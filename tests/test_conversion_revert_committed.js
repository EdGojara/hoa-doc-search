// A conversion retires only legacy ledger batches that are still committed, and the preflight proves it
// (Ed 2026-11-17, Waterview: EXECUTE refused "1 of 2 legacy ledger batches are still committed" because the
// plan listed a batch reverted months earlier). The refusal belongs in preflight, not at execute.
'use strict';
const fs = require('fs'); const path = require('path');
let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const plan = read('lib/onboarding/conversion_plan.js');
const reader = read('lib/onboarding/trusted_activity.js');
const svc = read('lib/onboarding/service.js');
const exec = read('migrations/560_conversion_prior_owner_ended_tenure.sql');
check('EXECUTE requires every batch it retires to be committed (the rule the plan must satisfy)', /legacy ledger batches are still committed/.test(exec));
check('the reader returns each homeowner batch\'s status', /'transaction_upload_batches', 'id, uploaded_by, status'/.test(reader) && /homeownerBatchStatus/.test(reader));
check('the service hands the statuses to the plan', /homeowner_batch_status: loaded\.homeownerBatchStatus/.test(svc));
check('the plan skips a batch that is no longer committed and records why', /if \(bst && bst !== 'committed'\) \{ alreadyRetired\.set/.test(plan) && /was already reverted before the conversion/.test(plan));
check('the preflight blocks if any batch it retires is not committed', /preflight\.legacy_batches_committed/.test(plan) && /filter\(\(id\) => ctx\.homeowner_batch_status\[id\] !== 'committed'\)/.test(plan));
check('plan version bumped', /const PLAN_VERSION = '2026-11-17\.1';/.test(plan));
const page = read('public/onboarding.html');
check('a rebuilt preflight can be approved even when an earlier fingerprint was approved (the old approval never authorizes it)', /const canApprove = owner && current && !p\.stale && approved !== r\.sha256/.test(page));
{
  // 561: the database lets the owner approve a REBUILT preflight; an approval stays fixed from execute on.
  const fnOf = (sql) => { const s = sql.indexOf('CREATE OR REPLACE FUNCTION conversion_batches_onboarding_guard()'); return sql.slice(s, sql.indexOf('\n$fn$;\n', s)); };
  const strip = (f) => f.split('\n').filter((l) => !/^\s*--/.test(l));
  const a = strip(fnOf(read('migrations/485_onboarding_operator.sql'))); const b = strip(fnOf(read('migrations/561_onboarding_reapprove_superseded_preflight.sql')));
  const removed = a.filter((l) => !b.includes(l)); const added = b.filter((l) => !a.includes(l));
  check('561 changes only the write-once rule of the batch guard (485 body otherwise unchanged)', a.length > 20 && removed.length === 2 && added.length === 6);
  const g = b.join('\n');
  check('561: a replacement needs preflight before and after, an unposted batch, a non-null hash, and a SUPERSEDED earlier approval',
    /OLD\.onboarding_stage IS DISTINCT FROM 'preflight' OR NEW\.onboarding_stage IS DISTINCT FROM 'preflight'/.test(g) && /NEW\.status = 'posted' OR NEW\.approved_preflight_sha256 IS NULL/.test(g) && /onboarding_completion_gate\(e\.completion_event_id\) IS NULL\)\) THEN/.test(g));
  check('561 keeps the human-approval-of-the-current-result check for every recorded hash', /preflight hash can only be recorded from a human approval of the current preflight result/.test(g));
}
{
  // The operator names the owner's authorization instead of "Nothing needed from you right now".
  const s = read('lib/onboarding/service.js'); const page2 = read('public/onboarding.html');
  check('operator asks: approve / execute a passing preflight, complete a passing post-proof', /asks\.push\(\{ type: 'authorize', step: approvedThis \? 'execute' : 'approve'/.test(s) && /type: 'authorize', step: 'complete'/.test(s));
  check('the stale "EXECUTE is not available in this milestone" text is gone', !/EXECUTE is not available in this milestone/.test(s));
  check('the page shows "Waiting for your authorization" for those asks', /Waiting for your authorization:/.test(page2) && /a\.type !== 'authorize'\);/.test(page2));
}
console.log(`\nconversion revert committed: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
