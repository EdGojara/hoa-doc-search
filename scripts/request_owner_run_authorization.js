#!/usr/bin/env node
// Request the owner's authorization of a package of prepared accounting runs (migration 566).
//   node scripts/request_owner_run_authorization.js --verify <run_id>[:id,id,...] ...
//   node scripts/request_owner_run_authorization.js --send --summary "..." <run_id>[:id,id,...] ...
// A run given without ":ids" includes every unposted item. --verify only checks and prints;
// --send verifies, records the request and emails it from Tessa's mailbox to the owner.
// Requesting authorizes nothing: only the owner's verified "approved" reply does (lib/ea/tessa_inbox.js).
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const ORA = require('../lib/accounting/owner_run_authorization');
const OA = require('../lib/onboarding/owner_authorization');
const graphSend = require('../lib/email/graph_send');

(async () => {
  const args = process.argv.slice(2);
  const send = args.includes('--send');
  const si = args.indexOf('--summary'); const summary = si >= 0 ? args[si + 1] : null;
  const list = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--summary').map((a) => {
    const k = a.indexOf(':'); const run_id = k < 0 ? a : a.slice(0, k); const ids = k < 0 ? '' : a.slice(k + 1); return { run_id, include: ids ? ids.split(',').filter(Boolean) : null };
  });
  if (!list.length) throw new Error('list at least one run id');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const verified = await ORA.verifyPackage(supabase, list);
  for (const v of verified) {
    console.log(`${v.run.id} ${v.run.process} ${String(v.run.period_month).slice(0, 7)}: ${v.ok ? 'OK' : 'NOT OK'} · ${v.units.length} item(s)`);
    for (const p of v.problems) console.log('   problem: ' + p);
    for (const n of v.notes) console.log('   note: ' + n);
  }
  if (!send) return;
  if (!summary || summary.trim().length < 10) throw new Error('--summary "<what this package is>" is required to send');
  const rpc = async (name, a) => { const { data, error } = await supabase.rpc(name, a); if (error) throw new Error(error.message); return data; };
  const out = await ORA.requestPackage({ supabase, rpc, list: verified.map((v) => ({ run_id: v.run.id, include: v.include })), summary,
    ownerEmail: graphSend.ED_MAILBOX, fromMailbox: graphSend.TESSA_MAILBOX, send: (m) => OA.graphSendTracked(graphSend, m) });
  console.log('requested', JSON.stringify(out));
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
