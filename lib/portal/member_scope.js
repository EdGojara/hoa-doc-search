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

// Map the entitled LIBRARY documents to their KNOWLEDGE documents (the retrieval
// substrate), enforcing scope IN THE MAPPING, never by an id match alone: we
// require source_type='library_doc' AND source_record_id in the entitled library
// ids AND the knowledge doc's community is one of the viewer's active parents. A
// stray knowledge doc that happened to reuse an id could not cross into scope.
// Returns { ids: [knowledge_document_id], mgmtCoId }.
async function entitledKnowledgeDocs(viewer) {
  const libDocs = await memberEntitledDocs(viewer); // already whitelist-filtered
  const libIds = libDocs.map((d) => d.id);
  const parentIds = (viewer && viewer.parents ? viewer.parents.map((p) => p.parentId) : []);
  if (!libIds.length || !parentIds.length) return { ids: [], mgmtCoId: null };

  const { data, error } = await supabase.from('knowledge_documents')
    .select('id, management_company_id, community_id, source_record_id, source_type')
    .eq('source_type', 'library_doc')
    .in('source_record_id', libIds)
    .in('community_id', parentIds);
  if (error) { console.warn('[member_scope] knowledge map error:', error.message); return { ids: [], mgmtCoId: null }; } // fail closed
  const rows = data || [];
  return { ids: rows.map((r) => r.id), mgmtCoId: rows.length ? rows[0].management_company_id : null };
}

// Retrieve the most relevant EVIDENCE for a question, from ONLY the entitled
// documents, relevance-ranked across the whole document (so late-in-document
// evidence surfaces). The entitlement restriction is pushed INTO retrieval via
// match_knowledge_chunks' document_filter, so the model can never receive a chunk
// from a document outside the entitlement. Returns { context, sources, chunkDocIds }.
async function memberEntitledRetrieval(viewer, question, opts = {}) {
  const matchCount = opts.matchCount || 18;
  const maxChars = opts.maxChars || 20000;
  const { ids, mgmtCoId } = await entitledKnowledgeDocs(viewer);
  if (!ids.length || !mgmtCoId) return { context: '', sources: [], chunkDocIds: [] }; // fail closed

  let queryEmbedding;
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const r = await openai.embeddings.create({ model: 'text-embedding-ada-002', input: String(question || '').replace(/\n/g, ' ').slice(0, 8000) });
    queryEmbedding = r.data[0].embedding;
  } catch (e) { console.warn('[member_scope] embed failed:', e.message); return { context: '', sources: [], chunkDocIds: [] }; }

  // document_filter is the precise entitlement boundary (query-time, not post-hoc);
  // mgmt_co_id is defense in depth. community_filter is omitted because the entitled
  // ids are already parent-community-scoped by entitledKnowledgeDocs.
  const { data: chunks, error } = await supabase.rpc('match_knowledge_chunks', {
    query_embedding: queryEmbedding,
    mgmt_co_id: mgmtCoId,
    match_count: matchCount,
    document_filter: ids,
  });
  if (error) { console.warn('[member_scope] retrieval error:', error.message); return { context: '', sources: [], chunkDocIds: [] }; } // fail closed

  const rows = chunks || [];
  let context = '';
  const sourceSet = new Set();
  const chunkDocIds = [];
  for (const c of rows) {
    chunkDocIds.push(c.document_id);
    if (context.length >= maxChars) continue;
    context += (context ? '\n\n' : '') + String(c.text || '');
    if (c.document_title) sourceSet.add(c.document_title);
  }
  return { context: context.slice(0, maxChars), sources: [...sourceSet].map((f) => ({ document: f })), chunkDocIds };
}

module.exports = {
  resolveMemberViewer,
  activeParentsForMember,
  memberEntitledDocs,
  entitledKnowledgeDocs,
  memberEntitledRetrieval,
};
