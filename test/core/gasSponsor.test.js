import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectGasSponsor } from '../../src/core/signals/gasSponsor.js';

// fetchTokenTransfers/fetchTransactionByHash are injected, so these tests
// never touch the network, same pattern as circularFunding.test.js.

function tokenFetcher(outbound) {
  return async () => ({
    transfers: outbound.map(([fromAddress, transactionHash]) => ({ fromAddress, transactionHash })),
  });
}

function hashLookup(map) {
  return async (hash) => ({ from: map[hash] });
}

test('a wallet whose own outbound transfers were broadcast by itself has no sponsor', async () => {
  const result = await detectGasSponsor(
    '0xWallet',
    tokenFetcher([['0xWallet', '0xhash1']]),
    hashLookup({ '0xhash1': '0xWallet' })
  );
  assert.equal(result, null);
});

test('a wallet whose outbound transfer was broadcast by a different address has a sponsor', async () => {
  const result = await detectGasSponsor(
    '0xWallet',
    tokenFetcher([['0xWallet', '0xhash1']]),
    hashLookup({ '0xhash1': '0xRelayer' })
  );
  assert.deepEqual(result, { sponsor: '0xrelayer', matchedTxHash: '0xhash1' });
});

test('matches case-insensitively — same address in different casing is not a sponsor', async () => {
  const result = await detectGasSponsor(
    '0xWALLET',
    tokenFetcher([['0xwallet', '0xhash1']]),
    hashLookup({ '0xhash1': '0xWaLLeT' })
  );
  assert.equal(result, null);
});

test('a wallet with no outbound token transfers has no sponsor evidence', async () => {
  const result = await detectGasSponsor('0xWallet', tokenFetcher([]), hashLookup({}));
  assert.equal(result, null);
});

test('stops at the first sponsored transfer found, does not need to check every one', async () => {
  let lookups = 0;
  const countingLookup = async (hash) => {
    lookups += 1;
    return { from: hash === '0xhash1' ? '0xRelayer' : '0xWallet' };
  };
  const result = await detectGasSponsor(
    '0xWallet',
    tokenFetcher([
      ['0xWallet', '0xhash1'],
      ['0xWallet', '0xhash2'],
      ['0xWallet', '0xhash3'],
    ]),
    countingLookup
  );
  assert.deepEqual(result, { sponsor: '0xrelayer', matchedTxHash: '0xhash1' });
  assert.equal(lookups, 1);
});

test('inbound transfers to the wallet are never mistaken for its own outbound activity', async () => {
  const result = await detectGasSponsor(
    '0xWallet',
    tokenFetcher([['0xSomeoneElse', '0xhash1']]), // fromAddress is NOT the wallet
    hashLookup({ '0xhash1': '0xRelayer' })
  );
  assert.equal(result, null);
});

test('a fetch error degrades to no evidence rather than throwing', async () => {
  const throwingFetcher = async () => {
    throw new Error('network blip');
  };
  const result = await detectGasSponsor('0xWallet', throwingFetcher, hashLookup({}));
  assert.equal(result, null);
});

test('a transaction-lookup error for one transfer degrades to no evidence rather than throwing', async () => {
  const throwingLookup = async () => {
    throw new Error('network blip');
  };
  const result = await detectGasSponsor('0xWallet', tokenFetcher([['0xWallet', '0xhash1']]), throwingLookup);
  assert.equal(result, null);
});
