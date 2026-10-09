#!/usr/bin/env node
// Render the PR C sample statements (Drama Creek Estates, demo fixture, sample figures):
// a web page and a PDF, both from the ONE renderer. Usage: node scripts/render_statement_samples.js <outdir>
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://x'; process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const path = require('path'); const fs = require('fs'); const Module = require('module');
const F = require('../tests/fixtures/drama_creek_statements');
const real = Module._load; Module._load = function (r) { if (r === '@supabase/supabase-js') return { createClient: () => F.fakeClient() }; return real.apply(this, arguments); };
const M = require('../lib/statements/model'); const R = require('../lib/statements/render'); const X = require('../lib/statements/export');
(async () => {
  const out = process.argv[2] || '.'; fs.mkdirSync(out, { recursive: true });
  F.seed(); const sb = F.fakeClient();
  const now = new Date('2026-10-09T18:00:00Z');
  const bs = await M.buildBalanceSheetModel(sb, { community_id: F.CID, as_of: '2026-09-30', now });
  const ib = await M.buildIncomeBudgetModel(sb, { community_id: F.CID, period_end: '2026-09-30', fund: 'OPR', now });
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Drama Creek Estates · Statements (sample)</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600&family=Inter:wght@400;500;600;700&display=swap">
<style>body{margin:0;background:#FBFAF6}.wrap{max-width:1100px;margin:0 auto;padding:24px 20px 60px}.card{background:#fff;border:1px solid #E4E1D7;border-radius:12px;padding:6px 28px 24px;margin-bottom:24px}</style></head><body><div class="wrap">
<div class="card">${R.renderHtml(bs, { mode: 'web' })}</div><div class="card">${R.renderHtml(ib, { mode: 'web' })}</div></div>
<script>document.querySelectorAll('.tstmt button.tg').forEach(function(b){b.addEventListener('click',function(){var o=b.getAttribute('aria-expanded')!=='true';b.setAttribute('aria-expanded',String(o));document.querySelectorAll('[data-of="'+b.dataset.g+'"]').forEach(function(r){r.hidden=!o;});});});</script></body></html>`;
  fs.writeFileSync(path.join(out, 'drama-creek-statements-web.html'), page);
  fs.writeFileSync(path.join(out, 'drama-creek-statements-print.html'), R.renderDocument([bs, ib]));
  fs.writeFileSync(path.join(out, 'drama-creek-statements.pdf'), await X.pdfBuffer([bs, ib]));
  fs.writeFileSync(path.join(out, 'drama-creek-statements.xlsx'), X.xlsxBuffer([bs, ib]));
  fs.writeFileSync(path.join(out, 'drama-creek-models.json'), JSON.stringify({ balance_sheet: bs, income_budget: ib }, null, 2));
  console.log('wrote samples to', out, '| BS snapshot', bs.snapshot_sha256.slice(0, 12), '| IB snapshot', ib.snapshot_sha256.slice(0, 12));
})().catch((e) => { console.error(e.stack); process.exit(1); });
