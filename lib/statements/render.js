// ============================================================================
// lib/statements/render.js  (Ed 2026-10-09, month-end close PR C)
// ----------------------------------------------------------------------------
// THE ONE STATEMENT RENDERER. Every presentation of a financial statement
// renders a statement model (lib/statements/model.js) through here:
//   renderHtml(model, { mode: 'web' })    interactive web statement (drill-down)
//   renderHtml(model, { mode: 'print' })  PDF / print (categories only, whole $)
//   renderHtml(model, { mode: 'embed' })  native board-packet section
//   renderDocument(model, opts)           a complete HTML document (PDF input)
//   xlsxRows(model)                       the XLSX sheet (lib/statements/export.js)
// Formatting rules live here once: negatives in parentheses, zero as "–",
// null as "n/a" (not available in TrustEd, visually distinct from zero),
// "n/m" for a percentage with no budget to compare to.
// ============================================================================

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NA_TITLE = 'Not available in TrustEd';

// cents -> display. whole: round to dollars (print).
function money(c, { whole = false } = {}) {
  if (c === null || c === undefined) return { text: 'n/a', cls: 'na' };
  const n = Number(c) || 0;
  if (Math.round(whole ? n / 100 : n) === 0) return { text: '–', cls: 'z' };
  const v = Math.abs(n) / 100;
  const s = v.toLocaleString('en-US', whole ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return { text: n < 0 ? `(${s})` : s, cls: n < 0 ? 'neg' : '' };
}
function percent(p, { varCents } = {}) {
  if (p === null || p === undefined) return varCents === null || varCents === undefined ? { text: 'n/a', cls: 'na' } : { text: 'n/m', cls: 'z' };
  if (p === 0) return { text: '–', cls: 'z' };
  const s = `${Math.abs(p).toFixed(1)}%`;
  return { text: p < 0 ? `(${s})` : s, cls: p < 0 ? 'neg' : '' };
}
function cell(col, v, values, opts, tone) {
  const f = col.is_pct ? percent(v, { varCents: values[col.key.replace('_pct', '')] }) : money(v, opts);
  const isVar = /_var/.test(col.key);
  const t = isVar && tone && f.cls !== 'na' && f.cls !== 'z' ? (Number(v) >= 0 ? ' fav' : ' unfav') : '';
  const inner = f.cls === 'na' ? `<span class="na" title="${NA_TITLE}">n/a</span>` : esc(f.text);
  return `<td class="num${f.cls && f.cls !== 'na' ? ' ' + f.cls : ''}${t}">${inner}</td>`;
}

const CSS = `
.tstmt{--t-navy:#0B1D34;--t-gold:#B8952B;--t-ink:#1A2233;--t-ink2:#4A5468;--t-ink3:#7B8394;--t-rule:#E4E1D7;--t-rule2:#EFEDE6;--t-na:#7A6F55;--t-nabg:#F4F0E4;--t-fav:#1F5F43;--t-unfav:#8E2A22;--t-warnbg:#FFF5DD;--t-warn:#7A5408;--t-draft:#8E2A22;--t-draftbg:#FBEDEB;--t-ok:#1F5F43;--t-okbg:#EAF3EE;--t-sheet:#FFFFFF;
  font-family:Inter,-apple-system,'Segoe UI',sans-serif;color:var(--t-ink);background:var(--t-sheet);font-size:13.5px;line-height:1.5}
.tstmt .th-head{padding:22px 0 14px;border-bottom:2px solid var(--t-navy)}
.tstmt .assoc{font-family:'Cormorant Garamond',Georgia,serif;font-size:26px;font-weight:600;color:var(--t-navy);line-height:1.15}
.tstmt .ttl{font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--t-ink2);font-weight:600;margin-top:5px}
.tstmt .sub{font-size:12.5px;color:var(--t-ink3);margin-top:2px}
.tstmt .life{margin-top:10px;padding:8px 12px;font-size:12.5px;border-radius:6px}
.tstmt .life b{letter-spacing:.12em;text-transform:uppercase;font-size:11px;margin-right:10px}
.tstmt .life.draft{background:var(--t-draftbg);color:var(--t-draft)}
.tstmt .life.closed{background:var(--t-okbg);color:var(--t-ok)}
.tstmt .notes{margin-top:8px;font-size:12px;color:var(--t-ink2)}
.tstmt .notes div{margin-top:3px}
.tstmt .warn{margin-top:8px;padding:8px 12px;background:var(--t-warnbg);color:var(--t-warn);border-radius:6px;font-size:12.5px}
.tstmt .scroll{overflow-x:auto}
.tstmt table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums lining-nums;margin-top:6px}
.tstmt thead th{font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--t-ink3);text-align:right;padding:14px 0 7px 14px;border-bottom:1px solid var(--t-ink3);vertical-align:bottom;line-height:1.3}
.tstmt thead th:first-child{text-align:left;padding-left:0}
.tstmt thead th small{display:block;font-size:10px;letter-spacing:.02em;text-transform:none;font-weight:500}
.tstmt td{padding:5px 0 5px 14px;white-space:nowrap}
.tstmt td:first-child{padding-left:0;white-space:normal}
.tstmt td.num{text-align:right}
.tstmt tr.sec td{font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;font-weight:600;color:var(--t-navy);padding-top:20px;padding-bottom:3px}
.tstmt tr.cat td:first-child{padding-left:12px}
.tstmt tr.acct td{color:var(--t-ink2);font-size:12.5px}
.tstmt tr.acct td:first-child{padding-left:30px}
.tstmt tr.acct .an{color:var(--t-ink3);font-size:11.5px;margin-right:7px}
.tstmt tr.unm td{background:var(--t-warnbg);color:var(--t-warn)}
.tstmt tr.unm td:first-child{padding-left:12px}
.tstmt tr.unm.acct td:first-child{padding-left:30px}
.tstmt .flag{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;border:1px solid currentColor;border-radius:4px;padding:0 4px;margin-left:7px}
.tstmt tr.sub td{font-weight:600;border-top:1px solid var(--t-rule)}
.tstmt tr.sub td:first-child{padding-left:12px}
.tstmt tr.tot td{font-weight:700;color:var(--t-navy);border-top:1px solid var(--t-navy);border-bottom:3px double var(--t-navy);padding-top:7px;padding-bottom:7px}
.tstmt tr.memo td{color:var(--t-ink3);font-size:12px;font-style:italic}
.tstmt tr.memo td:first-child{padding-left:12px}
.tstmt .z{color:var(--t-ink3)}
.tstmt .na{color:var(--t-na);background:var(--t-nabg);font-size:11px;font-weight:500;padding:1px 6px;border-radius:4px;letter-spacing:.02em}
.tstmt .fav{color:var(--t-fav)}
.tstmt .unfav{color:var(--t-unfav)}
.tstmt .tie{font-size:11.5px;color:var(--t-ink3);margin-top:10px}
.tstmt .foot{font-size:11.5px;color:var(--t-ink3);margin-top:12px;border-top:1px solid var(--t-rule2);padding-top:8px}
.tstmt button.tg{font:inherit;background:none;border:0;color:inherit;cursor:pointer;padding:0;text-align:left}
.tstmt button.tg::before{content:'\\25B8';display:inline-block;width:13px;color:var(--t-gold);transition:transform .15s}
.tstmt button.tg[aria-expanded="true"]::before{transform:rotate(90deg)}
.tstmt [data-drill]{cursor:pointer}
.tstmt .dl{border-bottom:1px dotted var(--t-ink3)}
.tstmt button:focus-visible,.tstmt [data-drill]:focus-visible{outline:2px solid #D4AF37;outline-offset:2px}
.tstmt.print{font-size:10.5px}
.tstmt.print .assoc{font-size:21px}
.tstmt.print td{padding:3px 0 3px 10px;font-size:10.5px}
.tstmt.print tr.acct td,.tstmt.print tr.memo td{font-size:10px}
.tstmt.print tr.acct .an{font-size:9.5px}
.tstmt.print tr.sec td{font-size:15px;padding-top:12px}
.tstmt.print .na{font-size:9px}
.tstmt.print thead{display:table-header-group}
.tstmt.print tbody{break-inside:avoid}
.tstmt.print tr{break-inside:avoid}
.tstmt.print .life{padding:5px 0;background:none!important}
@media (prefers-color-scheme:dark){.tstmt.web{--t-navy:#C9D6EA;--t-gold:#D9BC5E;--t-ink:#E7EBF2;--t-ink2:#B4BDCC;--t-ink3:#8790A1;--t-rule:#2A3444;--t-rule2:#212B3A;--t-na:#C4B48F;--t-nabg:#262619;--t-fav:#7FC8A3;--t-unfav:#F0A096;--t-warnbg:#2E2410;--t-warn:#F0CF84;--t-draft:#F0A096;--t-draftbg:#2D1715;--t-ok:#7FC8A3;--t-okbg:#13261C;--t-sheet:#141C28}}
`;

function headCells(model) {
  const cols = model.columns;
  if (model.kind === 'balance_sheet') {
    return cols.map((c) => `<th>${esc(c.label)}${c.as_of && model.view !== 'fund' ? `<small>${esc(shortDate(c.as_of))}</small>` : ''}</th>`).join('');
  }
  return cols.map((c) => { const [a, b] = splitLabel(c.label); return `<th>${esc(a)}${b ? `<small>${esc(b)}</small>` : ''}</th>`; }).join('');
}
function splitLabel(l) { const m = /^(Month|YTD|Prior-year)\s+(.*)$/.exec(l); return m ? [m[1], m[2]] : [l, '']; }
function shortDate(d) { const [y, m, dd] = String(d).split('-').map(Number); return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${dd}, ${y}`; }
const drillAttr = (d) => (d ? ` data-drill="${esc(JSON.stringify(d))}" tabindex="0"` : '');

function renderHtml(model, { mode = 'web', noStyle = false } = {}) {
  const web = mode === 'web';
  const whole = mode === 'print' || mode === 'embed';
  const tone = true;
  const opts = { whole };
  const cols = model.columns;
  const cells = (values) => cols.map((c) => cell(c, values[c.key], values, opts, tone)).join('');
  const rows = [];
  let gid = 0;
  for (const sec of model.sections) {
    rows.push(`<tr class="sec"><td colspan="${cols.length + 1}">${esc(sec.label)}</td></tr>`);
    // Fund balance: the equity accounts ARE the beginning fund balance; they show
    // as its expandable detail (never a second time as their own category).
    if (sec.fund_balance) {
      const id = `g${++gid}`;
      const b = sec.fund_balance.beginning;
      const allLines = sec.groups.flatMap((g) => g.lines.map((l) => ({ ...l, _unm: g.kind === 'unmapped' })));
      const anyUnm = allLines.some((l) => l._unm);
      const first = web ? `<button type="button" class="tg" aria-expanded="${anyUnm ? 'true' : 'false'}" data-g="${id}">${esc(b.label)}</button>` : esc(b.label);
      rows.push(`<tr class="cat"><td><span${web ? ` class="dl"${drillAttr({ level: 'category', accounts: allLines.map((l) => ({ account_id: l.account_id, fund_id: l.fund_id || null })) })}` : ''}>${first}</span></td>${cells(b.values)}</tr>`);
      for (const l of allLines) {
        if (!web && !l._unm) continue;
        const tag = l._unm ? (l.mapping && l.mapping.status === 'proposed' ? `<span class="flag">Proposed: ${esc(l.mapping.proposed_category)}</span>` : '<span class="flag">Unmapped</span>') : '';
        rows.push(`<tr class="acct${l._unm ? ' unm' : ''}" data-of="${id}"${web && !l._unm ? ' hidden' : ''}><td><span${web ? ` class="dl"${drillAttr(l.drill)}` : ''}><span class="an">${esc(l.account_number)}</span>${esc(l.account_name)}${l.fund_code && model.view !== 'fund' ? ` <span class="an">${esc(l.fund_code)}</span>` : ''}</span>${tag}</td>${cells(l.values)}</tr>`);
      }
      rows.push(`<tr class="cat"><td><span${web ? ` class="dl"${drillAttr(sec.fund_balance.current_year_activity.drill)}` : ''}>${esc(sec.fund_balance.current_year_activity.label)}</span></td>${cells(sec.fund_balance.current_year_activity.values)}</tr>`);
      rows.push(`<tr class="sub"><td>${esc(sec.total.label)}</td>${cells(sec.total.values)}</tr>`);
      for (const m of sec.memo || []) rows.push(`<tr class="memo"><td>${esc(m.label)}</td>${cells(m.values)}</tr>`);
      continue;
    }
    for (const g of sec.groups) {
      const id = `g${++gid}`;
      const unm = g.kind === 'unmapped';
      const label = unm ? `Unmapped<span class="flag">Review</span>` : esc(g.label);
      // Web: every group expands to its GL accounts. Print: categories only, but
      // unmapped accounts are always listed (never hidden).
      const showLines = web || unm || g.kind === 'accounts';
      const first = web
        ? `<button type="button" class="tg" aria-expanded="${unm ? 'true' : 'false'}" data-g="${id}">${label}</button>`
        : label;
      if (g.kind !== 'accounts') rows.push(`<tr class="cat${unm ? ' unm' : ''}"><td><span${web ? ` class="dl"${drillAttr(g.drill)}` : ''}>${first}</span></td>${cells(g.values)}</tr>`);
      if (showLines) {
        for (const l of g.lines) {
          const tag = l.mapping && l.mapping.status === 'proposed' ? `<span class="flag">Proposed: ${esc(l.mapping.proposed_category)}</span>` : (l.mapping && l.mapping.status === 'unmapped' ? '<span class="flag">Unmapped</span>' : '');
          const hidden = web && !unm && g.kind !== 'accounts' ? ' hidden' : '';
          rows.push(`<tr class="acct${unm ? ' unm' : ''}" data-of="${id}"${hidden}><td><span${web ? ` class="dl"${drillAttr(l.drill)}` : ''}><span class="an">${esc(l.account_number)}</span>${esc(l.account_name)}${l.fund_code && model.view !== 'fund' && model.kind === 'balance_sheet' ? ` <span class="an">${esc(l.fund_code)}</span>` : ''}</span>${tag}</td>${cells(l.values)}</tr>`);
        }
      }
    }
    rows.push(`<tr class="${model.kind === 'income_budget' || sec.key === 'liability' ? 'sub' : 'tot'}"><td>${esc(sec.total.label)}</td>${cells(sec.total.values)}</tr>`);
  }
  if (model.kind === 'balance_sheet') rows.push(`<tr class="tot"><td>Total liabilities &amp; fund balance</td>${cells(model.totals.liabilities_and_fund_balance)}</tr>`);
  if (model.kind === 'income_budget') rows.push(`<tr class="tot"><td>${esc(model.net.label)}</td>${cells(model.net.values)}</tr>`);

  const life = model.lifecycle || {};
  const lifeHtml = life.status === 'closed'
    ? `<div class="life closed"><b>${esc(life.label)}</b>${life.closed_at ? `Closed ${esc(fmtStamp(life.closed_at))}${life.closed_by ? ` by ${esc(life.closed_by)}` : ''}` : ''}</div>`
    : `<div class="life draft"><b>${esc(life.label || 'DRAFT – PERIOD NOT CLOSED')}</b>${esc(life.note || '')}</div>`;
  const notes = (model.notes || []).map((n) => `<div>${esc(n.text)}</div>`).join('');
  const warns = (model.warnings || []).map((w) => `<div class="warn">${esc(w.text)}</div>`).join('');
  const colHead = model.kind === 'balance_sheet' && model.view !== 'fund' ? '' : (model.kind === 'income_budget' ? 'Account' : '');
  const tie = model.kind === 'balance_sheet'
    ? (() => { const sec = model.sections.find((s) => s.key === 'equity'); const ok = sec && sec.tie_out.every((t) => t.ties); return `<div class="tie">${ok ? 'Fund balance ties: beginning fund balance + current-year activity = total fund balance in every column.' : 'Fund balance tie-out FAILED in at least one column; do not distribute.'} ${model.engine_tie.every((t) => t.ties) ? 'Every column ties to the statement engine.' : ''}</div>`; })()
    : (model.carryforward ? `<div class="tie">${esc(model.carryforward.label)}: revenue ${esc(money(model.carryforward.revenue, opts).text)}, expense ${esc(money(model.carryforward.expense, opts).text)} (included in year to date).</div>` : '');
  const foot = mode === 'web' ? '' : `<div class="foot">Prepared by Bedrock Association Management from trustEd${model.kind === 'income_budget' ? ' · Variance: favorable is positive, (unfavorable) in parentheses' : ''} · n/a = not available in TrustEd · – = zero</div>`;
  return `${noStyle ? '' : `<style>${CSS}</style>`}<section class="tstmt ${web ? 'web' : 'print'}" data-model-version="${esc(model.model_version)}" data-snapshot="${esc(model.snapshot_sha256)}">
  <header class="th-head"><div class="assoc">${esc(model.community.legal_name || `${model.community.name} Homeowners Association`)}</div><div class="ttl">${esc(model.title)}</div><div class="sub">${esc(model.subtitle)} · ${esc(model.basis)}</div>${lifeHtml}${notes ? `<div class="notes">${notes}</div>` : ''}${warns}</header>
  <div class="scroll"><table><thead><tr><th>${colHead}</th>${headCells(model)}</tr></thead><tbody>${rows.join('')}</tbody></table></div>
  ${tie}${foot}</section>`;
}
function fmtStamp(ts) {
  const d = new Date(ts);
  return d.toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' CT';
}

// A complete printable document (PDF input). Fonts load from Google Fonts.
function renderDocument(models, { title } = {}) {
  const list = Array.isArray(models) ? models : [models];
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title || list[0].title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600&family=Inter:wght@400;500;600;700&display=swap">
<style>@page{size:Letter;margin:0.6in 0.55in 0.7in}body{margin:0;background:#fff}${CSS}.pb{break-before:page}</style></head><body>
${list.map((m, i) => `<div class="${i ? 'pb' : ''}">${renderHtml(m, { mode: 'print', noStyle: true })}</div>`).join('\n')}
</body></html>`;
}

// XLSX rows: [label, ...values]; numbers in dollars (real numbers), null -> 'n/a'.
function xlsxRows(model) {
  const out = [];
  out.push([model.community.legal_name || model.community.name]);
  out.push([model.title]);
  out.push([`${model.subtitle} · ${model.basis}`]);
  out.push([model.lifecycle && model.lifecycle.status === 'closed' ? model.lifecycle.label : 'DRAFT – PERIOD NOT CLOSED']);
  for (const n of model.notes || []) out.push([n.text]);
  for (const w of model.warnings || []) out.push([`Warning: ${w.text}`]);
  out.push([]);
  out.push(['', ...model.columns.map((c) => (c.as_of && model.kind === 'balance_sheet' && model.view !== 'fund' ? `${c.label} (${c.as_of})` : c.label))]);
  const val = (c, v) => (v === null || v === undefined ? (c.is_pct ? null : 'n/a') : c.is_pct ? v / 100 : v / 100);
  const line = (label, values, kind) => out.push({ kind, cells: [label, ...model.columns.map((c) => (c.is_pct && values[c.key] === null && values[c.key.replace('_pct', '')] !== null ? 'n/m' : val(c, values[c.key])))] });
  for (const sec of model.sections) {
    out.push({ kind: 'sec', cells: [sec.label] });
    if (sec.fund_balance) {
      line(sec.fund_balance.beginning.label, sec.fund_balance.beginning.values, 'cat');
      for (const g of sec.groups) for (const l of g.lines) line(`    ${l.account_number} ${l.account_name}${g.kind === 'unmapped' ? ' [unmapped]' : ''}`, l.values, 'acct');
      line(sec.fund_balance.current_year_activity.label, sec.fund_balance.current_year_activity.values, 'cat');
    } else {
      for (const g of sec.groups) {
        if (g.kind !== 'accounts') line(g.kind === 'unmapped' ? 'Unmapped (review)' : g.label, g.values, 'cat');
        for (const l of g.lines) line(`    ${l.account_number} ${l.account_name}${l.mapping && l.mapping.status !== 'approved' ? ' [unmapped]' : ''}`, l.values, 'acct');
      }
    }
    line(sec.total.label, sec.total.values, 'total');
    for (const m of sec.memo || []) line(`  ${m.label}`, m.values, 'memo');
  }
  if (model.kind === 'balance_sheet') line('Total liabilities & fund balance', model.totals.liabilities_and_fund_balance, 'total');
  else line(model.net.label, model.net.values, 'total');
  out.push([]);
  out.push([`Model ${model.model_version} · snapshot ${model.snapshot_sha256} · generated ${model.generated_at}`]);
  return out;
}

module.exports = { renderHtml, renderDocument, xlsxRows, money, percent, CSS };
