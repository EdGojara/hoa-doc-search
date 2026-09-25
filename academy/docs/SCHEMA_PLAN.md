# Amanda Academy: proposed schema and migration plan (NOT a migration; nothing applied)

v1 runs entirely from files (`academy/cases/*.json`, `academy/lessons/*.json`, `academy/reports/*.json`). These tables are the proposal for when the Academy moves into the database. Every new table follows CLAUDE.md:
- explicit `service_role` grants;
- a record-ownership tag;
- append-only events for anything auditable;
- `RESTRICT` foreign keys for audit-relevant links.

## Reuse (no new tables)

| Need | Existing |
|---|---|
| grading UI and store for real drafts | `shadow_drafts` (396/397: `ed_rating`, `ed_note`, `ed_rewrite`), `/admin/shadow` |
| production guidance injection point | `persona_learned_guidance` (398). Approved Academy lessons compile into this. It stays the only production entry point. |
| human edits to real drafts | `email_reply_edits` (335) |
| draft review before send | `outbound_email_drafts` (327) |
| agent decisions vs human outcome | `objective_decisions` (400) |
| person history | `interactions` (050), `email_messages` (261), `homeowner_threads`, `board_threads`, `homeowner_calls` |
| community memory | `community_key_events` (412), `community_key_issues` (426), `community_decisions`, `vendor_projects` + events, `board_members` |
| model routing and verification | `lib/ai` (`model_client`, `verify`, `decide` gates) |

## New tables

### Migration A: Academy core (workpaper, Bedrock IP)

**`academy_cases`**
- `case_id` text, `version` int, PK (`case_id`, `version`);
- `agent`, `domains` text[], `audience`, `channel`, `title`;
- `visible` jsonb (what the agent sees), `answer_key` jsonb (the facts / supported_inferences / unknowns split, traps, authority, expected communication, next action, completion);
- `deterministic_checks` jsonb, `provenance`;
- `origin` (`seed` | `regression` | `incident`), `origin_ref`;
- `status` (`draft` | `reviewed` | `active` | `retired`), `created_by`, `reviewed_by`, `activated_at`.
- A version is **immutable once active**; edits create version N+1.

**`academy_runs`**
- `id`, `started_at`, `mode` (`baseline` | `contract`), `agent_model`, `judge_models[]`;
- `prompt_fingerprint`, `knowledge_fingerprint`, `memory_fingerprint`, `tool_fingerprint` (so a change can be traced to its cause);
- `runs_per_case`, `triggered_by`, `purpose` (`nightly` | `pre_deploy` | `model_change` | `prompt_change` | `adhoc`), `cost_usd`.

**`academy_results`**
- `run_id`, `case_id`, `case_version`, `repeat_n`;
- `message` text, `internal_contract` jsonb, `contract_ok`;
- `expertise` / `judgment` / `relationship` / `execution` verdicts (enum);
- `dimension_detail` jsonb (per-judge verdicts, explanations, evidence, expected), `critical_failures` jsonb, `detector_signals` jsonb;
- `human_verdict_override` jsonb, `overridden_by`, `overridden_at` (calibration data).
- Append-only.

### Migration B: agent_lessons (workpaper)

**`agent_lessons`**
- `lesson_id`, `version`, PK (`lesson_id`, `version`);
- `agent`, `domain`, `trigger`, `principle`, `bad_pattern`, `preferred_pattern`, `examples` jsonb;
- `source` (`human_correction` | `incident` | `evaluator` | `case_review`), `originating_case_id`, `human_correction`, `confidence`;
- `status` (`draft` | `reviewed` | `approved` | `active` | `superseded` | `retired`);
- `reviewed_by`, `reviewed_at`, `approved_by`, `approved_at`, `regression_case_ids` text[], `supersedes_version`.

Guard trigger, the same rules as `academy/lib/lessons.js`:
- no skipping states;
- human `reviewed_by` and `approved_by` (machine actors rejected);
- `active` requires at least one regression case;
- an active version is immutable.

**`agent_lesson_events`**: append-only (created, reviewed, approved, activated, superseded, retired), with actor and note.

**Compile step (the only path to behavior):** a reviewed script renders active lessons into a `persona_learned_guidance` draft. A human approves that guidance row exactly as today. There is no automatic write.

### Migration C: relationship memory (`mixed`: commitments are `association_record`, style notes are `workpaper`)

- **`relationship_profiles`**: see docs/MEMORY.md. `status` is `proposed` | `confirmed`. A sourced-note constraint rejects any note without a source.
- **`agent_commitments`** and **`agent_commitment_events`**: unify `ea_followups`, `promised_followup` and `objectives.next_action_due`. Foreign keys to community, contact, source message and owner. `due_at` stays null unless a date was actually promised.
- **`conversation_references`**: mention → entity links, with confidence and provenance.
- RLS and API: staff and board scoping mirror `homeowner_notes` and the board-portal isolation. Nothing is visible across communities.

### Migration D (later): authority matrix (`association_record`)

**`community_authority_rules`**
- `community_id`, `action_type` (spend, contract, vendor_termination, fine_waiver, …), `threshold_cents`, `authority` (`manager` | `board` | `members` | `legal`), `source_document_id`, `citation`, `status` (`draft` | `verified`).
- It generalizes `community_assessment_authority` (465) and the `spending_authority_limit` currently parsed but not stored (`api/billing.js`).
- Judgment cases then check authority against verified rules instead of case text.

## Order
A and B first, since they only need evaluation and lessons. C once the retrieval contract is agreed. D when the authority matrix is sourced per community. Each migration gets a rolled-back rehearsal first, like 465 and 466.
