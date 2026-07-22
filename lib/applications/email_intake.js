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
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const graphSend = require('../email/graph_send');
const { fetchAllAttachmentBuffers } = require('../email/graph_attachments');
const { checkCompleteness } = require('./completeness');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

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
      model: 'claude-sonnet-4-5', max_tokens: 700,
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
async function sendAcknowledgment({ to, applicantName, communityName, reference, address, additional = false }) {
  // `to` may be a comma-separated LIST (the form's applicant + the address that
  // actually emailed us). EMAIL_RE is a SINGLE-address regex (^...$, no spaces),
  // so testing the joined string against it returns null for every multi-
  // recipient ack — silently sending nobody a receipt. Validate each address.
  const recips = String(to || '').split(',').map((x) => x.trim()).filter((x) => EMAIL_RE.test(x));
  // Ed holds all automated outbound for now. The application still loads, gets
  // AI-reviewed and queued — only the receipt is held, and it's recorded as held
  // (not silently dropped) so the ACC queue shows the homeowner hasn't heard.
  if (!graphSend.autoSendEnabled()) return { error: 'automated outbound is OFF — receipt held for your release (set AUTO_OUTBOUND_EMAIL=on to resume)' };
  if (!graphSend.isConfigured()) return { error: 'email not connected (Graph credentials missing)' };
  if (!recips.length) return { error: `no valid applicant address to acknowledge (got "${String(to || '').slice(0, 80)}")` };
  const toLine = recips.join(', ');
  const first = (applicantName || '').trim().split(/\s+/)[0] || 'there';
  const subject = additional
    ? `We received your additional documents${reference && reference !== 'your application' ? ' (' + reference + ')' : ''}`
    : `We received your architectural application${reference ? ' (' + reference + ')' : ''}`;
  const html = additional
    ? `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a2230;">
    <p>Hi ${first},</p>
    <p>This is Annie with Bedrock Association Management${communityName ? ', architectural review coordinator for ' + communityName : ''}. Thank you — we have received your additional documents${address ? ' for ' + address : ''} and added them to your application. It remains under review, and we will follow up with the decision.</p>
    <p>Thank you,<br>Annie Reeves<br>Architectural Review Coordinator<br>Bedrock Association Management</p>
  </div>`
    : `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a2230;">
    <p>Hi ${first},</p>
    <p>This is Annie with Bedrock Association Management, the architectural review coordinator${communityName ? ' for ' + communityName : ''}. We have received your architectural review application${address ? ' for ' + address : ''} and it is now under review.</p>
    ${reference ? `<p>Your reference number is <b>${reference}</b>. Please keep it for your records.</p>` : ''}
    <p>The committee will review the request and we will follow up with the decision. If we need anything else to complete the review, we will reach out.</p>
    <p>Thank you,<br>Annie Reeves<br>Architectural Review Coordinator<br>Bedrock Association Management</p>
  </div>`;
  let lastErr = null;
  for (const from of [graphSend.ANNIE_MAILBOX, graphSend.CLAIRE_MAILBOX]) {
    try { await graphSend.sendAs({ from, to: toLine, subject, html }); return { from, to: recips }; }
    catch (e) { lastErr = e.message; console.warn(`[acc_email_intake] ack send as ${from} failed:`, e.message); }
  }
  return { error: `send failed from both ${graphSend.ANNIE_MAILBOX} and ${graphSend.CLAIRE_MAILBOX}: ${lastErr || 'unknown'}` };
}

