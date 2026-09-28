// tests/sql/tb_drilldown_rehearsal.mjs — the TB drill-down reproduces the REAL
// v_trial_balance view (migration 453 definition, run in PGlite) row for row, and
// every row's detail ties to the view's row. Skips without PGlite.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  TB drill-down rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const tbd = require(`${REPO}/lib/accounting/trial_balance_detail.js`);

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };

const m453 = fs.readFileSync(`${REPO}/migrations/453_trial_balance_counted_entries.sql`, 'utf8').replace(/\r\n/g, '\n');
const viewSql = m453.slice(m453.indexOf('CREATE VIEW v_trial_balance'), m453.indexOf('GRANT SELECT ON v_trial_balance'));
const C = '00000000-0000-0000-0000-00000000000c';
const db = new PGlite();
await db.exec(`
  CREATE TABLE account_funds (id text primary key, community_id uuid, fund_code text, fund_name text);
  CREATE TABLE chart_of_accounts (id text primary key, community_id uuid, account_number text, account_name text, account_type text, account_subtype text, normal_balance text, fund_id text, is_active boolean);
  CREATE TABLE journal_entries (id text primary key, community_id uuid, posting_date date, reference text, description text, status text, void_reversal_je_id text, reverses_je_id text, source_module text);
  CREATE TABLE journal_entry_lines (id text primary key, journal_entry_id text, line_number int, account_id text, fund_id text, debit_cents bigint, credit_cents bigint, memo text);
  ${viewSql}`);

// Same shape of fixture as tests/test_tb_drilldown.js, generated larger: many
// entries across two funds, conversion opening, void+reversal pairs, drafts,
// voids without reversal, null-fund lines, and an inactive account.
const funds = [{ id: 'f-op', fund_code: 'OP', fund_name: 'Operating' }, { id: 'f-res', fund_code: 'RES', fund_name: 'Reserve' }];
const accounts = [
  ['a-cash', '1000', 'asset', 'debit', 'f-op', true], ['a-res', '1100', 'asset', 'debit', 'f-res', true], ['a-ar', '1200', 'asset', 'debit', null, true],
  ['a-ap', '2000', 'liability', 'credit', null, true], ['a-eq', '3000', 'equity', 'credit', 'f-op', true],
  ['a-rev', '4000', 'revenue', 'credit', 'f-op', true], ['a-exp', '5000', 'expense', 'debit', 'f-op', true], ['a-old', '5999', 'expense', 'debit', 'f-op', false],
].map(([id, no, type, nb, fund, active]) => ({ id, account_number: no, account_name: `Acct ${no}`, account_type: type, normal_balance: nb, fund_id: fund, is_active: active }));
const jes = [], lines = [];
let seq = 0;
const je = (date, status, extra = {}) => { const e = { id: `je${++seq}`, posting_date: date, reference: `JE-${String(seq).padStart(4, '0')}`, description: `entry ${seq}`, status, void_reversal_je_id: null, reverses_je_id: null, source_module: 'test', ...extra }; jes.push(e); return e; };
const ln = (e, acct, d, c, fund = null) => lines.push({ id: `l${lines.length + 1}`, journal_entry_id: e.id, line_number: lines.length + 1, account_id: acct, fund_id: fund, debit_cents: d, credit_cents: c, memo: null });
const conv = je('2026-07-31', 'posted', { source_module: 'conversion' });
ln(conv, 'a-cash', 5000000, 0); ln(conv, 'a-res', 20000000, 0); ln(conv, 'a-ar', 150000, 0, 'f-op'); ln(conv, 'a-eq', 0, 25150000);
let rnd = 7;
const rand = (n) => { rnd = (rnd * 48271) % 2147483647; return rnd % n; };
for (let i = 0; i < 400; i++) {
  const day = `2026-${String(8 + (i % 3)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`;
  const amt = 1000 + rand(90000);
  const kind = i % 7;
  if (kind === 0) { const e = je(day, 'posted'); ln(e, 'a-ar', amt, 0, 'f-op'); ln(e, 'a-rev', 0, amt); }
  else if (kind === 1) { const e = je(day, 'posted'); ln(e, 'a-cash', amt, 0); ln(e, 'a-ar', 0, amt, 'f-op'); }
  else if (kind === 2) { const e = je(day, 'posted'); ln(e, 'a-exp', amt, 0); ln(e, 'a-ap', 0, amt, 'f-op'); }
  else if (kind === 3) { const e = je(day, 'posted'); ln(e, 'a-ap', amt, 0, 'f-op'); ln(e, 'a-cash', 0, amt); }
  else if (kind === 4) { const bad = je(day, 'voided'); const rev = je(day, 'posted', { reverses_je_id: bad.id }); bad.void_reversal_je_id = rev.id; ln(bad, 'a-exp', amt, 0); ln(bad, 'a-cash', 0, amt); ln(rev, 'a-exp', 0, amt); ln(rev, 'a-cash', amt, 0); }
  else if (kind === 5) { const e = je(day, i % 2 ? 'draft' : 'voided'); ln(e, 'a-exp', amt, 0); ln(e, 'a-cash', 0, amt); }
  else { const e = je(day, 'posted'); ln(e, 'a-cash', 0, amt); ln(e, 'a-cash', amt, 0, 'f-res'); }
}
{ const e = je('2026-09-15', 'posted'); ln(e, 'a-old', 777, 0); ln(e, 'a-rev', 0, 777); }

