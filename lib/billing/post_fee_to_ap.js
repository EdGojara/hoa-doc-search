// ============================================================================
// lib/billing/post_fee_to_ap.js
// ----------------------------------------------------------------------------
// Post a Bedrock invoice (our own management/activity bill) into the
// ASSOCIATION's Accounts Payable, so the association pays Bedrock. This is the
// other side of the invoices table: Bedrock's AR ↔ the association's AP.
//
// Ed 2026-08-25: approve the package by email → Tessa posts it to AP. HARD
// CUTOFF at 2026-08-01: invoices for periods before the cutoff, and communities
// whose books stayed in Vantaca (books_of_record <> 'trusted', e.g. Eaglewood),
// do NOT post here — Vantaca handles those. New bills for trustEd-books
// communities post to trustEd AP.
//
// Reuses the normal AP engine, so the payable lands AWAITING_APPROVAL and posts
// its accrual JE exactly like any bill. Idempotent: the (community, vendor,
// vendor_invoice_number) unique constraint makes a double-post impossible, and
// we pre-check it for a clean skip.
// ============================================================================

const CUTOFF_DATE = '2026-08-01';                 // hard cutover to trustEd books
const { BEDROCK_MGMT_CO_ID } = require('../company');
const BEDROCK_PAYEE_NAME = 'Bedrock Association Management';

// The association's expense account for the management fee. Prefer an exact
// "Management Fees" account; fall back to the closest management/admin expense;
// null lets the AP engine auto-code and flag for review.
async function findManagementFeeAccount(supabase, communityId) {
  const { data } = await supabase.from('chart_of_accounts')
    .select('id, account_number, account_name')
    .eq('community_id', communityId).eq('account_type', 'expense')
    .eq('is_active', true).eq('is_summary', false)
    .limit(500);
  const accounts = data || [];
  const pick = (re) => accounts.find((a) => re.test(String(a.account_name || '')));
  return (pick(/management\s*fee/i) || pick(/\bmanagement\b/i) || pick(/administrativ/i) || null);
}

// Bedrock as a PAYEE in the association's vendor list (mgmt-co level, shared).
async function findOrCreateBedrockPayee(supabase) {
  const { data: existing } = await supabase.from('vendors')
    .select('id, name')
    .eq('management_company_id', BEDROCK_MGMT_CO_ID)
    // "Bedrock Association Management" or "..., LLC" (the record that exists): never a second payee.
    .ilike('name', `${BEDROCK_PAYEE_NAME}%`).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (existing) return existing;
  const { data: created, error } = await supabase.from('vendors').insert({
    management_company_id: BEDROCK_MGMT_CO_ID,
    name: BEDROCK_PAYEE_NAME, payee_name: BEDROCK_PAYEE_NAME,
    category: 'Management', is_active: true, is_1099_vendor: false, payment_terms_days: 0,
  }).select('id, name').single();
  if (error) { console.warn('[post_fee_to_ap] payee create failed:', error.message); return null; }
  return created;
}

/**
 * Post one Bedrock invoice into the association's AP. Returns a result object;
 * never throws for a business skip (pre-cutoff, Vantaca books, already posted).
 */
