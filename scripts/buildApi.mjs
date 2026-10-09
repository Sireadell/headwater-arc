// Runs Headwater's verdict rules (src/provenance.js, ported from the Monad
// build) over every reviewed agent on Arc, from the two saved data files, and
// writes the static API the site reads:
//
//   docs/api/index.json          counts, verdict meanings, one line per agent
//   docs/api/agents/<id>.json    the full report for one reviewed agent
//   docs/api/rings.json          groups that reach across several agents
//
// The funding questions the Monad build asked an indexer are answered here
// from data/arc-transfer-index.json. Only the code check (is a rater a
// contract) goes to the network.
//
// Run: node --env-file=.env scripts/buildApi.mjs
//   needs data/arc-transfer-index.json (scripts/buildArcIndex.mjs)
//   and   data/arc-feedback.json       (scripts/buildArcFeedback.mjs)

import fs from 'node:fs';
import { config } from '../src/config.js';
import { rawRpc } from '../src/core/rpc/arcClient.js';
import { makeSignalContext, signalsFor } from '../src/agentSignals.js';
import {
  setGraphql, setRpcUrl, chainStats, classifyRaters, traceOwnerFunding, tracePayments,
  buildVerdict, findRings, splitSenders,
} from '../src/provenance.js';

for (const f of [config.arcTransferIndexPath, 'data/arc-feedback.json']) {
  if (!fs.existsSync(f)) {
    console.error(`Missing ${f}. Build it first, see README.`);
    process.exit(1);
  }
}
const index = JSON.parse(fs.readFileSync(config.arcTransferIndexPath, 'utf8'));
const fb = JSON.parse(fs.readFileSync('data/arc-feedback.json', 'utf8'));
const memos = fs.existsSync('data/arc-memos.json') ? JSON.parse(fs.readFileSync('data/arc-memos.json', 'utf8')) : {};
setRpcUrl(config.arcReadRpcUrl);

const ZERO = '0x0000000000000000000000000000000000000000';
const DUST_MICRO_USDC = 10_000; // under 0.01 USDC, same line the Monad build drew for 0.01 MON
const hubs = new Set(index.hubs.map((h) => h.address));

// First payment from each funder into each wallet. Busy shared wallets and
// the network's own zero address are left out: being paid by one of them
// links a wallet to nobody.
const first = new Map(); // wallet -> Map(funder -> { block, value, tx })
for (const t of index.transfers) {
  if (t.fromAddress === t.toAddress || t.fromAddress === ZERO || hubs.has(t.fromAddress)) continue;
  if (!first.has(t.toAddress)) first.set(t.toAddress, new Map());
  const m = first.get(t.toAddress);
  if (!m.has(t.fromAddress)) m.set(t.fromAddress, { block: t.blockNumber, value: Number(t.valueRawInteger), tx: t.transactionHash });
}
const rowFor = (wallet, funder, rec) => ({ wallet, funder, isDust: rec.value < DUST_MICRO_USDC, valueRaw: String(rec.value), firstFundedTimestamp: rec.block });

// Answers the two funding questions provenance.js asks, in the shape it expects.
const PAGE = 1000;
setGraphql(async (_query, vars) => {
  let rows = [];
  if (vars.wallets) {
    for (const w of vars.wallets) for (const [funder, rec] of first.get(w) ?? []) rows.push(rowFor(w, funder, rec));
  } else if (vars.owner && vars.raters) {
    const m = first.get(vars.owner) ?? new Map();
    for (const r of vars.raters) if (m.has(r)) rows.push(rowFor(vars.owner, r, m.get(r)));
  }
  return { WalletFunder: rows.slice(vars.offset ?? 0, (vars.offset ?? 0) + PAGE) };
});

const agentInfo = new Map(index.agents.map((a) => [a.agentId, a]));
const registered = new Map(fb.agents.map((a) => [a.agentId, a.registeredBlock]));
const byAgent = new Map();
for (const f of fb.feedback) {
  if (!byAgent.has(f.agentId)) byAgent.set(f.agentId, []);
  byAgent.get(f.agentId).push(f);
}
const ratedIds = [...byAgent.keys()].filter((id) => agentInfo.has(id)).sort((a, b) => a - b);

function ratersOf(id) {
  const rows = byAgent.get(id);
  const firstRatedAt = new Map();
  const senders = new Map();
  for (const f of rows) {
    if (!firstRatedAt.has(f.reviewer)) firstRatedAt.set(f.reviewer, f.block);
    if (f.sender && f.sender !== f.reviewer) {
      if (!senders.has(f.reviewer)) senders.set(f.reviewer, new Set());
      senders.get(f.reviewer).add(f.sender);
    }
  }
  return { raters: [...firstRatedAt.keys()], feedbackCount: rows.length, firstRatedAt, senders };
}

const sigCtx = makeSignalContext({ transfers: index.transfers, hubs }, byAgent);

