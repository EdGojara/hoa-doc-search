// tests/sql/471_deposit_followups_rehearsal.mjs — rehearsal for the PROPOSED migration
// 471 (vendor deposit follow-ups) on top of the REAL 364 vendor_deposits table.
// Proves the SQL side of the review fixes: idempotent apply, no data; follow-up
// update + audit event atomic; direct UPDATE of vendor_deposits denied to the
// service role (only the audited function); proposals + decisions via functions
// with row locks, identity required, admin-only decisions, one terminal decision,
// supersession, and manual_accounting_recorded live checks (net > 0, bill total =
// net, deposit paid unchanged, posted JE in the community, one applied bill per
// deposit); a refused call writes NOTHING; append-only ledger; grants; and an
// end-to-end apply through lib/migrations/apply_one.js with its real checks file.
// Skips without PGlite. DUMP_471_OBJECTS=1 prints the object diff.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  471 deposit follow-up rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const M364 = lf(`${REPO}/migrations/364_vendor_deposits.sql`);
const M471 = lf(`${REPO}/migrations/471_vendor_deposit_followups.sql`);

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const expectErr = async (name, fn, re) => { try { await fn(); fail++; console.log('FAIL ', name, '(no error)'); } catch (e) { const ok = !re || re.test(e.message); ok ? pass++ : fail++; console.log(ok ? 'PASS ' : 'FAIL ', name, ok ? '' : e.message); } };

const C = '00000000-0000-0000-0000-00000000000c', C2 = '00000000-0000-0000-0000-00000000000d', V = '00000000-0000-0000-0000-0000000000e1';
const INV_DEP = '00000000-0000-0000-0000-0000000000a1', INV_FIN = '00000000-0000-0000-0000-0000000000a2', INV_FULL = '00000000-0000-0000-0000-0000000000a3', INV_OTHER = '00000000-0000-0000-0000-0000000000a4';
const DEP = '00000000-0000-0000-0000-0000000000d1';
const JE_OK = '00000000-0000-0000-0000-0000000000f1', JE_DRAFT = '00000000-0000-0000-0000-0000000000f2', JE_OTHER = '00000000-0000-0000-0000-0000000000f3';
const JE_DEP = '00000000-0000-0000-0000-0000000000f4', JE_AMT = '00000000-0000-0000-0000-0000000000f5', JE_ACCT = '00000000-0000-0000-0000-0000000000f6';
const A1430 = '00000000-0000-0000-0000-000000001430', AEXP = '00000000-0000-0000-0000-000000005900';
const U_EMMA = '00000000-0000-0000-0000-000000000111', U_ED = '00000000-0000-0000-0000-000000000222', U_M = '00000000-0000-0000-0000-000000000333';
const STUB = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE OR REPLACE FUNCTION trusted_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
  CREATE TABLE communities (id uuid primary key, name text);
  CREATE TABLE vendors (id uuid primary key, name text);
  CREATE TABLE chart_of_accounts (id uuid primary key default gen_random_uuid(), account_number text);
  CREATE TABLE journal_entries (id uuid primary key default gen_random_uuid(), community_id uuid, status text NOT NULL DEFAULT 'posted', reference text);
  CREATE TABLE journal_entry_lines (id uuid primary key default gen_random_uuid(), journal_entry_id uuid, account_id uuid, debit_cents bigint NOT NULL DEFAULT 0, credit_cents bigint NOT NULL DEFAULT 0);
  CREATE TABLE ap_invoice_lines (id uuid primary key default gen_random_uuid(), invoice_id uuid, gl_account_id uuid, amount_cents bigint);
  CREATE TABLE ap_invoices (id uuid primary key, community_id uuid NOT NULL, vendor_id uuid NOT NULL, vendor_invoice_number text, total_cents bigint NOT NULL CHECK (total_cents > 0),
    amount_paid_cents bigint NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'awaiting_approval', posting_journal_entry_id uuid);
  CREATE TABLE ap_payments (id uuid primary key default gen_random_uuid(), amount_cents bigint);
  CREATE TABLE vendor_projects (id uuid primary key default gen_random_uuid(), community_id uuid NOT NULL, title text);
