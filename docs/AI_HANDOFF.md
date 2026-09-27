# AI Handoff

Shared state between Ed and the AI engineers (Claude, ChatGPT). Update before ending any task. Newest entry first. Keep it decision-oriented.

---

## 2026-09-27 (latest): Migration 469 COMPLETE (applied by Ed; verified read-only)

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
