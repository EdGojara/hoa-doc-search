# Employee Portal and Timekeeping: Architecture Assessment

**Status:** assessment only. No code, migration, deploy, or change to employee pay or status.
**Requested by:** Ed via ChatGPT instruction, GitHub Issue #1 (2026-09-28 11:53 UTC).
**Kept separate from:** `feat/trusted-pay-terms` and its pending pricing and migration-470 decisions.
**Branch:** `docs/employee-timekeeping-assessment` (docs only).

> **Legal notice.** This is an engineering assessment, not legal advice. Every wage-and-hour point below is marked **VERIFY**. Each needs current federal and Texas verification and review by employment/payroll counsel before any policy takes effect. That covers classification, overtime, meal periods, off-the-clock work, recordkeeping, notices, and any existing agreements. Nothing here is a legal conclusion.

**Legend.**
- **[VERIFIED]:** read in the current code, with a path cited.
- **[PROPOSAL]:** not built.
- **[VERIFY]:** a legal or policy question for counsel or Ed.

---

## 1. Summary

1. **Nothing in trustEd measures time worked today.** [VERIFIED]
   - There is no timesheet, punch, payroll, overtime, or meal model. Searches for timesheet, clock_in, punch, payroll, pay_period, overtime, time_entr, hours_worked, time_spent found nothing relevant.
   - The only "hourly" concepts are community billing rates (`migrations/002_bedrock_billing.sql:68`) and vendor rates.
2. **Login sessions are useless as time evidence, and the design must never use them.** [VERIFIED]
   - The staff gate cookie is a signed timestamp with no user identity. It lasts 30 days with no sliding renewal (`server.js:429-430`, `614-626`; `api/_require_admin.js:4-5`).
   - The Supabase browser session persists in localStorage and auto-refreshes (`public/index.html:378`, created with no options).
   - No idle timeout exists.
   - This matches Ed's observation that employees stay logged in.
3. **Staff identity exists but is thin.** [VERIFIED]
   - `user_profiles` (`migrations/039_user_profiles.sql:17-28`) holds id, management_company_id, email, full_name, role (`admin`/`staff`/`assistant`), is_active, and last_sign_in_at.
   - There are no employee fields: no department, manager, hire date, pay type, or FLSA status.
4. **A security gap must be fixed before any approval workflow relies on roles.** [VERIFIED in repo]
   - `migrations/039_user_profiles.sql:33` grants `SELECT, INSERT, UPDATE, DELETE ON user_profiles TO authenticated`.
   - No migration enables row-level security on it.
   - The Supabase anon key reaches the browser (`server.js` ~11025).
   - A signed-in staffer could likely edit their own `role` directly through the Supabase REST API.
   - Production state still needs a read-only check. I've proposed it as a separate task.
5. **Violations drives already record start, end, and pauses, but not who did the work.** [VERIFIED]
   - `inspections` stores one `operator_id` and a free-text `device_label`.
   - Photos have no capturer field.
   - The front end sends an empty body on observation confirm, so the reviewer is never recorded.
   - Two likely data bugs corrupt drive timing today (section 5.4).
6. **Recommendation.** [PROPOSAL]
   - Build a small, Bedrock-scoped, append-only punch ledger, with employee and manager views, a correction workflow, overtime pre-approval, meal-period attestations, and period lock plus payroll CSV.
   - Then add per-person drive participation, so labor-hours per drive come from punches, not logins.
   - Stage it so that nothing touches pay until counsel signs off and Ed sets the effective date.

---

## 2. What exists today

### 2.1 Authentication, users, roles [VERIFIED]

**Staff sign-in:**
- Microsoft through Supabase OAuth: `public/login.html:246-254`.
- `POST /api/auth/exchange-supabase-session` requires an active `user_profiles` row and sets the gate cookie (`server.js:763-815`).
- A shared-password fallback also exists: `POST /api/staff-login` (`server.js:711-730`).

