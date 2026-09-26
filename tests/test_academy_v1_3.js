// tests/test_academy_v1_3.js - pre-draft owner/authority classifier, release
// gate, community governance bodies, ownership-before-intent flow.
// Run: node tests/test_academy_v1_3.js
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { classifyOwner, ownerBlock } = require('../academy/team/owner_classifier');
const { gateProblems, release } = require('../academy/team/release_gate');
const { bodiesFor, decidingBody, governanceBlock } = require('../academy/team/governance');
const { teamRequest } = require('../academy/team/agent_under_test');
const { buildRequest, contextText } = require('../academy/lib/amanda_under_test');
const { SHAPES, withOwnership } = require('../academy/lib/intent');

let failed = 0;
const t = (name, fn) => { try { fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.message); } };

const TEAM = require('../academy/team/cases/team_routing.json').cases;
const AMANDA = [];
for (const f of ['interaction.json', 'technical.json', 'regression_v1_1.json']) {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'academy', 'cases', f), 'utf8'));
  for (const c of (raw.cases || raw)) AMANDA.push(c);
}
const all = [...AMANDA.map((c) => ({ ...c, agent: 'amanda' })), ...TEAM];
const byId = Object.fromEntries(all.map((c) => [c.case_id, c]));
const classify = (c) => classifyOwner({ message: c.incoming_message.text, agent: c.agent || 'amanda', audience: c.audience, contextText: (c.available_context || []).map((x) => x.text).join('\n'), history: c.conversation_history || [], sharedWork: c.shared_work_context || [], community: c.community_context || {} });

// Expected owner for every case in the two suites that will be rerun.
const EXPECTED = {
  'AA-REL-001': ['current_agent', 'amanda', false], 'AA-REL-003': ['current_agent', 'amanda', false], 'AA-REL-006': ['current_agent', 'amanda', false],
  'AA-REL-007': ['current_agent', 'amanda', false], 'AA-REL-009': ['current_agent', 'amanda', false], 'AA-REL-010': ['current_agent', 'amanda', false],
  'AA-TEC-004': ['current_agent', 'amanda', false], 'AA-TEC-007': ['current_agent', 'amanda', false],
  'AA-REG-001': ['current_agent', 'amanda', false], 'AA-REG-002': ['current_agent', 'amanda', false], 'AA-REG-003': ['current_agent', 'amanda', false],
  'AA-REG-004': ['current_agent', 'amanda', false], 'AA-REG-005': ['current_agent', 'amanda', false], 'AA-REG-006': ['current_agent', 'amanda', false],
  'AA-REG-007': ['current_agent', 'amanda', false], 'AA-REG-008': ['current_agent', 'amanda', false],
  'AA-TEAM-001': ['ai_teammate', 'amanda', true], 'AA-TEAM-002': ['ai_teammate', 'paige', true], 'AA-TEAM-003': ['ai_teammate', 'amanda', true],
  'AA-TEAM-004': ['current_agent', 'phoebe', false], 'AA-TEAM-005': ['current_agent', 'amanda', false], 'AA-TEAM-006': ['accounting', 'kat', true],
  'AA-TEAM-007': ['current_agent', 'amanda', false], 'AA-TEAM-008': ['current_agent', 'paige', false], 'AA-TEAM-009': ['human_role', 'community_manager', true],
  'AA-TEAM-010': ['board', 'board', false], 'AA-TEAM-011': ['legal', 'darby', true], 'AA-TEAM-012': ['accounting', 'kat', true],
  'AA-TEAM-013': ['ai_teammate', 'emma', true], 'AA-TEAM-014': ['ai_teammate', 'maggie', true], 'AA-TEAM-015': ['community_governance_body', 'annie', true],
  'AA-TEAM-016': ['human_role', 'community_manager', false],
};

t('owner classifier: every case in both rerun suites gets the expected owner class, owner, and handoff decision', () => {
  const wrong = [];
  for (const [id, [cls, owner, handoff]] of Object.entries(EXPECTED)) {
    const o = classify(byId[id]);
    if (o.owner_class !== cls || o.owner !== owner || o.handoff_required !== handoff) wrong.push(`${id}: got ${o.owner_class}/${o.owner}/handoff=${o.handoff_required}, want ${cls}/${owner}/${handoff}`);
  }
  assert.deepStrictEqual(wrong, []);
  assert.strictEqual(Object.keys(EXPECTED).length, 32);
});