`;
async function world() {
  const db = new PGlite();
  await db.exec(STUB);
  await db.exec(`INSERT INTO communities VALUES ('${C}', 'Waterview Estates'), ('${C2}', 'Other'); INSERT INTO vendors VALUES ('${V}', 'PRYME THYME KOOKERS');
    INSERT INTO ap_invoices (id, community_id, vendor_id, vendor_invoice_number, total_cents) VALUES
      ('${INV_DEP}', '${C}', '${V}', '2836', 334250), ('${INV_FIN}', '${C}', '${V}', '2901', 334250), ('${INV_FULL}', '${C}', '${V}', '2902', 668500), ('${INV_OTHER}', '${C2}', '${V}', '77', 100);
    INSERT INTO journal_entries (id, community_id, status, reference) VALUES ('${JE_OK}', '${C}', 'posted', 'JE-1'), ('${JE_DRAFT}', '${C}', 'draft', 'JE-2'), ('${JE_OTHER}', '${C2}', 'posted', 'JE-3'),
      ('${JE_DEP}', '${C}', 'posted', 'JE-DEP'), ('${JE_AMT}', '${C}', 'posted', 'JE-AMT'), ('${JE_ACCT}', '${C}', 'posted', 'JE-ACCT');
    -- The deposit was booked PREPAID: its accrual debits 1430.
    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit_cents, credit_cents) VALUES
      ('${JE_DEP}', '${A1430}', 334250, 0),
      ('${JE_OK}', '${AEXP}', 334250, 0), ('${JE_OK}', '${A1430}', 0, 334250),
      ('${JE_DRAFT}', '${A1430}', 0, 334250), ('${JE_OTHER}', '${A1430}', 0, 334250),
      ('${JE_AMT}', '${AEXP}', 300000, 0), ('${JE_AMT}', '${A1430}', 0, 300000),
      ('${JE_ACCT}', '${AEXP}', 334250, 0), ('${JE_ACCT}', '${AEXP}', 0, 334250);
    UPDATE ap_invoices SET posting_journal_entry_id = '${JE_DEP}' WHERE id = '${INV_DEP}';
    INSERT INTO journal_entries (id, community_id, status, reference) VALUES ('00000000-0000-0000-0000-0000000000b1', '${C}', 'posted', 'JE-FIN'), ('00000000-0000-0000-0000-0000000000b2', '${C}', 'posted', 'JE-FULL');
    UPDATE ap_invoices SET posting_journal_entry_id = '00000000-0000-0000-0000-0000000000b1' WHERE id = '${INV_FIN}';
    UPDATE ap_invoices SET posting_journal_entry_id = '00000000-0000-0000-0000-0000000000b2' WHERE id = '${INV_FULL}';
    INSERT INTO ap_invoice_lines (invoice_id, gl_account_id, amount_cents) VALUES ('${INV_FIN}', '${AEXP}', 334250);`);
  await db.exec(M364);
  await db.exec(`INSERT INTO vendor_deposits (id, community_id, vendor_id, deposit_invoice_id, gl_account_id, deposit_amount_cents, remaining_balance_cents) VALUES ('${DEP}', '${C}', '${V}', '${INV_DEP}', '${A1430}', 334250, 334250);`);
  return db;
}
const n = async (db, sql) => Number((await db.query(sql)).rows[0].n);

// ---- apply twice, no data, existing deposit untouched ----
const db = await world();
const snap = async () => JSON.stringify((await db.query(`SELECT id, deposit_amount_cents, remaining_balance_cents, status FROM vendor_deposits ORDER BY id`)).rows);
const before = await snap();
await db.exec(M471); await db.exec(M471);
check('471 applies twice (idempotent); existing deposit unchanged; nothing created', before === await snap() && await n(db, `SELECT count(*)::int n FROM vendor_deposit_reconciliations`) === 0);

// ---- follow-up via the audited function ----
const setF = (patch, user = U_ED) => db.query(`SELECT vendor_deposit_set_followup($1, $2::jsonb, 'Ed', $3) AS r`, [DEP, JSON.stringify(patch), user]);
await expectErr('follow-up needs an identity', () => setF({ balance_due_date: '2026-10-10' }, null), /identity_required/);
await setF({ event_date: '2026-10-10', balance_due_date: '2026-10-10', balance_due_basis: 'staff_entered', agreed_total_cents: 668500, agreed_total_basis: 'invoice_estimate' });
check('follow-up recorded with its audit event', (await db.query(`SELECT balance_due_date::text d FROM vendor_deposits WHERE id='${DEP}'`)).rows[0].d === '2026-10-10'
  && await n(db, `SELECT count(*)::int n FROM vendor_deposit_events WHERE event_type='followup_set'`) === 1);
await expectErr('an agreed total without a basis is refused', () => setF({ agreed_total_cents: 700000, agreed_total_basis: null }), /needs_basis|check/i);
check('...and the refused update wrote no event (atomic)', await n(db, `SELECT count(*)::int n FROM vendor_deposit_events`) === 1);

// ---- the service role can't bypass the audited function ----
await db.exec(`GRANT USAGE ON SCHEMA public TO service_role;`);
let roleOk = true;
try { await db.exec(`SET ROLE service_role`); } catch (_) { roleOk = false; }
if (roleOk) {
  await expectErr('service role: direct UPDATE of a follow-up column is denied', () => db.query(`UPDATE vendor_deposits SET balance_due_date = '2027-01-01'`), /permission denied/);
  await db.query(`UPDATE vendor_deposits SET notes = 'staff note' WHERE id = '${DEP}'`);
  check('service role: updating pre-existing columns (notes/status) still works', (await db.query(`SELECT notes FROM vendor_deposits WHERE id = '${DEP}'`)).rows[0].notes === 'staff note');
  await expectErr('service role: direct INSERT into the reconciliation ledger is denied', () => db.query(`INSERT INTO vendor_deposit_events (deposit_id, event_type, actor) VALUES ('${DEP}', 'followup_set', 'x')`), /permission denied/);
  const r = await db.query(`SELECT vendor_deposit_set_followup($1, '{"notes":"via function"}'::jsonb, 'Ed', $2) AS r`, [DEP, U_ED]);
  check('service role: the audited function still works (SECURITY DEFINER)', r.rows[0].r.notes === 'via function');
  await db.exec(`RESET ROLE`);
} else { check('SET ROLE unsupported here; role checks covered by grants test below', true); }

// ---- proposals ----
const propose = (inv, o = {}) => db.query(`SELECT vendor_deposit_propose($1::jsonb) AS id`, [JSON.stringify({
  deposit_id: DEP, incoming_invoice_id: inv, form: o.form || 'balance_only', deposit_billed_cents: 334250, deposit_paid_cents: o.paid ?? 0, deposit_still_owed_cents: o.owed ?? 334250,
  incoming_face_cents: o.face || 334250, net_due_cents: o.net ?? 334250, final_total_cents: 668500, needs_review: false, proposed_by: o.by === undefined ? 'emma' : o.by, proposed_by_user_id: o.byId || U_EMMA })]).then((r) => r.rows[0].id);
await expectErr('proposal needs an identity', () => propose(INV_FIN, { by: '' }), /identity_required/);
await expectErr('proposal against the deposit\'s own bill is refused', () => propose(INV_DEP), /same_as_deposit_invoice/);
await expectErr('proposal across communities is refused', () => propose(INV_OTHER), /vendor_or_community_mismatch/);
await expectErr('deposit paid + still owed must equal billed', () => propose(INV_FIN, { paid: 1, owed: 1 }), /paid_check/);
const r1 = await propose(INV_FIN);
check('proposal recorded with its event', !!r1 && await n(db, `SELECT count(*)::int n FROM vendor_deposit_events WHERE event_type='reconciliation_proposed'`) === 1);

// ---- decisions ----
const decide = (rec, decision, o = {}) => db.query(`SELECT vendor_deposit_decide($1, $2, $3, $4, $5, $6, $7, $8, $9) AS id`,
  [rec, decision, o.actor || 'Ed', o.user === undefined ? U_ED : o.user, o.role || 'admin', o.note === undefined ? 'ok' : o.note, o.je || null, o.net ?? null, o.paid ?? null]);
const counts = async () => `${await n(db, `SELECT count(*)::int n FROM vendor_deposit_reconciliation_decisions`)}/${await n(db, `SELECT count(*)::int n FROM vendor_deposit_events`)}`;
let c0 = await counts();
await expectErr('decision needs an identity', () => decide(r1, 'confirmed_match', { user: null }), /identity_required/);
await expectErr('the proposer cannot decide', () => decide(r1, 'confirmed_match', { user: U_EMMA }), /proposer_cannot_decide/);
await expectErr('"unrelated" is admin-only', () => decide(r1, 'unrelated', { role: 'staff', user: U_M }), /admin_required/);
await expectErr('a reject needs a note', () => decide(r1, 'reject', { note: '' }), /note_required/);
await expectErr('manual accounting refuses a non-positive net', () => decide(r1, 'manual_accounting_recorded', { je: JE_OK, net: 0, paid: 0 }), /net_due_not_positive/);
await expectErr('manual accounting refuses when the bill total is not the net due', () => decide(r1, 'manual_accounting_recorded', { je: JE_OK, net: 334000, paid: 0 }), /invoice_total_not_net_due/);
await expectErr('manual accounting refuses a bill whose own entry is not posted', async () => { await db.exec(`UPDATE journal_entries SET status = 'draft' WHERE reference = 'JE-FIN'`);
  try { await decide(r1, 'manual_accounting_recorded', { je: JE_OK, net: 334250, paid: 0 }); } finally { await db.exec(`UPDATE journal_entries SET status = 'posted' WHERE reference = 'JE-FIN'`); } }, /bill_not_posted/);
await expectErr('manual accounting refuses a stale deposit-paid snapshot', () => decide(r1, 'manual_accounting_recorded', { je: JE_OK, net: 334250, paid: 334250 }), /stale_reconciliation/);
await expectErr('manual accounting refuses an unposted JE', () => decide(r1, 'manual_accounting_recorded', { je: JE_DRAFT, net: 334250, paid: 0 }), /accounting_je_invalid/);
await expectErr('manual accounting refuses a JE from another community', () => decide(r1, 'manual_accounting_recorded', { je: JE_OTHER, net: 334250, paid: 0 }), /accounting_je_invalid/);
await expectErr('prepaid deposit: a JE crediting 1430 for the wrong amount does not relieve it', () => decide(r1, 'manual_accounting_recorded', { je: JE_AMT, net: 334250, paid: 0 }), /je_does_not_relieve_deposit/);
await expectErr('prepaid deposit: a JE that never touches 1430 does not relieve it', () => decide(r1, 'manual_accounting_recorded', { je: JE_ACCT, net: 334250, paid: 0 }), /je_does_not_relieve_deposit/);
await expectErr('prepaid deposit: no JE at all (and the bill\'s own accrual has no 1430 credit) is refused', () => decide(r1, 'manual_accounting_recorded', { je: null, net: 334250, paid: 0 }), /je_does_not_relieve_deposit|accounting_je_required/);
check('every refused decision wrote NOTHING (atomic)', c0 === await counts(), `${c0} vs ${await counts()}`);
await decide(r1, 'confirmed_match', { role: 'staff', user: U_M, note: null });
await expectErr('only one confirmed_match per reconciliation', () => decide(r1, 'confirmed_match'), /already_decided|duplicate/);
await decide(r1, 'manual_accounting_recorded', { je: JE_OK, net: 334250, paid: 0, note: 'Dr 5900 / Cr 1430 relieved' });
const snapRow = (await db.query(`SELECT verified_bill_posting_je_id j, verified_bill_lines l FROM vendor_deposit_reconciliation_decisions WHERE reconciliation_id = $1 AND decision = 'manual_accounting_recorded'`, [r1])).rows[0];
check('the attestation records what it was made against (bill posting JE + GL lines) for the gate to re-check',
  snapRow && snapRow.j === '00000000-0000-0000-0000-0000000000b1' && snapRow.l.length === 1 && snapRow.l[0].gl_account_id === AEXP && Number(snapRow.l[0].amount_cents) === 334250, JSON.stringify(snapRow));
check('confirmed match then manual accounting recorded, each with its event', await n(db, `SELECT count(*)::int n FROM vendor_deposit_reconciliation_decisions WHERE reconciliation_id='${r1}'`) === 2
  && await n(db, `SELECT count(*)::int n FROM vendor_deposit_events WHERE event_type='reconciliation_decided'`) === 2);
await expectErr('no second terminal decision', () => decide(r1, 'reject'), /already_decided/);
const rFull = await propose(INV_FULL, { face: 668500 });
await expectErr('the deposit cannot be applied to a second bill', async () => { await db.exec(`UPDATE ap_invoices SET total_cents = 334250 WHERE id = '${INV_FULL}'`); await decide(rFull, 'manual_accounting_recorded', { je: JE_OK, net: 334250, paid: 0 }); }, /deposit_already_applied_elsewhere/);
const rOld = await propose(INV_FULL, { form: 'ambiguous', net: null });
const rNew = await propose(INV_FULL);
await expectErr('a superseded proposal cannot be decided', () => decide(rOld, 'reject'), /superseded/);
await expectErr('manual accounting refuses a non-payable form', async () => { const x = await propose(INV_FULL, { form: 'duplicate_or_statement', net: 0 }); await decide(x, 'manual_accounting_recorded', { je: JE_OK, net: 334250, paid: 0 }); }, /form_not_payable/);
await decide(rNew, 'unrelated', { note: 'different job' }).catch(() => {});

// ---- accounting-state scenarios on fresh deposits ----
const extraDeposit = async (tag, { prepaid, finalLines = [], finalJeLines = [] }) => {
  const dep = `00000000-0000-0000-0000-0000000d${tag}000`.slice(0, 36), di = `00000000-0000-0000-0000-0000000a${tag}001`.slice(0, 36), fi = `00000000-0000-0000-0000-0000000a${tag}002`.slice(0, 36);
  const dje = `00000000-0000-0000-0000-0000000e${tag}001`.slice(0, 36), fje = `00000000-0000-0000-0000-0000000e${tag}002`.slice(0, 36);
  await db.exec(`INSERT INTO journal_entries (id, community_id, status) VALUES ('${dje}', '${C}', 'posted'), ('${fje}', '${C}', 'posted');
    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit_cents) VALUES ('${dje}', '${prepaid ? A1430 : AEXP}', 334250);
    INSERT INTO ap_invoices (id, community_id, vendor_id, vendor_invoice_number, total_cents, posting_journal_entry_id) VALUES ('${di}', '${C}', '${V}', 'D${tag}', 334250, '${dje}'), ('${fi}', '${C}', '${V}', 'F${tag}', 334250, '${fje}');
    INSERT INTO vendor_deposits (id, community_id, vendor_id, deposit_invoice_id, gl_account_id, deposit_amount_cents, remaining_balance_cents) VALUES ('${dep}', '${C}', '${V}', '${di}', '${A1430}', 334250, 334250);`);
  for (const [acct, amt] of finalLines) await db.query(`INSERT INTO ap_invoice_lines (invoice_id, gl_account_id, amount_cents) VALUES ($1, $2, $3)`, [fi, acct, amt]);
  for (const [acct, dr, cr] of finalJeLines) await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit_cents, credit_cents) VALUES ($1, $2, $3, $4)`, [fje, acct, dr, cr]);
  const rec = (await db.query(`SELECT vendor_deposit_propose($1::jsonb) AS id`, [JSON.stringify({ deposit_id: dep, incoming_invoice_id: fi, form: 'balance_only', deposit_billed_cents: 334250,
    deposit_paid_cents: 0, deposit_still_owed_cents: 334250, incoming_face_cents: 334250, net_due_cents: 334250, final_total_cents: 668500, needs_review: false, proposed_by: 'emma', proposed_by_user_id: U_EMMA })])).rows[0].id;
  return { dep, fi, rec };
};
{
  const x = await extraDeposit('2', { prepaid: true });
  await expectErr('a relieving JE cannot be reused for another deposit', () => decide(x.rec, 'manual_accounting_recorded', { je: JE_OK, net: 334250, paid: 0 }), /accounting_je_already_used|uq_vdrd_je_used_once/);
  const y = await extraDeposit('3', { prepaid: true, finalLines: [[AEXP, 668500], [A1430, -334250]], finalJeLines: [[AEXP, 668500, 0], [A1430, 0, 334250]] });
  await decide(y.rec, 'manual_accounting_recorded', { je: null, net: 334250, paid: 0, note: 'credit line on the bill relieved 1430' });
  const yRow = (await db.query(`SELECT deposit_accounting_state s, accounting_je_id j FROM vendor_deposit_reconciliation_decisions WHERE reconciliation_id = $1 AND decision = 'manual_accounting_recorded'`, [y.rec])).rows[0];
  check('prepaid: the final bill\'s own accrual with a 1430 credit counts as the relief entry', yRow && yRow.s === 'prepaid' && !!yRow.j, JSON.stringify(yRow));
  const z = await extraDeposit('4', { prepaid: false, finalLines: [[AEXP, 334250]] });
  await expectErr('expensed deposit: a relief JE is refused (nothing to relieve)', () => decide(z.rec, 'manual_accounting_recorded', { je: JE_DRAFT, net: 334250, paid: 0 }), /no_relief_entry_for_expensed_deposit/);
  const w = await extraDeposit('5', { prepaid: false, finalLines: [[AEXP, 668500], [A1430, -334250]] });
  await expectErr('expensed deposit: a final bill that touches 1430 is refused', () => decide(w.rec, 'manual_accounting_recorded', { je: null, net: 334250, paid: 0 }), /final_bill_touches_deposit_account/);
  await decide(z.rec, 'manual_accounting_recorded', { je: null, net: 334250, paid: 0, note: 'deposit already expensed; bill is the balance' });
  const zRow = (await db.query(`SELECT deposit_accounting_state s, accounting_je_id j FROM vendor_deposit_reconciliation_decisions WHERE reconciliation_id = $1 AND decision = 'manual_accounting_recorded'`, [z.rec])).rows[0];
  check('expensed: recorded with no relief entry and state "expensed"', zRow && zRow.s === 'expensed' && zRow.j === null, JSON.stringify(zRow));
}

