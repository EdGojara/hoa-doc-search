// ============================================================================
// tests/test_amanda_emma_handoff.js  (Ed 2026-10-06)
// ----------------------------------------------------------------------------
// Amanda hands a routine receipt to Emma: one processing item, linked to the
// email, receipt kept, coding left for review, never duplicated, never paid, the
// email left open for Amanda's reply, and PAYMENT METHOD DECIDED FIRST:
//   association card  -> card substantiation + coding, NO reimbursement
//   clearly personal  -> reimbursement
//   unclear           -> payment method review, no assumption
//
// Regression: the Canyon Gate sign email. A board president sent Amanda a $51.05
// receipt (an Amazon order sold by a third-party seller, paid with a MasterCard
// ending 4738 plus an $11.14 gift card). Most likely the association's debit
// card; the platform has no record of that card and no matching statement line
// yet, so it must go to Emma as "payment method needs review", not as a
// reimbursement payable to the board member. (Sanitized; this repo is public.)
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

const SIGN = { id: 'sign1', mailbox: 'amandaalbright@bedrocktx.com', graph_id: 'g1', has_attachments: true, classification: 'vendor_financial',
  subject: 'Sign Receipt', body_full: 'I ordered a new road sign for the neighborhood. I have attached the receipt.\n\nBoard President', sender_email: 'president@example-hoa.com',
  sender_name: 'President HOA', community_id: 'cg', extracted: { requested_action: 'Process/file the attached receipt' }, community: { name: 'Canyon Gate at Cinco Ranch' } };
const RECEIPT = { vendor_name: 'Fastasticdeal', total_cents: 5105, invoice_date: '2026-10-06',
  line_items: [{ description: 'Aluminum Vertical Metal Sign Multiple Sizes Do Not Block Intersection Traffic Black Road with Border Weatherproof Street 18x24Inches' }, { description: 'Estimated tax' }, { description: 'Gift Card Amount applied' }] };
const RECEIPT_TEXT = 'amazon.com Order Summary\nAluminum Vertical Metal Sign ... Do Not Block Intersection\nSold by: Fastasticdeal\nPayment method\nAmazon Gift Card\nMasterCard••••4738\nGift Card Amount:-$11.14\nGrand Total: $51.05';

console.log('\nWhat counts as routine payable intake');
check('the Canyon Gate sign email from a board member is routine', () => {
  assert.deepStrictEqual(H.isRoutinePayableIntake(SIGN, { boardMember: true }), { ok: true, reason: 'board member receipt' });
});
check('a small amount does not make it routine: a $50 legal filing fee or an unauthorized charge is not automatic', () => {
  assert.strictEqual(H.isRoutinePayableIntake({ ...SIGN, body_full: 'Receipt attached for the $50 court filing fee.' }, { boardMember: true }).ok, false);
  assert.strictEqual(H.isRoutinePayableIntake({ ...SIGN, body_full: 'I bought this without approval, receipt attached.' }, { boardMember: true }).ok, false);
});
check('no attachment, no receipt language, or an unknown outside sender: not automatic', () => {
  assert.strictEqual(H.isRoutinePayableIntake({ ...SIGN, has_attachments: false }, { boardMember: true }).ok, false);
  assert.strictEqual(H.isRoutinePayableIntake({ ...SIGN, subject: 'Hello', body_full: 'See attached photos of the pool.', extracted: {} }, { boardMember: true }).ok, false);
  assert.strictEqual(H.isRoutinePayableIntake(SIGN, { boardMember: false }).ok, false);
});

