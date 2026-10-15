// tests/sql/530_owner_void_e2e.mjs — the owner's "Void entry" against the REAL ledger guards.
// Applied in production order on the production GL shapes:
//   502 month-end close   503 corrections trail   528 books closed (former clients)
//   529 posted entries permanent   530 void corrections (kind 'void' + preview_hash)
// then the exact statements lib/accounting/posting.js voidJournalEntry + void_entry.js run:
//   INSERT the reversal header (status posted, reverses_je_id = original, open month)
//   INSERT its lines (every line flipped)
//   UPDATE the original: status voided + void_reversal_je_id in ONE statement
//   INSERT journal_entry_corrections (kind 'void', actor, reason, preview_hash)
// PERMITS: that sequence in an active community, open month (and for a closed-month original
//   whose reversal is dated in an open month). The original's lines survive untouched.
// REFUSES: line edits / deletes on posted or voided entries, un-voiding, re-pointing the reversal,
//   a bare status flip, header amount or date changes, a reversal dated in a closed month, every
//   write for a former client, a void correction with no preview hash, changing a correction.
// Postgres 17 (PGlite). Skips without PGlite. Voids nothing real.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { onboardingWorld } from './onboarding_world.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const A = createRequire(import.meta.url)(`${REPO}/lib/migrations/apply_one.js`);
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  530 owner void end-to-end (@electric-sql/pglite not installed)'); process.exit(0); }
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };

const C = '00000000-0000-0000-0000-0000000000c1';      // active community (onboardingWorld's)
const FORMER = '00000000-0000-0000-0000-0000000000c3'; // former client
const MC = '00000000-0000-0000-0000-0000000000a1';
const ED = '00000000-0000-0000-0000-0000000000ed';
const world = await onboardingWorld(PGlite, { through: 452, gl: true });
const { db } = world;
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const err = async (sql, p) => { try { await db.query(sql, p); return null; } catch (e) { return e.message; } };

await db.exec(`
  ALTER TABLE accounting_periods ADD COLUMN period_type text NOT NULL DEFAULT 'monthly', ADD COLUMN closed_at timestamptz, ADD COLUMN closed_by_user_id uuid,
    ADD COLUMN reopened_at timestamptz, ADD COLUMN reopened_by_user_id uuid, ADD COLUMN reopened_reason text, ADD COLUMN locked_at timestamptz, ADD COLUMN locked_by_user_id uuid,
    ADD COLUMN notes text, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
  ALTER TABLE journal_entries ADD COLUMN voided_by_user_id uuid, ADD COLUMN posted_by_user_id uuid, ADD COLUMN needs_review boolean NOT NULL DEFAULT false, ADD COLUMN last_edited_at timestamptz;
  ALTER TABLE communities ADD COLUMN is_demo boolean DEFAULT false, ADD COLUMN books_of_record text DEFAULT 'trusted',
    ADD COLUMN IF NOT EXISTS management_status text NOT NULL DEFAULT 'active', ADD COLUMN IF NOT EXISTS management_end_date date, ADD COLUMN IF NOT EXISTS financials_active boolean NOT NULL DEFAULT true;
  INSERT INTO management_companies (id) VALUES ('${MC}');
  UPDATE communities SET management_company_id = '${MC}' WHERE id = '${C}';
  INSERT INTO communities (id, name, management_company_id) VALUES ('${FORMER}', 'Former Client', '${MC}');
  INSERT INTO account_funds (id, community_id, fund_code) VALUES ('00000000-0000-0000-0000-00000000f0f1', '${C}', 'OPR');
  INSERT INTO chart_of_accounts (id, community_id, account_number, fund_id) VALUES
    ('00000000-0000-0000-0000-0000000a2000', '${C}', '2000', '00000000-0000-0000-0000-00000000f0f1'),
    ('00000000-0000-0000-0000-0000000a5205', '${C}', '5205', '00000000-0000-0000-0000-00000000f0f1');`);
