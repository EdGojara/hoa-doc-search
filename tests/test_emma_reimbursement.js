// tests/test_emma_reimbursement.js — Issue #3 (Ed 2026-09-28). A staff email asking
// Emma to reimburse a committee member, with a paid store receipt attached, must
// become a reviewable reimbursement payable (or a visible needs_review exception),
// never a silent "not an invoice". Offline: every AI call and DB write is faked.
require('dotenv').config({ quiet: true });
const assert = require('assert');
const R = require('../lib/ap/reimbursement');
const { autoIntake, findOrCreateReimbursementPayee } = require('../lib/ap/intake');
const { findDuplicates } = require('../lib/ap/dedup');
const { resolveEntities } = require('../lib/email/triage');
const { promoteReimbursementException, mapReason } = require('../lib/ap/intake_exceptions');

let failed = 0;
const results = [];
const t = (name, fn) => results.push({ name, fn });

// The real Issue #3 email (no address needed for the logic).
const SUBJECT = 'Reimbursement';
const BODY = 'Please process reimbursement in the amount of $35.72 to be paid to Gloria Allen.\nCode to community events\nThank you';
const STAFF = 'celina@bedrocktx.com';
const LOPF = 'c-lopf';
const ACCOUNTS = [
  { id: 'a5900', account_number: '5900', account_name: 'Community Events' },
  { id: 'a5100', account_number: '5100', account_name: 'Landscape Maintenance' },
  { id: 'a6100', account_number: '6100', account_name: 'Postage' },
];
const RECEIPT = { looks_like_invoice: false, vendor_name: 'Walmart', invoice_date: '2026-05-25', total_cents: 16600, invoice_number: null };
const INTENT = { is_reimbursement: true, reimbursee_name: 'Gloria Allen', community_hint: null, from_board_member: false };

// autoIntake with every external dependency faked; records what was committed.
function run({ extracted = RECEIPT, intent = INTENT, body = BODY, sender = STAFF, communityId = LOPF, accounts = ACCOUNTS, allocation = { cents: 3572, note: 'BBQ sauce 3 x $11 + tax' }, payeeCreated = true, subject = SUBJECT } = {}) {
  const calls = { commit: null, payee: null };
  const deps = {
    stageInvoice: async () => ({ extracted: JSON.parse(JSON.stringify(extracted)), sha256: 'sha-gloria', storagePath: 'ap_invoices/gloria.pdf' }),
    detectReimbursementIntent: async () => intent,
    readReceiptAllocation: async () => allocation,
    loadAccounts: async () => accounts,
    resolveCommunity: async () => ({ community: null }),
    findOrCreateReimbursementPayee: async (a) => { calls.payee = a; return { payee: { id: 'payee-gloria', kind: 'reimbursement' }, created: payeeCreated }; },
    commitInvoice: async (a) => { calls.commit = a; return { outcome: 'loaded', invoice_id: 'inv-1' }; },
  };
  return autoIntake({ buffer: Buffer.from('%PDF'), filename: 'Gloria Allen Reimbursement.pdf', intakeMethod: 'email', sourceRef: 'email:g1',
    communityId, achHintText: `${subject} ${body}`, staffNote: body, staffSenderEmail: sender, emailSubject: subject }, deps).then((out) => ({ out, calls }));
}

t('reimbursement intent + paid receipt (looks_like_invoice=false) still reaches the reimbursement flow', async () => {
  const { out, calls } = await run();
  assert.strictEqual(out.outcome, 'loaded');
  assert.ok(out.reimbursement);
  assert.ok(calls.commit, 'commitInvoice was reached');
  assert.strictEqual(R.routeAfterStage({ looksLikeInvoice: false, isReimbursement: true, paymentIntent: true }), 'reimbursement');
});

t('requested $35.72 vs receipt $166.00: the payable is $35.72 and both figures are kept', async () => {
  const { calls } = await run();
  const c = calls.commit;
  assert.strictEqual(c.extracted.total_cents, 3572);
  assert.strictEqual(c.extracted.line_items.length, 1);
  assert.strictEqual(c.extracted.line_items[0].amount_cents, 3572);
  assert.strictEqual(c.extracted.receipt_total_cents, 16600);
  assert.strictEqual(c.extracted.reimbursement.requested_cents, 3572);
  assert.strictEqual(c.extracted.reimbursement.receipt_total_cents, 16600);
  assert.match(c.extraNotes, /\$35\.72 from the staff email/);
  assert.match(c.extraNotes, /receipt total \$166\.00/);
  assert.strictEqual(c.reimbursementSource, 'Walmart');
});

