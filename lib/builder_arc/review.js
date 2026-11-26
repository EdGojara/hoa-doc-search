// ============================================================================
// lib/builder_arc/review.js  (Ed 2026-11-25)
// ----------------------------------------------------------------------------
// Annie's builder lot review, end to end, for one application:
//   1. read the whole packet (lib/builder_arc/packet.js)
//   2. load the community's standards and every other submission in the
//      community (the streetscape) and earlier decisions at this address
//   3. evaluate (lib/builder_arc/rules.js): findings + recommendation
//   4. apply only VERIFIED corrections: a blank / "UNKNOWN" lot, block,
//      section, plan or elevation that the packet shows unambiguously (both
//      reads agree, or the only read), and the plan name from the linked
//      approved master plan. A value that conflicts is never overwritten.
//   5. record the review (builder_application_assessments, append-only; the
//      latest row is canonical) and its snapshot on the application
//   6. refresh the application's work item (owner, deadline, next step)
//
// Annie recommends; she never decides (builder decisions are Ed's). Called on
// intake events (packet attached) and on demand. Kill switch:
// BUILDER_ARC_ANNIE_REVIEW=false.
// ============================================================================
const { readPacket } = require('./packet');
const { evaluate, draftInfoRequest, parseAddress } = require('./rules');
const { loadStandards } = require('./standards');
const { upsertWorkItem, clockFacts, deadlinesFor } = require('./tracking');
const { validateApplicationForLetter } = require('../builder_letter_validate');

const enabled = () => String(process.env.BUILDER_ARC_ANNIE_REVIEW || 'true').toLowerCase() !== 'false';
const RUN_BY = 'annie';

const APP_COLS = 'id, community_id, builder_company_id, master_plan_id, reference_number, submitter_name, submitter_email, source, lot_number, block_number, section_number, street_address, plan_number, plan_name, elevation, elevation_orientation, application_data, status, fast_track, submitted_at, decided_at, decided_by, assessment_recommended_action';

async function latestPacket(supabase, appId) {
  const { data, error } = await supabase.from('builder_application_attachments')
    .select('id, kind, original_filename, storage_bucket, storage_path, uploaded_at').eq('application_id', appId)
    .order('uploaded_at', { ascending: false }).limit(20);
  if (error) throw error;
  const pdfs = (data || []).filter((a) => /\.pdf$/i.test(a.original_filename || a.storage_path || ''));
  return pdfs.find((a) => a.kind === 'submission_packet') || pdfs.find((a) => a.kind === 'plot_plan') || pdfs[0] || null;
}

