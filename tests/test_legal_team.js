// ============================================================================
// tests/test_legal_team.js  (Ed 2026-10-11)
// ----------------------------------------------------------------------------
// Emma -> Amanda -> Kat on an attorney invoice. Deterministic: fake Supabase,
// fake mail / OneDrive / attachment sources. Pins:
//   - Amanda reads attorney status reports and notice letters as text, keeps the
//     right owner's passage (never the next owner's bankruptcy), and records
//     verified evidence apart from references and assumptions
//   - recommendations follow only from verified evidence; bankruptcy holds;
//     a deed-restriction matter gets the deed-restriction fee category
//   - outside requests are drafted only after internal sources are searched,
//     and always held for approval
//   - Kat refuses a treatment that credits AP, lacks the 1300 debit, or would
//     duplicate an owner charge
//   - one activity per invoice whose stage moves and closes automatically
//   - the team never approves, posts, pays or sends
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const RS = require('../lib/legal/research');
const TEAM = require('../lib/legal/team');
const { verifyTreatment } = require('../lib/legal/kat_verify');

let pass = 0, fail = 0;
const pending = [];
const t = (n, f) => pending.push([n, f]);
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// ---- fake Supabase (select / eq / in / limit / maybeSingle) --------------------
function fakeDb(tables) {
  return {
    tables,
    from(table) {
      const f = [];
      const q = {
        select() { return q; }, eq(k, v) { f.push((r) => r[k] === v); return q; }, in(k, vs) { f.push((r) => vs.includes(r[k])); return q; },
        neq(k, v) { f.push((r) => r[k] !== v); return q; }, order() { return q; }, limit() { return q; },
        maybeSingle() { return Promise.resolve({ data: (tables[table] || []).filter((r) => f.every((x) => x(r)))[0] || null, error: null }); },
        then(res, rej) { return Promise.resolve({ data: (tables[table] || []).filter((r) => f.every((x) => x(r))), error: null }).then(res, rej); },
      };
      return q;
    },
  };
}

// ---- texts modelled on the real documents ----------------------------------
const DF_REPORT = `Enclosed is the collection status report. The following payments were received since our last reporting:
Duncan - 6234 Clear Canyon Dr. CK#11787 $467.00 7/17/26 Brown - 6511 Glen Canyon Ct. CK#1 $10.00
COLLECTION STATUS REPORT BANKRUPTCY NEGRON, HEIDI – 6505 Kings Summit Dr. 2705.0006 11/15/24 Received file from prior counsel. Prior counsel indicated the bankruptcy remains active. 8/12/26 Mailed a post-petition demand letter.
BATISTE, REMICA – 6306 Clear Canyon Dr. 2705.0013 10/14/25 Mailed initial demand letter on September 29, 2025. waive the 2019-2021 balance pursuant to the Statute of Limitations. 04/13/26 the homeowner had filed bankruptcy on November 4, 2025. 08/12/26 The Bankruptcy case was dismissed on June 17, 2026.
BROWN, ORELESSA O. – 6511 Glen Canyon Ct. 2705.0014 10/14/25 Mailed initial demand letter on September 29, 2025. 08/12/26 Received payoff request. Forwarded the payoff statement good through August 31st to Danielle Ruiz on July 23, 2026. Payoff Balance Due: $15,086.54.
MOUGHAIT, NADER – 6310 Holly Canyon Ct. 2705.0011 Mailed initial demand letter on September 29, 2025. We advised that a letter was mailed via certified mail on March 25, 2025.`;
const RMWBH_REPORT = 'Deed Restriction DRV Litigation Martinez, Ricardo Ignacio (5922 Spring Sunrise Dr) 13705-20061 Last Action: 05/25/26 Pending - Return of executed Affidavit (Lit) (DRV) 01/20/26 Per Association: the trailer violation remained open.';
const WV_NOTICE = 'NOTICE OF VIOLATION HEARING December 13, 2024 Certified Mail No. 9589 0710 5270 2276 8814 10 Ricardo Martinez 5922 Spring Sunrise Drive Richmond, TX 77407 a covenant violation exists. cure within 30 days. You may also request a hearing before the Board. you will be responsible for all reasonable attorney fees. Texas Property Code Section 209.006(b)(1).';
const LOPF_NOTICE = 'April 23, 2025 Vance Nobe Certified Mail No. 9589 0710 5270 2276 8848 48 17714 Quiet Loch Lane Re: PAST DUE ASSESSMENTS If the delinquent balance is not paid within forty-five (45) days ... you have the right to request a payment plan ... you will be responsible for the reasonable attorneys\' fees.';

