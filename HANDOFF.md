# Session handoff — 2026-05-25 end-of-day

Heavy day. 8+ arcs shipped across voice, marketing, email infra, and portal.
Start a fresh session for the next conversation — context is heavy and the
next strategic question (homeowner-profile architecture) deserves a clean
slate.

---

## TL;DR

Voice Phase 1B done (Claire ↔ Isabella mid-call language transfer, both
prompts updated, transferCall infrastructure built in streamTurn). Marketing
page (`bedrocktxai.com`) rewritten to demo-funnel model. Email infrastructure
for `bedrocktxai.com` set up on Microsoft 365 (shared mailbox
`hello@bedrocktxai.com` live, first-name aliases for staff in progress).
Homeowner portal got a major operator-tooling pass: multi-property picker,
first-login tutorial, rate-limiting on magic links, bulk-invite + adoption
analytics, per-tile visibility admin (live / coming_soon / maintenance /
hidden), and Financials split into its own tile.

GitHub PAT was leaked in `git remote` URLs — rotated, replaced with `gh auth
login` keyring credential. Twilio token rotation **still pending from
yesterday**.

---

## Pending Ed actions (do these to bring today's work live)

### Critical / security
- [ ] **Rotate Twilio Auth Token** (leaked yesterday in old Render logs
      before the `safeForLogs` fix landed). Twilio Console → API keys →
      regenerate. Update `TWILIO_AUTH_TOKEN` on Render. Still pending from
      yesterday's handoff — nothing today increased the risk but it's been
      live for 24+ hours.

### Deploy today's work
- [ ] **Render Manual Deploy** for `hoa-doc-search` — picks up commits
      `85488bb` through `6748bfb`
- [ ] **Apply migrations 107, 108, 109** in Supabase SQL editor (or via
      `node migrations/apply.js`). Migration list:
  - `107_contacts_preferred_language.sql` — adds language preference for
    Isabella routing
  - `108_portal_tutorial_dismissed.sql` — adds tutorial dismissal flag to
    portal_users
  - `109_portal_financials_tile_default.sql` — defaults Financials tile
    to coming_soon for existing communities

### Email infrastructure (finish what's in progress)
- [ ] Finish adding first-name aliases for staff on `bedrocktx.com`
      (Celina = `celina@`, anyone else who handles homeowner contact).
      Path: M365 admin → Users → Active users → click each user →
      Manage email aliases → add their first name on bedrocktx.com
- [ ] Test send: from your personal email → `hello@bedrocktxai.com` →
      confirm it lands in the Bedrock Intelligence shared mailbox in
      your Outlook. Reply from that folder → confirm reply goes out as
      `hello@bedrocktxai.com`
- [ ] **Bedrock Intelligence shared mailbox** — verify the primary email
      is `hello@bedrocktxai.com` (not `hello@bedrocktx.com`). The Active
      Users list showed `hello@bedrocktx.com` as the displayed username
      which is suspicious. Click into the shared mailbox in admin, check
      the "Username" / primary at top. If wrong, promote the
      bedrocktxai alias to primary
- [ ] (Optional, when you have AppRiver admin time) Add `bedrocktxai.com`
      to AppRiver per Option A from earlier conversation — gives the new
      domain the same security stack as bedrocktx.com (AppRiver + EdgePilot
      in front of Microsoft 365). Without this, `@bedrocktxai.com` runs on
      Microsoft EOP only

### Voice Isabella (when you want to bring her live)
- [ ] **Audition + pick ElevenLabs Spanish voice** at
      elevenlabs.io/app/voice-library. Filter Spanish + Female +
      Conversational. Copy chosen voice ID → set `ISABELLA_VOICE_ID` env
      var on Render
- [ ] **Create Isabella Vapi assistant** per `lib/voice/SETUP_ISABELLA.md`
      (Custom LLM URL = `/api/voice/vapi-llm-webhook-es`, transcriber =
      Deepgram `nova-2-general` with language `es`, voice from above).
      Copy Isabella's assistant ID → set `VAPI_ISABELLA_ASSISTANT_ID` env var
- [ ] **Vapi Squad config** for the bidirectional language transfer:
      Squad with Claire + Isabella as members; register transferCall tool
      on each with the other as destination (lowercase names: `claire` /
      `isabella` — case-sensitive). Point your existing inbound phone
      number at the Squad (not at Claire individually)

