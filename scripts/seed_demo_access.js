#!/usr/bin/env node
/**
 * seed_demo_access.js — legitimate demo identities/entitlements for Demo Mode.
 *
 * Drama Creek already has its 13 demo portal_users (homeowner + board) from
 * migration 184. Sterling Ridge (the Demo LMA) needs a board identity and a
 * partner association so staff can enter Board / Partner viewing contexts
 * through the EXISTING view-as paths (mimic / board scope / member scope). No
 * new auth — just the identity rows those production paths already require.
 * Idempotent (stable UUIDs).
 *
 *   node scripts/seed_demo_access.js --execute
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { DEMO_MGMT_CO_ID } = require('../lib/company');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const EXECUTE = process.argv.includes('--execute');
const LMA = 'e0100000-0000-4000-a000-000000000000';
const VILLAS = 'e0200000-0000-4000-a000-000000000000';
const BM = 'e0120001-0000-4000-a000-000000000000';
const PU = 'e0140001-0000-4000-a000-000000000000';
const REL = 'e0210001-0000-4000-a000-000000000000';

async function main() {
  if (!EXECUTE) { console.log('DRY RUN — pass --execute. Seeds Sterling Ridge board identity + partner member community + relationship.'); return; }
  const steps = [
    ['board_members', { id: BM, management_company_id: DEMO_MGMT_CO_ID, community_id: LMA, community_name: 'Sterling Ridge Landscape District', name: 'Marcus Sterling', position: 'President', email: 'board@sterlingridge.demo', is_active: true, notes: 'Demo LMA board member (President).' }],
    ['portal_users', { id: PU, management_company_id: DEMO_MGMT_CO_ID, email: 'board@sterlingridge.demo', full_name: 'Marcus Sterling', role: 'board_member', status: 'active', notes: 'Demo LMA board portal identity (mimic target for Demo Mode board view).' }],
    ['communities', { id: VILLAS, management_company_id: DEMO_MGMT_CO_ID, name: 'Sterling Ridge Villas HOA', legal_name: 'Sterling Ridge Villas Homeowners Association', slug: 'sterling-ridge-villas', state: 'TX', is_demo: true, active: true, notes: 'Demo partner association (member of Sterling Ridge LMD).' }],
    ['community_relationships', { id: REL, parent_community_id: LMA, member_community_id: VILLAS, relationship_type: 'partner_association', status: 'active', started_at: new Date().toISOString() }],
  ];
  for (const [table, row] of steps) {
    const { error } = await sb.from(table).upsert(row, { onConflict: 'id' });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  console.log('Demo access identities seeded (idempotent): Sterling Ridge board member + portal_user + Villas member community + active partner relationship.');
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
