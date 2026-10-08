// tests/sql/499_apply_one_e2e.mjs — migration 499 (Tessa address delivery
// evidence, Nicole Hill) applied END TO END through the single-migration tool
// with its REAL checks file, on top of the real 344 / 345 / 372 ea_contacts
// migrations. Proves: objects exactly as declared, no existing contact changes
// on apply, then the database rules themselves on Nicole's real book:
//   - one event per (email, kind, message), evidence is append-only;
//   - a restore must name a human; a supersede needs an unrestored bounce and a
//     replacement that has not bounced;
//   - ea_supersede_email moves the typo row onto the address Nicole replied
//     from (or points it at the row that already holds it), keeping history;
//   - grants: service_role only, the function is not callable by anon.
// Postgres 17 (PGlite 0.3.x). Skips without PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  499 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '499_ea_email_address_status.sql';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm499-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const PRINT = process.argv.includes('--print-objects');
const OWNER = { id: 'owner-uuid', email: 'owner@example.test' };

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE OR REPLACE FUNCTION trusted_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
  CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);`);
for (const m of ['344_ea_contacts.sql', '345_ea_contacts_title_resp.sql', '372_ea_contacts_from_email.sql']) {
  await db.exec(lf(`${REPO}/migrations/${m}`));
  await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('${m}', 'recorded')`);
}
const client = { query: async (sql, params) => {
  if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
  const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
} };
const ctx = { client, user: OWNER, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' };
const q = async (sql, params) => (await db.query(sql, params)).rows;
const err = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e.message; } };

// Nicole's real book, as it stood.
const HOLTZ = '00000000-0000-0000-0000-00000000a001'; const HILL = '00000000-0000-0000-0000-00000000a002';
const BAD = 'nicoleholtzhiII@aol.com'; const GOOD = 'nicoleholtzhill@aol.com';
await db.query(`INSERT INTO ea_contacts (id, name, email, source) VALUES ($1, 'Nicole Holtzhill', $2, 'manual'), ($3, 'Nicole Hill', $4, 'manual')`, [HOLTZ, GOOD, HILL, BAD]);
const before = JSON.stringify(await q('SELECT id, name, email FROM ea_contacts ORDER BY id'));

