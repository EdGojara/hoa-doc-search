#!/usr/bin/env node
// ============================================================================
// scripts/request_legal_reversal.js  (Ed 2026-11-27, migration 585)
// ----------------------------------------------------------------------------
// Kat files ONE Owner Authorization Service request to reverse posted legal
// bill-backs (lib/authorization/legal_reversals); Tessa emails it to the owner
// from her mailbox. The owner replies "approved"; Kat reverses each posting
// through Legal Invoice Review's own reversal (lib/ea/tessa_inbox).
//
// Dry run by default (verifies every posting and writes the email preview; nothing
// is filed or sent). --send files the request and sends the email.
//
//   node scripts/request_legal_reversal.js <posting_id>[,<posting_id>...] --reason "..."
//        [--reversal-date YYYY-MM-DD] [--expect-amount 425.00] [--expect-address "100 Example"]
//        [--out preview.txt] [--send] [--summary "..."]
// ============================================================================
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const ids = String(argv.find((a) => !a.startsWith('--')) || '').split(',').map((x) => x.trim()).filter(Boolean);
  const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : null; };
  const str = (k) => (typeof flag(k) === 'string' ? flag(k) : null);
  const amt = str('--expect-amount');
  return { ids, send: !!flag('--send'), reason: str('--reason'), reversalDate: str('--reversal-date'), out: str('--out'), summary: str('--summary'),
    expect: { amount_cents: amt == null ? null : Math.round(Number(amt) * 100), address: str('--expect-address') } };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.ids.length || a.ids.some((x) => !/^[0-9a-f-]{36}$/i.test(x)) || !a.reason || (a.expect.amount_cents != null && !Number.isFinite(a.expect.amount_cents))) {
    console.error('usage: request_legal_reversal.js <posting_id,...> --reason "..." [--reversal-date YYYY-MM-DD] [--expect-amount N.NN] [--expect-address "..."] [--out file] [--send] [--summary "..."]');
    process.exit(2);
  }
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const LR = require('../lib/authorization/legal_reversals');
  const requests = a.ids.map((posting_id) => ({ posting_id, reason: a.reason, reversal_date: a.reversalDate, expect: a.expect }));
  if (!a.send) {
    const pkg = await LR.buildPackage(supabase, requests);
    const mail = LR.renderRequest({ subject: LR.requestSubject('DRYRUN00', pkg.postings), postings: pkg.postings, communityName: '(community)', expiresAt: '(set when sent)' });
    const out = a.out || path.join(process.cwd(), 'legal-reversal-request-preview.txt');
    fs.writeFileSync(out, mail.text);
    console.log(JSON.stringify({ ok: pkg.ok, dry_run: true, postings: pkg.postings.length, problems: pkg.problems, subject: mail.subject, preview: out }, null, 2));
    process.exit(pkg.ok ? 0 : 1);
  }
  const g = require('../lib/email/graph_send');
  const OA = require('../lib/onboarding/owner_authorization');
  const rpc = async (name, args) => { const { data, error } = await supabase.rpc(name, args); if (error) throw new Error(`${name}: ${error.message}`); return data; };
  const summary = a.summary || 'Duplicate legal bill-back reversal prepared by Kat, coordinated by Amanda.';
  const r = await LR.requestAuthorization({ supabase, rpc, requests, ownerEmail: g.ED_MAILBOX, fromMailbox: g.TESSA_MAILBOX, summary, send: (m) => OA.graphSendTracked(g, m) });
  console.log(JSON.stringify({ ok: true, ...r }, null, 2));
}

if (require.main === module) main().catch((e) => { console.error('FAILED:', e.message, e.problems ? JSON.stringify(e.problems, null, 2) : ''); process.exit(1); });
module.exports = { parseArgs };
