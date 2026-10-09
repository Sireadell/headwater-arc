// Tests for the provenance verdict shown on the lookup page and returned by
// the JSON API and the MCP server.
//
// buildVerdict is the part of this project that decides what a reader is told,
// and it is the part that was wrong once. An earlier version of this product
// announced that agents 153 to 158 were manipulating reviews. Their raters are
// game contracts, and each of their transactions carries one positive and one
// negative score, which is a winner and a loser. These tests pin the ordering
// that prevents that mistake from returning: when most raters are application
// contracts, the verdict says so rather than leading with owner funding.
//
// docs/provenance.js is a browser script rather than a module, for the reason
// given at the top of tools/lib.mjs, so it is evaluated here the same way the
// API and MCP server load it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVerdict } from '../../src/provenance.js';



const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const OWNER = addr(1);

function raterTypes({ sampled = 0, total = sampled, contracts = 0, apps = 0 } = {}) {
  const classified = new Map();
  for (let i = 0; i < sampled; i++) {
    const isApp = i < apps;
    const isContract = i < contracts || isApp;
    classified.set(addr(100 + i), {
      isContract,
      app: isApp ? ['createGame(uint256)'] : null,
    });
  }
  return { classified, sampled, total };
}

function funding({ direct = 0, indirect = 0, traced = 0, known = traced, via = addr(50) } = {}) {
  return {
    direct: Array.from({ length: direct }, (_, i) => ({ rater: addr(200 + i), isDust: false })),
    indirect: Array.from({ length: indirect }, (_, i) => ({ rater: addr(300 + i), via })),
    tracedRaters: traced,
    ratersWithKnownFunder: known,
  };
}

// A payment record in the shape tracePayments returns. `before` and `after`
// are the raters that paid the agent's owner, timed against their own first
// rating of it.
function payments({ before = [], after = [], traced = 0 } = {}) {
  const row = (rater) => ({ rater, isDust: false, valueRaw: '1000000000000000000', paidAt: 1 });
  return {
    paidBefore: before.map(row),
    paidAfter: after.map(row),
    paidUnknownTime: [],
    tracedRaters: traced,
  };
}

const base = {
  owner: OWNER,
  reviewers: [addr(100), addr(101), addr(102)],
  feedbackCount: 10,
  funding: funding({ traced: 3 }),
  raterTypes: raterTypes({ sampled: 3 }),
  selfRated: 0,
};

test('an agent nobody has rated reports no evidence, not a clean result', () => {
  const v = buildVerdict({ ...base, feedbackCount: 0, reviewers: [], funding: funding({}) });
  assert.equal(v.label, 'NO EVIDENCE');
  assert.match(v.summary, /nothing here to trust or distrust/i);
});

test('owner funding of every traced rater is reported as owner funded', () => {
  const v = buildVerdict({ ...base, funding: funding({ direct: 3, traced: 3 }) });
  assert.equal(v.label, 'OWNER FUNDED');
  assert.equal(v.tone, 'red');
  assert.match(v.summary, /100%/);
});

test('a minority share of owner funding is not coloured like a total one', () => {
  // A tool that paints 33% the same as 100% is one a reader stops believing.
  const v = buildVerdict({ ...base, funding: funding({ direct: 1, traced: 3 }) });
  assert.equal(v.label, 'OWNER FUNDED');
  assert.equal(v.tone, 'amber');
  assert.match(v.summary, /33%/);
});

test('funding routed through an intermediary still counts as owner funded', () => {
  // The whole point of the second hop: a farm that pays its raters from a
  // burner wallet looks independent to a direct owner-to-rater check.
  const v = buildVerdict({ ...base, funding: funding({ indirect: 2, traced: 3 }) });
  assert.equal(v.label, 'OWNER FUNDED');
  assert.ok(
    v.findings.some((f) => /intermediary wallet/i.test(f)),
    'the finding must say the link was indirect, or the reader cannot judge its strength',
  );
});

