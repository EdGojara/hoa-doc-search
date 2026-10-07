// ============================================================================
// lib/onboarding/snapshot.js  (Issue #15 Milestone 3) — Conversion Snapshot
// ----------------------------------------------------------------------------
// "What would Trusted look like at the cutoff?" A READ-ONLY proposed opening
// position built from the validated source (canonical rows), never from
// existing Trusted balances. Nothing here posts anything.
//
// Output:
//   lines       every proposed row, each with batch/cutoff identity and source
//               provenance (artifact sha256 + locator):
//                 gl_opening_balance   one per source GL account (ending TB)
//                 ar_detail            one per homeowner account with a debit balance
//                 ar_aging_item        charge-type detail behind each AR account (when an aging exists)
//                 prepaid_detail       one per homeowner account with a credit balance
//                 ap_detail            one per open AP item (when an AP source exists)
//                 ap_detail_restored   one per invoice an approved correction puts back into AP
//                 unsupported_detail   the part of a validated control balance that the
//                                      source detail does NOT support: reported, never
//                                      assigned to anyone, never plugged
//   components  gl / ar_detail / prepaid_detail / ap_detail, each PASS or BLOCKED with
//               control balance, supported detail and unsupported remainder
//   controls    the stage's control results (mechanical reconciliation to the source)
//   sha256      canonical hash of lines + components (what a reviewer approves)
//
// Missing detail blocks ONLY the affected component; the GL control balance is
// still proposed exactly as the source has it. Signs: debit-positive cents.
// ============================================================================
const crypto = require('crypto');
const C = require('./controls');
const { canonicalJson } = require('./preflight');

