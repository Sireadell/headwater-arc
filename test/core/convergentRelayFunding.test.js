import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConvergentRelayFunding } from '../../src/core/signals/convergentRelayFunding.js';
import { SIGNAL_CODES } from '../../src/core/evidence/model.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const F1 = '0x2222222222222222222222222222222222222222';
const F2 = '0x3333333333333333333333333333333333333333';
const UPSTREAM = '0x4444444444444444444444444444444444444444';
const UNRELATED_UPSTREAM_1 = '0x5555555555555555555555555555555555555555';
const UNRELATED_UPSTREAM_2 = '0x6666666666666666666666666666666666666666';
const KNOWN_EXCHANGE = '0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be'; // Binance, see knownEntities.js

const WALLET_RELATIONSHIPS = [
  { funder: F1, txHash: '0xf1wallet', blockNumber: 100, timestamp: 2000, valueRaw: '1000000000000000000' },
  { funder: F2, txHash: '0xf2wallet', blockNumber: 101, timestamp: 2100, valueRaw: '1000000000000000000' },
];

// Keyed by method then lowercased queried address, matching the pattern
// used in test/routes/assessmentPath.test.js.
function mockByAddress(responses) {
  const mock = async (method, params) => {
    const address = params.address?.[0]?.toLowerCase();
    const value = responses[method]?.[address];
    if (value instanceof Error) throw value;
    if (value === undefined) {
      return method === 'ankr_getTransactionsByAddress' ? { transactions: [] } : { transfers: [] };
    }
    return value;
  };
  return mock;
}

function nativeTx({ from, to, hash, blockNumber, timestamp, value = '1000000000000000000' }) {
  return { from, to, hash, blockNumber, timestamp: `0x${timestamp.toString(16)}`, value, status: '0x1' };
}

test('checkConvergentRelayFunding finds a common upstream funder behind two distinct relevant funders', async () => {
  const mock = mockByAddress({
    ankr_getTransactionsByAddress: {
      [F1.toLowerCase()]: { transactions: [nativeTx({ from: UPSTREAM, to: F1, hash: '0xu1', blockNumber: 10, timestamp: 1000 })] },
      [F2.toLowerCase()]: { transactions: [nativeTx({ from: UPSTREAM, to: F2, hash: '0xu2', blockNumber: 11, timestamp: 1050 })] },
    },
  });

  const evidence = await checkConvergentRelayFunding(WALLET, [F1, F2], WALLET_RELATIONSHIPS, { callAnkr: mock });

  assert.ok(evidence, 'expected convergent relay funding evidence');
  assert.equal(evidence.signalCode, SIGNAL_CODES.CONVERGENT_RELAY_FUNDING);
  assert.equal(evidence.polarity, 'contextual');
  assert.equal(evidence.strength, 'two_hop');
  assert.deepEqual(evidence.addresses, [WALLET, F1, F2, UPSTREAM]);
  assert.equal(evidence.metrics.provenanceComplete, true);
  assert.equal(evidence.metrics.orderedRelay, true);
  assert.equal(evidence.metrics.amountConsistent, true);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.relationships.length, 4);
});

test('checkConvergentRelayFunding returns null when funders share no common upstream', async () => {
  const mock = mockByAddress({
    ankr_getTransactionsByAddress: {
      [F1.toLowerCase()]: { transactions: [nativeTx({ from: UNRELATED_UPSTREAM_1, to: F1, hash: '0xu1', blockNumber: 10, timestamp: 1000 })] },
      [F2.toLowerCase()]: { transactions: [nativeTx({ from: UNRELATED_UPSTREAM_2, to: F2, hash: '0xu2', blockNumber: 11, timestamp: 1050 })] },
    },
  });

  const evidence = await checkConvergentRelayFunding(WALLET, [F1, F2], WALLET_RELATIONSHIPS, { callAnkr: mock });
  assert.equal(evidence, null);
});

test('checkConvergentRelayFunding excludes a common upstream that is a known exchange', async () => {
  const mock = mockByAddress({
    ankr_getTransactionsByAddress: {
      [F1.toLowerCase()]: { transactions: [nativeTx({ from: KNOWN_EXCHANGE, to: F1, hash: '0xu1', blockNumber: 10, timestamp: 1000 })] },
      [F2.toLowerCase()]: { transactions: [nativeTx({ from: KNOWN_EXCHANGE, to: F2, hash: '0xu2', blockNumber: 11, timestamp: 1050 })] },
    },
  });

  const evidence = await checkConvergentRelayFunding(WALLET, [F1, F2], WALLET_RELATIONSHIPS, { callAnkr: mock });
  assert.equal(evidence, null, 'a shared known-exchange upstream should not be treated as convergent relay funding');
});

test('checkConvergentRelayFunding is a no-op with fewer than two relevant funders', async () => {
  let coverageCalls = 0;
  const evidence = await checkConvergentRelayFunding(WALLET, [F1], WALLET_RELATIONSHIPS, {
    callAnkr: async () => { throw new Error('should never call RPC'); },
    onCoverage: (scan) => {
      coverageCalls += 1;
      assert.equal(scan.complete, true);
      assert.equal(scan.reason, 'fewer_than_two_relevant_funders');
    },
  });
  assert.equal(evidence, null);
  assert.equal(coverageCalls, 1);
});
