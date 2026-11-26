// ============================================================================
// lib/acc/service_clock.js  (Ed 2026-11-26)
// ----------------------------------------------------------------------------
// TWO CLOCKS on every resident architectural application, computed (never
// stored), so neither can be silently reset by a status change, an information
// request or a hand-off:
//
// 1. BEDROCK SERVICE STANDARD (internal; Ed 2026-11-26):
//      acknowledgment                       30 minutes from ingestion
//      routine review + response            60 minutes from ingestion
//      missing-information request          1 business day from ingestion
//      complex: initial review              4 business hours from ingestion
//      complex: recommendation              2 business days from ingestion
//      escalation to the decision owner     1 business day from the review
//      follow-up on an outstanding decision every 2 business days after escalation
//    New documents after a request start a fresh response clock for THAT
//    delivery (from when they arrived); the original clocks keep their history.
//    Complex never suspends accountability: every complex case names why it is
//    complex, what is outstanding, who owns the next action and when it is due.
//
// 2. GOVERNING DOCUMENTS: the association's review period from receipt
//    (lib/acc/review_periods), with its stated consequence. Nothing pauses it
//    unless the documents say so.
//
// Business days exclude weekends and Bedrock holidays (lib/builder_arc/
// holidays.json); business hours are 8 AM-5 PM Central. Windows are
// configurable: ACC_ACK_WINDOW_MINUTES (30), ACC_ROUTINE_RESPONSE_MINUTES (60).
//
//   serviceClock(row, { authority, now, facts }) -> {
//     complex, complexity_reasons[], stages[{ key, label, due_at, met_at, state }],
//     next: { key, label, owner, due_at, state } | null, levels[] (escalation keys) }
// ============================================================================
const DA = require('./decision_authority');
const { isBusinessDay } = require('../builder_arc/deadlines');

const MIN = 60000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
const ackWindowMinutes = () => Math.max(1, Number(process.env.ACC_ACK_WINDOW_MINUTES || 30));
const routineMinutes = () => Math.max(1, Number(process.env.ACC_ROUTINE_RESPONSE_MINUTES || 60));
const OPEN_HOUR = 8; const CLOSE_HOUR = 17;

function centralHour(d) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(d);
  const g = (t) => Number((p.find((x) => x.type === t) || {}).value || 0);
  return g('hour') + g('minute') / 60;
}
// Next instant at or after `d` that is inside business hours.
function nextBusinessMoment(d) {
  const x = new Date(d);
  for (let i = 0; i < 24 * 14; i++) {
    const h = centralHour(x);
    if (isBusinessDay(x) && h >= OPEN_HOUR && h < CLOSE_HOUR) return x;
    // advance to the top of the next hour (keeps it simple and DST-safe)
    x.setTime(x.getTime() + (60 - x.getUTCMinutes()) * MIN - x.getUTCSeconds() * 1000 - x.getUTCMilliseconds());
  }
  return x;
}
function addBusinessHours(fromIso, hours) {
  let x = nextBusinessMoment(new Date(fromIso));
  let left = hours * HOUR;
  for (let guard = 0; left > 0 && guard < 1000; guard++) {
    const untilClose = (CLOSE_HOUR - centralHour(x)) * HOUR;
    if (left <= untilClose) return new Date(x.getTime() + left).toISOString();
    left -= untilClose;
    x = nextBusinessMoment(new Date(x.getTime() + untilClose + MIN));
  }
  return x.toISOString();
}
function addBusinessDays(fromIso, n) {
  const d = new Date(fromIso); let k = 0;
  while (k < n) { d.setTime(d.getTime() + DAY); if (isBusinessDay(d)) k += 1; }
  return d.toISOString();
}
const plusMinutes = (iso, m) => new Date(Date.parse(iso) + m * MIN).toISOString();
const t = (x) => (x ? Date.parse(x) : NaN);
const state = (due, met, now) => (met ? (t(met) <= t(due) ? 'met' : 'met_late') : (now.getTime() > t(due) ? 'missed' : (t(due) - now.getTime() < 0.25 * Math.max(t(due) - 0, 1) && false ? 'at_risk' : 'open')));

