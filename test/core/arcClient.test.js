// Tests for the Arc transport. No network: the index path and the log
// decoding are pure, and the live path is not exercised here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callArc, decodeSystemLog, addressToTopic, setIndexForTests, SYSTEM_EMITTER, TRANSFER_TOPIC } from '../../src/core/rpc/arcClient.js';
import { callAnkr } from '../../src/core/rpc/client.js';

const A = '0x6a663faa871f0622ff2435b65f514faf876c59bf';
const B = '0x0ba8d43e0176324b5a6ae68e64c37f64e734ae73';
const C = '0x1111111111111111111111111111111111111111';

test('a system log is decoded with its 18-decimal value turned into 6-decimal USDC units', () => {
  const log = {
    address: SYSTEM_EMITTER,
    topics: [TRANSFER_TOPIC, addressToTopic(B), addressToTopic(A)],
    data: '0x' + (600_000n * 10n ** 12n).toString(16), // 0.6 USDC at 18 decimals
    transactionHash: '0xabc',
    blockNumber: '0x10',
    logIndex: '0x0',
  };
  const item = decodeSystemLog(log, 1000);
  assert.equal(item.fromAddress, B);
  assert.equal(item.toAddress, A);
  assert.equal(item.valueRawInteger, '600000');
  assert.equal(item.blockNumber, 16);
  assert.equal(item.tokenSymbol, 'USDC');
  assert.equal(item.timestamp, 1000);
});

test('an indexed wallet is answered from the index, in both directions, with no network call', async () => {
  setIndexForTests({
    toBlock: 25_000_000,
    wallets: [A, B],
    transfers: [
      { fromAddress: B, toAddress: A, transactionHash: '0x1', blockNumber: 1, valueRawInteger: '600000', tokenSymbol: 'USDC' },
      { fromAddress: A, toAddress: C, transactionHash: '0x2', blockNumber: 2, valueRawInteger: '1', tokenSymbol: 'USDC' },
      { fromAddress: C, toAddress: B, transactionHash: '0x3', blockNumber: 3, valueRawInteger: '1', tokenSymbol: 'USDC' },
    ],
  });
  const res = await callArc('arc_getTokenTransfers', { address: A.toUpperCase().replace('0X', '0x') });
  assert.deepEqual(res.transfers.map((t) => t.transactionHash), ['0x1', '0x2']);
  assert.equal(res.nextPageToken, undefined);
  assert.equal(res._source, 'index');
});

test('the Ankr-shaped entrypoint routes token transfers to the Arc reader', async () => {
  setIndexForTests({ toBlock: 1, wallets: [B], transfers: [{ fromAddress: C, toAddress: B, transactionHash: '0x9', blockNumber: 1, valueRawInteger: '5', tokenSymbol: 'USDC' }] });
  const res = await callAnkr('ankr_getTokenTransfers', { address: B, blockchain: 'arc' });
  assert.equal(res.transfers.length, 1);
});

test('native transfer history is complete and empty, because native sends are already in the system log', async () => {
  const res = await callArc('arc_getTransactionsByAddress', { address: A });
  assert.deepEqual(res.transactions, []);
  assert.equal(res.nextPageToken, undefined);
  assert.equal(res._nativeTransferHistoryUnavailable, undefined);
});

test('an unknown method fails loudly', async () => {
  await assert.rejects(() => callArc('arc_nope', { address: A }), /Unknown Arc RPC method/);
});
