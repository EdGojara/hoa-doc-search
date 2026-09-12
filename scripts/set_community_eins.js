// scripts/set_community_eins.js — populate each HOA's EIN (from its IRS CP 575 /
// 1120-H, verified 2026-09-12) for W-9 / tax-form generation. Run AFTER migration
// 415 (adds communities.ein) is applied:  node -r dotenv/config scripts/set_community_eins.js
//
// EINs verified against the association's own IRS records. August Meadows has no
// EIN yet (only an SS-4 application), so it is omitted. All are Form 1120-H filers.
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const ROWS = [
  { match: 'Waterview Estates',    legal: 'Waterview Estates Owners Association, Inc.',        ein: '20-1283917' },
  { match: 'Canyon Gate',          legal: 'Canyon Gate at Cinco Ranch Owners Association, Inc.', ein: '76-0555731' },
  { match: 'Lakes of Pine Forest', legal: 'Lakes of Pine Forest Homeowners Association, Inc.',  ein: '81-0633206' },
  { match: 'Eaglewood',            legal: 'Eaglewood Homeowners Association, Inc.',             ein: '76-0652489' },
  { match: 'Quail Ridge',          legal: 'Quail Ridge Homeowners Association, Inc.',           ein: '83-0643630' },
  { match: 'Still Creek Ranch',    legal: 'Still Creek Ranch Homeowners Association, Inc.',     ein: '83-4450035' },
];
const TAX_CLASS = 'Homeowners association (files Form 1120-H)';

(async () => {
  for (const r of ROWS) {
    const { data: c, error } = await s.from('communities').select('id,name,hoa_legal_name').ilike('name', `%${r.match}%`).limit(1).maybeSingle();
    if (error) { console.log(`ERR lookup ${r.match}: ${error.message}`); continue; }
    if (!c) { console.log(`SKIP ${r.match}: no community row`); continue; }
    const patch = { ein: r.ein, tax_classification: TAX_CLASS };
    if (!c.hoa_legal_name) patch.hoa_legal_name = r.legal; // don't clobber a name already set
    const { error: uErr } = await s.from('communities').update(patch).eq('id', c.id);
    if (uErr) { console.log(`ERR update ${c.name}: ${uErr.message}${/ein/.test(uErr.message) ? '  (apply migration 415 first)' : ''}`); continue; }
    console.log(`OK  ${c.name} -> ${r.ein}`);
  }
  console.log('\nAugust Meadows: no EIN yet (SS-4 application only) — left blank on purpose.');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
