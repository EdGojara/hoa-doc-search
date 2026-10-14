// ============================================================================
// lib/budget/contract_review.js — contracts against vendors, invoices and the budget
// (Ed 2026-10-14; Canyon Gate 2027 is the production validation case)
// ----------------------------------------------------------------------------
// The contract ENGINE prices a contract from its terms (lib/contracts/contract_terms,
// one engine; the working forecast and budget basis use it too). This module is the
// review AROUND it, the part that was missing:
//   * every contract is matched to a vendor record, its GL account, its invoices and
//     the draft budget line it should explain;
//   * every recurring vendor charge with NO contract on file is found (a missing
//     document is never read as "no obligation");
//   * expired, expiring, duplicate and unverified contracts, contracts with no invoices,
//     invoices that disagree with the contract, and draft lines that disagree with the
//     contract are reported as exceptions;
//   * each exception has an owner (Kat: accounting and pricing; Emma: vendor records and
//     documents; Amanda: the board and vendor choices) and an action; only those that
//     need a person's or the board's authority are marked as decisions.
// Pure core (reviewContracts) + a read-only loader (loadReviewInput). Writes nothing.
// ============================================================================
const T = require('../contracts/contract_terms');

const int = (n) => Math.round(Number(n) || 0);
const fmt = (c) => `$${(int(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ym = (d) => String(d || '').slice(0, 7);
const normName = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[.,'"()]/g, ' ').replace(/\b(l\s*l\s*c|llc|inc|incorporated|l\s*p|lp|ltd|co|corp|corporation|company|of south texas|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const cv = (xs) => { if (xs.length < 2) return 0; const m = xs.reduce((t, x) => t + x, 0) / xs.length; if (!m) return 0; const v = xs.reduce((t, x) => t + (x - m) ** 2, 0) / xs.length; return Math.sqrt(v) / m; };

const DEFAULTS = { recurring_min_months: 3, recurring_min_annual_cents: 1000000, stable_cv: 0.15, invoice_tolerance: 0.05, line_tolerance_cents: 10000, line_tolerance_pct: 0.01, decision_annual_cents: 2500000 };

/**
 * @param input {
 *   year, as_of (YYYY-MM-DD: invoices on or before it are history),
 *   accounts: [{ id, account_number, account_name, account_type }],
 *   lines: [{ account_id, annual_amount_cents, notes }]   the target year's draft budget
 *   prior_lines: [{ account_id, annual_amount_cents }]      the prior year's approved budget
 *   contracts: vendor_contracts rows (terms + forecast_account_id + vendor_id + verification)
 *   vendors: [{ id, name, is_mud, kind }]
 *   invoices: [{ id, vendor_id, invoice_date, total_cents, status, lines: [{ gl_account_id, amount_cents }], coded_gl_account_id }]
 * }
 */
function reviewContracts(input, opts = {}) {
  const S = { ...DEFAULTS, ...opts };
  const year = Number(input.year);
  const acct = new Map((input.accounts || []).map((a) => [a.id, a]));
  const vend = new Map((input.vendors || []).map((v) => [v.id, v]));
  const byNorm = new Map(); for (const v of input.vendors || []) { const k = normName(v.name); if (k && !byNorm.has(k)) byNorm.set(k, v); }
  const line = new Map((input.lines || []).map((l) => [l.account_id, l]));
  const prior = new Map((input.prior_lines || []).map((l) => [l.account_id, l]));
  const ex = []; const add = (e) => { ex.push({ severity: 'medium', decision: false, ...e }); };
  const label = (id) => { const a = acct.get(id); return a ? `${a.account_number} ${a.account_name}` : '(no GL account)'; };

  // invoice amounts by vendor x account x month (12 months of history before as_of)
  const asOf = String(input.as_of || `${year - 1}-12-31`).slice(0, 10);
  const from = `${year - 2}-${asOf.slice(5, 10)}`;
  const spend = new Map();   // `${vendor}|${account}` -> { vendor_id, account_id, months: Map(ym -> cents), invoices: n }
  for (const inv of input.invoices || []) {
    if (!inv.vendor_id || inv.voided_at || ['void', 'voided', 'rejected'].includes(inv.status)) continue;
    const d = String(inv.invoice_date || '').slice(0, 10); if (!d || d > asOf || d <= from) continue;
    const parts = (inv.lines || []).filter((l) => l.gl_account_id && int(l.amount_cents));
    // one amount per invoice per account (an invoice's lines to the same account are summed first)
    const byAcct = new Map(); for (const l of parts) byAcct.set(l.gl_account_id, (byAcct.get(l.gl_account_id) || 0) + int(l.amount_cents));
    const alloc = parts.length ? [...byAcct.entries()] : (inv.coded_gl_account_id ? [[inv.coded_gl_account_id, int(inv.total_cents)]] : []);
    for (const [aid, c] of alloc) {
      const k = `${inv.vendor_id}|${aid}`; if (!spend.has(k)) spend.set(k, { vendor_id: inv.vendor_id, account_id: aid, months: new Map(), invoices: 0, served: [], amounts: [] });
      // the month SERVED (service period end when the invoice states one, e.g. September service billed
      // in October), else the invoice month
      const m = ym(inv.service_period_end || d);
      const s = spend.get(k); s.months.set(m, (s.months.get(m) || 0) + c); s.invoices += 1; s.served.push(String(inv.service_period_end || d).slice(0, 10)); s.amounts.push(c);
    }
  }

  // ---- contracts
  const contracts = []; const history = [];
  for (const c of input.contracts || []) {
    // An agreement recorded expired, terminated or superseded that ends before the year is history:
    // listed, never priced or reported as an open exception (TXU electricity ended 11/30/2025).
    if (['expired', 'terminated', 'superseded'].includes(c.status) && !(c.end_date && String(c.end_date) >= `${year}-01-01`)) {
      history.push({ id: c.id, vendor_name: c.vendor_name_raw || 'contract', status: c.status, end_date: c.end_date || null, document_id: c.source_document_id || null }); continue;
    }
    const priced = T.contractCostForYear(c, year);
    // Cannot be priced month by month (seasonal schedule, per-visit pricing): never read as $0.
    // At no cost to the association (a revenue-share newsletter): nothing to price or bind.
    const noCost = !priced.annual_cents && !(Number(c.annualized_amount) > 0) && !(Number(c.total_amount) > 0) && !(c.one_time_fees || []).length;
    const uncostable = !noCost && !priced.annual_cents && priced.issues.some((i) => i.code === 'no_periodic_amount');
    const vendor = c.vendor_id ? vend.get(c.vendor_id) : byNorm.get(normName(c.vendor_name_raw)) || null;
    const name = c.vendor_name_raw || (vendor && vendor.name) || 'contract';
    const rec = { id: c.id, vendor_name: name, vendor_id: c.vendor_id || null, matched_vendor: vendor ? { id: vendor.id, name: vendor.name, by: c.vendor_id ? 'record' : 'name' } : null,
      account_id: c.forecast_account_id || null, account: c.forecast_account_id ? label(c.forecast_account_id) : null, document_id: c.source_document_id || null,
      annual_cents: priced.annual_cents, range_high_cents: priced.range_high_cents, months: priced.months, steps: priced.steps, issues: priced.issues,
      verified: !!(c.verified_by || c.verified_at), execution: c.execution_status || null, uncostable, no_cost: noCost,
      document_annual_cents: c.annualized_amount != null && Number(c.annualized_amount) > 0 ? Math.round(Number(c.annualized_amount) * 100) : null };
    contracts.push(rec);
    if (!c.vendor_id && !noCost) add({ code: 'contract_vendor_unlinked', owner: 'emma', account_id: rec.account_id, vendor: name,
      text: `${name}: the contract is not linked to a vendor record${vendor ? ` (it matches "${vendor.name}" by name)` : ' and no vendor record matches its name'}, so its invoices cannot be checked against it.`,
      action: vendor ? `Link the contract to vendor "${vendor.name}".` : `Create the vendor record for ${name} (W-9, remit address) and link the contract.` });
    if (!rec.account_id && !noCost) add({ code: 'contract_unbound', owner: 'kat', vendor: name, text: `${name}: the contract is not bound to a GL account, so it prices no budget line.`, action: 'Bind it to the expense account it is paid from.' });
    if (!rec.verified) add({ code: 'contract_unverified', owner: 'kat', account_id: rec.account_id, vendor: name, severity: 'low',
      text: `${name}: terms not yet verified against the signed document (execution: ${rec.execution || 'unknown'}).`, action: 'Kat checks the extracted terms against the document and marks them verified.' });
    // Ends before the year with nothing contracted in it (fees for work after the term, like an audit of
    // the last year, are an obligation in the year, not an expiry).
    if (c.end_date && String(c.end_date) < `${year}-01-01` && !c.auto_renews && !priced.annual_cents) add({ code: 'contract_expired', owner: 'emma', account_id: rec.account_id, vendor: name, severity: 'high',
      text: `${name}: the contract ${String(c.end_date) < asOf ? 'ended' : 'ends'} ${c.end_date} and does not auto-renew.`, action: 'Obtain the renewal or replacement contract, or confirm the service ends.' });
    if (uncostable) add({ code: 'pricing_uncostable', owner: 'kat', account_id: rec.account_id, vendor: name,
      text: `${name}: the contract states no fixed recurring amount (${Number(c.total_amount) > 0 ? 'a payment schedule rather than a rate' : (c.unit_pricing || []).length ? 'per-unit pricing' : 'no rate stated'}), so it cannot be priced month by month${rec.document_annual_cents ? `; the document's own annual figure is ${fmt(rec.document_annual_cents)}` : ''}.`,
      action: 'Kat confirms the annual cost from the document (schedule total, or rate x expected quantity); until then the line is not revised from this contract.' });
    else if (!noCost) for (const i of priced.issues.filter((x) => ['uncovered_months', 'schedule_before_start', 'no_periodic_amount', 'no_effective_date'].includes(x.code)))
      add({ code: `pricing_${i.code}`, owner: 'kat', account_id: rec.account_id, vendor: name, text: `${name}: ${i.text}`, action: 'Confirm the terms from the document; the amount is flagged until then.' });
    // invoices against the contract (same account, linked or name-matched vendor)
    const vid = rec.vendor_id || (vendor && vendor.id);
    if (vid && rec.account_id) {
      const s = spend.get(`${vid}|${rec.account_id}`);
      const nowRate = priced.rate_at_start_of_year ? Math.round(priced.rate_at_start_of_year.cents / (T.FREQ_MONTHS[priced.rate_at_start_of_year.freq] || 1)) : null;
      if (!s || !s.invoices) {
        // only once a first invoice is overdue: 45 days after the start (UPS began 10/1; 10/14 is too soon)
        if (c.effective_date && (Date.parse(asOf) - Date.parse(String(c.effective_date).slice(0, 10))) / 86400000 > 45) add({ code: 'contract_no_invoices', owner: 'kat', account_id: rec.account_id, vendor: name,
          text: `${name}: no invoices in the last 12 months coded to ${rec.account}, although the contract started ${c.effective_date}.`, action: 'Find where it is being billed (another account or vendor name) or confirm billing has not started.' });
      } else if (nowRate) {
        const recent = [...s.months.entries()].sort().slice(-6).map(([, v]) => v);
        const med = median(recent);
        if (med && Math.abs(med - nowRate) / nowRate > S.invoice_tolerance) add({ code: 'contract_vs_invoice', owner: 'kat', account_id: rec.account_id, vendor: name,
          text: `${name}: invoices to ${rec.account} run ${fmt(med)}/month (median of the last ${recent.length}); the contract rate is ${fmt(nowRate)}/month.`, action: 'Reconcile: a charge outside the contract, a split across accounts, or terms that changed.' });
      }
    }
  }
  // duplicates: two contracts, same vendor and account, overlapping
  const seenPair = new Map();
  for (const r of contracts) { const k = `${normName(r.vendor_name)}|${r.account_id}`; if (seenPair.has(k)) add({ code: 'contract_duplicate', owner: 'kat', account_id: r.account_id, vendor: r.vendor_name, severity: 'high', text: `${r.vendor_name}: two contracts bound to ${r.account}; the line would count the service twice.`, action: 'Keep the one in force; mark the other superseded.' }); else seenPair.set(k, r); }

  // ---- recurring vendor charges with no contract on file
  const contractedVendor = new Set(contracts.map((r) => r.vendor_id || (r.matched_vendor && r.matched_vendor.id)).filter(Boolean));
  const superseded = new Set();   // `${vendor}|${account}` replaced by a contracted vendor
  for (const s of spend.values()) {
    if (contractedVendor.has(s.vendor_id)) continue;
    const v = vend.get(s.vendor_id) || {}; const a = acct.get(s.account_id) || {};
    if (v.is_mud || ['utility', 'government', 'tax', 'mud'].includes(String(v.kind || '').toLowerCase()) || a.account_type !== 'expense') continue;
    const amts = [...s.months.values()]; const total = amts.reduce((t, x) => t + x, 0); const months = amts.length;
    const lastMonth = [...s.months.keys()].sort().pop();
    // billing that stopped when a contracted vendor took over the same account is a replaced vendor
    // REPLACED: its last service ended within 14 days of a contracted vendor's start in the same
    // account, and it has gone quiet for longer than its own billing cycle (Star Protection: weekly
    // invoices, last service 10/3, United Protective from 10/1). A vendor that simply has not billed
    // yet this cycle (Community Controls, every ~7 weeks) is not concluded replaced.
    const dayMs = 86400000; const served = [...new Set(s.served)].sort(); const lastServed = served[served.length - 1];
    const gaps = served.slice(1).map((d, i) => (Date.parse(d) - Date.parse(served[i])) / dayMs).filter((g) => g > 0);
    const cycle = gaps.length ? median(gaps) : 30;
    const quiet = (Date.parse(asOf) - Date.parse(lastServed)) / dayMs > Math.max(1.5 * cycle, 7);
    const successor = quiet && (input.contracts || []).find((c) => c.forecast_account_id === s.account_id && c.effective_date && String(c.effective_date) <= asOf && Math.abs(Date.parse(lastServed) - Date.parse(c.effective_date)) / dayMs <= 14);
    if (successor) {
      superseded.add(`${s.vendor_id}|${s.account_id}`);
      add({ code: 'vendor_superseded', owner: 'kat', account_id: s.account_id, vendor: v.name || s.vendor_id, severity: 'low',
        text: `${v.name || 'A vendor'}: billed ${label(s.account_id)} for service through ${lastServed} (${fmt(total)} in 12 months, billed about every ${Math.round(cycle)} days, none since); the ${successor.vendor_name_raw || 'contracted'} contract took over from ${successor.effective_date}. Not carried into ${year}.`,
        action: 'Confirm the prior vendor\'s final invoice and any termination terms; nothing for the budget.' });
      continue;
    }
    const steady = months >= S.recurring_min_months && cv(amts) <= S.stable_cv;
    if (steady) {
      const monthly = median(amts); const annualized = monthly * 12;
      add({ code: 'missing_contract', owner: 'emma', account_id: s.account_id, vendor: v.name || s.vendor_id, severity: annualized >= S.decision_annual_cents ? 'high' : 'medium',
        text: `${v.name || 'A vendor'}: billed ${label(s.account_id)} a steady ${fmt(monthly)}/month for ${months} months (about ${fmt(annualized)} a year) with no contract on file. That is not evidence there is no obligation.`,
        action: 'Find the agreement (email, shared drive, the vendor) and bring it into trustEd; if there truly is none, ask the vendor for written terms.', annualized_cents: annualized });
    } else if (total >= S.recurring_min_annual_cents) {
      add({ code: 'uncontracted_spend', owner: 'emma', account_id: s.account_id, vendor: v.name || s.vendor_id, severity: 'medium',
        text: `${v.name || 'A vendor'}: ${fmt(total)} billed to ${label(s.account_id)} across ${months} month(s) in irregular amounts, with no contract or engagement letter on file.`,
        action: 'Find the engagement letter, contract or board-approved proposal behind it; one-time projects belong outside the routine budget line.' });
    }
  }

  // ---- each expense line: contract total vs the draft amount; basis
  const by_account = [];
  for (const a of (input.accounts || []).filter((x) => x.account_type === 'expense')) {
    const cs = contracts.filter((r) => r.account_id === a.id);
    const draft = line.get(a.id); const pri = prior.get(a.id);
    const contractTotal = cs.reduce((t, r) => t + int(r.annual_cents), 0);
    const high = cs.some((r) => r.range_high_cents != null) ? cs.reduce((t, r) => t + int(r.range_high_cents != null ? r.range_high_cents : r.annual_cents), 0) : null;
    // continuing uncontracted billing, annualized from its own cycle (median charge x 365 / median days between)
    const annualOf = (s) => { const served = [...new Set(s.served)].sort(); const gaps = served.slice(1).map((d, i) => (Date.parse(d) - Date.parse(served[i])) / 86400000).filter((g) => g > 0); return gaps.length ? Math.round(median(s.amounts) * 365 / median(gaps)) : int(s.amounts.reduce((t, x) => t + x, 0)); };
    const vendorsBilled = [...spend.values()].filter((s) => s.account_id === a.id).map((s) => ({ vendor: (vend.get(s.vendor_id) || {}).name || s.vendor_id, total_cents: [...s.months.values()].reduce((t, x) => t + x, 0), months: s.months.size, annualized_cents: annualOf(s), contracted: contractedVendor.has(s.vendor_id), superseded: superseded.has(`${s.vendor_id}|${s.account_id}`) }));
    const uncontracted = vendorsBilled.filter((v) => !v.contracted && !v.superseded).reduce((t, v) => t + v.total_cents, 0);
    const basis = cs.length ? (uncontracted > 0.1 * (contractTotal || 1) ? 'contract_and_history' : 'contract') : (vendorsBilled.length ? 'historical' : 'allowance');
    const row = { account_id: a.id, account: `${a.account_number} ${a.account_name}`, draft_cents: draft ? int(draft.annual_amount_cents) : null, prior_budget_cents: pri ? int(pri.annual_amount_cents) : null,
      contract_cents: cs.length ? contractTotal : null, contract_high_cents: high, contracts: cs.map((r) => ({ id: r.id, vendor: r.vendor_name, annual_cents: r.annual_cents, range_high_cents: r.range_high_cents })), vendors_billed: vendorsBilled, basis };
    const continuing = vendorsBilled.filter((v) => !v.contracted && !v.superseded);
    const expected = contractTotal + continuing.reduce((t, v) => t + v.annualized_cents, 0);
    row.expected_cents = cs.length ? expected : null; row.continuing_uncontracted = continuing.map((v) => ({ vendor: v.vendor, annualized_cents: v.annualized_cents }));
    const uncost = cs.filter((r) => r.uncostable);
    row.uncostable = uncost.map((r) => ({ vendor: r.vendor_name, document_annual_cents: r.document_annual_cents }));
    if (uncost.length) row.expected_cents = null;   // not computable: never a $0 expectation
    if (cs.length && draft && !uncost.length) {
      const diff = int(draft.annual_amount_cents) - expected;
      if (Math.abs(diff) > Math.max(S.line_tolerance_cents, S.line_tolerance_pct * expected))
        add({ code: 'line_vs_contract', owner: 'kat', account_id: a.id, severity: 'high', text: `${row.account}: the draft line is ${fmt(draft.annual_amount_cents)}; the contract(s) price ${year} at ${fmt(contractTotal)}${high != null && high !== contractTotal ? ` (up to ${fmt(high)} if allowed increases are taken)` : ''}${continuing.length ? ` plus ${fmt(expected - contractTotal)} of continuing uncontracted billing (${continuing.map((v) => v.vendor).join(', ')})` : ''} = ${fmt(expected)}: the draft is ${diff > 0 ? 'over' : 'under'} by ${fmt(Math.abs(diff))}.`,
          action: `Propose a revision of the draft line to ${fmt(expected)}; nothing changes until it is approved.`, proposed_cents: expected });
    }
    // a material line with no contract behind it, whatever its billing history says
    // Utility, MUD and government billing is tariff or levy, not contract (same rule as missing_contract).
    const tariff = (s) => { const v = vend.get(s.vendor_id) || {}; return v.is_mud || ['utility', 'government', 'tax', 'mud'].includes(String(v.kind || '').toLowerCase()); };
    const acctSpend = [...spend.values()].filter((s) => s.account_id === a.id);
    const acctTotal = acctSpend.reduce((t, s) => t + [...s.months.values()].reduce((u, x) => u + x, 0), 0);
    const tariffTotal = acctSpend.filter(tariff).reduce((t, s) => t + [...s.months.values()].reduce((u, x) => u + x, 0), 0);
    if (!cs.length && draft && int(draft.annual_amount_cents) >= S.decision_annual_cents && !(acctTotal && tariffTotal / acctTotal >= 0.8)) {
      // name only the vendors that carry the line (a $2 miscoded charge does not)
      const billed = vendorsBilled.filter((v) => !v.superseded && v.total_cents >= 0.05 * int(draft.annual_amount_cents));
      add({ code: 'material_line_no_contract', owner: 'amanda', account_id: a.id, severity: 'medium',
        text: `${row.account}: ${fmt(draft.annual_amount_cents)} in the ${year} draft with no contract on file${billed.length ? ` (billed by ${billed.map((v) => v.vendor).join(', ')})` : ' and no vendor billing in the last 12 months'}.`,
        action: 'Amanda confirms the vendor and terms for the year (contract, renewal or board choice) so the line rests on an agreement, not history.' });
    }
    by_account.push(row);
  }
  // decisions: what needs a person's or the board's authority, consolidated
  // One finding per account and vendor: the most specific wins (a steady uncontracted charge over a
  // material line with no contract over irregular uncontracted spend).
  { const rank = { missing_contract: 3, material_line_no_contract: 2, uncontracted_spend: 1 };
    const best = new Map(); for (const e of ex) if (rank[e.code]) { const k = e.account_id; if (!best.has(k) || rank[e.code] > rank[best.get(k).code]) best.set(k, e); }
    for (let i = ex.length - 1; i >= 0; i--) { const e = ex[i]; if (rank[e.code] && best.get(e.account_id) !== e && !(e.code === 'missing_contract' && best.get(e.account_id).code === 'missing_contract')) ex.splice(i, 1); } }
  // Only what needs a person's or the board's authority: revising a draft line, an expired agreement.
  for (const e of ex) if (['line_vs_contract', 'contract_expired'].includes(e.code)) e.decision = true;
  const order = { high: 0, medium: 1, low: 2 };
  ex.sort((x, y) => (order[x.severity] - order[y.severity]) || String(x.code).localeCompare(String(y.code)));
  const summary = { contracts: contracts.length, accounts: by_account.length, by_basis: by_account.reduce((o, r) => ((o[r.basis] = (o[r.basis] || 0) + 1), o), {}), exceptions: ex.length, decisions: ex.filter((e) => e.decision).length,
    by_owner: ex.reduce((o, e) => ((o[e.owner] = (o[e.owner] || 0) + 1), o), {}) };
  return { year, as_of: asOf, contracts, history, by_account, exceptions: ex, summary };
}

// Read-only loader for one community and target year.
async function loadReviewInput(supabase, { community_id, year, as_of }) {
  const { fetchAllQuery } = require('../db/fetch_all');
  const must = async (q, w) => { const { data, error } = await q; if (error) throw new Error(`${w}: ${error.message}`); return data || []; };
  const accounts = await must(supabase.from('chart_of_accounts').select('id, account_number, account_name, account_type').eq('community_id', community_id).limit(2000), 'accounts');
  const budgets = await must(supabase.from('community_budgets').select('id, fiscal_year, status').eq('community_id', community_id).in('fiscal_year', [year, year - 1]), 'budgets');
  const target = budgets.find((b) => b.fiscal_year === year); const prior = budgets.find((b) => b.fiscal_year === year - 1 && b.status === 'approved');
  const lines = target ? await must(supabase.from('budget_line_items').select('account_id, annual_amount_cents, notes').eq('budget_id', target.id).limit(2000), 'lines') : [];
  const prior_lines = prior ? await must(supabase.from('budget_line_items').select('account_id, annual_amount_cents').eq('budget_id', prior.id).limit(2000), 'prior lines') : [];
  const contracts = await must(supabase.from('vendor_contracts').select('*').eq('community_id', community_id).limit(1000), 'contracts');
  const fromDate = `${year - 2}-${String(as_of).slice(5, 10)}`;
  const invoices = await fetchAllQuery(() => supabase.from('ap_invoices').select('id, vendor_id, invoice_date, service_period_end, total_cents, status, voided_at, coded_gl_account_id').eq('community_id', community_id).gt('invoice_date', fromDate).lte('invoice_date', as_of).order('invoice_date', { ascending: true }), { orderBy: 'id' });
  const ids = invoices.map((i) => i.id); const linesBy = new Map();
  for (let k = 0; k < ids.length; k += 200) {
    const chunk = await must(supabase.from('ap_invoice_lines').select('invoice_id, gl_account_id, amount_cents').in('invoice_id', ids.slice(k, k + 200)).limit(5000), 'invoice lines');
    for (const l of chunk) { if (!linesBy.has(l.invoice_id)) linesBy.set(l.invoice_id, []); linesBy.get(l.invoice_id).push(l); }
  }
  for (const i of invoices) i.lines = linesBy.get(i.id) || [];
  const vids = [...new Set([...invoices.map((i) => i.vendor_id), ...contracts.map((c) => c.vendor_id)].filter(Boolean))];
  const vendors = vids.length ? await must(supabase.from('vendors').select('id, name, is_mud, kind').in('id', vids), 'vendors') : [];
  // vendors a contract may match by name (no vendor_id yet)
  for (const c of contracts.filter((x) => !x.vendor_id && x.vendor_name_raw)) {
    const first = String(c.vendor_name_raw).split(/[\s,]+/)[0];
    if (first && first.length > 2) for (const v of await must(supabase.from('vendors').select('id, name, is_mud, kind').ilike('name', `${first}%`).limit(10), 'vendor name match')) if (!vendors.some((x) => x.id === v.id)) vendors.push(v);
  }
  return { year, as_of, accounts, lines, prior_lines, contracts, vendors, invoices, budget: target || null };
}

module.exports = { reviewContracts, loadReviewInput, normName, DEFAULTS };
