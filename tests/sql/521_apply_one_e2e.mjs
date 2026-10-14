// tests/sql/521_apply_one_e2e.mjs — migration 521 (budget line basis) applied END TO END through the
// single-migration tool with its REAL checks file: the six columns, the CHECK, both references (ON
// DELETE SET NULL) and the stale-basis trigger are added; no existing line changes; an APPROVED budget's
// lines stay locked by the migration 462 guard (including the new columns); a draft line whose amount
// changes without its basis is marked needs_review; drift (a column already present) blocks it.
// PGlite; skips without it.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  521 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '521_budget_line_basis.sql';
const PRINT = process.argv.includes('--print-objects');
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm521-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
const real = JSON.parse(lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), JSON.stringify(PRINT ? { ...real, objects: { added: [], changed: [], removed: [] } } : real, null, 2));

// The 462 lock, as shipped (function + trigger bodies copied from migration 462).
const LOCK = `
CREATE FUNCTION budget_unlock_in_progress() RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT coalesce(current_setting('trusted.budget_unlock', true), '') = 'on' $fn$;
CREATE FUNCTION budget_line_items_lock_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE st text; fy integer;
BEGIN
  IF budget_unlock_in_progress() THEN RETURN coalesce(NEW, OLD); END IF;
  SELECT status, fiscal_year INTO st, fy FROM community_budgets WHERE id = coalesce(NEW.budget_id, OLD.budget_id);
  IF st IN ('approved', 'active') THEN
    RAISE EXCEPTION 'the FY% budget is approved and locked; its lines cannot be added, changed or removed (reopen it first, with a reason)', fy;
  END IF;
  RETURN coalesce(NEW, OLD);
END; $fn$;
CREATE TRIGGER trg_budget_line_items_lock_guard BEFORE INSERT OR UPDATE OR DELETE ON budget_line_items FOR EACH ROW EXECUTE FUNCTION budget_line_items_lock_guard();`;
const APPR = '11111111-1111-4111-8111-111111111111', DRAFT = '22222222-2222-4222-8222-222222222222';
async function world({ drift = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE community_budgets (id uuid PRIMARY KEY, community_id uuid, fiscal_year int, status text);
    CREATE TABLE vendor_contracts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), vendor_name_raw text);
    CREATE TABLE library_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text);
    CREATE TABLE budget_line_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), budget_id uuid NOT NULL REFERENCES community_budgets(id) ON DELETE CASCADE, account_id uuid NOT NULL,
      fund_id uuid, annual_amount_cents bigint NOT NULL DEFAULT 0, monthly_amounts_cents bigint[] NOT NULL DEFAULT ARRAY[0,0,0,0,0,0,0,0,0,0,0,0]::bigint[], notes text${drift ? ', amount_basis text' : ''});
    CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reference text);
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO schema_migrations (filename, sha256) VALUES ('462_budget_approved_lock.sql', 'recorded');
    INSERT INTO community_budgets VALUES ('${APPR}', gen_random_uuid(), 2026, 'draft'), ('${DRAFT}', gen_random_uuid(), 2027, 'draft');
    INSERT INTO budget_line_items (budget_id, account_id, annual_amount_cents, notes) VALUES
      ('${APPR}', gen_random_uuid(), 12000000, 'adopted'), ('${DRAFT}', gen_random_uuid(), 6240000, 'FY2027 draft: $5,200/month x 12');
    INSERT INTO vendor_contracts (vendor_name_raw) VALUES ('United Protective Services');
    INSERT INTO library_documents (title) VALUES ('Security Officer Agreement');
    INSERT INTO journal_entries (reference) VALUES ('JE-1');
    ${LOCK}
    UPDATE community_budgets SET status = 'approved' WHERE id = '${APPR}';`);
  const client = { query: async (sql, params) => {
    if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
    const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
  } };
  return { db, client };
}
const ctx = (client) => ({ client, user: { id: 'o', email: 'owner@example.test' }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });
const raises = async (db, sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };

const { db, client } = await world();
const plan = await A.planMigration({ ...ctx(client), filename: F });
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, preflight: plan.preflight }).slice(0, 1500));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} } });
if (PRINT) { console.log(JSON.stringify({ status: r.status, objects: r.detail && r.detail.objects, rows: r.detail && r.detail.row_changes, error: r.error }, null, 2)); process.exit(0); }
check('apply: 521 applied and verified (objects as declared; no line, budget, GL or contract changed)', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error, detail: r.detail && r.detail.problems }).slice(0, 2000));
if (r.status === 'applied') {
  const lines = (await db.query(`SELECT budget_id, annual_amount_cents, notes, amount_basis, needs_review FROM budget_line_items ORDER BY annual_amount_cents`)).rows;
  check('existing lines: amounts and notes unchanged, no basis, needs_review false', lines.length === 2 && Number(lines[0].annual_amount_cents) === 6240000 && Number(lines[1].annual_amount_cents) === 12000000 && lines.every((l) => l.amount_basis === null && l.needs_review === false && l.notes));

  // Approved budget: still locked, including the new columns.
  const e1 = await raises(db, `UPDATE budget_line_items SET amount_basis = 'contract' WHERE budget_id = '${APPR}'`);
  check('approved budget: writing a basis on its line is refused by the 462 lock', /approved and locked/.test(e1 || ''), e1);
  const e2 = await raises(db, `UPDATE budget_line_items SET annual_amount_cents = 1 WHERE budget_id = '${APPR}'`);
  check('approved budget: its amount still cannot change', /approved and locked/.test(e2 || ''), e2);

  // Draft: a basis can be recorded; the CHECK refuses an invented basis.
  const vc = (await db.query('SELECT id FROM vendor_contracts')).rows[0].id, ld = (await db.query('SELECT id FROM library_documents')).rows[0].id;
  const e3 = await raises(db, `UPDATE budget_line_items SET amount_basis = 'contract', amount_calc = '$5,200/mo x 12', vendor_contract_id = '${vc}', source_document_id = '${ld}' WHERE budget_id = '${DRAFT}'`);
  check('draft: a contract basis with its contract and document is recorded', e3 === null, e3);
  const e4 = await raises(db, `UPDATE budget_line_items SET amount_basis = 'guess' WHERE budget_id = '${DRAFT}'`);
  check('draft: an amount_basis outside the six is refused by the CHECK', /check/i.test(e4 || ''), e4);
  const e5 = await raises(db, `INSERT INTO budget_line_items (budget_id, account_id, annual_amount_cents) VALUES ('${APPR}', gen_random_uuid(), 5)`);
  check('approved budget: a new line is still refused', /approved and locked/.test(e5 || ''), e5);

  // Stale basis: amount changes without the basis -> needs_review with both amounts.
  await db.exec(`UPDATE budget_line_items SET annual_amount_cents = 6500000 WHERE budget_id = '${DRAFT}'`);
  const s = (await db.query(`SELECT needs_review, review_note, amount_basis FROM budget_line_items WHERE budget_id = '${DRAFT}'`)).rows[0];
  check('draft: an amount change without a new basis marks the line needs_review, naming both amounts', s.needs_review === true && /\$62,400\.00 to \$65,000\.00/.test(s.review_note || '') && s.amount_basis === 'contract', JSON.stringify(s));
  await db.exec(`UPDATE budget_line_items SET needs_review = false, review_note = null WHERE budget_id = '${DRAFT}'`);
  await db.exec(`UPDATE budget_line_items SET annual_amount_cents = 6600000, amount_calc = '$5,500/mo x 12' WHERE budget_id = '${DRAFT}'`);
  const s2 = (await db.query(`SELECT needs_review FROM budget_line_items WHERE budget_id = '${DRAFT}'`)).rows[0];
  check('draft: an amount change that rewrites the calculation is not flagged', s2.needs_review === false, JSON.stringify(s2));

  // References: deleting the contract / document clears the link, never the line.
  await db.exec(`DELETE FROM vendor_contracts; DELETE FROM library_documents;`);
  const s3 = (await db.query(`SELECT vendor_contract_id, source_document_id, annual_amount_cents FROM budget_line_items WHERE budget_id = '${DRAFT}'`)).rows[0];
  check('ON DELETE SET NULL: the line stays, its links clear', s3 && s3.vendor_contract_id === null && s3.source_document_id === null && Number(s3.annual_amount_cents) === 6600000, JSON.stringify(s3));
}
const d = await world({ drift: true });
const p2 = await A.planMigration({ ...ctx(d.client), filename: F });
check('drift: a basis column already present stops the plan (no token)', p2.status !== 'ready' && !p2.plan_token, JSON.stringify({ status: p2.status }));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
