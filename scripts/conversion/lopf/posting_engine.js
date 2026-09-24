#!/usr/bin/env node
// ============================================================================
// scripts/conversion/lopf/posting_engine.js   --  LOPF 7/31/2026 conversion
// ----------------------------------------------------------------------------
// DRY RUN by default. Reads the STAGED batch (conversion_* tables, latest run,
// active files) + the approved decisions, and produces:
//   plan.json        every proposed action (no names; account ids + amounts)
//   projection.json  projected 7/31 TB by account+fund vs the target TB,
//                    cash, AR, prepaid, AP, equity, and the 8/1 state
//   posting.sql      ONE DO block: guards -> DDL (454, 455) -> all postings ->
//                    retirement of prior imports -> cutover date -> in-DB
//                    verification. Any failure raises = everything rolls back.
//   rehearsal.sql    the same block ending in RAISE (always rolls back), used to
//                    prove the SQL runs and the database itself computes
//                    "projected 7/31 TB = target" -- nothing persists.
// It never writes accounting data. Output: backups/lopf-0731-posting/ (ignored).
//
// Ledger decisions baked in (all approved by Ed 2026-09-24):
//   - cutover trial balance approach; opening JE per fund dated 7/31
//   - ADJ-001 Stiley reclass 2400 -> 1300 $150 (OPR)
//   - LEG-001 five former-owner credits: ledger rows with NO property/contact
//   - LEG-002 Inframark: legacy vendor, NULL invoice number
//   - overlap: 30 neutralize at original date, 24 re-post 8/1, 2 none
//   - homeowner opening detail -> homeowner_transactions (the shared ledger)
// ============================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CID = 'a0000000-0000-4000-8000-000000000002';
const BATCH = 'CONV-LPF-20260731';
const AS_OF = '2026-07-31';
const REPOST_DATE = '2026-08-01';
const OUT = path.join(ROOT, 'backups', 'lopf-0731-posting');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const uuid = () => crypto.randomUUID();
const $ = (c) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const q = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

async function all(t, sel, b) { const o = []; for (let f = 0; ; f += 1000) { let x = s.from(t).select(sel).order('id').range(f, f + 999); if (b) x = b(x); const { data, error } = await x; if (error) throw new Error(`${t}: ${error.message}`); o.push(...data); if (data.length < 1000) break; } return o; }
async function inIds(t, sel, col, ids) { const o = []; for (let i = 0; i < ids.length; i += 100) { for (let f = 0; ; f += 1000) { const { data, error } = await s.from(t).select(sel).in(col, ids.slice(i, i + 100)).order('id').range(f, f + 999); if (error) throw new Error(`${t}: ${error.message}`); o.push(...data); if (data.length < 1000) break; } } return o; }
const counts = (je) => je.status === 'posted' || (je.status === 'voided' && !!je.void_reversal_je_id);

