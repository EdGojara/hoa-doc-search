// tests/sql/502_month_end_close_e2e.mjs — month-end close (PR A) on the REAL SQL.
// Migration 502 is applied through the single-migration tool with its real checks
// file, on the production GL shapes (170 GL + 454 superseded + 466 source_module),
// then: the ledger facts and fingerprint (including LOPF's real defect shape: a
// posted entry whose lines were deleted, its conversion reversal still counted);
// the run / override / accept / close / reopen workflow and its authority rules;
// months closing in order; the lock on entries, lines and periods (including the
// prior-system July once August closes); the void flip; books changing between
// the run and the close; and the history being append-only.
// Postgres 17 (PGlite). Skips without PGlite. --print-objects prints 502's catalog diff.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { onboardingWorld } from './onboarding_world.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  502 month-end close rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const PRINT = process.argv.includes('--print-objects');
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const code = async (fn) => { try { await fn(); return null; } catch (e) { return `${e.code || ''} ${e.message || ''}`; } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const C = '00000000-0000-0000-0000-0000000000c1';   // the community (onboardingWorld's)
const OTHER = '00000000-0000-0000-0000-0000000000c2';
const MC = '00000000-0000-0000-0000-0000000000a1';
const world = await onboardingWorld(PGlite, { through: 452, gl: true });
const { db, rpc } = world;
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

// Production columns the close reads/writes that the shared GL stub leaves out.
await db.exec(`
  ALTER TABLE accounting_periods ADD COLUMN period_type text NOT NULL DEFAULT 'monthly', ADD COLUMN closed_at timestamptz, ADD COLUMN closed_by_user_id uuid,
    ADD COLUMN reopened_at timestamptz, ADD COLUMN reopened_by_user_id uuid, ADD COLUMN reopened_reason text, ADD COLUMN locked_at timestamptz, ADD COLUMN locked_by_user_id uuid,
    ADD COLUMN notes text, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
  ALTER TABLE journal_entries ADD COLUMN voided_by_user_id uuid, ADD COLUMN posted_by_user_id uuid, ADD COLUMN needs_review boolean NOT NULL DEFAULT false, ADD COLUMN last_edited_at timestamptz;
  ALTER TABLE communities ADD COLUMN is_demo boolean DEFAULT false, ADD COLUMN books_of_record text;
  INSERT INTO management_companies (id) VALUES ('${MC}');
  UPDATE communities SET gl_cutover_date = '2026-08-01', management_company_id = '${MC}' WHERE id = '${C}';
  INSERT INTO communities (id, name, management_company_id) VALUES ('${OTHER}', 'Other Place', '${MC}');
  INSERT INTO account_funds (id, community_id, fund_code) VALUES ('00000000-0000-0000-0000-00000000f0f1', '${C}', 'OPR'), ('00000000-0000-0000-0000-00000000f0f2', '${C}', 'RES');
  INSERT INTO chart_of_accounts (id, community_id, account_number, fund_id) VALUES
    ('00000000-0000-0000-0000-0000000a1000', '${C}', '1000', '00000000-0000-0000-0000-00000000f0f1'),
    ('00000000-0000-0000-0000-0000000a2000', '${C}', '2000', '00000000-0000-0000-0000-00000000f0f1'),
    ('00000000-0000-0000-0000-0000000a4000', '${C}', '4000', '00000000-0000-0000-0000-00000000f0f1'),
    ('00000000-0000-0000-0000-0000000a5205', '${C}', '5205', '00000000-0000-0000-0000-00000000f0f1'),
    ('00000000-0000-0000-0000-0000000a1110', '${C}', '1110', '00000000-0000-0000-0000-00000000f0f2'),
    ('00000000-0000-0000-0000-0000000a3100', '${C}', '3100', '00000000-0000-0000-0000-00000000f0f2');`);
for (let m = 1; m <= 12; m++) {
  const s = `2026-${String(m).padStart(2, '0')}-01`;
  await db.query(`INSERT INTO accounting_periods (community_id, fiscal_year, period_number, period_start, period_end) VALUES ($1, 2026, $2, $3::date, ($3::date + interval '1 month' - interval '1 day')::date)`, [C, m, s]);
  await db.query(`INSERT INTO accounting_periods (community_id, fiscal_year, period_number, period_start, period_end) VALUES ($1, 2026, $2, $3::date, ($3::date + interval '1 month' - interval '1 day')::date)`, [OTHER, m, s]);
}
const P = {};
for (const r of await q(`SELECT id, period_number FROM accounting_periods WHERE community_id = $1`, [C])) P[r.period_number] = r.id;
const POTHER = (await one(`SELECT id FROM accounting_periods WHERE community_id = $1 AND period_number = 8`, [OTHER])).id;
const A1000 = '00000000-0000-0000-0000-0000000a1000', A2000 = '00000000-0000-0000-0000-0000000a2000', A4000 = '00000000-0000-0000-0000-0000000a4000', A5205 = '00000000-0000-0000-0000-0000000a5205';
const A1110 = '00000000-0000-0000-0000-0000000a1110', A3100 = '00000000-0000-0000-0000-0000000a3100';
let refN = 0;
async function je(date, lines, { status = 'posted', source = 'manual', ref = null, reverses = null, cid = C } = {}) {
  const per = await one(`SELECT id FROM accounting_periods WHERE community_id = $1 AND $2::date BETWEEN period_start AND period_end`, [cid, date]);
  const dr = lines.reduce((s, l) => s + (l[1] || 0), 0);
  const r = await one(`INSERT INTO journal_entries (community_id, period_id, posting_date, reference, description, source_module, total_debits_cents, total_credits_cents, status, reverses_je_id)
    VALUES ($1, $2, $3, $4, 'test', $5, $6, $6, $7, $8) RETURNING id`, [cid, per.id, date, ref || `JE-${++refN}`, source, dr, status, reverses]);
  let n = 0;
  for (const [acct, d, c] of lines) await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit_cents, credit_cents) VALUES ($1, $2, $3, $4, $5)`, [r.id, ++n, acct, d || 0, c || 0]);
  return r.id;
}

// ------------------------------------------------------------------- the ledger (before 502)
// July: the conversion opening (prior system) carrying Jan-Jul P&L at 7/31.
await je('2026-07-31', [[A1000, 500000, 0], [A5205, 300000, 0], [A4000, 0, 700000], [A2000, 0, 100000]], { source: 'opening_entry', ref: 'CONV-X-OPEN-OPR' });
await je('2026-07-31', [[A1110, 900000, 0], [A3100, 0, 900000]], { source: 'opening_entry', ref: 'CONV-X-OPEN-RES' });
// LOPF's real defect shape: an AP accrual dated 7/28, neutralized by the conversion, whose
// lines were later deleted by the unpaid-bill re-code path (header kept: the reversal references it).
const mud = await je('2026-07-28', [[A5205, 47025, 0], [A2000, 0, 47025]], { source: 'ap_invoice', ref: 'JE-MUD-169' });
await je('2026-07-28', [[A2000, 47025, 0], [A5205, 0, 47025]], { source: 'reversal', ref: 'CONV-X-NEUT-JE-MUD-169', reverses: mud });
// August activity.
await je('2026-08-05', [[A1000, 49500, 0], [A4000, 0, 49500]]);
await je('2026-08-20', [[A5205, 12000, 0], [A1000, 0, 12000]]);
// September activity.
await je('2026-09-03', [[A1000, 49500, 0], [A4000, 0, 49500]]);

// ------------------------------------------------------------------- apply 502 through the tool
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig502-'));
fs.mkdirSync(path.join(dir, 'checks'));
const F = '502_month_end_close.sql';
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', '502_month_end_close.json'), lf(`${REPO}/migrations/checks/502_month_end_close.json`));
const reqs = JSON.parse(lf(`${REPO}/migrations/checks/502_month_end_close.json`)).requires;
check('every prerequisite named by the 502 checks file is a real migration file', reqs.every((x) => fs.existsSync(`${REPO}/migrations/${x}`)), JSON.stringify(reqs.filter((x) => !fs.existsSync(`${REPO}/migrations/${x}`))));
await db.exec(`INSERT INTO schema_migrations (filename, sha256) SELECT f, 'recorded' FROM unnest(ARRAY['170_gl_foundation.sql','454_journal_entry_superseded_status.sql','466_recognition_schedules_controls.sql']) f ON CONFLICT DO NOTHING`);
// Delete the defect's lines BEFORE 502 (as production already has it).
await db.query(`DELETE FROM journal_entry_lines WHERE journal_entry_id = $1`, [mud]);
const ctxA = { client: world.client, user: { id: 'o', email: 'owner@example.test' }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' };
const plan = await A.planMigration({ ...ctxA, filename: F });
const applied = await A.applyMigration({ ...ctxA, planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
if (PRINT) { console.log(JSON.stringify((applied.detail || {}).objects || applied, null, 2)); process.exit(0); }
check('502 planned (preflight passes) and applied + verified through the tool with its real checks file', plan.status === 'ready' && applied.status === 'applied',
  JSON.stringify({ plan: plan.status, pre: plan.preflight, err: plan.error, r: applied.status, e: applied.error }).slice(0, 2000));
if (applied.status !== 'applied') { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
check('no existing row changed (periods and journal entries protected; row deltas 0)', applied.detail.protected.every((p) => p.unchanged) && Object.values(applied.detail.row_changes).every((v) => v === 0));

// ------------------------------------------------------------------- ledger facts
const facts = async (pid) => rpc('close_ledger_facts', { p_community: C, p_period: pid });
const aug = await facts(P[8]);
check('facts: the ledger balances through August (debits = credits, the month too)', Number(aug.through_debits_cents) === Number(aug.through_credits_cents) && Number(aug.period_debits_cents) === Number(aug.period_credits_cents));
check('facts: the posted entry with no lines is a broken entry (LOPF\'s $470.25 MUD shape), named with its header amount',
  aug.broken_entries.length === 1 && aug.broken_entries[0].reference === 'JE-MUD-169' && aug.broken_entries[0].problem === 'no_lines' && Number(aug.broken_entries[0].header_debits_cents) === 47025);
check('facts: each fund balances (OPR, RES)', aug.unbalanced_funds.length === 0, JSON.stringify(aug.unbalanced_funds));
const fp1 = aug.fingerprint; const fp2 = (await facts(P[8])).fingerprint;
check('facts: the fingerprint is deterministic', fp1 === fp2 && /^[0-9a-f]{32}$/.test(fp1));
await je('2026-09-10', [[A5205, 100, 0], [A1000, 0, 100]], { status: 'draft' });
const sep = await facts(P[9]);
check('facts: a draft dated in September is listed for September (not August)', sep.draft_entries.length === 1 && aug.draft_entries.length === 0);
check('facts: September activity does not change August\'s fingerprint', (await facts(P[8])).fingerprint === fp1);
await db.query(`UPDATE journal_entries SET posting_date = '2026-09-15' WHERE reference = 'JE-1'`);   // posting date outside its filed period (July)
check('facts: an entry whose posting date is outside its filed period is an invalid date', (await facts(P[9])).invalid_dates.some((d) => d.problem === 'date_outside_period'));
await db.query(`UPDATE journal_entries SET posting_date = '2026-08-05' WHERE reference = 'JE-1'`);
const ovf = await facts(P[8]);

// ------------------------------------------------------------------- the workflow
const results = (blocks = [], warns = []) => [
  { code: 'GL-01', status: 'PASS', evidence_hash: 'h-gl01' },
  ...blocks.map((c) => ({ code: c, status: 'BLOCK', evidence_hash: `h-${c}` })),
  ...warns.map((c) => ({ code: c, status: 'WARNING', evidence_hash: `h-${c}` })),
];
const run = (pid, f, res) => rpc('close_record_run', { p_community: C, p_period: pid, p_actor: 'staff@x', p_actor_user_id: null, p_engine_version: 'test',
  p_fingerprint: f.fingerprint, p_ledger_facts: f, p_results: res, p_summary: { n: res.length } });

check('a run is refused when the fingerprint is not the books\' current one', /books_changed/.test(await code(() => run(P[8], { ...ovf, fingerprint: 'nope' }, results())) || ''));
const r1 = await run(P[8], ovf, results(['GL-02', 'DATA-02'], ['CASH-04']));
check('run recorded; with BLOCKs not overridden the month is in REVIEW', r1.status === 'review' && r1.unresolved_blocks.length === 2);
check('an admin cannot override a BLOCK (owner only)', /only the owner/.test(await code(() => rpc('close_override_block', { p_community: C, p_period: P[8], p_run: r1.run_id, p_control_code: 'GL-02', p_reason: 'fixed after close', p_actor: 'admin@x', p_actor_user_id: null, p_actor_role: 'admin' })) || ''));
check('an override needs a written reason (10+ characters)', /reason/.test(await code(() => rpc('close_override_block', { p_community: C, p_period: P[8], p_run: r1.run_id, p_control_code: 'GL-02', p_reason: 'ok', p_actor: 'ed', p_actor_user_id: null, p_actor_role: 'owner' })) || ''));
check('only a BLOCK is overridden (not a WARNING)', /not BLOCK/.test(await code(() => rpc('close_override_block', { p_community: C, p_period: P[8], p_run: r1.run_id, p_control_code: 'CASH-04', p_reason: 'a long enough reason', p_actor: 'ed', p_actor_user_id: null, p_actor_role: 'owner' })) || ''));
check('an admin cannot close with BLOCKs open', /BLOCK controls not overridden/.test(await code(() => rpc('close_period', { p_community: C, p_period: P[8], p_run: r1.run_id, p_actor: 'admin@x', p_actor_user_id: null, p_actor_role: 'admin' })) || ''));
await rpc('close_override_block', { p_community: C, p_period: P[8], p_run: r1.run_id, p_control_code: 'GL-02', p_reason: 'JE-MUD-169 lines restored separately; see ticket', p_actor: 'ed', p_actor_user_id: null, p_actor_role: 'owner' });
const o2 = await rpc('close_override_block', { p_community: C, p_period: P[8], p_run: r1.run_id, p_control_code: 'DATA-02', p_reason: 'Statement received on paper; uploading', p_actor: 'ed', p_actor_user_id: null, p_actor_role: 'owner' });
check('with every BLOCK overridden by the owner the month is READY TO CLOSE', o2.status === 'ready_to_close');
check('September cannot close before August (months close in order)', /close the earlier months first/.test(await code(async () => {
  const fs9 = await facts(P[9]); const r9 = await run(P[9], fs9, results());
  await rpc('close_period', { p_community: C, p_period: P[9], p_run: r9.run_id, p_actor: 'admin@x', p_actor_user_id: null, p_actor_role: 'admin' });
}) || ''));
check('a WARNING must be accepted before closing', /accept these warnings/.test(await code(() => rpc('close_period', { p_community: C, p_period: P[8], p_run: r1.run_id, p_actor: 'admin@x', p_actor_user_id: null, p_actor_role: 'admin' })) || ''));
check('staff cannot accept warnings', /admin or the owner/.test(await code(() => rpc('close_accept_warnings', { p_community: C, p_period: P[8], p_run: r1.run_id, p_control_codes: ['CASH-04'], p_note: null, p_actor: 's', p_actor_user_id: null, p_actor_role: 'staff' })) || ''));
check('accepting something that is not a WARNING is refused', /not a WARNING/.test(await code(() => rpc('close_accept_warnings', { p_community: C, p_period: P[8], p_run: r1.run_id, p_control_codes: ['GL-02'], p_note: null, p_actor: 'admin@x', p_actor_user_id: null, p_actor_role: 'admin' })) || ''));
await rpc('close_accept_warnings', { p_community: C, p_period: P[8], p_run: r1.run_id, p_control_codes: ['CASH-04'], p_note: 'two checks follow up', p_actor: 'admin@x', p_actor_user_id: null, p_actor_role: 'admin' });
// books change between the run and the close
const tmp = await je('2026-08-25', [[A5205, 500, 0], [A1000, 0, 500]]);
check('the close is refused when the books changed after the run', /books_changed/.test(await code(() => rpc('close_period', { p_community: C, p_period: P[8], p_run: r1.run_id, p_actor: 'admin@x', p_actor_user_id: null, p_actor_role: 'admin' })) || ''));
await db.query(`DELETE FROM journal_entry_lines WHERE journal_entry_id = $1`, [tmp]); await db.query(`DELETE FROM journal_entries WHERE id = $1`, [tmp]);
const closed = await rpc('close_period', { p_community: C, p_period: P[8], p_run: r1.run_id, p_actor: 'admin@x', p_actor_user_id: null, p_actor_role: 'admin' });
check('August closes, labelled "closed_with_override" (two owner overrides)', closed.status === 'closed' && closed.label === 'closed_with_override');
const rec = await one(`SELECT * FROM period_closes WHERE period_id = $1`, [P[8]]);
check('the close record keeps who, when, the run, the fingerprint, the accepted warning and both overrides with the ORIGINAL BLOCK results',
  rec.closed_by === 'admin@x' && rec.closed_at && rec.close_run_id === r1.run_id && rec.fingerprint === ovf.fingerprint
  && rec.accepted_warnings.length === 1 && rec.overrides.length === 2 && rec.overrides.every((o) => o.original_result && o.original_result.status === 'BLOCK' && o.reason.length >= 10));
check('accounting_periods: August is closed; closed-through is 8/31', (await one(`SELECT status FROM accounting_periods WHERE id = $1`, [P[8]])).status === 'closed'
  && (await one(`SELECT close_closed_through($1)::text AS d`, [C])).d === '2026-08-31');

// ------------------------------------------------------------------- the lock
check('LOCK: a new entry dated in closed August is refused', /period_closed/.test(await code(() => je('2026-08-15', [[A5205, 100, 0], [A1000, 0, 100]])) || ''));
check('LOCK: a new entry dated in prior-system July is refused too (closed through 8/31), though July is still flagged open',
  /period_closed/.test(await code(() => je('2026-07-15', [[A5205, 100, 0], [A1000, 0, 100]])) || ''));
check('LOCK: September still posts', !(await code(() => je('2026-09-12', [[A5205, 100, 0], [A1000, 0, 100]]))));
const augJe = (await one(`SELECT id FROM journal_entries WHERE reference = 'JE-2'`)).id;
check('LOCK: lines of an August entry cannot be added', /period_closed/.test(await code(() => db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit_cents) VALUES ($1, 9, $2, 1)`, [augJe, A5205])) || ''));
check('LOCK: lines of an August entry cannot be deleted (the LOPF defect path)', /period_closed/.test(await code(() => db.query(`DELETE FROM journal_entry_lines WHERE journal_entry_id = $1`, [augJe])) || ''));
check('LOCK: lines of an August entry cannot be changed', /period_closed/.test(await code(() => db.query(`UPDATE journal_entry_lines SET debit_cents = debit_cents + 1 WHERE journal_entry_id = $1 AND debit_cents > 0`, [augJe])) || ''));
check('LOCK: an August entry cannot be deleted', /period_closed/.test(await code(() => db.query(`DELETE FROM journal_entries WHERE id = $1`, [augJe])) || ''));
check('LOCK: an August entry\'s date and amounts cannot change', /period_closed/.test(await code(() => db.query(`UPDATE journal_entries SET posting_date = '2026-09-01' WHERE id = $1`, [augJe])) || ''));
check('LOCK: an August entry\'s description can still be corrected (non-financial)', !(await code(() => db.query(`UPDATE journal_entries SET description = 'clarified' WHERE id = $1`, [augJe]))));
check('LOCK: an August entry cannot be marked voided without its reversal', /reversal dated in an open month/.test(await code(() => db.query(`UPDATE journal_entries SET status = 'voided' WHERE id = $1`, [augJe])) || ''));
const rev = await je('2026-09-14', [[A1000, 49500, 0], [A4000, 0, 49500]], { source: 'reversal', reverses: augJe });
check('LOCK: the void flip IS allowed once its reversal posted in open September', !(await code(() => db.query(`UPDATE journal_entries SET status = 'voided', voided_at = now(), void_reason = 'dup', void_reversal_je_id = $2 WHERE id = $1`, [augJe, rev]))));
check('LOCK: superseding an August entry is refused', /period_closed/.test(await code(() => db.query(`UPDATE journal_entries SET status = 'superseded', superseded_at = now(), superseded_reason = 'x' WHERE reference = 'JE-1'`)) || ''));
check('LOCK: accounting_periods status cannot be flipped directly', /period_closed/.test(await code(() => db.query(`UPDATE accounting_periods SET status = 'open' WHERE id = $1`, [P[8]])) || ''));
check('LOCK: a closed period\'s dates cannot change', /period_closed/.test(await code(() => db.query(`UPDATE accounting_periods SET notes = 'x', period_end = '2026-08-30' WHERE id = $1`, [P[8]])) || ''));
check('LOCK: the close record cannot be written directly', /only through the month-end close/.test(await code(() => db.query(`UPDATE period_closes SET status = 'open' WHERE period_id = $1`, [P[8]])) || ''));
check('LOCK: history is append-only (events and runs)', /append-only/.test(await code(() => db.query(`DELETE FROM period_close_events`)) || '') && /append-only/.test(await code(() => db.query(`UPDATE period_close_runs SET engine_version = 'x'`)) || ''));
await db.exec(`INSERT INTO chart_of_accounts (id, community_id, account_number) VALUES ('00000000-0000-0000-0000-0000000b1000', '${OTHER}', '1000'), ('00000000-0000-0000-0000-0000000b5205', '${OTHER}', '5205')`);
check('LOCK: another community is not affected', !(await code(() => je('2026-08-15', [['00000000-0000-0000-0000-0000000b5205', 100, 0], ['00000000-0000-0000-0000-0000000b1000', 0, 100]], { cid: OTHER }))));

