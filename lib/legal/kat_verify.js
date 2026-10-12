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
  const lineIds = [...new Set(plan.postings.flatMap((p) => p.ap_invoice_line_ids || []))];
  const lineAccount = lineIds.length ? new Map(must(await supabase.from('ap_invoice_lines').select('id, gl_account_id').in('id', lineIds), 'invoice lines').map((l) => [l.id, l.gl_account_id])) : new Map();
  for (const a of [...lineAccount.values()]) if (a && !accounts.has(a)) {
    const extra = must(await supabase.from('chart_of_accounts').select('id, account_number, account_name').eq('id', a), 'accounts');
    if (extra[0]) accounts.set(extra[0].id, extra[0]);
  }
  const isAp = (a) => !!a && (/^(2000|20100)$/.test(String(a.account_number)) || /accounts payable/i.test(a.account_name || ''));

  const total = plan.totals.homeowner_cents + plan.totals.association_cents + plan.totals.bedrock_cents;
  add('allocations reconcile to the invoice total', total === plan.invoice_total_cents, `${total} of ${plan.invoice_total_cents} cents`);

  plan.postings.forEach((p, i) => {
    const dr = accounts.get(p.debit_account_id); const cr = accounts.get(p.credit_account_id);
    const tag = `posting ${i + 1}`;
    if (p.kind === 'homeowner_chargeback') {
      add(`${tag}: debit is 1300 Accounts Receivable for a named property`, dr && String(dr.account_number) === '1300' && !!p.property_id, dr ? `${dr.account_number} ${dr.account_name}` : 'no account');
    }
    const origin0 = [...new Set((p.ap_invoice_line_ids || []).map((id) => lineAccount.get(id)).filter(Boolean))];
    if (plan.mode === 'direct') {
      // Direct to receivable: the amount is part of the invoice accrual (Cr AP), and the
      // invoice line is coded to a legal-expense account (where an unrecovered amount would go).
      add(`${tag}: credit is Accounts Payable (posted with the invoice accrual)`, isAp(cr), cr ? `${cr.account_number} ${cr.account_name}` : 'no account');
      const la = origin0.length === 1 ? accounts.get(origin0[0]) : null;
      add(`${tag}: the invoice line is coded to a legal-expense account`, la && /^5\d{3}$/.test(String(la.account_number)) && /legal|attorney/i.test(la.account_name || ''), la ? `${la.account_number} ${la.account_name}` : 'line not coded');
      add(`${tag}: balanced (one debit, one equal credit)`, Number(p.amount_cents) > 0 && p.debit_account_id && p.credit_account_id, `${p.amount_cents} cents`);
      return;
    }
    add(`${tag}: credit is a legal-expense account on this association's chart, never AP`, cr && !isAp(cr) && /^5\d{3}$/.test(String(cr.account_number)) && /legal|attorney/i.test(cr.account_name || ''), cr ? `${cr.account_number} ${cr.account_name}` : 'no account');
    // The recovery nets against the SAME account the invoice line accrued to, so
    // the statement shows net legal cost per account (5870 collections/DRV vs
    // 5860 corporate), the way the association's history and budget present it.
    const origin = [...new Set((p.ap_invoice_line_ids || []).map((id) => lineAccount.get(id)).filter(Boolean))];
    add(`${tag}: credit is the account the invoice line accrued to`, origin.length === 1 && origin[0] === p.credit_account_id, origin.length ? (accounts.get(origin[0]) ? `${accounts.get(origin[0]).account_number} ${accounts.get(origin[0]).account_name}` : origin[0]) : 'line not coded');
    add(`${tag}: balanced (one debit, one equal credit)`, Number(p.amount_cents) > 0 && p.debit_account_id && p.credit_account_id, `${p.amount_cents} cents`);
  });

  const dateProblems = plan.blocking.filter((b) => /posting date|closed through|open accounting period|cutover/i.test(b));
  add('posting date is valid (after accrual/cutover, open period)', !dateProblems.length, dateProblems[0] || plan.posting_date);

  const live = livePostings != null ? livePostings : await require('./treatment').livePostingsForInvoice(supabase, d.invoice.id);
  // Once the treatment is approved, its own postings are expected: the check becomes
  // "posted exactly once" (one live posting per planned posting), never a self-match.
  const approvedReview = !!(d.saved && d.saved.review && d.saved.review.status === 'approved');
  const expected = approvedReview ? plan.postings.length : 0;
  add(approvedReview ? 'posted exactly once (live postings match the approved treatment)' : 'no live posting already exists for this invoice', live === expected, `${live} live${approvedReview ? ` of ${expected} planned` : ''}`);

  const num = d.invoiceNumber || d.invoice.invoice_number;
  const propIds = [...new Set(plan.postings.map((p) => p.property_id).filter(Boolean))];
  let dupes = 0;
  if (num && propIds.length) {
    const rows = must(await supabase.from('homeowner_transactions').select('property_id, description, txn_type').in('property_id', propIds).eq('txn_type', 'charge'), 'owner charges');
    dupes = rows.filter((r) => String(r.description || '').includes(String(num))).length;
  }
  add(approvedReview ? 'no owner charged twice for this invoice' : 'no owner charge already carries this invoice number', approvedReview ? dupes <= propIds.length : dupes === 0, `${dupes} found`);

  const ownerProblems = plan.blocking.filter((b) => /current owner/i.test(b));
  add('each charged owner is the current owner', !ownerProblems.length, ownerProblems[0] || null);

  const verified = checks.every((c) => c.ok);
  return { verified, ready_for_owner_approval: verified && plan.ready, checks, posting_date: plan.posting_date, totals: plan.totals, blocking: plan.blocking };
}

