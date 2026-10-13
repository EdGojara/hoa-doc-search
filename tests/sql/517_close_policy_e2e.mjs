// tests/sql/517_close_policy_e2e.mjs — migration 517 (accrual close policy) applied END TO END
// through the single-migration tool with its REAL checks file, on top of migration 502
// (itself applied through the tool). Proves:
//   - the checks file matches exactly what 517 does (one changed function, no row changes,
//     periods / close records / runs / events / GL byte-for-byte unchanged);
//   - after 517 an admin can no longer close a month; the owner can, but only on a run that
//     is Kat's cutoff review (recorded by Kat AND carrying CUT-01..03 + IF-01);
//   - everything 502 enforced still holds (latest run, BLOCK overrides, accepted warnings);
//   - drift blocks it (a close_period that is no longer the 502 version stops the plan).
// Postgres 17 (PGlite). Skips without PGlite. --print-objects prints 517's catalog diff.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { onboardingWorld } from './onboarding_world.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  517 close policy rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const PRINT = process.argv.includes('--print-objects');
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const code = async (fn) => { try { await fn(); return null; } catch (e) { return `${e.code || ''} ${e.message || ''}`; } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const C = '00000000-0000-0000-0000-0000000000c1';
const MC = '00000000-0000-0000-0000-0000000000a1';

async function world({ drift = false } = {}) {
  const w = await onboardingWorld(PGlite, { through: 452, gl: true });
  const { db } = w;
  await db.exec(`
    ALTER TABLE accounting_periods ADD COLUMN period_type text NOT NULL DEFAULT 'monthly', ADD COLUMN closed_at timestamptz, ADD COLUMN closed_by_user_id uuid,
      ADD COLUMN reopened_at timestamptz, ADD COLUMN reopened_by_user_id uuid, ADD COLUMN reopened_reason text, ADD COLUMN locked_at timestamptz, ADD COLUMN locked_by_user_id uuid,
      ADD COLUMN notes text, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE journal_entries ADD COLUMN voided_by_user_id uuid, ADD COLUMN posted_by_user_id uuid, ADD COLUMN needs_review boolean NOT NULL DEFAULT false, ADD COLUMN last_edited_at timestamptz;
    ALTER TABLE communities ADD COLUMN is_demo boolean DEFAULT false, ADD COLUMN books_of_record text;
    INSERT INTO management_companies (id) VALUES ('${MC}');
    UPDATE communities SET gl_cutover_date = '2026-08-01', management_company_id = '${MC}' WHERE id = '${C}';
    INSERT INTO account_funds (id, community_id, fund_code) VALUES ('00000000-0000-0000-0000-00000000f0f1', '${C}', 'OPR');
    INSERT INTO chart_of_accounts (id, community_id, account_number, fund_id) VALUES
      ('00000000-0000-0000-0000-0000000a1000', '${C}', '1000', '00000000-0000-0000-0000-00000000f0f1'),
      ('00000000-0000-0000-0000-0000000a4000', '${C}', '4000', '00000000-0000-0000-0000-00000000f0f1');`);
  for (let m = 1; m <= 12; m++) {
    await db.query(`INSERT INTO accounting_periods (community_id, fiscal_year, period_number, period_start, period_end) VALUES ($1, 2026, $2, $3::date, ($3::date + interval '1 month' - interval '1 day')::date)`, [C, m, `2026-${String(m).padStart(2, '0')}-01`]);
  }
  const P = {};
  for (const r of (await db.query(`SELECT id, period_number FROM accounting_periods WHERE community_id = $1`, [C])).rows) P[r.period_number] = r.id;
  const je = await db.query(`INSERT INTO journal_entries (community_id, period_id, posting_date, reference, description, source_module, total_debits_cents, total_credits_cents, status)
    VALUES ($1, $2, '2026-08-05', 'JE-1', 'test', 'manual', 49500, 49500, 'posted') RETURNING id`, [C, P[8]]);
  await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit_cents, credit_cents) VALUES ($1, 1, '00000000-0000-0000-0000-0000000a1000', 49500, 0), ($1, 2, '00000000-0000-0000-0000-0000000a4000', 0, 49500)`, [je.rows[0].id]);
  await db.exec(`INSERT INTO schema_migrations (filename, sha256) SELECT f, 'recorded' FROM unnest(ARRAY['170_gl_foundation.sql','454_journal_entry_superseded_status.sql','466_recognition_schedules_controls.sql']) f ON CONFLICT DO NOTHING`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig517-'));
  fs.mkdirSync(path.join(dir, 'checks'));
  for (const f of ['502_month_end_close', '517_close_policy_owner_kat_review']) {
    fs.writeFileSync(path.join(dir, `${f}.sql`), lf(`${REPO}/migrations/${f}.sql`));
    const ch = JSON.parse(lf(`${REPO}/migrations/checks/${f}.json`));
    fs.writeFileSync(path.join(dir, 'checks', `${f}.json`), JSON.stringify(PRINT && f.startsWith('517') ? { ...ch, objects: { added: [], changed: [], removed: [] } } : ch, null, 2));
  }
  const ctx = { client: w.client, user: { id: 'o', email: 'owner@example.test' }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' };
  const apply = async (F) => { const plan = await A.planMigration({ ...ctx, filename: F }); if (plan.status !== 'ready') return { plan, applied: null }; return { plan, applied: await A.applyMigration({ ...ctx, planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) }) }; };
  const m502 = await apply('502_month_end_close.sql');
  if (!m502.applied || m502.applied.status !== 'applied') throw new Error(`502 did not apply: ${JSON.stringify(m502.plan.status)} ${JSON.stringify(m502.applied && m502.applied.error)}`);
  if (drift) await db.exec(`CREATE OR REPLACE FUNCTION close_period(p_community uuid, p_period uuid, p_run uuid, p_actor text, p_actor_user_id uuid, p_actor_role text) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RETURN '{}'::jsonb; END; $$;`);
  return { ...w, P, apply };
}

const w = await world();
const { db, rpc, P } = w;
const r517 = await w.apply('517_close_policy_owner_kat_review.sql');
if (PRINT) { console.log(JSON.stringify({ plan: r517.plan.status, objects: r517.applied && r517.applied.detail && r517.applied.detail.objects, error: r517.applied && r517.applied.error }, null, 2)); process.exit(0); }
check('517 planned (preflight passes on the 502 function) and applied + verified through the tool with its real checks file', r517.plan.status === 'ready' && r517.applied && r517.applied.status === 'applied',
  JSON.stringify({ plan: r517.plan.status, pre: r517.plan.preflight, r: r517.applied && r517.applied.status, e: r517.applied && r517.applied.error }).slice(0, 2000));
if (!r517.applied || r517.applied.status !== 'applied') { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
check('no row changed: periods, close records, runs, events and the GL are protected and unchanged', r517.applied.detail.protected.every((p) => p.unchanged) && Object.values(r517.applied.detail.row_changes).every((v) => v === 0));
check('every month is still open', (await db.query(`SELECT count(*)::int n FROM accounting_periods WHERE status <> 'open'`)).rows[0].n === 0);

const facts = (pid) => rpc('close_ledger_facts', { p_community: C, p_period: pid });
const CUT = ['CUT-01', 'CUT-02', 'CUT-03', 'IF-01'].map((c) => ({ code: c, status: 'PASS', evidence_hash: `h-${c}` }));
const run = async (pid, actor, results) => rpc('close_record_run', { p_community: C, p_period: pid, p_actor: actor, p_actor_user_id: null, p_engine_version: 'close-b.1',
  p_fingerprint: (await facts(pid)).fingerprint, p_ledger_facts: await facts(pid), p_results: results, p_summary: { n: results.length } });
const close = (pid, runId, role, actor = role === 'owner' ? 'ed' : 'admin@x') => rpc('close_period', { p_community: C, p_period: pid, p_run: runId, p_actor: actor, p_actor_user_id: null, p_actor_role: role });
const base = [{ code: 'GL-01', status: 'PASS', evidence_hash: 'h1' }];

const human = await run(P[8], 'staff@x', [...base, ...CUT]);
check('a checklist run recorded by a person is not Kat\'s review: the owner cannot close on it', /cutoff review first/.test(await code(() => close(P[8], human.run_id, 'owner')) || ''));
const old = await run(P[8], 'Kat (AI accountant), refreshed from Mission Control', base);
check('a Kat run on the old engine (no cutoff controls) is not a cutoff review either', /cutoff review first/.test(await code(() => close(P[8], old.run_id, 'owner')) || ''));
const kat = await run(P[8], 'Kat (AI accountant) cutoff review, requested by staff@x', [...base, ...CUT]);
check('an admin can no longer close a month, even on Kat\'s review', /only the owner/.test(await code(() => close(P[8], kat.run_id, 'admin')) || ''));
check('staff cannot close', /only the owner/.test(await code(() => close(P[8], kat.run_id, 'staff')) || ''));
check('the owner closes only on the latest run (502 rule kept)', /stale_run/.test(await code(() => close(P[8], human.run_id, 'owner')) || ''));
const katBlock = await run(P[8], 'Kat (AI accountant) cutoff review', [...base, ...CUT.slice(0, 1).map((c) => ({ ...c, status: 'BLOCK' })), ...CUT.slice(1)]);
check('a BLOCK on Kat\'s review still needs the owner\'s override (502 rule kept)', /BLOCK controls not overridden/.test(await code(() => close(P[8], katBlock.run_id, 'owner')) || ''));
const kat2 = await run(P[8], 'Kat (AI accountant) cutoff review', [...base, ...CUT]);
const closed = await close(P[8], kat2.run_id, 'owner');
check('the owner approves and closes on Kat\'s cutoff review', closed.status === 'closed' && (await db.query(`SELECT status FROM accounting_periods WHERE id = $1`, [P[8]])).rows[0].status === 'closed', JSON.stringify(closed));
check('the close record names the owner', (await db.query(`SELECT closed_by, closed_by_role FROM period_closes WHERE period_id = $1`, [P[8]])).rows[0].closed_by_role === 'owner');
check('reopen keeps its 502 authority (admin with a reason)', (await rpc('reopen_period', { p_community: C, p_period: P[8], p_reason: 'late vendor bill for August', p_actor: 'admin@x', p_actor_user_id: null, p_actor_role: 'admin' })).status === 'open');

const d = await world({ drift: true });
const rd = await d.apply('517_close_policy_owner_kat_review.sql');
check('drift: a close_period that is not the 502 version stops the plan at preflight (no token)', rd.plan.status !== 'ready' && !rd.plan.plan_token, JSON.stringify({ status: rd.plan.status }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
