// A prior owner's 7/31 balance on that prior owner's OWN ended owner tenure (Ed 2026-11-16,
// Waterview): migration 560 + the plan + the fail-closed service gate.
'use strict';
const fs = require('fs'); const path = require('path');
let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

const fnOf = (sql) => { const s = sql.indexOf('CREATE OR REPLACE FUNCTION onboarding_execute(p_batch UUID'); const e = sql.indexOf('\nEND;\n$fn$;\n', s); return sql.slice(s, e); };
const m536 = fnOf(read('migrations/536_conversion_execute_establishment.sql'));
const m560sql = read('migrations/560_conversion_prior_owner_ended_tenure.sql');
const m560 = fnOf(m560sql);
const strip = (f) => f.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const oldCheck = "   WHERE h.source_batch_id = ar_batch AND coalesce((h.raw_row_jsonb->'onboarding'->>'prior_owner')::boolean, false) AND t.kind <> 'legacy';";
const newBlock = /LEFT JOIN properties lp ON lp\.id = t\.property_id\n   WHERE h\.source_batch_id = ar_batch AND coalesce\(\(h\.raw_row_jsonb->'onboarding'->>'prior_owner'\)::boolean, false\) AND t\.kind <> 'legacy'\n     AND NOT \(t\.kind = 'owner' AND t\.end_date IS NOT NULL AND t\.end_date <= cutoff AND t\.vantaca_account_id = h\.vantaca_account_id\n              AND lp\.id IS NOT NULL AND lp\.vantaca_account_id IS DISTINCT FROM h\.vantaca_account_id\);/;
{
  // Line diff of the two function bodies (comments ignored): exactly the one old WHERE line out, the 560 lines in.
  const a = strip(m536).split('\n'); const b = strip(m560).split('\n');
  const removed = a.filter((l) => !b.includes(l)); const added = b.filter((l) => !a.includes(l));
  check('560 replaces onboarding_execute with the 536 body unchanged except the prior-owner isolation check',
    m536.length > 1000 && removed.length === 1 && removed[0] === oldCheck && added.length === 4 && added.every((l) => /lp\.|t\.kind <> 'legacy'|t\.end_date <= cutoff|IS DISTINCT FROM h\.vantaca_account_id/.test(l)));
}
check('560: the check accepts only the prior owner\'s OWN ended tenure (same account, ended on/before the cutoff, lot now on another account)', newBlock.test(m560));
check('560: the capability probe offers prior_owner_ended_tenure and keeps the 536 capabilities', /"conversion_adjustments","adjustment_audit_chain","legacy_owner_records","initial_ownership","prior_owner_ended_tenure"/.test(m560sql));
check('560: one transaction, refuses while a batch is mid-execute', /^BEGIN;/m.test(m560sql) && /COMMIT;\s*$/.test(m560sql) && /onboarding_stage = 'execute' AND status <> 'posted'/.test(m560sql));
const checks = JSON.parse(read('migrations/checks/560_conversion_prior_owner_ended_tenure.json'));
check('560 checks file: no row changes, verifies the capability and the rule', checks.row_changes.homeowner_transactions === 0 && checks.row_changes.ownership_tenures === 0 && checks.verify.length === 2);

const plan = read('lib/onboarding/conversion_plan.js');
check('plan: routes a prior owner to their ended tenure only when it ended on/before the cutoff and the lot now carries another account',
  /t\.kind === 'owner' && t\.property_id && t\.end_date && String\(t\.end_date\)\.slice\(0, 10\) <= cutoff/.test(plan) && /String\(lot\.vantaca_account_id \|\| ''\) !== acct\) return \{ tenure_id: t\.id, ended_owner_tenure/.test(plan));
check('plan: the isolation control re-proves the ended tenure independently', /const endedOwn = \(r\) =>/.test(plan) && /r\.prior_owner_tenure === 'ended_owner' && endedOwn\(r\)/.test(plan));
check('plan version bumped (an existing preflight is rebuilt)', /const PLAN_VERSION = '2026-11-16\.1';/.test(plan));

const svc = read('lib/onboarding/service.js');
check('service: preflight BLOCKS and execute refuses that plan shape until 560 is applied (fail closed)',
  /needs560\(plan\.writes\)/.test(svc) && /needs560\(rec\.plan && rec\.plan\.writes\)\) \{ const why = await execute560Missing\(\); if \(why\) throw new ServiceError\(503/.test(svc) && /caps\.includes\('prior_owner_ended_tenure'\)/.test(svc));

// The current-owner ledger never reads an ended tenure (what makes the shape safe).
const v457 = read('migrations/457_current_tenure_reader_views.sql');
check('v_current_owner_ledger reads only open owner tenures', /t\.kind = 'owner' AND t\.end_date IS NULL/.test(v457));

console.log(`\nprior owner ended tenure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
