// ============================================================================
// lib/manager/subjects.js  (Issue #27 Phase 1) — deterministic preflight rules
// ----------------------------------------------------------------------------
// One evaluator per subject kind. Each takes the CURRENT source row (never the
// event payload) and returns what Amanda would do, as data:
//
//   action   'track'  -> an open Amanda-owned objective should exist (REVIEW/BLOCK)
//            'clear'  -> nothing for Amanda (routine, or the work is done);
//                        an open objective for this subject is resolved
//   outcome  wake outcome: execute_candidate | no_action | review | block | resolved
//
// Pure functions: no I/O, no model, no business action. In Phase 1 "EXECUTE"
// is a CLASSIFICATION only ("routine; the normal path continues"); nothing is
// executed. No thresholds are invented: priority comes from facts already on
// the row (a suspected duplicate, a meeting date), never from a guessed dollar
// cutoff.
// ============================================================================
const crypto = require('crypto');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
  : JSON.stringify(v === undefined ? null : v));
const money = (c) => (c == null ? '' : `$${(Number(c) / 100).toFixed(2)}`);

const MISSING_PIECE = {
  no_community: 'the community this bill belongs to',
  no_vendor: 'the vendor',
  vendor_ambiguous: 'which of the matching vendors it is',
  no_total: 'the bill total',
  no_date: 'the bill date',
};

// ---- AP invoice (ap_invoices row) ------------------------------------------
const AP_INVOICE_COLUMNS = 'id, community_id, vendor_id, vendor_invoice_number, total_cents, status, dedup_status, needs_review, classification_reason';
function apInvoice(row) {
  const refs = { table: 'ap_invoices', id: row.id, invoice_number: row.vendor_invoice_number || null };
  const base = { domain: 'ap', objective_type: 'ap', owner_kind: 'workflow', owner_key: 'ap.intake', community_id: row.community_id || null, subject_refs: refs };
  const basis = { status: row.status, needs_review: !!row.needs_review, dedup_status: row.dedup_status || null, reason: row.classification_reason || null };
  const label = `bill ${row.vendor_invoice_number || row.id}${row.total_cents != null ? ` (${money(row.total_cents)})` : ''}`;
  if (['paid', 'voided'].includes(row.status)) return { ...base, basis, action: 'clear', outcome: 'resolved', reason: `bill is ${row.status}` };
  if (row.status === 'on_hold' || row.dedup_status === 'suspected_duplicate') {
    return { ...base, basis, action: 'track', outcome: 'review', autonomy_class: 'REVIEW', priority: 'high',
      title: `Possible duplicate: ${label}`, next_action: 'A person confirms whether this bill is a duplicate before it can move.', reason: 'held as a suspected duplicate' };
  }
  if (row.status === 'disputed') {
    return { ...base, basis, action: 'track', outcome: 'review', autonomy_class: 'REVIEW', priority: 'normal',
      title: `Disputed: ${label}`, next_action: 'A person resolves the dispute with the vendor.', reason: 'bill is disputed' };
  }
  if (row.needs_review && row.status === 'awaiting_approval') {
    return { ...base, basis, action: 'track', outcome: 'review', autonomy_class: 'REVIEW', priority: 'normal',
      title: `Check coding: ${label}`, next_action: 'A person checks the coding / payee before approval.', reason: row.classification_reason || 'flagged for review at intake' };
  }
  // awaiting_approval and clean, approved, partially_paid: the normal path continues
  // (Ed still releases every payment). Classification only.
  return { ...base, basis, action: 'clear', outcome: 'execute_candidate', autonomy_class: 'EXECUTE', reason: 'routine: normal approval path continues' };
}

// ---- AP intake exception (ap_intake_exceptions row) ------------------------
const AP_EXCEPTION_COLUMNS = 'id, community_id, reason, status, vendor_name, invoice_number, total_cents, notes, suggested_vendor_id';
function apException(row) {
  const refs = { table: 'ap_intake_exceptions', id: row.id };
  const base = { domain: 'ap', objective_type: 'ap', owner_kind: 'workflow', owner_key: 'ap.intake', community_id: row.community_id || null, subject_refs: refs };
  const basis = { status: row.status, reason: row.reason, community_id: row.community_id || null, suggested_vendor_id: row.suggested_vendor_id || null };
  const label = `${row.vendor_name || 'unknown vendor'}${row.invoice_number ? ` #${row.invoice_number}` : ''}${row.total_cents != null ? ` (${money(row.total_cents)})` : ''}`;
  if (row.status !== 'pending') return { ...base, basis, action: 'clear', outcome: 'resolved', reason: `exception ${row.status}` };
  const piece = MISSING_PIECE[row.reason];
  if (piece) {
    return { ...base, basis, action: 'track', outcome: 'block', autonomy_class: 'BLOCK', priority: 'normal',
      title: `Bill waiting on ${piece}: ${label}`,
      blocked_reason: `Payables needs to supply ${piece} before this bill can load.`,
      depends_on: [{ table: 'ap_intake_exceptions', id: row.id, condition: 'not_pending' }],
      next_action: `Supply ${piece} on the Payables exceptions list.`, reason: row.reason };
  }
  return { ...base, basis, action: 'track', outcome: 'review', autonomy_class: 'REVIEW', priority: 'normal',
    title: `Bill needs a person: ${label}`, next_action: String(row.notes || 'Open the exception and decide how to load it.').slice(0, 300), reason: row.reason || 'other' };
}

