-- ============================================================================
-- 423_video_shares.sql  (Ed 2026-09-13)
-- ----------------------------------------------------------------------------
-- Quick, private, revocable video links. Ed records a mini video (e.g. Priya
-- speaking Hindi to one resident, or a demo of the AI team for a prospect),
-- uploads it, and sends ONE unguessable link. Taking it down actually revokes
-- access: the file lives in a PRIVATE bucket and the watch page mints a
-- short-lived signed playback URL each view, so once `active` is false no new
-- playback URL is ever issued.
--
-- Record ownership: WORKPAPER (Bedrock marketing / demo asset). Not an
-- association record; nothing here is delivered on behalf of an HOA.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS video_shares (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token          text UNIQUE NOT NULL,           -- unguessable id used in the /v/<token> link
  title          text,                           -- internal label ("Priya intro for the Sharmas")
  recipient_name text,                           -- greets them on the page ("Hi Anjali,")
  persona        text,                           -- which AI teammate is featured (claire/priya/...)
  community_id   uuid REFERENCES communities(id) ON DELETE SET NULL,
  storage_path   text NOT NULL,                  -- path inside the private 'videos' bucket
  content_type   text,
  file_size      bigint,
  uploaded       boolean NOT NULL DEFAULT false, -- flips true once the browser finishes the upload
  active         boolean NOT NULL DEFAULT true,  -- false = taken down (link goes dead)
  view_count     integer NOT NULL DEFAULT 0,
  last_viewed_at timestamptz,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_video_shares_token   ON video_shares (token);
CREATE INDEX IF NOT EXISTS idx_video_shares_created ON video_shares (created_at DESC);

-- updated_at maintenance (standard helper).
DROP TRIGGER IF EXISTS trg_video_shares_updated ON video_shares;
CREATE TRIGGER trg_video_shares_updated BEFORE UPDATE ON video_shares
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON video_shares TO service_role;
GRANT SELECT                          ON video_shares TO authenticated;

-- Private bucket for the video files. Playback is always via a short-lived
-- signed URL minted by the watch route; never public.
INSERT INTO storage.buckets (id, name, public)
VALUES ('videos', 'videos', false)
ON CONFLICT (id) DO NOTHING;

COMMIT;
