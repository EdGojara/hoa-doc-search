# Violations Drive Capture and Post-Drive Escalation: Assessment

**Status:** assessment only. No code, migration, deploy, letter sent, violation status changed, or production write. The production checks below were read-only (aggregate counts only; no PII).
**Requested by:** Ed via ChatGPT "PRIORITY SHIFT" instruction, GitHub Issue #1 (2026-09-28 14:34 UTC).
**Kept separate from:** employee timekeeping (paused, branch untouched) and payment work.
**Branch:** `docs/drv-capture-escalation-assessment` (docs only, cut from `main`).

> **Legal notice.** Texas Property Code Chapter 209 items are marked **VERIFY**. They cover:
> - notice content and delivery;
> - certified mail;
> - cure periods;
> - hearing rights;
> - the six-month repeat rule;
> - fines;
> - board authority;
> - self-help.
>
> Current statute and association counsel review are needed before any change that affects which notice is sent. Nothing here is a legal conclusion.

The document keeps four kinds of statement apart:
- **Section 2: CONFIRMED.** Read in code (path cited), or seen in production with read-only aggregate queries (marked **[prod]**).
- **Section 3: DEFECTS.** Each is labeled **confirmed** (code plus production evidence) or **likely** (code only).
- **Sections 4 to 9: PROPOSALS.** Nothing in them is built.

---

## 1. Summary

1. **Ed's desired field workflow is already mostly true for new issues.**
   - The inspector selects a house, takes a photo, and moves on.
   - The inspector picks no category or notice stage; AI proposes the category (`lib/enforcement/ai_vision.js`).
   - Nothing becomes a violation until an office user confirms it: `AUTO_OPEN_VIOLATIONS_ON_INSPECTION=false` and `AUTO_DRAFT_LETTERS_ON_INSPECTION=false` (`api/inspections.js:36, 46`).
2. **Escalation is decided in many places, not one end-of-drive step.** There are five paths:
   - office confirm (auto courtesy_1 → courtesy_2 on re-observation);
   - a daily cure-lapse job (which can auto-advance to certified and to fine);
   - staff "Advance stage" buttons, reachable from the field property panel;
   - bulk reconcile;
   - manual resolve.
   There is no single reconciliation pass, no drive-level review, and no per-drive letter batch.
3. **"No new photo" must not mean "resolved" today, and the data shows why.**
   - "Nothing found at this house" is kept only in browser memory (`inspPDMarkClean`, `public/index.html:19986-20006`) and lost on refresh.
   - Coverage is computed three different ways.
   - Drive end times can be fabricated by the stale-close job, which is **running in production** [prod].
   - GPS coverage reads are capped at 1,000 pings, and 15 of the last 60 drives exceeded that [prod].
4. **Letters:**
   - The notice stage comes from the violation's `current_stage`, not staff choice (`api/enforcement.js:1446-1455`).
   - **One approval covers every stage.** Certified §209 notices have no second gate: `supervisor_approved_*` columns exist but are unused.
   - The §209 wording in the standard letter is **hard-coded** (`lib/enforcement/violation_letter.js`), not injected from GLOBAL_RULES as CLAUDE.md requires.
5. **Recommendation.** Keep capture as it is, and add three things:
   - a persisted **property visit** record: covered, photographed, or explicitly checked, with per-prior-issue outcomes;
   - a single **end-of-drive reconciliation** that proposes CONTINUE/ESCALATE, NEW, RESOLVE or NEEDS_REVIEW for every open case on every visited property, with UNCERTAIN as the default when evidence is thin;
   - a **reviewed draft batch** with a separate approval gate for certified/formal notices. State changes and letters happen only after approval.
6. **Fix the confirmed data defects first** (section 3). Several directly affect escalation correctness.

---

## 2. Confirmed current behavior

### 2.1 Field capture (Inspect tab, `public/index.html`)
- **Start a drive:** `inspStart` (22432).
  - Community is required. Mode is `drive_by`, `resale` or `mounted_camera` (21761). Route label and driver name are optional.
  - It calls `POST /api/inspections`.
  - `public/inspector.html` is a GPS tracker only, with no photo UI (265-496).
- **Identify the property:** tap a pin or list row (`inspMapHandleMarkerClick` 21678), or use "Pre-select for capture" (`inspPDPreselect` 19977).
  - The selection is sticky across photos (23671-23678).
  - With no house selected, a red banner shows and the first shot asks for confirmation (22341, 23024-23043).
  - Each shot toasts the house it went to, or "UNLINKED" (22361).
