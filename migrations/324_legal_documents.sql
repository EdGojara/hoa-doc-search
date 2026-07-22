-- ===========================================================================
-- 324_legal_documents.sql   (Ed 2026-07-21)
-- ---------------------------------------------------------------------------
-- Legal Disclosures live in the platform, not in a file on someone's desktop.
-- Bedrock's privacy policy, terms/disclosures, and standing legal notices are
-- stored here as versioned, editable documents shown under Bedrock Office →
-- Legal Disclosures. "I want everything to be in the platform." (Ed 2026-07-21.)
--
-- Record ownership: workpaper — these are Bedrock's own corporate documents.
-- (A copy delivered to a homeowner is association/mixed, but the master here is
-- Bedrock's.)
-- ===========================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS legal_documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text NOT NULL UNIQUE,
  title             text NOT NULL,
  category          text NOT NULL DEFAULT 'policy',   -- policy | disclosure | notice | memo (descriptive)
  body_markdown     text NOT NULL DEFAULT '',
  version           integer NOT NULL DEFAULT 1,
  effective_date    date,
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  record_ownership  text NOT NULL DEFAULT 'workpaper',
  updated_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_legal_documents_status ON legal_documents (status, category);

GRANT SELECT, INSERT, UPDATE, DELETE ON legal_documents TO service_role;
GRANT SELECT                          ON legal_documents TO authenticated;

DROP TRIGGER IF EXISTS trg_legal_documents_updated_at ON legal_documents;
CREATE TRIGGER trg_legal_documents_updated_at
  BEFORE UPDATE ON legal_documents
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- Seed the privacy policy (DRAFT). Dollar-quoted so the markdown needs no
-- escaping. Idempotent: only inserts if the slug isn't already present.
INSERT INTO legal_documents (slug, title, category, status, body_markdown)
SELECT 'privacy-policy', 'Privacy Policy', 'policy', 'draft', $md$# Bedrock Association Management, LLC — Privacy Policy

**DRAFT — for internal and legal review before publication.**
**Effective date: [to be set on publication]**

## 1. Who we are and our role

Bedrock Association Management, LLC ("Bedrock," "we," "us," "our") provides community
association management services to homeowners and property owners associations
("Associations") in Texas. We act as the **managing agent** for each Association under a
written management agreement. In that role we handle personal information about community
owners, residents, and their representatives ("you") **on behalf of the Association**.
Each Association owns its own membership and community records; we process those records
to manage the community on the Association's behalf and at the direction of its Board of
Directors.

## 2. Information we collect

Depending on your community and your dealings with us, we may collect:

- **Contact and identity information** — name, property/lot address, mailing address,
  email address, and phone number.
- **Account information** — assessment and ledger balances, payment history, and payment
  details you provide. Card and bank-account payments are handled by our payment
  processor; we do not store full card or bank-account numbers.
- **Community records** — architectural review (ACC/ARC) applications, deed-restriction and
  violation records and related correspondence, amenity and access records, and messages
  you send us.
- **Portal and website information** — homeowner-portal access information and basic
  technical and usage data.

We collect this from you, from the Association and its Board, from a prior manager or the
Association's existing records, from public property records, and from service providers
such as banks and payment processors.

## 3. How we use information

We use personal information to:

- **Manage the community** — bill and collect assessments, maintain owner ledgers, process
  ACC/ARC requests, administer deed-restriction enforcement, manage amenities, and maintain
  Association records.
- **Communicate with you** about your account, your property, community notices, and
  Association business.
- **Provide the homeowner portal** and related services.
- **Comply with law and the governing documents**, and to establish or defend legal claims.

## 4. How we share information

**We do not sell your personal information.**

We share personal information only as needed to manage the community, to comply with law,
or at the written direction of the Association's Board — specifically with:

- **The Association, its Board of Directors, and its committees**, who direct the
  management of the community and are entitled to the Association's records.
- **Service providers acting on our or the Association's behalf** under confidentiality
  obligations — for example, payment processors, banking partners, the software platform we
  use to manage the community, communications and mailing providers, insurers, auditors and
  accountants, and attorneys or collection agents.
- **Community vendors or partners that the Association's Board directs us to work with** for
  community purposes. In that case we share only the information the Board directs and that
  is reasonably necessary for the stated purpose.
- **Government authorities, courts, or others** when required by law, legal process, or to
  protect legal rights.

When a management relationship ends, the Association's records are returned to the
Association under the management agreement.

## 5. Your choices and rights

- **Communications** — You may opt out of non-essential communications (for example,
  community newsletters or community-partner mailings) by contacting us. We must still send
  certain required notices, such as billing statements and statutory notices.
- **Access to Association records** — As an owner, you may have the right to inspect
  Association records under Texas Property Code § 209.005 and your governing documents.
- **Requests about your information** — You may ask what information we hold about you,
  request corrections, and ask us not to share your contact information with community
  partners. To make a request or opt out, contact us using the details in Section 10. Some
  information we must retain to manage the community or to comply with law.

## 6. Security and retention

We use reasonable administrative, technical, and physical safeguards to protect personal
information. We retain the Association's records for as long as needed to manage the
community and as required by the management agreement and by law, after which the records
are returned to the Association or securely disposed of.

## 7. Third-party services

Some services — such as payment processing, the homeowner portal, and communications — are
provided by third parties that process information under their own terms and privacy
practices. We select providers that agree to handle information appropriately.

## 8. Children

Our services are directed to adults managing property and community matters. We do not
knowingly collect information from children.

## 9. Changes to this policy

We may update this policy from time to time. The current version and its effective date are
available at [website URL].

## 10. Contact us

Bedrock Association Management, LLC
12808 West Airport Boulevard, Suite 253
Sugar Land, TX 77478
(832) 588-2485 · info@bedrocktx.com

To make a privacy request or to opt out of community-partner sharing, contact us at the
address or email above.

---

*Draft describing intended practices. Before publishing: confirm every statement matches
Bedrock's actual operations, set the effective date, and have counsel review — particularly
Sections 4 and 5 — given the pending homeowner inquiry this policy will be read against.*$md$
WHERE NOT EXISTS (SELECT 1 FROM legal_documents WHERE slug = 'privacy-policy');

COMMIT;
