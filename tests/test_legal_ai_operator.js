// ============================================================================
// tests/test_legal_ai_operator.js  (Ed 2026-10-11)
// ----------------------------------------------------------------------------
// Amanda prepares, Kat verifies, the owner approves. Regression cases from the
// real failures on Canyon Gate D&F invoices #278002 (15 exceptions) and
// #278001 (1 exception), including the $32 Adeyinka item:
//   - every #278002 exception had one trigger: the line text ("Owner - Address
//     - Fees") does not say collections vs DRV, and nothing else was consulted
//   - Amanda's research knew the work type but dropped it unless the charge was
//     already proven recoverable, and never read the originals retained in trustEd
//   - Sterling's collection letters say "restrictive covenants", so the notice
//     reader called them DRV notices
//   - #278001's "Prepare deed restriction status report" (no owner) was refused
//     association treatment because it mentions deed restrictions
// Pins: routine classification completes from evidence; genuine holds stay
// visible with specific reasons; amounts reconcile to the cent; nothing posts.
// ============================================================================
const assert = require('assert');
const RS = require('../lib/legal/research');
const S = require('../lib/legal/review_suggest');
const TEAM = require('../lib/legal/team');
const KV = require('../lib/legal/kat_verify');

let pass = 0, fail = 0;
const pending = [];
const t = (n, f) => pending.push([n, f]);

