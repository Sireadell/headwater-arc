// Runs Headwater's funding checks over every reviewed agent on Arc, from
// the saved payments list (scripts/buildArcIndex.mjs). No network calls.
//
// For each reviewed agent it asks, for every reviewer wallet: did the
// agent's own owner or wallet pay for this reviewer, directly or one wallet
// removed? Is the reviewer the owner? Did two reviewers of the same agent
// get their money from the same person-sized wallet?
//
// Rules for deciding what counts as a link:
//   1. Two hops, not one.
//   2. Identity beats shape: a busy wallet is ignored as a funder UNLESS it
//      is the agent's own owner or wallet.
//   3. A shared funder only counts on an agent where the wallets it funded
//      are at least half of that agent's reviewers.
//
// Run: node scripts/auditArc.mjs   (writes data/arc-audit.json)

import fs from 'node:fs';
import { config } from '../src/config.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const index = JSON.parse(fs.readFileSync(config.arcTransferIndexPath, 'utf8'));
const hubs = new Set(index.hubs.map((h) => h.address));

// First payment received by each wallet, oldest first.
const firstIn = new Map();
for (const t of index.transfers) {
  if (t.toAddress !== t.fromAddress && !firstIn.has(t.toAddress)) firstIn.set(t.toAddress, t);
}

// Walk up to two funders back. Stops at a hub, the zero address (money
// created by the network itself) or a wallet with no payment in the window.
function chainOf(wallet) {
  const links = [];
  let current = wallet;
  for (let hop = 1; hop <= 2; hop++) {
    const t = firstIn.get(current);
    if (!t) break;
    const funder = t.fromAddress;
    if (funder === ZERO) { links.push({ hop, kind: 'network', address: funder, tx: t.transactionHash }); break; }
    if (hubs.has(funder)) { links.push({ hop, kind: 'hub', address: funder, tx: t.transactionHash }); break; }
    links.push({ hop, kind: 'wallet', address: funder, tx: t.transactionHash, usdc: Number(t.valueRawInteger) / 1e6 });
    current = funder;
  }
  return links;
}

const results = [];
for (const agent of index.agents) {
  const own = new Set([agent.owner, agent.wallet].filter((a) => a && a !== ZERO));
  const ownerChains = [...own].map((a) => ({ wallet: a, links: chainOf(a) }));
  const ownerFamily = new Set([...own, ...ownerChains.flatMap((c) => c.links.filter((l) => l.kind === 'wallet').map((l) => l.address))]);

  const reviewers = agent.reviewers.map((r) => {
    const links = chainOf(r);
    const flags = [];
    if (own.has(r)) flags.push({ type: 'self_review', detail: 'The reviewer is the agent\'s own owner or wallet.' });
    const viaOwner = links.find((l) => l.kind === 'wallet' && own.has(l.address));
    if (viaOwner) flags.push({ type: 'paid_by_owner', hop: viaOwner.hop, tx: viaOwner.tx, detail: viaOwner.hop === 1 ? 'The agent\'s owner paid this reviewer directly.' : 'The agent\'s owner paid a wallet that paid this reviewer.' });
    const sharesFamily = links.find((l) => l.kind === 'wallet' && ownerFamily.has(l.address) && !own.has(l.address));
    if (sharesFamily && !viaOwner) flags.push({ type: 'same_funder_as_owner', hop: sharesFamily.hop, tx: sharesFamily.tx, detail: 'Reviewer and owner were paid by the same wallet.' });
    return { reviewer: r, links, flags };
  });

  // Shared person-sized funders among this agent's reviewers.
  const byFunder = new Map();
  for (const rv of reviewers) {
    for (const l of rv.links) if (l.kind === 'wallet') {
      if (!byFunder.has(l.address)) byFunder.set(l.address, new Set());
      byFunder.get(l.address).add(rv.reviewer);
    }
  }
  const shared = [...byFunder].filter(([, set]) => set.size >= 2 && set.size >= agent.reviewers.length / 2)
    .map(([funder, set]) => ({ funder, reviewers: [...set] }));
  for (const s of shared) for (const rv of reviewers) if (s.reviewers.includes(rv.reviewer)) rv.flags.push({ type: 'shared_funder', funder: s.funder, detail: 'Paid for by the same wallet as another reviewer of this agent.' });

  const flagged = reviewers.filter((r) => r.flags.length > 0);
  results.push({
    agentId: agent.agentId,
    owner: agent.owner,
    wallet: agent.wallet,
    reviewerCount: agent.reviewers.length,
    unknownFunders: reviewers.filter((r) => r.links.length === 0).length,
    flaggedReviewers: flagged.length,
    status: flagged.length === 0 ? 'NO_FUNDING_LINK_FOUND' : flagged.length === agent.reviewers.length ? 'ALL_REVIEWERS_LINKED' : 'SOME_REVIEWERS_LINKED',
    reviewers,
  });
}

const count = (s) => results.filter((r) => r.status === s).length;
const summary = {
  chain: 'arc',
  builtFromIndex: index.builtAt,
  window: { fromBlock: index.fromBlock, toBlock: index.toBlock },
  reviewedAgents: results.length,
  noLinkFound: count('NO_FUNDING_LINK_FOUND'),
  someLinked: count('SOME_REVIEWERS_LINKED'),
  allLinked: count('ALL_REVIEWERS_LINKED'),
  hubsIgnored: index.hubs.length,
};
fs.writeFileSync('data/arc-audit.json', JSON.stringify({ summary, results }, null, 1));
console.log(summary);
const interesting = results.filter((r) => r.flaggedReviewers > 0).sort((a, b) => b.flaggedReviewers - a.flaggedReviewers);
for (const r of interesting.slice(0, 15)) {
  console.log(`agent ${r.agentId}: ${r.flaggedReviewers}/${r.reviewerCount} reviewers linked (${[...new Set(r.reviewers.flatMap((x) => x.flags.map((f) => f.type)))].join(', ')})`);
}
