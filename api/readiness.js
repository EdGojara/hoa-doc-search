// ============================================================================
// api/readiness.js — Community Data Readiness (Issue #6)
// ----------------------------------------------------------------------------
// Mounted at /api/readiness. Read-only; staff sign-in required (on top of the
// staff gate). Powers /app/communities and /app/communities/:id.
//
//   GET /communities      every Bedrock community (demo excluded), each with
//                         its readiness rows, worst-first
//   GET /communities/:id  one community's readiness
//
// Runs only when the page is opened or refreshed (no polling). Bounded reads,
// at most 3 communities in flight at once. Status rules live in
// lib/community/data_readiness.js.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { requireStaff } = require('./_require_admin');
const { BEDROCK_MGMT_CO_ID } = require('../lib/company');
const { isDemoCommunityRow } = require('../lib/demo/demo_guard');
const { COMMUNITY_SELECT, SEVERITY, communityReadiness } = require('../lib/community/data_readiness');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

router.get('/communities', async (req, res) => {
  const staff = await requireStaff(req, res); if (!staff) return;
  try {
    const { data, error } = await supabase.from('communities').select(COMMUNITY_SELECT)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID).eq('active', true).order('name').limit(500);
    if (error) throw error;
    const communities = (data || []).filter((c) => !isDemoCommunityRow(c));
    const results = await mapLimit(communities, 3, (c) => communityReadiness(supabase, c));
    results.sort((a, b) => b.needs_action - a.needs_action || SEVERITY.indexOf(a.worst) - SEVERITY.indexOf(b.worst) || a.community.name.localeCompare(b.community.name));
    res.json({ generated_at: new Date().toISOString(), communities: results });
  } catch (err) {
    console.error('[readiness] portfolio failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/communities/:id', async (req, res) => {
  const staff = await requireStaff(req, res); if (!staff) return;
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'community_id_invalid' });
    const { data, error } = await supabase.from('communities').select(COMMUNITY_SELECT)
      .eq('id', req.params.id).eq('management_company_id', BEDROCK_MGMT_CO_ID).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'community_not_found' });
    res.json(Object.assign({ generated_at: new Date().toISOString() }, await communityReadiness(supabase, data)));
  } catch (err) {
    console.error('[readiness] community failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
