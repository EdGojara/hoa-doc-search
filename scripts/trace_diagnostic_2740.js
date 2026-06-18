require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  // App 0020 = 2740/O for DRB at August Meadows
  const { data: app } = await supabase
    .from('builder_applications')
    .select('id, plan_number, elevation, master_plan_id, builder_company_id, community_id, street_address, fast_track')
    .eq('reference_number', 'AM-BLD-2026-0020')
    .maybeSingle();
  console.log('App 0020:', app);

  // Run the EXACT diagnostic query
  const { data: nearMatches, error } = await supabase
    .from('master_plans')
    .select(`
      id, plan_number, elevation, status, builder_company_id,
      builder:builder_company_id(id, company_name, status),
      approvals:master_plan_community_approvals(community_id, retired_at)
    `)
    .eq('builder_company_id', app.builder_company_id)
    .ilike('plan_number', `${(app.plan_number || '').replace(/[%_]/g, '')}%`)
    .limit(20);
  if (error) { console.error(error); process.exit(1); }

  console.log(`\nnearMatches returned: ${nearMatches.length}`);
  for (const m of nearMatches) {
    const apprs = (m.approvals || []).map((a) => `${a.community_id.slice(0, 8)}${a.retired_at ? '(retired)' : ''}`).join(',');
    console.log(`  ${m.plan_number}/${m.elevation}  status=${m.status}  builder=${m.builder?.company_name}/${m.builder?.status}  approvals=[${apprs}]`);
  }
})();
