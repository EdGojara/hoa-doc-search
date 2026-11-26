// ============================================================================
// lib/email/salutation.js  (Ed 2026-11-26)
// ----------------------------------------------------------------------------
// WHO WE GREET. Scar: WAT-ARC-2026-0054's receipt opened "Hi Open," because the
// applicant is "Open House Texas Realty & Investments LLC" and the code took the
// first word of whatever name it had. A greeting uses a person's first name only
// when the name is a person's; a company, a trust or anything unverified gets a
// neutral "Hello,". Never guess a first name from an email address.
//
//   isOrganizationName(name) -> boolean
//   personFirstNames(name)   -> "Maria" | "Simon and Maria" | null
//   greeting(name, { casual }) -> "Hi Maria," | "Hello,"
// ============================================================================
const ORG = /\b(llc|l\.l\.c|inc|incorporated|corp|corporation|co\b|company|ltd|limited|lp|llp|pllc|pc|trust|trustee|estate of|properties|property|realty|real estate|investments?|holdings?|group|partners|partnership|homes|builders?|construction|management|association|hoa|services|enterprises|ventures|capital|fund|bank|church|ministries|foundation|rentals?|leasing|opendoor|offerpad|invitation homes|american homes)\b/i;
const TITLE = /^(mr|mrs|ms|dr|mx|miss)\.?\s+/i;

function isOrganizationName(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  return ORG.test(n) || /[&@]/.test(n.replace(/\s&\s(?=[A-Z][a-z]+\s+[A-Z])/g, ' and ')) && ORG.test(n);
}

function looksLikeFirstName(w) {
  return /^[A-Za-z][A-Za-z'\-]{1,}$/.test(w || '') && !/^(homeowner|owner|resident|tenant|unknown|na|n\/a)$/i.test(w);
}

function personFirstNames(name) {
  const n = String(name || '').trim();
  if (!n || isOrganizationName(n)) return null;
  const parts = n.split(/\s+(?:and|&|\+)\s+/i);
  if (parts.length === 2) {
    const a = parts[0].replace(TITLE, '').trim().split(/\s+/)[0];
    const b = parts[1].replace(TITLE, '').trim().split(/\s+/)[0];
    if (looksLikeFirstName(a) && looksLikeFirstName(b)) return `${a} and ${b}`;
  }
  const first = n.replace(TITLE, '').trim().split(/\s+/)[0];
  return looksLikeFirstName(first) ? first : null;
}

function greeting(name, { casual = true } = {}) {
  const f = personFirstNames(name);
  return f ? `${casual ? 'Hi' : 'Dear'} ${f},` : 'Hello,';
}

module.exports = { isOrganizationName, personFirstNames, greeting };
