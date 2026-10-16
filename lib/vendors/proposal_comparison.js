// ============================================================================
// lib/vendors/proposal_comparison.js  (Ed 2026-10-16: proposals run through the
// RFP / Bid Workflow as the system of record)
// ----------------------------------------------------------------------------
// When Amanda receives two or more proposals for the same project (or one that
// should be compared with a proposal already on file), the comparison is
// MANAGEMENT WORK and it belongs on the community's RFP / Bid Workflow record,
// not only inside her email. This module is the pure engine (no I/O):
//
//   detectComparisonMatter()   is this a vendor/project comparison matter?
//   boardRequirements()        what the Board said it wants (own / cloud / no monitoring)
//   classifyProposals()        current | historical | superseded | duplicate | expired,
//                              from chronology, version and scope (never ask the Board)
//   normalizeProposal()        one comparable structure: scope, upfront, recurring,
//                              term, total cost over a common horizon, ownership,
//                              monitoring, warranty, insurance, exclusions,
//                              assumptions, timing, change-order exposure, terms
//   openItems()                material missing information, as routine vendor
//                              diligence (queued, never sent from here) or Board items
//   rankAndRecommend()         viable alternatives ranked, one plain recommendation
//   buildComparisonRecord()    the full record stored on the workflow, with an
//                              audit trail of what was associated/classified and why
//   renderBoardSummary()       the short decision-ready Board email body
//
// Two-stage flow (CLAUDE.md): extraction (lib/vendors/proposal_extract.js) ->
// validateProposal() here -> everything renders from the validated structure.
// ============================================================================

const STATUSES = ['current', 'historical', 'superseded', 'duplicate', 'expired'];
const DEFAULT_HORIZON_MONTHS = 60;

