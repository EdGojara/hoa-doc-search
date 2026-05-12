// ============================================================================
// ACC Applications API
// ----------------------------------------------------------------------------
// Mounted at /api/applications.
//
// Public flow:
//   1. GET  /public/:community-slug          → form metadata (community rules, fee, fields)
//   2. POST /public/:community-slug/submit   → save + run instant AI assessment + return result
//   3. GET  /public/status/:reference        → check status (public; reference-number gated)
//
// Manager flow:
//   4. GET  /                                → queue list (filterable)
//   5. GET  /:id                             → full detail incl assessments + responses
//   6. POST /:id/assess                      → re-run AI assessment
//   7. POST /:id/finalize                    → manager action (approve/deny/conditional/request_info)
//                                              with editable response message
//
// Triangulates 5 sources for the AI assessment:
//   - Community profile + facts
//   - Governing-doc chunks (semantic)
//   - Historical ACC decisions (semantic match)
//   - Ed's playbook
//   - The application data itself
// ============================================================================

const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const EMBEDDING_MODEL = 'text-embedding-ada-002';
const ASSESSMENT_MODEL = 'claude-sonnet-4-6';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const router = express.Router();

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

async function embed(text) {
  if (!text || !text.trim()) return null;
  try {
    const r = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text.replace(/\n+/g, ' ').slice(0, 8000)
    });
    return r.data[0].embedding;
  } catch (err) {
    console.warn('[applications] embed failed:', err.message);
    return null;
  }
}

function normalizeAddress(s) {
  return (s || '').toString().toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
}

// Reference number generator (uses application_reference_counters from migration 021)
async function nextReferenceNumber(communityId, serviceType, prefix) {
  const year = new Date().getFullYear();
  // Atomic upsert via SQL (simple pattern: select, +1, update — race-resistant under sequential staff usage)
  const { data: row } = await supabase
    .from('application_reference_counters')
    .select('counter')
    .eq('community_id', communityId)
    .eq('service_type', serviceType)
    .eq('year', year)
    .maybeSingle();

  const next = (row?.counter || 0) + 1;
  await supabase
    .from('application_reference_counters')
    .upsert({
      community_id: communityId,
      service_type: serviceType,
      year,
      counter: next,
      updated_at: new Date().toISOString()
    }, { onConflict: 'community_id,service_type,year' });

  return `${prefix || 'APP'}-${year}-${String(next).padStart(4, '0')}`;
}

// ----------------------------------------------------------------------------
// AI assessment — the encode-Ed triangulation
// ----------------------------------------------------------------------------

