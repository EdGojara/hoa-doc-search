// ============================================================================
// lib/ar/owner_balance.js  (Ed 2026-10-21) — THE homeowner balance
// ----------------------------------------------------------------------------
// One calculation for every screen and API that shows what a current owner
// owes: owner search, collections, account, statement, AR aging, Homeowner
// 360, the homeowner portal, collections notices, Claire, resale certificates.
//
// An owner's account is two sources, both posted to GL 1300:
//   1. the homeowner ledger (homeowner_transactions via v_current_owner_ledger:
//      committed batches, the CURRENT owner's tenure only), which holds the
//      conversion opening balances, charges, payments, credits and prepayments;
//   2. charges trustEd billed natively in ar_charges (certified-letter fees),
//      not mirrored into the ledger. Current tenure only (an unstamped charge
//      is on the lot's current owner).
// Native rows from a Vantaca AR import (source 'vantaca_migration', Quail
// Ridge) are EXCLUDED: they are a superseded 6/20/2026 snapshot ("balance as of
// 6/20/2026"); the 7/31 conversion opening balances on the ledger are the ones
// posted to the GL, and they tie to GL 1300 to the cent. The rows are left in
// place, untouched.
//
// Per owner, every charge from both sources is reduced by every payment and
// credit in Texas Property Code §209.0063 order (assessments first, then
// assessment-related attorney fees, fines, everything else; oldest first). So:
//   net_due_cents      = ledger net + native open           (THE balance)
//   open_charges_cents = charges still open after credits    (what is aged)
//   credit_cents       = credit left after every charge      (owner in credit)
//   open_charges_cents - credit_cents = net_due_cents, and at most one is > 0.
// A payment for a native fee lands on the ledger, so it offsets that fee here
// even though the native row is never marked paid (7919 Caribou Valley).
// ============================================================================

const { fetchAllQuery } = require('../db/fetch_all');
const { currentOwnerLedgerForCommunity } = require('./current_owner_ledger');

const SUPERSEDED_NATIVE_SOURCES = ['vantaca_migration'];

// AR category + label + §209.0063 application priority (lower = applied first)
// from a ledger description or a native charge type's display name.
function categorizeCharge(desc) {
  const d = String(desc || '');
  if (/assessment/i.test(d) && !/late/i.test(d))            return { category: 'assessment', label: 'Assessment', priority: 1 };
  if (/(prior balance|balance forward)/i.test(d) && !/(interest|fine|legal|admin|fee)/i.test(d)) return { category: 'assessment', label: 'Prior Balance', priority: 1 };
  if (/(legal|attorney|collection)/i.test(d))               return { category: 'attorney_fee', label: 'Legal / Collections', priority: 3 };
  if (/fine/i.test(d))                                       return { category: 'fine', label: 'Fine', priority: 5 };
  if (/certified/i.test(d))                                  return { category: 'certified', label: 'Certified Fee', priority: 6 };
  if (/interest/i.test(d))                                   return { category: 'interest', label: 'Interest', priority: 6 };
  if (/late fee/i.test(d))                                   return { category: 'late_fee', label: 'Late Fee', priority: 6 };
  if (/(nsf|bank return|stop payment)/i.test(d))             return { category: 'nsf_fee', label: 'NSF / Returned', priority: 6 };
  if (/payment plan/i.test(d))                              return { category: 'other', label: 'Payment Plan Fee', priority: 6 };
  if (/admin/i.test(d))                                      return { category: 'other', label: 'Administrative Fee', priority: 6 };
  return { category: 'other', label: (d.split(/[-:]/)[0] || 'Other').trim().slice(0, 30) || 'Other', priority: 9 };
}

