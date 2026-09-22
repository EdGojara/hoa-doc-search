# CLMA Demo Handoff for ChatGPT

**Purpose:** Give ChatGPT enough *actual implementation detail* about the current trustEd platform to independently evaluate what Ed should demonstrate to the Cinco Landscape Maintenance Association (CLMA) board tomorrow morning. This is written from a direct inspection of the code and seeded data as of tonight. No code was changed to produce this.

**How to read this:** Sections 1–8 are **CURRENT IMPLEMENTATION FACTS** (what exists, with file paths, data sources, and click paths). Section 9 is separated into FACTS vs. RECOMMENDATIONS. The 10 decision questions are at the very end.

**One distinction that governs everything below:**
- **`/lma-map.html` (Sterling Ridge Visual Operating Map)** is **dynamic and database-backed** (makes ~7 API calls, reads real seeded relational data). This is the map wired into the presentation's landscape demo.
- **`/clma/*.html` pages (`command-center.html`, `asset-map.html`, `rfp.html`)** are **static hardcoded HTML** (0 API calls). They are polished *capability mockups*, not live software. `rfp.html` even prints: *"Capability demonstration with example bids. In production every figure links to the source page in the bid PDF."*

Getting this distinction right is the single most important thing for tomorrow.

---

## 1. Current CLMA (Sterling Ridge) live demo implementation

**Surface:** `public/lma-map.html` — "Sterling Ridge Visual Operating Map."
**Entry:** Demo Mode launcher (`/demo.html`) → Sterling Ridge → Enter as **Staff** (`/lma-map.html?staff=1`) or **Board** (`/lma-map.html?view_as=board@sterlingridge.demo`). Auth: staff Supabase Bearer JWT, or board view-as; both resolve through `lib/portal/board_access.js`.
**API:** `api/community_map.js`
- `GET /api/community-map/assets?community_id=<LMA>` → assets (GeoJSON) + operational status + district boundary.
- `GET /api/community-map/asset/:assetId/detail` → the full operational story for one asset.

**Data source:** **Database-backed.** Assets come from the `community_assets` table via the `community_assets_geojson(community_id)` RPC (migration 446). Operational status is computed live from `vendor_projects` (joined on `asset_id`) and `ap_invoice_lines` (joined on `project_id`). Seeded by `scripts/seed_demo_lma.js` (16 assets + boundary) and `scripts/seed_demo_lma_ops.js` (vendors, GL, projects, invoices, board motion, events). Sterling Ridge community id = `e0100000-0000-4000-a000-000000000000`, DEMO tenant (`management_company_id` = DEMO).

### The Median 7 chain, step by step

| Step | What the user sees | What can be clicked | What happens after the click | Component / data | Data type |
|---|---|---|---|---|---|
| Map load | Satellite map framed on the district; ~16 assets as colored shapes/pins; a gold dashed district boundary; filter bar (All / Projects / Problems / Upcoming / Completed) + time views (Current / 30d / 90d / This Year); legend; DEMO chip | Filters, time views, any asset, base-layer toggle | Filters/time hide-show layers client-side | `lma-map.html` `loadAssets()` → `/assets`; styling by `map_status` | DB-backed (assets + computed status) |
| Median 7 | A **red (problem)** median near the east entrance monument, labeled "Median 7." Child systems (irrigation, beds, trees, uplighting) render subordinate | Click Median 7 | `openDetail(id)` → `GET /asset/:id/detail`; opens the detail panel | `community_assets` row (condition `poor`) | DB-backed |
| Condition / problem | Panel shows name, condition = **poor**, location "Sterling Ridge Pkwy at Oak (recurring irrigation issues)", status pill = **problem** | — | — | asset row + `mapStatus()` | DB-backed |
| Child system | Panel lists children: **Median 7 Irrigation** (poor), Median 7 Landscape Beds, Median 7 Trees, Median 7 Lighting | Children listed (click-through to a child asset) | Loads that child's detail | `community_assets` where `parent_asset_id = median-7` | DB-backed |
| Project | **"Median 7 Irrigation Controller Replacement"** — stage `work_started`, **65% complete**, approved **$12,500**, vendor **AquaFlow Irrigation** | — | — | `vendor_projects` P1, `asset_id` = m7-irrig | DB-backed |
| Vendor | AquaFlow Irrigation (contact seeded) | — | — | `vendors` V2 | DB-backed |
| Board decision | Board motion **"Approve Median 7 irrigation controller replacement ($12,500)"**, status **passed**, tied to the project | — | — | `board_motions.related_project_id = P1`, status `passed` | DB-backed |
| Financial impact | Progress invoice **AQ-4471 $8,200 (approved)** on this project; plus prior-year **AQ-3980 $3,400 (paid)** on "Median 7 Irrigation Line Repair (2025)" → **$11,600 total irrigation spend across two projects**; GL account **6110 Irrigation Repairs** | — | — | `ap_invoices` + `ap_invoice_lines.project_id` + `chart_of_accounts` | DB-backed |
| History | Project events: "third controller fault this year," "Board approved controller replacement," "AquaFlow began replacement," and the 2025 mainline repair completion | — | — | `vendor_project_events` (4 rows) | DB-backed |
| Action (staff) | A staff geometry editor (place point/line/polygon) and a "report an issue" control | Edit geometry / report | Writes via `community_asset_set_geometry` RPC / `board_map_reports` | staff-only tools | DB-backed, **not for the board demo** |

