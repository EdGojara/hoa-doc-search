#!/usr/bin/env node
// ============================================================================
// scripts/ap_replay_emails.js  (Issue #14 recovery)
// ----------------------------------------------------------------------------
// Re-runs ONLY the named Emma emails through the deployed AP intake path
// (lib/ap/email_bill_intake.js: every bill format, autoIntake with its
// duplicate guards and review flags, one recorded outcome). Never approves or
// pays. Autopay vendors get is_ach_autopay from the vendor flag, which keeps the
// bill out of check runs and blocks a check payment against it.
//
//   node scripts/ap_replay_emails.js --ids <id,id>                 # DRY RUN (default): reads only
//   node scripts/ap_replay_emails.js --ids <id,id> --apply         # files payables / exceptions
//        [--fee-hold <id,...>]   do NOT add the vendor's convenience fee for these
//                                emails; the bill is forced to review with a note
//        [--out <file.json>]     where to write the before/after log
//
// Dry run: no database, storage, or model-telemetry writes. It reads each
// email's attachments, reads each bill with the invoice reader, and shows what
// is already on file (by file hash, source ref, vendor + invoice #).
// Apply: refuses any email that fails a precondition; skips (no-op) one that is
// already done; prints a before/after snapshot per email and checks invariants.
// ============================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { parseArgs, preconditions, diffSnapshots, invariantViolations, snapshot, predictOutcome } = require('../lib/ap/replay_emails');

const args = parseArgs(process.argv.slice(2));
if (args.error) { console.error(`ap_replay_emails: ${args.error}`); process.exit(2); }
if (!args.apply) process.env.AI_TELEMETRY = 'off'; // dry run writes nothing, not even usage telemetry

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const money = (c) => (c == null ? '-' : `$${(c / 100).toFixed(2)}`);
const SELECT = 'id, mailbox, graph_id, persona, direction, has_attachments, subject, sender_email, received_at, community_id, resolved_vendor_id, classification, triage_status, extracted, body_full, body_preview';

