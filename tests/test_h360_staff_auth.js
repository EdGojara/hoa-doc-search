// tests/test_h360_staff_auth.js  (Ed 2026-10-24) — Homeowner 360 Phase 2: every
// sensitive write uses the employee's OWN trustEd sign-in, never the shared
// staff-password cookie and never a name typed into the request body.
//
// THE SCAR. The 360's write routes trusted only the shared gate cookie, which
// names nobody. 82 violations were closed from the Resolve button with no record
// of who closed them or what stage they were at; the certified-number audit line
// printed whatever user_name the browser sent; and the note author field read
// actor.id, which the auth helper never sets, so no note ever saved its author.
//
// Live route checks run the real router against an in-memory Supabase stub (no
// network, no database). A STATIC check fails the build if any write route in
// api/homeowner_360.js skips the shared requireStaffWrite helper, or if any write
// fetch in public/homeowner.html skips hoWrite (which sends the sign-in token).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
process.env.SUPABASE_URL = 'http://localhost:1'; process.env.SUPABASE_KEY = 'test-key';
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ── in-memory Supabase stub ────────────────────────────────────────────────
const TOKENS = { 'martha-token': 'u-martha', 'inactive-token': 'u-gone' };
let DB; let FAIL_INSERT = {};
function resetDb() {
  FAIL_INSERT = {};
  DB = {
    user_profiles: [
      { id: 'u-martha', role: 'staff', is_active: true, full_name: 'Martha Bravo', email: 'martha@bedrocktx.com' },
      { id: 'u-gone', role: 'staff', is_active: false, full_name: 'Former Staffer', email: 'gone@bedrocktx.com' },
    ],
    property_ownerships: [{ contact_id: 'c1', property_id: 'p1', is_primary: true, end_date: null,
      properties: { id: 'p1', street_address: '1 Main St', unit: null, community_id: 'cm1', communities: { name: 'Test Community' } } }],
    violations: [
      { id: 'v1', property_id: 'p1', community_id: 'cm1', current_stage: 'certified_209', resolved_at: null, resolved_via: null, resolved_notes: null },
      { id: 'v2', property_id: 'p1', community_id: 'cm1', current_stage: 'courtesy_1', resolved_at: null, resolved_via: null, resolved_notes: null },
    ],
    interactions: [
      { id: 'n1', type: 'internal_note', content: 'old note', community_id: 'cm1', property_id: 'p1' },
      { id: 'n2', type: 'internal_note', content: 'to delete', community_id: 'cm1', property_id: 'p1' },
      { id: 'L1', type: 'letter_209', notes: null, delivery_method: null, community_id: 'cm1', property_id: 'p1' },
    ],
    account_attachments: [{ id: 'a1', file_path: 'account-attachments/cm1/p1/x.jpg' }],
    identity_verifications: [],
    email_messages: [],
    contacts: [],
  };
}
let seq = 0;
function from(table) {
  const st = { op: 'select', filters: [], payload: null };
  const match = () => (DB[table] || []).filter((r) => st.filters.every((f) => f(r)));
  async function exec() {
    if (st.op === 'insert') {
      if (FAIL_INSERT[table]) return { data: null, error: { message: 'insert refused (test)' } };
      const rows = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((p) => ({ id: 'new-' + (++seq), created_at: new Date().toISOString(), ...p }));
      (DB[table] = DB[table] || []).push(...rows);
      return { data: rows, error: null };
    }
    if (st.op === 'update') { const rows = match(); rows.forEach((r) => Object.assign(r, st.payload)); return { data: rows, error: null }; }
    if (st.op === 'delete') { const rows = match(); DB[table] = DB[table].filter((r) => !rows.includes(r)); return { data: rows, error: null }; }
    return { data: match(), error: null };
  }
  const one = () => exec().then(({ data, error }) => ({ data: Array.isArray(data) ? (data[0] || null) : data, error }));
  const q = {
    select() { return q; },
    insert(p) { st.op = 'insert'; st.payload = p; return q; },
    update(p) { st.op = 'update'; st.payload = p; return q; },
    delete() { st.op = 'delete'; return q; },
    eq(c, v) { st.filters.push((r) => r[c] === v); return q; },
    is(c, v) { st.filters.push((r) => (r[c] === undefined ? null : r[c]) === v); return q; },
    in(c, vs) { st.filters.push((r) => vs.includes(r[c])); return q; },
    or() { return q; }, order() { return q; }, limit() { return q; }, ilike() { return q; }, like() { return q; },
    maybeSingle: one, single: one,
    then(res, rej) { return exec().then(res, rej); },
  };
  return q;
}
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('@supabase/supabase-js', { createClient: () => ({
  auth: { getUser: async (t) => (TOKENS[t] ? { data: { user: { id: TOKENS[t], email: 'x@bedrocktx.com' } }, error: null } : { data: { user: null }, error: { message: 'invalid' } }) },
  from,
  storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }), createSignedUrl: async () => ({ data: { signedUrl: 'https://signed.example/x' }, error: null }) }) },
}) });

