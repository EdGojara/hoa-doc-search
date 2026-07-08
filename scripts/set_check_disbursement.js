// ============================================================================
// scripts/set_check_disbursement.js  (Ed 2026-07-08)
// ----------------------------------------------------------------------------
// Flag each community's go-forward OPERATING account as the sole check
// disbursement account (checks can only be cut from it). Requires migration 268.
// Target = an operating account that IS linked to a bank, is NOT a sweep, and is
// NOT a Columbia (closing) account. Skips a community if that's ambiguous — set
// those by hand in Bank Setup > "Set as check account".
//   node scripts/set_check_disbursement.js [--apply]
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');

(async () => {
  const { data: rows, error } = await s.from('bank_accounts')
    .select('id, community_id, account_nickname, account_type, bank_id, is_check_disbursement, community:community_id(name), bank:bank_id(name)');
  if (error) { console.error('Query failed (is migration 268 applied?):', error.message); return; }

  const byComm = {};
  for (const r of rows || []) (byComm[r.community_id] = byComm[r.community_id] || []).push(r);

  for (const [cid, accts] of Object.entries(byComm)) {
    const name = accts[0].community ? accts[0].community.name : cid;
    const candidates = accts.filter((a) =>
      a.account_type === 'operating' && a.bank_id &&
      !/sweep/i.test(a.account_nickname || '') &&
      !/columbia/i.test(a.account_nickname || '') &&
      !(a.bank && /columbia/i.test(a.bank.name || '')));
    if (candidates.length !== 1) {
      console.warn(`  ${name}: ${candidates.length} candidates — set by hand.`);
      continue;
    }
    const c = candidates[0];
    console.log(`  ${name}: ${c.account_nickname}  (${c.bank ? c.bank.name : '—'})`);
    if (!APPLY) continue;
    await s.from('bank_accounts').update({ is_check_disbursement: false }).eq('community_id', cid).eq('is_check_disbursement', true);
    const { error: uErr } = await s.from('bank_accounts').update({ is_check_disbursement: true }).eq('id', c.id);
    if (uErr) console.error(`   FAILED ${name}:`, uErr.message);
  }
  console.log(APPLY ? '\n✓ Applied.' : '\nDRY RUN — pass --apply (needs migration 268).');
})().catch((e) => console.error(e.message));