### Smoke-test what shipped today
- [ ] Portal multi-property picker — create a test portal_user with grants
      to 2+ properties, log in → confirm picker appears, click a card →
      land on portal, header chip "🏠 Switch property" works
- [ ] First-login tutorial — log in as a fresh test homeowner → tutorial
      auto-shows. Dismiss it. Refresh — doesn't auto-show. Click "🎓 Tour"
      chip in header — re-opens
- [ ] Portal-adoption admin — visit
      `https://my.bedrocktxai.com/portal-adoption.html` → pick Waterview
      (or August Meadows) → see funnel + contact table → click "Select
      eligible-not-yet-invited" → "Invite selected" → confirm 1-2 test
      contacts get the welcome email
- [ ] Tile-visibility admin — same page, flip Clubhouse tile to
      `maintenance` for one community → reload homeowner portal for that
      community → confirm Clubhouse tile shows amber "Maintenance" pill,
      not clickable. Flip back to `live`
- [ ] Financials tile — flip to `live` for a community where you have
      financial-category documents uploaded. Log in as homeowner → confirm
      Financials tile appears in "Your community" section → click → lands
      on the financials page showing what's uploaded
- [ ] Rate-limit smoke test — submit 6 magic-link requests for the same
      email within an hour → 6th returns `Retry-After` header (body still
      `{ok:true}` for anti-enumeration)

---

## Strategic state — where we are after today

**Voice is genuinely done at the platform level.** Claire English + Isabella
Spanish + bidirectional language transfer + AR balance lookup tool + post-call
review + Calls Dashboard. The only remaining blocker is Ed's Vapi dashboard
config (Isabella assistant + Squad). Once that's done, voice is operational
across two languages.

**Marketing page (`bedrocktxai.com`) is now a demo funnel**, not a coming-soon
placeholder. Owner-operator positioning, single CTA to "Schedule a walkthrough
with Ed" (mailto for now; swap in Calendly when ready). Strips mechanic-leaking
specifics per the IP-protection discipline.

**Portal is now genuinely operator-controllable per community.** Multi-property
homeowners get a picker. New homeowners get a 3-slide tutorial. Staff can
bulk-invite a whole community, see who's logged in vs not, flip individual
tiles to maintenance/hidden/coming_soon, and turn the whole portal on/off per
community via kill switch. Financials is its own tile so you can hide it
when monthly statements aren't ready without hiding all governing docs.

**Email infrastructure** — `hello@bedrocktxai.com` is live as a Microsoft 365
shared mailbox. Brand consistency: marketing/sales email comes from the
Intelligence sub-brand domain, operational email continues on `bedrocktx.com`.
Staff getting first-name aliases on bedrocktx.com (more personal, easier to
dictate over phone).

**GitHub credential hygiene fixed.** Old `ghp_...` PAT in remote URLs was
rotated, replaced with `gh auth login` keyring-stored credential. Both repos
(`hoa-doc-search` and `bedrock-intelligence-site`) now push cleanly via
Windows Credential Manager — no tokens in URLs anywhere.

---

## Commits shipped today (push order)

| Commit | Subject |
|---|---|
| `85488bb` | Voice: Isabella (Spanish persona) — parallel to Claire, persona-routed |
| `af232e6` | Isabella REGLA DURA #7: bilingual handoff for mid-call English switch |
| `ef46d64` | Voice Phase 1B: Claire ↔ Isabella mid-call language transfer |
| `5243f90` | Marketing page rewrite: demo-funnel model |
| `ce1c603` | Portal: multi-property picker + first-login tutorial + security hardening |
| `4e28491` | Portal adoption: per-community bulk-invite + adoption funnel UI |
| `7ccf3e0` | Portal: per-community tile visibility admin |
| `6748bfb` | Portal: split Financials into its own tile (toggleable per community) |

Plus on the `bedrock-intelligence-site` repo:
| `5243f90` | Marketing page rewrite (separate commit, separate repo) |

---

## Recommended next-session kickoff prompts

### Option A — Homeowner profile architecture (Ed's stated next interest)

> *"I want to design what trustEd should capture for each homeowner.
> Look at the screenshot of Vantaca's Homeowner Profile (tabs: Action
> Items / Ledger / Communication / Activity Notes / Additional Info /
> Tenants/Leases / Payment Method / Tags) and compare to what we have
> today in `contacts`, `property_residencies`, `owner_ar_snapshots`,
> `homeowner_calls`, `portal_users`, etc. Then propose a unified
> Homeowner Profile design for trustEd that consolidates these data
> sources and beats Vantaca on operator experience — what the canonical
> homeowner record should be, what tabs/sections, how it integrates with
> the per-community board portal and the homeowner-facing portal."*

