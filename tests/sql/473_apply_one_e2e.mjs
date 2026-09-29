// tests/sql/473_apply_one_e2e.mjs — migration 473 (draft-only Legal Invoice
// Review, Issue #9 step 2) applied END TO END through the single-migration tool
// (lib/migrations/apply_one.js) with its REAL checks file, in a stub world that
// has the columns 473 touches. Proves:
//   - the checks file matches exactly what 473 does (objects, row changes,
//     protected tables untouched, verify),
//   - the table rules hold (a recoverable allocation needs a property; a charge
//     category only on a recoverable one; no zero amounts; one review per AP
//     invoice; the updated_at trigger fires),
//   - the atomic save function: first save creates the review, a stale base
//     revision is refused and writes nothing, a resave supersedes (never
//     deletes) the prior set, a property from another community or a tenure
//     from another property rolls the WHOLE save back,
//   - drift blocks it (a missing attorney vendor stops the plan at preflight).
// Postgres 17 (PGlite 0.3.x) to match production's catalog behavior. Skips
// without PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  473 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '473_legal_invoice_review.sql';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm473-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const checks = JSON.parse(fs.readFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), 'utf8'));

const V = { winstead: '22488091-2642-489d-a84a-50c72fb05645', df: '35f76d51-0753-4f9f-b46d-df3c73d6092a', rmwbh: 'ee565db3-2c94-4830-8855-ccea1740dfa7' };
const C = 'a0000000-0000-4000-8000-000000000001';

