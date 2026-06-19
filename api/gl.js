// ============================================================================
// api/gl.js — read endpoints for the General Ledger.
// ----------------------------------------------------------------------------
// Powers the Accounting screen: community picker, chart of accounts, trial
// balance (from v_trial_balance), per-homeowner ledgers (from
// v_owner_ar_balance), and recent journal entries. Read-only for now — posting
// comes in a later slice. Staff-scoped (bare paths require the staff cookie via
// server.js, same as the other admin modules).
// ============================================================================
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Communities that have a GL stood up (an account_funds row exists).
router.get('/communities', async (req, res) => {
  try {
    const { data: funds, error } = await supabase.from('account_funds').select('community_id').eq('is_active', true);
    if (error) throw error;
    const ids = [...new Set((funds || []).map((f) => f.community_id))];
    if (!ids.length) return res.json({ communities: [] });
    const { data: comms } = await supabase.from('communities').select('id, name, slug').in('id', ids).order('name');
    res.json({ communities: comms || [] });
  } catch (err) {
    console.error('[gl] communities failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/:communityId/chart-of-accounts', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('chart_of_accounts')
      .select('account_number, account_name, account_type, account_subtype, normal_balance, is_active, fund_id, account_funds:fund_id(fund_code, fund_name)')
      .eq('community_id', req.params.communityId)
      .order('account_number');
    if (error) throw error;
    res.json({ accounts: data || [] });
  } catch (err) {
    console.error('[gl] chart-of-accounts failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/:communityId/trial-balance', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('v_trial_balance')
      .select('account_number, account_name, account_type, normal_balance, fund_code, fund_name, total_debits_cents, total_credits_cents, balance_cents')
      .eq('community_id', req.params.communityId)
      .order('account_number');
    if (error) throw error;
    const rows = data || [];
    const totals = rows.reduce((a, r) => ({
      debits: a.debits + Number(r.total_debits_cents || 0),
      credits: a.credits + Number(r.total_credits_cents || 0),
    }), { debits: 0, credits: 0 });
    res.json({ rows, totals, balanced: totals.debits === totals.credits });
  } catch (err) {
    console.error('[gl] trial-balance failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Per-homeowner ledgers: current balance + aging, joined to the property address.
router.get('/:communityId/homeowner-ledgers', async (req, res) => {
  try {
    const cid = req.params.communityId;
    // Paginated — a community can exceed the 1000-row PostgREST cap.
    const bals = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('v_owner_ar_balance')
        .select('property_id, open_charge_count, total_balance_cents, bucket_current_cents, bucket_1_30_cents, bucket_31_60_cents, bucket_61_90_cents, bucket_91_120_cents, bucket_over_120_cents, max_days_past_due')
        .eq('community_id', cid)
        .range(from, from + 999);
      if (error) throw error;
      bals.push(...(data || []));
      if (!data || data.length < 1000) break;
      from += 1000;
    }
    // All properties (so $0 owners show too), with current owner name/address.
    const props = [];
    let pf = 0;
    while (true) {
      const { data, error } = await supabase
        .from('v_current_property_owners')
        .select('property_id, street_address, owner_name')
        .eq('community_id', cid)
        .range(pf, pf + 999);
      if (error) throw error;
      props.push(...(data || []));
      if (!data || data.length < 1000) break;
      pf += 1000;
    }
    const balByProp = Object.fromEntries(bals.map((b) => [b.property_id, b]));
    const ledgers = props.map((p) => {
      const b = balByProp[p.property_id] || {};
      return {
        property_id: p.property_id,
        street_address: p.street_address,
        owner_name: p.owner_name,
        balance_cents: Number(b.total_balance_cents || 0),
        open_charge_count: b.open_charge_count || 0,
        max_days_past_due: b.max_days_past_due || 0,
      };
    }).sort((a, b) => b.balance_cents - a.balance_cents || (a.street_address || '').localeCompare(b.street_address || ''));
    const totalOutstanding = ledgers.reduce((s, l) => s + l.balance_cents, 0);
    res.json({ ledgers, count: ledgers.length, total_outstanding_cents: totalOutstanding });
  } catch (err) {
    console.error('[gl] homeowner-ledgers failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/:communityId/journal-entries', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const { data, error } = await supabase
      .from('journal_entries')
      .select('reference, posting_date, description, source_module, total_debits_cents, status')
      .eq('community_id', req.params.communityId)
      .order('posting_date', { ascending: false })
      .order('reference', { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json({ journal_entries: data || [] });
  } catch (err) {
    console.error('[gl] journal-entries failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
