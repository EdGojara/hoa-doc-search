#!/usr/bin/env node
// ============================================================================
// scripts/conversion/lopf_0731_dryrun.js
// ----------------------------------------------------------------------------
// LOPF 7/31/2026 conversion: STAGING DRY RUN. Implementation only.
//
//   1. validates each supplied file against lib/conversion/formats.js
//      (every missing / malformed field -> exception)
//   2. maps each valid row to Trusted records by EXACT key
//      (lib/conversion/mapping.js; anything that does not map exactly -> exception)
//   3. evaluates the EXTERNALLY SUPPLIED control rules against the supplied
//      control totals (lib/conversion/controls.js; no built-in comparisons)
//   4. fingerprints every Trusted row dated after the baseline
//   5. writes backups/lopf-0731-dryrun/dryrun.json + dryrun.md (git-ignored)
//
// It makes no accounting, attribution, duplicate or reconciliation judgment.
// Database: READ-ONLY by default. --stage also records batch, files (sha256),
// rows, controls, rules, the run, rule results and exceptions in the
// conversion_* staging tables (migration 452; refuses if not applied). It
// never writes to the GL, subledgers or any live table.
//
//   node scripts/conversion/lopf_0731_dryrun.js [--inputs=dir] [--out=dir] [--stage]
// ============================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { loadInputSet, FILES } = require('../../lib/conversion/formats');
const { mapInputs } = require('../../lib/conversion/mapping');
const { evaluateControls } = require('../../lib/conversion/controls');

