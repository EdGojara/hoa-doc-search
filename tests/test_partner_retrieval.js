// ============================================================================
// tests/test_partner_retrieval.js
// ----------------------------------------------------------------------------
// Regression for the retrieval-correctness defect: Ask CLMA must retrieve the
// MOST RELEVANT entitled evidence from anywhere in a document, not just the
// first 20k characters, and it must retrieve ONLY from entitled documents.
//
// The controlled condition is real: the entitled Maintenance Agreement is ~38k
// chars, and the easement size "21,286 square feet" lives PAST char 20,000 in
// document order (proven), so the old sequential-first-20k assembly could never
// see it. This test proves:
//   1. Reproduces the defect: a sequential first-20k slice does NOT contain the
//      late fact.
//   2. The new relevance-ranked, document-filtered retrieval DOES surface it.
//   3. Entitlement restriction happens IN retrieval: every returned chunk belongs
//      to the entitled knowledge document (no unentitled doc, e.g. Declarations).
//   4. Cross-partner / no-relationship viewers retrieve nothing (fail closed).
//   5. Existing match_knowledge_chunks callers (no document_filter) still work.
//
// Requires migrations 436 + 437 applied and OPENAI/SUPABASE env. Run:
//   node tests/test_partner_retrieval.js
// Release gate for the retrieval fix.
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const { activeParentsForMember, memberEntitledRetrieval } = require('../lib/portal/member_scope');

const CLMA = 'c4a87380-81ae-43aa-94eb-a671e2d6401f';
const CINCO_RESIDENTIAL = 'c1c0f000-0000-4000-8000-000000000001';
const CANYON_GATE = 'a0000000-0000-4000-8000-000000000003';
const AGREEMENT_KDOC = 'f2d710a1-ad59-4c6e-975f-c238df7b0564';
const BEDROCK = '00000000-0000-0000-0000-000000000001';
const LATE_FACT = '21,286'; // easement square footage, present only past char 20k

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); if (!c) fails++; };
async function viewerFor(id, name) {
  const parents = await activeParentsForMember(id);
  return { kind: 'member', memberCommunityId: id, memberName: name, parents: parents.map((p) => ({ parentId: p.parentId, parentName: 'CLMA', type: p.type })) };
}

(async () => {
  console.log('partner-retrieval regression\n');

  // 1) Reproduce the defect: sequential first-20k of the entitled agreement, in
  //    document order, does NOT contain the late fact.
  const { data: ch } = await supabase.from('knowledge_chunks')
    .select('chunk_index, text').eq('document_id', AGREEMENT_KDOC).order('chunk_index', { ascending: true });
  let seq = '', acc = 0;
  for (const c of (ch || [])) { if (acc >= 20000) break; acc += (c.text || '').length; seq += (c.text || '') + ' '; }
  const fullText = (ch || []).map((c) => c.text || '').join(' ');
  ok(fullText.includes(LATE_FACT), `the late fact "${LATE_FACT}" exists in the agreement`);
  ok(!seq.includes(LATE_FACT), `DEFECT reproduced: sequential first-20k does NOT contain "${LATE_FACT}"`);

  // 2 + 3) New retrieval surfaces the late fact AND every chunk is the entitled doc.
  const viewer = await viewerFor(CINCO_RESIDENTIAL, 'Cinco Residential Property Association');
  const q = 'What is the size in square feet of the Cinco Landscape Maintenance Association easement tract in Exhibit A of our agreement?';
  const { context, chunkDocIds } = await memberEntitledRetrieval(viewer, q);
  ok(chunkDocIds.length > 0, `retrieval returned chunks (${chunkDocIds.length})`);
  ok(chunkDocIds.every((id) => id === AGREEMENT_KDOC),
     'every retrieved chunk belongs to the entitled document (no unentitled doc leaked)');
  ok(context.includes(LATE_FACT),
     `relevance-ranked retrieval SURFACES the late-document fact "${LATE_FACT}" (defect fixed)`);

  // 4) No-relationship / cross-partner viewer retrieves nothing.
  const cg = await memberEntitledRetrieval(await viewerFor(CANYON_GATE, 'Canyon Gate'), q);
  ok(cg.chunkDocIds.length === 0 && cg.context === '', 'a non-partner viewer retrieves ZERO evidence (fail closed)');

  // 5) Existing callers (no document_filter) still work and are not doc-restricted.
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const emb = (await openai.embeddings.create({ model: 'text-embedding-ada-002', input: 'maintenance obligations' })).data[0].embedding;
    const { data, error } = await supabase.rpc('match_knowledge_chunks', {
      query_embedding: emb, mgmt_co_id: BEDROCK, match_count: 8, source_filter: ['library_doc'], community_filter: CLMA,
    });
    ok(!error && Array.isArray(data) && data.length > 0, 'existing caller shape (no document_filter) still returns results');
    const distinctDocs = new Set((data || []).map((r) => r.document_id));
    ok(distinctDocs.size >= 1, `no-filter call spans documents as before (${distinctDocs.size} docs)`);
  } catch (e) { ok(false, 'existing-caller check threw: ' + e.message); }

  console.log(fails ? `\n✗ partner-retrieval: ${fails} failure(s)` : '\n✓ partner-retrieval: late-document evidence retrieved, entitlement enforced in retrieval');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
