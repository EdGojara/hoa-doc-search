# Violations Drive Capture and Post-Drive Escalation: Assessment (rev 3)

**Status:** assessment only. No code, migration, deploy, letter sent, violation status changed, or production write. The production checks below were read-only (aggregate counts only; no PII).
**Requested by:** Ed via ChatGPT "PRIORITY SHIFT" instruction, GitHub Issue #1 (2026-09-28 14:34 UTC).
**Revision 3:** adds a mandatory, objective coverage gate (section 5.3) and separates the certified clock's meaning into its own decision (section 5.8), per ChatGPT's review of `4b4c73ef`.
**Revision 2:** applies Ed's operating rule (Issue #1, 2026-09-28 14:35 UTC) per ChatGPT's review of `1a4e5bf9`. The change log is at the end.
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
- **Sections 4 to 10: PROPOSALS.** Nothing in them is built.

---

## 1. Summary

1. **Ed's field workflow is already mostly true.**
   - The inspector selects a house, photographs conditions, and moves on.
   - The inspector picks no category or stage; AI proposes the category.
   - Nothing becomes a violation until an office user confirms it: `AUTO_OPEN_VIOLATIONS_ON_INSPECTION=false` and `AUTO_DRAFT_LETTERS_ON_INSPECTION=false` (`api/inspections.js:36, 46`).
2. **Escalation and resolution are scattered across five paths**, with no single end-of-drive step (section 2.6).
   - An existing read-only reconcile preview already approximates Ed's rule for courtesy cases (section 2.12).
   - But it counts a property as "re-inspected" only if some observation exists there, so a clean house with no photo never qualifies.
3. **Ed's rule, adopted** (section 4): at the end of a **completed** drive, every open **non-certified** case at an **in-scope** property with **no new matching photo** is proposed RESOLVED automatically.
   - No field taps.
   - Safety comes from drive eligibility, declared scope, and property-level exceptions, not from per-issue checks.
   - Every resolution is an auditable, reversible event.
4. **Certified cases never resolve from a missing photo.**
   - The certified 180-day clock exists but is **inconsistent**: three different start dates (section 2.11).
   - **70 of 208 open certified cases have no certified date, and 64 are past 180 days** [prod].
   - Expiry has no mechanics today.
5. **Letters:**
   - The notice stage comes from `current_stage`.
   - **One approval covers every stage** (the `supervisor_approved_*` columns are unused).
   - The §209 wording in the standard letter is **hard-coded**, not from GLOBAL_RULES.
6. **Fix the confirmed data defects first** (section 3), especially drive completion and time (D1) and coverage paging (D2). Ed's rule depends on knowing a drive really completed its scope.

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

### 2.11 Certified status and the six-month clock (as the code has it today)
- **Stage:** `certified_209` (`050:287`). Advancing to it is manual (advance-stage), or through the cure-lapse job (not running), or a recurrence opens there directly (`api/inspections.js:3834-3857`).
- **The window:** 180 days (`CERT_VALID_DAYS`, `lib/enforcement/vantaca_reconcile.js:66`). The origin is Ed's statement: "The certified letters are good for 180 days." (header, lines 4-6). The code doesn't say whether that is statutory or operating practice [VERIFY].
- **The start date is computed three different ways** (inconsistent):
  1. The cert re-inspection tool (`api/enforcement.js:11505-11591`) uses **`violations.certified_notice_date`** (`migration 323`: "Date the certified §209 notice was mailed (postmark)").
     - It was backfilled once from sent `letter_209` postmarks.
     - Staff enter it by hand for Vantaca carryovers (`POST /cert-reinspect/:id/certified-date`, 11605).
     - Null means "needs dating".
  2. The field property panel's cert clock (`api/inspections.js:2535-2555`) uses **`current_stage_started_at || opened_at`**. It never reads `certified_notice_date`.
  3. The Vantaca reconcile (`vantaca_reconcile.js:103-106, 156-162, 210-211`) uses **`current_stage_started_at || opened_at`**, for any status, open or closed.