async function dryRun(m, opts) {
  const { loadBillAttachments, withDeps } = require('../lib/ap/email_bill_intake');
  const { prepareBillFiles } = require('../lib/ap/bill_files');
  const { extractInvoice } = require('../lib/ap/invoice_extract');
    const prepared = await prepareBillFiles(await loadBillAttachments(m, withDeps({ supabase })));
  const files = [];
  for (const f of prepared.files) {
    const sha = crypto.createHash('sha256').update(f.buffer).digest('hex');
    let x = null, err = null;
    try { x = await extractInvoice(f); } catch (e) { err = e.message; }
    // PARITY with intake's vendor step: the SAME resolveInvoiceVendor (invoice
    // vendor by email/name, the email hint only when the bill names none, a
    // staff-named vendor, else CREATE from the invoice), in dry-run mode: it
    // reports the vendor intake WOULD create and writes nothing. A vendor an
    // earlier email in this run would create is reused, as intake would.
    let vendor = null, wouldCreate = null;
    if (x) {
      const { resolveInvoiceVendor, staffDirectivesFor } = require('../lib/ap/intake');
      const directives = await staffDirectivesFor({ staffNote: m.body_full || m.body_preview || '', staffSenderEmail: m.sender_email || '' });
      const vr = await resolveInvoiceVendor({ extracted: x, vendorIdHint: m.resolved_vendor_id || null, directives, dryRun: true });
      if (vr.vendor) vendor = { id: vr.vendor.id, name: vr.vendor.name, via: vr.method || 'match' };
      else if (vr.would_create) {
        const key = String(vr.would_create.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (opts.runVendors.has(key)) vendor = { id: null, name: vr.would_create.name, via: `created earlier in this run by ${opts.runVendors.get(key).slice(0, 8)}` };
        else { wouldCreate = vr.would_create; opts.runVendors.set(key, m.id); }
      } else if (vr.ambiguous) err = err || vr.reason;
    }
    let vrow = null;
    if (vendor && vendor.id) { const { data, error } = await supabase.from('vendors').select('name, auto_pay_ach, convenience_fee_cents, w9_on_file').eq('id', vendor.id).maybeSingle(); if (error) throw error; vrow = data; }
    if (!vrow && (wouldCreate || (vendor && !vendor.id))) vrow = { name: (wouldCreate || vendor).name, auto_pay_ach: false, convenience_fee_cents: 0, w9_on_file: false, _new: true };
    const { data: sameFile, error: e1 } = await supabase.from('ap_invoices').select('id, vendor_invoice_number, total_cents, status').eq('file_sha256', sha).neq('status', 'voided').limit(5);
    if (e1) throw e1;
    const { data: sameExc, error: e2 } = await supabase.from('ap_intake_exceptions').select('id, status, intake_source_ref, community_id').eq('file_sha256', sha).limit(5);
    if (e2) throw e2;
    let sameInvoice = [];
    if (vendor && vendor.id && x && x.invoice_number) {
      const { data, error } = await supabase.from('ap_invoices').select('id, vendor_invoice_number, total_cents, status, community_id').eq('vendor_id', vendor.id).neq('status', 'voided').limit(400);
      if (error) throw error;
      const n = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+(?=\d)/, '');
      sameInvoice = (data || []).filter((i) => n(i.vendor_invoice_number) === n(x.invoice_number));
    }
    // Community the same way intake resolves it: the email's link, else the
    // vendor's service account / single-community mapping (read only).
    let community = m.community_id ? { id: m.community_id, via: 'email link' } : null;
    if (!community && x) { const r = await require('../lib/ap/vendor_community').resolveMapping({ accountNumber: x.account_number, vendorId: (vendor && vendor.id) || null, vendorName: x.vendor_name }); if (r.community_id) community = { id: r.community_id, via: r.via }; }
    const vendorKnown = !!(vendor || wouldCreate);
    const missing = [!vendorKnown && 'vendor could not be resolved or created', !community && 'community not resolved', !(x && x.total_cents) && 'no total', !(x && x.invoice_date) && 'no printed invoice date'].filter(Boolean);
    // PARITY with intake: commitInvoice adds the convenience fee, then runs the
    // SAME findDuplicates (every rule, incl. account + service period). The dry
    // run calls it with the same candidate, so its verdict is intake's verdict.
    let dup = null, feeAppliedCents = 0;
    if (!missing.length) {
      const { getVendorConvenienceFee } = require('../lib/ap/convenience_fee');
      const { staffAsksForConvenienceFee } = require('../lib/ap/intake');
      const fee = vendor && vendor.id ? await getVendorConvenienceFee(supabase, vendor.id) : { cents: 0 };
      const feeCents = fee.cents || (staffAsksForConvenienceFee(m.body_full || m.body_preview || '') ? 100 : 0);
      feeAppliedCents = opts.feeHold ? 0 : feeCents;
      dup = await require('../lib/ap/dedup').findDuplicates(supabase, {
        communityId: community.id, vendorId: (vendor && vendor.id) || null, invoiceNumber: x.invoice_number,
        totalCents: x.total_cents + feeAppliedCents, invoiceDate: x.invoice_date, fileSha256: sha,
        accountNumber: x.account_number || null, servicePeriodStart: x.service_period_start || null, servicePeriodEnd: x.service_period_end || null,
      });
    }
    // An exception for the same file + community, pending already or created by an
    // earlier email in THIS run, is reused (recordException de-dup).
    const runKey = community ? `${sha}|${community.id}` : null;
    const pendingSame = (sameExc || []).find((e) => e.status === 'pending' && (!community || e.community_id === community.id));
    const exceptionReuse = pendingSame ? `existing exception ${pendingSame.id}` : (runKey && opts.runExceptions.has(runKey) ? `the exception email ${opts.runExceptions.get(runKey).slice(0, 8)} creates in this run` : null);
    // A payable an earlier email in this run would create for the SAME file +
    // community makes this one a same-file duplicate (findDuplicates rule 1).
    const runPayable = runKey && opts.runPayables.has(runKey) ? opts.runPayables.get(runKey) : null;
    const prediction = predictOutcome({ missing, dup, exceptionReuse, feeHeld: !!opts.feeHold && !missing.length, wouldCreateVendor: wouldCreate, runPayable });
    if (/exception/.test(prediction) && runKey && !opts.runExceptions.has(runKey)) opts.runExceptions.set(runKey, m.id);
    if (/payable/.test(prediction) && !/BLOCKED/.test(prediction) && runKey && !opts.runPayables.has(runKey)) opts.runPayables.set(runKey, m.id);
    files.push({ file: f.name, kind: f.kind, sha256: sha, read_error: err, vendor: x && x.vendor_name, invoice_number: x && x.invoice_number, invoice_date: x && x.invoice_date, due_date: x && x.due_date, total_cents: x && x.total_cents, account_number: x && x.account_number, service_period: x ? [x.service_period_start, x.service_period_end] : null, known_vendor: vendor, would_create_vendor: wouldCreate ? { name: wouldCreate.name, email: wouldCreate.email, w9_on_file: false, auto_pay_ach: false, notes: wouldCreate.notes } : null, community, vendor_autopay: vrow ? !!vrow.auto_pay_ach : null, vendor_fee_cents: vrow ? vrow.convenience_fee_cents || 0 : null, vendor_w9_on_file: vrow ? !!vrow.w9_on_file : null, on_file_same_file: sameFile, on_file_same_invoice: sameInvoice, exceptions_same_file: sameExc, fee_applied_cents: feeAppliedCents, duplicate_check: dup ? { verdict: dup.verdict, matches: dup.matches.map((mm) => ({ confidence: mm.confidence, reason: mm.reason, invoice_id: mm.invoice.id, invoice_number: mm.invoice.vendor_invoice_number })) } : null, prediction });
  }
  return { files_seen: prepared.seen, unreadable: prepared.skipped, files };
}

