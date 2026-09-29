// tests/sql/474_apply_one_e2e.mjs — migration 474 (attorney-PDF extractions,
// Issue #9 step 2b) applied END TO END through the single-migration tool
// (lib/migrations/apply_one.js) with its REAL checks file, on top of a stub
// world where 473 is already applied (a saved draft included). Proves:
//   - the checks file matches exactly what 474 does (objects, row changes,
//     protected tables untouched, verify);
//   - the extraction rules hold (a failed read records why; a completed read
//     keeps the raw output; append-only for the service role; browser roles
//     have no access);
//   - items accept the 'pdf_entry' source, and the save function persists
//     extraction_id and refuses an extraction from another invoice;
//   - an existing draft survives the migration untouched;
//   - drift blocks it (the table already present stops the plan).
// Postgres 17 (PGlite 0.3.x). Skips without PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  474 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '474_legal_invoice_extractions.sql';
const F473 = '473_legal_invoice_review.sql';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };

const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm474-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const PRINT = process.argv.includes('--print-objects');

const V = { winstead: '22488091-2642-489d-a84a-50c72fb05645', df: '35f76d51-0753-4f9f-b46d-df3c73d6092a', rmwbh: 'ee565db3-2c94-4830-8855-ccea1740dfa7' };
const C = 'a0000000-0000-4000-8000-000000000001';
const INV = 'e0000000-0000-4000-8000-000000000001', INV2 = 'e0000000-0000-4000-8000-000000000002';
const P1 = 'c0000000-0000-4000-8000-000000000001';

async function buildWorld({ preExtractions = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE OR REPLACE FUNCTION trusted_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
    CREATE TABLE communities (id uuid PRIMARY KEY, name text);
    CREATE TABLE vendors (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE properties (id uuid PRIMARY KEY, community_id uuid, street_address text);
    CREATE TABLE ownership_tenures (id uuid PRIMARY KEY, community_id uuid, property_id uuid, kind text, start_date date, end_date date);
    CREATE TABLE ap_invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid, vendor_id uuid, total_cents bigint);
    CREATE TABLE ap_invoice_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid, amount_cents bigint);
    CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid, source_module text);
    CREATE TABLE journal_entry_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), journal_entry_id uuid, debit_cents bigint);
    CREATE TABLE homeowner_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid, amount_cents bigint);
    CREATE TABLE library_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid, category text, file_hash text);
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO communities VALUES ('${C}', 'Sample HOA');
    INSERT INTO vendors VALUES ('${V.winstead}', 'Winstead PC'), ('${V.df}', 'DAUGHTRY & FARINE, P.C.'), ('${V.rmwbh}', 'RMWBH');
    INSERT INTO properties VALUES ('${P1}', '${C}', '4101 Sample Meadow Dr');
    INSERT INTO ownership_tenures VALUES ('d0000000-0000-4000-8000-000000000001', '${C}', '${P1}', 'owner', '2020-01-01', NULL);
    INSERT INTO ap_invoices (id, community_id, vendor_id, total_cents) VALUES ('${INV}', '${C}', '${V.df}', 33300), ('${INV2}', '${C}', '${V.df}', 5000);
    INSERT INTO ap_invoice_lines (invoice_id, amount_cents) VALUES ('${INV}', 32400), ('${INV}', 900);
    INSERT INTO journal_entries (community_id, source_module) VALUES ('${C}', 'ap_invoice');
    INSERT INTO homeowner_transactions (community_id, amount_cents) VALUES ('${C}', 100);`);
  // 473 is already live: apply it as production did, and record it.
  await db.exec(lf(`${REPO}/migrations/${F473}`));
  await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('469_payments_safe_foundation.sql', 'recorded'), ('472_vendor_invoice_document_unique.sql', 'recorded'), ('${F473}', 'recorded');`);
  // A draft saved before 474 (it must survive untouched).
  await db.query(`SELECT legal_review_save_draft($1, $2, 0, 'staff@example.test', $3::jsonb, '{}'::jsonb)`, [INV, C,
    JSON.stringify([{ source_line_ids: [], amount_cents: 33300, service_period_start: '2026-08-01', service_period_end: '2026-08-31', service_date_source: 'invoice_service_period',
      allocations: [{ amount_cents: 33300, classification: 'homeowner_recoverable', property_id: P1, tenure_id: 'd0000000-0000-4000-8000-000000000001', charge_category: 'attorney_fee', tenure_match: 'current' }] }])]);
  if (preExtractions) await db.exec(`CREATE TABLE legal_invoice_extractions (id uuid PRIMARY KEY);`);
  const client = { query: async (sql, params) => {
    if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
    const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
  } };
  return { db, client };
}

const OWNER = { id: 'owner-uuid', email: 'owner@example.test' };
const ctx = (client) => ({ client, user: OWNER, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });

const { db, client } = await buildWorld();
const q1 = async (sql, params) => (await db.query(sql, params)).rows[0];
const tryErr = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e.message; } };
const itemBefore = await q1(`SELECT row_to_json(i)::text j FROM legal_invoice_items i`);
const plan = await A.planMigration({ ...ctx(client), filename: F });
if (PRINT) { console.log(JSON.stringify(plan.objects, null, 2)); process.exit(0); }
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error, pf: plan.preflight && plan.preflight.filter((p) => !p.ok) }).slice(0, 900));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} },
  apiCheck: async ({ table }) => ({ ok: true, count: Number((await q1(`SELECT count(*)::int n FROM ${table}`)).n) }) });
