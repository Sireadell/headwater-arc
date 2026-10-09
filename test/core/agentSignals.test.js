import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSignalContext, signalsFor } from '../../src/agentSignals.js';

const a = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const pay = (from, to, block, tx = `0x${block}`) => ({ fromAddress: from, toAddress: to, blockNumber: block, transactionHash: tx });
const rev = (agentId, reviewer, block) => ({ agentId, reviewer, block });

function run(transfers, reviews, agentId, owner, raters, hubs = new Set()) {
  const byAgent = new Map();
  for (const r of reviews) { if (!byAgent.has(r.agentId)) byAgent.set(r.agentId, []); byAgent.get(r.agentId).push(r); }
  const ctx = makeSignalContext({ transfers, hubs }, byAgent);
  return Object.fromEntries(signalsFor(ctx, { agentId, owner, raters }).map((s) => [s.key, s.triggered]));
}

test('two reviewers paid by the same person-sized wallet trigger the shared funding source', () => {
  const [R1, R2, F, O] = [a(1), a(2), a(3), a(4)];
  const s = run([pay(F, R1, 100), pay(F, R2, 101)], [rev(1, R1, 200), rev(1, R2, 201)], 1, O, [R1, R2]);
  assert.equal(s.shared_funding_source, true);
});

test('a busy shared wallet is not a shared funding source', () => {
  const [R1, R2, F, O] = [a(1), a(2), a(3), a(4)];
  const s = run([pay(F, R1, 100), pay(F, R2, 101)], [rev(1, R1, 200), rev(1, R2, 201)], 1, O, [R1, R2], new Set([F]));
  assert.equal(s.shared_funding_source, false);
});

test('a reviewer that pays its own funder back is circular funding', () => {
  const [R, F, O] = [a(1), a(2), a(3)];
  const s = run([pay(F, R, 100), pay(R, F, 150)], [rev(1, R, 120)], 1, O, [R]);
  assert.equal(s.circular_funding, true);
});

test('an owner that paid a wallet that reviewed another agent is flagged', () => {
  const [R, O] = [a(1), a(2)];
  const s = run([pay(O, R, 100)], [rev(1, a(9), 120), rev(2, R, 130)], 1, O, [a(9)]);
  assert.equal(s.owner_funded_other_agents, true);
});

test('a reviewer on several agents is cross-agent overlap', () => {
  const R = a(1);
  const s = run([], [rev(1, R, 10), rev(2, R, 20)], 1, a(2), [R]);
  assert.equal(s.cross_agent_review_overlap, true);
});

test('evenly spaced reviews are automated timing, ragged ones are not', () => {
  const R = a(1);
  const even = [10, 20, 30, 40, 50, 60].map((b) => rev(1, R, b));
  assert.equal(run([], even, 1, a(2), [R]).automated_review_timing, true);
  const ragged = [10, 12, 90, 95, 700, 701].map((b) => rev(1, R, b));
  assert.equal(run([], ragged, 1, a(2), [R]).automated_review_timing, false);
});

test('three reviewers first paid on the same day are wallets created together', () => {
  const [R1, R2, R3, F] = [a(1), a(2), a(3), a(4)];
  const s = run([pay(F, R1, 1000), pay(F, R2, 2000), pay(F, R3, 3000)], [rev(1, R1, 1), rev(1, R2, 1), rev(1, R3, 1)], 1, a(9), [R1, R2, R3]);
  assert.equal(s.wallets_created_together, true);
});