- **Linking on the server** (`api/inspections.js:630-662`): a manual selection is authoritative and is written to both `polygon_match_property_id` and `reviewer_confirmed_property_id`.
  - The GPS fallback calls RPC `match_property_by_point`, which **does not exist in production** [prod]: it isn't in the PostgREST function list, and the code comment at 652 says "doesn't exist yet". `set_inspection_photo_geo` doesn't exist either.
  - In practice linking relies on manual selection, and it works: **9 of 5,220 photos are unlinked** [prod].
- **Photo roles:** single by default, with a sticky pair mode (wide, then close-up; `062`). Wide shots get no observation and no AI (667-670, 774). Unlinked photos are fixed through `/photos-needing-link` and the link endpoints (3145, 3202, 4575).
- **Offline:**
  - photos queue in IndexedDB `bedrock_inspect_queue` (23197), compressed to 1920px and stored as an ArrayBuffer (23216, 23288);
  - retry every 5 s and on `online`, with backoff (23323); 400/404 are dropped as failed (23344);
  - backlog is recovered on load (23415, 23564).
  - **No service worker or offline app shell for Inspect** (`public/sw.js` is registered only by `ask-ed-chat.html` and `tessa.html`).
- **Taps per house:** select, take photo, optionally "Done with house". **The inspector chooses no category, stage or escalation during capture.**

### 2.2 Where field staff CAN set escalation today
The **property-detail modal** is available during a drive (`inspOpenPropertyDetail`, backed by `GET /inspections/property-detail/:id`, api 2448). It shows the open and prior violations, a 12-month escalation hint (19464-19477), legal flags, and letters sent. It lets staff:
- **Advance stage** (`inspAdvanceStage` 20286 → `POST /api/enforcement/violations/:id/advance-stage`, enforcement 7991);
- **Reduce stage** (20312);
- **Add prior violation** at any stage including certified or fine (20190 → `/violations/manual`);
- **Mark cured** (`inspMarkCured` 20335 → `/violations/:id/resolve`, a reason is required).

These are the only field touchpoints for escalation, and the office uses them too.

### 2.3 AI analysis and duplicates
- **Model and trigger:** `categorizePhoto` (`lib/enforcement/ai_vision.js`), model `claude-sonnet-4-5` (151), fired after upload (`api/inspections.js:797`).
- **Output:** at most one finding per photo: `{category_slug, severity, description, recommended_action, confidence low/medium/high}`.
  - Stored on `property_observations` (`050:226`: `category_id`, `severity`, `ai_description`, `ai_confidence`, `ai_suggested_category_id`, `reviewer_status`) and on `inspection_photos.ai_*` (`212`).
- **Few-shot learning** from reviewer corrections per community (`vision_learning.buildLearnedCorrections`, 832).
- **Eligibility:** only medium or high confidence with a known slug (939-941), deduped to one per category per photo set (951-960). A clean result sets `severity='clean'`, `reviewer_status='rejected'` (859-868).
- **Duplicate-photo detection: none** (searched for hash, phash, sha256, content_hash).
- `ai_detected_house_number` and `address_confidence_score` exist but are never written.

### 2.4 Coverage (three definitions)
- **Map ring (client, 21300-21322):** the house has a linked session photo, OR it was marked clean in memory, OR it appears in `liveOtherCoveredIds`.
- **`GET /inspections/live/:community_id` (2250):** any observation in the last 18 h. Wide-only photos don't count.
- **`GET /inspections/:id/coverage` (2336):** within 50 m of any GPS ping; **no photo needed.**
- **Pagination defects:**
  - `/live` pings are unpaged (2285-2289);
  - `/live` observations use `.range()` without `.order()` (2307-2312);
  - `/:id/coverage` pings are unpaged (2371-2374);
  - `/:id/analyze` photos are unpaged (2965);
  - the completion-status observations are unpaged (366).

### 2.5 Violation identity and continuity
- **`violations`** (`050:275-298`, plus `057`, `219`, `247`, `323`, `337`, `347`).
  - `current_stage` CHECK: `courtesy_1, courtesy_2, certified_209, fine_assessed, cured, closed, voided` (`050:287`). Open means not cured, closed or voided, and `resolved_at` null.
  - Other fields: `primary_category_id`, `cure_period_ends_at`, `resolved_via` (cured/fine/withdrawn/voided), `is_recurrence`, `recurrence_of_violation_id`, `certified_notice_date`, `quality_status`, `reviewed_by_user_id`.
  - Open cases in production: courtesy_1 1,314; courtesy_2 237; certified_209 208; fine_assessed 5 (of 7,950 total) [prod].
