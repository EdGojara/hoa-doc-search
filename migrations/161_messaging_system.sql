-- 161_messaging_system.sql
--
-- Messaging System Phase 1 — Ed 2026-06-04 design session locked in
-- this as the foundation for Bedrock ↔ homeowner communication. Every
-- channel (in-portal, SMS, push, email, voice) eventually flows into ONE
-- canonical conversation thread anchored to a property.
--
-- Record ownership (per CLAUDE.md):
--   - homeowner_threads: MIXED. Message bodies sent to/from the homeowner
--     are association_record (delivered to a homeowner = theirs on
--     termination). Routing metadata, status, Claire's classification,
--     SLA timestamps are workpaper (internal to Bedrock's production
--     process).
--   - messages: same — body_text is association_record, claire_metadata
--     and sla_metadata are workpaper. Per-row record_ownership column
--     so the export tool can filter.
--   - thread_audit_log: PURE workpaper. Internal accountability layer.
--
-- Bezos accountability mechanisms baked into schema:
--   - SLA target timestamps + breach timestamps on every thread
--   - last_responder_type + last_responder_id surfaced for staff visibility
--   - next_action_status drives the master inbox view sort
--   - closure_proposed_at + closure_acknowledged_at for the empty-chair
--     close flow (no unilateral close)
--   - thread_audit_log captures every status transition so we can replay
--     any thread's full history for ops review or legal
--
-- One-way doors locked in:
--   - Threads are (property_id, primary_contact_id, subject_topic) — NOT
--     (homeowner_id, topic). A homeowner with 3 properties has 3 thread
--     namespaces. Property is the anchor because violations / ARC /
--     balance are all property-level.
--   - Portal is the canonical channel; other channels mirror to it.
--   - Every event timestamps with timestamptz (Postgres microsecond
--     precision) so future analytics aren't blocked.

BEGIN;

-- =============================================================================
-- homeowner_threads
-- =============================================================================
CREATE TABLE IF NOT EXISTS homeowner_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Anchor identity (locked in by design)
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  primary_contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,

  -- Subject + topic
  subject text NOT NULL,                              -- Claire auto-suggests, staff can override
  topic_tag text,                                     -- compliance | amenity | arc | vendor | financial | general | other
                                                      -- Auto-classified for analytics + routing.
                                                      -- Homeowner never sees this.

  -- Lifecycle
  next_action_status text NOT NULL DEFAULT 'awaiting_staff_first_response'
    CHECK (next_action_status IN (
      'awaiting_staff_first_response',
      'awaiting_homeowner',
      'awaiting_staff_followup',
      'awaiting_external',                            -- vendor / board / attorney
      'closure_pending',                              -- 24h ack window
      'closed',
      'escalated_to_attorney'
    )),

  -- Ownership + Claire state
  assigned_staff_id uuid,                             -- nullable until claimed
  claire_state text NOT NULL DEFAULT 'paused'         -- conservative default; Claire wires in Phase 2
    CHECK (claire_state IN ('active', 'paused', 'escalated')),

  -- Activity timestamps (Bezos accountability — every event tracked)
  last_message_at timestamptz,
  last_homeowner_message_at timestamptz,
  last_staff_message_at timestamptz,
  last_responder_type text                            -- homeowner | staff | claire | system
    CHECK (last_responder_type IS NULL OR last_responder_type IN ('homeowner','staff','claire','system')),
  last_responder_id uuid,                             -- contact_id / staff_user_id / null for claire

  -- SLA traffic-light system (Bezos: mechanisms not good intentions).
  -- Starting LOOSE so team isn't discouraged by metrics they can't reach.
  -- Ed 2026-06-04 directive: tighten over time as the team builds the muscle.
  -- Thresholds live in lib/messaging/sla_engine.js — adjustable any time
  -- without a migration since they're code constants, not DB columns:
  --   first_response_due_at = created_at + 8 business hours (1 business day)
  --   breached_yellow_at  = first_response_due_at + 12h passes
  --   breached_red_at     = first_response_due_at + 24h passes
  --   breached_overdue_at = first_response_due_at + 48h passes → escalate
  first_response_due_at timestamptz,
  first_responded_at timestamptz,                     -- captured on first outbound staff message
  breached_yellow_at timestamptz,
  breached_red_at timestamptz,
  breached_overdue_at timestamptz,

  -- Close-with-agreement flow (empty-chair lens applied)
  closure_proposed_at timestamptz,                    -- when staff hit "Propose Close"
  closure_proposed_by_staff_id uuid,
  closure_acknowledged_at timestamptz,                -- homeowner said "all good" OR replied with new content
  closed_at timestamptz,
  closed_reason text                                  -- homeowner_agreed | auto_after_silent_24h | staff_override | reopened
    CHECK (closed_reason IS NULL OR closed_reason IN ('homeowner_agreed','auto_after_silent_24h','staff_override','reopened')),

  -- Record ownership per CLAUDE.md (mixed table)
  record_ownership text NOT NULL DEFAULT 'mixed'
    CHECK (record_ownership IN ('association_record','workpaper','mixed')),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ht_community ON homeowner_threads(community_id);
