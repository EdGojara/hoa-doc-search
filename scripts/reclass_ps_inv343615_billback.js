#!/usr/bin/env node
// ============================================================================
// scripts/reclass_ps_inv343615_billback.js  (Ed 2026-08-31)
// ----------------------------------------------------------------------------
// Enter the $42 RMWBH invoice PS-INV343615 as a recoverable legal-fee bill-back
// on the Martinez homeowner account, IN AUGUST (we record a bill when we get it,
// not backdated to its June print date), with NO void (a system miscoding is
// corrected in place, never stamped "VOIDED").
//
// The correct August entry depends on what's already on the books, so this
// DETECTS it and does the right thing:
//
//   * No accrual posted yet (the June-dated accrual bounced on a closed period)
//       -> enter FRESH:   DR 1300 Accounts Receivable / CR AP  + owner charge
//   * A 5870 accrual is already posted (DR 5870 / CR AP)
//       -> RECLASS:       DR 1300 Accounts Receivable / CR 5870 + owner charge
//         (moves the expense to a receivable; AP untouched, no void)
//
// Either way: Martinez is charged 'attorney_fee' $42 described
// "Legal Fees - Collections/DRV - Legal Fees / PS-INV343615", AP shows RMWBH
// payable, expense ends at zero, all dated August. Requires migration 402
// (the 'ap_billback' source_module) — APPLY 402 FIRST.
//
// SAFE BY DEFAULT: dry-run prints the plan + which path; --commit posts.
//   node scripts/reclass_ps_inv343615_billback.js            # dry run
//   node scripts/reclass_ps_inv343615_billback.js --commit   # do it
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const { postJournalEntry, resolveOpenPeriod } = require('../lib/accounting/posting');
const { postHomeownerCharge } = require('../lib/accounting/homeowner_charge');
const { postLegalBillBack } = require('../lib/ap/legal_billback');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const INVOICE_NUMBER = 'PS-INV343615';
const OWNER_ACCOUNT = '1008671127';           // Martinez, 5922 Spring Sunrise Drive
const COMMIT = process.argv.includes('--commit');
const money = (c) => '$' + (Number(c || 0) / 100).toFixed(2);

async function acct(community_id, number) {
  const { data } = await supabase.from('chart_of_accounts')
    .select('id, account_number, account_name').eq('community_id', community_id)
    .eq('account_number', number).eq('is_active', true).maybeSingle();
  return data;
}

