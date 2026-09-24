// ============================================================================
// lib/ar/current_owner_ledger.js
// ----------------------------------------------------------------------------
// The CURRENT OWNER's money for a lot, keyed by ownership tenure (mig 456/457).
// Every current-homeowner reader (statements, portal, the shared balance
// resolver, Homeowner 360, AR aging, amenity access) goes through here, so a
// buyer never sees a seller's balance and legacy / historical tenures never
// leak into a current-owner view.
//
//   v_current_owner_ledger   committed rows on the lot's current tenure that are
//                            still on the lot's current account (+ not-yet-stamped
//                            rows on that account while writers are switched)
//   v_current_owner_balance  one row per property: balance / as-of / count
//   v_former_owner_ledger_balances  everything else: former-owner contexts ONLY
//
// Ordering is deterministic: transaction_date, created_at, id. Ties used to be
// returned in physical order, which changes whenever a row is rewritten.
// ============================================================================

const { fetchAllQuery } = require('../db/fetch_all');

// Every multi-page read goes through the sanctioned paginator; the builders
// set the business order and fetchAllQuery appends a unique final tiebreak.
const pageAll = (buildQuery, orderBy = 'id') => fetchAllQuery(buildQuery, { orderBy });

const LEDGER_COLS = 'id, community_id, property_id, tenure_id, vantaca_account_id, contact_id, transaction_date, description, txn_type, amount_cents, running_balance_cents, charge_category, created_at, source_batch_id, stamped';

// Current owner's balance for one lot. null = nothing on the ledger for the
// current owner (callers decide what "no data" means; never assume $0).
async function currentOwnerBalance(supabase, propertyId) {
  const { data, error } = await supabase.from('v_current_owner_balance')
    .select('community_id, property_id, tenure_id, balance_cents, most_recent_txn_date, txn_count, unstamped_count')
    .eq('property_id', propertyId);
  if (error) throw error;
  if (!data || !data.length) return null;
  if (data.length > 1) throw new Error(`current_owner_balance: ${data.length} rows for property ${propertyId}`);
  const r = data[0];
  return { ...r, balance_cents: Number(r.balance_cents) };
}

// Current balances for many lots at once: { property_id: row }.
async function currentOwnerBalances(supabase, propertyIds) {
  const out = {};
  for (let i = 0; i < propertyIds.length; i += 150) {
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await supabase.from('v_current_owner_balance')
      .select('community_id, property_id, tenure_id, balance_cents, most_recent_txn_date, txn_count')
      .in('property_id', propertyIds.slice(i, i + 150));
    if (error) throw error;
    for (const r of data || []) out[r.property_id] = { ...r, balance_cents: Number(r.balance_cents) };
  }
  return out;
}

// Current owner's ledger rows for one lot, deterministic order.
// opts: { ascending = true, limit, from (date), to (date), toInclusive = true }
async function currentOwnerActivity(supabase, propertyId, opts = {}) {
  const asc = opts.ascending !== false;
  const build = () => {
    let q = supabase.from('v_current_owner_ledger').select(LEDGER_COLS).eq('property_id', propertyId);
    if (opts.from) q = q.gte('transaction_date', opts.from);
    if (opts.to) q = opts.toExclusive ? q.lt('transaction_date', opts.to) : q.lte('transaction_date', opts.to);
    return q.order('transaction_date', { ascending: asc })
      .order('created_at', { ascending: asc })
      .order('id', { ascending: asc });
  };
  if (opts.limit) {
    const { data, error } = await build().limit(opts.limit);
    if (error) throw error;
    return data || [];
  }
  return pageAll(build);
}

// Current-owner rows for a whole community (AR aging), deterministic order.
async function currentOwnerLedgerForCommunity(supabase, communityId, propertyId = null) {
  return pageAll(() => {
    let q = supabase.from('v_current_owner_ledger').select(LEDGER_COLS).eq('community_id', communityId);
    if (propertyId) q = q.eq('property_id', propertyId);
    return q.order('property_id', { ascending: true }).order('transaction_date', { ascending: true })
      .order('created_at', { ascending: true }).order('id', { ascending: true });
  });
}

// Current owner's balance by charge category (amenity access).
async function currentOwnerComposition(supabase, propertyId) {
  const { data, error } = await supabase.from('v_current_owner_balance_composition')
    .select('charge_category, amount_cents').eq('property_id', propertyId);
  if (error) throw error;
  return data || [];
}

// Former-owner / legacy balances (historical aging and former-owner contexts only).
async function formerOwnerBalances(supabase, communityId) {
  return pageAll(() => supabase.from('v_former_owner_ledger_balances')
    .select('community_id, tenure_id, tenure_kind, property_id, vantaca_account_id, balance_cents, txn_count, most_recent_txn_date')
    .eq('community_id', communityId)
    .order('tenure_id', { ascending: true, nullsFirst: false })
    .order('property_id', { ascending: true, nullsFirst: false }), 'vantaca_account_id');
}

module.exports = {
  currentOwnerBalance, currentOwnerBalances, currentOwnerActivity,
  currentOwnerLedgerForCommunity, currentOwnerComposition, formerOwnerBalances,
};
