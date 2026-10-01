#!/usr/bin/env node
// ============================================================================
// evals/production/financial_score.js  (Issue #12): score the raw outputs of
// financial_run.js against the LOPF 7/31/2026 conversion ground truth
// (CONV-LPF-20260731: conversion_staged_rows + conversion_control_totals, the
// human-verified figures read from these exact reports) and the approved 2026
// budget. Business correctness and reconciliation, not parsing:
//   TB       every account+fund ending balance vs the converted TB; debits = credits
//   AR       report total vs AR_GROSS; per-account balances vs the 356 converted lines
//   owner AR same, on the owner-AR ingest path
//   AP       open total vs AP_OPEN_TOTAL; each open invoice vs the converted AP rows
//   bank rec book balance per account vs BANK_*_BOOK; outstanding checks vs the 3 items
//   checks   the 3 known outstanding checks present with exact amounts; count/total
//   txn      per-owner roll-forward (beginning + transactions = ending); models agree
//   GL       per-account roll-forward; total debits = credits
//   budget   per-account annual amounts vs the approved 2026 budget
//   classify report type + community for each source report
// Prints aggregates only (no names); details go to the JSON report outside the repo.
//   node evals/production/financial_score.js <raw.json>
// ============================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BATCH = '091e253c-3a54-4a51-a3c7-137844b211ba';
const LOPF = 'a0000000-0000-4000-8000-000000000002';
const raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const cents = (v) => (v == null || v === '' ? null : Math.round(Number(v) * 100));
const fundKey = (f) => { const s = String(f || '').toUpperCase(); return s.startsWith('RES') ? 'RES' : s.startsWith('SA') ? 'SAV' : s.startsWith('OP') ? 'OPR' : s || '?'; };
const acct = (s) => String(s || '').replace(/[^0-9]/g, '');
const pct = (a, b) => (b ? `${a}/${b}` : `${a}/0`);

async function truth() {
  const rows = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from('conversion_staged_rows').select('input_kind, row_data, source_file_id').eq('batch_id', BATCH).order('id').range(f, f + 999);
    if (error) throw error; rows.push(...data); if (data.length < 1000) break;
  }
  const { data: files } = await sb.from('conversion_source_files').select('id, status').eq('batch_id', BATCH);
  const active = new Set(files.filter((x) => x.status === 'active').map((x) => x.id));
  const by = (k) => rows.filter((r) => r.input_kind === k && active.has(r.source_file_id)).map((r) => r.row_data);
  const { data: ct } = await sb.from('conversion_control_totals').select('control_code, amount_cents').eq('batch_id', BATCH);
  const control = Object.fromEntries(ct.map((x) => [x.control_code, Number(x.amount_cents)]));
  const { data: bud } = await sb.from('community_budgets').select('id').eq('community_id', LOPF).eq('fiscal_year', 2026).eq('status', 'approved').maybeSingle();
  const lines = bud ? (await sb.from('budget_line_items').select('annual_amount_cents, account_id, chart_of_accounts(account_number, account_type)').eq('budget_id', bud.id)).data : [];
  // Per-check truth straight from the register text (deterministic, no AI).
  let checkTruth = {};
  try {
    const pdf = require('pdf-parse');
    const t = (await pdf(fs.readFileSync(path.join(process.env.SRC_DIR || path.join(require('os').homedir(), 'Downloads'), 'CheckRegisterReport.pdf')))).text.replace(/\n/g, ' ');
    const re = /(\d{1,2}\/\d{1,2}\/\d{4})(.*?)Check\s*(\d+)\s*\(\$([\d,]+\.\d\d)\)/g; let m;
    while ((m = re.exec(t))) checkTruth[m[3]] = (checkTruth[m[3]] || 0) + Math.round(parseFloat(m[4].replace(/,/g, '')) * 100);
  } catch (_) {}
  return { checkTruth, tb: by('gl_trial_balance'), ar: by('ar_debits'), ap: by('ap_open'), bank: by('bank_balances'), outstanding: by('outstanding_items'), control, budget: lines || [] };
}