// ------------------------------------------------------------------- reopen
const fs9 = await facts(P[9]); const r9 = await run(P[9], fs9, results());
check('September (all PASS) is ready to close immediately', r9.status === 'ready_to_close');
await rpc('close_period', { p_community: C, p_period: P[9], p_run: r9.run_id, p_actor: 'ed', p_actor_user_id: null, p_actor_role: 'owner' });
check('September closes "closed" (no override)', (await one(`SELECT close_label FROM period_closes WHERE period_id = $1`, [P[9]])).close_label === 'closed');
check('reopen: August cannot reopen while September is closed (newest first)', /later closed months first/.test(await code(() => rpc('reopen_period', { p_community: C, p_period: P[8], p_reason: 'need to fix the MUD entry', p_actor: 'ed', p_actor_user_id: null, p_actor_role: 'owner' })) || ''));
check('reopen: staff cannot reopen', /admin or the owner/.test(await code(() => rpc('reopen_period', { p_community: C, p_period: P[9], p_reason: 'need to fix something', p_actor: 's', p_actor_user_id: null, p_actor_role: 'staff' })) || ''));
check('reopen: a reason is required (10+ characters)', /reason/.test(await code(() => rpc('reopen_period', { p_community: C, p_period: P[9], p_reason: 'oops', p_actor: 'ed', p_actor_user_id: null, p_actor_role: 'owner' })) || ''));
await rpc('reopen_period', { p_community: C, p_period: P[9], p_reason: 'late vendor bill for September', p_actor: 'admin@x', p_actor_user_id: null, p_actor_role: 'admin' });
await rpc('reopen_period', { p_community: C, p_period: P[8], p_reason: 'restore the MUD entry lines', p_actor: 'ed', p_actor_user_id: null, p_actor_role: 'owner' });
const ev = await q(`SELECT event, actor, actor_role, reason FROM period_close_events WHERE period_id = $1 ORDER BY seq`, [P[8]]);
check('reopen recorded with actor, role, reason; the close record keeps the reopen and its count',
  ev[ev.length - 1].event === 'reopened' && ev[ev.length - 1].reason === 'restore the MUD entry lines'
  && (await one(`SELECT status, reopen_count, reopened_by FROM period_closes WHERE period_id = $1`, [P[8]])).reopen_count === 1);
