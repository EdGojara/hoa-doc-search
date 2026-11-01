// tests/sql/557_waterview_corrections_e2e.mjs — migration 557 applied END TO END through the single-
// migration tool with its REAL checks file, on the production GL / homeowner-ledger / AP shapes with the
// REAL ledger guards (502 close, 528 books-closed, 529 posted-lines-immutable), the REAL reference
// numbering (359) and the REAL balance view (195). The world holds the exact Waterview rows:
//   JE-2026-00232 (8/31, Dr 1300 / Cr 5870 $42.00) + its duplicate homeowner charge cd62c4c7,
//   the $557.35 bill-back (left alone: Legal Review corrects it), and Amazon bill 33fbabb2 (4 lines, $24.06).
// Then:
//   APPLY   reversal dated 8/31 mirrors the original, the original is voided naming it (529's rule),
//           a -$42.00 credit is linked to the duplicate charge; GL 1300 and the homeowner ledger both fall
//           by exactly $42.00; Amazon lines = total - tax; nothing else moves;
//   RERUN   the file refuses (its guards), changing nothing;
//   ATOMIC  a variant whose last step fails leaves no reversal, no void and no credit;
//   AFTER   the $557.35 Legal Review treatment (reverse + credit) brings GL 1300 and the subledger together
//           to $1,044.35 = Vantaca's 7/31 aging for the account.
// Postgres 17 (PGlite). Skips without PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { onboardingWorld } from './onboarding_world.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  557 Waterview corrections e2e (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '557_waterview_duplicate_billback_and_amazon_lines.sql';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const SQL = lf(`${REPO}/migrations/${F}`);
const CHECKS = lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`);

const WV = 'a0000000-0000-4000-8000-000000000001', MC = '00000000-0000-0000-0000-0000000000a1';
const FUND = '053b367e-4edd-487b-8342-da561ec1f454', A1300 = '5f1bcee0-86e6-40a9-a673-29aa8b44c994', A5870 = '4ced3590-4d1d-4fb8-a93d-ef96626f3f15';
const A2000 = '5d323fa6-cf74-41ca-b56a-508e825615ff', A5720 = 'd7bd6b1b-fa3c-4204-9f6e-4e61f7f39627';
const ATTY = 'ee565db3-2c94-4830-8855-ccea1740dfa7', AMZ = '486c9aad-8d57-4fb9-ac16-5c31cd827198';
const PROP = '640f4fdc-f1de-4565-91ab-078fb297fb0c', TENURE = '207d0e2a-2f10-40ae-8f94-6005814732f5';
const J42 = '663d14c0-76d7-4cf8-bed6-4985aa2a6c96', J557 = 'a85f5cb4-33d8-498a-a3b4-a5358c0fbad2';
const H42 = 'cd62c4c7-9db8-43f5-9664-05f981e9a40f', H557 = '5fce468b-9bc0-4109-8cf8-158ae5be7733';
const INV = '33fbabb2-2c62-4df0-af72-a55054e058e9';

async function build() {
  const world = await onboardingWorld(PGlite, { through: 452, gl: true });
  const { db } = world;
  await db.exec(`
    ALTER TABLE accounting_periods ADD COLUMN period_type text NOT NULL DEFAULT 'monthly', ADD COLUMN closed_at timestamptz, ADD COLUMN closed_by_user_id uuid,
      ADD COLUMN reopened_at timestamptz, ADD COLUMN reopened_by_user_id uuid, ADD COLUMN reopened_reason text, ADD COLUMN locked_at timestamptz, ADD COLUMN locked_by_user_id uuid,
      ADD COLUMN notes text, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE journal_entries ADD COLUMN voided_by_user_id uuid, ADD COLUMN posted_by_user_id uuid, ADD COLUMN needs_review boolean NOT NULL DEFAULT false, ADD COLUMN last_edited_at timestamptz;
    ALTER TABLE communities ADD COLUMN is_demo boolean DEFAULT false, ADD COLUMN books_of_record text DEFAULT 'trusted',
      ADD COLUMN IF NOT EXISTS management_status text NOT NULL DEFAULT 'active', ADD COLUMN IF NOT EXISTS management_end_date date, ADD COLUMN IF NOT EXISTS financials_active boolean NOT NULL DEFAULT true;
    ALTER TABLE homeowner_transactions ADD COLUMN is_operator_override boolean NOT NULL DEFAULT false, ADD COLUMN reduction_source text;
    CREATE TABLE ap_invoice_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid NOT NULL REFERENCES ap_invoices(id), line_number int NOT NULL,
      description text, quantity numeric, unit_price_cents bigint, amount_cents bigint NOT NULL, gl_account_id uuid REFERENCES chart_of_accounts(id),
      tax_amount_cents bigint, is_taxable boolean, notes text, created_at timestamptz NOT NULL DEFAULT now(), project_id uuid);
    CREATE TABLE legal_invoice_postings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text, journal_entry_id uuid);
    CREATE TABLE ap_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), amount_cents bigint);
    INSERT INTO management_companies (id) VALUES ('${MC}');
    INSERT INTO communities (id, name, management_company_id) VALUES ('${WV}', 'Waterview Estates', '${MC}');
    INSERT INTO properties (id, community_id, vantaca_account_id) VALUES ('${PROP}', '${WV}', '10111113');
    INSERT INTO ownership_tenures (id, community_id, property_id, start_date) VALUES ('${TENURE}', '${WV}', '${PROP}', '2020-01-01');
    INSERT INTO account_funds (id, community_id, fund_code) VALUES ('${FUND}', '${WV}', 'OPR');
    INSERT INTO chart_of_accounts (id, community_id, account_number, fund_id) VALUES
      ('${A1300}', '${WV}', '1300', '${FUND}'), ('${A5870}', '${WV}', '5870', '${FUND}'), ('${A2000}', '${WV}', '2000', '${FUND}'), ('${A5720}', '${WV}', '5720', '${FUND}');
    INSERT INTO vendors (id, name) VALUES ('${ATTY}', 'Attorney'), ('${AMZ}', 'Amazon.com');`);
  for (let m = 1; m <= 12; m++) {
    const s = `2026-${String(m).padStart(2, '0')}-01`;
    await db.query(`INSERT INTO accounting_periods (community_id, fiscal_year, period_number, period_start, period_end) VALUES ($1, 2026, $2, $3::date, ($3::date + interval '1 month' - interval '1 day')::date)`, [WV, m, s]);
  }
  await db.exec(lf(`${REPO}/migrations/359_je_reference_gap_tolerant.sql`).replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, ''));
  const m195 = lf(`${REPO}/migrations/195_homeowner_transactions.sql`);
  await db.exec(m195.slice(m195.indexOf('CREATE VIEW v_homeowner_current_balance AS'), m195.indexOf('GROUP BY t.community_id, t.vantaca_account_id, t.property_id, t.contact_id;') + 'GROUP BY t.community_id, t.vantaca_account_id, t.property_id, t.contact_id;'.length));
  const per = async (d) => (await db.query(`SELECT id FROM accounting_periods WHERE community_id = $1 AND $2::date BETWEEN period_start AND period_end`, [WV, d])).rows[0].id;
  // Production GL rows. JE-2026-00231 exists so the next number is not simply 00001.
  for (const [id, ref, d, cents, dr, cr] of [[null, 'JE-2026-00231', '2026-08-26', 100, A5870, A2000], [J42, 'JE-2026-00232', '2026-08-31', 4200, A1300, A5870], [J557, 'JE-2026-00425', '2026-10-11', 55735, A1300, A5870]]) {
    const r = await db.query(`INSERT INTO journal_entries (${id ? 'id, ' : ''}community_id, period_id, posting_date, reference, description, source_module, total_debits_cents, total_credits_cents, status)
      VALUES (${id ? `'${id}', ` : ''}$1, $2, $3, $4, 'seed', 'ap_billback', $5, $5, 'posted') RETURNING id`, [WV, await per(d), d, ref, cents]);
    const j = r.rows[0].id;
    await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, fund_id, debit_cents, vendor_id, memo) VALUES ($1, 1, $2, $3, $4, $5, 'dr')`, [j, dr, FUND, cents, ATTY]);
    await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, fund_id, credit_cents, vendor_id, memo) VALUES ($1, 2, $2, $3, $4, $5, 'cr')`, [j, cr, FUND, cents, ATTY]);
  }
  // Homeowner ledger: the legacy rows that make $1,044.35 less the two duplicates ($445 + $42 + $557.35 → seeded as one $445.00 row
  // so the account total is $1,044.35 with both duplicates), then the two duplicate native charges in their own committed batches.
  const batch = async (label) => (await db.query(`INSERT INTO transaction_upload_batches (management_company_id, community_id, period_label, as_of_date, status) VALUES ($1, $2, $3, '2026-07-31', 'committed') RETURNING id`, [MC, WV, label])).rows[0].id;
  await db.query(`INSERT INTO homeowner_transactions (source_batch_id, source_row_index, community_id, vantaca_account_id, property_id, transaction_date, description, txn_type, amount_cents, trusted_account_number, tenure_id)
    VALUES ($1, 0, $2, '10111113', $3, '2026-05-28', 'Legal Fees', 'charge', 44500, '1008671127', $4)`, [await batch('legacy'), WV, PROP, TENURE]);
  await db.query(`INSERT INTO homeowner_transactions (id, source_batch_id, source_row_index, community_id, vantaca_account_id, property_id, transaction_date, description, txn_type, charge_category, amount_cents, trusted_account_number, tenure_id, is_operator_override)
    VALUES ($1, $2, 0, $3, '10111113', $4, '2026-08-31', 'Legal Fees - Collections/DRV - Legal Fees / PS-INV343615', 'charge', 'attorney_fee', 4200, '1008671127', $5, true)`, [H42, await batch('dup42'), WV, PROP, TENURE]);
  await db.query(`INSERT INTO homeowner_transactions (id, source_batch_id, source_row_index, community_id, vantaca_account_id, property_id, transaction_date, description, txn_type, charge_category, amount_cents, trusted_account_number, raw_row_jsonb)
    VALUES ($1, $2, 0, $3, '10111113', $4, '2026-10-11', 'Legal Fees - DRV Enforcement (PS-INV350881)', 'charge', 'attorney_fee_other', 55735, '1008671127', $5)`, [H557, await batch('dup557'), WV, PROP, JSON.stringify({ journal_entry_id: J557 })]);
  // Amazon: the four mis-extracted lines.
  await db.query(`INSERT INTO ap_invoices (id, community_id, vendor_id, vendor_invoice_number, invoice_date, subtotal_cents, tax_cents, total_cents, status) VALUES ($1, $2, $3, '112-0467422-8439405', '2026-09-23', 2446, 259, 3404, 'awaiting_approval')`, [INV, WV, AMZ]);
  for (const [id, n, d, c] of [['6d97bd3a-499b-41f0-ad7a-48868055f90a', 1, 'Napkins', 499], ['02d8aabd-0ad9-495f-a1de-cceae537dec7', 2, 'Sheet protectors', 949], ['0e03f027-a357-45b1-9538-f25915e351be', 3, 'Shipping & Handling', 699], ['6f144203-22aa-45c5-8915-73752720afe6', 4, 'Estimated tax to be collected', 259]])
    await db.query(`INSERT INTO ap_invoice_lines (id, invoice_id, line_number, description, quantity, amount_cents, gl_account_id) VALUES ($1, $2, $3, $4, 1, $5, $6)`, [id, INV, n, d, c, A5720]);
  await db.exec(`INSERT INTO legal_invoice_postings (status, journal_entry_id) VALUES ('posted', '${J557}'); INSERT INTO ap_payments (amount_cents) VALUES (100);`);
  // The real ledger guards, in production order.
  await db.exec(lf(`${REPO}/migrations/502_month_end_close.sql`));
  if (fs.existsSync(`${REPO}/migrations/528_books_closed_guard.sql`)) await db.exec(lf(`${REPO}/migrations/528_books_closed_guard.sql`));
  await db.exec(lf(`${REPO}/migrations/529_posted_lines_immutable.sql`));
  await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('529_posted_lines_immutable.sql', 'recorded')`);
  const client = { query: async (sql, params) => {
    if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
    const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
  } };
  return { db, client };
}
function migDir(sql) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm557-e2e-'));
  fs.mkdirSync(path.join(dir, 'checks'));
  fs.writeFileSync(path.join(dir, F), sql);
  fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), CHECKS);
  return dir;
}
const ctxFor = (client, dir) => ({ client, user: { id: 'o', email: 'owner@example.test' }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });
const apply = async (client, dir) => {
  const ctx = ctxFor(client, dir); const plan = await A.planMigration({ ...ctx, filename: F });
  if (plan.status !== 'ready') return { plan };
  return { plan, r: await A.applyMigration({ ...ctx, planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) }) };
};

