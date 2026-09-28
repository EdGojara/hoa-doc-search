# Employee Portal and Timekeeping: Architecture Assessment (rev 2)

**Status:** assessment only. No code, migration, deploy, production write, or change to employee pay or status.
**Requested by:** Ed via ChatGPT instruction, GitHub Issue #1 (2026-09-28 11:53 UTC).
**Revision 2:** incorporates ChatGPT's review of `fbd7eaa7` (2026-09-28 12:05 UTC). The change log is at the end.
**Kept separate from:** `feat/trusted-pay-terms` and its pending decisions.
**Branch:** `docs/employee-timekeeping-assessment` (docs only).

> **Legal notice.** This is an engineering assessment, not legal advice. Every wage-and-hour point is marked **VERIFY**. Each needs current federal and Texas verification and review by employment/payroll counsel before any policy takes effect. That covers classification, overtime, meal periods, off-the-clock work, recordkeeping, notices, pay timing, and existing agreements. Nothing here is a legal conclusion.

The document keeps three kinds of statement strictly apart:
- **Section 2: CONFIRMED CODE FACTS.** Read in the current code, with the path cited. These describe code, not production data.
- **Section 3: LIKELY BUGS AND UNVERIFIED RISKS.** Inferred from code; each needs a read-only production check before anyone calls it real.
- **Sections 4 to 8: PROPOSALS.** Nothing in them is built.

---

## 1. Summary

1. **trustEd has no timekeeping model today** (section 2.4). Login sessions can't evidence time worked, because they are long-lived and don't identify activity (section 2.1).
2. **Paid time is proposed to be reconciled, not just punched** (section 4.1). Explicit punches are the primary record.
   - Employee reports, manager entries backed by credible evidence, and approved corrections also feed the paid record.
   - Activity signals (drive GPS, task activity) only raise review flags that a manager must resolve.
   - They never set hours on their own.
   - Known work is never ignored because a punch is missing.
3. **Every recorded fact is an immutable event row** (section 4.2). Status, "current" punches and totals are **projections** computed from events. No event row is ever updated or deleted.
4. **Locked pay periods never refuse newly discovered work** (section 4.7).
   - A lock freezes an **export snapshot**.
   - Later work or corrections produce an auditable **adjustment export** in the next pay cycle, with the affected workweeks' overtime recalculated.
5. **Overtime is computed per 7-day workweek and then allocated across pay periods by the date worked** (section 4.8).
   - The math uses exact seconds.
   - Rounding happens once, at export, by a documented rule.
6. **Paid hours and drive hours are separate quantities** (section 4.10). Participants confirm their actual on-drive time, which is then reconciled to paid time. Drive end times affected by the stale-close behavior are marked unreliable and excluded from baselines.
7. **Before anything relies on admin or manager roles**, run a read-only production check of `user_profiles` grants, RLS, and endpoint exposure (section 3.1).

---

## 2. Confirmed code facts

### 2.1 Authentication and sessions
**Staff sign-in:**
- Microsoft through Supabase OAuth: `public/login.html:246-254`.
- `POST /api/auth/exchange-supabase-session` requires an active `user_profiles` row and sets the gate cookie (`server.js:763-815`).
- A shared-password fallback exists: `POST /api/staff-login` (`server.js:711-730`).

**Gate cookie:**
- `bedrock_gate`, `STAFF_GATE_TTL_DAYS = 30` (`server.js:429-430`).
- Its value is a signed timestamp with **no user identity** (`server.js:614-626`; `api/_require_admin.js:4-5`).
- Fixed expiry, no sliding renewal.
- The global middleware is at `server.js:639-657`.

**Per-person identity** comes from the Supabase JWT on each endpoint (`api/_require_admin.js:17-34`):
- `requireStaff` (51-58);
- `requireAdmin` (38-45);
- `requireOwner` (63-72, admin plus `OWNER_EMAIL`).
- `api/_acting_user.js` provides `requireActingUser`.

**The Supabase browser client is created with no options** (`public/index.html:378`), so supabase-js defaults apply: the session persists and auto-refreshes. No idle-timeout code was found (searched idle, inactivity, heartbeat, refreshSession in `public/`).

**Sign-out:**
- `authSignOut()` (`public/index.html:442-445`) doesn't clear the gate cookie; `/staff-logout` (`server.js:733-739`) is separate.
- Deactivation blocks JWT calls (`api/_require_admin.js:29`) but not an existing gate cookie.

