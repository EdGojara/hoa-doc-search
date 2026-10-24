#!/usr/bin/env node
// ============================================================================
// tests/test_inspection_closeout.js  (Ed 2026-10-24, migration 546)
// ----------------------------------------------------------------------------
// Locks lib/inspections/closeout.js, offline, against an in-memory database:
//   - completing records the employee from the LOGIN, the time and the counts;
//   - completing changes no violation, letter or observation (and no other
//     inspection column than the stage fields);
//   - review-complete is refused while any observation is pending or deferred,
//     and records who/when once every observation has a decision;
//   - the 5 PM reminder fires once per drive per day, only for incomplete
//     tracked drives, only to staff mailboxes;
//   - Amanda's flag fires only the next morning (never for a drive started
//     today), once per day, and completing the drive closes the flag;
//   - the actor is never taken from the request body (API route source check);
//   - the ops overview counts incomplete drives and pending reviews.
// ============================================================================
// Offline: some required modules build a Supabase client at load time. This
// test never talks to it (every read and write goes to the in-memory db below).
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'offline-test-key';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../lib/inspections/closeout');

let pass = 0; let fail = 0;
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ok  ', name); } catch (e) { fail += 1; console.error('  FAIL', name, '\n       ', e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n        ') : e); }
}

// ---------------------------------------------------------------- fake db
function makeDb(seed) {
  const tables = JSON.parse(JSON.stringify(seed));
  const uniques = { inspection_closeout_notices: [['inspection_id', 'kind', 'notice_date']] };
  let seq = 0;
  const writes = [];
  function from(name) {
    if (!tables[name]) tables[name] = [];
    const st = { name, filters: [], op: 'select', payload: null, single: null, order: null, range: null, limit: null, returning: false };
    const rows = () => tables[name];
    const match = (r) => st.filters.every((f) => f(r));
    const api = {
      select() { st.returning = true; return api; },
      eq(c, v) { st.filters.push((r) => r[c] === v); return api; },
      neq(c, v) { st.filters.push((r) => r[c] !== v); return api; },
      is(c, v) { st.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return api; },
      in(c, vs) { st.filters.push((r) => vs.includes(r[c])); return api; },
      not(c, op, v) {
        if (op === 'in') { const vs = String(v).replace(/[()]/g, '').split(','); st.filters.push((r) => !vs.includes(r[c])); }
        else if (op === 'is') st.filters.push((r) => r[c] != null);
        return api;
      },
      gte(c, v) { st.filters.push((r) => r[c] >= v); return api; },
      order(c) { st.order = c; return api; },
      range(a, b) { st.range = [a, b]; return api; },
      limit(n) { st.limit = n; return api; },
      maybeSingle() { st.single = 'maybe'; return api; },
      single() { st.single = 'one'; return api; },
      insert(p) { st.op = 'insert'; st.payload = p; return api; },
      update(p) { st.op = 'update'; st.payload = p; return api; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
    };
    function out(list) {
      if (st.single === 'maybe') return { data: list[0] || null, error: null };
      if (st.single === 'one') return list.length === 1 ? { data: list[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'not one row' } };
      return { data: list, error: null };
    }
    function run() {
      if (st.op === 'insert') {
        const list = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((p) => ({ id: p.id || `${name}-${++seq}`, ...p }));
        for (const r of list) {
          for (const cols of uniques[name] || []) {
            if (rows().some((x) => cols.every((c) => x[c] === r[c]))) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          }
        }
        rows().push(...list); writes.push({ table: name, op: 'insert', rows: list });
        return out(list);
      }
      if (st.op === 'update') {
        const hit = rows().filter(match);
        hit.forEach((r) => Object.assign(r, st.payload));
        writes.push({ table: name, op: 'update', ids: hit.map((r) => r.id), payload: st.payload });
        return out(hit);
      }
      let list = rows().filter(match);
      if (st.order) list = list.slice().sort((a, b) => String(a[st.order]).localeCompare(String(b[st.order])));
      if (st.range) list = list.slice(st.range[0], st.range[1] + 1);
      if (st.limit) list = list.slice(0, st.limit);
      return out(list.map((r) => ({ ...r })));
    }
    return api;
  }
  return { from, tables, writes };
}

const NOW = new Date('2026-10-24T22:30:00Z'); // Sat 5:30 PM Central (CDT)
const ACTOR = { user: { id: '11111111-1111-1111-1111-111111111111' }, full_name: 'Pat Inspector', email: 'pat@bedrocktx.com', role: 'staff' };
function seedData() {
  return {
    communities: [{ id: 'c1', name: 'Waterview' }],
    properties: [
      { id: 'p1', community_id: 'c1', street_address: '100 Oak St', latitude: 29.70000, longitude: -95.50000 },
      { id: 'p2', community_id: 'c1', street_address: '102 Oak St', latitude: 29.70010, longitude: -95.50000 },
      { id: 'p3', community_id: 'c1', street_address: '900 Far Rd', latitude: 29.80000, longitude: -95.60000 },
      { id: 'p4', community_id: 'c1', street_address: '904 Far Rd', latitude: 29.80010, longitude: -95.60000 },
      { id: 'p5', community_id: 'c1', street_address: '1 No Map Ln', latitude: null, longitude: null },
    ],
    inspections: [
      { id: 'i1', community_id: 'c1', status: 'in_progress', closeout_tracked: true, started_by_user_id: ACTOR.user.id, operator_id: null, device_label: 'Pat', started_at: '2026-10-24T14:00:00Z', ended_at: null, completed_at: null, completed_by_user_id: null, review_completed_at: null, notes: 'keep me' },
    ],
    inspection_photos: [
      { id: 'ph1', inspection_id: 'i1', polygon_match_property_id: 'p1', reviewer_confirmed_property_id: null },
      { id: 'ph2', inspection_id: 'i1', polygon_match_property_id: null, reviewer_confirmed_property_id: 'p5' },
    ],
    inspection_route_traces: [
      { id: 'r1', inspection_id: 'i1', latitude: 29.70011, longitude: -95.50002 }, // passes p2 (and p1)
    ],
    property_observations: [
      { id: 'o1', inspection_id: 'i1', property_id: 'p1', severity: 'moderate', reviewer_status: 'pending' },
      { id: 'o2', inspection_id: 'i1', property_id: 'p5', severity: 'minor', reviewer_status: 'confirmed' },
      { id: 'o3', inspection_id: 'i1', property_id: 'p1', severity: 'clean', reviewer_status: 'pending' },
    ],
    violations: [{ id: 'v1', property_id: 'p5', current_stage: 'courtesy_1', opened_from_observation_id: 'o2' }],
    interactions: [{ id: 'l1', violation_id: 'v1', type: 'letter_courtesy_1', status: 'draft', printed_at: null }],
    user_profiles: [
      { id: ACTOR.user.id, email: 'pat@bedrocktx.com', full_name: 'Pat Inspector', is_active: true },
      { id: '22222222-2222-2222-2222-222222222222', email: 'someone@gmail.com', full_name: 'Outside', is_active: true },
    ],
    inspection_closeout_notices: [],
    work_items: [],
    work_item_events: [],
  };
}
const seed = () => makeDb(seedData());
const snap = (db, t) => JSON.stringify(db.tables[t]);

(async () => {
  console.log('test_inspection_closeout');

  await t('stage mapping onto existing statuses', () => {
    assert.strictEqual(C.deriveStage({ status: 'in_progress', closeout_tracked: true }), 'in_progress');
    assert.strictEqual(C.deriveStage({ status: 'captured', closeout_tracked: true }), 'in_progress'); // auto-ended, not completed
    assert.strictEqual(C.deriveStage({ status: 'captured', closeout_tracked: true, completed_at: 'x' }), 'inspection_completed');
    assert.strictEqual(C.deriveStage({ status: 'ai_analyzed', closeout_tracked: true, completed_at: 'x' }), 'inspection_completed');
    assert.strictEqual(C.deriveStage({ status: 'closed', closeout_tracked: true, completed_at: 'x', review_completed_at: 'y' }), 'review_completed');
    assert.strictEqual(C.deriveStage({ status: 'closed', closeout_tracked: false }), 'review_completed'); // legacy
    assert.strictEqual(C.deriveStage({ status: 'voided' }), 'voided');
  });

  await t('counts: photos + GPS trail inspected, explicit skip + not visited skipped, clean not a violation', () => {
    const db = seedData();
    const c = C.computeCloseout({ properties: db.properties, photos: db.inspection_photos, observations: db.property_observations, pings: db.inspection_route_traces, skipReasons: { p3: 'gate locked' }, generalReason: 'ran out of daylight' });
    assert.strictEqual(c.inspected_property_count, 3); // p1 (photo + trail), p2 (trail), p5 (photo)
    assert.strictEqual(c.violations_identified, 2);    // o1, o2; o3 is clean
    assert.strictEqual(c.skipped_property_count, 2);
    const p3 = c.skipped_properties.find((s) => s.property_id === 'p3');
    const p4 = c.skipped_properties.find((s) => s.property_id === 'p4');
    assert.deepStrictEqual([p3.source, p3.reason], ['inspector', 'gate locked']);
    assert.deepStrictEqual([p4.source, p4.reason], ['not_visited', 'ran out of daylight']);
    assert.strictEqual(c.summary.coverage_basis, 'photos_and_gps_trail');
    assert.strictEqual(c.summary.observations_pending_review, 2);
  });

  await t('skip reasons for another community\'s property are ignored', () => {
    const db = seedData();
    const c = C.computeCloseout({ properties: db.properties, photos: [], observations: [], pings: [], skipReasons: { 'not-ours': 'x' } });
    assert.ok(!c.skipped_properties.some((s) => s.property_id === 'not-ours'));
    assert.strictEqual(c.skipped_property_count, 5);
  });

  await t('completing records the logged-in actor, time and counts', async () => {
    const db = seed();
    const r = await C.completeInspection({ supabase: db, inspectionId: 'i1', actor: ACTOR, skipReasons: { p3: 'gate locked' }, now: NOW });
    const row = db.tables.inspections[0];
    assert.strictEqual(row.completed_by_user_id, ACTOR.user.id);
    assert.strictEqual(row.completed_by_name, 'Pat Inspector');
    assert.strictEqual(row.completed_at, NOW.toISOString());
    assert.strictEqual(row.inspected_property_count, 3);
    assert.strictEqual(row.violations_identified, 2);
    assert.strictEqual(row.skipped_property_count, 2);
    assert.strictEqual(row.status, 'captured');
    assert.strictEqual(row.ended_at, NOW.toISOString());
    assert.strictEqual(row.notes, 'keep me');
    assert.strictEqual(r.stage.stage, 'inspection_completed');
  });

  await t('completing changes no violation, letter or observation', async () => {
    const db = seed();
    const before = ['violations', 'interactions', 'property_observations', 'inspection_photos'].map((x) => snap(db, x));
    await C.completeInspection({ supabase: db, inspectionId: 'i1', actor: ACTOR, now: NOW });
    const after = ['violations', 'interactions', 'property_observations', 'inspection_photos'].map((x) => snap(db, x));
    assert.deepStrictEqual(after, before);
    const touched = [...new Set(db.writes.map((w) => w.table))];
    assert.deepStrictEqual(touched, ['inspections']); // no open flag to close here
  });

  await t('completing twice is refused; no actor = refused', async () => {
    const db = seed();
    await C.completeInspection({ supabase: db, inspectionId: 'i1', actor: ACTOR, now: NOW });
    await assert.rejects(() => C.completeInspection({ supabase: db, inspectionId: 'i1', actor: ACTOR, now: NOW }), (e) => e.code === 'already_completed' && e.status === 409);
    const db2 = seed();
    await assert.rejects(() => C.completeInspection({ supabase: db2, inspectionId: 'i1', actor: null, now: NOW }), (e) => e.code === 'sign_in_required' && e.status === 403);
    assert.strictEqual(db2.tables.inspections[0].completed_at, null);
  });

  await t('review-complete refused while observations are pending (and before the inspector completes)', async () => {
    const db = seed();
    await assert.rejects(() => C.completeReview({ supabase: db, inspectionId: 'i1', actor: ACTOR, now: NOW }), (e) => e.code === 'inspection_not_completed');
    await C.completeInspection({ supabase: db, inspectionId: 'i1', actor: ACTOR, now: NOW });
    await assert.rejects(() => C.completeReview({ supabase: db, inspectionId: 'i1', actor: ACTOR, now: NOW }), (e) => e.code === 'observations_pending' && e.extra.pending === 2 && /2 observations are still waiting/.test(e.message));
    db.tables.property_observations.forEach((o) => { o.reviewer_status = 'deferred'; });
    await assert.rejects(() => C.completeReview({ supabase: db, inspectionId: 'i1', actor: ACTOR, now: NOW }), (e) => e.code === 'observations_pending' && e.extra.deferred === 3);
    assert.strictEqual(db.tables.inspections[0].review_completed_at == null, true);
    assert.notStrictEqual(db.tables.inspections[0].status, 'closed');
  });

  await t('review-complete records who/when once all decided, and touches only the inspection', async () => {
    const db = seed();
    await C.completeInspection({ supabase: db, inspectionId: 'i1', actor: ACTOR, now: NOW });
    db.tables.property_observations.forEach((o) => { o.reviewer_status = o.id === 'o3' ? 'rejected' : 'confirmed'; });
    const before = ['violations', 'interactions', 'property_observations'].map((x) => snap(db, x));
    const reviewer = { user: { id: '33333333-3333-3333-3333-333333333333' }, full_name: 'Office Reviewer' };
    const r = await C.completeReview({ supabase: db, inspectionId: 'i1', actor: reviewer, now: new Date('2026-10-25T15:00:00Z') });
    const row = db.tables.inspections[0];
    assert.strictEqual(row.status, 'closed');
    assert.strictEqual(row.review_completed_by_user_id, reviewer.user.id);
    assert.strictEqual(row.review_completed_by_name, 'Office Reviewer');
    assert.strictEqual(row.completed_by_user_id, ACTOR.user.id); // inspector record untouched
    assert.strictEqual(r.stage.stage, 'review_completed');
    assert.deepStrictEqual(['violations', 'interactions', 'property_observations'].map((x) => snap(db, x)), before);
  });

  await t('5 PM reminder: once per drive per day, only incomplete tracked drives', async () => {
    const db = seed();
    db.tables.inspections.push(
      { id: 'i2', community_id: 'c1', status: 'captured', closeout_tracked: true, started_by_user_id: ACTOR.user.id, started_at: '2026-10-24T13:00:00Z', completed_at: '2026-10-24T20:00:00Z', completed_by_user_id: ACTOR.user.id },
      { id: 'i3', community_id: 'c1', status: 'captured', closeout_tracked: false, started_by_user_id: ACTOR.user.id, started_at: '2026-10-01T13:00:00Z', completed_at: null },
      { id: 'i4', community_id: 'c1', status: 'voided', closeout_tracked: true, started_by_user_id: ACTOR.user.id, started_at: '2026-10-24T13:00:00Z', completed_at: null },
      { id: 'i5', community_id: 'c1', status: 'captured', closeout_tracked: true, started_by_user_id: ACTOR.user.id, started_at: '2026-10-24T12:00:00Z', completed_at: null }, // auto-ended, still incomplete
    );
    const sent = [];
    const send = async (m) => { sent.push(m); return { ok: true, vendor_message_id: 'm' + sent.length }; };
    const r1 = await C.runInspectorReminders({ supabase: db, now: NOW, send, logger: { warn() {} } });
    assert.strictEqual(r1.sent, 2);
    assert.deepStrictEqual(sent.map((m) => m.to), ['pat@bedrocktx.com', 'pat@bedrocktx.com']);
    assert.ok(sent.every((m) => !/—/.test(m.text)), 'no em-dashes in staff copy');
    const r2 = await C.runInspectorReminders({ supabase: db, now: new Date(NOW.getTime() + 3600000), send, logger: { warn() {} } });
    assert.strictEqual(r2.sent, 0); assert.strictEqual(r2.already_today, 2);
    assert.strictEqual(sent.length, 2);
    const ids = db.tables.inspection_closeout_notices.map((n) => n.inspection_id).sort();
    assert.deepStrictEqual(ids, ['i1', 'i5']);
    assert.ok(db.tables.inspection_closeout_notices.every((n) => n.outcome === 'sent' && n.kind === 'inspector_reminder' && n.notice_date === '2026-10-24'));
    // next day: a new reminder for the still-incomplete drives
    const r3 = await C.runInspectorReminders({ supabase: db, now: new Date('2026-10-25T22:30:00Z'), send, logger: { warn() {} } });
    assert.strictEqual(r3.sent, 2);
  });

  await t('reminders never go to a non-staff mailbox', async () => {
    const db = seed();
    db.tables.inspections[0].started_by_user_id = '22222222-2222-2222-2222-222222222222';
    const sent = [];
    const r = await C.runInspectorReminders({ supabase: db, now: NOW, send: async (m) => { sent.push(m); return { ok: true }; }, logger: { warn() {} } });
    assert.strictEqual(sent.length, 0); assert.strictEqual(r.skipped, 1);
    assert.strictEqual(db.tables.inspection_closeout_notices[0].outcome, 'skipped');
  });

  await t('Amanda flag: only the next morning, once per day, closed when the drive completes', async () => {
    const db = seed();
    // Same day (drive started this morning, now 5:30 PM): no flag.
    const same = await C.runManagementFlags({ supabase: db, now: NOW, logger: { warn() {} } });
    assert.strictEqual(same.flagged, 0);
    assert.strictEqual(db.tables.work_items.length, 0);
    // Next morning 8:05 AM Central.
    const morning = new Date('2026-10-25T13:05:00Z');
    const r1 = await C.runManagementFlags({ supabase: db, now: morning, logger: { warn() {} } });
    assert.strictEqual(r1.flagged, 1);
    const wi = db.tables.work_items[0];
    assert.strictEqual(wi.source_type, 'agent'); assert.strictEqual(wi.assigned_to, C.MANAGEMENT_ASSIGNEE);
    assert.strictEqual(wi.source_ref, 'inspection-closeout:i1'); assert.strictEqual(wi.created_by, C.AMANDA_ACTOR);
    assert.ok(!/—/.test(wi.title + wi.summary + wi.next_step));
    const r2 = await C.runManagementFlags({ supabase: db, now: new Date(morning.getTime() + 3600000), logger: { warn() {} } });
    assert.strictEqual(r2.flagged, 0); assert.strictEqual(r2.already_today, 1);
    assert.strictEqual(db.tables.work_items.length, 1);
    // Day after: same work item touched, not duplicated.
    const r3 = await C.runManagementFlags({ supabase: db, now: new Date('2026-10-26T13:05:00Z'), logger: { warn() {} } });
    assert.strictEqual(r3.flagged, 1); assert.strictEqual(db.tables.work_items.length, 1);
    // Completing the drive closes the flag by evidence.
    await C.completeInspection({ supabase: db, inspectionId: 'i1', actor: ACTOR, now: new Date('2026-10-26T15:00:00Z') });
    assert.strictEqual(db.tables.work_items[0].status, 'done');
    assert.ok(db.tables.work_item_events.some((e) => e.event === 'closed_by_evidence'));
    const r4 = await C.runManagementFlags({ supabase: db, now: new Date('2026-10-27T13:05:00Z'), logger: { warn() {} } });
    assert.strictEqual(r4.flagged, 0);
  });

  await t('flagsDue / remindersDue are pure and Central-dated', () => {
    const d = { id: 'x', closeout_tracked: true, status: 'in_progress', started_at: '2026-10-25T04:30:00Z' }; // 11:30 PM Oct 24 Central
    assert.strictEqual(C.flagsDue([d], new Date('2026-10-25T13:05:00Z')).length, 1);
    assert.strictEqual(C.flagsDue([{ ...d, started_at: '2026-10-25T05:30:00Z' }], new Date('2026-10-25T13:05:00Z')).length, 0); // 12:30 AM Oct 25 Central
    assert.strictEqual(C.remindersDue([{ ...d, completed_at: 'x' }], NOW).length, 0);
  });

  await t('API routes take the actor from the login, never the body', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'inspections.js'), 'utf8');
    for (const route of ["'/inspections/:id/complete'", "'/inspections/:id/review-complete'"]) {
      const i = src.indexOf(`router.post(${route}`);
      assert.ok(i > 0, `${route} exists`);
      const body = src.slice(i, src.indexOf('\n});', i));
      assert.ok(/const actor = await requireStaff\(req, res\)/.test(body), `${route} uses requireStaff`);
      assert.ok(!/req\.body[^\n]*(user_id|completed_by|reviewer|actor|full_name)/.test(body), `${route} reads no actor from the body`);
      assert.ok(!/body\.(completed_by|user_id|actor|reviewed_by|operator_id)/.test(body), `${route} reads no actor field`);
    }
    // The library takes the actor object only (user.id from the verified JWT).
    const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'inspections', 'closeout.js'), 'utf8');
    assert.ok(/actor\.user\.id/.test(lib));
    assert.ok(!/req\.body/.test(lib));
    // A raw PATCH to 'closed' cannot skip the review gate on tracked drives.
    assert.ok(/use_review_complete/.test(src));
  });

  await t('ops overview counts incomplete drives and pending reviews', () => {
    const { evaluateOps } = require('../lib/ops/overview');
    const ok = (rows) => ({ ok: true, rows });
    const facts = { letters: ok([]), violations: ok([]), acc: ok([]), builder: ok([]), calls: ok([]), drafts: ok([]), work: ok([]), rentals: ok([]), inspections: ok([
      { id: 'a', community_id: 'c1', status: 'in_progress', closeout_tracked: true, started_at: '2026-10-24T14:00:00Z' },
      { id: 'b', community_id: 'c1', status: 'captured', closeout_tracked: true, started_at: '2026-10-23T14:00:00Z', completed_at: '2026-10-23T20:00:00Z' },
      { id: 'c', community_id: 'c1', status: 'closed', closeout_tracked: true, started_at: '2026-10-23T14:00:00Z', completed_at: 'x', review_completed_at: 'y' },
    ]) };
    const r = evaluateOps([{ id: 'c1', name: 'Waterview', management_status: 'active' }], facts, NOW);
    const inc = r.items.find((i) => i.key === 'inspections_incomplete');
    const rev = r.items.find((i) => i.key === 'inspection_reviews_pending');
    assert.strictEqual(inc.count, 1); assert.strictEqual(rev.count, 1);
    const failed = evaluateOps([{ id: 'c1', name: 'Waterview', management_status: 'active' }], { ...facts, inspections: { ok: false, error: 'column does not exist' } }, NOW);
    assert.ok(failed.areas.find((a) => a.key === 'inspections_incomplete').unknown);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
