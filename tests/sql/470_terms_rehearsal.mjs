// tests/sql/470_terms_rehearsal.mjs — rehearsal for the PROPOSED migration 470
// (payment_terms_acceptances) on top of the 469 stub world: idempotent apply, the
// insert guard (acceptance must match the checkout's payments rows exactly),
// immutability, and an end-to-end apply through lib/migrations/apply_one.js with
// its real checks file. Skips without PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  470 terms-acceptance rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const { world469 } = await import('./_469_world.mjs');
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const M469 = lf(`${REPO}/migrations/469_payments_safe_foundation.sql`);
const M470 = lf(`${REPO}/migrations/470_payment_terms_acceptances.sql`);

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const expectErr = async (name, fn, re) => { try { await fn(); fail++; console.log('FAIL ', name, '(no error)'); } catch (e) { const ok = !re || re.test(e.message); ok ? pass++ : fail++; console.log(ok ? 'PASS ' : 'FAIL ', name, ok ? '' : e.message); } };

const C = '00000000-0000-0000-0000-00000000000c', P = '00000000-0000-0000-0000-0000000000a1', T = '00000000-0000-0000-0000-0000000000f1', U = '00000000-0000-0000-0000-0000000000b1';
async function world() {
  const db = new PGlite();
  const { stub, real } = world469(REPO);
  await db.exec(stub); await db.exec(real);
  await db.exec(`INSERT INTO communities VALUES ('${C}', gen_random_uuid(), '2026-07-01', false, NULL);
    INSERT INTO properties VALUES ('${P}', '${C}', '2013059', '1004384184');
    INSERT INTO ownership_tenures VALUES ('${T}', '${C}', '${P}', 'owner', '2026-01-01', NULL, '2013059');
    INSERT INTO portal_users (id, management_company_id, email, role, status) VALUES ('${U}', gen_random_uuid(), 'owner@example.test', 'homeowner', 'active');`);
  await db.exec(M469);
  return db;
}
const GROUP = '11111111-1111-4111-8111-111111111111';
const payRows = (db, group, amount, fee, method = 'card') => db.query(`INSERT INTO payments (community_id, product_type, fee_type, amount_cents, status, payment_group_id, property_id, tenure_id, trusted_account_number, payment_method_type, settlement_state, posting_state)
  VALUES ($1,'assessment_payment','assessment',$3,'pending',$2,$4,$5,'1004384184',$6,'awaiting_payment','not_posted')` + (fee > 0 ? `, ($1,'assessment_payment','convenience_fee',$7,'pending',$2,$4,$5,'1004384184',$6,'awaiting_payment','not_posted')` : ''),
  fee > 0 ? [C, group, amount, P, T, method, fee] : [C, group, amount, P, T, method]);
const accept = (db, o) => db.query(`INSERT INTO payment_terms_acceptances (payment_group_id, community_id, property_id, tenure_id, portal_user_id, actor_type, source, payment_method, amount_cents, fee_cents, total_cents, terms_version, terms_sha256, quote_issued_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'2026-09-27.2',$12, now())`,
  [o.group || GROUP, C, P, T, o.portal === undefined ? U : o.portal, o.actor || 'homeowner', o.source || 'portal', o.method || 'card', o.amount, o.fee, o.total === undefined ? o.amount + o.fee : o.total, o.sha || 'a'.repeat(64)]);

