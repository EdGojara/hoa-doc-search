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
          cure_days: 21,
          requires_hearing: false,
          rationale: `Courtesy 1 cure period expired without remedy. Bumping to Courtesy 2 (regular mail, 21-day cure).`,
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
      case 'certified_209':
        return {
          should_open: true,
          stage: 'fine_assessed',
          mail_type: 'certified_mail',
          cure_days: 0,
          requires_hearing: true,
          rationale: `Certified §209 notice cure period expired. Hearing required under TX §209.0064 before fine becomes valid.`,
        };
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

  // Count prior violations of any stage (cured ones still count toward the
  // repeat-offender signal — the issue keeps coming back).
  const priorCount = priorViolations.length;
  // Did any prior reach certified or fine stages? Signals chronic.
  const everCertified = priorViolations.some(
    (v) => v.current_stage === 'certified_209' || v.current_stage === 'fine_assessed'
  );

  if (priorityWeight === 'aggressive') {
    if (priorCount === 0) {
      return {
        should_open: true,
        stage: 'courtesy_2',
        mail_type: 'first_class_mail',
        cure_days: 14,
        requires_hearing: false,
        rationale: `Aggressive enforcement priority. Opening directly at Courtesy 2 with shortened 14-day cure (board has authorized fast-track for this category).`,
      };
    }
    return {
      should_open: true,
      stage: 'certified_209',
      mail_type: 'certified_mail',
      cure_days: 30,
      requires_hearing: false,
      rationale: `Aggressive priority + ${priorCount} prior violation${priorCount === 1 ? '' : 's'} in 12 months. Opening at TX §209 certified-mail notice.`,
    };
  }

  if (priorityWeight === 'elevated') {
    if (priorCount === 0) {
      return {
        should_open: true,
        stage: 'courtesy_1',
        mail_type: 'first_class_mail',
        cure_days: 21,
        requires_hearing: false,
        rationale: `First violation in 12 months for this category. Elevated priority → 21-day cure (vs standard 30).`,
      };
    }
    if (priorCount === 1) {
      return {
        should_open: true,
        stage: 'courtesy_2',
        mail_type: 'first_class_mail',
        cure_days: 21,
        requires_hearing: false,
        rationale: `2nd violation of this category in 12 months under elevated priority. Opening at Courtesy 2.`,
      };
    }
    return {
      should_open: true,
      stage: 'certified_209',
      mail_type: 'certified_mail',
      cure_days: 30,
      requires_hearing: false,
      rationale: `${priorCount + 1}th violation of this category in 12 months. Elevated priority + repeat offender → certified §209 notice.`,
    };
  }

  // priorityWeight === 'standard' (default)
  if (priorCount === 0) {
    return {
      should_open: true,
      stage: 'courtesy_1',
      mail_type: 'first_class_mail',
      cure_days: 30,
      requires_hearing: false,
      rationale: `First violation of this category in 12 months. Standard 30-day courtesy notice via regular mail.`,
    };
  }
  if (priorCount === 1) {
    return {
      should_open: true,
      stage: 'courtesy_2',
      mail_type: 'first_class_mail',
      cure_days: 30,
      requires_hearing: false,
      rationale: `2nd violation of this category in 12 months. Courtesy 2 via regular mail with 30-day cure.`,
    };
  }
  if (priorCount === 2) {
    return {
      should_open: true,
      stage: 'certified_209',
      mail_type: 'certified_mail',
      cure_days: 30,
      requires_hearing: false,
      rationale: `3rd violation of this category in 12 months. Escalating to TX §209 certified-mail notice (return receipt required) to preserve the right to fine.`,
    };
  }
  // 4+ priors → certified notice + hearing
  return {
    should_open: true,
    stage: 'certified_209',
    mail_type: 'certified_mail',
    cure_days: 30,
    requires_hearing: true,
    rationale: `${priorCount + 1}th violation of this category in 12 months${everCertified ? ' (with prior certified notice on record)' : ''}. Certified §209 notice; hearing required under TX §209.0064 before any fine becomes valid.`,
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
