-- ============================================================================
-- 191_drama_creek_messaging_seed_fix.sql
-- ----------------------------------------------------------------------------
-- Replaces migration 190, which failed because:
--   1. closed_reason = 'mutual_agreement' is not in the CHECK constraint
--      (valid: homeowner_agreed | auto_after_silent_24h | staff_override |
--       reopened) — Sarah's thread used the invalid value
--   2. homeowner_threads doesn't have escalated_at / escalated_reason
--      columns — those were invented in migration 190 for Greg's thread
--      (escalation is captured via next_action_status='escalated_to_attorney'
--       only; no separate timestamp/reason columns)
--
-- This migration does what 190 was supposed to do, with constraint-valid
-- values and only real columns. Idempotent. Mark 190 as a historical
-- failure in the migration runner.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- THREAD 1 — Jennifer Lateleaves — contractor scheduling
-- ----------------------------------------------------------------------------
INSERT INTO homeowner_threads (
  id, community_id, property_id, primary_contact_id,
  subject, topic_tag,
  next_action_status,
  created_at, first_response_due_at, first_responded_at,
  last_homeowner_message_at, last_staff_message_at
) VALUES (
  'dc190001-0000-4000-a000-000000000000',
  'dc100000-0000-4000-a000-000000000000',
  'dc110011-0000-4000-a000-000000000000',
  'dc100007-0000-4000-a000-000000000000',
  'Lawn courtesy notice — contractor scheduled',
  'compliance',
  'awaiting_staff_followup',
  NOW() - INTERVAL '3 days',
  NOW() - INTERVAL '3 days' + INTERVAL '8 hours',
  NOW() - INTERVAL '3 days' + INTERVAL '2 hours',
  NOW() - INTERVAL '1 day' - INTERVAL '4 hours',
  NOW() - INTERVAL '3 days' + INTERVAL '2 hours'
) ON CONFLICT (id) DO UPDATE
  SET subject = EXCLUDED.subject,
      next_action_status = EXCLUDED.next_action_status;

INSERT INTO messages (id, thread_id, direction, sender_type, sender_id, sender_display_name, channel, body_text, created_at)
VALUES
  ('dc1a0001-0000-4000-a000-000000000000', 'dc190001-0000-4000-a000-000000000000',
   'inbound', 'homeowner', 'dc100007-0000-4000-a000-000000000000', 'Jennifer Lateleaves', 'portal',
   'Hi — got the courtesy notice about my front yard. Contractor is scheduled for Tuesday morning. Should be all cleaned up by EOD. Wanted to flag it before the cure period gets closer.',
   NOW() - INTERVAL '3 days'),
  ('dc1a0002-0000-4000-a000-000000000000', 'dc190001-0000-4000-a000-000000000000',
   'outbound', 'staff', NULL, 'Bedrock Team', 'portal',
   'Thanks for letting us know, Jennifer. Tuesday works — we''ll plan to inspect after the work is done. If anything changes on the contractor side, just reply here.',
   NOW() - INTERVAL '3 days' + INTERVAL '2 hours'),
  ('dc1a0003-0000-4000-a000-000000000000', 'dc190001-0000-4000-a000-000000000000',
   'inbound', 'homeowner', 'dc100007-0000-4000-a000-000000000000', 'Jennifer Lateleaves', 'portal',
   'Update: contractor pushed to Thursday — weather. Still well within the cure window. Sorry for the back-and-forth.',
   NOW() - INTERVAL '1 day' - INTERVAL '4 hours')
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- THREAD 2 — Sarah Welcome — pool fob (CLOSED via homeowner_agreed)
-- ----------------------------------------------------------------------------
INSERT INTO homeowner_threads (
  id, community_id, property_id, primary_contact_id,
  subject, topic_tag,
  next_action_status,
  created_at, first_response_due_at, first_responded_at,
  last_homeowner_message_at, last_staff_message_at,
  closure_proposed_at, closed_at, closed_reason
) VALUES (
  'dc190002-0000-4000-a000-000000000000',
  'dc100000-0000-4000-a000-000000000000',
  'dc110050-0000-4000-a000-000000000000',
  'dc10000b-0000-4000-a000-000000000000',
  'Pool fob — new owner',
  'amenity',
  'closed',
  NOW() - INTERVAL '10 days',
  NOW() - INTERVAL '10 days' + INTERVAL '8 hours',
  NOW() - INTERVAL '10 days' + INTERVAL '1 hour',
  NOW() - INTERVAL '8 days',
  NOW() - INTERVAL '8 days' + INTERVAL '30 minutes',
  NOW() - INTERVAL '8 days' + INTERVAL '4 hours',
  NOW() - INTERVAL '7 days',
  'homeowner_agreed'
) ON CONFLICT (id) DO UPDATE
  SET next_action_status = EXCLUDED.next_action_status,
      closed_at = EXCLUDED.closed_at,
      closed_reason = EXCLUDED.closed_reason;

