# AI Handoff

Shared state between Ed and the AI engineers (Claude, ChatGPT). Update before ending any task. Newest entry first. Keep it decision-oriented.

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
