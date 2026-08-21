// ============================================================================
// tests/test_presentation_mode.js — demo a real community, protect real people.
// ----------------------------------------------------------------------------
// Ed 2026-08-21: "i need to be able to maintain privacy for the homeowners if we
// go that route."
//
// The route: demo bankers on Waterview rather than the fictional community.
// Drama Creek's map cannot honestly be shown at all (its coordinates land on
// real houses near Austin belonging to strangers) and everything else about it
// is invented. Waterview is genuinely impressive, and the impressive parts —
// streets, the clubhouse, the pool — are public information. What is NOT public
// is a named person and their money.
//
// Ed also said "let's be careful not to break anything," and every assertion
// below exists because of that sentence:
//
//   OFF IS EXACTLY TODAY      no flag, no work, byte-for-byte the same response
//   FAIL CLOSED ON INTENT     an explicit ask by a non-staff caller is refused,
//                             never quietly served the real thing
//   A STALE COOKIE IS IGNORED refusing a homeowner because of a leftover cookie
//                             would lock them out of their own portal
//   SUPPRESS, NEVER FABRICATE a masked balance is blank, not a realistic
//                             invented number Ed could quote in good faith
//   NAVIGATION SURVIVES       ids, slugs and community names stay readable or
//                             the demo shows nothing at all
// ============================================================================
const assert = require('assert');
const { presentationMode, redact, requestedMode } = require('../api/_presentation_mode');

let passed = 0;
const results = [];
const check = (group, name, fn) => results.push({ group, name, fn });

function mkRes() {
  const r = { code: 200, body: null, headers: {}, ended: false };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; r.ended = true; return r; };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  return r;
}
function mkReq({ query = {}, cookie = null, header = null } = {}) {
  return {
    query,
    headers: cookie ? { cookie } : {},
    get: (h) => (h === 'X-Bedrock-Presentation' ? header : null),
  };
}
const asRole = (role) => async () => (role ? { user: { role } } : null);

// A response shaped like the ones the portal actually returns.
const realish = () => ({
  property: {
    id: 'p-1', street_address: '2318 Waterview Cove Dr', community_id: 'c-1',
    owner_name: 'Martha Villanueva',
    contacts: { full_name: 'Martha Villanueva', primary_email: 'martha@example.com', primary_phone: '281-555-0134' },
  },
  balance: 412.5,
  balance_cents: 41250,
  community: { id: 'c-1', name: 'Waterview Estates', slug: 'waterview' },
  amenities: [{ id: 'a-1', name: 'Clubhouse', capacity: 120 }],
  vendors: [{ id: 'v-1', name: 'Superior LawnCare', contact_name: 'Joe Ruiz', email: 'joe@superior.com' }],
  documents: [{ id: 'd-1', title: 'Declaration of Covenants' }],
});

// ---------------------------------------------------------------------------
check('Off is exactly today', 'no flag means the middleware does nothing', async () => {
  let resolverCalled = false;
  const mw = presentationMode(async () => { resolverCalled = true; return { user: { role: 'manager' } }; });
  const res = mkRes(); let nexted = false;
  await mw(mkReq(), res, () => { nexted = true; });
  assert.strictEqual(nexted, true, 'the request must continue');
  assert.strictEqual(resolverCalled, false, 'no flag must cost not even a role lookup');
  res.json(realish());
  assert.strictEqual(res.body.property.owner_name, 'Martha Villanueva', 'untouched');
  assert.strictEqual(res.body.balance, 412.5, 'untouched');
  assert.strictEqual(res.body._presentation, undefined, 'no marker added');
});

// ---------------------------------------------------------------------------
check('Fail closed on intent', 'an explicit ask by an anonymous caller is refused', async () => {
  const mw = presentationMode(asRole(null));
  const res = mkRes(); let nexted = false;
  await mw(mkReq({ query: { present: '1' } }), res, () => { nexted = true; });
  assert.strictEqual(res.code, 403);
  assert.strictEqual(nexted, false, 'the request must not reach the handler');
  assert.strictEqual(res.body.error, 'presentation_mode_staff_only');
});

check('Fail closed on intent', 'an explicit ask by a homeowner is refused', async () => {
  const mw = presentationMode(asRole('homeowner'));
  const res = mkRes(); let nexted = false;
  await mw(mkReq({ query: { present: '1' } }), res, () => { nexted = true; });
  assert.strictEqual(res.code, 403);
  assert.strictEqual(nexted, false);
});

check('Fail closed on intent', 'the header counts as an explicit ask', async () => {
  assert.strictEqual(requestedMode(mkReq({ header: '1' })), 'explicit');
  assert.strictEqual(requestedMode(mkReq({ query: { present: '1' } })), 'explicit');
});

check('Fail closed on intent', 'a role lookup that throws does not open the door', async () => {
  const mw = presentationMode(async () => { throw new Error('db down'); });
  const res = mkRes(); let nexted = false;
  await mw(mkReq({ query: { present: '1' } }), res, () => { nexted = true; });
  assert.strictEqual(res.code, 403, 'an unknown role is not a staff role');
  assert.strictEqual(nexted, false);
});

// ---------------------------------------------------------------------------
check('A stale cookie is ignored', 'a homeowner keeps their own portal', async () => {
  // The cookie outlives the intent: Ed hands the laptop back, or an owner signs
  // in on the same browser. 403-ing them here would be a real outage, and
  // ignoring it exposes nothing — an owner only ever sees their own data.
  const mw = presentationMode(asRole('homeowner'));
  const res = mkRes(); let nexted = false;
  await mw(mkReq({ cookie: 'bedrock_presentation=1' }), res, () => { nexted = true; });
  assert.strictEqual(nexted, true, 'the homeowner must not be locked out');
  assert.strictEqual(res.code, 200);
  res.json(realish());
  assert.strictEqual(res.body.property.owner_name, 'Martha Villanueva',
    'their own data is theirs to see');
});

