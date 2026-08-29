// ============================================================================
// tests/test_objectives.js  (Ed 2026-08-29)
// ----------------------------------------------------------------------------
// The operator spine: an objective the team holds and drives to an outcome. The
// invariants that make it an operator and not a log: opening records a timeline
// event, reattachment finds the resident's open objective, and findStalled
// surfaces exactly what has gone due/quiet (the anti-ghosting guarantee).
// Deterministic: a thenable Supabase stub, no DB, no model.
// ============================================================================
const assert = require('assert');
const { openObjective, findOpenObjectiveFor, findStalled, objectiveContextBlock } = require('../lib/team/objectives');

let pass = 0, fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } }

function stub({ selectData = [], captured = [] } = {}) {
  const make = (table) => {
    const b = {
      _op: 'select', _payload: null, _table: table, _single: false,
      select() { return b; }, insert(r) { b._op = 'insert'; b._payload = r; return b; },
      update(r) { b._op = 'update'; b._payload = r; return b; },
      in() { return b; }, eq() { return b; }, ilike() { return b; }, order() { return b; }, limit() { return b; },
      single() { b._single = true; return b; },
      then(res, rej) {
        if (b._op === 'insert') { captured.push({ table, row: b._payload }); const d = { id: 'obj-1', ...b._payload }; return Promise.resolve({ data: b._single ? d : [d], error: null }).then(res, rej); }
        if (b._op === 'update') { const d = { id: 'obj-1', ...b._payload }; return Promise.resolve({ data: b._single ? d : [d], error: null }).then(res, rej); }
        return Promise.resolve({ data: selectData, error: null }).then(res, rej);
      },
    };
    return b;
  };
  return { from(t) { return make(t); } };
}

(async () => {
  console.log('\nOperator spine — objectives\n');

  // --- context block (pure) ---
  const block = objectiveContextBlock(
    { title: 'Dog welfare at 5943 Baldwin Elm', goal: 'Resolve dog welfare report', status: 'waiting_third_party', next_action: 'follow up with Animal Control' },
    [{ actor: 'claire', kind: 'message_out', summary: 'told resident to escalate to AC supervisor' }],
  );
  ok(/OPEN OBJECTIVE/.test(block) && /Resolve dog welfare report/.test(block), 'context block states the goal');
  ok(/waiting_third_party/.test(block) && /follow up with Animal Control/.test(block), 'context block states status + next step');
  ok(objectiveContextBlock(null) === '', 'no objective -> empty block (no crash)');

  // --- opening records a timeline event ---
  console.log('');
  const cap = [];
  const oOpen = await openObjective(stub({ captured: cap }), {
    communityId: 'c1', title: 'Resolve dog welfare report', goal: 'Resolve dog welfare report at 5943 Baldwin Elm',
    ownerPersona: 'claire', residentEmail: 'lorenacarnero@hotmail.com',
  });
  ok(oOpen && oOpen.id === 'obj-1', 'openObjective returns the created row');
  ok(cap.some((c) => c.table === 'objectives' && c.row.title), 'wrote the objective');
  ok(cap.some((c) => c.table === 'objective_events' && c.row.kind === 'opened'), 'logged an "opened" timeline event');

  // --- reattachment finds the resident's open objective ---
  console.log('');
  const existing = { id: 'obj-9', status: 'waiting_resident', resident_email: 'lorenacarnero@hotmail.com', last_activity_at: '2026-08-29T00:00:00Z' };
  const found = await findOpenObjectiveFor(stub({ selectData: [existing] }), { residentEmail: 'lorenacarnero@hotmail.com' });
  ok(found && found.id === 'obj-9', 'reattaches a new inbound to the resident\'s existing open objective');
  const none = await findOpenObjectiveFor(stub({ selectData: [] }), { residentEmail: 'nobody@x.com' });
  ok(none === null, 'no open objective -> null (opens a fresh one)');

  // --- findStalled surfaces due/quiet, ignores fresh ---
  console.log('');
  const now = Date.now();
  const iso = (ms) => new Date(now + ms).toISOString();
  const rows = [
    { id: 'fresh', status: 'open', last_activity_at: iso(-1 * 3600 * 1000), next_action_due: null },       // 1h ago, no due -> not stalled
    { id: 'quiet', status: 'open', last_activity_at: iso(-100 * 3600 * 1000), next_action_due: null },     // 100h quiet -> stalled
    { id: 'overdue', status: 'waiting_resident', last_activity_at: iso(-1 * 3600 * 1000), next_action_due: iso(-2 * 3600 * 1000) }, // due passed -> stalled
  ];
  const stalled = await findStalled(stub({ selectData: rows }), { staleHours: 72 });
  const ids = stalled.map((o) => o.id);
  ok(ids.includes('quiet') && ids.includes('overdue'), 'stalled includes the quiet and the overdue');
  ok(!ids.includes('fresh'), 'stalled excludes the fresh one (no false follow-up)');

  console.log(`\n${fail ? 'FAILED' : 'All'} objective cases ${fail ? '' : 'passed'} (${pass} passed, ${fail} failed).`);
  process.exit(fail ? 1 : 0);
})();
