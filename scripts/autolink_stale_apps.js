/*
 * One-time sweep: any builder_application with master_plan_id=NULL whose
 * (plan_number + elevation + builder + community) now perfectly matches an
 * approved master_plan with an active community approval gets auto-linked.
 *
 * Same logic the recommendation endpoint runs on-the-fly; this just walks
 * the queue once to backfill so Ed doesn't have to open every detail panel.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  const { data: stale } = await supabase
    .from('builder_applications')
    .select('id, reference_number, plan_number, elevation, builder_company_id, community_id, status')
    .is('master_plan_id', null)
    .not('builder_company_id', 'is', null)
    .not('plan_number', 'is', null)
    .not('elevation', 'is', null);

  console.log(`Found ${stale.length} apps with NULL master_plan_id\n`);

  let linked = 0;
  let stillStale = 0;
  for (const app of stale) {
    const { data: match } = await supabase
      .from('master_plans')
      .select('id, master_plan_community_approvals!inner(community_id, retired_at)')
      .eq('builder_company_id', app.builder_company_id)
      .eq('plan_number', app.plan_number)
      .eq('elevation', app.elevation)
      .eq('status', 'approved')
      .eq('master_plan_community_approvals.community_id', app.community_id)
      .is('master_plan_community_approvals.retired_at', null)
      .limit(1)
      .maybeSingle();
    if (match) {
      const { error: upErr } = await supabase
        .from('builder_applications')
        .update({ master_plan_id: match.id, fast_track: true })
        .eq('id', app.id);
      if (upErr) {
        console.log(`  ✗ ${app.reference_number} (${app.plan_number}/${app.elevation}) — link failed: ${upErr.message}`);
      } else {
        console.log(`  ✓ ${app.reference_number} (${app.plan_number}/${app.elevation}) → master ${match.id.slice(0, 8)} (fast-track)`);
        linked += 1;
      }
    } else {
      console.log(`  · ${app.reference_number} (${app.plan_number}/${app.elevation}) — no perfect match yet`);
      stillStale += 1;
    }
  }
  console.log(`\nDone. ${linked} linked, ${stillStale} still need attention.`);
})();
