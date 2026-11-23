// ============================================================================
// lib/portal/portal_open.js  (Ed 2026-11-21)
// ----------------------------------------------------------------------------
// Is the homeowner portal open for this lot's association? The server-side
// gate behind communities.portal_active. Before this, only the browser checked
// it, so the portal APIs served data for an association that had not launched.
//
// Open = communities.portal_active === true, or a demo community, or (while
// portal_active is false) the signed-in portal user is on the association's
// PILOT list: portal_module_config.portal_pilot.user_ids, written only by the
// owner's pilot route (POST /api/portal-admin/community/:id/pilot). Everyone
// else in a pilot association still sees "not yet available". (Ed 2026-11-22.)
// FAIL-CLOSED: a lookup error means closed; no portal user id means no pilot.
// Staff manager view is not gated (it is how staff test an association).
// ============================================================================
'use strict';

function pilotUserIds(c) {
  const p = c && c.portal_module_config && c.portal_module_config.portal_pilot;
  return p && Array.isArray(p.user_ids) ? p.user_ids.filter((x) => typeof x === 'string') : [];
}

function isPilotUser(c, portalUserId) {
  return !!portalUserId && pilotUserIds(c).includes(String(portalUserId));
}

// portalUserId is the signed-in homeowner; omit it for a whole-association
// question ("is this association launched?"), which never counts the pilot.
function isOpenCommunity(c, portalUserId) {
  if (!c) return false;
  if (c.portal_active === true || c.is_demo === true) return true;
  return isPilotUser(c, portalUserId);
}

// Returns the subset of propertyIds whose association's portal is open for this user.
async function openPropertyIds(supabase, propertyIds, portalUserId) {
  const ids = [...new Set((propertyIds || []).filter(Boolean))];
  if (!ids.length) return new Set();
  const { data, error } = await supabase.from('properties')
    .select('id, communities:community_id(portal_active, is_demo, portal_module_config)').in('id', ids);
  if (error) {
    console.warn('[portal_open] lookup failed (treating as closed):', error.message);
    return new Set();
  }
  return new Set((data || []).filter((p) => isOpenCommunity(p.communities, portalUserId)).map((p) => p.id));
}

module.exports = { isOpenCommunity, isPilotUser, pilotUserIds, openPropertyIds };
