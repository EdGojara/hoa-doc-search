// ============================================================================
// lib/builder_arc/deadlines.js  (Ed 2026-11-25)
// ----------------------------------------------------------------------------
// Two clocks on every builder lot submission, both computed (never stored, so
// they cannot drift from submitted_at):
//
//   target   Bedrock's own turnaround: communities.builder_arc_sla_business_days
//            (fast-track: builder_arc_fast_track_business_days) business days.
//   limit    the governing documents' review period (Still Creek Ranch:
//            Declaration Art. X, 30 days; not approved in time = deemed
//            DISAPPROVED). From standards.legal_review_days; null when the
//            community's standards don't state one.
//
// The fee-tolled clock (the period does not run until a Board-set fee is paid)
// is deliberately NOT modeled: no Board resolution setting a fee is on file,
// and Ed's rule is no unverified fee requirements.
// ============================================================================
const DAY = 86400000;

function addBusinessDays(fromIso, n) {
  const d = new Date(fromIso);
  let k = 0;
  while (k < n) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) k += 1; }
  return d.toISOString();
}

/**
 * @param {object} app        { submitted_at, fast_track }
 * @param {object} community  { builder_arc_sla_business_days, builder_arc_fast_track_business_days }
 * @param {object} standards  { legal_review_days }
 * @param {Date}   now
 */
function computeDeadlines(app, community = {}, standards = {}, now = new Date()) {
  const submitted = app && app.submitted_at;
  if (!submitted) return null;
  const sla = Number(app.fast_track ? (community.builder_arc_fast_track_business_days ?? 2) : (community.builder_arc_sla_business_days ?? 5));
  const target_due_at = addBusinessDays(submitted, Number.isFinite(sla) && sla > 0 ? sla : 5);
  const legalDays = standards && Number(standards.legal_review_days);
  const limit_at = Number.isFinite(legalDays) && legalDays > 0 ? new Date(new Date(submitted).getTime() + legalDays * DAY).toISOString() : null;
  const t = now.getTime();
  const days_to_limit = limit_at ? Math.ceil((new Date(limit_at).getTime() - t) / DAY) : null;
  let state = 'on_track';
  if (limit_at && t >= new Date(limit_at).getTime()) state = 'limit_passed';
  else if (days_to_limit != null && days_to_limit <= 7) state = 'limit_near';
  else if (t >= new Date(target_due_at).getTime()) state = 'target_missed';
  return { target_business_days: sla, target_due_at, limit_days: limit_at ? legalDays : null, limit_at, days_to_limit, state, age_days: Math.floor((t - new Date(submitted).getTime()) / DAY) };
}

const STATE_LABEL = {
  on_track: 'On track',
  target_missed: 'Past Bedrock turnaround target',
  limit_near: 'Review period ends within 7 days',
  limit_passed: 'Review period passed (deemed disapproved if not approved)',
};

module.exports = { computeDeadlines, addBusinessDays, STATE_LABEL };
