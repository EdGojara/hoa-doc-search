// ============================================================================
// tests/test_tessa_groups.js — "staff" is a group, not somebody's surname.
// ----------------------------------------------------------------------------
// Ed 2026-08-21: "this is totally wrong."
//
// He asked: "can you send email to staff to introduce them to ai team and what
// each of you does."
//
// She addressed it to STAFFORD BECK <stafford.beck@vantaca.com>.
//
// "staff" went through the ordinary contact search, ILIKE %staff% matched
// "Stafford Beck", it was the ONLY match in 539 contacts, and a single match
// auto-fills the To field. An internal note about Bedrock's own team was one
// click from an employee of the software vendor we are migrating off.
//
// contactMatchesHint did not catch it and was never going to: "staff" is five
// characters, past the short-hint whole-word rule, and "stafford beck" contains
// "staff". That rule exists to stop two-letter hints matching inside domains.
//
// So the fix is CATEGORICAL rather than another scoring tweak. A word that
// names a group must never resolve to an individual, and when the group cannot
// be resolved she asks.
//
// The same email also invented its own content — see the second section.
// ============================================================================
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseGroupWord, teamFactsForPrompt } = require('../lib/ea/tessa_groups');

let pass = 0; let fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); } };

console.log('\nGroup words are groups');
check('the ways Ed actually says it', () => {
  for (const s of ['staff', 'the staff', 'all staff', 'everyone', 'the team', 'our team',
    'the office', 'the whole team', 'the entire staff', 'management']) {
    const g = parseGroupWord(s);
    assert.ok(g, `"${s}" must be recognised as a group`);
    assert.strictEqual(g.kind, 'staff', `"${s}" is the human staff`);
  }
});
check('the AI team is its own group', () => {
  for (const s of ['ai team', 'the ai team', 'the agents']) {
    const g = parseGroupWord(s);
    assert.ok(g && g.kind === 'ai_team', `"${s}" is the AI team, not the humans`);
  }
});

console.log('\nA person is still a person');
check('Stafford Beck does not become a group', () => {
  // The other direction of the same bug: over-correcting would stop her
  // emailing a real person whose name happens to contain a group word.
  assert.strictEqual(parseGroupWord('Stafford Beck'), null);
  assert.strictEqual(parseGroupWord('stafford'), null);
});
check('names that merely contain a group word are untouched', () => {
  for (const s of ['Teamer', 'Staffieri', 'Officer Dan', 'Mr Staffordshire']) {
    assert.strictEqual(parseGroupWord(s), null, `"${s}" is a person`);
  }
});
check('an empty hint is not a group', () => {
  assert.strictEqual(parseGroupWord(''), null);
  assert.strictEqual(parseGroupWord(null), null);
  assert.strictEqual(parseGroupWord('   '), null);
});

console.log('\nThe group runs before any person search');
check('resolveOne checks group words first', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ea', 'tessa_request.js'), 'utf8').replace(/\r\n/g, '\n');
  const group = src.indexOf('parseGroupWord(hint)');
  const person = src.indexOf('await resolveRecipient(hint)');
  assert.ok(group > -1, 'the group check must exist');
  assert.ok(person > -1, 'the person search must still exist');
  assert.ok(group < person, 'a group word must never reach the person search — that is the Stafford Beck bug');
});
check('an unresolvable group asks rather than guessing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ea', 'tessa_request.js'), 'utf8');
  assert.ok(/could not work out who .+ means/i.test(src),
    'she must ask who is meant, never fall back to the closest-looking name');
});

console.log('\nStaff means Bedrock people, not personas');
check('persona mailboxes are excluded', () => {
  // Mailing the AI team about the AI team is not what "staff" means.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ea', 'tessa_groups.js'), 'utf8');
  assert.ok(/personas/.test(src), 'the AI mailboxes must be filtered out of the staff group');
});
check('it reads the same table the Team screen does', () => {
  // The first cut read portal_users — the PORTAL login table for homeowners,
  // board members and managers. Wrong in both directions: it included Laurie
  // Vrvilo, who left in August and is deactivated on the Team screen, and it
  // left out Celina Deleon and Lizette Cano, who work here.
  //
  // Deactivating somebody on the Team screen has to stop their mail, and that
  // is only true if both surfaces read the same rows.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ea', 'tessa_groups.js'), 'utf8');
  const users = fs.readFileSync(path.join(__dirname, '..', 'api', 'users.js'), 'utf8');
  assert.ok(/from\('user_profiles'\)/.test(src), 'the staff group must read user_profiles');
  assert.ok(/from\('user_profiles'\)/.test(users), 'and that is what the Team screen reads');
  assert.ok(!/from\('portal_users'\)/.test(src), 'portal_users is the portal login table, not the staff roster');
  assert.ok(/\.eq\('is_active', true\)/.test(src), 'only active people get mail');
});
check('only @bedrocktx.com', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ea', 'tessa_groups.js'), 'utf8');
  assert.ok(/ilike\('email', '%@bedrocktx\.com'\)/.test(src),
    'an outside address must never land in "staff" — that is the whole incident');
});

console.log('\nShe stops inventing colleagues');
check('the roster is handed to her, complete', () => {
  // Same email: "Kat Reed works with board members, helping them stay informed
  // and engaged" — Kat is the ACCOUNTING MANAGER — plus an introduction to
  // "Daniel Ibarra", who does not exist, while Claire, Emma, Annie, Miranda,
  // Amanda, Reese and Paige were left out entirely.
  const facts = teamFactsForPrompt();
  assert.ok(facts, 'there must be a roster block at all');
  for (const who of ['Claire Bennett', 'Emma Brooks', 'Kat Reed', 'Annie Reeves',
    'Miranda Pierce', 'Amanda Albright', 'Reese Calloway', 'Paige Chandler', 'Tessa McCall']) {
    assert.ok(facts.includes(who), `${who} must be in the roster she is given`);
  }
});
check('Kat is the accounting manager, in the text she gets', () => {
  const facts = teamFactsForPrompt();
  assert.ok(/Kat Reed — Accounting Manager/.test(facts),
    'the exact fact she got wrong must be the fact she is handed');
});
check('the roster derives from roster.js, not a second copy', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ea', 'tessa_groups.js'), 'utf8');
  assert.ok(/require\('\.\.\/team\/roster'\)/.test(src),
    'a hand-maintained copy would drift the moment someone joins');
});
check('and she is told not to embroider it', () => {
  const facts = teamFactsForPrompt();
  assert.ok(/complete and only list/i.test(facts), 'the instruction must be explicit');
  assert.ok(/do not add/i.test(facts), '"Daniel Ibarra" is what happens without this');
});
check('it is only attached when the email is about the team', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ea', 'tessa_request.js'), 'utf8');
  assert.ok(/aboutTheTeam/.test(src), 'the roster should not ride along on every unrelated email');
});

console.log(`\ntessa_groups: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
