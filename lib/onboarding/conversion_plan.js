// ============================================================================
// lib/onboarding/conversion_plan.js  (Issue #15 Milestone 5) — the write contract
// ----------------------------------------------------------------------------
// PURE: from the current snapshot (the source position at the cutoff), the
// current PASS activity-bridge result (+ the owner's recorded decisions), the
// parsed source rows and a READ-ONLY copy of Trusted's financial records,
// enumerate EXACTLY what EXECUTE would write, line by line, and prove before
// anything is written that the result reproduces the source trial balance at
// the cutoff. No database client; nothing here writes.
//
// The contract follows the posted LOPF 7/31 conversion (CONV-LPF-20260731):
//   OPENING_JE        one journal entry per fund, dated the cutoff (source TB)
//   SUPERSEDE         prior legacy-import journal entries -> status 'superseded'
//                     (rows and lines retained; never counted again)
//   REVERT_AR_BATCH   the prior legacy homeowner-ledger import batch -> 'reverted'
//   NEUTRALIZE        a Trusted-native entry already in the source, or one an
//                     owner decision moves after the cutoff: an equal reversal
//                     on the ORIGINAL date (the original stays, as audit)
//   REPOST            the same lines again on the cutover date
//   AR_OPENING_BATCH  the homeowner ledger at the cutoff: aging items, current-
//                     owner prepaids, and PRIOR-OWNER historical balances
//   AP_OPENING_INVOICES  invoices open at the cutoff, posted by the opening entry
//   CUTOVER_DATE      communities.gl_cutover_date -> the day after the cutoff
// Every entry is written exactly as the live schema accepts it (M6, LOPF
// precedent): opening entries source_module 'opening_entry' (bank rec excludes
// them from operational activity), neutralizations 'reversal', re-posts
// 'manual'; each entry names the OPEN accounting period its date falls in.
// Everything else (post-cutover activity, out-of-scope records, payments and
// applications) is UNTOUCHED and listed as such.
//
// Prior-owner historical balances (generic, any source): a source row marked as
// a previous owner is kept on the PRIOR owner's own source account, tied to the
// lot it is printed against (exact lot address), with NO tenure and ownership
// dates "not established". The current-owner ledger (v_current_owner_ledger,
// mig 457) counts a row only on the lot's current tenure or current account, so
// such a row can never reach the current owner; v_former_owner_ledger_balances
// shows it. No tenure or date is invented to place it.
// ============================================================================
const crypto = require('crypto');
const { countsInGl } = require('../accounting/je_status');
const { categorizeChargeDescription } = require('../ar/categorize');
const { normName } = require('../ap/vendor_name');
const { buildBuilderPositions } = require('./builder_positions');

const PLAN_VERSION = '2026-10-08.1';
const dayAfter = (d) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
const d10 = (v) => (v ? String(v).slice(0, 10) : null);
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const lotKey = (s) => norm(s).replace(/\bDRIVE\b/g, 'DR').replace(/\bLANE\b/g, 'LN').replace(/\bSTREET\b/g, 'ST').replace(/\bCOURT\b/g, 'CT').replace(/\bROAD\b/g, 'RD').replace(/\bAVENUE\b/g, 'AVE');
const sha = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const ctl = (code, label, failures, extra = {}) => ({ code, label, level: 'preflight', status: failures.length ? (extra.blocked ? 'BLOCKED' : 'FAIL') : 'PASS', failures,
  ...(extra.reason ? { reason: extra.reason } : {}), ...(extra.left != null ? { left_cents: extra.left } : {}), ...(extra.right != null ? { right_cents: extra.right, difference_cents: (extra.left || 0) - extra.right } : {}) });
const parseRecord = (r) => { const s = String(r); const i = s.indexOf(':'); return { table: s.slice(0, i), id: s.slice(i + 1) }; };
const net = (l) => Number(l.debit_cents || 0) - Number(l.credit_cents || 0);

/**
 * @param {object} p
 *   batch     { id, batch_code, community_id, as_of_date }
 *   snapshot  { completion_id, sha256, roles, lines: [{ line_no, kind, account_code, fund_code, source_account_key, amount_cents, detail }] }
 *   bridge    { completion_id, sha256, trusted_fingerprint, status, items: [{ item_no, event_key, kind, classification, method, event_date, amount_cents, evidence, records: ['table:id'] }] }
 *   decisions [{ id, event_key, decision_type, choice_key, item_amount_cents, actor_id, decided_at, bridge_completion_id }]
 *   source    { prepaid_rows: [{ source_account_key, amount_cents, previous_owner, provenance: { artifact_sha256, locator, raw } }],
 *               aging_rows: [{ source_account_key, balance_cents, previous_owner, provenance: { artifact_sha256, locator, raw } }] }
 *   trusted   read-only loader output .trusted (journal_entries, journal_entry_lines, ap_invoices, homeowner_transactions, ...)
 *   ap_applications  read-only loader output .apApplications [{ payment_id, invoice_id, applied_cents }]
 *   ctx       { accounts: [{ id, account_number, fund_id, vantaca_account_number }], funds: [{ id, code }], properties: [{ id, vantaca_account_id, street_address }],
 *               tenures: [{ id, property_id, kind, start_date, end_date }], vendors: [{ id, name }], gl_cutover_date, current_trusted_fingerprint,
 *               periods: [{ id, period_start, period_end, status }], management_company_id }
 */
