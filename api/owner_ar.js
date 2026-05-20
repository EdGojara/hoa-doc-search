// =============================================================================
// Owner Receivables — Vantaca AR ingest + snapshot store + portfolio view
// =============================================================================
// Mounted at /api/owner-ar in server.js.
//
// Module purpose (project_owner_receivables.md):
// Until Bedrock builds its own accounting layer, this is the bridge. Operator
// drag-drops a Vantaca AR Aging PDF, the AI extracts per-property balance +
// aging buckets + dunning status, operator reviews the preview, approves,
// rows persist to owner_ar_snapshots. The latest approved snapshot per
// property joins into v_property_summary so the board-portal property tile
// shows current balance + at-legal flag.
//
// IMPORTANT DISCIPLINE: every UI surface that displays a balance from this
// module must label it 'as of [snapshot_date]'. Vantaca remains the live
// ledger; this is visibility infrastructure, not authority.
//
// Endpoints:
//   POST   /api/owner-ar/ingest                  drag-drop PDF; returns preview
//          (does NOT persist — operator must hit /approve)
//   POST   /api/owner-ar/ingest/:batch_id/approve commit the previewed batch
//   POST   /api/owner-ar/ingest/:batch_id/discard throw away
//   GET    /api/owner-ar/batches                 list ingest history per community
//   GET    /api/owner-ar/property/:id/history    AR history for one property
//   GET    /api/owner-ar/community/:id/at-legal  portfolio 'at legal' list
//   GET    /api/owner-ar/portfolio/at-legal      cross-community at-legal list
// =============================================================================

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { resolveProperty } = require('../lib/entity_resolution');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const router = express.Router();

// ----------------------------------------------------------------------------
// Extraction prompt — keep tight, return JSON only.
// ----------------------------------------------------------------------------
const AR_EXTRACTION_PROMPT = `You are reviewing a Vantaca (or similar HOA accounting) AR Aging report PDF.
The report lists per-account current balances broken into aging buckets, with
optional status notes like 'with attorney', 'in collections', 'payment plan'.

Extract a JSON object with this exact shape:

{
  "snapshot_date":     "YYYY-MM-DD — the AS-OF date claimed by the report header (look for 'Aging as of', 'Run date', or similar)",
  "community_name":    "string — community/HOA name from the report header, or null if not visible",
  "report_totals": {
    "total_ar":        <number — total receivable across all accounts>,
    "delinquent_count":<integer — accounts with balance > 0, if reported>,
    "current_count":   <integer — accounts at zero, if reported>
  },
  "rows": [
    {
      "property_address": "string — street address as written on the report",
      "unit":             "string or null — unit/apt/suite if present",
      "homeowner_name":   "string — primary account holder name",
      "account_number":   "string or null — Vantaca account ID if shown",
      "balance_total":    <number>,
      "bucket_0_30":      <number>,
      "bucket_31_60":     <number>,
      "bucket_61_90":     <number>,
      "bucket_91_120":    <number>,
      "bucket_over_120":  <number>,
      "at_legal":         <boolean — true if 'with attorney' / 'at legal' / 'WA' indicator>,
      "in_collections":   <boolean — true if 'in collections' / 'collections' indicator>,
      "payment_plan_active": <boolean — true if a payment plan is indicated>,
      "payment_plan_terms": "string or null — verbatim payment-plan terms if shown",
      "enforcement_stage": "reminder|courtesy_1|courtesy_2|certified_209|at_legal|with_attorney|in_collections|judgment|lien_filed|null — the most-recent dunning stage if visible (use null when no stage indicated)",
      "notes":            "string or null — any free-form note attached to this row (e.g., 'returned mail', 'spouse deceased', etc.)"
    }
  ]
}

EXTRACTION RULES:
- Money values are NUMBERS not strings (no dollar signs, no commas, parens for negatives → negative number)
- Zero balances are still extracted (a row with balance_total=0 is valid; some reports include them)
- Unit numbers stay separate from street address ('#2A' is unit, not part of street)
- If a row has multiple owners listed, use the primary (usually first) name
- Status flags are inferred from typical Vantaca indicators: 'WA' = with attorney, 'IC' = in collections, 'PP' = payment plan
- enforcement_stage: choose the highest-severity stage indicated. If a row says 'with attorney' use 'with_attorney'; if it says 'certified §209' use 'certified_209'.
- If snapshot_date is not clearly stated, use NULL and let the operator set it in review

Return ONLY the JSON. No preamble, no markdown fences.`;

// ----------------------------------------------------------------------------
// Helper — run the AI extraction
// ----------------------------------------------------------------------------
async function extractArFromPdf(pdfBuffer) {
  const t0 = Date.now();
  const pdfBase64 = pdfBuffer.toString('base64');

  const completion = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: AR_EXTRACTION_PROMPT }
      ]
    }]
  });

  const text = completion.content?.[0]?.text || '';
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const stopReason = completion.stop_reason;
    const hint = stopReason === 'max_tokens'
      ? ' Model hit max_tokens; output truncated. Bump the cap or split the report.'
      : '';
    throw new Error(`AR extraction returned malformed JSON.${hint} Parse error: ${err.message}`);
  }
  return { parsed, usage: completion.usage, duration_ms: Date.now() - t0 };
}

