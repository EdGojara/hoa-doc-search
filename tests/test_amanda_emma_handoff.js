// ============================================================================
// tests/test_amanda_emma_handoff.js  (Ed 2026-10-06)
// ----------------------------------------------------------------------------
// Amanda hands Emma a payment-evidence package for a routine receipt. Amanda
// reads; Emma classifies each payment component separately:
//   association card            -> card substantiation + coding
//   personal component(s)       -> ONE reimbursement for the personal-funded total
//   association gift card       -> nothing to reimburse
//   unknown component           -> ONE review question for that component only
// The expense is one line; the funding split sits underneath. Nothing is paid,
// nothing is duplicated, the email stays open for Amanda's reply.
//
// Regression: the Canyon Gate sign receipt. Item subtotal $57.99 + tax $4.20 =
// a $62.19 expense, paid $51.05 on a MasterCard ending 4738 (the receipt's "Grand
// Total") plus an $11.14 Amazon gift card. (Sanitized; this repo is public.)
//
//   node tests/test_amanda_emma_handoff.js
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('../lib/amanda/emma_handoff');

let passed = 0; const pending = [];
function check(name, fn) {
  pending.push(Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓ ' + name); },
    (e) => { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }));
}
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// The real receipt's layout (pdf text, line by line), sanitized.
const RECEIPT_TEXT = ['amazon.com Order Summary', 'Sold by: Fastasticdeal', 'Payment method', 'Amazon Gift Card', '$11.14 balance applied', 'MasterCard••••4738',
  'Item(s) Subtotal:$57.99', 'Shipping & Handling:$0.00', 'Total before tax:$57.99', 'Estimated tax to be', 'collected:', '$4.20', 'Gift Card Amount:-$11.14', 'Grand Total:$51.05'].join('\n');
const RECEIPT = { vendor_name: 'Fastasticdeal', total_cents: 5105, invoice_date: '2026-10-06',
  line_items: [{ description: 'Aluminum Vertical Metal Sign Multiple Sizes Do Not Block Intersection Traffic Black Road with Border Weatherproof Street 18x24Inches' }, { description: 'Estimated tax' }] };
const SIGN = { id: 'sign1', mailbox: 'amandaalbright@bedrocktx.com', graph_id: 'g1', has_attachments: true, classification: 'vendor_financial',
  subject: 'Sign Receipt', body_full: 'I ordered a new road sign for the neighborhood. I have attached the receipt.\n\nBoard President', sender_email: 'president@example-hoa.com',
  sender_name: 'President HOA', community_id: 'cg', extracted: { requested_action: 'Process/file the attached receipt' }, community: { name: 'Canyon Gate at Cinco Ranch' } };
const pkgFor = (emailText, opts = {}) => H.buildPaymentPackage({ emailText, receiptText: RECEIPT_TEXT, extracted: RECEIPT, ...opts });
const kinds = (p) => p.items.map((x) => [x.kind, x.amount_cents]);

console.log('\nRoutine intake (unchanged rules)');
check('the sign email from a board member is routine; a $50 legal filing fee or an unauthorized charge is not', () => {
  assert.strictEqual(H.isRoutinePayableIntake(SIGN, { boardMember: true }).ok, true);
  assert.strictEqual(H.isRoutinePayableIntake({ ...SIGN, body_full: 'Receipt attached for the $50 court filing fee.' }, { boardMember: true }).ok, false);
  assert.strictEqual(H.isRoutinePayableIntake({ ...SIGN, body_full: 'I bought this without approval, receipt attached.' }, { boardMember: true }).ok, false);
  assert.strictEqual(H.isRoutinePayableIntake(SIGN, { boardMember: false }).ok, false);
});

