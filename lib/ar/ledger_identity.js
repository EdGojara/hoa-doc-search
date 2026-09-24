// ============================================================================
// lib/ar/ledger_identity.js
// ----------------------------------------------------------------------------
// The homeowner ledger (homeowner_transactions, committed batches) is keyed by
// ACCOUNT: an account is one owner tenure. Every reader resolves a property to
// its CURRENT account (properties.vantaca_account_id) and reads that account
// (resolveCurrentAR, portal, Claire, autopay, online payments). Writers must use
// the same key, or a new charge lands on a prior owner's account and the current
// owner never sees it.
//
// Before this helper, the native charge paths copied the account from "the
// property's most recent ledger line" (which after a sale, or once a prior
// import is retired, can be the seller's) and computed the running balance by
// summing every row on the property, including retired batches and other
// owners. Both now come from here.
// ============================================================================

// Identity for a NEW ledger line on this property = its current tenure.
async function currentLedgerIdentity(supabase, propertyId) {
  const { data: prop, error } = await supabase.from('properties')
    .select('id, community_id, vantaca_account_id, trusted_account_number')
    .eq('id', propertyId).maybeSingle();
  if (error) throw error;
  if (!prop) throw Object.assign(new Error('property_not_found'), { code: 'not_found' });
  let contactId = null;
  const { data: owner, error: oErr } = await supabase.from('v_current_property_owners')
    .select('owner_contact_id').eq('property_id', propertyId).limit(1).maybeSingle();
  if (oErr) throw oErr;
  if (owner) contactId = owner.owner_contact_id || null;
  return {
    community_id: prop.community_id,
    vantaca_account_id: prop.vantaca_account_id || null,
    trusted_account_number: prop.trusted_account_number || null,
    contact_id: contactId,
  };
}

// Current balance of one account = committed ledger only (same as the view).
async function committedAccountBalance(supabase, communityId, vantacaAccountId) {
  if (!vantacaAccountId) return 0;
  const { data, error } = await supabase.from('v_homeowner_current_balance')
    .select('balance_cents').eq('community_id', communityId).eq('vantaca_account_id', vantacaAccountId);
  if (error) throw error;
  return (data || []).reduce((s, r) => s + Number(r.balance_cents || 0), 0);
}

module.exports = { currentLedgerIdentity, committedAccountBalance };
