// ============================================================================
// lib/onboarding/bridge.js  (Issue #15 Milestone 4) — Activity Bridge (read-only)
// ----------------------------------------------------------------------------
// Compares the authoritative cutoff position (validated source + snapshot) with
// the financial activity actually recorded in Trusted, WITHOUT changing either.
// Every candidate Trusted financial record is accounted for exactly once:
//
//   ALREADY_IN_SOURCE      represented in the legacy cutoff position; never post again
//   LEGITIMATE_SUBSEQUENT  real activity outside the source (after the cutoff, no
//                          source evidence); to be preserved by a later, separately
//                          approved step
//   AMBIGUOUS              insufficient evidence; a human decides
//   OUT_OF_SCOPE           no financial effect to carry (test / pending payments,
//                          void pairs that net to zero, records already superseded)
//
// Deterministic rules only, in order, each with explicit evidence and a method:
//   1. provenance  (legacy-derived imports / prior conversion, superseded entries)
//   2. no money moved  (test / pending payments; void + its reversal netting to zero)
//   3. durable identifiers against the SOURCE  (invoice number, check number,
//      homeowner account + reference), with the amount as a CONFIRMATION, never alone;
//      a Trusted system entry is in the source only when EVERY line (account, side,
//      cents) is a source "GL Entry" line of the same date and the same source
//      entry, each source line used once (line identity, not an amount match)
//   4. amount (+ counterparty) similarity WITHOUT an identifier  ->  AMBIGUOUS, never a duplicate
//      (a source line dated before the Trusted document was even issued is not a candidate)
//   5. date vs cutoff when there is no source evidence at all
// No LLM, no fuzzy text scoring. Operational ACC / violation / certification
// history is never loaded (only the financial records the loader returns).
//
// Structural checks run on every event that would be preserved: a balanced,
// posted journal entry with lines; GL <-> subsidiary identity (AR lines have an
// AR record of the same amount; AP invoice total = its entry). Problems are
// REPORTED, never repaired.
// ============================================================================
const crypto = require('crypto');
const C = require('./controls');
const { canonicalJson } = require('./preflight');

const CLASSES = Object.freeze(['ALREADY_IN_SOURCE', 'LEGITIMATE_SUBSEQUENT', 'AMBIGUOUS', 'OUT_OF_SCOPE']);
// Bumped whenever the deterministic rules change: a bridge recorded by another
// version is stale and the operator recomputes it (inputs unchanged or not).
const BRIDGE_VERSION = '2026-10-07.3';
const LEGACY_JE_MODULES = new Set(['vantaca_import', 'opening_entry', 'conversion']);
const LEGACY_SUB_SOURCES = new Set(['vantaca_migration', 'vantaca_import', 'conversion']);
const DAY = 86400000;
const days = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY;
const tokenIn = (text, token) => !!token && new RegExp(`(^|[^0-9A-Za-z])${String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^0-9A-Za-z]|$)`, 'i').test(String(text || ''));
const key = (table, id) => `${table}:${id}`;

// ---------------------------------------------------------------- events
// One event = a journal entry plus every subsidiary record linked to it. A
// subsidiary record with no journal entry is its own event; legacy-derived
// unlinked rows are grouped per (table, source batch / module).
function buildEvents(t) {
  const jeById = new Map(t.journal_entries.map((j) => [j.id, j]));
  const linesByJe = new Map();
  for (const l of t.journal_entry_lines || []) { if (!linesByJe.has(l.journal_entry_id)) linesByJe.set(l.journal_entry_id, []); linesByJe.get(l.journal_entry_id).push(l); }
  const events = new Map();
  const ensureJe = (id) => { if (!events.has(id)) { const je = jeById.get(id); events.set(id, { event_key: `je:${id}`, je, lines: linesByJe.get(id) || [], subs: [], records: je ? [key('journal_entries', id)] : [] }); } return events.get(id); };
  for (const j of t.journal_entries) ensureJe(j.id);
  const loose = new Map();
  const attach = (table, row, jeId, groupKey) => {
    const rec = { table, row };
    if (jeId && jeById.has(jeId)) { const e = ensureJe(jeId); e.subs.push(rec); e.records.push(key(table, row.id)); return; }
    const g = groupKey || key(table, row.id);
    if (!loose.has(g)) loose.set(g, { event_key: `loose:${g}`, je: null, lines: [], subs: [], records: [] });
    const e = loose.get(g); e.subs.push(rec); e.records.push(key(table, row.id));
  };
  for (const r of t.ap_invoices || []) attach('ap_invoices', r, r.posting_journal_entry_id);
  for (const r of t.ap_payments || []) attach('ap_payments', r, r.posting_journal_entry_id);
  for (const r of t.ar_charges || []) attach('ar_charges', r, r.posting_journal_entry_id, !r.posting_journal_entry_id && LEGACY_SUB_SOURCES.has(r.source_module) ? `ar_charges:${r.source_module}` : null);
  for (const r of t.ar_payments || []) attach('ar_payments', r, r.posting_journal_entry_id, !r.posting_journal_entry_id && LEGACY_SUB_SOURCES.has(r.source) ? `ar_payments:${r.source}` : null);
  for (const r of t.payments || []) attach('payments', r, r.journal_entry_id);
  for (const r of t.homeowner_transactions || []) attach('homeowner_transactions', r, null, r.source_batch_id ? `homeowner_transactions:batch:${r.source_batch_id}` : null);
  return [...events.values(), ...loose.values()];
}