t('the handwritten allocation is retained as evidence and does not override the staff instruction', async () => {
  const { calls } = await run();
  assert.strictEqual(calls.commit.extracted.reimbursement.allocation_cents, 3572);
  assert.match(calls.commit.extraNotes, /receipt allocation \$35\.72/);
  // A disagreeing allocation is a material conflict -> needs_review with all figures.
  const bad = await run({ allocation: { cents: 3300, note: 'sauce only' } });
  assert.strictEqual(bad.out.outcome, 'needs_review');
  assert.match(bad.out.reason, /disagree/);
  assert.match(bad.out.reason, /requested \$35\.72; receipt total \$166\.00; receipt allocation \$33\.00/);
  assert.strictEqual(bad.calls.commit, null);
});

t('the receipt grand total is never substituted: no stated amount, two amounts, or more than the receipt -> needs_review', async () => {
  const none = await run({ body: 'Please reimburse Gloria Allen for this. Code to community events' });
  assert.strictEqual(none.out.outcome, 'needs_review'); assert.match(none.out.reason, /no amount stated/);
  const two = await run({ body: 'Please reimburse Gloria Allen $35.72 (or $40.00 if the tip counts). Code to community events' });
  assert.strictEqual(two.out.outcome, 'needs_review'); assert.match(two.out.reason, /more than one amount/);
  const over = await run({ body: 'Please reimburse Gloria Allen $200.00. Code to community events' });
  assert.strictEqual(over.out.outcome, 'needs_review'); assert.match(over.out.reason, /more than the receipt total/);
  assert.deepStrictEqual(R.requestedAmountsCents('4619 Adobe Pines Lane, Houston, Texas 77084 on 9/22 at 10:06'), []);
});

t('missing community -> needs_review (not a silent no-op), with the PDF + hash carried for the exception', async () => {
  const { out, calls } = await run({ communityId: null });
  assert.strictEqual(out.outcome, 'needs_review');
  assert.match(out.reason, /which community/);
  assert.strictEqual(out.storage_path, 'ap_invoices/gloria.pdf'); assert.strictEqual(out.sha256, 'sha-gloria');
  assert.strictEqual(calls.commit, null);
  assert.strictEqual(mapReason(out.reason), 'no_community');
});

