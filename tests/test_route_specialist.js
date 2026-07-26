// Tests for lib/email/route_specialist.js — the content-router that suggests
// handing a homeowner email off to the right specialist instead of Claire
// answering out of her lane.
const assert = require('assert');
const { routeSpecialist } = require('../lib/email/route_specialist');

let pass = 0;
function is(desc, got, want) {
  assert.strictEqual(got, want, `${desc}: expected ${want}, got ${got}`);
  pass++;
}

// Specialist lanes route to the right person.
is('estoppel → reese', routeSpecialist({ bodyText: 'Please send the estoppel certificate for closing on 123 Oak.' })?.persona, 'reese');
is('title company → reese', routeSpecialist({ subject: 'Resale certificate request', bodyText: 'Our title company needs the transfer package.' })?.persona, 'reese');
is('violation dispute → miranda', routeSpecialist({ bodyText: 'This violation is wrong, I already fixed the fence last week. Please remove the fine.' })?.persona, 'miranda');
is('cure extension → miranda', routeSpecialist({ bodyText: 'Can I get an extension on the cure deadline for my grass?' })?.persona, 'miranda');
is('acc_request classification → annie', routeSpecialist({ classification: 'acc_request', bodyText: 'anything' })?.persona, 'annie');
is('architectural keyword → annie', routeSpecialist({ bodyText: 'I want to submit an application for a new fence and request approval to install it.' })?.persona, 'annie');
is('board matter → paige', routeSpecialist({ bodyText: 'How do I run for the board? When is the next board meeting?' })?.persona, 'paige');
is('payment plan → kat', routeSpecialist({ bodyText: 'Can I set up a payment plan for my past due assessments?' })?.persona, 'kat');
is('autopay → kat', routeSpecialist({ bodyText: 'How do I set up autopay for my dues?' })?.persona, 'kat');
is('disputed charge → kat', routeSpecialist({ bodyText: 'I think I was double charged and want a refund.' })?.persona, 'kat');

// Claire keeps general front-office mail (null = no handoff).
is('greeting stays with Claire', routeSpecialist({ bodyText: 'Hi, we just moved in — how do we get pool access?' }), null);
is('trash question stays with Claire', routeSpecialist({ bodyText: 'What day is trash pickup?' }), null);
is('simple balance question stays with Claire', routeSpecialist({ bodyText: 'What is my current balance?' }), null);
is('empty stays with Claire', routeSpecialist({ bodyText: '' }), null);

// Priority: a resale request mentioning a balance is Reese's, not Kat's.
is('resale beats accounting', routeSpecialist({ bodyText: 'Title company needs the resale certificate and the current balance for closing.' })?.persona, 'reese');

// Shape check.
const r = routeSpecialist({ bodyText: 'Please send the estoppel for closing.' });
assert.ok(r.name && r.title && r.reason, 'route object carries name/title/reason');
pass++;

console.log(`route_specialist: ${pass} assertions passed`);
