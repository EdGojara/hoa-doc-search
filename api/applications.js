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

const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { safeErrorMessage } = require('./_safe_error');
const { getRelevantChunks } = require('../lib/hybrid_retrieval');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const EMBEDDING_MODEL = 'text-embedding-ada-002';
const ASSESSMENT_MODEL = 'claude-sonnet-4-6';
const ASSESSMENT_MAX_TOKENS = 2500;

// ============================================================================
// Assessment guards + validators
// ----------------------------------------------------------------------------
// Layer 1: pre-flight guards on the AI call (parse failure, max_tokens
// truncation, missing community CC&Rs in retrieval).
// Layer 2: structural cross-validators on the parsed JSON (dimension
// consistency, length sanity, decision/letter agreement, citation source).
//
// Any blocker (Layer 1 or Layer 2) → assessment is "held_for_review" — still
// saved + visible to the manager, but flagged in the queue + NEVER exposed to
// the homeowner regardless of the community's homeowner-visible setting.
// ============================================================================

function parseRetrievalFingerprint(contextText) {
  // hybrid_retrieval.js formats chunk headers as:
  //   [From: <filename> - <community><ocrTag><sourceTag>]
  const fingerprint = [];
  const re = /\[From:\s*([^\]\n]+)\]/g;
  let m;
  while ((m = re.exec(contextText || '')) !== null) {
    const raw = m[1].trim();
    const beforeTags = raw.split(/\s+—\s+/);
    const head = beforeTags[0];
    const sources = beforeTags.slice(1).filter((s) => /^matched/i.test(s)).join(', ');
    const lastDash = head.lastIndexOf(' - ');
    const filename = lastDash > 0 ? head.slice(0, lastDash).trim() : head.trim();
    const community = lastDash > 0 ? head.slice(lastDash + 3).trim() : '';
    fingerprint.push({ filename, community, sources });
  }
  return fingerprint;
}

function summarizeContamination(fingerprint, targetCommunityName) {
  const targetLower = String(targetCommunityName || '').toLowerCase();
  let community = 0;
  let lawGeneral = 0;
  let wrong = 0;
  for (const f of fingerprint) {
    const c = (f.community || '').toLowerCase();
    if (c === 'law' || c === 'general') lawGeneral += 1;
    else if (targetLower && c && (c === targetLower || c.includes(targetLower) || targetLower.includes(c))) community += 1;
    else if (c) wrong += 1;
  }
  const total = fingerprint.length || 0;
  const contaminationRatio = total > 0 ? +(wrong / total).toFixed(4) : 0;
  return { total, community, lawGeneral, wrong, contaminationRatio };
}

function runPreflightGuards({ fingerprint, contamination, completion, parsed, parseError }) {
  const guards = [];
  if (parseError) {
    guards.push({ code: 'JSON_PARSE_FAILED', severity: 'block', detail: String(parseError).slice(0, 200) });
  }
  if (completion?.stop_reason === 'max_tokens') {
    guards.push({ code: 'AI_TRUNCATED', severity: 'block', detail: `stop_reason=max_tokens (output_tokens=${completion?.usage?.output_tokens})` });
  }
  if (contamination.total === 0) {
    guards.push({ code: 'NO_RETRIEVAL', severity: 'block', detail: 'No governing-doc chunks retrieved.' });
  } else if (contamination.community === 0 && contamination.lawGeneral === 0) {
    guards.push({ code: 'CCRS_MISSING', severity: 'block', detail: `Retrieved chunks from wrong communities only: ${[...new Set(fingerprint.map(f => f.community))].join(', ')}` });
  } else if (contamination.community === 0) {
    guards.push({ code: 'CCRS_COMMUNITY_MISSING', severity: 'warn', detail: 'Only Law/General reference chunks — no community-specific CC&Rs in retrieval.' });
  } else if (contamination.contaminationRatio > 0.25) {
    guards.push({ code: 'RETRIEVAL_CONTAMINATED', severity: 'warn', detail: `${Math.round(contamination.contaminationRatio * 100)}% of retrieved chunks are from other communities.` });
  }
  return guards;
}

function extractDimensions(text) {
  if (!text) return { sizes: [], areas: [] };
  const sizes = [];
  const areas = [];
  // 20x14, 20×14, 20'x14', 20 x 14, etc.
  const sizeRe = /(\d{1,4})\s*['′]?\s*[xX×]\s*['′]?\s*(\d{1,4})\s*['′]?/g;
  let m;
  while ((m = sizeRe.exec(text)) !== null) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (a >= 2 && a <= 500 && b >= 2 && b <= 500) {
      sizes.push(`${Math.min(a, b)}x${Math.max(a, b)}`);
    }
  }
  // 280 sq ft, 240 square feet
  const areaRe = /(\d{2,5})\s*(?:square\s*feet|sq\.?\s*ft|sqft)/gi;
  while ((m = areaRe.exec(text)) !== null) {
    areas.push(parseInt(m[1], 10));
  }
  return { sizes: [...new Set(sizes)], areas: [...new Set(areas)] };
}

