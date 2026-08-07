# Session Handoff — 2026-08-06

Paste into a fresh session. Current state, not history.

---

## 🎯 WEEKEND AGENDA (Ed's priorities for the next session)
1. **Stripe payment link** — build the assessment/payment link flow. Memory:
   `project_stripe_assessments` (dues via Stripe Connect; NEXT = webhook → AR/GL),
   `project_payment_architecture_v2` (direct Connect). Webhook → AR posting is the
   open piece.
2. **Finish the customer + board portals.** Memory: `project_homeowner_portal`
   (magic-link, one property, six cards), `project_board_portal` +
   `project_board_portal_auth` (dual-auth staff JWT / board magic-link,
   community-scoped).
3. **Project management module** — "really good," building on what's started.
   Memory: `project_project_tracking` (budget-vs-live-actual + health + milestones
   on `vendor_projects`; board-portal Projects panel) and
   `project_operations_dashboard` (vendor/project lifecycle + approval queue).

---

## 🔴 DO NOT FORGET — accounting reconciliation (Ed's decision)
- **The GL was cut over mid-period, not at month-start.** trustEd's AP intake ran
  in PARALLEL on top of the imported Vantaca GL, and the two were never reconciled.
- **Waterview reconciliation (illustrative):** GL AP (acct 2000) = $104,086.51 from
  1,662 lines; trustEd AP subledger open = $45,935.91 → **$58k gap.** Cash activity
  is ~all `vantaca_import` (1,999 lines), only 3 rows via trustEd's payment engine.
- **ACH parallel-ledger issue:** 49 ACH-autopay invoices ($74,865 across 6
  communities) are booked `Dr Exp / Cr AP` with **no payment leg**, stuck in
  `awaiting_approval`. **DO NOT bulk-post `recordPayment` on them** — they may
  DUPLICATE already-imported Vantaca activity; blind posting could compound a
  double-count. (I over-claimed "overstated, just book it" before verifying — the
  real answer is reconcile first.)
- **Ed's plan:** reconcile Vantaca ↔ trustEd **through 7/31**, make them tie, then
  run clean forward. First concrete job = a Waterview **tie-out view** (GL AP vs.
  what it should be; classify each trustEd invoice net-new vs. duplicate-of-import).
  Build it as a RECONCILIATION view, NOT a posting run.
- AP intake gaps found (real, for later): ACH invoices don't auto-record payment
  (`lib/ap/intake.js:207` sets `awaiting_approval`); auto-coder produces high
  confidence but 55/83 flagged `needs_review` (gate not wired); multi-service
  vendors (8/26) coded across GL accounts; dedup dormant (an exact
  vendor+invoice# dup slipped through). Rails exist: `lib/accounting/ap_engine.js`
  `recordPayment` (Dr AP/Cr Cash), `lib/ap/dedup.js`, `check_run.js` already
  excludes ACH from check runs. See the "exception-queue AP" plan in the transcript.

---

## 🟢 SHIPPED THIS SESSION — pushed to main, PENDING Ed deploy + mig 351
- **ACC inbound-email → application matcher** (`lib/acc/match_open_application.js`,
  mig **351** `correspondent_emails`+`conversation_id`, `tests/test_acc_application_matching.js`).
  Follow-ups now attach to the open case (thread/ref/email/normalized-addr/name)
  instead of spawning duplicates. Fixed the Lopez patio that fragmented across 3
  rows. Commit d72a26c. **Ed must apply mig 351 (admin banner) + deploy**, then run
  `scripts/backfill_lopez_correspondents.js`.
- **ACC letter-precedence unified** — queue preview + send now use
  `letter_body || ai_letter_body` (was ai_letter_body-first, could send a stale
  draft). Commit ae1d6c8.
- **ACC redraft survey-waiver guard** — never claims a survey was waived when one
  is attached. Commit ea1bffd.
- **ACC cover-note greets both homeowners** ("Hi Simon and Maria,"). Commit 7bfed6b.
- **Calendar → Monthly DRV Summary module** (`lib/enforcement/drv_monthly_summary.js`,
  `GET /api/calendar/drv-summary` + `/drv-communities`, DRV Summary pill next to
  Flyer Studio, one-page portrait Print/PDF). Community-facing: snapshot
  (first/second/certified from `interactions`), Top Violation Types by category
  (new non-voided violations opened this month, carryovers excluded), AI narrative,
  Top-3. **Separate from billing Activity Report (untouched).** Verified vs LPF
  July (167/7/1, 177 new). Commits 92797fb, 163d0a9.

## Lopez ACC (EAG-ARC-2026-0001) — ready to send, awaiting Ed
- Consolidated to survivor `9c843745`; two dup rows withdrawn. Approve-with-
  conditions letter in `letter_body` AND `ai_letter_body` ("Dear Simon and Maria,",
  8 conditions, survey acknowledged, no waiver). Recipient = her active gmail
  (lpzmartaxes@gmail.com). Survey attached. **Ed: ACC Review → Send. Do NOT click
  Redraft until mig/deploy lands** (live redraft still regenerates the waiver until
  ea1bffd deploys).

## Open decisions Ed hasn't answered
- DRV Summary: category **display-name mapping** ("Lawn dead patches" → board-
  friendly grouping)? And the **"Resolved" KPI** stays hidden until resolutions are
  tracked natively (was Vantaca-sourced).
- DRV camera (drive-once capture): recommended $20 side-mounted PHONE test on 10
  known-violation houses BEFORE buying an Insta360 X5 — resolution/evidence-quality
  is the make-or-break unknown. Not started.
- "Ship a feature, teach the platform": DRV Summary tab not yet in
  `scripts/seed_platform_knowledge.js`.

## Standing constraints
- Live GL = catastrophic-output surface: reconcile/dry-run + Ed review before any
  posting run. Never bulk-post ACH payments pre-reconciliation.
- Verify before claiming (this session had 3 over-claims corrected by looking:
  survey-mislabel, ACC field confusion, "AP overstated" before GL tie-out).
- CLAUDE.md scars in force. Deploy loop: commit+push per edit, Ed runs Manual
  Deploy on Render.

## Environment
- No local DB / DATABASE_URL — migrations apply via admin banner on Render.
- Local puppeteer fails ("Target closed") — PDF renders only on Render.
- `.env`: SUPABASE_URL/KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, STAFF_PASSWORD,
  GRAPH_* (Outlook/Teams read-only MCP; no presence-write).
- Model standard: `claude-sonnet-4-5`.
