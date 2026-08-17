// ============================================================================
// lib/claire/scope.js  (Ed 2026-08-16)
// ----------------------------------------------------------------------------
// WHO IS AT THE DOOR.
//
// Virtual Claire has three audiences — homeowners, board members, staff — and
// they are NOT three Claires. Building a second reasoning path per audience is
// the parallel-silo failure this codebase has already paid for twice (vector vs
// keyword retrieval; per-surface search). There is ONE Claire. What changes per
// visitor is (a) which communities she can see, (b) which property is "theirs",
// and (c) what she is permitted to do — never how she thinks.
//
// This module is the single gate that answers "who is this." Every Claire
// surface calls resolveVisitor() and gets one normalized shape back. No endpoint
// re-derives identity from the request, and no endpoint trusts a client-supplied
// community_id without running it through canAccessCommunity().
//
// It deliberately reuses the three auth systems that already exist rather than
// minting a fourth:
//   staff  → Supabase JWT / staff portal session   (api/_acting_user)
//   board  → board magic-link session, seat-scoped (lib/portal/board_access)
//   owner  → homeowner portal cookie               (api/portal resolvePortalUser)
// ============================================================================
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// How long a single visit may run before the server ends it, per role. This is
// the cost kill switch, not a UX preference: a streaming photoreal avatar bills
// by the minute, so a forgotten open tab is a bill. Staff/board get longer
// because their sessions are working sessions; a homeowner question is short by
// nature and can always be extended by a human.
const SECONDS_CAP = Object.freeze({ homeowner: 600, board: 1800, staff: 1800 });

/**
 * Resolve the visitor across all three doors. Returns null when nobody is
 * signed in — Claire is never anonymous, because an anonymous face that answers
 * questions about a specific community is a data-leak surface.
 *
 * Shape:
 *   { role, name, email, communityIds: 'all' | [uuid], propertyId, portalUserId,
 *     staffUserId, secondsCap, actingAs }
 */
async function resolveVisitor(req) {
  // 0) MIMIC WINS, ALWAYS. When a staffer is viewing the platform as a specific
  //    homeowner or board member, they must see exactly what that person sees
  //    and nothing more.
  //
  //    This runs FIRST for a reason that is not cosmetic. Ed used "view as" on a
  //    Waterview board member to check that community isolation held, and Claire
  //    showed her a picker containing all eight communities — because the staff
  //    check below ran first, matched his own session, and returned scope 'all'.
  //    The isolation was in fact fine; the TEST was lying. A view-as that does
  //    not constrain the view is worse than having none, because it is used
  //    precisely when someone is trying to verify a boundary and it answers with
  //    false confidence.
  const mimicked = await _mimickedVisitor(req);
  if (mimicked) return mimicked;

  // 1) Staff and board both resolve through the board-access gate, which already
  //    understands staff JWTs, staff portal sessions, board seats, and staff
  //    "view as" down-scoping. Reusing it means the Claire door can never drift
  //    from the board portal's notion of who may see what.
  let viewer = null;
  try {
    const { resolveBoardViewer } = require('../portal/board_access');
    viewer = await resolveBoardViewer(req);
  } catch (err) {
    console.warn('[claire/scope] board viewer resolve failed:', err.message);
  }

  if (viewer && viewer.kind === 'staff') {
    return {
      role: 'staff',
      name: viewer.name || viewer.email,
      email: viewer.email,
      communityIds: 'all',
      propertyId: null,
      portalUserId: null,
      staffUserId: null,
      secondsCap: SECONDS_CAP.staff,
      actingAs: viewer.acting_as || null,
    };
  }

  if (viewer && viewer.kind === 'board') {
    // A board member is also a homeowner. Attach their own property when their
    // portal session carries one, so "what's my balance" works in the same visit
    // as "what's the reserve position" — one login, two lenses.
    const own = await _ownProperty(req);
    return {
      role: 'board',
      name: viewer.name || viewer.email,
      email: viewer.email,
      communityIds: [...(viewer.scope || [])],
      propertyId: own.propertyId,
      portalUserId: own.portalUserId,
      staffUserId: null,
      secondsCap: SECONDS_CAP.board,
      actingAs: viewer.acting_as || null,
    };
  }

  // 2) Homeowner — the portal cookie.
  const own = await _ownProperty(req);
  if (!own.portalUserId) return null;
  return {
    role: 'homeowner',
    name: own.name,
    email: own.email,
    communityIds: own.communityId ? [own.communityId] : [],
    propertyId: own.propertyId,
    portalUserId: own.portalUserId,
    staffUserId: null,
    secondsCap: SECONDS_CAP.homeowner,
    actingAs: own.mimic ? { mimic: true } : null,
  };
}

