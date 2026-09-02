// One-off consolidation: 4718 Tahoe Canyon Lane (Ed 2026-09-01).
// The 8/31 LOPF drive re-observed a tarped truck (Stored Vehicle) and the AI
// mislabeled it "RV / boat / trailer". The observation was corrected to Stored
// Vehicle but the VIOLATION kept the stale RV label, creating a phantom second
// case. Reconcile to ONE Stored Vehicle case at courtesy_1 (no mailed first
// notice on record, so it cannot be escalated). Reversible via /unvoid.
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const SURVIVOR = '9c5a25ea-d6ec-45c8-b1cc-777b8db6ab3b';   // original 8/1 Stored Vehicle (courtesy_1)
const DUP      = '6e63275a-52da-4309-83ce-1b86e6013c57';   // 8/31 drive, mislabeled RV, same tarped-truck issue
const SURV_OBS = '46081194-9845-4fb5-99fd-ef06286a4ad2';
const STORED_VEHICLE_CAT = '5dff839b-42fc-4734-9108-02a18c05d86a';
const EVIDENCE = 'A truck covered with a tarp is parked in the driveway and visible from the street.';
const ED = '387f44df-a73f-40b3-be28-e73b2303b7cf';
const now = new Date().toISOString();

(async () => {
  const { data: dup, error: de } = await sb.from('violations').select('*').eq('id', DUP).maybeSingle();
  if (de) { console.error('read DUP failed', de.message); process.exit(1); }
  if (!dup) { console.error('DUP not found'); process.exit(1); }
  if (['voided', 'cured', 'closed'].includes(dup.current_stage)) { console.error('DUP already', dup.current_stage, '- aborting'); process.exit(1); }
  const { data: surv, error: se } = await sb.from('violations').select('*').eq('id', SURVIVOR).maybeSingle();
  if (se) { console.error('read SURV failed', se.message); process.exit(1); }
  if (!surv) { console.error('SURVIVOR not found'); process.exit(1); }

  // 1. Carry the good evidence onto the survivor's observation (it was empty).
  const { data: sObs, error: soe } = await sb.from('property_observations').select('ai_description,reviewer_notes').eq('id', SURV_OBS).maybeSingle();
  if (soe) { console.error('read surv obs failed', soe.message); process.exit(1); }
  const note = `[Evidence carried from 8/31 drive obs 77be10ea on consolidation ${now.slice(0, 10)}]`;
  const obsPatch = { reviewer_notes: sObs && sObs.reviewer_notes ? `${note}\n${sObs.reviewer_notes}` : note };
  if (!sObs || !sObs.ai_description) obsPatch.ai_description = EVIDENCE;
  const { error: ue1 } = await sb.from('property_observations').update(obsPatch).eq('id', SURV_OBS);
  if (ue1) { console.error('update surv obs failed', ue1.message); process.exit(1); }
  console.log('1. Evidence carried onto survivor observation. ai_description set:', !!obsPatch.ai_description);

  // 2. Ensure survivor is Stored Vehicle @ courtesy_1.
  const survPatch = {};
  if (surv.primary_category_id !== STORED_VEHICLE_CAT) survPatch.primary_category_id = STORED_VEHICLE_CAT;
  if (surv.current_stage !== 'courtesy_1') { survPatch.current_stage = 'courtesy_1'; survPatch.current_stage_started_at = now; }
  if (Object.keys(survPatch).length) {
    const { error: ue2 } = await sb.from('violations').update(survPatch).eq('id', SURVIVOR);
    if (ue2) { console.error('update survivor failed', ue2.message); process.exit(1); }
    console.log('2. Survivor updated:', JSON.stringify(survPatch));
  } else console.log('2. Survivor already Stored Vehicle @ courtesy_1 - no change.');

  // 3. Void the mislabeled RV duplicate.
  const { error: ue3 } = await sb.from('violations').update({
    current_stage: 'voided', resolved_via: 'voided', resolved_at: now,
    resolved_notes: `Consolidated into Stored Vehicle case ${SURVIVOR} (same tarped-truck issue, 4718 Tahoe Canyon). AI mislabeled the 8/31 re-observation as "RV / boat / trailer"; the observation was corrected to Stored Vehicle but the violation kept the stale label. No separate RV/boat/trailer violation exists. (Ed 2026-09-01)`,
    reviewed_by_user_id: ED, reviewed_at: now,
  }).eq('id', DUP);
  if (ue3) { console.error('void dup failed', ue3.message); process.exit(1); }
  console.log('3. Duplicate RV case voided.');

  // 4. Audit row (merged_into) with snapshot for undo.
  const snapshot = { ...dup };
  const { error: ue4 } = await sb.from('violation_corrections').insert({
    original_violation_id: DUP,
    correction_type: 'merged_into',
    replacement_violation_id: SURVIVOR,
    reason: 'Mislabeled RV/boat/trailer duplicate consolidated into the Stored Vehicle case at 4718 Tahoe Canyon (same tarped-truck issue). Kept at courtesy_1 - no mailed first notice on record.',
    corrected_by_user_id: ED,
    original_state: snapshot,
    notes: 'Consolidation of an AI-mislabeled re-observation. Evidence carried to the survivor. Reversible via unvoid.',
  });
  if (ue4) { console.error('audit insert failed', ue4.message); process.exit(1); }
  console.log('4. Audit (merged_into) row written.');

  // 5. Verify final state.
  const { data: fin, error: fe } = await sb.from('violations')
    .select('id, primary_category_id, current_stage, resolved_at, source, opened_at')
    .eq('property_id', 'c7f7d1f8-e5b6-40a2-aa4e-f7149b2e5013').order('opened_at');
  if (fe) { console.error('verify failed', fe.message); process.exit(1); }
  console.log('\nFINAL STATE @ 4718 Tahoe Canyon:');
  for (const v of fin) {
    const cat = v.primary_category_id === STORED_VEHICLE_CAT ? 'Stored Vehicle' : v.primary_category_id;
    console.log('  ', v.id.slice(0, 8), '|', cat, '| stage:', v.current_stage, '| resolved:', v.resolved_at ? 'YES' : 'open', '| src:', v.source);
  }
})();