**Two layers:**
- A global gate cookie (`server.js:639-657`) only proves "some staffer".
- Per-endpoint Supabase JWT checks (`api/_require_admin.js:17-34`) identify the person:
  - `requireStaff`: lines 51-58;
  - `requireAdmin`: lines 38-45;
  - `requireOwner`: lines 63-72; admin plus `OWNER_EMAIL`.
- `api/_acting_user.js` (`requireActingUser`) is the shared "who did this" helper.

**Sign-out:**
- `authSignOut()` (`public/index.html:442-445`) signs out of Supabase but does not clear the gate cookie.
- `/staff-logout` (`server.js:733-739`) is separate.
- Deactivating a user blocks JWT calls (`_require_admin.js:29`) but not an existing gate cookie.

**Tables and rosters:**
- **`user_profiles`:** described in 1.3.
  - The `handle_new_user` trigger makes the first user admin and everyone after it staff, for any new auth user (`039:37-62`).
  - I found no email-domain restriction.
- **`portal_users`** (`078`, roles updated in `201_portal_manager_role.sql:24-27`) are homeowner, board and portal identities, not the staff directory.
- **`portal_manager_scope`** (`201:35-47`) maps portal managers to communities.
- **`management_companies`** (`001_foundation.sql:39-50`); Bedrock is `00000000-0000-0000-0000-000000000001`.
- **Code-only rosters:**
  - `lib/bd/people.js` is a business-card roster.
  - `lib/team/roster.js` holds the AI personas.

**Org scoping:**
- `management_company_id` exists on `user_profiles` and `communities`.
- The JWT-claim RLS policies in `001` are effectively unused, because the API uses the service role. Scoping is enforced in endpoint code.

**Staff-to-community assignment:** no table.
- The closest are free-text `work_items.assigned_to` (`256_work_items.sql:32`) and `homeowner_threads.assigned_staff_id` (`161:69`).

**Departments, teams, org chart, presence:** not found.

### 2.2 RLS and grants posture [VERIFIED]
- Only 16 of 473 migrations enable RLS.
- The current pattern for sensitive tables is: enable RLS, `REVOKE ALL ... FROM PUBLIC, anon, authenticated`, then grant to `service_role` only. Examples: `469:63-65`, `468:30-31`, `467:782-785`.
- Timekeeping tables should follow this pattern, with all access through server endpoints.

### 2.3 Audit and immutability patterns to reuse [VERIFIED]
- **Append-only by trigger:**
  - `community_budget_events_append_only()` (`462_budget_approved_lock.sql:46-54`);
  - `ownership_tenures_guard()` (`456:68-90`);
  - `migration_attempts_append_only()` (`lib/migrations/apply_one.js:239-250`).
- **Lock with a reasoned reopen.** This is the closest analog for a locked pay period (`462`):
  - `community_budgets_lock_guard()` and `budget_line_items_lock_guard()`;
  - a session-flag bypass;
  - `reopen_community_budget(p_budget_id, p_reason, p_by)`, which requires a reason and an actor and is service-role only.
- **Before/after change log:** `journal_entry_edits` (`280:33-42`), with `changes JSONB {field:{before,after}}`, the editor, and a reason.
- **Actor from the JWT, never the request body:** `119_user_audit_attribution.sql`.
- **Approval trail:** `ap_invoice_approvals` (`175:187-208`), with an action enum, user id and a name snapshot.

### 2.4 Time, activity, tasks [VERIFIED]
- **No staff activity log.** Searched: friction, login_events, staff_activity, page_view, activity_log, last_active.
- **`calendar_events`** (`348`) has `vacation`/`sick`/`holiday` types with free-text times. It is tagged workpaper and allows hard DELETE. It is a PTO calendar, not a timekeeping record.
- **`work_items`** (`256`) backs the Team Status board: assignee as free text, status, `received_at`, `sla_due_at`, `completed_at`. There is no start time and no time spent.
- **`vendor_projects` / `project_milestones`** (`321`, `338`) have owners and dates only.

