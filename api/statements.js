// ============================================================================
// api/statements.js  (Ed 2026-08-27)
// Assessment statements — Bedrock-rendered replacement for the Vantaca
// statement. Staff surface (Finance → Assessment Statements). Reads canonical
// AR data; renders lib/statements/assessment_statement.js.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { buildStatementData, renderStatementHTML } = require('../lib/statements/assessment_statement');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();

// GET /api/statements/community/:communityId/accounts — the picker list.
router.get('/community/:communityId/accounts', async (req, res) => {
  try {
    const { communityId } = req.params;
    if (!communityId) return res.status(400).json({ error: 'community_id_required' });
    // Paginate — a community can exceed the 1000-row PostgREST cap (Waterview 1,171).
    let all = []; let from = 0;
    for (;;) {
      const { data, error } = await supabase
        .from('v_current_property_owners')
        .select('property_id, street_address, owner_name, vantaca_account_id, trusted_account_number')
        .eq('community_id', communityId)
        .order('street_address', { ascending: true })
        .order('property_id', { ascending: true })
        .range(from, from + 999);
      if (error) throw error;
      all = all.concat(data || []);
      if (!data || data.length < 1000) break;
      from += 1000;
    }
    res.json({
      accounts: all.map((o) => ({
        property_id: o.property_id,
        address: o.street_address || '',
        owner: o.owner_name || '',
        account: o.vantaca_account_id || o.trusted_account_number || '',
      })),
    });
  } catch (err) {
    console.error('[statements] accounts failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /api/statements/:propertyId — the rendered HTML statement (preview/print).
router.get('/:propertyId', async (req, res) => {
  try {
    const data = await buildStatementData(supabase, req.params.propertyId, { asOf: req.query.as_of });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderStatementHTML(data));
  } catch (err) {
    const code = err.message === 'property_not_found' ? 404 : 500;
    console.error('[statements] render failed:', err.message);
    res.status(code).send('<p style="font-family:Arial,sans-serif;padding:24px;color:#334155;">Could not render statement: ' + safeErrorMessage(err) + '</p>');
  }
});

module.exports = router;
