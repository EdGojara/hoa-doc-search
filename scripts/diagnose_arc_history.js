// What do we have to work with for an eval ground truth?
require('dotenv').config({ override: true });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function main() {
  const { count: totalCount } = await supabase
    .from('arc_historical_decisions')
    .select('id', { count: 'exact', head: true });
  console.log(`Total arc_historical_decisions rows: ${totalCount}`);

  // Per-community + per-decision-type breakdown
  const { data: comms } = await supabase
    .from('communities')
    .select('id, name')
    .order('name');

  console.log('\nPer-community breakdown:');
  for (const c of comms || []) {
    const { data: rows } = await supabase
      .from('arc_historical_decisions')
      .select('decision_type, project_type, project_description, conditions, decided_at')
      .eq('community_id', c.id)
      .limit(500);
    if (!rows || rows.length === 0) continue;
    const byType = {};
    for (const r of rows) {
      const k = r.decision_type || 'unknown';
      byType[k] = (byType[k] || 0) + 1;
    }
    const typeStr = Object.entries(byType).map(([k, n]) => `${k}=${n}`).join(', ');
    console.log(`  ${c.name.padEnd(36)} total=${rows.length}  (${typeStr})`);
  }

  // Sample rows
  console.log('\nSample rows (recent 8):');
  const { data: sample } = await supabase
    .from('arc_historical_decisions')
    .select('community_id, decided_at, project_type, decision_type, project_description, conditions, property_address')
    .order('decided_at', { ascending: false })
    .limit(8);
  (sample || []).forEach((r, i) => {
    console.log(`\n${i + 1}. ${r.decided_at || '(no date)'} — ${r.project_type || '?'} — ${r.decision_type || '?'}`);
    console.log(`   Property: ${r.property_address || '(none)'}`);
    console.log(`   Desc: ${(r.project_description || '').slice(0, 160)}`);
    console.log(`   Conditions: ${(r.conditions || '').slice(0, 160) || '(none)'}`);
  });

  // Quality check — how many have enough info to make a synthetic application?
  console.log('\nUsability check:');
  const { data: all } = await supabase
    .from('arc_historical_decisions')
    .select('decision_type, project_type, project_description, property_address, conditions');
  if (all) {
    const usable = all.filter((r) =>
      r.decision_type &&
      r.project_type &&
      (r.project_description || '').length > 30 &&
      r.property_address
    );
    console.log(`  Total rows: ${all.length}`);
    console.log(`  Usable as eval cases (has decision + type + desc + address): ${usable.length}`);
    console.log(`  Decision type distribution: ${JSON.stringify(usable.reduce((acc, r) => { acc[r.decision_type] = (acc[r.decision_type] || 0) + 1; return acc; }, {}))}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
