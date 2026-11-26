// ============================================================================
// lib/applications/email_intake.js  (Ed 2026-07-12)
// ----------------------------------------------------------------------------
// Annie Reeves — the ACC/ARC specialist. Claire triages every inbound email;
// when she recognizes an architectural application (classification acc_request
// with an attached form), she hands it to Annie here. Annie drops it into the
// SAME pipeline a web submission uses — community_applications -> completeness
// -> AI assessment -> the review queue — and sends the homeowner a receipt.
//
// She does NOT decide. Per the autonomy rule: acknowledge + run the internal
// assessment, then HOLD. A human finalizes and sends the actual approval or
// denial from the applications queue (api/applications.js send-decision).
//
// One door, idempotent: keyed on intake_source_ref = 'email:<graphId>', so a
// re-pull of the same mail never creates the application twice.
// ============================================================================
const { route: aiRoute } = require('../../lib/ai/router');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('../../lib/ai/anthropic');
const graphSend = require('../email/graph_send');
const { fetchAllAttachmentBuffers } = require('../email/graph_attachments');
const { checkCompleteness } = require('./completeness');
const { findContact } = require('../entity_resolution');
const { queueDraft } = require('../email/outbound_drafts');

// Homeowner-from-email (Ed 2026-07-22). If a submission carries no address in
// the form or body, but the SENDER is a known homeowner on the roster, use
// their property — never ask a homeowner for an address we already have on
// file. This resolves LIVE off the roster (via the canonical findContact),
// which catches the case the ingest resolver missed because the contact was
// loaded AFTER the email arrived. We only accept an UNAMBIGUOUS answer (exactly
// one contact, owning exactly one property); anything ambiguous falls through
// to no_address for a human, never a guess.
async function propertyForContact(contactId) {
  const { data: own, error: oErr } = await supabase
    .from('property_ownerships')
    .select('properties:property_id(street_address, community_id)')
    .eq('contact_id', contactId)
    .is('end_date', null)
    .limit(2);
  if (oErr) { console.warn('[acc_intake] ownership lookup failed:', oErr.message); return null; }
  // Only accept an UNAMBIGUOUS single property — never guess between two.
  if (!own || own.length !== 1 || !own[0].properties || !own[0].properties.street_address) return null;
  return { address: String(own[0].properties.street_address).trim(), communityId: own[0].properties.community_id || null };
}

