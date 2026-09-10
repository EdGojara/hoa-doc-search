// ============================================================================
// scripts/audit_fastlane_facts.js  (Ed 2026-09-10)
// ----------------------------------------------------------------------------
// Living gap report for Claire's fast-lane facts. For every Bedrock community,
// checks whether each operational fact the fast-lane answers is present in the
// context block Claire actually sees (buildCommunityContextBlock) — and marks
// facts N/A when they don't apply (no pool -> no pool hours; not on-site -> no
// on-site hours). So the "still missing" column is a REAL chase list, not noise.
//
// Detection logic is shared with the Community Profile page's live coverage
// panel via lib/community/fastlane_coverage.js (one source of truth).
//
// Re-run after any backfill:  node scripts/audit_fastlane_facts.js
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { buildCommunityContextBlock } = require('../api/communities');
const { FACTS, computeCoverage } = require('../lib/community/fastlane_coverage');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

(async () => {
  const { data: comms, error } = await supabase
    .from('communities')
    .select('id, name, profile')
    .order('name');
  if (error) throw error;

  const rows = [];
  const gaps = [];
  const totals = Object.fromEntries(FACTS.map((f) => [f.key, { pop: 0, applicable: 0 }]));
  let n = 0;

  for (const c of comms) {
    let block = '';
    try { block = (await buildCommunityContextBlock(c.id)) || ''; } catch (_) { /* skip */ }
    if (!block) continue; // non-Bedrock / unresolved
    n++;
    const cov = computeCoverage(block, c.profile || {});
    const cells = {};
    for (const { key, status } of cov) {
      cells[key] = status;
      if (status !== 'na') totals[key].applicable++;
      if (status === 'yes') totals[key].pop++;
      if (status === 'gap') gaps.push({ community: c.name, fact: key });
    }
    rows.push({ name: c.name, cells });
  }

  const fmt = (s) => (s === 'yes' ? 'yes' : s === 'gap' ? 'GAP' : '·').padEnd(10);
  const header = 'COMMUNITY'.padEnd(24) + FACTS.map((f) => f.key.slice(0, 9).padEnd(10)).join('');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of rows) console.log(r.name.slice(0, 23).padEnd(24) + FACTS.map((f) => fmt(r.cells[f.key])).join(''));
  console.log('-'.repeat(header.length));
  console.log('POPULATED / applicable'.padEnd(24) + FACTS.map((f) => `${totals[f.key].pop}/${totals[f.key].applicable}`.padEnd(10)).join(''));
  console.log(`\n(${n} communities · "·" = not applicable · GAP = applicable but missing)`);

  console.log('\n=== STILL MISSING (applicable gaps to backfill) ===');
  const byComm = {};
  for (const g of gaps) (byComm[g.community] = byComm[g.community] || []).push(g.fact);
  const names = Object.keys(byComm).sort();
  if (!names.length) console.log('  none — every applicable fact is populated.');
  for (const nm of names) console.log(`  ${nm}: ${byComm[nm].join(', ')}`);
})().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
