#!/usr/bin/env node
// Amanda + the RFP / Bid Workflow (Ed 2026-10-16): proposal and competing-bid matters run through the
// workflow record, and financial figures carry their reliability (transition-state data confidence).
// Regression case: Canyon Gate's camera proposals (fixture transcribed from the real documents).
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const DC = require('../lib/accounting/data_confidence');
const D = require('../lib/amanda/decision_ready');
const C = require('../lib/vendors/proposal_comparison');
const W = require('../lib/vendors/rfp_workflow');
const DRY = require('../scripts/amanda_rfp_dry_run');
const fx = require('./fixtures/rfp-comparison/canyon-gate-cameras-2026-10.json');

let passed = 0; let failed = 0;
const t = async (name, fn) => { try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message); } };
const near = (a, b, tol, what) => assert.ok(Math.abs(Number(a) - Number(b)) <= tol, `${what}: ${a} vs expected ${b} (tolerance ${tol})`);
const env = (vars, fn) => { const old = {}; for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; } try { return fn(); } finally { for (const k of Object.keys(old)) { if (old[k] == null) delete process.env[k]; else process.env[k] = old[k]; } } };

(async () => {
  console.log('Data confidence (transition-state control)');

  await t('mode is configurable: env, per-community override, unknown values fall back to transition', async () => {
    env({ DATA_CONFIDENCE_MODE: null, DATA_CONFIDENCE_OVERRIDES: null }, () => assert.strictEqual(DC.confidenceMode('x'), 'transition'));
    env({ DATA_CONFIDENCE_MODE: 'strict' }, () => assert.strictEqual(DC.confidenceMode('x'), 'strict'));
    env({ DATA_CONFIDENCE_MODE: 'transition', DATA_CONFIDENCE_OVERRIDES: '{"cg":"off"}' }, () => { assert.strictEqual(DC.confidenceMode('cg'), 'off'); assert.strictEqual(DC.confidenceMode('wv'), 'transition'); });
    env({ DATA_CONFIDENCE_MODE: 'bogus', DATA_CONFIDENCE_OVERRIDES: 'not json' }, () => assert.strictEqual(DC.confidenceMode('x'), 'transition'));
  });

  await t('labels: verified needs reconciliation through the latest month AND a closed month', async () => {
    const ba = [{ id: 'b1', gl_account_number: '1000', account_nickname: 'Operating', account_last4: '5313' }];
    const today = '2026-10-16';
    const ok = DC.assessBooks({ today, bankAccounts: ba, reconciliations: [{ bank_account_id: 'b1', period_end: '2026-09-30', status: 'reconciled' }], periods: [{ period_end: '2026-09-30', status: 'closed' }] });
    assert.strictEqual(DC.labelAccount(ok, '1000').label, 'verified');
    const notClosed = DC.assessBooks({ today, bankAccounts: ba, reconciliations: [{ bank_account_id: 'b1', period_end: '2026-09-30', status: 'reconciled' }], periods: [] });
    assert.strictEqual(DC.labelAccount(notClosed, '1000').label, 'provisional');
    const behind = DC.assessBooks({ today, bankAccounts: ba, reconciliations: [{ bank_account_id: 'b1', period_end: '2026-07-31', status: 'reconciled' }], periods: [] });
    assert.match(DC.labelAccount(behind, '1000').reason, /reconciled only through 2026-07-31/);
    const stale = DC.assessBooks({ today, bankAccounts: ba, reconciliations: [{ bank_account_id: 'b1', period_end: '2026-03-31', status: 'reconciled' }], periods: [] });
    assert.strictEqual(DC.labelAccount(stale, '1000').label, 'stale');
    assert.strictEqual(DC.labelAccount(ok, '1201').label, 'incomplete', 'a GL account with no bank link cannot be reconciled in trustEd');
    const down = DC.assessBooks({ today, errors: { recs: true } });
    assert.strictEqual(DC.labelAccount(down, '1000').label, 'unavailable');
    assert.strictEqual(DC.worst(['verified', 'provisional', 'stale']), 'stale');
  });

  await t('certainty check: flags "funds are available" on provisional balances, allows a hedged statement in transition', async () => {
    const s = ['The funds are available in the Reserve.', 'This can be funded now from operating.', 'There is sufficient cash to cover it.', 'Reserve shows $948,452.23 (provisional until the reconciliations are complete), so I recommend funding it from Reserve.'];
    const tr = DC.certaintyIssues(s, { mode: 'transition', cashLabel: 'provisional' }).map((i) => i.text);
    assert.deepStrictEqual(tr, s.slice(0, 3));
    assert.strictEqual(DC.certaintyIssues(['Funds are available, subject to the September reconciliation.'], { mode: 'strict', cashLabel: 'provisional' }).length, 1, 'strict: a hedge does not excuse an availability conclusion');
    assert.strictEqual(DC.certaintyIssues(s, { mode: 'off', cashLabel: 'provisional' }).length, 0);
    assert.strictEqual(DC.certaintyIssues(s, { mode: 'transition', cashLabel: 'verified' }).length, 0);
  });

  await t('checkDecisionReady flags overstated certainty only when confidence is passed, and the retry names it', async () => {
    const draft = 'Recommendation: approve iTech. Why: Canyon Gate has $948,452.23 in Reserve, so funds are definitively available.';
    assert.deepStrictEqual(D.checkDecisionReady(draft).issues, [], 'backward compatible without confidence');
    const r = D.checkDecisionReady(draft, { confidence: { mode: 'transition', cash_label: 'provisional' } });
    assert.ok(r.issues.some((i) => i.code === 'overstated_certainty'));
    assert.match(D.retryNote(r.issues), /provisional/);
  });

  const fakeDb = DRY.fakeDb;
  await t('board facts label every Canyon Gate cash figure provisional (operating 5313/3170 and Edward Jones unreconciled, no month closed)', async () => {
    const f = await D.boardDecisionFactsDetailed(fakeDb(fx.db_seed), fx.community.id, '', { today: fx.today, mode: 'transition' });
    for (const [fund, label] of Object.entries(fx.expected.cash_labels)) assert.strictEqual((f.funds.find((x) => x.fund === fund) || {}).label, label, fund);
    assert.strictEqual(f.cash_label, 'provisional');
    assert.match(f.funds.find((x) => x.fund === 'Reserve').reason, /Edward Jones/, 'the limitation names the account that matters most (largest balance)');
    assert.match(f.text, /1201 Reserve - Edward Jones \$947,447\.06 \[provisional: Edward Jones 0409: no completed reconciliation on file\]/);
    assert.match(f.text, /DATA CONFIDENCE \(transition\)/); assert.match(f.text, /never write that funds are definitively available/);
    assert.strictEqual(f.budget.label, 'provisional'); assert.strictEqual(f.payables.label, 'provisional');
    const off = await D.boardDecisionFactsDetailed(fakeDb(fx.db_seed), fx.community.id, '', { today: fx.today, mode: 'off' });
    assert.ok(!/\[provisional/.test(off.text) && !/DATA CONFIDENCE/.test(off.text), 'mode off: no labels, no guidance');
  });

  console.log('\nRFP / Bid Workflow comparison (Canyon Gate cameras)');
  const req = C.boardRequirements(fx.board_email.body);
  const facts = await D.boardDecisionFactsDetailed(fakeDb(fx.db_seed), fx.community.id, '', { today: fx.today, mode: 'transition' });
  const record = C.buildComparisonRecord({ community: fx.community, project: fx.project, proposals: fx.proposals, requirements: req, facts, today: fx.today });
  const byKey = Object.fromEntries(record.proposals.map((n) => [n.key, n]));

  await t('detects the comparison matter from the board email, and not from an ordinary message', async () => {
    assert.strictEqual(C.detectComparisonMatter({ subject: fx.board_email.subject, body: fx.board_email.body, attachments: fx.board_email.attachments }).is_matter, fx.expected.detect);
    assert.strictEqual(C.detectComparisonMatter({ subject: 'Pool hours', body: 'When does the pool close for the season?', attachments: [] }).is_matter, false);
    assert.strictEqual(C.detectComparisonMatter({ subject: 'Invoice', body: 'Attached is our invoice.', attachments: [{ name: 'invoice_2231.pdf' }] }).is_matter, false);
    assert.strictEqual(C.detectComparisonMatter({ subject: 'New quote', body: 'Here is our updated quote for the fence.', attachments: [{ name: 'Fence Quote.pdf' }], existingProposals: [{ id: 'p1' }] }).is_matter, true, 'one proposal plus one on file');
  });

  await t("reads the Board's requirements from its own words (own the hardware, cloud access, no monitoring)", async () => {
    for (const [k, v] of Object.entries(fx.expected.requirements)) assert.strictEqual(req[k], v, k);
  });

  await t('classifies each proposal: 2026 iTech current, 2024 iTech historical, Envera expired, copies duplicate', async () => {
    for (const [k, s] of Object.entries(fx.expected.status)) assert.strictEqual(byKey[k].status, s, `${k}: ${byKey[k].status} (${byKey[k].status_reason})`);
    assert.strictEqual(byKey['envera-q19538-2-packet'].approvable, false, 'an expired quote is not approvable');
    assert.strictEqual(byKey['netwatch-2026'].approvable, false, 'an unpriced proposal is not approvable');
  });

  await t('a lower revision of the same quote is superseded (version lineage)', async () => {
    const base = { vendor_name: 'Gate Co', document: { filename: 'a.pdf' }, pricing: { upfront_cents: 100000 } };
    const out = C.classifyProposals([{ ...base, key: 'r1', quote_number: 'Q-55-1', document_date: '2026-05-01', document: { filename: 'r1.pdf' } }, { ...base, key: 'r2', quote_number: 'Q-55-2', document_date: '2026-06-01', document: { filename: 'r2.pdf' }, pricing: { upfront_cents: 120000 } }], { today: '2026-06-15' });
    assert.deepStrictEqual(out.map((p) => p.status), ['superseded', 'current']);
  });

  await t('normalized costs match the documents within tolerance (tax, plan, 60-month TCO, minimum commitment)', async () => {
    for (const [k, exp] of Object.entries(fx.expected.costs)) for (const [field, v] of Object.entries(exp)) { if (typeof v === 'number') near(byKey[k][field], v, fx.expected.tolerance_cents, `${k}.${field}`); else assert.strictEqual(byKey[k][field], v, `${k}.${field}`); }
    const plan = byKey['itech-2026-a'].recurring[0];
    assert.strictEqual(plan.counted, false, 'the optional monitoring plan is not in the recommended configuration');
    assert.strictEqual(plan.conditional_addon, true, 'shown as a conditional add-on');
    assert.match(plan.counted_reason, /bundles monitoring the Board does not want.*unless the vendor confirms it is required for cloud access/);
    // Generalized: once the vendor confirms the plan is required for the wanted access, it is counted in the base.
    const confirmed = { ...fx.proposals.find((p) => p.key === 'itech-2026-a'), key: 'confirmed' };
    confirmed.pricing = { ...confirmed.pricing, recurring: [{ ...confirmed.pricing.recurring[0], vendor_confirmed_required: true }] };
    const nc = C.normalizeProposal({ ...confirmed, status: 'current' }, { requirements: req });
    assert.strictEqual(nc.recurring[0].counted, true); assert.strictEqual(nc.tco_cents, 7425468); assert.strictEqual(nc.addon_monthly_cents, 0);
    assert.strictEqual(byKey['itech-2026-a'].ownership, 'association');
    for (const f of ['scope', 'upfront_cents', 'recurring', 'contract_term_months', 'tco_cents', 'ownership', 'monitoring', 'warranty', 'insurance', 'exclusions', 'assumptions', 'implementation_timing', 'change_order_exposure', 'other_terms']) assert.ok(f in byKey['itech-2026-a'], `normalized structure has ${f}`);
  });

  await t('ranks only viable alternatives and recommends the current iTech proposal, funded from Reserve at provisional confidence', async () => {
    assert.strictEqual(record.ranking.recommended_key, fx.expected.recommended_key);
    assert.deepStrictEqual(record.ranking.not_viable.map((x) => x.key).sort(), [...fx.expected.not_viable].sort());
    assert.ok(record.ranking.not_viable.find((x) => x.key === 'envera-q19538-2-packet').reasons.some((r) => /expired/.test(r)));
    assert.strictEqual(record.ranking.funding.source, 'reserve'); assert.strictEqual(record.ranking.funding.label, 'provisional');
  });

  await t('open items: retention, cloud access cost, warranty, change-order control and schedule are routine diligence, queued and never sent', async () => {
    const topics = record.open_items.filter((i) => i.proposal_key === fx.expected.recommended_key && i.material).map((i) => i.topic);
    assert.deepStrictEqual(topics, fx.expected.open_item_topics_for_recommended);
    assert.ok(record.open_items.every((i) => i.status === 'queued_not_sent' && i.kind === 'routine_diligence'));
    assert.ok(!record.open_items.some((i) => /Envera|Netwatch/.test(i.vendor)), 'no diligence chased for options the Board excluded');
  });

  await t('the stored record carries an audit trail of what was associated, classified and why', async () => {
    const acts = record.audit.map((a) => a.action);
    for (const a of ['associate', 'classify', 'analyze', 'request_queued']) assert.ok(acts.includes(a), a);
    assert.ok(record.audit.some((a) => a.action === 'classify' && /expired 2026-08-31/.test(a.note)));
    assert.strictEqual(record.workflow.path, 'C');
  });

  await t('a proposal with missing fields is KEPT (repaired to explicit unknowns, with review notes), never dropped', async () => {
    const bad = { key: 'bad', vendor_name: '', document: { filename: 'x.pdf' }, pricing: {}, document_date: 'Aug 19' };
    const r = C.buildComparisonRecord({ community: fx.community, project: fx.project, proposals: [...fx.proposals, bad], requirements: req, facts, today: fx.today });
    const n = r.proposals.find((x) => x.key === 'bad');
    assert.ok(n, 'kept in the comparison'); assert.strictEqual(n.vendor_name, 'Unidentified vendor'); assert.strictEqual(n.unpriced, true);
    assert.ok(r.audit.some((a) => a.proposal_key === 'bad' && /Kept in the comparison with review notes: vendor name missing.*no price found: treated as unpriced.*document_date "Aug 19" unreadable/.test(a.note)));
    assert.strictEqual(r.proposals.length, fx.proposals.length + 1);
  });

  const summary = C.renderBoardSummary(record, { greetingName: 'Hugh', link: 'https://my.bedrocktxai.com/?tab=vendor&rfp=00000000-0000-0000-0000-000000000000' });
  await t('the Board email is a short decision-ready summary that links to the comparison and passes every check', async () => {
    for (const label of ['Situation:', 'Recommendation:', 'Why:', 'Open items before signing:', 'Action underway:', 'Board decision needed:']) assert.ok(summary.includes(label), label);
    assert.match(summary, /\$47,854\.68/); assert.match(summary, /Base installed cost is approximately \$47,854\.68 including estimated tax\./); assert.match(summary, /expired/); assert.match(summary, /rfp=/);
    assert.match(summary, /provisional/, 'the material limitation is stated once');
    assert.strictEqual((summary.match(/provisional/g) || []).length, 1, 'no repetitive disclaimers');
    assert.ok(!/which (?:proposal|one) is current|would you like me to|let me know how|shall I compare|I will check/i.test(summary));
    assert.ok(!/funds are (?:definitively )?available|fully funded/i.test(summary));
    assert.deepStrictEqual(D.checkDecisionReady(summary, { confidence: { mode: 'transition', cash_label: 'provisional' } }), { ok: true, issues: [] });
    // Ed's required wording (base vs optional plan, the Reserve-funding paragraph, six conclusions) sets the floor.
    assert.ok(summary.split(/\s+/).length < 560, `summary is concise (${summary.split(/\s+/).length} words)`);
  });

  console.log('\nMulti-lens risk and completeness review');
  const rv = record.review.by_proposal[fx.expected.recommended_key];
  await t('stores every section: strengths, weaknesses/risks, missing documents, conditions, counsel review, context used', async () => {
    for (const k of ['strengths', 'weaknesses_risks', 'missing_documents', 'required_conditions', 'counsel_review', 'community_context_used']) assert.ok(Array.isArray(rv[k]), k);
    for (const lens of ['operational', 'financial', 'contract', 'risk']) assert.ok(rv.weaknesses_risks.some((x) => x.lens === lens), `a ${lens} finding`);
    assert.ok(rv.weaknesses_risks.length >= 8, 'the recommended vendor\'s weaknesses are not hidden');
  });

  await t("recognizes, from iTech's proposal: budgetary, faults/change orders, retention, cloud-access cost, warranty, installation timing", async () => {
    const text = rv.weaknesses_risks.map((x) => x.text).join(' | ');
    assert.match(text, /Budgetary bid/); assert.match(text, /faults .*change order/);
    assert.match(text, /retention period is not stated/); assert.match(text, /cloud access appears only inside the optional \$440\.00\/month plan/i);
    assert.match(text, /Warranty terms are not stated/); assert.match(text, /No installation schedule/);
  });

  await t('flags contract terms for counsel review without drawing legal conclusions', async () => {
    const keys = rv.counsel_review.map((c) => c.term);
    for (const k of fx.expected.review.counsel_terms) assert.ok(keys.includes(k), k);
    assert.ok(rv.counsel_review.every((c) => /Flag for counsel review; no legal conclusion/.test(c.note)));
    assert.ok(!/\b(is unenforceable|is enforceable|is illegal|violates|legally binding)\b/i.test(JSON.stringify(rv)), 'no legal conclusions');
    assert.strictEqual(rv.counsel_review.find((c) => c.term === 'change_orders').status, 'adverse');
  });

  await t('never assumes the proposal is the contract package: missing and referenced-but-absent documents are tracked', async () => {
    const labels = rv.missing_documents.map((d) => d.label).join(' | ');
    for (const d of ['full contract or master services agreement', 'terms and conditions', 'service level agreement', 'cloud and data-storage terms', 'privacy and security terms', 'certificate of insurance', 'implementation schedule', 'change-order policy', 'pricing validity']) assert.ok(labels.includes(d), d);
    assert.ok(rv.missing_documents.some((d) => /Camera Layout Attached separately/.test(d.label) && /not provided/.test(d.note)));
    assert.ok(record.audit.some((a) => a.action === 'request_queued' && /full contract/.test(a.note)), 'each missing document is a tracked diligence item');
  });

  await t('keeps three conclusions separate: preferred vendor is not a signable contract', async () => {
    const c = record.review.conclusions;
    assert.strictEqual(c.vendor_recommendation.vendor, fx.expected.review.vendor);
    assert.strictEqual(c.project_recommendation.decision, fx.expected.review.project);
    assert.strictEqual(c.contract_readiness.ready, fx.expected.review.contract_ready);
    assert.strictEqual(c.contract_readiness.outstanding, rv.required_conditions.length);
    assert.match(c.contract_readiness.label, /^conditional, not ready to sign \(\d+ items outstanding\)$/);
    assert.match(summary, /Vendor recommendation: iTech\. Project recommendation: Proceed\. Preliminary funding recommendation: Reserve\./);
    assert.match(summary, /Contract readiness: Conditional, not ready to sign/);
    assert.match(summary, /Monitoring plan: Not recommended unless iTech confirms it is required/);
  });

  console.log('\nWorkflow orchestration (fixture replay, no production writes)');
  const run = await DRY.fixtureRun({ mode: 'dry_run' });
  await t('community context: cites Canyon Gate records that bear on the decision, with source tags', async () => {
    const used = run.result.record.review.by_proposal['itech-2026-a'].community_context_used;
    for (const src of fx.expected.review.context_sources) assert.ok(used.some((u) => u.source === src), src);
    assert.ok(used.every((u) => /^trustEd:/.test(u.source)));
    assert.match(run.result.summary, /From Canyon Gate records: on an annual run-rate basis, Security Services \(\$235,000\/yr\) less the United Protective and Gate Sentry contracts leaves about \$11,610\/yr, enough for the optional plan's \$5,280\/yr if it turns out to be required \(this is not the amount remaining in this year's budget\).*no camera contract is on file.*leaning toward iTech/);
    assert.match(run.result.summary, /the current reserve study\/budget does not specifically include a camera-system component, so this would be a Board funding decision rather than use of an already designated reserve line item/);
    const budget = run.result.record.review.by_proposal['itech-2026-a'].strengths.find((x) => x.source === 'trustEd:vendor_contracts' && x.lens === 'financial');
    assert.ok(budget, 'the budget-line finding rests on trustEd contracts, not the proposal');
  });

  await t('community context: omits irrelevant history and never cites the message being answered', async () => {
    const all = JSON.stringify(run.result.record.community_context);
    for (const s of fx.expected.review.context_must_omit) assert.ok(!all.includes(s), `must omit ${s}`);
    const CC = require('../lib/vendors/community_context');
    const poolOnly = await CC.gatherCommunityContext(fakeDb({ email_messages: [{ id: 'p', subject: 'Pool closing', body_preview: 'pool hours', received_at: '2026-10-01' }], ap_invoices: [{ total_cents: 1000, invoice_date: '2026-09-01', status: 'paid', vendors: { name: 'A-Beautiful Pools' } }], vendor_projects: [{ title: 'Pool resurfacing', category: 'pool', stage: 'approved' }] }), { communityId: 'x', category: 'security', proposalVendors: ['iTech Monitoring, Inc.'], today: '2026-10-16' });
    assert.ok(!JSON.stringify(poolOnly.findings).match(/pool/i), 'nothing about the pool for a camera decision');
  });

  await t('sales tax is never assumed to be $0: unstated tax is estimated from the community\'s stated rate, or shown as not stated and flagged', async () => {
    const env = byKey['envera-q19538-2-packet'];
    assert.strictEqual(env.tax_basis, 'estimated'); assert.strictEqual(env.tax_rate_pct, 7.25, 'the rate iTech states for Canyon Gate');
    assert.strictEqual(env.recurring[0].tax_basis, 'estimated', '"Sales tax will be added to Monthly Investment" makes the monthly charge taxable');
    assert.strictEqual(env.tco_cents, 22232908, 'the estimated-tax total is on the record (internal analysis), not in the Board sentence');
    const lone = { ...fx.proposals.find((p) => p.key === 'envera-q19538-2-packet'), key: 'lone', expires_on: null };
    const r = C.buildComparisonRecord({ community: fx.community, project: fx.project, proposals: [lone], requirements: {}, facts: null, today: fx.today });
    const n = r.proposals[0];
    assert.strictEqual(n.tax_basis, 'not_stated'); assert.strictEqual(n.upfront_tax_cents, null, 'unknown, not $0');
    assert.match(n.tax_note, /does not state sales tax/);
    assert.ok(r.open_items.some((i) => i.topic === 'sales tax'), 'flagged for the vendor');
  });

  await t('the message being answered (any id, or a later copy in its thread) and unrelated security emails are never cited', async () => {
    const prior = run.result.record.community_context.filter((c) => c.kind === 'prior_communication');
    assert.ok(prior.length >= 1 && prior.every((c) => c.text.startsWith('2026-09-17')), prior.map((c) => c.text.slice(0, 40)).join(' | '));
    assert.ok(!/October 16, 2026/.test(run.result.summary));
    const CC = require('../lib/vendors/community_context');
    const byGraph = await CC.gatherCommunityContext(fakeDb({ email_messages: fx.context_seed.email_messages }), { communityId: 'x', category: 'security', proposalVendors: ['iTech Monitoring, Inc.'], today: fx.today, currentMessage: { graph_id: 'AAMk-1016', conversation_id: 'conv-camera', subject: 'Camera Proposals', received_at: '2026-10-16T00:51:08Z' } });
    const texts = byGraph.findings.map((f) => f.text).join(' | ');
    assert.ok(!/Camera Proposals/.test(texts), 'excluded by graph id and its thread reply');
    assert.ok(!/United Protective - Contract|tax-exempt/i.test(texts), 'the guard contract emails do not bear on the camera decision');
  });

  await t('fixture books match the live read-only run (operating $41,104.86, reserve $948,452.23, both provisional)', async () => {
    for (const [fund, cents] of Object.entries(fx.expected.cash_totals)) assert.strictEqual(facts.funds.find((x) => x.fund === fund).balance_cents, cents, fund);
  });

  await t('the recorded conclusions: iTech, proceed, Reserve (preliminary), not designated for cameras, conditional contract, no monitoring plan', async () => {
    const c = run.result.record.review.conclusions; const e = fx.expected.conclusions;
    assert.strictEqual(c.vendor_recommendation.vendor, e.vendor);
    assert.strictEqual(c.project_recommendation.decision, e.project);
    assert.strictEqual(c.funding_recommendation.source, e.funding); assert.strictEqual(c.funding_recommendation.preliminary, true);
    assert.match(c.funding_recommendation.basis, /useful life beyond the current year.*operating liquidity/);
    assert.strictEqual(c.reserve_study_status.status, e.reserve_study); assert.match(c.reserve_study_status.label, /not specifically budgeted or designated for cameras/);
    assert.strictEqual(c.contract_readiness.ready, e.contract_ready); assert.strictEqual(c.contract_readiness.conditional, e.contract_conditional);
    assert.strictEqual(c.monitoring_plan.recommended, e.monitoring_plan_recommended);
    const s = run.result.summary;
    assert.match(s, /Reserve-study status: Not specifically budgeted or designated for cameras\./);
    assert.match(s, /Preliminary funding recommendation: Reserve\. This is a capital security\/infrastructure project with a useful life extending beyond the current year, and using Reserve would better preserve operating liquidity\./);
    assert.match(s, /Current reported balances are also provisional while reconciliation and close work remain incomplete/);
  });

  await t('$74,254.68 never appears without the optional-plan qualification; the Board is not asked to approve the plan by default', async () => {
    const s = run.result.summary;
    assert.match(s, /If Canyon Gate elected to add iTech's optional \$440\.00\/month plan, the 5-year total would be approximately \$74,254\.68\. Because the Board has stated it does not want monitoring, that recurring plan is not part of my recommended configuration unless iTech confirms it is required for the desired remote\/cloud functionality\./);
    const texts = [s, run.result.plan.comparison.row.recommendation_summary, run.result.block, DRY.report(run), JSON.stringify(run.result.record.review)];
    for (const text of texts) {
      for (const sentence of String(text).split(/(?<=\.)\s+|\n/)) if (/74,254\.68|74,255/.test(sentence)) assert.match(sentence, /optional/i, `unqualified: ${sentence.slice(0, 160)}`);
    }
    const decision = s.split('\n\n').find((p) => p.startsWith('Board decision needed:'));
    assert.ok(!/plus the \$440/.test(decision), 'the plan is not approved by default');
    assert.match(decision, /The optional \$440\.00\/month plan is not included; it comes back to the Board only if iTech confirms it is required/);
    assert.ok(run.result.record.open_items.some((i) => i.topic === 'remote/cloud access cost'), 'the cloud-access cost diligence item stays');
    assert.strictEqual(run.result.record.ranking.ranked[0].tco_cents, 4785468, 'ranked on the base configuration');
  });

  console.log('\nQuestion first: intent, constraints, urgency');
  const I = require('../lib/team/intent');
  const intent = I.extractIntent({ subject: fx.board_email.subject, body: fx.board_email.body, sender_name: 'Hugh Durlam' });
  const ckIntent = (text, it = intent) => I.checkIntent(text, it).map((i) => i.code);

  await t("extracts Hugh's intent before anything else: the ask, wants, the no-monitoring exclusion, high urgency, a recommendation expected", async () => {
    assert.match(intent.asks[0], /review these proposals and give us an assessment/);
    assert.deepStrictEqual(intent.wants, ['hardware', 'installation', 'cloud access/storage']);
    assert.deepStrictEqual(intent.constraints.exclusions.map((e) => e.key), ['monitoring']);
    assert.strictEqual(intent.urgency.level, 'high');
    for (const l of ['asked to move quickly', 'equipment is down', 'installation already delayed']) assert.ok(intent.urgency.signals.some((s) => s.label === l), l);
    assert.strictEqual(intent.expected_guidance, 'recommendation');
    assert.strictEqual(intent.primary_question, 'Which proposal should we move toward, given that we want hardware, installation, cloud access/storage, no monitoring, and we need to move quickly?');
    assert.deepStrictEqual(run.result.record.intent.constraints.exclusions.map((e) => e.key), ['monitoring'], 'stored with the analysis');
  });

  await t("the Board summary's opening answers the ask: move toward iTech, subject to diligence, no rebid, no monitoring unless required", async () => {
    const paras = run.result.summary.split('\n\n');
    const rec = paras.find((p) => p.startsWith('Recommendation:'));
    assert.match(rec, /^Recommendation: move toward iTech: its August 19, 2026 proposal is the preferred direction for hardware, installation and cloud access\/storage with no monitoring, subject to the diligence items below\. There is no need to restart the bid process, and monitoring should not be added unless iTech confirms it is required for the access the Board wants\. Because cameras are down and installation cannot start before December, this is moving now\./);
    assert.strictEqual(paras.indexOf(rec), 1, 'the answer comes first, right after the greeting');
    assert.ok(paras.findIndex((p) => p.startsWith('Situation:')) > paras.indexOf(rec), 'Situation follows the answer');
    // The first sentence after the greeting carries the recommendation when the sender asked a direct question.
    const firstSentence = paras[1].split(/(?<=[.?!])\s+/)[0];
    assert.match(firstSentence, /move toward iTech: its August 19, 2026 proposal is the preferred direction/);
    assert.deepStrictEqual(require('../lib/team/intent').checkIntent(paras.slice(0, 2).join('\n\n').split(/(?<=[.?!])\s+/)[0] + ' cameras are down', run.result.record.intent).filter((i) => i.code === 'unanswered_ask'), []);
    assert.match(paras.find((p) => p.startsWith('Action underway:')), /because cameras are down and installation cannot start before December, the requests to iTech .* prepared on the workflow record now, so iTech can fix the scope and hold an installation date/);
    assert.deepStrictEqual(D.checkDecisionReady(run.result.summary, { confidence: { mode: 'transition', cash_label: 'provisional' }, intent: run.result.record.intent }), { ok: true, issues: [] });
  });

  await t('flags an opening that does not answer the ask, and an unrequested generic process', async () => {
    assert.ok(ckIntent('Hi Hugh,\n\nThanks for sending these. Envera has the widest coverage and Netwatch uses AI analytics.\n\nCameras are down, so time matters.').includes('unanswered_ask'));
    assert.ok(ckIntent('Hi Hugh,\n\nI recommend iTech.\n\nWe should also issue a new RFP to two more vendors. Cameras are down, so time matters.').includes('adjacent_focus'));
    assert.ok(!ckIntent('Hi Hugh,\n\nI recommend iTech; there is no need to restart the bid process. Cameras are down, so time matters.').includes('adjacent_focus'), 'a negated mention is not a proposal');
  });

  await t('flags monitoring recommended or priced by default, but not the vendor name or an explained conflict', async () => {
    assert.ok(ckIntent('Hi Hugh,\n\nI recommend iTech plus its $440/month monitoring plan. Cameras are down, so I am moving quickly.').includes('ignored_constraint'));
    assert.ok(!ckIntent('Hi Hugh,\n\nI recommend iTech Monitoring, Inc. at $47,854.68. Cameras are down, so I am moving quickly.').includes('ignored_constraint'), 'the company name is not the service');
    assert.ok(!ckIntent('Hi Hugh,\n\nI recommend iTech at $47,854.68; the optional $440/month monitoring plan is not part of my recommendation unless iTech confirms it is required. Cameras are down, so I am moving quickly.').includes('ignored_constraint'));
    assert.ok(!ckIntent('Hi Hugh,\n\nI recommend iTech with its $440/month monitoring plan because iTech confirmed it is required for cloud access. Alternatives considered: a version without monitoring, an unbundled access option. Cameras are down, so I am moving quickly.').includes('ignored_constraint'), 'explained, with alternatives');
  });

  await t('flags a reply that ignores the urgency, and options without the guidance asked for; the retry names each', async () => {
    assert.ok(ckIntent('Hi Hugh,\n\nI recommend iTech at $47,854.68.').includes('urgency_omitted'));
    assert.ok(ckIntent('Hi Hugh,\n\nHere is where things stand on the cameras, which are down:\n1. iTech at $47,854.68\n2. Envera at $64,443.88').includes('options_without_guidance'));
    const note = D.retryNote(D.checkDecisionReady('Hi Hugh,\n\nThanks.\n\nEnvera covers the most locations.\n\nI recommend iTech plus its $440/month monitoring plan.', { intent }).issues, intent);
    assert.match(note, /Start by answering it: Which proposal should we move toward/); assert.match(note, /excluded \(monitoring\)/); assert.match(note, /urgent/);
  });

  console.log('\nExplicit constraints override default packages');
  await t('if iTech confirms the plan is required, the summary explains the conflict, names alternatives, queues a compliant-version request, and still passes', async () => {
    const props = fx.proposals.map((p) => p.key !== 'itech-2026-a' ? p : { ...p, pricing: { ...p.pricing, recurring: [{ ...p.pricing.recurring[0], vendor_confirmed_required: true }] } });
    const r = C.buildComparisonRecord({ community: fx.community, project: fx.project, proposals: props, requirements: req, facts, today: fx.today, intent });
    const c = r.constraint_conflicts.find((x) => x.kind === 'recommended_includes_excluded');
    assert.ok(c && c.constraint === 'monitoring'); assert.match(c.reason, /confirmed .* required for remote\/cloud access/);
    assert.ok(c.alternatives.some((a) => /version without the excluded monitoring/.test(a)) && c.alternatives.some((a) => /Envera/.test(a)));
    assert.ok(r.open_items.some((i) => i.topic === 'compliant version' && /iTech/.test(i.vendor)));
    const s = C.renderBoardSummary(r, { greetingName: 'Hugh' });
    assert.match(s, /This conflicts with the Board's instruction \(no monitoring\): .*Alternatives considered: .*Weighing those, I still recommend iTech/);
    assert.ok(D.checkDecisionReady(s, { intent }).issues.every((i) => i.code !== 'ignored_constraint'));
  });

  await t('"not vendor X": an excluded vendor is never recommended, and a draft recommending it without explanation is flagged', async () => {
    const it = I.extractIntent({ subject: 'Pool bids', body: 'Please give us your recommendation on the pool management bids. We do not want Aegis again.' });
    assert.deepStrictEqual(it.constraints.exclusions.map((e) => e.key), ['vendor:aegis']);
    const mk = (key, vendor, cents) => ({ key, vendor_name: vendor, document: { filename: `${key}.pdf` }, document_date: '2026-10-01', pricing: { upfront_cents: cents, tax_rate_pct: 8.25 }, model: { ownership: 'association', monitoring: 'none' } });
    const r = C.buildComparisonRecord({ community: fx.community, project: { title: 'Pool Management 2027', service_category: 'pool_management' }, proposals: [mk('a', 'Aegis Aquatics', 3000000), mk('s', 'SwimCo LLC', 3500000)], requirements: {}, facts: null, today: fx.today, intent: it });
    assert.strictEqual(r.recommendation.vendor_name, 'SwimCo LLC', 'the cheaper excluded vendor is not recommended');
    assert.ok(r.ranking.not_viable.find((x) => x.key === 'a').reasons.some((m) => /the Board said not to use Aegis/.test(m)));
    assert.ok(ckIntent('Hi,\n\nI recommend Aegis Aquatics at $30,000.', it).includes('ignored_constraint'));
  });

  await t('when every option violates a constraint, the summary says so, gives the reason and alternatives, and recommends asking for compliant versions', async () => {
    const only = fx.proposals.filter((p) => ['envera-q19538-2-packet', 'netwatch-2026'].includes(p.key)).map((p) => ({ ...p, expires_on: null }));
    const r = C.buildComparisonRecord({ community: fx.community, project: fx.project, proposals: only, requirements: req, facts, today: fx.today, intent });
    assert.strictEqual(r.recommendation, null);
    const nb = r.constraint_conflicts.find((x) => x.kind === 'no_option_satisfies');
    assert.ok(nb && /monitoring/.test(nb.reason));
    assert.ok(r.open_items.filter((i) => i.topic === 'compliant version').length >= 2, 'a compliant-version request per vendor');
    const s = C.renderBoardSummary(r, { greetingName: 'Hugh' });
    assert.match(s, /Recommendation: none of the proposals meets the Board's instruction as quoted, so I do not recommend approving any of them yet\. My recommendation is to ask Envera and Netwatch for versions that meet it\./);
    assert.match(s, /Alternatives considered: .*quotes from other vendors/);
    assert.match(s, /because cameras are down/);
  });

  await t('shared team layer exports the rule and the check; Amanda reads intent first and passes it to the check', async () => {
    const core = require('../lib/team/operator_core');
    for (const k of ['INTENT_FIRST_RULE', 'extractIntent', 'intentBlock', 'checkIntent', 'intentRetryLines']) assert.ok(core[k], k);
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'community', 'amanda_reply.js'), 'utf8');
    assert.ok(src.indexOf('intentLib.extractIntent(') < src.indexOf('propertyContext(') || src.indexOf('intentLib.extractIntent(') < src.indexOf('prepareComparison('), 'intent is extracted before the analysis');
    assert.ok(/intentLib\.intentBlock\(intent\)/.test(src) && /intentLib\.INTENT_FIRST_RULE/.test(src) && /, intent \};/.test(src) && /retryNote\(dr\.issues, intent\)/.test(src));
  });

  await t('the run-rate sentence joins vendor names cleanly (legal suffixes like ", LLC" / ", L.P." never leave a stray comma)', async () => {
    const R2 = require('../lib/vendors/proposal_review');
    const n = run.result.record.proposals.find((x) => x.key === 'itech-2026-a');
    const ctx = [{ kind: 'contract', source: 'trustEd:vendor_contracts', text: 'x', data: { category: 'security', annual_cents: 21663893, vendor: 'United Protective Services of South Texas, L.P.' } },
      { kind: 'contract', source: 'trustEd:vendor_contracts', text: 'y', data: { category: 'security', annual_cents: 675155, vendor: 'Gate Sentry, LLC' } }];
    const rv2 = R2.reviewProposal(n, { requirements: req, facts, context: ctx });
    const brief = rv2.strengths.concat(rv2.weaknesses_risks).find((x) => /run-rate/.test(x.brief || '')).brief;
    assert.match(brief, /less the United Protective and Gate Sentry contracts/);
    assert.ok(!/,\s+contracts|Sentry,/.test(brief), brief);
  });

  await t("the schedule note quotes the sender's sentence and interprets it (earliest installation December)", async () => {
    const notes = C.boardRequirements(fx.board_email.body).notes.join(' | ');
    assert.match(notes, /schedule: earliest installation December \(sender: "Even if we said yes today, they wouldn't be able to install us until December\."\)/);
    assert.ok(!/schedule: install us until/.test(notes));
  });

  await t('the structured conclusions carry all six keys and the Board summary is rendered from them', async () => {
    const c = run.result.record.review.conclusions;
    assert.deepStrictEqual(Object.keys(c).sort(), ['contract_readiness', 'funding_recommendation', 'monitoring_plan', 'project_recommendation', 'reserve_study_status', 'vendor_recommendation']);
    const line = run.result.summary.split('\n\n').find((p) => p.startsWith('Conclusions:'));
    assert.ok(line.includes(c.reserve_study_status.label.charAt(0).toUpperCase() + c.reserve_study_status.label.slice(1)));
    assert.ok(line.includes(c.contract_readiness.label.charAt(0).toUpperCase() + c.contract_readiness.label.slice(1)));
    assert.ok(line.includes(c.monitoring_plan.label.charAt(0).toUpperCase() + c.monitoring_plan.label.slice(1)));
    const rep = DRY.report(run);
    for (const k of ['Vendor recommendation:', 'Project recommendation:', 'Preliminary funding recommendation:', 'Reserve-study status:', 'Contract readiness:', 'Monitoring plan:']) assert.ok(rep.includes(`  ${k}`), `report prints ${k}`);
  });

  console.log('\nQuantities from stored line items (deterministic)');
  const LI = require('../lib/vendors/line_items');
  const itemOf = (key) => JSON.parse(JSON.stringify(fx.proposals.find((p) => p.key === key)));
  const build = (props) => C.buildComparisonRecord({ community: fx.community, project: fx.project, proposals: props, requirements: req, facts, today: fx.today, intent });

  await t('iTech counts are computed from the stored line items: 14 new + 13 reused = 27 cameras, 20 licenses, subtotal matches', async () => {
    const q = LI.computeQuantities(itemOf('itech-2026-a'));
    const e = fx.expected.itech_line_items;
    assert.strictEqual(q.status, 'stored'); assert.deepStrictEqual(q.errors, []);
    for (const k of ['cameras_new', 'cameras_reused', 'cameras_total', 'licenses', 'embedded_server_cameras']) assert.strictEqual(q.values[k], e[k], k);
    assert.deepStrictEqual(q.subtotal, { items_cents: e.items_cents, printed_cents: e.printed_cents, matches: true });
    assert.deepStrictEqual(q.uncertain, e.uncertain);
  });

  await t('determinism: the same stored line items give byte-identical quantities, open items and summary on every run', async () => {
    const a = build(JSON.parse(JSON.stringify(fx.proposals))); const b = build(JSON.parse(JSON.stringify(fx.proposals)));
    assert.strictEqual(JSON.stringify(a.quantities), JSON.stringify(b.quantities));
    assert.strictEqual(JSON.stringify(a.open_items), JSON.stringify(b.open_items));
    assert.strictEqual(C.renderBoardSummary(a, { greetingName: 'Hugh' }), C.renderBoardSummary(b, { greetingName: 'Hugh' }));
    // A model-stated total on the item is ignored: counts come from the line items.
    const noisy = JSON.parse(JSON.stringify(fx.proposals)); const it = noisy.find((p) => p.key === 'itech-2026-a'); it.scope.cameras_total = 28; it.scope.cameras_new = 15;
    assert.strictEqual(JSON.stringify(build(noisy).quantities), JSON.stringify(a.quantities));
  });

  await t('a line-item sum that does not match the printed subtotal is uncertain and becomes an open item', async () => {
    const it = itemOf('itech-2026-a'); it.line_items.find((l) => l.category === 'materials_labor').extended_cents = 4400000;
    const q = LI.computeQuantities(it);
    const u = q.uncertain.find((x) => x.field === 'upfront_cents');
    assert.ok(u && /do not add up/.test(u.reason)); assert.deepStrictEqual(u.values.map((v) => [v.value, v.page]), [[4400000, '7'], [4461975, 7]]);
    const r = build([it]);
    assert.ok(r.open_items.some((i) => i.topic === 'quantity: the subtotal' && /line items \$44,000\.00 \(page 7\); printed subtotal \$44,619\.75 \(page 7\), unconfirmed/.test(i.request)));
  });

  await t('a cover/narrative count that disagrees with the itemized table is uncertain, shown as "N per page X; M per page Y, unconfirmed"', async () => {
    const it = itemOf('itech-2026-a'); it.scope_statements.push({ category: 'camera_new', quantity: 1, page: 1, excerpt: 'cover: 15 new cameras' });
    const q = LI.computeQuantities(it);
    assert.ok(q.uncertain.some((x) => x.field === 'cameras_new' && /disagree/.test(x.reason)));
    assert.match(LI.renderQuantity(q, 'cameras_new'), /^page 4 table: 14; page 1-3: 'iTech will Swap out 4 Cameras.*' \/ 'cover: 15 new cameras', unconfirmed$/, 'quotes the document; never a derived narrative total');
    const r = build([it]);
    assert.ok(r.open_items.some((i) => i.topic === 'quantity: new cameras'));
    const s = C.renderBoardSummary(r, { greetingName: 'Hugh' });
    assert.match(s, /a camera count that is not yet confirmed \(new page 4 table: 14; page 1-3: '.*cover: 15 new cameras', unconfirmed; reused 13\)/);
    assert.ok(!/\b2[78] cameras\b/.test(s), 'no total stated while a component is unconfirmed');
  });

  await t('the Board summary states no count that is not in the computed values', async () => {
    const q = run.result.record.quantities.find((x) => x.key === 'itech-2026-a').values;
    const allowed = new Set(Object.values(q).filter((v) => v != null).map(String));
    for (const m of run.result.summary.matchAll(/\b(\d+) (cameras?(?! proposals)|reused|new|licenses?)\b/g)) assert.ok(allowed.has(m[1]), `"${m[0]}" is not a computed value`);
    assert.match(run.result.summary, /27 cameras \(13 reused, 14 new\)/); assert.match(run.result.summary, /a camera schedule \(27 cameras, 20 licenses\)/);
  });

  await t('source pages are carried through to the stored audit and the quantities record', async () => {
    const note = run.result.record.audit.find((a) => /^Quantities for iTech/.test(a.note)).note;
    assert.match(note, /from approved stored line items: cameras 27 = new 14 \(p\. 3, 4\), reused 13 \(p\. 3\), licenses 20 \(p\. 3\); line items \$44,619\.75 vs printed subtotal \$44,619\.75: match/);
    const pv = run.result.record.quantities.find((x) => x.key === 'itech-2026-a').provenance;
    assert.ok(pv.licenses.every((p) => p.page === 3 && /20- DW Licenses/.test(p.excerpt)));
  });

  await t('line items not yet stored: counts are labelled provisional; no line items at all: provisional too', async () => {
    const it = itemOf('itech-2026-a'); it.line_items_stored = false;
    assert.strictEqual(LI.computeQuantities(it).status, 'not_yet_stored');
    assert.match(C.renderBoardSummary(build([it]), { greetingName: 'Hugh' }), /27 cameras \(13 reused, 14 new\) \(provisional: line items not yet stored\)/);
    const bare = itemOf('itech-2026-b');
    assert.strictEqual(LI.computeQuantities(bare).status, 'none');
  });

  await t('backfill: dry run by default, skips proposals that already have line items, never overwrites; --apply writes extracted_data only', async () => {
    const B = require('../scripts/backfill_proposal_line_items');
    const writes = [];
    const rows = [{ id: 'vp-old', file_path: 'rfps/x/old.pdf', file_hash: null, extracted_data: { company_name: 'iTech' } }, { id: 'vp-new', file_path: 'rfps/x/new.pdf', extracted_data: { comparison_items: [itemOf('itech-2026-a')] } }];
    const db = { from(table) { const q = { select() { return q; }, order() { return q; }, limit() { return q; }, eq() { return q; }, maybeSingle() { return Promise.resolve({ data: rows[0], error: null }); }, update(row) { writes.push({ table, row }); return { eq: () => Promise.resolve({ error: null }) }; }, then(r, j) { return Promise.resolve({ data: rows, error: null }).then(r, j); } }; return q; },
      storage: { from: () => ({ download: async () => ({ data: { arrayBuffer: async () => Buffer.from('pdf') }, error: null }) }) } };
    const extract = async () => ({ items: [itemOf('itech-2026-a')], diagnostic: { invalid: [] } });
    const plan = await B.plan(db, { community: 'cg', extract });
    assert.deepStrictEqual(plan.map((p) => p.action), ['store', 'skip']);
    assert.strictEqual(plan[0].computed[0].values.cameras_total, 27);
    assert.strictEqual(writes.length, 0, 'planning writes nothing');
    await B.apply(db, plan);
    assert.strictEqual(writes.length, 1); assert.strictEqual(writes[0].table, 'vendor_proposals');
    assert.deepStrictEqual(Object.keys(writes[0].row), ['extracted_data']);
    assert.ok(writes[0].row.extracted_data.line_items_sha256 && writes[0].row.extracted_data.comparison_items[0].line_items.length === 23);
    assert.strictEqual(writes[0].row.extracted_data.company_name, 'iTech', 'existing extraction kept');
  });

  console.log('\nLine-item versions: reuse, no re-extraction; versioned reprocessing');
  const V = require('../lib/vendors/line_item_versions');
  const v1 = V.approveVersion(V.addVersion({}, { items: [itemOf('itech-2026-a')], document_sha256: 'sha-A', reason: 'initial extraction', requested_by: 'backfill', at: '2026-10-16T12:00:00Z' }), 1, { approved_by: 'Ed', at: '2026-10-16T13:00:00Z' });

  await t('a rerun with the same file hash makes no new extraction (store, backfill and workflow paths)', async () => {
    assert.deepStrictEqual(V.needsExtraction(v1, 'sha-A'), { extract: false, reason: null });
    assert.strictEqual(V.needsExtraction({}, 'sha-A').reason, 'not_stored');
    const B = require('../scripts/backfill_proposal_line_items');
    let calls = 0;
    const db = { from() { const q = { select() { return q; }, order() { return q; }, limit() { return q; }, eq() { return q; }, then(r, j) { return Promise.resolve({ data: [{ id: 'vp1', file_path: 'x.pdf', file_hash: 'sha-A', extracted_data: v1 }], error: null }).then(r, j); } }; return q; }, storage: { from: () => ({ download: async () => { calls++; return { data: null, error: null }; } }) } };
    const plan = await B.plan(db, { extract: async () => { calls++; return { items: [] }; } });
    assert.strictEqual(plan[0].action, 'skip'); assert.match(plan[0].reason, /v1, approved/); assert.strictEqual(calls, 0, 'no download, no model call');
    const again = await DRY.fixtureRun(); assert.deepStrictEqual(again.extracted, ['Canyon Gate at Cinco Ranch Qoute 19538.pdf'], 'only the document not on file is extracted');
  });

  await t('a hash change creates version 2 (pending review) and keeps version 1 approved and readable', async () => {
    assert.strictEqual(V.needsExtraction(v1, 'sha-B').reason, 'hash_changed');
    const v2 = V.addVersion(v1, { items: [itemOf('itech-2026-a')], document_sha256: 'sha-B', reason: 'source file changed', requested_by: 'backfill', at: '2026-10-17T12:00:00Z' });
    assert.deepStrictEqual(v2.line_item_versions.map((v) => [v.version, v.status, v.document_sha256]), [[1, 'approved', 'sha-A'], [2, 'pending_review', 'sha-B']]);
    assert.strictEqual(v2.approved_line_item_version, 1); assert.strictEqual(V.currentApproved(v2).version, 1, 'the workflow still reads v1');
    assert.strictEqual(JSON.stringify(v2.line_item_versions[0]), JSON.stringify(v1.line_item_versions[0]), 'v1 is not modified');
    assert.ok(v2.line_item_versions[1].differs_from_approved.some((d) => d.field === 'document_sha256'));
    assert.strictEqual(v1.line_item_versions.length, 1, 'inputs are not mutated');
  });

  await t('a reprocessed version whose counts differ is flagged for review, never swapped in; approval keeps the old version as superseded', async () => {
    assert.throws(() => V.needsExtraction(v1, 'sha-A', { reprocess: { reason: 'x' } }), /requested_by and reason/);
    assert.strictEqual(V.needsExtraction(v1, 'sha-A', { reprocess: { requested_by: 'Ed', reason: 'check the 27 vs 28 count' } }).reason, 'reprocess_requested');
    const changed = itemOf('itech-2026-a'); changed.line_items.find((l) => l.description === '5MP IR Turret Camera').quantity = 8;
    const v2 = V.addVersion(v1, { items: [changed], document_sha256: 'sha-A', reason: 'check the 27 vs 28 count', requested_by: 'Ed' });
    const nv = v2.line_item_versions[1];
    assert.strictEqual(nv.status, 'pending_review');
    assert.deepStrictEqual(nv.differs_from_approved.map((d) => [d.field, d.approved, d.new]), [['cameras_new', 14, 15], ['cameras_total', 27, 28]]);
    assert.match(nv.review_flag, /review before approving/);
    assert.strictEqual(V.currentApproved(v2).totals.cameras_total, 27, 'still 27 until a human approves');
    const ap = V.approveVersion(v2, 2, { approved_by: 'Ed' });
    assert.deepStrictEqual(ap.line_item_versions.map((v) => v.status), ['superseded', 'approved']);
    assert.strictEqual(ap.line_item_versions.length, 2, 'nothing deleted');
  });

  await t('preview cache: the first dry run extracts and caches by hash; the second reuses it with no model call; --reprocess makes a new version and shows the diff', async () => {
    const store = {}; const cache = { get: (sha) => store[sha] ? JSON.parse(store[sha]) : null, put: (sha, ed) => { store[sha] = JSON.stringify(ed); } };
    const first = await DRY.fixtureRun({ previewCache: cache });
    assert.deepStrictEqual(first.extracted, ['Canyon Gate at Cinco Ranch Qoute 19538.pdf']);
    assert.ok(first.result.extraction_log.some((x) => x.source === 'fresh extraction' && x.cached_as_version === 1));
    assert.ok(first.result.extraction_log.filter((x) => /^stored v1 \(approved\)/.test(x.source)).length >= 2, 'documents on the record come from storage');
    const second = await DRY.fixtureRun({ previewCache: cache });
    assert.deepStrictEqual(second.extracted, [], 'no model call on the second run');
    assert.ok(second.result.extraction_log.some((x) => x.source === 'preview cache v1 (preview)' && x.extracted === false));
    assert.strictEqual(JSON.stringify(second.result.record.quantities), JSON.stringify(first.result.record.quantities), 'identical quantities');
    assert.strictEqual(second.result.summary, first.result.summary, 'identical summary');
    const bump = (r0) => ({ ...r0, items: (r0.items || []).map((it) => ({ ...it, line_items: [{ description: 'Outdoor Bullet Camera', category: 'camera_new', quantity: 6, page: 1, excerpt: '6 Outdoor Bullet Camera - 4MP' }] })) });
    const rp = await DRY.fixtureRun({ previewCache: cache, reprocess: { requested_by: 'Ed', reason: 'compare a fresh extraction' }, transformExtract: bump });
    assert.ok(rp.extracted.length >= 1, 'reprocess calls the model');
    const entry = rp.result.extraction_log.find((x) => x.source === 'fresh (reprocess)');
    assert.ok(entry && entry.cached_as_version === 2 && entry.differs.some((d) => d.field === 'cameras_new'), JSON.stringify(entry));
    assert.match(DRY.report(rp), /fresh \(reprocess\).*DIFFERS from the current version \(v1, preview\): cameras_new 0 -> 6/);
    const kept = cache.get(Object.keys(store)[0]);
    assert.deepStrictEqual(kept.line_item_versions.map((v) => v.status), ['preview', 'preview'], 'preview versions are never approved; v1 kept');
  });

  console.log('\nNo proposal ever disappears (fresh and cache paths)');
  // The real live shapes: a multi-proposal packet, a single-proposal quote, and a document with line items.
  const packetShape = ['itech-2024', 'envera-q19538-2-packet', 'netwatch-2026'].map((k) => itemOf(k));
  const quoteShape = [itemOf('envera-q19538-2-standalone')];
  const itechShape = [itemOf('itech-2026-a')];
  const runFresh = async ({ cache = null, extract }) => {
    const db = DRY.fakeDb({ ...fx.db_seed, ...(fx.context_seed || {}), vendor_proposals: [], bid_requests: [], library_documents: [] });
    const files = [['packet.pdf', packetShape], ['quote 19538.pdf', quoteShape], ['itech sept.pdf', itechShape]].map(([n]) => ({ filename: n, buffer: Buffer.from(`bytes ${n}`), isPdf: true }));
    const shapes = { 'packet.pdf': packetShape, 'quote 19538.pdf': quoteShape, 'itech sept.pdf': itechShape };
    const ex = extract || (async (buf, meta) => ({ items: JSON.parse(JSON.stringify(shapes[meta.filename])).map((it) => ({ ...it, line_items_stored: undefined })), diagnostic: { returned_count: shapes[meta.filename].length, invalid: [] } }));
    return W.prepareComparison({ supabase: db, communityId: fx.community.id, communityName: fx.community.name, email: { ...fx.board_email, id: 'em-1016' }, attachments: files, today: fx.today, mode: 'dry_run', factsDetailed: facts, extract: ex, mgmtId: 'mgmt', greetingName: 'Hugh', previewCache: cache });
  };

  await t('a packet (3 proposals), a single quote and an itemized proposal all reach the classification, fresh and from the preview cache', async () => {
    const store = {}; const cache = { get: (sha) => store[sha] ? JSON.parse(store[sha]) : null, put: (sha, ed) => { store[sha] = JSON.stringify(ed); } };
    const fresh = await runFresh({ cache });
    const keysFresh = fresh.record.proposals.map((n) => n.key).sort();
    assert.deepStrictEqual(keysFresh, ['envera-q19538-2-packet', 'envera-q19538-2-standalone', 'itech-2024', 'itech-2026-a', 'netwatch-2026']);
    assert.deepStrictEqual(Object.values(store).map((x) => JSON.parse(x).line_item_versions[0].items.length).sort(), [1, 1, 3], 'every proposal cached, none empty');
    const cached = await runFresh({ cache, extract: async () => { throw new Error('model must not be called on the cache path'); } });
    assert.deepStrictEqual(cached.record.proposals.map((n) => n.key).sort(), keysFresh);
    assert.ok(cached.summary.includes("Envera is not recommended because the quote is expired and the package is built around substantial recurring monitoring/service costs the Board has said it does not want.")); assert.ok(cached.summary.includes("Netwatch is not a viable current alternative because no executable price was provided and the design incorporates monitoring the Board has said it does not want."));
    assert.ok(cached.extraction_log.every((x) => /^preview cache v1 \(preview\)/.test(x.source)));
  });

  await t('a run fails loudly with the count when extraction loses proposals (truncated reply, or parsed fewer than returned)', async () => {
    await assert.rejects(runFresh({ extract: async (buf, meta) => ({ items: meta.filename === 'packet.pdf' ? [packetShape[0]] : (meta.filename === 'quote 19538.pdf' ? quoteShape : itechShape), diagnostic: { returned_count: meta.filename === 'packet.pdf' ? 3 : 1, invalid: [], truncated: ['proposals pass hit max_tokens'] } }) }), /extraction dropped 2 of 3 proposal\(s\) in packet\.pdf \(proposals pass hit max_tokens\)/);
    const X = require('../lib/vendors/proposal_extract');
    const truncated = { messages: { create: async () => ({ stop_reason: 'max_tokens', content: [{ text: '{"proposals":[{"vendor_name":"iTech"},{"vendor_name":"Envera"},{"vendor_name":"Netwa' }] }) } };
    const r = await X.extractProposals(Buffer.from('pdf'), { filename: 'packet.pdf' }, { anthropic: truncated });
    assert.strictEqual(r.diagnostic.returned_count, 3); assert.strictEqual(r.items.length, 0);
    assert.throws(() => W.assertNoneDropped('packet.pdf', r), /dropped 3 of 3 proposal\(s\) in packet\.pdf/);
  });

  await t('two-pass extraction: proposals first, then line items per proposal; a failed line-item pass keeps the proposal', async () => {
    const X = require('../lib/vendors/proposal_extract');
    let n = 0;
    const client = { messages: { create: async ({ messages }) => { n++; const text = messages[0].content[1].text;
      if (/Read ONLY the proposal from Envera/.test(text)) return { stop_reason: 'max_tokens', content: [{ text: '{"line_items":[{"desc' }] };
      if (/Read ONLY the proposal from iTech/.test(text)) return { stop_reason: 'end_turn', content: [{ text: JSON.stringify({ line_items: itemOf('itech-2026-a').line_items, scope_statements: itemOf('itech-2026-a').scope_statements, printed_subtotal_cents: 4461975, printed_subtotal_page: 7 }) }] };
      return { stop_reason: 'end_turn', content: [{ text: JSON.stringify({ proposals: [{ vendor_name: 'iTech Monitoring, Inc.', pages: '1-8', pricing: { upfront_cents: 4461975 } }, { vendor_name: 'Envera Systems', pages: '9-13', pricing: { upfront_cents: 6008753 } }] }) }] }; } } };
    const r = await X.extractProposals(Buffer.from('pdf'), { filename: 'packet.pdf' }, { anthropic: client });
    assert.strictEqual(n, 3, 'one proposals pass + one line-item pass per proposal');
    assert.deepStrictEqual(r.items.map((i) => i.vendor_name), ['iTech Monitoring, Inc.', 'Envera Systems'], 'both kept');
    assert.strictEqual(r.items[0].line_items.length, 23); assert.strictEqual(r.items[1].line_items, null);
    assert.ok(r.diagnostic.truncated.some((x) => /Envera Systems hit max_tokens/.test(x)));
    assert.match(X.LINES_RULE, /ONE statement PER LOCATION/);
  });

  await t('Spec 1: live-like shapes with no line items or no price fields all stay in the comparison, with the full Board reasoning, fresh and cached', async () => {
    const strip = (it) => { const c = JSON.parse(JSON.stringify(it)); delete c.line_items; delete c.scope_statements; delete c.line_items_stored; return c; };
    // As the live extraction returns them: Netwatch is design-only with NO pricing fields at all (no unpriced flag);
    // Envera has proposal-level totals and monthly services but no line items; iTech 2024 has no line items.
    const netwatchLive = { ...strip(itemOf('netwatch-2026')), pricing: {} };
    const packetLive = [strip(itemOf('itech-2024')), strip(itemOf('envera-q19538-2-packet')), netwatchLive];
    const quoteLive = [strip(itemOf('envera-q19538-2-standalone'))];
    const shapes = { 'packet.pdf': packetLive, 'quote 19538.pdf': quoteLive, 'itech sept.pdf': [itemOf('itech-2026-a')] };
    const ex = async (buf, meta) => ({ items: JSON.parse(JSON.stringify(shapes[meta.filename])), diagnostic: { returned_count: shapes[meta.filename].length, invalid: [] } });
    const store = {}; const cache = { get: (sha) => store[sha] ? JSON.parse(store[sha]) : null, put: (sha, ed) => { store[sha] = JSON.stringify(ed); } };
    for (const pass of ['fresh', 'cached']) {
      const r = await runFresh({ cache, extract: pass === 'fresh' ? ex : async () => { throw new Error('no model call on the cache path'); } });
      const by = Object.fromEntries(r.record.proposals.map((n) => [n.key, n]));
      assert.deepStrictEqual(Object.keys(by).sort(), ['envera-q19538-2-packet', 'envera-q19538-2-standalone', 'itech-2024', 'itech-2026-a', 'netwatch-2026'], pass);
      assert.strictEqual(by['itech-2026-a'].status, 'current'); assert.strictEqual(by['itech-2024'].status, 'historical');
      assert.strictEqual(by['envera-q19538-2-packet'].status, 'expired'); assert.strictEqual(by['netwatch-2026'].status, 'current'); assert.strictEqual(by['netwatch-2026'].unpriced, true);
      assert.strictEqual(by['envera-q19538-2-standalone'].status, 'duplicate'); assert.strictEqual(by['envera-q19538-2-standalone'].duplicate_of, 'envera-q19538-2-packet', 'duplicate relationship recorded');
      assert.ok(r.summary.includes("Envera is not recommended because the quote is expired and the package is built around substantial recurring monitoring/service costs the Board has said it does not want."), 'Envera sentence');
      assert.ok(r.summary.includes("Netwatch is not a viable current alternative because no executable price was provided and the design incorporates monitoring the Board has said it does not want."), 'Netwatch sentence');
      assert.match(r.summary, /iTech's 2024 proposal is superseded/);
      assert.match(r.summary, /Situation: 4 camera proposals from 3 vendors are on file/);
      assert.ok(r.record.audit.some((a) => a.proposal_key === 'netwatch-2026' && /no price found: treated as unpriced/.test(a.note)), 'the repair is on the record');
    }
  });

  await t('Spec 1 guard: a proposal leaving the comparison without a classified reason fails the run with the counts', async () => {
    const r = build(JSON.parse(JSON.stringify(fx.proposals)));
    assert.ok(r.proposals.every((n) => n.status && n.status_reason), 'every proposal carries a classified reason');
    assert.ok(r.proposals.filter((n) => n.status === 'duplicate').every((n) => n.duplicate_of));
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vendors', 'rfp_workflow.js'), 'utf8');
    assert.match(src, /comparison completeness check failed: \$\{fedIn\} proposal\(s\) discovered, \$\{classified\} carried into the comparison/);
  });

  await t('exclusion reasons are computed from stored facts in a fixed order, identical across runs whose model text differs', async () => {
    // Run A vs run C on the live data: Netwatch's model attributes and wording differ; the facts do not.
    const netA = { ...itemOf('netwatch-2026'), model: { ownership: null, monitoring: 'required', cloud_access: null } };
    const netC = { ...itemOf('netwatch-2026'), model: { ownership: null, monitoring: null, cloud_access: 'included' }, scope: { ...itemOf('netwatch-2026').scope, summary: 'Netwatch to install Cvedia Analytic Platform for PVM monitoring and a Hanwha VMS with 30 days of footage retention' } };
    const envA = { ...itemOf('envera-q19538-2-packet'), model: { ownership: null, monitoring: 'included', cloud_access: 'included' } };
    const envC = { ...itemOf('envera-q19538-2-packet'), model: { ownership: null, monitoring: null, cloud_access: null } };
    const reasons = (props) => build(props).ranking.not_viable.map((x) => [x.key, x.reasons]);
    const a = reasons([itemOf('itech-2026-a'), itemOf('itech-2024'), envA, netA]);
    const c = reasons([itemOf('itech-2026-a'), itemOf('itech-2024'), envC, netC]);
    assert.deepStrictEqual(a, c);
    assert.deepStrictEqual(a, [
      ['envera-q19538-2-packet', ['quote expired 2026-08-31', 'monitoring-heavy ($2,631.42/month in required monitoring services the Board does not want)']],
      ['netwatch-2026', ['no price provided', 'monitoring-oriented (built around a monitoring service the Board does not want)']],
    ]);
    // Ownership is added only when the stored attribute says the vendor owns the equipment.
    const netOwn = { ...netA, model: { ...netA.model, ownership: 'vendor' } };
    assert.deepStrictEqual(reasons([itemOf('itech-2026-a'), netOwn]).find((x) => x[0] === 'netwatch-2026')[1], ['no price provided', 'monitoring-oriented (built around a monitoring service the Board does not want)', 'the association would not own the equipment']);
    // iTech's optional "Health Monitoring" plan and its company name never make it monitoring-oriented.
    assert.strictEqual(C.monitoringEvidence(build([itemOf('itech-2026-a')]).proposals[0]).oriented, false);
  });

  await t('every column the RFP code selects from a migration-defined table exists in the migrations (static check)', async () => {
    const migs = fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter((f) => /\.sql$/.test(f)).map((f) => fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8')).join('\n');
    const columnsOf = (table) => {
      const cols = new Set();
      const create = migs.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i')) || migs.match(new RegExp(`CREATE TABLE ${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i'));
      if (!create) return null;
      for (const line of create[1].split('\n')) { const m = line.match(/^\s+([a-z_][a-z0-9_]*)\s+[A-Za-z]/); if (m && !/^(constraint|primary|unique|check|foreign)$/i.test(m[1])) cols.add(m[1]); }
      for (const m of migs.matchAll(new RegExp(`ALTER TABLE (?:IF EXISTS )?${table}[\\s\\S]*?;`, 'gi'))) for (const c of m[0].matchAll(/ADD COLUMN (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gi)) cols.add(c[1]);
      return cols;
    };
    const src = ['lib/vendors/rfp_workflow.js', 'lib/vendors/community_context.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
    let checked = 0;
    for (const m of src.matchAll(/from\('([a-z_]+)'\)\.select\('([^']+)'\)/g)) {
      const cols = columnsOf(m[1]); if (!cols) continue;   // table created outside the migrations folder
      // Plain columns only; embedded relations such as vendors(name) are joins, not columns.
      for (const c of m[2].replace(/[a-z_]+!?[a-z_]*\([^)]*\)/g, '').split(',').map((x) => x.trim()).filter((x) => /^[a-z_]+$/.test(x))) { assert.ok(cols.has(c), `${m[1]}.${c} is not defined in any migration`); checked++; }
    }
    assert.ok(checked >= 20, `checked ${checked} columns`);
    assert.ok(columnsOf('library_documents').has('uploaded_at') && !columnsOf('library_documents').has('created_at'));
  });

  console.log('\nOne-time save with selective confidence (option (a): create; idempotent)');
  const SAVE = require('../lib/vendors/proposal_save');
  const crypto = require('crypto');
  const shaOf = (name) => crypto.createHash('sha256').update(Buffer.from(`bytes ${name}`)).digest('hex');
  const SH = { itech: shaOf('itech sept.pdf'), packet: shaOf('packet.pdf'), quote: shaOf('quote 19538.pdf') };
  const savePlan = () => ({
    community_id: fx.community.id, community_name: fx.community.name, storage_mode: 'create',
    bid_request: { title: 'Security Camera System 2026 (Canyon Gate at Cinco Ranch)', service_category: 'security' }, requirements: req,
    approval: { channel: 'chat_instruction', approved_by_label: 'Ed Gojara (chat instruction 2026-10-16)', approved_by_user_id: null, approved_at: '2026-10-16T00:00:00-05:00' },
    proposals: [
      { document_sha256: SH.itech, proposal_key: 'itech-2026-a', mode: 'full', sources: [{ kind: 'email_attachment', mailbox: 'amandaalbright@bedrocktx.com', message_graph_id: 'g-0917', attachment_name: 'iTech_Video Proposal_Sept 2026.pdf', sha256: SH.itech }] },
      { document_sha256: SH.packet, proposal_key: 'itech-2024', mode: 'historical_minimal', replaced_by_key: 'itech-2026-a' },
      { document_sha256: SH.quote, proposal_key: 'envera-q19538-2-standalone', mode: 'proposal_facts_only', duplicates: [{ document_sha256: SH.packet, proposal_key: 'envera-q19538-2-packet', pages: '10-14' }] },
      { document_sha256: SH.packet, proposal_key: 'netwatch-2026', mode: 'proposal_facts_only' },
    ] });
  const envFull = { ...itemOf('envera-q19538-2-packet'), key: 'envera-q19538-2-standalone', document: { ...itemOf('envera-q19538-2-standalone').document } };
  const itemsByDoc = { [SH.itech]: [itemOf('itech-2026-a')], [SH.packet]: [itemOf('itech-2024'), itemOf('netwatch-2026')], [SH.quote]: [envFull] };
  const emptySnap = { bid_requests: [], vendor_proposals: [], vendors: [{ id: 'v-itech', name: 'iTech Monitoring, Inc.', is_active: true }, { id: 'v-other', name: 'iTech Monitoring Services of Texas', is_active: true }], library_documents: [{ id: 'lib-packet', title: 'Security Camera Proposals.pdf', file_hash: SH.packet }] };
  const opts = { mgmtId: 'mgmt', communityName: fx.community.name, today: fx.today, at: '2026-10-16T12:00:00Z' };
  const planned = SAVE.planSave(savePlan(), itemsByDoc, { ...opts, snapshot: emptySnap });
  const insertOf = (ref) => planned.inserts.find((r) => r.ref === ref).row;
  const storedOf = (ref) => insertOf(ref).extracted_data;

  await t('dry-run shape: 1 bid_request (evaluating) + 4 canonical vendor_proposals, 0 vendors, duplicates as references', async () => {
    assert.deepStrictEqual(planned.conflicts, []);
    assert.deepStrictEqual(planned.inserts.map((r) => [r.table, r.ref]), [['bid_requests', 'bid_request'], ['vendor_proposals', 'itech-2026-a'], ['vendor_proposals', 'itech-2024'], ['vendor_proposals', 'envera-q19538-2-standalone'], ['vendor_proposals', 'netwatch-2026']]);
    assert.strictEqual(planned.inserts[0].row.status, 'evaluating'); assert.strictEqual(planned.inserts[0].row.title, 'Security Camera System 2026 (Canyon Gate at Cinco Ranch)');
    assert.match(planned.summary, /^5 insert\(s\) \(1 bid_requests, 4 vendor_proposals\), 0 updates, 0 vendors, 0 uploads, 0 rfp_decision_log$/);
    assert.deepStrictEqual(planned.inserts.filter((r) => r.table === 'vendor_proposals').map((r) => [r.ref, r.row.extracted_data.save_mode, r.row.outcome]), [['itech-2026-a', 'full', 'pending'], ['itech-2024', 'historical_minimal', 'pending'], ['envera-q19538-2-standalone', 'proposal_facts_only', 'expired'], ['netwatch-2026', 'proposal_facts_only', 'pending']]);
    assert.ok(storedOf('envera-q19538-2-standalone').source_documents.some((s) => s.kind === 'duplicate_copy' && s.proposal_key === 'envera-q19538-2-packet' && s.role === 'duplicate'), 'the packet copy of Envera is a reference, not a row');
    assert.ok(planned.inserts.every((r) => r.table !== 'vendors' && !('file_path' in r.row && r.row.file_path)), 'no vendors, no uploads');
    assert.ok(storedOf('netwatch-2026').source_documents.some((s) => s.kind === 'library_document' && s.library_document_id === 'lib-packet'), 'existing library document linked by hash');
    assert.ok(storedOf('itech-2026-a').source_documents.some((s) => s.kind === 'email_attachment' && s.message_graph_id === 'g-0917'));
    assert.ok(storedOf('itech-2026-a').audit.some((a) => a.action === 'approve'), 'audit in the record (no rfp_decision_log)');
  });

  await t('each save mode stores exactly its fields (full / proposal_facts_only / historical_minimal)', async () => {
    const it = (ref) => storedOf(ref).line_item_versions[0].items[0];
    assert.ok(it('itech-2026-a').line_items.length === 23 && it('itech-2026-a').scope_statements.length === 3 && it('itech-2026-a').printed_subtotal_cents === 4461975, 'full keeps reconciled line items');
    assert.deepStrictEqual(Object.keys(it('netwatch-2026')).sort(), ['budgetary', 'document', 'document_date', 'expires_on', 'key', 'model', 'other_terms', 'payment_terms', 'pricing', 'quote_number', 'revision', 'save_mode', 'scope', 'timing', 'vendor_name', 'warranty']);
    assert.deepStrictEqual(Object.keys(it('netwatch-2026').scope).sort(), ['retention_days', 'summary'], 'facts-only: no site list, no counts');
    for (const ref of ['netwatch-2026', 'envera-q19538-2-standalone']) { assert.strictEqual(it(ref).line_items, undefined); assert.ok(!/cameras_(total|new|reused)|licenses/.test(JSON.stringify(it(ref))), `${ref}: no counts stored as facts`); }
    assert.strictEqual(it('netwatch-2026').pricing.unpriced, true);
    assert.deepStrictEqual(it('envera-q19538-2-standalone').pricing.recurring.map((r) => r.monthly_cents), [245354], 'recurring charges kept');
    assert.deepStrictEqual(Object.keys(it('itech-2024')).sort(), ['document', 'document_date', 'key', 'pricing', 'replaced_by', 'save_mode', 'vendor_name']);
    assert.strictEqual(it('itech-2024').replaced_by, 'itech-2026-a');
    assert.throws(() => SAVE.planSave({ ...savePlan(), proposals: [{ ...savePlan().proposals[0], mode: undefined }] }, itemsByDoc, { ...opts, snapshot: emptySnap }), /mode must be one of/, 'a mode is never inferred');
  });

  await t('facts-only and historical rows store no locations and no count fields; full mode is unchanged', async () => {
    // The live Netwatch extraction shape: an inconsistent site list plus count fields in scope.
    const live = { ...itemOf('netwatch-2026'), scope: { summary: 'Netwatch PVM design across Guard House, Club House, and South Gate', locations: ['Guard House', 'Club House', 'South Gate', 'North Gate'], storage: 'Hanwha Wave VMS', retention_days: 30, cameras_total: 30, cameras_new: 29, cameras_reused: 1, licenses: 4, embedded_server_cameras: 0 } };
    const facts = SAVE.project(live, 'proposal_facts_only');
    assert.deepStrictEqual(facts.scope, { summary: 'Netwatch PVM design across Guard House, Club House, and South Gate', storage: 'Hanwha Wave VMS', retention_days: 30 });
    assert.ok(!/locations|North Gate|cameras_|licenses|embedded_server/.test(JSON.stringify(facts)), JSON.stringify(facts));
    const hist = SAVE.project({ ...itemOf('itech-2024'), scope: live.scope }, 'historical_minimal', { replacedBy: 'itech-2026-a' });
    assert.ok(!('scope' in hist) && !/locations|cameras_|licenses/.test(JSON.stringify(hist)));
    const full = SAVE.project(itemOf('itech-2026-a'), 'full');
    assert.deepStrictEqual(full.line_items, itemOf('itech-2026-a').line_items, 'full mode keeps line items');
    assert.deepStrictEqual(full.scope, itemOf('itech-2026-a').scope, 'full mode scope unchanged');
  });

  await t('a chat-instruction approval is recorded as such and never as an authenticated approver', async () => {
    const v = storedOf('itech-2026-a').line_item_versions[0];
    assert.strictEqual(v.status, 'approved');
    assert.deepStrictEqual(v.approval, { channel: 'chat_instruction', approved_by_label: 'Ed Gojara (chat instruction 2026-10-16)', approved_by_user_id: null });
    assert.ok(!('approved_by' in v), 'no authenticated approver field');
    assert.throws(() => V.approveVersion(V.addVersion({}, { items: [], document_sha256: 'x', reason: 'r' }), 1, { approval_channel: 'chat_instruction', approved_by_label: 'Ed', approved_by_user_id: 'u-123' }), /not an authenticated approval/);
    assert.throws(() => SAVE.validatePlan({ ...savePlan(), approval: { ...savePlan().approval, approved_by_user_id: 'u-123' } }), /must be null for a chat instruction/);
  });

  await t('vendors: never created; an exact-name match is reported but not used; a similar name never matches', async () => {
    const m = planned.vendor_matches.find((x) => x.ref === 'itech-2026-a');
    assert.strictEqual(m.vendor_id, null); assert.deepStrictEqual(m.exact_name_candidates, [{ id: 'v-itech', name: 'iTech Monitoring, Inc.' }], '"iTech Monitoring Services of Texas" is not an exact match');
    assert.ok(planned.inserts.filter((r) => r.table === 'vendor_proposals').every((r) => r.row.vendor_id === null));
    const withId = SAVE.planSave({ ...savePlan(), proposals: savePlan().proposals.map((p, i) => (i === 0 ? { ...p, vendor_id: 'v-itech' } : p)) }, itemsByDoc, { ...opts, snapshot: emptySnap });
    assert.strictEqual(withId.inserts.find((r) => r.ref === 'itech-2026-a').row.vendor_id, 'v-itech', 'only an explicit existing id is used');
  });

  await t('idempotent: the simulated second run over the planned rows is "0 inserts, 0 updates, already saved"', async () => {
    const after = SAVE.layerSaved(emptySnap, planned.inserts);
    const second = SAVE.planSave(savePlan(), itemsByDoc, { ...opts, snapshot: after });
    assert.strictEqual(second.summary, '0 inserts, 0 updates, already saved');
    assert.deepStrictEqual(second.inserts, []); assert.deepStrictEqual(second.conflicts, []);
    assert.strictEqual(second.noops.length, 5);
  });

  await t('partial or inconsistent prior state stops with a conflict and ids; nothing is written', async () => {
    const after = SAVE.layerSaved(emptySnap, planned.inserts);
    const partial = { ...after, vendor_proposals: after.vendor_proposals.slice(0, 2) };
    const r1 = SAVE.planSave(savePlan(), itemsByDoc, { ...opts, snapshot: partial });
    assert.deepStrictEqual(r1.inserts, []); assert.match(r1.summary, /^CONFLICT/);
    assert.ok(r1.conflicts.some((c) => /bid_request simulated-bid-request exists with 2 of 4 planned proposals \(partial save\)/.test(c)));
    const otherBid = { ...after, vendor_proposals: after.vendor_proposals.map((r, i) => (i === 0 ? { ...r, bid_request_id: 'some-other-rfp' } : r)) };
    assert.ok(SAVE.planSave(savePlan(), itemsByDoc, { ...opts, snapshot: otherBid }).conflicts.some((c) => /simulated-vp-1 \(itech-2026-a\) is attached to bid_request some-other-rfp/.test(c)));
    const otherMode = { ...after, vendor_proposals: after.vendor_proposals.map((r, i) => (i === 0 ? { ...r, extracted_data: { ...r.extracted_data, save_mode: 'proposal_facts_only' } } : r)) };
    assert.ok(SAVE.planSave(savePlan(), itemsByDoc, { ...opts, snapshot: otherMode }).conflicts.some((c) => /was saved as proposal_facts_only, the plan says full/.test(c)));
    const stray = { ...emptySnap, vendor_proposals: [{ id: 'vp-legacy', community_id: fx.community.id, file_hash: SH.itech, extracted_data: {} }] };
    assert.ok(SAVE.planSave(savePlan(), itemsByDoc, { ...opts, snapshot: stray }).conflicts.some((c) => /vp-legacy has the same source file/.test(c)));
    const B = require('../scripts/save_proposal_data');
    await assert.rejects(B.apply({ from() { throw new Error('must not write'); } }, r1), /refusing to write/);
  });

  await t('name-only similarity never matches an existing proposal: a same-vendor row from another file is ignored', async () => {
    const lookalike = { ...emptySnap, vendor_proposals: [{ id: 'vp-old-itech', community_id: fx.community.id, file_hash: 'f'.repeat(64), vendor_name_raw: 'iTech Monitoring, Inc.', extracted_data: { proposal_key: 'itech-2026-a', save_mode: 'full' } }] };
    const r = SAVE.planSave(savePlan(), itemsByDoc, { ...opts, snapshot: lookalike });
    assert.deepStrictEqual(r.conflicts, []); assert.strictEqual(r.inserts.filter((x) => x.table === 'vendor_proposals').length, 4);
    const otherCommunity = { ...emptySnap, vendor_proposals: [{ id: 'vp-wv', community_id: 'waterview', file_hash: SH.itech, extracted_data: { proposal_key: 'itech-2026-a', save_mode: 'full' } }] };
    assert.deepStrictEqual(SAVE.planSave(savePlan(), itemsByDoc, { ...opts, snapshot: otherCommunity }).conflicts, [], 'another community\'s row with the same file is not this RFP');
  });

  console.log('\nApproved Board exclusion statements (decision level, beside the facts)');
  const NET_ST = 'Netwatch is not a viable current alternative because no executable price was provided and the design incorporates monitoring the Board has said it does not want.';
  const ENV_ST = 'Envera is not recommended because the quote is expired and the package is built around substantial recurring monitoring/service costs the Board has said it does not want.';
  // The live cache v1 Netwatch facts: ownership vendor, monitoring optional, wording without monitoring terms.
  const netLive = { ...itemOf('netwatch-2026'), model: { ownership: 'vendor', monitoring: 'optional', cloud_access: null }, scope: { summary: 'Design site plan for Netwatch Cvedia Analytic Platform and Hanwha VMS installation across Guard House, Club House, and South Gate', retention_days: 30 } };
  const itemsLive = { ...itemsByDoc, [SH.packet]: [itemOf('itech-2024'), netLive] };
  const withStatements = () => { const pl = savePlan(); pl.proposals.find((p) => p.proposal_key === 'netwatch-2026').board_exclusion_statement = NET_ST; pl.proposals.find((p) => p.proposal_key === 'envera-q19538-2-standalone').board_exclusion_statement = ENV_ST; return pl; };

  await t('on already-saved rows a new approved statement is planned as an UPDATE that appends it; extracted facts untouched; user id null', async () => {
    const saved = SAVE.layerSaved(emptySnap, SAVE.planSave(savePlan(), itemsLive, { ...opts, snapshot: emptySnap }).inserts);
    const r = SAVE.planSave(withStatements(), itemsLive, { ...opts, snapshot: saved });
    assert.deepStrictEqual(r.conflicts, []); assert.deepStrictEqual(r.inserts, []);
    assert.deepStrictEqual(r.updates.map((u) => u.ref).sort(), ['envera-q19538-2-standalone', 'netwatch-2026']);
    assert.match(r.summary, /^0 insert\(s\) .*2 update\(s\) \(decision statements appended\)/);
    const u = r.updates.find((x) => x.ref === 'netwatch-2026');
    const before = saved.vendor_proposals.find((x) => x.id === u.id).extracted_data;
    const after = u.patch.extracted_data;
    assert.deepStrictEqual(after.decision_statements, [{ kind: 'board_exclusion_statement', text: NET_ST, approval: { channel: 'chat_instruction', approved_by_label: 'Ed Gojara (chat instruction 2026-10-16)', approved_by_user_id: null }, added_at: '2026-10-16T00:00:00-05:00' }]);
    for (const k of ['line_item_versions', 'comparison_items', 'approved_line_item_version', 'classification', 'save_mode', 'source_documents']) assert.strictEqual(JSON.stringify(after[k]), JSON.stringify(before[k]), `${k} unchanged`);
    assert.match(after.audit.slice(-1)[0].note, /Board exclusion statement added \(approved by Ed Gojara \(chat instruction 2026-10-16\) via chat_instruction\)/);
    // A second run with the same statement is a no-op.
    const again = SAVE.planSave(withStatements(), itemsLive, { ...opts, snapshot: SAVE.layerSaved(saved, [], r.updates) });
    assert.strictEqual(again.summary, '0 inserts, 0 updates, already saved');
    // Any other difference still stops.
    const moved = SAVE.layerSaved(saved, [], r.updates); moved.vendor_proposals = moved.vendor_proposals.map((x) => (x.id === u.id ? { ...x, extracted_data: { ...x.extracted_data, save_mode: 'full' } } : x));
    assert.ok(SAVE.planSave(withStatements(), itemsLive, { ...opts, snapshot: moved }).conflicts.some((c) => /was saved as full/.test(c)));
    const B = require('../scripts/save_proposal_data');
    assert.match(B.describe(r), /UPDATE vendor_proposals simulated-vp-\d+ \[netwatch-2026\]: append extracted_data\.decision_statements .*extracted facts unchanged/);
  });

  await t('the approved statement is used verbatim in the Board summary and RANKING, overriding the computed reasons (which stay internal)', async () => {
    const saved = SAVE.layerSaved(emptySnap, SAVE.planSave(withStatements(), itemsLive, { ...opts, snapshot: emptySnap }).inserts);
    const db = DRY.fakeDb({ ...fx.db_seed, ...(fx.context_seed || {}), vendor_proposals: saved.vendor_proposals.map((r) => ({ ...r, service_category: 'security', created_at: '2026-10-16T12:00:00Z' })), bid_requests: [], library_documents: [] });
    const files = ['packet.pdf', 'quote 19538.pdf', 'itech sept.pdf'].map((n) => ({ filename: n, buffer: Buffer.from(`bytes ${n}`), isPdf: true }));
    const r = await W.prepareComparison({ supabase: db, communityId: fx.community.id, communityName: fx.community.name, email: { ...fx.board_email, id: 'em-1016' }, attachments: files, today: fx.today, mode: 'dry_run', factsDetailed: facts, mgmtId: 'mgmt', greetingName: 'Hugh', extract: async () => { throw new Error('no model call'); } });
    const nw = r.record.ranking.not_viable.find((x) => /Netwatch/.test(x.vendor_name));
    assert.strictEqual(nw.statement, NET_ST);
    assert.ok(nw.reasons.includes('the association would not own the equipment'), 'computed reasons kept for the internal analysis');
    assert.ok(r.summary.includes(NET_ST)); assert.ok(r.summary.includes(ENV_ST));
    assert.ok(!/Netwatch is out:|would not own the equipment/.test(r.summary), 'computed fallback never reaches the Board');
    assert.match(DRY.report({ result: r, facts, extracted: [], writes: [] }), new RegExp(`not viable: Netwatch USA: ${NET_ST.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} \\[approved statement; computed \\(internal\\): `));
    // Without a statement, the same unstable facts fall back to computed reasons (documented behaviour).
    const r0 = C.buildComparisonRecord({ community: fx.community, project: fx.project, proposals: [itemOf('itech-2026-a'), netLive], requirements: req, facts, today: fx.today });
    assert.ok(!r0.ranking.not_viable.find((x) => x.key === 'netwatch-2026').statement);
  });

  await t("the exclusion sentences match Ed's wording exactly", async () => {
    assert.strictEqual(SAVE.exclusionSentence('Netwatch', ['no price provided', 'monitoring-oriented (built around a monitoring service the Board does not want)']), 'Netwatch is not a viable current alternative because no executable price was provided and the design incorporates monitoring the Board has said it does not want.');
    assert.strictEqual(SAVE.exclusionSentence('Envera', ['quote expired 2026-08-31', 'monitoring-heavy ($2,631.42/month in required monitoring services the Board does not want)']), 'Envera is not recommended because the quote is expired and the package is built around substantial recurring monitoring/service costs the Board has said it does not want.');
    assert.strictEqual(SAVE.exclusionSentence('X', ['quote expired 2026-08-31']), null, 'only when the stored facts support the full sentence');
  });

  await t('no site list from an unapproved or excluded vendor reaches the Board summary (internal note only, provisional)', async () => {
    assert.ok(!/does not cover/i.test(run.result.summary));
    assert.ok(!/Rec Center|Resident Exit|Tranquility Park|South Gate/.test(run.result.summary));
    const rv = run.result.record.review.by_proposal['itech-2026-a'];
    assert.ok(rv.weaknesses_risks.some((w) => /^Provisional \(from unapproved extracted site lists/.test(w.text) && w.severity === 'minor' && !w.brief));
  });

  await t('reruns after the save read the approved stored data: no model call, no provisional counts for facts-only proposals', async () => {
    const after = SAVE.layerSaved(emptySnap, planned.inserts);
    const db = DRY.fakeDb({ ...fx.db_seed, ...(fx.context_seed || {}), vendor_proposals: after.vendor_proposals.map((r) => ({ ...r, service_category: 'security', created_at: '2026-10-16T12:00:00Z' })), bid_requests: [], library_documents: [] });
    const files = ['packet.pdf', 'quote 19538.pdf', 'itech sept.pdf'].map((n) => ({ filename: n, buffer: Buffer.from(`bytes ${n}`), isPdf: true }));
    const r = await W.prepareComparison({ supabase: db, communityId: fx.community.id, communityName: fx.community.name, email: { ...fx.board_email, id: 'em-1016' }, attachments: files, today: fx.today, mode: 'dry_run', factsDetailed: facts, mgmtId: 'mgmt', greetingName: 'Hugh', extract: async () => { throw new Error('model must not be called after the save'); } });
    assert.ok(r.extraction_log.every((x) => /^stored v1 \(approved\)/.test(x.source) && x.extracted === false), JSON.stringify(r.extraction_log));
    const st = Object.fromEntries(r.record.proposals.filter((n) => n.status !== 'duplicate').map((n) => [n.vendor_name + ' ' + n.document_date, n.status]));
    assert.deepStrictEqual(st, { 'iTech Monitoring, Inc. 2026-08-19': 'current', 'iTech Monitoring, Inc. 2024-03-28': 'historical', 'Envera Systems 2026-06-05': 'expired', 'Netwatch USA 2026-07-09': 'current' });
    assert.ok(!/provisional:/.test(r.summary), 'no provisional labels in the Board summary');
    assert.deepStrictEqual([...r.summary.matchAll(/\b(\d+) cameras\b/g)].map((m) => m[1]), ['27', '27'], 'only iTech\'s stored, approved count');
    assert.ok(r.summary.includes('Envera is not recommended because the quote is expired'));
    assert.ok(r.summary.includes('Netwatch is not a viable current alternative because no executable price was provided'));
    assert.match(r.summary, /iTech's 2024 proposal is superseded/);
  });

  await t('pluralization: "1 camera proposal from 1 vendor is on file"', async () => {
    const r = build([itemOf('itech-2026-a')]);
    assert.match(C.renderBoardSummary(r, { greetingName: 'Hugh' }), /Situation: 1 camera proposal from 1 vendor is on file/);
    assert.match(run.result.summary, /Situation: 4 camera proposals from 3 vendors are on file/);
  });

  await t("the live cached iTech shape ('3 New Cameras at both A and B' recorded once) reconciles to the table: 27 cameras, certain, reconciliation in the audit", async () => {
    const cachedItem = require('./fixtures/rfp-comparison/itech-2026-cached-v1.json').item;
    const q = LI.computeQuantities({ ...cachedItem, line_items_stored: true });
    assert.deepStrictEqual([q.values.cameras_new, q.values.cameras_reused, q.values.cameras_total, q.values.licenses], [14, 13, 27, 20]);
    assert.deepStrictEqual(q.uncertain, []);
    assert.match(q.reconciliations[0].note, /narrative '3 New Cameras at both the Basketball Pavilion and Guard Shack' \(page 3\) read as 3 at each location; reconciles to the itemized table \(14\)/);
    const r = build([{ ...cachedItem, key: 'cached', line_items_stored: true }]);
    assert.ok(r.audit.some((a) => /RECONCILED: narrative '3 New Cameras at both/.test(a.note)));
    assert.ok(r.open_items.some((i) => i.topic === 'camera schedule and licensing'), 'the camera schedule request stays either way');
    // Neither reading reconciles (table says 12): stays uncertain, quoting the source wording, never "11".
    const odd = JSON.parse(JSON.stringify(cachedItem)); odd.line_items.find((l) => /Turret/.test(l.description)).quantity = 5;
    const q2 = LI.computeQuantities({ ...odd, line_items_stored: true });
    const shown = LI.renderQuantity(q2, 'cameras_new');
    assert.match(shown, /^page 4 table: 12; page 3: 'iTech will Swap out 4 Cameras.*' \/ 'iTech will install 3 New Cameras at both the Basketball Pavilion and Guard Shack/);
    assert.ok(!/\b11\b/.test(shown), 'no derived narrative total is presented as what the document said');
  });

  await t('a first stored extraction is pending approval, not approved; its counts are provisional until the owner approves', async () => {
    const first = V.addVersion({}, { items: [itemOf('itech-2026-a')], document_sha256: 'sha-A', reason: 'initial extraction', requested_by: 'backfill' });
    assert.strictEqual(first.line_item_versions[0].status, 'pending_approval'); assert.strictEqual(V.currentApproved(first), null);
    assert.strictEqual(V.currentUsable(first).version, 1, 'readable (provisional) before approval');
    const it = { ...itemOf('itech-2026-a'), line_items_status: 'pending_approval' };
    assert.match(C.renderBoardSummary(build([it]), { greetingName: 'Hugh' }), /27 cameras \(13 reused, 14 new\) \(provisional: line items pending approval\)/);
    assert.strictEqual(V.addVersion({}, { items: [it], document_sha256: 'x', reason: 'preview extraction', preview: true }).line_item_versions[0].status, 'preview');
  });

  await t('without community records the summary carries no "From ... records" line (nothing invented)', async () => {
    assert.ok(!/records:/.test(summary));
  });

  await t('dry run writes nothing, reuses proposals on file without re-extracting, and extracts only the new document', async () => {
    assert.strictEqual(run.writes.length, 0);
    assert.deepStrictEqual(run.extracted, ['Canyon Gate at Cinco Ranch Qoute 19538.pdf']);
    assert.strictEqual(run.result.record.recommendation.key, 'itech-2026-a');
    assert.strictEqual(run.result.record.proposals.filter((n) => n.status === 'duplicate').length, 5, 're-sent copies and the standalone Envera quote are duplicates');
    assert.strictEqual(run.result.plan.bid_request.op, 'insert'); assert.strictEqual(run.result.plan.bid_request.row.status, 'evaluating');
    assert.ok(run.result.plan.proposals.every((p) => p.op === 'update'), 'proposals already on file are associated, not inserted again');
    assert.match(run.result.block, /COMPARISON \(prepared on the RFP \/ Bid Workflow as a dry run/);
  });

  await t('write mode touches only the workflow tables and never eliminates, finalizes, creates a vendor or posts', async () => {
    const w = await DRY.fixtureRun({ mode: 'write' });
    const tables = [...new Set(w.writes.map((x) => x.table))].sort();
    assert.deepStrictEqual(tables, ['bid_requests', 'rfp_decision_log', 'vendor_comparisons', 'vendor_proposals']);
    for (const x of w.writes) {
      assert.ok(!(x.row && (x.row.is_finalist === true || x.row.eliminated_at || x.row.action === 'eliminate' || x.row.action === 'mark_finalist')), JSON.stringify(x.row).slice(0, 120));
    }
    assert.ok(w.result.written.bid_request_id && w.result.written.comparison_id);
    assert.match(w.result.link, /\?tab=vendor&rfp=/);
  });

  await t('a vendor missing from Vendor 360 never blocks the comparison (vendor_id stays null, name kept)', async () => {
    const r = await W.resolveVendorReadOnly(fakeDb({ vendors: [] }), 'Netwatch USA', 'mgmt');
    assert.strictEqual(r.vendor_id, null); assert.strictEqual(r.method, 'unresolved');
    const n = run.result.record.proposals.find((x) => x.key === 'netwatch-2026');
    assert.strictEqual(n.vendor_resolution.vendor_id, null);
    assert.ok(run.result.record.proposals.find((x) => x.key === 'itech-2026-a').vendor_resolution.vendor_id, 'iTech resolves by name');
  });

  await t('the live dry run is read-only: the guard throws on any write', async () => {
    const guarded = DRY.readOnly({ from: () => ({ insert() {}, update() {}, upsert() {}, delete() {}, select() { return 'ok'; } }), rpc() {}, storage: { from: () => ({}) } });
    assert.throws(() => guarded.from('bid_requests').insert({}), /read-only/);
    assert.throws(() => guarded.rpc('x'), /read-only/);
    assert.strictEqual(guarded.from('bid_requests').select(), 'ok');
  });

  await t('mode off does no comparison work; default mode is dry_run', async () => {
    assert.strictEqual((await W.prepareComparison({ mode: 'off' })).is_matter, false);
    env({ AMANDA_RFP_WORKFLOW: null }, () => assert.strictEqual(W.workflowMode(), 'dry_run'));
  });

  await t("Amanda's board replies run the comparison, give her the block, and check certainty against the data confidence", async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'community', 'amanda_reply.js'), 'utf8');
    assert.ok(/require\('\.\.\/vendors\/rfp_workflow'\)\.prepareComparison\(/.test(src));
    assert.ok(/comparison\.block/.test(src));
    assert.ok(/confidence: factsDetailed \? \{ mode: factsDetailed\.mode, cash_label: factsDetailed\.cash_label \}/.test(src));
    assert.ok(/PROPOSALS AND COMPETING BIDS/.test(D.DECISION_READY_RULE) && /DATA CONFIDENCE/.test(D.DECISION_READY_RULE));
    assert.ok(/\?tab=vendor&rfp=/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'vendors', 'rfp_workflow.js'), 'utf8')));
    assert.ok(/get\('rfp'\)/.test(fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')), 'the Board link opens the comparison');
  });

  await t('extractor fallback: a missing price is proposed from the largest dollar amount and flagged for review', async () => {
    const X = require('../lib/vendors/proposal_extract');
    assert.strictEqual(X.largestDollarCents('Subtotal $38,211.02 deposit $19,105.51'), 3821102);
    const fake = { messages: { create: async () => ({ content: [{ text: '{"proposals":[{"vendor_name":"Acme","pricing":{"upfront_cents":null,"recurring":[]}}]}' }] }) } };
    const r = await X.extractProposals(Buffer.from('pdf'), { filename: 'acme.pdf' }, { anthropic: fake, pdfText: 'Total $12,500.00' });
    assert.strictEqual(r.items[0].pricing.upfront_cents, 1250000); assert.match(r.items[0].needs_review, /fallback/);
    const broken = { messages: { create: async () => { throw new Error('overloaded'); } } };
    const r2 = await X.extractProposals(Buffer.from('pdf'), { filename: 'b.pdf' }, { anthropic: broken, pdfText: 'x' });
    assert.strictEqual(r2.items.length, 0); assert.match(JSON.stringify(r2.diagnostic.invalid), /overloaded/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
