// ============================================================================
// lib/ap/staff_directives.js  (Ed 2026-07-31)
// ----------------------------------------------------------------------------
// When a Bedrock STAFFER forwards a vendor bill to emma@ with instructions —
// "Upload invoice for Waterview Estates, vendor is Water Logic, code to 5125" —
// that note is an explicit directive from a colleague. Emma must EXECUTE it, not
// re-guess. This was the Water Logic #21245 miss: Celina wrote "code to 5125"
// and Emma still guessed 5120, AND the vendor line was ignored while Emma
// fuzzy-matched a retired pool vendor.
//
// Deterministic on purpose (no model call, so it's testable and never invents an
// account): the GL account is matched against the community's REAL chart — by
// number ("5125") OR by its actual name ("Irrigation Repair & Maintenance") — so
// a staffer can write either. Community + vendor are pulled with tight patterns.
//
// ONLY applied for internal senders (isStaffSender). An external vendor's email
// is data, never a directive — a vendor must not be able to tell Emma which GL
// account to hit or which community to bill.
// ============================================================================

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

// A staffer's note names a GL account either by number or by its real name.
// Match against THIS community's chart so we can only ever land on a real
// account — never a hallucinated one. Number match is strongest; a full-name
// match is accepted only when the account's distinctive name appears in the note
// (so "Water" alone can't pull in "5120 Water").
function matchGlDirective(text, accounts) {
  if (!text || !Array.isArray(accounts) || !accounts.length) return null;
  const t = ' ' + norm(text) + ' ';
  // 1) explicit account-number token, e.g. "code to 5125" / "gl 5125"
  for (const a of accounts) {
    const num = norm(a.account_number);
    if (num && t.includes(' ' + num + ' ')) {
      return { account_id: a.id, account_number: a.account_number, account_name: a.account_name, matched_by: 'number' };
    }
  }
  // 2) the account's full name appears (normalized substring), e.g.
  //    "code to irrigation repair & maintenance". Require >= 2 words so a
  //    single generic word can't match.
  let best = null;
  for (const a of accounts) {
    const name = norm(a.account_name);
    if (!name || name.split(' ').length < 2) continue;
    if (t.includes(' ' + name + ' ') || t.includes(' ' + name)) {
      if (!best || name.length > norm(best.account_name).length) {
        best = { account_id: a.id, account_number: a.account_number, account_name: a.account_name, matched_by: 'name' };
      }
    }
  }
  return best;
}

// Which community did the staffer name? Match the note against known community
// names (normalized). Longest match wins so "Waterview Estates" beats a stray
// "Estates". Returns the community row or null.
function matchCommunityDirective(text, communities) {
  if (!text || !Array.isArray(communities)) return null;
  const t = ' ' + norm(text) + ' ';
  let best = null;
  for (const c of communities) {
    const n = norm(c.name);
    if (n && n.split(' ').length >= 1 && t.includes(' ' + n + ' ')) {
      if (!best || n.length > norm(best.name).length) best = c;
    }
  }
  return best;
}

// The staffer may name the vendor ("vendor is Water Logic, Inc"). Tight pattern
// so we only capture an explicit vendor statement, not prose. Returns a trimmed
// name string or null. (Used only as a resolution HINT — the bill's own printed
// vendor name still leads; see autoIntake.)
function matchVendorDirective(text) {
  if (!text) return null;
  const m = String(text).match(/\bvendor\s*(?:is|:|=|=>|-)\s*([A-Za-z0-9][A-Za-z0-9 ,.&'()\/-]{1,60})/i);
  if (!m) return null;
  // Stop at a sentence break / newline that the char class already excludes;
  // trim trailing filler words.
  return m[1].replace(/\s+(please|thanks|thank you|kind regards|regards)\b.*$/i, '').replace(/[\s,.-]+$/, '').trim() || null;
}

// Parse all directives from a staff note in one shot. `accounts` is THIS
// community's chart (resolve the community first); `communities` is the master
// list for the community directive.
function parseStaffDirectives({ text, accounts = [], communities = [], isStaffSender = false }) {
  if (!isStaffSender || !text || !String(text).trim()) return { applies: false };
  return {
    applies: true,
    gl: matchGlDirective(text, accounts),
    community: matchCommunityDirective(text, communities),
    vendor_name: matchVendorDirective(text),
  };
}

module.exports = { parseStaffDirectives, matchGlDirective, matchCommunityDirective, matchVendorDirective, _norm: norm };
