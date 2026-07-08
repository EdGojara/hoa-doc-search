// ============================================================================
// scripts/flag_vendor_ach.js  (Ed 2026-07-08)
// ----------------------------------------------------------------------------
// Flag a vendor as ACH auto-pay (they auto-draft; Emma records, never cuts a
// check). Requires migration 267. Optionally pin the default expense account.
//   node scripts/flag_vendor_ach.js "Strike Electrical"            # dry run
//   node scripts/flag_vendor_ach.js "Strike Electrical" --apply    # set the flag
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');
const name = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ');

(async () => {
  if (!name) { console.log('Usage: node scripts/flag_vendor_ach.js "<vendor name>" [--apply]'); return; }
  const { data, error } = await s.from('vendors').select('id, name, auto_pay_ach').ilike('name', `%${name}%`).limit(10);
  if (error) { console.error('Query failed (is migration 267 applied?):', error.message); return; }
  if (!data || !data.length) { console.log('No vendor matches', JSON.stringify(name)); return; }
  data.forEach((v) => console.log(`  ${v.id}  ${v.name}  (auto_pay_ach=${v.auto_pay_ach})`));
  if (data.length > 1) { console.log('\nMultiple matches — narrow the name.'); return; }
  if (!APPLY) { console.log('\nDRY RUN — pass --apply to set auto_pay_ach = true.'); return; }
  const { error: uErr } = await s.from('vendors').update({ auto_pay_ach: true }).eq('id', data[0].id);
  console.log(uErr ? `FAILED: ${uErr.message}` : `✓ ${data[0].name} flagged ACH auto-pay. Emma will record their invoices and skip the check run.`);
})().catch((e) => console.error(e.message));
