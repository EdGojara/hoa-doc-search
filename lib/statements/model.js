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
  const line = (l) => ({ ...pick(l, ['kind', 'account_id', 'account_number', 'account_name', 'entry_reference', 'fund_id', 'fund_code', 'ytd_carryforward', 'subcategory_id']), mapping: mapState(l.mapping), values: vals(l.values) });
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
    columns: (m.columns || []).map((c) => pick(c, ['key', 'label', 'band', 'as_of', 'available', 'reason', 'fund_code', 'is_total', 'is_pct', 'is_var'])),
    sections: (m.sections || []).map(section),
    notes: (m.notes || []).map(disclosure), warnings: (m.warnings || []).map(disclosure),
  };
  if (m.transfers) out.transfers = section(m.transfers);
  if (m.prior_period) out.prior_period = section(m.prior_period);
  if (m.change) out.change = labelled(m.change);
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
    // Operating first, then the other funds in their configured order (reserve
    // before special-purpose funds), never alphabetical.
    const rank = (f) => (f.fund_code === 'OPR' ? 0 : f.fund_code === 'RES' ? 1 : 2);
    const orderedFunds = [...cur.funds].sort((x, y) => rank(x) - rank(y) || (x.display_order ?? 99) - (y.display_order ?? 99) || String(x.fund_name || x.fund_code).localeCompare(String(y.fund_name || y.fund_code)));
    columns = [...orderedFunds.map((f) => ({ key: `fund:${f.fund_code}`, label: f.fund_name || f.fund_code, fund_code: f.fund_code, as_of: asOf, available: true })),
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
  const { data: funds } = await supabase.from('account_funds').select('id, fund_code, fund_name').eq('community_id', cid).limit(50);
  const A = new Map((accts || []).map((a) => [a.id, a])); const FC = new Map((funds || []).map((f) => [f.id, f.fund_code])); const FN = new Map((funds || []).map((f) => [f.id, f.fund_name || f.fund_code]));
  const ref = (id) => { const a = A.get(id) || {}; return { account_id: id, number: a.account_number || null, name: a.account_name || null }; };
  const bal = (e, id, sec) => (e ? e.sections[sec].filter((r) => !r.is_computed && r.account_id === id).reduce((t, r) => t + Number(r.balance_cents || 0), 0) : null);
  const pairs = [];
  for (const [fid, m] of Object.entries(resolved.map)) {
    const fc = FC.get(fid) || fid;
    const fn = FN.get(fid) || fc;
    pairs.push({ label: `${fn} owes Operating`, fund_code: fc, receivable: ref(m.oprDueFrom), payable: ref(m.fundDueTo) });
    pairs.push({ label: `Operating owes ${fn}`, fund_code: fc, receivable: ref(m.fundDueFrom), payable: ref(m.oprDueTo) });
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
// Interfund transfer configuration (migration 506) for a community's transfer
// accounts. Before 506 the columns do not exist: no account is configured and
// each transfer line stays in the fund it is posted to.
async function loadTransferConfig(supabase, community_id) {
  const acc = await supabase.from('chart_of_accounts').select('id, account_subtype, fund_id, interfund_from_fund_id, interfund_to_fund_id').eq('community_id', community_id).eq('account_subtype', 'interfund_transfer').limit(500);
  if (acc.error) { console.warn('[statements] interfund transfer configuration not available:', acc.error.message); return { accounts: new Map(), funds: [] }; }
  const funds = must(await supabase.from('account_funds').select('id, fund_code, fund_type').eq('community_id', community_id).limit(50), 'account_funds');
  return { accounts: new Map((acc.data || []).map((a) => [a.id, a])), funds };
}

// One line per (transfer account, fund side) for the statement of `fund`, signed
// as that fund sees it (in +, out -). Budget: a configured account's budget is
// the amount moving from -> to (a negative revenue line or an expense line is
// the outgoing leg: the same rule as budget_fund_summary.classifyByFund). When
// it is the ONLY configured account for that from -> to pair, it is shown on
// both sides; when each fund has its own account (a transfer-out account and a
// transfer-in account), each account's budget stays on its own side. Actual: the
// posted lines in each fund, by fund effect (revenue +, expense -). Unconfigured
// or misconfigured transfer accounts stay in the fund they are posted to, with
// a warning when misconfigured. The consolidated statement ('all') shows every
// side, so a balanced transfer nets to zero.
function transferLines({ allRows, fund, cfg, mtdNA, ytdNA, warnings }) {
  const { transferConfig } = require('../forecast/working_forecast_data');
  const FC = new Map(cfg.funds.map((f) => [f.id, f.fund_code]));
  const rowsByAcct = new Map();
  for (const r of allRows) if (r.account_subtype === 'interfund_transfer') { if (!rowsByAcct.has(r.account_id)) rowsByAcct.set(r.account_id, []); rowsByAcct.get(r.account_id).push(r); }
  const keys = ['mtd_actual', 'mtd_budget', 'ytd_actual', 'ytd_budget', 'annual_budget'];
  const B = { mtd_budget: 'mtd_budget_cents', ytd_budget: 'ytd_budget_cents', annual_budget: 'annual_budget_cents' };
  const A = { mtd_actual: 'mtd_actual_cents', ytd_actual: 'ytd_actual_cents' };
  const configured = new Map();   // account_id -> transfer
  for (const [id, rs] of rowsByAcct) {
    const a = cfg.accounts.get(id); if (!a) continue;
    const c = transferConfig(a, cfg.funds);
    if (c.transfer) configured.set(id, c.transfer);
    else if (c.transfer_config_error) warnings.push({ code: 'transfer_config_invalid', text: `${rs[0].account_number} ${rs[0].account_name}: ${c.transfer_config_error}; shown in the fund it is posted to.` });
  }
  const pairCount = new Map();
  for (const t of configured.values()) { const k = `${t.from_fund_id}>${t.to_fund_id}`; pairCount.set(k, (pairCount.get(k) || 0) + 1); }
  const out = [];
  const want = (code) => fund === 'all' || code === fund;
  const mk = (r0, fundId, code, values, side) => {
    values.mtd_var = values.mtd_actual === null ? null : values.mtd_actual - values.mtd_budget;
    values.ytd_var = values.ytd_actual === null ? null : values.ytd_actual - values.ytd_budget;
    return { kind: 'account', account_id: r0.account_id, account_number: r0.account_number, account_name: side ? `${r0.account_name} (${side})` : r0.account_name, fund_id: fundId, fund_code: code,
      values, drill: { level: 'account', account_id: r0.account_id, fund_id: fundId } };
  };
  for (const [id, rs] of rowsByAcct) {
    const t = configured.get(id);
    if (!t) {
      for (const r of rs) { const code = r.fund_code || 'OPR'; if (!want(code)) continue;
        const k = r.account_type === 'revenue' ? 1 : -1; const v = {};
        for (const key of keys) { const src = r[A[key] || B[key]]; v[key] = src === null || src === undefined ? (A[key] ? null : 0) : src * k; }
        out.push(mk(r, r.fund_id || null, code, v, null)); }
      continue;
    }
    const single = pairCount.get(`${t.from_fund_id}>${t.to_fund_id}`) === 1;
    // amount moving from -> to, per budget measure (positive)
    const moving = (r, col) => { const v = Number(r[col] || 0); const isExp = r.account_type === 'expense'; const outgoing = isExp || Number(r.annual_budget_cents || 0) < 0; return outgoing ? (isExp ? v : -v) : v; };
    const sides = [[t.from_fund_id, -1, `transfer to ${t.to_fund_code}`], [t.to_fund_id, 1, `transfer from ${t.from_fund_code}`]];
    for (const [fid, sign, label] of sides) {
      const code = FC.get(fid); if (!want(code)) continue;
      const here = rs.filter((r) => r.fund_id === fid);
      const budgetRows = single ? rs : here;
      if (!single && !here.length) continue;
      const v = {};
      for (const key of Object.keys(B)) v[key] = sign * budgetRows.reduce((s, r) => s + moving(r, B[key]), 0);
      for (const key of Object.keys(A)) {
        const na = key === 'mtd_actual' ? mtdNA : ytdNA;
        v[key] = na ? null : here.reduce((s, r) => addN(s, r[A[key]] === null || r[A[key]] === undefined ? (r[A[key]] === null ? null : 0) : (r.account_type === 'revenue' ? 1 : -1) * r[A[key]]), 0);
      }
      out.push(mk(rs[0], fid, code, v, single ? label : null));
    }
  }
  return out.sort((x, y) => String(x.account_number).localeCompare(String(y.account_number)) || String(x.fund_code).localeCompare(String(y.fund_code)));
}

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

  // Board layout (Ed 2026-10-11): seven numeric columns on one statement:
  // Current month (actual, budget, variance), Year to date (actual, budget,
  // variance) and the Annual budget. No percentage columns. The column band
  // (month / YTD / annual) is the column's `band`. Prior-year figures, when
  // available, stay in the model (values) but are not printed.
  const columns = [
    { key: 'mtd_actual', label: 'Actual', band: 'Current month' }, { key: 'mtd_budget', label: 'Budget', band: 'Current month' }, { key: 'mtd_var', label: 'Variance', band: 'Current month', is_var: true },
    { key: 'ytd_actual', label: 'Actual', band: 'Year to date' }, { key: 'ytd_budget', label: 'Budget', band: 'Year to date' }, { key: 'ytd_var', label: 'Variance', band: 'Year to date', is_var: true },
    { key: 'annual_budget', label: 'Budget', band: 'Annual' },
  ];
  const lineValues = (r) => {
    const v = {
      mtd_actual: r.mtd_actual_cents, mtd_budget: r.mtd_budget_cents, mtd_var: r.mtd_variance_cents,
      ytd_actual: r.ytd_actual_cents, ytd_budget: r.ytd_budget_cents, ytd_var: r.ytd_variance_cents,
      annual_budget: r.annual_budget_cents || 0,
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
    return t;
  };

  // Interfund transfers (account_subtype 'interfund_transfer': a reserve
  // contribution out of Operating and into Reserve) are neither revenue nor
  // expense: they print below the excess of revenue over expenses, signed as
  // the fund sees them (in +, out -), with variance = actual - budget so an
  // unpaid contribution is unfavorable to the receiving fund. (Ed 2026-10-11.)
  const isTransfer = (r) => r.account_subtype === 'interfund_transfer';
  const sections = [];
  for (const [type, label] of [['revenue', 'Revenue'], ['expense', 'Expenses']]) {
    const lines = rows.filter((r) => r.account_type === type && !isTransfer(r)).map((r) => ({
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

  let transfers = null, change = null, priorPeriod = null;
  const transferWarnings = [];
  // Prior-period items recorded this month: shown apart, by account, signed by
  // their effect on the fund balance (revenue +, expense -). Month only: year to
  // date already carries them in their accounts.
  const pRows = rows.filter((r) => !isTransfer(r) && Number(r.mtd_prior_period_cents || 0) !== 0);
  if (pRows.length && !mtdNA) {
    const pLines = pRows.map((r) => { const k = r.account_type === 'revenue' ? 1 : -1; const amt = k * Number(r.mtd_prior_period_cents);
      return { kind: 'account', account_id: r.account_id, account_number: r.account_number, account_name: r.account_name, fund_id: r.fund_id || null, fund_code: r.fund_code || null,
        values: { mtd_actual: amt, mtd_budget: 0, mtd_var: null, ytd_actual: 0, ytd_budget: 0, ytd_var: null, annual_budget: 0 }, drill: { level: 'account', account_id: r.account_id, fund_id: r.fund_id || null } }; })
      .sort((x, y) => String(x.account_number).localeCompare(String(y.account_number)));
    const pv = { mtd_actual: pLines.reduce((t, l) => t + l.values.mtd_actual, 0), mtd_budget: 0, mtd_var: null, ytd_actual: 0, ytd_budget: 0, ytd_var: null, annual_budget: 0 };
    priorPeriod = { key: 'prior_period', label: 'Prior-period items recorded this month', groups: [{ kind: 'category', label: 'Pre-cutover activity', lines: pLines, values: pv }], total: { label: 'Total prior-period items', values: pv } };
  }
  // Which fund each transfer touches comes from the account's configuration
  // (migration 506: interfund_from_fund_id / interfund_to_fund_id), the same
  // definition the budget summary and the working forecast use
  // (lib/accounting/budget_fund_summary.js). A budget recorded on ONE account
  // (e.g. Canyon Gate 4010, a negative line in Reserve = the outgoing leg) is a
  // transfer out of the from-fund and into the to-fund: each fund's statement
  // shows its side. Actuals come from the fund on each posted GL line.
  const tLines = transferLines({ allRows: bva.rows || [], fund, cfg: await loadTransferConfig(supabase, community_id), mtdNA, ytdNA, warnings: transferWarnings });
  if (tLines.length) {
    const tv = Object.fromEntries(sumKeys.map((k) => [k, sumN(tLines.map((l) => l.values[k]))]));
    if (mtdNA) tv.mtd_actual = null; if (ytdNA) tv.ytd_actual = null;
    tv.mtd_var = tv.mtd_actual === null ? null : tv.mtd_actual - tv.mtd_budget; tv.ytd_var = tv.ytd_actual === null ? null : tv.ytd_actual - tv.ytd_budget;
    transfers = { key: 'transfers', label: 'Interfund transfers', groups: [{ kind: 'category', label: 'Transfers in (out)', lines: tLines, values: tv }], total: { label: 'Total interfund transfers', values: tv } };
    const cv = {};
    for (const k of sumKeys) cv[k] = addN(net[k], tv[k]);
    cv.mtd_var = cv.mtd_actual === null ? null : cv.mtd_actual - cv.mtd_budget; cv.ytd_var = cv.ytd_actual === null ? null : cv.ytd_actual - cv.ytd_budget;
    change = { label: 'Net change in fund balance', values: cv };
  }
  if (priorPeriod) {
    const base = change ? change.values : net;
    const cv = Object.assign({}, base);
    cv.mtd_actual = base.mtd_actual === null ? null : base.mtd_actual + priorPeriod.total.values.mtd_actual;
    cv.mtd_var = cv.mtd_actual === null ? null : cv.mtd_actual - cv.mtd_budget;
    change = { label: 'Net change in fund balance', values: cv };
  }
  const carry = (bva.carryforward && bva.carryforward.windows && bva.carryforward.windows[0]) || null;
  const carryRev = rows.filter((r) => r.account_type === 'revenue' && !isTransfer(r)).reduce((t, r) => t + (r.ytd_carryforward_cents || 0), 0);
  const carryExp = rows.filter((r) => r.account_type === 'expense' && !isTransfer(r)).reduce((t, r) => t + (r.ytd_carryforward_cents || 0), 0);
  const notes = [];
  if (bva.availability && bva.availability.mtd.note) notes.push({ code: 'month_availability', text: `Month: ${bva.availability.mtd.note}` });
  if (bva.availability && bva.availability.ytd.note) notes.push({ code: 'ytd_availability', text: `Year to date: ${bva.availability.ytd.note}` });
  if (priorNote) notes.push({ code: 'prior_year_hidden', text: priorNote });
  if (carry && (carryRev || carryExp)) notes.push({ code: 'carryforward', text: `Year-to-date actuals include ${carry.label}.` });
  if (priorPeriod) notes.push({ code: 'prior_period', text: `Prior-period items recorded this month (activity from before the books moved to trustEd, carried to the cutover date, or corrections of it) are shown below the excess of revenue over expenses and excluded from the month's operating results; year-to-date figures include them in their accounts.` });
  let fundLabel = fund === 'all' ? 'All funds' : `${fund} fund`;
  if (fund !== 'all') {
    const { data: fr, error: fe } = await supabase.from('account_funds').select('fund_name').eq('community_id', community_id).eq('fund_code', fund).limit(1);
    if (!fe && fr && fr[0] && fr[0].fund_name) fundLabel = /fund$/i.test(fr[0].fund_name) ? fr[0].fund_name : `${fr[0].fund_name} Fund`;
  }

  const model = {
    model_version: MODEL_VERSION, kind: 'income_budget', fund,
    community: { id: community.id, name: community.name, legal_name: community.legal_name || null },
    title: 'Statement of Revenues and Expenses vs Budget', subtitle: `${fundLabel} · month and year to date ended ${longDate(end)}`, basis: 'Accrual basis',
    period: { period_end: end, month_start: `${end.slice(0, 7)}-01`, year_start: `${end.slice(0, 4)}-01-01`, prior_year_included: !!prior },
    lifecycle: await lifecycle(supabase, community_id, end),
    variance_convention: 'favorable_positive', has_budget: !!bva.has_budget,
    columns, sections, net: { label: transfers || priorPeriod ? 'Excess (deficit) of revenue over expenses' : 'Net income', values: net },
    ...(transfers ? { transfers } : {}), ...(priorPeriod ? { prior_period: priorPeriod } : {}), ...(change ? { change } : {}),
    carryforward: carry && (carryRev || carryExp) ? { label: carry.label, through: carry.through, revenue: carryRev, expense: carryExp } : null,
    mapping: { has_mapping: mapping.has_mapping },
    notes, warnings: transferWarnings, generated_at: new Date(now).toISOString(),
  };
  model.snapshot_sha256 = modelSha(model);
  return model;
}

// ======================================================= RESERVE FUND ACTIVITY
// The board schedule for a reserve (or any non-operating) fund, from posted GL
// data only (Ed 2026-10-11): the fund balance roll-forward (beginning, funding
// and investment income by category, expenditures by category, ending, tied to
// the balance sheet), every expenditure as posted (date, description, account,
// amount), and the interfund position. No project detail is inferred: the
// detail lines are the posted entries' own descriptions.
async function buildReserveActivityModel(supabase, { community_id, period_end, fund = 'RES', now = new Date() }) {
  if (!community_id || !period_end) throw Object.assign(new Error('community_id_and_period_end_required'), { code: 'invalid_input' });
  const end = day(period_end);
  const monthStart = `${end.slice(0, 7)}-01`, yearStart = `${end.slice(0, 4)}-01-01`;
  const [community, inc, bs] = await Promise.all([
    loadCommunity(supabase, community_id),
    buildIncomeBudgetModel(supabase, { community_id, period_end: end, fund, now }),
    buildBalanceSheetModel(supabase, { community_id, as_of: end, view: 'fund', now }),
  ]);
  const colKey = `fund:${fund}`;
  const eq = bs.sections.find((x) => x.key === 'equity');
  const ending = eq ? eq.total.values[colKey] : null;
  const yearBeginning = eq && eq.fund_balance ? eq.fund_balance.beginning.values[colKey] : null;
  const columns = [{ key: 'mtd', label: 'Current month' }, { key: 'ytd', label: 'Year to date' }];
  const v = (mtd, ytd) => ({ mtd, ytd });
  const rev = inc.sections.find((x) => x.key === 'revenue'), exp = inc.sections.find((x) => x.key === 'expense');
  const asGroup = (g, sign) => ({ kind: 'category', category_id: g.category_id || null, label: g.label, display_order: g.display_order ?? null,
    values: v(g.values.mtd_actual === null ? null : sign * g.values.mtd_actual, g.values.ytd_actual === null ? null : sign * g.values.ytd_actual),
    lines: g.lines.map((l) => ({ kind: 'account', account_id: l.account_id, account_number: l.account_number, account_name: l.account_name, fund_id: l.fund_id, fund_code: l.fund_code,
      values: v(l.values.mtd_actual === null ? null : sign * l.values.mtd_actual, l.values.ytd_actual === null ? null : sign * l.values.ytd_actual), drill: l.drill })) });
  const fin = inc.change || inc.net;
  const netMtd = fin.values.mtd_actual, netYtd = fin.values.ytd_actual;
  const monthBeginning = ending === null || netMtd === null ? null : ending - netMtd;
  const rollGroups = [
    { kind: 'category', label: 'Beginning fund balance', values: v(monthBeginning, yearBeginning), lines: [] },
    ...(inc.transfers ? inc.transfers.groups.map((g) => Object.assign(asGroup(g, 1), { label: 'Interfund transfers in (out)' })) : []),
    ...(inc.prior_period ? inc.prior_period.groups.map((g) => Object.assign(asGroup(g, 1), { label: 'Prior-period items recorded this month', values: v(g.values.mtd_actual, 0) })) : []),
    ...rev.groups.map((g) => asGroup(g, 1)),
    ...exp.groups.map((g) => asGroup(g, -1)),
  ];
  const sections = [{ key: 'rollforward', label: 'Fund balance roll-forward', groups: rollGroups, total: { label: 'Ending fund balance', values: v(ending, ending) } }];

  // Every expenditure as posted, year to date, by account.
  const accIds = exp.groups.flatMap((g) => g.lines.map((l) => l.account_id));
  const fundIds = [...new Set(exp.groups.flatMap((g) => g.lines.map((l) => l.fund_id)).filter(Boolean))];
  if (accIds.length) {
    const { fetchAllQuery } = require('../db/fetch_all');
    const { countsInGl } = require('../accounting/je_status');
    let rows = await fetchAllQuery(() => {
      let q = supabase.from('journal_entry_lines').select('id, account_id, fund_id, debit_cents, credit_cents, memo, journal_entries!inner(id, reference, posting_date, description, status, void_reversal_je_id, source_module, community_id)')
        .in('account_id', accIds).eq('journal_entries.community_id', community_id).gte('journal_entries.posting_date', yearStart).lte('journal_entries.posting_date', end);
      if (fundIds.length) q = q.in('fund_id', fundIds);
      return q;
    }, { orderBy: 'id' });
    rows = rows.filter((r) => countsInGl(r.journal_entries) && r.journal_entries.source_module !== 'opening_entry');
    const detailGroups = [];
    for (const g of exp.groups) for (const l of g.lines) {
      const mine = rows.filter((r) => r.account_id === l.account_id).sort((a, b) => String(a.journal_entries.posting_date).localeCompare(String(b.journal_entries.posting_date)) || String(a.journal_entries.reference).localeCompare(String(b.journal_entries.reference)));
      if (!mine.length) continue;
      const lines = mine.map((r) => { const amt = Number(r.debit_cents) - Number(r.credit_cents); const d = r.journal_entries.posting_date;
        return { kind: 'entry', account_id: l.account_id, account_number: shortUs(d), account_name: (r.memo && r.memo.trim()) || r.journal_entries.description || r.journal_entries.reference,
          entry_reference: r.journal_entries.reference, values: v(d >= monthStart ? amt : 0, amt), drill: { level: 'entry', je_id: r.journal_entries.id } }; });
      const sum = (k) => lines.reduce((t, x) => t + x.values[k], 0);
      detailGroups.push({ kind: 'category', label: `${l.account_number} ${l.account_name}`, values: v(sum('mtd'), sum('ytd')), lines });
    }
    if (detailGroups.length) {
      const tot = (k) => detailGroups.reduce((t, g) => t + g.values[k], 0);
      sections.push({ key: 'expenditures', label: 'Expenditures as posted', groups: detailGroups, total: { label: 'Total expenditures', values: v(tot('mtd'), tot('ytd')) } });
    }
  }

  const notes = [];
  const warnings = [];
  // Only the pairs that involve THIS fund: its code in the pair label, or its
  // name in either account's name.
  const pairFundName = ((bs.columns.find((c) => c.key === colKey) || {}).label || fund).toLowerCase();
  const pairs = ((bs.interfund && bs.interfund.pairs) || []).filter((p) => p.label.split(/\s+/).includes(fund)
    || `${p.receivable.name} ${p.payable.name}`.toLowerCase().includes(pairFundName));
  for (const p of pairs) {
    const bal = p.by_column && (p.by_column.total || p.by_column[colKey]);
    if (bal && bal.receivable_cents) notes.push({ code: 'interfund', text: `${p.label}: ${p.receivable.number} ${p.receivable.name} / ${p.payable.number} ${p.payable.name} ${money2(bal.receivable_cents)} at ${longDate(end)} (${bal.status}).` });
  }
  // The roll-forward must tie: beginning + year-to-date activity = ending.
  if (yearBeginning !== null && netYtd !== null && ending !== null && yearBeginning + netYtd !== ending) {
    warnings.push({ code: 'rollforward_tie', text: `Roll-forward does not tie: beginning ${money2(yearBeginning)} + activity ${money2(netYtd)} differs from the balance sheet ${money2(ending)}. Do not distribute.` });
  }
  for (const n of inc.notes || []) if (n.code === 'carryforward') notes.push(n);
  const fundName = (bs.columns.find((c) => c.key === colKey) || {}).label || fund;
  const model = {
    model_version: MODEL_VERSION, kind: 'reserve_activity', fund,
    community: { id: community.id, name: community.name, legal_name: community.legal_name || null },
    title: `${fundName} Fund Activity`, subtitle: `Month and year to date ended ${longDate(end)}`, basis: 'Accrual basis',
    period: { period_end: end, month_start: monthStart, year_start: yearStart },
    lifecycle: await lifecycle(supabase, community_id, end),
    columns, sections, notes, warnings, generated_at: new Date(now).toISOString(),
  };
  model.snapshot_sha256 = modelSha(model);
  return model;
}
function shortUs(d) { const [y, m, dd] = day(d).split('-'); return `${m}/${dd}/${y}`; }
function money2(c) { const n = Number(c) || 0; const s = (Math.abs(n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return n < 0 ? `($${s})` : `$${s}`; }

// ======================================================= PROPOSED BUDGET
// The board's proposed-budget statement for one fund (Ed 2026-10-11): every
// account under the same reporting categories as the monthly statements, with
// the base year's approved budget, actual to date and projection (the working
// forecast: actual through as_of + the remaining approved budget) beside the
// target year's draft budget. Funds are separate. A transfer between funds is
// never revenue or expense: it uses the account's from / to configuration
// (budget_fund_summary.classifyByFund, the same classification as the board
// portal and the working forecast) and prints below the excess of revenue over
// expenses. summary: category totals only. Nothing here invents an amount: the
// proposed column is the saved draft budget, line for line.
async function buildProposedBudgetModel(supabase, { community_id, target_year, as_of, fund = 'OPR', budget_id = null, summary = false, now = new Date() }) {
  if (!community_id || !target_year || !as_of) throw Object.assign(new Error('community_id_target_year_and_as_of_required'), { code: 'invalid_input' });
  const D = require('../forecast/working_forecast_data'); const W = require('../forecast/working_forecast');
  const { classifyByFund } = require('../accounting/budget_fund_summary');
  const { loadReportMapping } = require('../accounting/report_categories');
  const ty = Number(target_year), by = ty - 1, asOf = day(as_of);
  const [community, input, mapping] = await Promise.all([loadCommunity(supabase, community_id), D.loadWorkingForecastInput(supabase, { community_id, target_year: ty, as_of: asOf }), loadReportMapping(supabase, community_id)]);
  const wf = W.buildWorkingForecast(input, { now });
  let bq = supabase.from('community_budgets').select('id, fiscal_year, status').eq('community_id', community_id).eq('fiscal_year', ty);
  if (budget_id) bq = bq.eq('id', budget_id);
  const budgets = must(await bq.order('created_at', { ascending: false }).limit(10), 'community_budgets');
  const draft = budgets.find((b) => b.status === 'draft') || (budget_id ? budgets[0] : null);
  if (!draft) throw Object.assign(new Error(`no draft ${ty} budget`), { code: 'not_found' });
  const draftLines = must(await supabase.from('budget_line_items').select('account_id, fund_id, annual_amount_cents').eq('budget_id', draft.id).limit(2000), 'budget_line_items');
  const coaQ = (cols) => supabase.from('chart_of_accounts').select(cols).eq('community_id', community_id).in('account_type', ['revenue', 'expense']).limit(5000);
  let coaR = await coaQ('id, account_number, account_name, account_type, account_subtype, fund_id, interfund_from_fund_id, interfund_to_fund_id');
  if (coaR.error && /interfund_|does not exist|schema cache/i.test(coaR.error.message || '')) coaR = await coaQ('id, account_number, account_name, account_type, account_subtype, fund_id');
  const accounts = must(coaR, 'chart_of_accounts');
  const funds = must(await supabase.from('account_funds').select('id, fund_code, fund_name, fund_type, display_order').eq('community_id', community_id).limit(50), 'account_funds');
  const A = new Map(accounts.map((a) => [a.id, a]));
  const fundOf = (accountId, fundId) => fundId || (A.get(accountId) || {}).fund_id || null;
  // One row per (account, fund): base year from the forecast, target year from the draft.
  const rows = new Map();
  const row = (accountId, fundId) => {
    const k = `${accountId}|${fundOf(accountId, fundId) || ''}`;
    if (!rows.has(k)) rows.set(k, { account_id: accountId, fund_id: fundOf(accountId, fundId), appr: 0, ytd: 0, proj: 0, prop: 0 });
    return rows.get(k);
  };
  for (const l of wf.lines) { const r = row(l.account_id, l.fund_id); const b = l.base_year || {}; r.appr += Number(b.approved_budget_cents || 0); r.ytd += Number(b.ytd_actual_cents || 0); r.proj += Number(b.current_forecast_cents || 0); }
  for (const l of draftLines) row(l.account_id, l.fund_id).prop += Number(l.annual_amount_cents || 0);
  const c = classifyByFund({ rows: [...rows.values()], accounts, funds, measures: ['prop', 'appr', 'ytd', 'proj'] });
  const f = funds.find((x) => x.fund_code === fund);
  if (!f) throw Object.assign(new Error(`fund ${fund} not found`), { code: 'not_found' });
  const g = c.funds.find((x) => x.fund_id === f.id) || { revenue: [], expense: [], transfers: [] };
  const K = ['appr', 'ytd', 'proj', 'prop', 'chg'];
  const vals = (r) => ({ appr: r.appr, ytd: r.ytd, proj: r.proj, prop: r.prop, chg: r.prop - r.appr });
  const add = (ls) => { const t = { appr: 0, ytd: 0, proj: 0, prop: 0 }; for (const l of ls) for (const k of Object.keys(t)) t[k] += l.values[k]; t.chg = t.prop - t.appr; return t; };
  const sections = [];
  for (const [type, label] of [['revenue', 'Revenue'], ['expense', 'Expenses']]) {
    const lines = (g[type] || []).filter((r) => r.appr || r.ytd || r.proj || r.prop).map((r) => {
      const a = A.get(r.account_id);
      return { kind: 'account', account_id: r.account_id, account_number: a.account_number, account_name: a.account_name, fund_id: r.fund_id, fund_code: fund, values: vals(r) };
    }).sort((x, y) => String(x.account_number).localeCompare(String(y.account_number)));
    const groups = new Map(); const unmapped = [];
    for (const l of lines) {
      const mm = mapping.byAccount.get(l.account_id);
      if (!mm || mm.top.section !== type) { l.mapping = { status: 'unmapped' }; unmapped.push(l); continue; }
      if (!groups.has(mm.top.id)) groups.set(mm.top.id, { kind: 'category', category_id: mm.top.id, label: mm.top.report_label || mm.top.name, display_order: mm.top.display_order, lines: [] });
      groups.get(mm.top.id).lines.push(l);
    }
    const gs = mapping.has_mapping ? [...groups.values()].sort((x, y) => (x.display_order ?? 100) - (y.display_order ?? 100) || x.label.localeCompare(y.label)) : [];
    for (const gr of gs) gr.values = add(gr.lines);
    if (!mapping.has_mapping) gs.push({ kind: 'accounts', label, lines, values: add(lines) });
    else if (unmapped.length) gs.push({ kind: 'unmapped', label: 'Unmapped', lines: unmapped, values: add(unmapped) });
    if (summary) for (const gr of gs) if (gr.kind === 'category') gr.lines = [];
    sections.push({ key: type, label, groups: gs, total: { label: `Total ${type === 'revenue' ? 'revenue' : 'expenses'}`, values: add(lines) } });
  }
  const net = Object.fromEntries(K.map((k) => [k, sections[0].total.values[k] - sections[1].total.values[k]]));
  let transfers = null, change = null;
  if ((g.transfers || []).length) {
    const tl = g.transfers.map((t) => {
      const k = t.direction === 'out' ? -1 : 1;
      const v = { appr: k * (t.appr || 0), ytd: k * (t.ytd || 0), proj: k * (t.proj || 0), prop: k * (t.prop || 0) }; v.chg = v.prop - v.appr;
      return { kind: 'account', account_id: t.account_id, account_number: t.account_number, account_name: `${t.account_name} (${t.direction === 'out' ? `transfer to ${t.to_fund_code}` : `transfer from ${t.from_fund_code}`})`, fund_code: fund, values: v };
    });
    const tv = add(tl);
    transfers = { key: 'transfers', label: 'Interfund transfers', groups: [{ kind: 'category', label: 'Transfers in (out)', lines: tl, values: tv }], total: { label: 'Total interfund transfers', values: tv } };
    change = { label: 'Net change in fund balance', values: Object.fromEntries(K.map((k) => [k, net[k] + tv[k]])) };
  }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const asLabel = `${MON[Number(asOf.slice(5, 7)) - 1]} ${Number(asOf.slice(8, 10))}`;
  const columns = [
    { key: 'appr', label: 'Approved budget', band: String(by) }, { key: 'ytd', label: `Actual through ${asLabel}`, band: String(by) }, { key: 'proj', label: 'Projected', band: String(by) },
    { key: 'prop', label: 'Proposed', band: String(ty) }, { key: 'chg', label: `Change vs ${by} budget`, band: String(ty) },
  ];
  const notes = [
    { code: 'projection', text: `${by} projected = actual through ${longDate(asOf)} plus the remaining ${by} approved budget for the rest of the year.` },
    { code: 'proposed', text: `${ty} proposed = the ${ty} draft budget, line for line. It has not been adopted by the Board of Directors.` },
  ];
  if (transfers) notes.push({ code: 'transfers', text: 'A transfer between funds (for example the planned Reserve contribution) is neither revenue nor expense. It is shown below the excess of revenue over expenses as a transfer out of the paying fund and a transfer in to the receiving fund.' });
  const model = {
    model_version: MODEL_VERSION, kind: 'income_budget', fund, view: 'proposed_budget',
    community: { id: community.id, name: community.name, legal_name: community.legal_name || null },
    title: summary ? `Proposed ${ty} Budget · Summary` : `Proposed ${ty} Budget`,
    subtitle: `${f.fund_name || fund} Fund · with the ${by} budget, actual through ${longDate(asOf)} and projection`, basis: 'Accrual basis',
    period: { target_year: ty, base_year: by, as_of: asOf, budget_id: draft.id, budget_status: draft.status },
    lifecycle: { status: 'draft', label: 'DRAFT – PROPOSED, NOT APPROVED', note: 'For board review. Not adopted by the Board of Directors.' },
    columns, sections, net: { label: transfers ? 'Excess (deficit) of revenue over expenses' : 'Net income', values: net },
    ...(transfers ? { transfers, change } : {}),
    notes, warnings: (c.warnings || []).map((w) => ({ code: w.code, text: w.text })), generated_at: new Date(now).toISOString(),
  };
  model.snapshot_sha256 = modelSha(model);
  return model;
}

module.exports = { MODEL_VERSION, buildBalanceSheetModel, buildIncomeBudgetModel, buildReserveActivityModel, buildProposedBudgetModel, modelSha, statementContent, HASH_EXCLUDED, canonical, lifecycle, lastOfPrevMonth, prevYearEnd };