async function buildWorld({ dropVendor = false } = {}) {
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
    INSERT INTO schema_migrations (filename, sha256) SELECT f, 'recorded' FROM unnest(ARRAY[${checks.requires.map((r) => `'${r}'`).join(',')}]) f;
    INSERT INTO communities VALUES ('${C}', 'Sample HOA');
    INSERT INTO vendors VALUES ('${V.winstead}', 'Winstead PC'), ('${V.df}', 'DAUGHTRY & FARINE, P.C.'), ${dropVendor ? '' : `('${V.rmwbh}', 'RMWBH'),`} ('b0000000-0000-4000-8000-000000000009', 'Superior LawnCare');
    INSERT INTO communities VALUES ('a0000000-0000-4000-8000-000000000002', 'Other HOA');
    INSERT INTO properties VALUES ('c0000000-0000-4000-8000-000000000001', '${C}', '4101 Sample Meadow Dr'), ('c0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', '1 Elsewhere Ln');
    INSERT INTO ownership_tenures VALUES ('d0000000-0000-4000-8000-000000000001', '${C}', 'c0000000-0000-4000-8000-000000000001', 'owner', '2020-01-01', NULL);
    INSERT INTO ap_invoices (id, community_id, vendor_id, total_cents) VALUES ('e0000000-0000-4000-8000-000000000001', '${C}', '${V.df}', 33300), ('e0000000-0000-4000-8000-000000000002', '${C}', '${V.df}', 5000);
    INSERT INTO ap_invoice_lines (invoice_id, amount_cents) VALUES ('e0000000-0000-4000-8000-000000000001', 32400), ('e0000000-0000-4000-8000-000000000001', 900);
    INSERT INTO journal_entries (community_id, source_module) VALUES ('${C}', 'ap_invoice');
    INSERT INTO homeowner_transactions (community_id, amount_cents) VALUES ('${C}', 100);
    INSERT INTO library_documents (community_id, category, file_hash) VALUES ('${C}', 'vendor_invoice', 'h1');`);
  const client = { query: async (sql, params) => {
    if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
    const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
  } };
  return { db, client };
}

const OWNER = { id: 'owner-uuid', email: 'owner@example.test' };
const ctx = (client) => ({ client, user: OWNER, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });

const { db, client } = await buildWorld();
const q1 = async (sql) => (await db.query(sql)).rows[0];
const plan = await A.planMigration({ ...ctx(client), filename: F });
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify(plan.preflight.filter((p) => !p.ok)));
check('plan: 6 protected tables, 99 added / 0 changed / 0 removed objects',
  plan.protected.length === 6 && plan.objects.added.length === 99 && plan.objects.changed.length === 0 && plan.objects.removed.length === 0,
  JSON.stringify({ p: plan.protected.length, a: plan.objects.added.length }));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} },
  apiCheck: async ({ table }) => ({ ok: true, count: Number((await q1(`SELECT count(*)::int n FROM ${table}`)).n) }) });
check('apply: 473 applied and verified through the tool', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }).slice(0, 900));

if (r.status === 'applied') {
  check('apply: vendors net 0 rows, 3 flagged legal counsel, the lawn vendor not', (await q1(`SELECT count(*)::int n FROM vendors WHERE is_legal_counsel`)).n === 3
    && (await q1(`SELECT is_legal_counsel f FROM vendors WHERE name = 'Superior LawnCare'`)).f === false);
  check('apply: protected tables untouched', (r.detail.protected || []).every((p) => p.unchanged), JSON.stringify(r.detail.protected));

  const rev = (await q1(`INSERT INTO legal_invoice_reviews (ap_invoice_id, community_id, created_by) VALUES ('e0000000-0000-4000-8000-000000000001', '${C}', 't') RETURNING id, updated_at`));
  const item = (await q1(`INSERT INTO legal_invoice_items (review_id, community_id, revision, source_line_ids, amount_cents) VALUES ('${rev.id}', '${C}', 1, '{}', 32400) RETURNING id`));
  const tryErr = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
  const base = `(item_id, review_id, community_id, revision, amount_cents, classification, property_id, charge_category)`;
  check('rule: a recoverable allocation without a property is rejected',
    /legal_alloc_recoverable_has_property/.test(await tryErr(`INSERT INTO legal_invoice_allocations ${base} VALUES ('${item.id}', '${rev.id}', '${C}', 1, 32400, 'homeowner_recoverable', NULL, 'attorney_fee')`) || ''));
  check('rule: a charge category on an association expense is rejected',
    /legal_alloc_category_only_recoverable/.test(await tryErr(`INSERT INTO legal_invoice_allocations ${base} VALUES ('${item.id}', '${rev.id}', '${C}', 1, 100, 'association_legal_expense', NULL, 'attorney_fee')`) || ''));
  check('rule: an unknown charge category is rejected',
    /charge_category_check/.test(await tryErr(`INSERT INTO legal_invoice_allocations ${base} VALUES ('${item.id}', '${rev.id}', '${C}', 1, 100, 'homeowner_recoverable', 'c0000000-0000-4000-8000-000000000001', 'fine')`) || ''));
  check('rule: a zero amount is rejected',
    /amount_cents_check/.test(await tryErr(`INSERT INTO legal_invoice_allocations ${base} VALUES ('${item.id}', '${rev.id}', '${C}', 1, 0, 'needs_review', NULL, NULL)`) || ''));
  check('rule: a valid recoverable allocation with property + category is accepted',
    (await tryErr(`INSERT INTO legal_invoice_allocations ${base} VALUES ('${item.id}', '${rev.id}', '${C}', 1, 32400, 'homeowner_recoverable', 'c0000000-0000-4000-8000-000000000001', 'attorney_fee_other')`)) === null);
  check('rule: one review per AP invoice',
    /ap_invoice_id_key/.test(await tryErr(`INSERT INTO legal_invoice_reviews (ap_invoice_id, community_id) VALUES ('e0000000-0000-4000-8000-000000000001', '${C}')`) || ''));
  check('rule: an AP invoice with a review cannot be deleted (history is kept)',
    /violates foreign key/.test(await tryErr(`DELETE FROM ap_invoices WHERE id = 'e0000000-0000-4000-8000-000000000001'`) || ''));
  await db.exec(`UPDATE legal_invoice_reviews SET updated_at = '2000-01-01', revision = 1 WHERE id = '${rev.id}'`);
  check('trigger: updated_at is refreshed on update', (await q1(`SELECT updated_at > '2020-01-01' ok FROM legal_invoice_reviews WHERE id = '${rev.id}'`)).ok === true);
  check('grants: service_role can read/insert/update review tables but not delete',
    (await q1(`SELECT has_table_privilege('service_role', 'legal_invoice_allocations', 'INSERT') AND has_table_privilege('service_role', 'legal_invoice_allocations', 'UPDATE') AND NOT has_table_privilege('service_role', 'legal_invoice_allocations', 'DELETE') ok`)).ok === true);
  // ---- the atomic save function (on the second invoice, which has no review yet) ----
  const INV2 = 'e0000000-0000-4000-8000-000000000002', P1 = 'c0000000-0000-4000-8000-000000000001', T1 = 'd0000000-0000-4000-8000-000000000001';
  const save = async (base, items, community = C) => (await db.query(`SELECT legal_review_save_draft($1, $2, $3, 'staff@example.test', $4::jsonb, '{"note":"t"}'::jsonb) r`, [INV2, community, base, JSON.stringify(items)])).rows[0].r;
  const saveErr = async (...a) => { try { await save(...a); return null; } catch (e) { return e.message; } };
  const itemsA = [{ source_line_ids: [], source_text: 'a', amount_cents: 5000, service_date: '2026-08-01', service_date_source: 'invoice_service_period',
    allocations: [{ amount_cents: 3000, classification: 'homeowner_recoverable', property_id: P1, tenure_id: T1, charge_category: 'attorney_fee', tenure_match: 'current', confidence: 'high', evidence: [{ kind: 'address', value: 'x' }], suggested: true },
                  { amount_cents: 2000, classification: 'association_legal_expense' }] }];
  const s1 = await save(0, itemsA);
  check('save: first save creates the review at revision 1', s1.ok === true && s1.revision === 1, JSON.stringify(s1));
  const counts = async () => (await q1(`SELECT (SELECT count(*) FROM legal_invoice_items i JOIN legal_invoice_reviews r ON r.id = i.review_id WHERE r.ap_invoice_id = '${INV2}' AND i.is_active)::int ai,
      (SELECT count(*) FROM legal_invoice_items i JOIN legal_invoice_reviews r ON r.id = i.review_id WHERE r.ap_invoice_id = '${INV2}')::int ti,
      (SELECT count(*) FROM legal_invoice_allocations a JOIN legal_invoice_reviews r ON r.id = a.review_id WHERE r.ap_invoice_id = '${INV2}' AND a.is_active)::int aa,
      (SELECT count(*) FROM legal_invoice_allocations a JOIN legal_invoice_reviews r ON r.id = a.review_id WHERE r.ap_invoice_id = '${INV2}')::int ta,
      (SELECT count(*) FROM legal_invoice_review_events e JOIN legal_invoice_reviews r ON r.id = e.review_id WHERE r.ap_invoice_id = '${INV2}')::int ev,
      (SELECT revision FROM legal_invoice_reviews WHERE ap_invoice_id = '${INV2}') rev`));
  let c1 = await counts();
  check('save: 1 item + 2 allocations active, 1 event', c1.ai === 1 && c1.aa === 2 && c1.ev === 1, JSON.stringify(c1));
  const stale = await save(0, itemsA);
  const c2 = await counts();
  check('save: a stale base revision is refused and writes nothing', stale.ok === false && stale.error === 'stale' && stale.revision === 1 && JSON.stringify(c2) === JSON.stringify(c1), JSON.stringify({ stale, c2 }));
  const s2 = await save(1, [{ source_line_ids: [], amount_cents: 5000, allocations: [{ amount_cents: 5000, classification: 'needs_review' }] }]);
  const c3 = await counts();
  check('save: a resave supersedes the prior set (kept, inactive) at revision 2', s2.ok === true && s2.revision === 2 && c3.ai === 1 && c3.ti === 2 && c3.aa === 1 && c3.ta === 3 && c3.ev === 2, JSON.stringify({ s2, c3 }));
  const bad1 = await saveErr(2, [{ source_line_ids: [], amount_cents: 5000, allocations: [{ amount_cents: 5000, classification: 'homeowner_recoverable', property_id: 'c0000000-0000-4000-8000-000000000002', charge_category: 'attorney_fee' }] }]);
  const c4 = await counts();
  check('save: a property from another community rolls the whole save back', /property_not_in_community/.test(bad1 || '') && JSON.stringify(c4) === JSON.stringify(c3), JSON.stringify({ bad1, c4 }));
  const bad2 = await saveErr(2, [{ source_line_ids: [], amount_cents: 5000, allocations: [{ amount_cents: 5000, classification: 'needs_review', property_id: P1, tenure_id: 'd0000000-0000-4000-8000-0000000000ff' }] }]);
  check('save: a tenure not on that property rolls the whole save back', /tenure_not_on_property/.test(bad2 || '') && JSON.stringify(await counts()) === JSON.stringify(c3), bad2);
  const bad3 = await saveErr(2, [{ source_line_ids: [], amount_cents: 5000, allocations: [{ amount_cents: 5000, classification: 'homeowner_recoverable' }] }]);
  check('save: a table rule violation (recoverable, no property) rolls the whole save back', /legal_alloc_recoverable_has_property/.test(bad3 || '') && JSON.stringify(await counts()) === JSON.stringify(c3), bad3);
  const bad4 = await saveErr(2, [], 'a0000000-0000-4000-8000-000000000002');
  check('save: an invoice saved under the wrong community is refused', /invoice_community_mismatch/.test(bad4 || ''), bad4);
  check('grants: only the service role may execute the save function',
    (await q1(`SELECT has_function_privilege('service_role', 'legal_review_save_draft(uuid, uuid, integer, text, jsonb, jsonb)', 'EXECUTE') AND NOT has_function_privilege('anon', 'legal_review_save_draft(uuid, uuid, integer, text, jsonb, jsonb)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'legal_review_save_draft(uuid, uuid, integer, text, jsonb, jsonb)', 'EXECUTE') ok`)).ok === true);
  check('grants: browser roles cannot read the review tables',
    (await q1(`SELECT NOT has_table_privilege('anon', 'legal_invoice_allocations', 'SELECT') AND NOT has_table_privilege('authenticated', 'legal_invoice_reviews', 'SELECT') ok`)).ok === true);
}

// ---- drift: a missing attorney vendor blocks the plan ----
const drift = await buildWorld({ dropVendor: true });
const plan2 = await A.planMigration({ ...ctx(drift.client), filename: F });
check('drift: a missing attorney vendor BLOCKS the plan (preflight), no token', plan2.status !== 'ready' && !plan2.plan_token, JSON.stringify({ status: plan2.status }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
