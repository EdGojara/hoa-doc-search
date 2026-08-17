// ============================================================================
// lib/portal/board_access.js  (Ed 2026-07-27)
// ----------------------------------------------------------------------------
// The authorization core for the board portal. The board portal was v0
// UNAUTHENTICATED (any request returned any community's data). This makes every
// board-portal endpoint require an identity AND derive — server-side — the set
// of communities that identity may see. The browser's community id is NEVER
// trusted as proof of access; it is CHECKED against the derived scope.
//
// Two kinds of viewer, resolved from what they present:
//   - STAFF/ADMIN/MANAGER: a Supabase Bearer JWT (user_profiles). Scope = ALL
//     communities (the portfolio view they have today).
//   - BOARD MEMBER: a portal magic-link session (portal_users). Scope = the
//     communities they sit on the board of, derived LIVE from board_members by
//     email. Live derivation = instant revocation: drop them from board_members
//     (or set is_active=false) and the very next request loses access — no
//     stale token to expire, no session-revocation store to maintain.
//
// A plain homeowner (portal session, no board seat) gets NO community scope —
// they see "My Home" in the homeowner portal, never the board oversight view.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const STAFF_ROLES = new Set(['admin', 'staff', 'manager']);

// Communities this email sits on the board of (active seats only).
async function boardCommunitiesForEmail(email) {
  const set = new Set();
  const e = String(email || '').trim().toLowerCase();
  if (!e) return set;
  try {
    const { data, error } = await supabase.from('board_members')
      .select('community_id, is_active, email').ilike('email', e).eq('is_active', true);
    if (error) return set;
    for (const b of (data || [])) if (b.community_id) set.add(b.community_id);
  } catch (_) { /* best-effort — deny on failure (empty set) */ }
  return set;
}

// Resolve the viewer + their community scope. Returns:
//   { kind:'staff'|'board', email, name, scope:'all'|Set<communityId>, acting_as? }
//   or null.
async function resolveBoardViewer(req) {
  // MIMIC WINS, ALWAYS, AND CAN ONLY NARROW.
  //
  // When a staffer is viewing the platform as a specific person, every surface
  // must show exactly what that person sees. This check has to come before the
  // staff check below, because a staffer in mimic mode still carries their own
  // JWT — so resolving staff first meant the mimic cookie was ignored entirely
  // and the viewer came back scoped to 'all'.
  //
  // Ed hit this on 2026-08-16 using view-as on a Waterview board member to
  // confirm community isolation. It reported no isolation when the isolation
  // was in fact correct. The failure mode is what makes it serious: view-as is
  // used precisely when someone is verifying a boundary, so a view-as that does
  // not constrain answers a safety question with false confidence — and it
  // would have said "isolated" just as readily if the truth had been otherwise.
  //
  // A mimicked person with no board seat resolves to null, not to staff: a
  // homeowner being viewed must not acquire board access on the way through.
  try {
    const { resolvePortalUser } = require('../../api/portal');
    const { portalUserId, mimic } = resolvePortalUser(req) || {};
    if (portalUserId && mimic) {
      const { data: u } = await supabase.from('portal_users')
        .select('id, email, full_name, status').eq('id', portalUserId).maybeSingle();
      if (!u || u.status === 'revoked') return null;
      const scope = await boardCommunitiesForEmail(u.email);
      if (!scope.size) return null;   // mimicking a non-board user: no board access
      return {
        kind: 'board',
        email: u.email,
        name: u.full_name || u.email,
        scope,
        acting_as: { mimic: true },
      };
    }
  } catch (err) {
    // Deny rather than widen. An unreadable mimic must never fall through to
    // the staff branch and hand back scope 'all'.
    console.warn('[board_access] mimic resolve failed:', err.message);
    return null;
  }

  // Otherwise establish whether the requester is STAFF (Supabase JWT, or a
  // portal session whose role is staff-like).
  let staff = null;
  try {
    const { getActingUser } = require('../../api/_acting_user');
    const actor = await getActingUser(req);
    if (actor && actor.is_active !== false && STAFF_ROLES.has(actor.role)) staff = { email: actor.email, name: actor.full_name || actor.email };
  } catch (_) { /* no JWT */ }
  if (!staff) {
    try {
      const { resolvePortalUser } = require('../../api/portal');
      const resolved = resolvePortalUser(req) || {};
      if (resolved.portalUserId) {
        const { data: u } = await supabase.from('portal_users').select('id, email, full_name, role, status').eq('id', resolved.portalUserId).maybeSingle();
        if (u && u.status !== 'revoked') {
          if (STAFF_ROLES.has(u.role)) staff = { email: u.email, name: u.full_name || u.email };
          else {
            // A board member's own session — scoped to their seats.
            const scope = await boardCommunitiesForEmail(u.email);
            if (scope.size) return { kind: 'board', email: u.email, name: u.full_name || u.email, scope };
          }
        }
      }
    } catch (_) { /* fall through */ }
  }

  if (staff) {
    // "View as" a board member — staff DOWN-scopes to see exactly what that
    // member sees. Safe: staff can already see everything, this only narrows it.
    const viewAs = String((req.query && req.query.view_as) || '').trim().toLowerCase();
    if (viewAs && viewAs.includes('@')) {
      const scope = await boardCommunitiesForEmail(viewAs);
      let name = viewAs;
      try { const { data } = await supabase.from('board_members').select('name').ilike('email', viewAs).eq('is_active', true).limit(1); if (data && data[0] && data[0].name) name = data[0].name; } catch (_) {}
      return { kind: 'board', email: viewAs, name, scope, acting_as: { staff: staff.email, staff_name: staff.name } };
    }
    return { kind: 'staff', email: staff.email, name: staff.name, scope: 'all' };
  }

  return null;
}

// Is this viewer allowed to see this community? Staff → always; board → only
// their seats. Never infer access from the request — this is the one gate.
function canSeeCommunity(viewer, communityId) {
  if (!viewer || !communityId) return false;
  if (viewer.scope === 'all') return true;
  return viewer.scope.has(communityId);
}

// The list of community ids a viewer may enumerate ('all' for staff, else the
// board set as an array). Used by the /communities endpoint.
function scopeCommunityIds(viewer) {
  if (!viewer) return [];
  if (viewer.scope === 'all') return 'all';
  return [...viewer.scope];
}

// Express-style gate. Sets req.boardViewer or sends 401. Per-community checks
// still happen in each handler via canSeeCommunity (this only proves identity).
async function requireBoardViewer(req, res) {
  const viewer = await resolveBoardViewer(req);
  if (!viewer) { res.status(401).json({ error: 'not_signed_in' }); return null; }
  req.boardViewer = viewer;
  return viewer;
}

module.exports = { resolveBoardViewer, requireBoardViewer, canSeeCommunity, scopeCommunityIds, boardCommunitiesForEmail };
