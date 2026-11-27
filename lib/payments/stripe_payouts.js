// ============================================================================
// lib/payments/stripe_payouts.js  (Ed 2026-11-27)
// ----------------------------------------------------------------------------
// Stages a Stripe payout to an association's bank as evidence for the monthly
// bank reconciliation. Called from the payout.paid / payout.failed webhook on the
// association's connected account (payment_lifecycle.js). POSTS NOTHING.
//
// One bank_rec_payouts row per balance transaction in the payout (migration 240
// table, migration 587 columns): kind 'stripe', source_filename 'stripe:webhook',
// trxn_date = when the money entered the association's Stripe balance,
// payout_date = arrival_date = when it lands in the bank, amount_cents = the
// component's NET (a refund or reversal is negative), payout_amount_cents = the
// whole payout, account_ref = the lot's Trusted account number.
//
// Each component is tied to OUR assessment payment (payment_id) only on evidence:
// its PaymentIntent (or payment_group_id) is one of this community's assessment
// payments AND the amount is that payment's assessment (+) or its full reversal
// (-). Anything else stays resolution 'unresolved' with the reason; the bank rec
// lists it as an exception and proposes nothing for that payout.
//
// Idempotent: balance_txn_id is UNIQUE, the insert ignores duplicates, so a
// replayed or re-delivered payout.paid stages nothing twice. payout.failed marks
// the payout's rows failed; the rec stops matching them.
//
// Then lib/banking/stripe_clearing.js (inside Kat's monthly bank rec) matches the
// payout to one bank deposit and proposes Dr operating cash / Cr Stripe clearing,
// keyed stripe:payout:<po id>, for the owner's approval.
// ============================================================================
const { centralDate } = require('./payment_lifecycle');

const STRIPE_SOURCE = 'stripe:webhook';
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

async function communityForAccount(supabase, accountId) {
  const { data, error } = await supabase.from('communities').select('id, name').eq('stripe_connected_account_id', accountId).limit(2);
  if (error) throw new Error(`[stripe_payouts] community lookup failed: ${error.message}`);
  return data || [];
}

// PURE: tie components to payments. payments: this community's assessment rows
// that any component could name. -> rows ready for bank_rec_payouts.
function buildPayoutRows({ payout, communityId, components, payments }) {
  const byPi = new Map(); const byGroup = new Map();
  for (const p of payments || []) {
    if (p.processor_payment_id) byPi.set(p.processor_payment_id, p);
    if (p.payment_group_id) byGroup.set(p.payment_group_id, p);
  }
  const arrival = payout.arrival_date ? centralDate(payout.arrival_date) : null;
  const base = { community_id: communityId, kind: 'stripe', source_filename: STRIPE_SOURCE, processor_payout_id: payout.id,
    payout_status: 'paid', payout_date: arrival, arrival_date: arrival, payout_amount_cents: Number(payout.amount) };
  if (!components.length) {
    // A manual payout (or one Stripe will not itemize): staged whole, unresolved.
    return [{ ...base, balance_txn_id: `${payout.id}:unitemized`, trxn_date: arrival, txn_type: 'payout_unitemized', amount_cents: Number(payout.amount),
      resolution: 'unresolved', resolution_note: 'Stripe did not itemize this payout (a manual payout?); its contents cannot be tied to payments.' }];
  }
  return components.map((c) => {
    const pay = (c.payment_intent_id && byPi.get(c.payment_intent_id)) || (c.payment_group_id && byGroup.get(c.payment_group_id)) || null;
    const amt = Number(c.amount_cents);
    let resolution = 'unresolved'; let note = null;
    if (!pay) note = c.resolved ? 'the Stripe charge is not one of this association\'s online assessment payments' : 'Stripe component could not be traced to a charge';
    else if (pay.community_id !== communityId) note = 'the payment belongs to another community';
    else if (amt > 0 && amt === Math.abs(Number(pay.amount_cents))) resolution = 'tied';
    else if (amt < 0 && -amt === Math.abs(Number(pay.amount_cents))) resolution = 'tied';
    else note = `component ${amt} cents does not equal the payment's ${Math.abs(Number(pay.amount_cents))} cents (a partial refund, a fee, or a mismatch)`;
    return { ...base, balance_txn_id: c.balance_txn_id, trxn_date: c.created ? centralDate(c.created) : arrival, txn_type: c.type,
      amount_cents: amt, charge_id: c.platform_charge_id || null, payment_intent_id: c.payment_intent_id || null,
      payment_id: pay && pay.community_id === communityId ? pay.id : null,
      account_ref: pay && pay.community_id === communityId ? pay.trusted_account_number || null : null, resolution, resolution_note: note };
  });
}

