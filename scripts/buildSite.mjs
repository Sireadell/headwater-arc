// Builds docs/data.json for the live page from the audit and the Arc memos.
// Run: node scripts/buildSite.mjs
import fs from 'node:fs';
const audit = JSON.parse(fs.readFileSync('data/arc-audit.json', 'utf8'));
const memos = JSON.parse(fs.readFileSync('data/arc-memos.json', 'utf8'));
const WHY = {
  self_review: 'The reviewer is the agent\'s own owner or wallet.',
  paid_by_owner_2: 'The owner of this agent paid a wallet, and that wallet then paid this reviewer.',
  paid_the_owner_2: 'This reviewer paid a wallet, and that wallet then paid the owner of this agent.',
  paid_the_owner: 'This reviewer sent the owner of this agent its starting money.',
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
    reasons: x.flags.map((f) => ({ type: f.type, why: f.hop === 2 ? (WHY[f.type + '_2'] ?? WHY[f.type]) : WHY[f.type] })),
    fundingTx: x.flags.find((f) => f.tx)?.tx ?? null,
    fundingNote: (() => { const f = x.flags.find((g) => g.tx); if (!f) return 'Funding payment'; if (f.type === 'paid_the_owner') return f.hop === 2 ? 'Payment from this reviewer to the wallet that then paid the owner' : 'Payment from this reviewer to the owner'; return f.type === 'paid_by_owner' && f.hop === 2 ? 'Payment from the owner to the wallet that then paid this reviewer' : 'Funding payment'; })(),
  })),
}));
const clean = audit.results.filter((r) => r.flaggedReviewers === 0).map((r) => r.agentId);
const noFunder = new Set(audit.results.flatMap((r) => r.reviewers.filter((x) => x.links.length === 0).map((x) => x.reviewer))).size;
const rows = audit.results.map((r) => ({ agentId: r.agentId, reviewers: r.reviewerCount, linked: r.flaggedReviewers, unknown: r.unknownFunders, status: r.status, memoTx: memos[r.agentId]?.tx ?? null })).sort((a, b) => a.agentId - b.agentId);
fs.writeFileSync('docs/data.json', JSON.stringify({ summary: audit.summary, reviewersWithNoFunderFound: noFunder, rows, cleanAgentIds: clean, cleanWithUnknownFunders: audit.results.filter((r) => r.flaggedReviewers === 0 && r.unknownFunders > 0).map((r) => r.agentId), flagged }, null, 1));
console.log('flagged', flagged.length, 'withMemo', flagged.filter((f) => f.memoTx).length);
