// ============================================================================
// api/legal_updates.js — Legal Updates ingestion + listing API
// ----------------------------------------------------------------------------
// Mount path: /api/legal-updates (registered in server.js).
//
// Endpoints:
//   POST   /                         upload a PDF, extract metadata, save
//   GET    /                         list with filters
//   GET    /:id                      detail with chunk count
//   PATCH  /:id                      operator review/edit
//   GET    /vocab                    controlled vocabularies for UI
//
// Architecture:
//   - PDF is stored in the 'documents' storage bucket like every other
//     library doc — no parallel storage silo.
//   - library_documents row gets category='legal_update', community_id=null
//     (legal updates are cross-community); chunks get community='Law' so
//     hybrid retrieval pulls them on every query via the Law fallback.
//   - Sidecar row in legal_updates table holds the structured metadata.
//   - indexLibraryDoc() runs synchronously after insert so chunks are
//     ready as soon as the API returns. Catastrophic-output surface so
//     we don't ship without verifying the indexing landed.
// ============================================================================

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { extractLegalUpdateMetadata, VALID_TOPICS, VALID_JURISDICTIONS } = require('../lib/legal_updates_extract');
const { indexLibraryDoc } = require('../lib/library_reindex');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});

const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const STORAGE_BUCKET = 'documents';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ----------------------------------------------------------------------------
// GET /vocab — controlled vocabulary for the UI's tag pickers
// ----------------------------------------------------------------------------
router.get('/vocab', (_req, res) => {
  res.json({ topics: VALID_TOPICS, jurisdictions: VALID_JURISDICTIONS });
});

