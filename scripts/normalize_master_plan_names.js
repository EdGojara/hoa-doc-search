#!/usr/bin/env node
// ===========================================================================
// normalize_master_plan_names.js  (Ed 2026-06-30)
// ---------------------------------------------------------------------------
// Master-plan rows that share a plan_number sometimes carry inconsistent
// plan_name values — blank on some elevation rows, the marketing name on
// others (seen at Lennar/Still Creek: 4506 "Wakefield II" + blank, 450N
// "Oak Hill IV" + blank). The grouped approval letter renderer already
// defends against this for display, but the blank rows also leak into the
// per-lot submission dropdown and precedents, so normalize at the source.
//
// For each (builder_company_id, plan_number) group, picks the best plan_name
// (longest non-blank) and updates every row in the group whose plan_name
// differs to match it. NEVER overwrites a non-blank name with a different
// non-blank name unless the chosen one is strictly longer (the long form is
// the fully-typed marketing name); logs any genuine conflict for review.
//
// DRY RUN BY DEFAULT. Pass --apply to write. Requires SUPABASE_URL +
// SUPABASE_KEY (service role) in env, same as other data scripts.
//
//   node scripts/normalize_master_plan_names.js                 # preview
//   node scripts/normalize_master_plan_names.js --apply         # write
//   node scripts/normalize_master_plan_names.js --builder <uuid> --apply
// ===========================================================================

const { createClient } = require('@supabase/supabase-js');

const APPLY = process.argv.includes('--apply');
const builderIdx = process.argv.indexOf('--builder');
const ONLY_BUILDER = builderIdx > -1 ? process.argv[builderIdx + 1] : null;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

(async () => {
  let q = supabase
    .from('master_plans')
    .select('id, builder_company_id, plan_number, plan_name')
    .limit(5000);
  if (ONLY_BUILDER) q = q.eq('builder_company_id', ONLY_BUILDER);
  const { data: rows, error } = await q;
  if (error) { console.error('query failed:', error.message); process.exit(1); }

  // Group by builder + plan_number
  const groups = new Map();
  for (const r of (rows || [])) {
    const key = `${r.builder_company_id}::${String(r.plan_number || '').trim()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const updates = [];
  const conflicts = [];
  for (const [key, grp] of groups) {
    const names = [...new Set(grp.map((r) => (r.plan_name || '').trim()).filter(Boolean))];
    if (names.length <= 1) continue; // already consistent (or all blank)
    // Best = longest. Flag if two distinct non-blank names aren't prefix-ish.
    const best = names.slice().sort((a, b) => b.length - a.length)[0];
    const realConflict = names.some((n) => n && !best.toLowerCase().includes(n.toLowerCase()) && !n.toLowerCase().includes(best.toLowerCase()));
    if (realConflict) { conflicts.push({ key, names }); continue; }
    for (const r of grp) {
      if ((r.plan_name || '').trim() !== best) {
        updates.push({ id: r.id, plan_number: r.plan_number, from: r.plan_name, to: best });
      }
    }
  }

  console.log(`Groups scanned: ${groups.size}`);
  console.log(`Rows to update: ${updates.length}`);
  updates.forEach((u) => console.log(`  ${u.plan_number}: ${JSON.stringify(u.from)} -> ${JSON.stringify(u.to)}`));
  if (conflicts.length) {
    console.log(`\n⚠ ${conflicts.length} genuine name conflicts (NOT auto-fixed — review):`);
    conflicts.forEach((c) => console.log(`  ${c.key}: ${JSON.stringify(c.names)}`));
  }

  if (!APPLY) { console.log('\nDRY RUN — pass --apply to write.'); return; }
  let ok = 0, fail = 0;
  for (const u of updates) {
    const { error: e } = await supabase.from('master_plans').update({ plan_name: u.to }).eq('id', u.id);
    if (e) { fail++; console.error(`  FAIL ${u.id}: ${e.message}`); } else { ok++; }
  }
  console.log(`\nApplied: ${ok} updated, ${fail} failed.`);
})();
