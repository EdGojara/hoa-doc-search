// One-time LOPF drive consolidation + reset-for-review (Ed 2026-09-01).
// Merges the 8/31 fragmented drives into one, voids the new courtesy_1 violations
// that never got a letter, and resets their observations to pending so staff can
// do one final review (confirm → drafts first notice; reject → nothing orphaned).
// Fully backed up. Dry-run by default; pass --apply to write.
require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const { fetchAllQuery } = require('../lib/db/fetch_all');
const cid = 'a0000000-0000-4000-8000-000000000002';
const LTYPES = ['letter_courtesy_1','letter_courtesy_2','letter_209','letter_postcard_reminder'];
const APPLY = process.argv.includes('--apply');

(async () => {
  const insp = await fetchAllQuery(()=>supabase.from('inspections').select('id, status, created_at').eq('community_id',cid).gte('created_at','2026-08-31'),{orderBy:'created_at'});
  const photoCounts={}; for(const i of insp){const{count}=await supabase.from('inspection_photos').select('id',{count:'exact',head:true}).eq('inspection_id',i.id);photoCounts[i.id]=count||0;}
  const primary = insp.slice().sort((a,b)=>photoCounts[b.id]-photoCounts[a.id])[0];
  const mergeFrom = insp.filter(i=>i.id!==primary.id);

  const obs = await fetchAllQuery(()=>supabase.from('property_observations').select('*').eq('community_id',cid).gte('created_at','2026-08-31'),{orderBy:'created_at'});
  const activeIds = obs.filter(o=>o.reviewer_status!=='rejected').map(o=>o.id);
  const opened=[]; for(let i=0;i<activeIds.length;i+=200){const{data:vs}=await supabase.from('violations').select('*').in('opened_from_observation_id',activeIds.slice(i,i+200));opened.push(...(vs||[]));}
  const openedIds=opened.map(v=>v.id); const withLetter=new Set();
  for(let i=0;i<openedIds.length;i+=200){const{data:l}=await supabase.from('interactions').select('violation_id').in('violation_id',openedIds.slice(i,i+200)).in('type',LTYPES);(l||[]).forEach(x=>withLetter.add(x.violation_id));}
  const target = opened.filter(v=>!v.resolved_at && v.current_stage==='courtesy_1' && !withLetter.has(v.id));
  const targetObsIds = target.map(v=>v.opened_from_observation_id).filter(Boolean);

  const photos = await fetchAllQuery(()=>supabase.from('inspection_photos').select('id, inspection_id').in('inspection_id', insp.map(i=>i.id)),{orderBy:'id'});

  console.log(`Primary inspection: ${primary.id} (${photoCounts[primary.id]} photos)`);
  console.log(`Merge ${mergeFrom.length} other inspections into it (${photos.length} photos, ${obs.length} observations total)`);
  console.log(`Void + reset-to-pending: ${target.length} new courtesy_1 violations (no letter) + ${targetObsIds.length} observations`);
  console.log(`Leave untouched: ${withLetter.size} violations that already have a letter\n`);

  // BACKUP everything we mutate
  const backup = {
    generated_for:'lopf-merge-review-2026-09-01',
    primary_inspection: primary.id,
    photos_original: photos.map(p=>({id:p.id, inspection_id:p.inspection_id})),
    observations_original: obs.map(o=>({id:o.id, inspection_id:o.inspection_id, reviewer_status:o.reviewer_status, reviewed_at:o.reviewed_at, reviewer_user_id:o.reviewer_user_id, reviewer_notes:o.reviewer_notes})),
    voided_violations: target.map(v=>({id:v.id, current_stage:v.current_stage, resolved_via:v.resolved_via, resolved_at:v.resolved_at, resolved_notes:v.resolved_notes})),
  };
  fs.writeFileSync('backups/lopf-merge-review-2026-09-01.json', JSON.stringify(backup,null,2));
  console.log('Backup written → backups/lopf-merge-review-2026-09-01.json');

  if(!APPLY){ console.log('\nDRY RUN — pass --apply to write.'); return; }

  // 1) Merge photos + observations into primary
  const otherIds = mergeFrom.map(i=>i.id);
  for(let i=0;i<otherIds.length;i+=50){
    await supabase.from('inspection_photos').update({inspection_id:primary.id}).in('inspection_id',otherIds.slice(i,i+50));
    await supabase.from('property_observations').update({inspection_id:primary.id}).in('inspection_id',otherIds.slice(i,i+50));
  }
  console.log('✓ merged photos + observations into primary');

  // 2) Void the target violations
  let voided=0;
  for(let i=0;i<target.length;i+=100){
    const ids=target.slice(i,i+100).map(v=>v.id);
    const {error}=await supabase.from('violations').update({current_stage:'voided', resolved_via:'voided', resolved_at:new Date().toISOString(), resolved_notes:'[stale-drive-review] Auto-opened without review on the fragmented 8/31 LOPF drive; reset for staff final review (confirm re-opens + drafts first notice).'}).in('id',ids);
    if(!error)voided+=ids.length; else console.warn('void batch err',error.message);
  }
  console.log(`✓ voided ${voided} violations`);

  // 3) Reset their observations to pending
  let reset=0;
  for(let i=0;i<targetObsIds.length;i+=100){
    const ids=targetObsIds.slice(i,i+100);
    const {error}=await supabase.from('property_observations').update({reviewer_status:'pending', reviewed_at:null, reviewer_user_id:null, reviewer_notes:null}).in('id',ids);
    if(!error)reset+=ids.length; else console.warn('reset batch err',error.message);
  }
  console.log(`✓ reset ${reset} observations to pending`);

  // 4) Primary inspection reviewable
  await supabase.from('inspections').update({status:'ai_analyzed'}).eq('id',primary.id);
  console.log('✓ primary inspection set to ai_analyzed (reviewable)');
  console.log('\nDONE.');
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
