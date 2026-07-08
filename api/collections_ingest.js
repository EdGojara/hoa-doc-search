// ============================================================================
// api/collections_ingest.js  (Ed 2026-07-08) — mounted at /api/collections-ingest
// ----------------------------------------------------------------------------
// Recurring drop-in ingest for the Winstead PC monthly collections status
// report. Operator drops the "Matter Detail Portrait" PDF; the AI extracts the
// matters; each is matched to a property and given a proposed collection_status
// (lib/collections/winstead_extract) plus a DELTA vs the current state (new /
// changed / same); operator reviews (and can override any status) then
// approves — the rows upsert into the canonical ar_account_collections (SSOT,
// mig 232), which already feeds the Board Portal, board packet, and Homeowner
// 360. Nothing is written until /approve. Admin-only beta.
//
//   POST /api/collections-ingest/ingest                 drop PDF -> preview (persists batch, not statuses)
//   POST /api/collections-ingest/ingest/:id/approve     commit the batch (optional per-property overrides)
//   POST /api/collections-ingest/ingest/:id/discard     throw the batch away
//   GET  /api/collections-ingest/batches                ingest history
// ============================================================================
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { extractWinsteadMatters, COLLECTION_STATUSES } = require('../lib/collections/winstead_extract');
const { resolveProperty } = require('../lib/entity_resolution');
const { requireAdmin } = require('./_require_admin');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const router = express.Router();

// Compact, human-readable notes line stored on each ar_account_collections row.
function noteFor(m, asOf) {
  const parts = [`Winstead #${m.firm_file}`, m.debtors, `Bal $${Number(m.balance_total || 0).toFixed(2)}`];
  const fees = [];
  if (m.attorney_fee) fees.push(`atty fee $${Number(m.attorney_fee).toFixed(2)}`);
  if (m.collection_cost) fees.push(`coll cost $${Number(m.collection_cost).toFixed(2)}`);
  if (fees.length) parts[2] += ` (incl ${fees.join(', ')})`;
  if (m.latest_note) parts.push(m.latest_note);
  if (m.latest_action) parts.push(`Latest: ${m.latest_action}${m.latest_action_date ? ` (${m.latest_action_date})` : ''}`);
  parts.push(`Winstead status report as of ${asOf || 'n/a'}.`);
  return parts.filter(Boolean).join(' · ');
}