// ----------------------------------------------------------------------------
// POST /  — upload + extract + index
//
// Body (multipart):
//   file: PDF binary (required)
//   title: optional override title (defaults to filename)
//
// Returns:
//   { legal_update: {...}, library_document: {...}, raw_extracted, warnings }
// ----------------------------------------------------------------------------
router.post('/', upload.single('file'), async (req, res) => {
  const warnings = [];
  try {
    if (!req.file) return res.status(400).json({ error: 'file_required' });
    if (!req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({ error: 'file_empty' });
    }
    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'pdf_only' });
    }

    // 1. AI extraction — PDF binary directly to Claude per CLAUDE.md form-PDF rule.
    let extraction = { parsed: null, raw: '', modelMessage: null };
    try {
      extraction = await extractLegalUpdateMetadata(req.file.buffer);
    } catch (extErr) {
      console.warn('[legal-updates] extraction failed:', extErr?.message);
      warnings.push({ stage: 'extraction', message: extErr?.message });
    }
    const parsed = extraction.parsed || {};

    // 2. Validate required fields. If extraction failed to capture
    //    source_publisher / source_date / key_holding, the operator
    //    has to fill them via the post-upload review form — but we
    //    still proceed with the upload so the file isn't lost.
    const missingRequired = [];
    if (!parsed.source_publisher) missingRequired.push('source_publisher');
    if (!parsed.source_date) missingRequired.push('source_date');
    if (!parsed.key_holding) missingRequired.push('key_holding');

    // 3. Hash + dedup check. If the same PDF was already uploaded, return
    //    the existing legal_update row + library_doc instead of creating a
    //    duplicate.
    const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const { data: existingDoc } = await supabase
      .from('library_documents')
      .select('id')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('file_hash', fileHash)
      .maybeSingle();
    if (existingDoc) {
      const { data: existingLU } = await supabase
        .from('legal_updates')
        .select('*')
        .eq('library_document_id', existingDoc.id)
        .maybeSingle();
      return res.status(200).json({
        duplicate: true,
        legal_update: existingLU,
        library_document_id: existingDoc.id,
        raw_extracted: extraction.raw,
        warnings,
      });
    }

    // 4. Upload to storage. Path uses 'legal_update' subfolder so listing
    //    by folder shows the legal-updates corpus cleanly.
    const docId = crypto.randomUUID();
    const filePath = `${BEDROCK_MGMT_CO_ID}/legal/${docId}.pdf`;
    const { error: storageErr } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(filePath, req.file.buffer, {
        contentType: 'application/pdf',
        upsert: false,
      });
    if (storageErr) {
      console.error('[legal-updates] storage upload failed:', storageErr.message);
      return res.status(500).json({ error: safeErrorMessage(storageErr), warnings });
    }

    // 5. Insert library_documents row. community_id is null (cross-community);
    //    chunks will get community='Law' via library_reindex's resolution
    //    logic when community_name is unset and we pass it explicitly.
    const title = (req.body?.title || '').trim() || parsed.source_publisher
      ? `${parsed.source_publisher || 'Legal Update'} — ${parsed.key_holding ? parsed.key_holding.slice(0, 80) : (req.file.originalname || 'legal update').replace(/\.pdf$/i, '')}`
      : (req.file.originalname || 'Legal Update').replace(/\.pdf$/i, '');
    const { data: libDoc, error: libErr } = await supabase
      .from('library_documents')
      .insert({
        id: docId,
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id: null,                          // cross-community
        category: 'legal_update',
        period_label: parsed.source_date || null,
        effective_date: parsed.effective_date || parsed.source_date || null,
        approval_status: null,
        status: 'current',
        title,
        file_name_original: req.file.originalname,
        file_name_normalized: req.file.originalname,
        file_path: filePath,
        file_hash: fileHash,
        file_size_bytes: req.file.size,
        extraction_model: 'claude-sonnet-4-5',
        extraction_confidence: parsed.confidence || 'medium',
        extraction_notes: missingRequired.length ? `Missing: ${missingRequired.join(', ')}` : null,
        index_status: 'pending',
      })
      .select()
      .single();
    if (libErr) {
      console.error('[legal-updates] library_documents insert failed:', libErr.message);
      try { await supabase.storage.from(STORAGE_BUCKET).remove([filePath]); } catch (_) {}
      return res.status(500).json({ error: safeErrorMessage(libErr), warnings });
    }

    // 6. Insert legal_updates sidecar. Required fields use either the
    //    extraction OR safe placeholders the operator must edit.
    const luRow = {
      library_document_id: libDoc.id,
      source_publisher: parsed.source_publisher || '(unknown — please edit)',
      source_url: parsed.source_url || null,
      source_date: parsed.source_date || new Date().toISOString().slice(0, 10),
      effective_date: parsed.effective_date || null,
      jurisdiction: parsed.jurisdiction || [],
      topics: parsed.topics || [],
      key_holding: parsed.key_holding || '(extraction failed — please edit)',
      key_quote: parsed.key_quote || null,
      status: 'current',
      ai_extracted: extraction.raw ? { raw: extraction.raw, parsed } : {},
    };
    const { data: lu, error: luErr } = await supabase
      .from('legal_updates')
      .insert(luRow)
      .select()
      .single();
    if (luErr) {
      console.error('[legal-updates] legal_updates insert failed:', luErr.message);
      // Roll back library doc + storage to avoid an orphan
      try { await supabase.from('library_documents').delete().eq('id', libDoc.id); } catch (_) {}
      try { await supabase.storage.from(STORAGE_BUCKET).remove([filePath]); } catch (_) {}
      return res.status(500).json({ error: safeErrorMessage(luErr), warnings });
    }

    // 7. Resolve supersedes_id if the extraction surfaced notice ids.
    //    Best-effort — match against existing legal_updates by partial
    //    string in source_publisher or key_holding. Operator can correct
    //    on review.
    if (Array.isArray(parsed.supersedes_notice_ids) && parsed.supersedes_notice_ids.length > 0) {
      try {
        const needle = parsed.supersedes_notice_ids[0];
        const { data: candidates } = await supabase
          .from('legal_updates')
          .select('id, source_publisher, key_holding')
          .or(`key_holding.ilike.%${needle}%,source_publisher.ilike.%${needle}%`)
          .neq('id', lu.id)
          .limit(1);
        if (candidates && candidates[0]) {
          await supabase
            .from('legal_updates')
            .update({ supersedes_id: candidates[0].id })
            .eq('id', lu.id);
          warnings.push({ stage: 'supersedes', message: `Linked supersedes -> ${candidates[0].source_publisher}. Verify on review.` });
        }
      } catch (e) {
        console.warn('[legal-updates] supersedes resolution skipped:', e.message);
      }
    }

    // 8. Index the chunks synchronously. Catastrophic-output surface =
    //    don't return success until retrieval can actually find this doc.
    //    Forces communityName='Law' so chunks are tagged for cross-
    //    community retrieval.
    try {
      await indexLibraryDoc({
        ...libDoc,
        community_name: 'Law',
      });
    } catch (idxErr) {
      console.warn('[legal-updates] indexing failed (doc is saved, will retry via scheduler):', idxErr?.message);
      warnings.push({ stage: 'indexing', message: idxErr?.message });
    }

    return res.status(201).json({
      legal_update: lu,
      library_document_id: libDoc.id,
      file_path: filePath,
      raw_extracted: extraction.raw,
      missing_required: missingRequired,
      warnings,
    });
  } catch (err) {
    console.error('[legal-updates] POST / failed:', err.stack || err.message);
    return res.status(500).json({ error: safeErrorMessage(err), warnings });
  }
});

