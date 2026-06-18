require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  // Find DRB builder id
  const { data: drbs } = await supabase
    .from('builder_companies')
    .select('id, company_name, status')
    .ilike('company_name', '%DRB%');
  console.log('DRB builder rows:');
  drbs.forEach((d) => console.log(`  ${d.id}  ${d.company_name}  (${d.status})`));
  const drb = drbs.find((d) => d.status === 'active') || drbs[0];
  if (!drb) { console.error('no DRB builder found'); process.exit(1); }

  // Pull every master_plan for DRB grouped by plan_number
  const { data: plans, error } = await supabase
    .from('master_plans')
    .select('id, plan_number, plan_name, elevation, elevation_orientation, status, library_document_id, created_at')
    .eq('builder_company_id', drb.id)
    .order('plan_number')
    .order('elevation');
  if (error) { console.error(error); process.exit(1); }

  console.log(`\nDRB master_plans rows: ${plans.length}\n`);

  const byPlan = {};
  for (const p of plans) (byPlan[p.plan_number] ||= []).push(p);
  for (const [pn, rows] of Object.entries(byPlan)) {
    const elevs = rows.map((r) => r.elevation).sort().join(', ');
    console.log(`  Plan ${pn} (${rows[0].plan_name || '—'}): elevations [${elevs}] (${rows.length} rows)`);
  }

  // Specifically check what's MISSING for each plan where Karla submitted /O
  const oCheckPlans = ['2740', '2210', '2170', '2500', '2640', '1970', '1960'];
  console.log('\nPer-plan /O presence:');
  for (const pn of oCheckPlans) {
    const rows = byPlan[pn] || [];
    const hasO = rows.some((r) => r.elevation === 'O');
    console.log(`  Plan ${pn}: ${hasO ? '✓ has /O' : '✗ MISSING /O'} (has ${rows.map((r) => r.elevation).sort().join('/')})`);
  }

  // Look at the library_documents underlying these plans — was the /O sheet uploaded?
  const libDocIds = [...new Set(plans.map((p) => p.library_document_id).filter(Boolean))];
  if (libDocIds.length) {
    const { data: docs } = await supabase
      .from('library_documents')
      .select('id, title, file_path, category, created_at')
      .in('id', libDocIds);
    console.log('\nUnderlying library_documents:');
    docs.forEach((d) => console.log(`  ${d.id} — ${d.title} (${d.category})`));
  }
})();
