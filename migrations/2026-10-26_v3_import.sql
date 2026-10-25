-- Importing v3's people into a district (Admin tab > Import from v3).
--
--   1. site_officer_pending: officers named before they have a login. When
--      a profiles row with that email appears (they're invited, or sign in
--      to roster-app), they become a site_officers row automatically.
--   2. import_v3_people(): super admin only. Creates missing sites, adds
--      doctors and officers. Sends nothing: doctors without a login are
--      added with no user_id and invited later; anyone who already has a
--      login (roster-app or district-roster) is linked straight away.
--      Existing doctors (same email in the district) are left as they are.
--
-- Run this whole file in the Supabase SQL Editor, after
-- 2026-10-24_district_foundation.sql. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS site_officer_pending (
  site_id uuid NOT NULL REFERENCES sites(site_id) ON DELETE CASCADE,
  email text NOT NULL,
  name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, email),
  CONSTRAINT site_officer_pending_email_lower CHECK (email = lower(email))
);

ALTER TABLE site_officer_pending ENABLE ROW LEVEL SECURITY;

-- Same as site_officers: district members read, super admin removes.
DROP POLICY IF EXISTS "site_officer_pending_select_member" ON site_officer_pending;
CREATE POLICY "site_officer_pending_select_member" ON site_officer_pending
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM sites s WHERE s.site_id = site_officer_pending.site_id AND is_district_member(s.district_id))
  );

DROP POLICY IF EXISTS "site_officer_pending_delete_super_admin" ON site_officer_pending;
CREATE POLICY "site_officer_pending_delete_super_admin" ON site_officer_pending
  FOR DELETE TO authenticated USING (is_super_admin());

REVOKE ALL ON site_officer_pending FROM anon;
REVOKE INSERT, UPDATE, TRUNCATE ON site_officer_pending FROM authenticated;

-- A new or changed login email turns pending officer rows into real ones.
CREATE OR REPLACE FUNCTION site_officer_pending_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO site_officers (site_id, user_id, email)
  SELECT site_id, NEW.user_id, email FROM site_officer_pending WHERE email = lower(NEW.email)
  ON CONFLICT (site_id, user_id) DO NOTHING;
  DELETE FROM site_officer_pending WHERE email = lower(NEW.email);
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION site_officer_pending_claim() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS site_officer_pending_claim ON profiles;
CREATE TRIGGER site_officer_pending_claim
  AFTER INSERT OR UPDATE OF email ON profiles
  FOR EACH ROW EXECUTE FUNCTION site_officer_pending_claim();

-- p_data: {
--   sites: ["Innisfail", ...],
--   people: [{ name, email,
--              doctor: { home_site: "Innisfail", skills: ["Emergency", ...] } | null,
--              officer_sites: ["Innisfail", ...] }]
-- }
-- Sites are matched to existing ones by name, ignoring case.
CREATE OR REPLACE FUNCTION import_v3_people(p_district_id uuid, p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_site_name text;
  v_person jsonb;
  v_email text;
  v_user_id uuid;
  v_site_id uuid;
  v_sites jsonb := '{}';
  v_sites_created int := 0;
  v_doctors_added int := 0;
  v_doctors_existing int := 0;
  v_officers_added int := 0;
  v_officers_pending int := 0;
  v_rows int;
BEGIN
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'Only a super admin can import';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM districts WHERE district_id = p_district_id) THEN
    RAISE EXCEPTION 'No such district';
  END IF;

  -- Sites: find or create, remembering each name's site_id.
  FOR v_site_name IN SELECT trim(value) FROM jsonb_array_elements_text(p_data->'sites') LOOP
    SELECT site_id INTO v_site_id FROM sites
    WHERE district_id = p_district_id AND lower(name) = lower(v_site_name);
    IF v_site_id IS NULL THEN
      INSERT INTO sites (district_id, name) VALUES (p_district_id, v_site_name) RETURNING site_id INTO v_site_id;
      v_sites_created := v_sites_created + 1;
    END IF;
    v_sites := v_sites || jsonb_build_object(lower(v_site_name), v_site_id);
  END LOOP;

  FOR v_person IN SELECT value FROM jsonb_array_elements(p_data->'people') LOOP
    v_email := lower(trim(v_person->>'email'));
    IF v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
      RAISE EXCEPTION 'Bad email for %: %', v_person->>'name', v_email;
    END IF;
    SELECT user_id INTO v_user_id FROM profiles WHERE lower(email) = v_email;

    IF jsonb_typeof(v_person->'doctor') = 'object' THEN
      INSERT INTO district_doctors (district_id, user_id, email, name, home_site_id, skills)
      VALUES (
        p_district_id,
        v_user_id,
        v_email,
        trim(v_person->>'name'),
        (v_sites->>lower(v_person->'doctor'->>'home_site'))::uuid,
        ARRAY(SELECT jsonb_array_elements_text(v_person->'doctor'->'skills'))
      )
      ON CONFLICT (district_id, email) DO NOTHING;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows = 1 THEN v_doctors_added := v_doctors_added + 1; ELSE v_doctors_existing := v_doctors_existing + 1; END IF;
    END IF;

    FOR v_site_name IN SELECT value FROM jsonb_array_elements_text(coalesce(v_person->'officer_sites', '[]')) LOOP
      v_site_id := (v_sites->>lower(trim(v_site_name)))::uuid;
      IF v_site_id IS NULL THEN
        RAISE EXCEPTION '% is an officer of %, which isn''t in the sites list', v_person->>'name', v_site_name;
      END IF;
      IF v_user_id IS NOT NULL THEN
        INSERT INTO site_officers (site_id, user_id, email) VALUES (v_site_id, v_user_id, v_email)
        ON CONFLICT (site_id, user_id) DO NOTHING;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        v_officers_added := v_officers_added + v_rows;
      ELSE
        INSERT INTO site_officer_pending (site_id, email, name) VALUES (v_site_id, v_email, trim(v_person->>'name'))
        ON CONFLICT (site_id, email) DO NOTHING;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        v_officers_pending := v_officers_pending + v_rows;
      END IF;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'sites_created', v_sites_created,
    'doctors_added', v_doctors_added,
    'doctors_existing', v_doctors_existing,
    'officers_added', v_officers_added,
    'officers_pending', v_officers_pending
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION import_v3_people(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION import_v3_people(uuid, jsonb) TO authenticated;

COMMIT;

-- To undo an import into a district (doctors who haven't logged in yet,
-- and pending officers):
--   DELETE FROM district_doctors WHERE district_id = '<district id>' AND user_id IS NULL;
--   DELETE FROM site_officer_pending WHERE site_id IN (SELECT site_id FROM sites WHERE district_id = '<district id>');