console.log('\nPayment method first (pure)');
check('the receipt’s card and gift card are read', () => {
  assert.deepStrictEqual(H.receiptPayment(RECEIPT_TEXT), { card_brand: 'mastercard', card_last4: '4738', gift_card_cents: 1114 });
});
check('association card: stated in the email, the receipt card on file, or exactly one matching bank charge', () => {
  assert.strictEqual(H.classifyPaymentMethod({ emailText: 'Bought it with the HOA debit card, receipt attached.' }).method, 'association_card');
  assert.strictEqual(H.classifyPaymentMethod({ receiptText: RECEIPT_TEXT, associationLast4s: ['4738'] }).method, 'association_card');
  assert.strictEqual(H.classifyPaymentMethod({ emailText: 'receipt attached', matches: [{ id: 't1' }] }).method, 'association_card');
});
check('personal: only when the sender clearly says so and nothing shows an association card', () => {
  assert.strictEqual(H.classifyPaymentMethod({ emailText: 'I paid for this personally, please reimburse me.' }).method, 'personal');
  assert.strictEqual(H.classifyPaymentMethod({ emailText: 'I paid for this personally, please reimburse me.', matches: [{ id: 't1' }] }).method, 'unclear', 'a conflict is reviewed, not decided');
});
check('unclear: the Canyon Gate sign (card not on file, no matching charge yet), or several candidate charges', () => {
  const c = H.classifyPaymentMethod({ emailText: SIGN.body_full, receiptText: RECEIPT_TEXT });
  assert.strictEqual(c.method, 'unclear');
  assert.match(c.why, /mastercard ending 4738 and a \$11\.14 gift card, it is not on file as an association card/);
  assert.strictEqual(H.classifyPaymentMethod({ emailText: 'receipt attached', matches: [{ id: 't1' }, { id: 't2' }] }).method, 'unclear');
});

console.log('\nAmanda’s handoff note (the expected Canyon Gate handoff)');
check('community, sender, vendor (marketplace + seller), purpose, total + card, coding needs review, payment-method treatment, source', () => {
  const pm = H.classifyPaymentMethod({ emailText: SIGN.body_full, receiptText: RECEIPT_TEXT });
  const s = H.handoffSummary({ communityName: 'Canyon Gate at Cinco Ranch', senderName: 'Board President', senderEmail: 'president@example-hoa.com', senderRole: 'board', extracted: RECEIPT, receiptText: RECEIPT_TEXT, payment: pm });
  assert.match(s.text, /Treatment: payment method needs review .*do not create a reimbursement unless the records show Board President paid personally/);
  assert.match(s.text, /Community: Canyon Gate at Cinco Ranch/);
  assert.match(s.text, /Vendor: Amazon \(sold by Fastasticdeal\)/);
  assert.match(s.text, /Purpose: Aluminum Vertical Metal Sign .*Do Not Block Intersection/);
  assert.match(s.text, /Receipt total: \$51\.05 \(paid with mastercard ending 4738 plus a \$11\.14 gift card\)/);
  assert.match(s.text, /Coding: needs review/);
  assert.ok(!/reimbursement to/i.test(s.text));
});

