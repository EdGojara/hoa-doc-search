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
async function sendAcknowledgment({ to, applicantName, communityName, reference, address }) {
  if (!graphSend.isConfigured() || !to || !EMAIL_RE.test(to)) return null;
  const first = (applicantName || '').trim().split(/\s+/)[0] || 'there';
  const subject = `We received your architectural application${reference ? ' (' + reference + ')' : ''}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a2230;">
    <p>Hi ${first},</p>
    <p>This is Annie with Bedrock Association Management, the architectural review coordinator${communityName ? ' for ' + communityName : ''}. We have received your architectural review application${address ? ' for ' + address : ''} and it is now under review.</p>
    ${reference ? `<p>Your reference number is <b>${reference}</b>. Please keep it for your records.</p>` : ''}
    <p>The committee will review the request and we will follow up with the decision. If we need anything else to complete the review, we will reach out.</p>
    <p>Thank you,<br>Annie Reeves<br>Architectural Review Coordinator<br>Bedrock Association Management</p>
  </div>`;
  for (const from of [graphSend.ANNIE_MAILBOX, graphSend.CLAIRE_MAILBOX]) {
    try { await graphSend.sendAs({ from, to, subject, html }); return from; }
    catch (e) { console.warn(`[acc_email_intake] ack send as ${from} failed:`, e.message); }
  }
  return null;
}

