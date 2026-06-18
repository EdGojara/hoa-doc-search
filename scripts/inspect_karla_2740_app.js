require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  // Look at every received/approved app for plan 2740 + elevation O-ish
  const { data: apps } = await supabase
    .from('builder_applications')
    .select('id, reference_number, plan_number, elevation, master_plan_id, fast_track, status, street_address, community_id, builder_company_id, created_at')
    .like('reference_number', 'AM-BLD-2026-%')
    .order('created_at', { ascending: true });

  console.log(`Apps:`);
  for (const a of apps) {
    const pn = JSON.stringify(a.plan_number);
    const ev = JSON.stringify(a.elevation);
    const mp = a.master_plan_id ? a.master_plan_id.slice(0, 8) : 'NULL';
    console.log(`  ${a.reference_number}  pn=${pn} ev=${ev} master_plan_id=${mp} fast_track=${a.fast_track} status=${a.status}`);
  }

  // Specifically check the master_plans /O elevations for casing
  const { data: drbs } = await supabase
    .from('builder_companies')
    .select('id, status').ilike('company_name', '%DRB%');
  const drb = drbs.find((d) => d.status === 'active') || drbs[0];
  const { data: mps } = await supabase
    .from('master_plans')
    .select('id, plan_number, elevation')
    .eq('builder_company_id', drb.id)
    .eq('elevation', 'O');
  console.log(`\nDRB master_plans where elevation EXACTLY = 'O': ${mps.length}`);
  mps.forEach((m) => console.log(`  Plan ${JSON.stringify(m.plan_number)} elevation=${JSON.stringify(m.elevation)} id=${m.id}`));
})();