async function stagePayout({ supabase, stripeLib, log = console }, payout, accountId) {
  if (!payout || !payout.id || !/^po_/.test(String(payout.id))) return { action: 'invalid', reason: 'not a payout' };
  const comms = await communityForAccount(supabase, accountId);
  if (comms.length !== 1) {
    log.error(`[stripe_payouts] payout ${payout.id} on ${accountId}: ${comms.length} communities use this account; not staged`);
    return { action: 'unknown_account', communities: comms.length };
  }
  const community = comms[0];
  if (!stripeLib || typeof stripeLib.listPayoutComponents !== 'function') throw new Error('stripe payout listing not available');
  const r = await stripeLib.listPayoutComponents(accountId, payout.id);
  // A Stripe error throws, so the webhook answers 500 and Stripe re-delivers later.
  if (!r.ok) throw new Error(`[stripe_payouts] payout ${payout.id}: components not available (${r.error})`);

  const pis = [...new Set(r.components.map((c) => c.payment_intent_id).filter(Boolean))];
  const groups = [...new Set(r.components.map((c) => c.payment_group_id).filter(Boolean))];
  const payments = [];
  const SEL = 'id, community_id, payment_group_id, processor_payment_id, amount_cents, trusted_account_number';
  for (const ids of chunk(pis, 200)) {
    const { data, error } = await supabase.from('payments').select(SEL).eq('product_type', 'assessment_payment').eq('fee_type', 'assessment').in('processor_payment_id', ids);
    if (error) throw new Error(`[stripe_payouts] payment lookup failed: ${error.message}`);
    payments.push(...(data || []));
  }
  const have = new Set(payments.map((p) => p.payment_group_id));
  for (const ids of chunk(groups.filter((g) => !have.has(g)), 200)) {
    const { data, error } = await supabase.from('payments').select(SEL).eq('product_type', 'assessment_payment').eq('fee_type', 'assessment').in('payment_group_id', ids);
    if (error) throw new Error(`[stripe_payouts] payment lookup failed: ${error.message}`);
    payments.push(...(data || []));
  }

  const rows = buildPayoutRows({ payout, communityId: community.id, components: r.components, payments });
  for (const part of chunk(rows, 500)) {
    const { error } = await supabase.from('bank_rec_payouts').upsert(part, { onConflict: 'balance_txn_id', ignoreDuplicates: true });
    if (error) throw new Error(`[stripe_payouts] staging failed: ${error.message}`);
  }
  const net = rows.reduce((s, x) => s + Number(x.amount_cents), 0);
  const unresolved = rows.filter((x) => x.resolution !== 'tied').length;
  const ties = net === Number(payout.amount);
  if (!ties) log.error(`[stripe_payouts] payout ${payout.id}: components net ${net} but the payout is ${payout.amount}`);
  if (unresolved) log.warn(`[stripe_payouts] payout ${payout.id}: ${unresolved} component(s) not tied to a payment`);
  return { action: 'staged', payout_id: payout.id, community_id: community.id, components: rows.length, tied: rows.length - unresolved, unresolved,
    net_cents: net, payout_amount_cents: Number(payout.amount), ties };
}

async function failPayout({ supabase, log = console }, payout, accountId) {
  if (!payout || !payout.id) return { action: 'invalid' };
  const comms = await communityForAccount(supabase, accountId);
  if (comms.length !== 1) return { action: 'unknown_account', communities: comms.length };
  const { data, error } = await supabase.from('bank_rec_payouts').update({ payout_status: 'failed',
    resolution_note: `payout failed: ${String(payout.failure_message || payout.failure_code || 'no reason given').slice(0, 300)}` })
    .eq('community_id', comms[0].id).eq('processor_payout_id', payout.id).select('id');
  if (error) throw new Error(`[stripe_payouts] could not mark payout ${payout.id} failed: ${error.message}`);
  log.error(`[stripe_payouts] payout ${payout.id} FAILED (${payout.failure_code || 'no code'}); ${(data || []).length} staged row(s) marked failed`);
  return { action: 'failed', payout_id: payout.id, rows: (data || []).length };
}

module.exports = { stagePayout, failPayout, buildPayoutRows, STRIPE_SOURCE };