// ---- apply + idempotency + no data ----
const db = await world();
const cnt = async (t) => Number((await db.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n);
const before = { p: await cnt('payments'), h: await cnt('homeowner_transactions'), j: await cnt('journal_entries') };
await db.exec(M470); await db.exec(M470);
check('470 applies twice without error (idempotent) and creates no data', (await cnt('payment_terms_acceptances')) === 0
  && JSON.stringify(before) === JSON.stringify({ p: await cnt('payments'), h: await cnt('homeowner_transactions'), j: await cnt('journal_entries') }));

// ---- guard: acceptance must match the checkout exactly ----
await payRows(db, GROUP, 25000, 781);
await accept(db, { amount: 25000, fee: 781 });
check('an acceptance matching the checkout rows is recorded', (await cnt('payment_terms_acceptances')) === 1);
await expectErr('a second acceptance for the same checkout is refused', () => accept(db, { amount: 25000, fee: 781 }), /payment_group_id|duplicate/);
const G2 = '22222222-2222-4222-8222-222222222222';
await payRows(db, G2, 25000, 781);
await expectErr('acceptance with a different amount than the checkout is refused', () => accept(db, { group: G2, amount: 24000, fee: 781 }), /does not match the checkout/);
await expectErr('acceptance with a different fee than the checkout is refused', () => accept(db, { group: G2, amount: 25000, fee: 0 }), /fee 0 does not match/);
await expectErr('acceptance with a different method than the checkout is refused', () => accept(db, { group: G2, amount: 25000, fee: 781, method: 'us_bank_account' }), /does not match the checkout/);
await expectErr('acceptance whose total is not amount + fee is refused', () => accept(db, { group: G2, amount: 25000, fee: 781, total: 25000 }), /total_check/);
await expectErr('acceptance for a checkout with no payments rows is refused', () => accept(db, { group: '33333333-3333-4333-8333-333333333333', amount: 100, fee: 0 }), /no checkout payment rows/);
await expectErr('a homeowner acceptance must name the portal user', () => accept(db, { group: G2, amount: 25000, fee: 781, portal: null }), /portal_actor_check/);
await expectErr('terms hash must be a sha256', () => accept(db, { group: G2, amount: 25000, fee: 781, sha: 'nothex' }), /terms_sha256_check/);
const G3 = '44444444-4444-4444-8444-444444444444';
await payRows(db, G3, 100, 0, 'us_bank_account');
await accept(db, { group: G3, amount: 100, fee: 0, method: 'us_bank_account', actor: 'payment_link', source: 'pay_link', portal: null });
check('an ACH pay-link acceptance with no fee and no portal user is recorded', (await cnt('payment_terms_acceptances')) === 2);

// ---- immutability ----
await expectErr('an acceptance cannot be updated', () => db.query(`UPDATE payment_terms_acceptances SET amount_cents = 1`), /permanent/);
await expectErr('an acceptance cannot be deleted', () => db.query(`DELETE FROM payment_terms_acceptances`), /permanent/);
check('both acceptances intact', (await cnt('payment_terms_acceptances')) === 2);

// ---- end to end through the single-migration tool with the real checks file ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm470-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, '470_payment_terms_acceptances.sql'), M470);
fs.writeFileSync(path.join(dir, 'checks', '470_payment_terms_acceptances.json'), lf(`${REPO}/migrations/checks/470_payment_terms_acceptances.json`));
const db2 = await world();
await db2.exec(`CREATE TABLE journal_entry_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), journal_entry_id uuid);
  CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
  INSERT INTO schema_migrations (filename, sha256) VALUES ('468_schema_migrations_service_role_access.sql', 'r'), ('469_payments_safe_foundation.sql', 'r');`);
const client = { query: async (sql, params) => {
  if (params) { const r = await db2.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
  const rs = await db2.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
} };
const ctx = { client, user: { id: 'owner', email: 'owner@example.test' }, deployedCommit: 'feedface', migrationsDir: dir, secret: 's' };
const plan = await A.planMigration({ ...ctx, filename: '470_payment_terms_acceptances.sql' });
check('tool plan: 470 ready, all preflight green', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify(plan.preflight || plan.reason));
const r = await A.applyMigration({ ...ctx, planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('tool apply: 470 applied, verified, recorded; no rows written', r.status === 'applied' && r.detail.verify.every((v) => v.ok) && r.detail.protected.every((p) => p.unchanged) && r.detail.tables_written.length === 0,
  JSON.stringify({ status: r.status, error: r.error, written: r.detail && r.detail.tables_written }).slice(0, 400));
check('tool: schema objects exactly as declared (39 added, 0 changed, 0 removed)', r.detail && r.detail.objects.added.length === 39 && r.detail.objects.changed.length === 0 && r.detail.objects.removed.length === 0);
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
