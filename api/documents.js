// ============================================================================
// Documents Tracker
// ----------------------------------------------------------------------------
// Endpoints under /api/documents for Bedrock's canonical document library.
//
//   POST /upload          single PDF, auto-extract metadata, dedup, save
//   POST /bulk-upload     multiple PDFs at once; reports dedups + extractions
//   GET  /                list documents (filterable, ?include_legacy=true)
//   GET  /matrix          per-community document matrix view
//   GET  /:id             single document with extracted fields
//   GET  /:id/download    serve the PDF file
//   POST /query           natural-language retrieval ("give me 2026 LPF Budget")
//   PATCH /:id            update document metadata (push state, notes, status)
//   DELETE /:id           remove a document (and its file from storage)
//   GET  /duplicates      list pending duplicate groups
//   POST /duplicates/:id/resolve   accept keep/delete decisions
//   POST /:id/supersede   mark this doc as superseded by another (library or legacy)
//   POST /legacy/categorize        promote a legacy doc into library_documents
//                                   via the AI metadata extraction from chunks
//   GET  /legacy                   list legacy docs (grouped, with chunk counts)
//
// Three-repository reality:
//   - library_documents   = new Documents Tracker (writes go here)
//   - documents (legacy)  = original askEd vector index (chunked, reads only)
//   - knowledge_documents = Help layer (reads only — pulled via /api/help)
// Reads UNIFY across these; writes always target library_documents.
//
// Design principles applied:
//   - Frustration Test: drop a PDF, get a clean result without typing metadata
//   - Calm Test: dedup surfaces before user has to discover it manually
//   - Proactive Guidance: extraction notes explain why categorization may be uncertain
//   - askEd template: structured output even for non-Help responses (e.g., dedup explanations)
// ============================================================================

const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const multer = require('multer');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const STORAGE_BUCKET = 'documents';

// Library → askEd-chunks bridge. Auto-runs after every upload + exposed
// here as manual reindex/coverage routes for one-time backfill.
const { indexLibraryDoc } = require('../lib/library_reindex');

const router = express.Router();