console.log('\nAmanda reads the receipt: one expense, two payment components');
check('expense $62.19 = card $51.05 (MasterCard ending 4738) + Amazon gift card $11.14, and it reconciles', () => {
  const t = H.parseTenders(RECEIPT_TEXT, RECEIPT);
  assert.strictEqual(t.expense_cents, 6219);
  assert.deepStrictEqual(t.components.map((c) => [c.kind, c.card_last4 || null, c.amount_cents]), [['card', '4738', 5105], ['gift_card', null, 1114]]);
  assert.strictEqual(t.reconciles, true);
});
check('a receipt whose payments do not add up raises a question instead of guessing', () => {
  const bad = RECEIPT_TEXT.replace('Grand Total:$51.05', 'Grand Total:$50.00');
  const p = H.buildPaymentPackage({ emailText: 'Receipt attached.', receiptText: bad, extracted: RECEIPT });
  assert.ok(p.items.some((x) => x.key === 'reconcile' && /payments add to \$61\.14 but the order total is \$62\.19/.test(x.why)));
});
check('a single-tender receipt is one component for the whole amount', () => {
  const one = 'Item(s) Subtotal:$20.00\nTotal before tax:$20.00\nEstimated tax: $1.65\nVisa ending 1111\nGrand Total:$21.65';
  const t = H.parseTenders(one, {});
  assert.deepStrictEqual([t.expense_cents, t.components.length, t.components[0].amount_cents, t.reconciles], [2165, 1, 2165, true]);
});

console.log('\nThe four requested regressions (each component classified separately)');
check('1) association card + PERSONAL gift card -> card to code, reimbursement only for the $11.14 gift-card portion', () => {
  const p = pkgFor('Receipt attached. I used my own Amazon gift card for part of it.', { associationLast4s: ['4738'] });
  assert.deepStrictEqual(kinds(p), [['card_substantiation', 5105], ['reimbursement', 1114]]);
  assert.strictEqual(p.reimbursement_cents, 1114);
});
check('2) association card + ASSOCIATION-owned gift card -> card to code, no reimbursement', () => {
  const p = pkgFor("Receipt attached. Part of it was on the HOA's gift card.", { associationLast4s: ['4738'] });
  assert.deepStrictEqual(kinds(p), [['card_substantiation', 5105]]);
  assert.strictEqual(p.reimbursement_cents, 0);
  assert.strictEqual(p.components[1].treatment, 'association_funded');
});
check('3) association card + UNKNOWN gift-card ownership -> card processed, one question for the $11.14 only', () => {
  const p = pkgFor('Receipt attached.', { cardMatches: [{ id: 'txn-9', posting_date: '2026-10-07', amount_cents: -5105, description: 'AMZN Mktp US' }] });
  assert.deepStrictEqual(kinds(p), [['card_substantiation', 5105], ['funding_review', 1114]]);
  assert.strictEqual(p.components[0].transaction_id, 'txn-9');
  assert.match(p.items[1].why, /who owned the gift card/);
});
check('4) FULLY PERSONAL split tender -> one reimbursement for the personal-funded total ($62.19)', () => {
  const p = pkgFor('I paid for this personally, please reimburse me. Receipt attached.');
  assert.deepStrictEqual(kinds(p), [['reimbursement', 6219]]);
  assert.strictEqual(p.reimbursement_cents, 6219);
});

console.log('\nNo assumptions');
check('the Canyon Gate sign today (card not on file, no matching charge, gift card owner not stated): two questions, NO reimbursement', () => {
  const p = pkgFor(SIGN.body_full);
  assert.deepStrictEqual(kinds(p), [['funding_review', 5105], ['funding_review', 1114]]);
  assert.strictEqual(p.reimbursement_cents, 0);
  assert.match(p.items[0].why, /card ending 4738 is not on file as an association card/);
});
check('a personal claim that conflicts with association card evidence is a question, not a reimbursement', () => {
  const p = pkgFor('I paid for this personally, please reimburse me.', { associationLast4s: ['4738'] });
  assert.strictEqual(p.components[0].treatment, 'review');
});
check('several candidate bank charges for the card amount: question, not a guess', () => {
  const p = pkgFor('Receipt attached.', { cardMatches: [{ id: 'a' }, { id: 'b' }] });
  assert.strictEqual(p.components[0].treatment, 'review');
});

