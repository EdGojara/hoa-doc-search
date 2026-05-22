# Violation Letter — Gold Standard Reference

> **Status**: Locked spec. The renderer in `lib/enforcement/violation_letter.js` must produce output that matches this reference for each stage. Changes here require attorney review (statutory wording) and Ed's approval (tone/layout) before merging.
>
> **Why this file exists**: PDFKit code in the renderer is operationally accurate but not human-reviewable. This markdown is the canonical description of what a letter should contain at each stage — for QA, legal review, future-Claude reference, and as the diff target if a regression slips into the renderer.
>
> **Pattern**: `[STATUTORY_209.x]` markers below indicate where text injects from `lib/enforcement/violation_letter_rules.js` at render time. These are NEVER paraphrased by the model.

---

## Universal elements (every stage)

Every violation letter — courtesy, certified, or fine — contains these:

1. **Co-branded header**
   - **Left**: Community logo (from `community_logo_buffer`) + community legal name primary, with mailing address.
   - **Right**: Bedrock cornerstone mark (small, subtle) — signaling managing-agent role without competing with the Association's identity.
   - **Falls back to text-only HOA name** if no logo is on file. Cornerstone always renders.

2. **Letter date** — top right. This is the mailing date (cure clock starts here for first-class; postmark controls for certified).

3. **Owner block** — top left, below header
   - Owner name (with honorific from `owner.honorific` if provided)
   - Owner mailing address (NOT the property address — critical for rentals)

4. **Property reference line** — single line beneath owner block
   - `Property: <property.street_address>` + `Lot <lot_block_section>` if available

5. **Body sections** (vary by stage — see below)

6. **Wide-shot photo** at the top of the body — establishes property identity for the entire letter. Captioned per `PHOTO_DISCIPLINE.caption_wide`.

7. **Per-violation block** for each violation in `violations[]`:
   - Item label (Item 1, Item 2, …) — only when multi-violation
   - Violation type + description
   - Date documented
   - Governing doc reference (CC&R Article X, Section Y) if `governing_doc_reference` provided
   - Close-up photo of the specific finding
   - Prior notice dates (if `prior_notice_dates[]` populated)

8. **Cure section** — what's required and by when
   - Cure label (varies by stage tone — see below)
   - Hard date of cure deadline (computed from `letter_date + cure_days`)
   - Cure instructions (text editorialized per stage)

9. **Sender block** — bottom of letter
   - Sender name + title (from `community.letter_sender_name` / `letter_sender_title`, or option overrides)
   - Default title: "On behalf of the {community.name} Board of Directors"

10. **Managing-agent footer** — every letter, no exceptions
    `[MANAGING_AGENT_FOOTER(hoaName)]`

---

## Stage 1: `courtesy_1` — First courtesy notice

**Mailing class**: First-class mail
**Cure period**: 20 days (per-community override via `letter_cure_days_courtesy_1`)
**Admin fee**: $0 default
**Title**: `[TONE_SOFTENED.title_courtesy_1]` → "Courtesy Notice"
**Hearing-rights block**: NOT included (premature on courtesy)
**SCRA disclosure**: NOT included
**Postmark anchor**: NOT included

### Body structure

```
Dear {honorific} {owner.last_name or owner.name},

[TONE_SOFTENED.intro_courtesy_1(hoaName)]

[insert wide-shot photo + caption]

The Association has documented the following at your property:

  Item 1: {violation.type}
    {violation.description}
    Documented on {violation.date_documented}
    {violation.governing_doc_reference if set}
    [insert close-up photo + caption]

  Item 2: ... (if multi-violation)

Time to address: by {cureBy date}

[COURTESY_PREAMBLE.resolution_first()]

We don't expect a response; documentation that the issue has been resolved is sufficient. If you have questions or need additional time, please reach out before {cureBy date} so we can work with you.

Sincerely,

{sender_name}
{sender_title}

[MANAGING_AGENT_FOOTER(hoaName)]
```

### What MUST be true
- Tone is warm and resolution-first. The word "violation" should not appear in body text directed at the homeowner (it appears only in the photo-section header "Item X" descriptors).
- The cure label reads "Time to address" — NOT "cure deadline" (statutory term reserved for certified).
- Photos are present even at this stage — they reduce back-and-forth and document for the homeowner's benefit.

