-- ============================================================================
-- 467_character_registry.sql  (Ed 2026-09-26)  Trusted Character System, Phase A
-- ----------------------------------------------------------------------------
-- The canonical identity of every AI teammate, owned by Trusted, versioned
-- forever. ONE CHARACTER, ONE CANONICAL IDENTITY, MANY RENDERERS.
--
--   characters                      immutable uuid identity (slug/name can change)
--   component_versions              face | voice | body | wardrobe | persona | guardrails,
--                                   each versioned independently, frozen once written
--   component_assets                version -> stored bytes (sha256), with a role
--   character_assets                content-addressed private media (bucket character-canon)
--   character_releases              a frozen bundle: one approved version per component
--   release_components
--   character_events                append-only status history (approve/promote/retire/...)
--   provider_mappings               HeyGen/ElevenLabs/Runway/Veo/... objects: MAPPINGS, not identity
--   provider_mapping_sources        exact component version + exact source bytes behind each mapping
--   render_log / render_participants / render_participant_components /
--   render_participant_component_assets / render_reviews
--                                   full provenance of every generated output
--
-- RECORD OWNERSHIP: workpaper (Bedrock IP) for every table here. Finished videos
-- delivered to a board remain association records in video_shares / explainers.
--
-- IMMUTABILITY IS ENFORCED, NOT DOCUMENTED. Every table refuses direct INSERT
-- unless called through a registry function, and refuses UPDATE/DELETE/TRUNCATE
-- outright (the two narrow exceptions: characters' mutable pointer/name fields,
-- and a provider mapping's one-time retirement, both only via functions that
-- write an event in the same transaction). This guards against accidental edits
-- by application code; it is not a defence against someone with raw SQL access.
--
-- ADDITIVE ONLY: no existing table, function, or bucket is modified. Nothing in
-- the runtime reads these tables yet (roster, env vars, persona_voices unchanged).
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- Write-gate helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION character_registry_write_on() RETURNS void
LANGUAGE sql AS $$ SELECT set_config('trusted.registry_write', 'on', true); $$;
CREATE OR REPLACE FUNCTION character_registry_write_off() RETURNS void
LANGUAGE sql AS $$ SELECT set_config('trusted.registry_write', 'off', true); $$;
CREATE OR REPLACE FUNCTION character_registry_write_allowed() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('trusted.registry_write', true), '') = 'on'; $$;

-- Frozen tables: INSERT only through a registry function; never UPDATE/DELETE.
CREATE OR REPLACE FUNCTION character_registry_guard_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT character_registry_write_allowed() THEN
      RAISE EXCEPTION 'character_registry: direct INSERT into % is not allowed; use the registry functions', TG_TABLE_NAME;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'character_registry: % is immutable (% refused)', TG_TABLE_NAME, TG_OP;
END $$;

CREATE OR REPLACE FUNCTION character_registry_guard_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'character_registry: TRUNCATE of % refused', TG_TABLE_NAME;
END $$;

