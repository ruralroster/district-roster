-- Doctors tab > Invite an officer: a district officer names a new officer
-- (name, email, site). They go on site_officer_pending, and the
-- invite-district-doctor function then emails them (officerEmails) and
-- makes them an officer of that site: straight away if they already have
-- a login (e.g. Rstar), or when they set their password. An officer with
-- no district_doctors row sees only the officer side of DR App.
--
-- Run in the Supabase SQL Editor. Safe to re-run.

BEGIN;

CREATE OR REPLACE FUNCTION add_pending_site_officer(p_site_id uuid, p_email text, p_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(trim(p_email));
  v_district uuid := (SELECT district_id FROM sites WHERE site_id = p_site_id);
BEGIN
  IF v_district IS NULL THEN
    RAISE EXCEPTION 'No such site';
  END IF;
  IF NOT is_district_officer(v_district) THEN
    RAISE EXCEPTION 'Only an officer in this district can invite officers';
  END IF;
  IF v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'That email doesn''t look right: %', p_email;
  END IF;

  INSERT INTO site_officer_pending (site_id, email, name)
  VALUES (p_site_id, v_email, nullif(trim(p_name), ''))
  ON CONFLICT (site_id, email) DO UPDATE SET name = coalesce(EXCLUDED.name, site_officer_pending.name);
END;
$$;

REVOKE EXECUTE ON FUNCTION add_pending_site_officer(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION add_pending_site_officer(uuid, text, text) TO authenticated;

COMMIT;