// ---- research: reading documents --------------------------------------------
t('status report: the matter section is used, not the payments list, and the window stops at the next owner', () => {
  const w = RS.windowAround(DF_REPORT, ['6511 Glen Canyon']);
  assert.ok(/2705\.0014/.test(w) && /payoff statement/.test(w));
  assert.ok(!/MOUGHAIT/.test(w), 'stops at the next owner heading');
  const neg = RS.readStatusPassage(RS.windowAround(DF_REPORT, ['NEGRON']));
  assert.strictEqual(neg.bankruptcy, 'active');
  const bat = RS.readStatusPassage(RS.windowAround(DF_REPORT, ['6306 Clear Canyon']));
  assert.strictEqual(bat.bankruptcy, 'dismissed'); assert.strictEqual(bat.bankruptcy_date, 'June 17, 2026');
  const brown = RS.readStatusPassage(RS.windowAround(DF_REPORT, ['6511 Glen Canyon']));
  assert.ok(!brown.bankruptcy, 'Batiste\'s bankruptcy never bleeds into Brown');
  assert.deepStrictEqual(brown.payoff, { good_through: 'August 31st', amount: '15,086.54' });
  assert.strictEqual(RS.readStatusPassage(RS.windowAround(DF_REPORT, ['6310 Holly Canyon'])).prior_certified_notice, 'March 25, 2025');
  assert.strictEqual(RS.readStatusPassage('DUNCAN, RONALD – 6234 Clear Canyon Dr. 2705.0019 Mailed initial demand letter. Notice of Assessment Lien recorded. owner also asked about a parking violation.').work_type, 'collection', 'a stray violation in a collection file is still collection');
});
t('status report: a mixed-case summary line never pulls in the next category (no false bankruptcy)', () => {
  const rm = 'Summary of Matters Deed Restriction DRV Litigation Martinez, Ricardo Ignacio (5922 Spring Sunrise Dr) Heather Campbell - hc@rmwbh.test 13705-20061 05/25/26 Pending - Return of executed Affidavit (Lit) (DRV) $998.00 Page 1 of 5 Details of Matters Collection Bankruptcy Benford, Lasandra (19810 Moss Bark Trl) 13705-00018 BK-Monitoring Bankruptcy';
  const r = RS.readStatusPassage(RS.windowAround(rm, ['13705-20061', '5922 Spring Sunrise']));
  assert.ok(!r.bankruptcy, 'Benford\'s bankruptcy is not Martinez\'s');
  assert.strictEqual(r.work_type, 'drv');
});
t('status report: an RMWBH DRV matter reads as deed-restriction work', () => {
  assert.strictEqual(RS.readStatusPassage(RS.windowAround(RMWBH_REPORT, ['5922 Spring Sunrise'])).work_type, 'drv');
});
t('notice letters: §209.006 and §209.0064 notices are recognised from their own text, with the certified number', () => {
  const wv = RS.readNoticeText(WV_NOTICE, { address: '5922 Spring Sunrise Drive', surname: 'Martinez' });
  assert.strictEqual(wv.kind, 'drv_209_006'); assert.ok(wv.certified_number.startsWith('9589 0710 5270 2276 8814')); assert.ok(wv.fee_warning && wv.hearing_right);
  const lopf = RS.readNoticeText(LOPF_NOTICE, { address: '17714 Quiet Loch Lane', surname: 'Nobe' });
  assert.strictEqual(lopf.kind, 'collection_209_0064'); assert.ok(lopf.payment_plan_right && lopf.fee_warning);
  assert.strictEqual(RS.readNoticeText(LOPF_NOTICE, { address: '4814 Bonny Loch Lane', surname: 'Shahid' }), null, 'a letter for another owner proves nothing');
});

