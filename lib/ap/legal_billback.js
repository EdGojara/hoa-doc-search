// ============================================================================
// lib/ap/legal_billback.js  (Ed 2026-08-30)
// ----------------------------------------------------------------------------
// Post an attorney invoice as a BILL-BACK to the homeowner, not an association
// expense. A recoverable collection/DRV legal cost is the owner's cost that the
// association is fronting, so it is a RECEIVABLE, never a P&L expense. Running it
// through expense (as we do today) inflates then deflates 5870 and makes the
// legal-fee budget-vs-actual meaningless.
//
//   GL:            DR 1300 Accounts Receivable  /  CR 20100/2000 Accounts Payable
//   Owner ledger:  a homeowner_transactions charge, charge_category 'attorney_fee',
//                  described "Legal Fees - Collections/DRV - Legal Fees / <inv#>"
//                  — matching the exact format already on Waterview accounts.
//
// The check-cut (DR AP / CR Cash) and the two-key approval are unchanged. When
// the owner pays, the payment clears 1300; a legal cost only ever hits the P&L
// if it is later written off as uncollectible.
// ============================================================================

const { postHomeownerCharge } = require('../accounting/homeowner_charge');

async function _resolveAccountId(supabase, communityId, numbers) {
  for (const n of numbers) {
    const { data } = await supabase.from('chart_of_accounts').select('id').eq('community_id', communityId).eq('account_number', n).eq('is_active', true).maybeSingle();
    if (data) return data.id;
  }
  return null;
}

// opts.postJE is injectable for tests; defaults to the real GL poster.
async function postLegalBillBack(supabase, {
  communityId, propertyId, totalCents, vendorInvoiceNumber, vendorName, invoiceDate, invoiceId,
}, opts = {}) {
  if (!supabase) throw new Error('supabase required');
  if (!communityId || !propertyId) throw new Error('communityId + propertyId required (which owner to bill)');
  if (!Number.isFinite(totalCents) || totalCents <= 0) throw new Error('positive totalCents required');

  const arId = await _resolveAccountId(supabase, communityId, ['1300']);
  const apId = await _resolveAccountId(supabase, communityId, ['20100', '2000']);
  if (!arId) throw new Error('Accounts Receivable (1300) not found for community');
  if (!apId) throw new Error('Accounts Payable account not found for community');

  const postJE = opts.postJE || require('../accounting/posting').postJournalEntry;
  const je = await postJE({
    community_id: communityId, posting_date: String(invoiceDate || new Date().toISOString()).slice(0, 10),
    description: `Attorney bill-back ${vendorInvoiceNumber || ''} — ${vendorName || 'attorney'}`.trim(),
    source_module: 'ap_billback', source_reference: invoiceId || null,
    lines: [
      { account_id: arId, debit_cents: totalCents, credit_cents: 0, memo: `Legal bill-back Inv ${vendorInvoiceNumber || ''}`.trim() },
      { account_id: apId, debit_cents: 0, credit_cents: totalCents, memo: `AP — ${vendorName || 'attorney'}`.trim() },
    ],
  });

  const charge = await postHomeownerCharge(supabase, {
    communityId, propertyId, transactionDate: String(invoiceDate || new Date().toISOString()).slice(0, 10),
    description: `Legal Fees - Collections/DRV - Legal Fees / ${vendorInvoiceNumber || ''}`.trim(),
    chargeCategory: 'attorney_fee', amountCents: totalCents,
    notes: `Attorney bill-back, invoice ${vendorInvoiceNumber || ''}`.trim(),
  });

  return { jeId: je && je.entry && je.entry.id, chargeId: charge.chargeId, arAccountId: arId, apAccountId: apId };
}

module.exports = { postLegalBillBack, _resolveAccountId };