console.log('\nEnd to end (fakes): one item, the right treatment, never a duplicate');
function world({ email = SIGN, existingExc = [], existingInv = [], board = true, recorded = null, matches = [], last4s = [] } = {}) {
  const st = { exc: [...existingExc], inv: [...existingInv], email: { ...email, extracted: { ...email.extracted, ...(recorded ? { emma_handoff: recorded } : {}) } }, notesUpdates: [], emailUpdates: [], recorded: [], intake: [] };
  const q = (table) => {
    let op = 'select'; let row = null;
    const api = {
      select() { return api; }, limit() { return api; }, neq() { return api; }, eq() { return api; }, in() { return api; }, or() { return api; }, ilike() { return api; },
      update(r) { op = 'update'; row = r; return api; },
      maybeSingle() { return run(true); }, single() { return run(true); }, then(a, b) { return run(false).then(a, b); },
    };
    async function run(one) {
      if (op === 'update') {
        if (table === 'email_messages') { st.email.extracted = row.extracted || st.email.extracted; st.emailUpdates.push(row); } else st.notesUpdates.push({ table, row });
        return { data: null, error: null };
      }
      if (table === 'email_messages') return { data: st.email, error: null };
      if (table === 'board_members') return { data: board ? [{ name: 'Board President', community_id: 'cg', community_name: 'Canyon Gate at Cinco Ranch' }] : [], error: null };
      if (table === 'bank_accounts') return { data: last4s.map((l) => ({ account_last4: l })), error: null };
      if (table === 'ap_intake_exceptions') return one ? { data: { notes: 'intake reason' }, error: null } : { data: st.exc, error: null };
      if (table === 'ap_invoices') return one ? { data: { notes: '' }, error: null } : { data: st.inv, error: null };
      return { data: [], error: null };
    }
    return api;
  };
  const deps = {
    loadAttachments: async () => [{ name: 'Block Inter Sign.pdf', contentType: 'application/pdf', buffer: Buffer.from('%PDF') }],
    stageInvoice: async () => ({ extracted: RECEIPT, sha256: 'sha-1', storagePath: 'ap_invoices/sha_receipt.pdf' }),
    pdfText: async () => RECEIPT_TEXT,
    findCardMatches: async () => matches,
    recordException: async (x) => { st.recorded.push(x); st.exc.push({ id: 'exc-1', status: 'pending', email_message_id: x.emailMessageId }); return { ok: true, id: 'exc-1' }; },
    intakeBillEmail: async (m, opts) => { st.intake.push({ m, opts }); st.inv.push({ id: 'inv-1', status: 'needs_review', intake_source_ref: 'email:g1' }); return { results: [] }; },
  };
  return { sb: { from: q }, st, deps };
}
check('REGRESSION 1: board member + association debit card (one matching bank charge) -> card substantiation, NO reimbursement', async () => {
  const w = world({ matches: [{ id: 'txn-9', posting_date: '2026-10-07', amount_cents: -5105, description: 'AMZN Mktp US' }] });
  const r = await H.handoffToEmma(w.sb, 'sign1', w.deps);
  assert.deepStrictEqual([r.status, r.treatment], ['handed', 'association_card']);
  assert.strictEqual(w.st.intake.length, 0, 'the reimbursement intake path is NOT used');
  assert.strictEqual(w.st.recorded.length, 1);
  assert.match(w.st.recorded[0].reason, /^card transaction substantiation/);
  assert.strictEqual(w.st.recorded[0].extracted.payment_method.card_transaction_id, 'txn-9');
  assert.strictEqual(w.st.recorded[0].storagePath, 'ap_invoices/sha_receipt.pdf', 'the receipt is kept and linked');
  const note = w.st.notesUpdates.find((u) => u.table === 'ap_intake_exceptions').row.notes;
  assert.match(note, /Treatment: association card purchase .*Not a reimbursement\./);
});
check('REGRESSION 1b: the email itself says the HOA card was used -> no reimbursement either', async () => {
  const w = world({ email: { ...SIGN, body_full: 'Bought the new road sign with the HOA debit card, receipt attached.' } });
  const r = await H.handoffToEmma(w.sb, 'sign1', w.deps);
  assert.strictEqual(r.treatment, 'association_card');
  assert.strictEqual(w.st.intake.length, 0);
});
check('REGRESSION 2: board member says "I paid for this personally, please reimburse me" -> reimbursement via the existing intake', async () => {
  const w = world({ email: { ...SIGN, body_full: 'I ordered a new road sign. I paid for this personally, please reimburse me. Receipt attached.' } });
  const r = await H.handoffToEmma(w.sb, 'sign1', w.deps);
  assert.deepStrictEqual([r.status, r.treatment], ['handed', 'personal']);
  assert.strictEqual(w.st.intake.length, 1);
  assert.deepStrictEqual([w.st.intake[0].opts.intentHint.is_reimbursement, w.st.intake[0].opts.intentHint.reimbursee_name, w.st.intake[0].opts.keepOpen], [true, 'Board President', true]);
  assert.strictEqual(w.st.recorded.length, 0);
});
check('REGRESSION 3: payment method ambiguous (the Canyon Gate sign as it is today) -> one review item, no reimbursement, no assumption', async () => {
  const w = world();
  const r = await H.handoffToEmma(w.sb, 'sign1', w.deps);
  assert.deepStrictEqual([r.status, r.treatment], ['handed', 'unclear']);
  assert.strictEqual(w.st.intake.length, 0, 'no reimbursement payable');
  assert.strictEqual(w.st.recorded.length, 1);
  assert.match(w.st.recorded[0].reason, /^payment method needs review/);
  assert.deepStrictEqual(w.st.recorded[0].extracted.payment_method.receipt, { card_brand: 'mastercard', card_last4: '4738', gift_card_cents: 1114 });
  const rec = w.st.email.extracted.emma_handoff;
  assert.deepStrictEqual([rec.status, rec.treatment, rec.exception_ids], ['handed', 'unclear', ['exc-1']]);
  assert.ok(!w.st.emailUpdates.some((u) => u.triage_status), 'the email stays open for Amanda’s reply');
});
check('running it again creates nothing: already with Emma, nothing recorded, still one item', async () => {
  const w = world();
  await H.handoffToEmma(w.sb, 'sign1', w.deps);
  const again = await H.handoffToEmma(w.sb, 'sign1', w.deps);
  assert.strictEqual(again.status, 'already_handed');
  assert.strictEqual(w.st.recorded.length, 1);
  assert.strictEqual(w.st.exc.length, 1);
});
check('an existing AP invoice for the email, or a handoff recorded on it, also blocks a duplicate', async () => {
  const a = world({ existingInv: [{ id: 'inv-9', intake_source_ref: 'email:g1' }] });
  assert.strictEqual((await H.handoffToEmma(a.sb, 'sign1', a.deps)).status, 'already_handed');
  const b = world({ recorded: { status: 'handed', exception_ids: ['exc-old'] } });
  assert.strictEqual((await H.handoffToEmma(b.sb, 'sign1', b.deps)).status, 'already_handed');
  assert.strictEqual(a.st.recorded.length + b.st.recorded.length + a.st.intake.length + b.st.intake.length, 0);
});
check('a non-routine email is not handed automatically', async () => {
  const w = world({ email: { ...SIGN, body_full: 'Receipt for the attorney retainer is attached.' } });
  assert.strictEqual((await H.handoffToEmma(w.sb, 'sign1', w.deps)).status, 'not_eligible');
  assert.strictEqual(w.st.recorded.length + w.st.intake.length, 0);
});