// ---- ledger immutability + grants ----
await expectErr('a reconciliation cannot be edited', () => db.query(`UPDATE vendor_deposit_reconciliations SET net_due_cents = 1`), /permanent/);
await expectErr('a decision cannot be deleted', () => db.query(`DELETE FROM vendor_deposit_reconciliation_decisions`), /permanent/);
await expectErr('an event cannot be deleted', () => db.query(`DELETE FROM vendor_deposit_events`), /permanent/);
await expectErr('a deposit with reconciliations cannot be deleted', () => db.query(`DELETE FROM vendor_deposits WHERE id='${DEP}'`), /foreign key|violates/i);
check('no payment was written by any of this', await n(db, `SELECT count(*)::int n FROM ap_payments`) === 0);
const g = (await db.query(`SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants WHERE table_name LIKE 'vendor_deposit%'`)).rows;
check('ledger: service_role SELECT only; nothing for anon/authenticated',
  ['vendor_deposit_reconciliations', 'vendor_deposit_reconciliation_decisions', 'vendor_deposit_events'].every((t) => g.filter((x) => x.table_name === t && x.grantee === 'service_role').map((x) => x.privilege_type).join() === 'SELECT')
  && !g.some((x) => ['anon', 'authenticated'].includes(x.grantee) && x.table_name !== 'vendor_deposits'), JSON.stringify(g));
