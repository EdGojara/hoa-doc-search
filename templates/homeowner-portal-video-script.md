# Homeowner Portal — 90-Second Walkthrough Script

**Purpose:** Short video (~90 sec) embedded on bedrocktxai.com and sent in the
homeowner portal invitation email. Shows brand-new homeowners what the portal
does and gets them comfortable enough to log in for the first time.

**Tone:** Casual, warm, owner-operator (Ed on-camera, not a polished VO).
Match the same register as the Claire voice and the bedrock-intelligence-site
copy — confident, plain-spoken, not corporate.

**Production notes for whoever shoots it:**
- 1080p horizontal or 9:16 vertical (vertical works for mobile-first email
  CTAs; horizontal for embed on the website)
- Capture screen recording of the actual portal as Ed talks (don't just show
  a static slide)
- Use the **demo mode URL** for screen capture so no real homeowner data
  appears on camera: `https://my.bedrocktxai.com/portal?demo=1&community=waterview`
- Open with Bedrock cornerstone logo (gold) for ~1 sec, then jump to face cam
- Brand colors: navy `#1A3050`, gold `#D4AF37` for any title cards or
  lower-third name tag
- Background should be Bedrock office, a Bedrock-managed common area, or a
  clean home-office setup — not generic stock
- Lower-third on camera: **Ed Gojara — Bedrock Association Management**
- Final card: phone + email overlay for 2 sec

---

## Script (target: 90 seconds total)

### [0:00 – 0:08] Open

**Visual:** Cornerstone logo flash → cut to Ed on camera

**Ed:**
> "Hey — Ed Gojara with Bedrock. Quick 90-second walkthrough of your homeowner
> portal. If you've gotten this far, you're set up — let me show you what's in
> there."

---

### [0:08 – 0:18] What it is

**Visual:** Cut to screen capture of portal home page (demo mode). Hover over
the hero card to make the stats visible.

**Ed (VO over screen):**
> "Top of your portal — you'll see your account balance, whether you're in
> good standing on community rules, and any requests you've got in flight.
> One glance, everything that matters."

---

### [0:18 – 0:38] Quick tour of tiles

**Visual:** Pan/zoom across the three sections — "Your account" → "Make a
request" → "Your community". Hover over each tile briefly.

**Ed:**
> "Below that you've got three groups of tiles. *Your account* — balance,
> compliance, property details. *Make a request* — that's where you'd ask
> for a new pool fob, submit an architectural request, or reserve the
> clubhouse. And *Your community* — your governing documents, board meetings
> coming up, and local contacts like trash schedule and utility numbers."

---

### [0:38 – 0:55] Two things people care about most

**Visual:** Click into the Balance tile (demo) to show the detail page. Then
back, click ARC tile.

**Ed:**
> "Two things I'll point out — your balance page shows what you owe and how
> to pay it, with payment history right there. And if you need any kind of
> exterior change to your home — paint, fence, anything — start with the
> architectural request tile. It walks you through the whole submission
> in about two minutes."

---

### [0:55 – 1:10] Multi-property note (optional — skip if you don't want it)

**Visual:** Show the property picker screen (sign in with a multi-property
demo account).

**Ed:**
> "If you own more than one property in a community we manage, you'll get a
> property picker when you sign in. Pick whichever one you want to look at —
> you can switch anytime from the top of the page."

---

### [1:10 – 1:25] Where to get help

**Visual:** Cut back to Ed face-cam.

**Ed:**
> "That's basically it. If something's not working or you can't find what
> you need, give us a call at (832) 588-2485 or email info@bedrocktx.com —
> you'll get a real person, usually same day."

---

### [1:25 – 1:30] Close

**Visual:** Final card with phone + email overlay, cornerstone logo

**Ed:**
> "Thanks for being part of a Bedrock community. Talk to you soon."

---

## Variations to consider

- **30-second cut** (for social / mobile-first email CTA): just sections 1 +
  4 + 5. Same script, drop the middle tour.
- **Spanish version** (Isabella's audience): same script, Ed delivers in
  Spanish OR a Spanish-speaking team member records. Tie to multilingual
  voice rollout (see `lib/voice/SETUP_ISABELLA.md`).
- **Community-specific intro** (later, when justified): same body, custom
  10-sec intro per community ("Hey Waterview homeowners — Ed with Bedrock…").
  Defer until volume justifies it; one generic version covers 95%.

## Where to put the video once recorded

- **bedrocktxai.com**: embed in the Resident Experience capability section,
  or add a dedicated `/portal-tour` page that the email CTA can link to
- **Portal invitation email**: the magic-link invite (in
  `api/portal_admin.js` send-invite flow) can include a "Watch a 90-second
  tour first →" link above the sign-in button
- **Inside the portal**: link from the "Tour" chip in the header could be
  replaced with "Watch tour" → video, with the 3-slide overlay kept as the
  text-only fallback for users who don't want video

## Recommended file naming

- `bedrock-portal-tour-90s.mp4` (horizontal)
- `bedrock-portal-tour-vertical-90s.mp4` (9:16 mobile)
- `bedrock-portal-tour-30s.mp4` (short cut)
- Spanish: `bedrock-portal-tour-es-90s.mp4`

Host on Vimeo (better embed control + no ads) or YouTube (better SEO + free).
Vimeo if you want absolute embed control on the marketing site; YouTube if
you want the video to also be findable when prospects google "Bedrock HOA
management Houston."
