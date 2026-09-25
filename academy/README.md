# Amanda Academy v1 (sandbox)

The training, evaluation, memory and behavior framework for making Amanda an exceptional AI community manager: someone boards, homeowners, vendors and staff genuinely enjoy working with.

**Sandbox only.** Nothing here is imported by production code:
- Amanda's live prompt is read from source, never modified;
- nothing writes to the database;
- nothing sends email;
- nothing takes an autonomous action.

## Layout

```
academy/
  run.js                     harness: validate | dry | live evaluation (2 cross-provider judges)
  compare.js                 improvement/regression between two runs (per case, per dimension)
  cases/interaction.json     12 relationship-first cases (correct AND enjoyable)
  cases/technical.json       12 technical/judgment cases (from real 2026-09 situations, anonymized)
  cases/regression/          draft cases generated from human corrections
  lessons/seed_lessons.json  agent_lessons (all draft; nothing active)
  lib/live_prompt.js         loads Amanda's LIVE system prompts from lib/community/*.js source
  lib/amanda_under_test.js   baseline (production prompt) vs contract (internal response contract) modes
  lib/case_schema.js         case model + validator (FACT / SUPPORTED INFERENCE / UNKNOWN; leak guard)
  lib/rubric.js              four independent dimensions, judge prompt, merge (split -> needs_review)
  lib/critical.js            critical-failure catalog + deterministic detectors
  lib/lessons.js             lesson lifecycle draft -> reviewed -> approved -> active (human-gated)
  tools/correction_to_case.js  human correction -> draft regression case + draft lesson
  docs/RUBRIC.md  docs/MEMORY.md  docs/SCHEMA_PLAN.md
tests/test_academy.js        offline invariants (runs in npm test)
```

## Run it

```bash
node academy/run.js --validate
node academy/run.js --dry --cases AA-REL-009
node academy/run.js --cases AA-REL-006,AA-TEC-004 --runs 2
node academy/run.js --all --mode contract --runs 2
node academy/compare.js academy/reports/before.json academy/reports/after.json
```

## Architecture

```
            case (visible half) ──► Amanda under test ──► response ──┬─► detectors (signals / high-precision criticals)
            ▲                        live prompt (baseline)          ├─► judge A (Anthropic)  ─┐
            │                        + contract (optional)           └─► judge B (OpenAI)     ─┴─► merge: per-dimension verdicts,
 answer key (judges only)                                                                          split = needs_review, criticals
            │                                                                                      with provenance, consistency
            ▼                                                                                                  │
   human correction ──► correction_to_case ──► draft regression case + draft lesson ──► human review ─► approval ─► active
                                                                                                        │             │
                                                                            permanent regression test ◄─┘             ▼
                                                                                      compile ─► persona_learned_guidance (human-approved)
```

**Four independent dimensions.** Expertise, judgment, relationship and execution are judged separately, and there is no overall score. Correct but socially poor fails relationship. Warm but wrong fails expertise. See docs/RUBRIC.md.

**Critical failures.** These are flagged independently of the verdicts, with provenance: which judge or detector raised each one, and whether it's confirmed or disputed.

**FACT / SUPPORTED INFERENCE / UNKNOWN.**
- Every case's answer key keeps the three separate.
- Contract mode makes Amanda produce the same split internally.
- Presenting an unknown as fact is a judgment failure.

**Internal response contract** (contract mode):
- Fields: `facts`, `supported_inferences`, `unknowns`, `issues`, `proposed_actions`, `authority_required`, `escalation`, `communication_plan`, `next_action {action, owner, due, depends_on}`, `completion_condition`.
- Never shown to the person. The message still has to sound like Amanda.

## Existing architecture reused

| Need | Reused |
|---|---|
| Amanda persona | `lib/community/amanda_reply.js` (board / homeowner / vendor prompts), `amanda_staff_assist.js`, roster, signature, `CONTACT_ROUTING_RULE`, `NO_OVERPROMISE_RULE`, `FINANCE_PRIMER` |
| Models | `lib/ai/model_client.js` (Anthropic + OpenAI, retries, empty-output = error), `lib/ai/usage.js` (in-memory cost) |
| Eval precedent | `evals/` (deterministic rubric + severity gate + cross-check), `scripts/train_persona.js` |
| Human grading | `shadow_drafts` + `/admin/shadow` (`ed_rating`, `ed_rewrite`) |
| Production learning path | `persona_learned_guidance` (398), `email_reply_edits` (335), `photo_analysis_corrections` |
| Memory | `interactions`, `email_messages` (resolved contact / property / vendor), `community_key_events`, `community_key_issues`, `vendor_projects` + events, `board_members` |
| Commitments | `ea_followups` + `lib/email/commitment_capture.js`, `lib/email/promised_followup.js`, `objectives` / `objective_events` / `objective_decisions` |
| Authority | `community_assessment_authority` (465), `lib/team/operator_core.reservedAsk`, `operator_actions` (safe vs reserved) |

