// ============================================================================
// lib/statements/model.js  (Ed 2026-10-09, month-end close PR C)
// ----------------------------------------------------------------------------
// THE STATEMENT MODEL: one versioned, serializable shape for a financial
// statement. Web, PDF, XLSX, CSV and native board-packet sections all render
// from it (lib/statements/render.js); a board packet stores it as the snapshot
// of exactly what the board saw.
//
// Numbers come ONLY from the verified statement engine
// (lib/accounting/financial_statements.js + statement_periods.js). This module
// does presentation: grouping by an explicit, APPROVED report-category mapping,
// columns, availability, lifecycle. It does no accounting math beyond adding up
// rows the engine produced (and proves every group ties to the engine total).
//
// Rules carried through unchanged:
//   - null = not available in trustEd, never 0 (PR B / #107);
//   - a balance-sheet column dated before a converted community's books begin
//     is null (never a balance manufactured from conversion data);
//   - variance is favorable-positive (lib/accounting/variance.js).
// ============================================================================

const crypto = require('crypto');
const FS = require('../accounting/financial_statements');
const SP = require('../accounting/statement_periods');
const { favorableVariance } = require('../accounting/variance');

const MODEL_VERSION = 'trusted.statement.v1';
const NA = SP.NOT_AVAILABLE_LABEL;
const BS_SECTIONS = [['asset', 'Assets', 'assets'], ['liability', 'Liabilities', 'liabilities'], ['equity', 'Fund balance', 'equity']];

const day = (d) => String(d).slice(0, 10);
const lastOfPrevMonth = (d) => { const [y, m] = day(d).split('-').map(Number); return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10); };
const prevYearEnd = (d) => `${Number(day(d).slice(0, 4)) - 1}-12-31`;
const fmtUs = (d) => { const [y, m, dd] = day(d).split('-'); return `${Number(m)}/${Number(dd)}/${y}`; };
const addN = (a, b) => (a === null || b === null ? null : a + b);
const sumN = (vals) => vals.reduce((t, v) => addN(t, v), 0);
const pct = (v, budget) => (v === null || !budget ? null : Math.round((v / Math.abs(budget)) * 1000) / 10);
const must = (r, what) => { if (r.error) throw Object.assign(new Error(`${what}: ${r.error.message}`), { code: r.error.code }); return r.data; };