console.log('\nWiring');
check('Emma’s intake honors an explicit reimbursement hint (route only; amount/coding rules unchanged)', () => {
  const s = src('lib/ap/intake.js');
  assert.match(s, /if \(intentHint && intentHint\.is_reimbursement\) intent = intentHint;/);
  assert.match(s, /R\.planReimbursement\(\{ intent, staffText/);
});
check('only the personal branch passes the reimbursement hint', () => {
  const s = src('lib/amanda/emma_handoff.js');
  const personal = s.indexOf("if (pm.method === 'personal') {"); const hint = s.indexOf('is_reimbursement: true, reimbursee_name: senderName', personal); const els = s.indexOf('} else {', personal);
  assert.ok(personal > 0 && hint > personal && hint < els);
});
check('email intake can leave the email open; ingest hands off after filing without blocking; Inbox route is admin-gated', () => {
  assert.match(src('lib/ap/email_bill_intake.js'), /if \(decision\.handled && !opts\.keepOpen\) upd\.triage_status = 'handled';/);
  const g = src('lib/email/graph_ingest.js');
  const file = g.indexOf("console.warn('[graph_ingest] file-to-folder skipped:'"); const hand = g.indexOf("require('../amanda/emma_handoff').handoffToEmma(supabase, insId)");
  assert.ok(file > 0 && hand > file);
  const a = src('api/amanda_email.js'); const k = a.indexOf("router.post('/inbox/:id/handoff-emma'");
  assert.ok(k > 0); assert.match(a.slice(k, k + 200), /requireAdmin/);
});

Promise.all(pending).then(() => console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', with failures' : '')));
