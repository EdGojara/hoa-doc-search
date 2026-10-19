'use strict';
// ============================================================================
// tests/test_tessa_rls.js  (Ed 2026-10-19) — Tessa's tables, tested in real Postgres
// ----------------------------------------------------------------------------
// PGlite (Postgres compiled to WebAssembly, already a dev dependency) runs the
// REAL migrations that build Tessa's tables, with Supabase's three roles:
//   anon, authenticated (every signed-in user, staff included), service_role
//   (the server's key; BYPASSRLS, like Supabase).
// Worst case is assumed: Supabase's default privileges grant ALL on new tables
// to anon and authenticated. Then, as each role, it tries SELECT / INSERT /
// UPDATE / DELETE on every Tessa table, before and after migration 537, and runs
// 537's own checks file (preflight before, verify after) against the database.
//   node tests/test_tessa_rls.js
// ============================================================================
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const check = async (name, fn) => { try { await fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '\n     ', e.message); } };

const TABLES = ['ea_inbox', 'ea_followups', 'ea_contacts', 'ea_standing_tasks', 'tessa_outbox', 'ea_email_events', 'ea_contact_email_history', 'ea_followup_events'];
const BUILD = ['284_ea_followups', '285_ea_inbox', '344_ea_contacts', '345_ea_contacts_title_resp', '346_ea_standing_tasks', '372_ea_contacts_from_email', '373_ea_inbox_body_full',
  '377_ea_inbox_cc_awareness', '380_ea_inbox_recipients', '405_tessa_outbox', '492_tessa_outbox_meeting_mode', '499_ea_email_address_status'];
const sql = (f) => fs.readFileSync(path.join(ROOT, 'migrations', f + '.sql'), 'utf8');

async function as(db, role, q, params) {
  await db.exec(`SET ROLE ${role}`);
  try { return await db.query(q, params); } finally { await db.exec('RESET ROLE'); }
}
async function denied(db, role, q) {
  try { await as(db, role, q); return false; } catch (e) { if (/permission denied|row-level security/i.test(e.message)) return true; throw e; }
}