**Exact recommended click path (live):**
`/demo.html` → **Sterling Ridge → Enter as Staff** → map frames the district → click **Median 7** (red, by the east monument) → detail panel shows condition → the controller project ($12,500 approved, 65%) → AquaFlow → the passed board motion → the $8,200 progress invoice + $3,400 prior repair ($11,600 total) → the event history.

**Incomplete / nonfunctional to know about:**
- The geometry editor and "report issue" are staff tools; fine to have on screen but not part of the story.
- Sterling Ridge has **no seeded `community_budgets`**, so there is no formal budget-vs-actual line (approved-vs-actual is real; a budget tile would read "no adopted budget").
- Placement note: the district was re-geocoded onto a real developed corridor (Northpointe Blvd area, Spring TX) so assets sit on real ground in satellite imagery; the detention basin sits in real greenspace.

---

## 2. Vendor / RFP / proposal system — deeper inspection

**This is the area with the biggest gap between the polished demo and the working software. Evidence:**

### 2a. The landscape RFP comparison the board would be shown is STATIC
**File:** `public/clma/rfp.html` — **0 API calls, all hardcoded HTML.** It renders a normalized 3-bid comparison table. The actual sample data baked into the page:

- **Recommendation (hardcoded):** TerraCare Grounds is the recommended finalist (full acreage incl. irrigation, required insurance, competitive all-in). GreenSpan looks cheapest on base fee but excludes irrigation + 6% escalation → highest true multi-year cost.
- **"What trustEd caught" (hardcoded flags):** cheapest base fee has highest true multi-year cost; two bids exclude irrigation; GreenSpan reserves right to change price (not a firm bid); only TerraCare names CLMA as additional insured.
- **Normalized table (hardcoded values):**

| Compared | GreenSpan (incumbent) | TerraCare (finalist) | Lone Star |
|---|---|---|---|
| Base fee (annual) | $171,000 | $184,500 | $178,200 |
| Seasonal color | $24,800 (extra) | Included | $18,000 |
| **True annual (yr 1)** | **$195,800** | **$184,500** | **$196,200** |
| Acreage covered | 38 ac | 41 ac | 41 ac |
| Pruning frequency | 2x/yr | 4x/yr | 3x/yr |
| Irrigation responsibility | Excluded | Included | Excluded |
| Annual escalation | 6%/yr | 3%/yr | Not stated |
| Insurance / additional insured | Not stated | $2M, names CLMA | $1M |
| Termination notice | 90 days + penalty | 30 days, no penalty | 60 days |
| Price basis | Budgetary, subject to change | Firm | Firm |

- A hardcoded "Decision log" (Sep 12 RFP opened → Sep 15 TerraCare finalist → Pending board vote).

This is a **convincing static artifact**, but there is **no live upload → extract → normalize → compare pipeline** behind this page. Nothing is database-backed; nothing links to a real PDF at runtime.

### 2b. There IS a real dynamic comparison engine — but for INSURANCE, not landscape
**Files:** `lib/insurance_extract.js`, `lib/insurance_compare.js`, `lib/community/amanda_insurance_rfp.js`, `lib/insurance_rfp*.js`, `api/insurance.js`.
`compareInsurancePrograms(current, proposed)` genuinely normalizes two insurance programs and returns `{ premium, lines, dropped, added, limitReductions, property, findings }` (detects coinsurance, limit reductions, dropped/added coverages). This is a working extraction→normalize→compare engine — but it is **insurance-domain**, driven by insurance dec pages, not landscape maintenance bids.

