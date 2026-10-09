// Tests for "who sent the review". A smart wallet or a contract can have its
// review sent, and paid for, by another address. On Monad the agent's own
// owner did exactly that for nine agents, through smart wallets that never
// held any money, and those agents read as THIN before this rule existed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVerdict, splitSenders } from '../../src/provenance.js';



const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const OWNER = addr(1);
const SMART = addr(100);

const base = {
  owner: OWNER,
  reviewers: [SMART],
  feedbackCount: 1,
  funding: { direct: [], indirect: [], tracedRaters: 1, ratersWithKnownFunder: 0 },
  raterTypes: { classified: new Map(), sampled: 0, total: 1 },
  selfRated: 0,
};

test('splitSenders separates the owner from other senders', () => {
  const senders = new Map([
    [SMART, new Set([OWNER])],
    [addr(101), new Set([addr(7)])],
  ]);
  const { ownerSent, otherSenders } = splitSenders(OWNER, senders);
  assert.deepEqual(ownerSent, [SMART]);
  assert.deepEqual(otherSenders.get(addr(101)), [addr(7)]);
  assert.equal(otherSenders.has(SMART), false);
});

test('splitSenders makes no claim without sender data', () => {
  const { ownerSent, otherSenders } = splitSenders(OWNER, undefined);
  assert.deepEqual(ownerSent, []);
  assert.equal(otherSenders.size, 0);
});

test('a review the owner sent through another wallet is SELF REVIEWED, not THIN', () => {
  const thin = buildVerdict({ ...base });
  assert.equal(thin.label, 'THIN');
  const v = buildVerdict({ ...base, ownerSent: [SMART] });
  assert.equal(v.label, 'SELF REVIEWED');
  assert.match(v.summary, /owner sent the review/);
  assert.ok(v.findings.some((f) => /did not send its own review/.test(f)));
});

test('owner sending reviews does not outrank an application majority', () => {
  const classified = new Map([[SMART, { isContract: true, app: ['createGame(uint256)'] }]]);
  const v = buildVerdict({
    ...base,
    raterTypes: { classified, sampled: 1, total: 1 },
    ownerSent: [SMART],
  });
  assert.equal(v.label, 'APP GENERATED');
  assert.ok(v.findings.some((f) => /owner sent and paid/.test(f)));
});
