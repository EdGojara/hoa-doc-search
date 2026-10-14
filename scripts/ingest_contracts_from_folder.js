// ============================================================================
// scripts/ingest_contracts_from_folder.js
// ----------------------------------------------------------------------------
// Emma's contract intake from a community's client folder (the synced OneDrive
// client folder). Any community, any folder: differences are arguments, not code.
// Plan-only by default; --apply files the originals and records signed agreements.
// See lib/contracts/folder_ingest.js for the controls.
//
//   node scripts/ingest_contracts_from_folder.js \
//     --community <community uuid> \
//     --root "C:\Users\...\OneDrive - ...\BEDROCK\Client - Canyon Gate at Cinco Ranch" \
//     --path Contracts --path "Proposals & Quotes/2027" \
//     [--as-of 2026-10-14] [--cache extractions.json] [--out results.json] [--apply]
//
// --cache keeps each document's extraction by content hash, so a plan run followed
// by --apply reads every document once.
// ============================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

function args(argv) {
  const o = { path: [] };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (k === 'apply') o.apply = true;
    else if (k === 'path') o.path.push(argv[++i]);
    else o[k.replace(/-/g, '_')] = argv[++i];
  }
  return o;
}

async function main() {
  const a = args(process.argv);
  if (!a.community || !a.root) { console.error('usage: --community <uuid> --root <client folder> [--path <sub>]... [--apply]'); process.exit(2); }
  const supabase = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { extractVendorContract } = require('../lib/accounting/vendor_contract_extractor');
  const { ingestFolder } = require('../lib/contracts/folder_ingest');
  const cache = a.cache && fs.existsSync(a.cache) ? JSON.parse(fs.readFileSync(a.cache, 'utf8')) : {};
  const root = path.resolve(a.root);
  const results = await ingestFolder(supabase, {
    community_id: a.community, folder: root, paths: a.path.length ? a.path.map((p) => path.join(root, p)) : null,
    source_label: `OneDrive/${path.basename(root)}`, as_of: a.as_of, apply: !!a.apply, extract: extractVendorContract, cache,
  });
  if (a.cache) fs.writeFileSync(a.cache, JSON.stringify(cache, null, 1));
  if (a.out) fs.writeFileSync(a.out, JSON.stringify(results, null, 1));
  for (const r of results) {
    const ex = r.extraction || {};
    console.log(`${r.outcome.padEnd(24)} ${r.source}`);
    if (r.plan) console.log(`   ${ex.document_kind} | ${ex.vendor_name || '-'} | ${ex.effective_date || '?'}..${ex.end_date || (ex.auto_renews ? 'auto-renews' : '?')} | ${ex.periodic_amount != null ? `$${ex.periodic_amount} ${ex.periodic_frequency || ''}` : ''} annual $${ex.annual_amount || 0} | ${r.plan.reason}${r.match ? ` | match: ${r.match.vendor_name || '-'} (${r.match.note})` : ''}`);
    else if (r.reason) console.log(`   ${r.reason}`);
  }
}

if (require.main === module) main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
module.exports = { args };
