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

function buildSnapshot(parsed, { batch_code, cutoff_date, roles = {}, fund_by_account = {} } = {}) {
  if (!batch_code || !cutoff_date) throw new Error('snapshot needs batch_code and cutoff_date');
  const id = { batch_code, cutoff_date };
  const lines = []; const controls = []; const components = [];
  const push = (l) => { lines.push(Object.freeze({ line_no: lines.length + 1, ...id, ...l })); };

  // ---- GL opening balances (validated source ending trial balance)
  const bal = of(parsed, 'gl_trial_balance', 'gl_account_balance');
  if (!bal.length) {
    components.push({ component: 'gl', status: 'BLOCKED', reason: 'no GL trial balance in the batch', needs: ['gl_trial_balance'] });
    controls.push(C.blocked('snapshot.gl_opening_balances', { label: 'GL opening balances from the source trial balance', reason: 'no GL trial balance', needs: ['gl_trial_balance'] }));
  } else {
    for (const a of bal) if (a.ending_cents !== 0) push({ kind: 'gl_opening_balance', component: 'gl', account_code: a.account_code, account_name: a.account_name, fund_code: fund_by_account[a.account_code] || null, amount_cents: a.ending_cents, provenance: [prov(a)] });
    const gl = lines.filter((l) => l.kind === 'gl_opening_balance');
    const mism = bal.filter((a) => a.ending_cents !== 0 && (gl.find((l) => l.account_code === a.account_code) || {}).amount_cents !== a.ending_cents);
    controls.push(C.holds('snapshot.gl_lines_equal_source_ending_tb', { label: 'Every proposed GL opening line equals the source ending balance', failures: mism.map((a) => ({ account: a.account_code })) }));
    controls.push(C.equals('snapshot.gl_opening_balances_balance', { label: 'Proposed GL opening debits = credits', left: sum(gl.filter((l) => l.amount_cents > 0), 'amount_cents'), right: -sum(gl.filter((l) => l.amount_cents < 0), 'amount_cents'), leftLabel: 'debits', rightLabel: 'credits' }));
    components.push({ component: 'gl', status: 'PASS', accounts: gl.length, debits_cents: sum(gl.filter((l) => l.amount_cents > 0), 'amount_cents') });
  }
  const glEnd = (code) => { const a = bal.find((x) => x.account_code === String(code)); return a ? a.ending_cents : null; };

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
    const supported = sum(picked, 'ending_cents');
    const unsupported = control - supported;           // debit-positive: AR positive, prepaid negative
    if (unsupported === 0) {
      components.push({ component, status: 'PASS', account_code: code, control_cents: control, supported_cents: supported, unsupported_cents: 0, accounts: picked.length });
      controls.push(C.equals(`snapshot.${component}_supports_gl`, { label: `${roleLabel} detail supports GL ${code}`, left: supported * sign, right: control * sign, leftLabel: 'homeowner detail', rightLabel: `GL ${code}` }));
    } else {
      // Unsupported remainder: reported as its own line, never assigned to an owner, never plugged.
      push({ kind: 'unsupported_detail', component, account_code: code, amount_cents: unsupported, reason: `GL ${code} carries ${(unsupported * sign / 100).toFixed(2)} that the homeowner detail does not support`, provenance: [prov(bal.find((a) => a.account_code === String(code)))] });
      components.push({ component, status: 'BLOCKED', account_code: code, control_cents: control, supported_cents: supported, unsupported_cents: unsupported, accounts: picked.length, needs: component === 'prepaid_detail' ? ['prepaid_credit_report_including_former_owners'] : ['subledger_detail'] });
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
      for (const it of ap) push({ kind: 'ap_detail', component: 'ap_detail', account_code: apCode, source_vendor_key: it.source_vendor_key, amount_cents: -it.amount_cents, provenance: [prov(it)] });
      controls.push(C.equals('snapshot.ap_detail_supports_gl', { label: `AP detail supports GL ${apCode}`, left: sum(ap, 'amount_cents'), right: control === null ? null : -control, leftLabel: 'AP detail', rightLabel: `GL ${apCode}` }));
      components.push({ component: 'ap_detail', status: sum(ap, 'amount_cents') === -control ? 'PASS' : 'BLOCKED', account_code: apCode, control_cents: control, supported_cents: -sum(ap, 'amount_cents') });
    }
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
