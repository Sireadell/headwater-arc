// Arc transport layer for the funding-graph signals.
//
// The six funding signals (fundingRelationship, circularFunding,
// clustering, fanOut, convergentRelayFunding, outboundRelationships) call
// callAnkr(method, params, opts) and expect Ankr-shaped token-transfer
// items. This file gives Arc that same call shape, so no signal file had
// to change.
//
// WHY ARC NEEDS ONLY ONE LOG SOURCE
// USDC is Arc's gas coin. Every USDC movement, including a plain native
// send with no token contract involved, writes one Transfer log from the
// system address 0xffff...fffe, valued with 18 decimals. Checked on live
// receipts 2026-10-03 for Assay and again 2026-10-08. So reading that one
// emitter sees every dollar that moved, exactly once. There is no native-transfer gap, so 'getTransactionsByAddress'
// returns an empty, complete result on purpose: those payments are
// already in the token-transfer stream.
//
// HOW IT STAYS FAST
// Scanning Arc's full history for one wallet takes thousands of log
// calls, because Dwellir caps eth_getLogs at 500 blocks. So the expected
// wallets (reviewers, agent owners, agent wallets and their funders) are
// scanned once, together, by scripts/buildArcIndex.mjs, and saved to
// data/arc-transfer-index.json. This file answers from that index first.
// A wallet that is not in the index gets a live scan, bounded to the
// most recent LIVE_LOOKBACK_BLOCKS, and the result says so.

import fs from 'node:fs';
import { config } from '../../config.js';

export const SYSTEM_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe';
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SYSTEM_TO_USDC_MICRO = 10n ** 12n; // 18-decimal system log value to 6-decimal USDC units

const RPC_URLS = config.arcRpcUrls;
const BLOCK_WINDOW = config.arcLogBlockWindow;
const CONCURRENCY = config.arcLogConcurrency;
const LIVE_LOOKBACK_BLOCKS = Number(process.env.ARC_LIVE_LOOKBACK_BLOCKS) || 200_000;
const RATE_LIMIT_RETRIES = 6;

export class ArcRpcError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArcRpcError';
  }
}

export async function rawRpc(method, params, attempt = 0) {
  // Fast endpoint first. Fall through to the next one only after its
  // retries are spent, so a busy public endpoint never slows the fast path.
  const url = RPC_URLS[Math.min(Math.floor(attempt / RATE_LIMIT_RETRIES), RPC_URLS.length - 1)];
  let body;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    body = await res.json();
  } catch (err) {
    body = { error: { message: String(err?.message ?? err) } };
  }
  if (body?.error) {
    if (attempt < RATE_LIMIT_RETRIES * RPC_URLS.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt % RATE_LIMIT_RETRIES)));
      return rawRpc(method, params, attempt + 1);
    }
    throw new ArcRpcError(`Arc RPC error: ${body.error.message ?? JSON.stringify(body.error)}`);
  }
  return body.result;
}

export function addressToTopic(address) {
  return '0x' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function topicToAddress(topic) {
  return '0x' + topic.slice(26).toLowerCase();
}

/** Decode a system Transfer log into the Ankr token-transfer item shape. */
export function decodeSystemLog(log, blockTimestampMs = null) {
  return {
    fromAddress: topicToAddress(log.topics[1]),
    toAddress: topicToAddress(log.topics[2]),
    transactionHash: log.transactionHash,
    blockNumber: parseInt(log.blockNumber, 16),
    timestamp: blockTimestampMs,
    valueRawInteger: (BigInt(log.data && log.data !== '0x' ? log.data : '0x0') / SYSTEM_TO_USDC_MICRO).toString(),
    tokenSymbol: 'USDC',
  };
}

/**
 * Scan system Transfer logs touching any of `wallets` between two blocks,
 * in BLOCK_WINDOW slices with bounded concurrency. Both directions.
 */
export async function scanSystemTransfers(wallets, fromBlock, toBlock) {
  const topics = wallets.map(addressToTopic);
  const starts = [];
  for (let b = fromBlock; b <= toBlock; b += BLOCK_WINDOW) starts.push(b);
  const logs = [];
  let next = 0;
  async function worker() {
    while (next < starts.length) {
      const from = starts[next++];
      const range = { fromBlock: '0x' + from.toString(16), toBlock: '0x' + Math.min(from + BLOCK_WINDOW - 1, toBlock).toString(16), address: SYSTEM_EMITTER };
      const [incoming, outgoing] = await Promise.all([
        rawRpc('eth_getLogs', [{ ...range, topics: [TRANSFER_TOPIC, null, topics] }]),
        rawRpc('eth_getLogs', [{ ...range, topics: [TRANSFER_TOPIC, topics] }]),
      ]);
      logs.push(...incoming, ...outgoing);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, starts.length) }, worker));
  const unique = new Map(logs.map((l) => [`${l.transactionHash}:${l.logIndex}`, l]));
  return [...unique.values()].sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16) || parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16));
}

let indexCache;
function loadIndex() {
  if (indexCache !== undefined) return indexCache;
  try {
    indexCache = JSON.parse(fs.readFileSync(config.arcTransferIndexPath, 'utf8'));
  } catch {
    indexCache = null;
  }
  return indexCache;
}

/** Test hook: swap in an in-memory index. */
export function setIndexForTests(index) {
  indexCache = index;
}

async function fetchTokenTransfers(wallet) {
  const address = wallet.toLowerCase();
  const index = loadIndex();
  if (index?.wallets?.includes(address)) {
    const transfers = (index.transfers ?? []).filter((t) => t.fromAddress === address || t.toAddress === address);
    return { transfers, nextPageToken: undefined, _source: 'index', _indexedThroughBlock: index.toBlock };
  }
  const tip = parseInt(await rawRpc('eth_blockNumber', []), 16);
  const from = Math.max(config.arcScanStartBlock, tip - LIVE_LOOKBACK_BLOCKS);
  const logs = await scanSystemTransfers([address], from, tip);
  return {
    transfers: logs.map((l) => decodeSystemLog(l)),
    nextPageToken: undefined,
    _source: 'live',
    _lookbackExhausted: from > config.arcScanStartBlock,
  };
}

/**
 * Same call signature as callAnkr(method, params, opts).
 */
export async function callArc(method, params, _opts = {}) {
  const wallet = Array.isArray(params.address) ? params.address[0] : params.address;
  if (method === 'arc_getTokenTransfers') {
    return fetchTokenTransfers(wallet);
  }
  if (method === 'arc_getTransactionsByAddress') {
    // Native USDC sends are already in the system-log stream above, so
    // this is complete and empty by design, not a missing data source.
    return { transactions: [], nextPageToken: undefined };
  }
  throw new ArcRpcError(`Unknown Arc RPC method: ${method}`);
}
