// trace_one_draft.js — drill into a single draft interaction to find what
// photo source the letter generator is finding when interaction.observation_id is null.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function main() {
  const interactionId = process.argv[2] || '93e97d56';
  console.log(`\nTracing interaction ${interactionId}…\n`);

  // UUID column — can't do prefix match. Look up the full UUID via the
  // most-recent-drafts list, matching on prefix in JS.
  const { data: recent } = await supabase
    .from('interactions')
    .select('id')
    .eq('status', 'draft')
    .order('created_at', { ascending: false })
    .limit(50);
  const fullId = (recent || []).find(r => r.id.startsWith(interactionId));
  if (!fullId) { console.log('id prefix not found in recent drafts'); return; }
  const { data: ints } = await supabase
    .from('interactions')
    .select('*')
    .eq('id', fullId.id);
  if (!ints || ints.length === 0) { console.log('not found'); return; }
  const i = ints[0];

  console.log('INTERACTION:');
  console.log('  id          =', i.id);
  console.log('  type        =', i.type);
  console.log('  status      =', i.status);
  console.log('  property_id =', i.property_id);
  console.log('  observation_id =', i.observation_id);
  console.log('  violation_id =', i.violation_id);
  console.log('  inspection_id =', i.inspection_id);
  console.log('  content (PDF path) =', i.content);
  console.log('  bundle_id =', i.bundle_id);

  if (i.violation_id) {
    const { data: v } = await supabase.from('violations').select('*').eq('id', i.violation_id).maybeSingle();
    console.log('\nVIOLATION:');
    console.log('  id =', v && v.id);
    console.log('  observation_id =', v && v.observation_id);
    console.log('  source =', v && v.source);
    console.log('  primary_category_id =', v && v.primary_category_id);
    console.log('  current_stage =', v && v.current_stage);
    console.log('  opened_at =', v && v.opened_at);

    if (v && v.observation_id) {
      const { data: o } = await supabase.from('property_observations').select('*').eq('id', v.observation_id).maybeSingle();
      console.log('\nVIOLATION.OBSERVATION:');
      console.log('  id =', o && o.id);
      console.log('  inspection_photo_id =', o && o.inspection_photo_id);
      console.log('  ai_description =', o && o.ai_description);
      if (o && o.inspection_photo_id) {
        const { data: p } = await supabase.from('inspection_photos').select('*').eq('id', o.inspection_photo_id).maybeSingle();
        console.log('\nVIOLATION.OBSERVATION.PHOTO:');
        console.log('  id =', p && p.id);
        console.log('  storage_path =', p && p.storage_path);
        console.log('  property_id =', p && p.property_id);
        console.log('  captured_at =', p && p.captured_at);
      }
    }

    // Prior violations at same property — used for "Second Notice" carry-over photo
    const { data: priors } = await supabase
      .from('violations')
      .select('id, current_stage, observation_id, opened_at, source')
      .eq('property_id', i.property_id)
      .neq('id', i.violation_id);
    console.log(`\nPRIOR VIOLATIONS at this property: ${priors ? priors.length : 0}`);
    for (const p of (priors || [])) {
      console.log(`  ${p.id.slice(0,8)}  stage=${p.current_stage}  obs=${p.observation_id ? p.observation_id.slice(0,8) : '—'}  source=${p.source}  opened=${p.opened_at}`);
    }
  }

  // Any inspection_photos at this property at all?
  const { data: photos } = await supabase
    .from('inspection_photos')
    .select('id, storage_path, captured_at, inspection_id')
    .eq('property_id', i.property_id)
    .order('captured_at', { ascending: false });
  console.log(`\nALL inspection_photos at this property: ${photos ? photos.length : 0}`);
  for (const p of (photos || []).slice(0, 5)) {
    console.log(`  ${p.id.slice(0,8)}  path=${p.storage_path}  captured=${p.captured_at}  insp=${p.inspection_id ? p.inspection_id.slice(0,8) : '—'}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