(async () => {
  let PGlite;
  try { ({ PGlite } = await import('@electric-sql/pglite')); }
  catch (e) { console.log('  ✗ PGlite is not installed (npm install).'); process.exit(1); }
  const db = new PGlite();
  console.log('Tessa tables in real Postgres (PGlite)');

  // Supabase's roles and its default grants (the worst case for privacy).
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    CREATE TABLE communities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
    CREATE TABLE work_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE OR REPLACE FUNCTION trusted_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
    INSERT INTO communities (id, name) VALUES ('a0000000-0000-4000-8000-0000000000a1', 'August Meadows');`);
  for (const f of BUILD) { try { await db.exec(sql(f)); } catch (e) { console.log(`  ✗ could not apply ${f}: ${e.message}`); process.exit(1); } }
  await db.exec(`INSERT INTO ea_inbox (graph_id, from_email, subject, body_preview, status) VALUES ('g1', 'paulgrover@ventanaland.com', 'RE: Tax return', 'Hi Paul, please print, sign and scan', 'dismissed');
                 INSERT INTO ea_followups (title) VALUES ('Existing follow-up');`);

  await check('BEFORE 537: a signed-in staff user (authenticated) can read Ed\'s Tessa inbox directly — the gap being closed', async () => {
    const r = await as(db, 'authenticated', 'SELECT subject FROM ea_inbox');
    assert.equal(r.rows.length, 1, 'exposed before the migration');
  });

  const checks = JSON.parse(fs.readFileSync(path.join(ROOT, 'migrations/checks/537_tessa_copied_fyi_private.json'), 'utf8'));
  await check('537 checks file: every preflight query passes against the real schema', async () => {
    for (const p of checks.preflight) {
      const r = await db.query(p.sql); const v = Object.values(r.rows[0])[0];
      assert.equal(Number(v), p.expect, `${p.name}: got ${v}`);
    }
  });

  await check('537 applies cleanly as one transaction', async () => { await db.exec(sql('537_tessa_copied_fyi_private')); });

  await check('537 checks file: every verify query passes after the migration', async () => {
    for (const v of checks.verify) {
      const r = await db.query(v.sql); const got = Object.values(r.rows[0])[0];
      assert.equal(Number(got), v.expect, `${v.name}: got ${got}`);
    }
  });

  for (const role of ['authenticated', 'anon']) {
    await check(`AFTER 537: ${role} is refused SELECT, INSERT, UPDATE and DELETE on all eight Tessa tables`, async () => {
      for (const t of TABLES) {
        assert.ok(await denied(db, role, `SELECT * FROM ${t} LIMIT 1`), `${role} SELECT ${t}`);
        assert.ok(await denied(db, role, `INSERT INTO ${t} DEFAULT VALUES`), `${role} INSERT ${t}`);
        assert.ok(await denied(db, role, `UPDATE ${t} SET id = id`), `${role} UPDATE ${t}`);
        assert.ok(await denied(db, role, `DELETE FROM ${t}`), `${role} DELETE ${t}`);
      }
    });
  }

  await check('AFTER 537: even an explicit GRANT later would not expose rows (RLS on, no policy)', async () => {
    await db.exec('GRANT SELECT ON ea_inbox TO authenticated');
    const r = await as(db, 'authenticated', 'SELECT * FROM ea_inbox');
    assert.equal(r.rows.length, 0);
    await db.exec('REVOKE SELECT ON ea_inbox FROM authenticated');
  });

  await check('AFTER 537: the server (service_role) still reads and writes Tessa\'s tables', async () => {
    const r = await as(db, 'service_role', 'SELECT subject FROM ea_inbox'); assert.equal(r.rows.length, 1);
    await as(db, 'service_role', "UPDATE ea_inbox SET status = 'fyi' WHERE graph_id = 'g1'");
    const f = await as(db, 'service_role', "INSERT INTO ea_followups (title, kind, community_id, steps) VALUES ('Signed 1120-H', 'signed_return', 'a0000000-0000-4000-8000-0000000000a1', '{}'::jsonb) RETURNING id");
    await as(db, 'service_role', "INSERT INTO ea_followup_events (followup_id, event, actor) VALUES ($1, 'delegated', 'Ed Gojara')", [f.rows[0].id]);
    assert.equal((await as(db, 'service_role', 'SELECT count(*)::int AS n FROM ea_followup_events')).rows[0].n, 1);
  });

  await check('AFTER 537: the audit trail is append-only, even for the server', async () => {
    assert.ok(await denied(db, 'service_role', "UPDATE ea_followup_events SET actor = 'someone else'"), 'UPDATE');
    assert.ok(await denied(db, 'service_role', 'DELETE FROM ea_followup_events'), 'DELETE');
  });

  await check('AFTER 537: the database enforces the step rules it owns (status, kind, event names)', async () => {
    await assert.rejects(as(db, 'service_role', "UPDATE ea_inbox SET status = 'archived'"), /ea_inbox_status_check/);
    await assert.rejects(as(db, 'service_role', "INSERT INTO ea_followups (title, kind) VALUES ('x', 'anything')"), /ea_followups_kind_check/);
    const id = (await as(db, 'service_role', "SELECT id FROM ea_followups WHERE kind = 'signed_return' LIMIT 1")).rows[0].id;
    await assert.rejects(as(db, 'service_role', "INSERT INTO ea_followup_events (followup_id, event, actor) VALUES ($1, 'mailed_by_tessa', 'tessa')", [id]), /ea_followup_events_event_check/);
    await assert.rejects(as(db, 'service_role', `DELETE FROM ea_followups WHERE id = '${id}'`), /permission denied|violates foreign key/i);
  });

  await check('AFTER 537: existing rows are untouched (existing follow-up is kind task; the inbox row kept its data)', async () => {
    const f = await db.query("SELECT kind FROM ea_followups WHERE title = 'Existing follow-up'"); assert.equal(f.rows[0].kind, 'task');
    const i = await db.query("SELECT body_preview FROM ea_inbox WHERE graph_id = 'g1'"); assert.match(i.rows[0].body_preview, /please print/);
  });

  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
