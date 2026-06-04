# Bedrock Connect — Design Spec

**Status**: Placeholder / queued. Build starts after Messaging System Phase 1
ships.
**Author**: Ed Gojara + Claude (2026-06-04 design session)
**Brand name**: Bedrock Connect (internal); customer-facing emails are
**community-branded** (Quail Ridge, LOPF, Canyon Gate, etc.) with no Bedrock
chrome. Bedrock is invisible plumbing — same posture as Lob for mail or
Resend for delivery.

---

## Strategic frame

Vantaca's email tool is built for collections, enforcement, and
transactional notifications. Their template categories are 6/9
enforcement-heavy (Alerts, Board, Collections, Invoices, Violations,
Requests). They treat homeowner email as a billing channel.

Riverstone HOA's "Lifestyle Team" emails (Ed's home community, used as a
reference) are the opposite — visual-first, community-branded, multiple
low-friction CTAs, conversational voice, "Director of Fun" sender identity,
viral "spread the news" forwarding mechanic.

Bedrock Connect combines:
- **Riverstone-grade engagement aesthetic** (visual, warm, specific)
- **Enterprise-grade infrastructure** (scheduling, segmentation, A/B,
  analytics, multi-stage campaigns) that Vantaca doesn't have yet
- **AI drafting via Claire** (writes in the community's voice, learns over
  time) that neither has

This combination is the moat. Vantaca structurally can't follow without
abandoning their collections-first model.

---

## Three voice registers

Every blast goes through one of three registers. Same platform, all three.

| Register | Use case | Visual treatment |
|---|---|---|
| **Engagement** | Community events, social, fun, surveys, newsletters, board candidate spotlights | Hero photo, warm color treatment, multiple CTAs, social icons, "forward to a neighbor" mechanic |
| **Operational** | Meeting reminders, maintenance notices, doc distribution, hurricane prep, schedule changes | Cleaner, text-forward, single clear CTA, calendar-friendly |
| **Compliance** | Violations, fines, §209 cure notices, statutory mailings | Formal, brand-controlled, legally precise, no marketing flourish. Some statutory mailings auto-route to certified mail via Lob instead of email — same platform, different channel based on law. |