const colPriv = async (col) => (await db.query(`SELECT has_column_privilege('service_role', 'vendor_deposits', $1, 'UPDATE') p`, [col])).rows[0].p;
check('vendor_deposits: every pre-existing column still UPDATE-able by service_role (existing workflows unaffected)',
  (await Promise.all(['status', 'applied_invoice_id', 'applied_at', 'notes', 'remaining_balance_cents', 'deposit_amount_cents', 'gl_account_id', 'project_description', 'vendor_id', 'deposit_invoice_id', 'updated_at'].map(colPriv))).every(Boolean));
check('vendor_deposits: the six follow-up columns are function-only', !(await Promise.all(['event_date', 'balance_due_date', 'balance_due_basis', 'agreed_total_cents', 'agreed_total_basis', 'project_id'].map(colPriv))).some(Boolean));
check('vendor_deposits: DELETE/INSERT/SELECT unchanged for service_role', (await db.query(`SELECT has_table_privilege('service_role', 'vendor_deposits', 'DELETE') d, has_table_privilege('service_role', 'vendor_deposits', 'INSERT') i, has_table_privilege('service_role', 'vendor_deposits', 'SELECT') s`)).rows.every((r) => r.d && r.i && r.s));
const fx = (await db.query(`SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('service_role', p.oid, 'EXECUTE') s
  FROM pg_proc p WHERE p.proname IN ('vendor_deposit_set_followup', 'vendor_deposit_propose', 'vendor_deposit_decide')`)).rows;
