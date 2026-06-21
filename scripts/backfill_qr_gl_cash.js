// ============================================================================
// scripts/backfill_qr_gl_cash.js
// ----------------------------------------------------------------------------
// One-time backfill: seed Quail Ridge's GL cash reconciliation foundation.
//   1. Ingest the 2025 Vantaca GL Trial Balance detail (Jun–Aug, Sep–Dec) into
//      the continuous bank_rec_gl_cash ledger (cash account 1000 → bank 4536).
//   2. Record the opening reconciled position on the bank account:
//        • gl_anchor       — 6/1/2025 beginning cash balance ($51,429.84)
//        • as_of_date      — 8/31/2025 cutover ("stake in the ground")
//        • outstanding_checks #4/#6/#7/#8 = $2,216.33 (clear Sep–Dec)
//        • deposits_in_transit $2,945.35 lockbox (clears Sep)
//   These were proven to reconcile bank↔GL to $0.00 for Sep–Dec 2025.
//
// Requires migration 241 applied first. Idempotent (date-range replace on
// ingest; opening_position is overwritten with the canonical values).
//
//   node scripts/backfill_qr_gl_cash.js
// ============================================================================

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { parseGlTrialBalance } = require('../lib/banking/extractors/gl_cash');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const QR = 'a0000000-0000-4000-8000-000000000005';
const LAST4 = '4536';
const GL_ACCT = '1000';

// GL Trial Balance detail files (Ed's exports). Override via argv if relocated.
const HOME = process.env.USERPROFILE || process.env.HOME || '.';
const FILES = (process.argv.slice(2).length ? process.argv.slice(2) : [
  path.join(HOME, 'Downloads', 'GLTrialBalance (3).xls'), // Jun–Aug
  path.join(HOME, 'Downloads', 'GLTrialBalance (2).xls'), // Sep–Dec
]);

const f = (c) => '$' + (Number(c || 0) / 100).toFixed(2);

async function replaceRange(lo, hi) {
  await supabase.from('bank_rec_gl_cash').delete()
    .eq('community_id', QR).eq('account_last4', LAST4)
    .gte('posting_date', lo).lte('posting_date', hi);
}
async function insertChunks(rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('bank_rec_gl_cash').insert(rows.slice(i, i + 500));
    if (error) throw new Error('insert failed: ' + error.message);
  }
}

(async () => {
  let anchor = null;
  for (const file of FILES) {
    if (!fs.existsSync(file)) { console.warn('SKIP (not found):', file); continue; }
    const parsed = parseGlTrialBalance(fs.readFileSync(file));
    const acct = (parsed.accounts || []).find((a) => a.account_number === GL_ACCT);
    if (!acct) { console.warn('no cash account', GL_ACCT, 'in', file); continue; }
    const txns = (acct.transactions || []).filter((t) => t.date && t.amount_cents != null);
    const dates = txns.map((t) => t.date).sort();
    if (dates.length) {
      await replaceRange(dates[0], dates[dates.length - 1]);
      await insertChunks(txns.map((t) => ({
        community_id: QR, account_last4: LAST4, gl_account: GL_ACCT,
        posting_date: t.date, ledger_id: t.ledger_id || null, description: t.description || null,
        amount_cents: t.amount_cents,
        check_number: (String(t.description || '').match(/check\s*#?\s*(\d+)/i) || [])[1] || null,
        source_filename: path.basename(file),
      })));
    }
    if (parsed.period_start && (!anchor || parsed.period_start < anchor.date)) {
      anchor = { date: parsed.period_start, balance_cents: acct.beginning_cents };
    }
    console.log(`ingested ${txns.length} cash txns from ${path.basename(file)} (${parsed.period_start}..${parsed.period_end}), beginning ${f(acct.beginning_cents)}`);
  }

  const opening = {
    gl_anchor: anchor, // { date: '2025-06-01', balance_cents: 5142984 }
    as_of_date: '2025-08-31',
    outstanding_checks: [
      { check_number: '4', amount_cents: 66033, issue_date: '2025-07-15', payee: '' },
      { check_number: '6', amount_cents: 22600, issue_date: '2025-07-15', payee: '' },
      { check_number: '7', amount_cents: 55000, issue_date: '2025-08-01', payee: '' },
      { check_number: '8', amount_cents: 78000, issue_date: '2025-08-01', payee: '' },
    ],
    deposits_in_transit: [
      { amount_cents: 294535, date: '2025-08-29', description: 'Lockbox deposit' },
    ],
  };

  const { data: ba } = await supabase.from('bank_accounts')
    .select('id').eq('community_id', QR).eq('account_last4', LAST4).maybeSingle();
  if (!ba) throw new Error('QR bank account 4536 not found');
  const { error } = await supabase.from('bank_accounts')
    .update({ opening_position: opening }).eq('id', ba.id);
  if (error) throw new Error('opening_position update failed: ' + error.message);

  console.log('\nopening position set:');
  console.log('  anchor', opening.gl_anchor.date, f(opening.gl_anchor.balance_cents));
  console.log('  cutover', opening.as_of_date, '| OC', f(opening.outstanding_checks.reduce((s, c) => s + c.amount_cents, 0)), '| DIT', f(opening.deposits_in_transit.reduce((s, d) => s + d.amount_cents, 0)));
  console.log('\nDone. Run-match on Sep–Dec 2025 should now reconcile to $0.00.');
})().catch((e) => { console.error('BACKFILL FAILED:', e.message); process.exit(1); });
