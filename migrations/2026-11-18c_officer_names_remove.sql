-- Staff tab > Officers: names, and removing an officer.
--   1. site_officers.name: filled when they become an officer (from the
--      name they were invited with, or their Rstar or doctor record), and
--      backfilled the same way. Edit name sets it (set_site_officer_name).
--   2. remove_site_officer(): a district officer takes someone off as an
--      officer of one site, or of every site in the district. Their login
--      stays; they just stop being an officer here. Officers not invited
--      yet are taken off the waiting list. You can't remove yourself.
--      (Officers who come from a site's Rstar link aren't in site_officers
--      and are managed in Rstar.)
--
-- Run in the Supabase SQL Editor. Safe to re-run.

BEGIN;

ALTER TABLE site_officers ADD COLUMN IF NOT EXISTS name text;

-- The best name we have for an officer's login.
CREATE OR REPLACE FUNCTION officer_known_name(p_user_id uuid, p_email text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    (SELECT name FROM site_officer_pending WHERE email = lower(p_email) AND name IS NOT NULL LIMIT 1),
    (SELECT name FROM staff WHERE user_id = p_user_id AND name IS NOT NULL ORDER BY active DESC LIMIT 1),
    (SELECT name FROM district_doctors WHERE user_id = p_user_id AND name IS NOT NULL LIMIT 1)
  );
$$;
REVOKE EXECUTE ON FUNCTION officer_known_name(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION site_officers_fill_name()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.name IS NULL THEN
    NEW.name := officer_known_name(NEW.user_id, NEW.email);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION site_officers_fill_name() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS site_officers_fill_name ON site_officers;
CREATE TRIGGER site_officers_fill_name
  BEFORE INSERT ON site_officers
  FOR EACH ROW EXECUTE FUNCTION site_officers_fill_name();

UPDATE site_officers SET name = officer_known_name(user_id, email) WHERE name IS NULL;

-- Edit name: every site row for that officer in the district.
CREATE OR REPLACE FUNCTION set_site_officer_name(p_district_id uuid, p_email text, p_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_district_officer(p_district_id) THEN
    RAISE EXCEPTION 'Only an officer in this district can change officers';
  END IF;
  UPDATE site_officers o SET name = nullif(trim(p_name), '')
  FROM sites s
  WHERE s.site_id = o.site_id AND s.district_id = p_district_id AND o.email = lower(trim(p_email));
  UPDATE site_officer_pending p SET name = nullif(trim(p_name), '')
  FROM sites s
  WHERE s.site_id = p.site_id AND s.district_id = p_district_id AND p.email = lower(trim(p_email));
END;
$$;
REVOKE EXECUTE ON FUNCTION set_site_officer_name(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_site_officer_name(uuid, text, text) TO authenticated;

-- p_site_id null: every site in the district.
CREATE OR REPLACE FUNCTION remove_site_officer(p_district_id uuid, p_email text, p_site_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(trim(p_email));
BEGIN
  IF NOT is_district_officer(p_district_id) THEN
    RAISE EXCEPTION 'Only an officer in this district can remove officers';
  END IF;
  IF p_site_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sites WHERE site_id = p_site_id AND district_id = p_district_id) THEN
    RAISE EXCEPTION 'That site isn''t in this district';
  END IF;
  IF v_email = (SELECT lower(email) FROM profiles WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'You can''t remove yourself. Ask another officer.';
  END IF;

  DELETE FROM site_officers o USING sites s
  WHERE s.site_id = o.site_id AND s.district_id = p_district_id AND o.email = v_email
    AND (p_site_id IS NULL OR o.site_id = p_site_id);
  DELETE FROM site_officer_pending p USING sites s
  WHERE s.site_id = p.site_id AND s.district_id = p_district_id AND p.email = v_email
    AND (p_site_id IS NULL OR p.site_id = p_site_id);
END;
$$;
REVOKE EXECUTE ON FUNCTION remove_site_officer(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION remove_site_officer(uuid, text, uuid) TO authenticated;

COMMIT;

-- Officers and their names now:
SELECT s.name AS site, o.name, o.email FROM site_officers o JOIN sites s ON s.site_id = o.site_id ORDER BY s.name, o.email;
