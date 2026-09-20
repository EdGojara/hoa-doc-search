# ACC Async Clarification / Resume — DESIGN PROPOSAL (design only)

Status: **design + proposed migration (`migrations/434_acc_async_clarification.sql`)
— NOT applied; Ed applies migrations manually. No runtime change.** Ed/ChatGPT
2026-09-19, refined after review. Answers "what happens when Miranda can't finish
something immediately?" — the step from a trustworthy single decision to a
trustworthy piece of work that spans hours or days. No model / ACC reasoning /
verifier / autonomy / ASSIST change is part of this.

Guiding principle (GPT): **a normal resolvable conflict is Miranda's work, not an
Ed exception. Time passing must not, by itself, turn work into Ed's problem** —
Miranda owns reasonable follow-up; only genuinely unresolvable work escalates.

Ownership is FIRST-CLASS and the deepest idea here (it generalizes far beyond ACC —
violation disputes, accounting exceptions, vendor questions, board requests,
collections): **AI-owned work stays AI-owned through waiting, reminders, and
ordinary clarification. Human ownership begins ONLY at a genuine exception, and
once it transfers to a human, automation cannot silently reclaim it** — a return
to Miranda is an EXPLICIT transition (`ESCALATED → RETURNED_TO_AI → PENDING`),
never an inbound email quietly restarting her.

## Reuse first (what already exists — do NOT rebuild)

| Need | Reuse | Path |
|---|---|---|
| Case identity + "we're waiting" state | `acc_decisions.status='awaiting_info'` (+ `source_email_refs`, `conversation_id`, `correspondent_emails`) | migrations 326/351 |
| Match an inbound reply back to its case | `findOpenAccApplication()` (thread/reference/email/address scoring) | `lib/acc/match_open_application.js` |
| Inbound email persisted, exactly-once | `email_messages` (`graph_id`/`internet_message_id`/`conversation_id`; unique on `graph_id`) | migration 261, `lib/email/graph_ingest.js` |
| Send the clarification (threaded) + kill switch | `outbound_email_drafts` + `graph_send.sendReplyAs` + `autoSendEnabled()` | migrations 327/395, `lib/email/graph_send.js` |
| "Waiting-for-response with a follow-up deadline" unit of work + reminders | `work_items` (`status='waiting'`, `sla_due_at`, `source_type='acc'`) + `lib/scheduler.js` + `cron_runs` | migrations 256/059 |
| Immutable finalized letter | `finalized_record_archive` (append-only, hashed) | migration 311, `lib/record_archive.js` |
| Idempotency idiom | partial UNIQUE on a natural source key; treat PG `23505` as "already processed" | repo-wide (261/286/327) |

**Genuinely missing → the only things a migration must add:** durable persistence
of (1) the versioned `EvidencePackage` and (2) the clarification lifecycle. The
async workflow hangs off `acc_decisions` by FK; it does NOT create a parallel case
system.

## Smallest state model that fits

The CASE already has `awaiting_info` — it does not need new states. Only the
CLARIFICATION needs a lifecycle. The smallest set that fits:

```
PENDING ──send──▶ AWAITING_RESPONSE ──answer resolves──▶ RESOLVED ──▶ (resume)
                       │  ▲                                   
              follow-up│  │(reminder; Miranda's own)          
                       ▼  │                                   
                  AWAITING_RESPONSE                            
                       │                                       
     answer doesn't resolve & re-ask budget left ─▶ PENDING (clarification round 2)
                       │                                       
   no response after N follow-ups  OR  re-ask budget exhausted ─▶ ESCALATED (human)
```

Terminal: `RESOLVED`, `CANCELLED` (case withdrawn/superseded). `ESCALATED` is
terminal FOR MIRANDA — ownership has transferred to a human. A human may hand it
back explicitly:

```
ESCALATED ──human decides──▶ RETURNED_TO_AI ──▶ PENDING (owner_type flips AI, new round)
```