check('after reopening, August posts again (closed-through cleared)', !(await code(() => je('2026-08-28', [[A5205, 100, 0], [A1000, 0, 100]]))) && (await rpc('close_closed_through', { p_community: C })) === null);
const f8b = await facts(P[8]);
const r8b = await run(P[8], f8b, results(['GL-02'], []));
check('after a reopen, the earlier overrides no longer count: the same BLOCK needs a new owner override', r8b.status === 'review' && r8b.unresolved_blocks.includes('GL-02'));
check('the full history is kept (run, overrides, acceptance, close, reopen, run)', ev.map((e) => e.event).join(',') === 'run,block_overridden,block_overridden,warnings_accepted,closed,reopened');

// ------------------------------------------------------------------- evidence for an "other" source
await db.query(`INSERT INTO close_source_requirements (community_id, source_key, label, set_by, set_reason) VALUES ($1, 'other', 'Edward Jones statement', 'ed', 'brokerage statement is required monthly')`, [C]);
const reqId = (await one(`SELECT id FROM close_source_requirements WHERE community_id = $1`, [C])).id;
const evid = await rpc('close_add_evidence', { p_community: C, p_period: P[8], p_requirement: reqId, p_document_ref: 'library_documents:abc', p_note: null, p_actor: 'staff@x' });
check('evidence for an "other" required source is recorded (append-only)', !!evid && /append-only/.test(await code(() => db.query(`DELETE FROM period_close_evidence`)) || ''));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
