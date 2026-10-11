// ============================================================================
// lib/accounting/homeowner_charge.js  (Ed 2026-08-30)
// ----------------------------------------------------------------------------
// Post a NATIVE charge onto a homeowner's account (the trustEd ledger,
// `homeowner_transactions`) — the going-forward way to add a charge for a
// community that is on this ledger (Waterview and every not-yet-on-the-ar_engine
// community). It mirrors the exact pattern the transfer-proration path already
// uses: a committed upload batch, the account identity carried from the
// property's existing lines, and a running balance = prior balance + this charge.
//
// This is the one sanctioned helper for a native owner charge, so a second
// caller (legal bill-back) can't drift from how proration does it. It writes the
// SUBLEDGER only; the GL side is the caller's (a bill-back debits 1300 / credits
// AP; an assessment debits AR / credits revenue).
// ============================================================================

const { BEDROCK_MGMT_CO_ID } = require('../company');
const { currentLedgerIdentity, committedAccountBalance } = require('../ar/ledger_identity');

async function postHomeownerCharge(supabase, opts) {
  if (!Number.isFinite(opts && opts.amountCents) || opts.amountCents <= 0) throw new Error('positive amountCents required');
  return postLine(supabase, Object.assign({}, opts, { txnType: 'charge' }));
}

// The offsetting line for a documented correction (e.g. a legal chargeback
// reversed): a negative adjustment, never a deletion of the original charge.
async function postHomeownerCredit(supabase, opts) {
  if (!Number.isFinite(opts && opts.amountCents) || opts.amountCents <= 0) throw new Error('positive amountCents required');
  return postLine(supabase, Object.assign({}, opts, { txnType: 'adjustment', chargeCategory: 'adjustment', amountCents: -opts.amountCents }));
}

async function postLine(supabase, {
  communityId, propertyId, transactionDate, description, chargeCategory, amountCents, notes = null, raw = null, txnType,
}) {
  if (!supabase) throw new Error('supabase required');
  if (!communityId || !propertyId) throw new Error('communityId + propertyId required');
  const txnDate = String(transactionDate || new Date().toISOString().slice(0, 10)).slice(0, 10);

  // Account identity = the property's CURRENT tenure (the key every reader
  // uses), never the most recent ledger line (which can be a prior owner's).
  const ident = await currentLedgerIdentity(supabase, propertyId);
  const trusted = ident.trusted_account_number;
  const vantaca = ident.vantaca_account_id;
  const contactId = ident.contact_id;

  // Running balance base = this account's committed ledger (same as the view).
  const currentBal = await committedAccountBalance(supabase, communityId, vantaca);

  const { data: comm } = await supabase.from('communities').select('management_company_id').eq('id', communityId).maybeSingle();
  const { data: batch, error: bErr } = await supabase.from('transaction_upload_batches').insert({
    management_company_id: (comm && comm.management_company_id) || BEDROCK_MGMT_CO_ID,
    community_id: communityId, period_label: String(description || 'Charge').slice(0, 60), as_of_date: txnDate,
    source_format: 'manual', status: 'committed', uploaded_by: 'trusted_native_charge',
    row_count: 1, account_count: 1, total_charges_cents: amountCents > 0 ? amountCents : 0, total_payments_cents: 0,
    min_transaction_date: txnDate, max_transaction_date: txnDate, committed_at: new Date().toISOString(),
    notes: notes || description,
  }).select('id').single();
  if (bErr) throw bErr;

  const { data: txn, error: tErr } = await supabase.from('homeowner_transactions').insert({
    source_batch_id: batch.id, source_row_index: 0, community_id: communityId, property_id: propertyId,
    contact_id: contactId, trusted_account_number: trusted, vantaca_account_id: vantaca,
    transaction_date: txnDate, description, txn_type: txnType, charge_category: chargeCategory,
    amount_cents: amountCents, running_balance_cents: currentBal + amountCents, is_operator_override: true,
    notes: notes || null, raw_row_jsonb: raw || null,
  }).select('id').single();
  if (tErr) throw tErr;

  return { chargeId: txn.id, batchId: batch.id, newBalanceCents: currentBal + amountCents };
}

module.exports = { postHomeownerCharge, postHomeownerCredit };
