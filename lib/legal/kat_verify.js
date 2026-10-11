// ============================================================================
// lib/legal/kat_verify.js — Kat's accounting verification of a legal treatment
// (Ed 2026-10-11)
// ----------------------------------------------------------------------------
// Kat checks the treatment the plan would post (lib/legal/treatment.js
// planTreatment) before it can be put in front of the owner:
//
//   - each homeowner recovery debits 1300 Accounts Receivable for a named
//     property and credits the invoice line's own legal-expense account
//     (5870 / 5860); nothing ever credits Accounts Payable again
//   - every entry balances (one debit, one equal credit)
//   - the posting date is not before the accrual or GL cutover and falls in an
//     open period (the plan's own blocking reasons)
//   - the allocations reconcile to the invoice total to the cent
//   - nothing is posted twice: no live posting for the invoice already, and no
//     owner charge already carrying this invoice number
//
// Read-only. Kat recommends; posting still requires the owner's Approve
// Treatment (migration 508 controls).
// ============================================================================
const must = (r, what) => { if (r && r.error) throw Object.assign(new Error(`${what}: ${r.error.message}`), { cause: r.error }); return (r && r.data) || []; };

async function verifyTreatment(supabase, d, plan, { livePostings } = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || null });

  const ids = [...new Set(plan.postings.flatMap((p) => [p.debit_account_id, p.credit_account_id]).filter(Boolean))];
  const accounts = ids.length ? new Map(must(await supabase.from('chart_of_accounts').select('id, account_number, account_name').in('id', ids), 'accounts').map((a) => [a.id, a])) : new Map();
  const isAp = (a) => !!a && (/^(2000|20100)$/.test(String(a.account_number)) || /accounts payable/i.test(a.account_name || ''));

  const total = plan.totals.homeowner_cents + plan.totals.association_cents + plan.totals.bedrock_cents;
  add('allocations reconcile to the invoice total', total === plan.invoice_total_cents, `${total} of ${plan.invoice_total_cents} cents`);

  plan.postings.forEach((p, i) => {
    const dr = accounts.get(p.debit_account_id); const cr = accounts.get(p.credit_account_id);
    const tag = `posting ${i + 1}`;
    if (p.kind === 'homeowner_chargeback') {
      add(`${tag}: debit is 1300 Accounts Receivable for a named property`, dr && String(dr.account_number) === '1300' && !!p.property_id, dr ? `${dr.account_number} ${dr.account_name}` : 'no account');
    }
    add(`${tag}: credit is the line's legal-expense account, never AP`, cr && !isAp(cr) && /^5\d{3}$/.test(String(cr.account_number)), cr ? `${cr.account_number} ${cr.account_name}` : 'no account');
    add(`${tag}: balanced (one debit, one equal credit)`, Number(p.amount_cents) > 0 && p.debit_account_id && p.credit_account_id, `${p.amount_cents} cents`);
  });

  const dateProblems = plan.blocking.filter((b) => /posting date|closed through|open accounting period|cutover/i.test(b));
  add('posting date is valid (after accrual/cutover, open period)', !dateProblems.length, dateProblems[0] || plan.posting_date);

  const live = livePostings != null ? livePostings : await require('./treatment').livePostingsForInvoice(supabase, d.invoice.id);
  add('no live posting already exists for this invoice', live === 0, `${live} live`);

  const num = d.invoiceNumber || d.invoice.invoice_number;
  const propIds = [...new Set(plan.postings.map((p) => p.property_id).filter(Boolean))];
  let dupes = 0;
  if (num && propIds.length) {
    const rows = must(await supabase.from('homeowner_transactions').select('property_id, description, txn_type').in('property_id', propIds).eq('txn_type', 'charge'), 'owner charges');
    dupes = rows.filter((r) => String(r.description || '').includes(String(num))).length;
  }
  add('no owner charge already carries this invoice number', dupes === 0, `${dupes} found`);

  const ownerProblems = plan.blocking.filter((b) => /current owner/i.test(b));
  add('each charged owner is the current owner', !ownerProblems.length, ownerProblems[0] || null);

  const verified = checks.every((c) => c.ok);
  return { verified, ready_for_owner_approval: verified && plan.ready, checks, posting_date: plan.posting_date, totals: plan.totals, blocking: plan.blocking };
}

module.exports = { verifyTreatment };
