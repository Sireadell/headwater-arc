// Saves every review (NewFeedback) and every agent registration (Registered)
// on Arc to data/arc-feedback.json, with the wallet that actually sent each
// review transaction. The verdicts need three things the payments list does
// not have: when each rater first rated an agent, when each agent was
// registered, and who sent the review transaction.
//
// Times are block numbers, which order events the same way dates would.
//
// Run: node --env-file=.env scripts/buildArcFeedback.mjs
import fs from 'node:fs';
import { ethers } from 'ethers';
import { config } from '../src/config.js';
import { rawRpc } from '../src/core/rpc/arcClient.js';
import { IDENTITY_REGISTRY_ADDRESS, REPUTATION_REGISTRY_ADDRESS } from '../src/core/rpc/erc8004Registry.js';

const feedbackIface = new ethers.Interface([
  'event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
]);
const T_FEEDBACK = feedbackIface.getEvent('NewFeedback').topicHash;
const T_REGISTERED = feedbackIface.getEvent('Registered').topicHash;
const START = Number(process.env.ARC_REGISTRY_START_BLOCK) || 13_000_000;
const WINDOW = config.arcLogBlockWindow;
const CONCURRENCY = config.arcLogConcurrency;
const hex = (n) => '0x' + n.toString(16);

const started = Date.now();
const tip = parseInt(await rawRpc('eth_blockNumber', []), 16);
const ranges = [];
for (let from = START; from <= tip; from += WINDOW) ranges.push([from, Math.min(from + WINDOW - 1, tip)]);

const logs = [];
let next = 0;
async function worker() {
  while (next < ranges.length) {
    const [from, to] = ranges[next++];
    const res = await rawRpc('eth_getLogs', [{
      fromBlock: hex(from), toBlock: hex(to),
      address: [IDENTITY_REGISTRY_ADDRESS, REPUTATION_REGISTRY_ADDRESS],
      topics: [[T_FEEDBACK, T_REGISTERED]],
    }]);
    logs.push(...res);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`scanned ${ranges.length} windows from block ${START} to ${tip}, ${logs.length} logs`);

const feedback = [];
const agents = new Map();
for (const log of logs) {
  const parsed = feedbackIface.parseLog(log);
  const block = parseInt(log.blockNumber, 16);
  if (parsed.name === 'Registered') {
    agents.set(Number(parsed.args.agentId), { agentId: Number(parsed.args.agentId), owner: parsed.args.owner.toLowerCase(), registeredBlock: block });
  } else {
    feedback.push({
      agentId: Number(parsed.args.agentId),
      reviewer: parsed.args.clientAddress.toLowerCase(),
      feedbackIndex: Number(parsed.args.feedbackIndex),
      value: parsed.args.value.toString(),
      valueDecimals: Number(parsed.args.valueDecimals),
      block,
      tx: log.transactionHash,
      logIndex: parseInt(log.logIndex, 16),
    });
  }
}

// Who sent each review transaction. A smart wallet or a contract can have a
// review sent, and paid for, by another address.
const txs = [...new Set(feedback.map((f) => f.tx))];
const sender = new Map();
let ti = 0;
async function txWorker() {
  while (ti < txs.length) {
    const hash = txs[ti++];
    const t = await rawRpc('eth_getTransactionByHash', [hash]);
    sender.set(hash, (t?.from ?? '').toLowerCase());
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, txWorker));
for (const f of feedback) f.sender = sender.get(f.tx);
feedback.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);

fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/arc-feedback.json', JSON.stringify({
  chain: 'arc', builtAt: new Date().toISOString(), fromBlock: START, toBlock: tip,
  agents: [...agents.values()].sort((a, b) => a.agentId - b.agentId), feedback,
}));
console.log(`saved ${agents.size} registrations and ${feedback.length} reviews in ${Math.round((Date.now() - started) / 1000)}s`);
