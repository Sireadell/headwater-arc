// Phase 4 of BUILD_PLAN.md: the piece meant to separate this from a
// one-off report. Every claim Headwater makes gets logged here, and
// checked against what actually happens later where that's possible.
// Where nothing exists yet to check a claim against, the record says so
// outright, an explicit UNVALIDATED state with a reason, rather than
// staying silent about it or letting a flag imply more certainty than it
// has.
//
// Stored as a local JSON file for now. A real database is not needed
// yet, this is meant to accumulate real predictions over the build, not
// serve concurrent writers.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '..', 'data', 'predictions.json');

async function loadAll() {
  try {
    const raw = await readFile(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function saveAll(predictions) {
  await mkdir(path.dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(predictions, null, 2) + '\n', 'utf8');
}

/**
 * @param {{ signalCode: string, claim: string, subject: string, evidence: object }} entry
 * @returns {Promise<object>} the stored prediction, deduplicated by signalCode+subject
 */
export async function recordPrediction({ signalCode, claim, subject, evidence }) {
  const predictions = await loadAll();
  const id = `${signalCode}:${subject}`;
  const existing = predictions.find((p) => p.id === id);
  if (existing) return existing; // don't re-log the same claim on every run

  const prediction = {
    id,
    signalCode,
    claim,
    subject,
    evidence,
    madeAt: new Date().toISOString(),
    status: 'UNVALIDATED',
    reason: 'no_outside_check_available_yet',
    validatedAt: null,
    validationNote: null,
  };
  predictions.push(prediction);
  await saveAll(predictions);
  return prediction;
}

/**
 * Marks a prediction validated (or refuted) against a real outside
 * event. Nothing calls this yet, since no outside check exists to run
 * against; it exists so that when one does (an agent gets delisted, a
 * reviewer gets flagged elsewhere, a user confirms a finding), the
 * scoreboard has somewhere real to record it rather than needing new
 * plumbing built under deadline pressure.
 *
 * @param {string} id
 * @param {{ outcome: 'confirmed' | 'refuted', note: string }} result
 */
export async function recordValidation(id, { outcome, note }) {
  const predictions = await loadAll();
  const prediction = predictions.find((p) => p.id === id);
  if (!prediction) throw new Error(`No prediction with id ${id}`);
  prediction.status = outcome === 'confirmed' ? 'CONFIRMED' : 'REFUTED';
  prediction.validatedAt = new Date().toISOString();
  prediction.validationNote = note;
  await saveAll(predictions);
  return prediction;
}

/**
 * @returns {Promise<{ total: number, unvalidated: number, confirmed: number, refuted: number, predictions: object[] }>}
 */
export async function getScoreboard() {
  const predictions = await loadAll();
  return {
    total: predictions.length,
    unvalidated: predictions.filter((p) => p.status === 'UNVALIDATED').length,
    confirmed: predictions.filter((p) => p.status === 'CONFIRMED').length,
    refuted: predictions.filter((p) => p.status === 'REFUTED').length,
    predictions,
  };
}
