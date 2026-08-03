// ============================================================================
// scripts/finish_eaglewood_draft_regen.js  (Ed 2026-07-31)
// ----------------------------------------------------------------------------
// Finish the one-time backfill: re-render every Eaglewood DRAFT letter bundle
// from its violation's CURRENT (corrected) category, so the reviewed preview
// matches what ships. Root cause + structural fix are in memory note
// project_stale_draft_letter_backfill. Last night's whole-community run was
// killed at 89/279; this version works PER PROPERTY with progress logging so
// it's resumable and observable, and only re-renders each property once.
// runAutoBundle(force) is idempotent — safe to re-run over already-done ones.
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { runAutoBundle } = require('../api/enforcement');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const EG = 'a0000000-0000-4000-8000-000000000004';

(async () => {
  const L = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await s.from('interactions')
      .select('property_id')
      .eq('community_id', EG).eq('status', 'draft')
      .in('type', ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209'])
      .order('id').range(f, f + 999);
    if (error) { console.error('load failed:', error.message); process.exit(1); }
    L.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const propIds = [...new Set(L.map((r) => r.property_id).filter(Boolean))];
  console.log(`Eaglewood: ${L.length} draft letters across ${propIds.length} properties. Re-rendering...`);

  let done = 0, bundles = 0, errs = 0;
  for (const pid of propIds) {
    try {
      const r = await runAutoBundle({ propertyId: pid, force: true });
      bundles += (r && r.bundles_created) || 0;
    } catch (e) { errs++; if (errs <= 5) console.warn('  err', pid.slice(0, 8), e.message); }
    done++;
    if (done % 20 === 0 || done === propIds.length) {
      console.log(`  ${done}/${propIds.length} properties · ${bundles} bundles rendered · ${errs} errors`);
    }
  }
  console.log(`DONE. ${done} properties, ${bundles} bundles re-rendered, ${errs} errors.`);
})();
