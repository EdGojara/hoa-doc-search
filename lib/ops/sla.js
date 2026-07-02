// ============================================================================
// lib/ops/sla.js  (Ed 2026-07-01)
// ----------------------------------------------------------------------------
// The BAM Operations Standard response matrix, as code. Given an item's
// received time + urgency, computes the SLA due timestamp the Status page
// flags against. Also maps a classified mail/email TYPE to its default owner +
// urgency (the routing matrix), so Mail Scan / email intake create a work item
// pre-routed the way the Standard prescribes.
//
//   Urgent / legal / board   -> within 2 hours          (critical)
//   Gov / financial deadline -> same business day        (high)
//   Invoice / owner / insurance / board corr -> EOD      (normal)
//   Everything else          -> +2 business days EOD     (low)
//
// EOD = 5:00 PM Central (approximated as 22:00 UTC, CDT). Weekend skipping is
// deliberately omitted in v1 (documented) — refine if the board shows weekend
// items flagging overdue on Monday.
// ============================================================================

const HOUR = 3600 * 1000;

// 5pm Central ≈ 22:00 UTC (CDT, summer). Close enough for a work board; the
// display side formats in America/Chicago.
function eodUtcForDate(d) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 22, 0, 0));
  return x;
}

/**
 * Compute the SLA due timestamp.
 * @param {string|Date} receivedAt
 * @param {'critical'|'high'|'normal'|'low'} urgency
 * @returns {string} ISO timestamp
 */
function slaDueAt(receivedAt, urgency) {
  const rcv = receivedAt ? new Date(receivedAt) : new Date();
  const base = Number.isNaN(rcv.getTime()) ? new Date() : rcv;

  if (urgency === 'critical') {
    return new Date(base.getTime() + 2 * HOUR).toISOString();          // within 2 hours
  }
  if (urgency === 'high') {
    let eod = eodUtcForDate(base);
    if (base.getTime() >= eod.getTime()) eod = new Date(base.getTime() + 4 * HOUR); // after hours -> +4h, still same-day urgent
    return eod.toISOString();                                          // same business day
  }
  if (urgency === 'low') {
    const d = new Date(base.getTime());
    d.setUTCDate(d.getUTCDate() + 2);
    return eodUtcForDate(d).toISOString();                             // +2 days EOD
  }
  // normal -> EOD; if already past today's EOD, next day EOD
  let eod = eodUtcForDate(base);
  if (base.getTime() >= eod.getTime()) {
    const d = new Date(base.getTime());
    d.setUTCDate(d.getUTCDate() + 1);
    eod = eodUtcForDate(d);
  }
  return eod.toISOString();
}

// Routing matrix: classified type -> default owner + urgency. Keys are matched
// case-insensitively against a substring of the type string, so "Legal /
// Attorney", "Legal Invoices", etc. all resolve.
const ROUTES = [
  { match: /legal|attorney|subpoena|lawsuit|demand/i, owner: 'Ed',                urgency: 'critical', item_type: 'legal' },
  { match: /board/i,                                  owner: 'Community Manager', urgency: 'critical', item_type: 'board' },
  { match: /government|regulatory|tax|county/i,       owner: 'Ed',                urgency: 'high',     item_type: 'government' },
  { match: /collection|nsf|delinqu/i,                 owner: 'Ed',                urgency: 'high',     item_type: 'financial' },
  { match: /invoice|vendor|ap\b/i,                    owner: 'Martha',            urgency: 'normal',   item_type: 'invoice' },
  { match: /insurance/i,                              owner: 'Martha',            urgency: 'normal',   item_type: 'insurance' },
  { match: /homeowner|owner corresp|resident/i,       owner: 'Community Manager', urgency: 'normal',   item_type: 'owner_correspondence' },
  { match: /junk|marketing|solicit/i,                 owner: 'Community Manager', urgency: 'low',      item_type: 'other' },
];

/**
 * Map a classified type string to its default route.
 * @param {string} typeStr
 * @returns {{owner:string, urgency:string, item_type:string}}
 */
function defaultRoute(typeStr) {
  const s = String(typeStr || '');
  for (const r of ROUTES) if (r.match.test(s)) return { owner: r.owner, urgency: r.urgency, item_type: r.item_type };
  return { owner: 'Community Manager', urgency: 'normal', item_type: 'other' };
}

// If a classifier already gave an urgency, trust it; else derive from type.
function resolveUrgency(urgency, typeStr) {
  const allowed = ['critical', 'high', 'normal', 'low'];
  if (allowed.includes(urgency)) return urgency;
  return defaultRoute(typeStr).urgency;
}

module.exports = { slaDueAt, defaultRoute, resolveUrgency };