**Ownership travels with status:** `owner_type='AI'` for PENDING / AWAITING_RESPONSE
/ RESOLVED; it flips to `'HUMAN'` exactly at `ESCALATED`; it flips back to `'AI'`
only through the explicit `RETURNED_TO_AI` transition. A late homeowner reply after
`ESCALATED` is NEVER a silent resume (see below).

**Late response after ESCALATED (decided):** attach the answer as new evidence on
the case and alert/flag the human owner; do NOT auto-resume. Once Trusted has
escalated, the human may already have acted — silently restarting Miranda would put
two actors on the same matter. The human chooses whether to `RETURNED_TO_AI`.

**Why this is smaller than the sketched states, and still complete:**
- `WAITING_FOR_RESPONSE` = `AWAITING_RESPONSE` (SENT already implies waiting).
- `RESPONSE_RECEIVED` is a transient *processing step*, not a durable state — we
  either resolve or re-ask in the same transaction.
- `RESUMED` is an *action* fired on entering `RESOLVED`, not a state.
- `NO_RESPONSE → FOLLOW_UP → TIMEOUT` are a **counter + timer inside
  AWAITING_RESPONSE** (`follow_up_count`, `follow_up_due_at`), then a single edge
  to `ESCALATED`. Follow-ups are Miranda's; escalation is the last resort.
- `STILL_CONFLICTING → CLARIFICATION_2` is the **re-ask counter** (`round`): the
  answer is recorded as evidence and the conflict re-evaluated; if still open and
  budget remains, a new round; else `ESCALATED`.

## Persistence schema — written as `migrations/434_acc_async_clarification.sql` (proposed, not applied)

**Three** tables (the events log is now first-class, not optional — an autonomy
audit needs "how we got here", not just "what is true now"). All hang off
`acc_decisions` by FK; `record_ownership` declared; append-only tables enforce
immutability at the GRANT level (INSERT/SELECT only). Ownership is typed
(`owner_type` AI|HUMAN + `owner_agent_key` + `owner_user_id` FK, with a CHECK) and
generalizable beyond ACC.

**`acc_evidence_packages`** — durable, append-only versions (`workpaper`). Never
UPDATE a row; a new version is a new row.
```
id uuid pk
acc_decision_id  fk -> acc_decisions(id)  not null
version          int not null                       -- 1,2,3...
content_hash     text not null                      -- integrity; both models saw this
readiness        text not null                      -- READY|INCOMPLETE|EXTRACTION_FAILED|CONFLICT
manifest         jsonb not null                     -- artifact states
conflicts        jsonb not null default '[]'
bundle_text      text not null                      -- the frozen bytes reasoned on
assembled_at     timestamptz not null
record_ownership text not null default 'workpaper'
created_at ...
UNIQUE (acc_decision_id, version)                   -- exactly-one per version
```

