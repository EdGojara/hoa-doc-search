// ============================================================================
// lib/enforcement/vantaca_reconcile.js
// ----------------------------------------------------------------------------
// Ed 2026-06-18: "I need to reconcile what we have in trustEd with Vantaca's
// reports to make sure we don't send first notice to anyone that got a cert.
// The certified letters are good for 180 days."
//
// THE PROBLEM this solves
// -----------------------
// Vantaca is still the live enforcement system during the transition. Its
// violation report carries each case's real stage (First Notice, Second
// Notice, Certified Letter Notice, Pending Hearing, Closed, ...). trustEd is
// taking over DRV. The danger: trustEd opens a *first notice* on a property +
// violation that Vantaca already escalated to a certified §209 letter. That
// regresses a homeowner who is mid-enforcement back to square one — a §209
// problem, and an embarrassing one in front of a board.
//
// THE RULE
// --------
// 1. Enforcement is a one-way ladder:
//        courtesy_1 < courtesy_2 < certified_209 < fine_assessed
//    Reconciliation NEVER moves a case DOWN the ladder. If trustEd and Vantaca
//    disagree on the stage for the same (property, category), the MORE ADVANCED
//    stage wins.
// 2. A certified §209 letter is "live" for CERT_VALID_DAYS (180) days from the
//    date it was issued. While a cert is live for a (property, category), that
//    pair is "cert-protected": trustEd must not open or send a courtesy_1 /
//    courtesy_2 for it. The case stays at certified_209.
// 3. "Pending Hearing" is NOT a distinct stage — it's a process step inside the
//    certified_209 stage (the §209 hearing right). The import already folds it
//    to certified_209 (see vantaca_violation_import.js). So a "Pending Hearing"
//    row is treated as a live cert for protection purposes.
//
// This module is a PURE function — no DB, no I/O — so the same decision can be
// exercised by the import preview, the /apply writer, and the regression test
// without any of them drifting. The escalation engine reads trustEd's own
// violations once the reconciled stages are written, so loading Vantaca's certs
// correctly is what makes the existing find_or_continue guard actually protect
// cert-stage cases.
// ============================================================================

// The canonical open-case stages, in ladder order. The FULL ladder lives in
// migration 124 (v_violation_latest_letter.suggested_next_stage) and the live
// CHECK constraint: courtesy_1 → courtesy_2 → certified_209 → fine_assessed →
// hearing_notice → legal_referral → lien_filed. ALL of these must be ranked —
// an existing trustEd case at lien_filed is the MOST advanced; if it ranked 0
// (unknown), an incoming Vantaca courtesy_1 would look "more advanced" and the
// reconciler would regress a homeowner who is already in legal. That is the
// exact regression this module exists to prevent, so the ladder must be
// complete here. Terminal values (cured / closed / voided) are handled
// separately by isTerminal().
const STAGE_RANK = {
  courtesy_1: 1,
  courtesy_2: 2,
  certified_209: 3,
  fine_assessed: 4,
  hearing_notice: 5,
  legal_referral: 6,
  lien_filed: 7,
};

const TERMINAL_STAGES = ['cured', 'closed', 'voided'];

// A certified §209 letter is statutorily "live" for this many days. Within the
// window the case cannot be regressed to a courtesy notice.
const CERT_VALID_DAYS = 180;

// Stages at or above this rank are cert-protected (a §209 certified letter has
// been issued). courtesy_1 / courtesy_2 are pre-certified and not protected.
const CERT_PROTECTED_MIN_RANK = STAGE_RANK.certified_209;

function rankOf(stage) {
  if (!stage) return 0;
  return STAGE_RANK[stage] || 0;
}

function isTerminal(stage) {
  return TERMINAL_STAGES.includes(stage);
}

