import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLiveSolvencyRisk } from '../../src/core/signals/liveSolvencyRisk.js';
import { SIGNAL_CODES } from '../../src/core/evidence/model.js';

const WALLET = '0x1111111111111111111111111111111111111111';

function encodeAccountData({ totalCollateralBase, totalDebtBase, healthFactor }) {
  const word = (n) => n.toString(16).padStart(64, '0');
  // availableBorrowsBase, currentLiquidationThreshold, ltv are unused by
  // this module -- zero-filled here, real position only in the fields
  // that matter to the decoder.
  return `0x${word(totalCollateralBase)}${word(totalDebtBase)}${word(0n)}${word(0n)}${word(0n)}${word(healthFactor)}`;
}

const NO_DEBT = (1n << 256n) - 1n;
const WAD = 10n ** 18n;

test('checkLiveSolvencyRisk returns null when the wallet has no live debt position', async () => {
  let coverage;
  const client = async () => encodeAccountData({ totalCollateralBase: 0n, totalDebtBase: 0n, healthFactor: NO_DEBT });
  const evidence = await checkLiveSolvencyRisk(WALLET, {
    chain: 'eth',
    callPublicRpc: client,
    onCoverage: (scan) => { coverage = scan; },
  });
  assert.equal(evidence, null);
  assert.deepEqual(coverage, { complete: true, reason: 'no_live_debt_position' });
});

test('checkLiveSolvencyRisk returns null for a healthy position well above the liquidation line', async () => {
  const client = async () => encodeAccountData({
    totalCollateralBase: 10_000n * 10n ** 8n,
    totalDebtBase: 2_000n * 10n ** 8n,
    healthFactor: (WAD * 3n), // 3.0, comfortably healthy
  });
  const evidence = await checkLiveSolvencyRisk(WALLET, {
    chain: 'eth', callPublicRpc: client, chain: 'eth' });
  assert.equal(evidence, null, 'a healthy position is not notable on its own');
});

test('checkLiveSolvencyRisk flags a position close to liquidation without marking it already-liquidatable', async () => {
  const client = async () => encodeAccountData({
    totalCollateralBase: 10_000n * 10n ** 8n,
    totalDebtBase: 9_000n * 10n ** 8n,
    healthFactor: (WAD * 11n) / 10n, // 1.1: below the 1.2 "close" threshold, above 1.0
  });
  const evidence = await checkLiveSolvencyRisk(WALLET, {
    chain: 'eth', callPublicRpc: client, chain: 'eth' });
  assert.ok(evidence);
  assert.equal(evidence.signalCode, SIGNAL_CODES.LIVE_SOLVENCY_RISK);
  assert.equal(evidence.polarity, 'contextual');
  assert.equal(evidence.metrics.alreadyLiquidatable, false);
  assert.equal(evidence.metrics.healthFactor, '1.100');
  assert.match(evidence.note, /close enough/);
});

test('checkLiveSolvencyRisk flags a position already eligible for liquidation', async () => {
  const client = async () => encodeAccountData({
    totalCollateralBase: 10_000n * 10n ** 8n,
    totalDebtBase: 11_000n * 10n ** 8n,
    healthFactor: (WAD * 9n) / 10n, // 0.9: already below 1.0
  });
  const evidence = await checkLiveSolvencyRisk(WALLET, {
    chain: 'eth', callPublicRpc: client, chain: 'eth' });
  assert.ok(evidence);
  assert.equal(evidence.metrics.alreadyLiquidatable, true);
  assert.equal(evidence.metrics.healthFactor, '0.900');
  assert.match(evidence.note, /already eligible for liquidation/);
  assert.equal(evidence.metrics.totalCollateralUsd, '$10000.00');
  assert.equal(evidence.metrics.totalDebtUsd, '$11000.00');
});

test('checkLiveSolvencyRisk degrades to partial coverage when the public node is unavailable', async () => {
  let coverage;
  const client = async () => { throw new Error('network unreachable'); };
  const evidence = await checkLiveSolvencyRisk(WALLET, {
    chain: 'eth',
    callPublicRpc: client,
    onCoverage: (scan) => { coverage = scan; },
  });
  assert.equal(evidence, null);
  assert.deepEqual(coverage, { complete: false, reason: 'public_rpc_unavailable' });
});

test('checkLiveSolvencyRisk degrades to partial coverage on a malformed response', async () => {
  let coverage;
  const client = async () => '0x';
  const evidence = await checkLiveSolvencyRisk(WALLET, {
    chain: 'eth',
    callPublicRpc: client,
    onCoverage: (scan) => { coverage = scan; },
  });
  assert.equal(evidence, null);
  assert.deepEqual(coverage, { complete: false, reason: 'malformed_rpc_result' });
});

test('checkLiveSolvencyRisk rejects a short non-empty response instead of reading it as no debt', async () => {
  let coverage;
  const client = async () => '0x01';
  const evidence = await checkLiveSolvencyRisk(WALLET, {
    chain: 'eth',
    callPublicRpc: client,
    onCoverage: (scan) => { coverage = scan; },
  });
  assert.equal(evidence, null);
  assert.deepEqual(coverage, { complete: false, reason: 'malformed_rpc_result' });
});
