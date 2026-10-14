// ============================================================================
// lib/ar/ar_control.js — owner receivables vs the GL AR control, one community
// ----------------------------------------------------------------------------
// ONE place that answers "what do owners owe here, and does it tie to the GL?"
//   subledger = v_homeowner_current_balance (the canonical current-AR source,
//               see lib/ar/resolve_current_ar.js) summed for the community
//   GL        = every GL account that holds owner balances (Ed 2026-10-13): 1300
//               receivable + 2400 prepaid + 2410 former-owner refunds payable +
//               1310 legacy previous-owner receivable, net. The subledger includes
//               former owners, so the GL side must too.
//   unidentified receipts (posted as "Unidentified homeowner receipt", held in
//               2400 with no owner) are shown SEPARATELY, never inside the diff.
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
const { communityReadiness } = require('./ownership_history');
const OWNER_ACCOUNTS = ['1300', '2400', '2410', '1310'];

async function glOwnerAccounts(supabase, communityId) {
  const { data, error } = await supabase.from('v_trial_balance').select('account_number, total_debits_cents, total_credits_cents').eq('community_id', communityId).in('account_number', OWNER_ACCOUNTS);
  if (error) throw error;
  const by = {}; for (const r of data || []) by[r.account_number] = (by[r.account_number] || 0) + Number(r.total_debits_cents || 0) - Number(r.total_credits_cents || 0);
  return { by, net_cents: Object.values(by).reduce((s, v) => s + v, 0), accounts_found: (data || []).length };
}

// Receipts no owner could be matched to, held in 2400 (lib/accounting bank-rec convention:
// description "Unidentified homeowner receipt ..."). Positive = a credit sitting in the GL.
async function unidentifiedReceipts(supabase, communityId) {
  const { data: jes, error } = await supabase.from('journal_entries').select('id, reference').eq('community_id', communityId).eq('status', 'posted').ilike('description', 'Unidentified homeowner receipt%').limit(500);
  if (error) throw error;
  if (!jes.length) return { cents: 0, references: [] };
  const { data: acct, error: ae } = await supabase.from('chart_of_accounts').select('id').eq('community_id', communityId).eq('account_number', '2400');
  if (ae) throw ae;
  const { data: lines, error: le } = await supabase.from('journal_entry_lines').select('journal_entry_id, debit_cents, credit_cents').in('journal_entry_id', jes.map((j) => j.id)).in('account_id', (acct || []).map((a) => a.id));
  if (le) throw le;
  const cents = (lines || []).reduce((s, l) => s + Number(l.credit_cents || 0) - Number(l.debit_cents || 0), 0);
  return { cents, references: jes.filter((j) => (lines || []).some((l) => l.journal_entry_id === j.id)).map((j) => j.reference) };
}

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
  const gl = await glOwnerAccounts(supabase, communityId);
  const unid = await unidentifiedReceipts(supabase, communityId);
  const conversion = (await communityReadiness(supabase, [communityId])).get(communityId);
  return {
    community_id: communityId,
    subledger_cents: subledger,
    accounts: rows.length,
    owners_owing: owing,
    owners_in_credit: credit,
    gl_1300_2400_net_cents: gl.net_cents,   // kept name: now every owner-balance account (OWNER_ACCOUNTS)
    gl_owner_accounts: gl.by,
    gl_accounts_found: gl.accounts_found,
    unidentified_receipts_cents: unid.cents, unidentified_receipt_refs: unid.references,
    // Owners vs GL with the unidentified receipts set aside (shown separately).
    diff_cents: subledger - gl.net_cents - unid.cents,
    conversion: { ready: !!conversion.ready, batch_code: conversion.batch_code || null, as_of_date: conversion.as_of_date || null },
    ties: !!conversion.ready && gl.accounts_found > 0 && subledger - gl.net_cents - unid.cents === 0,
  };
}

module.exports = { arControl, unidentifiedReceipts, OWNER_ACCOUNTS };