console.log('\nAmanda’s note: the expense once, funding split underneath');
check('one $62.19 expense line, coding needs review; each component with its treatment; Emma’s items listed', () => {
  const p = pkgFor('Receipt attached.', { associationLast4s: ['4738'] });
  const s = H.handoffSummary({ communityName: 'Canyon Gate at Cinco Ranch', senderName: 'Board President', senderEmail: 'president@example-hoa.com', senderRole: 'board', extracted: RECEIPT, receiptText: RECEIPT_TEXT, pkg: p });
  assert.match(s.text, /Expense: \$62\.19 \(one expense line; coding needs review, none assumed\)/);
  assert.match(s.text, /MasterCard ending 4738 \$51\.05: association card: match to the bank charge, attach the receipt, code it \(not a reimbursement\)/);
  assert.match(s.text, /Amazon gift card \$11\.14: unresolved: review this component only/);
  assert.match(s.text, /Vendor: Amazon \(sold by Fastasticdeal\)/);
  assert.match(s.text, /Card charge to code \$51\.05/);
  assert.match(s.text, /Question \$11\.14: who owned the gift card/);
});

console.log('\nEnd to end (fakes): one item per component, never duplicated, never paid');
function world({ email = SIGN, last4s = [], matches = [], existingInv = [] } = {}) {
  const st = { email: { ...email, extracted: { ...email.extracted } }, exc: [], inv: [...existingInv], recorded: [], notes: [], emailUpdates: [] };
  const q = (table) => {
    let op = 'select'; let row = null;
    const api = {
      select() { return api; }, limit() { return api; }, neq() { return api; }, eq() { return api; }, in() { return api; }, or() { return api; }, ilike() { return api; },
      update(r) { op = 'update'; row = r; return api; },
      maybeSingle() { return run(true); }, single() { return run(true); }, then(a, b) { return run(false).then(a, b); },
    };
    async function run(one) {
      if (op === 'update') { if (table === 'email_messages') { st.email.extracted = row.extracted; st.emailUpdates.push(row); } else st.notes.push(row); return { data: null, error: null }; }
      if (table === 'email_messages') return { data: st.email, error: null };
      if (table === 'board_members') return { data: [{ name: 'Board President', community_id: 'cg', community_name: 'Canyon Gate at Cinco Ranch' }], error: null };
      if (table === 'bank_accounts') return { data: last4s.map((l) => ({ account_last4: l })), error: null };
      if (table === 'ap_intake_exceptions') return one ? { data: { notes: 'item reason' }, error: null } : { data: st.exc, error: null };
      if (table === 'ap_invoices') return { data: st.inv, error: null };
      return { data: [], error: null };
    }
    return api;
  };
  const deps = {
    loadAttachments: async () => [{ name: 'Block Inter Sign.pdf', contentType: 'application/pdf', buffer: Buffer.from('%PDF') }],
    stageInvoice: async () => ({ extracted: RECEIPT, sha256: 'sha-1', storagePath: 'ap_invoices/sha_receipt.pdf' }),
    pdfText: async () => RECEIPT_TEXT,
    findCardMatches: async () => matches,
    // Mirrors recordException's idempotency: same source ref -> the existing row.
    recordException: async (x) => {
      const hit = st.exc.find((e) => e.intake_source_ref === x.sourceRef);
      if (hit) return { ok: true, id: hit.id, existing: true };
      const id = 'exc-' + (st.exc.length + 1); st.exc.push({ id, intake_source_ref: x.sourceRef, email_message_id: x.emailMessageId }); st.recorded.push(x);
      return { ok: true, id };
    },
  };
  return { sb: { from: q }, st, deps };
}
check('Canyon Gate with card 4738 confirmed and gift card owner unknown: exactly two Emma items ($51.05 card, $11.14 question), receipt on both', async () => {
  const w = world({ last4s: ['4738'] });
  const r = await H.handoffToEmma(w.sb, 'sign1', w.deps);
  assert.strictEqual(r.status, 'handed');
  assert.deepStrictEqual(w.st.recorded.map((x) => [x.extracted.handoff_item.kind, x.extracted.total_cents]), [['card_substantiation', 5105], ['funding_review', 1114]]);
  assert.ok(w.st.recorded.every((x) => x.storagePath === 'ap_invoices/sha_receipt.pdf'));
  assert.match(w.st.recorded[0].reason, /^card transaction substantiation: \$51\.05/);
  assert.match(w.st.recorded[1].reason, /^payment component needs review: \$11\.14/);
  assert.ok(!w.st.recorded.some((x) => x.extracted.reimbursement), 'no reimbursement item');
  assert.strictEqual(w.st.recorded[0].extracted.payment_package.expense_cents, 6219);
});
check('a reimbursement item is shaped for Emma’s promote action (person, community, amount = personal portion)', async () => {
  const w = world({ last4s: ['4738'], email: { ...SIGN, body_full: 'I ordered a new road sign. I used my own Amazon gift card for part of it. Receipt attached.' } });
  await H.handoffToEmma(w.sb, 'sign1', w.deps);
  const rb = w.st.recorded.find((x) => x.extracted.reimbursement);
  assert.deepStrictEqual([rb.extracted.reimbursement.reimbursee, rb.extracted.reimbursement.community_id, rb.extracted.reimbursement.requested_cents], ['Board President', 'cg', 1114]);
  assert.match(rb.reason, /^reimbursement: \$11\.14 personally funded portion/);
});
check('re-running creates nothing new (one item per component per email)', async () => {
  const w = world({ last4s: ['4738'] });
  await H.handoffToEmma(w.sb, 'sign1', w.deps);
  const again = await H.handoffToEmma(w.sb, 'sign1', w.deps);
  assert.strictEqual(again.status, 'already_handed');
  assert.strictEqual(w.st.exc.length, 2);
});
check('a partial earlier run is completed without duplicating what already exists', async () => {
  const w = world({ last4s: ['4738'] });
  w.st.exc.push({ id: 'exc-0', intake_source_ref: 'email:g1#card0', email_message_id: 'sign1' });
  await H.handoffToEmma(w.sb, 'sign1', w.deps);
  assert.deepStrictEqual(w.st.exc.map((e) => e.intake_source_ref), ['email:g1#card0', 'email:g1#review1']);
});
check('the email stays open, and the handoff is recorded with the expense and items', async () => {
  const w = world();
  await H.handoffToEmma(w.sb, 'sign1', w.deps);
  const rec = w.st.email.extracted.emma_handoff;
  assert.deepStrictEqual([rec.status, rec.expense_cents, rec.reimbursement_cents, rec.items.length], ['handed', 6219, 0, 2]);
  assert.ok(!w.st.emailUpdates.some((u) => u.triage_status));
});

