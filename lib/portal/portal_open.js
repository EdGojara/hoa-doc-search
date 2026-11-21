// ============================================================================
// lib/portal/portal_open.js  (Ed 2026-11-21)
// ----------------------------------------------------------------------------
// Is the homeowner portal open for this lot's association? The server-side
// gate behind communities.portal_active. Before this, only the browser checked
// it, so the portal APIs served data for an association that had not launched.
//
// Open = communities.portal_active === true, or a demo community.
// FAIL-CLOSED: a lookup error means closed. Staff manager view is not gated
// (it is how staff test an association before launch).
// ============================================================================
'use strict';

function isOpenCommunity(c) {
  return !!(c && (c.portal_active === true || c.is_demo === true));
}

// Returns the subset of propertyIds whose association's portal is open.
async function openPropertyIds(supabase, propertyIds) {
  const ids = [...new Set((propertyIds || []).filter(Boolean))];
  if (!ids.length) return new Set();
  const { data, error } = await supabase.from('properties')
    .select('id, communities:community_id(portal_active, is_demo)').in('id', ids);
  if (error) {
    console.warn('[portal_open] lookup failed (treating as closed):', error.message);
    return new Set();
  }
  return new Set((data || []).filter((p) => isOpenCommunity(p.communities)).map((p) => p.id));
}

module.exports = { isOpenCommunity, openPropertyIds };
