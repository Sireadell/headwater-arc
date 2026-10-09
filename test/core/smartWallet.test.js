// A wallet with a smart-wallet add-on (EIP-7702) returns code starting
// 0xef0100. It is still a person's wallet, and these tests pin that it is not
// reported as a contract. Until 2026-10-06 it was, on 16 agents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRaters } from '../../src/provenance.js';



const CODE = {
  '0xsmart': '0xef0100' + 'ab'.repeat(20),
  '0xplain': '0x',
  '0xgame': '0x6080604052' + '48e837b9',
};

test('smart wallets are wallets, real contracts are contracts', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async (_url, { body }) => {
    const { params } = JSON.parse(body);
    return { ok: true, json: async () => ({ result: CODE[params[0]] }) };
  };
  try {
    const { classified } = await classifyRaters(Object.keys(CODE));
    assert.equal(classified.get('0xsmart').isContract, false);
    assert.equal(classified.get('0xsmart').isSmartWallet, true);
    assert.equal(classified.get('0xplain').isContract, false);
    assert.equal(classified.get('0xgame').isContract, true);
    assert.deepEqual(classified.get('0xgame').app, ['createGame(uint256)']);
  } finally {
    globalThis.fetch = saved;
  }
});
