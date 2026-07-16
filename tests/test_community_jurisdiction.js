// ============================================================================
// tests/test_community_jurisdiction.js  (Ed 2026-07-16)
// ----------------------------------------------------------------------------
// A reply that points a homeowner at "the city" or "the county" must point at
// the RIGHT one. Ed: "waterview eaglewood still creek august meadows quail ridge
// are not in city limits they are county only."
//
// The mailing city is not the jurisdiction: August Meadows mails to "Needville"
// but sits in unincorporated Fort Bend County, so a noise ordinance there is the
// county's, not Needville's. And a model reading a "Houston" address will guess
// Harris County when the community is really Fort Bend, unless we hand it the
// county. These are pure-logic assertions on that mapping.
//
// Run: npm run test:jurisdiction
// ============================================================================
const { communityJurisdiction } = require('../lib/community_jurisdiction');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  else { failures++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`); }
};

console.log('\n\x1b[1mCommunity jurisdiction — point at the right government\x1b[0m\n');

// County-only, county known.
const eaglewood = communityJurisdiction({ name: 'Eaglewood', in_city_limits: false, declaration_county: 'Fort Bend' });
check('unincorporated community names its county', /Fort Bend County/.test(eaglewood.sentence));
check('  ...and says NOT a city', /not a city/i.test(eaglewood.sentence));

// The trap: a mailing-city address that is NOT the jurisdiction.
const augustMeadows = communityJurisdiction({ name: 'August Meadows', in_city_limits: false, city: 'Needville', county: 'Fort Bend' });
check('a county-only community with a mailing city does NOT name that city', !/City of Needville|contact Needville/i.test(augustMeadows.sentence) && /Fort Bend County/.test(augustMeadows.sentence), augustMeadows.sentence);

// Inside city limits.
const inCity = communityJurisdiction({ name: 'X', in_city_limits: true, city: 'Sugar Land' });
check('an in-city community names the city', /City of Sugar Land/.test(inCity.sentence));

// Unconfirmed but county known — the pre-migration / to-be-checked case (Lakes
// of Pine Forest, Canyon Gate). Name the county, DON'T guess a city, DON'T guess
// a different county.
const unconfirmed = communityJurisdiction({ name: 'Lakes of Pine Forest', in_city_limits: null, county: 'Harris' });
check('unconfirmed-but-county-known names the county', /Harris County/.test(unconfirmed.sentence));
check('  ...and does NOT assert a specific city', /do NOT assert a specific CITY|not.*city/i.test(unconfirmed.sentence));

// Nothing known — fully generic, no guess at all.
const blank = communityJurisdiction({ name: 'Y', in_city_limits: null });
check('with nothing on record, names no specific city or county', !/Fort Bend|Harris|City of/i.test(blank.sentence), blank.sentence);

console.log('');
if (failures) { console.log(`\x1b[31m\x1b[1m✗ ${failures} check(s) failed.\x1b[0m\n`); process.exitCode = 1; }
else console.log('\x1b[32m\x1b[1m✓ Community jurisdiction: all checks passed.\x1b[0m\n');
