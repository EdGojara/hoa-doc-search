// ============================================================================
// scripts/seed_bank_accounts.js
// ----------------------------------------------------------------------------
// Stand up each community's bank_accounts (one row per GL cash account) so the
// accounting page's bank-statement upload has accounts to route statements to.
// Idempotent: upserts on (community_id, gl_account_number). account_last4 is
// seeded where known from the statements already on hand; unknown ones are
// created with null last4 (the upload backfills/staff picks). --apply to write.
//
//   node scripts/seed_bank_accounts.js [--apply]
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');
const MC = '00000000-0000-0000-0000-000000000001'; // Bedrock Association Management

// community slug -> [ { gl, nickname, type, last4? } ]
const INVENTORY = {
  'lpf': [
    { gl: '1000', nickname: 'LOPF Operating Checking', type: 'operating', last4: '2449' },
    { gl: '1005', nickname: 'LOPF ICS Operating (sweep)', type: 'operating', last4: '2449' },
    { gl: '1100', nickname: 'LOPF Savings', type: 'other', last4: '2457' },
    { gl: '1110', nickname: 'LOPF Reserve Money Market', type: 'reserve', last4: '2465' },
  ],
  'waterview': [
    { gl: '1000', nickname: 'Waterview Operating Checking', type: 'operating', last4: '5961' },
    { gl: '1005', nickname: 'Waterview ICS Operating (sweep)', type: 'operating' },
    { gl: '1100', nickname: 'Waterview Savings', type: 'other' },
    { gl: '1200', nickname: 'Waterview Reserve Cash', type: 'reserve' },
    { gl: '1205', nickname: 'Waterview ICS Reserve (sweep)', type: 'reserve' },
    { gl: '1250', nickname: 'Waterview Adopt-A-School Cash', type: 'other' },
    { gl: '1255', nickname: 'Waterview ICS Adopt-A-School (sweep)', type: 'other' },
  ],
  'canyon-gate': [
    { gl: '1000', nickname: 'Canyon Gate Operating Checking', type: 'operating' },
    { gl: '1200', nickname: 'Canyon Gate Reserve Cash', type: 'reserve' },
    { gl: '1201', nickname: 'Canyon Gate Reserve — Edward Jones (brokerage)', type: 'reserve' },
    { gl: '1250', nickname: 'Canyon Gate Adopt-A-School Cash', type: 'other' },
  ],
  'still-creek-ranch': [
    { gl: '1000', nickname: 'Still Creek Operating Checking', type: 'operating', last4: '1777' },
  ],
};

(async () => {
  let planned = 0;
  for (const [slug, accts] of Object.entries(INVENTORY)) {
    const { data: comm } = await s.from('communities').select('id, name').eq('slug', slug).maybeSingle();
    if (!comm) { console.warn(`  skip: community ${slug} not found`); continue; }
    console.log(`\n${comm.name} (${slug}): ${accts.length} accounts`);
    for (const a of accts) {
      console.log(`  ${a.gl}  ${a.nickname.padEnd(42)} ${a.type.padEnd(10)} ····${a.last4 || '????'}`);
      planned++;
      if (!APPLY) continue;
      const row = {
        management_company_id: MC, community_id: comm.id, account_nickname: a.nickname,
        bank_name: a.gl === '1201' ? 'Edward Jones' : 'NewFirst National Bank',
        account_last4: a.last4 || null, account_type: a.type, gl_account_number: a.gl, is_active: true,
      };
      // upsert by (community_id, gl_account_number): find existing, update or insert.
      const { data: existing } = await s.from('bank_accounts').select('id').eq('community_id', comm.id).eq('gl_account_number', a.gl).maybeSingle();
      if (existing) {
        const { error } = await s.from('bank_accounts').update(row).eq('id', existing.id);
        if (error) { console.error('   update failed:', error.message); process.exit(1); }
      } else {
        const { error } = await s.from('bank_accounts').insert(row);
        if (error) { console.error('   insert failed:', error.message); process.exit(1); }
      }
    }
  }
  console.log(`\n${APPLY ? 'Wrote' : 'Planned'} ${planned} bank accounts across ${Object.keys(INVENTORY).length} communities.${APPLY ? '' : '  (dry run — pass --apply)'}`);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
