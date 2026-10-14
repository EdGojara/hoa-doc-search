// ============================================================================
// lib/budget/board_report.js  (Ed 2026-10-14: printable board budget report)
// ----------------------------------------------------------------------------
// The board's printed proposed budget: a PRESENTATION of records trustEd already
// keeps, never a second budget calculation. Every amount comes from
// lib/statements/model.buildProposedBudgetModel (the same model as the statement
// package and the board portal):
//   2026 approved   = the adopted base-year budget
//   2026 projected  = the working forecast: actual through the as-of date + the
//                     remaining approved budget (as the books stand: a reclassification
//                     awaiting approval is footnoted, never applied)
//   2027 proposed   = the saved target-year budget, line for line (PROPOSED until the
//                     budget's status is approved)
//   change          = proposed - approved, in dollars and percent
// Explanations for material changes come from the draft line's own basis or note and
// the contract review (contract, vendor, execution status); exceptions and board
// decisions come from the contract review and the working forecast. Nothing is
// invented: a missing explanation prints as missing.
// Community differences live in data (funds, categories, contracts), not here.
// ============================================================================

const M = require('../statements/model');

const MATERIAL = { min_cents: 250000, pct: 0.10 };   // $2,500 and 10% of the approved amount
const int = (n) => Math.round(Number(n) || 0);
const day = (d) => String(d || '').slice(0, 10);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (d) => { const [y, m, dd] = day(d).split('-').map(Number); return `${MONTHS[m - 1]} ${dd}, ${y}`; };

function pct(chg, base) { if (!base) return chg ? null : 0; return chg / Math.abs(base); }

// A draft line's note, made readable for a board: system prefixes and sign-off boilerplate removed.
function cleanNote(note) {
  let t = String(note || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^FY\d{4} draft( from working forecast [0-9a-f]+)?:\s*/i, '').replace(/^FY\d{4} draft:\s*/i, '');
  t = t.replace(/\s*Validated \d{4} recommendation \([^)]*\)\.?/gi, '').replace(/\s*Revised \d{4}-\d{2}-\d{2} \([^)]*\):[^.]*\.[^.]*\./gi, '');
  t = t.replace(/\s*\((?:library document|contract record)[^)]*\)/gi, '').replace(/\s*library document [0-9a-f]{8}[^,;.)]*/gi, '').replace(/,?\s*contract record [0-9a-f]{8}/gi, '');
  t = t.replace(/\s*Corrected \d{4}-\d{2}-\d{2}:[^.]*\./gi, '').replace(/\s*\((?:confirmed|authorized|approved|requested) by [^)]*\)/gi, '').replace(/\b(Ed Gojara|Claude)( \(AI\))?\b[^.;]*authorized[^.;]*[.;]?/gi, '').trim();
  if (t.length > 420) { const cut = t.slice(0, 420); const end = cut.lastIndexOf('. '); t = `${end > 160 ? cut.slice(0, end + 1) : `${cut.trim()}…`}`; }
  return t;
}

/** Material when the change is at least $2,500 and at least 10% of the approved amount (or a new line of $2,500+). */
function isMaterial(v) {
  const chg = Math.abs(int(v.chg));
  if (chg < MATERIAL.min_cents) return false;
  return !v.appr || chg >= MATERIAL.pct * Math.abs(v.appr);
}

function must(res, what) { const { data, error } = res; if (error) throw new Error(`${what}: ${error.message}`); return data; }

/**
 * Assemble the report from existing records. No writes.
 */
