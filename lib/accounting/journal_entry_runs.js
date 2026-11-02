// ============================================================================
// lib/accounting/journal_entry_runs.js  (Ed 2026-11-01: Kat prepares ordinary journal entries)
// ----------------------------------------------------------------------------
// Ed: "Kat must be able to prepare ordinary journal entries herself ... saved as a draft,
// not posted ... an authorized human can review, approve, and post that exact entry."
//
// Kat prepares the items (date, accounts by number, debits, credits, description and the
// evidence the entry rests on); this module VALIDATES them against the GL. They wait in
// Kat's queue as an accounting run (process 'journal_entry', migration 558). The owner
// approves each entry by name (authenticated in-app approval, lib/accounting/monthly_runs);
// only then does it post, through the ordinary posting code (lib/accounting/posting), as
// a NEW entry citing its run and evidence. After posting, Kat reads the entry back and
// records each account's balance, so the next step can rely on the ledger as posted.
//
// Refused (blocking exceptions), never silently adjusted:
//   - an account that is missing or inactive, a line with both or neither side, an
//     unbalanced entry, fewer than two lines
//   - a posting date before the GL cutover (the converted period is certified)
//   - an entry without its evidence (the basis for it)
// The item id is the idempotency key (source_reference KATJE:<community>:<id>): a
// corrected entry resubmitted under the same id posts once, never twice.
// ============================================================================
const day = (d) => String(d || '').slice(0, 10);
const money = (c) => { const n = Number(c || 0) / 100; const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return n < 0 ? `($${s})` : `$${s}`; };
const srcRef = (community_id, id) => `KATJE:${community_id}:${id}`;

/**
 * PURE. Validate Kat's items against the facts and build the proposals.
 * facts = { community_id, cutover_date, accounts: {number: {id, account_type, is_active}}, posted_refs: Set }
 * items = [{ id, label, posting_date, description, lines: [{account_number, debit_cents, credit_cents, memo}], evidence: {basis, source} }]
 */
function buildProposals(facts, items) {
  const out = []; const exceptions = []; const ids = new Set();
  for (const it of items || []) {
    const bad = (text) => exceptions.push({ code: 'invalid_item', item_id: it.id, severity: 'blocking', text: `${it.label || it.id}: ${text}` });
    if (!it.id || ids.has(it.id)) { bad('each entry needs a unique id'); continue; }
    ids.add(it.id);
    const pd = day(it.posting_date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pd)) { bad('a posting date is required'); continue; }
    if (facts.cutover_date && pd < facts.cutover_date) { bad(`${pd} is before the GL cutover (${facts.cutover_date})`); continue; }
    if (!String(it.description || '').trim()) { bad('a description is required'); continue; }
    if (!it.evidence || String(it.evidence.basis || '').trim().length < 10) { bad('the evidence (the basis for the entry) is required'); continue; }
    const lines = Array.isArray(it.lines) ? it.lines : [];
    if (lines.length < 2) { bad('an entry needs at least two lines'); continue; }
    let dr = 0, cr = 0, lineErr = null;
    for (const [i, l] of lines.entries()) {
      const a = facts.accounts[l.account_number];
      const d = Number(l.debit_cents || 0), c = Number(l.credit_cents || 0);
      if (!a) { lineErr = `line ${i + 1}: GL ${l.account_number} does not exist`; break; }
      if (a.is_active === false) { lineErr = `line ${i + 1}: GL ${l.account_number} is inactive`; break; }
      if (!Number.isInteger(d) || !Number.isInteger(c) || d < 0 || c < 0 || (d > 0) === (c > 0)) { lineErr = `line ${i + 1}: exactly one of debit or credit, a positive number of cents`; break; }
      dr += d; cr += c;
    }
    if (lineErr) { bad(lineErr); continue; }
    if (dr !== cr) { bad(`debits ${money(dr)} do not equal credits ${money(cr)}`); continue; }
    const ref = srcRef(facts.community_id, it.id);
    const effects = {};
    for (const l of lines) effects[l.account_number] = (effects[l.account_number] || 0) + Number(l.debit_cents || 0) - Number(l.credit_cents || 0);
    const entry = { posting_date: pd, description: String(it.description).trim(), source_reference: ref,
      lines: lines.map((l) => ({ account_number: String(l.account_number), debit_cents: Number(l.debit_cents || 0), credit_cents: Number(l.credit_cents || 0), memo: l.memo || null })) };
    out.push({ id: it.id, label: it.label || it.description, amount_cents: dr, evidence: it.evidence, effects, entries: [entry], source_reference: ref,
      already: facts.posted_refs.has(ref) || undefined,
      verification: { text: `Balanced: ${money(dr)} debits = ${money(cr)} credits, dated ${pd}.` } });
  }
  const live = out.filter((p) => !p.already);
  return { items: out, exceptions, totals: { proposals: live.length, already_posted: out.length - live.length, amount_cents: live.reduce((t, p) => t + p.amount_cents, 0) } };
}

async function must(q, what) { const { data, error } = await q; if (error) throw new Error(`${what}: ${error.message}`); return data; }