const eventDate = (e) => (e.je ? e.je.posting_date : (e.subs.map((s) => s.row.invoice_date || s.row.payment_date || s.row.charge_date || s.row.transaction_date || (s.row.paid_at || s.row.created_at || '').slice(0, 10)).filter(Boolean).sort()[0] || null));
const eventAmount = (e) => (e.je ? Number(e.je.total_debits_cents || 0) : e.subs.reduce((t, s) => t + Math.abs(Number(s.row.total_cents ?? s.row.amount_cents ?? s.row.original_amount_cents ?? 0)), 0));

// ---------------------------------------------------------------- source evidence
// Durable identifiers in the source: invoice / check numbers sit in GL descriptions
// and ledger ids; homeowner references sit in the homeowner ledger.
function sourceIndex(parsed) {
  const gl = ((parsed.gl_trial_balance && parsed.gl_trial_balance.rows) || []).filter((r) => r.domain === 'gl_transaction');
  const hoTx = ((parsed.homeowner_transactions && parsed.homeowner_transactions.rows) || []).filter((r) => r.domain === 'homeowner_txn');
  const apOpen = ((parsed.ap_aging && parsed.ap_aging.rows) || []).filter((r) => r.domain === 'ap_open_item');
  return { gl, hoTx, apOpen, hasApAging: !!parsed.ap_aging };
}
const glAmount = (r) => r.debit_cents || r.credit_cents;
const srcRef = (r) => ({ artifact_sha256: r.provenance.artifact_sha256, locator: r.provenance.locator, date: r.date, amount_cents: glAmount(r) ?? (r.charge_cents || r.payment_cents), account_code: r.account_code, source_type: r.source_type, ledger_id: r.ledger_id });

