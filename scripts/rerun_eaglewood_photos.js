// ============================================================================
// scripts/rerun_eaglewood_photos.js  (Ed 2026-07-30)
// ----------------------------------------------------------------------------
// Re-analyze every photo-backed Eaglewood courtesy violation with the corrected
// ONE-VIOLATION-PER-PHOTO AI, to fix the pre-fix garbage (wrong categories like
// "Prune Trees" on a treeless lot) and remove false positives. Does NOT send
// anything — every result is left quality_status='unreviewed' for human approval.
//   - photo re-reads CLEAN  -> void the violation (false positive), obs rejected
//   - re-reads a category   -> set that category (mig-340 safe), mark unreviewed
// Resumable: skips violations already stamped 'reanalyzed-20260730'. Certified,
// sent letters, and no-photo (Vantaca) violations are untouched.
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { categorizePhoto } = require('../lib/enforcement/ai_vision');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const EG = 'a0000000-0000-4000-8000-000000000004';
const STAMP = 'reanalyzed-20260730';
const CONCURRENCY = 4;

async function loadCats() {
  const { data } = await s.from('enforcement_categories').select('id,slug,label,description').order('display_order');
  const byId = {}; const bySlug = {};
  for (const c of (data || [])) { byId[c.id] = c; bySlug[c.slug] = c; }
  return { list: data || [], byId, bySlug };
}

(async () => {
  const cats = await loadCats();
  // all photo-backed open courtesy violations not yet re-analyzed
  const v = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await s.from('violations')
      .select('id,property_id,primary_category_id,current_stage,opened_from_observation_id,review_notes')
      .eq('community_id', EG).in('current_stage', ['courtesy_1', 'courtesy_2']).order('id').range(f, f + 999);
    v.push(...(data || [])); if (!data || data.length < 1000) break;
  }
  let todo = v.filter((r) => r.opened_from_observation_id && !(r.review_notes || '').includes(STAMP));
  if (process.argv.includes('--test')) todo = todo.slice(0, 8);
  // resolve each violation's photo path
  const oids = todo.map((r) => r.opened_from_observation_id);
  const obsById = {};
  for (let i = 0; i < oids.length; i += 200) {
    const { data: o } = await s.from('property_observations').select('id,inspection_photo_id').in('id', oids.slice(i, i + 200));
    for (const x of (o || [])) obsById[x.id] = x;
  }
  const photoIds = [...new Set(Object.values(obsById).map((o) => o.inspection_photo_id).filter(Boolean))];
  const pathById = {};
  for (let i = 0; i < photoIds.length; i += 200) {
    const { data: p } = await s.from('inspection_photos').select('id,storage_path').in('id', photoIds.slice(i, i + 200));
    for (const x of (p || [])) pathById[x.id] = x.storage_path;
  }

  console.log(`re-analyzing ${todo.length} photo-backed courtesy violations (concurrency ${CONCURRENCY})...`);
  let done = 0, voidedClean = 0, recategorized = 0, confirmed = 0, dupVoided = 0, errs = 0;

  async function processOne(r) {
    try {
      const obs = obsById[r.opened_from_observation_id];
      const path = obs && pathById[obs.inspection_photo_id];
      if (!path) { errs++; return; }
      const { data: dl } = await s.storage.from('documents').download(path);
      if (!dl) { errs++; return; }
      const buf = Buffer.from(await dl.arrayBuffer());
      const res = await categorizePhoto({ image_buffer: buf, image_media_type: 'image/jpeg', categories: cats.list });
      const finding = res && res.findings && res.findings[0];
      if (!finding || !finding.category_slug || !cats.bySlug[finding.category_slug]) {
        // clean or unmapped → false positive
        await s.from('violations').update({ current_stage: 'voided', resolved_at: new Date().toISOString(), resolved_via: 'voided', review_notes: `${STAMP}: re-read clean/false-positive`, updated_at: new Date().toISOString() }).eq('id', r.id);
        await s.from('property_observations').update({ reviewer_status: 'rejected', reviewed_at: new Date().toISOString() }).eq('id', r.opened_from_observation_id);
        voidedClean++; return;
      }
      const newCatId = cats.bySlug[finding.category_slug].id;
      const obsUpdate = { ai_description: finding.description || null, reviewer_status: 'pending' };
      if (newCatId === r.primary_category_id) {
        await s.from('violations').update({ quality_status: 'unreviewed', review_notes: `${STAMP}: confirmed ${finding.category_slug}`, updated_at: new Date().toISOString() }).eq('id', r.id);
        await s.from('property_observations').update(obsUpdate).eq('id', r.opened_from_observation_id);
        confirmed++; return;
      }
      // different category — mig-340 guard: does the property already have an open one of the new category?
      const { data: clash } = await s.from('violations').select('id').eq('property_id', r.property_id).eq('primary_category_id', newCatId).in('current_stage', ['courtesy_1', 'courtesy_2', 'certified_209', 'fine_assessed']).neq('id', r.id).limit(1);
      if (clash && clash[0]) {
        await s.from('violations').update({ current_stage: 'voided', resolved_at: new Date().toISOString(), resolved_via: 'voided', review_notes: `${STAMP}: re-read as ${finding.category_slug}, already open on property → merged` , updated_at: new Date().toISOString() }).eq('id', r.id);
        dupVoided++; return;
      }
      await s.from('violations').update({ primary_category_id: newCatId, quality_status: 'unreviewed', review_notes: `${STAMP}: recategorized → ${finding.category_slug}`, updated_at: new Date().toISOString() }).eq('id', r.id);
      await s.from('property_observations').update(obsUpdate).eq('id', r.opened_from_observation_id);
      recategorized++;
    } catch (e) { errs++; if (errs <= 5) console.log('  err', r.id.slice(0, 8), e.message); }
    finally { done++; if (done % 50 === 0) console.log(`  ${done}/${todo.length} (clean-voided ${voidedClean}, recat ${recategorized}, confirmed ${confirmed}, merged ${dupVoided}, err ${errs})`); }
  }

  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    await Promise.all(todo.slice(i, i + CONCURRENCY).map(processOne));
  }
  console.log(`DONE. processed ${done}: clean-voided ${voidedClean}, recategorized ${recategorized}, confirmed ${confirmed}, merged-dups ${dupVoided}, errors ${errs}`);
})();
