#!/usr/bin/env node
// ============================================================================
// scripts/positive_pay_backlog_reconciliation.js  (Ed 2026-10-22)  READ-ONLY
// ----------------------------------------------------------------------------
// The checks trustEd issued on NewFirst accounts that were never sent to Positive
// Pay (go-live 2026-09-10 to the start of tracked files, migration 542). For each
// NewFirst account: every check in the register, sorted into
//   outstanding         issued, not cleared, not voided: candidates for the backlog upload
//   presented (paid)    appeared on a NewFirst exception notice and a staff approval
//                       reply exists that day: the bank already paid it; do not upload
//   presented (no approval found)  on a notice, approval not found in mail: verify
//   voided / stop / cleared
// Former-client accounts (not operational) and accounts not on the Addendum are
// listed separately. Writes nothing; prints Markdown, and CSV with --csv.
//   node scripts/positive_pay_backlog_reconciliation.js > report.md
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { isOperational } = require('../lib/community/lifecycle');
const { fetchAllQuery } = require('../lib/db/fetch_all');

const NEWFIRST = '16e07b6a-8902-4d1a-980e-db78938b98b3';
const ADDENDUM = new Set(['2dd4bf0b-0e71-4da0-b8a7-269845ddf54c', '52cf2b77-4277-4b11-9e3f-60177f419f5f', '13d7c91d-955c-43a1-bee6-a77c8b5a84de', '829b287e-3d9f-4a4e-9eab-4ba437a329be']);
const GO_LIVE = '2026-09-10';   // NewFirst Positive Pay live (Melody Hess to Kat, 2026-09-10)
const STAFF =/@bedrocktx\.com$/i;
const APPROVAL = /\b(approved?|good to pay|ok to pay|pay (?:these|them|all)|are approved)\b/i;
const money = (c) => `$${(Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const centralDay = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));

(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const must = async (q, w) => { const { data, error } = await q; if (error) throw new Error(`${w}: ${error.message}`); return data; };
  const accounts = await must(sb.from('bank_accounts').select('id, community_id, account_nickname, account_last4, is_active, is_check_disbursement, communities(name, management_status, management_end_date)').eq('bank_id', NEWFIRST).order('id'), 'accounts');
  const ids = accounts.map((a) => a.id);
  const checks = await fetchAllQuery(() => sb.from('check_register').select('id, bank_account_id, check_number, issue_date, payee_name, amount_cents, status, voided_at, voided_reason, stop_payment_at, cleared_date, print_run_id, created_at').in('bank_account_id', ids), { orderBy: 'id' });

  // Every NewFirst Positive Pay notice and every staff reply on that subject.
  const mail = await fetchAllQuery(() => sb.from('email_messages').select('id, received_at, sender_email, subject, body_preview, extracted').ilike('subject', '%positive pay%'), { orderBy: 'id' });
  const notices = mail.filter((m) => /newfirst\.com$/i.test(m.sender_email || '') && m.extracted && m.extracted.positive_pay && Array.isArray(m.extracted.positive_pay.items));
  const approvals = mail.filter((m) => STAFF.test(m.sender_email || '') && APPROVAL.test(m.body_preview || '') && m.received_at);
  const approvedDays = new Set(approvals.map((m) => centralDay(m.received_at)));
  const presented = new Map();   // `${last4}|${check}` -> [{day, amount, approved}]
  for (const n of notices) for (const it of n.extracted.positive_pay.items) {
    const k = `${it.account_last4}|${String(Number(it.check_number))}`;
    const d = centralDay(n.received_at);
    const list = presented.get(k) || [];
    if (!list.some((x) => x.day === d)) list.push({ day: d, amount_cents: it.amount_cents, approved: approvedDays.has(d) });
    presented.set(k, list);
  }

  const rows = []; const out = [];
  out.push(`# NewFirst Positive Pay backlog reconciliation (read-only)\n\nGenerated ${new Date().toISOString()}. Source: check_register (all checks on NewFirst accounts), NewFirst exception notices and staff approval replies in email_messages. Nothing was changed.\n`);
  const totals = {};
  for (const a of accounts) {
    const c = a.communities || {};
    const mine = checks.filter((k) => k.bank_account_id === a.id).sort((x, y) => Number(x.check_number) - Number(y.check_number));
    if (!mine.length) continue;
    const former = !isOperational(c);
    const tag = former ? 'FORMER CLIENT' : (ADDENDUM.has(a.id) ? 'On Positive Pay Addendum' : 'NOT on the Addendum');
    out.push(`\n## ${c.name}: ${a.account_nickname} (…${a.account_last4}) [${tag}]\n`);
    out.push('| Check | Issued | Payee | Amount | Register | Reconciliation |\n|---|---|---|---:|---|---|');
    for (const k of mine) {
      const pres = presented.get(`${a.account_last4}|${String(Number(k.check_number))}`) || [];
      const amtMismatch = pres.some((p) => p.amount_cents !== Number(k.amount_cents));
      let cls;
      if (k.status === 'voided' || k.voided_at) cls = 'voided';
      else if (k.status === 'stop_payment' || k.stop_payment_at) cls = 'stop payment';
      else if (k.status === 'cleared' || k.cleared_date) cls = 'cleared';
      else if (pres.length && pres.some((p) => p.approved)) cls = 'presented, approved via exception';
      else if (pres.length) cls = 'presented, approval not found';
      else if (String(k.issue_date) < GO_LIVE) cls = 'issued before go-live, never presented as an exception';
      else cls = 'outstanding';
      if (former) cls = `former client: ${cls}`;
      const note = [pres.length ? `notice ${pres.map((p) => p.day).join(', ')}` : '', amtMismatch ? 'AMOUNT ON NOTICE DIFFERS' : '', k.voided_reason ? `void reason: ${k.voided_reason}` : ''].filter(Boolean).join('; ');
      out.push(`| ${k.check_number} | ${k.issue_date} | ${String(k.payee_name || '').replace(/\|/g, '/')} | ${money(k.amount_cents)} | ${k.status} | ${cls}${note ? ` (${note})` : ''} |`);
      rows.push({ community: c.name, account: a.account_nickname, last4: a.account_last4, addendum: ADDENDUM.has(a.id), former_client: former, check_number: k.check_number, issue_date: k.issue_date, payee: k.payee_name, amount: (Number(k.amount_cents) / 100).toFixed(2), register_status: k.status, reconciliation: cls, notices: pres.map((p) => p.day).join(' '), amount_mismatch: amtMismatch });
      const t = totals[`${c.name} …${a.account_last4}`] || (totals[`${c.name} …${a.account_last4}`] = {});
      t[cls] = t[cls] || { n: 0, cents: 0 }; t[cls].n += 1; t[cls].cents += Number(k.amount_cents);
    }
  }
  out.splice(1, 0, '\n## Summary\n\n| Account | Classification | Checks | Amount |\n|---|---|---:|---:|\n' + Object.entries(totals).flatMap(([acc, t]) => Object.entries(t).map(([k, v]) => `| ${acc} | ${k} | ${v.n} | ${money(v.cents)} |`)).join('\n') + '\n');
  out.push(`\n## Notes\n\n- "Presented, approved via exception": the check appeared on a NewFirst exception notice and a Bedrock staff reply approving payment exists the same day. The bank has already paid it, so it should not be uploaded; it will clear on the statement.\n- "Presented, approval not found": on a notice, but no approval reply was found in the mail record that day. Confirm in the bank portal.\n- "Issued before go-live, never presented as an exception": cut before Positive Pay was on (9/10). Most likely cleared normally with no exception; the register's cleared status is not kept current, so confirm against the bank statement before treating any as open.
- "Outstanding": issued on or after go-live, not yet presented on any notice, not voided or cleared. These are the backlog upload candidates, pending NewFirst's guidance on previously issued checks.\n- Approval replies are matched by day and wording, not by item; a day with an approval reply marks every item on that day's notice. Verify before relying on it.\n- Quail Ridge (First Citizens) is not a NewFirst account and is not included.\n`);
  if (process.argv.includes('--csv')) {
    const keys = Object.keys(rows[0] || {});
    const q = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    process.stdout.write([keys.join(','), ...rows.map((r) => keys.map((k) => q(r[k])).join(','))].join('\n') + '\n');
  } else process.stdout.write(out.join('\n') + '\n');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
