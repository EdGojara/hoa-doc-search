// ============================================================================
// scripts/vantaca_receipts.js — DRY RUN of the post-cutover Vantaca receipts import
// ----------------------------------------------------------------------------
//   node scripts/vantaca_receipts.js --community=lpf --from=2026-08-01 --to=2026-10-31 \
//        --files="C:/Users/edget/Downloads/VantacaPayPayoutContents (1).pdf" --out=<dir>
//
// Reads the original Vantaca PDFs (Payout Contents and/or Deposit Register), reads
// trustEd (read-only), and writes <out>/<slug>.json + <slug>.md: what would post, what
// is already in trustEd, what is held and why, and the source-to-posting tie-out.
// Writes NOTHING to the database. Posting is lib/ar/vantaca_receipts.postPlan, run only
// after Ed approves a reviewed dry run; this script has no flag that reaches it.
// ============================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const V = require('../lib/onboarding/adapters/vantaca');
const { pdfToLayoutText } = require('../lib/onboarding/pdf_layout');
const R = require('../lib/ar/vantaca_receipts');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const money = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const words = (s) => new Set(String(s || '').toLowerCase().replace(/homeowners?|association|owners|inc\b|the\b|at\b|of\b|hoa\b|[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 2).map((w) => w.replace(/s$/, '')));
function sameCommunity(reportName, community) {
  const a = words(reportName); const b = words(community.name);
  if (!a.size || !b.size) return false;
  const hit = [...b].filter((w) => a.has(w)).length;
  return hit / b.size >= 0.6;
}

async function readSources(files, community) {
  const payouts = []; const registers = []; const sources = []; const problems = [];
  for (const f of files) {
    const buffer = fs.readFileSync(f);
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const text = await pdfToLayoutText(buffer);
    const id = V.identify(text);
    if (!id || !['vantaca_pay_payouts', 'deposit_register'].includes(id.type)) { problems.push({ file: path.basename(f), problem: `not a Payout Contents or Deposit Register report (${id ? id.type : 'unrecognized'})` }); continue; }
    const parsed = V.parse(id.type, text, { sha256 });
    const name = id.type === 'vantaca_pay_payouts' ? (parsed.associations[0] || {}).name : parsed.community;
    const src = { name: path.basename(f), path: f, sha256, bytes: buffer.length, buffer, report_type: id.type, period: parsed.period, period_end: parsed.period && parsed.period.end,
      report_community: name, row_count: parsed.rows.length, parsed_cents: parsed.rows.reduce((s, r) => s + r.amount_cents, 0),
      printed_cents: id.type === 'vantaca_pay_payouts' ? parsed.printed.total_payout_cents : parsed.printed.total_cents, defects: parsed.defects };
    if (!sameCommunity(name, community)) { src.rejected = `report is for "${name}", not ${community.name}`; problems.push({ file: src.name, problem: src.rejected }); sources.push(src); continue; }
    if (parsed.defects.length) { src.rejected = 'report did not read cleanly (see defects)'; problems.push({ file: src.name, problem: src.rejected, defects: parsed.defects }); sources.push(src); continue; }
    sources.push(src);
    (id.type === 'vantaca_pay_payouts' ? payouts : registers).push(parsed);
  }
  return { payouts, registers, sources, problems };
}

function markdown(r) {
  const L = [];
  const c = r.community;
  L.push(`# ${c.name}: Vantaca homeowner receipts, DRY RUN`, '');
  L.push(`Window ${r.window.from} to ${r.window.to}. GL cutover ${c.gl_cutover_date}. Generated ${r.generated_at}. Nothing was written.`, '');
  L.push('## Source files', '');
  L.push('| File | Report | Period | Rows | Parsed | Printed total | Ties | SHA-256 |', '|---|---|---|---|---|---|---|---|');
  for (const s of r.sources) L.push(`| ${s.name} | ${s.report_type} | ${s.period ? s.period.start + ' to ' + s.period.end : '?'} | ${s.row_count} | ${money(s.parsed_cents)} | ${s.printed_cents == null ? 'n/a' : money(s.printed_cents)} | ${s.rejected ? 'REJECTED: ' + s.rejected : (s.parsed_cents === s.printed_cents ? 'yes' : 'NO')} | ${s.sha256.slice(0, 12)}… |`);
  if (!r.sources.length) L.push('| (none on file) | | | | | | | |');
  L.push('', '## Coverage of the requested window', '');
  for (const g of r.coverage_gaps) L.push(`- ${g}`);
  if (!r.coverage_gaps.length) L.push('- The source reports cover the whole window.');
  L.push('', '## Tie-out: every source item lands in exactly one bucket', '');
  L.push('| Category | Source | Proposed | Already in trustEd | Before cutover | Outside window | Held |', '|---|---|---|---|---|---|---|');
  for (const [cat, t] of Object.entries(r.plan.reconciliation.by_category)) {
    if (!t.source_count) continue;
    const cell = (x) => `${x.count} / ${money(x.cents)}`;
    L.push(`| ${cat} | ${t.source_count} / ${money(t.source_cents)} | ${cell(t.proposed)} | ${cell(t.already_imported)} | ${cell(t.before_cutover)} | ${cell(t.outside_window)} | ${cell(t.held)} |`);
  }
  L.push('', `Every item in one bucket: **${r.plan.reconciliation.every_item_in_one_bucket ? 'yes' : 'NO'}**. Online payments also on the Deposit Register (counted once): ${r.plan.reconciliation.corroborated_online}. Not homeowner receipts (excluded): ${r.plan.reconciliation.excluded_non_homeowner.count} / ${money(r.plan.reconciliation.excluded_non_homeowner.cents)}.`, '');
  L.push('## Proposed GL entries (one per bank settlement)', '');
  if (!r.plan.entries.length) L.push('None.');
  else {
    L.push('| Date | Reference | Items | Cash | Net | Balanced |', '|---|---|---|---|---|---|');
    for (const e of r.plan.entries) L.push(`| ${e.posting_date} | ${e.source_reference} | ${e.items.length} | ${e.cash_account} | ${money(e.net_cents)} | ${e.balanced ? 'yes' : 'NO'}${e.already_posted ? ' (already posted)' : ''} |`);
  }
  L.push('', `Proposed homeowner ledger rows: ${r.plan.ledgerRows.length}.`, '');
  const held = r.plan.items.filter((i) => i.status === 'held');
  L.push('## Held for review (not posted; nothing else waits on them)', '');
  if (!held.length) L.push('None.');
  else {
    L.push('| Date | Account | Amount | Category | Reason | Detail |', '|---|---|---|---|---|---|');
    for (const h of held) L.push(`| ${h.trxn_date} | ${h.account || '-'} | ${money(h.signed_cents)} | ${h.category} | ${h.reason} | ${h.duplicate_of ? `matches ${h.duplicate_of.reference || h.duplicate_of.source} ${h.duplicate_of.date} ${money(h.duplicate_of.amount_cents)}` : h.description} |`);
  }
  const already = r.plan.items.filter((i) => i.status === 'already_imported');
  if (already.length) L.push('', `## Already in trustEd (skipped)`, '', `${already.length} items, ${money(already.reduce((s, i) => s + i.signed_cents, 0))}. These match receipts already on the homeowner ledger by Vantaca identity.`);
  const former = r.plan.items.filter((i) => i.status === 'proposed' && i.match && i.match.owner === 'former_owner');
  if (former.length) L.push('', `Proposed items on a FORMER owner's account: ${former.length} (${former.map((f) => f.account).join(', ')}).`);
  if (r.problems.length) { L.push('', '## File problems', ''); for (const p of r.problems) L.push(`- ${p.file}: ${p.problem}`); }
  return L.join('\n') + '\n';
}

async function run({ community: key, from, to, files, out }) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const q = /^[0-9a-f-]{36}$/.test(key) ? supabase.from('communities').select('id, slug, name').eq('id', key) : supabase.from('communities').select('id, slug, name').eq('slug', key);
  const { data: cs, error } = await q; if (error) throw error;
  if (!cs || cs.length !== 1) throw new Error(`community ${key} not found`);
  const facts = await R.loadFacts(supabase, cs[0].id, { from });
  const src = await readSources(files, facts.community);
  const normalized = R.normalizeReceipts({ payouts: src.payouts, registers: src.registers });
  const plan = R.planReceipts(normalized, facts, { from, to });
  // Coverage: which part of the window has a payout report, and which has a deposit register.
  const gaps = [];
  const span = (t) => src.sources.filter((s) => !s.rejected && s.report_type === t).map((s) => s.period);
  for (const [t, label] of [['vantaca_pay_payouts', 'Vantaca Pay Payout Contents (online payments)'], ['deposit_register', 'Deposit Register (checks)']]) {
    const ps = span(t);
    if (!ps.length) { gaps.push(`No ${label} on file for ${from} to ${to}.`); continue; }
    const covEnd = ps.map((p) => p.end).sort().pop(); const covStart = ps.map((p) => p.start).sort()[0];
    if (covStart > from) gaps.push(`${label} starts ${covStart}; ${from} up to ${covStart} is not covered.`);
    if (covEnd < to) gaps.push(`${label} ends ${covEnd}; after ${covEnd} through ${to} is not covered.`);
  }
  const report = {
    generated_at: new Date().toISOString(), dry_run: true, window: { from, to },
    community: { id: facts.community.id, slug: facts.community.slug, name: facts.community.name, gl_cutover_date: facts.community.gl_cutover_date },
    gl_accounts: facts.gl, sources: src.sources.map(({ buffer, ...s }) => s), problems: src.problems, coverage_gaps: gaps,
    pending_drafts: facts.draftRefs.length,
    plan: { reconciliation: plan.reconciliation, entries: plan.entries, ledgerRows: plan.ledgerRows, excluded: normalized.excluded,
      items: plan.items.map((i) => ({ vantaca_ref: i.vantaca_ref, status: i.status, reason: i.reason, category: i.category, source: i.source, account: i.account, trxn_date: i.trxn_date, settle_date: i.settle_date, signed_cents: i.signed_cents, check_number: i.check_number, description: i.description, match: i.match, duplicate_of: i.duplicate_of || null, provenance: i.provenance })) },
  };
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${facts.community.slug}.json`), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(out, `${facts.community.slug}.md`), markdown(report));
  return report;
}

if (require.main === module) {
  if (process.argv.includes('--apply')) { console.error('This script is dry-run only. Posting runs only after Ed approves a reviewed dry run.'); process.exit(2); }
  const files = (arg('files', '') || '').split('|').map((s) => s.trim()).filter(Boolean);
  run({ community: arg('community'), from: arg('from'), to: arg('to'), files, out: arg('out', 'vantaca_receipts_dry_run') })
    .then((r) => { const t = r.plan.reconciliation; console.log(`${r.community.name}: proposed ${r.plan.ledgerRows.length} ledger rows, ${r.plan.entries.length} GL entries; held ${r.plan.items.filter((i) => i.status === 'held').length}; already in trustEd ${r.plan.items.filter((i) => i.status === 'already_imported').length}; ties ${t.every_item_in_one_bucket}; gaps: ${r.coverage_gaps.length}`); })
    .catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
}

module.exports = { run, readSources, sameCommunity, markdown };
