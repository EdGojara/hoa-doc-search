// ============================================================================
// Banks API — management-company bank registry
// ----------------------------------------------------------------------------
// Mounted at /api/banks.
//
// Banks are mgmt-company-level (one row per real-world bank Bedrock uses).
// bank_accounts (per-community) FK to this table.
//
// Phase 1 surface:
//   GET    /                    list banks (filter active, transitioning, etc.)
//   GET    /:id                 detail incl. linked accounts
//   POST   /                    create
//   PATCH  /:id                 update
//   POST   /:id/transition      mark as transitioning_out + add notes
//
// Phase 2 (when check printing builds):
//   POST   /:id/positive-pay-format    bank-specific positive-pay format spec
// ============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { is_active, transition_status } = req.query;
    let q = supabase.from('banks')
      .select('*')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('name')
      .limit(200);
    if (is_active === 'true') q = q.eq('is_active', true);
    if (is_active === 'false') q = q.eq('is_active', false);
    if (transition_status) q = q.eq('transition_status', transition_status);
    const { data, error } = await q;
    if (error) throw error;

    // Decorate with account count per bank
    const ids = (data || []).map((b) => b.id);
    let counts = {};
    if (ids.length > 0) {
      const { data: accts } = await supabase
        .from('bank_accounts')
        .select('bank_id, is_active')
        .in('bank_id', ids);
      for (const a of accts || []) {
        if (!counts[a.bank_id]) counts[a.bank_id] = { total: 0, active: 0 };
        counts[a.bank_id].total += 1;
        if (a.is_active) counts[a.bank_id].active += 1;
      }
    }
    const decorated = (data || []).map((b) => ({
      ...b,
      account_count: counts[b.id]?.total || 0,
      active_account_count: counts[b.id]?.active || 0,
    }));
    res.json({ banks: decorated });
  } catch (err) {
    console.error('[banks] list failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [{ data: bank }, { data: accounts }] = await Promise.all([
      supabase.from('banks').select('*').eq('id', id).maybeSingle(),
      supabase.from('bank_accounts')
        .select('id, community_id, account_nickname, account_last4, account_type, is_active, communities(name)')
        .eq('bank_id', id).order('account_nickname'),
    ]);
    if (!bank) return res.status(404).json({ error: 'not_found' });
    res.json({ bank, accounts: accounts || [] });
  } catch (err) {
    console.error('[banks] detail failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/', express.json(), async (req, res) => {
  try {
    const allowed = [
      'name', 'address_line1', 'address_line2', 'city', 'state', 'postal_code',
      'aba_check', 'aba_deposit', 'branch', 'beneficiary_name',
      'contact_name', 'contact_phone', 'contact_email',
      'is_active', 'transition_status', 'transition_notes', 'notes',
    ];
    const row = { management_company_id: BEDROCK_MGMT_CO_ID };
    for (const k of allowed) if (k in (req.body || {})) row[k] = req.body[k];
    if (!row.name) return res.status(400).json({ error: 'name_required' });
    if (!row.transition_status) row.transition_status = 'active';
    const { data, error } = await supabase.from('banks').insert(row).select('*').single();
    if (error) throw error;
    res.json({ bank: data });
  } catch (err) {
    console.error('[banks] create failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.patch('/:id', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = [
      'name', 'address_line1', 'address_line2', 'city', 'state', 'postal_code',
      'aba_check', 'aba_deposit', 'branch', 'beneficiary_name',
      'contact_name', 'contact_phone', 'contact_email',
      'is_active', 'transition_status', 'transition_notes', 'notes',
    ];
    const patch = {};
    for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no_fields' });
    const { data, error } = await supabase.from('banks').update(patch).eq('id', id).select('*').single();
    if (error) throw error;
    res.json({ bank: data });
  } catch (err) {
    console.error('[banks] update failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/:id/transition', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const { transition_notes } = req.body || {};
    const { data, error } = await supabase.from('banks').update({
      transition_status: 'transitioning_out',
      transition_notes: transition_notes || null,
    }).eq('id', id).select('*').single();
    if (error) throw error;
    res.json({ bank: data });
  } catch (err) {
    console.error('[banks] transition failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