- **No link to a specific rule or provision on the violation.**
  - Citations live per (community, category) in `community_enforcement_priorities.governing_doc_*` (`056:21-30`) and `communities.enforcement_authority_citation` (`079`).
  - They are looked up at letter time (`lib/enforcement/governing_doc_lookup.js`). The citation used isn't stored on the case.
- **Owner:** there is no owner or tenure column; the owner is derived at read time from `v_current_property_owners`.
- **Categories and aliases:**
  - `enforcement_categories` (`050:105`; `recurrence_escalates` added in `336`);
  - confirmed aliases in `enforcement_category_aliases` (`223`);
  - `expandCategoryToAliases` / `getCanonicalCategory` (`lib/enforcement/category_aliases.js:34, 71`).
- **`findOrContinueViolation`** (`lib/enforcement/find_or_continue_violation.js`):
  - The open-case lookup is alias-expanded and picks the furthest stage (142-165).
  - It excludes the case this same observation opened (196).
  - On a match it writes `violation_continuations` (unique per observation) and **never changes the stage itself** (248-308).
  - Closed priors are never reopened. `detectRecurrence` (63-100) flags a new case only when the category is marked `recurrence_escalates` and a prior was cured within 183 days (`current_stage='cured'` only).
- **One-open-case index** `uq_violations_one_open_per_property_category` (`340`) is keyed on the raw category, **not alias-aware.**

### 2.6 Where the stage changes (five paths)
1. **Office confirm of a re-observation** (`POST /inspections/observations/:id/confirm`, `api/inspections.js:3607`, outcome from `lib/enforcement/reobservation_outcome.js:36-74`):
   - courtesy_1 with the first notice mailed: **auto-advances to courtesy_2** and drafts the letter;
   - courtesy_2: flagged `eligible_209` only;
   - certified or fine: continuation only.
   - New cases get their stage from `decideEscalation` (`lib/enforcement/escalation.js`).
   - A recurrence opens at certified_209 (3834-3857).
2. **Cure-lapse job** (`processCureLapses`, `api/enforcement.js:6836`; scheduled at `lib/scheduler.js:261-265`):
   - It **can auto-advance courtesy_2 → certified_209 and certified_209 → fine_assessed** when fines are enabled. Its cure days are hard-coded (20/30).
   - No self-help guard, no certified guard.
   - Opt-in via `SCHEDULER_ENABLED`; **last recorded run 2026-06-07** [prod, `cron_runs`], so it is not running now.
3. **Staff advance or reduce** (`/advance-stage` 7991, `/reduce-stage` 8131). The only gate is `fines_enabled` for fine and later stages.
4. **Bulk reconcile** (`/reconcile/apply` 5245): courtesy_1 → courtesy_2 only; excludes self-help slugs (5116).
5. **Resolve:** `/violations/:id/resolve` (enforcement 5847; notes required; no photo; re-stages siblings), plus a second path in `api/homeowner_360.js:877` (notes optional; sets cured even for voided or withdrawn; no sibling re-stage).
   - Bulk `/stale-violations/close` (6014) skips certified and fine.
   - `cert-reinspect` "cured" (`public/cert-reinspect.html`; `violation_field_checks`, `322`) records a check but does **not** close.

### 2.7 Community policy
- `communities.fines_enabled` plus a board date and minutes reference (`058:25`).
- `community_category_fine_schedule` plus `v_resolved_fine_schedule`, time-bounded.
- `community_enforcement_priorities` (priority weight, board vote reference, time-bounded).
- `communities.letter_cure_days_courtesy_1/2/certified_209` (`063`, defaults 20/20/30).
- `bundle_certified_letters_separately` (`133`).
- **No escalation-ladder configuration:** the ladder is hard-coded in `escalation.js` and in `conventionalNext` (enforcement 8012-8018).

### 2.8 Letters, approval, sending, delivery
- **Generate:** `POST /api/enforcement/generate-letter` (1380).
  - The template comes from `current_stage` (1446-1455).
  - The click **also verifies** an unreviewed AI violation (1419-1432).
  - The record is an `interactions` draft (1890-1907), with certified mail for certified, fine and self-help.
  - Self-help 10-day categories use `renderForceMowLetterPdf` (1718), the only renderer using `lib/global_rules.js`.