// ---- research: recommendations -----------------------------------------------
const base = (signals, extra) => Object.assign({ verified: [{ source: 'x', fact: 'y' }], references: [], assumptions: [], missing: [], sources_searched: ['a', 'b', 'c'], signals: Object.assign({ owner_current: true }, signals) }, extra || {});
t('recommend: active bankruptcy holds; dismissed bankruptcy goes to the owner; ownership and duplicates go to review', () => {
  assert.strictEqual(RS.recommend(base({ bankruptcy: { status: 'active', source: 'r' }, collection_notice_verified: true }), {}).recommendation, 'hold');
  assert.strictEqual(RS.recommend(base({ bankruptcy: { status: 'dismissed', source: 'r' }, collection_notice_verified: true }), {}).recommendation, 'review');
  assert.strictEqual(RS.recommend(base({ owner_current: false, collection_notice_verified: true }), {}).recommendation, 'review');
  assert.strictEqual(RS.recommend(base({ already_billed: true, collection_notice_verified: true }), {}).recommendation, 'review');
});
t('recommend: a verified notice supports recovery; a deed-restriction matter takes the deed-restriction category', () => {
  const r = RS.recommend(base({ work_type: 'drv', drv_notice_verified: true }), { charge_category: 'attorney_fee' });
  assert.strictEqual(r.recommendation, 'recoverable'); assert.strictEqual(r.charge_category, 'attorney_fee_other');
  assert.ok(r.verified.some((v) => /should be attorney_fee_other/.test(v.fact)));
  const c = RS.recommend(base({ status_report: { prior_certified_notice: 'March 25, 2025' } }), { charge_category: 'attorney_fee' });
  assert.strictEqual(c.recommendation, 'recoverable');
});
t('recommend: no verified notice is review with the specific missing document, never recoverable', () => {
  const r = RS.recommend(base({}), { charge_category: 'attorney_fee' });
  assert.strictEqual(r.recommendation, 'review');
  assert.ok(r.missing.some((m) => /209\.0064/.test(m)));
});
t('outside request: drafted only after internal search, always held; never for a bankruptcy hold', () => {
  const f = RS.recommend(base({}), {}); f.address = '1 Test Ln'; f.matter_ref = '2705.0099';
  const req = RS.draftExternalRequest(f, { vendorName: 'D&F', invoiceNumber: '280595' });
  assert.strictEqual(req.status, 'held_for_approval'); assert.ok(/searched our own records first/.test(req.body));
  const thin = Object.assign(RS.recommend(base({}), {}), { sources_searched: ['trustEd', 'email: not searched (Graph not configured on this server)'] });
  assert.strictEqual(RS.draftExternalRequest(thin, {}), null, 'not every source was available: search first');
  assert.strictEqual(RS.draftExternalRequest(RS.recommend(base({ bankruptcy: { status: 'active', source: 'r' } }), {}), {}), null);
});

