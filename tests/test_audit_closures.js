// tests/test_audit_closures.js  (Ed 2026-10-24, migration 545)
// The permanent audit trail + closure outcomes + repeat-offense safety.
//
// THE SCARS. 82 cases were closed from the Homeowner 360 Resolve button with no
// record of who closed them, why, or what stage they were at; every closure was
// written as "cured" whatever really happened (a duplicate, a wrong property), so
// a voided or duplicate case could later count as a prior offense; and edits or
// deletions of notes, files and certified numbers left no before/after record.
//
// Route checks run the real Homeowner 360 router against an in-memory Supabase
// stand-in (no network, no database). The migration is checked statically: the
// database-level guarantees (append-only, insert-only grants, stage_at_closure
// immutability, no backfill) must be in the SQL itself.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:1';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const { buildAuditEvent, recordAuditEvent } = require('../lib/audit/record_event');
const CO = require('../lib/enforcement/closure_outcomes');

let passed = 0; let failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { failed++; console.error('  ✗', name, '\n     ', e.message); }
};
const quiet = async (fn) => { const w = console.warn, l = console.log, e = console.error; console.warn = () => {}; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; console.error = e; } };

// ── in-memory Supabase stand-in (same shape as tests/test_h360_staff_auth.js) ──
const TOKENS = { 'martha-token': 'u-martha' };
let DB; let FAIL = {}; let seq = 0;
function resetDb() {
  FAIL = {};
  DB = {
    user_profiles: [{ id: 'u-martha', role: 'staff', is_active: true, full_name: 'Martha Bravo', email: 'martha@bedrocktx.com' }],
    property_ownerships: [],
    violations: [
      { id: 'v1', property_id: 'p1', community_id: 'cm1', current_stage: 'certified_209', resolved_at: null, resolved_via: null, resolved_notes: null, closure_outcome: null },
      { id: 'v2', property_id: 'p1', community_id: 'cm1', current_stage: 'courtesy_1', resolved_at: null, resolved_via: null, resolved_notes: null, closure_outcome: null },
      { id: 'v3', property_id: 'p2', community_id: 'cm1', current_stage: 'courtesy_1', resolved_at: null, resolved_via: null, resolved_notes: null, closure_outcome: null },
    ],
    interactions: [
      { id: 'n1', type: 'internal_note', content: 'old note', community_id: 'cm1', property_id: 'p1', updated_at: '2026-10-01T00:00:00Z' },
      { id: 'n2', type: 'internal_note', content: 'to delete', subject: 'Note', community_id: 'cm1', property_id: 'p1' },
      { id: 'L1', type: 'letter_209', notes: null, delivery_method: 'certified_mail', certified_tracking_number: '9589071052701111111111', community_id: 'cm1', property_id: 'p1' },
      { id: 'L2', type: 'letter_209', notes: null, delivery_method: null, certified_tracking_number: null, community_id: 'cm1', property_id: 'p1' },
    ],
    account_attachments: [
      { id: 'a1', file_path: 'account-attachments/cm1/p1/x.jpg', kind: 'photo', property_id: 'p1', community_id: 'cm1', captured_at: '2026-10-20T00:00:00Z' },
      { id: 'a2', file_path: 'account-attachments/cm1/p2/y.jpg', kind: 'photo', property_id: 'p2', community_id: 'cm1', captured_at: '2026-10-20T00:00:00Z' },
    ],
    inspection_photos: [{ id: 'ip1', reviewer_confirmed_property_id: null, polygon_match_property_id: 'p1', captured_at: '2026-10-21T00:00:00Z', inspection_id: 'ins1' }],
    email_attachments: [],
    audit_events: [],
  };
}
function from(table) {
  const st = { op: 'select', filters: [], payload: null };
  const match = () => (DB[table] || []).filter((r) => st.filters.every((f) => f(r)));
  async function exec() {
    if (st.op === 'insert') {
      if (FAIL[table]) return { data: null, error: { message: 'insert refused (test)' } };
      const rows = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((p) => ({ id: 'new-' + (++seq), created_at: new Date().toISOString(), ...p }));
      (DB[table] = DB[table] || []).push(...rows);
      return { data: rows, error: null };
    }
    if (st.op === 'update') {
      if (table === 'audit_events') return { data: null, error: { message: 'audit_events is append-only' } };
      if (FAIL['update:' + table]) return { data: null, error: { message: 'update refused (test)' } };
      const rows = match(); rows.forEach((r) => Object.assign(r, st.payload)); return { data: rows, error: null };
    }
    if (st.op === 'delete') {
      if (table === 'audit_events') return { data: null, error: { message: 'audit_events is append-only' } };
      if (FAIL['delete:' + table]) return { data: null, error: { message: 'delete refused (test)' } };
      const rows = match(); DB[table] = DB[table].filter((r) => !rows.includes(r)); return { data: rows, error: null };
    }
    return { data: match().map((r) => ({ ...r })), error: null };
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
// close_violation_with_audit stand-in: close + audit event + timeline note as one unit.
const RPC_CALLS = [];
async function rpc(name, p) {
  RPC_CALLS.push({ name, p });
  if (FAIL.rpc) return { data: null, error: { message: 'transaction rolled back (test)' } };
  const v = DB.violations.find((x) => x.id === p.p_violation_id);
  if (!v) return { data: { status: 'not_found' }, error: null };
  if (v.resolved_at) return { data: { status: 'already_resolved' }, error: null };
  if (v.current_stage !== p.p_expected_stage) return { data: { status: 'stage_changed' }, error: null };
  const now = new Date().toISOString(); const prior = v.current_stage;
  Object.assign(v, { resolved_at: now, resolved_via: p.p_resolved_via, resolved_notes: p.p_resolved_notes, current_stage: 'cured',
    closure_outcome: p.p_closure_outcome, closure_reason: p.p_closure_reason, duplicate_of_violation_id: p.p_duplicate_of,
    closed_by_user_id: p.p_actor_user_id, stage_at_closure: prior });
  DB.audit_events.push({ id: 'ae-' + (++seq), community_id: v.community_id, actor_user_id: p.p_actor_user_id, actor_name: p.p_actor_name, entity_type: 'violation', entity_id: v.id, action: 'violation.closed',
    previous_value: { current_stage: prior, resolved_at: null }, new_value: { current_stage: 'cured', closure_outcome: p.p_closure_outcome, stage_at_closure: prior, evidence: p.p_evidence }, reason: p.p_closure_reason, route: p.p_route });
  if (p.p_timeline_subject) DB.interactions.push({ id: 'new-' + (++seq), violation_id: v.id, type: 'observation_note', direction: 'internal', subject: p.p_timeline_subject, content: p.p_timeline_content, sent_by_user_id: p.p_actor_user_id });
  return { data: { status: 'closed', closed_at: now, prior_stage: prior, audit_event_id: 'ae-' + seq }, error: null };
}
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('@supabase/supabase-js', { createClient: () => ({
  auth: { getUser: async (t) => (TOKENS[t] ? { data: { user: { id: TOKENS[t], email: 'x@bedrocktx.com' } }, error: null } : { data: { user: null }, error: { message: 'invalid' } }) },
  from, rpc,
  storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }), createSignedUrl: async () => ({ data: { signedUrl: 'https://signed.example/x' }, error: null }) }) },
}) });

