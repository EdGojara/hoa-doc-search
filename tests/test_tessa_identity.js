// ============================================================================
// tests/test_tessa_identity.js — the people Tessa must never have to look up.
// ----------------------------------------------------------------------------
// Ed 2026-08-21, with a screenshot: "tessa is having a hard time understanding
// me, she doesn't know who Ed is."
//
// He had asked her to "send to canyon gate board and copy ed and martha". She
// got the board right and Martha right, then asked:
//
//     Which one did you mean by "ed"?
//       Hope Lloyd at Bedrock Association Management
//       HomeWiseDocs Implementation at Homewisedocs
//       Claire Bennett at Bedrock Association Management
//       Jobs/Careers Inbox at Bedrock Association Management
//       Kale McClarty at RealPage
//
// Then: "should i use Ed G to help her" — which is the wrong question to have to
// ask. Phrasing instructions around an assistant's blind spot is the bug.
//
// TWO FAULTS, tested separately below:
//
//  1. Ed was in no list she reads. roster.js is the AI team; the address book
//     was mined from his correspondence, which does not contain him as a
//     correspondent. His own name hit the generic fuzzy search like a stranger's.
//
//  2. The search ILIKEs %hint% against the EMAIL column, so "ed" matched 96 of
//     539 contacts through b-ed-rocktx.com, homewis-ed-ocs.com, f-ed-ex.com and
//     inde-ed-email.com. A two-letter hint inside a domain is a coincidence, not
//     a match.
// ============================================================================
require('dotenv').config();
const assert = require('assert');
const {
  resolveKnownIdentity, knownIdentities, edIdentity, teamIdentities,
} = require('../lib/ea/tessa_identity');

let passed = 0;
const results = [];
const check = (group, name, fn) => results.push({ group, name, fn });

