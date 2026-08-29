// ============================================================================
// api/vendor_outreach.js  (Ed 2026-08-29)
// ----------------------------------------------------------------------------
// The team reaching OUT: turn a reported issue (broken sprinkler, water leak,
// pool down) into a service-request email addressed to the vendor this community
// actually uses — then hold it in the Draft Queue for a human to send. This is
// the first "the team acts, not just answers" surface, and it is deliberately
// dark up to the send: preview and queue only; POST /email-drafts/:id/send (the
// existing review screen) is the single place mail leaves.
//
// Vendor selection is honest about the data. There is no populated
// community<->vendor directory yet, so we resolve from PAYMENT HISTORY (who the
// community has actually paid, in ap_invoices) and only auto-pick when one paid
// vendor clearly matches the service category by name. Otherwise we return the
// candidate list and a human chooses — we never email a guessed third party.
// See lib/team/operator_actions.js for the resolver + the safe/reserved gate.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const {
  draft_vendor_outreach, inferServiceCategory, resolveCommunityVendor,
  renderVendorOutreach, SERVICE_CATEGORIES,
} = require('../lib/team/operator_actions');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
function safe(err) { try { return require('./_safe_error').safeErrorMessage(err); } catch (_) { return 'Something went wrong'; } }

async function communityName(id) {
  if (!id) return null;
  const { data, error } = await supabase.from('communities').select('name').eq('id', id).limit(1);
  if (error) return null;
  return (data && data[0] && data[0].name) || null;
}

// Form data for the page: communities (this management company) + the service
// categories we can route + the persona that will send. Self-contained so the
// page needs no other endpoint.
router.get('/form-data', async (req, res) => {
  try {
    const { data, error } = await supabase.from('communities')
      .select('id, name').eq('management_company_id', BEDROCK_MGMT_CO_ID).order('name');
    if (error) throw error;
    res.json({
      communities: data || [],
      categories: Object.keys(SERVICE_CATEGORIES),
    });
  } catch (err) {
    console.error('[vendor_outreach] form-data failed:', err.message);
    res.status(500).json({ error: safe(err) });
  }
});

// The community's candidate vendors (everyone it has actually paid, with an
// email) — for the manual-pick dropdown when auto-resolve isn't confident.
router.get('/vendors', async (req, res) => {
  try {
    const communityId = req.query.communityId;
    if (!communityId) return res.status(400).json({ error: 'communityId_required' });
    const category = req.query.category || null;
    const { candidates } = await resolveCommunityVendor(supabase, communityId, category, {});
    res.json({ vendors: candidates });
  } catch (err) {
    console.error('[vendor_outreach] vendors failed:', err.message);
    res.status(500).json({ error: safe(err) });
  }
});

// Preview: infer the category, resolve the vendor from real history, and render
// the exact email that would be queued — WITHOUT queuing or sending anything.
router.post('/preview', async (req, res) => {
  try {
    const { communityId, issue, accessNote, vendorId } = req.body || {};
    if (!communityId || !issue) return res.status(400).json({ error: 'communityId_and_issue_required' });
    const category = req.body.serviceCategory || inferServiceCategory(issue);
    const cName = (await communityName(communityId)) || req.body.communityName || null;
    if (!category) return res.json({ ok: true, category: null, pick: null, candidates: [], draft: null, note: 'Could not infer a service category — pick a vendor manually.' });

    const resolved = await resolveCommunityVendor(supabase, communityId, category, { issue });
    let chosen = resolved.pick;
    if (vendorId) {
      chosen = resolved.candidates.find((c) => c.vendor_id === vendorId)
        || (chosen && chosen.vendor_id === vendorId ? chosen : null);
    }
    const draft = chosen
      ? { ...renderVendorOutreach(chosen, { issue, communityName: cName, category, accessNote }), toName: chosen.name, toEmail: chosen.email }
      : null;
    res.json({ ok: true, category, communityName: cName, pick: resolved.pick, candidates: resolved.candidates, chosen, draft });
  } catch (err) {
    console.error('[vendor_outreach] preview failed:', err.message);
    res.status(500).json({ error: safe(err) });
  }
});

// Queue: create the held draft in the Draft Queue. Human-triggered, so it runs
// the safe action directly; the SEND still happens only from the review screen.
router.post('/queue', async (req, res) => {
  try {
    const { communityId, issue, accessNote, vendorId } = req.body || {};
    if (!communityId || !issue) return res.status(400).json({ error: 'communityId_and_issue_required' });
    const cName = (await communityName(communityId)) || req.body.communityName || null;
    const ctx = { supabase, communityId, persona: req.body.persona || 'amanda' };
    const result = await draft_vendor_outreach.execute(ctx, {
      issue, accessNote, communityName: cName,
      serviceCategory: req.body.serviceCategory || undefined, vendorId: vendorId || undefined,
    });
    // needs_human is a legitimate outcome (ambiguous or no vendor), not an error.
    res.json(result);
  } catch (err) {
    console.error('[vendor_outreach] queue failed:', err.message);
    res.status(500).json({ error: safe(err) });
  }
});

module.exports = router;