// Parse a 'YYYY-MM-DD' (or ISO) string to a UTC-midnight epoch ms. Returns null
// for anything unparseable. We compare dates at day granularity to avoid
// timezone drift across the trustEd → Vantaca boundary (CLAUDE.md scar:
// date strings across boundaries).
function _dayMs(value) {
  if (!value) return null;
  const s = String(value).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function _daysBetween(laterMs, earlierMs) {
  return Math.floor((laterMs - earlierMs) / (24 * 60 * 60 * 1000));
}

// Best available date for "when did this case enter its current stage."
//   - existing trustEd violation → current_stage_started_at (falls back to opened_at)
//   - incoming Vantaca row        → opened_at (the import puts the event date here)
function _stageDateOf(record) {
  if (!record) return null;
  return record.current_stage_started_at || record.opened_at || null;
}

// ----------------------------------------------------------------------------
// pairKey — the reconciliation match key. A "case" is one (property, category).
// Both sides expose property_id; existing violations use primary_category_id,
// incoming rows use category_id.
// ----------------------------------------------------------------------------
function pairKey(propertyId, categoryId) {
  return `${propertyId}::${categoryId}`;
}

/**
 * Reconcile parsed Vantaca rows against trustEd's existing violations.
 *
 * @param {Array} resolvedRows   incoming Vantaca rows that matched a property +
 *                               category. Each: { property_id, category_id,
 *                               stage, opened_at, street_address?,
 *                               category_label?, ... }. `stage` is the canonical
 *                               slug from vantaca_violation_import (may be null
 *                               for unmapped / owner-response / void rows).
 * @param {Array} existingViolations  trustEd violations for this community.
 *                               Each: { property_id, primary_category_id,
 *                               current_stage, current_stage_started_at,
 *                               opened_at, resolved_at }.
 * @param {Object} [opts]
 * @param {string|Date} [opts.asOf]   reference "today" for the 180-day window
 *                               (defaults to the caller's now; pass a fixed date
 *                               in tests).
 * @returns {{ rows: Array, blocklist: Array, summary: Object }}
 *   rows      — resolvedRows each annotated with `.reconciliation`
 *   blocklist — the subset whose action is 'block_regression' (a courtesy notice
 *               that would land on a cert-protected case) — what Ed wants to SEE
 *   summary   — counts by action + cert_protected total
 */
function reconcileResolvedRows(resolvedRows, existingViolations, opts = {}) {
  const asOfMs = _dayMs(opts.asOf) ?? _dayMs(new Date().toISOString());

  // Index existing OPEN violations by (property, category). Keep the most
  // advanced open case per pair (and, for ties, the most recent). Terminal
  // cases don't protect anything but we remember the latest cert date even if
  // the case later closed — a closed-then-reopened pattern is rare and a closed
  // cert still shouldn't be silently regressed inside its window; we err toward
  // protection.
  const existingByPair = new Map();   // pairKey -> best open violation
  const certDateByPair = new Map();   // pairKey -> latest certified_209 stage date (ms), any status

  for (const v of existingViolations || []) {
    const key = pairKey(v.property_id, v.primary_category_id);

    // Track the latest cert date regardless of open/closed — used for the
    // 180-day protection window.
    if (rankOf(v.current_stage) >= CERT_PROTECTED_MIN_RANK) {
      const d = _dayMs(_stageDateOf(v));
      if (d != null) {
        const prev = certDateByPair.get(key);
        if (prev == null || d > prev) certDateByPair.set(key, d);
      }
    }

    if (isTerminal(v.current_stage)) continue;   // closed cases aren't "the open case"
    const prev = existingByPair.get(key);
    if (!prev) { existingByPair.set(key, v); continue; }
    const better =
      rankOf(v.current_stage) > rankOf(prev.current_stage) ||
      (rankOf(v.current_stage) === rankOf(prev.current_stage) &&
        (_dayMs(_stageDateOf(v)) || 0) > (_dayMs(_stageDateOf(prev)) || 0));
    if (better) existingByPair.set(key, v);
  }

  // Fold incoming Vantaca cert dates into the protection window too — a cert
  // that exists in the Vantaca report but not yet in trustEd must still protect.
  for (const r of resolvedRows || []) {
    if (rankOf(r.stage) >= CERT_PROTECTED_MIN_RANK) {
      const key = pairKey(r.property_id, r.category_id);
      const d = _dayMs(_stageDateOf(r));
      if (d != null) {
        const prev = certDateByPair.get(key);
        if (prev == null || d > prev) certDateByPair.set(key, d);
      }
    }
  }

  const rows = [];
  const blocklist = [];
  const summary = {
    total: 0,
    advance: 0,
    open: 0,
    continue: 0,
    block_regression: 0,
    skip_terminal: 0,
    needs_review: 0,
    cert_protected: 0,
  };

  for (const r of resolvedRows || []) {
    summary.total += 1;
    const key = pairKey(r.property_id, r.category_id);
    const existing = existingByPair.get(key) || null;
    const incomingStage = r.stage || null;

    // Is this pair under a live cert (from either system)?
    const certMs = certDateByPair.get(key) ?? null;
    const certAgeDays = certMs != null ? _daysBetween(asOfMs, certMs) : null;
    const certProtected = certMs != null && certAgeDays >= 0 && certAgeDays <= CERT_VALID_DAYS;
    const certExpiresMs = certMs != null ? certMs + CERT_VALID_DAYS * 24 * 60 * 60 * 1000 : null;

    let action;
    let resultStage = incomingStage;
    let reason;

    if (isTerminal(incomingStage)) {
      // Resolved / void / closed row — records an outcome, never opens a case.
      action = 'skip_terminal';
      resultStage = incomingStage;
      reason = `Vantaca shows this ${incomingStage} — recorded as outcome, no notice.`;
    } else if (!incomingStage) {
      // Unmapped stage (e.g. "Owner Response"). Do NOT default to courtesy_1 —
      // that is exactly the silent-first-notice bug. Flag for a human.
      action = 'needs_review';
      reason = 'Stage not recognized — will not auto-open as a first notice. Review the source row.';
    } else if (certProtected && rankOf(incomingStage) < CERT_PROTECTED_MIN_RANK) {
      // A courtesy notice arriving on a case with a live §209 cert. THE guard.
      action = 'block_regression';
      resultStage = 'certified_209';
      reason =
        `Live certified letter on file (issued ${_fmt(certMs)}, valid through ` +
        `${_fmt(certExpiresMs)} — ${CERT_VALID_DAYS}-day §209 window). ` +
        `Do NOT send a first/second notice; case stays at certified.`;
    } else if (existing) {
      // trustEd already has an open case for this pair. Keep the more-advanced
      // stage; never regress.
      if (rankOf(incomingStage) > rankOf(existing.current_stage)) {
        action = 'advance';
        resultStage = incomingStage;
        reason =
          `Advance existing case ${existing.current_stage} → ${incomingStage} ` +
          `(Vantaca is further along). No duplicate created.`;
      } else {
        action = 'continue';
        resultStage = existing.current_stage;
        reason =
          `trustEd already at ${existing.current_stage} (≥ Vantaca's ${incomingStage}). ` +
          `Recorded as continuation; no new case, no regression.`;
      }
    } else {
      // No existing case, not cert-protected — open at the Vantaca stage.
      action = 'open';
      resultStage = incomingStage;
      reason = `New case opened at ${incomingStage} from Vantaca.`;
    }

    summary[action] += 1;
    if (certProtected) summary.cert_protected += 1;

    const reconciliation = {
      action,
      incoming_stage: incomingStage,
      existing_stage: existing ? existing.current_stage : null,
      existing_violation_id: existing ? (existing.id || null) : null,
      result_stage: resultStage,
      cert_protected: certProtected,
      cert_issued_at: certMs != null ? _fmt(certMs) : null,
      cert_expires_at: certExpiresMs != null ? _fmt(certExpiresMs) : null,
      cert_age_days: certAgeDays,
      reason,
    };
    const annotated = { ...r, reconciliation };
    rows.push(annotated);
    if (action === 'block_regression') blocklist.push(annotated);
  }

  return { rows, blocklist, summary };
}

function _fmt(ms) {
  if (ms == null) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Turn reconciled rows into concrete DB operations. Pure — no I/O — so the
 * import writer just executes this plan and the test can assert the plan
 * without a database. Each annotated row's `.reconciliation.action` maps to
 * exactly one bucket:
 *
 *   open             → insert a new open violation at result_stage
 *   advance          → UPDATE the existing open case up to result_stage
 *   continue         → no DB write (trustEd already ≥ Vantaca); counted only
 *   block_regression → no DB write; the courtesy notice is suppressed because a
 *                      live §209 cert protects the case. Surfaced to the UI.
 *   skip_terminal    → insert a historical (resolved/voided) record, no notice
 *   needs_review     → no DB write; surfaced to staff to resolve the stage
 *
 * @param {Array} reconciledRows  rows annotated by reconcileResolvedRows
 * @returns {{ inserts, updates, continued, blocked, needs_review, terminal }}
 */
function planApply(reconciledRows) {
  const inserts = [];       // rows to INSERT as open violations
  const updates = [];       // { violation_id, current_stage, current_stage_started_at, row }
  const terminal = [];      // historical resolved/voided records to INSERT
  const continued = [];     // no-op (already at/above Vantaca stage)
  const blocked = [];       // suppressed courtesy notices (live cert)
  const needs_review = [];  // unmapped stage — staff must resolve

  for (const r of reconciledRows || []) {
    const rec = r.reconciliation || {};
    switch (rec.action) {
      case 'open':
        inserts.push({ row: r, current_stage: rec.result_stage });
        break;
      case 'advance':
        updates.push({
          violation_id: rec.existing_violation_id,
          current_stage: rec.result_stage,
          current_stage_started_at: r.opened_at,
          row: r,
        });
        break;
      case 'skip_terminal':
        terminal.push({ row: r, current_stage: rec.result_stage });
        break;
      case 'continue':
        continued.push(r);
        break;
      case 'block_regression':
        blocked.push(r);
        break;
      case 'needs_review':
      default:
        needs_review.push(r);
        break;
    }
  }
  return { inserts, updates, terminal, continued, blocked, needs_review };
}

module.exports = {
  STAGE_RANK,
  TERMINAL_STAGES,
  CERT_VALID_DAYS,
  CERT_PROTECTED_MIN_RANK,
  rankOf,
  isTerminal,
  pairKey,
  reconcileResolvedRows,
  planApply,
};
