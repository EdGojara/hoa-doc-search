// tests/sql/529_guards_combined_e2e.mjs — the three ledger guards together, on the REAL SQL:
//   502 trg_*_close_guard    (closed months)
//   528 trg_*_books_closed   (former clients; applied when the file is in the tree)
//   529 trg_*_posted_guard   (posted lines and headers, any month, any community)
// Applied in production order (502, 528, 529) on the production GL shapes, then every
// combination: open/closed month x active/former client x draft/posted/voided, for line
// DELETE / UPDATE / INSERT and header UPDATE. Proves the trigger order is the documented
// name order, that each guard still refuses on its own condition, and that the legitimate
// paths (posting, draft edit, void flip in an open month, metadata edits) survive all three.
// Postgres 17 (PGlite). Skips without PGlite.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { onboardingWorld } from './onboarding_world.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  529 combined ledger guards (@electric-sql/pglite not installed)'); process.exit(0); }
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const HAS_528 = fs.existsSync(`${REPO}/migrations/528_books_closed_guard.sql`);
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };

const C = '00000000-0000-0000-0000-0000000000c1';      // active community (onboardingWorld's)
const FORMER = '00000000-0000-0000-0000-0000000000c3'; // former client
const MC = '00000000-0000-0000-0000-0000000000a1';
const world = await onboardingWorld(PGlite, { through: 452, gl: true });
const { db } = world;
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const err = async (sql, p) => { try { await db.query(sql, p); return null; } catch (e) { return e.message; } };

// Production columns the guards read that the shared GL stub leaves out (as the 502 rehearsal adds them).
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
async function je(cid, date, { status = 'posted', cents = 1000, reverses = null } = {}) {
  const per = await one(`SELECT id FROM accounting_periods WHERE community_id = $1 AND $2::date BETWEEN period_start AND period_end`, [cid, date]);
  const r = await one(`INSERT INTO journal_entries (community_id, period_id, posting_date, reference, description, source_module, total_debits_cents, total_credits_cents, status, reverses_je_id)
    VALUES ($1, $2, $3, $4, 'test', 'manual', $5, $5, $6, $7) RETURNING id`, [cid, per.id, date, `T-${++n}`, cents, status, reverses]);
  await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit_cents) VALUES ($1, 1, $2, $3)`, [r.id, A5205, cents]);
  await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, credit_cents) VALUES ($1, 2, $2, $3)`, [r.id, A2000, cents]);
  return r.id;
}

// The ledger before the guards: July (to be closed) and October (open), both communities.
const julPosted = await je(C, '2026-07-28');
const julDraft = await je(C, '2026-07-29', { status: 'draft' });
const octPosted = await je(C, '2026-10-02');
const octDraft = await je(C, '2026-10-03', { status: 'draft' });
const octToVoid = await je(C, '2026-10-04');
const formerPosted = await je(FORMER, '2026-09-10');
const formerDraft = await je(FORMER, '2026-09-11', { status: 'draft' });

// Apply in production order.
await db.exec(lf(`${REPO}/migrations/502_month_end_close.sql`));
if (HAS_528) await db.exec(lf(`${REPO}/migrations/528_books_closed_guard.sql`));
await db.exec(lf(`${REPO}/migrations/529_posted_lines_immutable.sql`));
// Close July through the close transaction flag (the only way 502 lets a period close).
await db.exec(`BEGIN; SELECT set_config('trusted.close_txn', 'on', true); UPDATE accounting_periods SET status = 'closed' WHERE community_id = '${C}' AND period_number = 7; COMMIT;`);
// The former client leaves.
await db.exec(`UPDATE communities SET management_status = 'archived', financials_active = false, books_of_record = 'vantaca' WHERE id = '${FORMER}'`);

