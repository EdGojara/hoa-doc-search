// A bank's Positive Pay exception notice is Kat's accounting work, never an email to answer
// (lib/banking/positive_pay_notice + positive_pay_watch; Ed 2026-10-14). Shapes: NewFirst's
// 10/13 and 10/14/2026 notices (DDA-XX5961 Waterview, DDA-XX5313 Canyon Gate) and the bank
// specialist's reply that quoted the 10/13 reminder.
const PP = require('../lib/banking/positive_pay_notice');
const W = require('../lib/banking/positive_pay_watch');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };

const OCT14 = { direction: 'inbound', sender_email: 'treasurymanagement@newfirst.com', subject: 'Positive Pay Items Ready For Review', received_at: '2026-10-14T11:56:48Z',
  recipients: ['cdeleon@bedrocktx.com', 'egojara@bedrocktx.com', 'treasurymanagement@newfirst.com', 'kat@bedrocktx.com', 'accounting@graywoodpropertiesllc.com'],
  body_full: '<p>You have positive pay items to review. Please review these by 11:00AM.</p><table><tr><td>Account Number</td><td>Date</td><td>Item Number</td><td>Amount</td></tr><tr><td>DDA-XX5961</td><td>October 13, 2026</td><td>1037</td><td>$625.00</td></tr><tr><td>DDA-XX5313</td><td>October 13, 2026</td><td>1033</td><td>$918.90</td></tr><tr><td>DDA-XX5313</td><td>October 13, 2026</td><td>1044</td><td>$4275.87</td></tr></table>' };
const REPLY = { direction: 'inbound', sender_email: 'TreasuryManagement@newfirst.com', subject: 'RE: Reminder: Positive Pay Items Ready For Review', received_at: '2026-10-13T15:43:13Z', recipients: ['cdeleon@bedrocktx.com', 'kat@bedrocktx.com', 'accounting@graywoodpropertiesllc.com', 'egojara@bedrocktx.com'],
  body_full: 'Good morning, The below item is still outstanding in Positive Pay and needs to be reviewed as soon as possible. Please contact our department to approve or return this item. From: treasurymanagement@newfirst.com Sent: Tuesday, October 13, 2026 8:55 AM Subject: Reminder: Positive Pay Items Ready For Review You still have positive pay exception items to review by 11:00AM. Account Number Date Item Number Amount DDA-XX5961 October 9, 2026 1033 $740.00' };

console.log('detect and parse');
{
  const n = PP.parseNotice(OCT14);
  check('three items, account ending / date / check / amount', JSON.stringify(n.items) === JSON.stringify([{ account_last4: '5961', presented_date: '2026-10-13', check_number: '1037', amount_cents: 62500 }, { account_last4: '5313', presented_date: '2026-10-13', check_number: '1033', amount_cents: 91890 }, { account_last4: '5313', presented_date: '2026-10-13', check_number: '1044', amount_cents: 427587 }]), JSON.stringify(n.items));
  check('stated cutoff 11:00, not a reminder', n.stated_cutoff === '11:00' && !n.reminder);
  const r = PP.parseNotice(REPLY);
  check('a bank person replying above the system notice: the quoted item is read once, as a reminder', r.items.length === 1 && r.items[0].check_number === '1033' && r.reminder && r.replied_by_person);
  check('detected as a Positive Pay notice', PP.isPositivePayNotice(OCT14) && PP.isPositivePayNotice(REPLY));
  check('not detected: our own outbound mail, a subject without Positive Pay, or one with no item rows', !PP.isPositivePayNotice({ ...OCT14, direction: 'outbound' }) && !PP.isPositivePayNotice({ ...OCT14, subject: 'Items ready' }) && !PP.isPositivePayNotice({ ...OCT14, body_full: 'Positive Pay is now live on your accounts.' }) && !PP.isPositivePayNotice({ ...OCT14, sender_email: 'kat@bedrocktx.com' }));
}