function buildConversionPlan({ batch, snapshot, bridge, decisions = [], source = {}, trusted, ap_applications: apApplications = [], ctx }) {
  const cutoff = d10(batch.as_of_date); const cutover = dayAfter(cutoff); const code = batch.batch_code;
  const accounts = ctx.accounts || []; const funds = ctx.funds || [];
  const acctById = new Map(accounts.map((a) => [a.id, a])); const fundById = new Map(funds.map((f) => [f.id, f]));
  const accountNumber = (id) => (acctById.get(id) || {}).account_number || `?${id}`;
  const jeById = new Map((trusted.journal_entries || []).map((j) => [j.id, j]));
  const linesByJe = new Map(); for (const l of trusted.journal_entry_lines || []) { if (!linesByJe.has(l.journal_entry_id)) linesByJe.set(l.journal_entry_id, []); linesByJe.get(l.journal_entry_id).push(l); }
  for (const ls of linesByJe.values()) ls.sort((a, b) => (Number(a.line_number) || 0) - (Number(b.line_number) || 0) || String(a.id).localeCompare(String(b.id)));
  const htById = new Map((trusted.homeowner_transactions || []).map((h) => [h.id, h]));
  const controls = []; const notes = [];
  const roles = snapshot.roles || {};

  // ---------------------------------------------------------------- treatments
  const decisionOf = (it) => {
    const r = it.evidence && it.evidence.decision && it.evidence.decision.recorded;
    if (r) return { choice_key: r.choice_key, decision_id: r.decision_id || null };
    const d = decisions.filter((x) => x.event_key === it.event_key && Number(x.item_amount_cents ?? it.amount_cents) === Number(it.amount_cents));
    return d.length ? { choice_key: d[d.length - 1].choice_key, decision_id: d[d.length - 1].id } : null;
  };
  const supersede = new Map(); const neutralize = new Map(); const repost = new Map(); const revertBatches = new Map(); const untouched = []; const noTreatment = [];
  const accrualReclasses = [];   // owner decision 'accrued_in_legacy_books': move the source accrual to AP on the cutover date
  const preCutJe = (id) => { const j = jeById.get(id); return j && d10(j.posting_date) <= cutoff; };
  for (const it of bridge.items || []) {
    const recs = (it.records || []).map(parseRecord); const jes = recs.filter((r) => r.table === 'journal_entries').map((r) => r.id);
    const why = { item_no: it.item_no, event_key: it.event_key, classification: it.classification, method: it.method };
    if (it.classification === 'ALREADY_IN_SOURCE' && /^provenance_legacy_import/.test(it.method)) {
      for (const id of jes) supersede.set(id, why);
      for (const r of recs.filter((x) => x.table === 'homeowner_transactions')) {
        const h = htById.get(r.id); if (!h || !h.source_batch_id) continue;
        if (!revertBatches.has(h.source_batch_id)) revertBatches.set(h.source_batch_id, { ...why, rows: 0 }); revertBatches.get(h.source_batch_id).rows++;
      }
      const other = recs.filter((x) => !['journal_entries', 'homeowner_transactions'].includes(x.table));
      if (other.length) untouched.push({ ...why, reason: 'legacy subledger rows; their posting entry is superseded; kept as history', records: other.length, tables: [...new Set(other.map((x) => x.table))].sort() });
    } else if (it.classification === 'ALREADY_IN_SOURCE') {
      for (const id of jes) { if (preCutJe(id)) neutralize.set(id, { ...why, because: 'already in the source position' }); else untouched.push({ ...why, reason: 'dated after the cutoff', records: 1 }); }
    } else if (it.classification === 'AMBIGUOUS') {
      const dec = decisionOf(it);
      if (!dec) { noTreatment.push({ ...why, problem: 'open question with no recorded decision' }); continue; }
      if (dec.choice_key === 'record_after_cutoff' || dec.choice_key === 'keep_as_trusted_activity') {
        for (const id of jes) { if (preCutJe(id)) { neutralize.set(id, { ...why, because: `owner decision ${dec.choice_key}` }); repost.set(id, { ...why, because: `owner decision ${dec.choice_key}` }); } }
        untouched.push({ ...why, reason: `document kept (owner decision ${dec.choice_key}); only its GL date moves to ${cutover}`, records: recs.filter((x) => x.table !== 'journal_entries').length, decision: dec });
      } else if (dec.choice_key === 'accrued_in_legacy_books') {
        // The source accrued it (same expense lines, credited to a non-AP liability): the Trusted entry is a
        // duplicate of the source expense, so it is neutralized; the bill is real and is paid from AP after
        // the cutover, so the accrual moves from that liability to AP on the cutover date (Dr accrual / Cr AP).
        const acc = it.evidence && it.evidence.decision && it.evidence.decision.accrual;
        if (!acc || !acc.account || !(Number(acc.amount_cents) > 0)) { noTreatment.push({ ...why, problem: 'accrued_in_legacy_books needs the proven source accrual (account and amount)' }); continue; }
        for (const id of jes) if (preCutJe(id)) neutralize.set(id, { ...why, because: `owner decision: accrued in the legacy books to ${acc.account}` });
        accrualReclasses.push({ ...why, je: jes[0], account: String(acc.account), amount_cents: Number(acc.amount_cents), source_lines: acc.source_lines || [], decision: dec });
      } else if (dec.choice_key === 'already_in_legacy_books') {
        for (const id of jes) if (preCutJe(id)) neutralize.set(id, { ...why, because: 'owner decision: already in the legacy books' });
      } else noTreatment.push({ ...why, problem: `decision ${dec.choice_key} has no conversion treatment in this milestone` });
    } else if (it.classification === 'LEGITIMATE_SUBSEQUENT') {
      for (const id of jes) if (preCutJe(id)) { neutralize.set(id, { ...why, because: 'subsequent activity dated before the cutover' }); repost.set(id, { ...why, because: 'subsequent activity dated before the cutover' }); }
      untouched.push({ ...why, reason: 'post-cutoff activity preserved', records: recs.length });
    } else {
      // A void pair that STRADDLES the cutoff (entry on/before it, its void reversal after it) nets to
      // zero overall but not at the cutoff. Move the entry across the cutover with its reversal:
      // neutralize it on its own date, re-post it on the cutover date; the cutoff TB stays the
      // source's and, after the cutover, the re-post and the existing reversal net to zero.
      for (const id of jes) {
        const j = jeById.get(id); if (!j || !preCutJe(id)) continue;
        const partnerId = j.status === 'voided' ? j.void_reversal_je_id : j.reverses_je_id;
        if (partnerId && jeById.has(partnerId) && !preCutJe(partnerId)) { neutralize.set(id, { ...why, because: 'void pair straddles the cutoff (reversal after the cutover)' }); repost.set(id, { ...why, because: 'void pair straddles the cutoff; re-posted to meet its reversal' }); }
      }
      untouched.push({ ...why, reason: 'out of scope (no money moved / nets to zero)', records: recs.length });
    }
  }
  controls.push(ctl('preflight.every_item_has_a_treatment', 'Every bridge item has exactly one conversion treatment', noTreatment, { blocked: true }));

  // ------------------------------------------------- residual pre-cutover GL
  const counted = (trusted.journal_entries || []).filter(countsInGl);
  const preCut = counted.filter((j) => d10(j.posting_date) <= cutoff);
  const residualJes = preCut.filter((j) => !supersede.has(j.id) && !neutralize.has(j.id));
  const residual = new Map(); for (const j of residualJes) for (const l of linesByJe.get(j.id) || []) residual.set(accountNumber(l.account_id), (residual.get(accountNumber(l.account_id)) || 0) + net(l));
  const residualNonZero = [...residual].filter(([, v]) => v !== 0).sort(([a], [b]) => a.localeCompare(b)).map(([account, net_cents]) => ({ account, net_cents, entries: residualJes.filter((j) => (linesByJe.get(j.id) || []).some((l) => accountNumber(l.account_id) === account)).map((j) => j.reference || j.id) }));
  controls.push(ctl('preflight.no_unhandled_pre_cutover_entries', 'Every counted Trusted entry dated on/before the cutoff is superseded or neutralized (or nets to zero)', residualNonZero, { blocked: true }));
  const wrongStatus = [...supersede.keys()].filter((id) => (jeById.get(id) || {}).status !== 'posted').map((id) => ({ je: id, status: (jeById.get(id) || {}).status || 'missing' }));
  controls.push(ctl('preflight.supersede_targets_posted', 'Every entry to supersede exists and is currently posted', wrongStatus, { blocked: true }));

  // ---------------------------------------------------------- opening entries
  const tb = (snapshot.lines || []).filter((l) => l.kind === 'gl_opening_balance').sort((a, b) => String(a.account_code).localeCompare(String(b.account_code)));
  const resolveAcct = (c) => { const hits = accounts.filter((a) => a.account_number === c); if (hits.length === 1) return hits[0]; if (hits.length) return null; const v = accounts.filter((a) => a.vantaca_account_number === c); return v.length === 1 ? v[0] : null; };
  const unresolved = []; const byFund = new Map();
  for (const l of tb) {
    const a = resolveAcct(l.account_code);
    if (!a) { unresolved.push({ account: l.account_code, amount_cents: l.amount_cents, problem: 'no single Trusted account' }); continue; }
    const fcode = (fundById.get(a.fund_id) || {}).code || l.fund_code || null;
    if (!fcode) { unresolved.push({ account: l.account_code, problem: 'account has no fund' }); continue; }
    const amt = Number(l.amount_cents);
    // A source-evidenced fund allocation splits the account's opening across funds (each part
    // a line of the SAME account, tagged with that fund); the parts already sum to the opening.
    const alloc = l.detail && l.detail.fund_allocation;
    if (alloc && Array.isArray(alloc.parts) && alloc.parts.length) {
      const missing = alloc.parts.filter((p) => !funds.some((f) => f.code === p.fund_code));
      if (missing.length || alloc.parts.reduce((t, p) => t + Number(p.amount_cents), 0) !== amt) { unresolved.push({ account: l.account_code, problem: missing.length ? `fund allocation names unknown fund(s) ${missing.map((p) => p.fund_code).join(', ')}` : 'fund allocation parts do not equal the opening' }); continue; }
      for (const p of alloc.parts) {
        const f = funds.find((x) => x.code === p.fund_code); const v = Number(p.amount_cents);
        if (!byFund.has(f.code)) byFund.set(f.code, []);
        byFund.get(f.code).push({ account_number: l.account_code, account_id: a.id, fund_id: f.id, debit_cents: v > 0 ? v : 0, credit_cents: v < 0 ? -v : 0, memo: `Source TB ${cutoff} ${l.account_code}, ${f.code} part per the source fund columns (snapshot line ${l.line_no})` });
      }
      continue;
    }
    if (!byFund.has(fcode)) byFund.set(fcode, []);
    if (amt !== 0) byFund.get(fcode).push({ account_number: l.account_code, account_id: a.id, fund_id: a.fund_id, debit_cents: amt > 0 ? amt : 0, credit_cents: amt < 0 ? -amt : 0, memo: `Source TB ${cutoff} ${l.account_code} (snapshot line ${l.line_no})` });
  }
  controls.push(ctl('preflight.accounts_resolved', 'Every source TB account maps to exactly one Trusted account and its fund', unresolved, { blocked: true }));
  const openingJes = [...byFund].filter(([, lines]) => lines.length).sort(([a], [b]) => a.localeCompare(b)).map(([fcode, lines]) => ({
    reference: `${code}-OPEN-${fcode}`, posting_date: cutoff, source_module: 'opening_entry', fund_code: fcode,
    description: `Conversion opening balances at ${cutoff} (${fcode}) from the source trial balance`,
    lines: lines.map((l, i) => ({ line_number: i + 1, ...l })), total_debits_cents: lines.reduce((t, l) => t + l.debit_cents, 0), total_credits_cents: lines.reduce((t, l) => t + l.credit_cents, 0) }));
  controls.push(ctl('preflight.opening_entries_balance', 'Each fund\'s opening entry balances (debits = credits)', openingJes.filter((j) => j.total_debits_cents !== j.total_credits_cents).map((j) => ({ fund: j.fund_code, debits_cents: j.total_debits_cents, credits_cents: j.total_credits_cents, difference_cents: j.total_debits_cents - j.total_credits_cents })), { blocked: true }));

  // ------------------------------------------------- neutralize + repost lines
  const ref = (id) => (jeById.get(id) || {}).reference || String(id).slice(0, 8);
  const copyLines = (id, negate) => (linesByJe.get(id) || []).map((l, i) => ({ line_number: i + 1, account_number: accountNumber(l.account_id), account_id: l.account_id, fund_id: l.fund_id || null,
    debit_cents: Number(negate ? l.credit_cents : l.debit_cents) || 0, credit_cents: Number(negate ? l.debit_cents : l.credit_cents) || 0, property_id: l.property_id || null, vendor_id: l.vendor_id || null, memo: `${negate ? 'Reversal' : 'Re-post'} of ${ref(id)} line ${i + 1}` }));
  const total = (lines) => ({ total_debits_cents: lines.reduce((t, l) => t + l.debit_cents, 0), total_credits_cents: lines.reduce((t, l) => t + l.credit_cents, 0) });
  const byDateThenId = ([a], [b]) => String(d10((jeById.get(a) || {}).posting_date)).localeCompare(String(d10((jeById.get(b) || {}).posting_date))) || String(a).localeCompare(String(b));
  const neutralizeJes = [...neutralize].sort(byDateThenId).map(([id, why]) => { const lines = copyLines(id, true); return { reference: `${code}-NEUT-${ref(id)}`, original_je_id: id, posting_date: d10(jeById.get(id).posting_date), source_module: 'reversal', reverses_je_id: id, description: `Conversion neutralization of ${ref(id)} (${why.because})`, item_no: why.item_no, lines, ...total(lines) }; });
  const repostJes = [...repost].sort(byDateThenId).map(([id, why]) => { const lines = copyLines(id, false); return { reference: `${code}-REPOST-${ref(id)}`, original_je_id: id, posting_date: cutover, source_module: 'manual', source_reference: id, description: `Conversion re-post of ${ref(id)} effective ${cutover} (${why.because})`, item_no: why.item_no, lines, ...total(lines) }; });
  // Accrual-to-AP reclasses ride in the cutover-dated entries EXECUTE writes (same transaction, same period
  // and balance checks, same post-proof). Each names its decision; a non-AP accrual account it cannot resolve blocks.
  const reclassProblems = [];
  const apAcct = resolveAcct(roles.ap_account || '2000');
  for (const r of accrualReclasses.sort((a, b) => String(a.je).localeCompare(String(b.je)))) {
    const acc = resolveAcct(r.account);
    if (!acc || !apAcct || acc.id === apAcct.id) { reclassProblems.push({ item_no: r.item_no, account: r.account, problem: !acc ? 'the accrual account is not a single Trusted account' : !apAcct ? 'no AP account' : 'the accrual account is AP' }); continue; }
    const lines = [{ line_number: 1, account_number: r.account, account_id: acc.id, fund_id: acc.fund_id || null, debit_cents: r.amount_cents, credit_cents: 0, property_id: null, vendor_id: null, memo: `Move the source accrual for ${ref(r.je)} from ${r.account} to AP (owner decision)` },
      { line_number: 2, account_number: apAcct.account_number, account_id: apAcct.id, fund_id: apAcct.fund_id || null, debit_cents: 0, credit_cents: r.amount_cents, property_id: null, vendor_id: null, memo: `Payable for ${ref(r.je)}, accrued in the source to ${r.account}` }];
    repostJes.push({ reference: `${code}-RECLASS-${ref(r.je)}`, kind: 'accrual_to_ap_reclass', original_je_id: null, posting_date: cutover, source_module: 'manual', source_reference: r.je, description: `Conversion reclass ${cutover}: accrual for ${ref(r.je)} moved from ${r.account} to AP (owner decision accrued_in_legacy_books)`, item_no: r.item_no, decision_id: r.decision.decision_id || null, source_lines: r.source_lines, lines, ...total(lines) });
  }
  // BUILDER ASSESSMENTS (GitHub #96): each builder lot's position through the cutoff at the builder
  // rate, written as durable coverage + a cutover-dated entry and ledger batch; the deferred-assessment
  // release schedule; anything that does not reconcile is a reconciling item (never folded in).
  const srcTb = new Map(tb.map((l) => [l.account_code, Number(l.amount_cents)]));
  const builder = buildBuilderPositions({ cutoff, cutover, code, builder: ctx.builder, properties: ctx.properties || [], tenures: ctx.tenures || [], resolveAcct, tbOf: (a) => srcTb.get(a) || 0 });
  if (builder.je) repostJes.push(builder.je);
  for (const c of builder.controls) controls.push(ctl(c.code, c.label, c.failures, { blocked: !!c.blocked }));
  if (accrualReclasses.length) controls.push(ctl('preflight.accrual_reclasses_resolved', 'Every accrued-in-the-source decision moves its accrual to AP on the cutover date, balanced, between two resolved accounts', reclassProblems, { blocked: true }));
  // Every entry names the one OPEN accounting period its posting date falls in (the same
  // rule as lib/accounting/posting.js); EXECUTE re-checks the period is still open.
  const periodProblems = [];
  for (const j of [...openingJes, ...neutralizeJes, ...repostJes]) {
    const hits = (ctx.periods || []).filter((p) => d10(p.period_start) <= j.posting_date && d10(p.period_end) >= j.posting_date);
    const open = hits.filter((p) => ['open', 'reopened'].includes(p.status));
    if (open.length === 1) j.period_id = open[0].id;
    else periodProblems.push({ reference: j.reference, posting_date: j.posting_date, problem: hits.length ? (open.length ? 'more than one open period covers the date' : `the period is ${hits.map((p) => p.status).join('/')}`) : 'no accounting period covers the date' });
  }
  controls.push(ctl('preflight.posting_periods_open', 'Every proposed entry falls in exactly one OPEN accounting period', periodProblems, { blocked: true }));
  controls.push(ctl('preflight.reversal_entries_complete', 'Every neutralization / re-post copies a balanced original with all its lines', [...neutralizeJes, ...repostJes].filter((j) => !j.lines.length || j.total_debits_cents !== j.total_credits_cents).map((j) => ({ reference: j.reference, lines: j.lines.length })), { blocked: true }));

  // -------------------------------------------- projected trial balance proof
  const proj = new Map(); const add = (m, a, v) => m.set(a, (m.get(a) || 0) + v);
  for (const j of preCut.filter((x) => !supersede.has(x.id))) for (const l of linesByJe.get(j.id) || []) add(proj, accountNumber(l.account_id), net(l));
  for (const j of [...openingJes, ...neutralizeJes]) for (const l of j.lines) add(proj, l.account_number, l.debit_cents - l.credit_cents);
  const sourceTb = new Map(tb.map((l) => [l.account_code, Number(l.amount_cents)]));
  const tbDiff = [...new Set([...proj.keys(), ...sourceTb.keys()])].sort().map((a) => ({ account: a, projected_cents: proj.get(a) || 0, source_cents: sourceTb.get(a) || 0 })).filter((x) => x.projected_cents !== x.source_cents);
  controls.push(ctl('preflight.projected_cutoff_tb_equals_source', `After the proposed writes, Trusted's trial balance at ${cutoff} equals the source trial balance on every account`, tbDiff));

  // ------------------------------------------------------- homeowner ledger
  const props = ctx.properties || [];
  const propByAcct = new Map(props.filter((p) => p.vantaca_account_id).map((p) => [String(p.vantaca_account_id), p]));
  const currentAccounts = new Set(propByAcct.keys());
  const tenuresOf = (pid) => (ctx.tenures || []).filter((t) => t.property_id === pid && (t.kind || 'owner') === 'owner');
  const prepaidRowByAcct = new Map(); for (const r of source.prepaid_rows || []) if (r.previous_owner) prepaidRowByAcct.set(String(r.source_account_key), r);
  // FORMER OWNERS IN THE AR AGING (Ed 2026-10-07): when the snapshot routed them
  // (former_owner_receivable / former_owner_refund lines), their charge-type items become
  // PRIOR-OWNER rows on the former owner's own source account: receivables (debits) and
  // named refund liabilities (credits). Never a current owner's balance, never income.
  const formerAgingKind = new Map(); const formerAgingAcct = new Map();
  for (const l of (snapshot.lines || []).filter((x) => x.kind === 'former_owner_receivable' || x.kind === 'former_owner_refund')) { formerAgingKind.set(String(l.source_account_key), l.kind); formerAgingAcct.set(String(l.source_account_key), l.account_code); }
  const agingRowByAcct = new Map(); for (const r of source.aging_rows || []) if (r.previous_owner) agingRowByAcct.set(String(r.source_account_key), r);
  // "<account> - *** <lot address> - <name>": the lot only when it is exactly a Trusted lot address.
  const lotFromAgingRow = (raw, acct) => {
    const m = new RegExp(String.raw`^\s*${acct}\s+-\s+\*{3}\s*(.+?)\s+-\s+(.+?)\s*$`).exec(String(raw || ''));
    if (!m) return { hits: [], lot: null, address: null, name: null };
    const text = lotKey(m[1]); const hits = props.filter((p) => p.street_address && text === lotKey(p.street_address));
    return { hits, lot: hits.length === 1 ? hits[0] : null, address: m[1].trim(), name: m[2].trim() };
  };
  const formerAgingRows = [];
  const lotFromPrintedRow = (raw, acct) => {
    // "[***]<account>  <lot address>  <name as printed>  <amount>": the lot is the Trusted property whose
    // address the printed text starts with (exact lot address, longest match). Names are never used.
    const m = new RegExp(String.raw`^\s*\*{0,3}${acct}\s+(.*?)\s{2,}[\d,]+\.\d{2}\s*$`).exec(String(raw || ''));
    const text = lotKey(m ? m[1] : ''); if (!text) return { hits: [] };
    const hits = props.filter((p) => p.street_address && (text === lotKey(p.street_address) || text.startsWith(`${lotKey(p.street_address)} `)));
    const best = hits.length ? Math.max(...hits.map((p) => lotKey(p.street_address).length)) : 0;
    const top = hits.filter((p) => lotKey(p.street_address).length === best);
    const lot = top.length === 1 ? top[0] : null;
    return { hits: top, lot, printed_as: lot ? m[1].replace(/\s+/g, ' ').trim() : null };
  };
  const arRows = []; const arProblems = []; const priorOwner = [];
  for (const l of (snapshot.lines || []).filter((x) => x.kind === 'ar_aging_item' || x.kind === 'prepaid_detail').sort((a, b) => a.line_no - b.line_no)) {
    const acct = String(l.source_account_key || ''); const isPrepaid = l.kind === 'prepaid_detail'; const former = !!(l.detail && l.detail.former_owner);
    const chargeType = (l.detail && l.detail.charge_type) || (isPrepaid ? 'Prepaid' : 'Opening balance');
    if (!isPrepaid && formerAgingKind.has(acct)) {
      const src = agingRowByAcct.get(acct);
      if (!src) { arProblems.push({ line_no: l.line_no, problem: 'former-owner aging row has no source row (provenance missing)', amount_cents: l.amount_cents }); continue; }
      if (currentAccounts.has(acct)) { arProblems.push({ line_no: l.line_no, problem: 'former-owner aging account is a CURRENT property account (would reach a current owner)', amount_cents: l.amount_cents }); continue; }
      const refund = formerAgingKind.get(acct) === 'former_owner_refund'; const found = lotFromAgingRow(src.provenance && src.provenance.raw, acct);
      const row = { property_id: found.lot ? found.lot.id : null, vantaca_account_id: acct, tenure_id: null, prior_owner: true, transaction_date: cutoff,
        txn_type: refund ? 'credit' : 'balance_brought_forward', charge_category: refund ? 'credit' : categorizeChargeDescription(chargeType, { amount_cents: Number(l.amount_cents) }), amount_cents: Number(l.amount_cents),
        description: `${refund ? 'Former-owner refund payable' : 'Former-owner receivable'} at ${cutoff} (${chargeType}; source previous owner; ownership dates${found.lot ? '' : ' and lot'} not established)`, source_line_no: l.line_no, source_charge_type: chargeType,
        raw_row: { source: 'conversion', batch_code: code, prior_owner: { source_account: acct, printed_as: found.address ? `${found.address} - ${found.name}` : null, name: found.name || null, lot: found.lot ? 'exact lot address printed by the source' : (found.hits.length > 1 ? 'ambiguous; not established' : 'not established by the source'), ownership_dates: 'not established', gl_account: formerAgingAcct.get(acct), route: refund ? 'refund_liability' : 'prior_owner_receivable' },
          provenance: { artifact_sha256: src.provenance.artifact_sha256, locator: src.provenance.locator, report: 'ar_aging' } } };
      arRows.push(row); priorOwner.push(row); formerAgingRows.push({ ...row, kind: formerAgingKind.get(acct) }); continue;
    }
    if (former) {
      // PRIOR-OWNER historical balance: on the prior owner's own account, tied to the printed lot, no tenure, dates unknown.
      const src = prepaidRowByAcct.get(acct); const found = src ? lotFromPrintedRow(src.provenance && src.provenance.raw, acct) : { hits: [] };
      if (!src) { arProblems.push({ line_no: l.line_no, problem: 'prior-owner row has no source row (provenance missing)', amount_cents: l.amount_cents }); continue; }
      if (currentAccounts.has(acct)) { arProblems.push({ line_no: l.line_no, problem: 'prior-owner source account is a CURRENT property account (would reach a current owner)', amount_cents: l.amount_cents }); continue; }
      // The lot only when the source prints an exact Trusted lot address (one match); otherwise the lot is
      // NOT ESTABLISHED (e.g. a legacy placeholder address) and property_id stays null. Never guessed.
      const printedRaw = String((src.provenance && src.provenance.raw) || '');
      const printedText = (new RegExp(String.raw`^\s*\*{0,3}${acct}\s+(.*?)\s{2,}[\d,]+\.\d{2}\s*$`).exec(printedRaw) || [])[1];
      const row = { property_id: found.lot ? found.lot.id : null, vantaca_account_id: acct, tenure_id: null, prior_owner: true, transaction_date: cutoff, txn_type: 'credit', charge_category: 'credit', amount_cents: Number(l.amount_cents),
        description: `Prior-owner credit at ${cutoff} (source previous owner; ownership dates${found.lot ? '' : ' and lot'} not established)`, source_line_no: l.line_no, source_charge_type: chargeType,
        raw_row: { source: 'conversion', batch_code: code, prior_owner: { source_account: acct, printed_as: printedText ? printedText.replace(/\s+/g, ' ').trim() : null, lot: found.lot ? 'exact lot address printed by the source' : (found.hits.length > 1 ? 'ambiguous; not established' : 'not established by the source'), ownership_dates: 'not established' },
          provenance: { artifact_sha256: src.provenance.artifact_sha256, locator: src.provenance.locator, report: 'prepaid_homeowners' } } };
      arRows.push(row); priorOwner.push(row); continue;
    }
    const p = propByAcct.get(acct);
    if (!p) { arProblems.push({ line_no: l.line_no, kind: l.kind, problem: 'source account is not a Trusted property account', amount_cents: l.amount_cents }); continue; }
    const open = tenuresOf(p.id).filter((t) => !t.end_date);
    if (open.length !== 1) { arProblems.push({ line_no: l.line_no, problem: `property has ${open.length} current owner tenures`, amount_cents: l.amount_cents }); continue; }
    arRows.push({ property_id: p.id, vantaca_account_id: acct, tenure_id: open[0].id, prior_owner: false, transaction_date: cutoff, txn_type: isPrepaid ? 'credit' : 'balance_brought_forward',
      charge_category: isPrepaid ? 'credit' : categorizeChargeDescription(chargeType, { amount_cents: Number(l.amount_cents) }), amount_cents: Number(l.amount_cents),
      description: `Opening balance ${cutoff} (${chargeType})`, source_line_no: l.line_no, source_charge_type: chargeType, raw_row: { source: 'conversion', batch_code: code } });
  }
  if (arRows.length && !ctx.management_company_id) arProblems.push({ problem: 'the community has no management company (the homeowner-ledger batch needs one)' });
  controls.push(ctl('preflight.ar_rows_resolved', 'Every homeowner-ledger opening row resolves: current owners to their lot and current tenure; prior owners to their own source account (no tenure; lot only when the source prints it)', arProblems, { blocked: true }));
  const tbOf = (a) => sourceTb.get(a) || 0; const arA = roles.ar_account || '1300'; const ppA = roles.prepaid_account || '2400';
  // Execute-time totals (488 verifies these over ALL rows): every receivable row; current-owner
  // credits; every prior-owner credit (prepaid-report former owners + aging former-owner refunds).
  const arSum = arRows.filter((r) => r.txn_type !== 'credit').reduce((t, r) => t + r.amount_cents, 0);
  const ppCurrent = arRows.filter((r) => r.txn_type === 'credit' && !r.prior_owner).reduce((t, r) => t + r.amount_cents, 0);
  const ppPrior = priorOwner.filter((r) => r.txn_type === 'credit').reduce((t, r) => t + r.amount_cents, 0);
  // GL tie-outs, each subledger to its own account.
  const curAr = arRows.filter((r) => r.txn_type !== 'credit' && !r.prior_owner).reduce((t, r) => t + r.amount_cents, 0);
  const ppPriorPrepaid = priorOwner.filter((r) => r.txn_type === 'credit' && !formerAgingRows.includes(r) && !(r.raw_row && r.raw_row.prior_owner && r.raw_row.prior_owner.route)).reduce((t, r) => t + r.amount_cents, 0);
  controls.push(ctl('preflight.ar_subledger_ties_to_gl', `Current-owner homeowner-ledger receivables equal GL ${arA} at the cutoff`, curAr === tbOf(arA) ? [] : [{ ledger_cents: curAr, gl_cents: tbOf(arA) }], { left: curAr, right: tbOf(arA) }));
  controls.push(ctl('preflight.prepaid_subledger_ties_to_gl', `Current-owner prepaids + prior-owner prepaid credits equal GL ${ppA} at the cutoff`, ppCurrent + ppPriorPrepaid === tbOf(ppA) ? [] : [{ current_owner_cents: ppCurrent, prior_owner_cents: ppPriorPrepaid, gl_cents: tbOf(ppA) }], { left: ppCurrent + ppPriorPrepaid, right: tbOf(ppA) }));
  if (formerAgingRows.length || formerAgingKind.size) {
    const want = (k) => (snapshot.lines || []).filter((x) => x.kind === k).reduce((t, x) => t + Number(x.amount_cents), 0);
    const got = (k) => formerAgingRows.filter((r) => r.kind === k).reduce((t, r) => t + r.amount_cents, 0);
    const refundAcct = [...new Set((snapshot.lines || []).filter((x) => x.kind === 'former_owner_refund').map((x) => x.account_code))];
    const bad = [];
    for (const k of ['former_owner_receivable', 'former_owner_refund']) if (got(k) !== want(k)) bad.push({ route: k, rows_cents: got(k), snapshot_cents: want(k) });
    if (refundAcct.length === 1 && got('former_owner_refund') !== tbOf(refundAcct[0])) bad.push({ route: 'former_owner_refund', rows_cents: got('former_owner_refund'), gl_account: refundAcct[0], gl_cents: tbOf(refundAcct[0]) });
    controls.push(ctl('preflight.former_owner_aging_rows_routed', `Former owners in the aging: ${formerAgingRows.filter((r) => r.kind === 'former_owner_receivable').length} receivable row(s) and ${formerAgingRows.filter((r) => r.kind === 'former_owner_refund').length} refund-liability row(s) on their own accounts, equal to the routed amounts (refunds = GL ${refundAcct[0] || '?'})`, bad));
  }
  const other = arRows.filter((r) => r.charge_category === 'other');
  if (other.length) notes.push({ type: 'charge_category_other', text: `${other.length} opening row(s) categorize to "other" under the shared categorizer (${[...new Set(other.map((r) => r.source_charge_type))].sort().join(', ')}). Balances are unaffected.` });
  if (priorOwner.length) {
    const noLot = priorOwner.filter((r) => !r.property_id).length;
    notes.push({ type: 'prior_owner_balances', text: `${priorOwner.length} prior-owner credit(s) ($${(-ppPrior / 100).toFixed(2)}) kept on the prior owners' own source accounts with no tenure and ownership dates not established${noLot ? `; for ${noLot} the source does not establish the lot, so no lot is assigned` : ''}. Never part of a current owner's balance (or a lot's balance when no lot is assigned). Exact lots / tenure dates are historical enrichment (backlog).` });
  }

  // -------------------------------------------------------- open AP invoices
  const apA = roles.ap_account || '2000';
  const apFund = (() => { const a = resolveAcct(apA); return a ? ((fundById.get(a.fund_id) || {}).code || null) : null; })();
  // Vendor identity (generic): the exact name first; otherwise the ONE shared vendor-name
  // normalizer (lib/ap/vendor_name.js: legal suffixes and punctuation dropped) against each
  // ACTIVE vendor's name and dba. Accepted only when exactly one vendor matches; the match
  // method is recorded so a non-exact match is visible in the review package.
  const activeVendors = (ctx.vendors || []).filter((v) => v.is_active !== false);
  const resolveVendor = (sourceName) => {
    const exact = activeVendors.filter((v) => norm(v.name) === norm(sourceName));
    if (exact.length === 1) return { vendor: exact[0], via: 'exact' };
    if (exact.length > 1) return { problem: `vendor matches ${exact.length} Trusted vendors exactly`, candidates: exact.map((v) => v.name) };
    const n = normName(sourceName);
    const byName = activeVendors.filter((v) => n && normName(v.name) === n); const byDba = activeVendors.filter((v) => n && v.dba && normName(v.dba) === n);
    const all = [...new Map([...byName, ...byDba].map((v) => [v.id, v])).values()];
    if (all.length === 1) return { vendor: all[0], via: byName.length ? 'normalized_name' : 'dba' };
    return { problem: `vendor matches ${all.length} Trusted vendors`, candidates: all.map((v) => v.name) };
  };
  const vendorMatches = [];
  const apProblems = []; const apInvoices = [];
  // OPEN AP AT THE CUTOFF THAT TRUSTED ALREADY HOLDS (generic; e.g. Canyon Gate's A-Beautiful
  // Pools invoices, re-entered in Trusted to reissue a voided source check). The source open
  // item is the existing Trusted invoice: it is CARRIED (below, the same once-only checks as a
  // restored invoice), never written a second time.
  const carryCandidates = [];
  for (const l of (snapshot.lines || []).filter((x) => x.kind === 'ap_detail').sort((a, b) => a.line_no - b.line_no)) {
    const srcName = l.detail && l.detail.source_vendor_key; const vk = norm(srcName); const r = resolveVendor(srcName);
    const inv = (l.detail && l.detail.invoice_number) || null; const amt = -Number(l.amount_cents);
    if (!r.vendor) { apProblems.push({ line_no: l.line_no, problem: r.problem, ...(r.candidates.length ? { candidates: r.candidates } : {}) }); continue; }
    if (r.via !== 'exact') vendorMatches.push({ source_vendor: srcName, vendor_id: r.vendor.id, vendor: r.vendor.name, via: r.via, line_no: l.line_no });
    if (!d10(l.detail && l.detail.invoice_date)) { apProblems.push({ line_no: l.line_no, problem: 'the source prints no invoice date' }); continue; }
    if (!(amt > 0)) { apProblems.push({ line_no: l.line_no, problem: 'an open invoice must be a positive amount owed', amount_cents: amt }); continue; }
    const existing = inv ? (trusted.ap_invoices || []).filter((x) => x.vendor_id === r.vendor.id && String(x.vendor_invoice_number || '').trim() === String(inv).trim() && !x.voided_at) : [];
    if (existing.length) { carryCandidates.push({ line: l, vendor: r.vendor, inv: String(inv).trim(), amt, origin: 'source_open_item' }); continue; }
    apInvoices.push({ vendor_id: r.vendor.id, vendor_invoice_number: inv, invoice_date: d10(l.detail && l.detail.invoice_date), subtotal_cents: amt, total_cents: amt, amount_paid_cents: 0, status: 'approved',
      posting_journal_entry_reference: apFund ? `${code}-OPEN-${apFund}` : null, idempotency_key: `${code}:${snapshot.sha256}:${vk}|${inv || d10(l.detail && l.detail.invoice_date)}|${(amt / 100).toFixed(2)}`, source_line_no: l.line_no });
  }
  controls.push(ctl('preflight.ap_invoices_resolved', 'Every invoice open at the cutoff resolves to exactly one active Trusted vendor (exact name, else the shared normalizer on name / dba)', apProblems, { blocked: true }));

  // RESTORED OPEN AP (Ed 2026-10-07; Canyon Gate / Star Protection). An approved opening
  // correction put these invoices back into AP at the cutoff because the source booked a
  // payment that never left the bank. Each is carried as the EXISTING Trusted invoice,
  // never a second one, and the books must show it exactly once:
  //   expense  its pre-cutoff Trusted entry is neutralized or superseded (the expense is the
  //            source's), or posts nothing net (e.g. an AP-to-AP reissue entry);
  //   AP       it is open at the cutoff inside the opening AP balance;
  //   cash     no payment on/before the cutoff; only the post-cutoff Trusted payments pay it.
  for (const l of (snapshot.lines || []).filter((x) => x.kind === 'ap_detail_restored').sort((a, b) => a.line_no - b.line_no)) {
    const srcName = l.detail && l.detail.source_vendor_key; const r = resolveVendor(srcName);
    const inv = String((l.detail && l.detail.invoice_number) || '').trim(); const amt = -Number(l.amount_cents);
    if (!r.vendor) { carryCandidates.push({ line: l, problem: r.problem, inv, amt, origin: 'restored' }); continue; }
    if (r.via !== 'exact') vendorMatches.push({ source_vendor: srcName, vendor_id: r.vendor.id, vendor: r.vendor.name, via: r.via, line_no: l.line_no });
    carryCandidates.push({ line: l, vendor: r.vendor, inv, amt, origin: 'restored' });
  }
  const carried = []; const carriedProblems = [];
  const neutralizedOrSuperseded = (id) => neutralize.has(id) || supersede.has(id);
  const postsNothing = (id) => { const m = new Map(); for (const ln of linesByJe.get(id) || []) m.set(ln.account_id, (m.get(ln.account_id) || 0) + net(ln)); return (linesByJe.get(id) || []).length > 0 && [...m.values()].every((v) => v === 0); };
  for (const c of carryCandidates) {
    const l = c.line; const inv = c.inv; const amt = c.amt;
    if (c.problem) { carriedProblems.push({ line_no: l.line_no, invoice: inv, problem: c.problem }); continue; }
    const hits = (trusted.ap_invoices || []).filter((x) => x.vendor_id === c.vendor.id && String(x.vendor_invoice_number || '').trim() === inv && !x.voided_at);
    if (hits.length !== 1) { carriedProblems.push({ line_no: l.line_no, invoice: inv, problem: `${hits.length} Trusted invoices carry this vendor invoice number (exactly one is required)` }); continue; }
    const x = hits[0];
    if (Number(x.total_cents) !== amt) { carriedProblems.push({ line_no: l.line_no, invoice: inv, problem: `Trusted invoice total ${x.total_cents} differs from the source open amount ${amt}` }); continue; }
    if (!(d10(x.invoice_date) <= cutoff)) { carriedProblems.push({ line_no: l.line_no, invoice: inv, problem: `the Trusted invoice is dated ${d10(x.invoice_date)}, after the cutoff` }); continue; }
    const je = x.posting_journal_entry_id;
    if (!je || !preCutJe(je) || !(neutralizedOrSuperseded(je) || postsNothing(je))) {
      carriedProblems.push({ line_no: l.line_no, invoice: inv, problem: 'its pre-cutoff Trusted entry is neither neutralized nor net zero (the expense would be counted twice)', je: je || null }); continue;
    }
    const apps = (apApplications || []).filter((a) => a.invoice_id === x.id).map((a) => { const p = (trusted.ap_payments || []).find((y) => y.id === a.payment_id) || {}; return { payment_id: a.payment_id, check_number: p.check_number || null, payment_date: d10(p.payment_date), applied_cents: Number(a.applied_cents), payment_je: p.posting_journal_entry_id || null }; });
    const early = apps.filter((a) => !a.payment_date || a.payment_date <= cutoff);
    if (early.length) { carriedProblems.push({ line_no: l.line_no, invoice: inv, problem: 'a Trusted payment on/before the cutoff is applied (the invoice was not open at the cutoff)', payments: early }); continue; }
    if (repost.has(je)) { carriedProblems.push({ line_no: l.line_no, invoice: inv, problem: 'its entry is also re-posted after the cutover (the expense and AP would be counted twice)' }); continue; }
    const paidAfter = apps.reduce((t, a) => t + a.applied_cents, 0);
    carried.push({ invoice_id: x.id, vendor_id: x.vendor_id, vendor_invoice_number: inv, invoice_date: d10(x.invoice_date), total_cents: amt, source_line_no: l.line_no, origin: c.origin,
      entry: { je, reference: (jeById.get(je) || {}).reference || null, posting_date: d10((jeById.get(je) || {}).posting_date), treatment: neutralize.has(je) ? 'neutralized' : supersede.has(je) ? 'superseded' : 'posts nothing net' },
      paid_after_cutoff: apps, paid_after_cutoff_cents: paidAfter, open_today_cents: amt - paidAfter });
  }
  for (const c of carried) {
    if (apInvoices.find((a) => a.vendor_id === c.vendor_id && a.vendor_invoice_number === c.vendor_invoice_number)) carriedProblems.push({ line_no: c.source_line_no, invoice: c.vendor_invoice_number, problem: 'a new opening invoice would duplicate the carried Trusted invoice' });
    if (carried.filter((o) => o.invoice_id === c.invoice_id).length > 1) carriedProblems.push({ line_no: c.source_line_no, invoice: c.vendor_invoice_number, problem: 'the same Trusted invoice is carried twice' });
    if (c.paid_after_cutoff_cents > c.total_cents) carriedProblems.push({ line_no: c.source_line_no, invoice: c.vendor_invoice_number, problem: `paid ${c.paid_after_cutoff_cents} after the cutoff, more than the invoice ${c.total_cents} (cash reduced twice)` });
  }
  if (carryCandidates.length) {
    controls.push(ctl('preflight.restored_ap_carried_once', 'Open AP the Trusted books already hold (source open items, or invoices restored by an approved correction) is carried once: the existing Trusted invoice (never a second one), its pre-cutoff entry neutralized or net zero (expense once), no payment on/before the cutoff, paid only after it (cash once)', carriedProblems, { blocked: true }));
  }
  if (vendorMatches.length) notes.push({ type: 'vendor_matched_by_normalized_name', text: `${vendorMatches.length} source vendor name(s) matched a Trusted vendor by the shared normalizer (not exactly): ${[...new Set(vendorMatches.map((m) => `${m.source_vendor} -> ${m.vendor} (${m.via})`))].join('; ')}.`, matches: vendorMatches });
  const carriedCents = carried.reduce((t, c) => t + c.total_cents, 0);
  const apSum = -(apInvoices.reduce((t, r) => t + r.total_cents, 0) + carriedCents);
  controls.push(ctl('preflight.ap_subledger_ties_to_gl', carried.length ? `Open AP invoices (new opening invoices + ${carried.length} carried Trusted invoice(s)) equal GL ${apA} at the cutoff` : `Open AP invoices equal GL ${apA} at the cutoff`, apSum === tbOf(apA) ? [] : [{ invoices_cents: apSum, gl_cents: tbOf(apA) }], { left: apSum, right: tbOf(apA) }));

  // --------------------------------------------------- execute preconditions
  controls.push(ctl('preflight.no_conversion_entries_exist_yet', `No ${code} journal entry exists yet`, (trusted.journal_entries || []).filter((j) => String(j.reference || '').startsWith(code)).map((j) => ({ reference: j.reference })), { blocked: true }));
  const postCut = counted.filter((j) => d10(j.posting_date) >= cutover);
  controls.push(ctl('preflight.post_cutover_activity_untouched', 'No proposed write changes an entry dated on/after the cutover', [...supersede.keys(), ...neutralize.keys()].filter((id) => !preCutJe(id)).map((id) => ({ je: id })), { blocked: true }));
  const fresh = [...(bridge.status === 'PASS' ? [] : [{ problem: `bridge result is ${bridge.status}` }]),
    ...(ctx.current_trusted_fingerprint && bridge.trusted_fingerprint && ctx.current_trusted_fingerprint !== bridge.trusted_fingerprint ? [{ problem: 'Trusted financial activity changed since the bridge result' }] : [])];
  controls.push(ctl('preflight.built_on_current_bridge', 'Built on the current PASS bridge result and the Trusted activity it classified', fresh, { blocked: true }));

  const postFingerprint = sha(postCut.map((j) => [j.id, j.status, Number(j.total_debits_cents || 0), (linesByJe.get(j.id) || []).length]).sort());
  const preconditions = {
    batch_status_in: ['draft', 'staged', 'validated', 'approved'],
    no_journal_entry_reference_prefix: code,
    gl_cutover_date_is: ctx.gl_cutover_date || null,
    trusted_fingerprint_is: bridge.trusted_fingerprint,
    supersede_set: { count: supersede.size, all_status: 'posted', ids_sha256: sha([...supersede.keys()].sort()) },
    neutralize_set: { count: neutralize.size, ids_sha256: sha([...neutralize.keys()].sort()) },
    ar_batches_to_revert: [...revertBatches].sort(([a], [b]) => a.localeCompare(b)).map(([id, v]) => ({ id, status_is: 'committed', rows: v.rows })),
    post_cutover_entries: { count: postCut.length, debits_cents: postCut.reduce((t, j) => t + Number(j.total_debits_cents || 0), 0), fingerprint: postFingerprint },
  };
  const currentTb = new Map(proj);
  for (const j of postCut) for (const l of linesByJe.get(j.id) || []) add(currentTb, accountNumber(l.account_id), net(l));
  for (const j of repostJes) for (const l of j.lines) add(currentTb, l.account_number, l.debit_cents - l.credit_cents);

  const writes = {
    opening_journal_entries: openingJes,
    neutralize_journal_entries: neutralizeJes,
    repost_journal_entries: repostJes,
    supersede_journal_entries: [...supersede].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([id, why]) => ({ id, reference: (jeById.get(id) || {}).reference || null, posting_date: d10((jeById.get(id) || {}).posting_date), prior_status: (jeById.get(id) || {}).status || null, item_no: why.item_no,
      set: { status: 'superseded', superseded_by_conversion: code, superseded_reason: `prior legacy import retired at the ${cutoff} cutover (${code}); replaced by the conversion opening entries` } })),
    revert_ar_batches: [...revertBatches].sort(([a], [b]) => a.localeCompare(b)).map(([id, v]) => ({ id, rows: v.rows, prior_status: 'committed', set: { status: 'reverted', reverted_reason: `prior legacy import retired at the ${cutoff} cutover (${code}); reference only`, replaced_by: `${code}-AR` } })),
    ar_opening_batch: { key: `${code}-AR`, management_company_id: ctx.management_company_id || null, uploaded_by: `conversion:${code}`, period_label: `Conversion opening balances ${cutoff}`, as_of_date: cutoff, source_format: 'manual', status: 'committed',
      rows: arRows, row_count: arRows.length, account_count: new Set(arRows.map((r) => r.vantaca_account_id)).size, receivable_cents: arSum, current_owner_prepaid_cents: ppCurrent, prior_owner_credit_cents: ppPrior },
    ap_opening_invoices: apInvoices,
    ...(builder.applies ? {
      builder_coverage_batch: { key: `${code}-BUILDER`, management_company_id: ctx.management_company_id || null, uploaded_by: `conversion:${code}:builder`, period_label: `Conversion builder assessments through ${cutoff}`,
        as_of_date: cutover, journal_entry_reference: builder.je ? builder.je.reference : null, rows: builder.rows,
        ledger_cents: builder.rows.reduce((s, r) => s + r.ledger_amount_cents, 0), coverage_cents: builder.rows.reduce((s, r) => s + r.base_amount_cents, 0) },
      deferral_schedules: builder.schedule ? [builder.schedule] : [],
      reconciling_items: builder.reconciling_items,
    } : {}),
    cutover_date: { table: 'communities', id: batch.community_id, from: ctx.gl_cutover_date || null, to: cutover },
    conversion_batch: { id: batch.id, set: { status: 'posted' } },
  };
  const summary = {
    opening_journal_entries: openingJes.length, opening_lines: openingJes.reduce((t, j) => t + j.lines.length, 0),
    supersede_journal_entries: supersede.size, neutralize_journal_entries: neutralizeJes.length, repost_journal_entries: repostJes.length,
    revert_ar_batches: revertBatches.size, ar_opening_rows: arRows.length, prior_owner_rows: priorOwner.length, ap_opening_invoices: apInvoices.length,
    ...(carried.length ? { ap_carried_invoices: carried.length } : {}),
    untouched_items: untouched.length, post_cutover_entries_preserved: postCut.length,
    ...(builder.applies ? { builder_coverage_rows: builder.rows.length, builder_ledger_rows: builder.rows.filter((r) => r.ledger_amount_cents !== 0).length,
      deferral_schedules: builder.schedule ? 1 : 0, reconciling_items: builder.reconciling_items.length } : {}),
  };
  const proof_plan = [
    { check: 'cutoff_trial_balance', text: `Trusted TB at ${cutoff} (counted entries) equals the source TB on every account; every other account is zero`, expected: Object.fromEntries([...sourceTb].sort()) },
    { check: 'funds_balance', text: 'Each fund balances at the cutoff' },
    { check: 'current_trial_balance', text: 'Trusted TB through today equals the projected TB (cutoff TB + preserved post-cutover entries + re-posts)', expected: Object.fromEntries([...currentTb].filter(([, v]) => v !== 0).sort()) },
    { check: 'ar_subledger', text: `Committed homeowner ledger at ${cutoff}: receivables = GL ${arA}; current-owner prepaids + prior-owner credits = GL ${ppA}; per account = the snapshot`, expected: { receivable_cents: arSum, current_owner_prepaid_cents: ppCurrent, prior_owner_credit_cents: ppPrior } },
    { check: 'prior_owner_isolation', text: 'No prior-owner row appears in v_current_owner_ledger or in any lot balance it was not assigned to; each appears in v_former_owner_ledger_balances on its own source account', expected: { prior_owner_rows: priorOwner.length, prior_owner_credit_cents: ppPrior } },
    { check: 'ap_as_of_cutoff', text: `AP open as of ${cutoff} (point-in-time) = GL ${apA}`, expected: { ap_cents: apSum, ...(carried.length ? { carried_invoices: carried.length, carried_cents: carriedCents } : {}) } },
    { check: 'post_cutover_preserved', text: 'Every post-cutover entry is unchanged (same ids, status, amounts, line counts)', expected: preconditions.post_cutover_entries },
    { check: 'write_counts', text: 'Exactly the proposed rows were written, nothing else', expected: summary },
    ...(builder.applies ? [{ check: 'builder_coverage', text: `Every resolved builder lot has exactly one conversion coverage period ${builder.rows.length ? `(${builder.rows[0].covered_from.slice(0, 4)}-01-01 or its start through ${cutoff})` : ''}, posted to ${code}-BUILDER; its ledger row equals the entry's AR line; unresolved lots have none and are reconciling items`,
        expected: { rows: builder.rows.length, coverage_cents: builder.rows.reduce((s, r) => s + r.base_amount_cents, 0), ledger_cents: builder.rows.reduce((s, r) => s + r.ledger_amount_cents, 0), unresolved: builder.unresolved.map((u) => u.street_address) } },
      { check: 'deferral_schedule', text: builder.schedule ? `One approved release schedule: ${builder.schedule.balance_account_number} to ${builder.schedule.recognition_account_number}, ${builder.schedule.term_months} months from ${builder.schedule.start_month}, total ${(builder.schedule.recognize_amount_cents / 100).toFixed(2)}` : 'No deferral schedule',
        expected: builder.schedule ? { recognize_amount_cents: builder.schedule.recognize_amount_cents, term_months: builder.schedule.term_months, start_month: builder.schedule.start_month } : null },
      { check: 'reconciling_items', text: 'Each reconciling item is recorded open, once, on this batch', expected: builder.reconciling_items.map((r) => ({ kind: r.kind, item_key: r.item_key, amount_cents: r.amount_cents })) }] : []),
    { check: 'cutover_date', text: `communities.gl_cutover_date = ${cutover}`, expected: cutover },
    { check: 'untouched_tables', text: 'payments, ar_charges, ar_payments, ap_payments and payment applications unchanged (row fingerprints taken just before EXECUTE)' },
  ];
  const rollback = {
    before_commit: 'EXECUTE is ONE database transaction; any failed guard or statement rolls back every write (nothing partial).',
    after_commit: [
      `void (with reversal) every journal entry whose reference starts with ${code}`,
      'restore each superseded entry to its prior status (posted) and clear superseded_*',
      `set each reverted homeowner-ledger batch back to committed; set ${code}-AR to reverted`,
      'void each conversion AP invoice (the conversion never pays one)',
      `restore communities.gl_cutover_date to ${ctx.gl_cutover_date || '(null)'}`,
      'record the reversal as its own audited onboarding event; nothing is deleted',
    ],
  };
  const idempotency = {
    batch_code: code,
    keys: { opening: openingJes.map((j) => j.reference), neutralize: neutralizeJes.map((j) => j.reference), repost: repostJes.map((j) => j.reference), ar_batch: `${code}-AR`, ...(builder.applies ? { builder_batch: `${code}-BUILDER` } : {}), ap_invoices: apInvoices.map((a) => a.idempotency_key) },
    retry_behavior: `EXECUTE refuses unless no journal entry reference starts with ${code}, the conversion batch is not posted, and every precondition still holds (fingerprints included); the approved preflight hash is write-once. A retry after a commit can never post twice; a retry after a rollback re-runs the same writes.`,
  };
  // Carried invoices are NOT writes: the existing Trusted invoices stay exactly as they are.
  return { plan_version: PLAN_VERSION, cutoff, cutover, writes, summary, untouched, preconditions, proof_plan, rollback, idempotency, controls, notes, ...(carried.length ? { carried_ap_invoices: carried } : {}) };
}

module.exports = { buildConversionPlan, PLAN_VERSION, dayAfter };
