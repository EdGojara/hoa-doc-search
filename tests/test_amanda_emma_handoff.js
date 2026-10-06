// ============================================================================
// tests/test_amanda_emma_handoff.js  (Ed 2026-10-06)
// ----------------------------------------------------------------------------
// Amanda hands a routine receipt to Emma: one processing item, linked to the
// email, receipt kept, coding left for review, never duplicated, never paid, and
// the email stays open for Amanda's reply.
//
// Regression: the Canyon Gate sign email. A board president sent Amanda a $51.05
// receipt (an Amazon order, sold by a third-party seller, for a "Do Not Block
// Intersection" aluminum road sign). Nothing put it in front of Emma. (Sanitized
// where it matters; this repo is public.)
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
const RECEIPT_TEXT = 'amazon.com Order Summary\nAluminum Vertical Metal Sign ... Do Not Block Intersection\nSold by: Fastasticdeal\nGrand Total: $51.05';

console.log('\nWhat counts as routine payable intake');
check('the Canyon Gate sign email from a board member is routine', () => {
  assert.deepStrictEqual(H.isRoutinePayableIntake(SIGN, { boardMember: true }), { ok: true, reason: 'board member receipt' });
});
check('Bedrock staff forwarding a receipt is routine too', () => {
  assert.strictEqual(H.isRoutinePayableIntake({ ...SIGN, sender_email: 'cdeleon@bedrocktx.com' }).ok, true);
});
check('a small amount does not make it routine: a $50 legal filing fee or an unauthorized charge is not automatic', () => {
  assert.strictEqual(H.isRoutinePayableIntake({ ...SIGN, body_full: 'Receipt attached for the $50 court filing fee.' }, { boardMember: true }).ok, false);
  assert.strictEqual(H.isRoutinePayableIntake({ ...SIGN, body_full: 'I bought this without approval, receipt attached.' }, { boardMember: true }).ok, false);
});
check('no attachment, no receipt language, or an unknown outside sender: not automatic', () => {
  assert.strictEqual(H.isRoutinePayableIntake({ ...SIGN, has_attachments: false }, { boardMember: true }).ok, false);
  assert.strictEqual(H.isRoutinePayableIntake({ ...SIGN, subject: 'Hello', body_full: 'See attached photos of the pool.', extracted: {} }, { boardMember: true }).ok, false);
  assert.strictEqual(H.isRoutinePayableIntake(SIGN, { boardMember: false }).ok, false, 'a homeowner is not a reimbursement payee by email');
});

console.log('\nAmanda’s handoff note (the expected Canyon Gate handoff)');
check('community, sender, vendor (marketplace + seller), purpose, amount, coding needs review, source', () => {
  const s = H.handoffSummary({ communityName: 'Canyon Gate at Cinco Ranch', senderName: 'Board President', senderEmail: 'president@example-hoa.com', senderRole: 'board', extracted: RECEIPT, receiptText: RECEIPT_TEXT });
  assert.match(s.text, /Community: Canyon Gate at Cinco Ranch/);
  assert.match(s.text, /From: Board President \(board member\)/);
  assert.match(s.text, /Vendor: Amazon \(sold by Fastasticdeal\)/);
  assert.match(s.text, /Purpose: Aluminum Vertical Metal Sign .*Do Not Block Intersection/);
  assert.match(s.text, /Receipt total: \$51\.05/);
  assert.match(s.text, /Coding: needs review \(no expense account was given; none was assumed\)/);
  assert.match(s.text, /Do not ask the sender to resend anything/);
  assert.strictEqual(s.vendor, 'Amazon (sold by Fastasticdeal)');
});
check('the purpose skips tax / gift card lines and stays readable', () => {
  assert.ok(H.purposeFrom(RECEIPT.line_items).length <= 111);
  assert.strictEqual(H.purposeFrom([{ description: 'Estimated tax' }]), null);
});