// ----------------------------------------------------------------------------
// Initialization: ensure storage bucket exists (called lazily on first upload)
// ----------------------------------------------------------------------------
let bucketEnsured = false;
async function ensureBucket() {
  if (bucketEnsured) return;
  try {
    const { data: buckets } = await supabase.storage.listBuckets();
    if (!(buckets || []).find(b => b.name === STORAGE_BUCKET)) {
      const { error } = await supabase.storage.createBucket(STORAGE_BUCKET, { public: false });
      if (error && !String(error.message).match(/already exists/i)) throw error;
    }
    bucketEnsured = true;
  } catch (err) {
    console.warn('[documents] bucket ensure warning:', err.message);
    // Don't crash startup; admin can create bucket manually in Supabase dashboard
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const STANDARD_CATEGORIES = [
  'annual_budget', 'insurance_dec_page', 'annual_board_meeting_minutes',
  'regular_meeting_minutes', 'reserve_study', 'reserve_report',
  'bylaws', 'declaration_ccrs', 'rules_and_regulations', 'legal_update',
  'resolutions_and_policies', 'articles_of_incorporation',
  'annual_financial_statements', 'current_unaudited_financials',
  'w9', 'welcome_package', 'engineers_inspection_report',
  'litigation', 'design_document', 'special_assessments',
  'unit_ledger', 'management_agreement',
  // Resident-facing form templates (added in migration 017)
  'arc_application', 'key_fob_form', 'forms_and_applications',
  // Vendor management agreements (pool, landscape, security, pest, etc.)
  'vendor_contract',
  // Vendor invoices ingested via reserve invoice review queue
  'vendor_invoice',
  'other'
];

const DOC_EXTRACTION_PROMPT = `You are extracting metadata from a community association (HOA) document. Read the PDF and return a JSON object with EXACTLY this shape:

{
  "community_name": "string (best-guess of the community/association name from document content)",
  "community_legal_name": "string (full legal name if found, e.g., 'Lakes of Pine Forest Homeowners Association, Inc.')",
  "category": "one of: annual_budget | insurance_dec_page | annual_board_meeting_minutes | regular_meeting_minutes | reserve_study | reserve_report | bylaws | declaration_ccrs | rules_and_regulations | resolutions_and_policies | articles_of_incorporation | annual_financial_statements | current_unaudited_financials | w9 | welcome_package | engineers_inspection_report | litigation | design_document | special_assessments | unit_ledger | management_agreement | arc_application | key_fob_form | forms_and_applications | other. NOTE on forms: arc_application = blank Architectural Review / ACC application TEMPLATE residents fill out. key_fob_form = key fob or access card request TEMPLATE. forms_and_applications = catch-all for OTHER blank form templates (lease disclosures, pet registration, pool access requests, violation notice templates, etc.). These are template forms, NOT submitted/completed instances. The design_document category is for architectural GUIDELINES (the rules); arc_application is for the application FORM owners use to request approval under those rules.",
  "period_label": "string (e.g., '2026', '2026-04', 'FY2025-2026', etc.) — what fiscal year/period this document represents",
  "effective_date": "YYYY-MM-DD or null",
  "expiration_date": "YYYY-MM-DD or null (only for documents that have an explicit expiration like insurance policies)",
  "approval_status": "approved | draft | proposed | signed | unsigned | null",
  "title": "human-friendly title for this document (max 80 chars)",
  "page_count": <integer>,
  "extracted_fields": {
    /* Structured fields specific to this document type. Examples:
       For annual_budget: { total_revenue: 1198248, total_expense: 1382313, fiscal_year_start: "2026-01-01", fiscal_year_end: "2026-12-31" }
       For insurance_dec_page: { carrier: "Travelers", policy_number: "X", effective_date: "2026-01-01", expiration_date: "2026-12-31", premium: 42500, gl_per_occurrence: 1000000, gl_aggregate: 2000000, do_limit: 1000000 }
       For reserve_study: { study_date: "2024-06-01", recommended_balance: 1500000, current_balance: 1200000 }
       For meeting_minutes: { meeting_date: "2026-04-15", meeting_type: "regular", agenda_topics: [...], decisions: [...] }
       For management_agreement: { effective_date: "2023-08-01", monthly_fee: 2400, escalator: "max of CPI or 5%" }
       Empty object {} is fine if nothing specific extracted.
    */
  },
  "extraction_confidence": "high | medium | low",
  "extraction_notes": "Free text. Anything unusual you noticed about this document: ambiguous category, unclear period, multiple possible interpretations, scan quality issues.",
  "amendment": {
    "is_amendment": true | false,
    "amends_document_title_guess": "string or null — your best guess at the title of the original document this amends (e.g., 'Declaration of Covenants, Conditions and Restrictions'). null if not an amendment.",
    "amended_sections": ["3.3", "5.1(a)"] /* array of section identifiers this amendment touches; empty array means whole-document supersession */,
    "amendment_effective_date": "YYYY-MM-DD or null",
    "amendment_reasoning": "Brief explanation of how you concluded this is an amendment, or null if not an amendment. Look for cues like: 'Amendment to', 'First Amendment', 'Supersedes', 'Hereby amends Section X', 'replaces Section Y', explicit cross-references to a parent document, restatement of specific section numbers with new language."
  }
}

Rules:
- Use null (not empty string) for fields you cannot find.
- Money values are NUMBERS, not strings.
- Dates are ISO YYYY-MM-DD only.
- If you cannot confidently determine the community, set community_name to null and explain in extraction_notes.
- If the document type doesn't cleanly match any category, use "other" and explain in extraction_notes.
- Be conservative on confidence: only "high" if the document is clearly a standard HOA document with all key fields present and legible.

Return ONLY the JSON object, no preamble, no code fence.`;

async function extractDocumentMetadata(pdfBuffer) {
  const pdfBase64 = pdfBuffer.toString('base64');
  // Retry up to 4 times with exponential backoff on 429 rate-limit errors.
  // Anthropic's input token cap is 30K/min on lower tiers — bulk PDF uploads
  // burn through this fast. Backoff waits 30s, 60s, 90s, 120s.
  const RETRY_DELAYS_MS = [30000, 60000, 90000, 120000];
  let lastError = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const completion = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
            { type: 'text', text: DOC_EXTRACTION_PROMPT }
          ]
        }]
      });
      const text = completion.content?.[0]?.text || '';
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      return { parsed: JSON.parse(cleaned), usage: completion.usage };
    } catch (err) {
      lastError = err;
      // Only retry on rate-limit (429) or overload (529) errors
      const isRetryable = err.status === 429 || err.status === 529 ||
                          /rate_limit|overloaded/i.test(err.message || '');
      if (!isRetryable || attempt >= RETRY_DELAYS_MS.length) throw err;
      const delay = RETRY_DELAYS_MS[attempt];
      console.warn(`[documents] the AI rate-limited, retrying in ${delay/1000}s (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

function buildNormalizedFilename({ community_name, category_display, period_label, approval_status }) {
  const parts = [];
  if (community_name) parts.push(community_name);
  if (category_display) parts.push(category_display);
  if (period_label) parts.push(period_label);
  if (approval_status && approval_status !== 'null') {
    parts.push(approval_status.charAt(0).toUpperCase() + approval_status.slice(1));
  }
  if (parts.length === 0) parts.push('Document');
  return parts.join(' - ').replace(/[/\\?%*:|"<>]/g, '_') + '.pdf';
}

// Token-set Jaccard similarity for fuzzy name matching.
// Tolerates singular/plural ('Lake'/'Lakes'), abbreviations,
// trailing entity types ('HOA', 'Inc.'), word reorderings.
function nameJaccard(a, b) {
  const tokenize = s => new Set(
    (s || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter(t => t.length > 2 && !['the','and','for','inc','llc','hoa','homeowners','association'].includes(t))
  );
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  const inter = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return inter / union;
}

async function findCommunityByName(name) {
  if (!name) return null;
  // Try exact first
  let { data } = await supabase
    .from('communities')
    .select('id, name, legal_name')
    .eq('management_company_id', BEDROCK_MGMT_CO_ID)
    .ilike('name', name)
    .maybeSingle();
  if (data) return data;
  // Try substring (legacy behavior)
  ({ data } = await supabase
    .from('communities')
    .select('id, name, legal_name')
    .eq('management_company_id', BEDROCK_MGMT_CO_ID)
    .ilike('name', `%${name}%`)
    .limit(1));
  if (data && data.length > 0) return data[0];
  ({ data } = await supabase
    .from('communities')
    .select('id, name, legal_name')
    .eq('management_company_id', BEDROCK_MGMT_CO_ID)
    .ilike('legal_name', `%${name}%`)
    .limit(1));
  if (data && data.length > 0) return data[0];
  // Fuzzy match across all communities — fixes singular/plural typos, abbreviations,
  // partial matches that substring doesn't catch
  const { data: all } = await supabase
    .from('communities')
    .select('id, name, legal_name')
    .eq('management_company_id', BEDROCK_MGMT_CO_ID);
  if (!all || all.length === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const c of all) {
    const score = Math.max(
      nameJaccard(name, c.name),
      nameJaccard(name, c.legal_name)
    );
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  // Threshold of 0.4 — generous because community names are short and the AI often
  // drops a letter or pluralizes wrong. False positives are caught by the user
  // reviewing the upload card.
  return bestScore >= 0.4 ? best : null;
}

async function getPredecessorContext(communityId, effectiveDate) {
  if (!communityId || !effectiveDate) return { mgmt: 'Unknown', predecessor: null };
  const { data: history } = await supabase
    .from('community_management_history')
    .select('management_company, start_date, end_date')
    .eq('community_id', communityId)
    .order('start_date', { ascending: true });
  if (!history || history.length === 0) return { mgmt: 'Unknown', predecessor: null };
  const eff = new Date(effectiveDate);
  for (const h of history) {
    const start = new Date(h.start_date);
    const end = h.end_date ? new Date(h.end_date) : new Date('2099-12-31');
    if (eff >= start && eff <= end) {
      return {
        mgmt: h.management_company === 'Bedrock' ? 'Bedrock' : 'Predecessor',
        predecessor: h.management_company === 'Bedrock' ? null : h.management_company
      };
    }
  }
  // Effective date before any known history record
  return { mgmt: 'Predecessor', predecessor: history[0].management_company === 'Bedrock' ? null : history[0].management_company };
}

// ----------------------------------------------------------------------------
// POST /api/documents/upload  — single file
// ----------------------------------------------------------------------------
router.post('/upload', upload.single('pdf'), async (req, res) => {
  const t0 = Date.now();
  await ensureBucket();
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded (expected field "pdf")' });
  if (req.file.mimetype !== 'application/pdf') {
    return res.status(400).json({ error: `Unsupported file type: ${req.file.mimetype}` });
  }

  try {
    // 1) Hash check for byte-level duplicate
    const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const { data: existing } = await supabase
      .from('library_documents')
      .select('id, title, status, file_name_normalized, community_id, category')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('file_hash', fileHash)
      .maybeSingle();
    if (existing) {
      return res.status(409).json({
        duplicate: true,
        dup_type: 'byte_identical',
        message: `This exact file is already in trustEd as "${existing.title || existing.file_name_normalized}" (status: ${existing.status}). No action needed.`,
        existing
      });
    }

    // 2) Extract metadata via the AI
    const { parsed, usage } = await extractDocumentMetadata(req.file.buffer);

    // 3) Match community — caller can LOCK the community via form field
    //    community_id (e.g., the user picked "Lock to: Waterview" in the upload
    //    UI). Locking overrides the AI's detection — useful when the doc
    //    doesn't name the community internally (recorded amendments,
    //    insurance policies, generic templates).
    let community = null;
    const lockedCommunityId = (req.body?.community_id || '').trim();
    if (lockedCommunityId) {
      const { data: c } = await supabase
        .from('communities')
        .select('id, name, legal_name')
        .eq('id', lockedCommunityId)
        .eq('management_company_id', BEDROCK_MGMT_CO_ID)
        .maybeSingle();
      community = c || null;
    }
    if (!community) {
      community = await findCommunityByName(parsed.community_name);
    }
    const { data: catRow } = await supabase
      .from('document_categories')
      .select('display_name')
      .eq('category', STANDARD_CATEGORIES.includes(parsed.category) ? parsed.category : 'other')
      .maybeSingle();
    const categoryDisplay = catRow?.display_name || parsed.category;

    // 4) Determine predecessor context based on effective_date and management history
    const provenance = await getPredecessorContext(community?.id, parsed.effective_date);

    // 5) Build normalized filename
    const fileNameNormalized = buildNormalizedFilename({
      community_name: community?.name || parsed.community_name || 'Unknown Community',
      category_display: categoryDisplay,
      period_label: parsed.period_label,
      approval_status: parsed.approval_status
    });

    // 6) Pre-insert: Check for semantic duplicate (same community + category + period + similar title)
    // Title comparison prevents false-positives for legitimately distinct documents that
    // share community/category/period but are different things (e.g., separate GL / D&O /
    // Umbrella / Crime insurance policies all categorized as 'insurance_dec_page').
    let semanticDup = null;
    let legacyDup = null;  // separately tracked: a likely-matching legacy doc (informational)
    if (community?.id && parsed.category && parsed.period_label) {
      const { data: candidates } = await supabase
        .from('library_documents')
        .select('id, title, file_name_normalized, status, uploaded_at')
        .eq('management_company_id', BEDROCK_MGMT_CO_ID)
        .eq('community_id', community.id)
        .eq('category', STANDARD_CATEGORIES.includes(parsed.category) ? parsed.category : 'other')
        .eq('period_label', parsed.period_label)
        .eq('status', 'current');
      // Compare titles: only flag as dup if titles are similar enough that they
      // describe the same logical document.
      const normalize = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const newTitleNorm = normalize(parsed.title);
      const newTokens = new Set(newTitleNorm.split(' ').filter(t => t.length > 2));
      for (const c of (candidates || [])) {
        const existingNorm = normalize(c.title);
        const existingTokens = new Set(existingNorm.split(' ').filter(t => t.length > 2));
        // Token Jaccard similarity
        const intersect = [...newTokens].filter(t => existingTokens.has(t)).length;
        const union = new Set([...newTokens, ...existingTokens]).size || 1;
        const similarity = intersect / union;
        // Fire dup only if titles are 60%+ similar OR either title is empty/null
        if (similarity >= 0.6 || newTokens.size === 0 || existingTokens.size === 0) {
          semanticDup = c;
          break;
        }
      }
    }

    // 6c) Form supersession check (forms-only path).
    // For resident-facing form categories, a new upload that matches an
    // existing current form (same community + category, similar title)
    // is treated as a NEW VERSION that supersedes the old one. Unlike the
    // semantic_dup flow (which holds the new doc as 'draft' for user review),
    // this auto-promotes new to 'current' and demotes old to 'superseded' —
    // because forms have ONE current version per community by definition.
    // Threshold is looser (0.3 vs 0.6) for the same reason.
    const FORM_CATEGORIES = ['arc_application', 'key_fob_form', 'forms_and_applications'];
    let supersedeTargetId = null;
    let supersedeTargetSnapshot = null;
    if (community?.id && FORM_CATEGORIES.includes(parsed.category) && !semanticDup) {
      const { data: priorVersions } = await supabase
        .from('library_documents')
        .select('id, title, file_name_normalized, uploaded_at, period_label')
        .eq('management_company_id', BEDROCK_MGMT_CO_ID)
        .eq('community_id', community.id)
        .eq('category', parsed.category)
        .eq('status', 'current');
      if (priorVersions && priorVersions.length > 0) {
        const normalize = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const newTokens = new Set(normalize(parsed.title).split(' ').filter(t => t.length > 2));
        let bestMatch = null;
        let bestScore = 0;
        for (const p of priorVersions) {
          const existingTokens = new Set(normalize(p.title).split(' ').filter(t => t.length > 2));
          if (newTokens.size === 0 || existingTokens.size === 0) {
            // If either title is empty, ANY same-community-same-category form is a likely supersession
            bestMatch = p;
            bestScore = 1.0;
            break;
          }
          const intersect = [...newTokens].filter(t => existingTokens.has(t)).length;
          const union = new Set([...newTokens, ...existingTokens]).size || 1;
          const sim = intersect / union;
          if (sim > bestScore) { bestScore = sim; bestMatch = p; }
        }
        // Forms threshold: 0.3 (looser than general 0.6) because each form
        // category typically has only one current version per community.
        if (bestScore >= 0.3) {
          supersedeTargetId = bestMatch.id;
          supersedeTargetSnapshot = bestMatch;
        }
      }
    }

    // 6b) Legacy table cross-check: did Ed upload this same logical doc before
    // through the original askEd pipeline? Match by community name + filename
    // fuzzy similarity (legacy table has no category/period — just filename + chunks).
    if (community?.name) {
      try {
        const { data: legacyRows } = await supabase
          .from('v_legacy_documents_summary')
          .select('legacy_id, filename, chunk_count, is_migrated')
          .eq('community_name', community.name)
          .eq('is_migrated', false)  // already-migrated legacy docs don't dup-warn
          .limit(50);
        const newTitle = parsed.title || req.file.originalname || '';
        let bestScore = 0;
        let best = null;
        for (const lr of (legacyRows || [])) {
          // Compare against both filename and the new title
          const score = Math.max(
            nameJaccard(newTitle, lr.filename || ''),
            nameJaccard(req.file.originalname || '', lr.filename || '')
          );
          if (score > bestScore) { bestScore = score; best = lr; }
        }
        // 0.5 threshold — slightly stricter than community matching because
        // false positives are more annoying here (user has to dismiss).
        if (bestScore >= 0.5) legacyDup = { ...best, similarity: bestScore };
      } catch (e) {
        console.warn('[documents] legacy dup check skipped:', e.message);
      }
    }

    // 7) Upload file to Supabase Storage (skip if storage isn't enabled — fall back to metadata only)
    const docId = crypto.randomUUID();
    const filePath = `${BEDROCK_MGMT_CO_ID}/${community?.id || 'unassigned'}/${parsed.category || 'other'}/${docId}.pdf`;
    let uploadedFile = false;
    try {
      const { error: storageErr } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(filePath, req.file.buffer, { contentType: 'application/pdf', upsert: false });
      if (!storageErr) uploadedFile = true;
      else console.warn('[documents] storage upload skipped:', storageErr.message);
    } catch (sErr) {
      console.warn('[documents] storage exception:', sErr.message);
    }

    // 8) Insert document row
    const { data: doc, error: insErr } = await supabase
      .from('library_documents')
      .insert({
        id: docId,
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id: community?.id || null,
        category: STANDARD_CATEGORIES.includes(parsed.category) ? parsed.category : 'other',
        period_label: parsed.period_label || null,
        effective_date: parsed.effective_date || null,
        expiration_date: parsed.expiration_date || null,
        approval_status: parsed.approval_status || null,
        status: semanticDup ? 'draft' : 'current',   // hold as draft if there's already a current for this period
        title: parsed.title || fileNameNormalized.replace('.pdf', ''),
        file_name_original: req.file.originalname,
        file_name_normalized: fileNameNormalized,
        file_path: uploadedFile ? filePath : null,
        file_hash: fileHash,
        file_size_bytes: req.file.size,
        page_count: parsed.page_count || null,
        created_by_mgmt_company: provenance.mgmt,
        predecessor_name: provenance.predecessor,
        extraction_model: 'claude-sonnet-4-5',
        extraction_confidence: parsed.extraction_confidence || 'medium',
        extraction_notes: parsed.extraction_notes || null,
        // Queue for background indexing. Null when there's no file in storage
        // (extraction-only upload) so the scheduler won't try to index nothing.
        index_status: uploadedFile ? 'pending' : null
      })
      .select()
      .single();
    if (insErr) {
      // The byte-dedup check at step 1 SHOULD have caught any same-hash duplicate.
      // If we still hit the unique constraint here, it's a race condition (two
      // simultaneous uploads of the same file) or a stale-read scenario.
      // Either way: surface it as a friendly 409 rather than a raw SQL 500.
      if (insErr.code === '23505' && /file_hash|ux_docs_file_hash/i.test(insErr.message || '')) {
        const { data: dup } = await supabase
          .from('library_documents')
          .select('id, title, status, file_name_normalized, community_id, category')
          .eq('management_company_id', BEDROCK_MGMT_CO_ID)
          .eq('file_hash', fileHash)
          .maybeSingle();
        // Clean up the storage upload we just did since the DB row didn't land
        if (uploadedFile) {
          try { await supabase.storage.from(STORAGE_BUCKET).remove([filePath]); } catch (_) { /* swallow */ }
        }
        return res.status(409).json({
          duplicate: true,
          dup_type: 'byte_identical_race',
          message: `This file is already in trustEd as "${dup?.title || dup?.file_name_normalized || 'an existing document'}" (status: ${dup?.status || 'unknown'}). No action needed.`,
          existing: dup || null
        });
      }
      throw insErr;
    }

    // 9) Store extracted fields
    if (parsed.extracted_fields && Object.keys(parsed.extracted_fields).length > 0) {
      await supabase.from('document_extracted_fields').insert({
        document_id: doc.id,
        fields: parsed.extracted_fields
      });
    }

    // 9b) Form supersession execution.
    // If this upload was identified as a new version of an existing form,
    // mark the prior version as 'superseded' and link the chain. The new
    // doc is already 'current' (the default). Forms-only auto-flow — for
    // other categories, supersession remains a user-confirmed action.
    if (supersedeTargetId) {
      await supabase
        .from('library_documents')
        .update({
          status: 'superseded',
          superseded_at: new Date().toISOString(),
          superseded_by_id: doc.id
        })
        .eq('id', supersedeTargetId)
        .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    }

    // 9b) Governing-doc amendment supersession (Ed 2026-06-18, migration 228).
    // If the AI extractor flagged this upload as an amendment to an existing
    // doc, find the most likely parent in the same community by fuzzy title
    // similarity and write the suggestion to the amendment log. We do NOT
    // auto-confirm the link -- it shows up in the operator UI as a pending
    // suggestion until a human clicks Confirm. That's the catastrophic-output
    // discipline: a wrong supersession link could cause Bedrock to send a
    // homeowner the wrong version of a deed restriction.
    try {
      const amend = parsed.amendment || {};
      const isAmendment = amend.is_amendment === true;
      const isGoverning = ['declaration_ccrs', 'bylaws', 'rules_and_regulations', 'articles_of_incorporation'].includes(parsed.category);
      if (isAmendment && isGoverning && community?.id) {
        // Find candidate parent docs -- same community, same OR related
        // category, not this document itself. Restrict to governing-doc
        // categories so we don't accidentally suggest an "Amendment to
        // Bylaws" amends a budget.
        const { data: candidates } = await supabase
          .from('library_documents')
          .select('id, title, category')
          .eq('community_id', community.id)
          .in('category', ['declaration_ccrs', 'bylaws', 'rules_and_regulations', 'articles_of_incorporation'])
          .neq('id', doc.id);

        const guessTitle = amend.amends_document_title_guess || '';
        let bestMatch = null;
        let bestScore = 0;
        for (const c of (candidates || [])) {
          // Score = title similarity + category match bonus. Category match
          // (an "Amendment to Bylaws" should prefer a Bylaws parent over a
          // Declaration parent of equal title similarity).
          const titleScore = nameJaccard(c.title || '', guessTitle);
          const categoryBonus = c.category === parsed.category ? 0.2 : 0;
          const score = titleScore + categoryBonus;
          if (score > bestScore) {
            bestScore = score;
            bestMatch = c;
          }
        }

        // Threshold: 0.35 of combined score. Below that, we don't have a
        // confident pick -- the suggestion still gets logged but with no
        // parent, so the operator can pick the right one manually.
        const confidentMatch = bestMatch && bestScore >= 0.35;
        await supabase
          .from('library_document_amendment_log')
          .insert({
            amendment_library_document_id: doc.id,
            superseded_library_document_id: confidentMatch ? bestMatch.id : null,
            amended_sections: Array.isArray(amend.amended_sections) ? amend.amended_sections : null,
            action: 'ai_suggested',
            source: 'ai',
            actor: 'extractor',
            ai_confidence: Math.min(0.99, Math.max(0, bestScore)),
            ai_reasoning: (amend.amendment_reasoning || '').slice(0, 1000)
              + (confidentMatch ? `\nProposed parent: ${bestMatch.title} (score=${bestScore.toFixed(2)})` : '\nNo confident parent match found -- operator must pick.'),
          });
        console.log(`[documents] amendment suggested for ${doc.id} -> parent ${confidentMatch ? bestMatch.id : '(unknown)'} score=${bestScore.toFixed(2)}`);
      }
    } catch (amendErr) {
      // Non-fatal: amendment suggestion failures should never block an
      // upload. Operator can manually link via the UI later.
      console.warn('[documents] amendment suggestion failed:', amendErr.message);
    }

    // 10) If there's a semantic duplicate, create a duplicate group for user resolution
    if (semanticDup) {
      const { data: dupGroup } = await supabase
        .from('document_duplicate_groups')
        .insert({
          management_company_id: BEDROCK_MGMT_CO_ID,
          detection_type: 'semantic_match',
          notes: `Both documents map to ${community?.name || 'Unknown'} / ${categoryDisplay} / ${parsed.period_label}`
        })
        .select()
        .single();
      if (dupGroup) {
        await supabase.from('document_duplicate_members').insert([
          { group_id: dupGroup.id, document_id: semanticDup.id },
          { group_id: dupGroup.id, document_id: doc.id }
        ]);
      }
    }

    // 11) Trade tape
    await supabase.from('agent_runs').insert({
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id: community?.id || null,
      module: 'documents',
      endpoint: 'POST /api/documents/upload',
      request_input: { file_name: req.file.originalname, file_size: req.file.size, file_hash: fileHash },
      retrieved_context: { matched_community: community?.name, semantic_dup_id: semanticDup?.id || null },
      prompt: 'DOC_EXTRACTION_PROMPT',
      model: 'claude-sonnet-4-5',
      response: { document_id: doc.id, ...parsed },
      input_tokens: usage?.input_tokens || null,
      output_tokens: usage?.output_tokens || null,
      duration_ms: Date.now() - t0
    });

    // Bridge: queue the new doc for background indexing into askEd's chunks
    // table. We used to call indexLibraryDoc synchronously here, which worked
    // for fast PDFs but silently failed for form-field / scanned PDFs that
    // need the Claude vision pipeline (~30-90s per doc) — Render's 100s
    // gateway timeout would guillotine the upload request mid-OCR, chunks
    // would never insert, and the doc would land in queue limbo with no
    // visible error. 2026-05-24: switched to async-via-status-column. The
    // upload INSERT at step 8 marks the row index_status='pending' when
    // there's a file in storage. The scheduler's documents_auto_reindex job
    // picks up pending rows and runs the same indexLibraryDoc pipeline with
    // no HTTP timeout pressure. Migration 104 backfills existing rows.
    let indexed = { ok: true, reason: 'queued', queued: true };
    if (!uploadedFile) {
      indexed = { ok: false, reason: 'no_file_in_storage' };
    }

    res.json({
      ok: true,
      document: doc,
      matched_community: community,
      extracted: parsed,
      stored_file: uploadedFile,
      semantic_duplicate: semanticDup,
      legacy_duplicate: legacyDup,  // legacy askEd doc that looks like the same logical doc
      // Forms-only: auto-superseded a prior version. UI shows what got replaced
      // so user can undo if it was the wrong target.
      superseded_prior: supersedeTargetSnapshot,
      // askEd visibility: was this doc chunked + embedded into the vector store?
      asked_indexed: indexed,
      duration_ms: Date.now() - t0
    });
  } catch (err) {
    console.error('[documents] upload failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/documents/matrix  — per-community matrix
// Query: ?community_id=<uuid>  optional filter
// ----------------------------------------------------------------------------
router.get('/matrix', async (req, res) => {
  try {
    let q = supabase.from('v_community_document_matrix').select('*');
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ matrix: data || [] });
  } catch (err) {
    console.error('[documents] matrix failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/documents  — list (with filters)
// Query: ?community_id&category&status&include_predecessor=true&include_legacy=true
//
// When include_legacy=true (default), also returns legacy askEd docs (chunked
// PDF/DOCX from the original Lakes of Pine Forest doc-search project) merged
// into one unified list. Legacy rows are tagged source='legacy' and identified
// by a synthetic id ('legacy:<md5>') so the UI can treat them uniformly.
// ----------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const includeLegacy = req.query.include_legacy !== 'false';   // default: include

    // ---- Library docs (the new system) ----
    let q = supabase
      .from('library_documents')
      .select('*, community:communities(id, name, legal_name), extracted:document_extracted_fields(fields)')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('uploaded_at', { ascending: false });
    // Support 'community_id=null' filter for orphan discovery (docs the AI
    // couldn't match to a community, awaiting manual assignment).
    if (req.query.community_id === 'null' || req.query.community_id === 'unassigned') {
      q = q.is('community_id', null);
    } else if (req.query.community_id) {
      q = q.eq('community_id', req.query.community_id);
    }
    if (req.query.category) q = q.eq('category', req.query.category);
    if (req.query.status) q = q.eq('status', req.query.status);
    if (req.query.include_predecessor === 'false') {
      q = q.eq('created_by_mgmt_company', 'Bedrock');
    }
    const { data: libDocs, error } = await q.limit(Number(req.query.limit) || 200);
    if (error) throw error;

    const libraryNormalized = (libDocs || []).map(d => ({
      ...d,
      source: 'library',
      _id: d.id
    }));

    // ---- Legacy docs (chunked askEd index) ----
    let legacyNormalized = [];
    if (includeLegacy) {
      let lq = supabase.from('v_legacy_documents_summary').select('*');
      // Apply community filter if provided. The legacy table uses community
      // NAME in metadata->>'community', not the UUID — so we resolve the
      // community name first if a community_id was passed.
      if (req.query.community_id) {
        const { data: c } = await supabase
          .from('communities')
          .select('name')
          .eq('id', req.query.community_id)
          .maybeSingle();
        if (c?.name) lq = lq.eq('community_name', c.name);
        else lq = lq.eq('community_name', '__no_match__');
      }
      // Don't show already-migrated legacy docs unless explicitly asked
      if (req.query.include_migrated !== 'true') lq = lq.eq('is_migrated', false);
      const { data: legacyDocs } = await lq.limit(500);
      legacyNormalized = (legacyDocs || []).map(l => ({
        // Match the shape consumers expect, with everything category/period-y
        // as null because legacy docs were never categorized.
        id: l.legacy_id,
        _id: l.legacy_id,
        source: 'legacy',
        title: l.filename || '(untitled)',
        file_name_original: l.filename,
        file_name_normalized: l.filename,
        category: l.doc_type || null,
        period_label: null,
        effective_date: null,
        expiration_date: null,
        status: 'current',
        approval_status: null,
        created_by_mgmt_company: 'Unknown',
        community: l.community_name ? { name: l.community_name } : null,
        community_name: l.community_name,
        chunk_count: l.chunk_count,
        preview: l.preview,
        is_migrated: l.is_migrated,
        migrated_to_library_id: l.migrated_to_library_id,
        uploaded_at: null
      }));
    }

    res.json({
      documents: [...libraryNormalized, ...legacyNormalized],
      library_count: libraryNormalized.length,
      legacy_count: legacyNormalized.length
    });
  } catch (err) {
    console.error('[documents] list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/documents/legacy  — legacy docs only, grouped by (community, filename)
// Useful for the "Legacy library" panel in the Documents tab UI.
// ----------------------------------------------------------------------------
router.get('/legacy/list', async (req, res) => {
  try {
    let q = supabase.from('v_legacy_documents_summary').select('*');
    if (req.query.community_name) q = q.eq('community_name', req.query.community_name);
    if (req.query.include_migrated !== 'true') q = q.eq('is_migrated', false);
    const { data, error } = await q.limit(1000);
    if (error) throw error;
    res.json({ documents: data || [] });
  } catch (err) {
    console.error('[documents] legacy list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------
// /general-orphans — every library doc whose chunks are tagged 'General'.
// Ed 2026-06-04: after migration 156 re-tagged 'Unknown' chunks, plus
// every doc that was uploaded without a community_id, end up in 'General'.
// Hybrid retrieval used to treat 'General' as a universal fallback (now
// dropped), so these docs were polluting every community's results.
// Surface them here so the operator can re-tag them via the Documents UI.
// MUST be defined before /:id catch-all.
// ----------------------------------------------------------------------------
router.get('/general-orphans', async (req, res) => {
  try {
    // Pull library docs whose chunks are tagged 'General'. We approximate
    // by finding library_documents whose community_id is null OR whose
    // join to communities fails. Either condition means the chunks ended
    // up in 'General' per lib/library_reindex.js's resolution logic.
    const { data: libs, error } = await supabase
      .from('library_documents')
      .select('id, file_name_original, file_name_normalized, community_id, category, status, communities:community_id(name)')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .neq('status', 'missing')
      .not('file_path', 'is', null);
    if (error) return res.status(500).json({ error: error.message });
    const orphans = (libs || []).filter((d) => !d.community_id || !(d.communities && d.communities.name));
    // For each orphan, pull a short preview of the first chunk so the
    // operator can identify what doc it actually is. Cheap join — one
    // .select per orphan, capped at 200 chars of content.
    const enriched = await Promise.all(orphans.map(async (d) => {
      // Chunks link to library_documents via TWO paths -- metadata blob (new
      // ingestions) or the migrated_to_library_id SQL column (legacy promotions).
      // Check both so the preview shows the actual first chunk for legacy-
      // promoted docs instead of "(no chunks)". Ed 2026-06-16 class audit.
      const [byMeta, byCol] = await Promise.all([
        supabase.from('documents').select('content').eq('metadata->>library_document_id', d.id).limit(1),
        supabase.from('documents').select('content').eq('migrated_to_library_id', d.id).limit(1),
      ]);
      const firstChunk = (byMeta.data && byMeta.data[0]) || (byCol.data && byCol.data[0]);
      const preview = firstChunk ? String(firstChunk.content || '').slice(0, 200).replace(/\s+/g, ' ').trim() : '(no chunks)';
      return {
        id: d.id,
        filename: d.file_name_original || d.file_name_normalized || '(no filename)',
        category: d.category || 'other',
        status: d.status || null,
        community_id: d.community_id,
        community_name: d.communities?.name || null,
        first_chunk_preview: preview,
      };
    }));
    res.json({
      total: enriched.length,
      orphans: enriched.sort((a, b) => (a.filename || '').localeCompare(b.filename || '')),
    });
  } catch (err) {
    console.error('[documents/general-orphans]', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// /assign-community/:id — reassign a library doc to a real community and
// reindex its chunks so metadata.community gets corrected. The reindex
// also re-stamps the article/section breadcrumb under the right community
// so future queries pull it for that community correctly.
// ----------------------------------------------------------------------------
router.post('/assign-community/:id', async (req, res) => {
  try {
    const docId = req.params.id;
    const communityId = req.body?.community_id;
    if (!docId) return res.status(400).json({ error: 'id_required' });
    if (!communityId) return res.status(400).json({ error: 'community_id_required' });
    // 1. Update library_documents.community_id
    const { error: updErr } = await supabase
      .from('library_documents')
      .update({ community_id: communityId })
      .eq('id', docId);
    if (updErr) return res.status(500).json({ error: updErr.message });
    // 2. Re-resolve community name + UPDATE chunks metadata in-place
    // (cheap — no re-embedding needed since we're only updating the tag).
    const { data: c } = await supabase
      .from('communities')
      .select('name')
      .eq('id', communityId)
      .maybeSingle();
    if (!c) return res.status(400).json({ error: 'community_not_found' });
    // The community metadata is a JSONB key on documents.metadata — update
    // every chunk linked to this library doc. TWO link paths:
    //   - metadata->>library_document_id (new ingestions)
    //   - migrated_to_library_id SQL column (legacy promotions)
    // Both updated here so the community tag lands on chunks regardless of
    // which ingestion era they came from. Ed 2026-06-16 class audit.
    const { error: chunkErr } = await supabase.rpc('exec_sql', {
      sql: `UPDATE documents SET metadata = jsonb_set(metadata, '{community}', to_jsonb($1::text))
            WHERE metadata->>'library_document_id' = $2
               OR migrated_to_library_id = $2::uuid`,
      params: [c.name, docId],
    }).then(() => ({ error: null })).catch((e) => ({ error: e }));
    // If exec_sql RPC isn't available (it isn't by default), fall back to
    // fetching the affected chunks and updating each metadata JSONB. Slower
    // but works without a custom RPC. Same two-path lookup.
    if (chunkErr) {
      const [byMeta, byCol] = await Promise.all([
        supabase.from('documents').select('id, metadata').eq('metadata->>library_document_id', docId),
        supabase.from('documents').select('id, metadata').eq('migrated_to_library_id', docId),
      ]);
      const seen = new Set();
      const chunks = [...(byMeta.data || []), ...(byCol.data || [])].filter((c) => {
        if (seen.has(c.id)) return false;
        seen.add(c.id);
        return true;
      });
      let updated = 0;
      for (const ch of chunks) {
        const newMeta = { ...(ch.metadata || {}), community: c.name };
        const { error: ue } = await supabase.from('documents').update({ metadata: newMeta }).eq('id', ch.id);
        if (!ue) updated += 1;
      }
      return res.json({ ok: true, community: c.name, chunks_retagged: updated, via: 'per-row fallback' });
    }
    res.json({ ok: true, community: c.name });
  } catch (err) {
    console.error('[documents/assign-community]', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Amendment supersession endpoints (migration 228, Ed 2026-06-18)
// ----------------------------------------------------------------------------
// GET  /api/documents/amendment-suggestions  — pending AI-suggested links
// POST /api/documents/amendment/:logId/confirm — operator accepts the link
// POST /api/documents/amendment/:logId/reject  — operator rejects (audit only)
// POST /api/documents/amendment/manual-link    — operator links without AI
// ============================================================================

// List every AI-suggested supersession link that hasn't been confirmed,
// rejected, or unlinked yet. Used by the Documents tab "Pending amendment
// reviews" panel. Returns each suggestion with both docs' titles + community
// + section list so the operator can decide in one screen.
router.get('/amendment-suggestions', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const communityId = req.query.community_id || null;

    // Latest log row per amendment_library_document_id where action='ai_suggested'
    // and there's no later operator_confirmed / unlinked row.
    const { data: logs, error } = await supabase
      .from('library_document_amendment_log')
      .select('id, amendment_library_document_id, superseded_library_document_id, amended_sections, action, source, ai_confidence, ai_reasoning, recorded_at')
      .eq('action', 'ai_suggested')
      .eq('source', 'ai')
      .order('recorded_at', { ascending: false })
      .limit(500);
    if (error) return res.status(500).json({ error: error.message });

    // For each amendment doc, only keep the most recent suggestion.
    const latestByAmendment = new Map();
    for (const row of (logs || [])) {
      if (!latestByAmendment.has(row.amendment_library_document_id)) {
        latestByAmendment.set(row.amendment_library_document_id, row);
      }
    }
    const candidates = Array.from(latestByAmendment.values());

    // Drop any whose amendment doc already has a confirmed supersession link.
    const amendmentDocIds = candidates.map((r) => r.amendment_library_document_id);
    let confirmedSet = new Set();
    if (amendmentDocIds.length > 0) {
      const { data: docs } = await supabase
        .from('library_documents')
        .select('id, supersedes_library_document_id, supersession_recorded_at')
        .in('id', amendmentDocIds);
      for (const d of (docs || [])) {
        if (d.supersedes_library_document_id && d.supersession_recorded_at) confirmedSet.add(d.id);
      }
    }
    const pending = candidates.filter((r) => !confirmedSet.has(r.amendment_library_document_id));

    if (pending.length === 0) return res.json({ suggestions: [] });

    const allDocIds = new Set();
    for (const p of pending) {
      allDocIds.add(p.amendment_library_document_id);
      if (p.superseded_library_document_id) allDocIds.add(p.superseded_library_document_id);
    }
    const { data: docs } = await supabase
      .from('library_documents')
      .select('id, title, category, file_name_original, community_id, communities:community_id(name), effective_date')
      .in('id', [...allDocIds]);
    const docById = new Map((docs || []).map((d) => [d.id, d]));

    // Enrich each doc with chunk count (both link paths) so the operator sees
    // a doc's size at a glance. A 3-chunk "Second Amendment" with 109-chunk
    // parent makes sense; a 109-chunk amendment with a 3-chunk parent should
    // raise an eyebrow about which is which.
    const chunkCountById = new Map();
    if (allDocIds.size > 0) {
      const ids = [...allDocIds];
      const [byMeta, byCol] = await Promise.all([
        supabase.from('documents').select('metadata').in('metadata->>library_document_id', ids),
        supabase.from('documents').select('migrated_to_library_id').in('migrated_to_library_id', ids),
      ]);
      for (const row of (byMeta.data || [])) {
        const id = row.metadata?.library_document_id;
        if (id) chunkCountById.set(id, (chunkCountById.get(id) || 0) + 1);
      }
      for (const row of (byCol.data || [])) {
        const id = row.migrated_to_library_id;
        if (id) chunkCountById.set(id, (chunkCountById.get(id) || 0) + 1);
      }
    }

    // For each proposed parent, look up other CONFIRMED amendments already
    // recorded against it. Pattern: amendment doc rows whose
    // supersedes_library_document_id == parent_id AND supersession_recorded_at
    // IS NOT NULL. Operator confirming this suggestion will see "this parent
    // already has 2 confirmed amendments; we're adding a third."
    const parentIds = [...new Set(pending.map((p) => p.superseded_library_document_id).filter(Boolean))];
    const confirmedAmendmentsByParent = new Map();
    if (parentIds.length > 0) {
      const { data: confirmedRows } = await supabase
        .from('library_documents')
        .select('id, title, supersedes_library_document_id, supersession_recorded_at, amended_sections')
        .in('supersedes_library_document_id', parentIds)
        .not('supersession_recorded_at', 'is', null);
      for (const r of (confirmedRows || [])) {
        const arr = confirmedAmendmentsByParent.get(r.supersedes_library_document_id) || [];
        arr.push({ id: r.id, title: r.title, amended_sections: r.amended_sections });
        confirmedAmendmentsByParent.set(r.supersedes_library_document_id, arr);
      }
    }

    const enrichDoc = (d) => d ? {
      id: d.id, title: d.title, category: d.category,
      community_name: d.communities?.name || null,
      file_name: d.file_name_original,
      effective_date: d.effective_date,
      chunk_count: chunkCountById.get(d.id) || 0,
    } : null;

    const suggestions = pending
      .filter((p) => {
        if (!communityId) return true;
        const amendDoc = docById.get(p.amendment_library_document_id);
        return amendDoc && amendDoc.community_id === communityId;
      })
      .slice(0, limit)
      .map((p) => ({
        log_id: p.id,
        ai_confidence: p.ai_confidence,
        ai_reasoning: p.ai_reasoning,
        suggested_at: p.recorded_at,
        amended_sections: p.amended_sections,
        amendment: enrichDoc(docById.get(p.amendment_library_document_id)),
        proposed_parent: p.superseded_library_document_id ? enrichDoc(docById.get(p.superseded_library_document_id)) : null,
        // Other confirmed amendments already on this same parent, so the
        // operator sees the full chain context before deciding.
        existing_confirmed_amendments: p.superseded_library_document_id
          ? (confirmedAmendmentsByParent.get(p.superseded_library_document_id) || [])
          : [],
      }));

    res.json({ suggestions });
  } catch (err) {
    console.error('[documents/amendment-suggestions]', err);
    res.status(500).json({ error: err.message });
  }
});

// Operator confirms an amendment suggestion. Writes the supersession link
// on the amendment doc + an 'operator_confirmed' log row. Optional body
// fields allow overriding the proposed parent / amended_sections.
router.post('/amendment/:logId/confirm', express.json(), async (req, res) => {
  try {
    const logId = req.params.logId;
    const body = req.body || {};
    const actor = (body.actor || '').toString().slice(0, 200) || 'operator';

    const { data: log } = await supabase
      .from('library_document_amendment_log')
      .select('amendment_library_document_id, superseded_library_document_id, amended_sections')
      .eq('id', logId)
      .maybeSingle();
    if (!log) return res.status(404).json({ error: 'log_not_found' });

    // Operator can override the parent doc and section list before confirming.
    const parentId = body.superseded_library_document_id || log.superseded_library_document_id;
    if (!parentId) return res.status(400).json({ error: 'parent_required', detail: 'No parent doc specified -- AI suggestion had no confident match; supply superseded_library_document_id in body.' });
    const sections = Array.isArray(body.amended_sections) ? body.amended_sections : (log.amended_sections || null);

    // Write the supersession link on the amendment doc.
    const { error: upErr } = await supabase
      .from('library_documents')
      .update({
        supersedes_library_document_id: parentId,
        amended_sections: sections,
        supersession_recorded_at: new Date().toISOString(),
        supersession_recorded_by: actor,
      })
      .eq('id', log.amendment_library_document_id);
    if (upErr) return res.status(500).json({ error: upErr.message });

    await supabase.from('library_document_amendment_log').insert({
      amendment_library_document_id: log.amendment_library_document_id,
      superseded_library_document_id: parentId,
      amended_sections: sections,
      action: 'operator_confirmed',
      source: 'operator',
      actor,
    });

    res.json({ ok: true, amendment_library_document_id: log.amendment_library_document_id, superseded_library_document_id: parentId, amended_sections: sections });
  } catch (err) {
    console.error('[documents/amendment/confirm]', err);
    res.status(500).json({ error: err.message });
  }
});

// Operator rejects an AI suggestion (the doc is not actually an amendment,
// or amends something else). Logs the rejection but doesn't link anything.
router.post('/amendment/:logId/reject', express.json(), async (req, res) => {
  try {
    const logId = req.params.logId;
    const body = req.body || {};
    const actor = (body.actor || '').toString().slice(0, 200) || 'operator';

    const { data: log } = await supabase
      .from('library_document_amendment_log')
      .select('amendment_library_document_id')
      .eq('id', logId)
      .maybeSingle();
    if (!log) return res.status(404).json({ error: 'log_not_found' });

    await supabase.from('library_document_amendment_log').insert({
      amendment_library_document_id: log.amendment_library_document_id,
      superseded_library_document_id: null,
      action: 'unlinked',
      source: 'operator',
      actor,
      ai_reasoning: (body.reason || 'Operator rejected AI suggestion').slice(0, 1000),
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[documents/amendment/reject]', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Amendment backfill — for governing docs already in the library, run AI
// detection retroactively on the candidate set (title contains amendment-ish
// keywords) and write pending suggestions to the amendment log. Lets existing
// content benefit from migration 228 without re-uploading.
// Ed 2026-06-18 follow-up to the amendment management ship.
// ============================================================================
const BACKFILL_AMENDMENT_PROMPT = `You are extracting two things from the following HOA governing document chunks:

1. Whether this document is an AMENDMENT to another doc, and if so, which one + which sections.
2. The document's effective date (when it was adopted / signed / became effective). Look for "effective", "adopted", "signed", "executed", "dated", or visible date stamps.

Amendment cues:
  - Title or opening text contains "Amendment", "Amend", "Supersede", "Restate"
  - Explicit cross-references to a parent document ("Declaration of CC&Rs", "Bylaws")
  - "Hereby amends Section X" or "replaces Section Y" phrasing
  - Restatement of specific section numbers with new language

Return ONLY this JSON (no preamble, no code fence):
{
  "is_amendment": true | false,
  "amends_document_title_guess": "string or null — your best guess at the original document this amends. null if not an amendment.",
  "amended_sections": ["3.3", "5.1(a)"] /* array of section identifiers this amendment touches; empty array means whole-document supersession */,
  "amendment_effective_date": "YYYY-MM-DD or null — the date the amendment was adopted, NOT the date of the parent doc",
  "amendment_reasoning": "Brief explanation of the amendment conclusion, or null if not an amendment.",
  "document_effective_date": "YYYY-MM-DD or null — the date THIS doc became effective. Same as amendment_effective_date if this is an amendment. For non-amendments, look for the doc's own adoption/signing date.",
  "effective_date_confidence": "high | medium | low — high if explicit 'effective on YYYY-MM-DD' wording, medium if inferred from signature blocks or county recording stamps, low if guessed from contextual cues."
}`;

router.post('/amendment-backfill', express.json(), async (req, res) => {
  try {
    const limit = Math.min(20, Math.max(1, parseInt(req.body?.limit, 10) || 10));
    const communityId = req.body?.community_id || null;

    // Find governing-doc rows in library that LOOK like amendments by name +
    // don't already have any amendment log row (so we don't re-suggest).
    let q = supabase
      .from('library_documents')
      .select('id, title, category, file_name_original, community_id, communities:community_id(name)')
      .in('category', ['declaration_ccrs', 'bylaws', 'rules_and_regulations', 'articles_of_incorporation'])
      .or('title.ilike.%amend%,title.ilike.%supersed%,title.ilike.%restate%,file_name_original.ilike.%amend%')
      .limit(200);
    if (communityId) q = q.eq('community_id', communityId);
    const { data: candidates, error: cErr } = await q;
    if (cErr) return res.status(500).json({ error: cErr.message });
    if (!candidates || candidates.length === 0) {
      return res.json({ processed: 0, suggested: 0, skipped: 0, candidates: [] });
    }

    // Filter out those that already have a log row (ai_suggested OR confirmed).
    const candIds = candidates.map((c) => c.id);
    const { data: existingLogs } = await supabase
      .from('library_document_amendment_log')
      .select('amendment_library_document_id')
      .in('amendment_library_document_id', candIds);
    const alreadyLogged = new Set((existingLogs || []).map((r) => r.amendment_library_document_id));
    const fresh = candidates.filter((c) => !alreadyLogged.has(c.id)).slice(0, limit);

    if (fresh.length === 0) {
      return res.json({
        processed: 0,
        suggested: 0,
        skipped: candidates.length,
        message: `All ${candidates.length} title-matching candidates already have amendment log entries. Nothing to backfill.`,
      });
    }

    let suggestedCount = 0;
    const results = [];

    for (const c of fresh) {
      try {
        // Get a representative sample of chunks (first 5) for this doc.
        // Both link paths -- same dual-path pattern as the rest of the audit.
        const [byMeta, byCol] = await Promise.all([
          supabase.from('documents').select('content').eq('metadata->>library_document_id', c.id).limit(5),
          supabase.from('documents').select('content').eq('migrated_to_library_id', c.id).limit(5),
        ]);
        const chunks = [...(byMeta.data || []), ...(byCol.data || [])];
        if (chunks.length === 0) {
          results.push({ id: c.id, title: c.title, status: 'no_chunks' });
          continue;
        }
        // Take first ~6000 chars across chunks -- enough for amendment cues,
        // small enough to keep AI cost bounded.
        let combined = '';
        for (const ch of chunks) {
          if (!ch.content) continue;
          combined += '\n\n--- chunk ---\n' + ch.content;
          if (combined.length > 6000) break;
        }
        combined = combined.slice(0, 6000);

        // AI detection
        const resp = await anthropic.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 600,
          messages: [{
            role: 'user',
            content: [{
              type: 'text',
              text: `${BACKFILL_AMENDMENT_PROMPT}\n\nDocument title: ${c.title || '(untitled)'}\nDocument file name: ${c.file_name_original || '(unknown)'}\nDocument category: ${c.category}\nCommunity: ${c.communities?.name || '(unknown)'}\n\nChunks:\n${combined}`,
            }],
          }],
        });
        const txt = (resp.content || []).map((b) => b.text || '').join('').trim();
        const jsonMatch = txt.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          results.push({ id: c.id, title: c.title, status: 'no_json', raw: txt.slice(0, 200) });
          continue;
        }
        let parsed;
        try { parsed = JSON.parse(jsonMatch[0]); }
        catch (e) { results.push({ id: c.id, title: c.title, status: 'parse_failed', raw: txt.slice(0, 200) }); continue; }

        // Backfill effective_date if missing -- runs on EVERY processed doc,
        // amendment or not, since the AI already read the chunks. Cheap win.
        if (parsed.document_effective_date) {
          const { data: existing } = await supabase
            .from('library_documents')
            .select('effective_date')
            .eq('id', c.id)
            .maybeSingle();
          if (existing && !existing.effective_date) {
            await supabase
              .from('library_documents')
              .update({ effective_date: parsed.document_effective_date })
              .eq('id', c.id);
            console.log(`[amendment-backfill] filled effective_date for ${c.title}: ${parsed.document_effective_date}`);
          }
        }

        if (!parsed.is_amendment) {
          results.push({
            id: c.id, title: c.title, status: 'not_amendment',
            effective_date_filled: parsed.document_effective_date || null,
          });
          continue;
        }

        // Find best parent match in same community
        const { data: parentCandidates } = await supabase
          .from('library_documents')
          .select('id, title, category')
          .eq('community_id', c.community_id)
          .in('category', ['declaration_ccrs', 'bylaws', 'rules_and_regulations', 'articles_of_incorporation'])
          .neq('id', c.id);
        const guessTitle = parsed.amends_document_title_guess || '';
        let bestMatch = null;
        let bestScore = 0;
        for (const pc of (parentCandidates || [])) {
          const titleScore = nameJaccard(pc.title || '', guessTitle);
          const categoryBonus = pc.category === c.category ? 0.2 : 0;
          const score = titleScore + categoryBonus;
          if (score > bestScore) { bestScore = score; bestMatch = pc; }
        }
        const confidentMatch = bestMatch && bestScore >= 0.35;

        await supabase.from('library_document_amendment_log').insert({
          amendment_library_document_id: c.id,
          superseded_library_document_id: confidentMatch ? bestMatch.id : null,
          amended_sections: Array.isArray(parsed.amended_sections) ? parsed.amended_sections : null,
          action: 'ai_suggested',
          source: 'ai',
          actor: 'backfill',
          ai_confidence: Math.min(0.99, Math.max(0, bestScore)),
          ai_reasoning: (parsed.amendment_reasoning || '').slice(0, 800)
            + (confidentMatch
                ? `\nProposed parent: ${bestMatch.title} (score=${bestScore.toFixed(2)})`
                : '\nNo confident parent match -- operator must pick.'),
        });
        suggestedCount += 1;
        results.push({
          id: c.id, title: c.title, status: 'suggested',
          parent: confidentMatch ? bestMatch.title : null,
          confidence: bestScore.toFixed(2),
        });
      } catch (perDocErr) {
        console.warn('[amendment-backfill] per-doc failed:', perDocErr.message);
        results.push({ id: c.id, title: c.title, status: 'error', error: perDocErr.message });
      }
    }

    res.json({
      processed: fresh.length,
      suggested: suggestedCount,
      skipped: candidates.length - fresh.length,
      total_title_matches: candidates.length,
      message: `Processed ${fresh.length} of ${candidates.length} title-matching candidates. ${suggestedCount} new amendment suggestions logged. View them in the Pending amendment reviews panel.`,
      results,
    });
  } catch (err) {
    console.error('[documents/amendment-backfill]', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Governing Doc Health Portfolio Overview — aggregate matrix across every
// community. One bird's-eye query so operators see at a glance which
// communities have a complete + current library and which have gaps.
// Returns one row per community with per-category counts + total flags.
// ============================================================================
router.get('/governing-health/portfolio', async (req, res) => {
  try {
    // BEDROCK_MGMT_CO_ID already defined at top of this file
    // All Bedrock-managed communities
    const { data: communities, error: cErr } = await supabase
      .from('communities')
      .select('id, name')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('active', true)
      .order('name');
    if (cErr) return res.status(500).json({ error: cErr.message });
    if (!communities || communities.length === 0) {
      return res.json({ communities: [] });
    }

    const communityIds = communities.map((c) => c.id);

    // All governing-doc library rows across the portfolio
    const { data: libDocs } = await supabase
      .from('library_documents')
      .select('id, title, category, status, community_id, effective_date, supersedes_library_document_id, amended_sections, supersession_recorded_at')
      .in('community_id', communityIds)
      .in('category', ['declaration_ccrs', 'bylaws', 'rules_and_regulations', 'articles_of_incorporation']);
    const docs = libDocs || [];
    const allDocIds = docs.map((d) => d.id);

    // Chunk counts per doc (both link paths) so we can flag zero-chunk docs.
    const chunkCountById = new Map();
    if (allDocIds.length > 0) {
      const [byMeta, byCol] = await Promise.all([
        supabase.from('documents').select('metadata').in('metadata->>library_document_id', allDocIds),
        supabase.from('documents').select('migrated_to_library_id').in('migrated_to_library_id', allDocIds),
      ]);
      for (const row of (byMeta.data || [])) {
        const id = row.metadata?.library_document_id;
        if (id) chunkCountById.set(id, (chunkCountById.get(id) || 0) + 1);
      }
      for (const row of (byCol.data || [])) {
        const id = row.migrated_to_library_id;
        if (id) chunkCountById.set(id, (chunkCountById.get(id) || 0) + 1);
      }
    }

    // Pending amendment suggestions across the portfolio (count per community)
    const pendingByCommunity = new Map();
    if (allDocIds.length > 0) {
      const { data: pendingLogs } = await supabase
        .from('library_document_amendment_log')
        .select('amendment_library_document_id')
        .in('amendment_library_document_id', allDocIds)
        .eq('action', 'ai_suggested');
      const confirmedSet = new Set(docs.filter((d) => d.supersession_recorded_at).map((d) => d.id));
      const seen = new Set();
      const docToCommunityId = new Map(docs.map((d) => [d.id, d.community_id]));
      for (const row of (pendingLogs || [])) {
        const docId = row.amendment_library_document_id;
        if (confirmedSet.has(docId) || seen.has(docId)) continue;
        seen.add(docId);
        const cid = docToCommunityId.get(docId);
        if (cid) pendingByCommunity.set(cid, (pendingByCommunity.get(cid) || 0) + 1);
      }
    }

    // Build the per-community summary
    const summary = communities.map((c) => {
      const myDocs = docs.filter((d) => d.community_id === c.id);
      const categoryStats = {};
      for (const cat of ['declaration_ccrs', 'bylaws', 'rules_and_regulations', 'articles_of_incorporation']) {
        const list = myDocs.filter((d) => d.category === cat);
        categoryStats[cat] = {
          total: list.length,
          current: list.filter((d) => d.status === 'current' || (!d.status && d.status !== 'superseded')).length,
          superseded: list.filter((d) => d.status === 'superseded').length,
          amendments: list.filter((d) => d.supersedes_library_document_id && d.supersession_recorded_at).length,
          zero_chunks: list.filter((d) => (chunkCountById.get(d.id) || 0) === 0).length,
          missing_effective_date: list.filter((d) => !d.effective_date).length,
        };
      }
      // Probably-stale count: per category, count docs older than the newest
      // that have no amendment link in either direction (matches the per-
      // community panel's heuristic).
      let probablyStale = 0;
      for (const cat of ['declaration_ccrs', 'bylaws', 'rules_and_regulations', 'articles_of_incorporation']) {
        const list = myDocs.filter((d) => d.category === cat);
        if (list.length < 2) continue;
        const datedList = list.filter((d) => d.effective_date && d.status !== 'superseded');
        if (datedList.length < 2) continue;
        const newest = datedList.reduce((a, b) => a.effective_date > b.effective_date ? a : b);
        for (const d of datedList) {
          if (d.id === newest.id) continue;
          if (d.supersedes_library_document_id && d.supersession_recorded_at) continue;
          if (d.effective_date < newest.effective_date) probablyStale += 1;
        }
      }
      return {
        community_id: c.id,
        community_name: c.name,
        categories: categoryStats,
        pending_amendments: pendingByCommunity.get(c.id) || 0,
        probably_stale: probablyStale,
        total_governing_docs: myDocs.length,
        total_zero_chunks: Object.values(categoryStats).reduce((s, x) => s + x.zero_chunks, 0),
        total_missing_dates: Object.values(categoryStats).reduce((s, x) => s + x.missing_effective_date, 0),
      };
    });

    res.json({ communities: summary });
  } catch (err) {
    console.error('[documents/governing-health/portfolio]', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Governing Doc Health — per-community diagnostic of declaration/bylaws/rules
// Ed 2026-06-18, follow-up to amendment management. Surfaces every governing
// doc with chunk counts, supersession state, and duplicate flags so the
// operator can pick canonicals manually. Automated consolidation is unsafe
// for governing docs -- a wrong call sends homeowners stale language.
// ============================================================================
router.get('/governing-health', async (req, res) => {
  try {
    const communityId = req.query.community_id || null;
    if (!communityId) {
      return res.status(400).json({ error: 'community_id required' });
    }

    const { data: comm } = await supabase
      .from('communities')
      .select('id, name')
      .eq('id', communityId)
      .maybeSingle();
    if (!comm) return res.status(404).json({ error: 'community_not_found' });

    // Library docs (governing categories only) for this community.
    const { data: libDocs, error: libErr } = await supabase
      .from('library_documents')
      .select('id, title, category, status, page_count, file_name_original, effective_date, supersedes_library_document_id, amended_sections, supersession_recorded_at, superseded_at, superseded_by_id, created_at')
      .eq('community_id', communityId)
      .in('category', ['declaration_ccrs', 'bylaws', 'rules_and_regulations', 'articles_of_incorporation'])
      .order('category')
      .order('created_at', { ascending: true });
    if (libErr) return res.status(500).json({ error: libErr.message });

    // Chunk counts per library doc (both link paths)
    const libIds = (libDocs || []).map((d) => d.id);
    const chunkCountById = new Map();
    if (libIds.length > 0) {
      // Two parallel count queries, one per link path.
      const [byMeta, byCol] = await Promise.all([
        supabase.from('documents')
          .select('metadata', { count: 'exact', head: false })
          .in('metadata->>library_document_id', libIds),
        supabase.from('documents')
          .select('migrated_to_library_id', { count: 'exact', head: false })
          .in('migrated_to_library_id', libIds),
      ]);
      // Aggregate in JS since PostgREST doesn't do group-by counts inline.
      for (const row of (byMeta.data || [])) {
        const id = row.metadata?.library_document_id;
        if (id) chunkCountById.set(id, (chunkCountById.get(id) || 0) + 1);
      }
      for (const row of (byCol.data || [])) {
        const id = row.migrated_to_library_id;
        if (id) chunkCountById.set(id, (chunkCountById.get(id) || 0) + 1);
      }
    }

    // Amendment relationships: who supersedes whom (confirmed only)
    const supersededByMap = new Map();   // parent_id -> [amendment_id, ...]
    for (const d of (libDocs || [])) {
      if (d.supersedes_library_document_id && d.supersession_recorded_at) {
        const arr = supersededByMap.get(d.supersedes_library_document_id) || [];
        arr.push(d.id);
        supersededByMap.set(d.supersedes_library_document_id, arr);
      }
    }

    // Legacy docs in the legacy documents table not yet promoted to library
    // (metadata->>community matches and filename mentions a governing-doc
    // keyword). Group by filename + return chunk counts so operator sees
    // pre-library-era docs that should be promoted.
    const lcName = (comm.name || '').toLowerCase();
    const { data: legacyRaw } = await supabase
      .from('documents')
      .select('metadata, migrated_to_library_id')
      .ilike('metadata->>community', `%${lcName}%`)
      .is('migrated_to_library_id', null)
      .limit(5000);
    const legacyCountByFile = new Map();
    for (const row of (legacyRaw || [])) {
      const fn = row.metadata?.filename;
      if (!fn) continue;
      if (!/declaration|bylaw|ccr|rules|amend|articles/i.test(fn)) continue;
      legacyCountByFile.set(fn, (legacyCountByFile.get(fn) || 0) + 1);
    }
    const legacyDocs = Array.from(legacyCountByFile.entries())
      .map(([filename, chunk_count]) => ({ filename, chunk_count }))
      .sort((a, b) => b.chunk_count - a.chunk_count);

    // Detect probable duplicates among library docs within the same category
    // by Jaccard title similarity (>= 0.7).
    const duplicateGroups = [];
    const seenDupIds = new Set();
    const byCategory = {};
    for (const d of (libDocs || [])) {
      if (!byCategory[d.category]) byCategory[d.category] = [];
      byCategory[d.category].push(d);
    }
    for (const cat of Object.keys(byCategory)) {
      const list = byCategory[cat];
      for (let i = 0; i < list.length; i++) {
        if (seenDupIds.has(list[i].id)) continue;
        const group = [list[i]];
        for (let j = i + 1; j < list.length; j++) {
          if (seenDupIds.has(list[j].id)) continue;
          if (nameJaccard(list[i].title || '', list[j].title || '') >= 0.7) {
            group.push(list[j]);
          }
        }
        if (group.length > 1) {
          duplicateGroups.push({
            category: cat,
            docs: group.map((d) => ({ id: d.id, title: d.title, page_count: d.page_count, chunks: chunkCountById.get(d.id) || 0, status: d.status })),
          });
          group.forEach((d) => seenDupIds.add(d.id));
        }
      }
    }

    // Pending amendment suggestions for this community's library docs so
    // the panel can cross-link a "PROBABLY STALE" row to its own pending
    // review when one exists. Single batched query instead of per-row.
    const pendingAmendmentsByDocId = new Map();
    if (libIds.length > 0) {
      const { data: pendingLogs } = await supabase
        .from('library_document_amendment_log')
        .select('id, amendment_library_document_id, superseded_library_document_id, recorded_at')
        .in('amendment_library_document_id', libIds)
        .eq('action', 'ai_suggested')
        .order('recorded_at', { ascending: false });
      // Latest pending suggestion per amendment doc. Then filter out any
      // already confirmed -- if supersession_recorded_at IS NOT NULL on the
      // amendment doc, the operator already linked it.
      const confirmedSet = new Set((libDocs || [])
        .filter((d) => d.supersession_recorded_at)
        .map((d) => d.id));
      const seen = new Set();
      for (const row of (pendingLogs || [])) {
        if (confirmedSet.has(row.amendment_library_document_id)) continue;
        if (seen.has(row.amendment_library_document_id)) continue;
        seen.add(row.amendment_library_document_id);
        // Index by BOTH the amendment doc AND the proposed parent doc, so
        // the UI can light up either row.
        pendingAmendmentsByDocId.set(row.amendment_library_document_id, {
          log_id: row.id,
          role: 'amendment',
          partner_doc_id: row.superseded_library_document_id,
        });
        if (row.superseded_library_document_id) {
          // Don't overwrite if this parent already has an entry from a
          // different (closer / more confident) amendment.
          if (!pendingAmendmentsByDocId.has(row.superseded_library_document_id)) {
            pendingAmendmentsByDocId.set(row.superseded_library_document_id, {
              log_id: row.id,
              role: 'parent',
              partner_doc_id: row.amendment_library_document_id,
            });
          }
        }
      }
    }

    res.json({
      community: { id: comm.id, name: comm.name },
      library_docs: (libDocs || []).map((d) => ({
        id: d.id,
        title: d.title,
        category: d.category,
        status: d.status,
        page_count: d.page_count,
        chunk_count: chunkCountById.get(d.id) || 0,
        file_name: d.file_name_original,
        effective_date: d.effective_date,
        created_at: d.created_at,
        is_amendment: !!d.supersedes_library_document_id && !!d.supersession_recorded_at,
        amends_id: d.supersedes_library_document_id || null,
        amended_sections: d.amended_sections || null,
        amendments_count: (supersededByMap.get(d.id) || []).length,
        superseded_at: d.superseded_at,
        superseded_by_id: d.superseded_by_id,
        pending_amendment: pendingAmendmentsByDocId.get(d.id) || null,
      })),
      legacy_docs: legacyDocs,
      duplicate_groups: duplicateGroups,
    });
  } catch (err) {
    console.error('[documents/governing-health]', err);
    res.status(500).json({ error: err.message });
  }
});

// Operator manually marks a library doc as superseded (status='superseded'
// with link to the new canonical). Used when the operator decides one
// duplicate is THE canonical and the others are stale copies.
router.post('/governing-health/mark-superseded', express.json(), async (req, res) => {
  try {
    const { superseded_id, superseded_by_id, actor } = req.body || {};
    if (!superseded_id || !superseded_by_id) {
      return res.status(400).json({ error: 'superseded_id + superseded_by_id required' });
    }
    if (superseded_id === superseded_by_id) {
      return res.status(400).json({ error: 'a doc cannot supersede itself' });
    }
    const { error } = await supabase
      .from('library_documents')
      .update({
        status: 'superseded',
        superseded_at: new Date().toISOString(),
        superseded_by_id,
      })
      .eq('id', superseded_id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    console.error('[documents/governing-health/mark-superseded]', err);
    res.status(500).json({ error: err.message });
  }
});

// askEd coverage diagnostic — per-community count of library docs vs. how
// many are actually indexed in the chunks table the askEd retrieval reads.
// MUST be defined before /:id (otherwise the catch-all UUID route shadows it).
// ----------------------------------------------------------------------------
router.get('/asked-coverage', async (req, res) => {
  try {
    // Pull library docs once (small set).
    const { data: libs, error: libsErr } = await supabase
      .from('library_documents')
      .select('id, community_id, category, status, communities:community_id(name)')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .neq('status', 'missing')
      .not('file_path', 'is', null);
    if (libsErr) return res.status(500).json({ error: libsErr.message });

    // Paginate chunks. Supabase / PostgREST caps a single .select() at 1000
    // rows by default; LPF alone has 840+ legacy chunks, which used to
    // saturate that cap and leave the rest invisible. Page through everything.
    const indexedIds = new Set();
    const communityChunkCount = {};
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data: page, error: pErr } = await supabase
        .from('documents')
        .select('metadata')
        .range(from, from + PAGE - 1);
      if (pErr) {
        console.warn('[asked-coverage] page error at offset', from, pErr.message);
        break;
      }
      if (!page || page.length === 0) break;
      for (const c of page) {
        const meta = c.metadata || {};
        if (meta.library_document_id) indexedIds.add(meta.library_document_id);
        // Bucket chunks per community. For chunks WITHOUT a community tag
        // but WITH a library_document_id (i.e. community-less library
        // docs), bucket them under 'Unknown' to mirror the libs loop's
        // bucketing — otherwise the panel shows "39 indexed / 0 chunks"
        // for the Unknown bucket and the columns visibly disagree.
        let name = meta.community;
        if (!name && meta.library_document_id) name = 'Unknown';
        if (name) communityChunkCount[name] = (communityChunkCount[name] || 0) + 1;
      }
      if (page.length < PAGE) break; // last page
      from += PAGE;
      // Safety stop — if chunks ever balloon, abort to avoid pulling forever.
      if (from > 100000) {
        console.warn('[asked-coverage] hit safety stop at 100k chunks');
        break;
      }
    }

    const byCommunity = {};
    for (const d of libs || []) {
      const name = (d.communities && d.communities.name) || 'Unknown';
      if (!byCommunity[name]) byCommunity[name] = { name, total: 0, indexed: 0, not_indexed: 0, chunks_total: 0 };
      byCommunity[name].total += 1;
      if (indexedIds.has(d.id)) byCommunity[name].indexed += 1;
      else byCommunity[name].not_indexed += 1;
    }
    for (const name of Object.keys(byCommunity)) {
      byCommunity[name].chunks_total = communityChunkCount[name] || 0;
    }
    res.json({
      by_community: Object.values(byCommunity).sort((a, b) => a.name.localeCompare(b.name)),
      total_chunks_scanned: from + (indexedIds.size > 0 ? indexedIds.size : 0),
      total_library_indexed_ids: indexedIds.size,
    });
  } catch (err) {
    console.error('[documents/asked-coverage]', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/documents/reindex-all  — batched reindex. The client calls this
// repeatedly with rising `offset` until `done: true`. Each call handles
// `limit` docs (default 10) so a single HTTP request stays well under
// Render's 100s timeout even on slow PDFs.
//
// Query params:
//   ?community=Name       narrow to docs whose community contains "Name"
//   ?only_missing=0       set to "0" to reindex everything (default: only docs not yet in chunks)
//   ?offset=0&limit=10    pagination over the work queue
//
// Response includes:
//   queue_total           total docs that need indexing
//   processed_this_batch  how many this call handled
//   processed_total       cumulative (so far, this offset + limit)
//   indexed/skipped/failed per-batch counts
//   details[]             per-doc result for this batch
//   done                  true when offset+limit >= queue_total
// ----------------------------------------------------------------------------

// 180-second hard ceiling per doc. Was 60s; bumped to accommodate the OCR
// fallback path for scanned PDFs (multi-page splits + concurrent the AI
// vision calls can take 60-120s on older 50+ page bylaws/CC&Rs). Text-only
// PDFs still finish well under the old 60s budget.
async function _indexWithTimeout(supabase, openai, doc, timeoutMs = 180000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout_after_${Math.round(timeoutMs/1000)}s`)), timeoutMs);
  });
  try {
    return await Promise.race([
      indexLibraryDoc(supabase, openai, doc),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Find library docs not yet indexed for askEd. Used by both the
// reindex-all endpoint and the scheduled auto-reindex job.
//
// 2026-05-24: replaced the JSONB-scan-of-documents.metadata approach with a
// direct read of library_documents.index_status (column added in migration
// 104). Single source of truth, partial index makes the query trivial, and
// 'failed_permanent' rows are excluded so poison-pill docs don't soak up
// the queue budget on every run. To force a retry of a permanent-failed
// doc, manually set index_status='pending' or use the per-doc reindex
// endpoint.
async function _findUnindexedDocs(supabase, { communityFilter = null, limit = null } = {}) {
  let q = supabase
    .from('library_documents')
    .select('id, community_id, file_path, file_name_original, file_name_normalized, category, period_label, status, index_status, index_attempt_count, communities:community_id(name)')
    .eq('management_company_id', BEDROCK_MGMT_CO_ID)
    .in('index_status', ['pending', 'failed'])
    .not('file_path', 'is', null)
    .order('uploaded_at', { ascending: true });
  if (limit) q = q.limit(limit * 2); // pull extra for community filtering before slicing
  const { data: docs, error } = await q;
  if (error) throw error;

  let queue = (docs || []).map((d) => ({ ...d, community_name: (d.communities && d.communities.name) || null }));
  if (communityFilter) {
    const filt = communityFilter.toLowerCase().split(' at ')[0].trim();
    queue = queue.filter((d) => (d.community_name || '').toLowerCase().includes(filt));
  }
  return limit ? queue.slice(0, limit) : queue;
}

// Background-job entry point: drain the unindexed queue for ALL communities
// up to a budget. Time-boxed so it can't overlap with the next scheduler
// tick (15 min). Returns a summary the scheduler logs to cron_runs.
async function drainUnindexedQueue({ supabase, openai, maxDocs = 50, budgetMs = 10 * 60 * 1000 } = {}) {
  const started = Date.now();
  const queue = await _findUnindexedDocs(supabase, { limit: maxDocs });
  const summary = { queue_size: queue.length, indexed: 0, skipped: 0, failed: 0, budget_hit: false, duration_ms: 0 };
  for (const doc of queue) {
    if (Date.now() - started > budgetMs) { summary.budget_hit = true; break; }
    try {
      const r = await _indexWithTimeout(supabase, openai, doc);
      if (r && r.ok) summary.indexed += 1;
      else summary.skipped += 1;
    } catch (e) {
      summary.failed += 1;
    }
  }
  summary.duration_ms = Date.now() - started;
  return summary;
}

// ----------------------------------------------------------------------------
// POST /api/documents/queue-thin-extraction-reindex
// Backlog catch-up for docs that were uploaded BEFORE the OCR pipeline existed.
//
// Migration 104's backfill promoted every doc with chunks to index_status=
// 'indexed' — including docs where pdf-parse only got header noise off a
// scanned PDF. Those rows then never re-enter the reindex queue because
// _findUnindexedDocs only looks at 'pending' / 'failed'.
//
// This endpoint calls the queue_thin_extraction_reindex() function
// (migration 130) to flip the suspect 'indexed' rows back to 'pending' so
// the existing /reindex-all flow + scheduler process them through the OCR
// fallback automatically. No new chunking code; reuses everything in
// lib/library_reindex.js and lib/ocr_pdf.js.
//
// Body / query (all optional):
//   min_chunks  — chunk-count threshold (default 5)
//   min_chars   — total-content-length threshold (default 1000)
//   max_requeue — safety cap per call (default 500)
//
// Returns:
//   {
//     requeued_count: 12,
//     sample_titles: ['Quail Ridge - R&P 2021', ...],
//     threshold_used: { chunks: 5, chars: 1000 },
//     next_step: 'Run /reindex-all to process the queue, or wait for scheduler'
//   }
// ----------------------------------------------------------------------------
router.post('/queue-thin-extraction-reindex', async (req, res) => {
  try {
    const minChunks = Math.max(1, parseInt(req.body?.min_chunks || req.query.min_chunks || '5', 10));
    const minChars  = Math.max(1, parseInt(req.body?.min_chars  || req.query.min_chars  || '1000', 10));
    const maxRequeue = Math.max(1, Math.min(2000, parseInt(req.body?.max_requeue || req.query.max_requeue || '500', 10)));

    const { data, error } = await supabase.rpc('queue_thin_extraction_reindex', {
      min_chunk_count: minChunks,
      min_total_chars: minChars,
      max_requeue:     maxRequeue,
    });
    if (error) {
      console.error('[documents/queue-thin-extraction-reindex] rpc failed:', error.message);
      return res.status(500).json({ error: error.message });
    }

    // The function returns a single row (RETURNS TABLE with one tuple).
    const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
    const requeuedCount = (row && row.requeued_count) || 0;
    const sampleTitles  = (row && row.sample_titles) || [];

    res.json({
      ok: true,
      requeued_count: requeuedCount,
      sample_titles: sampleTitles,
      threshold_used: { chunks: minChunks, chars: minChars },
      max_requeue: maxRequeue,
      next_step: requeuedCount > 0
        ? 'The flagged docs are now back in the reindex queue. Click "Reindex all" to process now, or the scheduler will pick them up on its next run.'
        : 'No suspect docs found — every indexed doc has at least the minimum chunks and content length.',
    });
  } catch (err) {
    console.error('[documents/queue-thin-extraction-reindex]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/reindex-all', async (req, res) => {
  try {
    const communityFilter = (req.query.community || req.body?.community || '').trim();
    // ?category=declaration_ccrs,bylaws lets us force-reindex only governing
    // docs (Ed 2026-06-04, structure-aware chunking rollout). Without this,
    // a full re-chunk of every doc to pick up the new article/section
    // metadata would also re-embed ~1500 vendor invoices we don't care
    // about. Comma-separated; matches library_documents.category exactly.
    const categoryFilter = (req.query.category || req.body?.category || '').trim();
    const onlyMissing = (req.query.only_missing || req.body?.only_missing) !== '0';
    const offset = Math.max(0, parseInt(req.query.offset || req.body?.offset || '0', 10));
    // Hard cap at 5 docs/batch. Combined with the time budget below this keeps
    // every HTTP request under Render's proxy timeout regardless of which
    // docs are next.
    const limit  = Math.max(1, Math.min(5, parseInt(req.query.limit || req.body?.limit || '5', 10)));
    // Time-budget the batch: stop pulling new docs after this many ms so the
    // response always returns well before Render's 100s gateway timeout.
    const BATCH_BUDGET_MS = 75000;
    const startedAt = Date.now();

    // Pull candidates from library_documents. `onlyMissing` (the default)
    // now means "index_status IN ('pending','failed')" — i.e., the queue.
    // Pass-through `onlyMissing=0` returns ALL library docs (including
    // already-indexed) for explicit full-rebuild scenarios.
    let q = supabase
      .from('library_documents')
      .select('id, community_id, file_path, file_name_original, file_name_normalized, category, period_label, status, index_status, communities:community_id(name)')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .not('file_path', 'is', null)
      .order('uploaded_at', { ascending: true });
    if (onlyMissing) {
      q = q.in('index_status', ['pending', 'failed']);
    } else {
      q = q.neq('status', 'missing');
    }
    if (categoryFilter) {
      const cats = categoryFilter.split(',').map((c) => c.trim()).filter(Boolean);
      if (cats.length > 0) q = q.in('category', cats);
    }
    const { data: docs, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    let workQueue = (docs || []).map((d) => ({ ...d, community_name: (d.communities && d.communities.name) || null }));
    if (communityFilter) {
      const filt = communityFilter.toLowerCase().split(' at ')[0].trim();
      workQueue = workQueue.filter((d) => (d.community_name || '').toLowerCase().includes(filt));
    }

    const queueTotal = workQueue.length;
    const slice = workQueue.slice(offset, offset + limit);

    const results = {
      queue_total: queueTotal,
      offset,
      limit,
      processed_this_batch: 0,
      processed_total: offset,    // we'll bump this as docs complete
      next_offset: offset,        // also bumped as we complete
      indexed: 0,
      skipped: 0,
      failed: 0,
      details: [],
      done: false,
      time_budget_hit: false,
      duration_ms: 0,
    };

    for (let i = 0; i < slice.length; i++) {
      // Bail out before starting another doc if the budget is gone.
      if (Date.now() - startedAt > BATCH_BUDGET_MS) {
        results.time_budget_hit = true;
        break;
      }
      const doc = slice[i];
      try {
        const r = await _indexWithTimeout(supabase, openai, doc);
        results.processed_this_batch += 1;
        results.processed_total += 1;
        results.next_offset += 1;
        if (r.ok) {
          results.indexed += 1;
          results.details.push({ id: doc.id, name: doc.file_name_original, community: doc.community_name, chunks: r.chunks_inserted, status: 'indexed' });
        } else {
          results.skipped += 1;
          results.details.push({ id: doc.id, name: doc.file_name_original, community: doc.community_name, status: 'skipped', reason: r.reason });
        }
      } catch (e) {
        results.processed_this_batch += 1;
        results.processed_total += 1;
        results.next_offset += 1;
        results.failed += 1;
        results.details.push({ id: doc.id, name: doc.file_name_original, community: doc.community_name, status: 'failed', error: e.message });
      }
    }

    results.duration_ms = Date.now() - startedAt;
    results.done = results.next_offset >= queueTotal;

    res.json(results);
  } catch (err) {
    console.error('[documents/reindex-all]', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/documents/:id/reindex  — reindex a single doc. Manual override
// if a doc previously failed to index (e.g., was a scan, OCR added later).
// ----------------------------------------------------------------------------
router.post('/:id/reindex', async (req, res) => {
  try {
    const { data: doc, error } = await supabase
      .from('library_documents')
      .select('id, community_id, file_path, file_name_original, file_name_normalized, category, period_label, status, communities:community_id(name)')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!doc) return res.status(404).json({ error: 'library_document not found' });
    const libDoc = { ...doc, community_name: (doc.communities && doc.communities.name) || null };
    const result = await indexLibraryDoc(supabase, openai, libDoc);
    res.json(result);
  } catch (err) {
    console.error('[documents/:id/reindex]', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/documents/:id  — single document detail
// ----------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('library_documents')
      .select('*, community:communities(name, legal_name), extracted:document_extracted_fields(fields)')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Document not found' });
    res.json({ document: data });
  } catch (err) {
    console.error('[documents] detail failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/documents/:id/download  — serve the PDF
// ----------------------------------------------------------------------------
router.get('/:id/download', async (req, res) => {
  try {
    const { data: doc } = await supabase
      .from('library_documents')
      .select('file_path, file_name_normalized')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (!doc || !doc.file_path) return res.status(404).json({ error: 'File not available' });

    const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(doc.file_path);
    if (error) throw error;
    const buf = Buffer.from(await data.arrayBuffer());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${doc.file_name_normalized}"`);
    res.send(buf);
  } catch (err) {
    console.error('[documents] download failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/documents/query  — natural-language retrieval
// Body: { question: "give me 2026 LPF approved budget" }
// ----------------------------------------------------------------------------
router.post('/query', async (req, res) => {
  const t0 = Date.now();
  const { question, default_community } = req.body || {};
  if (!question || !question.trim()) return res.status(400).json({ error: 'question is required' });

  try {
    // Parse the NL question into structured filters via the AI
    const { data: cats } = await supabase.from('document_categories').select('category, display_name');
    const { data: comms } = await supabase
      .from('communities')
      .select('id, name')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);

    // Context hint: the UI's top-of-page community selector. If the user's
    // question doesn't name a community, assume they mean the selected one.
    const contextLine = default_community
      ? `\n\nUI CONTEXT: The user currently has "${default_community}" selected as the active community. If the question doesn't explicitly name a different community, assume they mean ${default_community}.`
      : '';

    const parsePrompt = `Parse this document retrieval request into structured filters. Available communities: ${JSON.stringify((comms || []).map(c => c.name))}. Available categories: ${JSON.stringify((cats || []).map(c => `${c.category} (${c.display_name})`))}.${contextLine}

Request: "${question}"

Return JSON:
{
  "community_name": "best match from available list, or null",
  "category": "best match category slug, or null",
  "period_label": "year/period like '2026' or null",
  "approval_status": "approved | draft | proposed | signed | null",
  "interpretation": "1-sentence Bedrock-voice description of what they're asking for"
}

Return ONLY the JSON, no preamble.`;

    const parseRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      messages: [{ role: 'user', content: parsePrompt }]
    });
    const parsedFilters = JSON.parse(
      (parseRes.content?.[0]?.text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    );

    // Backstop: if the AI failed to set a community AND the UI has one selected,
    // apply the UI default. Also annotate the interpretation so the user sees
    // the assumption.
    if (!parsedFilters.community_name && default_community) {
      parsedFilters.community_name = default_community;
      parsedFilters.defaulted_to_ui_community = true;
    }

    // Query documents matching the parsed filters
    let q = supabase
      .from('library_documents')
      .select('*, community:communities(name)')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);

    if (parsedFilters.community_name) {
      const match = (comms || []).find(c => c.name.toLowerCase() === parsedFilters.community_name.toLowerCase());
      if (match) q = q.eq('community_id', match.id);
    }
    if (parsedFilters.category) q = q.eq('category', parsedFilters.category);
    if (parsedFilters.period_label) q = q.ilike('period_label', `%${parsedFilters.period_label}%`);
    if (parsedFilters.approval_status) q = q.eq('approval_status', parsedFilters.approval_status);

    const { data: results, error } = await q.limit(20).order('uploaded_at', { ascending: false });
    if (error) throw error;

    res.json({
      question,
      interpretation: parsedFilters.interpretation,
      filters_applied: parsedFilters,
      results: results || [],
      result_count: (results || []).length,
      duration_ms: Date.now() - t0
    });
  } catch (err) {
    console.error('[documents] query failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// PATCH /api/documents/:id  — update metadata (push state, notes, status)
// ----------------------------------------------------------------------------
router.patch('/:id', async (req, res) => {
  try {
    const allowed = [
      'community_id', 'category', 'period_label', 'effective_date', 'expiration_date',
      'approval_status', 'status', 'title', 'created_by_mgmt_company', 'predecessor_name',
      'in_homewise_doctivity', 'in_homewise_verified_at', 'in_vantaca_library',
      'in_vantaca_verified_at', 'notes'
    ];
    const update = {};
    for (const k of allowed) if (k in (req.body || {})) update[k] = req.body[k];
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'no updatable fields supplied' });

    const { data, error } = await supabase
      .from('library_documents')
      .update(update)
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .select()
      .single();
    if (error) throw error;
    res.json({ document: data });
  } catch (err) {
    console.error('[documents] patch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// DELETE /api/documents/:id  — remove document + file
// ----------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const { data: doc } = await supabase
      .from('library_documents')
      .select('file_path')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (doc?.file_path) {
      try { await supabase.storage.from(STORAGE_BUCKET).remove([doc.file_path]); } catch (_) { /* swallow */ }
    }
    const { error } = await supabase
      .from('library_documents')
      .delete()
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[documents] delete failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/documents/duplicates  — pending duplicate groups
// ----------------------------------------------------------------------------
router.get('/duplicates/pending', async (req, res) => {
  try {
    const { data: groups, error } = await supabase
      .from('document_duplicate_groups')
      .select('*, members:document_duplicate_members(document_id, decision, document:library_documents(*))')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('resolution_status', 'pending')
      .order('detected_at', { ascending: false });
    if (error) throw error;
    res.json({ groups: groups || [] });
  } catch (err) {
    console.error('[documents] duplicates list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/documents/duplicates/:groupId/resolve
// Body: { decisions: [{ document_id, decision: 'keep' | 'delete' | 'keep_as_version' }] }
// ----------------------------------------------------------------------------
router.post('/duplicates/:groupId/resolve', async (req, res) => {
  try {
    const { decisions } = req.body || {};
    if (!Array.isArray(decisions) || decisions.length === 0) {
      return res.status(400).json({ error: 'decisions array required' });
    }
    // Record decisions on members
    for (const d of decisions) {
      await supabase
        .from('document_duplicate_members')
        .update({ decision: d.decision })
        .eq('group_id', req.params.groupId)
        .eq('document_id', d.document_id);
      // Apply the decision
      if (d.decision === 'delete') {
        const { data: doc } = await supabase
          .from('library_documents')
          .select('file_path')
          .eq('id', d.document_id)
          .maybeSingle();
        if (doc?.file_path) {
          try { await supabase.storage.from(STORAGE_BUCKET).remove([doc.file_path]); } catch (_) { /* swallow */ }
        }
        await supabase.from('library_documents').delete().eq('id', d.document_id);
      } else if (d.decision === 'keep_as_version') {
        await supabase.from('library_documents').update({ status: 'superseded' }).eq('id', d.document_id);
      }
      // 'keep' = no change to document
    }
    // Mark group resolved
    await supabase
      .from('document_duplicate_groups')
      .update({ resolution_status: 'resolved', resolved_at: new Date().toISOString() })
      .eq('id', req.params.groupId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[documents] dedup resolve failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/documents/:id/supersede
// Body: { superseded_by_id: '<library_doc_uuid>' }   // new doc that replaces this one
//
// Use cases:
//   - A new 2026 Budget supersedes the 2025 Budget for the same community.
//   - A new categorized library doc supersedes a legacy askEd doc (in this
//     case :id is the new library doc, and we mark the legacy migrated_to_library_id).
//
// If :id starts with 'legacy:' we're operating on a legacy doc; otherwise on a
// library doc.
// ----------------------------------------------------------------------------
router.post('/:id/supersede', async (req, res) => {
  try {
    const { superseded_by_id } = req.body || {};
    const docId = req.params.id;

    // Path A: legacy doc being marked as superseded by a new library doc
    if (docId.startsWith('legacy:')) {
      if (!superseded_by_id) {
        return res.status(400).json({ error: 'superseded_by_id required (the new library doc id)' });
      }
      // We need to find the legacy chunks matching this synthetic id.
      // Fastest path: look up the row in the summary view, get filename+community,
      // then update every chunk row.
      const { data: summary } = await supabase
        .from('v_legacy_documents_summary')
        .select('community_name, filename')
        .eq('legacy_id', docId)
        .maybeSingle();
      if (!summary) return res.status(404).json({ error: 'Legacy document not found' });
      const { error: upErr } = await supabase
        .from('documents')
        .update({ migrated_to_library_id: superseded_by_id })
        .eq('metadata->>community', summary.community_name)
        .eq('metadata->>filename', summary.filename);
      if (upErr) throw upErr;
      return res.json({ ok: true, type: 'legacy_marked_migrated', legacy: summary });
    }

    // Path B: library doc being marked as superseded by another library doc
    const update = {
      status: 'superseded',
      superseded_at: new Date().toISOString()
    };
    if (superseded_by_id) update.superseded_by_id = superseded_by_id;
    const { data, error } = await supabase
      .from('library_documents')
      .update(update)
      .eq('id', docId)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .select()
      .single();
    if (error) throw error;
    res.json({ ok: true, type: 'library_superseded', document: data });
  } catch (err) {
    console.error('[documents] supersede failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/documents/legacy/categorize
// Body: { legacy_id: 'legacy:<md5>' }
//
// Promote a legacy askEd doc into library_documents:
//   1) Fetch all chunks for this (community, filename) and concatenate.
//   2) Ask the AI (text-only, no PDF) to extract metadata using the same
//      DOC_EXTRACTION_PROMPT.
//   3) Insert a new library_documents row with source_origin='migrated_from_legacy'
//      and link the legacy chunks via migrated_to_library_id.
//   4) NOTE: we keep the legacy chunks in place (askEd still searches them).
//      The library row becomes the canonical metadata reference.
// ----------------------------------------------------------------------------
router.post('/legacy/categorize', async (req, res) => {
  const t0 = Date.now();
  try {
    const { legacy_id } = req.body || {};
    if (!legacy_id || !legacy_id.startsWith('legacy:')) {
      return res.status(400).json({ error: 'legacy_id required (format: legacy:<md5>)' });
    }

    // 1) Look up the legacy doc summary
    const { data: summary } = await supabase
      .from('v_legacy_documents_summary')
      .select('*')
      .eq('legacy_id', legacy_id)
      .maybeSingle();
    if (!summary) return res.status(404).json({ error: 'Legacy document not found' });
    if (summary.is_migrated) {
      return res.status(409).json({ error: 'Already migrated', migrated_to_library_id: summary.migrated_to_library_id });
    }

    // 2) Pull the concatenated text via the helper function
    const { data: textRows, error: txErr } = await supabase.rpc('legacy_document_text', {
      p_community: summary.community_name,
      p_filename: summary.filename
    });
    if (txErr) throw txErr;
    const fullText = (typeof textRows === 'string' ? textRows : '') || '';
    if (!fullText) return res.status(422).json({ error: 'No text content found in legacy chunks' });

    // 3) Ask the AI to extract metadata from the text (not a PDF — text-only path)
    const textPrompt = `${DOC_EXTRACTION_PROMPT}

NOTE: I'm giving you the EXTRACTED TEXT of this document, not the PDF. Set page_count to null. Be honest about extraction_confidence — text-only extraction is generally less reliable than PDF-based extraction.

The document filename was: "${summary.filename}"
The community is known to be: "${summary.community_name}"

--- DOCUMENT TEXT BEGINS ---
${fullText.slice(0, 80000)}
--- DOCUMENT TEXT ENDS ---`;

    const completion = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content: textPrompt }]
    });
    const rawText = completion.content?.[0]?.text || '';
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned);

    // 4) Resolve the community
    const community = await findCommunityByName(parsed.community_name || summary.community_name);

    // 5) Build the library_documents row
    const docId = crypto.randomUUID();
    const { data: catRow } = await supabase
      .from('document_categories')
      .select('display_name')
      .eq('category', STANDARD_CATEGORIES.includes(parsed.category) ? parsed.category : 'other')
      .maybeSingle();
    const categoryDisplay = catRow?.display_name || parsed.category || 'Other';
    const fileNameNormalized = buildNormalizedFilename({
      community_name: community?.name || parsed.community_name || summary.community_name,
      category_display: categoryDisplay,
      period_label: parsed.period_label,
      approval_status: parsed.approval_status
    });
    const provenance = await getPredecessorContext(community?.id, parsed.effective_date);

    const { data: doc, error: insErr } = await supabase
      .from('library_documents')
      .insert({
        id: docId,
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id: community?.id || null,
        category: STANDARD_CATEGORIES.includes(parsed.category) ? parsed.category : 'other',
        period_label: parsed.period_label || null,
        effective_date: parsed.effective_date || null,
        expiration_date: parsed.expiration_date || null,
        approval_status: parsed.approval_status || null,
        status: 'current',
        title: parsed.title || summary.filename.replace(/\.[a-z]+$/i, ''),
        file_name_original: summary.filename,
        file_name_normalized: fileNameNormalized,
        file_path: null,                         // no PDF on disk for legacy migration
        file_hash: null,
        file_size_bytes: null,
        page_count: null,
        created_by_mgmt_company: provenance.mgmt,
        predecessor_name: provenance.predecessor,
        extraction_model: 'claude-sonnet-4-5',
        extraction_confidence: parsed.extraction_confidence || 'medium',
        extraction_notes: `[Migrated from legacy askEd index, text-only extraction] ${parsed.extraction_notes || ''}`.trim(),
        source_origin: 'migrated_from_legacy'
      })
      .select()
      .single();
    if (insErr) throw insErr;

    if (parsed.extracted_fields && Object.keys(parsed.extracted_fields).length > 0) {
      await supabase.from('document_extracted_fields').insert({
        document_id: doc.id,
        fields: parsed.extracted_fields
      });
    }

    // 6) Link the legacy chunks → this new library doc
    await supabase
      .from('documents')
      .update({ migrated_to_library_id: doc.id })
      .eq('metadata->>community', summary.community_name)
      .eq('metadata->>filename', summary.filename);

    // 7) Trade tape
    await supabase.from('agent_runs').insert({
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id: community?.id || null,
      module: 'documents',
      endpoint: 'POST /api/documents/legacy/categorize',
      request_input: { legacy_id, community: summary.community_name, filename: summary.filename, chunks: summary.chunk_count },
      retrieved_context: { matched_community: community?.name },
      prompt: 'DOC_EXTRACTION_PROMPT (text-only variant)',
      model: 'claude-sonnet-4-5',
      response: { document_id: doc.id, ...parsed },
      input_tokens: completion.usage?.input_tokens || null,
      output_tokens: completion.usage?.output_tokens || null,
      duration_ms: Date.now() - t0
    });

    res.json({
      ok: true,
      document: doc,
      extracted: parsed,
      matched_community: community,
      legacy_summary: summary,
      duration_ms: Date.now() - t0
    });
  } catch (err) {
    console.error('[documents] legacy categorize failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Form Email Templates — for the "Send to Owner" workflow on the Forms tab
// ----------------------------------------------------------------------------
// Per-category subject + body templates with variable substitution. Lives
// here (not in a separate router) because it's tightly tied to library_documents
// and only applies to form categories.
//
// Endpoints:
//   GET  /api/documents/email-templates                list all templates
//   GET  /api/documents/email-templates/:category      get one template
//   PUT  /api/documents/email-templates/:category      update template (Ed-editable)
//   POST /api/documents/:id/email-render               render template with this
//                                                       doc's data + recipient name,
//                                                       returns subject + body + mailto:
// ============================================================================

router.get('/email-templates/all', async (req, res) => {
  // Note: path is '/email-templates/all' (not just '/email-templates') so it
  // doesn't get swallowed by the earlier-registered GET /:id route.
  try {
    const { data, error } = await supabase
      .from('form_email_templates')
      .select('*')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('category');
    if (error) throw error;
    res.json({ templates: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/email-templates/:category', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('form_email_templates')
      .select('*')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('category', req.params.category)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Template not found for category: ' + req.params.category });
    res.json({ template: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/email-templates/:category', async (req, res) => {
  try {
    const { subject_template, body_template, notes } = req.body || {};
    if (!subject_template || !body_template) {
      return res.status(400).json({ error: 'subject_template and body_template required' });
    }
    // Upsert — create if missing, update if exists
    const { data, error } = await supabase
      .from('form_email_templates')
      .upsert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        category: req.params.category,
        subject_template,
        body_template,
        notes: notes || null
      }, { onConflict: 'management_company_id,category' })
      .select()
      .single();
    if (error) throw error;
    res.json({ ok: true, template: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/email-render', async (req, res) => {
  try {
    const { recipient_name, recipient_email, base_url } = req.body || {};
    // Load the doc + community (incl. slug for short-URL generation)
    const { data: doc } = await supabase
      .from('library_documents')
      .select('*, community:communities(name, slug)')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    // Load the template for this doc's category
    const { data: template } = await supabase
      .from('form_email_templates')
      .select('*')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('category', doc.category)
      .maybeSingle();
    if (!template) {
      return res.status(404).json({ error: 'No email template configured for category: ' + doc.category });
    }
    // Build the download URL.
    // Domain priority:
    //   1. FORMS_PUBLIC_URL env var — pinned owner-facing domain (e.g.,
    //      my.bedrocktxai.com). Ensures email links are always branded
    //      consistently regardless of which subdomain the manager is using.
    //   2. base_url from request (window.location.origin) — fallback for
    //      local dev or before env var is set.
    //   3. Empty — last resort.
    //
    // Path priority — readable slug > UUID:
    //   - If the doc's community has a slug AND the category has a short
    //     alias (arc/fob/form), use /f/{community-slug}-{category-short}
    //     e.g., my.bedrocktxai.com/f/lpf-arc
    //     The slug always resolves to the CURRENT version, so updating
    //     the form later doesn't break old email links.
    //   - Otherwise fall back to /f/{uuid} (still works, just uglier).
    const downloadBase = (process.env.FORMS_PUBLIC_URL || base_url || '').replace(/\/+$/, '');
    const CATEGORY_TO_SHORT = {
      arc_application: 'arc',
      key_fob_form: 'fob',
      forms_and_applications: 'form'
    };
    const communitySlug = doc.community?.slug;
    const categoryShort = CATEGORY_TO_SHORT[doc.category];
    const downloadLink = (communitySlug && categoryShort)
      ? `${downloadBase}/f/${communitySlug}-${categoryShort}`
      : `${downloadBase}/f/${doc.id}`;
    const communityName = doc.community?.name || 'your community';
    const recipientNameOrEmpty = recipient_name ? ` ${recipient_name}` : '';

    // Substitute variables in subject + body
    const vars = {
      community_name: communityName,
      form_title: doc.title || doc.file_name_normalized || 'the form',
      download_link: downloadLink,
      bedrock_phone: '(832) 588-2485',
      bedrock_email: 'info@bedrocktx.com',
      recipient_name: recipient_name || '',
      recipient_name_or_empty: recipientNameOrEmpty
    };
    const fill = (str) => Object.entries(vars).reduce(
      (s, [k, v]) => s.split(`{${k}}`).join(v),
      str
    );
    const subject = fill(template.subject_template);
    const body = fill(template.body_template);

    // Construct a mailto: URL the browser can open in Outlook
    // (URL-encoded so Outlook/Gmail/etc. handle special chars correctly)
    const mailto = `mailto:${encodeURIComponent(recipient_email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

    res.json({
      ok: true,
      subject,
      body,
      mailto,
      recipient_email: recipient_email || '',
      template_category: template.category,
      document: { id: doc.id, title: doc.title, community: communityName }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/documents/categories  — master category list
// ----------------------------------------------------------------------------
router.get('/categories/list', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('document_categories')
      .select('*')
      .order('sort_order');
    if (error) throw error;
    res.json({ categories: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, drainUnindexedQueue };