### What MUST NOT appear
- Texas Property Code statute citations (§209.x) — those signal an escalation we haven't taken yet.
- Hearing rights language — premature.
- Fine schedule or admin-fee disclosure — there are none at this stage.
- SCRA notice — only required on escalated stages.
- The phrase "you are in violation" or "you have violated."

---

## Stage 2: `courtesy_2` — Second courtesy notice

**Mailing class**: First-class mail
**Cure period**: 20 days (per-community override via `letter_cure_days_courtesy_2`)
**Admin fee**: $0 default
**Title**: `[TONE_SOFTENED.title_courtesy_2]` → "Second Notice — Covenant Violation"
**Hearing-rights block**: NOT included
**SCRA disclosure**: NOT included
**Postmark anchor**: NOT included

### Body structure differences from courtesy_1

```
Dear {honorific} {owner.last_name or owner.name},

[TONE_SOFTENED.intro_courtesy_2(hoaName)]

[prior_notice_dates from each violation rendered as: "We previously
contacted you on {date} about Item X." — exact dates, not "previously."]

[wide-shot + per-violation blocks — same structure as courtesy_1]

Time to address: by {cureBy date}

If this matter is not resolved by the above date, the next notice will
be sent by certified mail under Texas Property Code §209 and will
include an administrative fee. Resolving now keeps your account clean
and avoids those costs.

[COURTESY_PREAMBLE.resolution_first()]

Sincerely,
{sender_name}
{sender_title}

[MANAGING_AGENT_FOOTER(hoaName)]
```

### What MUST be true
- Prior notice dates are **specific dates**, not "you were previously notified." Specificity is part of the §209 framework that has to be established by certified mail; the second notice is where that record gets built.
- The escalation warning is present but factual: "next notice will be sent by certified mail under Texas Property Code §209." Not threatening; clear.
- Tone is still resolution-first but firmer. The cure label is still "Time to address" — statutory term still reserved for certified.

### What MUST NOT appear
- Detailed §209 statutory language (saved for certified stage).
- Hearing rights language.
- SCRA disclosure.
- Fine schedule.

---

## Stage 3: `certified_209` — Formal §209 notice

**Mailing class**: Certified mail with return receipt
**Cure period**: 30 days minimum (statute floor; per-community override allowed for longer cure)
**Admin fee**: $35 default ($3500 cents, configurable per community)
**Title**: `[TONE_STATUTORY.title_certified_209]` → "FORMAL NOTICE OF COVENANT VIOLATION"
**Hearing-rights block**: REQUIRED
**SCRA disclosure**: REQUIRED
**Postmark anchor**: REQUIRED (belt-and-suspenders timing protection)

### Body structure

```
Dear {honorific} {owner.last_name or owner.name},

This is a formal notice under Texas Property Code §209 regarding
{violations.length === 1 ? 'an ongoing covenant violation' : `${violations.length} ongoing covenant violations`} at the above property. {hoaName} has documented prior notices on {this matter / these matters} that remain uncured. {Each violation is detailed below.}

[insert wide-shot photo + caption]

[per-violation blocks — same structure but using "Notice of Covenant
Violation" terminology, not "courtesy" framing. Prior notice dates
ARE required here.]

[STATUTORY_209.notice_satisfies_209_006()]

Cure deadline: {cureBy date}

[STATUTORY_209.postmark_anchor()]

[STATUTORY_209.cure_kills_fine()]

Hearing rights:

[STATUTORY_209.hearing_request_rights(hearingByDate, hearingAddress)]

Administrative fee:

An administrative fee of ${feeDollars} has been assessed in connection
with this certified notice. Remittance: {community.letter_pay_to_name}, {community.letter_pay_to_address}. Online payment: {community.letter_payment_url}.

[STATUTORY_209.scra_disclosure()]

Sincerely,
{sender_name}
{sender_title}

[MANAGING_AGENT_FOOTER(hoaName)]
```

### What MUST be true
- The literal statutory phrases from `STATUTORY_209.*` constants are present verbatim. No paraphrasing.
- "Cure deadline" is the label (not "Time to address" — this is where §209 vocabulary takes over).
- The postmark-anchor clause is present even when the mailing date and print date are the same. It closes a legal-challenge surface that costs nothing to close defensively.
- The hearing-rights block includes the hearing-by date (computed from `letter_date + HEARING_REQUEST_DAYS`).
- SCRA disclosure is at the end of the notice, not buried.