(async () => {
  // ------------------------------------------------------------------ load
  const { data: batch, error: be } = await s.from('conversion_batches').select('*').eq('batch_code', BATCH).single();
  if (be) throw be;
  const { data: run, error: re } = await s.from('conversion_runs').select('id,counts,all_pass,run_at').eq('batch_id', batch.id).order('run_at', { ascending: false }).limit(1).single();
  if (re) throw re;
  const files = await all('conversion_source_files', 'id,input_kind,filename,sha256,status', (x) => x.eq('batch_id', batch.id).eq('status', 'active'));
  const fileIds = new Set(files.map((f) => f.id));
  const staged = (await all('conversion_staged_rows', 'id,input_kind,line_no,conversion_source_key,row_data,map_status,mapped_property_id,mapped_account_id,mapped_fund_id,mapped_bank_account_id,mapped_vendor_id,source_file_id', (x) => x.eq('batch_id', batch.id))).filter((r) => fileIds.has(r.source_file_id));
  const kind = (k) => staged.filter((r) => r.input_kind === k);
  const results = await all('conversion_control_results', 'rule_code,status', (x) => x.eq('run_id', run.id));
  const openEx = await all('conversion_exceptions', 'input_kind,line_no,code,status', (x) => x.eq('run_id', run.id).eq('status', 'open'));
  const coa = await all('chart_of_accounts', 'id,account_number,account_type,fund_id', (x) => x.eq('community_id', CID));
  const A = Object.fromEntries(coa.map((a) => [a.id, a]));
  const AN = Object.fromEntries(coa.map((a) => [a.account_number, a]));
  const funds = await all('account_funds', 'id,fund_code', (x) => x.eq('community_id', CID));
  const FC = Object.fromEntries(funds.map((f) => [f.id, f.fund_code]));
  const FID = Object.fromEntries(funds.map((f) => [f.fund_code, f.id]));
  const periods = await all('accounting_periods', 'id,period_start,period_end,status', (x) => x.eq('community_id', CID));
  const periodFor = (d) => { const p = periods.find((x) => x.period_start <= d && x.period_end >= d); if (!p) throw new Error(`no accounting period for ${d}`); if (p.status !== 'open') throw new Error(`period for ${d} is ${p.status}`); return p.id; };
  const { data: com, error: ce } = await s.from('communities').select('management_company_id,gl_cutover_date').eq('id', CID).single();
  if (ce) throw ce;
  const props = await all('properties', 'id,vantaca_account_id,trusted_account_number', (x) => x.eq('community_id', CID));
  const P = Object.fromEntries(props.map((p) => [p.id, p]));
  const owners = await all('v_current_property_owners', 'property_id,owner_contact_id', (x) => x.eq('community_id', CID)).catch(async () => {
    const o = []; for (let f = 0; ; f += 1000) { const { data, error } = await s.from('v_current_property_owners').select('property_id,owner_contact_id').eq('community_id', CID).order('property_id').range(f, f + 999); if (error) throw error; o.push(...data); if (data.length < 1000) break; } return o;
  });
  const OWN = Object.fromEntries(owners.map((o) => [o.property_id, o.owner_contact_id]));
  const disp = JSON.parse(fs.readFileSync(path.join(__dirname, 'overlap_dispositions.json'), 'utf8')).items;
  const DISP = Object.fromEntries(disp.map((d) => [d.je, d]));
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'prior_source_imports.manifest.json'), 'utf8'));
  const jes = await all('journal_entries', 'id,reference,posting_date,source_module,status,void_reversal_je_id,reverses_je_id,total_debits_cents,description', (x) => x.eq('community_id', CID));
  const J = Object.fromEntries(jes.map((j) => [j.id, j]));
  const lines = await inIds('journal_entry_lines', 'id,journal_entry_id,line_number,account_id,fund_id,debit_cents,credit_cents,memo,property_id,vendor_id,bank_account_id', 'journal_entry_id', jes.map((j) => j.id));
  const LBJ = lines.reduce((m, l) => { (m[l.journal_entry_id] = m[l.journal_entry_id] || []).push(l); return m; }, {});

  // ------------------------------------------------------------ preconditions
  const pre = [];
  const need = (ok, msg) => pre.push({ ok: !!ok, msg });
  need(results.length === 14 && results.every((r) => r.status === 'PASS'), `all staged control rules PASS (${results.filter((r) => r.status === 'PASS').length}/${results.length})`);
  need(openEx.length === 0, `no open staging exceptions (${openEx.length})`);
  need(['draft', 'staged', 'validated', 'approved'].includes(batch.status), `batch status ${batch.status}`);
  need(!jes.some((j) => /^CONV-LPF/.test(j.reference)), 'no CONV-LPF journal entries exist yet');
  const native = jes.filter((j) => j.posting_date <= AS_OF && !['vantaca_import', 'opening_entry', 'closing_entry'].includes(j.source_module));
  need(native.length === 32 && native.every((j) => DISP[j.reference]), `32 native pre-cutover JEs, all with an approved disposition (${native.length})`);
  const importer = jes.filter((j) => manifest.journal_entries.ids.includes(j.id));
  need(importer.length === manifest.journal_entries.ids.length && importer.every((j) => j.status === 'posted'), `prior-import manifest intact (${importer.length}/${manifest.journal_entries.ids.length} posted)`);

  // ------------------------------------------------------------ target TB
  const tbRows = kind('gl_trial_balance').map((r) => ({ acct: r.row_data.account_number, fund: r.row_data.fund, account_id: r.mapped_account_id, fund_id: r.mapped_fund_id, dr: r.row_data.ending_debit, cr: r.row_data.ending_credit, key: r.conversion_source_key }));
  const ADJ = [{ acct: '1300', fund: 'OPR', dr: 15000, cr: 0 }, { acct: '2400', fund: 'OPR', dr: 0, cr: 15000 }];
  const target = {};
  for (const r of [...tbRows, ...ADJ]) { const k = `${r.acct}|${r.fund}`; target[k] = (target[k] || 0) + r.dr - r.cr; }

  // ------------------------------------------------------------ build actions
  const plan = { batch: BATCH, batch_id: batch.id, run_id: run.id, generated_at: new Date().toISOString(), actions: [] };
  const newJes = [];
  const addJe = (je, jl) => { const id = uuid(); const dr = jl.reduce((a, l) => a + l.debit_cents, 0); const cr = jl.reduce((a, l) => a + l.credit_cents, 0); if (dr !== cr || dr === 0) throw new Error(`unbalanced ${je.reference}: ${dr} vs ${cr}`); newJes.push({ id, ...je, period_id: periodFor(je.posting_date), total: dr, lines: jl.map((l, i) => ({ id: uuid(), line_number: i + 1, ...l })) }); return id; };

  // 1. opening JE per fund at 7/31 (Vantaca TB as supplied)
  const openingIds = {};
  for (const fund of [...new Set(tbRows.map((r) => r.fund))].sort()) {
    const jl = tbRows.filter((r) => r.fund === fund && (r.dr || r.cr)).map((r) => ({ account_id: r.account_id, fund_id: r.fund_id, debit_cents: r.dr, credit_cents: r.cr, memo: `Vantaca 7/31 TB ${r.acct} (${r.key.split(':').slice(-1)[0]})` }));
    openingIds[fund] = addJe({ reference: `${BATCH}-OPEN-${fund}`, posting_date: AS_OF, source_module: 'opening_entry', description: `Conversion opening balances at 7/31/2026, fund ${fund} (Vantaca GLTrialBalance 7/31 as supplied)`, source_reference: BATCH, notes: `Cutover trial balance approach. Source ${files.find((f) => f.input_kind === 'gl_trial_balance').filename} sha256 ${files.find((f) => f.input_kind === 'gl_trial_balance').sha256}` }, jl);
    plan.actions.push({ type: 'OPENING_JE', fund, reference: `${BATCH}-OPEN-${fund}`, lines: jl.length, amount: $(jl.reduce((a, l) => a + l.debit_cents, 0)) });
  }
  // 2. ADJ-001
  addJe({ reference: `${BATCH}-ADJ-001`, posting_date: AS_OF, source_module: 'manual', description: 'Conversion adjustment ADJ-001: reclass $150.00 debit in prepaid (Vantaca acct 2012720) to AR', source_reference: BATCH, notes: 'Approved by Ed 2026-09-24 (approved_treatments.json ADJ-001)' },
    [{ account_id: AN['1300'].id, fund_id: FID.OPR, debit_cents: 15000, credit_cents: 0, memo: 'ADJ-001 Stiley reclass to AR' }, { account_id: AN['2400'].id, fund_id: FID.OPR, debit_cents: 0, credit_cents: 15000, memo: 'ADJ-001 Stiley reclass from prepaid' }]);
  plan.actions.push({ type: 'CONVERSION_ADJUSTMENT', reference: `${BATCH}-ADJ-001`, amount: '$150.00', lines: 'Dr 1300 OPR / Cr 2400 OPR' });

  // 3. neutralizations + 8/1 re-posts
  for (const j of native.sort((a, b) => (a.reference < b.reference ? -1 : 1))) {
    const d = DISP[j.reference];
    if (d.disposition === 'NONE') { plan.actions.push({ type: 'OVERLAP_NONE', je: j.reference, reason: d.class }); continue; }
    const src = (LBJ[j.id] || []).sort((a, b) => a.line_number - b.line_number);
    const copy = (l, flip) => ({ account_id: l.account_id, fund_id: l.fund_id, debit_cents: flip ? l.credit_cents : l.debit_cents, credit_cents: flip ? l.debit_cents : l.credit_cents, memo: l.memo, property_id: l.property_id, vendor_id: l.vendor_id, bank_account_id: l.bank_account_id });
    addJe({ reference: `${BATCH}-NEUT-${j.reference}`, posting_date: j.posting_date, source_module: 'reversal', reverses_je_id: j.id, description: `Conversion neutralization of ${j.reference} (${d.class}): Vantaca is authoritative through 7/31`, source_reference: j.id, notes: d.basis }, src.map((l) => copy(l, true)));
    plan.actions.push({ type: 'NEUTRALIZE', je: j.reference, date: j.posting_date, amount: $(j.total_debits_cents), class: d.class });
    if (d.disposition === 'NEUTRALIZE_IN_JULY_AND_REPOST_0801') {
      addJe({ reference: `${BATCH}-REPOST-${j.reference}`, posting_date: REPOST_DATE, source_module: 'manual', description: `Conversion re-post of ${j.reference} effective 8/1/2026 (Trusted activity from cutover): ${(j.description || '').slice(0, 80)}`, source_reference: j.id, notes: d.basis }, src.map((l) => copy(l, false)));
      plan.actions.push({ type: 'REPOST_0801', je: j.reference, amount: $(j.total_debits_cents) });
    }
  }

  // 4. homeowner ledger batch (AR, prepaid, legacy former owners)
  const arBatchId = uuid();
  const ht = [];
  let idx = 0;
  for (const r of kind('ar_debits')) {
    const p = P[r.mapped_property_id];
    ht.push({ id: uuid(), row: ++idx, property_id: p.id, contact_id: OWN[p.id] || null, vantaca: r.row_data.vantaca_account_id, trusted: p.trusted_account_number, date: r.row_data.effective_date, type: 'balance_brought_forward', category: r.row_data.charge_category, cents: r.row_data.amount, desc: `Opening balance 7/31/2026 (${r.row_data.charge_category})`, key: r.conversion_source_key, note: null });
  }
  for (const r of kind('ar_credits')) {
    const p = P[r.mapped_property_id];
    const amt = -r.row_data.amount; // positive credit -> negative balance; Stiley -150 -> +150 (ADJ-001)
    const stiley = r.row_data.amount < 0;
    ht.push({ id: uuid(), row: ++idx, property_id: p.id, contact_id: OWN[p.id] || null, vantaca: r.row_data.vantaca_account_id, trusted: p.trusted_account_number, date: r.row_data.effective_date, type: stiley ? 'adjustment' : 'credit', category: r.row_data.charge_category, cents: amt, desc: stiley ? 'Opening balance 7/31/2026: reclassed from prepaid to receivable (ADJ-001)' : 'Opening prepaid/credit 7/31/2026', key: r.conversion_source_key, note: stiley ? 'ADJ-001' : null });
  }
  for (const r of kind('ar_former_owners')) {
    ht.push({ id: uuid(), row: ++idx, property_id: null, contact_id: null, vantaca: r.row_data.vantaca_account_id, trusted: null, date: r.row_data.effective_date, type: 'credit', category: r.row_data.charge_category, cents: -Math.abs(r.row_data.amount), desc: 'Opening former-owner credit 7/31/2026 (LEGACY_UNRESOLVED, no provable lot)', key: r.conversion_source_key, note: 'LEG-001' });
  }
  const htTotal = ht.reduce((a, r) => a + r.cents, 0);
  plan.actions.push({ type: 'AR_LEDGER_BATCH', rows: ht.length, debits: $(ht.filter((r) => r.cents > 0).reduce((a, r) => a + r.cents, 0)), credits: $(ht.filter((r) => r.cents < 0).reduce((a, r) => a + r.cents, 0)), net: $(htTotal), legacy_unresolved_rows: ht.filter((r) => !r.property_id).length, accounts: new Set(ht.map((r) => r.vantaca)).size });

  // 5. AP opening invoices (no GL: carried by the opening JE)
  const apNew = kind('ap_open').map((r) => ({ id: uuid(), vendor_id: r.mapped_vendor_id, inv: r.row_data.invoice_number || null, date: r.row_data.invoice_date, due: r.row_data.due_date || null, total: r.row_data.original_amount, paid: r.row_data.original_amount - r.row_data.amount_open, key: r.conversion_source_key, desc: r.row_data.description, report: r.row_data.source_report }));
  plan.actions.push({ type: 'AP_OPENING_INVOICES', count: apNew.length, open: $(apNew.reduce((a, r) => a + r.total - r.paid, 0)), null_invoice_numbers: apNew.filter((r) => !r.inv).length });
  plan.actions.push({ type: 'SUPERSEDE_PRIOR_IMPORTS', journal_entries: manifest.journal_entries.ids.length, ar_batch: manifest.ar_batch.id, note: 'same transaction; migration 454 DDL applied inside it' });
  plan.actions.push({ type: 'CUTOVER_DATE', from: com.gl_cutover_date, to: '2026-08-01' });

  // ------------------------------------------------------------ projection (JS)
  const retired = new Set(manifest.journal_entries.ids);
  const fundOf = (l) => FC[l.fund_id || (A[l.account_id] && A[l.account_id].fund_id)] || '?';
  const acc = (m, l) => { const k = `${A[l.account_id].account_number}|${fundOf(l)}`; m[k] = (m[k] || 0) + l.debit_cents - l.credit_cents; };
  const proj731 = {}; const proj801 = {}; const projNow = {};
  for (const l of lines) {
    const je = J[l.journal_entry_id];
    if (retired.has(je.id) || !counts(je)) continue;
    if (je.posting_date <= AS_OF) acc(proj731, l);
    if (je.posting_date <= REPOST_DATE) acc(proj801, l);
    acc(projNow, l);
  }
  for (const je of newJes) for (const l of je.lines) { if (je.posting_date <= AS_OF) acc(proj731, l); if (je.posting_date <= REPOST_DATE) acc(proj801, l); acc(projNow, l); }
  const keys = [...new Set([...Object.keys(target), ...Object.keys(proj731)])].sort();
  const variance = keys.filter((k) => (target[k] || 0) !== (proj731[k] || 0)).map((k) => ({ k, target: target[k] || 0, projected: proj731[k] || 0 }));
  const byFund = (m) => { const f = {}; for (const [k, v] of Object.entries(m)) { const fd = k.split('|')[1]; f[fd] = f[fd] || { dr: 0, cr: 0 }; if (v > 0) f[fd].dr += v; else f[fd].cr -= v; } return f; };
  const acctTot = (m, a) => Object.entries(m).filter(([k]) => k.split('|')[0] === a).reduce((x, [, v]) => x + v, 0);
  const typeTot = (m, t) => Object.entries(m).filter(([k]) => AN[k.split('|')[0]] && AN[k.split('|')[0]].account_type === t).reduce((x, [, v]) => x + v, 0);
  const projection = {
    target_equals_projected_731: variance.length === 0, variance,
    tb_by_fund_731: byFund(proj731), tb_by_fund_target: byFund(target),
    cash_731: Object.fromEntries(['1000', '1005', '1100', '1110'].map((a) => [a, acctTot(proj731, a)])),
    ar_1300_731: acctTot(proj731, '1300'), prepaid_2400_731: acctTot(proj731, '2400'), ap_2000_731: acctTot(proj731, '2000'),
    equity_731: Object.fromEntries(Object.entries(proj731).filter(([k]) => /^3/.test(k)).map(([k, v]) => [k, v])),
    ar_ledger: { debits: ht.filter((r) => r.cents > 0).reduce((a, r) => a + r.cents, 0), credits: ht.filter((r) => r.cents < 0).reduce((a, r) => a + r.cents, 0), net: htTotal, current_owner_credits: ht.filter((r) => r.cents < 0 && r.property_id).reduce((a, r) => a + r.cents, 0), legacy_unresolved: ht.filter((r) => !r.property_id).reduce((a, r) => a + r.cents, 0) },
    ap_subledger_opening: apNew.reduce((a, r) => a + r.total - r.paid, 0),
    state_801: { ap_2000: acctTot(proj801, '2000'), expense: typeTot(proj801, 'expense') - typeTot(proj731, 'expense'), revenue: typeTot(proj801, 'revenue') - typeTot(proj731, 'revenue'), cash_1000: acctTot(proj801, '1000') },
    state_today: { ap_2000: acctTot(projNow, '2000'), cash_1000: acctTot(projNow, '1000') },
  };

  // ------------------------------------------------------------ SQL
  const augJes = jes.filter((j) => j.posting_date > AS_OF);
  const augSum = augJes.reduce((a, j) => a + j.total_debits_cents, 0);
  const augLines = lines.filter((l) => J[l.journal_entry_id].posting_date > AS_OF).length;
  const nativeSum = native.reduce((a, j) => a + j.total_debits_cents, 0);
  const tgtValues = Object.entries(target).filter(([, v]) => v !== 0).map(([k, v]) => `(${q(k.split('|')[0])},${q(k.split('|')[1])},${v})`).join(',\n      ');
  const S = [];
  S.push(`-- ${BATCH} posting. Generated ${plan.generated_at} from run ${run.id}. ONE statement: any error rolls back ALL of it.`);
  S.push(`DO $post$\nDECLARE n bigint; v bigint; bad text;\nBEGIN`);
  S.push(`  -- guards`);
  S.push(`  PERFORM 1 FROM conversion_batches WHERE id = ${q(batch.id)} AND status IN ('draft','staged','validated','approved') FOR UPDATE;\n  IF NOT FOUND THEN RAISE EXCEPTION 'batch not postable'; END IF;`);
  S.push(`  SELECT count(*) INTO n FROM journal_entries WHERE community_id = ${q(CID)} AND reference LIKE 'CONV-LPF%';\n  IF n <> 0 THEN RAISE EXCEPTION 'conversion entries already exist (%)', n; END IF;`);
  S.push(`  SELECT count(*), coalesce(sum(total_debits_cents),0) INTO n, v FROM journal_entries WHERE community_id = ${q(CID)} AND posting_date > ${q(AS_OF)};\n  IF n <> ${augJes.length} OR v <> ${augSum} THEN RAISE EXCEPTION 'August-forward activity changed since the plan (% JEs, %)', n, v; END IF;`);
  S.push(`  SELECT count(*) INTO n FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.journal_entry_id WHERE j.community_id = ${q(CID)} AND j.posting_date > ${q(AS_OF)};\n  IF n <> ${augLines} THEN RAISE EXCEPTION 'August-forward lines changed (%)', n; END IF;`);
  S.push(`  SELECT count(*), coalesce(sum(total_debits_cents),0) INTO n, v FROM journal_entries WHERE id IN (${native.map((j) => q(j.id)).join(',')}) AND status IN ('posted','voided');\n  IF n <> ${native.length} OR v <> ${nativeSum} THEN RAISE EXCEPTION 'native pre-cutover entries changed'; END IF;`);
  S.push(`  PERFORM 1 FROM vendors WHERE id = 'c624bfa2-3464-4dba-bd8f-fcc82e8a908d' AND name = 'INFRAMARK' AND is_active = false;\n  IF NOT FOUND THEN RAISE EXCEPTION 'INFRAMARK legacy vendor missing'; END IF;`);
  S.push(`  -- schema (migrations 454, 455), inside this transaction`);
  S.push(`  PERFORM 1 FROM information_schema.columns WHERE table_name = 'journal_entries' AND column_name = 'superseded_at';\n  IF NOT FOUND THEN\n    SELECT conname INTO bad FROM pg_constraint WHERE conrelid = 'journal_entries'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%status%draft%posted%voided%';\n    IF bad IS NOT NULL THEN EXECUTE format('ALTER TABLE journal_entries DROP CONSTRAINT %I', bad); END IF;\n    EXECUTE $x$ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_status_check CHECK (status IN ('draft','posted','voided','superseded'))$x$;\n    EXECUTE 'ALTER TABLE journal_entries ADD COLUMN superseded_at TIMESTAMPTZ, ADD COLUMN superseded_reason TEXT, ADD COLUMN superseded_by_conversion TEXT';\n    EXECUTE $x$ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_superseded_audit CHECK (status <> 'superseded' OR (superseded_at IS NOT NULL AND superseded_reason IS NOT NULL))$x$;\n  END IF;`);
  S.push(`  SELECT conname INTO bad FROM pg_constraint WHERE conrelid = 'homeowner_transactions'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%charge_category%';\n  IF bad IS NOT NULL AND pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = bad AND conrelid = 'homeowner_transactions'::regclass)) NOT ILIKE '%nsf_fee%' THEN\n    EXECUTE format('ALTER TABLE homeowner_transactions DROP CONSTRAINT %I', bad);\n    EXECUTE $x$ALTER TABLE homeowner_transactions ADD CONSTRAINT homeowner_transactions_charge_category_check CHECK (charge_category IS NULL OR charge_category IN ('assessment','late_fee','interest','fine','attorney_fee','admin_fee','payment','credit','refund','adjustment','prior_balance','other','certified_letter','attorney_fee_other','nsf_fee'))$x$;\n  END IF;`);
  S.push(`  -- journal entries (${newJes.length})`);
  for (const je of newJes) {
    S.push(`  INSERT INTO journal_entries (id, community_id, period_id, posting_date, reference, description, source_module, source_reference, total_debits_cents, total_credits_cents, reverses_je_id, status, notes) VALUES (${q(je.id)}, ${q(CID)}, ${q(je.period_id)}, ${q(je.posting_date)}, ${q(je.reference)}, ${q(je.description)}, ${q(je.source_module)}, ${q(je.source_reference)}, ${je.total}, ${je.total}, ${q(je.reverses_je_id || null)}, 'posted', ${q(je.notes || null)});`);
    S.push(`  INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, fund_id, debit_cents, credit_cents, memo, property_id, vendor_id, bank_account_id) VALUES\n    ${je.lines.map((l) => `(${q(l.id)}, ${q(je.id)}, ${l.line_number}, ${q(l.account_id)}, ${q(l.fund_id)}, ${l.debit_cents}, ${l.credit_cents}, ${q(l.memo || null)}, ${q(l.property_id || null)}, ${q(l.vendor_id || null)}, ${q(l.bank_account_id || null)})`).join(',\n    ')};`);
  }
  S.push(`  -- homeowner ledger: conversion batch (${ht.length} rows)`);
  S.push(`  INSERT INTO transaction_upload_batches (id, management_company_id, community_id, period_label, as_of_date, source_filename, source_format, row_count, account_count, total_charges_cents, total_payments_cents, status, uploaded_by, committed_at, min_transaction_date, max_transaction_date, notes) VALUES (${q(arBatchId)}, ${q(com.management_company_id)}, ${q(CID)}, 'LOPF conversion opening balances 7/31/2026', ${q(AS_OF)}, ${q(files.filter((f) => /^ar_/.test(f.input_kind)).map((f) => f.filename + '@' + f.sha256.slice(0, 12)).join(' + '))}, 'manual', ${ht.length}, ${new Set(ht.map((r) => r.vantaca)).size}, ${ht.filter((r) => r.cents > 0).reduce((a, r) => a + r.cents, 0)}, ${-ht.filter((r) => r.cents < 0).reduce((a, r) => a + r.cents, 0)}, 'committed', ${q('conversion:' + BATCH)}, now(), ${q(ht.map((r) => r.date).sort()[0])}, ${q(ht.map((r) => r.date).sort().pop())}, 'Conversion opening homeowner balances (AR, prepaid, LEG-001). Replaces prior import c732b43c.');`);
  for (let i = 0; i < ht.length; i += 200) {
    S.push(`  INSERT INTO homeowner_transactions (id, source_batch_id, source_row_index, community_id, vantaca_account_id, property_id, contact_id, trusted_account_number, transaction_date, description, txn_type, charge_category, amount_cents, notes) VALUES\n    ${ht.slice(i, i + 200).map((r) => `(${q(r.id)}, ${q(arBatchId)}, ${r.row}, ${q(CID)}, ${q(r.vantaca)}, ${q(r.property_id)}, ${q(r.contact_id)}, ${q(r.trusted)}, ${q(r.date)}, ${q(r.desc)}, ${q(r.type)}, ${q(r.category)}, ${r.cents}, ${q([r.note, 'key ' + r.key].filter(Boolean).join(' | '))})`).join(',\n    ')};`);
  }
  S.push(`  -- AP opening invoices (${apNew.length}); GL carried by the OPR opening entry`);
  S.push(`  INSERT INTO ap_invoices (id, community_id, vendor_id, vendor_invoice_number, invoice_date, due_date, subtotal_cents, total_cents, amount_paid_cents, status, posting_journal_entry_id, notes) VALUES\n    ${apNew.map((r) => `(${q(r.id)}, ${q(CID)}, ${q(r.vendor_id)}, ${q(r.inv)}, ${q(r.date)}, ${q(r.due)}, ${r.total}, ${r.total}, ${r.paid}, 'approved', ${q(openingIds.OPR)}, ${q(`Conversion opening AP (${BATCH}); Vantaca AP aging 7/31: ${r.desc || ''}; ${r.report}; key ${r.key}`)})`).join(',\n    ')};`);
  S.push(`  -- retire prior source imports (same transaction)`);
  S.push(`  UPDATE journal_entries SET status = 'superseded', superseded_at = now(), superseded_by_conversion = ${q(BATCH)}, superseded_reason = 'PRIOR_SOURCE_IMPORT retired at 7/31/2026 cutover; replaced by per-fund conversion opening entries'\n   WHERE id IN (${manifest.journal_entries.ids.map(q).join(',')}) AND status = 'posted';\n  GET DIAGNOSTICS n = ROW_COUNT; IF n <> ${manifest.journal_entries.ids.length} THEN RAISE EXCEPTION 'superseded % of ${manifest.journal_entries.ids.length}', n; END IF;`);
  S.push(`  UPDATE transaction_upload_batches SET status = 'reverted', reverted_at = now(), replaced_by_batch_id = ${q(arBatchId)}, reverted_reason = 'PRIOR_SOURCE_IMPORT retired at 7/31/2026 cutover (${BATCH}); reference only'\n   WHERE id = ${q(manifest.ar_batch.id)} AND status = 'committed' AND row_count = ${manifest.ar_batch.row_count};\n  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION 'prior AR batch not retired'; END IF;`);
  S.push(`  UPDATE communities SET gl_cutover_date = '2026-08-01' WHERE id = ${q(CID)};`);
  S.push(`  UPDATE conversion_batches SET status = 'posted', approved_by = 'Ed', approved_at = now(), notes = coalesce(notes,'') || ' posted from run ${run.id}' WHERE id = ${q(batch.id)};`);
  S.push(`  -- in-database verification: live 7/31 TB (account+fund) must equal the target exactly`);
  S.push(`  WITH live AS (\n    SELECT c.account_number a, f.fund_code fd, sum(l.debit_cents - l.credit_cents) v\n    FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.journal_entry_id\n    JOIN chart_of_accounts c ON c.id = l.account_id\n    LEFT JOIN account_funds f ON f.id = coalesce(l.fund_id, c.fund_id)\n    WHERE j.community_id = ${q(CID)} AND j.posting_date <= ${q(AS_OF)}\n      AND (j.status = 'posted' OR (j.status = 'voided' AND j.void_reversal_je_id IS NOT NULL))\n    GROUP BY 1, 2 HAVING sum(l.debit_cents - l.credit_cents) <> 0),\n  tgt(a, fd, v) AS (VALUES\n      ${tgtValues})\n  SELECT string_agg(coalesce(live.a, tgt.a) || '/' || coalesce(live.fd, tgt.fd) || ' live ' || coalesce(live.v, 0) || ' target ' || coalesce(tgt.v, 0), '; ')\n    INTO bad FROM live FULL JOIN tgt ON tgt.a = live.a AND tgt.fd = live.fd\n   WHERE coalesce(live.v, 0) <> coalesce(tgt.v, 0);\n  IF bad IS NOT NULL THEN RAISE EXCEPTION 'LIVE 7/31 TB != TARGET: %', bad; END IF;`);
  S.push(`  SELECT coalesce(sum(amount_cents),0) INTO v FROM homeowner_transactions WHERE source_batch_id = ${q(arBatchId)};\n  IF v <> ${htTotal} THEN RAISE EXCEPTION 'homeowner ledger batch total % <> ${htTotal}', v; END IF;`);
  S.push(`  SELECT count(*), coalesce(sum(total_debits_cents),0) INTO n, v FROM journal_entries WHERE community_id = ${q(CID)} AND posting_date > ${q(AS_OF)} AND reference NOT LIKE 'CONV-LPF%';\n  IF n <> ${augJes.length} OR v <> ${augSum} THEN RAISE EXCEPTION 'pre-existing August-forward entries changed'; END IF;`);
  S.push(`  --@@END@@\nEND\n$post$;`);
  const posting = S.join('\n');
  const rehearsal = posting.replace('  --@@END@@', `  RAISE EXCEPTION 'REHEARSAL_OK: all guards passed, % conversion JEs, live 7/31 TB = target on every account+fund, ledger batch % rows net %; rolled back', ${newJes.length}, ${ht.length}, ${htTotal};`);

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'plan.json'), JSON.stringify({ ...plan, preconditions: pre, new_journal_entries: newJes.map((j) => ({ reference: j.reference, date: j.posting_date, module: j.source_module, lines: j.lines.length, amount: $(j.total) })) }, null, 1));
  fs.writeFileSync(path.join(OUT, 'projection.json'), JSON.stringify(projection, null, 1));
  fs.writeFileSync(path.join(OUT, 'posting.sql'), posting);
  fs.writeFileSync(path.join(OUT, 'rehearsal.sql'), rehearsal);
  const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
  console.log(JSON.stringify({ preconditions: pre, actions: plan.actions.reduce((m, a) => { m[a.type] = (m[a.type] || 0) + 1; return m; }, {}), new_jes: newJes.length, ht_rows: ht.length, ap: apNew.length, target_equals_projected_731: projection.target_equals_projected_731, variance: projection.variance, posting_sql_sha256: sha(posting), rehearsal_sql_sha256: sha(rehearsal), rehearsal_bytes: rehearsal.length }, null, 1));
})().catch((e) => { console.error('ENGINE FAILED:', e.message); process.exitCode = 1; });
