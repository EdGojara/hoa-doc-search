// ============================================================================
// lib/acc/pending_intake.js  (Ed 2026-07-13)
// ----------------------------------------------------------------------------
// The ONE intake path all three doors use to drop an application into the
// working decision engine's queue. Runs the shared engine (unchanged), captures
// its drafted recommendation + letter, and lands an acc_decisions row in
// status='pending_review' for a human to review, accept/adjust, and send.
// Idempotent via intake_source_ref. Best-effort file archival to storage.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { runEngine, isReady } = require('./engine_registry');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const DECISIONS = ['approved_no_conditions', 'approved_with_conditions', 'request_more_info', 'incomplete', 'denied'];

// Classify the engine's own recommendation into a structured decision_type so
// the queue can show it as an accept-or-change suggestion. Advisory only.
async function classifyRecommendation(reviewText, letterBody) {
  const src = `${reviewText || ''}\n\nLETTER:\n${letterBody || ''}`.slice(0, 8000);
  try {
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 20,
      messages: [{ role: 'user', content: `An HOA ACC reviewer wrote the analysis + letter below. What did they RECOMMEND? Answer with EXACTLY one token: approved_no_conditions, approved_with_conditions, request_more_info, or denied.\n\n${src}` }],
    });
    const t = (r.content?.[0]?.text || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
    if (t === 'incomplete') return 'request_more_info';
    return DECISIONS.includes(t) ? t : 'request_more_info';
  } catch (_) { return 'request_more_info'; }
}

async function resolveCommunityId(communityId, communityName) {
  if (communityId) return communityId;
  if (!communityName) return null;
  try {
    const { data } = await supabase.from('communities').select('id').eq('management_company_id', BEDROCK_MGMT_CO_ID).ilike('name', communityName).maybeSingle();
    return data ? data.id : null;
  } catch (_) { return null; }
}

// Duplicate guard (Ed 2026-07-17). A homeowner emailing an application for a
// project staff ALREADY decided directly would otherwise create a redundant
// pending review — and a second decision on it re-bills the ARC fee. Return the
// most recent DECIDED decision for the same property (address-matched within
// the community) in the last `withinDays`, so the reviewer is warned. We FLAG,
// never drop — a genuinely new project must still get its review.
const normAddr = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
async function findRecentDecisionForAddress(cid, address, withinDays = 120) {
  if (!cid || !address) return null;
  const target = normAddr(address);
  if (!target) return null;
  const sinceIso = new Date(Date.now() - withinDays * 86400000).toISOString();
  try {
    const { data } = await supabase.from('acc_decisions')
      .select('id, created_at, decision_type, project_summary, homeowner_address')
      .eq('community_id', cid).eq('status', 'decided')
      .gte('created_at', sinceIso).order('created_at', { ascending: false }).limit(50);
    return (data || []).find((d) => {
      const a = normAddr(d.homeowner_address);
      return a && (a === target || a.includes(target) || target.includes(a));
    }) || null;
  } catch (_) { return null; }
}