(async () => {
  const log = { at: new Date().toISOString(), mode: args.apply ? 'apply' : 'dry-run', ids: args.ids, fee_hold: [...args.feeHold], emails: [] };
  const { data: rows, error } = await supabase.from('email_messages').select(SELECT).in('id', args.ids);
  if (error) throw new Error(`load emails: ${error.message}`);
  const byId = new Map((rows || []).map((r) => [r.id, r]));
  const cids = [...new Set((rows || []).map((r) => r.community_id).filter(Boolean))];
  const comms = new Map();
  if (cids.length) { const { data: cs, error: ce } = await supabase.from('communities').select('id, name, financials_active, books_of_record').in('id', cids); if (ce) throw new Error(`load communities: ${ce.message}`); (cs || []).forEach((c) => comms.set(c.id, c)); }
  let refused = 0;
  const runExceptions = new Map(); // `${sha}|${community}` -> email id that would create the exception
  const runPayables = new Map();   // `${sha}|${community}` -> email id that would create the payable
  const runVendors = new Map();    // normalized vendor name -> email id that would create the vendor
  for (const id of args.ids) {
    const m = byId.get(id) || null;
    const entry = { id, subject: m && m.subject, received_at: m && m.received_at };
    const before = m ? await snapshot(supabase, m) : {};
    const pre = preconditions(m, before, m && m.community_id ? comms.get(m.community_id) || null : null);
    Object.assign(entry, { preconditions: pre, before });
    console.log(`\n── ${id}  ${m ? `"${String(m.subject || '').slice(0, 60)}"  ${String(m.received_at || '').slice(0, 10)}` : ''}`);
    console.log(`   before: payables ${before.payables ? before.payables.length : '-'} · exceptions ${before.exceptions ? before.exceptions.length : '-'} · triage ${before.triage_status || '-'} · outcome ${before.ap_intake_outcome || '-'}`);
    if (!pre.ok) { refused += 1; console.log(`   REFUSED: ${pre.problems.join('; ')}`); log.emails.push(entry); continue; }
    if (pre.skip) { console.log(`   SKIP (already done, no-op): ${pre.skip}`); log.emails.push(entry); continue; }
    if (!args.apply) {
      entry.dry_run = await dryRun(m, { feeHold: args.feeHold.has(id), runExceptions, runPayables, runVendors });
      for (const f of entry.dry_run.files) {
        console.log(`   file ${f.file} [${f.kind}] ${money(f.total_cents)} inv ${f.invoice_number || '-'} dated ${f.invoice_date || '(none printed)'} due ${f.due_date || '-'} acct ${f.account_number || '-'}`);
        console.log(`        vendor: ${f.would_create_vendor ? `WOULD CREATE NEW VENDOR "${f.would_create_vendor.name}" (w9_on_file=false, no autopay, flagged NEW)` : f.known_vendor ? `${f.known_vendor.name} (${f.known_vendor.id ? 'on file' : 'not on file'}, via ${f.known_vendor.via})` : `${f.vendor || '?'} (could not be resolved)`}${f.vendor_autopay ? ' · AUTOPAY' : ''}${f.vendor_fee_cents ? ` · fee ${money(f.vendor_fee_cents)}${args.feeHold.has(id) ? ' (HELD)' : ' (would be added)'}` : ''}${f.vendor_w9_on_file === false ? ' · no W-9 on file' : ''}`);
        console.log(`        community: ${f.community ? `${f.community.id.slice(0, 8)} (via ${f.community.via})` : 'not resolved'}`);
        console.log(`        duplicate check (same findDuplicates as intake): ${f.duplicate_check ? `${f.duplicate_check.verdict}${f.duplicate_check.matches.length ? ' · ' + f.duplicate_check.matches.map((x) => `${x.confidence}: ${x.reason}`).join(' | ') : ''}` : 'not reached (intake stops before it: ' + 'missing vendor/community/total/date)'}`);
        console.log(`        on file: same file ${f.on_file_same_file.length} · same invoice # ${f.on_file_same_invoice.length} · exception with same file ${f.exceptions_same_file.length}`);
        console.log(`        would be: ${f.prediction}${f.read_error ? ` · read error: ${f.read_error}` : ''}`);
      }
      for (const s of entry.dry_run.unreadable) console.log(`   unreadable: ${s.name}: ${s.reason}`);
      log.emails.push(entry); continue;
    }
    const { intakeBillEmail } = require('../lib/ap/email_bill_intake');
    const out = await intakeBillEmail(m, { convenienceFeeHold: args.feeHold.has(id) });
    const after = await snapshot(supabase, m);
    const diff = diffSnapshots(before, after);
    const vids = [...new Set(diff.payables_created.map((p) => p.vendor_id).filter(Boolean))];
    const autopayVendorIds = new Set();
    if (vids.length) { const { data, error: ve } = await supabase.from('vendors').select('id, auto_pay_ach').in('id', vids); if (ve) throw ve; (data || []).filter((v) => v.auto_pay_ach).forEach((v) => autopayVendorIds.add(v.id)); }
    const violations = invariantViolations(diff, { autopayVendorIds });
    Object.assign(entry, { after, diff, violations, outcome: out.decision ? out.decision.outcome : null, skipped: out.skipped || null, record_error: out.recordError || null });
    console.log(`   after:  payables ${after.payables.length} · exceptions ${after.exceptions.length} · triage ${after.triage_status} · outcome ${after.ap_intake_outcome}`);
    for (const p of diff.payables_created) console.log(`   + payable ${p.id} inv ${p.vendor_invoice_number || '-'} ${money(p.total_cents)} ${p.status}${p.is_ach_autopay ? ' · autopay' : ''}${p.needs_review ? ' · needs review' : ''}`);
    for (const e of diff.exceptions_created) console.log(`   + exception ${e.id} ${e.reason}: ${String(e.notes || '').slice(0, 110)}`);
    for (const e of diff.exceptions_reused) console.log(`   = exception ${e.id} (already existed; reused)`);
    for (const v of violations) console.log(`   !! INVARIANT: ${v}`);
    if (out.recordError) console.log(`   !! outcome not recorded on the email: ${out.recordError}`);
    log.emails.push(entry);
  }
  const file = args.out || path.join(os.tmpdir(), `ap_replay_${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(log, null, 2));
  console.log(`\n${args.apply ? 'APPLIED' : 'DRY RUN (nothing written)'} · ${args.ids.length} email(s) · refused ${refused} · log ${file}`);
  const bad = log.emails.some((e) => (e.violations || []).length || e.record_error);
  process.exit(refused || bad ? 1 : 0);
})().catch((e) => { console.error('ap_replay_emails failed:', e.message); process.exit(1); });
