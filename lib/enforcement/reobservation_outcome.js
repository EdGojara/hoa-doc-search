// ============================================================================
// lib/enforcement/reobservation_outcome.js
// ----------------------------------------------------------------------------
// The SINGLE source of "what should a re-observation of an already-OPEN case
// do." Used by BOTH the confirm endpoint (to execute the action) and the
// re-inspection preview (to count what will happen) — so the preview can never
// disagree with the action a confirm actually takes (the preview-diverges scar).
//
// Ed's §209 policy (2026-09-01): courtesy notices keep issuing on re-inspection
// regardless of the cure window; only the certified §209 waits on the cure clock
// and staff. See project_enforcement_escalation_model.
//
// Outcomes (given the furthest-advanced OPEN case at the property+category):
//   advance_courtesy_2   — Courtesy 1 whose first notice was MAILED → advance to
//                          Courtesy 2 and draft the second notice.
//   recover_courtesy_1   — Courtesy 1 whose first notice was never drafted (a
//                          lost draft) and NOT opened today → draft it now.
//   awaiting_first_mail  — Courtesy 1 drafted but not yet mailed → wait; you
//                          cannot issue a 2nd notice before the 1st goes out.
//   awaiting_second_mail — Courtesy 2 whose second notice was never MAILED (or is
//                          missing) → held, with the reason; never flagged for §209.
//   eligible_209         — Courtesy 2 with its second notice MAILED → flag eligible for certified §209 (staff
//                          sends it when the cure time is earned). No auto-letter.
//   continuation         — certified §209 / fine in progress, or a same-day
//                          re-scan (the same-day guard against double-advancing).
// ============================================================================

/**
 * @param {object} supabase  service-role client
 * @param {object} violation  the OPEN violation row: { id, current_stage, current_stage_started_at }
 * @param {object} [opts]
 * @param {Array}  [opts.letters]  pre-fetched letter rows [{type, subject, status, mailed_at}] for
 *   THIS violation. When provided, no per-violation query runs (batch callers like the preview pass
 *   this so they don't fire one query per case). When omitted, it queries — same result either way.
 *   (opts.courtesy1Letters is the older name for the same thing.)
 * @param {number} [opts.nowMs]  injectable clock (tests)
 * @returns {Promise<{outcome: string, started_today: boolean}>}
 */
async function decideReobservationOutcome(supabase, violation, opts = {}) {
  const nowMs = opts.nowMs || Date.now();
  const stage = violation.current_stage;
  const tz = { timeZone: 'America/Chicago' };
  const today = new Date(nowMs).toLocaleDateString('en-CA', tz);
  const startedToday = violation.current_stage_started_at
    ? new Date(violation.current_stage_started_at).toLocaleDateString('en-CA', tz) === today
    : false;

  // One step per inspection (Ed 2026-10-23): a second photo of the same case on the
  // same inspection, even one that runs past midnight, never advances it again.
  if (opts.sameInspection && (stage === 'courtesy_1' || stage === 'courtesy_2')) {
    return { outcome: 'continuation', reason: 'same_inspection', started_today: startedToday };
  }
  // Letters on the case, recognised by their ACTUAL stage (a Courtesy 1 typed
  // letter_209 still counts), and "mailed" means a CONFIRMED mailing, not a letter
  // that is only queued or printed (Ed 2026-10-23).
  const { letterStageOf } = require('./letter_stage');
  let letters = opts.letters || opts.courtesy1Letters;
  if (!letters && (stage === 'courtesy_1' || stage === 'courtesy_2')) {
    const { data } = await supabase
      .from('interactions')
      .select('type, subject, status, mailed_at')
      .eq('violation_id', violation.id)
      .like('type', 'letter%');
    letters = data || [];
  }
  const liveOf = (st) => (letters || []).filter((l) => !['rejected', 'voided', 'failed', 'cancelled', 'superseded'].includes(String(l.status || ''))
    && (l.subject || l.type !== undefined ? (letterStageOf(l) === st) : st === 'courtesy_1'));
  if (stage === 'courtesy_1') {
    const live = liveOf('courtesy_1');
    const mailed = live.some((l) => l.mailed_at);
    // `reason` explains a "held" (continuation / awaiting_first_mail) outcome so
    // the UI can say WHY, not just "held" (Ed 2026-09-15).
    if (!live.length) return startedToday
      ? { outcome: 'continuation', reason: 'opened_today', started_today: startedToday }
      : { outcome: 'recover_courtesy_1', reason: null, started_today: startedToday };
    if (!mailed) return { outcome: 'awaiting_first_mail', reason: 'first_notice_not_mailed', started_today: startedToday };
    if (startedToday) return { outcome: 'continuation', reason: 'opened_today', started_today: startedToday };
    return { outcome: 'advance_courtesy_2', reason: null, started_today: startedToday };
  }
  if (stage === 'courtesy_2') {
    // §209 eligibility rests on the second notice actually having been mailed,
    // not on the stage label (Ed 2026-10-23). Without it the case is held, with
    // the reason, and nothing is flagged.
    const c2 = liveOf('courtesy_2');
    if (!c2.some((l) => l.mailed_at)) return { outcome: 'awaiting_second_mail', reason: c2.length ? 'second_notice_not_mailed' : 'second_notice_missing', started_today: startedToday };
    return { outcome: 'eligible_209', reason: null, started_today: startedToday };
  }
  // Already at certified §209 or fine — re-observing keeps the case moving but
  // never issues a fresh courtesy notice (that would break the §209 chain).
  return {
    outcome: 'continuation',
    reason: stage === 'fine_assessed' ? 'at_fine' : (stage === 'certified_209' ? 'already_certified' : 'in_progress'),
    started_today: startedToday,
  };
}

// True when this case was opened from, or already continued by, an observation of
// the SAME inspection. A failed lookup answers true, so a lookup error never
// produces an extra advance.
async function seenEarlierInThisInspection(supabase, { violationId, openedFromObservationId, inspectionId, excludeObservationId }) {
  if (!inspectionId || !violationId) return false;
  try {
    if (openedFromObservationId) {
      const { data: o, error } = await supabase.from('property_observations').select('inspection_id').eq('id', openedFromObservationId).maybeSingle();
      if (error) return true;
      if (o && o.inspection_id === inspectionId) return true;
    }
    let q = supabase.from('violation_continuations').select('id').eq('violation_id', violationId).eq('inspection_id', inspectionId);
    if (excludeObservationId) q = q.neq('observation_id', excludeObservationId);
    const { data: rows, error: cErr } = await q.limit(1);
    if (cErr) return true;
    return (rows || []).length > 0;
  } catch (_) {
    return true;
  }
}

module.exports = { decideReobservationOutcome, seenEarlierInThisInspection };
