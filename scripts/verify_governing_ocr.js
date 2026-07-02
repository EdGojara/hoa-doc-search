#!/usr/bin/env node
// ===========================================================================
// verify_governing_ocr.js  (Ed 2026-07-02)
// ---------------------------------------------------------------------------
// Proof that the forceOcr re-index produced clean, citation-grade text in
// BOTH retrieval stores. Checks the two paths that were broken:
//   1) askEd  → getRelevantChunks over `documents` (hybrid_retrieval)
//   2) letter → lookupGoverningDoc over `knowledge_chunks`
// for the Property Maintenance category (Waterview §3.12 is the canary).
//
//   node -r dotenv/config scripts/verify_governing_ocr.js "<community>"
// ===========================================================================

const { createClient } = require('@supabase/supabase-js');
const { getRelevantChunks } = require('../lib/hybrid_retrieval');
const { lookupGoverningDoc } = require('../lib/enforcement/governing_doc_lookup');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const commQuery = process.argv[2] || 'Waterview';

// Signal the clean text carries and OCR-garble does not.
const CLEAN_MARKERS = ['neat and attractive', 'free of debris', 'good repair', 'good condition', 'sanitary'];
const GARBLE = /[^\x09\x0a\x0d\x20-\x7e]/g; // non-printing / mojibake

(async () => {
  const { data: comm } = await sb.from('communities').select('id, name').ilike('name', `%${commQuery}%`).limit(1).maybeSingle();
  if (!comm) { console.error('community not found:', commQuery); process.exit(1); }
  console.log('community:', comm.name, '\n');

  // --- 1) askEd path (documents store) --------------------------------------
  console.log('=== askEd  (documents / getRelevantChunks) ===');
  const ctx = await getRelevantChunks(
    'lawn weeds grass property maintenance keep lot neat attractive good repair condition', comm.name);
  const text = typeof ctx === 'string' ? ctx : JSON.stringify(ctx);
  const hits = CLEAN_MARKERS.filter((m) => text.toLowerCase().includes(m));
  const garbleCount = (text.match(GARBLE) || []).length;
  console.log(`  clean markers present: ${hits.length ? hits.join(', ') : 'NONE'}`);
  console.log(`  non-printing/garble chars in context: ${garbleCount}`);
  const m312 = text.match(/3\.12[^\n]{0,120}/);
  if (m312) console.log(`  §3.12 excerpt: "${m312[0].replace(/\s+/g, ' ').slice(0, 110)}"`);

  // --- 2) letter path (knowledge_chunks store) ------------------------------
  console.log('\n=== letter  (knowledge_chunks / lookupGoverningDoc) ===');
  const cite = await lookupGoverningDoc({
    communityId: comm.id,
    categorySlug: 'property_maintenance',
    categoryLabel: 'Property Maintenance',
    categoryDescription: 'maintain the lot and improvements in good condition and repair; keep lawn cut, free of weeds and debris',
  });
  if (!cite) console.log('  → no citation returned (still not found)');
  else {
    console.log(`  reference: ${cite.reference || '?'}`);
    console.log(`  doc:       ${cite.doc_title || cite.source || '?'}`);
    console.log(`  quote:     "${(cite.quote || '').replace(/\s+/g, ' ').slice(0, 160)}"`);
    console.log(`  garble in quote: ${((cite.quote || '').match(GARBLE) || []).length}`);
  }

  const ok = hits.length >= 1 && garbleCount < 20 && cite && cite.quote;
  console.log(`\n${ok ? 'PASS' : 'CHECK'} — askEd clean=${hits.length >= 1}, letter citation=${!!(cite && cite.quote)}`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
