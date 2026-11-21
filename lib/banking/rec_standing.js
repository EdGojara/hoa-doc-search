// ============================================================================
// lib/banking/rec_standing.js  (Ed 2026-11-21)
// ----------------------------------------------------------------------------
// ONE answer to "is this bank account reconciled for this month?", computed on
// read from what is already stored. Every screen, report and gate that shows
// or relies on a reconciliation uses this, never bank_reconciliations.status
// alone. An approval is not a reconciliation.
//
//   reconciled    the stored reconciliation balances to $0.00, nothing is open
//                 (status 'reconciled'), no bank item is missing from the GL
//                 (no bank_only items), and the GL has not changed since.
//   unreconciled  anything else: a difference, open exceptions, bank items not
//                 yet in the GL, or no reconciliation for the month.
//   stale         it met that bar, or its run was approved, and something it relied
//                 on changed after it was saved: the GL balance at period end differs
//                 from the stored one, an entry dated on or before period end was
//                 posted, voided or superseded afterwards, or its bank statement was
//                 superseded by a corrected statement.
//
// Nothing is written. Statuses on bank_reconciliations stay what they were.
// ============================================================================

const { countsInGl } = require('../accounting/je_status');
const { fetchAllQuery } = require('../db/fetch_all');

const STANDING_LABEL = { reconciled: 'Reconciled', unreconciled: 'Unreconciled', stale: 'Stale' };
const day = (d) => String(d || '').slice(0, 10);
const firstOf = (d) => `${day(d).slice(0, 7)}-01`;

// Pure decision (tested in tests/test_bank_rec_standing.js).
//   rec: { status, difference_cents }
//   facts: { bank_only_count, approved, gl_now_cents, gl_saved_cents, changed_after_save }
function decideStanding(rec, facts = {}) {
  if (!rec) return { standing: 'unreconciled', reasons: ['no reconciliation for the month'] };
  const reasons = [];
  const diff = rec.difference_cents == null ? null : Number(rec.difference_cents);
  const bankOnly = Number(facts.bank_only_count || 0);
  if (rec.status !== 'reconciled') reasons.push(rec.status === 'unbalanced' ? 'does not balance' : rec.status === 'in_progress' ? 'exceptions still open' : `status ${String(rec.status || 'unknown').replace(/_/g, ' ')}`);
  if (diff == null) reasons.push('no difference computed');
  else if (diff !== 0) reasons.push(`off by ${(diff / 100).toFixed(2)}`);
  if (bankOnly > 0) reasons.push(`${bankOnly} bank item${bankOnly === 1 ? '' : 's'} not in the GL`);
  const metBar = reasons.length === 0;
  const glMoved = facts.gl_saved_cents != null && facts.gl_now_cents != null && Number(facts.gl_saved_cents) !== Number(facts.gl_now_cents);
  const changed = glMoved || Number(facts.changed_after_save || 0) > 0 || !!facts.statement_superseded;
  if ((metBar || facts.approved) && changed) {
    const why = [];
    if (facts.statement_superseded) why.push('the bank statement it was reconciled to has since been superseded by a corrected statement');
    if (glMoved) why.push(`GL cash at period end is now ${(facts.gl_now_cents / 100).toFixed(2)}, saved as ${(facts.gl_saved_cents / 100).toFixed(2)}`);
    if (facts.changed_after_save) why.push(`${facts.changed_after_save} GL cash entr${facts.changed_after_save === 1 ? 'y' : 'ies'} for the period changed after it was saved`);
    return { standing: 'stale', reasons: [...why, ...reasons], approved: !!facts.approved };
  }
  return { standing: metBar ? 'reconciled' : 'unreconciled', reasons, approved: !!facts.approved };
}

