'use strict';
// ============================================================================
// lib/ea/delegation.js  (Ed 2026-10-19) — Tessa's delegated follow-through
// ----------------------------------------------------------------------------
// Ed copied Tessa on "please print, sign and scan back to me and we will mail it
// to the IRS" (Paul Grover, August Meadows 2025 Form 1120-H). He meant: own the
// whole follow-through, not draft one email. Being copied still only INFORMS her;
// Ed turns a copied email into a delegation with one instruction, and from then
// on she tracks the steps:
//
//   requested -> received -> signature -> filed -> mail_assigned -> mailed
//
// Who may move each step is fixed here, in code, not left to a model:
//   received       Tessa (a reply from the expected person with a PDF): only ever
//                  "received_unverified". An attachment is never assumed to be the
//                  signed return.
//   signature      Tessa may CHECK (advisory: appears_signed / not_signed /
//                  uncertain). Only Ed verifies, against the exact file (sha256).
//   filed          Ed, and only after a verified signature, into that community's
//                  tax records (library_documents, category tax_return).
//   mail_assigned  Ed assigns a named staff member (a Mission Control task).
//   mailed         Only the ASSIGNED staff member (or Ed), by explicitly recording
//                  the mailed date, the method and, for any tracked method, the
//                  tracking / certified number (api/tessa_mailing.js). Closing the
//                  task is NOT mailing; Tessa can never mark it mailed.
// Late or stuck: she alerts Ed (once per kind, at most every 48h). A nudge to the
// sender is a draft Ed approves; nothing is sent, filed or mailed on its own.
//
// The record is Tessa's own owner-only ledger (ea_followups, kind signed_return,
// with community_id) plus an append-only audit (ea_followup_events). Staff only
// ever see the print-and-mail task. (Amanda's objectives were not used: the
// manager sweep acts on every open objective, and this is Ed's matter.)
// ============================================================================

const KIND = 'signed_return';
const STEP_ORDER = ['requested', 'received', 'signature', 'filed', 'mail_assigned', 'mailed'];
const MAIL_DAYS = 3;                  // a print-and-mail task should be closed within 3 days
const ALERT_EVERY_MS = 48 * 3600e3;   // at most one text per alert kind per 48 hours
const SYSTEM_ACTORS = /^(tessa|agent|system|scheduler|claude|amanda)\b/i;

