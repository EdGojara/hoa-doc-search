# Trusted Onboarding Engine: architecture (Issue #15, milestone 1)

A reusable, system-agnostic pipeline for bringing a community from any legacy system into Trusted. Quail Ridge (Vantaca, 7/31/2026) is the first proving fixture. This is not a Vantaca importer.

```
legacy source → immutable intake → normalized staging → source controls → conversion snapshot
              → activity bridge → preflight approval → atomic/idempotent execution → post-conversion proof
```

The source system's validated closing position at the approved cutoff is the authority. Existing Trusted balances are **not** a target to force-match. Existing Trusted transactions are examined separately, and only for duplicate/overlapping real-world activity and legitimate subsequent activity.

## Milestone 1 scope (this branch)

| # | Deliverable | Where |
|---|---|---|
| 1 | Architecture + schema proposal | this file; `migrations/481_onboarding_engine.sql` (**proposal, not applied**) + `migrations/checks/481_onboarding_engine.json` |
| 2 | Canonical staging models | `lib/onboarding/canonical.js` |
| 3 | Source artifact / provenance model | `lib/onboarding/artifacts.js`; `onboarding_artifacts` (481) |
| 4 | Control / assertion framework | `lib/onboarding/controls.js`, `lib/onboarding/source_controls.js` |
| 5 | Staged state machine + hard write gates | `lib/onboarding/stages.js`, `lib/onboarding/write_gate.js`; DB guard trigger (481) |
| 6 | Provider adapter interface | `lib/onboarding/adapters/index.js` |
| 7 | Read-only Vantaca adapter reproducing Quail Ridge controls | `lib/onboarding/adapters/vantaca/` |
| 8 | Regression test for the dropped-row defect | `tests/test_onboarding_engine.js` (synthetic) + `tests/onboarding_quail_ridge_local.js` (real package, local only) |
| 9 | Preflight report format | `lib/onboarding/preflight.js` (`trusted.onboarding.preflight/v1`) |
| 10 | Tests proving an agent/stage cannot mutate production or advance itself | `tests/test_onboarding_engine.js`, `tests/sql/481_apply_one_e2e.mjs` |

Stage runners exist for stages 0–2 only (`lib/onboarding/engine.js`). Snapshot, activity bridge, preflight-with-writes, execute and post-proof are later milestones, each separately approved.

## Stages

| Stage | Name | What it does | Writes production? |
|---|---|---|---|
| 0 | `intake` | Register originals (and derived text) with sha256, bytes, provider, report type, period/cutoff, community, batch, supplier, provenance. Frozen. | No |
| 1 | `normalize` | Provider adapter → canonical rows, each with provenance. Extraction controls: parsed rows vs the report's **own printed totals**. | No |
| 2 | `source_controls` | Source vs its own authoritative controls. No plugs; explicit tolerances only. | No |
| 3 | `snapshot` | Proposed Trusted opening position at cutoff (not a history replay). Homeowner AR/prepaids keep subledger detail that supports the GL. | No |
| 4 | `activity_bridge` | Real Trusted activity vs source/post-cutoff: duplicate → no second posting; legitimate subsequent → preserve; ambiguous → review. | No |
| 5 | `preflight` | One report with everything a human approves (below). STOP. | No |
| 6 | `execute` | Atomic, idempotent, provenance on every record. | **Only here**, only with approval |
| 7 | `post_proof` | Read-only: validated source closing position + preserved/subsequent activity = Trusted position. | No |

## Guardrail: one bounded stage at a time

Enforced twice: in application code (`stages.js`, `write_gate.js`) and in the database (481).

- **Agent scope.** An agent is assigned **one** stage. It may perform only that stage's permitted actions, and only while the batch is in it. Completing a stage records the result; it never moves the batch.
- **Human transitions.** Every transition is made by a **human**, one step forward, never skipping. A stage that is FAIL/BLOCKED cannot advance unless a human waives each non-passing control by code, with a reason. Waivers are recorded.
- **Execute gate.** Entering `execute` requires a human approval bound to the **exact preflight sha256**, with every control PASS or waived. An agent can never execute.
- **Read-only before execute.** Every stage before `execute` gets a read-only DB client. `insert` / `update` / `upsert` / `delete`, every `rpc`, and every storage mutation throw before any request is sent. `writeClientFor()` returns a writable client only in `execute`, with the write lock open and the approval matching the preflight being executed.
- **Static check.** A test scans `lib/onboarding/**`. No module imports a DB client or posting module, and none calls a DB mutator (only the gate names them).
- **Database enforcement (481):**
  - artifacts and stage events are append-only;
  - advances, waivers and approvals must be `actor_kind = 'human'`;
  - waivers need a reason and approvals need the hash;
  - the batch guard trigger allows only one step forward, with a matching human advance event, and `execute` only with an approved hash;
  - the write lock may open only in `execute` and re-locks on leaving it.
- **Discovery is permission to report, not to fix.** A control surfacing a problem is a result, never a trigger for a correction.

## Canonical model (`canonical.js`)

Domains:
- **General ledger:** `gl_account`, `gl_account_balance`, `gl_transaction`.
- **Statements:** `statement_line` (printed lines, used as controls).
- **Homeowner subledger:** `property`, `owner`, `ownership_period`, `homeowner_account`, `homeowner_txn`, `ar_aging_account`, `ar_aging_item`, `prepaid_credit`.
- **Payables, cash and other:** `ap_open_item`, `bank_balance`, `vendor`, `assessment_schedule`.

