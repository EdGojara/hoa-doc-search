#!/usr/bin/env node
// ============================================================================
// scripts/request_check_allocation_authorization.js  (Ed 2026-11-28, migration 584)
// ----------------------------------------------------------------------------
// Tessa sends the owner ONE Owner Authorization Service request to record prepared
// split checks (lib/authorization/check_allocations). The owner replies "approved";
// Kat records each check through Check Receipts (lib/ea/tessa_inbox).
//
//   node scripts/request_check_allocation_authorization.js <receipt_id>[,<receipt_id>...] --dry [--out preview.html]
//   node scripts/request_check_allocation_authorization.js <receipt_id>[,...] --send [--summary "..."]
// ============================================================================
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

async function main() {
  const args = process.argv.slice(2);
  const ids = String(args.find((a) => !a.startsWith('--')) || '').split(',').map((x) => x.trim()).filter(Boolean);
  const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null; };
  if (!ids.length || ids.some((x) => !/^[0-9a-f-]{36}$/i.test(x)) || (!flag('--dry') && !flag('--send'))) { console.error('usage: request_check_allocation_authorization.js <receipt_id,...> --dry [--out file] | --send [--summary "..."]'); process.exit(2); }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const CA = require('../lib/authorization/check_allocations');
  if (flag('--dry')) {
    const pkg = await CA.buildPackage(supabase, ids);
    const mail = CA.renderRequest({ subject: CA.requestSubject('DRYRUN00', pkg.checks), checks: pkg.checks, communityName: '(community)', expiresAt: '(set when sent)' });
    const out = typeof flag('--out') === 'string' ? flag('--out') : path.join(process.cwd(), 'check-allocation-request-preview.txt');
    fs.writeFileSync(out, mail.text);
    console.log(JSON.stringify({ ok: pkg.ok, checks: pkg.checks.length, problems: pkg.problems, subject: mail.subject, preview: out }, null, 2));
    process.exit(pkg.ok ? 0 : 1);
  }
  const g = require('../lib/email/graph_send');
  const OA = require('../lib/onboarding/owner_authorization');
  const rpc = async (name, a) => { const { data, error } = await supabase.rpc(name, a); if (error) throw new Error(`${name}: ${error.message}`); return data; };
  const summary = typeof flag('--summary') === 'string' ? flag('--summary') : 'Closing checks split by settlement statement between the seller and buyer accounts. Prepared by Reese and Kat, coordinated by Amanda.';
  const r = await CA.requestAuthorization({ supabase, rpc, receiptIds: ids, ownerEmail: g.ED_MAILBOX, fromMailbox: g.TESSA_MAILBOX, summary, send: (m) => OA.graphSendTracked(g, m) });
  console.log(JSON.stringify({ ok: true, ...r }, null, 2));
}

main().catch((e) => { console.error('FAILED:', e.message, e.problems ? JSON.stringify(e.problems, null, 2) : ''); process.exit(1); });