**`acc_clarifications`** — the lifecycle (`mixed`: the question sent + answer are
association correspondence; the workflow record is Bedrock's).
```
id uuid pk
acc_decision_id      fk -> acc_decisions(id) not null
raised_from_version  int not null            -- evidence-package version that raised it
conflict_id          text not null           -- from the conflict object
topic                text
question             text not null           -- the deterministic clarification
status               text not null default 'PENDING'
                     -- PENDING|AWAITING_RESPONSE|RESOLVED|ESCALATED|CANCELLED
round                int not null default 1  -- re-ask counter
outbound_draft_id    fk -> outbound_email_drafts(id)
conversation_id      text                    -- thread the ask went out on
sent_at              timestamptz
follow_up_count      int not null default 0
follow_up_due_at     timestamptz             -- next reminder / timeout tick
last_nudged_at       timestamptz
answer_text          text
answer_email_ref     text                    -- email:<graphId> that answered
answered_at          timestamptz
resolved_to_version  int                     -- evidence-package version after resume
escalation_reason    text                    -- NO_RESPONSE | UNRESOLVED_AFTER_ANSWER
escalated_work_item_id fk -> work_items(id)
record_ownership     text not null default 'mixed'
created_at, updated_at
-- idempotency:
UNIQUE (acc_decision_id, conflict_id, round)          -- one live ask per fact per round
UNIQUE (answer_email_ref) WHERE answer_email_ref IS NOT NULL   -- an answer resolves once
```

Migration 434 is the authoritative schema. The illustrative columns above are
superseded there by the typed ownership (`owner_type` AI|HUMAN + `owner_agent_key`
+ `owner_user_id` FK + CHECK) on `acc_clarifications`, the `RETURNED_TO_AI` status
for explicit hand-back, and `ON DELETE RESTRICT` on the audit chain.

**`acc_clarification_events`** (now first-class, not optional) — append-only history
(`clarification_id`, `acc_decision_id`, `from_status`, `to_status`, `event_type`,
`actor_type` AI|HUMAN|SYSTEM, `actor_agent_key`, `actor_user_id`, `detail` jsonb,
`created_at`); INSERT/SELECT only. "What is true now" lives in the first two tables;
"how we got here" lives here — reconstruct why Miranda stopped, what she asked and
when, what evidence she had, whether she followed up, what came back, which package
resumed it, and why (if) it escalated. Same append-only spirit as
`nomination_events_audit` (mig 048).

## Final pre-apply schema review (the four checks)
1. **Identity abstraction:** no canonical agent/actor table exists (personas are
   code keys in `lib/team/roster.js`; `persona_voices.face` is only a voice key).
   Human identity is `user_profiles(id)` (UUID PK). So ownership is TYPED, not one
   polymorphic text field: `owner_type` (AI|HUMAN) + `owner_agent_key` TEXT (AI) +
   `owner_user_id` UUID FK→user_profiles (HUMAN), with a CHECK enforcing the
   combination — a typo can't become a valid owner, and the human side has real
   referential integrity. No global identity framework invented. Same split on the
   event log (`actor_agent_key` / `actor_user_id`).
2. **Delete semantics:** the audit chain uses `ON DELETE RESTRICT` on the
   `acc_decisions` / `acc_clarifications` parents (accidental parent deletion can't
   silently erase the trail). Soft references (community, outbound draft, work item,
   owner/actor user) are `ON DELETE SET NULL` so ordinary deletions aren't blocked;
   the CHECK tolerates a nulled `owner_user_id` for a departed HUMAN owner.
3. **Deployed-schema check:** all five FK targets exist and are reachable in the
   live DB; all target ids are UUID (matches these FKs); the three new tables do
   not yet exist (no collision). `trusted_set_updated_at` and `gen_random_uuid` are
   in use by applied migration 432.
4. **Atomicity/rollback:** wrapped in BEGIN/COMMIT — a partial failure rolls the
   whole migration back (never a half-installed model). All CREATEs use
   `IF NOT EXISTS`, indexes `IF NOT EXISTS`, trigger `DROP IF EXISTS`+CREATE, grants
   idempotent → safe to re-run.

## Idempotency & concurrency (exactly-once resume)

The resume path can be hit twice (webhook + poll, duplicate delivery, retry).
Three interlocking guards, all repo-idiomatic:
1. **Inbound is already exactly-once**: `email_messages.graph_id` UNIQUE — each
   reply is persisted once.
2. **Compare-and-swap on status** is the serialization point: resume runs
   `UPDATE acc_clarifications SET status='RESOLVED', answer_email_ref=$ref, ...
   WHERE id=$id AND status='AWAITING_RESPONSE'`. Only one caller's UPDATE affects
   a row; the loser sees 0 rows changed and stops. No advisory lock needed.
3. **Answer uniqueness**: `UNIQUE(answer_email_ref)` — a re-delivered answer can't
   create a second resolution.
Package versioning is safe via `UNIQUE(acc_decision_id, version)` inside the same
transaction as the CAS; the next version is computed and inserted atomically, so a
double-fire fails the unique and rolls back rather than forking the package.

## Integration points (where each edge fires)

- **Detect → create (PENDING):** live ACC evaluation hits `readiness==='CONFLICT'`
  → persist the current `EvidencePackage` version, insert `acc_clarifications`
  (PENDING), set `acc_decisions.status='awaiting_info'`. (Shadow: record-only, no row.)
- **Send (→ AWAITING_RESPONSE):** create an `outbound_email_drafts` row
  (`related_type='acc_decision'`, `draft_kind='acc_clarification'`,
  `source_email_ref`=case's latest inbound) → if `autoSendEnabled()` and autonomy
  permits, `graph_send.sendReplyAs` on the thread; on send set status, `sent_at`,
  `conversation_id`, `follow_up_due_at = now + waitPeriod(request_type)`.
- **Reply → resume (→ RESOLVED):** existing `graph_ingest` persists the inbound →
  `findOpenAccApplication` maps it to the case → resolver finds the
  `AWAITING_RESPONSE` clarification on that case → `applyClarification(pkg,{answer})`
  → persist new package version → CAS to RESOLVED → re-run ACC evaluation → case
  back to `pending_review`/`decided`. If the answer does NOT clear the conflict:
  record it, and if `round < MAX_ROUNDS` open round+1 (PENDING) else ESCALATE.
- **Follow-up / timeout (scheduler):** a `cron_runs`-logged tick scans
  `AWAITING_RESPONSE` past `follow_up_due_at`: if `follow_up_count < MAX_FOLLOWUPS`
  send Miranda's reminder, `follow_up_count++`, reset timer; else → ESCALATED +
  create a `work_items` row (`source_type='acc'`, human-owned, DECISION_REQUIRED).
- **Audit:** every package version is append-only; every status edge writes a
  clarification event; the finalized letter still seals to `finalized_record_archive`.

## The eleven questions, answered

1. **Clarification ↔ application ↔ exact package version:** `acc_clarifications.acc_decision_id` + `raised_from_version`; the versioned package lives in `acc_evidence_packages(acc_decision_id, version)`.
2. **Persist the exact unresolved conflict/question:** `conflict_id`, `topic`, `question` on the clarification; the full conflict object stays in that package version's `conflicts` jsonb.
3. **Correlate outbound ↔ homeowner response:** outbound via `outbound_draft_id` + `conversation_id`; inbound matched by `findOpenAccApplication` (thread/ref/email). Correlation is thread-level; `conversation_id` on the clarification pins the exact thread.
4. **Response → new evidence artifact:** `applyClarification` appends a `homeowner_clarification` manifest entry (`PRESENT_READABLE`) and the answer text into `bundle_text` — already built.
5. **New package version + resume exactly once:** new `acc_evidence_packages` row (version+1); resume gated by the status CAS (§idempotency) so it fires once.
6. **Duplicate/late responses:** `email_messages.graph_id` + `UNIQUE(answer_email_ref)` + the CAS → a duplicate is a no-op. A late answer after `RESOLVED`/`ESCALATED` is attached as evidence and flagged for the human handler, never a silent second resume.
7. **Retries/follow-ups:** `follow_up_count` + `follow_up_due_at`, driven by the scheduler; `waitPeriod`/`MAX_FOLLOWUPS` are per-request-type config (different asks wait different lengths).
8. **Unanswered vs answered-but-still-conflicting:** unanswered → follow-ups then `ESCALATED (NO_RESPONSE)`. Answered-but-unresolved → re-ask up to `MAX_ROUNDS`, then `ESCALATED (UNRESOLVED_AFTER_ANSWER)`. Two distinct escalation reasons.
9. **Miranda follows up vs human exception:** Miranda owns the reminders (config'd cadence). Only exhausting the follow-up budget OR the re-ask budget creates a human exception. Time alone never escalates.
10. **Auditable chain:** append-only package versions + clarification events + the sealed finalized letter give a full, replayable trail: which version raised which conflict, what was asked, when, what came back, which version resumed it, and why (if) it escalated.
11. **Safe under retries/webhooks/concurrency:** the status CAS is the single serialization point; inbound + answer uniqueness prevent double-processing; version uniqueness prevents a forked package. Nothing executes twice.

## Scope boundaries (unchanged)
No migration written, no endpoint/runtime change, no model/reasoning/verifier/
autonomy/ASSIST change. Sending stays behind the existing `AUTO_OUTBOUND_EMAIL`
kill switch and autonomy state; in shadow the workflow is record-only. Review this
design (state model + schema + idempotency + integration) before any migration.