### 2.2 Staff identity, roles, scoping
- **`user_profiles`** (`migrations/039_user_profiles.sql:17-28`): id (FK `auth.users`), management_company_id, email, full_name, role `CHECK IN ('admin','staff','assistant')`, is_active, last_sign_in_at. `preferences` was added in `131`.
- **`039:33`:** `GRANT SELECT, INSERT, UPDATE, DELETE ON user_profiles TO authenticated, service_role`. No migration in the repo enables RLS on it or revokes that grant. Section 3.1 covers what this may mean in production.
- **`handle_new_user` trigger** (`039:37-62`): the first auth user becomes admin and later ones become staff. No email-domain check was found.
- **No employee fields**: no department, manager, hire date, pay type, or FLSA status. Searched migrations for hire_date, pay_type, hourly, salar, department, job_title, manager_id, reports_to, employee.
- **Other identity tables:**
  - `portal_users` (`078`; roles in `201:24-27`) and `portal_manager_scope` (`201:35-47`) are portal identities, not the staff directory.
  - `management_companies` (`001:39-50`); Bedrock is `00000000-0000-0000-0000-000000000001`.
- **Staff-to-community assignment:** no table. Nearest: free-text `work_items.assigned_to` (`256:32`), `homeowner_threads.assigned_staff_id` (`161:69`).
- **Departments, org chart, presence:** not found.

### 2.3 RLS and audit patterns
- **RLS:** only 16 of 473 migrations enable it. The current pattern for sensitive tables is enable RLS, `REVOKE ALL ... FROM PUBLIC, anon, authenticated`, then grant to `service_role` only (`469:63-65`, `468:30-31`, `467:782-785`).
- **Append-only by trigger:**
  - `community_budget_events_append_only()` (`462:46-54`);
  - `ownership_tenures_guard()` (`456:68-90`);
  - `migration_attempts_append_only()` (`lib/migrations/apply_one.js:239-250`).
- **Lock with a reasoned reopen:** `462` (`community_budgets_lock_guard`, `reopen_community_budget(p_budget_id, p_reason, p_by)`, service-role only).
- **Before/after log:** `journal_entry_edits` (`280:33-42`, `changes JSONB`).
- **Actor from the JWT:** `119_user_audit_attribution.sql`.
- **Approval trail:** `ap_invoice_approvals` (`175:187-208`).

### 2.4 Time, activity, tasks
- **No timesheet, punch, payroll, overtime or meal model.** Searched timesheet, clock_in, punch, payroll, pay_period, overtime, time_entr, hours_worked, time_spent.
- **"Hourly" appears only as community billing** (`002_bedrock_billing.sql:68`; seeds `003:160-171`).
- **No staff activity log.** Searched friction, login_events, staff_activity, page_view, activity_log, last_active.
- **`calendar_events`** (`348`) has vacation/sick/holiday types, free-text times and hard DELETE. It is a calendar, not a time record.
- **`work_items`** (`256`) has a free-text assignee, `received_at`, `sla_due_at` and `completed_at`, with no start time and no time spent.