async function loadFacts(supabase, { community_id, items }) {
  const nums = [...new Set((items || []).flatMap((i) => (i.lines || []).map((l) => String(l.account_number))).filter(Boolean))];
  const coa = nums.length ? await must(supabase.from('chart_of_accounts').select('id, account_number, account_type, is_active').eq('community_id', community_id).in('account_number', nums), 'accounts') : [];
  const refs = (items || []).map((i) => srcRef(community_id, i.id));
  const posted = refs.length ? await must(supabase.from('journal_entries').select('source_reference').eq('community_id', community_id).in('source_reference', refs).neq('status', 'voided'), 'posted refs') : [];
  const { getGlCutoverDate } = require('./cutover');
  return { community_id, cutover_date: await getGlCutoverDate(supabase, community_id), accounts: Object.fromEntries(coa.map((a) => [a.account_number, a])), posted_refs: new Set(posted.map((p) => p.source_reference)) };
}

async function preview(supabase, { community_id, items }) {
  if (!Array.isArray(items) || !items.length) throw Object.assign(new Error('a journal entry run needs items'), { code: 'invalid_input' });
  return { ...buildProposals(await loadFacts(supabase, { community_id, items }), items), submitted: items };
}

// Each account's posted balance (debits - credits, all dates), read after posting.
async function balances(supabase, community_id, numbers) {
  const coa = await must(supabase.from('chart_of_accounts').select('id, account_number').eq('community_id', community_id).in('account_number', numbers), 'accounts');
  const out = {};
  for (const a of coa) {
    const rows = await require('../db/fetch_all').fetchAllQuery(() => supabase.from('journal_entry_lines').select('id, debit_cents, credit_cents, journal_entries!inner(status)')
      .eq('account_id', a.id).eq('journal_entries.status', 'posted'), { orderBy: 'id' });
    out[a.account_number] = rows.reduce((t, r) => t + Number(r.debit_cents || 0) - Number(r.credit_cents || 0), 0);
  }
  return out;
}

async function postApproved(supabase, run, { include, approver, approval }) {
  const P = require('./posting');
  const pv = run.preview || {};
  const all = pv.items || [];
  const unknown = include.filter((id) => !all.some((p) => p.id === id));
  if (unknown.length) throw Object.assign(new Error(`not entries of this run: ${unknown.join(', ')}`), { code: 'invalid_input' });
  const inc = new Set(include);
  // Re-validate against the GL as it stands now, and post exactly what was prepared.
  const fresh = buildProposals(await loadFacts(supabase, { community_id: run.community_id, items: pv.submitted || [] }), pv.submitted || []);
  const blocking = fresh.exceptions.filter((e) => !e.item_id || inc.has(e.item_id));
  if (blocking.length) throw Object.assign(new Error(`cannot post: ${blocking.map((b) => b.text).join(' ')}`), { code: 'blocked' });
  const coa = await must(supabase.from('chart_of_accounts').select('id, account_number').eq('community_id', run.community_id).limit(2000), 'accounts');
  const A = Object.fromEntries(coa.map((a) => [a.account_number, a.id]));
  const out = [];
  for (const it of fresh.items.filter((x) => inc.has(x.id))) {
    const e = it.entries[0];
    const prior = await must(supabase.from('journal_entries').select('id, reference').eq('community_id', run.community_id).eq('source_reference', e.source_reference).neq('status', 'voided').limit(1), 'idempotency');
    if (prior.length) { out.push({ id: it.id, reference: prior[0].reference, already: true }); continue; }
    const ev = it.evidence || {};
    const notes = `Prepared by Kat (run ${run.id}). ${ev.basis}${ev.source ? ` Source: ${ev.source}.` : ''} Approved in-app by ${approver}.`;
    const r = await P.postJournalEntry({ community_id: run.community_id, posting_date: e.posting_date, source_module: 'manual', source_reference: e.source_reference, description: e.description, notes,
      posted_by_user_id: (approval && approval.user_id) || null, lines: e.lines.map((l) => ({ account_id: A[l.account_number], debit_cents: l.debit_cents, credit_cents: l.credit_cents, memo: l.memo })) });
    // Kat reads the posted entry back: its lines must be exactly the prepared ones.
    const posted = await must(supabase.from('journal_entry_lines').select('account_id, debit_cents, credit_cents').eq('journal_entry_id', r.entry.id), 'read back');
    const key = (l) => `${l.account_id}:${Number(l.debit_cents || 0)}:${Number(l.credit_cents || 0)}`;
    const want = e.lines.map((l) => key({ account_id: A[l.account_number], debit_cents: l.debit_cents, credit_cents: l.credit_cents })).sort();
    const got = posted.map(key).sort();
    out.push({ id: it.id, reference: r.entry.reference, journal_entry_id: r.entry.id, posted_as_prepared: JSON.stringify(want) === JSON.stringify(got) });
  }
  const touched = [...new Set(fresh.items.filter((x) => inc.has(x.id)).flatMap((x) => x.entries[0].lines.map((l) => l.account_number)))];
  return { posted: out, entries: out.filter((o) => o.reference).map((o) => ({ reference: o.reference })),
    balances_after: touched.length ? await balances(supabase, run.community_id, touched) : {},
    not_approved: all.filter((p) => !inc.has(p.id)).map((p) => p.id) };
}

module.exports = { buildProposals, preview, postApproved, srcRef };
