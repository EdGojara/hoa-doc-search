#!/usr/bin/env node
// ===========================================================================
// reocr_governing_docs.js  (Ed 2026-07-02)
// ---------------------------------------------------------------------------
// Re-index a community's GOVERNING docs (Declaration/CC&Rs, Bylaws, Rules,
// Architectural Guidelines) with OCR FORCED, so their clean, citation-grade
// text replaces the garbled embedded-text-layer version that pdf-parse
// ingested. Uses the proven indexLibraryDoc pipeline (structure-aware chunking
// + breadcrumbs), which rewrites BOTH retrieval stores — askEd's `documents`
// AND the letter path's `knowledge_chunks` — so askEd answers and letter
// citations both improve in one pass.
//
//   node -r dotenv/config scripts/reocr_governing_docs.js "<community>"          # list only
//   node -r dotenv/config scripts/reocr_governing_docs.js "<community>" --apply  # re-OCR + re-index
// ===========================================================================

const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const { indexLibraryDoc } = require('../lib/library_reindex');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const APPLY = process.argv.includes('--apply');
const commQuery = process.argv[2];

// Governing-authority categories a §209 letter / askEd would cite. NOT forms.
const GOV_CATEGORIES = ['declaration_ccrs', 'bylaws', 'rules_and_regulations', 'design_document'];

(async () => {
  if (!commQuery) { console.error('usage: "<community>" [--apply]'); process.exit(1); }
  const { data: comm } = await sb.from('communities').select('id, name').ilike('name', `%${commQuery}%`).limit(1).maybeSingle();
  if (!comm) { console.error('community not found:', commQuery); process.exit(1); }
  console.log('community:', comm.name);

  const { data: docs } = await sb.from('library_documents')
    .select('id, title, category, file_path, file_name_original, file_name_normalized, management_company_id, community_id, page_count')
    .eq('community_id', comm.id).in('category', GOV_CATEGORIES).order('category');
  console.log(`governing docs to re-OCR: ${(docs || []).length}`);
  for (const d of docs || []) console.log(`  [${d.category}] ${d.title} (${d.page_count || '?'} pg)`);

  if (!APPLY) { console.log('\n(list only — re-run with --apply to re-OCR + re-index)'); return; }
  if (!docs || !docs.length) { console.log('nothing to do.'); return; }

  console.log('\n=== re-OCR + re-index (forceOcr) ===');
  for (const d of docs) {
    process.stdout.write(`  ${d.title.slice(0, 50)} … `);
    try {
      const r = await indexLibraryDoc(sb, openai, d, { forceOcr: true });
      console.log(r.ok ? `OK — ${r.chunks_inserted} chunks${r.ocrUsed ? ' (OCR)' : ''}` : `FAILED — ${r.reason || r.error}`);
    } catch (e) {
      console.log('THREW —', e.message);
    }
  }
  console.log('\nDone. Both stores (documents + knowledge_chunks) rewritten with clean text.');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