Same community brand identity across all three. Voice register adapts to
the topic.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  AUTHOR + DRAFT                                              │
│                                                              │
│  Staff → "Compose Blast" → pick register → describe goal    │
│    → Claire drafts in community voice → review/edit         │
│    → preview (desktop + mobile) → schedule or send test     │
└──────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────┐
│  SEGMENTATION + COMPLIANCE GATES                             │
│                                                              │
│  Audience query: by community, section, property type,      │
│  role, interest opt-in, status                              │
│  Compliance: CAN-SPAM footer auto-injected; per-recipient   │
│  opt-out filter; statutory mailings re-routed if certified  │
│  mail required                                              │
└──────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────┐
│  DELIVERY                                                    │
│                                                              │
│  Resend API → community-branded sender domain               │
│  (events@quailridge.community, etc.)                        │
│  Per-recipient delivery row created                         │
│  Send-time throttling for large lists                       │
└──────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────┐
│  TRACKING                                                    │
│                                                              │
│  Resend webhooks: delivered, opened, clicked, bounced,      │
│  unsubscribed                                               │
│  Per-blast metrics + per-community baselines                │
│  Click-through per CTA (which button)                       │
│  Forward rate via "share this" tracking pixel               │
└──────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────┐
│  REPLY HANDLING                                              │
│                                                              │
│  Inbound replies → routed to MESSAGING SYSTEM as            │
│  per-homeowner inbound thread, anchored to property,        │
│  classified by Claire                                       │
│  Vantaca treats replies as something to suppress.           │
│  Bedrock Connect treats them as highest-value engagement.   │
└──────────────────────────────────────────────────────────────┘
```

---

## Data model

### `email_campaigns`
- `id`, `community_id`, `register` (engagement | operational | compliance)
- `name`, `description`, `created_by_staff_id`
- `audience_query_jsonb` (the segmentation rules)
- `status` (draft | scheduled | sending | sent | archived)
- `template_id` (which Bedrock Connect template was used)
- `claire_drafted_jsonb` (Claire's reasoning, prompt, draft history)
- `scheduled_for_at`, `sent_at`
- `created_at`, `updated_at`

### `email_blasts`
- `id`, `campaign_id`
- `sent_at`, `recipient_count`
- `delivered_count`, `opened_count`, `clicked_count`
- `bounced_count`, `unsubscribed_count`, `complained_count`
- `forward_count` (via tracking pixel on forwarded variants)
- `reply_count` (how many landed in messaging threads)
- `top_clicked_cta` (which button got clicked most)
- `subject_line_used`, `from_address_used`
- `resend_message_id_prefix` (for webhook correlation)

### `email_blast_recipients`
- `id`, `blast_id`, `homeowner_contact_id`, `property_id`
- `email_address`, `personalized_subject`
- `delivered_at`, `opened_at`, `clicked_at`, `bounced_at`
- `unsubscribed_at`, `complained_at`
- `last_open_at` (for opens that happen multiple times)
- `open_count`, `click_count`
- `clicked_cta_keys` (jsonb array of which CTAs they clicked)

### `community_brand_kits`
- `community_id` (FK)
- `primary_color`, `secondary_color`, `accent_color`
- `logo_url`, `hero_image_urls` (jsonb array — community signage, pool,
  clubhouse photos)
- `voice_preset` (warm_lifestyle | professional_clean |
  community_traditional)
- `default_sender_name` ("Quail Ridge Community Team")
- `default_sender_email_prefix` ("team" — combines with community domain)
- `social_links_jsonb` (Facebook, Instagram, NextDoor, community website)
- `physical_mailing_address` (CAN-SPAM compliance — auto from
  `community_contacts`)

### `homeowner_email_preferences`
- `contact_id`, `community_id`
- `engagement_opt_in` (default true)
- `operational_opt_in` (default true — required for governance notices)
- `compliance_opt_in` (default true — required by law)
- `category_preferences` (jsonb: events, surveys, maintenance, etc.)
- `unsubscribed_at`, `unsubscribed_reason`
- `last_engagement_at` (used for re-engagement campaigns)

### `email_templates_bc` (Bedrock Connect templates, distinct from any
existing letter templates)
- `id`, `register`, `name`, `description`
- `subject_line_template`, `body_html_template`
- `merge_tag_specs_jsonb` (allowed merge tags + their data sources)
- `default_ctas_jsonb`
- `image_slot_specs` (where hero/secondary images plug in)
- `is_bedrock_provided` (Bedrock template — copy-on-edit) vs custom
- `created_by`, `created_at`

---

## Voice presets (per-community)

Each community has one of three voice presets. Claire writes in that voice
for every blast from that community.

### warm_lifestyle (Riverstone-style)
- Sender: "Quail Ridge Lifestyle Team"
- Subject lines: casual, may use 1-2 emojis, specific date
- Body: short paragraphs, "we're", "you'll", "swing by", "join your
  neighbors"
- CTAs: button-styled, multiple per email, action-oriented
- Sign-off: "See you there!" / "Hope to see you Saturday!"

### professional_clean
- Sender: "Canyon Gate Management Team"
- Subject lines: clear, no emoji, descriptive
- Body: short, professional, third-person occasional
- CTAs: button-styled, usually one per email, "View" / "Register" /
  "Learn More"
- Sign-off: "Best regards" / "Thank you"

### community_traditional
- Sender: "LOPF Board of Directors" or named officer
- Subject lines: formal, no emoji
- Body: longer paragraphs, more formal, board-voice
- CTAs: text links + occasional buttons, single primary action
- Sign-off: officer name + title

Communities pick their preset at brand-kit setup. Editable later.

---

## Claire's role in Bedrock Connect

Same Claire as messaging + voice surfaces. Operating principles per memory:

- **Drafts in the community's voice preset**, learns from prior approved
  blasts in that community
- **Generates subject line variants** for A/B testing if requested
- **Suggests hero image** from the community's image library based on topic
- **Estimates send-time** based on community's prior open-rate history
  (per-community optimal send window)
- **Flags compliance issues** before send: missing CAN-SPAM footer,
  unsubscribe link missing, "do not reply" address but inbound replies
  route to messaging anyway, etc.
- **Suggests segmentation** based on topic ("Pool maintenance Saturday →
  consider sending only to homeowners with pool access, not all
  1,000 homeowners")
- **Cannot send autonomously**. Every blast requires staff approval
  before delivery. Same safety rail as voice surface (no compliance
  actions without human).

---

## Analytics dashboards

Per the Bezos-mode design from messaging:

### Per-blast view (immediately after send + retroactive)
- Delivery rate, bounce rate, complaint rate
- Open rate over time (1h, 24h, 7d, 30d)
- Click rate per CTA (which button is performing)
- Reply rate (how many landed in messaging)
- Top-performing subject line variant if A/B was run

### Per-template performance
- "Pool announcements outperform amenity reminders by 18% open rate"
- "warm_lifestyle voice template gets 47% open rate vs 31% for
  professional_clean — community is responding to warmth"
- Template-level click heatmaps

### Per-community baseline
- Each community develops its own engagement profile over time
- "LOPF Engagement emails typically see 47% open rate" — new blast
  benchmarked against the community's own history, not portfolio average
- Send-time optimization per community

### Portfolio (Ed's view)
- Total blasts sent / month
- Engagement vs operational vs compliance ratio
- Top-performing communities
- Underperforming communities (intervention opportunity)
- Trends over quarters

---

## Integration with messaging system

When a homeowner replies to a Bedrock Connect email, the reply does NOT
bounce or go to /dev/null. It flows into the messaging system as a per-
homeowner inbound thread, anchored to the property, classified by Claire.

This is the structural connection between Bedrock Connect (outbound,
broadcast) and the messaging system (per-homeowner, conversation).

**Concrete flow:**

1. Staff sends "Annual meeting next Tuesday" via Connect to all 312 LOPF
   homeowners
2. 14 homeowners reply with "Will minutes be sent afterward?"
3. Each reply lands in the messaging system as a new inbound thread
4. Claire classifies all 14 as the same topic ("FAQ: minutes
   distribution")
5. Claire drafts a uniform response that staff can approve once and apply
   to all 14
6. Each homeowner gets a personal answer referencing their question
7. Reply rate flows back to the original blast's analytics

Vantaca's Do-Not-Reply panel forces homeowners to start over via a
different channel (call, email a different address, log into portal).
Bedrock Connect treats the reply as the highest-value engagement signal
and routes it as a first-class thread.

---

## Compliance baked in

- **CAN-SPAM physical mailing address** auto-pulled from community's
  `community_contacts` record; injected in every footer; verified before
  send
- **One-click unsubscribe** with per-category preferences (homeowner can
  opt out of events but stay on operational + compliance)
- **Operational + compliance categories are NOT unsubscribable** —
  governance notices and statutory mailings are required by law and HOA
  governing docs
- **Statutory mailings** (§209 cure notices, annual meeting notices for
  certain bylaws) auto-route to certified mail via Lob, not email — same
  platform, different channel based on what the law requires
- **Audit log** — every blast records who sent it, when, to which list,
  with which content; immutable archive
- **Unsubscribe centralized** — homeowner can manage all email
  preferences from a single page on the portal

---

## What this means competitively vs Vantaca

| Capability | Vantaca | Bedrock Connect |
|---|---|---|
| Action-item driven transactional emails | Yes | Yes (operational register) |
| Community-engagement emails (events, social) | No / clunky | Yes (engagement register, first-class) |
| Brand colors | Yes (paint job) | Yes (full community brand identity) |
| Sender identity | Vantaca-flavored | Community-branded (no Bedrock chrome) |
| Voice register adaptation | No | Yes (3 registers per community) |
| AI drafting | No | Yes (Claire in community's voice) |
| Audience segmentation | Action-item-bound | Full segmentation (community, section, role, interest) |
| Email scheduling | Coming soon | Yes |
| Bulk approval | Coming soon | Yes |
| A/B testing | No | Yes (subject line variants) |
| Analytics per CTA | No | Yes |
| Forward tracking | No | Yes |
| Reply handling | Suppressed | Routed to messaging system (first-class engagement) |
| Per-community baselines | No | Yes |
| Statutory mail routing | Email only | Email or certified mail (via Lob) based on legal requirement |
| One-click unsubscribe by category | No | Yes |

---

## Build plan (when we get there)

Estimated 4-5 days focused work for v1. Reuses existing stack.

### Phase 1: Foundation (1.5 days)
- Migrations: `email_campaigns`, `email_blasts`, `email_blast_recipients`,
  `community_brand_kits`, `homeowner_email_preferences`, `email_templates_bc`
- `lib/bedrock_connect/` directory structure
- `lib/bedrock_connect/audience_resolver.js` (segmentation logic)
- `lib/bedrock_connect/compliance_gates.js` (CAN-SPAM, unsubscribe,
  statutory routing)

### Phase 2: Templates + voice presets (1 day)
- Three voice preset implementations
- Bedrock-provided templates per register (3-5 per register to start)
- Brand kit setup flow (extract colors from logo, define voice preset)

### Phase 3: Drafting with Claire (1 day)
- `lib/bedrock_connect/claire_drafter.js` — composer + voice-aware prompts
- Operator UI: compose blast → describe goal → Claire drafts → review →
  schedule

### Phase 4: Send + track (1 day)
- Resend API integration (send, schedule, throttle)
- Webhook handler for opens / clicks / bounces / unsubscribes / replies
- Inbound reply routing to messaging system (the structural connection)

### Phase 5: Analytics + dashboards (0.5 day)
- Per-blast view
- Per-template performance
- Per-community baseline
- Portfolio view

---

## Open design questions to revisit before build

1. **Sender domain strategy** — do we provision a `quailridge.community`
   subdomain for each community, or send from `*.bedrocktx.com` with the
   community name as the sender display? Trade-off: domain-per-community
   feels owned but requires DNS work per community; shared domain is
   simpler but reads less authentic. Lean toward subdomain at scale.
2. **A/B test depth** — subject line A/B is easy. Hero image / body / CTA
   variants are harder. Ship with subject-line A/B only; add the others
   when a community has enough volume to make the test statistically
   useful.
3. **Reply-handling fan-out** — when 200 homeowners reply to the same
   blast, do we create 200 separate threads or one mega-thread? Lean
   toward 200 separate threads (each homeowner has their own
   conversation) with Claire's same-topic batch-response UI.
4. **Templates: Bedrock-provided vs operator-built** — how many
   Bedrock-provided to ship? Lean toward 15-20 across the three registers
   as a starting library, operators duplicate-and-edit for community
   customization.

---

## Memory + CLAUDE.md alignment

- **No Claude branding** in any user-visible text (memory rule
  `feedback_no_claude_branding`). Claire is the persona; the underlying
  model is internal plumbing.
- **Brand-the-output** (memory `feedback_brand_the_output`) — every email
  is community-branded, never a Bedrock-chrome forwarded message. Bedrock
  is invisible.
- **Bespoke touch** (memory `feedback_bespoke_touch`) — every email carries
  names, dates, community-specific facts. "Dear Homeowner" is banned.
- **Empty-chair lens** (memory `project_empty_chair_lens`) — when
  designing voice presets and CTAs, the homeowner-experience lens is
  co-equal with the operator-efficiency lens. If a feature makes the
  blast easier to send but worse to receive, kill it.
- **Single source of truth** (CLAUDE.md) — sender identity, mailing
  address, preferences all live in canonical rows, not duplicated.
- **Two-stage data flow** (CLAUDE.md) — operator inputs goal → Claire
  drafts (extract) → compliance gates validate → render to HTML →
  deliver via Resend. Statutory wording (§209, etc.) injects at render
  from GLOBAL_RULES, never freestyled.

---

## Status

**This spec is queued behind Messaging System Phase 1.** Build does not
start until messaging threads + staff inbox + close-with-agreement flow
are shipped. The placeholder UI at `/bedrock-connect.html` and the API
stub at `/api/bedrock-connect/*` exist so the structural placement is
preserved and the team has something visible to reference.

See `templates/messaging-system.spec.md` (forthcoming) for messaging
system design. See `public/bedrock-connect.html` for the placeholder UI
and current build status.
