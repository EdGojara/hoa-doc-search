// tests/sql/_ta_world.mjs — the minimal pre-547 world for the Time & Attendance
// SQL tests: Supabase roles, an auth.uid() that reads the request JWT the way
// PostgREST sets it, user_profiles (039 shape), communities, audit_events (545).
export const ED = '00000000-0000-4000-8000-0000000000ed';
export const ANA = '00000000-0000-4000-8000-0000000000a1';
export const BEN = '00000000-0000-4000-8000-0000000000b2';
export const OUTSIDER = '00000000-0000-4000-8000-0000000000c3';
export const CG = 'a0000000-0000-4000-8000-000000000003';

export const WORLD = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; -- as in Supabase
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  CREATE OR REPLACE FUNCTION trusted_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
  CREATE TABLE communities (id uuid PRIMARY KEY, name text);
  CREATE TABLE user_profiles (id uuid PRIMARY KEY, email text, full_name text, role text NOT NULL DEFAULT 'staff'
    CHECK (role IN ('admin','staff','assistant')), is_active boolean NOT NULL DEFAULT true);
  CREATE TABLE audit_events (
    id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, community_id uuid, actor_user_id uuid NOT NULL REFERENCES user_profiles(id),
    actor_name text, entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL, field text,
    previous_value jsonb, new_value jsonb, reason text NOT NULL CHECK (length(btrim(reason)) > 0), route text,
    record_ownership text NOT NULL DEFAULT 'association_record', created_at timestamptz NOT NULL DEFAULT now());
  GRANT SELECT, INSERT ON audit_events TO service_role;
  CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
  INSERT INTO schema_migrations (filename, sha256) VALUES ('546_inspection_closeout_stages.sql', 'recorded');
  INSERT INTO communities VALUES ('${CG}', 'Canyon Gate');
  INSERT INTO user_profiles (id, email, full_name, role) VALUES
    ('${ED}', 'ed@example.test', 'Ed Owner', 'admin'),
    ('${ANA}', 'ana@example.test', 'Ana Staff', 'staff'),
    ('${BEN}', 'ben@example.test', 'Ben Staff', 'staff'),
    ('${OUTSIDER}', 'cy@example.test', 'Cy NotEnrolled', 'staff');
`;
