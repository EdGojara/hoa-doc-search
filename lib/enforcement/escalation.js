// ============================================================================
// escalation.js — Bedrock's enforcement decision engine
// ----------------------------------------------------------------------------
// Given:
//   1. A property's enforcement history (prior violations in last 12 months)
//   2. The community's priority weight for the violation category
//   3. Whether this is a cure-lapse (existing violation aging up) or fresh
//
// Returns the recommended:
//   - opening stage (courtesy_1 / courtesy_2 / certified_209 / fine_assessed)
//   - mail delivery method (first_class_mail / certified_mail / in_person)
//   - cure period in days
//   - whether a TX §209.0064 hearing is required
//   - rationale (human-readable explanation for board defensibility)
//
// This file encodes Ed's enforcement judgment as a pure function so:
//   - The same rule fires for every property in every community
//     ("consistent enforcement = fair-housing defensibility")
//   - The rationale is recorded with each violation, so boards can later
//     answer "why did this property get certified mail?" by reading the
//     rationale, not by digging through manager-call notes.
//   - Future modules (DRV letter generator, fine queue, hearing scheduler)
//     can call this same logic.
//
// Texas §209 reference: when fines are assessed, the homeowner must have
// received written notice via CERTIFIED MAIL, return receipt requested,
// before the fine becomes valid. Bedrock's standard practice ratchets a
// 2nd same-category violation in 12 months straight to certified mail so
// the legal precondition is always satisfied before a fine queue.
//
// Priority weights (set per community per category in
// community_enforcement_priorities):
//   'standard'    — typical HOA (most communities)
//   'elevated'    — board has signaled tighter enforcement
//   'aggressive'  — bypass courtesy stages; jump to formal notices fast
//   'disabled'    — board has voted NOT to enforce this category (rare)
// ============================================================================

/**
 * Decide the appropriate enforcement stage for a violation.
 *
 * @param {Object} input
 * @param {Array}  input.prior_violations - Array of prior violation rows
 *                                          with { opened_at, category_id, current_stage }
 *                                          for THIS property + THIS category
 *                                          (caller filters to last 12 months).
 * @param {string} input.priority_weight  - 'standard' | 'elevated' | 'aggressive' | 'disabled'
 * @param {boolean} [input.is_cure_lapse=false] - true if we're bumping an EXISTING
 *                                                 violation whose cure period expired
 *                                                 uncured (used by the daily cron).
 * @param {string} [input.current_stage]  - For cure lapses, the stage we're bumping FROM.
 * @returns {Object} decision
 *   {
 *     should_open: boolean,        // false when priority is 'disabled'
 *     stage: string,                // opening stage (or new stage for cure lapse)
 *     mail_type: string,            // 'first_class_mail' | 'certified_mail' | 'in_person'
 *     cure_days: number,            // how long the owner has to fix it
 *     requires_hearing: boolean,    // TX §209.0064 hearing required before fine
 *     rationale: string,            // human-readable reason — recorded on the violation
 *   }
 */