async function addressFromSenderEmail(email, applicantName) {
  try {
    // 1) Sender email on the roster (the common case: owner emails from their
    //    on-file address).
    const em = String(email && email.sender_email || '').toLowerCase().trim();
    if (em && EMAIL_RE.test(em)) {
      const contact = await findContact(supabase, { email: em });
      if (contact && contact.id) {
        const p = await propertyForContact(contact.id);
        if (p) return { ...p, contactName: contact.full_name || null };
      }
    }
    // 2) Applicant name on the roster, sender emailing from an OFF-roster
    //    address (e.g. a family member's inbox). Strict: exactly one contact of
    //    that full name, owning exactly one property. Ambiguous → no guess.
    const nm = String(applicantName || '').trim();
    if (nm.length >= 4 && !/^homeowner$/i.test(nm)) {
      const { data: cts, error: cErr } = await supabase
        .from('contacts').select('id, full_name').ilike('full_name', nm).limit(2);
      if (cErr) { console.warn('[acc_intake] name lookup failed:', cErr.message); }
      else if (cts && cts.length === 1) {
        const p = await propertyForContact(cts[0].id);
        if (p) return { ...p, contactName: cts[0].full_name || null };
      }
    }
    return null;
  } catch (e) { console.warn('[acc_intake] homeowner-from-email fallback errored:', e.message); return null; }
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const { BEDROCK_MGMT_CO_ID } = require('../company');

// Lazy require — api/applications.js is a big router module already loaded by
// server.js; pull the shared helpers at call time to avoid load-order coupling.
function appsPipeline() { return require('../../api/applications'); }

// Read the application form (PDF or image) for the header fields we need to
// CREATE the record. The deep per-document analysis is runAssessment's job.
async function extractHeader(primary) {
  if (!primary || !primary.buffer) return {};
  const isPdf = primary.isPdf;
  const media = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: primary.buffer.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: (primary.contentType || 'image/jpeg'), data: primary.buffer.toString('base64') } };
  const prompt = `This is an HOA architectural review (ACC/ARC) application. Extract ONLY these header fields as JSON, no markdown:
{
  "applicant_name": string | null,
  "applicant_email": string | null,
  "applicant_phone": string | null,
  "property_address": string | null,
  "community_name": string | null,
  "requested_change_summary": string | null
}
Do not fabricate. If a field is not on the form, use null.`;
  try {
    const resp = await anthropic.messages.create({
      model: aiRoute('acc.application_email_header'), max_tokens: 700,
      messages: [{ role: 'user', content: [media, { type: 'text', text: prompt }] }],
    });
    const t = (resp.content?.[0]?.text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(t);
  } catch (e) { console.warn('[acc_email_intake] header extract failed:', e.message); return {}; }
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// The applicant's own property, from their email → contact → ownership. The
// most reliable link (an owner emails from their address on file).
async function propertyFromEmail(email) {
  if (!email || !EMAIL_RE.test(email)) return null;
  try {
    const { data: c } = await supabase.from('contacts').select('id').or(`primary_email.ilike.${email},secondary_email.ilike.${email}`).limit(1);
    if (!c || !c.length) return null;
    const { data: o } = await supabase.from('property_ownerships').select('property_id, properties(id, community_id)').eq('contact_id', c[0].id).is('end_date', null).limit(1);
    if (o && o.length && o[0].properties) return { property_id: o[0].properties.id, community_id: o[0].properties.community_id, contact_id: c[0].id };
  } catch (_) {}
  return null;
}

// Match the property ADDRESS to a lot → community. House number + street name,
// only accepted when it resolves to a single community (no cross-street mixups).
async function propertyFromAddress(addressText) {
  const t = String(addressText || '').trim();
  const num = (t.match(/^\s*(\d+)/) || [])[1];
  if (!num) return null;
  const streetWord = (t.replace(/^\s*\d+\s*/, '').match(/^([A-Za-z]+)/) || [])[1] || '';
  try {
    const { data } = await supabase.from('properties').select('id, community_id, street_address').ilike('street_address', `${num}%`).limit(80);
    if (!data || !data.length) return null;
    let cands = streetWord ? data.filter((p) => new RegExp('\\b' + streetWord, 'i').test(p.street_address || '')) : data;
    if (!cands.length) cands = data;
    const comms = [...new Set(cands.map((c) => c.community_id))];
    if (comms.length === 1) return { property_id: cands[0].id, community_id: comms[0] };
    const exact = cands.find((c) => String(c.street_address || '').toLowerCase().startsWith(`${num} ${streetWord}`.toLowerCase().trim()));
    if (exact) return { property_id: exact.id, community_id: exact.community_id };
  } catch (_) {}
  return null;
}

// Resolve community + its 'arc' service (and the property when we can). Order:
// the id Claire resolved → the applicant's email → the property address →
// a stated community name.
async function resolveArcTarget({ communityId, submitterEmail, addressText, communityHint }) {
  let comm = null, propertyId = null;
  const loadComm = async (id) => { const { data } = await supabase.from('communities').select('id, name').eq('id', id).maybeSingle(); return data || null; };
  if (communityId) comm = await loadComm(communityId);
  if (!comm && submitterEmail) { const p = await propertyFromEmail(submitterEmail); if (p) { propertyId = p.property_id; comm = await loadComm(p.community_id); } }
  if (!comm && addressText) { const p = await propertyFromAddress(addressText); if (p) { propertyId = p.property_id; comm = await loadComm(p.community_id); } }
  if (!comm && communityHint) {
    const { data } = await supabase.from('communities').select('id, name').eq('management_company_id', BEDROCK_MGMT_CO_ID).ilike('name', `%${communityHint}%`).limit(1);
    if (data && data.length) comm = data[0];
  }
  if (!comm) return { comm: null, service: null, propertyId: null };
  const { data: service } = await supabase.from('community_services')
    .select('id, service_type, application_fee_usd, paid_by')
    .eq('community_id', comm.id).eq('service_type', 'arc').maybeSingle();
  return { comm, service: service || null, propertyId };
}
const isInternalAddr = (e) => /@bedrocktx\.com$/i.test(String(e || '')) || /no-?reply|donotreply/i.test(String(e || ''));

// Send Annie's receipt, falling back to Claire's mailbox if annie@ isn't set up
// in Exchange yet. Returns the mailbox actually used, or null.
// Returns { from } on success, or { error } — never a bare null, because a
// receipt that didn't go out MUST be recorded, not shrugged off.
async function sendAcknowledgment({ to, applicantName, communityName, communityId = null, reference, address, additional = false, sourceEmailRef = null, relatedType = 'application', relatedId = null, receivedAt = null }) {
  // `to` may be a comma-separated LIST (the form's applicant + the address that
  // actually emailed us). EMAIL_RE is a SINGLE-address regex (^...$, no spaces),
  // so testing the joined string against it returns null for every multi-
  // recipient ack — silently sending nobody a receipt. Validate each address.
  const recips = String(to || '').split(',').map((x) => x.trim()).filter((x) => EMAIL_RE.test(x));
  if (!recips.length) return { error: `no valid applicant address to acknowledge (got "${String(to || '').slice(0, 80)}")` };
  const toLine = recips.join(', ');
  // Annie sends the receipt herself (Ed 2026-11-26, lib/acc/acknowledge): it
  // decides nothing, and a receipt that waits for a person never goes out (52
  // sat in the Draft Queue from July to November). Only when she cannot send it
  // does it fall back to the Draft Queue, with the reason recorded.
  let autoErr = null;
  if (relatedType === 'acc_decision' && relatedId) {
    const A = require('../acc/acknowledge');
    const r = await A.acknowledgeApplication(supabase, { decisionId: relatedId, to: toLine, applicantName, communityName, communityId, reference, address, receivedAt, additional });
    if (r.sent) return { sent: true, to: r.to };
    if (r.skipped && /already acknowledged|backlog hold|application is /.test(r.skipped)) return { skipped: r.skipped };
    autoErr = r.error || r.skipped || null;
    if (autoErr) console.warn(`[acc_email_intake] receipt for ${reference || relatedId} not sent automatically (${autoErr}); queued for review`);
  }
  const { subject, body: bodyText } = require('../acc/acknowledge').acknowledgmentText({ applicantName, reference, address, receivedAt, additional });
  // Fallback: the Draft Queue. Annie's branded signature + logo are applied at
  // release (buildAnnieEmail at send time).
  const q = await queueDraft({
    communityId, communityName, persona: 'annie', fromMailbox: graphSend.ANNIE_MAILBOX,
    toEmail: toLine, toName: applicantName || null, subject, bodyText,
    relatedType, relatedId: relatedId, sourceEmailRef,
    draftKind: 'acknowledgment', draftReason: autoErr ? `ACC receipt not sent automatically: ${autoErr}` : 'ACC receipt — review before sending', createdBy: 'annie',
  });
  if (q.status === 'queued' || q.status === 'exists') return { queued: true, draftId: q.id, to: recips, error: autoErr ? `Receipt not sent automatically (${autoErr}); release it from the Draft Queue` : null };
  if (q.status === 'skipped') return { error: 'draft queue not set up yet (apply migration 327)' };
  return { error: q.error || 'could not queue acknowledgment' };
}

// ---- replies about a DECIDED application (Ed 2026-11-24, migration 576) -----
// The same message can reach two mailboxes at once (annie@ and info@): process one
// message id at a time, and remember the message on the case, so it is filed once.
const _inFlight = new Map();
async function oneAtATime(key, fn) {
  if (!key) return fn();
  const prev = _inFlight.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  _inFlight.set(key, run);
  try { return await run; } finally { if (_inFlight.get(key) === run) _inFlight.delete(key); }
}
async function hydrateIds(email) {
  if (!email || (email.internet_message_id && email.conversation_id)) return email;
  let q = supabase.from('email_messages').select('id, internet_message_id, conversation_id, received_at');
  if (email.id) q = q.eq('id', email.id); else if (email.graph_id) q = q.eq('graph_id', email.graph_id); else return email;
  const { data, error } = await q.limit(1);
  if (error) { console.warn('[acc_intake] message ids not read:', error.message); return email; }
  const r = (data || [])[0];
  return r ? { ...email, id: email.id || r.id, internet_message_id: email.internet_message_id || r.internet_message_id, conversation_id: email.conversation_id || r.conversation_id, received_at: email.received_at || r.received_at } : email;
}
const msgRefOf = (email) => (email && email.internet_message_id ? `msg:${email.internet_message_id}` : null);
// Already filed (as an application, on one, or as evidence)?
async function alreadyFiled(msgRef) {
  if (!msgRef) return null;
  const a = await supabase.from('acc_decisions').select('id').contains('source_email_refs', [msgRef]).limit(1);
  if (a.error) console.warn('[acc_intake] filed check failed:', a.error.message);
  else if (a.data && a.data.length) return { status: 'exists', application_id: a.data[0].id };
  const s = await supabase.from('acc_case_supplements').select('acc_decision_id').eq('source_ref', msgRef).limit(1);
  if (s.error) { if (!/does not exist|schema cache|could not find/i.test(s.error.message || '')) console.warn('[acc_intake] evidence check failed:', s.error.message); }
  else if (s.data && s.data.length) return { status: 'exists', application_id: s.data[0].acc_decision_id };
  return null;
}
async function rememberMessage(applicationId, msgRef) {
  if (!applicationId || !msgRef) return;
  const { data, error } = await supabase.from('acc_decisions').select('status, source_email_refs').eq('id', applicationId).maybeSingle();
  if (error || !data) { if (error) console.warn('[acc_intake] message not remembered:', error.message); return; }
  const refs = Array.isArray(data.source_email_refs) ? data.source_email_refs : [];
  if (refs.includes(msgRef) || !['pending_review', 'awaiting_info'].includes(data.status)) return;
  const up = await supabase.from('acc_decisions').update({ source_email_refs: [...refs, msgRef] }).eq('id', applicationId).in('status', ['pending_review', 'awaiting_info']);
  if (up.error) console.warn('[acc_intake] message not remembered:', up.error.message);
}
// File a message on the decided application it is about. A denial with new files
// opens a reconsideration and Annie reviews it; anything that may be a different
// request opens one too, so a person sees it in the ACC queue. Nothing is sent and
// nothing is decided here.
async function fileOnDecidedCase({ hit, email, atts = [], possibleNewRequest = false }) {
  const R = require('../acc/reconsideration');
  const download = async (p) => { const { data, error } = await supabase.storage.from('documents').download(p); if (error || !data) return null; return Buffer.from(await data.arrayBuffer()); };
  const { data: dec, error } = await supabase.from('acc_decisions').select('*').eq('id', hit.decided.id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!dec || dec.status !== 'decided') return null;
  const added = await R.addSupplement(supabase, {
    dec, kind: 'email', files: atts.map((a) => ({ buffer: a.buffer, originalname: a.filename, mimetype: a.contentType })),
    sourceRef: R.emailSourceRef(email), emailMessageId: email.id || null, fromEmail: email.sender_email || null, fromName: email.sender_name || null, subject: email.subject || null,
    bodyText: email.body_full || email.body_preview || null, receivedAt: email.received_at || null, matchedBy: hit.matched_by, possibleNewRequest, addedBy: 'Email intake', download,
  });
  if (!added.ok) { const e = new Error(added.error); e.missing576 = added.httpStatus === 503; throw e; }
  const out = { status: added.status === 'exists' ? 'exists' : 'supplement', application_id: dec.id, reference: dec.reference_number || null, match: hit.matched_by, new_documents: added.new_documents || 0, possible_new_request: possibleNewRequest };
  if (added.status === 'exists') return out;
  const inEffect = (await R.priorDecision(supabase, dec)).decision_type;
  const active = await R.activeReconsideration(supabase, dec.id);
  let rec = active;
  if (!active && (possibleNewRequest || (inEffect === 'denied' && out.new_documents > 0))) {
    const o = await R.openReconsideration(supabase, { dec, openedBy: 'Email intake', reason: possibleNewRequest ? `A message about this application came with a new application form (${String(email.received_at || '').slice(0, 10)}). It may be a different request.` : `Supplemental information received ${String(email.received_at || '').slice(0, 10)} after the denial.` });
    if (o.ok) rec = o.reconsideration; else console.warn('[acc_intake] reconsideration not opened:', dec.id, o.error);
  }
  out.reconsideration_id = rec ? rec.id : null;
  const { runEngine, isReady } = require('../acc/engine_registry');
  if (rec && out.new_documents > 0 && !possibleNewRequest && isReady()) {
    setImmediate(() => {
      const { classifyRecommendation } = require('../acc/pending_intake');
      R.reviewReconsideration(supabase, rec.id, { runEngine, classifyRecommendation, download, trigger: 'evidence_received' })
        .then((r) => { if (!r.ok) console.warn('[acc_intake] reconsideration review:', rec.id, r.error); })
        .catch((e) => console.error('[acc_intake] reconsideration review failed:', rec.id, e.message));
    });
  }
  return out;
}
// A reply with nothing attached: file it only on a clear match (number or thread)
// to a decided application. Returns null when it is not one.
async function fileReplyOnDecidedCase({ email: raw }) {
  const email = await hydrateIds(raw);
  const msgRef = msgRefOf(email);
  return oneAtATime(msgRef || (email && email.graph_id), async () => {
    const done = await alreadyFiled(msgRef); if (done) return done;
    const hit = await require('../acc/match_decided').findCaseByReferenceOrThread(supabase, { managementCompanyId: BEDROCK_MGMT_CO_ID, subject: email.subject, body: email.body_full || email.body_preview, conversationId: email.conversation_id, sender: email.sender_email });
    if (!hit || !hit.decided) return null;
    return fileOnDecidedCase({ hit, email });
  });
}

// Main entry. `email` is the ingested email row (has mailbox, graph_id,
// sender_email, sender_name, subject). `extracted` is Claire's classifier
// output (community_hint, addresses, person_names). Returns a status object.
// forceNew: staff said this is a new application, so it is never filed on an
// existing decided one.
async function intakeApplicationFromEmail(args) {
  const email = await hydrateIds(args.email);
  const msgRef = msgRefOf(email);
  return oneAtATime(msgRef || (email && email.graph_id), async () => {
    if (!args.forceNew) { const done = await alreadyFiled(msgRef); if (done) return done; }
    const out = await _intakeApplicationFromEmail({ ...args, email });
    if (out && ['created', 'attached'].includes(out.status)) await rememberMessage(out.application_id, msgRef);
    return out;
  });
}
async function _intakeApplicationFromEmail({ email, extracted = {}, communityId = null, sendAck = true, allowBodyOnly = false, forceNew = false }) {
  const graphId = email && email.graph_id;
  if (!graphId) return { status: 'no_graph_id' };
  const srcRef = `email:${graphId}`;
  // Idempotency now lives in createPendingAccDecision (keyed on intake_source_ref
  // against acc_decisions) — the new engine/queue store.

  // Pull the form + supporting files.
  const atts = await fetchAllAttachmentBuffers(email.mailbox, graphId);
  // Attachments that could not be fetched are recorded on the case, never
  // silently dropped (Issue #14). If the list itself failed, say so instead of
  // treating the email as having no attachments.
  const fetchErrors = (atts.failed || []).map((x) => ({ filename: x.filename, source_ref: srcRef, stage: 'fetch', error: x.error, at: new Date().toISOString() }));
  if (atts.listError && !atts.length && email.has_attachments) {
    console.error(`[acc_email_intake] attachments for ${srcRef} could not be read: ${atts.listError}`);
    return { status: 'attachments_unavailable', detail: atts.listError };
  }
  // Body-only path (Ed 2026-07-27): a homeowner emails the request in the BODY
  // (or describes the plan inline) with no PDF form attached — the leak class
  // that stranded "Patio plan…" emails. The AUTO-intake stays attachment-gated
  // (so a stray body email to annie@ can't self-file), but a STAFF click can
  // file body-only: we feed the message text to the engine as typedDetails,
  // exactly like a form-only portal application. A question that isn't really a
  // submission is caught by the human review the queue holds it for.
  // A reply about a decided application goes on that application (migration 576).
  // Checked before anything else can turn it into a new one.
  let strongHit = null;
  if (!forceNew) {
    strongHit = await require('../acc/match_decided').findCaseByReferenceOrThread(supabase, { managementCompanyId: BEDROCK_MGMT_CO_ID, subject: email.subject, body: email.body_full || email.body_preview, conversationId: email.conversation_id, sender: email.sender_email });
    if (strongHit && strongHit.open) strongHit = null;   // an open case: the open-case path below attaches it
  }
  // Some attachment is an application form this case does not already have?
  const caseHasFile = async (dec, buf) => {
    const want = require('crypto').createHash('sha256').update(buf).digest('hex');
    const { data, error } = await supabase.from('acc_decisions').select('application_pdf_storage_path, supporting_docs_storage_paths').eq('id', dec.id).maybeSingle();
    if (error || !data) return false;
    for (const p of [data.application_pdf_storage_path, ...(data.supporting_docs_storage_paths || [])].filter(Boolean)) {
      const d = await supabase.storage.from('documents').download(p);
      if (!d.error && d.data && require('crypto').createHash('sha256').update(Buffer.from(await d.data.arrayBuffer())).digest('hex') === want) return true;
    }
    return false;
  };
  const isForm = (h) => !!(h && h.property_address && h.requested_change_summary && (h.applicant_name || h.applicant_email));
  if (strongHit) {
    let newForm = false;
    const formPdf = atts.find((a) => a.isPdf);
    if (formPdf && !(await caseHasFile(strongHit.decided, formPdf.buffer))) newForm = isForm(await extractHeader(formPdf));
    // A new form in an old thread, without the case number, is a new application.
    if (!(newForm && !strongHit.matched_by.includes('reference'))) {
      try { const filed = await fileOnDecidedCase({ hit: strongHit, email, atts, possibleNewRequest: newForm }); if (filed) return { ...filed, community_id: strongHit.decided.community_id }; }
      catch (e) {
        // Before migration 576 there is nowhere to file it: hold it for a person
        // rather than create a duplicate application.
        console.error('[acc_intake] could not file on the decided application:', strongHit.decided.reference_number, e.message);
        return { status: 'decided_case', application_id: strongHit.decided.id, reference: strongHit.decided.reference_number, detail: `It is about ${strongHit.decided.reference_number || 'a decided application'}. ${e.message}` };
      }
    }
  }

  const bodyOnly = !atts.length;
  if (bodyOnly && !allowBodyOnly) return { status: 'no_attachments' }; // auto path: leave it in triage
  const bodyText = String(email.body_full || email.body_preview || '').trim();
  if (bodyOnly && !bodyText) return { status: 'no_attachments' }; // nothing to read

  const primary = atts.find((a) => a.isPdf) || atts[0];
  const header = primary ? await extractHeader(primary) : {};

  let propertyAddress = (header.property_address || (Array.isArray(extracted.addresses) && extracted.addresses[0]) || '').trim();
  // Fallback for photo-only / formless submissions that carry no address in the
  // form or body: the email was already resolved to a homeowner's property at
  // ingest, so use that so a legit submission from a known owner still converts
  // instead of stranding in triage. The pipeline still HOLDS for human review,
  // which catches a wrong guess. (Ed 2026-07-22 — "read the pictures".)
  if (!propertyAddress && email.resolved_property_id) {
    try {
      const { data: p } = await supabase.from('properties').select('street_address').eq('id', email.resolved_property_id).maybeSingle();
      if (p && p.street_address) propertyAddress = p.street_address.trim();
    } catch (_) { /* fall through to no_address */ }
  }
  // Last resort before giving up: resolve the homeowner from their email. If
  // the sender is a known owner, we already have their address — don't ask.
  let communityFromSender = null;
  if (!propertyAddress) {
    const fromSender = await addressFromSenderEmail(email, header.applicant_name);
    if (fromSender) { propertyAddress = fromSender.address; communityFromSender = fromSender.communityId; }
  }
  if (!propertyAddress) return { status: 'no_address' }; // can't run the pipeline without a property — leave for a human

  const senderExternal = !isInternalAddr(email.sender_email) && EMAIL_RE.test(email.sender_email || '');
  const submitterEmailForResolve = (header.applicant_email && EMAIL_RE.test(header.applicant_email)) ? header.applicant_email : (senderExternal ? email.sender_email : null);
  const { comm, service, propertyId } = await resolveArcTarget({
    communityId: communityId || communityFromSender, submitterEmail: submitterEmailForResolve, addressText: propertyAddress,
    communityHint: header.community_name || extracted.community_hint,
  });
  if (!comm) return { status: 'no_community' };
  // Persist what we resolved from the FORM back onto the email row, so the
  // resolution survives the message being filed (its Graph id changes and the
  // attachments can't be re-fetched). Downstream — the reply drafter, the 360,
  // the team board — then confirm the address instead of re-asking for it.
  // (Ed 2026-07-22 — Rocio's Waterview form.)
  try {
    const stamp = {};
    if (comm.id) stamp.community_id = comm.id;
    if (propertyId) stamp.resolved_property_id = propertyId;
    if (Object.keys(stamp).length && email.id) await supabase.from('email_messages').update(stamp).eq('id', email.id);
  } catch (_) { /* best-effort */ }
  if (!service) return { status: 'no_arc_service', community_id: comm.id, community_name: comm.name };

  // Applicant identity: the form's applicant email wins; else the email sender
  // (unless it's an internal forward, in which case we still create the record
  // but won't auto-email the forwarder a homeowner receipt).
  const senderIsInternal = isInternalAddr(email.sender_email);
  const applicantEmail = (header.applicant_email && EMAIL_RE.test(header.applicant_email)) ? header.applicant_email
    : (!senderIsInternal && EMAIL_RE.test(email.sender_email || '')) ? email.sender_email : null;
  const applicantName = header.applicant_name || (!senderIsInternal ? email.sender_name : null) || 'Homeowner';

  const { nextReferenceNumber } = appsPipeline();
  const prefix = (comm.name || 'APP').replace(/[^A-Z]/gi, '').slice(0, 3).toUpperCase() + '-ARC';
  let reference = null;
  try { reference = await nextReferenceNumber(comm.id, 'resident_acc', prefix); } catch (_) {}

  // Run the emailed application through the ONE shared decision engine and land
  // it in the acc_decisions queue as pending_review, carrying its drafted
  // recommendation + letter — the SAME engine + queue staff upload + portal use.
  // Only the FIRST pdf is the application form; every other file (a survey, a
  // plot plan, photos) is a supporting document the engine reads. Tagging every
  // pdf as the form meant the engine read only the first one, and a survey sent
  // with the application was reported "not submitted" (WAT-ARC-2026-0025).
  const files = require('../acc/documents').tagFilesForEngine(atts);

  // Multi-email applications (Ed 2026-07-22, hardened 2026-08-03): a homeowner
  // sends documents, we ask for more, they send the rest. If this homeowner
  // already has an OPEN application in this community, ATTACH these documents to
  // it instead of starting a duplicate — and LINK the sender's name + email onto
  // the case so the next message self-matches. The matcher scores by thread /
  // reference / any-known-email / normalized-address / name (see
  // lib/acc/match_open_application.js); the old exact-email + raw-ilike match
  // stranded the Lopez patio across three rows because she wrote from a
  // different address and the punctuation differed. Degrades to a new record if
  // migration 326/351 columns aren't applied yet.
  try {
    const { findOpenAccApplication, captureCorrespondent } = require('../acc/match_open_application');
    const openApp = await findOpenAccApplication({
      supabase, communityId: comm.id, inboundEmail: email,
      applicantEmail: applicantEmail || submitterEmailForResolve,
      applicantName: header.applicant_name || email.sender_name,
      propertyAddress,
      referenceText: [email.subject, bodyText].filter(Boolean).join(' \n '),
    });
    if (openApp) {
      const linkEmails = [applicantEmail, senderExternal ? email.sender_email : null].filter(Boolean);
      // Record who wrote in, regardless of whether there's a doc to attach — the
      // link is the point (Ed 2026-08-03: "link the names + emails to the apps").
      await captureCorrespondent(supabase, {
        decisionId: openApp.id, emails: linkEmails,
        name: header.applicant_name || (!senderIsInternal ? email.sender_name : null),
        conversationId: openApp._conversation_id, isInternalAddr,
      });

      if (Array.isArray(openApp.source_email_refs) && openApp.source_email_refs.includes(srcRef)) {
        return { status: 'exists', application_id: openApp.id, match: openApp._match_reasons };
      }
      // Body-only follow-up (nothing to attach) — already linked above; don't dupe.
      if (bodyOnly) return { status: 'exists', application_id: openApp.id, match: openApp._match_reasons };

      const { attachDocsToApplication } = require('../acc/pending_intake');
      const at = await attachDocsToApplication({ applicationId: openApp.id, files, sourceRef: srcRef, intakeErrors: fetchErrors, deferIssue: true });
      if (at.status === 'attached') {
        // Annie re-reviewed with the new documents. Her next step (a request or a
        // decision) is the reply; only when there is nothing to send yet does the
        // homeowner get "we received your additional documents" (Ed 2026-11-26).
        let answered = false;
        try { const nx = await require('../acc/annie_issue').issueIfReady(supabase, openApp.id, { source: 'documents_received' }); answered = !!(nx.requested_info || (nx.issued && nx.email_sent)); }
        catch (e) { console.warn('[acc_email_intake] next step after new documents failed:', e.message); }
        if (!answered && sendAck && applicantEmail) {
          try { await sendAcknowledgment({ to: applicantEmail, applicantName, communityName: comm.name, communityId: comm.id, reference: 'your application', address: propertyAddress, additional: true, sourceEmailRef: srcRef, relatedType: 'acc_decision', relatedId: openApp.id }); } catch (_) {}
        }
        return { status: 'attached', application_id: openApp.id, added: at.added, match: openApp._match_reasons };
      }
      // attach failed (e.g. migration 326 not applied) — fall through to create.
    }
  } catch (e) { console.warn('[acc_email_intake] open-app match/link skipped:', e.message); }

  // No open case, no form, a known correspondent, and exactly one recent decision at
  // this property: more evidence for that decision, not a new application.
  if (!forceNew && !bodyOnly && !isForm(header)) {
    const weak = await require('../acc/match_decided').findDecidedByEmailAndAddress(supabase, { communityId: comm.id, emails: [applicantEmail, senderExternal ? email.sender_email : null].filter(Boolean), address: propertyAddress });
    if (weak) {
      try { const filed = await fileOnDecidedCase({ hit: weak, email, atts }); if (filed) return { ...filed, community_id: comm.id, community_name: comm.name }; }
      catch (e) { if (!e.missing576) throw e; console.warn('[acc_intake] evidence not filed (migration 576 not applied); continuing as a new application:', e.message); }
    }
  }

  // Body-only: hand the email text to the engine where a form's PDF would go.
  const typedDetails = bodyOnly
    ? `HOMEOWNER EMAIL — no application form was attached; treat this message as the architectural request itself.\nSubject: ${email.subject || ''}\nFrom: ${email.sender_name || email.sender_email || ''}\nProperty: ${propertyAddress || '(see body)'}\n\n${bodyText.slice(0, 6000)}`
    : null;

  // Received = when the HOMEOWNER submitted it: a property manager's forward
  // carries the original send time in its quoted header (Ed 2026-11-26,
  // lib/acc/received_date). Never the forward time or our processing time.
  const received = require('../acc/received_date').originalReceivedAt({ subject: email.subject, body: email.body_full || email.body_preview, receivedAt: email.received_at });

  const { createPendingAccDecision } = require('../acc/pending_intake');
  const pend = await createPendingAccDecision({
    community: comm.name, communityId: comm.id, files,
    submitterEmail: applicantEmail, submitterName: applicantName,
    source: 'email', intakeSourceRef: srcRef, propertyAddress, reference,
    typedDetails, intakeErrors: fetchErrors,
    receivedAt: received.at, receivedAtBasis: received.basis,
    // The receipt goes first; Annie's next step (a request for information or
    // her decision) runs after it, below.
    deferIssue: true,
  });
  if (pend.status === 'exists') return { status: 'exists', application_id: pend.id };
  if (pend.status !== 'created') return { status: pend.status === 'skipped' ? (pend.reason || 'skipped') : (pend.status || 'engine_failed'), detail: pend.error };

  // Seed the link on the NEW case: record the sender's email + the Graph
  // conversation, so a follow-up in this thread (or from this address) attaches
  // to THIS case instead of spawning another (Ed 2026-08-03). Best-effort.
  try {
    const { captureCorrespondent } = require('../acc/match_open_application');
    await captureCorrespondent(supabase, {
      decisionId: pend.id,
      emails: [applicantEmail, senderExternal ? email.sender_email : null].filter(Boolean),
      name: header.applicant_name || (!senderIsInternal ? email.sender_name : null),
      conversationId: email.conversation_id || null,
      isInternalAddr,
    });
  } catch (e) { console.warn('[acc_email_intake] correspondent link (create) skipped:', e.message); }

  // Acknowledge the homeowner. Send to the form's applicant address AND the
  // person who actually emailed it in (deduped, external only).
  //
  // Scar (Ed 2026-07-15): WAT-ARC-2026-0003 was acknowledged only to
  // "Tamjtrmb@gmail.com" — an address AI-extracted off the application form —
  // which bounced 550 NoSuchUser. The homeowner had emailed the application from
  // a perfectly good address, but because the FORM's email wins for applicant
  // identity (correct for identity), we never wrote to the one address we KNEW
  // worked. Worse, the receipt was still logged triage_status='handled', so the
  // books said "acknowledged" while the homeowner got nothing. A parsed string
  // is a guess; the sender's address is a fact — write to both.
  // ONE coordinated first message (Ed 2026-11-26, lib/acc/first_contact). Annie
  // has already reviewed it: when her outcome is ready, the homeowner gets one
  // email that confirms receipt and gives the outcome; when the decision belongs
  // to someone else the receipt goes now (the review may take longer); otherwise
  // the receipt waits for the 30-minute window. Recipients: the form's applicant
  // AND the address that actually emailed it in (captured on the case above).
  // Scar (Ed 2026-07-15): WAT-ARC-2026-0003 was acknowledged only to an address
  // AI-extracted off the form, which bounced; the sender's address is a fact.
  const hasRecipient = [applicantEmail, senderExternal ? email.sender_email : null]
    .some((a) => a && EMAIL_RE.test(String(a).trim()) && !isInternalAddr(String(a).trim()));
  let ackError = null;
  const ackQueued = false;
  let ackSent = false;
  let firstContact = null;
  if (sendAck && hasRecipient) {
    try { firstContact = await require('../acc/first_contact').respondToApplication(supabase, pend.id, { source: 'intake' }); }
    catch (e) { firstContact = { outcome: 'error', detail: e.message }; }
    ackSent = ['combined', 'receipt', 'already'].includes(firstContact.outcome);
    if (firstContact.outcome === 'deferred') ackError = `Receipt scheduled: Annie sends it by ${new Date(firstContact.due_at).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })} Central unless her response goes first`;
    else if (!ackSent) ackError = `No receipt yet: ${firstContact.detail || 'not sent'}`;
  } else {
    if (sendAck) ackError = 'no external applicant address on the application or the email';
    // Nothing to coordinate with a receipt: Annie's next step still runs.
    require('../acc/annie_issue').issueIfReadySoon(supabase, pend.id, { source: 'intake' });
  }

  // A receipt that hasn't reached the homeowner must be RECORDED, never shrugged
  // off (scar, Ed 2026-07-15): the queue shows the homeowner has not heard yet.
  if (!ackSent && ackError) {
    try { await supabase.from('acc_decisions').update({ acknowledgment_error: ackError }).eq('id', pend.id).is('acknowledged_at', null); }
    catch (e) { console.warn('[acc_email_intake] ack stamp skipped (migration 298 not applied?):', e.message); }
  }
  if (ackError && !(firstContact && firstContact.outcome === 'deferred')) console.error(`[acc_email_intake] NO RECEIPT for ${reference} (${propertyAddress}): ${ackError}`);

  return {
    status: 'created', application_id: pend.id, reference, community_id: comm.id, community_name: comm.name,
    ai_recommendation: pend.ai_recommendation, submitter_email: applicantEmail,
    acknowledgment_sent: ackSent, acknowledgment_queued: ackQueued, acknowledgment_error: ackError, first_contact: firstContact, received_at: received.at, received_at_basis: received.basis,
  };
}

// Read the actual application a homeowner attached, BEFORE anyone asks them for
// anything. Reads the ARC form (and resolves the property/community from what's
// ON the form — address first, then applicant email/name), so a reply confirms
// their details instead of asking for what they already sent. (Ed 2026-07-22 —
// Rocio Munoz attached a complete Waterview ARC form with her address on it and
// we asked her for the address anyway. "makes us look dumb.")
async function readAccApplicationContext(email) {
  if (!email || !email.graph_id || !email.mailbox) return null;
  let atts = [];
  try { atts = await fetchAllAttachmentBuffers(email.mailbox, email.graph_id); } catch (_) { return null; }
  if (!atts.length) return null;
  const primary = atts.find((a) => a.isPdf) || atts[0];
  const header = await extractHeader(primary);
  if (!header || (!header.property_address && !header.applicant_name && !header.community_name)) return null;
  // Resolve community/property from what the FORM says — the address is the
  // strongest signal, then the applicant's email, then their name.
  let community_id = null, property_id = null, community_name = header.community_name || null;
  if (header.property_address) {
    const p = await propertyFromAddress(header.property_address);
    if (p) { property_id = p.property_id; community_id = p.community_id; }
  }
  if (!community_id && header.applicant_email && EMAIL_RE.test(header.applicant_email)) {
    const p = await propertyFromEmail(header.applicant_email);
    if (p) { property_id = property_id || p.property_id; community_id = p.community_id; }
  }
  if (!community_id && header.applicant_name) {
    const fromName = await addressFromSenderEmail({ sender_email: null }, header.applicant_name);
    if (fromName && fromName.communityId) { community_id = fromName.communityId; if (!header.property_address) header.property_address = fromName.address; }
  }
  if (community_id && !community_name) {
    try { const { data: cm } = await supabase.from('communities').select('name').eq('id', community_id).maybeSingle(); if (cm) community_name = cm.name; } catch (_) {}
  }
  return {
    applicant_name: header.applicant_name || null,
    applicant_email: header.applicant_email || null,
    applicant_phone: header.applicant_phone || null,
    property_address: header.property_address || null,
    community_name, community_id, property_id,
    requested_change_summary: header.requested_change_summary || null,
    attachment_count: atts.length,
  };
}

module.exports = { intakeApplicationFromEmail, fileReplyOnDecidedCase, readAccApplicationContext };