const express = require('express');
const h360 = require('../api/homeowner_360');
const app = express(); app.use('/api/homeowner', h360.router);

// Every write route, with a body that would get past validation once signed in.
const WRITES = [
  ['POST', '/verify-identity', { contact_id_1: 'c1', contact_id_2: 'c2', result: 'different_people' }],
  ['POST', '/email-letter', {}],
  ['POST', '/c1/note', { content: 'hello' }],
  ['POST', '/c1/attachment', 'multipart'],
  ['DELETE', '/attachment/a1', null],
  ['PATCH', '/note/n1', { content: 'edited' }],
  ['DELETE', '/note/n2', null],
  ['POST', '/import-review', 'multipart-empty'],
  ['POST', '/import-file', { email: { subject: 's' }, links: [{ role: 'from', contact_id: 'c1', community_id: 'cm1' }] }],
  ['POST', '/violations/v1/resolve', { note: 'Photo proof received — cured' }],
  ['POST', '/interactions/L1/certified-number', { certified_tracking_number: '9589071052701234567890' }],
];

let passed = 0; let failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { failed++; console.error('  ✗', name, '\n     ', e.message); }
};

(async () => {
  console.log('h360_staff_auth:');
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api/homeowner`;
  const call = (method, p, body, token) => {
    const headers = { Cookie: 'bedrock_gate=shared-staff-cookie' };
    if (token) headers.Authorization = 'Bearer ' + token;
    let payload;
    if (body === 'multipart' || body === 'multipart-empty') {
      payload = new FormData();
      if (body === 'multipart') { payload.append('file', new Blob([Buffer.from([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }), 'p.jpg'); payload.append('captured_by', 'Ed Gojara'); }
    } else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    return fetch(base + p, { method, headers, body: payload });
  };
  const quiet = async (fn) => { const w = console.warn, l = console.log, e = console.error; const seen = []; console.warn = (...a) => seen.push(a); console.log = () => {}; console.error = () => {}; try { await fn(seen); } finally { console.warn = w; console.log = l; console.error = e; } return seen; };

  // ── enforce mode ─────────────────────────────────────────────────────────
  process.env.H360_AUTH_MODE = 'enforce';
  await check(`enforce: all ${WRITES.length} write routes refuse a request with only the shared staff cookie, and nothing is written`, async () => {
    resetDb(); const before = JSON.stringify(DB);
    await quiet(async () => {
      for (const [m, p, b] of WRITES) {
        const r = await call(m, p, b, null);
        assert.strictEqual(r.status, 403, `${m} ${p} returned ${r.status}`);
        const j = await r.json();
        assert.strictEqual(j.error, 'sign_in_required', `${m} ${p}`);
        assert.strictEqual(j.detail, 'Your sign-in expired. Please sign in again.');
      }
    });
    assert.strictEqual(JSON.stringify(DB), before, 'a refused request changed data');
  });
  await check('enforce: an invalid token and a deactivated employee are refused too', async () => {
    resetDb();
    await quiet(async () => {
      assert.strictEqual((await call('POST', '/c1/note', { content: 'x' }, 'forged-token')).status, 403);
      assert.strictEqual((await call('POST', '/c1/note', { content: 'x' }, 'inactive-token')).status, 403);
    });
  });
  await check('enforce: with a staff sign-in every write route proceeds past the gate', async () => {
    resetDb();
    await quiet(async () => {
      for (const [m, p, b] of WRITES) {
        const r = await call(m, p, b, 'martha-token');
        const j = await r.json().catch(() => ({}));
        assert.notStrictEqual(j.error, 'sign_in_required', `${m} ${p} still refused`);
        assert.ok(r.status !== 403, `${m} ${p} returned 403 (${j.error})`);
      }
    });
  });

  // ── attribution from the session ─────────────────────────────────────────
  await check('note: the author is the signed-in employee (sent_by_user_id), which was always blank before', async () => {
    resetDb();
    const r = await quiet(() => call('POST', '/c1/note', { content: 'Called owner', user_name: 'Ed Gojara' }, 'martha-token'));
    const note = DB.interactions.find((i) => i.content === 'Called owner');
    assert.ok(note, 'note written'); assert.strictEqual(note.sent_by_user_id, 'u-martha');
    assert.strictEqual(note.type, 'internal_note');
  });
  await check('certified-number: a spoofed user_name in the body is ignored; the audit line names the signed-in employee', async () => {
    resetDb();
    let status;
    await quiet(async () => { status = (await call('POST', '/interactions/L1/certified-number', { certified_tracking_number: '9589 0710 5270 1234 5678 90', user_name: 'Ed Gojara' }, 'martha-token')).status; });
    assert.strictEqual(status, 200);
    const L1 = DB.interactions.find((i) => i.id === 'L1');
    assert.match(L1.notes, /by Martha Bravo: 9589071052701234567890/);
    assert.ok(!/Ed Gojara/.test(L1.notes), 'spoofed name leaked into the audit line');
  });
  await check('attachment: captured_by comes from the sign-in, not the form field', async () => {
    resetDb();
    await quiet(() => call('POST', '/c1/attachment', 'multipart', 'martha-token'));
    const a = DB.account_attachments.find((x) => x.id !== 'a1');
    assert.ok(a, 'attachment indexed'); assert.strictEqual(a.captured_by, 'Martha Bravo');
  });
  await check('verify-identity: verified_by is the signed-in employee id (was always null before)', async () => {
    resetDb();
    await quiet(() => call('POST', '/verify-identity', { contact_id_1: 'c1', contact_id_2: 'c2', result: 'same_person' }, 'martha-token'));
    assert.strictEqual(DB.identity_verifications[0].verified_by, 'u-martha');
  });
  await check('import-file: the filed email records who filed it', async () => {
    resetDb();
    await quiet(() => call('POST', '/import-file', { email: { subject: 's' }, links: [{ role: 'from', contact_id: 'c1', community_id: 'cm1' }] }, 'martha-token'));
    assert.strictEqual(DB.email_messages[0].extracted.imported_by, 'Martha Bravo');
    assert.strictEqual(DB.email_messages[0].extracted.imported_by_user_id, 'u-martha');
  });

  // ── resolve ──────────────────────────────────────────────────────────────
  await check('resolve: no reason is refused with 400 and the case stays open', async () => {
    resetDb();
    for (const body of [{}, { note: '' }, { note: '   ' }]) {
      const r = await call('POST', '/violations/v1/resolve', body, 'martha-token');
      assert.strictEqual(r.status, 400); assert.strictEqual((await r.json()).error, 'reason_required');
    }
    const v = DB.violations.find((x) => x.id === 'v1');
    assert.strictEqual(v.resolved_at, null); assert.strictEqual(v.current_stage, 'certified_209');
  });
  await check('resolve: writes a timeline note naming who, when, why, and the stage before closing', async () => {
    resetDb();
    let j;
    await quiet(async () => { j = await (await call('POST', '/violations/v1/resolve', { note: 'Photo proof received — cured', resolved_via: 'cured' }, 'martha-token')).json(); });
    assert.strictEqual(j.ok, true); assert.strictEqual(j.prior_stage, 'certified_209');
    const v = DB.violations.find((x) => x.id === 'v1');
    assert.ok(v.resolved_at); assert.strictEqual(v.resolved_via, 'cured');
    assert.strictEqual(v.current_stage, 'cured', 'stage overwrite behaviour unchanged in this PR');
    const n = DB.interactions.find((i) => i.violation_id === 'v1');
    assert.ok(n, 'attribution note written');
    assert.strictEqual(n.type, 'observation_note'); assert.strictEqual(n.direction, 'internal'); assert.strictEqual(n.source, 'manual');
    assert.strictEqual(n.property_id, 'p1'); assert.strictEqual(n.community_id, 'cm1'); assert.strictEqual(n.sent_by_user_id, 'u-martha');
    assert.match(n.content, /^Closed from Homeowner 360 by Martha Bravo on \d{4}-\d{2}-\d{2}: Photo proof received — cured/);
    assert.match(n.content, /Stage before closing: Certified 209 \(certified_209\)/);
    assert.ok(!/^Stage (advanced|corrected|recalculated|reset|recomputed)/i.test(n.subject), 'the 360 timeline filter would hide it');
  });
  await check('resolve: if the attribution note cannot be saved, the closure is undone (never closed without a name)', async () => {
    resetDb(); FAIL_INSERT.interactions = true;
    let r;
    await quiet(async () => { r = await call('POST', '/violations/v2/resolve', { note: 'Verified cured in field' }, 'martha-token'); });
    assert.strictEqual(r.status, 500); assert.strictEqual((await r.json()).error, 'audit_failed');
    const v = DB.violations.find((x) => x.id === 'v2');
    assert.strictEqual(v.resolved_at, null); assert.strictEqual(v.current_stage, 'courtesy_1');
  });
  await check('resolve: an already-closed case is not closed twice and gets no second note', async () => {
    resetDb(); DB.violations[0].resolved_at = '2026-10-01T00:00:00.000Z';
    const j = await (await call('POST', '/violations/v1/resolve', { note: 'x' }, 'martha-token')).json();
    assert.strictEqual(j.already_resolved, true);
    assert.ok(!DB.interactions.some((i) => i.violation_id === 'v1'));
  });

  // ── log mode (the default) ───────────────────────────────────────────────
  delete process.env.H360_AUTH_MODE;
  await check('log mode (default): an unsigned write is accepted but logged, and records no author', async () => {
    resetDb();
    let r;
    const warns = await quiet(async () => { r = await call('POST', '/c1/note', { content: 'cookie only' }, null); });
    assert.strictEqual(r.status, 200);
    assert.ok(warns.some((a) => a[0] === '[homeowner360.auth] unauthenticated write' && /\/api\/homeowner\/:contactId\/note/.test(a[1].route)), 'warn not logged');
    assert.strictEqual(DB.interactions.find((i) => i.content === 'cookie only').sent_by_user_id, null);
  });
  await check('log mode: resolve still requires a reason and the note says the closer was not signed in', async () => {
    resetDb();
    await quiet(async () => { assert.strictEqual((await call('POST', '/violations/v1/resolve', {}, null)).status, 400); });
    await quiet(() => call('POST', '/violations/v1/resolve', { note: 'Owner corrected — resolved' }, null));
    const n = DB.interactions.find((i) => i.violation_id === 'v1');
    assert.match(n.content, /by Unidentified staff \(not signed in\)/); assert.strictEqual(n.sent_by_user_id, null);
  });
  await check('log mode never loosens a route that was already strict: email-letter still needs a sign-in', async () => {
    resetDb();
    await quiet(async () => { assert.strictEqual((await call('POST', '/email-letter', { letter_path: 'x.pdf', to_email: 'a@b.co' }, null)).status, 403); });
  });
  await check('an unknown mode value falls back to log, not to open or locked', async () => {
    process.env.H360_AUTH_MODE = 'Enforce '; assert.strictEqual(h360._test.h360AuthMode(), 'enforce');
    process.env.H360_AUTH_MODE = 'banana'; assert.strictEqual(h360._test.h360AuthMode(), 'log');
    delete process.env.H360_AUTH_MODE;
  });

  // ── STATIC: scars become checks ──────────────────────────────────────────
  await check('STATIC: every router.post/patch/put/delete in api/homeowner_360.js calls requireStaffWrite first', async () => {
    const src = read('api/homeowner_360.js');
    const re = /router\.(post|patch|put|delete)\(\s*'([^']+)'/g; let m; const routes = [];
    while ((m = re.exec(src))) routes.push({ method: m[1], path: m[2], at: m.index });
    assert.ok(routes.length >= WRITES.length, `found ${routes.length} write routes, expected at least ${WRITES.length}`);
    routes.forEach((r) => {
      const next = src.indexOf('\nrouter.', r.at + 1);
      const body = src.slice(r.at, next > 0 ? next : src.length);
      const gate = body.indexOf('await requireStaffWrite(req, res');
      assert.ok(gate > 0, `${r.method.toUpperCase()} ${r.path} does not call requireStaffWrite`);
      const firstDb = body.search(/supabase\.(from|storage)|ownedProperties\(|parseEmailFile\(|queueDraft\(/);
      assert.ok(firstDb < 0 || gate < firstDb, `${r.method.toUpperCase()} ${r.path} touches data before the auth gate`);
      assert.ok(!/body\)?\s*\.\s*user_name|\(req\.body \|\| \{\}\)\.user_name|b\.captured_by/.test(body), `${r.method.toUpperCase()} ${r.path} reads an actor name from the request body`);
    });
    // The every-route-is-listed check: a new write route must be added to WRITES above.
    const listed = new Set(WRITES.map(([mm, p]) => mm.toLowerCase() + ' ' + p.replace(/c1|a1|n1|n2|v1|L1/g, ':x')));
    routes.forEach((r) => assert.ok(listed.has(r.method + ' ' + r.path.replace(/:[A-Za-z]+/g, ':x')), `${r.method.toUpperCase()} ${r.path} has no live auth test in WRITES`));
  });
  await check('STATIC: every write fetch in public/homeowner.html goes through hoWrite (sends the sign-in token, shows the expired message)', async () => {
    const page = read('public/homeowner.html');
    const bare = [...page.matchAll(/(?<![A-Za-z_])fetch\(([^;]{0,300}?)method\s*:\s*'(POST|PATCH|PUT|DELETE)'/g)];
    assert.strictEqual(bare.length, 0, 'bare write fetch: ' + (bare[0] && bare[0][0].slice(0, 120)));
    assert.ok((page.match(/hoWrite\(/g) || []).length >= 13, 'expected hoWrite on every write call');
    assert.match(page, /const HO_SIGNIN_MSG='Your sign-in expired\. Please sign in again\.'/);
    assert.match(page, /async function hoWrite\(url,opts\)\{[\s\S]{0,200}await hoAuthHeader\(\)/);
    assert.match(page, /r\.status===401\|\|r\.status===403/);
  });
  await check('STATIC: the Resolve control makes the employee choose a reason before it submits', async () => {
    const page = read('public/homeowner.html');
    assert.match(page, /const opts='<option value="">Choose a reason…<\/option>'\+RESOLVE_NOTES/);
    const fn = page.slice(page.indexOf('window.doResolve=async function'), page.indexOf('window.doResolve=async function') + 900);
    assert.ok(fn.indexOf('A reason is required to close this case.') > 0 && fn.indexOf('A reason is required') < fn.indexOf('hoWrite('), 'reason check comes before the request');
  });

  srv.close();
  console.log(`\nh360_staff_auth: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch((e) => { console.error('  ✗', e.stack || e.message); process.exit(1); });