INSERT INTO messages (id, thread_id, direction, sender_type, sender_id, sender_display_name, channel, body_text, created_at)
VALUES
  ('dc1a0004-0000-4000-a000-000000000000', 'dc190002-0000-4000-a000-000000000000',
   'inbound', 'homeowner', 'dc10000b-0000-4000-a000-000000000000', 'Sarah Welcome', 'portal',
   'Hi — just closed on 331 Calm Waters Way and we''d love to get pool fobs set up for the family before the weekend. What''s the process?',
   NOW() - INTERVAL '10 days'),
  ('dc1a0005-0000-4000-a000-000000000000', 'dc190002-0000-4000-a000-000000000000',
   'outbound', 'claire', NULL, 'Claire (AI assistant)', 'portal',
   'Welcome to Drama Creek, Sarah! I''ll email you the key fob application — fill it out and send back, and the team can usually process within 2-3 business days. I''ll also note the urgency for the weekend.',
   NOW() - INTERVAL '10 days' + INTERVAL '1 hour'),
  ('dc1a0006-0000-4000-a000-000000000000', 'dc190002-0000-4000-a000-000000000000',
   'inbound', 'homeowner', 'dc10000b-0000-4000-a000-000000000000', 'Sarah Welcome', 'portal',
   'Got the application, sent it back yesterday. Just wanted to confirm receipt.',
   NOW() - INTERVAL '8 days'),
  ('dc1a0007-0000-4000-a000-000000000000', 'dc190002-0000-4000-a000-000000000000',
   'outbound', 'staff', NULL, 'Bedrock Team', 'portal',
   'Confirmed received, Sarah. Fobs activated this morning — you should be set for the weekend. Welcome to the community!',
   NOW() - INTERVAL '8 days' + INTERVAL '30 minutes')
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- THREAD 3 — Marcus Behindbills — payment plan (awaiting_homeowner)
-- ----------------------------------------------------------------------------
INSERT INTO homeowner_threads (
  id, community_id, property_id, primary_contact_id,
  subject, topic_tag,
  next_action_status,
  created_at, first_response_due_at, first_responded_at,
  last_homeowner_message_at, last_staff_message_at
) VALUES (
  'dc190003-0000-4000-a000-000000000000',
  'dc100000-0000-4000-a000-000000000000',
  'dc110021-0000-4000-a000-000000000000',
  'dc100008-0000-4000-a000-000000000000',
  'Payment plan — confirming October installment',
  'financial',
  'awaiting_homeowner',
  NOW() - INTERVAL '2 days',
  NOW() - INTERVAL '2 days' + INTERVAL '8 hours',
  NOW() - INTERVAL '2 days' + INTERVAL '3 hours',
  NOW() - INTERVAL '2 days',
  NOW() - INTERVAL '2 days' + INTERVAL '3 hours'
) ON CONFLICT (id) DO UPDATE
  SET next_action_status = EXCLUDED.next_action_status;

INSERT INTO messages (id, thread_id, direction, sender_type, sender_id, sender_display_name, channel, body_text, created_at)
VALUES
  ('dc1a0008-0000-4000-a000-000000000000', 'dc190003-0000-4000-a000-000000000000',
   'inbound', 'homeowner', 'dc100008-0000-4000-a000-000000000000', 'Marcus Behindbills', 'portal',
   'Confirming the next $200 payment is due October 1 like the plan says. Got laid off a few weeks ago, just want to make sure nothing has changed on your end before I send it.',
   NOW() - INTERVAL '2 days'),
  ('dc1a0009-0000-4000-a000-000000000000', 'dc190003-0000-4000-a000-000000000000',
   'outbound', 'staff', NULL, 'Bedrock Team', 'portal',
   'Hi Marcus — plan terms are unchanged: $200/month through October 2026, October installment due 10/1. Sorry to hear about the job change — if you need to adjust the cadence at any point, reply here and we can talk through what works. No pressure either way.',
   NOW() - INTERVAL '2 days' + INTERVAL '3 hours')
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- THREAD 4 — Patricia Newpaint — ARC timing (closure_pending)
-- ----------------------------------------------------------------------------
INSERT INTO homeowner_threads (
  id, community_id, property_id, primary_contact_id,
  subject, topic_tag,
  next_action_status,
  created_at, first_response_due_at, first_responded_at,
  last_homeowner_message_at, last_staff_message_at,
  closure_proposed_at
) VALUES (
  'dc190004-0000-4000-a000-000000000000',
  'dc100000-0000-4000-a000-000000000000',
  'dc110035-0000-4000-a000-000000000000',
  'dc100009-0000-4000-a000-000000000000',
  'ARC repaint — committee timing',
  'arc',
  'closure_pending',
  NOW() - INTERVAL '5 days',
  NOW() - INTERVAL '5 days' + INTERVAL '8 hours',
  NOW() - INTERVAL '5 days' + INTERVAL '1 hour',
  NOW() - INTERVAL '4 days',
  NOW() - INTERVAL '12 hours',
  NOW() - INTERVAL '12 hours'
) ON CONFLICT (id) DO UPDATE
  SET next_action_status = EXCLUDED.next_action_status,
      closure_proposed_at = EXCLUDED.closure_proposed_at;