check('Emma’s queue labels these items neutrally (no item is mislabeled "no community")', () => {
  // lib/ap/intake_exceptions.js mapReason: these words pick a specific label; none may appear.
  const LABEL_WORDS = /associat|communit|vendor|total|amount|date|ambig|could not be (read|downloaded|opened)|unsupported attachment/i;
  const p = pkgFor('Receipt attached.');
  for (const it of [...p.items, { kind: 'card_substantiation', amount_cents: 5105 }, { kind: 'reimbursement', amount_cents: 1114 }]) {
    const r = H.ITEM_REASON[it.kind](it);
    assert.ok(!LABEL_WORDS.test(r), `${it.kind} reason would be mislabeled: ${r}`);
  }
  assert.match(src('lib/ap/intake_exceptions.js'), /if \(\/associat\|communit\/\.test\(r\)\) return 'no_community';/, 'the labeling rule this guards against still exists');
});

console.log('\nWiring');
check('Emma’s shared intake is untouched by this feature; ingest hands off after filing; Inbox route admin-gated', () => {
  assert.ok(!/intentHint/.test(src('lib/ap/intake.js')) && !/keepOpen/.test(src('lib/ap/email_bill_intake.js')));
  const g = src('lib/email/graph_ingest.js');
  const file = g.indexOf("console.warn('[graph_ingest] file-to-folder skipped:'"); const hand = g.indexOf("require('../amanda/emma_handoff').handoffToEmma(supabase, insId)");
  assert.ok(file > 0 && hand > file);
  const a = src('api/amanda_email.js'); const k = a.indexOf("router.post('/inbox/:id/handoff-emma'");
  assert.ok(k > 0); assert.match(a.slice(k, k + 200), /requireAdmin/);
});

Promise.all(pending).then(() => console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', with failures' : '')));
