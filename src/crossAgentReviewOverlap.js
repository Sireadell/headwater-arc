// Catches a reviewer wallet that reviews more than one agent. This is a
// distinct signal from analyzeAgent.js's shared-funder check: it needs no
// eth_getLogs scanning at all, just the reviewer lists already pulled
// from the Reputation Registry, so it is fast and immune to the
// lookback-window limit that funding-based checks run into.
//
// A wallet reviewing several agents is not proof of anything on its own,
// a real user can legitimately try and review several products. It is
// the same shape as the two funding-based patterns this product exists
// to catch, though: one identity spread across surfaces that are
// supposed to look independent. Found live 2026-09-16 by eye (agent 18's
// own registered wallet turned out to be the exact address that reviewed
// agents 2, 3 and 4) before this module existed to catch it
// automatically.

import { listAgents, getReviewers } from './core/rpc/erc8004Registry.js';

/**
 * Scans every agent once and returns both the cross-agent overlap result
 * and each agent's reviewer count, so a caller that also needs "which
 * agents have real reviews" (scripts/demo.mjs does) doesn't have to pay
 * for a second full scan to get it.
 *
 * @param {{ maxAgents?: number }} [opts]
 * @returns {Promise<{ agentsScanned: number, overlaps: Array<{ reviewer: string, agentIds: number[] }>, agentsWithReviewers: Array<{ agentId: number, reviewerCount: number }> }>}
 */
export async function findCrossAgentReviewOverlap({ maxAgents = 250 } = {}) {
  const agents = await listAgents({ startId: 0, maxAgents });

  const reviewerToAgents = new Map();
  const agentsWithReviewers = [];
  const BATCH = 25;
  for (let i = 0; i < agents.length; i += BATCH) {
    const batch = agents.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async ({ agentId }) => {
      const reviewers = await getReviewers(agentId);
      return { agentId, reviewers };
    }));
    for (const { agentId, reviewers } of results) {
      if (reviewers.length > 0) agentsWithReviewers.push({ agentId, reviewerCount: reviewers.length });
      for (const reviewer of reviewers) {
        const key = reviewer.toLowerCase();
        if (!reviewerToAgents.has(key)) reviewerToAgents.set(key, { reviewer, agentIds: [] });
        reviewerToAgents.get(key).agentIds.push(agentId);
      }
    }
  }

  const overlaps = [...reviewerToAgents.values()]
    .filter((entry) => entry.agentIds.length > 1)
    .map((entry) => ({ reviewer: entry.reviewer, agentIds: entry.agentIds }));

  return { agentsScanned: agents.length, overlaps, agentsWithReviewers };
}