### What MUST NOT appear
- "Courtesy" framing language.
- Casual cure flexibility offers ("we can work with you on timing") — the statute fixes the timeline.
- Tone-softening preambles (`[COURTESY_PREAMBLE.*]`) — courtesy stages have those; certified does not.
- Statements that paraphrase §209 obligations in different words. Use the constants.

---

## Stage 4: `fine_assessed` — Notice of fine assessment

**Mailing class**: Certified mail with return receipt (same as `certified_209`)
**Cure period**: 30 days (cure-before-deadline still kills the fine per §209.006(e))
**Title**: `[TONE_STATUTORY.title_fine_assessed]` → "NOTICE OF FINE ASSESSMENT"
**Hearing-rights block**: REQUIRED
**SCRA disclosure**: REQUIRED
**Postmark anchor**: REQUIRED
**Fine amount**: from `violation.fine_cents` per violation, or community fine schedule

### Body structure differences from certified_209

```
Dear {honorific} {owner.last_name or owner.name},

{violations.length === 1 ? 'This notice memorializes a fine assessment against your account for an unresolved covenant violation' : `This notice memorializes fine assessments against your account for ${violations.length} unresolved covenant violations`} at the above property. {Fines are / The fine is} being assessed after written notice and an opportunity to cure under Texas Property Code §209.

[wide-shot photo + per-violation blocks — each block shows the specific
fine amount in cents converted to dollars; also shows prior notice dates
that established the §209 framework]

[STATUTORY_209.fines_schedule_anchored()]

Total fines assessed: ${totalFinesDollars}
Administrative fee: ${feeDollars}
Total now due: ${totalDollars}

Cure deadline: {cureBy date}

[STATUTORY_209.postmark_anchor()]

[STATUTORY_209.cure_kills_fine()]   ← critical: fine waivable if cured

[STATUTORY_209.fee_disclosure_fine_assessed(feeDollars)]

Hearing rights:
[STATUTORY_209.hearing_request_rights(hearingByDate, hearingAddress)]

Remittance:
  Pay to: {letter_pay_to_name}
  Address: {letter_pay_to_address}
  Online: {letter_payment_url}

[STATUTORY_209.scra_disclosure()]

Sincerely,
{sender_name}
{sender_title}

[MANAGING_AGENT_FOOTER(hoaName)]
```

### What MUST be true
- Per-violation fine amounts are itemized AND totaled. Boards should be able to see which Item X = which dollar amount on which line of the fine schedule.
- The "cure-kills-fine" language from `STATUTORY_209.cure_kills_fine()` is prominent — this protects the Association from over-collection AND signals fairness to the homeowner.
- All §209 statutory blocks are present (notice_satisfies + postmark_anchor + cure_kills_fine + fines_schedule_anchored + fee_disclosure_fine_assessed + hearing_request_rights + scra_disclosure).
- "Total now due" sums fines + fee accurately (cents arithmetic, not floats).

### What MUST NOT appear
- Fines without an associated violation block (no "miscellaneous fines").
- Fines for violations that don't have a documented `date_documented` AND prior notice dates — that's the audit trail §209 requires before fines.
- Suggestions that paying the fine resolves the underlying violation. The fine and the cure are separate; cure is still required even after paying.

---

## Layout + typography

(To be locked once Ed reviews the first rendered sample of each stage.)

- **Font**: To match BRAND.fonts (Inter sans + Playfair serif for headers)
- **Page size**: US Letter, 56-pt margins (0.78" — printable safe area for window envelopes)
- **Color**: Body text in `--ink` (#1a1a1a); statutory section headers in `--navy` (#1A3050); cornerstone mark + section dividers in `--gold` (#D4AF37)
- **Photos**: Wide-shot at top of body (~280pt wide). Close-up photos per violation (~180pt wide).
- **Spacing**: Section breaks between header / owner block / body / cure / hearing / sender / footer use consistent 14pt vertical rhythm.

---

## Versioning

Every change to this file should:
1. Have an attorney review the statutory text changes (if any)
2. Be approved by Ed before merging
3. Update the "Last attorney review" date in `violation_letter_rules.js`
4. Be tested against all four stage variants in the staging environment before any letter ships to a real homeowner

**Last updated**: 2026-05-21 (initial creation post-Swim Houston debug cycle)
**Last attorney review**: NOT YET — this is the pre-production reference. Before any real §209 letter ships, the statutory blocks in `violation_letter_rules.js` MUST be reviewed by an HOA attorney.