t('all eight owner classes are reachable, with owner, reason, authority, handoff, accountability', () => {
  const probes = {
    current_agent: ['Did we pay Harned? Y/N', 'amanda'],
    ai_teammate: ['Finished the pole light repair. Who do I send the invoice to?', 'amanda'],
    human_role: ['Can someone come look at the drain with me?', 'amanda'],
    ed: ['We received a notice from the county about the retention pond.', 'amanda'],
    board: ['Can you waive the $150 late fee?', 'amanda'],
    legal: ['My attorney will be contacting you.', 'amanda'],
    accounting: ['The bank statement shows $412,880 but the financials say $405,130. Which is right?', 'amanda'],
  };
  for (const [cls, [m, agent]] of Object.entries(probes)) {
    const o = classifyOwner({ message: m, agent });
    assert.strictEqual(o.owner_class, cls, m);
    for (const f of ['owner', 'reason', 'authority_required', 'handoff_required', 'accountable', 'transfer']) assert.ok(f in o, `${cls}.${f}`);
  }
  assert.strictEqual(classify(byId['AA-TEAM-015']).owner_class, 'community_governance_body');
});

t('legal threats: legal-review path owns it (Darby), Ed is the internal escalation, no merits, handoff mandatory', () => {
  const o = classifyOwner({ message: 'This fence violation is harassment. My attorney will be contacting you.', agent: 'amanda' });
  assert.deepStrictEqual([o.owner_class, o.owner, o.notify, o.handoff_required, o.accountable], ['legal', 'darby', ['ed'], true, 'amanda']);
  const block = ownerBlock(o, { names: { darby: 'Darby Woods', ed: 'Ed Gojara' } });
  assert.ok(/Do not respond to the merits/.test(block) && /notify Ed Gojara/.test(block) && /stay accountable for follow-through/.test(block));
});

t('follow-through: the originating agent stays accountable unless ownership explicitly transfers', () => {
  const claireToAmanda = classify(byId['AA-TEAM-001']);
  assert.strictEqual(claireToAmanda.accountable, 'claire');
  assert.strictEqual(claireToAmanda.transfer, false);
  assert.strictEqual(classify(byId['AA-TEAM-013']).transfer, true, 'Emma fully owns vendor invoices');
});

t('release gate: a required handoff blocks release without a valid package; valid package releases', () => {
  const o = classify(byId['AA-TEAM-011']);
  assert.strictEqual(release(o, null).status, 'held');
  const pkg = { from: 'amanda', to: 'darby', notify: ['ed'], requestor: 'Ron Castillo, homeowner, email', issue: 'says the fence violation is harassment; attorney will contact us', known_facts: ['V-3310 fence stain, courtesy notice 2 sent 9/10'], unknowns: ['attorney name'], actions_taken: [], source_refs: ['violation record V-3310'], reason: 'legal threat goes to legal review', next_expected_action: 'Darby coordinates counsel and briefs Ed', followup_state: 'Ron told it has gone to the team that handles legal matters; Amanda keeps the thread' };
  assert.strictEqual(release(o, pkg).status, 'released');
  assert.strictEqual(release(o, { ...pkg, notify: [] }).status, 'held', 'missing Ed escalation holds it');
  assert.strictEqual(release(o, { ...pkg, to: 'amanda' }).status, 'held', 'wrong owner holds it');
  assert.deepStrictEqual(gateProblems(classify(byId['AA-TEAM-007']), null), [], 'no handoff required, nothing to gate');
});

t('governance bodies: community-specific, source-backed, date-bounded; no generic committee', () => {
  const body = { name: 'Architectural Control Committee', type: 'acc', scope: 'exterior modifications', source: 'Declaration Art. 8', active_from: '2019-01-01', active_to: null };
  assert.strictEqual(bodiesFor({ governance_bodies: [body] }).length, 1);
  assert.strictEqual(bodiesFor({ governance_bodies: [{ ...body, source: '' }] }).length, 0, 'no source, no body');
  assert.strictEqual(bodiesFor({ governance_bodies: [{ ...body, active_to: '2020-01-01' }] }).length, 0, 'expired');
  assert.strictEqual(decidingBody({}, 'architectural'), null);
  assert.ok(/none on record/.test(governanceBlock({})) && /do not name any committee/.test(governanceBlock({})));
  assert.strictEqual(classifyOwner({ message: 'So will my fence get approved?', agent: 'claire' }).owner_class, 'board', 'no ACC on record: the board decides');
});

