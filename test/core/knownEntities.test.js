import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyKnownEntity,
  checkKnownExchangeFunder,
  checkKnownBridgeFunder,
} from '../../src/core/signals/knownEntities.js';
import { SIGNAL_CODES } from '../../src/core/evidence/model.js';

const KNOWN_EXCHANGE = '0x4b4e14a3773ee558b6597070797fd51eb48606e5'; // "OKX: Hot Wallet"
const KNOWN_BRIDGE = '0x3154cf16ccdb4c6d922629664174b904d80f2c35'; // "Base: Base Bridge"
const UNKNOWN_ADDRESS = '0x1111111111111111111111111111111111111111';

test('classifyKnownEntity matches a built-in exchange address, case-insensitively', () => {
  assert.deepEqual(classifyKnownEntity(KNOWN_EXCHANGE), { type: 'known_exchange' });
  assert.deepEqual(classifyKnownEntity(KNOWN_EXCHANGE.toUpperCase()), { type: 'known_exchange' });
});

test('classifyKnownEntity returns null for an unrecognized address', () => {
  assert.equal(classifyKnownEntity(UNKNOWN_ADDRESS), null);
});

test('classifyKnownEntity returns null for a missing address', () => {
  assert.equal(classifyKnownEntity(null), null);
  assert.equal(classifyKnownEntity(undefined), null);
  assert.equal(classifyKnownEntity(''), null);
});

test('checkKnownExchangeFunder emits exculpatory, registry-derived evidence for a match', () => {
  const evidence = checkKnownExchangeFunder(KNOWN_EXCHANGE);
  assert.equal(evidence.signalCode, SIGNAL_CODES.KNOWN_EXCHANGE_FUNDER);
  assert.equal(evidence.polarity, 'exculpatory');
  assert.equal(evidence.strength, 'registry_derived');
  assert.equal(evidence.entityClassification, 'known_exchange');
  assert.equal(evidence.complete, true);
  assert.deepEqual(evidence.addresses, [KNOWN_EXCHANGE]);
  assert.ok(evidence.source?.name);
});

test('checkKnownExchangeFunder returns null for an unrecognized funder', () => {
  assert.equal(checkKnownExchangeFunder(UNKNOWN_ADDRESS), null);
});

test('checkKnownExchangeFunder returns null for no funder', () => {
  assert.equal(checkKnownExchangeFunder(null), null);
});

test('classifyKnownEntity matches a built-in bridge address, case-insensitively', () => {
  assert.deepEqual(classifyKnownEntity(KNOWN_BRIDGE), { type: 'known_bridge' });
  assert.deepEqual(classifyKnownEntity(KNOWN_BRIDGE.toUpperCase()), { type: 'known_bridge' });
});

test('checkKnownBridgeFunder emits exculpatory, registry-derived evidence for a match', () => {
  const evidence = checkKnownBridgeFunder(KNOWN_BRIDGE);
  assert.equal(evidence.signalCode, SIGNAL_CODES.KNOWN_BRIDGE_FUNDER);
  assert.equal(evidence.polarity, 'exculpatory');
  assert.equal(evidence.strength, 'registry_derived');
  assert.equal(evidence.entityClassification, 'known_bridge');
  assert.equal(evidence.complete, true);
  assert.deepEqual(evidence.addresses, [KNOWN_BRIDGE]);
  assert.ok(evidence.source?.name);
});

test('checkKnownBridgeFunder returns null for an unrecognized funder', () => {
  assert.equal(checkKnownBridgeFunder(UNKNOWN_ADDRESS), null);
});

test('checkKnownBridgeFunder returns null for no funder', () => {
  assert.equal(checkKnownBridgeFunder(null), null);
});

test('checkKnownExchangeFunder does not fire for a bridge address, and vice versa', () => {
  assert.equal(checkKnownExchangeFunder(KNOWN_BRIDGE), null);
  assert.equal(checkKnownBridgeFunder(KNOWN_EXCHANGE), null);
});
