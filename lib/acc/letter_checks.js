// ============================================================================
// lib/acc/letter_checks.js  (Issue #14, Ed 2026-10-02)
// ----------------------------------------------------------------------------
// Deterministic checks on the numbered CONDITIONS of a drafted ACC letter,
// run on every generated draft (engine first draft, re-review draft, redraft).
// The prompts carry the same rules, but a prompt rule is not a control: the
// engine already had today's date and still wrote an expired one.
//
//   1. EXPIRED DATES. A condition that puts a date already in the past (by the
//      review date) in a future-facing role ("let us know if completion
//      extends beyond <a date already past>") is removed. No
//      replacement deadline is invented.
//   2. NO MANUFACTURED BOILERPLATE. A permit / licensing / insurance /
//      liability condition is removed unless it cites a governing provision
//      or adopted policy in the condition itself, or the staff instructions
//      ask for it. "Sounds prudent" is not a basis.
//
// Removed items are returned (never silently lost) so they can be recorded in
// the internal review provenance. Staff can still type any condition by hand.
// Nothing community-, case- or date-specific is hard-coded.
// ============================================================================

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const FUTURE_FACING = /\b(beyond|by|before|no later than|until|extend(?:s|ed)?|complet(?:e|ed|ion)|deadline|within|prior to|notify|timeline|timeframe)\b/i;
const BOILERPLATE = /\b(permits?|permitting|licen[sc](?:e|ed|es|ing)|insurance|insured|liabilit(?:y|ies)|indemnif\w*|hold harmless|building codes?|code compliance|solely responsible)\b/i;
const BASIS = /\b(section|article|§|declaration|cc&rs?|covenants?|guidelines|bylaws|policy|rules and regulations)\b/i;

// Calendar date (UTC midnight) in America/Chicago for a Date/ISO string.
function centralDay(d) {
  const s = new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  return Date.parse(s + 'T00:00:00Z');
}

// Every date written in the text, as UTC-midnight timestamps.
function datesIn(text) {
  const out = [];
  const t = String(text || '');
  for (const m of t.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi)) {
    out.push(Date.UTC(Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2])));
  }
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) out.push(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])));
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.push(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return out.filter((x) => !Number.isNaN(x));
}

// Split a letter into lines, grouping each numbered item with its continuation
// lines (until a blank line or the next numbered item).
function parseItems(text) {
  const lines = String(text || '').split(/\r?\n/);
  const blocks = []; let cur = null;
  for (const line of lines) {
    const m = /^(\s*)(\d{1,2})([.)])\s+(.*)$/.exec(line);
    if (m) { cur = { kind: 'item', indent: m[1], sep: m[3], lines: [m[4]] }; blocks.push(cur); continue; }
    if (cur && cur.kind === 'item' && line.trim() !== '') { cur.lines.push(line.trim()); continue; }
    cur = null; blocks.push({ kind: 'line', line });
  }
  return blocks;
}

function classify(itemText, { reviewDay, staffInstructions }) {
  const past = datesIn(itemText).filter((d) => d < reviewDay);
  if (past.length && FUTURE_FACING.test(itemText)) return 'expired_date';
  const bp = BOILERPLATE.exec(itemText);
  if (bp && !BASIS.test(itemText)) {
    const asked = staffInstructions && new RegExp(bp[1].replace(/s$/, ''), 'i').test(staffInstructions);
    if (!asked) return 'unsupported_boilerplate';
  }
  return null;
}

// -> { text, removed: [{ item, reason }] }
function pruneConditions(letter, { reviewDate = new Date(), staffInstructions = '' } = {}) {
  const reviewDay = centralDay(reviewDate);
  const blocks = parseItems(letter);
  const removed = []; let n = 0; const out = [];
  for (const b of blocks) {
    if (b.kind === 'line') { out.push(b.line); continue; }
    const itemText = b.lines.join(' ');
    const reason = classify(itemText, { reviewDay, staffInstructions });
    if (reason) { removed.push({ item: itemText, reason }); continue; }
    n += 1;
    out.push(`${b.indent}${n}${b.sep} ${b.lines[0]}`, ...b.lines.slice(1));
  }
  // collapse blank runs left by removed items
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n');
  return { text: removed.length ? text : String(letter || ''), removed };
}

module.exports = { pruneConditions, datesIn, centralDay };
