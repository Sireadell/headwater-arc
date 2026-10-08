// Builds data/arc-transfer-index.json: every USDC payment on Arc that
// touches an agent owner, an agent wallet, a reviewer, or the first funder
// of any of those. One shared scan instead of one scan per wallet, which
// is what keeps checks fast (see the header of src/core/rpc/arcClient.js).
//
// Run: node --env-file=.env scripts/buildArcIndex.mjs
// Uses DWELLIR_ARC_URL when set (fast), otherwise Arc's public endpoint.

import fs from 'node:fs';
import { config } from '../src/config.js';
import { listAgents, getReviewers, getAgentWallet } from '../src/core/rpc/erc8004Registry.js';
import { rawRpc, scanSystemTransfers, decodeSystemLog } from '../src/core/rpc/arcClient.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const lower = (a) => String(a).toLowerCase();

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return out;
}

const started = Date.now();
const agents = await listAgents({ maxAgents: 100_000 });
console.log(`agents registered: ${agents.length}`);

const details = await inBatches(agents, 20, async ({ agentId, owner }) => {
  const [reviewers, wallet] = await Promise.all([
    getReviewers(agentId).catch(() => []),
    getAgentWallet(agentId).catch(() => ZERO),
  ]);
  return { agentId, owner: lower(owner), wallet: lower(wallet), reviewers: reviewers.map(lower) };
});
const reviewed = details.filter((d) => d.reviewers.length > 0);
console.log(`agents with reviews: ${reviewed.length}`);

// Hop 1: owners, agent wallets and reviewers of every reviewed agent.
const hop1 = new Set();
for (const d of reviewed) {
  hop1.add(d.owner);
  if (d.wallet !== ZERO) hop1.add(d.wallet);
  for (const r of d.reviewers) hop1.add(r);
}
hop1.delete(ZERO);

const tip = parseInt(await rawRpc('eth_blockNumber', []), 16);
const from = config.arcScanStartBlock;
let logs = await scanSystemTransfers([...hop1], from, tip);
console.log(`hop 1: ${hop1.size} wallets, ${logs.length} payments`);

// Hop 2: whoever first paid each hop-1 wallet, so a shared funder one
// step back is visible too.
const firstFunder = new Map();
for (const log of logs) {
  const t = decodeSystemLog(log);
  if (hop1.has(t.toAddress) && !firstFunder.has(t.toAddress)) firstFunder.set(t.toAddress, t.fromAddress);
}
const hop2 = new Set([...firstFunder.values()].filter((a) => a !== ZERO && !hop1.has(a)));
let more = [];
if (hop2.size > 0) {
  more = await scanSystemTransfers([...hop2], from, tip);
  console.log(`hop 2: ${hop2.size} wallets, ${more.length} payments`);
}

// A wallet with thousands of payments is a shared service (an exchange,
// a bridge, a faucet), not a person. Seen live 2026-10-08: one first
// funder of two reviewers had made 491,426 payments. Being funded by such
// a hub links two wallets to nobody in particular, so hubs are listed by
// name, and only their payments that touch a hop-1 wallet are kept.
const HUB_MIN_PAYMENTS = Number(process.env.ARC_HUB_MIN_PAYMENTS) || 5_000;
const countBy = new Map();
for (const l of more) {
  const t = decodeSystemLog(l);
  for (const a of [t.fromAddress, t.toAddress]) if (hop2.has(a)) countBy.set(a, (countBy.get(a) ?? 0) + 1);
}
const hubs = [...countBy].filter(([, n]) => n >= HUB_MIN_PAYMENTS).map(([a, n]) => ({ address: a, payments: n }));
const hubSet = new Set(hubs.map((h) => h.address));
const keptMore = more.filter((l) => {
  const t = decodeSystemLog(l);
  const touchesHub = hubSet.has(t.fromAddress) || hubSet.has(t.toAddress);
  return !touchesHub || hop1.has(t.fromAddress) || hop1.has(t.toAddress);
});
logs = [...new Map([...logs, ...keptMore].map((l) => [`${l.transactionHash}:${l.logIndex}`, l])).values()];
console.log(`hubs: ${hubs.length} (${hubs.map((h) => `${h.address.slice(0, 10)}:${h.payments}`).join(', ')})`);

const transfers = logs
  .map((l) => decodeSystemLog(l))
  .sort((a, b) => a.blockNumber - b.blockNumber);

const index = {
  chain: 'arc',
  builtAt: new Date().toISOString(),
  fromBlock: from,
  toBlock: tip,
  // Hubs are not "indexed wallets": their kept payments are only the ones
  // touching hop-1 wallets, so answering a full-history question about a
  // hub from the index would be wrong.
  wallets: [...new Set([...hop1, ...hop2])].filter((a) => !hubSet.has(a)).sort(),
  hubs,
  agents: reviewed,
  transfers,
};
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(config.arcTransferIndexPath, JSON.stringify(index));
console.log(`saved ${transfers.length} payments for ${index.wallets.length} wallets, blocks ${from} to ${tip}, in ${Math.round((Date.now() - started) / 1000)}s`);
