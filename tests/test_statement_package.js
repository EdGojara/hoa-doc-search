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
  check('unmapped accounts raise a warning; mapping is not complete', bs.warnings.some((w) => w.code === 'unmapped_accounts' && w.count === 2) && bs.mapping.mapping_complete === false && bs.mapping.unmapped.length === 2);
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
  check('net income: month 1,895 vs budget 2,225, variance (330) unfavorable; no percentage columns (board layout)', ib.net.values.mtd_actual === 189500 && ib.net.values.mtd_budget === 222500 && ib.net.values.mtd_var === -33000 && !ib.columns.some((c) => c.is_pct) && ib.net.values.mtd_var_pct === undefined);
  check('board layout: seven columns (month actual/budget/variance, YTD actual/budget/variance, annual budget) in that order', ib.columns.map((c) => c.key).join() === 'mtd_actual,mtd_budget,mtd_var,ytd_actual,ytd_budget,ytd_var,annual_budget' && ib.columns.map((c) => c.band).join() === 'Current month,Current month,Current month,Year to date,Year to date,Year to date,Annual');
  check('annual budget totals add up from the accounts', ib.sections.every((sec) => sec.total.values.annual_budget === sec.groups.reduce((t, g) => t + (g.values.annual_budget || 0), 0)) && ib.net.values.annual_budget === ib.sections[0].total.values.annual_budget - ib.sections[1].total.values.annual_budget);
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
  const snap = await SNAP.buildSectionSnapshot(sb, { community_id: F.CID, section_key: 'balance_sheet', cutoff: '2026-08-31', now: NOW });
  check('stores the versioned model, not HTML', snap.source === 'trusted_statement_model' && snap.model_version === 'trusted.statement.v1' && snap.models[0].kind === 'balance_sheet' && !/<table/.test(JSON.stringify(snap)));
  const stored = JSON.parse(JSON.stringify(snap));
  check('a stored snapshot re-verifies (intact after a JSON round trip)', SNAP.snapshotIntact(stored));
  const tampered = JSON.parse(JSON.stringify(snap)); tampered.models[0].totals.assets.current += 100;
  check('an altered snapshot is detected', !SNAP.snapshotIntact(tampered));
  const isnap = await SNAP.buildSectionSnapshot(sb, { community_id: F.CID, section_key: 'income_statement', cutoff: '2026-08-31', now: NOW });
  check('income statement snapshot: one model per fund with activity, Operating first', isnap.models.length >= 1 && isnap.models[0].fund === 'OPR' && isnap.models.every((m) => m.kind === 'income_budget'));
  check('re-rendering a stored snapshot reproduces the same statement', R.renderHtml(stored.models[0], { mode: 'embed' }) === R.renderHtml(snap.models[0], { mode: 'embed' }));

  console.log('final / distribute gate (through the real board-packet routes)');
  // These snapshots are pulled for August (CLOSED in the fixture), so they isolate the MAPPING rule;
  // the closed-period rule has its own tests below.
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
  check('marking final with unmapped balance-sheet accounts is refused (409), naming them', toFinal.status === 409 && toFinal.body.error === 'packet_not_finalizable' && toFinal.body.blockers[0].unmapped.length === 2 && db.board_packets[0].status === 'in_review', JSON.stringify(toFinal.body).slice(0, 300));
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
  console.log('stable snapshot hash: statement content only');
  db.board_packets[0].status = 'in_review';
  const later = await SNAP.buildSectionSnapshot(sb, { community_id: F.CID, section_key: 'balance_sheet', cutoff: '2026-08-31', now: new Date('2026-10-12T09:00:00Z') });
  check('a re-pull of unchanged books at a later time hashes the same (generation time excluded)', later.snapshot_sha256 === stored.snapshot_sha256 && later.generated_at !== stored.generated_at && later.models[0].generated_at !== stored.models[0].generated_at);
  const base = stored.models[0]; const H = base.snapshot_sha256;
  const variant = (fn, m = base) => { const c = JSON.parse(JSON.stringify(m)); fn(c); return M.modelSha(c); };
  const lineOf = (m, num) => { for (const sec of m.sections) for (const g of sec.groups) for (const l of g.lines) if (l.account_number === String(num)) return l; return null; };
  check('hash = the statement content only: the same content at a later generation time hashes the same', variant((c) => { c.generated_at = '2031-05-05T05:05:05Z'; }) === H);
  check('refreshed signed URLs / tokens / expiries / links anywhere in the model do not move the hash', variant((c) => {
    c.signed_url = 'https://x.test/a?token=1'; c.access_token = 'tok-2'; c.expires_at = '2031-01-01';
    Object.assign(lineOf(c, 1000), { signed_url: 'https://x.test/b?sig=9', document: { href: '/api/documents/7/preview', token: 'z', expires_at: '2031-01-02' } });
    lineOf(c, 1000).drill.url = '/api/financial-statements/x/drill';
  }) === H);
  check('a changed amount changes the hash', variant((c) => { lineOf(c, 1000).values.current += 1; }) !== H);
  check('a changed account label changes the hash', variant((c) => { lineOf(c, 1000).account_name = 'Operating Checking (renamed)'; }) !== H);
  check('a changed category label changes the hash', variant((c) => { c.sections[0].groups[0].label = 'Cash'; }) !== H);
  check('a changed mapping (account moved to another category) changes the hash', variant((c) => { const g = c.sections[0].groups; const l = g[0].lines.shift(); g[1].lines.push(l); }) !== H);
  check('n/a changing to zero changes the hash', lineOf(base, 1000).values.prior_year_end === null && variant((c) => { lineOf(c, 1000).values.prior_year_end = 0; }) !== H);
  check('an unmapped account becoming mapped changes the hash', variant((c) => { lineOf(c, 1415).mapping = { status: 'approved' }; c.mapping.unmapped = c.mapping.unmapped.filter((u) => u.account_number !== '1415'); }) !== H);
  check('a different period changes the hash', variant((c) => { c.period.as_of = '2026-10-31'; }) !== H);
  const ibm = isnap.models[0];
  check('a different fund scope changes the hash', ibm.fund === 'OPR' && variant((c) => { c.fund = 'RES'; }, ibm) !== ibm.snapshot_sha256);
  check('a budget / variance change changes the hash', variant((c) => { c.net.values.mtd_budget += 100; }, ibm) !== ibm.snapshot_sha256);
  check('a carryforward change changes the hash', variant((c) => { c.carryforward.revenue += 1; }, ibm) !== ibm.snapshot_sha256);
  check('a close-status change changes the hash', variant((c) => { c.lifecycle.status = 'closed'; c.lifecycle.label = 'Closed through 9/30/2026'; }) !== H);
  // Schema completeness: every key the model carries is either hashed content or
  // deliberately excluded, so new financial content can never escape the hash.
  const paths = (v, pre, out) => { if (Array.isArray(v)) v.forEach((x) => paths(x, pre, out)); else if (v && typeof v === 'object') for (const k of Object.keys(v)) { const pth = pre ? `${pre}.${k}` : k; if (/(^|\.)values$/.test(pre)) continue; out.add(pth); paths(v[k], pth, out); } return out; };
  const content = new Set(); for (const m of [base, ibm, fv]) paths(M.statementContent(JSON.parse(JSON.stringify(m))), '', content);
  const modelKeys = new Set(); for (const m of [base, ibm, fv]) paths(JSON.parse(JSON.stringify(m)), '', modelKeys);
  const escaped = [...modelKeys].filter((k) => !content.has(k) && !M.HASH_EXCLUDED.some((x) => k === x || k.startsWith(x + '.') || k.endsWith('.' + x) || k.includes('.' + x + '.')));
  check('schema completeness: every model key is hashed content or explicitly excluded (generated_at, snapshot_sha256, drill, lifecycle.note)', escaped.length === 0, JSON.stringify(escaped));
  db.board_packet_sections[0].input_data = JSON.parse(JSON.stringify(later));
  const toFinalSame = await call('patch', '/:id', { id: 'pk-1' }, { status: 'final' });
  check('the override still applies to a re-pull of the SAME statement (same content, same hash)', toFinalSame.status === 200);
  // A financial change makes a different statement: the old override no longer applies.
  db.board_packets[0].status = 'in_review';
  db.journal_entries.push({ id: 'je-late', community_id: F.CID, reference: 'SEP-LATE', posting_date: '2026-08-29', source_module: 'manual', status: 'posted', void_reversal_je_id: null, reverses_je_id: null, description: 'Late utility bill' });
  db.journal_entry_lines.push({ id: 'jl-late-1', journal_entry_id: 'je-late', line_number: 1, account_id: F.aid(5300), fund_id: 'f-opr', debit_cents: 12345, credit_cents: 0, memo: null, vendor_id: null, property_id: null },
    { id: 'jl-late-2', journal_entry_id: 'je-late', line_number: 2, account_id: F.aid(1000), fund_id: 'f-opr', debit_cents: 0, credit_cents: 12345, memo: null, vendor_id: null, property_id: null });
  const changed = await SNAP.buildSectionSnapshot(sb, { community_id: F.CID, section_key: 'balance_sheet', cutoff: '2026-08-31', now: NOW });
  db.board_packet_sections[0].input_data = JSON.parse(JSON.stringify(changed));
  const toFinal3 = await call('patch', '/:id', { id: 'pk-1' }, { status: 'final' });
  check('an override does not carry to a statement whose numbers changed (new hash = blocked again)', changed.snapshot_sha256 !== stored.snapshot_sha256 && toFinal3.status === 409);
  db.journal_entries = db.journal_entries.filter((j) => j.id !== 'je-late'); db.journal_entry_lines = db.journal_entry_lines.filter((l) => l.journal_entry_id !== 'je-late');
  db.board_packet_sections[0].input_data = tampered;
  const toFinal4 = await call('patch', '/:id', { id: 'pk-1' }, { status: 'final' });
  check('an altered snapshot blocks finalizing', toFinal4.status === 409 && toFinal4.body.blockers.some((b) => b.problem === 'snapshot_altered'));

  console.log('the gate reads the STORED snapshot, not live mappings');
  db.statement_mapping_overrides = [];   // no override in play
  const oldSnap = JSON.parse(JSON.stringify(stored));
  db.board_packet_sections[0].input_data = oldSnap;
  // Map and approve every account LIVE, after the snapshot was taken.
  for (const m of db.account_report_map) if (m.statement === 'balance_sheet' && m.approval_status !== 'approved') { m.approval_status = 'approved'; m.approved_by = 'Ed'; m.approved_at = '2026-10-10T00:00:00Z'; }
  const cat1415 = db.report_categories.find((c) => c.statement === 'balance_sheet' && c.section === 'asset');
  if (!db.account_report_map.some((m) => m.account_id === F.aid(1415) && m.statement === 'balance_sheet')) db.account_report_map.push({ community_id: F.CID, account_id: F.aid(1415), statement: 'balance_sheet', category_id: cat1415.id, approval_status: 'approved', approved_by: 'Ed', approved_at: '2026-10-10T00:00:00Z' });
  const liveNow = await M.buildBalanceSheetModel(sb, { community_id: F.CID, as_of: '2026-09-30', now: NOW });
  const toFinalOld = await call('patch', '/:id', { id: 'pk-1' }, { status: 'final' });
  check('live mapping is now complete, yet the OLD snapshot (with unmapped accounts) still blocks final', liveNow.mapping.mapping_complete === true && toFinalOld.status === 409 && toFinalOld.body.blockers[0].unmapped.length === 2);
  check('the refusal says to pull the section again', /pull the section again/i.test(toFinalOld.body.message));
  const distOld = await call('post', '/:id/distribute', { id: 'pk-1' }, { recipients: ['board@example.test'], method: 'email' });
  check('distribute is refused on the old snapshot too', distOld.status === 409);
  const mapped = await SNAP.buildSectionSnapshot(sb, { community_id: F.CID, section_key: 'balance_sheet', cutoff: '2026-08-31', now: NOW });
  db.board_packet_sections[0].input_data = JSON.parse(JSON.stringify(mapped));
  const toFinal5 = await call('patch', '/:id', { id: 'pk-1' }, { status: 'final' });
  check('after the re-pull (new snapshot, every account mapped) final needs no override', mapped.models[0].mapping.mapping_complete === true && mapped.snapshot_sha256 !== stored.snapshot_sha256 && toFinal5.status === 200);

  console.log('old-format native statement sections (pre trusted.statement.v1)');
  const oldBS = { as_of_date: '2026-07-31', statement: { sections: { assets: [], liabilities: [], equity: [] }, totals: {} }, source: 'trusted_gl' };
  const oldIS = { period_start: '2026-07-01', period_end: '2026-07-31', statement: { rows: [] }, source: 'trusted_gl' };
  const pdfBS = { as_of_date: '2026-07-31', assets: [{ name: 'Operating', amount: 1000 }], liabilities: [], equity: [], totals: { total_assets: 1000 }, current_period_label: 'July 2026' };
  const pdfIS = { current_period_label: 'July 2026', line_items: [{ name: 'Assessments', actual: 1000 }], total_revenue: 1000 };
  const mkPacket = (id, sections) => {
    db.board_packets.push({ id, community_id: F.CID, management_company_id: BEDROCK_MGMT_CO_ID, status: 'draft' });
    for (const [k, d] of Object.entries(sections)) db.board_packet_sections.push({ id: `${id}-${k}`, packet_id: id, section_key: k, input_data: d === null ? null : JSON.parse(JSON.stringify(d)), status: 'ready' });
  };
  const sectionsOf = (id) => JSON.stringify(db.board_packet_sections.filter((x) => x.packet_id === id));
  mkPacket('pk-oldbs', { balance_sheet: oldBS });
  mkPacket('pk-oldis', { income_statement: oldIS });
  mkPacket('pk-oldboth', { balance_sheet: oldBS, income_statement: oldIS });
  const before = { bs: sectionsOf('pk-oldbs'), is: sectionsOf('pk-oldis'), both: sectionsOf('pk-oldboth') };
  check('the stale-format test helper sees old native sections and nothing else', SNAP.isStaleNative({ section_key: 'balance_sheet', input_data: oldBS }) && SNAP.isStaleNative({ section_key: 'income_statement', input_data: oldIS })
    && !SNAP.isStaleNative({ section_key: 'balance_sheet', input_data: pdfBS }) && !SNAP.isStaleNative({ section_key: 'income_statement', input_data: pdfIS })
    && !SNAP.isStaleNative({ section_key: 'balance_sheet', input_data: {} }) && !SNAP.isStaleNative({ section_key: 'balance_sheet', input_data: null })
    && !SNAP.isStaleNative({ section_key: 'balance_sheet', input_data: stored }) && !SNAP.isStaleNative({ section_key: 'ar_aging', input_data: { source: 'trusted_gl' } }));
  const fBS = await call('patch', '/:id', { id: 'pk-oldbs' }, { status: 'final' });
  check('old native balance sheet blocks final (409), naming the section and the fix', fBS.status === 409 && fBS.body.blockers.some((b) => b.section_key === 'balance_sheet' && b.problem === 'stale_native_format')
    && /balance sheet section was filled in an older format and must be pulled again/.test(fBS.body.message) && /current native statement model/.test(fBS.body.message), JSON.stringify(fBS.body).slice(0, 400));
  const fIS = await call('patch', '/:id', { id: 'pk-oldis' }, { status: 'final' });
  check('old native income statement blocks final (409)', fIS.status === 409 && fIS.body.blockers.some((b) => b.section_key === 'income_statement' && b.problem === 'stale_native_format') && /income statement section/.test(fIS.body.message));
  const fDist = await call('patch', '/:id', { id: 'pk-oldboth' }, { status: 'distributed' });
  const logBefore = db.board_packet_distribution_log.length;
  const dOld = await call('post', '/:id/distribute', { id: 'pk-oldboth' }, { recipients: ['board@example.test'], method: 'email' });
  const dOldPrint = await call('post', '/:id/distribute', { id: 'pk-oldbs' }, { recipients: ['board@example.test'], method: 'print' });
  check('old native sections block distribute (any method) and status "distributed"; nothing is logged', dOld.status === 409 && dOldPrint.status === 409 && fDist.status === 409
    && db.board_packet_distribution_log.length === logBefore && /balance sheet and income statement sections were filled in an older format/.test(dOld.body.message));
  check('old-format packets stay draft-able (in_review allowed)', (await call('patch', '/:id', { id: 'pk-oldboth' }, { status: 'in_review' })).status === 200);
  const ovOld = await call('post', '/:id/statement-mapping-override', { id: 'pk-oldbs' }, { section_key: 'balance_sheet', reason: 'Trying to override a stale section' });
  check('the owner override cannot bypass a stale section (re-pull is the only fix)', ovOld.status === 409 && (await call('patch', '/:id', { id: 'pk-oldbs' }, { status: 'final' })).status === 409);
  check('existing packet sections are not modified or refilled by the gate', sectionsOf('pk-oldbs') === before.bs && sectionsOf('pk-oldis') === before.is && sectionsOf('pk-oldboth') === before.both);
  mkPacket('pk-badmodel', { balance_sheet: { source: 'trusted_statement_model', model_version: 'trusted.statement.v1', models: [] } });
  check('a section claiming the model source without a usable model also blocks', (await call('patch', '/:id', { id: 'pk-badmodel' }, { status: 'final' })).status === 409);
  // trusted.statement.v1 snapshots continue through the existing mapping gate.
  mkPacket('pk-v1-unmapped', { balance_sheet: stored, income_statement: isnap });
  const v1u = await call('patch', '/:id', { id: 'pk-v1-unmapped' }, { status: 'final' });
  check('v1 snapshot with unmapped accounts: still blocked by the mapping gate (not the stale rule)', v1u.status === 409 && v1u.body.blockers.every((b) => b.problem === 'unmapped_accounts'));
  mkPacket('pk-v1-mapped', { balance_sheet: mapped, income_statement: isnap });
  check('v1 snapshot fully mapped: final allowed, as before', (await call('patch', '/:id', { id: 'pk-v1-mapped' }, { status: 'final' })).status === 200);
  // Uploaded PDF sections and empty sections: unchanged behavior.
  mkPacket('pk-pdf', { balance_sheet: pdfBS, income_statement: pdfIS });
  const pdfFinal = await call('patch', '/:id', { id: 'pk-pdf' }, { status: 'final' });
  const pdfDist = await call('post', '/:id/distribute', { id: 'pk-pdf' }, { recipients: ['board@example.test'], method: 'email' });
  check('uploaded Vantaca PDF sections remain allowed (final and distribute)', pdfFinal.status === 200 && pdfDist.status === 200);
  check('uploaded PDF sections still render with their own renderer', !/needs to be pulled again/.test(bp.renderSectionStandaloneHtml({ packet: { community: {} }, section: { section_key: 'balance_sheet', input_data: pdfBS }, embed: true })));
  mkPacket('pk-empty', { balance_sheet: {}, income_statement: null });
  check('empty statement sections behave as today (do not block)', (await call('patch', '/:id', { id: 'pk-empty' }, { status: 'final' })).status === 200);

  console.log('no conversion: history starts at the earliest posted entry (August Meadows shape)');
  {
    const FS = require('../lib/accounting/financial_statements');
    const AM = 'c-am';
    db.communities.push({ id: AM, name: 'August Meadows', legal_name: 'August Meadows Homeowners Association', gl_cutover_date: null });
    db.account_funds.push({ id: 'f-am', community_id: AM, fund_code: 'OPR', fund_name: 'Operating', is_active: true, display_order: 1 });
    const acct = (n, t, name) => db.chart_of_accounts.push({ id: `am-${n}`, community_id: AM, account_number: String(n), account_name: name, account_type: t, normal_balance: ['asset', 'expense'].includes(t) ? 'debit' : 'credit', is_active: true, is_summary: false, fund_id: 'f-am', account_subtype: null, account_funds: { fund_code: 'OPR', fund_name: 'Operating', fund_type: 'operating' } });
    acct(1020, 'asset', 'Undeposited Funds'); acct(1300, 'asset', 'Accounts Receivable'); acct(2110, 'liability', 'Prepaid Assessments'); acct(4000, 'revenue', 'Assessment Income');
    const amje = (id, ref, date, mod, lines) => { db.journal_entries.push({ id, community_id: AM, reference: ref, posting_date: date, source_module: mod, status: 'posted', void_reversal_je_id: null, reverses_je_id: null, description: ref });
      lines.forEach(([a, d, c], i) => db.journal_entry_lines.push({ id: `${id}-${i}`, journal_entry_id: id, line_number: i + 1, account_id: `am-${a}`, fund_id: 'f-am', debit_cents: d, credit_cents: c, memo: null, vendor_id: null, property_id: null })); };
    amje('am-1', 'JE-2026-00001', '2026-05-21', 'assessment_billing', [[1300, 1031014, 0], [2110, 0, 1031014]]);
    amje('am-2', 'JE-2026-00002', '2026-05-26', 'payment_intake', [[1020, 1031014, 0], [1300, 0, 1031014]]);
    amje('am-3', 'JE-2026-00003', '2026-06-30', 'system', [[2110, 187874, 0], [4000, 0, 187874]]);
    const amBS = await M.buildBalanceSheetModel(sb, { community_id: AM, as_of: '2026-09-30', now: NOW });
    const pyeCol = amBS.columns.find((c) => c.key === 'prior_year_end');
    check('August Meadows: 12/31/2025 prior year end is n/a (books begin 5/21/2026), never zero', pyeCol.available === false && /5\/21\/2026/.test(pyeCol.reason)
      && amBS.totals.assets.prior_year_end === null && amBS.totals.liabilities_and_fund_balance.prior_year_end === null && amBS.totals.balanced.prior_year_end === null, JSON.stringify(pyeCol));
    check('August Meadows: n/a all the way down the prior-year-end column (no 0 anywhere)', amBS.sections.every((sec) => sec.groups.every((g) => g.values.prior_year_end === null && g.lines.every((l) => l.values.prior_year_end === null))));
    const amEq = amBS.sections.find((x) => x.key === 'equity');
    check('August Meadows: Beginning fund balance (no equity accounts at all) is n/a too, never an empty-sum zero; current stays a real zero', amEq.groups.length === 0
      && amEq.fund_balance.beginning.values.prior_year_end === null && amEq.total.values.prior_year_end === null && amEq.fund_balance.beginning.values.current === 0, JSON.stringify(amEq.fund_balance.beginning.values));
    check('the rendered prior-year-end column has no zero dash anywhere (every cell n/a)', (() => { const h = R.renderHtml(amBS, { mode: 'print' }); const rows = [...h.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]).filter((r) => /<td/.test(r)); return rows.every((r) => { const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]); return cells.length < 4 || /n\/a/.test(cells[cells.length - 1]); }); })());
    const eng = await FS.balanceSheet({ community_id: AM, as_of_date: '2026-09-30' });
    check('August Meadows: the current 2026 balance sheet is unchanged (equals the engine: 10,310.14 assets; 8,431.40 prepaid)', amBS.totals.assets.current === eng.totals.assets_cents && amBS.totals.assets.current === 1031014
      && amBS.totals.liabilities.current === 843140 && amBS.totals.balanced.current === true && amBS.engine_tie.every((t) => t.ties));
    check('August Meadows: prior month (8/31, after the first entry) stays available', amBS.columns.find((c) => c.key === 'prior_month').available === true && amBS.totals.assets.prior_month === 1031014);
    const amIB = await M.buildIncomeBudgetModel(sb, { community_id: AM, period_end: '2026-09-30', fund: 'OPR', now: NOW });
    check('August Meadows: YTD unchanged (plain sum, available, no not-available note); prior-year columns hidden as not in trustEd', amIB.net.values.ytd_actual === 187874
      && !amIB.columns.some((c) => c.key.startsWith('py_')) && amIB.notes.some((n) => n.code === 'prior_year_hidden') && !amIB.notes.some((n) => n.code === 'ytd_availability'));
    const am25 = await M.buildIncomeBudgetModel(sb, { community_id: AM, period_end: '2025-12-31', fund: 'OPR', now: NOW });
    check('no downstream arithmetic treats the unavailable period as zero (actuals, variances, net all null)', ['mtd_actual', 'ytd_actual', 'mtd_var', 'ytd_var'].every((k) => am25.net.values[k] === null)
      && am25.sections.every((sec) => sec.total.values.ytd_actual === null), JSON.stringify(am25.net.values));
    const r12 = await FS.rollingIncomeStatement({ community_id: AM, end_date: '2026-09-30', months: 12 });
    check('rolling 12: months before 5/21/2026 are n/a (null), later months real; the range total is the real activity', r12.not_available_months.join() === '2025-10,2025-11,2025-12,2026-01,2026-02,2026-03,2026-04'
      && r12.monthly.filter((m) => m.month < '2026-05').every((m) => m.revenue_cents === null) && r12.monthly.find((m) => m.month === '2026-06').revenue_cents === 187874);
    const dCash = await D.drillAccount(sb, { community_id: AM, kind: 'balance_sheet', account_id: 'am-1020', fund_id: 'f-am', as_of: '2026-09-30' });
    check('August Meadows drill still ties to the current balance', dCash.total_cents === 1031014);
  }
  console.log('converted communities unchanged');
  {
    // bs / ib were built on the fresh fixture at the top of this file. Pinned content hashes: the
    // income statement is unchanged since #109; the balance sheet changed exactly once, when its
    // mapping state key was renamed final_ready -> mapping_complete (Ed 2026-10-10).
    check('Drama Creek (converted): statement content hashes are the pinned values (income re-pinned 2026-10-11: seven-column board layout and the fund name in the subtitle; balance sheet unchanged)', bs.snapshot_sha256.startsWith('87999b8f716a') && ib.snapshot_sha256.startsWith('89ffb221dcb3') && bs.period.books_start === '2026-01-01', `${bs.snapshot_sha256} ${ib.snapshot_sha256}`);
  }

  console.log('balance-sheet subcategories and interfund elimination');
  {
    const IF = 'c-ifund';
    db.communities.push({ id: IF, name: 'Interfund Test', legal_name: 'Interfund Test HOA', gl_cutover_date: null });
    db.account_funds.push({ id: 'if-opr', community_id: IF, fund_code: 'OPR', fund_name: 'Operating', fund_type: 'operating', is_active: true, display_order: 1 },
      { id: 'if-ado', community_id: IF, fund_code: 'ADO', fund_name: 'Adopt a School', fund_type: 'special', is_active: true, display_order: 2 });
    const A = (n, t, name, f) => db.chart_of_accounts.push({ id: `if-${n}`, community_id: IF, account_number: String(n), account_name: name, account_type: t, normal_balance: ['asset', 'expense'].includes(t) ? 'debit' : 'credit', is_active: true, is_summary: false, fund_id: f, account_subtype: null, account_funds: { fund_code: f === 'if-opr' ? 'OPR' : 'ADO', fund_name: f === 'if-opr' ? 'Operating' : 'Adopt a School' } });
    A(1000, 'asset', 'Operating Cash', 'if-opr'); A(1300, 'asset', 'Accounts Receivable', 'if-opr'); A(1305, 'asset', 'Allowance for Doubtful Accounts', 'if-opr'); A(1310, 'asset', 'Legacy Receivable - Previous Owners', 'if-opr');
    A(1500, 'asset', 'Office Equipment', 'if-opr'); A(1505, 'asset', 'Accumulated Depreciation', 'if-opr');
    A(1810, 'asset', 'Due from Adopt a School to Operating', 'if-opr'); A(2810, 'liability', 'Due to Adopt a School from Operating', 'if-opr');
    A(1815, 'asset', 'Due from Operating to Adopt a School', 'if-ado'); A(2815, 'liability', 'Due to Operating from Adopt a School', 'if-ado');
    A(2000, 'liability', 'Accounts Payable', 'if-opr'); A(3050, 'equity', 'Accumulated Fund Balance', 'if-opr'); A(3030, 'equity', 'Adopt a School Fund Balance', 'if-ado');
    let k = 0;
    const J = (date, lines) => { const id = `if-je-${++k}`; db.journal_entries.push({ id, community_id: IF, reference: `IF-${k}`, posting_date: date, source_module: 'manual', status: 'posted', void_reversal_je_id: null, reverses_je_id: null, description: `IF-${k}` });
      lines.forEach(([a, f, d, c], i) => db.journal_entry_lines.push({ id: `${id}-${i}`, journal_entry_id: id, line_number: i + 1, account_id: `if-${a}`, fund_id: f, debit_cents: d, credit_cents: c, memo: null, vendor_id: null, property_id: null })); };
    J('2025-01-15', [[1000, 'if-opr', 5000000, 0], [1300, 'if-opr', 2845000, 0], [1310, 'if-opr', 171600, 0], [1305, 'if-opr', 0, 626500], [1500, 'if-opr', 2069800, 0], [1505, 'if-opr', 0, 1406100], [2000, 'if-opr', 0, 1000000], [3050, 'if-opr', 0, 7053800]]);
    J('2026-09-10', [[1810, 'if-opr', 50000, 0], [2815, 'if-ado', 0, 50000], [3050, 'if-opr', 0, 50000], [3030, 'if-ado', 50000, 0]]);   // matched pair: ADO owes OPR 500.00
    const cat = (id, section, name, order, parent = null, label = null) => db.report_categories.push({ id, community_id: IF, statement: 'balance_sheet', section, name, report_label: label, parent_category_id: parent, display_order: order, is_active: true });
    const map = (acct, catId) => db.account_report_map.push({ community_id: IF, account_id: `if-${acct}`, statement: 'balance_sheet', category_id: catId, display_order: null, approval_status: 'approved', approved_by: 'Ed', approved_at: '2026-10-10T00:00:00Z' });
    cat('ic-cash', 'asset', 'Cash & cash equivalents', 10); cat('ic-ar', 'asset', 'Homeowner receivables', 30);
    cat('ic-ar-cur', 'asset', 'Current owners', 1, 'ic-ar'); cat('ic-ar-for', 'asset', 'Former owners', 2, 'ic-ar'); cat('ic-ar-all', 'asset', 'Allowance for doubtful accounts', 3, 'ic-ar', 'Less: allowance for doubtful accounts');
    cat('ic-oth', 'asset', 'Other assets', 50); cat('ic-oth-fa', 'asset', 'Fixed assets, net', 3, 'ic-oth');
    cat('ic-ifr', 'asset', 'Interfund receivables', 90); cat('ic-ap', 'liability', 'Accounts payable', 10); cat('ic-ifp', 'liability', 'Interfund payables', 90); cat('ic-fb', 'equity', 'Fund balance', 10);
    map(1000, 'ic-cash'); map(1300, 'ic-ar-cur'); map(1310, 'ic-ar-for'); map(1305, 'ic-ar-all'); map(1500, 'ic-oth-fa'); map(1505, 'ic-oth-fa');
    map(1810, 'ic-ifr'); map(1815, 'ic-ifr'); map(2810, 'ic-ifp'); map(2815, 'ic-ifp'); map(2000, 'ic-ap'); map(3050, 'ic-fb'); map(3030, 'ic-fb');
    const con = await M.buildBalanceSheetModel(sb, { community_id: IF, as_of: '2026-09-30', now: NOW });
    const ar = con.sections[0].groups.find((g) => g.label === 'Homeowner receivables');
    const sg = (g, label) => g.subgroups.find((x) => x.label === label);
    check('subcategories: current-owner AR, former-owner AR and the allowance stay separate', ar && ar.subgroups && sg(ar, 'Current owners').values.current === 2845000 && sg(ar, 'Former owners').values.current === 171600
      && sg(ar, 'Less: allowance for doubtful accounts').values.current === -626500 && ar.values.current === 2845000 + 171600 - 626500, JSON.stringify(ar && ar.subgroups && ar.subgroups.map((x) => [x.label, x.values.current])));
    const oth = con.sections[0].groups.find((g) => g.label === 'Other assets');
    check('subcategories: office equipment and accumulated depreciation stay separate with a net fixed-asset subtotal', sg(oth, 'Fixed assets, net').values.current === 663700 && sg(oth, 'Fixed assets, net').lines.map((l) => l.account_number).join() === '1500,1505');
    const prt = R.renderHtml(con, { mode: 'print' }); const webh = R.renderHtml(con, { mode: 'web' });
    check('print / PDF / board packet: subcategories are visible, never collapsed into one category total', ['Current owners', 'Former owners', 'Less: allowance for doubtful accounts', 'Office Equipment', 'Accumulated Depreciation', 'Fixed assets, net', 'Total homeowner receivables', 'Total other assets'].every((t) => prt.includes(t)));
    check('the allowance renders as a contra line (parentheses) reducing receivables', /Less: allowance for doubtful accounts[\s\S]*?\(6,265\)/.test(prt) && /Total homeowner receivables[\s\S]*?23,901/.test(prt));
    check('web shows the same subcategories, with drill targets', ['Current owners', 'Former owners', 'Fixed assets, net'].every((t) => webh.includes(t)) && /class="sgrow"/.test(webh));
    const xr = R.xlsxRows(con).map((r) => (Array.isArray(r) ? r[0] : r.cells[0])).join('|');
    check('XLSX keeps the subcategories and the net fixed-asset subtotal', /Current owners/.test(xr) && /Less: allowance for doubtful accounts/.test(xr) && /Fixed assets, net/.test(xr) && /1505 Accumulated Depreciation/.test(xr));
    check('interfund pairs come from the posting resolver (1810/2815 and 1815/2810)', con.interfund && con.interfund.pairs.map((p) => `${p.receivable.number}/${p.payable.number}`).sort().join() === '1810/2815,1815/2810');
    const elimA = con.sections[0].groups.find((g) => g.kind === 'elimination'); const elimL = con.sections[1].groups.find((g) => g.kind === 'elimination');
    check('consolidated: the matched pair (500.00 both sides) is eliminated from assets and liabilities', elimA && elimA.values.current === -50000 && elimL && elimL.values.current === -50000 && con.interfund.eliminated.current === 50000);
    const gross = con.sections[0].groups.filter((g) => g.kind !== 'elimination').reduce((t, g) => t + g.values.current, 0);
    check('consolidated totals are after elimination, still balanced, and tie to the engine (engine - eliminated)', con.totals.assets.current === gross - 50000 && con.totals.balanced.current === true && con.engine_tie.every((t) => t.ties) && con.engine_tie[0].interfund_eliminated === 50000);
    check('the elimination is visible in the PDF with an explanation', /Less: interfund eliminations/.test(prt) && /eliminated in this consolidated statement/.test(prt));
    const fv2 = await M.buildBalanceSheetModel(sb, { community_id: IF, as_of: '2026-09-30', view: 'fund', now: NOW });
    const ifr = fv2.sections[0].groups.find((g) => g.label === 'Interfund receivables');
    check('by fund: interfund accounts show normally (no elimination line); funds still balance', !fv2.sections[0].groups.some((g) => g.kind === 'elimination') && ifr.values['fund:OPR'] === 50000
      && fv2.sections[1].groups.find((g) => g.label === 'Interfund payables').values['fund:ADO'] === 50000 && Object.values(fv2.totals.balanced).every(Boolean) && fv2.engine_tie.every((t) => t.ties));
    // An unmatched pair: ADO records a receivable from Operating with no reciprocal payable.
    J('2026-09-20', [[1815, 'if-ado', 30000, 0], [3030, 'if-ado', 0, 30000]]);
    const con2 = await M.buildBalanceSheetModel(sb, { community_id: IF, as_of: '2026-09-30', now: NOW });
    const imb = con2.warnings.find((w) => w.code === 'interfund_imbalance');
    check('an unmatched pair is NOT eliminated and raises an interfund imbalance warning', imb && /1815 shows 300\.00 but 2810 shows 0\.00/.test(imb.text) && con2.interfund.eliminated.current === 50000
      && con2.interfund.pairs.find((p) => p.receivable.number === '1815').by_column.current.status === 'imbalance', imb && imb.text);
    check('with the imbalance the statement still balances and ties (only the matched pair eliminated)', con2.totals.balanced.current === true && con2.engine_tie.every((t) => t.ties));
    const fv3 = await M.buildBalanceSheetModel(sb, { community_id: IF, as_of: '2026-09-30', view: 'fund', now: NOW });
    check('the by-fund view reports the same imbalance', fv3.warnings.some((w) => w.code === 'interfund_imbalance'));
    check('prior year end (before any interfund activity) eliminates nothing', con2.interfund.eliminated.prior_year_end === 0);
    // Hash content covers the new structure (schema completeness on this model too).
    const paths2 = (v, pre, out) => { if (Array.isArray(v)) v.forEach((x) => paths2(x, pre, out)); else if (v && typeof v === 'object') for (const kk of Object.keys(v)) { const pth = pre ? `${pre}.${kk}` : kk; if (/(^|\.)(values|eliminated|by_column)$/.test(pre)) continue; out.add(pth); paths2(v[kk], pth, out); } return out; };
    const c2 = paths2(M.statementContent(JSON.parse(JSON.stringify(con2))), '', new Set()); const k2 = paths2(JSON.parse(JSON.stringify(con2)), '', new Set());
    const esc2 = [...k2].filter((x) => !c2.has(x) && !M.HASH_EXCLUDED.some((e) => x === e || x.startsWith(e + '.') || x.endsWith('.' + e) || x.includes('.' + e + '.'))
      && !/^sections\.groups\.subgroups\.lines/.test(x) && !/^interfund\.(pairs\.(receivable|payable)\.|imbalances\.(receivable|payable|column_label))/.test(x));
    check('hash schema completeness holds with subgroups and interfund (lines are hashed once, by account)', esc2.length === 0, JSON.stringify(esc2));
    check('moving an account between subcategories changes the hash', (() => { const c = JSON.parse(JSON.stringify(con2)); const g = c.sections[0].groups.find((x) => x.label === 'Homeowner receivables'); const t = g.subgroups[0].lines.pop(); g.subgroups[1].lines.push(t); return M.modelSha(c) !== con2.snapshot_sha256; })());
    const emb = bp.renderSectionStandaloneHtml({ packet: { community: { name: 'Interfund Test' } }, section: { section_key: 'balance_sheet', input_data: JSON.parse(JSON.stringify(await SNAP.buildSectionSnapshot(sb, { community_id: IF, section_key: 'balance_sheet', cutoff: '2026-09-30', now: NOW }))) }, embed: true });
    check('board packet section shows the subcategories and the interfund handling', /Former owners/.test(emb) && /Fixed assets, net/.test(emb) && /Interfund imbalance/.test(emb));
  }

  console.log('final requires a CLOSED financial period (mapping-complete is not final-ready)');
  {
    // Fixture: August CLOSED, September OPEN. All Drama Creek balance-sheet accounts are mapped by now.
    const NOT_CLOSED = 'Financial period September 2026 is not closed. Close the period before finalizing or distributing this packet.';
    const pk = (id, sections) => { db.board_packets.push({ id, community_id: F.CID, management_company_id: BEDROCK_MGMT_CO_ID, status: 'draft' });
      for (const [key, d] of Object.entries(sections)) db.board_packet_sections.push({ id: `${id}-${key}`, packet_id: id, section_key: key, input_data: JSON.parse(JSON.stringify(d)), status: 'ready' }); };
    const pull = (key, cutoff, client = sb) => SNAP.buildSectionSnapshot(client, { community_id: F.CID, section_key: key, cutoff, now: NOW });
    const sepBS = await pull('balance_sheet', '2026-09-30'); const sepIS = await pull('income_statement', '2026-09-30');
    check('September snapshots are mapping-complete but record the period as DRAFT', sepBS.models[0].mapping.mapping_complete === true && sepBS.models[0].lifecycle.status === 'draft');
    pk('pk-sep', { balance_sheet: sepBS, income_statement: sepIS });
    const f1 = await call('patch', '/:id', { id: 'pk-sep' }, { status: 'final' });
    check('mapping complete + period OPEN: final blocked with the plain message', f1.status === 409 && f1.body.message.includes(NOT_CLOSED) && f1.body.blockers.every((b) => b.problem === 'period_not_closed') && db.board_packets.find((x) => x.id === 'pk-sep').status === 'draft', JSON.stringify(f1.body).slice(0, 300));
    const logN = db.board_packet_distribution_log.length;
    const d1 = await call('post', '/:id/distribute', { id: 'pk-sep' }, { recipients: ['board@example.test'], method: 'email' });
    const d1b = await call('patch', '/:id', { id: 'pk-sep' }, { status: 'distributed' });
    check('distribute (action and status) follows the same rule; nothing logged; packet stays DRAFT', d1.status === 409 && d1.body.message.includes(NOT_CLOSED) && d1b.status === 409 && db.board_packet_distribution_log.length === logN && db.board_packets.find((x) => x.id === 'pk-sep').status === 'draft');
    const gate1 = await call('get', '/:id/statement-gate', { id: 'pk-sep' });
    check('the gate reports the period blocker for the UI', gate1.body.ok === false && gate1.body.open.some((b) => b.problem === 'period_not_closed' && b.period_label === 'September 2026'));
    const augBS = await pull('balance_sheet', '2026-08-31'); const augIS = await pull('income_statement', '2026-08-31');
    pk('pk-aug', { balance_sheet: augBS, income_statement: augIS });
    check('mapping complete + period CLOSED + closed-state snapshot: final allowed', augBS.models[0].lifecycle.status === 'closed' && (await call('patch', '/:id', { id: 'pk-aug' }, { status: 'final' })).status === 200);
    pk('pk-aug2', { balance_sheet: augBS });
    check('... and distribute is allowed', (await call('post', '/:id/distribute', { id: 'pk-aug2' }, { recipients: ['board@example.test'], method: 'email' })).status === 200);
    // Mapping incomplete + period closed: the mapping blocker still applies.
    const m1415 = db.account_report_map.find((m) => m.account_id === F.aid(1415) && m.statement === 'balance_sheet');
    const saved = { ...m1415 }; Object.assign(m1415, { approval_status: 'proposed', approved_by: null, approved_at: null });
    const augUnmapped = await pull('balance_sheet', '2026-08-31');
    pk('pk-aug-unmapped', { balance_sheet: augUnmapped });
    const f3 = await call('patch', '/:id', { id: 'pk-aug-unmapped' }, { status: 'final' });
    check('mapping incomplete + period closed: the mapping blocker still applies (no period blocker)', f3.status === 409 && f3.body.blockers.length === 1 && f3.body.blockers[0].problem === 'unmapped_accounts');
    // Owner mapping override does not bypass the period requirement.
    const sepUnmapped = await pull('balance_sheet', '2026-09-30');
    pk('pk-sep-ovr', { balance_sheet: sepUnmapped });
    const ovr = await call('post', '/:id/statement-mapping-override', { id: 'pk-sep-ovr' }, { section_key: 'balance_sheet', reason: 'Escrow account classification pending CPA review' });
    const f4 = await call('patch', '/:id', { id: 'pk-sep-ovr' }, { status: 'final' });
    check('owner mapping override does not bypass the closed-period requirement', ovr.status === 200 && f4.status === 409 && f4.body.message.includes(NOT_CLOSED) && f4.body.blockers.every((b) => b.problem === 'period_not_closed'));
    Object.assign(m1415, saved);
    // A snapshot pulled while open stays blocked after the live period closes, until re-pulled.
    const sepPer = db.accounting_periods.find((x) => x.community_id === F.CID && x.period_number === 9);
    const sepSaved = { ...sepPer };
    pk('pk-sep-late', { balance_sheet: sepBS });
    Object.assign(sepPer, { status: 'closed', closed_at: '2026-10-11T15:00:00Z' });
    db.period_closes.push({ id: 'pc-sep', community_id: F.CID, period_id: sepPer.id, status: 'closed', close_label: 'closed', closed_at: '2026-10-11T15:00:00Z', closed_by: 'Association Manager' });
    const f5 = await call('patch', '/:id', { id: 'pk-sep-late' }, { status: 'final' });
    const d5 = await call('post', '/:id/distribute', { id: 'pk-sep-late' }, { recipients: ['board@example.test'], method: 'email' });
    check('snapshot pulled while OPEN stays blocked after the live period closes (final and distribute)', f5.status === 409 && f5.body.blockers.some((b) => b.problem === 'snapshot_pulled_open') && /pulled while it was still open\. Pull the section again/.test(f5.body.message) && d5.status === 409);
    const closedClient = F.fakeClient({ closedThrough: '2026-09-30' });
    const sepClosed = await pull('balance_sheet', '2026-09-30', closedClient);
    db.board_packet_sections.find((x) => x.id === 'pk-sep-late-balance_sheet').input_data = JSON.parse(JSON.stringify(sepClosed));
    check('after the re-pull (snapshot records the CLOSED period, new hash) final is allowed', sepClosed.models[0].lifecycle.status === 'closed' && sepClosed.models[0].lifecycle.closed_through === '2026-09-30'
      && sepClosed.snapshot_sha256 !== sepBS.snapshot_sha256 && (await call('patch', '/:id', { id: 'pk-sep-late' }, { status: 'final' })).status === 200);
    // A period reopened after a closed-state pull blocks again.
    Object.assign(sepPer, { status: 'reopened' });
    pk('pk-reopen', { balance_sheet: sepClosed });
    const f6 = await call('patch', '/:id', { id: 'pk-reopen' }, { status: 'final' });
    check('a period reopened after the pull blocks final (re-close and re-pull)', f6.status === 409 && f6.body.blockers.some((b) => b.problem === 'period_reopened') && /was reopened after this statement was pulled/.test(f6.body.message));
    Object.assign(sepPer, sepSaved); db.period_closes = db.period_closes.filter((x) => x.id !== 'pc-sep');
    // Uploaded Vantaca PDF sections keep their existing behavior (no native snapshot, no period rule).
    pk('pk-pdf-open', { balance_sheet: { as_of_date: '2026-09-30', assets: [{ name: 'Operating', amount: 1 }], liabilities: [], equity: [], totals: {} }, income_statement: { current_period_label: 'September 2026', line_items: [{ name: 'x', actual: 1 }] } });
    check('uploaded Vantaca PDF sections keep their existing behavior (allowed; the period rule is for native statements)', (await call('patch', '/:id', { id: 'pk-pdf-open' }, { status: 'final' })).status === 200);
    check('a packet mixing an uploaded PDF with a native open-period statement is still blocked', (() => true)() && (await (async () => { pk('pk-mixed', { balance_sheet: sepBS, income_statement: { current_period_label: 'September 2026', line_items: [{ name: 'x', actual: 1 }] } }); return (await call('patch', '/:id', { id: 'pk-mixed' }, { status: 'final' })).status === 409; })()));
  }

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

  console.log('reserve fund activity (board schedule)');
  {
    F.seed(); const sbr = F.fakeClient();
    const ra = await M.buildReserveActivityModel(sbr, { community_id: F.CID, period_end: '2026-09-30', fund: 'RES', now: NOW });
    const fvr = await M.buildBalanceSheetModel(sbr, { community_id: F.CID, as_of: '2026-09-30', view: 'fund', now: NOW });
    const ibr = await M.buildIncomeBudgetModel(sbr, { community_id: F.CID, period_end: '2026-09-30', fund: 'RES', now: NOW });
    const roll = ra.sections.find((s) => s.key === 'rollforward');
    const beg = roll.groups[0];
    const activity = roll.groups.slice(1).reduce((t, g) => t + g.values.ytd, 0);
    const eqr = fvr.sections.find((s) => s.key === 'equity');
    check('roll-forward: beginning + year-to-date activity = ending = the balance sheet fund balance', beg.label === 'Beginning fund balance' && beg.values.ytd + activity === roll.total.values.ytd && roll.total.values.ytd === eqr.total.values['fund:RES'] && !ra.warnings.length, JSON.stringify({ beg: beg.values, activity, end: roll.total.values }));
    check('roll-forward activity is the fund\'s own income statement (revenue in, expenses out)', activity === ibr.net.values.ytd_actual);
    check('month: beginning of month + month activity = ending', beg.values.mtd + roll.groups.slice(1).reduce((t, g) => t + g.values.mtd, 0) === roll.total.values.mtd);
    const exps = ra.sections.find((s) => s.key === 'expenditures');
    check('expenditure detail, when present, adds up to the fund\'s expenses', !exps || exps.total.values.ytd === -roll.groups.filter((g) => g.values.ytd < 0).reduce((t, g) => t + g.values.ytd, 0));
    const keysR = new Set(); const walkR = (o, pre) => { if (Array.isArray(o)) return o.forEach((x) => walkR(x, pre)); if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { const p = pre ? `${pre}.${k}` : k; keysR.add(p.replace(/\.\d+/g, '')); walkR(v, p); } };
    walkR(ra, ''); const contentR = new Set(); const walkC = (o, pre) => { if (Array.isArray(o)) return o.forEach((x) => walkC(x, pre)); if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { const p = pre ? `${pre}.${k}` : k; contentR.add(p.replace(/\.\d+/g, '')); walkC(v, p); } };
    walkC(M.statementContent(ra), '');
    const escR = [...keysR].filter((k) => !contentR.has(k) && !M.HASH_EXCLUDED.some((x) => k === x || k.startsWith(x + '.') || k.endsWith('.' + x) || k.includes('.' + x + '.')));
    check('reserve schedule: every model key is hashed content or explicitly excluded', escR.length === 0, JSON.stringify(escR));
    const htmlR = R.renderHtml(ra, { mode: 'print', noStyle: true });
    check('reserve schedule prints the roll-forward with its ending balance, two columns (month, year to date)', /Fund balance roll-forward/.test(htmlR) && /Ending fund balance/.test(htmlR) && ra.columns.map((c) => c.key).join() === 'mtd,ytd');
    const doc = R.renderDocument([fvr, ibr, ra]);
    check('the package document is landscape letter', /@page\{size:Letter landscape/.test(doc));
    const ibPrint = R.renderHtml(ibr, { mode: 'print', noStyle: true });
    check('printed income statement: a column band row and each GL account under its category with a category subtotal', /class="band"/.test(ibPrint) && /Current month/.test(ibPrint) && /Annual/.test(ibPrint) && (!ibr.sections[0].groups.some((g) => g.kind === 'category') || /class="cattot"/.test(ibPrint)));
  }

  console.log('interfund transfers (reserve contribution)');
  {
    F.seed(); const sbt = F.fakeClient(); const dbt = F.getDb();
    for (const a of dbt.chart_of_accounts) if (a.account_number === '5900' || a.account_number === '4900') a.account_subtype = 'interfund_transfer';
    const opr = await M.buildIncomeBudgetModel(sbt, { community_id: F.CID, period_end: '2026-09-30', fund: 'OPR', now: NOW });
    const res = await M.buildIncomeBudgetModel(sbt, { community_id: F.CID, period_end: '2026-09-30', fund: 'RES', now: NOW });
    const inSections = (m, n) => m.sections.some((s) => s.groups.some((g) => g.lines.some((l) => l.account_number === n)));
    check('a transfer is neither revenue nor expense: it prints in its own section', !inSections(opr, '5900') && opr.transfers && opr.transfers.groups[0].lines[0].account_number === '5900' && !inSections(res, '4900') && res.transfers.groups[0].lines[0].account_number === '4900');
    const out = opr.transfers.total.values, inn = res.transfers.total.values;
    check('signed as the fund sees it: Operating transfer out is negative, Reserve transfer in is positive', out.mtd_actual === -1250000 && out.mtd_budget === -1250000 && inn.mtd_actual === 1250000 && inn.mtd_budget === 1250000, JSON.stringify({ out, inn }));
    check('net change in fund balance = excess of revenue over expenses + transfers', opr.change.values.ytd_actual === opr.net.values.ytd_actual + out.ytd_actual && opr.net.label === 'Excess (deficit) of revenue over expenses' && opr.change.label === 'Net change in fund balance');
    // An unpaid contribution: actual 0 against a budget is unfavorable to the receiving fund.
    const unpaid = { mtd_actual: 0, mtd_budget: 1250000 }; const v = unpaid.mtd_actual - unpaid.mtd_budget;
    check('variance on a transfer is actual - budget (an unpaid contribution is unfavorable to Reserve)', inn.mtd_var === inn.mtd_actual - inn.mtd_budget && v < 0);
    const pr = R.renderHtml(res, { mode: 'print', noStyle: true });
    check('printed: the transfer section and the net change row follow the excess of revenue over expenses', pr.indexOf('Excess (deficit) of revenue over expenses') < pr.indexOf('Interfund transfers') && pr.indexOf('Interfund transfers') < pr.indexOf('Net change in fund balance'));
    const ra = await M.buildReserveActivityModel(sbt, { community_id: F.CID, period_end: '2026-09-30', fund: 'RES', now: NOW });
    const roll = ra.sections.find((s) => s.key === 'rollforward');
    check('reserve roll-forward counts the transfer in and still ties', roll.groups.some((g) => /Interfund transfers/.test(g.label)) && !ra.warnings.length && roll.groups[0].values.ytd + roll.groups.slice(1).reduce((t, g) => t + g.values.ytd, 0) === roll.total.values.ytd);
  }

  console.log('interfund transfers from the account configuration (from / to funds)');
  {
    // paired: a transfer-out account in Operating and a transfer-in account in Reserve
    F.seed(); const sbc = F.fakeClient(); const dbc = F.getDb();
    for (const a of dbc.chart_of_accounts) if (a.account_number === '5900' || a.account_number === '4900') Object.assign(a, { account_subtype: 'interfund_transfer', interfund_from_fund_id: 'f-opr', interfund_to_fund_id: 'f-res' });
    const o = await M.buildIncomeBudgetModel(sbc, { community_id: F.CID, period_end: '2026-09-30', fund: 'OPR', now: NOW });
    const r = await M.buildIncomeBudgetModel(sbc, { community_id: F.CID, period_end: '2026-09-30', fund: 'RES', now: NOW });
    check('paired accounts: each fund shows its own account once (no double count), no warning', o.transfers.groups[0].lines.length === 1 && o.transfers.total.values.annual_budget === r.transfers.total.values.annual_budget * -1 && r.transfers.total.values.mtd_actual === 1250000 && !o.warnings.length && !r.warnings.length, JSON.stringify(o.transfers.groups[0].lines.map((l) => l.values)));
    // single account (the Canyon Gate shape): the whole transfer budgeted on one Reserve line as the outgoing leg
    F.seed(); const sbs = F.fakeClient(); const dbs = F.getDb();
    const a49 = dbs.chart_of_accounts.find((a) => a.account_number === '4900'); Object.assign(a49, { account_subtype: 'interfund_transfer', interfund_from_fund_id: 'f-opr', interfund_to_fund_id: 'f-res' });
    for (const b of dbs.budget_line_items) if (b.account_id === a49.id) { b.annual_amount_cents = -Math.abs(b.annual_amount_cents); if (b.monthly_amounts_cents) b.monthly_amounts_cents = b.monthly_amounts_cents.map((x) => -Math.abs(x)); }
    const o2 = await M.buildIncomeBudgetModel(sbs, { community_id: F.CID, period_end: '2026-09-30', fund: 'OPR', now: NOW });
    const r2 = await M.buildIncomeBudgetModel(sbs, { community_id: F.CID, period_end: '2026-09-30', fund: 'RES', now: NOW });
    const ol = o2.transfers && o2.transfers.groups[0].lines.find((l) => l.account_number === '4900'), rl = r2.transfers.groups[0].lines.find((l) => l.account_number === '4900');
    check('single account: Operating shows a transfer out of the budgeted amount, Reserve a transfer in of the same amount', ol && rl && ol.values.annual_budget < 0 && rl.values.annual_budget === -ol.values.annual_budget && /transfer to RES/.test(ol.account_name) && /transfer from OPR/.test(rl.account_name), JSON.stringify({ ol: ol && ol.values, rl: rl && rl.values }));
    check('single account: actuals come from each fund\'s posted lines (none in Operating, the posted amount in Reserve)', ol.values.mtd_actual === 0 && rl.values.mtd_actual === 1250000 && ol.values.mtd_var === ol.values.mtd_actual - ol.values.mtd_budget);
    const c2 = await M.buildIncomeBudgetModel(sbs, { community_id: F.CID, period_end: '2026-09-30', fund: 'all', now: NOW });
    check('consolidated: the budgeted transfer nets to zero across funds', c2.transfers && c2.transfers.total.values.annual_budget === 0);
  }

  console.log('proposed budget (draft next year beside this year\'s budget, actual and projection)');
  {
    F.seed(); const sbb = F.fakeClient(); const dbb = F.getDb();
    const a49 = dbb.chart_of_accounts.find((a) => a.account_number === '4900'); Object.assign(a49, { account_subtype: 'interfund_transfer', interfund_from_fund_id: 'f-opr', interfund_to_fund_id: 'f-res' });
    for (const b of dbb.budget_line_items) if (b.account_id === a49.id) { b.annual_amount_cents = -Math.abs(b.annual_amount_cents); if (b.monthly_amounts_cents) b.monthly_amounts_cents = b.monthly_amounts_cents.map((x) => -Math.abs(x)); }
    const base = dbb.community_budgets.find((b) => b.fiscal_year === 2026);
    dbb.community_budgets.push({ id: 'bud-2027', community_id: F.CID, fiscal_year: 2027, status: 'draft', created_at: '2026-10-10T00:00:00Z' });
    let n = 0;
    for (const l of dbb.budget_line_items.filter((x) => x.budget_id === base.id)) dbb.budget_line_items.push({ ...l, id: `bl27-${++n}`, budget_id: 'bud-2027', annual_amount_cents: Math.round(l.annual_amount_cents * 1.1) });
    const draftOf = (num) => dbb.budget_line_items.filter((x) => x.budget_id === 'bud-2027' && x.account_id === `a-${num}`).reduce((t, x) => t + x.annual_amount_cents, 0);
    const apprOf = (num) => dbb.budget_line_items.filter((x) => x.budget_id === base.id && x.account_id === `a-${num}`).reduce((t, x) => t + x.annual_amount_cents, 0);
    // an Operating account's revenue posted to the Reserve fund (the Vantaca 4050 shape, mirrored)
    dbb.journal_entries.push({ id: 'je-xf', community_id: F.CID, reference: 'JE-XF', posting_date: '2026-09-15', source_module: 'manual', status: 'posted', void_reversal_je_id: null, reverses_je_id: null, description: 'cross-fund' });
    dbb.journal_entry_lines.push({ id: 'jl-xf1', journal_entry_id: 'je-xf', line_number: 1, account_id: 'a-1200', fund_id: 'f-res', debit_cents: 4321, credit_cents: 0, memo: null, vendor_id: null, property_id: null },
      { id: 'jl-xf2', journal_entry_id: 'je-xf', line_number: 2, account_id: 'a-4200', fund_id: 'f-res', debit_cents: 0, credit_cents: 4321, memo: null, vendor_id: null, property_id: null });
    const po = await M.buildProposedBudgetModel(sbb, { community_id: F.CID, target_year: 2027, as_of: '2026-09-30', fund: 'OPR', now: NOW });
    const pr = await M.buildProposedBudgetModel(sbb, { community_id: F.CID, target_year: 2027, as_of: '2026-09-30', fund: 'RES', now: NOW });
    const lineP = (m, num) => { for (const s of m.sections) for (const g of s.groups) for (const l of g.lines) if (l.account_number === num) return l; return null; };
    const l52 = lineP(po, '5200');
    check('proposed column is the draft budget line for line; the base-year column is the approved budget; change = proposed - approved', l52 && l52.values.prop === draftOf(5200) && l52.values.appr === apprOf(5200) && l52.values.chg === l52.values.prop - l52.values.appr, JSON.stringify(l52 && l52.values));
    check('columns are banded by year (2026 budget, actual, projected | 2027 proposed, change) with no variance or percentage column', po.columns.map((c) => `${c.band}:${c.key}`).join() === '2026:appr,2026:ytd,2026:proj,2027:prop,2027:chg' && !po.columns.some((c) => c.is_var || c.is_pct));
    const ot = po.transfers && po.transfers.groups[0].lines[0], rt = pr.transfers && pr.transfers.groups[0].lines[0];
    check('a single-account reserve contribution is a transfer out of Operating and into Reserve, never revenue', ot && rt && ot.values.prop === -rt.values.prop && ot.values.prop < 0 && !lineP(pr, '4900') && /transfer to RES/.test(ot.account_name));
    check('net change in fund balance = excess + transfers, every column', po.change && ['appr', 'ytd', 'proj', 'prop'].every((k) => po.change.values[k] === po.net.values[k] + po.transfers.total.values[k]));
    const ib = await M.buildIncomeBudgetModel(sbb, { community_id: F.CID, period_end: '2026-09-30', fund: 'OPR', now: NOW });
    const ibl = (() => { for (const s of ib.sections) for (const g of s.groups) for (const l of g.lines) if (l.account_number === '4200') return l; return null; })();
    check('actuals stay in the fund they were posted to (never merged into the budget line of another fund): Operating actual matches the statement, Reserve shows its own line', lineP(po, '4200').values.ytd === ibl.values.ytd_actual && lineP(pr, '4200') && lineP(pr, '4200').values.ytd === 4321);
    const ps = await M.buildProposedBudgetModel(sbb, { community_id: F.CID, target_year: 2027, as_of: '2026-09-30', fund: 'OPR', summary: true, now: NOW });
    check('summary: category totals only, same totals as the detail', ps.sections.every((s) => s.groups.every((g) => g.kind !== 'category' || !g.lines.length)) && ps.change.values.prop === po.change.values.prop);
    const htm = R.renderHtml(po, { mode: 'print', noStyle: true });
    check('printed: draft lifecycle label, year bands, no variance legend', /DRAFT – PROPOSED, NOT APPROVED/.test(htm) && /<th colspan="3">2026<\/th>/.test(htm) && !/Variance: favorable/.test(R.renderDocument([po])));
  }

  console.log('prior-period items recorded this month (conversion re-posts and flagged entries)');
  {
    F.seed(); const sbp = F.fakeClient(); const dbp = F.getDb();
    const base = await M.buildIncomeBudgetModel(sbp, { community_id: F.CID, period_end: '2026-09-30', fund: 'OPR', now: NOW });
    const line = (m, n) => { for (const s of m.sections) for (const g of s.groups) for (const l of g.lines) if (l.account_number === n) return l; return null; };
    // a pre-cutover invoice re-posted at the cutover date, and a flagged correction of pre-cutover spending
    const push = (ref, extra, acct, d, c) => { const id = `je-pp-${ref}`; dbp.journal_entries.push({ id, community_id: F.CID, reference: ref, posting_date: '2026-09-01', source_module: 'manual', status: 'posted', void_reversal_je_id: null, reverses_je_id: null, description: ref, ...extra });
      dbp.journal_entry_lines.push({ id: `${id}-1`, journal_entry_id: id, line_number: 1, account_id: `a-${acct}`, fund_id: 'f-opr', debit_cents: d, credit_cents: c, memo: null, vendor_id: null, property_id: null },
        { id: `${id}-2`, journal_entry_id: id, line_number: 2, account_id: 'a-2000', fund_id: 'f-opr', debit_cents: c, credit_cents: d, memo: null, vendor_id: null, property_id: null }); };
    push('CONV-DC-REPOST-JE1', {}, 5210, 40000, 0);
    push('JE-PP-1', { prior_period_through: '2026-07-31' }, 5400, 0, 15000);
    // a void in September of an invoice dated before the cutover (the original sits in the carried YTD)
    dbp.journal_entries.push({ id: 'je-pp-orig', community_id: F.CID, reference: 'JE-ORIG-0720', posting_date: '2026-07-20', source_module: 'ap_invoice', status: 'voided', void_reversal_je_id: 'je-pp-JE-VOID-1', reverses_je_id: null, description: 'July invoice' });
    push('JE-VOID-1', { source_module: 'reversal', reverses_je_id: 'je-pp-orig' }, 5300, 0, 7000);
    // a void in September of a September invoice stays in the month
    push('JE-SEPINV', { source_module: 'ap_invoice' }, 5300, 3000, 0);
    push('JE-VOID-2', { source_module: 'reversal', reverses_je_id: 'je-pp-JE-SEPINV' }, 5300, 0, 3000);
    const pp = await M.buildIncomeBudgetModel(sbp, { community_id: F.CID, period_end: '2026-09-30', fund: 'OPR', now: NOW });
    check('prior-period items print in their own section, signed by fund effect (re-post expense -400.00, correction credit +150.00, void of a July invoice +70.00)', pp.prior_period && pp.prior_period.total.values.mtd_actual === -18000
      && pp.prior_period.groups[0].lines.map((l) => `${l.account_number}:${l.values.mtd_actual}`).join() === '5210:-40000,5300:7000,5400:15000', JSON.stringify(pp.prior_period && pp.prior_period.groups[0].lines.map((l) => l.values)));
    check('the month excludes them from operating results; year to date keeps them in their accounts', line(pp, '5210').values.mtd_actual === (line(base, '5210') ? line(base, '5210').values.mtd_actual : 0)
      && line(pp, '5210').values.ytd_actual === (line(base, '5210') ? line(base, '5210').values.ytd_actual : 0) + 40000);
    check('a void of a September invoice stays in the month (only reversals of entries dated on or before the cutoff move)', line(pp, '5300').values.mtd_actual === (line(base, '5300') ? line(base, '5300').values.mtd_actual : 0));
    check('net change in fund balance = excess of revenue over expenses + prior-period items', pp.change && pp.change.values.mtd_actual === pp.net.values.mtd_actual - 18000 && pp.net.label === 'Excess (deficit) of revenue over expenses');
    const ppr = R.renderHtml(pp, { mode: 'print', noStyle: true });
    check('printed: the prior-period section sits between the excess and the net change, with its note', ppr.indexOf('Excess (deficit) of revenue over expenses') < ppr.search(/<tr class="sec"><td[^>]*>Prior-period items recorded this month/) && ppr.search(/<tr class="sec"><td[^>]*>Prior-period items recorded this month/) < ppr.indexOf('Net change in fund balance') && pp.notes.some((n) => n.code === 'prior_period'));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.stack); process.exit(1); });
