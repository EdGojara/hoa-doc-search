// trace_drafts_photos.js — diagnostic for 2026-06-10 "no photo" bug
//
// Hypothesis: the drafts queue says "no photo" on rows whose generated
// letter PDF embeds a photo. The /drafts API joins
//   interactions → property_observations → inspection_photos (by inspection_photo_id)
// while the letter generator may resolve the photo via a different path.
//
// This script traces a recent batch of draft interactions and prints, per row:
//   - interaction_id
//   - property address
//   - observation_id (or null)
//   - observation.inspection_photo_id (or null)
//   - inspection_photo.storage_path (or null — broken FK or missing row)
//   - inspection_photo.ai_findings count (proxy for whether it has been analyzed)
//   - whether letter generator would find a different photo at this property

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function main() {
  const limit = Number(process.argv[2]) || 20;
  console.log(`\nTracing photo-attachment chain for the ${limit} most recent draft letter interactions…\n`);

  const { data: drafts, error } = await supabase
    .from('interactions')
    .select('id, property_id, observation_id, violation_id, inspection_id, created_at, type, community_id')
    .eq('status', 'draft')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) { console.error(error); process.exit(1); }
  if (!drafts || drafts.length === 0) { console.log('No drafts.'); return; }

  // Pull every observation in one shot
  const obsIds = drafts.map(d => d.observation_id).filter(Boolean);
  const { data: obs } = obsIds.length
    ? await supabase.from('property_observations')
        .select('id, inspection_photo_id, severity, ai_description, created_at')
        .in('id', obsIds)
    : { data: [] };
  const obsById = new Map((obs || []).map(o => [o.id, o]));

  // Pull every photo referenced by those observations
  const photoIds = (obs || []).map(o => o.inspection_photo_id).filter(Boolean);
  const { data: photos } = photoIds.length
    ? await supabase.from('inspection_photos')
        .select('id, storage_path, captured_at, property_id, inspection_id, ai_findings')
        .in('id', photoIds)
    : { data: [] };
  const photoById = new Map((photos || []).map(p => [p.id, p]));

  // For comparison — also pull the MOST RECENT inspection photo per property
  // (this is what a "smart" fallback would use)
  const propIds = [...new Set(drafts.map(d => d.property_id).filter(Boolean))];
  const { data: latestPhotosPerProp } = propIds.length
    ? await supabase.from('inspection_photos')
        .select('id, storage_path, captured_at, property_id')
        .in('property_id', propIds)
        .order('captured_at', { ascending: false })
    : { data: [] };
  const latestPhotoByProp = new Map();
  for (const p of (latestPhotosPerProp || [])) {
    if (!latestPhotoByProp.has(p.property_id)) latestPhotoByProp.set(p.property_id, p);
  }

  // Property addresses
  const { data: props } = propIds.length
    ? await supabase.from('properties')
        .select('id, street_address')
        .in('id', propIds)
    : { data: [] };
  const propById = new Map((props || []).map(p => [p.id, p]));

  let hasObsHasPhoto = 0;
  let hasObsNoPhotoId = 0;
  let hasObsPhotoIdBroken = 0;
  let noObs = 0;
  let propertyHasPhotoElsewhere = 0;

  console.log('═'.repeat(110));
  for (const d of drafts) {
    const o = obsById.get(d.observation_id);
    const photo = o && o.inspection_photo_id ? photoById.get(o.inspection_photo_id) : null;
    const prop = propById.get(d.property_id);
    const latestForProp = latestPhotoByProp.get(d.property_id);

    let status;
    if (!d.observation_id) {
      status = 'NO_OBS  (interaction has no observation_id at all)';
      noObs++;
    } else if (!o) {
      status = 'OBS_GONE  (observation_id set but row not found — orphaned FK)';
      hasObsPhotoIdBroken++;
    } else if (!o.inspection_photo_id) {
      status = 'OBS_NO_PHOTO_ID  (observation has no inspection_photo_id)';
      hasObsNoPhotoId++;
    } else if (!photo) {
      status = 'PHOTO_GONE  (inspection_photo_id set but row not found)';
      hasObsPhotoIdBroken++;
    } else if (!photo.storage_path) {
      status = 'PATH_NULL  (photo row exists but storage_path is null)';
      hasObsPhotoIdBroken++;
    } else {
      status = 'OK  (photo path resolvable)';
      hasObsHasPhoto++;
    }

    const fallbackNote = (!photo || !photo.storage_path) && latestForProp
      ? `  ↳ FALLBACK AVAILABLE: latest photo at this property = ${latestForProp.id.slice(0,8)} captured ${latestForProp.captured_at}`
      : '';
    if (fallbackNote) propertyHasPhotoElsewhere++;

    console.log(
      `${(prop && prop.street_address) || '?'}\n` +
      `  interaction ${d.id.slice(0,8)}  type=${d.type}  obs=${d.observation_id ? d.observation_id.slice(0,8) : '—'}  ` +
      `inspPhoto=${(o && o.inspection_photo_id) ? o.inspection_photo_id.slice(0,8) : '—'}\n` +
      `  → ${status}${fallbackNote}\n`
    );
  }
  console.log('═'.repeat(110));
  console.log('\nSUMMARY');
  console.log(`  OK (photo resolves):              ${hasObsHasPhoto}`);
  console.log(`  Obs has no inspection_photo_id:   ${hasObsNoPhotoId}`);
  console.log(`  Obs missing / FK broken / path:   ${hasObsPhotoIdBroken}`);
  console.log(`  Interaction has no observation:   ${noObs}`);
  console.log(`  Property HAS a usable photo from a sibling row (fallback would work): ${propertyHasPhotoElsewhere}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
