import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySubjectApplicability,
  checkSubjectApplicability,
} from '../../src/core/signals/subjectApplicability.js';
import { SIGNAL_CODES } from '../../src/core/evidence/model.js';

const NULL_ADDRESS = '0x0000000000000000000000000000000000000000';
const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const MIXER_ADDRESS = '0x722122dF12D4e14e13Ac3b6895a86e84145b6967';
const NORMAL_ADDRESS = '0x1111111111111111111111111111111111111111';

test('classifySubjectApplicability matches the zero address', () => {
  assert.deepEqual(classifySubjectApplicability(NULL_ADDRESS), { type: 'burn_null' });
});

test('classifySubjectApplicability matches the conventional burn address, case-insensitively', () => {
  assert.deepEqual(classifySubjectApplicability(BURN_ADDRESS), { type: 'burn_null' });
  assert.deepEqual(classifySubjectApplicability(BURN_ADDRESS.toLowerCase()), { type: 'burn_null' });
});

test('classifySubjectApplicability matches a known mixer contract', () => {
  assert.deepEqual(classifySubjectApplicability(MIXER_ADDRESS), { type: 'known_mixer' });
});

test('classifySubjectApplicability returns null for an ordinary address', () => {
  assert.equal(classifySubjectApplicability(NORMAL_ADDRESS), null);
});

test('classifySubjectApplicability returns null for a missing address', () => {
  assert.equal(classifySubjectApplicability(null), null);
  assert.equal(classifySubjectApplicability(undefined), null);
  assert.equal(classifySubjectApplicability(''), null);
});

test('checkSubjectApplicability emits contextual, registry-derived evidence for a burn address', () => {
  const evidence = checkSubjectApplicability(BURN_ADDRESS);
  assert.equal(evidence.signalCode, SIGNAL_CODES.SUBJECT_NOT_STANDARD_WALLET);
  assert.equal(evidence.polarity, 'contextual');
  assert.equal(evidence.strength, 'registry_derived');
  assert.equal(evidence.entityClassification, 'burn_null');
  assert.equal(evidence.complete, true);
  assert.deepEqual(evidence.addresses, [BURN_ADDRESS]);
  assert.ok(evidence.note.length > 0);
});

test('checkSubjectApplicability emits evidence for a known mixer contract', () => {
  const evidence = checkSubjectApplicability(MIXER_ADDRESS);
  assert.equal(evidence.entityClassification, 'known_mixer');
});

test('checkSubjectApplicability returns null for an ordinary wallet', () => {
  assert.equal(checkSubjectApplicability(NORMAL_ADDRESS), null);
});