INSERT INTO messages (id, thread_id, direction, sender_type, sender_id, sender_display_name, channel, body_text, created_at)
VALUES
  ('dc1a000a-0000-4000-a000-000000000000', 'dc190004-0000-4000-a000-000000000000',
   'inbound', 'homeowner', 'dc100009-0000-4000-a000-000000000000', 'Patricia Newpaint', 'portal',
   'Hi — submitted my exterior repaint app last week (sage green w/ white trim). Just wondering about the timeline since I''m hoping to start before the fall weather.',
   NOW() - INTERVAL '5 days'),
  ('dc1a000b-0000-4000-a000-000000000000', 'dc190004-0000-4000-a000-000000000000',
   'outbound', 'staff', NULL, 'Bedrock Team', 'portal',
   'Hi Patricia — your submission''s in the queue for the next ACC committee review (10 business days from submission per the guidelines). You''ll receive a decision letter as soon as the committee meets. Sage green is a popular request lately, so you''re in good company.',
   NOW() - INTERVAL '5 days' + INTERVAL '1 hour'),
  ('dc1a000c-0000-4000-a000-000000000000', 'dc190004-0000-4000-a000-000000000000',
   'inbound', 'homeowner', 'dc100009-0000-4000-a000-000000000000', 'Patricia Newpaint', 'portal',
   'Thanks — that helps. Will wait for the letter.',
   NOW() - INTERVAL '4 days'),
  ('dc1a000d-0000-4000-a000-000000000000', 'dc190004-0000-4000-a000-000000000000',
   'outbound', 'staff', NULL, 'Bedrock Team', 'portal',
   'Sounds good. If you don''t hear back within 10 business days, message us here and we''ll check in with the committee. Looks like this one''s resolved — I''ll close it out unless you have more to add.',
   NOW() - INTERVAL '12 hours')
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- THREAD 5 — Greg Yardgone — hardship inquiry (escalated_to_attorney)
-- No separate escalated_at column exists; the state lives on next_action_status.
-- ----------------------------------------------------------------------------
INSERT INTO homeowner_threads (
  id, community_id, property_id, primary_contact_id,
  subject, topic_tag,
  next_action_status,
  created_at, first_response_due_at, first_responded_at,
  last_homeowner_message_at, last_staff_message_at
) VALUES (
  'dc190005-0000-4000-a000-000000000000',
  'dc100000-0000-4000-a000-000000000000',
  'dc110041-0000-4000-a000-000000000000',
  'dc10000a-0000-4000-a000-000000000000',
  'Hardship — account at attorney',
  'financial',
  'escalated_to_attorney',
  NOW() - INTERVAL '6 days',
  NOW() - INTERVAL '6 days' + INTERVAL '8 hours',
  NOW() - INTERVAL '6 days' + INTERVAL '4 hours',
  NOW() - INTERVAL '6 days',
  NOW() - INTERVAL '6 days' + INTERVAL '4 hours'
) ON CONFLICT (id) DO UPDATE
  SET next_action_status = EXCLUDED.next_action_status;

INSERT INTO messages (id, thread_id, direction, sender_type, sender_id, sender_display_name, channel, body_text, created_at)
VALUES
  ('dc1a000e-0000-4000-a000-000000000000', 'dc190005-0000-4000-a000-000000000000',
   'inbound', 'homeowner', 'dc10000a-0000-4000-a000-000000000000', 'Greg Yardgone', 'portal',
   'I''m dealing with a serious medical situation and the assessments have gotten away from me. Is there any way to set up a hardship arrangement before this goes further?',
   NOW() - INTERVAL '6 days'),
  ('dc1a000f-0000-4000-a000-000000000000', 'dc190005-0000-4000-a000-000000000000',
   'outbound', 'staff', NULL, 'Bedrock Team', 'portal',
   'Hi Greg — really sorry to hear what you''re going through. Honest piece: once an account moves to collections counsel (which yours has), the management side can''t negotiate hardship terms directly — that''s the attorney''s call. I''m connecting you with their contact directly so you can raise the hardship piece with them. They''re typically responsive to medical situations.',
   NOW() - INTERVAL '6 days' + INTERVAL '4 hours')
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
--   SELECT next_action_status, count(*)
--   FROM homeowner_threads
--   WHERE community_id = 'dc100000-0000-4000-a000-000000000000'
--   GROUP BY next_action_status;
--   -- Expected: 5 rows total, one per status
-- ============================================================================
