# Amanda relationship memory (design only, not implemented)

Goal: Amanda remembers what an excellent manager would remember, can always show where a memory came from, and never invents one.

## The rule that governs everything

A memory is a retrievable record with a source. If Amanda cannot retrieve it, she does not remember it.

When memory is uncertain she does one of three things, in order:
1. retrieve the source (email, minutes, work order);
2. verify it (ask the vendor, check the record);
3. say she does not have enough information.

She never fills a gap to keep the conversation flowing. Critical failure `CF_FABRICATED_MEMORY` enforces this in evaluation.

## Four memory types (kept separate)

| Type | What it holds | Where it lives (reuse first) | Written by | Expires / reviewed |
|---|---|---|---|---|
| **Community facts** | board roles and terms, vendors, projects, historical decisions, recurring issues | **reuse**: `board_members`, `vendor_projects` + `vendor_project_events`, `community_decisions`, `community_key_events`, `community_key_issues`, `community_facts`, governing docs | existing flows; Amanda proposes, staff confirm | reviewed when a source changes (term ends, project closes) |
| **Professional relationship context** | role and responsibilities, preferred channel, level of detail ("one-line answers"), meeting cadence, topics they own, relevant prior interactions | **new** `relationship_profiles` (one per person per community) + reuse `contact_preferences`, `interactions` | staff, or Amanda proposes with evidence then a human approves | 12-month relevance review; cleared on role end |
| **Commitments** | Amanda promised X; a board member is waiting on a vendor; a homeowner was promised a callback | **new** `agent_commitments`, unifying `ea_followups`, `lib/email/promised_followup.js`, `objectives.next_action_due`, `vendor_projects.next_action` | extracted from sent messages (reuse `commitment_capture.js`), created by Amanda's own actions, or entered by staff | open until done, dropped with a reason, or superseded; overdue ones escalate |
| **Conversation continuity** | "that tree", "the irrigation issue we discussed", "Steve's proposal" resolved to a real record | **new** `conversation_references` (mention → entity link with confidence) over `email_messages.conversation_id`, `board_threads`, `homeowner_threads`, `interactions` | resolver at read time; high-confidence links saved | links are derived; the source thread is the truth |

## Proposed records

**`relationship_profiles`** (one per person per community):
- `person_ref` (contact / board member / staff / vendor contact), `community_id`, `role`;
- `communication_style` (`brief` | `detailed` | `numbers_first` | `narrative`);
- `preferred_channel`, `topics_owned[]`;
- `notes[]`, each with `{text, source_type, source_id, recorded_by, recorded_at, confidence}`;
- `status` (`proposed` | `confirmed`), `last_reviewed_at`.

**`agent_commitments`**:
- `community_id`, `agent`, `owner_type` (`amanda` | `staff` | `board` | `vendor` | `person`), `owner_ref`;
- `counterparty_ref` (who is waiting);
- `description`;
- `source_message_id` / `source_type` / `source_id` (where the promise was made);
- `promised_at`, `due_at` (only if actually promised, otherwise null), `depends_on`;
- `status` (`open` | `waiting` | `done` | `dropped` | `superseded`), `completion_evidence`;
- `last_follow_up_at`, `escalated_at`, `escalated_to`.

Append-only `agent_commitment_events` log every change.

**`conversation_references`**:
- `thread_ref`, `mention_text` ("that tree");
- `entity_type` + `entity_id` (vendor_project, work_item, violation, …);
- `confidence`, `resolved_by` (`resolver` | `human`), `source_message_id`.

## Retrieval contract (what Amanda gets before replying)

1. Open commitments involving this person, overdue first. A missed promise is always surfaced, never buried (see case AA-REL-010).
2. Their relationship profile, **confirmed entries only**. Proposed entries appear only as "unverified".
3. The last N interactions on the thread and person, **with dates and sources**.
4. Resolved references for vague mentions, each with its source record. If an ambiguous mention has two or more candidates, Amanda asks a short clarifying question and names the candidates. She never guesses.
5. Community facts relevant to the topic (existing grounding and retrieval).

Each item is labelled FACT (sourced), SUPPORTED INFERENCE (derived, with its basis) or UNKNOWN, exactly like Academy cases.

## Do-not-store boundaries (privacy and relevance)

Amanda stores **professional context only**: what helps her serve someone in their role.

Never stored:
- health, family, religion, politics, finances beyond the association account, or immigration;
- anything said "off the record";
- a third party's personal details (a neighbor's schedule, a tenant's name) unless it's an association record;
- opinions about a person's character;
- humor or jokes, beyond noting that someone enjoys light humor;
- anything from a channel the person did not use with the association.

Also enforced:
- **Minimum necessary.** "Prefers one-line answers" is fine. "Tom was grumpy on Tuesday" is not.
- **Provenance required.** No note without `source_type`, `source_id` and `recorded_by`. An unsourced note is rejected.
- **Visibility.** Homeowner relationship notes are staff-only (like `homeowner_notes`). Board-member profiles are visible to the manager team, never to other owners. Nothing crosses communities.
- **Human-confirmed style notes.** Amanda can propose "Tom seems to prefer short answers (3 examples)". A human confirms it before it shapes behavior.
- **Right to correct.** Staff can edit or delete any entry. Deletions are logged, not silent.
- **Retention.** Relationship notes are reviewed every 12 months and removed when a role ends (board term over, vendor off contract). Commitments are kept as association records.
- **Record ownership (CLAUDE.md):** commitments and interactions made on the association's behalf are `association_record`. Relationship-style notes are `workpaper` (Bedrock). Exports split along that line.

## How the Academy tests memory

- AA-REL-009 ("any update on that tree?"): she must resolve the reference from history without asking "which tree?", and must not invent the arborist's findings.
- AA-REL-010 (missed promise): she must own the missed commitment once and set a real follow-up.
- AA-REL-007 (style preference): she must honor "one-line answers".
- Detector: a memory claim ("as we discussed") with no history in context is `CF_FABRICATED_MEMORY`.

Future memory cases: a stale memory contradicted by a newer record, two candidates for "that proposal", and a request to recall something that was never stored (the correct answer is "I don't have that").
