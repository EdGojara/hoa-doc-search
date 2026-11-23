// ============================================================================
// tests/test_acc_property_history.js  (Ed 2026-11-19)
// Annie's ACC review sees what trustEd already knows about the lot: open and
// recent violations and the other ACC cases at the address. Missing history
// never blocks a review. Run: node tests/test_acc_property_history.js
// ============================================================================
const fs = require('fs');
const path = require('path');
const { propertyHistory } = require('../lib/acc/property_history');

let failures = 0;
const check = (name, cond, detail) => { if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`); else { failures++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`); } };

function fakeDb(tables, { failOn = null } = {}) {
  return { from(t) {
    const st = { filters: [] };
    const q = {
      select() { return q; }, order() { return q; }, limit() { return q; },
      eq(k, v) { st.filters.push((r) => r[k] === v); return q; },
      in(k, vs) { st.filters.push((r) => vs.includes(r[k])); return q; },
      ilike(k, pat) { const rx = new RegExp('^' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i'); st.filters.push((r) => rx.test(String(r[k] || ''))); return q; },
      then(res, rej) {
        if (failOn === t) return Promise.resolve({ data: null, error: { message: 'boom' } }).then(res, rej);
        return Promise.resolve({ data: (tables[t] || []).filter((r) => st.filters.every((f) => f(r))), error: null }).then(res, rej);
      },
    };
    return q;
  } };
}

const C = 'wv';
const tables = {
  properties: [{ id: 'p1', community_id: C, street_address: '100 Example Way' }, { id: 'p2', community_id: C, street_address: '100 Other Lane' }],
  violations: [
    { id: 'v1', property_id: 'p1', primary_category_id: 'k1', current_stage: 'courtesy_1', opened_at: '2026-09-14T15:00:00Z', resolved_at: null, opened_from_observation_id: 'o1' },
    { id: 'v2', property_id: 'p2', primary_category_id: 'k1', current_stage: 'courtesy_1', opened_at: '2026-09-14T15:00:00Z', resolved_at: null },
  ],
  enforcement_categories: [{ id: 'k1', label: 'Unapproved modification' }],
  property_observations: [{ id: 'o1', ai_description: 'Garage door is painted a color not cohesive with community standards.', created_at: '2026-09-14T15:24:44Z' }],
  acc_decisions: [
    { id: 'self', community_id: C, reference_number: 'WAT-1', status: 'pending_review', project_summary: 'Garage door repaint', created_at: '2026-11-16', homeowner_address: '100 Example Way, Sampletown, TX 77000' },
    { id: 'old', community_id: C, reference_number: 'WAT-0', status: 'decided', decision_type: 'approved', decided_at: '2026-03-01', project_summary: 'Fence replacement', created_at: '2026-02-20', homeowner_address: '100 Example Way' },
    { id: 'nbr', community_id: C, reference_number: 'WAT-9', status: 'decided', project_summary: 'Roof', created_at: '2026-02-20', homeowner_address: '100 Other Lane' },
  ],
};

(async () => {
  console.log('\nProperty history for Annie\'s review');
  const h = await propertyHistory(fakeDb(tables), { communityId: C, address: '100 Example Way, Sampletown, TX 77000', excludeId: 'self', now: new Date('2026-11-19') });
  check('lists the open violation with the inspection finding', /OPEN, stage courtesy_1/.test(h) && /not cohesive/.test(h), h);
  check('lists the other ACC case at the address', /WAT-0/.test(h) && /approved 2026-03-01/.test(h));
  check('never the case under review itself', !/WAT-1/.test(h));
  check('never a different lot with the same house number', !/WAT-9/.test(h) && (h.match(/OPEN/g) || []).length === 1);
  check('tells Annie to review it as the response to the violation', /response to that violation/.test(h));
  check('nothing on file: empty, no error', (await propertyHistory(fakeDb({}), { communityId: C, address: '1 Nowhere St' })) === '');
  check('no address: empty', (await propertyHistory(fakeDb(tables), { communityId: C, address: null })) === '');
  check('a failed query never throws or blocks the review', typeof (await propertyHistory(fakeDb(tables, { failOn: 'violations' }), { communityId: C, address: '100 Example Way' })) === 'string');

  console.log('\nWired into both of Annie\'s review paths');
  const pi = fs.readFileSync(path.join(__dirname, '..', 'lib', 'acc', 'pending_intake.js'), 'utf8');
  const docs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'acc', 'documents.js'), 'utf8');
  const sv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check('intake review passes the history', /propertyHistory\(supabase[\s\S]{0,200}\n\s*try \{ out = await runEngine\(\{[^}]*additionalContext: history/.test(pi));
  check('re-review passes the history', /propertyHistory\(supabase[\s\S]{0,200}runEngine\(\{[^}]*additionalContext: history/.test(docs));
  check('the review prompt limits clarification requests and does not reopen supported decisions', /ONLY when the missing item would change the outcome AND cannot be resolved/.test(sv) && /Do not reopen it/.test(sv));

  console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall property-history checks passed\x1b[0m');
  process.exit(failures ? 1 : 0);
})();