// ----------------------------------------------------------------------------
// POST /ingest — extract + resolve + delta + stage. Does NOT write statuses.
// ----------------------------------------------------------------------------
router.post('/ingest', upload.single('pdf'), async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  const t0 = Date.now();
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded (expected field "pdf").' });
    if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: `Unsupported file type: ${req.file.mimetype}` });
    const communityId = (req.body && req.body.community_id) || null;
    if (!communityId) return res.status(400).json({ error: 'community_id required (pick the association).' });

    // Stash the source PDF for the audit trail (non-fatal if it fails).
    let storagePath = null;
    try {
      const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 16);
      const safe = (req.file.originalname || 'winstead_collections.pdf').replace(/[^a-zA-Z0-9._\-]/g, '_');
      storagePath = `collection_ingests/${hash}_${safe}`;
      await supabase.storage.from('documents').upload(storagePath, req.file.buffer, { contentType: 'application/pdf', upsert: true });
    } catch (e) { console.warn('[collections_ingest] storage upload failed (non-fatal):', e.message); storagePath = null; }

    const { parsed, matters } = await extractWinsteadMatters(req.file.buffer);

    // Current state for this community — to compute deltas.
    const { data: existing } = await supabase.from('ar_account_collections')
      .select('property_id, collection_status').eq('community_id', communityId);
    const currentByProp = new Map((existing || []).map((r) => [r.property_id, r.collection_status]));

    const resolved = []; let matched = 0;
    const seenProps = new Set();
    for (const m of matters) {
      let prop = null;
      if (m.property_address) {
        try { prop = await resolveProperty(supabase, communityId, m.property_address); } catch (_) {}
      }
      if (prop && prop.id) { matched += 1; seenProps.add(prop.id); }
      const cur = prop && prop.id ? (currentByProp.get(prop.id) || null) : null;
      const delta = !prop || !prop.id ? 'unmatched'
        : cur === null ? 'new'
        : cur === m.mapped_status ? 'same' : 'changed';
      resolved.push({
        firm_file: m.firm_file, debtors: m.debtors,
        property_address: m.property_address,
        property_id: prop && prop.id ? prop.id : null,
        matched_address: prop && prop.id ? prop.street_address : null,
        balance_total: m.balance_total, attorney_fee: m.attorney_fee, collection_cost: m.collection_cost,
        latest_action: m.latest_action, latest_action_date: m.latest_action_date, latest_note: m.latest_note,
        mapped_status: m.mapped_status, current_status: cur, delta,
        closing_removed: !!m.closing_removed,
      });
    }

    // Accounts previously in collections that are ABSENT from this report —
    // likely cured/closed. We flag them; we never auto-clear (safety).
    const resolvedCandidates = (existing || [])
      .filter((r) => !seenProps.has(r.property_id) && r.collection_status !== 'none')
      .map((r) => r.property_id);

    const { data: batch, error: bErr } = await supabase.from('collection_ingest_batches').insert({
      community_id: communityId, source: 'winstead',
      source_filename: req.file.originalname || null, source_storage_path: storagePath,
      report_as_of: parsed.report_as_of || null,
      total_matters: matters.length, matters_matched: matched, matters_unmatched: matters.length - matched,
      status: 'previewed',
      raw_extraction: { report_as_of: parsed.report_as_of, association_name: parsed.association_name, rows: resolved, resolved_candidates: resolvedCandidates },
      extraction_model: 'claude-sonnet-4-5',
    }).select('id').single();
    if (bErr) throw bErr;

    res.json({
      ok: true, batch_id: batch.id,
      report_as_of: parsed.report_as_of || null, association_name: parsed.association_name || null,
      total_matters: matters.length, matters_matched: matched, matters_unmatched: matters.length - matched,
      rows: resolved, resolved_candidate_count: resolvedCandidates.length,
      allowed_statuses: COLLECTION_STATUSES, duration_ms: Date.now() - t0,
    });
  } catch (err) {
    console.error('[collections_ingest] ingest failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /ingest/:id/approve — commit the batch into ar_account_collections.
// Body: { overrides?: { "<property_id>": "<collection_status>" } }
// ----------------------------------------------------------------------------
router.post('/ingest/:id/approve', express.json(), async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const { data: batch, error: bErr } = await supabase.from('collection_ingest_batches')
      .select('*').eq('id', req.params.id).maybeSingle();
    if (bErr) throw bErr;
    if (!batch) return res.status(404).json({ error: 'batch_not_found' });
    if (batch.status !== 'previewed') return res.status(409).json({ error: `batch already ${batch.status}` });

    const overrides = (req.body && req.body.overrides) || {};
    const rows = (batch.raw_extraction && Array.isArray(batch.raw_extraction.rows)) ? batch.raw_extraction.rows : [];
    const asOf = batch.report_as_of;

    const toUpsert = []; let skipped = 0;
    for (const r of rows) {
      if (!r.property_id) { skipped += 1; continue; }
      let status = overrides[r.property_id] || r.mapped_status;
      if (!COLLECTION_STATUSES.includes(status)) status = r.mapped_status; // guard: never write an invalid enum
      toUpsert.push({
        community_id: batch.community_id, property_id: r.property_id,
        collection_status: status,
        status_since: r.latest_action_date || asOf || null,
        notes: noteFor(r, asOf),
      });
    }
    if (!toUpsert.length) return res.status(400).json({ error: 'No matched matters to write.' });

    const { error: upErr } = await supabase.from('ar_account_collections')
      .upsert(toUpsert, { onConflict: 'community_id,property_id' });
    if (upErr) throw upErr;

    await supabase.from('collection_ingest_batches')
      .update({ status: 'approved', approved_at: new Date().toISOString() }).eq('id', batch.id);

    res.json({ ok: true, records_written: toUpsert.length, rows_skipped_unmatched: skipped, report_as_of: asOf });
  } catch (err) {
    console.error('[collections_ingest] approve failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /ingest/:id/discard
// ----------------------------------------------------------------------------
router.post('/ingest/:id/discard', express.json(), async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const { error } = await supabase.from('collection_ingest_batches')
      .update({ status: 'discarded' }).eq('id', req.params.id).eq('status', 'previewed');
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /batches?community_id=
// ----------------------------------------------------------------------------
router.get('/batches', async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    let q = supabase.from('collection_ingest_batches')
      .select('id, community_id, source_filename, report_as_of, total_matters, matters_matched, matters_unmatched, status, created_at, approved_at')
      .order('created_at', { ascending: false }).limit(50);
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ ok: true, batches: data || [] });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
