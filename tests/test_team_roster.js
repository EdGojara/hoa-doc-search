// =============================================================================
// tests/test_team_roster.js — one roster, every surface
// =============================================================================
//
// The scar: there were four lists of who works here.
//
//   lib/email/persona.js           TEAM         — the email board's columns
//   lib/email/route_specialist.js  SPECIALISTS  — the hand-off card
//   lib/email/team_roster.js       AI_TEAM      — injected into EVERY outbound
//                                                 persona's system prompt
//   lib/team/roster.js             ROSTER       — the faces + voices
//
// Three were hand-maintained copies. route_specialist.js even carried a comment
// asking the next person to keep it "mirroring persona.js TEAM," which is a
// promise, not a control. And the copy that mattered most had gone stale:
// AI_TEAM listed four people. Kat Reed, Amanda Albright, Reese Calloway and
// Paige Chandler were missing, so every persona was told, authoritatively, that
// its own colleagues did not work here. That is exactly the bug team_roster.js
// was written to prevent — a vendor says "I already spoke with Kat," and Emma
// replies that we have never heard of her.
//
// All three are now derived from lib/team/roster.js. This file is what keeps
// them derived: add a teammate and every surface picks them up, or these fail.
//
// Run: node tests/test_team_roster.js   (wired into npm test)
// =============================================================================

try { require('dotenv').config(); } catch (_) { /* team_roster builds a client at import */ }
const assert = require('assert');
const roster = require('../lib/team/roster');
const { TEAM, TESSA_CARD } = require('../lib/email/persona');
const { SPECIALISTS } = require('../lib/email/route_specialist');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failures += 1; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); }
}

console.log('\nTeam roster — one source of truth\n');

// ---------------------------------------------------------------------------
// The roster itself.
// ---------------------------------------------------------------------------
check('every teammate has the fields every surface reads', () => {
  for (const m of roster.ROSTER) {
    for (const f of ['persona', 'name', 'title', 'mailbox', 'emoji', 'tier', 'language', 'domain']) {
      assert(m[f] !== undefined && m[f] !== '', `"${m.persona}" is missing ${f}`);
    }
    assert(roster.TIERS.includes(m.tier), `"${m.persona}" has tier "${m.tier}", not one of ${roster.TIERS.join('/')}`);
    assert(['en', 'es'].includes(m.language), `"${m.persona}" has language "${m.language}"`);
  }
});

check('persona keys are unique', () => {
  const keys = roster.ROSTER.map((m) => m.persona);
  assert.strictEqual(new Set(keys).size, keys.length, `duplicate persona key in ${keys.join(', ')}`);
});

check('anyone with a video door has a face slot', () => {
  for (const m of roster.people()) {
    if (m.visit) assert(m.face, `"${m.persona}" has visit:true but no face key, so no avatar can ever be configured for them`);
  }
});

check('domains read as a description, not a label', () => {
  // The domain goes into the system prompt, so it can be long and specific.
  for (const m of roster.people()) {
    assert(m.domain.split(/\s+/).length >= 4, `"${m.persona}" domain is too terse to be useful in a prompt: "${m.domain}"`);
  }
});

check('lanes are short enough to say out loud', () => {
  // `lane` is the spoken half. It lands inside "...who handles X. One second."
  // and a visitor is watching a face say it, so a clause list reads as a stall.
  for (const m of roster.ROSTER) {
    assert(m.lane, `"${m.persona}" has no spoken lane`);
    const words = m.lane.split(/\s+/).length;
    assert(words <= 9, `"${m.persona}" lane is ${words} words, too long to speak in a hand-off: "${m.lane}"`);
    assert(!/[:;]/.test(m.lane), `"${m.persona}" lane has prompt punctuation in spoken copy: "${m.lane}"`);
  }
});

// ---------------------------------------------------------------------------
// The derived views. These are the anti-drift checks.
// ---------------------------------------------------------------------------
console.log('\nDerived views agree with the roster');

check('the email board carries every non-private teammate', () => {
  const expected = roster.people().filter((m) => m.email_board !== false && !m.owner_only).map((m) => m.persona);
  const got = TEAM.filter((t) => !t.catch_all).map((t) => t.persona);
  assert.deepStrictEqual(got, expected, `board columns ${got.join(',')} vs roster ${expected.join(',')}`);
});

check('the board still ends with the unrouted pile', () => {
  assert(TEAM[TEAM.length - 1].catch_all === true, 'the catch-all column is not last');
});

check('board names and titles come from the roster', () => {
  for (const t of TEAM) {
    const m = roster.get(t.persona);
    assert(m, `board column "${t.persona}" is not on the roster`);
    assert.strictEqual(t.name, m.name, `"${t.persona}" name disagrees`);
    assert.strictEqual(t.title, m.title, `"${t.persona}" title disagrees`);
    assert.strictEqual(t.mailbox, m.mailbox, `"${t.persona}" mailbox disagrees`);
  }
});

check('the hand-off card agrees with the board', () => {
  for (const [persona, s] of Object.entries(SPECIALISTS)) {
    const m = roster.get(persona);
    assert(m, `specialist "${persona}" is not on the roster`);
    assert.strictEqual(s.name, m.name, `"${persona}" name disagrees between the hand-off card and the roster`);
    assert.strictEqual(s.title, m.title, `"${persona}" title disagrees between the hand-off card and the roster`);
  }
});