// Main entry. `email` is the ingested email row (has mailbox, graph_id,
// sender_email, sender_name, subject). `extracted` is Claire's classifier
// output (community_hint, addresses, person_names). Returns a status object.
async function intakeApplicationFromEmail({ email, extracted = {}, communityId = null, sendAck = true }) {
  const graphId = email && email.graph_id;
  if (!graphId) return { status: 'no_graph_id' };
  const srcRef = `email:${graphId}`;

  // Idempotency — already intook this email?
  const { data: existing } = await supabase.from('community_applications')
    .select('id, reference_number').eq('intake_source_ref', srcRef).limit(1);
  if (existing && existing.length) return { status: 'exists', application_id: existing[0].id, reference: existing[0].reference_number };

  // Pull the form + supporting files.
  const atts = await fetchAllAttachmentBuffers(email.mailbox, graphId);
  if (!atts.length) return { status: 'no_attachments' }; // an ACC question, not a submission — leave it in triage

  const primary = atts.find((a) => a.isPdf) || atts[0];
  const header = await extractHeader(primary);

  const propertyAddress = (header.property_address || (Array.isArray(extracted.addresses) && extracted.addresses[0]) || '').trim();
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

  const { nextReferenceNumber, normalizeAddress, runAssessment } = appsPipeline();
  const prefix = (comm.name || 'APP').replace(/[^A-Z]/gi, '').slice(0, 3).toUpperCase() + '-ARC';
  // Counter service_type must be one migration 218's constraint allows
  // ('resident_acc'); the application row itself stays service_type='arc'.
  const reference = await nextReferenceNumber(comm.id, 'resident_acc', prefix);

  // Roster match (flag only).
  let propertyAddressId = null;
  try {
    if (normalizeAddress(propertyAddress)) {
      const { data: addr } = await supabase.from('community_addresses').select('id')
        .eq('community_id', comm.id).ilike('address', `%${propertyAddress.split(' ')[0]}%`).limit(1).maybeSingle();
      if (addr) propertyAddressId = addr.id;
    }
  } catch (_) {}

  const description = header.requested_change_summary || extracted.requested_action || email.subject || null;
  const applicationData = {
    source: 'email',
    email_subject: email.subject || null,
    email_from: email.sender_email || null,
    requested_change_summary: description,
    description, // completeness reads `description`
    project_description: description, // the AI assessment prompt reads `project_description`
    signature: {
      signed_by_name: applicantName,
      signed_at: email.received_at || new Date().toISOString(),
      agreed_to_indemnification: null,
      note: 'Submitted by email. Signature/indemnification is on the attached application form — reviewer to confirm before finalizing.',
    },
  };

  const insert = {
    management_company_id: BEDROCK_MGMT_CO_ID,
    community_id: comm.id,
    community_service_id: service.id,
    reference_number: reference,
    service_type: 'arc',
    submitter_name: applicantName,
    submitter_email: applicantEmail,
    submitter_phone: header.applicant_phone || null,
    property_address: propertyAddress,
    property_address_id: propertyAddressId,
    application_data: applicationData,
    final_status: 'pending_committee_review',
    submitted_at: new Date().toISOString(),
    payment_status: (service.paid_by === 'owner' && service.application_fee_usd != null) ? 'pending' : 'not_required',
    calculated_fee_usd: (service.paid_by === 'owner' && service.application_fee_usd != null) ? Number(service.application_fee_usd) : null,
    intake_method: 'email',
    intake_source_ref: srcRef,
  };

  let app;
  try {
    const { data, error } = await supabase.from('community_applications').insert(insert).select().single();
    if (error) {
      // Unique-violation on the source ref = a concurrent pull already made it.
      if (String(error.code) === '23505') return { status: 'exists' };
      throw error;
    }
    app = data;
  } catch (e) { console.error('[acc_email_intake] insert failed:', e.message); return { status: 'error', error: e.message }; }

  // Save each attachment to storage + index it.
  for (const a of atts) {
    try {
      const safeName = (a.filename || 'upload').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'upload';
      const storagePath = `applications/${app.id}/${Date.now()}_${safeName}`;
      const { error: stErr } = await supabase.storage.from('documents').upload(storagePath, a.buffer, { contentType: a.contentType, upsert: false });
      if (stErr) { console.warn('[acc_email_intake] file upload failed:', stErr.message); continue; }
      await supabase.from('application_attachments').insert({
        application_id: app.id,
        attachment_type: a.isPdf ? 'site_plan' : 'photo_current',
        file_path: storagePath, original_filename: a.filename,
        file_size_bytes: a.buffer.length, file_mime_type: a.contentType,
      });
    } catch (e) { console.warn('[acc_email_intake] attachment record failed:', e.message); }
  }

  // Completeness + internal AI assessment (workpaper; never auto-sent).
  let completeness = { passed: false, issues: [], message: '' };
  try {
    const { data: attachmentRows } = await supabase.from('application_attachments')
      .select('id, attachment_type, original_filename, file_mime_type').eq('application_id', app.id);
    completeness = checkCompleteness({
      service_type: app.service_type, application_data: applicationData,
      attachments: (attachmentRows || []).map((r) => ({ id: r.id, name: r.original_filename, kind: r.attachment_type, mime: r.file_mime_type })),
    });
    const stagedStatus = completeness.passed ? 'pending_review' : 'incomplete';
    await supabase.from('community_applications').update({
      completeness_passed: completeness.passed, completeness_checked_at: new Date().toISOString(),
      completeness_issues: completeness.issues, completeness_message: completeness.message, final_status: stagedStatus,
    }).eq('id', app.id);
    if (completeness.passed) {
      try { await runAssessment(app, { triggerSource: 'email_intake' }); }
      catch (e) { console.warn('[acc_email_intake] assessment failed (non-fatal):', e.message); }
    }
  } catch (e) { console.warn('[acc_email_intake] completeness/assessment skipped:', e.message); }

  // Acknowledge the homeowner (only when we have a real external applicant addr).
  let acknowledgedFrom = null;
  if (sendAck && applicantEmail && !isInternalAddr(applicantEmail)) {
    acknowledgedFrom = await sendAcknowledgment({ to: applicantEmail, applicantName, communityName: comm.name, reference, address: propertyAddress });
    // Log Annie's receipt as an outbound message so it shows on the team board.
    if (acknowledgedFrom) {
      try {
        await supabase.from('email_messages').insert({
          mailbox: acknowledgedFrom, direction: 'outbound', sender_email: acknowledgedFrom,
          sender_name: 'Annie Reeves (Bedrock AI)', recipients: [applicantEmail],
          subject: `We received your architectural application (${reference})`,
          body_preview: `Acknowledged ${applicantName}'s ARC application for ${propertyAddress}. Reference ${reference}.`,
          classification: 'outbound_reply', classification_confidence: 'high', persona: 'annie',
          ai_summary: `Annie acknowledged the ARC application for ${propertyAddress}`,
          community_id: comm.id, triage_status: 'handled', record_ownership: 'association_record',
          reviewed_at: new Date().toISOString(),
        });
      } catch (e) { console.warn('[acc_email_intake] ack log skipped:', e.message); }
    }
  }

  return {
    status: 'created', application_id: app.id, reference, community_id: comm.id, community_name: comm.name,
    submitter_email: applicantEmail, acknowledged_from: acknowledgedFrom, completeness_passed: completeness.passed,
  };
}

module.exports = { intakeApplicationFromEmail };