CREATE INDEX IF NOT EXISTS idx_ht_property ON homeowner_threads(property_id);
CREATE INDEX IF NOT EXISTS idx_ht_contact ON homeowner_threads(primary_contact_id);
CREATE INDEX IF NOT EXISTS idx_ht_status ON homeowner_threads(next_action_status) WHERE next_action_status != 'closed';
CREATE INDEX IF NOT EXISTS idx_ht_assigned ON homeowner_threads(assigned_staff_id) WHERE next_action_status != 'closed';
CREATE INDEX IF NOT EXISTS idx_ht_last_message ON homeowner_threads(last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_ht_sla_overdue ON homeowner_threads(first_response_due_at) WHERE first_responded_at IS NULL AND next_action_status != 'closed';
CREATE INDEX IF NOT EXISTS idx_ht_closure_pending ON homeowner_threads(closure_proposed_at) WHERE next_action_status = 'closure_pending';

DROP TRIGGER IF EXISTS trg_ht_updated_at ON homeowner_threads;
CREATE TRIGGER trg_ht_updated_at
  BEFORE UPDATE ON homeowner_threads
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- =============================================================================
-- messages
-- =============================================================================
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES homeowner_threads(id) ON DELETE CASCADE,

  -- Direction relative to Bedrock
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),

  -- Sender
  sender_type text NOT NULL CHECK (sender_type IN ('homeowner','staff','claire','system')),
  sender_id uuid,                                     -- contact_id / staff_user_id / null for claire/system
  sender_display_name text,                           -- captured at send time for audit (staff names can change)

  -- Channel — portal is canonical; everything else mirrors to portal thread.
  channel text NOT NULL DEFAULT 'portal'
    CHECK (channel IN ('portal','sms','push','email','voice_transcript','system_notice')),

  -- Content
  body_text text NOT NULL,
  body_html text,                                     -- rendered HTML if email/portal-with-formatting
  attachments_jsonb jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{type, url, filename, size_bytes, mime}]

  -- Claire metadata (when she drafted/sent — workpaper portion)
  claire_metadata_jsonb jsonb DEFAULT '{}'::jsonb,    -- {reasoning, retrieved_chunks, confidence, why_escalated, draft_iterations}

  -- Delivery + read tracking (Bezos: measure everything)
  delivered_at timestamptz,                           -- when system marked as delivered to channel
  read_at timestamptz,                                -- when recipient first opened
  read_count int NOT NULL DEFAULT 0,                  -- multiple opens tracked
  last_read_at timestamptz,

  -- For inbound: which external channel-event triggered this row
  external_event_id text,                             -- twilio sid / resend msg_id / etc.

  -- Record ownership per CLAUDE.md
  -- Most messages are association_record (delivered to homeowner). System
  -- notices and Claire's internal-reasoning rows are workpaper.
  record_ownership text NOT NULL DEFAULT 'association_record'
    CHECK (record_ownership IN ('association_record','workpaper')),

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_unread ON messages(thread_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_msg_sender ON messages(sender_type, sender_id);
CREATE INDEX IF NOT EXISTS idx_msg_channel ON messages(channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_external ON messages(external_event_id) WHERE external_event_id IS NOT NULL;

-- =============================================================================
-- thread_audit_log — workpaper, immutable replay history
-- Every status transition, every assignment change, every Claire decision
-- gets a row here. Lets us answer "what happened to this thread?" cleanly
-- in 6 months for ops review, legal review, or homeowner dispute.
-- =============================================================================
CREATE TABLE IF NOT EXISTS thread_audit_log (
  id bigserial PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES homeowner_threads(id) ON DELETE CASCADE,
  event_type text NOT NULL
    CHECK (event_type IN (
      'created',
      'status_changed',
      'assigned',
      'unassigned',
      'reassigned',
      'message_sent',
      'message_received',
      'claire_responded',
      'claire_escalated',
      'closure_proposed',
      'closure_acknowledged',
      'closed',
      'reopened',
      'sla_breached_yellow',
      'sla_breached_red',
      'sla_breached_overdue',
      'attached_to_violation',
      'attached_to_arc',
      'note_added'
    )),
  actor_type text                                     -- homeowner | staff | claire | system
    CHECK (actor_type IS NULL OR actor_type IN ('homeowner','staff','claire','system')),
  actor_id uuid,
  payload_jsonb jsonb DEFAULT '{}'::jsonb,            -- old/new values + context
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tal_thread ON thread_audit_log(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tal_event ON thread_audit_log(event_type, created_at DESC);

-- =============================================================================
-- Auto-fill audit log on thread updates
-- =============================================================================
CREATE OR REPLACE FUNCTION trusted_thread_audit_handler() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO thread_audit_log (thread_id, event_type, actor_type, payload_jsonb)
    VALUES (NEW.id, 'created', 'system', jsonb_build_object(
      'community_id', NEW.community_id,
      'property_id', NEW.property_id,
      'subject', NEW.subject
    ));
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Status changed
    IF OLD.next_action_status IS DISTINCT FROM NEW.next_action_status THEN
      INSERT INTO thread_audit_log (thread_id, event_type, payload_jsonb)
      VALUES (NEW.id, 'status_changed', jsonb_build_object(
        'from', OLD.next_action_status,
        'to', NEW.next_action_status
      ));
    END IF;
    -- Assignment changed
    IF OLD.assigned_staff_id IS DISTINCT FROM NEW.assigned_staff_id THEN
      INSERT INTO thread_audit_log (thread_id, event_type, payload_jsonb)
      VALUES (NEW.id, CASE
        WHEN NEW.assigned_staff_id IS NULL THEN 'unassigned'
        WHEN OLD.assigned_staff_id IS NULL THEN 'assigned'
        ELSE 'reassigned'
      END, jsonb_build_object(
        'from_staff_id', OLD.assigned_staff_id,
        'to_staff_id', NEW.assigned_staff_id
      ));
    END IF;
    -- Closure proposed
    IF OLD.closure_proposed_at IS DISTINCT FROM NEW.closure_proposed_at AND NEW.closure_proposed_at IS NOT NULL THEN
      INSERT INTO thread_audit_log (thread_id, event_type, actor_id, payload_jsonb)
      VALUES (NEW.id, 'closure_proposed', NEW.closure_proposed_by_staff_id, jsonb_build_object(
        'proposed_at', NEW.closure_proposed_at
      ));
    END IF;
    -- Closed
    IF OLD.closed_at IS DISTINCT FROM NEW.closed_at AND NEW.closed_at IS NOT NULL THEN
      INSERT INTO thread_audit_log (thread_id, event_type, payload_jsonb)
      VALUES (NEW.id, 'closed', jsonb_build_object(
        'reason', NEW.closed_reason
      ));
    END IF;
    -- Reopened (closed_at was set, now null)
    IF OLD.closed_at IS NOT NULL AND NEW.closed_at IS NULL THEN
      INSERT INTO thread_audit_log (thread_id, event_type, payload_jsonb)
      VALUES (NEW.id, 'reopened', '{}'::jsonb);
    END IF;
    -- SLA breach transitions (yellow / red / overdue)
    IF OLD.breached_yellow_at IS NULL AND NEW.breached_yellow_at IS NOT NULL THEN
      INSERT INTO thread_audit_log (thread_id, event_type, payload_jsonb)
      VALUES (NEW.id, 'sla_breached_yellow', '{}'::jsonb);
    END IF;
    IF OLD.breached_red_at IS NULL AND NEW.breached_red_at IS NOT NULL THEN
      INSERT INTO thread_audit_log (thread_id, event_type, payload_jsonb)
      VALUES (NEW.id, 'sla_breached_red', '{}'::jsonb);
    END IF;
    IF OLD.breached_overdue_at IS NULL AND NEW.breached_overdue_at IS NOT NULL THEN
      INSERT INTO thread_audit_log (thread_id, event_type, payload_jsonb)
      VALUES (NEW.id, 'sla_breached_overdue', '{}'::jsonb);
    END IF;
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ht_audit ON homeowner_threads;
CREATE TRIGGER trg_ht_audit
  AFTER INSERT OR UPDATE ON homeowner_threads
  FOR EACH ROW EXECUTE FUNCTION trusted_thread_audit_handler();

-- Auto-fill audit log on message insert
CREATE OR REPLACE FUNCTION trusted_message_audit_handler() RETURNS trigger AS $$
BEGIN
  INSERT INTO thread_audit_log (thread_id, event_type, actor_type, actor_id, payload_jsonb)
  VALUES (NEW.thread_id,
    CASE WHEN NEW.direction = 'outbound' THEN 'message_sent' ELSE 'message_received' END,
    NEW.sender_type, NEW.sender_id,
    jsonb_build_object(
      'message_id', NEW.id,
      'channel', NEW.channel,
      'has_attachments', jsonb_array_length(COALESCE(NEW.attachments_jsonb, '[]'::jsonb)) > 0
    ));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_msg_audit ON messages;
CREATE TRIGGER trg_msg_audit
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION trusted_message_audit_handler();

-- =============================================================================
-- Update thread timestamps on new message
-- Keeps last_message_at + last_responder fields synced without app-layer code.
-- Also auto-computes first_responded_at on first outbound staff/claire message.
-- =============================================================================
CREATE OR REPLACE FUNCTION trusted_thread_activity_sync() RETURNS trigger AS $$
DECLARE
  v_thread homeowner_threads%ROWTYPE;
BEGIN
  SELECT * INTO v_thread FROM homeowner_threads WHERE id = NEW.thread_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  UPDATE homeowner_threads
  SET
    last_message_at = NEW.created_at,
    last_responder_type = NEW.sender_type,
    last_responder_id = NEW.sender_id,
    last_homeowner_message_at = CASE WHEN NEW.sender_type = 'homeowner' THEN NEW.created_at ELSE last_homeowner_message_at END,
    last_staff_message_at = CASE WHEN NEW.sender_type IN ('staff','claire') THEN NEW.created_at ELSE last_staff_message_at END,
    -- First-response tracking: when staff or claire sends an outbound and it's the first one
    first_responded_at = CASE
      WHEN first_responded_at IS NULL AND NEW.direction = 'outbound' AND NEW.sender_type IN ('staff','claire')
      THEN NEW.created_at
      ELSE first_responded_at
    END,
    -- Status auto-flip rules
    next_action_status = CASE
      -- New inbound from homeowner → ball is back with staff
      WHEN NEW.sender_type = 'homeowner' AND v_thread.next_action_status IN ('awaiting_homeowner', 'closure_pending')
        THEN 'awaiting_staff_followup'
      WHEN NEW.sender_type = 'homeowner' AND v_thread.next_action_status = 'closed'
        THEN 'awaiting_staff_followup'  -- reopen
      -- Outbound from staff/claire → ball goes to homeowner
      WHEN NEW.direction = 'outbound' AND NEW.sender_type IN ('staff','claire')
        AND v_thread.next_action_status IN ('awaiting_staff_first_response', 'awaiting_staff_followup')
        THEN 'awaiting_homeowner'
      ELSE next_action_status
    END,
    -- If homeowner replied during closure_pending OR after close → reopen
    closure_proposed_at = CASE
      WHEN NEW.sender_type = 'homeowner' AND v_thread.next_action_status = 'closure_pending'
        THEN NULL  -- closure offer canceled
      ELSE closure_proposed_at
    END,
    closed_at = CASE
      WHEN NEW.sender_type = 'homeowner' AND v_thread.closed_at IS NOT NULL
        THEN NULL  -- reopen
      ELSE closed_at
    END,
    closed_reason = CASE
      WHEN NEW.sender_type = 'homeowner' AND v_thread.closed_at IS NOT NULL
        THEN 'reopened'
      ELSE closed_reason
    END
  WHERE id = NEW.thread_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_msg_thread_sync ON messages;
CREATE TRIGGER trg_msg_thread_sync
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION trusted_thread_activity_sync();

-- =============================================================================
-- Grants
-- =============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON homeowner_threads TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON messages TO service_role;
GRANT SELECT, INSERT ON thread_audit_log TO service_role;
GRANT USAGE, SELECT ON SEQUENCE thread_audit_log_id_seq TO service_role;

-- Authenticated staff can read threads / messages / audit log via the API
-- (RLS handled at the API layer for now — homeowner-portal-side reads go
-- through magic-link-cookie auth in a separate code path).
GRANT SELECT ON homeowner_threads TO authenticated;
GRANT SELECT ON messages TO authenticated;
GRANT SELECT ON thread_audit_log TO authenticated;

COMMIT;
