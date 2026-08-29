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
const { runAction, resolveAction, ACTIONS } = require('../lib/team/operator_actions');

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

  console.log('');
  if (failures) { console.log(`FAILED — ${failures} case(s)\n`); process.exit(1); }
  console.log('All operator action cases passed.\n');
})();