-- ---------------------------------------------------------------------------
-- Content-addressed media
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS character_assets (
  sha256            text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  media_type        text NOT NULL,                    -- image/png, audio/wav, ...
  kind              text NOT NULL CHECK (kind IN ('image','audio','video','document')),
  bytes             bigint NOT NULL CHECK (bytes > 0),
  width             int,
  height            int,
  duration_seconds  numeric,
  storage_bucket    text NOT NULL DEFAULT 'character-canon',
  storage_key       text NOT NULL UNIQUE,              -- sha256/<aa>/<sha256>.<ext>
  parent_sha256     text REFERENCES character_assets(sha256) ON DELETE RESTRICT,
  origin            text NOT NULL,                     -- heygen_group_source, heygen_look_image, chatgpt, repo, ...
  origin_ref        text,                              -- non-secret provenance note (provider object id, repo path)
  notes             text,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Characters: the immutable identity
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS characters (
  character_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_slug      text NOT NULL UNIQUE CHECK (character_slug ~ '^[a-z][a-z0-9_]{1,62}$'),
  roster_persona      text UNIQUE,                     -- link to lib/team/roster.js persona key (nullable)
  display_name        text NOT NULL,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','retired')),
  current_release_id  uuid,                            -- FK added below (circular)
  created_by          text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION character_registry_guard_characters() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT character_registry_write_allowed() THEN
    RAISE EXCEPTION 'character_registry: direct % on characters is not allowed; use the registry functions', TG_OP;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'character_registry: characters are never deleted (retire instead)';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.character_id <> OLD.character_id OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by THEN
      RAISE EXCEPTION 'character_registry: character_id / created_at / created_by are immutable';
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Independently versioned components
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS component_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id       uuid NOT NULL REFERENCES characters(character_id) ON DELETE RESTRICT,
  component          text NOT NULL CHECK (component IN ('face','voice','body','wardrobe','persona','guardrails')),
  version_no         int  NOT NULL CHECK (version_no > 0),
  parent_version_id  uuid REFERENCES component_versions(id) ON DELETE RESTRICT,
  schema_version     int  NOT NULL DEFAULT 1,
  spec               jsonb NOT NULL,
  spec_sha256        text NOT NULL CHECK (spec_sha256 ~ '^[0-9a-f]{64}$'),
  change_reason      text NOT NULL,
  created_by         text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (character_id, component, version_no)
);
CREATE INDEX IF NOT EXISTS idx_component_versions_char ON component_versions (character_id, component);

CREATE TABLE IF NOT EXISTS component_assets (
  component_version_id uuid NOT NULL REFERENCES component_versions(id) ON DELETE RESTRICT,
  sha256               text NOT NULL REFERENCES character_assets(sha256) ON DELETE RESTRICT,
  role                 text NOT NULL CHECK (role IN ('canonical','alternate','legacy_source','derived','provider_copy',
                                                     'reference_audio','voice_sample','rejected_candidate','unapproved_variant')),
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (component_version_id, sha256, role)
);
CREATE INDEX IF NOT EXISTS idx_component_assets_sha ON component_assets (sha256);

-- ---------------------------------------------------------------------------
-- Releases: frozen bundles of component versions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS character_releases (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id       uuid NOT NULL REFERENCES characters(character_id) ON DELETE RESTRICT,
  release_no         int  NOT NULL CHECK (release_no > 0),
  parent_release_id  uuid REFERENCES character_releases(id) ON DELETE RESTRICT,
  release_notes      text NOT NULL,
  release_sha256     text NOT NULL CHECK (release_sha256 ~ '^[0-9a-f]{64}$'),
  created_by         text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (character_id, release_no)
);

CREATE TABLE IF NOT EXISTS release_components (
  release_id            uuid NOT NULL REFERENCES character_releases(id) ON DELETE RESTRICT,
  component             text NOT NULL CHECK (component IN ('face','voice','body','wardrobe','persona','guardrails')),
  component_version_id  uuid NOT NULL REFERENCES component_versions(id) ON DELETE RESTRICT,
  PRIMARY KEY (release_id, component)
);
CREATE INDEX IF NOT EXISTS idx_release_components_cv ON release_components (component_version_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'characters_current_release_fk') THEN
    ALTER TABLE characters ADD CONSTRAINT characters_current_release_fk
      FOREIGN KEY (current_release_id) REFERENCES character_releases(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Append-only event history
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS character_events (
  id            bigserial PRIMARY KEY,
  character_id  uuid NOT NULL REFERENCES characters(character_id) ON DELETE RESTRICT,
  subject_type  text NOT NULL CHECK (subject_type IN ('character','release','component_version','provider_mapping')),
  subject_id    uuid NOT NULL,
  event         text NOT NULL CHECK (event IN ('created','proposed','approved','rejected','promoted','retired','restored','renamed')),
  actor         text NOT NULL,
  reason        text,
  effective_at  timestamptz NOT NULL DEFAULT now(),
  payload       jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_character_events_subject ON character_events (subject_id, id);
CREATE INDEX IF NOT EXISTS idx_character_events_char ON character_events (character_id, id);

-- ---------------------------------------------------------------------------
-- Provider mappings: implementations, never identity
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_mappings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id    uuid NOT NULL REFERENCES characters(character_id) ON DELETE RESTRICT,
  provider        text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,40}$'),  -- heygen, elevenlabs, runway, veo, remotion, ...
  kind            text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{1,40}$'),      -- avatar_group, look, voice, reference_set, ...
  external_id     text NOT NULL,
  license_class   text NOT NULL CHECK (license_class IN ('owned','licensed','stock','community','provider_locked','unknown')),
  channel         text,                                   -- e.g. video, phone, portal_tts (where this mapping is used)
  notes           text,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  retired_at      timestamptz,
  retired_reason  text
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_mappings_active
  ON provider_mappings (character_id, provider, kind, external_id, coalesce(channel, '')) WHERE retired_at IS NULL;

CREATE OR REPLACE FUNCTION character_registry_guard_mappings() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT character_registry_write_allowed() THEN
    RAISE EXCEPTION 'character_registry: direct % on provider_mappings is not allowed; use the registry functions', TG_OP;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'character_registry: provider mappings are never deleted (retire instead)';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'character_registry: provider mapping % is already retired', OLD.id;
    END IF;
    IF (to_jsonb(NEW) - 'retired_at' - 'retired_reason') <> (to_jsonb(OLD) - 'retired_at' - 'retired_reason') THEN
      RAISE EXCEPTION 'character_registry: only retired_at / retired_reason may change on a provider mapping';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- The exact component version AND the exact stored bytes behind a provider object.
-- asset_sha256 is NULL only when the provider object was not built from our bytes
-- (e.g. a stock voice chosen from a provider library).
CREATE TABLE IF NOT EXISTS provider_mapping_sources (
  id                    bigserial PRIMARY KEY,
  mapping_id            uuid NOT NULL REFERENCES provider_mappings(id) ON DELETE RESTRICT,
  component_version_id  uuid NOT NULL REFERENCES component_versions(id) ON DELETE RESTRICT,
  asset_sha256          text REFERENCES character_assets(sha256) ON DELETE RESTRICT,
  role                  text NOT NULL DEFAULT 'source' CHECK (role IN ('source','reference','voice_reference')),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_mapping_sources
  ON provider_mapping_sources (mapping_id, component_version_id, coalesce(asset_sha256, ''), role);
CREATE INDEX IF NOT EXISTS idx_provider_mapping_sources_asset ON provider_mapping_sources (asset_sha256);

-- ---------------------------------------------------------------------------
-- Render provenance
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS render_log (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  renderer             text NOT NULL,                  -- heygen, runway, veo, remotion, ...
  provider_job_id      text,
  provider_asset_ids   jsonb,                          -- provider-side ids used (avatar/look/voice/...)
  script_sha256        text CHECK (script_sha256 IS NULL OR script_sha256 ~ '^[0-9a-f]{64}$'),
  scene_spec           jsonb,
  wardrobe_selection   jsonb,
  renderer_settings    jsonb,
  output_sha256        text CHECK (output_sha256 IS NULL OR output_sha256 ~ '^[0-9a-f]{64}$'),
  output_bucket        text,
  output_key           text,
  source_table         text,                           -- claire_explainers | video_shares | ...
  source_id            text,
  rendered_at          timestamptz,
  provenance_quality   text NOT NULL CHECK (provenance_quality IN ('recorded','inferred','unknown')),
  notes                text,
  created_by           text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_render_log_source ON render_log (source_table, source_id)
  WHERE source_table IS NOT NULL AND source_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS render_participants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  render_id     uuid NOT NULL REFERENCES render_log(id) ON DELETE RESTRICT,
  character_id  uuid NOT NULL REFERENCES characters(character_id) ON DELETE RESTRICT,
  release_id    uuid REFERENCES character_releases(id) ON DELETE RESTRICT,
  speaking      boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_render_participants_render ON render_participants (render_id);
CREATE INDEX IF NOT EXISTS idx_render_participants_char ON render_participants (character_id);

CREATE TABLE IF NOT EXISTS render_participant_components (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id         uuid NOT NULL REFERENCES render_participants(id) ON DELETE RESTRICT,
  component              text NOT NULL CHECK (component IN ('face','voice','body','wardrobe','persona','guardrails')),
  component_version_id   uuid REFERENCES component_versions(id) ON DELETE RESTRICT,
  provider_mapping_id    uuid REFERENCES provider_mappings(id) ON DELETE RESTRICT,
  deviates_from_release  boolean NOT NULL DEFAULT false,
  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (participant_id, component)
);
CREATE INDEX IF NOT EXISTS idx_rpc_cv ON render_participant_components (component_version_id);

CREATE TABLE IF NOT EXISTS render_participant_component_assets (
  id                               bigserial PRIMARY KEY,
  render_participant_component_id  uuid NOT NULL REFERENCES render_participant_components(id) ON DELETE RESTRICT,
  asset_sha256                     text NOT NULL REFERENCES character_assets(sha256) ON DELETE RESTRICT,
  role                             text NOT NULL CHECK (role IN ('face_source','body_reference','wardrobe_reference',
                                                                 'voice_reference','reference','audio_track')),
  created_at                       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (render_participant_component_id, asset_sha256, role)
);
CREATE INDEX IF NOT EXISTS idx_rpca_asset ON render_participant_component_assets (asset_sha256);

CREATE TABLE IF NOT EXISTS render_reviews (
  id          bigserial PRIMARY KEY,
  render_id   uuid NOT NULL REFERENCES render_log(id) ON DELETE RESTRICT,
  kind        text NOT NULL CHECK (kind IN ('qa','approval')),
  result      text NOT NULL CHECK (result IN ('pass','flag','fail','approved','rejected')),
  actor       text NOT NULL,
  details     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_render_reviews_render ON render_reviews (render_id);

-- ---------------------------------------------------------------------------
-- Guards on every table
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['character_assets','component_versions','component_assets','character_releases',
                           'release_components','character_events','provider_mapping_sources','render_log',
                           'render_participants','render_participant_components',
                           'render_participant_component_assets','render_reviews'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_frozen ON %1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_frozen BEFORE INSERT OR UPDATE OR DELETE ON %1$I
                    FOR EACH ROW EXECUTE FUNCTION character_registry_guard_frozen()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['characters','character_assets','component_versions','component_assets','character_releases',
                           'release_components','character_events','provider_mappings','provider_mapping_sources',
                           'render_log','render_participants','render_participant_components',
                           'render_participant_component_assets','render_reviews'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_no_truncate ON %1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_no_truncate BEFORE TRUNCATE ON %1$I
                    FOR EACH STATEMENT EXECUTE FUNCTION character_registry_guard_truncate()', t);
  END LOOP;
END $$;
DROP TRIGGER IF EXISTS trg_characters_guard ON characters;
CREATE TRIGGER trg_characters_guard BEFORE INSERT OR UPDATE OR DELETE ON characters
  FOR EACH ROW EXECUTE FUNCTION character_registry_guard_characters();
DROP TRIGGER IF EXISTS trg_provider_mappings_guard ON provider_mappings;
CREATE TRIGGER trg_provider_mappings_guard BEFORE INSERT OR UPDATE OR DELETE ON provider_mappings
  FOR EACH ROW EXECUTE FUNCTION character_registry_guard_mappings();

-- ---------------------------------------------------------------------------
-- Status (always derived from the event log, never stored)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION character_subject_status(p_subject_id uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT e.event FROM character_events e
   WHERE e.subject_id = p_subject_id AND e.event IN ('proposed','approved','rejected','promoted','retired','restored')
   ORDER BY e.id DESC LIMIT 1;
$$;

-- A component version is usable in a promoted release when its latest status is approved or restored.
CREATE OR REPLACE FUNCTION character_component_is_approved(p_version_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce(character_subject_status(p_version_id) IN ('approved','restored'), false); $$;

CREATE OR REPLACE FUNCTION character_log_event(p_character uuid, p_subject_type text, p_subject uuid, p_event text,
                                               p_actor text, p_reason text, p_payload jsonb DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(trim(p_actor), '') = '' THEN RAISE EXCEPTION 'character_registry: actor is required'; END IF;
  INSERT INTO character_events (character_id, subject_type, subject_id, event, actor, reason, payload)
  VALUES (p_character, p_subject_type, p_subject, p_event, p_actor, p_reason, p_payload);
END $$;

-- ---------------------------------------------------------------------------
-- Registry functions: the ONLY write path
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION character_register_asset(
  p_sha256 text, p_media_type text, p_kind text, p_bytes bigint, p_width int, p_height int,
  p_duration_seconds numeric, p_storage_key text, p_parent_sha256 text, p_origin text,
  p_origin_ref text, p_notes text, p_actor text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_existing character_assets%ROWTYPE;
BEGIN
  SELECT * INTO v_existing FROM character_assets WHERE sha256 = p_sha256;
  IF FOUND THEN
    IF v_existing.storage_key <> p_storage_key OR v_existing.bytes <> p_bytes THEN
      RAISE EXCEPTION 'character_registry: asset % already registered with different storage key/size', p_sha256;
    END IF;
    RETURN p_sha256;                                    -- same bytes, idempotent
  END IF;
  PERFORM character_registry_write_on();
  INSERT INTO character_assets (sha256, media_type, kind, bytes, width, height, duration_seconds, storage_key,
                                parent_sha256, origin, origin_ref, notes, created_by)
  VALUES (p_sha256, p_media_type, p_kind, p_bytes, p_width, p_height, p_duration_seconds, p_storage_key,
          p_parent_sha256, p_origin, p_origin_ref, p_notes, p_actor);
  PERFORM character_registry_write_off();
  RETURN p_sha256;
END $$;

CREATE OR REPLACE FUNCTION character_create(p_slug text, p_display_name text, p_roster_persona text,
                                            p_actor text, p_reason text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM character_registry_write_on();
  INSERT INTO characters (character_slug, display_name, roster_persona, created_by)
  VALUES (p_slug, p_display_name, nullif(p_roster_persona, ''), p_actor)
  RETURNING character_id INTO v_id;
  PERFORM character_log_event(v_id, 'character', v_id, 'created', p_actor, p_reason,
                              jsonb_build_object('slug', p_slug, 'display_name', p_display_name, 'roster_persona', p_roster_persona));
  PERFORM character_registry_write_off();
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION character_rename(p_character uuid, p_slug text, p_display_name text, p_roster_persona text,
                                            p_actor text, p_reason text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_old characters%ROWTYPE;
BEGIN
  SELECT * INTO v_old FROM characters WHERE character_id = p_character FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'character_registry: unknown character %', p_character; END IF;
  IF coalesce(trim(p_reason), '') = '' THEN RAISE EXCEPTION 'character_registry: a rename needs a reason'; END IF;
  PERFORM character_registry_write_on();
  UPDATE characters SET character_slug = p_slug, display_name = p_display_name, roster_persona = nullif(p_roster_persona, '')
   WHERE character_id = p_character;
  PERFORM character_log_event(p_character, 'character', p_character, 'renamed', p_actor, p_reason,
    jsonb_build_object('old', jsonb_build_object('slug', v_old.character_slug, 'display_name', v_old.display_name, 'roster_persona', v_old.roster_persona),
                       'new', jsonb_build_object('slug', p_slug, 'display_name', p_display_name, 'roster_persona', p_roster_persona)));
  PERFORM character_registry_write_off();
END $$;

-- p_assets: [{ "sha256": "...", "role": "canonical", "notes": "..." }, ...]
CREATE OR REPLACE FUNCTION character_create_component_version(
  p_character uuid, p_component text, p_spec jsonb, p_schema_version int, p_parent_version uuid,
  p_change_reason text, p_actor text, p_assets jsonb DEFAULT '[]'::jsonb) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_no int; v_parent component_versions%ROWTYPE; a jsonb;
BEGIN
  IF p_parent_version IS NOT NULL THEN
    SELECT * INTO v_parent FROM component_versions WHERE id = p_parent_version;
    IF NOT FOUND OR v_parent.character_id <> p_character OR v_parent.component <> p_component THEN
      RAISE EXCEPTION 'character_registry: parent version must be the same character and component';
    END IF;
  END IF;
  SELECT coalesce(max(version_no), 0) + 1 INTO v_no FROM component_versions
   WHERE character_id = p_character AND component = p_component;
  PERFORM character_registry_write_on();
  INSERT INTO component_versions (character_id, component, version_no, parent_version_id, schema_version, spec,
                                  spec_sha256, change_reason, created_by)
  VALUES (p_character, p_component, v_no, p_parent_version, coalesce(p_schema_version, 1), p_spec,
          encode(sha256(convert_to(p_spec::text, 'UTF8')), 'hex'), p_change_reason, p_actor)
  RETURNING id INTO v_id;
  FOR a IN SELECT * FROM jsonb_array_elements(coalesce(p_assets, '[]'::jsonb)) LOOP
    INSERT INTO component_assets (component_version_id, sha256, role, notes)
    VALUES (v_id, a->>'sha256', a->>'role', a->>'notes');
  END LOOP;
  PERFORM character_log_event(p_character, 'component_version', v_id, 'proposed', p_actor, p_change_reason,
                              jsonb_build_object('component', p_component, 'version_no', v_no));
  PERFORM character_registry_write_off();
  RETURN v_id;
END $$;

-- Approve / reject / retire / restore a component version.
CREATE OR REPLACE FUNCTION character_set_component_status(p_version uuid, p_event text, p_actor text, p_reason text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v component_versions%ROWTYPE; v_cur text;
BEGIN
  SELECT * INTO v FROM component_versions WHERE id = p_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'character_registry: unknown component version %', p_version; END IF;
  v_cur := character_subject_status(p_version);
  IF p_event = 'approved' AND v_cur NOT IN ('proposed') THEN
    RAISE EXCEPTION 'character_registry: only a proposed version can be approved (current: %)', v_cur;
  ELSIF p_event = 'rejected' AND v_cur NOT IN ('proposed') THEN
    RAISE EXCEPTION 'character_registry: only a proposed version can be rejected (current: %)', v_cur;
  ELSIF p_event = 'retired' AND v_cur NOT IN ('approved','restored') THEN
    RAISE EXCEPTION 'character_registry: only an approved version can be retired (current: %)', v_cur;
  ELSIF p_event = 'restored' AND v_cur NOT IN ('retired') THEN
    RAISE EXCEPTION 'character_registry: only a retired version can be restored (current: %)', v_cur;
  ELSIF p_event NOT IN ('approved','rejected','retired','restored') THEN
    RAISE EXCEPTION 'character_registry: unsupported component event %', p_event;
  END IF;
  PERFORM character_registry_write_on();
  PERFORM character_log_event(v.character_id, 'component_version', p_version, p_event, p_actor, p_reason,
                              jsonb_build_object('component', v.component, 'version_no', v.version_no));
  PERFORM character_registry_write_off();
END $$;

-- p_components: { "face": "<component_version_id>", "voice": "...", ... }  (omit a component = not yet defined)
CREATE OR REPLACE FUNCTION character_create_release(p_character uuid, p_components jsonb, p_notes text,
                                                    p_actor text, p_parent_release uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_no int; k text; v_cv component_versions%ROWTYPE; v_sig text := ''; v_parent uuid;
BEGIN
  IF p_components IS NULL OR jsonb_typeof(p_components) <> 'object' OR p_components = '{}'::jsonb THEN
    RAISE EXCEPTION 'character_registry: a release needs at least one component';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_components) ORDER BY 1 LOOP
    SELECT * INTO v_cv FROM component_versions WHERE id = (p_components->>k)::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'character_registry: unknown component version for %', k; END IF;
    IF v_cv.character_id <> p_character THEN
      RAISE EXCEPTION 'character_registry: % version belongs to a different character', k;
    END IF;
    IF v_cv.component <> k THEN
      RAISE EXCEPTION 'character_registry: version supplied for % is a % version', k, v_cv.component;
    END IF;
    v_sig := v_sig || k || ':' || v_cv.id::text || ':' || v_cv.spec_sha256 || ';';
  END LOOP;
  v_parent := coalesce(p_parent_release, (SELECT current_release_id FROM characters WHERE character_id = p_character));
  SELECT coalesce(max(release_no), 0) + 1 INTO v_no FROM character_releases WHERE character_id = p_character;
  PERFORM character_registry_write_on();
  INSERT INTO character_releases (character_id, release_no, parent_release_id, release_notes, release_sha256, created_by)
  VALUES (p_character, v_no, v_parent, p_notes, encode(sha256(convert_to(v_sig, 'UTF8')), 'hex'), p_actor)
  RETURNING id INTO v_id;
  FOR k IN SELECT jsonb_object_keys(p_components) LOOP
    INSERT INTO release_components (release_id, component, component_version_id)
    VALUES (v_id, k, (p_components->>k)::uuid);
  END LOOP;
  PERFORM character_log_event(p_character, 'release', v_id, 'proposed', p_actor, p_notes,
                              jsonb_build_object('release_no', v_no, 'components', p_components));
  PERFORM character_registry_write_off();
  RETURN v_id;
END $$;

-- New release = base release with specific components swapped (value null = remove that component).
CREATE OR REPLACE FUNCTION character_derive_release(p_base_release uuid, p_overrides jsonb, p_notes text, p_actor text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_char uuid; v_components jsonb; k text;
BEGIN
  SELECT character_id INTO v_char FROM character_releases WHERE id = p_base_release;
  IF NOT FOUND THEN RAISE EXCEPTION 'character_registry: unknown release %', p_base_release; END IF;
  SELECT coalesce(jsonb_object_agg(component, component_version_id::text), '{}'::jsonb) INTO v_components
    FROM release_components WHERE release_id = p_base_release;
  FOR k IN SELECT jsonb_object_keys(coalesce(p_overrides, '{}'::jsonb)) LOOP
    IF p_overrides->k = 'null'::jsonb THEN v_components := v_components - k;
    ELSE v_components := v_components || jsonb_build_object(k, p_overrides->>k);
    END IF;
  END LOOP;
  RETURN character_create_release(v_char, v_components, p_notes, p_actor, p_base_release);
END $$;

-- Make a release current. Every component version in it must be approved (or restored).
CREATE OR REPLACE FUNCTION character_promote_release(p_release uuid, p_actor text, p_reason text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_rel character_releases%ROWTYPE; v_prev uuid; r record; v_was_promoted boolean;
BEGIN
  SELECT * INTO v_rel FROM character_releases WHERE id = p_release;
  IF NOT FOUND THEN RAISE EXCEPTION 'character_registry: unknown release %', p_release; END IF;
  IF coalesce(trim(p_reason), '') = '' THEN RAISE EXCEPTION 'character_registry: promotion needs a reason'; END IF;
  FOR r IN SELECT rc.component, rc.component_version_id FROM release_components rc WHERE rc.release_id = p_release LOOP
    IF NOT character_component_is_approved(r.component_version_id) THEN
      RAISE EXCEPTION 'character_registry: release % contains a % version that is not approved', v_rel.release_no, r.component;
    END IF;
  END LOOP;
  SELECT current_release_id INTO v_prev FROM characters WHERE character_id = v_rel.character_id FOR UPDATE;
  IF v_prev = p_release THEN RAISE EXCEPTION 'character_registry: release % is already current', v_rel.release_no; END IF;
  SELECT EXISTS (SELECT 1 FROM character_events WHERE subject_id = p_release AND event IN ('promoted','restored')) INTO v_was_promoted;
  PERFORM character_registry_write_on();
  UPDATE characters SET current_release_id = p_release WHERE character_id = v_rel.character_id;
  IF v_prev IS NOT NULL THEN
    PERFORM character_log_event(v_rel.character_id, 'release', v_prev, 'retired', p_actor, p_reason,
                                jsonb_build_object('superseded_by', p_release));
  END IF;
  PERFORM character_log_event(v_rel.character_id, 'release', p_release,
                              CASE WHEN v_was_promoted THEN 'restored' ELSE 'promoted' END, p_actor, p_reason,
                              jsonb_build_object('release_no', v_rel.release_no, 'previous_release', v_prev));
  PERFORM character_registry_write_off();
END $$;

-- Record a retired release WITHOUT making it current (used to preserve a legacy
-- bundle that was in force before the registry existed).
CREATE OR REPLACE FUNCTION character_mark_release_legacy(p_release uuid, p_actor text, p_reason text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_rel character_releases%ROWTYPE; r record;
BEGIN
  SELECT * INTO v_rel FROM character_releases WHERE id = p_release;
  IF NOT FOUND THEN RAISE EXCEPTION 'character_registry: unknown release %', p_release; END IF;
  IF character_subject_status(p_release) <> 'proposed' THEN
    RAISE EXCEPTION 'character_registry: only a proposed release can be marked legacy';
  END IF;
  FOR r IN SELECT rc.component, rc.component_version_id FROM release_components rc WHERE rc.release_id = p_release LOOP
    IF character_subject_status(r.component_version_id) NOT IN ('approved','restored','retired') THEN
      RAISE EXCEPTION 'character_registry: legacy release % contains an unapproved % version', v_rel.release_no, r.component;
    END IF;
  END LOOP;
  PERFORM character_registry_write_on();
  PERFORM character_log_event(v_rel.character_id, 'release', p_release, 'retired', p_actor, p_reason,
                              jsonb_build_object('release_no', v_rel.release_no, 'legacy', true));
  PERFORM character_registry_write_off();
END $$;

-- One owner decision, applied atomically: approve every still-proposed component
-- version referenced by the given releases, record the legacy releases as retired,
-- and promote the current release. Either all of it happens or none of it does.
CREATE OR REPLACE FUNCTION character_approve_package(p_character uuid, p_current_release uuid, p_legacy_releases uuid[],
                                                     p_actor text, p_reason text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE rel uuid; r record;
BEGIN
  IF coalesce(trim(p_reason), '') = '' THEN RAISE EXCEPTION 'character_registry: approval needs a reason'; END IF;
  FOR rel IN SELECT unnest(coalesce(p_legacy_releases, '{}'::uuid[]) || ARRAY[p_current_release]) LOOP
    IF NOT EXISTS (SELECT 1 FROM character_releases WHERE id = rel AND character_id = p_character) THEN
      RAISE EXCEPTION 'character_registry: release % does not belong to this character', rel;
    END IF;
    FOR r IN SELECT DISTINCT rc.component_version_id FROM release_components rc WHERE rc.release_id = rel LOOP
      IF character_subject_status(r.component_version_id) = 'proposed' THEN
        PERFORM character_set_component_status(r.component_version_id, 'approved', p_actor, p_reason);
      END IF;
    END LOOP;
  END LOOP;
  FOR rel IN SELECT unnest(coalesce(p_legacy_releases, '{}'::uuid[])) LOOP
    PERFORM character_mark_release_legacy(rel, p_actor, p_reason);
  END LOOP;
  PERFORM character_promote_release(p_current_release, p_actor, p_reason);
END $$;

-- p_sources: [{ "component_version_id": "...", "asset_sha256": "..." | null, "role": "source" }, ...]
CREATE OR REPLACE FUNCTION character_create_provider_mapping(
  p_character uuid, p_provider text, p_kind text, p_external_id text, p_license_class text, p_channel text,
  p_notes text, p_actor text, p_sources jsonb) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid; s jsonb; v_cv component_versions%ROWTYPE; v_sha text;
BEGIN
  IF p_sources IS NULL OR jsonb_array_length(p_sources) = 0 THEN
    RAISE EXCEPTION 'character_registry: a provider mapping must name at least one source component version';
  END IF;
  PERFORM character_registry_write_on();
  INSERT INTO provider_mappings (character_id, provider, kind, external_id, license_class, channel, notes, created_by)
  VALUES (p_character, p_provider, p_kind, p_external_id, p_license_class, nullif(p_channel, ''), p_notes, p_actor)
  RETURNING id INTO v_id;
  FOR s IN SELECT * FROM jsonb_array_elements(p_sources) LOOP
    SELECT * INTO v_cv FROM component_versions WHERE id = (s->>'component_version_id')::uuid;
    IF NOT FOUND OR v_cv.character_id <> p_character THEN
      RAISE EXCEPTION 'character_registry: mapping source must be a component version of the same character';
    END IF;
    v_sha := nullif(s->>'asset_sha256', '');
    IF v_sha IS NOT NULL AND NOT EXISTS (SELECT 1 FROM component_assets WHERE component_version_id = v_cv.id AND sha256 = v_sha) THEN
      RAISE EXCEPTION 'character_registry: source asset % is not attached to that component version', v_sha;
    END IF;
    INSERT INTO provider_mapping_sources (mapping_id, component_version_id, asset_sha256, role)
    VALUES (v_id, v_cv.id, v_sha, coalesce(s->>'role', 'source'));
  END LOOP;
  PERFORM character_log_event(p_character, 'provider_mapping', v_id, 'created', p_actor, p_notes,
    jsonb_build_object('provider', p_provider, 'kind', p_kind, 'external_id', p_external_id, 'channel', p_channel));
  PERFORM character_registry_write_off();
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION character_retire_provider_mapping(p_mapping uuid, p_actor text, p_reason text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v provider_mappings%ROWTYPE;
BEGIN
  SELECT * INTO v FROM provider_mappings WHERE id = p_mapping;
  IF NOT FOUND THEN RAISE EXCEPTION 'character_registry: unknown provider mapping %', p_mapping; END IF;
  PERFORM character_registry_write_on();
  UPDATE provider_mappings SET retired_at = now(), retired_reason = p_reason WHERE id = p_mapping;
  PERFORM character_log_event(v.character_id, 'provider_mapping', p_mapping, 'retired', p_actor, p_reason, NULL);
  PERFORM character_registry_write_off();
END $$;

-- Record one render atomically.
-- p: { renderer, provider_job_id, provider_asset_ids, script_sha256, scene_spec, wardrobe_selection,
--      renderer_settings, output_sha256, output_bucket, output_key, source_table, source_id, rendered_at,
--      provenance_quality, notes,
--      participants: [{ character_id, release_id, speaking,
--                       components: [{ component, component_version_id, provider_mapping_id, notes,
--                                      assets: [{ sha256, role }] }] }] }
CREATE OR REPLACE FUNCTION character_record_render(p jsonb, p_actor text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_render uuid; v_part uuid; v_comp uuid; pt jsonb; c jsonb; a jsonb; v_cv component_versions%ROWTYPE;
        v_release uuid; v_expected uuid; v_dev boolean;
BEGIN
  PERFORM character_registry_write_on();
  INSERT INTO render_log (renderer, provider_job_id, provider_asset_ids, script_sha256, scene_spec, wardrobe_selection,
                          renderer_settings, output_sha256, output_bucket, output_key, source_table, source_id,
                          rendered_at, provenance_quality, notes, created_by)
  VALUES (p->>'renderer', p->>'provider_job_id', p->'provider_asset_ids', p->>'script_sha256', p->'scene_spec',
          p->'wardrobe_selection', p->'renderer_settings', p->>'output_sha256', p->>'output_bucket', p->>'output_key',
          p->>'source_table', p->>'source_id', (p->>'rendered_at')::timestamptz, p->>'provenance_quality', p->>'notes', p_actor)
  RETURNING id INTO v_render;
  FOR pt IN SELECT * FROM jsonb_array_elements(coalesce(p->'participants', '[]'::jsonb)) LOOP
    v_release := nullif(pt->>'release_id', '')::uuid;
    IF v_release IS NOT NULL AND NOT EXISTS (SELECT 1 FROM character_releases WHERE id = v_release AND character_id = (pt->>'character_id')::uuid) THEN
      RAISE EXCEPTION 'character_registry: render participant release does not belong to that character';
    END IF;
    INSERT INTO render_participants (render_id, character_id, release_id, speaking)
    VALUES (v_render, (pt->>'character_id')::uuid, v_release, coalesce((pt->>'speaking')::boolean, true))
    RETURNING id INTO v_part;
    FOR c IN SELECT * FROM jsonb_array_elements(coalesce(pt->'components', '[]'::jsonb)) LOOP
      v_dev := false;
      IF nullif(c->>'component_version_id', '') IS NOT NULL THEN
        SELECT * INTO v_cv FROM component_versions WHERE id = (c->>'component_version_id')::uuid;
        IF NOT FOUND OR v_cv.character_id <> (pt->>'character_id')::uuid OR v_cv.component <> c->>'component' THEN
          RAISE EXCEPTION 'character_registry: render component version does not match character/component';
        END IF;
        IF v_release IS NOT NULL THEN
          SELECT component_version_id INTO v_expected FROM release_components
           WHERE release_id = v_release AND component = c->>'component';
          v_dev := (v_expected IS DISTINCT FROM v_cv.id);
        END IF;
      END IF;
      INSERT INTO render_participant_components (participant_id, component, component_version_id, provider_mapping_id,
                                                 deviates_from_release, notes)
      VALUES (v_part, c->>'component', nullif(c->>'component_version_id', '')::uuid,
              nullif(c->>'provider_mapping_id', '')::uuid, v_dev, c->>'notes')
      RETURNING id INTO v_comp;
      FOR a IN SELECT * FROM jsonb_array_elements(coalesce(c->'assets', '[]'::jsonb)) LOOP
        INSERT INTO render_participant_component_assets (render_participant_component_id, asset_sha256, role)
        VALUES (v_comp, a->>'sha256', a->>'role');
      END LOOP;
    END LOOP;
  END LOOP;
  PERFORM character_registry_write_off();
  RETURN v_render;
END $$;

CREATE OR REPLACE FUNCTION character_review_render(p_render uuid, p_kind text, p_result text, p_actor text, p_details jsonb)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM character_registry_write_on();
  INSERT INTO render_reviews (render_id, kind, result, actor, details) VALUES (p_render, p_kind, p_result, p_actor, p_details);
  PERFORM character_registry_write_off();
END $$;

-- ---------------------------------------------------------------------------
-- Access: service role only. RLS on with no policies = anon/authenticated see nothing.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['characters','character_assets','component_versions','component_assets','character_releases',
                           'release_components','character_events','provider_mappings','provider_mapping_sources',
                           'render_log','render_participants','render_participant_components',
                           'render_participant_component_assets','render_reviews'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO service_role', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE character_events_id_seq, provider_mapping_sources_id_seq,
      render_participant_component_assets_id_seq, render_reviews_id_seq TO service_role;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'character_registry_write_on()', 'character_registry_write_off()', 'character_registry_write_allowed()',
    'character_subject_status(uuid)', 'character_component_is_approved(uuid)',
    'character_log_event(uuid,text,uuid,text,text,text,jsonb)',
    'character_register_asset(text,text,text,bigint,int,int,numeric,text,text,text,text,text,text)',
    'character_create(text,text,text,text,text)', 'character_rename(uuid,text,text,text,text,text)',
    'character_create_component_version(uuid,text,jsonb,int,uuid,text,text,jsonb)',
    'character_set_component_status(uuid,text,text,text)',
    'character_create_release(uuid,jsonb,text,text,uuid)', 'character_derive_release(uuid,jsonb,text,text)',
    'character_promote_release(uuid,text,text)', 'character_mark_release_legacy(uuid,text,text)',
    'character_approve_package(uuid,uuid,uuid[],text,text)',
    'character_create_provider_mapping(uuid,text,text,text,text,text,text,text,jsonb)',
    'character_retire_provider_mapping(uuid,text,text)', 'character_record_render(jsonb,text)',
    'character_review_render(uuid,text,text,text,jsonb)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;

-- Private bucket for canonical media. Content-addressed keys; never public.
INSERT INTO storage.buckets (id, name, public)
VALUES ('character-canon', 'character-canon', false)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- SELF-TEST: proves the guards and the rollback model against the real database,
-- then rolls its own rows back. If any guarantee fails, this migration fails.
-- ---------------------------------------------------------------------------
DO $$
DECLARE c1 uuid; c2 uuid; f1 uuid; f2 uuid; w1 uuid; x2 uuid; r1 uuid; r2 uuid; r3 uuid; m1 uuid; rid uuid;
        ok boolean; v_cur uuid;
BEGIN
  BEGIN
    c1 := character_create('zz_selftest_a', 'Selftest A', NULL, 'selftest', 'migration self-test');
    c2 := character_create('zz_selftest_b', 'Selftest B', NULL, 'selftest', 'migration self-test');
    f1 := character_create_component_version(c1, 'face', '{"n":1}', 1, NULL, 'v1', 'selftest');
    f2 := character_create_component_version(c1, 'face', '{"n":2}', 1, f1, 'v2', 'selftest');
    w1 := character_create_component_version(c1, 'wardrobe', '{"w":1}', 1, NULL, 'w1', 'selftest');
    x2 := character_create_component_version(c2, 'face', '{"n":9}', 1, NULL, 'other', 'selftest');

    -- 1. direct writes are refused
    ok := false; BEGIN UPDATE component_versions SET change_reason = 'x' WHERE id = f1; EXCEPTION WHEN raise_exception THEN ok := true; END;
    IF NOT ok THEN RAISE EXCEPTION 'SELFTEST FAIL: component_versions UPDATE was allowed'; END IF;
    ok := false; BEGIN DELETE FROM component_versions WHERE id = f1; EXCEPTION WHEN raise_exception THEN ok := true; END;
    IF NOT ok THEN RAISE EXCEPTION 'SELFTEST FAIL: component_versions DELETE was allowed'; END IF;
    ok := false; BEGIN INSERT INTO character_events (character_id, subject_type, subject_id, event, actor)
                        VALUES (c1, 'character', c1, 'approved', 'x'); EXCEPTION WHEN raise_exception THEN ok := true; END;
    IF NOT ok THEN RAISE EXCEPTION 'SELFTEST FAIL: direct event INSERT was allowed'; END IF;
    ok := false; BEGIN UPDATE characters SET current_release_id = NULL WHERE character_id = c1; EXCEPTION WHEN raise_exception THEN ok := true; END;
    IF NOT ok THEN RAISE EXCEPTION 'SELFTEST FAIL: direct characters UPDATE was allowed'; END IF;

    -- 2. cross-character release is refused
    ok := false; BEGIN PERFORM character_create_release(c1, jsonb_build_object('face', x2), 'bad', 'selftest'); EXCEPTION WHEN raise_exception THEN ok := true; END;
    IF NOT ok THEN RAISE EXCEPTION 'SELFTEST FAIL: cross-character release was allowed'; END IF;

    -- 3. promoting a release with an unapproved component is refused
    r1 := character_create_release(c1, jsonb_build_object('face', f1, 'wardrobe', w1), 'r1', 'selftest');
    ok := false; BEGIN PERFORM character_promote_release(r1, 'selftest', 'try'); EXCEPTION WHEN raise_exception THEN ok := true; END;
    IF NOT ok THEN RAISE EXCEPTION 'SELFTEST FAIL: unapproved release was promoted'; END IF;

    -- 4. approve, promote r1, derive r2 (face v2), promote, roll back to r1
    PERFORM character_set_component_status(f1, 'approved', 'selftest', 'ok');
    PERFORM character_set_component_status(f2, 'approved', 'selftest', 'ok');
    PERFORM character_set_component_status(w1, 'approved', 'selftest', 'ok');
    PERFORM character_promote_release(r1, 'selftest', 'first');
    r2 := character_derive_release(r1, jsonb_build_object('face', f2), 'face v2', 'selftest');
    PERFORM character_promote_release(r2, 'selftest', 'face change');
    PERFORM character_promote_release(r1, 'selftest', 'rollback');
    SELECT current_release_id INTO v_cur FROM characters WHERE character_id = c1;
    IF v_cur <> r1 THEN RAISE EXCEPTION 'SELFTEST FAIL: rollback did not restore release 1'; END IF;
    IF character_subject_status(r1) <> 'restored' OR character_subject_status(r2) <> 'retired' THEN
      RAISE EXCEPTION 'SELFTEST FAIL: rollback events wrong (% / %)', character_subject_status(r1), character_subject_status(r2);
    END IF;

    -- 5. single-component rollback by derivation keeps history linear
    r3 := character_derive_release(r2, jsonb_build_object('face', f1), 'undo face', 'selftest');
    IF (SELECT component_version_id FROM release_components WHERE release_id = r3 AND component = 'wardrobe') <> w1 THEN
      RAISE EXCEPTION 'SELFTEST FAIL: derived release lost an unchanged component';
    END IF;

    -- 6. rename keeps the id
    PERFORM character_rename(c1, 'zz_selftest_renamed', 'Renamed', NULL, 'selftest', 'rename test');
    IF NOT EXISTS (SELECT 1 FROM characters WHERE character_id = c1 AND character_slug = 'zz_selftest_renamed') THEN
      RAISE EXCEPTION 'SELFTEST FAIL: rename changed identity';
    END IF;

    -- 7. provider mapping needs a same-character source; retire is one-time
    ok := false; BEGIN PERFORM character_create_provider_mapping(c1, 'heygen', 'look', 'x', 'unknown', NULL, NULL, 'selftest',
                   jsonb_build_array(jsonb_build_object('component_version_id', x2))); EXCEPTION WHEN raise_exception THEN ok := true; END;
    IF NOT ok THEN RAISE EXCEPTION 'SELFTEST FAIL: cross-character mapping source was allowed'; END IF;
    m1 := character_create_provider_mapping(c1, 'heygen', 'look', 'x', 'unknown', NULL, NULL, 'selftest',
            jsonb_build_array(jsonb_build_object('component_version_id', f1)));
    PERFORM character_retire_provider_mapping(m1, 'selftest', 'gone');
    ok := false; BEGIN PERFORM character_retire_provider_mapping(m1, 'selftest', 'again'); EXCEPTION WHEN raise_exception THEN ok := true; END;
    IF NOT ok THEN RAISE EXCEPTION 'SELFTEST FAIL: mapping retired twice'; END IF;

    -- 8. package approval: legacy release retired, current promoted, all in one call
    DECLARE c3 uuid; g1 uuid; g2 uuid; p1 uuid; p2 uuid;
    BEGIN
      c3 := character_create('zz_selftest_c', 'Selftest C', NULL, 'selftest', 'package test');
      g1 := character_create_component_version(c3, 'face', '{"n":1}', 1, NULL, 'legacy face', 'selftest');
      g2 := character_create_component_version(c3, 'face', '{"n":2}', 1, g1, 'new face', 'selftest');
      p1 := character_create_release(c3, jsonb_build_object('face', g1), 'legacy', 'selftest');
      p2 := character_create_release(c3, jsonb_build_object('face', g2), 'current', 'selftest', p1);
      PERFORM character_approve_package(c3, p2, ARRAY[p1], 'selftest', 'package');
      IF character_subject_status(p1) <> 'retired' OR character_subject_status(p2) <> 'promoted'
         OR NOT character_component_is_approved(g1) OR NOT character_component_is_approved(g2)
         OR (SELECT current_release_id FROM characters WHERE character_id = c3) <> p2 THEN
        RAISE EXCEPTION 'SELFTEST FAIL: package approval produced the wrong state';
      END IF;
    END;

    -- 9. render deviation is detected
    rid := character_record_render(jsonb_build_object('renderer', 'selftest', 'provenance_quality', 'recorded',
             'participants', jsonb_build_array(jsonb_build_object('character_id', c1, 'release_id', r1,
               'components', jsonb_build_array(jsonb_build_object('component', 'face', 'component_version_id', f2))))), 'selftest');
    IF NOT (SELECT bool_and(deviates_from_release) FROM render_participant_components rpc
              JOIN render_participants rp ON rp.id = rpc.participant_id WHERE rp.render_id = rid) THEN
      RAISE EXCEPTION 'SELFTEST FAIL: render deviation not flagged';
    END IF;

    RAISE EXCEPTION 'character_registry_selftest_ok';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'character_registry_selftest_ok' THEN RAISE; END IF;
  END;
END $$;

COMMIT;
