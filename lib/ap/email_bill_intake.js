// ============================================================================
// lib/ap/email_bill_intake.js  (Issue #14): run ONE stored Emma email through AP
// ----------------------------------------------------------------------------
// The single path that re-reads an email already in trustEd and files its
// bills: used by /sweep-inbox and scripts/ap_replay_emails.js, so the two can
// never diverge. Same reader (every bill format), same autoIntake (duplicate
// guards, review flags, autopay flag), same one-outcome record as live intake.
// Never approves or pays. Idempotent: every payable / exception is keyed on
// `email:<graph_id>` plus the file hash, so a re-run returns what exists.
// ============================================================================
let _sb = null;
const sb = () => (_sb = _sb || require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY));
// Real dependencies, loaded only for the ones a caller does not inject.
const LOADERS = {
  supabase: () => sb(),
  autoIntake: () => require('./intake').autoIntake,
  recordException: () => require('./intake_exceptions').recordException,
  fetchBillAttachments: () => require('../email/graph_attachments').fetchBillAttachments,
};
const withDeps = (injected = {}) => { const d = { ...injected }; for (const k of Object.keys(LOADERS)) if (!d[k]) d[k] = LOADERS[k](); return d; };

// Attachments for a stored email. The MAILBOX copy first: Graph marks inline
// images (signature logos), so they are never read as bills. The archive is the
// fallback for a message no longer in the mailbox; it does not record "inline",
// so Outlook's own signature-image names (image001.png, under 100 KB) are
// treated as inline there. Returns [{ name, contentType, buffer|null, isInline }].
const SIGNATURE_IMAGE = /^image\d*\.(png|jpe?g|gif)$/i;
async function loadBillAttachments(m, deps) {
  const { supabase, fetchBillAttachments } = deps;
  if (m.graph_id) {
    try {
      const live = await fetchBillAttachments(m.mailbox, m.graph_id);
      if (live.length) return live;
    } catch (e) { console.warn('[email_bill_intake] mailbox copy unavailable for', m.id, '- using the archive:', e.message); }
  }
  const atts = [];
  const { data: arch, error: ae } = await supabase.from('email_attachments').select('filename, storage_path, mime').eq('email_message_id', m.id);
  if (ae) console.warn('[email_bill_intake] archived-attachment read failed for', m.id, ae.message);
  for (const a of (arch || [])) {
    const { data: blob, error: be } = await supabase.storage.from('documents').download(a.storage_path);
    if (be) console.warn('[email_bill_intake] archive download failed for', m.id, a.filename, be.message);
    const buffer = blob ? Buffer.from(await blob.arrayBuffer()) : null;
    const name = a.filename || 'attachment';
    atts.push({ name, contentType: a.mime || '', buffer, isInline: !!(buffer && SIGNATURE_IMAGE.test(name) && buffer.length < 100 * 1024),
      unavailable: buffer ? undefined : 'archived copy could not be downloaded: open the email and enter the bill' });
  }
  return atts;
}

// m: email_messages row (id, mailbox, graph_id, subject, sender_email,
// community_id, resolved_vendor_id, extracted, body_full, body_preview,
// classification). opts: { classification, convenienceFeeHold, atts }.
// Returns { skipped, decision, results, prepared, exceptionIds, recordError }.
async function intakeBillEmail(m, opts = {}, _deps = {}) {
  const deps = withDeps(_deps);
  const { prepareBillFiles } = require('./bill_files');
  const { decideOutcome, intakeRecord } = require('./email_intake_outcome');
  const { hasPaymentIntent } = require('./reimbursement');
  const { annotateNotInvoiceResults } = require('./bill_signal');
  const atts = opts.atts || await loadBillAttachments(m, deps);
  const prepared = await prepareBillFiles(atts);
  if (!prepared.files.length && !prepared.skipped.length) return { skipped: 'no attachments could be found', prepared };
  const srcRef = `email:${m.graph_id || m.id}`;
  const body = m.body_full || m.body_preview || '';
  const results = [];
  for (const f of prepared.files) {
    let out;
    try {
      out = await deps.autoIntake({ buffer: f.buffer, filename: f.name, file: f, intakeMethod: 'email', sourceRef: srcRef, communityId: m.community_id || null, vendorIdHint: m.resolved_vendor_id || null, achHintText: `${m.subject || ''} ${body}`, staffNote: body, staffSenderEmail: m.sender_email || '', emailSubject: m.subject || '', convenienceFeeHold: !!opts.convenienceFeeHold, intentHint: opts.intentHint || null });
    } catch (e) { out = { outcome: 'error', reason: e.message }; }
    results.push({ file: f.name, kind: f.kind, outcome: (out && out.outcome) || 'error', invoice_id: out && out.invoice_id, duplicate_of: out && out.duplicate_of, reason: out && out.reason, _out: out });
  }
  await annotateNotInvoiceResults(deps.supabase, results);
  const paymentAsked = hasPaymentIntent(`${m.subject || ''}\n${body}`);
  const decision = decideOutcome({ filesSeen: prepared.seen, results, skipped: prepared.skipped, paymentAsked, classification: opts.classification || 'vendor_financial' });
  const exceptionIds = [];
  for (const x of decision.exceptions) {
    const o = x.fromReader && x.result && x.result._out ? x.result._out : null;
    const r = await deps.recordException({ emailMessageId: m.id, sourceRef: srcRef, reason: `${x.reason}${x.file ? ` [${x.file}]` : ''}`, extracted: (o && o.extracted) || {}, storagePath: o && o.storage_path, sha256: o && o.sha256, communityId: m.community_id || null, suggestedVendorId: (o && o.suggested_vendor_id) || null });
    if (r && r.ok && r.id) exceptionIds.push(r.id);
    else console.warn('[email_bill_intake] exception not recorded for', m.id, r && r.reason);
  }
  const upd = { extracted: { ...(m.extracted || {}), ap_intake: intakeRecord(decision, { results: results.map(({ _out, ...r }) => r), skipped: prepared.skipped, exceptionIds }) } };
  // keepOpen: a teammate still owes the sender a reply (Amanda's handoff), so filing
  // the receipt must not close the email in her inbox.
  if (decision.handled && !opts.keepOpen) upd.triage_status = 'handled';
  const { error: ue } = await deps.supabase.from('email_messages').update(upd).eq('id', m.id);
  if (ue) console.warn('[email_bill_intake] could not record outcome on', m.id, ue.message);
  return { skipped: null, decision, results, prepared, exceptionIds, recordError: ue ? ue.message : null };
}

module.exports = { intakeBillEmail, loadBillAttachments, withDeps };
