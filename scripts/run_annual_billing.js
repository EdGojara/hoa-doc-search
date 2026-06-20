// ============================================================================
// scripts/run_annual_billing.js
// ----------------------------------------------------------------------------
// Run the annual assessment billing for a community through the billing engine.
//   node scripts/run_annual_billing.js --community=quail-ridge --year=2027 \
//        --per-unit=260 [--billing-date=2027-01-01] [--due-date=2027-01-31] [--apply]
// Dry-run by default (prints the plan); --apply posts it. Idempotent per year.
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const { runAnnualBilling } = require('../lib/accounting/assessment_billing');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const APPLY = process.argv.includes('--apply');

(async () => {
  const slug = arg('community'); const year = parseInt(arg('year'), 10);
  const perUnit = Math.round(parseFloat(arg('per-unit')) * 100);
  if (!slug || !year || !perUnit) { console.error('need --community --year --per-unit'); process.exit(1); }
  const { data: comm } = await s.from('communities').select('id, name').eq('slug', slug).single();
  const r = await runAnnualBilling({
    supabase: s, communityId: comm.id, fiscalYear: year, perUnitCents: perUnit,
    billingDate: arg('billing-date'), dueDate: arg('due-date'), dryRun: !APPLY,
  });
  console.log(`${comm.name} — annual billing ${year}:`);
  console.log(JSON.stringify(r, null, 2));
})().catch((e) => { console.error(e.message); process.exit(1); });
