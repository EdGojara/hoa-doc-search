// ============================================================================
// Vantaca Imports — canonical landing module for all Vantaca exports
// ----------------------------------------------------------------------------
// Mounted at /api/vantaca-imports in server.js.
//
// One module, one drop, one classifier, fans out to per-domain snapshot
// tables (owner_ar_snapshots, gl_snapshots, ap_snapshots, etc.). Until
// Bedrock replaces Vantaca with a more durable back-office system, this
// is the structural bridge that lets trustEd hold the data needed for
// every customer + board surface.
//
// HONEST NAMING: the module + endpoints + table are named `vantaca_imports`.
// Visible dependency stays visible until we cut over. Day-of-cutover, code
// gets a rename + alias; until then, the bill comes from Vantaca and the
// name reflects that.
//
// ENDPOINTS:
//   POST   /upload                    drop one file (multipart). Classifier
//                                     runs, row inserted, extractor fires
//                                     if classification is high-confidence
//                                     AND extractor exists for that type
//   GET    /                          list imports w/ filters
//   GET    /:id                       detail (incl. classification + extraction)
//   PATCH  /:id/reclassify            operator override of classification
//   POST   /:id/void                  soft-delete (audit trail preserved)
//   GET    /freshness                 staleness dashboard (per community × type)
//   GET    /report-types              metadata: which types have extractors
//
// EVERY SURFACE that consumes a Vantaca-mirrored value MUST display
// `as_of_date` from the snapshot row. Enforced at the API contract level —
// snapshots return {value, as_of_date, source_label} triples.
// ============================================================================

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { classifyVantacaFile } = require('../lib/vantaca/classifier');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const upload = multer({
  storage: multer.memoryStorage(),
  // 25MB — same ceiling as other PDF intake endpoints. Vantaca exports
  // rarely exceed a few MB but reserve study PDFs sometimes do; same limit.
  limits: { fileSize: 25 * 1024 * 1024 },
});
const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Quick Excel/CSV parser for the classifier signal-2 path. Uses 'xlsx' if
// available (existing dep in this codebase for Owner AR), falls back to a
// naive CSV split for .csv files. Returns first 50 rows or null.
function readExcelRows(buffer, mime, filename) {
  try {
    // Detect CSV by extension/MIME — no parser library needed.
    if (mime === 'text/csv' || /\.csv$/i.test(filename || '')) {
      const text = buffer.toString('utf-8').slice(0, 64 * 1024);
      return text.split(/\r?\n/).slice(0, 50).map((line) => line.split(','));
    }
    // For Excel — require xlsx lazily so the module loads even if the
    // dep isn't installed (defensive against deployment env diffs).
    let xlsx;
    try { xlsx = require('xlsx'); } catch (_) { return null; }
    const wb = xlsx.read(buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return null;
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });
    return rows.slice(0, 50);
  } catch (e) {
    console.warn('[vantaca-imports] Excel read failed:', e.message);
    return null;
  }
}

// Determine downstream extractor module path for a given report type.
// Returns the module spec (or null if extractor not yet implemented).
// Extractors are added incrementally per the architecture — AR exists
// today; GL/AP/Bank Recon/Owner Statement get added one at a time.
function getExtractorForReportType(report_type) {
  const EXTRACTORS = {
    ar_aging: { module: '../lib/vantaca/extractors/ar_aging', label: 'AR Aging' },
    check_register: { module: '../lib/vantaca/extractors/check_register', label: 'Check Register' },
    gl_export: { module: '../lib/vantaca/extractors/gl_export', label: 'GL Export' },
    transaction_history: { module: '../lib/vantaca/extractors/transaction_history', label: 'Transaction History (Owner Ledger)' },
    bank_reconciliation: { module: '../lib/vantaca/extractors/bank_reconciliation', label: 'Bank Reconciliation (Vantaca output)' },
    // Phase 2+ slots — populated as extractors are written.
    ap_ledger: null,
    owner_statement: null,
    vendor_history: null,
    budget_actual: null,
  };
  return EXTRACTORS[report_type] || null;
}

// Storage path for raw uploaded files. Per CLAUDE.md single-source-of-truth:
// raw files live in Supabase Storage at a predictable path, the import row
// holds the path. Don't co-mingle with other library uses.
function buildStoragePath({ community_id, report_type, sha, filename }) {
  const safeName = (filename || 'vantaca-import').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const typeBucket = report_type || 'unclassified';
  return `vantaca-imports/${community_id || 'unrouted'}/${typeBucket}/${sha.slice(0, 12)}-${safeName}`;
}