// ---------------------------------------------------------------- the snapshot hash
// The snapshot fingerprint is a sha256 of the STATEMENT CONTENT of a model, not of
// the model object. statementContent() is the explicit allowlist that defines
// what trusted.statement.v1 says financially: statement type, community, period
// and fund scope; columns and their availability; account and category
// identities and labels; every amount, with null (n/a) kept distinct from 0;
// budget and variance values; carryforward; mapping and unmapped state; the
// close status of the period; disclosures (notes, warnings) and tie-outs.
// Anything not named here (generation time, drill navigation targets, any link,
// token or expiry a future version might carry) cannot move the hash.
// HASH_EXCLUDED lists the model's own keys that are deliberately outside it;
// tests/test_statement_package.js fails if the model grows a key that is in
// neither list, so new financial content can never silently escape the hash.
const HASH_EXCLUDED = ['generated_at', 'snapshot_sha256', 'drill', 'lifecycle.note'];
const pick = (o, keys) => { const out = {}; if (!o) return null; for (const k of keys) if (o[k] !== undefined) out[k] = o[k]; return out; };
function statementContent(m) {
  const colKeys = (m.columns || []).map((c) => c.key);
  const vals = (v) => (v ? Object.fromEntries(colKeys.map((k) => [k, v[k] === undefined ? null : v[k]])) : null);
  const mapState = (x) => (x ? pick(x, ['status', 'proposed_category']) : null);
  const line = (l) => ({ ...pick(l, ['kind', 'account_id', 'account_number', 'account_name', 'fund_id', 'fund_code', 'ytd_carryforward', 'subcategory_id']), mapping: mapState(l.mapping), values: vals(l.values) });
  const group = (g) => ({ ...pick(g, ['kind', 'category_id', 'label', 'display_order']), values: vals(g.values), lines: (g.lines || []).map(line),
    ...(g.subgroups ? { subgroups: g.subgroups.map((sg) => ({ category_id: sg.category_id, label: sg.label, display_order: sg.display_order ?? null, values: vals(sg.values), accounts: sg.lines.map((l) => `${l.account_id}|${l.fund_id || ''}`) })) } : {}) });
  const labelled = (x) => (x ? { label: x.label, values: vals(x.values) } : null);
  const section = (sec) => ({
    ...pick(sec, ['key', 'label']), groups: (sec.groups || []).map(group), total: labelled(sec.total),
    fund_balance: sec.fund_balance ? { beginning: labelled(sec.fund_balance.beginning), current_year_activity: labelled(sec.fund_balance.current_year_activity) } : null,
    memo: (sec.memo || []).map((x) => ({ label: x.label, fund_code: x.fund_code, values: vals(x.values) })),
    tie_out: (sec.tie_out || []).map((t) => pick(t, ['column', 'engine_total', 'shown', 'ties'])),
  });
  const disclosure = (x) => pick(x, ['code', 'text', 'count', 'column']);
  const out = {
    model_version: m.model_version, kind: m.kind, view: m.view ?? null, fund: m.fund ?? null,
    community: pick(m.community, ['id', 'name', 'legal_name']),
    title: m.title, subtitle: m.subtitle, basis: m.basis,
    period: m.period ? { ...m.period } : null,
    lifecycle: pick(m.lifecycle, ['status', 'label', 'closed_through', 'closed_at', 'closed_by', 'close_label']),
    columns: (m.columns || []).map((c) => pick(c, ['key', 'label', 'as_of', 'available', 'reason', 'fund_code', 'is_total', 'is_pct'])),
    sections: (m.sections || []).map(section),
    notes: (m.notes || []).map(disclosure), warnings: (m.warnings || []).map(disclosure),
  };
  if (m.kind === 'balance_sheet') {
    out.totals = m.totals ? { assets: vals(m.totals.assets), liabilities: vals(m.totals.liabilities), fund_balance: vals(m.totals.fund_balance), liabilities_and_fund_balance: vals(m.totals.liabilities_and_fund_balance), balanced: vals(m.totals.balanced) } : null;
    out.engine_tie = (m.engine_tie || []).map((t) => pick(t, ['column', 'engine_assets', 'interfund_eliminated', 'shown_assets', 'ties']));
    if (m.interfund) out.interfund = { eliminated: vals(m.interfund.eliminated), eliminated_any: m.interfund.eliminated_any,
      pairs: (m.interfund.pairs || []).map((p) => ({ label: p.label, fund_code: p.fund_code, receivable: p.receivable.account_id, payable: p.payable.account_id, by_column: p.by_column })),
      imbalances: (m.interfund.imbalances || []).map((x) => pick(x, ['label', 'column', 'receivable_cents', 'payable_cents'])) };
    out.mapping = m.mapping ? { available: m.mapping.available, approved_count: m.mapping.approved_count, mapping_complete: m.mapping.mapping_complete,
      unmapped: (m.mapping.unmapped || []).map((u) => pick(u, ['account_id', 'account_number', 'account_name', 'section', 'proposed_category'])) } : null;
  } else {
    out.net = labelled(m.net);
    out.carryforward = m.carryforward ? pick(m.carryforward, ['label', 'through', 'revenue', 'expense']) : null;
    out.mapping = m.mapping ? pick(m.mapping, ['has_mapping']) : null;
    out.has_budget = m.has_budget ?? null; out.variance_convention = m.variance_convention ?? null;
  }
  return out;
}
// Canonical JSON (key order independent). Keys whose value is undefined are
// skipped, as JSON / jsonb storage drops them.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
function modelSha(model) { return crypto.createHash('sha256').update(canonical(statementContent(model))).digest('hex'); }

// ---------------------------------------------------------------- shared context
async function loadCommunity(supabase, cid) {
  const c = must(await supabase.from('communities').select('id, name, legal_name, gl_cutover_date').eq('id', cid).maybeSingle(), 'communities');
  if (!c) throw Object.assign(new Error('community_not_found'), { code: 'not_found' });
  return c;
}
async function loadCoaTypes(supabase, cid) {
  return must(await supabase.from('chart_of_accounts').select('id, account_number, account_name, account_type, fund_id').eq('community_id', cid).limit(5000), 'chart_of_accounts');
}
// Start of trustEd history: a converted community's earliest carryforward window;
// a community with no conversion opening entry, its earliest posted entry
// (statement_periods.js); null when neither is known.
async function booksStart(supabase, cid, coa) {
  const windows = await SP.loadWindows(supabase, cid, new Map(coa.map((a) => [a.id, a.account_type])));
  return windows.length ? windows.map((w) => w.from).sort()[0] : (windows.history_start || null);
}