function runCrossValidators(parsed, fingerprint) {
  const out = {
    dimension_consistency: { ok: true, severity: 'ok' },
    length_sanity: { ok: true, severity: 'ok' },
    decision_letter_agreement: { ok: true, severity: 'ok' },
    citation_source: { ok: true, severity: 'ok' },
  };

  // (a) Dimension consistency across summary + conditions + draft_response
  const summaryText = String(parsed?.summary || '');
  const conditionsText = (parsed?.conditions || []).map((c) => `${c?.condition || ''} ${c?.rationale || ''}`).join(' ');
  const draftText = String(parsed?.draft_response || '');
  const combined = `${summaryText}\n${conditionsText}\n${draftText}`;
  const summaryDims = extractDimensions(summaryText);
  const draftDims = extractDimensions(draftText);
  const allSizes = [...new Set([...summaryDims.sizes, ...draftDims.sizes, ...extractDimensions(conditionsText).sizes])];
  const allAreas = [...new Set([...summaryDims.areas, ...draftDims.areas, ...extractDimensions(conditionsText).areas])];
  if (allSizes.length > 1) {
    out.dimension_consistency = {
      ok: false,
      severity: 'block',
      detail: `Multiple project sizes cited in same output: ${allSizes.join(', ')}. Architect drawing controls — analysis + letter must agree.`,
    };
  } else if (allAreas.length > 1) {
    out.dimension_consistency = {
      ok: false,
      severity: 'block',
      detail: `Multiple square-footage values cited in same output: ${allAreas.map((a) => a + ' sq ft').join(', ')}.`,
    };
  }

  // (b) Length sanity on draft_response
  const wordCount = draftText.split(/\s+/).filter(Boolean).length;
  if (draftText) {
    if (wordCount < 60) {
      out.length_sanity = { ok: false, severity: 'warn', word_count: wordCount, detail: `Draft response is unusually short (${wordCount} words). Letters usually run 120-350 words.` };
    } else if (wordCount > 800) {
      out.length_sanity = { ok: false, severity: 'warn', word_count: wordCount, detail: `Draft response is unusually long (${wordCount} words). Letters usually run 120-350 words.` };
    } else {
      out.length_sanity = { ok: true, severity: 'ok', word_count: wordCount };
    }
  }

  // (c) Decision/letter agreement — recommended_action must match the language in draft_response
  const action = (parsed?.recommended_action || '').toLowerCase();
  if (action && draftText) {
    const draftLower = draftText.toLowerCase();
    const sayApproved = /\b(approved?|approval|granted|pleased to (let|inform|approve)|approve your)\b/.test(draftLower);
    const sayDenied = /\b(denied?|cannot (approve|proceed)|unable to approve|not approved|denial)\b/.test(draftLower);
    const sayRequest = /\b(need|require|missing|please (provide|submit|send)|additional information|cannot fully review)\b/.test(draftLower);
    if (action === 'approve' && sayDenied) {
      out.decision_letter_agreement = { ok: false, severity: 'block', detail: 'recommended_action=approve but draft_response uses denial language.' };
    } else if ((action === 'deny') && (sayApproved && !sayDenied)) {
      out.decision_letter_agreement = { ok: false, severity: 'block', detail: 'recommended_action=deny but draft_response uses approval language.' };
    } else if (action === 'request_more_info' && !sayRequest) {
      out.decision_letter_agreement = { ok: false, severity: 'warn', detail: 'recommended_action=request_more_info but draft_response does not appear to ask for additional info.' };
    }
  }

  // (d) Citation source — every cited document should appear in the retrieval fingerprint
  const citations = parsed?.citations || [];
  const fingerprintFilenames = fingerprint.map((f) => (f.filename || '').toLowerCase());
  const unmatched = [];
  for (const cit of citations) {
    const docName = String(cit?.document || '').toLowerCase().trim();
    if (!docName) continue;
    // Match if any fingerprint filename contains the cited doc name (or vice versa) at a discriminating length
    const matched = fingerprintFilenames.some((fname) => {
      if (!fname) return false;
      if (fname.includes(docName) || docName.includes(fname)) return true;
      // Loose: share at least one 6+ char token
      const docTokens = docName.split(/[^a-z0-9]+/).filter((t) => t.length >= 6);
      return docTokens.some((t) => fname.includes(t));
    });
    if (!matched) unmatched.push(cit.document);
  }
  if (unmatched.length > 0) {
    out.citation_source = {
      ok: false,
      severity: 'warn',
      detail: `Cited documents not present in retrieval fingerprint: ${unmatched.join('; ')}. Model may have hallucinated citations.`,
      unmatched,
    };
  }

  return out;
}

