// The secondary signals shown under every verdict, computed from the saved
// Arc payments list and the saved reviews. They are context, not verdicts:
// each one says what it saw and why that is or is not unusual.
//
// Thresholds are the ones the Monad build used. Time on Arc is measured in
// blocks (about two a second), which is fine for the two signals that care
// only about spacing and ratios.

const ZERO = '0x0000000000000000000000000000000000000000';
const BLOCKS_PER_DAY = 172_800;            // about two blocks a second
const FAN_OUT_MIN_RECIPIENTS = 15;
const FAN_OUT_MIN_SPAN_BLOCKS = Math.round(BLOCKS_PER_DAY * 25 / 24);
const DISTRIBUTOR_RECIPIENTS = 25;          // a funder paying this many wallets is distributing, not coordinating
const MIN_SHARED_FUNDER_REVIEWERS = 2;
const MIN_CADENCE_INTERVALS = 5;
const MAX_CADENCE_CV = 0.35;
const MIN_BORN_TOGETHER = 3;

const short = (a) => `${a.slice(0, 8)}...${a.slice(-4)}`;

/**
 * @param {{ transfers: any[], hubs: Set<string> }} index
 * @param {Map<number, any[]>} byAgent reviews per agent
 */
export function makeSignalContext(index, byAgent) {
  const hubs = index.hubs;
  const firstIn = new Map();     // wallet -> Map(funder -> { block, tx })
  const recipients = new Map();  // funder -> { wallets:Set, first, last }
  const paid = new Map();        // from -> Set(to)
  for (const t of index.transfers) {
    if (t.fromAddress === t.toAddress || t.fromAddress === ZERO) continue;
    if (!paid.has(t.fromAddress)) paid.set(t.fromAddress, new Set());
    paid.get(t.fromAddress).add(t.toAddress);
    if (!firstIn.has(t.toAddress)) firstIn.set(t.toAddress, new Map());
    const m = firstIn.get(t.toAddress);
    if (!m.has(t.fromAddress)) m.set(t.fromAddress, { block: t.blockNumber, tx: t.transactionHash });
    if (!recipients.has(t.fromAddress)) recipients.set(t.fromAddress, { wallets: new Set(), first: t.blockNumber, last: t.blockNumber });
    const r = recipients.get(t.fromAddress);
    r.wallets.add(t.toAddress);
    r.last = Math.max(r.last, t.blockNumber);
  }
  const agentsOf = new Map();    // reviewer -> Set(agentId)
  for (const [agentId, rows] of byAgent) for (const f of rows) {
    if (!agentsOf.has(f.reviewer)) agentsOf.set(f.reviewer, new Set());
    agentsOf.get(f.reviewer).add(agentId);
  }
  return { hubs, firstIn, recipients, paid, agentsOf, byAgent };
}