Rules for every row:
- integer cents and ISO dates;
- **mandatory provenance**: artifact sha256, locator (page/line/row) and the raw source text.

Core logic never branches on provider.

## Controls (`controls.js`, `source_controls.js`)

Every control returns `PASS` / `FAIL` / `BLOCKED` (missing input), with a level:
- **extraction**: parsed rows vs the report's own printed totals. A FAIL here is an adapter defect, never evidence the books are wrong;
- **source**;
- **cross_source**.

There is no plug function. The only knob is a declared tolerance, which needs a reason and is recorded.

Provider-agnostic source controls:
- GL debits = credits;
- beginning and ending trial balances net to zero;
- Balance Sheet A = L + E;
- homeowner debit balances = GL AR;
- AR aging = GL AR;
- aging = ledger by account;
- homeowner credits = GL prepaid;
- human-supplied authoritative totals.

Account roles (`ar_account`, `prepaid_account`, …) come from batch configuration, never a hard-coded chart.

## Provider adapters (`adapters/index.js`)

Contract: `provider`, `version`, `artifact_types`, `parse(type, input, artifact, opts)`, `extractionControls(parsed)`, plus optional `mechanicsControls(parsed, opts)`.
- Adapters are **pure**: they receive bytes/text, never a DB client.
- Provider presentation rules live in the adapter. Vantaca's: the Balance Sheet shows 3000 as the GL carried balance plus the current-period P&L result.
- Future adapters (CINC, C3, TOPS, AppFolio, QuickBooks, spreadsheets, unknown exports) implement the same contract.

**Vantaca adapter** (`pdftotext -layout` text of the original PDFs) supports:
- GL Trial Balance;
- Balance Sheet;
- AR Aging;
- Homeowner Transaction History;
- a normalized GL CSV derivative. A CSV is never trusted alone: it must add to the original GL's printed per-account totals.

Unreadable data lines are recorded as defects, never dropped. Amounts parse strictly (`.38` is 38 cents; anything unreadable throws).

## Quail Ridge proof (real package, read-only, local)

`tests/onboarding_quail_ridge_local.js` runs only where `Quail_Ridge_Claude_Migration_Package.zip` exists. The repo is public, so client data is never committed. Result: **36/36**.
- **Stage 0:** 8 artifacts (4 original PDFs plus their extracted text); every hash equals the package manifest.
- **Stage 1:** every line read (1,162 GL lines). Every extraction control passes: GL roll-forward and per-account tie, aging items and printed buckets, ledger day-end balances, Balance Sheet sections.
- **Regression:** the package's own `gl_transactions.csv` **FAILS** against the original GL (accounts 1000, 1100, 1300, 2300, 4100).
- **Stage 2:** every authoritative control from the issue passes:
  - GL debits = credits = 139,282.37;
  - AR 19,767.91; cash 41,706.66; savings 3,011.99;
  - assets 57,608.18; liabilities 9,713.60; equity 47,894.58; L+E 57,608.18.
- **Ties:** every Balance Sheet line = GL, with 3000 = 46,173.71 carried + 6,018.33 current-period result = 52,192.04. Homeowner debit balances = aging = GL AR, account by account.
- **Prepaid gap (FAIL, surfaced, not plugged):** homeowner credits 184.60 vs GL 2400 922.13 (−737.53). The stage therefore cannot advance without a human waiver, and the agent cannot advance it at all.

## Preflight report (`preflight.js`)

Format `trusted.onboarding.preflight/v1`. Canonical JSON (sorted keys) with a sha256 over the content; approval binds to that hash, and any edit breaks verification.

Sections:
- `batch`, `source_cutoff`, `artifacts` (hashes), `normalization`;
- `controls`, `status` (overall + per-domain GL/AR/AP/cash/ownership);
- `collisions`, `automatic_matches`, `human_exceptions`, `unexplained_differences`;
- `proposed_writes`, `rollback`, `idempotency`.

`renderMarkdown()` produces the human-readable copy.

## Schema proposal (481, not applied)

Extends 452 (no parallel silo):
- `onboarding_artifacts`;
- `onboarding_stage_events`;
- on `conversion_batches`: `onboarding_stage` (NULL = legacy batch such as CONV-LPF-20260731, untouched), `write_locked` and `approved_preflight_sha256`, with the guard trigger;
- on `conversion_staged_rows`: `artifact_id`, `canonical_domain`, `source_locator`, `raw_source`;
- widened `conversion_runs.run_kind`;
- on `conversion_control_results`: `level` and a declared tolerance (a reason is required).

No rows change. The rehearsal `tests/sql/481_apply_one_e2e.mjs` passes 20/20 on Postgres 17 through the same apply tool Ed uses.

## Not in this milestone

- persistence wiring (stage runners write nothing);
- UI/API surface for stage, permitted actions, controls and write lock;
- snapshot builder, activity bridge, execute, post-proof;
- non-Vantaca adapters;
- AP, cash/bank and owner/contact roster adapters.

For Quail Ridge specifically, three things are still blocked on sources:
- the former-owner credit report (for the 737.53);
- the 7/31 AP aging;
- the roster/contact exports.