// Why a case is complex (empty = routine).
function complexityReasons(row, a) {
  const r = [];
  if (a.route === 'owner_review_required') r.push(`Ed's approval required (${(a.owner_triggers || []).map((x) => x.replace(/_/g, ' ')).join(', ') || 'owner review'})`);
  if (a.route === 'committee_or_board_required') r.push(`${row.acc_delegation && row.acc_delegation.reserved_to === 'developer' ? "the developer's" : 'the Architectural Committee or Board'} decision required (${(a.body_triggers || []).map((x) => x.replace(/_/g, ' ')).join(', ') || a.route_detail || 'no delegated authority'})`);
  if (a.route === 'annie_decides' && a.annie && !a.annie.ok && a.annie.error) r.push(a.annie.error);
  return r;
}

function serviceClock(row = {}, { authority = null, now = new Date(), facts = {} } = {}) {
  const a = authority || DA.authorityFor(row);
  const ingested = row.created_at || row.received_at;
  const received = row.received_at || row.created_at;
  const reviewAt = DA.reviewAt(row);
  const reasons = complexityReasons(row, a);
  const complex = reasons.length > 0;
  const firstContact = row.acknowledged_at || null;
  const infoRequestedAt = row.decision_type === 'request_more_info' ? (facts.info_requested_at || row.updated_at || null) : (facts.info_requested_at || null);
  const decidedAt = row.status === 'decided' ? (row.decided_at || null) : null;
  const escalatedAt = facts.escalated_at || null;
  const stages = [];
  const push = (key, label, due_at, met_at, owner) => stages.push({ key, label, due_at, met_at: met_at || null, owner, state: state(due_at, met_at, now) });

  push('acknowledgment', 'Acknowledge receipt', plusMinutes(ingested, ackWindowMinutes()), firstContact, 'Annie');
  const incomplete = a.route === 'request_more_info';
  if (!complex) {
    if (incomplete) push('info_request', 'Request the missing information', plusMinutes(ingested, routineMinutes()), infoRequestedAt, 'Annie');
    else push('response', 'Review and respond', plusMinutes(ingested, routineMinutes()), decidedAt || (row.decision_type && firstContact ? firstContact : null), 'Annie');
  } else {
    push('initial_review', 'Initial review (complex)', addBusinessHours(ingested, 4), reviewAt, 'Annie');
    if (incomplete) push('info_request', 'Request the missing information', addBusinessDays(ingested, 1), infoRequestedAt, 'Annie');
    push('recommendation', 'Recommendation (complex)', addBusinessDays(ingested, 2), reviewAt && DA.currentRecommendation && DA.currentRecommendation(row) ? reviewAt : null, 'Annie');
    if (!incomplete) {
      push('escalation', 'Escalate to the decision owner', addBusinessDays(reviewAt || ingested, 1), escalatedAt, 'Amanda');
      if (escalatedAt && !decidedAt) {
        // Follow up every 2 business days while the decision is outstanding.
        let due = addBusinessDays(escalatedAt, 2); let n = 1;
        while (t(due) < now.getTime() && n < 60) { due = addBusinessDays(due, 2); n += 1; }
        stages.push({ key: `decision_followup_${n}`, label: `Follow up on the outstanding decision (#${n})`, due_at: due, met_at: null, owner: 'Amanda', state: 'open', followup: n });
      }
    }
  }
  // Documents arrived after a request: a fresh response clock for that delivery.
  if (row.last_document_added_at && infoRequestedAt && t(row.last_document_added_at) > t(infoRequestedAt) && !decidedAt) {
    const resp = complex ? addBusinessDays(row.last_document_added_at, 1) : plusMinutes(row.last_document_added_at, routineMinutes());
    const answered = row.current_review_at && t(row.current_review_at) >= t(row.last_document_added_at) && t(row.updated_at) >= t(row.current_review_at) ? row.updated_at : null;
    push('response_to_new_documents', 'Review the new documents and respond', resp, answered, 'Annie');
  }
  const open = stages.filter((s) => !s.met_at);
  const next = open.sort((x, y) => t(x.due_at) - t(y.due_at))[0] || null;
  const levels = stages.filter((s) => s.state === 'missed' || s.state === 'met_late').filter((s) => !s.met_at).map((s) => `service:${s.key}_missed`);
  return { complex, complexity_reasons: reasons, received_at: received, ingested_at: ingested, stages, next, levels };
}

module.exports = { serviceClock, addBusinessHours, addBusinessDays, complexityReasons, ackWindowMinutes, routineMinutes };
