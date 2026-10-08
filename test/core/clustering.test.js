import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordAndGetFundingCluster } from '../../src/core/signals/clustering.js';
import { SIGNAL_CODES } from '../../src/core/evidence/model.js';

const FUNDER = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';

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

function native(to, hash, extras = {}) {
  return { from: FUNDER, to, hash, blockNumber: extras.blockNumber ?? 10, timestamp: '0x64', value: '10', ...extras };
}

function token(to, hash, extras = {}) {
  return { fromAddress: FUNDER, toAddress: to, transactionHash: hash, blockNumber: extras.blockNumber ?? 20, timestamp: '100', valueRawInteger: '10', tokenSymbol: 'USDC', ...extras };
}

test('cluster reports distinct members with per-edge provenance', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{ transactions: [native(WALLET, '0xa'), native(OTHER, '0xb', { blockNumber: 11, blockHash: '0xblock' })] }],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });
  const evidence = await recordAndGetFundingCluster(FUNDER, WALLET, { callAnkr: mock });
  assert.equal(evidence.signalCode, SIGNAL_CODES.FUNDING_CLUSTER);
  assert.equal(evidence.polarity, 'contextual');
  assert.equal(evidence.strength, 'one_hop');
  assert.equal(evidence.metrics.clusterSize, 2);
  assert.equal(evidence.relationships.length, 2);
  assert.ok(evidence.relationships.every((edge) => edge.from && edge.to && edge.rpcMethod));
  assert.deepEqual(evidence.observationCutoff, { block: 11, hash: '0xblock' });
});

test('duplicate events across pages do not increase members or supporting edges', async () => {
  const duplicate = native(WALLET, '0xa');
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [
      { transactions: [duplicate, native(OTHER, '0xb')], nextPageToken: 'p2' },
      { transactions: [duplicate] },
    ],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });
  const evidence = await recordAndGetFundingCluster(FUNDER, WALLET, { callAnkr: mock });
  assert.equal(evidence.metrics.clusterSize, 2);
  assert.equal(evidence.metrics.supportingEdgeCount, 2);
});

test('repeated per-request analysis is deterministic and has no accumulated state', async () => {
  const responses = () => ({
    ankr_getTransactionsByAddress: [{ transactions: [native(WALLET, '0xa'), native(OTHER, '0xb')] }],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });
  const first = await recordAndGetFundingCluster(FUNDER, WALLET, { callAnkr: mockByMethod(responses()).mock });
  const second = await recordAndGetFundingCluster(FUNDER, WALLET, { callAnkr: mockByMethod(responses()).mock });
  assert.equal(first.metrics.clusterSize, 2);
  assert.equal(second.metrics.clusterSize, 2);
  assert.equal(first.evidenceId, second.evidenceId);
});

test('multiple transfers to one wallet preserve support but count one member', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{ transactions: [native(WALLET, '0xa'), native(WALLET, '0xb'), native(OTHER, '0xc')] }],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });
  const evidence = await recordAndGetFundingCluster(FUNDER, WALLET, { callAnkr: mock });
  assert.equal(evidence.metrics.clusterSize, 2);
  assert.equal(evidence.metrics.supportingEdgeCount, 3);
  assert.equal(evidence.relationships.filter((edge) => edge.to === WALLET).length, 2);
});

test('native and token duplicate representation is conservatively deduplicated', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{ transactions: [native(WALLET, '0xsame'), native(OTHER, '0xb')] }],
    ankr_getTokenTransfers: [{ transfers: [token(WALLET, '0xsame')] }],
  });
  const evidence = await recordAndGetFundingCluster(FUNDER, WALLET, { callAnkr: mock });
  assert.equal(evidence.metrics.clusterSize, 2);
  assert.equal(evidence.metrics.supportingEdgeCount, 2);
});

test('only exact funder outbound records become cluster relationships', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{ transactions: [native(WALLET, '0xa'), { from: OTHER, to: WALLET, hash: '0xunrelated' }, native(OTHER, '0xb')] }],
    ankr_getTokenTransfers: [{ transfers: [{ fromAddress: OTHER, toAddress: WALLET, transactionHash: '0xunrelated-token' }] }],
  });
  const evidence = await recordAndGetFundingCluster(FUNDER, WALLET, { callAnkr: mock });
  assert.equal(evidence.metrics.supportingEdgeCount, 2);
  assert.ok(evidence.relationships.every((edge) => edge.from.toLowerCase() === FUNDER));
});

