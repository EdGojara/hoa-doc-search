// ============================================================================
// lib/ap/stragglers.js  (Issue #14): bills that reached Emma and went nowhere
// ----------------------------------------------------------------------------
// A straggler is an inbound email to Emma, with attachments, that is a bill,
// older than 24 hours, and that has NONE of: a recorded intake outcome
// (extracted.ap_intake), a payable or a Payables exception tied to it, or a
// person closing it (handled / dismissed / spam). Those are exactly the emails
// that sat silently for two weeks (Waterview DJ + petting zoo, Sept 2026).
//
// "Is a bill" does not trust the email's label alone: the classifier, a payment
// ask, a FILE the reader tied to a vendor we pay, or (for mail with no recorded
// outcome) a subject or attachment name that reads like a bill. The 9/29
// Waterview MUD bill was labeled "internal" and was missed by the label-only
// rule. Surfaced daily (scheduler job ap_intake_stragglers -> cron_runs summary)
// and on the Payables page, with the reason. Read-only.
// ============================================================================
const { hasPaymentIntent } = require('./reimbursement');
const { looksLikeBillText } = require('./bill_signal');
const TERMINAL_TRIAGE = new Set(['handled', 'dismissed', 'spam']);
const TERMINAL_OUTCOMES = new Set(['payable', 'exception', 'duplicate', 'not_a_bill']);

// Pure: why this email is a straggler, or null. m: email_messages row; ctx: {
// now, olderThanHours, payableRefs:Set('email:<graph_id>'), exceptionRefs:Set,
// exceptionEmailIds:Set, attachmentNames:{ [email_id]: [filename] } }.
function stragglerReason(m, ctx) {
  const { now = new Date(), olderThanHours = 24, payableRefs = new Set(), exceptionRefs = new Set(), exceptionEmailIds = new Set(), attachmentNames = {} } = ctx || {};
  if (!m || m.direction !== 'inbound' || !m.has_attachments || m.persona !== 'emma') return null;
  if (TERMINAL_TRIAGE.has(m.triage_status)) return null;
  const received = new Date(m.received_at || m.created_at || 0);
  if (now - received < olderThanHours * 3600 * 1000) return null;
  const ref = `email:${m.graph_id}`;
  if (payableRefs.has(ref) || exceptionRefs.has(ref) || exceptionEmailIds.has(m.id)) return null;
  const ai = m.extracted && m.extracted.ap_intake;
  const fileSaysBill = !!(ai && (ai.files || []).some((f) => f && f.bill_signal && f.bill_signal.known_vendor_id));
  if (ai && TERMINAL_OUTCOMES.has(ai.outcome) && !fileSaysBill) return null;
  const text = `${m.subject || ''}\n${m.body_preview || m.body_full || ''}`;
  if (m.classification === 'vendor_financial') return 'classified as a vendor bill';
  if (hasPaymentIntent(text)) return 'someone asked for it to be paid';
  if (fileSaysBill) return 'the attachment reads as a bill from a vendor we pay';
  if (!ai && looksLikeBillText(m.subject, attachmentNames[m.id] || [])) return `the subject or attachment name reads like a bill (labeled "${m.classification || 'unlabeled'}")`;
  return null;
}
function isStraggler(m, ctx) { return !!stragglerReason(m, ctx); }

async function findStragglers(supabase, { olderThanHours = 24, sinceDays = 60, now = new Date() } = {}) {
  const since = new Date(now - sinceDays * 86400000).toISOString();
  const rows = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await supabase.from('email_messages')
      .select('id, graph_id, mailbox, persona, direction, has_attachments, classification, triage_status, subject, body_preview, received_at, created_at, community_id, extracted')
      .eq('persona', 'emma').eq('direction', 'inbound').eq('has_attachments', true).gte('received_at', since)
      .order('received_at', { ascending: true }).range(f, f + 999);
    if (error) throw error;
    rows.push(...data); if (data.length < 1000) break;
  }
  const open = rows.filter((m) => !TERMINAL_TRIAGE.has(m.triage_status));
  const refs = open.map((m) => `email:${m.graph_id}`);
  const payableRefs = new Set(), exceptionRefs = new Set(), exceptionEmailIds = new Set();
  for (let i = 0; i < refs.length; i += 25) {
    const chunk = refs.slice(i, i + 25);
    const { data: ap, error: e1 } = await supabase.from('ap_invoices').select('intake_source_ref').in('intake_source_ref', chunk);
    if (e1) throw e1; (ap || []).forEach((x) => payableRefs.add(x.intake_source_ref));
    const { data: ex, error: e2 } = await supabase.from('ap_intake_exceptions').select('intake_source_ref, email_message_id').in('intake_source_ref', chunk);
    if (e2) throw e2; (ex || []).forEach((x) => { exceptionRefs.add(x.intake_source_ref); if (x.email_message_id) exceptionEmailIds.add(x.email_message_id); });
  }
  const ids = open.map((m) => m.id);
  const attachmentNames = {};
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { data: ex, error } = await supabase.from('ap_intake_exceptions').select('email_message_id').in('email_message_id', chunk);
    if (error) throw error; (ex || []).forEach((x) => exceptionEmailIds.add(x.email_message_id));
    const { data: at, error: ae } = await supabase.from('email_attachments').select('email_message_id, filename').in('email_message_id', chunk).limit(1000);
    if (ae) throw ae; (at || []).forEach((a) => { (attachmentNames[a.email_message_id] = attachmentNames[a.email_message_id] || []).push(a.filename); });
  }
  const ctx = { now, olderThanHours, payableRefs, exceptionRefs, exceptionEmailIds, attachmentNames };
  return open.map((m) => ({ m, reason: stragglerReason(m, ctx) })).filter((x) => x.reason)
    .map(({ m, reason }) => ({ id: m.id, reason, subject: m.subject, received_at: m.received_at, triage_status: m.triage_status, classification: m.classification, community_id: m.community_id, age_hours: Math.round((now - new Date(m.received_at)) / 3600000) }));
}

module.exports = { isStraggler, stragglerReason, findStragglers };