### 2c. Landscape bid analysis exists as a TESTED capability (eval), driven by a memo generator
**Files:** `evals/cases/clma-bid-analysis/case.js`, `lib/vendors/board_memo.js`.
The eval is grounded in CLMA's real 2009 Maintenance Agreement (irrigation is a **core CLMA duty**, so a bid excluding it is a real scope gap). It feeds three realistic bids with deliberate gotchas:
- **Bid A (GreenScape):** lowest headline ($5,800/mo, yr-1 $69,600) BUT 6% escalator AND **excludes irrigation**.
- **Bid B (Lone Star):** $6,450/mo flat 3 yr, yr-1 $77,400, includes irrigation, GL $1M — fully compliant, highest yr-1.
- **Bid C (Cypress):** $5,950/mo, yr-1 $71,400, includes irrigation, BUT GL only $500k — **below the required $1,000,000**.
The design rule (quoted from the case): *"the operator dictates the recommendation, the system lays out the decision-relevant facts (`lib/vendors/board_memo.js`)."* So the model-driven analysis is tested, but there is **no live landscape proposal-upload/extraction UI** wired to it.

### 2d. Vendor records, sample proposal
- **Vendors:** real rows in the `vendors` table — 5 Sterling Ridge demo vendors seeded (GreenScape Partners, AquaFlow Irrigation, Lumina Electric, StoneWorks Masonry, TerraFirma Civil). Surfaced via `api/vendors.js`, `public/portal-vendor-directory.html`, `public/portal-vendor-detail.html`.
- **Sample proposal PDF:** `public/clma/Landscape_Maintenance_Proposal_SAMPLE.pdf` (a sample document; not wired to a live extractor).
- **Board memo generator:** `lib/vendors/board_memo.js` (facts-not-recommendation memo).

**Bottom line for evaluation:** the landscape RFP comparison shown on screen is a **static mockup**; the genuinely dynamic extract/normalize/compare engine that exists is **insurance-specific**; the landscape bid-analysis logic exists as a **model-tested capability + memo generator**, not a live landscape upload/compare screen.

---

## 3. Amanda — how she actually interacts with CLMA data

**Surface:** "Ask Amanda" = `POST /api/board-portal/ask` (`api/board_portal.js`). Same "one brain" as Claire wearing Amanda's face, pointed at the WHOLE community, behind the board door.
**Model:** **live Anthropic `claude-sonnet-4-5` inference** (`ANTHROPIC_API_KEY`). Auth: `requireBoardViewer` + `canSeeCommunity`.
**Design constraint:** **AGGREGATE ONLY** — no individual owner rows by construction.

**What Amanda's context actually contains (from `buildBoardAggregateContext`):**
1. Community profile + live **Key Issues** (`buildCommunityContextBlock`).
2. **Compliance aggregate** from `v_property_summary` (homes, homes with open violations, ARC counts).
3. **AR aggregate** from `v_homeowner_current_balance` + `property_enforcement_states` (owners past due, total outstanding, enforcement counts).
4. **Reserve study** from `v_reserve_community_summary`.
5. **Operating budget** from `community_budgets` + `budget_line_items`.
6. **Governing-doc / Texas-law excerpts** via hybrid retrieval (`getRelevantChunksWithSources`).

**Classification for CLMA:**
- **Works today:** aggregate compliance / AR / reserve / budget questions, and governing-document / Chapter 209 questions grounded in retrieved excerpts, in Amanda's voice, aggregate-only.
- **Partially works (for CLMA specifically):** CLMA is a landscape district with **no homeowners**, so the homes/violations/AR aggregates are largely empty or trivial, and there is no seeded budget → thin snapshot.
- **Intended but NOT implemented:** Amanda's context builder **does not query `vendor_projects`, `community_assets`, vendors, proposals, invoices, or board motions.** So Ask Amanda does **not** currently see the Sterling Ridge asset/project/vendor/financial operational layer that the map shows. Asking Ask Amanda "tell me about the Median 7 controller project" would not be answered from that seeded data — she has no retrieval path to it today.