for (const f of funds) await db.query('INSERT INTO account_funds VALUES ($1,$2,$3,$4)', [f.id, C, f.fund_code, f.fund_name]);
for (const a of accounts) await db.query('INSERT INTO chart_of_accounts VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [a.id, C, a.account_number, a.account_name, a.account_type, null, a.normal_balance, a.fund_id, a.is_active]);
for (const e of jes) await db.query('INSERT INTO journal_entries VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [e.id, C, e.posting_date, e.reference, e.description, e.status, e.void_reversal_je_id, e.reverses_je_id, e.source_module]);
for (const l of lines) await db.query('INSERT INTO journal_entry_lines VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [l.id, l.journal_entry_id, l.line_number, l.account_id, l.fund_id, l.debit_cents, l.credit_cents, l.memo]);

const view = (await db.query(`SELECT account_id, fund_id, total_debits_cents::bigint d, total_credits_cents::bigint c FROM v_trial_balance WHERE community_id = $1`, [C])).rows
  .map((r) => ({ key: `${r.account_id}|${r.fund_id}`, d: Number(r.d), c: Number(r.c) }));
const jeById = new Map(jes.map((e) => [e.id, e]));
const withJe = lines.map((l) => ({ ...l, journal_entries: jeById.get(l.journal_entry_id) }));
const tb = tbd.scopedTrialBalance({ accounts, lines: withJe, funds });
const mine = tb.rows.map((r) => ({ key: `${r.account_id}|${r.fund_id}`, d: r.total_debits_cents, c: r.total_credits_cents }));
const sortK = (a, b) => a.key.localeCompare(b.key);
check(`scoped TB (no dates) reproduces the real view row for row (${view.length} rows, ${lines.length} lines)`, JSON.stringify(view.sort(sortK)) === JSON.stringify(mine.sort(sortK)),
  JSON.stringify({ view: view.sort(sortK), mine: mine.sort(sortK) }).slice(0, 600));
let tiesAll = true, firstBad = null;
for (const r of view) {
  const [acctId, fund] = r.key.split('|');
  const d = tbd.buildDetail({ account: accounts.find((a) => a.id === acctId), lines: withJe.filter((l) => l.account_id === acctId), fundId: fund === 'null' ? null : fund, pageSize: 50 });
  if (d.tb_row.total_debits_cents !== r.d || d.tb_row.total_credits_cents !== r.c) { tiesAll = false; firstBad = firstBad || { key: r.key, view: r, detail: d.tb_row }; }
}
check('every view row\'s drill-down detail ties exactly (debits and credits)', tiesAll, JSON.stringify(firstBad));
const viewTot = view.reduce((a, r) => ({ d: a.d + r.d, c: a.c + r.c }), { d: 0, c: 0 });
check('grand totals match the view (including the inactive-account imbalance the view also shows)', viewTot.d === tb.totals.debits && viewTot.c === tb.totals.credits, JSON.stringify({ viewTot, mine: tb.totals }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
