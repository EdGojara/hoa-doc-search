#!/usr/bin/env node
// ============================================================================
// scripts/request_portal_silent_create_authorization.js  (Ed 2026-11-27, migration 586)
// ----------------------------------------------------------------------------
// Tessa sends the owner ONE Owner Authorization Service request to create the
// eligible homeowner portal accounts silently (lib/authorization/portal_silent_create).
// The owner replies "approved" or "approved except <association>"; Amanda creates
// each association's accounts through the shared create path (lib/ea/tessa_inbox).
// No invitation is sent; portal_active, balances and payments are not touched.
//
//   node scripts/request_portal_silent_create_authorization.js <slug> [<slug>...] --dry [--out preview.txt] [--exceptions file.csv]
//   node scripts/request_portal_silent_create_authorization.js <slug> [<slug>...] --send [--summary "..."]
//
// --exceptions writes the shared-inbox exceptions (association, contact, lot, MASKED
// email, group size) for staff. Write it outside the repo: it names homeowners.
// ============================================================================
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

async function main() {
  const args = process.argv.slice(2);
  const valued = new Set(['--out', '--exceptions', '--summary']);
  const slugs = []; const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valued.has(a)) { flags[a] = args[i + 1]; i++; continue; }
    if (a.startsWith('--')) { flags[a] = true; continue; }
    slugs.push(a);
  }
  if (!slugs.length || slugs.some((s) => !/^[a-z0-9-]+$/.test(s)) || (!flags['--dry'] === !flags['--send'])) {
    console.error('usage: request_portal_silent_create_authorization.js <slug> [<slug>...] --dry [--out file] [--exceptions file.csv] | --send [--summary "..."]');
    process.exit(2);
  }
  const repo = path.resolve(__dirname, '..');
  if (flags['--exceptions'] && path.resolve(flags['--exceptions']).toLowerCase().startsWith(repo.toLowerCase())) {
    console.error('the exceptions file names homeowners: write it outside the repository'); process.exit(2);
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const PS = require('../lib/authorization/portal_silent_create');
  if (flags['--dry']) {
    const pkg = await PS.buildPackage(supabase, slugs);
    const mail = PS.renderRequest({ subject: PS.requestSubject('DRYRUN00', pkg.associations), associations: pkg.associations, nothing: pkg.nothing, expiresAt: '(set when sent)' });
    const out = typeof flags['--out'] === 'string' ? flags['--out'] : path.join(process.cwd(), 'portal-silent-create-request-preview.txt');
    fs.writeFileSync(out, mail.text);
    if (typeof flags['--exceptions'] === 'string') {
      const rows = [...pkg.associations, ...pkg.nothing].flatMap((a) => PS.sharedEmailExceptions(a.name, a.loaded ? a.loaded.roster : { skipped: [] }));
      const cols = ['association', 'shared_inbox_group', 'contact_name', 'lot_address', 'masked_email', 'group_size'];
      fs.writeFileSync(flags['--exceptions'], [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n');
      console.error(`shared-inbox exceptions: ${rows.length} owners written to ${flags['--exceptions']}`);
    }
    console.log(JSON.stringify({ ok: pkg.ok, problems: pkg.problems, subject: mail.subject, preview: out,
      associations: pkg.associations.map((a) => ({ name: a.name, accounts_to_create: a.accounts_to_create, multi_lot_accounts: a.multi_lot_accounts, existing_silent_accounts: a.existing_silent_accounts, skipped: a.skipped, cross_check: a.cross_check, roster_hash: a.roster_hash })),
      nothing_to_create: pkg.nothing.map((a) => a.name),
      total: pkg.associations.reduce((n, a) => n + a.accounts_to_create, 0) }, null, 2));
    process.exit(pkg.ok ? 0 : 1);
  }
  const g = require('../lib/email/graph_send');
  const OA = require('../lib/onboarding/owner_authorization');
  const rpc = async (name, a) => { const { data, error } = await supabase.rpc(name, a); if (error) throw new Error(`${name}: ${error.message}`); return data; };
  const summary = typeof flags['--summary'] === 'string' ? flags['--summary'] : 'Silent homeowner portal account creation before the 2027 assessment mailing, per Ed 11/27. Coordinated by Amanda; no invitations, portal stays off, balances and payments off.';
  const r = await PS.requestAuthorization({ supabase, rpc, slugs, ownerEmail: g.ED_MAILBOX, fromMailbox: g.TESSA_MAILBOX, summary, send: (m) => OA.graphSendTracked(g, m) });
  console.log(JSON.stringify({ ok: true, ...r }, null, 2));
}

main().catch((e) => { console.error('FAILED:', e.message, e.problems ? JSON.stringify(e.problems, null, 2) : ''); process.exit(1); });