const order = (t) => q(`SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal AND tgname LIKE 'trg_%' AND tgname <> 'trg_je_updated_at' ORDER BY tgname`, [t]);
const expJ = [HAS_528 && 'trg_journal_entries_books_closed', 'trg_journal_entries_close_guard', 'trg_journal_entries_posted_guard'].filter(Boolean);
const expL = [HAS_528 && 'trg_journal_entry_lines_books_closed', 'trg_journal_entry_lines_close_guard', 'trg_journal_entry_lines_posted_guard'].filter(Boolean);
check(`journal_entries guards fire in name order: ${expJ.join(' -> ')}`, JSON.stringify((await order('journal_entries')).map((r) => r.tgname)) === JSON.stringify(expJ), JSON.stringify(await order('journal_entries')));
check(`journal_entry_lines guards fire in name order: ${expL.join(' -> ')}`, JSON.stringify((await order('journal_entry_lines')).map((r) => r.tgname)) === JSON.stringify(expL), JSON.stringify(await order('journal_entry_lines')));

const delLines = (id) => err(`DELETE FROM journal_entry_lines WHERE journal_entry_id = $1`, [id]);
const updLine = (id) => err(`UPDATE journal_entry_lines SET memo = 'changed' WHERE journal_entry_id = $1 AND line_number = 1`, [id]);
const addLine = (id) => err(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit_cents) VALUES ($1, 9, $2, 1)`, [id, A5205]);
const IMM = /posted_lines_immutable/, CLOSED = /period_closed/, BOOKS = /books_closed/;

// Open month, active community: 529 alone decides.
check('open month, active, POSTED: line delete refused by 529', IMM.test(await delLines(octPosted) || ''));
check('open month, active, POSTED: line update refused by 529', IMM.test(await updLine(octPosted) || ''));
check('open month, active, DRAFT: line update, delete and re-insert all work (draft edit)', (await updLine(octDraft)) === null && (await delLines(octDraft)) === null && (await addLine(octDraft)) === null);
check('open month, active: posting a new entry (header, then lines) works', (await (async () => { try { await je(C, '2026-10-06'); return null; } catch (e) { return e.message; } })()) === null);
check('open month, active, POSTED: description / review flag edit works under all guards', (await err(`UPDATE journal_entries SET description = 'x', needs_review = true WHERE id = $1`, [octPosted])) === null);
check('open month, active, POSTED: date change refused by 529', IMM.test(await err(`UPDATE journal_entries SET posting_date = '2026-10-20' WHERE id = $1`, [octPosted]) || ''));
// Void flip in an open month: reversal posted, then posted -> voided.
const rev = await je(C, '2026-10-05', { reverses: octToVoid });
check('open month, active: the void flip works under all guards', (await err(`UPDATE journal_entries SET status = 'voided', void_reversal_je_id = $2 WHERE id = $1`, [octToVoid, rev])) === null);
check('open month, active, VOIDED: un-void refused by 529', IMM.test(await err(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [octToVoid]) || ''));

// Closed month, active community: 502 refuses first (name order), even for a draft.
check('closed month, active, POSTED: line delete refused (502 fires first: period_closed)', CLOSED.test(await delLines(julPosted) || ''));
check('closed month, active, DRAFT: line delete refused by 502 (529 would allow a draft)', CLOSED.test(await delLines(julDraft) || ''));
check('closed month, active: adding a line refused by 502', CLOSED.test(await addLine(julPosted) || ''));
check('closed month, active, POSTED: lines intact', (await one(`SELECT count(*)::int n FROM journal_entry_lines WHERE journal_entry_id = $1`, [julPosted])).n === 2);

// Former client: 528 refuses first (when present); otherwise 529 still protects posted lines.
if (HAS_528) {
  check('former client, POSTED: line delete refused (528 fires first: books_closed)', BOOKS.test(await delLines(formerPosted) || ''));
  check('former client, DRAFT: line delete refused by 528 (529 would allow a draft)', BOOKS.test(await delLines(formerDraft) || ''));
  check('former client: description edit refused by 528', BOOKS.test(await err(`UPDATE journal_entries SET description = 'x' WHERE id = $1`, [formerPosted]) || ''));
} else {
  check('former client, POSTED (528 not in tree): line delete still refused by 529', IMM.test(await delLines(formerPosted) || ''));
  console.log('SKIP  528 combinations (migration 528 not on this branch yet)');
}
check('former client, POSTED: lines intact', (await one(`SELECT count(*)::int n FROM journal_entry_lines WHERE journal_entry_id = $1`, [formerPosted])).n === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
