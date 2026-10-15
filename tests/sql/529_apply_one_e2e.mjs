// tests/sql/529_apply_one_e2e.mjs — migration 529 (posted journal entry lines are permanent)
// applied END TO END through the single-migration tool with its REAL checks file. Proves:
//   - THE SCAR: the 9/28 re-code sequence (delete lines, then delete header) on a posted
//     LOPF-shaped accrual in an OPEN month of an ACTIVE community is refused at the first
//     statement and the lines survive (before 529 the same SQL strips them);
//   - every legitimate path still works: posting (header, then lines), the failed-insert
//     rollback (delete a header that has no lines), the draft edit (delete + reinsert a
//     draft's lines, change its totals, then post it), the void flip, the superseded flip and
//     its restore, description / notes edits, a no-op line write;
//   - a non-draft entry cannot return to draft, change its totals, have a line moved into it;
//   - the four known empty LOPF headers do not block the apply; a fifth one does (preflight);
//   - when migration 528 is present it is applied too and both guards refuse on their own.
// Postgres 17 (PGlite). Skips without PGlite. --print-objects prints the catalog diff.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  529 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '529_posted_lines_immutable.sql';
const F528 = '528_books_closed_guard.sql';
const HAS_528 = fs.existsSync(`${REPO}/migrations/${F528}`);
const PRINT = process.argv.includes('--print-objects');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm529-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
const realChecks = JSON.parse(lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const checks = PRINT ? { ...realChecks, objects: { added: [], changed: [], removed: [] } } : realChecks;
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), JSON.stringify(checks, null, 2));
check('every prerequisite named by the 529 checks file is a real migration file', realChecks.requires.every((x) => fs.existsSync(`${REPO}/migrations/${x}`)));

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const LOPF = id(1), EW = id(2), A2000 = id(20), A5205 = id(52);

