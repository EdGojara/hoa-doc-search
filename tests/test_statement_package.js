// tests/test_statement_package.js  (Ed 2026-10-09, month-end close PR C)
// The financial statement package on the Drama Creek Estates fixture (demo
// community, sample figures): the statement model, the ONE renderer, drill-down
// ties, exports, the native board-packet snapshot, and the final / distribute
// gate on unmapped balance-sheet accounts with its owner override.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'; process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test';
const Module = require('module');
const F = require('./fixtures/drama_creek_statements');
const realLoad = Module._load;
Module._load = function (r) { if (r === '@supabase/supabase-js') return { createClient: () => F.fakeClient() }; return realLoad.apply(this, arguments); };
const M = require('../lib/statements/model');
const R = require('../lib/statements/render');
const D = require('../lib/statements/drill');
const X = require('../lib/statements/export');
const SNAP = require('../lib/statements/snapshot');
const { proposeFromRoles } = require('../scripts/propose_balance_sheet_mapping');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); } };
const NOW = new Date('2026-10-09T18:00:00Z');
const find = (model, num) => { for (const s of model.sections) for (const g of s.groups) for (const l of g.lines) if (l.account_number === String(num)) return { s, g, l }; return null; };

(async () => {
  F.seed(); const sb = F.fakeClient();
  const bs = await M.buildBalanceSheetModel(sb, { community_id: F.CID, as_of: '2026-09-30', now: NOW });
  const ib = await M.buildIncomeBudgetModel(sb, { community_id: F.CID, period_end: '2026-09-30', fund: 'OPR', now: NOW });

  console.log('balance sheet model');
  check('versioned model', bs.model_version === 'trusted.statement.v1' && bs.kind === 'balance_sheet');
  check('balanced in every available column', bs.totals.balanced.current === true && bs.totals.balanced.prior_month === true, JSON.stringify(bs.totals.balanced));
  check('every column ties to the statement engine', bs.engine_tie.every((t) => t.ties), JSON.stringify(bs.engine_tie));
  const eq = bs.sections.find((s) => s.key === 'equity');
  check('fund balance: beginning + current-year activity = total, and = the engine, in every column', eq.tie_out.every((t) => t.ties) && eq.total.values.current === eq.fund_balance.beginning.values.current + eq.fund_balance.current_year_activity.values.current);
  const pye = bs.columns.find((c) => c.key === 'prior_year_end');
  check('prior year end before the books begin is n/a (null), never $0', pye.available === false && bs.totals.assets.prior_year_end === null && find(bs, 1000).l.values.prior_year_end === null && /begin/.test(pye.reason));
  check('the n/a column is null all the way down (no 0 anywhere in it)', bs.sections.every((s) => s.groups.every((g) => g.values.prior_year_end === null && g.lines.every((l) => l.values.prior_year_end === null))));
  const unm = bs.sections[0].groups.find((g) => g.kind === 'unmapped');
  check('a proposed and an unmapped account present under Unmapped, included in totals', unm && unm.lines.length === 2 && unm.lines.some((l) => l.mapping.status === 'proposed' && l.mapping.proposed_category) && unm.lines.some((l) => l.mapping.status === 'unmapped'));
  check('assets total includes Unmapped', bs.totals.assets.current === bs.sections[0].groups.reduce((t, g) => t + g.values.current, 0));
  check('unmapped accounts raise a warning; mapping is not final-ready', bs.warnings.some((w) => w.code === 'unmapped_accounts' && w.count === 2) && bs.mapping.final_ready === false && bs.mapping.unmapped.length === 2);
  check('categories come only from APPROVED mappings (the proposal does not group)', !bs.sections[0].groups.some((g) => g.kind === 'category' && g.lines.some((l) => l.account_number === '1405')));
  check('lifecycle: September is DRAFT, closed through 8/31', bs.lifecycle.status === 'draft' && /DRAFT/.test(bs.lifecycle.label) && /8\/31\/2026/.test(bs.lifecycle.note));
  const aug = await M.buildBalanceSheetModel(sb, { community_id: F.CID, as_of: '2026-08-31', now: NOW });
  check('lifecycle: August is closed, with who and when from the close record', aug.lifecycle.status === 'closed' && aug.lifecycle.label === 'Closed through 8/31/2026' && aug.lifecycle.closed_by === 'Association Manager' && aug.lifecycle.closed_at);
  const fv = await M.buildBalanceSheetModel(sb, { community_id: F.CID, as_of: '2026-09-30', view: 'fund', now: NOW });
  check('fund view: a column per fund plus total; funds add to the total and tie to the engine', fv.columns.map((c) => c.key).join() === 'fund:OPR,fund:RES,total' && fv.totals.assets['fund:OPR'] + fv.totals.assets['fund:RES'] === fv.totals.assets.total && fv.engine_tie.every((t) => t.ties));
  check('the snapshot hash is stable across a JSON round trip (what a packet stores re-verifies)', M.modelSha(JSON.parse(JSON.stringify(bs))) === bs.snapshot_sha256);
  check('the snapshot hash changes when a value changes', (() => { const c = JSON.parse(JSON.stringify(bs)); c.totals.assets.current += 1; return M.modelSha(c) !== bs.snapshot_sha256; })());

  console.log('income vs budget model');
  check('prior-year columns hidden (2025 not in trustEd), with the reason', !ib.columns.some((c) => c.key.startsWith('py_')) && ib.notes.some((n) => n.code === 'prior_year_hidden'));
  check('year to date includes the conversion carryforward, and says so', ib.carryforward && ib.carryforward.revenue > 0 && ib.notes.some((n) => n.code === 'carryforward'));
  check('net income: month 1,895 vs budget 2,225, variance (330) unfavorable, (14.8%)', ib.net.values.mtd_actual === 189500 && ib.net.values.mtd_budget === 222500 && ib.net.values.mtd_var === -33000 && ib.net.values.mtd_var_pct === -14.8);
  const land = ib.sections[1].groups.find((g) => g.label === 'Landscaping');
  check('variance is favorable-positive: expense over budget is negative', land.values.mtd_var === -70000 && ib.sections[0].total.values.mtd_var > 0);
  check('a group\'s figures add up from its accounts', land.values.ytd_actual === land.lines.reduce((t, l) => t + l.values.ytd_actual, 0));

  console.log('the one renderer');
  const web = R.renderHtml(bs, { mode: 'web' }); const pr = R.renderHtml(bs, { mode: 'print' });
  check('n/a renders as n/a (titled), distinct from zero', /<span class="na" title="Not available in TrustEd">n\/a<\/span>/.test(web) && R.money(0).text === '–' && R.money(null).text === 'n/a');
  check('negatives in parentheses; print rounds to whole dollars', R.money(-123456).text === '(1,234.56)' && R.money(-123456, { whole: true }).text === '(1,235)');
  check('a null never renders as $0 / 0.00', !/>\$?0(\.00)?</.test(pr) && !/>\$?0(\.00)?</.test(web));
  check('percent with no budget is n/m; with no actual is n/a', R.percent(null, { varCents: 500 }).text === 'n/m' && R.percent(null, { varCents: null }).text === 'n/a');
  check('web: every account line carries its drill target', (web.match(/data-drill=/g) || []).length > 20 && /&quot;level&quot;:&quot;account&quot;/.test(web));
  check('print: categories only, but unmapped accounts are always listed', /Utility Deposits/.test(pr) && /Gate Project Escrow/.test(pr) && !/Operating Checking/.test(pr));
  check('the rendered statement carries its model version and snapshot', web.includes(`data-snapshot="${bs.snapshot_sha256}"`) && web.includes('data-model-version="trusted.statement.v1"'));
  check('draft banner on an open period', /DRAFT – PERIOD NOT CLOSED/.test(pr));
  const doc = R.renderDocument([bs, ib]);
  check('the PDF document is the same renderer (print mode), Letter, one statement per page', /@page\{size:Letter/.test(doc) && /class="pb"/.test(doc) && doc.includes(bs.snapshot_sha256));

  console.log('drill-down: line -> GL -> transactions -> source');
  const cash = find(bs, 1000).l;
  const dCash = await D.drillAccount(sb, { community_id: F.CID, kind: 'balance_sheet', account_id: cash.account_id, fund_id: cash.fund_id, as_of: '2026-09-30' });
  check('balance-sheet account: the transactions add up to the statement figure', dCash.total_cents === cash.values.current, `${dCash.total_cents} vs ${cash.values.current}`);
  check('cash account: bank statements shown as evidence', dCash.bank_evidence && dCash.bank_evidence.statements.length === 1);
  const irr = find(ib, 5210).l;
  const dM = await D.drillAccount(sb, { community_id: F.CID, kind: 'income_budget', account_id: irr.account_id, fund_id: irr.fund_id, period_start: '2026-09-01', period_end: '2026-09-30' });
  const dY = await D.drillAccount(sb, { community_id: F.CID, kind: 'income_budget', account_id: irr.account_id, fund_id: irr.fund_id, period_start: '2026-01-01', period_end: '2026-09-30' });
  check('income account, month: ties to month actual and never shows the conversion carryforward', dM.total_cents === irr.values.mtd_actual && !dM.transactions.some((t) => t.is_opening_carryforward));
  check('income account, year to date: ties to YTD actual and flags the carried line', dY.total_cents === irr.values.ytd_actual && dY.transactions.some((t) => t.is_opening_carryforward));
  const inv = dM.transactions.find((t) => /INV-4471|JE-2026-00412/.test(`${t.reference} ${t.description}`)) || dM.transactions[0];
  const src = await D.drillEntry(sb, { community_id: F.CID, journal_entry_id: inv.journal_entry_id });
  check('transaction -> source: the entry summary (origin, accounting lines)', src.journal_entry_id === inv.journal_entry_id && Array.isArray(src.accounting) && src.accounting.length >= 2 && src.origin);
  let refused = null; try { await D.drillEntry(sb, { community_id: 'another-community', journal_entry_id: inv.journal_entry_id }); } catch (e) { refused = e.code; }
  check('an entry of another community is refused (not_found)', refused === 'not_found');

  console.log('exports');
  const XLSX = require('xlsx');
  const wb = XLSX.read(X.xlsxBuffer([bs, ib]), { type: 'buffer', cellNF: true });
  const sh = wb.Sheets[wb.SheetNames[0]]; const aoa = XLSX.utils.sheet_to_json(sh, { header: 1 });
  const totRow = aoa.find((r) => r[0] === 'Total assets');
  check('XLSX: one sheet per statement; real numbers in dollars; n/a stays text', wb.SheetNames.length === 2 && totRow && totRow[1] === bs.totals.assets.current / 100 && totRow[3] === 'n/a');
  check('XLSX: money cells carry the parentheses / dash number format', Object.values(sh).some((c) => c && c.t === 'n' && /\(#,##0\.00\)/.test(c.z || '')));
  const csv = X.csvDetail(await D.detailRows(sb, bs));
  check('CSV detail: header + a row per transaction behind the statement', csv.startsWith('section,category,account_number') && csv.split('\r\n').length > 20);

  console.log('board-packet snapshot');
  const snap = await SNAP.buildSectionSnapshot(sb, { community_id: F.CID, section_key: 'balance_sheet', cutoff: '2026-09-30', now: NOW });
  check('stores the versioned model, not HTML', snap.source === 'trusted_statement_model' && snap.model_version === 'trusted.statement.v1' && snap.models[0].kind === 'balance_sheet' && !/<table/.test(JSON.stringify(snap)));
  const stored = JSON.parse(JSON.stringify(snap));
  check('a stored snapshot re-verifies (intact after a JSON round trip)', SNAP.snapshotIntact(stored));
  const tampered = JSON.parse(JSON.stringify(snap)); tampered.models[0].totals.assets.current += 100;
  check('an altered snapshot is detected', !SNAP.snapshotIntact(tampered));
  const isnap = await SNAP.buildSectionSnapshot(sb, { community_id: F.CID, section_key: 'income_statement', cutoff: '2026-09-30', now: NOW });
  check('income statement snapshot: one model per fund with activity, Operating first', isnap.models.length >= 1 && isnap.models[0].fund === 'OPR' && isnap.models.every((m) => m.kind === 'income_budget'));
  check('re-rendering a stored snapshot reproduces the same statement', R.renderHtml(stored.models[0], { mode: 'embed' }) === R.renderHtml(snap.models[0], { mode: 'embed' }));

  console.log('final / distribute gate (through the real board-packet routes)');
  const { BEDROCK_MGMT_CO_ID } = require('../lib/company');
  const adm = require('../api/_require_admin');
  let ownerOk = false; adm.requireOwner = async (req, res) => { if (ownerOk) return { email: 'owner@example.test', full_name: 'Owner', user: { id: null } }; res.status(403).json({ error: 'owner_only' }); return null; };
  const bp = require('../api/board_packets');
  const db = F.getDb();
  db.board_packets = [{ id: 'pk-1', community_id: F.CID, management_company_id: BEDROCK_MGMT_CO_ID, status: 'draft' }];
  db.board_packet_sections = [{ id: 's-bs', packet_id: 'pk-1', section_key: 'balance_sheet', input_data: stored, status: 'ready' }, { id: 's-is', packet_id: 'pk-1', section_key: 'income_statement', input_data: JSON.parse(JSON.stringify(isnap)), status: 'ready' }];
  db.statement_mapping_overrides = []; db.board_packet_distribution_log = [];
  const route = (method, path) => bp.router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]).route.stack.slice(-1)[0].handle;
  const call = async (method, path, params, body) => { let out = { status: 200 }; const res = { status(c) { out.status = c; return res; }, json(j) { out.body = j; return res; }, set() { return res; }, send(b) { out.body = b; return res; } }; await route(method, path)({ params, body, query: {}, headers: {} }, res); return out; };

  const toReview = await call('patch', '/:id', { id: 'pk-1' }, { status: 'in_review' });
  check('a draft / in-review move is never blocked by unmapped accounts', toReview.status === 200 && db.board_packets[0].status === 'in_review');
  const toFinal = await call('patch', '/:id', { id: 'pk-1' }, { status: 'final' });
  check('marking final with unmapped balance-sheet accounts is refused (409), naming them', toFinal.status === 409 && toFinal.body.error === 'statement_not_final_ready' && toFinal.body.blockers[0].unmapped.length === 2 && db.board_packets[0].status === 'in_review', JSON.stringify(toFinal.body).slice(0, 300));
  const dist = await call('post', '/:id/distribute', { id: 'pk-1' }, { recipients: ['board@example.test'], method: 'email' });
  check('distributing is refused the same way (nothing logged, status unchanged)', dist.status === 409 && db.board_packet_distribution_log.length === 0 && db.board_packets[0].status === 'in_review');
  const gate = await call('get', '/:id/statement-gate', { id: 'pk-1' });
  check('the gate is readable for the UI', gate.status === 200 && gate.body.ok === false && gate.body.open.length === 1);
  const notOwner = await call('post', '/:id/statement-mapping-override', { id: 'pk-1' }, { section_key: 'balance_sheet', reason: 'Escrow classification pending CPA review' });
  check('a non-owner cannot override (403)', notOwner.status === 403 && db.statement_mapping_overrides.length === 0);
  ownerOk = true;
  const short = await call('post', '/:id/statement-mapping-override', { id: 'pk-1' }, { section_key: 'balance_sheet', reason: 'ok' });
  check('an override needs a written reason', short.status === 400);
  const ov = await call('post', '/:id/statement-mapping-override', { id: 'pk-1' }, { section_key: 'balance_sheet', reason: 'Escrow classification pending CPA review' });
  check('the owner records an override bound to this exact snapshot, listing the accounts', ov.status === 200 && db.statement_mapping_overrides.length === 1 && db.statement_mapping_overrides[0].snapshot_sha256 === stored.snapshot_sha256 && db.statement_mapping_overrides[0].unmapped_accounts.length === 2);
  const toFinal2 = await call('patch', '/:id', { id: 'pk-1' }, { status: 'final' });
  check('with the owner override the packet can be marked final', toFinal2.status === 200 && db.board_packets[0].status === 'final');
  // Pulling the section again makes a new snapshot: the old override no longer applies.
  db.board_packets[0].status = 'in_review';
  const repulled = await SNAP.buildSectionSnapshot(sb, { community_id: F.CID, section_key: 'balance_sheet', cutoff: '2026-09-30', now: new Date('2026-10-10T09:00:00Z') });
  db.board_packet_sections[0].input_data = JSON.parse(JSON.stringify(repulled));
  const toFinal3 = await call('patch', '/:id', { id: 'pk-1' }, { status: 'final' });
  check('an override does not carry to a re-pulled statement (new snapshot = blocked again)', repulled.snapshot_sha256 !== stored.snapshot_sha256 && toFinal3.status === 409);
  db.board_packet_sections[0].input_data = tampered;
  const toFinal4 = await call('patch', '/:id', { id: 'pk-1' }, { status: 'final' });
  check('an altered snapshot blocks finalizing', toFinal4.status === 409 && toFinal4.body.blockers.some((b) => b.problem === 'snapshot_altered'));
  // Mapping approved -> no blocker.
  for (const m of db.account_report_map) if (m.statement === 'balance_sheet' && m.approval_status !== 'approved') { m.approval_status = 'approved'; m.approved_by = 'Ed'; m.approved_at = '2026-10-10T00:00:00Z'; }
  const cat1415 = db.report_categories.find((c) => c.statement === 'balance_sheet' && c.section === 'asset');
  if (!db.account_report_map.some((m) => m.account_id === F.aid(1415) && m.statement === 'balance_sheet')) db.account_report_map.push({ community_id: F.CID, account_id: F.aid(1415), statement: 'balance_sheet', category_id: cat1415.id, approval_status: 'approved', approved_by: 'Ed', approved_at: '2026-10-10T00:00:00Z' });
  const mapped = await SNAP.buildSectionSnapshot(sb, { community_id: F.CID, section_key: 'balance_sheet', cutoff: '2026-09-30', now: NOW });
  db.board_packet_sections[0].input_data = JSON.parse(JSON.stringify(mapped));
  const toFinal5 = await call('patch', '/:id', { id: 'pk-1' }, { status: 'final' });
  check('once every account is mapped and approved, final needs no override', mapped.models[0].mapping.final_ready === true && toFinal5.status === 200);

  console.log('board-packet section renders through the shared renderer');
  const html = bp.renderSectionStandaloneHtml({ packet: { community: { name: 'Drama Creek Estates' }, period_label: 'September 2026' }, section: { section_key: 'balance_sheet', input_data: stored }, embed: true });
  check('native snapshot section = the shared renderer\'s statement (same snapshot id)', html.includes(`data-snapshot="${stored.models[0].snapshot_sha256}"`) && html.includes('class="tstmt print"'));
  const legacy = bp.renderSectionStandaloneHtml({ packet: { community: {} }, section: { section_key: 'income_statement', input_data: { statement: { rows: [] }, source: 'trusted_gl' } }, embed: true });
  check('an old native fill (raw engine result) says to pull again instead of rendering an empty statement', /needs to be pulled again/.test(legacy));

  console.log('mapping proposals (durable roles only)');
  const accts = [{ id: 'a1', account_number: '1000', account_name: 'Anything', account_type: 'asset' }, { id: 'a2', account_number: '1200', account_name: 'Reserve-ish name', account_type: 'asset' },
    { id: 'a3', account_number: '1400', account_name: 'Prepaid Insurance', account_type: 'asset' }, { id: 'a4', account_number: '2205', account_name: 'X', account_type: 'liability' },
    { id: 'a5', account_number: '3050', account_name: 'Y', account_type: 'equity' }, { id: 'a6', account_number: '1300', account_name: 'Accounts Receivable', account_type: 'asset' }];
  const pr2 = proposeFromRoles({ accounts: accts, banks: [{ gl_account_number: '1000', account_type: 'operating' }, { gl_account_number: '1200', account_type: 'reserve' }],
    schedules: [{ schedule_type: 'prepaid_expense', balance_account_number: '1400' }, { schedule_type: 'deferred_revenue', balance_account_number: '2205' }], existing: new Set() });
  const roleOf = (n) => (pr2.proposals.find((p) => p.account.account_number === n) || {}).role;
  check('bank links, recognition schedules and equity type propose categories', roleOf('1000') === 'cash' && roleOf('1200') === 'reserve' && roleOf('1400') === 'prepaid' && roleOf('2205') === 'deferred' && roleOf('3050') === 'fund_balance');
  check('nothing is inferred from an account name (AR stays for a person)', !roleOf('1300'));
  const pr3 = proposeFromRoles({ accounts: accts, banks: [{ gl_account_number: '1000', account_type: 'operating' }, { gl_account_number: '1000', account_type: 'reserve' }], schedules: [], existing: new Set(['a5']) });
  check('two roles that disagree are a conflict, not a guess; an existing mapping is never touched', pr3.conflicts.some((c) => c.account.id === 'a1') && !pr3.proposals.some((p) => p.account.id === 'a5'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.stack); process.exit(1); });
