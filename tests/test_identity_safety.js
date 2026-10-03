// ============================================================================
// tests/test_identity_safety.js  (Issue #15) — legacy identity writes fail closed
// ----------------------------------------------------------------------------
// The production paths that inferred identity / relationships are mounted with a
// stubbed network (every Supabase request is recorded; nothing real is reached).
// Proves: the paused paths answer 423 with a clear message BEFORE any database
// call; add-renter never links a contact by a shared phone or ends a real
// residency silently; automatic contact enrichment needs an exact-email
// identity; thread participants / scanned sheets / name-matched contacts never
// receive contact details; the dormant create-by-name paths throw; the offline
// scripts refuse to run.
// ============================================================================
process.env.SUPABASE_URL = 'http://stub.test';
process.env.SUPABASE_KEY = 'stub-key';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

// ---- network stub: PostgREST-shaped answers from a per-test table map; every request recorded
let calls = []; let tables = {};
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url)); const method = (opts.method || 'GET').toUpperCase();
  const table = u.pathname.replace(/^\/rest\/v1\//, '');
  calls.push({ method, table, query: u.search, body: opts.body || null });
  const single = /vnd\.pgrst\.object/.test(JSON.stringify(opts.headers || {}));
  let rows = method === 'GET' ? (tables[table] || []) : (method === 'POST' ? [{ id: `new-${table}-${calls.length}`, ...(opts.body ? JSON.parse(opts.body) : {}) }] : []);
  if (Array.isArray(rows) && rows.length && method === 'POST' && Array.isArray(JSON.parse(opts.body || '{}'))) rows = JSON.parse(opts.body);
  const body = single ? (rows[0] || null) : rows;
  return new Response(single && !rows.length ? '' : JSON.stringify(body), { status: single && !rows.length ? 406 : 200, headers: { 'content-type': 'application/json', 'content-range': `0-${Math.max(0, rows.length - 1)}/${rows.length}` } });
};
const { router: contactsRouter } = require('../api/contacts');
const { router: rosterRouter } = require('../api/roster_import');
const S = require('../lib/identity_safety');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
async function withApp(fn) {
  const app = express(); app.use('/api', contactsRouter); app.use('/api', rosterRouter);
  const srv = app.listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const realFetch = global.fetch;
  const nodeFetch = (await import('node:http')) && null;   // keep the stub for Supabase; use a raw http client for the app itself
  const req = (method, p, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = require('http').request(base + p, { method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => { let j = {}; try { j = JSON.parse(t); } catch (_) {} resolve({ status: res.statusCode, json: j }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  try { await fn(req); } finally { srv.close(); global.fetch = realFetch; void nodeFetch; }
}
const writes = () => calls.filter((c) => c.method !== 'GET' && c.method !== 'HEAD');

check('paused paths answer 423 with a clear message and make ZERO database calls (Vantaca apply, infer-residency, bulk email/phone apply, roster apply, mailing-delta apply, clean mailings)', async () => withApp(async (req) => {
  const cases = [
    ['POST', '/contacts/vantaca/apply/abc', 'vantaca_contacts_apply'],
    ['POST', '/contacts/infer-residency', 'infer_residency'],
    ['POST', '/contacts/methods/import/abc/apply', 'contact_methods_import_apply'],
    ['POST', '/communities/c1/roster-import/apply', 'roster_import_apply'],
    ['POST', '/communities/c1/mailing-delta/apply', 'mailing_delta_apply'],
    ['POST', '/communities/c1/clean-redundant-mailings', 'clean_redundant_mailings'],
  ];
  for (const [m, p, key] of cases) {
    calls = []; tables = {};
    const r = await req(m, p, { community_id: 'c1', force: true });
    assert.strictEqual(r.status, 423, p); assert.strictEqual(r.json.code, 'PAUSED_IDENTITY_SAFETY'); assert.strictEqual(r.json.paused, key);
    assert.match(r.json.error, /paused .*Issue #15.*Still available:/);
    assert.strictEqual(calls.length, 0, `${p} touched the database: ${JSON.stringify(calls)}`);
  }
}));
check('the clean-mailings DRY RUN (preview) is not blocked; only the real run is', async () => withApp(async (req) => {
  calls = []; tables = { properties: [], property_ownerships: [], contacts: [] };
  const r = await req('POST', '/communities/c1/clean-redundant-mailings?dry_run=true');
  assert.notStrictEqual(r.status, 423); assert.strictEqual(writes().length, 0);
}));
check('add-renter: a phone already on another contact is NOT a silent link (same number != same person); staff must choose', async () => withApp(async (req) => {
  calls = []; tables = { contacts: [{ id: 'owner-1', full_name: 'Alex Morgan', primary_phone: '(555) 010-0001', primary_email: null }] };
  const r = await req('POST', '/property-residencies/add-renter', { property_id: 'p1', full_name: 'Alex Morgan', primary_phone: '555-010-0001' });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.json.code, 'PHONE_MATCHES_EXISTING_CONTACT');
  assert.deepStrictEqual(r.json.candidates.map((c) => c.id), ['owner-1']);
  assert.strictEqual(writes().length, 0, 'nothing written, no residency ended');
}));
check('add-renter: a residency conflict is refused in PREFLIGHT with ZERO writes (no contact created, nothing ended)', async () => withApp(async (req) => {
  calls = []; tables = { contacts: [], property_residencies: [{ id: 'r-real', residency_type: 'renter', source: 'manual' }, { id: 'r-guess', residency_type: 'owner_occupied', source: 'inferred_from_mailing_address' }] };
  const r = await req('POST', '/property-residencies/add-renter', { property_id: 'p1', full_name: 'New Tenant', create_new_contact: true });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.json.code, 'OPEN_RESIDENCY_EXISTS'); assert.deepStrictEqual(r.json.open_residencies.map((x) => x.id), ['r-real']);
  assert.strictEqual(writes().length, 0, `refused request wrote: ${JSON.stringify(writes())}`);
  calls = [];
  const unknown = await req('POST', '/property-residencies/add-renter', { property_id: 'p1', full_name: 'New Tenant', create_new_contact: true, end_residency_ids: ['r-elsewhere'] });
  assert.deepStrictEqual([unknown.status, unknown.json.code], [409, 'END_RESIDENCY_NOT_OPEN_HERE']); assert.strictEqual(writes().length, 0);
  calls = [];
  const legacy = await req('POST', '/property-residencies/add-renter', { property_id: 'p1', full_name: 'New Tenant', create_new_contact: true, end_previous: true });
  assert.deepStrictEqual([legacy.status, legacy.json.code], [400, 'END_PREVIOUS_NOT_ACCEPTED'], 'a blanket "end everything" is not accepted'); assert.strictEqual(writes().length, 0);
}));
check('add-renter: adding a co-tenant (add_alongside) never ends an existing tenant; only guessed rows are ended, by id', async () => withApp(async (req) => {
  calls = []; tables = { contacts: [], property_residencies: [{ id: 'r-tenant', residency_type: 'renter', source: 'manual' }, { id: 'r-guess', residency_type: 'owner_occupied', source: 'inferred_from_mailing_address' }] };
  const r = await req('POST', '/property-residencies/add-renter', { property_id: 'p1', full_name: 'Co Tenant', create_new_contact: true, add_alongside: true });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const ended = writes().filter((w) => w.table === 'property_residencies' && w.method === 'PATCH');
  assert.strictEqual(ended.length, 1); const q = decodeURIComponent(ended[0].query);
  assert.ok(/id=in\.\(r-guess\)/.test(q) && !/r-tenant/.test(q), `only the guessed row is ended: ${q}`);
  assert.ok(/property_id=eq\.p1/.test(q) && /end_date=is\.null/.test(q), 'scoped to this property and still-open rows');
  assert.deepStrictEqual(r.json.kept_residency_ids, ['r-tenant']);
  assert.ok(writes().some((w) => w.table === 'property_residencies' && w.method === 'POST'), 'the co-tenant residency is added');
}));
check('add-renter: an explicit replacement ends ONLY the selected residency(ies); other real ones are kept', async () => withApp(async (req) => {
  calls = []; tables = { contacts: [], property_residencies: [{ id: 'r-a', residency_type: 'renter', source: 'manual' }, { id: 'r-b', residency_type: 'renter', source: 'manual' }] };
  let r = await req('POST', '/property-residencies/add-renter', { property_id: 'p1', full_name: 'Replacement', create_new_contact: true, end_residency_ids: ['r-a'] });
  assert.deepStrictEqual([r.status, r.json.code], [409, 'OPEN_RESIDENCY_EXISTS'], 'r-b is still open and was not acknowledged'); assert.strictEqual(writes().length, 0);
  calls = [];
  r = await req('POST', '/property-residencies/add-renter', { property_id: 'p1', full_name: 'Replacement', create_new_contact: true, end_residency_ids: ['r-a'], add_alongside: true });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const q = decodeURIComponent(writes().find((w) => w.table === 'property_residencies' && w.method === 'PATCH').query);
  assert.ok(/id=in\.\(r-a\)/.test(q) && !/r-b/.test(q), `only r-a ended: ${q}`);
  assert.deepStrictEqual([r.json.ended_residency_ids, r.json.kept_residency_ids], [['r-a'], ['r-b']]);
  calls = []; tables.property_residencies = [{ id: 'r-a', residency_type: 'renter', source: 'manual' }];
  r = await req('POST', '/property-residencies/add-renter', { property_id: 'p1', full_name: 'Replacement', create_new_contact: true, end_residency_ids: ['r-a'] });
  assert.strictEqual(r.status, 200, 'naming every real residency is a full replacement without add_alongside');
}));
check('automatic enrichment from an inbound message needs an exact-email identity; name / address matches never qualify', () => {
  assert.strictEqual(S.mayEnrichFromMessage({ contact_id: 'c', contact_basis: 'email' }), true);
  for (const basis of ['sender_name', 'address_and_name', 'candidate_name', undefined]) assert.strictEqual(S.mayEnrichFromMessage({ contact_id: 'c', confidence: 'high', contact_basis: basis }), false, String(basis));
  const ingest = fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'graph_ingest.js'), 'utf8');
  assert.ok(/mayEnrichFromMessage\(res\)/.test(ingest) && !/res\.confidence === 'high' && res\.contact_id\)/.test(ingest));
  const triage = fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'triage.js'), 'utf8');
  for (const b of ["contact_basis = 'email'", "contact_basis = 'address_and_name'", "contact_basis = 'sender_name'", "contact_basis = 'candidate_name'"]) assert.ok(triage.includes(b), b);
});
check('thread participants, scanned sheets and name-matched ACC contacts never receive contact details (suggestions only)', () => {
  const triage = fs.readFileSync(path.join(__dirname, '..', 'api', 'email_triage.js'), 'utf8');
  const scan = fs.readFileSync(path.join(__dirname, '..', 'api', 'mail_scan.js'), 'utf8');
  assert.ok(!/enrichContactFromEmail/.test(triage), 'email triage (link / assign-homeowner) writes no contact methods');
  assert.ok(/suggested_addresses/.test(triage) && /suggested_contact_methods/.test(triage));
  assert.ok(!/enrichContactFromEmail/.test(scan) && /contact_suggestions/.test(scan), 'mail scan suggests, never writes');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/contact\.match_method === 'email' && toEmail/.test(server), 'ACC finalize writes an email only for a contact identified by that email');
  assert.ok(!/contact\.primary_email \? \{ secondary_email: lower \}/.test(server), 'never overwrites a secondary email');
});
check('the dormant create-by-name / create-by-address paths throw instead of creating', async () => {
  const ER = require('../lib/entity_resolution');
  const chain = () => { const q = { select: () => q, eq: () => q, ilike: () => q, or: () => q, in: () => q, is: () => q, limit: () => q, order: () => q, maybeSingle: async () => ({ data: null, error: null }), then: (r) => r({ data: [], error: null }) }; return q; };
  const sb = { from: () => chain() };
  await assert.rejects(() => ER.resolveContact(sb, { name: 'Alex Morgan', communityId: 'c1', createIfMissing: true }), /disabled \(Issue #15/);
  await assert.rejects(() => ER.resolveProperty(sb, 'c1', '999 Nowhere St', { createIfMissing: true }), /disabled \(Issue #15/);
});
check('offline identity scripts refuse to run unless explicitly allowed', () => {
  for (const s of ['fix_placeholder_owners', 'import_canyon_gate', 'apply_reconciliation', 'apply_mailing_conflicts', 'generate_address_correction_sql']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', `${s}.js`), 'utf8');
    assert.ok(src.includes(`require('./_legacy_identity_guard')('${s}')`), s);
  }
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'fix_placeholder_owners.js')], { env: { ...process.env, ALLOW_LEGACY_IDENTITY_SCRIPT: '' }, encoding: 'utf8' });
  assert.strictEqual(r.status, 3); assert.match(r.stderr, /paused \(Issue #15\)/);
});
check('read paths are untouched: listing contacts still answers (no 423)', async () => withApp(async (req) => {
  calls = []; tables = { contacts: [] };
  const r = await req('GET', '/contacts?q=x');
  assert.notStrictEqual(r.status, 423);
}));

(async () => {
  let pass = 0, fail = 0;
  console.log('Identity safety: legacy identity writes fail closed (Issue #15)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n      ')); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
