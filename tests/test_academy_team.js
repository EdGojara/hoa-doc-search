// tests/test_academy_team.js - Shared culture layer, personalities, team awareness (design invariants).
// Run: node tests/test_academy_team.js
require('dotenv').config({ quiet: true });
const assert = require('assert');
const { PRINCIPLES, cultureBlock } = require('../academy/team/culture');
const { INVARIANTS, PROFILES, SAME_SITUATION_SAMPLES } = require('../academy/team/personalities');
const { TRIGGERS, COLLABORATIONS, teamMap, teamBlock } = require('../academy/team/team_awareness');
const { guard } = require('../academy/lib/action_guard');
const { ROSTER } = require('../lib/team/roster');

let failed = 0;
const t = (name, fn) => { try { fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.message); } };
const rosterKeys = new Set(ROSTER.map((p) => p.persona).filter(Boolean));

t('culture layer: the 8 principles, each with observable behavior and a failure it must not become', () => {
  assert.strictEqual(PRINCIPLES.length, 8);
  for (const p of PRINCIPLES) assert.ok(p.looks_like.length > 40 && p.never_becomes.length > 20, p.id);
  assert.ok(/never lowers this standard, your accuracy, your authority limits, or your follow-through/.test(cultureBlock()));
});

t('four distinct personalities, each tied to a real roster role, each with a guarded blind spot', () => {
  assert.deepStrictEqual(Object.keys(PROFILES).sort(), ['amanda', 'claire', 'paige', 'phoebe']);
  const voices = new Set();
  for (const [k, p] of Object.entries(PROFILES)) {
    assert.ok(rosterKeys.has(p.roster_key), `${k} not in roster`);
    for (const f of ['temperament', 'voice', 'humor', 'under_pressure', 'bad_news', 'disagreement', 'blind_spot', 'team_stance']) assert.ok(p[f] && p[f].length > 20, `${k}.${f}`);
    assert.ok(/Guardrail:/.test(p.blind_spot), `${k} blind spot needs a guardrail`);
    assert.ok(!/\b(may guess|estimate if|round up|promise a date|skip the follow-up)\b/i.test(JSON.stringify(p)), `${k} profile relaxes a standard`);
    voices.add(p.voice);
  }
  assert.strictEqual(voices.size, 4, 'voices must differ');
  assert.ok(INVARIANTS.some((x) => /authority boundary/.test(x)) && INVARIANTS.some((x) => /follow-up/.test(x)));
});

t('same situation, four voices: all pass the integrity guard (no invented action, date, or status)', () => {
  const ctx = 'Pump ordered from AquaTech 9/2; AquaTech has not given a delivery date.';
  for (const k of ['amanda', 'paige', 'claire', 'phoebe']) assert.deepStrictEqual(guard({ message: SAME_SITUATION_SAMPLES[k], contextText: ctx }).map((v) => v.rule), [], k);
  assert.strictEqual(new Set(['amanda', 'paige', 'claire', 'phoebe'].map((k) => SAME_SITUATION_SAMPLES[k])).size, 4);
});

t('team awareness covers every roster teammate and only references real teammates', () => {
  const map = teamMap();
  assert.deepStrictEqual(map.filter((m) => m.missing_triggers).map((m) => m.persona), []);
  for (const k of Object.keys(TRIGGERS)) assert.ok(rosterKeys.has(k), `trigger for unknown teammate ${k}`);
  for (const c of COLLABORATIONS) for (const p of [c.owner, ...c.with]) assert.ok(rosterKeys.has(p), `collaboration references ${p}`);
  const block = teamBlock('amanda');
  assert.ok(!block.includes('Tessa'), 'private owner-only assistant is not offered as a handoff');
  assert.ok(!block.includes('Amanda Albright'), 'an agent is not listed as her own teammate');
  assert.ok(block.includes('Paige Chandler') && block.includes('Kat Reed'));
});

console.log(failed ? `\n${failed} failure(s)` : '\nall passed');
process.exitCode = failed ? 1 : 0;
