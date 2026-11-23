// ============================================================================
// scripts/newfirst_iremit.js  (Ed 2026-11-23)  DRY RUN of NewFirst iRemit payment files
// ----------------------------------------------------------------------------
//   node scripts/newfirst_iremit.js --community="Lakes of Pine Forest" --zip="<iRemit.zip>" \
//        --from=2026-11-01 --to=2026-11-30 --out=<dir> [--crosswalk=<file.json>] [--reviewed=<file.txt>]
//
// Reads the ZIP exactly as iRemit downloads it (TXT, Detail, Summary, Images),
// ties every TXT to its reports, matches accounts, and writes to <out>:
//   <slug>.md / .json        what is ready, what is held and why, what was refused
//   <slug>_kat_items.json    entries in the shape Kat's journal-entry runs take
// Reads the database; writes NOTHING to it. Approval and posting happen only in
// Kat's queue. Reports and images carry homeowner and bank details: keep <out> private.
//   --crosswalk  rows { association_code, remittance_account, vantaca_account_id, status }
//                (until migration 574 is applied; then the table is read too)
//   --reviewed   one payment ref per line: lockbox checks whose IMAGE a person compared
//                with the owner
// ============================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const X = require('../lib/banking/extractors/newfirst_iremit');
const I = require('../lib/ar/iremit_receipts');

const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const usd = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MAX_FILE = 25 * 1024 * 1024;

// The ZIP's files grouped by processing date. Report type comes from the printed
// text, the date from the report itself; file names are never trusted.
async function readZip(buffer) {
  const JSZip = require('jszip');
  const { pdfToLayoutText } = require('../lib/onboarding/pdf_layout');
  const zip = await JSZip.loadAsync(buffer);
  const txts = []; const reports = {}; const problems = [];
  for (const f of Object.values(zip.files)) {
    if (f.dir) continue;
    const name = path.basename(f.name);
    const data = await f.async('nodebuffer');
    if (data.length > MAX_FILE) { problems.push(`${name}: too large`); continue; }
    if (/\.txt$/i.test(name)) { txts.push(X.parseTxt(data, { filename: name })); continue; }
    if (!/\.pdf$/i.test(name)) { problems.push(`${name}: not a TXT or PDF`); continue; }
    let text; try { text = await pdfToLayoutText(data); } catch (e) { problems.push(`${name}: ${e.message}`); continue; }
    const type = X.identifyReport(text);
    if (!type) { problems.push(`${name}: not an iRemit report`); continue; }
    const p = type === 'images' ? X.parseImages(text) : /summary/.test(type) ? X.parseSummary(text) : X.parseDetail(text);
    if (!p.date) { problems.push(`${name}: no report date`); continue; }
    const day = reports[p.date] = reports[p.date] || {};
    if (day[type]) problems.push(`${name}: a second ${type} for ${p.date}`); else day[type] = p;
  }
  const files = txts.map((t) => ({ sha256: t.sha256, filename: t.filename, date: t.file_date, tie: X.tieOut(t, reports[t.file_date] || {}) }));
  for (const d of Object.keys(reports)) if (!txts.some((t) => t.file_date === d)) problems.push(`reports for ${d} have no TXT`);
  return { files, problems };
}

async function loadCommunity(supabase, name, from) {
  const { fetchAll } = require('../lib/db/fetch_all');
  const { data: c, error } = await supabase.from('communities').select('id, slug, name').eq('name', name).maybeSingle();
  if (error) throw error;
  if (!c) throw new Error(`community not found: ${name}`);
  const facts = await require('../lib/ar/vantaca_receipts').loadFacts(supabase, c.id, { from });
  const { data: role, error: re } = await supabase.from('community_account_roles').select('chart_of_accounts(account_number)').eq('community_id', c.id).eq('role', 'undeposited_funds').maybeSingle();
  if (re) throw re;
  facts.undeposited = (role && role.chart_of_accounts && role.chart_of_accounts.account_number) || null;
  const owners = new Map((await fetchAll(supabase, 'v_current_property_owners', { select: 'property_id, vantaca_account_id, owner_name', filters: { community_id: c.id }, orderBy: 'property_id' }))
    .filter((o) => o.vantaca_account_id).map((o) => [String(o.vantaca_account_id), o.owner_name || '']));
  // Kat's open runs and deposits already on the cash accounts: never prepared twice
  const runs = await supabase.from('accounting_runs').select('id, process, status, preview').eq('community_id', c.id).in('process', ['journal_entry', 'bank_reconciliation', 'reclassification']).in('status', ['prepared', 'approved', 'held', 'failed']).order('id').limit(500);
  if (runs.error) throw runs.error;
  if (runs.data.length >= 500) throw new Error('500+ open runs; page this read before relying on it');
  facts.openRuns = runs.data;
  const { fetchAllQuery } = require('../lib/db/fetch_all');
  const lower = new Date(Date.parse(from) - 5 * 864e5).toISOString().slice(0, 10);
  const cashAccounts = [...new Set([...Object.values(facts.gl.cash_by_last4), facts.gl.default_cash].filter(Boolean))];
  facts.cashDebits = (await fetchAllQuery(() => supabase.from('journal_entry_lines').select('id, debit_cents, chart_of_accounts!inner(account_number), journal_entries!inner(community_id, reference, posting_date, status)')
    .eq('journal_entries.community_id', c.id).eq('journal_entries.status', 'posted').gte('journal_entries.posting_date', lower).gt('debit_cents', 0).in('chart_of_accounts.account_number', cashAccounts)))
    .map((l) => ({ account_number: l.chart_of_accounts.account_number, amount_cents: Number(l.debit_cents), date: l.journal_entries.posting_date, ref: l.journal_entries.reference }));
  // the crosswalk table arrives with migration 574; before it, only --crosswalk is used
  let table = [];
  const t = await supabase.from('bank_remittance_accounts').select('association_code, remittance_account, vantaca_account_id, status').eq('community_id', c.id).eq('status', 'confirmed').order('id').limit(1000);
  if (t.error && !/does not exist|schema cache/i.test(t.error.message)) throw t.error;
  if (!t.error) table = t.data;
  if (table.length >= 1000) throw new Error('crosswalk is at the 1000-row cap; page it before relying on it');
  return { community: c, facts, owners, crosswalk: table };
}

