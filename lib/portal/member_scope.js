// ============================================================================
// lib/portal/member_scope.js  (Ed 2026-09-20)
// ----------------------------------------------------------------------------
// The authorization core for the PARTNER ASSOCIATION experience, the sibling of
// lib/portal/board_access.js. A Partner Association (e.g. Cinco Residential
// Property Association) is an organizational client of a parent service org
// (e.g. CLMA). Entitlement belongs to the ORG-TO-ORG relationship, never to an
// individual user, and is derived server-side. The browser's member id is never
// trusted as proof of access; it is CHECKED.
//
// Three gates, all required (the approved invariant):
//   authenticated person
//     -> authority to represent the Partner Association
//     -> ACTIVE relationship between that Partner and its parent
//     -> relationship entitlement
//     -> scoped information
//
// For now the ONLY way to represent a partner is STAFF VIEW-AS: an authenticated
// staff user (Supabase JWT) may view a specific partner's experience. This
// down-scopes what staff can already see and manufactures no identities. A plain
// homeowner never becomes a partner representative. A real per-user
// representative-authorization layer is deliberately deferred (documented, not
// stubbed) and would slot in at resolveMemberViewer without changing any consumer.
//
// SCOPE IS FAIL-CLOSED. A document is exposed to a partner ONLY when its
// member_scope is 'all_members', or 'selected_members' WITH an explicit join row
// for that partner. 'internal_only', 'not_applicable', and the default
// 'unclassified' are NEVER exposed. Missing/unknown scope hides, never leaks.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const STAFF_ROLES = new Set(['admin', 'staff', 'manager']);

// Active parent relationships for a member community. Returns [{parentId, type}].
// status must be 'active' — a pending/terminated relationship grants nothing.
async function activeParentsForMember(memberCommunityId) {
  const out = [];
  if (!memberCommunityId) return out;
  const { data, error } = await supabase.from('community_relationships')
    .select('parent_community_id, relationship_type, status')
    .eq('member_community_id', memberCommunityId)
    .eq('status', 'active');
  if (error) { console.warn('[member_scope] activeParents error:', error.message); return out; } // fail closed
  for (const r of (data || [])) if (r.parent_community_id) out.push({ parentId: r.parent_community_id, type: r.relationship_type });
  return out;
}

// Resolve the partner viewer + their entitlement scope, or null.
// Returns { kind:'member', memberCommunityId, memberName, memberOrgType,
//           parents:[{parentId, parentName, type}], acting_as:{staff} } | null.
async function resolveMemberViewer(req) {
  const memberId = String(
    (req.query && req.query.member) || (req.body && req.body.member) || ''
  ).trim();
  if (!memberId) return null;

  // GATE 1 + 2 (Tuesday): authenticated STAFF acting as this partner (View-As).
  // Only staff may represent a partner for now; a real representative layer is
  // deferred and would be added here (a portal_user authorized for memberId).
  let staff = null;
  try {
    const { getActingUser } = require('../../api/_acting_user');
    const actor = await getActingUser(req);
    if (actor && actor.is_active !== false && STAFF_ROLES.has(actor.role)) {
      staff = { email: actor.email, name: actor.full_name || actor.email };
    }
  } catch (_) { /* no JWT */ }
  if (!staff) return null; // no authority to represent a partner → no access

  // The partner org must exist.
  const { data: member, error: mErr } = await supabase.from('communities')
    .select('id, name, organization_type').eq('id', memberId).maybeSingle();
  if (mErr || !member) return null;

  // GATE 3: there must be at least one ACTIVE relationship to a parent.
  const parents = await activeParentsForMember(memberId);
  if (!parents.length) return null; // not an active partner of anyone → no access

  // Name the parents for display (best-effort).
  const parentIds = parents.map((p) => p.parentId);
  const { data: pRows } = await supabase.from('communities').select('id, name').in('id', parentIds);
  const nameById = new Map((pRows || []).map((r) => [r.id, r.name]));

  return {
    kind: 'member',
    memberCommunityId: member.id,
    memberName: member.name,
    memberOrgType: member.organization_type,
    parents: parents.map((p) => ({ parentId: p.parentId, parentName: nameById.get(p.parentId) || 'CLMA', type: p.type })),
    acting_as: { staff: staff.email, staff_name: staff.name },
  };
}

// The library documents this partner is entitled to see. Whitelist only:
// member_scope='all_members', or 'selected_members' with a join row for this
// member. Everything else (internal_only / not_applicable / unclassified) is
// excluded here, at the query, so no unentitled row is ever returned.
async function memberEntitledDocs(viewer) {
  if (!viewer || viewer.kind !== 'member') return [];
  const parentIds = (viewer.parents || []).map((p) => p.parentId);
  if (!parentIds.length) return [];

  const { data, error } = await supabase.from('library_documents')
    .select('id, title, category, community_id, member_scope, file_path')
    .in('community_id', parentIds)
    .in('member_scope', ['all_members', 'selected_members']); // whitelist
  if (error) { console.warn('[member_scope] entitledDocs error:', error.message); return []; } // fail closed

  const rows = data || [];
  const selectedIds = rows.filter((r) => r.member_scope === 'selected_members').map((r) => r.id);
  let allowedSelected = new Set();
  if (selectedIds.length) {
    const { data: joins, error: jErr } = await supabase.from('document_member_scope')
      .select('document_id')
      .eq('member_community_id', viewer.memberCommunityId)
      .in('document_id', selectedIds);
    if (jErr) { console.warn('[member_scope] scope join error:', jErr.message); return []; } // fail closed
    allowedSelected = new Set((joins || []).map((j) => j.document_id));
  }

  // all_members pass through; selected_members pass ONLY with a join row.
  return rows
    .filter((r) => r.member_scope === 'all_members' || allowedSelected.has(r.id))
    .map((r) => ({ id: r.id, title: r.title, category: r.category, community_id: r.community_id, file_path: r.file_path }));
}

// Assemble grounding context for Ask CLMA from ONLY the entitled documents. The
// model never receives a chunk outside the entitled set: retrieval is the
// boundary, not the prompt. Bounded to ~20k chars (the retrieval-truncation
// floor). entitledDocIds MUST come from memberEntitledDocs.
async function memberEntitledDocContext(entitledDocIds, maxChars = 20000) {
  if (!entitledDocIds || !entitledDocIds.length) return { context: '', sources: [] };
  const { data, error } = await supabase.from('documents')
    .select('content, metadata')
    .in('metadata->>library_document_id', entitledDocIds)
    .limit(400);
  if (error) { console.warn('[member_scope] docContext error:', error.message); return { context: '', sources: [] }; }

  const chunks = (data || []).filter((c) => c && c.content);
  let ctx = '';
  const sourceSet = new Set();
  for (const c of chunks) {
    if (ctx.length >= maxChars) break;
    ctx += (ctx ? '\n\n' : '') + String(c.content);
    const fn = c.metadata && (c.metadata.filename || c.metadata.title);
    if (fn) sourceSet.add(fn);
  }
  return { context: ctx.slice(0, maxChars), sources: [...sourceSet].map((f) => ({ document: f })) };
}

module.exports = {
  resolveMemberViewer,
  activeParentsForMember,
  memberEntitledDocs,
  memberEntitledDocContext,
};