// Lifecycle of the period containing `asOf`: DRAFT unless that month is closed
// (migration 502). Never changes close state.
async function lifecycle(supabase, cid, asOf) {
  const d = day(asOf);
  const per = must(await supabase.from('accounting_periods').select('id, period_start, period_end, status, closed_at')
    .eq('community_id', cid).lte('period_start', d).gte('period_end', d).limit(5), 'accounting_periods');
  const p = (per || []).find((x) => (x.period_type || 'monthly') === 'monthly') || (per || [])[0] || null;
  let through = null;
  const tr = await supabase.rpc('close_closed_through', { p_community: cid });
  if (!tr.error && tr.data) through = day(tr.data);
  if (p && ['closed', 'locked'].includes(p.status)) {
    let rec = null;
    const r = await supabase.from('period_closes').select('closed_at, closed_by, close_label').eq('period_id', p.id).maybeSingle();
    if (!r.error) rec = r.data;
    return { status: 'closed', label: `Closed through ${fmtUs(through || p.period_end)}`, closed_through: through || day(p.period_end),
      closed_at: (rec && rec.closed_at) || p.closed_at || null, closed_by: (rec && rec.closed_by) || null, close_label: (rec && rec.close_label) || 'closed' };
  }
  return { status: 'draft', label: 'DRAFT – PERIOD NOT CLOSED', closed_through: through, closed_at: null, closed_by: null,
    note: through ? `Closed through ${fmtUs(through)}; this period is still open.` : 'No month has been closed yet.' };
}

// Balance-sheet mapping. Only APPROVED rows group an account; a proposal is
// shown with its suggested category but presents under Unmapped.
async function loadBsMapping(supabase, cid) {
  const cats = await supabase.from('report_categories').select('id, section, name, report_label, parent_category_id, display_order, is_active')
    .eq('community_id', cid).eq('statement', 'balance_sheet').order('display_order').order('name').limit(2000);
  const maps = await supabase.from('account_report_map').select('account_id, category_id, display_order, approval_status, approved_by, approved_at')
    .eq('community_id', cid).eq('statement', 'balance_sheet').order('account_id').limit(5000);
  if (cats.error || maps.error) {
    const e = cats.error || maps.error;
    if (/approval_status|balance_sheet|check constraint|does not exist/i.test(e.message || '')) return { available: false, categories: [], byAccount: new Map(), proposals: new Map() };
    throw Object.assign(new Error(`balance-sheet mapping: ${e.message}`), { code: e.code });
  }
  const byId = new Map((cats.data || []).map((c) => [c.id, c]));
  const byAccount = new Map(), proposals = new Map();
  for (const m of maps.data || []) {
    const leaf = byId.get(m.category_id); if (!leaf || !leaf.is_active) continue;
    const top = leaf.parent_category_id ? byId.get(leaf.parent_category_id) : leaf; if (!top) continue;
    (m.approval_status === 'approved' ? byAccount : proposals).set(m.account_id, { top, leaf, display_order: m.display_order, approved_by: m.approved_by, approved_at: m.approved_at });
  }
  return { available: true, categories: cats.data || [], byAccount, proposals };
}