// ---- research: one allocation end to end (fake records + sources) -------------
t('researchAllocation: trustEd + attorney report + OneDrive notice -> verified, recoverable, DRV category', async () => {
  const db = fakeDb({
    ownership_tenures: [{ id: 'ten-1', property_id: 'p1', kind: 'owner', start_date: '2019-04-01', end_date: null }],
    ar_account_collections: [], violations: [], sent_letter_archive: [],
    homeowner_transactions: [{ property_id: 'p1', txn_type: 'charge', charge_category: 'attorney_fee', description: 'Legal Fees / PS-INV338518', amount_cents: 44500 }],
  });
  const ctx = { invoiceNumber: 'PS-INV350881', props: new Map([['p1', { id: 'p1', street_address: '5922 Spring Sunrise Drive' }]]), owners: new Map([['p1', ['Ricardo Martinez']]]) };
  const sources = {
    graphConfigured: () => true, mailboxes: () => ['ed@example.test'], driveOwner: () => 'ed@example.test',
    searchMail: async (_m, q) => ({ messages: /5922/.test(q) ? [{ id: 'm1', subject: 'RMWBH Status Report - Waterview', received_at: '2026-05-28', from: { email: 'status@rmwbh.test' }, has_attachments: true, web_link: 'L1' }] : [] }),
    attachmentTexts: async () => [{ name: 'RMWBH Status Report.pdf', text: RMWBH_REPORT }],
    searchDrive: async () => ({ items: [{ id: 'd1', name: 'Martinez - Violation - Notice of Violation Hearing.pdf', web_url: 'W1' }] }),
    driveText: async () => WV_NOTICE,
  };
  const f = await RS.researchAllocation(db, ctx, { item: { id: 'it1', matter_ref: '13705-20061' }, alloc: { id: 'a1', property_id: 'p1', tenure_id: 'ten-1', classification: 'homeowner_recoverable', charge_category: 'attorney_fee', amount_cents: 55735 } }, sources, { reports: new Map() });
  assert.strictEqual(f.recommendation, 'recoverable', JSON.stringify(f.missing));
  assert.strictEqual(f.charge_category, 'attorney_fee_other');
  assert.strictEqual(f.evidence_grade, 'verified');
  assert.ok(f.verified.some((v) => /OneDrive/.test(v.source) && /209\.006/.test(v.fact)));
  assert.ok(f.verified.some((v) => /status report/.test(v.source)));
  assert.ok(f.references.some((r) => /RMWBH Status Report/.test(r.fact)), 'the email itself is a reference');
  assert.ok(f.sources_searched.some((s) => /^email:/.test(s)) && f.sources_searched.some((s) => /^OneDrive:/.test(s)));
});
t('researchAllocation: OneDrive without permission is recorded as not accessible, not as nothing found', async () => {
  const db = fakeDb({ ownership_tenures: [{ id: 'ten-1', property_id: 'p1', kind: 'owner', end_date: null }], ar_account_collections: [], violations: [], sent_letter_archive: [], homeowner_transactions: [] });
  const ctx = { invoiceNumber: 'X', props: new Map([['p1', { street_address: '1 A St' }]]), owners: new Map() };
  const sources = { graphConfigured: () => true, mailboxes: () => [], driveOwner: () => 'ed', searchDrive: async () => { throw Object.assign(new Error('Forbidden'), { status: 403 }); } };
  const f = await RS.researchAllocation(db, ctx, { item: {}, alloc: { property_id: 'p1', tenure_id: 'ten-1', classification: 'homeowner_recoverable' } }, sources, { reports: new Map() });
  assert.ok(f.sources_searched.some((s) => /OneDrive not accessible/.test(s)));
  assert.ok(f.missing.some((m) => /internal search incomplete: OneDrive/.test(m)));
  assert.strictEqual(RS.draftExternalRequest(f, {}), null, 'no outside request while an internal source was unavailable');
  assert.strictEqual(f.recommendation, 'review');
});

// ---- Amanda writes into AI drafts only ---------------------------------------
t('applyRecommendations: changes the draft, attests only verified recoveries; holds become needs_review', () => {
  const d = { saved: { items: [{ source_line_ids: ['l1'], matter_ref: 'm', allocations: [
    { id: 'a1', amount_cents: 100, classification: 'homeowner_recoverable', property_id: 'p1', charge_category: 'attorney_fee', evidence: [] },
    { id: 'a2', amount_cents: 50, classification: 'homeowner_recoverable', property_id: 'p2', charge_category: 'attorney_fee', evidence: [] }] }] } };
  const findings = [
    { allocation_id: 'a1', recommendation: 'recoverable', classification: 'homeowner_recoverable', charge_category: 'attorney_fee_other', reason: 'notice verified', verified: [{ source: 's', fact: 'f' }], missing: [], evidence_grade: 'verified' },
    { allocation_id: 'a2', recommendation: 'hold', classification: 'needs_review', charge_category: null, reason: 'active bankruptcy', verified: [{ source: 's', fact: 'f' }], missing: [], evidence_grade: 'verified' }];
  const { items, changed } = TEAM.applyRecommendations(d, findings);
  assert.ok(changed);
  const [a1, a2] = items[0].allocations;
  assert.strictEqual(a1.charge_category, 'attorney_fee_other'); assert.strictEqual(a1.confirmed, true); assert.ok(/^Amanda \(AI\): recoverable/.test(a1.note));
  assert.strictEqual(a2.classification, 'needs_review'); assert.strictEqual(a2.confirmed, false);
});
t('amandaResearch: a draft a person saved is never rewritten; the recommendation is recorded only', async () => {
  let saved = false;
  const db = { rpc: async () => { saved = true; return { data: { ok: true, revision: 9 } }; } };
  const d = { saved: { review: { revision: 3, updated_by: 'owner@example.test' }, items: [{ allocations: [{ id: 'a1' }] }] } };
  const out = await TEAM.amandaResearch(db, d, { research: async () => ({ findings: [{ allocation_id: 'a1', recommendation: 'review', verified: [], missing: [] }] }) });
  assert.strictEqual(saved, false);
  assert.ok(/recorded only/.test(out.applied_to_draft));
});

