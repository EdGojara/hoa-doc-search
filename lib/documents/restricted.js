'use strict';
// ============================================================================
// lib/documents/restricted.js  (Ed 2026-10-19) — restricted association records
// ----------------------------------------------------------------------------
// A signed association tax return is an association record, but not one every
// staff member should browse, download or attach to an email. Library documents
// in a RESTRICTED category are visible only to the owner on the general document
// surfaces (Documents list / open / download / preview / open-by-name, and the
// Communications "attach a filed document" search, view and attach). A staff
// member who must handle one gets it through the narrow route for that job (the
// IRS mailing task: api/tessa_mailing.js), never through browsing.
// One list, one check, used everywhere.
// ============================================================================
const RESTRICTED_CATEGORIES = new Set(['tax_return']);

const isRestricted = (doc) => !!(doc && RESTRICTED_CATEGORIES.has(String(doc.category || '').toLowerCase()));

async function viewerIsOwner(req) {
  try {
    const { getAuthedUser, OWNER_EMAIL } = require('../../api/_require_admin');
    const u = await getAuthedUser(req);
    return !!(u && u.role === 'admin' && String(u.email || '').toLowerCase() === String(OWNER_EMAIL).toLowerCase());
  } catch (_) { return false; }   // fail closed
}

// Drop restricted documents from a list unless the viewer is the owner.
async function filterForViewer(req, docs) {
  const list = Array.isArray(docs) ? docs : [];
  if (!list.some(isRestricted)) return list;
  return (await viewerIsOwner(req)) ? list : list.filter((d) => !isRestricted(d));
}

// For a single document: may this viewer open it here?
async function mayOpen(req, doc) { return !isRestricted(doc) || viewerIsOwner(req); }

module.exports = { RESTRICTED_CATEGORIES, isRestricted, viewerIsOwner, filterForViewer, mayOpen };