function apInvoiceNumber(e) {
  const inv = e.subs.find((s) => s.table === 'ap_invoices');
  if (inv && inv.row.vendor_invoice_number) return String(inv.row.vendor_invoice_number).trim();
  const m = /AP invoice\s+([0-9A-Za-z][0-9A-Za-z-]{2,})/.exec((e.je && e.je.description) || '');
  return m ? m[1] : null;
}
function checkNumber(e) {
  const p = e.subs.find((s) => s.table === 'ap_payments');
  if (p && p.row.check_number) return String(p.row.check_number).trim();
  const m = /check\s*#\s*([0-9]{2,})/i.exec((e.je && e.je.description) || '');
  return m ? m[1] : null;
}
// Deterministic disqualifiers for an amount-only candidate (never used to PROVE a match).
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function contradicts(r, { ident, date, docDate }) {
  if (docDate && r.date < docDate) return true;                              // the source line predates the document's issue date
  const d = String(r.description || '');
  const lead = /^\s*([0-9A-Za-z][0-9A-Za-z-]{2,})\s+-\s/.exec(d);           // "<document #> - Vendor - memo"
  if (lead && ident && lead[1].toLowerCase() !== String(ident).toLowerCase()) return true;
  if (lead && !ident) return false;
  const m = new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{4})\\b`, 'i').exec(d);  // "June 2026 Landscaping"
  if (m && date) { const [y, mo] = date.split('-').map(Number); if (Number(m[2]) !== y || MONTHS.indexOf(m[1].toLowerCase()) !== mo - 1) return true; }
  return false;
}
const kindOf = (e) => {
  if (e.je) return e.je.source_module || 'journal_entry';
  return e.subs[0] ? e.subs[0].table : 'unknown';
};

// Line identity for a Trusted system entry: every line must be a distinct, unused source
// "GL Entry" row of the same date, the same account number, the same side and cents, and
// all from ONE source entry (same source description). Amount alone never qualifies.
function matchLinesInSource(e, ctx, date) {
  if (!e.lines.length || !ctx.accountNumber) return null;
  const want = e.lines.map((l) => ({ acct: ctx.accountNumber(l.account_id), dr: Number(l.debit_cents || 0), cr: Number(l.credit_cents || 0) }));
  if (want.some((w) => !w.acct || (w.dr > 0) === (w.cr > 0))) return null;
  const pool = ctx.src.gl.filter((r) => r.date === date && /GL Entry/i.test(r.source_type || '') && !ctx.usedSource.has(r));
  const groups = new Map(); for (const r of pool) { const k = String(r.description || ''); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  for (const [description, rows] of groups) {
    const taken = new Set(); let ok = true;
    for (const w of want) {
      const hit = rows.find((r) => !taken.has(r) && r.account_code === w.acct && Number(r.debit_cents || 0) === w.dr && Number(r.credit_cents || 0) === w.cr);
      if (!hit) { ok = false; break; }
      taken.add(hit);
    }
    if (ok) { for (const r of taken) ctx.usedSource.add(r); return { description, rows: [...taken] }; }
  }
  return null;
}
// The plain question for an in-period document the source does not hold.
const usd = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const mdy = (iso) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}/${iso.slice(0, 4)}` : '');
// ACCRUED IN THE SOURCE (Ed 2026-10-07, Canyon Gate Earthcare 117311 / D&F 278002): the source
// never entered the vendor bill, but a source "GL Entry" accrued it: the SAME expense accounts and
// cents debited, the same total credited to ONE non-AP liability (e.g. 2300 Accrued Liability).
// Line identity (account + cents), never amount alone; each source line used once.
function sourceAccrualFor(e, ctx, date) {
  if (!e.je || !e.lines.length || !ctx.accountNumber) return null;
  const ap = ctx.roles && ctx.roles.ap_account;
  const byAcct = new Map(); let apCredit = 0;
  for (const l of e.lines) { const a = ctx.accountNumber(l.account_id); if (!a) return null; if (ap && a === ap) { apCredit += Number(l.credit_cents || 0) - Number(l.debit_cents || 0); continue; } byAcct.set(a, (byAcct.get(a) || 0) + Number(l.debit_cents || 0) - Number(l.credit_cents || 0)); }
  const want = new Map([...byAcct].filter(([, v]) => v !== 0));
  if (!(apCredit > 0) || ![...want.values()].every((v) => v > 0) || [...want.values()].reduce((t, v) => t + v, 0) !== apCredit) return null;
  const pool = ctx.src.gl.filter((r) => /GL Entry/i.test(r.source_type || '') && !ctx.usedSource.has(r) && r.date <= ctx.cutoff && days(r.date, date) <= 45);
  const groups = new Map(); for (const r of pool) { const k = `${r.date}|${r.description || ''}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  for (const [, rows] of groups) {
    const credit = rows.find((r) => Number(r.credit_cents || 0) === apCredit && !Number(r.debit_cents || 0) && r.account_code !== ap && !want.has(r.account_code));
    if (!credit) continue;
    const taken = [credit]; let ok = true;
    for (const [a, v] of want) { const hit = rows.find((r) => !taken.includes(r) && r.account_code === a && Number(r.debit_cents || 0) === v); if (!hit) { ok = false; break; } taken.push(hit); }
    if (!ok) continue;
    for (const r of taken) ctx.usedSource.add(r);
    return { account: credit.account_code, amount_cents: apCredit, date: credit.date, description: credit.description || null, source_lines: taken.map(srcRef) };
  }
  return null;
}
function periodDecision({ ident, amount, date, cutoff, vendor, paidStatus, elsewhere, accrual = null }) {
  const what = `${vendor ? vendor + ' ' : ''}invoice ${ident}`;
  const context = [`Not in the legacy books at ${mdy(cutoff)}: the number is not a vendor invoice in the GL, and it is not open in the AP Aging.`];
  if (elsewhere && elsewhere.length) context.push(`The number does appear in the legacy books on ${[...new Set(elsewhere.map((r) => mdy(r.date)))].join(', ')} as ${[...new Set(elsewhere.map((r) => r.source_type || 'another entry'))].join(' / ')} (for example a homeowner bill-back), but the vendor bill itself was never entered.`);
  if (paidStatus) context.push(paidStatus === 'paid' ? 'Trusted shows it paid.' : `Trusted shows it not yet paid (${paidStatus}).`);
  if (accrual) context.push(`The legacy books ACCRUED it: a GL entry on ${mdy(accrual.date)} ("${accrual.description || ''}") debits the same expense accounts for the same cents and credits ${accrual.account} ${usd(accrual.amount_cents)}. The expense is already there; the liability sits in ${accrual.account}, not AP.`);
  return {
    type: 'recording_period',
    question: accrual ? `${what} (${usd(amount)}, dated ${mdy(date)}) was accrued in the legacy books to ${accrual.account}, not entered as a bill. Treat it as already accrued (reverse the Trusted entry; move the accrual to AP on the cutover date)?`
      : `${what} (${usd(amount)}, dated ${mdy(date)}) is real but is not in the legacy books. Record it after the cutoff, or on ${mdy(date)}?`,
    context,
    choices: [
      ...(accrual ? [{ key: 'accrued_in_legacy_books', label: `Already accrued in the legacy books (${accrual.account}): reverse the Trusted entry on its date; on the cutover date move ${usd(accrual.amount_cents)} from ${accrual.account} to AP so the payment clears AP` }] : []),
      { key: 'record_after_cutoff', label: `After the cutoff (first day after ${mdy(cutoff)}); the cutoff balances stay exactly as the legacy books show them` },
      { key: 'record_on_document_date', label: `On ${mdy(date)}; the period before the cutoff will differ from the legacy books by ${usd(amount)}` },
    ],
    recommended: accrual ? 'accrued_in_legacy_books' : 'record_after_cutoff',
    ...(accrual ? { accrual } : {}),
  };
}

// Every other open item: the generic factual choice (already in the legacy books, or keep).
function genericDecision(it) {
  return {
    type: 'source_or_keep',
    question: `${String(it.kind).replace(/_/g, ' ')} of ${usd(it.amount_cents)} dated ${it.event_date ? mdy(it.event_date) : '(no date)'}: is it already in the legacy books, or is it real activity Trusted must keep?`,
    context: [it.evidence && it.evidence.note ? it.evidence.note : String(it.method).replace(/_/g, ' ')],
    choices: [{ key: 'already_in_legacy_books', label: 'Already in the legacy books (do not carry it forward)' }, { key: 'keep_as_trusted_activity', label: 'Real activity Trusted must keep' }],
    recommended: null,
  };
}
// A recorded owner decision still applies to this item only if it answered the same
// question about the same transaction (same event, question type, amount and date).
function recordedDecisionFor(it, decisions) {
  const d = it.evidence && it.evidence.decision;
  if (!d) return null;
  const hits = (decisions || []).filter((x) => x.event_key === it.event_key && x.decision_type === d.type && Number(x.item_amount_cents) === Number(it.amount_cents)
    && String(x.item_event_date || '').slice(0, 10) === String(it.event_date || '').slice(0, 10) && d.choices.some((c) => c.key === x.choice_key));
  if (!hits.length) return null;
  const x = hits.slice().sort((a, b) => String(a.decided_at).localeCompare(String(b.decided_at))).pop();
  return { decision_id: x.id, choice_key: x.choice_key, choice_label: x.choice_label, decided_by: x.actor_id, decided_at: x.decided_at, on_bridge_result: x.bridge_completion_id, reason: x.reason || null };
}
// Source anomalies worth an accountant's look after conversion (never a blocker,
// never a change to the cutoff position): the same source GL Entry recorded more
// than once on one date (every line repeated the same number of times).
function sourceAnomalies(src) {
  const groups = new Map();
  for (const r of src.gl.filter((x) => /GL Entry/i.test(x.source_type || ''))) { const k = `${r.date}|${r.description || ''}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const notes = [];
  for (const [k, rows] of groups) {
    const counts = new Map(); for (const r of rows) { const lk = `${r.account_code}|${r.debit_cents || 0}|${r.credit_cents || 0}`; counts.set(lk, (counts.get(lk) || 0) + 1); }
    const n = Math.min(...counts.values());
    if (n < 2 || [...counts.values()].some((c) => c % n !== 0) || counts.size < 2) continue;
    const [date, description] = [k.slice(0, 10), k.slice(11)];
    const amount = rows.reduce((t, r) => t + Number(r.debit_cents || 0), 0) / n;
    notes.push({ kind: 'duplicate_source_gl_entry', date, description, times: n, amount_cents: amount, source_lines: rows.map(srcRef),
      text: `The legacy GL records the same entry ${n} times on ${mdy(date)} ("${description}", ${usd(amount)} each time). The cutoff position is kept exactly as the legacy books show it; review this after conversion.` });
  }
  return notes;
}

// Does a closing entry close ONLY legacy-imported history? For each account it touches: the
// balance up to the close date (posted, not superseded entries; the close excluded), split
// legacy-derived vs Trusted-native. OK when native is zero, or the close moves exactly the
// legacy balance (the native part is left open). At least one legacy entry must exist.
function closingEntryOfLegacy(e, ctx, date) {
  const closeNet = new Map(); for (const l of e.lines) { const a = ctx.accountNumber(l.account_id) || `?${l.account_id}`; closeNet.set(a, (closeNet.get(a) || 0) + Number(l.debit_cents || 0) - Number(l.credit_cents || 0)); }
  const legacy = new Map(); const native = new Map(); const legacyJes = new Set(); const nativeJes = new Map();
  for (const j of ctx.byId.values()) {
    if (j.id === e.je.id || j.status !== 'posted' || j.superseded_at || !j.posting_date || String(j.posting_date).slice(0, 10) > date) continue;
    const isLegacy = LEGACY_JE_MODULES.has(j.source_module);
    for (const l of ctx.linesByJe.get(j.id) || []) {
      const a = ctx.accountNumber(l.account_id) || `?${l.account_id}`; if (!closeNet.has(a)) continue;
      const n = Number(l.debit_cents || 0) - Number(l.credit_cents || 0);
      if (isLegacy) { legacy.set(a, (legacy.get(a) || 0) + n); legacyJes.add(j.id); } else { native.set(a, (native.get(a) || 0) + n); if (n) nativeJes.set(a, [...(nativeJes.get(a) || []), j.reference || j.id]); }
    }
  }
  const accounts = []; let ok = legacyJes.size > 0;
  for (const [a, c] of [...closeNet].sort(([x], [y]) => x.localeCompare(y))) {
    const nat = native.get(a) || 0; const leg = legacy.get(a) || 0;
    const fine = nat === 0 || c === -leg;
    if (!fine) ok = false;
    accounts.push({ account: a, close_cents: c, legacy_cents: leg, native_cents: nat, ...(fine ? {} : { problem: 'the close moves Trusted-native activity' }) });
  }
  const nativeLeftOpen = accounts.filter((x) => x.native_cents !== 0).map((x) => ({ account: x.account, native_cents: x.native_cents, entries: (nativeJes.get(x.account) || []).slice(0, 5) }));
  return { ok, accounts: accounts.length, legacyEntries: legacyJes.size, nativeLeftOpen, detail: accounts };
}

// ---------------------------------------------------------------- classification
function classifyEvent(e, ctx) {
  const { cutoff, src, byId } = ctx;
  const date = eventDate(e); const amount = eventAmount(e); const kind = kindOf(e);
  const base = { event_key: e.event_key, kind, event_date: date, amount_cents: amount, records: e.records.slice().sort() };
  const out = (classification, method, evidence, confidence = 'high') => ({ ...base, classification, method, confidence, evidence });
  const je = e.je;

  // 1. provenance
  if (je && je.superseded_at) return out('OUT_OF_SCOPE', 'superseded_by_prior_conversion', { superseded_at: je.superseded_at, reason: je.superseded_reason || null });
  const legacySub = e.subs.length && e.subs.every((s) => LEGACY_SUB_SOURCES.has(s.row.source_module || s.row.source) || (s.table === 'homeowner_transactions' && s.row.source_batch_id));
  if ((je && LEGACY_JE_MODULES.has(je.source_module)) || (!je && legacySub)) {
    if (date && date > cutoff) return out('AMBIGUOUS', 'legacy_derived_dated_after_cutoff', { source_module: je ? je.source_module : e.subs[0].row.source_module || e.subs[0].row.source || 'import batch', date });
    return out('ALREADY_IN_SOURCE', 'provenance_legacy_import', { source_module: je ? je.source_module : (e.subs[0].row.source_module || e.subs[0].row.source || `import batch ${e.subs[0].row.source_batch_id}`), records: e.records.length, note: 'a record derived from the legacy system for a period the cutoff position covers' });
  }
  // A year-end CLOSING entry inside the source period that closes only legacy-imported
  // history (Ed 2026-10-07, Canyon Gate JE-2025-CLOSE). It is not operational activity: it
  // is derived from the imported books it closes, and the source trial balance at the cutoff
  // already carries that close in its fund balances. Proven line by line: on every account it
  // touches, either Trusted has no native (non-legacy) activity up to the close date, or the
  // close moves exactly the legacy-imported balance (it never closes Trusted-native activity).
  if (je && je.source_module === 'closing_entry' && date && date <= cutoff && je.status === 'posted') {
    const proof = closingEntryOfLegacy(e, ctx, date);
    if (proof.ok) return out('ALREADY_IN_SOURCE', 'provenance_legacy_import_closing_entry', { closes_through: date, accounts: proof.accounts, legacy_entries: proof.legacyEntries, native_entries_left_open: proof.nativeLeftOpen,
      note: 'a year-end close of legacy-imported history; the source position at the cutoff already includes it; retired with the legacy imports' });
  }
  // A generic Trusted 'system' entry inside the source period is NOT proof of anything:
  // date + generic module never makes it ALREADY_IN_SOURCE (it could be a Trusted-only
  // event). It goes through the identifier rules below and, without stronger evidence,
  // ends AMBIGUOUS for a human (Ed, Issue #15 review of M4).
  const genericSystemInPeriod = !!(je && je.source_module === 'system' && date && date <= cutoff);
  if (genericSystemInPeriod && !je.reverses_je_id && je.status !== 'voided') {
    const m = matchLinesInSource(e, ctx, date);
    if (m) return out('ALREADY_IN_SOURCE', 'gl_entry_lines_identical_in_source', { reference: je.reference || null, description: je.description || null, lines: e.lines.length, source_entry_description: m.description, source_matches: m.rows.map(srcRef), note: 'every line (account, side, cents) is a line of one source GL Entry of the same date; each source line is used once' });
  }

  // 2. no money moved
  // A document voided without ever posting (no journal entry): nothing to carry.
  if (!je && e.subs.length && e.subs.every((s) => s.table === 'ap_invoices' && (s.row.voided_at || s.row.status === 'voided') && !s.row.posting_journal_entry_id)) {
    return out('OUT_OF_SCOPE', 'voided_document_never_posted', { documents: e.subs.map((s) => ({ invoice: s.row.vendor_invoice_number || null, status: s.row.status || null, voided_at: s.row.voided_at || null })) });
  }
  const pays = e.subs.filter((s) => s.table === 'payments');
  if (pays.length && !je && pays.every((s) => s.row.livemode !== true || !['succeeded', 'paid', 'settled', 'posted'].includes(String(s.row.status)))) return out('OUT_OF_SCOPE', 'payment_not_live_or_not_settled', { statuses: [...new Set(pays.map((s) => `${s.row.status}/${s.row.livemode === true ? 'live' : 'test'}`))] });
  if (je && (je.status === 'voided' || je.reverses_je_id)) {
    const partnerId = je.status === 'voided' ? je.void_reversal_je_id : je.reverses_je_id;
    const partner = partnerId ? byId.get(partnerId) : null;
    if (partner && Number(partner.total_debits_cents) === Number(je.total_debits_cents)) return out('OUT_OF_SCOPE', 'void_pair_nets_to_zero', { partner_journal_entry: partnerId, partner_reference: partner.reference || null, amount_cents: amount });
    return { ...out('AMBIGUOUS', 'void_without_matching_reversal', { partner_journal_entry: partnerId || null }), structural_issues: ['voided or reversing entry without a matching partner of the same amount'] };
  }

  // 2b. invoices an owner-approved opening correction restored to AP at the cutoff (the
  //     source booked them, then booked a payment that never left the bank). Matched by
  //     invoice NUMBER + amount to exactly one Trusted invoice. Its pre-cutoff entry is
  //     already in the source position (the expense is the source's; the open AP is the
  //     correction's); the post-cutoff payments that pay ONLY such invoices are real.
  const restoredInv = e.subs.filter((s) => s.table === 'ap_invoices' && ctx.restored.byInvoiceId.has(s.row.id));
  if (restoredInv.length && date && date <= cutoff) {
    const its = restoredInv.map((s) => ctx.restored.byInvoiceId.get(s.row.id));
    return out('ALREADY_IN_SOURCE', 'invoice_number_restored_by_opening_correction', { identifier: its.map((x) => x.invoice_number).join(', '), snapshot_lines: its.map((x) => x.line_no),
      note: 'the source holds the expense; the approved opening correction carries this invoice as open AP at the cutoff, so this entry is neutralized and the Trusted invoice is carried (never a second invoice)' });
  }
  const payRows = e.subs.filter((s) => s.table === 'ap_payments');
  if (payRows.length && date && date > cutoff) {
    const apps = payRows.flatMap((s) => ctx.restored.appsOfPayment(s.row.id));
    const paid = payRows.reduce((t, s) => t + Number(s.row.amount_cents || 0), 0);
    if (apps.length && apps.every((a) => ctx.restored.byInvoiceId.has(a.invoice_id)) && apps.reduce((t, a) => t + Number(a.applied_cents || 0), 0) === paid) {
      return out('LEGITIMATE_SUBSEQUENT', 'pays_invoices_restored_by_opening_correction', { identifier: checkNumber(e), invoices: apps.map((a) => ctx.restored.byInvoiceId.get(a.invoice_id).invoice_number), applied_cents: paid,
        note: 'the actual payment of invoices the opening correction carries as open AP at the cutoff; the source payment of the same invoices was book-only' });
    }
  }

  // 3. durable identifiers against the source
  const inv = kind === 'ap_invoice' || e.subs.some((s) => s.table === 'ap_invoices') ? apInvoiceNumber(e) : null;
  const chk = kind === 'payment_intake' || e.subs.some((s) => s.table === 'ap_payments') ? checkNumber(e) : null;
  const ident = inv || chk;
  if (ident) {
    const hits = src.gl.filter((r) => (tokenIn(r.description, ident) || r.ledger_id === ident) && (!inv || /invoice/i.test(r.source_type || '')));
    const same = hits.filter((r) => glAmount(r) === amount);
    if (same.length) return out('ALREADY_IN_SOURCE', inv ? 'invoice_number_and_amount_in_source' : 'check_number_and_amount_in_source', { identifier: ident, source_matches: same.slice(0, 5).map(srcRef) });
    if (hits.length) return out('AMBIGUOUS', 'identifier_in_source_amount_differs', { identifier: ident, trusted_amount_cents: amount, source_matches: hits.slice(0, 5).map(srcRef) });
  }
  const ar = e.subs.filter((s) => s.table === 'ar_charges' || s.table === 'ar_payments');
  if (ar.length && ctx.accountOfProperty) {
    const acct = ctx.accountOfProperty(ar[0].row.property_id);
    const ref = ar[0].row.source_reference;
    const sameAcct = acct ? src.hoTx.filter((r) => r.source_account_key === acct && Math.abs(r.charge_cents || r.payment_cents) === amount) : [];
    const withRef = sameAcct.filter((r) => ref && tokenIn(r.description, ref) && r.date === ar[0].row.charge_date);
    if (withRef.length) return out('ALREADY_IN_SOURCE', 'homeowner_account_reference_and_amount_in_source', { account: acct, reference: ref, source_matches: withRef.slice(0, 5).map(srcRef) });
    if (sameAcct.filter((r) => days(r.date, date) <= 45).length) return out('AMBIGUOUS', 'amount_and_account_without_identifier', { account: acct, trusted_amount_cents: amount, source_candidates: sameAcct.slice(0, 5).map(srcRef) }, 'low');
  }

  // 4. amount similarity without an identifier -> AMBIGUOUS, never a duplicate.
  //    A source line that carries a DIFFERENT invoice number, or a different service
  //    month, is positive evidence it is another document and is not a candidate.
  const docDate = (() => {
    const invRow = e.subs.find((s) => s.table === 'ap_invoices');
    if (invRow && invRow.row.invoice_date) return invRow.row.invoice_date;
    const pay = e.subs.find((s) => s.table === 'ap_payments');
    const paid = pay && ctx.invoiceDatesOfPayment ? ctx.invoiceDatesOfPayment(pay.row.id) : [];
    return paid.length ? paid.slice().sort()[0] : null;
  })();
  if (amount > 0) {
    const nearAll = src.gl.filter((r) => glAmount(r) === amount && days(r.date, date) <= 45 && (!inv || /invoice/i.test(r.source_type || '')));
    const near = nearAll.filter((r) => !contradicts(r, { ident, date, docDate }));
    const rejected = nearAll.filter((r) => docDate && r.date < docDate).map((r) => ({ ...srcRef(r), rejected_because: `source line dated ${r.date} predates the document issued ${docDate}` }));
    if (rejected.length) e.rejectedCandidates = rejected;
    if (near.length && (inv || chk || kind === 'ap_invoice' || kind === 'payment_intake')) return out('AMBIGUOUS', 'amount_match_without_identifier', { identifier: ident || null, trusted_amount_cents: amount, source_candidates: near.slice(0, 5).map(srcRef), note: 'same amount near the date but no shared identifier; never treated as a duplicate on amount alone' }, 'low');
  }

  // 5. no source evidence at all: the date decides
  if (date && date > cutoff) return out('LEGITIMATE_SUBSEQUENT', 'after_cutoff_no_source_evidence', { identifier: ident || null, cutoff, ...(e.rejectedCandidates ? { rejected_source_candidates: e.rejectedCandidates.slice(0, 5) } : {}) });
  if (genericSystemInPeriod) return out('AMBIGUOUS', 'system_entry_in_source_period_unproven', { source_module: 'system', reference: je.reference || null, description: je.description || null, date, cutoff, note: 'a generic Trusted system entry dated inside the source period; date and module alone do not prove the source already holds it' }, 'low');
  if (ident && inv && src.hasApAging) {
    // The document number is nowhere in the source as a vendor invoice and the source AP
    // aging at the cutoff does not carry it: positive evidence the legacy books do not
    // hold it. Whether to keep it is not the question (it is real); WHEN to record it is.
    const elsewhere = src.gl.filter((r) => tokenIn(r.description, ident) && !/invoice/i.test(r.source_type || '')).map((r) => ({ ...srcRef(r), note: 'the number appears, but not as a vendor invoice' }));
    const openAtCutoff = (src.apOpen || []).some((r) => String(r.invoice_number || '').toLowerCase() === String(ident).toLowerCase());
    if (!openAtCutoff) return out('AMBIGUOUS', 'in_source_period_absent_from_source', { identifier: ident, date, cutoff, searched: { gl_lines: src.gl.length, ap_aging_open_items: (src.apOpen || []).length }, open_in_source_ap_aging: false, identifier_elsewhere_in_source: elsewhere.slice(0, 5), decision: periodDecision({ ident, amount, date, cutoff, vendor: ((je && /\s[—-]\s(.+)$/.exec(je.description || '')) || [])[1] || null, paidStatus: (e.subs.find((s) => s.table === 'ap_invoices') || { row: {} }).row.status || null, elsewhere, accrual: sourceAccrualFor(e, ctx, date) }), note: 'not a duplicate: the legacy books do not hold this document; only the recording period needs a decision' }, 'high');
  }
  return out('AMBIGUOUS', 'in_source_period_not_found_in_source', { identifier: ident || null, date, cutoff, note: 'dated inside the period the source covers, but nothing in the source matches it' }, 'low');
}

// GL <-> subsidiary identity for an event that would be preserved. Reported, never repaired.
function structuralIssues(e, ctx) {
  const issues = [];
  const je = e.je;
  const financialSubs = e.subs.filter((s) => s.table !== 'payments' || s.row.livemode === true);
  if (!je) { if (financialSubs.length) issues.push(`subsidiary ${financialSubs[0].table} record with no journal entry`); return issues; }
  if (je.status !== 'posted') issues.push(`journal entry status ${je.status}`);
  if (Number(je.total_debits_cents) !== Number(je.total_credits_cents)) issues.push('journal entry header debits != credits');
  if (e.lines.length < 2) issues.push('journal entry has fewer than two lines');
  const dr = e.lines.reduce((t, l) => t + Number(l.debit_cents || 0), 0), cr = e.lines.reduce((t, l) => t + Number(l.credit_cents || 0), 0);
  if (e.lines.length && dr !== cr) issues.push('journal entry lines do not balance');
  if (e.lines.length && dr !== Number(je.total_debits_cents)) issues.push('journal entry lines do not equal the header total');
  const arLines = e.lines.filter((l) => ctx.accountNumber(l.account_id) === ctx.roles.ar_account);
  if (arLines.length) {
    const arNet = arLines.reduce((t, l) => t + Number(l.debit_cents || 0) - Number(l.credit_cents || 0), 0);
    const arSubs = e.subs.filter((s) => ['ar_charges', 'ar_payments', 'payments', 'homeowner_transactions'].includes(s.table));
    if (!arSubs.length) issues.push('AR is posted but no homeowner AR record is linked');
    else {
      const subNet = arSubs.reduce((t, s) => t + (s.table === 'ar_charges' ? Number(s.row.original_amount_cents) : -Number(s.row.amount_cents || 0)), 0);
      if (subNet !== arNet) issues.push(`AR lines (${arNet}) != linked homeowner records (${subNet})`);
    }
  }
  const invs = e.subs.filter((s) => s.table === 'ap_invoices');
  if (invs.length) {
    const t = invs.reduce((s, r) => s + Number(r.row.total_cents || 0), 0);
    const apLines = ctx.roles.ap_account ? e.lines.filter((l) => ctx.accountNumber(l.account_id) === ctx.roles.ap_account) : [];
    const apNet = apLines.reduce((s, l) => s + Number(l.credit_cents || 0) - Number(l.debit_cents || 0), 0);
    if (t !== Number(je.total_debits_cents)) {
      // The subledger <-> GL identity is the AP account: invoice total = net AP credit.
      // A header grossed up by a self-cancelling pair (a bill's previous balance and
      // payment lines) is reported as a note, not as a broken identity.
      if (apLines.length && apNet === t) (e.notes = e.notes || []).push(`journal entry header ${je.total_debits_cents} is grossed up by self-cancelling lines; net AP credit ${apNet} = invoice total ${t}`);
      else issues.push(`AP invoice total (${t}) != journal entry (${je.total_debits_cents})`);
    } else if (apLines.length && apNet !== t) issues.push(`AP invoice total (${t}) != net AP credit (${apNet})`);
    if (invs.some((r) => r.row.voided_at)) issues.push('a linked AP invoice is voided');
  }
  const aps = e.subs.filter((s) => s.table === 'ap_payments');
  if (aps.length) { const t = aps.reduce((s, r) => s + Number(r.row.amount_cents || 0), 0); if (t !== Number(je.total_debits_cents)) issues.push(`AP payment (${t}) != journal entry (${je.total_debits_cents})`); }
  return issues;
}

// Fingerprint of the Trusted activity the bridge saw: any later change makes it stale.
function trustedFingerprint(t) {
  const rows = [];
  for (const [table, list] of Object.entries(t)) for (const r of list || []) rows.push([table, r.id, r.updated_at || r.created_at || null, r.status || null, r.total_debits_cents ?? r.total_cents ?? r.amount_cents ?? r.original_amount_cents ?? r.debit_cents ?? null, r.credit_cents ?? null, r.superseded_at || null]);
  rows.sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

// Restored AP items (snapshot lines kind ap_detail_restored) -> the ONE Trusted invoice
// each names (same invoice number, same amount, dated on/before the cutoff, not voided).
// An item that matches zero or several invoices restores nothing here (the preflight
// reports it); amount alone never matches.
function restoredIndex(restoredAp, trusted, cutoff, apApplications) {
  const byInvoiceId = new Map();
  for (const it of restoredAp || []) {
    const hits = (trusted.ap_invoices || []).filter((r) => String(r.vendor_invoice_number || '').trim() === String(it.invoice_number) && Number(r.total_cents) === Number(it.amount_cents)
      && !r.voided_at && String(r.invoice_date || '').slice(0, 10) <= cutoff);
    if (hits.length === 1 && !byInvoiceId.has(hits[0].id)) byInvoiceId.set(hits[0].id, it);
  }
  const appsOfPayment = (pid) => (apApplications || []).filter((a) => a.payment_id === pid);
  return { byInvoiceId, appsOfPayment };
}

function buildBridge(parsed, trusted, { batch_code, cutoff_date, roles = {}, snapshot = null, accountOfProperty = null, accountNumber = () => null, apApplications = [], decisions = [], restoredAp = [] } = {}) {
  if (!batch_code || !cutoff_date) throw new Error('bridge needs batch_code and cutoff_date');
  const src = sourceIndex(parsed);
  const byId = new Map(trusted.journal_entries.map((j) => [j.id, j]));
  const invDate = new Map((trusted.ap_invoices || []).map((r) => [r.id, r.invoice_date]));
  const invoiceDatesOfPayment = (paymentId) => (apApplications || []).filter((a) => a.payment_id === paymentId).map((a) => invDate.get(a.invoice_id)).filter(Boolean);
  const restored = restoredIndex(restoredAp, trusted, cutoff_date, apApplications);
  const linesByJe = new Map(); for (const l of trusted.journal_entry_lines || []) { if (!linesByJe.has(l.journal_entry_id)) linesByJe.set(l.journal_entry_id, []); linesByJe.get(l.journal_entry_id).push(l); }
  const ctx = { cutoff: cutoff_date, src, byId, roles, accountOfProperty, accountNumber, usedSource: new Set(), invoiceDatesOfPayment, restored, linesByJe };
  // deterministic order (date, then key) so source-line consumption never depends on load order
  const events = buildEvents(trusted).sort((a, b) => (eventDate(a) || '').localeCompare(eventDate(b) || '') || a.event_key.localeCompare(b.event_key));
  const items = events.map((e, i) => {
    const c = classifyEvent(e, ctx);
    const issues = [...(c.structural_issues || []), ...(c.classification === 'LEGITIMATE_SUBSEQUENT' ? structuralIssues(e, ctx) : [])];
    let evidence = e.notes && e.notes.length ? { ...c.evidence, notes: e.notes } : c.evidence;
    if (c.classification === 'AMBIGUOUS') {
      if (!evidence.decision) evidence = { ...evidence, decision: genericDecision({ ...c, evidence }) };
      const recorded = recordedDecisionFor({ ...c, evidence }, decisions);
      if (recorded) evidence = { ...evidence, decision: { ...evidence.decision, recorded } };
    }
    return Object.freeze({ item_no: i + 1, batch_code, cutoff_date, ...c, evidence, structural_issues: issues });
  }).sort((a, b) => (a.event_date || '').localeCompare(b.event_date || '') || a.event_key.localeCompare(b.event_key)).map((it, i) => Object.freeze({ ...it, item_no: i + 1 }));

  // ---- controls: every candidate record accounted for exactly once; nothing disappears
  const candidates = new Set();
  for (const [table, list] of Object.entries(trusted)) if (table !== 'journal_entry_lines') for (const r of list || []) candidates.add(key(table, r.id));
  const seen = new Map();
  for (const it of items) for (const r of it.records) seen.set(r, (seen.get(r) || 0) + 1);
  const missing = [...candidates].filter((r) => !seen.has(r));
  const doubled = [...seen.entries()].filter(([, n]) => n > 1).map(([r]) => r);
  const extra = [...seen.keys()].filter((r) => !candidates.has(r));
  const totals = Object.fromEntries(CLASSES.map((k) => [k, { events: 0, records: 0, amount_cents: 0 }]));
  for (const it of items) { const t = totals[it.classification]; t.events++; t.records += it.records.length; t.amount_cents += it.amount_cents; }
  const controls = [
    C.holds('bridge.every_record_classified_exactly_once', { label: 'Every candidate Trusted financial record is in exactly one classified event', failures: [...missing.map((r) => ({ record: r, problem: 'not classified' })), ...doubled.map((r) => ({ record: r, problem: 'classified more than once' })), ...extra.map((r) => ({ record: r, problem: 'not a candidate' }))] }),
    C.equals('bridge.record_count_reconciles', { label: 'Candidate records = records across all classifications', left: candidates.size, right: Object.values(totals).reduce((t, x) => t + x.records, 0), leftLabel: 'candidates', rightLabel: 'classified' }),
    C.holds('bridge.no_duplicate_on_amount_alone', { label: 'No event is ALREADY_IN_SOURCE on amount alone (identifier or provenance required)', failures: items.filter((it) => it.classification === 'ALREADY_IN_SOURCE' && !/provenance|identifier|number|reference|lines_identical/.test(it.method)).map((it) => ({ event: it.event_key, method: it.method })) }),
    C.holds('bridge.every_item_has_evidence', { label: 'Every classification carries a method and evidence', failures: items.filter((it) => !it.method || !it.evidence).map((it) => ({ event: it.event_key })) }),
    C.holds('bridge.preserved_events_structurally_complete', { label: 'Every event to be preserved is a balanced, posted entry with GL <-> subsidiary identity', failures: items.filter((it) => it.structural_issues.length && it.classification !== 'OUT_OF_SCOPE').map((it) => ({ event: it.event_key, classification: it.classification, issues: it.structural_issues })) }),
    // An open question is settled by a recorded owner DECISION (never by a waiver).
    (() => {
      const open = items.filter((it) => it.classification === 'AMBIGUOUS' && !(it.evidence.decision && it.evidence.decision.recorded));
      return open.length
        ? Object.freeze({ ...C.blocked('bridge.ambiguous_items_reviewed', { label: 'Every open question has a recorded owner decision', reason: `${open.length} open question(s) need the owner's decision`, needs: ['owner_decision'] }), left_cents: open.reduce((t, it) => t + it.amount_cents, 0), left_label: 'undecided dollars' })
        : C.holds('bridge.ambiguous_items_reviewed', { label: 'Every open question has a recorded owner decision', failures: [] });
    })(),
    snapshot && snapshot.completion_id
      ? C.holds('bridge.built_on_current_snapshot', { label: 'Built on the current snapshot result', failures: snapshot.stale ? [{ snapshot: snapshot.completion_id, problem: 'stale' }] : [] })
      : C.blocked('bridge.built_on_current_snapshot', { label: 'Built on the current snapshot result', reason: 'no snapshot result to build on', needs: ['snapshot'] }),
  ];
  const fingerprint = trustedFingerprint(trusted);
  const source_notes = sourceAnomalies(src);
  const body = { batch_code, cutoff_date, snapshot_completion_id: snapshot ? snapshot.completion_id : null, trusted_fingerprint: fingerprint, items, totals, source_notes, bridge_engine: BRIDGE_VERSION,
    ...((restoredAp || []).length ? { restored_ap: restoredAp.map((it) => ({ line_no: it.line_no, invoice_number: it.invoice_number, amount_cents: Number(it.amount_cents) })) } : {}) };
  const sha256 = crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');
  return Object.freeze({ ...body, controls, sha256, candidate_records: candidates.size });
}

module.exports = { CLASSES, BRIDGE_VERSION, buildBridge, buildEvents, trustedFingerprint };
