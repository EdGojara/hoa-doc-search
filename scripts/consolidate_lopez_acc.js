require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const SURVIVOR = '9c843745-a0aa-4d7d-a182-4057b3cb2dbd'; // 0005 — has engineering plans + active gmail, not acknowledged
const WITHDRAW = ['ecd1e0dd-ee8f-468d-9ba7-ad5ed93487c0', 'b097b806-bc87-4cff-8f28-15358cd1a2e1']; // 0003 superseded + phantom decided
const PORTAL_APP = '2aaeaf07-c0a9-4921-8fad-2e7c096157aa'; // community_applications EAG-ARC-2026-0001
const CANONICAL_REF = 'EAG-ARC-2026-0001';

const DRY = process.argv.includes('--dry');

async function upd(table, id, patch, extraEq) {
  let q = supabase.from(table).update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (extraEq) q = q.eq(extraEq[0], extraEq[1]);
  const { data, error } = await q.select('id').maybeSingle();
  if (error) { console.log(`  ✗ ${table} ${id.slice(0,8)}: ${error.message}`); return false; }
  console.log(`  ✓ ${table} ${id.slice(0,8)} updated`);
  return true;
}

(async () => {
  console.log(DRY ? '=== DRY RUN ===' : '=== APPLYING ===');

  // 1) Survivor: canonical ref + link to portal app.
  console.log('\n1) Survivor 9c843745 → ref=' + CANONICAL_REF + ', link portal app');
  if (!DRY) await upd('acc_decisions', SURVIVOR, {
    reference_number: CANONICAL_REF,
    community_application_id: PORTAL_APP,
  });

  // 2) Portal app → point at survivor decision.
  console.log('\n2) Portal app 2aaeaf07 → acc_decision_id=survivor');
  if (!DRY) await upd('community_applications', PORTAL_APP, { acc_decision_id: SURVIVOR });

  // 3) Withdraw superseded + phantom rows.
  console.log('\n3) Withdraw superseded/phantom rows');
  for (const id of WITHDRAW) {
    if (!DRY) await upd('acc_decisions', id, { status: 'withdrawn' });
    else console.log(`  (dry) would withdraw ${id.slice(0,8)}`);
  }

  // 4) Verify final state.
  console.log('\n--- POST STATE ---');
  const { data, error } = await supabase.from('acc_decisions')
    .select('id, status, decision_type, reference_number, submitter_email, community_application_id, acknowledged_at')
    .in('id', [SURVIVOR, ...WITHDRAW]);
  if (error) { console.log('verify error', error.message); return; }
  for (const d of (data||[])) {
    const tag = d.id === SURVIVOR ? 'SURVIVOR' : 'withdrawn?';
    console.log(`  ${d.id.slice(0,8)} [${tag}] status=${d.status} ref=${d.reference_number} email=${d.submitter_email} appLink=${d.community_application_id} ack=${d.acknowledged_at}`);
  }
  const { data: capp } = await supabase.from('community_applications').select('id, reference_number, acc_decision_id, final_status').eq('id', PORTAL_APP).maybeSingle();
  console.log(`  PORTAL ${capp?.reference_number}: acc_decision_id=${capp?.acc_decision_id} status=${capp?.final_status}`);
})();