check('Tessa stays owner-only and off the board', () => {
  assert(!TEAM.some((t) => t.persona === 'tessa'), 'Ed\'s private EA is on the staff-visible board');
  assert.strictEqual(TESSA_CARD.persona, 'tessa');
  assert.strictEqual(TESSA_CARD.owner_only, true);
  assert.strictEqual(TESSA_CARD.name, roster.get('tessa').name);
});

// ---------------------------------------------------------------------------
// The one that actually bit. AI_TEAM is loaded separately because
// team_roster.js opens a Supabase client at require time.
// ---------------------------------------------------------------------------
console.log('\nEvery persona knows the whole team');

check('the prompt roster lists every teammate except the private EA', () => {
  let AI_TEAM;
  try { ({ AI_TEAM } = require('../lib/email/team_roster')); }
  catch (e) { throw new Error(`could not load team_roster (needs SUPABASE_URL): ${e.message}`); }

  const expected = roster.people().filter((m) => !m.owner_only).map((m) => m.name).sort();
  const got = AI_TEAM.map((m) => m.full_name).sort();
  assert.deepStrictEqual(got, expected,
    `personas would be told these are their only colleagues: ${got.join(', ')}\n        missing: ${expected.filter((n) => !got.includes(n)).join(', ') || 'none'}`);
  assert(!got.includes(roster.get('tessa').name), 'the private EA leaked into every outbound prompt');
});

check('every listed colleague has a real bedrocktx.com address', () => {
  const { AI_TEAM } = require('../lib/email/team_roster');
  for (const m of AI_TEAM) {
    assert(/^[a-z]+@bedrocktx\.com$/.test(m.email), `"${m.full_name}" has address "${m.email}"`);
    assert(m.role && m.role.includes('(AI)'), `"${m.full_name}" is not marked as AI in the roster block`);
  }
});

// ---------------------------------------------------------------------------
// Faces + openers.
// ---------------------------------------------------------------------------
console.log('\nFaces and introductions');

check('avatar and voice resolve per teammate, independently', () => {
  process.env.ANNIE_AVATAR_ID = 'avatar_annie_test';
  process.env.CLAIRE_AVATAR_ID = 'avatar_claire_test';
  assert.strictEqual(roster.avatarIdFor('annie'), 'avatar_annie_test');
  assert.strictEqual(roster.avatarIdFor('claire'), 'avatar_claire_test');
  assert.notStrictEqual(roster.avatarIdFor('annie'), roster.avatarIdFor('claire'), 'two teammates share one face');
  delete process.env.ANNIE_AVATAR_ID; delete process.env.CLAIRE_AVATAR_ID;
});

check('an unconfigured face reports null rather than borrowing another', () => {
  delete process.env.REESE_AVATAR_ID;
  assert.strictEqual(roster.avatarIdFor('reese'), null);
  assert.strictEqual(roster.avatarIdFor('nobody'), null);
});

check('every opener identifies the speaker as AI and names the community', () => {
  for (const m of roster.people()) {
    const o = roster.opener(m.persona, 'Waterview', 'Ed');
    assert(o, `"${m.persona}" has no opener`);
    assert(o.includes(m.name), `"${m.persona}" opener does not say their own name`);
    assert(/\bAI\b|inteligencia artificial/.test(o), `"${m.persona}" opener does not identify as AI: "${o}"`);
    assert(o.includes('Waterview'), `"${m.persona}" opener does not name the community`);
    assert(!/claude|anthropic|openai|gpt|heygen/i.test(o), `"${m.persona}" opener leaks the vendor`);
  }
});

check('openers survive a visitor with no first name', () => {
  for (const m of roster.people()) {
    const o = roster.opener(m.persona, 'Canyon Gate', null);
    assert(!/,\s*,/.test(o) && !/\s+,/.test(o), `"${m.persona}" dangling comma: "${o}"`);
  }
});

check('a hand-off names the person being brought in and why', () => {
  const line = roster.handoffLine('claire', 'annie', 'an architectural request');
  assert(line.includes('Annie Reeves'), 'does not name who is arriving');
  assert(line.includes('architectural'), 'does not say why');
  assert(!/[—–]/.test(line), 'em-dash in customer copy');
  assert(line.split(/\s+/).length <= 32, `hand-off runs long for speech (${line.split(/\s+/).length} words): "${line}"`);
  assert.strictEqual(roster.handoffLine('claire', 'nobody'), null, 'invented a teammate');
});

check('a hand-off says the staff routing reason out loud, not on screen', () => {
  // routeSpecialist writes its reasons for a staffer reading a card. Spoken by
  // a face, "architectural / exterior-modification (ACC) request" is noise.
  const line = roster.handoffLine('claire', 'annie', 'an architectural / exterior-modification (ACC) request');
  assert(!line.includes('('), `parenthetical acronym survived into speech: "${line}"`);
  assert(!/\s\/\s/.test(line), `slash survived into speech: "${line}"`);
  assert(line.includes('architectural'), 'lost the actual reason while cleaning it up');
  const kat = roster.handoffLine('claire', 'kat', 'an accounting action (payment plan, autopay, refund, disputed charge)');
  assert(!kat.includes('('), `parenthetical survived: "${kat}"`);
});

check('the Spanish counterpart introduces herself in Spanish', () => {
  const o = roster.opener('isabella', 'Waterview', 'Ana');
  assert(/inteligencia artificial/.test(o), `Isabella does not identify as AI in Spanish: "${o}"`);
  assert(!/\bI'm\b|What can I help/.test(o), 'Isabella opened in English');
});

console.log(failures ? `\n${failures} FAILED\n` : '\nAll roster checks passed.\n');
process.exit(failures ? 1 : 0);
