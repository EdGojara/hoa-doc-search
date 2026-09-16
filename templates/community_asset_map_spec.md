# Community Asset & Project Map — build spec

**Status:** proposed (demo prototype built 2026-09-15). Ready to schedule.
**Origin:** Cinco (CLMA) prospect pitch; also fixes the amenity map-placement pain and covers residential HOA common areas. See memory `project_community_asset_map`, `project_cinco_landscape_prospect`.

## Goal
Plot what a community *maintains* — monuments, entry signage, esplanades/setbacks, irrigation zones, seasonal color beds, streetlight runs, detention ponds, trails, amenities — as real geographic features (points/lines/polygons), each tied to its vendor contract, spend, condition, and reserve lifecycle. Board question ("what do we pay for on that corner?") → source contract/invoice in ≤3 clicks.

Two problems it solves at once:
1. **Pitch centerpiece** for landscape/infrastructure districts (CLMA) and any HOA with common areas.
2. **Retires amenity geocoding-drift** — assets are hand-placed against imagery, not geocoded by address.

## Non-goals
- Not a parcel/property map (that already exists — inspection map).
- No new vector/embedding silo. No enforcement/ACC coupling.

## Data model — `community_assets` (new table)
One row per maintained asset. `mixed` record-ownership (delivered map views = association; internal cost analysis = workpaper) — tag at schema time per CLAUDE.md.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| community_id | uuid fk → communities | **required, indexed** (scoping) |
| management_company_id | uuid | |
| category | text CHECK | monument, entry_signage, esplanade, irrigation_zone, color_bed, streetlight_run, detention_greenbelt, trail, amenity, other |
| name | text | |
| geometry_type | text CHECK | point / line / polygon |
| geometry | jsonb | GeoJSON coordinates (validated on the geometry_type) |
| condition | text CHECK | good / due / active / unknown |
| reserve_component_id | uuid fk → reserve_components NULL | lifecycle/replacement (existing SSOT) |
| amenity_id | uuid fk → amenities NULL | when the asset IS an amenity (operating contract SSOT) |
| primary_vendor_id | uuid fk → vendors NULL | vendor under contract |
| notes | text | |
| created_by / created_at / updated_at | | trusted_set_updated_at trigger |

- **Spend is derived, not stored** — sum vendor invoices linked to this asset/community/category for YTD; don't duplicate GL. Add `asset_id` (nullable) to vendor invoice line linkage, OR compute by vendor+category+community for v1.
- **GRANTs in the same migration**: `SELECT,INSERT,UPDATE,DELETE` to service_role; `SELECT` to authenticated (CLAUDE.md GRANT scar).
- Geometry validation at the extract→validate boundary before insert (reject malformed GeoJSON; cluster-check points against the community centroid — reuse the geocoding cluster rule so a mis-placed point is flagged, not silently 10 mi away).

## API — `/api/community-assets`
- `GET /?community_id=` → assets (paginate via fetchAllQuery; community-scoped; never trust client community_id without access check).
- `POST /` → create (allowedFields; validate geometry).
- `PATCH /:id` → update (allowedFields).
- `DELETE /:id`.
- `GET /:id/detail` → asset + derived YTD spend + linked invoices + reserve timeline + last/next work.
- All staff-gated; admin-gate the write/editor endpoints.

## Frontend
1. **Viewer** (`public/…` page, or a tab on the community): reuse the shared Leaflet + Esri component (public/reserve-map.html pattern) with the 3-button basemap toggle. Render points as category pins, lines as colored polylines, polygons as filled areas; **color by condition** (good/due/active). Legend + KPI header (assets / spend YTD / due / active). Click → detail panel (vendor, contract, YTD spend, last/next work, reserve timeline). Prototype already built: scratchpad `cinco_assets_map.html`.
2. **Editor** (admin): **click-to-drop a point / draw a line or polygon** on the imagery, then tag category/condition/vendor/reserve link. This is the piece that fixes amenity placement — hand-place once, locked to real geometry. Use Leaflet draw or a minimal custom draw handler (no heavy GIS dep).

Note: map tiles are external image requests, so this ships as a **platform page**, not an Artifact (artifact CSP blocks external tiles).

## Phasing
- **P1 (demo polish, hours):** refine the standalone prototype for the CLMA pitch (logo, a few more real monuments). No backend.
- **P2 (MVP, real):** `community_assets` table + migration + GRANTs; GET/POST/PATCH/DELETE; viewer page reading live rows; admin click-to-place editor. Seed CLMA + one residential community's common areas.
- **P3 (live money):** link vendor invoices → assets; derive YTD spend and last/next work from real AP + work orders; reserve lifecycle from reserve_components. Retire amenity address-geocoding in favor of hand-placed geometry.

## Reuse / anti-silo checklist
- Shared Leaflet/Esri map component (not a new map stack).
- FK to reserve_components + amenities + vendors + vendor invoices (depth, not duplication).
- Spend derived from GL/AP SSOT, never re-keyed.
- Community-scoped queries + paginated reads (fetch_all helper).
