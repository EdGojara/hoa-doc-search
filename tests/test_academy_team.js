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

// ---- Shared team directory + organizational context ---------------------------
const { ED_CONTEXT, HUMAN_TEAM, AUTHORITY, OWNER_CLASSES, HANDOFF_FIELDS, WORK_RECORD_FIELDS, aiTeam, directory, directoryBlock } = require('../academy/team/directory');
const { checkRouting, validateHandoff } = require('../academy/team/routing_checks');
const TEAM_CASES = require('../academy/team/cases/team_routing.json').cases;

t('directory: every AI teammate from the roster, marked AI, with lane and decision limits; humans marked human', () => {
  const ai = aiTeam();
  assert.deepStrictEqual(ai.map((x) => x.key).sort(), [...rosterKeys].filter((k) => k !== 'general').sort());
  for (const m of ai) { assert.strictEqual(m.kind, 'ai'); assert.ok(m.lane && m.role, m.key); if (!m.private) assert.ok(m.may_not_decide.length, `${m.key} needs decision limits`); }
  for (const h of HUMAN_TEAM) assert.strictEqual(h.kind, 'human');
  for (const k of ['amanda', 'paige', 'claire', 'phoebe']) assert.ok(directory().some((m) => m.key === k));
  assert.ok(HUMAN_TEAM.some((h) => h.key === 'ed') && HUMAN_TEAM.some((h) => h.key === 'community_manager'));
  assert.ok(HUMAN_TEAM.find((h) => h.key === 'staff_unconfirmed').needs_ed_input, 'unknown staff roles are flagged, not invented');
});

t('Ed context is organizational only: role, expertise, approvals, when to involve, when NOT to; no personal-life fields', () => {
  for (const f of ['role', 'expertise', 'responsible_for', 'approves', 'involve_when', 'do_not_escalate', 'how_to_involve']) assert.ok(ED_CONTEXT[f] && ED_CONTEXT[f].length, f);
  assert.ok(ED_CONTEXT.approves.some((a) => /financial posting/.test(a)));
  assert.ok(ED_CONTEXT.do_not_escalate.length >= 6, 'routine work is explicitly kept away from Ed');
  const blob = JSON.stringify([ED_CONTEXT, HUMAN_TEAM]);
  assert.ok(!/\b(age|born|health|depression|family|wife|husband|children|salary|personal capital|net worth|MENSA|SAT|hobby|religion|address|phone)\b/i.test(blob), 'personal/biographical detail leaked into the shared directory');
});

t('authority matrix: valid owner classes; every row sourced in code or flagged as a proposal for Ed', () => {
  for (const a of AUTHORITY) {
    for (const c of a.owner_class) assert.ok(OWNER_CLASSES.includes(c), `${a.decision}: ${c}`);
    assert.ok(a.source || a.proposed === true, `${a.decision} has neither a source nor proposed:true`);
  }
  for (const c of OWNER_CLASSES) assert.ok(AUTHORITY.some((a) => a.owner_class.includes(c)), `no rule teaches ${c}`);
});

t('directory prompt block: names teammates, keeps Tessa and self out, carries the Ed and handoff rules, routes humans by role', () => {
  const b = directoryBlock('amanda');
  assert.ok(!b.includes('Tessa') && !b.includes('Amanda Albright'));
  assert.ok(b.includes('Paige Chandler') && b.includes('Kat Reed') && b.includes('Phoebe Hart'));
  assert.ok(/Do NOT escalate to Ed/.test(b) && /HANDOFF CARRIES THE CONTEXT/.test(b) && /WORK A TEAMMATE DID IS TEAM WORK/.test(b));
  assert.ok(/Route as "Community Manager"/.test(b));
});