const money = (c) => { if (c == null || !Number.isFinite(Number(c))) return 'not priced'; const n = Number(c) / 100; return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
const money0 = (c) => { if (c == null) return 'not priced'; return '$' + Math.round(Number(c) / 100).toLocaleString('en-US'); };
const normVendor = (s) => String(s || '').toLowerCase().replace(/\b(inc|llc|l\.?p|corp|corporation|company|co|systems?|monitoring|usa|security|services?)\b\.?/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const vendorKey = (p) => normVendor(p.vendor_name).split(' ')[0] || normVendor(p.vendor_name);
const quoteBase = (q) => String(q || '').trim().toUpperCase().replace(/[-_ ]?(?:R(?:EV)?)?\d{1,2}$/, '');
const quoteRev = (q, rev) => { if (rev != null && Number.isFinite(Number(rev))) return Number(rev); const m = String(q || '').match(/[-_ ](?:R(?:EV)?)?(\d{1,2})$/i); return m ? Number(m[1]) : 0; };

// ------------------------------------------------------------------ detection
const PROPOSAL_WORDS = /\b(proposals?|quotes?|quotations?|bids?|estimates?|pricing|contract\/proposal)\b/i;
const COMPARE_WORDS = /\b(compare|comparison|side[- ]by[- ]side|assessment|assess|review (?:these|the|this)|which (?:one|proposal|vendor|bid)|recommend|options?|vs\.?|versus|evaluate)\b/i;
const PROPOSAL_FILE = /(propos|quote|qoute|quotation|bid|estimate|rfp)/i;

/**
 * Is this a vendor-proposal / competing-bid matter?
 *   attachments        [{name}]
 *   existingProposals  proposals already on file for the community in a related category
 * Two or more proposal documents, or one plus a related proposal on file, or a
 * packet the sender describes as several proposals.
 */
function detectComparisonMatter({ subject = '', body = '', attachments = [], existingProposals = [] } = {}) {
  const text = `${subject}\n${body}`;
  const propFiles = (attachments || []).filter((a) => a && !a.isInline && PROPOSAL_FILE.test(a.name || ''));
  const reasons = [];
  if (propFiles.length >= 2) reasons.push(`${propFiles.length} proposal documents attached`);
  if (/\b(all three|three|two|both|several|the other two|multiple|recent) proposals\b/i.test(text)) reasons.push('message refers to several proposals');
  if (propFiles.length >= 1 && (existingProposals || []).length >= 1) reasons.push(`${existingProposals.length} related proposal(s) already on file`);
  const asks = PROPOSAL_WORDS.test(text) && (COMPARE_WORDS.test(text) || propFiles.length >= 1);
  const is = reasons.length > 0 && asks;
  return { is_matter: is, reasons: is ? reasons : [], proposal_files: propFiles.map((a) => a.name) };
}

/** What the Board told us it wants, from its own words. Never invented. */
function boardRequirements(text) {
  const t = String(text || '');
  const req = { ownership: null, cloud_access: null, monitoring: null, notes: [] };
  if (/\b(purchas(?:e|ing) the hardware|own (?:the )?(?:system|equipment|hardware)|buy (?:the )?(?:system|hardware))/i.test(t)) { req.ownership = true; req.notes.push('purchase and own the hardware'); }
  if (/\b(cloud (?:storage|access)|remote(?:ly)? (?:access|view)|storage\/access)/i.test(t)) { req.cloud_access = true; req.notes.push('cloud storage and remote access'); }
  if (/\b(not interested in (?:any )?monitoring|no monitoring|don'?t (?:want|need) (?:any )?monitoring|without monitoring)\b/i.test(t)) { req.monitoring = false; req.notes.push('no monitoring service'); }
  else if (/\b(want|need|interested in) (?:active |live )?monitoring\b/i.test(t)) { req.monitoring = true; req.notes.push('active monitoring'); }
  const when = t.match(/\b(?:install(?:ed|ation)?|start)\b[^.]{0,60}\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i);
  if (when) req.notes.push(`schedule: ${when[0].trim()}`);
  return req;
}

// ------------------------------------------------------------------ validation
/** Validate one extracted proposal. Returns { ok, errors, warnings }. */
function validateProposal(p) {
  const errors = []; const warnings = [];
  if (!p || typeof p !== 'object') return { ok: false, errors: ['not an object'], warnings };
  if (!p.vendor_name) errors.push('vendor_name missing');
  if (!p.document || !p.document.filename) errors.push('document.filename missing (no source pointer)');
  const pr = p.pricing || {};
  if (!pr.unpriced && !Number.isInteger(pr.upfront_cents) && !(pr.recurring || []).length) errors.push('no price and not marked unpriced');
  if (pr.upfront_cents != null && (!Number.isInteger(pr.upfront_cents) || pr.upfront_cents < 0)) errors.push('upfront_cents must be a non-negative integer');
  for (const r of pr.recurring || []) if (!Number.isInteger(r.monthly_cents) || r.monthly_cents < 0) errors.push(`recurring "${r.label}" monthly_cents invalid`);
  for (const k of ['document_date', 'expires_on', 'accepted_on']) if (p[k] && !/^\d{4}-\d{2}-\d{2}$/.test(p[k])) errors.push(`${k} must be YYYY-MM-DD`);
  if (!p.document_date) warnings.push('document_date missing: chronology falls back to receipt date');
  if (pr.tax_rate_pct != null && (pr.tax_rate_pct < 0 || pr.tax_rate_pct > 15)) errors.push('tax_rate_pct out of range');
  return { ok: errors.length === 0, errors, warnings };
}

// ------------------------------------------------------------------ classification
function sameDocument(a, b) {
  const da = a.document || {}; const db = b.document || {};
  // A packet holds several proposals: the same file is a duplicate only for the same pages.
  if (da.sha256 && db.sha256 && da.sha256 === db.sha256) return (da.pages || '') === (db.pages || '') ? 'identical file (same SHA-256)' : null;
  if (vendorKey(a) !== vendorKey(b)) return null;
  if (a.quote_number && b.quote_number && quoteBase(a.quote_number) === quoteBase(b.quote_number)
    && quoteRev(a.quote_number, a.revision) === quoteRev(b.quote_number, b.revision)
    && (a.pricing || {}).upfront_cents === (b.pricing || {}).upfront_cents) return `same quote ${a.quote_number} at the same price`;
  if (da.filename && da.filename === db.filename && da.size_bytes && da.size_bytes === db.size_bytes && (da.pages || '') === (db.pages || '')) return 'same file name and size';
  if (a.document_date && a.document_date === b.document_date && (a.pricing || {}).upfront_cents != null
    && (a.pricing || {}).upfront_cents === (b.pricing || {}).upfront_cents) return 'same vendor, date and price';
  return null;
}

/**
 * Classify every proposal from chronology, version and scope. Returns a new array
 * with { status, status_reason, duplicate_of, approvable } on each item.
 */
function classifyProposals(items, { today } = {}) {
  const asOf = today || new Date().toISOString().slice(0, 10);
  const list = (items || []).map((p) => ({ ...p }));
  const received = (p) => (p.document && p.document.received_at) || p.document_date || '9999-12-31';
  const byArrival = [...list].sort((a, b) => received(a).localeCompare(received(b)) || String(a.key).localeCompare(String(b.key)));
  const canonical = [];
  for (const p of byArrival) {
    // same_file_as: the caller already matched this copy to a document on file by its hash.
    const known = p.same_file_as && canonical.find((c) => c.key === p.same_file_as);
    const dupOf = known || canonical.find((c) => sameDocument(c, p));
    if (dupOf) { p.status = 'duplicate'; p.duplicate_of = dupOf.key; p.status_reason = `${known ? 'same file already on the workflow' : sameDocument(dupOf, p)} as ${dupOf.key} (${(dupOf.document || {}).filename}); kept once`; }
    else canonical.push(p);
  }
  // Version lineage within a vendor: same quote base, lower revision = superseded;
  // otherwise an older dated proposal from the same vendor = historical.
  const groups = {};
  for (const p of canonical) (groups[vendorKey(p)] = groups[vendorKey(p)] || []).push(p);
  for (const g of Object.values(groups)) {
    const dated = (p) => p.document_date || received(p);
    const newest = [...g].sort((a, b) => dated(b).localeCompare(dated(a)))[0];
    for (const p of g) {
      if (p === newest) continue;
      if (p.quote_number && newest.quote_number && quoteBase(p.quote_number) === quoteBase(newest.quote_number) && quoteRev(p.quote_number, p.revision) < quoteRev(newest.quote_number, newest.revision)) {
        p.status = 'superseded'; p.status_reason = `revision of ${newest.quote_number} replaced it`;
      } else {
        p.status = 'historical';
        p.status_reason = `older ${p.vendor_name} proposal (${dated(p)}) replaced by its ${dated(newest)} proposal${scopeDiffers(p, newest) ? ' with a different scope' : ''}; kept for reference only`;
      }
    }
  }
  for (const p of canonical) {
    if (p.status) continue;
    if (p.expires_on && p.expires_on < asOf) { p.status = 'expired'; p.status_reason = `quote expired ${p.expires_on}; not approvable without refreshed pricing`; }
    else { p.status = 'current'; p.status_reason = p.expires_on ? `latest from ${p.vendor_name}, valid through ${p.expires_on}` : `latest from ${p.vendor_name}${(p.pricing || {}).unpriced ? ' (no price yet)' : ''}`; }
  }
  // A duplicate of an expired quote is also not approvable.
  for (const p of list) p.approvable = p.status === 'current' && !(p.pricing || {}).unpriced;
  return list;
}

function scopeDiffers(a, b) {
  const sa = a.scope || {}; const sb = b.scope || {};
  return (sa.cameras_total || null) !== (sb.cameras_total || null) || (a.pricing || {}).upfront_cents !== (b.pricing || {}).upfront_cents
    || JSON.stringify((sa.locations || []).slice().sort()) !== JSON.stringify((sb.locations || []).slice().sort());
}

// ------------------------------------------------------------------ normalization
/**
 * One comparable structure. Total cost of ownership over a common horizon counts
 * the upfront price with tax, every REQUIRED recurring charge, and every optional
 * charge that buys something the Board said it needs (e.g. cloud access sold only
 * inside a maintenance plan). Optional charges the Board does not need are shown,
 * never silently added.
 */
// A quote that says tax is added to the monthly charges, when the extraction left `taxable` unset.
const TAX_ON_MONTHLY = /\b(?:sales )?tax (?:will be |is )?added to (?:all )?(?:the )?monthly/i;

function normalizeProposal(p, { horizonMonths = DEFAULT_HORIZON_MONTHS, requirements = {}, estimatedTaxRatePct = null } = {}) {
  const pr = p.pricing || {};
  // Sales tax is never assumed to be $0. A stated rate is used as stated; a missing rate takes the rate
  // other proposals for this community state (labelled estimated); with no basis at all the tax is
  // "not stated", the total is pre-tax and the gap is flagged.
  const stated = pr.tax_rate_pct != null && Number.isFinite(Number(pr.tax_rate_pct));
  const ratePct = pr.tax_included ? 0 : stated ? Number(pr.tax_rate_pct) : (estimatedTaxRatePct != null ? Number(estimatedTaxRatePct) : null);
  const taxBasis = pr.tax_included ? 'included' : stated ? 'stated' : ratePct != null ? 'estimated' : 'not_stated';
  const rate = Number(ratePct || 0) / 100;
  const upfront = Number.isInteger(pr.upfront_cents) ? pr.upfront_cents : null;
  const upfrontTax = upfront == null ? null : (pr.tax_included ? 0 : ratePct == null ? null : Math.round(upfront * rate));
  const termsText = [...(p.other_terms || []), p.payment_terms || '', ...((pr.recurring || []).map((r) => r.label || ''))].join(' ');
  const needs = new Set([requirements.cloud_access ? 'cloud_access' : null].filter(Boolean));
  const monitoringUnwanted = requirements.monitoring === false;
  const recurring = (pr.recurring || []).map((r) => {
    const provides = r.provides || [];
    // An optional plan that bundles monitoring the Board excluded stays OUT of the recommended
    // configuration, even when it is the only listed route to a wanted feature: it is a conditional
    // add-on, counted only if the vendor confirms it is required (r.vendor_confirmed_required).
    const bundlesMonitoring = provides.includes('active_monitoring') || provides.includes('health_alerts') || /monitor/i.test(r.label || '');
    const wantedVia = provides.filter((x) => needs.has(x));
    const conditionalAddon = !r.required && monitoringUnwanted && bundlesMonitoring && wantedVia.length > 0 && r.vendor_confirmed_required !== true;
    const neededForBoard = !r.required && wantedVia.length > 0 && (!monitoringUnwanted || !bundlesMonitoring || r.vendor_confirmed_required === true);
    const taxable = r.taxable === true || (r.taxable == null && TAX_ON_MONTHLY.test(termsText));
    const monthlyWithTax = taxable && ratePct != null ? Math.round(r.monthly_cents * (1 + rate)) : r.monthly_cents;
    return { ...r, taxable: r.taxable == null && taxable ? true : r.taxable, tax_basis: taxable ? (r.taxable === true && stated ? 'stated' : ratePct != null ? 'estimated' : 'not_stated') : (r.taxable === false ? 'exempt' : 'not_stated'),
      counted: !!(r.required || neededForBoard), conditional_addon: conditionalAddon,
      counted_reason: r.required ? 'required by the proposal'
        : neededForBoard ? `optional, but ${r.vendor_confirmed_required ? 'the vendor confirmed it is required for' : 'it is the only way to get'} ${wantedVia.join(', ').replace(/_/g, ' ')}`
        : conditionalAddon ? `optional plan that bundles monitoring the Board does not want; not in the recommended configuration unless the vendor confirms it is required for ${wantedVia.join(', ').replace(/_/g, ' ')}`
        : 'optional and not needed for what the Board asked for',
      monthly_with_tax_cents: monthlyWithTax };
  });
  const addonMonthly = recurring.filter((r) => r.conditional_addon).reduce((t, r) => t + r.monthly_with_tax_cents, 0);
  const countedMonthly = recurring.filter((r) => r.counted).reduce((t, r) => t + r.monthly_with_tax_cents, 0);
  const requiredMonthly = recurring.filter((r) => r.required).reduce((t, r) => t + r.monthly_with_tax_cents, 0);
  const minTerm = Math.max(0, ...recurring.filter((r) => r.required).map((r) => Number(r.min_term_months || 0)));
  const upfrontTotal = upfront == null ? null : upfront + (upfrontTax || 0);
  const tco = upfrontTotal == null ? null : upfrontTotal + countedMonthly * horizonMonths;
  const scope = p.scope || {};
  const model = p.model || {};
  return {
    key: p.key, vendor_name: p.vendor_name, status: p.status, status_reason: p.status_reason || null, duplicate_of: p.duplicate_of || null, approvable: !!p.approvable,
    source: p.document, document_date: p.document_date || null, quote_number: p.quote_number || null, expires_on: p.expires_on || null,
    scope: { summary: scope.summary || null, cameras_total: scope.cameras_total ?? null, cameras_new: scope.cameras_new ?? null, cameras_reused: scope.cameras_reused ?? null, locations: scope.locations || [], storage: scope.storage || null, retention_days: scope.retention_days ?? null, licenses: scope.licenses ?? null, embedded_server_cameras: scope.embedded_server_cameras ?? 0 },
    upfront_cents: upfront, upfront_tax_cents: upfrontTax, upfront_total_cents: upfrontTotal, tax_rate_pct: ratePct, tax_basis: taxBasis, tax_included: !!pr.tax_included,
    tax_note: taxBasis === 'estimated' ? `the quote does not state a tax rate; ${ratePct}% applied, the rate stated on this community's other proposals` : taxBasis === 'not_stated' ? 'the quote does not state sales tax and no community rate is known; totals are before tax' : null,
    recurring, recurring_counted_monthly_cents: countedMonthly, recurring_required_monthly_cents: requiredMonthly,
    contract_term_months: minTerm || null, minimum_commitment_cents: upfrontTotal == null ? null : upfrontTotal + requiredMonthly * minTerm,
    horizon_months: horizonMonths, tco_cents: tco,
    // Conditional add-ons (optional plans that bundle monitoring the Board excluded) are shown, never in the base.
    addon_monthly_cents: addonMonthly, tco_with_addons_cents: tco == null ? null : tco + addonMonthly * horizonMonths,
    first_year_cents: upfrontTotal == null ? null : upfrontTotal + countedMonthly * Math.min(12, horizonMonths),
    ownership: model.ownership || null, monitoring: model.monitoring || null, cloud_access: model.cloud_access || null,
    warranty: p.warranty || null, insurance: p.insurance || null, exclusions: p.exclusions || [], assumptions: p.assumptions || [],
    implementation_timing: p.timing || null, change_order_exposure: p.change_order || null, payment_terms: p.payment_terms || null,
    other_terms: p.other_terms || [], budgetary: !!p.budgetary, unpriced: !!pr.unpriced,
  };
}

/** Does a normalized proposal fit what the Board said it wants? */
function fitsRequirements(n, req = {}) {
  const misses = [];
  if (req.monitoring === false && ['included', 'required'].includes(n.monitoring)) misses.push('built around a monitoring service the Board said it does not want');
  if (req.monitoring === true && (!n.monitoring || n.monitoring === 'none')) misses.push('no monitoring, which the Board asked for');
  if (req.ownership === true && n.ownership && n.ownership !== 'association') misses.push('the association would not own the equipment');
  if (req.cloud_access === true && n.cloud_access === 'none') misses.push('no cloud or remote access');
  return { fits: misses.length === 0, misses };
}

// ------------------------------------------------------------------ open items
/**
 * Material missing information. Routine vendor diligence is management work: it is
 * recorded as a queued request on the workflow (never sent from here; sending is a
 * separate, allowlisted step). Items only the Board can resolve are marked 'board'.
 */
function openItems(normalized, { requirements = {}, viableKeys = new Set() } = {}) {
  const items = [];
  const add = (n, topic, request, material = true, plain = null) => items.push({ vendor: n.vendor_name, proposal_key: n.key, topic, request, plain: plain || topic, kind: 'routine_diligence', material, status: 'queued_not_sent' });
  for (const n of normalized) {
    if (n.status === 'duplicate' || n.status === 'historical' || n.status === 'superseded') continue;
    const fit = fitsRequirements(n, requirements);
    if (n.status === 'expired' || n.unpriced) {
      if (fit.fits) add(n, n.unpriced ? 'pricing' : 'refreshed pricing', n.unpriced ? `Provide a price for the proposed scope.` : `Quote ${n.quote_number || ''} expired ${n.expires_on}. Provide refreshed pricing.`.replace(/\s+/g, ' '));
      continue;   // not pursued further: model the Board excluded, or nothing to diligence until priced
    }
    if (!viableKeys.has(n.key)) continue;
    const s = n.scope;
    if (n.budgetary || /change order/i.test(n.change_order_exposure || '')) add(n, 'change-order control', 'The bid is budgetary and anticipates a change order for existing faults. After the pre-installation survey, provide a final fixed scope and a not-to-exceed price; no added work or change order without the Board\'s written approval.', true, 'a fixed not-to-exceed price after the site survey (the bid is budgetary and expects a change order)');
    if (s.cameras_total && s.licenses != null && s.licenses < s.cameras_total - (s.embedded_server_cameras || 0)) add(n, 'camera schedule and licensing', `The scope totals ${s.cameras_total} cameras but lists ${s.licenses} licenses (${s.embedded_server_cameras || 0} cameras carry their own server). Provide a final camera schedule by location and confirm licensing covers every camera.`, true, `a camera-by-camera schedule (${s.cameras_total} cameras against ${s.licenses} licenses)`);
    if (n.tax_basis === 'estimated' || n.tax_basis === 'not_stated') add(n, 'sales tax', `The proposal does not state sales tax (${n.tax_note}). Confirm the tax on the installation and any monthly charges.`, true, 'the sales tax, which the quote does not state');
    if (s.retention_days == null) add(n, 'retention', 'State the guaranteed video retention in days at the proposed resolution and frame rate.', true, 'how many days of video are kept');
    const cloudPlan = n.recurring.find((r) => (r.provides || []).includes('cloud_access') && !r.required);
    if (requirements.cloud_access && cloudPlan) add(n, 'remote/cloud access cost', `Remote cloud access appears only inside the ${money(cloudPlan.monthly_cents)}/month ${cloudPlan.label}. Confirm whether cloud access can be purchased without it, the price either way, and whether sales tax applies.`, true, `whether cloud access requires the ${money(cloudPlan.monthly_cents)}/month plan`);
    if (requirements.cloud_access && !cloudPlan && !n.cloud_access) add(n, 'remote/cloud access cost', 'Confirm how remote and cloud access is provided and what it costs.');
    for (const r of n.recurring) if (r.auto_renews) add(n, 'renewal and termination', `The ${r.label} renews automatically. Restate the renewal and cancellation terms plainly, with a cancellation right on 30 days\' notice.`, true, 'plain renewal and cancellation terms for the plan');
    if (!n.warranty) add(n, 'warranty', 'Provide a written workmanship warranty (at least one year parts and labor) and the manufacturer warranty terms.', true, 'a written warranty');
    if (!n.insurance) add(n, 'insurance', 'Provide a certificate of insurance naming the association as additional insured before any work starts.', true, 'a certificate of insurance');
    if (!n.implementation_timing) add(n, 'schedule', 'Confirm the installation start and completion dates.', true, 'firm installation dates');
    if (/50%.*accept/i.test(n.payment_terms || '')) add(n, 'deposit protection', 'The 50% deposit is due on acceptance. Make it refundable if the post-survey scope or price changes, and no materials ordered until the Board approves the final scope.', false);
  }
  return items;
}

// ------------------------------------------------------------------ rank + recommend
function rankAndRecommend(normalized, { requirements = {}, facts = null } = {}) {
  const considered = normalized.filter((n) => !['duplicate', 'historical', 'superseded'].includes(n.status));
  const viable = []; const notViable = [];
  for (const n of considered) {
    const fit = fitsRequirements(n, requirements);
    const why = [];
    if (n.status === 'expired') why.push(`quote expired ${n.expires_on}`);
    if (n.unpriced) why.push('no price provided');
    why.push(...fit.misses);
    if (why.length) notViable.push({ key: n.key, vendor_name: n.vendor_name, reasons: why });
    else viable.push(n);
  }
  viable.sort((a, b) => (a.tco_cents ?? Infinity) - (b.tco_cents ?? Infinity));
  const rec = viable[0] || null;
  let funding = null;
  if (rec) funding = recommendFunding(rec, facts);
  return { ranked: viable.map((n, i) => ({ rank: i + 1, key: n.key, vendor_name: n.vendor_name, tco_cents: n.tco_cents, upfront_total_cents: n.upfront_total_cents })), not_viable: notViable, recommended_key: rec ? rec.key : null, funding };
}

/**
 * Preliminary funding source. Capital equipment goes to Reserve when the reserve
 * balance covers it; recurring service charges belong in the operating budget.
 * The confidence label travels with the conclusion so the email never states it
 * as certain when the balance is provisional.
 */
function recommendFunding(n, facts) {
  if (!facts || !facts.funds) return { source: null, basis: 'financial facts unavailable', label: 'unavailable' };
  const reserve = facts.funds.find((f) => /reserve|replacement/i.test(f.fund));
  const operating = facts.funds.find((f) => /operat/i.test(f.fund));
  const amt = n.upfront_total_cents || 0;
  if (reserve && reserve.balance_cents >= amt) {
    return { source: 'reserve', capital_cents: amt, fund: reserve.fund, balance_cents: reserve.balance_cents, label: reserve.label, reason: reserve.reason,
      recurring_source: n.recurring_counted_monthly_cents ? 'operating' : null, operating_balance_cents: operating ? operating.balance_cents : null, operating_label: operating ? operating.label : null,
      basis: `capital equipment, ${money(amt)} against ${reserve.fund} of ${money(reserve.balance_cents)}` };
  }
  if (operating && operating.balance_cents >= amt) return { source: 'operating', capital_cents: amt, fund: operating.fund, balance_cents: operating.balance_cents, label: operating.label, reason: operating.reason, basis: `operating covers ${money(amt)}` };
  return { source: null, capital_cents: amt, label: worstLabel([reserve && reserve.label, operating && operating.label]), basis: 'no single fund shows enough to cover it; the Board needs a funding decision' };
}
const worstLabel = (ls) => require('../accounting/data_confidence').worst(ls.filter(Boolean));

// ------------------------------------------------------------------ the record
/**
 * Everything that gets stored on the RFP / Bid Workflow record (bid_requests +
 * vendor_proposals + vendor_comparisons.analysis_data + rfp_decision_log). Pure.
 */
function buildComparisonRecord({ community, project, proposals, requirements, facts, today, horizonMonths = DEFAULT_HORIZON_MONTHS, source, context = [] }) {
  const asOf = today || new Date().toISOString().slice(0, 10);
  const validation = proposals.map((p) => ({ key: p.key, ...validateProposal(p) }));
  const valid = proposals.filter((p, i) => validation[i].ok);
  const classified = classifyProposals(valid, { today: asOf });
  // The community's sales-tax rate as the vendors themselves state it (most common stated rate), used to
  // estimate tax on a quote that leaves it out. Never a hard-coded rate; never $0.
  const statedRates = valid.map((p) => (p.pricing || {}).tax_rate_pct).filter((r) => r != null && Number.isFinite(Number(r)) && Number(r) > 0).map(Number);
  const peerRate = statedRates.length ? statedRates.sort((a, b) => statedRates.filter((x) => x === b).length - statedRates.filter((x) => x === a).length)[0] : null;
  const normalized = classified.map((p) => normalizeProposal(p, { horizonMonths, requirements, estimatedTaxRatePct: peerRate }));
  const ranking = rankAndRecommend(normalized, { requirements, facts });
  const items = openItems(normalized, { requirements, viableKeys: new Set(ranking.ranked.map((r) => r.key)) });
  const rec = normalized.find((n) => n.key === ranking.recommended_key) || null;
  // Multi-lens risk and completeness review of every viable proposal (the recommended one first),
  // using the community's own records (lib/vendors/community_context.js), not just the PDFs.
  const R = require('./proposal_review');
  const reviewed = {};
  const comparable = normalized.filter((n) => !['duplicate', 'historical', 'superseded'].includes(n.status));
  for (const r of ranking.ranked) {
    const n = normalized.find((x) => x.key === r.key);
    reviewed[n.key] = R.reviewProposal(n, { item: valid.find((p) => p.key === n.key) || {}, requirements, facts, context, others: comparable.filter((o) => o.key !== n.key), funding: n.key === ranking.recommended_key ? ranking.funding : null, boardNotes: requirements && requirements.notes });
  }
  const review = { by_proposal: reviewed };
  review.conclusions = R.conclusions({ proposals: normalized, recommendation: rec ? { key: rec.key } : null, horizon_months: horizonMonths }, rec ? reviewed[rec.key] : null, { funding: ranking.funding, context });
  const audit = [
    { action: 'associate', note: `Comparison opened on the RFP / Bid Workflow via "C. Skip, just compare" (proposals already in hand; no formal RFP needed).`, actor: 'Amanda' },
    ...classified.map((p) => ({ action: 'associate', proposal_key: p.key, note: `Associated ${p.vendor_name} from ${(p.document || {}).source_kind || 'document'} "${(p.document || {}).filename}"${(p.document || {}).pages ? ` pp.${p.document.pages}` : ''}${(p.document || {}).received_at ? `, received ${p.document.received_at}` : ''}. No re-upload.`, actor: 'Amanda' })),
    ...classified.map((p) => ({ action: 'classify', proposal_key: p.key, note: `${p.status}: ${p.status_reason}`, actor: 'Amanda' })),
    ...validation.filter((v) => !v.ok).map((v) => ({ action: 'classify', proposal_key: v.key, note: `Not compared: extraction failed validation (${v.errors.join('; ')}). Needs a human look.`, actor: 'Amanda' })),
    { action: 'analyze', note: `Normalized ${normalized.filter((n) => !['duplicate'].includes(n.status)).length} proposal(s) to a ${horizonMonths}-month total cost; ranked ${ranking.ranked.length} viable; recommended ${rec ? rec.vendor_name : 'none'}.`, actor: 'Amanda' },
    ...items.map((i) => ({ action: 'request_queued', proposal_key: i.proposal_key, note: `${i.vendor}: ${i.topic} (queued, not sent)`, actor: 'Amanda' })),
    ...(rec && reviewed[rec.key] ? [
      ...reviewed[rec.key].missing_documents.map((d) => ({ action: 'request_queued', proposal_key: rec.key, note: `${rec.vendor_name}: provide ${d.label}${d.note ? ` (${d.note})` : ''} (queued, not sent)`, actor: 'Amanda' })),
      { action: 'analyze', proposal_key: rec.key, note: `Review: vendor ${review.conclusions.vendor_recommendation.vendor}; project ${review.conclusions.project_recommendation.decision}; contract ${review.conclusions.contract_readiness.label}; ${reviewed[rec.key].counsel_review.length} term(s) flagged for counsel review; ${reviewed[rec.key].community_context_used.length} community record(s) used.`, actor: 'Amanda' },
    ] : []),
  ];
  return {
    schema_version: 'amanda-rfp-v1', as_of: asOf, community, project,
    workflow: { path: 'C', path_label: 'Skip, just compare', service_category: project.service_category, title: project.title, status: rec ? 'evaluating' : 'collecting' },
    source, requirements, horizon_months: horizonMonths,
    validation, proposals: normalized, ranking, recommendation: rec ? { key: rec.key, vendor_name: rec.vendor_name, conditions: items.filter((i) => i.proposal_key === rec.key && i.material).map((i) => i.topic) } : null,
    open_items: items, financial_facts: facts, review, community_context: context, audit,
  };
}

// ------------------------------------------------------------------ the Board email
/**
 * The short decision-ready executive summary (Ed's structure). Detailed analysis
 * stays on the workflow record; this links to it.
 */
function renderBoardSummary(record, { greetingName = 'Board', link = null, authorityCents = null } = {}) {
  const rec = record.proposals.find((n) => n.key === (record.recommendation || {}).key);
  const req = record.requirements || {};
  const nv = record.ranking.not_viable;
  const lines = [];
  const facts = record.financial_facts || {};
  const f = record.ranking.funding || {};
  lines.push(`Hi ${greetingName},`);
  const kept = record.proposals.filter((n) => n.status !== 'duplicate');
  const vendors = [...new Set(kept.map((n) => n.vendor_name))];
  const want = [req.ownership ? 'own the hardware' : null, req.cloud_access ? 'with cloud storage and remote access' : null, req.monitoring === false ? 'and no monitoring service' : null].filter(Boolean).join(' ');
  lines.push(`Situation: ${kept.length} ${record.project && /camera/i.test(record.project.title || '') ? 'camera ' : ''}proposals from ${vendors.length} vendors are on file${want ? `, and the Board wants to ${want}` : ''}. I compared them on the RFP / Bid Workflow${link ? ` (${link})` : ''}.`);
  if (!rec) {
    lines.push(`Recommendation: none of the proposals on file can be approved as they stand (${nv.map((x) => `${x.vendor_name}: ${x.reasons.join(', ')}`).join('; ')}).`);
    lines.push(`Action underway: I am requesting what is missing from the vendors.`);
    return lines.join('\n\n');
  }
  const plan = rec.recurring.find((r) => r.counted && !r.required);            // in the base (required or vendor-confirmed)
  const addon = rec.recurring.find((r) => r.conditional_addon);               // shown separately, never in the base
  const rv = (record.review && record.review.by_proposal && record.review.by_proposal[rec.key]) || null;
  const cc = record.review && record.review.conclusions;
  const vname = shortVendor(rec.vendor_name);
  const taxPhrase = rec.tax_basis === 'not_stated' ? ' before sales tax, which the quote does not state' : rec.tax_basis === 'included' ? ' including tax' : ` plus tax`;
  const base = rec.tax_basis === 'not_stated' ? `Base installed cost is ${money(rec.upfront_total_cents)} before sales tax, which the quote does not state.` : `Base installed cost is approximately ${money(rec.upfront_total_cents)} including ${rec.tax_basis === 'included' ? '' : 'estimated '}tax.`;
  lines.push(`Recommendation: I recommend ${rec.vendor_name}'s ${fmtDate(rec.document_date)} proposal at ${money(rec.upfront_cents)}${taxPhrase}. ${base}${plan ? ` It includes the ${money(plan.monthly_cents)}/month ${plan.label} (${plan.counted_reason}).` : ''}${addon ? ` If Canyon Gate elected to add ${vname}'s optional ${money(addon.monthly_cents)}/month plan, the ${record.horizon_months / 12}-year total would be approximately ${money(rec.tco_with_addons_cents)}. Because the Board has stated it does not want monitoring, that recurring plan is not part of my recommended configuration unless ${vname} confirms it is required for the desired remote/cloud functionality.` : ''}`.replace(/Canyon Gate/g, (record.community && record.community.name ? record.community.name.replace(/ at .*$/, '') : 'the community')));
  if (cc) {
    const fr = cc.funding_recommendation || {};
    lines.push(`Conclusions: Vendor recommendation: ${shortVendor(cc.vendor_recommendation.vendor)}. Project recommendation: ${capital(cc.project_recommendation.decision)}. Preliminary funding recommendation: ${fr.source ? capital(fr.source) : 'to be decided'}. Reserve-study status: ${capital(cc.reserve_study_status.label)}. Contract readiness: ${capital(cc.contract_readiness.label)}.${cc.monitoring_plan && cc.monitoring_plan.recommended === false ? ` Monitoring plan: ${capital(cc.monitoring_plan.label)}.` : ''}`);
  }
  const why = [];
  why.push(`It is the only current proposal that fits what the Board asked for: owned equipment${rec.scope.cameras_total ? `, about ${rec.scope.cameras_total} cameras (${rec.scope.cameras_reused} reused) at the ${joinList(rec.scope.locations)}` : ''}, and no monitoring service.`);
  for (const x of nv) {
    const other = record.proposals.find((n) => n.key === x.key);
    const taxWord = other && other.tax_basis === 'estimated' ? ' with estimated tax' : other && other.tax_basis === 'not_stated' ? ' before tax, which it does not state' : '';
    const cost = other && other.tco_cents ? ` (about ${money0(other.tco_cents)} over ${record.horizon_months / 12} years${taxWord})` : '';
    why.push(`${shortVendor(x.vendor_name)} is out: ${x.reasons.join(' and ').replace('built around a monitoring service the Board said it does not want', 'built around monitoring the Board does not want')}${cost}.`);
  }
  const hist = record.proposals.filter((n) => n.status === 'historical');
  if (hist.length) why.push(`${joinList(hist.map((h) => `${shortVendor(h.vendor_name)}'s ${String(h.document_date || '').slice(0, 4)} proposal`))} is superseded.`);
  if (f.source) {
    const prov = f.label && f.label !== 'verified';
    const rs = cc && cc.reserve_study_status ? cc.reserve_study_status.status : 'unknown';
    if (f.source === 'reserve') {
      why.push(`Preliminary funding recommendation: Reserve. This is a capital security/infrastructure project with a useful life extending beyond the current year, and using Reserve would better preserve operating liquidity.${rs === 'not_designated' ? ' However, the current reserve study/budget does not specifically include a camera-system component, so this would be a Board funding decision rather than use of an already designated reserve line item.' : rs === 'designated' ? ' The reserve study includes a component for this system.' : ''}${prov ? ` Current reported balances are also provisional while reconciliation and close work remain incomplete (Reserve shows ${money(f.balance_cents)}).` : ` Reserve shows ${money(f.balance_cents)}.`}`);
    } else {
      why.push(`Preliminary funding recommendation: ${capital(f.fund)} (${f.basis})${prov ? `; current reported balances are provisional while reconciliation and close work remain incomplete` : ''}.`);
    }
  }
  // Community knowledge from trustEd that changes or strengthens the decision, marked as such.
  // (The reserve-study status is already stated in the funding paragraph.)
  if (rv) {
    const fromRecords = [...rv.strengths, ...rv.weaknesses_risks].filter((x) => String(x.source).startsWith('trustEd:') && !['trustEd:books', 'trustEd:reserve_components'].includes(x.source) && x.brief).map((x) => x.brief);
    const prior = (record.community_context || []).find((c) => c.kind === 'prior_communication' && rv.community_context_used.some((u) => u.text === c.text));
    const vword = vname.split(' ')[0];
    const leaning = (record.community_context || []).find((c) => c.kind === 'prior_communication' && /presumably contract|leaning toward|prefer|going with/i.test(c.text) && new RegExp(`\\b${vword}`, 'i').test(c.text));
    if (leaning) fromRecords.push(`on ${fmtDate(leaning.text.slice(0, 10))} the Board indicated it was leaning toward ${vword}`);
    else if (prior) fromRecords.push(`the Board discussed these proposals on ${fmtDate(prior.text.slice(0, 10))}`);
    const cname = record.community && record.community.name ? record.community.name.replace(/ at .*$/, '') : 'community';
    if (fromRecords.length) why.push(`From ${cname} records: ${fromRecords.slice(0, 4).join('; ')}.`);
    const risks = rv.weaknesses_risks.filter((x) => x.severity === 'material' && x.brief && !String(x.source).startsWith('trustEd:')).map((x) => x.brief);
    if (risks.length) why.push(`Main risks: ${risks.slice(0, 4).join('; ')}.`);
  }
  lines.push(`Why: ${why.join(' ')}`);
  const conds = rv ? rv.required_conditions.map((c) => c.short) : record.open_items.filter((i) => i.proposal_key === rec.key && i.material).map((i) => i.plain);
  if (conds.length) lines.push(`Open items before signing: ${joinList(conds)}.`);
  // Honest about state: the requests are recorded on the workflow (queued); sending is a separate step.
  if (conds.length) lines.push(`Action underway: the requests to ${vname} for these items are prepared on the workflow record${rv && rv.counsel_review.length ? ', and the contract terms are flagged for counsel review' : ''}. I will hold signature until a fixed not-to-exceed price and the contract terms are in writing.`);
  const overAuthority = authorityCents == null || (rec.upfront_total_cents || 0) > authorityCents;
  if (overAuthority) lines.push(`Board decision needed: approve ${vname} up to ${money(rec.upfront_total_cents)} including ${rec.tax_basis === 'included' ? '' : 'estimated '}tax${f.source ? `, funded from ${f.fund} as a Board funding decision` : ''}${plan ? `, plus the ${money(plan.monthly_cents)}/month ${plan.label}` : ''}, conditioned on the open items above.${addon ? ` The optional ${money(addon.monthly_cents)}/month plan is not included; it comes back to the Board only if ${vname} confirms it is required for remote/cloud access.` : ''}`);
  return lines.join('\n\n');
}
const fmtDate = (d) => { if (!d) return 'latest'; const [y, m, dd] = d.split('-').map(Number); return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${dd}, ${y}`; };
const joinList = (xs) => { const a = (xs || []).filter(Boolean); return a.length <= 1 ? (a[0] || '') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`; };
const shortVendor = (s) => String(s || '').replace(/,?\s+(?:Inc|LLC|L\.?P|Corp)\.?$/i, '').replace(/\s+(?:Monitoring|Systems|USA)$/i, '');
const capital = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

module.exports = {
  STATUSES, DEFAULT_HORIZON_MONTHS, detectComparisonMatter, boardRequirements, validateProposal, classifyProposals,
  normalizeProposal, fitsRequirements, openItems, rankAndRecommend, recommendFunding, buildComparisonRecord, renderBoardSummary, money,
};