console.log('\nOne item per receipt, linked, never paid, email left open');
function world({ existingExc = [], existingInv = [], board = true, recorded = null } = {}) {
  const st = { exc: [...existingExc], inv: [...existingInv], email: { ...SIGN, extracted: { ...SIGN.extracted, ...(recorded ? { emma_handoff: recorded } : {}) } }, notesUpdates: [], emailUpdates: [] };
  const q = (table) => {
    const f = []; let op = 'select'; let row = null;
    const api = {
      select() { return api; }, limit() { return api; }, neq() { return api; },
      eq(c, v) { f.push(['eq', c, v]); return api; }, in(c, v) { f.push(['in', c, v]); return api; }, or(v) { f.push(['or', v]); return api; }, ilike() { return api; },
      update(r) { op = 'update'; row = r; return api; },
      maybeSingle() { return run(true); }, single() { return run(true); }, then(a, b) { return run(false).then(a, b); },
    };
    async function run(one) {
      if (op === 'update') {
        if (table === 'email_messages') { st.email.extracted = row.extracted || st.email.extracted; st.emailUpdates.push(row); }
        else st.notesUpdates.push({ table, row });
        return { data: null, error: null };
      }
      if (table === 'email_messages') return { data: st.email, error: null };
      if (table === 'board_members') return { data: board ? [{ name: 'Board President', community_id: 'cg', community_name: 'Canyon Gate at Cinco Ranch' }] : [], error: null };
      if (table === 'ap_intake_exceptions') return one ? { data: { notes: 'reimbursement: no amount stated in the email (receipt total $51.05)' }, error: null } : { data: st.exc, error: null };
      if (table === 'ap_invoices') return one ? { data: { notes: '' }, error: null } : { data: st.inv, error: null };
      return { data: [], error: null };
    }
    return api;
  };
  const calls = [];
  const intakeBillEmail = async (m, opts) => {
    calls.push({ m, opts });
    st.exc.push({ id: 'exc-1', status: 'pending', email_message_id: m.id, intake_source_ref: 'email:' + m.graph_id });
    return { results: [{ outcome: 'needs_review', _out: { extracted: RECEIPT } }], prepared: { files: [{ kind: 'pdf', buffer: Buffer.from('x') }] } };
  };
  return { sb: { from: q }, st, calls, deps: { intakeBillEmail, pdfText: async () => RECEIPT_TEXT } };
}
check('first handoff: Emma’s intake runs once, as a reimbursement, email kept open; one item; Amanda’s note on it; recorded on the email', async () => {
  const w = world();
  const r = await H.handoffToEmma(w.sb, 'sign1', w.deps);
  assert.strictEqual(r.status, 'handed');
  assert.strictEqual(w.calls.length, 1);
  assert.deepStrictEqual([w.calls[0].opts.intentHint.is_reimbursement, w.calls[0].opts.intentHint.reimbursee_name, w.calls[0].opts.keepOpen], [true, 'Board President', true]);
  assert.strictEqual(w.st.exc.length, 1);
  const note = w.st.notesUpdates.find((u) => u.table === 'ap_intake_exceptions');
  assert.ok(note && /^Amanda handoff/.test(note.row.notes) && /Amazon \(sold by Fastasticdeal\)/.test(note.row.notes) && /Intake: reimbursement: no amount stated/.test(note.row.notes));
  const rec = w.st.email.extracted.emma_handoff;
  assert.deepStrictEqual([rec.status, rec.exception_ids], ['handed', ['exc-1']]);
  assert.ok(!w.st.emailUpdates.some((u) => u.triage_status), 'the email is not closed');
});
check('running it again creates nothing: already with Emma, intake not called, still one item', async () => {
  const w = world();
  await H.handoffToEmma(w.sb, 'sign1', w.deps);
  const again = await H.handoffToEmma(w.sb, 'sign1', w.deps);
  assert.strictEqual(again.status, 'already_handed');
  assert.strictEqual(w.calls.length, 1);
  assert.strictEqual(w.st.exc.length, 1);
});
check('an existing AP invoice for the email, or a handoff recorded on the email, also blocks a duplicate', async () => {
  const a = world({ existingInv: [{ id: 'inv-9', status: 'awaiting_approval', intake_source_ref: 'email:g1' }] });
  assert.strictEqual((await H.handoffToEmma(a.sb, 'sign1', a.deps)).status, 'already_handed');
  const b = world({ recorded: { status: 'handed', exception_ids: ['exc-old'] } });
  assert.strictEqual((await H.handoffToEmma(b.sb, 'sign1', b.deps)).status, 'already_handed');
  assert.strictEqual(a.calls.length + b.calls.length, 0);
});
check('a non-routine email is not handed automatically', async () => {
  const w = world();
  w.st.email.body_full = 'Receipt for the attorney retainer is attached.';
  const r = await H.handoffToEmma(w.sb, 'sign1', w.deps);
  assert.strictEqual(r.status, 'not_eligible');
  assert.strictEqual(w.calls.length, 0);
});

console.log('\nWiring');
check('Emma’s intake honors an explicit reimbursement hint (route only; amount/coding rules unchanged)', () => {
  const s = src('lib/ap/intake.js');
  assert.match(s, /if \(intentHint && intentHint\.is_reimbursement\) intent = intentHint;/);
  assert.match(s, /R\.planReimbursement\(\{ intent, staffText/);
});
check('email intake can leave the email open for a pending reply', () => {
  assert.match(src('lib/ap/email_bill_intake.js'), /if \(decision\.handled && !opts\.keepOpen\) upd\.triage_status = 'handled';/);
});
check('ingest hands Amanda’s receipts to Emma after filing, without blocking', () => {
  const g = src('lib/email/graph_ingest.js');
  const file = g.indexOf("console.warn('[graph_ingest] file-to-folder skipped:'"); const hand = g.indexOf("require('../amanda/emma_handoff').handoffToEmma(supabase, insId)");
  assert.ok(file > 0 && hand > file, 'after filing');
  assert.match(g.slice(hand - 400, hand), /row\.persona === 'amanda' && email\.has_attachments/);
  assert.match(g.slice(hand, hand + 400), /\.catch\(/);
});
check('the Inbox can hand a receipt to Emma (admin-gated) and shows where it stands', () => {
  const a = src('api/amanda_email.js'); const k = a.indexOf("router.post('/inbox/:id/handoff-emma'");
  assert.ok(k > 0); assert.match(a.slice(k, k + 200), /requireAdmin/);
  const h = src('public/app/today.html');
  assert.ok(h.includes('data-ibact="emma"') && h.includes('Receipt handed to Emma for processing'));
});

Promise.all(pending).then(() => console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', with failures' : '')));