// ------------------------------------------------------------------ the real apply
const { db, client } = await build();
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const gl1300 = async () => Number((await one(`SELECT coalesce(sum(l.debit_cents - l.credit_cents), 0) n FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.journal_entry_id
  WHERE l.account_id = $1 AND j.status IN ('posted', 'voided') AND j.reference <> 'JE-2026-00231'`, [A1300])).n);
const sub = async () => Number((await one(`SELECT coalesce(sum(balance_cents), 0) n FROM v_homeowner_current_balance WHERE vantaca_account_id = '10111113'`)).n);
const others = async () => JSON.stringify(await q(`SELECT id, status, total_debits_cents FROM journal_entries WHERE id <> $1 ORDER BY reference`, [J42]));
const before = { gl: await gl1300(), sub: await sub(), others: await others() };
check('BEFORE: account 10111113 is $1,044.35 in the subledger; GL 1300 carries both duplicates ($599.35)', before.sub === 104435 && before.gl === 59935, JSON.stringify(before));

const dir = migDir(SQL);
const { plan, r } = await apply(client, dir);
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ s: plan.status, reason: plan.reason, pre: plan.preflight }).slice(0, 900));
check('apply: 557 applied and verified through the tool (row changes, protected tables, verify queries)', r && r.status === 'applied', JSON.stringify(r && { status: r.status, error: r.error, detail: r.detail }).slice(0, 1500));
if (!r || r.status !== 'applied') { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

const o = await one(`SELECT * FROM journal_entries WHERE id = $1`, [J42]);
const rev = await one(`SELECT * FROM journal_entries WHERE id = $1`, [o.void_reversal_je_id]);
check('the original is voided and names its reversal; the reversal is posted 8/31, source reversal, reverses it', o.status === 'voided' && rev.status === 'posted' && rev.reverses_je_id === J42
  && String(rev.posting_date.toISOString ? rev.posting_date.toISOString() : rev.posting_date).slice(0, 10) === '2026-08-31' && rev.source_module === 'reversal', JSON.stringify({ o: o.status, rev }));
check('the reversal takes the next reference (JE-2026-00426, gap-tolerant numbering)', rev.reference === 'JE-2026-00426', rev.reference);
const rl = await q(`SELECT account_id, fund_id, debit_cents::int d, credit_cents::int c, vendor_id FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY line_number`, [rev.id]);
check('reversal lines: Dr 5870 $42.00 / Cr 1300 $42.00, same fund and vendor', rl.length === 2 && rl[0].account_id === A1300 && rl[0].c === 4200 && rl[1].account_id === A5870 && rl[1].d === 4200 && rl.every((x) => x.fund_id === FUND && x.vendor_id === ATTY), JSON.stringify(rl));
const ol = await q(`SELECT debit_cents::int d, credit_cents::int c FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY line_number`, [J42]);
check('the original lines are untouched', ol.length === 2 && ol[0].d === 4200 && ol[1].c === 4200, JSON.stringify(ol));
const cr = await one(`SELECT h.*, b.status AS bstatus FROM homeowner_transactions h JOIN transaction_upload_batches b ON b.id = h.source_batch_id WHERE h.raw_row_jsonb->>'reverses_homeowner_transaction_id' = $1`, [H42]);
check('one committed -$42.00 credit on the same account and tenure, linked to the duplicate charge and both entries', cr && cr.amount_cents == -4200 && cr.bstatus === 'committed' && cr.tenure_id === TENURE
  && cr.vantaca_account_id === '10111113' && cr.raw_row_jsonb.reversal_journal_entry_id === rev.id && cr.raw_row_jsonb.reverses_journal_entry_id === J42 && Number(cr.running_balance_cents) === 100235, JSON.stringify(cr).slice(0, 600));
check('the duplicate charge is untouched', (await one(`SELECT amount_cents::int a, txn_type FROM homeowner_transactions WHERE id = $1`, [H42])).a === 4200);
const after = { gl: await gl1300(), sub: await sub() };
check('GL 1300 and the subledger BOTH fall by exactly $42.00 (no new difference)', before.gl - after.gl === 4200 && before.sub - after.sub === 4200, JSON.stringify({ before, after }));
check('no other journal entry changed', (await others()).replace(/"id":"[^"]+","status":"posted","total_debits_cents":"?4200"?,?/, '') !== null && JSON.parse(await others()).filter((x) => x.id !== rev.id).length === JSON.parse(before.others).length);
const al = await q(`SELECT description, amount_cents::int a, quantity::int qty FROM ap_invoice_lines WHERE invoice_id = $1 ORDER BY line_number`, [INV]);
const inv = await one(`SELECT status, posting_journal_entry_id, total_cents::int t, tax_cents::int x, notes FROM ap_invoices WHERE id = $1`, [INV]);
check('Amazon: 3 lines, napkins 3 x $4.99 = $14.97, lines = total - tax ($31.45), still unposted and awaiting approval, correction noted',
  al.length === 3 && al[0].a === 1497 && al[0].qty === 3 && al.reduce((s, x) => s + x.a, 0) === inv.t - inv.x && inv.status === 'awaiting_approval' && !inv.posting_journal_entry_id && /Migration 557/.test(inv.notes || ''), JSON.stringify({ al, inv }));

// ------------------------------------------------------------------ rerun refuses
const re = await apply(client, migDir(SQL));
check('RERUN: the tool refuses to apply 557 again; nothing changes', re.plan.status !== 'ready' || (re.r && re.r.status !== 'applied'), JSON.stringify(re.plan.status));
let rawErr = null; try { await db.exec(SQL); } catch (e) { rawErr = e.message; await db.exec('ROLLBACK'); }
check('RERUN (raw file): its own guards refuse a second reversal', /guard: JE-2026-00232/.test(rawErr || ''), rawErr);
check('after the refused reruns: still exactly one reversal and one credit', (await one(`SELECT count(*)::int n FROM journal_entries WHERE reverses_je_id = $1`, [J42])).n === 1
  && (await one(`SELECT count(*)::int n FROM homeowner_transactions WHERE raw_row_jsonb->>'reverses_homeowner_transaction_id' = $1`, [H42])).n === 1);

// ------------------------------------------------------------------ the $557.35 Legal Review treatment
// lib/legal/treatment.js reversePosting: void the entry with a reversal + an offsetting owner credit.
const per10 = (await one(`SELECT id FROM accounting_periods WHERE community_id = $1 AND DATE '2026-10-11' BETWEEN period_start AND period_end`, [WV])).id;
const r557 = (await one(`INSERT INTO journal_entries (community_id, period_id, posting_date, reference, description, source_module, total_debits_cents, total_credits_cents, reverses_je_id, status)
  VALUES ($1, $2, '2026-10-11', next_je_reference($1, 2026), 'VOID: JE-2026-00425', 'reversal', 55735, 55735, $3, 'posted') RETURNING id`, [WV, per10, J557])).id;
await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, fund_id, credit_cents) VALUES ($1, 1, $2, $3, 55735)`, [r557, A1300, FUND]);
await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, fund_id, debit_cents) VALUES ($1, 2, $2, $3, 55735)`, [r557, A5870, FUND]);
await db.query(`UPDATE journal_entries SET status = 'voided', voided_at = now(), void_reason = 'dup', void_reversal_je_id = $1 WHERE id = $2`, [r557, J557]);
const b557 = (await one(`INSERT INTO transaction_upload_batches (management_company_id, community_id, period_label, as_of_date, status) VALUES ($1, $2, 'c', '2026-10-11', 'committed') RETURNING id`, [MC, WV])).id;
await db.query(`INSERT INTO homeowner_transactions (source_batch_id, source_row_index, community_id, vantaca_account_id, property_id, transaction_date, description, txn_type, charge_category, amount_cents)
  VALUES ($1, 0, $2, '10111113', $3, '2026-10-11', 'Legal Fees - correction (reverses attorney bill-back)', 'adjustment', 'adjustment', -55735)`, [b557, WV, PROP]);