// ================================================================ BALANCE SHEET
// view: 'consolidated' (current / prior month end / prior year end) or 'fund'
// (one column per fund at the current date + total).
async function buildBalanceSheetModel(supabase, { community_id, as_of, view = 'consolidated', now = new Date() }) {
  if (!community_id || !as_of) throw Object.assign(new Error('community_id_and_as_of_required'), { code: 'invalid_input' });
  const asOf = day(as_of);
  const [community, coa] = await Promise.all([loadCommunity(supabase, community_id), loadCoaTypes(supabase, community_id)]);
  const start = await booksStart(supabase, community_id, coa);
  const mapping = await loadBsMapping(supabase, community_id);

  // Columns. A date before a converted community's books begin is not available.
  const colDefs = view === 'fund' ? [{ key: 'current', as_of: asOf }] : [
    { key: 'current', label: 'Current', as_of: asOf },
    { key: 'prior_month', label: 'Prior month', as_of: lastOfPrevMonth(asOf) },
    { key: 'prior_year_end', label: 'Prior year end', as_of: prevYearEnd(asOf) },
  ];
  const engine = {};
  for (const c of colDefs) {
    c.available = !(start && c.as_of < start);
    c.reason = c.available ? null : `${NA}: trustEd's books for this community begin ${fmtUs(start)}.`;
    engine[c.key] = c.available ? await FS.balanceSheet({ community_id, as_of_date: c.as_of }) : null;
  }
  const cur = engine.current;

  // Column set the rows are keyed by.
  let columns;
  if (view === 'fund') {
    columns = [...cur.funds.map((f) => ({ key: `fund:${f.fund_code}`, label: f.fund_name || f.fund_code, fund_code: f.fund_code, as_of: asOf, available: true })),
      { key: 'total', label: 'Total', as_of: asOf, available: true, is_total: true }];
  } else {
    columns = colDefs.map((c) => ({ key: c.key, label: c.label, as_of: c.as_of, available: c.available, reason: c.reason }));
  }
  const valuesFor = (pick) => {   // pick(engineResult, column) -> number
    const out = {};
    for (const col of columns) {
      if (view === 'fund') out[col.key] = pick(cur, col);
      else out[col.key] = col.available ? pick(engine[col.key], col) : null;
    }
    return out;
  };
  const rowFund = (r, col) => (view !== 'fund' || col.is_total || r.fund_code === col.fund_code);

  // Every (account, fund) the engine reported in ANY available column.
  const accounts = new Map();   // key account_id|fund -> {account}
  for (const c of colDefs) {
    const e = engine[c.key]; if (!e) continue;
    for (const [secKey] of [['assets'], ['liabilities'], ['equity']]) {
      for (const r of e.sections[secKey]) {
        if (r.is_computed) continue;
        const k = `${r.account_id}|${r.fund_id || ''}`;
        if (!accounts.has(k)) accounts.set(k, { account_id: r.account_id, account_number: r.account_number, account_name: r.account_name, fund_id: r.fund_id, fund_code: r.fund_code, section: secKey });
      }
    }
  }
  const balOf = (e, a, col) => { if (!e) return null; const r = e.sections[a.section].find((x) => !x.is_computed && x.account_id === a.account_id && (x.fund_id || '') === (a.fund_id || '')); return r && rowFund(r, col) ? r.balance_cents : 0; };

  const sections = []; const warnings = []; const unmappedAll = [];
  const interfund = await interfundPairs(supabase, community_id, { view, columns, colDefs, engine, cur });
  for (const im of (interfund && interfund.imbalances) || []) {
    warnings.push({ code: 'interfund_imbalance', column: im.column, text: `Interfund imbalance (${im.label}, ${im.column_label}): ${im.receivable.number} shows ${fmtMoney(im.receivable_cents)} but ${im.payable.number} shows ${fmtMoney(im.payable_cents)}. Not eliminated; the funds' due-to / due-from balances need review.` });
  }
  for (const [type, label, secKey] of BS_SECTIONS) {
    const accts = [...accounts.values()].filter((a) => a.section === secKey).sort((a, b) => String(a.account_number).localeCompare(String(b.account_number)) || String(a.fund_code || '').localeCompare(String(b.fund_code || '')));
    const groups = new Map(); const unmapped = [];
    for (const a of accts) {
      const m = mapping.byAccount.get(a.account_id);
      const line = { kind: 'account', account_id: a.account_id, account_number: a.account_number, account_name: a.account_name, fund_id: a.fund_id, fund_code: a.fund_code,
        values: valuesFor((e, col) => balOf(e, a, col)), drill: { level: 'account', account_id: a.account_id, fund_id: a.fund_id || null } };
      if (!m) {
        const p = mapping.proposals.get(a.account_id);
        line.mapping = p ? { status: 'proposed', proposed_category: (p.leaf.report_label || p.leaf.name) } : { status: 'unmapped' };
        unmapped.push(line); unmappedAll.push({ account_id: a.account_id, account_number: a.account_number, account_name: a.account_name, section: type, proposed_category: line.mapping.proposed_category || null });
        continue;
      }
      const key = m.top.id;
      if (!groups.has(key)) groups.set(key, { kind: 'category', category_id: m.top.id, label: m.top.report_label || m.top.name, display_order: m.top.display_order, lines: [], _subs: new Map() });
      const g0 = groups.get(key);
      g0.lines.push(line);
      // Subcategory (one level, approved mapping): kept visible on every surface.
      if (m.leaf && m.leaf.id !== m.top.id) {
        line.subcategory_id = m.leaf.id;
        if (!g0._subs.has(m.leaf.id)) g0._subs.set(m.leaf.id, { category_id: m.leaf.id, label: m.leaf.report_label || m.leaf.name, display_order: m.leaf.display_order, lines: [] });
        g0._subs.get(m.leaf.id).lines.push(line);
      }
    }
    const cats = [...groups.values()].sort((a, b) => (a.display_order ?? 100) - (b.display_order ?? 100) || a.label.localeCompare(b.label));
    for (const g of cats) {
      g.values = sumCols(columns, g.lines); g.drill = { level: 'category', accounts: g.lines.map((l) => ({ account_id: l.account_id, fund_id: l.fund_id || null })) };
      if (g._subs.size) {
        // Subgroups in order; lines mapped to the category itself come first, unlabelled.
        const direct = g.lines.filter((l) => !l.subcategory_id);
        const subs = [...g._subs.values()].sort((a, b) => (a.display_order ?? 100) - (b.display_order ?? 100) || a.label.localeCompare(b.label));
        g.subgroups = [...(direct.length ? [{ category_id: null, label: null, lines: direct }] : []), ...subs]
          .map((sg) => ({ ...sg, values: sumCols(columns, sg.lines), drill: { level: 'category', accounts: sg.lines.map((l) => ({ account_id: l.account_id, fund_id: l.fund_id || null })) } }));
      }
      delete g._subs;
    }
    const groupsOut = [...cats];
    // Consolidation: matched interfund balances are eliminated (consolidated view only).
    if (type !== 'equity' && interfund && interfund.eliminated_any) {
      groupsOut.push({ kind: 'elimination', label: 'Less: interfund eliminations', lines: [],
        values: Object.fromEntries(columns.map((c) => [c.key, interfund.eliminated[c.key] === null ? null : -interfund.eliminated[c.key]])) });
    }
    if (unmapped.length) {
      const g = { kind: 'unmapped', label: 'Unmapped', lines: unmapped, values: sumCols(columns, unmapped), drill: { level: 'category', accounts: unmapped.map((l) => ({ account_id: l.account_id, fund_id: l.fund_id || null })) } };
      groupsOut.push(g);
    }
    const sec = { key: type, label, groups: groupsOut };
    // Fund balance: engine values only. Beginning = the equity accounts as the
    // engine reports them; current-year activity = the engine's computed
    // current-year net (it already includes a conversion's opening YTD).
    if (type === 'equity') {
      const accountsTotal = sumCols(columns, groupsOut.flatMap((g) => g.lines));
      const niVals = valuesFor((e, col) => { const r = e && e.sections.equity.find((x) => x.is_computed); if (!r) return 0; if (view === 'fund' && !col.is_total) return Number((r.by_fund || {})[col.fund_code] || 0); return r.balance_cents; });
      sec.fund_balance = {
        beginning: { label: 'Beginning fund balance', values: accountsTotal },
        current_year_activity: { label: 'Current-year activity', values: niVals, drill: { level: 'current_year_activity' } },
      };
      sec.total = { label: 'Total fund balance', values: sumColsVals(columns, [accountsTotal, niVals]) };
      // memo: fund split (engine fund totals), consolidated current column only
      sec.memo = view === 'fund' ? [] : (cur.funds || []).map((f) => ({ label: `${f.fund_name || f.fund_code} fund`, fund_code: f.fund_code,
        values: valuesFor((e) => (e && e.fund_totals[f.fund_code] ? e.fund_totals[f.fund_code].equity_cents : null)) }));
      // Tie-out: beginning + current-year activity = the engine's total equity.
      sec.tie_out = columns.map((col) => {
        const engTot = view === 'fund' ? (col.is_total ? cur.totals.equity_cents : (cur.fund_totals[col.fund_code] || {}).equity_cents) : (engine[col.key] ? engine[col.key].totals.equity_cents : null);
        const shown = sec.total.values[col.key];
        return { column: col.key, engine_total: engTot ?? null, shown, ties: engTot === null || engTot === undefined ? shown === null : shown === engTot };
      });
    } else {
      sec.total = { label: `Total ${label.toLowerCase()}`, values: sumCols(columns, groupsOut.flatMap((g) => g.lines)) };
      const elim = groupsOut.find((g) => g.kind === 'elimination');
      if (elim) sec.total.values = sumColsVals(columns, [sec.total.values, elim.values]);
    }
    sections.push(sec);
  }
  const liabEq = sumColsVals(columns, [sections[1].total.values, sections[2].total.values]);
  const totals = {
    assets: sections[0].total.values, liabilities: sections[1].total.values, fund_balance: sections[2].total.values, liabilities_and_fund_balance: liabEq,
    balanced: Object.fromEntries(columns.map((c) => [c.key, sections[0].total.values[c.key] === null ? null : sections[0].total.values[c.key] === liabEq[c.key]])),
  };
  // Every group ties to the engine: assets total = engine totals.assets_cents.
  const engineTie = columns.map((col) => {
    const e = view === 'fund' ? cur : engine[col.key];
    if (!e) return { column: col.key, ties: sections[0].total.values[col.key] === null };
    const engAssets = view === 'fund' && !col.is_total ? (e.fund_totals[col.fund_code] || {}).assets_cents : e.totals.assets_cents;
    const eliminated = interfund && interfund.eliminated_any ? Number(interfund.eliminated[col.key] || 0) : 0;
    return { column: col.key, engine_assets: engAssets, ...(eliminated ? { interfund_eliminated: eliminated } : {}), shown_assets: sections[0].total.values[col.key], ties: engAssets - eliminated === sections[0].total.values[col.key] };
  });
  if (!mapping.available) warnings.push({ code: 'mapping_unavailable', text: 'Balance-sheet categories are not set up yet (migration 505). Every account is listed under Unmapped and counted in every total.' });
  if (unmappedAll.length) warnings.push({ code: 'unmapped_accounts', count: unmappedAll.length, text: `${unmappedAll.length} account${unmappedAll.length === 1 ? ' is' : 's are'} not yet mapped to an approved balance-sheet category. ${unmappedAll.length === 1 ? 'It is' : 'They are'} listed under Unmapped and included in every total. Approve the mapping (or record an owner override) before a board packet can be finalized; the period must also be closed.` });
  for (const t of engineTie) if (!t.ties) warnings.push({ code: 'engine_tie_failed', column: t.column, text: `The ${t.column} column does not tie to the statement engine.` });

  const model = {
    model_version: MODEL_VERSION, kind: 'balance_sheet', view,
    community: { id: community.id, name: community.name, legal_name: community.legal_name || null },
    title: 'Balance Sheet', subtitle: `As of ${longDate(asOf)}`, basis: 'Accrual basis',
    period: { as_of: asOf, books_start: start },
    lifecycle: await lifecycle(supabase, community_id, asOf),
    columns, sections, totals, engine_tie: engineTie,
    ...(interfund ? { interfund: { pairs: interfund.pairs, eliminated: interfund.eliminated, eliminated_any: interfund.eliminated_any, imbalances: interfund.imbalances } } : {}),
    mapping: { available: mapping.available, approved_count: mapping.byAccount.size, unmapped: unmappedAll, mapping_complete: mapping.available && unmappedAll.length === 0 },
    warnings, generated_at: new Date(now).toISOString(),
  };
  model.snapshot_sha256 = modelSha(model);
  return model;
}

