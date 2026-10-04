// ============================================================================
// api/manager.js  (Issue #27 Phase 1) — read-only Amanda shadow view
// ----------------------------------------------------------------------------
// GET /api/manager/shadow?community_id=  ->  "What Amanda would do" (admin only).
// No write endpoints: Phase 1 sweeps run only from the scheduler.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./_require_admin');
const { safeErrorMessage } = require('./_safe_error');
const { buildShadow } = require('../lib/manager/shadow');

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let _sb = null;
const sb = () => (_sb || (_sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)));

router.get('/shadow', async (req, res) => {
  const admin = await requireAdmin(req, res); // sends 401/403 itself
  if (!admin) return;
  const communityId = req.query.community_id && UUID.test(String(req.query.community_id)) ? String(req.query.community_id) : null;
  try { res.json(await buildShadow(sb(), { communityId })); }
  catch (e) { console.error('[manager] shadow failed:', e.message); res.status(500).json({ error: safeErrorMessage(e) }); }
});

module.exports = router;