- **Setting the date:** lock-and-batch and record-mailing **don't** set `certified_notice_date` (section 2.8). New certified notices mailed by trustEd get no date unless staff enter one.
- **Expiry:** display only. The tool shows `days_remaining`, `expires_on` and `expired` (11547-11577); the code comment says "observe until then, else recertify / refer". **No code** recertifies, refers, restarts, closes or alerts at expiry (searched enforcement for cert expiry actions).
- **While live:** the window blocks regression. No courtesy notice can be opened for a pair with a live cert (`vantaca_reconcile.js:227-235`). The reconcile preview and the stale-close tool treat certified as protected (never auto-touched).
- **Field re-checks:** `violation_field_checks` (`322`) records `not_cured` or `cured` per check. A `cured` result does **not** close the case. There are **0 rows** in production [prod].
- **Production:** 208 open certified; 138 with `certified_notice_date`; 70 undated; **64 dated more than 180 days ago and still open** [prod].
- **Separate six-month rule:** `detectRecurrence` (`find_or_continue_violation.js:47, 63-100`) uses a **183-day** look-back for a *new occurrence after a cure* (the §209.006(d) note in code). This is a different clock from the certified window [VERIFY].

### 2.12 Existing reconcile preview (closest current approximation of Ed's rule)
`GET /api/enforcement/reconcile` (`api/enforcement.js:5103-5222`) is read-only. `POST /reconcile/apply` (5245) applies it.
- **Candidates:** only open courtesy_1/2 cases with `source` `trustEd_native`, excluding certified, fine and self-help (`_SELF_HELP_SLUGS`, 5116).
- **Its CURE rule:** the property was "re-inspected" (**any observation at the property** after `opened_at` + 2 days, within `window_days`, default 60), and the category was not re-flagged.
- **Its ESCALATE rule:** re-flagged in a later drive, and 10 days or more at the current stage (Ed 2026-09-15).
- **What it lacks for Ed's rule:**
  - No drive completion or scope: "inspected" means *an observation exists*, so a house photographed only for a clean pass has no observation (clean AI results are rejected) and never counts. A house with no photo at all never counts either.
  - No per-drive audit event, and no reversal.
  - Windows are by days, not by drive.

## 3. Defects

| # | Defect | Status | Evidence | Why it matters here |
|---|---|---|---|---|
| D1 | Stale-drive job may set `ended_at = started_at + 4h` mid-drive | **confirmed** | Job runs in prod (last run today). 20 drives carry its auto-close note; 6 end exactly at start + 4 h; 137 of 149 drives have null `last_ping_at`; 23 of 60 sampled null-ping drives do have GPS traces [prod]. The Inspect tab never updates `last_ping_at` (`api/inspections.js:2170` vs 4946) | Drive windows (and "was this house in scope?") are unreliable |
| D2 | GPS coverage reads capped at 1,000 pings | **confirmed** | 15 of the last 60 drives exceed 1,000 pings (max 5,149) [prod]; `/:id/coverage` and `/live` are unpaged | Undercounts coverage, so "not covered" becomes wrong |
| D3 | "Mark clean" isn't persisted | **confirmed (code)** | Client memory only (19986-20006) | Superseded by the automatic property-visit record (5.2); no field tap needed |
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

## 4. Ed's operating rule, and how it is made safe