### 2.5 Violations drives
- **`inspections`** (`050:156-172`).
  - Columns: `started_at`, `ended_at`, `status`, `mode`, and one `operator_id` (UUID, no FK).
  - Later additions: `device_label` (the driver's name as text), `last_ping_at`, and start/end offices (`165:82-89`).
  - Status `paused` and `inspection_pause_segments` (`211`), with `paused_by` as a text email.
- **Endpoints** (all in `api/inspections.js`):
  - start: line 107;
  - resume by community plus device label within 12 h: 118-143;
  - pause and resume: 470, 505;
  - `time-on-drive`: 541, computing end − start − pauses.
- **Stale-drive job** (`lib/scheduler.js:483-523`, every 2 h):
  - It marks drives `captured` when `last_ping_at` is older than 4 h, or it is null and `started_at` is older than 4 h.
  - It sets `ended_at` to `last_ping_at`, or to `started_at + 4h` when there are no pings.
- **Who writes `last_ping_at`:**
  - Only `POST /:id/ping` (`api/inspections.js:4946`, patch at 4993).
  - `public/inspector.html:417` calls `/ping`.
  - The main Inspect tab in `public/index.html` posts batches to `/:id/route-trace` (22523, 22555), and that handler (2170) doesn't write `last_ping_at`.
- **GPS:** `inspection_route_traces` (`052`), a ping about every 4.5 s. `GET /:id/route-trace` pages through all rows (2207). `GET /:id/coverage` (2336) reads pings without paging (around 2371).
- **Photos:** `inspection_photos` (`050:190`) has `captured_at` and `created_at` but **no capturer column** (insert at 722-737).
- **Observations:** `property_observations` (`050:226`) has `reviewer_user_id` and `reviewed_at`.
  - Confirm is at 3607 and goes through `findOrContinueViolation`.
  - The front end posts an empty body on confirm and reject (`public/index.html:24598, 24691`), so the reviewer id is not sent.
- **add-violation** (`api/inspections.js:4675`) inserts `opened_by_observation_id` and `opened_by_email` (4766-4767). No migration in the repo defines those columns.
- **No participant table or roles:** one `operator_id` and one `device_label` per drive.

### 2.6 Plumbing to reuse
- **Scheduler:** `lib/scheduler.js`, a 15-minute tick with Central-time gating, logged to `cron_runs` (`059`).
- **Time zones:** `_toCentralTimestamp` (`server.js:8677`), `_centralOffsetForDate` (8716), and `centralParts()`.
  - `centralParts()` is duplicated in `lib/scheduler.js:35`, `lib/ea/tessa_standing.js:18` and `lib/notifications/ar_reminder.js:29`.
  - DST is resolved by calendar date. There is no workweek helper.
- **Notifications:**
  - Resend: `lib/notifications/email.js`;
  - Twilio: `lib/notifications/sms.js`;
  - Graph mail: `lib/email/graph_send.js`.
  - No Teams chat.
- **Export:** `xlsx` dependency (`package.json:106`; write example at `api/roster_import.js:287-295`); CSV helpers in `api/checks.js:566-621` and `lib/accounting/positive_pay.js`.
- **No payroll provider integration.** Searched ADP, Gusto, Paychex, QuickBooks, Paylocity, Rippling.

---

## 3. Likely bugs and unverified risks

Each item needs read-only verification before anyone calls it real. Two are proposed as separate tasks outside this assessment.

### 3.1 `user_profiles` privileges: priority, verify before claiming exploitability
- **Code facts** (section 2.2): the repo grants the `authenticated` role full CRUD on `user_profiles`, and no RLS appears in any migration. The anon key is served to the browser (`server.js` around 11025).
- **Not yet verified:**
  - production grants (`information_schema.role_table_grants`);
  - RLS state (`pg_class.relrowsecurity`, `pg_policies`), since either could have been changed outside migrations;
  - whether PostgREST exposes the table to authenticated users;
  - whether any browser code relies on direct access.
- **Why it matters:** `requireAdmin` and `requireOwner` read `user_profiles.role`, so manager and approver roles for timekeeping depend on it.
- **Status:** a candidate issue, not a confirmed vulnerability. **Verify before any role-based timekeeping approval exists.**

### 3.2 Drive end times may be fabricated
- **The inference** (section 2.5): Inspect-tab drives never write `last_ping_at`, so the stale job may close any such drive older than 4 hours, setting `ended_at = started_at + 4h`, even mid-drive.
- **The check:** count `inspections` where `ended_at = started_at + interval '4 hours'`, or `last_ping_at IS NULL` while route traces exist.
- **A related risk:** resume (118-143) doesn't clear `ended_at`.
- **Consequence for metrics:** until verified and fixed, historical `ended_at` values that could have come from the stale job are **unreliable** and must not be used as a baseline (see 4.10).

### 3.3 Coverage undercount
`/:id/coverage` reads pings unpaged, so drives with more than 1,000 pings are probably undercounted (the PostgREST row cap).

### 3.4 add-violation may fail silently
- It writes two columns no migration defines. If production lacks them, the insert fails and is only logged (catch around 4782).
- **The check:** production `information_schema.columns` for `violations`.

### 3.5 No actor on drive work
- Photos have no capturer column.
- Confirm and reject don't send the reviewer, so per-person drive and review attribution isn't possible today.
- This is a design gap rather than a runtime bug.

---

## 4. Proposals

### 4.1 Principles (revised)
1. **Paid time is the reconciled record of actual work.** Sources, in order of normal use:
   - (a) explicit employee punches;
   - (b) employee-reported time for missed punches or off-clock work;
   - (c) manager entries based on credible evidence (for example, the employee was seen working, or sent documented work at a time);
   - (d) approved corrections.
   All four are immutable events, and all reconcile into one computed record.
2. **Signals trigger review; they never set hours.**
   - Drive GPS, task activity, document edits and email outside punched time raise a **review flag**.
   - The manager must resolve each flag: either record the work (which creates a (c) entry) or document why it wasn't work.
   - A manager cannot dismiss known work merely because no punch exists. [VERIFY] the employer-knowledge standard with counsel.
3. **Record everything; suppress nothing.**
   - No auto-clock-out.
   - No automatic meal deduction.
   - No fabricated punches.
   - No hours reduced without a reasoned, attributed event that the employee is notified of.
4. **Immutable events, computed projections** (section 4.2).
5. **Rules are versioned data**, and every computed total names its policy version.
6. **Bedrock-scoped HR records (workpaper)**, never `association_record`, and excluded from community exports.
7. **Server-authoritative time** for live punches.

### 4.2 Event model: immutable events vs. mutable projections
This resolves the contradiction in rev 1. There are **no mutable status or "voided" columns on event tables.**

**Immutable event tables.** Each has a trigger blocking UPDATE and DELETE; access is RLS on, service_role only, and the actor comes from the JWT.

`time_punches`: one row per punch fact.
- `id`, `employee_id`, `kind` (`clock_in`, `meal_start`, `meal_end`, `clock_out`), `occurred_at` (effective instant), `recorded_at` (server now), `policy_version`.
- `origin`: `live` (employee, server time), `employee_report`, `manager_entry`, or `correction`.
- `request_id`: FK to `time_change_requests`, required for any origin other than `live`.
- `client_request_id`: the idempotency key. `UNIQUE (employee_id, client_request_id)`.
- `client_reported_at`, `note`, `recorded_by_user_id`.

`time_change_requests`: a proposed change to the record; the row never changes.
- `id`, `employee_id`, `origin` (`employee`, `manager`, `review_flag`).
- `operations` JSONB: an ordered list of `{op:'add', kind, occurred_at}` and `{op:'supersede', punch_id}`.
- `reason` (required), `evidence` (optional references: an inspection id, a document id, free text), `requested_by`, `requested_at`, `client_request_id` (unique per requester).

`time_change_decisions`: exactly one terminal decision per request.
- `id`, `request_id UNIQUE`, `decision` (`approved`, `rejected`, `withdrawn`), `decided_by`, `decided_at`, `note`.
- The unique constraint makes simultaneous approvals impossible: the second insert fails and the UI reports "already decided".
- **Separation of duties:** `decided_by` must differ from the requester for manager-originated changes that reduce time, and a manager can't decide their own time. Enforced in the apply function.

`time_punch_supersessions`: how a punch stops counting, without touching the punch.
- `superseded_punch_id UNIQUE`, `decision_id`, `created_at`.

`time_review_flags` and `time_flag_resolutions`: a flag, and exactly one resolution per flag.
- Resolution values: `work_recorded`, which requires a linked approved request, or `not_work`, which requires a reason.

`meal_attestations`: immutable employee statements (section 4.6).

`overtime_requests` and `overtime_decisions`: the same request/decision pattern (section 4.5).

`payroll_exports` and `payroll_export_lines`: immutable snapshots (section 4.7).

**Projections.** These are views, or rebuildable caches with no authority:
- `v_effective_punches`: punches with no row in `time_punch_supersessions`.
- `v_change_request_status`: pending if there's no decision, otherwise the decision.
- `v_time_intervals`: effective punches paired into worked and meal intervals, with exceptions (unpaired, overlapping).
- `v_workday_time`, `v_workweek_time`, `v_pay_period_allocation`: section 4.8.

**Applying an approval.** One database function, `apply_time_change(request_id, decided_by, note)`, runs in a single transaction:
1. takes a per-employee advisory lock;
2. inserts the decision;
3. inserts the new punches (`origin='correction'`, `request_id` set);
4. inserts the supersession rows;
5. re-validates the resulting effective record (no overlaps; valid kind order);
6. rejects the whole transaction if invalid.

Nothing is updated. The audit trail is simply the event rows.

**Mutable data kept outside the ledger** (normal tables with before/after logging, like `journal_entry_edits`): `employees` (profile and classification, effective-dated) and `timekeeping_policies` (versioned; a new version is a new row).

### 4.3 Concurrency and idempotency
- **Double clicks and retries:** the client generates `client_request_id` (a UUID) per intended action. A repeat returns the existing row with HTTP 200, `duplicate:true`.
- **Live punch function** `record_punch(employee, kind, client_request_id)`:
  - takes the per-employee advisory lock;
  - reads the latest effective punch;
  - allows only the valid next kind (`clock_in` → `meal_start`|`clock_out`; `meal_start` → `meal_end`; `meal_end` → `meal_start`|`clock_out`; `clock_out` → `clock_in`);
  - stamps `occurred_at = now()` on the server.
  - An invalid sequence returns a clear error plus a "request a correction" path, never a silent fix.
- **Offline retries.** Proposed: no offline live punches in stage 2.
  - If the device is offline, the portal queues an `employee_report` request carrying the device time as `client_reported_at`, which goes through approval.
  - This avoids trusting device clocks while still capturing the work.
- **Overlapping intervals:** refused at `record_punch`. For corrections, `apply_time_change` re-validates the whole affected day or week under the same lock.
- **Simultaneous approvals:** the `request_id UNIQUE` on decisions, plus the advisory lock.
- **Boundary calculations:**
  - pure, deterministic functions of (effective events, policy version, time zone rules);
  - computed at read time;
  - exports record a **ledger watermark** (the max event `recorded_at` and id included) so any total can be reproduced.

### 4.4 Corrections and evidence
- **Employee:** "I forgot to clock out at 5:40 PM" or "I answered owner calls from 7:00 to 7:30 PM". This creates a request with a reason, and the manager decides.
- **Manager:** "Seen working 7:00 to 7:30 PM (drive GPS, inspection id X)". This creates a manager-origin request.
  - If it **adds** time, it can be decided by another approver or the owner, and the employee is notified.
  - If it **reduces** time, the employee must be notified and given a way to respond, and separation of duties applies. [VERIFY] with counsel.
- **Review flags** come from signals (4.1 #2), and each needs a resolution.
- **Rejections require a note**, and the employee sees it.

### 4.5 Overtime pre-approval (advisory)
- **Policy as Ed described it:** no more than 40 worked hours in the workweek without prior approval.
  - The system warns at a configurable lead and routes an `overtime_request`.
  - It **records and exports all hours actually worked, whether or not they were approved.**
  - Unapproved overtime becomes a manager exception, never a reduction.
- **The workweek** is a fixed, recurring 7-day period set in `timekeeping_policies`; Ed chooses it.
- [VERIFY]:
  - workweek designation and changes;
  - my understanding that non-exempt hours over 40 in a workweek are generally owed at 1.5× the regular rate federally, with Texas generally following the federal standard for private employers;
  - that unauthorized overtime must generally be paid, while the policy violation may be addressed separately;
  - regular-rate components (payroll and counsel).

### 4.6 Meal periods
**Decisions Ed must make.** These are not silently picked. Each has implications.
1. **Basis for the 5-hour and 7-hour thresholds.**
   - (a) **Net worked time excluding meals.** A 7:30 span with a 60-minute meal is 6:30 worked, so only a 30-minute meal is required.
   - (b) **Scheduled or elapsed shift span.**
   - Option (a) avoids circularity but lets a long span need a shorter meal. Option (b) is simpler to explain but can require a meal the work time doesn't reach.
2. **Can the 60-minute meal be satisfied in segments** (for example 2 × 30 minutes)? If so, what is the minimum segment that counts?
3. **Whose day is a shift that crosses midnight?** The start date, or split at midnight?

**Engineering rules** (independent of those answers):
- **A meal exists only where the employee punched `meal_start` and `meal_end` and was relieved of duty.** The system never creates an unpaid meal by itself. A 60-minute requirement never becomes an automatic unpaid hour.
- **Interrupted meal:** if the employee worked while the meal punch was open, the attestation opens a **correction request** that converts the worked minutes back to worked time.
  - For example: `meal_end` at the interruption, then a new `meal_start` if the meal resumed; or supersede the meal entirely.
  - Attesting alone is not enough. The recorded meal must reflect only relieved time.
- **Short meal** (under the requirement): flag and attest. The unrelieved time outside the meal punches is already worked time. [VERIFY] how short breaks are treated: short rest breaks are generally understood to be compensable.
- **Missed meal:** flag and attest. Nothing is deducted.
- **Open meal punch** (never ended): an exception resolved by correction, never auto-closed.
- [VERIFY]:
  - my understanding that Texas has no general meal-break mandate for adult private-sector employees, so this would be Bedrock policy;
  - federal conditions for an unpaid meal (completely relieved, typically 30 minutes or more);
  - whether Bedrock's 5-hour and 7-hour policy is advisable as written;
  - the policy text and acknowledgment.

### 4.7 Pay periods, locks, exports, adjustments
**`pay_periods`:** `period_start`, `period_end`, `pay_date`. Status is a projection of immutable `pay_period_events` (`submitted`, `approved`, `locked`, `reopened`, each with actor and reason).

**Lock** means: an **export snapshot** is taken and frozen. It does **not** block recording work.
- New punches, reports and corrections dated inside a locked period are **always accepted**.
- They're marked as *post-lock* by comparing their `recorded_at` with the snapshot's watermark.

**`payroll_exports`** (immutable):
- `id`, `pay_period_id`, `kind` (`regular` or `adjustment`), `sequence`, `ledger_watermark`, `policy_version`, `created_by`, `created_at`, `content_sha256`, `file_format_version`.

**`payroll_export_lines`** (immutable), one row per employee, workweek and pay period:
- `regular_seconds`, `overtime_seconds`;
- for adjustment lines, a delta against what was previously exported for that employee, workweek and pay period;
- `meal_exception_count`, `unresolved_exception_count`.

**Adjustment export** (the next pay cycle, or off-cycle if payroll needs it):
- For every employee-workweek touched by a post-lock event, recompute the full workweek, including overtime.
- Subtract the sum of all previously exported lines for that employee-workweek.
- Export the delta, tagged with the original pay period and workweek.
- Overtime moves correctly: if an added hour pushes a prior workweek past 40, the delta is overtime, not regular time.
- [VERIFY] with counsel and the payroll provider when corrected wages must be paid.

**Reconciliation invariant:** for every employee-workweek, the sum of exported lines across all exports equals the current ledger computation. A daily check reports any drift and any post-lock events not yet exported.

**Escalation:**
- post-lock events older than N days;
- adjustments crossing a pay date;
- any adjustment that reduces previously exported time.
All go to the owner, with the reason.

**Reopen** is available for errors caught before payroll processes a period. It writes a `reopened` event with a reason and voids nothing: a new snapshot supersedes the old one via `sequence`. It is never the only way to record late work.

### 4.8 Payroll-week math
- **Overtime is a workweek quantity** [VERIFY]. It is computed per employee per 7-day workweek (a policy start instant in America/Chicago), never per pay period.
- **Splitting intervals.** Each worked interval is split at three kinds of boundary, all computed as local wall-clock boundaries converted to UTC instants:
  - (1) workweek boundaries, for the overtime test;
  - (2) pay-period boundaries, for allocation;
  - (3) local midnights, for daily display and meal-rule attribution per Ed's answer to 4.6 Q3.
- **Allocating a workweek that straddles two pay periods:**
  - **Regular seconds:** to each pay period by the date and time worked.
  - **Overtime seconds** only become known when the workweek ends. Proposal: attribute them to the pay period containing the workweek's end.
  - If a pay period closes before a straddling workweek ends, that period's regular-time export includes the known straddle hours, and the overtime lands in the next period's export as a normal line (not an adjustment).
  - [VERIFY] with counsel and the payroll provider the timing for paying overtime on straddling workweeks.
  - **Strong recommendation:** pick **biweekly pay periods aligned to the workweek start**. Then no workweek straddles a period and the problem disappears. This is a decision for Ed.
- **Units:**
  - All computation in integer seconds from UTC instants. No per-punch rounding. [VERIFY] if any rounding policy is wanted; none is proposed.
  - Export per line: exact minutes, plus decimal hours to 2 places computed from the line's total seconds, rounded half-up once.
  - The residue is documented, and the reconciliation compares seconds, not decimals.
- **DST:**
  - Durations are real elapsed seconds, so a shift across the fall-back hour really is one hour longer, and one across spring-forward is one hour shorter.
  - Boundary instants are computed with a time-zone-aware conversion.
  - Proposal: add one tested helper (`lib/time/central.js`: `workweekStartFor(instant, policy)`, `localMidnightsBetween`, `splitIntervalAt`) and retire the duplicated `centralParts()` copies over time.
- **Overnight shifts:** split at midnight for daily display. Meal attribution follows Ed's 4.6 Q3 answer.
- **Versioning:**
  - Each export records its policy version, watermark and hash.
  - A policy change applies from a future workweek start only; historical recomputation uses the policy version in force for that workweek.

### 4.9 Employee portal and manager view
**"My Time"** is a tab in the staff app; punching takes three clicks or fewer.
- Buttons for the valid next punch, each confirming the server-recorded time.
- Today and this week versus 40:00, with the overtime warning and a request button.
- Meal prompts near thresholds, with an attestation and correction flow.
- Missing-punch prompts.
- A "report time I worked" button for off-clock work.
- Pay-period review and attestation. [VERIFY] the wording.

**Manager view:**
- A today board showing status only.
- An exceptions and flags queue, where each item needs a decision and a note.
- A workweek grid.
- Pay-period approve, lock and export, plus an adjustments queue.
- A per-day audit drawer showing every event, including superseded ones.

**The portal never:** auto-clocks out, deducts meals, blocks punching past 40 hours, or derives time from login.

### 4.10 Violations-drive labor
- **Two separate quantities:**
  - (1) **paid hours**, from the reconciled record;
  - (2) **allocated drive hours**, per person per drive.
- Punch overlap is only a plausibility bound: it can include unrelated work, or miss a drive reported late.
- **`inspection_participants`:** `inspection_id`, `employee_id`, `role` (`driver`, `documenter`, `solo`, `trainee`, `trainer`, `safety_second`), `reason` (required when two or more participants), `added_by`.
- **Participant time claims** (immutable events): each participant **confirms their actual on-drive start and end** (and breaks). Confirmation is prefilled from drive start, pause and end where those are reliable, and it is editable with a reason. A manager approves.
- **Reconciliation:**
  - Approved drive time must fall inside paid worked time.
  - Drive time outside punches raises a **review flag** (possible unrecorded work, resolved by the section 4.4 process).
  - Punched time with no drive allocation is simply other work.
- **Data quality:** proposal to add `inspections.ended_at_quality` (`user`, `auto_stale`, `legacy_unverified`). All historical drives possibly affected by 3.2 are marked `legacy_unverified` and **excluded from baselines** until confirmed.
- **Metrics** (for coaching and staffing; never to change hours):
  - labor-hours per completed comparable drive, and per 100 properties covered (paged coverage);
  - confirmed vs. rejected observations at office review;
  - rework (edits, reopens, misses found on the next drive);
  - office follow-up events and elapsed time to printed letters;
  - participant count and role mix, with reasons.
  - Compare within the same community (or similar size), mode, season and scope, and show distributions.
  - [VERIFY] the use of performance data in discipline.
- **Prerequisites:** fix 3.2 through 3.5, and add capturer and reviewer attribution (actor from the JWT).

---

## 5. Security and privacy
1. **Section 3.1 verification first.** No timekeeping role or approval ships until `user_profiles` grants, RLS and exposure are verified and, if needed, fixed.
2. **Every timekeeping endpoint uses the JWT and `requireActingUser`**, never the gate cookie alone.
3. **Employees are created explicitly** by the owner or an admin in an `employees` row; auto-created staff profiles (`039:37-62`) aren't enough.
4. **No GPS on punches by default.** No keystroke, screen or activity monitoring. No IP or user agent on punches. [VERIFY] any location-on-punch policy.
5. **Visibility:** employees see their own records, managers their reports', the owner everyone's. All enforced server-side.
6. **Retention:** Bedrock HR records. [VERIFY] retention periods.
7. **Record ownership:** every new table is workpaper, documented in its migration header.

---

## 6. Staged plan

| Stage | Scope | Gate |
|---|---|---|
| 0. Decisions | Counsel review; Ed's answers (section 8) | Before anything affects pay |
| 1. Foundations | Read-only verify and fix 3.1; verify and fix 3.2 to 3.5; `employees`, `timekeeping_policies`; time helper | Separate approvals; migrations via the owner panel |
| 2. Ledger + My Time | Immutable punches, `record_punch`, projections, portal, today board | **Shadow pilot, parallel to current pay** |
| 3. Changes + flags | Requests, decisions, supersessions, `apply_time_change`, review flags, meals, overtime requests | Counsel-approved policy text |
| 4. Pay periods + export | Snapshots, adjustment exports, reconciliation, escalation, the provider's format | Provider named; effective date set |
| 5. Drive labor | Participants, time claims, attribution, quality flags, metrics | Stages 1 and 3 done |
| 6. Task allocation (optional) | Allocation tags, link to `work_items` | Only if Ed wants hours per task |

The shadow pilot runs 2 to 4 weeks. Go live at a workweek boundary after notices.

---

## 7. Focused test strategy
- **Pure time math, table-driven:**
  - workweek splitting;
  - pay-period straddle allocation (regular by date; overtime to the period containing the week's end);
  - midnight and DST (23-hour and 25-hour days);
  - integer seconds and export rounding with residue;
  - meal classification under each 4.6 option;
  - unapproved overtime counted in full;
  - no code path deducts meals or closes shifts.
- **Ledger rehearsal (PGlite):**
  - UPDATE and DELETE refused on every event table;
  - supersession derived, not written into punches;
  - one decision per request (a simultaneous second insert fails);
  - `apply_time_change` is atomic and re-validates overlaps;
  - `record_punch` enforces the kind sequence under the advisory lock;
  - a duplicate `client_request_id` returns the existing row;
  - grants are service_role only.
- **Locked periods:**
  - post-lock events are accepted;
  - the adjustment export deltas equal the recomputation minus prior exports, including an overtime shift from regular to overtime;
  - the reconciliation invariant holds after several adjustments;
  - reopen writes an event and voids nothing.
- **Authorization:**
  - employee only sees their own records;
  - manager only sees their reports;
  - no self-approval;
  - separation of duties on reductions;
  - gate cookie without a JWT refused.
- **Drive labor:**
  - claims must be approved;
  - out-of-punch drive time raises a flag;
  - `legacy_unverified` drives are excluded from baselines;
  - coverage is paged past 1,000 pings.

---

## 8. Decisions and verification

**Ed:**
1. Workweek start day and time.
2. Pay period cadence (biweekly aligned to the workweek is recommended).
3. Payroll provider.
4. Which roles convert, and the effective date.
5. Meal basis: net worked vs. span (4.6 Q1).
6. Whether the 60-minute meal can be split, and the minimum segment (Q2).
7. Midnight-crossing day attribution (Q3).
8. Overtime warning lead.
9. Approvers and separation of duties.
10. Pilot length.
11. Whether hours per task are wanted.

**Counsel (current federal + Texas) [VERIFY]:**
1. Classification and conversion mechanics, notices.
2. Workweek designation.
3. Overtime rate and regular rate.
4. Unauthorized overtime.
5. Pay timing for straddling workweeks and post-lock adjustments.
6. Meal compensability, and whether the 5-hour and 7-hour policy is advisable.
7. Off-the-clock work and the employer-knowledge standard.
8. Corrections that reduce time.
9. Rounding (none proposed).
10. Recordkeeping content and retention.
11. Attestation wording.
12. Location data and the use of performance metrics.
13. Existing offer letters and agreements.

**Read-only production checks (engineering):**
1. `user_profiles` grants, RLS, exposure (3.1).
2. Drive end-time corruption (3.2).
3. The `violations` columns used by add-violation (3.4).

---

## Change log
**rev 2 (2026-09-28):** ChatGPT review of `fbd7eaa7`.
- Paid time is the reconciled record: punches plus employee reports, manager evidence entries and approved corrections. Signals raise review flags and never set hours.
- Removed the append-only contradiction. `voided_by_correction_id` and the mutable status and decision fields are gone. Immutable punch, request, decision and supersession events; projections are derived.
- Added idempotency and concurrency controls.
- Locked periods no longer refuse work. They freeze snapshots, and post-lock work flows into adjustment exports with workweek overtime recalculated, a reconciliation invariant, and escalation.
- Specified payroll-week math: workweek overtime, straddle allocation, integer seconds, rounding, DST and overnight handling, versioning.
- Meal attestation now drives corrections for interrupted meals. The 60-minute rule never becomes an automatic unpaid hour. The threshold basis and segmenting are decisions for Ed; nothing is picked silently.
- Drive labor: paid hours and allocated drive hours kept separate; confirmed participant time reconciled to paid time; stale-affected end times marked unreliable.
- The `user_profiles` finding is restated as a code fact plus unverified risk, needing read-only production verification before anyone calls it exploitable.
- Reorganized into confirmed code facts, likely bugs, and proposals.

**rev 1 (`fbd7eaa7`):** initial assessment.