const fin = { gl: await gl1300(), sub: await sub() };
check('AFTER both corrections, before the conversion: the duplicates net to zero in GL 1300; the subledger is the $445.00 Vantaca import through 6/27', fin.gl === 0 && fin.sub === 44500, JSON.stringify(fin));
// The conversion then reverts the 6/27 import batch and opens the account at Vantaca's 7/31 aging ($1,044.35,
// which includes the 6/26 $42.00 and 7/30 $557.35 charges) in its own committed batch.
await db.query(`UPDATE transaction_upload_batches SET status = 'reverted' WHERE period_label = 'legacy'`);
const ob = (await one(`INSERT INTO transaction_upload_batches (management_company_id, community_id, period_label, as_of_date, status) VALUES ($1, $2, 'CONV-WE-20260731-AR', '2026-07-31', 'committed') RETURNING id`, [MC, WV])).id;
await db.query(`INSERT INTO homeowner_transactions (source_batch_id, source_row_index, community_id, vantaca_account_id, property_id, transaction_date, description, txn_type, amount_cents)
  VALUES ($1, 0, $2, '10111113', $3, '2026-07-31', 'Opening balance', 'balance_brought_forward', 104435)`, [ob, WV, PROP]);
const conv = { sub: await sub() };
check('AFTER the conversion: the subledger is $1,044.35 = Vantaca 7/31 aging, and the post-cutover duplicates add nothing in GL or subledger', conv.sub === 104435 && fin.gl === 0, JSON.stringify(conv));

// ------------------------------------------------------------------ atomicity
{
  const w = await build();
  const broken = SQL.replace("IF n <> 1 THEN RAISE EXCEPTION 'guard: duplicate tax line not removed'; END IF;", "RAISE EXCEPTION 'injected failure after every write but the last';");
  let e = null; try { await w.db.exec(broken); } catch (x) { e = x.message; await w.db.exec('ROLLBACK'); }
  const st = await w.db.query(`SELECT (SELECT status FROM journal_entries WHERE id = $1) s, (SELECT count(*)::int FROM journal_entries WHERE reverses_je_id = $1) r,
    (SELECT count(*)::int FROM homeowner_transactions WHERE raw_row_jsonb->>'reverses_homeowner_transaction_id' = $2) c, (SELECT count(*)::int FROM ap_invoice_lines WHERE invoice_id = $3) l`, [J42, H42, INV]);
  const s = st.rows[0];
  check('ATOMIC: a failure late in the file leaves no reversal, no void, no credit and no line change', /injected failure/.test(e || '') && s.s === 'posted' && s.r === 0 && s.c === 0 && s.l === 4, JSON.stringify({ e, s }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
