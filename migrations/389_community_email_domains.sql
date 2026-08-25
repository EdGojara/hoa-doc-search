-- ============================================================================
-- 389 — Community email-domain map (authoritative community signal for intake).
-- ----------------------------------------------------------------------------
-- Ed 2026-08-25. An Amazon clubhouse-supplies bill emailed from
-- propertymanager@canyongateatcincoranch.com posted to WATERVIEW. Root cause:
-- "everyone uses Amazon" — a shared vendor tells you nothing about which
-- association a bill belongs to, so the community was decided by an AI reading
-- the email text, and it guessed wrong. The single most reliable clue was
-- ignored: the SENDER'S DOMAIN. canyongateatcincoranch.com IS Canyon Gate.
--
-- This table maps a community's OWN email domain(s) to the community, so a bill
-- (or any email) from that domain resolves the association with certainty,
-- above any fuzzy text guess.
--
-- IMPORTANT: only COMMUNITY-OWNED domains belong here — the HOA's / property
-- manager's own domain. NEVER a vendor domain (besttrashtexas.com,
-- texaspridedisposal.com, swimhoustonpools.com serve MANY communities; mapping
-- them would recreate the shared-vendor trap in reverse). The map grows
-- deliberately, one confirmed community domain at a time.
--
-- Record ownership: workpaper (Bedrock routing configuration, not an
-- association record).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS community_email_domains (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  domain       text NOT NULL UNIQUE,          -- store lowercased; one domain -> one community
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE community_email_domains IS
  'Maps a community''s OWN email domain(s) to the community, as an authoritative sender-domain signal for AP/email intake. Community-owned domains ONLY — never vendor domains. (mig 389, Ed 2026-08-25)';

CREATE INDEX IF NOT EXISTS ix_community_email_domains_community
  ON community_email_domains(community_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON community_email_domains TO service_role;
GRANT SELECT                          ON community_email_domains TO authenticated;

-- Seed the one confirmed community-owned domain (the misfiled bill's sender).
INSERT INTO community_email_domains (community_id, domain, note)
SELECT id, 'canyongateatcincoranch.com', 'Community-owned property-manager domain (seed, Ed 2026-08-25)'
FROM communities WHERE slug = 'canyon-gate'
ON CONFLICT (domain) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
