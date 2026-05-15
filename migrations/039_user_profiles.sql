-- ============================================================================
-- 039_user_profiles.sql
-- ----------------------------------------------------------------------------
-- Auth foundation for the Bedrock team. Each authenticated user gets a
-- user_profiles row with a role: admin | staff | assistant.
--
-- First user to sign in becomes 'admin' automatically. Every subsequent
-- user defaults to 'staff'. Ed can promote/demote via SQL (or via a future
-- admin UI). Public homeowner-facing pages (apply.html, nominate.html,
-- pool fob, status lookup) remain unauthenticated.
--
-- Apply AFTER 038. Idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS user_profiles (
  id                          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  management_company_id       UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  email                       TEXT NOT NULL,
  full_name                   TEXT NULL,
  role                        TEXT NOT NULL DEFAULT 'staff'
                                CHECK (role IN ('admin','staff','assistant')),
  is_active                   BOOLEAN NOT NULL DEFAULT TRUE,
  last_sign_in_at             TIMESTAMPTZ NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_email ON user_profiles (email);
CREATE INDEX IF NOT EXISTS idx_user_profiles_role  ON user_profiles (role, is_active);

GRANT SELECT, INSERT, UPDATE, DELETE ON user_profiles TO authenticated, service_role;

-- Auto-create a profile when someone signs up via Supabase Auth.
-- First user signing in = admin (Ed bootstraps himself); everyone after = staff.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  is_first_user BOOLEAN;
BEGIN
  SELECT NOT EXISTS(SELECT 1 FROM public.user_profiles LIMIT 1) INTO is_first_user;
  INSERT INTO public.user_profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'name',
      split_part(NEW.email, '@', 1)
    ),
    CASE WHEN is_first_user THEN 'admin' ELSE 'staff' END
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Keep last_sign_in_at fresh from auth.users so we can audit dormant accounts.
CREATE OR REPLACE FUNCTION public.handle_user_sign_in()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.user_profiles
     SET last_sign_in_at = NEW.last_sign_in_at,
         updated_at = NOW()
   WHERE id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_sign_in ON auth.users;
CREATE TRIGGER on_auth_user_sign_in
  AFTER UPDATE OF last_sign_in_at ON auth.users
  FOR EACH ROW
  WHEN (NEW.last_sign_in_at IS DISTINCT FROM OLD.last_sign_in_at)
  EXECUTE FUNCTION public.handle_user_sign_in();

COMMIT;

-- ============================================================================
-- VERIFY after running:
--   SELECT id, email, role, last_sign_in_at FROM user_profiles ORDER BY created_at;
-- ============================================================================
