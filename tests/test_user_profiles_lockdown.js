// tests/test_user_profiles_lockdown.js  (Ed 2026-10-26, migration 548) — the
// user_profiles privilege-escalation fix stays fixed.
//
// THE SCAR. Migration 039 let every signed-in user write user_profiles directly
// through the database API (no row level security, INSERT/UPDATE/DELETE granted
// to authenticated). A staffer could set role='admin' and the owner's email and
// pass every owner gate, or demote/delete the owner. 548 closes it in the
// database; tests/sql/548_user_profiles_lockdown_e2e.mjs proves that on Postgres.
//
// This file guards the two places it could come back:
//   1) requireOwner: the owner must match on BOTH the profile email and the
//      sign-in (Supabase Auth) email, plus role admin and an active profile;
//   2) STATIC: no later migration may grant authenticated/anon a write on
//      user_profiles or turn its row level security off.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.env.SUPABASE_URL = 'http://localhost:1';
process.env.SUPABASE_KEY = 'service-key';
process.env.OWNER_EMAIL = 'owner@example.test';

// in-memory Supabase stub: token -> auth user; id -> profile
let AUTH; let PROFILES;
function createClient() {
  return {
    auth: { getUser: async (t) => (AUTH[t] ? { data: { user: AUTH[t] }, error: null } : { data: { user: null }, error: { message: 'bad token' } }) },
    from: () => {
      let id = null;
      const q = { select: () => q, eq: (k, v) => { id = v; return q; }, maybeSingle: async () => ({ data: PROFILES[id] || null, error: null }) };
      return q;
    },
  };
}
require.cache[require.resolve('@supabase/supabase-js')] = { id: 'stub', filename: 'stub', loaded: true, exports: { createClient } };
const { requireOwner, isOwnerIdentity } = require('../api/_require_admin');

function reset() {
  AUTH = {
    ed: { id: 'u-ed', email: 'Owner@Example.test' },
    ana: { id: 'u-ana', email: 'ana@example.test' },
    anaRenamed: { id: 'u-ana2', email: 'owner@example.test' },
  };
  PROFILES = {
    'u-ed': { role: 'admin', is_active: true, full_name: 'Ed', email: 'owner@example.test' },
    'u-ana': { role: 'staff', is_active: true, full_name: 'Ana', email: 'ana@example.test' },
    'u-ana2': { role: 'staff', is_active: true, full_name: 'Ana', email: 'ana@example.test' },
  };
}
function res() { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; }
const req = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });

let n = 0;
const t = async (name, fn) => { reset(); await fn(); n++; console.log('  ok ', name); };

(async () => {
  await t('the owner passes (emails compared case-insensitively)', async () => {
    const r = res(); const u = await requireOwner(req('ed'), r);
    assert.ok(u && u.user.id === 'u-ed'); assert.strictEqual(r.code, 200);
  });
  await t('a forged PROFILE (role admin + owner email) with a staff sign-in is refused', async () => {
    PROFILES['u-ana'] = { ...PROFILES['u-ana'], role: 'admin', email: 'owner@example.test' };
    const r = res(); assert.strictEqual(await requireOwner(req('ana'), r), null); assert.strictEqual(r.code, 403);
  });
  await t('a sign-in renamed to the owner email without the owner profile is refused', async () => {
    const r = res(); assert.strictEqual(await requireOwner(req('anaRenamed'), r), null); assert.strictEqual(r.code, 403);
  });
  await t('the owner profile demoted, or deactivated, is refused', async () => {
    PROFILES['u-ed'].role = 'staff';
    assert.strictEqual(await requireOwner(req('ed'), res()), null);
    reset(); PROFILES['u-ed'].is_active = false;
    assert.strictEqual(await requireOwner(req('ed'), res()), null);
  });
  await t('no token, a bad token, or no profile is refused', async () => {
    assert.strictEqual(await requireOwner(req(null), res()), null);
    assert.strictEqual(await requireOwner(req('nope'), res()), null);
    delete PROFILES['u-ed'];
    assert.strictEqual(await requireOwner(req('ed'), res()), null);
  });
  await t('isOwnerIdentity is false for empty input', async () => {
    assert.strictEqual(isOwnerIdentity(null), false);
    assert.strictEqual(isOwnerIdentity({ role: 'admin', email: 'owner@example.test' }), false);
  });
  await t('STATIC: no migration after 548 re-grants writes on user_profiles or turns its RLS off', async () => {
    const dir = path.join(ROOT, 'migrations');
    const later = fs.readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f) && Number(f.slice(0, 3)) >= 548);
    assert.ok(later.includes('548_user_profiles_lockdown.sql'), '548 must exist');
    for (const f of later) {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/--.*$/gm, '');
      for (const stmt of sql.split(';')) {
        const s = stmt.replace(/\s+/g, ' ');
        if (/\bGRANT\b/i.test(s) && /\bON (TABLE )?(public\.)?user_profiles\b/i.test(s) && /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALL)\b/i.test(s) && /\b(authenticated|anon|PUBLIC)\b/i.test(s)) {
          assert.fail(`${f} grants a write on user_profiles to a client role: ${s.trim()}`);
        }
        if (/user_profiles\s+(DISABLE|NO FORCE)\s+ROW LEVEL SECURITY/i.test(s) || /ALTER TABLE (public\.)?user_profiles DISABLE ROW LEVEL SECURITY/i.test(s)) {
          assert.fail(`${f} turns off row level security on user_profiles`);
        }
      }
    }
  });
  await t('STATIC: 548 enables RLS, revokes client writes, and keeps only the own-row read', async () => {
    const sql = fs.readFileSync(path.join(ROOT, 'migrations/548_user_profiles_lockdown.sql'), 'utf8');
    assert.ok(/ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY/.test(sql));
    assert.ok(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON user_profiles FROM authenticated, anon, PUBLIC/.test(sql));
    assert.ok(/CREATE POLICY user_profiles_read_own ON user_profiles\s+FOR SELECT TO authenticated\s+USING \(id = auth\.uid\(\)\)/.test(sql));
    assert.ok(!/\b(UPDATE|INSERT INTO|DELETE FROM)\s+user_profiles\b/i.test(sql.replace(/--.*$/gm, '')), '548 changes no rows');
  });
  console.log(`\n${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