async function buildWorld({ fifthEmpty = false } = {}) {
  const db = new PGlite();
  // Production GL shapes: 170 (journal_entries / journal_entry_lines with the RESTRICT FKs),
  // 454 (superseded status + audit), 382/516 lifecycle columns (read by 528 when present).
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE communities (id uuid PRIMARY KEY, name text, management_status text NOT NULL DEFAULT 'active', management_end_date date,
      financials_active boolean NOT NULL DEFAULT true, books_of_record text DEFAULT 'trusted');
    CREATE TABLE chart_of_accounts (id uuid PRIMARY KEY, community_id uuid, account_number text);
    CREATE TABLE journal_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid NOT NULL REFERENCES communities(id), posting_date date NOT NULL,
      reference text NOT NULL, description text, notes text, source_module text, period_id uuid, needs_review boolean DEFAULT false, classification_reason text,
      source_document_id uuid, source_document_path text, prior_period_through date, voided_at timestamptz, void_reason text, total_debits_cents bigint NOT NULL DEFAULT 0, total_credits_cents bigint NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'posted' CHECK (status IN ('draft', 'posted', 'voided', 'superseded')),
      reverses_je_id uuid REFERENCES journal_entries(id) ON DELETE RESTRICT, void_reversal_je_id uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,
      superseded_at timestamptz, superseded_reason text, superseded_by_conversion text, updated_at timestamptz DEFAULT now(),
      CONSTRAINT journal_entries_superseded_audit CHECK (status <> 'superseded' OR (superseded_at IS NOT NULL AND superseded_reason IS NOT NULL)));
    CREATE TABLE journal_entry_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), journal_entry_id uuid NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT, line_number int NOT NULL,
      account_id uuid NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT, debit_cents bigint NOT NULL DEFAULT 0, credit_cents bigint NOT NULL DEFAULT 0,
      memo text, property_id uuid, vendor_id uuid, bank_account_id uuid, fund_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (debit_cents >= 0 AND credit_cents >= 0), CHECK (NOT (debit_cents > 0 AND credit_cents > 0)), CHECK (debit_cents > 0 OR credit_cents > 0));
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO schema_migrations (filename, sha256) VALUES ('170_gl_foundation.sql', 'recorded'), ('454_journal_entry_superseded_status.sql', 'recorded'), ('516_community_archived_status.sql', 'recorded');
    INSERT INTO communities (id, name) VALUES ('${LOPF}', 'Lakes of Pine Forest');
    INSERT INTO communities (id, name, management_status, financials_active, books_of_record) VALUES ('${EW}', 'Former Client', 'archived', false, 'vantaca');
    INSERT INTO chart_of_accounts (id, community_id, account_number) VALUES ('${A2000}', '${LOPF}', '2000'), ('${A5205}', '${LOPF}', '5205');
  `);
  // The four LOPF headers exactly as production has them: posted, $6,277.75 in total, no lines,
  // each referenced by its conversion NEUT reversal (which keeps its own lines).
  const amounts = { 'JE-2026-00169': 87750, 'JE-2026-00170': 173150, 'JE-2026-00171': 27525, 'JE-2026-00172': 339350 };
  for (const [ref, c] of Object.entries(amounts)) {
    const { rows: [h] } = await db.query(`INSERT INTO journal_entries (community_id, posting_date, reference, source_module, total_debits_cents, total_credits_cents) VALUES ($1, '2026-07-28', $2, 'ap_invoice', $3, $3) RETURNING id`, [LOPF, ref, c]);
    const { rows: [n] } = await db.query(`INSERT INTO journal_entries (community_id, posting_date, reference, source_module, total_debits_cents, total_credits_cents, reverses_je_id) VALUES ($1, '2026-07-28', $2, 'reversal', $3, $3, $4) RETURNING id`, [LOPF, `CONV-LPF-20260731-NEUT-${ref}`, c, h.id]);
    await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit_cents) VALUES ($1, 1, $2, $3)`, [n.id, A2000, c]);
    await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, credit_cents) VALUES ($1, 2, $2, $3)`, [n.id, A5205, c]);
  }
  if (fifthEmpty) await db.query(`INSERT INTO journal_entries (community_id, posting_date, reference, total_debits_cents, total_credits_cents) VALUES ($1, '2026-09-02', 'JE-2026-00999', 5000, 5000)`, [LOPF]);
  const client = { query: async (sql, params) => {
    if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
    const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
  } };
  return { db, client };
}

const OWNER = { id: 'owner-uuid', email: 'owner@example.test' };
const ctx = (client) => ({ client, user: OWNER, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });
const { db, client } = await buildWorld();
const q = async (sql, p) => (await db.query(sql, p)).rows;
const q1 = async (sql, p) => (await q(sql, p))[0];
const err = async (sql, p) => { try { await db.query(sql, p); return null; } catch (e) { return e.message; } };
const IMM = /posted_lines_immutable/;

// A posted accrual in an OPEN month of an ACTIVE community (the scar's exact setting), with lines.
async function postedAccrual(ref, cents, { status = 'posted' } = {}) {
  const { id: je } = await q1(`INSERT INTO journal_entries (community_id, posting_date, reference, source_module, total_debits_cents, total_credits_cents, status) VALUES ($1, '2026-10-02', $2, 'ap_invoice', $3, $3, $4) RETURNING id`, [LOPF, ref, cents, status]);
  await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit_cents) VALUES ($1, 1, $2, $3)`, [je, A5205, cents]);
  await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, credit_cents) VALUES ($1, 2, $2, $3)`, [je, A2000, cents]);
  return je;
}
const linesOf = async (je) => (await q1(`SELECT count(*)::int n FROM journal_entry_lines WHERE journal_entry_id = $1`, [je])).n;

// Before 529: the scar reproduces (the lines go; the header survives because its reversal references it).
const pre = await postedAccrual('PRE-529', 47025);
await db.query(`INSERT INTO journal_entries (community_id, posting_date, reference, source_module, total_debits_cents, total_credits_cents, reverses_je_id) VALUES ($1, '2026-10-02', 'NEUT-PRE-529', 'reversal', 1, 1, $2)`, [LOPF, pre]);
await db.query(`DELETE FROM journal_entry_lines WHERE journal_entry_id = $1`, [pre]);
const preHdr = await err(`DELETE FROM journal_entries WHERE id = $1`, [pre]);
check('before 529 the 9/28 sequence strips a posted entry: lines deleted, header delete refused by the FK, header left with no lines', (await linesOf(pre)) === 0 && /foreign key|violates/i.test(preHdr || ''), preHdr);
// Undo the rehearsal so the protected-table snapshot matches the reviewed world.
await db.query(`DELETE FROM journal_entries WHERE reference = 'NEUT-PRE-529'`); await db.query(`DELETE FROM journal_entries WHERE id = $1`, [pre]);

const plan = await A.planMigration({ ...ctx(client), filename: F });
check('plan: ready, every preflight passes (the four known empty LOPF headers do not block it)', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, reason: plan.reason, preflight: plan.preflight }).slice(0, 1500));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} } });
if (PRINT) { console.log(JSON.stringify({ status: r.status, objects: r.detail && r.detail.objects, row_changes: r.detail && r.detail.row_changes, error: r.error }, null, 2)); process.exit(0); }
check('apply: 529 applied and verified through the tool (objects, zero row changes, ledger byte-for-byte unchanged, verify)', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error, detail: r.detail }).slice(0, 2000));
if (r.status !== 'applied') { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

// ---------------------------------------------------------------- the scar, after 529
const je = await postedAccrual('JE-2026-T0169', 87750);
await db.query(`INSERT INTO journal_entries (community_id, posting_date, reference, source_module, total_debits_cents, total_credits_cents, reverses_je_id) VALUES ($1, '2026-10-02', 'CONV-T-NEUT-JE-2026-T0169', 'reversal', 1, 1, $2)`, [LOPF, je]);
const scar = await err(`DELETE FROM journal_entry_lines WHERE journal_entry_id = $1`, [je]);
check('THE SCAR: deleting a posted entry\'s lines (open month, active community) is refused', IMM.test(scar || ''), scar);
check('... and both lines are still there', (await linesOf(je)) === 2);
const own = require(`${REPO}/lib/accounting/ownership.js`);
check('the app maps the real refusal to a 409 (ownership.isPostedEntryPermanent recognises the trigger message, and isBooksClosed does not)', own.isPostedEntryPermanent({ message: scar }) && !own.isBooksClosed({ message: scar }) && !own.isPostedEntryPermanent({ message: 'books_closed: x' }));
check('deleting a single posted line by id is refused', IMM.test(await err(`DELETE FROM journal_entry_lines WHERE id = (SELECT id FROM journal_entry_lines WHERE journal_entry_id = $1 LIMIT 1)`, [je]) || ''));
check('re-coding a posted line in place (account) is refused', IMM.test(await err(`UPDATE journal_entry_lines SET account_id = $2 WHERE journal_entry_id = $1 AND line_number = 1`, [je, A2000]) || ''));
check('changing a posted line\'s amount is refused', IMM.test(await err(`UPDATE journal_entry_lines SET debit_cents = 1 WHERE journal_entry_id = $1 AND line_number = 1`, [je]) || ''));
check('changing a posted line\'s memo / property is refused (lines are permanent, not just amounts)', IMM.test(await err(`UPDATE journal_entry_lines SET memo = 'x' WHERE journal_entry_id = $1 AND line_number = 1`, [je]) || ''));
check('a no-op write to a posted line is harmless', (await err(`UPDATE journal_entry_lines SET memo = memo WHERE journal_entry_id = $1`, [je])) === null);
check('a posted entry cannot be turned back into a draft (that would unlock its lines)', IMM.test(await err(`UPDATE journal_entries SET status = 'draft' WHERE id = $1`, [je]) || ''));
check('a posted entry\'s header totals cannot change', IMM.test(await err(`UPDATE journal_entries SET total_debits_cents = 0, total_credits_cents = 0 WHERE id = $1`, [je]) || ''));
check('description and notes stay editable on a posted entry', (await err(`UPDATE journal_entries SET description = 'MUD 7/28', notes = 'n' WHERE id = $1`, [je])) === null);
check('header metadata stays editable on a posted entry (needs_review, classification_reason, document link, prior-period flag)', (await err(`UPDATE journal_entries SET needs_review = true, classification_reason = 'r', source_document_id = gen_random_uuid(), source_document_path = 'p', prior_period_through = '2026-07-31' WHERE id = $1`, [je])) === null);
check('the posting date of a posted entry cannot change', IMM.test(await err(`UPDATE journal_entries SET posting_date = '2026-10-09' WHERE id = $1`, [je]) || ''));
check('the period of a posted entry cannot change', IMM.test(await err(`UPDATE journal_entries SET period_id = gen_random_uuid() WHERE id = $1`, [je]) || ''));
check('a posted entry cannot move to another community', IMM.test(await err(`UPDATE journal_entries SET community_id = $2 WHERE id = $1`, [je, EW]) || ''));
check('the reversal link of a posted entry cannot change', IMM.test(await err(`UPDATE journal_entries SET reverses_je_id = (SELECT id FROM journal_entries WHERE reference = 'JE-2026-00169') WHERE id = $1`, [je]) || ''));

// A draft line cannot be moved into a posted entry.
const { id: dft } = await q1(`INSERT INTO journal_entries (community_id, posting_date, reference, total_debits_cents, total_credits_cents, status) VALUES ($1, '2026-10-03', 'DRAFT-1', 100, 100, 'draft') RETURNING id`, [LOPF]);
await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit_cents) VALUES ($1, 1, $2, 100), ($1, 2, $3, 100)`, [dft, A5205, A2000]);
await db.query(`UPDATE journal_entry_lines SET debit_cents = 0, credit_cents = 100 WHERE journal_entry_id = $1 AND line_number = 2`, [dft]);
check('moving a line into a posted entry is refused', IMM.test(await err(`UPDATE journal_entry_lines SET journal_entry_id = $2 WHERE journal_entry_id = $1 AND line_number = 1`, [dft, je]) || ''));