// PURE. One owner's ledger rows + native open charges -> the balance.
function allocateOwner(ledgerRows = [], nativeCharges = []) {
  const charges = []; let credit = 0; let ledgerNet = 0; let nativeOpen = 0;
  for (const t of ledgerRows) {
    const amt = Number(t.amount_cents) || 0;
    ledgerNet += amt;
    // Positive = owed (a positive 'payment' row is a reversed / returned payment);
    // negative = payments, credits, prepayments and negative opening rows.
    if (amt > 0) {
      const cat = t.txn_type === 'payment' ? { category: 'nsf_fee', label: 'Returned Payment', priority: 6 } : categorizeCharge(t.description);
      charges.push({ source: 'ledger', ...cat, date: String(t.transaction_date || '').slice(0, 10), description: t.description, amount: amt });
    } else credit -= amt;
  }
  for (const c of nativeCharges) {
    const amt = Number(c.balance_remaining_cents) || 0;
    if (amt <= 0) continue;
    nativeOpen += amt;
    const display = (c.ar_charge_types && c.ar_charge_types.display_name) || c.description;
    const cat = categorizeCharge(display);
    charges.push({ source: 'native', native_charge_id: c.id || null, ...cat, label: display || cat.label,
      date: String(c.due_date || c.charge_date || '').slice(0, 10), description: c.description, amount: amt });
  }
  charges.sort((a, b) => (a.priority - b.priority) || a.date.localeCompare(b.date));
  let left = credit;
  for (const ch of charges) { const applied = Math.min(ch.amount, left); ch.remaining = ch.amount - applied; left -= applied; }
  const open = charges.filter((ch) => ch.remaining > 0).map((ch) => ({
    source: ch.source, native_charge_id: ch.native_charge_id || null, due_date: ch.date, description: ch.description,
    original_amount_cents: ch.amount, balance_remaining_cents: ch.remaining,
    ar_charge_types: { category: ch.category, display_name: ch.label },
  }));
  const openCents = open.reduce((s, c) => s + c.balance_remaining_cents, 0);
  return {
    net_due_cents: ledgerNet + nativeOpen, open_charges_cents: openCents, credit_cents: left,
    ledger_net_cents: ledgerNet, native_open_cents: nativeOpen, open_charges: open,
  };
}

// Native open charges that count toward current owners (see header).
async function currentNativeCharges(supabase, communityId, { propertyId = null, asOf = null, tenureByProp = null } = {}) {
  const rows = await fetchAllQuery(() => {
    let q = supabase.from('ar_charges')
      .select('id, property_id, tenure_id, charge_date, due_date, description, original_amount_cents, balance_remaining_cents, source_module, ar_charge_types:charge_type_id(category, display_name)')
      .eq('community_id', communityId).eq('status', 'open');
    if (propertyId) q = q.eq('property_id', propertyId);
    return q;
  }, { orderBy: 'id' });
  return rows.filter((c) => Number(c.balance_remaining_cents) > 0
    && !SUPERSEDED_NATIVE_SOURCES.includes(c.source_module)
    && (!asOf || String(c.charge_date || c.due_date || '').slice(0, 10) <= asOf)
    && (!c.tenure_id || !tenureByProp || c.tenure_id === tenureByProp[c.property_id]));
}

// Every current owner's balance in a community (or one lot): { property_id: balance }.
// Also returns the rows it used so AR aging can reconcile from the same data.
async function ownerBalancesDetailed(supabase, communityId, { propertyId = null, asOf = null } = {}) {
  const owners = await fetchAllQuery(() => {
    let q = supabase.from('v_current_property_owners').select('property_id, tenure_id').eq('community_id', communityId);
    if (propertyId) q = q.eq('property_id', propertyId);
    return q;
  }, { orderBy: 'property_id' });
  const tenureByProp = Object.fromEntries(owners.map((o) => [o.property_id, o.tenure_id]));
  let ledgerRows = await currentOwnerLedgerForCommunity(supabase, communityId, propertyId);
  if (asOf) ledgerRows = ledgerRows.filter((t) => String(t.transaction_date || '').slice(0, 10) <= asOf);
  const native = await currentNativeCharges(supabase, communityId, { propertyId, asOf, tenureByProp });
  const group = (list) => { const m = {}; for (const r of list) if (r.property_id) (m[r.property_id] = m[r.property_id] || []).push(r); return m; };
  const L = group(ledgerRows); const N = group(native);
  const balances = {};
  for (const pid of new Set([...Object.keys(L), ...Object.keys(N)])) {
    const rows = L[pid] || [];
    balances[pid] = { property_id: pid, tenure_id: tenureByProp[pid] || null, ...allocateOwner(rows, N[pid] || []), native_charges: N[pid] || [],
      most_recent_txn_date: rows.map((r) => String(r.transaction_date || '').slice(0, 10)).concat((N[pid] || []).map((c) => String(c.charge_date || '').slice(0, 10))).filter(Boolean).sort().pop() || null,
      ledger_txn_count: rows.length };
  }
  return { balances, ledgerRows, nativeCharges: native };
}

