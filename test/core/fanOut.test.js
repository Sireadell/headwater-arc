import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFunderFanOut } from '../../src/core/signals/fanOut.js';
import { SIGNAL_CODES } from '../../src/core/evidence/model.js';

const FUNDER = '0x1111111111111111111111111111111111111111';
const SPAN = 25 * 60 * 60;

function address(index) {
  return `0x${index.toString(16).padStart(40, '0')}`;
}

function nativeTransfers(count, { start = 1_000, span = SPAN, offset = 1 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    from: FUNDER,
    to: address(index + offset),
    hash: `0xnative${index}`,
    blockNumber: 100 + index,
    timestamp: `0x${Math.round(start + (span * index) / Math.max(1, count - 1)).toString(16)}`,
  }));
}

function tokenTransfers(count, { start = 1_000, span = SPAN, offset = 1 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    fromAddress: FUNDER,
    toAddress: address(index + offset),
    transactionHash: `0xtoken${index}`,
    blockNumber: 200 + index,
    timestamp: String(Math.round(start + (span * index) / Math.max(1, count - 1))),
  }));
}

function mockByMethod(responses) {
  const calls = [];
  const mock = async (method, params) => {
    calls.push({ method, params });
    const value = (responses[method] ?? []).shift();
    if (value instanceof Error) throw value;
    return value;
  };
  return { mock, calls };
}

test('analyzeFunderFanOut emits contextual evidence for normal fan-out', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{ transactions: nativeTransfers(10) }],
    ankr_getTokenTransfers: [{ transfers: tokenTransfers(6, { offset: 11 }) }],
  });
  const evidence = await analyzeFunderFanOut(FUNDER, { callAnkr: mock });

  assert.equal(evidence.signalCode, SIGNAL_CODES.FUNDER_FAN_OUT);
  assert.equal(evidence.polarity, 'contextual');
  assert.equal(evidence.strength, 'one_hop');
  assert.equal(evidence.metrics.recipientCount, 16);
  assert.equal(evidence.metrics.spanSeconds, SPAN);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.addresses.length, 17);
  assert.equal(evidence.txHashes.length, 16);
  assert.ok(evidence.blockNumbers.includes(100));
  assert.deepEqual(evidence.observationCutoff, { block: 205, hash: '0xtoken5' });
  assert.match(evidence.rpcMethod, /ankr_getTransactionsByAddress/);
});

test('analyzeFunderFanOut returns null below the distinct-recipient threshold', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{ transactions: nativeTransfers(14) }],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });
  let coverage;
  assert.equal(await analyzeFunderFanOut(FUNDER, {
    callAnkr: mock,
    onCoverage: (value) => { coverage = value; },
  }), null);
  assert.equal(coverage.recipientCount, 14);
  assert.equal(coverage.thresholdMet, false);
});

test('analyzeFunderFanOut applies threshold inclusively and deduplicates recipients', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{ transactions: nativeTransfers(15) }],
    ankr_getTokenTransfers: [{
      transfers: [{
        fromAddress: FUNDER,
        toAddress: address(1).toUpperCase(),
        transactionHash: '0xduplicate',
        timestamp: String(1_000 + SPAN),
      }],
    }],
  });
  const evidence = await analyzeFunderFanOut(FUNDER, { callAnkr: mock });
  assert.equal(evidence.metrics.recipientCount, 15);
  assert.equal(evidence.metrics.spanSeconds, SPAN);
});

test('analyzeFunderFanOut requires the minimum payout time span', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{ transactions: nativeTransfers(20, { span: SPAN - 1 }) }],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });
  let coverage;
  assert.equal(await analyzeFunderFanOut(FUNDER, {
    callAnkr: mock,
    onCoverage: (value) => { coverage = value; },
  }), null);
  assert.equal(coverage.recipientCount, 20);
  assert.equal(coverage.spanSeconds, SPAN - 1);
  assert.equal(coverage.thresholdMet, false);
});

test('analyzeFunderFanOut handles large fan-out within bounded pages', async () => {
  const { mock, calls } = mockByMethod({
    ankr_getTransactionsByAddress: [
      { transactions: nativeTransfers(100), nextPageToken: 'native-2' },
      { transactions: nativeTransfers(80, { offset: 101, start: 1_000 + SPAN }) },
    ],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });
  const evidence = await analyzeFunderFanOut(FUNDER, { callAnkr: mock });
  assert.equal(evidence.metrics.recipientCount, 180);
  assert.equal(calls.length, 3);
  assert.equal(evidence.complete, true);
});

test('analyzeFunderFanOut preserves page-cap incompleteness on positive evidence', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{
      transactions: nativeTransfers(15),
      nextPageToken: 'more',
    }],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });
  let coverage;
  const evidence = await analyzeFunderFanOut(FUNDER, {
    maxPages: 1,
    callAnkr: mock,
    onCoverage: (value) => { coverage = value; },
  });
  assert.equal(evidence.complete, false);
  assert.equal(evidence.incompleteReason, 'page_cap_reached');
  assert.equal(coverage.reason, 'page_cap_reached');
});

test('analyzeFunderFanOut reports malformed RPC data as incomplete', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [undefined],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });
  let coverage;
  assert.equal(await analyzeFunderFanOut(FUNDER, {
    callAnkr: mock,
    onCoverage: (value) => { coverage = value; },
  }), null);
  assert.equal(coverage.complete, false);
  assert.equal(coverage.reason, 'malformed_rpc_result');
});

test('analyzeFunderFanOut performs no RPC work without a direct funder', async () => {
  const { mock, calls } = mockByMethod({});
  assert.equal(await analyzeFunderFanOut(null, { callAnkr: mock }), null);
  assert.equal(calls.length, 0);
});

test('analyzeFunderFanOut cannot exceed the five-page fast-tier cap', async () => {
  const { mock, calls } = mockByMethod({
    ankr_getTransactionsByAddress: Array(6).fill({ transactions: [], nextPageToken: 'native-next' }),
    ankr_getTokenTransfers: Array(6).fill({ transfers: [], nextPageToken: 'token-next' }),
  });
  let coverage;
  assert.equal(await analyzeFunderFanOut(FUNDER, {
    maxPages: 99,
    callAnkr: mock,
    onCoverage: (value) => { coverage = value; },
  }), null);
  assert.equal(calls.length, 10);
  assert.deepEqual(coverage.pagesWalked, { native: 5, token: 5 });
  assert.equal(coverage.complete, false);
});