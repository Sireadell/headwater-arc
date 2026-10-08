import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDirectFunder } from '../../src/core/signals/fundingRelationship.js';
import { checkDirectCircularFunding } from '../../src/core/signals/circularFunding.js';
import { SIGNAL_CODES } from '../../src/core/evidence/model.js';
import { config } from '../../src/config.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const FUNDER = '0x2222222222222222222222222222222222222222';

function mockByMethod(responses) {
  const calls = [];
  const mock = async (method, params) => {
    calls.push({ method, params });
    const queue = responses[method] ?? [];
    const value = queue.shift();
    if (value instanceof Error) throw value;
    return value;
  };
  return { mock, calls };
}

test('findDirectFunder returns direct native funding evidence', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{
      transactions: [{
        from: FUNDER,
        to: WALLET.toUpperCase(),
        hash: '0xnative',
        blockNumber: 42,
        timestamp: '0x64',
        value: '1000',
        status: '0x1',
      }],
    }],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });

  const evidence = await findDirectFunder(WALLET, { callAnkr: mock });

  assert.equal(evidence.signalCode, SIGNAL_CODES.DIRECT_FUNDER);
  assert.equal(evidence.polarity, 'contextual');
  assert.equal(evidence.strength, 'direct');
  assert.deepEqual(evidence.addresses, [WALLET, FUNDER]);
  assert.deepEqual(evidence.txHashes, ['0xnative']);
  assert.deepEqual(evidence.blockNumbers, [42]);
  assert.equal(evidence.asset.from, FUNDER);
  assert.equal(evidence.asset.to, WALLET);
  assert.equal(evidence.asset.valueRaw, '1000');
  assert.equal(evidence.asset.timestamp, 100);
  assert.equal(evidence.rpcMethod, 'ankr_getTransactionsByAddress');
  assert.equal(evidence.complete, true);
});

// Regression test: Ankr's ankr_getTransactionsByAddress returns results
// newest-first by default (confirmed live against the API, undocumented),
// but findDirectFunder needs the wallet's earliest inbound transaction, so
// the native request must explicitly ask for oldest-first order. The
// sibling ankr_getTokenTransfers call already defaults to oldest-first, so
// it must NOT send descOrder at all -- asserting both sides here catches
// either direction of regression.
test('findDirectFunder requests native transactions oldest-first, leaves token request untouched', async () => {
  const { mock, calls } = mockByMethod({
    ankr_getTransactionsByAddress: [{ transactions: [] }],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });

  await findDirectFunder(WALLET, { callAnkr: mock });

  const nativeCall = calls.find((call) => call.method === 'ankr_getTransactionsByAddress');
  const tokenCall = calls.find((call) => call.method === 'ankr_getTokenTransfers');
  assert.equal(nativeCall.params.descOrder, false);
  assert.equal(tokenCall.params.descOrder, undefined);
});

// A cache-collision test from the original signal code covered a separate
// rate-limit layer that this build does not have (callAnkr routes straight
// to the Arc reader, see src/core/rpc/client.js), so it was dropped.

test('findDirectFunder returns null when no transfer qualifies', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{ transactions: [{ from: FUNDER, to: FUNDER, timestamp: '0x1' }] }],
    ankr_getTokenTransfers: [{ transfers: [{ fromAddress: FUNDER, toAddress: FUNDER, timestamp: 1 }] }],
  });
  assert.equal(await findDirectFunder(WALLET, { callAnkr: mock }), null);
});

test('findDirectFunder walks multiple pages and chooses earliest across sources', async () => {
  const tokenFunder = '0x3333333333333333333333333333333333333333';
  const { mock, calls } = mockByMethod({
    ankr_getTransactionsByAddress: [
      { transactions: [], nextPageToken: 'native-2' },
      { transactions: [{ from: FUNDER, to: WALLET, hash: '0xlater', timestamp: '0xc8', value: '2' }] },
    ],
    ankr_getTokenTransfers: [
      { transfers: [], nextPageToken: 'token-2' },
      { transfers: [{ fromAddress: tokenFunder, toAddress: WALLET, transactionHash: '0xearliest', timestamp: '50', valueRawInteger: '9' }] },
    ],
  });

  const evidence = await findDirectFunder(WALLET, { callAnkr: mock });
  assert.equal(evidence.addresses[1], tokenFunder);
  assert.deepEqual(evidence.txHashes, ['0xearliest']);
  assert.equal(evidence.rpcMethod, 'ankr_getTokenTransfers');
  assert.equal(calls.length, 4);
  const nativeCalls = calls.filter((call) => call.method === 'ankr_getTransactionsByAddress');
  const tokenCalls = calls.filter((call) => call.method === 'ankr_getTokenTransfers');
  assert.equal(nativeCalls[1].params.pageToken, 'native-2');
  assert.equal(tokenCalls[1].params.pageToken, 'token-2');
});