async function ownerBalances(supabase, communityId, opts = {}) {
  return (await ownerBalancesDetailed(supabase, communityId, opts)).balances;
}

// One lot's current-owner balance. null = nothing on file for the current owner
// (callers decide what "no data" means; never assume $0).
async function ownerBalance(supabase, propertyId, { communityId = null, asOf = null } = {}) {
  let cid = communityId;
  if (!cid) {
    const { data, error } = await supabase.from('properties').select('community_id').eq('id', propertyId).maybeSingle();
    if (error) throw error;
    cid = data && data.community_id;
  }
  if (!cid) return null;
  return (await ownerBalances(supabase, cid, { propertyId, asOf }))[propertyId] || null;
}

// Many lots across communities at once (Homeowner 360): { property_id: balance }.
async function ownerBalancesForProperties(supabase, propertyIds) {
  const ids = [...new Set((propertyIds || []).filter(Boolean))];
  if (!ids.length) return {};
  const { data, error } = await supabase.from('properties').select('id, community_id').in('id', ids);
  if (error) throw error;
  const out = {};
  for (const p of data || []) Object.assign(out, await ownerBalances(supabase, p.community_id, { propertyId: p.id }));
  return out;
}

// Activity for a statement: the ledger rows (oldest first) with the owner's
// native charges merged in by date, so the lines add up to THE balance. A
// ledger row keeps its running balance plus the native charges dated on or
// before it; a native row's running balance is the ledger's at that point plus
// the native charges so far. PURE.
function mergeNativeActivity(ledgerRowsAsc = [], nativeCharges = []) {
  const native = nativeCharges.filter((c) => Number(c.balance_remaining_cents) > 0).map((c) => ({
    id: c.id, property_id: c.property_id, tenure_id: c.tenure_id || null,
    transaction_date: String(c.charge_date || c.due_date || '').slice(0, 10),
    description: c.description || (c.ar_charge_types && c.ar_charge_types.display_name) || 'Charge',
    txn_type: 'charge', amount_cents: Number(c.balance_remaining_cents), source: 'native',
  })).sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));
  if (!native.length) return ledgerRowsAsc;
  const out = []; let nat = 0; let lastLedgerRun = 0; let i = 0;
  for (const r of ledgerRowsAsc) {
    const d = String(r.transaction_date || '').slice(0, 10);
    while (i < native.length && native[i].transaction_date < d) { nat += native[i].amount_cents; out.push({ ...native[i], running_balance_cents: lastLedgerRun + nat }); i++; }
    lastLedgerRun = r.running_balance_cents != null ? Number(r.running_balance_cents) : lastLedgerRun + (Number(r.amount_cents) || 0);
    out.push({ ...r, running_balance_cents: r.running_balance_cents == null ? null : Number(r.running_balance_cents) + nat });
  }
  while (i < native.length) { nat += native[i].amount_cents; out.push({ ...native[i], running_balance_cents: lastLedgerRun + nat }); i++; }
  return out;
}

module.exports = {
  mergeNativeActivity,
  ownerBalance, ownerBalances, ownerBalancesDetailed, ownerBalancesForProperties, currentNativeCharges,
  allocateOwner, categorizeCharge, SUPERSEDED_NATIVE_SOURCES,
};