- **Batch tools:**
  - `/drafts/generate-missing` (2219) drafts courtesy_1 only; higher stages go to `needs_review`.
  - `/drafts/auto-bundle` (2329) makes one envelope per property and stage.
  - A Mail Queue (2954-3347).
  - `GET /inspections/:id/completion-status` (410) only **warns** about unsent letters.
- **Approve:** `/drafts/approve` (2760) takes an array of ids, stamps `approved_by_user_id`, and applies **the same single gate to every stage.**
  - Unapprove (2801) works until print. Reject (2854) voids the violation and rejects the observation.
  - UI: "STEP 2 Drafts queue" with multi-select approve (`public/index.html:~18385`, 26562).
- **Mail:**
  - `/mail-queue/lock-and-batch` (3562) re-renders to the postmark date and sets `cure_period_ends_at` = postmark + community cure days (3780-3783, 4010).
    - It seals the archive (`309`) and the evidence (`310`), writes `delivery_receipts` (tracking null) and `letter_mail_pieces` (provider manual).
    - It posts the certified fee.
  - `/mail-queue/confirm-mailed` (3165) runs `stale_letter_guard` and sets `mailed_at` (overwriting `sent_at`).
  - `/interactions/:id/record-mailing` (5315, admin) sets the true mail date and tracking number and recomputes cure dates.
  - Lob: `/mail/send-via-lob` (9614, needs `LOB_API_KEY`), plus a webhook (9805) that updates `letter_mail_pieces` (`180`: tracking, `delivered_at`, signature).
  - **No upload path for green cards or return receipts.**
  - `certified_notice_date` is set only by `/cert-reinspect/:id/certified-date` (11605), not by lock-and-batch.
- **Mailing never changes `current_stage`.**
- **§209 wording in the standard letter is hard-coded** in `lib/enforcement/violation_letter.js` (header 22-52; body around 256, 259, 1021, 1099). `lib/global_rules.js` is used only by `lib/lawn_force_mow_renderer.js:26`.

### 2.9 Audit
- **Kept today:**
  - `violation_corrections` (`057`, `original_state` JSONB);
  - `violation_continuations` (`219`);
  - `violation_field_checks` (`322`);
  - `violation_letters` (`124`, written only by manual, bulk-attach, advance-stage and force-mow paths);
  - sealed letters and evidence (`309`, `310`, sha256, append-only seals).
- **Missing:**
  - a stage-history table;
  - an actor on stage changes;
  - immutability triggers on violations.
  Stage changes are logged only as best-effort `interactions` notes (enforcement 405, 8057). Cure-lapse and reconcile write none.
- **Reviewer attribution on observations is mostly missing:** 96 of 5,128 observations have `reviewer_user_id` [prod]. Confirm and reject send an empty body (`public/index.html:24598, 24691`).
- **Health:** `lib/enforcement/health.js` and `GET /api/enforcement/health` (138) report dup_risk, category_phantom, rejected_open, orphan_drafts, open_no_letter and stale_pending. `scripts/audit_enforcement_divergence.js` is the matching audit script.

### 2.10 Miranda
Miranda Pierce is the AI "Compliance / DRV" email persona:
- `lib/team/roster.js:118-121`, `lib/team/persona_configs.js:76-83`;
- she drafts reviewed replies to homeowner DRV responses (`lib/enforcement/drv_reply.js`).

**She has no role in field capture or escalation.** In the proposal she could draft the reviewer's plain-language summary of a batch. She would never decide a stage.

---

## 3. Defects