// Interfund pairs: the SAME accounts the posting chokepoint bridges with
// (lib/accounting/interfund.js resolveInterfund): Operating's "due from <fund>"
// with the fund's "due to Operating", and the fund's "due from Operating" with
// Operating's "due to <fund>". In the CONSOLIDATED view a pair is eliminated only
// when the receivable equals the payable exactly; otherwise it is left gross and
// reported as an imbalance. The by-fund view shows them normally (imbalances are
// still reported). Returns null when the community has no resolvable pair.
const fmtMoney = (c) => { const n = Number(c) / 100; const t = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return n < 0 ? `(${t})` : t; };
async function interfundPairs(supabase, cid, { view, columns, colDefs, engine, cur }) {
  let resolved = null;
  try { resolved = await require('../accounting/interfund').resolveInterfund(supabase, cid); } catch (e) { console.warn('[statements] interfund resolve failed:', e.message); return null; }
  if (!resolved || !Object.keys(resolved.map || {}).length) return null;
  const { data: accts, error } = await supabase.from('chart_of_accounts').select('id, account_number, account_name, fund_id').eq('community_id', cid).limit(5000);
  if (error) throw Object.assign(new Error(`interfund accounts: ${error.message}`), { code: error.code });
  const { data: funds } = await supabase.from('account_funds').select('id, fund_code').eq('community_id', cid).limit(50);
  const A = new Map((accts || []).map((a) => [a.id, a])); const FC = new Map((funds || []).map((f) => [f.id, f.fund_code]));
  const ref = (id) => { const a = A.get(id) || {}; return { account_id: id, number: a.account_number || null, name: a.account_name || null }; };
  const bal = (e, id, sec) => (e ? e.sections[sec].filter((r) => !r.is_computed && r.account_id === id).reduce((t, r) => t + Number(r.balance_cents || 0), 0) : null);
  const pairs = [];
  for (const [fid, m] of Object.entries(resolved.map)) {
    const fc = FC.get(fid) || fid;
    pairs.push({ label: `Operating owed by ${fc}`, fund_code: fc, receivable: ref(m.oprDueFrom), payable: ref(m.fundDueTo) });
    pairs.push({ label: `${fc} owed by Operating`, fund_code: fc, receivable: ref(m.fundDueFrom), payable: ref(m.oprDueTo) });
  }
  const eliminated = {}; const imbalances = []; let any = false;
  const cols = view === 'fund' ? [{ key: 'total', label: 'Total', e: cur }] : colDefs.map((c) => ({ key: c.key, label: c.label, e: engine[c.key] }));
  for (const c of columns) eliminated[c.key] = c.available === false ? null : 0;
  for (const p of pairs) {
    p.by_column = {};
    for (const c of cols) {
      if (!c.e) { p.by_column[c.key] = null; continue; }
      const R = bal(c.e, p.receivable.account_id, 'assets'); const P = bal(c.e, p.payable.account_id, 'liabilities');
      const status = R === P ? (R === 0 ? 'zero' : 'matched') : 'imbalance';
      p.by_column[c.key] = { receivable_cents: R, payable_cents: P, status };
      if (status === 'imbalance') imbalances.push({ label: p.label, column: c.key, column_label: c.label, receivable: p.receivable, payable: p.payable, receivable_cents: R, payable_cents: P });
      if (status === 'matched' && view !== 'fund') { eliminated[c.key] += R; any = true; }
    }
  }
  return { pairs, eliminated, eliminated_any: any, imbalances };
}

