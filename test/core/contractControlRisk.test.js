import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkContractControlRisk } from '../../src/core/signals/contractControlRisk.js';
import { SIGNAL_CODES } from '../../src/core/evidence/model.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const OWNER = '0x9999999999999999999999999999999999999999';

const ownerCallResult = `0x${'0'.repeat(24)}${OWNER.slice(2)}`;
const trueBoolResult = `0x${'0'.repeat(63)}1`;
const falseBoolResult = `0x${'0'.repeat(64)}`;
const zeroSlotResult = `0x${'0'.repeat(64)}`;
const nonZeroSlotResult = `0x${'0'.repeat(24)}${'a'.repeat(40)}`;

function mockByMethod(handlers) {
  return async (method, params) => {
    const handler = handlers[method];
    if (!handler) throw new Error(`unexpected method ${method}`);
    return handler(params);
  };
}

// Bytecode long enough to be "a contract" and, for the mint-detection
// tests, containing the mint(address,uint256) selector (40c10f19)
// somewhere in the middle -- position doesn't matter, this is a plain
// substring scan, not ABI-aware.
const CODE_WITHOUT_MINT = '0x6080604052';
const CODE_WITH_MINT = `0x608060405263${'40c10f19'}00`;

test('checkContractControlRisk returns null for a plain EOA (empty code)', async () => {
  const calls = [];
  const client = async (method, params) => {
    calls.push(method);
    return '0x';
  };
  const evidence = await checkContractControlRisk(WALLET, {
    chain: 'eth', callPublicRpc: client, chain: 'eth' });
  assert.equal(evidence, null);
  assert.deepEqual(calls, ['eth_getCode']);
});

test('checkContractControlRisk returns null and reports coverage for an EIP-7702-delegated EOA', async () => {
  const delegationCode = `0xef0100${'b'.repeat(40)}`;
  let coverage;
  const client = async () => delegationCode;
  const evidence = await checkContractControlRisk(WALLET, {
    chain: 'eth',
    callPublicRpc: client,
    onCoverage: (scan) => { coverage = scan; },
  });
  assert.equal(evidence, null);
  assert.deepEqual(coverage, { complete: true, reason: 'eoa_with_eip7702_delegation' });
});

test('checkContractControlRisk returns null for an immutable, ownerless contract', async () => {
  const client = mockByMethod({
    eth_getCode: () => CODE_WITHOUT_MINT,
    eth_call: () => '0x', // owner() and paused() both revert/empty
    eth_getStorageAt: () => zeroSlotResult,
  });
  const evidence = await checkContractControlRisk(WALLET, {
    chain: 'eth', callPublicRpc: client, chain: 'eth' });
  assert.equal(evidence, null, 'no owner detected, so nothing risk-bearing to report even though it is a contract');
});

test('checkContractControlRisk returns null when a contract has an owner but no dangerous capability', async () => {
  const client = mockByMethod({
    eth_getCode: () => CODE_WITHOUT_MINT,
    eth_call: (params) => {
      const [{ data }] = params;
      if (data === '0x8da5cb5b') return ownerCallResult; // owner()
      return '0x'; // paused() reverts -- not pausable
    },
    eth_getStorageAt: () => zeroSlotResult, // not a proxy
  });
  const evidence = await checkContractControlRisk(WALLET, {
    chain: 'eth', callPublicRpc: client, chain: 'eth' });
  assert.equal(evidence, null, 'owner-controlled alone, with no pause/upgrade/mint capability, is not notable on its own');
});

test('checkContractControlRisk reports stablecoin-shaped controls as contextual evidence', async () => {
  let coverage;
  const client = mockByMethod({
    eth_getCode: () => CODE_WITH_MINT,
    eth_call: (params) => {
      const [{ data }] = params;
      if (data === '0x8da5cb5b') return ownerCallResult;
      if (data === '0x5c975abb') return trueBoolResult;
      throw new Error('unexpected selector');
    },
    eth_getStorageAt: () => nonZeroSlotResult,
  });

  const evidence = await checkContractControlRisk(WALLET, {
    chain: 'eth',
    callPublicRpc: client,
    onCoverage: (scan) => { coverage = scan; },
  });

  assert.ok(evidence);
  assert.equal(evidence.signalCode, SIGNAL_CODES.CONTRACT_CONTROL_RISK);
  assert.equal(evidence.polarity, 'contextual');
  assert.deepEqual(evidence.metrics, {
    isContract: true,
    ownerControlled: true,
    pausable: true,
    upgradeable: true,
    mintAuthorityDetected: true,
  });
  assert.ok(evidence.addresses.includes(OWNER.toLowerCase()) || evidence.addresses.some((a) => a.toLowerCase() === OWNER.toLowerCase()));
  assert.match(evidence.note, /pause the contract/);
  assert.match(evidence.note, /upgrade its logic/);
  assert.match(evidence.note, /mint\(address,uint256\)/);
  assert.deepEqual(coverage, { complete: true, reason: 'contract_inspected' });
});

test('checkContractControlRisk exempts a known-exchange address without making any RPC call', async () => {
  const COINBASE_10 = '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43';
  let coverage;
  const client = async () => { throw new Error('should never be called for a known-exchange address'); };
  const evidence = await checkContractControlRisk(COINBASE_10, {
    chain: 'eth',
    callPublicRpc: client,
    onCoverage: (scan) => { coverage = scan; },
  });
  assert.equal(evidence, null);
  assert.deepEqual(coverage, { complete: true, reason: 'known_exchange_or_bridge_exempt' });
});

test('checkContractControlRisk degrades to a partial-coverage no-op when the public node is unavailable', async () => {
  let coverage;
  const client = async () => { throw new Error('network unreachable'); };
  const evidence = await checkContractControlRisk(WALLET, {
    chain: 'eth',
    callPublicRpc: client,
    onCoverage: (scan) => { coverage = scan; },
  });
  assert.equal(evidence, null);
  assert.deepEqual(coverage, { complete: false, reason: 'public_rpc_unavailable' });
});

test('checkContractControlRisk reports partial coverage when capability probes fail', async () => {
  let coverage;
  const client = mockByMethod({
    eth_getCode: () => CODE_WITH_MINT,
    eth_call: () => { throw new Error('network unreachable'); },
    eth_getStorageAt: () => zeroSlotResult,
  });

  const evidence = await checkContractControlRisk(WALLET, {
    chain: 'eth',
    callPublicRpc: client,
    onCoverage: (scan) => { coverage = scan; },
  });

  assert.equal(evidence, null);
  assert.deepEqual(coverage, { complete: false, reason: 'contract_inspection_incomplete' });
});

test('checkContractControlRisk rejects short capability responses as incomplete', async () => {
  let coverage;
  const client = mockByMethod({
    eth_getCode: () => CODE_WITH_MINT,
    eth_call: () => '0x1',
    eth_getStorageAt: () => '0x2',
  });

  const evidence = await checkContractControlRisk(WALLET, {
    chain: 'eth',
    callPublicRpc: client,
    onCoverage: (scan) => { coverage = scan; },
  });

  assert.equal(evidence, null);
  assert.deepEqual(coverage, { complete: false, reason: 'contract_inspection_incomplete' });
});