const express = require('express');
const h360 = require('../api/homeowner_360');
const app = express(); app.use('/api/homeowner', h360.router);
const { detectRecurrence, partitionPriors } = require('../lib/enforcement/find_or_continue_violation');

(async () => {
  console.log('audit_closures:');
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api/homeowner`;
  const call = async (method, p, body, token = 'martha-token') => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    let payload; if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await quiet(() => fetch(base + p, { method, headers, body: payload }));
    const j = await r.json().catch(() => ({}));
    return { status: r.status, j };
  };
  const events = (action) => DB.audit_events.filter((e) => !action || e.action === action);

  // ── the helper ──────────────────────────────────────────────────────────
  await check('helper: a missing or blank reason is refused, and so is a missing actor or entity', async () => {
    const ok = { actor_user_id: 'u1', entity_type: 'violation', entity_id: 'v1', action: 'x', reason: 'why' };
    assert.strictEqual(buildAuditEvent(ok).reason, 'why');
    for (const [k, code] of [['reason', 'reason_required'], ['actor_user_id', 'actor_required'], ['entity_type', 'entity_type_required'], ['entity_id', 'entity_id_required'], ['action', 'action_required']]) {
      assert.throws(() => buildAuditEvent({ ...ok, [k]: '  ' }), (e) => e.code === code, k);
      assert.throws(() => buildAuditEvent({ ...ok, [k]: null }), (e) => e.code === code, k);
    }
  });
  await check('helper: recordAuditEvent THROWS when the database refuses (so callers fail closed)', async () => {
    resetDb(); FAIL.audit_events = true;
    await assert.rejects(recordAuditEvent({ from }, { actor_user_id: 'u1', entity_type: 'x', entity_id: '1', action: 'a', reason: 'r' }), (e) => e.code === 'insert_failed');
    FAIL = {};
    const row = await recordAuditEvent({ from }, { actor_user_id: 'u1', entity_type: 'x', entity_id: '1', action: 'a', reason: 'r', previous_value: { a: 1 }, new_value: { a: 2 } });
    assert.ok(row.id); assert.deepStrictEqual(DB.audit_events[0].previous_value, { a: 1 }); assert.deepStrictEqual(DB.audit_events[0].new_value, { a: 2 });
  });

  // ── outcomes ─────────────────────────────────────────────────────────────
  await check('outcomes: every closure outcome maps to an allowed resolved_via, exactly as the migration CHECK does', async () => {
    const allowedVia = ['cured', 'fine', 'withdrawn', 'voided']; // violations.resolved_via CHECK (migration 050)
    const expect = { cured_verified: 'cured', cured_reported: 'cured', voided_error: 'voided', duplicate: 'voided', administrative: 'withdrawn', expired_unverified: 'withdrawn' };
    assert.deepStrictEqual(CO.OUTCOME_KEYS.slice().sort(), Object.keys(expect).sort());
    for (const k of CO.OUTCOME_KEYS) { assert.strictEqual(CO.resolvedViaFor(k), expect[k], k); assert.ok(allowedVia.includes(CO.resolvedViaFor(k)), k); }
    const sql = read('migrations/545_audit_events_and_closure_outcomes.sql');
    const m = /violations_closure_outcome_check\s+CHECK \(closure_outcome IN \(([^)]*)\)\)/.exec(sql);
    assert.ok(m, 'outcome CHECK present');
    assert.deepStrictEqual(m[1].split(',').map((s) => s.trim().replace(/'/g, '')).sort(), CO.OUTCOME_KEYS.slice().sort(), 'code and CHECK list the same outcomes');
    assert.match(sql, /closure_outcome IN \('cured_verified', 'cured_reported'\) AND resolved_via = 'cured'/);
    assert.match(sql, /closure_outcome IN \('voided_error', 'duplicate'\) AND resolved_via = 'voided'/);
    assert.match(sql, /closure_outcome IN \('administrative', 'expired_unverified'\) AND resolved_via = 'withdrawn'/);
  });
  await check('outcomes: the closure for each outcome is recorded with its outcome, resolved_via, reason, closer and audit event', async () => {
    for (const outcome of ['cured_reported', 'voided_error', 'administrative', 'expired_unverified']) {
      resetDb();
      const { status, j } = await call('POST', '/violations/v2/resolve', { closure_outcome: outcome, reason: 'Because' });
      assert.strictEqual(status, 200, `${outcome}: ${JSON.stringify(j)}`);
      const v = DB.violations.find((x) => x.id === 'v2');
      assert.strictEqual(v.closure_outcome, outcome); assert.strictEqual(v.resolved_via, CO.resolvedViaFor(outcome));
      assert.strictEqual(v.current_stage, 'cured', 'current_stage behaviour unchanged'); assert.strictEqual(v.closed_by_user_id, 'u-martha');
      const e = events('violation.closed')[0];
      assert.ok(e, 'audit event'); assert.strictEqual(e.actor_user_id, 'u-martha'); assert.strictEqual(e.actor_name, 'Martha Bravo'); assert.strictEqual(e.reason, 'Because');
      assert.match(e.route, /POST \/api\/homeowner\/violations\/:id\/resolve/);
    }
  });
  await check('resolve: no outcome, an unknown outcome, or no reason is refused and the case stays open', async () => {
    resetDb(); RPC_CALLS.length = 0;
    for (const [body, code] of [[{ reason: 'x' }, 'outcome_required'], [{ reason: 'x', closure_outcome: 'cured' }, 'invalid_outcome'], [{ closure_outcome: 'cured_reported' }, 'reason_required'], [{ closure_outcome: 'cured_reported', reason: '   ' }, 'reason_required']]) {
      const { status, j } = await call('POST', '/violations/v1/resolve', body);
      assert.strictEqual(status, 400); assert.strictEqual(j.error, code);
    }
    assert.strictEqual(DB.violations[0].resolved_at, null); assert.strictEqual(RPC_CALLS.length, 0); assert.strictEqual(events().length, 0);
  });
  await check('duplicate: refused without a surviving case, with a case on another property, or with itself; accepted with a case on the same property', async () => {
    resetDb(); RPC_CALLS.length = 0;
    let r = await call('POST', '/violations/v2/resolve', { closure_outcome: 'duplicate', reason: 'Same issue' });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.j.error, 'survivor_required');
    r = await call('POST', '/violations/v2/resolve', { closure_outcome: 'duplicate', reason: 'Same issue', duplicate_of_violation_id: 'v3' });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.j.error, 'survivor_invalid'); assert.match(r.j.detail, /same property/);
    r = await call('POST', '/violations/v2/resolve', { closure_outcome: 'duplicate', reason: 'Same issue', duplicate_of_violation_id: 'v2' });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.j.error, 'survivor_invalid');
    r = await call('POST', '/violations/v2/resolve', { closure_outcome: 'duplicate', reason: 'Same issue', duplicate_of_violation_id: 'nope' });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.j.error, 'survivor_invalid');
    assert.strictEqual(RPC_CALLS.length, 0, 'nothing reached the database write');
    r = await call('POST', '/violations/v2/resolve', { closure_outcome: 'duplicate', reason: 'Same issue', duplicate_of_violation_id: 'v1' });
    assert.strictEqual(r.status, 200);
    const v = DB.violations.find((x) => x.id === 'v2');
    assert.strictEqual(v.duplicate_of_violation_id, 'v1'); assert.strictEqual(v.resolved_via, 'voided');
  });
  await check('cured_verified: refused without evidence, with evidence from another property, or unknown evidence; accepted with a photo or inspection on this property', async () => {
    resetDb(); RPC_CALLS.length = 0;
    let r = await call('POST', '/violations/v1/resolve', { closure_outcome: 'cured_verified', reason: 'Fixed' });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.j.error, 'evidence_required');
    r = await call('POST', '/violations/v1/resolve', { closure_outcome: 'cured_verified', reason: 'Fixed', evidence: { type: 'account_attachment', id: 'a2' } });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.j.error, 'evidence_invalid');
    r = await call('POST', '/violations/v1/resolve', { closure_outcome: 'cured_verified', reason: 'Fixed', evidence: { type: 'account_attachment', id: 'zzz' } });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.j.error, 'evidence_invalid');
    r = await call('POST', '/violations/v1/resolve', { closure_outcome: 'cured_verified', reason: 'Fixed', evidence: { type: 'selfie', id: 'a1' } });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.j.error, 'evidence_invalid');
    assert.strictEqual(RPC_CALLS.length, 0);
    r = await call('POST', '/violations/v1/resolve', { closure_outcome: 'cured_verified', reason: 'Fixed', evidence: { type: 'inspection_photo', id: 'ip1' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.j));
    assert.strictEqual(events('violation.closed')[0].new_value.evidence.id, 'ip1');
    resetDb();
    r = await call('POST', '/violations/v1/resolve', { closure_outcome: 'cured_verified', reason: 'Fixed', evidence: { type: 'account_attachment', id: 'a1' } });
    assert.strictEqual(r.status, 200);
  });
  await check('stage_at_closure: closing a Certified case keeps Certified as its stage at closure (current_stage still reads cured)', async () => {
    resetDb(); RPC_CALLS.length = 0;
    const r = await call('POST', '/violations/v1/resolve', { closure_outcome: 'cured_reported', reason: 'Owner says fixed' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.j.prior_stage, 'certified_209');
    assert.strictEqual(RPC_CALLS[0].p.p_expected_stage, 'certified_209', 'the stage is checked against what the employee saw');
    const v = DB.violations.find((x) => x.id === 'v1');
    assert.strictEqual(v.stage_at_closure, 'certified_209'); assert.strictEqual(v.current_stage, 'cured');
    assert.strictEqual(events('violation.closed')[0].previous_value.current_stage, 'certified_209');
    const note = DB.interactions.find((i) => i.violation_id === 'v1');
    assert.match(note.content, /Outcome: Cured, reported by owner/); assert.match(note.content, /Stage before closing: Certified 209 \(certified_209\)/);
  });
  await check('resolve: if the one-transaction close fails, nothing changes and the employee is told', async () => {
    resetDb(); FAIL.rpc = true;
    const r = await call('POST', '/violations/v1/resolve', { closure_outcome: 'cured_reported', reason: 'x' });
    assert.strictEqual(r.status, 500); assert.strictEqual(r.j.error, 'audit_failed');
    assert.strictEqual(DB.violations[0].resolved_at, null); assert.strictEqual(events().length, 0);
  });

  // ── audited edits: before/after + actor + reason; fail closed ────────────
  await check('certified #: first number needs no typed reason; the event has before/after, actor and reason', async () => {
    resetDb();
    const r = await call('POST', '/interactions/L2/certified-number', { certified_tracking_number: '9589 0710 5270 2222 2222 22' });
    assert.strictEqual(r.status, 200);
    const e = events('letter.certified_number_recorded')[0];
    assert.ok(e); assert.strictEqual(e.actor_user_id, 'u-martha'); assert.strictEqual(e.reason, 'Certified number recorded');
    assert.deepStrictEqual(e.previous_value, { certified_tracking_number: null, delivery_method: null });
    assert.strictEqual(e.new_value.certified_tracking_number, '9589071052702222222222'); assert.strictEqual(e.field, 'certified_tracking_number');
  });
  await check('certified #: changing or clearing a number on file needs a reason; with one, the event keeps the old and new number', async () => {
    resetDb();
    let r = await call('POST', '/interactions/L1/certified-number', { certified_tracking_number: '9589071052703333333333' });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.j.error, 'reason_required');
    r = await call('POST', '/interactions/L1/certified-number', { certified_tracking_number: '' });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.j.error, 'reason_required');
    assert.strictEqual(DB.interactions.find((i) => i.id === 'L1').certified_tracking_number, '9589071052701111111111');
    r = await call('POST', '/interactions/L1/certified-number', { certified_tracking_number: '9589071052703333333333', reason: 'Typed the wrong label' });
    assert.strictEqual(r.status, 200);
    const e = events('letter.certified_number_changed')[0];
    assert.strictEqual(e.previous_value.certified_tracking_number, '9589071052701111111111');
    assert.strictEqual(e.new_value.certified_tracking_number, '9589071052703333333333'); assert.strictEqual(e.reason, 'Typed the wrong label');
  });
  await check('certified #: if the audit event cannot be saved the number is put back', async () => {
    resetDb(); FAIL.audit_events = true;
    const r = await call('POST', '/interactions/L1/certified-number', { certified_tracking_number: '9589071052703333333333', reason: 'x' });
    assert.strictEqual(r.status, 500); assert.strictEqual(r.j.error, 'audit_failed');
    const L1 = DB.interactions.find((i) => i.id === 'L1');
    assert.strictEqual(L1.certified_tracking_number, '9589071052701111111111'); assert.strictEqual(L1.notes, null);
  });
  await check('note edit: needs a reason; the event keeps the old and new text; a failed event undoes the edit', async () => {
    resetDb();
    let r = await call('PATCH', '/note/n1', { content: 'new words' });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.j.error, 'reason_required');
    r = await call('PATCH', '/note/n1', { content: 'new words', reason: 'Corrected the wording' });
    assert.strictEqual(r.status, 200);
    const e = events('note.edited')[0];
    assert.deepStrictEqual(e.previous_value, { content: 'old note' }); assert.deepStrictEqual(e.new_value, { content: 'new words' });
    assert.strictEqual(e.actor_user_id, 'u-martha'); assert.strictEqual(e.reason, 'Corrected the wording');
    resetDb(); FAIL.audit_events = true;
    r = await call('PATCH', '/note/n1', { content: 'new words', reason: 'x' });
    assert.strictEqual(r.status, 500); assert.strictEqual(DB.interactions.find((i) => i.id === 'n1').content, 'old note');
  });
  await check('note delete: needs a reason; the event keeps the full note; if the event cannot be saved nothing is deleted', async () => {
    resetDb();
    let r = await call('DELETE', '/note/n2', null);
    assert.strictEqual(r.status, 400); assert.strictEqual(r.j.error, 'reason_required');
    FAIL.audit_events = true;
    r = await call('DELETE', '/note/n2', { reason: 'Wrong account' });
    assert.strictEqual(r.status, 500); assert.ok(DB.interactions.some((i) => i.id === 'n2'), 'still there');
    FAIL = {};
    r = await call('DELETE', '/note/n2', { reason: 'Wrong account' });
    assert.strictEqual(r.status, 200); assert.ok(!DB.interactions.some((i) => i.id === 'n2'));
    const e = events('note.deleted')[0];
    assert.strictEqual(e.previous_value.content, 'to delete'); assert.strictEqual(e.new_value, null); assert.strictEqual(e.reason, 'Wrong account');
  });
  await check('file delete: needs a reason; the event keeps a snapshot; if the event cannot be saved nothing is removed', async () => {
    resetDb();
    let r = await call('DELETE', '/attachment/a1', null);
    assert.strictEqual(r.status, 400); assert.strictEqual(r.j.error, 'reason_required');
    FAIL.audit_events = true;
    r = await call('DELETE', '/attachment/a1', { reason: 'Wrong account' });
    assert.strictEqual(r.status, 500); assert.ok(DB.account_attachments.some((a) => a.id === 'a1'));
    FAIL = {};
    r = await call('DELETE', '/attachment/a1', { reason: 'Wrong account' });
    assert.strictEqual(r.status, 200);
    const e = events('attachment.deleted')[0];
    assert.strictEqual(e.previous_value.file_path, 'account-attachments/cm1/p1/x.jpg'); assert.strictEqual(e.community_id, 'cm1');
  });
  await check('a failed delete after its event is recorded as delete_failed (the trail is append-only, never rewritten)', async () => {
    resetDb(); FAIL['delete:interactions'] = true;
    const r = await call('DELETE', '/note/n2', { reason: 'Wrong account' });
    assert.strictEqual(r.status, 500);
    assert.deepStrictEqual(events().map((e) => e.action), ['note.deleted', 'note.delete_failed']);
  });

  // ── repeat-offense safety ───────────────────────────────────────────────
  const NOW = Date.parse('2026-10-24T12:00:00Z');
  const ago = (d) => new Date(NOW - d * 864e5).toISOString();
  const rdb = (priors, pieces = []) => ({ from(table) {
    const q = { _in: null, select() { return q; }, eq() { return q; }, not() { return q; }, gte() { return q; }, order() { return q; }, limit() { return q; },
      in(col, vals) { if (col === 'violation_id') q._in = vals; return q; },
      then(res, rej) {
        let out = { data: [], error: null };
        if (table === 'enforcement_categories') out = { data: [{ recurrence_escalates: true }], error: null };
        else if (table === 'violations') out = { data: priors, error: null };
        else if (table === 'letter_mail_pieces') out = { data: pieces.filter((p) => !q._in || q._in.includes(p.violation_id)), error: null };
        return Promise.resolve(out).then(res, rej);
      } };
    return q;
  } });
  await check('recurrence: voided_error, duplicate, administrative and expired_unverified priors never count', async () => {
    for (const o of ['voided_error', 'duplicate', 'administrative', 'expired_unverified']) {
      const r = await detectRecurrence({ propertyId: 'p', categoryId: 'c' }, { db: rdb([{ id: 'x', current_stage: 'cured', resolved_at: ago(20), closure_outcome: o }]), nowMs: NOW });
      assert.strictEqual(r, null, `${o} counted`);
    }
  });
  await check('recurrence: a legacy (NULL outcome) prior is never a repeat; it returns "needs verification" instead', async () => {
    const r = await detectRecurrence({ propertyId: 'p', categoryId: 'c' }, { db: rdb([{ id: 'old', current_stage: 'cured', resolved_at: ago(30), closure_outcome: null }]), nowMs: NOW });
    assert.ok(r); assert.strictEqual(r.is_repeat, false); assert.strictEqual(r.escalates, false);
    assert.strictEqual(r.needs_verification, true); assert.deepStrictEqual(r.legacy_prior_violation_ids, ['old']); assert.strictEqual(r.prior_violation_id, null);
  });
  await check('recurrence: a cured prior still counts (flagged, never escalated); legacy + voided priors alongside it are listed, not counted', async () => {
    const r = await detectRecurrence({ propertyId: 'p', categoryId: 'c' }, { db: rdb([
      { id: 'cur', current_stage: 'cured', resolved_at: ago(10), closure_outcome: 'cured_reported' },
      { id: 'void', current_stage: 'cured', resolved_at: ago(15), closure_outcome: 'voided_error' },
      { id: 'leg', current_stage: 'cured', resolved_at: ago(40), closure_outcome: null },
    ]), nowMs: NOW });
    assert.strictEqual(r.is_repeat, true); assert.strictEqual(r.escalates, false); assert.strictEqual(r.prior_violation_id, 'cur');
    assert.strictEqual(r.needs_verification, true); assert.deepStrictEqual(r.legacy_prior_violation_ids, ['leg']); assert.deepStrictEqual(r.excluded_prior_violation_ids, ['void']);
  });
  await check('recurrence: before migration 545 is applied (no closure_outcome column) every prior is treated as legacy', async () => {
    let calls = 0;
    const db = { from(table) {
      const q = { cols: '', select(c) { q.cols = c; return q; }, eq() { return q; }, not() { return q; }, gte() { return q; }, order() { return q; }, limit() { return q; }, in() { return q; },
        then(res, rej) {
          let out = { data: [], error: null };
          if (table === 'enforcement_categories') out = { data: [{ recurrence_escalates: true }], error: null };
          else if (table === 'violations') { calls++; out = /closure_outcome/.test(q.cols) ? { data: null, error: { message: 'column violations.closure_outcome does not exist' } } : { data: [{ id: 'old', current_stage: 'cured', resolved_at: ago(30) }], error: null }; }
          return Promise.resolve(out).then(res, rej);
        } };
      return q;
    } };
    const r = await detectRecurrence({ propertyId: 'p', categoryId: 'c' }, { db, nowMs: NOW });
    assert.strictEqual(calls, 2); assert.strictEqual(r.is_repeat, false); assert.strictEqual(r.needs_verification, true);
  });
  await check('recurrence: partitionPriors sorts each prior into counted / legacy / excluded', async () => {
    const p = partitionPriors([{ closure_outcome: 'cured_verified' }, { closure_outcome: null }, {}, { closure_outcome: 'duplicate' }, { closure_outcome: 'something_new' }]);
    assert.strictEqual(p.counted.length, 1); assert.strictEqual(p.legacy.length, 2); assert.strictEqual(p.excluded.length, 2);
  });
  await check('STATIC: the inspection confirm path surfaces "Prior history needs verification" on the new case (and still never escalates a repeat)', async () => {
    const ins = read('api/inspections.js');
    assert.match(ins, /if \(recurrenceSignal && recurrenceSignal\.needs_verification\) \{[\s\S]{0,400}Prior history needs verification/);
    assert.match(ins, /const openStage = decision\.stage;/);
  });

  // ── the migration: database-level guarantees ────────────────────────────
  const sql = read('migrations/545_audit_events_and_closure_outcomes.sql');
  const code = sql.replace(/--[^\n]*/g, '');
  await check('STATIC migration: audit_events is append-only at the database (trigger raises on UPDATE/DELETE/TRUNCATE; insert-only grants)', async () => {
    assert.match(code, /CREATE TRIGGER trg_audit_events_append_only\s+BEFORE UPDATE OR DELETE ON audit_events\s+FOR EACH ROW EXECUTE FUNCTION audit_events_append_only\(\)/);
    assert.match(code, /CREATE TRIGGER trg_audit_events_no_truncate\s+BEFORE TRUNCATE ON audit_events/);
    assert.match(code, /FUNCTION audit_events_append_only\(\)[\s\S]*?RAISE EXCEPTION 'audit_events is append-only/);
    assert.match(code, /GRANT SELECT, INSERT ON audit_events TO service_role;/);
    assert.match(code, /REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM service_role;/);
    assert.match(code, /REVOKE ALL ON audit_events FROM anon, authenticated;/);
    assert.ok(!/GRANT[^;]*\b(UPDATE|DELETE|ALL)\b[^;]*ON audit_events/i.test(code), 'no grant of UPDATE/DELETE/ALL on audit_events');
    assert.match(code, /actor_user_id\s+uuid\s+NOT NULL/); assert.match(code, /reason\s+text\s+NOT NULL/);
    assert.match(code, /audit_events_reason_not_blank CHECK \(length\(btrim\(reason\)\) > 0\)/);
    assert.match(code, /REFERENCES user_profiles\(id\) ON DELETE RESTRICT/);
  });
  await check('STATIC migration: no backfill, no change to any existing row (only additive DDL; the only DML lives inside the close function)', async () => {
    const noFns = code.replace(/\$fn\$[\s\S]*?\$fn\$/g, '').replace(/\$do\$[\s\S]*?\$do\$/g, '');
    assert.ok(!/\bUPDATE\s+\w+\s+SET\b/i.test(noFns), 'top-level UPDATE');
    assert.ok(!/\bINSERT\s+INTO\b/i.test(noFns), 'top-level INSERT');
    assert.ok(!/\bDELETE\s+FROM\b/i.test(noFns), 'top-level DELETE');
    for (const c of ['closure_outcome', 'closure_reason', 'duplicate_of_violation_id', 'closed_by_user_id', 'stage_at_closure']) {
      assert.match(code, new RegExp(`ADD COLUMN IF NOT EXISTS ${c} (text|uuid);`), `${c} nullable, no default`);
    }
    assert.match(code, /^BEGIN;/m); assert.match(code, /^COMMIT;\s*$/m);
    const checks = JSON.parse(read('migrations/checks/545_audit_events_and_closure_outcomes.json'));
    assert.strictEqual(checks.row_changes.violations, 0); assert.ok(checks.protected.some((p) => p.table === 'violations'));
    assert.ok(checks.verify.some((v) => /no historical violation was classified/.test(v.name) && v.expect === 0));
  });
  await check('STATIC migration: stage_at_closure is protected (cannot change once set, except an audited reopen) and the close function sets it from the locked row', async () => {
    assert.match(code, /CREATE TRIGGER trg_violations_stage_at_closure_guard\s+BEFORE UPDATE ON violations/);
    assert.match(code, /OLD\.stage_at_closure IS NOT NULL AND NEW\.stage_at_closure IS DISTINCT FROM OLD\.stage_at_closure/);
    assert.match(code, /ae\.action = 'violation\.reopened'/);
    assert.match(code, /RAISE EXCEPTION 'violations\.stage_at_closure cannot change once set/);
    assert.match(code, /SELECT \* INTO v FROM violations WHERE id = p_violation_id FOR UPDATE;/);
    assert.match(code, /stage_at_closure\s+= v\.current_stage/);
    assert.match(code, /INSERT INTO audit_events[\s\S]*?'violation\.closed'/);
    assert.match(code, /REVOKE ALL ON FUNCTION close_violation_with_audit\([^)]*\) FROM anon, authenticated;/);
    assert.match(code, /GRANT EXECUTE ON FUNCTION close_violation_with_audit\([^)]*\) TO service_role;/);
  });
  await check('STATIC: enforcement Advance and Reduce write the canonical audit event and undo the change if it fails', async () => {
    const enf = read('api/enforcement.js');
    const adv = enf.slice(enf.indexOf("router.post('/violations/:violationId/advance-stage'"), enf.indexOf("router.post('/violations/:violationId/prepare-stage-letter'"));
    assert.match(adv, /action: 'violation\.stage_advanced'/);
    assert.match(adv, /auditHook/);
    const red = enf.slice(enf.indexOf("router.post('/violations/:violationId/reduce-stage'"), enf.indexOf('// Hold the stale letters'));
    assert.match(red, /await recordAuditEvent\(supabase, \{[\s\S]*?violation\.stage_reduced[\s\S]*?\} catch \(auditErr\) \{[\s\S]*?update\(undo\)[\s\S]*?audit_failed/);
  });

  srv.close();

  // ── the shared advance workflow: a failed audit hook undoes the advance ──
  await check('advance workflow: if the audit hook throws, the stage goes back and the prepared letter is withdrawn', async () => {
    try { require('dotenv').config(); } catch (_) {}
    const { _advanceWithStageLetter } = require('../api/enforcement');
    const T = {
      violations: [{ id: 'v1', property_id: 'p1', community_id: 'c1', primary_category_id: 'k1', current_stage: 'courtesy_1', current_stage_started_at: '2026-09-22T12:00:00Z', opened_at: '2026-09-22T12:00:00Z', resolved_at: null, quality_status: 'verified', source: 'trustEd_native' }],
      interactions: [{ id: 'L1', violation_id: 'v1', type: 'letter_courtesy_1', subject: 'Violation letter (courtesy_1)', status: 'sent', mailed_at: '2026-09-22T18:00:00Z', postmark_date: '2026-09-22', created_at: '2026-09-22T12:00:00Z' }],
    };
    let n = 0;
    const fdb = { from(table) {
      const st = { filters: [], op: 'select', patch: null, rows: null };
      const m = (r) => st.filters.every(([k, op, v]) => (op === 'eq' ? r[k] === v : op === 'like' ? String(r[k] || '').startsWith(String(v).replace(/%$/, '')) : true));
      const run = () => {
        if (st.op === 'insert') { const rows = st.rows.map((r) => ({ id: 'i' + (++n), ...r })); T[table].push(...rows); return { data: rows, error: null }; }
        if (st.op === 'update') { const hit = T[table].filter(m); hit.forEach((r) => Object.assign(r, st.patch)); return { data: hit.map((r) => ({ id: r.id })), error: null }; }
        return { data: T[table].filter(m).map((r) => ({ ...r })), error: null };
      };
      const api = { select() { return api; }, eq(k, v) { st.filters.push([k, 'eq', v]); return api; }, like(k, v) { st.filters.push([k, 'like', v]); return api; },
        insert(r) { st.op = 'insert'; st.rows = Array.isArray(r) ? r : [r]; return api; }, update(p) { st.op = 'update'; st.patch = p; return api; },
        maybeSingle() { const r = run(); return Promise.resolve({ data: (r.data || [])[0] || null, error: r.error }); },
        single() { const r = run(); return Promise.resolve({ data: (r.data || [])[0] || null, error: r.error }); },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); } };
      return api;
    } };
    const draft = async (v, decision) => { T.interactions.push({ id: 'D1', violation_id: v.id, type: 'letter_courtesy_2', subject: 'Violation letter (courtesy_2)', status: 'draft', created_at: new Date().toISOString() }); return { interaction_id: 'D1' }; };
    const r = await quiet(() => _advanceWithStageLetter({ violationId: 'v1', toStage: 'courtesy_2', actor: { id: 'u-martha', full_name: 'Martha Bravo' }, source: 'manual_advance', reason: 'Still out',
      auditHook: async () => { throw new Error('audit_events insert refused'); } }, { db: fdb, draft }));
    assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'audit_failed');
    assert.strictEqual(T.violations[0].current_stage, 'courtesy_1', 'stage put back');
    assert.strictEqual(T.interactions.find((i) => i.id === 'D1').status, 'rejected', 'the new letter was withdrawn');
    assert.ok(!T.interactions.some((i) => /^Stage advanced/.test(i.subject || '')), 'no timeline note claims the advance');
  });

  console.log(`\naudit_closures: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch((e) => { console.error('  ✗', e.stack || e.message); process.exit(1); });