// files: [{ fieldname:'pdf'|'images', buffer, mimetype, originalname }] (engine shape).
// Returns { status:'created'|'exists'|'skipped'|'error', id?, ai_recommendation?, ... }.
async function createPendingAccDecision({ community, communityId, files = [], submitterEmail = null, submitterName = null, source = 'email', intakeSourceRef = null, propertyAddress = null, reference = null }) {
  if (!isReady()) return { status: 'skipped', reason: 'engine_not_ready' };
  if (!community) return { status: 'skipped', reason: 'no_community' };
  if (!files.length) return { status: 'skipped', reason: 'no_files' };

  // Idempotency.
  if (intakeSourceRef) {
    const { data: existing } = await supabase.from('acc_decisions').select('id').eq('intake_source_ref', intakeSourceRef).limit(1);
    if (existing && existing.length) return { status: 'exists', id: existing[0].id };
  }

  // Run the shared engine (isAdmin so we get the workpaper to store).
  let out;
  try { out = await runEngine({ community, files, isAdmin: true }); }
  catch (e) { console.error('[acc_pending] engine failed:', e.message); return { status: 'error', error: e.message }; }

  const ex = out.extracted || {};
  const reviewText = (out.review || '').replace(/^\*\*\*[^\n]*\n+/, '').replace(/\n+\*\*\* END[^\n]*$/, '').trim();
  const ai_recommendation = await classifyRecommendation(reviewText, out.letter_body);
  const cid = await resolveCommunityId(communityId, community);

  // Duplicate guard: warn the reviewer if this property already has a recent
  // decided decision (prepended to the review text so it's impossible to miss).
  let dupNote = '';
  const dupOf = await findRecentDecisionForAddress(cid, ex.homeowner_address || propertyAddress);
  if (dupOf) {
    dupNote = `⚠️ POSSIBLE DUPLICATE — ${dupOf.homeowner_address || 'this property'} already has a DECIDED ACC decision from ${String(dupOf.created_at).slice(0, 10)} (${dupOf.decision_type || 'decided'}) for: "${(dupOf.project_summary || '').slice(0, 160)}". If this is the same request, DISMISS this instead of issuing a new decision or letter — a second decision re-bills the ARC fee.\n\n`;
  }

  const { data: rec, error } = await supabase.from('acc_decisions').insert({
    management_company_id: BEDROCK_MGMT_CO_ID,
    community_id: cid, community_name: community,
    homeowner_name: ex.homeowner_name || submitterName || null,
    homeowner_address: ex.homeowner_address || propertyAddress || null,
    project_summary: ex.project_summary || null,
    reference_number: reference || ex.reference_number || null,
    status: 'pending_review', source, submitter_email: submitterEmail,
    ai_recommendation, ai_review_text: (dupNote + (reviewText || '')) || null, ai_letter_body: out.letter_body || null,
    intake_source_ref: intakeSourceRef,
  }).select('id').single();
  if (error) {
    if (String(error.code) === '23505') return { status: 'exists' };
    console.error('[acc_pending] insert failed:', error.message);
    return { status: 'error', error: error.message };
  }
  const id = rec.id;

  // Archive source files under the decision (best-effort; matches the letter flow's paths).
  const photoPaths = [];
  let applicationPath = null;
  for (let i = 0, p = 0; i < files.length; i++) {
    const f = files[i];
    const isPdf = /pdf/i.test(f.mimetype || '') || /\.pdf$/i.test(f.originalname || '');
    try {
      if (f.fieldname === 'pdf' && !applicationPath) {
        applicationPath = `acc_decisions/${id}/application.pdf`;
        await supabase.storage.from('documents').upload(applicationPath, f.buffer, { contentType: 'application/pdf', upsert: true });
      } else {
        const ext = isPdf ? 'pdf' : (/(png)/i.test(f.mimetype || '') ? 'png' : 'jpg');
        const path = `acc_decisions/${id}/photo_${++p}.${ext}`;
        await supabase.storage.from('documents').upload(path, f.buffer, { contentType: f.mimetype || 'image/jpeg', upsert: true });
        photoPaths.push(path);
      }
    } catch (e) { console.warn('[acc_pending] file archive skipped:', e.message); }
  }
  try { await supabase.from('acc_decisions').update({ application_pdf_storage_path: applicationPath, photo_storage_paths: photoPaths, updated_at: new Date().toISOString() }).eq('id', id); } catch (_) {}

  return { status: 'created', id, ai_recommendation, community_name: community, homeowner_name: ex.homeowner_name || null, project_summary: ex.project_summary || null };
}

// Attach follow-up documents to an EXISTING open application — a homeowner emails
// in the rest of their package after we asked for more. PDFs append to
// supporting_docs_storage_paths, images to photo_storage_paths, the contributing
// email is recorded, and the case flips back to 'pending_review' (a fresh doc
// means it's ready to look at again). Tolerant: if migration 326 isn't applied
// yet the update errors and the caller falls back to creating a new record.
async function attachDocsToApplication({ applicationId, files = [], sourceRef = null }) {
  if (!applicationId || !files.length) return { status: 'skipped', reason: 'nothing_to_attach' };
  const { data: app, error } = await supabase.from('acc_decisions')
    .select('photo_storage_paths, supporting_docs_storage_paths, source_email_refs')
    .eq('id', applicationId).maybeSingle();
  if (error || !app) return { status: 'error', error: error ? error.message : 'application_not_found' };
  const photos = Array.isArray(app.photo_storage_paths) ? app.photo_storage_paths.slice() : [];
  const docs = Array.isArray(app.supporting_docs_storage_paths) ? app.supporting_docs_storage_paths.slice() : [];
  const refs = Array.isArray(app.source_email_refs) ? app.source_email_refs.slice() : [];
  const stamp = Date.now();
  let added = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const isPdf = /pdf/i.test(f.mimetype || '') || /\.pdf$/i.test(f.originalname || '');
    try {
      if (isPdf) {
        const path = `acc_decisions/${applicationId}/supporting_${stamp}_${i}.pdf`;
        await supabase.storage.from('documents').upload(path, f.buffer, { contentType: 'application/pdf', upsert: true });
        docs.push(path); added++;
      } else {
        const ext = /(png)/i.test(f.mimetype || '') ? 'png' : 'jpg';
        const path = `acc_decisions/${applicationId}/photo_${stamp}_${i}.${ext}`;
        await supabase.storage.from('documents').upload(path, f.buffer, { contentType: f.mimetype || 'image/jpeg', upsert: true });
        photos.push(path); added++;
      }
    } catch (e) { console.warn('[acc_pending] attach file skipped:', e.message); }
  }
  if (sourceRef && !refs.includes(sourceRef)) refs.push(sourceRef);
  const { error: uErr } = await supabase.from('acc_decisions').update({
    photo_storage_paths: photos,
    supporting_docs_storage_paths: docs,
    source_email_refs: refs,
    last_document_added_at: new Date().toISOString(),
    status: 'pending_review',
    updated_at: new Date().toISOString(),
  }).eq('id', applicationId);
  if (uErr) return { status: 'error', error: uErr.message };
  return { status: 'attached', id: applicationId, added };
}

module.exports = { createPendingAccDecision, attachDocsToApplication };
