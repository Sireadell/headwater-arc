import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDirectCircularFunding } from '../../src/core/signals/circularFunding.js';
import { SIGNAL_CODES } from '../../src/core/evidence/model.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const FUNDER = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';

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

test('checkDirectCircularFunding returns null without funders', async () => {
  const { mock, calls } = mockByMethod({});
  assert.equal(await checkDirectCircularFunding(WALLET, [], { callAnkr: mock }), null);
  assert.equal(calls.length, 0);
});

test('checkDirectCircularFunding finds a direct native circular transfer', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{
      transactions: [{
        from: WALLET.toUpperCase(),
        to: FUNDER,
        hash: '0xcircular',
        blockNumber: 77,
        value: '500',
        status: '0x1',
      }],
    }],
  });
  const evidence = await checkDirectCircularFunding(WALLET, [FUNDER], { callAnkr: mock });
  assert.equal(evidence.signalCode, SIGNAL_CODES.DIRECT_CIRCULAR_FUNDING);
  assert.equal(evidence.polarity, 'risk');
  assert.equal(evidence.strength, 'direct');
  assert.deepEqual(evidence.addresses, [WALLET, FUNDER]);
  assert.deepEqual(evidence.txHashes, ['0xcircular']);
  assert.deepEqual(evidence.blockNumbers, [77]);
  assert.equal(evidence.asset.from, WALLET);
  assert.equal(evidence.asset.to, FUNDER);
  assert.equal(evidence.asset.valueRaw, '500');
  assert.equal(evidence.complete, true);
});

test('checkDirectCircularFunding finds a token circular transfer after unrelated native history', async () => {
  const { mock, calls } = mockByMethod({
    ankr_getTransactionsByAddress: [{
      transactions: [{ from: WALLET, to: OTHER, hash: '0xother' }],
    }],
    ankr_getTokenTransfers: [{
      transfers: [
        { fromAddress: OTHER, toAddress: FUNDER, transactionHash: '0xunrelated' },
        // Ankr's real ankr_getTokenTransfers response field is
        // blockHeight, not blockNumber -- this mock intentionally
        // matches the real API shape so this test would catch a
        // regression back to reading transfer.blockNumber.
        { fromAddress: WALLET, toAddress: FUNDER, transactionHash: '0xtoken', blockHeight: 88, valueRawInteger: '9', tokenSymbol: 'USDC' },
      ],
    }],
  });
  const evidence = await checkDirectCircularFunding(WALLET, [FUNDER], { callAnkr: mock });
  assert.equal(evidence.rpcMethod, 'ankr_getTokenTransfers');
  assert.deepEqual(evidence.txHashes, ['0xtoken']);
  assert.deepEqual(evidence.blockNumbers, [88]);
  assert.equal(evidence.asset.symbol, 'USDC');
  assert.equal(calls.length, 2);
});

// Regression test for a live-caught bug: circularFunding.js's token-transfer
// path read transfer.blockNumber, a field ankr_getTokenTransfers does not
// return (the real field is blockHeight). transfer.blockNumber was always
// undefined, so hasHighProvenance was always false for token-sourced
// matches, so a genuine circular-funding match was permanently downgraded
// to polarity 'contextual' and excluded from risk scoring -- this is
// exactly what happened on a real OFAC-sanctioned wallet (Ronin Bridge
// Exploiter) whose circular-funding evidence was a USDC token transfer.
test('checkDirectCircularFunding scores a token-only circular transfer as risk-bearing with full provenance', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{ transactions: [] }],
    ankr_getTokenTransfers: [{
      transfers: [
        { fromAddress: WALLET, toAddress: FUNDER, transactionHash: '0xronin-style', blockHeight: 14837404, valueRawInteger: '25500000000000', tokenSymbol: 'USDC' },
      ],
    }],
  });
  const evidence = await checkDirectCircularFunding(WALLET, [FUNDER], { callAnkr: mock });
  assert.equal(evidence.polarity, 'risk');
  assert.equal(evidence.complete, true);
  assert.equal(evidence.incompleteReason, undefined);
  assert.deepEqual(evidence.txHashes, ['0xronin-style']);
  assert.deepEqual(evidence.blockNumbers, [14837404]);
  assert.equal(evidence.asset.symbol, 'USDC');
});

test('checkDirectCircularFunding ignores unrelated outbound transactions', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{ transactions: [{ from: WALLET, to: OTHER, hash: '0xother' }] }],
    ankr_getTokenTransfers: [{ transfers: [{ fromAddress: WALLET, toAddress: OTHER, transactionHash: '0xother-token' }] }],
  });
  assert.equal(await checkDirectCircularFunding(WALLET, [FUNDER], { callAnkr: mock }), null);
});