| # | Defect | Status | Evidence | Why it matters here |
|---|---|---|---|---|
| D1 | Stale-drive job may set `ended_at = started_at + 4h` mid-drive | **confirmed** | Job runs in prod (last run today). 20 drives carry its auto-close note; 6 end exactly at start + 4 h; 137 of 149 drives have null `last_ping_at`; 23 of 60 sampled null-ping drives do have GPS traces [prod]. The Inspect tab never updates `last_ping_at` (`api/inspections.js:2170` vs 4946) | Drive windows (and "was this house in scope?") are unreliable |
| D2 | GPS coverage reads capped at 1,000 pings | **confirmed** | 15 of the last 60 drives exceed 1,000 pings (max 5,149) [prod]; `/:id/coverage` and `/live` are unpaged | Undercounts coverage, so "not covered" becomes wrong |
| D3 | "Mark clean" isn't persisted | **confirmed (code)** | Client memory only (19986-20006) | No durable negative observation exists |
| D4 | add-violation writes columns that don't exist | **confirmed** | `opened_by_observation_id` / `opened_by_email` missing in prod [prod] (`api/inspections.js:4766-4767`) | A field add-violation path fails silently |
| D5 | Confirm reads nonexistent priority columns and ignores the error | **confirmed** | `community_enforcement_priorities.fines_enabled` / `fine_amount_cents` missing in prod [prod]; query at `api/inspections.js:3790-3795` doesn't destructure `error` | Priority always falls back to "standard"; board priority is ignored |
| D6 | advance-stage ladder goes past `fine_assessed` to values the CHECK forbids | **likely** | `conventionalNext` (enforcement 8012-8018) vs `050:287` | Advancing a fined case fails at the DB |
| D7 | Recurrence cases may get a courtesy-length cure window | **likely** | Opens at certified_209 with the courtesy decision's `cure_days` (3836-3838); validator floor is 30 | Certified notice with a short cure period [VERIFY] |
| D8 | One-open-case index and several prior-count queries aren't alias-aware | **confirmed (code)** | `340` raw category; confirm prior query, `processCureLapses`, `assess-fine` | Duplicates and wrong offense counts |
| D9 | Cure-lapse can auto-escalate to certified and fine with hard-coded cure days and no certified or self-help guard | **confirmed (code); not running now** | enforcement 6836, `escalation.js:83-151`; last run 2026-06-07 [prod] | Must stay off until replaced by the reviewed pipeline |
| D10 | One approval gate for all stages; `supervisor_approved_*` unused | **confirmed (code)** | enforcement 2760 | Certified or formal notices can go out on one click |
| D11 | §209 wording hard-coded in the standard letter, not GLOBAL_RULES | **confirmed (code)** | `violation_letter.js`; `global_rules.js` used only by force-mow | Violates the CLAUDE.md single-source rule |
| D12 | Two resolve paths with different rules | **confirmed (code)** | enforcement 5847 vs `homeowner_360.js:877` | Resolution audit is inconsistent |
| D13 | No reviewer or actor on observation confirm and reject | **confirmed** | 96 of 5,128 [prod] | No accountability on the key decision |
| D14 | No duplicate-photo detection | **confirmed (code)** | Searched | The same image can support two observations |
| D15 | `match_property_by_point` / `set_inspection_photo_geo` RPCs missing | **confirmed** | Not in the prod function list [prod] | No GPS fallback if the inspector forgets to select |

---

## 4. Why absence is not resolution (safeguard)

- **A missing photo can mean any of these:**
  - the house was cured;
  - it was skipped;
  - it was out of scope;
  - it was blocked (car or trash truck);
  - the condition is seasonal or intermittent (trash cans on non-trash days);
  - the inspector missed it;
  - the upload is still queued offline;
  - the photo linked to the wrong house;
  - the photo was wide-only (no observation).
- **Today the system has no durable record** that separates "looked and it's gone" from "didn't look" (D3). Its coverage signals are inconsistent (2.4) and partly broken (D1, D2).
- **Rule for the proposal:** a RESOLVE proposal requires **positive evidence of absence**:
  - an explicit per-issue "not present" check by a person at the property (with an optional photo), or
  - a full-property pass that the reviewer accepts, per section 5.3.
- **Everything else is UNCERTAIN.** It never closes and never escalates by itself.

---

## 5. Proposed design

### 5.1 Principles
1. **Capture stays minimal.** Select the house, take photos, move on. No stage, category or escalation decisions in the field.
2. **One reconciliation, after the drive,** against the full history and the community policy version.
3. **Every proposal carries evidence and a reason.** Ambiguity goes to NEEDS_REVIEW, never a guess.
4. **Human approval before any state change or letter.** A certified or formal notice needs a second, distinct approval.
5. **Immutable decision trail.** Proposals, decisions and state changes are events.
6. **Statutory wording from GLOBAL_RULES only** (fixes D11). [VERIFY] content with counsel.

### 5.2 Field capture additions (minimal taps, offline-safe)
- **Property visit** (new, persisted): created automatically the first time a property is photographed or selected during a drive.
  - It has `inspection_id`, `property_id`, `first_seen_at`, `visited_by_user_id`, and a `visit_state`: `photographed`, `checked_clean`, `checked_with_issues`, or `skipped` (reason: blocked, no access, out of scope).
  - It is queued in IndexedDB like photos, and idempotent through a client-generated id.
