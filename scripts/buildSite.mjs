// Builds docs/data.json for the live page from the audit and the Arc memos.
// Run: node scripts/buildSite.mjs
import fs from 'node:fs';
const audit = JSON.parse(fs.readFileSync('data/arc-audit.json', 'utf8'));
const memos = JSON.parse(fs.readFileSync('data/arc-memos.json', 'utf8'));
const WHY = {
  self_review: 'The reviewer is the agent\'s own owner or wallet.',
  paid_by_owner_2: 'The owner of this agent paid a wallet, and that wallet then paid this reviewer.',
  paid_by_owner: 'The agent\'s owner sent this reviewer its starting money.',
  same_funder_as_owner: 'The owner and this reviewer got their starting money from the same wallet.',
  shared_funder: 'Another reviewer of this agent got its starting money from the same wallet.',
};
const flagged = audit.results.filter((r) => r.flaggedReviewers > 0).map((r) => ({
  agentId: r.agentId, owner: r.owner, status: r.status,
  reviewers: r.reviewerCount, linked: r.flaggedReviewers,
  memoTx: memos[r.agentId]?.tx ?? null,
  evidence: r.reviewers.filter((x) => x.flags.length).map((x) => ({
    reviewer: x.reviewer,
    reasons: x.flags.map((f) => ({ type: f.type, why: f.type === 'paid_by_owner' && f.hop === 2 ? WHY.paid_by_owner_2 : WHY[f.type] })),
    fundingTx: x.flags.find((f) => f.tx)?.tx ?? null,
    fundingNote: x.flags.some((f) => f.type === 'paid_by_owner' && f.hop === 2) ? 'Payment from the owner to the wallet that then paid this reviewer' : 'Funding payment',
  })),
}));
const clean = audit.results.filter((r) => r.flaggedReviewers === 0).map((r) => r.agentId);
const noFunder = new Set(audit.results.flatMap((r) => r.reviewers.filter((x) => x.links.length === 0).map((x) => x.reviewer))).size;
fs.writeFileSync('docs/data.json', JSON.stringify({ summary: audit.summary, reviewersWithNoFunderFound: noFunder, cleanAgentIds: clean, cleanWithUnknownFunders: audit.results.filter((r) => r.flaggedReviewers === 0 && r.unknownFunders > 0).map((r) => r.agentId), flagged }, null, 1));
console.log('flagged', flagged.length, 'withMemo', flagged.filter((f) => f.memoTx).length);
