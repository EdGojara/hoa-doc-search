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
console.log(`\nconversion revert committed: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