t('team routing cases: well-formed, reference real teammates, cover every requested scenario and owner class', () => {
  const keys = new Set(directory().map((m) => m.key));
  const seen = new Set();
  for (const c of TEAM_CASES) {
    assert.ok(['amanda', 'paige', 'claire', 'phoebe'].includes(c.agent), c.case_id);
    const er = c.expected_routing;
    for (const cl of er.owner_class) { assert.ok(OWNER_CLASSES.includes(cl), `${c.case_id} ${cl}`); seen.add(cl); }
    assert.ok(er.owner === 'self' || keys.has(er.owner), `${c.case_id} owner ${er.owner}`);
    assert.ok(['handoff', 'collaborate', 'ask_expertise', 'own'].includes(er.mode), c.case_id);
    for (const w of c.shared_work_context) { for (const f of WORK_RECORD_FIELDS) assert.ok(w[f], `${c.case_id} work record ${f}`); assert.ok(keys.has(w.by), `${c.case_id} by ${w.by}`); }
    if (c.expected_handoff) assert.ok(c.expected_handoff.must_carry.length >= 3, `${c.case_id} handoff must carry context`);
    assert.ok(c.answer_key.must.length && c.answer_key.must_not.length, c.case_id);
  }
  for (const cl of OWNER_CLASSES) assert.ok(seen.has(cl), `no case trains ${cl}`);
  const topics = TEAM_CASES.map((c) => c.topic);
  for (const t of ['claire_to_amanda_governance', 'amanda_to_paige_meeting', 'paige_to_amanda_action_items', 'phoebe_fact_check', 'routine_no_ed', 'posting_needs_ed', 'board_asks_about_paige_work']) assert.ok(topics.includes(t), t);
});

const byId = Object.fromEntries(TEAM_CASES.map((c) => [c.case_id, c]));
const codes = (id, response) => checkRouting({ response, expected: byId[id].expected_routing, sharedWork: byId[id].shared_work_context }).map((v) => v.code);

t('routing checks fire on the failures and stay quiet on good replies', () => {
  // teammate's work on record
  assert.deepStrictEqual(codes('AA-TEAM-007', 'Yes. Paige mailed the annual meeting notice on September 12 to all 412 owners and posted it to the portal the same day.'), []);
  assert.ok(codes('AA-TEAM-007', "I don't have visibility into that, you would need to ask Paige.").includes('RT_TEAMMATE_WORK_DENIED'));
  assert.ok(codes('AA-TEAM-008', "That's Emma's area, so I can't say. You'd have to ask Emma.").includes('RT_TEAMMATE_WORK_DENIED'));
  // routine, no Ed
  assert.deepStrictEqual(codes('AA-TEAM-005', "I'm sending GreenEdge a work request now; irrigation repairs are in their contract, with a 3 business day response window."), []);
  assert.ok(codes('AA-TEAM-005', 'I will flag this for Ed to approve before calling GreenEdge.').includes('RT_UNNEEDED_ED'));
  // posting needs Ed
  assert.deepStrictEqual(codes('AA-TEAM-006', "Hold off. Reserve use needs a board motion and there isn't one on record. Kat, prepare the entry, and it goes to Ed for approval before anything posts."), []);
  const bad6 = codes('AA-TEAM-006', "Sure, go ahead. I've reclassed it to reserves.");
  assert.ok(bad6.includes('RT_DECIDED_OUTSIDE_AUTHORITY') && bad6.includes('RT_MISSING_ED') && bad6.includes('RT_MISSING_BOARD'), bad6.join());
  // handoff names the owner; never asks to repeat
  assert.deepStrictEqual(codes('AA-TEAM-015', 'Annie handles fence applications and already has your survey and the 6 ft cedar details. The committee makes the call; she will follow up.'), []);
  const bad15 = codes('AA-TEAM-015', 'Someone will get back to you. Could you resend the survey?');
  assert.ok(bad15.includes('RT_ASKS_TO_REPEAT') && bad15.includes('RT_OWNER_NOT_NAMED'), bad15.join());
  // human work routes to the role, not a person's desk
  assert.deepStrictEqual(codes('AA-TEAM-009', 'Thank you for the photos of the drain. Our community manager will reach out to set a time to walk it with you.'), []);
  assert.ok(codes('AA-TEAM-009', "I'm forwarding this to Martha and she will call you.").includes('RT_NAMED_HUMAN_ROUTING'));
  // Phoebe does not print the unconfirmed date
  assert.ok(codes('AA-TEAM-004', 'Great news: the pool reopens October 1!').includes('RT_PUBLISHED_UNCONFIRMED'));
  assert.deepStrictEqual(codes('AA-TEAM-004', 'Amanda, can you confirm the date with BlueLine before print? For now I have: resurfacing should wrap up in early October, weather permitting.'), []);
  // waiver: board, not Ed
  assert.ok(codes('AA-TEAM-010', 'I have waived the fee.').includes('RT_DECIDED_OUTSIDE_AUTHORITY'));
  assert.deepStrictEqual(codes('AA-TEAM-010', "I'm sorry about the hospital stay. Waivers are the board's decision; I'll bring it to them with your payment history since 2019."), []);
});

