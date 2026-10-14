// ============================================================================
// lib/accounting/reclassifications.js  (Ed 2026-10-14: controlled reclassifications)
// ----------------------------------------------------------------------------
// Ed: "Prepare controlled reclassification journal entries ... Preserve the original
// invoices, transaction history, audit trail, and total expenses. Do not duplicate
// expenses or alter payments ... The reclassification must have zero effect on total
// operating expenses, net income, cash."
//
// Kat prepares the items (what moves, from which expense account to which, with the
// source document and original posting each rests on); this module VALIDATES them
// against the GL and builds one balanced entry per item:
//     Dr <to account> / Cr <from account>, same amount, same fund
// The owner approves each item by name in Kat's queue (accounting_runs process
// 'reclassification', migration 527; authenticated in-app approval in
// lib/accounting/monthly_runs). Nothing posts at prepare time. The original entry,
// its invoice, vendor history and payments are never touched; an approved item posts
// a NEW entry that cites them.
//
// Refused (blocking exceptions), never silently adjusted:
//   - an account that is missing, not an expense account, or in another fund
//     (a reclass between expense accounts of one fund cannot change total expense,
//     net income or cash; anything else could)
//   - moving more than the from-account carries in the fiscal year through the date
//   - an item already posted (source_reference is the idempotency key)
//   - a posting date before the GL cutover (the converted period is certified: an
//     amount in a converted opening balance is moved on the cutover date, labeled)
// ============================================================================

const { fetchAllQuery } = require('../db/fetch_all');
const day = (d) => String(d || '').slice(0, 10);
const money = (c) => { const n = Number(c || 0) / 100; const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return n < 0 ? `($${s})` : `$${s}`; };
const srcRef = (community_id, id) => `RECLASS:${community_id}:${id}`;

/**
 * PURE. Validate Kat's items against the facts and build the proposals.
 * facts = { community_id, cutover_date, accounts: {number: {id, account_type, fund_id}},
 *           balances: {number: [{posting_date, cents}]} (posted net debits in the fiscal year),
 *           posted_refs: Set(source_reference) }
 * items = [{ id, label, posting_date, from_account, to_account, amount_cents, evidence: {...} }]
 */
function buildProposals(facts, items) {
  const out = []; const exceptions = []; const moved = {};
  const balanceThrough = (acct, date) => (facts.balances[acct] || []).filter((b) => day(b.posting_date) <= date).reduce((t, b) => t + b.cents, 0);
  const sorted = [...(items || [])].sort((a, b) => day(a.posting_date).localeCompare(day(b.posting_date)) || String(a.id).localeCompare(String(b.id)));
  const ids = new Set();
  for (const it of sorted) {
    const bad = (text) => exceptions.push({ code: 'invalid_item', item_id: it.id, severity: 'blocking', text: `${it.label || it.id}: ${text}` });
    if (!it.id || ids.has(it.id)) { bad('each item needs a unique id'); continue; }
    ids.add(it.id);
    const from = facts.accounts[it.from_account]; const to = facts.accounts[it.to_account];
    const amt = Number(it.amount_cents);
    if (!Number.isInteger(amt) || amt <= 0) { bad('the amount must be a positive number of cents'); continue; }
    if (!from || !to) { bad(`GL ${!from ? it.from_account : it.to_account} does not exist`); continue; }
    if (it.from_account === it.to_account) { bad('from and to are the same account'); continue; }
    if (from.account_type !== 'expense' || to.account_type !== 'expense') { bad('both accounts must be expense accounts (a reclassification never changes total expense or net income)'); continue; }
    if ((from.fund_id || null) !== (to.fund_id || null)) { bad('the accounts are in different funds'); continue; }
    const pd = day(it.posting_date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pd)) { bad('a posting date is required'); continue; }
    if (facts.cutover_date && pd < facts.cutover_date) { bad(`${pd} is before the GL cutover (${facts.cutover_date}); move a converted balance on the cutover date`); continue; }
    if (!it.evidence || !String(it.evidence.basis || '').trim()) { bad('the evidence (source document and basis) is required'); continue; }
    const ref = srcRef(facts.community_id, it.id);
    if (facts.posted_refs.has(ref)) { out.push({ ...it, already: true, source_reference: ref }); continue; }
    const key = it.from_account;
    const carried = balanceThrough(key, pd) - (moved[key] || 0);
    if (carried < amt) { bad(`GL ${key} carries ${money(carried)} in the year through ${pd}; cannot move ${money(amt)}`); continue; }
    moved[key] = (moved[key] || 0) + amt; moved[it.to_account] = (moved[it.to_account] || 0) - amt;
    out.push({
      id: it.id, kind: 'reclassification', label: it.label, amount_cents: amt, evidence: it.evidence,
      effects: { [it.from_account]: -amt, [it.to_account]: amt },
      entries: [{ reference_hint: 'RECLASS', posting_date: pd, source_reference: ref,
        description: `Reclassify ${it.label}: GL ${it.from_account} to GL ${it.to_account}`,
        lines: [
          { account_number: it.to_account, debit_cents: amt, credit_cents: 0, memo: it.evidence.memo || it.label },
          { account_number: it.from_account, debit_cents: 0, credit_cents: amt, memo: `Reclass to ${it.to_account}: ${it.evidence.memo || it.label}` },
        ] }],
      verification: { text: `Moves ${money(amt)} from ${it.from_account} to ${it.to_account}; GL ${it.from_account} carried ${money(carried)} through ${pd}. ${it.evidence.basis}` },
    });
  }
  const live = out.filter((p) => !p.already);
  const byAccount = {};
  for (const p of live) for (const [a, c] of Object.entries(p.effects)) byAccount[a] = (byAccount[a] || 0) + c;
  const net = Object.values(byAccount).reduce((t, c) => t + c, 0);
  if (net !== 0) exceptions.push({ code: 'not_zero_sum', severity: 'blocking', text: `The items change total expense by ${money(net)}; a reclassification must net to zero.` });
  return {
    items: out, exceptions,
    totals: { proposals: live.length, already_posted: out.length - live.length, amount_cents: live.reduce((t, p) => t + p.amount_cents, 0), by_account: byAccount, net_expense_change_cents: net },
  };
}