check('functions: EXECUTE for service_role only', fx.length === 3 && fx.every((f) => f.s && !f.a), JSON.stringify(fx));

// ---- end to end through the single-migration tool with the real checks file ----
const checksPath = `${REPO}/migrations/checks/471_vendor_deposit_followups.json`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm471-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, '471_vendor_deposit_followups.sql'), M471);
fs.writeFileSync(path.join(dir, 'checks', '471_vendor_deposit_followups.json'), process.env.DUMP_471_OBJECTS || !fs.existsSync(checksPath) ? JSON.stringify({
  migration: '471_vendor_deposit_followups.sql', summary: 'dump', requires: [], preflight: [], expected_changes: ['x'], objects: { added: [], changed: [], removed: [] }, row_changes: {}, protected: [], verify: [], api_checks: [], reload_schema: true }) : lf(checksPath));
const db2 = await world();
await db2.exec(`CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
  INSERT INTO schema_migrations (filename, sha256) VALUES ('321_vendor_projects.sql', 'r'), ('364_vendor_deposits.sql', 'r');`);
const client = { query: async (sql, params) => {
  if (params) { const r = await db2.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
  const rs = await db2.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
} };
const ctx = { client, user: { id: 'owner', email: 'owner@example.test' }, deployedCommit: 'feedface', migrationsDir: dir, secret: 's' };
const plan = await A.planMigration({ ...ctx, filename: '471_vendor_deposit_followups.sql' });
check('tool plan: 471 ready, all preflight green', plan.status === 'ready' && (plan.preflight || []).every((p) => p.ok), JSON.stringify(plan.preflight || plan.reason));
const r = await A.applyMigration({ ...ctx, planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
if (process.env.DUMP_471_OBJECTS) console.log(JSON.stringify({ status: r.status, error: r.error, objects: r.detail && r.detail.objects }, null, 1));
check('tool apply: 471 applied, verified, recorded; no rows written', r.status === 'applied' && r.detail.verify.every((v) => v.ok) && r.detail.protected.every((p) => p.unchanged) && r.detail.tables_written.length === 0,
  JSON.stringify({ status: r.status, error: r.error, written: r.detail && r.detail.tables_written }).slice(0, 500));
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
