// ============================================================================
// scripts/ingest_qr_payout_contents.js
// ----------------------------------------------------------------------------
// Ingest a Vantaca Pay Payout Contents export into the continuous bank_rec_payouts
// ledger. This is the AUTHORITATIVE online-settlement key: each row maps a
// payment's transaction date to its payout (bank settlement) date, which is how
// deposits-in-transit are computed (trxn <= period-end, payout > period-end).
// Date-range replace on trxn_date so re-ingesting is idempotent.
//   node scripts/ingest_qr_payout_contents.js "<path-to-xls>"
// ============================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { parseVantacaPayPayouts } = require('../lib/banking/extractors/vantaca_pay_payouts');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const QR = 'a0000000-0000-4000-8000-000000000005';
const f = (c) => '$' + (Number(c || 0) / 100).toFixed(2);
const HOME = process.env.USERPROFILE || process.env.HOME || '.';
const FILE = process.argv[2] || path.join(HOME, 'Downloads', 'VantacaPayPayoutContents (2).xls');

(async () => {
  const parsed = parseVantacaPayPayouts(fs.readFileSync(FILE));
  const pays = (parsed.payments || []).filter((p) => p.trxn_date && p.amount_cents != null);
  if (!pays.length) { console.error('no payout rows parsed'); process.exit(1); }
  const dates = pays.map((p) => p.trxn_date).sort();
  await s.from('bank_rec_payouts').delete().eq('community_id', QR).gte('trxn_date', dates[0]).lte('trxn_date', dates[dates.length - 1]);
  for (let i = 0; i < pays.length; i += 500) {
    const rows = pays.slice(i, i + 500).map((p) => ({
      community_id: QR, trxn_date: p.trxn_date, payout_date: p.payout_date,
      account_ref: p.account_ref, kind: p.kind, txn_type: p.type, amount_cents: p.amount_cents,
      source_filename: path.basename(FILE),
    }));
    const { error } = await s.from('bank_rec_payouts').insert(rows);
    if (error) throw new Error(error.message);
  }
  console.log(`ingested ${pays.length} payout rows (${dates[0]}..${dates[dates.length - 1]})`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