/**
 * When a staff "view as" mimic cookie is active, resolve the visitor as the
 * MIMICKED person and never as staff. Returns null when no mimic is in play.
 *
 * The mimicked user is scoped the same way a real sign-in would be: their board
 * seats if they hold any (a homeowner who sits on a board is both), otherwise
 * their own property and community. Nothing here can widen to 'all'.
 */
async function _mimickedVisitor(req) {
  const own = await _ownProperty(req);
  if (!own.portalUserId || !own.mimic) return null;

  const seats = await _boardSeats(own.email);
  const isBoard = seats.length > 0;
  return {
    role: isBoard ? 'board' : 'homeowner',
    name: own.name,
    email: own.email,
    communityIds: isBoard ? seats : (own.communityId ? [own.communityId] : []),
    propertyId: own.propertyId,
    portalUserId: own.portalUserId,
    staffUserId: null,
    secondsCap: isBoard ? SECONDS_CAP.board : SECONDS_CAP.homeowner,
    actingAs: { mimic: true, by: own.mimic.email || null },
  };
}

/** Community ids where this email holds an active board seat. Never throws. */
async function _boardSeats(email) {
  if (!email) return [];
  try {
    const { boardCommunitiesForEmail } = require('../portal/board_access');
    return [...(await boardCommunitiesForEmail(email))];
  } catch (err) {
    // Deny rather than widen: an unreadable seat list must never fall back to
    // "everything", it falls back to "just their own property".
    console.warn('[claire/scope] board seat lookup failed:', err.message);
    return [];
  }
}

// The homeowner's own identity + property from the portal cookie. Returns an
// all-null shape when there's no valid portal session (never throws — a missing
// cookie is the normal case for a staff visitor).
async function _ownProperty(req) {
  const empty = { portalUserId: null, propertyId: null, communityId: null, name: null, email: null, mimic: null };
  let portalUserId = null, mimic = null;
  try {
    const { resolvePortalUser } = require('../../api/portal');
    ({ portalUserId, mimic } = resolvePortalUser(req) || {});
  } catch (err) {
    console.warn('[claire/scope] portal user resolve failed:', err.message);
  }
  if (!portalUserId) return empty;

  const { data: u, error } = await supabase
    .from('portal_users')
    .select('id, email, full_name, status')
    .eq('id', portalUserId)
    .maybeSingle();
  if (error) { console.warn('[claire/scope] portal_users read failed:', error.message); return empty; }
  if (!u || u.status === 'revoked') return empty;

  // Their property (and through it, their community). A portal user can be
  // linked to more than one; the visit anchors on the primary/first, and Claire
  // asks which one when it matters rather than guessing silently.
  let propertyId = null, communityId = null;
  const { data: links, error: linkErr } = await supabase
    .from('portal_user_properties')
    .select('property_id, granted_at')
    .eq('portal_user_id', portalUserId)
    .is('revoked_at', null)
    .order('granted_at', { ascending: true })
    .limit(5);
  if (linkErr) console.warn('[claire/scope] property link read failed:', linkErr.message);
  if (links && links.length) {
    propertyId = links[0].property_id;
    const { data: p, error: pErr } = await supabase
      .from('properties').select('id, community_id').eq('id', propertyId).maybeSingle();
    if (pErr) console.warn('[claire/scope] property read failed:', pErr.message);
    if (p) communityId = p.community_id;
  }

  return { portalUserId, propertyId, communityId, name: u.full_name || u.email, email: u.email, mimic: mimic || null };
}

/**
 * The one community check. Never infer access from the request body — a visitor
 * hands us a community_id and this decides whether they may have it.
 */
function canAccessCommunity(visitor, communityId) {
  if (!visitor || !communityId) return false;
  if (visitor.communityIds === 'all') return true;
  return Array.isArray(visitor.communityIds) && visitor.communityIds.includes(communityId);
}

/**
 * Resolve which community THIS visit is about. Homeowners get theirs and cannot
 * ask for another. Staff/board may name one they're entitled to; if they name
 * nothing and hold exactly one seat, we pick it rather than making them choose.
 * Returns null when the request names a community the visitor may not see —
 * callers must treat null as a 403, not as "unscoped".
 */
function resolveVisitCommunity(visitor, requestedId) {
  if (!visitor) return null;
  const requested = (requestedId || '').trim() || null;
  if (visitor.role === 'homeowner') {
    const own = visitor.communityIds[0] || null;
    if (requested && requested !== own) return null;
    return own;
  }
  if (requested) return canAccessCommunity(visitor, requested) ? requested : null;
  if (Array.isArray(visitor.communityIds) && visitor.communityIds.length === 1) return visitor.communityIds[0];
  return null; // staff/board with many seats must name one
}

module.exports = { resolveVisitor, canAccessCommunity, resolveVisitCommunity, SECONDS_CAP };