// ---- Kat --------------------------------------------------------------------
const katDb = (charges = []) => fakeDb({
  chart_of_accounts: [{ id: 'a1300', account_number: '1300', account_name: 'Accounts Receivable' }, { id: 'a5870', account_number: '5870', account_name: 'Legal Fees - Collections/DRV' }, { id: 'a2000', account_number: '2000', account_name: 'Accounts Payable' }],
  homeowner_transactions: charges,
});
const plan = (over) => Object.assign({ ready: true, blocking: [], posting_date: '2026-09-01', invoice_total_cents: 1000, totals: { homeowner_cents: 800, association_cents: 200, bedrock_cents: 0 },
  postings: [{ kind: 'homeowner_chargeback', property_id: 'p1', amount_cents: 800, debit_account_id: 'a1300', credit_account_id: 'a5870' }] }, over || {});
const kd = { invoice: { id: 'inv', invoice_number: '280595' }, invoiceNumber: '280595' };
t('Kat: Dr 1300 / Cr 5870, balanced, reconciled, no duplicates -> verified and ready for the owner', async () => {
  const k = await verifyTreatment(katDb(), kd, plan(), { livePostings: 0 });
  assert.ok(k.verified && k.ready_for_owner_approval, JSON.stringify(k.checks.filter((c) => !c.ok)));
});
t('Kat: a credit to AP, a missing 1300 debit, a duplicate owner charge or a live posting all fail', async () => {
  const ap = await verifyTreatment(katDb(), kd, plan({ postings: [{ kind: 'homeowner_chargeback', property_id: 'p1', amount_cents: 800, debit_account_id: 'a1300', credit_account_id: 'a2000' }] }), { livePostings: 0 });
  assert.ok(!ap.verified && ap.checks.some((c) => !c.ok && /never AP/.test(c.name)));
  const nodr = await verifyTreatment(katDb(), kd, plan({ postings: [{ kind: 'homeowner_chargeback', property_id: 'p1', amount_cents: 800, debit_account_id: 'a5870', credit_account_id: 'a5870' }] }), { livePostings: 0 });
  assert.ok(!nodr.verified);
  const dup = await verifyTreatment(katDb([{ property_id: 'p1', txn_type: 'charge', description: 'Legal Fees / 280595' }]), kd, plan(), { livePostings: 0 });
  assert.ok(!dup.verified && dup.checks.some((c) => !c.ok && /invoice number/.test(c.name)));
  const live = await verifyTreatment(katDb(), kd, plan(), { livePostings: 1 });
  assert.ok(!live.verified);
  const unrec = await verifyTreatment(katDb(), kd, plan({ invoice_total_cents: 1001 }), { livePostings: 0 });
  assert.ok(!unrec.verified);
});

// ---- the activity ----------------------------------------------------------------
const row = (o) => Object.assign({ id: 'inv', community_id: 'c', invoice_number: '280595', vendor: 'D&F', total_cents: 474061, ap_status: 'awaiting_approval', paid: false, released: false,
  read_only: null, review_status: 'draft', has_draft: true, homeowner_cents: 0, exceptions: [], postings: { pending: 0, posted: 0 } }, o || {});
