# Conversion primitives (migrations 535 + 536)

Reusable onboarding-engine capabilities. They are source-agnostic and community-agnostic. Every community fact enters as batch **data**: source reports, approved adjustments and policies, and owner decisions. No community fact enters as code. `scripts/check_onboarding_community_agnostic.js` (in `npm test`) fails the build on:
- a UUID literal anywhere in `lib/onboarding/**`;
- a community name or batch code in executable code there.

## 1. Three separate concepts, one approval / audit trail

| Concept | Table | What it is | Acts when |
|---|---|---|---|
| Adjustment | `conversion_adjustments` | A balanced accounting transformation of the source position: lines (account, debit-positive cents), reason, evidence (a source report or evidence document of the batch, plus a locator). Effect `opening` rides in the opening entry and may never flip a sign. Effect `post_opening` is its own entry at the cutoff; a declared `allow_sign_change` is allowed only here. | approved |
| Policy | `conversion_policies` | An approved non-journal instruction, one of: `cutoff_authority`, `legacy_owner_routing` (default `control_accounts`), `suspense_treatment`, `timing_treatment`, `preserve_source_coding`, `carried_balance` (an exact, source-supported balance the conversion carries as a reconciling item; it explains a preflight control's difference so the control PASSES citing the policy; a partial or unsupported one explains nothing). | approved |
| Exception | `conversion_exceptions` (452, extended) | A bridge item a rule or policy resolved beyond identifiers / provenance, or a question still open for the owner. It records the evidence, classification, resolution, confidence and proposed resolution. | recorded per bridge result |

`conversion_object_events` (append-only) records `proposed / approved / rejected / superseded / recorded` for all three, with actor kind, actor id, label, channel and fingerprint.

## 2. Data model and record ownership

| Table | Migration | Record ownership |
|---|---|---|
| conversion_adjustments, conversion_policies, conversion_object_events | 535 | association_record |
| conversion_exceptions (new columns; status `auto_resolved`) | 535 | workpaper (unchanged from 452) |
| onboarding_source_fact_sets, onboarding_source_facts | 535 | workpaper: the normalized working copy; the source documents are the association's |
| conversion_source_identities | 536 | association_record |
| conversion_adjustment_applications | 536 | association_record |
| ownership_tenures.origin `conversion`; reconciling kind `suspense_balance` | 536 | unchanged |

## 3. How it plugs into the stage machine

No new stages and no new transitions; `lib/onboarding/stages.js` is unchanged.

- **normalize.** The adapter parses (provider-specific). `source_period.sliceToCutoff` then slices any history that runs past the cutoff (canonical rows; every account must roll forward exactly). The facts are persisted and sealed (`onboarding_open_fact_set` / `append_source_facts` / `seal_fact_set`). The PASS result names the sealed set; the database refuses a normalize PASS without one.
- **Every later stage** reads the facts (`service.loadSource`, re-hashed on read), never the documents.
- **source_controls.** `conversion_objects.resolveControls`: an approved adjustment that moves the control's GL account by exactly the difference makes the control PASS. It cites the adjustment and keeps the source amounts. A partial or plug move resolves nothing. No waiver is involved.
- **snapshot.** Approved `opening` adjustments, plus separate legacy accounts only when that policy is approved.
- **activity_bridge.** The new rules:
  - corroborated one-to-one matches;
  - duplicate candidates;
  - timing by the approved policy.
  Each item carries `evidence.resolution`. Exceptions are recorded.
- **preflight.** The plan is built with:
  - post-opening adjustment entries;
  - the adjustment chain;
  - legacy-owner records;
  - initial ownership;
  - suspense items.
  New controls: `adjustments_applied_as_approved`, `preserved_source_coding_untouched`, `legacy_owner_isolation`, `establishments_identity_safe`, `suspense_balances_labelled`, `source_period_approved`, `conversion_objects_current`, `execute_supports_plan`. The plan binds the approved-objects digest.
- **Staleness.** Each stage result records the digest of the approved objects it used. A changed approved set makes the current stage's result stale, and the operator recomputes it in its own stage. Execute refuses a preflight whose digest is not current.

## 4. What the database enforces vs what the application enforces

| Guarantee | Enforced by | Where |
|---|---|---|
| Adjustment / policy content immutable after proposal; fingerprint computed by the database over the content | DB | trigger `conversion_*_guard`, `conversion_sha256_jsonb` |
| Created `proposed`; status changes only through `conversion_decide_object` / a superseding proposal; approved → superseded only; approval fields permanent | DB | guards + `onboarding.object_writer` flag |
| Approve / reject only with actor_kind `human`, channel `in_app`, the current fingerprint, before EXECUTE | DB | `conversion_decide_object`, CHECK on events |
| One live adjustment number / policy (kind + key) per batch; a suspense policy never allocates to owners | DB | partial unique indexes, guard |
| Events, facts, bridge exceptions, identities, audit chain are append-only | DB | triggers |
| A normalize PASS carries a sealed fact set (count, contiguous seq), bound once | DB | `onboarding_stage_events_fact_set_gate` / `_bind` |
| The facts' sha256 matches the sealed fingerprint | **App** | `source_facts.verifyFacts` on every read |
| At EXECUTE: approved-objects digest = the preflight's; each applied adjustment approved with that fingerprint; old-format preflight refused when approved objects exist; planned identities absent; prior-owner rows only on legacy records; current-owner rows only on their lot's current owner tenure; write counts | DB | `onboarding_execute` (536) |
| A conversion creates only a legacy record (no lot) or a lot's FIRST owner tenure | DB | `ownership_tenures_transfer_only` (536) + transaction-local flag set only inside `onboarding_execute` |
| A source account is established at most once per community | DB | UNIQUE `uq_conversion_source_identity` |
| The `human` actor is the signed-in OWNER; the actor comes from the session, never the request body | **App** | `api/onboarding.js` (`requireOwner`), `service.decideObject` |
| The approval came from the app UI | **App** (tag only) | the API route sets `channel: 'in_app'`; the database cannot tell the app from any other holder of the service key |
| A plan needing 536 writes is refused while 536 is missing | **App** | `service.executeSupportsPlan` (probe `onboarding_execute_capabilities`) |
| Stage results are recomputed when the approved set changes | **App** | `service.operate` / staleness reasons |

## 5. Migration order and compatibility

**Apply order:** 528, then 529, then 535, then 536 (numeric).
- 536 requires 535: the checks file names it and the migration's own DO block refuses without it.
- 528, 529 and 535 / 536 are independent; any relative order is safe.
  - 529 permits everything EXECUTE writes: it inserts headers and then lines, and supersedes with `superseded_by_conversion`.
  - 528 refuses EXECUTE for a community whose books are closed (not `trusted`, financials off, archived / terminated / prospect). EXECUTE then rolls back and records a failed attempt.

| Code | 535 | 536 | Behavior |
|---|---|---|---|
| this PR | no | no | New conversions stop at normalize: "needs 535_conversion_primitives.sql". Existing batches: post-proof unaffected. Approving / executing an old-format preflight still works; no objects can exist, so the set is empty. A plan with 536 writes is refused. |
| this PR | yes | no | Stages run on persisted facts; objects can be proposed / approved. A preflight with adjustment entries, legacy records or initial ownership is BLOCKED (`preflight.execute_supports_plan`), and execute answers 503. A plan without them executes on the 501 body; the objects digest is then checked by the service only. |
| this PR | yes | yes | Full behavior (sections 3-4). |
| this PR | no | yes | Impossible: 536 refuses to apply without 535. |
| main (before this PR) | yes | either | The database refuses main's normalize PASS (no fact set): new onboarding stops with "deploy the code that records them". Nothing else in main touches the new tables. With 536, an old-format plan executes as before unless approved objects exist (refused). |
| any | any | any, with 528 / 529 in any combination | As above; 528 / 529 only add refusals that make EXECUTE roll back. |

**Failure and rollback**
- **535 apply.** One transaction through the Approve & Apply tool, with preflight, object and protected-table checks. Any failure applies nothing. Rollback after commit (only before first use) means dropping the new tables, functions, triggers and columns. Additive: no existing row changes.
- **536 apply.** One transaction. Rollback means re-applying the `onboarding_execute` definition from 501 and `ownership_tenures_transfer_only` from 459, then dropping the two new tables (if unused).
- **EXECUTE.** One transaction, unchanged. Any failed guard or statement rolls back every write. The attempt is recorded as `failed` in a separate transaction, and a retry re-runs the same writes. A committed execution is returned on retry, never repeated.

## 6. Tests

- `tests/test_onboarding_conversion_primitives.js`: slicing, facts, validation, resolved controls, digest, audit chain, bridge rules, fail-closed service, the 536 guard.
- `tests/sql/535_conversion_primitives_e2e.mjs`: 535 + 536 through the apply tool on the real SQL. Covers:
  - facts;
  - fingerprints and approvals;
  - refusals;
  - EXECUTE with a sign-changing post-opening adjustment, legacy records, initial ownership and suspense;
  - the portal-path isolation (`v_current_owner_ledger` / `v_current_owner_balance`);
  - idempotency (retry, unique identity, the tenure guard).
- The existing onboarding rehearsals run with 535 in their test databases where the service drives stages.
