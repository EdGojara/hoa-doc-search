// Bulk-regenerate draft violation letters to pick up the latest renderer
// (window-envelope City/ST ZIP address + current stage). Reuses the production
// runAutoBundle() so there's no divergent render path. Drafts only — never
// touches printed/mailed letters.
//   node scripts/bulk_regenerate_drafts.js --one   (regen ONE test property + verify PDF address)
//   node scripts/bulk_regenerate_drafts.js --all    (regen every draft across all communities)
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const pdf = require('pdf-parse');
const { runAutoBundle } = require('../api/enforcement');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const LETTERS_BUCKET = 'violation-letters';
const log = (...a) => console.log(...a);
const TEST_PROP = 'ce53f381-ff39-4805-be57-f65592fb851d'; // India Causey, 4-letter bundle

async function bundlePath(propertyId) {
  const { data } = await supabase.from('interactions').select('content')
    .eq('status', 'draft').eq('property_id', propertyId)
    .in('type', ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209']).limit(1).maybeSingle();
  return data && data.content;
}

async function verifyAddressInPdf(path) {
  const { data: blob, error } = await supabase.storage.from(LETTERS_BUCKET).download(path);
  if (error || !blob) return { ok: false, why: 'download failed: ' + (error && error.message) };
  const buf = Buffer.from(await blob.arrayBuffer());
  const text = (await pdf(buf)).text || '';
  // One-line "City, ST ZIP" leaves the comma intact; the old split removed it.
  const m = text.match(/[A-Za-z][A-Za-z .'-]+,\s+[A-Z]{2}\s+\d{5}/);
  return { ok: !!m, sample: m ? m[0] : '(no "City, ST ZIP" pattern found)', len: text.length };
}

(async () => {
  if (process.argv.includes('--one')) {
    log('=== Single-property regenerate + verify:', TEST_PROP, '===');
    const before = await bundlePath(TEST_PROP);
    log('Before PDF:', before);
    const res = await runAutoBundle({ force: true, propertyId: TEST_PROP });
    log('runAutoBundle =>', JSON.stringify(res));
    const after = await bundlePath(TEST_PROP);
    log('After  PDF:', after);
    log('PDF path changed:', before !== after);
    const v = await verifyAddressInPdf(after);
    log('Address check:', v.ok ? 'PASS' : 'FAIL', '— found:', JSON.stringify(v.sample), '(text len', v.len + ')');
    process.exit(v.ok && before !== after ? 0 : 1);
  }

  if (process.argv.includes('--all')) {
    log('=== BULK regenerate ALL draft letters (force) ===');
    // Run per community so each call is bounded + we get progress.
    const { data: comms } = await supabase.from('interactions')
      .select('community_id').eq('status', 'draft').in('type', ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209']);
    const communityIds = [...new Set((comms || []).map((c) => c.community_id).filter(Boolean))];
    log('Communities with drafts:', communityIds.length);
    let totBundles = 0, totDrafts = 0, totSingletons = 0, totSkipped = 0;
    for (const cid of communityIds) {
      const r = await runAutoBundle({ force: true, communityId: cid });
      totBundles += r.bundles_created; totDrafts += r.drafts_bundled; totSingletons += r.singletons; totSkipped += (r.skipped || []).length;
      log(`  comm ${cid.slice(0, 8)}: bundles=${r.bundles_created} drafts=${r.drafts_bundled} singletons=${r.singletons} skipped=${(r.skipped || []).length}`);
      if ((r.skipped || []).length) log('     skipped sample:', JSON.stringify((r.skipped || []).slice(0, 3)));
    }
    log(`\nTOTAL — bundles:${totBundles} drafts:${totDrafts} singletons:${totSingletons} skipped:${totSkipped}`);
    process.exit(0);
  }

  log('Pass --one (test) or --all (full run).');
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
