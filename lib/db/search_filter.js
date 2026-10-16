// ============================================================================
// lib/db/search_filter.js  (Ed 2026-10-16)
// ----------------------------------------------------------------------------
// The ONE way typed search text reaches a Supabase/PostgREST filter.
//
// The scar: /api/email-triage/contact-search built
//   .or(`full_name.ilike.%${q}%,primary_email.ilike.%${q}%`)
// straight from the query string. In a PostgREST `or=(...)` filter, a comma
// starts a new condition and parentheses group them, so text like
//   x%,id.not.is.null
// added a condition of the caller's choosing, and % or _ in a name became
// wildcards. PostgREST has no bind parameters for `or`, so "parameterized"
// here means: every value is LIKE-escaped AND double-quoted, which PostgREST
// treats as one literal value whatever it contains.
//
//   normalizeQuery(q)        trim, collapse whitespace, drop control chars, cap length
//   escapeLike(s)            \ % _ -> literal (Postgres LIKE escape is backslash)
//   containsPattern(q)       %<escaped>%  for .ilike(col, ...)  (supabase-js encodes it)
//   orIlike(cols, q)         "c1.ilike.\"%..%\",c2.ilike.\"%..%\"" for .or(...)
//   orIlikeExact(cols, v)    case-insensitive exact match (an email address) for .or(...)
//
// Partial-name and partial-email search behave as before; quotes (O'Brien),
// commas, parentheses, % and _ are searched for literally. `*` is PostgREST's
// alias for % inside like patterns and has no literal meaning in a name or an
// address, so it is treated as a space.
// ============================================================================
'use strict';

const MAX_LEN = 80;

function normalizeQuery(q, max = MAX_LEN) {
  return String(q == null ? '' : q).normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function escapeLike(s) { return String(s).replace(/[\\%_]/g, (c) => '\\' + c); }

function containsPattern(q) { return `%${escapeLike(normalizeQuery(q))}%`; }

// A double-quoted PostgREST value: backslash and double quote are escaped with a backslash.
function quoteValue(v) { return '"' + String(v).replace(/[\\"]/g, (c) => '\\' + c) + '"'; }

const COL_RE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;
function cols(list) {
  for (const c of list) if (!COL_RE.test(c)) throw new Error(`search_filter: bad column name ${c}`);
  return list;
}

function orIlike(columns, q) {
  const v = quoteValue(containsPattern(q));
  return cols(columns).map((c) => `${c}.ilike.${v}`).join(',');
}

function orIlikeExact(columns, value) {
  const v = quoteValue(escapeLike(normalizeQuery(value, 320)));
  return cols(columns).map((c) => `${c}.ilike.${v}`).join(',');
}

module.exports = { normalizeQuery, escapeLike, containsPattern, quoteValue, orIlike, orIlikeExact, MAX_LEN };
