# AI Handoff

Shared state between Ed and the AI engineers (Claude, ChatGPT). Update before ending any task. Newest entry first. Keep it decision-oriented.

---

## 2026-09-28 (latest): AP deposit follow-up, attestation re-validation (third review; feat/ap-deposit-followup; migration 471 PROPOSED; NOT merged/deployed)

**ChatGPT review of `19c9663f`** (16:45 UTC). It confirmed the route correction; one remaining issue: a recorded attestation was re-checked only against the bill total.

**Fixed.**
- **The attestation records what it was made against.** Migration 471 adds `verified_bill_posting_je_id` and `verified_bill_lines` (GL account + amount per line) to decisions, alongside the verified deposit-paid amount and the relief JE. The function also refuses (`bill_not_posted`) if the bill's own entry isn't posted.
- **The gate re-validates EVERYTHING on every check**, reading a FRESH invoice row. Any of these re-holds the bill with a specific reason:
  - the bill total differs;
  - the bill's posting JE was replaced, voided or un-posted;
  - the bill's GL coding changed, **even at the same total**;
  - the deposit invoice's paid amount changed, or it was voided;
  - the relief JE is missing, un-posted or voided, or no longer credits the deposit account for the deposit amount.
- **Checked before every money step**, not just approval:
  - both approval keys (manager and admin release);
  - `POST /invoices/:id/mark-paid` and `POST /payments` (409 when held; 503 if the check can't run);
  - the check run: `listPayableInvoices` omits held bills, and `createCheckRun` refuses the whole run naming the held bill.
  - `depositHoldsForInvoices` batches this: one deposit query per community, and gate calls only for bills whose vendor has an outstanding deposit.
- **UI states the manual step plainly.** Emma cannot release; an admin records the deposit accounting; a full-total bill without the deposit credit can't be paid in this version (the vendor reissues it for the balance); and it is re-checked at every step.

**Tests.**
- Approval route **17/17**. Seven post-attestation mutations each re-hold BOTH keys:
  - relief JE voided;
  - relief JE un-posted;
  - relief JE credit changed;
  - bill recoded at the same total;
  - bill posting JE voided;
  - bill re-posted under a new JE;
  - deposit payment reversed.
  Plus mark-paid and /payments refused, the check run omitting and refusing the held bill while a plain bill still lists, and an unchanged attestation still releasing.
- Unit **24/24**.
- SQL rehearsal **52/52**: bill-not-posted refusal and the snapshot recorded; apply_one end to end with 94 objects plus the grant verifies.
- **Sabotage:** turning off re-validation fails 10 route tests; removing the check-run filter fails 1; removing the payment hold fails 1.
- Full suite 124/129 (the same 5 pre-existing failures).

**Still manual** (unchanged from the entry below): reconcile a held bill; confirm or reject; an admin records the deposit accounting; no in-app netting of a full-face bill; duplicate → Void.

---

## 2026-09-28: AP deposit follow-up, second review fixes (superseded in part by the entry above)

**ChatGPT review of `a1d20750`** (Issue #1, 16:28 UTC), item by item.

**1. Approval "bypass."**
- The committed route at `a1d20750` already selected `vendor_id, community_id` (api/ap.js:1126); the review likely read the earlier `7a4e2d09`.
- The underlying weakness was real, though: the helper returned `block:false` on a partial row (fail-open). It now reloads vendor/community/total by id, and blocks if it can't.
- **The test fake ignored `select()` column lists**, so no fake-based test could ever catch a narrow SELECT. The shared fake (`tests/_fake_supabase_deposits.js`) now projects columns like PostgREST.
- **New `tests/test_ap_deposit_approve_route.js`** mounts the REAL `api/ap.js` router and makes HTTP calls to `POST /invoices/:id/approve`:
  - manager key 1 → 409 (no approval row);
  - admin release → 409 (nothing released);
  - pending/confirmed → 409 "Emma cannot release";
  - missing 471 → 409 fail-closed;
  - multiple deposits → 409 until each is resolved;
  - recorded accounting at the net → 200, and re-held if the bill changes;
  - other vendors and the deposit bill itself → normal.
- **Sabotage:** reproducing the reviewer's exact bypass (narrow SELECT plus fail-open gate) fails 6 route tests. With only a narrow SELECT, the reload still holds (0 fails).

**2. Revocation compatibility.**
- **Code search** (whole repo, excluding node_modules and academy): the only writer of `vendor_deposits` is `lib/ap/intake.js` (INSERT, around line 358). No UPDATE or DELETE exists anywhere.
- **Narrowed anyway:** table-level UPDATE is replaced by column-level UPDATE on every pre-existing column. Only the six follow-up columns are function-only. DELETE, INSERT and SELECT are unchanged.
- **The rehearsal proves it:**
  - `has_column_privilege` shows the service role can still update status, applied_invoice_id, notes and every other pre-existing column, and cannot update the follow-up columns;
  - a live `SET ROLE service_role` UPDATE of notes succeeds while a follow-up column UPDATE is denied;
  - DELETE, INSERT and SELECT are intact.

**3. Full-total, no-credit bills.**
- `manual_accounting_recorded` requires the bill's live total to equal the net due. A full-face bill T can never pass, so it **stays held**.
- **This version has no supported in-app way to net a bill from T to B.** The hold message says so: have the vendor reissue it for the balance (the new bill is proposed automatically and reconciles as balance_only), or wait for the accounting step.
- A re-proposal on a changed bill records the ORIGINAL billed face (warning `bill_amount_changed_since_first_proposal` plus a math line). Tested.

**4. Manual accounting is an attestation with structural JE checks, not "verified accounting."**
- The SQL reads how the DEPOSIT was booked from its own posted accrual.
- **Prepaid** (the accrual debited the deposit account): requires a posted JE in this community, never used by another decision (`uq_vdrd_je_used_once`), with a CREDIT line on the deposit account for exactly the deposit billed. The final bill's own accrual counts when it carries that credit.
- **Expensed** (the 4 live rows): no relief JE is allowed, and the final bill may not touch the deposit account.
- The recorded state is stored (`deposit_accounting_state`). The UI labels it "admin attestation."
- Rehearsed: wrong amount, wrong account, missing JE, reuse, the own-accrual path, and both expensed rules.

**5. Changed objects.**
- The object diff shows 92 added and 0 changed, because the tool's snapshot doesn't track ACLs. The grant change on the EXISTING `vendor_deposits` is now stated in `expected_changes` and **verified by the apply tool** with three verify steps:
  - status is still updatable;
  - balance_due_date is function-only;
  - DELETE is unchanged.
- The functions are new, so CREATE OR REPLACE creates them rather than replacing anything.

**What stays manual, exactly.**
1. **Reconciling a held bill** with no proposal: click "Reconcile against the deposit" on the red held banner.
2. **Confirm or reject the match** (staff).
3. **Deposit accounting (admin):**
   - if prepaid, post the JE crediting 1430 for the deposit amount (unless the bill's own entry already does), then record it with the JE reference;
   - if expensed, record with no JE.
   - In both cases the bill must already read the net due.
4. **A full-face bill** can't be netted in-app. The vendor reissues it, or it waits for the accounting step.
5. **Duplicate or statement:** confirm it, then use the existing Void.
6. **Normal two-key approval and the check run** afterwards.

**Tests.**
- Unit 24/24;
- approval route 7/7;
- SQL rehearsal 50/50 (apply_one end to end with 92 objects and the grant verifies);
- full suite 124/129 (the same 5 pre-existing failures).

---

## 2026-09-28: AP deposit follow-up, REVISED narrow slice after ChatGPT code review (superseded in part by the entry above)

**Why revised.** ChatGPT's code review of `7a4e2d09` (Issue #1, 16:08 UTC) found six blocking gaps:
1. the accounting path was incomplete;
2. the obligation vanished on approval;
3. the gate could be bypassed;
4. decisions weren't atomic or current;
5. the duplicate/statement lifecycle was left open;
6. audit and authorization were weak.

All six are addressed by narrowing the slice. **Emma CANNOT release a deposit-consuming bill in this slice.** Nothing changes an AP amount, a journal entry or a deposit's status, and nothing pays.

**What the slice does now.**
- **Obligation tracking** (`upcomingBalances`). Each outstanding deposit shows:
  - due date, estimate label and source documents (the invoice file plus `ap_invoice_documents`);
  - an obligation state: `waiting_for_final_bill` → `final_bill_held` → `final_bill_accounted_awaiting_payment` → `final_bill_paid`.
  - **The item stays listed until the final bill is actually PAID.** Reconciling never clears it, and `vendor_deposits.status` is never changed here.
- **Hard hold** (`approvalGateForInvoice`, used by approve/release). A bill whose vendor + community has an OUTSTANDING deposit (other than the one the bill itself created) is held until EACH such deposit is resolved for this bill, by the newest proposal's terminal decision:
  - `unrelated` (admin only, with a note): released;
  - `manual_accounting_recorded` (admin only): released while the bill total stays at the verified amount;
  - anything else, including no proposal or multiple deposits: held.
  - **Fails closed:** `deposit_check_unavailable` if the 471 ledger is absent. It is driven by the deposits themselves, so a skipped or failed proposal can't let a bill through.
- **Atomic, audited writes.** Migration 471 now adds three `SECURITY DEFINER` functions (EXECUTE for service_role only). Each takes row locks, runs its checks, and writes its change plus its audit event in ONE transaction, or nothing:
  - `vendor_deposit_set_followup`;
  - `vendor_deposit_propose`;
  - `vendor_deposit_decide`: requires identity (non-null user); the proposer can't decide; a state machine allows at most one `confirmed_match` and one terminal decision (`reject` / `unrelated` / `duplicate_confirmed` / `manual_accounting_recorded`); superseded proposals can't be decided.
  - For `manual_accounting_recorded` it requires, under lock: an admin; a payable form; net > 0; the bill's live total = the net; the deposit invoice's live paid amount = the recomputed snapshot (else `stale_reconciliation`); a POSTED adjusting JE in this community; and no other bill already applied to the deposit.
  - UPDATE/DELETE on `vendor_deposits` is revoked, so edits only go through the audited function.
  - The JS layer also re-evaluates live data first, and refuses a full-face bill or a non-positive net before anything is written.
- **Duplicate or statement:** `duplicate_confirmed` keeps the bill HELD with "void it". The existing void reverses the accrual, so it is never treated as not-payable while its AP row and JE are still open.
- **Statement inference removed from the deposit path.** `lib/ap/statement_lines.js` counts any negative "deposit" line as a Vantaca prior payment, which would have turned a genuine "full total less deposit" bill into a non-payable statement. In the deposit context, "statement" is now a person's call. (Tested.)
- **Intake** proposes against EACH open deposit. Kept from before: deposit lines stay on 1430; a deposit-looking bill from a vendor with an open deposit isn't recorded as a new deposit; the bill routes to manager_review.
- **UI:** a red "⛔ Held: Emma cannot release this bill" banner and source documents on the reconciliation view. Buttons: Confirm match, Reject, Duplicate/statement, and (admin) Not related and Record manual deposit accounting (which asks for the JE reference). The queue shows the obligation state and document count.

**Deposit accounting design** (NOT implemented; the next, separately gated step). D = deposit billed, B = balance, T = D + B.

| Deposit booked as | Final bill form | Correct result | What today's intake posts | Adjusting entry |
|---|---|---|---|---|
| **Prepaid 1430** (intended; deposit Dr 1430 / Cr AP, paid Dr AP / Cr Cash) | Balance only (face B) | Dr Expense T, Cr 1430 D, Cr AP B | Dr Expense B / Cr AP B | **Dr Expense D / Cr 1430 D**; AP unchanged |
| Prepaid 1430 | Full total with credit line −D | Same | If the credit line is coded 1430: correct as posted. If coded to expense: Dr Exp T, Cr Exp D, Cr AP B | Credit coded 1430: none. Coded to expense: **Dr Expense D / Cr 1430 D** |
| Prepaid 1430 | Full total T, no credit | Same, payable B | Dr Expense T / Cr AP T | **Dr AP D / Cr 1430 D**, AND the AP bill must drop from T to B (add a −D line coded 1430). This is an AP amount change, so it belongs to the gated step. |
| **Expensed** (the 4 live rows; deposit Dr Expense / Cr AP) | Balance only | Total expense T, AP B | Dr Expense B / Cr AP B | None (optionally reclass to the project) |
| Expensed | Full total with credit line −D | Same | Credit coded to expense: correct. Coded 1430: Cr 1430 D (a wrong negative prepaid) | Coded 1430: **Dr 1430 D / Cr Expense D** |
| Expensed | Full total T, no credit | Payable B | Dr Expense T / Cr AP T | **Dr AP D / Cr Expense D**, AND the bill drops from T to B |

- **Unpaid deposit:** the same entries apply. The deposit bill's AP D stays open on its own bill, so AP totals D + B = T and the total is paid once.
- **Revised total T′:** expense T′; the variance is reviewed.
- **Net ≤ 0:** a vendor credit to collect (`vendor_credits_expected`), never a payable.
- **Converting the 4 live expensed deposits to prepaid now** would be Dr 1430 D / Cr Expense D, then relieved at completion as in the prepaid rows. That is Ed's decision, and it is a production GL write.
- **Until the automated step exists:** Ed posts the adjusting JE by hand (and nets the bill to B where needed, via void and re-enter), then records `manual_accounting_recorded` with the JE reference. The function re-checks everything under lock.

**Tests (revised).**
- `test_ap_deposit_followup` **22/22**, including:
  - the hold with no proposal;
  - the hold failing CLOSED without 471;
  - confirmed/pending, reject and duplicate all staying held;
  - admin unrelated releasing, with multiple deposits each needing resolution;
  - manual accounting: identity, admin, JE, stale re-check, the full-face bill refused, net ≤ 0 refused, released only after it, and re-held if the bill changes;
  - the obligation staying listed until PAID;
  - follow-up only via the audited function;
  - a "full total less deposit" bill NOT mistaken for a statement;
  - the real `commitInvoice` intake end to end (deposit line and JE on 1430 → completion bill proposal plus hold → a second same-amount "deposit" not recorded, and held), with nothing paid.
- `471_deposit_followups_rehearsal` **39/39**:
  - every function refusal, and that each refused call writes nothing;
  - the one-terminal and one-confirm limits, supersession, and one applied bill per deposit;
  - as the service role: direct UPDATE denied, direct ledger INSERT denied, and the function working;
  - append-only tables, grants and EXECUTE grants;
  - apply_one end to end (89 objects).
- **Sabotage:** removing the candidate hold, failing open, allowing a face-amount release, removing the stale check, or not revoking UPDATE each fails tests.
- **Full suite:** 123/128, the same 5 pre-existing failures.
- **Bug caught by the rehearsal and fixed:** `jsonb_populate_record` bypasses column defaults.

**Still needs Ed (unchanged; separate approvals).** Migration 471 approval; PRYME follow-up data; the reclass decision for the 4 expensed deposits; review of Texas Access Works 03-091426-001. **New:** approve building the gated accounting step per the table above.

---

## 2026-09-28: AP deposit follow-up for Emma (PRYME THYME KOOKERS #2836), first cut (superseded by the revision above)

**Task.** ChatGPT's "AP DEPOSIT FOLLOW-UP FOR EMMA" (Issue #1, 15:34 UTC), plus Ed's clarification on the four final-invoice forms (15:37 UTC). The model and approach were reported first in Issue #1 (#issuecomment-5873477749).

**Status.**
- Built on `feat/ap-deposit-followup` (cut from `main`; this commit).
- Not merged, not deployed.
- No production AP write, no payment, no check.
- **Migration 471 is proposed only.** Ed must approve it before it is applied.

**Existing model (verified).**
- `vendor_deposits` (364) already records deposits at intake. The "⚠ APPLY DEPOSIT" note flags a later bill from the same vendor.
- But nothing ever applied or closed a deposit.
- There was no due date, no agreed total and no reconciliation record, and approval never checked deposits.

**Production findings (read-only; NOT changed).**
- **Invoice 2836 posted Dr 5900 Community Events, not 1430 Prepaid Vendor Deposits.** Intake chose 1430, but the line coder re-coded the single line and the accrual followed the lines (JE-2026-00322).
- **All 4 deposits on file posted to expense accounts** (5450, 5905, 5450, 5900).
- **Texas Access Works (Canyon Gate):**
  - 03-090126-001, $22,035.61 ("50% due to start, 50% at completion"), is paid.
  - 03-091426-001, the same amount, is awaiting approval and was also read as a deposit.
  - It is most likely the completion bill. **A person should review it before approval.**
- **Invoice 2836 approval state:** a manager "approved" row exists (15:17 UTC), but the invoice is still `awaiting_approval`; the admin release is pending. amount_paid is 0.

**Built.**
- **`lib/ap/deposit_reconcile.js`:** pure logic, no DB.
  - Classifies the next bill as balance_only, full_total_less_deposit (with or without a credit line), revised_total, duplicate_or_statement, or ambiguous.
  - Reconciles against the deposit ACTUALLY PAID.
  - Invariant: paid + still owed + net due = final total, so the Association pays the total once, paid deposit or not.
  - A second same-amount "deposit" (the Texas Access pattern) is ambiguous.
  - `forceDepositLineCoding` keeps a deposit's lines on 1430.
- **`lib/ap/deposit_followup.js`:**
  - the upcoming-balances queue, keyed on the deposit, so it survives the deposit being paid;
  - `setFollowup` (a basis is required for any agreed total; an estimate is labeled as one);
  - propose / decide (approve, reject, unrelated; the proposer can't decide; flagged items need an admin; approval only when the bill total already equals the net due; approval marks the deposit applied and never pays);
  - the approval gate.
- **`lib/ap/intake.js`:**
  - deposit lines follow 1430;
  - a deposit-looking bill from a vendor with an open deposit is flagged and NOT recorded as a new deposit;
  - all open deposits are read;
  - a bill that may consume a deposit routes to manager_review;
  - one open deposit triggers an automatic reconciliation proposal.
- **`api/ap.js`:**
  - `GET /api/ap/deposits/upcoming`, `PATCH /deposits/:id/followup`, `POST /deposits/:id/reconcile`, `POST /deposit-reconciliations/:id/decide`;
  - invoice detail returns `deposit`;
  - **approve and release return 409** while a reconciliation is pending, was rejected, doesn't match the net due, or was reconciled as a duplicate or statement. The gate fails closed (503) if it can't check.
- **`public/index.html`:** a "💰 Upcoming balances" AP sub-tab, and a deposit block on the invoice detail (the follow-up form on the deposit bill; the reconciliation view with Approve / Reject / Not related on the final bill).
- **`migrations/471_vendor_deposit_followups.sql`** (PROPOSED) and `migrations/checks/471_vendor_deposit_followups.json`:
  - follow-up columns on `vendor_deposits`;
  - append-only `vendor_deposit_reconciliations` (paid + still owed = billed CHECK), `vendor_deposit_reconciliation_decisions` (one per reconciliation), `vendor_deposit_events`;
  - service_role SELECT and INSERT only;
  - creates no data; 79 objects added, 0 changed.

**Tests.**
- `tests/test_ap_deposit_followup.js` **22/22**: each form, the unpaid deposit, the reminder surviving payment, no duplicate payable, no payment or JE from any path, the proposer can't decide, the final amount needs approval at the net due, the gate states, and graceful degradation before 471.
- `tests/sql/471_deposit_followups_rehearsal.mjs` **20/20**, including an apply_one end-to-end run with the real checks file.
- Sabotage: each of three disabled protections (the gate, paying the face, the deposit line coding) failed tests.
- Full suite: 123/128, the same 5 pre-existing failures.
- The UI block was render-checked.

**Needs Ed (separate approvals).**
1. **Approve migration 471.** Then a file-only commit to main, and apply via the owner panel. Only then merge this branch.
2. **PRYME follow-up data:** event and balance due Oct 10, 2026, agreed total $6,685 as an estimate from the invoice's 50% statement. Entered through the new form after deploy, or approved as a one-off write.
3. **Reclass decision** for the 4 deposits posted to expense (→ 1430). This would be correcting JEs, which is a production GL write.
4. **Review Texas Access Works 03-091426-001** before anyone approves it.

**Side finding.** In `api/operations.js`, `GET /:id` (line 220) is registered before `GET /upcoming` (line 403), so `/api/operations/upcoming` probably hits the project handler. Not verified at runtime; not fixed here.

---

## 2026-09-27: Stripe-hosted onboarding link opened for Ed; onboarding NOT yet completed

**Task.** ChatGPT's "ED APPROVED STRIPE-HOSTED ONBOARDING" instruction (Issue #1, 23:09 UTC).

**Done.**
1. From Ed's signed-in owner session (his browser, via the Claude in Chrome extension): `POST /api/payments/connect/onboard` for Drama Creek returned HTTP 200. It **reused** the existing TEST Express account `acct_1UKR8…`; no second account was created. The onboarding link is on `connect.stripe.com`, with return URL `https://app.bedrocktxai.com/?stripe_onboarded=1`.
2. The link was opened in Ed's browser (tab "[Test] Bedrock Association Management LLC sandbox | Set up payments with Stripe"). Stripe shows "You're using a test account with test data."
3. **Claude entered nothing** in the Stripe form.

**Read-only state now** (the form is still on the first "Let's get started" screen, phone empty; Ed has not completed it):
- Drama Creek `stripe_connected_account_id` is the same account (`acct_1UKR8…`, full-id match).
- `stripe_onboarding_status` = **restricted** (set by the webhook; Stripe requirements outstanding). `stripe_onboarded_at` = null.
- **Connected-account webhook works end to end.** `stripe_events` holds 1 row: `account.updated` for `acct_1UKR8…`, received 23:06:21 UTC, status **processed**, no error. It was verified with `STRIPE_CONNECT_WEBHOOK_SECRET`, and the handler updated Drama Creek's status. It came from the account's creation during the earlier test-onboard attempt, not from onboarding.
- charges_enabled / payouts_enabled: **not yet** (status restricted; the exact requirements list is not visible without Stripe access; it shows in Stripe after onboarding).
- **No checkout or payment:** payments still 10.

**Remaining blocker.** Ed completes the Stripe TEST onboarding form himself, using Stripe's test values (test phone and code `000000`, SSN `000-00-0000`, DOB `01/01/1901`, routing `110000000`, account `000123456789`, accept ToS). Stripe account links are single-use and expire within minutes; if it has expired, Claude regenerates one for the same account (the route reuses it). After completion, Claude verifies read-only:
- same account;
- status enabled and `stripe_onboarded_at` set;
- a new `account.updated` processed;
- payments unchanged.

**Next after that (separate approval).** The first $1 test payment on DC-45-060 (see the previous entry).

---

## 2026-09-27: Sandbox PROVISIONED and verified; Drama Creek Stripe test account created but NOT onboarded (blocker)

**Task.** ChatGPT's "ED APPROVED SANDBOX PROVISIONING" instruction (Issue #1): plan, apply only if exact, verify, create/onboard the Drama Creek test connected account, no checkout or payment.

**How it was run.** From Ed's own signed-in trustEd session (ADMIN) in his browser, via the Claude in Chrome extension. Claude made same-origin calls from the page; no credentials were entered by Claude and no token left the page. Stripe TEST mode throughout.

**1. Plan** (`POST /api/payments/test/payment-sandbox`, action `plan`; runs and rolls back): HTTP 200, `committed:false`, `stripe_mode:"test"`, **29 rows**:
- `properties` 1 (DC-45-060 `e09d3deb-57c7-4028-b366-4f79c9379708`: payment_sandbox=true, Trusted # 1002900060, only if null);
- `communities` 1 (Drama Creek GL cutover 2026-09-01, only if null);
- `account_funds` 1 (OPR); `chart_of_accounts` 3 (1000/1090/1300);
- `accounting_periods` 16 (2026-09-01 to 2027-12 open monthly);
- `community_account_roles` 3;
- `contacts` 1; `property_ownerships` 1 (current tenure `23e196cd-dc21-4021-a479-74a876aab6f8`); `portal_users` 1; `portal_user_properties` 1.

The before-state was completely empty (no conflicts), and the preflight (demo community, lot in it, no other sandbox lot, test key) passed. The plan matched the reviewed design exactly.

**2. Apply** (action `apply`): HTTP 200, `committed:true`, `stripe_mode:"test"`; after-state identical to the plan.

**3. Read-only verification** (independent, service-role selects; 20/20):
- Exactly one `payment_sandbox` property: DC-45-060 in Drama Creek (demo). Trusted # 1002900060, unique.
- Drama Creek GL cutover 2026-09-01. OPR fund and COA 1000 / 1090 "Cash in Transit - Stripe Clearing" / 1300, all with fixed ids. 16 open monthly periods 2026-09 to 2027-12.
- 3 roles: homeowner_ar=1300, operating_cash=1000, stripe_clearing=1090 (updated_by payment-sandbox).
- Test owner on the lot's current tenure. Portal login `payments-sandbox@bedrock.test`: active homeowner, scoped to DC-45-060 only (1 portal user, 1 contact).
- **Nothing else changed:** payments 10; `stripe_events` 0; `homeowner_transactions` 29,117; `journal_entries` 1,790; `assessment_autopay` 0; no refunded payments; real-community roles still 18; 1090 accounts = 6 real + 1 Drama Creek.
- (One probe line first showed a false FAIL: a `LIKE` on a uuid column returns count null with no error, the known PostgREST false-read. Re-checked by exact id: correct.)

**4. Stripe test connected account** (`POST /api/payments/connect/test-onboard`, community Drama Creek): **HTTP 500 `company_update_failed`**. Stripe: "You cannot accept the Terms of Service on behalf of accounts where `controller[requirement_collection]=stripe`, which includes Standard and Express accounts."
- The route created the Express test account and stored it before the failing step. Drama Creek now has `stripe_connected_account_id` = `acct_1UKR8…`, `stripe_onboarding_status` = `in_progress`, `stripe_onboarded_at` = null.
- The API-prefill shortcut cannot onboard Express accounts: Stripe collects their requirements itself. This is a pre-existing limitation of that route.

**5. Connected-account status.** Not charges-enabled or payouts-enabled (onboarding incomplete). Exact `still_needed` not returned (the route failed before it asked Stripe for requirements).

**Checkout or payment created.** **No.** Payments 10, `stripe_events` 0.

**Blocker.** Drama Creek's Express test account must finish **Stripe-hosted onboarding** before the $1 test payment. Options:
- **(a) Recommended, no code change.** Claude calls the existing `POST /api/payments/connect/onboard` for Drama Creek (reuses `acct_1UKR8…`) to get a Stripe-hosted onboarding link. Ed opens it and completes it in TEST mode using Stripe's test values (Stripe shows test-data helpers; for example SSN 000-00-0000, routing 110000000, account 000123456789). Claude does not type identity or bank values into Stripe's form. When finished, Stripe sends `account.updated` to the connected-accounts endpoint, which also exercises the connect webhook path, and Drama Creek becomes enabled.
- **(b)** Change `test-onboard` to create a Custom test account instead (the platform may accept ToS for Custom). This is a code change plus a different account type from production communities; not recommended.

**Exact next step for the first $1 test payment (after onboarding shows charges_enabled).** From Ed's session: `POST /api/payments/test/assessment-checkout` with `{ property_id: "e09d3deb-57c7-4028-b366-4f79c9379708", payment_method: "card" }`. It returns a Stripe TEST checkout URL (fixed $1). Ed pays with 4242 4242 4242 4242. Claude verifies read-only: the `stripe_events` row; payment settled and posted; ledger row on tenure `23e196cd…`; JE `stripe:pay:<id>` Dr 1090 / Cr 1300 for $1.00.

**Decisions needed from Ed.** Approve option (a) (Claude generates the hosted onboarding link; Ed completes it in test mode). The $1 payment stays a separate approval.

---

## 2026-09-27: Sandbox provisioning NOT yet started: blocked on Ed's signed-in owner session

**Task.** ChatGPT's "ED APPROVED SANDBOX PROVISIONING" instruction (Issue #1, 22:34:49 UTC), followed by the 22:55 review check.

**What was actually done.** **Nothing in production or Stripe.**
- Claude's previous Issue #1 read (about 22:33 UTC) came before the 22:34:49 approval, so that instruction was missed until the 22:55 review check.
- No plan call, no apply, no Stripe connected account, no checkout, no payment.
- Plan/apply results: none. Verification counts: unchanged from the last check (`stripe_events` 0, `payments` 10, `homeowner_transactions` 29,117, `journal_entries` 1,790).
- Drama Creek Stripe connected account: not created (`stripe_connected_account_id` null, as last read).
- Checkout or payment created: **no**.

**Blocker.** Both steps are owner/admin-only routes behind the staff sign-in:
- `POST /api/payments/test/payment-sandbox` (admin role plus a test key);
- `POST /api/payments/connect/test-onboard` (staff session plus a test key).

Claude does not enter passwords or sign in. The plan is to run them from the built-in browser pane using Ed's own signed-in trustEd session. The pane currently shows the trustEd sign-in page ("Sign in with Microsoft"): no session.

**To unblock.** Ed signs in to trustEd (my.bedrocktxai.com) in the Claude browser pane himself. Then Claude, in order:
1. calls **plan** (runs and rolls back) and reports the 29 planned rows and any conflicts against the reviewed design;
2. **applies** only if the plan exactly matches;
3. verifies read-only;
4. calls **test-onboard** for Drama Creek and reports charges_enabled / payouts_enabled / still_needed;
5. updates this file and stops.

No checkout or payment.

**Exact next step for the first $1 test payment (after the above, and only on approval).** `POST /api/payments/test/assessment-checkout` with `property_id` = `e09d3deb-57c7-4028-b366-4f79c9379708` (DC-45-060), `payment_method` = card, from the owner session. It returns a Stripe TEST checkout URL; Ed pays with 4242 4242 4242 4242 (any future expiry, any CVC). Claude then verifies the webhook, posting and GL read-only.

---

## 2026-09-27: Both webhook secrets verified: CLEARED for sandbox provisioning

**Task.** Per ChatGPT's instruction in GitHub Issue #1: focused read-only verification after Ed restored `STRIPE_WEBHOOK_SECRET` (platform endpoint "inspiring-victory") alongside `STRIPE_CONNECT_WEBHOOK_SECRET` (connected-account-updates endpoint) and redeployed.

**Status.** **CLEARED for sandbox provisioning.** Sandbox NOT provisioned; no payment created (waiting for ChatGPT review and Ed's approval).

**Production.** `/version` = `9a0b1d55` (current main; payment code as merged in `6fdc7031`), booted 2026-09-27 22:32:36 UTC, healthy.

**Probe results** (deliberately bad or missing signatures; refused at verification):

| Probe | Result |
|---|---|
| Platform `checkout.session.completed`, fresh timestamp, bad signature | **400 `signature mismatch`**, source=platform, secret_present=true (no 503) |
| Connected-account `account.updated`, fresh timestamp, bad signature | **400 `signature mismatch`**, source=connect, secret_present=true (no 503) |
| Platform, unsigned | 400 `missing_signature` |
| Connected-account, unsigned | 400 `missing_signature` |

**No production writes.** Counts before and after the probes are identical: `stripe_events` 0/0, `payments` 10/10, `homeowner_transactions` 29,117/29,117, `journal_entries` 1,790/1,790. There are no `evt_smoke*` rows.

**Now true in production (Stripe TEST mode):**
- All three secrets are recognized (`PAYMENT_LINK_SECRET` confirmed earlier; both webhook secrets now).
- Each webhook path verifies with its own secret.
- Real-homeowner checkout is blocked by the test-mode gate.
- Autopay is off. 469 is applied. Migration status is clean.

**Next (each needs Ed's explicit approval):**
1. Provision the sandbox (plan, review the 29 rows, then apply).
2. Create the Drama Creek test connected account.
3. Run the $1 staff test checkout on DC-45-060 with the Stripe test card.
4. Verify posting read-only.

See the entry below "Payment foundation MERGED and DEPLOYED" for step detail.

---

## 2026-09-27: Webhook secrets re-check after Ed's Render change: connect FIXED, platform now MISSING

**Task.** Per ChatGPT's instruction in GitHub Issue #1: focused read-only verification after Ed added `STRIPE_CONNECT_WEBHOOK_SECRET` and redeployed.

**Status.** **Not cleared for sandbox provisioning yet.** The connect secret is now recognized, but the platform secret `STRIPE_WEBHOOK_SECRET` is no longer visible to production.

**Production.** `/version` = `6dc709af` (current main; code identical to merge `6fdc7031` plus the handoff), booted 2026-09-27 22:06:43 UTC, healthy.

**Probe results** (unsigned or invalid deliveries, refused at signature verification):

| Probe | Result | Meaning |
|---|---|---|
| Connected-account `account.updated`, fresh timestamp, bad signature | 400 `signature mismatch`, source=connect, secret_present=true | Connect secret now RECOGNIZED; verification active |
| Connected-account, stale timestamp, bad signature | 400 `signature timestamp too old` | Replay refused |
| Connected-account, no signature | 400 `missing_signature` | Unsigned refused |
| **Platform `checkout.session.completed`, fresh timestamp, bad signature** | **503 `platform_webhook_secret_not_configured`** | **Platform secret now MISSING** |
| Platform, no signature | 400 `missing_signature` | Unsigned refused |

`stripe_events` count 0 before and after, no smoke rows; `payments` 10 before and after. No production writes.

**What changed.** At 22:04 UTC (the merge deploy) the platform probe returned 400 with secret_present=true, so `STRIPE_WEBHOOK_SECRET` was set. After Ed's Render change and redeploy, it is gone. Most likely the existing `STRIPE_WEBHOOK_SECRET` entry was edited or renamed to `STRIPE_CONNECT_WEBHOOK_SECRET` instead of a second variable being added.

**Effect now.**
- Platform payment webhooks (checkout, payment failed, refunds, disputes) are refused with 503; Stripe retries them. Nothing is lost while Stripe retries, but Stripe may disable an endpoint that keeps failing.
- No payments can occur in TEST mode for real homeowners, and there is no sandbox yet, so there is no money impact.
- Connected-account events now work.

**Fix (Ed, Render, trustEd web service, Environment).** There must be TWO separate variables:
1. `STRIPE_WEBHOOK_SECRET` = the signing secret of the **platform** endpoint (Stripe Dashboard, Test mode, Webhooks, the endpoint to `/api/payments/webhook` that is NOT marked Connected accounts, Signing secret).
2. `STRIPE_CONNECT_WEBHOOK_SECRET` = the signing secret of the **Connected accounts** endpoint (keep as is).

The two values must be different. Save, redeploy, then Claude reruns this check. Expected: both paths return 400 on a bad signature, neither returns 503.

**Cleared for sandbox provisioning?** Not yet. The sandbox's $1 test payment needs the platform webhook to confirm and post it. Recommend clearing after the next check shows both secrets recognized (all smoke checks green).

**Decisions needed from Ed.** Restore `STRIPE_WEBHOOK_SECRET` (platform) alongside the connect secret, redeploy, and tell Claude to re-verify.

**Re-check 2026-09-27 22:27 UTC** (same instruction re-run; no new Render deploy since: production `0e4cc940`, booted 22:13 UTC, which was the handoff-commit deploy): unchanged. Connect: bad signature 400 (secret recognized), no signature 400. **Platform: bad signature 503 `platform_webhook_secret_not_configured`**; no signature 400. `stripe_events` 0 before and after, payments 10 before and after, no writes. Still **not cleared** for sandbox provisioning until `STRIPE_WEBHOOK_SECRET` is restored.

---

## 2026-09-27: Payment foundation MERGED and DEPLOYED (Stripe TEST mode only)

**Task.** Per ChatGPT's instruction in GitHub Issue #1 (Ed approved the merge): merge `feat/payments-safe-foundation`, push main, confirm the deploy, run read-only smoke checks. No live key, no sandbox data, no payments.

**Status.** Merged and deployed. 17/19 smoke checks pass. **One config item is open: production does not see `STRIPE_CONNECT_WEBHOOK_SECRET`** (details below). It fails safe; payments are unaffected.

**Commits.** Merge commit `6fdc7031` on main (merges `feat/payments-safe-foundation` at `79cbb258`; 28 files; 469 and its checks file unchanged). This handoff update is the commit after it.

**Deploy.** Production `/version` = `6fdc7031`, booted 2026-09-27 22:04:31 UTC (live about 100 s after push).

**Smoke checks** (read-only; HTTP probes were unsigned or invalid and refused before any handler work; DB selects only; no rows created):
- OK: server healthy; `/version` is the merge commit.
- OK: 469 recorded exactly once, clean, applied, approved hash. Migration status clean: 0 of 473 files pending.
- OK: platform webhook reachable, signature verification active (bad signature refused with 400, source=platform).
- OK: `STRIPE_WEBHOOK_SECRET` recognized (secret_present=true; not 503).
- OK: Stripe mode is TEST (the test-mode-only delivery diagnostic is returned, and it is only returned with an `sk_test_` key).
- **FAIL: connected-account webhook returned 503 `connect_webhook_secret_not_configured`.** The connect path is used correctly (source=connect), but the running server has no `STRIPE_CONNECT_WEBHOOK_SECRET` value.
- **FAIL: `STRIPE_CONNECT_WEBHOOK_SECRET` recognized** (same cause).
- OK: unsigned webhook delivery refused (400); no `stripe_events` row created by the probes.
- OK: `PAYMENT_LINK_SECRET` recognized (a bad link returns 400 "isn't valid", not 503 "unavailable").
- OK: portal checkout requires a signed-in homeowner (401 unauthenticated).
- OK: real homeowner checkout in TEST mode is refused by the containment gate. This ran the deployed checkout code against production data (a real Quail Ridge lot, Stripe-onboarded, current owner) through a client that blocks all writes, with a Stripe stub. Result: `test_mode_sandbox_only`, no Stripe session attempted, no write attempted, payments table unchanged (10 before, 10 after).
- OK: autopay begin returns 503 `autopay_unavailable`; charging disabled in the deployed code; `assessment_autopay` empty.

**Open item: `STRIPE_CONNECT_WEBHOOK_SECRET` not visible to production.** It was reported as set, but the deployed process (booted 22:04 UTC) does not have it. Likely causes:
- the key name differs (typo or spaces);
- it was set on a different Render service or an unlinked environment group;
- it was saved after this deploy started, or without a redeploy.

Effect: connected-account `account.updated` deliveries get 503 and Stripe retries them. Platform payment events work. Nothing is lost while Stripe retries (up to about 3 days), but Stripe may disable an endpoint that keeps failing.

Fix (Ed, in Render):
1. Open the trustEd web service (the one that already has `STRIPE_WEBHOOK_SECRET`), then Environment.
2. Confirm a variable named exactly `STRIPE_CONNECT_WEBHOOK_SECRET`, whose value is the **Connected accounts** endpoint's signing secret (Stripe Dashboard, Test mode, Webhooks, the Connected accounts endpoint, Signing secret). It is not the platform endpoint's secret.
3. Save and redeploy.
4. Claude reruns the read-only smoke check.

**Remaining steps to an end-to-end sandbox payment today** (each needs Ed's explicit approval; all in Stripe TEST mode):
1. (Recommended first) Fix `STRIPE_CONNECT_WEBHOOK_SECRET` as above. Not strictly required for the payment itself; it affects only `account.updated`.
2. **Provision the sandbox** (Claude, via the owner/admin session in the browser pane): `POST /api/payments/test/payment-sandbox` with `plan`, show the 29 rows, then `apply`. It creates Drama Creek lot DC-45-060's sandbox flag, Trusted # 1002900060, GL (OPR fund, 1000/1090/1300, open periods, cutover 2026-09-01), account roles, test owner and portal login.
3. **Create the Drama Creek test connected account** with `POST /api/payments/connect/test-onboard` for Drama Creek. This is a call to Stripe's TEST API using Stripe's documented test identity data.
4. **One test payment.** The sandbox balance is $0, so use the staff test route `POST /api/payments/test/assessment-checkout` for DC-45-060 (a fixed $1 in test mode), then pay on Stripe's test checkout with a test card (4242 4242 4242 4242).
5. **Verify read-only:** `stripe_events` has the delivery; the payment is settled and posted; the ledger has the payment row on the sandbox tenure; a JE `stripe:pay:<id>` debits 1090 and credits 1300 for $1; nothing touches real communities.
6. (Optional) Test the refund path: refund the $1 in Stripe test mode, then confirm a separate `payment_reversal` row, JE `stripe:rev:<id>`, and the original payment still visible.

**Remaining known limitations** (unchanged; blockers for LIVE only): payouts and bank reconciliation (1090 to operating cash); Stripe fee accounting and policy; no staff review UI; autopay off; old pay links invalid; the `api/system.js` env list lacks the two new secrets; the test-mode webhook diagnostic should be removed before live.

**Decisions needed from Ed.**
1. Fix `STRIPE_CONNECT_WEBHOOK_SECRET` in Render, then tell Claude to rerun the smoke check.
2. Approve sandbox provisioning (step 2) and the Drama Creek test connected account (step 3).
3. Approve the first $1 test payment (step 4).

**Recommended next action.** Ed fixes the connect secret. Claude reruns the smoke check. Then, on approval, the sandbox steps 2 to 5 in order, reporting after each.

---

## 2026-09-27: FINAL PRE-MERGE VERIFICATION, payment foundation (NOT merged, NOT deployed, sandbox NOT provisioned)

**Task.** Per ChatGPT's instruction in GitHub Issue #1: final pre-merge verification only. No code changes in this step.

**Status.** Verification complete. **Recommendation: READY to merge to main for TEST-MODE-ONLY deployment** (details below). Stopped for ChatGPT review and Ed's merge approval.

**Final branch commit.** `feat/payments-safe-foundation` at `39f25517` (code at `b4354b8d`); this handoff update is the commit after it. Local and remote identical.

**1. Drift.** None. `origin/main` is still `003ffa76`; the branch contains it; 0 main commits missing. Branch vs main: 28 files, payment code, tests, the preflight script and this file only.

**2. Final test results** (local; mock Stripe; PGlite in-memory; no production writes):
- `test_payment_foundation` 45/45.
- Related suites all pass: dedup, ledger path, ownership transfer, gl_concept (12), operator actions, early prepay (23), checkout preview gate (8), bedrock_pay (11), autopay (20).
- 469 rehearsal 79/79; 469 end-to-end through the tool 13/13; tool rehearsal 57/57.
- `check_migration_checks`, `check_migration_immutability` (473 files; 27 pinned exceptions), `check_constraint_values` and `check_pagination` pass; node syntax OK on every changed server file.
- `check_requires_tracked` fails only on the pre-existing `tests/test_proposal_boundary.js -> ../lib/presentations` (identical on main; unrelated).

**3. Migration 469.** SQL (`5d10f2b4...3130`) and checks file (`1d404af8...29fe`) are byte-identical between the branch and main. 469 is already applied and verified in production; no new migration.

**4. Secrets are expected and fail closed** (verified by tracing every read and by running the real functions with the secrets unset):
- `PAYMENT_LINK_SECRET` (min 32 chars, no fallback), read only in `lib/payments/payment_link.js`. Missing: minting returns 503 `payment_link_not_configured`; `/pay/:token` shows "temporarily unavailable" (503).
- `STRIPE_WEBHOOK_SECRET`: platform deliveries only (`lib/payments/webhook_auth.js`). Missing: platform deliveries get 503 `platform_webhook_secret_not_configured`.
- `STRIPE_CONNECT_WEBHOOK_SECRET`: connected-account deliveries only. Missing: those deliveries get 503 `connect_webhook_secret_not_configured`, and platform deliveries are unaffected. A delivery is never verified with the other source's secret.

**5. Test-mode containment** (tests pass this run):
- TEST key + real community: portal, pay link and staff $1 route are all refused (`test_mode_sandbox_only`), with no payment rows and no Stripe session.
- TEST key + the designated sandbox lot (demo community): portal and staff test route allowed. A sandbox flag outside a demo community is refused.
- LIVE key: real communities allowed by the gate; sandbox or demo refused. Unconfigured key: refused.
- The demo-guard exception is still test-key-only, sandbox-lot-only, and checkout/account only.

**Stripe TEST webhook configuration (as reported by Ed; not independently inspected; Stripe was not accessed).**
- Platform endpoint `https://my.bedrocktxai.com/api/payments/webhook` listens to all 8 required events: `charge.dispute.closed`, `charge.dispute.created`, `charge.refunded`, `checkout.session.async_payment_failed`, `checkout.session.async_payment_succeeded`, `checkout.session.completed`, `checkout.session.expired`, `payment_intent.payment_failed`.
- A separate Connected accounts endpoint to the same URL is active and listens to `account.updated`.

**Production env prerequisites (as reported by Ed).** `PAYMENT_LINK_SECRET` set; `STRIPE_CONNECT_WEBHOOK_SECRET` set. Existing: `STRIPE_SECRET_KEY` (test), `STRIPE_WEBHOOK_SECRET`, `DATABASE_URL`, `MIGRATION_PLAN_SECRET`. The secrets were not read, and presence was not independently verified. After deploy, `node scripts/stripe_preflight.js` in the Render shell confirms presence without printing values.

**Timing note (why merge sooner rather than later).** Production is running main, whose webhook verifies every delivery with `STRIPE_WEBHOOK_SECRET` only. The new Connected accounts endpoint's deliveries are therefore failing signature checks (400) on production right now. Stripe retries, and may disable an endpoint that keeps failing. The platform endpoint works; main ignores the new event types with 200. Merging this branch fixes the connected-account deliveries.

**Remaining known limitations (by design for test mode; not blockers for a test-mode merge).**
- Payouts and bank reconciliation not built: nothing moves 1090 (cash in transit) to operating cash. **Must be built before any live payments.**
- Stripe fee accounting and policy: ACH and dispute fees are billed to the platform and not recorded. Needs Ed's policy decision before live.
- No staff review UI for blocked or review payments, or retry-posting (API only).
- Autopay off (enrollment 503; charging disabled).
- Old pay links invalid: links issued before owner binding are refused; staff must re-send.
- Minor, not blockers:
  - `api/system.js` env status page lists only `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` (the two new secrets are not shown there).
  - The pre-existing test-mode webhook diagnostic returns an 8-character secret prefix on a failed signature (remove before live).
  - The signature verifier checks only the last `v1` during secret rotation.

**What a test-mode merge changes in production.**
- Real homeowners cannot open a Stripe session (they get "not available yet"); only the sandbox lot can, and it doesn't exist until provisioning is approved.
- Autopay setup shows unavailable.
- Webhook deliveries are processed idempotently through `stripe_events`.
- No database migration, and no data changes on deploy.

**Recommendation.** **Ready to merge `feat/payments-safe-foundation` to main for TEST-MODE-ONLY deployment**, on these conditions:
1. `STRIPE_SECRET_KEY` remains `sk_test_`.
2. The sandbox is provisioned only as a separate approved step.
3. After deploy: confirm `/version` shows the merge commit, then run `node scripts/stripe_preflight.js` in the Render shell (read-only) to confirm the secrets and webhook events.
4. No live mode until payout/bank reconciliation, fee policy and a staff review UI exist.

**Decisions needed from Ed.**
1. Approve the merge to main (test mode only). Merging soon also stops the connected-account webhook 400s.
2. After deploy, a separate approval for sandbox provisioning plus the Drama Creek test connected account.
3. Later (before live): fee policy, and prioritizing payout/bank reconciliation plus the staff review UI.

**Recommended next action.** ChatGPT reviews this verification. Ed approves the test-mode merge. Claude merges, waits for the deploy, and verifies read-only (version, route smoke check, preflight if Ed runs it in the Render shell). No sandbox, Stripe change or live mode.

---

## 2026-09-27: Connected-account webhook signing secret (NOT merged, NOT deployed, sandbox NOT provisioned)

**Task.** Per ChatGPT's instruction in GitHub Issue #1 (after approving `c871f36b`): one bounded fix, a dedicated `STRIPE_CONNECT_WEBHOOK_SECRET` for connected-account webhook deliveries, plus tests, preflight reporting and this update.

**Status.** Done. Stopped for ChatGPT review. The merge is still blocked on Ed's read-only Stripe endpoint check (see the previous entry for steps) and `PAYMENT_LINK_SECRET`.

**Branch / commits.** `feat/payments-safe-foundation`: `b4354b8d` (fix), then this handoff commit. Main untouched (`003ffa76`).

**Change.**
- New `lib/payments/webhook_auth.js` (`verifyStripeWebhook`), used by `POST /api/payments/webhook`. Each delivery is verified with exactly ONE secret, chosen by its source:
  - A top-level `account` field means the connected-accounts endpoint, verified with `STRIPE_CONNECT_WEBHOOK_SECRET`.
  - Otherwise it's the platform endpoint, verified with `STRIPE_WEBHOOK_SECRET`.
- There's no fallback to the other secret and no unsigned path. Choosing by the unverified `account` field is safe, because the field is inside the signed body: adding or removing it breaks the signature (tested).
- A missing secret refuses only that source, with 503 so Stripe retries once it's set. Platform payment events keep working without the connect secret.
- The 5-minute timestamp tolerance is unchanged. The function never returns or logs a secret value. The test-mode delivery diagnostic now uses the source's own secret.

**Tests / results** (local; no production writes):
- `test_payment_foundation` 45/45 (+8 webhook tests):
  - platform event + platform secret accepted;
  - platform event + connect secret refused;
  - platform event with only the connect secret configured refused (503);
  - connected `account.updated` + connect secret accepted;
  - connected `account.updated` + platform secret refused;
  - missing connect secret refuses connected-account events but platform events still pass;
  - no secrets refuses everything;
  - unsigned, malformed, stale (replayed) and tampered deliveries refused (`account` stripped or added).
- Sabotage: adding a fallback to the other secret fails 2 tests.
- Existing related suites all pass (dedup, ledger path, ownership transfer, gl_concept, operator actions, early prepay 23, checkout preview gate 8, bedrock_pay 11, autopay 20).
- 469 rehearsal 79/79, 469 end-to-end 13/13, tool rehearsal 57/57; migration-checks, immutability, constraint and pagination checks pass; syntax OK.
- `check_requires_tracked` fails only on the pre-existing `lib/presentations` item.
- 469 and its checks file are byte-identical to main.

**Preflight (`scripts/stripe_preflight.js`).**
- Reports whether `STRIPE_WEBHOOK_SECRET` and `STRIPE_CONNECT_WEBHOOK_SECRET` are present, printing no part of either value (the old 8-character webhook-secret prefix print is removed).
- Flags identical secrets, and flags an endpoint that points at the server while its secret is missing.
- The only prefix still printed is the API key's type prefix (`sk_test_` / `sk_live_`), which contains no secret characters.

**Production config for deploy (updated).**
- `STRIPE_WEBHOOK_SECRET`: existing; the platform endpoint's signing secret.
- `STRIPE_CONNECT_WEBHOOK_SECRET`: NEW. The signing secret of the connected-accounts endpoint (Stripe Dashboard, Test mode, Webhooks, that endpoint, "Signing secret"). Only needed if such an endpoint exists or is added for `account.updated`. Without it, those deliveries get 503 and nothing else is affected.
- `PAYMENT_LINK_SECRET`: required (previous entry).
- `STRIPE_SECRET_KEY` stays `sk_test_`.

**Risks / open issues.**
- Pre-existing (not changed here): the test-mode-only webhook signature diagnostic returns the secret's first 8 characters (the `whsec_` prefix plus 2 real characters) and expected-signature heads to any caller whose signature fails. It never runs with a live key. Recommend removing it before live.
- Stripe's signature header can carry several `v1` values while a secret is being rotated; the verifier checks the last one only. Pre-existing; relevant only during rotation.
- Unchanged from before: payouts and bank reconciliation not built; fee policy; no staff UI for review or blocked payments; old pay links stop working at deploy.

**Decisions needed from Ed.**
1. Read-only Stripe check of the TEST webhook endpoints: the 8 platform events, plus whether a connected-accounts endpoint exists with `account.updated`. Or allow `node scripts/stripe_preflight.js` in the Render shell.
2. Set `PAYMENT_LINK_SECRET` on Render.
3. If a connected-accounts endpoint exists (or is added later), set `STRIPE_CONNECT_WEBHOOK_SECRET` to its signing secret.
4. After ChatGPT review: approve the merge (test mode only). Sandbox stays a separate step.

**Recommended next action.** ChatGPT reviews `b4354b8d`. Ed does items 1 and 2. No merge, deploy, Stripe change or sandbox until approved.

---

## 2026-09-27: ChatGPT payment review fixes (NOT merged, NOT deployed, sandbox NOT provisioned)

**Task.** Per ChatGPT's payment review in GitHub Issue #1: (1) dedicated payment-link secret, (2) test-mode containment for real homeowner checkout, (3) Stripe webhook subscription readiness, (4) rerun tests, (5) update this file.

**Status.** Items 1, 2, 4 and 5 are done. Item 3 needs Ed (read-only check in the Stripe Dashboard; instructions below). Stopped for ChatGPT review.

**Branch / commits.** `feat/payments-safe-foundation`: `c871f36b` (fixes), then this handoff commit. Main untouched (`003ffa76`).

**Changes.**
1. *Payment-link secret* (`lib/payments/payment_link.js`).
   - Signs and verifies ONLY with `PAYMENT_LINK_SECRET`, at least 32 characters. The fallbacks to `STAFF_GATE_SECRET`, `STAFF_PASSWORD`, `STRIPE_WEBHOOK_SECRET` and `SUPABASE_KEY` are removed.
   - If the secret is missing or short, minting returns 503 `payment_link_not_configured`, and `/pay/:token` shows "Online payment is temporarily unavailable" (503). It never tells the homeowner their link is invalid, and the refusal is logged server-side.
2. *Test-mode containment* (`checkoutModeGate` in `lib/payments/assessment_checkout.js`). It runs before any payment row is written or any Stripe call is made, and covers every path (portal, pay link, staff test route) because they all go through the one checkout core.
   - TEST key: only the single `payment_sandbox` lot in a demo community. Real homeowners get 403 `test_mode_sandbox_only`, with no rows and no session. The staff $1 route is also sandbox-only now.
   - LIVE key: real communities only; a sandbox or demo lot gets 403 `sandbox_not_payable_live`.
   - Unconfigured: 503.
   - `payment_identity.js` now reads `properties.payment_sandbox` and `communities.is_demo`.
   - `/pay/:token` shows the "not available yet" page for a test-mode refusal.
3. *Preflight* (`scripts/stripe_preflight.js`, read-only): now checks all 8 platform events plus `account.updated` on a connected-accounts endpoint, and warns if two endpoints point at the server.

**Tests / results** (local; mock Stripe; PGlite in-memory; no production writes):
- `test_payment_foundation` 37/37 (+8 new): test key + real community refused with 0 rows and 0 sessions (portal, pay link, staff test route); test key + approved sandbox lot allowed; sandbox flag outside a demo community refused; live key + enabled real community allowed; live key + sandbox refused; unconfigured refused; no credential fallback; short or wrong secret refused.
- Sabotage: disabling the gate fails 4 tests; restoring a credential fallback fails the secret test.
- Existing related suites pass (dedup, ledger path, ownership transfer, gl_concept, operator actions, early prepay 23, checkout preview gate 8, bedrock_pay 11, autopay 20).
- 469 rehearsal 79/79, 469 end-to-end 13/13, tool rehearsal 57/57; migration-checks, immutability, constraint and pagination checks pass; syntax OK.
- `check_requires_tracked` still fails only on the pre-existing `lib/presentations` item (same on main).
- 469 and its checks file are byte-identical to main. No production DB touched.

**Webhook comparison (item 3).** Not inspected: the Stripe key exists only on Render, and I did not use any Stripe access. Ed checks in the Stripe Dashboard (read-only, change nothing):
1. Switch the Dashboard to **Test mode** (toggle top right).
2. Go to **Developers**, then **Webhooks** (sometimes shown as Workbench, then Webhooks).
3. Open the endpoint whose URL ends in `/api/payments/webhook`. Note whether it is **Enabled**.
4. Under **Listening to** (Events), check each of these 8 platform events is listed:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`
   - `payment_intent.payment_failed`
   - `charge.refunded`
   - `charge.dispute.created`
   - `charge.dispute.closed`
5. Check whether there is a **second** endpoint to the same URL marked "Connected accounts" (or "Listening to events on Connected accounts") that lists `account.updated`.
6. Report which of the 9 are present or missing, and how many endpoints point at `/api/payments/webhook`.

Alternatively, run `node scripts/stripe_preflight.js` in the Render shell, where the key already lives, for the same comparison.

**Finding (new blocker for `account.updated`).** The server verifies webhook signatures only with `STRIPE_WEBHOOK_SECRET`. Stripe delivers connected-account events such as `account.updated` from a separate connected-accounts endpoint with its own signing secret, so those deliveries would fail signature checks (400) today. Platform payment events are unaffected. Fix option for review: accept a second secret (for example `STRIPE_CONNECT_WEBHOOK_SECRET`) and verify against either. Not implemented (outside this bounded task). `account.updated` only refreshes onboarding status; it does not post money.

**Production config still required before deploy.**
- `PAYMENT_LINK_SECRET` set on Render (required now; without it, pay links are disabled, loudly).
- The webhook events above, confirmed or added (by Ed, later).
- The connected-account webhook secret decision (finding above).
- `STRIPE_SECRET_KEY` stays `sk_test_` for this phase. With it, only the sandbox lot can pay, and real homeowners get "not available yet".

**Remaining risks / blockers.** Payouts and bank reconciliation are not built (1090 accumulates). Stripe ACH and dispute fees are billed to the platform (policy). There's no staff UI for blocked or review payments. Previously emailed pay links stop working after deploy.

**Decisions needed from Ed.**
1. Do the Stripe Dashboard check above and report the result (or allow running the preflight in the Render shell).
2. Set `PAYMENT_LINK_SECRET` on Render (48+ random characters).
3. Decide on the connected-account webhook secret fix (implement second-secret support, or drop `account.updated` for now).
4. After ChatGPT review: approve the merge (test mode only); sandbox provisioning stays a separate step.

**Recommended next action.** ChatGPT reviews `c871f36b` and this entry. Ed does the read-only Stripe check. No merge, deploy or sandbox until approved.

---

## 2026-09-27: Payment application code prepared for review (NOT merged, NOT deployed)

**Task.** Per the ChatGPT instruction in GitHub Issue #1: re-sync `feat/payments-safe-foundation` onto main, drop the stale tool copy, keep 469 byte-identical, run the focused tests, summarize the diff, and list the production config deployment would need. No merge, no deploy, no Stripe or production change.

**Status.** Ready for ChatGPT review. This entry exists on the branch only; main's copy of this file stops at the "469 COMPLETE" entry.

**Branch.** `feat/payments-safe-foundation`. The re-sync merge commit is `19d57a5f` (main `003ffa76` merged in cleanly, no conflicts). This handoff update is the commit after it.

**Re-sync verification.**
- The migration tool is now exactly main's final version, so no stale copy remains: `lib/migrations/*`, the tool scripts and rehearsal, and the tool sections of `server.js` and `public/index.html` are all identical to main.
- 469 and its checks file are byte-identical to main (`5d10f2b4...3130`, `1d404af8...29fe`); neither was edited.
- The branch vs main diff is now payment code and its tests only: 25 files, +1911 / -170.

**Tests / results** (local; PGlite in-memory; no production writes):
- `test_payment_foundation` 29/29.
- Existing related suites all pass: `test_payment_dedup`, `test_homeowner_ledger_path`, `test_ownership_transfer_single_path`, `test_gl_concept`, `test_operator_actions`, `test_early_prepay` (23), `test_checkout_preview_gate` (8), `test_bedrock_pay` (11), `test_autopay` (20).
- 469 rehearsal 79/79 (includes sandbox provision / remove / recreate); 469 end-to-end through the tool 13/13; tool rehearsal 57/57.
- `check_migration_checks`, `check_migration_immutability`, `check_constraint_values`, `check_pagination` pass; node syntax OK on every changed server file.
- `check_requires_tracked` fails only on the pre-existing `tests/test_proposal_boundary.js -> ../lib/presentations` (same on main; unrelated).
- Not run: `test_demo_isolation` (writes suppressed-action rows to production).

**Diff summary.**
- *Checkout / auth.*
  - New `POST /api/portal/pay/checkout`: signed-in homeowner or board member, own lot only. Staff view-as and managers are refused, and more than one lot requires an explicit choice (`lib/payments/homeowner_checkout.js`).
  - One checkout core (`lib/payments/assessment_checkout.js`): the server decides the lot, the owner (current tenure) and the amount (the tenure balance). The client can't set an amount; only the test route can use a fixed $1, and only with a test key.
  - The old unauthenticated `POST /api/payments/assessment/create-checkout` now returns 410.
  - New staff `POST /api/payments/test/assessment-checkout` (test key only).
  - Portal pages call the new route.
  - Pay links (`payment_link.js`) are bound to the owner tenure: after a sale a link returns 410 instead of paying the buyer. Links issued before this change are refused (`pre_tenure_link`). The hard-coded signing fallback is removed.
- *Stripe webhook / idempotency.*
  - Every event is claimed once in `stripe_events`: already processed returns 200 duplicate, in progress returns 409 (Stripe retries), and a handler error returns 500 (Stripe retries).
  - A livemode mismatch is ignored loudly.
  - Payment rows carry a `payment_group_id` created before the Stripe session and sent in its metadata.
  - Non-assessment (amenity) events still go to the legacy handlers.
- *Tenure / property identity* (`payment_identity.js`). Every assessment payment records the property, the owner tenure, the contact and the Trusted account number captured at checkout. It refuses if there's no owner, more than one owner, or no Trusted number. It credits the captured tenure even if the lot sells before settlement. The Vantaca number comes from the tenure, not the lot.
- *Ledger posting + GL* (`payment_store.js`, 469 functions).
  - Card: credited only when Stripe reports "paid". ACH: "processing" until `async_payment_succeeded`, so nothing is credited before settlement; failure never credits.
  - Posting order:
    1. a tenure-stamped AR row in a DRAFT batch;
    2. the GL entry `stripe:pay:<id>`, Dr stripe_clearing role (1090) / Cr homeowner_ar role (1300);
    3. commit, and only then is the credit visible.
  - Accounts come from `community_account_roles`, never from numbers in code.
  - A community that isn't on the live GL is marked `not_applicable`. A missing role or closed period is marked `blocked`, and staff can re-run it with `POST /api/payments/:id/retry-posting`.
  - Payments apply per Tex. Prop. Code 209.0063; unapplied remainders are allowed.
  - `operator_core` cash on hand excludes stripe_clearing, which is shown separately as cash in transit.
- *Refund / chargeback reversal.*
  - A full refund or full-amount dispute drafts a separate dated +amount row (`payment_reversal` / `chargeback`, `reverses_txn_id` pointing at the payment). It then posts GL `stripe:rev:<id>` (Dr AR / Cr clearing) and commits, reopening the paid charges with exact-negative applications. The original payment always stays on the ledger.
  - Partial refunds, partial disputes and won disputes are flagged `needs_review`, never automatic.
  - A reversal that can't post (missing role or closed period) stays a draft and is flagged.
- *Autopay containment.* `/api/portal/autopay/begin` returns 503 and `chargeDue` is disabled. New enrollments store `tenure_id`, and the 469 trigger cancels an enrollment when its tenure ends at a sale. Production has 0 enrollments.
- *Sandbox / test-only.*
  - `payment_sandbox.js`: a narrow demo-guard exception for Stripe checkout and connected-account creation, for the single `payment_sandbox` lot, and only with a test key. Refunds and off-session charges stay blocked.
  - `payment_sandbox_provision.js` plus admin `POST /api/payments/test/payment-sandbox` (plan / apply / plan_remove / remove; test key only; one transaction; 29 fixed-id rows for Drama Creek lot DC-45-060; removal refuses while test activity exists).
- *Still NOT built.*
  - Payouts and bank reconciliation: nothing moves 1090 to operating cash (Dr 1000 / Cr 1090 on a Stripe payout), so 1090 would accumulate until this is built.
  - Stripe fee accounting: processing and dispute fees are not recorded.
  - No staff screen for payment settlement or posting state, the `needs_review` queue, or retry-posting (API only).
  - No retry path for a blocked reversal (manual).
  - Partial refund and dispute resolution, and re-crediting a won dispute, are manual.
  - Autopay charging stays off.
  - Homeowner receipt or notification on settle, fail or reverse is not reviewed in this branch.
  - The existing staff refund route (`POST /api/payments/:id/refund`) only reverses the transfer to the association if `reverse_transfer` is passed; its default was not changed or re-reviewed.

**Production config needed before deploying this code.**
1. *Stripe webhook (test mode, platform endpoint `/api/payments/webhook`)* must deliver: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`, plus `account.updated` from connected accounts. The current subscription list was not checked (no Stripe access used); Ed or ChatGPT should compare it read-only.
2. *Env vars.* Existing and unchanged: `STRIPE_SECRET_KEY` (must stay `sk_test_` for this phase), `STRIPE_WEBHOOK_SECRET`, `DATABASE_URL` (used by the sandbox route), `APP_BASE_URL`. Recommended new: a dedicated `PAYMENT_LINK_SECRET`. Without it, pay links are signed with `SUPABASE_KEY`, the same credential-reuse concern that was fixed for migration plans.
3. *Connected accounts.* None change for real communities. The sandbox needs a Drama Creek test connected account, created after provisioning through the existing test-only `POST /api/payments/connect/test-onboard`.
4. *Database.* No new migration: 469 is applied and verified. Sandbox data is created only by the separate provisioning route, on approval.
5. *Behaviour visible at deploy.*
   - Previously emailed pay links stop working; they must be re-sent.
   - Portal autopay setup shows "unavailable".
   - The old public create-checkout returns 410.

**Risks / open issues.**
- With destination charges, Stripe bills processing and dispute fees to the platform (Bedrock). The card convenience fee covers card processing, but nothing covers ACH or dispute fees. This is a policy question; confirm against the Stripe account settings.
- 1090 grows without payouts; don't go live beyond the sandbox until payout reconciliation exists.
- No UI for blocked or review payments; staff would need the API or Claude.
- The legacy amenity webhook path now returns 500 on a handler error (Stripe retries), where before an error could be swallowed.

**Decisions needed from Ed.**
1. After ChatGPT's review: approve merging `feat/payments-safe-foundation` to main (test mode only).
2. Set a dedicated `PAYMENT_LINK_SECRET` on Render before that merge (recommended).
3. Confirm the Stripe test webhook subscribes to the events above (read-only comparison first).
4. Approve sandbox provisioning and the Drama Creek test connected account as a separate step after the merge.
5. Policy: who bears Stripe ACH and dispute fees.

**Recommended next action.** ChatGPT reviews the branch and this entry. No merge, deploy or Stripe change until Ed approves item 1.

---

## 2026-09-27: Migration 469 COMPLETE (applied by Ed; verified read-only)

**Task.** Per the ChatGPT instruction in GitHub Issue #1: verify Ed's owner-panel apply of 469, read-only; no new production changes.

**Status.** 469 is applied, recorded and verified. **Complete.** Waiting for ChatGPT review before any next feature or deploy step.

**Apply.** Ed clicked Approve & Apply. Attempt `26b68552-1efe-4676-9129-b75f624a7201`. Applied 2026-09-27 17:30:51 UTC, 6.7 s. Applied by `egojara@bedrocktx.com`. Deployed commit recorded: `cdec7cda` (the deploy that carried 469; the file blob is identical to `33019547`).

**Production verification (read-only, service-role selects; 27/27 OK).**
- `schema_migrations`: exactly one row for `469_payments_safe_foundation.sql`. Clean (`error` NULL), `status` = applied, `sha256` = `5d10f2b4...3130` (approved), `checks_sha256` = `1d404af8...29fe` (approved), `applied_via` = owner_single_apply, `applied_by`, `commit_sha`, `applied_at`, `duration_ms` populated.
- Stored verification: 8/8 checks OK; 14/14 protected tables and views unchanged; row changes `chart_of_accounts` +6, `community_account_roles` +18, `stripe_events` net 0; schema objects exactly 97 added / 2 changed / 0 removed. Rows were written only in `chart_of_accounts` (6 inserts), `community_account_roles` (18 inserts) and `stripe_events` (the self-test's rolled-back writes, net 0).
- `migration_attempts`: the attempt row is finalized `applied` with the same hashes and `finished_at` set; it is the only attempt row. The post-commit API checks were recorded OK (roles 18, stripe_events 0).
- Accounts: exactly 6 rows numbered 1090, one each for Waterview Estates, Lakes of Pine Forest, Canyon Gate at Cinco Ranch, Eaglewood, Quail Ridge and Still Creek Ranch. All named "Cash in Transit - Stripe Clearing", active, postable, debit asset, in the same fund as that community's 1000.
- Roles: exactly 18 rows (6 communities x 3 roles). Each points at the expected account in its own community (operating_cash = 1000, stripe_clearing = 1090, homeowner_ar = 1300); all `updated_by` = migration 469.
- Nothing else created:
  - `stripe_events` = 0.
  - `payments` still 10 rows, none with the new identity or settlement fields set.
  - Homeowner ledger: no reversal rows, no reversal categories, no Stripe-sourced rows.
  - No journal entries with a `stripe:` reference, and no journal entries at all since the apply.
  - `assessment_autopay` = 0.
  - No lot flagged `payment_sandbox`.

**Owner panel.** Computed with the same rule the Migration status check uses: 0 of 473 migration files are pending, so 469 no longer appears. The banner should read "Every migration file is recorded as applied." Two files (227, 435) differ from their recorded hash; these are the documented historical exceptions in `migrations/LEDGER_NOTES.md`; the check skips them and never re-runs them. (Not visually confirmed in Ed's browser session.)

**Production changes in this step.** None (verification only). This handoff update is a docs-only commit.

**Risks / open issues.**
- Payment application code is still unmerged on `feat/payments-safe-foundation`, which carries an older merge of the tool; re-sync it with main before review.
- Payment posting is not live. Main's legacy payment path is unchanged; the new tables exist but nothing writes to them until the payment code merges.
- The 5 pre-existing test failures (Maggie roster, persona routing, signature logo, Amanda signature, `lib/presentations` require) remain open.

**Decisions needed from Ed.** None right now. Next: ChatGPT reviews this verification; then Ed decides on the payment-code merge (after a re-sync and review).

**Recommended next action.** ChatGPT reviews this entry. Then Claude re-syncs `feat/payments-safe-foundation` with main (dropping its now-duplicate copy of the tool and keeping 469 byte-identical) and presents the payment-code merge for review. No deploy until approved.

---

## 2026-09-27: Migration 469 landed on main as files only; NOT applied

**Task.** Per the ChatGPT instruction in GitHub Issue #1 (Ed confirmed `MIGRATION_PLAN_SECRET` is set on Render): bring only the 469 SQL file and its checks file onto main, verify hashes, run local checks, push, do not apply.

**Status.** Done. Waiting for Ed to review and apply 469 in the owner panel.

**Commit.** `33019547` on `main` (file-only). Deployed: production `/version` reports `33019547`, booted 2026-09-27 17:25:27 UTC.

**Exact files landed** (byte-for-byte from `feat/payments-safe-foundation`; nothing else):
- `migrations/469_payments_safe_foundation.sql`
- `migrations/checks/469_payments_safe_foundation.json`

**Hash verification** (source branch blob, staged blob, and `origin/main` blob all identical):
- SQL: `5d10f2b485080dd459c020e7cbcf02b97fc17ded38d05728959d9d2ff2653130`
- Checks: `1d404af88a6d5cd9f6c6f92e67cd87f23ce463ef8cbfbdea076862f09ac429fe`

**Checks / results** (all local; PGlite in-memory; no production writes):
- `check_migration_checks`: 1 migration from 469 on has a valid checks file and runs as one transaction.
- `check_migration_immutability`: pass (472 migrations unchanged; 27 pinned historical exceptions).
- `check_constraint_values`: pass.
- Tool rehearsal (`apply_one_rehearsal`): 57/57.
- 469 end-to-end through main's current tool, with the real checks file: 13/13 (plan ready with all 16 preflights passing, applied, +6 accounts / +18 roles / stripe_events net 0, 14 protected tables unchanged, 8 verifications, recorded with the approved hash; drift blocks the plan).
- 469 migration rehearsal: 56/56 migration assertions pass on main. It then stops at the Drama Creek sandbox-provisioning section because that needs `lib/payments/payment_sandbox_provision.js`, which is payment application code deliberately NOT on main (it passes 79/79 on the payments branch). The rehearsal test files were used temporarily and not committed.

**Production changes.** Code deploy containing only the two new files. No database change. Read-only checks after deploy:
- `schema_migrations` has 0 rows for 469.
- `stripe_events`, `community_account_roles`, `migration_attempts`: absent.
- `payments.payment_group_id`: absent. 1090 accounts: 0.
- **469 is NOT applied.** No Stripe change.

**Risks / open issues.**
- `MIGRATION_PLAN_SECRET` is reported set but not yet proven; the Review step proves it (it refuses with "MIGRATION_PLAN_SECRET is not set" otherwise).
- First real use of the owner panel. If the Review screen shows BLOCKED, do not work around it; send the reason.
- Payment application code remains unmerged on `feat/payments-safe-foundation` (still carries the older tool merge; re-sync before merging).

**Decisions needed from Ed.** Review 469 in the panel and decide whether to click Approve & Apply.

**Exact next action for Ed.**
1. Open trustEd (my.bedrocktxai.com), signed in as the owner.
2. Go to **Documents**, then click **Migration status**.
3. In the yellow banner, click **Review 469**.
4. Confirm the screen shows: status **READY**; SHA-256 `5d10f2b485080dd459c020e7cbcf02b97fc17ded38d05728959d9d2ff2653130`; checks file `1d404af88a6d5cd9f6c6f92e67cd87f23ce463ef8cbfbdea076862f09ac429fe`; deployed commit `33019547...`; data rows `chart_of_accounts +6`, `community_account_roles +18`, `stripe_events 0`; all preflight checks green; the one-time tracker setup notice.
5. If all of that matches, click **Approve & Apply** once, and wait for the result box (APPLIED or NOT APPLIED).
6. Tell Claude the result. Claude then verifies read-only (tracker row, attempt log, 6 accounts, 18 roles) and updates this file.

---

## 2026-09-27: GitHub Issue #1 check

Claude saw the GitHub comment from ChatGPT.

---

## 2026-09-27 (later): Tool merged to main; waiting on MIGRATION_PLAN_SECRET

**Task.** Ed approved merging `feat/single-migration-apply` to main. Then: set `MIGRATION_PLAN_SECRET` on Render (Ed), prepare the 469 file-only main commit, stop before applying 469.

**Status.** Merged and pushed. Waiting for Ed to set `MIGRATION_PLAN_SECRET` on Render. 469 is NOT on main yet and NOT applied.

**Branch.** `main`. Merge commit `a3aa3473` (merges `feat/single-migration-apply` at `236e056e`).

**Latest commit.** This handoff update is the commit after `a3aa3473`.

**Material files changed.** Same as the entry below: `lib/migrations/apply_one.js`, `server.js` (3 owner-only routes), `public/index.html` (Review / Approve & Apply panel), `scripts/check_migration_checks.js`, `scripts/check_migration_immutability.js`, `migrations/LEDGER_NOTES.md`, `tests/sql/apply_one_rehearsal.mjs`, `scripts/run_all_tests.js`, `.gitignore`, this file. No `.sql` file.

**Tests / results.** On the merged tree: tool rehearsal 57/57; migration-checks and immutability checks pass; `server.js` syntax OK. Full-suite result from the branch still stands (117/122; the 5 failures predate this work; `test_community_boundary` not run).

**Migrations involved.** None applied. Next: 469 (`5d10f2b485080dd459c020e7cbcf02b97fc17ded38d05728959d9d2ff2653130`) plus `migrations/checks/469_payments_safe_foundation.json` (`1d404af88a6d5cd9f6c6f92e67cd87f23ce463ef8cbfbdea076862f09ac429fe`), as a file-only commit on main once the secret is confirmed.

**Production changes.** Code deploy of the tool (new owner-only routes and panel). No database change: the review step is read-only, and the tracker bootstrap runs only inside an approved apply. Without `MIGRATION_PLAN_SECRET`, review and apply refuse.

**Risks / open issues.**
- Until 469 is on main, there is no pending file to review, so the secret can only be proven by the "Review 469" step after the file-only commit.
- Owner panel not yet exercised in a browser; the first real use is Review 469.
- `feat/payments-safe-foundation` still carries the older tool merge; re-sync before that branch merges.
- The 5 pre-existing test failures (Maggie roster, persona routing, signature logo, Amanda signature, `lib/presentations` require) are unrelated but open.

**Decisions needed from Ed.**
1. Set `MIGRATION_PLAN_SECRET` on Render and say "set" (never paste the value into chat).
2. Then approve the 469 file-only commit to main (SQL file plus checks file; no payment code).
3. Then review 469 in the panel and click Approve & Apply.

**Recommended next action.** Ed sets the secret. Claude lands the 469 file-only commit, waits for the deploy, and confirms the panel shows "Review 469". Ed reviews and clicks Approve & Apply. Claude verifies read-only and reports.

---

## 2026-09-27: Single-migration apply tool

**Task.** Replace manual SQL-editor migrations with an owner-approved, single-file apply that records itself correctly. Final review items from ChatGPT: (1) dedicated plan-signing secret, (2) precise atomicity wording, (3) this handoff file.

**Status.** Implementation complete and tested on a branch. Not merged. No production migration applied. Awaiting Ed's review and ChatGPT's GitHub review.

**Branch.** `feat/single-migration-apply` (based on `origin/main` f783beeb; includes the migration immutability check from `chore/migration-immutability`).

**Latest commit.** `8c4494fc` (code). This handoff file is the commit after it.

**Material files changed.**
- `lib/migrations/apply_one.js`: plan (read-only) and apply. Plan token bound to file SHA-256, checks-file SHA-256, deployed commit and owner; 30 minutes; single use; signed only with `MIGRATION_PLAN_SECRET`.
- `server.js`: owner-only `POST /api/admin/migrations/plan`, `POST /api/admin/migrations/apply`, `GET /api/admin/migrations/attempts/:id`. No bulk, list-apply or acknowledge route.
- `public/index.html`: Documents > Migration status > Review shows filename, SHA-256, checks hash, deployed commit, expected changes, protected tables and check results, then one "Approve & Apply" button.
- `scripts/check_migration_checks.js`: build fails if any migration numbered 469 or higher has no valid checks file, or cannot run as one transaction.
- `scripts/check_migration_immutability.js`, `migrations/LEDGER_NOTES.md`: applied migration files cannot change (27 documented historical exceptions).
- `tests/sql/apply_one_rehearsal.mjs`, `scripts/run_all_tests.js`.

**Atomicity (precise).** The migration changes and the successful `schema_migrations` record are atomic: they commit together or not at all. The one-time tracker bootstrap (provenance columns on `schema_migrations`, plus the append-only `migration_attempts` log) runs in its own transaction and commits first. It is bookkeeping only, idempotent, and runs only inside an approved apply, never on a status check. `migration_attempts` rows never mean "applied".

**Tests / results.**
- Tool rehearsal (PGlite): 57/57. Covers the lint, checks-file validation, plan read-only, token tamper/expiry/user/commit/replay, hash bound, SQL error rolls back with no record, verification failures roll back (wrong check, undeclared object, undeclared table write, protected-table change, wrong row delta, missing object), dependency and preflight blocks, old error rows, append-only log, stale attempts, secret rules, and bootstrap-vs-atomic behaviour.
- Full suite (`scripts/run_all_tests.js` list, PGlite enabled): 117/122 pass, 1 not run.
  - Not run: `tests/test_community_boundary.js`, because it inserts and deletes a temporary demo community in production. It runs on Ed's OK.
  - 5 failures, all identical on a clean `origin/main`, so they predate this branch: `test_bedrock_ops` ("Maggie" roster, 2 cases), `test_persona_routing` (a `*_MAILBOX` persona lacks a routing rule), `test_signature_identity` (inline logo for every signer), `test_amanda_review` (signature pinned to Amanda), `check_requires_tracked` (`tests/test_proposal_boundary.js` requires `../lib/presentations`, which has no `index.js`).
  - Note: `test_character_registry` deliberately attempts writes on production that the database is expected to refuse; it passed.
- Sabotage checks: disabling verification rollback, and removing the hash binding, both fail the rehearsal.

**Migrations involved.**
- None applied. The tool adds no migration file; its tracker bookkeeping is created by its own bootstrap, so 469 stays first in numeric order.
- 469 (`469_payments_safe_foundation.sql`, SHA-256 `5d10f2b485080dd459c020e7cbcf02b97fc17ded38d05728959d9d2ff2653130`) lives on `feat/payments-safe-foundation` with its checks file (`migrations/checks/469_payments_safe_foundation.json`, SHA-256 `1d404af88a6d5cd9f6c6f92e67cd87f23ce463ef8cbfbdea076862f09ac429fe`) and an end-to-end test through the tool (13/13).

**Production changes.** None. No merge, no deploy, no database change, no Stripe change.

**Risks / open issues.**
- `MIGRATION_PLAN_SECRET` is not set on Render yet. Until it is, plan and apply refuse (by design).
- The owner panel has not been exercised in a browser. Previewing it means starting the full production server locally.
- A few 469 preflight checks read Postgres system catalogs that cannot be reached from the laptop. They run live at plan time and block the button if they fail.
- The `DATABASE_URL` connection mode (direct vs pooler) is unconfirmed. The plan step displays it; both work with this design.
- The four PGlite rehearsals skip in `npm test` unless `@electric-sql/pglite` is installed as a dev dependency.
- `feat/payments-safe-foundation` carries an older merge of this tool (before the secret and wording changes). Re-sync it before that branch merges.

**Decisions needed from Ed.**
1. Approve merging `feat/single-migration-apply` to main.
2. Set `MIGRATION_PLAN_SECRET` on Render yourself (at least 32 random characters; for example, the output of `openssl rand -hex 32`). The AI engineers never see it.
3. Approve landing 469 on main as a file-only commit (the `.sql` file and its checks file, no payment code). This can be the same deploy as item 1.
4. Optional: allow adding `@electric-sql/pglite` as a dev dependency so the rehearsals run in `npm test`.
5. Optional: OK running `test_community_boundary` (it creates and deletes a demo community in production).

**Recommended next action.** ChatGPT reviews `feat/single-migration-apply` on GitHub. Then Ed approves items 1 to 3. Claude merges and waits for the deploy. Ed opens Documents > Migration status > Review 469, checks the displayed hash and changes, and clicks Approve & Apply himself (his signed-in owner click plus the plan token is the approval). Claude then verifies read-only and reports the tracker row, attempt log and API checks.
