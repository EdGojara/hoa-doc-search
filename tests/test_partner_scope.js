// ============================================================================
// tests/test_partner_scope.js
// ----------------------------------------------------------------------------
// Isolation gate for the Partner Association experience. Proves the fail-closed
// entitlement whitelist in lib/portal/member_scope against REAL data:
//   - CLMA has 5 governing docs; exactly ONE (the Maintenance Agreement) is
//     classified selected_members -> Cinco Residential. The other 4 are
//     'unclassified' and are the live adversarial decoys.
//   - Ask CLMA context must be built ONLY from entitled documents.
//   - A community with no active partner relationship gets nothing (fail closed).
//   - A DIFFERENT member must not see Cinco Residential's selected document.
//
// Requires migration 436 applied (member_scope column + the relationship). Run:
//   node tests/test_partner_scope.js
// This is the RELEASE GATE for the partner portal — it must pass before ship.
// ============================================================================
require('dotenv').config();
const {
  activeParentsForMember, memberEntitledDocs, entitledKnowledgeDocs,
} = require('../lib/portal/member_scope');

const CLMA = 'c4a87380-81ae-43aa-94eb-a671e2d6401f';
const CINCO_RESIDENTIAL = 'c1c0f000-0000-4000-8000-000000000001';
const CANYON_GATE = 'a0000000-0000-4000-8000-000000000003'; // active HOA, NOT a partner
const AGREEMENT = '61da0561-f6ca-4b5e-9034-38783c2da172';        // library_documents.id
const AGREEMENT_KDOC = 'f2d710a1-ad59-4c6e-975f-c238df7b0564';   // knowledge_documents.id

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}`); if (!cond) fails++; };

async function viewerFor(memberId, name) {
  const parents = await activeParentsForMember(memberId);
  return { kind: 'member', memberCommunityId: memberId, memberName: name, parents: parents.map((p) => ({ parentId: p.parentId, parentName: 'CLMA', type: p.type })) };
}

(async () => {
  console.log('partner-scope isolation gate\n');

  // 1) Cinco Residential is an active partner of CLMA.
  const parents = await activeParentsForMember(CINCO_RESIDENTIAL);
  ok(parents.some((p) => p.parentId === CLMA && p.type === 'partner_association'),
     'Cinco Residential has an ACTIVE partner_association relationship to CLMA');

  // 2) Entitled docs = exactly the Maintenance Agreement; the 4 unclassified are NEVER returned.
  const viewer = await viewerFor(CINCO_RESIDENTIAL, 'Cinco Residential Property Association');
  const docs = await memberEntitledDocs(viewer);
  const ids = docs.map((d) => d.id);
  ok(ids.includes(AGREEMENT), 'entitled docs INCLUDE the Maintenance Agreement');
  ok(ids.length === 1, `entitled docs contain ONLY the entitled set (got ${ids.length}: ${ids.join(',') || 'none'})`);
  ok(!ids.some((id) => id !== AGREEMENT), 'no unclassified/internal doc leaked into entitled set');

  // 3) The library->knowledge mapping is part of the security boundary. It must
  //    resolve the entitled library doc to exactly its knowledge document, scoped
  //    by source_record_id AND parent community (never an id match alone).
  const { ids: kIds, mgmtCoId } = await entitledKnowledgeDocs(viewer);
  ok(kIds.length === 1 && kIds[0] === AGREEMENT_KDOC,
     `entitled maps to ONLY the agreement knowledge doc (got ${kIds.join(',') || 'none'})`);
  ok(!!mgmtCoId, 'entitled mapping resolves a management company for scoping');
  // fail closed: a non-partner community maps to nothing
  const cgMap = await entitledKnowledgeDocs(await viewerFor(CANYON_GATE, 'Canyon Gate'));
  ok(cgMap.ids.length === 0, 'a non-partner community maps to ZERO knowledge docs (fail closed)');

  // 4) A community with NO active partner relationship gets nothing.
  const cgParents = await activeParentsForMember(CANYON_GATE);
  ok(cgParents.length === 0, 'Canyon Gate has NO active partner relationship');
  const cgDocs = await memberEntitledDocs(await viewerFor(CANYON_GATE, 'Canyon Gate'));
  ok(cgDocs.length === 0, 'a non-partner community is entitled to ZERO documents (fail closed)');

  // 5) Cross-member: a DIFFERENT member (parented to CLMA but not on the agreement's
  //    selected list) must NOT see Cinco Residential's selected document.
  const otherViewer = { kind: 'member', memberCommunityId: '00000000-0000-0000-0000-0000000000ff', memberName: 'Other Partner',
    parents: [{ parentId: CLMA, parentName: 'CLMA', type: 'partner_association' }] };
  const otherDocs = await memberEntitledDocs(otherViewer);
  ok(!otherDocs.some((d) => d.id === AGREEMENT),
     'a different partner CANNOT see Cinco Residential’s selected_members document');

  console.log(fails ? `\n✗ partner-scope: ${fails} failure(s)` : '\n✓ partner-scope: fail-closed entitlement holds');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