function fakeDb(tables) {
  return {
    from(table) {
      const f = [];
      const q = {
        select() { return q; }, eq(k, v) { f.push((r) => r[k] === v); return q; }, in(k, vs) { f.push((r) => vs.includes(r[k])); return q; },
        neq(k, v) { f.push((r) => r[k] !== v); return q; }, order() { return q; }, limit() { return q; },
        ilike(k, pat) { const re = new RegExp('^' + String(pat).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i'); f.push((r) => re.test(String(r[k] || ''))); return q; },
        maybeSingle() { return Promise.resolve({ data: (tables[table] || []).filter((r) => f.every((x) => x(r)))[0] || null, error: null }); },
        then(res, rej) { return Promise.resolve({ data: (tables[table] || []).filter((r) => f.every((x) => x(r))), error: null }).then(res, rej); },
      };
      return q;
    },
  };
}

// ---- texts modelled on the real retained originals ----------------------------
const STERLING_BATCH = [
  'Canyon Gate at Cinco Ranch Owners Association, Inc. 20422 Canyon Gate Blvd Katy, TX 77450 281-492-6020 3/25/2025 4:43:29 PM Latrice Adeyinka 6211 Piedra Negras Court Certified Mail # _______________________ Katy, TX 77450 Return Receipt Requested and Copy by Regular Mail --FINAL DELINQUENCY WARNING-- 6211 Piedra Negras Court RE: Dear Latrice Adeyinka: According to our records, you are delinquent in the payment of the Assessments owed to Canyon Gate at Cinco Ranch Owners Association, Inc. The total due is $1,212.40. This letter serves as the FINAL DELIQUENCY NOTICE regarding your failure to pay your annual/monthly maintenance charge(s) and/or other charges authorized by the restrictive covenants of Canyon Gate at Cinco Ranch Owners Association, Inc. and/or state law. This letter is to request that you pay the total amount due no later than forty-five (45) days from the date of this letter. You may choose to enter into a written and signed payment plan agreement. You may also request a hearing before the Board. You will be responsible for all attorney fees and costs incurred by the Association in collecting the total amount due.',
  'Canyon Gate at Cinco Ranch Owners Association, Inc. 20422 Canyon Gate Blvd Katy, TX 77450 3/25/2025 4:43:31 PM Guillermo & Rosita Chapellin 6210 Jacob Canyon Drive Certified Mail # _______________________ --FINAL DELINQUENCY WARNING-- RE: Dear Guillermo & Rosita Chapellin: you are delinquent in the payment of the Assessments ... restrictive covenants ... no later than forty-five (45) days ... payment plan ... hearing ... you will be responsible for all attorney fees and costs.',
].join(' ');
const DF_JULY = 'COLLECTION STATUS REPORT BANKRUPTCY BATISTE, REMICA – 6306 Clear Canyon Dr. 2705.0013 04/13/26 the homeowner had filed bankruptcy on November 4, 2025. The bankruptcy remains pending.';
const DF_AUG = 'COLLECTION STATUS REPORT ADEYINKA, LATRICE J. – 6211 Piedra Negras Ct. 2705.0007 10/14/25 Received request to send initial demand letter on September 24, 2025. Mailed initial demand letter on September 29, 2025. Balance Due: $2,871.56. 11/12/25 the owner asked for a payment plan. ' +
  'BATISTE, REMICA – 6306 Clear Canyon Dr. 2705.0013 10/14/25 Mailed initial demand letter on September 29, 2025. 04/13/26 the homeowner had filed bankruptcy on November 4, 2025. 08/12/26 The Bankruptcy case was dismissed on June 17, 2026. ' +
  'COOKS, RAYFORD – 6206 Marina Canyon Way 2705.0019 10/14/25 Received request to send initial demand letter on September 19, 2025. Mailed initial demand letter on September 24, 2025.';
const retained = (docs) => async () => docs.map((d) => Object.assign({ text: async () => d.body }, d));
const DOCS = [
  { id: 'r-jul', title: 'Collection Status Report - July 2026', kinds: ['attorney_status_report'], doc_date: '2026-07-14', body: DF_JULY },
  { id: 'r-aug', title: 'Collection Status Report - August 2026', kinds: ['attorney_status_report'], doc_date: '2026-08-13', body: DF_AUG },
  { id: 'n-batch', title: 'Sterling Final Delinquency Warning batch 3/25/2025', kinds: ['section_209_0064_notice_batch'], doc_date: '2025-03-25', body: STERLING_BATCH },
];
const SOURCES = { graphConfigured: () => false, retainedEvidence: retained(DOCS) };   // email / OneDrive off: retained originals only
const ownerDb = (pid, extra) => fakeDb(Object.assign({
  ownership_tenures: [{ id: 'ten-' + pid, property_id: pid, kind: 'owner', start_date: '2026-05-19', end_date: null }],   // the import date, not a transfer
  ar_account_collections: [], violations: [], sent_letter_archive: [], homeowner_transactions: [],
}, extra || {}));
const research = (pid, address, opts) => RS.researchAllocation(ownerDb(pid, opts && opts.tables), { invoiceNumber: '278002', communityId: 'cg', props: new Map([[pid, { id: pid, street_address: address }]]), owners: new Map() },
  { item: { id: 'it-' + pid, matter_ref: null }, alloc: { id: 'al-' + pid, property_id: pid, tenure_id: 'ten-' + pid, classification: 'needs_review', charge_category: null, amount_cents: 3200 } }, Object.assign({}, SOURCES, (opts && opts.sources) || {}), { reports: new Map() });

// ---- the readers ---------------------------------------------------------------
t('a Sterling delinquency letter that mentions "restrictive covenants" is a §209.0064 notice, not a DRV notice', () => {
  const r = RS.readNoticeText(STERLING_BATCH.slice(0, 1400), { address: '6211 Piedra Negras Court', surname: null });
  assert.strictEqual(r.kind, 'collection_209_0064');
  assert.strictEqual(r.certified_line_blank, true); assert.strictEqual(r.certified_number, null);
});
t('a status report records Bedrock\'s referral date and counsel\'s initial demand', () => {
  const r = RS.readStatusPassage(RS.windowAround(DF_AUG, ['6211 Piedra Negras']));
  assert.strictEqual(r.work_type, 'collection'); assert.strictEqual(r.referral_requested, 'September 24, 2025'); assert.strictEqual(r.initial_demand, 'September 29, 2025');
});

// ---- the $32 Adeyinka item (#278002 item 1) -----------------------------------
t('Adeyinka $32: before, the line text alone left the work type blank (an exception)', () => {
  const ix = S.buildIndex({ properties: [{ id: 'p-ad', street_address: '6211 Piedra Negras Court', normalized_address: '6211 piedra negras court' }], tenures: [{ id: 'ten-p-ad', property_id: 'p-ad', kind: 'owner', start_date: '2026-05-19', end_date: null }], owners: [{ property_id: 'p-ad', tenure_id: 'ten-p-ad', name: 'Latrice Jackson Adeyinka' }] });
  const text = 'Adeyinka, Latrice Jackson - 6211 Piedra Negras Ct. - Fees';
  const a = S.assess(ix, S.matchProperty(ix, S.extractEvidence(text)), S.extractEvidence(text), S.classifyText(text), null, '2026-07-31');
  assert.strictEqual(a.classification, 'needs_review');
  assert.ok(a.review_reasons.some((r) => /work type .* not clear/.test(r)), a.review_reasons.join('; '));
});
t('Adeyinka $32: after, Amanda establishes collections from the retained status report and finds the notice in the retained Sterling batch: READY with the mailing limitation', async () => {
  const f = await research('p-ad', '6211 Piedra Negras Court');
  assert.strictEqual(f.outcome, 'ready', f.reason + ' | ' + f.missing.join('; '));
  assert.strictEqual(f.classification, 'homeowner_recoverable'); assert.strictEqual(f.charge_category, 'attorney_fee');
  assert.strictEqual(f.work_type, 'collection'); assert.ok(/Status Report/.test(f.work_type_source), 'the work type names its source, never account 5870');
  assert.ok(f.evidence.content.length === 1 && f.evidence.mailing.length === 0, 'content on file; no mailing evidence invented');
  assert.ok(f.limitations.some((l) => /proof of mailing .* not verified .*certified-mail line on the letter is blank.*Bedrock's referral/.test(l)));
  assert.ok(f.evidence.indirect.some((e) => /Bedrock referral to counsel requested September 24, 2025/.test(e.fact)), 'the referral is recorded as indirect support');
  assert.ok(!f.missing.length, 'nothing is missing');
});
t('the import-generated 5/19/2026 ownership date is never an ownership problem', async () => {
  const f = await research('p-ad', '6211 Piedra Negras Court');
  assert.strictEqual(f.signals.owner_current, true);
  assert.ok(!/owner/i.test(f.reason));
});
t('a neighbour on the same street is never this owner\'s evidence (house number required)', async () => {
  const f = await research('p-nb', '6223 Piedra Negras Court');
  assert.strictEqual(f.evidence.content.length, 0);
  assert.notStrictEqual(f.outcome, 'ready');
});

// ---- genuine holds stay visible, with their own reasons ------------------------
t('Batiste: the later (August) report wins over July: bankruptcy DISMISSED is a decision about recoverability, never "active" and never a silent charge', async () => {
  const f = await research('p-ba', '6306 Clear Canyon Dr.');
  assert.strictEqual(f.signals.bankruptcy.status, 'dismissed');
  assert.strictEqual(f.outcome, 'needs_decision'); assert.strictEqual(f.classification, 'needs_review');
  assert.ok(/bankruptcy dismissed/.test(f.reason));
});
t('active bankruptcy is a hold (needs decision), never recoverable even with the notice on file', () => {
  const r = RS.recommend({ signals: { owner_current: true, work_type: 'collection', collection_notice_content: true, bankruptcy: { status: 'active', source: 'r' } }, verified: [], references: [], missing: [], unavailable: [] }, {});
  assert.strictEqual(r.outcome, 'needs_decision'); assert.strictEqual(r.recommendation, 'hold'); assert.strictEqual(r.classification, 'needs_review');
});
t('a payoff that may already cover the fees is a decision (Glen Canyon)', () => {
  const r = RS.recommend({ signals: { owner_current: true, work_type: 'collection', collection_notice_content: true, payoff: { good_through: 'August 31', amount: '15,086.54' } }, verified: [], references: [], missing: [], unavailable: [] }, {});
  assert.strictEqual(r.outcome, 'needs_decision'); assert.ok(/payoff/.test(r.reason));
});
t('notice copy absent but counsel proceeded on Bedrock\'s referral: a decision to accept the referral record, never recoverable on its own', async () => {
  const f = await research('p-co', '6206 Marina Canyon Way');   // in the August report, no letter in the batch
  assert.strictEqual(f.outcome, 'needs_decision'); assert.strictEqual(f.classification, 'needs_review');
  assert.ok(/copy not on file; counsel proceeded on Bedrock's referral \(September 19, 2025\)/.test(f.reason));
  assert.ok(f.judgment.some((j) => /accept Bedrock's referral record/.test(j)));
});
t('no evidence of the work type: needs information, never a default to collections', () => {
  const r = RS.recommend({ signals: { owner_current: true }, verified: [], references: [], missing: [], unavailable: [] }, { charge_category: null });
  assert.strictEqual(r.outcome, 'needs_information'); assert.strictEqual(r.work_type, null); assert.strictEqual(r.charge_category, null);
});

// ---- #278001: the attorney's status report for the association ------------------
t('#278001 "Prepare deed restriction status report." (no owner) is association general legal, not "no property named"', () => {
  const cls = S.classifyText('Prepare deed restriction status report.');
  assert.strictEqual(cls.association, true);
  const ix = S.buildIndex({ properties: [], tenures: [], owners: [] });
  const ev = S.extractEvidence('Prepare deed restriction status report.');
  const a = S.assess(ix, S.matchProperty(ix, ev), ev, cls, null, '2026-07-31');
  assert.strictEqual(a.classification, 'association_legal_expense');
  assert.strictEqual(S.triageItem({ amount_cents: 2400, allocations: [Object.assign({ amount_cents: 2400 }, a)] }).status, 'accepted');
});

// ---- three states replace the bare exception count -------------------------------
t('decision states: Amanda\'s reason is shown; generic reasons map to information vs decision; totals reconcile to the cent', () => {
  const ready = { amount_cents: 3200, allocations: [{ amount_cents: 3200, classification: 'homeowner_recoverable', property_id: 'p', tenure_match: 'current', charge_category: 'attorney_fee', confidence: 'high', suggested: true, evidence: [], note: 'Amanda (AI): READY FOR APPROVAL - §209.0064 pre-referral delinquency notice on file. Work type: collections (report). Limitation: Independent proof of mailing is not verified. Verified: x.' }] };
  const decide = { amount_cents: 33300, allocations: [{ amount_cents: 33300, classification: 'needs_review', property_id: 'p2', evidence: [], note: 'Amanda (AI): NEEDS DECISION - bankruptcy dismissed (report): whether these fees are recoverable after the case. Decision: x.' }] };
  const info = { amount_cents: 500, allocations: [{ amount_cents: 500, classification: 'needs_review', property_id: null, review_reasons: ['no property or account named on this line; check the invoice PDF for the matter'], evidence: [] }] };
  assert.deepStrictEqual(S.decisionOf(ready), { state: 'ready', reason: null, limitation: 'Independent proof of mailing is not verified.' });
  const d2 = S.decisionOf(decide); assert.strictEqual(d2.state, 'needs_decision'); assert.ok(/^bankruptcy dismissed/.test(d2.reason));
  assert.strictEqual(S.triageItem(decide).reasons[0], d2.reason, 'the triage shows Amanda\'s reason, not "needs a decision: homeowner or association"');
  assert.strictEqual(S.decisionOf(info).state, 'needs_information');
  const sum = S.summarize(37000, [ready, decide, info]);
  assert.strictEqual(sum.reconciled, true); assert.strictEqual(sum.difference_cents, 0);
  assert.deepStrictEqual([sum.decisions.ready.cents, sum.decisions.needs_decision.cents, sum.decisions.needs_information.cents], [3200, 33300, 500]);
  assert.strictEqual(sum.recoverable.cents, 3200);
});
t('Amanda\'s note leads with her outcome and states the limitation; the draft change is a classification, not a posting', () => {
  const f = { allocation_id: 'a1', outcome: 'ready', outcome_label: 'READY FOR APPROVAL', recommendation: 'recoverable', classification: 'homeowner_recoverable', charge_category: 'attorney_fee', reason: '§209.0064 pre-referral delinquency notice on file', work_type: 'collection', work_type_source: 'Collection Status Report - August 2026', limitations: ['Independent proof of mailing of the notice is not verified.'], judgment: [], missing: [], verified: [{ source: 's', fact: 'f' }], evidence_grade: 'verified' };
  const note = TEAM.amandaNote(f);
  assert.ok(/^Amanda \(AI\): READY FOR APPROVAL - §209\.0064 .* on file\. Work type: collections \(Collection Status Report - August 2026\)\. Limitation: Independent proof/.test(note), note);
  const d = { saved: { items: [{ source_line_ids: ['l1'], matter_ref: null, allocations: [{ id: 'a1', amount_cents: 3200, classification: 'needs_review', property_id: 'p', charge_category: null, evidence: [] }] }] } };
  const out = TEAM.applyRecommendations(d, [f]);
  assert.strictEqual(out.items[0].allocations[0].classification, 'homeowner_recoverable');
  assert.strictEqual(out.items[0].allocations[0].amount_cents, 3200, 'amounts never change');
});

// ---- Kat checks the accounting herself -------------------------------------------
t('Kat: reconciles every line (open ones too), checks the accrual coding, flags a pre-cutover invoice whose owners carry legal fees in the opening balance, and previews one owner charge per property and category', async () => {
  const db = fakeDb({
    journal_entry_lines: [
      { journal_entry_id: 'je1', debit_cents: 3200, credit_cents: 0, chart_of_accounts: { account_number: '5870', account_name: 'Legal Fees - Collections/DRV' } },
      { journal_entry_id: 'je1', debit_cents: 33300, credit_cents: 0, chart_of_accounts: { account_number: '5870', account_name: 'Legal Fees - Collections/DRV' } },
      { journal_entry_id: 'je1', debit_cents: 0, credit_cents: 36500, chart_of_accounts: { account_number: '2000', account_name: 'Accounts Payable' } }],
    communities: [{ id: 'cg', gl_cutover_date: '2026-08-01' }],
    homeowner_transactions: [{ property_id: 'p', description: 'Opening balance 2026-07-31 (Legal Fees - Collections/DRV)', charge_category: 'attorney_fee' }],
  });
  const items = [
    { amount_cents: 3200, allocations: [{ amount_cents: 3200, classification: 'homeowner_recoverable', property_id: 'p', tenure_match: 'current', charge_category: 'attorney_fee', confidence: 'high', suggested: true, evidence: [], note: 'Amanda (AI): READY FOR APPROVAL - notice on file. Limitation: Independent proof of mailing is not verified.' }] },
    { amount_cents: 33300, allocations: [{ amount_cents: 33300, classification: 'needs_review', property_id: 'p2', evidence: [], note: 'Amanda (AI): NEEDS DECISION - bankruptcy dismissed (r): whether recoverable.' }] }];
  const d = { invoiceNumber: '278002', invoice: { id: 'inv', community_id: 'cg', invoice_number: '278002', invoice_date: '2026-07-31', total_cents: 36500 }, saved: { review: { revision: 1 }, items } };
  const plan = { ready: false, blocking: ['Item 2: bankruptcy dismissed (r): whether recoverable'], accrual: { id: 'je1' }, postings: [], totals: { homeowner_cents: 3200, association_cents: 0, bedrock_cents: 0 }, invoice_total_cents: 36500 };
  const verify = { verified: false, checks: [{ name: 'allocations reconcile to the invoice total', ok: false, detail: '3200 of 36500 cents' }] };
  const k = await KV.katDecision(db, d, plan, verify);
  assert.ok(k.checks.some((c) => /every invoice line allocated, to the cent/.test(c.name) && c.ok), 'open lines are counted: no false "does not reconcile"');
  assert.ok(k.checks.some((c) => /coded to a legal-expense account/.test(c.name) && c.ok));
  assert.ok(k.checks.some((c) => /AP credited once/.test(c.name) && c.ok));
  assert.ok(k.issues.some((i) => i.state === 'needs_information' && /Vantaca owner history/.test(i.text)), 'the conversion overlap is a specific information item');
  assert.strictEqual(k.state, 'needs_decision');
  assert.ok(k.accounting_ok);
  assert.deepStrictEqual(k.charges.map((c) => [c.description, c.amount_cents]), [['Legal Fees - Collections / 278002', 3200]]);
  assert.ok(k.charges[0].limitation);
});
t('Kat: an invoice line coded outside legal expense is an accounting decision', async () => {
  const db = fakeDb({ journal_entry_lines: [
    { journal_entry_id: 'je2', debit_cents: 1000, credit_cents: 0, chart_of_accounts: { account_number: '5797', account_name: 'Deed Restriction Mowing' } },
    { journal_entry_id: 'je2', debit_cents: 0, credit_cents: 1000, chart_of_accounts: { account_number: '2000', account_name: 'Accounts Payable' } }], communities: [{ id: 'c', gl_cutover_date: null }], homeowner_transactions: [] });
  const d = { invoice: { id: 'i', community_id: 'c', invoice_number: 'X', invoice_date: '2026-09-30', total_cents: 1000 }, saved: { review: { revision: 1 }, items: [{ amount_cents: 1000, allocations: [{ amount_cents: 1000, classification: 'association_legal_expense', evidence: [{ kind: 'work_type', value: 'supported by the line text' }] }] }] } };
  const k = await KV.katDecision(db, d, { ready: true, blocking: [], accrual: { id: 'je2' }, postings: [], totals: { homeowner_cents: 0, association_cents: 1000, bedrock_cents: 0 } }, { verified: true, checks: [] });
  assert.strictEqual(k.state, 'needs_decision'); assert.ok(k.issues.some((i) => /non-legal accounts \(5797 Deed Restriction Mowing\)/.test(i.text)));
});

// ---- AI preparation is not authorization ---------------------------------------
t('nothing in the operator path posts, approves or pays', () => {
  const fs = require('fs'); const path = require('path');
  for (const f of ['lib/legal/research.js', 'lib/legal/kat_verify.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/approveTreatment|postClaim|postHomeownerCharge|recordPayment|released_for_payment|\.insert\(|\.update\(/.test(src), `${f} must stay read-only`);
  }
});

(async () => {
  for (const [name, fn] of pending) {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n        ' + (e && e.message)); }
  }
  console.log(`\n${pass} passed${fail ? ', FAILURES above' : ''}`);
  if (fail) process.exit(1);
})();
