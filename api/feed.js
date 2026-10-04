// ============================================================================
// api/feed.js  (Issue #29 Phase 1) — read-only Operations Feed (admin)
// ----------------------------------------------------------------------------
// GET /api/feed?community_id=     what needs a person, recent changes, summary
// GET /api/feed/item?key=kind:id  one item's timeline from its own records
// No write routes, no actions, no model calls. Phase 1 proves the read model.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./_require_admin');
const { safeErrorMessage } = require('./_safe_error');
const { buildFeed, buildItem } = require('../lib/feed/build');

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let _sb = null;
const sb = () => (_sb || (_sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)));

router.get('/', async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  const communityId = req.query.community_id && UUID.test(String(req.query.community_id)) ? String(req.query.community_id) : null;
  try { res.json(await buildFeed(sb(), { communityId })); }
  catch (e) { console.error('[feed] build failed:', e.message); res.status(500).json({ error: safeErrorMessage(e) }); }
});

router.get('/item', async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const item = await buildItem(sb(), String(req.query.key || ''));
    if (!item) return res.status(404).json({ error: 'not_found' });
    res.json(item);
  } catch (e) {
    if (e.code === 'BAD_INPUT') return res.status(400).json({ error: e.message });
    console.error('[feed] item failed:', e.message); res.status(500).json({ error: safeErrorMessage(e) });
  }
});

module.exports = router;
