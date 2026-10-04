# Media Studio V1: proposed schema (NOT applied)

Status: proposal for Ed's review (Issue #10). V1 stores projects as JSON files
(`lib/media/studio_store.js`) because no migration was authorized for this pass.
Render's disk is ephemeral, so the file store is for local review only. This
migration replaces it behind the same `list / get / save` seam.

Record ownership: `workpaper` (Bedrock production IP). A delivered video is an
`association_record` only when it is delivered to a board or homeowners; that is
recorded on the export, not here.

```sql
BEGIN;
-- 489_media_studio_projects.sql (proposed)
CREATE TABLE IF NOT EXISTS media_projects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title            text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('training','announcement','explainer','brand')),
  brief            text NOT NULL,
  audience         text,
  target_seconds   integer NOT NULL CHECK (target_seconds BETWEEN 10 AND 1800),
  production_mode  text NOT NULL CHECK (production_mode IN ('draft','standard_final','hero_final')),
  host_slug        text NOT NULL DEFAULT 'amanda_albright',
  status           text NOT NULL DEFAULT 'brief' CHECK (status IN ('brief','proposed','in_review','changes_requested','approved')),
  proposal         jsonb,            -- treatment / script / storyboard: intent only, validated by lib/media/studio.validateProposal
  proposal_sha256  text,             -- canonical hash of proposal
  approved_sha256  text,             -- set only by owner approval of that exact hash
  renderer_pins    jsonb NOT NULL DEFAULT '{}'::jsonb,  -- advanced only: {shot_key: renderer id}; a router filter, never canonical
  community_id     uuid REFERENCES communities(id) ON DELETE RESTRICT,  -- optional: community-specific videos
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS media_project_events (
  id          bigserial PRIMARY KEY,
  project_id  uuid NOT NULL REFERENCES media_projects(id) ON DELETE RESTRICT,
  event       text NOT NULL,
  actor       text,
  detail      jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_project_events_project_idx ON media_project_events(project_id, id);
CREATE TRIGGER media_projects_updated_at BEFORE UPDATE ON media_projects FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();
GRANT SELECT, INSERT, UPDATE, DELETE ON media_projects TO service_role;
GRANT SELECT, INSERT ON media_project_events TO service_role;
GRANT USAGE ON SEQUENCE media_project_events_id_seq TO service_role;
COMMIT;
```

Notes
- No renderer, model or job column exists on a project or a shot. Provider,
  model and version are recorded only on a take (`render_log`, migration 467).
- Shots stay inside `proposal` jsonb in V1 (they are edited as a unit and
  approved by one hash). They move to their own table when takes link to shots.
- Face-reference evidence (`accounts[renderer].face_reference`) comes from
  reviewed acceptance takes; a later migration records it per renderer/account
  with evidence and date.
