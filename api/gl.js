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

// ----------------------------------------------------------------------------
// Aging helper — days past due → bucket. Shared by AR + AP.
// ----------------------------------------------------------------------------
const AGING_BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd91_120', 'd120_plus'];
function _agingBucket(dueDate, asOf) {
  if (!dueDate) return 'current';
  const due = Date.parse(String(dueDate).slice(0, 10));
  const now = Date.parse(asOf);
  if (Number.isNaN(due)) return 'current';
  const days = Math.floor((now - due) / 86400000);
  if (days <= 0) return 'current';
  if (days <= 30) return 'd1_30';
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  if (days <= 120) return 'd91_120';
  return 'd120_plus';
}
const _emptyBuckets = () => Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0]));
const _today = () => new Date().toISOString().slice(0, 10);

async function _fetchAll(table, cols, filters) {
  const out = [];
  let from = 0;
  while (true) {
    let q = supabase.from(table).select(cols).range(from, from + 999);
    for (const [k, v] of Object.entries(filters || {})) q = q.eq(k, v);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return out;
}

// ----------------------------------------------------------------------------
// AR aging — per homeowner, broken out by charge CATEGORY (assessment, late
// fee, interest, certified/attorney fees, etc.) and aged by due date.
// ----------------------------------------------------------------------------
router.get('/:communityId/ar-aging', async (req, res) => {
  try {
    const cid = req.params.communityId;
    const asOf = req.query.as_of || _today();
    const charges = await _fetchAll('ar_charges',
      'property_id, charge_type_id, balance_remaining_cents, due_date, status, ar_charge_types:charge_type_id(category, display_name)',
      { community_id: cid, status: 'open' });
    const open = charges.filter((c) => Number(c.balance_remaining_cents) > 0);

    const categories = new Set();
    const byCategory = {};       // category -> { label, total, buckets }
    const byProp = {};           // property_id -> { total, by_category{}, buckets, oldest_days }
    let grandTotal = 0;
    const totalBuckets = _emptyBuckets();

    for (const c of open) {
      const cat = (c.ar_charge_types && c.ar_charge_types.category) || 'other';
      const label = (c.ar_charge_types && c.ar_charge_types.display_name) || cat;
      const bal = Number(c.balance_remaining_cents);
      const bucket = _agingBucket(c.due_date, asOf);
      categories.add(cat);
      grandTotal += bal;
      totalBuckets[bucket] += bal;

      if (!byCategory[cat]) byCategory[cat] = { category: cat, label, total: 0, buckets: _emptyBuckets() };
      byCategory[cat].total += bal; byCategory[cat].buckets[bucket] += bal;

      if (!byProp[c.property_id]) byProp[c.property_id] = { property_id: c.property_id, total: 0, by_category: {}, buckets: _emptyBuckets(), oldest_days: 0 };
      const p = byProp[c.property_id];
      p.total += bal; p.by_category[cat] = (p.by_category[cat] || 0) + bal; p.buckets[bucket] += bal;
      const days = Math.max(0, Math.floor((Date.parse(asOf) - Date.parse(String(c.due_date).slice(0, 10))) / 86400000));
      if (days > p.oldest_days) p.oldest_days = days;
    }

    // Join property addresses + owner names.
    const owners = await _fetchAll('v_current_property_owners', 'property_id, street_address, owner_name', { community_id: cid });
    const ownerByProp = Object.fromEntries(owners.map((o) => [o.property_id, o]));
    // Collection state per account (status badge + bankruptcy flag). Defensive:
    // the code can deploy before migration 232 creates the table — degrade to
    // "no collections" rather than 500 the whole aging screen.
    let collByProp = {};
    try {
      const coll = await _fetchAll('ar_account_collections', 'property_id, collection_status, status_since, bankruptcy_petition_date', { community_id: cid });
      collByProp = Object.fromEntries(coll.map((c) => [c.property_id, c]));
    } catch (e) { console.warn('[gl] collections table not ready:', e.message); }
    const homeowners = Object.values(byProp).map((p) => ({
      ...p,
      street_address: (ownerByProp[p.property_id] || {}).street_address || '—',
      owner_name: (ownerByProp[p.property_id] || {}).owner_name || '—',
      collection_status: (collByProp[p.property_id] || {}).collection_status || 'none',
      bankruptcy_petition_date: (collByProp[p.property_id] || {}).bankruptcy_petition_date || null,
    })).sort((a, b) => b.total - a.total);

    const collectionSummary = {};
    for (const h of homeowners) { if (h.collection_status && h.collection_status !== 'none') collectionSummary[h.collection_status] = (collectionSummary[h.collection_status] || 0) + 1; }

    res.json({
      as_of: asOf,
      categories: [...categories],
      summary: { total_cents: grandTotal, by_bucket: totalBuckets, by_category: Object.values(byCategory).sort((a, b) => b.total - a.total) },
      collection_summary: collectionSummary,
      homeowners,
      homeowner_count: homeowners.length,
    });
  } catch (err) {
    console.error('[gl] ar-aging failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// AR drill-down — every open charge for one property, by category, with age.
router.get('/:communityId/ar-aging/property/:propertyId', async (req, res) => {
  try {
    const asOf = req.query.as_of || _today();
    const charges = await _fetchAll('ar_charges',
      'id, charge_date, due_date, description, original_amount_cents, balance_remaining_cents, ar_charge_types:charge_type_id(category, display_name)',
      { community_id: req.params.communityId, property_id: req.params.propertyId, status: 'open' });
    // Collection state for this account (status + bankruptcy petition data).
    // Defensive against the pre-migration window (see ar-aging above).
    let collRow = null;
    try {
      const r = await supabase.from('ar_account_collections')
        .select('collection_status, status_since, bankruptcy_petition_date, bankruptcy_chapter, bankruptcy_case_number, bankruptcy_discharge_date, bankruptcy_dismissed_date, notes')
        .eq('community_id', req.params.communityId).eq('property_id', req.params.propertyId).maybeSingle();
      if (r.error) throw r.error;
      collRow = r.data;
    } catch (e) { console.warn('[gl] collections table not ready:', e.message); }
    const collection = collRow || { collection_status: 'none' };
    const petition = collection.bankruptcy_petition_date ? String(collection.bankruptcy_petition_date).slice(0, 10) : null;

    const rows = charges.filter((c) => Number(c.balance_remaining_cents) > 0).map((c) => {
      const chargeDate = String(c.charge_date || c.due_date || '').slice(0, 10);
      // Pre-petition = charge incurred BEFORE the bankruptcy filing (frozen by the
      // automatic stay); post-petition = on/after filing (the debtor's ongoing,
      // collectible obligation). Null when the account isn't in bankruptcy.
      const petition_phase = petition ? (chargeDate < petition ? 'pre_petition' : 'post_petition') : null;
      return {
        charge_date: c.charge_date, due_date: c.due_date, description: c.description,
        category: (c.ar_charge_types && c.ar_charge_types.display_name) || 'other',
        original_cents: Number(c.original_amount_cents), balance_cents: Number(c.balance_remaining_cents),
        days_past_due: Math.max(0, Math.floor((Date.parse(asOf) - Date.parse(String(c.due_date).slice(0, 10))) / 86400000)),
        bucket: _agingBucket(c.due_date, asOf), petition_phase,
      };
    }).sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));

    const total_cents = rows.reduce((s, r) => s + r.balance_cents, 0);
    // When in bankruptcy, split the ledger into the two legally-distinct buckets.
    const bankruptcy_split = petition ? {
      petition_date: petition,
      pre_petition_cents: rows.filter((r) => r.petition_phase === 'pre_petition').reduce((s, r) => s + r.balance_cents, 0),
      post_petition_cents: rows.filter((r) => r.petition_phase === 'post_petition').reduce((s, r) => s + r.balance_cents, 0),
    } : null;
    res.json({ charges: rows, total_cents, collection, bankruptcy_split });
  } catch (err) {
    console.error('[gl] ar-aging property failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// AP aging — open vendor invoices grouped by vendor, aged by due date.
// ----------------------------------------------------------------------------
router.get('/:communityId/ap-aging', async (req, res) => {
  try {
    const cid = req.params.communityId;
    const asOf = req.query.as_of || _today();
    const invoices = await _fetchAll('ap_invoices',
      'vendor_id, total_cents, amount_paid_cents, due_date, status, vendors:vendor_id(name, category)',
      { community_id: cid });
    const open = invoices.filter((i) => (Number(i.total_cents) - Number(i.amount_paid_cents)) > 0 && !['paid', 'voided'].includes(i.status));

    const byVendor = {};
    let grandTotal = 0;
    const totalBuckets = _emptyBuckets();
    for (const i of open) {
      const bal = Number(i.total_cents) - Number(i.amount_paid_cents);
      const bucket = _agingBucket(i.due_date, asOf);
      const vid = i.vendor_id;
      grandTotal += bal; totalBuckets[bucket] += bal;
      if (!byVendor[vid]) byVendor[vid] = { vendor_id: vid, vendor_name: (i.vendors && i.vendors.name) || '—', category: (i.vendors && i.vendors.category) || null, total: 0, open_count: 0, buckets: _emptyBuckets(), oldest_days: 0 };
      const v = byVendor[vid];
      v.total += bal; v.open_count += 1; v.buckets[bucket] += bal;
      const days = Math.max(0, Math.floor((Date.parse(asOf) - Date.parse(String(i.due_date || '').slice(0, 10))) / 86400000));
      if (days > v.oldest_days) v.oldest_days = days;
    }
    res.json({
      as_of: asOf,
      summary: { total_cents: grandTotal, by_bucket: totalBuckets },
      vendors: Object.values(byVendor).sort((a, b) => b.total - a.total),
      vendor_count: Object.keys(byVendor).length,
    });
  } catch (err) {
    console.error('[gl] ap-aging failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/:communityId/ap-aging/vendor/:vendorId', async (req, res) => {
  try {
    const asOf = req.query.as_of || _today();
    const invoices = await _fetchAll('ap_invoices',
      'id, vendor_invoice_number, invoice_date, due_date, total_cents, amount_paid_cents, status',
      { community_id: req.params.communityId, vendor_id: req.params.vendorId });
    const rows = invoices.filter((i) => (Number(i.total_cents) - Number(i.amount_paid_cents)) > 0 && !['paid', 'voided'].includes(i.status)).map((i) => ({
      invoice_number: i.vendor_invoice_number, invoice_date: i.invoice_date, due_date: i.due_date,
      total_cents: Number(i.total_cents), balance_cents: Number(i.total_cents) - Number(i.amount_paid_cents),
      days_past_due: Math.max(0, Math.floor((Date.parse(asOf) - Date.parse(String(i.due_date || '').slice(0, 10))) / 86400000)),
      bucket: _agingBucket(i.due_date, asOf),
    })).sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
    res.json({ invoices: rows, total_cents: rows.reduce((s, r) => s + r.balance_cents, 0) });
  } catch (err) {
    console.error('[gl] ap-aging vendor failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// Collections — set/update an account's collection status + bankruptcy data.
// The pre/post-petition ledger split (in the property drill-down) activates
// automatically once bankruptcy_petition_date is set.
// ----------------------------------------------------------------------------
const COLLECTION_STATUSES = ['none', 'late_notice', 'delinquent_reminder', 'certified_demand', 'board_review', 'payment_plan', 'with_attorney', 'bankruptcy', 'lien_filed', 'foreclosure', 'written_off'];
const COLLECTION_FIELDS = ['collection_status', 'status_since', 'bankruptcy_petition_date', 'bankruptcy_chapter', 'bankruptcy_case_number', 'bankruptcy_discharge_date', 'bankruptcy_dismissed_date', 'notes'];

router.patch('/:communityId/collections/:propertyId', async (req, res) => {
  try {
    const { communityId, propertyId } = req.params;
    const patch = { community_id: communityId, property_id: propertyId };
    for (const f of COLLECTION_FIELDS) {
      if (req.body[f] === undefined) continue;
      patch[f] = req.body[f] === '' ? null : req.body[f];
    }
    if (patch.collection_status && !COLLECTION_STATUSES.includes(patch.collection_status)) {
      return res.status(400).json({ error: 'invalid_collection_status' });
    }
    if (patch.bankruptcy_chapter && !['7', '11', '12', '13'].includes(String(patch.bankruptcy_chapter))) {
      return res.status(400).json({ error: 'invalid_bankruptcy_chapter' });
    }
    const { data, error } = await supabase.from('ar_account_collections')
      .upsert(patch, { onConflict: 'community_id,property_id' }).select().single();
    if (error) throw error;
    res.json({ ok: true, collection: data });
  } catch (err) {
    console.error('[gl] collections patch failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// List accounts in collections (status != none), with current balance + owner.
router.get('/:communityId/collections', async (req, res) => {
  try {
    const cid = req.params.communityId;
    const coll = await _fetchAll('ar_account_collections',
      'property_id, collection_status, status_since, bankruptcy_petition_date, bankruptcy_chapter, bankruptcy_case_number, notes',
      { community_id: cid });
    const active = coll.filter((c) => c.collection_status && c.collection_status !== 'none');
    const charges = await _fetchAll('ar_charges', 'property_id, balance_remaining_cents', { community_id: cid, status: 'open' });
    const balByProp = {};
    for (const c of charges) balByProp[c.property_id] = (balByProp[c.property_id] || 0) + Number(c.balance_remaining_cents);
    const owners = await _fetchAll('v_current_property_owners', 'property_id, street_address, owner_name', { community_id: cid });
    const ownerByProp = Object.fromEntries(owners.map((o) => [o.property_id, o]));
    const rows = active.map((c) => ({
      ...c,
      balance_cents: balByProp[c.property_id] || 0,
      street_address: (ownerByProp[c.property_id] || {}).street_address || '—',
      owner_name: (ownerByProp[c.property_id] || {}).owner_name || '—',
    })).sort((a, b) => b.balance_cents - a.balance_cents);
    res.json({ accounts: rows, count: rows.length });
  } catch (err) {
    console.error('[gl] collections list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
