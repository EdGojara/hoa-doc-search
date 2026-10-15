// ============================================================================
// lib/accounting/je_integrity.js  (Ed 2026-10-15)
// ----------------------------------------------------------------------------
// Integrity exceptions on journal entries, computed live and read-only: a
// non-draft entry whose header carries an amount but whose lines are missing,
// or whose line totals differ from its header totals. Nothing here changes
// accounting data; it only says so, on the entry list and the entry detail.
//
// Today: Lakes of Pine Forest JE-2026-00169..00172 (posted 7/28, lines deleted
// on 2026-09-28/29 by the pre-#102 AP re-code; headers $6,277.75). They are
// repaired by voiding the conversion NEUT and REPOST entries, never by voiding
// or editing these headers, so the void action is refused on any entry here.
// ============================================================================
const { fetchAll } = require('../db/fetch_all');

const money = (c) => { const n = Number(c) || 0; const s = (Math.abs(n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return n < 0 ? `($${s})` : `$${s}`; };

// header: { status, total_debits_cents, total_credits_cents }; sums: { n, debit_cents, credit_cents } or null.
function integrityOf(header, sums) {
  if (!header || header.status === 'draft') return null;
  const hd = Number(header.total_debits_cents) || 0, hc = Number(header.total_credits_cents) || 0;
  const s = sums || { n: 0, debit_cents: 0, credit_cents: 0 };
  if (!s.n) {
    if (!hd && !hc) return null;
    return { code: 'no_lines', message: `This entry's header says ${money(hd)} but it has no lines. Its amount is not in any balance; the header total is not supported by the ledger.` };
  }
  if (s.debit_cents !== hd || s.credit_cents !== hc) {
    return { code: 'totals_mismatch', message: `The lines total ${money(s.debit_cents)} debit / ${money(s.credit_cents)} credit, but the header says ${money(hd)} / ${money(hc)}. Balances use the lines.` };
  }
  return null;
}

// { [journal_entry_id]: { n, debit_cents, credit_cents } } for the given ids (paged, chunked).
async function lineSums(supabase, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const rows = await fetchAll(supabase, 'journal_entry_lines', { select: 'id, journal_entry_id, debit_cents, credit_cents', filters: { journal_entry_id: chunk } });
    for (const r of rows) {
      const s = out[r.journal_entry_id] || (out[r.journal_entry_id] = { n: 0, debit_cents: 0, credit_cents: 0 });
      s.n++; s.debit_cents += Number(r.debit_cents) || 0; s.credit_cents += Number(r.credit_cents) || 0;
    }
  }
  return out;
}

// Adds .integrity (null or { code, message }) to each entry. Read-only.
async function annotateIntegrity(supabase, entries) {
  const list = entries || [];
  const ids = list.filter((e) => e && e.status !== 'draft').map((e) => e.id);
  const sums = ids.length ? await lineSums(supabase, ids) : {};
  for (const e of list) e.integrity = integrityOf(e, sums[e.id] || null);
  return list;
}

module.exports = { integrityOf, lineSums, annotateIntegrity };
