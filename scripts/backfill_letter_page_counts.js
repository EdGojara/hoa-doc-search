#!/usr/bin/env node
// ===========================================================================
// backfill_letter_page_counts.js  (Ed 2026-07-02)
// ---------------------------------------------------------------------------
// One-time backfill of interactions.page_count (migration 257) for letters
// already mailed before page-count tracking shipped. Reads each stored letter
// PDF from the violation-letters bucket, counts pages, writes page_count.
//
// Dedupes by PDF PATH so a shared bundle PDF (older property-keyed "bundle-*"
// letters) is downloaded once; every interaction pointing at that path gets the
// same physical page count. The billing report then dedupes pages by path so a
// bundle's pages are billed once.
//
//   node -r dotenv/config scripts/backfill_letter_page_counts.js          # dry run
//   node -r dotenv/config scripts/backfill_letter_page_counts.js --apply
// ===========================================================================

const { createClient } = require('@supabase/supabase-js');
const { PDFDocument } = require('pdf-lib');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');
const LETTER_TYPES = ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209', 'letter_postcard_reminder'];
const BUCKET = 'violation-letters';

async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

(async () => {
  // Letters that were printed/mailed but have no page_count yet.
  const rows = await fetchAll(() => sb.from('interactions')
    .select('id, content, page_count, type, printed_at')
    .in('type', LETTER_TYPES)
    .not('printed_at', 'is', null)
    .is('page_count', null));
  const withPath = rows.filter((r) => r.content && r.content.endsWith('.pdf'));
  console.log(`letters needing page_count: ${rows.length} (${withPath.length} have a PDF path)`);

  // Group by PDF path — download each distinct file once.
  const byPath = new Map();
  withPath.forEach((r) => { (byPath.get(r.content) || byPath.set(r.content, []).get(r.content)).push(r.id); });
  console.log(`distinct PDF files to read: ${byPath.size}`);

  let filled = 0, missing = 0, i = 0;
  for (const [path, ids] of byPath) {
    i++;
    let pages = null;
    try {
      const { data: blob, error } = await sb.storage.from(BUCKET).download(path);
      if (error || !blob) { missing++; continue; }
      const doc = await PDFDocument.load(Buffer.from(await blob.arrayBuffer()));
      pages = doc.getPageIndices().length;
    } catch (e) { missing++; continue; }
    if (!pages) { missing++; continue; }
    if (APPLY) {
      const { error: uErr } = await sb.from('interactions').update({ page_count: pages }).in('id', ids);
      if (uErr) { console.warn('  update failed for', path, uErr.message); continue; }
    }
    filled += ids.length;
    if (i % 25 === 0) console.log(`  …${i}/${byPath.size} files, ${filled} interactions set`);
  }

  console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'}: ${filled} interactions would get page_count; ${missing} files unreadable/missing.`);
  if (!APPLY) console.log('re-run with --apply to write.');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
