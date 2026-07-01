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

## Bedrock voice persona — Claire

**Name**: Claire. Chosen 2026-05-23. The "clarity" association lines up with
Bedrock's transparency thesis (audit trails, visible reserve health, decisions
shown not hidden — see `project_competitive_thesis.md` and the board-portal
work). Two syllables, clean for TTS, common enough to feel human without
claiming to be a specific Bedrock employee.

**Honest-AI rule**: every opener identifies Claire as AI. Never pretend to be
a specific human. The brand opener is:

> "Hey, this is Claire from Bedrock — AI assistant for [Community Name].
>  What can I help with?"

This is the rule across every voice surface: when the system answers a call,
the first sentence MUST identify it as Bedrock's AI assistant. No exceptions,
no "let's see if they notice" experiments. Per the memory note
`feedback_no_claude_branding.md`, the platform IS Bedrock AI — "Claude"
never appears in user-facing text or function names. Claire is the persona;
the underlying model is internal plumbing.

**Human handoff**: never "press 1." Always offered conversationally
("Want me to put you through to someone on the team?"). Phone trees grate;
offered handoff feels respectful. Partial Stage-1 brief always accompanies
the warm transfer so the receiving human has context — solves the #1 customer-
service frustration ("please repeat everything").

**Tone is the SAME as the email/chat casual tone** that shipped 2026-05-23
(`TONE_CASUAL_ADDENDUM` in server.js). Banned-phrase list applies. Specificity
+ brevity + honesty are the human signal; no fake typos or fake casualness.

**Voice surfaces NEVER touch compliance outputs.** Same scoping discipline as
the casual-tone toggle. Claire cannot grant a waiver, decide a violation, or
assert a legal position. Anything touching enforcement / §209 / fines /
deadlines forces a handoff to the human team. See
`templates/responder-engine.spec.md` §8.

Implementation in `lib/voice/` (persona, bridge, transcribe, reason, speak,
handoff, call_log). Migration 103 creates `voice_phone_routes` and
`homeowner_calls`.

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

### Parallel retrieval silos — hybrid is not optional

**Scar**: 2026-05-22. Ed asked askEd "what's Canyon Gate's quorum?" and got a
hedge ("I don't have the specific number — check Vantaca"). Meanwhile the
Documents tab would have surfaced the answer instantly because it does
keyword search. Two retrieval paths on the SAME `documents` table:

- `getRelevantChunks` (askEd) — pure vector search via `match_documents` RPC
- `api/ask.js` / Documents tab — pure ILIKE keyword search

Each missed what the other found. Vector search ranked the longer
"reconvening rule" chunk above the actual "twenty-five percent (25%)" chunk
because both contained "quorum" and the longer one had more contextual
filler around the embedding vector. Keyword search would have returned both.
Two algorithms on one table = unpredictable outputs depending on which
surface the user happens to land on. That's the parallel-silo failure
pattern Ed has explicitly named in memory.

**Rule**: `getRelevantChunks` now does **three-way hybrid retrieval**:

1. **Vector** — embedding search via `match_documents` (concept matching)
2. **Keyword** — per-keyword fanout with multi-keyword re-rank and filename
   boost (exact-fact matching)
3. **Title-match** — search `library_documents.title` for query keywords,
   pull ALL chunks of docs whose title strongly matches. Title-match docs
   are scored by DISCRIMINATING keyword matches (keywords NOT in the
   community name, so "quorum" in a title is signal but "canyon" is just
   community noise).

Results merge via Reciprocal Rank Fusion. Title hits get 3× weight (a doc
literally titled "Amendment to Bylaws Regarding Quorum" should always
surface on a quorum question). Final output is the top 18 unique chunks
across all three sources, with source tags exposed on each chunk header
(`matched title+vector+keyword`).

When building any new retrieval surface in this codebase: **don't ship a
new keyword-only or vector-only search.** Either use the central
`getRelevantChunks` or follow the same hybrid pattern. Parallel silos
on the same data are a bug.

### Diagnostic-first debugging (the 90-minute lesson)