// Standing for many stored reconciliations at once. recs need: id, bank_account_id,
// period_end, status, difference_cents, gl_ending_balance_cents, prepared_at, updated_at.
// Returns Map(rec.id -> { standing, label, reasons, approved, gl_now_cents }).
async function standingsFor(supabase, recs) {
  const out = new Map();
  const list = (recs || []).filter((r) => r && r.id && r.bank_account_id && r.status !== 'voided');
  if (!list.length) return out;
  const must = async (q, what) => { const { data, error } = await q; if (error) throw new Error(`${what}: ${error.message}`); return data || []; };

  const baIds = [...new Set(list.map((r) => r.bank_account_id))];
  const bas = await must(supabase.from('bank_accounts').select('id, community_id, gl_account_number').in('id', baIds), 'bank accounts');
  const baById = new Map(bas.map((b) => [b.id, b]));

  // GL cash lines per bank account (its own mapped GL account), dated through the latest period end.
  const lines = new Map();
  for (const b of bas) {
    if (!b.gl_account_number) { lines.set(b.id, null); continue; }
    const acct = (await must(supabase.from('chart_of_accounts').select('id').eq('community_id', b.community_id).eq('account_number', String(b.gl_account_number)).limit(1), 'cash account'))[0];
    if (!acct) { lines.set(b.id, null); continue; }
    const maxEnd = list.filter((r) => r.bank_account_id === b.id).map((r) => day(r.period_end)).sort().pop();
    const rows = await fetchAllQuery(() => supabase.from('journal_entry_lines')
      .select('id, debit_cents, credit_cents, journal_entries!inner(posting_date, status, void_reversal_je_id, posted_at, created_at, voided_at, superseded_at)')
      .eq('account_id', acct.id).lte('journal_entries.posting_date', maxEnd), { orderBy: 'id' });
    lines.set(b.id, rows);
  }

  // bank-only item counts per reconciliation
  const bankOnly = new Map();
  const ids = list.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const rows = await fetchAllQuery(() => supabase.from('bank_reconciliation_items').select('id, reconciliation_id').eq('category', 'bank_only').in('reconciliation_id', chunk), { orderBy: 'id' });
    for (const x of rows) bankOnly.set(x.reconciliation_id, (bankOnly.get(x.reconciliation_id) || 0) + 1);
  }

  // statements the reconciliations were saved against: superseded (voided) since = a correction arrived.
  // Callers need not select the column; it is read here for any row that lacks it.
  const missing = list.filter((r) => !('bank_statement_import_id' in r)).map((r) => r.id);
  for (let i = 0; i < missing.length; i += 100) {
    const rows = await fetchAllQuery(() => supabase.from('bank_reconciliations').select('id, bank_statement_import_id').in('id', missing.slice(i, i + 100)), { orderBy: 'id' });
    const m = new Map(rows.map((x) => [x.id, x.bank_statement_import_id]));
    for (const r of list) if (m.has(r.id)) r.bank_statement_import_id = m.get(r.id);
  }
  const stmtIds = [...new Set(list.map((r) => r.bank_statement_import_id).filter(Boolean))];
  const voidedStmt = new Set();
  for (let i = 0; i < stmtIds.length; i += 100) {
    const rows = await fetchAllQuery(() => supabase.from('bank_statement_imports').select('id, status').in('id', stmtIds.slice(i, i + 100)), { orderBy: 'id' });
    for (const x of rows) if (x.status === 'voided') voidedStmt.add(x.id);
  }

  // approved = Kat's run for that account and month was approved and posted
  const posted = await fetchAllQuery(() => supabase.from('accounting_runs').select('id, subject_id, period_month').eq('process', 'bank_reconciliation').eq('status', 'posted').in('subject_id', baIds), { orderBy: 'id' });
  const approvedKey = new Set(posted.map((p) => `${p.subject_id}|${day(p.period_month)}`));

  for (const r of list) {
    const pe = day(r.period_end);
    const savedAt = r.prepared_at || r.updated_at || null;
    const L = lines.get(r.bank_account_id);
    let glNow = null, changed = 0;
    if (L) {
      const inPeriod = L.filter((l) => day(l.journal_entries.posting_date) <= pe);
      glNow = inPeriod.filter((l) => countsInGl(l.journal_entries)).reduce((t, l) => t + Number(l.debit_cents || 0) - Number(l.credit_cents || 0), 0);
      if (savedAt) {
        changed = inPeriod.filter((l) => {
          const j = l.journal_entries;
          const last = [j.posted_at || j.created_at, j.voided_at, j.superseded_at].filter(Boolean).sort().pop();
          return last && last > savedAt;
        }).length;
      }
    }
    const d = decideStanding(r, {
      bank_only_count: bankOnly.get(r.id) || 0,
      approved: approvedKey.has(`${r.bank_account_id}|${firstOf(pe)}`),
      gl_now_cents: glNow, gl_saved_cents: r.gl_ending_balance_cents == null ? null : Number(r.gl_ending_balance_cents),
      changed_after_save: changed,
      statement_superseded: !!(r.bank_statement_import_id && voidedStmt.has(r.bank_statement_import_id)),
    });
    out.set(r.id, { ...d, label: STANDING_LABEL[d.standing], gl_now_cents: glNow });
  }
  return out;
}

// Convenience: attach .standing / .standing_label / .standing_reasons to rec rows in place.
// Fails closed: if the standing cannot be computed, every row is Unreconciled with the
// reason, and the error is logged. A failure never falls back to the stored status.
async function withStandings(supabase, recs) {
  let m;
  try { m = await standingsFor(supabase, recs); }
  catch (e) {
    console.error('[rec_standing] standing could not be computed', JSON.stringify({ recs: (recs || []).length, error: e.message }));
    for (const r of recs || []) if (r) { r.standing = 'unreconciled'; r.standing_label = STANDING_LABEL.unreconciled; r.standing_reasons = [`standing could not be computed (${e.message})`]; r.approved = false; }
    return recs;
  }
  for (const r of recs || []) {
    const s = r && m.get(r.id);
    if (s) { r.standing = s.standing; r.standing_label = s.label; r.standing_reasons = s.reasons; r.approved = s.approved; }
    else if (r) { r.standing = 'unreconciled'; r.standing_label = STANDING_LABEL.unreconciled; r.standing_reasons = [r.status === 'voided' ? 'voided' : 'not evaluated']; }
  }
  return recs;
}

module.exports = { decideStanding, standingsFor, withStandings, STANDING_LABEL };
