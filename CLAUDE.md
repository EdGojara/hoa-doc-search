# CLAUDE.md — Engineering operating rules for trustEd / Bedrock Intelligence

> This file is read by Claude Code on every session in this repo. It encodes
> the engineering discipline that's been earned through real production scars.
> Treat it as standing context, not a TODO list. If you're tempted to skip a
> rule "just this once," that's exactly when the rule matters most.

---

## The Prime Directive

**Works-when-you-test-it ≠ done.**

Before claiming any feature is complete, walk through the **Done Checklist**:

1. **Empty / null / malformed input** — what happens when fields are blank,
   columns are missing, the user types punctuation in a number field, or the
   API returns `{}`? Don't ship code that only handles the happy path.
2. **Access scope** — who can read this data? Every endpoint that returns
   homeowner data must filter by `community_id` (or auth-scoped equivalent).
   Service-role keys never reach the browser. Demo mode never exposes real
   community data.
3. **Silent failure paths** — what fails without throwing? Database
   constraint that doesn't match? AI returns malformed JSON? File upload
   succeeds in storage but DB insert fails? Add explicit logging at every
   such junction — at minimum a `console.warn` with structured context.
4. **Scale** — what changes at 50 communities × 1000 properties each, vs.
   today's 7 × 500? Unbounded queries become outages. `SELECT * FROM
   properties` without LIMIT is a smell. Loops over `await` in JS are slow
   at scale even when fast on a demo.
5. **Gold standard satisfied** — for catastrophic-output surfaces (DRV
   letters, ACC decisions, estoppels, financial postings, board packets),
   does the rendered output still match the locked gold-standard reference?
   If you changed letter copy, does it still satisfy Texas §209 wording
   requirements from GLOBAL_RULES?

**Push back rather than ship if the request invites a failure on any of these.**
Tell Ed clearly what the risk is and propose the safer path. Silent
compliance is the wrong move — encoded in `feedback_no_code_review.md`,
Ed isn't reading the code, so the engineer voice has to come from you.

---

## What this codebase is

- **Product**: trustEd — operations platform for Bedrock Association
  Management (and eventual franchise operators). HOA management
  end-to-end: DRV, ACC, accounting (mirror of Vantaca), reserve studies,
  homeowner portal, board portal, vendor management, ARC, amenity rentals.
- **Jurisdiction**: Texas (Property Code Chapter 209). Statutory wording
  is non-negotiable. Letters that should cite §209.0064 cure rights must
  cite them exactly.
- **Stack**: Node.js + Express + Supabase (Postgres) + Anthropic API +
  OpenAI (embeddings) + Resend (email) + Stripe Connect (non-assessment
  payments) + Leaflet/Esri (maps).
- **Frontend**: vanilla HTML/JS — no framework. Brand styling from
  `public/brand.css` and lib/brand.js.
- **Auth**: HMAC-signed magic-link cookies for homeowner portal. Staff
  auth via separate flow. Service role used server-side only.

---

## Single Source of Truth — the canonical-location table

| Fact | Lives in | Anti-pattern |
|---|---|---|
| Brand tokens (colors, fonts, gold #D4AF37) | `lib/brand.js` + `public/brand.css` | Hard-coding hex values inline |
| Physical lot address | `properties.street_address` (normalized) | Storing mailing address here (we hit this 2 weeks ago — see migration 084-087) |
| Mailing address | `contacts.mailing_address` | Co-mingling with property address |
| Reserve study baseline values | `reserve_components` table (immutable after import) | Mutating baseline RUL/cost as years pass |
| Reserve study "today" values | `v_reserve_components_with_totals` view (computed) | Storing computed values in the table |
| Operating contract data (vendor, cost, dates) | `amenities` table | Duplicating onto `reserve_components` |
| Vendor invoice PDFs | `library_documents` (category=`vendor_invoice`) | Random storage paths |
| Vendor contract PDFs | `library_documents` (category=`vendor_contract`) | Same |
| Governing docs | `library_documents` (category=`declaration_ccrs` / `bylaws` / etc.) | Inline copies in API responses |
| Statutory letter wording (§209, etc.) | injected at render time from `GLOBAL_RULES` | Hard-coding in letter templates |
| Per-community portal config | `communities.portal_module_config` JSONB | Hard-coding tile lists |
| Per-community trash schedule | `communities.trash_schedule` JSONB | Hardcoding in portal HTML |
| Per-community contact directory | `community_contacts` table | Linking out to per-community websites |

When in doubt: **one fact = one canonical row.** Other surfaces reference it
by FK; they do not duplicate it. See memory note
`feedback_single_source_of_truth.md`.

---

## The two architectural rules that govern almost everything

### 1) Two-stage data flow: extract → validate → render

Any time data enters the system from a messy source (PDF, Excel, email, OCR,
user free-text), the flow is:

1. **Extract** into a structured shape — JSON schema, typed object, or
   table row. This is the *only* step that touches raw input.
2. **Validate** against business rules — required fields, allowed ranges,
   referential integrity, CHECK constraints. Reject + surface diagnostic
   info before persisting.
3. **Render** for any output (UI, PDF letter, email, board packet) from
   the validated structured form. Renders never freestyle from raw input.

Statutory wording (Texas §209 cure language, etc.) injects at render time
from `GLOBAL_RULES` — never lives in the extracted data and never gets
freestyled by a model.

**Why this matters**: it gives us one place to fix bugs (validation),
one source of truth for legal wording (GLOBAL_RULES), and one render
pipeline per output type so formatting is reproducible.

### 2) Integration depth before breadth

When choosing between "add a new module that stands alone" vs. "deepen
links between existing modules," depth almost always wins. Each new FK
between existing tables multiplies the value of every existing FK. See
memory note `project_integration_depth_moat.md`.

Concrete signals you're shorting depth:
- A new table with no FK to existing tables
- A new admin page with no link from related pages
- An AI extraction that doesn't ask "what does this connect to?"
- A board's question requires opening 3 pages to answer

The audit-trail target is: **board question → source PDF in ≤3 clicks.**

---

## Record ownership — tag at schema-design time, not after

Every table that holds operational data falls into one of three buckets.
Decide at schema-design time, before the first INSERT:

| Bucket | Owner | On termination | Examples |
|---|---|---|---|
| `association_record` | The HOA | Must be exported and handed over (typically 15-30 days per management agreement) | Governing documents, board minutes, financial books, member roster, executed vendor/insurance contracts, ARC files, correspondence sent on behalf of the association, sign-in sheets + ballots, reserve study reports |
| `workpaper` | Bedrock | Not transferable. Bedrock IP. | AI judgment outputs (multi-persona lens analyses, triangulations), internal playbook entries, portfolio-wide vendor benchmarks, Bedrock University materials, draft letters never sent, email-triage classifications, memory layer / encode-Ed data, internal staff notes |
| `mixed` | Splits at export time | Export rule: anything **delivered to a board member or homeowner** is `association_record`. Anything **internal to Bedrock's production process** is `workpaper`. | Board packets (delivered=theirs, underlying portfolio data=ours), vendor recommendation memos (sent memo=theirs, supporting AI analysis=ours), drafted compliance letters (sent=theirs, drafting history=ours), AI extractions (source PDF=theirs, structured JSON=ours) |

**When adding a new table:**

1. Decide which bucket it belongs to. Document in the migration's
   leading comment block.
2. If single-class, table-level documentation is enough. If `mixed`,
   add a `record_ownership` column on the row so the export tool can
   filter.
3. Confirm the community FK is present and queryable — community-scoped
   termination export depends on it.

**Why this matters now**: an HOA termination 18 months from now should
be a 30-second export, not a forensic archaeology project. The
industry's "we don't get most of what we should on takeover" pattern
(documented in memory) is the failure mode Bedrock must not become —
both because it's wrong, and because being the clean-export operator
is a board-pitch differentiator when we're on the takeover side
complaining about a sloppy predecessor.

Workpaper carve-out language must also be explicit in the management
agreement itself — the schema discipline alone doesn't protect us if
the contract sloppily says "all records relating to the Association."
Standing attorney brief at `templates/legal/workpaper-carveout-memo.md`.

---

## Anti-patterns we've already hit — don't repeat

Each of these is a real scar. The rule is "don't do this because [actual bug we shipped]."

### PDF text extraction: never use pdf-parse for form PDFs

**Scar**: 2026-05-21, 90 minutes burned on the Swim Houston contract
extraction. pdf-parse only reads base PDF text, which on interactive
Adobe forms is just underscores (`$_____` not `$84,829.44`). The values
sit as form-field overlays that pdf-parse silently ignores.

**Rule**: For any PDF that might be an Adobe form (vendor contracts,
invoices, applications, etc.), send the binary directly to Claude using
the SDK's `document` content type:

```js
const response = await anthropic.messages.create({
  model: 'claude-sonnet-4-5',
  max_tokens: 2000,
  messages: [{
    role: 'user',
    content: [
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf',
                  data: req.file.buffer.toString('base64') },
      },
      { type: 'text', text: prompt },
    ],
  }],
});
```

pdf-parse is fine as a fallback for page count or scanned-flat-PDF cases.
It is never the primary path for forms.

See `feedback_diagnostic_first_debugging.md` and `api/amenities.js`
extract-contract endpoint for the canonical implementation.

### ON CONFLICT DO NOTHING without a unique constraint

**Scar**: Migration 096's seed used `ON CONFLICT DO NOTHING` to make
re-runs safe. There was no unique constraint to conflict against, so
the clause silently became a no-op. Re-running the migration created
duplicate rows. Migration 098 cleaned up.

**Rule**: Before writing `ON CONFLICT DO NOTHING` or `ON CONFLICT (cols)
DO UPDATE`, confirm the target table has a UNIQUE constraint or index on
the columns you're conflicting against. If not, add one in the same
migration *before* the INSERT.

### Removing HTML elements without grepping for JS references

**Scar**: 2026-05-21, the amenities admin map "went away" because I
removed the old month-only `<select id="fld-seasonal_open_month">`
elements but left `$('fld-seasonal_open_month').value = ...` lines in
the JS. `null.value = ...` threw a TypeError that crashed `renderEditor`
before `initMap()` was ever called.

**Rule**: When removing a DOM element (input, button, container, etc.),
grep the file for its id BEFORE deleting. Every reference must either be
deleted, replaced, or guarded with `?.`. Same rule applies to renaming
ids.

### CREATE OR REPLACE VIEW after schema changes

**Scar**: Migration 091's `CREATE OR REPLACE VIEW
v_reserve_components_with_totals` failed because migration 089 had added
columns to the underlying table, which shifted column positions in the
view's `rc.*` expansion. PostgreSQL refused with "cannot change name of
view column."

**Rule**: When a view's SELECT uses `tablename.*` and the underlying
table has gained columns since the view was first created, use
`DROP VIEW IF EXISTS <name> CASCADE; CREATE VIEW <name> AS ...` instead
of `CREATE OR REPLACE VIEW`. Always confirm with `SELECT * FROM
information_schema.view_column_usage` if uncertain whether anything
depends on the view (CASCADE handles dependents safely if there are none).

### DROP VIEW loses GRANTs — must re-issue

**Scar**: Migration 100 used DROP + CREATE to update the view's column
list. The original view (migration 088) had
`GRANT SELECT ... TO authenticated, service_role`. After DROP + CREATE,
those grants were lost and the API silently returned empty arrays
because the service_role couldn't SELECT. Filter counts in the UI all
showed 0, and the map went blank — same symptom Ed hit on 2026-05-22.

**Rule**: Whenever a migration does `DROP VIEW + CREATE VIEW`, re-issue
the `GRANT SELECT ... TO anon, authenticated, service_role` statements
that were attached to the original view. Standard pattern:

```sql
DROP VIEW IF EXISTS my_view CASCADE;
CREATE VIEW my_view AS SELECT ...;
GRANT SELECT ON my_view TO anon, authenticated, service_role;
```

The grant is idempotent — safe to re-run in a follow-up migration if it
gets forgotten.

### CHECK constraint values that don't exist in the constraint

**Scar**: Migration 094 inserted `typical_frequency = 'multi_year'`
into `document_categories`. The CHECK constraint only allowed
`('one_time','annual','quarterly','monthly','event_driven','perpetual')`.
The migration failed with a constraint violation.

**Rule**: Before INSERTing into a table with CHECK-constrained columns,
read the constraint and confirm your value is in the allowed list. If
you need a new value, either expand the constraint OR pick the closest
existing one. Don't invent values.

### Mailing address ≠ property address

**Scar**: The Vantaca import was writing the *mailing address* (where the
owner gets their bills) into `properties.street_address` (which is the
*physical lot location*). This caused two distinct properties owned by
the same person — at the same mailing address — to dedupe into one
property. We had to reverse the merges and rebuild from a different
Vantaca export. See migrations 084-087.

**Rule**: `properties.street_address` is the **physical lot**. Always.
The mailing address (where statements go) lives on `contacts.mailing_address`.
Never co-mingle. Imports from external systems (Vantaca, etc.) must
classify both fields explicitly.

### Vector silos

**Scar**: Pre-2026-05-20, the codebase had grown 4 parallel vector
embedding stores (`match_*` RPCs in different domains). Discovered
during the unified-architecture audit.

**Rule**: All new features that use embeddings write to the unified
`documents` table with `source_type` discriminator. Never create a new
`*_embeddings` table or `match_*` RPC. See `feedback_no_new_silos.md`.

### Generic vendor APIs / generic error messages

**Scar**: Multiple places where error messages from upstream APIs leaked
to the homeowner-facing UI ("Failed to query Stripe" / "Supabase 500").
These are scary and unhelpful for non-technical users.

**Rule**: Every endpoint that returns an error to the UI uses
`safeErrorMessage(err)` (in `api/_safe_error.js`). This sanitizes
upstream noise and returns a brief, user-friendly message. Detailed
errors go to server logs only.

### Showing tiles as "live" without enabling them in the gate

**Scar**: 2026-05-21, added the Local Contacts tile to MODULES but
forgot to add it to `defaultDemoModuleConfig` AND the per-community
`portal_module_config` JSONB. Tile rendered as "Coming soon" instead of
clickable. Took a migration to fix.

**Rule**: When adding a new tile to `MODULES` in `public/portal.html`,
two-step enable:
1. Add `<key>: { status: 'live' }` to `defaultDemoModuleConfig()`
2. Ship a migration to default it on for existing community configs:
   `UPDATE communities SET portal_module_config =
   COALESCE(portal_module_config, '{}'::jsonb) || jsonb_build_object(
   '<key>', jsonb_build_object('status', 'live')) WHERE NOT
   (portal_module_config ? '<key>')`

### Diagnostic-first debugging (the 90-minute lesson)

**Rule**: When a feature stops working in production, the FIRST move is
"show me the data the code is seeing" — not "let me try a different
prompt / regex / timeout." Surface debug samples in the API response.
Log raw model output server-side. For text extraction, return excerpts
near key markers. Confirm the input matches your assumptions before
changing the processing. See `feedback_diagnostic_first_debugging.md`.

---

## Database conventions

- **Migrations are immutable once shipped.** Never edit a migration file
  that's been applied to production. Write a follow-up migration with a
  higher number.
- **Migrations are sequentially numbered** (`NNN_description.sql`).
- **Every migration is wrapped in `BEGIN; ... COMMIT;`**.
- **Idempotent by default**: `IF NOT EXISTS` on CREATE statements,
  `ON CONFLICT DO NOTHING` only with a unique constraint, `WHERE NOT
  EXISTS` guards on seed INSERTs.
- **Foreign keys: explicit ON DELETE behavior.** Prefer `RESTRICT` for
  audit-relevant references (reserve_expenditures, payments,
  library_documents links). `SET NULL` only when the parent is
  genuinely optional. `CASCADE` only when the child is a pure detail of
  the parent (e.g., `reserve_funding_plan` rows of a `reserve_study_version`).
- **CHECK constraints** on enum-like text columns. Catch bad values at
  insert time, not at runtime.
- **Triggers**: use the existing `trusted_set_updated_at()` function for
  any table with an `updated_at` column.
- **Indexes**: index foreign key columns + any column used in WHERE on
  hot endpoints. Partial indexes (`WHERE status='active'`) for filtered
  hot paths.
- **Never DROP a column with data** without an explicit migration that
  archives or migrates the data first. Deprecate columns in place
  (stop writing to them, document the deprecation, drop in a later
  migration if truly unused).

---

## API endpoint conventions

- **Mount path**: routers mount at `/api/<feature>` in `server.js`.
- **JSON body limit**: 64kb default (`express.json({ limit: '64kb' })`).
  Higher only when needed (uploads use `multer`).
- **Auth scoping**: every endpoint that returns or modifies homeowner
  data filters by `community_id` (or auth-scoped equivalent). Never
  trust client-provided `community_id` without verifying the user has
  access.
- **Service role** (`SUPABASE_KEY` env var pointing at the service role)
  is server-side only. Never returned to the client.
- **Errors**: `res.status(500).json({ error: safeErrorMessage(err) })`.
  Detailed error logged with `console.error('[<feature>] <action>
  failed:', err.message)`. Stack traces never leak to client.
- **Field validation**: required fields checked at the top of the
  handler with `if (!body.x) return res.status(400).json({ error:
  'x_required' })`.
- **Update endpoints (PATCH)**: use an `allowedFields` array and copy
  only those into the patch object. Never `update(req.body)` raw.
- **List endpoints**: always paginate or hard-cap (`limit(2000)`)
  unless the table is intrinsically small.

---

## AI extraction conventions

- **Always send the PDF binary**, not pre-extracted text (see scar above).
- **Always log the raw model response** server-side:
  ```js
  console.log('[<feature>] Claude returned:', JSON.stringify(extracted));
  ```
- **Always return `raw_extracted`** in the API response (a copy of the
  model's output BEFORE any post-processing). Lets us debug whether
  failures are at the model layer or the post-processing layer.
- **Always include diagnostic samples** in the response when the
  extraction returns null/empty for an expected field. Show what text
  was around the key markers. This is what unblocked the Swim Houston
  debug cycle.
- **Always have a fallback** for critical fields. Even if Claude is
  perfect 95% of the time, the 5% failures hit billion-dollar
  consequences for HOA management. Regex / heuristic / largest-dollar
  scan / etc. as a safety net.
- **Model name**: `'claude-sonnet-4-5'` is the standard. Don't change
  per-feature without a reason.

---

## Catastrophic-output surfaces (require the schema + gold-standard pattern)

These features produce outputs where bugs end up in court or in front of a
boards' attorneys. Each one MUST follow the extraction-schema +
gold-standard-template + GLOBAL_RULES-injection pattern:

| Surface | Status | Gold-standard reference |
|---|---|---|
| DRV / violation letters | TBD — add schema + template | `templates/violation-letter.gold-standard.md` (to be added) |
| ACC approval / denial decisions | TBD | `lib/builder_letter.js` exists for builder ARC; resident ACC needs same treatment |
| Estoppels | not yet built | TBD |
| Assessment statements | not yet built | TBD |
| Board packets | partial — `api/board_packets.js` | curated-not-comprehensive (see memory) |
| 1099s / W-9 collection | not yet built | TBD |

**Pattern**: each surface has three files:
1. `templates/<surface>.schema.json` — extraction validator
2. `templates/<surface>.gold-standard.md` — locked template with
   `[GLOBAL_RULES.xxx]` markers where statutory wording injects
3. `lib/<surface>_renderer.js` — single rendering pipeline from
   validated structured input to final artifact

---

## Frontend conventions

- **No framework** — vanilla HTML/JS. Adding React/Vue/etc. is a
  conversation, not a default.
- **Brand styling** comes from `public/brand.css` (loaded everywhere)
  and `lib/brand.js` (server-side renderers). Never hard-code colors.
- **Demo mode** — every customer-facing surface supports
  `?demo=1&community=<slug>` URL params. The page renders mock data
  scoped to the demo community and never touches real data. Demo mode
  is the franchise sales asset (see `project_homeowner_portal_as_showcase.md`).
- **Layer toggle on maps**: every Leaflet map uses the same 3-button
  toggle (🛰️ Hybrid / 📷 Satellite / 🗺️ Street) with Esri tiles. See
  `public/reserve-map.html` for the canonical implementation.
- **Tile gates**: new portal tiles must be enabled in BOTH
  `defaultDemoModuleConfig` AND the per-community config (see scar
  above).
- **Sub-nav pattern**: feature modules with multiple pages share a
  module-subnav (see Reserves cluster: Components / Map / Invoice
  review / Import). One platform-nav tab, one consistent sub-nav.

---

## Memory + GLOBAL_RULES (related layers)

This file is for engineering rules. Strategic principles and product
discipline live in two other layers:

- **Memory notes** at `C:/Users/edget/.claude/projects/C--Users-edget/memory/*.md`
  — strategic principles, product discipline, customer-context guidance.
  These are the "why" behind the code. Read them when designing new
  features.
- **GLOBAL_RULES** — Ed's existing pattern for content rules (Texas §209
  wording, brand voice, tone). These inject at render time on
  customer-facing artifacts. Code references them; doesn't duplicate or
  paraphrase them.

When a request touches both layers (e.g., "build a violation letter
generator") — the engineering rules in this file govern the code; the
memory + GLOBAL_RULES govern the artifact's content.

---

## Communication style with Ed

- Ed doesn't read code. Don't ask for a code review.
- Ship edits, then tell him what to click to verify in the UI.
- Be brutally honest about tradeoffs. Don't sandbag the truth to seem
  agreeable.
- Why-before-what. Lead with the reasoning, then the implementation.
- When something stops working, diagnose-first. Show the actual data
  before proposing fixes.
- Long answers are fine when warranted. Walls of text without structure
  are not.

See `feedback_collaboration_style.md` and `feedback_no_code_review.md`.

---

## The "would-an-engineer-yell-at-me" test

Before claiming any feature is done, ask yourself: **what would an experienced
engineer reading this code yell about?**

Common answers:
- "No tests for this."
- "Where's the rate limit?"
- "This loop awaits inside `.map()` — it'll be slow at scale."
- "You're trusting client-side data to determine access."
- "This will hit a constraint violation if X happens."
- "The frontend assumes this field exists but the API may return null."
- "You deleted X but didn't search for everywhere X is used."
- "This regex doesn't match what the input actually looks like."

If the answer is "an engineer would yell about something specific," fix
that thing before claiming done. If you genuinely can't think of
anything, ask: "what's the simplest input that breaks this?" There's
usually one within 30 seconds of looking.

---

## When to STOP and push back

Tell Ed clearly + propose alternative when:

- A feature would mutate baseline data that's supposed to be immutable
  (reserve study line items, signed letter templates, etc.)
- A query would unbounded-iterate at scale
- A new endpoint exposes data without proper community-scoping
- A migration would drop a column that has live data
- A schema change would require a backfill we haven't designed
- A new dependency adds significant attack surface for marginal value
- A new module would create a silo when the same data already exists
  elsewhere

Pushing back is the engineering equivalent of the lens-based judgment
Ed already uses on product decisions. Memory notes about multi-persona
judgment apply to code reviews too.

---

*Last reviewed: 2026-05-21 after the Swim Houston extraction debug cycle
and the Local Contacts shipping. Update when new scars are accumulated.*