**Representative context Amanda receives (shape):**
```
Community: <name>
The board member asks: "<question>"
COMMUNITY SNAPSHOT (aggregate):
  <profile + Key Issues>
  COMMUNITY SIZE & COMPLIANCE (aggregate): Homes: N; open violations: X; ARC: ...
  ACCOUNTS RECEIVABLE (aggregate): past due N of M; total outstanding $...; enforcement ...
  RESERVE STUDY (aggregate): components ...; future cost $...; critical 2yr ...
  OPERATING BUDGET (FY, status): revenue $...; expense $...; reserve contribution $...
GOVERNING-DOCUMENT & TEXAS-LAW EXCERPTS: <retrieved chunks or "(none)">
```
There is also `/api/board-portal/learning/ask` (a board "tutor," same model + retrieval) — governance education, not operations.

---

## 4. Financial / project connection — what's real vs conceptual

**The chain Project → vendor → approval → invoice → GL → asset genuinely exists in the data model** (migrations 443 `vendor_projects.asset_id`, 444 `ap_invoice_lines.project_id`, 446 assets RPC), and is exercised by the map's asset-detail endpoint:

| Link | Real FK / field | Evidence |
|---|---|---|
| Project → Vendor | `vendor_projects.vendor_id`, `vendor_name` | P1 → AquaFlow |
| Project → Asset | `vendor_projects.asset_id` | P1 → m7-irrig |
| Project → Approval | `board_motions.related_project_id` + `vendor_projects.approved_cost_cents` | motion "…($12,500)" passed |
| Invoice → Vendor | `ap_invoices.vendor_id` | AQ-4471 → AquaFlow |
| Invoice line → Project | `ap_invoice_lines.project_id` | AQ-4471 line → P1 |
| Invoice line → GL | `ap_invoice_lines.gl_account_id` → `chart_of_accounts` | line → 6110 Irrigation Repairs |
| Actual vs approved | sum(`ap_invoice_lines.amount_cents` where project) vs `approved_cost_cents` | $8,200 progress vs $12,500 approved |

The map's `assetOperationalState()` computes **actual_cents / remaining_cents per project** by summing project-attributed invoice lines, and the asset-detail endpoint returns a **spend rollup** for an asset + its children. So "follow the money back to the work" is **real and demonstrable on the map's detail panel.**

**Only conceptual / thin today:**
- **Budget → actual:** `community_budgets`/`budget_line_items` exist as a model, but **Sterling Ridge has no seeded budget**, so there is no live budget-vs-actual for CLMA. Approved-vs-actual (per project) is real; formal budget variance is not seeded.
- The **GL is an account structure** (`chart_of_accounts` 6100–6140 seeded) with invoice lines coded to it; it is not a full posted general ledger with journal entries for Sterling Ridge.

---

## 5. Map and asset system

