-- ===========================================================================
-- 325_legal_documents_seed_more.sql   (Ed 2026-07-21)
-- ---------------------------------------------------------------------------
-- Two more starter documents in Legal Disclosures so the section isn't a party
-- of one: a Community Communications Disclosure (the thing that would have
-- headed off the My Neighborhood News complaint) and a Homeowner Data Request
-- Procedure (encodes the standing rule + the handling playbook so staff have a
-- checklist). Both DRAFT. Idempotent: only inserts if the slug isn't present.
-- Requires migration 324 (legal_documents). Record ownership: workpaper.
-- ===========================================================================
BEGIN;

INSERT INTO legal_documents (slug, title, category, status, body_markdown)
SELECT 'communications-disclosure', 'Community Communications Disclosure', 'disclosure', 'draft', $md$# Community Communications Disclosure

**DRAFT — for internal and legal review.**

## Purpose

This disclosure explains how the Association and Bedrock Association Management, LLC
("Bedrock"), as managing agent, communicate with residents, and how community
communication partners are used.

## How we communicate

- **Official notices** — billing statements, Texas Property Code § 209 notices, meeting
  notices, and architectural (ACC/ARC) decisions come from Bedrock on the Association's
  behalf, sent to the contact information on file.
- **Community announcements and newsletters** may be delivered by email, mail, the
  homeowner portal, or a community communication partner selected by the Association's
  Board of Directors.

## Community communication partners

From time to time an Association's Board may partner with a third-party community
communications service — for example, a neighborhood newsletter or events platform — to
keep residents informed. When the Board directs such a partnership:

- Bedrock shares only the contact information the Board directs and that is reasonably
  necessary for the service.
- **We do not sell resident information.**
- The partner is expected to use resident information only for the stated community purpose
  and to honor opt-out requests.

## Your choices

You may opt out of non-essential community communications, including community-partner
mailings and newsletters, at any time by contacting Bedrock at info@bedrocktx.com or
(832) 588-2485. Certain required notices — billing and statutory notices — will still be
sent.

## Contact

Bedrock Association Management, LLC
12808 West Airport Boulevard, Suite 253, Sugar Land, TX 77478
(832) 588-2485 · info@bedrocktx.com

---

*Draft — confirm it matches actual practice and have counsel review before publishing.*$md$
WHERE NOT EXISTS (SELECT 1 FROM legal_documents WHERE slug = 'communications-disclosure');

INSERT INTO legal_documents (slug, title, category, status, body_markdown)
SELECT 'data-request-procedure', 'Homeowner Data Request Procedure', 'procedure', 'draft', $md$# Homeowner Data Request Procedure

**DRAFT — internal procedure with a resident-facing summary.**

## For residents

If you want to know what information we hold about you, correct it, or ask us not to share
your contact information with community partners, contact Bedrock at info@bedrocktx.com or
(832) 588-2485. We will confirm receipt and respond as promptly as we reasonably can. Some
information we must retain to manage the community or to comply with law.

## Internal procedure (staff)

When a resident submits a data request — access, correction, or opt-out:

1. **Log it the day it arrives** — sender, community, date, and exactly what they asked
   for. Acknowledge receipt promptly; do not guess at specifics in the acknowledgment.
2. **Identify what applies** — access to their own information, a correction, an opt-out of
   community-partner sharing, or a broader question about disclosures.
3. **Gather the facts before answering:**
   - What information Bedrock holds for the resident.
   - Whether any information was shared with a community partner, on what basis (Board
     authorization), and with whom.
   - The partner's data practices, if relevant.
4. **Opt-out is immediate.** If the resident asks to opt out of a community partner or
   newsletter, action it right away — have the partner remove them — and confirm. This
   de-escalates and is honored regardless of the rest of the request.
5. **Escalate before a substantive answer** on any formal or written demand touching data
   disclosure. Route it to Ed, and for formal demands, to the Association's counsel, before
   the detailed reply goes out.
6. **Provide the privacy policy** and this procedure on request.

## Standing rule

Bedrock does not release resident contact information to any third party without **(a)** a
documented Board authorization, **(b)** a written data-handling commitment from that third
party, and **(c)** a resident opt-out. For marketing-type sharing, opt-in is preferred.

## Contact

Bedrock Association Management, LLC · (832) 588-2485 · info@bedrocktx.com

---

*Draft — confirm it matches actual practice and have counsel review.*$md$
WHERE NOT EXISTS (SELECT 1 FROM legal_documents WHERE slug = 'data-request-procedure');

COMMIT;