// A column not available in trustEd is null at every level, including a group or
// section with no lines (an empty sum is not a zero).
const naCol = (c) => c.available === false;
function sumCols(columns, lines) { return Object.fromEntries(columns.map((c) => [c.key, naCol(c) ? null : sumN(lines.map((l) => l.values[c.key]))])); }
function sumColsVals(columns, valsList) { return Object.fromEntries(columns.map((c) => [c.key, naCol(c) ? null : sumN(valsList.map((v) => v[c.key]))])); }
function longDate(d) { const [y, m, dd] = day(d).split('-').map(Number); return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${dd}, ${y}`; }

// ======================================================= INCOME vs BUDGET
// fund: a fund code (OPR, RES, ...) or 'all'. Prior-year columns are included
// only when that period is available in trustEd.
async function buildIncomeBudgetModel(supabase, { community_id, period_end, fund = 'all', now = new Date() }) {
  if (!community_id || !period_end) throw Object.assign(new Error('community_id_and_period_end_required'), { code: 'invalid_input' });
  const end = day(period_end);
  const { loadReportMapping } = require('../accounting/report_categories');
  const [community, bva, mapping] = await Promise.all([
    loadCommunity(supabase, community_id),
    FS.budgetVsActual({ community_id, period_end: end }),
    loadReportMapping(supabase, community_id),
  ]);
  const rows = (bva.rows || []).filter((r) => fund === 'all' || (r.fund_code || 'OPR') === fund);

  // Prior year (same month + YTD) only when available.
  const pyEnd = `${Number(end.slice(0, 4)) - 1}${end.slice(4)}`;
  let prior = null, priorNote = null;
  const py = await FS.budgetVsActual({ community_id, period_end: pyEnd });
  const pyAvail = py.availability && py.availability.mtd.status === 'available' && py.availability.ytd.status === 'available';
  if (pyAvail) prior = new Map((py.rows || []).map((r) => [`${r.account_id}|${r.fund_id || ''}`, r]));
  else priorNote = `Prior-year comparison is hidden: ${longDate(pyEnd).replace(/ \d+,/, ',')} is not available in TrustEd.`;

  const columns = [
    { key: 'mtd_actual', label: 'Month actual' }, { key: 'mtd_budget', label: 'Month budget' }, { key: 'mtd_var', label: 'Variance $' }, { key: 'mtd_var_pct', label: 'Variance %', is_pct: true },
    { key: 'ytd_actual', label: 'YTD actual' }, { key: 'ytd_budget', label: 'YTD budget' }, { key: 'ytd_var', label: 'YTD variance $' }, { key: 'ytd_var_pct', label: 'YTD variance %', is_pct: true },
    ...(prior ? [{ key: 'py_mtd_actual', label: 'Prior-year month' }, { key: 'py_ytd_actual', label: 'Prior-year YTD' }] : []),
  ];
  const lineValues = (r) => {
    const v = {
      mtd_actual: r.mtd_actual_cents, mtd_budget: r.mtd_budget_cents, mtd_var: r.mtd_variance_cents, mtd_var_pct: pct(r.mtd_variance_cents, r.mtd_budget_cents),
      ytd_actual: r.ytd_actual_cents, ytd_budget: r.ytd_budget_cents, ytd_var: r.ytd_variance_cents, ytd_var_pct: pct(r.ytd_variance_cents, r.ytd_budget_cents),
    };
    if (prior) { const p = prior.get(`${r.account_id}|${r.fund_id || ''}`); v.py_mtd_actual = p ? p.mtd_actual_cents : 0; v.py_ytd_actual = p ? p.ytd_actual_cents : 0; }
    return v;
  };
  const sumKeys = columns.filter((c) => !c.is_pct).map((c) => c.key);
  // A period not available in trustEd has no actual at any level, even when it
  // has no account rows to carry the null up (an empty sum is not a zero).
  const mtdNA = !!(bva.availability && bva.availability.mtd && bva.availability.mtd.status === 'not_available');
  const ytdNA = !!(bva.availability && bva.availability.ytd && bva.availability.ytd.status === 'not_available');
  const totalOf = (lines, type) => {
    const t = Object.fromEntries(sumKeys.map((k) => [k, sumN(lines.map((l) => l.values[k]))]));
    if (mtdNA) t.mtd_actual = null;
    if (ytdNA) t.ytd_actual = null;
    // Variance of a total is computed from the total's own actual and budget (same convention).
    t.mtd_var = t.mtd_actual === null ? null : favorableVariance(type, t.mtd_budget, t.mtd_actual);
    t.ytd_var = t.ytd_actual === null ? null : favorableVariance(type, t.ytd_budget, t.ytd_actual);
    t.mtd_var_pct = pct(t.mtd_var, t.mtd_budget); t.ytd_var_pct = pct(t.ytd_var, t.ytd_budget);
    return t;
  };

  const sections = [];
  for (const [type, label] of [['revenue', 'Revenue'], ['expense', 'Expenses']]) {
    const lines = rows.filter((r) => r.account_type === type).map((r) => ({
      kind: 'account', account_id: r.account_id, account_number: r.account_number, account_name: r.account_name, fund_id: r.fund_id || null, fund_code: r.fund_code || null,
      values: lineValues(r), ytd_carryforward: r.ytd_carryforward_cents || 0,
      drill: { level: 'account', account_id: r.account_id, fund_id: r.fund_id || null },
    }));
    const groups = new Map(); const unmapped = [];
    for (const l of lines) {
      const m = mapping.byAccount.get(l.account_id);
      if (!m || m.top.section !== type) { l.mapping = { status: 'unmapped' }; unmapped.push(l); continue; }
      if (!groups.has(m.top.id)) groups.set(m.top.id, { kind: 'category', category_id: m.top.id, label: m.top.report_label || m.top.name, display_order: m.top.display_order, lines: [] });
      groups.get(m.top.id).lines.push(l);
    }
    // Without any income-statement categories, each account is its own line (nothing inferred).
    const cats = mapping.has_mapping ? [...groups.values()].sort((a, b) => (a.display_order ?? 100) - (b.display_order ?? 100) || a.label.localeCompare(b.label)) : [];
    const ungrouped = mapping.has_mapping ? unmapped : lines;
    for (const g of cats) { g.lines.sort((a, b) => String(a.account_number).localeCompare(String(b.account_number))); g.values = totalOf(g.lines, type); g.drill = { level: 'category', accounts: g.lines.map((l) => ({ account_id: l.account_id, fund_id: l.fund_id })) }; }
    const out = [...cats];
    if (ungrouped.length) out.push({ kind: mapping.has_mapping ? 'unmapped' : 'accounts', label: mapping.has_mapping ? 'Unmapped' : 'Accounts', lines: ungrouped, values: totalOf(ungrouped, type), drill: { level: 'category', accounts: ungrouped.map((l) => ({ account_id: l.account_id, fund_id: l.fund_id })) } });
    sections.push({ key: type, label, groups: out, total: { label: `Total ${label.toLowerCase()}`, values: totalOf(lines, type) } });
  }
  const net = {};
  for (const k of sumKeys) net[k] = addN(sections[0].total.values[k], sections[1].total.values[k] === null ? null : -sections[1].total.values[k]);
  // Net variance: (net actual - net budget) is favorable-positive for a net figure.
  net.mtd_var = net.mtd_actual === null ? null : net.mtd_actual - net.mtd_budget;
  net.ytd_var = net.ytd_actual === null ? null : net.ytd_actual - net.ytd_budget;
  net.mtd_var_pct = pct(net.mtd_var, net.mtd_budget); net.ytd_var_pct = pct(net.ytd_var, net.ytd_budget);

  const carry = (bva.carryforward && bva.carryforward.windows && bva.carryforward.windows[0]) || null;
  const carryRev = rows.filter((r) => r.account_type === 'revenue').reduce((t, r) => t + (r.ytd_carryforward_cents || 0), 0);
  const carryExp = rows.filter((r) => r.account_type === 'expense').reduce((t, r) => t + (r.ytd_carryforward_cents || 0), 0);
  const notes = [];
  if (bva.availability && bva.availability.mtd.note) notes.push({ code: 'month_availability', text: `Month: ${bva.availability.mtd.note}` });
  if (bva.availability && bva.availability.ytd.note) notes.push({ code: 'ytd_availability', text: `Year to date: ${bva.availability.ytd.note}` });
  if (priorNote) notes.push({ code: 'prior_year_hidden', text: priorNote });
  if (carry && (carryRev || carryExp)) notes.push({ code: 'carryforward', text: `Year-to-date actuals include ${carry.label}.` });
  const fundLabel = fund === 'all' ? 'All funds' : `${fund} fund`;

  const model = {
    model_version: MODEL_VERSION, kind: 'income_budget', fund,
    community: { id: community.id, name: community.name, legal_name: community.legal_name || null },
    title: 'Statement of Revenues and Expenses vs Budget', subtitle: `${fundLabel} · month and year to date ended ${longDate(end)}`, basis: 'Accrual basis',
    period: { period_end: end, month_start: `${end.slice(0, 7)}-01`, year_start: `${end.slice(0, 4)}-01-01`, prior_year_included: !!prior },
    lifecycle: await lifecycle(supabase, community_id, end),
    variance_convention: 'favorable_positive', has_budget: !!bva.has_budget,
    columns, sections, net: { label: 'Net income', values: net },
    carryforward: carry && (carryRev || carryExp) ? { label: carry.label, through: carry.through, revenue: carryRev, expense: carryExp } : null,
    mapping: { has_mapping: mapping.has_mapping },
    notes, warnings: [], generated_at: new Date(now).toISOString(),
  };
  model.snapshot_sha256 = modelSha(model);
  return model;
}

module.exports = { MODEL_VERSION, buildBalanceSheetModel, buildIncomeBudgetModel, modelSha, statementContent, HASH_EXCLUDED, canonical, lifecycle, lastOfPrevMonth, prevYearEnd };
