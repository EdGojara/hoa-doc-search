#!/usr/bin/env node
// ============================================================================
// scripts/request_arc_acc_authorization.js  (Ed 2026-11-26)
// ----------------------------------------------------------------------------
// Send the owner ONE Owner Authorization Service request for a package of
// ARC/ACC items (lib/authorization/arc_acc). The spec is a JSON array of items
// (see buildPackage); it lives outside the repository because it names cases.
//
//   node scripts/request_arc_acc_authorization.js <spec.json> --dry [--out preview.html]
//       verifies every item exactly as the request would (open, unchanged, the
//       ACC authority preflight, the builder city-letter validator, one email per
//       recipient) and writes the request email it would send. Sends nothing.
//   node scripts/request_arc_acc_authorization.js <spec.json> --send --summary "..."
//       creates the request (owner_authorization_request_arc_acc, migration 582)
//       and emails it to the owner from Tessa's mailbox. Nothing is decided or sent
//       to anyone else until the owner replies "approved".
// ============================================================================
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

async function main() {
  const args = process.argv.slice(2);
  const specPath = args.find((a) => !a.startsWith('--'));
  const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null; };
  if (!specPath || (!flag('--dry') && !flag('--send'))) { console.error('usage: request_arc_acc_authorization.js <spec.json> --dry [--out file] | --send --summary "..."'); process.exit(2); }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const AA = require('../lib/authorization/arc_acc');
  // The same checks the server's executors run (lib/acc/owner_preflight, the city-letter validator).
  AA.registerExecutor('acc', { preflight: (id, body, actor) => require('../lib/acc/owner_preflight').preflight(supabase, { id, body, actor }) });
  AA.registerExecutor('builder', { validate: (id) => require('../lib/builder_letter_validate').validateApplicationForLetterById(supabase, id) });
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

  if (flag('--dry')) {
    const pkg = await AA.buildPackage(supabase, spec);
    const mail = AA.renderRequest({ subject: AA.requestSubject('DRYRUN00', pkg.items), shown: pkg.shown, expiresAt: '(set when sent)' });
    const out = typeof flag('--out') === 'string' ? flag('--out') : path.join(path.dirname(specPath), 'arc-acc-request-preview.html');
    fs.writeFileSync(out, `<!doctype html><meta charset="utf-8"><title>${mail.subject}</title><body style="max-width:900px;margin:20px auto;font-family:Arial">${mail.html}</body>`);
    console.log(JSON.stringify({ ok: pkg.ok, items: pkg.items.length, tier: pkg.tier, problems: pkg.problems, preview: out }, null, 2));
    process.exit(pkg.ok ? 0 : 1);
  }
  const summary = typeof flag('--summary') === 'string' ? flag('--summary') : 'Architectural decisions and correspondence prepared by Annie and Amanda.';
  const g = require('../lib/email/graph_send');
  const OA = require('../lib/onboarding/owner_authorization');
  const rpc = async (name, a) => { const { data, error } = await supabase.rpc(name, a); if (error) throw new Error(`${name}: ${error.message}`); return data; };
  const r = await AA.requestPackage({ supabase, rpc, spec, ownerEmail: g.ED_MAILBOX, fromMailbox: g.TESSA_MAILBOX, summary, send: (m) => OA.graphSendTracked(g, m) });
  console.log(JSON.stringify({ ok: true, ...r }, null, 2));
}

main().catch((e) => { console.error('FAILED:', e.message, e.problems ? JSON.stringify(e.problems, null, 2) : ''); process.exit(1); });