- **Prior-issue quick check.** When the inspector selects a house that has open violations, a compact strip lists them, e.g. "Trash cans (courtesy 2)".
  - Each item has two optional buttons: **"Still there"** (prompts a photo) and **"Not present"** (a photo is optional, but encouraged for certified cases).
  - The default is untouched, meaning not checked. **The inspector never escalates anything.**
  - This replaces in-drive use of Advance, Reduce and Mark cured, which become office-only (they move out of the field modal).
- **"Done with house"** turns into `checked_clean` or `checked_with_issues` automatically, based on whether photos exist.
- **Ambiguous property** (no house selected): the photo stays unlinked and goes to review, as it does today.
- **Offline:**
  - add a service-worker app shell for the Inspect tab, so a restart without signal still opens the queue;
  - visits and checks queue alongside photos.
- **Duplicates:** a perceptual hash (plus exact sha256) on upload. Near-duplicates within the same property and drive are flagged, never auto-dropped.

### 5.3 Drive completion and coverage validation
- **End drive** runs a completeness check before reconciliation:
  - uploads fully drained (the device reports an empty queue);
  - visits list complete;
  - unlinked photos resolved or explicitly deferred;
  - AI analysis complete for every close-up and single photo.
- **Coverage is one definition.** Stored per property per drive (`drive_property_coverage`, derived):
  - `visited`: a visit record exists;
  - `passed`: within X m of paged GPS pings, with no visit;
  - `not_passed`.
  "Passed" is recorded as context only. **It never supports RESOLVE by itself.**
- **Drive scope:** the drive declares a scope (full community, a section or polygon, or a spot list). Properties outside the scope are never considered "missed".
- **Drive time quality:** `ended_at_quality` (`user`, `auto_stale`, `legacy_unverified`), per the timekeeping assessment. Drives with `auto_stale` or `legacy_unverified` end times can't support a RESOLVE based on scope.

### 5.4 Reconciliation (per property in scope)
For each property, the drive's evidence is compared with the full history:
- the drive's observations (AI category, confidence, reviewer corrections);
- visit state and per-issue checks;
- all open cases (alias-expanded, furthest stage);
- closed cases in the look-back window;
- letters and mailing proof;
- cure deadlines;
- the community policy version.

Each open case and each new observation gets exactly one proposal:

| Proposal | When | Evidence required |
|---|---|---|
| **CONTINUE** | Same condition observed; cure period not yet lapsed, or prior notice not yet mailed | Photo matched to the case (5.5) |
| **ESCALATE** to stage N | Same condition observed after the cure deadline, prior notice **mailed with proof**, and policy allows stage N | Match, `mailed_at` / postmark, `cure_period_ends_at` < observation time, policy version |
| **NEW** | Condition with no open case for the canonical category | Observation plus confidence; check for a recurrence within the look-back window [VERIFY the six-month rule] |
| **RESOLVE** | Positive evidence of absence: an explicit "Not present" check, or a reviewer-accepted full pass | Check record (and photo if required); coverage state `visited` |
| **NEEDS_REVIEW** | Ambiguous match, low confidence, a mail proof gap, drive time unreliable, self-help or 10-day category, certified or fine target, legal flag, attorney referral, owner changed since the notice | Reason codes |
| **UNCERTAIN** | Open case, property not visited or not explicitly checked | None: an explicit no-action state |

**Guards:**
- **Owner change since the last notice** (tenure changed): never escalate; propose NEEDS_REVIEW, and restarting at courtesy_1 is a policy decision [VERIFY].
- **Self-help or 10-day categories and anything already certified or later:** NEEDS_REVIEW always. This matches the rule "never auto-touch certified §209 or 10-day".
- **Mailing proof missing** (no `mailed_at`, or tracking missing for certified): no escalation; NEEDS_REVIEW.
- **Recurrence** opens at the policy stage only with the correct cure period (fixes D7), and always goes through review.

### 5.5 Matching a photo to the SAME condition
- **Candidate match:** same property, **and** a canonical category (alias-expanded) equal to the case's canonical category, **and** the case's category rule is unchanged.
  - Don't trust the label alone. If the case's category was re-aliased or its governing provision changed (`community_enforcement_priorities` effective dates), propose NEEDS_REVIEW.
