// lib/enforcement/reduce_plan.js  (Ed 2026-10-23)
// ----------------------------------------------------------------------------
// What a stage reduction does, decided without touching the database, so the
// rules are testable: the target stage, which unmailed higher-stage letters
// become held, and when the request must be refused.
//
//   - A reduction always has a reason and always goes DOWN the ladder.
//   - correction 'match_mailed_letter': the record shows a stage that was never
//     sent; the case takes the stage of the letter actually mailed and keeps the
//     cure clock that letter set (5115 Emory Mill / 5811 Acacia Rose: recorded
//     certified, only a first-class Courtesy 1 went out on 8/27).
//   - A printed higher-stage letter is a physical envelope: the person confirms
//     it is held before the reduction goes through (the two 10/23 Still Creek
//     certified letters).
// ----------------------------------------------------------------------------
const { letterStageOf, letterRankOf, letterMailState, STAGE_RANK } = require('./letter_stage');

const DEAD = new Set(['rejected', 'failed', 'cancelled', 'error', 'superseded']);
const CONVENTIONAL_PREV = { fine_assessed: 'certified_209', certified_209: 'courtesy_2', courtesy_2: 'courtesy_1' };

function planReduction({ violation, letters, body }) {
  const b = body || {};
  const note = String(b.note || '').trim();
  if (!note) return { status: 400, error: 'reason_required', detail: 'Say why the stage is being reduced; it goes on the audit trail.' };
  if (!violation) return { status: 404, error: 'violation_not_found' };
  if (violation.resolved_at || ['cured', 'closed', 'voided'].includes(violation.current_stage)) {
    return { status: 409, error: 'violation is resolved/closed; cannot reduce' };
  }
  const curRank = STAGE_RANK[violation.current_stage] || 0;
  const live = (letters || []).filter((l) => !DEAD.has(String(l.status || '')));

  const correction = b.correction === 'match_mailed_letter';
  let prevStage;
  let mailedLetter = null;
  if (correction) {
    mailedLetter = live.filter((l) => l.mailed_at).sort((x, y) => String(y.mailed_at).localeCompare(String(x.mailed_at)))[0] || null;
    if (!mailedLetter) return { status: 409, error: 'no_mailed_letter', detail: 'No letter on this case was confirmed mailed, so there is nothing to match.' };
    prevStage = letterStageOf(mailedLetter);
  } else {
    prevStage = b.override_stage || CONVENTIONAL_PREV[violation.current_stage];
  }
  if (!prevStage) return { status: 409, error: `cannot reduce a ${violation.current_stage} violation — already at the first stage` };
  if (!STAGE_RANK[prevStage] || STAGE_RANK[prevStage] >= curRank) {
    return { status: 400, error: 'not_a_reduction', detail: `${prevStage} is not a lower stage than ${violation.current_stage}.` };
  }

  const outranking = live.filter((l) => !l.mailed_at && letterRankOf(l) > STAGE_RANK[prevStage]);
  const printed = outranking.filter((l) => l.printed_at);
  if (printed.length && b.printed_letters_held !== true) {
    return {
      status: 409,
      error: 'printed_letter_hold_unconfirmed',
      detail: 'A printed letter for the higher stage has not been confirmed mailed. Confirm it is physically held and was not mailed before reducing.',
      printed_letters: printed.map((l) => ({ id: l.id, stage: letterStageOf(l), state: letterMailState(l).label })),
    };
  }
  return { ok: true, note, prevStage, correction, mailedLetter, outranking, printed };
}

module.exports = { planReduction };