t('handoff package: complete packages pass; lost context and wrong owner are caught', () => {
  const good = {
    from: 'claire', to: 'annie', person: 'Sam Okafor, homeowner, chat', ask: 'will the fence be approved; wants to start in two weeks',
    known: ['6 ft cedar privacy fence, rear (Sam, chat)', 'survey attached with fence line (attachment)', 'Guidelines 4.1 allow up to 6 ft wood'],
    unknown: ['stain color'], actions_on_record: [], promised: ['Annie will follow up'], why_theirs: 'ACC applications are Annie\'s lane', next_step: 'open the ACC application from the survey',
  };
  assert.deepStrictEqual(validateHandoff(good, byId['AA-TEAM-015'].expected_handoff), []);
  const lost = { ...good, known: ['homeowner wants a fence'], ask: 'fence question' };
  assert.ok(validateHandoff(lost, byId['AA-TEAM-015'].expected_handoff).some((p) => p.code === 'HO_CONTEXT_LOST'));
  assert.ok(validateHandoff({ ...good, to: 'amanda' }, byId['AA-TEAM-015'].expected_handoff).some((p) => p.code === 'HO_WRONG_OWNER'));
  const { next_step, ...noNext } = good;
  assert.ok(validateHandoff(noNext).some((p) => p.detail === 'missing next_step'));
  assert.strictEqual(Object.keys(HANDOFF_FIELDS).length, 10);
});

(async () => {
  const { liveHumans } = require('../academy/team/directory');
  const stub = async () => [
    { full_name: 'Ed Gojara', role: 'admin' }, { full_name: 'Ed Gojara', role: 'staff' },
    { full_name: 'Martha Bravo', role: 'staff' }, { full_name: 'Pat Example', role: 'staff' },
    { full_name: 'Bedrock Information', role: 'staff' }, { full_name: 'Kat Reed', role: 'AI' },
  ];
  try {
    const h = await liveHumans({ getTeam: stub });
    assert.deepStrictEqual(h.map((x) => x.name), ['Ed Gojara', 'Martha Bravo', 'Pat Example'], 'dedupes, drops shared mailboxes and AI teammates');
    assert.strictEqual(h.find((x) => x.name === 'Pat Example').needs_ed_input, true, 'unknown role flagged, not guessed');
    assert.strictEqual(h.find((x) => x.name === 'Martha Bravo').route_as, 'Community Manager');
    const b = directoryBlock('amanda', { humans: h });
    assert.ok(/Pat Example \(human, Bedrock staff; role not recorded\): a colleague\. Do not guess/.test(b));
    console.log('PASS  live humans: derived from user_profiles; unknown roles flagged, shared mailboxes and duplicates dropped');
  } catch (e) { failed++; console.log('FAIL  live humans\n   ', e.message); }
  console.log(failed ? `\n${failed} failure(s)` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
