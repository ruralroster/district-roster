-- Staff tab > Officers > Add site: a district officer makes an officer
-- who already has a login an officer of another site in the district too.
-- No email is sent. (Officers not invited yet get the site through
-- add_pending_site_officer instead, and it's in their invite.)
--
-- Run in the Supabase SQL Editor, after 2026-11-18_invite_officer.sql.
-- Safe to re-run.

BEGIN;

CREATE OR REPLACE FUNCTION add_officer_site(p_site_id uuid, p_email text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(trim(p_email));
  v_district uuid := (SELECT district_id FROM sites WHERE site_id = p_site_id);
  v_user uuid;
BEGIN
  IF v_district IS NULL THEN
    RAISE EXCEPTION 'No such site';
  END IF;
  IF NOT is_district_officer(v_district) THEN
    RAISE EXCEPTION 'Only an officer in this district can add officers';
  END IF;
  -- Only someone already an officer in this district.
  IF NOT EXISTS (
    SELECT 1 FROM site_officers o JOIN sites s ON s.site_id = o.site_id
    WHERE s.district_id = v_district AND o.email = v_email
  ) THEN
    RAISE EXCEPTION '% isn''t an officer in this district yet. Use Invite an officer.', v_email;
  END IF;
  SELECT user_id INTO v_user FROM profiles WHERE lower(email) = v_email;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'No login found for %', v_email;
  END IF;

  INSERT INTO site_officers (site_id, user_id, email)
  VALUES (p_site_id, v_user, v_email)
  ON CONFLICT (site_id, user_id) DO NOTHING;
END;
$$;

REVOKE EXECUTE ON FUNCTION add_officer_site(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION add_officer_site(uuid, text) TO authenticated;

COMMIT;