## Gaps found (inputs to the implementation sequence)
1. Amanda bypasses `lib/ai`: every path hardcodes `claude-sonnet-4-5`. There's no routing, verification or model swap without editing code.
2. `amanda_reply` runs neither `scrubFabricatedConfirmation` nor the `grounding.js` receipts pass. Both exist, and other personas use them.
3. Amanda's fallback reply opens with "Thank you for reaching out, and I'm sorry this has been frustrating". That's a stock phrase the tone rules ban.
4. The board prompt demands "2 to 3 options with tradeoffs and your recommendation" for every board message, including casual status questions. That works against the relationship goals. The sample run is what shows whether it causes harm.
5. There's no lesson approval lifecycle. Playbook entries go live on save, and `persona_learned_guidance` has only a status field, with no versions or approver history.
6. There's no commitments table with community, contact, owner and source foreign keys. `ea_followups` is for Ed and Tessa only.
7. There are no relationship profiles (style, detail preference) with provenance.
8. There's no authority matrix covering manager vs board thresholds by action type.
9. Evals store JSON files only, and there's no judge for tone or judgment.
10. Amanda isn't in `persona_configs` or the shadow lanes by default.

## Lesson workflow
`draft → reviewed → approved → active`, and any state can go to `retired`. Editing an active lesson creates a new version; the old version stays active until the new one is activated.
- Evaluator-generated lessons are drafts and **cannot** leave draft without a human reviewer.
- `approved` requires a human `approved_by` and `approved_at`.
- `active` requires at least one linked regression case.
- Only active lessons compile, and they compile into a `persona_learned_guidance` draft that a human approves.

Tested in `tests/test_academy.js`.

## Regression workflow
`real situation → Amanda response → human correction → lesson → approved lesson → permanent regression test`
1. Capture the correction as JSON: situation, Amanda's response, the correction, the answer key, the lesson. Sources: `shadow_drafts` grades, `email_reply_edits`, or a direct correction.
2. `node academy/tools/correction_to_case.js correction.json` writes a **draft** case (`AA-REG-###`) and a **draft** lesson, linked. The original response and the correction are preserved verbatim.
3. A human reviews both, the case becomes active and the lesson is approved, then activated.
4. The case runs in every Academy run from then on. Case versions are immutable once active.
5. After any model, prompt, tool, knowledge or memory change, run the suite and `compare.js` against the last baseline. Reports carry the live-prompt fingerprint, so a regression traces back to its cause.

## Implementation sequence (recommended)
1. **Now (this deliverable):** sandbox harness, 24 cases, rubric, lesson model, memory design, schema plan, sample evaluation.
2. **Calibrate the judges:** Ed grades about 30 responses. Compare his verdicts with the judges per dimension, tune the rubric wording, and set a bar for trusting auto-verdicts. Reuse the `/admin/shadow` grading UI.
3. **Expand to about 80 cases,** weighted to real history: shadow_drafts Ed rewrote, and real board and homeowner threads (anonymized). Add memory cases: stale memory, two candidate references, a never-stored fact.
4. **Close cheap production gaps behind review.** Each is a separate approval, and none changes behavior without one:
   - route Amanda through `lib/ai/model_client`;
   - add the fabricated-confirmation scrub and grounding receipts to `amanda_reply`;
   - replace the canned fallback;
   - make the board prompt respect casual questions.

   Each goes through an Academy before/after comparison first.
5. **Migrations A and B:** cases, runs, results and lessons in the database, a nightly run, and an admin page.
6. **Commitments (migration C, part 1):** unify commitments and surface overdue ones in Amanda's context and on the ops board.
7. **Relationship profiles and continuity (migration C, part 2):** proposal-then-confirm style notes and reference resolution.
8. **Authority matrix (migration D):** per-community verified rules, used by judgment cases and by the reserved-decision gate.
9. **Graduated autonomy:** only lanes whose Academy verdicts and critical-failure rate hold steady across model and prompt changes move from draft to execute. Every move needs Ed's approval.
