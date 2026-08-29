// =============================================================================
// tests/test_operator_actions.js — what a teammate may DO on its own
// =============================================================================
//
// The action layer is where autonomy becomes real, so its safety is the whole
// ballgame. Two invariants, enforced in code, must hold no matter what a prompt
// says:
//
//   1. A RESERVED action (irreversible or authority-bearing — waive, pay,
//      approve, send a §209 letter, delete) NEVER self-executes. There is no
//      autonomy setting that runs it. It can only be proposed for a human.
//   2. A SAFE action runs on its own ONLY when its lane is explicitly on
//      'execute'. Dark by default: propose-only, nothing mutates.
//
// The test uses fake actions whose execute() throws, so "was execute called"
// is provable: if a reserved action or a dark-lane safe action ran, the throw
// would surface. Deterministic, no DB, no model.
//
// Run: node tests/test_operator_actions.js   (wired into npm test)
// =============================================================================

const assert = require('assert');
const {
  runAction, resolveAction, ACTIONS,
  inferServiceCategory, resolveCommunityVendor, renderVendorOutreach,
} = require('../lib/team/operator_actions');

// A tiny thenable Supabase stub: from(table) returns a builder whose query
// methods chain and that awaits to the configured { data, error } for the table.
function fakeSupabase(byTable) {
  return {
    from(table) {
      const result = byTable[table] || { data: [], error: null };
      const builder = {
        select() { return builder; }, eq() { return builder; }, in() { return builder; },
        limit() { return builder; }, order() { return builder; },
        then(res, rej) { return Promise.resolve(result).then(res, rej); },
      };
      return builder;
    },
  };
}

let failures = 0;
function check(name, fn) {
  const run = fn.constructor.name === 'AsyncFunction' ? fn() : Promise.resolve().then(fn);
  return run.then(() => console.log(`  PASS  ${name}`))
    .catch((err) => { failures += 1; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); });
}

const boom = async () => { throw new Error('execute() must NOT have been called'); };
const reserved = { name: 'reserved_x', risk: 'reserved', summarize: () => 'do reserved x', execute: boom };
const safe = { name: 'safe_y', risk: 'safe', summarize: () => 'do safe y', execute: async () => ({ ok: true }) };
const safeBoom = { name: 'safe_boom', risk: 'safe', summarize: () => 'safe that throws if run', execute: boom };

