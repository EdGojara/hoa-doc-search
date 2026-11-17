#!/usr/bin/env node
// Execute Kat runs on the owner's explicit instruction, under an execution grant the owner issued
// while signed in (migration 567). Each run is verified first (balanced, not a duplicate, nothing
// blocking) and the owner's exact words are recorded on it.
//   node scripts/execute_runs_under_grant.js --grant <grant_id> --instruction "<owner's exact words>" <run_id>[:id,id] ...
// Refuses with no active grant, a run outside the grant, a run above its ceiling, or a failed check.
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const MR = require('../lib/accounting/monthly_runs');

(async () => {
  const args = process.argv.slice(2);
  const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const grant = val('--grant'); const instruction = val('--instruction');
  const runs = args.filter((a, i) => !a.startsWith('--') && !['--grant', '--instruction'].includes(args[i - 1])).map((a) => { const [run_id, ids] = a.split(':'); return { run_id, include: ids ? ids.split(',') : [] }; });
  if (!grant || !instruction || !runs.length) throw new Error('usage: --grant <id> --instruction "<exact words>" <run_id>[:ids] ...');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  for (const r of runs) {
    try {
      const out = await MR.approveAndPost(supabase, { run_id: r.run_id, include: r.include, approval: { channel: 'owner_grant', grant_id: grant, instruction } });
      const res = out.result || {};
      console.log(`${r.run_id}: ${out.status} · ${(res.posted_entries || []).length} entr(ies)${res.status ? ' · ' + res.status : ''}`);
    } catch (e) { console.log(`${r.run_id}: NOT executed: ${e.message}`); }
  }
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
