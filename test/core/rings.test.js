// Tests for ring detection: groups that only show up when several agents are
// looked at together. The two positive cases are the shapes measured on chain
// on 2026-10-06, and the negative cases are the ordinary behaviour the guards
// exist to leave alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRings, buildVerdict } from '../../src/provenance.js';



const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const rate = (agent, rater) => ({ agent_id: String(agent), reviewer_id: rater });
const paid = (funder, wallet, isDust = false) => ({ funder, wallet, isDust });

test('one outside wallet funding the raters of three agents is a ring', () => {
  const funder = addr(9);
  const agents = [1, 2, 3].map((id) => ({ id: String(id), owner: addr(1) }));
  const feedback = [rate(1, addr(11)), rate(2, addr(12)), rate(3, addr(13))];
  const funders = [paid(funder, addr(11)), paid(funder, addr(12)), paid(funder, addr(13))];
  const rings = findRings({ feedback, agents, funders });
  assert.equal(rings.length, 1);
  assert.equal(rings[0].kind, 'shared funder');
  assert.deepEqual(rings[0].agents, ['1', '2', '3']);
});

test('the owner funding its own raters is not a ring, it is OWNER FUNDED', () => {
  const owner = addr(1);
  const agents = [1, 2, 3].map((id) => ({ id: String(id), owner }));
  const feedback = [rate(1, addr(11)), rate(2, addr(12)), rate(3, addr(13))];
  const funders = [paid(owner, addr(11)), paid(owner, addr(12)), paid(owner, addr(13))];
  assert.equal(findRings({ feedback, agents, funders }).length, 0);
});

test('a faucet that topped up a few raters among many is not a ring', () => {
  const faucet = addr(9);
  const agents = [1, 2, 3].map((id) => ({ id: String(id), owner: addr(id) }));
  const feedback = [];
  const funders = [];
  for (const id of [1, 2, 3]) {
    for (let i = 0; i < 10; i++) feedback.push(rate(id, addr(id * 100 + i)));
    funders.push(paid(faucet, addr(id * 100)));
  }
  assert.equal(findRings({ feedback, agents, funders }).length, 0);
});

test('gas top-ups alone never make a ring', () => {
  const funder = addr(9);
  const agents = [1, 2, 3].map((id) => ({ id: String(id), owner: addr(id) }));
  const feedback = [rate(1, addr(11)), rate(2, addr(12)), rate(3, addr(13))];
  const funders = [11, 12, 13].map((n) => paid(funder, addr(n), true));
  assert.equal(findRings({ feedback, agents, funders }).length, 0);
});

test('one rater covering three agents whose owners share a funder is a ring', () => {
  const family = addr(7);
  const rater = addr(50);
  const agents = [1, 2, 3].map((id) => ({ id: String(id), owner: addr(id) }));
  const feedback = [1, 2, 3].map((id) => rate(id, rater));
  const funders = [1, 2, 3].map((id) => paid(family, addr(id)));
  const rings = findRings({ feedback, agents, funders });
  assert.equal(rings.length, 1);
  assert.equal(rings[0].kind, 'one rater, one family of owners');
  assert.equal(rings[0].source, family);
});

test('a wide reviewer of unrelated agents is not a ring', () => {
  const rater = addr(50);
  const agents = [1, 2, 3].map((id) => ({ id: String(id), owner: addr(id) }));
  const feedback = [1, 2, 3].map((id) => rate(id, rater));
  const funders = [1, 2, 3].map((id) => paid(addr(id + 20), addr(id)));
  assert.equal(findRings({ feedback, agents, funders }).length, 0);
});

test('RING outranks THIN but OWNER FUNDED and SELF REVIEWED outrank RING', () => {
  const ring = { kind: 'shared funder', source: addr(9), agents: ['1', '2', '3'], raters: [addr(11), addr(12)], owners: [addr(1)] };
  const base = {
    owner: addr(1),
    reviewers: [addr(11)],
    feedbackCount: 1,
    raterTypes: { classified: new Map(), sampled: 0, total: 1 },
    selfRated: 0,
    agentId: '1',
    rings: [ring],
  };
  const clean = { direct: [], indirect: [], tracedRaters: 1, ratersWithKnownFunder: 1 };
  const v = buildVerdict({ ...base, funding: clean });
  assert.equal(v.label, 'RING');
  assert.ok(v.findings.some((f) => f.includes('2 other')));

  const owned = { ...clean, direct: [{ rater: addr(11), isDust: false }] };
  const w = buildVerdict({ ...base, funding: owned });
  assert.equal(w.label, 'OWNER FUNDED');
  assert.ok(w.findings.some((f) => f.includes('funded 2 raters')));

  const s = buildVerdict({ ...base, funding: clean, selfRated: 1 });
  assert.equal(s.label, 'SELF REVIEWED');
});

test('no rings supplied means no ring claim', () => {
  const v = buildVerdict({
    owner: addr(1),
    reviewers: [addr(11)],
    feedbackCount: 1,
    funding: { direct: [], indirect: [], tracedRaters: 1, ratersWithKnownFunder: 1 },
    raterTypes: { classified: new Map(), sampled: 0, total: 1 },
    selfRated: 0,
  });
  assert.equal(v.label, 'THIN');
});