// ----------------------------------------------------------------------------
// POST /api/owner-ar/ingest
// Drag-drop endpoint: extracts and stages a batch for operator review.
// Does NOT commit to owner_ar_snapshots — that happens on /approve.
//
// Body: multipart with field 'pdf' + optional 'community_id' (operator pick)
// ----------------------------------------------------------------------------
router.post('/ingest', upload.single('pdf'), async (req, res) => {
  const t0 = Date.now();
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded (expected field "pdf")' });
    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: `Unsupported file type: ${req.file.mimetype}` });
    }
    const communityId = req.body && req.body.community_id ? req.body.community_id : null;

    // Optional: stash the source PDF in storage for audit trail
    let storagePath = null;
    try {
      const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 16);
      const safeName = (req.file.originalname || 'ar_report.pdf').replace(/[^a-zA-Z0-9._\-]/g, '_');
      storagePath = `ar_ingests/${hash}_${safeName}`;
      await supabase.storage
        .from('documents')
        .upload(storagePath, req.file.buffer, { contentType: 'application/pdf', upsert: true });
    } catch (e) {
      console.warn('[owner_ar] storage upload failed (non-fatal):', e.message);
      storagePath = null;
    }

    // Run extraction
    const { parsed } = await extractArFromPdf(req.file.buffer);
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];

    // Resolve each row's property_address → properties.id (match-only;
    // unmatched rows surface in the operator's preview for triage)
    const resolved = [];
    let matchedCount = 0;
    for (const row of rows) {
      let propertyMatch = null;
      // If operator didn't pre-select a community, we can't match property
      // (resolveProperty needs a community to scope to). Surface as unmatched.
      if (communityId && row.property_address) {
        try {
          const m = await resolveProperty(supabase, communityId, row.property_address);
          if (m && m.id) propertyMatch = m;
        } catch (e) { /* swallow per-row resolve errors */ }
      }
      if (propertyMatch) matchedCount += 1;
      resolved.push({
        ...row,
        property_id: propertyMatch ? propertyMatch.id : null,
        property_match_confidence: propertyMatch ? propertyMatch.match_confidence : null,
        matched_address: propertyMatch ? `${propertyMatch.street_address}${propertyMatch.unit ? ' #' + propertyMatch.unit : ''}` : null,
      });
    }

    // Persist the batch (status='previewed' — awaiting operator approve)
    const { data: batch, error: batchErr } = await supabase
      .from('ar_ingest_batches')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id: communityId,
        source_filename: req.file.originalname || null,
        source_storage_path: storagePath,
        snapshot_date: parsed.snapshot_date || null,
        total_rows: rows.length,
        rows_matched_property: matchedCount,
        rows_unmatched: rows.length - matchedCount,
        status: 'previewed',
        raw_extraction: { snapshot_date: parsed.snapshot_date, community_name: parsed.community_name, report_totals: parsed.report_totals, rows: resolved },
        extraction_model: 'claude-sonnet-4-5',
      })
      .select('id')
      .single();
    if (batchErr) throw batchErr;

    res.json({
      ok: true,
      batch_id: batch.id,
      snapshot_date: parsed.snapshot_date || null,
      community_name: parsed.community_name || null,
      report_totals: parsed.report_totals || null,
      total_rows: rows.length,
      rows_matched_property: matchedCount,
      rows_unmatched: rows.length - matchedCount,
      preview_rows: resolved.slice(0, 50),   // first 50 for the preview UI
      preview_truncated: rows.length > 50,
      duration_ms: Date.now() - t0,
    });
  } catch (err) {
    console.error('[owner_ar] ingest failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/owner-ar/ingest/:batch_id/approve
// Commit the previewed batch: write per-property snapshots into
// owner_ar_snapshots. Operator can pass an override snapshot_date if the
// extracted one was wrong or missing.
//
// Body: { snapshot_date?: 'YYYY-MM-DD' }
// ----------------------------------------------------------------------------
router.post('/ingest/:batch_id/approve', express.json(), async (req, res) => {
  try {
    const { data: batch, error: bErr } = await supabase
      .from('ar_ingest_batches')
      .select('*')
      .eq('id', req.params.batch_id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (bErr) throw bErr;
    if (!batch) return res.status(404).json({ error: 'batch_not_found' });
    if (batch.status !== 'previewed') {
      return res.status(409).json({ error: `batch already ${batch.status}` });
    }

    const snapshotDate = (req.body && req.body.snapshot_date) || batch.snapshot_date;
    if (!snapshotDate) {
      return res.status(400).json({ error: 'snapshot_date required (extraction did not produce one; operator must supply)' });
    }

    const rows = (batch.raw_extraction && Array.isArray(batch.raw_extraction.rows)) ? batch.raw_extraction.rows : [];
    if (rows.length === 0) return res.status(400).json({ error: 'batch has no rows to approve' });

    // Build snapshot inserts. Skip rows with no property_id — those need
    // operator intervention (typo in address, property not yet Vantaca-synced).
    const toInsert = [];
    let skipped = 0;
    for (const r of rows) {
      if (!r.property_id) { skipped += 1; continue; }
      toInsert.push({
        management_company_id:  BEDROCK_MGMT_CO_ID,
        community_id:           batch.community_id,
        property_id:            r.property_id,
        snapshot_date:          snapshotDate,
        source_filename:        batch.source_filename,
        source_storage_path:    batch.source_storage_path,
        ingest_batch_id:        batch.id,
        balance_total:          r.balance_total,
        bucket_0_30:            r.bucket_0_30,
        bucket_31_60:           r.bucket_31_60,
        bucket_61_90:           r.bucket_61_90,
        bucket_91_120:          r.bucket_91_120,
        bucket_over_120:        r.bucket_over_120,
        at_legal:               !!r.at_legal,
        in_collections:         !!r.in_collections,
        payment_plan_active:    !!r.payment_plan_active,
        payment_plan_terms_text:r.payment_plan_terms || null,
        enforcement_stage:      r.enforcement_stage || null,
        enforcement_notes:      r.notes || null,
        raw_extraction:         r,
        extracted_by_model:     batch.extraction_model,
        approved_at:            new Date().toISOString(),
      });
    }

    // Upsert (one snapshot per property × snapshot_date) so re-running an
    // approve after a fix updates instead of duplicating.
    const { error: insErr, count } = await supabase
      .from('owner_ar_snapshots')
      .upsert(toInsert, { onConflict: 'property_id,snapshot_date', count: 'exact' });
    if (insErr) throw insErr;

    // Mark batch approved
    await supabase
      .from('ar_ingest_batches')
      .update({ status: 'approved', approved_at: new Date().toISOString(), snapshot_date: snapshotDate })
      .eq('id', batch.id);

    res.json({
      ok: true,
      snapshots_written: toInsert.length,
      rows_skipped_unmatched: skipped,
      snapshot_date: snapshotDate,
    });
  } catch (err) {
    console.error('[owner_ar] approve failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/owner-ar/ingest/:batch_id/discard
// ----------------------------------------------------------------------------
router.post('/ingest/:batch_id/discard', async (req, res) => {
  try {
    await supabase
      .from('ar_ingest_batches')
      .update({ status: 'discarded' })
      .eq('id', req.params.batch_id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/owner-ar/batches — ingest history (per community optional)
// ----------------------------------------------------------------------------
router.get('/batches', async (req, res) => {
  try {
    let q = supabase
      .from('ar_ingest_batches')
      .select('id, community_id, source_filename, snapshot_date, total_rows, rows_matched_property, rows_unmatched, status, uploaded_at, approved_at')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('uploaded_at', { ascending: false })
      .limit(100);
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ batches: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/owner-ar/property/:id/history
// Full snapshot history for one property (timeline for the drawer)
// ----------------------------------------------------------------------------
router.get('/property/:id/history', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('owner_ar_snapshots')
      .select('id, snapshot_date, balance_total, bucket_0_30, bucket_31_60, bucket_61_90, bucket_91_120, bucket_over_120, at_legal, in_collections, payment_plan_active, enforcement_stage, source_filename')
      .eq('property_id', req.params.id)
      .not('approved_at', 'is', null)
      .order('snapshot_date', { ascending: false });
    if (error) throw error;
    res.json({ history: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/owner-ar/community/:id/at-legal
// All properties in this community currently at legal (or in collections),
// from the latest approved snapshot.
// ----------------------------------------------------------------------------
router.get('/community/:id/at-legal', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('v_property_summary')
      .select('property_id, street_address, unit, owner_name, current_balance, ar_at_legal, ar_in_collections, ar_payment_plan_active, ar_enforcement_stage, ar_snapshot_date, ar_days_since_snapshot')
      .eq('community_id', req.params.id)
      .or('ar_at_legal.eq.true,ar_in_collections.eq.true')
      .order('current_balance', { ascending: false, nullsFirst: false });
    if (error) throw error;
    res.json({ properties: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/owner-ar/portfolio/at-legal
// Cross-community at-legal list — the boardroom-money portfolio view.
// ----------------------------------------------------------------------------
router.get('/portfolio/at-legal', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('v_property_summary')
      .select('property_id, community_id, community_name, street_address, unit, owner_name, current_balance, ar_at_legal, ar_in_collections, ar_payment_plan_active, ar_enforcement_stage, ar_snapshot_date, ar_days_since_snapshot')
      .or('ar_at_legal.eq.true,ar_in_collections.eq.true')
      .order('current_balance', { ascending: false, nullsFirst: false });
    if (error) throw error;
    res.json({ properties: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
