# trustEd migrations

Versioned SQL migrations for trustEd's Supabase Postgres database. Apply in order.

## What's here today

| File | Purpose |
|---|---|
| `001_foundation.sql` | Tenancy root (`management_companies`), `communities`, `contracts`, `agent_runs` (the AI trade tape — P3), `kill_switches`, RLS scaffolding |
| `002_bedrock_billing.sql` | Bedrock Billing module: contract fee tables, `invoices`, `invoice_line_items`, `invoice_events`, `vantaca_activity_imports` |
| `003_waterview_seed.sql` | Seeds Waterview Estates + the Jan 2025 fee schedule, drawn directly from the executed contract + Exhibit A |

Future migrations (in order they'll likely land):
- `004_financial_review.sql` — `financial_packages`, `gl_*`, `analytical_findings`, `finding_responses`
- `005_board_packet.sql` — `packets`, `packet_sections`, `packet_renderings`

## How to apply

You're not running the Supabase CLI today, so the simplest path is the Supabase SQL editor:

1. Open Supabase → SQL Editor → New query
2. Paste the entire contents of `001_foundation.sql`, hit Run
3. Repeat for `002_bedrock_billing.sql`, then `003_waterview_seed.sql`
4. Each file is **idempotent** — safe to re-run if you need to redeploy

After 003 runs, verify with:

```sql
-- Bedrock + Waterview should be present
SELECT name FROM management_companies;
SELECT name, vantaca_code FROM communities;

-- Active contract version + escalator
SELECT version, effective_date, escalator_kind, escalator_pct
FROM contracts
WHERE community_id = 'a0000000-0000-4000-8000-000000000001';

-- Fixed monthly should sum to $6,712 (matches Oct 2025 fixed invoice)
SELECT description, monthly_amount FROM contract_fixed_items
WHERE contract_id = 'b0000000-0000-4000-8000-000000000001'
ORDER BY sort_order;

-- Owner charges should show the corrected $50 / $35 / $35 rates for the
-- three line items historically billed at $25
SELECT category, description, fee_amount FROM contract_owner_charges
WHERE contract_id = 'b0000000-0000-4000-8000-000000000001'
ORDER BY sort_order;

-- Full fee schedule view (3 fixed + 9 reimbursable + 8 owner_charge = 20 rows)
SELECT section, description, amount, billing_method
FROM v_contract_fee_schedule
WHERE contract_id = 'b0000000-0000-4000-8000-000000000001'
ORDER BY section, sort_order;
```

Once those pass, the API endpoints in `api/billing.js` will work against Bedrock + Waterview.

## Leakage finding — read before next manual billing cycle

The Jan 2025 fee schedule updated three line items that the historical invoices (Jan 2026, Aug 2025) were still billing at the old 2017 rates:

| Category | Old (2017) rate on invoices | Current (Jan 2025) contract rate | Per-unit gap |
|---|---|---|---|
| Assessment Certified Demand Letter | $25.00 | **$50.00** | $25 |
| Deed Restriction Certified Demand Letter | $25.00 | **$35.00** | $10 |
| Insufficient Check Charge | $25.00 | **$35.00** | $10 |

At Waterview alone, certified-letter volume runs 25–28/month — roughly **$250–700/month, $3K–8K/year leaked** at the old rates. Across all communities at similar volumes, conservative range is $15K–60K/year.

This seed file uses the **current Jan 2025 rates**. Drafts produced by `POST /api/billing/communities/:id/draft-invoice` will pull these correct rates by category. Recovering past under-billing is a separate operational decision, but **the next manual billing cycle should also be corrected forward** — don't wait for the system to catch up.

## Contract hygiene flags worth eventual cleanup

Captured in the seed comments and in the contract row's `notes` field:

1. **Signatory and notice address are stale.** The 2017 contract names Jacey Jetton (no longer with Bedrock) at the old Mason Rd Richmond address. Notice clause directs legal notices there. Re-paper or amend notice clause when Waterview's board cycle allows.
2. **Confirm whether the 2026 CPI escalator was applied.** Article V allows `max(CPI%, 5%)` annually with Board approval. We don't have a 2026 fixed invoice in the audit set yet — confirm whether the bump was taken or skipped.
3. **`communities.total_lots` is NULL for Waterview.** Annual statement billing is `$3.00/platted lot + postage`, so we need this filled in before the annual mailing cycle. Update with: `UPDATE communities SET total_lots = <count> WHERE vantaca_code = 'WV';`

## Track 2 / multi-tenant note

`server.js` already references `BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001'`. The foundation migration seeds Bedrock with that exact UUID, so existing endpoints continue to work without code change.

When auth lands (P1+P2), the `BEDROCK_MGMT_CO_ID` constant in `api/billing.js` is the one place to swap for a JWT-derived lookup. The RLS policies are already written against `auth.jwt() ->> 'management_company_id'`, so they'll activate automatically.

## What's NOT in this round

- **UI tab.** Bedrock Office > Client Billing tab in `public/index.html` will land in the next push.
- **Vantaca activity import endpoint.** `POST /api/billing/activity-import` (with multer) will land alongside the UI to populate activity-invoice quantities automatically.
- **PDF rendering.** Invoice PDFs will use Puppeteer (later push) — same render stack the Board Packet will use.
- **Leakage detection.** The five anomaly checks (zero-where-never-zero, quantity outliers, event-driven category emergence, postage-to-certified ratio, YoY same-month) need 2–3 months of historical activity data before they're useful. Schema is ready for them.
- **AI involvement.** No `agent_runs` writes yet because no AI calls in v0. When draft narratives or anomaly summaries land, every call will write to `agent_runs`.