// ---- Kat's verdict -------------------------------------------------------------
// Kat checks the accounting herself (she does not repeat Amanda): the original
// accrual, the coding of every invoice line, the totals, duplicates including
// an overlap with the conversion opening balances, the posting period and the
// owner-ledger wording. Her verdict is one of three states:
//   ready             accounting verified and every item is ready
//   needs_information a record is missing (e.g. old-system owner history)
//   needs_decision    an accounting correction or an open judgment
const S = require('./review_suggest');
async function katDecision(supabase, d, plan, verify) {
  const issues = [];
  // The plan's totals leave out lines still open, so reconcile the draft itself:
  // every line, open or not, must be allocated to the cent.
  const rec = S.reconcile(d.invoice.total_cents, (d.saved && d.saved.items) || []);
  const checks = verify.checks.filter((c) => !/allocations reconcile/.test(c.name));
  checks.unshift({ name: 'every invoice line allocated, to the cent', ok: rec.reconciled, detail: `${rec.allocated_cents} of ${rec.invoice_total_cents} cents` });
  if (!rec.reconciled) issues.push({ state: 'needs_decision', text: `Accounting: allocations total ${rec.allocated_cents} of ${rec.invoice_total_cents} cents` });
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || null });
  const num = d.invoiceNumber || d.invoice.invoice_number;

  // The original accrual: every debit to a legal-expense account, AP credited
  // exactly once for the invoice total, balanced.
  if (plan.accrual && plan.accrual.id) {
    const lines = must(await supabase.from('journal_entry_lines').select('debit_cents, credit_cents, chart_of_accounts(account_number, account_name)').eq('journal_entry_id', plan.accrual.id), 'accrual lines');
    let dr = 0, cr = 0, ap = 0; const odd = [];
    for (const l of lines) {
      const a = l.chart_of_accounts || {};
      dr += Number(l.debit_cents) || 0; cr += Number(l.credit_cents) || 0;
      if (Number(l.debit_cents) > 0 && !(/^5\d{3}$/.test(String(a.account_number)) && /legal|attorney/i.test(a.account_name || ''))) odd.push(`${a.account_number} ${a.account_name}`);
      if (Number(l.credit_cents) > 0 && /^(2000|20100)$/.test(String(a.account_number))) ap += Number(l.credit_cents);
    }
    add('accrual: every invoice line coded to a legal-expense account', !odd.length, odd.length ? `not legal: ${odd.join(', ')}` : 'all legal');
    add('accrual: AP credited once, for the invoice total', ap === Number(d.invoice.total_cents), `${ap} of ${d.invoice.total_cents} cents`);
    add('accrual: balanced', dr === cr && dr > 0, `${dr} / ${cr}`);
    if (odd.length) issues.push({ state: 'needs_decision', text: `Accounting correction: invoice line(s) coded to non-legal accounts (${odd.join(', ')})` });
  } else if (plan.mode === 'direct') {
    // Not accrued yet by design: the approval posts the accrual, owner fees straight to 1300.
    add('accrual posts with the approved treatment (owner fees direct to 1300, no expense-and-recovery)', !plan.blocking.some((b) => /Accounts Payable|uncoded|Code every invoice line/.test(b)), plan.blocking.find((b) => /Accounts Payable|Code every/.test(b)) || 'ready to post on approval');
  } else {
    add('accrual entry exists', false, 'no accrual');
    issues.push({ state: 'needs_information', text: 'The invoice has no accrual entry yet: code it in Payables first' });
  }

  // The proposed owner charges: one per invoice, property and category.
  const items = (d.saved && d.saved.items) || [];
  const charges = new Map();
  items.forEach((it) => (it.allocations || []).forEach((a) => {
    if (a.classification !== 'homeowner_recoverable' || !a.property_id) return;
    const key = `${a.property_id}|${a.charge_category}`;
    const c = charges.get(key) || { property_id: a.property_id, charge_category: a.charge_category, amount_cents: 0, description: S.ownerDescription(a.charge_category, num), limitation: null };
    c.amount_cents += Number(a.amount_cents) || 0;
    const o = S.amandaOutcome(a); if (o && o.limitation) c.limitation = o.limitation;
    charges.set(key, c);
  }));

  // Overlap with the conversion: work billed before the GL cutover may already
  // sit, unitemised, in an owner's opening balance carried from the old system.
  const comm = must(await supabase.from('communities').select('gl_cutover_date').eq('id', d.invoice.community_id), 'community')[0] || {};
  const cutover = comm.gl_cutover_date ? String(comm.gl_cutover_date).slice(0, 10) : null;
  const invDate = d.invoice.invoice_date ? String(d.invoice.invoice_date).slice(0, 10) : null;
  const ownerProps = [...new Set(items.flatMap((it) => (it.allocations || []).filter((a) => a.property_id && ['homeowner_recoverable', 'needs_review'].includes(a.classification)).map((a) => a.property_id)))];
  if (cutover && invDate && invDate < cutover && ownerProps.length) {
    const rows = must(await supabase.from('homeowner_transactions').select('property_id, description, charge_category').in('property_id', ownerProps).ilike('description', 'Opening balance%'), 'opening balances');
    const withLegal = [...new Set(rows.filter((r) => /legal|attorney/i.test(r.description || '') || /^attorney_fee/.test(r.charge_category || '')).map((r) => r.property_id))];
    add('no overlap with conversion opening balances', !withLegal.length, withLegal.length ? `${withLegal.length} owner(s) carry legal fees in the opening balance` : 'none');
    if (withLegal.length) issues.push({ state: 'needs_information', text: `Old-system owner history: invoice ${num} (${invDate}) predates the ${cutover} cutover and ${withLegal.length} owner(s) carry unitemised legal fees in their opening balance. Confirm in the Vantaca owner history that this invoice was not already billed back.`, property_ids: withLegal });
  }

  for (const c of verify.checks.filter((x) => !x.ok && !/allocations reconcile/.test(x.name))) {
    if (/balanced|credit is|debit is/i.test(c.name)) issues.push({ state: 'needs_decision', text: `Accounting: ${c.name} (${c.detail || ''})` });
    else if (/owner charge already carries|live posting|posted exactly once|charged twice/i.test(c.name)) issues.push({ state: 'needs_decision', text: `Possible duplicate: ${c.name} (${c.detail || ''})` });
    else if (/posting date/i.test(c.name)) issues.push({ state: 'needs_decision', text: `Posting period: ${c.detail || c.name}` });
  }

  // Anything else the plan itself blocks on (a stale draft, a missing review) is
  // named, never left as a bare "not ready".
  if (!plan.ready) {
    for (const b of plan.blocking.filter((x) => !/^Item \d+:/.test(x) && !/allocations do not add up|Treatment totals/.test(x))) {
      issues.push({ state: /Save a reviewed draft|no accrual entry|changed since/i.test(b) ? 'needs_information' : 'needs_decision', text: b });
    }
  }
  const tally = { ready: 0, needs_information: 0, needs_decision: 0 };
  items.forEach((it) => { tally[S.decisionOf(it).state] += 1; });
  const accountingOk = !issues.some((i) => i.state === 'needs_decision');
  const state = issues.some((i) => i.state === 'needs_decision') || tally.needs_decision ? 'needs_decision'
    : issues.some((i) => i.state === 'needs_information') || tally.needs_information ? 'needs_information'
    : plan.ready && verify.verified ? 'ready' : 'needs_decision';
  const summary = state === 'ready'
    ? `Ready for owner approval: ${[...charges.values()].length} owner charge(s), accounting verified`
    : `${accountingOk ? 'Accounting verified' : 'Accounting issue'}; open: ${[tally.needs_decision ? `${tally.needs_decision} item(s) need a decision` : '', tally.needs_information ? `${tally.needs_information} need information` : '', ...issues.map((i) => i.text)].filter(Boolean).slice(0, 3).join('; ')}`;
  return { state, summary, issues, checks, items: tally, charges: [...charges.values()], cutover, accounting_ok: accountingOk };
}

module.exports = { verifyTreatment, katDecision };