const CID = 'a0000000-0000-4000-8000-000000000002';
const AS_OF = '2026-07-31';
const BATCH = 'CONV-LPF-20260731';
const ROOT = path.resolve(__dirname, '..', '..');
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
const INPUT_DIR = path.resolve(ROOT, arg('inputs', 'backups/lopf-0731-inputs'));
const OUT_DIR = path.resolve(ROOT, arg('out', 'backups/lopf-0731-dryrun'));
const STAGE = process.argv.includes('--stage');

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
async function all(t, sel, b, order = 'id') {
  const out = [];
  for (let f = 0; ; f += 1000) {
    let q = s.from(t).select(sel).order(order).range(f, f + 999);
    if (b) q = b(q);
    const { data, error } = await q;
    if (error) throw new Error(`${t}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}
async function inIds(t, sel, col, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 150) {
    for (let f = 0; ; f += 1000) {
      const { data, error } = await s.from(t).select(sel).in(col, ids.slice(i, i + 150)).order('id').range(f, f + 999);
      if (error) throw new Error(`${t}: ${error.message}`);
      out.push(...data);
      if (data.length < 1000) break;
    }
  }
  return out;
}

async function augustForwardFingerprint() {
  const jes = await all('journal_entries', 'id,posting_date,status,total_debits_cents,total_credits_cents', (q) => q.eq('community_id', CID).gt('posting_date', AS_OF));
  const lines = await inIds('journal_entry_lines', 'id,journal_entry_id,account_id,debit_cents,credit_cents,fund_id', 'journal_entry_id', jes.map((j) => j.id));
  const apInv = await all('ap_invoices', 'id,invoice_date,total_cents,amount_paid_cents,status', (q) => q.eq('community_id', CID).gt('invoice_date', AS_OF));
  const apPay = await all('ap_payments', 'id,payment_date,amount_cents,status', (q) => q.eq('community_id', CID).gt('payment_date', AS_OF));
  const checks = await all('check_register', 'id,issue_date,amount_cents,status,cleared_date', (q) => q.eq('community_id', CID).gt('issue_date', AS_OF));
  const payload = { jes, lines, apInv, apPay, checks };
  const counts = Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, v.length]));
  const hash = crypto.createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, v.map((r) => JSON.stringify(r)).sort()])))).digest('hex');
  return { hash, counts };
}

// Per-file staged-row accounting: rows read, valid, mapped, with exceptions.
function stagedRowStats(inputs, mapping, allExceptions) {
  const out = {};
  for (const [kind, f] of Object.entries(inputs.files)) {
    const exLines = new Set(allExceptions.filter((e) => e.file === kind && e.line > 1).map((e) => e.line));
    const headerEx = allExceptions.filter((e) => e.file === kind && e.line === 1).length;
    const valid = f.rows.filter((r) => !r._errors.length).length;
    const mapped = ['control_totals', 'control_rules'].includes(kind) ? null : f.rows.length - exLines.size;
    out[kind] = { file: f.file, sha256: f.sha256, rows: f.rows.length, format_valid: valid, mapped, rows_with_exceptions: exLines.size, header_exceptions: headerEx };
  }
  return out;
}

async function stageRun(report, inputs, mapping, ctl, stats, allExceptions) {
  const { error: probe } = await s.from('conversion_batches').select('id').limit(1);
  if (probe) throw new Error(`--stage needs migration 452 (conversion_* tables): ${probe.message}`);
  let { data: batch, error: be } = await s.from('conversion_batches').select('id,status').eq('batch_code', BATCH).maybeSingle();
  if (be) throw be;
  if (!batch) {
    const { data, error } = await s.from('conversion_batches').insert({ community_id: CID, batch_code: BATCH, as_of_date: AS_OF, status: 'draft', august_forward_fingerprint: report.august_forward.hash, created_by: 'lopf_0731_dryrun' }).select('id,status').single();
    if (error) throw error;
    batch = data;
  }
  if (['approved', 'posted', 'voided'].includes(batch.status)) throw new Error(`batch ${BATCH} is ${batch.status}; staging refused`);
  const fileIds = {};
  for (const [kind, f] of Object.entries(inputs.files)) {
    const { data: existing, error: xe } = await s.from('conversion_source_files').select('id,sha256').eq('batch_id', batch.id).eq('input_kind', kind).eq('status', 'active').maybeSingle();
    if (xe) throw xe;
    if (existing && existing.sha256 === f.sha256) { fileIds[kind] = existing.id; continue; }
    if (existing) { const { error } = await s.from('conversion_source_files').update({ status: 'superseded' }).eq('id', existing.id); if (error) throw error; }
    const { data: sf, error: fe } = await s.from('conversion_source_files').insert({ batch_id: batch.id, input_kind: kind, filename: f.file, sha256: f.sha256, row_count: f.rows.length, format_ok: f.ok, format_errors: f.exceptions.slice(0, 500), supplied_by: 'Ed / ChatGPT' }).select('id').single();
    if (fe) throw fe;
    fileIds[kind] = sf.id;
    const mappedRows = mapping.mapped[kind] || [];
    const excLines = new Set(allExceptions.filter((e) => e.file === kind).map((e) => e.line));
    const rows = f.rows.map((r, i) => {
      const m = mappedRows[i] || {};
      const { _errors, ...data } = r;
      return {
        batch_id: batch.id, source_file_id: sf.id, input_kind: kind, line_no: r._line, row_data: data,
        conversion_source_key: `${BATCH}:${f.sha256}:${r.source_row || 'line' + r._line}`,
        vantaca_account_id: r.vantaca_account_id || null, account_number: r.account_number || r.gl_account || r.gl_account_number || null,
        amount_cents: r.amount ?? r.amount_open ?? null,
        mapped_property_id: m.property_id || null, mapped_account_id: m.account_id || null, mapped_fund_id: m.fund_id || null,
        mapped_bank_account_id: m.bank_account_id || null, mapped_vendor_id: m.vendor_id || null,
        map_status: excLines.has(r._line) ? 'exception' : ['control_totals', 'control_rules'].includes(kind) ? 'not_applicable' : 'mapped',
      };
    });
    for (let i = 0; i < rows.length; i += 500) { const { error } = await s.from('conversion_staged_rows').insert(rows.slice(i, i + 500)); if (error) throw error; }
    const good = f.rows.filter((r) => !r._errors.length);
    if (kind === 'control_totals' && good.length) { const { error } = await s.from('conversion_control_totals').insert(good.map((r) => ({ batch_id: batch.id, source_file_id: sf.id, control_code: r.control_code, amount_cents: r.amount, as_of: r.as_of, source_report: r.source_report, note: r.note }))); if (error) throw error; }
    if (kind === 'control_rules' && good.length) { const { error } = await s.from('conversion_control_rules').insert(good.map((r) => ({ batch_id: batch.id, source_file_id: sf.id, rule_code: r.rule_code, left_expr: r.left, right_expr: r.right, note: r.note }))); if (error) throw error; }
  }
  const { data: run, error: re } = await s.from('conversion_runs').insert({ batch_id: batch.id, source_file_ids: Object.values(fileIds), counts: ctl.counts, staged_rows: stats, all_pass: report.summary.ready, august_forward_fingerprint: report.august_forward.hash, report, run_by: 'lopf_0731_dryrun' }).select('id').single();
  if (re) throw re;
  if (ctl.results.length) {
    const { error } = await s.from('conversion_control_results').insert(ctl.results.map((c) => ({ run_id: run.id, rule_code: c.rule_code, note: c.note, status: c.status, left_expr: c.left, right_expr: c.right, left_cents: c.left_cents ?? null, right_cents: c.right_cents ?? null, detail: c })));
    if (error) throw error;
  }
  const exRows = allExceptions.map((e) => ({ run_id: run.id, batch_id: batch.id, input_kind: e.file, line_no: e.line, field: e.field || null, code: e.code, detail: e.detail }));
  for (let i = 0; i < exRows.length; i += 500) { const { error } = await s.from('conversion_exceptions').insert(exRows.slice(i, i + 500)); if (error) throw error; }
  return { batch_id: batch.id, run_id: run.id, files: Object.keys(fileIds).length, exceptions: exRows.length };
}

(async () => {
  const report = { generated_at: new Date().toISOString(), batch: BATCH, community_id: CID, as_of: AS_OF, mode: STAGE ? 'DRY_RUN_WITH_STAGING' : 'DRY_RUN_READ_ONLY', input_dir: path.relative(ROOT, INPUT_DIR) };

  const inputs = fs.existsSync(INPUT_DIR) ? loadInputSet(INPUT_DIR) : { dir: INPUT_DIR, files: {}, pending: Object.keys(FILES) };

  const properties = await all('properties', 'id,street_address,vantaca_account_id', (q) => q.eq('community_id', CID));
  const coa = await all('chart_of_accounts', 'id,account_number', (q) => q.eq('community_id', CID));
  const funds = (await all('account_funds', 'id,fund_code', (q) => q.eq('community_id', CID))).map((f) => ({ id: f.id, code: f.fund_code }));
  const bankAccounts = await all('bank_accounts', 'id,gl_account_number,account_last4,is_active', (q) => q.eq('community_id', CID));
  const vendors = await all('vendors', 'id,name');
  const mapping = mapInputs(inputs, { properties, vendors, coa, funds, bankAccounts });
  const ctl = evaluateControls({ inputs });

  const formatEx = Object.values(inputs.files).flatMap((f) => f.exceptions);
  const allExceptions = [...formatEx, ...mapping.exceptions, ...ctl.exceptions];
  const stats = stagedRowStats(inputs, mapping, allExceptions);

  report.inputs = { present: Object.keys(inputs.files), pending: inputs.pending };
  report.staged_rows = stats;
  report.exceptions = { total: allExceptions.length, by_code: allExceptions.reduce((m, e) => { m[e.code] = (m[e.code] || 0) + 1; return m; }, {}), list: allExceptions };
  report.controls = ctl;
  report.reference_counts = { properties: properties.length, chart_of_accounts: coa.length, funds: funds.length, bank_accounts: bankAccounts.length, vendors: vendors.length };
  report.august_forward = await augustForwardFingerprint();
  report.summary = {
    files_present: Object.keys(inputs.files).length,
    files_pending: inputs.pending.length,
    rows_staged: Object.values(stats).reduce((a, x) => a + x.rows, 0),
    rows_with_exceptions: Object.values(stats).reduce((a, x) => a + x.rows_with_exceptions, 0),
    exceptions: allExceptions.length,
    rules: ctl.counts,
    ready: inputs.pending.length === 0 && allExceptions.length === 0 && ctl.all_pass,
  };

  if (STAGE) report.staging = await stageRun(report, inputs, mapping, ctl, stats, allExceptions);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'dryrun.json'), JSON.stringify(report, null, 1));
  const pad = (v, n) => String(v).padEnd(n);
  const md = [
    `# ${BATCH} dry run`, '',
    `Mode: ${report.mode}. Generated ${report.generated_at}. Baseline ${AS_OF}.`,
    `READY: ${report.summary.ready ? 'YES' : 'NO'} (all files present, zero exceptions, every supplied rule PASS)`, '',
    '## Staged rows', '',
    '| file | rows read | valid rows | mapped rows | rows with exceptions | sha256 |', '|---|---:|---:|---:|---:|---|',
    ...Object.entries(stats).map(([k, x]) => `| ${k} | ${x.rows} | ${x.format_valid} | ${x.mapped == null ? 'n/a' : x.mapped} | ${x.rows_with_exceptions}${x.header_exceptions ? ` (+${x.header_exceptions} header)` : ''} | ${x.sha256.slice(0, 12)} |`),
    ...inputs.pending.map((k) => `| ${k} | not supplied | | | | |`), '',
    `## Control rules: ${Object.entries(ctl.counts).map(([k, v]) => `${v} ${k}`).join(', ')}`,
    ctl.rules_file_missing ? '_control_rules.csv not supplied: no rules evaluated._' : '', '',
    ...(ctl.results.length ? ['| rule | status | left | right | variance |', '|---|---|---:|---:|---:|', ...ctl.results.map((r) => `| ${r.rule_code} | ${r.status} | ${r.left_value || (r.waiting_for || r.unknown || []).join(', ')} | ${r.right_value || ''} | ${r.variance || ''} |`)] : []),
    ctl.unused_control_codes.length ? `\nControl totals supplied but not used by any rule: ${ctl.unused_control_codes.join(', ')}` : '', '',
    `## Exceptions: ${allExceptions.length}`, '',
    ...Object.entries(report.exceptions.by_code).map(([k, n]) => `- ${pad(k, 32)} ${n}`),
    '', 'Full list with file / line / field / detail in dryrun.json -> exceptions.list.', '',
    '## August-forward fingerprint', `${report.august_forward.hash} (${JSON.stringify(report.august_forward.counts)})`,
  ].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'dryrun.md'), md + '\n');
  console.log(md);
})().catch((e) => { console.error('DRY RUN FAILED:', e.message); process.exit(1); });
