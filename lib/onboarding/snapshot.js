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
function validateCorrections(corrections, bal, artifactShas) {
  const problems = []; const out = new Map();
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
    if (problems.length === before) for (const l of ls) out.set(String(l.account), (out.get(String(l.account)) || 0) + Number(l.amount_cents));
  });
  return { problems, moved: out };
}

function buildSnapshot(parsed, { batch_code, cutoff_date, roles = {}, fund_by_account = {}, opening_reclasses = [], opening_corrections = [], artifact_shas = [] } = {}) {
  if (!batch_code || !cutoff_date) throw new Error('snapshot needs batch_code and cutoff_date');
  const id = { batch_code, cutoff_date };
  const lines = []; const controls = []; const components = [];
  const push = (l) => { lines.push(Object.freeze({ line_no: lines.length + 1, ...id, ...l })); };

  // ---- GL opening balances (validated source ending trial balance)
  const bal = of(parsed, 'gl_trial_balance', 'gl_account_balance');
  const shas = new Set(artifact_shas);
  const rc = validateReclasses(opening_reclasses, bal, shas);
  const cc = validateCorrections(opening_corrections, bal, shas);
  const merged = new Map(rc.moved);
  for (const [k, v] of cc.moved) merged.set(k, (merged.get(k) || 0) + v);
  // No adjustment may flip a source account's sign (a correction is not a plug).
  for (const a of bal) {
    const after = a.ending_cents + (merged.get(a.account_code) || 0);
    if (merged.has(a.account_code) && a.ending_cents !== 0 && after !== 0 && Math.sign(after) !== Math.sign(a.ending_cents)) cc.problems.push({ account: a.account_code, problem: `the opening adjustments would flip ${a.account_code} from ${a.ending_cents} to ${after}` });
  }
  const moved = (rc.problems.length || cc.problems.length) ? new Map() : merged;   // a defective reclass or correction moves nothing
  const correctionsFor = (code) => opening_corrections.flatMap((c) => (c.lines || []).filter((l) => String(l.account) === code)
    .map((l) => ({ amount_cents: Number(l.amount_cents), reason: c.reason, approved_by: c.approved_by, approved_at: c.approved_at, evidence: c.evidence })));
  if (!bal.length) {
    components.push({ component: 'gl', status: 'BLOCKED', reason: 'no GL trial balance in the batch', needs: ['gl_trial_balance'] });
    controls.push(C.blocked('snapshot.gl_opening_balances', { label: 'GL opening balances from the source trial balance', reason: 'no GL trial balance', needs: ['gl_trial_balance'] }));
  } else {
    for (const a of bal) {
      const amt = a.ending_cents + (moved.get(a.account_code) || 0);
      const why = opening_reclasses.filter((r) => String(r.from_account) === a.account_code);
      if (amt !== 0) push({ kind: 'gl_opening_balance', component: 'gl', account_code: a.account_code, account_name: a.account_name, fund_code: fund_by_account[a.account_code] || null, amount_cents: amt, provenance: [prov(a)],
        ...(moved.has(a.account_code) ? { source_ending_cents: a.ending_cents, reclassified_cents: moved.get(a.account_code), reclass: why.map((r) => ({ to_account: String(r.to_account), amount_cents: Number(r.amount_cents), reason: r.reason, approved_by: r.approved_by })),
          ...(correctionsFor(a.account_code).length ? { corrections: correctionsFor(a.account_code) } : {}) } : {}) });
    }
    for (const r of opening_reclasses) {
      if (!moved.has(String(r.to_account)) || bal.some((a) => a.account_code === String(r.to_account))) continue;
      const src = bal.find((a) => a.account_code === String(r.from_account));
      push({ kind: 'gl_opening_balance', component: 'gl', account_code: String(r.to_account), account_name: r.to_account_name, fund_code: fund_by_account[String(r.to_account)] || fund_by_account[String(r.from_account)] || null,
        amount_cents: Number(r.amount_cents), source_ending_cents: 0, reclassified_cents: Number(r.amount_cents),
        reclass: [{ from_account: String(r.from_account), amount_cents: Number(r.amount_cents), reason: r.reason, approved_by: r.approved_by, approved_at: r.approved_at, evidence: r.evidence }],
        provenance: [prov(src), { artifact_sha256: r.evidence.artifact_sha256, locator: r.evidence.locator }] });
    }
    // A correction that opens an account the source does not have (rare): its own line.
    for (const c of (moved.size ? opening_corrections : [])) for (const l of c.lines || []) {
      const code = String(l.account);
      if (bal.some((a) => a.account_code === code) || lines.some((x) => x.kind === 'gl_opening_balance' && x.account_code === code)) continue;
      const anchor = bal.find((a) => (c.lines || []).some((o) => String(o.account) === a.account_code));
      push({ kind: 'gl_opening_balance', component: 'gl', account_code: code, account_name: l.account_name, fund_code: fund_by_account[code] || null, amount_cents: moved.get(code), source_ending_cents: 0, reclassified_cents: moved.get(code),
        corrections: correctionsFor(code), provenance: [...(anchor ? [prov(anchor)] : []), { artifact_sha256: c.evidence.artifact_sha256, locator: c.evidence.locator }] });
    }
    const gl = lines.filter((l) => l.kind === 'gl_opening_balance');
    const mism = bal.filter((a) => (a.ending_cents + (moved.get(a.account_code) || 0)) !== 0 && (gl.find((l) => l.account_code === a.account_code) || {}).amount_cents !== a.ending_cents + (moved.get(a.account_code) || 0));
    controls.push(C.holds('snapshot.gl_lines_equal_source_ending_tb', { label: (opening_reclasses.length || opening_corrections.length) ? 'Every proposed GL opening line equals the source ending balance, apart from the documented opening reclassifications / corrections' : 'Every proposed GL opening line equals the source ending balance', failures: mism.map((a) => ({ account: a.account_code })) }));
    if (opening_corrections.length) {
      controls.push(C.holds('snapshot.opening_corrections_documented', { label: `Opening corrections of source errors (${opening_corrections.length}) are sourced, approved, balanced, and flip no account`, failures: cc.problems }));
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
  const subledgerComponent = (component, role, roleLabel, pick, kind, sign) => {
    const code = roles[role];
    if (!code) { components.push({ component, status: 'BLOCKED', reason: `no ${role} role configured` }); controls.push(C.blocked(`snapshot.${component}`, { label: `${roleLabel} detail`, reason: `batch has no ${role} role` })); return; }
    const control = glEnd(code);
    if (control === null) { components.push({ component, status: 'BLOCKED', reason: `GL has no account ${code}` }); controls.push(C.blocked(`snapshot.${component}`, { label: `${roleLabel} detail`, reason: `GL has no account ${code}` })); return; }
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
    const formerRows = component === 'prepaid_detail' ? of(parsed, 'prepaid_homeowners', 'prepaid_credit').filter((p) => p.previous_owner) : [];
    for (const p of formerRows) push({ kind, component, account_code: code, source_account_key: p.source_account_key, amount_cents: -p.amount_cents, former_owner: true, provenance: [prov(p)] });
    const supported = sum(picked, 'ending_cents') - sum(formerRows, 'amount_cents');
    const unsupported = control - supported;           // debit-positive: AR positive, prepaid negative
    if (unsupported === 0) {
      components.push({ component, status: 'PASS', account_code: code, control_cents: control, supported_cents: supported, unsupported_cents: 0, accounts: picked.length, former_owner_accounts: formerRows.length });
      controls.push(C.equals(`snapshot.${component}_supports_gl`, { label: `${roleLabel} detail supports GL ${code}`, left: supported * sign, right: control * sign, leftLabel: 'homeowner detail', rightLabel: `GL ${code}` }));
    } else {
      // Unsupported remainder: reported as its own line, never assigned to an owner, never plugged.
      push({ kind: 'unsupported_detail', component, account_code: code, amount_cents: unsupported, reason: `GL ${code} carries ${(unsupported * sign / 100).toFixed(2)} that the homeowner detail does not support`, provenance: [prov(bal.find((a) => a.account_code === String(code)))] });
      components.push({ component, status: 'BLOCKED', account_code: code, control_cents: control, supported_cents: supported, unsupported_cents: unsupported, accounts: picked.length, former_owner_accounts: formerRows.length, needs: component === 'prepaid_detail' ? ['prepaid_credit_report_including_former_owners'] : ['subledger_detail'] });
      controls.push(Object.freeze({ ...C.blocked(`snapshot.${component}_supports_gl`, { label: `${roleLabel} detail supports GL ${code}`, reason: `unsupported detail ${(unsupported * sign / 100).toFixed(2)} (validated control balance kept; detail missing)`, needs: component === 'prepaid_detail' ? ['prepaid_credit_report_including_former_owners'] : ['subledger_detail'] }),
        left_label: 'homeowner detail', right_label: `GL ${code}`, left_cents: supported * sign, right_cents: control * sign, difference_cents: (supported - control) * sign }));
    }
  };
  subledgerComponent('ar_detail', 'ar_account', 'Homeowner AR', (a) => a.ending_cents > 0, 'ar_detail', 1);
  subledgerComponent('prepaid_detail', 'prepaid_account', 'Homeowner prepaid / credit', (a) => a.ending_cents < 0, 'prepaid_detail', -1);

  // AR aging: buckets and charge-type items behind each AR detail line (when an aging exists)
  if (aging.length) {
    for (const it of agingItems) push({ kind: 'ar_aging_item', component: 'ar_detail', account_code: roles.ar_account || null, source_account_key: it.source_account_key, charge_type: it.charge_type, amount_cents: it.balance_cents,
      buckets: { current_cents: it.current_cents, over_30_cents: it.over_30_cents, over_60_cents: it.over_60_cents, over_90_cents: it.over_90_cents }, provenance: [prov(it)] });
    const ar = lines.filter((l) => l.kind === 'ar_detail');
    const fails = [];
    for (const l of ar) { const g = aging.find((x) => x.source_account_key === l.source_account_key); if (!g || g.balance_cents !== l.amount_cents) fails.push({ account: l.source_account_key, detail_cents: l.amount_cents, aging_cents: g ? g.balance_cents : null }); }
    for (const g of aging) if (!ar.find((l) => l.source_account_key === g.source_account_key)) fails.push({ account: g.source_account_key, detail_cents: null, aging_cents: g.balance_cents });
    controls.push(C.holds('snapshot.ar_detail_matches_aging_by_account', { label: 'Every AR detail line equals its AR aging balance (charge-type items attached)', failures: fails }));
  }

  // ---- AP detail (only when an AP source exists; no plug otherwise)
  const ap = of(parsed, 'ap_aging', 'ap_open_item');
  const apCode = roles.ap_account;
  if (apCode) {
    const control = glEnd(apCode);
    if (!ap.length) {
      components.push({ component: 'ap_detail', status: 'BLOCKED', account_code: apCode, control_cents: control, supported_cents: 0, unsupported_cents: control, needs: ['ap_aging'], reason: 'no AP detail source in the batch' });
      if (control) push({ kind: 'unsupported_detail', component: 'ap_detail', account_code: apCode, amount_cents: control, reason: 'no AP detail source (AP aging) in the batch', provenance: [prov(bal.find((a) => a.account_code === String(apCode)))] });
      controls.push(Object.freeze({ ...C.blocked('snapshot.ap_detail_supports_gl', { label: `AP detail supports GL ${apCode}`, reason: 'no AP aging in the batch (validated control balance kept)', needs: ['ap_aging'] }), right_label: `GL ${apCode}`, right_cents: control === null ? null : -control }));
    } else {
      for (const it of ap) push({ kind: 'ap_detail', component: 'ap_detail', account_code: apCode, source_vendor_key: it.source_vendor_key, invoice_number: it.invoice_number, invoice_date: it.invoice_date, amount_cents: -it.amount_cents, provenance: [prov(it)] });
      controls.push(C.equals('snapshot.ap_detail_supports_gl', { label: `AP detail supports GL ${apCode}`, left: sum(ap, 'amount_cents'), right: control === null ? null : -control, leftLabel: 'AP detail', rightLabel: `GL ${apCode}` }));
      const apUnsupported = (control || 0) + sum(ap, 'amount_cents');      // AP is credit (negative) in GL
      if (apUnsupported) push({ kind: 'unsupported_detail', component: 'ap_detail', account_code: apCode, amount_cents: apUnsupported, reason: `GL ${apCode} and the AP aging differ by ${(Math.abs(apUnsupported) / 100).toFixed(2)}`, provenance: [prov(bal.find((a) => a.account_code === String(apCode)))] });
      components.push({ component: 'ap_detail', status: apUnsupported === 0 ? 'PASS' : 'BLOCKED', account_code: apCode, control_cents: control, supported_cents: -sum(ap, 'amount_cents'), unsupported_cents: apUnsupported, invoices: ap.length });
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