const sum = (rows, k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
const prov = (r) => ({ artifact_sha256: r.provenance.artifact_sha256, locator: r.provenance.locator });
const of = (parsed, type, domain) => ((parsed[type] && parsed[type].rows) || []).filter((r) => r.domain === domain);

// OPENING RECLASSIFICATIONS (Ed 2026-10-07). An owner-approved move of part of a
// source account's ending balance into another account at the cutoff, e.g. Canyon
// Gate's $1,629.70 "14010 Previous Owners Rec. PM" (prior-management balance sheet,
// 10/31/2025) carried inside Vantaca 1300 with no homeowner behind it: 1300 opens at
// the source balance less 1,629.70 and 1310 Legacy Receivable - Previous Owners
// opens at 1,629.70. Preserved, never written off; the total is unchanged.
//
// Each reclass: { from_account, to_account, to_account_name, amount_cents (debit-
// positive, same sign as the from balance), reason, evidence: { description,
// artifact_sha256, locator }, approved_by, approved_at }. It is a documented
// decision, never a plug: the evidence document must be an artifact of this batch,
// the approval must be named, and the amount can never exceed (or flip) the source
// balance. Anything short of that BLOCKS the GL component and moves nothing.
function validateReclasses(reclasses, bal, artifactShas) {
  const problems = [];
  const out = new Map();   // account -> net cents moved in (+) / out (-)
  reclasses.forEach((r, i) => {
    const at = `opening_reclasses[${i}]`;
    const src = bal.find((a) => a.account_code === String(r.from_account || ''));
    const amt = Number(r.amount_cents);
    if (!src) problems.push({ reclass: at, problem: `from_account ${r.from_account} is not in the source trial balance` });
    if (!r.to_account || String(r.to_account) === String(r.from_account)) problems.push({ reclass: at, problem: 'to_account is required and must differ from from_account' });
    if (bal.some((a) => a.account_code === String(r.to_account) && a.ending_cents !== 0)) problems.push({ reclass: at, problem: `to_account ${r.to_account} already carries a source balance` });
    if (!r.to_account_name) problems.push({ reclass: at, problem: 'to_account_name is required' });
    if (!Number.isInteger(amt) || amt === 0) problems.push({ reclass: at, problem: 'amount_cents must be a non-zero integer' });
    else if (src && (Math.sign(amt) !== Math.sign(src.ending_cents) || Math.abs(amt) > Math.abs(src.ending_cents))) problems.push({ reclass: at, problem: `amount ${amt} exceeds or flips the source balance ${src.ending_cents}` });
    if (!r.reason) problems.push({ reclass: at, problem: 'reason is required' });
    if (!r.approved_by || !r.approved_at) problems.push({ reclass: at, problem: 'a named approval (approved_by, approved_at) is required' });
    const ev = r.evidence || {};
    if (!ev.description || !ev.locator) problems.push({ reclass: at, problem: 'evidence needs a description and a locator (where in the document)' });
    if (!ev.artifact_sha256 || !artifactShas.has(ev.artifact_sha256)) problems.push({ reclass: at, problem: 'evidence document is not an artifact of this batch (upload it so the decision is sourced)', needs: ['evidence_document'] });
    if (src && Number.isInteger(amt)) { out.set(src.account_code, (out.get(src.account_code) || 0) - amt); out.set(String(r.to_account), (out.get(String(r.to_account)) || 0) + amt); }
  });
  return { problems, moved: out };
}

// OPENING CORRECTIONS (Ed 2026-10-07). An owner-approved correction of a proven
// SOURCE ERROR, booked in the opening position as explicit balanced lines, e.g.
// Canyon Gate's $24.75: the bank debited a check shortfall once, Vantaca booked it
// twice, so the opening is Dr 1000 Operating Cash 24.75 / Cr 1300 AR 24.75.
// Each correction: { lines: [{ account, account_name?, amount_cents (debit-
// positive) }], reason, evidence: { description, artifact_sha256, locator },
// approved_by, approved_at }. Lines must balance; every account must be in the
// source trial balance (or be named, for a new account); the evidence document
// must be an artifact of the batch; the approval must be named. A correction can
// never flip a source account's sign. Anything short of that moves nothing.
//
// RESTORED OPEN AP (Ed 2026-10-07, Canyon Gate / Star Protection). A correction that
// credits the AP account because the source booked a payment that never left the bank
// (Vantaca 8680 / 8681, 7/31/2026) names the invoices it puts back into AP at the
// cutoff: open_ap_items [{ vendor, invoice_number, invoice_date, amount_cents (> 0) }].
// They must add up to exactly the correction's credit to the AP account. They become
// AP detail at the cutoff (kind ap_detail_restored); the reconciliation step carries
// the EXISTING Trusted invoices for them (never a second invoice).
function validateRestoredAp(c, at, apCode, cutoff, problems) {
  const items = c.open_ap_items;
  if (items === undefined) return [];
  if (!Array.isArray(items) || !items.length) { problems.push({ correction: at, problem: 'open_ap_items must be a non-empty list when present' }); return []; }
  if (!apCode) { problems.push({ correction: at, problem: 'open_ap_items need the batch AP account role' }); return []; }
  const before = problems.length;
  items.forEach((it, j) => {
    const w = `${at}.open_ap_items[${j}]`; const amt = Number(it && it.amount_cents);
    if (!it || !String(it.vendor || '').trim()) problems.push({ correction: w, problem: 'vendor is required' });
    if (!it || !String(it.invoice_number || '').trim()) problems.push({ correction: w, problem: 'invoice_number is required (the invoice is identified by its number, never by amount)' });
    if (!it || !/^\d{4}-\d{2}-\d{2}$/.test(String(it.invoice_date || '')) || String(it.invoice_date) > cutoff) problems.push({ correction: w, problem: `invoice_date must be a date on or before the cutoff ${cutoff}` });
    if (!Number.isInteger(amt) || amt <= 0) problems.push({ correction: w, problem: 'amount_cents must be a positive integer (an amount owed)' });
  });
  const numbers = items.map((it) => `${String((it && it.vendor) || '').trim().toUpperCase()}|${String((it && it.invoice_number) || '').trim()}`);
  if (new Set(numbers).size !== numbers.length) problems.push({ correction: at, problem: 'an invoice is listed twice in open_ap_items' });
  const apCredit = -(c.lines || []).filter((l) => String(l.account) === String(apCode)).reduce((t, l) => t + (Number(l.amount_cents) || 0), 0);
  const total = items.reduce((t, it) => t + (Number(it && it.amount_cents) || 0), 0);
  if (apCredit !== total) problems.push({ correction: at, problem: `open_ap_items total ${total} must equal the correction's credit to AP ${apCode} (${apCredit})` });
  return problems.length === before ? items.map((it) => ({ vendor: String(it.vendor).trim(), invoice_number: String(it.invoice_number).trim(), invoice_date: String(it.invoice_date), amount_cents: Number(it.amount_cents) })) : [];
}

function validateCorrections(corrections, bal, artifactShas, { apCode = null, cutoff = null } = {}) {
  const problems = []; const out = new Map(); const restored = [];
  corrections.forEach((c, i) => {
    const at = `opening_corrections[${i}]`; const before = problems.length;
    const ls = Array.isArray(c && c.lines) ? c.lines : [];
    if (ls.length < 2) problems.push({ correction: at, problem: 'a correction needs at least two lines' });
    let net = 0;
    for (const l of ls) {
      const amt = Number(l.amount_cents); const acct = String(l.account || '');
      if (!Number.isInteger(amt) || amt === 0) problems.push({ correction: at, problem: `line ${acct}: amount_cents must be a non-zero integer` });
      if (!bal.some((a) => a.account_code === acct) && !l.account_name) problems.push({ correction: at, problem: `account ${acct} is not in the source trial balance and has no account_name` });
      net += Number.isInteger(amt) ? amt : 0;
    }
    if (net !== 0) problems.push({ correction: at, problem: `lines must balance (debits = credits); they net to ${net}` });
    if (!c.reason) problems.push({ correction: at, problem: 'reason is required' });
    if (!c.approved_by || !c.approved_at) problems.push({ correction: at, problem: 'a named approval (approved_by, approved_at) is required' });
    const ev = c.evidence || {};
    if (!ev.description || !ev.locator) problems.push({ correction: at, problem: 'evidence needs a description and a locator (where in the document)' });
    if (!ev.artifact_sha256 || !artifactShas.has(ev.artifact_sha256)) problems.push({ correction: at, problem: 'evidence document is not an artifact of this batch (upload it so the correction is sourced)', needs: ['evidence_document'] });
    const items = validateRestoredAp(c || {}, at, apCode, cutoff, problems);
    if (problems.length === before) {
      for (const l of ls) out.set(String(l.account), (out.get(String(l.account)) || 0) + Number(l.amount_cents));
      for (const it of items) restored.push({ ...it, correction: at, reason: c.reason, approved_by: c.approved_by, approved_at: c.approved_at, evidence: ev });
    }
  });
  return { problems, moved: out, restored };
}

// FORMER-OWNER ROUTING (Ed 2026-10-07). Rows the AR aging marks as PREVIOUS owners
// ("***") are not current homeowners' receivables. Owner-approved routing moves them
// out of the AR account in the opening, by the amounts the aging itself prints:
//   former-owner DEBITS  -> a prior-owner receivable account (e.g. 1310)
//   former-owner CREDITS -> a named refund liability (e.g. 2410 Former Owner Refunds
//                           Payable), one line per former owner; never income, never
//                           written off.
// { receivable_account, receivable_account_name?, refund_account, refund_account_name?,
//   reason, approved_by, approved_at }. Nothing is typed in: the amounts are the aging's.
function validateFormerRouting(routing, bal, aging, roles) {
  const problems = []; const out = new Map();
  if (!routing) return { problems, moved: out, active: false, debits: [], credits: [] };
  const ar = roles.ar_account; const r = routing;
  const exists = (c) => bal.some((a) => a.account_code === String(c));
  if (!ar) problems.push({ problem: 'no ar_account role: nothing to route former owners out of' });
  for (const [k, nameK] of [['receivable_account', 'receivable_account_name'], ['refund_account', 'refund_account_name']]) {
    if (!r[k]) problems.push({ problem: k + ' is required' });
    else if (String(r[k]) === String(ar)) problems.push({ problem: k + ' must differ from the AR account' });
    else if (!exists(r[k]) && !r[nameK]) problems.push({ problem: k + ' ' + r[k] + ' is not in the source trial balance and has no ' + nameK });
  }
  if (r.receivable_account && String(r.receivable_account) === String(r.refund_account)) problems.push({ problem: 'receivable_account and refund_account must differ' });
  if (!r.reason) problems.push({ problem: 'reason is required' });
  if (!r.approved_by || !r.approved_at) problems.push({ problem: 'a named approval (approved_by, approved_at) is required' });
  const former = aging.filter((g) => g.previous_owner);
  const debits = former.filter((g) => g.balance_cents > 0); const credits = former.filter((g) => g.balance_cents < 0);
  if (!problems.length) {
    const d = sum(debits, 'balance_cents'); const c = sum(credits, 'balance_cents');
    if (d) { out.set(String(ar), (out.get(String(ar)) || 0) - d); out.set(String(r.receivable_account), (out.get(String(r.receivable_account)) || 0) + d); }
    if (c) { out.set(String(ar), (out.get(String(ar)) || 0) - c); out.set(String(r.refund_account), (out.get(String(r.refund_account)) || 0) + c); }
  }
  return { problems, moved: out, active: !problems.length, debits, credits };
}

// FUND ALLOCATIONS (Ed 2026-10-07, Canyon Gate). Some sources keep fund on each posting, not
// on each account, so one account's balance can sit in several funds (Vantaca's balance sheet
// prints Operating / Reserve / Adopt a School columns: 1250 and 3050 span funds; 4050 and 5950
// are Operating although Trusted homes them in Adopt a School). An allocation splits ONE
// account's opening across funds by the source's own fund columns:
//   { account, parts: [{ fund_code, amount_cents }], reason, evidence: { description,
//     artifact_sha256, locator }, approved_by, approved_at }
// The parts must add up to the account's opening exactly (nothing is created or moved between
// accounts); the evidence must be a document of the batch; the approval must be named. A
// single part re-homes the whole balance to that fund. Any defect applies NO allocation.
function validateFundAllocations(allocs, openingOf, artifactShas) {
  const problems = []; const byAccount = new Map();
  (allocs || []).forEach((a, i) => {
    const at = `fund_allocations[${i}]`; const before = problems.length; const acct = String((a && a.account) || '');
    const parts = Array.isArray(a && a.parts) ? a.parts : [];
    const opening = openingOf(acct);
    if (opening === null) problems.push({ allocation: at, problem: `account ${acct} has no opening balance in this snapshot` });
    if (byAccount.has(acct)) problems.push({ allocation: at, problem: `account ${acct} is allocated twice` });
    if (!parts.length) problems.push({ allocation: at, problem: 'parts are required' });
    const codes = parts.map((p) => String((p && p.fund_code) || '').trim());
    if (codes.some((c) => !c)) problems.push({ allocation: at, problem: 'every part needs a fund_code' });
    if (new Set(codes).size !== codes.length) problems.push({ allocation: at, problem: 'a fund appears twice' });
    if (parts.some((p) => !Number.isInteger(Number(p && p.amount_cents)) || Number(p.amount_cents) === 0)) problems.push({ allocation: at, problem: 'every part needs a non-zero integer amount_cents' });
    const total = parts.reduce((t, p) => t + (Number(p && p.amount_cents) || 0), 0);
    if (opening !== null && total !== opening) problems.push({ allocation: at, problem: `parts total ${total} must equal the account's opening ${opening}` });
    if (!a || !a.reason) problems.push({ allocation: at, problem: 'reason is required' });
    if (!a || !a.approved_by || !a.approved_at) problems.push({ allocation: at, problem: 'a named approval (approved_by, approved_at) is required' });
    const ev = (a && a.evidence) || {};
    if (!ev.description || !ev.locator) problems.push({ allocation: at, problem: 'evidence needs a description and a locator (the fund columns in the source)' });
    if (!ev.artifact_sha256 || !artifactShas.has(ev.artifact_sha256)) problems.push({ allocation: at, problem: 'evidence document is not an artifact of this batch', needs: ['evidence_document'] });
    if (problems.length === before) byAccount.set(acct, { parts: parts.map((p) => ({ fund_code: String(p.fund_code).trim(), amount_cents: Number(p.amount_cents) })), reason: a.reason, approved_by: a.approved_by, approved_at: a.approved_at, evidence: ev });
  });
  return { problems, byAccount: problems.length ? new Map() : byAccount };
}

function buildSnapshot(parsed, { batch_code, cutoff_date, roles = {}, fund_by_account = {}, opening_reclasses = [], opening_corrections = [], ledger_dispositions = [], former_owner_routing = null, fund_allocations = [], artifact_shas = [] } = {}) {
  if (!batch_code || !cutoff_date) throw new Error('snapshot needs batch_code and cutoff_date');
  const id = { batch_code, cutoff_date };
  const lines = []; const controls = []; const components = [];
  const push = (l) => { lines.push(Object.freeze({ line_no: lines.length + 1, ...id, ...l })); };

  // ---- GL opening balances (validated source ending trial balance)
  const bal = of(parsed, 'gl_trial_balance', 'gl_account_balance');
  const shas = new Set(artifact_shas);
  const rc = validateReclasses(opening_reclasses, bal, shas);
  const cc = validateCorrections(opening_corrections, bal, shas, { apCode: roles.ap_account || null, cutoff: cutoff_date });
  const fr = validateFormerRouting(former_owner_routing, bal, of(parsed, 'ar_aging', 'ar_aging_account'), roles);
  const merged = new Map(rc.moved);
  for (const src of [cc.moved, fr.moved]) for (const [k, v] of src) merged.set(k, (merged.get(k) || 0) + v);
  // No adjustment may flip a source account's sign (a correction is not a plug).
  for (const a of bal) {
    const after = a.ending_cents + (merged.get(a.account_code) || 0);
    if (merged.has(a.account_code) && a.ending_cents !== 0 && after !== 0 && Math.sign(after) !== Math.sign(a.ending_cents)) cc.problems.push({ account: a.account_code, problem: `the opening adjustments would flip ${a.account_code} from ${a.ending_cents} to ${after}` });
  }
  const moved = (rc.problems.length || cc.problems.length || fr.problems.length) ? new Map() : merged;   // a defective reclass, correction or routing moves nothing
  const routed = fr.active && moved.size > 0;
  const openingOf = (code) => { const a = bal.find((x) => x.account_code === code); const v = a ? a.ending_cents + (moved.get(code) || 0) : (moved.has(code) ? moved.get(code) : null); return v === 0 ? null : v; };
  const fa = validateFundAllocations(fund_allocations, openingOf, shas);
  const allocOf = (code) => (fa.byAccount.has(code) ? { fund_allocation: fa.byAccount.get(code) } : {});
  const correctionsFor = (code) => opening_corrections.flatMap((c) => (c.lines || []).filter((l) => String(l.account) === code)
    .map((l) => ({ amount_cents: Number(l.amount_cents), reason: c.reason, approved_by: c.approved_by, approved_at: c.approved_at, evidence: c.evidence })));
  if (!bal.length) {
    components.push({ component: 'gl', status: 'BLOCKED', reason: 'no GL trial balance in the batch', needs: ['gl_trial_balance'] });
    controls.push(C.blocked('snapshot.gl_opening_balances', { label: 'GL opening balances from the source trial balance', reason: 'no GL trial balance', needs: ['gl_trial_balance'] }));
  } else {
    for (const a of bal) {
      const amt = a.ending_cents + (moved.get(a.account_code) || 0);
      const why = opening_reclasses.filter((r) => String(r.from_account) === a.account_code);
      if (amt !== 0) push({ kind: 'gl_opening_balance', component: 'gl', account_code: a.account_code, account_name: a.account_name, fund_code: fund_by_account[a.account_code] || null, amount_cents: amt, provenance: [prov(a)], ...allocOf(a.account_code),
        ...(moved.has(a.account_code) ? { source_ending_cents: a.ending_cents, reclassified_cents: moved.get(a.account_code), reclass: why.map((r) => ({ to_account: String(r.to_account), amount_cents: Number(r.amount_cents), reason: r.reason, approved_by: r.approved_by })),
          ...(correctionsFor(a.account_code).length ? { corrections: correctionsFor(a.account_code) } : {}) } : {}) });
    }
    // Accounts the source does not carry, opened by a reclass, a correction or the former-
    // owner routing: ONE line each, for the total moved in, citing every decision behind it.
    const newCodes = [...moved.keys()].filter((code) => !bal.some((a) => a.account_code === code) && moved.get(code) !== 0).sort();
    for (const code of newCodes) {
      const rcs = opening_reclasses.filter((r) => String(r.to_account) === code);
      const ccs = opening_corrections.filter((c) => (c.lines || []).some((l) => String(l.account) === code));
      const viaRouting = routed && [former_owner_routing.receivable_account, former_owner_routing.refund_account].map(String).includes(code);
      const name = (rcs[0] && rcs[0].to_account_name) || ((ccs[0] && (ccs[0].lines || []).find((l) => String(l.account) === code)) || {}).account_name
        || (viaRouting ? (String(former_owner_routing.receivable_account) === code ? former_owner_routing.receivable_account_name : former_owner_routing.refund_account_name) : null);
      const arBal = bal.find((a) => a.account_code === String(roles.ar_account));
      const provs = [];
      for (const r of rcs) provs.push(prov(bal.find((a) => a.account_code === String(r.from_account))), { artifact_sha256: r.evidence.artifact_sha256, locator: r.evidence.locator });
      for (const c of ccs) { const anchor = bal.find((a) => (c.lines || []).some((o) => String(o.account) === a.account_code)); if (anchor) provs.push(prov(anchor)); provs.push({ artifact_sha256: c.evidence.artifact_sha256, locator: c.evidence.locator }); }
      if (viaRouting) { if (arBal) provs.push(prov(arBal)); for (const g of (String(former_owner_routing.receivable_account) === code ? fr.debits : fr.credits)) provs.push(prov(g)); }
      push({ kind: 'gl_opening_balance', component: 'gl', account_code: code, account_name: name, fund_code: fund_by_account[code] || fund_by_account[String(roles.ar_account)] || null,
        amount_cents: moved.get(code), source_ending_cents: 0, reclassified_cents: moved.get(code), ...allocOf(code),
        ...(rcs.length ? { reclass: rcs.map((r) => ({ from_account: String(r.from_account), amount_cents: Number(r.amount_cents), reason: r.reason, approved_by: r.approved_by, approved_at: r.approved_at, evidence: r.evidence })) } : {}),
        ...(ccs.length ? { corrections: correctionsFor(code) } : {}),
        ...(viaRouting ? { former_owner_routing: { reason: former_owner_routing.reason, approved_by: former_owner_routing.approved_by, approved_at: former_owner_routing.approved_at, accounts: (String(former_owner_routing.receivable_account) === code ? fr.debits : fr.credits).map((g) => g.source_account_key) } } : {}),
        provenance: provs.filter(Boolean) });
    }
    const gl = lines.filter((l) => l.kind === 'gl_opening_balance');
    const mism = bal.filter((a) => (a.ending_cents + (moved.get(a.account_code) || 0)) !== 0 && (gl.find((l) => l.account_code === a.account_code) || {}).amount_cents !== a.ending_cents + (moved.get(a.account_code) || 0));
    controls.push(C.holds('snapshot.gl_lines_equal_source_ending_tb', { label: (opening_reclasses.length || opening_corrections.length) ? 'Every proposed GL opening line equals the source ending balance, apart from the documented opening reclassifications / corrections' : 'Every proposed GL opening line equals the source ending balance', failures: mism.map((a) => ({ account: a.account_code })) }));
    if (former_owner_routing) {
      controls.push(C.holds('snapshot.former_owner_routing', { label: 'Former-owner aging rows routed out of AR (' + fr.debits.length + ' debit(s) to ' + former_owner_routing.receivable_account + ', ' + fr.credits.length + ' credit(s) to ' + former_owner_routing.refund_account + '), owner-approved, by the aging\u2019s own amounts', failures: fr.problems }));
    }
    if (opening_corrections.length) {
      controls.push(C.holds('snapshot.opening_corrections_documented', { label: `Opening corrections of source errors (${opening_corrections.length}) are sourced, approved, balanced, and flip no account`, failures: cc.problems }));
    }
    if (fund_allocations.length) {
      controls.push(C.holds('snapshot.fund_allocations_documented', { label: `Fund allocations (${fund_allocations.length}) split each account's opening by the source's fund columns, exactly, sourced and approved`, failures: fa.problems }));
    }
    if (opening_reclasses.length) {
      const net = [...moved.values()].reduce((s, v) => s + v, 0);
      controls.push(C.holds('snapshot.opening_reclasses_documented', { label: `Opening reclassifications (${opening_reclasses.length}) are sourced, approved, within the source balance, and move nothing in total`,
        failures: [...rc.problems, ...(net !== 0 ? [{ problem: `reclassifications net to ${net}, not 0` }] : [])] }));
    }
    controls.push(C.equals('snapshot.gl_opening_balances_balance', { label: 'Proposed GL opening debits = credits', left: sum(gl.filter((l) => l.amount_cents > 0), 'amount_cents'), right: -sum(gl.filter((l) => l.amount_cents < 0), 'amount_cents'), leftLabel: 'debits', rightLabel: 'credits' }));
    components.push({ component: 'gl', status: 'PASS', accounts: gl.length, debits_cents: sum(gl.filter((l) => l.amount_cents > 0), 'amount_cents') });
  }
  // The control balance a subledger must support is the OPENING balance (after any
  // documented reclass), e.g. 1300 less the legacy previous-owner receivable.
  const glEnd = (code) => { const a = bal.find((x) => x.account_code === String(code)); return a ? a.ending_cents + (moved.get(a.account_code) || 0) : null; };

  // ---- Cutoff identity: every dated source must be as of the batch cutoff
  const dates = [];
  if (parsed.gl_trial_balance && parsed.gl_trial_balance.period) dates.push(['gl_trial_balance', parsed.gl_trial_balance.period.end]);
  if (parsed.balance_sheet) dates.push(['balance_sheet', parsed.balance_sheet.as_of]);
  if (parsed.ar_aging) dates.push(['ar_aging', parsed.ar_aging.as_of]);
  if (parsed.homeowner_transactions && parsed.homeowner_transactions.period) dates.push(['homeowner_transactions', parsed.homeowner_transactions.period.end]);
  controls.push(C.holds('snapshot.sources_as_of_cutoff', { label: `Every dated source report is as of the cutoff ${cutoff_date}`, failures: dates.filter(([, d]) => d !== cutoff_date).map(([t, d]) => ({ artifact_type: t, as_of: d })) }));

  // ---- Homeowner subledger
  const accts = of(parsed, 'homeowner_transactions', 'homeowner_account');
  const aging = of(parsed, 'ar_aging', 'ar_aging_account');
  const agingItems = of(parsed, 'ar_aging', 'ar_aging_item');
  const prepaidRows = of(parsed, 'prepaid_homeowners', 'prepaid_credit');
  // SOURCE AUTHORITY (Ed 2026-10-07). The opening homeowner position comes from the
  // reports that carry the GL's own split: AR from the AR AGING (every account it
  // prints, credit balances and previous owners included) and prepaid from the
  // PREPAID report (current and former owners). Vantaca keeps receivables in AR and
  // prepayments in prepaid GROSS; netting each owner's ledger and sorting it by sign
  // (the old path) mis-states both. The homeowner ledger (transaction history) is a
  // CROSS-CHECK only: it never changes the opening position, and an account where it
  // disagrees is an exception that needs an approved, evidenced disposition. When a
  // source has no aging / no prepaid report, the ledger path below is used unchanged.
  const controlOf = (component, role, roleLabel) => {
    const code = roles[role];
    if (!code) { components.push({ component, status: 'BLOCKED', reason: `no ${role} role configured` }); controls.push(C.blocked(`snapshot.${component}`, { label: `${roleLabel} detail`, reason: `batch has no ${role} role` })); return null; }
    const control = glEnd(code);
    if (control === null) { components.push({ component, status: 'BLOCKED', reason: `GL has no account ${code}` }); controls.push(C.blocked(`snapshot.${component}`, { label: `${roleLabel} detail`, reason: `GL has no account ${code}` })); return null; }
    return { code, control };
  };
  // Compare the supported detail with the GL control balance; a remainder is its own
  // line that names nobody (never plugged).
  const finish = (component, roleLabel, code, control, supported, sign, meta, needs) => {
    const unsupported = control - supported;           // debit-positive: AR positive, prepaid negative
    if (unsupported === 0) {
      components.push({ component, status: 'PASS', account_code: code, control_cents: control, supported_cents: supported, unsupported_cents: 0, ...meta });
      controls.push(C.equals(`snapshot.${component}_supports_gl`, { label: `${roleLabel} detail supports GL ${code}`, left: supported * sign, right: control * sign, leftLabel: 'homeowner detail', rightLabel: `GL ${code}` }));
    } else {
      push({ kind: 'unsupported_detail', component, account_code: code, amount_cents: unsupported, reason: `GL ${code} carries ${(unsupported * sign / 100).toFixed(2)} that the homeowner detail does not support`, provenance: [prov(bal.find((a) => a.account_code === String(code)))] });
      components.push({ component, status: 'BLOCKED', account_code: code, control_cents: control, supported_cents: supported, unsupported_cents: unsupported, ...meta, needs });
      controls.push(Object.freeze({ ...C.blocked(`snapshot.${component}_supports_gl`, { label: `${roleLabel} detail supports GL ${code}`, reason: `unsupported detail ${(unsupported * sign / 100).toFixed(2)} (validated control balance kept; detail missing)`, needs }),
        left_label: 'homeowner detail', right_label: `GL ${code}`, left_cents: supported * sign, right_cents: control * sign, difference_cents: (supported - control) * sign }));
    }
  };
  const subledgerComponent = (component, role, roleLabel, pick, kind, sign) => {
    const c = controlOf(component, role, roleLabel); if (!c) return;
    const { code, control } = c;
    if (!accts.length) {
      components.push({ component, status: 'BLOCKED', account_code: code, control_cents: control, supported_cents: 0, unsupported_cents: control, reason: 'no homeowner subledger source', needs: ['homeowner_transactions'] });
      if (control !== 0) push({ kind: 'unsupported_detail', component, account_code: code, amount_cents: control, reason: 'no homeowner subledger source', provenance: [prov(bal.find((a) => a.account_code === String(code)))] });
      controls.push(C.blocked(`snapshot.${component}_supports_gl`, { label: `${roleLabel} detail supports GL ${code}`, reason: 'missing homeowner subledger', needs: ['homeowner_transactions'] }));
      return;
    }
    const picked = accts.filter(pick);
    for (const a of picked) push({ kind, component, account_code: code, source_account_key: a.source_account_key, amount_cents: a.ending_cents, provenance: [prov(a)] });
    // Previous-owner credits from a prepaid / credit-balance report: their own lines,
    // keyed by the FORMER owner's account (never attached to a current lot or owner).
    const formerRows = component === 'prepaid_detail' ? prepaidRows.filter((p) => p.previous_owner) : [];
    for (const p of formerRows) push({ kind, component, account_code: code, source_account_key: p.source_account_key, amount_cents: -p.amount_cents, former_owner: true, provenance: [prov(p)] });
    finish(component, roleLabel, code, control, sum(picked, 'ending_cents') - sum(formerRows, 'amount_cents'), sign,
      { accounts: picked.length, former_owner_accounts: formerRows.length, source: 'homeowner_ledger' }, component === 'prepaid_detail' ? ['prepaid_credit_report_including_former_owners'] : ['subledger_detail']);
  };
  // AR from the AR aging: one line per account the aging prints (debit, credit and
  // previous-owner rows alike). Previous owners keep their own account key.
  const agingArComponent = () => {
    const c = controlOf('ar_detail', 'ar_account', 'Homeowner AR'); if (!c) return;
    // Routed: AR is the CURRENT owners only; each former owner sits on its own line in the
    // prior-owner receivable or the refund liability (keyed to the former owner's account).
    const inAr = routed ? aging.filter((g) => !g.previous_owner) : aging;
    for (const g of inAr) push({ kind: 'ar_detail', component: 'ar_detail', account_code: c.code, source_account_key: g.source_account_key, amount_cents: g.balance_cents, ...(g.previous_owner ? { former_owner: true } : {}), provenance: [prov(g)] });
    finish('ar_detail', 'Homeowner AR', c.code, c.control, sum(inAr, 'balance_cents'), 1,
      { accounts: inAr.length, former_owner_accounts: inAr.filter((g) => g.previous_owner).length, source: 'ar_aging' }, ['ar_aging']);
    if (routed) {
      for (const [kind, rows, acct] of [['former_owner_receivable', fr.debits, former_owner_routing.receivable_account], ['former_owner_refund', fr.credits, former_owner_routing.refund_account]]) {
        for (const g of rows) push({ kind, component: kind, account_code: String(acct), source_account_key: g.source_account_key, amount_cents: g.balance_cents, former_owner: true, provenance: [prov(g)] });
        components.push({ component: kind, status: 'PASS', account_code: String(acct), accounts: rows.length, amount_cents: sum(rows, 'balance_cents'), source: 'ar_aging' });
      }
    }
  };
  // Prepaid from the prepaid report: one line per credit it prints, current and former owners.
  const prepaidReportComponent = () => {
    const c = controlOf('prepaid_detail', 'prepaid_account', 'Homeowner prepaid / credit'); if (!c) return;
    for (const p of prepaidRows) push({ kind: 'prepaid_detail', component: 'prepaid_detail', account_code: c.code, source_account_key: p.source_account_key, amount_cents: -p.amount_cents, ...(p.previous_owner ? { former_owner: true } : {}), provenance: [prov(p)] });
    finish('prepaid_detail', 'Homeowner prepaid / credit', c.code, c.control, -sum(prepaidRows, 'amount_cents'), -1,
      { accounts: prepaidRows.filter((p) => !p.previous_owner).length, former_owner_accounts: prepaidRows.filter((p) => p.previous_owner).length, source: 'prepaid_report' }, ['prepaid_credit_report_including_former_owners']);
  };
  if (aging.length) agingArComponent();
  else subledgerComponent('ar_detail', 'ar_account', 'Homeowner AR', (a) => a.ending_cents > 0, 'ar_detail', 1);
  if (prepaidRows.length) prepaidReportComponent();
  else subledgerComponent('prepaid_detail', 'prepaid_account', 'Homeowner prepaid / credit', (a) => a.ending_cents < 0, 'prepaid_detail', -1);

  // Ledger CROSS-CHECK (only when the opening came from the aging): every current
  // owner's ledger balance must equal its aging balance less its prepaid credit. A
  // disagreement never changes the opening; it is an exception until an approved,
  // evidenced disposition says the aging governs for that account.
  if (aging.length && !accts.length) {
    components.push({ component: 'ledger_cross_check', status: 'BLOCKED', reason: 'no homeowner ledger to cross-check the aging against', needs: ['homeowner_transactions'] });
    controls.push(C.blocked('snapshot.ledger_cross_check', { label: 'Homeowner ledger = AR aging - prepaid credit for every current owner (cross-check)', reason: 'missing homeowner ledger', needs: ['homeowner_transactions'] }));
  }
  if (aging.length && accts.length) {
    const prepaidBy = new Map(); for (const p of prepaidRows.filter((x) => !x.previous_owner)) prepaidBy.set(p.source_account_key, (prepaidBy.get(p.source_account_key) || 0) + p.amount_cents);
    const agingBy = new Map(aging.map((g) => [g.source_account_key, g]));
    const ledgerBy = new Map(accts.map((a) => [a.source_account_key, a]));
    const exceptions = [];
    for (const a of accts) {
      const g = agingBy.get(a.source_account_key); const pp = prepaidBy.get(a.source_account_key) || 0;
      if (!g && !prepaidRows.length && a.ending_cents < 0) continue;      // a prepaid credit with no prepaid report to check it against
      const expected = (g ? g.balance_cents : 0) - pp;
      if (a.ending_cents !== expected) exceptions.push({ account: a.source_account_key, ledger_cents: a.ending_cents, aging_cents: g ? g.balance_cents : 0, prepaid_cents: pp, difference_cents: a.ending_cents - expected });
    }
    for (const g of aging) if (!g.previous_owner && !ledgerBy.has(g.source_account_key)) exceptions.push({ account: g.source_account_key, ledger_cents: null, aging_cents: g.balance_cents, prepaid_cents: prepaidBy.get(g.source_account_key) || 0, difference_cents: null, problem: 'current-owner aging account has no ledger' });
    const shas2 = new Set(artifact_shas); const resolved = []; const dispProblems = [];
    for (const [i, d] of ledger_dispositions.entries()) {
      const at = `ledger_dispositions[${i}]`; const ex = exceptions.find((e) => e.account === String(d.account || ''));
      const bad = [];
      if (!ex) bad.push(`account ${d.account} has no ledger exception to dispose of`);
      if (d.disposition !== 'aging_governs') bad.push("disposition must be 'aging_governs' (the opening already uses the aging; nothing else is supported)");
      if (!d.reason) bad.push('reason is required');
      if (!d.approved_by || !d.approved_at) bad.push('a named approval (approved_by, approved_at) is required');
      if (!d.evidence || !d.evidence.description || !d.evidence.locator) bad.push('evidence needs a description and a locator');
      if (!d.evidence || !d.evidence.artifact_sha256 || !shas2.has(d.evidence.artifact_sha256)) bad.push('evidence document is not an artifact of this batch');
      if (bad.length) { dispProblems.push(...bad.map((problem) => ({ disposition: at, account: d.account, problem }))); continue; }
      resolved.push({ ...ex, disposition: d.disposition, reason: d.reason, approved_by: d.approved_by, approved_at: d.approved_at, evidence: d.evidence });
    }
    const open = exceptions.filter((e) => !resolved.some((r) => r.account === e.account));
    // Part of what the reviewer approves (hashed): which accounts disagree, which are resolved and by whom.
    components.push({ component: 'ledger_cross_check', status: open.length || dispProblems.length ? 'EXCEPTIONS' : 'PASS', accounts_checked: accts.length,
      exceptions: open.map((e) => ({ account: e.account, ledger_cents: e.ledger_cents, aging_cents: e.aging_cents, prepaid_cents: e.prepaid_cents, difference_cents: e.difference_cents })),
      resolved: resolved.map((r) => ({ account: r.account, difference_cents: r.difference_cents, disposition: r.disposition, approved_by: r.approved_by, approved_at: r.approved_at, evidence_sha256: r.evidence.artifact_sha256 })) });
    controls.push(Object.freeze({ ...C.holds('snapshot.ledger_cross_check', { label: `Homeowner ledger = AR aging - prepaid credit for every current owner (cross-check only; ${resolved.length} exception(s) resolved by approved disposition)`, failures: [...open, ...dispProblems] }), resolved }));
  }

  // AR aging: buckets and charge-type items behind each AR detail line (when an aging exists)
  if (aging.length) {
    for (const it of agingItems) push({ kind: 'ar_aging_item', component: 'ar_detail', account_code: roles.ar_account || null, source_account_key: it.source_account_key, charge_type: it.charge_type, amount_cents: it.balance_cents,
      buckets: { current_cents: it.current_cents, over_30_cents: it.over_30_cents, over_60_cents: it.over_60_cents, over_90_cents: it.over_90_cents }, provenance: [prov(it)] });
    // Routed former owners are on their own lines (receivable / refund), still one per aging account.
    const ar = lines.filter((l) => l.kind === 'ar_detail' || l.kind === 'former_owner_receivable' || l.kind === 'former_owner_refund');
    const fails = [];
    for (const l of ar) { const g = aging.find((x) => x.source_account_key === l.source_account_key); if (!g || g.balance_cents !== l.amount_cents) fails.push({ account: l.source_account_key, detail_cents: l.amount_cents, aging_cents: g ? g.balance_cents : null }); }
    for (const g of aging) if (!ar.find((l) => l.source_account_key === g.source_account_key)) fails.push({ account: g.source_account_key, detail_cents: null, aging_cents: g.balance_cents });
    controls.push(C.holds('snapshot.ar_detail_matches_aging_by_account', { label: 'Every AR detail line equals its AR aging balance (charge-type items attached)', failures: fails }));
  }

  // ---- AP detail (only when an AP source exists; no plug otherwise)
  const ap = of(parsed, 'ap_aging', 'ap_open_item');
  const apCode = roles.ap_account;
  // Invoices an approved correction put back into AP (only when the corrections applied).
  const restoredAp = moved.size ? cc.restored : [];
  if (apCode) {
    const control = glEnd(apCode);
    if (!ap.length && !restoredAp.length) {
      components.push({ component: 'ap_detail', status: 'BLOCKED', account_code: apCode, control_cents: control, supported_cents: 0, unsupported_cents: control, needs: ['ap_aging'], reason: 'no AP detail source in the batch' });
      if (control) push({ kind: 'unsupported_detail', component: 'ap_detail', account_code: apCode, amount_cents: control, reason: 'no AP detail source (AP aging) in the batch', provenance: [prov(bal.find((a) => a.account_code === String(apCode)))] });
      controls.push(Object.freeze({ ...C.blocked('snapshot.ap_detail_supports_gl', { label: `AP detail supports GL ${apCode}`, reason: 'no AP aging in the batch (validated control balance kept)', needs: ['ap_aging'] }), right_label: `GL ${apCode}`, right_cents: control === null ? null : -control }));
    } else {
      for (const it of ap) push({ kind: 'ap_detail', component: 'ap_detail', account_code: apCode, source_vendor_key: it.source_vendor_key, invoice_number: it.invoice_number, invoice_date: it.invoice_date, amount_cents: -it.amount_cents, provenance: [prov(it)] });
      for (const it of restoredAp) push({ kind: 'ap_detail_restored', component: 'ap_detail', account_code: apCode, source_vendor_key: it.vendor, invoice_number: it.invoice_number, invoice_date: it.invoice_date, amount_cents: -it.amount_cents,
        restored_by: { correction: it.correction, reason: it.reason, approved_by: it.approved_by, approved_at: it.approved_at }, provenance: [{ artifact_sha256: it.evidence.artifact_sha256, locator: it.evidence.locator }] });
      const supported = sum(ap, 'amount_cents') + sum(restoredAp, 'amount_cents');
      controls.push(C.equals('snapshot.ap_detail_supports_gl', { label: restoredAp.length ? `AP detail (AP aging + ${restoredAp.length} invoice(s) restored by an approved correction) supports GL ${apCode}` : `AP detail supports GL ${apCode}`, left: supported, right: control === null ? null : -control, leftLabel: 'AP detail', rightLabel: `GL ${apCode}` }));
      const apUnsupported = (control || 0) + supported;      // AP is credit (negative) in GL
      if (apUnsupported) push({ kind: 'unsupported_detail', component: 'ap_detail', account_code: apCode, amount_cents: apUnsupported, reason: `GL ${apCode} and the AP aging differ by ${(Math.abs(apUnsupported) / 100).toFixed(2)}`, provenance: [prov(bal.find((a) => a.account_code === String(apCode)))] });
      components.push({ component: 'ap_detail', status: apUnsupported === 0 ? 'PASS' : 'BLOCKED', account_code: apCode, control_cents: control, supported_cents: -supported, unsupported_cents: apUnsupported, invoices: ap.length, ...(restoredAp.length ? { restored_invoices: restoredAp.length, restored_cents: sum(restoredAp, 'amount_cents') } : {}) });
    }
  } else if (!bal.some((a) => /accounts payable/i.test(a.account_name || ''))) {
    // The source chart has no AP account at all: there is no AP balance to support.
    components.push({ component: 'ap_detail', status: 'NOT_APPLICABLE', reason: 'the source chart has no Accounts Payable account' });
  } else {
    components.push({ component: 'ap_detail', status: 'BLOCKED', reason: 'no ap_account role configured', needs: ['ap_account', 'ap_aging'] });
    controls.push(C.blocked('snapshot.ap_detail_supports_gl', { label: 'AP detail supports GL AP', reason: 'no AP account configured for this batch', needs: ['ap_account', 'ap_aging'] }));
  }

  // ---- Every line carries provenance and identity
  controls.push(C.holds('snapshot.every_line_has_provenance', { label: 'Every proposed line carries batch, cutoff and source provenance', failures: lines.filter((l) => !l.batch_code || !l.cutoff_date || !l.provenance.length || l.provenance.some((p) => !p || !p.artifact_sha256 || !p.locator)).map((l) => ({ line_no: l.line_no })) }));

  const body = { batch_code, cutoff_date, lines, components };
  const sha256 = crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');
  return Object.freeze({ ...body, controls, sha256 });
}

module.exports = { buildSnapshot };
