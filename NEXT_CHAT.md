# Next chat — handoff brief

Ed asked for this. Read CLAUDE.md and the memory index first, then this file.

---

## The active task

**Waterview Vantaca historical import + hearing-stage migration.**

Ed attached a Vantaca violations PDF (95 of 100 image limit hit, ending the
prior chat) and asked me to bring Waterview's historical violations into
trustEd so they show up in the month-end report we shipped this session.

Distribution in the PDF (~240 open violations):

| Stage              | Count | Vantaca label          |
|--------------------|-------|------------------------|
| First Notice       | 118   | courtesy_1 equivalent  |
| Second Notice      | 54    | courtesy_2 equivalent  |
| Certified Letter   | 34    | certified_209          |
| Pending Hearing    | 34    | **hearing_notice**     |

Repeat-offender clusters worth eyeballing on import: MDY Capital LLC at
19727 Norfolk Ridge Way (4 hearing-stage rows), Terrill Lewis at 5943
Baldwin Elm, Christine Nguyen at 5506 Hickory Harvest, Pascal Dor at 5206
Magnolia Sky, Sardar Durrani at 5602 Baldwin Elm.

## Why this is non-trivial — the scar that will trigger

The `violations.current_stage` CHECK constraint allows only:

```
courtesy_1 / courtesy_2 / certified_209 / fine_assessed / cured / closed / voided
```