function decideEscalation(input) {
  const priorViolations = Array.isArray(input.prior_violations) ? input.prior_violations : [];
  const priorityWeight = input.priority_weight || 'standard';
  const isCureLapse = !!input.is_cure_lapse;
  const currentStage = input.current_stage || null;

  // Disabled categories: do nothing.
  if (priorityWeight === 'disabled') {
    return {
      should_open: false,
      stage: null,
      mail_type: null,
      cure_days: 0,
      requires_hearing: false,
      rationale: 'Board has voted to disable enforcement for this category. No action taken.',
    };
  }

  // ---- Cure lapse path: bumping an existing violation up the stages -------
  // Used by a daily cron (or evaluated at letter-send time) when a violation's
  // cure_period_ends_at has passed and the violation isn't resolved.
  if (isCureLapse && currentStage) {
    switch (currentStage) {
      case 'courtesy_1':
        return {
          should_open: true,
          stage: 'courtesy_2',
          mail_type: 'first_class_mail',
          cure_days: 20,
          requires_hearing: false,
          rationale: `Courtesy 1 cure period expired without remedy. Bumping to Courtesy 2 (regular mail, 20-day cure).`,
        };
      case 'courtesy_2':
        return {
          should_open: true,
          stage: 'certified_209',
          mail_type: 'certified_mail',
          cure_days: 30,
          requires_hearing: false,
          rationale: `Courtesy 2 cure period expired. Escalating to TX §209 certified-mail notice (return receipt required) before any fine.`,
        };
      case 'certified_209': {
        // Phase 7c: Respect the community + per-category fine schedule.
        // Most TX HOAs have a fine schedule in the CC&Rs but the board has
        // historically declined to fine. If fines aren't actively authorized
        // for THIS community + category, the violation STAYS at certified_209
        // and gets flagged for board attention. Staff can manually assess
        // fines with explicit board approval.
        const finesAllowed = input.community_fines_enabled === true &&
                              input.category_fines_enabled === true &&
                              (typeof input.fine_amount === 'number' && input.fine_amount > 0);
        if (!finesAllowed) {
          let why;
          if (input.community_fines_enabled === false) {
            why = `Board has not authorized fine enforcement for this community.`;
          } else if (input.category_fines_enabled === false) {
            why = `Board has not authorized fine enforcement for this category.`;
          } else {
            why = `No fine amount on the community's fine schedule for this category.`;
          }
          return {
            should_open: false,
            stage: 'certified_209',
            mail_type: null,
            cure_days: 0,
            requires_hearing: true,
            rationale: `Certified §209 notice cure period expired. ${why} Violation remains at certified_209 — flag for board review if manual fine is needed.`,
            needs_board_review: true,
          };
        }
        return {
          should_open: true,
          stage: 'fine_assessed',
          mail_type: 'certified_mail',
          cure_days: 0,
          requires_hearing: true,
          rationale: `Certified §209 notice cure period expired. Fine of $${input.fine_amount.toFixed(2)} assessed per board fine schedule. Hearing required under TX §209.0064 before fine becomes final.`,
          fine_amount: input.fine_amount,
        };
      }
      default:
        return {
          should_open: false,
          stage: currentStage,
          mail_type: null,
          cure_days: 0,
          requires_hearing: false,
          rationale: `Violation is in terminal stage (${currentStage}); no further escalation.`,
        };
    }
  }

  // ---- Fresh violation path: opening stage based on 12-month history ------
  //
  // Phase 7b: WEIGHTED count, not raw count. Each prior contributes its
  // confidence_weight (default 1.0 for trustEd-native and vantaca_import,
  // 0.3 for predecessor_import, 0 for superseded). The discount only
  // applies to data we took over from a DIFFERENT management firm —
  // Vantaca-imported rows are Bedrock's own historical inspections from
  // before trustEd existed and weigh the same as native rows. (Updated
  // Ed 2026-06-13 from prior 0.5 vantaca discount + migration 221 to
  // back-fill existing rows.)
  //
  // Thresholds (using weighted sum):
  //   < 1.0   → effectively "no prior" → courtesy_1
  //   1.0-1.99 → "1 prior" → courtesy_2
  //   2.0+    → "2+ priors" → certified_209
  //
  // Examples:
  //   1 trustEd or vantaca prior (1.0)        → courtesy_2  ✓
  //   2 priors (any mix of 1.0 weights = 2.0) → certified_209  ✓
  //   1 predecessor-import prior (0.3)         → courtesy_1  (still under threshold)
  //   3 predecessor-import (0.3*3=0.9)         → courtesy_1
  //   2 trustEd + 1 predecessor (2.0+0.3=2.3) → certified_209
  //
  // Superseded violations (post-correction) contribute 0 — they're factually
  // wrong and shouldn't count toward escalation, but the row stays for audit.
  //
  // Each input row may carry confidence_weight + quality_status; if not present
  // (older callers), defaults to weight=1.0 (matches v1 behavior).

  const weightFor = (v) => {
    if (v.quality_status === 'superseded') return 0;
    if (typeof v.confidence_weight === 'number') return Math.max(0, Math.min(1, v.confidence_weight));
    return 1.0;  // legacy callers that don't pass weight get full count
  };
  const priorWeightedSum = priorViolations.reduce((acc, v) => acc + weightFor(v), 0);
  const priorCount = priorViolations.length;  // raw count for rationale display
  // Did any prior reach certified or fine stages? Signals chronic. Weight-aware.
  const everCertified = priorViolations.some(
    (v) => (v.current_stage === 'certified_209' || v.current_stage === 'fine_assessed') && weightFor(v) > 0
  );

  // Format the weighted sum for the rationale ("weighted: 1.5" vs "1 prior")
  const wSumLabel = priorWeightedSum.toFixed(1);
  const lowTrustPriors = priorViolations.filter((v) => v.source && v.source !== 'trustEd_native').length;
  const lowTrustNote = lowTrustPriors > 0
    ? ` (${lowTrustPriors} of ${priorCount} are unverified/imported — counted at reduced weight)`
    : '';

  if (priorityWeight === 'aggressive') {
    if (priorWeightedSum < 1.0) {
      return {
        should_open: true,
        stage: 'courtesy_2',
        mail_type: 'first_class_mail',
        cure_days: 14,
        requires_hearing: false,
        rationale: `Aggressive enforcement priority. Opening directly at Courtesy 2 with shortened 14-day cure (board has authorized fast-track for this category).${lowTrustNote}`,
      };
    }
    return {
      should_open: true,
      stage: 'certified_209',
      mail_type: 'certified_mail',
      cure_days: 30,
      requires_hearing: false,
      rationale: `Aggressive priority + ${priorCount} prior violation${priorCount === 1 ? '' : 's'} in 12 months (weighted: ${wSumLabel}). Opening at TX §209 certified-mail notice.${lowTrustNote}`,
    };
  }

  if (priorityWeight === 'elevated') {
    if (priorWeightedSum < 1.0) {
      return {
        should_open: true,
        stage: 'courtesy_1',
        mail_type: 'first_class_mail',
        cure_days: 20,
        requires_hearing: false,
        rationale: `Effectively first violation in 12 months for this category (weighted: ${wSumLabel}). Elevated priority → 20-day cure.${lowTrustNote}`,
      };
    }
    if (priorWeightedSum < 2.0) {
      return {
        should_open: true,
        stage: 'courtesy_2',
        mail_type: 'first_class_mail',
        cure_days: 20,
        requires_hearing: false,
        rationale: `${priorCount} prior${priorCount === 1 ? '' : 's'} in 12 months (weighted: ${wSumLabel}) under elevated priority. Opening at Courtesy 2.${lowTrustNote}`,
      };
    }
    return {
      should_open: true,
      stage: 'certified_209',
      mail_type: 'certified_mail',
      cure_days: 30,
      requires_hearing: false,
      rationale: `${priorCount} prior${priorCount === 1 ? '' : 's'} in 12 months (weighted: ${wSumLabel}). Elevated priority + repeat offender → certified §209 notice.${lowTrustNote}`,
    };
  }

  // priorityWeight === 'standard' (default)
  if (priorWeightedSum < 1.0) {
    return {
      should_open: true,
      stage: 'courtesy_1',
      mail_type: 'first_class_mail',
      cure_days: 20,
      requires_hearing: false,
      rationale: `Effectively first violation of this category in 12 months (weighted: ${wSumLabel}). Standard 20-day courtesy notice via regular mail.${lowTrustNote}`,
    };
  }
  if (priorWeightedSum < 2.0) {
    return {
      should_open: true,
      stage: 'courtesy_2',
      mail_type: 'first_class_mail',
      cure_days: 20,
      requires_hearing: false,
      rationale: `${priorCount} prior${priorCount === 1 ? '' : 's'} in 12 months (weighted: ${wSumLabel}). Courtesy 2 via regular mail with 20-day cure.${lowTrustNote}`,
    };
  }
  if (priorWeightedSum < 3.0) {
    return {
      should_open: true,
      stage: 'certified_209',
      mail_type: 'certified_mail',
      cure_days: 30,
      requires_hearing: false,
      rationale: `${priorCount} prior${priorCount === 1 ? '' : 's'} in 12 months (weighted: ${wSumLabel}). Escalating to TX §209 certified-mail notice (return receipt required) to preserve the right to fine.${lowTrustNote}`,
    };
  }
  // 3.0+ weighted priors → certified notice + hearing
  return {
    should_open: true,
    stage: 'certified_209',
    mail_type: 'certified_mail',
    cure_days: 30,
    requires_hearing: true,
    rationale: `${priorCount} prior${priorCount === 1 ? '' : 's'} in 12 months (weighted: ${wSumLabel})${everCertified ? ' (with prior certified notice on record)' : ''}. Certified §209 notice; hearing required under TX §209.0064 before any fine becomes valid.${lowTrustNote}`,
  };
}

/**
 * Filter a list of violation rows to those opened in the last N months
 * for a given category. Convenience for callers building input.prior_violations.
 */
function filterRecentSameCategory(allViolations, categoryId, months = 12) {
  if (!Array.isArray(allViolations) || !categoryId) return [];
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  return allViolations.filter((v) => {
    if (v.primary_category_id !== categoryId) return false;
    if (!v.opened_at) return false;
    return new Date(v.opened_at) >= cutoff;
  });
}

module.exports = {
  decideEscalation,
  filterRecentSameCategory,
};
