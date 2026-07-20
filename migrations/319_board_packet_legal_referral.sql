-- ===========================================================================
-- 319_board_packet_legal_referral.sql
-- ---------------------------------------------------------------------------
-- Adds the "Accounts Recommended for Legal Referral" board-packet section — the
-- items the board votes on to send to the attorney (seriously delinquent, aged,
-- not already with counsel). Board-ONLY (default_audience 'board', legal
-- confidentiality) so it never appears in the homeowner/attendee copy.
-- Mirrors migrations 314/315: the engine registry (DEFAULT_SECTIONS) is the
-- source of truth; this adds the matching template row + backfills draft packets.
-- ===========================================================================
BEGIN;

INSERT INTO board_packet_section_templates
  (section_key, display_name, description, default_order, required_default,
   supports_manual, supports_upload, supports_auto_trusted, supports_ai_generated,
   default_audience, data_schema_hint)
VALUES
  ('legal_referral', 'Accounts Recommended for Legal Referral',
   'Seriously delinquent, aged accounts not yet with counsel — the board votes on which to refer to the attorney. Native from the AR subledger + enforcement status. Board-only.',
   104, TRUE, TRUE, FALSE, TRUE, FALSE, 'board',
   '{"as_of":"2026-06-30","threshold":500,"count":0,"accounts":[{"address":"","owner":"","balance":0,"oldest_days":0,"status":null}]}'::jsonb)
ON CONFLICT (section_key) DO NOTHING;

-- Backfill into existing DRAFT packets so in-flight packages get it too.
INSERT INTO board_packet_sections (packet_id, section_key, section_order, input_mode, status, audience)
SELECT p.id, t.section_key, t.default_order, 'auto_from_trusted', 'pending', t.default_audience
FROM board_packets p
CROSS JOIN board_packet_section_templates t
WHERE p.status = 'draft'
  AND t.section_key = 'legal_referral'
  AND NOT EXISTS (
    SELECT 1 FROM board_packet_sections s
    WHERE s.packet_id = p.id AND s.section_key = t.section_key
  )
ON CONFLICT (packet_id, section_key) DO NOTHING;

COMMIT;