**Rule**: When a feature stops working in production, the FIRST move is
"show me the data the code is seeing" — not "let me try a different
prompt / regex / timeout." Surface debug samples in the API response.
Log raw model output server-side. For text extraction, return excerpts
near key markers. Confirm the input matches your assumptions before
changing the processing. See `feedback_diagnostic_first_debugging.md`.

### IIFE script-wrap before dependency defined

**Scar**: 2026-05-24, Owner AR community dropdown stuck on "Loading…"
forever — blocked Ed mid-AR-test-flow for ~10 min of debugging. Root
cause: an IIFE at `public/index.html` line 8444 tried to wrap
`window.switchTab` to add an auto-load-on-tab-open hook, but
`switchTab` itself is defined at line **14932** — ~6,000 lines later.
The IIFE's defensive guard `if (typeof orig !== 'function') return;`
bailed silently during page parse. The auto-load never fired.

This pattern is used in **8 places** in `index.html` (lines 3950, 8152,
8444, 12380, 18128, 20864, 20985, 21007). The four BELOW 14932 work
fine; the four ABOVE silently no-op the same way Owner AR did. Symptom:
a tab opens but its "auto-load on first view" data never populates —
dropdowns stuck on placeholder text, lists empty when they should fill.

**Rule**: When wiring auto-load / tab-open / page-init logic via
script-tag IIFEs that depend on functions defined elsewhere, ALWAYS
guard with DOMContentLoaded retry (not just an early-return):

```js
function _wireSwitchTabHook() {
  const orig = window.switchTab;
  if (typeof orig !== 'function') return false;
  window.switchTab = function (tab) {
    const r = orig.apply(this, arguments);
    if (tab === 'mytab') { autoLoadMyTabData(); }
    return r;
  };
  return true;
}
if (!_wireSwitchTabHook()) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wireSwitchTabHook);
  } else {
    // DOM ready but dep still missing — retry next tick
    setTimeout(_wireSwitchTabHook, 0);
  }
}
```

Anti-pattern is the naive IIFE with silent return. When you spot the
silent-return pattern in `index.html` (or anywhere else this technique
is used), promote it to the retry pattern above. The Owner AR fix in
commit `4cf01c3` is the canonical example.

Better long-term fix: hoist `function switchTab(tab)` to the TOP of
`index.html`'s script tags so all subsequent IIFEs can wrap it safely.
Risky to do as a single sweeping change (the function references other
helpers defined later); doing it incrementally per-tab as bugs surface
is the pragmatic path.

### Preview screens that show counts without cross-checking against truth

**Scar**: 2026-06-01, the bedrock-vote bridge Preview returned 1000
voters for Waterview when the actual roster was 1171. PostgREST defaults
to a 1000-row response cap and the bridge query never asked for more.
The Preview rendered the truncated number as if it were the answer.
Ed caught the mismatch because he knows Waterview's home count by heart.
The platform did not. A live push would have shipped a ballot universe
missing 171 owners — and "we synced what the system told us" is not a
defense the board would accept.

**Rule**: every Preview / dry-run / export surface that displays a count
or roster MUST cross-check that count against an independent canonical
source in the same query, in the same response. The pattern:

1. Query the truth source separately (e.g.,
   `SELECT count(*) FROM properties WHERE community_id = $1` for voter
   counts; equivalent canonical source for whatever is being previewed).
2. Compare to the count being displayed.
3. If they diverge, flag loudly in the UI — a red banner, not a footnote
   — and refuse the destructive action on the server with HTTP 409.

The server check is non-negotiable. A UI-only warning is bypassable;
the 409 makes "ship anyway" structurally impossible. Fix layer added in
commit `0a1c5cf`.

**Encode-Ed lens**: the system has to know what Ed knows, or the
platform is just a faster way to make consistent mistakes. Every Preview
is a moment where domain knowledge must be encoded into a query, not
left to the operator's memory. If a human's gut would catch the
discrepancy, the system has to catch it first — otherwise the franchise
operator without Ed's instinct ships the bug.