async function runAssessment(application) {
  const t0 = Date.now();

  // 1. Community profile + facts
  const { data: comm } = await supabase
    .from('communities')
    .select('id, name, profile')
    .eq('id', application.community_id)
    .maybeSingle();

  const { data: facts } = await supabase
    .from('v_community_facts')
    .select('category, label, value, is_expired, expires_at')
    .eq('community_id', application.community_id)
    .order('category');

  // 2. Build embedding from project description to drive retrieval
  const appData = application.application_data || {};
  const projectSnippet = [
    appData.project_type,
    appData.project_description,
    appData.materials,
    appData.dimensions,
    appData.location_on_property
  ].filter(Boolean).join(' — ');
  const queryEmbed = await embed(projectSnippet || 'general architectural review');

  // 3. Governing-doc chunks (semantic)
  let govDocContext = '';
  if (queryEmbed) {
    try {
      const { data: chunks } = await supabase.rpc('match_documents', {
        query_embedding: queryEmbed,
        match_count: 8,
        filter_communities: ['Law', 'General', comm?.name].filter(Boolean)
      });
      if (chunks && chunks.length > 0) {
        govDocContext = chunks.map(c =>
          `[${c.metadata?.filename || 'doc'}] ${c.content}`
        ).join('\n\n---\n\n');
      }
    } catch (e) { console.warn('[assess] gov-doc retrieval failed:', e.message); }
  }

  // 4. Historical ACC decisions (semantic match)
  let historyContext = '';
  if (queryEmbed) {
    try {
      const { data: matches } = await supabase.rpc('match_arc_decisions', {
        query_embedding: queryEmbed,
        community_id_in: application.community_id,
        match_count: 5,
        similarity_threshold: 0.6
      });
      if (matches && matches.length > 0) {
        historyContext = matches.map(m =>
          `[${(m.decision_type || '?').toUpperCase()}] ${m.decided_at || '(no date)'} — ${m.property_address || ''}: ${m.summary || m.project_description || ''}${m.conditions ? ` (conditions: ${m.conditions})` : ''}`
        ).join('\n');
      }
    } catch (e) { console.warn('[assess] arc-history retrieval failed:', e.message); }
  }

  // 5. Ed's playbook (semantic via existing helper if available)
  let playbookContext = '';
  try {
    const { getRelevantPlaybook, formatPlaybookContext } = require('../playbook');
    const entries = await getRelevantPlaybook(projectSnippet || 'ACC application review', { matchCount: 6 });
    playbookContext = formatPlaybookContext(entries, { heading: "ED'S PLAYBOOK — RELEVANT PATTERNS" });
  } catch (e) { console.warn('[assess] playbook retrieval failed:', e.message); }

  // Build the prompt
  const profileLines = [];
  if (comm?.profile) {
    for (const [k, v] of Object.entries(comm.profile)) {
      if (v == null || v === '') continue;
      profileLines.push(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
  }
  const factsLines = (facts || []).map(f => {
    const stale = f.is_expired ? ' [⚠ may be outdated]' : '';
    return `  • ${f.label || f.category}: ${f.value}${stale}`;
  });

  const appBlock = [
    `Project type: ${appData.project_type || '(not specified)'}`,
    `Description: ${appData.project_description || '(none)'}`,
    appData.materials ? `Materials: ${appData.materials}` : null,
    appData.dimensions ? `Dimensions: ${appData.dimensions}` : null,
    appData.location_on_property ? `Location on property: ${appData.location_on_property}` : null,
    appData.start_date ? `Expected start: ${appData.start_date}` : null,
    appData.completion_date ? `Expected completion: ${appData.completion_date}` : null,
    appData.contractor ? `Contractor: ${appData.contractor}` : null,
    appData.estimated_cost ? `Estimated cost: $${appData.estimated_cost}` : null,
    `Property address: ${application.property_address}`,
    `Submitter: ${application.submitter_name} (${application.submitter_email})`
  ].filter(Boolean).join('\n');

  const systemPrompt = `You are reviewing a homeowner-submitted ARC (Architectural Review Committee) application for an HOA managed by Bedrock Association Management.

Your role: provide a structured PRELIMINARY assessment that helps the community manager make the final decision. You are NOT the final authority — the manager and committee are. Your output gets shown to the homeowner IMMEDIATELY after they submit, framed as "preliminary AI analysis — your community manager will follow up within 24 hours with the official decision."

CRITICAL OUTPUT RULES:
- Return ONLY a single valid JSON object (no markdown fences, no commentary outside the JSON)
- Use the exact shape below
- Be CONCRETE — cite specific governing-doc sections when possible
- Treat HISTORICAL DECISIONS as informational context, not binding precedent. The current governing documents are the authority.
- "draft_response" should be in Bedrock's voice: warm, clear, respectful, lead with the decision, explain reasoning, offer path forward. Sign off "— Bedrock Association Management" (never a personal name).

OUTPUT SHAPE:
{
  "status": "likely_approved" | "incomplete" | "concerns_identified" | "manual_review",
  "recommended_action": "approve" | "approve_with_conditions" | "request_more_info" | "deny" | "manual_review",
  "summary": "<1-2 sentence reasoning aimed at the manager>",
  "missing_items": [{"item": "...", "required": true | false, "hint": "..."}],
  "concerns": [{"concern": "...", "citation": "<doc + section>", "severity": "low" | "medium" | "high"}],
  "conditions": [{"condition": "...", "rationale": "..."}],
  "citations": [{"document": "...", "section": "...", "quote": "..."}],
  "confidence": "high" | "medium" | "low",
  "draft_response": "<email body to the homeowner — Bedrock voice, ~150-300 words>"
}`;

  const userMessage = `COMMUNITY: ${comm?.name || application.property_address || '(unknown)'}

COMMUNITY PROFILE:
${profileLines.length > 0 ? profileLines.join('\n') : '  (no profile data on file)'}

COMMUNITY FACTS:
${factsLines.length > 0 ? factsLines.join('\n') : '  (no facts on file)'}

RELEVANT GOVERNING DOCUMENTS (extracted by semantic match):
${govDocContext || '  (no governing docs matched — flag this if it materially affects the assessment)'}

HISTORICAL ACC DECISIONS FOR THIS COMMUNITY (informational only — NOT binding precedent):
${historyContext || '  (no historical decisions on file)'}

${playbookContext || ''}

THE APPLICATION:
${appBlock}

Return the JSON assessment now.`;

  try {
    const completion = await anthropic.messages.create({
      model: ASSESSMENT_MODEL,
      max_tokens: 2500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    });

    const raw = completion.content[0]?.text || '';
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned);

    const durationMs = Date.now() - t0;

    // Persist to application_assessments (full history)
    await supabase.from('application_assessments').insert({
      application_id: application.id,
      status: parsed.status,
      summary: parsed.summary,
      missing_items: parsed.missing_items || [],
      concerns: parsed.concerns || [],
      citations: parsed.citations || [],
      confidence: parsed.confidence,
      draft_response: parsed.draft_response || null,
      recommended_action: parsed.recommended_action || null,
      ai_model: ASSESSMENT_MODEL,
      ai_input_tokens: completion.usage?.input_tokens || null,
      ai_output_tokens: completion.usage?.output_tokens || null,
      ai_duration_ms: durationMs,
      prompt_version: 'v1',
      triggered_by: 'initial_submission'
    });

    // Denormalize latest snapshot onto the application row
    await supabase.from('community_applications').update({
      assessment_status: parsed.status,
      assessment_summary: parsed.summary,
      assessment_missing_items: parsed.missing_items || [],
      assessment_concerns: parsed.concerns || [],
      assessment_citations: parsed.citations || [],
      assessment_confidence: parsed.confidence,
      assessment_draft_response: parsed.draft_response || null,
      assessment_recommended_action: parsed.recommended_action || null,
      last_assessment_at: new Date().toISOString()
    }).eq('id', application.id);

    return { ok: true, assessment: parsed, duration_ms: durationMs };
  } catch (err) {
    console.error('[applications] assessment failed:', err.message);
    return { ok: false, error: safeErrorMessage(err) };
  }
}

// ============================================================================
// PUBLIC ENDPOINTS
// ============================================================================

// GET /api/applications/public/:slug — community + service config (so the form can render)
router.get('/public/:slug', async (req, res) => {
  try {
    const { data: comm, error } = await supabase
      .from('communities')
      .select(`
        id, name, slug, profile, total_lots,
        services:community_services(id, service_type, owner_payable_fee, fee_paid_by, payment_required_before_review, notice_period_days, notice_period_enforcement, service_config)
      `)
      .eq('slug', req.params.slug)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (error) throw error;
    if (!comm) return res.status(404).json({ error: 'Community not found' });

    const arcService = (comm.services || []).find(s => s.service_type === 'arc_application');
    res.json({
      community: { id: comm.id, name: comm.name, slug: comm.slug, profile: comm.profile },
      service: arcService || null
    });
  } catch (err) {
    console.error('[applications] public-meta failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /api/applications/public/:slug/submit — homeowner submits, AI assesses instantly
// Body (JSON): { submitter_name, submitter_email, submitter_phone?, property_address,
//                application_data: {...}, signature_png? }
router.post('/public/:slug/submit', express.json({ limit: '4mb' }), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.submitter_name || !b.submitter_email || !b.property_address) {
      return res.status(400).json({ error: 'submitter_name, submitter_email, and property_address are required' });
    }

    // Resolve community
    const { data: comm } = await supabase
      .from('communities')
      .select('id, name')
      .eq('slug', req.params.slug)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (!comm) return res.status(404).json({ error: 'Community not found' });

    // Resolve service (arc_application)
    const { data: service } = await supabase
      .from('community_services')
      .select('id, service_type, owner_payable_fee, fee_paid_by, payment_required_before_review')
      .eq('community_id', comm.id)
      .eq('service_type', 'arc_application')
      .maybeSingle();
    if (!service) {
      return res.status(400).json({ error: 'This community has not enabled ARC applications. Contact management.' });
    }

    // Reference number (e.g., LPF-ARC-2026-0042)
    const prefix = (comm.name || 'APP').replace(/[^A-Z]/gi, '').slice(0, 3).toUpperCase() + '-ARC';
    const reference = await nextReferenceNumber(comm.id, 'arc_application', prefix);

    // Roster match (optional — used as flag only, no auth gate)
    const normalized = normalizeAddress(b.property_address);
    let propertyAddressId = null;
    if (normalized) {
      const { data: addr } = await supabase
        .from('community_addresses')
        .select('id')
        .eq('community_id', comm.id)
        .ilike('address', `%${b.property_address.split(' ')[0]}%`)
        .limit(1)
        .maybeSingle();
      if (addr) propertyAddressId = addr.id;
    }

    // Determine fee
    let calculatedFee = null;
    let feeBasis = null;
    let paymentStatus = 'not_required';
    if (service.fee_paid_by === 'owner' && service.owner_payable_fee != null) {
      calculatedFee = service.owner_payable_fee;
      feeBasis = `Owner-paid ARC fee: $${service.owner_payable_fee}`;
      paymentStatus = service.payment_required_before_review ? 'pending' : 'pending';
    }

    // Insert application
    const insert = {
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id: comm.id,
      community_service_id: service.id,
      reference_number: reference,
      service_type: 'arc_application',
      submitter_name: b.submitter_name,
      submitter_email: b.submitter_email,
      submitter_phone: b.submitter_phone || null,
      property_address: b.property_address,
      property_unit: b.property_unit || null,
      property_address_id: propertyAddressId,
      application_data: b.application_data || {},
      final_status: 'pending_committee_review',
      submitted_at: new Date().toISOString(),
      calculated_fee_usd: calculatedFee,
      fee_basis: feeBasis,
      payment_status: paymentStatus,
      client_ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() || null,
      user_agent: req.headers['user-agent'] || null
    };

    const { data: app, error } = await supabase
      .from('community_applications')
      .insert(insert)
      .select()
      .single();
    if (error) throw error;

    // Run AI assessment SYNCHRONOUSLY — the instant-feedback wedge
    const assessmentResult = await runAssessment(app);

    res.json({
      ok: true,
      reference_number: reference,
      application_id: app.id,
      status_url: `/apply/status/${encodeURIComponent(reference)}`,
      assessment: assessmentResult.ok ? assessmentResult.assessment : null,
      assessment_error: assessmentResult.ok ? null : assessmentResult.error
    });
  } catch (err) {
    console.error('[applications] submit failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /api/applications/public/status/:reference — homeowner status check
router.get('/public/status/:reference', async (req, res) => {
  try {
    const { data: app, error } = await supabase
      .from('community_applications')
      .select(`
        reference_number, service_type, property_address, submitter_name,
        submitted_at, final_status, final_decided_at, final_decision_reasoning,
        assessment_status, assessment_summary, assessment_concerns, assessment_missing_items,
        community:communities(name)
      `)
      .eq('reference_number', req.params.reference)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (error) throw error;
    if (!app) return res.status(404).json({ error: 'Application not found' });

    // Latest manager-sent response (if any)
    const { data: latestResponse } = await supabase
      .from('application_responses')
      .select('response_type, message_to_owner, email_subject, action_at')
      .eq('application_id', (await supabase.from('community_applications').select('id').eq('reference_number', req.params.reference).single()).data?.id)
      .in('response_type', ['approval', 'denial', 'request_more_info', 'email_sent'])
      .order('action_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    res.json({ application: app, latest_response: latestResponse });
  } catch (err) {
    console.error('[applications] status failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// MANAGER ENDPOINTS — queue + detail + finalize
// ============================================================================

// GET /api/applications — manager queue (filterable)
router.get('/', async (req, res) => {
  try {
    let q = supabase
      .from('community_applications')
      .select(`
        id, reference_number, service_type, property_address, submitter_name,
        submitter_email, submitted_at, final_status, final_decided_at,
        assessment_status, assessment_summary, assessment_confidence, last_assessment_at,
        payment_status, calculated_fee_usd,
        community:communities(id, name, slug)
      `)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('submitted_at', { ascending: false, nullsFirst: false })
      .limit(Math.min(Number(req.query.limit) || 200, 500));

    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    if (req.query.final_status) q = q.eq('final_status', req.query.final_status);
    if (req.query.assessment_status) q = q.eq('assessment_status', req.query.assessment_status);

    const { data, error } = await q;
    if (error) throw error;
    res.json({ applications: data || [] });
  } catch (err) {
    console.error('[applications] queue failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /api/applications/:id — full detail (assessments + responses)
router.get('/:id', async (req, res) => {
  try {
    const [appResp, assessResp, respResp, attachResp] = await Promise.all([
      supabase.from('community_applications')
        .select('*, community:communities(id, name, slug)')
        .eq('id', req.params.id)
        .eq('management_company_id', BEDROCK_MGMT_CO_ID)
        .maybeSingle(),
      supabase.from('application_assessments')
        .select('*')
        .eq('application_id', req.params.id)
        .order('created_at', { ascending: false }),
      supabase.from('application_responses')
        .select('*')
        .eq('application_id', req.params.id)
        .order('action_at', { ascending: false }),
      supabase.from('application_attachments')
        .select('id, attachment_type, original_filename, file_size_bytes, caption, uploaded_at')
        .eq('application_id', req.params.id)
        .order('display_order')
    ]);

    if (appResp.error) throw appResp.error;
    if (!appResp.data) return res.status(404).json({ error: 'Application not found' });

    res.json({
      application: appResp.data,
      assessments: assessResp.data || [],
      responses: respResp.data || [],
      attachments: attachResp.data || []
    });
  } catch (err) {
    console.error('[applications] detail failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /api/applications/:id/assess — re-run AI assessment
router.post('/:id/assess', async (req, res) => {
  try {
    const { data: app, error } = await supabase
      .from('community_applications')
      .select('*')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .single();
    if (error) throw error;
    const result = await runAssessment(app);
    if (!result.ok) return res.status(500).json({ error: result.error });
    res.json({ ok: true, assessment: result.assessment, duration_ms: result.duration_ms });
  } catch (err) {
    console.error('[applications] reassess failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /api/applications/:id/finalize — manager action
// Body: { action, message_to_owner, internal_notes?, decided_by_name?,
//          conditions?, promote_to_history? (default: true) }
//
// When promote_to_history is true and action is approve/deny/conditional,
// a row is also created in arc_historical_decisions so this decision
// immediately becomes precedent for future AI assessments of similar
// applications in the same community. THIS IS THE TYPE-B LEARNING LOOP.
router.post('/:id/finalize', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const { action, message_to_owner, internal_notes, decided_by_name, conditions, promote_to_history } = req.body || {};
    if (!action) return res.status(400).json({ error: 'action is required' });

    const validActions = ['approve', 'deny', 'approve_with_conditions', 'request_more_info'];
    if (!validActions.includes(action)) return res.status(400).json({ error: 'invalid action' });

    const finalStatusMap = {
      approve: 'approved',
      deny: 'denied',
      approve_with_conditions: 'approved',
      request_more_info: 'pending_committee_review'
    };
    const responseTypeMap = {
      approve: 'approval',
      deny: 'denial',
      approve_with_conditions: 'approval',
      request_more_info: 'request_more_info'
    };

    const finalStatus = finalStatusMap[action];

    // Update the application row
    const patch = {
      final_status: finalStatus,
      final_decided_at: action === 'request_more_info' ? null : new Date().toISOString(),
      final_decision_reasoning: internal_notes || null
    };
    const { data: app, error: updErr } = await supabase
      .from('community_applications')
      .update(patch)
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .select('*, community:communities(id, name)')
      .single();
    if (updErr) throw updErr;

    // Insert the response row
    await supabase.from('application_responses').insert({
      application_id: req.params.id,
      response_type: responseTypeMap[action],
      message_to_owner: message_to_owner || null,
      internal_notes: internal_notes || null,
      action_by_name: decided_by_name || null,
      email_to: app.submitter_email,
      email_subject: action === 'approve' ? `Your application ${app.reference_number} has been approved`
                    : action === 'deny' ? `Update on your application ${app.reference_number}`
                    : action === 'approve_with_conditions' ? `Your application ${app.reference_number} — conditional approval`
                    : `We need a bit more information — application ${app.reference_number}`,
      metadata: { final_status: finalStatus, action }
    });

    // ========================================================================
    // TYPE-B LEARNING LOOP: promote this decision into arc_historical_decisions
    // so future AI assessments treat it as precedent. Skipped on request_more_info
    // (no decision yet to learn from) and skippable via promote_to_history=false.
    // ========================================================================
    let promoted = null;
    const shouldPromote = (promote_to_history !== false) && action !== 'request_more_info';
    if (shouldPromote) {
      try {
        const appData = app.application_data || {};
        const decisionType = action === 'approve' ? 'approved'
                           : action === 'deny' ? 'denied'
                           : 'conditional';
        const summary = message_to_owner
          ? message_to_owner.replace(/\s+/g, ' ').slice(0, 400)
          : `${app.submitter_name} requested ${appData.project_type || 'a project'} at ${app.property_address}; ${decisionType} on ${new Date().toISOString().slice(0, 10)}.`;
        const reasoning = internal_notes || null;
        const embedSource = [
          appData.project_type,
          appData.project_description,
          conditions,
          reasoning,
          summary
        ].filter(Boolean).join(' — ').slice(0, 6000);
        const embedding = await embed(embedSource);

        const { data: historyRow } = await supabase
          .from('arc_historical_decisions')
          .insert({
            management_company_id: BEDROCK_MGMT_CO_ID,
            community_id: app.community_id,
            source_filename: `internal-app-${app.reference_number}`,
            source_excerpt: `Submitted via Bedrock public portal · ${app.reference_number}`,
            property_address: app.property_address,
            homeowner_name: app.submitter_name,
            project_type: appData.project_type || null,
            project_description: appData.project_description || null,
            decision_type: decisionType,
            decided_at: new Date().toISOString().slice(0, 10),
            decided_by: decided_by_name || 'Bedrock manager',
            conditions: conditions || null,
            reasoning: reasoning,
            summary: summary,
            embedding,
            extracted_by_model: ASSESSMENT_MODEL,
            extraction_confidence: 'high',
            manually_edited: true,
            raw_extraction: { source: 'internal_application_finalize', application_id: app.id }
          })
          .select('id')
          .single();
        promoted = historyRow;
      } catch (err) {
        // Don't fail the finalize if the history promotion errors — log it.
        console.error('[applications] promote-to-history failed:', err.message);
      }
    }

    res.json({ ok: true, application: app, promoted_to_history: promoted });
  } catch (err) {
    console.error('[applications] finalize failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
