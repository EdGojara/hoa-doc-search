// ============================================================================
// api/ap_intake.js  (Ed 2026-07-08) — mounted at /api/ap-intake
// ----------------------------------------------------------------------------
// Emma's AP invoice intake. Every channel funnels through here so duplicates
// are caught no matter how a bill arrives (email, upload, or physical scan).
//
//   POST /ingest            drop/receive a PDF -> extract + dedup PREVIEW (no DB write)
//   POST /commit            operator-confirmed vendor+community -> load to ap_invoices
//   GET  /queue             review queue: awaiting_approval + suspected-duplicate holds
//   POST /:id/confirm-unique     clear a suspected-duplicate hold -> awaiting_approval
//   POST /:id/confirm-duplicate  void a suspected/confirmed duplicate
//   GET  /vendors?q=        vendor search for the picker
//   GET  /communities       community list for the picker
// Admin-only (owner beta).
// ============================================================================
const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { stageInvoice, resolveVendor, resolveCommunity, commitInvoice } = require('../lib/ap/intake');
const { findDuplicates } = require('../lib/ap/dedup');
const { requireAdmin } = require('./_require_admin');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const router = express.Router();

// POST /ingest — extract + dedup preview. No DB write; operator confirms on /commit.
router.post('/ingest', upload.single('pdf'), async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded (field "pdf").' });
    if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: `Unsupported type: ${req.file.mimetype}` });

    const { extracted, sha256, storagePath } = await stageInvoice(req.file.buffer, req.file.originalname);
    extracted._filename = req.file.originalname || null;

    const v = await resolveVendor({ name: extracted.vendor_name, email: extracted.vendor_email });
    const bodyCommunity = req.body && req.body.community_id;
    let community = null, communityCandidates = [];
    if (bodyCommunity) { const { data } = await supabase.from('communities').select('id, name').eq('id', bodyCommunity).maybeSingle(); community = data || null; }
    else { const c = await resolveCommunity(extracted.community_hint); community = c.community; communityCandidates = c.candidates; }

    // Dedup preview only when we can key it (needs vendor + community).
    let dedup = { verdict: 'unknown', matches: [] };
    if (v.vendor && community) {
      dedup = await findDuplicates(supabase, {
        communityId: community.id, vendorId: v.vendor.id, invoiceNumber: extracted.invoice_number,
        totalCents: extracted.total_cents, invoiceDate: extracted.invoice_date, fileSha256: sha256,
      });
      // hydrate match display names
      for (const m of dedup.matches) m.invoice.vendor_name = v.vendor.name;
    }

    res.json({
      ok: true, extracted, sha256, storage_path: storagePath,
      vendor: v.vendor, vendor_candidates: v.candidates, vendor_match_method: v.method,
      community, community_candidates: communityCandidates,
      dedup,
      complete: !!(v.vendor && community && extracted.total_cents > 0 && extracted.invoice_date && extracted.looks_like_invoice),
    });
  } catch (err) {
    console.error('[ap_intake] ingest failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /commit — write to ap_invoices (with the dedup re-check inside).
router.post('/commit', express.json({ limit: '2mb' }), async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const b = req.body || {};
    if (!b.extracted || !b.vendor_id || !b.community_id) return res.status(400).json({ error: 'extracted, vendor_id and community_id are required.' });
    const result = await commitInvoice({
      extracted: b.extracted, vendorId: b.vendor_id, communityId: b.community_id,
      sha256: b.sha256 || null, storagePath: b.storage_path || null,
      intakeMethod: b.intake_method || 'manual_upload', sourceRef: b.source_ref || null,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[ap_intake] commit failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /queue — awaiting approval + suspected-duplicate holds.
router.get('/queue', async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const { data, error } = await supabase.from('ap_invoices')
      .select('id, vendor_invoice_number, invoice_date, due_date, total_cents, status, dedup_status, duplicate_of_invoice_id, source_storage_path, intake_method, notes, received_at, vendor:vendor_id(name), community:community_id(name)')
      .in('status', ['awaiting_approval', 'on_hold'])
      .order('received_at', { ascending: false }).limit(300);
    if (error) throw error;
    const rows = data || [];
    res.json({
      ok: true,
      suspected: rows.filter((r) => r.dedup_status === 'suspected_duplicate'),
      queue: rows.filter((r) => r.dedup_status !== 'suspected_duplicate'),
    });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /:id/confirm-unique — it's NOT a duplicate; release the hold.
router.post('/:id/confirm-unique', express.json(), async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const { error } = await supabase.from('ap_invoices')
      .update({ status: 'awaiting_approval', dedup_status: 'unique', duplicate_of_invoice_id: null })
      .eq('id', req.params.id).eq('dedup_status', 'suspected_duplicate');
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /:id/confirm-duplicate — void it as a confirmed duplicate.
router.post('/:id/confirm-duplicate', express.json(), async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const { error } = await supabase.from('ap_invoices')
      .update({ status: 'voided', dedup_status: 'confirmed_duplicate', voided_at: new Date().toISOString(), voided_reason: 'Confirmed duplicate' })
      .eq('id', req.params.id).neq('status', 'paid');
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// GET /vendors?q= — picker search.
router.get('/vendors', async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    let q = supabase.from('vendors').select('id, name, dba, email').order('name').limit(50);
    if (req.query.q) q = q.ilike('name', `%${req.query.q}%`);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ ok: true, vendors: data || [] });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// GET /communities — picker.
router.get('/communities', async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const { data, error } = await supabase.from('communities').select('id, name').order('name').limit(500);
    if (error) throw error;
    res.json({ ok: true, communities: data || [] });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

module.exports = { router };