const scorers = {
  tb(v, T) {
    const accts = v.accounts || [];
    const truthMap = new Map(T.tb.map((r) => [`${acct(r.account_number)}|${fundKey(r.fund)}`, Math.abs((r.ending_debit || 0) - (r.ending_credit || 0))]));
    const truthByAcct = new Map(); for (const r of T.tb) truthByAcct.set(acct(r.account_number), (truthByAcct.get(acct(r.account_number)) || 0) + Math.abs((r.ending_debit || 0) - (r.ending_credit || 0)));
    let exact = 0, wrong = 0; const wrongList = [];
    const seen = new Set();
    for (const a of accts) {
      const k = `${acct(a.account_number)}|${fundKey(a.fund_code)}`;
      const want = truthMap.has(k) ? truthMap.get(k) : null;
      if (want == null) continue;
      seen.add(k);
      if (Math.abs(Number(a.ending_balance_cents) || 0) === want) exact++; else { wrong++; wrongList.push(`${k}: got ${a.ending_balance_cents} want ${want}`); }
    }
    const missing = [...truthMap.keys()].filter((k) => !seen.has(k));
    const t = v.totals || {};
    const debits = Number(t.total_debits_cents), credits = Number(t.total_credits_cents);
    const sumDr = accts.reduce((s, a) => s + (Number(a.period_debits_cents) || 0), 0), sumCr = accts.reduce((s, a) => s + (Number(a.period_credits_cents) || 0), 0);
    return {
      summary: `balances exact ${pct(exact, truthMap.size)}, wrong ${wrong}, missing ${missing.length}; period Dr=Cr ${debits === credits ? 'yes' : 'NO'}; rows Dr/Cr sum to totals ${sumDr === debits && sumCr === credits ? 'yes' : 'NO'}`,
      material: wrong > 0 || missing.length > 0 || debits !== credits,
      detail: { exact, wrong, missing, wrongList: wrongList.slice(0, 12), accounts_extracted: accts.length },
    };
  },
  ar(v, T) {
    const rows = v.rows || (v.parsed && v.parsed.rows) || [];
    const reportTotal = cents((v.report_totals || (v.parsed && v.parsed.report_totals) || {}).total_ar);
    const rowSum = rows.reduce((s, r) => s + (cents(r.balance_total) || 0), 0);
    const truthPer = new Map(); for (const r of T.ar) { const a = String(r.source_row || '').split('|')[0]; truthPer.set(a, (truthPer.get(a) || 0) + Number(r.amount || 0)); }
    let exact = 0, wrong = 0; const seen = new Set(); const wrongList = [];
    for (const r of rows) { const a = String(r.account_number || '').trim(); if (!truthPer.has(a)) continue; seen.add(a); if (cents(r.balance_total) === truthPer.get(a)) exact++; else { wrong++; wrongList.push(`${a}: got ${cents(r.balance_total)} want ${truthPer.get(a)}`); } }
    const missing = [...truthPer.keys()].filter((a) => !seen.has(a));
    return {
      summary: `report total ${reportTotal === T.control.AR_GROSS ? 'MATCH' : 'DIFF ' + reportTotal}; row sum ${rowSum === T.control.AR_GROSS ? 'MATCH' : 'DIFF ' + rowSum} (truth ${T.control.AR_GROSS}); accounts exact ${pct(exact, truthPer.size)}, wrong ${wrong}, missing ${missing.length}, rows ${rows.length}`,
      material: reportTotal !== T.control.AR_GROSS || rowSum !== T.control.AR_GROSS || wrong > 0 || missing.length > 0,
      detail: { exact, wrong, missing: missing.length, wrongList: wrongList.slice(0, 12) },
    };
  },
  owner_ar(v, T) { return scorers.ar(v.parsed || v, T); },
  ap(v, T) {
    const total = Number((v.report_totals || {}).total_open_ap_cents);
    const inv = (v.vendors || []).flatMap((x) => (x.invoices || []).map((i) => ({ ...i, vendor: x.vendor_name })));
    const invSum = inv.reduce((s, i) => s + (Number(i.balance_remaining_cents) || 0), 0);
    const truthInv = T.ap.map((r) => ({ num: String(r.invoice_number || String(r.source_row || '').split('|')[1] || ''), amt: Number(r.amount_open) }));
    let matched = 0; for (const t of truthInv) if (inv.some((i) => Number(i.balance_remaining_cents) === t.amt)) matched++;
    return { summary: `open total ${total === T.control.AP_OPEN_TOTAL ? 'MATCH' : 'DIFF ' + total}; invoice sum ${invSum === T.control.AP_OPEN_TOTAL ? 'MATCH' : 'DIFF ' + invSum}; open invoices matched ${pct(matched, truthInv.length)} (extracted ${inv.length})`,
      material: total !== T.control.AP_OPEN_TOTAL || invSum !== T.control.AP_OPEN_TOTAL || matched < truthInv.length, detail: { matched, extracted: inv.length } };
  },
  bank_rec(v, T) {
    const recs = Array.isArray(v) ? v : (v.accounts || v.reconciliations || [v]);
    const want = { '1000': T.control.BANK_1000_BOOK, '1005': T.control.BANK_1005_BOOK, '1100': T.control.BANK_1100_BOOK, '1110': T.control.BANK_1110_BOOK };
    const res = []; let ok = 0;
    // 1000 and 1005 share last4 2449 (operating + ICS sweep): pick the candidate whose book balance the extraction claims, else the first.
    const candidates = (last4) => T.bank.filter((b) => String(b.bank_account_last4) === String(last4));
    for (const r of recs) {
      const cands = candidates(r.bank_account_last4);
      const pick = cands.find((b) => Number(b.reconciled_book_balance) === Number(r.gl_ending_balance_cents)) || cands[0];
      const a = acct(r.gl_account_number).slice(0, 4) || (pick ? String(pick.gl_account_number) : '');
      if (pick && Number(r.bank_ending_balance_cents) !== Number(pick.statement_ending_balance)) res.push(`${a}: statement DIFF ${r.bank_ending_balance_cents} want ${pick.statement_ending_balance}`); if (!want[a]) { res.push(`${r.gl_account_number || '?'}: not a known account`); continue; } const hit = Number(r.gl_ending_balance_cents) === want[a]; if (hit) ok++; res.push(`${a}: book ${hit ? 'MATCH' : 'DIFF ' + r.gl_ending_balance_cents + ' want ' + want[a]}, balanced=${r.balanced}, diff=${r.difference_cents}`); }
    const oc = recs.flatMap((r) => r.outstanding_checks || []);
    const ocMatch = T.outstanding.filter((t) => oc.some((c) => acct(c.check_number) === acct(t.check_number) && Math.abs(Number(c.amount_cents)) === Math.abs(Number(t.amount)))).length;
    return { summary: `accounts extracted ${recs.length}/4, book balances matched ${ok}; outstanding checks matched ${pct(ocMatch, T.outstanding.length)} | ${res.join('; ')}`,
      material: ok < recs.length || (recs.some((r) => acct(r.gl_account_number).startsWith('1000')) && ocMatch < T.outstanding.length), detail: { res, ocMatch } };
  },
  checks(v, T) {
    const cks = v.checks || [];
    const per = T.checkTruth || {};
    const p = {}; cks.forEach((c) => { p[c.check_number] = (p[c.check_number] || 0) + Number(c.amount_cents); });
    const keys = Object.keys(per); const exact = keys.filter((k) => p[k] === per[k]).length;
    const oneRowPerCheck = cks.length === keys.length;
    const sum = cks.reduce((s, c) => s + (Number(c.amount_cents) || 0), 0);
    const found = T.outstanding.filter((t) => cks.some((c) => acct(c.check_number) === acct(t.check_number) && Math.abs(Number(c.amount_cents)) === Math.abs(Number(t.amount)))).length;
    return { summary: `rows ${cks.length} vs ${keys.length} checks (${oneRowPerCheck ? 'one row per check' : 'NOT one row per check'}); per-check totals exact ${pct(exact, keys.length)}; sum ${sum} vs register total ${v.total_amount_cents} (${sum === Number(v.total_amount_cents) ? 'ties' : 'DOES NOT TIE'})`,
      material: !oneRowPerCheck || exact < keys.length || sum !== Number(v.total_amount_cents), detail: { count: cks.length, sum, exact, found } };
  },
  txn(v) {
    const owners = v.owners || [];
    let rollOk = 0, rollBad = 0, tx = 0;
    for (const o of owners) { const t = (o.transactions || []); tx += t.length; if (o.beginning_balance_cents == null || o.ending_balance_cents == null) continue; const s = t.reduce((a, x) => a + (Number(x.amount_cents) || 0), 0); if (Number(o.beginning_balance_cents) + s === Number(o.ending_balance_cents)) rollOk++; else rollBad++; }
    return { summary: `owners ${owners.length}, transactions ${tx}; per-owner roll-forward ties ${pct(rollOk, rollOk + rollBad)}`, material: rollBad > 0, detail: { owners: owners.length, tx, rollOk, rollBad }, sig: { owners: owners.length, tx, endSum: owners.reduce((a, o) => a + (Number(o.ending_balance_cents) || 0), 0) } };
  },
  gl_entries(v) {
    const sets = Array.isArray(v) ? v : (v.accounts || [v]);
    let ok = 0, bad = 0, entries = 0;
    for (const a of sets) { const e = a.entries || a.lines || []; entries += e.length; const dr = e.reduce((s, x) => s + (Number(x.debit_cents) || 0), 0), cr = e.reduce((s, x) => s + (Number(x.credit_cents) || 0), 0); if (a.beginning_balance_cents == null) continue; if (Number(a.beginning_balance_cents) + dr - cr === Number(a.ending_balance_cents) && dr === Number(a.total_debits_cents) && cr === Number(a.total_credits_cents)) ok++; else bad++; }
    return { summary: `account sections ${sets.length}, entries ${entries}; roll-forward + column totals tie ${pct(ok, ok + bad)}`, material: bad > 0, detail: { ok, bad, entries }, sig: { entries } };
  },
  budget(v, T) {
    const items = v.line_items || [];
    const truth = new Map(); for (const l of T.budget) { const a = acct(l.chart_of_accounts && l.chart_of_accounts.account_number); truth.set(a, (truth.get(a) || 0) + Number(l.annual_amount_cents || 0)); }
    const got = new Map(); for (const i of items) got.set(acct(i.account_number), (got.get(acct(i.account_number)) || 0) + Number(i.annual_amount_cents || 0));
    let exact = 0, wrong = 0; const wrongList = [];
    for (const [a, w] of truth) { if (!got.has(a)) continue; if (Math.abs(got.get(a)) === Math.abs(w)) exact++; else { wrong++; wrongList.push(`${a}: got ${got.get(a)} want ${w}`); } }
    const missing = [...truth.keys()].filter((a) => !got.has(a));
    const monthlyOk = items.filter((i) => Array.isArray(i.monthly_amounts_cents) && i.monthly_amounts_cents.length === 12 && i.monthly_amounts_cents.reduce((s, x) => s + Number(x || 0), 0) === Number(i.annual_amount_cents)).length;
    return { summary: `accounts exact ${pct(exact, truth.size)}, wrong ${wrong}, missing ${missing.length}, extracted ${items.length}; monthly sums tie to annual ${pct(monthlyOk, items.length)}`, material: wrong > 0, detail: { exact, wrong, missing, wrongList: wrongList.slice(0, 12) } };
  },
  classify(v) {
    const want = { tb: 'trial_balance', ar: 'ar_aging', ap: 'ap_ledger', bank_rec: 'bank_reconciliation', checks: 'check_register', txn: 'transaction_history', gl_entries: 'gl_export' };
    const res = Object.entries(want).map(([k, w]) => { const g = v[k] || {}; return { k, ok: g.report_type === w, comm: g.community_id === LOPF, got: g.report_type || g.error }; });
    return { summary: `type right ${res.filter((r) => r.ok).length}/7, community right ${res.filter((r) => r.comm).length}/7 | ${res.map((r) => `${r.k}:${r.got}`).join(' ')}`, material: res.some((r) => !r.ok || !r.comm), detail: res };
  },
};