const iso = (d) => new Date(d).toISOString();
const norm = (e) => String(e || '').trim().toLowerCase();
const normSubject = (s) => String(s || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
const isPdfName = (n) => /\.pdf$/i.test(String(n || '').trim());

function newSteps({ at = new Date(), requestedBy = 'Ed', sourceInboxId = null, sourceSubject = '', expectedFrom = null, documentLabel = null, taxYear = null, deadline = null } = {}) {
  return {
    meta: { source_inbox_id: sourceInboxId, source_subject: sourceSubject, expected_from: norm(expectedFrom) || null, document_label: documentLabel, tax_year: taxYear, deadline },
    requested: { state: 'done', at: iso(at), by: requestedBy },
    received: { state: 'pending' },
    signature: { state: 'pending' },
    filed: { state: 'pending' },
    mail_assigned: { state: 'pending' },
    mailed: { state: 'pending' },
    alerts: {},
  };
}

// Where the workflow is: the first step not finished.
function currentStep(steps) {
  const done = { requested: ['done'], received: ['received_unverified'], signature: ['verified'], filed: ['filed'], mail_assigned: ['assigned'], mailed: ['confirmed_by_staff'] };
  for (const k of STEP_ORDER) if (!done[k].includes((steps[k] || {}).state)) return k;
  return 'complete';
}
function followupStatus(steps) {
  const c = currentStep(steps);
  if (c === 'complete') return 'done';
  return c === 'received' ? 'waiting' : 'open';
}
function nextAction(steps) {
  const m = steps.meta || {};
  switch (currentStep(steps)) {
    case 'received': return `Waiting for ${m.expected_from || 'the sender'} to send back the signed ${m.document_label || 'document'}.`;
    case 'signature': return (steps.signature.state === 'rejected')
      ? 'The returned document was not accepted as signed. Ask for a signed copy.'
      : (steps.signature.state === 'checked' ? 'Tessa checked the returned document. Confirm the signature (Ed).' : 'A document came back. Check it, then confirm the signature (Ed).');
    case 'filed': return 'File the verified return in the association\'s tax records (Ed).';
    case 'mail_assigned': return 'Assign a staff member to print and mail it to the IRS (Ed).';
    case 'mailed': return `Waiting for ${steps.mail_assigned.assigned_to || 'staff'} to confirm it was mailed.`;
    default: return 'Complete.';
  }
}

// Does an inbox message look like the expected return? The expected person, the
// same thread (subject or conversation), and a PDF. Never more than that.
function matchesReturn(steps, msg) {
  const m = steps.meta || {};
  if (!msg || !m.expected_from) return false;
  if (norm(msg.from_email) !== m.expected_from) return false;
  const sameThread = (m.source_conversation_id && msg.conversation_id && m.source_conversation_id === msg.conversation_id)
    || (m.source_subject && normSubject(msg.subject) === normSubject(m.source_subject));
  if (!sameThread) return false;
  const names = Array.isArray(msg.attachment_names) ? msg.attachment_names : [];
  return names.some(isPdfName);
}

function applyReceived(steps, { inboxId, attachments = [], at = new Date() }) {
  if (steps.received.state !== 'pending' && steps.signature.state !== 'rejected') return { steps, changed: false };
  const pdfs = attachments.filter(isPdfName);
  const next = { ...steps,
    received: { state: 'received_unverified', inbox_id: inboxId, attachments: pdfs, at: iso(at) },
    // A new document after a rejected one starts the check over.
    signature: { state: 'pending' } };
  return { steps: next, changed: true };
}

const VERDICTS = ['appears_signed', 'not_signed', 'uncertain'];
// Tessa's read of the document. ADVISORY ONLY: it never verifies anything.
function applyCheck(steps, { advisory, sha256, filename, at = new Date() }) {
  if (steps.received.state !== 'received_unverified') throw Object.assign(new Error('Nothing has come back to check yet.'), { code: 'nothing_received' });
  if (!sha256) throw Object.assign(new Error('The checked file has no fingerprint.'), { code: 'no_hash' });
  const verdict = VERDICTS.includes(advisory && advisory.verdict) ? advisory.verdict : 'uncertain';
  return { ...steps, signature: { state: 'checked', advisory: { ...(advisory || {}), verdict }, sha256, filename: filename || null, checked_at: iso(at) } };
}

// Ed's decision, on the exact file Tessa checked. The association is never taken
// from a file name: unless the document itself matched the association (its name,
// and its EIN when one is on file), Ed must confirm the association explicitly.
function applyOwnerVerify(steps, { verdict, sha256, by, associationConfirmed = false, at = new Date() }) {
  if (steps.signature.state !== 'checked') throw Object.assign(new Error('Check the document first, so the decision is about a specific file.'), { code: 'not_checked' });
  if (!sha256 || sha256 !== steps.signature.sha256) throw Object.assign(new Error('That is not the file that was checked. Check it again.'), { code: 'hash_mismatch' });
  if (!by || SYSTEM_ACTORS.test(by)) throw Object.assign(new Error('A named person must confirm the signature.'), { code: 'needs_person' });
  const assoc = steps.signature.advisory && steps.signature.advisory.association_match;
  if (verdict === 'signed' && assoc !== true && associationConfirmed !== true) {
    throw Object.assign(new Error(assoc === false ? 'The document does not match this association. Review it, then confirm the association explicitly (or fix the association).' : 'The document could not prove which association it is for. Review it and confirm the association explicitly.'), { code: 'association_unconfirmed' });
  }
  if (verdict === 'signed') return { ...steps, signature: { ...steps.signature, state: 'verified', verified_by: by, verified_at: iso(at), association_confirmed_by: assoc === true ? 'document' : by } };
  if (verdict === 'not_signed') return { ...steps, signature: { ...steps.signature, state: 'rejected', rejected_by: by, rejected_at: iso(at) } };
  throw Object.assign(new Error('verdict must be signed or not_signed'), { code: 'bad_verdict' });
}

function assertCanFile(steps) {
  if (steps.signature.state !== 'verified') throw Object.assign(new Error('Only a return whose signature you confirmed can be filed.'), { code: 'not_verified' });
  if (steps.filed.state === 'filed') throw Object.assign(new Error('Already filed.'), { code: 'already_filed' });
}
function applyFiled(steps, { libraryDocumentId, by, at = new Date() }) {
  assertCanFile(steps);
  return { ...steps, filed: { state: 'filed', library_document_id: libraryDocumentId, by, at: iso(at) } };
}

function assertCanAssign(steps) {
  if (steps.filed.state !== 'filed') throw Object.assign(new Error('File the verified return first, so the task links the right document.'), { code: 'not_filed' });
}
// The assignee is a USER (stable id from user_profiles); the name is display only.
// Two staff with the same name, or a renamed account, cannot confuse who may act.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function applyAssigned(steps, { workItemId, assignee, by, at = new Date() }) {
  assertCanAssign(steps);
  const a = assignee || {};
  if (!a.id || !UUID_RE.test(String(a.id))) throw Object.assign(new Error('Choose a staff member from the list.'), { code: 'needs_person' });
  if (!a.name || SYSTEM_ACTORS.test(a.name)) throw Object.assign(new Error('Assign a staff member, not Tessa or an agent.'), { code: 'needs_person' });
  return { ...steps, mail_assigned: { state: 'assigned', work_item_id: workItemId, assigned_user_id: String(a.id), assigned_to: a.name, assigned_email: a.email || null, by, at: iso(at) } };
}

