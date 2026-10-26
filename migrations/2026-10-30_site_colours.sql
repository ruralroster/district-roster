-- A colour of each site's choosing.
--
-- sites.colour_hue: 0-359 round the colour wheel, or NULL for the automatic
-- colour (siteColours.js spreads sites in name order round the wheel).
-- Set by the site's officers on the Sites tab, through set_site_colour()
-- because sites are otherwise only writable by the super admin.
--
-- Run after 2026-10-24_district_foundation.sql. Safe to re-run.

BEGIN;

ALTER TABLE sites ADD COLUMN IF NOT EXISTS colour_hue integer;
ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_colour_hue_check;
ALTER TABLE sites ADD CONSTRAINT sites_colour_hue_check CHECK (colour_hue IS NULL OR colour_hue BETWEEN 0 AND 359);

CREATE OR REPLACE FUNCTION set_site_colour(p_site_id uuid, p_hue integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_site_officer(p_site_id) THEN
    RAISE EXCEPTION 'Only this site''s officers can change this';
  END IF;
  IF p_hue IS NOT NULL AND p_hue NOT BETWEEN 0 AND 359 THEN
    RAISE EXCEPTION 'Choose a colour from the list';
  END IF;
  UPDATE sites SET colour_hue = p_hue WHERE site_id = p_site_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION set_site_colour(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_site_colour(uuid, integer) TO authenticated;

COMMIT;