- **Confidence tiers:**
  - AI high confidence with the same canonical category: *proposed match*;
  - medium: *proposed match, flagged*;
  - low, or a different category at the same location: **NEEDS_REVIEW**.
  - Two open cases that could match the same photo: NEEDS_REVIEW.
- **Different issue at the same property:** a NEW proposal that is independent of the existing case, and never merged silently.
- **Store the match decision** (`observation_case_links`: observation, case, method (`ai_proposed`, `reviewer_confirmed`), confidence, decided_by). `violation_continuations` remains the confirmed-continuation record.
- **Store the governing-doc citation used on the case** when it opens (a column or link), so later letters cite the same provision unless a reviewer changes it.

### 5.6 Review and batch
**The reviewer screen, per drive:**
- a summary (for example: covered 312, visited 188, new 14, continue 22, escalate 9, resolve 6, needs review 11, uncertain 87);
- property cards, each showing photos next to the prior case photo, the proposal, the reason codes, and the evidence;
- **Approve classification** per item or in bulk, but bulk is **allowed only for CONTINUE, NEW-at-courtesy and RESOLVE-with-check**. ESCALATE and NEEDS_REVIEW items need an individual decision.

**Approval gates:**
- **Stage 1 (classification):** a staff reviewer.
- **Stage 2 (notice):** after classification approval, draft letters are generated into a **drive batch** (reusing `/drafts`, auto-bundle, and the Mail Queue).
  - Courtesy notices: one approval, as today.
  - **Certified/formal §209 notices, fines, and self-help:** a **second approval by a different, designated approver.** This would put the unused `supervisor_approved_*` columns (D10) to use.
  - Board approval where community policy requires it: a board motion link [VERIFY which actions need a board vote per community documents].

**After approval, in order:**
1. state changes (stage, dates) are applied as events;
2. letters are locked and queued;
3. mailing proof updates the cure dates (existing lock-and-batch / record-mailing).

**No stage changes on mailing, as today.** Escalation happens only through an approved proposal.

**Rejected proposals** keep their reasons, and they feed AI learning, as reviewer corrections already do.

### 5.7 Data model (minimal, all new)
- **`drive_property_visits`**: visit state, skip reason, actor, client id. Append-only; state changes are new rows.
- **`drive_issue_checks`**: a per-prior-case `still_present` / `not_present` result, with optional photo, actor and time. Append-only.
- **`drive_reconciliations`**: one per drive run: `policy_version`, inputs watermark, `status` projection.
- **`reconciliation_proposals`**: property, case or observation, proposal type, proposed stage, reason codes, evidence JSON. Immutable.
- **`reconciliation_decisions`**: approve, reject or modify, decided_by, note, one per proposal (a unique constraint). A second-approval row for gated stages.
- **`violation_stage_events`**: an immutable stage history with actor, source (proposal, decision, manual, correction), from and to, and dates. It fixes the missing audit trail. All five stage paths should write to it.
- **`observation_case_links`** (5.5), and a governing-provision reference on violations.
- **Policy versioning:** `community_enforcement_policy_versions` (the ladder, cure days per stage, the board gate per stage, the recurrence rule, fines). It replaces the hard-coded ladder in `escalation.js` and `conventionalNext`. Every proposal records its version.

All tables above are `association_record`, because enforcement evidence and decisions are handed over with the association's records. Exception: AI proposal internals are workpaper, per the CLAUDE.md mixed rule [confirm with Ed].

---

## 6. Edge cases
- **Inspector forgets to select a house:** the photo is unlinked and goes to review. There is no GPS fallback until D15 is fixed.
- **Photo of a neighbor's lot,** or a condition visible from one house but belonging to another: the reviewer relinks; proposals are keyed on the confirmed property.
- **Same condition, different AI label** (trash vs. recycling containers): the alias-expanded canonical category matches it. If the alias isn't confirmed, NEEDS_REVIEW.
- **Two conditions in one photo:** the AI returns one finding today. The reviewer can add a second observation; propose a later AI change to return several findings.
- **A cure deadline falls mid-drive, or the drive spans midnight:** compare against the observation's `captured_at`, not the drive time.
- **Letter drafted but not mailed:** CONTINUE only (the existing `awaiting_first_mail`).
- **Mailed but no proof on a certified case:** NEEDS_REVIEW.
- **Owner changed:** NEEDS_REVIEW [VERIFY].
- **Case at the attorney** (`sent_to_attorney_at`): NEEDS_REVIEW, never auto.
- **Duplicate photos across drives on the same day:** hash flag. One observation per case per day, keeping the existing same-day guard.
- **Offline queue not drained at end of drive:** reconciliation is blocked (5.3).
- **`auto_stale` drive:** no scope-based RESOLVE; explicit checks still count.
- **Seasonal or intermittent conditions** (trash day): category policy may require two observations or a specific time window [policy decision].
- **Demo communities:** they stay excluded, as in the cure-lapse job.

