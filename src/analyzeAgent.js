// Single-agent read: pulls the real reviewer wallets from the Reputation
// Registry on Arc, then runs findDirectFunder (the funding-provenance
// signal) against each reviewer to see who funded them. A shared funder
// across reviewers of the same agent means "independent" reviewers are
// not independent.
//
// Honest limit: without the saved payments list (scripts/buildArcIndex.mjs)
// each lookup scans a bounded recent window of Arc blocks, so a reviewer
// funded earlier shows up as "no funder found", not "clean". The full-run
// audit (scripts/auditArc.mjs) uses the saved list and has no such window.

import { getAgentWallet, getReviewers, getReputationSummary, readAllFeedback } from './core/rpc/erc8004Registry.js';
import { findDirectFunder } from './core/signals/fundingRelationship.js';

/**
 * @param {number} agentId
 * @returns {Promise<object>} a funding-based read for one agent, or an explicit UNVALIDATED result if it has no reviewers yet
 */
export async function analyzeAgent(agentId) {
  const [wallet, reviewers] = await Promise.all([
    getAgentWallet(agentId),
    getReviewers(agentId),
  ]);

  if (reviewers.length === 0) {
    return {
      agentId,
      wallet,
      reviewCount: 0,
      status: 'UNVALIDATED',
      reason: 'no_reviewers_yet',
    };
  }

  const [summary, feedback] = await Promise.all([
    getReputationSummary(agentId, reviewers),
    readAllFeedback(agentId, reviewers),
  ]);

  // Each findDirectFunder call can fire many log requests internally, so
  // reviewers are looked up two at a time to stay inside the endpoint rate
  // limit.
  const REVIEWER_CONCURRENCY = 2;
  const reviewerFunding = [];
  for (let i = 0; i < reviewers.length; i += REVIEWER_CONCURRENCY) {
    const batch = reviewers.slice(i, i + REVIEWER_CONCURRENCY);
    const results = await Promise.all(batch.map(async (reviewer) => {
      const evidence = await findDirectFunder(reviewer, {});
      return { reviewer, funder: evidence?.asset?.from ?? null, evidence };
    }));
    reviewerFunding.push(...results);
  }

  const funderCounts = new Map();
  for (const { funder } of reviewerFunding) {
    if (!funder) continue;
    funderCounts.set(funder, (funderCounts.get(funder) ?? 0) + 1);
  }
  const sharedFunders = [...funderCounts.entries()].filter(([, count]) => count > 1);
  const fundersFoundInWindow = reviewerFunding.filter((r) => r.funder).length;

  return {
    agentId,
    wallet,
    reviewCount: Number(summary.count),
    averageScore: Number(summary.summaryValue),
    scoreDecimals: Number(summary.summaryValueDecimals),
    reviewerFunding,
    fundersFoundInWindow,
    fundersOutOfWindow: reviewers.length - fundersFoundInWindow,
    sharedFunders: sharedFunders.map(([funder, count]) => ({ funder, reviewerCount: count })),
    status: sharedFunders.length > 0 ? 'FLAGGED' : 'CLEAN_IN_WINDOW',
    tags: feedback.map((f) => `${f.tag1}${f.tag2 ? '/' + f.tag2 : ''}`),
  };
}
