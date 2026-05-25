-- ============================================================================
-- 114_contact_methods.sql
-- ----------------------------------------------------------------------------
-- N emails + phones per contact, each with its own per-topic notification
-- subscription preferences. Solves the real-world case where a homeowner has
-- multiple email addresses and wants different topics routed to different
-- inboxes (e.g., husband's email gets billing, spouse's email gets events,
-- work email gets nothing).
--
-- Why a new table (not more columns on contacts):
--   - Genuine N-per-contact pattern; can't be modeled as flat columns
--   - Per-method notification subscriptions need their own row
--   - Adding a new email later shouldn't churn the contacts schema
--
-- Backfills from existing contacts.primary_email / .secondary_email /
-- .primary_phone / .secondary_phone so nothing is lost on the migration.
-- Legacy flat columns on contacts STAY for backwards compatibility (voice
-- caller-phone resolution and other code reads them); future writes go
-- through contact_methods and staff edits sync back to the legacy columns
-- in the application layer.
--
-- 7 notification topics chosen to match HOA-operator-felt distinctions:
--   general          — broadcasts, mailers, community announcements
--   events           — community events, parties, meetings (RSVP-relevant)
--   billing          — statements, invoices, late notices
--   violations       — DRV correspondence (courtesy + §209 + cure notices)
--   arc_decisions    — ARC approval / denial / conditional decisions
--   emergency        — water shutoffs, gate failures, urgent safety
--   payment_confirm  — auto-receipts after a successful payment
--
-- Apply AFTER 113. Idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS contact_methods (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id                      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

  method_type                     TEXT NOT NULL
                                    CHECK (method_type IN ('email', 'phone')),
  -- Subtype is free-text-but-categorical: 'primary', 'secondary', 'work',
  -- 'personal', 'cell', 'home', 'spouse', 'property_manager', etc.
  -- No CHECK so operators can use the labels that fit their world.
  subtype                         TEXT NULL,
  value                           TEXT NOT NULL,
  -- Optional user-provided label ("Husband's gmail", "Property manager —
  -- Maria")
  label                           TEXT NULL,
  is_primary                      BOOLEAN NOT NULL DEFAULT FALSE,

  -- Per-topic notification subscriptions. Defaults to TRUE for legitimate
  -- categories the homeowner is likely to want. Defaults to FALSE for
  -- payment_confirm (opt-in, matches contact_preferences default).
  notify_general                  BOOLEAN NOT NULL DEFAULT TRUE,
  notify_events                   BOOLEAN NOT NULL DEFAULT TRUE,
  notify_billing                  BOOLEAN NOT NULL DEFAULT TRUE,
  notify_violations               BOOLEAN NOT NULL DEFAULT TRUE,
  notify_arc_decisions            BOOLEAN NOT NULL DEFAULT TRUE,
  notify_emergency                BOOLEAN NOT NULL DEFAULT TRUE,
  notify_payment_confirm          BOOLEAN NOT NULL DEFAULT FALSE,

  -- Verification (email click-thru, SMS confirm) — populated by future
  -- verification workflow; nullable today.
  verified_at                     TIMESTAMPTZ NULL,
  verified_via                    TEXT NULL,

  notes                           TEXT NULL,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_methods_contact
  ON contact_methods (contact_id, method_type);
CREATE INDEX IF NOT EXISTS idx_contact_methods_value
  ON contact_methods (method_type, lower(value));
CREATE INDEX IF NOT EXISTS idx_contact_methods_primary
  ON contact_methods (contact_id, method_type)
  WHERE is_primary = TRUE;
-- For routing: "who wants notifications on topic X via email?"
CREATE INDEX IF NOT EXISTS idx_contact_methods_notify_general
  ON contact_methods (method_type, contact_id)
  WHERE notify_general = TRUE;
CREATE INDEX IF NOT EXISTS idx_contact_methods_notify_billing
  ON contact_methods (method_type, contact_id)
  WHERE notify_billing = TRUE;
CREATE INDEX IF NOT EXISTS idx_contact_methods_notify_events
  ON contact_methods (method_type, contact_id)
  WHERE notify_events = TRUE;

DROP TRIGGER IF EXISTS trg_contact_methods_set_updated_at ON contact_methods;
CREATE TRIGGER trg_contact_methods_set_updated_at
  BEFORE UPDATE ON contact_methods
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON contact_methods TO service_role;

-- ============================================================================
-- Backfill from existing contacts.primary_email / secondary_email / phones
-- ON CONFLICT clause: this table has no UNIQUE constraint, so duplicate
-- runs would insert duplicates. Guard with WHERE NOT EXISTS instead.
-- ============================================================================

INSERT INTO contact_methods (contact_id, method_type, subtype, value, is_primary, label)
SELECT c.id, 'email', 'primary', c.primary_email, TRUE, 'Primary email (auto-imported)'
FROM contacts c
WHERE c.primary_email IS NOT NULL
  AND TRIM(c.primary_email) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM contact_methods cm
    WHERE cm.contact_id = c.id
      AND cm.method_type = 'email'
      AND LOWER(cm.value) = LOWER(c.primary_email)
  );

INSERT INTO contact_methods (contact_id, method_type, subtype, value, is_primary, label)
SELECT c.id, 'email', 'secondary', c.secondary_email, FALSE, 'Secondary email (auto-imported)'
FROM contacts c
WHERE c.secondary_email IS NOT NULL
  AND TRIM(c.secondary_email) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM contact_methods cm
    WHERE cm.contact_id = c.id
      AND cm.method_type = 'email'
      AND LOWER(cm.value) = LOWER(c.secondary_email)
  );

INSERT INTO contact_methods (contact_id, method_type, subtype, value, is_primary, label)
SELECT c.id, 'phone', 'primary', c.primary_phone, TRUE, 'Primary phone (auto-imported)'
FROM contacts c
WHERE c.primary_phone IS NOT NULL
  AND TRIM(c.primary_phone) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM contact_methods cm
    WHERE cm.contact_id = c.id
      AND cm.method_type = 'phone'
      AND cm.value = c.primary_phone
  );

INSERT INTO contact_methods (contact_id, method_type, subtype, value, is_primary, label)
SELECT c.id, 'phone', 'secondary', c.secondary_phone, FALSE, 'Secondary phone (auto-imported)'
FROM contacts c
WHERE c.secondary_phone IS NOT NULL
  AND TRIM(c.secondary_phone) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM contact_methods cm
    WHERE cm.contact_id = c.id
      AND cm.method_type = 'phone'
      AND cm.value = c.secondary_phone
  );

COMMIT;

-- Verify after running:
--   SELECT method_type, COUNT(*) FROM contact_methods GROUP BY method_type;
--   SELECT c.full_name,
--          COUNT(*) FILTER (WHERE cm.method_type='email') AS emails,
--          COUNT(*) FILTER (WHERE cm.method_type='phone') AS phones
--   FROM contacts c LEFT JOIN contact_methods cm ON cm.contact_id = c.id
--   GROUP BY c.id, c.full_name ORDER BY emails DESC LIMIT 20;