check('A stale cookie is ignored', 'but staff holding it are masked', async () => {
  const mw = presentationMode(asRole('manager'));
  const res = mkRes();
  await mw(mkReq({ cookie: 'bedrock_presentation=1' }), res, () => {});
  res.json(realish());
  assert.strictEqual(res.body.property.owner_name, 'Homeowner');
});

check('A stale cookie is ignored', 'an unrelated cookie is not a flag', async () => {
  assert.strictEqual(requestedMode(mkReq({ cookie: 'other=1; bedrock_portal=abc' })), null);
  assert.strictEqual(requestedMode(mkReq({ cookie: 'bedrock_presentation=0' })), null);
  assert.strictEqual(requestedMode(mkReq({ cookie: 'bedrock_presentation=1' })), 'cookie');
});

// ---------------------------------------------------------------------------
check('What gets masked', 'identity goes, navigation stays', async () => {
  const out = redact(realish());
  assert.strictEqual(out.property.owner_name, 'Homeowner');
  assert.strictEqual(out.property.contacts.full_name, 'Homeowner');
  assert.strictEqual(out.property.contacts.primary_email, 'hidden@privacy');
  assert.strictEqual(out.property.contacts.primary_phone, '—');

  // Navigation and the things that make the demo worth showing.
  assert.strictEqual(out.property.id, 'p-1');
  assert.strictEqual(out.property.community_id, 'c-1');
  assert.strictEqual(out.community.name, 'Waterview Estates', 'the community name must survive');
  assert.strictEqual(out.community.slug, 'waterview');
  assert.strictEqual(out.amenities[0].name, 'Clubhouse', 'amenity names must survive');
  assert.strictEqual(out.vendors[0].name, 'Superior LawnCare', 'vendor businesses must survive');
  assert.strictEqual(out.documents[0].title, 'Declaration of Covenants');
});

check('What gets masked', 'the street address stays, because it is public', async () => {
  // Anyone can see the street on a map. It is the NAME against it that is not
  // public, and that is gone.
  const out = redact(realish());
  assert.strictEqual(out.property.street_address, '2318 Waterview Cove Dr');
});

check('What gets masked', 'a vendor rep is not labelled a homeowner', async () => {
  const out = redact(realish());
  assert.strictEqual(out.vendors[0].contact_name, 'Name hidden');
  assert.strictEqual(out.vendors[0].email, 'hidden@privacy');
});

check('What gets masked', 'an email is caught wherever it is nested', async () => {
  // Some endpoints emit `name: user.email`. A key-name list alone would miss it.
  const out = redact({ user: { name: 'egojara@bedrocktx.com', role: 'manager' } });
  assert.strictEqual(out.user.name, 'hidden@privacy');
});

// ---------------------------------------------------------------------------
check('Suppress, never fabricate', 'money is blanked, not invented', async () => {
  const out = redact(realish());
  assert.strictEqual(out.balance, null, 'a masked balance must be empty');
  assert.strictEqual(out.balance_cents, null);
  // The failure this prevents: a realistic fake number Ed quotes to a banker in
  // good faith. A visible blank cannot mislead; a plausible figure can.
  assert.notStrictEqual(out.balance, 412.5);
  assert.strictEqual(typeof out.balance, 'object', 'null, not a number');
});

check('Suppress, never fabricate', 'redaction failure sends nothing rather than the truth', async () => {
  const mw = presentationMode(asRole('manager'));
  const res = mkRes();
  await mw(mkReq({ query: { present: '1' } }), res, () => {});
  // A getter that throws stands in for any shape the walker cannot handle.
  const hostile = {};
  Object.defineProperty(hostile, 'boom', { enumerable: true, get() { throw new Error('nope'); } });
  res.json(hostile);
  assert.strictEqual(res.body.error, 'presentation_redaction_failed',
    'if masking fails, the real payload must not go out instead');
});

// ---------------------------------------------------------------------------
check('Safety of the walker', 'the caller\'s own object is not mutated', async () => {
  const src = realish();
  redact(src);
  assert.strictEqual(src.property.owner_name, 'Martha Villanueva',
    'redact must copy, never edit the row the rest of the handler still holds');
  assert.strictEqual(src.balance, 412.5);
});

check('Safety of the walker', 'a cycle does not hang the request', async () => {
  const a = { full_name: 'Someone' };
  a.self = a;
  const out = redact(a);
  assert.strictEqual(out.full_name, 'Homeowner');
});

check('Safety of the walker', 'null and empty payloads pass through', async () => {
  assert.strictEqual(redact(null), null);
  assert.strictEqual(redact(undefined), undefined);
  assert.deepStrictEqual(redact({}), {});
  assert.deepStrictEqual(redact([]), []);
});

check('Safety of the walker', 'the marker rides on objects, not arrays', async () => {
  const mw = presentationMode(asRole('manager'));
  const res = mkRes();
  await mw(mkReq({ query: { present: '1' } }), res, () => {});
  res.json([{ full_name: 'A Person' }]);
  assert.ok(Array.isArray(res.body), 'an array response must stay an array');
  assert.strictEqual(res.body[0].full_name, 'Homeowner');
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
    console.log('✗ Presentation mode: ' + failed + ' of ' + results.length + ' checks failed.');
    process.exit(1);
  }
  console.log('✓ Presentation mode: all ' + passed + ' checks passed.');
})();