test('application contracts lead the verdict even when the owner funded them', () => {
  // This is the regression guard for the 153 to 158 mistake. Owner funding is
  // present and true, but calling this OWNER FUNDED would tell a reader that a
  // game reporting its own results is a reputation farm.
  const v = buildVerdict({
    ...base,
    funding: funding({ direct: 1, indirect: 1, traced: 5 }),
    raterTypes: raterTypes({ sampled: 5, contracts: 4, apps: 4 }),
  });
  assert.equal(v.label, 'APP GENERATED');
  assert.match(v.summary, /not by people forming opinions/i);
  assert.match(v.summary, /paying its gas rather than buying an opinion/i);
});

test('a single application rater among many people does not take over the verdict', () => {
  const v = buildVerdict({
    ...base,
    funding: funding({ direct: 4, traced: 5 }),
    raterTypes: raterTypes({ sampled: 5, contracts: 1, apps: 1 }),
  });
  assert.equal(v.label, 'OWNER FUNDED');
});

test('a self reviewing owner is named when no funding link outranks it', () => {
  const v = buildVerdict({ ...base, selfRated: 1, funding: funding({ traced: 3 }) });
  assert.equal(v.label, 'SELF REVIEWED');
});

test('a single rater is thin', () => {
  const v = buildVerdict({
    ...base,
    reviewers: [addr(100)],
    funding: funding({ traced: 1 }),
    raterTypes: raterTypes({ sampled: 1 }),
  });
  assert.equal(v.label, 'THIN');
});

test('no link found states how much of the rater set could be traced at all', () => {
  // Absence of evidence is reported as weaker than evidence, with the numbers
  // that let a reader see how weak.
  const v = buildVerdict({ ...base, funding: funding({ traced: 3, known: 1 }) });
  assert.equal(v.label, 'NO LINK FOUND');
  assert.match(v.summary, /1 of 3/);
  assert.match(v.summary, /weaker evidence than a link/i);
});

test('no verdict ever accuses anyone of fraud', () => {
  // The product claims provenance, never intent. This asserts across every
  // branch at once so a future edit to any single summary cannot quietly
  // reintroduce the claim that collapsed under checking.
  const cases = [
    { ...base, feedbackCount: 0, reviewers: [], funding: funding({}) },
    { ...base, funding: funding({ direct: 3, traced: 3 }) },
    { ...base, funding: funding({ indirect: 1, traced: 3 }) },
    { ...base, selfRated: 1 },
    { ...base, reviewers: [addr(100)], funding: funding({ traced: 1 }), raterTypes: raterTypes({ sampled: 1 }) },
    { ...base, raterTypes: raterTypes({ sampled: 3, contracts: 3, apps: 3 }) },
    {
      ...base,
      funding: funding({ direct: 3, traced: 3 }),
      payments: payments({ after: [addr(200), addr(201), addr(202)], traced: 3 }),
    },
    { ...base, payments: payments({ before: [addr(100)], traced: 3 }) },
    { ...base, payments: payments({ after: [addr(100)], traced: 3 }) },
    base,
  ];
  // The words themselves are allowed inside an explicit disclaimer, and one
  // verdict deliberately says "that is not an accusation of fraud". Removing
  // the disclaimers first is what makes this assertion about the claim being
  // made rather than about vocabulary.
  const disclaimers = [
    /that is not an accusation of fraud,?/gi,
    /it is not a warning,?/gi,
    /is not a judgement of anyone's intent,?/gi,
  ];
  const banned = /\b(fraud|fraudulent|scam|scammer|fake|cheat|cheating|sybil|farm|farmed)\b/i;
  for (const input of cases) {
    const v = buildVerdict(input);
    let text = [v.label, v.summary, ...v.findings].join(' ');
    for (const d of disclaimers) text = text.replace(d, '');
    assert.ok(
      !banned.test(text),
      `verdict ${v.label} makes a claim the product must not make: ${banned.exec(text)?.[0]}`,
    );
  }
});


