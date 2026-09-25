// tests/test_academy.js - Amanda Academy sandbox invariants (offline, no model calls).
// Run: node tests/test_academy.js
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { validateCase, amandaView } = require('../academy/lib/case_schema');
const { loadLivePrompts, systemFor } = require('../academy/lib/live_prompt');
const { runDetectors, CATALOG } = require('../academy/lib/critical');
const { mergeJudges, parseJudge } = require('../academy/lib/rubric');
const { buildRequest, parseResponse } = require('../academy/lib/amanda_under_test');
const L = require('../academy/lib/lessons');

let failed = 0;
const t = (name, fn) => { try { fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.message); } };
const casesDir = path.join(__dirname, '..', 'academy', 'cases');
const cases = fs.readdirSync(casesDir).filter((f) => f.endsWith('.json')).flatMap((f) => JSON.parse(fs.readFileSync(path.join(casesDir, f), 'utf8')));
const byId = Object.fromEntries(cases.map((c) => [c.case_id, c]));

t('all seed cases are valid and unique (12 interaction + 12 technical)', () => {
  const errs = cases.map((c) => [c.case_id, validateCase(c)]).filter(([, e]) => e.length);
  assert.deepStrictEqual(errs, []);
  assert.strictEqual(new Set(cases.map((c) => c.case_id)).size, cases.length);
  assert.strictEqual(cases.filter((c) => c.case_id.startsWith('AA-REL-')).length, 12);
  assert.strictEqual(cases.filter((c) => c.case_id.startsWith('AA-TEC-')).length, 12);
});

t('every case separates FACT / SUPPORTED INFERENCE / UNKNOWN in the answer key', () => {
  for (const c of cases) {
    assert.ok(Array.isArray(c.answer_key.facts) && c.answer_key.facts.length, c.case_id);
    assert.ok(Array.isArray(c.answer_key.supported_inferences), c.case_id);
    assert.ok(Array.isArray(c.answer_key.unknowns), c.case_id);
  }
});

t('Amanda never sees the answer key', () => {
  for (const c of cases) {
    const shown = JSON.stringify(amandaView(c)) + buildRequest(c).prompt;
    for (const trap of c.answer_key.hidden_traps) assert.ok(!shown.includes(trap), `${c.case_id} leaks trap`);
    assert.ok(!shown.includes('expected_next_action') && !shown.includes('completion_condition'), c.case_id);
  }
});

t('live prompt is read from production source (not a copy) and differs by audience', () => {
  const p = loadLivePrompts();
  assert.ok(/^[0-9a-f]{16}$/.test(p.fingerprint));
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'community', 'amanda_reply.js'), 'utf8');
  const board = systemFor('board', 'X');
  assert.ok(src.includes('Treat them like a board') && board.includes('Treat them like a board'));
  assert.ok(systemFor('vendor', 'X').includes('WHAT YOU MAY NOT DISCLOSE'));
  assert.ok(!systemFor('vendor', 'X').includes('HOA FINANCE'), 'vendor never gets the finance primer (matches production)');
  assert.ok(systemFor('staff', 'X').includes('This is a COLLEAGUE'));
  assert.ok(!p.financeAddendum.includes('\\n'), 'finance addendum unescaped');
});

t('detectors: generic phrases are signals; critical only when unambiguous', () => {
  const c = byId['AA-REL-007'];
  const long = 'Yes. ' + 'word '.repeat(80);
  const r = runDetectors(c, long);
  assert.ok(r.critical.some((x) => x.code === 'CF_VERBOSE_WHEN_SHORT_REQUESTED'));
  const ok = runDetectors(c, 'Yes, $12,254 by ACH on 8/31 ($12,242 premium plus a $12 fee).');
  assert.strictEqual(ok.critical.length, 0);
  const noHist = runDetectors(byId['AA-REL-001'], 'As we discussed, I will call them.');
  assert.ok(noHist.critical.some((x) => x.code === 'CF_FABRICATED_MEMORY'));
  const withHist = runDetectors(byId['AA-REL-009'], 'As we discussed, the arborist was scheduled for 9/20.');
  assert.ok(!withHist.critical.some((x) => x.code === 'CF_FABRICATED_MEMORY'), 'history present: memory claim is only a signal');
  const empathy = runDetectors(byId['AA-REL-003'], 'Thank you for reaching out. I understand your frustration. Rest assured we care.');
  assert.ok(empathy.critical.some((x) => x.code === 'CF_FAKE_EMPATHY_OVERUSE'));
});