const plan = await A.planMigration({ ...ctx, filename: F });
if (PRINT) { const rr = await A.applyMigration({ ...ctx, planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) }); console.log(JSON.stringify((rr.detail || {}).objects || rr, null, 2)); process.exit(0); }
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error, pre: plan.preflight }).slice(0, 600));
const r = await A.applyMigration({ ...ctx, planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 499 applied and verified through the tool (objects as declared, no contact changed)', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error, detail: r.detail }).slice(0, 900));

if (r.status === 'applied') {
  check('apply changed no existing contact', JSON.stringify(await q('SELECT id, name, email FROM ea_contacts ORDER BY id')) === before);

  // Evidence rules.
  const bad = BAD.toLowerCase();
  check('an address must be stored lowercased', /ea_email_events_email_check/.test(await err(`INSERT INTO ea_email_events (email, kind, message_ref, occurred_at) VALUES ($1, 'bounce', 'ndr-1', '2026-10-07T01:14:46Z')`, [BAD]) || ''));
  await db.query(`INSERT INTO ea_email_events (email, kind, message_ref, occurred_at, detail) VALUES ($1, 'bounce', 'ndr-1', '2026-10-07T01:14:46Z', '{"reason":"552 1 Requested mail action aborted, mailbox not found"}')`, [bad]);
  check('the same NDR twice is one event (unique)', /uq_ea_email_events/.test(await err(`INSERT INTO ea_email_events (email, kind, message_ref, occurred_at) VALUES ($1, 'bounce', 'ndr-1', now())`, [bad]) || ''));
  check('evidence is append-only (no UPDATE)', /append-only/.test(await err(`UPDATE ea_email_events SET detail = '{}' WHERE email = $1`, [bad]) || ''));
  check('evidence is append-only (no DELETE)', /append-only/.test(await err(`DELETE FROM ea_email_events WHERE email = $1`, [bad]) || ''));
  check('a restore must name a human', /ea_email_events_restore_actor_check/.test(await err(`INSERT INTO ea_email_events (email, kind, message_ref, occurred_at) VALUES ($1, 'restore', 'restore:x', now())`, [bad]) || ''));
  check('an unknown kind is refused', /ea_email_events_kind_check/.test(await err(`INSERT INTO ea_email_events (email, kind, message_ref, occurred_at) VALUES ($1, 'soft_bounce', 'x', now())`, [bad]) || ''));

  // ea_supersede_email guards.
  check('supersede refused when the old address never bounced', /no unrestored bounce/.test(await err(`SELECT ea_supersede_email('someone@x.com', $1, 'm', now(), '{}', 'tessa')`, [GOOD]) || ''));
  await db.query(`INSERT INTO ea_email_events (email, kind, message_ref, occurred_at) VALUES ('typo@x.com', 'bounce', 'n', '2026-10-01'), ('other@x.com', 'bounce', 'n2', '2026-10-01')`);
  check('supersede refused when the replacement bounced too', /bounced too/.test(await err(`SELECT ea_supersede_email('typo@x.com', 'other@x.com', 'm', now(), '{}', 'tessa')`) || ''));

  // Nicole: the verified address already belongs to "Nicole Holtzhill".
  const res = (await q(`SELECT ea_supersede_email($1, $2, 'm-reply', '2026-10-07T12:14:49Z', '{"inbound_ref":"m-reply","link":"near_typo"}', 'tessa') AS r`, [BAD, GOOD]))[0].r;
  const rows = await q('SELECT id, name, email, superseded_by_contact_id FROM ea_contacts ORDER BY id');
  const hill = rows.find((x) => x.id === HILL); const holtz = rows.find((x) => x.id === HOLTZ);
  check('Nicole: the typo row no longer holds the bounced address and points at the row Nicole replied from', hill.email === null && hill.superseded_by_contact_id === HOLTZ && holtz.email === GOOD, JSON.stringify(rows));
  const hist = await q('SELECT contact_id, contact_name, old_email, new_email, merged_into_contact_id, reason, changed_by, evidence FROM ea_contact_email_history');
  check('Nicole: the old address is preserved in history, with evidence and who changed it',
    hist.length === 1 && hist[0].contact_id === HILL && hist[0].old_email === BAD && hist[0].new_email === GOOD && hist[0].merged_into_contact_id === HOLTZ
      && hist[0].reason === 'bounced_superseded' && hist[0].changed_by === 'tessa' && hist[0].evidence.inbound_ref === 'm-reply', JSON.stringify(hist));
  const sup = await q(`SELECT related_email FROM ea_email_events WHERE email = $1 AND kind = 'supersede'`, [bad]);
  check('Nicole: the supersede is recorded against the bounced address', sup.length === 1 && sup[0].related_email === GOOD && res.good === GOOD);
  check('re-running the supersede is harmless (one event, no new history)',
    !(await err(`SELECT ea_supersede_email($1, $2, 'm-reply', '2026-10-07T12:14:49Z', '{}', 'tessa')`, [BAD, GOOD]))
      && (await q(`SELECT count(*)::int AS n FROM ea_email_events WHERE kind = 'supersede'`))[0].n === 1
      && (await q('SELECT count(*)::int AS n FROM ea_contact_email_history'))[0].n === 1);

  // The single-row case: nobody else holds the verified address -> the row moves to it.
  await db.query(`INSERT INTO ea_contacts (name, email) VALUES ('Dana Typo', 'dana@exampel.com')`);
  await db.query(`INSERT INTO ea_email_events (email, kind, message_ref, occurred_at) VALUES ('dana@exampel.com', 'bounce', 'nd', '2026-10-02')`);
  await db.query(`SELECT ea_supersede_email('dana@exampel.com', 'dana@example.com', 'm-d', '2026-10-03', '{}', 'tessa')`);
  const dana = (await q(`SELECT email FROM ea_contacts WHERE name = 'Dana Typo'`))[0];
  const dh = await q(`SELECT old_email, new_email, merged_into_contact_id FROM ea_contact_email_history WHERE contact_name = 'Dana Typo'`);
  check('single row: the contact moves to the verified address, history keeps the old one', dana.email === 'dana@example.com' && dh.length === 1 && dh[0].old_email === 'dana@exampel.com' && dh[0].merged_into_contact_id === null);

  // A human restore un-bounces; the supersede then refuses (nothing to supersede).
  await db.query(`INSERT INTO ea_email_events (email, kind, message_ref, occurred_at, actor) VALUES ('typo@x.com', 'restore', 'restore:1', '2026-10-05', 'egojara@bedrocktx.com')`);
  check('after a human restore the address is no longer bounced', /no unrestored bounce/.test(await err(`SELECT ea_supersede_email('typo@x.com', 'fresh@x.com', 'm', now(), '{}', 'tessa')`) || ''));

  const priv = (await q(`SELECT has_function_privilege('anon', 'ea_supersede_email(text,text,text,timestamptz,jsonb,text)', 'EXECUTE') AS anon,
    has_function_privilege('authenticated', 'ea_supersede_email(text,text,text,timestamptz,jsonb,text)', 'EXECUTE') AS auth,
    has_function_privilege('service_role', 'ea_supersede_email(text,text,text,timestamptz,jsonb,text)', 'EXECUTE') AS svc,
    has_table_privilege('service_role', 'ea_email_events', 'INSERT') AS ev_ins, has_table_privilege('service_role', 'ea_email_events', 'UPDATE') AS ev_upd,
    has_table_privilege('service_role', 'ea_contact_email_history', 'INSERT') AS h_ins`))[0];
  check('grants: the function is service_role only; events + history are insert/read only', !priv.anon && !priv.auth && priv.svc && priv.ev_ins && !priv.ev_upd && priv.h_ins, JSON.stringify(priv));
  const again = await A.planMigration({ ...ctx, filename: F });
  check('re-apply: the plan refuses once 499 is in place', again.status !== 'ready');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
