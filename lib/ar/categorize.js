// ============================================================================
// lib/ar/categorize.js — Vantaca description → legal-grade category mapping
// ----------------------------------------------------------------------------
// Ed 2026-06-08 — Categorize ledger lines so amenity access decisions don't
// trip over composition. Same balance can mean "deny pool" or "allow pool"
// depending on whether it's assessments or fines.
//
// Pattern-matched on description text. Tested against real Vantaca exports
// (Quail Ridge ingest 2026-06-08). Extend as new patterns are seen.
//
// FALLBACK: if no pattern matches, returns 'other'. Operator can override
// via the AR ledger UI.
// ============================================================================

const CATEGORY_PATTERNS = [
  // Most specific patterns first — order matters.

  // Prior balance / opening
  { re: /\b(prior\s+balance|opening\s+balance|brought\s+forward|carry\s+over)\b/i, category: 'prior_balance' },

  // Assessments (most common; many variants)
  { re: /\bspecial\s+assessment\b/i,                         category: 'assessment' },
  { re: /\bannual\s+assessment\b/i,                          category: 'assessment' },
  { re: /\bmonthly\s+assessment\b/i,                         category: 'assessment' },
  { re: /\bquarterly\s+assessment\b/i,                       category: 'assessment' },
  { re: /\bregular\s+assessment\b/i,                         category: 'assessment' },
  { re: /\bsemi[\-\s]*annual\s+assessment\b/i,               category: 'assessment' },
  { re: /\bassessment\b/i,                                   category: 'assessment' },
  { re: /\bdues\b/i,                                         category: 'assessment' },

  // Late fees — flat charges for being late
  { re: /\blate\s+fee/i,                                     category: 'late_fee' },
  { re: /\blf\s*charge/i,                                    category: 'late_fee' },

  // Interest — accruing charges on past-due
  { re: /\blate\s+interest/i,                                category: 'interest' },
  { re: /\binterest\s+(?:on|charge)/i,                       category: 'interest' },
  { re: /\binterest\b/i,                                     category: 'interest' },

  // Attorney / legal fees
  { re: /\battorney\s+fee/i,                                 category: 'attorney_fee' },
  { re: /\blegal\s+fee/i,                                    category: 'attorney_fee' },
  { re: /\bcollection\s+fee/i,                               category: 'attorney_fee' },

  // Admin / processing fees (certified letters, transfer fees, etc.)
  { re: /\bcertified\s+letter/i,                             category: 'admin_fee' },
  { re: /\bcertified\s+mail/i,                               category: 'admin_fee' },
  { re: /\btransfer\s+fee/i,                                 category: 'admin_fee' },
  { re: /\bresale\s+certificate/i,                           category: 'admin_fee' },
  { re: /\brecords?\s+request/i,                             category: 'admin_fee' },
  { re: /\bestoppel\b/i,                                     category: 'admin_fee' },
  { re: /\bnsf\b/i,                                          category: 'admin_fee' },
  { re: /\breturned\s+check/i,                               category: 'admin_fee' },

  // Fines (violation-related, NOT assessment-related)
  { re: /\bfine\b/i,                                         category: 'fine' },
  { re: /\bviolation\s+fee/i,                                category: 'fine' },
  { re: /\bccr\s+violation/i,                                category: 'fine' },
  { re: /\bdrv\b/i,                                          category: 'fine' },

  // Payments — usually have type='payment' already but description may indicate
  { re: /\b(chk|check)\s*#?\s*\d+/i,                         category: 'payment' },
  { re: /\bach\s+payment/i,                                  category: 'payment' },
  { re: /\bonline\s+payment/i,                               category: 'payment' },
  { re: /\bpayment\b/i,                                      category: 'payment' },
  { re: /\bach\b/i,                                          category: 'payment' },

  // Credits + refunds
  { re: /\brefund\b/i,                                       category: 'refund' },
  { re: /\bcredit\b/i,                                       category: 'credit' },
  { re: /\bwrite[\-\s]*off/i,                                category: 'credit' },

  // Adjustments
  { re: /\badjustment\b/i,                                   category: 'adjustment' },
  { re: /\badj\b/i,                                          category: 'adjustment' },
];

/**
 * Categorize a transaction description into a legal-grade charge category.
 * Returns 'other' if no pattern matches.
 *
 * @param {string} description - The ledger line description from Vantaca.
 * @param {{ txn_type?: string, amount_cents?: number }} [opts]
 *   Optional context. If txn_type === 'payment' and no other pattern matches,
 *   defaults to 'payment'. Signed amount (negative = payment) helps too.
 * @returns {string} One of the allowed CHECK values.
 */
function categorizeChargeDescription(description, opts = {}) {
  const desc = String(description || '').trim();
  if (!desc) {
    // No description — fall back on amount sign + type
    if (opts.txn_type === 'payment' || (opts.amount_cents != null && opts.amount_cents < 0)) {
      return 'payment';
    }
    return 'other';
  }

  for (const p of CATEGORY_PATTERNS) {
    if (p.re.test(desc)) return p.category;
  }

  // Final fallback by type/sign
  if (opts.txn_type === 'payment' || opts.txn_type === 'credit') return opts.txn_type;
  if (opts.amount_cents != null && opts.amount_cents < 0) return 'payment';
  return 'other';
}

module.exports = { categorizeChargeDescription, CATEGORY_PATTERNS };
