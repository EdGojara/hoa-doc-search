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
    assert.strictEqual(byKey['itech-2026-a'].recurring[0].counted, true, 'optional plan counted: it is the only way to get the cloud access the Board asked for');
    assert.match(byKey['itech-2026-a'].recurring[0].counted_reason, /cloud access/);
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

  await t('an extraction that fails validation is reported in the trail, never silently compared', async () => {
    const bad = { key: 'bad', vendor_name: '', document: { filename: 'x.pdf' }, pricing: {} };
    const r = C.buildComparisonRecord({ community: fx.community, project: fx.project, proposals: [...fx.proposals, bad], requirements: req, facts, today: fx.today });
    assert.ok(!r.proposals.some((n) => n.key === 'bad'));
    assert.ok(r.audit.some((a) => a.proposal_key === 'bad' && /failed validation/.test(a.note)));
  });

  const summary = C.renderBoardSummary(record, { greetingName: 'Hugh', link: 'https://my.bedrocktxai.com/?tab=vendor&rfp=00000000-0000-0000-0000-000000000000' });
  await t('the Board email is a short decision-ready summary that links to the comparison and passes every check', async () => {
    for (const label of ['Situation:', 'Recommendation:', 'Why:', 'Open items before signing:', 'Action underway:', 'Board decision needed:']) assert.ok(summary.includes(label), label);
    assert.match(summary, /\$47,854\.68/); assert.match(summary, /\$74,255/); assert.match(summary, /expired/); assert.match(summary, /rfp=/);
    assert.match(summary, /provisional/, 'the material limitation is stated once');
    assert.strictEqual((summary.match(/provisional/g) || []).length, 1, 'no repetitive disclaimers');
    assert.ok(!/which (?:proposal|one) is current|would you like me to|let me know how|shall I compare|I will check/i.test(summary));
    assert.ok(!/funds are (?:definitively )?available|fully funded/i.test(summary));
    assert.deepStrictEqual(D.checkDecisionReady(summary, { confidence: { mode: 'transition', cash_label: 'provisional' } }), { ok: true, issues: [] });
    assert.ok(summary.split(/\s+/).length < 400, `summary is concise (${summary.split(/\s+/).length} words)`);
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
    assert.match(c.contract_readiness.label, /^not ready to sign, \d+ items outstanding$/);
    assert.match(summary, /Vendor: iTech is the preferred vendor\. Project: proceed\. Contract: not ready to sign/);
  });

  console.log('\nWorkflow orchestration (fixture replay, no production writes)');
  const run = await DRY.fixtureRun({ mode: 'dry_run' });
  await t('community context: cites Canyon Gate records that bear on the decision, with source tags', async () => {
    const used = run.result.record.review.by_proposal['itech-2026-a'].community_context_used;
    for (const src of fx.expected.review.context_sources) assert.ok(used.some((u) => u.source === src), src);
    assert.ok(used.every((u) => /^trustEd:/.test(u.source)));
    assert.match(run.result.summary, /From Canyon Gate records: on an annual run-rate basis, Security Services \(\$235,000\/yr\) less the United Protective and Gate Sentry contracts leaves about \$11,610\/yr, enough for the plan's \$5,280\/yr \(this is not the amount remaining in this year's budget\).*no camera contract is on file.*reserve study has no camera component.*leaning toward iTech/);
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
    assert.match(summary, /about \$222,329 over 5 years with estimated tax/);
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
