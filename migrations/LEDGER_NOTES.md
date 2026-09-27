# Migration ledger notes

**Append-only.** Add entries at the bottom; never edit or delete an existing entry.
This file explains every place where the migration files, the `schema_migrations`
tracker, and production disagree, so nobody "fixes" history by rewriting it.

## The rule (enforced)

A migration file is **immutable once it lands on `main`**. To change behaviour,
write a new migration with the next number. `scripts/check_migration_immutability.js`
(part of `npm test`) fails the build if any file on `main` is modified or deleted
after it first landed there. A file that has not reached `main` yet (for example
one still being revised on a feature branch) is not checked.

The only exceptions are the historical edits listed below, each pinned to its
current content so it can never change again.

---

## 2026-09-27: historical edits made before the rule existed

Found by the migration-tracker reconciliation (see also migration 468).

### A. Tracker records a different version than the file (2)

These two are the only files whose `schema_migrations.sha256` differs from the
file on `main`. The tracker rows were deliberately **left unchanged**.

**`227_portal_manager_builder_scope.sql`**
- Recorded: `ff0f79ae9288…`, the original version (commit `e92de6bc`, 2026-06-16 19:02 CDT).
- File now: `d1e60ab44c4b…` (commit `748c0d19`, 2026-06-16 19:06 CDT).
- The original made `(portal_user_id, builder_company_id)` the primary key, which
  forces `builder_company_id` NOT NULL and blocks portfolio-wide grants. It
  **failed** when the in-app runner applied it (19:04). The runner's bulk
  "acknowledge" button then cleared the error, so the row reads
  `applied_by = "acknowledged by …"` with the original's hash. The broken original
  never took effect.
- The fix (synthetic `id` primary key plus partial unique indexes) was committed at
  19:06 and applied through the SQL editor as
  `RUN_NOW_227_builder_manager_scope.sql` (commit `9eb5f2a5`, 19:12).
- Production reflects the **fixed** version: the `id` column exists and there are
  6 active portfolio-wide (NULL builder) grants, which the original key made
  impossible. Verified read-only 2026-09-27.
- Impact: none. The tracker row is historically inaccurate (it names a version that
  failed), and that is recorded here rather than overwritten.

**`435_presentation_artifact_type.sql`**
- Recorded: `528061cb36e0…`, the original (commit `80fc8e10`, 2026-09-20 08:44 CDT),
  applied successfully 09:05 CDT.
- File now: `81f3e6bfa369…` (commit `296be474`, 09:11 CDT).
- The only change adds `NOTIFY pgrst, 'reload schema';`, a one-time signal to the
  API layer. It leaves nothing in the schema.
- Production reflects the original's schema (`presentation_instances.artifact_type`
  is live). Impact: none.

### B. Edited on main before being applied (25)

Each was fixed on the same day it first landed on `main`, before it was applied.
For every one, the tracker's recorded hash equals the current file, so the
applied version is the current version. No action needed; listed for completeness.

| Migration | First on main | Last edit (same day) | Tracker |
|---|---|---|---|
| 012_documents_module | 23f70cb8 · 2026-05-10 | 0f2e1613 · rename 'documents' to 'library_documents' | = current (2026-05-30) |
| 013b_documents_unify_hotfix | fba23d89 · 2026-05-10 | 1d401275 · make standalone | = current (2026-05-30) |
| 027_arc_historical_decisions | 0c9bed8c · 2026-05-12 | 49508df0 · drop document_id FK | = current (2026-05-30) |
| 051_view_lat_lng | 8ae1610d · 2026-05-18 | 3a4a7bd4 · append lat/lng to view | = current (2026-05-30) |
| 055_interactions_printed_at | 38aad96b · 2026-05-18 | 729eece9 · fix column refs | = current (2026-05-30) |
| 076_property_summary_view | 400964a3 · 2026-05-20 | 1389563f · fix inspections → properties | = current (2026-05-30, acknowledged) |
| 085_dedup_properties_function | 66ce463f · 2026-05-21 | bd5337d9 · DROP function before CREATE | = current (2026-05-30) |
| 091_reserve_today_view | a9a2037f · 2026-05-21 | 9bc2970b · fix view replacement | = current (2026-05-30) |
| 093_reserve_view_with_amenity_operating | cc761acb · 2026-05-21 | 9bc2970b · fix view replacement | = current (2026-05-30) |
| 094_vendor_contract_category | 1c4c8c45 · 2026-05-21 | c76cb362 · typical_frequency value | = current (2026-05-30) |
| 121_community_map_audit_and_acks | 22d4fe79 · 2026-05-28 | 13602ef6 · remove NOW() from index | = current (2026-05-30) |
| 147_community_default_geo | 47d85d51 · 2026-06-02 | bfe80814 · don't seed defaults | = current (2026-06-02, acknowledged) |
| 151_community_website_url | 4d30cc8d · 2026-06-03 | 62fabfd8 · seed Waterview URL | = current (2026-06-03) |
| 219_violation_continuations | db588456 · 2026-06-13 | b27949cd · owner_name location | = current (2026-06-14) |
| 278_add_postage_drv_category | 4ed5cec0 · 2026-07-10 | 2aa201c6 · current USPS rate | = current (2026-07-10) |
| 322_violation_field_checks | 096543a0 · 2026-07-20 | be867f12 · cert re-verify rule | = current (2026-07-20) |
| 361_property_summary_canonical_balance | cc000104 · 2026-08-11 | 9fe95830 · DROP+CREATE view | = current (2026-08-11) |
| 363_chamber_meeting_broadcasts | e994acdb · 2026-08-12 | 96536721 · two modes | = current (2026-08-12) |
| 385_board_learning | b0b7372b · 2026-08-25 | b068750a · staff review surface | = current (2026-08-25) |
| 390_amenity_security_and_sports_fields | d36ce10c · 2026-08-26 | 9e04f784 · multi-phase pool hours | = current (2026-08-27) |
| 391_drama_creek_demo_amenities | 411f0b5a · 2026-08-26 | 9e04f784 · multi-phase pool hours | = current (2026-08-27) |
| 418_voice_route_bedrock_number | 77adbb58 · 2026-09-12 | e5ef2183 · keep test number off | = current (2026-09-12) |
| 434_acc_async_clarification | adef5baf · 2026-09-19 | a70c9d35 · typed ownership review | = current (2026-09-20) |
| 460_same_day_sequential_resale | f8a2a9b8 · 2026-09-24 | cae6a23d · guard: LOPF control by date | = current (reconciled 2026-09-27) |
| RUN_NOW_karla_drb_consolidate | b5ee2ab6 · 2026-06-16 | 608d87b1 · auto-detect canonical | = current (2026-06-17) |

Note on 460: its tracker hash equals the current file because the 2026-09-27
reconciliation recorded it that way. Independent proof that the current version is
live: the production `approve_ownership_proposal` body matched the current file
byte for byte in the read-only diagnostic. The later edit only changed a guard.

### C. RUN_NOW scripts in this folder

`RUN_NOW_*.sql` files are one-off paste-and-run scripts that were kept alongside the
migrations. They are covered by the same immutability rule. New one-off scripts
should not be added here; write a numbered migration instead.
