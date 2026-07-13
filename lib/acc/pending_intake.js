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

  const { data: rec, error } = await supabase.from('acc_decisions').insert({
    management_company_id: BEDROCK_MGMT_CO_ID,
    community_id: cid, community_name: community,
    homeowner_name: ex.homeowner_name || submitterName || null,
    homeowner_address: ex.homeowner_address || propertyAddress || null,
    project_summary: ex.project_summary || null,
    reference_number: reference || ex.reference_number || null,
    status: 'pending_review', source, submitter_email: submitterEmail,
    ai_recommendation, ai_review_text: reviewText || null, ai_letter_body: out.letter_body || null,
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

module.exports = { createPendingAccDecision };