// Pass 1: facts per agent.
const facts = new Map();
for (const id of ratedIds) {
  const owner = agentInfo.get(id).owner;
  const { raters, feedbackCount, firstRatedAt, senders } = ratersOf(id);
  const funding = await traceOwnerFunding(owner, raters, senders);
  const { ownerSent } = splitSenders(owner, senders);
  const payments = await tracePayments(owner, raters, firstRatedAt, registered.get(id));
  const raterTypes = await classifyRaters(raters);
  facts.set(id, { owner, raters, feedbackCount, funding, ownerSent, payments, raterTypes, selfRated: raters.includes(owner) ? 1 : 0 });
}

// Numbers the verdict text quotes about the chain.
chainStats.registered = fb.agents.length;
chainStats.rated = ratedIds.length;
chainStats.thin = ratedIds.filter((id) => facts.get(id).raters.length === 1).length;
chainStats.paidBeforeAcrossChain = ratedIds.reduce((n, id) => {
  const f = facts.get(id);
  const ownerFunded = new Set([...f.funding.direct.map((d) => d.rater), ...f.funding.indirect.map((i) => i.rater)]);
  return n + f.payments.paidBefore.filter((p) => !ownerFunded.has(p.rater)).length;
}, 0);

// Rings, from the whole chain at once.
const ringFunders = [];
const wallets = new Set(ratedIds.flatMap((id) => [facts.get(id).owner, ...facts.get(id).raters]));
for (const w of wallets) for (const [funder, rec] of first.get(w) ?? []) ringFunders.push({ wallet: w, funder, isDust: rec.value < DUST_MICRO_USDC });
const rings = findRings({
  feedback: fb.feedback.filter((f) => agentInfo.has(f.agentId)).map((f) => ({ agent_id: String(f.agentId), reviewer_id: f.reviewer })),
  agents: ratedIds.map((id) => ({ id: String(id), owner: facts.get(id).owner })),
  funders: ringFunders,
});

fs.rmSync('docs/api', { recursive: true, force: true });
fs.mkdirSync('docs/api/agents', { recursive: true });
fs.writeFileSync('docs/api/rings.json', JSON.stringify({ rings, generatedAt: new Date().toISOString() }, null, 2) + '\n');

