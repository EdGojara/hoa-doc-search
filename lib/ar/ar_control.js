// ============================================================================
// lib/ar/ar_control.js — owner receivables vs the GL AR control, one community
// ----------------------------------------------------------------------------
// ONE place that answers "what do owners owe here, and does it tie to the GL?"
//   subledger = v_homeowner_current_balance (the canonical current-AR source,
//               see lib/ar/resolve_current_ar.js) summed for the community
//   GL        = 1300 receivable + 2400 prepaid, net (glArNetCents)
//   diff      = subledger − GL; it "ties" only at exactly 0 cents, and only
//               for a community whose ledger conversion is POSTED. Before
//               conversion the two are different books and the comparison
//               is not a validation (Ed: never validate unconverted
//               communities), so callers show it as not applicable.
//
// Used by the Operator Home receivables card (Issue #6) and Kat's month-end
// reconciliation status (lib/accounting/reconciliation_status.js), so both
// report the same numbers. Read-only. Throws on any query error; a failed read
// must never come back as a clean $0.
// ============================================================================
const { fetchAllQuery } = require('../db/fetch_all');
const { glArNetCents, communityReadiness } = require('./ownership_history');

async function arControl(supabase, communityId) {
  if (!communityId) throw new Error('arControl: communityId required');
  // Stable, unique order across pages: the view groups by
  // (community, vantaca_account_id, property_id, contact_id).
  const rows = await fetchAllQuery(() => supabase.from('v_homeowner_current_balance')
    .select('vantaca_account_id, property_id, contact_id, balance_cents')
    .eq('community_id', communityId)
    .order('vantaca_account_id', { ascending: true })
    .order('property_id', { ascending: true }), { orderBy: 'contact_id' });
  let subledger = 0, owing = 0, credit = 0;
  for (const r of rows) {
    const c = Number(r.balance_cents || 0);
    subledger += c;
    if (c > 0) owing += 1; else if (c < 0) credit += 1;
  }
  const gl = await glArNetCents(supabase, communityId);
  const conversion = (await communityReadiness(supabase, [communityId])).get(communityId);
  return {
    community_id: communityId,
    subledger_cents: subledger,
    accounts: rows.length,
    owners_owing: owing,
    owners_in_credit: credit,
    gl_1300_2400_net_cents: gl.net_cents,
    gl_accounts_found: gl.accounts_found,
    diff_cents: subledger - gl.net_cents,
    conversion: { ready: !!conversion.ready, batch_code: conversion.batch_code || null, as_of_date: conversion.as_of_date || null },
    ties: !!conversion.ready && gl.accounts_found > 0 && subledger - gl.net_cents === 0,
  };
}

module.exports = { arControl };
