#!/usr/bin/env node
// ============================================================================
// scripts/positive_pay_backlog_reconciliation.js  (Ed 2026-10-22)  READ-ONLY
// ----------------------------------------------------------------------------
// The checks trustEd issued on NewFirst accounts that were never sent to Positive
// Pay. Each check is tested against the evidence that it already reached the bank,
// strongest first:
//   1. voided / stop payment in the register             -> never upload
//   2. CLEARED on an imported bank statement (same account, check number and
//      amount) or cleared in the register                -> paid; never upload
//   3. on a NewFirst exception notice                    -> presented; the bank has
//      decided it (approved = paid); never upload
//   4. a statement covers a period after the issue date and the check is not on it
//                                                        -> not cleared as of that
//      statement's end; still open unless it cleared after (October statements)
//   5. no statement after the issue date                 -> clearing status UNKNOWN
// and grouped by issue date: before Positive Pay go-live (2026-09-10) or after.
// Only groups 4 and 5 can be upload candidates, and only after NewFirst says how to
// handle previously issued checks. Writes nothing; Markdown, or CSV with --csv.
//   node scripts/positive_pay_backlog_reconciliation.js > report.md
// ============================================================================
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const { isOperational } = require('../lib/community/lifecycle');
const { fetchAllQuery } = require('../lib/db/fetch_all');