t('missing or ambiguous coding -> needs_review; a match is only ever a real chart account', async () => {
  const none = await run({ body: 'Please process reimbursement in the amount of $35.72 to be paid to Gloria Allen.' });
  assert.strictEqual(none.out.outcome, 'needs_review'); assert.match(none.out.reason, /no coding instruction/);
  const nomatch = await run({ body: 'Please reimburse Gloria Allen $35.72. Code to holiday party' });
  assert.strictEqual(nomatch.out.outcome, 'needs_review'); assert.match(nomatch.out.reason, /doesn't match an account/);
  const dupAccts = ACCOUNTS.concat([{ id: 'a5901', account_number: '5901', account_name: 'Community Events' }]);
  const amb = await run({ accounts: dupAccts });
  assert.strictEqual(amb.out.outcome, 'needs_review'); assert.match(amb.out.reason, /more than one account/);
  const ok = await run();
  assert.deepStrictEqual([ok.calls.commit.staffGl.account_id, ok.calls.commit.staffGl.account_number], ['a5900', '5900']);
  assert.strictEqual(mapReason(amb.out.reason), 'other');
  // A non-staff sender cannot direct coding.
  const ext = await run({ sender: 'someone@gmail.com' });
  assert.strictEqual(ext.out.outcome, 'needs_review'); assert.match(ext.out.reason, /no coding instruction/);
});

t('an individual who is not a payee yet gets a REIMBURSEMENT payee (never a trade vendor), and the payable is forced to review', async () => {
  const inserted = [];
  const fake = { from() { const q = { select() { return q; }, eq() { return q; }, ilike() { return q; }, maybeSingle: async () => ({ data: null, error: null }),
    insert(row) { inserted.push(row); return { select() { return { single: async () => ({ data: { id: 'new', ...row }, error: null }) }; } }; } }; return q; } };
  const r = await findOrCreateReimbursementPayee({ name: 'Gloria Allen' }, fake);
  assert.ok(r.created);
  assert.strictEqual(inserted[0].kind, 'reimbursement');
  assert.strictEqual(inserted[0].is_1099_vendor, false);
  assert.strictEqual(inserted[0].category, 'Reimbursement');
  const { calls } = await run({ payeeCreated: true });
  assert.strictEqual(calls.commit.forceReview, true);
  assert.match(calls.commit.extraNotes, /New reimbursement payee created for Gloria Allen \(not a trade vendor/);
  const existing = { from() { const q = { select() { return q; }, eq() { return q; }, ilike() { return q; }, maybeSingle: async () => ({ data: { id: 'p1', kind: 'reimbursement' }, error: null }), insert() { throw new Error('must not insert'); } }; return q; } };
  assert.strictEqual((await findOrCreateReimbursementPayee({ name: 'Gloria Allen' }, existing)).created, false);
});

t('a payment-intent email cannot finish as "not an invoice": it becomes needs_review; with no intent it stays not_an_invoice', async () => {
  const noReimb = { is_reimbursement: false };
  const asked = await run({ intent: noReimb, subject: 'Pool contract', body: 'Please pay this to the pool company.' });
  assert.strictEqual(asked.out.outcome, 'needs_review');
  assert.match(asked.out.reason, /payment requested/);
  assert.strictEqual(asked.out.storage_path, 'ap_invoices/gloria.pdf');
  const fyi = await run({ intent: noReimb, subject: 'Pool contract', body: 'FYI, the signed contract is attached.' });
  assert.strictEqual(fyi.out.outcome, 'not_an_invoice');
  assert.ok(R.hasPaymentIntent(`${SUBJECT}\n${BODY}`));
  // The caller records every needs_review as a Payables exception (source contract).
  const src = require('fs').readFileSync(require.resolve('../lib/email/graph_ingest'), 'utf8');
  assert.ok(/out\.outcome === 'needs_review'[\s\S]{0,200}recordException/.test(src));
  assert.ok(/!pdfs\.length && paymentAsked[\s\S]{0,200}recordException/.test(src));
});

t('reply promise is removed when no payable exists, kept when one does', () => {
  const draft = 'Hi Celina,\n\nThanks! I\'ll get this posted and cut the check for Gloria this week.\n\nEmma';
  const held = R.stateAwarePaymentDraft(draft, { payable: false, needs_review: true });
  assert.ok(held.changed);
  assert.ok(!/cut the check|get this posted/i.test(held.body));
  assert.match(held.body, /logged this in Payables for review/);
  const none = R.stateAwarePaymentDraft(draft, { payable: false, needs_review: false });
  assert.ok(!/cut the check/i.test(none.body)); assert.match(none.body, /review it before anything is paid/);
  const paid = R.stateAwarePaymentDraft(draft, { payable: true });
  assert.strictEqual(paid.changed, false); assert.strictEqual(paid.body, draft);
  assert.strictEqual(R.stateAwarePaymentDraft('Hi, got it, thanks.', { payable: false }).changed, false);
});

t('draft scrub never splits a sentence inside a dollar amount (the real Emma draft shape)', () => {
  const d = "Hi Celina,\n\nThanks for sending this over. I'll process the $35.72 reimbursement to Gloria Allen and code it to community events. The receipt shows the Walmart purchase from 5/25/26, totaling $35.72.\n\nEmma";
  const out = R.stateAwarePaymentDraft(d, { payable: false, needs_review: true }).body;
  assert.ok(!/I'll process/.test(out)); assert.ok(!/^72 /m.test(out) && !/\. 72 /.test(out));
  assert.match(out, /Thanks for sending this over\. I've logged this in Payables for review/);
  assert.match(out, /totaling \$35\.72\./);
});

t('handwritten allocation counts only when its lines add up (handwriting is read unreliably)', () => {
  assert.deepStrictEqual(R.allocationFromLines({ lines: [{ text: 'BBQ Sauce 11.00 x 3', quantity: 3, unit_price: 11, amount: 33 }, { text: 'Tax', amount: 2.72 }], written_total: 35.72 }).cents, 3572);
  assert.strictEqual(R.allocationFromLines({ lines: [{ text: 'x', amount: 33 }, { text: 'tax', amount: 2.72 }], written_total: 135.72 }).cents, null);   // misread total
  assert.strictEqual(R.allocationFromLines({ lines: [{ text: 'x', quantity: 3, unit_price: 11, amount: 35 }] }).cents, null);                          // qty x unit mismatch
  assert.strictEqual(R.allocationFromLines({ lines: [] }).cents, null);
});

t('an internal @bedrocktx.com sender never resolves to a vendor, even if a vendor lists that address', async () => {
  const vendorRow = { id: 'v-star', name: 'Star Protection Agency LLC', email: null, contact_email: STAFF };
  const sb = { from(table) {
    const q = { select() { return q; }, or() { return q; }, eq() { return q; }, ilike() { return q; }, in() { return q; }, neq() { return q; }, not() { return q; }, is() { return q; }, order() { return q; }, limit() { return q; },
      maybeSingle: async () => ({ data: null, error: null }),
      then(res) { return res({ data: table === 'vendors' ? [vendorRow] : [], error: null }); } };
    return q; } };
  const out = await resolveEntities({ vendor_name: null, person_names: [], addresses: [], community_hint: null }, { sender_email: STAFF, subject: SUBJECT, body_preview: BODY }, sb);
  assert.notStrictEqual(out.vendor_id, 'v-star');
  assert.ok(!out.candidates.some((c) => c.why === 'vendor email on file'));
  const ext = await resolveEntities({ vendor_name: null, person_names: [], addresses: [], community_hint: null }, { sender_email: 'billing@starprotection.com', subject: 'Invoice', body_preview: '' }, sb);
  assert.strictEqual(ext.vendor_id, 'v-star');   // real vendor mail still resolves
});

t('a forwarded or replayed copy of the same receipt is a certain duplicate (same file hash, same community)', async () => {
  const sb = { from() { const q = { select() { return q; }, eq() { return q; }, neq() { return q; }, gte() { return q; }, lte() { return q; }, ilike() { return q; }, in() { return q; }, or() { return q; }, not() { return q; }, order() { return q; },
    limit: async () => ({ data: [{ id: 'inv-1', status: 'awaiting_approval', total_cents: 3572, invoice_date: '2026-05-25' }], error: null }) }; return q; } };
  const d = await findDuplicates(sb, { communityId: LOPF, vendorId: 'payee-gloria', invoiceNumber: null, totalCents: 3572, invoiceDate: '2026-05-25', fileSha256: 'sha-gloria' });
  assert.strictEqual(d.verdict, 'certain');
  const { calls } = await run();
  assert.strictEqual(calls.commit.sha256, 'sha-gloria');     // commitInvoice runs findDuplicates on this hash
});

t('the receipt stays linked: the payable and a promoted exception carry the original PDF + hash', async () => {
  const { calls } = await run();
  assert.strictEqual(calls.commit.storagePath, 'ap_invoices/gloria.pdf');
  assert.strictEqual(calls.commit.sha256, 'sha-gloria');
  // Promote a held reimbursement exception.
  const exc = { id: 'e1', status: 'pending', community_id: LOPF, email_message_id: 'm1', intake_source_ref: 'email:g1', storage_path: 'ap_invoices/gloria.pdf', file_sha256: 'sha-gloria',
    extracted: { ...RECEIPT, reimbursement: { reimbursee: 'Gloria Allen', requested_cents: 3572, receipt_total_cents: 16600, allocation_cents: 3572, community_id: LOPF } } };
  const updates = [];
  const db = { from(table) { const q = { select() { return q; }, eq() { return q; }, update(u) { updates.push([table, u]); return q; },
    maybeSingle: async () => ({ data: table === 'ap_intake_exceptions' ? exc : (table === 'chart_of_accounts' ? ACCOUNTS[0] : null), error: null }), then(res) { return res({ data: null, error: null }); } }; return q; } };
  let committed = null;
  const intake = { findOrCreateReimbursementPayee: async () => ({ payee: { id: 'payee-gloria' }, created: false }), commitInvoice: async (a) => { committed = a; return { outcome: 'loaded', invoice_id: 'inv-9' }; } };
  const r = await promoteReimbursementException('e1', { amountCents: 3572, accountId: 'a5900', resolvedBy: 'Kat' }, { supabase: db, intake });
  assert.ok(r.ok);
  assert.strictEqual(committed.storagePath, 'ap_invoices/gloria.pdf'); assert.strictEqual(committed.sha256, 'sha-gloria');
  assert.strictEqual(committed.extracted.total_cents, 3572); assert.strictEqual(committed.forceReview, true);
  assert.strictEqual(committed.vendorId, 'payee-gloria'); assert.strictEqual(committed.staffGl.account_number, '5900');
  assert.ok(updates.some(([tb, u]) => tb === 'ap_intake_exceptions' && u.status === 'resolved'));
  const noAcct = await promoteReimbursementException('e1', { amountCents: 3572, accountId: null }, { supabase: db, intake });
  assert.strictEqual(noAcct.error, 'need_account');
});

t('check workflow stays behind approval: a reimbursement is never auto-paid (commit path unchanged: awaiting_approval + needs_review)', () => {
  const src = require('fs').readFileSync(require.resolve('../lib/ap/intake'), 'utf8');
  assert.ok(/status: suspected \? 'on_hold' : 'awaiting_approval'/.test(src));
  assert.ok(/needs_review: [^\n]*!!forceReview/.test(src));
});

(async () => {
  for (const { name, fn } of results) {
    try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.message); }
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall Emma reimbursement checks passed');
  process.exitCode = failed ? 1 : 0;
})();
