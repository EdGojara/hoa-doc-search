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
//   eligible_209         — Courtesy 2 → flag eligible for certified §209 (staff
//                          sends it when the cure time is earned). No auto-letter.
//   continuation         — certified §209 / fine in progress, or a same-day
//                          re-scan (the same-day guard against double-advancing).
// ============================================================================

/**
 * @param {object} supabase  service-role client
 * @param {object} violation  the OPEN violation row: { id, current_stage, current_stage_started_at }
 * @param {object} [opts]
 * @param {Array}  [opts.courtesy1Letters]  pre-fetched letter_courtesy_1 rows [{status, mailed_at}] for
 *   THIS violation. When provided, no per-violation query runs (batch callers like the preview pass
 *   this so they don't fire one query per case). When omitted, it queries — same result either way.
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

  if (stage === 'courtesy_1') {
    let c1 = opts.courtesy1Letters;
    if (!c1) {
      const { data } = await supabase
        .from('interactions')
        .select('status, mailed_at')
        .eq('violation_id', violation.id)
        .eq('type', 'letter_courtesy_1');
      c1 = data || [];
    }
    const live = c1.filter((l) => l.status !== 'rejected' && l.status !== 'voided');
    const mailed = live.some((l) => l.mailed_at || l.status === 'sent');
    if (!live.length) return { outcome: startedToday ? 'continuation' : 'recover_courtesy_1', started_today: startedToday };
    if (!mailed) return { outcome: 'awaiting_first_mail', started_today: startedToday };
    if (startedToday) return { outcome: 'continuation', started_today: startedToday };
    return { outcome: 'advance_courtesy_2', started_today: startedToday };
  }
  if (stage === 'courtesy_2') return { outcome: 'eligible_209', started_today: startedToday };
  return { outcome: 'continuation', started_today: startedToday };
}

module.exports = { decideReobservationOutcome };