(async () => {
  console.log('\nOperator actions — the autonomy gate\n');

  await check('reserved action never executes, even with autonomy=execute', async () => {
    const r = await runAction(reserved, {}, {}, { autonomy: 'execute' });
    assert.strictEqual(r.status, 'proposed', `got ${r.status}`);
    assert.ok(/reserved/.test(r.reason), 'reason should name it reserved');
  });

  await check('safe action is proposed (not run) when the lane is dark', async () => {
    const r = await runAction(safeBoom, {}, {}, { autonomy: 'propose' });
    assert.strictEqual(r.status, 'proposed', `got ${r.status}`);
  });

  await check('safe action executes only when the lane is on execute', async () => {
    const r = await runAction(safe, {}, {}, { autonomy: 'execute' });
    assert.strictEqual(r.status, 'done', `got ${r.status}`);
    assert.deepStrictEqual(r.result, { ok: true });
  });

  await check('default autonomy is propose-only (dark)', async () => {
    const r = await runAction(safeBoom, {}, {});
    assert.strictEqual(r.status, 'proposed', 'default must be dark');
  });

  await check('unknown action is an error, not a silent no-op', async () => {
    const r = await runAction(null, {}, {}, { autonomy: 'execute' });
    assert.strictEqual(r.status, 'error');
  });

  await check('log_interaction is registered as a SAFE action', async () => {
    const a = resolveAction('log_interaction');
    assert.ok(a, 'log_interaction not registered');
    assert.strictEqual(a.risk, 'safe');
    assert.ok(Object.isFrozen(ACTIONS), 'ACTIONS registry should be frozen');
  });

  await check('draft_vendor_outreach is SAFE and dark by default (drafting only)', async () => {
    const a = resolveAction('draft_vendor_outreach');
    assert.ok(a && a.risk === 'safe', 'should be a registered safe action');
    // Safe, but sending is never its job — it queues a needs_review draft, and
    // in a dark lane it is only proposed.
    const r = await runAction(a, {}, {}, { autonomy: 'propose' });
    assert.strictEqual(r.status, 'proposed');
  });

  console.log('\n  -- vendor outreach: category inference --');
  await check('infers categories from natural issue text; unknown -> null', () => {
    assert.strictEqual(inferServiceCategory('sprinkler zone 3 wont shut off'), 'irrigation');
    assert.strictEqual(inferServiceCategory('there is a water line leak at the entrance'), 'plumbing');
    assert.strictEqual(inferServiceCategory('the pool pump is broken'), 'pool');
    assert.strictEqual(inferServiceCategory('the front gate wont open'), 'gate');
    assert.strictEqual(inferServiceCategory('my dog is barking'), null);
  });

  console.log('\n  -- vendor outreach: the rendered email --');
  await check('renders greeting, issue, community, and access note', () => {
    const { subject, body } = renderVendorOutreach(
      { contactName: 'Daniel Aleman' },
      { issue: 'Sprinkler zone 3 is stuck on.', communityName: 'Quail Ridge', category: 'irrigation', accessNote: 'Gate code 1234' });
    assert.ok(/irrigation/.test(subject) && /Quail Ridge/.test(subject), 'subject names category + community');
    assert.ok(/Hi Daniel,/.test(body), 'greets the vendor contact by first name');
    assert.ok(/Sprinkler zone 3 is stuck on\./.test(body), 'includes the issue');
    assert.ok(/Gate code 1234/.test(body), 'includes the access note');
  });

  console.log('\n  -- vendor outreach: resolver on real-shaped data --');
  await check('single category match -> confident pick, with compound email cleaned', async () => {
    const sb = fakeSupabase({
      vendor_contracts: { data: [], error: null },
      ap_invoices: { data: [{ vendor_id: 'v1', invoice_date: '2026-07-01', total_cents: 500000 }], error: null },
      vendors: { data: [{ id: 'v1', name: 'Swim Houston Pool Management LLC', email: 'matt@swimhoustonpools.com / hill@swimhoustonpools.com', is_active: true, status: 'active' }], error: null },
    });
    const r = await resolveCommunityVendor(sb, 'c1', 'pool', {});
    assert.ok(r.pick, 'should have a confident pick');
    assert.strictEqual(r.pick.email, 'matt@swimhoustonpools.com', 'compound email must be reduced to the first valid address');
    assert.strictEqual(r.pick.source, 'history');
  });

  await check('two category matches -> no auto-pick, humans choose from candidates', async () => {
    const sb = fakeSupabase({
      vendor_contracts: { data: [], error: null },
      ap_invoices: { data: [{ vendor_id: 'v1' }, { vendor_id: 'v2' }], error: null },
      vendors: { data: [
        { id: 'v1', name: 'Superior LawnCare', email: 'a@x.com', is_active: true },
        { id: 'v2', name: 'Green Turf Irrigation', email: 'b@x.com', is_active: true },
      ], error: null },
    });
    const r = await resolveCommunityVendor(sb, 'c1', 'irrigation', {});
    assert.strictEqual(r.pick, null, 'ambiguous -> no auto pick');
    assert.ok(r.candidates.length === 2 && r.candidates.every((c) => c.matchesCategory), 'both surface as matching candidates');
  });

  await check('an errored ap_invoices query FAILS LOUD (never read as "no vendors")', async () => {
    const sb = fakeSupabase({
      vendor_contracts: { data: [], error: null },
      ap_invoices: { data: null, error: { message: 'boom', code: '42703' } },
      vendors: { data: [], error: null },
    });
    let threw = false;
    try { await resolveCommunityVendor(sb, 'c1', 'pool', {}); } catch (_) { threw = true; }
    assert.ok(threw, 'must throw on a DB error, not silently return empty');
  });

  console.log('');
  if (failures) { console.log(`FAILED — ${failures} case(s)\n`); process.exit(1); }
  console.log('All operator action cases passed.\n');
})();
