// ============================================================================
// tests/test_bill_classifier.js  (Ed 2026-07-20)
// ----------------------------------------------------------------------------
// classifyBill decides whether a vendor email is money-already-out (record to
// GL) vs a bill we owe (load to Payables) vs not-a-bill. It's driven by text
// patterns, and word-order-strict patterns silently misfired: 4 of 5 identical
// Inframark/Starnik "Payment Success" water confirmations classified as
// "not a bill" and were skipped, because "Payment Success" / "confirms payment
// of $X" / "payment has been submitted successfully" matched none of the paid
// patterns. This locks the real phrasings so that can't regress — and keeps
// genuine invoices out of the already-paid bucket.
// ============================================================================
const { classifyBill } = require('../lib/ap/email_bill_classifier');

let failures = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name} — got '${got}', want '${want}'`);
}

console.log('\n\x1b[1mAlready-paid confirmations (record to GL)\x1b[0m');
// The real Inframark/Starnik body + subject.
check('subject "Payment Success"',
  classifyBill({ subject: 'Payment Success', bodyText: 'Your payment has been submitted successfully. Thank you for your payment to BARKER CYPRESS M.U.D.', extracted: { amounts: ['$407.25', '$1.00', '$408.25'] } }).disposition,
  'already_paid');
check('summary "confirms payment of $X"',
  classifyBill({ subject: 'Payment Success', bodyText: 'Inframark confirms payment of $1,517.75 for water district account 392347.' }).disposition,
  'already_paid');
check('"thank you for your payment"',
  classifyBill({ subject: 'Receipt', bodyText: 'Thank you for your payment to the district.' }).disposition,
  'already_paid');
check('"payment submitted successfully"',
  classifyBill({ subject: 'Auto notice', bodyText: 'Your payment has been submitted successfully.' }).disposition,
  'already_paid');
check('classic autopay still works',
  classifyBill({ subject: 'Auto-Pay Successfully Submitted', bodyText: 'Your auto-draft was processed.' }).disposition,
  'already_paid');

console.log('\n\x1b[1mReal invoices must NOT read as already paid\x1b[0m');
check('forwarded vendor invoice + PDF',
  classifyBill({ subject: 'Fw: Invoice 43166 from Superior LawnCare', bodyText: 'Superior LawnCare sent invoice 43166 for $2,390.00 for irrigation work.', hasPdf: true }).disposition,
  'payable');
check('past-due notice',
  classifyBill({ subject: 'Your invoice balance of $204.59 is now 14 days past due', bodyText: 'Invoice #9330 is past due. Please pay.' }).disposition,
  'payable');
check('"please remit payment"',
  classifyBill({ subject: 'Statement', bodyText: 'Amount due $500. Please remit payment.' }).disposition,
  'payable');

console.log('\n\x1b[1mNot a bill\x1b[0m');
check('order confirmation',
  classifyBill({ subject: 'Your order confirmation', bodyText: 'Your shipment is on the way.' }).disposition,
  'review');

if (failures) { console.error(`\n\x1b[31m${failures} check(s) failed.\x1b[0m`); process.exit(1); }
console.log('\n\x1b[32mAll bill-classifier checks passed.\x1b[0m');
