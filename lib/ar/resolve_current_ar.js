// ============================================================================
// lib/ar/resolve_current_ar.js — single source of truth for current AR
// ----------------------------------------------------------------------------
// Ed 2026-06-08 standing rule: ONE Vantaca report per data domain, ONE
// canonical table, all consumers read from one place. This function is the
// shared resolver every "what's this homeowner's current balance?" surface
// goes through.
//
// MERGE LOGIC:
//   Balance + as_of_date:
//     1. Try v_homeowner_current_balance (sum of homeowner_transactions from
//        committed batches) — the canonical post-Jun-2026 source.
//     2. Fall back to owner_ar_snapshots — legacy mirror, kept readable
//        for communities that haven't done a transaction import yet.
//   Enforcement signals (at_legal, in_collections, payment_plan_active,
//   enforcement_stage):
//     - Only owner_ar_snapshots has these today; transactions doesn't track
//       them yet. So we ALWAYS try the snapshot for these signals, even
//       when balance comes from transactions.
//     - When an "enforcement_state" table eventually exists, this is the
//       one place that needs to change.
//
// INPUT:
//   { propertyId?, vantacaAccountId?, communityId? }
//   - propertyId alone is enough; the function resolves the other two.
//   - vantacaAccountId + communityId together skip the property lookup.
//
// OUTPUT:
//   { balance_cents, as_of, source, enforcement_stage, at_legal,
//     in_collections, payment_plan_active, payment_plan_terms_text }
//   OR null when nothing is on file.
//
// source = 'transactions' | 'snapshot' | 'none' — tells the caller which
//   path won. Useful for the disclosure language Claire uses on voice.
// ============================================================================

async function resolveCurrentAR(supabase, opts = {}) {
  let { propertyId, vantacaAccountId, communityId } = opts;

  // Step 1 — resolve any missing identifiers from the property
  if (propertyId && (!vantacaAccountId || !communityId)) {
    try {
      const { data: p } = await supabase
        .from('properties')
        .select('vantaca_account_id, community_id')
        .eq('id', propertyId)
        .maybeSingle();
      if (p) {
        vantacaAccountId = vantacaAccountId || p.vantaca_account_id || null;
        communityId      = communityId      || p.community_id      || null;
      }
    } catch (_) { /* fall through to whatever we have */ }
  }

  // Step 2 — fetch both sources in parallel
  const [txnRes, snapRes] = await Promise.allSettled([
    (vantacaAccountId && communityId)
      ? supabase
          .from('v_homeowner_current_balance')
          .select('balance_cents, most_recent_txn_date')
          .eq('community_id', communityId)
          .eq('vantaca_account_id', vantacaAccountId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    propertyId
      ? supabase
          .from('owner_ar_snapshots')
          .select('balance_total, snapshot_date, enforcement_stage, at_legal, in_collections, payment_plan_active, payment_plan_terms_text')
          .eq('property_id', propertyId)
          .order('snapshot_date', { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const txn  = (txnRes.status === 'fulfilled') ? txnRes.value?.data  : null;
  const snap = (snapRes.status === 'fulfilled') ? snapRes.value?.data : null;

  if (!txn && !snap) return null;

  // Step 3 — balance + as_of: prefer transactions (granular, recent),
  // fall back to snapshot (legacy).
  let balance_cents, as_of, source;
  if (txn) {
    balance_cents = (txn.balance_cents != null) ? Number(txn.balance_cents) : null;
    as_of         = txn.most_recent_txn_date || null;
    source        = 'transactions';
  } else {
    balance_cents = (snap.balance_total != null) ? Math.round(Number(snap.balance_total) * 100) : null;
    as_of         = snap.snapshot_date || null;
    source        = 'snapshot';
  }

  // Step 4 — enforcement signals always from snapshot (only place they
  // currently exist). When transactions has data but no snapshot exists,
  // these are null — the caller treats null as "no flags."
  return {
    balance_cents,
    as_of,
    source,
    enforcement_stage:       snap?.enforcement_stage || null,
    at_legal:                !!snap?.at_legal,
    in_collections:          !!snap?.in_collections,
    payment_plan_active:     !!snap?.payment_plan_active,
    payment_plan_terms_text: snap?.payment_plan_terms_text || null,
  };
}

module.exports = { resolveCurrentAR };
