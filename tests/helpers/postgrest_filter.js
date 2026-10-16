// Test helper: evaluate PostgREST filter strings the way PostgREST does, for the
// in-memory Supabase fakes. Faithful on the parts the search-safety tests rely
// on: top-level commas split conditions only OUTSIDE double quotes, a quoted
// value is one literal (backslash escapes \ and "), and LIKE patterns treat
// \% \_ \\ as literals while % and _ are wildcards. Anything it cannot parse
// throws, so a malformed filter fails the test instead of matching nothing.
'use strict';

function splitTop(expr) {
  const parts = []; let cur = ''; let inQ = false; let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (inQ) { cur += c; if (c === '\\') { cur += expr[++i] || ''; } else if (c === '"') inQ = false; continue; }
    if (c === '"') { inQ = true; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (inQ || depth !== 0) throw new Error('unbalanced filter: ' + expr);
  parts.push(cur);
  return parts;
}

function unquote(v) {
  if (!v.startsWith('"')) {
    if (/[",()]/.test(v)) throw new Error('reserved character in unquoted value: ' + v);
    return v;
  }
  if (!v.endsWith('"') || v.length < 2) throw new Error('bad quoted value: ' + v);
  let out = '';
  for (let i = 1; i < v.length - 1; i++) { const c = v[i]; if (c === '\\') { out += v[++i]; } else if (c === '"') { throw new Error('unescaped quote: ' + v); } else out += c; }
  return out;
}

// LIKE pattern -> RegExp. Backslash escapes the next character; * is PostgREST's alias for %.
function likeToRegex(pat, flags = 'i') {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '\\') { const n = pat[++i] || ''; re += n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    if (c === '%' || c === '*') re += '.*';
    else if (c === '_') re += '.';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', flags);
}

function condition(part) {
  // Groups: and(a,b,...) / or(a,b,...), nested.
  const g = part.match(/^(and|or)\((.*)\)$/s);
  if (g) {
    const subs = splitTop(g[2]).map(condition);
    return g[1] === 'and' ? (r) => subs.every((f) => f(r)) : (r) => subs.some((f) => f(r));
  }
  // col.in.(a,b) / col.not.in.(a,b)
  const li = part.match(/^([a-z_][a-z0-9_]*)\.(not\.)?in\.\((.*)\)$/i);
  if (li) {
    const vals = splitTop(li[3]).map(unquote);
    return li[2] ? (r) => r[li[1]] != null && !vals.includes(String(r[li[1]])) : (r) => r[li[1]] != null && vals.includes(String(r[li[1]]));
  }
  const m = part.match(/^([a-z_][a-z0-9_]*)\.(ilike|like|eq|neq|is)\.(.*)$/i);
  if (!m) throw new Error('unsupported filter condition: ' + part);
  const [, col, op, raw] = m;
  const val = unquote(raw);
  if (op === 'is') { if (val !== 'null') throw new Error('is only supports null here'); return (r) => (r[col] ?? null) === null; }
  if (op === 'eq') return (r) => r[col] != null && String(r[col]) === val;
  if (op === 'neq') return (r) => r[col] != null && String(r[col]) !== val;   // SQL: NULL <> x is not true
  const re = likeToRegex(val, op === 'ilike' ? 'i' : '');
  return (r) => r[col] != null && re.test(String(r[col]));
}

/** `.or('a.ilike."%x%",b.is.null')` -> predicate(row) */
function parseOr(expr) {
  const conds = splitTop(String(expr)).map(condition);
  return (r) => conds.some((f) => f(r));
}

module.exports = { parseOr, likeToRegex, splitTop, unquote };
