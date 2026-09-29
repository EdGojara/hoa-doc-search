// ============================================================================
// api/owners.js — Owners area (Issue #6, Owners slice)
// ----------------------------------------------------------------------------
// Mounted at /api/owners. Read-only; staff sign-in required (per user, on top
// of the shared staff gate: this area touches homeowner records).
//
//   GET /search?q=   find an owner/property across Bedrock communities
//                    (name, physical address, trustEd/Vantaca account number).
//                    Returns no email / phone / mailing address.
//   GET /overview    owner exceptions per community + owner-collapse check
//
// Demo communities excluded. Logic in lib/owners/overview.js.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { requireStaff } = require('./_require_admin');
const { BEDROCK_MGMT_CO_ID } = require('../lib/company');
const { isDemoCommunityRow } = require('../lib/demo/demo_guard');
const { COMMUNITY_SELECT, searchOwners, fetchOwnerFacts, evaluateOwners } = require('../lib/owners/overview');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();

async function bedrockCommunities() {
  const { data, error } = await supabase.from('communities').select(COMMUNITY_SELECT)
    .eq('management_company_id', BEDROCK_MGMT_CO_ID).eq('active', true).order('name').limit(500);
  if (error) throw error;
  return (data || []).filter((c) => !isDemoCommunityRow(c));
}

router.get('/search', async (req, res) => {
  const staff = await requireStaff(req, res); if (!staff) return;
  try {
    const communities = await bedrockCommunities();
    res.json(await searchOwners(supabase, req.query.q, communities));
  } catch (err) {
    console.error('[owners] search failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/overview', async (req, res) => {
  const staff = await requireStaff(req, res); if (!staff) return;
  try {
    const communities = await bedrockCommunities();
    const facts = communities.length ? await fetchOwnerFacts(supabase, communities) : {};
    res.json(Object.assign({ generated_at: new Date().toISOString() }, evaluateOwners(communities, facts)));
  } catch (err) {
    console.error('[owners] overview failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
