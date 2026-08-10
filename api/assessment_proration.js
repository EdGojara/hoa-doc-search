// ============================================================================
// Prorated-assessment API — mounted at /api/assessment-proration.
// Protected by the global staff-cookie gate (like /api/home-sales and
// /api/checks); closings are normal staff operations.
//   GET  /rates?community_id                 the builder + homeowner annual rates
//   PUT  /rates                              upsert a rate
//   POST /preview                            compute a proration (no write)
//   POST /post                               post the prorated charge + log it
//   GET  /history?community_id[&property_id] the proration audit trail
// ============================================================================
const express = require('express');
const { safeErrorMessage } = require('./_safe_error');
const {
  computeProration, postProration, listRates, upsertRate, listHistory,
} = require('../lib/accounting/assessment_proration');

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
    if (!out.ok) return res.status(out.error === 'already_prorated' ? 409 : 400).json(out);
    res.json(out);
  } catch (err) { fail(res, 'post', err); }
});

router.get('/history', async (req, res) => {
  try {
    if (!req.query.community_id) return res.status(400).json({ error: 'community_id_required' });
    res.json({ history: await listHistory({ community_id: req.query.community_id, property_id: req.query.property_id || null }) });
  } catch (err) { fail(res, 'history', err); }
});

module.exports = router;