// ----------------------------------------------------------------------------
// GET /  — list with filters
//
// Query params:
//   status    'current' (default) | 'superseded' | 'historical' | 'all'
//   topic     repeatable, filter by any matching topic
//   q         text search across source_publisher + key_holding
//   limit     default 50, hard cap 200
//   offset    default 0
// ----------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const status = String(req.query.status || 'current');
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
    const q = (req.query.q || '').toString().trim();
    const topics = []
      .concat(req.query.topic || [])
      .filter(Boolean);

    let query = supabase
      .from('legal_updates')
      .select('*, library_documents(id, title, file_name_original, file_path)', { count: 'exact' })
      .order('source_date', { ascending: false });
    if (status !== 'all') query = query.eq('status', status);
    if (topics.length > 0) query = query.overlaps('topics', topics);
    if (q) query = query.or(`source_publisher.ilike.%${q}%,key_holding.ilike.%${q}%`);
    query = query.range(offset, offset + limit - 1);
    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: safeErrorMessage(error) });
    res.json({ legal_updates: data || [], total: count || 0, limit, offset });
  } catch (err) {
    console.error('[legal-updates] GET / failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /:id — detail
// ----------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('legal_updates')
      .select('*, library_documents(id, title, file_name_original, file_path, file_size_bytes)')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: safeErrorMessage(error) });
    if (!data) return res.status(404).json({ error: 'not_found' });
    // Chunk count — useful for the operator to see retrieval is ready.
    const { count: chunkCount } = await supabase
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .eq('metadata->>library_document_id', data.library_document_id);
    // Supersedes chain — find any rows we supersede AND any that
    // supersede us (the latter only happens after we've been superseded).
    const supersedes = data.supersedes_id
      ? (await supabase.from('legal_updates').select('id, source_publisher, source_date, key_holding').eq('id', data.supersedes_id).maybeSingle()).data
      : null;
    const supersededBy = (await supabase
      .from('legal_updates')
      .select('id, source_publisher, source_date, key_holding')
      .eq('supersedes_id', data.id)
      .order('source_date', { ascending: false })
      .limit(5)).data;
    res.json({ legal_update: data, chunk_count: chunkCount || 0, supersedes, superseded_by: supersededBy || [] });
  } catch (err) {
    console.error('[legal-updates] GET /:id failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// PATCH /:id — operator review/edit
//
// allowedFields enforced per CLAUDE.md PATCH convention. Reviewing the
// record also stamps reviewed_at + reviewed_by so the audit trail shows
// when the operator confirmed the AI extraction.
// ----------------------------------------------------------------------------
const ALLOWED_PATCH_FIELDS = [
  'source_publisher', 'source_url', 'source_date', 'effective_date',
  'jurisdiction', 'topics', 'key_holding', 'key_quote',
  'supersedes_id', 'status', 'reviewed_by',
];
router.patch('/:id', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const patch = {};
    for (const f of ALLOWED_PATCH_FIELDS) {
      if (req.body[f] !== undefined) patch[f] = req.body[f];
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'no_allowed_fields' });
    }
    // Clamp controlled vocab if topics/jurisdiction are being patched.
    if (Array.isArray(patch.topics)) {
      patch.topics = patch.topics.filter((t) => VALID_TOPICS.includes(t));
    }
    if (Array.isArray(patch.jurisdiction)) {
      patch.jurisdiction = patch.jurisdiction.filter((j) => VALID_JURISDICTIONS.includes(j));
    }
    if (patch.reviewed_by) patch.reviewed_at = new Date().toISOString();
    if (patch.status && !['current', 'superseded', 'historical'].includes(patch.status)) {
      return res.status(400).json({ error: 'invalid_status' });
    }
    const { data, error } = await supabase
      .from('legal_updates')
      .update(patch)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: safeErrorMessage(error) });
    res.json({ legal_update: data });
  } catch (err) {
    console.error('[legal-updates] PATCH /:id failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