**The rule (Ed, Issue #1, 2026-09-28 14:35 UTC; it supersedes rev 1's UNCERTAIN default):**
- At the end of a **completed** violations drive, a prior **open, non-certified** case that got **no new matching photo** in that drive is resolved.
- The field team does not mark negative observations, tap "Not present", or resolve ordinary cases by hand.
- The field action stays: **select the property, photograph conditions that are still present, move on.**
- **Certified cases never resolve from a missing photo.** They need a manual resolution and follow their own six-month clock (sections 2.11 and 5.8).

**What makes the rule safe is not per-issue taps.** It is four drive-level and property-level conditions, all derived automatically:
1. **The drive is completed and eligible:**
   - ended by a user, not auto-closed by the stale job;
   - upload queue drained;
   - every photo linked and AI-analyzed;
   - every observation at in-scope properties reviewed.
2. **The property was covered:** it is in the drive's declared scope, **and** either it was photographed on this drive, or the drive's GPS route objectively passed it (the **completion gate**, section 5.3). Tapping End Drive never makes an uncovered property count as inspected.
3. **There is no unresolved exception at that property** (section 5.5). Exceptions block only the affected property, never the whole community, and are never the default for an ordinary no-photo case.
4. **The case is eligible:** open, non-certified, opened before this drive started, and not in an excluded class (section 5.4).

When all four hold, the case gets a **RESOLVE** proposal automatically. Whether it is applied at drive completion or at batch approval is Ed's decision (section 5.6).

---

## 5. Proposed design

### 5.1 Principles
1. **Field = photos of conditions that are present.** No stage, category, escalation, negative-observation or per-issue decisions in the field.
2. **One reconciliation, after the drive,** against the full history and the community policy version.
3. **Ordinary no-photo cases resolve** (Ed's rule). Exceptions are specific and property-scoped.
4. **Certified and later stages never resolve without a person.**
5. **Every automated resolution is an auditable, reversible event.**
6. **Escalations and letters still need human approval.** Certified, fine and self-help notices need a second, distinct approver.
7. **Statutory wording comes from GLOBAL_RULES only** (fixes D11). [VERIFY] content with counsel.

### 5.2 Field capture (unchanged workflow, small reliability additions)
- **Unchanged:** select the house, take photos (single or wide-plus-close), move on. There are no new taps per house or per issue.
- **Removed from the field modal:** Advance stage, Reduce stage, Add prior violation, and Mark cured become office-only. The field panel can still *show* prior cases and the certified clock (read-only), so the inspector knows to photograph a condition that is still there.
- **Automatic property-visit record:** when a photo is taken for a house, the system records that the house was photographed on this drive. This needs no tap, and it replaces the in-memory "Mark clean".
- **Offline:**
  - a service-worker app shell for the Inspect tab;
  - the queue already persists photos;
  - **End drive** reports the device's queue count, and a drive can't complete while its queue is non-empty.
- **Duplicates:** a perceptual hash plus an exact sha256 on upload. Duplicates within the same property and drive are flagged for review, never dropped.

### 5.3 Drive scope: knowing which properties were inspected
The inspector picks a scope when starting the drive. Default: **full community**.

| Scope type | How it's declared | Properties in scope |
|---|---|---|
| **Full community** | Default at start | All properties of the community |
| **Section** | Pick saved sections (street list or drawn polygon, stored per community) | Properties in those sections |
| **Spot list** | A list (e.g. certified re-checks, a complaint list) | Exactly those properties |

**Coverage and completion gate** (mandatory for every drive that can auto-resolve; no per-property or per-issue taps):
- **A property is `covered` on this drive** if either:
  - (a) **Photo:** it has a linked photo from this drive. It is deemed visited by its photo, **even if GPS failed.**
  - (b) **GPS pass:** at least one accepted ping from this drive lies within **D metres** of the property's location (`properties.latitude/longitude`, cluster-validated).
    - Pings come from the **fully paged** route (`inspection_route_traces`; requires D1 and D2).
    - Accepted pings have `accuracy_m` ≤ A.
    - D and A are policy values; the suggested defaults are D = 50 m (the existing coverage default) and A = 50 m.
- **Only covered, in-scope properties are eligible for auto-RESOLVE.**
  - An in-scope property that is **not covered** gets **no resolution and no per-issue flag**.
  - Its ordinary cases simply stay open and carry forward to the next drive.
  - It appears once, as a line in the drive's **coverage gaps** list (grouped by street).
- **Route interruptions:**
  - Gaps in the ping stream (more than T seconds, or a jump of more than J metres between consecutive accepted pings) are **not interpolated**.
  - Properties along a gap are covered only by photo or by other pings.
  - So a half-driven community resolves only the half actually driven.
- **Drive-level completion summary**, shown before any resolution applies:
  - in-scope count; covered by photo; covered by GPS; not covered;
  - coverage %;
  - GPS quality (ping count, gaps, median accuracy).
- **When coverage of a full-community or section drive is below a threshold C** (policy, e.g. 90%), the reviewer must do one of these before resolutions apply. Both are drive-level choices, not per-property taps:
  - (i) **narrow the scope** to the sections actually driven (the map suggests the sections whose properties are mostly covered), or
  - (ii) **accept as partial**: covered properties resolve normally, and the uncovered ones carry forward.
- **GPS unavailable for the whole drive** (permission denied, device failure):
  - Photographed properties are covered by photo, and their ordinary cases without a matching photo resolve.
  - **Properties with no photo are not covered, so they don't resolve.**
  - Optional (Ed's decision; off by default): a reviewer may record a **street-level coverage attestation** for the drive ("drove Oak Bend and Elm Ct; GPS failed"), with a reason. It is audited and needs a second person. It is still drive-level, never per-issue.
- **Spot-list scopes** use the same rule: each listed property must be covered by photo or GPS.
- **Stored per drive:** `drive_property_coverage` (property, `method` = photo, gps, attested or none, `min_distance_m`, `ping_count`, gap flags). Every resolution event cites its property's coverage record.

**A property outside the declared scope** is simply not part of the drive. Its cases aren't resolved and aren't flagged; they wait for a drive whose scope includes them.

**Stored as `drive_scopes`** (inspection, scope type, section or list reference, property snapshot at drive start), so the audit shows exactly which properties the drive covered.

### 5.4 Reconciliation matrix (per in-scope property, completed eligible drive)
First, all observations at the property must be reviewed (confirmed, relabeled or rejected). Then each case and observation gets exactly one proposal:

| Case or observation | Condition | Proposal |
|---|---|---|
| Open non-certified case (courtesy_1/2) | **No matching photo** this drive, no exception at the property | **RESOLVE** (auto-proposed; section 5.6 for apply timing) |
| Open non-certified case | Matching photo, cure deadline not passed or prior notice not yet mailed | **CONTINUE** (continuation evidence) |
| Open non-certified case | Matching photo, cure deadline passed, prior notice **mailed with proof** | **ESCALATE** to the policy's next stage (courtesy_1→2 is routine; courtesy_2→certified needs the section 5.6 second approval) |
| Open **certified or fine** case | Matching photo | **CERTIFIED_STILL_PRESENT**: continuation plus a "not cured as of" evidence record; no letter; the clock is unchanged (section 5.8) |
| Open **certified or fine** case | No matching photo | **NO CHANGE.** Stays open. Shown in the certified work list as "not photographed this drive" for information; **never resolved** |
| New confirmed observation | No open case for its canonical category | **NEW** at the policy's opening stage (a recurrence within the look-back gets the recurrence path; [VERIFY] the six-month rule) |
| Any | Ambiguous match (section 5.5) | **NEEDS_REVIEW** for that case only |

**What counts as a "matching photo":**
- a reviewed, confirmed observation at the property on this drive;
- whose canonical category (alias-expanded, confirmed aliases only) equals the case's canonical category;
- and whose case category rule hasn't changed since the case opened.
A photo of a *different* issue at the same property doesn't block RESOLVE for the prior case.

**Cases excluded from auto-RESOLVE:**
- **Opened on this same drive,** or within the existing 2-day re-inspection gap (`api/enforcement.js` reconcile, `REINSPECT_GAP_MS`), so a new case isn't treated as prior.
- **Self-help / 10-day categories** (`_SELF_HELP_SLUGS`). The current reconcile protects these. **Ed's decision:** treat them like ordinary non-certified cases, or like certified. Until Ed decides, they are proposed excluded.
- **Vantaca-carryover courtesy cases** (`source` is not `trustEd_native`). The current reconcile excludes these. **Ed's decision** whether his rule covers them.
- **Cases at the attorney** (`sent_to_attorney_at`), or with a legal flag. These are always manual.

**Unmailed drafts:** if a resolved case has an unsent draft letter, that draft is dropped. This reuses the existing stale-letter guard; nothing is mailed for a resolved case.

### 5.5 Exceptions (block resolution for the affected property only)
- **Unlinked photo** from this drive:
  - with GPS: block the properties within the match radius;
  - without GPS: block the drive's RESOLVE batch until the photo is linked.
- **Upload queue not drained, or AI analysis pending,** on photos from this drive: the drive isn't complete.
- **Observation not yet reviewed** at the property.
- **Ambiguous match:**
  - AI confidence low;
  - category in an *unconfirmed* (AI-suggested) alias relation to the case's category;
  - two open cases that could match one photo;
  - duplicate-photo flag;
  - photo linked to a different house by the reviewer.
- **Not covered:** no photo and no qualifying GPS pass (section 5.3). The property's ordinary cases carry forward. This is a single coverage-gap line per property, not a per-violation exception.
- **Drive auto-closed** (`ended_at_quality = auto_stale`) or otherwise not ended by a user: the drive is **not eligible** for auto-RESOLVE until a person confirms it was completed.

Each exception names its reason. Clearing it (linking the photo, reviewing the observation, confirming the drive) re-runs reconciliation for that property.

### 5.6 Review screen, apply timing, approvals
**The drive review screen:**
- **Summary line,** for example: "Full community, 1,171 properties, completed 3:42 PM. RESOLVE 41, CONTINUE 22, ESCALATE 9, NEW 14, certified still present 6, certified not photographed 12, exceptions 3".
- **RESOLVE list:** grouped by street, each row showing the prior case, its last photo, and the stage. **One action approves them all.** Individual rows can be excluded with a reason.
- **Exceptions list** with the fix action for each.
- **ESCALATE and NEW** items, with photos next to the prior case photo.

**Apply timing for ordinary RESOLVEs** is **Ed's decision.** It isn't assumed:
- **(A) At drive completion.** Resolutions apply automatically as soon as the drive is complete and has no exceptions. The review screen then shows them as already applied, with Reverse.
- **(B) At batch approval.** Applied when the reviewer clicks "Approve all resolutions", the same moment the letter batch is approved.

Recommendation: (B) initially, then (A) once the shadow period (Phase 3) shows proposals matching what staff would do.

**Letters and escalation gates:**
- Courtesy notices: one approval.
- Certified, fine and self-help notices: a **second approval by a different designated approver** (putting the unused `supervisor_approved_*` to use; fixes D10).
- Board approval where the community's documents require it [VERIFY].

**Order after approval:**
1. state-change events;
2. letters locked and queued;
3. mailing proof sets the cure dates (existing lock-and-batch / record-mailing).
Mailing still never changes the stage.

### 5.7 Audit and reversibility
**`violation_resolution_events`** (immutable), written for every automatic or approved resolution:
- `violation_id`, `inspection_id` (the completed drive), `drive_scope_id`, `property_id`;
- `evidence`: `{no_matching_photo: true, photos_at_property: N, property_in_scope: true, coverage: {method: photo|gps|attested, min_distance_m, ping_count}, exceptions: []}`;
- `policy_version`, `rule` (`completed_drive_no_photo`);
- `prior_stage`, `prior_stage_started_at`, `prior_cure_period_ends_at`;
- `actor` (`system` + the approving user for option B, or `system` for option A).

**`violation_stage_events`** (immutable) records every stage change from every path, with actor and source. This fixes the missing history.

**Reverse a mistaken closure:** `reverse_resolution(resolution_event_id, reason, by)`.
- It restores the case to open at its prior stage and dates, and writes a reversal event.
- It never deletes the original event.
- The UI offers it from the case, the drive review screen, and any later drive where the same condition is photographed.

**A condition photographed again after an auto-resolution**, on a later drive:
- The reviewer sees "resolved by drive X on date, no photo".
- The reviewer chooses either **reverse** (the condition was missed, so the case continues at its prior stage) or **NEW** (a genuinely new occurrence).
- The default suggestion depends on elapsed time and is **Ed's policy decision**. [VERIFY] the §209 six-month repeat-violation treatment, and whether a reversed case's cure period needs a fresh notice.

### 5.8 Certified lifecycle (separate from ordinary cases)
**What exists today** (section 2.11):
- a 180-day window, `CERT_VALID_DAYS`;
- **three different start dates** in three places;
- display-only expiry, with no recertify, refer or restart mechanics;
- 70 of 208 open certified cases undated;
- 64 of them already past 180 days while still open [prod].

**Proposed lifecycle** (mechanics marked as open questions; nothing is assumed):
1. **Enter certified:** when the certified notice is mailed, `certified_notice_date` is set from the postmark by lock-and-batch and record-mailing. Today only the cert-reinspect tool sets it (fixes the gap).
2. **One clock source:** everything reads `certified_notice_date`: the cert-reinspect page, the field panel (`api/inspections.js:2535-2555`), and the Vantaca reconcile (`lib/enforcement/vantaca_reconcile.js`).
   - A case without a date shows **"needs dating"**. It is never computed from `current_stage_started_at`.
3. **On each drive:**
   - Matching photo: continuation plus a `violation_field_checks` `not_cured` record written automatically from the photo, as evidence for the board-only "not cured as of" report.
   - No photo: no change.
4. **Resolution:** **manual only**, by an office user with a reason (and a photo if Ed requires one). It uses the one unified resolve endpoint (fixes D12).
5. **Start date going forward:** unify on the **actual postmark** for newly mailed certified notices (set at lock-and-batch and record-mailing). Existing dates are **not** rewritten. Undated carryovers stay "needs dating" until staff enter the real date.
6. **No automatic expiry or closure.** The 64 open cases dated more than 180 days ago, and every other certified case, stay open until a person acts. The 180-day certified window and the separate **183-day repeat-violation look-back** (`detectRecurrence`) are **different rules** and are never merged.
7. **Window expiry, the operational meaning** (a separate decision for Ed and counsel; the code has no behavior today):
   - What happens at expiry? The options noted in code comments are "recertify / refer", i.e. send a new certified notice, refer to the attorney, or board review. Who decides, and is there a deadline?
   - Does the clock ever restart without a new certified notice, for example after a hearing or a board action?
   - What does the "six-month clock" govern legally, versus Bedrock's operating practice (Ed: "certified letters are good for 180 days", `vantaca_reconcile.js:4-6`)? [VERIFY]
   - How are certified cases handled after an ownership change? [VERIFY]
8. **Work list:** the existing "Certified §209 cases" view (enforcement around 11256, 11505-11591) becomes the single certified queue, sorted by days remaining, with expired and undated cases at the top.

### 5.9 Data model (minimal, all new, immutable where marked)
- `drive_scopes` (with a property snapshot).
- `drive_property_visits` (automatic, from photos).
- `drive_reconciliations` (one per drive: `policy_version`, inputs watermark).
- `reconciliation_proposals` (immutable).
- `reconciliation_decisions` (immutable; one per proposal; a second approval row for gated stages).
- `violation_resolution_events` and `violation_stage_events` (immutable).
- `observation_case_links`.
- `community_enforcement_policy_versions`: the ladder, cure days per stage, gates, the recurrence rule, the auto-resolve settings (apply timing A or B, coverage-gate values D/A/T/J/C and attestation allowed, self-help and carryover inclusion), and the certified window.
- **Record ownership:** `association_record` for enforcement evidence, decisions and events. AI proposal internals are workpaper [confirm with Ed].

---

## 6. Separate lifecycles

**Regular (courtesy) case:**
```
NEW (confirmed observation) -> courtesy_1 --(mailed, cure lapses, matching photo on later drive)--> ESCALATE -> courtesy_2
   any open courtesy case on a completed in-scope drive with NO matching photo -> RESOLVE (auto-proposed; applied per 5.6 A/B)
   courtesy_2 + matching photo after cure lapse -> ESCALATE proposal to certified (second approver) 
   RESOLVED --(missed? condition photographed later)--> reviewer: REVERSE (reopen at prior stage) or NEW occurrence
```

**Certified (or fine) case:**
```
certified_209 (certified_notice_date = postmark) 
   each drive: matching photo -> continuation + not_cured field check (evidence); no photo -> no change
   resolution: MANUAL ONLY (reason; photo if required)
   day 180: expiry handling = OPEN QUESTION (recertify / refer / board) - no current mechanics
   fine_assessed: board/fine rules; never auto
```

---

## 7. Edge cases
- **Inspector forgets to select a house:** the photo is unlinked, which is an exception for the nearby properties until it's linked. There is no GPS fallback until D15 is fixed.
- **The condition was present but the inspector didn't photograph it:** the case auto-resolves under Ed's rule. The reversal path (5.7) covers it when a later drive finds it. The mandatory coverage gate prevents the "street skipped" variant: a street the route never passed stays uncovered and nothing on it resolves.
- **Photo of a different issue at the same house:** it doesn't block RESOLVE of the prior case. It becomes a NEW proposal.
- **AI labels the same condition differently:** a confirmed alias counts as a match. An unconfirmed alias or low confidence is an exception for that case.
- **A case opened on this drive:** excluded (the 2-day gap).
- **A drive started, then the tablet died, and the stale job closed it:** not eligible for auto-RESOLVE until a person confirms the drive was completed.
- **Offline photos uploaded after "End drive":** the drive can't complete until the queue is drained, which the device reports. Late photos re-run reconciliation for their property.
- **GPS off for the whole drive:** only photographed properties are covered, so no-photo cases elsewhere carry forward (unless Ed enables the audited street-level attestation).
- **GPS drops mid-drive:** properties along the gap aren't covered unless photographed. The coverage summary shows the gap.
- **Team ends after half the streets:** the uncovered half carries forward. Below threshold C, the reviewer narrows the scope or accepts the drive as partial before anything resolves.
- **Poor GPS accuracy** (urban canyon, tree cover): pings with accuracy worse than A are ignored, so affected properties are covered only by photo.
- **Two drives in one community on the same day,** with different sections: each reconciles its own scope. Overlapping scopes: a matching photo from either drive counts, so RESOLVE waits until both are complete.
- **Owner changed since the notice:** the case still resolves on no photo under Ed's rule. Escalation on a new owner goes to NEEDS_REVIEW [VERIFY].
- **Resolved case with an unmailed draft:** the draft is dropped. A resolved case with a letter mailed earlier keeps it in its history.
- **Demo communities:** excluded, as the cure-lapse job already does.

---

## 8. Phased plan

| Phase | Scope | Gate |
|---|---|---|
| **0. Fix confirmed defects** | Fix these first: D1 (route-trace updates `last_ping_at`; `ended_at_quality`); D2 (paged coverage); D4; D5; D6; D7; D13 (reviewer and actor on confirm and reject). Keep the cure-lapse job **off** (D9). Set `certified_notice_date` at mailing, and one certified clock source | Small separate approvals; migrations via the owner panel |
| **1. Scope and visits** | `drive_scopes` (full, section, spot), **coverage gate (`drive_property_coverage`)**, automatic property visits, End-drive queue check, service-worker shell; remove Advance, Reduce, Add prior and Mark cured from the field modal (office-only) | Ed approves |
| **2. History and policy** | `violation_stage_events` from all paths; resolution events plus reversal; `community_enforcement_policy_versions` seeded from the current hard-coded ladder, with no behavior change; alias-aware index and counts (D8) | Rehearsal plus a production read-only diff |
| **3. Reconciliation (shadow)** | The engine runs after each drive and **only displays** proposals, including RESOLVE, next to what staff actually do | 2 to 4 weeks comparing proposals with actual staff actions |
| **4. Apply** | RESOLVE applied per Ed's choice (A or B), with reversal; ESCALATE and NEW through review; second approver for certified, fine and self-help; drafts from approved proposals; GLOBAL_RULES §209 injection (D11) | Counsel review of notice content and gates |
| **5. Certified workflow** | Single certified queue; automatic `not_cured` checks from matched photos; expiry handling once Ed and counsel define it | Ed and counsel answers (5.8 item 5) |
| **6. Retire the old paths** | Remove auto-advance on confirm, reconcile auto-advance, the cure-lapse escalation, and the duplicate resolve endpoint | After phase 4 has been stable |

---

## 9. Test strategy
- **Pure reconciliation engine, table-driven:**
  - completed in-scope drive plus a non-certified case with no matching photo gives **RESOLVE**, with no tap required;
  - a certified or fine case with no photo gives **no change**, never resolve;
  - a matching photo gives CONTINUE or ESCALATE by cure and mailing proof;
  - a different-issue photo doesn't block RESOLVE;
  - a case opened on this drive is excluded;
  - self-help and carryover cases follow the configured inclusion;
  - an unlinked photo, pending AI, an unreviewed observation, an ambiguous alias, a duplicate flag, each block **only that property**; an uncovered property carries forward;
  - an out-of-scope property is untouched;
  - an `auto_stale` drive is ineligible;
  - the policy version is recorded;
  - there is **no default UNCERTAIN** for ordinary no-photo cases.
- **Coverage gate:**
  - photo gives covered even with zero pings;
  - GPS pass within D with accuracy ≤ A gives covered;
  - a ping gap is not interpolated;
  - an uncovered in-scope property never resolves;
  - a half-route fixture resolves only the covered half;
  - below C, resolution is blocked until the scope is narrowed or the drive accepted as partial;
  - GPS-off drive: only photographed properties resolve;
  - the 5,000-ping fixture is fully paged.
- **Reversal:**
  - a reversed resolution restores the prior stage, stage start and cure dates;
  - the original event is kept;
  - a later matching photo offers REVERSE or NEW.
- **Scope and coverage:**
  - property snapshot at drive start;
  - section and spot scopes;
  - the coverage gate with a 5,000-ping fixture (paged).
- **Certified clock:**
  - every surface reads `certified_notice_date`;
  - undated shows "needs dating";
  - the date is set at mailing;
  - expiry is displayed without automatic action.
- **Ledger rehearsal (PGlite):**
  - proposals, decisions, resolution and stage events are append-only;
  - one decision per proposal;
  - a distinct second approver for certified, fine and self-help;
  - the stage CHECK accepts every value the code can emit (D6 class).
- **Letters:**
  - GLOBAL_RULES §209 text matches the gold-standard fixture;
  - no letter from an unapproved proposal;
  - a resolved case's unsent draft is dropped.

---

## 10. Decisions and verification

**Ed:**
1. When ordinary RESOLVEs apply: **(A) automatically at drive completion**, or **(B) at batch approval** with one click (5.6).
2. Coverage-gate values: pass distance D, ping accuracy A, gap limits T and J, and the full-scope threshold C. Also whether the audited street-level attestation is allowed when GPS fails. (The gate itself is mandatory.)
3. Drive scopes: full community by default, plus sections and spot lists; who defines sections.
4. Whether self-help / 10-day categories follow the ordinary rule or the certified rule.
5. Whether Vantaca-carryover courtesy cases follow the ordinary rule.
6. What happens when a resolved condition is photographed again: the default suggestion (reverse vs. NEW) by elapsed time.
7. Certified: a photo required on manual resolution? **Separately, the operational meaning of the 180-day window** (what happens at expiry; any restart), decided with counsel. No automatic expiry or closure in any case.
8. Moving Advance, Reduce, Add prior and Mark cured to office-only.
9. The second approver for certified, fine and self-help.
10. Record-ownership split for AI proposal internals.

**Counsel [VERIFY]:**
1. Chapter 209 notice content and delivery per stage; certified proof.
2. Cure minimums.
3. Hearing rights.
4. The six-month repeat rule and the "same violation" definition, including after an auto-resolution and a later sighting.
5. The meaning of the 180-day certified window and the expiry options.
6. Owner-change handling.
7. Board approval before fines and self-help.
8. Closing ordinary cases from a documented completed drive with no re-sighting (evidence and records).

**Engineering (read-only, done here):**
- D1, D2, D4, D5, D13 and D15, the cure-lapse run state, and the certified clock data (208 open certified; 138 dated; 64 dated more than 180 days ago; 0 field checks) were all checked in production with aggregate queries only.

---

## Change log
**rev 3 (2026-09-28):** ChatGPT review of `4b4c73ef`.
- The mandatory coverage and completion gate: a property is covered by a photo on this drive, or by a fully paged GPS pass within D metres at accuracy ≤ A.
- Route gaps are not interpolated. Uncovered in-scope properties carry forward, without resolution or per-issue flags.
- Below the full-scope threshold C, the reviewer narrows the scope or accepts the drive as partial.
- GPS-off drives resolve only photographed properties; an optional audited street-level attestation is an Ed decision.
- Certified: the start date is unified on the actual postmark for new mail only. No automatic expiry or closure of the 64 older cases. The 180-day window and the 183-day repeat look-back are kept distinct. The window's operational meaning is a separate Ed and counsel decision.

**rev 2 (2026-09-28):** ChatGPT review of `1a4e5bf9`, applying Ed's correction (Issue #1, 14:35 UTC).
- Removed per-issue "Still there / Not present" taps, the positive-absence requirement, the blanket UNCERTAIN default, and "RESOLVE only with check".
- Ordinary non-certified cases with no matching photo on a completed, in-scope drive are **auto-proposed RESOLVE**. Apply timing (A or B) is Ed's decision.
- Certified and fine cases never resolve from a missing photo.
- Mapped the certified clock precisely (2.11): three inconsistent start dates, display-only expiry, 70 undated, 64 past 180 days.
- Added drive scope (full, section, spot), property-scoped exceptions, the drive-eligibility rules, auditable resolution events with reversal, and separate lifecycles.
- Documented the existing reconcile CURE logic (2.12).
- Updated the matrix, screen, phases, tests and decisions to match.
- Separated from the `user_profiles` verification script (branch `chore/verify-user-profiles-privileges`).

**rev 1 (`1a4e5bf9`):** initial assessment. Did not incorporate Ed's 14:35 correction, which was posted before rev 1's reply and missed.
