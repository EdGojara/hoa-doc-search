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
// GET /api/owner-ar/community/:id/as-of?date=YYYY-MM-DD
// Period-locked AR snapshot for board packets and historical reports.
//
// Returns one row per property in the community — the snapshot closest to
// (but not after) the target date. If a property has no snapshot on/before
// that date, it's omitted (no fabricated data).
//
// Required for the "May board package uses 5/31 even if I uploaded 6/5
// after" workflow. The /latest view always shows the most-recent regardless
// of date; this endpoint locks to a specific period.
// ----------------------------------------------------------------------------
router.get('/community/:id/as-of', async (req, res) => {
  try {
    const communityId = req.params.id;
    const target = (req.query.date || '').toString().trim();
    if (!communityId) return res.status(400).json({ error: 'community_id_required' });
    if (!target || !/^\d{4}-\d{2}-\d{2}$/.test(target)) {
      return res.status(400).json({ error: 'date_required (YYYY-MM-DD)' });
    }

    // Pull every approved snapshot for this community on/before the target.
    // Bounded: ~12 months × ~1200 properties max = ~14k rows worst case.
    // Hard cap is the safety net.
    const { data, error } = await supabase
      .from('owner_ar_snapshots')
      .select('property_id, snapshot_date, balance_total, bucket_0_30, bucket_31_60, bucket_61_90, bucket_91_120, bucket_over_120, at_legal, in_collections, payment_plan_active, payment_plan_terms_text, enforcement_stage')
      .eq('community_id', communityId)
      .not('approved_at', 'is', null)
      .lte('snapshot_date', target)
      .order('property_id', { ascending: true })
      .order('snapshot_date', { ascending: false })
      .limit(20000);
    if (error) throw error;

    // Pick the latest snapshot per property (the first one we encounter
    // after the DESC order on snapshot_date).
    const seen = new Set();
    const rows = [];
    for (const r of (data || [])) {
      if (seen.has(r.property_id)) continue;
      seen.add(r.property_id);
      rows.push(r);
    }

    res.json({
      community_id: communityId,
      as_of: target,
      property_count: rows.length,
      snapshots: rows,
    });
  } catch (err) {
    console.error('[owner_ar] as-of failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/owner-ar/staleness
// Per-community last-snapshot-date age. Powers the Owner AR tab banner that
// nudges "Canyon Gate is 47 days stale — refresh" so no community drops out
// of the monthly cadence by accident.
//
// Returns array sorted by oldest first (the ones that need attention).
// Communities with NO snapshots at all surface with last_snapshot_date=null
// so they're surfaced for first-time ingest.
// ----------------------------------------------------------------------------
router.get('/staleness', async (req, res) => {
  try {
    const { data: communities, error: cErr } = await supabase
      .from('communities')
      .select('id, name')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('active', true)
      .order('name');
    if (cErr) throw cErr;

    // Single-source-of-truth principle (Ed 2026-06-08):
    // transaction_upload_batches is the canonical Vantaca-ingest signal.
    // owner_ar_snapshots is a legacy mirror — kept as fallback for any
    // community whose latest data still lives in the old table, but
    // transaction batches win when both exist.
    //
    // Take MAX(as_of_date) per community across both sources, prefer
    // transactions when same date.

    const [{ data: batches, error: bErr }, { data: snaps, error: sErr }] = await Promise.all([
      supabase
        .from('transaction_upload_batches')
        .select('community_id, as_of_date, committed_at')
        .eq('status', 'committed')
        .order('as_of_date', { ascending: false })
        .limit(50000),
      supabase
        .from('owner_ar_snapshots')
        .select('community_id, snapshot_date')
        .not('approved_at', 'is', null)
        .order('snapshot_date', { ascending: false })
        .limit(50000),
    ]);
    if (bErr) console.warn('[owner-ar/staleness] transaction_upload_batches read failed:', bErr.message);
    if (sErr) console.warn('[owner-ar/staleness] owner_ar_snapshots read failed:', sErr.message);

    // Merge: latest per community, preferring batches when dates tie.
    const latestByCommunity = new Map();
    for (const b of (batches || [])) {
      if (!latestByCommunity.has(b.community_id)) {
        latestByCommunity.set(b.community_id, { date: b.as_of_date, source: 'transactions' });
      }
    }
    for (const s of (snaps || [])) {
      const existing = latestByCommunity.get(s.community_id);
      if (!existing) {
        latestByCommunity.set(s.community_id, { date: s.snapshot_date, source: 'snapshot' });
      } else if (s.snapshot_date > existing.date) {
        // Snapshot newer than transaction batch — unusual but respect it
        latestByCommunity.set(s.community_id, { date: s.snapshot_date, source: 'snapshot' });
      }
    }

    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const rows = (communities || []).map((c) => {
      const lastEntry = latestByCommunity.get(c.id) || null;
      const last = lastEntry?.date || null;
      let daysSince = null;
      if (last) {
        const lastDt = new Date(last + 'T00:00:00Z');
        daysSince = Math.floor((Date.parse(todayStr + 'T00:00:00Z') - lastDt.getTime()) / 86400000);
      }
      // Severity buckets so the UI doesn't have to re-implement the policy:
      //   current  : <= 35 days
      //   stale    : 36-60 days
      //   very_stale: > 60 days, OR never ingested
      let severity;
      if (daysSince == null) severity = 'never_ingested';
      else if (daysSince <= 35) severity = 'current';
      else if (daysSince <= 60) severity = 'stale';
      else severity = 'very_stale';

      return {
        community_id: c.id,
        community_name: c.name,
        last_snapshot_date: last,
        days_since: daysSince,
        severity,
        // Surface which source provided the freshest signal so the UI
        // can distinguish (or future endpoints can route on it).
        source: lastEntry?.source || null,
      };
    });

    // Sort: never_ingested + very_stale first, then by descending days_since.
    rows.sort((a, b) => {
      const sevRank = { never_ingested: 0, very_stale: 1, stale: 2, current: 3 };
      if (sevRank[a.severity] !== sevRank[b.severity]) return sevRank[a.severity] - sevRank[b.severity];
      return (b.days_since || -1) - (a.days_since || -1);
    });

    res.json({ communities: rows, computed_at: today.toISOString() });
  } catch (err) {
    console.error('[owner_ar] staleness failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/owner-ar/portfolio/trend?months=12&community_id=<optional>
// Month-by-month totals across the portfolio (or one community).
//
// Each month uses the as-of-month-end snapshot per property (closest snapshot
// on/before the last day of that month). Returns:
//   month_end, total_outstanding, at_legal_count, in_collections_count,
//   property_count, plan_active_count
//
// Used by the Owner AR tab headline trend chart.
// ----------------------------------------------------------------------------
router.get('/portfolio/trend', async (req, res) => {
  try {
    const months = Math.max(1, Math.min(36, Number(req.query.months || 12)));
    const communityId = req.query.community_id || null;

    // Generate the last N month-end dates in UTC. Month-ends are "last day of
    // month" — we use these because Ed's policy is month-end snapshots align
    // with monthly financials.
    const today = new Date();
    const monthEnds = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i + 1, 0)); // last day of (current - i)
      monthEnds.push(d.toISOString().slice(0, 10));
    }
    const earliest = monthEnds[0];

    // Pull all approved snapshots in the timeframe. Bounded: ~12 months × ~5000
    // properties × ~1-2 snapshots/month = ~120k rows worst case. Hard cap at 200k.
    let q = supabase
      .from('owner_ar_snapshots')
      .select('property_id, community_id, snapshot_date, balance_total, at_legal, in_collections, payment_plan_active')
      .not('approved_at', 'is', null)
      .gte('snapshot_date', earliest)
      .order('property_id', { ascending: true })
      .order('snapshot_date', { ascending: true })
      .limit(200000);
    if (communityId) q = q.eq('community_id', communityId);
    const { data: snaps, error } = await q;
    if (error) throw error;

    // Bucketize per (month_end, property_id) — keep the latest snapshot on/before each month_end.
    // Build a map: property_id -> [{date, ...}] ascending.
    const byProperty = new Map();
    for (const s of (snaps || [])) {
      if (!byProperty.has(s.property_id)) byProperty.set(s.property_id, []);
      byProperty.get(s.property_id).push(s);
    }

    const trend = monthEnds.map((me) => {
      let totalOutstanding = 0;
      let propCount = 0;
      let atLegal = 0;
      let inCollections = 0;
      let planActive = 0;
      for (const [, list] of byProperty) {
        // Find latest snapshot <= me. List is ascending by snapshot_date.
        let chosen = null;
        for (const s of list) {
          if (s.snapshot_date <= me) chosen = s;
          else break;
        }
        if (!chosen) continue;
        propCount += 1;
        if ((chosen.balance_total || 0) > 0) totalOutstanding += Number(chosen.balance_total);
        if (chosen.at_legal) atLegal += 1;
        if (chosen.in_collections) inCollections += 1;
        if (chosen.payment_plan_active) planActive += 1;
      }
      return {
        month_end: me,
        total_outstanding: Number(totalOutstanding.toFixed(2)),
        property_count: propCount,
        at_legal_count: atLegal,
        in_collections_count: inCollections,
        plan_active_count: planActive,
      };
    });

    res.json({ months, community_id: communityId, trend });
  } catch (err) {
    console.error('[owner_ar] portfolio trend failed:', err.message);
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
