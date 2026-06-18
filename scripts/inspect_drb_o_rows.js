require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  const { data: drbs } = await supabase
    .from('builder_companies')
    .select('id, company_name, status')
    .ilike('company_name', '%DRB%');
  const drb = drbs.find((d) => d.status === 'active') || drbs[0];

  // August Meadows community id
  const { data: amCo } = await supabase
    .from('communities')
    .select('id, name, slug')
    .ilike('name', '%august meadows%')
    .limit(1)
    .maybeSingle();
  console.log(`DRB: ${drb.id} (${drb.status})`);
  console.log(`August Meadows: ${amCo?.id} (${amCo?.slug})\n`);

  // Pull /O rows specifically with their full status + approvals
  const { data: oPlans } = await supabase
    .from('master_plans')
    .select(`
      id, plan_number, plan_name, elevation, status, builder_company_id, created_at,
      approvals:master_plan_community_approvals(community_id, retired_at, approved_at, approved_by)
    `)
    .eq('builder_company_id', drb.id)
    .eq('elevation', 'O')
    .order('plan_number');

  console.log(`DRB /O master_plans rows: ${oPlans.length}\n`);
  for (const p of oPlans) {
    const amApproval = (p.approvals || []).find((a) => a.community_id === amCo?.id);
    const allComms = (p.approvals || []).map((a) => `${a.community_id.slice(0, 8)}${a.retired_at ? '(retired)' : ''}`).join(', ');
    console.log(`Plan ${p.plan_number}/O (${p.plan_name || '—'})`);
    console.log(`  id: ${p.id}`);
    console.log(`  status: ${p.status}`);
    console.log(`  builder_company_id: ${p.builder_company_id}`);
    console.log(`  approvals across all communities: [${allComms}]`);
    console.log(`  August Meadows approval: ${amApproval ? (amApproval.retired_at ? `RETIRED at ${amApproval.retired_at}` : `active (by ${amApproval.approved_by})`) : 'NONE'}`);
    console.log('');
  }
})();