// ---------------------------------------------------------------- legitimate paths still work
// editJournalEntry on a DRAFT: delete its lines, insert the replacement, update its totals; then post it.
const draftEditRun = await (async () => { try { await db.exec(`
  DELETE FROM journal_entry_lines WHERE journal_entry_id = '${dft}';
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit_cents, credit_cents) VALUES ('${dft}', 1, '${A5205}', 250, 0), ('${dft}', 2, '${A2000}', 0, 250);
  UPDATE journal_entries SET total_debits_cents = 250, total_credits_cents = 250 WHERE id = '${dft}';
  UPDATE journal_entry_lines SET memo = 'edited' WHERE journal_entry_id = '${dft}';`); return null; } catch (e) { return e.message; } })();
check('a DRAFT\'s lines are still fully editable (delete, reinsert, change totals, edit a line), the editJournalEntry path', draftEditRun === null && (await q1(`SELECT count(*)::int n, sum(debit_cents)::int d FROM journal_entry_lines WHERE journal_entry_id = $1`, [dft])).d === 250, draftEditRun);
check('a draft can be posted', (await err(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [dft])) === null);
check('... and once posted its lines are permanent', IMM.test(await err(`DELETE FROM journal_entry_lines WHERE journal_entry_id = $1`, [dft]) || ''));
check('deleting a draft line still works', await (async () => {
  const { id: d2 } = await q1(`INSERT INTO journal_entries (community_id, posting_date, reference, status) VALUES ($1, '2026-10-03', 'DRAFT-2', 'draft') RETURNING id`, [LOPF]);
  await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit_cents) VALUES ($1, 1, $2, 5)`, [d2, A5205]);
  return (await err(`DELETE FROM journal_entry_lines WHERE journal_entry_id = $1`, [d2])) === null && (await err(`DELETE FROM journal_entries WHERE id = $1`, [d2])) === null;
})());

// postJournalEntry: header inserted as posted, then its lines (INSERT unchanged); failed-insert rollback deletes a header with no lines.
const posted = await postedAccrual('JE-2026-T0200', 1200);
check('posting still works: a posted header, then its lines', (await linesOf(posted)) === 2);
const { id: orphan } = await q1(`INSERT INTO journal_entries (community_id, posting_date, reference, total_debits_cents, total_credits_cents) VALUES ($1, '2026-10-04', 'JE-2026-T0201', 9, 9) RETURNING id`, [LOPF]);
check('the failed-insert rollback (delete a posted header that never got its lines) still works', (await err(`DELETE FROM journal_entries WHERE id = $1`, [orphan])) === null);

// voidJournalEntry: post the reversal, then flip the original to voided.
const { id: rev } = await q1(`INSERT INTO journal_entries (community_id, posting_date, reference, source_module, total_debits_cents, total_credits_cents, reverses_je_id) VALUES ($1, '2026-10-05', 'VOID-T0200', 'reversal', 1200, 1200, $2) RETURNING id`, [LOPF, posted]);
await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit_cents) VALUES ($1, 1, $2, 1200)`, [rev, A2000]);
await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, credit_cents) VALUES ($1, 2, $2, 1200)`, [rev, A5205]);
check('the void flip still works (posted -> voided with its reversal)', (await err(`UPDATE journal_entries SET status = 'voided', voided_at = now(), void_reason = 'dup', void_reversal_je_id = $2 WHERE id = $1`, [posted, rev])) === null);
check('a voided entry\'s lines are permanent too', IMM.test(await err(`DELETE FROM journal_entry_lines WHERE journal_entry_id = $1`, [posted]) || ''));
check('a voided entry cannot return to draft', IMM.test(await err(`UPDATE journal_entries SET status = 'draft' WHERE id = $1`, [posted]) || ''));
check('a void is final: voided -> posted is refused (its reversal is live)', IMM.test(await err(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [posted]) || ''));
check('a void is final: its reversal link cannot be cleared', IMM.test(await err(`UPDATE journal_entries SET void_reversal_je_id = NULL WHERE id = $1`, [posted]) || ''));
check('notes on a voided entry stay editable', (await err(`UPDATE journal_entries SET notes = 'voided: duplicate' WHERE id = $1`, [posted])) === null);

// Conversion retirement (454): posted -> superseded, and its restore superseded -> posted.
const sup = await postedAccrual('VANTACA-DAILY-0701', 300);
check('the superseded flip still works', (await err(`UPDATE journal_entries SET status = 'superseded', superseded_at = now(), superseded_reason = 'conversion', superseded_by_conversion = 'CONV-T' WHERE id = $1`, [sup])) === null);
check('... and its restore', (await err(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [sup])) === null);

// The four LOPF headers stay exactly as they were.
check('JE-2026-00169..00172 unchanged: four posted headers, $6,277.75, still no lines (529 repairs nothing)', await (async () => {
  const x = await q1(`SELECT count(*)::int n, sum(total_debits_cents)::int t, sum((SELECT count(*) FROM journal_entry_lines l WHERE l.journal_entry_id = je.id))::int lines FROM journal_entries je WHERE reference IN ('JE-2026-00169','JE-2026-00170','JE-2026-00171','JE-2026-00172') AND status = 'posted'`);
  return x.n === 4 && x.t === 627775 && x.lines === 0;
})());

// ---------------------------------------------------------------- coexistence with 528 (books closed)
if (HAS_528) {
  fs.writeFileSync(path.join(dir, F528), lf(`${REPO}/migrations/${F528}`));
  await db.exec(lf(`${REPO}/migrations/${F528}`));
  const { id: ew } = await q1(`SELECT gen_random_uuid() id`);
  // A former client's posted entry, written before 528 closed its books.
  await db.exec(`ALTER TABLE journal_entries DISABLE TRIGGER trg_journal_entries_books_closed; ALTER TABLE journal_entry_lines DISABLE TRIGGER trg_journal_entry_lines_books_closed;`);
  await db.query(`INSERT INTO journal_entries (id, community_id, posting_date, reference, total_debits_cents, total_credits_cents) VALUES ($1, $2, '2026-09-01', 'EW-1', 10, 10)`, [ew, EW]);
  await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit_cents) VALUES ($1, 1, $2, 10)`, [ew, A5205]);
  await db.exec(`ALTER TABLE journal_entries ENABLE TRIGGER trg_journal_entries_books_closed; ALTER TABLE journal_entry_lines ENABLE TRIGGER trg_journal_entry_lines_books_closed;`);
  const e1 = await err(`DELETE FROM journal_entry_lines WHERE journal_entry_id = $1`, [ew]);
  check('with 528: a former client\'s posted lines are refused (by 528 or 529, either way kept)', /books_closed|posted_lines_immutable/.test(e1 || '') && (await linesOf(ew)) === 1, e1);
  check('with 528: an active community\'s draft edit still works under both guards', (await err(`UPDATE journal_entries SET description = 'ok' WHERE id = $1`, [je])) === null);
  check('with 528: an active community\'s posted lines are still refused by 529', IMM.test(await err(`DELETE FROM journal_entry_lines WHERE journal_entry_id = $1`, [je]) || ''));
} else {
  console.log('SKIP  528 coexistence (migration 528 not on this branch yet)');
}

// ---------------------------------------------------------------- drift
const drift = await buildWorld({ fifthEmpty: true });
const plan2 = await A.planMigration({ ...ctx(drift.client), filename: F });
check('drift: a FIFTH non-draft entry with no lines stops the plan at preflight (new damage must be looked at first)', plan2.status !== 'ready' && !plan2.plan_token, JSON.stringify({ status: plan2.status }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
