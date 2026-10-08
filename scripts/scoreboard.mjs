// Phase 4 deliverable: a live view of Headwater's own track record.
// Every claim this product has made, whether it turned out right, and
// an honest UNVALIDATED label with a reason on anything nobody has
// checked yet, rather than silence about it.
//
//   node scripts/scoreboard.mjs

import { getScoreboard } from '../src/scoreboard.js';

const board = await getScoreboard();

console.log('Headwater scoreboard\n' + '='.repeat(70));
console.log(`Total claims logged: ${board.total}`);
console.log(`  Confirmed:   ${board.confirmed}`);
console.log(`  Refuted:     ${board.refuted}`);
console.log(`  Unvalidated: ${board.unvalidated}\n`);

if (board.total === 0) {
  console.log('Nothing logged yet. Run node scripts/demo.mjs first, it logs any real finding it makes.');
} else {
  for (const p of board.predictions) {
    console.log(`[${p.status}] ${p.id}`);
    console.log(`  ${p.claim}`);
    console.log(`  Made: ${p.madeAt}`);
    if (p.status === 'UNVALIDATED') {
      console.log(`  Why still unvalidated: ${p.reason}`);
    } else {
      console.log(`  Validated: ${p.validatedAt} — ${p.validationNote}`);
    }
    console.log('');
  }
}

console.log('='.repeat(70));
console.log(`
Honest read: this product is new, so most or all claims here are
UNVALIDATED, not because they're weak, but because nothing external
exists yet to check them against. That state is shown on purpose instead
of hidden. As real outcomes become checkable (an agent gets delisted, a
reviewer gets flagged elsewhere, a human confirms a finding), those
claims move to CONFIRMED or REFUTED here, not silently dropped.
`);
