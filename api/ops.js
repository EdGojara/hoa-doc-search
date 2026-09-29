// ============================================================================
// api/ops.js — Operations overview (Issue #6, Operations slice)
// ----------------------------------------------------------------------------
// Mounted at /api/ops. Read-only; staff sign-in required. Powers /app/operations.
//
//   GET /overview   every Bedrock community (demo excluded) with the open
//                   operational work per area, plus a portfolio attention list
//
// Runs only when the page is opened or refreshed. Rules and reads live in
// lib/ops/overview.js.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { requireStaff } = require('./_require_admin');
const { BEDROCK_MGMT_CO_ID } = require('../lib/company');
const { isDemoCommunityRow } = require('../lib/demo/demo_guard');
const { COMMUNITY_SELECT, fetchOps, evaluateOps } = require('../lib/ops/overview');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();

router.get('/overview', async (req, res) => {
  const staff = await requireStaff(req, res); if (!staff) return;
  try {
    const { data, error } = await supabase.from('communities').select(COMMUNITY_SELECT)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID).eq('active', true).order('name').limit(500);
    if (error) throw error;
    const communities = (data || []).filter((c) => !isDemoCommunityRow(c));
    if (!communities.length) return res.json(evaluateOps([], {}, new Date()));
    const facts = await fetchOps(supabase, communities.map((c) => c.id));
    res.json(evaluateOps(communities, facts, new Date()));
  } catch (err) {
    console.error('[ops] overview failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