function markdown(r) {
  const L = [`# ${r.community}: NewFirst iRemit payments, DRY RUN`, '', `${r.from} to ${r.to}. Generated ${r.generated_at}. Nothing was written or posted.`, '',
    '## Files', '', '| File | Date | Records | Ties to its bank reports |', '|---|---|---|---|'];
  for (const f of r.files) L.push(`| ${f.filename} | ${f.date} | ${f.records} | ${f.ok ? 'yes' : 'NO: ' + f.problems.join('; ')} |`);
  for (const p of r.problems) L.push(`- ${p}`);
  L.push('', `This community: ${usd(r.source_cents)} in ${r.items.length} payment(s); ready ${usd(r.proposed_cents)}; held ${usd(r.held_cents)}. Every payment in one bucket: ${r.ties ? 'yes' : 'NO'}. Other associations: ${r.excluded} payment(s), not included.`, '');
  L.push('| Date | Bank account no. | Vantaca | Amount | Type | Status | Why held |', '|---|---|---|---|---|---|---|');
  for (const i of r.items) L.push(`| ${i.trxn_date} | ${i.provenance.remittance_account} | ${i.account || '-'} | ${usd(i.amount_cents)} | ${i.method}${i.check_number ? ' ' + i.check_number : ''} | ${i.status} | ${i.reason || ''}${i.duplicate_of ? ` (${i.duplicate_of.date}${i.duplicate_of.ref ? ' ' + i.duplicate_of.ref : ''})` : ''} |`);
  if (r.bank) { L.push('', '## Bank lines', ''); for (const b of r.bank) L.push(`- ${b.date} ${usd(b.amount_cents)}: ${b.status}`); }
  return L.join('\n') + '\n';
}

async function main() {
  if (process.argv.includes('--apply') || process.argv.includes('--post')) throw new Error('this script only reads; approval and posting happen in Kat\'s queue');
  const name = arg('community'); const zip = arg('zip'); const from = arg('from'); const to = arg('to'); const out = arg('out');
  if (!name || !zip || !from || !to || !out) throw new Error('--community, --zip, --from, --to and --out are required');
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const src = await readZip(fs.readFileSync(zip));
  const ctx = await loadCommunity(supabase, name, from);
  const crosswalk = [...ctx.crosswalk, ...(arg('crosswalk') ? JSON.parse(fs.readFileSync(arg('crosswalk'), 'utf8')) : [])];
  const reviewed = new Set(arg('reviewed') ? fs.readFileSync(arg('reviewed'), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : []);
  const n = I.toItems({ files: src.files, communityName: name, owners: ctx.owners, crosswalk, reviewedChecks: reviewed });
  const p = I.plan(n, ctx.facts, { from, to });
  const { fetchAllQuery } = require('../lib/db/fetch_all');
  const lines = await fetchAllQuery(() => supabase.from('bank_statement_transactions').select('id, posting_date, amount_cents, bank_statement_imports!inner(community_id, status)')
    .eq('bank_statement_imports.community_id', ctx.community.id).eq('bank_statement_imports.status', 'completed').gte('posting_date', from).lte('posting_date', to).gt('amount_cents', 0));
  const bank = I.matchBank(p.kat_items, lines.map((b) => ({ id: b.id, date: String(b.posting_date).slice(0, 10), amount_cents: Number(b.amount_cents) })));
  const r = { generated_at: new Date().toISOString(), community: name, from, to, files: src.files.map((f) => ({ filename: f.filename, sha256: f.sha256, date: f.date, records: f.tie.records.length, ok: f.tie.ok, problems: f.tie.problems })),
    problems: [...src.problems, ...n.refused.flatMap((x) => x.problems.map((q) => `${x.file}: ${q}`))], excluded: n.excluded.length, ...p, bank };
  fs.mkdirSync(out, { recursive: true });
  const slug = ctx.community.slug || name.replace(/\W+/g, '-').toLowerCase();
  fs.writeFileSync(path.join(out, `${slug}.json`), JSON.stringify(r, null, 2));
  fs.writeFileSync(path.join(out, `${slug}.md`), markdown(r));
  fs.writeFileSync(path.join(out, `${slug}_kat_items.json`), JSON.stringify(p.kat_items, null, 2));
  console.log(`${name}: ${r.items.length} payments ${usd(p.source_cents)}; ready ${usd(p.proposed_cents)}; held ${usd(p.held_cents)}; one bucket each ${p.ties}; files refused ${r.files.filter((f) => !f.ok).length}; bank lines matched ${bank.filter((b) => b.status === 'matched').length} of ${bank.length}`);
}

if (require.main === module) main().catch((e) => { console.error('STOPPED:', e.message); process.exit(1); });
module.exports = { readZip };
