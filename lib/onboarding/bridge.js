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
//      homeowner account + reference), with the amount as a CONFIRMATION, never alone
//   4. amount (+ counterparty) similarity WITHOUT an identifier  ->  AMBIGUOUS, never a duplicate
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
  return { gl, hoTx };
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
function contradicts(r, { ident, date }) {
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
  if (je && je.source_module === 'system' && date && date <= cutoff) return out('ALREADY_IN_SOURCE', 'system_entry_in_source_period', { source_module: 'system', date, note: 'Trusted system entry dated inside the period the authoritative source covers (the source position supersedes it)' }, 'medium');

  // 2. no money moved
  const pays = e.subs.filter((s) => s.table === 'payments');
  if (pays.length && !je && pays.every((s) => s.row.livemode !== true || !['succeeded', 'paid', 'settled', 'posted'].includes(String(s.row.status)))) return out('OUT_OF_SCOPE', 'payment_not_live_or_not_settled', { statuses: [...new Set(pays.map((s) => `${s.row.status}/${s.row.livemode === true ? 'live' : 'test'}`))] });
  if (je && (je.status === 'voided' || je.reverses_je_id)) {
    const partnerId = je.status === 'voided' ? je.void_reversal_je_id : je.reverses_je_id;
    const partner = partnerId ? byId.get(partnerId) : null;
    if (partner && Number(partner.total_debits_cents) === Number(je.total_debits_cents)) return out('OUT_OF_SCOPE', 'void_pair_nets_to_zero', { partner_journal_entry: partnerId, partner_reference: partner.reference || null, amount_cents: amount });
    return { ...out('AMBIGUOUS', 'void_without_matching_reversal', { partner_journal_entry: partnerId || null }), structural_issues: ['voided or reversing entry without a matching partner of the same amount'] };
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
  if (amount > 0) {
    const near = src.gl.filter((r) => glAmount(r) === amount && days(r.date, date) <= 45 && (!inv || /invoice/i.test(r.source_type || '')) && !contradicts(r, { ident, date }));
    if (near.length && (inv || chk || kind === 'ap_invoice' || kind === 'payment_intake')) return out('AMBIGUOUS', 'amount_match_without_identifier', { identifier: ident || null, trusted_amount_cents: amount, source_candidates: near.slice(0, 5).map(srcRef), note: 'same amount near the date but no shared identifier; never treated as a duplicate on amount alone' }, 'low');
  }

  // 5. no source evidence at all: the date decides
  if (date && date > cutoff) return out('LEGITIMATE_SUBSEQUENT', 'after_cutoff_no_source_evidence', { identifier: ident || null, cutoff });
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
  if (invs.length) { const t = invs.reduce((s, r) => s + Number(r.row.total_cents || 0), 0); if (t !== Number(je.total_debits_cents)) issues.push(`AP invoice total (${t}) != journal entry (${je.total_debits_cents})`); if (invs.some((r) => r.row.voided_at)) issues.push('a linked AP invoice is voided'); }
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

function buildBridge(parsed, trusted, { batch_code, cutoff_date, roles = {}, snapshot = null, accountOfProperty = null, accountNumber = () => null } = {}) {
  if (!batch_code || !cutoff_date) throw new Error('bridge needs batch_code and cutoff_date');
  const src = sourceIndex(parsed);
  const byId = new Map(trusted.journal_entries.map((j) => [j.id, j]));
  const ctx = { cutoff: cutoff_date, src, byId, roles, accountOfProperty, accountNumber };
  const events = buildEvents(trusted);
  const items = events.map((e, i) => {
    const c = classifyEvent(e, ctx);
    const issues = [...(c.structural_issues || []), ...(c.classification === 'LEGITIMATE_SUBSEQUENT' ? structuralIssues(e, ctx) : [])];
    return Object.freeze({ item_no: i + 1, batch_code, cutoff_date, ...c, structural_issues: issues });
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
    C.holds('bridge.no_duplicate_on_amount_alone', { label: 'No event is ALREADY_IN_SOURCE on amount alone (identifier or provenance required)', failures: items.filter((it) => it.classification === 'ALREADY_IN_SOURCE' && !/provenance|identifier|number|reference|system_entry/.test(it.method)).map((it) => ({ event: it.event_key, method: it.method })) }),
    C.holds('bridge.every_item_has_evidence', { label: 'Every classification carries a method and evidence', failures: items.filter((it) => !it.method || !it.evidence).map((it) => ({ event: it.event_key })) }),
    C.holds('bridge.preserved_events_structurally_complete', { label: 'Every event to be preserved is a balanced, posted entry with GL <-> subsidiary identity', failures: items.filter((it) => it.structural_issues.length && it.classification !== 'OUT_OF_SCOPE').map((it) => ({ event: it.event_key, classification: it.classification, issues: it.structural_issues })) }),
    totals.AMBIGUOUS.events
      ? Object.freeze({ ...C.blocked('bridge.ambiguous_items_reviewed', { label: 'No event needs human review', reason: `${totals.AMBIGUOUS.events} ambiguous event(s) need a human decision`, needs: ['human_review'] }), left_cents: totals.AMBIGUOUS.amount_cents, left_label: 'ambiguous dollars' })
      : C.holds('bridge.ambiguous_items_reviewed', { label: 'No event needs human review', failures: [] }),
    snapshot && snapshot.completion_id
      ? C.holds('bridge.built_on_current_snapshot', { label: 'Built on the current snapshot result', failures: snapshot.stale ? [{ snapshot: snapshot.completion_id, problem: 'stale' }] : [] })
      : C.blocked('bridge.built_on_current_snapshot', { label: 'Built on the current snapshot result', reason: 'no snapshot result to build on', needs: ['snapshot'] }),
  ];
  const fingerprint = trustedFingerprint(trusted);
  const body = { batch_code, cutoff_date, snapshot_completion_id: snapshot ? snapshot.completion_id : null, trusted_fingerprint: fingerprint, items, totals };
  const sha256 = crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');
  return Object.freeze({ ...body, controls, sha256, candidate_records: candidates.size });
}

module.exports = { CLASSES, buildBridge, buildEvents, trustedFingerprint };
