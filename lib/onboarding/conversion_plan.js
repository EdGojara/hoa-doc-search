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

const PLAN_VERSION = '2026-10-04.1';
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
 *   source    { prepaid_rows: [{ source_account_key, amount_cents, previous_owner, provenance: { artifact_sha256, locator, raw } }] }
 *   trusted   read-only loader output .trusted (journal_entries, journal_entry_lines, ap_invoices, homeowner_transactions, ...)
 *   ctx       { accounts: [{ id, account_number, fund_id, vantaca_account_number }], funds: [{ id, code }], properties: [{ id, vantaca_account_id, street_address }],
 *               tenures: [{ id, property_id, kind, start_date, end_date }], vendors: [{ id, name }], gl_cutover_date, current_trusted_fingerprint,
 *               periods: [{ id, period_start, period_end, status }], management_company_id }
 */
function buildConversionPlan({ batch, snapshot, bridge, decisions = [], source = {}, trusted, ctx }) {
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
      } else if (dec.choice_key === 'already_in_legacy_books') {
        for (const id of jes) if (preCutJe(id)) neutralize.set(id, { ...why, because: 'owner decision: already in the legacy books' });
      } else noTreatment.push({ ...why, problem: `decision ${dec.choice_key} has no conversion treatment in this milestone` });
    } else if (it.classification === 'LEGITIMATE_SUBSEQUENT') {
      for (const id of jes) if (preCutJe(id)) { neutralize.set(id, { ...why, because: 'subsequent activity dated before the cutover' }); repost.set(id, { ...why, because: 'subsequent activity dated before the cutover' }); }
      untouched.push({ ...why, reason: 'post-cutoff activity preserved', records: recs.length });
    } else untouched.push({ ...why, reason: 'out of scope (no money moved / nets to zero)', records: recs.length });
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
  const arSum = arRows.filter((r) => r.txn_type !== 'credit').reduce((t, r) => t + r.amount_cents, 0);
  const ppCurrent = arRows.filter((r) => r.txn_type === 'credit' && !r.prior_owner).reduce((t, r) => t + r.amount_cents, 0);
  const ppPrior = priorOwner.reduce((t, r) => t + r.amount_cents, 0);
  controls.push(ctl('preflight.ar_subledger_ties_to_gl', `Homeowner-ledger receivables equal GL ${arA} at the cutoff`, arSum === tbOf(arA) ? [] : [{ ledger_cents: arSum, gl_cents: tbOf(arA) }], { left: arSum, right: tbOf(arA) }));
  controls.push(ctl('preflight.prepaid_subledger_ties_to_gl', `Current-owner prepaids + prior-owner credits equal GL ${ppA} at the cutoff`, ppCurrent + ppPrior === tbOf(ppA) ? [] : [{ current_owner_cents: ppCurrent, prior_owner_cents: ppPrior, gl_cents: tbOf(ppA) }], { left: ppCurrent + ppPrior, right: tbOf(ppA) }));
  const other = arRows.filter((r) => r.charge_category === 'other');
  if (other.length) notes.push({ type: 'charge_category_other', text: `${other.length} opening row(s) categorize to "other" under the shared categorizer (${[...new Set(other.map((r) => r.source_charge_type))].sort().join(', ')}). Balances are unaffected.` });
  if (priorOwner.length) {
    const noLot = priorOwner.filter((r) => !r.property_id).length;
    notes.push({ type: 'prior_owner_balances', text: `${priorOwner.length} prior-owner credit(s) ($${(-ppPrior / 100).toFixed(2)}) kept on the prior owners' own source accounts with no tenure and ownership dates not established${noLot ? `; for ${noLot} the source does not establish the lot, so no lot is assigned` : ''}. Never part of a current owner's balance (or a lot's balance when no lot is assigned). Exact lots / tenure dates are historical enrichment (backlog).` });
  }

  // -------------------------------------------------------- open AP invoices
  const apA = roles.ap_account || '2000';
  const apFund = (() => { const a = resolveAcct(apA); return a ? ((fundById.get(a.fund_id) || {}).code || null) : null; })();
  const apProblems = []; const apInvoices = [];
  for (const l of (snapshot.lines || []).filter((x) => x.kind === 'ap_detail').sort((a, b) => a.line_no - b.line_no)) {
    const vk = norm(l.detail && l.detail.source_vendor_key); const hits = (ctx.vendors || []).filter((v) => norm(v.name) === vk);
    const inv = (l.detail && l.detail.invoice_number) || null; const amt = -Number(l.amount_cents);
    if (hits.length !== 1) { apProblems.push({ line_no: l.line_no, problem: `vendor matches ${hits.length} Trusted vendors` }); continue; }
    if (!d10(l.detail && l.detail.invoice_date)) { apProblems.push({ line_no: l.line_no, problem: 'the source prints no invoice date' }); continue; }
    if (!(amt > 0)) { apProblems.push({ line_no: l.line_no, problem: 'an open invoice must be a positive amount owed', amount_cents: amt }); continue; }
    if (inv && (trusted.ap_invoices || []).some((x) => x.vendor_id === hits[0].id && x.vendor_invoice_number === inv && !x.voided_at)) { apProblems.push({ line_no: l.line_no, problem: 'this vendor invoice number already exists in Trusted', invoice: inv }); continue; }
    apInvoices.push({ vendor_id: hits[0].id, vendor_invoice_number: inv, invoice_date: d10(l.detail && l.detail.invoice_date), subtotal_cents: amt, total_cents: amt, amount_paid_cents: 0, status: 'approved',
      posting_journal_entry_reference: apFund ? `${code}-OPEN-${apFund}` : null, idempotency_key: `${code}:${snapshot.sha256}:${vk}|${inv || d10(l.detail && l.detail.invoice_date)}|${(amt / 100).toFixed(2)}`, source_line_no: l.line_no });
  }
  controls.push(ctl('preflight.ap_invoices_resolved', 'Every invoice open at the cutoff resolves to one Trusted vendor and is not already in Trusted', apProblems, { blocked: true }));
  const apSum = -apInvoices.reduce((t, r) => t + r.total_cents, 0);
  controls.push(ctl('preflight.ap_subledger_ties_to_gl', `Open AP invoices equal GL ${apA} at the cutoff`, apSum === tbOf(apA) ? [] : [{ invoices_cents: apSum, gl_cents: tbOf(apA) }], { left: apSum, right: tbOf(apA) }));

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
    cutover_date: { table: 'communities', id: batch.community_id, from: ctx.gl_cutover_date || null, to: cutover },
    conversion_batch: { id: batch.id, set: { status: 'posted' } },
  };
  const summary = {
    opening_journal_entries: openingJes.length, opening_lines: openingJes.reduce((t, j) => t + j.lines.length, 0),
    supersede_journal_entries: supersede.size, neutralize_journal_entries: neutralizeJes.length, repost_journal_entries: repostJes.length,
    revert_ar_batches: revertBatches.size, ar_opening_rows: arRows.length, prior_owner_rows: priorOwner.length, ap_opening_invoices: apInvoices.length,
    untouched_items: untouched.length, post_cutover_entries_preserved: postCut.length,
  };
  const proof_plan = [
    { check: 'cutoff_trial_balance', text: `Trusted TB at ${cutoff} (counted entries) equals the source TB on every account; every other account is zero`, expected: Object.fromEntries([...sourceTb].sort()) },
    { check: 'funds_balance', text: 'Each fund balances at the cutoff' },
    { check: 'current_trial_balance', text: 'Trusted TB through today equals the projected TB (cutoff TB + preserved post-cutover entries + re-posts)', expected: Object.fromEntries([...currentTb].filter(([, v]) => v !== 0).sort()) },
    { check: 'ar_subledger', text: `Committed homeowner ledger at ${cutoff}: receivables = GL ${arA}; current-owner prepaids + prior-owner credits = GL ${ppA}; per account = the snapshot`, expected: { receivable_cents: arSum, current_owner_prepaid_cents: ppCurrent, prior_owner_credit_cents: ppPrior } },
    { check: 'prior_owner_isolation', text: 'No prior-owner row appears in v_current_owner_ledger or in any lot balance it was not assigned to; each appears in v_former_owner_ledger_balances on its own source account', expected: { prior_owner_rows: priorOwner.length, prior_owner_credit_cents: ppPrior } },
    { check: 'ap_as_of_cutoff', text: `AP open as of ${cutoff} (point-in-time) = GL ${apA}`, expected: { ap_cents: apSum } },
    { check: 'post_cutover_preserved', text: 'Every post-cutover entry is unchanged (same ids, status, amounts, line counts)', expected: preconditions.post_cutover_entries },
    { check: 'write_counts', text: 'Exactly the proposed rows were written, nothing else', expected: summary },
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
    keys: { opening: openingJes.map((j) => j.reference), neutralize: neutralizeJes.map((j) => j.reference), repost: repostJes.map((j) => j.reference), ar_batch: `${code}-AR`, ap_invoices: apInvoices.map((a) => a.idempotency_key) },
    retry_behavior: `EXECUTE refuses unless no journal entry reference starts with ${code}, the conversion batch is not posted, and every precondition still holds (fingerprints included); the approved preflight hash is write-once. A retry after a commit can never post twice; a retry after a rollback re-runs the same writes.`,
  };
  return { plan_version: PLAN_VERSION, cutoff, cutover, writes, summary, untouched, preconditions, proof_plan, rollback, idempotency, controls, notes };
}

module.exports = { buildConversionPlan, PLAN_VERSION, dayAfter };