async function download(supabase, att) {
  const { data, error } = await supabase.storage.from(att.storage_bucket || 'documents').download(att.storage_path);
  if (error) throw new Error(`packet download failed: ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}

async function matchMasterPlan(supabase, app) {
  if (!app.builder_company_id || !app.plan_number || !app.elevation) return null;
  const { data, error } = await supabase.from('master_plans')
    .select('id, plan_number, plan_name, elevation, status, master_plan_community_approvals!inner(community_id, retired_at)')
    .eq('builder_company_id', app.builder_company_id).eq('plan_number', app.plan_number).eq('elevation', app.elevation)
    .eq('status', 'approved').eq('master_plan_community_approvals.community_id', app.community_id)
    .is('master_plan_community_approvals.retired_at', null).limit(1);
  if (error) throw error;
  return data[0] || null;
}

async function linkedPlan(supabase, app) {
  if (!app.master_plan_id) return { plan: null, approvedAt: null };
  const { data: p, error } = await supabase.from('master_plans').select('id, plan_number, plan_name, elevation, status').eq('id', app.master_plan_id).maybeSingle();
  if (error) throw error;
  if (!p) return { plan: null, approvedAt: null };
  const { data: a, error: ae } = await supabase.from('master_plan_community_approvals').select('retired_at').eq('master_plan_id', p.id).eq('community_id', app.community_id).maybeSingle();
  if (ae) throw ae;
  return { plan: p, approvedAt: !!(a && !a.retired_at) };
}

async function communityApps(supabase, communityId) {
  const { fetchAllQuery } = require('../db/fetch_all');
  return fetchAllQuery(() => supabase.from('builder_applications')
    .select('id, reference_number, street_address, lot_number, block_number, plan_number, elevation, application_data, status, submitted_at, decided_at')
    .eq('community_id', communityId));
}

/**
 * @param {object} supabase
 * @param {string} applicationId
 * @param {object} opts { apply = true, useModel = true, packetOverride (Buffer), now }
 * @returns {object} { application, result, corrections_applied, assessment_id, work_item, packet }
 */
async function runReview(supabase, applicationId, opts = {}) {
  const apply = opts.apply !== false;
  const { data: app, error } = await supabase.from('builder_applications').select(APP_COLS).eq('id', applicationId).maybeSingle();
  if (error) throw error;
  if (!app) throw Object.assign(new Error('application not found'), { statusCode: 404 });

  const { community, standards } = await loadStandards(supabase, app.community_id);

  // 1. Packet
  let packet = null; let packetAtt = null;
  try {
    packetAtt = await latestPacket(supabase, app.id);
    if (packetAtt || opts.packetOverride) {
      const buf = opts.packetOverride || await download(supabase, packetAtt);
      packet = await readPacket(buf, { useModel: opts.useModel !== false, client: opts.client });
    }
  } catch (e) {
    console.warn('[builder_arc.review] packet read failed:', e.message);
    packet = { facts: null, errors: [e.message] };
  }

  // 2. Streetscape + history
  const all = await communityApps(supabase, app.community_id);
  const addrKey = (a) => { const p = parseAddress(a); return `${p.number}|${p.street}`; };
  const priorAtAddress = all.filter((o) => o.id !== app.id && addrKey(o.street_address) === addrKey(app.street_address) && o.decided_at && new Date(o.submitted_at) < new Date(app.submitted_at));
  const neighbors = all.filter((o) => o.id !== app.id);
  const facts = (await clockFacts(supabase, [app])).get(app.id);
  let deadlines = deadlinesFor(app, community, standards, facts, opts.now);

  // 3a. First pass: which blank fields can the packet fill?
  const pass1 = evaluate({ app, packet, standards, neighbors, priorAtAddress, letterCheck: null, deadlines });
  const corrected = { ...app, ...pass1.corrections };

  // 3b. Plan link + plan name from the approved master plan (verified record).
  let plan = null; let approvedAt = null; const linkChanges = {};
  if (!corrected.master_plan_id || pass1.corrections.plan_number || pass1.corrections.elevation) {
    const mp = await matchMasterPlan(supabase, corrected);
    if (mp && mp.id !== corrected.master_plan_id) { linkChanges.master_plan_id = mp.id; linkChanges.fast_track = true; corrected.master_plan_id = mp.id; corrected.fast_track = true; }
  }
  ({ plan, approvedAt } = await linkedPlan(supabase, corrected));
  if (plan && (!corrected.plan_name || /^unknown$/i.test(String(corrected.plan_name).trim())) && plan.plan_name && String(plan.plan_number).toUpperCase() === String(corrected.plan_number).toUpperCase()) {
    linkChanges.plan_name = plan.plan_name; corrected.plan_name = plan.plan_name;
  }
  const letterCheck = validateApplicationForLetter(corrected, plan, approvedAt);

  // 3c. Final evaluation on the corrected record.
  // Deadlines follow the new review (an incomplete application starts the
  // info-request clock; a complete one the 2-business-day decision clock).
  deadlines = deadlinesFor({ ...corrected, assessment_recommended_action: pass1.recommended_action }, community, standards, facts, opts.now);
  let result = evaluate({ app: corrected, packet, standards, neighbors, priorAtAddress, letterCheck, deadlines });
  if (result.recommended_action !== pass1.recommended_action) {
    deadlines = deadlinesFor({ ...corrected, assessment_recommended_action: result.recommended_action }, community, standards, facts, opts.now);
    result = evaluate({ app: corrected, packet, standards, neighbors, priorAtAddress, letterCheck, deadlines });
  }
  for (const [k, v] of Object.entries(linkChanges)) {
    if (k === 'plan_name') result.findings.push({ code: 'fill_plan_name', severity: 'ok', title: 'Plan name taken from the approved master plan', detail: `Plan ${corrected.plan_number} is "${v}" in the master plan library.`, fix_by: null, ref: null });
    if (k === 'master_plan_id') result.findings.push({ code: 'linked_master_plan', severity: 'ok', title: 'Linked to the approved master plan', detail: `Plan ${corrected.plan_number} elevation ${corrected.elevation} is approved at this community.`, fix_by: null, ref: null });
  }
  if (letterCheck.ok) result.findings.push({ code: 'letter_ready', severity: 'ok', title: 'Approval letter data complete', detail: 'Address, lot, plan, elevation and the approved master plan link all check out.', fix_by: null, ref: null });
  const corrections = { ...pass1.corrections, ...linkChanges };
  const draft = result.recommended_action === 'request_more_info' ? draftInfoRequest(corrected, result) : null;

  const assessment = {
    application_id: app.id,
    compared_against_master_plan_id: corrected.master_plan_id || null,
    assessment_text: result.summary,
    draft_response: draft,
    recommended_action: result.recommended_action,
    ai_compliance_findings: result.findings.map((f) => ({ section_ref: f.ref || null, finding: f.title, detail: f.detail, severity: f.severity, code: f.code, fix_by: f.fix_by || null, recommendation: f.ask || null })),
    ai_confidence: result.confidence,
    model_version: (packet && packet.model) || 'rules',
    ai_provider: packet && packet.model ? 'anthropic' : 'rules',
    run_by: RUN_BY,
  };

  if (!apply) return { application: corrected, result, corrections, assessment, packet, deadlines, applied: false };

  // 4. Verified corrections + review snapshot on the application.
  const patch = applicationPatch(app, corrections, result, draft);
  const { error: ue } = await supabase.from('builder_applications').update(patch).eq('id', app.id);
  if (ue) throw ue;
  // 5. The review record.
  const { data: ins, error: ie } = await supabase.from('builder_application_assessments').insert(assessment).select('id').single();
  if (ie) throw ie;
  // 6. Ownership + deadlines.
  let work_item = null;
  try { work_item = await upsertWorkItem(supabase, { app: corrected, community, standards, result, facts }); }
  catch (e) { console.warn('[builder_arc.review] work item update failed:', e.message); work_item = { error: e.message }; }
  // 7. Builder notice + Ed's notice, on a change of Annie's recommendation.
  let notices = null;
  try { notices = await afterReview(supabase, { app, corrected, community, result, draft, deadlines, notify: opts.notify || null }); }
  catch (e) { console.warn('[builder_arc.review] notices failed:', e.message); notices = { error: e.message }; }
  return { application: corrected, result, corrections, assessment_id: ins.id, work_item, notices, packet: packet ? { facts: packet.facts, pages: packet.pages, errors: packet.errors, model: packet.model } : null, deadlines, applied: true };
}

// The application update a review writes: verified corrections, the review
// snapshot, and the extraction flag cleared. Verified materials from the packet
// form (when the application had none) ride in corrections.application_data.
function applicationPatch(app, corrections, result, draft) {
  return {
    ...corrections,
    assessment_recommended_action: result.recommended_action,
    assessment_draft_response: draft,
    application_data: { ...(corrections.application_data || app.application_data || {}), ai_extraction_pending: false },
  };
}

// After a review: an incomplete application gets Annie's request to the builder
// queued in the Draft Queue at once (a person sends it; it must reach the
// builder within 1 business day of receipt), and Ed is told when an
// application becomes ready for his decision or needs a request sent. Only a
// CHANGE of recommendation notifies, so re-reviews of the same packet stay quiet.
async function afterReview(supabase, { app, corrected, community, result, draft, deadlines, notify }) {
  const prev = app.assessment_recommended_action || null;
  const now = result.recommended_action;
  const bedrockFix = result.findings.some((f) => f.severity === 'blocker' && f.fix_by === 'bedrock');
  const out = { changed: prev !== now, queued: null, notified: null };
  const addr = String(corrected.street_address || '').split(',')[0];
  if (now === 'request_more_info' && draft && corrected.submitter_email) {
    const { queueDraft } = require('../email/outbound_drafts');
    out.queued = await queueDraft({
      communityId: corrected.community_id, communityName: community && community.name, persona: 'annie',
      toEmail: corrected.submitter_email, toName: corrected.submitter_name || null,
      subject: `${(community && community.name) || 'Builder ARC'}: information needed for ${addr} (${corrected.reference_number})`,
      bodyText: draft, relatedType: 'builder_application', relatedId: corrected.id,
      sourceEmailRef: `builder_info_request:${corrected.reference_number}`, draftKind: 'reply',
      draftReason: `Annie: the submission is incomplete. Send by ${deadlines && deadlines.standard.info_request_due_at ? String(deadlines.standard.info_request_due_at).slice(0, 10) : 'the next business day'} (1 business day from receipt).`,
      createdBy: 'Annie Reeves (AI architectural review)',
    });
  }
  if (!out.changed || typeof notify !== 'function') return out;
  const due = deadlines && deadlines.standard.due_at ? String(deadlines.standard.due_at).slice(0, 10) : null;
  if (now === 'approve' || (now === 'manual_review' && !bedrockFix)) {
    out.notified = await notify({
      subject: `Builder ARC: ${addr} ready for your ${now === 'approve' ? 'approval' : 'decision'} (${corrected.reference_number})`,
      text: `${now === 'approve' ? 'Annie found this submission ready for approval.' : 'Annie flagged a question for your decision.'}

${addr} (${corrected.reference_number}), ${community && community.name}
Annie: ${result.summary}
${due ? `Bedrock standard: decision approved and emailed to the builder by ${due}.
` : ''}${deadlines && deadlines.governing.limit_at ? `Association review period ends ${String(deadlines.governing.limit_at).slice(0, 10)}.
` : ''}
Open trustEd: /builder-arc-review.html?id=${corrected.id}`,
    });
  } else if (now === 'request_more_info') {
    out.notified = await notify({
      subject: `Builder ARC: info request ready to send for ${addr} (${corrected.reference_number})`,
      text: `Annie found the submission incomplete and drafted the request to the builder. It is in the Draft Queue; it must reach the builder by ${deadlines && deadlines.standard.info_request_due_at ? String(deadlines.standard.info_request_due_at).slice(0, 10) : 'the next business day'}.

${draft || ''}

Open trustEd: /draft-queue.html`,
    });
  }
  return out;
}

/** Fire-and-forget wrapper for intake events. Never throws. */
function reviewSoon(supabase, applicationId, reason) {
  if (!enabled()) return;
  setImmediate(() => {
    runReview(supabase, applicationId, { notify: notifyEd }).then((r) => {
      console.log(`[builder_arc.review] ${reason}: ${r.application.reference_number} -> ${r.result.recommended_action}`);
    }).catch((e) => console.warn(`[builder_arc.review] ${reason} review failed for ${applicationId}:`, e.message));
  });
}

// Ed's notices go to the owner's inbox (internal; never to a builder).
async function notifyEd({ subject, text }) {
  const { sendEmail } = require('../notifications/email');
  const { OWNER_EMAIL } = require('../auth/owner_email');
  const html = `<pre style="font-family:inherit;white-space:pre-wrap">${String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
  return sendEmail({ to: OWNER_EMAIL, subject, text, html });
}

module.exports = { runReview, reviewSoon, enabled, latestPacket, applicationPatch, afterReview, notifyEd };
