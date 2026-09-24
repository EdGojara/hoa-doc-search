// ============================================================================
// lib/conversion/controls.js
// ----------------------------------------------------------------------------
// Evaluates EXTERNALLY SUPPLIED control rules (control_rules.csv) against
// SUPPLIED control totals (control_totals.csv) and mechanical measures of the
// supplied files. This module has no built-in accounting comparisons: every
// "X must equal Y" comes from the rules file written by Ed / ChatGPT.
//
// Measures (all computed only from the supplied files, never from Trusted data):
//   ROWS_<file>                         number of data rows
//   ROWS_<file>@<column>=<value>        rows whose <column> equals <value> exactly
//   SUM_<file>_<money column>           sum of that column
//   SUM_<file>_<money column>@<column>=<value>   sum over rows whose <column> = <value>
//   DISTINCT_<file>_<column>            number of distinct non-blank values
// e.g. SUM_gl_trial_balance_ending_debit@account_number=1300
// Counts compare against control amounts supplied the same way (579 = 579).
//
// Rule statuses:
//   PASS           left = right exactly, and every file the rule reads has no exceptions
//   FAIL           left != right (variance shown)
//   BLOCKED        values computed, but a file the rule reads has row exceptions
//   PENDING_INPUT  a file the rule reads has not been supplied
//   UNKNOWN_NAME   the rule references something that is neither a supplied control
//                  code nor a valid measure (also captured as an exception)
// ============================================================================
const { FILES } = require('./formats');

const $ = (c) => (c == null ? 'n/a' : (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' }));

// Resolve one name. Returns { value } | { pending } | { unknown }, plus the
// file it read (so exceptions in that file can block the rule).
function resolveName(name, inputs, controls) {
  if (Object.prototype.hasOwnProperty.call(controls, name)) return { value: controls[name] };
  const m = /^(ROWS|SUM|DISTINCT)_(.+)$/.exec(name);
  if (!m) return { unknown: true };
  const [, fn, rest] = m;
  const [lhs, filter] = rest.split('@');
  const kind = Object.keys(FILES).sort((a, b) => b.length - a.length).find((k) => lhs === k || lhs.startsWith(k + '_'));
  if (!kind) return { unknown: true };
  const column = lhs === kind ? null : lhs.slice(kind.length + 1);
  const spec = FILES[kind];
  const colSpec = column ? spec.columns.find((c) => c.name === column) : null;
  if (fn === 'ROWS' && column) return { unknown: true };
  if ((fn === 'SUM' || fn === 'DISTINCT') && !colSpec) return { unknown: true };
  if (fn === 'SUM' && colSpec.type !== 'money') return { unknown: true };
  let fcol = null;
  let fval = null;
  if (filter) {
    const fm = /^([a-z_0-9]+)=(.*)$/.exec(filter);
    if (!fm || !spec.columns.find((c) => c.name === fm[1])) return { unknown: true };
    [, fcol, fval] = fm;
  }
  const f = inputs.files[kind];
  if (!f) return { pending: kind, kind };
  const rows = f.rows.filter((r) => !r._errors.length && (!fcol || String(r[fcol] ?? '').toUpperCase() === String(fval).toUpperCase()));
  if (fn === 'ROWS') return { value: rows.length * 100, kind };
  if (fn === 'SUM') return { value: rows.reduce((a, r) => a + (r[column] || 0), 0), kind };
  return { value: new Set(rows.map((r) => r[column]).filter((v) => v != null && v !== '')).size * 100, kind };
}

function evalExpr(expr, inputs, controls) {
  const tokens = String(expr).replace(/\s+/g, '').match(/[+-]?[^+-]+/g) || [];
  let total = 0;
  const pending = [];
  const unknown = [];
  const kinds = new Set();
  for (const tk of tokens) {
    const sign = tk.startsWith('-') ? -1 : 1;
    const name = tk.replace(/^[+-]/, '');
    const r = resolveName(name, inputs, controls);
    if (r.kind) kinds.add(r.kind);
    if (r.unknown) unknown.push(name);
    else if (r.pending) pending.push(`${name} (needs ${r.pending})`);
    else total += sign * r.value;
  }
  return { value: total, pending, unknown, kinds: [...kinds] };
}

function evaluateControls({ inputs, rulesFileMissing }) {
  const controls = {};
  const ct = inputs.files.control_totals;
  if (ct) for (const r of ct.rows) if (!r._errors.length) controls[r.control_code] = r.amount;
  const rules = inputs.files.control_rules ? inputs.files.control_rules.rows.filter((r) => !r._errors.length) : [];
  const results = [];
  const exceptions = [];
  const used = new Set();
  for (const rule of rules) {
    const L = evalExpr(rule.left, inputs, controls);
    const R = evalExpr(rule.right, inputs, controls);
    for (const side of [rule.left, rule.right]) for (const tk of String(side).replace(/\s+/g, '').match(/[+-]?[^+-]+/g) || []) used.add(tk.replace(/^[+-]/, ''));
    const base = { rule_code: rule.rule_code, note: rule.note || null, left: rule.left, right: rule.right, line: rule._line };
    const unknown = [...L.unknown, ...R.unknown];
    const pending = [...L.pending, ...R.pending];
    if (unknown.length) {
      results.push({ ...base, status: 'UNKNOWN_NAME', unknown });
      exceptions.push({ file: 'control_rules', line: rule._line, field: 'left/right', code: 'RULE_UNKNOWN_NAME', detail: `rule ${rule.rule_code} references ${unknown.join(', ')}` });
      continue;
    }
    if (pending.length) { results.push({ ...base, status: 'PENDING_INPUT', waiting_for: pending }); continue; }
    const blockedBy = [...new Set([...L.kinds, ...R.kinds])].filter((k) => inputs.files[k] && inputs.files[k].exceptions.length);
    const equal = L.value === R.value;
    results.push({ ...base, status: blockedBy.length ? 'BLOCKED' : equal ? 'PASS' : 'FAIL', left_value: $(L.value), right_value: $(R.value), left_cents: L.value, right_cents: R.value, variance: $(L.value - R.value), blocked_by_exceptions_in: blockedBy.length ? blockedBy : undefined });
  }
  const unusedControls = Object.keys(controls).filter((c) => !used.has(c));
  const counts = ['PASS', 'FAIL', 'BLOCKED', 'PENDING_INPUT', 'UNKNOWN_NAME'].reduce((m, st) => ({ ...m, [st]: results.filter((r) => r.status === st).length }), {});
  return {
    rules_supplied: rules.length,
    rules_file_missing: !inputs.files.control_rules,
    controls_supplied: Object.keys(controls).length,
    unused_control_codes: unusedControls,
    results,
    exceptions,
    counts,
    all_pass: rules.length > 0 && counts.PASS === rules.length,
  };
}

module.exports = { evaluateControls, resolveName, evalExpr };