console.log('recipients and deadline');
{
  const exp = ['cdeleon@bedrocktx.com', 'egojara@bedrocktx.com', 'kat@bedrocktx.com', 'treasurymanagement@newfirst.com'];
  const r = PP.reviewRecipients(OCT14.recipients, OCT14.sender_email, [exp], exp);
  check('Graywood is unexpected against the bank\'s expected list, and newly added versus earlier notices', JSON.stringify(r.unexpected) === '["accounting@graywoodpropertiesllc.com"]' && JSON.stringify(r.newly_added) === '["accounting@graywoodpropertiesllc.com"]');
  const d = PP.reviewRecipients(OCT14.recipients, OCT14.sender_email, []);
  check('without a configured list, anyone outside our domains and the bank\'s is unexpected', JSON.stringify(d.unexpected) === '["accounting@graywoodpropertiesllc.com"]');
  const dl = PP.deadlineFor(OCT14.received_at, '11:00', '10:00');
  check('deadline: the earlier of the notice (11:00) and the bank\'s configured cutoff (10:00), Central (CDT)', dl.at === '2026-10-14T15:00:00.000Z' && dl.source === 'bank configuration', JSON.stringify(dl));
  check('in winter the same cutoff is CST', PP.deadlineFor('2026-12-14T14:00:00Z', '10:00', null).at === '2026-12-14T16:00:00.000Z');
}

console.log('matching against the books');
{
  const acct = [{ id: 'ba-cg', community_id: 'cg', bank_id: 'nf', account_nickname: 'Canyon Gate Operating', community_name: 'Canyon Gate' }];
  const ok = { accounts: acct, register: [{ check_number: '1044', issue_date: '2026-10-01', payee_name: 'AAA Awning Co., Inc.', amount_cents: 427587, status: 'issued' }], payment: { status: 'completed' }, invoices: [{ id: 'i1', vendor_invoice_number: '0092546-IN', invoice_date: '2026-09-23', total_cents: 427587 }], approvals: [{ invoice_id: 'i1', action: 'approved', user_name: 'cdeleon@bedrocktx.com' }, { invoice_id: 'i1', action: 'released_for_payment', user_name: 'egojara@bedrocktx.com' }], je_reference: 'JE-2026-00386' };
  const item = { account_last4: '5313', presented_date: '2026-10-13', check_number: '1044', amount_cents: 427587 };
  const m = PP.judgeItem(item, ok);
  check('issued check, same amount, approved and released invoice: MATCH', m.verdict === 'matched' && m.payee === 'AAA Awning Co., Inc.' && m.invoices[0].approved_by && m.invoices[0].released_by, JSON.stringify(m.reasons));
  check('a different amount is a discrepancy', PP.judgeItem({ ...item, amount_cents: 427529 }, ok).verdict === 'discrepancy');
  check('a voided check is a discrepancy', /voided/.test(PP.judgeItem(item, { ...ok, register: [{ ...ok.register[0], status: 'voided', voided_at: '2026-10-05' }] }).reasons.join(' ')));
  check('an already-cleared check is a second presentment', /second presentment/.test(PP.judgeItem(item, { ...ok, register: [{ ...ok.register[0], cleared_date: '2026-10-06' }] }).reasons.join(' ')));
  check('a check not in the register is UNMATCHED', PP.judgeItem(item, { ...ok, register: [] }).verdict === 'unmatched');
  check('an unknown account ending is a discrepancy', /no active bank account/.test(PP.judgeItem(item, { accounts: [], register: [] }).reasons.join(' ')));
  check('an invoice without approval or release is a discrepancy', PP.judgeItem(item, { ...ok, approvals: [] }).verdict === 'discrepancy');
}