test('money that leaves the owner and comes back is named as a round trip', () => {
  // The live case this exists for: on agent 182 the owner sends a wallet 11
  // MON, the wallet rates the agent, and about 10.93 MON goes straight back to
  // the owner. Verified on chain 2026-09-23, transactions
  // 0x2c7cebc273da93a5a66a41986ab36a2b6fe2ca96a57d928c58adb8600ced64d6 out and
  // 0x62fad4d296f9d510a2b38ea8c09a3cdefc5bc57f39cb829fbfd674e1b01c9461 back.
  const funded = funding({ direct: 3, traced: 3 });
  const paid = funded.direct.map((d) => d.rater);
  const v = buildVerdict({ ...base, funding: funded, payments: payments({ after: paid, traced: 3 }) });
  assert.equal(v.label, 'ROUND TRIP');
  assert.match(v.summary, /100%/);
  assert.ok(
    v.findings.some((f) => /round trip/i.test(f)),
    'a reader must be able to see the movement, not only the label',
  );
});

test('a round trip never outranks an application recording its own outcomes', () => {
  // Same guard as the 153 to 158 case, extended to the payment signal. A
  // contract returning its leftover gas balance is ordinary plumbing, and
  // reading that as a round trip would repeat this project's one real mistake.
  const funded = funding({ direct: 4, traced: 4 });
  const paid = funded.direct.map((d) => d.rater);
  const v = buildVerdict({
    ...base,
    funding: funded,
    raterTypes: raterTypes({ sampled: 4, contracts: 4, apps: 4 }),
    payments: payments({ after: paid, traced: 4 }),
  });
  assert.equal(v.label, 'APP GENERATED');
});

test('a payment made after the rating is not reported as a round trip on its own', () => {
  // Paying the owner proves nothing unless it is known whether the owner had
  // paid first. Without an owner funding link this stays a plain observation.
  const v = buildVerdict({
    ...base,
    funding: funding({ traced: 3, known: 1 }),
    payments: payments({ after: [addr(100)], traced: 3 }),
  });
  assert.equal(v.label, 'NO LINK FOUND');
  assert.ok(v.findings.some((f) => /only after rating it/i.test(f)));
});

test('a rater that paid before rating, and was never owner funded, is called out', () => {
  // The rarest thing on this chain: 1 such relationship exists in total. Three
  // were reported until 2026-10-06, but two of them paid the owner wallet
  // before the agent was registered (see the next test).
  const v = buildVerdict({
    ...base,
    funding: funding({ traced: 3, known: 3 }),
    payments: payments({ before: [addr(100)], traced: 3 }),
  });
  assert.ok(
    v.findings.some((f) => /BEFORE rating it/.test(f)),
    'the one genuinely grounding signal must be visible when it fires',
  );
});

test('a caller that supplies no payment record gets no payment claim', () => {
  // The API, the MCP server and the page all pass payments now, but an older
  // caller must not have silence turned into a finding in either direction.
  const v = buildVerdict({ ...base, funding: funding({ direct: 3, traced: 3 }) });
  assert.equal(v.label, 'OWNER FUNDED');
  assert.ok(!v.findings.some((f) => /round trip|paid this agent/i.test(f)));
});

test("money sent to the owner's wallet before the agent existed is not a customer payment", () => {
  const p = payments({ traced: 3 });
  p.paidBeforeAgentExisted = [{ rater: addr(100), isDust: false, valueRaw: '100000000000000000', paidAt: 1 }];
  const v = buildVerdict({ ...base, funding: funding({ traced: 3, known: 3 }), payments: p });
  assert.ok(!v.findings.some((f) => /BEFORE rating it/.test(f)));
  assert.ok(v.findings.some((f) => /before this agent was registered/.test(f)));
});