// Pass 2: verdicts.
const summary = [];
// One noun for the person behind a review, on every screen and in every sentence.
const plain = (s) => (typeof s === 'string' ? s.replace(/\brater(s?)\b/g, 'reviewer$1').replace(/\bRater(s?)\b/g, 'Reviewer$1') : s);
for (const id of ratedIds) {
  const f = facts.get(id);
  const myRings = rings.filter((r) => r.agents.includes(String(id)));
  const verdict = buildVerdict({ agentId: String(id), rings: myRings, owner: f.owner, reviewers: f.raters, feedbackCount: f.feedbackCount, funding: f.funding, raterTypes: f.raterTypes, selfRated: f.selfRated, payments: f.payments, ownerSent: f.ownerSent });
  const ownerFundedSet = new Set([...f.funding.direct.map((d) => d.rater), ...f.funding.indirect.map((i) => i.rater)]);
  const txOf = (wallet, funder) => first.get(wallet)?.get(funder)?.tx ?? null;
  const report = {
    agentId: String(id),
    owner: f.owner,
    registeredAtBlock: registered.get(id) ?? null,
    verdict: verdict.label,
    tone: verdict.tone,
    summary: plain(verdict.summary),
    findings: verdict.findings.map(plain),
    evidence: {
      feedbackCount: f.feedbackCount,
      distinctRaters: f.raters.length,
      selfRated: f.selfRated === 1,
      sentByOwner: f.ownerSent.length,
      ownerFundedDirect: new Set(f.funding.direct.map((d) => d.rater)).size,
      ownerFundedViaIntermediary: new Set(f.funding.indirect.filter((i) => !f.funding.direct.some((d) => d.rater === i.rater)).map((i) => i.rater)).size,
      intermediaries: [...new Set(f.funding.indirect.map((i) => i.via))],
      ratersWithKnownFunder: f.funding.ratersWithKnownFunder,
      ratersTraced: f.funding.tracedRaters,
      contractRaters: [...f.raterTypes.classified.values()].filter((v) => v.isContract).length,
      applicationRaters: [...f.raterTypes.classified.values()].filter((v) => v.app).length,
      ratersCheckedForCode: f.raterTypes.sampled,
      paidOwnerBeforeRating: f.payments.paidBefore.length,
      paidOwnerAfterRating: f.payments.paidAfter.length,
      paidOwnerBeforeAgentExisted: f.payments.paidBeforeAgentExisted.length,
      roundTripped: f.payments.paidAfter.filter((p) => ownerFundedSet.has(p.rater)).length,
      rings: myRings.map((r) => ({ kind: r.kind, source: r.source, agents: r.agents, raters: r.raters.length })),
      registryAverage: (() => { const rows = byAgent.get(id); const vals = rows.map((r) => Number(r.value) / 10 ** r.valueDecimals); return Math.round((vals.reduce((x, y) => x + y, 0) / vals.length) * 100) / 100; })(),
      independentPaidBeforeRating: f.payments.paidBefore.filter((p) => !ownerFundedSet.has(p.rater)).length,
    },
    signals: signalsFor(sigCtx, { agentId: id, owner: f.owner, raters: f.raters }).map((s) => ({ ...s, title: plain(s.title), desc: plain(s.desc) })),
    // Payments a reader can open on the explorer to check the verdict.
    proof: {
      ownerPaidRater: f.funding.direct.map((d) => ({ rater: d.rater, tx: first.get(d.rater)?.get(f.owner)?.tx ?? null, dust: d.isDust })),
      ownerPaidViaWallet: f.funding.indirect.map((i) => ({ rater: i.rater, via: i.via, ownerToViaTx: first.get(i.via)?.get(f.owner)?.tx ?? null, viaToRaterTx: first.get(i.rater)?.get(i.via)?.tx ?? null })),
      raterPaidOwner: [...f.payments.paidBefore, ...f.payments.paidAfter, ...f.payments.paidBeforeAgentExisted].map((p) => ({ rater: p.rater, tx: first.get(f.owner)?.get(p.rater)?.tx ?? null, afterRating: f.payments.paidAfter.includes(p) })),
      record: memos[id]?.tx ?? null,
    },
    limits: {
      fundingHops: 2,
      fundingAsset: 'USDC, which is also Arc\'s gas coin, so plain sends are included',
      window: { fromBlock: index.fromBlock, toBlock: index.toBlock },
      paymentTiming: 'A payment is timed against the payer\'s FIRST payment to this owner. A later payment by an already-paying wallet is not separately timed. Times are block numbers.',
      codeCheckSample: f.raterTypes.sampled,
      codeCheckTotal: f.raterTypes.total,
      note: 'A verdict is a statement about where money came from, not about anyone\'s intent. Absence of a funding link is weaker evidence than a link, because a wallet funded outside the scanned window, or through a wallet not paid directly, is not visible.',
    },
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(`docs/api/agents/${id}.json`, JSON.stringify(report, null, 2) + '\n');
  summary.push({ agentId: String(id), verdict: report.verdict, tone: report.tone, registryAverage: report.evidence.registryAverage, distinctRaters: report.evidence.distinctRaters, feedbackCount: report.evidence.feedbackCount, ownerFunded: report.evidence.ownerFundedDirect + report.evidence.ownerFundedViaIntermediary, record: report.proof.record });
}

// The newest ratings as of this snapshot, for the home page feed. The page
// asks Arc directly for anything newer.
const newest = fb.feedback.slice(-12).reverse();
const recent = [];
for (const f of newest) {
  const blk = await rawRpc('eth_getBlockByNumber', ['0x' + f.block.toString(16), false]);
  recent.push({ agentId: f.agentId, reviewer: f.reviewer, block: f.block, time: parseInt(blk.timestamp, 16), tx: f.tx });
}
fs.writeFileSync('docs/api/recent.json', JSON.stringify({ snapshotToBlock: fb.toBlock, recent }, null, 2) + '\n');

const byVerdict = {};
for (const s of summary) byVerdict[s.verdict] = (byVerdict[s.verdict] ?? 0) + 1;
fs.writeFileSync('docs/api/index.json', JSON.stringify({
  what: 'Where each ERC-8004 agent\'s reputation on Arc actually came from. A verdict describes the origin of the money behind an agent\'s raters. It is not a judgement of anyone\'s intent, and a funded campaign can be entirely legitimate.',
  usage: {
    agent: 'GET /headwater-arc/api/agents/{agentId}.json',
    absent: 'An agent id with no file here has never been rated. Treat that as the verdict NO EVIDENCE, not as an error: it is the normal case on this chain.',
    live: 'This is a static snapshot, as fresh as generatedAt below. Run the MCP server in mcp/server.mjs for the same answers from your own copy of the data.',
  },
  verdicts: {
    'NO EVIDENCE': 'Never rated. Nothing to trust or distrust.',
    THIN: 'Every rating came from a single address.',
    'SELF REVIEWED': 'The owner\'s own wallet is among the raters, or the owner sent a review through another wallet.',
    'APP GENERATED': 'Raters are application contracts recording outcomes, not people.',
    'OWNER FUNDED': 'The agent\'s own owner paid for its raters, directly or via one hop.',
    'ROUND TRIP': 'The owner paid its raters and the same wallets sent funds back to the owner after rating.',
    RING: 'The agent\'s raters trace to one money source that also sits behind several other agents.',
    'NO LINK FOUND': 'No funding link found across two hops. Weaker evidence than a link.',
  },
  limits: { fundingHops: 2, fundingAsset: 'USDC (Arc gas coin)', window: { fromBlock: index.fromBlock, toBlock: index.toBlock }, note: 'Absence of a link is weaker evidence than a link.' },
  counts: { agentsRegistered: chainStats.registered, agentsEverRated: summary.length, byVerdict, rings: rings.length },
  agents: summary,
  generatedAt: new Date().toISOString(),
}, null, 2) + '\n');
console.log(`${summary.length} agents, ${rings.length} rings`, byVerdict);