// How it went to the IRS. A tracked method needs its tracking number.
const MAIL_METHODS = {
  certified_mail: { label: 'Certified Mail', tracked: true },
  certified_return_receipt: { label: 'Certified Mail, return receipt', tracked: true },
  priority_mail: { label: 'Priority Mail', tracked: true },
  private_delivery_service: { label: 'IRS-designated private delivery service', tracked: true },
  first_class: { label: 'First-Class Mail (no tracking)', tracked: false },
};

// Validate a mailing record. Returns { ok, errors[], record }.
function validateMailingRecord(input, { assignedAt = null, now = new Date() } = {}) {
  const r = input || {};
  const errors = [];
  const mailedOn = String(r.mailed_on || '').trim();
  const okDate = /^\d{4}-\d{2}-\d{2}$/.test(mailedOn) && new Date(mailedOn + 'T12:00:00Z').toISOString().slice(0, 10) === mailedOn;
  if (!okDate) errors.push('Enter the date it was mailed.');
  else {
    const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    if (mailedOn > today) errors.push('The mailed date cannot be in the future.');
    if (assignedAt && mailedOn < new Date(assignedAt).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })) errors.push('The mailed date is before the task was assigned.');
  }
  const method = MAIL_METHODS[r.method] ? r.method : null;
  if (!method) errors.push('Choose how it was mailed.');
  const tracking = String(r.tracking_number || '').replace(/\s+/g, '').toUpperCase();
  if (method && MAIL_METHODS[method].tracked && !/^[A-Z0-9]{8,40}$/.test(tracking)) errors.push(`Enter the ${method.startsWith('certified') ? 'certified-mail' : 'tracking'} number.`);
  return { ok: !errors.length, errors, record: { mailed_on: okDate ? mailedOn : null, method, method_label: method ? MAIL_METHODS[method].label : null, tracking_number: tracking || null, notes: String(r.notes || '').trim().slice(0, 500) || null } };
}