### 2.5 Violations drives [VERIFIED]
- **`inspections`** (`050_drv_and_memory_foundation.sql:156-172`).
  - Columns: `started_at`, `ended_at`, `status`, `mode`, and one `operator_id` (UUID, no foreign key).
  - Later additions: `device_label` (the driver's name as text), `last_ping_at`, and start/end offices (`165:82-89`).
  - Status `paused` and `inspection_pause_segments` (`211`) record pause and resume times; `paused_by` is a text email.
- **Endpoints** (all in `api/inspections.js`):
  - start: `POST /api/inspections` (line 107);
  - resume within 12 hours by community plus device label (118-143);
  - pause and resume (470, 505);
  - `GET /:id/time-on-drive` (541), which returns active time = end − start − pauses.
- **GPS:** `inspection_route_traces` (`052`), one ping about every 4.5 s, batched every 30 s (`public/index.html:22523, 22555`).
- **Photos:** `inspection_photos` (`050:190`) has `captured_at` and `created_at` but **no capturer column** (insert at `api/inspections.js:722-737`).
- **Observations:** `property_observations` (`050:226`) has `reviewer_user_id` and `reviewed_at`.
  - Confirm is at `POST /observations/:id/confirm` (3607) and goes through `findOrContinueViolation`.
  - The front end posts an empty body (`public/index.html:24598, 24691`), so **`reviewer_user_id` is always null** and only `reviewed_at` is usable.
- **Violations and letters:**
  - violations carry `opened_by_user_id`;
  - `interactions` carries `created_at`/`printed_at`/`mailed_at` plus approver and sender ids (`119:77-79`).
- **One person per drive:**
  - There is no table assigning people to a drive and no driver/documenter role.
  - Two people on the road show up as two drives, or one shared drive under one label.

### 2.6 Reusable plumbing [VERIFIED]
- **Scheduler:** `lib/scheduler.js`, a 15-minute tick with Central-time gating, logged to `cron_runs` (`059`).
- **Time zones:** `_toCentralTimestamp` (`server.js:8677`), `_centralOffsetForDate` (8716), `centralParts()`.
  - `centralParts()` is duplicated in `lib/scheduler.js:35`, `lib/ea/tessa_standing.js:18` and `lib/notifications/ar_reminder.js:29`.
  - **There is no workweek helper**, and DST handling is date-granular. Timekeeping needs a proper tested helper.
- **Notifications:**
  - Resend email: `lib/notifications/email.js`;
  - Twilio SMS: `lib/notifications/sms.js`. The line is TEST-only and needs A2P registration before staff SMS;
  - Graph mail: `lib/email/graph_send.js`.
  - There is no Teams chat.
- **Export:**
  - `xlsx` is a dependency (`package.json:106`; write example at `api/roster_import.js:287-295`);
  - CSV helpers are in `api/checks.js:566-621` and `lib/accounting/positive_pay.js`.
  - There is **no payroll provider integration** (searched ADP, Gusto, Paychex, QuickBooks, Paylocity, Rippling).

---

## 3. Proposed design [PROPOSAL]

### 3.1 Principles
1. **Time worked comes only from explicit employee punches** (or an approved correction). Login, activity, GPS and task output are never time evidence. They may be shown next to punches as context for a manager's review, never used to create or change hours.
2. **Record everything; suppress nothing.**
   - There is no auto-clock-out.
   - There is no automatic meal deduction.
   - The system never fabricates a punch.
   - Missing data is flagged for the employee to fix or a manager to approve, with a reason.
3. **Append-only ledger.**
   - Punches are never edited.
   - A correction is a new, reasoned, approved record that supersedes an earlier one.
   - Totals are always computed from the ledger.
4. **Rules are versioned data**: workweek start, overtime threshold, meal thresholds. Every computed result records which policy version it used.
5. **Bedrock-scoped.** Employees belong to `management_company_id`. Communities, departments and tasks are allocation tags, not ownership. Timekeeping records are **Bedrock HR records (workpaper), never `association_record`**, so they are excluded from any community termination export.
6. **Server-authoritative time.**
   - The server stamps `recorded_at`.
   - A client-reported time, if offline capture is ever supported, is kept separately and flagged when it differs.

### 3.2 Minimal schema, stage 1-2 (all RLS on, service_role only, actor from the JWT)

**`employees`** (one row per `user_profiles` row that is an employee):
- `user_id` (FK to user_profiles, RESTRICT), `management_company_id`, `employee_number` (optional), `department` (text or FK to a small `departments` table);
- `manager_user_id`, `flsa_classification` (`nonexempt`/`exempt`, set only from counsel-approved classification), `timekeeping_required` (bool);
- `effective_from`, `effective_to`, `created_by`, timestamps.
- **Store no pay rates.** Rates stay with the payroll provider, which keeps sensitive compensation data out of trustEd.

**`timekeeping_policies`** (versioned; one active per company):
- `workweek_start_dow`, `workweek_start_time` (local), `timezone` (`America/Chicago`), `overtime_threshold_minutes` (2400);
- `meal_rules` JSONB (e.g. `[{min_worked_minutes:420, meal_minutes:60}, {min_worked_minutes:300, meal_minutes:30}]`), `meal_basis` (`worked_excluding_meals`);
- `effective_from`, `approved_by`, `approved_at`.

**`time_punches`** (append-only; blocked by trigger on UPDATE and DELETE):
- `id`, `employee_id`, `kind` (`clock_in`, `meal_start`, `meal_end`, `clock_out`), `occurred_at` (the effective instant), `recorded_at` (server now);
- `source` (`portal`, `manager_correction`, `kiosk` later), `client_reported_at`, `supersedes_punch_id`, `voided_by_correction_id`;
- `note`, `recorded_by_user_id`.
- Optional, off by default: an allocation tag (`community_id`, `department`, `task_ref`).

**`time_corrections`** (append-only request plus decision events):
- The request: `employee_id`, the proposed punches (added, voided, or retimed), `reason` (required), `requested_by`, `requested_at`.
- The decision: `status` (`pending`, `approved`, `rejected`), `decided_by`, `decided_at`, `decision_note`.
- Approval inserts the new punches (`source='manager_correction'`, `supersedes_punch_id` set). The before/after lives in the linked rows, so nothing is overwritten.
- Employees can request; managers approve.
- **A manager may not approve their own corrections.** The owner approves those.

**`overtime_approvals`**:
- `employee_id`, `workweek_start`, `requested_minutes` over threshold, `reason`, `requested_by`, `requested_at`, `status`, `decided_by`, `decided_at`.
- Advisory only. It never limits recorded or paid time (see 4.1).

**`meal_attestations`**:
- `employee_id`, `work_date`, `outcome` (`taken_full`, `short`, `interrupted`, `missed`, `waived_by_policy` if counsel allows), `minutes_taken`, `reason`, `recorded_at`, `reviewed_by`, `reviewed_at`.
- A factual statement by the employee; never an automatic deduction.

**`pay_periods`**:
- `management_company_id`, `period_start`, `period_end`, `status` (`open`, `submitted`, `approved`, `locked`), `locked_by`, `locked_at`.
- A lock guard blocks new punches and corrections dated inside a locked period, unless a reasoned `reopen_pay_period(id, reason, by)` event runs. This copies the `462` budget lock/reopen pattern.
- Employee sign-off (`timesheet_attestations`: employee, period, attested_at, statement version) is recommended. Its wording is a counsel item.

**Derived views** (computed, never stored as truth):
- `v_time_intervals`: punch pairs turned into worked and meal intervals.
- `v_daily_time`: per employee and work date: worked minutes, meal minutes, meal requirement met or not, missing-punch flags.
- `v_workweek_time`: per employee and workweek: worked minutes, minutes over threshold, whether overtime was approved.

**Stage 3 addition for drives:**

**`inspection_participants`**:
- `inspection_id`, `employee_id` (user), `role` (`driver`, `documenter`, `solo`, `trainee`, `trainer`, `safety_second`), `reason` (required when two or more participants).
- `joined_at`, `left_at`, `added_by`.
- It links drive labor to punched time. **It never creates time.**

### 3.3 Employee portal (inside the staff app, Bedrock-first)
A **"My Time"** tab in `public/index.html`. It should take three clicks or fewer to punch.

**Big buttons:** Clock in, Start meal, End meal, Clock out.
- Only the valid next action is enabled.
- Each confirmation states the recorded time, e.g. "Clocked in 8:02 AM Central".

**Today and this week:**
- worked time, meal status, and running workweek total against 40:00;
- a warning banner as the total approaches the threshold, with a **Request overtime approval** button;
- missing-punch prompts with **Request correction** (reason required).

**Meal prompts:**
- As worked time nears 5:00 or 7:00 without a meal, a prompt appears: "Policy calls for a 30/60-minute unpaid meal".
- After a short, interrupted or missed meal, a one-tap attestation with a reason. It records facts and does not change time automatically.

**Pay period view:** daily lines, flags, and an attest-and-submit step.

**What it will not do:** auto-clock-out, suppress hours, block clocking in past 40 hours, or start or stop time from login.

### 3.4 Manager view
- **Today board:** who is clocked in, on meal, or off. Status only; no surveillance feed.
- **Exceptions queue:** missing punches, open shifts older than N hours, short or missed meals, overtime without approval, correction requests. Each one requires a decision with a note.
- **Workweek grid:** per employee, daily totals, the workweek total, minutes over 40, and approval state.
- **Pay period:** review, approve, lock, export. Reopen requires a reason and is logged.
- **Audit drawer per day:** every punch, correction, approval and attestation with who, when and why, including superseded rows.

### 3.5 Payroll export
- **CSV** (xlsx optional) per pay period and employee:
  - employee number, name, workweek start;
  - regular minutes, minutes over threshold (as time, not dollars), meal exceptions count;
  - unresolved flags count, approval and lock state, policy version;
  - a hash of the included punch ids for audit.
- The export refuses to generate for a period that isn't locked.
- **Which provider?** No integration exists today. Ed should name Bedrock's payroll provider so the column layout matches its import format. **trustEd calculates hours only; the payroll provider calculates pay.**
- Reconciliation test: export totals must equal ledger-derived totals for the period.

### 3.6 Violations-drive labor measurement
- A **run** = one `inspections` row.
  - Existing data: community, actual `started_at` and `ended_at`, and pauses.
  - Added: `inspection_participants` for the assigned people, each with a role and a reason.
- **Per-person drive labor** = the overlap of that person's punched worked intervals with their `joined_at`–`left_at` on the drive.
  - Punches bound it, so drive labor can never exceed paid time and is never inferred from GPS or login.
- **Office follow-up labor.** Two options:
  - (a) allocation-tagged punches ("switch task: DRV review, community X"). Explicit and accurate, but adds friction.
  - (b) review event counts and timestamps. Cheap, but not time.
  - Recommend (b) for metrics and (a) only if Ed wants hours per task. Either way, first fix reviewer attribution: send the actor from the JWT on confirm and reject, and add a capturer to photos.
- **Comparable-drive metrics.** Report all of these; don't reduce them to one number:
  - total labor-hours per completed drive, and per 100 properties covered;
  - properties covered, from pings within radius (paginated) or observations;
  - observations documented, and the confirmed vs. rejected rate at office review, a quality signal;
  - rework: violations later edited, reopened, or found missed on the next drive;
  - office follow-up events and elapsed time to letters printed;
  - participant count and role mix, with reasons such as training, safety, or driving and documenting.
- **Comparability** means the same community (or a similar size), mode, season, and scope (full sweep vs. spot check). Show distributions, not a single leaderboard.
- **Guardrail.** These metrics inform coaching and staffing. They must never be used to change recorded hours. [VERIFY] with counsel how performance data may be used in discipline.

---

## 4. Rules and edge cases

### 4.1 Overtime and the 40-hour policy
- **Policy as Ed described it:** no more than 40 worked hours in the workweek without prior approval.
  - The system warns at a configurable lead, e.g. 36:00, and requests approval.
  - It **records and exports all hours actually worked, including unapproved hours.**
  - Unapproved overtime becomes a manager exception (a conduct matter), never a reduction in hours.
- **Workweek:** a fixed, recurring 7-day period set in `timekeeping_policies`, e.g. Sunday 12:00 AM to Saturday 11:59:59 PM Central. Ed chooses it. [VERIFY] the rules for setting the workweek and changing it later.
- **Hours count in the workweek in which they're worked.** A shift crossing the workweek boundary is split at the boundary for workweek totals. [VERIFY]
- **Overtime treatment.** My understanding is that federal law generally requires 1.5× the regular rate for non-exempt hours over 40 in a workweek, and Texas generally follows the federal standard for private employers. [VERIFY both with counsel.] Regular-rate calculation (bonuses and similar) belongs to payroll and counsel, not trustEd.
- **Unauthorized overtime:** it is generally understood that it must still be paid, while the employer may discipline for violating policy. [VERIFY]
- **Exempt-to-nonexempt conversion** is the biggest legal item. [VERIFY]:
  - the classification analysis per role;
  - the effective date aligned to a workweek boundary;
  - written notice and acknowledgment;
  - handling of any past period;
  - existing offer letters and agreements;
  - benefits and PTO effects.

### 4.2 Meal periods
- **Policy as Ed described it:**
  - 7 hours or more worked in a day: a 60-minute unpaid meal;
  - 5 to under 7 hours: 30 minutes;
  - under 5 hours: none.
- **Recommended interpretation, for Ed and counsel to confirm:** the thresholds measure actual worked time excluding meal time, per workday.
  - Otherwise the rule is circular: a 7:30 span with a 60-minute meal is 6:30 worked.
  - Evaluate the requirement against worked time, and prompt as worked time approaches each threshold.
- **Record, prompt, flag. Never deduct.** A meal exists only if the employee punched meal start and meal end.
  - **Short** (less than the required minutes): flag, prompt an attestation, pay the time as punched. [VERIFY] how short breaks are treated; short rest breaks are generally understood to be compensable time.
  - **Interrupted** (worked during the meal): the employee attests, and the interrupted portion is recorded as worked. [VERIFY] whether an interrupted meal is compensable in full.
  - **Missed:** flag and attest. The time stays worked and paid.
  - A meal punch that is never ended becomes a missing-punch exception resolved by correction. It is never auto-closed.
- **Texas state law.** My understanding is that Texas has no general meal-break requirement for adult private-sector employees, so the 5-hour and 7-hour rule would be Bedrock policy rather than a legal mandate. [VERIFY] Whether and when a meal period may be unpaid under federal rules (completely relieved of duty, typically 30 minutes or more) is also [VERIFY].
- **The policy text itself** (acknowledgment, how to report interruptions, no retaliation) needs counsel review.

### 4.3 Days, midnight, DST
- **Store UTC** (`timestamptz`). Compute durations as real elapsed time.
- **Workday for meal rules:** the shift is attributed to the local date it **started**. A 10 PM–4 AM shift is one workday with 6:00 worked, so a 30-minute meal is owed. Ed and counsel to confirm.
- **Workweek totals:** split at the workweek boundary instant (4.1).
- **DST:** spring-forward days have 23 hours and fall-back days have 25. A shift across the fall-back hour really is one hour longer. Test both.
- **An open shift older than N hours** (configurable, e.g. 14) raises an exception for the manager. Still no auto-close.

### 4.4 Missing punches and corrections
- **Exceptions:** clock-out without a clock-in, a meal without an end, an overlapping shift, a punch dated in a locked period.
- **The employee requests a correction with a reason; the manager approves.** On approval, new superseding punch rows are written, and the original stays visible and marked superseded.
- **A manager-initiated correction still requires a reason**, and it notifies the employee, with the employee's acknowledgment recorded.
- **Corrections that reduce hours** get extra scrutiny and require the employee's acknowledgment. [VERIFY] Counsel should weigh in on off-the-clock risk.

### 4.5 Off-the-clock work
Examples: email or Teams after hours, drives that start before clocking in.
- **Policy line in the portal:** "Record all time you work. If you worked without clocking in, submit a correction." [VERIFY] the wording.
- **Telemetry can flag possible off-the-clock work for a manager to review** (e.g. drive pings or document edits while clocked out), as an exception to resolve. It never becomes time on its own. [VERIFY] whether employer knowledge creates an obligation to pay, and how to handle the flags.

---

## 5. Security, privacy, prerequisites

### 5.1 Prerequisites (fix first)
1. **`user_profiles` privileges.** Revoke authenticated INSERT/UPDATE/DELETE and enable RLS: a small migration, after a read-only check of production state. Approvals depend on role integrity.
2. **Identity on timekeeping endpoints.** Every timekeeping endpoint uses the JWT (`requireStaff`/`requireAdmin`) and `requireActingUser`, never the gate cookie alone.
3. **Signing up must not create staff automatically.** New auth users currently become `staff` automatically (`039:37-62`). Timekeeping should require an explicit `employees` row created by the owner or an admin.

### 5.2 Privacy
- **No GPS on punches by default.**
  - Drive GPS already exists for inspections; keep it scoped to drives.
  - If location-on-punch is ever wanted, make it an explicit, disclosed policy decision. [VERIFY]
- **No keystroke, screen, or activity monitoring** as part of timekeeping.
- **No IP or user-agent** on punches, matching the decision on Trusted Pay acceptance records. A server timestamp and the authenticated user are enough.
- **Visibility.**
  - Employees see their own records.
  - Managers see their reports' records.
  - Ed sees everyone.
  - Enforce all of it server-side.
- **Retention.** Bedrock HR records. [VERIFY] the required retention periods for payroll and time records, and set a retention policy. They are excluded from community exports.

### 5.3 Record ownership
Every new table is **workpaper** (Bedrock HR), documented in each migration header. `inspection_participants` is Bedrock workpaper too: it records Bedrock's labor. The drive itself stays as it is.

### 5.4 Drive data bugs to fix before trusting drive metrics [VERIFIED in code; confirm with production data]
- **Auto-close with a made-up end time.**
  - The `stale_inspection_close` job (`lib/scheduler.js:483-523`) closes drives more than 4 hours past `last_ping_at`, or more than 4 hours past start if `last_ping_at` is null. It sets `ended_at` to `last_ping_at` or to start + 4 h.
  - `last_ping_at` is written only by `POST /:id/ping` (`api/inspections.js:4946`). `public/inspector.html:417` calls it; the main Inspect tab in `public/index.html` posts to `/route-trace` instead, which doesn't update it.
  - So Inspect-tab drives longer than 4 hours may be closed with `ended_at = start + 4 h`.
- **Resume keeps the old end time.** Resuming a captured drive doesn't clear `ended_at` (`api/inspections.js:118-143`).
- **Coverage undercount.** `GET /:id/coverage` reads pings unpaginated (around line 2371), so drives with more than 1,000 pings are undercounted.
- **Likely silent failure in add-violation.** `api/inspections.js:4766-4767` inserts `opened_by_observation_id` and `opened_by_email`, and no migration defines those columns.
- **No actor on photos or reviews** (2.5).
- I've proposed these as a separate fix task.

---

## 6. Staged plan

| Stage | Scope | Gate to start |
|---|---|---|
| **0. Decisions** | Counsel: classification, overtime, meals, notices, policy text. Ed: workweek start, pay period cadence, payroll provider, meal-rule interpretation, who approves, effective date | Nothing builds that affects pay before this |
| **1. Foundations** | Fix `user_profiles`, fix drive bugs, add `employees` + `timekeeping_policies` | Separate approvals; migrations via the owner panel |
| **2. Punch ledger + My Time** | `time_punches` (append-only), daily and weekly views, employee portal, manager Today board | Can run as a **pilot, parallel to current pay**: no payroll effect |
| **3. Exceptions + approvals** | Corrections, overtime pre-approval, meal attestations, pay periods with lock/reopen, audit drawer | Counsel-approved policy text |
| **4. Payroll export** | Locked-period CSV in the provider's format, reconciliation | Payroll provider named; effective date set |
| **5. Drive labor** | `inspection_participants`, reviewer and capturer attribution, drive metrics dashboard | Stages 2 and 5.4 done |
| **6. Task allocation (optional)** | Allocation-tagged punches for department, community or task; link to `work_items` | Only if Ed wants hours per task |

**Recommended rollout:**
- Run stage 2 as a 2–4 week shadow pilot, with employees punching while pay stays unchanged. This surfaces friction and edge cases.
- Then go live at a workweek boundary after notices go out.

---

## 7. Focused test strategy
- **Pure rule engine** (`lib/timekeeping/rules.js`, no database), with table-driven tests:
  - daily and weekly totals;
  - shift across midnight (attributed to the start date for meals);
  - shift across the workweek boundary (split for overtime);
  - DST spring and fall days;
  - meal classification: taken, short, interrupted, missed, not required under 5 hours, and exactly 5:00 / 7:00;
  - missing and overlapping punches;
  - overtime warning at the lead threshold;
  - **unapproved overtime still counted in full**;
  - **no code path deducts a meal or closes a shift automatically** (asserted on outputs).
- **Ledger rehearsal** (PGlite, like `tests/sql/*_rehearsal.mjs`):
  - UPDATE and DELETE on punches refused;
  - correction supersedes without overwriting;
  - locked period refuses new punches;
  - reopen requires a reason and actor and is logged;
  - grants are service_role only.
- **Authorization:**
  - an employee sees and punches only for themselves;
  - a manager sees only their reports;
  - a manager can't approve their own correction;
  - a gate cookie without a JWT is refused;
  - the actor always comes from the JWT.
- **Export:** CSV totals equal ledger totals; refused unless the period is locked; stable ordering; stable hash.
- **Drive labor:**
  - participant labor is bounded by punched time;
  - two-person drives require a reason;
  - metrics ignore login and session data entirely;
  - coverage is paginated past 1,000 pings.

---

## 8. Decisions and verification list

**Ed:**
1. Workweek start day and time.
2. Pay period cadence.
3. Payroll provider.
4. Which roles convert to hourly, and the effective date.
5. Meal-rule basis (worked time excluding meals, per shift start date).
6. Overtime warning lead.
7. Who approves (managers or Ed only).
8. Pilot length.
9. Whether hours per task (stage 6) are wanted.

**Counsel (current federal + Texas) [VERIFY]:**
1. Exempt/non-exempt classification per role.
2. Conversion mechanics, notices and acknowledgments.
3. Workweek designation.
4. Overtime rate and regular-rate issues.
5. Unauthorized overtime and discipline.
6. Meal-period compensability (short, interrupted, missed) and whether Bedrock's 5 h/7 h policy is lawful and advisable as written.
7. Off-the-clock work and employer knowledge.
8. Recordkeeping content and retention.
9. Corrections that reduce hours.
10. Employee attestation wording.
11. Location data and performance-metric use.
12. Existing offer letters and agreements.