function tallyValidators(validators) {
  let blockers = 0;
  let warnings = 0;
  for (const v of Object.values(validators)) {
    if (v?.severity === 'block') blockers += 1;
    else if (v?.severity === 'warn') warnings += 1;
  }
  return { blockers, warnings };
}

async function writeAuditRow(row) {
  // Defensive — table may not yet exist if migration 118 hasn't been applied.
  try {
    const { error } = await supabase.from('acc_assessment_audit').insert(row);
    if (error) console.warn('[applications] audit insert failed:', error.message);
  } catch (e) {
    console.warn('[applications] audit insert threw:', e.message);
  }
}

function homeownerReceiptFromAssessment(parsed, holdForReview) {
  // What the homeowner sees in the receipt. NEVER the full AI assessment.
  // A short, neutral sentence based on the AI's high-level read, gated to
  // not over-promise. If the assessment was held for review, return a
  // generic "we'll be in touch" message — no AI peek through.
  if (holdForReview) {
    return {
      headline: 'Application received',
      preview: "We've received your application and will follow up within 48 hours with the next steps.",
    };
  }
  const action = (parsed?.recommended_action || '').toLowerCase();
  if (action === 'request_more_info' || (parsed?.missing_items || []).some((m) => m?.required)) {
    return {
      headline: 'Application received',
      preview: 'Based on a preliminary review, we may need a few additional materials. Our team will reach out within 48 hours.',
    };
  }
  return {
    headline: 'Application received',
    preview: 'Based on a preliminary review, your draft appears complete. You can expect a response within 48 hours.',
  };
}

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