`hearing_notice` and `legal_referral` are NOT in that list -- but they DO
exist in `violation_letters.stage_at_send`. That asymmetry is the exact scar
CLAUDE.md names ("Invented enum values that crashed
violations_current_stage_check -- invisible because the tests asserted only
row counts and stage distribution, not that emitted values are actually
accepted by the DB"). LOPF dodged it; Waterview triggers it.

The "Pending Hearing" 34 rows WILL fail the import without the migration
below.

## Build sequence — the three pieces

1. **Migration NNN_violations_current_stage_hearing_notice.sql**
   - DROP existing `violations_current_stage_check` constraint and re-ADD
     it with `hearing_notice` and `legal_referral` added to the allowed set
     (matching the violation_letters.stage_at_send superset).
   - Same migration: GRANT verification on any new helper view if added
     (CLAUDE.md scar: new tables/views need explicit grants).
   - No data backfill needed -- existing rows are already in the allowed set.

2. **Vantaca parser map**
   - `lib/enforcement/vantaca_violation_import.js` already has a stage-name
     mapper. Extend it:
     - "Pending Hearing" -> `hearing_notice`
     - "Certified Letter Notice" / "Certified Letter" -> `certified_209`
     - "Second Notice" -> `courtesy_2`
     - "First Notice" -> `courtesy_1`
     - "Owner Response" -> per the PDF those 2 rows appear closed; treat as
       informational, don't open new violation rows
   - The constraint-validator in `tests/test_vantaca_extraction.js`
     (`loadCanonicalStages()`) must continue to fail any emission not in
     the live CHECK set. After the migration, hearing_notice will be in
     the set and the test passes.

3. **Fixture + test**
   - Drop the Waterview Vantaca PDF as
     `tests/fixtures/vantaca-violations/waterview-pending-hearing-2026-05.pdf`
     (Ed will need to attach in the new chat -- the prior chat's analysis
     summary is in the transcript but the binary is not).
   - `expected-counts.json`: min/max bands of 110-125 first notice, 50-58
     second notice, 32-36 certified, 32-36 hearing. PDF/AI extractions get
     tolerance bands per CLAUDE.md.
   - Per CLAUDE.md three-confirmations rule, "done" requires: (a) LOPF
     fixture still passes, (b) this Waterview fixture passes, (c) the
     CHECK validator accepts every emitted stage.

## After import lands

Run the Inspect tab -> "Month-end violations report" chip for Waterview
with as_of = 2026-05-31. Expect ~240 rows grouped by street, with the
hearing-stage 34 showing as `hearing_notice` chips on a maroon background
(the renderer already has the color for that stage).

That's the customer-facing end goal: a board-packet-ready report
covering Waterview's historical state from Vantaca, indistinguishable
from a natively-trustEd-managed community's report.

---

## What shipped in this session (so the new chat doesn't re-do it)

Commit log on `main` since session start (most recent first):

| SHA       | Subject                                                              |
|-----------|----------------------------------------------------------------------|
| 3eb8533   | Violations report: fix BRAND import (destructured returned undefined)|
| ae144e3   | Violations report: standalone page bypasses modal-script-scope risk  |
| 0c0a5f2   | Violations report: drop speculative columns + surface real error     |
| acf355f   | Surface month-end report button at top of Inspect tab                |
| 84c6448   | Month-end violations report: point-in-time stage by street + house   |
| 6088198   | Upload-on-behalf: degrade gracefully when dedup column missing       |
| f3cf5d9   | Auto-link applications to master plans when data becomes valid       |
| e867e98   | Dedupe byte-identical PDF re-uploads on upload-on-behalf             |
| bd2e16b   | Raise builder ARC upload-on-behalf cap to 50 MB                      |
| eb66d43   | Multi-PDF upload for Builder ARC upload-on-behalf                    |

### Open punch list at session end

- **Apply migration 229** (`source_pdf_sha256` column on builder_applications)
  -- Ed needs to click Admin -> Apply pending migrations. The endpoint is
  defensive (degrades to no-dedup if column missing), but until applied
  Karla's batch re-runs won't dedupe.
- **Manual Deploy on Render** -- last push (3eb8533) shipped the BRAND
  import fix on the violations report. Ed clicked once already after an
  earlier push and got `community_not_found`, then `Cannot read properties
  of undefined (reading 'service')`. The 3eb8533 fix is the last one
  needed for the report to actually render.
- **Karla's 14-PDF DRB run** -- not yet sent. Auto-link backfill ran
  successfully (5 apps now fast-track), multi-file upload + 50MB cap +
  defensive dedup all live. Once migration 229 is applied + Render
  deploys 3eb8533, Karla is unblocked.

## Strategic frame Ed set this session (read these memory entries)

- `project_consistent_enforcement.md` -- the fair-housing + franchise moat
- `feedback_cost_consciousness_defaults.md` -- Ed pushed back on a daily
  integrity sweep because we're still small. Event-driven invariants
  instead of background polling.
- `feedback_audit_the_class.md` + `feedback_scar_check_before_done.md` --
  applied four times this session (composite-PK, stale-link, zero-mismatch
  filter, BRAND import). Pattern: I keep shipping forward on manual scar
  checks instead of automated invariants. Ed's franchise-grade comment:
  the system should catch its own contradictions before any operator sees
  them. Three-layer prevention model proposed (continuous integrity sweep
  -> render-time sanity check -> pre-deploy fixture corpus); Ed approved
  Layer 2 + 3 plus event-driven hooks for Layer 1 (no scheduled sweep).
  Not yet built; standing backlog after Waterview import lands.

## File map for the active task

- `lib/enforcement/vantaca_violation_import.js` -- the parser
- `api/enforcement.js` -- /vantaca-violations/preview + /finalize endpoints
- `migrations/050_drv_and_memory_foundation.sql` -- holds the CHECK
  constraint to extend (line 287, `current_stage TEXT CHECK ...`)
- `tests/test_vantaca_extraction.js` -- regression runner
- `tests/fixtures/vantaca-violations/` -- fixture corpus
- `lib/enforcement/violation_report.js` -- shipped this session; consumes
  the violations table and will render Waterview hearing-stage rows
  automatically once the migration + parser are in.

---

Ed's standing rules apply (commit + push on every code edit in
hoa-doc-search; tell him what to click; don't ask for code reviews;
audit the class on every fix). The `MEMORY.md` index has the full set.
