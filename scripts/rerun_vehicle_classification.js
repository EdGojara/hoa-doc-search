// Re-run the corrected vision AI on the 16 cross-category vehicle pairs to tell
// same-object (one is wrong) from two-real-vehicles. Dry-run: prints verdicts;
// --apply voids only same-object misclassifications. (Ed 2026-07-30)
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { categorizePhoto } = require('../lib/enforcement/ai_vision');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const VG = 'ee666d3e-22fd-4507-9f9c-39bd0ad973d2';
const OPEN = ['courtesy_1', 'courtesy_2', 'certified_209', 'fine_assessed'];
const APPLY = process.argv.includes('--apply');

async function download(path) {
  for (const b of ['documents', 'inspections', 'inspection-photos', 'photos']) {
    const { data, error } = await s.storage.from(b).download(path);
    if (!error && data) return Buffer.from(await data.arrayBuffer());
  }
  return null;
}

(async () => {
  const { data: cats } = await s.from('enforcement_categories').select('slug,label,description').not('slug', 'like', '%\\_-\\_%');
  const categories = (cats || []).filter((c) => c.description && !/auto-added from vantaca|DO NOT USE/i.test(c.description))
    .map((c) => ({ slug: c.slug, label: c.label, description: c.description }));

  const v = [];
  for (let f = 0; ; f += 1000) { const { data } = await s.from('violations').select('id,property_id,opened_from_observation_id,current_stage,cat:primary_category_id(label,group_id),prop:property_id(street_address)').in('current_stage', OPEN).order('id').range(f, f + 999); v.push(...(data || [])); if (!data || data.length < 1000) break; }
  const g = {}; for (const r of v) { if (r.cat?.group_id !== VG) continue; (g[r.property_id] = g[r.property_id] || []).push(r); }
  const multi = Object.values(g).filter((a) => a.length > 1);

  for (const grp of multi) {
    const addr = grp[0].prop?.street_address || grp[0].property_id;
    console.log('\n=== ' + addr + ' ===');
    const verdicts = [];
    for (const r of grp) {
      const { data: obs } = await s.from('property_observations').select('inspection_photo_id').eq('id', r.opened_from_observation_id).maybeSingle();
      const { data: ph } = obs?.inspection_photo_id ? await s.from('inspection_photos').select('storage_path').eq('id', obs.inspection_photo_id).maybeSingle() : { data: null };
      if (!ph?.storage_path) { console.log('  ' + r.cat.label + ' (' + r.id.slice(0, 8) + '): no photo'); verdicts.push({ r, cats: null }); continue; }
      const buf = await download(ph.storage_path);
      if (!buf) { console.log('  ' + r.cat.label + ' (' + r.id.slice(0, 8) + '): photo download failed'); verdicts.push({ r, cats: null }); continue; }
      let res = null; try { res = await categorizePhoto({ image_buffer: buf, image_media_type: 'image/jpeg', categories }); } catch (e) { console.log('  AI err', e.message); }
      const findings = (res && res.findings) || [];
      const vehFindings = findings.filter((f) => /vehicle|rv|boat|trailer|parking|inoperable|commercial|stored/i.test((f.category_slug || '') + ' ' + (f.description || '')));
      const labels = vehFindings.map((f) => f.category_slug + (f.description ? ' — ' + f.description.slice(0, 60) : ''));
      console.log('  WAS ' + r.cat.label + ' (' + r.id.slice(0, 8) + ') → AI now: ' + (labels.length ? labels.join(' | ') : (findings.length ? '(no vehicle finding; other: ' + findings.map((f) => f.category_slug).join(',') + ')' : 'CLEAN — no violation')));
      verdicts.push({ r, cats: vehFindings.map((f) => f.category_slug) });
    }
    // Same-object heuristic: if both photos' AI verdicts collapse to the SAME single
    // vehicle category, they are the same vehicle → keep the one matching, void other.
    // (Only printed here; voiding is manual after review to stay safe on §209.)
  }
  console.log('\nDry run — review verdicts. (Voiding left manual; these are §209 records.)');
})();