test('findDirectFunder marks evidence and coverage incomplete at page limit', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{
      transactions: [{
        from: FUNDER, to: WALLET, hash: '0xbounded', timestamp: '0x64', value: '5', status: '0x1',
      }],
      nextPageToken: 'still-more',
    }],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });
  let coverage;
  const evidence = await findDirectFunder(WALLET, {
    maxPages: 1,
    callAnkr: mock,
    onCoverage: (value) => { coverage = value; },
  });
  assert.equal(evidence.complete, false);
  assert.equal(evidence.incompleteReason, 'page_cap_reached');
  assert.deepEqual(coverage, {
    complete: false,
    pagesWalked: { native: 1, token: 1 },
    reason: 'page_cap_reached',
  });
});

test('findDirectFunder reports malformed RPC results as incomplete', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [undefined],
    ankr_getTokenTransfers: [{ transfers: 'not-an-array' }],
  });
  let coverage;
  assert.equal(await findDirectFunder(WALLET, {
    callAnkr: mock,
    onCoverage: (value) => { coverage = value; },
  }), null);
  assert.equal(coverage.complete, false);
  assert.equal(coverage.reason, 'malformed_rpc_result');
});

test('findDirectFunder propagates RPC failures', async () => {
  const failure = new Error('provider unavailable');
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [failure],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });
  await assert.rejects(findDirectFunder(WALLET, { callAnkr: mock }), /provider unavailable/);
});

test('findDirectFunder qualifies a successful positive-value native inbound transfer', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{
      transactions: [{
        from: FUNDER, to: WALLET, hash: '0xgenuine', blockNumber: 42, timestamp: '0x64', value: '1000', status: '0x1',
      }],
    }],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });
  const evidence = await findDirectFunder(WALLET, { callAnkr: mock });
  assert.equal(evidence.addresses[1], FUNDER);
  assert.equal(evidence.asset.valueRaw, '1000');
});

test('findDirectFunder rejects a reverted native inbound transaction', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{
      transactions: [{
        from: FUNDER, to: WALLET, hash: '0xreverted', timestamp: '0x64', value: '1000', status: '0x0',
      }],
    }],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });
  assert.equal(await findDirectFunder(WALLET, { callAnkr: mock }), null);
});

test('findDirectFunder rejects a zero-value native inbound transaction', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{
      transactions: [{
        from: FUNDER, to: WALLET, hash: '0xzero', timestamp: '0x64', value: '0', status: '0x1',
      }],
    }],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });
  assert.equal(await findDirectFunder(WALLET, { callAnkr: mock }), null);
});

test('findDirectFunder rejects a native inbound transaction with no status field', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{
      transactions: [{ from: FUNDER, to: WALLET, hash: '0xnostatus', timestamp: '0x64', value: '1000' }],
    }],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });
  assert.equal(await findDirectFunder(WALLET, { callAnkr: mock }), null);
});

test('findDirectFunder never exceeds the fast-tier page cap', async () => {
  const endlessPage = { transactions: [], nextPageToken: 'next' };
  const endlessTokenPage = { transfers: [], nextPageToken: 'next' };
  const { mock, calls } = mockByMethod({
    ankr_getTransactionsByAddress: Array(4).fill(endlessPage),
    ankr_getTokenTransfers: Array(4).fill(endlessTokenPage),
  });
  let coverage;
  assert.equal(await findDirectFunder(WALLET, {
    maxPages: 99,
    callAnkr: mock,
    onCoverage: (value) => { coverage = value; },
  }), null);
  assert.equal(calls.length, 6);
  assert.deepEqual(coverage.pagesWalked, { native: 3, token: 3 });
  assert.equal(coverage.complete, false);
});