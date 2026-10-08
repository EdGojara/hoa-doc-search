// ============================================================================
// Prorated-assessment API — mounted at /api/assessment-proration.
// Protected by the global staff-cookie gate (like /api/home-sales and
// /api/checks); closings are normal staff operations.
//   GET  /rates?community_id                 the builder + homeowner annual rates
//   PUT  /rates                              upsert a rate
//   POST /preview                            compute a proration (no write)
//   POST /post                               post the prorated charge + log it
//   GET  /history?community_id[&property_id] the proration audit trail
//   GET  /transfer/queue?community_id        transfer prorations not yet posted,
//                                            recalculated: Staged / Ready to Post / Blocked
//   POST /transfer/:proposalId/post          post one (recomputed; 409 with the
//                                            numbers until { confirmed: true })
// ============================================================================
const express = require('express');
const { safeErrorMessage } = require('./_safe_error');
const {
  computeProration, postProration, listRates, upsertRate, listHistory,
} = require('../lib/accounting/assessment_proration');
const { createClient } = require('@supabase/supabase-js');
const TP = require('../lib/accounting/transfer_proration');
const BA = require('../lib/accounting/builder_accrual');
const { requireStaff, requireAdmin } = require('./_require_admin');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const router = express.Router();

function fail(res, feature, err) {
  if (err.code === 'invalid_input' || err.code === 'invalid_state') return res.status(400).json({ error: err.message, code: err.code });
  console.error(`[assessment-proration] ${feature} failed:`, err.message);
  return res.status(500).json({ error: safeErrorMessage(err) });
}

router.get('/rates', async (req, res) => {
  try {
    if (!req.query.community_id) return res.status(400).json({ error: 'community_id_required' });
    res.json({ rates: await listRates(req.query.community_id) });
  } catch (err) { fail(res, 'rates-get', err); }
});

router.put('/rates', express.json(), async (req, res) => {
  try { res.json({ rate: await upsertRate(req.body || {}) }); }
  catch (err) { fail(res, 'rates-put', err); }
});

router.post('/preview', express.json(), async (req, res) => {
  try { res.json(await computeProration(req.body || {})); }
  catch (err) { fail(res, 'preview', err); }
});

router.post('/post', express.json(), async (req, res) => {
  try {
    const out = await postProration({ ...(req.body || {}), posted_by: (req.body && req.body.posted_by) || 'staff' });
    if (!out.ok) return res.status(['already_prorated', 'proration_runs_at_transfer'].includes(out.error) ? 409 : 400).json(out);
    res.json(out);
  } catch (err) { fail(res, 'post', err); }
});

router.get('/history', async (req, res) => {
  try {
    if (!req.query.community_id) return res.status(400).json({ error: 'community_id_required' });
    res.json({ history: await listHistory({ community_id: req.query.community_id, property_id: req.query.property_id || null }) });
  } catch (err) { fail(res, 'history', err); }
});

router.get('/transfer/queue', async (req, res) => {
  try { res.json({ queue: await TP.listTransferQueue(supabase, req.query.community_id || null) }); }
  catch (err) { fail(res, 'transfer-queue', err); }
});

router.post('/transfer/:proposalId/post', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const r = await TP.postStagedProration(supabase, { proposalId: req.params.proposalId, postedBy: b.posted_by || 'staff', confirmed: b.confirmed });
    if (r.status === 'confirmation_required') {
      return res.status(409).json({ error: 'proration_confirmation_required: review the recomputed assessment proration, then confirm', code: 'proration_confirmation_required', proration: r.plan });
    }
    res.json({ proration: r });
  } catch (err) {
    if (err.code === 'P0001') return res.status(409).json({ error: err.message });
    fail(res, 'transfer-post', err);
  }
});

// ---- Builder assessment coverage + monthly accrual (GitHub #96) -------------
// GET  /builder-coverage?community_id[&as_of]       status: covered through vs expected, per lot; open reconciling items
// GET  /builder-accrual/preview?community_id&through   what the accrual through a month end would bill (read-only)
// POST /builder-accrual/run {community_id, through, confirmed:true}   posts it (admin; never twice)
// POST /reconciling-items/:id/resolve {note}          resolves a conversion reconciling item (admin; note 10+ chars)
const centralToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
router.get('/builder-coverage', async (req, res) => {
  try {
    const u = await requireStaff(req, res); if (!u) return;
    if (!req.query.community_id) return res.status(400).json({ error: 'community_id_required' });
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(req.query.as_of || '') ? req.query.as_of : centralToday();
    res.json({ status: await BA.status(supabase, { communityId: req.query.community_id, asOf }) });
  } catch (err) { fail(res, 'builder-coverage', err); }
});
router.get('/builder-accrual/preview', async (req, res) => {
  try {
    const u = await requireStaff(req, res); if (!u) return;
    if (!req.query.community_id) return res.status(400).json({ error: 'community_id_required' });
    if (!BA.isMonthEnd(req.query.through || '')) return res.status(400).json({ error: 'through_must_be_a_month_end' });
    res.json({ plan: await BA.preview(supabase, { communityId: req.query.community_id, through: req.query.through }) });
  } catch (err) { fail(res, 'builder-accrual-preview', err); }
});
router.post('/builder-accrual/run', express.json(), async (req, res) => {
  try {
    const u = await requireAdmin(req, res); if (!u) return;
    const b = req.body || {};
    if (!b.community_id) return res.status(400).json({ error: 'community_id_required' });
    if (!BA.isMonthEnd(b.through || '')) return res.status(400).json({ error: 'through_must_be_a_month_end' });
    if (b.confirmed !== true) return res.status(409).json({ error: 'confirmation_required: review the preview, then confirm', code: 'confirmation_required', plan: await BA.preview(supabase, { communityId: b.community_id, through: b.through }) });
    res.json({ accrual: await BA.run(supabase, { communityId: b.community_id, through: b.through, actor: u.email || u.id || 'staff' }) });
  } catch (err) {
    if (err.code === 'P0001') return res.status(409).json({ error: err.message });
    fail(res, 'builder-accrual-run', err);
  }
});
router.post('/reconciling-items/:id/resolve', express.json(), async (req, res) => {
  try {
    const u = await requireAdmin(req, res); if (!u) return;
    const note = String((req.body || {}).note || '').trim();
    if (note.length < 10) return res.status(400).json({ error: 'a resolution note of at least 10 characters is required' });
    const { data, error } = await supabase.from('conversion_reconciling_items')
      .update({ status: 'resolved', resolved_by: u.email || u.id, resolved_at: new Date().toISOString(), resolution_note: note })
      .eq('id', req.params.id).eq('status', 'open').select('id, kind, item_key, status, resolved_by, resolved_at');
    if (error) throw error;
    if (!data || !data.length) return res.status(409).json({ error: 'not an open reconciling item' });
    res.json({ item: data[0] });
  } catch (err) { fail(res, 'reconciling-item-resolve', err); }
});

module.exports = router;
