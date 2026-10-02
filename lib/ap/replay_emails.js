// ============================================================================
// lib/ap/replay_emails.js  (Issue #14 recovery): the checks behind
// scripts/ap_replay_emails.js, kept pure so they are tested.
// ----------------------------------------------------------------------------
// The replay re-runs named Emma emails through the deployed intake path
// (lib/ap/email_bill_intake.js). These functions decide whether an email may be
// replayed, and describe exactly what changed.
// ============================================================================
const { outsideTrustedBooks } = require('./books_scope');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 10;

// argv -> { ids, apply, feeHold:Set, out } or { error }
function parseArgs(argv) {
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ids = list(get('--ids'));
  if (!ids.length) return { error: '--ids is required: a comma-separated list of email_messages ids (nothing is replayed by default)' };
  if (ids.length > MAX_IDS) return { error: `at most ${MAX_IDS} ids per run (got ${ids.length})` };
  const bad = ids.filter((x) => !UUID.test(x));
  if (bad.length) return { error: `not an email id: ${bad.join(', ')}` };
  if (new Set(ids).size !== ids.length) return { error: 'duplicate id in --ids' };
  const feeHold = new Set(list(get('--fee-hold')));
  const stray = [...feeHold].filter((x) => !ids.includes(x));
  if (stray.length) return { error: `--fee-hold names an id that is not in --ids: ${stray.join(', ')}` };
  return { ids, apply: argv.includes('--apply'), feeHold, out: get('--out') };
}

// Pure: may this email be replayed? m: email_messages row (or null);
// before: snapshot (see snapshot()); community: the email's communities row
// (name, financials_active, books_of_record) when linked. -> { ok, skip, problems }
//   ok=false        -> refuse (a precondition failed)
//   skip='reason'   -> already done; a replay would be a no-op (idempotent)
function preconditions(m, before, community = null) {
  const problems = [];
  if (!m) return { ok: false, skip: null, problems: ['email not found'] };
  if (m.persona !== 'emma') problems.push(`not an Emma email (persona ${m.persona || 'none'})`);
  if (m.direction !== 'inbound') problems.push('not an inbound email');
  if (!m.has_attachments) problems.push('email has no attachments');
  if (!m.graph_id) problems.push('email has no mailbox id (no source ref possible)');
  const x = m.extracted || {};
  const outside = outsideTrustedBooks(community);
  if (outside) problems.push(outside);
  if (x.auto_gl) problems.push(`already auto-recorded to the GL as a payment (JE ${x.auto_gl.je_id}); that entry must be reversed first, under its own approval`);
  if (problems.length) return { ok: false, skip: null, problems };
  if ((before.payables || []).length) return { ok: true, skip: `a payable already exists for this email (${before.payables.map((p) => p.id).join(', ')})`, problems };
  const ai = x.ap_intake;
  if (ai && (ai.outcome === 'payable' || ai.outcome === 'duplicate')) return { ok: true, skip: `already recorded as ${ai.outcome}`, problems };
  return { ok: true, skip: null, problems };
}

// What changed between two snapshots of one email.
function diffSnapshots(before, after) {
  const ids = (rows) => new Set((rows || []).map((r) => r.id));
  const b = { p: ids(before.payables), e: ids(before.exceptions) };
  return {
    payables_created: (after.payables || []).filter((r) => !b.p.has(r.id)),
    exceptions_created: (after.exceptions || []).filter((r) => !b.e.has(r.id)),
    exceptions_reused: (after.exceptions || []).filter((r) => b.e.has(r.id)),
    triage: before.triage_status === after.triage_status ? null : { from: before.triage_status, to: after.triage_status },
    outcome: { from: before.ap_intake_outcome || null, to: after.ap_intake_outcome || null },
  };
}

// Invariants a replay must never break. -> [violation strings]
function invariantViolations(diff, { autopayVendorIds = new Set() } = {}) {
  const v = [];
  for (const p of diff.payables_created) {
    if (['approved', 'partially_paid', 'paid'].includes(p.status)) v.push(`payable ${p.id} was created as ${p.status}; replays must never approve or pay`);
    if (autopayVendorIds.has(p.vendor_id) && p.is_ach_autopay !== true) v.push(`payable ${p.id} is for an autopay vendor but is not flagged autopay (a check could pay it twice)`);
  }
  return v;
}

// Pure: the predicted intake result for one file, from the same inputs intake
// uses. missing: what commitInvoice would stop on (vendor/community/total/date);
// dup: findDuplicates() result; exceptionReuse: which existing/in-run exception
// a new one would reuse; feeHeld: the convenience fee is held.
function predictOutcome({ missing = [], dup = null, exceptionReuse = null, feeHeld = false, wouldCreateVendor = null, runPayable = null }) {
  // Intake resolves (and, if needed, CREATES) the vendor before anything else,
  // so a created vendor stays even when the bill then stops as an exception.
  const pre = wouldCreateVendor ? `CREATES NEW VENDOR "${wouldCreateVendor.name}" (w9_on_file=false, no autopay, flagged NEW), then ` : '';
  if (missing.length) return `${pre}Payables exception (${missing.join('; ')})${exceptionReuse ? ` · reuses ${exceptionReuse}, no new card` : ''}`;
  if (runPayable) return `${pre}BLOCKED as a duplicate of the payable email ${String(runPayable).slice(0, 8)} creates in this run (same file)`;
  if (dup && dup.verdict === 'certain') { const mm = dup.matches[0] || {}; return `${pre}BLOCKED as a duplicate of ${mm.invoice ? mm.invoice.id : 'an invoice on file'} (${mm.reason || 'certain match'})`; }
  const flags = [feeHeld && 'convenience fee held', wouldCreateVendor && 'new vendor'].filter(Boolean);
  const review = flags.length ? `, needs review (${flags.join('; ')})` : '';
  if (dup && dup.verdict === 'suspected') return `${pre}payable held as a suspected duplicate (${dup.matches.map((x) => x.reason).join('; ')})${review}`;
  return `${pre}payable, awaiting approval${review}`;
}

// Read-only snapshot of everything a replay can touch for one email.
async function snapshot(supabase, m) {
  const ref = `email:${m.graph_id}`;
  const must = async (q, what) => { const { data, error } = await q; if (error) throw new Error(`${what}: ${error.message}`); return data || []; };
  const payables = await must(supabase.from('ap_invoices').select('id, vendor_id, vendor_invoice_number, invoice_date, total_cents, status, is_ach_autopay, needs_review, file_sha256, notes').eq('intake_source_ref', ref), 'payables');
  const byRef = await must(supabase.from('ap_intake_exceptions').select('id, status, reason, notes, file_sha256, total_cents, vendor_name').eq('intake_source_ref', ref), 'exceptions by ref');
  const byEmail = await must(supabase.from('ap_intake_exceptions').select('id, status, reason, notes, file_sha256, total_cents, vendor_name').eq('email_message_id', m.id), 'exceptions by email');
  const seen = new Set(); const exceptions = [...byRef, ...byEmail].filter((e) => !seen.has(e.id) && seen.add(e.id));
  const [row] = await must(supabase.from('email_messages').select('triage_status, extracted').eq('id', m.id), 'email');
  return { payables, exceptions, triage_status: row && row.triage_status, ap_intake_outcome: row && row.extracted && row.extracted.ap_intake ? row.extracted.ap_intake.outcome : null };
}

module.exports = { parseArgs, preconditions, diffSnapshots, invariantViolations, snapshot, predictOutcome, MAX_IDS };