console.log('review on books (in-memory)');
(async () => {
  const db = {
    bank_accounts: [{ id: 'ba-wv', community_id: 'wv', bank_id: 'nf', account_nickname: 'Waterview Operating', account_last4: '5961', is_active: true, communities: { name: 'Waterview Estates' } }, { id: 'ba-cg', community_id: 'cg', bank_id: 'nf', account_nickname: 'Canyon Gate Operating', account_last4: '5313', is_active: true, communities: { name: 'Canyon Gate' } }],
    check_register: [{ bank_account_id: 'ba-wv', check_number: '1037', issue_date: '2026-10-09', payee_name: 'Sweetie Pies Petting Zoo', amount_cents: 62500, status: 'issued', ap_payment_id: 'p1' }, { bank_account_id: 'ba-cg', check_number: '1033', issue_date: '2026-09-16', payee_name: 'GymTech360', amount_cents: 91890, status: 'issued', ap_payment_id: 'p2' }, { bank_account_id: 'ba-cg', check_number: '1044', issue_date: '2026-10-01', payee_name: 'AAA Awning Co., Inc.', amount_cents: 427587, status: 'issued', ap_payment_id: 'p3' }],
    ap_payments: [{ id: 'p1', status: 'completed' }, { id: 'p2', status: 'completed' }, { id: 'p3', status: 'completed' }],
    ap_payment_applications: [{ payment_id: 'p1', invoice_id: 'i1' }, { payment_id: 'p2', invoice_id: 'i2' }, { payment_id: 'p3', invoice_id: 'i3' }],
    ap_invoices: [{ id: 'i1', vendor_invoice_number: null, invoice_date: '2026-10-10', total_cents: 62500 }, { id: 'i2', vendor_invoice_number: '2732', total_cents: 91890 }, { id: 'i3', vendor_invoice_number: '0092546-IN', total_cents: 427587 }],
    ap_invoice_approvals: ['i1', 'i2', 'i3'].flatMap((id) => [{ invoice_id: id, action: 'approved', user_name: 'cdeleon@bedrocktx.com' }, { invoice_id: id, action: 'released_for_payment', user_name: 'egojara@bedrocktx.com' }]),
    journal_entries: [], banks: [{ id: 'nf', name: 'NewFirst National Bank', positive_pay_settings: { exception_cutoff: '10:00', notice_sender_domain: 'newfirst.com', expected_recipients: ['cdeleon@bedrocktx.com', 'egojara@bedrocktx.com', 'kat@bedrocktx.com', 'treasurymanagement@newfirst.com'] } }],
    email_messages: [{ id: 'old', sender_email: 'treasurymanagement@newfirst.com', subject: 'Positive Pay Items Ready For Review', received_at: '2026-10-09T11:56:00Z', recipients: ['cdeleon@bedrocktx.com', 'egojara@bedrocktx.com', 'treasurymanagement@newfirst.com', 'kat@bedrocktx.com'] }],
  };
  const sb = { from(t) { const st = { f: [] }; const q = { select() { return q; }, eq(c, v) { st.f.push((r) => r[c] === v); return q; }, in(c, vs) { st.f.push((r) => vs.includes(r[c])); return q; }, ilike(c, p) { const re = new RegExp('^' + p.replace(/%/g, '.*') + '$', 'i'); st.f.push((r) => re.test(r[c] || '')); return q; }, lt(c, v) { st.f.push((r) => r[c] < v); return q; }, gte(c, v) { st.f.push((r) => r[c] >= v); return q; }, order() { return q; }, limit() { return q; },
    update(p) { st.upd = p; return q; },
    then(res) { if (st.upd) { (db[t] || []).filter((r) => st.f.every((fn) => fn(r))).forEach((r) => Object.assign(r, st.upd)); return Promise.resolve({ data: null, error: null }).then(res); } return Promise.resolve({ data: (db[t] || []).filter((r) => st.f.every((fn) => fn(r))), error: null }).then(res); } }; return q; } };
  const rv = await PP.reviewNotice(sb, OCT14);
  check('all three checks MATCH, each to its community, payee and register', rv.items.length === 3 && rv.items.every((i) => i.verdict === 'matched') && rv.items.map((i) => i.community_name).join() === 'Waterview Estates,Canyon Gate,Canyon Gate', JSON.stringify(rv.items.map((i) => [i.verdict, i.reasons])));
  check('the invoice with no number is noted, not a discrepancy', rv.items[0].notes.length === 1);
  check('Graywood escalated to Ed as an unexpected recipient (not routine), with the 10:00 bank cutoff', !rv.routine && rv.escalate.length === 1 && /graywoodpropertiesllc/.test(rv.escalate[0]) && /not on the bank's earlier notices/.test(rv.escalate[0]) && rv.deadline.at === '2026-10-14T15:00:00.000Z' && rv.bank === 'NewFirst National Bank', JSON.stringify(rv.escalate));
  check('the matched items are prepared for an authorized user to decide Pay in the bank portal; no reply to the bank', /ready to be decided Pay in the bank portal/.test(rv.next) && !/Ed will/i.test(rv.summary));
  const clean = await PP.reviewNotice(sb, { ...OCT14, recipients: OCT14.recipients.filter((r) => !/graywood/.test(r)) });
  check('without the stranger: routine, nothing escalated, "decide Pay before 10:00 Central"', clean.routine && !clean.escalate.length && /decide Pay in the bank portal before 10:00 Central/.test(clean.next));

  console.log('routing: Kat, no reply');
  const persona = require('../lib/email/persona');
  check('the notice belongs to Kat in any mailbox, Ed\'s included', ['egojara@bedrocktx.com', 'cdeleon@bedrocktx.com', 'kat@bedrocktx.com', 'info@bedrocktx.com'].every((mb) => persona.personaForMessage({ ...OCT14, mailbox: mb, classification: 'vendor_financial', extracted: {} }) === 'kat'));
  const fs = require('fs'); const src = fs.readFileSync(require.resolve('../lib/email/graph_ingest'), 'utf8');
  check('ingest drafts no reply of any kind for it, skips vendor bill and payment-chase matching, and stores Kat\'s review', (src.match(/if \(!draft && !ppNotice/g) || []).length >= 8 && /!ppNotice && isCompletionAck/.test(src) && (src.match(/!light && !ppNotice && email\.direction === 'inbound' && \['vendor_financial'/g) || []).length === 2 && /positive_pay: ppNotice \?/.test(src) && /if \(ppNotice\) row\.persona = 'kat'/.test(src));
  const tri = fs.readFileSync(require.resolve('../api/email_triage'), 'utf8');
  check('"Draft reply" on it is NOT refused: Kat drafts correspondence to a verified bank contact for approval (processing stays separate)', /isPositivePayNotice\(\{ \.\.\.m, recipients: undefined \}\)/.test(tri) && /BC\.draftForNotice\(/.test(tri) && !/draftable: false, positive_pay: review/.test(tri));
  check('sending it is a fresh message (never threaded to the notice sender, never quoting the notice) behind the bank-recipient guard', /const threaded = !bankInquiry &&/.test(tri) && /threaded \|\| bankInquiry \? '' : quoted/.test(tri) && /sendGuard\(/.test(tri));
  check('ingest drafts no reply to a notice; an unfamiliar recipient is the shared vigilance engine\'s case (run on every inbound message after it is stored)', !/draftForNotice\(supabase, \{ email, review: ppReview \}\)/.test(src) && /require\('\.\.\/vigilance\/engine'\)\.evaluate\(supabase/.test(src));

  console.log('deadline watch');
  const now = new Date('2026-10-14T12:30:00Z');
  const first = W.dueAlerts(rv, now);
  check('an unexpected recipient alone does not text from the Positive Pay watch (vigilance owns it: one case, one escalation)', !first.length);
  const unmatched = { ...rv, escalate: [...rv.escalate, '5313 check 1099 $10.00: check 1099 is not in the issued-check register'] };
  const firstU = W.dueAlerts(unmatched, now);
  check('an unmatched item texts Ed at once', firstU.length === 1 && firstU[0].kind === 'exception' && /not in the issued-check register/.test(firstU[0].text) && !/graywood/.test(firstU[0].text));
  const sent = { ...unmatched, alerts: [{ kind: 'exception' }] };
  check('then nothing until the last hour', !W.dueAlerts(sent, now).length);
  check('still open 45 minutes before the cutoff: the exception again, and the undecided items (a match is not the bank\'s decision)', W.dueAlerts(sent, new Date('2026-10-14T14:15:00Z')).map((a) => a.kind).join() === 'exception_deadline,undecided_near_cutoff');
  check('decided in the bank portal: no more texts', !W.dueAlerts({ ...unmatched, decided_at: '2026-10-14T13:00:00Z' }, new Date('2026-10-14T14:15:00Z')).length);
  check('a routine notice: no text until the last hour; then once if its items are still undecided; then once if the cutoff passes unconfirmed', !W.dueAlerts(clean, now).length && W.dueAlerts(clean, new Date('2026-10-14T14:15:00Z')).map((a) => a.kind).join() === 'undecided_near_cutoff' && W.dueAlerts({ ...clean, alerts: [{ kind: 'undecided_near_cutoff' }] }, new Date('2026-10-14T16:00:00Z')).map((a) => a.kind).join() === 'cutoff_passed_unconfirmed');
  check('a bank reminder near the cutoff is an exception (the cutoff may be missed)', W.dueAlerts({ ...clean, notice: { reminder: true }, alerts: [{ kind: 'undecided_near_cutoff' }] }, new Date('2026-10-14T14:00:00Z')).map((a) => a.kind).join() === 'reminder_near_cutoff');
  check('every item starts "bank decision unconfirmed", separate from matching our register', rv.items.every((i) => i.bank_decision === 'unconfirmed') && /bank decision unconfirmed/.test(rv.summary) && /A match is not the bank's decision/.test(clean.next));
  { const conf = { items: [{ account_last4: '5313', check_number: '1044', amount_cents: 427587, bank_account_id: 'ba-cg', bank_decision: 'unconfirmed' }] };
    db.bank_statement_imports = [{ id: 'imp-cg', bank_account_id: 'ba-cg' }]; db.bank_statement_transactions = [{ bank_statement_import_id: 'imp-cg', check_number: '1044', amount_cents: -427587, posting_date: '2026-10-16' }];
    const ch = await W.confirmFromStatements(sb, conf);
    check('clearing comes from bank activity: a check on the statement is recorded CLEARED, separately from the exception decision', ch && conf.items[0].cleared_date === '2026-10-16' && /check transaction on the bank statement, posted 2026-10-16/.test(conf.items[0].cleared_evidence) && conf.items[0].bank_decision === 'unconfirmed'); }
  { const tri2 = fs.readFileSync(require.resolve('../api/email_triage'), 'utf8');
    check('a person records the portal decision per item (pay / return); a note alone confirms nothing', /decisions = Array\.isArray\(req\.body && req\.body\.decisions\)/.test(tri2) && /allDecided \? \{ decided_at: at/.test(tri2)); }
  db.email_messages.push({ id: 'today', direction: 'inbound', ...OCT14, extracted: {} });
  const texts = [];
  const t1 = await W.tick({ supabase: sb, now, notify: async (b) => { texts.push(b); return { ok: true, sid: 'SM1' }; }, logger: { warn() {} } });
  const t2 = await W.tick({ supabase: sb, now, notify: async (b) => { texts.push(b); return { ok: true }; }, logger: { warn() {} } });
  const rec = db.email_messages.find((m) => m.id === 'today');
  check('the watch reviews today\'s notice and files it to Kat; the recipient case is vigilance\'s, so no Positive Pay text', t1.reviewed === 1 && t1.alerted === 0 && t2.alerted === 0 && texts.length === 0 && rec.persona === 'kat' && rec.extracted.positive_pay && rec.extracted.positive_pay.items.length === 3, JSON.stringify([t1, t2, texts.length]));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
