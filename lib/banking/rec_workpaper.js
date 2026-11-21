// ============================================================================
// lib/banking/rec_workpaper.js  (Ed 2026-11-21)
// ----------------------------------------------------------------------------
// The bank reconciliation workpaper: one builder, rendered as a review page and
// as a PDF. Read-only. It reuses what is already stored, never recomputes:
//
//   approved   the posted run's result.workpaper (runs since 2026-11-21). A
//              posted run is permanent (migration 510), so this reproduces the
//              exact approved version whatever changes afterwards.
//   approved (as prepared)   older posted runs: the run's preview (what was
//              approved) with its posted result totals.
//   current    no approved run: the saved reconciliation and its items.
//
// The current standing (Reconciled / Unreconciled / Stale) is always shown
// beside the version, so an approved-then-stale month says so on its face.
// ============================================================================

const { withStandings } = require('./rec_standing');
const { fetchAllQuery } = require('../db/fetch_all');

const money = (c) => (c == null ? '—' : (Number(c) < 0 ? '(' : '') + '$' + (Math.abs(Number(c)) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (Number(c) < 0 ? ')' : ''));
const day = (d) => String(d || '').slice(0, 10);
const firstOf = (d) => `${day(d).slice(0, 7)}-01`;
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const longDate = (d) => (d ? new Date(`${day(d)}T12:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : '—');
const stamp = (t) => (t ? new Date(t).toLocaleString('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' CT' : '—');

async function must(q, what) { const { data, error } = await q; if (error) throw new Error(`${what}: ${error.message}`); return data; }

async function buildWorkpaper(supabase, { reconciliation_id, run_id = null, version = null }) {
  const rec = await must(supabase.from('bank_reconciliations').select('*').eq('id', reconciliation_id).maybeSingle(), 'reconciliation');
  if (!rec) return null;
  await withStandings(supabase, [rec]);
  const ba = await must(supabase.from('bank_accounts').select('id, account_nickname, bank_name, account_last4, gl_account_number, community_id').eq('id', rec.bank_account_id).maybeSingle(), 'bank account');
  const comm = await must(supabase.from('communities').select('id, name, legal_name').eq('id', rec.community_id).maybeSingle(), 'community');

  // Kat's runs for this account and month, newest first.
  const runs = rec.bank_account_id ? await must(supabase.from('accounting_runs')
    .select('id, status, period_month, preview, totals, exceptions, result, prepared_by, prepared_at, approved_by, approved_at, posted_by, posted_at, created_at')
    .eq('process', 'bank_reconciliation').eq('subject_id', rec.bank_account_id).eq('period_month', firstOf(rec.period_end)).order('created_at', { ascending: false }).limit(50), 'runs') : [];
  const posted = runs.filter((r) => r.status === 'posted');
  const run = run_id ? runs.find((r) => r.id === run_id) || null : (version === 'current' ? null : posted[0] || null);
  const events = runs.length ? await fetchAllQuery(() => supabase.from('accounting_run_events').select('id, run_id, event, actor, detail, created_at').in('run_id', runs.map((r) => r.id)), { orderBy: 'id' }) : [];

  let source, snap;
  if (run && run.result && run.result.workpaper) { source = 'approved'; snap = run.result.workpaper; }
  else if (run && run.preview && run.preview.items) {
    source = run.status === 'posted' ? 'approved (as prepared)' : `run ${run.status}`;
    const t = { ...(run.preview.totals || {}), ...((run.result && run.result.totals) || {}) };
    snap = { ...run.preview, totals: t, exceptions: (run.result && run.result.open_exceptions) ? [...run.result.open_exceptions, ...((run.preview.exceptions || []).filter((e) => e.severity === 'info'))] : run.preview.exceptions };
  } else {
    source = 'current';
    const items = await fetchAllQuery(() => supabase.from('bank_reconciliation_items').select('*').eq('reconciliation_id', rec.id), { orderBy: 'id' });
    snap = {
      period_start: rec.period_start, period_end: rec.period_end, items, exceptions: [],
      totals: { bank_ending_cents: rec.bank_ending_balance_cents, gl_ending_cents: rec.gl_ending_balance_cents, outstanding_checks_cents: rec.outstanding_checks_total_cents,
        deposits_in_transit_cents: rec.deposits_in_transit_total_cents, bank_only_cents: rec.bank_only_adjustments_cents, manual_adjustments_cents: -Number(rec.manual_adjustments_cents || 0),
        adjusted_bank_cents: rec.reconciled_balance_cents, difference_cents: rec.difference_cents },
    };
  }
  const t = { ...(snap.totals || {}) };
  if (t.adjusted_book_cents == null && t.gl_ending_cents != null) t.adjusted_book_cents = Number(t.gl_ending_cents) + Number(t.bank_only_cents || 0);

  // The exact statement: the snapshot's, else the reconciliation's own (by id, even if superseded).
  const stmtId = (snap.statement && snap.statement.id) || rec.bank_statement_import_id || null;
  const statement = stmtId ? await must(supabase.from('bank_statement_imports').select('id, statement_period_start, statement_period_end, beginning_balance_cents, ending_balance_cents, total_deposits_cents, total_withdrawals_cents, source_filename, status, imported_at').eq('id', stmtId).maybeSingle(), 'statement') : null;

  const items = snap.items || [];
  const by = (c) => items.filter((i) => i.category === c).sort((a, b) => String(a.date_ref || '').localeCompare(String(b.date_ref || '')));
  const ex = snap.exceptions || [];
  const proposals = (run && run.preview && run.preview.proposals) || [];
  const postedIds = new Set(((run && run.result && run.result.posted_entries) || []).map((p) => p.proposal_id || p.id).filter(Boolean));
  const receipts = proposals.filter((p) => p.receipts && p.receipts.length).map((p) => ({ ...p, posted: postedIds.size ? postedIds.has(p.id) : null }));

  const ev = (e) => events.filter((x) => x.run_id === (run && run.id) && x.event === e).pop() || null;
  return {
    community: comm, account: ba, reconciliation: rec, period_start: snap.period_start || rec.period_start, period_end: snap.period_end || rec.period_end,
    source, run_id: run ? run.id : null, run_status: run ? run.status : null,
    standing: rec.standing, standing_label: rec.standing_label, standing_reasons: rec.standing_reasons,
    statement, totals: t,
    outstanding_checks: by('outstanding_check'), deposits_in_transit: by('deposit_in_transit'), bank_only: by('bank_only'), adjustments: by('manual_adjustment'), gl_only: by('gl_only'), matched: by('matched'),
    exceptions_open: ex.filter((e) => e.severity !== 'info'), exceptions_documented: ex.filter((e) => e.severity === 'info'),
    receipts,
    people: {
      prepared_by: run ? run.prepared_by : null, prepared_at: run ? run.prepared_at : rec.prepared_at,
      approved_by: run ? run.approved_by : null, approved_at: run ? run.approved_at : null,
      posted_by: run ? run.posted_by : null, posted_at: run ? run.posted_at : null,
      reviewed: (ev('approved') || {}).actor || null,
    },
    versions: runs.map((r) => ({ run_id: r.id, status: r.status, prepared_at: r.prepared_at, approved_by: r.approved_by, approved_at: r.approved_at, has_snapshot: !!(r.result && r.result.workpaper) })),
    history: events.filter((e) => e.event === 'note' || ['prepared', 'approved', 'posted', 'superseded', 'held'].includes(e.event)).map((e) => ({ at: e.created_at, event: e.event, actor: e.actor, text: (e.detail && (e.detail.text || e.detail.reason)) || null, kind: e.detail && e.detail.kind })),
    generated_at: new Date().toISOString(),
  };
}

const STANDING_COLOR = { reconciled: '#1F5F43', unreconciled: '#8A5A00', stale: '#8E2A22' };

function renderWorkpaperHtml(w, { forPdf = false, pdfHref = null } = {}) {
  const acct = `${esc(w.account && (w.account.account_nickname || w.account.bank_name))}${w.account && w.account.account_last4 ? ' ····' + esc(w.account.account_last4) : ''}`;
  const T = w.totals;
  const row = (label, cents, opts = {}) => `<tr class="${opts.cls || ''}"><td>${label}</td><td class="n">${money(cents)}</td></tr>`;
  const sched = (title, list, note) => `<h3>${title} <span class="cnt">${list.length}</span></h3>${note ? `<p class="note">${note}</p>` : ''}${list.length ? `<table class="sch"><thead><tr><th>Date</th><th>Check</th><th>Description</th><th>Bank line</th><th>GL reference</th><th class="n">Amount</th></tr></thead><tbody>${list.map((i) => `<tr><td>${esc(day(i.date_ref))}</td><td>${esc(i.check_number || '')}</td><td>${esc(i.description || '')}${i.operator_notes ? `<div class="sub">${esc(i.operator_notes)}</div>` : ''}</td><td class="ref">${esc(i.bank_transaction_id ? String(i.bank_transaction_id).slice(0, 8) : '')}</td><td class="ref">${esc(i.gl_ref ? String(i.gl_ref).slice(0, 18) : '')}</td><td class="n">${money(i.amount_cents)}</td></tr>`).join('')}<tr class="tot"><td colspan="5">Total</td><td class="n">${money(list.reduce((a, i) => a + Number(i.amount_cents || 0), 0))}</td></tr></tbody></table>` : '<p class="none">None.</p>'}`;
  const stColor = STANDING_COLOR[w.standing] || '#8A5A00';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Bank Reconciliation ${esc(acct)} ${esc(day(w.period_end))}</title>
<style>
  @page { size: Letter; margin: 0.6in 0.55in 0.7in; }
  body { font-family: Helvetica, Arial, sans-serif; color: #1c2430; font-size: 10.5px; margin: ${forPdf ? '0' : '24px auto'}; max-width: ${forPdf ? 'none' : '900px'}; background: #fff; }
  .hdr { border-bottom: 3px solid #D4AF37; padding-bottom: 8px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: flex-end; }
  .hdr h1 { font-size: 17px; color: #0B1D34; margin: 0; } .hdr .sub2 { color: #4A5468; font-size: 11px; margin-top: 2px; }
  .badge { font-weight: 700; font-size: 12px; color: ${stColor}; border: 1.5px solid ${stColor}; border-radius: 4px; padding: 3px 8px; letter-spacing: .04em; text-transform: uppercase; }
  .reasons { color: ${stColor}; font-size: 10px; margin: 6px 0 10px; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; font-size: 10px; color: #4A5468; margin-bottom: 12px; }
  .meta b { color: #1c2430; font-weight: 600; }
  h2 { font-size: 12.5px; color: #0B1D34; border-bottom: 1px solid #d8dde6; padding-bottom: 3px; margin: 16px 0 6px; }
  h3 { font-size: 11px; color: #0B1D34; margin: 12px 0 4px; } .cnt { color: #8592a6; font-weight: 400; }
  table { width: 100%; border-collapse: collapse; } td, th { padding: 3px 5px; vertical-align: top; }
  .summ td { border-bottom: 1px solid #eef1f5; } .summ .tot td { font-weight: 700; border-top: 1.5px solid #0B1D34; border-bottom: none; } .summ .diff td { font-weight: 700; font-size: 11.5px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }
  .sch th { text-align: left; font-size: 9px; color: #4A5468; border-bottom: 1px solid #c9d0db; text-transform: uppercase; letter-spacing: .03em; }
  .sch td { border-bottom: 1px solid #f0f2f6; } .sch .tot td { font-weight: 700; border-top: 1px solid #0B1D34; }
  .n { text-align: right; white-space: nowrap; } .ref { font-family: Menlo, Consolas, monospace; font-size: 8.5px; color: #6b7686; }
  .sub { color: #6b7686; font-size: 9px; } .note, .none { color: #6b7686; font-size: 9.5px; margin: 2px 0 6px; }
  .exc div { padding: 3px 0; border-bottom: 1px solid #f0f2f6; } .exc .open { color: #8E2A22; }
  .sig td { padding: 4px 6px; border-bottom: 1px solid #eef1f5; } .sig td:first-child { width: 120px; color: #4A5468; }
  .bar { margin-bottom: 14px; } .bar a { display: inline-block; background: #0B1D34; color: #fff; text-decoration: none; padding: 7px 14px; border-radius: 6px; font-weight: 700; font-size: 12px; margin-right: 8px; }
  .bar span { color: #6b7686; font-size: 11px; }
  .brk { page-break-inside: avoid; }
</style></head><body>
${!forPdf && pdfHref ? `<div class="bar"><a href="${esc(pdfHref)}">Download PDF</a><span>Version shown: ${esc(w.source)}${w.versions.length > 1 ? ` · ${w.versions.length} runs on file for this month` : ''}</span></div>` : ''}
<div class="hdr"><div><h1>Bank Reconciliation</h1><div class="sub2">${esc((w.community && (w.community.legal_name || w.community.name)) || '')} · ${acct}${w.account && w.account.gl_account_number ? ` · GL ${esc(w.account.gl_account_number)}` : ''}</div><div class="sub2">Period ${esc(longDate(w.period_start))} to ${esc(longDate(w.period_end))}</div></div><div class="badge">${esc(w.standing_label || 'Unreconciled')}</div></div>
${w.standing !== 'reconciled' && (w.standing_reasons || []).length ? `<div class="reasons">${esc(w.standing_label)}: ${esc(w.standing_reasons.join('; '))}.</div>` : ''}
<div class="meta">
  <div>Version: <b>${esc(w.source)}</b>${w.run_id ? ` · run ${esc(String(w.run_id).slice(0, 8))}` : ''}</div>
  <div>Bank statement: <b>${w.statement ? `${esc(longDate(w.statement.statement_period_start))} to ${esc(longDate(w.statement.statement_period_end))}` : 'none on file'}</b>${w.statement && w.statement.status === 'voided' ? ' <b style="color:#8E2A22">(since superseded)</b>' : ''}</div>
  <div>Statement file: <b>${esc((w.statement && w.statement.source_filename) || '—')}</b></div>
  <div>Generated: <b>${esc(stamp(w.generated_at))}</b></div>
</div>

<h2>Summary</h2>
<div class="two brk">
<table class="summ"><tbody>
  ${row('Bank statement beginning balance', w.statement && w.statement.beginning_balance_cents)}
  ${row('Bank statement ending balance', T.bank_ending_cents)}
  ${row('Add: deposits in transit', T.deposits_in_transit_cents)}
  ${row('Less: outstanding checks', T.outstanding_checks_cents)}
  ${row('Bank-side adjustments', T.manual_adjustments_cents != null ? -Number(T.manual_adjustments_cents) : null)}
  ${row('Adjusted bank balance', T.adjusted_bank_cents, { cls: 'tot' })}
</tbody></table>
<table class="summ"><tbody>
  ${row('GL cash balance at period end', T.gl_ending_cents)}
  ${row('Bank items not yet in the GL', T.bank_only_cents)}
  ${row('&nbsp;', null).replace('—', '')}
  ${row('&nbsp;', null).replace('—', '')}
  ${row('&nbsp;', null).replace('—', '')}
  ${row('Adjusted book balance', T.adjusted_book_cents, { cls: 'tot' })}
</tbody></table>
</div>
<table class="summ"><tbody>${row('Difference (adjusted bank less adjusted book)', T.difference_cents, { cls: 'diff' })}</tbody></table>
<p class="note">A zero difference alone is not a reconciliation: the month is Reconciled only when nothing is open and every bank item is recorded in the GL.</p>

<h2>Exceptions</h2>
<div class="exc">${w.exceptions_open.length ? w.exceptions_open.map((e) => `<div class="open">${e.severity === 'blocking' ? '<b>Blocking:</b> ' : ''}${esc(e.text)}${e.amount_cents != null ? ` <span class="n">${money(e.amount_cents)}</span>` : ''}</div>`).join('') : '<p class="none">No open exceptions.</p>'}</div>
${w.exceptions_documented.length ? `<h3>Documented reconciling items</h3><div class="exc">${w.exceptions_documented.map((e) => `<div>${esc(e.text)}</div>`).join('')}</div>` : ''}

<h2>Supporting schedules</h2>
${sched('Outstanding checks', w.outstanding_checks, 'Issued and recorded in the GL, not yet cleared the bank. Checks outstanding past the stale threshold are listed as exceptions for follow-up.')}
${sched('Deposits in transit', w.deposits_in_transit, 'Recorded in the GL, not yet on the bank statement.')}
${sched('Bank items not yet in the GL', w.bank_only, 'On the bank statement, not yet recorded. Each needs an entry before the month is Reconciled.')}
${w.adjustments.length ? sched('Bank-side adjustments', w.adjustments) : ''}
${w.gl_only.length ? sched('GL-only items', w.gl_only) : ''}

${w.receipts.length ? `<h2>Deposit detail: homeowner receipts</h2>${w.receipts.map((p) => `<div class="brk"><h3>${esc(p.description || (p.evidence && p.evidence.bank_description) || 'Deposit')} · ${money(p.amount_cents)}${p.posted === true ? ' · posted' : p.posted === false ? ' · not posted' : ''}</h3>${p.evidence && p.evidence.basis ? `<p class="note">${esc(p.evidence.basis)}</p>` : ''}<table class="sch"><thead><tr><th>Paid</th><th>Account</th><th>Property</th><th>Method</th><th class="n">Amount</th></tr></thead><tbody>${p.receipts.map((x) => `<tr><td>${esc(x.payment_date)}</td><td>${esc(x.vantaca_account_id || '')}</td><td>${esc(x.address || '')}</td><td>${esc(x.method || '')}</td><td class="n">${money(x.amount_cents)}</td></tr>`).join('')}</tbody></table></div>`).join('')}` : ''}

<h2>Matched items <span class="cnt">${w.matched.length}</span></h2>
${w.matched.length ? `<table class="sch"><thead><tr><th>Date</th><th>Description</th><th>Method</th><th>Bank line</th><th>GL reference</th><th class="n">Amount</th></tr></thead><tbody>${w.matched.map((i) => `<tr><td>${esc(day(i.date_ref))}</td><td>${esc(i.description || '')}</td><td>${esc(String(i.match_method || '').replace(/_/g, ' '))}</td><td class="ref">${esc(i.bank_transaction_id ? String(i.bank_transaction_id).slice(0, 8) : '')}</td><td class="ref">${esc(i.gl_ref ? String(i.gl_ref).slice(0, 18) : '')}</td><td class="n">${money(i.amount_cents)}</td></tr>`).join('')}</tbody></table>` : '<p class="none">None.</p>'}

<h2>Preparation and approval</h2>
<table class="sig brk"><tbody>
  <tr><td>Prepared by</td><td>${esc(w.people.prepared_by || '—')}</td><td>${esc(stamp(w.people.prepared_at))}</td></tr>
  <tr><td>Approved by</td><td>${esc(w.people.approved_by || 'Not approved')}</td><td>${esc(stamp(w.people.approved_at))}</td></tr>
  <tr><td>Posted / stored</td><td>${esc(w.people.posted_by || '—')}</td><td>${esc(stamp(w.people.posted_at))}</td></tr>
</tbody></table>
${w.history.length ? `<h3>History</h3><table class="sch"><tbody>${w.history.map((h) => `<tr><td style="width:150px">${esc(stamp(h.at))}</td><td style="width:90px">${esc(h.kind === 'reconciliation_replaced' ? 'replaced' : h.event)}</td><td>${esc(h.actor || '')}${h.text ? `<div class="sub">${esc(h.text)}</div>` : ''}</td></tr>`).join('')}</tbody></table>` : ''}
</body></html>`;
}

async function workpaperPdf(w) {
  const puppeteer = require('puppeteer');
  const html = renderWorkpaperHtml(w, { forPdf: true });
  const e = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/[\u0080-￿]/g, (c) => `&#${c.charCodeAt(0)};`);
  const band = 'font-family:Helvetica,Arial,sans-serif;font-size:7.5px;color:#4A5468;width:100%;padding:0 0.55in;display:flex;justify-content:space-between;';
  const acct = `${(w.account && (w.account.account_nickname || w.account.bank_name)) || ''}${w.account && w.account.account_last4 ? ' ' + w.account.account_last4 : ''}`;
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 45000 });
    return Buffer.from(await page.pdf({ format: 'Letter', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
      headerTemplate: `<div style="${band}"><span>${e((w.community && (w.community.legal_name || w.community.name)) || '')} &middot; Bank Reconciliation &middot; ${e(acct)}</span><span style="font-weight:bold;letter-spacing:.1em;color:${STANDING_COLOR[w.standing] || '#8A5A00'};">${e(String(w.standing_label || '').toUpperCase())}</span></div>`,
      footerTemplate: `<div style="${band}"><span>Prepared by Bedrock Association Management &middot; version: ${e(w.source)}</span><span>Period ending ${e(longDate(w.period_end))}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>` }));
  } finally { await browser.close(); }
}

const fileName = (w) => {
  const ent = String((w.community && (w.community.name)) || 'Association').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const ac = String((w.account && (w.account.account_nickname || 'Account')) || 'Account').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${ent}_Bank-Reconciliation_${ac}_${day(w.period_end)}.pdf`;
};

module.exports = { buildWorkpaper, renderWorkpaperHtml, workpaperPdf, fileName };
