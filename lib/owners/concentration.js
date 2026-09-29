// ============================================================================
// lib/owners/concentration.js — the owner-collapse rule, one definition
// ----------------------------------------------------------------------------
// Moved out of scripts/check_owner_concentration.js (Issue #6, 2026-09-29) so
// the npm-test guard and the /app/owners page flag the SAME contacts.
//
// Background (Ed 2026-07-20): a "Current Resident" export + dedupe-by-name once
// collapsed 62 Lakes of Pine Forest owners onto one contact, who then received
// violation letters meant for real owners. Builders and investors legitimately
// own many homes; a private individual owning THRESHOLD+ is a likely collapse.
// ============================================================================
const THRESHOLD = 8; // a private individual owning 8+ homes in the portfolio is suspicious
const CORPORATE = /\b(LLC|L\.L\.C|INC|CORP|CO\.|COMPANY|HOMES?|PROPERT(Y|IES)|TRUST|RENT|RENTALS?|MANAGEMENT|BORROWER|GROUP|HOLDINGS?|CAPITAL|INVESTMENTS?|INVESTOR|PARTNERS?|REALTY|BUILDERS?|DEVELOPMENT|ASSOCIATES?|ENTERPRISES?|VENTURES?|FUND|REIT|LP|LTD|BANK|HOA|ASSOCIATION)\b/i;
const EMAIL_THRESHOLD_INDIVIDUAL = 5; // a private person with 5+ distinct emails on file is suspicious
const EMAIL_THRESHOLD_ANY = 15;       // even a builder/LLC shouldn't hold 15+ — that's a collapse

const isCorporateName = (name) => CORPORATE.test(String(name || ''));

module.exports = { THRESHOLD, CORPORATE, EMAIL_THRESHOLD_INDIVIDUAL, EMAIL_THRESHOLD_ANY, isCorporateName };