check('apply: 474 applied and verified through the tool', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }).slice(0, 900));

if (r.status === 'applied') {
  check('apply: protected tables untouched (incl. the saved draft review + allocations)', (r.detail.protected || []).every((p) => p.unchanged), JSON.stringify(r.detail.protected));
  const itemAfter = await q1(`SELECT (row_to_json(i)::jsonb - 'extraction_id')::text j, extraction_id FROM legal_invoice_items i`);
  const canon = (s) => { const o = JSON.parse(s); return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]])); };
  check('apply: the existing draft item is unchanged (new column null)', canon(itemAfter.j) === canon(itemBefore.j) && itemAfter.extraction_id === null, itemAfter.j + ' vs ' + itemBefore.j);

  const FP = 'a'.repeat(64);
  const ins = (status, raw, error, fp = FP, snap = '{}') => tryErr(`INSERT INTO legal_invoice_extractions (ap_invoice_id, community_id, model, prompt_version, status, raw, error, payable_fingerprint, payable_snapshot) VALUES ($1, $2, 'm', 'v1', $3, $4::jsonb, $5, $6, $7::jsonb)`, [INV2, C, status, raw, error, fp, snap]);
  check('rule: a read must be bound to a payable fingerprint (missing / malformed rejected)',
    /null value in column "payable_fingerprint"/.test(await ins('valid', '{}', null, null) || '') && /legal_extraction_payable_fingerprint_format/.test(await ins('valid', '{}', null, 'not-a-hash') || '')
    && /null value in column "payable_snapshot"/.test(await ins('valid', '{}', null, FP, null) || ''));
  check('rule: a failed read must say why', /legal_extraction_status_detail/.test(await ins('failed', null, null) || ''));
  check('rule: a completed read must keep the raw output', /legal_extraction_status_detail/.test(await ins('valid', null, null) || ''));
  check('rule: an unknown status is rejected', /status_check/.test(await ins('approved', '{}', null) || ''));
  check('rule: a valid read with raw output is accepted', (await ins('valid', '{"matters":[]}', null)) === null);
  const ext = await q1(`SELECT id FROM legal_invoice_extractions WHERE ap_invoice_id = '${INV2}' LIMIT 1`);
  const otherExt = (await q1(`INSERT INTO legal_invoice_extractions (ap_invoice_id, community_id, model, prompt_version, status, raw, payable_fingerprint, payable_snapshot) VALUES ('${INV}', '${C}', 'm', 'v1', 'valid', '{}', '${FP}', '{}') RETURNING id`)).id;

  const save = async (base, items) => (await db.query(`SELECT legal_review_save_draft($1, $2, $3, 'staff@example.test', $4::jsonb, '{}'::jsonb) r`, [INV2, C, base, JSON.stringify(items)])).rows[0].r;
  const s1 = await save(0, [{ source_line_ids: [], amount_cents: 5000, service_period_start: '2026-08-03', service_period_end: '2026-08-12', service_date_source: 'pdf_entry', extraction_id: ext.id,
    allocations: [{ amount_cents: 5000, classification: 'needs_review' }] }]);
  const it = await q1(`SELECT i.extraction_id, i.service_date_source src FROM legal_invoice_items i JOIN legal_invoice_reviews r ON r.id = i.review_id WHERE r.ap_invoice_id = '${INV2}' AND i.is_active`);
  check('save: pdf_entry source + extraction_id persisted', s1.ok === true && it.extraction_id === ext.id && it.src === 'pdf_entry', JSON.stringify({ s1, it }));
  let bad = null; try { await save(1, [{ source_line_ids: [], amount_cents: 5000, extraction_id: otherExt, allocations: [{ amount_cents: 5000, classification: 'needs_review' }] }]); } catch (e) { bad = e.message; }
  check('save: an extraction from a different invoice rolls the whole save back', /legal_review_extraction_not_for_invoice/.test(bad || '') && (await q1(`SELECT revision FROM legal_invoice_reviews WHERE ap_invoice_id = '${INV2}'`)).revision === 1, bad);
  check('grants: extractions are append-only for the service role (no UPDATE / DELETE)',
    (await q1(`SELECT has_table_privilege('service_role', 'legal_invoice_extractions', 'INSERT') AND NOT has_table_privilege('service_role', 'legal_invoice_extractions', 'UPDATE') AND NOT has_table_privilege('service_role', 'legal_invoice_extractions', 'DELETE') ok`)).ok === true);
  check('grants: browser roles cannot read extractions',
    (await q1(`SELECT NOT has_table_privilege('anon', 'legal_invoice_extractions', 'SELECT') AND NOT has_table_privilege('authenticated', 'legal_invoice_extractions', 'SELECT') ok`)).ok === true);
  check('rule: an extraction referenced by an item cannot be deleted', /violates foreign key/.test(await tryErr(`DELETE FROM legal_invoice_extractions WHERE id = '${ext.id}'`) || ''));
}

const drift = await buildWorld({ preExtractions: true });
const plan2 = await A.planMigration({ ...ctx(drift.client), filename: F });
check('drift: an existing extractions table BLOCKS the plan (preflight), no token', plan2.status !== 'ready' && !plan2.plan_token, JSON.stringify({ status: plan2.status }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
