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

// A staffer can also SPLIT one bill across accounts:
//   "$700.00 to GL Code 5130
//    $485.22 to GL Code 5140"
//
// matchGlDirective cannot express that. It returns ONE account and the caller
// applies it to the whole invoice. Worse, it finds that account by walking the
// community's CHART and returning the first number that appears anywhere in the
// note — so with two codes present, which one wins is decided by chart ordering,
// not by what the staffer wrote. (Ed 2026-08-18, Lake Pro #262093: Celina asked
// for 700.00 to 5130 and 485.22 to 5140; the whole $1,185.22 landed in 5130
// because 5130 sits at chart position 35 and 5140 at 36.)
//
// This is the SECOND time this scar has fired — the header above already records
// the Water Logic #21245 miss — so it is enforced by tests/test_staff_directives.js
// rather than by another paragraph.
//
// Returns null unless there are at least TWO amount->account pairs, so a single
// "code to 5125" keeps flowing through matchGlDirective unchanged. Every account
// must exist on the community's real chart; a pair naming an unknown code makes
// the whole split null rather than silently dropping a line, because a partial
// split would post an unbalanced bill.
function matchGlSplitDirective(text, accounts) {
  if (!text || !Array.isArray(accounts) || !accounts.length) return null;
  const byNum = new Map(accounts.map((a) => [String(a.account_number).trim(), a]));

  // "$700.00 to GL Code 5130" / "485.22 -> 5140" / "$1,000 = 5120"
  // The amount pattern requires PROPER thousands grouping. A loose [\d,]+ reads
  // the trailing "Total invoice $1,185.22" as amount "1," + account "185", and
  // since 185 is on no chart the unknown-code guard below then refused the whole
  // split. That is how this parser returned null on the very note it was written
  // for. (Ed 2026-08-18.)
  const re = /\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(?:->|to|for|[-–—=:])?\s*(?:gl\s*)?(?:code|account|acct)?\s*#?\s*(\d{3,6})\b/gi;
  const pairs = [];
  let m;
  while ((m = re.exec(String(text))) !== null) {
    const cents = Math.round(parseFloat(String(m[1]).replace(/,/g, '')) * 100);
    const acct = byNum.get(String(m[2]).trim());
    if (!Number.isFinite(cents) || cents <= 0) continue;
    if (!acct) return null;                       // unknown code -> refuse the whole split
    pairs.push({
      amount_cents: cents,
      account_id: acct.id,
      account_number: acct.account_number,
      account_name: acct.account_name,
    });
  }
  if (pairs.length < 2) return null;

  // Same account twice in one note is a staffer correcting themselves mid-line,
  // not a split. Collapse rather than double-post.
  const merged = [];
  for (const p of pairs) {
    const hit = merged.find((x) => x.account_id === p.account_id);
    if (hit) hit.amount_cents += p.amount_cents; else merged.push({ ...p });
  }
  if (merged.length < 2) return null;

  return { lines: merged, total_cents: merged.reduce((s, p) => s + p.amount_cents, 0), matched_by: 'amount_split' };
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

module.exports = { parseStaffDirectives, matchGlDirective, matchGlSplitDirective, matchCommunityDirective, matchVendorDirective, _norm: norm };
