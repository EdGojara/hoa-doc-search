#!/usr/bin/env node
// ============================================================================
// test_updated_at_triggers.js  (migration 451)
// ----------------------------------------------------------------------------
// The spine tables (contacts, property_ownerships, property_residencies,
// properties) had updated_at columns but no trigger, so UPDATEs left the
// timestamp frozen. Found during batch LOPF-MAIL-2026-09-24.
//
// Static (always): 451 attaches the house trusted_set_updated_at() trigger,
//   BEFORE UPDATE FOR EACH ROW, to every spine table, and rewrites no data.
// Live (when SUPABASE_DB_URL is set): runs tests/sql/test_updated_at_triggers.sql,
//   which proves UPDATE refreshes updated_at, a stale caller value is
//   overridden, created_at never moves, and INSERT stamps both. That SQL is
//   one DO block that always raises at the end, so it rolls itself back.
// ============================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIG = fs.readFileSync(path.join(ROOT, 'migrations/451_spine_updated_at_triggers.sql'), 'utf8');
const TEST_SQL = fs.readFileSync(path.join(ROOT, 'tests/sql/test_updated_at_triggers.sql'), 'utf8');
const SPINE = ['contacts', 'property_ownerships', 'property_residencies', 'properties'];

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : '  ' + detail}`);
  if (!cond) failed++;
};

const code = MIG.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
for (const t of SPINE) {
  const re = new RegExp(`CREATE TRIGGER trg_${t}_updated_at\\s+BEFORE UPDATE ON ${t}\\s+FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at\\(\\);`);
  ok(`451 attaches trusted_set_updated_at to ${t} (BEFORE UPDATE, per row)`, re.test(code));
  ok(`451 is re-runnable for ${t} (DROP TRIGGER IF EXISTS first)`, code.includes(`DROP TRIGGER IF EXISTS trg_${t}_updated_at ON ${t};`));
}
ok('451 rewrites no rows (no UPDATE/INSERT/DELETE statements)', !/^\s*(UPDATE|INSERT|DELETE)\b/im.test(code));
ok('451 does not redefine the shared trigger function', !/CREATE (OR REPLACE )?FUNCTION/i.test(code));
ok('SQL test always aborts (guaranteed rollback)', /RAISE EXCEPTION 'UPDATED_AT_TEST_PASS/.test(TEST_SQL) && (TEST_SQL.match(/\bDO \$test\$/g) || []).length === 1);

(async () => {
  if (!process.env.SUPABASE_DB_URL) {
    console.log('SKIP  live trigger test (SUPABASE_DB_URL not set)');
  } else {
    const { Client } = require('pg');
    const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
    await db.connect();
    try {
      await db.query(TEST_SQL);
      ok('live trigger test', false, 'the test block returned without raising; it must always raise');
    } catch (e) {
      const pass = /^UPDATED_AT_TEST_PASS/.test(e.message);
      ok('live: UPDATE refreshes updated_at, created_at unchanged, INSERT stamps both', pass, e.message);
      if (pass) console.log('      ' + e.message.replace(/^UPDATED_AT_TEST_PASS\s*/, ''));
    } finally {
      await db.end();
    }
  }
  console.log(failed ? `\n${failed} failure(s)` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