---

## 7. Phased plan

| Phase | Scope | Gate |
|---|---|---|
| **0. Stop the bleeding** | Fix D1 (route-trace updates `last_ping_at`; stale close uses pings; `ended_at_quality`), D2 (paged coverage), D4, D5, D6, D7, D13 (actor on confirm and reject); keep the cure-lapse job **off** (D9) | Separate small approvals; migrations via the owner panel |
| **1. Persisted visits and checks** | `drive_property_visits`, `drive_issue_checks`, the field strip (Still there / Not present), persisted "Done with house", move Advance/Reduce/Mark cured to office-only, a service-worker shell | Ed approves the field UX |
| **2. Stage history and policy versions** | `violation_stage_events` written by all paths; `community_enforcement_policy_versions` seeded from the current hard-coded ladder, with no behavior change; alias-aware index and counts (D8) | Rehearsal plus a production read-only diff |
| **3. Reconciliation (shadow)** | The proposal engine runs after each drive and **only displays** proposals next to the current workflow | Compare proposals with what staff actually did for 2 to 4 weeks |
| **4. Reviewed batch** | Review screen, decisions, two-level approval for certified, fine and self-help; drafts from approved proposals only; GLOBAL_RULES §209 injection (D11) | Counsel review of notice content and gates |
| **5. Retire the old paths** | Remove auto-advance on confirm, the reconcile auto-advance, and the cure-lapse escalation; every change goes through proposals | After phase 4 has been stable |

---

## 8. Test strategy
- **Pure proposal engine, table-driven:**
  - every row of the 5.4 table and every guard;
  - absence without a check gives UNCERTAIN, never RESOLVE;
  - mailed-proof gaps block ESCALATE;
  - owner change, attorney, self-help and certified cases give NEEDS_REVIEW;
  - alias matching;
  - a changed category rule gives NEEDS_REVIEW;
  - recurrence cure days meet the certified floor;
  - the policy version is recorded.
- **Coverage:**
  - paged pings beyond 1,000 (a fixture with 5,000 pings);
  - an out-of-scope property is never "missed";
  - an `auto_stale` drive can't give a scope-based RESOLVE.
- **Ledger rehearsal (PGlite):**
  - proposals, decisions and stage events are append-only;
  - one decision per proposal;
  - a certified approval requires a second approver distinct from the first;
  - the stage CHECK accepts every value the code can emit (fixes the D6 class of bug, following the CLAUDE.md "output accepted by constraint" rule).
- **Letters:**
  - §209 text rendered from GLOBAL_RULES, matched against the gold-standard fixture;
  - the stage-to-template mapping;
  - no letter from an unapproved proposal.
- **Field:**
  - the offline queue for visits and checks;
  - idempotent retries;
  - "Not present" never closes anything without office approval.
- **Health:** extend `lib/enforcement/health.js` with an "open case with no stage event" check and a "proposal older than N days undecided" check.

---

## 9. Decisions and verification

**Ed:**
1. The field strip: are "Still there / Not present" per prior issue acceptable taps, and is a photo required for "Not present" on certified cases?
2. Moving Advance, Reduce and Mark cured to office-only.
3. Who is the second approver for certified, fine and self-help.
4. Bulk-approval limits.
5. The drive-scope model (full, section, or spot list).
6. Treatment of seasonal and intermittent categories.
7. Whether to replace the cure-lapse job entirely.
8. Record-ownership split for AI proposal internals.

**Counsel [VERIFY]:**
1. Chapter 209 notice content and the delivery method per stage (certified mail and what counts as proof).
2. Cure-period minimums per stage.
3. Hearing-request rights and timing.
4. The repeat-violation-within-six-months rule and what counts as the "same" violation.
5. Owner-change handling.
6. Board-approval requirements before fines and self-help.
7. Using AI-proposed classifications with human approval.
8. Evidence retention.

**Engineering (read-only, done here):** D1, D2, D4, D5, D13, D15 and the cure-lapse run state were checked in production with aggregate queries only.