test('cluster preserves token log index and asset provenance when supplied', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{ transactions: [] }],
    ankr_getTokenTransfers: [{ transfers: [token(WALLET, '0xa', { logIndex: 1, tokenAddress: '0x4444444444444444444444444444444444444444' }), token(OTHER, '0xa', { logIndex: 2 })] }],
  });
  const evidence = await recordAndGetFundingCluster(FUNDER, WALLET, { callAnkr: mock });
  assert.equal(evidence.relationships[0].logIndex, 1);
  assert.equal(evidence.relationships[0].asset.address, '0x4444444444444444444444444444444444444444');
});

test('five-page hard cap and malformed data produce incomplete coverage', async () => {
  const endless = { transactions: [], nextPageToken: 'next' };
  const { mock, calls } = mockByMethod({
    ankr_getTransactionsByAddress: Array(6).fill(endless),
    ankr_getTokenTransfers: Array(6).fill({ transfers: [], nextPageToken: 'next' }),
  });
  let coverage;
  assert.equal(await recordAndGetFundingCluster(FUNDER, WALLET, { maxPages: 99, callAnkr: mock, onCoverage: (value) => { coverage = value; } }), null);
  assert.equal(calls.length, 10);
  assert.deepEqual(coverage.pagesWalked, { native: 5, token: 5 });
  assert.equal(coverage.reason, 'page_cap_reached');

  const malformed = mockByMethod({ ankr_getTransactionsByAddress: [undefined], ankr_getTokenTransfers: [{ transfers: [] }] });
  await recordAndGetFundingCluster(FUNDER, WALLET, { callAnkr: malformed.mock, onCoverage: (value) => { coverage = value; } });
  assert.equal(coverage.reason, 'malformed_rpc_result');
});

test('no direct funder means zero cluster work and no second-hop calls', async () => {
  const { mock, calls } = mockByMethod({});
  assert.equal(await recordAndGetFundingCluster(null, WALLET, { callAnkr: mock }), null);
  assert.equal(calls.length, 0);
});

test('three recipients funded within the burst window set burstDetected', async () => {
  const THIRD = '0x4444444444444444444444444444444444444444';
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{
      transactions: [
        native(WALLET, '0xa', { timestamp: '0x64' }),
        native(OTHER, '0xb', { timestamp: '0x96' }),
        native(THIRD, '0xc', { timestamp: '0xc8' }),
      ],
    }],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });
  const evidence = await recordAndGetFundingCluster(FUNDER, WALLET, { callAnkr: mock });
  assert.equal(evidence.metrics.burstDetected, true);
  assert.ok(evidence.note.includes('within a'));
});

test('three recipients spread far apart in time do not set burstDetected', async () => {
  const THIRD = '0x4444444444444444444444444444444444444444';
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{
      transactions: [
        native(WALLET, '0xa', { timestamp: '0x64' }),
        native(OTHER, '0xb', { timestamp: '0x1388' }),
        native(THIRD, '0xc', { timestamp: '0x2710' }),
      ],
    }],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });
  const evidence = await recordAndGetFundingCluster(FUNDER, WALLET, { callAnkr: mock });
  assert.equal(evidence.metrics.burstDetected, false);
});

test('three recipients funded near-identical amounts set amountUniformityDetected', async () => {
  const THIRD = '0x4444444444444444444444444444444444444444';
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{
      transactions: [
        native(WALLET, '0xa', { value: '1000000000000000000' }),
        native(OTHER, '0xb', { value: '1005000000000000000' }),
        native(THIRD, '0xc', { value: '1010000000000000000' }),
      ],
    }],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });
  const evidence = await recordAndGetFundingCluster(FUNDER, WALLET, { callAnkr: mock });
  assert.equal(evidence.metrics.amountUniformityDetected, true);
  assert.ok(evidence.note.includes('near-identical amounts'));
});

test('three recipients funded widely different amounts do not set amountUniformityDetected', async () => {
  const THIRD = '0x4444444444444444444444444444444444444444';
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{
      transactions: [
        native(WALLET, '0xa', { value: '1000000000000000000' }),
        native(OTHER, '0xb', { value: '5000000000000000000' }),
        native(THIRD, '0xc', { value: '9000000000000000000' }),
      ],
    }],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });
  const evidence = await recordAndGetFundingCluster(FUNDER, WALLET, { callAnkr: mock });
  assert.equal(evidence.metrics.amountUniformityDetected, false);
});

test('note explicitly disclaims cross-funder Sybil detection', async () => {
  const { mock } = mockByMethod({
    ankr_getTransactionsByAddress: [{ transactions: [native(WALLET, '0xa'), native(OTHER, '0xb')] }],
    ankr_getTokenTransfers: [{ transfers: [] }],
  });
  const evidence = await recordAndGetFundingCluster(FUNDER, WALLET, { callAnkr: mock });
  assert.ok(evidence.note.includes('multiple different funder addresses'));
});