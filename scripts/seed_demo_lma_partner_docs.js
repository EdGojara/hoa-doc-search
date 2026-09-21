#!/usr/bin/env node
/**
 * seed_demo_lma_partner_docs.js — entitled fictional documents for the Sterling
 * Ridge Villas partner portal, seeded through the REAL retrieval path:
 * library_documents (member_scope='all_members') -> knowledge_documents
 * (source_type='library_doc') -> embedded knowledge_chunks. Makes the partner
 * doc list AND "Ask Sterling Ridge" work without weakening entitlement — the
 * docs are entitled only to members of Sterling Ridge LMD. Idempotent.
 *
 *   node scripts/seed_demo_lma_partner_docs.js --execute
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { DEMO_MGMT_CO_ID } = require('../lib/company');
const OpenAI = require('openai');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const EXECUTE = process.argv.includes('--execute');
const LMA = 'e0100000-0000-4000-a000-000000000000';

const DOCS = [
  {
    lib: 'e0300001-0000-4000-a000-000000000000', kdoc: 'e0310001-0000-4000-a000-000000000000',
    title: 'Sterling Ridge LMD – Villas Landscape Services Agreement', category: 'management_agreement',
    text: 'Sterling Ridge Landscape District (SRLD) provides landscape and common-area maintenance to Sterling Ridge Villas HOA under this services agreement, effective January 2026. SRLD maintains the boulevard medians and esplanades, the two entrance monuments, the entrance landscape beds, the irrigation systems, the parkway tree corridor, the street lighting circuit, and the regional detention basin. Sterling Ridge Villas contributes a quarterly landscape assessment of $18,500, billed to the HOA, covering routine maintenance, seasonal color, irrigation service, and its allocated share of capital repairs. Capital projects over $10,000 require SRLD board approval and are cost-shared according to the district allocation schedule. The Villas representative may request the status of any common-area matter through the district office.',
  },
  {
    lib: 'e0300002-0000-4000-a000-000000000000', kdoc: 'e0310002-0000-4000-a000-000000000000',
    title: 'Landscape Maintenance Standards & Schedule (2026)', category: 'rules_and_regulations',
    text: 'Mowing and edging of all medians and esplanades occurs weekly from March through November and biweekly in winter. Irrigation systems are inspected monthly and controllers are audited each spring. Median 7 irrigation has been flagged for recurring controller faults and is under active repair. Seasonal color is rotated at the entrances twice a year. Live oaks and crape myrtles along the parkway corridor are pruned annually. Street lighting is inspected quarterly. Detention basin vegetation and erosion are inspected after major storms. The standard response time for an irrigation break is 48 hours; for a lighting outage, five business days.',
  },
  {
    lib: 'e0300003-0000-4000-a000-000000000000', kdoc: 'e0310003-0000-4000-a000-000000000000',
    title: 'Common-Area Work Summary — Q3 2026', category: 'meeting_records',
    text: 'Active work: the Median 7 irrigation controller replacement is in progress with AquaFlow Irrigation; the district board approved $12,500 and about $8,200 has been invoiced to date. Completed work: the West Entrance monument refurbishment ($6,800) and the parkway lighting LED conversion ($22,000) are finished. Planned and awaiting approval: the detention basin erosion repair is before the board at an estimated $18,000, and an East Entrance seasonal color program is budgeted. Median 7 has now required two irrigation projects in twelve months, and the district is monitoring whether a full irrigation zone rebuild is warranted. For Sterling Ridge Villas, the visible impact is limited to brief watering interruptions near Median 7 during the controller work.',
  },
];

async function main() {
  console.log(`\nDemo LMA partner docs seed — ${EXECUTE ? 'EXECUTE' : 'DRY RUN'} — ${DOCS.length} entitled documents`);
  DOCS.forEach((d) => console.log('  ' + d.title + '  [' + d.category + ', all_members]'));
  if (!EXECUTE) { console.log('\nDRY RUN — no writes.'); return; }

  for (const d of DOCS) {
    // 1) library_documents (entitled to members)
    const { error: le } = await sb.from('library_documents').upsert({
      id: d.lib, management_company_id: DEMO_MGMT_CO_ID, community_id: LMA,
      category: d.category, title: d.title, member_scope: 'all_members',
      status: 'current', approval_status: 'approved', index_status: 'indexed',
      file_name_original: d.title + '.pdf', notes: 'Demo LMA partner document.',
    }, { onConflict: 'id' });
    if (le) throw new Error('library_documents ' + d.title + ': ' + le.message);

    // 2) knowledge_documents (the retrieval substrate mapping)
    const { error: ke } = await sb.from('knowledge_documents').upsert({
      id: d.kdoc, management_company_id: DEMO_MGMT_CO_ID, community_id: LMA,
      title: d.title, source_type: 'library_doc', source_record_id: d.lib,
      access_level: 'staff_internal', status: 'active', model_version: 'text-embedding-ada-002@v1',
      chunk_count: 1,
    }, { onConflict: 'id' });
    if (ke) throw new Error('knowledge_documents ' + d.title + ': ' + ke.message);

    // 3) embedded knowledge_chunks (real embedding via ada-002)
    await sb.from('knowledge_chunks').delete().eq('document_id', d.kdoc);
    const emb = await openai.embeddings.create({ model: 'text-embedding-ada-002', input: d.text.replace(/\n/g, ' ') });
    const { error: ce } = await sb.from('knowledge_chunks').insert({
      document_id: d.kdoc, chunk_index: 0, text: d.text,
      embedding: emb.data[0].embedding, model_version: 'text-embedding-ada-002@v1',
      token_count: Math.round(d.text.length / 4),
    });
    if (ce) throw new Error('knowledge_chunks ' + d.title + ': ' + ce.message);
    console.log('  ✓ ' + d.title);
  }
  console.log('\nEXECUTE complete: 3 entitled + embedded partner documents for Sterling Ridge (all_members).');
}
main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
