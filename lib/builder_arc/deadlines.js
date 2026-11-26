// ============================================================================
// lib/builder_arc/deadlines.js  (Ed 2026-11-25)
// ----------------------------------------------------------------------------
// Two independent clocks on every builder lot submission. Both are computed,
// never stored, so they cannot drift from the facts they come from.
//
// 1. BEDROCK STANDARD (internal service level, Ed 2026-11-25):
//    final decision approved AND communicated within 2 business days of
//    receiving a COMPLETE application.
//    - received_at = actual receipt (builder_applications.submitted_at: the
//      portal timestamp, or the email's receipt time for an emailed packet),
//      never the date it was entered or reviewed.
//    - complete_at = received_at when the submission was complete; when the
//      builder had to send more, the time the last required item arrived (the
//      latest packet upload). Internal delays, extraction errors and pending
//      approvals never move it: a review that wrongly called the packet
//      incomplete, once corrected, dates completeness back to receipt.
//    - incomplete: Annie must notify the builder of everything outstanding
//      within 1 business day of receipt (info_request_due_at).
//    - business days exclude weekends and Bedrock's holidays
//      (lib/builder_arc/holidays.json).
//    - met when the decision letter is emailed (communicated) by due_at.
//
// 2. GOVERNING DOCUMENTS (the association's deadline): standards
//    .legal_review_days calendar days from receipt (Still Creek Ranch: 30;
//    not approved by then = deemed disapproved). Runs from receipt whether or
//    not the application is complete; nothing pauses it unless the documents
//    say so. Not modeled: the fee-tolling clause (no Board-set fee on file).
// ============================================================================
const HOLIDAYS = new Set(require('./holidays.json').dates || []);
const DAY = 86400000;
const STANDARD_DAYS = () => Number(process.env.BUILDER_ARC_DECISION_BUSINESS_DAYS || 2);

// Central calendar date for an instant.
function centralDate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function isBusinessDay(d) {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(d);
  return wd !== 'Sat' && wd !== 'Sun' && !HOLIDAYS.has(centralDate(d));
}
// n business days after `fromIso`, same time of day. A receipt on a weekend or
// holiday starts counting from the next business day.
function addBusinessDays(fromIso, n) {
  const d = new Date(fromIso);
  let k = 0;
  while (k < n) { d.setTime(d.getTime() + DAY); if (isBusinessDay(d)) k += 1; }
  return d.toISOString();
}

const later = (a, b) => (!a ? b : !b ? a : (new Date(a) > new Date(b) ? a : b));

/**
 * @param {object} app        { submitted_at, status, decided_at }
 * @param {object} community  (unused by the standard; kept for callers)
 * @param {object} standards  { legal_review_days }
 * @param {Date}   now
 * @param {object} facts {
 *   recommended_action  Annie's latest recommendation (null = not reviewed)
 *   last_info_at        latest packet / information received from the builder
 *   info_requested_at   when the builder was told what is outstanding (null = not yet)
 *   communicated_at     when the decision letter was emailed (null = not yet)
 * }
 */
function computeDeadlines(app, community = {}, standards = {}, now = new Date(), facts = {}) {
  const received_at = app && app.submitted_at;
  if (!received_at) return null;
  const t = now.getTime();
  const days = STANDARD_DAYS();
  const rec = facts.recommended_action || null;
  const incomplete = rec === 'request_more_info';

  // ---- Bedrock standard
  const standard = { business_days: days, received_at, complete_at: null, due_at: null, risk_at: null, info_request_due_at: null, info_requested_at: facts.info_requested_at || null, communicated_at: facts.communicated_at || null, state: 'not_reviewed' };
  if (incomplete) {
    standard.info_request_due_at = addBusinessDays(received_at, 1);
    standard.state = facts.info_requested_at ? 'waiting_on_builder'
      : (t >= new Date(standard.info_request_due_at).getTime() ? 'info_request_overdue' : 'info_request_due');
  } else if (rec || facts.communicated_at || (app && app.decided_at)) {
    standard.complete_at = later(received_at, facts.last_info_at || null);
    standard.due_at = addBusinessDays(standard.complete_at, days);
    standard.risk_at = addBusinessDays(standard.complete_at, Math.max(days - 1, 0));
    if (facts.communicated_at) standard.state = new Date(facts.communicated_at) <= new Date(standard.due_at) ? 'met' : 'met_late';
    else if (t >= new Date(standard.due_at).getTime()) standard.state = 'missed';
    else if (t >= new Date(standard.risk_at).getTime()) standard.state = 'at_risk';
    else standard.state = 'on_track';
  }

  // ---- Governing documents (independent)
  const legalDays = standards && Number(standards.legal_review_days);
  const governing = { days: null, limit_at: null, days_to_limit: null, state: 'none' };
  if (Number.isFinite(legalDays) && legalDays > 0) {
    governing.days = legalDays;
    governing.limit_at = new Date(new Date(received_at).getTime() + legalDays * DAY).toISOString();
    governing.days_to_limit = Math.ceil((new Date(governing.limit_at).getTime() - t) / DAY);
    const decided = !!(app && app.decided_at);
    governing.state = decided ? 'decided' : t >= new Date(governing.limit_at).getTime() ? 'passed' : governing.days_to_limit <= 7 ? 'near' : 'open';
  }

  // Escalation levels (each escalated once). Amanda oversees any of these.
  const levels = [];
  if (['info_request_overdue'].includes(standard.state)) levels.push('standard:info_request_overdue');
  if (standard.state === 'at_risk') levels.push('standard:at_risk');
  if (standard.state === 'missed') levels.push('standard:missed');
  if (governing.state === 'near') levels.push('governing:near');
  if (governing.state === 'passed') levels.push('governing:passed');

  return {
    standard, governing, levels,
    // compatibility fields used by the screen and work items
    target_due_at: standard.due_at || standard.info_request_due_at,
    limit_at: governing.limit_at, limit_days: governing.days, days_to_limit: governing.days_to_limit,
    state: levels.includes('governing:passed') ? 'limit_passed' : levels.includes('governing:near') ? 'limit_near'
      : (levels.includes('standard:missed') || levels.includes('standard:info_request_overdue')) ? 'standard_missed'
      : levels.includes('standard:at_risk') ? 'at_risk' : 'on_track',
    age_days: Math.floor((t - new Date(received_at).getTime()) / DAY),
  };
}

const STATE_LABEL = {
  on_track: 'On track',
  at_risk: 'At risk of missing the 2-business-day standard',
  standard_missed: 'Past the 2-business-day standard',
  limit_near: 'Association review period ends within 7 days',
  limit_passed: 'Association review period passed (deemed disapproved if not approved)',
};
const STANDARD_LABEL = {
  not_reviewed: 'Not reviewed yet',
  info_request_due: 'Info request due to builder',
  info_request_overdue: 'Info request to builder overdue',
  waiting_on_builder: 'Waiting on builder',
  on_track: 'On track',
  at_risk: 'At risk',
  missed: 'Missed',
  met: 'Met',
  met_late: 'Met late',
};

module.exports = { computeDeadlines, addBusinessDays, isBusinessDay, STATE_LABEL, STANDARD_LABEL, STANDARD_DAYS };
