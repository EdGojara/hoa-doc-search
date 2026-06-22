// ============================================================================
// Homeowner AR API — charges, payments, ledger
// ----------------------------------------------------------------------------
// Mounted at /api/ar.
//
// Phase 2A surface (this ship):
//   GET    /charge-types?community_id
//   GET    /charges?community_id&property_id&status
//   POST   /charges                       create charge + post JE
//   GET    /payments?community_id&property_id
//   POST   /payments                      record payment + auto-apply §209.0063
//   POST   /payments/:id/apply            re-run §209.0063 application
//   GET    /owners/:property_id/ledger    full chronological ledger
//   GET    /owners/:property_id/balance   current balance + aging buckets
//   GET    /aging?community_id            portfolio aging summary
//   GET    /billing-policies?community_id current active policy
//   POST   /billing-policies              create/update policy
// ============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { createCharge, recordPayment, applyPayment, getOwnerLedger } = require('../lib/accounting/ar_engine');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();

router.get('/charge-types', async (req, res) => {
  try {
    const { community_id } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    const { data, error } = await supabase
      .from('ar_charge_types')
      .select('*, chart_of_accounts!ar_charge_types_gl_revenue_account_id_fkey(account_number, account_name)')
      .eq('community_id', community_id).eq('is_active', true)
      .order('display_order').limit(200);
    if (error) throw error;
    res.json({ charge_types: data || [] });
  } catch (err) {
    console.error('[ar] list charge types failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/charges', async (req, res) => {
  try {
    const { community_id, property_id, status, limit = '200' } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    let q = supabase.from('ar_charges')
      .select('*, ar_charge_types(display_name, category, tx_priority_step), properties(street_address)')
      .eq('community_id', community_id)
      .order('charge_date', { ascending: false })
      .limit(Math.min(parseInt(limit, 10) || 200, 1000));
    if (property_id) q = q.eq('property_id', property_id);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ charges: data || [] });
  } catch (err) {
    console.error('[ar] list charges failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/charges', express.json(), async (req, res) => {
  try {
    const result = await createCharge(req.body || {});
    res.json(result);
  } catch (err) {
    if (err.code === 'invalid_input' || err.code === 'invalid_state' || err.code === 'period_closed') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error('[ar] create charge failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/payments', async (req, res) => {
  try {
    const { community_id, property_id, source, limit = '200' } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    let q = supabase.from('ar_payments')
      .select('*, properties(street_address)')
      .eq('community_id', community_id)
      .order('payment_date', { ascending: false })
      .limit(Math.min(parseInt(limit, 10) || 200, 1000));
    if (property_id) q = q.eq('property_id', property_id);
    if (source) q = q.eq('source', source);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ payments: data || [] });
  } catch (err) {
    console.error('[ar] list payments failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/payments', express.json(), async (req, res) => {
  try {
    const result = await recordPayment(req.body || {});
    res.json(result);
  } catch (err) {
    if (err.code === 'invalid_input' || err.code === 'invalid_state' || err.code === 'period_closed') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error('[ar] record payment failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/payments/:id/apply', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await applyPayment({ payment_id: id, posted_by_user_id: req.body?.user_id });
    res.json(result);
  } catch (err) {
    if (err.code === 'invalid_input' || err.code === 'invalid_state' || err.code === 'not_found') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error('[ar] apply payment failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/owners/:property_id/ledger', async (req, res) => {
  try {
    const { property_id } = req.params;
    const { community_id, from_date, to_date } = req.query;
    const result = await getOwnerLedger({ community_id, property_id, from_date, to_date });
    res.json(result);
  } catch (err) {
    console.error('[ar] owner ledger failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/owners/:property_id/balance', async (req, res) => {
  try {
    const { property_id } = req.params;
    const { data, error } = await supabase
      .from('v_owner_ar_balance').select('*').eq('property_id', property_id).maybeSingle();
    if (error) throw error;
    res.json({ balance: data || { property_id, total_balance_cents: 0 } });
  } catch (err) {
    console.error('[ar] owner balance failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Paginated fetch of all of a community's rows from a view/table (honors the
// PostgREST 1000-row cap — a single .limit() is silently truncated server-side).
async function _fetchAllForCommunity(table, community_id, cap, select) {
  const out = [];
  const page = 1000;
  for (let from = 0; from < cap; from += page) {
    const to = Math.min(from + page - 1, cap - 1);
    const { data, error } = await supabase.from(table).select(select || '*')
      .eq('community_id', community_id).range(from, to);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < page) break;
  }
  return out;
}

router.get('/aging', async (req, res) => {
  try {
    const { community_id, limit = '5000' } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    const cap = Math.min(parseInt(limit, 10) || 5000, 5000);

    // Balances flat (the view has no direct FK path to contacts, so the nested
    // embed `properties(contacts(...))` can't resolve). Enrich address + owner
    // name from the current-owners view by property_id instead.
    const balances = await _fetchAllForCommunity('v_owner_ar_balance', community_id, cap);
    const owners = await _fetchAllForCommunity('v_current_property_owners', community_id, cap, 'property_id, street_address, unit, owner_name');
    const ownerMap = new Map((owners || []).map((o) => [o.property_id, o]));

    const data = (balances || []).map((b) => {
      const o = ownerMap.get(b.property_id) || {};
      return Object.assign({}, b, {
        street_address: o.street_address || null,
        unit: o.unit || null,
        owner_name: o.owner_name || null,
        properties: { street_address: o.street_address || null, contacts: { full_name: o.owner_name || null } },
      });
    }).sort((a, b) => Number(b.total_balance_cents || 0) - Number(a.total_balance_cents || 0));

    const totals = (data || []).reduce((acc, r) => {
      acc.total_balance += Number(r.total_balance_cents || 0);
      acc.bucket_current += Number(r.bucket_current_cents || 0);
      acc.bucket_1_30 += Number(r.bucket_1_30_cents || 0);
      acc.bucket_31_60 += Number(r.bucket_31_60_cents || 0);
      acc.bucket_61_90 += Number(r.bucket_61_90_cents || 0);
      acc.bucket_91_120 += Number(r.bucket_91_120_cents || 0);
      acc.bucket_over_120 += Number(r.bucket_over_120_cents || 0);
      return acc;
    }, { total_balance: 0, bucket_current: 0, bucket_1_30: 0, bucket_31_60: 0, bucket_61_90: 0, bucket_91_120: 0, bucket_over_120: 0 });
    res.json({ rows: data || [], totals, owners_with_balance: (data || []).length });
  } catch (err) {
    console.error('[ar] aging failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/billing-policies', async (req, res) => {
  try {
    const { community_id, history } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    let q = supabase.from('community_billing_policies').select('*').eq('community_id', community_id);
    if (!history) q = q.is('effective_end_date', null);
    q = q.order('effective_start_date', { ascending: false });
    const { data, error } = await q;
    if (error) throw error;
    res.json({ policies: data || [] });
  } catch (err) {
    console.error('[ar] billing policies failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/billing-policies', express.json(), async (req, res) => {
  try {
    const allowed = [
      'community_id', 'effective_start_date', 'effective_end_date',
      'assessment_cadence', 'assessment_default_amount_cents', 'assessment_due_day_of_month',
      'reserve_contribution_pct', 'grace_period_days', 'late_fee_amount_cents',
      'late_fee_recurring', 'interest_apr_pct', 'interest_compounding', 'interest_start_days_past_due',
      'courtesy_letter_days', 'certified_209_notice_days', 'collections_referral_days',
      'notes', 'approved_by_board_at',
    ];
    const row = {};
    for (const k of allowed) if (k in (req.body || {})) row[k] = req.body[k];
    if (!row.community_id) return res.status(400).json({ error: 'community_id_required' });

    // End the prior active policy if creating a new active one
    if (!row.effective_end_date) {
      await supabase.from('community_billing_policies').update({ effective_end_date: row.effective_start_date })
        .eq('community_id', row.community_id).is('effective_end_date', null);
    }
    const { data, error } = await supabase.from('community_billing_policies').insert(row).select('*').single();
    if (error) throw error;
    res.json({ policy: data });
  } catch (err) {
    console.error('[ar] create policy failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