Drop the Vantaca screenshot in the first message. This session is staged
to overlap usefully with the Financial Statements ingest priority (since
the design will surface where financial records belong in the schema).

### Option B — DRV inspections module (top-3 strategic priority)

> *"Build the DRV inspections module per `project_drv_module.md`. Start
> with the full 5-signal wrong-house verification (GPS + heading + polygon
> + AI house# + reviewer) and the mobile capture flow. This is one of my
> top-3 priorities and the first major test of the full framework."*

### Option C — Financial Statements ingest strategy (top-3 strategic priority)

> *"Spec out the Financial Statements ingest strategy per
> `project_financial_records_ingest_strategy.md`. Vantaca exports → trustEd.
> What schema, what extraction pipeline, what surfacing in board packets +
> homeowner portal. Connect to the Financials tile we just shipped."*

### Option D — Verify-and-test focus

> *"Walk me through testing everything that shipped 2026-05-25 in
> production. Start with Render Manual Deploy + migrations 107/108/109,
> then click through each of the 6 portal smoke tests in `HANDOFF.md`,
> then Vapi Isabella setup."*

---

## Reference: key URLs + file locations

**Production:**
- trustEd platform (staff): `https://my.bedrocktxai.com`
- Portal Adoption admin: `https://my.bedrocktxai.com/portal-adoption.html`
- Homeowner portal: `https://my.bedrocktxai.com/portal`
- Marketing site: `https://bedrocktxai.com` (rewritten today)
- Demo portal URL: `https://my.bedrocktxai.com/portal?demo=1&community=waterview-estates`

**Repos:**
- `C:/Users/edget/hoa-doc-search` — trustEd platform (push via gh credential)
- `C:/Users/edget/bedrock-intelligence-site` — marketing site
- `C:/Users/edget/bedrock-brand` — brand assets

**Setup docs created today:**
- `lib/voice/SETUP_ISABELLA.md` — full Vapi config walkthrough for Isabella
  including the Squad transferCall setup for Phase 1B
- `templates/homeowner-portal-video-script.md` — 90-second walkthrough script
  for the homeowner-portal explainer video (whoever shoots it)

**Memory notes touched today:**
- `reference_voice_production_stack_2026_05_24.md` (created yesterday,
  still current — Sonnet 4.5 + ElevenLabs Mary + Vapi)
- Existing memory unchanged but relevant: `project_homeowner_portal.md`,
  `project_multilingual_voice_architecture.md`,
  `feedback_ip_protection.md`, `project_back_office_model.md`

---

## Open strategic threads (not blocked, but real)

1. **AppRiver integration for bedrocktxai.com** — cosmetic vs strategic
   choice. Option A from the email-setup conversation. Defer until you
   have 30 min in the AppRiver admin
2. **Twilio token rotation** — security, do this soon
3. **Vapi Squad config for Isabella** — voice Phase 1B is built but the
   actual handoff won't fire until you do the dashboard setup
4. **Portal token hashing** — security hardening I flagged; defer to
   when there's a dedicated portal-security session
5. **Adoption analytics history** — currently a snapshot view; charting
   trend over time needs a periodic snapshot job. Defer
6. **Reminder cadence automation** for stale portal invites — currently
   manual via the stale-invite quick-select in the adoption UI. Worth
   automating eventually
7. **Bulk-revoke** for portal users — only per-user revoke today
8. **CSV export** of the adoption contact table

---

## Things to NOT lose track of (recurring reminders)

- Ed doesn't read code (per `feedback_no_code_review.md`) — ship edits,
  tell him what to click
- Commit + push after every code edit in `hoa-doc-search` (per
  `feedback_commit_push_after_edits.md`)
- IP-protection on marketing surfaces (per `feedback_ip_protection.md`)
- Don't offer stopping points at the end of tasks (per
  `feedback_dont_offer_stopping_points.md`)
- Costs are creeping up (per `feedback_cost_consciousness_defaults.md`)
- Voting app is separate, do not touch (per `feedback_voting_app.md`)
- Use demo mode (`?demo=1&community=<slug>`) for sales/screenshot surfaces;
  never expose real homeowner data on marketing artifacts

---

*Generated end of 2026-05-25 session. Solid day. Closing the loop.*