// ---------------------------------------------------------------------------
// POST /api/vantaca-imports/upload — drop a file, classify, extract
// ---------------------------------------------------------------------------
// Multipart body: file (single). Optional form fields:
//   override_community_id — if operator already knows which community
//   override_report_type — same, for type
//   override_as_of_date — same, for as-of
//   skip_classifier — bool, when overrides are complete
//
// Response:
//   { import: { id, status, community, report_type, as_of_date, confidence,
//               extraction_summary, downstream_snapshot_count }, ... }
// ---------------------------------------------------------------------------
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file_required' });

    const {
      override_community_id,
      override_report_type,
      override_as_of_date,
      skip_classifier,
      imported_by_user_id,
    } = req.body || {};

    const fileBuffer = req.file.buffer;
    const sha = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const filename = req.file.originalname || 'vantaca-export';
    const mime = req.file.mimetype || 'application/octet-stream';

    // Dedupe — if the same SHA was already imported AND not voided,
    // surface that instead of re-running the pipeline.
    const { data: existing } = await supabase
      .from('vantaca_imports')
      .select('id, status, community_id, report_type, as_of_date, downstream_snapshot_count, imported_at')
      .eq('source_sha256', sha)
      .neq('status', 'voided')
      .order('imported_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) {
      return res.json({
        import: existing,
        duplicate: true,
        message: 'This exact file (by SHA-256) was already imported. Returning existing record.',
      });
    }

    // Load communities for the classifier
    const { data: communities } = await supabase
      .from('communities')
      .select('id, name, slug')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('name')
      .limit(200);

    // Classify (or accept overrides)
    let classification;
    if (skip_classifier === 'true' || skip_classifier === true) {
      classification = {
        community: communities?.find((c) => c.id === override_community_id) || null,
        report_type: override_report_type || 'unknown',
        as_of_date: override_as_of_date || null,
        confidence: 'high',                  // operator says so
        signals: { override: true },
      };
    } else {
      const excelRows = readExcelRows(fileBuffer, mime, filename);
      classification = await classifyVantacaFile({
        fileBuffer,
        filename,
        mime,
        communities: communities || [],
        excelRows,
      });
      // Apply any explicit overrides on top of the classifier
      if (override_community_id) {
        classification.community = communities?.find((c) => c.id === override_community_id) || classification.community;
      }
      if (override_report_type) classification.report_type = override_report_type;
      if (override_as_of_date) classification.as_of_date = override_as_of_date;
    }

    // Store the raw file in Supabase Storage
    const storagePath = buildStoragePath({
      community_id: classification.community?.id,
      report_type: classification.report_type,
      sha,
      filename,
    });
    const { error: storageErr } = await supabase.storage
      .from('library')
      .upload(storagePath, fileBuffer, { contentType: mime, upsert: false });
    if (storageErr && !/already exists/i.test(storageErr.message)) {
      console.warn('[vantaca-imports] storage upload failed:', storageErr.message);
    }

    // Insert the canonical landing row
    const status = classification.confidence === 'low'
      ? 'needs_review'
      : 'classified';
    const { data: row, error: rowErr } = await supabase
      .from('vantaca_imports')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id: classification.community?.id || null,
        report_type: classification.report_type || null,
        as_of_date: classification.as_of_date || null,
        source: 'manual',
        source_filename: filename,
        source_storage_path: storagePath,
        source_sha256: sha,
        source_file_size_bytes: req.file.size,
        source_file_mime: mime,
        classifier_confidence: classification.confidence,
        classifier_signals: classification.signals,
        classifier_raw: classification.signals?.claude || null,
        status,
        imported_by_user_id: imported_by_user_id || null,
      })
      .select('*')
      .single();
    if (rowErr) throw rowErr;

    // If high/medium confidence AND extractor exists AND we have a community,
    // run the extractor inline. Otherwise leave for operator review.
    let extractionResult = null;
    const canExtract =
      (classification.confidence === 'high' || classification.confidence === 'medium')
      && classification.community?.id
      && classification.report_type
      && classification.report_type !== 'unknown';

    if (canExtract) {
      const extractorSpec = getExtractorForReportType(classification.report_type);
      if (extractorSpec) {
        try {
          await supabase
            .from('vantaca_imports')
            .update({ status: 'processing' })
            .eq('id', row.id);
          const extractor = require(extractorSpec.module);
          extractionResult = await extractor.run({
            importRow: row,
            fileBuffer,
            mime,
            filename,
            community: classification.community,
            supabase,
          });
          await supabase
            .from('vantaca_imports')
            .update({
              status: 'completed',
              extraction_raw: extractionResult.extraction_raw || null,
              extraction_row_count: extractionResult.row_count || 0,
              extraction_warnings: extractionResult.warnings || [],
              downstream_snapshot_table: extractionResult.downstream_table || null,
              downstream_snapshot_count: extractionResult.downstream_count || 0,
            })
            .eq('id', row.id);
        } catch (extractErr) {
          console.error('[vantaca-imports] extractor failed:', extractErr);
          await supabase
            .from('vantaca_imports')
            .update({
              status: 'failed',
              extraction_warnings: [String(extractErr.message || 'extraction error')],
            })
            .eq('id', row.id);
        }
      } else {
        // No extractor yet — leave classified, operator sees "extension pending"
        await supabase
          .from('vantaca_imports')
          .update({
            status: 'classified',
            extraction_warnings: [`No extractor implemented for report_type='${classification.report_type}' yet. Classified and stored; downstream snapshot will populate when extractor ships.`],
          })
          .eq('id', row.id);
      }
    }

    // Return the final row state
    const { data: finalRow } = await supabase
      .from('vantaca_imports')
      .select('*, communities(name, slug)')
      .eq('id', row.id)
      .maybeSingle();

    res.json({
      import: finalRow,
      classification,
      extraction: extractionResult,
    });
  } catch (err) {
    console.error('[vantaca-imports] upload failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/vantaca-imports — list imports with filters
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const { community_id, report_type, status, limit = '50' } = req.query;
    let q = supabase
      .from('vantaca_imports')
      .select('*, communities(name, slug)')
      .order('imported_at', { ascending: false })
      .limit(Math.min(parseInt(limit, 10) || 50, 200));
    if (community_id) q = q.eq('community_id', community_id);
    if (report_type) q = q.eq('report_type', report_type);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ imports: data || [] });
  } catch (err) {
    console.error('[vantaca-imports] list failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/freshness', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('v_vantaca_mirror_freshness')
      .select('*')
      .order('community_name')
      .limit(2000);
    if (error) throw error;
    res.json({ freshness: data || [] });
  } catch (err) {
    console.error('[vantaca-imports] freshness failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/report-types', async (req, res) => {
  // Hard-coded metadata about which types have working extractors.
  // Phase 1 ships with ar_aging live; others classify only.
  res.json({
    report_types: [
      { type: 'ar_aging', label: 'AR Aging', extractor: true, expected_cadence: 'weekly' },
      { type: 'gl_export', label: 'GL Export (cash account)', extractor: true, expected_cadence: 'monthly' },
      { type: 'check_register', label: 'Check Register', extractor: true, expected_cadence: 'monthly' },
      { type: 'transaction_history', label: 'Transaction History (Owner Ledger)', extractor: true, expected_cadence: 'ad_hoc' },
      { type: 'ap_ledger', label: 'AP Ledger / Vendor Invoices', extractor: false, expected_cadence: 'weekly' },
      { type: 'bank_reconciliation', label: 'Bank Rec (Vantaca-generated)', extractor: true, expected_cadence: 'monthly' },
      { type: 'owner_statement', label: 'Owner Statement', extractor: false, expected_cadence: 'monthly' },
      { type: 'vendor_history', label: 'Vendor History / 1099', extractor: false, expected_cadence: 'annual' },
      { type: 'budget_actual', label: 'Budget vs Actual', extractor: false, expected_cadence: 'monthly' },
    ],
  });
});

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('vantaca_imports')
      .select('*, communities(name, slug)')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not_found' });
    res.json({ import: data });
  } catch (err) {
    console.error('[vantaca-imports] detail failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.patch('/:id/reclassify', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = ['community_id', 'report_type', 'as_of_date'];
    const patch = {};
    for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no_fields' });
    patch.status = 'classified';
    patch.classifier_confidence = 'high';   // operator override is authoritative
    const { data, error } = await supabase
      .from('vantaca_imports')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw error;
    res.json({ import: data });
  } catch (err) {
    console.error('[vantaca-imports] reclassify failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/:id/void', express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, user_id } = req.body || {};
    const { data, error } = await supabase
      .from('vantaca_imports')
      .update({
        status: 'voided',
        voided_at: new Date().toISOString(),
        voided_by_user_id: user_id || null,
        voided_reason: reason || null,
      })
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw error;
    res.json({ import: data });
  } catch (err) {
    console.error('[vantaca-imports] void failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
