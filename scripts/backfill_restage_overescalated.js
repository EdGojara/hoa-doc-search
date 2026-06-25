// One-time backfill: re-stage violations that were over-escalated by the
// cured-prior bug. Iterates every OPEN courtesy_1/courtesy_2 violation and runs
// the PRODUCTION _restageOpenViolation (downgrade-only, refuses certified §209),
// so the corrected escalation logic is applied uniformly — no parallel copy.
//   node scripts/backfill_restage_overescalated.js          (dry-run, lists changes)
//   node scripts/backfill_restage_overescalated.js --apply   (writes + logs each)
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { _restageOpenViolation } = require('../api/enforcement');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');
const log = (...a) => console.log(...a);

(async () => {
  // All open informal-stage violations (the only ones eligible to downgrade).
  const open = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('violations')
      .select('id, community_id, opened_at, current_stage')
      .in('current_stage', ['courtesy_1', 'courtesy_2'])
      .neq('quality_status', 'superseded')
      .order('opened_at', { ascending: false })
      .range(from, from + 999);
    if (error) { log('query error', error.message); process.exit(1); }
    open.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  log(`Open courtesy_1/courtesy_2 violations scanned: ${open.length}`);
  log(APPLY ? '\n*** APPLY MODE — writing changes ***\n' : '\n(dry-run — no writes; pass --apply to commit)\n');

  let changed = 0;
  for (const v of open) {
    const r = await _restageOpenViolation(v.id, { dryRun: !APPLY, reason: 'Backfill: cured-prior over-escalation correction' });
    if (r.changed) {
      changed++;
      log(`  ${v.id.slice(0, 8)}  ${String(v.opened_at).slice(0, 10)}  comm ${(v.community_id || '').slice(0, 8)}  ${r.from} -> ${r.to}`);
    }
  }
  log(`\n${APPLY ? 'Re-staged' : 'WOULD re-stage'}: ${changed} violation(s).`);
  if (!APPLY && changed) log('Re-run with --apply to commit.');
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
