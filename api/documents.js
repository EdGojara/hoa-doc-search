// ============================================================================
// Documents Tracker
// ----------------------------------------------------------------------------
// Endpoints under /api/documents for Bedrock's canonical document library.
//
//   POST /upload          single PDF, auto-extract metadata, dedup, save
//   POST /bulk-upload     multiple PDFs at once; reports dedups + extractions
//   GET  /                list documents (filterable)
//   GET  /matrix          per-community document matrix view
//   GET  /:id             single document with extracted fields
//   GET  /:id/download    serve the PDF file
//   POST /query           natural-language retrieval ("give me 2026 LPF Budget")
//   PATCH /:id            update document metadata (push state, notes, status)
//   DELETE /:id           remove a document (and its file from storage)
//   GET  /duplicates      list pending duplicate groups
//   POST /duplicates/:id/resolve   accept keep/delete decisions
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
  'bylaws', 'declaration_ccrs', 'rules_and_regulations',
  'resolutions_and_policies', 'articles_of_incorporation',
  'annual_financial_statements', 'current_unaudited_financials',
  'w9', 'welcome_package', 'engineers_inspection_report',
  'litigation', 'design_document', 'special_assessments',
  'unit_ledger', 'management_agreement', 'other'
];

const DOC_EXTRACTION_PROMPT = `You are extracting metadata from a community association (HOA) document. Read the PDF and return a JSON object with EXACTLY this shape:

{
  "community_name": "string (best-guess of the community/association name from document content)",
  "community_legal_name": "string (full legal name if found, e.g., 'Lakes of Pine Forest Homeowners Association, Inc.')",
  "category": "one of: annual_budget | insurance_dec_page | annual_board_meeting_minutes | regular_meeting_minutes | reserve_study | reserve_report | bylaws | declaration_ccrs | rules_and_regulations | resolutions_and_policies | articles_of_incorporation | annual_financial_statements | current_unaudited_financials | w9 | welcome_package | engineers_inspection_report | litigation | design_document | special_assessments | unit_ledger | management_agreement | other",
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
  "extraction_notes": "Free text. Anything unusual you noticed about this document: ambiguous category, unclear period, multiple possible interpretations, scan quality issues."
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
      console.warn(`[documents] Claude rate-limited, retrying in ${delay/1000}s (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length})`);
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

async function findCommunityByName(name) {
  if (!name) return null;
  // Try exact first, then ilike, then fuzzy on legal_name
  let { data } = await supabase
    .from('communities')
    .select('id, name, legal_name')
    .eq('management_company_id', BEDROCK_MGMT_CO_ID)
    .ilike('name', name)
    .maybeSingle();
  if (data) return data;
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
  return null;
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

    // 2) Extract metadata via Claude
    const { parsed, usage } = await extractDocumentMetadata(req.file.buffer);

    // 3) Match community + load category display name
    const community = await findCommunityByName(parsed.community_name);
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
        extraction_notes: parsed.extraction_notes || null
      })
      .select()
      .single();
    if (insErr) throw insErr;

    // 9) Store extracted fields
    if (parsed.extracted_fields && Object.keys(parsed.extracted_fields).length > 0) {
      await supabase.from('document_extracted_fields').insert({
        document_id: doc.id,
        fields: parsed.extracted_fields
      });
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

    res.json({
      ok: true,
      document: doc,
      matched_community: community,
      extracted: parsed,
      stored_file: uploadedFile,
      semantic_duplicate: semanticDup,
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
// Query: ?community_id&category&status&include_predecessor=true
// ----------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    let q = supabase
      .from('library_documents')
      .select('*, community:communities(name, legal_name), extracted:document_extracted_fields(fields)')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('uploaded_at', { ascending: false });
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    if (req.query.category) q = q.eq('category', req.query.category);
    if (req.query.status) q = q.eq('status', req.query.status);
    if (req.query.include_predecessor !== 'true') {
      // by default, show all; if explicit 'false' is passed, filter out predecessor
      if (req.query.include_predecessor === 'false') {
        q = q.eq('created_by_mgmt_company', 'Bedrock');
      }
    }
    const { data, error } = await q.limit(Number(req.query.limit) || 200);
    if (error) throw error;
    res.json({ documents: data || [] });
  } catch (err) {
    console.error('[documents] list failed:', err.message);
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
  const { question } = req.body || {};
  if (!question || !question.trim()) return res.status(400).json({ error: 'question is required' });

  try {
    // Parse the NL question into structured filters via Claude
    const { data: cats } = await supabase.from('document_categories').select('category, display_name');
    const { data: comms } = await supabase
      .from('communities')
      .select('id, name')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);

    const parsePrompt = `Parse this document retrieval request into structured filters. Available communities: ${JSON.stringify((comms || []).map(c => c.name))}. Available categories: ${JSON.stringify((cats || []).map(c => `${c.category} (${c.display_name})`))}.

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

module.exports = { router };