async function postBedrockInvoiceToAP(supabase, { invoiceId, approvedBy }) {
  const { data: inv, error } = await supabase.from('invoices')
    .select('id, community_id, invoice_number, invoice_type, service_period_start, total, status')
    .eq('id', invoiceId).maybeSingle();
  if (error) throw error;
  if (!inv) return { invoiceId, skipped: true, reason: 'invoice_not_found' };

  // Cutoff by the invoice's own service period. A package can mix a post-cutoff
  // management fee (→ trustEd) and a pre-cutoff activity bill (→ Vantaca).
  if (!inv.service_period_start || inv.service_period_start < CUTOFF_DATE) {
    return { invoiceId, invoice_number: inv.invoice_number, skipped: true, reason: 'pre_cutoff_goes_to_vantaca', period: inv.service_period_start };
  }

  const { data: comm } = await supabase.from('communities')
    .select('id, name, books_of_record').eq('id', inv.community_id).maybeSingle();
  if (!comm) return { invoiceId, skipped: true, reason: 'community_not_found' };
  if ((comm.books_of_record || 'trusted') !== 'trusted') {
    return { invoiceId, invoice_number: inv.invoice_number, skipped: true, reason: `books_in_${comm.books_of_record}_goes_to_vantaca` };
  }

  const totalCents = Math.round(Number(inv.total || 0) * 100);   // invoices.total is DOLLARS
  if (totalCents <= 0) return { invoiceId, invoice_number: inv.invoice_number, skipped: true, reason: 'zero_total' };

  const payee = await findOrCreateBedrockPayee(supabase);
  if (!payee) return { invoiceId, skipped: true, reason: 'no_payee' };

  // Idempotency: the AP (community, vendor, vendor_invoice_number) unique
  // constraint makes a double-post impossible; pre-check for a clean skip.
  const { data: existingAp } = await supabase.from('ap_invoices')
    .select('id').eq('community_id', inv.community_id).eq('vendor_id', payee.id)
    .eq('vendor_invoice_number', inv.invoice_number).maybeSingle();
  if (existingAp) return { invoiceId, invoice_number: inv.invoice_number, skipped: true, reason: 'already_posted', ap_invoice_id: existingAp.id };

  const glId = await findManagementFeeAccount(supabase, inv.community_id);
  const label = inv.invoice_type === 'activity' ? 'Bedrock activity & reimbursables' : 'Bedrock management fee';
  // Split by the contract (Ed 2026-10-14): one AP line per Bedrock invoice line, each coded by the
  // community's contract line rules (vendor_line_rules: management fee, onsite staff, website). A
  // line no rule codes falls back to the management-fee account and is flagged by the AP engine.
  // The lines must add to the invoice total, or the bill posts as before (one line) and says why.
  const LR = require('../ap/line_rules');
  const rules = await LR.loadRules(supabase, { communityId: inv.community_id, vendorId: payee.id });
  const { data: items } = await supabase.from('invoice_line_items').select('description, amount, sort_order').eq('invoice_id', inv.id).order('sort_order', { ascending: true }).limit(200);
  let lines = null;
  if (rules.length && items && items.length) {
    const split = items.map((li) => { const r = LR.ruleForLine(rules, li.description); return { description: `${li.description} — ${inv.invoice_number}`, amount_cents: Math.round(Number(li.amount || 0) * 100), gl_account_id: (r && !r.ambiguous && r.gl_account_id) || (glId ? glId.id : null) }; }).filter((l) => l.amount_cents !== 0);
    if (split.reduce((t, l) => t + l.amount_cents, 0) === totalCents) lines = split;
    else console.warn('[post_fee_to_ap] line items do not add to the invoice total; posting one line', { invoice: inv.invoice_number, total_cents: totalCents });
  }
  const { createInvoice } = require('../accounting/ap_engine');
  try {
    const result = await createInvoice({
      community_id: inv.community_id,
      vendor_id: payee.id,
      vendor_invoice_number: inv.invoice_number,
      invoice_date: new Date().toISOString().slice(0, 10),
      subtotal_cents: totalCents,
      total_cents: totalCents,
      lines: lines || [{
        description: `${label} — ${inv.invoice_number} (${inv.service_period_start})`,
        amount_cents: totalCents,
        gl_account_id: glId ? glId.id : null,   // null → auto-code + flag for review
      }],
      notes: `Bedrock ${inv.invoice_type} invoice ${inv.invoice_number}, approved by ${approvedBy || 'Ed'} via email. Posted to the association's AP for payment.`,
    });
    return { invoiceId, invoice_number: inv.invoice_number, posted: true, community: comm.name, amount_cents: totalCents, ap_invoice_id: result && result.invoice ? result.invoice.id : null, coded: glId ? `${glId.account_number} ${glId.account_name}` : 'auto (needs review)' };
  } catch (e) {
    // Unique-constraint race → already posted; anything else is a real error.
    if (/duplicate key|unique/i.test(e.message || '')) return { invoiceId, invoice_number: inv.invoice_number, skipped: true, reason: 'already_posted_race' };
    throw e;
  }
}

module.exports = { postBedrockInvoiceToAP, CUTOFF_DATE };
