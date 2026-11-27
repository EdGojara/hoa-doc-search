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
// Only the OWNER principal is issued today (Talk to Amanda). Board, staff and
// homeowner principals are defined so their scope is explicit, but no surface
// hands them out until Ed approves that expansion. Issuing one is the only way
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
  return freeze({ kind: 'board', user_id: viewer.userId || null, name: viewer.name || null, communities: [...viewer.communityIds], properties: [], capabilities: ['governing_documents', 'community_info', 'association_financials', 'association_ar', 'vendors'] });
}

/** A homeowner, from the portal's own property resolution. Their lots only. NOT ISSUED YET. */
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

module.exports = { CAPABILITIES, AccessError, ownerPrincipal, boardPrincipal, homeownerPrincipal, require: require_, canCommunity, canProperty, assertCommunity, assertProperty };
