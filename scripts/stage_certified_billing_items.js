#!/usr/bin/env node
// ============================================================================
// scripts/stage_certified_billing_items.js  (Issue #11)
// ----------------------------------------------------------------------------
// Stage certified-letter charges for historically recovered mailings on the
// Billing area's pending-items rail (billing_pending_items, mig 296). They drop
// onto the community's next ACTIVITY draft invoice and are flipped to 'billed'
// with the invoice id when that invoice is generated, so they can't bill twice.
//
//   node scripts/stage_certified_billing_items.js <manifest.json>          dry run
//   node scripts/stage_certified_billing_items.js <manifest.json> --apply  write
//
// Reads manifest.billing: [{ violation_id, mailed_on, address_label, amount,
//   already_accounted?: 'where it was already billed' }]. An already-accounted
// mailing stages a $0 line that documents it, never a second charge. The rate
// must equal the contract's DRV certified-letter owner charge. Idempotent:
// source_ref 'issue11:<violation_id>:<mailed_on>' is looked up first.
// ============================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const CATEGORY = 'drv_certified_demand';
const ref = (b) => `issue11:${b.violation_id}:${b.mailed_on}`;

function planBilling(items, contractRate) {
  const problems = [];
  const seen = new Set();
  for (const b of items) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.mailed_on || '')) problems.push(`${b.address_label}: mailed_on must be YYYY-MM-DD`);
    if (seen.has(ref(b))) problems.push(`${b.address_label}: listed twice`);
    seen.add(ref(b));
    const want = b.already_accounted ? 0 : contractRate;
    if (Number(b.amount) !== want) problems.push(`${b.address_label}: amount ${b.amount} should be ${want}${b.already_accounted ? ' (already accounted)' : ' (contract rate)'}`);
  }
  return problems;
}

async function main() {
  const file = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!file) { console.error('usage: stage_certified_billing_items.js <manifest.json> [--apply]'); process.exit(2); }
  const m = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (!m.community_id || !Array.isArray(m.billing) || !m.billing.length) throw new Error('manifest needs community_id and billing[]');
  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const must = async (q, what) => { const { data, error } = await q; if (error) throw new Error(what + ': ' + error.message); return data; };

  const comm = await must(sb.from('communities').select('id, name, management_company_id').eq('id', m.community_id).single(), 'community');
  const contracts = await must(sb.from('contracts').select('id, status').eq('community_id', m.community_id), 'contracts');
  const charges = contracts.length ? await must(sb.from('contract_owner_charges').select('fee_amount, contract_id').in('contract_id', contracts.map((c) => c.id)).eq('category', CATEGORY), 'owner charge') : [];
  const rates = [...new Set(charges.map((c) => Number(c.fee_amount)))];
  if (rates.length !== 1) throw new Error(`expected one ${CATEGORY} rate on the contract, found ${JSON.stringify(rates)}`);
  const problems = planBilling(m.billing, rates[0]);
  if (problems.length) throw new Error('blocked, nothing written:\n  ' + problems.join('\n  '));

  const existing = await must(sb.from('billing_pending_items').select('source_ref, status, amount').eq('community_id', m.community_id).in('source_ref', m.billing.map(ref)), 'existing items');
  let total = 0;
  const toInsert = [];
  for (const b of m.billing) {
    const have = existing.find((x) => x.source_ref === ref(b));
    const amount = Number(b.amount);
    total += amount;
    console.log(`${b.mailed_on} ${b.address_label.padEnd(26)} $${amount.toFixed(2)} ${b.already_accounted ? '(already accounted: ' + b.already_accounted + ')' : ''} ${have ? '-> already staged (' + have.status + ')' : '-> stage'}`);
    if (!have) toInsert.push({
      management_company_id: comm.management_company_id, community_id: m.community_id, category: CATEGORY,
      description: b.already_accounted
        ? `Deed Restriction Certified Demand Letter, ${b.address_label}, mailed ${b.mailed_on} (already billed: ${b.already_accounted})`
        : `Deed Restriction Certified Demand Letter, ${b.address_label}, mailed ${b.mailed_on}`,
      qty: 1, unit_price: amount, amount, source: 'manual', source_ref: ref(b),
      submitted_by: m.recovered_by || 'historical_letter_recovery',
      note: 'Certified notice mailed per USPS receipt; Trusted record restored (Issue #11). Charged at the contract rate.',
      status: 'pending',
    });
  }
  console.log(`\n${m.billing.length} mailings, new charges $${total.toFixed(2)} (contract rate $${rates[0]}); ${toInsert.length} to stage.`);
  if (!apply) { console.log('DRY RUN: nothing written.'); return; }
  if (toInsert.length) await must(sb.from('billing_pending_items').insert(toInsert), 'stage items');
  console.log(`Staged ${toInsert.length}. They drop onto ${comm.name}'s next activity draft invoice.`);
}

if (require.main === module) main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
module.exports = { planBilling, ref };