// Main entry. `email` is the ingested email row (has mailbox, graph_id,
// sender_email, sender_name, subject). `extracted` is Claire's classifier
// output (community_hint, addresses, person_names). Returns a status object.
async function intakeApplicationFromEmail({ email, extracted = {}, communityId = null, sendAck = true }) {
  const graphId = email && email.graph_id;
  if (!graphId) return { status: 'no_graph_id' };
  const srcRef = `email:${graphId}`;
  // Idempotency now lives in createPendingAccDecision (keyed on intake_source_ref
  // against acc_decisions) — the new engine/queue store.

  // Pull the form + supporting files.
  const atts = await fetchAllAttachmentBuffers(email.mailbox, graphId);
  if (!atts.length) return { status: 'no_attachments' }; // an ACC question, not a submission — leave it in triage

  const primary = atts.find((a) => a.isPdf) || atts[0];
  const header = await extractHeader(primary);

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
  if (!propertyAddress) return { status: 'no_address' }; // can't run the pipeline without a property — leave for a human

  const senderExternal = !isInternalAddr(email.sender_email) && EMAIL_RE.test(email.sender_email || '');
  const submitterEmailForResolve = (header.applicant_email && EMAIL_RE.test(header.applicant_email)) ? header.applicant_email : (senderExternal ? email.sender_email : null);
  const { comm, service, propertyId } = await resolveArcTarget({
    communityId, submitterEmail: submitterEmailForResolve, addressText: propertyAddress,
    communityHint: header.community_name || extracted.community_hint,
  });
  if (!comm) return { status: 'no_community' };
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
  const files = atts.map((a) => ({ fieldname: a.isPdf ? 'pdf' : 'images', buffer: a.buffer, mimetype: a.contentType, originalname: a.filename }));

  // Multi-email applications (Ed 2026-07-22): a homeowner sends documents, we ask
  // for more, they send the rest. If this homeowner already has an OPEN
  // application in this community (pending_review / awaiting_info), ATTACH these
  // documents to it instead of starting a duplicate. Match on submitter email
  // first, then property address. Degrades to a new record if migration 326 (the
  // status/columns) isn't applied yet.
  try {
    const emailForMatch = String(applicantEmail || submitterEmailForResolve || '').toLowerCase();
    let openApp = null;
    if (emailForMatch) {
      const { data } = await supabase.from('acc_decisions')
        .select('id, source_email_refs')
        .eq('community_id', comm.id).in('status', ['pending_review', 'awaiting_info'])
        .ilike('submitter_email', emailForMatch).order('created_at', { ascending: false }).limit(1);
      if (data && data.length) openApp = data[0];
    }
    if (!openApp && propertyAddress) {
      const { data } = await supabase.from('acc_decisions')
        .select('id, source_email_refs')
        .eq('community_id', comm.id).in('status', ['pending_review', 'awaiting_info'])
        .ilike('homeowner_address', propertyAddress).order('created_at', { ascending: false }).limit(1);
      if (data && data.length) openApp = data[0];
    }
    if (openApp) {
      if (Array.isArray(openApp.source_email_refs) && openApp.source_email_refs.includes(srcRef)) {
        return { status: 'exists', application_id: openApp.id };
      }
      const { attachDocsToApplication } = require('../acc/pending_intake');
      const at = await attachDocsToApplication({ applicationId: openApp.id, files, sourceRef: srcRef });
      if (at.status === 'attached') {
        if (sendAck && applicantEmail) {
          try { await sendAcknowledgment({ to: applicantEmail, applicantName, communityName: comm.name, reference: 'your application', address: propertyAddress, additional: true }); } catch (_) {}
        }
        return { status: 'attached', application_id: openApp.id, added: at.added };
      }
      // attach failed (e.g. migration 326 not applied) — fall through to create.
    }
  } catch (_) { /* no open-application match / column not there yet — create new */ }

  const { createPendingAccDecision } = require('../acc/pending_intake');
  const pend = await createPendingAccDecision({
    community: comm.name, communityId: comm.id, files,
    submitterEmail: applicantEmail, submitterName: applicantName,
    source: 'email', intakeSourceRef: srcRef, propertyAddress, reference,
  });
  if (pend.status === 'exists') return { status: 'exists', application_id: pend.id };
  if (pend.status !== 'created') return { status: pend.status === 'skipped' ? (pend.reason || 'skipped') : (pend.status || 'engine_failed'), detail: pend.error };

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
  let acknowledgedFrom = null;
  const ackTo = [...new Set(
    [applicantEmail, senderExternal ? email.sender_email : null]
      .filter((a) => a && EMAIL_RE.test(String(a).trim()) && !isInternalAddr(String(a).trim()))
      .map((a) => String(a).trim())
  )];
  let ackError = null;
  if (sendAck && ackTo.length) {
    const ackRes = await sendAcknowledgment({ to: ackTo.join(', '), applicantName, communityName: comm.name, reference, address: propertyAddress });
    acknowledgedFrom = ackRes && ackRes.from ? ackRes.from : null;
    ackError = ackRes && ackRes.error ? ackRes.error : null;
    // Log Annie's receipt as an outbound message so it shows on the team board.
    if (acknowledgedFrom) {
      try {
        await supabase.from('email_messages').insert({
          mailbox: acknowledgedFrom, direction: 'outbound', sender_email: acknowledgedFrom,
          sender_name: 'Annie Reeves (Bedrock AI)', recipients: ackTo,
          subject: `We received your architectural application (${reference})`,
          body_preview: `Acknowledged ${applicantName}'s ARC application for ${propertyAddress}. Reference ${reference}.`,
          classification: 'outbound_reply', classification_confidence: 'high', persona: 'annie',
          ai_summary: `Annie acknowledged the ARC application for ${propertyAddress}`,
          community_id: comm.id, triage_status: 'handled', record_ownership: 'association_record',
          reviewed_at: new Date().toISOString(),
        });
      } catch (e) { console.warn('[acc_email_intake] ack log skipped:', e.message); }
    }
  } else if (sendAck) {
    ackError = 'no external applicant address on the application or the email';
  }

  // A receipt that did NOT go out must be RECORDED, never shrugged off.
  // Scar (Ed 2026-07-15): five ARC applications (7/13) were created, AI-reviewed,
  // and queued — and every applicant heard nothing, because the ack send failed
  // and this function just moved on. `return null` on failure + no else branch =
  // the homeowner is waiting, the queue looks healthy, and nobody knows. Stamp it
  // on the application so the ACC queue can show "receipt NOT delivered".
  try {
    await supabase.from('acc_decisions').update({
      acknowledged_at: acknowledgedFrom ? new Date().toISOString() : null,
      acknowledged_to: acknowledgedFrom ? ackTo.join(', ') : null,
      acknowledgment_error: ackError,
    }).eq('id', pend.id);
  } catch (e) { console.warn('[acc_email_intake] ack stamp skipped (migration 298 not applied?):', e.message); }
  if (ackError) console.error(`[acc_email_intake] NO RECEIPT SENT for ${reference} (${propertyAddress}): ${ackError}`);

  return {
    status: 'created', application_id: pend.id, reference, community_id: comm.id, community_name: comm.name,
    ai_recommendation: pend.ai_recommendation, submitter_email: applicantEmail,
    acknowledged_from: acknowledgedFrom, acknowledgment_error: ackError,
  };
}

module.exports = { intakeApplicationFromEmail };