(async () => {
  const T = await truth();
  console.log(`ground truth: TB rows ${T.tb.length}, AR lines ${T.ar.length} (AR_GROSS ${T.control.AR_GROSS}), AP open ${T.ap.length} (${T.control.AP_OPEN_TOTAL}), bank ${T.bank.length}, outstanding checks ${T.outstanding.length}, budget lines ${T.budget.length}\n`);
  const report = {};
  for (const [task, byModel] of Object.entries(raw.tasks)) {
    report[task] = {};
    for (const [m, r] of Object.entries(byModel)) {
      if (!r.ok) { report[task][m] = { summary: 'ERROR ' + r.error, material: true }; continue; }
      try { report[task][m] = scorers[task](r.value, T); } catch (e) { report[task][m] = { summary: 'SCORER ERROR ' + e.message, material: true }; }
      report[task][m].seconds = Math.round(r.ms / 1000);
    }
    for (const [m, s] of Object.entries(report[task])) console.log(`${task.padEnd(10)} ${m.padEnd(11)} ${s.material ? 'MATERIAL' : 'clean   '} ${s.summary} (${s.seconds ?? '-'}s)`);
    const sigs = Object.entries(report[task]).filter(([, s]) => s.sig).map(([m, s]) => `${m}:${JSON.stringify(s.sig)}`);
    if (sigs.length > 1) console.log(`${' '.repeat(10)} models agree: ${new Set(Object.values(report[task]).map((s) => JSON.stringify(s.sig))).size === 1 ? 'yes' : 'NO'}  ${sigs.join('  ')}`);
  }
  const out = process.argv[2].replace(/raw/, 'scored');
  fs.writeFileSync(out, JSON.stringify(report, null, 1));
  console.log('\nscored report (outside the repo):', out);
})().catch((e) => { console.error(e); process.exit(1); });