export function signalsFor(ctx, { agentId, owner, raters }) {
  const out = [];
  const rows = ctx.byAgent.get(agentId) ?? [];
  const funderOf = (w) => [...(ctx.firstIn.get(w) ?? [])].filter(([f]) => !ctx.hubs.has(f));

  // 1. Owner funded other agents' reviewers.
  const ownerPaid = ctx.paid.get(owner) ?? new Set();
  const otherAgents = new Set();
  for (const w of ownerPaid) for (const a of ctx.agentsOf.get(w) ?? []) if (a !== agentId) otherAgents.add(a);
  out.push({
    key: 'owner_funded_other_agents', title: 'Owner funded other agents\' reviewers', triggered: otherAgents.size > 0,
    desc: otherAgents.size > 0
      ? `This agent's owner paid wallets that reviewed ${otherAgents.size} other agent${otherAgents.size === 1 ? '' : 's'} (${[...otherAgents].slice(0, 8).join(', ')}).`
      : 'This agent\'s owner has not paid any wallet that reviewed a different agent.',
  });

  // 2. The same reviewer on several agents.
  const overlaps = raters.map((r) => ({ r, n: ctx.agentsOf.get(r)?.size ?? 0 })).filter((x) => x.n > 1);
  out.push({
    key: 'cross_agent_review_overlap', title: 'Cross-agent review overlap', triggered: overlaps.length > 0,
    desc: overlaps.length > 0
      ? `${overlaps.length} of this agent's reviewers also reviewed other agents (${overlaps.slice(0, 4).map((x) => `${short(x.r)}: ${x.n} agents`).join('; ')}). One wallet on several agents is not proof of anything, but it is one identity spread across places that are meant to look independent.`
      : 'None of this agent\'s reviewers reviewed any other agent.',
  });

  // 3. Circular funding: a reviewer paid its own first funder back.
  const circular = [];
  for (const r of raters) for (const [f] of funderOf(r)) if (ctx.paid.get(r)?.has(f)) circular.push({ r, f });
  out.push({
    key: 'circular_funding', title: 'Circular funding', triggered: circular.length > 0,
    desc: circular.length > 0
      ? `${circular.length} reviewer${circular.length === 1 ? '' : 's'} paid money back to a wallet that had funded it (${circular.slice(0, 3).map((c) => `${short(c.r)} to ${short(c.f)}`).join('; ')}).`
      : 'No reviewer paid money back to a wallet that funded it.',
  });

  // 4. Funder fan-out: a funder of this agent's reviewers that pays many wallets over a long span.
  const fan = [];
  const seenF = new Set();
  for (const r of raters) for (const [f] of funderOf(r)) {
    if (seenF.has(f)) continue; seenF.add(f);
    const info = ctx.recipients.get(f);
    if (info && info.wallets.size >= FAN_OUT_MIN_RECIPIENTS && info.last - info.first >= FAN_OUT_MIN_SPAN_BLOCKS) fan.push({ f, n: info.wallets.size });
  }
  out.push({
    key: 'funder_fan_out', title: 'Funder fan-out', triggered: fan.length > 0,
    desc: fan.length > 0
      ? `A funder of this agent's reviewers paid ${fan[0].n} different wallets over more than a day (${short(fan[0].f)}). Alone this is circumstantial: a busy funder looks the same as an exchange.`
      : 'No funder of this agent\'s reviewers paid 15 or more wallets over a long span.',
  });

  // 5. Shared funding source among this agent's reviewers.
  const byFunder = new Map();
  for (const r of raters) for (const [f] of funderOf(r)) {
    if ((ctx.recipients.get(f)?.wallets.size ?? 0) >= DISTRIBUTOR_RECIPIENTS) continue;
    if (!byFunder.has(f)) byFunder.set(f, new Set());
    byFunder.get(f).add(r);
  }
  const shared = [...byFunder].filter(([, s]) => s.size >= MIN_SHARED_FUNDER_REVIEWERS);
  out.push({
    key: 'shared_funding_source', title: 'Shared funding source', triggered: shared.length > 0,
    desc: shared.length > 0
      ? `Wallet ${short(shared[0][0])} paid ${shared[0][1].size} of this agent's ${raters.length} reviewers. Reviewers that look separate got their money from the same place.`
      : 'No single person-sized wallet paid two or more of this agent\'s reviewers.',
  });

  // 6. Wallets created together (first payment received, as a stand-in for the wallet's birth).
  const born = raters.map((r) => [...(ctx.firstIn.get(r) ?? [])].reduce((m, [, v]) => Math.min(m, v.block), Infinity)).filter(Number.isFinite).sort((a, b) => a - b);
  let batch = 0;
  for (let i = 0; i < born.length; i++) { let j = i; while (j < born.length && born[j] - born[i] <= BLOCKS_PER_DAY) j++; batch = Math.max(batch, j - i); }
  out.push({
    key: 'wallets_created_together', title: 'Wallets created together', triggered: batch >= MIN_BORN_TOGETHER,
    desc: batch >= MIN_BORN_TOGETHER
      ? `${batch} of this agent's reviewers first received money within the same day. Measured from each wallet's first incoming payment, since that is what the payments list holds.`
      : `No ${MIN_BORN_TOGETHER} or more of this agent's reviewers first received money within one day of each other.`,
  });

  // 7. Review timing: ragged gaps are people, near-identical gaps are scripts.
  const timed = [];
  const byRater = new Map();
  for (const f of rows) { if (!byRater.has(f.reviewer)) byRater.set(f.reviewer, []); byRater.get(f.reviewer).push(f.block); }
  for (const [r, blocks] of byRater) {
    const gaps = blocks.slice(1).map((b, i) => b - blocks[i]).filter((g) => g > 0);
    if (gaps.length < MIN_CADENCE_INTERVALS) continue;
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
    if (mean > 0 && sd / mean <= MAX_CADENCE_CV) timed.push({ r, n: gaps.length, cv: sd / mean });
  }
  out.push({
    key: 'automated_review_timing', title: 'Automated review timing', triggered: timed.length > 0,
    desc: timed.length > 0
      ? `${timed.length} reviewer${timed.length === 1 ? '' : 's'} left reviews at near-identical intervals (${short(timed[0].r)}: ${timed[0].n} gaps, spread ${timed[0].cv.toFixed(2)}). People review at ragged intervals; scripts do not.`
      : `No reviewer left ${MIN_CADENCE_INTERVALS + 1} or more reviews of this agent at near-identical intervals. Most agents have too few reviews to tell.`,
  });
  return out;
}