async function must(q, what) { const { data, error } = await q; if (error) throw new Error(`${what}: ${error.message}`); return data; }

async function loadFacts(supabase, { community_id, items }) {
  const nums = [...new Set((items || []).flatMap((i) => [i.from_account, i.to_account]).filter(Boolean))];
  const coa = nums.length ? await must(supabase.from('chart_of_accounts').select('id, account_number, account_type, fund_id').eq('community_id', community_id).in('account_number', nums), 'accounts') : [];
  const accounts = Object.fromEntries(coa.map((a) => [a.account_number, a]));
  const years = [...new Set((items || []).map((i) => day(i.posting_date).slice(0, 4)).filter((y) => /^\d{4}$/.test(y)))];
  const balances = {};
  for (const a of coa) {
    balances[a.account_number] = [];
    for (const y of years) {
      const rows = await fetchAllQuery(() => supabase.from('journal_entry_lines').select('id, debit_cents, credit_cents, journal_entries!inner(posting_date, status)')
        .eq('account_id', a.id).eq('journal_entries.status', 'posted').gte('journal_entries.posting_date', `${y}-01-01`).lte('journal_entries.posting_date', `${y}-12-31`), { orderBy: 'id' });
      for (const r of rows) balances[a.account_number].push({ posting_date: r.journal_entries.posting_date, cents: Number(r.debit_cents || 0) - Number(r.credit_cents || 0) });
    }
  }
  const refs = (items || []).map((i) => srcRef(community_id, i.id));
  const posted = refs.length ? await must(supabase.from('journal_entries').select('source_reference').eq('community_id', community_id).in('source_reference', refs).neq('status', 'voided'), 'posted refs') : [];
  const { getGlCutoverDate } = require('./cutover');
  return { community_id, cutover_date: await getGlCutoverDate(supabase, community_id), accounts, balances, posted_refs: new Set(posted.map((p) => p.source_reference)) };
}

async function preview(supabase, { community_id, items }) {
  if (!Array.isArray(items) || !items.length) throw Object.assign(new Error('a reclassification needs items'), { code: 'invalid_input' });
  return { ...buildProposals(await loadFacts(supabase, { community_id, items }), items), submitted: items };
}

async function postApproved(supabase, run, { include, approver, approval }) {
  const P = require('./posting');
  const pv = run.preview || {};
  const all = pv.items || [];
  const unknown = include.filter((id) => !all.some((p) => p.id === id));
  if (unknown.length) throw Object.assign(new Error(`not proposals of this run: ${unknown.join(', ')}`), { code: 'invalid_input' });
  const inc = new Set(include);
  // Re-validate against the GL as it stands now: something may have posted since prepare.
  const fresh = buildProposals(await loadFacts(supabase, { community_id: run.community_id, items: pv.submitted || [] }), pv.submitted || []);
  const blocking = fresh.exceptions.filter((e) => e.severity === 'blocking' && (!e.item_id || inc.has(e.item_id)));
  if (blocking.length) throw Object.assign(new Error(`cannot post: ${blocking.map((b) => b.text).join(' ')}`), { code: 'blocked' });
  const coa = await must(supabase.from('chart_of_accounts').select('id, account_number').eq('community_id', run.community_id).limit(2000), 'accounts');
  const A = Object.fromEntries(coa.map((a) => [a.account_number, a.id]));
  const out = [];
  for (const it of fresh.items.filter((x) => inc.has(x.id))) {
    if (it.already) { out.push({ id: it.id, already_posted: it.source_reference }); continue; }
    const e = it.entries[0];
    const prior = await must(supabase.from('journal_entries').select('id, reference').eq('community_id', run.community_id).eq('source_reference', e.source_reference).neq('status', 'voided').limit(1), 'idempotency');
    if (prior.length) { out.push({ id: it.id, reference: prior[0].reference, already: true }); continue; }
    const ev = it.evidence || {};
    const notes = `Kat reclassification (run ${run.id}). ${ev.basis} Source: ${ev.source || ''}${ev.original_reference ? `; original ${ev.original_reference} ${ev.original_posting_date || ''}` : ''}. Original entry, invoice and payment unchanged. Approved in-app by ${approver}.`;
    const r = await P.postJournalEntry({ community_id: run.community_id, posting_date: e.posting_date, source_module: 'manual', source_reference: e.source_reference, description: e.description, notes,
      posted_by_user_id: (approval && approval.user_id) || null, lines: e.lines.map((l) => ({ account_id: A[l.account_number], debit_cents: l.debit_cents, credit_cents: l.credit_cents, memo: l.memo })) });
    out.push({ id: it.id, reference: r.entry.reference });
  }
  return { posted: out, entries: out.filter((o) => o.reference).map((o) => ({ reference: o.reference })), not_approved: all.filter((p) => !inc.has(p.id)).map((p) => p.id) };
}

module.exports = { buildProposals, preview, postApproved, srcRef };