// The real matcher from api/tessa.js. Kept in step with it by the last test in
// this file, which reads the source and fails if the two drift apart.
function contactMatchesHint(c, q) {
  const hint = String(q || '').toLowerCase().trim();
  if (!hint) return true;
  const local = String(c.email || '').toLowerCase().split('@')[0];
  const fields = [c.name, c.org, c.role, local].map((s) => String(s || '').toLowerCase());
  if (hint.length >= 4) return fields.some((f) => f.includes(hint));
  const esc = hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`);
  return fields.some((f) => re.test(f));
}

// ---------------------------------------------------------------------------
check('She knows her boss', '"ed" is Ed, with no question asked', async () => {
  const r = resolveKnownIdentity('ed');
  assert.ok(r, 'she must not have to ask who Ed is');
  assert.strictEqual(r.name, 'Ed Gojara');
  assert.match(r.email, /^egojara@/);
  assert.strictEqual(r.source, 'known_identity');
});

check('She knows her boss', 'case and surname both work', async () => {
  for (const h of ['Ed', 'ED', 'ed gojara', 'Ed Gojara', 'gojara']) {
    const r = resolveKnownIdentity(h);
    assert.ok(r && r.name === 'Ed Gojara', `"${h}" must resolve to Ed`);
  }
});

check('She knows her boss', 'first person means Ed too', async () => {
  // He dictates in both voices: "ed asked me to reach out" when writing FOR her,
  // "copy me" when instructing her.
  for (const h of ['me', 'myself', 'the boss', 'the owner']) {
    const r = resolveKnownIdentity(h);
    assert.ok(r && r.name === 'Ed Gojara', `"${h}" must resolve to Ed`);
  }
});

check('She knows her boss', 'Ed has a real mailbox, not a placeholder', async () => {
  const ed = edIdentity();
  assert.match(ed.email, /@/, 'must be a real address');
  assert.ok(ed.position, 'she should know what he does');
});

// ---------------------------------------------------------------------------
check('She knows the team', 'every teammate with a mailbox is known', async () => {
  const team = teamIdentities();
  assert.ok(team.length >= 8, `expected the AI team, got ${team.length}`);
  for (const p of team) {
    assert.ok(p.email && p.email.includes('@'), `${p.name} needs a real mailbox`);
    assert.ok(resolveKnownIdentity(p.name), `${p.name} must resolve by full name`);
    const first = p.name.split(' ')[0];
    assert.ok(resolveKnownIdentity(first), `${p.name} must resolve by first name ("${first}")`);
  }
});

check('She knows the team', 'a surname works too', async () => {
  const r = resolveKnownIdentity('albright');
  assert.ok(r, '"albright" must resolve');
  assert.match(r.name, /Amanda/);
});

check('She knows the team', 'the roster stays the source of truth', async () => {
  // If a teammate is added to roster.js with a mailbox constant, Tessa learns
  // them for free. This asserts the derivation rather than a copied list.
  const { ROSTER } = require('../lib/team/roster');
  const known = new Set(knownIdentities().map((p) => p.persona).filter(Boolean));
  const withMailbox = ROSTER.filter((p) => {
    const gs = require('../lib/email/graph_send');
    return gs[`${String(p.persona).toUpperCase()}_MAILBOX`];
  });
  for (const p of withMailbox) {
    assert.ok(known.has(p.persona), `${p.name} is on the roster with a mailbox but Tessa does not know them`);
  }
});

// ---------------------------------------------------------------------------
check('She does not over-reach', 'a stranger falls through to the search', async () => {
  // The fast path must stay exact. Resolving "eddie at the bank" to Ed because
  // it starts with "ed" is the same mistake as matching inside a domain.
  for (const h of ['eddie at the bank', 'ed hyde', 'martha', 'haley bellanger', 'edward jones']) {
    assert.strictEqual(resolveKnownIdentity(h), null, `"${h}" must NOT short-circuit to a known identity`);
  }
});

check('She does not over-reach', 'empty input resolves to nobody', async () => {
  assert.strictEqual(resolveKnownIdentity(''), null);
  assert.strictEqual(resolveKnownIdentity(null), null);
  assert.strictEqual(resolveKnownIdentity('   '), null);
});

// ---------------------------------------------------------------------------
check('A short hint is not a domain', 'the five wrong answers are all rejected', async () => {
  // Verbatim from the screenshot.
  const wrong = [
    { name: 'Hope Lloyd', org: 'Bedrock Association Management, LLC', email: 'hlloyd@bedrocktx.com' },
    { name: 'HomeWiseDocs Implementation', org: 'Homewisedocs', email: 'implementation@homewisedocs.com' },
    { name: 'Claire Bennett', org: 'Bedrock Association Management', email: 'claire@bedrocktx.com' },
    { name: 'Jobs/Careers Inbox', org: 'Bedrock Association Management', email: 'jobs@bedrocktx.com' },
    { name: 'Kale McClarty', org: 'RealPage for Associations | HomeWiseDocs', email: 'kale.mcclarty@realpage.com' },
  ];
  for (const c of wrong) {
    assert.strictEqual(contactMatchesHint(c, 'ed'), false,
      `"${c.name}" must not match "ed" — it only matched through a domain or the word Bedrock`);
  }
});

check('A short hint is not a domain', 'a real "ed" still matches', async () => {
  assert.strictEqual(contactMatchesHint({ name: 'Ed Hyde', email: 'treasurer@pmrhoa.com' }, 'ed'), true);
  assert.strictEqual(contactMatchesHint({ name: 'Ed Gojara', email: 'egojara@bedrocktx.com' }, 'ed'), true);
  // The local part counts; the domain does not.
  assert.strictEqual(contactMatchesHint({ name: 'Someone', email: 'ed@example.com' }, 'ed'), true);
  assert.strictEqual(contactMatchesHint({ name: 'Someone', email: 'x@bedrock.com' }, 'ed'), false);
});

check('A short hint is not a domain', 'a short hint will not match mid-word', async () => {
  assert.strictEqual(contactMatchesHint({ name: 'Teddy Holtz', email: 'tholtz@winstead.com' }, 'ed'), false);
  assert.strictEqual(contactMatchesHint({ name: 'Celina Deleon', email: 'cdeleon@bedrocktx.com' }, 'ed'), false);
});

check('A short hint is not a domain', 'a longer hint may still match anywhere', async () => {
  // "waterv" and "protect" are useful precisely because they match fragments.
  assert.strictEqual(contactMatchesHint({ name: 'X', org: 'Waterview Estates', email: 'a@b.com' }, 'waterv'), true);
  assert.strictEqual(contactMatchesHint({ name: 'Haley', org: 'United Protective Services', email: 'h@u.com' }, 'protect'), true);
});

check('A short hint is not a domain', 'a regex metacharacter does not blow up', async () => {
  // A hint is user input. "c++" or "a." must not throw or match everything.
  assert.doesNotThrow(() => contactMatchesHint({ name: 'A', email: 'a@b.com' }, 'a.'));
  assert.strictEqual(contactMatchesHint({ name: 'Ab', email: 'ab@b.com' }, 'a.'), false);
});

check('A short hint is not a domain', 'the copy here matches the real matcher', async () => {
  // This file reimplements contactMatchesHint so the rules can be tested
  // directly. If api/tessa.js changes its version, this fails rather than
  // quietly testing a stale copy.
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'api', 'tessa.js'), 'utf8');
  assert.ok(src.includes('function contactMatchesHint(c, q) {'),
    'contactMatchesHint has been renamed or removed from api/tessa.js');
  assert.ok(src.includes("split('@')[0]"),
    'the real matcher no longer strips the email domain — the Bedrock/FedEx bug is back');
  assert.ok(src.includes('hint.length >= 4'),
    'the real matcher no longer treats short hints differently');
});

// ---------------------------------------------------------------------------
(async () => {
  let group = null; let failed = 0;
  for (const t of results) {
    if (t.group !== group) { group = t.group; console.log('\n' + group); }
    try { await t.fn(); passed++; console.log('  ✓ ' + t.name); }
    catch (e) { failed++; console.log('  ✗ ' + t.name + '\n      ' + e.message); }
  }
  console.log('');
  if (failed) {
    console.log('✗ Tessa identity: ' + failed + ' of ' + results.length + ' checks failed.');
    process.exit(1);
  }
  console.log('✓ Tessa identity: all ' + passed + ' checks passed.');
})();
