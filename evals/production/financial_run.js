#!/usr/bin/env node
// ============================================================================
// evals/production/financial_run.js  (Issue #12): run the PRODUCTION Vantaca
// financial extractors on the LOPF 7/31/2026 source reports under each model
// (scoped route overrides, no code edits) and save the raw outputs for
// scoring by financial_score.js. Read-only against production; outputs carry
// homeowner data, so they are written OUTSIDE the repo (EVAL_OUT).
//   node evals/production/financial_run.js --models sonnet-4-5,sonnet-5 [--only tb,ar]
// Source reports (LOPF, the exact files the 7/31 conversion controls cite):
//   SRC_DIR (default ~/Downloads): GLTrialBalance (15).pdf, AR Aging (7).pdf,
//   APAging (3).pdf, BankReconciliation (4).pdf, CheckRegisterReport.pdf,
//   Transaction History By Association.pdf, GL Entry Report.pdf; the 2026 budget
//   comes from the LOPF document library.
// ============================================================================
require('dotenv').config({ quiet: true });
process.env.AI_TELEMETRY = process.env.AI_TELEMETRY || 'off';
const fs = require('fs');
const os = require('os');
const path = require('path');
const router = require('../../lib/ai/router');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const MODELS = arg('models', 'sonnet-4-5,sonnet-5').split(',');
const ONLY = arg('only', '') ? arg('only', '').split(',') : null;
const SRC = process.env.SRC_DIR || path.join(os.homedir(), 'Downloads');
const OUT = process.env.EVAL_OUT || os.tmpdir();
const LOPF = 'a0000000-0000-4000-8000-000000000002';
const read = (f) => fs.readFileSync(path.join(SRC, f));

async function budgetPdf() {
  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { data, error } = await sb.from('library_documents').select('file_path, file_name_original').eq('community_id', LOPF).eq('category', 'annual_budget').ilike('file_name_original', '%2026%').limit(1).maybeSingle();
  if (error || !data) throw new Error('2026 budget PDF not found in the library');
  const { data: blob } = await sb.storage.from('documents').download(data.file_path);
  return { buf: Buffer.from(await blob.arrayBuffer()), name: data.file_name_original };
}

const TASKS = {
  tb:        { file: 'GLTrialBalance (15).pdf', run: (b) => require('../../lib/vantaca/extractors/trial_balance').extractFromPdf(b) },
  ar:        { file: 'AR Aging (7).pdf', run: (b) => require('../../lib/vantaca/extractors/ar_aging').extractArFromPdf(b) },
  owner_ar:  { file: 'AR Aging (7).pdf', run: (b) => require('../../api/owner_ar').extractArFromPdf(b) },
  ap:        { file: 'APAging (3).pdf', run: (b) => require('../../lib/vantaca/extractors/ap_ledger').extractFromPdf(b) },
  bank_rec:  { file: 'BankReconciliation (4).pdf', run: (b) => require('../../lib/vantaca/extractors/bank_reconciliation').extractBankReconciliation(b) },
  checks:    { file: 'CheckRegisterReport.pdf', run: (b) => require('../../lib/vantaca/extractors/check_register').extractCheckRegister(b) },
  txn:       { file: 'Transaction History By Association.pdf', run: (b) => require('../../lib/vantaca/extractors/transaction_history').extractTransactionHistory(b) },
  gl_entries:{ file: 'GL Entry Report.pdf', run: (b) => require('../../lib/vantaca/extractors/gl_export').extractGlExport(b) },
  budget:    { file: null, run: async () => { const p = await budgetPdf(); return require('../../lib/accounting/budget_pdf_extractor').extractBudget(p.buf, 'application/pdf', p.name); } },
  classify:  { file: null, run: async () => {
    // Neutral filename so the AI (not the filename heuristic) decides the report type.
    const { classifyVantacaFile } = require('../../lib/vantaca/classifier');
    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const { data: communities } = await sb.from('communities').select('id, name, slug');
    const out = {};
    for (const [k, f] of [['tb', 'GLTrialBalance (15).pdf'], ['ar', 'AR Aging (7).pdf'], ['ap', 'APAging (3).pdf'], ['bank_rec', 'BankReconciliation (4).pdf'], ['checks', 'CheckRegisterReport.pdf'], ['txn', 'Transaction History By Association.pdf'], ['gl_entries', 'GL Entry Report.pdf']]) {
      try { const r = await classifyVantacaFile({ fileBuffer: read(f), filename: 'report.pdf', mime: 'application/pdf', communities: communities || [] }); out[k] = { report_type: r.report_type, community_id: r.community_id, as_of_date: r.as_of_date, confidence: r.report_type_confidence || r.confidence }; } catch (e) { out[k] = { error: e.message }; }
    }
    return out;
  } },
};

(async () => {
  const results = { at: new Date().toISOString(), models: MODELS, tasks: {} };
  for (const [name, t] of Object.entries(TASKS)) {
    if (ONLY && !ONLY.includes(name)) continue;
    results.tasks[name] = {};
    for (const m of MODELS) {
      const t0 = Date.now();
      try {
        const buf = t.file ? read(t.file) : null;
        const value = await router.withRouteOverrides({ '*': m }, () => t.run(buf));
        results.tasks[name][m] = { ok: true, ms: Date.now() - t0, value };
        console.log(`${name.padEnd(10)} ${m.padEnd(11)} ok   ${Math.round((Date.now() - t0) / 1000)}s`);
      } catch (e) {
        results.tasks[name][m] = { ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 500) };
        console.log(`${name.padEnd(10)} ${m.padEnd(11)} ERR  ${String(e.message).slice(0, 140)}`);
      }
    }
  }
  const file = path.join(OUT, `financial-eval-raw-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(results, null, 1));
  console.log('raw outputs (homeowner data, outside the repo):', file);
})().catch((e) => { console.error(e); process.exit(1); });