t('activity: one stage at a time, closing automatically when paid', () => {
  assert.ok(/research in progress/.test(TEAM.legalInvoice(row({ has_draft: false })).title));
  const bk = TEAM.legalInvoice(row({ exceptions: [{ matter: '2705.0006', kind: 'bankruptcy', reason: 'bankruptcy: hard stop' }] }));
  assert.strictEqual(bk.autonomy_class, 'BLOCK'); assert.ok(/bankruptcy exception/.test(bk.title));
  assert.ok(/missing legal notice/.test(TEAM.legalInvoice(row({ exceptions: [{ matter: 'x', kind: 'missing_notice', reason: 'r' }] })).title));
  assert.ok(/^Approval required: \$4,?550/.test(TEAM.legalInvoice(row({ homeowner_cents: 455034 })).title.replace('4550.34', '4,550.34')));
  assert.ok(/Chargeback posting pending/.test(TEAM.legalInvoice(row({ homeowner_cents: 100, review_status: 'approved', postings: { pending: 1, posted: 0 } })).title));
  assert.ok(/Payment awaiting release.*chargebacks posted/.test(TEAM.legalInvoice(row({ homeowner_cents: 100, review_status: 'approved', postings: { pending: 0, posted: 2 } })).title));
  assert.ok(/Payment released, awaiting payment/.test(TEAM.legalInvoice(row({ released: true })).title));
  const done = TEAM.legalInvoice(row({ paid: true, ap_status: 'paid', review_status: 'approved', homeowner_cents: 100, postings: { pending: 0, posted: 2 } }));
  assert.strictEqual(done.action, 'clear'); assert.strictEqual(done.outcome, 'resolved');
  assert.strictEqual(TEAM.legalInvoice(row({ ap_status: 'voided' })).action, 'clear');
  assert.strictEqual(TEAM.legalInvoice(row({ read_only: 'Leaving Bedrock: view only.' })).action, 'clear');
});
t('activity: the same state hashes the same (no duplicate activity), a new stage hashes differently', () => {
  const { stateHash } = require('../lib/manager/subjects');
  const h = (c) => stateHash({ subject: c.basis, classification: { action: c.action, autonomy_class: c.autonomy_class || null, priority: c.priority || null, blocked_reason: c.blocked_reason || null }, due: null, status: 'open' });
  assert.strictEqual(h(TEAM.legalInvoice(row())), h(TEAM.legalInvoice(row())));
  assert.notStrictEqual(h(TEAM.legalInvoice(row())), h(TEAM.legalInvoice(row({ released: true }))));
});
t('manager: legal_invoice is a registered subject with its own loader; the sweep uses it', () => {
  const { KINDS, parseSubjectKey } = require('../lib/manager/subjects');
  assert.ok(KINDS.legal_invoice && typeof KINDS.legal_invoice.load === 'function' && typeof KINDS.legal_invoice.evaluate === 'function');
  assert.deepStrictEqual(parseSubjectKey('legal_invoice:abc'), { kind: 'legal_invoice', id: 'abc' });
  assert.ok(/if \(k\.load\) return k\.load\(supabase, id\);/.test(src('lib/manager/sweep.js')));
});

// ---- controls -------------------------------------------------------------------
t('the team never approves, posts, pays or sends', () => {
  for (const f of ['lib/legal/team.js', 'lib/legal/research.js', 'lib/legal/kat_verify.js']) {
    const s = src(f).replace(/\/\/.*$/gm, '');
    assert.ok(!/approveTreatment\s*\(|postJournalEntry|postHomeownerCharge|recordPayment|sendAs\s*\(|sendReplyAs|released_for_payment'\s*\}|legal_review_approve|legal_posting_claim/.test(s), f);
  }
});
t('intake hands only a loaded (non-duplicate) attorney invoice to the team, in the background', () => {
  const s = src('lib/ap/intake.js');
  assert.ok(/if \(!suspected\) \{[\s\S]{0,400}is_legal_counsel[\s\S]{0,300}triggerFromIntake\(supabase, data\.id\)/.test(s));
  assert.ok(/setImmediate\(/.test(src('lib/legal/team.js')), 'never delays the bill load');
});

(async () => {
  for (const [n, f] of pending) {
    try { await f(); pass++; console.log('  ok   ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n        ' + e.message); }
  }
  console.log(`\n${pass} passed${fail ? ', FAILURES above' : ''}`);
  if (fail) process.exit(1);
})();
