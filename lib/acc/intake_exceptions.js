// lib/acc/intake_exceptions.js — ACC applications that arrived but never reached the queue
// (Ed 2026-11-17: "failed intake must generate a visible staff exception rather than silently
// disappearing").
//
// Scar: emailed applications landed in trustEd (acc_request, attachments, property resolved)
// and no acc_decisions row was ever created, with no trace of why. intakeApplicationFromEmail
// returned no_address / no_community / engine_not_ready / attachments_unavailable and the
// caller threw the result away. Several homeowner applications to info@ were ingested 11/15
// and never filed.
//
// Two parts:
//   recordIntakeOutcome(email row id, outcome)  stamps extracted.acc_intake on the email so
//     every attempt is visible (status, plain-English reason, the record it created or joined).
//   findIntakeExceptions({ emails, decisions })  pure: ACC emails with no record, grouped by
//     thread, with the reason. Served to staff on the ACC queue as "Received, not filed".
// A row leaves the list when it is filed (record linked), or staff dismiss the email.

const FILED = new Set(['created', 'attached', 'exists']);
const REASON = {
  no_attachments: 'No form or photo was attached. File it from the email if it is an application.',
  no_address: 'No property address on the form, in the email or for the sender. Identify the property, then file it.',
  no_community: 'Could not tell which community this is for.',
  no_arc_service: 'This community has no ACC/ARC service set up.',
  no_graph_id: 'The original email can no longer be fetched. Ask the sender to resend it.',
  attachments_unavailable: 'The attachments could not be read from the mailbox.',
  engine_not_ready: 'The ACC review engine was not running when this email was taken in.',
  engine_failed: 'The ACC review engine failed on this email.',
  error: 'Intake failed with an error.',
  not_attempted: 'No ACC record was created and the reason was not recorded (received before intake results were tracked).',
};
const reasonFor = (st, detail) => (REASON[st] || `Not filed (${st}).`) + (detail ? ` ${String(detail).slice(0, 160)}` : '');

const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
// House number + first street word: "100 Sample Oak Cir" -> "100sample".
function addrKey(a) {
  const m = String(a || '').toLowerCase().match(/(\d{2,6})\s+([a-z]+)/);
  return m ? m[1] + m[2] : null;
}

// emails: inbound email_messages rows (id, graph_id, conversation_id, mailbox, subject,
//   sender_email, received_at, has_attachments, classification, triage_status, extracted,
//   community_id, property_address). decisions: acc_decisions rows (id, reference_number,
//   status, homeowner_address, intake_source_ref, source_email_refs, conversation_id, created_at).
// accMailboxes: lower-case mailbox addresses that only receive ACC mail (annie@, acc@).
function findIntakeExceptions({ emails = [], decisions = [], accMailboxes = [] }) {
  const refs = new Set(); const convs = new Set(); const byAddr = new Map();
  for (const d of decisions) {
    if (d.intake_source_ref) refs.add(d.intake_source_ref);
    for (const r of d.source_email_refs || []) refs.add(String(r));
    if (d.conversation_id) convs.add(d.conversation_id);
    const k = addrKey(d.homeowner_address);
    if (k) { if (!byAddr.has(k)) byAddr.set(k, []); byAddr.get(k).push(d); }
  }
  const accBox = new Set(accMailboxes.map((m) => String(m).toLowerCase()));
  const isAcc = (m) => m.classification === 'acc_request' || accBox.has(String(m.mailbox || '').toLowerCase());
  const linked = (m) => refs.has('email:' + m.graph_id) || refs.has('email:' + m.id) || refs.has('msg:' + m.id) || (m.conversation_id && convs.has(m.conversation_id));
  const out = new Map();
  for (const m of emails) {
    if (m.direction && m.direction !== 'inbound') continue;
    if (!isAcc(m)) continue;
    if (['handled', 'dismissed', 'spam'].includes(m.triage_status)) continue;
    const ai = (m.extracted && m.extracted.acc_intake) || null;
    if (ai && FILED.has(ai.status)) continue;
    if (linked(m)) continue;
    // A record for the same property created when or after this email arrived covers it
    // (the forward was filed, this is the homeowner's original or a reply).
    const k = addrKey(m.property_address) || addrKey((m.extracted && (m.extracted.addresses || [])[0]) || '') || addrKey(m.subject);
    // An OPEN record for the property also covers it: a forward or reply about a case already in
    // the queue is attached to it (and filing the message in Annie's mailbox changes its Graph id,
    // so the link by message id can't be relied on).
    const OPEN = ['pending_review', 'awaiting_info', 'finalizing'];
    const cover = k && (byAddr.get(k) || []).find((d) => OPEN.includes(d.status) || (d.status !== 'archived' && new Date(d.created_at) >= new Date(new Date(m.received_at).getTime() - 86400000)));
    if (cover) continue;
    const key = m.conversation_id || m.id;
    const prior = out.get(key);
    const status = ai ? ai.status : (m.has_attachments || accBox.has(String(m.mailbox || '').toLowerCase()) ? 'not_attempted' : 'no_attachments');
    const row = { email_id: m.id, subject: m.subject || '', from: m.sender_email || '', mailbox: m.mailbox, received_at: m.received_at,
      has_attachments: !!m.has_attachments, community_id: m.community_id || null, property_address: m.property_address || null,
      status, reason: reasonFor(status, ai && ai.detail), messages: 1,
      prior_records: k ? (byAddr.get(k) || []).map((d) => `${d.reference_number || d.id.slice(0, 8)} ${d.status}`) : [] };
    if (!prior) out.set(key, row);
    else {
      prior.messages += 1;
      // Show the newest message that has an attachment (the one worth filing), else the newest.
      const better = (row.has_attachments && !prior.has_attachments) || (row.has_attachments === prior.has_attachments && row.received_at > prior.received_at);
      if (better) out.set(key, { ...row, messages: prior.messages });
    }
  }
  return [...out.values()].sort((a, b) => String(a.received_at).localeCompare(String(b.received_at)));
}

// Stamp the intake result on the email (merged into extracted). Never throws.
async function recordIntakeOutcome(supabase, emailId, outcome) {
  if (!emailId) return;
  try {
    const { data } = await supabase.from('email_messages').select('extracted').eq('id', emailId).maybeSingle();
    const o = outcome || {};
    const acc_intake = { status: o.status || (o.queued ? 'created' : 'error'), detail: o.detail || null, application_id: o.application_id || o.id || null, at: new Date().toISOString() };
    const patch = { extracted: { ...((data && data.extracted) || {}), acc_intake } };
    if (!FILED.has(acc_intake.status)) patch.triage_status = 'needs_review';
    const { error } = await supabase.from('email_messages').update(patch).eq('id', emailId);
    if (error) console.warn('[acc_intake] outcome not recorded:', emailId, error.message);
    if (!FILED.has(acc_intake.status)) console.warn('[acc_intake] application NOT filed', { email_id: emailId, status: acc_intake.status, detail: acc_intake.detail });
  } catch (e) { console.warn('[acc_intake] outcome not recorded:', emailId, e.message); }
}

module.exports = { findIntakeExceptions, recordIntakeOutcome, reasonFor, addrKey, FILED };