async function buildBoardReport(supabase, { community_id, target_year, as_of, budget_id = null, now = new Date() }) {
  if (!community_id || !target_year || !as_of) throw Object.assign(new Error('community_id_target_year_and_as_of_required'), { code: 'invalid_input' });
  const ty = Number(target_year), by = ty - 1;
  const funds = must(await supabase.from('account_funds').select('fund_code, fund_name, fund_type, display_order, is_active').eq('community_id', community_id).eq('is_active', true).order('display_order'), 'funds');
  const codes = funds.map((f) => f.fund_code);
  const ordered = [...codes.filter((c) => c === 'OPR'), ...codes.filter((c) => c !== 'OPR')];
  const models = [];
  for (const f of ordered) models.push(await M.buildProposedBudgetModel(supabase, { community_id, target_year: ty, as_of, budget_id, fund: f, now }));
  if (!models.length) throw Object.assign(new Error('no active funds'), { code: 'not_found' });
  const m0 = models[0];
  const budget = must(await supabase.from('community_budgets').select('id, fiscal_year, status, approved_at').eq('id', m0.period.budget_id).single(), 'budget');
  const approved = ['approved', 'active'].includes(budget.status);

  // Draft line notes (the explanation recorded with each proposed amount).
  let dlr = await supabase.from('budget_line_items').select('account_id, notes, review_note, annual_amount_cents').eq('budget_id', budget.id).limit(2000);
  if (dlr.error && /review_note|does not exist|schema cache/i.test(dlr.error.message || '')) dlr = await supabase.from('budget_line_items').select('account_id, notes, annual_amount_cents').eq('budget_id', budget.id).limit(2000);
  const draftLines = must(dlr, 'draft lines');
  // A revision recorded on a line but not yet approved (review_note "Proposed revision pending approval: ..."):
  // presented as a decision with both amounts; the line keeps its draft amount until it is approved.
  const revisions = draftLines.filter((l) => /^Proposed revision pending approval:/i.test(String(l.review_note || ''))).map((l) => ({ account_id: l.account_id, text: String(l.review_note).replace(/^Proposed revision pending approval:\s*/i, '') }));
  const noteBy = new Map(draftLines.map((l) => [l.account_id, cleanNote(l.notes)]));

  // Contracts and exceptions (lib/budget/contract_review, read-only).
  let review = null;
  try {
    const R = require('./contract_review');
    review = R.reviewContracts(await R.loadReviewInput(supabase, { community_id, year: ty, as_of: day(now.toISOString ? now.toISOString() : now) }));
  } catch (e) { console.warn('[board_report] contract review unavailable:', e.message); }
  const contractsBy = new Map();
  for (const c of (review && review.contracts) || []) { if (!c.account_id) continue; if (!contractsBy.has(c.account_id)) contractsBy.set(c.account_id, []); contractsBy.get(c.account_id).push(c); }

  // Reclassifications prepared or approved but not posted: footnoted on the rows they would move.
  const runs = must(await supabase.from('accounting_runs').select('id, status, preview, created_at').eq('community_id', community_id).eq('process', 'reclassification').in('status', ['prepared', 'approved', 'held']).limit(20), 'pending reclassifications');
  const pending = [];
  for (const r of runs) for (const it of ((r.preview || {}).items || []).filter((i) => !i.already)) pending.push({ run_id: r.id, status: r.status, label: it.label, amount_cents: it.amount_cents, posting_date: it.entries && it.entries[0] && it.entries[0].posting_date, effects: it.effects || {} });
  const pendingByAcct = {};
  for (const p of pending) for (const [a, c] of Object.entries(p.effects)) pendingByAcct[a] = (pendingByAcct[a] || 0) + c;

  // Fund sections and the material changes, line by line.
  const material = [];
  const fundsOut = models.map((m) => {
    const sections = [...m.sections, ...(m.transfers ? [m.transfers] : [])].map((s) => ({
      key: s.key, label: s.label,
      groups: s.groups.map((g) => ({ label: g.label, kind: g.kind, values: g.values,
        lines: g.lines.map((l) => {
          const v = l.values; const p = pct(v.chg, v.appr);
          const row = { account_id: l.account_id, account_number: l.account_number, account_name: l.account_name, appr: v.appr, proj: v.proj, prop: v.prop, chg: v.chg, pct: p,
            pending_cents: pendingByAcct[l.account_number] || 0 };
          if (isMaterial(v)) {
            const cs = (contractsBy.get(l.account_id) || []).map((c) => `${c.vendor_name} (${c.execution === 'verified_executed' ? 'executed, verified' : c.execution === 'likely_executed' ? 'signed, not yet verified' : 'not fully executed'}${c.annual_cents ? `; contract prices ${Math.round(c.annual_cents / 100).toLocaleString('en-US')} for ${ty}` : ''})`);
            material.push({ fund: m.fund, account_number: l.account_number, account_name: l.account_name, appr: v.appr, prop: v.prop, chg: v.chg, pct: p,
              explanation: noteBy.get(l.account_id) || null, contracts: cs });
          }
          return row;
        }) })),
      total: s.total,
    }));
    return { fund: m.fund, title: m.subtitle.split(' · ')[0].replace(/\s+Fund$/i, ''), sections, net: m.net, change: m.change || null, transfers: !!m.transfers,
      fund_balance: m.fund_balance || null, reserve_plan: m.reserve_plan ? { summary: m.reserve_plan.summary, projects: m.reserve_plan.projects || [] } : null, warnings: m.warnings };
  });

  // Assumptions, exceptions and board decisions: only what the records hold.
  const D = require('../forecast/working_forecast_data'); const W = require('../forecast/working_forecast');
  const wf = W.buildWorkingForecast(await D.loadWorkingForecastInput(supabase, { community_id, target_year: ty, as_of }), { now });
  const assumptions = [
    `${by} projected = actual through ${longDate(as_of)} plus the remaining ${by} approved budget for the rest of the year. A transfer between funds counts only when actually made.`,
    `${ty} proposed = the ${ty} draft budget, line for line.${approved ? '' : ' It has not been adopted by the Board of Directors.'}`,
    'Change = proposed minus the approved budget for the prior year. A transfer between funds (such as the Reserve contribution) is neither revenue nor expense and is shown below the operating result.',
    ...((wf.data_status && wf.data_status.reasons) || []).filter((r) => ['converted_mid_year', 'no_closed_month'].includes(r.code)).map((r) => r.text.replace(/trustEd's/g, 'The association\'s')),
  ];
  if (pending.length) assumptions.push(`Awaiting approval: ${pending.length} reclassification entr${pending.length === 1 ? 'y' : 'ies'} totaling ${(pending.reduce((t, p) => t + p.amount_cents, 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} (${[...new Set(pending.map((p) => Object.keys(p.effects).join(' to ')))].join('; ')}). The ${by} columns show the books as they stand; rows marked † change when the entries are approved.`);
  const usd = (c) => (int(c) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const rowBy = new Map(); for (const f of fundsOut) for (const sct of f.sections) for (const g of sct.groups) for (const l of g.lines) rowBy.set(l.account_id, l);
  const acctLabel = (id) => { const l = rowBy.get(id); return l ? `${l.account_number} ${l.account_name}` : 'the account'; };
  const decisions = [];
  for (const d of (wf.summary && wf.summary.board_decisions) || []) decisions.push({ topic: d.label || d.account, text: `${d.account}: ${usd(d.working_cents)} is carried at the ${by} approved amount as a provisional ${ty} assumption. The board sets the ${ty} contribution (reserve study or an explicit decision).` });
  for (const rv of revisions) decisions.push({ topic: 'Budget revision pending approval', text: `${acctLabel(rv.account_id)}: ${rv.text}` });
  const revised = new Set(revisions.map((r) => r.account_id));
  for (const e of ((review && review.exceptions) || []).filter((x) => x.decision && !revised.has(x.account_id))) {
    const l = rowBy.get(e.account_id);
    if (e.code === 'line_vs_contract' && l) decisions.push({ topic: 'Line revision', text: `${acctLabel(e.account_id)}: proposed ${usd(l.prop)}; the agreements on file support ${usd(e.proposed_cents)}. Revise the line, or keep it with the reason recorded.` });
    else if (e.code === 'contract_expired') decisions.push({ topic: 'Expiring agreement', text: `${e.vendor}: the agreement ends without automatic renewal. Renew, replace or confirm the service ends.` });
  }
  const exceptions = [];
  for (const e of (review && review.exceptions) || []) {
    if (e.decision) continue;
    const a = acctLabel(e.account_id); const l = rowBy.get(e.account_id);
    if (e.code === 'material_line_no_contract') exceptions.push({ text: `${a}: ${l ? `${usd(l.prop)} proposed` : 'proposed amount'} with no supporting agreement on file yet.` });
    else if (e.code === 'missing_contract') exceptions.push({ text: `${e.vendor}: bills ${a} monthly; the signed agreement is not yet on file.` });
    else if (e.code === 'pricing_uncostable') exceptions.push({ text: `${e.vendor} (${a}): the agreement sets a payment schedule or per-visit price, not a fixed monthly rate; the proposed amount rests on its stated annual figure.` });
    else if (e.code === 'uncontracted_spend') exceptions.push({ text: `${e.vendor}: ${a} billing in ${by} has no written agreement or engagement letter on file.` });
  }
  const unverified = ((review && review.exceptions) || []).filter((x) => x.code === 'contract_unverified').length;
  if (unverified) exceptions.push({ text: `${unverified} agreement(s) are recorded from their documents; execution is not yet verified by a person.` });
  for (const f of fundsOut) if (f.fund_balance && int(f.fund_balance.ending.values.prop) < 0) exceptions.push({ text: `${f.title} Fund balance is projected at ${usd(f.fund_balance.ending.values.prop)} at the end of ${ty} under the proposed budget.` });
  for (const f of fundsOut) for (const w of f.warnings.filter((x) => ['fund_balance_tie', 'reserve_plan_differs', 'reserve_plan_ending_differs'].includes(x.code))) exceptions.push({ text: w.text.replace(/(-?\d+\.\d{2})/g, (n) => usd(Math.round(Number(n) * 100))) });

  return {
    kind: 'board_budget_report', version: 1,
    community: m0.community, target_year: ty, base_year: by, as_of: day(as_of),
    budget: { id: budget.id, status: budget.status, approved, approved_at: budget.approved_at },
    status_label: approved ? `ADOPTED ${ty} BUDGET` : 'PROPOSED – NOT APPROVED',
    funds: fundsOut, material, assumptions, decisions, exceptions, pending, generated_at: new Date(now).toISOString(),
  };
}

// ----------------------------------------------------------------- render
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function money(c, { blankZero = false } = {}) {
  if (c === null || c === undefined) return '<span class="na">n/a</span>';
  const n = int(c); if (!n && blankZero) return '–';
  const s = (Math.abs(n) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return n < 0 ? `(${s})` : s;
}
function pctText(p) { if (p === null || p === undefined) return 'new'; if (!Number.isFinite(p)) return '–'; const v = Math.round(p * 1000) / 10; return v === 0 ? '–' : `${v > 0 ? '' : '('}${Math.abs(v).toFixed(1)}%${v > 0 ? '' : ')'}`; }

const CSS = `
@page{size:Letter landscape;margin:0.7in 0.5in 0.6in}
*{box-sizing:border-box}
body{margin:0;font-family:Inter,'Segoe UI',Helvetica,Arial,sans-serif;color:#1A2233;font-size:10px;line-height:1.45;font-variant-numeric:tabular-nums lining-nums}
h1{font-family:'Cormorant Garamond',Georgia,serif;font-size:25px;font-weight:600;color:#0B1D34;margin:0}
h2{font-family:'Cormorant Garamond',Georgia,serif;font-size:19px;font-weight:600;color:#0B1D34;margin:0 0 4px}
.kicker{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#4A5468;font-weight:600;margin-top:4px}
.sub{font-size:10.5px;color:#7B8394;margin-top:2px}
.status{display:inline-block;margin-top:10px;padding:6px 12px;border-radius:5px;background:#FBEDEB;color:#8E2A22;font-weight:700;letter-spacing:.14em;font-size:10px}
.status.adopted{background:#EAF3EE;color:#1F5F43}
.head{border-bottom:2px solid #0B1D34;padding-bottom:12px;margin-bottom:12px}
.page{page-break-before:always}
.lead{font-size:11px;color:#1A2233;margin:8px 0 10px;max-width:9.2in}
table{border-collapse:collapse;width:100%}
thead{display:table-header-group}
thead th{font-size:8.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:#4A5468;text-align:right;padding:6px 0 5px 10px;border-bottom:1px solid #4A5468;vertical-align:bottom}
thead th.l{text-align:left;padding-left:0}
thead tr.band th{border-bottom:none;color:#0B1D34;font-size:9px;padding-bottom:0}
td{padding:3px 0 3px 10px;text-align:right;white-space:nowrap;vertical-align:top}
td.l{text-align:left;padding-left:0;white-space:normal}
tr{page-break-inside:avoid}
tr.sec td{font-family:'Cormorant Garamond',Georgia,serif;font-size:15px;font-weight:600;color:#0B1D34;padding-top:12px;text-align:left}
tr.cat td{font-weight:600;color:#1A2233;padding-top:7px}
tr.acct td{color:#4A5468}
tr.acct td.gl{color:#7B8394;width:44px}
tr.sub td{font-weight:600;border-top:1px solid #C9C6BC}
tr.tot td{font-weight:700;border-top:1px solid #1A2233;padding-top:5px}
tr.grand td{font-weight:700;border-top:1px solid #1A2233;border-bottom:3px double #1A2233;padding:6px 0 6px 10px}
tr.grand td.l{padding-left:0}
tr.sec, tr.cat{page-break-after:avoid}
td.neg{color:#8E2A22}
.na{color:#9A917A}
.dag{color:#8E2A22;font-weight:700}
.fb td{padding-top:4px}
.box{border:1px solid #E4E1D7;border-radius:6px;padding:10px 12px;margin-top:10px;page-break-inside:avoid}
.box.warn{background:#FFF5DD;border-color:#F0DCA6;color:#5E4206}
ol,ul{margin:4px 0 0 16px;padding:0}
li{margin:3px 0}
table.mat td{white-space:normal;padding-top:6px;padding-bottom:6px;border-bottom:1px solid #EFEDE6}
table.mat td.num{white-space:nowrap}
table.mat td.ex{text-align:left;color:#1A2233;width:56%}
.small{font-size:9px;color:#4A5468}
.own{display:inline-block;min-width:54px;font-size:8.5px;text-transform:uppercase;letter-spacing:.08em;color:#4A5468}
`;

function head(r, title, sub) {
  return `<div class="head"><h1>${esc(r.community.legal_name || r.community.name)}</h1><div class="kicker">${esc(title)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}<div class="status${r.budget.approved ? ' adopted' : ''}">${esc(r.status_label)}</div></div>`;
}
function colHead(r, { gl = true } = {}) {
  return `<thead><tr class="band"><th class="l"></th>${gl ? '<th class="l"></th>' : ''}<th colspan="2" style="text-align:center">${r.base_year}</th><th colspan="3" style="text-align:center">${r.target_year}</th></tr>
<tr>${gl ? '<th class="l">GL</th>' : ''}<th class="l">Description</th><th>Approved budget</th><th>Projected actual</th><th>Proposed budget</th><th>$ change</th><th>% change</th></tr></thead>`;
}
function numCells(v, { pending = 0, noPct = false } = {}) {
  const chg = v.chg !== undefined ? v.chg : int(v.prop) - int(v.appr);
  const p = v.pct !== undefined ? v.pct : pct(chg, v.appr);
  return `<td>${money(v.appr, { blankZero: true })}</td><td>${money(v.proj, { blankZero: true })}${pending ? ' <span class="dag">†</span>' : ''}</td><td>${money(v.prop, { blankZero: true })}</td><td>${money(chg, { blankZero: true })}</td><td>${noPct ? '' : pctText(p)}</td>`;
}

function fundSummaryRows(r, f) {
  const out = [];
  for (const s of f.sections) {
    out.push(`<tr class="sec"><td class="l" colspan="6">${esc(s.label)}</td></tr>`);
    for (const g of s.groups) out.push(`<tr class="acct"><td class="l">${esc(g.label)}</td>${numCells(g.values)}</tr>`);
    out.push(`<tr class="tot"><td class="l">${esc(s.total.label)}</td>${numCells(s.total.values)}</tr>`);
    if (s.key === 'expense') out.push(`<tr class="grand"><td class="l">${esc(f.net.label)}</td>${numCells(f.net.values, { noPct: true })}</tr>`);
  }
  if (f.change) out.push(`<tr class="grand"><td class="l">${esc(f.change.label)}</td>${numCells(f.change.values, { noPct: true })}</tr>`);
  if (f.fund_balance) {
    const b = f.fund_balance;
    out.push(`<tr class="fb"><td class="l">${esc(b.beginning.label)}</td><td>${money(b.beginning.values.appr)}</td><td>${money(b.beginning.values.proj)}</td><td>${money(b.beginning.values.prop)}</td><td></td><td></td></tr>`);
    out.push(`<tr class="grand"><td class="l">${esc(b.ending.label)}</td><td>${money(b.ending.values.appr)}</td><td>${money(b.ending.values.proj)}</td><td>${money(b.ending.values.prop)}</td><td></td><td></td></tr>`);
  }
  return out.join('');
}

function fundDetail(r, f) {
  const rows = [];
  for (const s of f.sections) {
    rows.push(`<tr class="sec"><td class="l" colspan="7">${esc(s.label)}</td></tr>`);
    for (const g of s.groups) {
      if (g.label && g.kind !== 'accounts') rows.push(`<tr class="cat"><td class="l" colspan="7">${esc(g.label)}</td></tr>`);
      for (const l of g.lines) rows.push(`<tr class="acct"><td class="l gl">${esc(l.account_number)}</td><td class="l">${esc(l.account_name)}</td>${numCells(l, { pending: l.pending_cents })}</tr>`);
      if (g.kind !== 'accounts' && g.lines.length > 1) rows.push(`<tr class="sub"><td></td><td class="l">Total ${esc(g.label)}</td>${numCells(g.values)}</tr>`);
    }
    rows.push(`<tr class="tot"><td></td><td class="l">${esc(s.total.label)}</td>${numCells(s.total.values)}</tr>`);
    if (s.key === 'expense') rows.push(`<tr class="grand"><td></td><td class="l">${esc(f.net.label)}</td>${numCells(f.net.values, { noPct: true })}</tr>`);
  }
  if (f.change) rows.push(`<tr class="grand"><td></td><td class="l">${esc(f.change.label)}</td>${numCells(f.change.values, { noPct: true })}</tr>`);
  return `<table>${colHead(r)}<tbody>${rows.join('')}</tbody></table>`;
}

function renderBoardReportHtml(r) {
  const pages = [];
  const opr = r.funds.find((f) => f.fund === 'OPR') || r.funds[0];
  const fb = (f) => (f.fund_balance ? f.fund_balance.ending.values.prop : null);
  const ord = (n) => (n === null || n === undefined ? 'not available' : `$${money(n)}`);
  const lead = [
    `The proposed ${r.target_year} budget totals $${money(opr.sections[0].total.values.prop)} of ${opr.title} Fund revenue and $${money(opr.sections[1].total.values.prop)} of expenses`,
    opr.change ? `; after interfund transfers the ${opr.title} Fund changes by $${money(opr.change.values.prop)}` : `; the ${opr.title} Fund result is $${money(opr.net.values.prop)}`,
    `. Projected ${opr.title} Fund balance at the end of ${r.target_year}: ${ord(fb(opr))}.`,
  ].join('');
  pages.push(`${head(r, `Proposed ${r.target_year} Budget · Summary`, `With the ${r.base_year} approved budget and ${r.base_year} projected actual (actual through ${longDate(r.as_of)}) · Accrual basis`)}
<p class="lead">${esc(lead)}</p>
${r.funds.map((f) => `<h2 style="margin-top:12px">${esc(f.title)} Fund</h2><table>${colHead(r, { gl: false })}<tbody>${fundSummaryRows(r, f)}</tbody></table>`).join('')}
${r.decisions.length ? `<div class="box"><b>For board decision</b><ol>${r.decisions.map((d) => `<li>${esc(d.text)}</li>`).join('')}</ol></div>` : ''}`);
  for (const f of r.funds) pages.push(`<div class="page">${head(r, `Proposed ${r.target_year} Budget · ${f.title} Fund detail`, `By GL account, grouped by reporting category · actual through ${longDate(r.as_of)}`)}${fundDetail(r, f)}
${f.reserve_plan && f.reserve_plan.summary ? `<div class="box"><b>Reserve fund: contributions, capital projects and balance</b>
${(f.reserve_plan.projects || []).length ? `<table style="margin-top:6px"><thead><tr><th class="l">Planned capital project</th><th class="l">Status</th><th>${r.target_year} amount</th></tr></thead><tbody>${f.reserve_plan.projects.map((p) => `<tr><td class="l">${esc(p.project_name || p.name || '')}${p.note ? `<div class="small">${esc(p.note)}</div>` : ''}</td><td class="l">${(p.review_status || p.status) === 'needs_review' ? 'Needs board review' : 'Planned'}</td><td>${int(p.planned_amount_cents ?? p.amount_cents) ? money(p.planned_amount_cents ?? p.amount_cents) : '<span class="na">not yet estimated</span>'}</td></tr>`).join('')}</tbody></table>` : '<div class="small" style="margin-top:4px">No capital projects are planned for this year.</div>'}
<table style="margin-top:8px">${f.reserve_plan.summary.map((s) => `<tr><td class="l">${esc(s.label)}</td><td>${money(s.cents)}</td></tr>`).join('')}</table></div>` : ''}</div>`);
  pages.push(`<div class="page">${head(r, 'Material changes', `Changes of at least $${money(MATERIAL.min_cents)} and ${Math.round(MATERIAL.pct * 100)}% from the ${r.base_year} approved budget, with the explanation recorded for the proposed amount`)}
<table class="mat"><thead><tr><th class="l">GL</th><th class="l">Description</th><th>${r.base_year} approved</th><th>${r.target_year} proposed</th><th>$ change</th><th>% change</th><th class="l" style="padding-left:14px">Explanation and contract support</th></tr></thead><tbody>
${r.material.map((x) => `<tr><td class="l" style="color:#7B8394;width:40px;padding-right:8px">${esc(x.account_number)}</td><td class="l">${esc(x.account_name)}</td><td class="num">${money(x.appr, { blankZero: true })}</td><td class="num">${money(x.prop, { blankZero: true })}</td><td class="num">${money(x.chg)}</td><td class="num">${pctText(x.pct)}</td><td class="ex" style="padding-left:14px">${x.explanation ? esc(x.explanation) : '<span class="na">No explanation recorded for this amount.</span>'}${x.contracts.length ? `<div class="small" style="margin-top:3px">Contract: ${esc(x.contracts.join('; '))}</div>` : ''}</td></tr>`).join('')}
</tbody></table></div>`);
  pages.push(`<div class="page">${head(r, 'Assumptions, exceptions and decisions', `Prepared ${longDate(r.generated_at)} from the association's records`)}
<div class="box"><b>Assumptions</b><ul>${r.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>
${r.decisions.length ? `<div class="box"><b>Board decisions</b><ol>${r.decisions.map((d) => `<li><b>${esc(d.topic)}.</b> ${esc(d.text)}</li>`).join('')}</ol></div>` : ''}
${r.exceptions.length ? `<div class="box warn"><b>Open items and unresolved contract questions</b><ul>${r.exceptions.map((e) => `<li>${esc(e.text)}</li>`).join('')}</ul></div>` : ''}
${r.pending.length ? `<div class="box"><b>† Awaiting approval</b><ul>${r.pending.map((p) => `<li>${esc(p.label)}: ${money(p.amount_cents)} (${esc(Object.keys(p.effects).join(' to '))}), dated ${esc(p.posting_date || '')}</li>`).join('')}</ul></div>` : ''}
</div>`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.community.name)} · Proposed ${r.target_year} Budget</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>${pages.join('')}</body></html>`;
}

async function boardReportPdf(r) {
  const puppeteer = require('puppeteer');
  const html = renderBoardReportHtml(r);
  const e = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/[\u0080-￿]/g, (c) => `&#${c.charCodeAt(0)};`);
  const band = 'font-family:Helvetica,Arial,sans-serif;font-size:7.5px;color:#4A5468;width:100%;padding:0 0.5in;display:flex;justify-content:space-between;';
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 45000 });
    return await page.pdf({ format: 'Letter', landscape: true, printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
      headerTemplate: `<div style="${band}"><span>${e(r.community.legal_name || r.community.name)} &middot; ${e(`Proposed ${r.target_year} Budget`)}</span><span style="letter-spacing:.12em;font-weight:bold;color:${r.budget.approved ? '#1F5F43' : '#8E2A22'};">${e(r.status_label)}</span></div>`,
      footerTemplate: `<div style="${band}"><span>Prepared by Bedrock Association Management</span><span>Prepared ${e(longDate(r.generated_at))} &middot; ${r.base_year} actual through ${e(longDate(r.as_of))}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>` });
  } finally { await browser.close(); }
}

module.exports = { buildBoardReport, renderBoardReportHtml, boardReportPdf, cleanNote, isMaterial, MATERIAL };