const NEWFIRST = '16e07b6a-8902-4d1a-980e-db78938b98b3';
const ADDENDUM = new Set(['2dd4bf0b-0e71-4da0-b8a7-269845ddf54c', '52cf2b77-4277-4b11-9e3f-60177f419f5f', '13d7c91d-955c-43a1-bee6-a77c8b5a84de', '829b287e-3d9f-4a4e-9eab-4ba437a329be']);
const GO_LIVE = '2026-09-10';   // NewFirst Positive Pay live (Melody Hess to Kat, 2026-09-10)
const STAFF = /@bedrocktx\.com$/i;
const APPROVAL = /\b(approved?|good to pay|ok to pay|pay (?:these|them|all)|are approved)\b/i;
const money = (c) => `$${(Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const centralDay = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
const num = (s) => String(Number(String(s).replace(/[^0-9]/g, '')));

(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const must = async (q, w) => { const { data, error } = await q; if (error) throw new Error(`${w}: ${error.message}`); return data; };
  const accounts = await must(sb.from('bank_accounts').select('id, community_id, account_nickname, account_last4, is_active, communities(name, management_status, management_end_date)').eq('bank_id', NEWFIRST).order('id'), 'accounts');
  const ids = accounts.map((a) => a.id);
  const checks = await fetchAllQuery(() => sb.from('check_register').select('id, bank_account_id, check_number, issue_date, payee_name, amount_cents, status, voided_at, voided_reason, stop_payment_at, cleared_date').in('bank_account_id', ids), { orderBy: 'id' });

  // Imported bank statements: which periods each account has, and every check that cleared.
  const imports = await must(sb.from('bank_statement_imports').select('id, bank_account_id, statement_period_start, statement_period_end, status').in('bank_account_id', ids).eq('status', 'completed').order('id').limit(1000), 'statements');
  const impAcct = new Map(imports.map((i) => [i.id, i.bank_account_id]));
  const coveredThrough = {};
  for (const i of imports) if (i.statement_period_end && (!coveredThrough[i.bank_account_id] || i.statement_period_end > coveredThrough[i.bank_account_id])) coveredThrough[i.bank_account_id] = i.statement_period_end;
  const cleared = imports.length ? await fetchAllQuery(() => sb.from('bank_statement_transactions').select('id, bank_statement_import_id, posting_date, amount_cents, check_number').in('bank_statement_import_id', imports.map((i) => i.id)).not('check_number', 'is', null), { orderBy: 'id' }) : [];
  const clearedBy = new Map();   // `${account}|${check#}` -> [txn]
  for (const t of cleared) { const k = `${impAcct.get(t.bank_statement_import_id)}|${num(t.check_number)}`; (clearedBy.get(k) || clearedBy.set(k, []).get(k)).push(t); }

  // NewFirst exception notices (presented items) and staff approval replies.
  const mail = await fetchAllQuery(() => sb.from('email_messages').select('id, received_at, sender_email, body_preview, extracted').ilike('subject', '%positive pay%'), { orderBy: 'id' });
  const notices = mail.filter((m) => /newfirst\.com$/i.test(m.sender_email || '') && m.extracted && m.extracted.positive_pay && Array.isArray(m.extracted.positive_pay.items));
  const approvedDays = new Set(mail.filter((m) => STAFF.test(m.sender_email || '') && APPROVAL.test(m.body_preview || '') && m.received_at).map((m) => centralDay(m.received_at)));
  const presented = new Map();
  for (const n of notices) for (const it of n.extracted.positive_pay.items) {
    const k = `${it.account_last4}|${num(it.check_number)}`; const d = centralDay(n.received_at);
    const list = presented.get(k) || [];
    if (!list.some((x) => x.day === d)) list.push({ day: d, amount_cents: it.amount_cents, approved: approvedDays.has(d) });
    presented.set(k, list);
  }

  const rows = []; const sections = []; const totals = {};
  for (const a of accounts) {
    const c = a.communities || {};
    const mine = checks.filter((k) => k.bank_account_id === a.id).sort((x, y) => Number(x.check_number) - Number(y.check_number));
    if (!mine.length) continue;
    const former = !isOperational(c);
    const thru = coveredThrough[a.id] || null;
    sections.push(`\n## ${c.name}: ${a.account_nickname} (…${a.account_last4}) [${former ? 'FORMER CLIENT' : (ADDENDUM.has(a.id) ? 'on the Positive Pay Addendum' : 'NOT on the Addendum')}; statements imported through ${thru || 'none'}]\n`);
    sections.push('| Check | Issued | Payee | Amount | Evidence | Upload? |\n|---|---|---|---:|---|---|');
    for (const k of mine) {
      const era = String(k.issue_date) < GO_LIVE ? 'before go-live' : 'after go-live';
      const txns = clearedBy.get(`${a.id}|${num(k.check_number)}`) || [];
      const exact = txns.find((t) => Math.abs(Number(t.amount_cents)) === Number(k.amount_cents));
      const pres = presented.get(`${a.account_last4}|${num(k.check_number)}`) || [];
      let ev, upload;
      if (k.status === 'voided' || k.voided_at) { ev = 'voided'; upload = 'no'; }
      else if (k.status === 'stop_payment' || k.stop_payment_at) { ev = 'stop payment'; upload = 'no'; }
      else if (exact) { ev = `cleared on statement ${exact.posting_date}`; upload = 'no'; }
      else if (k.status === 'cleared' || k.cleared_date) { ev = `cleared in register ${k.cleared_date || ''}`.trim(); upload = 'no'; }
      else if (txns.length) { ev = `check number on statement for a different amount (${txns.map((t) => money(Math.abs(t.amount_cents))).join(', ')})`; upload = 'investigate'; }
      else if (pres.length) { ev = `presented as an exception ${pres.map((p) => p.day).join(', ')}${pres.some((p) => p.approved) ? ', staff approval found' : ', approval not found'}${pres.some((p) => p.amount_cents !== Number(k.amount_cents)) ? ', AMOUNT DIFFERS' : ''}`; upload = 'no (already presented)'; }
      else if (thru && thru >= String(k.issue_date)) { ev = `not cleared through ${thru}`; upload = 'candidate (confirm on October activity)'; }
      else { ev = `clearing unknown: no statement after issue${thru ? ` (latest ${thru})` : ''}`; upload = 'unknown: need statement'; }
      if (former) upload = 'no (former client)';
      const group = upload.startsWith('no') ? 'no upload' : upload.startsWith('candidate') ? 'candidate' : upload.startsWith('investigate') ? 'investigate' : 'unknown';
      sections.push(`| ${k.check_number} | ${k.issue_date} | ${String(k.payee_name || '').replace(/\|/g, '/')} | ${money(k.amount_cents)} | ${ev} | ${upload} |`);
      rows.push({ community: c.name, account: a.account_nickname, last4: a.account_last4, former_client: former, era, check_number: k.check_number, issue_date: k.issue_date, payee: k.payee_name, amount: (Number(k.amount_cents) / 100).toFixed(2), register_status: k.status, evidence: ev, upload, statements_through: thru || '' });
      const key = `${era}|${c.name} …${a.account_last4}|${group}`;
      totals[key] = totals[key] || { n: 0, cents: 0 }; totals[key].n += 1; totals[key].cents += Number(k.amount_cents);
    }
  }
  if (process.argv.includes('--csv')) {
    const keys = Object.keys(rows[0] || {});
    const q = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    process.stdout.write([keys.join(','), ...rows.map((r) => keys.map((k) => q(r[k])).join(','))].join('\n') + '\n');
    return;
  }
  const sum = Object.entries(totals).sort().map(([k, v]) => { const [era, acc, g] = k.split('|'); return `| ${era} | ${acc} | ${g} | ${v.n} | ${money(v.cents)} |`; });
  process.stdout.write([
    `# NewFirst Positive Pay backlog reconciliation (read-only)\n\nGenerated ${new Date().toISOString()}. Evidence: check_register, imported bank statements (bank_statement_transactions), NewFirst exception notices and staff replies. Nothing was changed.\n`,
    '## Summary\n\n| Issued | Account | Status | Checks | Amount |\n|---|---|---|---:|---:|\n' + sum.join('\n'),
    ...sections,
    `\n## How to read this\n\n- "no": voided, stopped, cleared on a statement, or already presented to NewFirst as an exception. Never upload these.\n- "candidate": issued, not on any notice, and NOT on the latest imported statement for the account. Still open as of that statement; confirm against October activity before upload.\n- "unknown: need statement": no imported statement covers the period after the check was issued, so its status cannot be established from trustEd.\n- Approval replies are matched to notices by day and wording, not item by item.\n- Quail Ridge (First Citizens) is not a NewFirst account and is not included.\n`,
  ].join('\n') + '\n');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