test('checkDirectCircularFunding reports malformed RPC results as incomplete', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [undefined],
    ankr_getTokenTransfers: [{ transfers: 'invalid' }],
  });
  let coverage;
  assert.equal(await checkDirectCircularFunding(WALLET, [FUNDER], {
    callAnkr: mock,
    onCoverage: (value) => { coverage = value; },
  }), null);
  assert.equal(coverage.complete, false);
  assert.equal(coverage.reason, 'malformed_rpc_result');
});

test('checkDirectCircularFunding propagates RPC failures', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [new Error('provider unavailable')],
  });
  await assert.rejects(
    checkDirectCircularFunding(WALLET, [FUNDER], { callAnkr: mock }),
    /provider unavailable/
  );
});

test('checkDirectCircularFunding reports a bounded no-match scan', async () => {
  const { mock, calls } = mockByMethod({
    ankr_getTransactionsByAddress: Array(6).fill({ transactions: [], nextPageToken: 'native-next' }),
    ankr_getTokenTransfers: Array(6).fill({ transfers: [], nextPageToken: 'token-next' }),
  });
  let coverage;
  assert.equal(await checkDirectCircularFunding(WALLET, [FUNDER], {
    maxPages: 99,
    callAnkr: mock,
    onCoverage: (value) => { coverage = value; },
  }), null);
  assert.equal(calls.length, 10);
  assert.deepEqual(coverage.pagesWalked, { native: 5, token: 5 });
  assert.equal(coverage.complete, false);
  assert.equal(coverage.reason, 'page_cap_reached');
});

test('checkDirectCircularFunding downgrades a match missing transaction hash', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{
      transactions: [{ from: WALLET, to: FUNDER, blockNumber: 77, value: '500', status: '0x1' }],
    }],
  });
  let coverage;
  const evidence = await checkDirectCircularFunding(WALLET, [FUNDER], {
    callAnkr: mock,
    onCoverage: (value) => { coverage = value; },
  });
  assert.equal(evidence.polarity, 'contextual');
  assert.equal(evidence.complete, false);
  assert.equal(evidence.incompleteReason, 'missing_transaction_provenance');
  assert.equal(coverage.complete, false);
  assert.equal(coverage.reason, 'missing_transaction_provenance');
});

test('checkDirectCircularFunding downgrades a match missing block number', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{
      transactions: [{ from: WALLET, to: FUNDER, hash: '0xcircular', value: '500', status: '0x1' }],
    }],
  });
  const evidence = await checkDirectCircularFunding(WALLET, [FUNDER], { callAnkr: mock });
  assert.equal(evidence.polarity, 'contextual');
  assert.equal(evidence.complete, false);
  assert.deepEqual(evidence.txHashes, ['0xcircular']);
  assert.equal(evidence.blockNumbers, undefined);
});

test('checkDirectCircularFunding ignores a reverted native transaction to the funder', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{
      transactions: [{
        from: WALLET, to: FUNDER, hash: '0xreverted', blockNumber: 77, value: '500', status: '0x0',
      }],
    }],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });
  assert.equal(await checkDirectCircularFunding(WALLET, [FUNDER], { callAnkr: mock }), null);
});

test('checkDirectCircularFunding ignores a zero-value contract call to the funder (e.g. Safe execTransaction)', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{
      transactions: [{
        from: WALLET, to: FUNDER, hash: '0xexectransaction', blockNumber: 77, value: '0', status: '0x1',
      }],
    }],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });
  assert.equal(await checkDirectCircularFunding(WALLET, [FUNDER], { callAnkr: mock }), null);
});

test('checkDirectCircularFunding ignores a native transaction with no status field', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{
      transactions: [{ from: WALLET, to: FUNDER, hash: '0xnostatus', blockNumber: 77, value: '500' }],
    }],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });
  assert.equal(await checkDirectCircularFunding(WALLET, [FUNDER], { callAnkr: mock }), null);
});

test('checkDirectCircularFunding ignores a zero-value decoded token transfer to the funder', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{ transactions: [] }],
    ankr_getTokenTransfers: [{
      transfers: [{
        fromAddress: WALLET, toAddress: FUNDER, transactionHash: '0xzerotoken', blockNumber: 88, valueRawInteger: '0', tokenSymbol: 'USDC',
      }],
    }],
  });
  assert.equal(await checkDirectCircularFunding(WALLET, [FUNDER], { callAnkr: mock }), null);
});

test('checkDirectCircularFunding accepts a successful value-bearing native transfer with matching status', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{
      transactions: [{
        from: WALLET, to: FUNDER, hash: '0xgenuine', blockNumber: 77, value: '500', status: '0x1',
      }],
    }],
  });
  const evidence = await checkDirectCircularFunding(WALLET, [FUNDER], { callAnkr: mock });
  assert.equal(evidence.polarity, 'risk');
  assert.equal(evidence.asset.valueRaw, '500');
});