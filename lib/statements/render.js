// ============================================================================
// lib/statements/render.js  (Ed 2026-10-09, month-end close PR C)
// ----------------------------------------------------------------------------
// THE ONE STATEMENT RENDERER. Every presentation of a financial statement
// renders a statement model (lib/statements/model.js) through here:
//   renderHtml(model, { mode: 'web' })    interactive web statement (drill-down)
//   renderHtml(model, { mode: 'print' })  PDF / print (to the cent)
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
.tstmt tr.sub td{font-weight:600;color:var(--t-ink);border-top:1px solid var(--t-rule)}
.tstmt tr.sub td:first-child{padding-left:12px}
.tstmt tr.sectot td{font-weight:700;color:var(--t-ink);border-top:1px solid var(--t-ink3);padding-top:6px}
.tstmt tr.sectot td:first-child{padding-left:0}
.tstmt tr.tot td{font-weight:700;color:var(--t-navy);border-top:1px solid var(--t-navy);border-bottom:3px double var(--t-navy);padding-top:7px;padding-bottom:7px}
.tstmt tr.memo td{color:var(--t-ink3);font-size:12px;font-style:italic}
.tstmt tr.subhead td:first-child{padding-left:12px;font-weight:500}
.tstmt tr.sgrow td:first-child{padding-left:30px}
.tstmt tr.sgrow td{color:var(--t-ink)}
.tstmt tr.acct.sg1 td:first-child,.tstmt tr.acct.sg2 td:first-child{padding-left:30px}
.tstmt tr.sgsub td{border-top:1px solid var(--t-rule2);font-style:italic}
.tstmt tr.sgsub td:first-child{padding-left:30px}
.tstmt tr.cattot td{font-weight:600;border-top:1px solid var(--t-rule)}
.tstmt tr.cattot td:first-child{padding-left:12px}
.tstmt tr.elim td{font-style:italic;color:var(--t-ink2)}
.tstmt tr.elim td:first-child{padding-left:12px}
.tstmt tr.memo td:first-child{padding-left:12px}
.tstmt .z{color:var(--t-ink3)}
.tstmt .na{color:var(--t-na);background:var(--t-nabg);font-size:11px;font-weight:500;padding:1px 6px;border-radius:4px;letter-spacing:.02em}
.tstmt .fav{color:var(--t-fav)}
.tstmt .unfav{color:var(--t-unfav)}
.tstmt .tie{font-size:11.5px;color:var(--t-ink3);margin-top:10px}
.tstmt .rplan{margin-top:18px}
.tstmt .rplan h3{font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--t-navy);font-weight:700;margin:14px 0 2px}
.tstmt .rplan .rv{font-size:10.5px;font-weight:700;color:var(--t-warn);background:var(--t-warnbg);padding:1px 6px;border-radius:6px;white-space:nowrap}
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
.tstmt.print tr.acct td,.tstmt.print tr.memo td,.tstmt.print tr.sgrow td,.tstmt.print tr.sgsub td{font-size:10px}
.tstmt.print tr.acct .an{font-size:9.5px}
.tstmt.print tr.sec td{font-size:15px;padding-top:12px}
.tstmt.print .na{font-size:9px}
.tstmt thead tr.band th{text-align:center;border-bottom:1px solid var(--t-rule);padding-bottom:4px;color:var(--t-navy);letter-spacing:.1em}
.tstmt thead tr.band th:first-child{border-bottom:none}
.tstmt.print thead{display:table-header-group}
.tstmt.print tr{break-inside:avoid}
.tstmt.print .life{padding:5px 0;background:none!important}
.tstmt.board{font-size:9.5pt;line-height:1.28;color:#1A2233}
.tstmt.board .th-head{padding:0 0 5pt;border-bottom:1.5pt solid var(--t-navy);position:relative}
.tstmt.board .th-head::after{content:'';position:absolute;left:0;bottom:-3.5pt;width:1.1in;border-bottom:1.5pt solid var(--t-gold)}
.tstmt.board .assoc{font-size:17pt;line-height:1.1}
.tstmt.board .ttl{font-size:8.5pt;margin-top:3pt;color:var(--t-navy)}
.tstmt.board .fundname{font-size:12pt;font-weight:700;color:var(--t-navy);margin-top:5pt}
.tstmt.board .sub{font-size:9pt;color:var(--t-ink2);margin-top:1pt}
.tstmt.board .life{margin-top:4pt;padding:0;font-size:8.5pt}
.tstmt.board .life b{font-size:8.5pt;border:1pt solid currentColor;border-radius:3pt;padding:1pt 5pt;margin-right:6pt}
.tstmt.board .warn{font-size:8.5pt;padding:4pt 7pt;margin-top:5pt;border:0.75pt solid #E3C98A}
.tstmt.board table{table-layout:fixed;margin-top:5pt}
.tstmt.board col.acc{width:35%}
.tstmt.board thead th{font-size:7.5pt;padding:6pt 0 3pt 6pt;color:var(--t-ink2);border-bottom:0.75pt solid var(--t-navy)}
.tstmt.board thead tr.band th{padding:4pt 0 2pt 6pt;font-size:7.5pt;color:var(--t-navy);border-bottom:0.75pt solid var(--t-gold)}
.tstmt.board td{padding:1.15pt 0 1.15pt 6pt;font-size:9.5pt}
.tstmt.board tbody.blk{break-inside:avoid}
.tstmt.board tr.subhead,.tstmt.board tr.sec{break-after:avoid}
.tstmt.board tr.cattot,.tstmt.board tr.sectot{break-before:avoid}
.tstmt.board .th-head.compact{padding-bottom:4pt}
.tstmt.board .th-head.compact .fundname{margin-top:0}
.tstmt.board td:first-child{padding-left:0;white-space:normal}
.tstmt.board tr.sec td{font-size:11pt;padding-top:6pt;padding-bottom:1pt;letter-spacing:.02em}
.tstmt.board tr.cat td:first-child,.tstmt.board tr.subhead td:first-child{padding-left:8pt}
.tstmt.board tr.subhead td{font-weight:600;color:var(--t-navy);padding-top:3pt}
.tstmt.board tr.sgrow td:first-child,.tstmt.board tr.acct td:first-child{padding-left:20pt}
.tstmt.board tr.acct td,.tstmt.board tr.sgrow td{font-size:9.5pt;color:#1A2233}
.tstmt.board tr.cat.one td{color:#1A2233}
.tstmt.board .an{font-size:8pt;color:var(--t-ink3);margin-right:5pt}
.tstmt.board .an-after{margin:0 0 0 5pt}
.tstmt.board tr.cattot td{font-weight:700;border-top:0.5pt solid #9AA1AE;padding-bottom:3pt}
.tstmt.board tr.cattot td:first-child{padding-left:8pt}
.tstmt.board tr.sectot td{font-weight:700;border-top:0.75pt solid var(--t-navy);padding-top:3pt;padding-bottom:3pt}
.tstmt.board tr.tot td{font-size:10pt;font-weight:700;color:var(--t-navy);border-top:0.75pt solid var(--t-navy);border-bottom:2.25pt double var(--t-navy);padding-top:4pt;padding-bottom:4pt}
.tstmt.board tr.unm td{background:none;color:#7A5408;font-style:italic}
.tstmt.board .flag{font-size:7pt;padding:0 3pt}
.tstmt.board .na{font-size:7.5pt;padding:0 3pt}
.tstmt.board tr{break-inside:avoid}
.tnotes{font-family:Inter,-apple-system,'Segoe UI',sans-serif;color:#1A2233;font-size:9pt;line-height:1.4}
.tnotes h2{font-family:'Cormorant Garamond',Georgia,serif;font-size:15pt;color:#0B1D34;margin:0 0 6pt;border-bottom:1.5pt solid #0B1D34;padding-bottom:3pt}
.tnotes ol{margin:0;padding-left:16pt}
.tnotes li{margin:0 0 4pt}
@media (prefers-color-scheme:dark){.tstmt.web{--t-navy:#C9D6EA;--t-gold:#D9BC5E;--t-ink:#E7EBF2;--t-ink2:#B4BDCC;--t-ink3:#8790A1;--t-rule:#2A3444;--t-rule2:#212B3A;--t-na:#C4B48F;--t-nabg:#262619;--t-fav:#7FC8A3;--t-unfav:#F0A096;--t-warnbg:#2E2410;--t-warn:#F0CF84;--t-draft:#F0A096;--t-draftbg:#2D1715;--t-ok:#7FC8A3;--t-okbg:#13261C;--t-sheet:#141C28}}
`;

// Income statement columns carry a band (Current month / Year to date /
// Annual): one header row of bands spanning their columns, then the labels.
function headRows(model, colHead, cols = model.columns) {
  const banded = model.kind !== 'balance_sheet' && cols.some((c) => c.band);
  if (!banded) return `<tr><th>${colHead}</th>${headCells(model, cols)}</tr>`;
  const bands = [];
  for (const c of cols) { const last = bands[bands.length - 1]; if (last && last.band === c.band) last.n += 1; else bands.push({ band: c.band, n: 1 }); }
  return `<tr class="band"><th></th>${bands.map((b) => `<th colspan="${b.n}">${esc(b.band || '')}</th>`).join('')}</tr><tr><th>${colHead}</th>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr>`;
}
function headCells(model, cols = model.columns) {
  if (model.kind === 'balance_sheet') {
    return cols.map((c) => `<th>${esc(c.label)}${c.as_of && model.view !== 'fund' ? `<small>${esc(shortDate(c.as_of))}</small>` : ''}</th>`).join('');
  }
  return cols.map((c) => { const [a, b] = splitLabel(c.label); return `<th>${esc(a)}${b ? `<small>${esc(b)}</small>` : ''}</th>`; }).join('');
}
function splitLabel(l) { const m = /^(Month|YTD|Prior-year)\s+(.*)$/.exec(l); return m ? [m[1], m[2]] : [l, '']; }
function shortDate(d) { const [y, m, dd] = String(d).split('-').map(Number); return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${dd}, ${y}`; }
// The Budget vs. Actual (month and year to date with variances); the proposed budget shares the
// income_budget kind but has no variance columns and keeps its own layout.
const isBva = (m) => !!m && m.kind === 'income_budget' && (m.columns || []).some((c) => c.is_var);
const drillAttr = (d) => (d ? ` data-drill="${esc(JSON.stringify(d))}" tabindex="0"` : '');

function renderHtml(model, { mode = 'web', noStyle = false, compact = false } = {}) {
  const web = mode === 'web';
  // Board statements print to the cent (Ed 2026-10-11): rounding to dollars hid real
  // differences (a $0.25 assessment variance printed as a dash).
  const whole = false;
  const tone = true;
  const opts = { whole };
  // The printed Budget vs. Actual (Ed 2026-10-13): month and year-to-date actual, budget and
  // variance only. The annual budget stays on screen and in Excel; on paper it took the room
  // the account names need.
  const board = !web && isBva(model);
  const cols = board ? model.columns.filter((c) => c.band !== 'Annual') : model.columns;
  const totalLabel = (g) => (board ? `Total ${g.label}` : `Total ${g.label.charAt(0).toLowerCase() + g.label.slice(1)}`);
  // One account under a heading of its own name prints as one line (the line is its subtotal).
  const sameName = (a, b) => String(a || '').toLowerCase().replace(/[^a-z0-9]/g, '') === String(b || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const acctTag = (label, l) => `<span class="an an-after">${esc(l.account_number)}</span>`;
  const acctLabel = (l) => (board ? `${esc(l.account_name)}<span class="an an-after">${esc(l.account_number)}</span>` : `<span class="an">${esc(l.account_number)}</span>${esc(l.account_name)}`);
  // Printed: each category (heading through its total) is one block that never splits across pages.
  const OPEN = board ? '</tbody><tbody class="blk">' : ''; const CLOSE = board ? '</tbody><tbody>' : '';
  const cells = (values, t = tone) => cols.map((c) => cell(c, values[c.key], values, opts, t)).join('');
  const rows = [];
  let gid = 0;
  for (const sec of model.sections) {
    if (sec.suppressed) continue;   // a section with no account to show prints no heading and no zero total
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
      // Consolidation elimination: one visible line in the section.
      if (g.kind === 'elimination') { rows.push(`<tr class="cat elim"><td>${esc(g.label)}</td>${cells(g.values)}</tr>`); continue; }
      // A category with subcategories is never collapsed (web or print): each
      // subcategory shows; a multi-account subcategory lists its accounts and a
      // subtotal under its own label (e.g. fixed assets less depreciation, net).
      if (board && g.kind === 'category' && (g.subgroups || []).reduce((n, sg) => n + sg.lines.length, 0) === 1) {
        const only = g.subgroups.find((sg) => sg.lines.length).lines[0];
        rows.push(`<tr class="cat one"><td>${esc(g.label)} ${acctTag(g.label, only)}</td>${cells(g.values)}</tr>`);
        continue;
      }
      if (g.subgroups && g.subgroups.length) {
        rows.push(OPEN);
        rows.push(`<tr class="cat subhead"><td><span${web ? ` class="dl"${drillAttr(g.drill)}` : ''}>${esc(g.label)}</span></td>${cols.map(() => '<td></td>').join('')}</tr>`);
        const acctRow = (l, cls) => `<tr class="acct ${cls}"><td><span${web ? ` class="dl"${drillAttr(l.drill)}` : ''}>${acctLabel(l)}${l.fund_code && model.view !== 'fund' ? ` <span class="an">${esc(l.fund_code)}</span>` : ''}</span></td>${cells(l.values)}</tr>`;
        for (const sg of g.subgroups) {
          if (!sg.label) { for (const l of sg.lines) rows.push(acctRow(l, 'sg1')); continue; }
          const nums = [...new Set(sg.lines.map((l) => l.account_number))];
          if (nums.length === 1) {
            rows.push(`<tr class="sgrow"><td><span${web ? ` class="dl"${drillAttr(sg.drill)}` : ''}>${esc(sg.label)} ${board ? acctTag(sg.label, sg.lines[0]) : `<span class="an">${esc(nums[0])}</span>`}</span></td>${cells(sg.values)}</tr>`);
            if (web && sg.lines.length > 1) for (const l of sg.lines) rows.push(acctRow(l, 'sg2'));
          } else {
            for (const l of sg.lines) rows.push(acctRow(l, 'sg2'));
            rows.push(`<tr class="sgsub"><td><span${web ? ` class="dl"${drillAttr(sg.drill)}` : ''}>${esc(sg.label)}</span></td>${cells(sg.values)}</tr>`);
          }
        }
        rows.push(`<tr class="cattot"><td>${esc(totalLabel(g))}</td>${cells(g.values)}</tr>`);
        rows.push(CLOSE);
        continue;
      }
      // Printed Budget vs. Actual: a category holding one account is one line.
      if (board && g.kind === 'category' && (g.lines || []).length === 1) {
        rows.push(`<tr class="cat one"><td>${esc(g.label)} ${acctTag(g.label, g.lines[0])}</td>${cells(g.values)}</tr>`);
        continue;
      }
      const unm = g.kind === 'unmapped';
      const label = unm ? `Unmapped<span class="flag">Review</span>` : esc(g.label);
      // Web: every group expands to its GL accounts. Print: an income statement
      // lists every GL account under its category with a category subtotal (the
      // board layout); other statements print categories only. Unmapped accounts
      // are always listed (never hidden).
      const boardPrint = !web && (model.kind === 'income_budget' || model.kind === 'reserve_activity') && g.kind !== 'accounts' && (g.lines || []).length > 0;
      const showLines = web || unm || g.kind === 'accounts' || boardPrint;
      const first = web
        ? `<button type="button" class="tg" aria-expanded="${unm ? 'true' : 'false'}" data-g="${id}">${label}</button>`
        : label;
      if (boardPrint) rows.push(OPEN, `<tr class="cat subhead${unm ? ' unm' : ''}"><td>${first}</td>${cols.map(() => '<td></td>').join('')}</tr>`);
      else if (g.kind !== 'accounts') rows.push(`<tr class="cat${unm ? ' unm' : ''}"><td><span${web ? ` class="dl"${drillAttr(g.drill)}` : ''}>${first}</span></td>${cells(g.values)}</tr>`);
      if (showLines) {
        for (const l of g.lines) {
          const tag = l.mapping && l.mapping.status === 'proposed' ? `<span class="flag">Proposed: ${esc(l.mapping.proposed_category)}</span>` : (l.mapping && l.mapping.status === 'unmapped' ? '<span class="flag">Unmapped</span>' : '');
          const hidden = web && !unm && g.kind !== 'accounts' ? ' hidden' : '';
          rows.push(`<tr class="acct${unm ? ' unm' : ''}" data-of="${id}"${hidden}><td><span${web ? ` class="dl"${drillAttr(l.drill)}` : ''}>${acctLabel(l)}${l.fund_code && model.view !== 'fund' && model.kind === 'balance_sheet' ? ` <span class="an">${esc(l.fund_code)}</span>` : ''}</span>${tag}</td>${cells(l.values)}</tr>`);
        }
        if (boardPrint) rows.push(`<tr class="cattot"><td>Total ${unm ? 'unmapped' : esc(g.label)}</td>${cells(g.values)}</tr>`, CLOSE);
      }
    }
    rows.push(`<tr class="${model.kind === 'income_budget' || sec.key === 'expenditures' ? 'sectot' : sec.key === 'liability' ? 'sub' : 'tot'}"><td>${esc(sec.total.label)}</td>${cells(sec.total.values)}</tr>`);
  }
  if (model.kind === 'balance_sheet') rows.push(`<tr class="tot"><td>Total liabilities &amp; fund balance</td>${cells(model.totals.liabilities_and_fund_balance)}</tr>`);
  if (model.kind === 'income_budget') {
    rows.push(`<tr class="${model.change ? 'sectot' : 'tot'}"><td>${esc(model.net.label)}</td>${cells(model.net.values)}</tr>`);
    for (const t of [model.prior_period, model.transfers].filter(Boolean)) {
      rows.push(OPEN, `<tr class="sec"><td colspan="${cols.length + 1}">${esc(t.label)}</td></tr>`);
      for (const g of t.groups) for (const l of g.lines) rows.push(`<tr class="acct"><td><span${web ? ` class="dl"${drillAttr(l.drill)}` : ''}>${acctLabel(l)}</span></td>${cells(l.values, !l.is_transfer)}</tr>`);
      rows.push(`<tr class="sectot"><td>${esc(t.total.label)}</td>${cells(t.total.values, !t.total.values.is_transfer && !t.total.is_transfer)}</tr>`, CLOSE);
    }
    if (model.change) rows.push(`<tr class="tot"><td>${esc(model.change.label)}</td>${cells(model.change.values)}</tr>`);
    if (model.fund_balance) {
      const fbCells = (v) => cols.map((col) => (v[col.key] === null && col.key === 'chg' ? '<td></td>' : cell(col, v[col.key], v, opts, false))).join('');
      rows.push(`<tr class="acct"><td>${esc(model.fund_balance.beginning.label)}</td>${fbCells(model.fund_balance.beginning.values)}</tr>`);
      rows.push(`<tr class="tot"><td>${esc(model.fund_balance.ending.label)}</td>${fbCells(model.fund_balance.ending.values)}</tr>`);
    }
  }

  const life = model.lifecycle || {};
  const lifeHtml = life.status === 'closed'
    ? `<div class="life closed"><b>${esc(life.label)}</b>${life.closed_at ? `Closed ${esc(fmtStamp(life.closed_at))}${life.closed_by ? ` by ${esc(life.closed_by)}` : ''}` : ''}</div>`
    : `<div class="life draft"><b>${esc(life.label || 'DRAFT – PERIOD NOT CLOSED')}</b>${esc(life.note || '')}</div>`;
  const notes = (model.notes || []).map((n) => `<div>${esc(n.text)}</div>`).join('');
  const warns = (model.warnings || []).map((w) => `<div class="warn">${esc(w.text)}</div>`).join('');
  const colHead = model.kind === 'balance_sheet' && model.view !== 'fund' ? '' : (model.kind === 'income_budget' ? 'Account' : model.kind === 'reserve_activity' ? 'Date / description' : '');
  const tie = model.kind === 'balance_sheet'
    ? (() => { const sec = model.sections.find((s) => s.key === 'equity'); const ok = sec && sec.tie_out.every((t) => t.ties); return `<div class="tie">${ok ? 'Fund balance ties: beginning fund balance + current-year activity = total fund balance in every column.' : 'Fund balance tie-out FAILED in at least one column; do not distribute.'} ${model.engine_tie.every((t) => t.ties) ? 'Every column ties to the statement engine.' : ''}</div>`; })()
    : (model.carryforward ? `<div class="tie">${esc(model.carryforward.label)}: revenue ${esc(money(model.carryforward.revenue, opts).text)}, expense ${esc(money(model.carryforward.expense, opts).text)} (included in year to date).</div>` : '');
  const ifn = model.kind === 'balance_sheet' && model.interfund ? (() => {
    const pairs = model.interfund.pairs || [];
    const nums = pairs.map((p) => `${p.receivable.number}/${p.payable.number}`).join(', ');
    if (model.view === 'fund') return `<div class="tie">Interfund due-to / due-from accounts (${esc(nums)}) are shown in each fund; the consolidated statement eliminates matched pairs.${(model.interfund.imbalances || []).length ? ' One or more pairs do not net to zero (see warning).' : ''}</div>`;
    if (model.interfund.eliminated_any) return `<div class="tie">Interfund balances that net exactly to zero between funds (${esc(nums)}) are eliminated in this consolidated statement: ${cols.filter((c) => model.interfund.eliminated[c.key]).map((c) => `${esc(c.label)} ${esc(money(model.interfund.eliminated[c.key], opts).text)}`).join('; ')}.</div>`;
    return `<div class="tie">Interfund pairs checked (${esc(nums)}): ${(model.interfund.imbalances || []).length ? 'not all net to zero; not eliminated (see warning).' : 'no interfund balances to eliminate.'}</div>`;
  })() : '';
  const foot = mode === 'web' ? '' : `<div class="foot">Prepared by Bedrock Association Management from trustEd${model.kind === 'income_budget' && (model.columns || []).some((c) => c.is_var) ? ' · Variance: favorable is positive (revenue above budget, expense below budget); (unfavorable) in parentheses' : ''} · n/a = not available in TrustEd · – = zero</div>`;
  const rplan = model.reserve_plan ? (() => {
    const rp = model.reserve_plan; const m = (c) => esc(money(c, opts).text);
    const proj = rp.projects.length
      ? rp.projects.map((p) => `<tr class="acct"><td>${esc(p.project_name || '(no description)')}${p.review_status === 'needs_review' ? ' <span class="rv">Needs review</span>' : ''}</td><td>${p.account_number ? `<span class="an">${esc(p.account_number)}</span>${esc(p.account_name || '')}` : 'GL account not chosen'}</td><td>${esc(p.month_label)}</td><td class="num">${m(p.planned_amount_cents)}</td></tr>`).join('')
      : '';
    const review = rp.review_items.map((r) => `<tr class="acct"><td>Carried from the saved budget <span class="rv">Needs review</span></td><td><span class="an">${esc(r.account_number || '')}</span>${esc(r.account_name || '')}</td><td>Timing not set</td><td class="num">${m(r.amount_cents)}</td></tr>`).join('');
    const none = !proj && !review ? `<tr class="acct"><td colspan="4">No capital projects are planned for ${esc(String(model.period.target_year))}.</td></tr>` : '';
    const byAcct = rp.by_account.map((b) => `<tr class="acct"><td>${b.account_number ? `<span class="an">${esc(b.account_number)}</span>` : ''}${esc(b.account_name || '')}</td><td class="num">${b.project_count || ''}</td><td class="num">${m(b.total_cents)}</td></tr>`).join('');
    const sum = rp.summary.map((x) => `<tr class="${x.key === 'net' || x.key === 'end' ? 'tot' : 'acct'}"><td>${esc(x.label)}</td><td class="num">${x.cents === null || x.cents === undefined ? '<span class="na">n/a</span>' : m(x.cents)}</td></tr>`).join('');
    return `<div class="rplan"><h3>Planned capital projects ${esc(String(model.period.target_year))}</h3>
      <table><thead><tr><th>Project</th><th>GL account</th><th>Expected timing</th><th class="num">Amount</th></tr></thead><tbody>${proj}${review}${none}
      <tr class="sectot"><td colspan="3">Total planned capital expenditures</td><td class="num">${m(rp.totals.capex_cents)}</td></tr></tbody></table>
      ${byAcct ? `<h3>By GL account (as budgeted)</h3><table><thead><tr><th>Account</th><th class="num">Projects</th><th class="num">Amount</th></tr></thead><tbody>${byAcct}</tbody></table>` : ''}
      <h3>Reserve Fund summary</h3><table><tbody>${sum}</tbody></table></div>`;
  })() : '';
  // A short category stays whole on one page; a long one (more than BLOCK_MAX rows) may continue
  // on the next page under the repeated column headings rather than leave half a page empty.
  if (board) {
    const BLOCK_MAX = 12; let open = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i] === OPEN) open = i;
      else if (rows[i] === CLOSE && open >= 0) { if (i - open - 1 > BLOCK_MAX) rows[open] = '</tbody><tbody class="long">'; open = -1; }
    }
  }
  // Printed Budget vs. Actual: the fund and reporting period lead the header; notes, the
  // carry-forward disclosure and the legend go once to the notes page at the end of the
  // document (renderDocument), and the page header/footer carry the rest.
  if (board && mode === 'print') {
    const [fundLabel] = String(model.subtitle || '').split(' · ');
    const p = model.period || {};
    // A later fund in the same package needs only its fund and period: the page header already
    // names the association and the statement.
    const head = compact
      ? `<header class="th-head compact"><div class="fundname">${esc(fundLabel)}</div><div class="sub">${esc(periodText(p))} · ${esc(model.basis)}</div>${warns}</header>`
      : `<header class="th-head"><div class="assoc">${esc(model.community.legal_name || model.community.name)}</div><div class="ttl">${esc(model.title)}</div>
      <div class="fundname">${esc(fundLabel)}</div><div class="sub">${esc(periodText(p))} · ${esc(model.basis)}</div>${lifeHtml}${warns}</header>`;
    return `${noStyle ? '' : `<style>${CSS}</style>`}<section class="tstmt print board" data-model-version="${esc(model.model_version)}" data-snapshot="${esc(model.snapshot_sha256)}">
  ${head}<table><colgroup><col class="acc">${cols.map(() => '<col>').join('')}</colgroup><thead>${headRows(model, colHead, cols)}</thead><tbody>${rows.join('')}</tbody></table></section>`;
  }
  return `${noStyle ? '' : `<style>${CSS}</style>`}<section class="tstmt ${web ? 'web' : 'print'}${board ? ' board' : ''}" data-model-version="${esc(model.model_version)}" data-snapshot="${esc(model.snapshot_sha256)}">
  <header class="th-head"><div class="assoc">${esc(model.community.legal_name || model.community.name)}</div><div class="ttl">${esc(model.title)}</div><div class="sub">${esc(model.subtitle)} · ${esc(model.basis)}</div>${lifeHtml}${notes ? `<div class="notes">${notes}</div>` : ''}${warns}</header>
  <div class="scroll"><table>${board ? `<colgroup><col class="acc">${cols.map(() => '<col>').join('')}</colgroup>` : ''}<thead>${headRows(model, colHead, cols)}</thead><tbody>${rows.join('')}</tbody></table></div>
  ${rplan}${tie}${ifn}${foot}</section>`;
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDay(d) { const [y, m, dd] = String(d).slice(0, 10).split('-').map(Number); return `${MONTHS[m - 1]} ${dd}, ${y}`; }
// "Month ended September 30, 2026 · Fiscal year to date, January 1 to September 30, 2026"
function periodText(p) {
  if (!p || !p.period_end) return '';
  return `Month ended ${longDay(p.period_end)} · Fiscal year to date, ${longDay(p.year_start || `${String(p.period_end).slice(0, 4)}-01-01`).replace(/, \d{4}$/, '')} to ${longDay(p.period_end)}`;
}
// The notes page of a printed package: every model's disclosures once, in order, plus the
// standing notes a board reader needs to read a Budget vs. Actual.
function notesFor(models) {
  const out = []; const seen = new Set();
  const add = (t) => { const k = String(t).trim(); if (k && !seen.has(k)) { seen.add(k); out.push(k); } };
  const boards = models.filter(isBva);
  if (boards.length) {
    add('Actuals are posted general-ledger entries only. Proposed or unposted adjustments, including any awaiting approval, are not included.');
    add('Budget figures are the association\'s approved budget for the fiscal year, by month. An account with no line in the approved budget shows a zero budget; if no budget has been approved for the year, budget columns show n/a.');
    add('Variance: favorable is positive (revenue above budget, expense below budget); unfavorable is shown in parentheses.');
    add('n/a = not available in TrustEd; – = zero.');
  }
  for (const m of boards) {
    const [fundLabel] = String(m.subtitle || '').split(' · ');
    if (m.carryforward) add(`${fundLabel}: year to date includes activity carried from the prior accounting system through ${longDay(m.carryforward.through || m.period.period_end)} (${[['revenue', m.carryforward.revenue], ['expense', m.carryforward.expense]].filter(([, c]) => Number(c)).map(([k, c]) => `${k} ${money(c).text}`).join(', ') || 'no revenue or expense'}), entered once as opening year-to-date balances at the conversion.`);
    for (const n of m.notes || []) if (!(m.carryforward && n.code === 'carryforward')) add(n.text);
    if (m.mapping && m.mapping.has_mapping === false && m.kind === 'income_budget') add(`${fundLabel}: no report categories are configured; accounts are listed individually.`);
  }
  return out;
}
function fmtStamp(ts) {
  const d = new Date(ts);
  return d.toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' CT';
}

// A complete printable document (PDF input). Fonts load from Google Fonts.
// Page flow (Ed 2026-10-13): every statement starts a page, except that short fund statements
// of the Budget vs. Actual (Reserve, Savings) stack on one page after Operating instead of
// each taking a mostly empty page. A stacked statement is kept whole. Notes close the package.
const SHORT_ROWS = 22;
function rowCount(m) {
  if (!isBva(m)) return Infinity;
  let n = 0;
  for (const s of [...(m.sections || []), m.transfers, m.prior_period].filter(Boolean)) {
    if (s.suppressed) continue;
    n += 2;
    for (const g of s.groups || []) n += (g.lines || []).length + (g.subgroups ? g.subgroups.length + 2 : 2);
  }
  return n + 6;
}
function renderDocument(models, { title } = {}) {
  const list = Array.isArray(models) ? models : [models];
  const short = list.map((m) => isBva(m) && m.fund !== 'OPR' && m.fund !== 'all' && rowCount(m) <= SHORT_ROWS);
  const notes = notesFor(list);
  const notesHtml = notes.length && list.some(isBva)
    ? `<div class="pb tnotes"><h2>Notes to the statements</h2><ol>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ol></div>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title || list[0].title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600&family=Inter:wght@400;500;600;700&display=swap">
<style>@page{size:Letter landscape;margin:0.62in 0.45in 0.6in}body{margin:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}${CSS}.pb{break-before:page}.stack{break-inside:avoid;margin-top:22pt}.keep{break-inside:avoid}</style></head><body>
${list.map((m, i) => `<div class="${!i ? '' : short[i] && isBva(list[i - 1]) && list[i - 1].fund !== 'OPR' && list[i - 1].fund !== 'all' ? 'stack' : 'pb'}${short[i] ? ' keep' : ''}">${renderHtml(m, { mode: 'print', noStyle: true, compact: i > 0 && isBva(m) && isBva(list[i - 1]) })}</div>`).join('\n')}
${notesHtml}
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
  out.push(['', ...model.columns.map((c) => (c.as_of && model.kind === 'balance_sheet' && model.view !== 'fund' ? `${c.label} (${c.as_of})` : c.band ? `${c.band} ${c.label.toLowerCase()}` : c.label))]);
  const val = (c, v) => (v === null || v === undefined ? (c.is_pct ? null : 'n/a') : c.is_pct ? v / 100 : v / 100);
  const line = (label, values, kind) => out.push({ kind, cells: [label, ...model.columns.map((c) => (c.is_pct && values[c.key] === null && values[c.key.replace('_pct', '')] !== null ? 'n/m' : val(c, values[c.key])))] });
  for (const sec of model.sections) {
    if (sec.suppressed) continue;
    out.push({ kind: 'sec', cells: [sec.label] });
    if (sec.fund_balance) {
      line(sec.fund_balance.beginning.label, sec.fund_balance.beginning.values, 'cat');
      for (const g of sec.groups) for (const l of g.lines) line(`    ${l.account_number} ${l.account_name}${g.kind === 'unmapped' ? ' [unmapped]' : ''}`, l.values, 'acct');
      line(sec.fund_balance.current_year_activity.label, sec.fund_balance.current_year_activity.values, 'cat');
    } else {
      for (const g of sec.groups) {
        if (g.kind === 'elimination') { line(g.label, g.values, 'cat'); continue; }
        if (g.subgroups && g.subgroups.length) {
          out.push({ kind: 'cat', cells: [g.label] });
          for (const sg of g.subgroups) {
            for (const l of sg.lines) line(`${sg.label ? '      ' : '    '}${l.account_number} ${l.account_name}`, l.values, 'acct');
            if (sg.label) line(`    ${sg.label}`, sg.values, 'sub');
          }
          line(`  Total ${g.label.charAt(0).toLowerCase() + g.label.slice(1)}`, g.values, 'cat');
          continue;
        }
        if (g.kind !== 'accounts') line(g.kind === 'unmapped' ? 'Unmapped (review)' : g.label, g.values, 'cat');
        for (const l of g.lines) line(`    ${l.account_number} ${l.account_name}${l.mapping && l.mapping.status !== 'approved' ? ' [unmapped]' : ''}`, l.values, 'acct');
      }
    }
    line(sec.total.label, sec.total.values, 'total');
    for (const m of sec.memo || []) line(`  ${m.label}`, m.values, 'memo');
  }
  if (model.kind === 'balance_sheet') line('Total liabilities & fund balance', model.totals.liabilities_and_fund_balance, 'total');
  else {
    line(model.net.label, model.net.values, 'total');
    for (const t of [model.prior_period, model.transfers].filter(Boolean)) {
      out.push({ kind: 'sec', cells: [t.label] });
      for (const g of t.groups) for (const l of g.lines) line(`    ${l.account_number} ${l.account_name}`, l.values, 'acct');
      line(t.total.label, t.total.values, 'total');
    }
    if (model.change) line(model.change.label, model.change.values, 'total');
    if (model.fund_balance) { line(model.fund_balance.beginning.label, model.fund_balance.beginning.values, 'acct'); line(model.fund_balance.ending.label, model.fund_balance.ending.values, 'total'); }
  }
  if (model.reserve_plan) {
    const rp = model.reserve_plan; const d = (c) => (c === null || c === undefined ? null : c / 100);
    out.push([]); out.push({ kind: 'sec', cells: [`Planned capital projects ${model.period.target_year}`] });
    out.push(['Project', 'GL account', 'Expected timing', 'Amount', 'Status']);
    for (const p of rp.projects) out.push([p.project_name, p.account_number ? `${p.account_number} ${p.account_name || ''}` : 'GL account not chosen', p.month_label, d(p.planned_amount_cents), p.review_status === 'needs_review' ? 'Needs review' : 'Planned']);
    for (const r of rp.review_items) out.push(['Carried from the saved budget', `${r.account_number || ''} ${r.account_name || ''}`, 'Timing not set', d(r.amount_cents), 'Needs review']);
    out.push(['Total planned capital expenditures', '', '', d(rp.totals.capex_cents)]);
    out.push([]); out.push({ kind: 'sec', cells: ['Reserve Fund summary'] });
    for (const x of rp.summary) out.push([x.label, d(x.cents)]);
  }
  out.push([]);
  out.push([`Model ${model.model_version} · snapshot ${model.snapshot_sha256} · generated ${model.generated_at}`]);
  return out;
}

module.exports = { renderHtml, renderDocument, xlsxRows, money, percent, CSS };
