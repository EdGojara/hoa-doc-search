#!/usr/bin/env node
/**
 * seed_demo_clma_rfp.js — mirror the CLMA 2027 Landscape Maintenance RFP demo
 * into the EXISTING generic bid pipeline (bid_requests + vendor_proposals), so
 * the board demo's RFP/proposals are real records in the same tables the vendor
 * bid engine already uses (migrations 009/015/150) — not a bolt-on. The single
 * source of truth for the content is public/clma-rfp.demo.json; this script only
 * lands it in the pipeline and links Proposal A to the EXISTING GreenScape vendor
 * so the award -> vendor -> project -> asset -> invoice -> history chain is live.
 *
 * DEMO tenant only. Idempotent (stable ids + upsert). No schema changes.
 *
 *   node scripts/seed_demo_clma_rfp.js --execute
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const EXECUTE = process.argv.includes('--execute');

const MC = 'd0000000-0000-4000-a000-000000000000';   // DEMO management company
const CID = 'e0100000-0000-4000-a000-000000000000';  // Sterling Ridge (operating community)
const BID_ID = 'e01a0001-0000-4000-a000-000000000000';
// vendor ids: GreenScape + AquaFlow already exist; Verdant + Lone Star are new demo firms.
const VENDOR_ID = {
  greenscape: 'e0190001-0000-4000-a000-000000000000', // EXISTING — has live projects
  verdant:    'e0190006-0000-4000-a000-000000000000',
  lonestar:   'e0190007-0000-4000-a000-000000000000',
};
const PROPOSAL_ID = { A: 'e01b0001-0000-4000-a000-000000000000', B: 'e01b0002-0000-4000-a000-000000000000', C: 'e01b0003-0000-4000-a000-000000000000' };

function loadDemo() {
  const p = path.join(__dirname, '..', 'public', 'clma-rfp.demo.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Shape a proposal into the pipeline's extracted_data contract (same shape
// extractBidFromPDF emits: scope_items[], explicitly_excluded[], pricing_breakdown[]).
function toExtracted(p) {
  return {
    proposer_company_name: p.company,
    total_annual_amount: p.base_annual_cents / 100,
    stated_annual_amount: (p.base_annual_stated_cents != null ? p.base_annual_stated_cents : p.base_annual_cents) / 100,
    escalator_clause: p.escalation,
    response_standard: p.response,
    seasonal_color: p.seasonal_color,
    irrigation: p.irrigation,
    tree_work: p.tree_work,
    scope_items: [
      ...p.included.map((n) => ({ name: n, included: true })),
      ...p.excluded.map((n) => ({ name: n, included: false })),
    ],
    explicitly_excluded: p.excluded,
    allowances: p.allowances,
    pricing_breakdown: p.pricing_breakdown,
    references: p.references,
    extraction_confidence: 'demo_seed',
    notes: p.notes || null,
  };
}

async function main() {
  const D = loadDemo();
  console.log(`\nCLMA 2027 Landscape RFP -> bid pipeline — ${EXECUTE ? 'EXECUTE' : 'DRY RUN'}`);
  console.log(`  RFP: ${D.meta.title} (${D.proposals.length} proposals)`);
  D.proposals.forEach((p) => console.log(`   Proposal ${p.id}: ${p.company}  base ${(p.base_annual_cents/100).toLocaleString()}  vendor ${VENDOR_ID[p.vendor_key].slice(0,8)}`));
  if (!EXECUTE) { console.log('\nDRY RUN — no writes. Re-run with --execute.'); return; }

  // 1) new demo vendors (Verdant, Lone Star). GreenScape already exists — leave it.
  const newVendors = [
    { id: VENDOR_ID.verdant,  management_company_id: MC, name: 'Verdant Grounds Management', category: 'landscaping', status: 'active' },
    { id: VENDOR_ID.lonestar, management_company_id: MC, name: 'Lone Star Landservices',     category: 'landscaping', status: 'active' },
  ];
  { const { error } = await sb.from('vendors').upsert(newVendors, { onConflict: 'id' }); if (error) throw new Error('vendors: ' + error.message); }
  console.log('  ✓ demo vendors upserted (Verdant, Lone Star)');

  // 2) the RFP envelope (bid_requests). structured_rfp carries the full RFP body.
  const bid = {
    id: BID_ID, management_company_id: MC, community_id: CID, community: D.meta.community,
    vendor_type: 'Landscape Maintenance', service_category: 'landscape_maintenance',
    title: D.meta.title, contract_term: D.meta.term, bid_deadline: D.meta.due,
    scope_summary: D.rfp.summary, structured_rfp: D.rfp, status: 'evaluating',
  };
  { const { error } = await sb.from('bid_requests').upsert(bid, { onConflict: 'id' }); if (error) throw new Error('bid_requests: ' + error.message); }
  console.log('  ✓ RFP envelope upserted (bid_requests, status=evaluating)');

  // 3) the three proposals (vendor_proposals) with extracted_data.
  const rows = D.proposals.map((p) => ({
    id: PROPOSAL_ID[p.id], management_company_id: MC, community_id: CID, community: D.meta.community,
    bid_request_id: BID_ID, vendor_id: VENDOR_ID[p.vendor_key], service_category: 'landscape_maintenance',
    proposer_company_name: p.company, vendor_name_raw: p.company,
    document_type: 'project_bid', extraction_status: 'extracted',
    total_amount: p.base_annual_cents / 100, total_annual_amount: p.base_annual_cents / 100,
    term_months: p.term_months, extracted_data: toExtracted(p), is_finalist: true, currency: 'USD',
  }));
  { const { error } = await sb.from('vendor_proposals').upsert(rows, { onConflict: 'id' }); if (error) throw new Error('vendor_proposals: ' + error.message); }
  console.log(`  ✓ ${rows.length} proposals upserted (vendor_proposals, all finalists)`);

  // verify
  const { data: check } = await sb.from('vendor_proposals').select('proposer_company_name, total_annual_amount, vendor_id').eq('bid_request_id', BID_ID).order('total_annual_amount');
  console.log('\n  In-system now:');
  (check || []).forEach((r) => console.log(`    ${r.proposer_company_name.padEnd(28)} $${Number(r.total_annual_amount).toLocaleString()}  vendor ${String(r.vendor_id).slice(0,8)}${r.vendor_id===VENDOR_ID.greenscape?' (existing, live projects)':''}`));
  console.log('\nDone. RFP + 3 proposals are real records; Proposal A is the existing GreenScape vendor.');
}
main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
