// ============================================================================
// tests/test_acc_constraints.js  (Ed 2026-10-20)
// ----------------------------------------------------------------------------
// Measurable governing-document restrictions as allowable ranges, compared by
// code (lib/acc/constraints.js). Permanent regressions:
//   - "shall be eighteen feet (18')" is EXACT 18 (min 18, max 18), never "at least"
//   - a 30 ft driveway FAILS an applicable 18 ft prescribed width
//   - "not more than six feet" is a MAXIMUM of 6 (a bug once read it as > 6)
// No community-specific logic: the Waterview clause is a fixture, not a rule.
// Run: node tests/test_acc_constraints.js
// ============================================================================
const C = require('../lib/acc/constraints');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  else { failures++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`); }
}
const range = (c) => [c.min ? [c.min.value, c.min.inclusive] : null, c.max ? [c.max.value, c.max.inclusive] : null];
const one = (q, o) => { const p = C.parseClause(q, o || {}); return p.constraints[0] ? range(p.constraints[0]) : null; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\n1. Bounds come from the whole clause, not "shall" / "must"');
check('"shall be eighteen feet (18\') in width" -> exact 18', eq(one('shall be eighteen feet (18\') in width'), [[18, true], [18, true]]));
check('"must be 18 feet" -> exact 18', eq(one('must be 18 feet'), [[18, true], [18, true]]));
check('"at least 18 feet" -> min 18, no max', eq(one('at least 18 feet'), [[18, true], null]));
check('"a minimum of ten feet (10\')" -> min 10', eq(one('shall be a minimum of ten feet (10\') in width'), [[10, true], null]));
check('"not more than six feet" -> MAX 6 (regression: once read as > 6)', eq(one('not more than six feet in height'), [null, [6, true]]));
check('"no more than six feet (6\')" -> max 6', eq(one('no more than six feet (6\') in height'), [null, [6, true]]));
check('"shall not exceed 20 feet" -> max 20', eq(one('shall not exceed 20 feet'), [null, [20, true]]));
check('"more than 6 feet" -> min 6 exclusive', eq(one('more than 6 feet'), [[6, false], null]));
check('"less than 10 feet" -> max 10 exclusive', eq(one('less than 10 feet'), [null, [10, false]]));
check('"no closer than two feet (2\')" -> min 2', eq(one('no closer than two feet (2\') from the side property line'), [[2, true], null]));
check('"not less than 4 inches" -> min 4 in (0.333 ft)', eq(one('not less than 4 inches'), [[4 / 12, true], null]));
const between = C.parseClause('between 48 inches and 60 inches in height', {});
check('"between 48 inches and 60 inches" -> 4 ft to 5 ft, inclusivity flagged as unstated',
  eq(range(between.constraints[0]), [[4, true], [5, true]]) && between.constraints[0].ambiguities.includes('between_inclusivity_unstated'));
check('"2\'6\"" reads as 2.5 ft', Math.abs(C.readQuantity('extend width by 2\'6" on one side').value - 2.5) < 1e-9);

console.log('\n2. Conditional rule (the Waterview width clause as a fixture)');
const WIDTH = 'Driveways serving attached two car garages facing the street shall be eighteen feet (18\') in width for lots greater than fifty-five feet (55\') wide and sixteen feet (16\') in width for lots 55\' wide and smaller.';
const opts = { subject: 'driveway', measurement: 'width', factFor: (t) => (/lot/i.test(t) ? 'lot.width_ft' : null),
  conditions: [{ fact: 'garage.type', op: 'eq', value: 'attached_front_two_car', text: 'attached two car garage facing the street' }],
  source: { document: 'Amended Declaration', section: '2.22', page: '16 of 47' } };
const p = C.parseClause(WIDTH, opts);
check('parses into two exact, conditional constraints', p.ok && p.constraints.length === 2 && eq(range(p.constraints[0]), [[18, true], [18, true]]) && eq(range(p.constraints[1]), [[16, true], [16, true]]));
check('...conditioned on lot width > 55 and <= 55', p.constraints[0].conditions.some((c) => c.fact === 'lot.width_ft' && c.op === 'gt' && c.value === 55) && p.constraints[1].conditions.some((c) => c.fact === 'lot.width_ft' && c.op === 'lte' && c.value === 55));
const facts = (w, lot = 60) => ({ 'garage.type': 'attached_front_two_car', 'lot.width_ft': lot, 'driveway.width_ft': w });
const ev = (c, f) => C.evaluate(c, f, { valueFact: 'driveway.width_ft' });
check('18 ft on a 60 ft lot complies', ev(p.constraints[0], facts(18)).result === 'complies');
check('30 ft FAILS the 18 ft prescribed width (exceeds required value)', ev(p.constraints[0], facts(30)).result === 'does_not_comply' && ev(p.constraints[0], facts(30)).direction === 'exceeds_required_value');
check('18.5 ft fails: no implied tolerance near the prescribed value', ev(p.constraints[0], facts(18.5)).result === 'does_not_comply');
check('16 ft fails the 18 ft rule (below required value)', ev(p.constraints[0], facts(16)).direction === 'below_required_value');
check('the 16 ft rule does not apply to a 60 ft lot', ev(p.constraints[1], facts(16)).result === 'not_applicable');
check('the 16 ft rule applies to a 50 ft lot', ev(p.constraints[1], facts(16, 50)).result === 'complies');
check('unknown lot width -> needs_fact (never assumed)', ev(p.constraints[0], { 'garage.type': 'attached_front_two_car', 'driveway.width_ft': 30 }).result === 'needs_fact');
check('unknown proposed width -> needs_fact', ev(p.constraints[0], { 'garage.type': 'attached_front_two_car', 'lot.width_ft': 60 }).result === 'needs_fact');
const tol = { ...p.constraints[0], tolerance: { value: 0.5, unit: 'ft', source: { document: 'hypothetical', section: 'x', quote: 'a tolerance of six inches' } } };
check('only a STATED tolerance widens the comparison', ev(tol, facts(18.5)).result === 'complies' && ev({ ...p.constraints[0], tolerance: { value: 0.5 } }, facts(18.5)).result === 'does_not_comply');

console.log('\n3. Conflicting provisions are reported, not resolved by assumption');
const orig = C.parseClause('Driveways serving attached two car garages facing the street shall be eighteen feet (18\') in width.', { ...opts, source: { document: 'Declaration (May 2004)', section: '2.22', document_id: 'orig' } }).constraints[0];
const amended = p.constraints.map((c) => ({ ...c, source: { ...c.source, document_id: 'amended' } }));
const conflicts = C.detectConflicts([orig, ...amended]);
check('original 18 ft vs amended 16 ft (lots <= 55) is a conflict', conflicts.some((cf) => [cf.a, cf.b].includes(orig)));
check('...unresolved without documented precedence', conflicts.every((cf) => !C.resolveConflict(cf).resolved));
const supersededOrig = { ...orig, source: { ...orig.source, superseded_by: 'amended' } };
const res = C.detectConflicts([supersededOrig, amended[1]]).map(C.resolveConflict)[0];
check('...resolved only when the documents establish supersession', res && res.resolved && res.controlling === amended[1]);
check('rules for mutually exclusive lot sizes do not conflict', C.detectConflicts(amended).length === 0);
check('assessment summary refuses "compliant" while a conflict is open', C.assess([{ constraint: orig, valueFact: 'driveway.width_ft' }, { constraint: amended[1], valueFact: 'driveway.width_ft' }], facts(16, 50)).summary === 'conflicting_provisions');

console.log('\n4. Deviations are evaluated separately and never widen the range');
const authority = { covers: ['size', 'location'], source: { document: 'Amended Declaration', section: '2.1', page: '5 of 47' } };
const a1 = C.assess([{ constraint: p.constraints[0], valueFact: 'driveway.width_ft' }], facts(30), { deviationAuthorities: [authority] });
check('30 ft with deviation authority but no decision -> noncompliant, deviation required', a1.summary === 'noncompliant_deviation_required' && !a1.may_recommend_approval);
const a2 = C.assess([{ constraint: p.constraints[0], valueFact: 'driveway.width_ft' }], facts(30), { deviationAuthorities: [authority], authorization: { deviation_granted: true, deviation_statement: 'Board grants a 30 ft width under §2.1', evidence_reference: 'Board minutes 2026-10-01', decided_on: '2026-10-01' } });
check('...with a documented deviation -> noncompliant, deviation AUTHORIZED (range unchanged)', a2.summary === 'noncompliant_deviation_authorized' && a2.results[0].result === 'does_not_comply' && p.constraints[0].max.value === 18);
const a3 = C.assess([{ constraint: p.constraints[0], valueFact: 'driveway.width_ft' }], facts(30));
check('...with no deviation authority -> not permitted as submitted', a3.summary === 'noncompliant_not_permitted');
check('a compliant proposal is the only one that may be recommended for approval', C.assess([{ constraint: p.constraints[0], valueFact: 'driveway.width_ft' }], facts(18)).may_recommend_approval === true);

console.log('\n5. A model-proposed constraint must match its quote');
check('"minimum 18" proposed for "shall be 18" is rejected (the Brian error)', !C.verifyAgainstQuote({ min: { value: 18, inclusive: true }, max: null, source: { quote: 'shall be eighteen feet (18\') in width' } }).ok);
check('the exact reading is accepted', C.verifyAgainstQuote({ min: { value: 18, inclusive: true }, max: { value: 18, inclusive: true }, source: { quote: 'shall be eighteen feet (18\') in width' } }).ok);

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
process.exit(failures ? 1 : 0);