- **Sterling Ridge:** `public/lma-map.html`, Leaflet + Esri satellite/street tiles, 3 base layers. Community `e0100000-…`.
- **Median 7:** `community_assets` row, `asset_type` median, condition `poor`, near the east entrance monument; drawn as a pointed esplanade polygon; status red via `mapStatus()`.
- **Asset records:** 16 assets (3 medians, 2 monuments, 2 entrance beds, Median 7's 4 child systems, Median 5 irrigation, Median 3 trees, parkway lighting run, parkway tree corridor, detention basin), each with class/type/condition/location and PostGIS geometry.
- **Pins / status:** `map_status` ∈ problem (red) / in_progress (amber) / upcoming (blue) / completed (green) / ok (grey), computed from the asset's projects.
- **Projects / issues:** from `vendor_projects` (8 seeded) joined by `asset_id`.
- **Irrigation / landscape info:** condition + child systems + the irrigation project + the irrigation GL account.
- **History:** `vendor_project_events` (per project).
- **Documents / photos:** `board_map_reports` (photo_path) surface in the detail panel if present; the asset story itself is projects/motions/events (no per-asset document library seeded).
- **Click behavior:** click asset → `GET /asset/:id/detail` → panel (condition, projects with approved/actual/%, vendor, board motions, events, children, spend rollup, reports). District boundary + `fitBounds` frame the map on load.
- **Partner view:** `public/partner-portal.html?member=<villas>` shows entitled documents for a partner association (separate, document-retrieval surface).

---

## 6. Residential Drama Creek demo

**Surface:** `public/community-map.html` (dynamic, DB-backed). Community `dc100000-…`, DEMO tenant, 376 canonical FBCAD properties.
**Entry:** Demo Mode → Drama Creek → Enter as Staff (`/community-map.html?community=dc100000-…`) or Board.
**API:** `GET /api/community-map/:id/layers?include=drv,ar,occupancy` → reads `v_property_summary`; `GET /api/community-map/property/:id` → per-property detail.
**Data source:** database-backed view (`v_property_summary` aggregates violations, AR snapshot, residency). Populated by `scripts/seed_demo_dc_operations.js` (20 properties with active violations across stages, 19 delinquent accounts across aging buckets, ~273 owner / 35 renter / 68 unknown occupancy). Signature personas preserved.

**Flow:** Map (376 pins, visual hierarchy: quiet normal homes, exceptions flare with a halo) → pick a lens chip (**Violations / Delinquency / Owner-Renter**) → exceptions stand out → click a property → panel shows compliance (open violations + stage), account (balance, at-legal), occupancy.

**Strongest existing record — Greg Yardgone (`DC-40-007`), and why:** he is the only property that lights up on **both** operational lenses at once — **3 open violations** (worst stage `fine_assessed` → red on Violations) **and** **$4,800 at-legal AR** (→ darkest on Delinquency) — and clicking him shows a coherent, multi-signal story (lawn/weeds/fence violations + at-legal balance + owner-occupied). Supporting cast: **Marcus Behindbills** ($2,400, over-120), **Jennifer Lateleaves** (fresh landscaping courtesy + $75), **Tom Investorson** (the signature renter).

**Exact click path:** `/demo.html` → Drama Creek → Enter as Staff → Violations lens (header reads "20 need attention · 376 homes") → click a flared home (Greg) → panel → switch to Delinquency (19 flare, sized by aging) → switch to Owner/Renter (renters stand out).

**What could fail:** requires the latest deploy for the visual-hierarchy styling (frontend) — the *data* is already live, but a stale deploy shows old styling; auth/session (Demo Mode staff Bearer or board view-as) must be valid or the map 401s; Esri tiles are an external dependency.

---

## 7. Current CLMA presentation integration (16 moments)

Source of truth: `lib/presentations/story.js` (`CLMA_SCREENS`), rendered by `public/present.html` (browser) and `lib/presentations/pptx_render.js` (PowerPoint), same content.

1. Cover · 2. **VIDEO Paige** · 3. Where Bedrock came from · 4. The insight (management-company framing) · 5. The result · 6. The breakthrough · 7. **VIDEO Phoebe** · 8. Bespoke at scale (two models) · **9. LIVE DEMO — Residential (Drama Creek)** · 10. The pivot ("CLMA is not a residential HOA") · **11. LIVE DEMO — Landscape (Sterling Ridge / Median 7)** · 12. **VIDEO Amanda** · 13. **VIDEO Kat** (money-trail chain on slide) · 14. **VIDEO Tessa** + full-team reveal · 15. What changes with Bedrock managing CLMA · 16. Close.

**Live demos occur at slide 9 (Drama Creek) and slide 11 (Sterling Ridge).** The transition slides carry launch links: slide 9 → `/community-map.html?community=dc100000-…`; slide 11 → `/lma-map.html?staff=1`.
**Videos (all rendered, ~37s except Amanda ~54s):** Paige→2, Phoebe→7, Amanda→12, Kat→13, Tessa→ slide-14 team reveal.

Pacing shape: story (1–8) → residential proof (9) → pivot (10) → landscape proof (11) → three team videos + reveal (12–14) → outcomes + close (15–16). Amanda's video (12) verbally sets up vendor-proposal comparison; Kat's (13) mirrors the on-slide money chain.

---

## 8. Reliability assessment (identify, don't fix)

- **External services:** Esri tile servers (both maps); Supabase (DB + storage; the five persona videos are hosted as public Supabase Storage URLs, so **playback does not call HeyGen** at presentation time); Anthropic API (only if Ask Amanda / tutor is invoked live).
- **Live model inference:** Ask Amanda (`/ask`) and `/learning/ask` call `claude-sonnet-4-5` live → variable wording, latency, and could answer differently tomorrow. The maps and asset-detail are deterministic DB reads (stable).
- **Could be slow:** first tile load; Ask Amanda round-trip (seconds).
- **Could differ tomorrow:** anything through the live model (Amanda/tutor). Deterministic: maps, asset detail, property detail, the static `/clma/*` pages, the videos.
- **Auth / session dependent:** `/lma-map.html` and `/community-map.html` require a valid Demo Mode session (staff Bearer JWT or board view-as) behind the staff gate; an expired cookie → 401 blank/banner. The static `/clma/*` pages render without API calls but are still served behind the staff gate.
- **Incomplete demo data:** Sterling Ridge has no seeded budget (no budget-vs-actual); Ask Amanda's snapshot is thin for a no-homeowner district; no per-asset document library.
- **Unfinished / non-story UI:** the `lma-map.html` staff geometry editor and "report issue" controls; `/clma/command-center.html` + `/clma/rfp.html` are static (no drill-down beyond what's printed).
- **Dead controls:** none that break, but the static `/clma/` pages imply interactivity ("each figure links to its source page") that does not exist at runtime — do not click into them expecting a PDF.
- **Could expose something unwanted:** while inside Demo communities (Drama Creek / Sterling Ridge) everything is fictional and outbound is suppressed. **Risk = navigating away from the demo tenant** — the same staff login can reach real client communities (real names, balances, AR). Staying inside Demo Mode is the guardrail.

---

## 9. FACTS vs. RECOMMENDATIONS

### CURRENT IMPLEMENTATION FACTS (summary of the evidence above)
- Sterling Ridge map + Median 7 chain (asset → condition → project → vendor → board motion → invoices/GL → history) is **real, relational, database-backed**, and demonstrable through the map detail panel. Canonical numbers: **$12,500 approved** controller project (65%, AquaFlow, board motion passed); **$8,200** progress invoice + **$3,400** prior repair = **$11,600** irrigation actual across two projects; GL 6110.
- The landscape **RFP comparison screen (`/clma/rfp.html`) is a static mockup**; the real dynamic extract/compare engine is **insurance-domain**; landscape bid analysis exists as a **tested model capability + memo generator**, not a live landscape upload/compare UI.
- **Ask Amanda is aggregate-only, live-model, and does NOT currently read the asset/project/vendor layer.**
- Drama Creek residential map is real and DB-backed; **Greg Yardgone** is the strongest single record (violations + at-legal on one property).
- Five persona videos are rendered and hosted on Supabase (no HeyGen dependency at showtime).

### YOUR (Claude's) RECOMMENDATIONS — clearly separated, for ChatGPT to weigh
- **Lead the CLMA proof with the live Sterling Ridge map → Median 7**, because it is the one place where real relational data tells the whole "asset → work → money → decision → history" story on screen, deterministically.
- **Show the RFP comparison as a slide/screen narrative, not as "live software"** — it is static. If vendor comparison is central to the pitch, present `/clma/rfp.html` as "here is the analysis Amanda produces," and be ready to say the extraction pipeline is productionizing (the insurance version is already live).
- **Do not invoke Ask Amanda live for Median 7 / vendor questions** — she has no retrieval path to that data today and runs on live inference. Use Amanda/Kat as *videos + the map's own detail panel* for the operational story.
- **Keep the residential demo short** — it exists to prove "same system, different organization," not to sell residential features.
- **Stay inside Demo Mode the entire time** to avoid exposing real client data.

---

## Questions ChatGPT Should Help Ed Decide Tonight

1. **What is the strongest live-demo story?** (Evidence points to Sterling Ridge → Median 7, the only fully DB-backed asset→money→decision→history chain.)
2. **What should Ed actually click and say?** (A tight Median 7 path vs. touring more assets.)
3. **Is the vendor comparison strong enough as-is?** (It is a static mockup for landscape; the real engine is insurance. Show as narrative, or invest tonight?)
4. **What should be improved tonight?** (Minimum-risk, highest-payoff — e.g., a seeded budget line? A second obviously-different asset? Nothing?)
5. **What should absolutely NOT be touched tonight?** (The working map/asset/financial chain and the rendered videos.)
6. **Which demo elements are too risky for a live board presentation?** (Live Ask Amanda; navigating outside Demo Mode; implying `/clma/*` pages are interactive.)
7. **Is the residential demo adding enough value to justify its time?** (It proves the "same system" thesis; is it worth the minutes?)
8. **How should Amanda and Kat be used around the live demo?** (Videos + the map's detail panel, vs. any live interaction.)
9. **Where should Ed stop demonstrating and return to the presentation?** (After the Median 7 money-trail, before anything static/thin.)
10. **What is the minimum work required tonight to make tomorrow exceptional?** (Given the map+videos are solid and the RFP screen is static — the smallest change with the biggest credibility gain.)

---

*Prepared from a direct read of the repository and seeded database. File paths and figures are quoted from the actual implementation. Sterling Ridge, Drama Creek, and the sample vendors/bids are fictional demo data under the DEMO tenant.*
