// The bank reconciliation workpaper renders the stored version faithfully (Ed 2026-11-21).
const assert = require('assert');
const { renderWorkpaperHtml, fileName } = require('../lib/banking/rec_workpaper');

const w = {
  community: { name: 'Sample HOA', legal_name: 'Sample Homeowners Association, Inc.' },
  account: { account_nickname: 'Operating', account_last4: '0001', gl_account_number: '1000' },
  reconciliation: { id: 'R' }, period_start: '2026-08-01', period_end: '2026-08-31',
  source: 'approved', run_id: 'RUN12345', standing: 'stale', standing_label: 'Stale', standing_reasons: ['GL cash at period end is now 5000.00, saved as 4500.00'],
  statement: { statement_period_start: '2026-08-01', statement_period_end: '2026-08-31', beginning_balance_cents: 100000, ending_balance_cents: 90000, source_filename: 'aug.pdf', status: 'voided' },
  totals: { bank_ending_cents: 90000, deposits_in_transit_cents: 5000, outstanding_checks_cents: -15000, manual_adjustments_cents: 0, adjusted_bank_cents: 80000, gl_ending_cents: 79000, bank_only_cents: 1000, adjusted_book_cents: 80000, difference_cents: 0 },
  outstanding_checks: [{ date_ref: '2026-08-20', check_number: '1001', description: 'Pool vendor <b>', amount_cents: -15000 }],
  deposits_in_transit: [{ date_ref: '2026-08-31', description: 'Lockbox', amount_cents: 5000 }],
  bank_only: [{ date_ref: '2026-08-15', description: 'Bank fee', amount_cents: 1000 }], adjustments: [], gl_only: [], matched: [],
  exceptions_open: [{ severity: 'open', text: 'Bank fee not in the GL', amount_cents: 1000 }], exceptions_documented: [],
  receipts: [{ description: 'Payout ST-1', amount_cents: 5000, posted: true, evidence: { basis: 'Payout contents' }, receipts: [{ payment_date: '2026-08-30', vantaca_account_id: 'A1', address: '1 Main', method: 'ACH', amount_cents: 5000 }] }],
  people: { prepared_by: 'Kat Reed', prepared_at: '2026-09-02T15:00:00Z', approved_by: 'owner@example.com', approved_at: '2026-09-03T15:00:00Z', posted_by: 'Kat Reed', posted_at: '2026-09-03T15:00:01Z' },
  versions: [{ run_id: 'RUN12345', status: 'posted' }], history: [{ at: '2026-09-03T15:00:00Z', event: 'approved', actor: 'owner@example.com' }],
  generated_at: '2026-11-21T18:00:00Z',
};
const html = renderWorkpaperHtml(w, { pdfHref: '/x.pdf' });
for (const s of ['Bank Reconciliation', 'Sample Homeowners Association, Inc.', 'GL 1000', 'Stale', '$1,000.00', '$900.00', '($150.00)', '$800.00', '$790.00', '(since superseded)',
  'Bank fee not in the GL', 'Outstanding checks', 'Deposits in transit', 'Bank items not yet in the GL', 'Deposit detail: homeowner receipts', '1 Main', 'owner@example.com', 'Download PDF', 'A zero difference alone is not a reconciliation'])
  assert.ok(html.includes(s), `workpaper shows ${s}`);
assert.ok(!html.includes('<b>') || html.includes('Pool vendor &lt;b&gt;'), 'text is escaped');
assert.ok(!renderWorkpaperHtml(w, { forPdf: true }).includes('Download PDF'), 'the PDF carries no download button');
assert.strictEqual(fileName(w), 'Sample-HOA_Bank-Reconciliation_Operating_2026-08-31.pdf');
console.log('test_bank_rec_workpaper: ok');
