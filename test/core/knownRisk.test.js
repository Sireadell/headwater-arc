import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyKnownRisk,
  checkKnownRiskAddress,
  checkKnownRiskFunder,
} from '../../src/core/signals/knownRisk.js';
import { SIGNAL_CODES } from '../../src/core/evidence/model.js';

const SANCTIONED_ADDRESS = '0x0330070fd38ec3bb94f58fa55d40368271e9e54a'; // OFAC SDN list
const SCAM_ADDRESS = '0x101ce0cedd142f199c9ef61739ae59b6611a0fc0'; // scamsniffer list
const UNKNOWN_ADDRESS = '0x1111111111111111111111111111111111111111';

test('classifyKnownRisk matches a sanctioned address, case-insensitively', () => {
  assert.deepEqual(classifyKnownRisk(SANCTIONED_ADDRESS), { type: 'sanctioned' });
  assert.deepEqual(classifyKnownRisk(SANCTIONED_ADDRESS.toUpperCase()), { type: 'sanctioned' });
});

test('classifyKnownRisk matches a known-scam address', () => {
  assert.deepEqual(classifyKnownRisk(SCAM_ADDRESS), { type: 'known_scam' });
});

test('classifyKnownRisk returns null for an unrecognized address', () => {
  assert.equal(classifyKnownRisk(UNKNOWN_ADDRESS), null);
});

test('classifyKnownRisk returns null for a missing address', () => {
  assert.equal(classifyKnownRisk(null), null);
  assert.equal(classifyKnownRisk(undefined), null);
  assert.equal(classifyKnownRisk(''), null);
});

test('checkKnownRiskAddress emits risk, registry-derived evidence for a sanctioned match', () => {
  const evidence = checkKnownRiskAddress(SANCTIONED_ADDRESS);
  assert.equal(evidence.signalCode, SIGNAL_CODES.SANCTIONED_ADDRESS);
  assert.equal(evidence.polarity, 'risk');
  assert.equal(evidence.strength, 'registry_derived');
  assert.equal(evidence.entityClassification, 'sanctioned');
  assert.equal(evidence.complete, true);
  assert.deepEqual(evidence.addresses, [SANCTIONED_ADDRESS]);
  assert.ok(evidence.source?.name);
});

test('checkKnownRiskAddress emits risk, registry-derived evidence for a scam-list match', () => {
  const evidence = checkKnownRiskAddress(SCAM_ADDRESS);
  assert.equal(evidence.signalCode, SIGNAL_CODES.KNOWN_SCAM_ADDRESS);
  assert.equal(evidence.polarity, 'risk');
  assert.equal(evidence.entityClassification, 'known_scam');
});

test('checkKnownRiskAddress returns null for an unrecognized address', () => {
  assert.equal(checkKnownRiskAddress(UNKNOWN_ADDRESS), null);
});

test('checkKnownRiskAddress returns null for no address', () => {
  assert.equal(checkKnownRiskAddress(null), null);
});

test('checkKnownRiskFunder preserves the match as contextual funder evidence', () => {
  const evidence = checkKnownRiskFunder(SCAM_ADDRESS);
  assert.equal(evidence.signalCode, SIGNAL_CODES.KNOWN_SCAM_FUNDER);
  assert.equal(evidence.polarity, 'contextual');
  assert.equal(evidence.entityClassification, 'known_scam_funder');
  assert.deepEqual(evidence.addresses, [SCAM_ADDRESS]);
  assert.ok(evidence.source?.name);
  assert.match(evidence.note, /funder/i);
  assert.doesNotMatch(evidence.note, /assessed wallet directly matches/i);
});