t('flow: ownership is decided before intent; a required handoff overrides the conversational shape', () => {
  const r = teamRequest(byId['AA-TEAM-011'], { team: {} });
  assert.strictEqual(r.owner.owner_class, 'legal');
  assert.strictEqual(r.intent.mode, 'handoff', 'a legal threat read as casual must not get a chatty reply');
  assert.ok(r.system.indexOf('OWNERSHIP') > -1 && r.system.indexOf('OWNERSHIP') < r.system.indexOf('WHAT THIS MESSAGE IS'), 'ownership precedes the intent shape');
  assert.ok(/GOVERNANCE BODIES FOR THIS COMMUNITY/.test(r.system));
  assert.strictEqual(withOwnership({ mode: 'direct_fact', underlying_mode: 'direct_fact' }, { handoff_required: false }).mode, 'direct_fact');
  assert.ok(SHAPES.handoff && /no rulings, no arguments/.test(SHAPES.handoff));
  const a = buildRequest(AMANDA.find((c) => c.case_id === 'AA-REG-004'), { mode: 'candidate' });
  assert.ok(a.owner && /OWNERSHIP/.test(a.system), 'existing Amanda cases get the same step');
  assert.ok(contextText);
});

t('v1.3 run misses (judge-confirmed) are now caught by the guard', () => {
  const { guard } = require('../academy/lib/action_guard');
  const r = (m) => guard({ message: m, agent: 'amanda' }).map((v) => v.rule);
  // AA-REL-010 r1: a physical visit phrased as a calendar entry
  assert.ok(r("I'm putting a site visit on my calendar for this afternoon to verify the gate closes and latches properly.").includes('CAPABILITY'));
  // AA-REG-003 r2: what other associations may do, offered as if it answered this one
  assert.ok(r('Many communities can adopt fees through a board resolution, but some require an amendment.').includes('TYPICAL_AS_RULE'));
  assert.deepStrictEqual(r('I will ask our community manager to set up a site visit.'), [], 'delegation is not a capability claim');
});

t('substantive-ruling guard: the originating agent may acknowledge and hand off, never rule (all agents)', () => {
  const { rulingViolations } = require('../academy/team/ruling_guard');
  const gov = classifyOwner({ message: 'Can the board just change the fence rules without asking us?', agent: 'claire' });
  const v = (m, o, a) => rulingViolations({ message: m, owner: o, agent: a }).map((x) => x.rule);
  // AA-TEAM-001 r2, verbatim
  for (const m of ['So yes, they could decide wood fences need approval or limit certain styles through a rule.', "The board can't do that on its own.", '**Rules**: The board can adopt or change rules without a membership vote.']) assert.ok(v(m, gov, 'claire').includes('SUBSTANTIVE_RULING'), m);
  // Ed's allowed example
  assert.deepStrictEqual(v("I've sent this to Amanda because it requires a governance review. She has the documents and context.", gov, 'claire'), []);
  assert.deepStrictEqual(v('Section 7.2 and Section 12.1 both come up here, and Amanda will walk you through how they apply.', gov, 'claire'), [], 'naming the sections and the handoff is not a ruling');
  // other agents and domains
  const acc = classifyOwner({ message: 'The reserve statement shows $412,880 but the financials say $405,130. Which is right?', agent: 'amanda' });
  assert.ok(v('The difference is timing.', acc, 'amanda').includes('SUBSTANTIVE_RULING'));
  const legal = classifyOwner({ message: 'This fence violation is harassment. My attorney will be contacting you.', agent: 'amanda' });
  assert.ok(v('A violation notice is not harassment.', legal, 'amanda').includes('SUBSTANTIVE_RULING'));
  const arc = classifyOwner({ message: 'So will my fence get approved?', agent: 'claire', history: [{ text: '6 ft cedar fence, survey attached' }] });
  assert.ok(v('It meets the guidelines, so it should be approved.', arc, 'claire').includes('SUBSTANTIVE_RULING'));
  // the owner answering its own question is not gated
  const own = classifyOwner({ message: 'For 2027, can the board raise dues 15% on our own?', agent: 'amanda' });
  assert.deepStrictEqual(v('So yes, the board can adopt it by resolution.', own, 'amanda'), [], 'Amanda owns governance; this guard does not apply to the owner');
});

console.log(failed ? `\n${failed} failure(s)` : '\nall passed');
process.exitCode = failed ? 1 : 0;