// The mailing is confirmed only by the assigned person (or Ed), with a valid record.
function applyMailingConfirmed(steps, { record, by, byUserId = null, isOwner = false, at = new Date() }) {
  if (steps.mail_assigned.state !== 'assigned') throw Object.assign(new Error('This return has not been assigned for mailing.'), { code: 'not_assigned' });
  if (steps.mailed.state === 'confirmed_by_staff') throw Object.assign(new Error('Mailing is already confirmed.'), { code: 'already_mailed' });
  if (!by || SYSTEM_ACTORS.test(by)) throw Object.assign(new Error('A named person must confirm mailing.'), { code: 'needs_person' });
  // Matched on the user id, never the name.
  if (!isOwner && (!steps.mail_assigned.assigned_user_id || !byUserId || String(byUserId) !== String(steps.mail_assigned.assigned_user_id))) {
    throw Object.assign(new Error(`Only ${steps.mail_assigned.assigned_to} (or Ed) can confirm this mailing.`), { code: 'not_assignee' });
  }
  const v = validateMailingRecord(record, { assignedAt: steps.mail_assigned.at, now: at });
  if (!v.ok) throw Object.assign(new Error(v.errors.join(' ')), { code: 'bad_mailing_record', errors: v.errors });
  return { ...steps, mailed: { state: 'confirmed_by_staff', by, at: iso(at), ...v.record } };
}

// What needs Ed's attention now. Pure: the caller texts Ed / records the alert.
function dueAlerts(steps, { dueDate = null, now = new Date(), taskClosed = false } = {}) {
  const out = [];
  const t = new Date(now).getTime();
  const recently = (kind) => steps.alerts && steps.alerts[kind] && t - Date.parse(steps.alerts[kind]) < ALERT_EVERY_MS;
  const endOfDay = (d) => Date.parse(`${d}T23:59:59-05:00`);
  const c = currentStep(steps);
  const m = steps.meta || {};
  if (c === 'received' && dueDate && t > endOfDay(dueDate) && !recently('return_overdue')) {
    out.push({ kind: 'return_overdue', text: `${m.document_label || 'The document'} from ${m.expected_from || 'the sender'} was expected by ${dueDate} and has not come back. Open Tessa to send a nudge (a draft for you to approve).` });
  }
  if (c === 'signature' && steps.signature.state === 'rejected' && !recently('signature_rejected')) {
    out.push({ kind: 'signature_rejected', text: `The ${m.document_label || 'document'} that came back was not accepted as signed. Open Tessa to ask for a signed copy.` });
  }
  if (c === 'mailed' && taskClosed && !recently('closed_without_mailing_record')) {
    out.push({ kind: 'closed_without_mailing_record', text: `The task to mail ${m.document_label || 'the return'} was closed, but nobody recorded the mailing date, method and tracking number. It is NOT counted as mailed.` });
  }
  if (c === 'mailed' && steps.mail_assigned.at && t - Date.parse(steps.mail_assigned.at) > MAIL_DAYS * 864e5 && !recently('mailing_overdue')) {
    out.push({ kind: 'mailing_overdue', text: `${steps.mail_assigned.assigned_to} has not confirmed mailing ${m.document_label || 'the return'} to the IRS (assigned ${steps.mail_assigned.at.slice(0, 10)}).` });
  }
  if (m.deadline && c !== 'complete' && !['mailed'].includes(c) && t > endOfDay(m.deadline) - 2 * 864e5 && !recently('deadline')) {
    out.push({ kind: 'deadline', text: `${m.document_label || 'This filing'} is due ${m.deadline} and is still at "${c.replace('_', ' ')}".` });
  }
  return out;
}
function markAlerted(steps, kinds, at = new Date()) {
  return { ...steps, alerts: { ...(steps.alerts || {}), ...Object.fromEntries(kinds.map((k) => [k, iso(at)])) } };
}

module.exports = {
  KIND, STEP_ORDER, MAIL_DAYS, normSubject, isPdfName,
  newSteps, currentStep, followupStatus, nextAction, matchesReturn,
  applyReceived, applyCheck, applyOwnerVerify, assertCanFile, applyFiled, assertCanAssign, applyAssigned,
  MAIL_METHODS, validateMailingRecord, applyMailingConfirmed,
  dueAlerts, markAlerted,
};
