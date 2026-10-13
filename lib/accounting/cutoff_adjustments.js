// ============================================================================
// lib/accounting/cutoff_adjustments.js  (Ed 2026-10-13: cutoff corrections for approval)
// ----------------------------------------------------------------------------
// Kat's cutoff review (lib/close, CUT-01 / CUT-03) finds bills booked in the wrong
// month. This turns those findings into balanced correcting entries that the OWNER
// approves in Kat's queue (an authenticated in-app approval, lib/accounting/
// monthly_runs.assertInAppApproval). Nothing posts at prepare time.
//
//   late bill (service in the month, booked later)
//     accrual   dated the month end: Dr each expense account of the original AP
//               entry / Cr Accrued Expenses
//     reversal  dated the 1st of the month the original AP entry is in: the exact
//               mirror, so that month carries the bill once (original minus reversal
//               = 0) and the service month carries it once (the accrual)
//   billed in advance (booked in the month, service after it)
//     deferral  dated the month end: Dr Prepaid Expenses / Cr the expense account
//     schedule  a prepaid_expense recognition schedule for the service months,
//               created as DRAFT and approved by the owner (the database requires an
//               approver: migration 466), then each due month recognized through
//               post_recognition_period
//   Accrued Expenses missing from the chart: an account addition the owner approves
//   by name, posted before the accruals (no existing account or mapping changes).
//
// The original invoice, its AP entry, vendor history and payments are never touched.
// Only expense lines move; non-expense lines on the bill (e.g. homeowner pass-through
// fees held in 2300) are listed as excluded. Holds say exactly what evidence is missing.
// ============================================================================

const day = (d) => String(d || '').slice(0, 10);
const firstOf = (d) => `${day(d).slice(0, 7)}-01`;
const addDays = (iso, n) => { const d = new Date(`${day(iso)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const lastOf = (d) => { const x = new Date(`${firstOf(d)}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1); x.setUTCDate(0); return x.toISOString().slice(0, 10); };
const monthsBetween = (a, b) => { const [ay, am] = day(a).split('-').map(Number); const [by, bm] = day(b).split('-').map(Number); return (by * 12 + bm) - (ay * 12 + am) + 1; };
const money = (c) => { const n = Number(c || 0) / 100; const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return n < 0 ? `($${s})` : `$${s}`; };
const ym = (d) => day(d).slice(0, 7);
const ACCRUED_NAME = /accrued expenses?/i;
const PREPAID_NAME = /prepaid expenses?/i;
const ACCRUED_CANDIDATES = ['2100', '2110', '2120', '2190'];

// Expense lines of the original AP entry, netted per account.
function expenseByAccount(lines) {
  const m = new Map();
  for (const l of lines || []) {
    if (l.account_type !== 'expense') continue;
    const v = Number(l.debit_cents || 0) - Number(l.credit_cents || 0);
    m.set(l.account_number, (m.get(l.account_number) || 0) + v);
  }
  return [...m.entries()].filter(([, v]) => v !== 0).map(([account_number, cents]) => ({ account_number, cents }));
}

/**
 * PURE. Build the proposals for one community and month.
 * facts = { period: {period_start, period_end}, late_bills, prepaid_bills (gatherCutoff shapes),
 *           invoices: {[id]: {..., source_storage_path, original: {id, reference, posting_date, status, lines:[{account_number, account_type, debit_cents, credit_cents}]}}},
 *           accounts: [{account_number, account_name, account_type, fund_code, is_active}],
 *           already: Set of source_reference strings already on the books, schedules_for: Set of invoice ids with a live schedule, today }
 */
