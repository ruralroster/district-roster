-- Step 1 of the district-roster build (roster-app issue #2): districts,
-- sites, site officers and district doctor profiles, with their RLS.
--
-- Same Supabase project as roster-app. A site can be linked to a roster-app
-- department (sites.department_id); sites not on roster-app exist only here.
--
-- Who can do what:
--   - super admin (profiles.is_super_admin): creates districts and sites,
--     links departments, adds site officers.
--   - site officer: a site_officers row, OR an officer of the roster-app
--     department linked to the site. A site officer is a district officer
--     for that site's district: invites doctors, edits or deactivates them.
--   - district doctor: an active district_doctors row with their login.
--     Sees their district's sites and doctors; edits their own profile
--     (except email, district and active).
--
-- Doctors are created only by the invite-district-doctor Edge Function
-- (service role), so there is no INSERT policy on district_doctors.
--
-- Run this whole file in the Supabase SQL Editor, after roster-app's
-- migrations (needs profiles, departments and is_department_officer).
-- Safe to re-run.

BEGIN;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS districts (
  district_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sites (
  site_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(district_id) ON DELETE CASCADE,
  name text NOT NULL,
  -- One site per roster-app department at most.
  department_id uuid UNIQUE REFERENCES departments(department_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (district_id, name)
);

-- Officers of sites that aren't on roster-app (linked sites also take their
-- department's officers, see is_site_officer). email is copied in because
-- profiles is readable only by its owner.
CREATE TABLE IF NOT EXISTS site_officers (
  site_id uuid NOT NULL REFERENCES sites(site_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, user_id)
);

-- Skills are v3's AST quals. Emergency is always held, as in v3.
CREATE TABLE IF NOT EXISTS district_doctors (
  doctor_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(district_id) ON DELETE CASCADE,
  user_id uuid REFERENCES profiles(user_id) ON DELETE SET NULL,
  email text NOT NULL,
  name text NOT NULL,
  phone text,
  home_site_id uuid REFERENCES sites(site_id) ON DELETE SET NULL,
  skills text[] NOT NULL DEFAULT '{Emergency}',
  notify_email boolean NOT NULL DEFAULT true,
  notify_push boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (district_id, email),
  CONSTRAINT district_doctors_email_lower CHECK (email = lower(email)),
  CONSTRAINT district_doctors_skills_check CHECK (
    skills <@ ARRAY['Emergency', 'Anaesthetics', 'O&G']
    AND 'Emergency' = ANY (skills)
  )
);

CREATE INDEX IF NOT EXISTS district_doctors_user_id_idx ON district_doctors (user_id);
CREATE INDEX IF NOT EXISTS site_officers_user_id_idx ON site_officers (user_id);

-- ---------------------------------------------------------------------------
-- RLS helpers (same shape as is_department_member/is_department_officer)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM profiles WHERE user_id = auth.uid() AND is_super_admin);
$$;

CREATE OR REPLACE FUNCTION is_site_officer(p_site_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    is_super_admin()
    OR EXISTS (SELECT 1 FROM site_officers WHERE site_id = p_site_id AND user_id = auth.uid())
    OR EXISTS (
      SELECT 1 FROM sites s
      WHERE s.site_id = p_site_id
        AND s.department_id IS NOT NULL
        AND is_department_officer(s.department_id)
    );
$$;

CREATE OR REPLACE FUNCTION is_district_officer(p_district_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    is_super_admin()
    OR EXISTS (
      SELECT 1 FROM sites s
      WHERE s.district_id = p_district_id AND is_site_officer(s.site_id)
    );
$$;

CREATE OR REPLACE FUNCTION is_district_member(p_district_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM district_doctors
      WHERE district_id = p_district_id AND user_id = auth.uid() AND active
    )
    OR is_district_officer(p_district_id);
$$;

REVOKE EXECUTE ON FUNCTION is_super_admin() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION is_site_officer(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION is_district_officer(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION is_district_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION is_super_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION is_site_officer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION is_district_officer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION is_district_member(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- district_doctors guards
-- ---------------------------------------------------------------------------

-- From the browser: email, district and login can't be changed, only a
-- district officer can change active, and the home site must be in the
-- doctor's district. Edge Functions (service role) and the SQL editor have
-- no auth.uid() and skip the browser rules.
CREATE OR REPLACE FUNCTION district_doctors_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.home_site_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sites WHERE site_id = NEW.home_site_id AND district_id = NEW.district_id
  ) THEN
    RAISE EXCEPTION 'Home site must be in the doctor''s district';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
    IF auth.uid() IS NOT NULL THEN
      IF NEW.email IS DISTINCT FROM OLD.email
         OR NEW.district_id IS DISTINCT FROM OLD.district_id
         OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        RAISE EXCEPTION 'Email, district and login can''t be changed here';
      END IF;
      IF NEW.active IS DISTINCT FROM OLD.active AND NOT is_district_officer(OLD.district_id) THEN
        RAISE EXCEPTION 'Only a district officer can activate or deactivate a doctor';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION district_doctors_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS district_doctors_guard ON district_doctors;
CREATE TRIGGER district_doctors_guard
  BEFORE INSERT OR UPDATE ON district_doctors
  FOR EACH ROW EXECUTE FUNCTION district_doctors_guard();

-- ---------------------------------------------------------------------------
-- RLS policies
-- ---------------------------------------------------------------------------

ALTER TABLE districts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_officers ENABLE ROW LEVEL SECURITY;
ALTER TABLE district_doctors ENABLE ROW LEVEL SECURITY;

-- districts: members read, super admin writes.
DROP POLICY IF EXISTS "districts_select_member" ON districts;
CREATE POLICY "districts_select_member" ON districts
  FOR SELECT TO authenticated USING (is_district_member(district_id));

DROP POLICY IF EXISTS "districts_write_super_admin" ON districts;
CREATE POLICY "districts_write_super_admin" ON districts
  FOR ALL TO authenticated USING (is_super_admin()) WITH CHECK (is_super_admin());

-- sites: district members read, super admin writes.
DROP POLICY IF EXISTS "sites_select_member" ON sites;
CREATE POLICY "sites_select_member" ON sites
  FOR SELECT TO authenticated USING (is_district_member(district_id));

DROP POLICY IF EXISTS "sites_write_super_admin" ON sites;
CREATE POLICY "sites_write_super_admin" ON sites
  FOR ALL TO authenticated USING (is_super_admin()) WITH CHECK (is_super_admin());

-- site_officers: district members read (who to contact), super admin
-- removes; adding goes through add_site_officer below.
DROP POLICY IF EXISTS "site_officers_select_member" ON site_officers;
CREATE POLICY "site_officers_select_member" ON site_officers
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM sites s WHERE s.site_id = site_officers.site_id AND is_district_member(s.district_id))
  );

DROP POLICY IF EXISTS "site_officers_delete_super_admin" ON site_officers;
CREATE POLICY "site_officers_delete_super_admin" ON site_officers
  FOR DELETE TO authenticated USING (is_super_admin());

-- district_doctors: district members read; the doctor or a district
-- officer updates (the guard trigger limits what each can change).
DROP POLICY IF EXISTS "district_doctors_select_member" ON district_doctors;
CREATE POLICY "district_doctors_select_member" ON district_doctors
  FOR SELECT TO authenticated USING (is_district_member(district_id));

DROP POLICY IF EXISTS "district_doctors_update_self_or_officer" ON district_doctors;
CREATE POLICY "district_doctors_update_self_or_officer" ON district_doctors
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR is_district_officer(district_id))
  WITH CHECK (user_id = auth.uid() OR is_district_officer(district_id));

REVOKE ALL ON districts, sites, site_officers, district_doctors FROM anon;
REVOKE INSERT, DELETE, TRUNCATE ON district_doctors FROM authenticated;
REVOKE INSERT, UPDATE, TRUNCATE ON site_officers FROM authenticated;

-- ---------------------------------------------------------------------------
-- Super admin RPCs
-- ---------------------------------------------------------------------------

-- Makes an existing login (anyone who has signed in to roster-app or
-- district-roster) an officer of a site. Looked up by email here because
-- the browser can't read other people's profiles rows.
CREATE OR REPLACE FUNCTION add_site_officer(p_site_id uuid, p_email text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_email text := lower(trim(p_email));
BEGIN
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'Only a super admin can add site officers';
  END IF;

  SELECT user_id INTO v_user_id FROM profiles WHERE lower(email) = v_email;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No login found for %. Invite them first (as a district doctor or in roster-app).', v_email;
  END IF;

  INSERT INTO site_officers (site_id, user_id, email)
  VALUES (p_site_id, v_user_id, v_email)
  ON CONFLICT (site_id, user_id) DO NOTHING;
END;
$$;

REVOKE EXECUTE ON FUNCTION add_site_officer(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION add_site_officer(uuid, text) TO authenticated;

-- Lists roster-app departments for linking to sites. departments RLS only
-- shows a user their own, so this gives the super admin the full list.
CREATE OR REPLACE FUNCTION list_departments_for_linking()
RETURNS TABLE (department_id uuid, name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'Only a super admin can list departments';
  END IF;
  RETURN QUERY SELECT d.department_id, d.name FROM departments d ORDER BY d.name;
END;
$$;

REVOKE EXECUTE ON FUNCTION list_departments_for_linking() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION list_departments_for_linking() TO authenticated;

COMMIT;

-- After running: make your first district and its sites in the app
-- (Admin tab, super admins only), or here, e.g.
--   INSERT INTO districts (name) VALUES ('Cairns and Hinterland');