for (const cid of [C, FORMER]) for (let m = 7; m <= 10; m++) {
  const s = `2026-${String(m).padStart(2, '0')}-01`;
  await db.query(`INSERT INTO accounting_periods (community_id, fiscal_year, period_number, period_start, period_end) VALUES ($1, 2026, $2, $3::date, ($3::date + interval '1 month' - interval '1 day')::date)`, [cid, m, s]);
}
const A2000 = '00000000-0000-0000-0000-0000000a2000', A5205 = '00000000-0000-0000-0000-0000000a5205';
let n = 0;
const periodOf = async (cid, date) => (await one(`SELECT id FROM accounting_periods WHERE community_id = $1 AND $2::date BETWEEN period_start AND period_end`, [cid, date])).id;
// A posted entry exactly as postJournalEntry writes it: header, then its lines.
async function je(cid, date, { cents = 87750, ref = `T-${++n}` } = {}) {
  const r = await one(`INSERT INTO journal_entries (community_id, period_id, posting_date, reference, description, source_module, total_debits_cents, total_credits_cents, status)
    VALUES ($1, $2, $3, $4, 'test', 'manual', $5, $5, 'posted') RETURNING id`, [cid, await periodOf(cid, date), date, ref, cents]);
  await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit_cents) VALUES ($1, 1, $2, $3)`, [r.id, A5205, cents]);
  await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, credit_cents) VALUES ($1, 2, $2, $3)`, [r.id, A2000, cents]);
  return r.id;
}
// The void, statement for statement as voidJournalEntry + voidAsOwner run it. Returns the reversal id.
async function voidSteps(cid, origId, revDate, { hash = '1760550000000.' + 'a'.repeat(64), flip = true } = {}) {
  const o = await one(`SELECT reference, total_debits_cents FROM journal_entries WHERE id = $1`, [origId]);
  const rev = await one(`INSERT INTO journal_entries (community_id, period_id, posting_date, reference, description, source_module, source_reference, total_debits_cents, total_credits_cents, reverses_je_id, status, posted_by_user_id, notes)
    VALUES ($1, $2, $3, $4, $5, 'reversal', $6::text, $7, $7, $9::uuid, 'posted', $8, 'Void reason: test') RETURNING id`,
  [cid, await periodOf(cid, revDate), revDate, `REV-${++n}`, `VOID: ${o.reference} - test`, origId, o.total_debits_cents, ED, origId]);
  for (const l of await q(`SELECT line_number, account_id, debit_cents, credit_cents FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY line_number`, [origId])) {
    await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit_cents, credit_cents) VALUES ($1, $2, $3, $4, $5)`,
      [rev.id, l.line_number, l.account_id, l.credit_cents, l.debit_cents]);
  }
  if (flip) {
    await db.query(`UPDATE journal_entries SET status = 'voided', voided_at = now(), voided_by_user_id = $2, void_reason = 'test', void_reversal_je_id = $3 WHERE id = $1`, [origId, ED, rev.id]);
    await db.query(`INSERT INTO journal_entry_corrections (community_id, original_je_id, corrected_je_id, correcting_je_id, kind, actor_user_id, actor_name, reason, preview_hash)
      VALUES ($1, $2, $2, $3, 'void', $4, 'Ed Gojara', 'Duplicate payment entry', $5)`, [cid, origId, rev.id, ED, hash]);
  }
  return rev.id;
}
const linesOf = async (id) => JSON.stringify(await q(`SELECT line_number, account_id, debit_cents, credit_cents, memo FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY line_number`, [id]));

// Ledger before the guards.
const octA = await je(C, '2026-10-02');
const octB = await je(C, '2026-10-03');
const julA = await je(C, '2026-07-28');
const julB = await je(C, '2026-07-29');
const formerA = await je(FORMER, '2026-09-10');

// Apply in production order: 502, 503, 528, 529 as prerequisites, then 530 THROUGH the
// single-migration tool with its real checks file (preflight, objects, zero row changes, verify).
await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);`);
for (const f of ['502_month_end_close.sql', '503_journal_entry_corrections.sql', '528_books_closed_guard.sql', '529_posted_lines_immutable.sql']) {
  const e = await db.exec(lf(`${REPO}/migrations/${f}`)).then(() => null, (x) => x.message);
  check(`applies: ${f}`, e === null, e || '');
  await db.query(`INSERT INTO schema_migrations (filename, sha256) SELECT $1, 'recorded' WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = $1)`, [f]);
}
const F530 = '530_journal_entry_void_corrections.sql';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm530-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F530), lf(`${REPO}/migrations/${F530}`));
fs.writeFileSync(path.join(dir, 'checks', F530.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F530.replace('.sql', '.json')}`));
const client = { query: async (sql, params) => {
  if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
  const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
} };
const ctx = { client, user: { id: 'owner-uuid', email: 'owner@example.test' }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' };
const plan = await A.planMigration({ ...ctx, filename: F530 });
check('530 plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, reason: plan.reason, preflight: plan.preflight }).slice(0, 1500));
const applied = await A.applyMigration({ ...ctx, planToken: plan.plan_token, log: { error() {} } });
check('530 applied through the tool: objects match the checks file, zero row changes, verify passes', applied.status === 'applied', JSON.stringify({ status: applied.status, error: applied.error, detail: applied.detail }).slice(0, 2000));
if (applied.status !== 'applied') { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
check('530: journal_entry_void_audit_ready() answers true', (await one(`SELECT journal_entry_void_audit_ready() AS ok`)).ok === true);
await db.exec(`BEGIN; SELECT set_config('trusted.close_txn', 'on', true); UPDATE accounting_periods SET status = 'closed' WHERE community_id = '${C}' AND period_number = 7; COMMIT;`);
await db.exec(`UPDATE communities SET management_status = 'archived', financials_active = false, books_of_record = 'vantaca' WHERE id = '${FORMER}'`);

const IMM = /posted_lines_immutable/, CLOSED = /period_closed/, BOOKS = /books_closed/;

// ---------------------------------------------------------------- PERMITTED
const before = await linesOf(octA);
const e1 = await (async () => { try { return { rev: await voidSteps(C, octA, '2026-10-02') }; } catch (e) { return { e: e.message }; } })();
check('active, open month: reversal INSERT + lines + posted->voided flip (with its reversal) + void correction all succeed', !e1.e, e1.e || '');
const after = await one(`SELECT status, void_reversal_je_id FROM journal_entries WHERE id = $1`, [octA]);
check('the original is voided and linked to its reversal', after.status === 'voided' && after.void_reversal_je_id === e1.rev);
check('the original entry\'s lines are preserved exactly', (await linesOf(octA)) === before);
const net = await one(`SELECT coalesce(sum(l.debit_cents - l.credit_cents), 0)::int AS net FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.journal_entry_id
  WHERE j.id IN ($1, $2) AND (j.status = 'posted' OR (j.status = 'voided' AND j.void_reversal_je_id IS NOT NULL)) AND l.account_id = $3`, [octA, e1.rev, A2000]);
check('in balances (the counted-status rule) the pair nets to zero on AP', net.net === 0, JSON.stringify(net));
const julRes = await (async () => { try { await voidSteps(C, julA, '2026-10-05'); return null; } catch (e) { return e.message; } })();
check('closed-month original (July), reversal dated in an open month: the void is permitted (502 + 529)', julRes === null, julRes || '');
check('closed-month original: its lines are still intact', JSON.parse(await linesOf(julA)).length === 2);

// ---------------------------------------------------------------- REFUSED
check('posted: line UPDATE refused (529)', IMM.test(await err(`UPDATE journal_entry_lines SET debit_cents = debit_cents + 1 WHERE journal_entry_id = $1 AND line_number = 1`, [octB]) || ''));
check('posted: line DELETE refused (529)', IMM.test(await err(`DELETE FROM journal_entry_lines WHERE journal_entry_id = $1`, [octB]) || ''));
check('voided: line UPDATE refused (529)', IMM.test(await err(`UPDATE journal_entry_lines SET memo = 'x' WHERE journal_entry_id = $1`, [octA]) || ''));
check('voided: line DELETE refused (529)', IMM.test(await err(`DELETE FROM journal_entry_lines WHERE journal_entry_id = $1`, [octA]) || ''));
check('voided: un-void (voided -> posted) refused (529)', IMM.test(await err(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [octA]) || ''));
check('voided: re-pointing void_reversal_je_id refused (529)', IMM.test(await err(`UPDATE journal_entries SET void_reversal_je_id = $2 WHERE id = $1`, [octA, octB]) || ''));
check('posted: bare flip to voided with no reversal refused (529)', IMM.test(await err(`UPDATE journal_entries SET status = 'voided' WHERE id = $1`, [octB]) || ''));
check('posted: flip naming an entry that does not reverse it refused (529)', IMM.test(await err(`UPDATE journal_entries SET status = 'voided', void_reversal_je_id = $2 WHERE id = $1`, [octB, julB]) || ''));
check('posted: header amount change refused (529)', IMM.test(await err(`UPDATE journal_entries SET total_debits_cents = 1, total_credits_cents = 1 WHERE id = $1`, [octB]) || ''));
check('posted: header posting_date change refused (529)', IMM.test(await err(`UPDATE journal_entries SET posting_date = '2026-10-20' WHERE id = $1`, [octB]) || ''));
check('voided: header amount change refused (529)', IMM.test(await err(`UPDATE journal_entries SET total_debits_cents = 1, total_credits_cents = 1 WHERE id = $1`, [octA]) || ''));
const closedRev = await (async () => { try { await voidSteps(C, julB, '2026-07-30', { flip: false }); return null; } catch (e) { return e.message; } })();
check('a reversal dated in a CLOSED month is refused at its INSERT (502)', CLOSED.test(closedRev || ''), closedRev || '');
check('former client: the reversal INSERT is refused (528 books_closed)', BOOKS.test(await (async () => { try { await voidSteps(FORMER, formerA, '2026-10-02', { flip: false }); return ''; } catch (e) { return e.message; } })()));
const fRev = await one(`SELECT id FROM journal_entries WHERE id <> $1 AND community_id = $2`, [formerA, FORMER]).catch(() => null);
check('former client: nothing was written for it', !fRev);
check('former client: the void flip is refused (528)', BOOKS.test(await err(`UPDATE journal_entries SET status = 'voided', void_reversal_je_id = $2 WHERE id = $1`, [formerA, octB]) || ''));
check('former client: description edit refused (528)', BOOKS.test(await err(`UPDATE journal_entries SET description = 'x' WHERE id = $1`, [formerA]) || ''));
check('former client: line DELETE refused (528)', BOOKS.test(await err(`DELETE FROM journal_entry_lines WHERE journal_entry_id = $1`, [formerA]) || ''));
check('former client: its lines are intact', JSON.parse(await linesOf(formerA)).length === 2);
check('530: a void correction with no preview_hash is refused', /void_preview_check/.test(await err(`INSERT INTO journal_entry_corrections (community_id, original_je_id, corrected_je_id, correcting_je_id, kind, actor_user_id, actor_name, reason)
  VALUES ($1, $2, $2, $3, 'void', $4, 'Ed Gojara', 'no hash')`, [C, octB, e1.rev, ED]) || ''));
check('503: a correction record cannot be changed (append-only)', /append-only/.test(await err(`UPDATE journal_entry_corrections SET reason = 'edited' WHERE kind = 'void'`) || ''));
check('503: a correction record cannot be deleted (append-only)', /append-only/.test(await err(`DELETE FROM journal_entry_corrections WHERE kind = 'void'`) || ''));
check('both voids are recorded with actor, reason and preview hash', (await one(`SELECT count(*)::int n FROM journal_entry_corrections WHERE kind = 'void' AND actor_user_id = $1 AND preview_hash IS NOT NULL AND reason <> ''`, [ED])).n === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