// ---- Board packet (board_packets row) --------------------------------------
const BOARD_PACKET_COLUMNS = 'id, community_id, period_label, meeting_date, status';
// Midnight America/Chicago on a calendar date, as a full ISO instant (CDT/CST resolved).
function centralMidnightIso(dateStr) {
  const d = String(dateStr).slice(0, 10);
  for (const off of [5, 6]) {
    const probe = new Date(`${d}T${String(off).padStart(2, '0')}:00:00Z`);
    const hr = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', hour12: false }).format(probe);
    if (Number(hr) % 24 === 0) return probe.toISOString();
  }
  return new Date(`${d}T05:00:00Z`).toISOString();
}
const FINAL = ['final', 'distributed', 'archived'];
function daysUntil(dateStr, now) {
  if (!dateStr) return null;
  const d = Date.parse(`${String(dateStr).slice(0, 10)}T12:00:00Z`);
  const t = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T12:00:00Z`);
  return Math.round((d - t) / 86400000);
}
function boardPacket(row, now = Date.now(), { urgentDays = 3 } = {}) {
  const refs = { table: 'board_packets', id: row.id, meeting_date: row.meeting_date || null };
  const base = { domain: 'board', objective_type: 'board', owner_kind: 'workflow', owner_key: 'board.packet', community_id: row.community_id || null, subject_refs: refs };
  const days = daysUntil(row.meeting_date, now);
  const basis = { status: row.status, meeting_date: row.meeting_date || null, urgent: days != null && days <= urgentDays };
  if (FINAL.includes(row.status)) return { ...base, basis, action: 'clear', outcome: 'resolved', reason: `packet ${row.status}` };
  if (days == null) return { ...base, basis, action: 'clear', outcome: 'no_action', reason: 'no meeting date on file' };
  const when = days < 0 ? `meeting was ${-days} day${days === -1 ? '' : 's'} ago` : days === 0 ? 'meeting is today' : `meeting in ${days} day${days === 1 ? '' : 's'}`;
  return { ...base, basis, action: 'track', outcome: 'review', autonomy_class: 'REVIEW', priority: days <= urgentDays ? 'high' : 'normal',
    title: `Board packet ${row.period_label || ''} still ${String(row.status).replace('_', ' ')} (${when})`.replace(/\s+/g, ' '),
    next_action: 'Finish and finalize the board packet before the meeting.',
    next_action_due: centralMidnightIso(row.meeting_date), reason: `packet ${row.status}, ${when}` };
}

const KINDS = {
  ap_invoice:   { table: 'ap_invoices',          columns: AP_INVOICE_COLUMNS,   evaluate: apInvoice },
  ap_exception: { table: 'ap_intake_exceptions', columns: AP_EXCEPTION_COLUMNS, evaluate: apException },
  board_packet: { table: 'board_packets',        columns: BOARD_PACKET_COLUMNS, evaluate: boardPacket },
};
const subjectKey = (kind, id) => `${kind}:${id}`;
const parseSubjectKey = (k) => { const m = /^([a-z_]+):(.+)$/.exec(String(k || '')); return m && KINDS[m[1]] ? { kind: m[1], id: m[2] } : null; };

// The due condition is part of the state, so "due soon" -> "overdue" is ONE change.
function dueCondition(nextActionDue, now = Date.now(), lookaheadHours = 24) {
  if (!nextActionDue) return null;
  const t = Date.parse(nextActionDue);
  if (Number.isNaN(t)) return null;
  if (t < now) return 'overdue';
  if (t <= now + lookaheadHours * 3600000) return 'due_soon';
  return null;
}
// One state hash for an objective: subject facts + the classification + due condition + status.
function stateHash({ subject = null, classification = null, due = null, status = null }) {
  return sha(canon({ subject, classification, due, status }));
}

module.exports = { KINDS, MISSING_PIECE, apInvoice, apException, boardPacket, subjectKey, parseSubjectKey, dueCondition, stateHash, daysUntil, centralMidnightIso, canon, sha, FINAL };