async function runAssessment(application, opts = {}) {
  const t0 = Date.now();
  const triggerSource = opts.triggerSource || 'public_submit';
  // In eval mode we skip ALL persistence (application_assessments,
  // community_applications.update, acc_assessment_audit). Lets us run the
  // assessment pipeline against synthetic applications for accuracy
  // benchmarking without polluting production tables.
  const evalMode = opts.evalMode === true;

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

  // 2. Build a FOCUSED retrieval query — community + project type + summary.
  //    Hybrid retrieval was tuned for short focused queries, not long blobs.
  const appData = application.application_data || {};
  const projectSnippet = [
    appData.project_type,
    appData.project_description,
    appData.materials,
    appData.dimensions,
    appData.location_on_property
  ].filter(Boolean).join(' — ');
  const retrievalQuery = [
    comm?.name,
    appData.project_type,
    appData.project_description?.slice(0, 200),
  ].filter(Boolean).join(' — ').slice(0, 400) || projectSnippet || 'architectural review application';

  // 3. Governing-doc chunks via the unified hybrid retrieval (vector +
  //    keyword + title-match, RRF-merged). Community filtering happens
  //    inside getRelevantChunks; same retrieval used by askEd + Review tab.
  let govDocContext = '';
  try {
    govDocContext = await getRelevantChunks(retrievalQuery, comm?.name);
  } catch (e) {
    console.warn('[assess] hybrid retrieval failed:', e.message);
  }

  // 4. Historical ACC decisions (semantic match) — uses a focused embedding
  //    of the retrieval query (cheaper than the long blob).
  let historyContext = '';
  try {
    const historyEmbed = await embed(retrievalQuery);
    if (historyEmbed) {
      const { data: matches } = await supabase.rpc('match_arc_decisions', {
        query_embedding: historyEmbed,
        community_id_in: application.community_id,
        match_count: 5,
        similarity_threshold: 0.6
      });
      if (matches && matches.length > 0) {
        historyContext = matches.map(m =>
          `[${(m.decision_type || '?').toUpperCase()}] ${m.decided_at || '(no date)'} — ${m.property_address || ''}: ${m.summary || m.project_description || ''}${m.conditions ? ` (conditions: ${m.conditions})` : ''}`
        ).join('\n');
      }
    }
  } catch (e) { console.warn('[assess] arc-history retrieval failed:', e.message); }

  // 5. Ed's playbook (semantic via existing helper if available)
  let playbookContext = '';
  try {
    const { getRelevantPlaybook, formatPlaybookContext } = require('../playbook');
    const entries = await getRelevantPlaybook(retrievalQuery, { matchCount: 6 });
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

Your role: produce a structured PRELIMINARY assessment + a draft response letter that the community manager will review, optionally edit, and send. You are NOT the final authority — the manager and committee are. Your output is NOT shown to the homeowner directly; the homeowner only sees a brief receipt and the manager's final reviewed letter.

COMMIT TO A DECISION — DO NOT PUNT:
You are not the manager's research assistant. You are the manager's first draft. Your job is to make a confident, well-reasoned recommendation on EVERY application. The manager will review and edit. Punting wastes their time and defeats the entire point of preliminary AI review.

Use "manual_review" ONLY when ALL of the following are true:
  (a) The project is unusual enough that no comparable historical decision exists in this community
  (b) The governing documents do not give clear guidance for this project type
  (c) Even an experienced manager would need to confer with the board before deciding
This should be rare — maybe 5% of applications.

Use "request_more_info" ONLY when a SPECIFIC critical fact is missing AND that fact materially changes the decision:
  - A structural addition or pool with NO site plan/survey showing location
  - A paint change with NO color reference (name, sample, photo, or "match existing")
  - A contractor-required project with NO contractor identified
Do NOT request more info for minor gaps the manager can fill in by phone, for things visible in attached photos, or because you'd like more comfort. If the homeowner gave you enough to make a judgment call the way an experienced manager would, MAKE THE CALL.

When historical decisions show a clear pattern for similar projects (e.g., "fence replacements at this community are routinely approved with standard conditions"), follow that pattern. Do NOT punt to manual_review just because you see a duplicate — that's a SIGNAL the standard treatment applies, not a reason for caution.

DIMENSIONAL RECONCILIATION — HARD RULE:
When dimensions appear in multiple places (homeowner-typed form, contractor estimate, architect-stamped drawings, survey), THE STAMPED ARCHITECT/ENGINEER DRAWING CONTROLS. The form is a homeowner estimate; the drawing is the instrument being approved. ALL derived calculations (square footage, area, lot coverage, distances) must flow from the controlling dimension set. NEVER cite two different dimensions for the same measurement within the same output. If you see a form-vs-drawing discrepancy, surface it in the summary AND state explicitly which set you are approving; in the draft_response, use only the controlling dimensions.

CRITICAL OUTPUT RULES:
- Return ONLY a single valid JSON object (no markdown fences, no commentary outside the JSON)
- Use the exact shape below
- Be CONCRETE — cite specific governing-doc sections when possible, but ONLY from documents that appeared in the RELEVANT GOVERNING DOCUMENTS section below. Do NOT invent citations or reference documents you haven't been shown.
- Treat HISTORICAL DECISIONS as STRONG PATTERN evidence — if 8 of the last 10 fence applications at this community were conditional approvals with standard conditions, recommend approve_with_conditions matching those standard conditions. The governing documents are the legal authority, but past decisions tell you how that authority is applied in practice at THIS community.
- "draft_response" should be in Bedrock's voice: warm, clear, respectful, lead with the decision, explain reasoning, offer path forward. Sign off "— Bedrock Association Management" (never a personal name).
- "draft_response" should be 120-350 words. Long form letters lose homeowners; short ones look hasty. Find the middle.
- "recommended_action" must match the language in "draft_response" — if you recommend approve, the letter must read as an approval; if deny, as a denial; if request_more_info, as a polite request for additional materials.

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

  // Parse retrieval fingerprint up-front so we can log/audit it even if
  // the AI call fails later.
  const fingerprint = parseRetrievalFingerprint(govDocContext);
  const contamination = summarizeContamination(fingerprint, comm?.name);
  console.log(`[applications] retrieval — community="${comm?.name}" chunks=${contamination.total} target=${contamination.community} law/general=${contamination.lawGeneral} wrong=${contamination.wrong} contamination=${(contamination.contaminationRatio * 100).toFixed(1)}%`);

  let completion = null;
  let parsed = null;
  let parseError = null;
  let rawText = '';
  try {
    completion = await anthropic.messages.create({
      model: ASSESSMENT_MODEL,
      max_tokens: ASSESSMENT_MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    });

    rawText = completion.content[0]?.text || '';
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      parseError = e.message;
    }
  } catch (err) {
    console.error('[applications] AI call failed:', err.message);
    const durationMs = Date.now() - t0;
    // Audit even the failed call so the manager queue sees it.
    if (!evalMode) {
      await writeAuditRow({
        application_id: application.id,
        community_id: application.community_id,
        trigger_source: triggerSource,
        retrieved_chunks: fingerprint,
        retrieved_chunk_count: fingerprint.length,
        contamination_ratio: contamination.contaminationRatio,
        community_chunk_count: contamination.community,
        law_general_chunk_count: contamination.lawGeneral,
        ai_model: ASSESSMENT_MODEL,
        ai_max_tokens: ASSESSMENT_MAX_TOKENS,
        ai_duration_ms: durationMs,
        guards_fired: [{ code: 'AI_CALL_FAILED', severity: 'block', detail: String(err.message || err).slice(0, 200) }],
        validators: {},
        validator_blockers: 1,
        validator_warnings: 0,
        final_status: 'failed',
        hold_reason: 'AI call failed — see server log',
      });
    }
    return { ok: false, error: safeErrorMessage(err), held_for_review: true };
  }

  const durationMs = Date.now() - t0;

  // Layer 1: pre-flight guards
  const guards = runPreflightGuards({ fingerprint, contamination, completion, parsed, parseError });
  const guardBlocked = guards.some((g) => g.severity === 'block');

  // Layer 2: cross-validators (only meaningful if we have parsed JSON)
  const validators = parsed ? runCrossValidators(parsed, fingerprint) : {};
  const { blockers: validatorBlockers, warnings: validatorWarnings } = tallyValidators(validators);

  const holdForReview = guardBlocked || validatorBlockers > 0 || !parsed;
  const finalStatus = parsed ? (holdForReview ? 'held_for_review' : 'shipped') : 'failed';
  const promptHash = crypto.createHash('sha256').update(userMessage).digest('hex').slice(0, 16);

  // Audit
  if (!evalMode) await writeAuditRow({
    application_id: application.id,
    community_id: application.community_id,
    trigger_source: triggerSource,
    retrieved_chunks: fingerprint,
    retrieved_chunk_count: fingerprint.length,
    contamination_ratio: contamination.contaminationRatio,
    community_chunk_count: contamination.community,
    law_general_chunk_count: contamination.lawGeneral,
    ai_model: ASSESSMENT_MODEL,
    ai_input_tokens: completion?.usage?.input_tokens || null,
    ai_output_tokens: completion?.usage?.output_tokens || null,
    ai_max_tokens: ASSESSMENT_MAX_TOKENS,
    ai_stop_reason: completion?.stop_reason || null,
    ai_duration_ms: durationMs,
    guards_fired: guards,
    validators,
    validator_blockers: validatorBlockers,
    validator_warnings: validatorWarnings,
    final_status: finalStatus,
    hold_reason: holdForReview
      ? (guards.filter((g) => g.severity === 'block').map((g) => g.code).join(',')
          || (validatorBlockers > 0 ? 'validator_blocker' : 'parse_failure'))
      : null,
    prompt_hash: promptHash,
    response_excerpt: (rawText || '').slice(0, 600),
  });

  // Persist to application_assessments (full history) — only if we have a parse
  if (parsed && !evalMode) {
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
      prompt_version: 'v2_hardened',
      triggered_by: triggerSource,
    });

    // Denormalize latest snapshot onto the application row. If held for
    // review, force the status into a manual_review-flavored bucket so the
    // queue surfaces it loud.
    await supabase.from('community_applications').update({
      assessment_status: holdForReview ? 'manual_review' : parsed.status,
      assessment_summary: parsed.summary,
      assessment_missing_items: parsed.missing_items || [],
      assessment_concerns: parsed.concerns || [],
      assessment_citations: parsed.citations || [],
      assessment_confidence: parsed.confidence,
      assessment_draft_response: parsed.draft_response || null,
      assessment_recommended_action: parsed.recommended_action || null,
      last_assessment_at: new Date().toISOString()
    }).eq('id', application.id);
  }

  return {
    ok: !!parsed,
    assessment: parsed,
    held_for_review: holdForReview,
    guards,
    validators,
    contamination,
    duration_ms: durationMs,
  };
}