function buildProposals(facts) {
  const P = facts.period; const E = day(P.period_end); const S = day(P.period_start);
  const acct = (n) => (facts.accounts || []).find((a) => a.account_number === n) || null;
  const items = []; const holds = []; const additions = [];
  let accrued = (facts.accounts || []).find((a) => a.account_type === 'liability' && a.is_active !== false && ACCRUED_NAME.test(a.account_name || ''));
  const prepaid = (facts.accounts || []).find((a) => a.account_type === 'asset' && a.is_active !== false && PREPAID_NAME.test(a.account_name || '') && (a.fund_code || 'OPR') === 'OPR');
  const needAccrued = () => {
    if (accrued) return accrued.account_number;
    const n = ACCRUED_CANDIDATES.find((x) => !acct(x));
    if (!n) return null;
    accrued = { account_number: n, account_name: 'Accrued Expenses', account_type: 'liability', fund_code: 'OPR', proposed: true };
    additions.push({ id: `account:${n}`, kind: 'account_addition', account_number: n, account_name: 'Accrued Expenses', account_type: 'liability', account_subtype: 'current_liability', normal_balance: 'credit', fund_code: 'OPR',
      text: `Add GL ${n} Accrued Expenses (Operating fund liability; the standard chart's 20200 Accrued Expenses). Expenses incurred in a month and billed after it are accrued here and reversed when the bill is booked. No existing account or mapping changes; it shows as unmapped on the balance sheet until an admin maps it.` });
    return n;
  };
  const evidenceOf = (b, inv) => ({ invoice_id: b.id, vendor: b.vendor, invoice_number: b.invoice_number, invoice_date: b.invoice_date, service_period_start: b.service_period_start, service_period_end: b.service_period_end,
    total_cents: b.total_cents, status: b.status, document_path: inv.source_storage_path || null, original_reference: inv.original && inv.original.reference, original_posting_date: inv.original && day(inv.original.posting_date) });

  for (const b of facts.late_bills || []) {
    const inv = (facts.invoices || {})[b.id] || {};
    const o = inv.original;
    const label = `${b.vendor} #${b.invoice_number || '?'}`;
    if (!o) { holds.push({ invoice_id: b.id, text: `${label}: not booked yet, so there is nothing to accrue and reverse; book it dated in ${ym(E)} when it is approved.` }); continue; }
    if (o.status !== 'posted') { holds.push({ invoice_id: b.id, text: `${label}: its AP entry ${o.reference} is ${o.status}, not posted.` }); continue; }
    if (day(o.posting_date) <= E) continue;   // booked in the month after all
    const src = `cutoff:${b.id}:accrue`;
    if ((facts.already || new Set()).has(src)) { holds.push({ invoice_id: b.id, text: `${label}: already accrued (${src}).`, already: true }); continue; }
    const exp = expenseByAccount(o.lines);
    if (!exp.length) { holds.push({ invoice_id: b.id, text: `${label}: the AP entry ${o.reference} has no expense lines to accrue.` }); continue; }
    const excluded = (o.lines || []).filter((l) => l.account_type !== 'expense' && Number(l.debit_cents || 0) > 0).map((l) => ({ account_number: l.account_number, cents: Number(l.debit_cents) }));
    const accNo = needAccrued();
    if (!accNo) { holds.push({ invoice_id: b.id, text: `${label}: no free account number for Accrued Expenses.` }); continue; }
    const total = exp.reduce((s, x) => s + x.cents, 0);
    const revDate = firstOf(o.posting_date);
    const accrual = { reference_hint: 'ACCR', posting_date: E, source_reference: src,
      description: `Cutoff accrual: ${label} (service ${b.service_period_start || b.invoice_date} to ${b.service_period_end || b.invoice_date}) recognized in ${ym(E)}`,
      lines: [...exp.map((x) => ({ account_number: x.account_number, debit_cents: x.cents, credit_cents: 0, memo: `${label} service ${b.service_period_start || ''} to ${b.service_period_end || ''}; booked ${day(o.posting_date)} as ${o.reference}` })),
        { account_number: accNo, debit_cents: 0, credit_cents: total, memo: `Accrued: ${label}` }] };
    const reversal = { reference_hint: 'REV', posting_date: revDate, source_reference: `cutoff:${b.id}:reverse`, reverses: 'accrual',
      description: `Reverse cutoff accrual for ${label}: the bill is booked in ${ym(revDate)} as ${o.reference}`,
      lines: [{ account_number: accNo, debit_cents: total, credit_cents: 0, memo: `Reverse accrual ${label}` }, ...exp.map((x) => ({ account_number: x.account_number, debit_cents: 0, credit_cents: x.cents, memo: `${label} is in ${o.reference}; counted once, in ${ym(E)}` }))] };
    // Verification against the original AP posting: the reversal mirrors the accrual account
    // by account, and the original month then nets to zero for exactly the moved lines.
    const mirror = exp.every((x) => reversal.lines.some((l) => l.account_number === x.account_number && l.credit_cents === x.cents)) && reversal.lines[0].debit_cents === total;
    const net = exp.map((x) => ({ account_number: x.account_number, original_cents: x.cents, reversal_cents: -x.cents, net_in_original_month_cents: 0 }));
    items.push({ id: `accrue:${b.id}`, kind: 'accrual', label, evidence: { ...evidenceOf(b, inv), excluded_lines: excluded }, entries: [accrual, reversal], amount_cents: total,
      effects: { [ym(E)]: total, [ym(revDate)]: -total },
      verification: { reversal_mirrors_accrual: mirror, original_month: ym(o.posting_date), reversal_month: ym(revDate), lines: net,
        text: `${o.reference} (${day(o.posting_date)}) keeps its ${money(total)} of expense; the reversal on ${revDate} removes exactly that from ${ym(revDate)}, so the expense is counted once, in ${ym(E)}.${excluded.length ? ` Not accrued (not expense): ${excluded.map((x) => `${x.account_number} ${money(x.cents)}`).join(', ')}.` : ''}` } });
  }

  for (const b of facts.prepaid_bills || []) {
    const inv = (facts.invoices || {})[b.id] || {};
    const o = inv.original;
    const label = `${b.vendor} #${b.invoice_number || '?'}`;
    if (!o || o.status !== 'posted') { holds.push({ invoice_id: b.id, text: `${label}: its AP entry is not posted.` }); continue; }
    if (day(o.posting_date) < S || day(o.posting_date) > E) continue;
    const src = `cutoff:${b.id}:defer`;
    if ((facts.already || new Set()).has(src) || (facts.schedules_for || new Set()).has(b.id)) { holds.push({ invoice_id: b.id, text: `${label}: already deferred or scheduled.`, already: true }); continue; }
    if (!b.service_period_start || !b.service_period_end) { holds.push({ invoice_id: b.id, text: `${label}: the service period is incomplete on the bill; enter it from the invoice first.` }); continue; }
    const exp = expenseByAccount(o.lines);
    if (exp.length !== 1) { holds.push({ invoice_id: b.id, text: `${label}: ${exp.length ? 'expense is split across accounts' : 'no expense line'}; one recognition schedule needs one expense account.` }); continue; }
    if (!prepaid) { holds.push({ invoice_id: b.id, text: `${label}: no Prepaid Expenses asset account in the Operating fund.` }); continue; }
    const total = exp[0].cents; const months = monthsBetween(b.service_period_start, b.service_period_end);
    const start = firstOf(b.service_period_start);
    const per = []; let left = total;
    for (let k = 0; k < months; k++) { const d = new Date(`${start}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + k); const amt = k === months - 1 ? left : Math.round(total / months); left -= amt; per.push({ month: d.toISOString().slice(0, 10), cents: amt }); }
    const deferral = { reference_hint: 'DEFER', posting_date: E, source_reference: src,
      description: `Cutoff deferral: ${label} billed in advance (service ${b.service_period_start} to ${b.service_period_end}) moved to prepaid`,
      lines: [{ account_number: prepaid.account_number, debit_cents: total, credit_cents: 0, memo: `Prepaid: ${label} service ${b.service_period_start} to ${b.service_period_end}` },
        { account_number: exp[0].account_number, debit_cents: 0, credit_cents: total, memo: `Not ${ym(E)} expense: ${label} (booked in ${o.reference})` }] };
    const effects = { [ym(E)]: -total };
    for (const p of per) effects[ym(p.month)] = (effects[ym(p.month)] || 0) + p.cents;
    items.push({ id: `defer:${b.id}`, kind: 'deferral', label, evidence: evidenceOf(b, inv), entries: [deferral], amount_cents: total, effects,
      schedule: { schedule_type: 'prepaid_expense', description: `Prepaid ${label}: service ${b.service_period_start} to ${b.service_period_end}`, balance_account_number: prepaid.account_number,
        recognition_account_number: exp[0].account_number, recognize_amount_cents: total, start_month: start, term_months: months, monthly_amount_cents: per[0].cents,
        period_start: day(b.service_period_start), period_end: day(b.service_period_end), months: per },
      verification: { text: `${o.reference} (${day(o.posting_date)}) keeps its ${money(total)}; the deferral moves it to ${prepaid.account_number} at ${E} and the schedule (draft until you approve it) recognizes it in ${per.map((p) => ym(p.month)).join(', ')}.` } });
  }
  const effects = {};
  for (const it of items) for (const [m, v] of Object.entries(it.effects)) effects[m] = (effects[m] || 0) + v;
  return { period_month: firstOf(S), additions, items, holds, effects,
    totals: { proposals: additions.length + items.length, accruals: items.filter((i) => i.kind === 'accrual').length, deferrals: items.filter((i) => i.kind === 'deferral').length, holds: holds.filter((h) => !h.already).length,
      expense_change_by_month: effects } };
}

async function must(q, what) { const { data, error } = await q; if (error) throw new Error(`${what}: ${error.message}`); return data; }

// Read the facts for one community and month (read-only).
async function loadFacts(supabase, { community_id, period_month }) {
  const per = { period_start: firstOf(period_month), period_end: lastOf(period_month) };
  const { _parts } = require('../close/gather');
  const cut = await _parts.gatherCutoff(supabase, community_id, per);
  const funds = Object.fromEntries((await must(supabase.from('account_funds').select('id, fund_code').eq('community_id', community_id), 'funds')).map((f) => [f.id, f.fund_code]));
  const coa = (await must(supabase.from('chart_of_accounts').select('id, account_number, account_name, account_type, fund_id, is_active').eq('community_id', community_id).limit(2000), 'accounts'))
    .map((a) => ({ ...a, fund_code: funds[a.fund_id] || null }));
  const byId = Object.fromEntries(coa.map((a) => [a.id, a]));
  const ids = [...cut.late_bills, ...cut.prepaid_bills].map((b) => b.id);
  const invoices = {};
  for (const id of ids) {
    const inv = await must(supabase.from('ap_invoices').select('id, source_storage_path, posting_journal_entry_id').eq('id', id).single(), 'invoice');
    let original = null;
    if (inv.posting_journal_entry_id) {
      const je = await must(supabase.from('journal_entries').select('id, reference, posting_date, status').eq('id', inv.posting_journal_entry_id).single(), 'original entry');
      const lines = await must(supabase.from('journal_entry_lines').select('account_id, debit_cents, credit_cents').eq('journal_entry_id', je.id), 'original lines');
      original = { ...je, lines: lines.map((l) => ({ account_number: (byId[l.account_id] || {}).account_number, account_type: (byId[l.account_id] || {}).account_type, debit_cents: l.debit_cents, credit_cents: l.credit_cents })) };
    }
    invoices[id] = { source_storage_path: inv.source_storage_path, original };
  }
  const refs = ids.flatMap((id) => [`cutoff:${id}:accrue`, `cutoff:${id}:defer`]);
  const already = new Set(refs.length ? (await must(supabase.from('journal_entries').select('source_reference').eq('community_id', community_id).in('source_reference', refs), 'existing')).map((r) => r.source_reference) : []);
  const sch = ids.length ? await must(supabase.from('recognition_schedules').select('source_id').eq('community_id', community_id).eq('source_type', 'ap_invoice').in('source_id', ids).in('status', ['draft', 'active', 'fully_recognized']), 'schedules') : [];
  return { period: per, late_bills: cut.late_bills, prepaid_bills: cut.prepaid_bills, invoices, accounts: coa, already, schedules_for: new Set(sch.map((s) => s.source_id)) };
}

async function preview(supabase, { community_id, period_month }) {
  return buildProposals(await loadFacts(supabase, { community_id, period_month }));
}

// Post exactly what was prepared and ticked by name, on the owner's authenticated approval.
async function postApproved(supabase, run, { include, approver, approval, actor }) {
  const P = require('./posting');
  const pv = run.preview || {};
  const all = [...(pv.additions || []), ...(pv.items || [])];
  const unknown = include.filter((id) => !all.some((p) => p.id === id));
  if (unknown.length) throw Object.assign(new Error(`not proposals of this run: ${unknown.join(', ')}`), { code: 'invalid_input' });
  const inc = new Set(include);
  const cid = run.community_id;
  const out = [];
  const funds = Object.fromEntries((await must(supabase.from('account_funds').select('id, fund_code').eq('community_id', cid), 'funds')).map((f) => [f.fund_code, f.id]));
  for (const a of (pv.additions || []).filter((x) => inc.has(x.id))) {
    const have = await must(supabase.from('chart_of_accounts').select('id').eq('community_id', cid).eq('account_number', a.account_number), 'account check');
    if (have.length) { out.push({ id: a.id, already: true }); continue; }
    const row = await must(supabase.from('chart_of_accounts').insert({ community_id: cid, fund_id: funds[a.fund_code], account_number: a.account_number, account_name: a.account_name, account_type: a.account_type, account_subtype: a.account_subtype, normal_balance: a.normal_balance, is_active: true, is_summary: false }).select('id').single(), 'add account');
    out.push({ id: a.id, account_id: row.id, account_number: a.account_number });
  }
  const coa = await must(supabase.from('chart_of_accounts').select('id, account_number, fund_id').eq('community_id', cid).limit(2000), 'accounts');
  const A = Object.fromEntries(coa.map((a) => [a.account_number, a]));
  const lines = (e) => e.lines.map((l) => { const a = A[l.account_number]; if (!a) throw Object.assign(new Error(`GL ${l.account_number} does not exist (approve the account addition first)`), { code: 'blocked' }); return { account_id: a.id, debit_cents: l.debit_cents, credit_cents: l.credit_cents, memo: l.memo }; });
  const note = (it) => `Kat cutoff correction (run ${run.id}). Evidence: ${it.evidence.vendor} invoice ${it.evidence.invoice_number}${it.evidence.document_path ? ` (${it.evidence.document_path})` : ''}, service ${it.evidence.service_period_start} to ${it.evidence.service_period_end}; original ${it.evidence.original_reference} ${it.evidence.original_posting_date}. ${it.verification.text} Approved in-app by ${approver}.`;
  const userId = approval && approval.user_id;
  for (const it of (pv.items || []).filter((x) => inc.has(x.id))) {
    const posted = {};
    for (const e of it.entries) {
      const prior = await must(supabase.from('journal_entries').select('id, reference').eq('community_id', cid).eq('source_reference', e.source_reference).limit(1), 'idempotency');
      if (prior.length) { posted[e.reference_hint] = prior[0]; continue; }
      const r = await P.postJournalEntry({ community_id: cid, posting_date: e.posting_date, source_module: 'manual', source_reference: e.source_reference, description: e.description, notes: note(it),
        posted_by_user_id: userId || null, lines: lines(e), reverses_je_id: e.reverses ? (posted.ACCR && posted.ACCR.id) : undefined });
      posted[e.reference_hint] = { id: r.entry.id, reference: r.entry.reference };
    }
    const res = { id: it.id, entries: Object.fromEntries(Object.entries(posted).map(([k, v]) => [k, v.reference])) };
    if (it.schedule) {
      const s = it.schedule;
      let sched = (await must(supabase.from('recognition_schedules').select('id, status').eq('community_id', cid).eq('source_type', 'ap_invoice').eq('source_id', it.evidence.invoice_id).in('status', ['draft', 'active', 'fully_recognized']), 'schedule check'))[0];
      if (!sched) {
        sched = await must(supabase.from('recognition_schedules').insert({ community_id: cid, schedule_type: s.schedule_type, description: s.description, balance_account_number: s.balance_account_number,
          balance_account_id: A[s.balance_account_number].id, recognition_account_id: A[s.recognition_account_number].id, recognize_amount_cents: s.recognize_amount_cents, start_month: s.start_month,
          term_months: s.term_months, monthly_amount_cents: s.monthly_amount_cents, period_start: s.period_start, period_end: s.period_end, status: 'draft', recognition_method: 'straight_line_monthly',
          schedule_basis: 'documented', source_type: 'ap_invoice', source_id: it.evidence.invoice_id, source_journal_entry_id: posted.DEFER.id, record_ownership: 'association_record',
          explanation: `${it.evidence.vendor} invoice ${it.evidence.invoice_number} bills service ${s.period_start} to ${s.period_end}; booked ${it.evidence.original_posting_date} (${it.evidence.original_reference}); deferred by ${posted.DEFER.reference}.`,
          created_by: actor }).select('id, status').single(), 'draft schedule');
      }
      if (sched.status === 'draft') {
        // The database requires who approved and when (migration 466); it is the signed-in owner.
        await must(supabase.from('recognition_schedules').update({ status: 'active', approved_by: approver, approved_at: new Date().toISOString() }).eq('id', sched.id).eq('status', 'draft').select('id'), 'approve schedule');
      }
      const today = day(new Date().toISOString());
      const done = new Set((await must(supabase.from('recognition_postings').select('period_month, kind, reversed_by_posting_id').eq('schedule_id', sched.id), 'postings')).filter((p) => p.kind === 'recognition' && !p.reversed_by_posting_id).map((p) => day(p.period_month)));
      res.schedule_id = sched.id; res.recognized = [];
      for (const m of s.months) {
        if (m.month > today || done.has(m.month)) continue;
        const { data: pid, error } = await supabase.rpc('post_recognition_period', { p_schedule_id: sched.id, p_period_month: m.month, p_actor: `${actor}; approved by ${approver}`, p_posting_date: m.month });
        if (error) throw Object.assign(new Error(`recognition ${it.label} ${ym(m.month)}: ${error.message}`), { partial: [...out, res] });
        res.recognized.push({ month: m.month, posting_id: pid });
      }
    }
    out.push(res);
  }
  return { posted: out, not_approved: all.filter((p) => !inc.has(p.id)).map((p) => p.id) };
}

module.exports = { buildProposals, loadFacts, preview, postApproved, expenseByAccount };
