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

// Resolve the community + its 'arc' service. Prefer the id Claire already
// resolved; fall back to the community name Claire pulled, then the address.
async function resolveArcCommunity({ communityId, communityHint, addressText }) {
  let comm = null;
  if (communityId) {
    const { data } = await supabase.from('communities').select('id, name').eq('id', communityId).maybeSingle();
    if (data) comm = data;
  }
  if (!comm && communityHint) {
    const { data } = await supabase.from('communities').select('id, name')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID).ilike('name', `%${communityHint}%`).limit(1);
    if (data && data.length) comm = data[0];
  }
  if (!comm) return { comm: null, service: null };
  const { data: service } = await supabase.from('community_services')
    .select('id, service_type, application_fee_usd, paid_by')
    .eq('community_id', comm.id).eq('service_type', 'arc').maybeSingle();
  return { comm, service: service || null };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
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
async function intakeApplicationFromEmail({ email, extracted = {}, communityId = null }) {
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

  const { comm, service } = await resolveArcCommunity({
    communityId, communityHint: header.community_name || extracted.community_hint, addressText: propertyAddress,
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
  const reference = await nextReferenceNumber(comm.id, 'arc', prefix);

  // Roster match (flag only).
  let propertyAddressId = null;
  try {
    if (normalizeAddress(propertyAddress)) {
      const { data: addr } = await supabase.from('community_addresses').select('id')
        .eq('community_id', comm.id).ilike('address', `%${propertyAddress.split(' ')[0]}%`).limit(1).maybeSingle();
      if (addr) propertyAddressId = addr.id;
    }
  } catch (_) {}

  const applicationData = {
    source: 'email',
    email_subject: email.subject || null,
    email_from: email.sender_email || null,
    requested_change_summary: header.requested_change_summary || extracted.requested_action || null,
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
  if (applicantEmail && !isInternalAddr(applicantEmail)) {
    acknowledgedFrom = await sendAcknowledgment({ to: applicantEmail, applicantName, communityName: comm.name, reference, address: propertyAddress });
  }

  return {
    status: 'created', application_id: app.id, reference, community_id: comm.id, community_name: comm.name,
    submitter_email: applicantEmail, acknowledged_from: acknowledgedFrom, completeness_passed: completeness.passed,
  };
}

module.exports = { intakeApplicationFromEmail };
