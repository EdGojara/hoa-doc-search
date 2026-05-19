-- Postcard reminders between Courtesy 1 and Courtesy 2.
-- ---------------------------------------------------------------------------
-- The structural answer to "I never got the letter": between Courtesy 1
-- (envelope) and Courtesy 2 (envelope), drop a postcard. Different physical
-- artifact, sorted differently by the homeowner — envelopes get bucketed
-- with credit-card offers; postcards get read because they're already open.
-- Cheap (~$0.45 USPS postcard rate vs ~$0.66 first-class envelope) and the
-- third independent attempt makes the "never got it" complaint difficult
-- to maintain.
--
-- Mechanic:
--   1. Scheduler (lib/scheduler.js) sweeps daily at 06:00 Central for
--      courtesy_1 violations where the cure window is still open and
--      no postcard reminder has been mailed for this violation yet.
--   2. For each, generate a postcard PDF + insert an interactions row
--      with type='letter_postcard_reminder', status='draft'.
--   3. Operator prints + mails from the Mail Queue (Lock + print path).
--   4. Postmark date stamped at mail-out time, just like envelopes.

-- Add the new interaction type to the CHECK constraint
ALTER TABLE interactions
  DROP CONSTRAINT IF EXISTS interactions_type_check;

ALTER TABLE interactions
  ADD CONSTRAINT interactions_type_check
  CHECK (type IN (
    'email_inbound','email_outbound',
    'letter_courtesy_1','letter_courtesy_2','letter_209',
    'letter_postcard_reminder',
    'letter_other','phone','in_person','sms',
    'board_communication','vendor_communication',
    'ai_draft','observation_note','internal_note'
  ));

-- Per-community postcard timing (days after Courtesy 1 mail-out)
ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS postcard_reminder_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS postcard_reminder_days    INTEGER NOT NULL DEFAULT 7;