Generalize: any surface that shows N of something downstream of a
filterable / paginated / capped query is a candidate for this rule.
Look for `.limit()`, default page sizes, `range()` calls, and any place
the displayed number could silently undercount.

### Date strings across system boundaries — must combine date + time + TZ

**Scar**: 2026-06-03, the trustEd → bedrock-vote bridge was sending
`end_date: "2026-06-22"` (date only, no time, no timezone) for the
voting cutoff. bedrock-vote parsed this as midnight UTC, which displays
as 7:00 PM the PREVIOUS day in Central time. Result: an election
configured in trustEd to close June 22 at 4:00 PM Central was displayed
on the bedrock-vote admin card as "Closes Jun 21." Ed caught it by
eyeball on the bedrock-vote card. The franchise operator who doesn't
have Ed's instinct would have shipped the mailing with the platform's
displayed-correctly cutoff, and a voter trying to cast at 3:55 PM
Central on June 22 (BEFORE the configured 4:00 PM cutoff) would have
been refused. That's a Texas §209 disenfranchisement issue that voids
the entire election when challenged.

**Rule**: any date that crosses a system boundary (trustEd → bedrock-
vote, trustEd → Resend email, trustEd → Vantaca, etc.) MUST be sent as
a full ISO timestamp with timezone offset, NEVER as a date-only string.
The receiver cannot guess the timezone correctly. Use the canonical
helper `_toCentralTimestamp(date, time)` in server.js — combines a
date + time + Central offset (CDT/CST resolved by calendar date) into
`'YYYY-MM-DDTHH:MM:SS-05:00'` shape. Format-on-display in
`America/Chicago` everywhere ("Monday, June 22, 2026 at 4:00 PM
Central").

**Encode-Ed lens**: surfacing the parsed-in-Central display string on
the Preview AND the success popup is required so the operator can
sanity-check before the mailing goes out. The cross-check rule from
"Preview screens that show counts" generalizes: every value that flows
across a boundary must display in canonical human-readable form on
both sides. If a human's gut would catch the mismatch, the UI has to
catch it first — silent ship is the failure mode.

Concrete code smell: any `cycle.something_at` or `cycle.something_date`
passed directly into a fetch body without combining with the `_time`
sibling field. Any `.toISOString().slice(0, 10)` that ends up in an
outbound payload. Any external API call where the date field's value
doesn't include both an explicit time component AND an explicit
timezone offset.

Fixes landed in commits `e68a3bb` (helper + bridge payload) and
follow-up (preview + success-popup display cross-check).

### New tables without service_role GRANTs are silently unwritable

**Scar**: 2026-06-08, hit this THREE TIMES in one evening:
- `vantaca_imports` (migration 168) — fixed by migration 196
- `transaction_upload_batches` + `homeowner_transactions` (migration 195) — fixed by migration 200

Pattern: a migration creates a new table the API will write to, but
forgets the `GRANT` to service_role. Default privileges don't propagate
cleanly across migrations in this Supabase setup. The Node.js API uses
the service role key for all writes; without an explicit GRANT, Postgres
rejects every INSERT/UPDATE/DELETE with:
```
permission denied for table <name>
```

This shows up as "extraction succeeded but downstream write failed" in
extractor pipelines, or as silent 500s on direct endpoints. The error
message is clear once you see it — but the developer typically doesn't,
because the failure happens deep in a side-effect chain and the
extractor returns "Completed" anyway.

**Rule**: Every migration that creates a NEW TABLE the Node.js API will
write to MUST include explicit grants in the SAME migration:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON <new_table> TO service_role;
GRANT SELECT                          ON <new_table> TO authenticated;
```

If the table is read-only by the API, drop INSERT/UPDATE/DELETE. If it's
operator-only and never client-facing, drop the authenticated grant.

This pairs with the existing "DROP VIEW loses GRANTs — must re-issue"
rule above. Both reduce to: **never assume Postgres will pick the right
privileges; always state them.**

### Supabase 1000-row silent truncation

**Scar**: 2026-06-01, hit the same bug **7 times across two repos** in
one afternoon. Supabase's PostgREST layer enforces a 1000-row response
cap by default. `.range(0, 9999)` and `.limit(5000)` are silently
clamped server-side — no error, no warning, just a truncated array.
First caught when trustEd's bridge preview returned 1000 voters for
Waterview against a roster of 1171 (the Preview cross-check rule above
fired because Ed knew the home count by heart). Audit of bedrock-vote
then surfaced six more endpoints with the same bug:

| Endpoint | Truncated query |
|---|---|
| `/archive` | voters + ballots + audit_log |
| `/audit/export` | audit_log + ballots |
| `/qrcodes` | voters |
| `/mailing` | voters |
| `/results` | **ballots — the live vote tally** |
| `/pending-proxies` | ballots |
| `/audit` | audit_log |

At Waterview's size every one of those was silently capping. `/results`
would have under-tallied a live election. Under-tallied election
results land in court.

**Rule**: any "fetch all rows for X" query must page through with a
helper. bedrock-vote uses `fetchAllRows(buildQuery, pageSize=1000)` —
loops 1000-row pages until a partial page comes back, safety cap at
100k rows. hoa-doc-search uses a paginated `.range()` loop with the
same shape. Single-row lookups via `.single()` and bounded queries with
an explicit `.limit(N)` where N is small (≤ a few hundred for UI lists,
top-of-leaderboard, etc.) are fine — the rule kicks in the moment the
query is "everything for community X" or "everything for election Y"
without a real upstream bound.

Concrete code smell: `.select(...).eq('community_id', X)` or
`.eq('election_id', X)` with no `.single()` and no small `.limit()` —
that endpoint is silently capped right now. Same goes for `.in('id',
bigArray)` style joins where the joined table could exceed 1000.

Fixes landed in bedrock-vote commit `bc27f1b` and hoa-doc-search
commit `dd1cb30`. The pagination helper is the canonical pattern; any
new endpoint in either repo MUST use it.

**Encode-Ed lens**: same shape as the Preview cross-check rule above —
the system has to catch the truncation, not the operator's domain
knowledge. Ed knew Waterview had 1171 voters; the franchise operator
working a 1500-door portfolio two years from now will not have every
roster size memorized. Make it structurally impossible to ship a
truncated result: the helper everywhere, no per-endpoint heroics, no
"I'll remember to add `.range()` next time."

### Live UI: don't wipe before you have the replacement; rehydrate from the server

**Scar**: 2026-06-30, Laurie was mid-drive on the Inspect tab at Still Creek
when the house pins vanished and she couldn't tap to capture. Three distinct
faults, one incident:

1. **Clear-then-fetch wipe.** `inspMapLoadProperties` removed every map marker
   FIRST, then fetched `/api/inspections/properties`, silently swallowing
   failures (`catch (_) {}`). A single dropped request on a moving tablet
   (cellular blip) cleared all 344 house pins and never restored them — capture
   blocked mid-drive. Fix: fetch FIRST; only clear+rebuild on a successful,
   non-empty response. On failure (or empty while pins are already on screen),
   keep the on-screen pins, show a non-blocking "couldn't refresh — retrying"
   status, and retry on a timer. Commit `95d11dd`.

2. **Client-only state lost on reload.** The GPS breadcrumb (`routePingsAll`)
   and the route polyline lived only in browser memory. A close/reopen (resume)
   started the trail blank even though every ping was saved server-side — the
   operator's "where I've driven" coverage looked gone. Fix: on resume,
   rehydrate from the server (`GET /:id/route-trace`) and redraw. (Covered
   houses already restored — from photos; the trail did not.) Commit `0f0e188`.

3. **1000-row cap on the trail read** — a live instance of the Supabase
   truncation scar above. `GET /:id/route-trace` was an unpaginated select; at
   1,191 pings it returned only the first 1,000, so even the rehydrated trail
   ended ~191 points early. Fix: page through with `.range()` until a short
   page.

**Rules**:
- **Never destroy rendered UI before its replacement is confirmed in hand.**
  Fetch → confirm non-empty → THEN swap. A failed/empty refresh must leave the
  last good render in place, never a blank screen. Same family as "DROP VIEW
  loses GRANTs → map went blank" and "preview shows 0 on a capped query": a
  blank/zero state must never be the silent result of a transient failure.
- **Anything the operator relies on across a reload rehydrates from the
  server.** Client-side accumulators (trails, buffers, selection state) are a
  live cache, never the source of truth. On resume, reload them — and confirm
  the read isn't itself capped (point 3).
- Mid-drive surfaces get this scrutiny first: an inspector on cellular WILL hit
  dropped requests and WILL close/reopen the tab. Build for it.

### Category dedup / grouping must be alias-aware (canonical, not raw)

**Scar**: 2026-07-01, 7610 Wolf Creek. A property carried TWO open trash
violations — native `trash_visible` (courtesy_2) and Vantaca
`trash_cans_recycling_containers` (courtesy_1) — the same real-world issue
under a **confirmed category alias**. A courtesy letter fired at courtesy_1
while the property was effectively further along; on other properties one
duplicate sat at **certified §209** while its twin was at courtesy_1 (a
courtesy re-notice on a certified case voids the §209 process). Root cause:
`findOrContinueViolation` — the single documented chokepoint every
violation-creation path calls first — keyed its open-case lookup on the
**raw** `primary_category_id` (`.eq`), so a re-observation under a sibling
alias label missed the open case and opened a DUPLICATE. `getCanonicalCategory`
existed but was **never called**; `_reconcileAliasedOpenViolations` only ran
once at alias-confirm time, so any violation created afterward re-split.

**Rule**: anywhere enforcement **dedups, groups, or picks a stage** by category
(intake continue-vs-open, the property §209 open-case panel, letter-stage
determination), expand to the confirmed alias group
(`expandCategoryToAliases`) and act on the CANONICAL set — never the raw
`primary_category_id` alone. When choosing which open case a re-observation
continues, pick the **furthest-advanced** stage (never continue a courtesy
case when a certified one is open for the same issue). The confirmed alias is
the source of truth that two labels are one violation; every consumer must
honor it, not just prior-counting. Fix: `lib/enforcement/find_or_continue_violation.js`
(commit 3a0f0e2) + re-ran `_reconcileAliasedOpenViolations` on the backlog.

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

## Extraction surfaces — the staff-self-serve pattern (Ed 2026-06-10)

Any feature where a file (CSV / PDF / XLSX / email / image / etc.) gets
parsed into structured rows is an **extraction surface**. Vantaca
violations, county appraisal CSVs, financial statements, estoppel
requests, ARC submissions, insurance dec pages, vendor invoices,
governing docs — all extraction surfaces.

Standing requirement before any extraction surface ships, and before
any change to one:

### 1) Permanent fixture corpus + regression test runner

Real production files become permanent test cases. Pattern:

```
tests/fixtures/<surface-name>/
  <community-slug>-<period>.<ext>     ← real file from a customer
  expected-counts.json                ← min_rows / max_rows / stage
                                       distribution / known-row asserts
  README.md                           ← how to add a new fixture
tests/test_<surface-name>_extraction.js
```

Every staff-blocking import shape becomes a new fixture + JSON entry.
Adding a fixture is a 30-second drop-in (file in dir, 5 lines of JSON,
re-run) — no test code changes. The runner is wired to `npm test` so
every change to the extractor runs the full corpus before merging.

PDF / AI-based extractions get tolerance bands (min/max), not exact
counts — they're non-deterministic by nature. Catch real failures
(zero rows, truncation, missing-row assertions) without flapping on
normal model variance. Single deterministic surface (CSV / XLSX) is
the strict assertion path.

**Canonical reference**: `tests/test_vantaca_extraction.js` +
`tests/fixtures/vantaca-violations/`.

### 2) Self-diagnosing UI on every parse failure

When extraction fails, the UI does NOT show a bare error string.
The error response includes a `diagnostic` object:

```js
return res.status(400).json({
  error: '...',
  diagnostic: {
    headers,                  // what we saw
    sample_rows,              // first 3 data rows
    auto_detected_mapping,    // what auto-detect found (per field)
    required_fields,          // what we need
    help,                     // one-line plain-English instruction
  },
});
```

The frontend renders this as an inline panel with:
- A data preview table (first 3 rows × all columns, with column numbers)
- A dropdown per required field showing every column with header+sample
- An "auto-detected" / "required" / "optional" badge per row
- A "Retry with these columns" button that re-submits with a
  `manual_mapping` form field ({field: columnIndex})

The parser accepts the manual_mapping override and uses it instead of
auto-detect. Single shared row-extraction code path (the override and
auto-detect cannot silently diverge).

**Canonical reference**:
- Backend: `lib/enforcement/vantaca_violation_import.js`
  (`parseVantacaViolations(buffer, filename, { manualMapping })`)
  + `api/enforcement.js` POST `/vantaca-violations/preview`
- Frontend: `public/index.html` `inspVViPreview` / `inspVViRenderDiagnostic`
  / `inspVViDiagnosticRetry`

### Why this matters

Every extraction surface is a place where domain shape varies wildly
across real files. The first version always handles the file in front
of us. The second file is shaped slightly differently and the import
breaks for staff. Old loop: staff escalates to Ed → Ed digs in → Ed
ships a one-off patch → next file breaks differently. That loop is
the encode-Ed problem applied to the platform's resilience instead of
its judgment. See memory `project_ed_not_in_loop_test`.

**New default**: the system surfaces what it saw + lets staff resolve.
Every new file shape Laurie sees that breaks either works OR she can
fix it cold via the override dropdowns in 30 seconds, no Ed in the
loop. The file then becomes a fixture so it never breaks again.

### 3) The three-confirmations rule before declaring "done"

**Scar**: Ed 2026-06-10 evening. Vantaca import was declared "fixed" after
Lakes of Pine Forest (~900 properties, only courtesy_1/2 + certified_209
stages) passed end-to-end. Then Waterview (1,171 properties, hearing
process steps in source data) surfaced three NEW bug classes my fixture
suite structurally could not catch:

1. The 1000-row PostgREST truncation — invisible because the only
   fixture community was below the cap.
2. Invented enum values (`hearing_pending`, `hearing_notice`) that
   crashed `violations_current_stage_check` — invisible because the
   tests asserted only row counts and stage distribution, not that
   emitted values are actually accepted by the DB.
3. A dedup edge case where hearing process pairs collapsed differently
   than my expectations encoded — passed the test only because my
   expectations encoded wrong values as correct.

**Rule**: "Done" requires three independent confirmations, not one.

1. **Tests pass on the small/easy fixture** — the one the feature was
   developed on. Necessary baseline; never sufficient.
2. **Tests pass on a representative HARD fixture** — for
   property-count-sensitive code, a 1500+ property synthetic community.
   For input-shape-sensitive code, the file shape NOT covered by step
   one. For any code touching CLAUDE.md-named scars, a fixture that
   specifically triggers the scar's bug class. The fixture corpus
   has to make the bug class impossible to ship; the rule alone
   isn't enough.
3. **Output is accepted by the production constraint layer** — query
   the actual CHECK constraint or distinct existing values for any
   enum-like column the parser emits; assert every emitted row's
   value is in that set. Row counts validate "parser produced
   output." They don't validate "output is insertable." For
   `tests/test_vantaca_extraction.js`, the constraint validator
   loads live distinct values from `violations.current_stage` and
   fails the test on any parser emission outside that set.

**When tempted to declare "done" after one fixture passes**, ask: "what
is structurally different about the next case I haven't tested?" Then
test THAT before reporting completion. If a CLAUDE.md scar names the
class but my fixtures don't trigger it, the scar list is decoration,
not discipline.

**Canonical reference**:
- Synthetic large-scale fixture:
  `tests/fixtures/vantaca-violations/synthetic-1500-props-2026-05.csv`
- CHECK constraint validator:
  `tests/test_vantaca_extraction.js` `loadCanonicalStages()` + the
  per-row stage assertion inside `runOneFixture`.

See memory `feedback_test_what_ships_not_what_parses` for the rule's
encoding as a discipline change, not just a one-time fix.

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
