// ============================================================================
// lib/lookups/principal.js  (Ed 2026-11-27: one trustEd intelligence, access by audience)
// ----------------------------------------------------------------------------
// WHO is asking, as data. Every shared lookup (lib/lookups/index.js) takes a
// principal and refuses anything outside it, in code, before any data is read.
// A persona's prompt is never the control (Ed: "Do not rely on personality
// prompts to prevent disclosure of sensitive information").
//
//   kind          owner | board | staff | homeowner
//   communities   'all' or [community_id]       which associations
//   properties    'all' or [property_id]        which lots (homeowner: their own)
//   capabilities  Set of what this principal may read (CAPABILITIES below)
//
// Issued today: OWNER (Talk to Amanda, Amanda's phone line after a code), HOMEOWNER
// (portal Claire from the signed portal session; phone Claire after a code to the
// owner's number on file), STAFF (Amanda's phone line after a code to the
// employee's number on file). Board is defined, not yet issued. Issuing one is the only way
// to widen access, and each issuer must derive it from an authenticated
// identity (requireOwner, requireBoardViewer, the portal cookie), never from
// anything the model or the caller says.
// ============================================================================

const CAPABILITIES = Object.freeze({
  homeowner_search: 'find a homeowner by name, address, email or phone',
  homeowner_record: 'one homeowner: contact details, properties, balance, violations, ACC, correspondence',
  my_account: 'the signed-in homeowner own lot: property, balance, violations, ACC, correspondence (homeowner-facing fields only)',
  homeowner_ledger: 'one homeowner\'s transaction history',
  collections: 'collection / legal / bankruptcy status (staff-only data)',
  governing_documents: 'governing documents and Texas law',
  community_info: 'community calendar, meetings, amenity availability and the portal tiles that are live',
  association_profile: 'an association as management sees it: size, board, amenities, documents, vendors, receivables, enforcement and open work',
  association_financials: 'balance sheet, income vs budget',
  association_ar: 'association receivables: totals and largest balances',
  vendors: 'vendors, contracts, open payables',
});

class AccessError extends Error {
  constructor(message, detail) { super(message); this.code = 'forbidden'; this.detail = detail || null; }
}

const ALL = Object.keys(CAPABILITIES);

function freeze(p) {
  return Object.freeze({ ...p, capabilities: Object.freeze(new Set(p.capabilities)) });
}

/** The owner (Ed), from requireOwner's user. Portfolio-wide, everything. */
function ownerPrincipal(u) {
  if (!u || !u.user || !u.user.id) throw new AccessError('no authenticated owner');
  return freeze({ kind: 'owner', user_id: u.user.id, name: u.full_name || null, communities: 'all', properties: 'all', capabilities: ALL });
}

/**
 * A board member, from lib/portal/board_access resolveBoardViewer (kind 'board').
 * Their associations only; association-level reads, no individual homeowner
 * records (the board portal's existing aggregate-only rule). NOT ISSUED YET.
 */
function boardPrincipal(viewer) {
  if (!viewer || viewer.kind !== 'board' || !Array.isArray(viewer.communityIds)) throw new AccessError('no authenticated board member');
  return freeze({ kind: 'board', user_id: viewer.userId || null, name: viewer.name || null, communities: [...viewer.communityIds], properties: [], capabilities: ['governing_documents', 'community_info', 'association_profile', 'association_financials', 'association_ar', 'vendors'] });
}

/**
 * A Bedrock employee, from an active trustEd user (user_profiles staff role) whose identity was
 * proven on the phone by a code sent to the number on their own record (lib/verification).
 * Everything the staff app shows them today, portfolio-wide. Issued by lib/phone only.
 */
function staffPrincipal({ user_id, name = null, verified }) {
  if (!user_id || !verified) throw new AccessError('no verified staff member');
  return freeze({ kind: 'staff', user_id, name, communities: 'all', properties: 'all', capabilities: ALL });
}

/**
 * A homeowner on the PHONE: their own lot only, and only from a branded verification minted by
 * lib/voice/private_gate after the code check passed (an id in a request can never stand in).
 * Same capabilities as the portal homeowner principal.
 */
function phoneHomeownerPrincipal({ ctx, communityId, financials = false }) {
  const pid = require('../voice/private_gate').phoneVerifiedPropertyId(ctx);
  if (!pid || !communityId) throw new AccessError('no verified homeowner on this call');
  return homeownerPrincipal({ portalUserId: `phone:${pid}`, communityId, propertyIds: [pid], financials });
}

/** A homeowner, from the portal's own property resolution. Their lots only. */
function homeownerPrincipal({ portalUserId, communityId, propertyIds, financials = false }) {
  if (!portalUserId || !communityId || !Array.isArray(propertyIds) || !propertyIds.length) throw new AccessError('no authenticated homeowner');
  const caps = ['my_account', 'governing_documents', 'community_info'];
  if (financials) caps.push('homeowner_ledger');
  return freeze({ kind: 'homeowner', user_id: portalUserId, name: null, communities: [communityId], properties: [...propertyIds], capabilities: caps });
}

function require_(p, capability) {
  if (!p || !p.capabilities) throw new AccessError('no principal');
  if (!p.capabilities.has(capability)) throw new AccessError(`not authorized for ${capability}`, { capability, kind: p.kind });
}
function canCommunity(p, communityId) {
  return !!p && (p.communities === 'all' || (!!communityId && p.communities.includes(communityId)));
}
function canProperty(p, { property_id, community_id }) {
  if (!canCommunity(p, community_id)) return false;
  return p.properties === 'all' || (!!property_id && p.properties.includes(property_id));
}
function assertCommunity(p, communityId) {
  if (!canCommunity(p, communityId)) throw new AccessError('that association is outside your access', { community_id: communityId });
}
function assertProperty(p, where) {
  if (!canProperty(p, where)) throw new AccessError('that property is outside your access', where);
}

module.exports = { CAPABILITIES, AccessError, ownerPrincipal, boardPrincipal, homeownerPrincipal, staffPrincipal, phoneHomeownerPrincipal, require: require_, canCommunity, canProperty, assertCommunity, assertProperty };