(async () => {
  const { data: inv, error: invErr } = await supabase.from('ap_invoices')
    .select('*').eq('vendor_invoice_number', INVOICE_NUMBER).maybeSingle();
  if (invErr) throw invErr;
  if (!inv) throw new Error(`invoice ${INVOICE_NUMBER} not found`);
  if (inv.status === 'paid') throw new Error('invoice already PAID — adjust, do not reclass');

  const { data: prop, error: propErr } = await supabase.from('properties')
    .select('id, street_address, trusted_account_number, community_id')
    .eq('community_id', inv.community_id).eq('trusted_account_number', OWNER_ACCOUNT).maybeSingle();
  if (propErr) throw propErr;
  if (!prop) throw new Error(`property acct ${OWNER_ACCOUNT} not found in community ${inv.community_id}`);

  const ar = await acct(inv.community_id, '1300');
  const exp = await acct(inv.community_id, '5870');
  if (!ar) throw new Error('1300 Accounts Receivable not found');
  if (!exp) throw new Error('5870 Legal Fees - Collections/DRV not found');

  // Detect: is there a LIVE accrual that already debited 5870 for this invoice?
  let accrualOn5870 = false;
  if (inv.posting_journal_entry_id) {
    const { data: je } = await supabase.from('journal_entries')
      .select('id, status').eq('id', inv.posting_journal_entry_id).maybeSingle();
    if (je && je.status !== 'voided') {
      const { data: lines } = await supabase.from('journal_entry_lines')
        .select('account_id, debit_cents').eq('journal_entry_id', je.id);
      accrualOn5870 = (lines || []).some((l) => l.account_id === exp.id && Number(l.debit_cents) > 0);
    }
  }
  const path = accrualOn5870 ? 'reclass' : 'fresh';

  const today = new Date().toISOString().slice(0, 10);   // August
  const open = await resolveOpenPeriod(inv.community_id, today);

  console.log('\n=== Enter PS-INV343615 as a Martinez legal bill-back (August, no void) ===');
  console.log(`Invoice   : ${inv.vendor_invoice_number}  ${money(inv.total_cents)}  status=${inv.status}  invoice_date=${inv.invoice_date}`);
  console.log(`Bill to   : ${prop.street_address}  (acct ${prop.trusted_account_number})`);
  console.log(`Post date : ${today}  (open period: ${open ? 'yes' : 'NO'})`);
  console.log(`State     : ${accrualOn5870 ? 'a 5870 accrual is already posted' : 'no accrual posted yet'}`);
  console.log(path === 'reclass'
    ? `Action    : RECLASS  DR 1300 ${ar.account_name} / CR 5870 ${exp.account_name}  ${money(inv.total_cents)}  + owner charge`
    : `Action    : FRESH    DR 1300 ${ar.account_name} / CR AP  ${money(inv.total_cents)}  + owner charge`);

  if (!open) throw new Error('today is not in an open period — open August first');
  if (!COMMIT) { console.log('\nDRY RUN — nothing changed. Re-run with --commit to apply.\n'); return; }

  if (path === 'reclass') {
    // Move the already-booked expense to a receivable — no void, AP untouched.
    const je = await postJournalEntry({
      community_id: inv.community_id, posting_date: today,
      description: `Reclass ${INVOICE_NUMBER} to homeowner legal bill-back — ${prop.street_address} (acct ${OWNER_ACCOUNT})`,
      source_module: 'ap_billback', source_reference: inv.id,
      lines: [
        { account_id: ar.id, debit_cents: inv.total_cents, credit_cents: 0, memo: `Legal bill-back Inv ${INVOICE_NUMBER}`, vendor_id: inv.vendor_id },
        { account_id: exp.id, debit_cents: 0, credit_cents: inv.total_cents, memo: `Reclass off 5870 — Inv ${INVOICE_NUMBER}`, vendor_id: inv.vendor_id },
      ],
    });
    console.log(`Posted reclass JE ${je.entry.id}.`);
    const charge = await postHomeownerCharge(supabase, {
      communityId: inv.community_id, propertyId: prop.id, transactionDate: today,
      description: `Legal Fees - Collections/DRV - Legal Fees / ${INVOICE_NUMBER}`,
      chargeCategory: 'attorney_fee', amountCents: inv.total_cents,
      notes: `Attorney bill-back, invoice ${INVOICE_NUMBER}`,
    });
    console.log(`Posted owner charge ${charge.chargeId}.`);
  } else {
    // Nothing on the books — enter it fresh: DR 1300 / CR AP + owner charge,
    // dated August (invoiceDate passed as today so it lands in the open period).
    const res = await postLegalBillBack(supabase, {
      communityId: inv.community_id, propertyId: prop.id, totalCents: inv.total_cents,
      vendorInvoiceNumber: inv.vendor_invoice_number, vendorName: 'RMWBH',
      invoiceDate: today, invoiceId: inv.id,
    });
    console.log(`Posted bill-back JE ${res.jeId}; owner charge ${res.chargeId}.`);
    await supabase.from('ap_invoices').update({ posting_journal_entry_id: res.jeId }).eq('id', inv.id);
  }

  await supabase.from('ap_invoices').update({
    notes: [inv.notes, `Entered as Martinez legal bill-back (acct ${OWNER_ACCOUNT}) ${today} via ${path}; no void.`].filter(Boolean).join(' '),
  }).eq('id', inv.id);

  console.log('\nDone. $42 is a receivable from Martinez, not an expense. RMWBH still payable.\n');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
