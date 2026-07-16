// ============================================================================
// lib/community_jurisdiction.js  (Ed 2026-07-16)
// ----------------------------------------------------------------------------
// Which government body actually has jurisdiction over a community — so a reply
// that points a homeowner at "the city" or "the county" points at the RIGHT one.
//
// The mailing city is not the jurisdiction. Waterview, Eaglewood, Still Creek,
// August Meadows, and Quail Ridge are unincorporated county despite their
// mailing-city addresses; a noise ordinance or a nuisance complaint there is the
// county's, not a city's. (migration 303 in_city_limits.)
//
// Honest about what it doesn't know: when in_city_limits is NULL/absent, it says
// to confirm the jurisdiction rather than assert a city — a confident wrong
// answer ("call the City of Needville") is worse than "we'll confirm."
// ============================================================================

/**
 * @param {{ in_city_limits?:boolean|null, city?:string, county?:string, declaration_county?:string, name?:string }} community
 * @returns {{ known:boolean, in_city_limits:boolean|null, body:string, sentence:string }}
 *   body     — a short phrase for the right agency ("Fort Bend County")
 *   sentence — a ready one-liner Claire can adapt, or a "confirm first" note
 */
function communityJurisdiction(community) {
  const c = community || {};
  const county = (c.county || c.declaration_county || '').trim();
  const city = (c.city || '').trim();

  if (c.in_city_limits === false) {
    const body = county ? `${county} County` : 'the county';
    return {
      known: true, in_city_limits: false, body,
      sentence: `This community is in an unincorporated area, so ${body} (not a city) handles noise ordinances, nuisance complaints, and law enforcement here. The mailing address city does not have jurisdiction.`,
    };
  }
  if (c.in_city_limits === true) {
    const body = city ? `the City of ${city}` : 'the city';
    return {
      known: true, in_city_limits: true, body,
      sentence: `This community is inside ${body}'s limits, so ${body} handles local ordinances and enforcement.`,
    };
  }
  // Unknown / not yet confirmed. We may still know the COUNTY even if the
  // city-limits status isn't recorded — give it, so a reply names the RIGHT
  // county instead of guessing from the mailing address (a "Houston" address
  // makes a model reach for Harris when the community is actually Fort Bend).
  if (county) {
    return {
      known: false, in_city_limits: null, body: `${county} County`,
      sentence: `This community is in ${county} County. It has NOT been confirmed whether it sits inside a city's limits or is unincorporated. If you point the owner to a local government, name ${county} County (do NOT guess a different county, and do NOT assert a specific CITY has jurisdiction). If a city ordinance might matter, say the team will confirm which agency applies.`,
    };
  }
  return {
    known: false, in_city_limits: null, body: 'your local government',
    sentence: `This community's jurisdiction is not on record. Do NOT name a specific city or county. Say "your local county or city" generally, or that the team will confirm which agency applies.`,
  };
}

module.exports = { communityJurisdiction };