// ============================================================================
// COMMUNITY LANDING — public page that lists all services + status check
// ----------------------------------------------------------------------------
// Returns everything the landing page needs in one call. Logo lookup is
// derived from a small static map (extend as new community logo files land
// in /public/logos/).
// ============================================================================

const COMMUNITY_LOGO_MAP = {
  'lpf':                    'lakes_of_pine_forest_logo.png',
  'lakes-of-pine-forest':   'lakes_of_pine_forest_logo.png',
  'canyon-gate':            'canyon_gate_logo.png',
  'canyon-gate-at-cinco-ranch': 'canyon_gate_logo.png',
  'waterview':              'waterview_logo.jpg',
  'waterview-estates':      'waterview_logo.jpg'
};

router.get('/community-landing/:slug', async (req, res) => {
  try {
    const slug = req.params.slug;
    const { data: comm, error } = await supabase
      .from('communities')
      .select(`
        id, name, slug, profile, total_lots,
        services:community_services(
          id, service_type, application_fee_usd, paid_by,
          fee_structure_notes, service_config, enabled
        )
      `)
      .eq('slug', slug)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (error) throw error;
    if (!comm) return res.status(404).json({ error: 'Community not found' });

    // Map schema fields to the UI-friendly names the front-end uses
    const activeServices = (comm.services || [])
      .filter(s => s.enabled !== false)
      .map(s => ({
        id: s.id,
        service_type: s.service_type,
        // UI uses these legacy names — keep stable to avoid client changes
        owner_payable_fee: s.application_fee_usd,
        fee_paid_by: s.paid_by,
        fee_structure_notes: s.fee_structure_notes,
        service_config: s.service_config,
        enabled: s.enabled
      }));

    // Look up upcoming events (next 60 days, public_signup_enabled)
    const future60 = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    const { data: events } = await supabase
      .from('events')
      .select('id, name, slug, event_type, location, scheduled_start_at, public_signup_enabled')
      .eq('community_id', comm.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('public_signup_enabled', true)
      .gte('scheduled_start_at', new Date().toISOString())
      .lte('scheduled_start_at', future60)
      .order('scheduled_start_at', { ascending: true })
      .limit(5);

    res.json({
      community: {
        id: comm.id,
        name: comm.name,
        slug: comm.slug,
        profile: comm.profile || {},
        logo_filename: COMMUNITY_LOGO_MAP[slug] || null
      },
      services: activeServices,
      upcoming_events: events || []
    });
  } catch (err) {
    console.error('[applications] community-landing failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

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
        services:community_services(id, service_type, application_fee_usd, paid_by, fee_structure_notes, service_config, enabled)
      `)
      .eq('slug', req.params.slug)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (error) throw error;
    if (!comm) return res.status(404).json({ error: 'Community not found' });

    const arcRow = (comm.services || []).find(s => s.service_type === 'arc');
    const arcService = arcRow ? {
      id: arcRow.id,
      service_type: arcRow.service_type,
      owner_payable_fee: arcRow.application_fee_usd,
      fee_paid_by: arcRow.paid_by,
      fee_structure_notes: arcRow.fee_structure_notes,
      service_config: arcRow.service_config,
      enabled: arcRow.enabled
    } : null;
    res.json({
      community: { id: comm.id, name: comm.name, slug: comm.slug, profile: comm.profile },
      service: arcService
    });
  } catch (err) {
    console.error('[applications] public-meta failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /api/applications/public/:slug/submit — homeowner submits, AI assesses instantly
// Multipart form: text fields for submitter + application_data (JSON-encoded)
// + signed_by_name + agreed_to_indemnification, plus file fields
// 'documents' (PDFs — survey, plans, contractor bid) and 'photos' (images).
router.post('/public/:slug/submit', upload.any(), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.submitter_name || !b.submitter_email || !b.property_address) {
      return res.status(400).json({ error: 'submitter_name, submitter_email, and property_address are required' });
    }
    if (!b.signed_by_name || !b.signed_by_name.trim() || b.signed_by_name.trim().length < 2) {
      return res.status(400).json({ error: 'Electronic signature (full legal name) is required to submit.' });
    }
    if (String(b.agreed_to_indemnification || '').toLowerCase() !== 'true') {
      return res.status(400).json({ error: 'You must acknowledge the indemnification terms before submitting.' });
    }

    // application_data may arrive as a JSON-encoded string (from multipart) or
    // as individual fields. Prefer the JSON blob; fall back to assembling from
    // top-level field names that match the old schema.
    let applicationData = {};
    if (b.application_data) {
      try { applicationData = JSON.parse(b.application_data); } catch (_) { applicationData = {}; }
    }
    // Stamp the signature + ack into application_data so it's preserved with the
    // record and exposed to the manager / AI assessment.
    applicationData.signature = {
      signed_by_name: b.signed_by_name.trim(),
      signed_at: new Date().toISOString(),
      agreed_to_indemnification: true,
    };

    // Resolve community
    const { data: comm } = await supabase
      .from('communities')
      .select('id, name')
      .eq('slug', req.params.slug)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (!comm) return res.status(404).json({ error: 'Community not found' });

    // Resolve service (arc — schema constraint uses 'arc', not 'arc_application')
    const { data: service } = await supabase
      .from('community_services')
      .select('id, service_type, application_fee_usd, paid_by, fee_structure_notes, service_config, arc_ai_homeowner_visible')
      .eq('community_id', comm.id)
      .eq('service_type', 'arc')
      .maybeSingle();
    if (!service) {
      return res.status(400).json({ error: 'This community has not enabled ARC applications. Contact management.' });
    }

    // Reference number (e.g., LPF-ARC-2026-0042)
    const prefix = (comm.name || 'APP').replace(/[^A-Z]/gi, '').slice(0, 3).toUpperCase() + '-ARC';
    const reference = await nextReferenceNumber(comm.id, 'arc', prefix);

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

    // Determine fee — schema uses paid_by + application_fee_usd
    let calculatedFee = null;
    let feeBasis = null;
    let paymentStatus = 'not_required';
    if (service.paid_by === 'owner' && service.application_fee_usd != null) {
      calculatedFee = Number(service.application_fee_usd);
      feeBasis = `Owner-paid ARC fee: $${calculatedFee.toFixed(2)}`;
      paymentStatus = 'pending';
    }

    // Insert application
    const insert = {
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id: comm.id,
      community_service_id: service.id,
      reference_number: reference,
      service_type: 'arc',
      submitter_name: b.submitter_name,
      submitter_email: b.submitter_email,
      submitter_phone: b.submitter_phone || null,
      property_address: b.property_address,
      property_unit: b.property_unit || null,
      property_address_id: propertyAddressId,
      application_data: applicationData,
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

    // Save uploaded files to Supabase storage + index in application_attachments.
    // 'documents' fieldname → attachment_type='site_plan' (good default for surveys,
    // plans, contractor bids). 'photos' fieldname → attachment_type='photo_current'.
    const files = req.files || [];
    for (const f of files) {
      try {
        const isDoc = f.fieldname === 'documents';
        const isPhoto = f.fieldname === 'photos';
        if (!isDoc && !isPhoto) continue;
        const safeName = (f.originalname || 'upload')
          .replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'upload';
        const storagePath = `applications/${app.id}/${Date.now()}_${safeName}`;
        const { error: stErr } = await supabase.storage
          .from('documents')
          .upload(storagePath, f.buffer, { contentType: f.mimetype, upsert: false });
        if (stErr) { console.warn('[applications] file upload failed:', stErr.message); continue; }
        await supabase.from('application_attachments').insert({
          application_id: app.id,
          attachment_type: isDoc ? 'site_plan' : 'photo_current',
          file_path: storagePath,
          original_filename: f.originalname,
          file_size_bytes: f.size,
          file_mime_type: f.mimetype,
        });
      } catch (e) {
        console.warn('[applications] attachment record failed:', e.message);
      }
    }

    // Run AI assessment SYNCHRONOUSLY so the manager queue is populated
    // before the homeowner navigates away. The HOMEOWNER does NOT see the
    // full AI output — they see a clean receipt + 48hr SLA. The AI output
    // is for the manager (and optionally, per-community, for the homeowner
    // once the community has been validated in production for that exposure).
    const assessmentResult = await runAssessment(app, { triggerSource: 'public_submit' });

    // Receipt for the homeowner — a brief, neutral acknowledgment.
    const receipt = homeownerReceiptFromAssessment(
      assessmentResult.assessment,
      assessmentResult.held_for_review || !assessmentResult.ok
    );

    // Per-community flag: do we want to expose the AI's assessment block
    // to this community's homeowners? Default FALSE (migration 118).
    const homeownerVisible =
      service.arc_ai_homeowner_visible === true &&
      assessmentResult.ok &&
      !assessmentResult.held_for_review;

    res.json({
      ok: true,
      reference_number: reference,
      application_id: app.id,
      status_url: `/apply/status/${encodeURIComponent(reference)}`,
      receipt,
      // assessment block is only included when the community has opted in
      // AND the assessment passed all guards/validators. Otherwise null.
      assessment: homeownerVisible ? assessmentResult.assessment : null,
    });
  } catch (err) {
    console.error('[applications] submit failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// FOB / KEY REQUESTS — separate flow, transactional, no AI assessment
// ----------------------------------------------------------------------------
// Per Ed: fobs are transactional, not judgment-driven. They don't belong in
// the ARC pipeline (would dilute the AI's precedent library with admin
// noise). Same community_applications table but service_type='key_fob',
// no AI assessment, simpler manager workflow.
// ============================================================================

// GET /api/applications/public/:slug/fob-meta — what the fob form needs
// "Fob" here maps to pool_amenity or gate_vehicle in the schema. We pick the
// first enabled one. Communities that only have ARC enabled return 404.
router.get('/public/:slug/fob-meta', async (req, res) => {
  try {
    const { data: comm, error } = await supabase
      .from('communities')
      .select(`
        id, name, slug, profile,
        services:community_services(id, service_type, application_fee_usd, paid_by, fee_structure_notes, service_config, enabled)
      `)
      .eq('slug', req.params.slug)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (error) throw error;
    if (!comm) return res.status(404).json({ error: 'Community not found' });

    // "Fob" can be pool_amenity (pool fob) or gate_vehicle (gate fob).
    // Pick the first enabled match — pool wins ties.
    const candidates = ['pool_amenity', 'gate_vehicle'];
    const fobRow = candidates
      .map(t => (comm.services || []).find(s => s.service_type === t && s.enabled !== false))
      .find(Boolean);
    if (!fobRow) {
      return res.status(404).json({ error: 'This community does not offer key/fob requests.' });
    }

    res.json({
      community: { id: comm.id, name: comm.name, slug: comm.slug, profile: comm.profile || {} },
      service: {
        id: fobRow.id,
        service_type: fobRow.service_type,
        owner_payable_fee: fobRow.application_fee_usd,
        fee_paid_by: fobRow.paid_by,
        fee_structure_notes: fobRow.fee_structure_notes,
        service_config: fobRow.service_config
      }
    });
  } catch (err) {
    console.error('[applications] fob-meta failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /api/applications/public/:slug/submit-fob — submit a fob request
// Body: { submitter_name, submitter_email, submitter_phone?, property_address,
//          application_data: { request_type, num_fobs, reason?, mailing_instructions? } }
router.post('/public/:slug/submit-fob', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.submitter_name || !b.submitter_email || !b.property_address) {
      return res.status(400).json({ error: 'submitter_name, submitter_email, and property_address are required' });
    }

    const { data: comm } = await supabase
      .from('communities')
      .select('id, name')
      .eq('slug', req.params.slug)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (!comm) return res.status(404).json({ error: 'Community not found' });

    // Look for pool_amenity first, then gate_vehicle. This is what "fob"
    // maps to in this schema.
    const fobCandidates = ['pool_amenity', 'gate_vehicle'];
    let service = null;
    for (const t of fobCandidates) {
      const { data } = await supabase
        .from('community_services')
        .select('id, service_type, application_fee_usd, paid_by, fee_structure_notes, service_config')
        .eq('community_id', comm.id)
        .eq('service_type', t)
        .eq('enabled', true)
        .maybeSingle();
      if (data) { service = data; break; }
    }
    if (!service) {
      return res.status(400).json({ error: 'This community has not enabled fob requests. Contact management.' });
    }

    // Reference number — e.g., LPF-FOB-2026-0042
    const prefix = (comm.name || 'APP').replace(/[^A-Z]/gi, '').slice(0, 3).toUpperCase() + '-FOB';
    const reference = await nextReferenceNumber(comm.id, service.service_type, prefix);

    const appData = b.application_data || {};
    const numFobs = Math.max(1, Math.min(10, Number(appData.num_fobs) || 1));
    const requestType = appData.request_type || 'replacement';

    // Fee calculation: per-fob fee × count, but new-owner first fob is often free
    // per the service_config (the schema example shows `first_unit_free`).
    let calculatedFee = null;
    let feeBasis = null;
    if (service.paid_by === 'owner') {
      const perFob = Number(service.application_fee_usd) || 0;
      const cfg = service.service_config || {};
      const firstFree = (cfg.first_unit_free || cfg.first_fob_free) && requestType === 'new_owner';
      const billable = firstFree ? Math.max(0, numFobs - 1) : numFobs;
      calculatedFee = perFob * billable;
      feeBasis = billable === 0
        ? 'First fob complimentary for new owners'
        : `${billable} × $${perFob.toFixed(2)} = $${calculatedFee.toFixed(2)}`;
    }

    const insert = {
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id: comm.id,
      community_service_id: service.id,
      reference_number: reference,
      service_type: service.service_type,
      submitter_name: b.submitter_name,
      submitter_email: b.submitter_email,
      submitter_phone: b.submitter_phone || null,
      property_address: b.property_address,
      property_unit: b.property_unit || null,
      application_data: {
        request_type: requestType,
        num_fobs: numFobs,
        reason: appData.reason || null,
        mailing_instructions: appData.mailing_instructions || null,
        notes: appData.notes || null
      },
      final_status: 'pending_committee_review',
      submitted_at: new Date().toISOString(),
      calculated_fee_usd: calculatedFee,
      fee_basis: feeBasis,
      payment_status: (calculatedFee && calculatedFee > 0) ? 'pending' : 'not_required',
      client_ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() || null,
      user_agent: req.headers['user-agent'] || null
    };

    const { data: app, error } = await supabase
      .from('community_applications')
      .insert(insert)
      .select()
      .single();
    if (error) throw error;

    res.json({
      ok: true,
      reference_number: reference,
      application_id: app.id,
      status_url: `/apply/status/${encodeURIComponent(reference)}`,
      calculated_fee_usd: calculatedFee,
      fee_basis: feeBasis
    });
  } catch (err) {
    console.error('[applications] fob submit failed:', err.message);
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

// GET /api/applications/:id — full detail (assessments + responses + audit)
router.get('/:id', async (req, res) => {
  try {
    const [appResp, assessResp, respResp, attachResp, auditResp] = await Promise.all([
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
        .order('display_order'),
      // Latest audit row — surfaces guards/validators/contamination/etc.
      // Defensive: returns empty if migration 118 hasn't been applied yet.
      supabase.from('acc_assessment_audit')
        .select('*')
        .eq('application_id', req.params.id)
        .order('ran_at', { ascending: false })
        .limit(1)
        .maybeSingle()
        .then((r) => r, () => ({ data: null, error: null })),
    ]);

    if (appResp.error) throw appResp.error;
    if (!appResp.data) return res.status(404).json({ error: 'Application not found' });

    res.json({
      application: appResp.data,
      assessments: assessResp.data || [],
      responses: respResp.data || [],
      attachments: attachResp.data || [],
      latest_audit: auditResp?.data || null
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

module.exports = { router, runAssessment };