t('critical catalog covers every required failure', () => {
  for (const code of ['CF_INVENTED_GOVDOC_RULE', 'CF_INVENTED_LEGAL_AUTHORITY', 'CF_UNCONFIRMED_AS_LAPSED', 'CF_TIMING_WITHOUT_EVIDENCE', 'CF_UNAUTHORIZED_POSTING', 'CF_MISSED_INSURANCE_ESCALATION', 'CF_FORGOTTEN_COMMITMENT', 'CF_FABRICATED_MEMORY', 'CF_FALSE_COMPLETION', 'CF_PARTIAL_SCHEDULE_AS_WHOLE', 'CF_MECHANICAL_TO_FRUSTRATED', 'CF_FAKE_EMPATHY_OVERUSE', 'CF_VERBOSE_WHEN_SHORT_REQUESTED', 'CF_TOO_CASUAL_SERIOUS']) assert.ok(CATALOG[code], code);
});

t('judges: split verdicts become needs_review, never averaged; critical flags keep provenance', () => {
  const mk = (e, j, r, x, crit = []) => ({ expertise: { verdict: e }, judgment: { verdict: j }, relationship: { verdict: r }, execution: { verdict: x }, critical_failures: crit });
  const m = mergeJudges([{ judge: 'A', result: mk('pass', 'fail', 'pass', 'pass', [{ code: 'CF_UNCONFIRMED_AS_LAPSED', evidence: 'lapsed' }]) }, { judge: 'B', result: mk('pass', 'pass', 'fail', 'pass') }]);
  assert.strictEqual(m.dimensions.expertise.verdict, 'pass');
  assert.strictEqual(m.dimensions.judgment.verdict, 'needs_review');
  assert.strictEqual(m.dimensions.relationship.verdict, 'needs_review');
  assert.strictEqual(m.dimensions.judgment.agreement, 'disagree');
  assert.strictEqual(m.critical_failures[0].status, 'disputed');
  assert.ok(!('overall' in m) && !('score' in m), 'no overall score');
  assert.throws(() => parseJudge('{"expertise":{"verdict":"great"}}'));
});

t('contract mode parses the internal contract and keeps the message separate', () => {
  const txt = JSON.stringify({ internal: { facts: [], supported_inferences: [], unknowns: [], issues: [], proposed_actions: [], authority_required: [], escalation: 'none', communication_plan: 'short', next_action: { action: 'a', owner: 'b' }, completion_condition: 'c' }, message: 'Hi Tom, yes.' });
  const r = parseResponse('```json\n' + txt + '\n```', 'contract');
  assert.strictEqual(r.message, 'Hi Tom, yes.');
  assert.strictEqual(r.contract_ok, true);
  assert.strictEqual(parseResponse('plain text', 'contract').contract_ok, false);
  assert.ok(buildRequest(byId['AA-REL-007'], { mode: 'contract' }).system.includes('EVALUATION MODE'));
  assert.ok(!buildRequest(byId['AA-REL-007']).system.includes('EVALUATION MODE'), 'baseline = production prompt only');
});

t('lessons: evaluator output can never self-activate; active needs human approval + regression case', () => {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'academy', 'lessons', 'seed_lessons.json'), 'utf8'));
  for (const l of seed) assert.deepStrictEqual(L.validateLesson(l), [], l.lesson_id);
  assert.strictEqual(L.compileActive(seed), '', 'draft lessons never compile into behavior');
  const evalLesson = { ...seed[0], lesson_id: 'LSN-JDG-900', source: 'evaluator' };
  assert.throws(() => L.transition(evalLesson, 'reviewed', { by: 'evaluator' }), /human/);
  assert.throws(() => L.transition(evalLesson, 'approved', { by: 'Ed Gojara' }), /illegal/);
  const r = L.transition(evalLesson, 'reviewed', { by: 'Ed Gojara' });
  const a = L.transition(r, 'approved', { by: 'Ed Gojara' });
  assert.throws(() => L.transition({ ...a, regression_case_ids: [] }, 'active', { by: 'Ed Gojara' }), /regression case/);
  const act = L.transition(a, 'active', { by: 'Ed Gojara' });
  assert.ok(L.compileActive([act]).includes('Unconfirmed is not the same as lapsed'));
  const v2 = L.newVersion(act, { principle: 'Unconfirmed is not lapsed; say what is known and act the same day.' }, { by: 'Ed Gojara' });
  assert.strictEqual(v2.status, 'draft');
  assert.ok(L.compileActive([act, v2]).includes('Unconfirmed is not the same as lapsed'), 'old version stays active until the new one is activated');
  assert.strictEqual(act.history.length, 3);
});

console.log(failed ? `\n${failed} failure(s)` : '\nall passed');
process.exitCode = failed ? 1 : 0;
