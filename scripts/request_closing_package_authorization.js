#!/usr/bin/env node
// ============================================================================
// scripts/request_closing_package_authorization.js  (Ed 2026-11-27)
// ----------------------------------------------------------------------------
// Tessa sends the owner ONE Owner Authorization Service request for a community's
// closing package (lib/home_sales/transfer_package; migration 583). It is the same
// package Ownership Review shows; the owner approves it by replying "approved", and
// the reply is executed by the existing package workflow (lib/ea/tessa_inbox).
//
//   node scripts/request_closing_package_authorization.js <community_id> --dry [--out preview.html]
//       builds the package and writes the request email it would send. Sends nothing.
//   node scripts/request_closing_package_authorization.js <community_id> --send [--summary "..."]
//       creates the request and emails it from Tessa's mailbox. Nothing is transferred
//       or charged until the owner replies "approved".
// ============================================================================
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

async function main() {
  const args = process.argv.slice(2);
  const cid = args.find((a) => !a.startsWith('--'));
  const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null; };
  if (!/^[0-9a-f-]{36}$/i.test(String(cid || '')) || (!flag('--dry') && !flag('--send'))) { console.error('usage: request_closing_package_authorization.js <community_id> --dry [--out file] | --send [--summary "..."]'); process.exit(2); }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const TPKG = require('../lib/home_sales/transfer_package');
  if (flag('--dry')) {
    const pkg = await TPKG.buildPackage(supabase, { communityId: cid });
    const { data: c, error } = await supabase.from('communities').select('name').eq('id', cid).maybeSingle();
    if (error) throw new Error(error.message);
    const mail = TPKG.renderRequest({ subject: TPKG.requestSubject('DRYRUN00', (c && c.name) || 'Community', pkg.totals), pkg, communityName: (c && c.name) || 'Community', expiresAt: '(set when sent)' });
    const out = typeof flag('--out') === 'string' ? flag('--out') : path.join(process.cwd(), 'closing-package-request-preview.html');
    fs.writeFileSync(out, `<!doctype html><meta charset="utf-8"><title>${mail.subject}</title><body style="max-width:900px;margin:20px auto;font-family:Arial">${mail.html}</body>`);
    console.log(JSON.stringify({ transfers: pkg.rows.length, totals: pkg.totals, excluded: pkg.excluded.length, fingerprint: pkg.fingerprint, subject: mail.subject, preview: out }, null, 2));
    return;
  }
  const g = require('../lib/email/graph_send');
  const OA = require('../lib/onboarding/owner_authorization');
  const rpc = async (name, a) => { const { data, error } = await supabase.rpc(name, a); if (error) throw new Error(`${name}: ${error.message}`); return data; };
  const summary = typeof flag('--summary') === 'string' ? flag('--summary') : 'Completed builder closings: ownership transfers at recorded settlement dates, the builder and buyer prorations they post, and the buyer capitalization fees. Prepared by Reese and Kat, coordinated by Amanda.';
  const r = await TPKG.requestAuthorization({ supabase, rpc, communityId: cid, ownerEmail: g.ED_MAILBOX, fromMailbox: g.TESSA_MAILBOX, summary, send: (m) => OA.graphSendTracked(g, m) });
  console.log(JSON.stringify({ ok: true, ...r }, null, 2));
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
