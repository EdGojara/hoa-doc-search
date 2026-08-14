// ============================================================================
// api/vault.js  (Ed 2026-08-14)
// ----------------------------------------------------------------------------
// The OWNER'S PRIVATE accounting vault — Bedrock (S-corp) + Ed's other
// companies, reconstructed for the audit and kept going forward.
//
// LOCK: every route is gated by requireOwner (Ed's login specifically — not
// merely "an admin"). A router-level gate runs FIRST so no endpoint can ever
// ship ungated by accident. Nothing here is exposed to staff, portals, or any
// AI/search index. See migration 365.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireOwner } = require('./_require_admin');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();

router.use(express.json({ limit: '512kb' }));

// The seal: EVERY vault request must be the owner. requireOwner sends a 403 for
// anyone else (including a future second admin). We also log every entry.
router.use(async (req, res, next) => {
  const owner = await requireOwner(req, res); // sends 403 if not Ed
  if (!owner) return;
  req.owner = owner;
  try { await supabase.from('vault_access_log').insert({ user_email: owner.email, action: `${req.method} ${req.path}` }); } catch (_) { /* log is best-effort */ }
  next();
});

// GET /whoami — proves the lock. Returns the owner; everyone else already got 403.
router.get('/whoami', (req, res) => res.json({ ok: true, owner: { email: req.owner.email, name: req.owner.full_name } }));

// ---- Entities (the companies) ---------------------------------------------
router.get('/entities', async (req, res) => {
  try {
    const { data, error } = await supabase.from('vault_entities').select('*').order('name');
    if (error) throw error;
    res.json({ entities: data || [] });
  } catch (err) { console.error('[vault] entities list failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

const ENTITY_TYPES = ['s_corp', 'c_corp', 'llc', 'partnership', 'sole_prop', 'individual'];
router.post('/entities', async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name_required' });
    const entity_type = ENTITY_TYPES.includes(b.entity_type) ? b.entity_type : 's_corp';
    const row = {
      name, entity_type,
      ein: (b.ein || '').trim() || null,
      fiscal_year_end: /^\d{2}-\d{2}$/.test(b.fiscal_year_end || '') ? b.fiscal_year_end : '12-31',
      notes: (b.notes || '').trim() || null,
    };
    const { data, error } = await supabase.from('vault_entities').insert(row).select('*').single();
    if (error) throw error;
    res.json({ entity: data });
  } catch (err) { console.error('[vault] entity create failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.patch('/entities/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    if (b.name != null) patch.name = String(b.name).trim();
    if (b.entity_type && ENTITY_TYPES.includes(b.entity_type)) patch.entity_type = b.entity_type;
    if (b.ein != null) patch.ein = String(b.ein).trim() || null;
    if (b.fiscal_year_end && /^\d{2}-\d{2}$/.test(b.fiscal_year_end)) patch.fiscal_year_end = b.fiscal_year_end;
    if (b.notes != null) patch.notes = String(b.notes).trim() || null;
    if (b.is_active != null) patch.is_active = b.is_active !== false;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing_to_update' });
    patch.updated_at = new Date().toISOString();
    const { error } = await supabase.from('vault_entities').update(patch).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { console.error('[vault] entity update failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ---- Chart of accounts (per entity) ---------------------------------------
router.get('/entities/:id/accounts', async (req, res) => {
  try {
    const { data, error } = await supabase.from('vault_accounts').select('*').eq('entity_id', req.params.id).order('account_number');
    if (error) throw error;
    res.json({ accounts: data || [] });
  } catch (err) { console.error('[vault] accounts list failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'];
router.post('/entities/:id/accounts', async (req, res) => {
  try {
    const b = req.body || {};
    const account_number = String(b.account_number || '').trim();
    const account_name = String(b.account_name || '').trim();
    if (!account_number || !account_name) return res.status(400).json({ error: 'account_number_and_name_required' });
    if (!ACCOUNT_TYPES.includes(b.account_type)) return res.status(400).json({ error: 'invalid_account_type', allowed: ACCOUNT_TYPES });
    const normal_balance = ['asset', 'expense'].includes(b.account_type) ? 'debit' : 'credit';
    const row = { entity_id: req.params.id, account_number, account_name, account_type: b.account_type, normal_balance };
    const { data, error } = await supabase.from('vault_accounts').insert(row).select('*').single();
    if (error) {
      if (/duplicate|unique/i.test(error.message)) return res.status(409).json({ error: 'account_number_exists' });
      throw error;
    }
    res.json({ account: data });
  } catch (err) { console.error('[vault] account create failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

module.exports = { router };
