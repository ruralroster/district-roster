-- New doctors start with every site in the district under "Sites I'd work
-- at", instead of just their home site, so they see straight away how much
-- work there is. The first time they open DR Roster, a pop-up says so and
-- points them at My profile to narrow it down (sites_intro_seen).
--
-- Sites a doctor brought with them from the v3 import are kept.
--
-- Doctors who've never signed in, and whose list is still empty or just
-- their home site, get every site too, and will see the pop-up. Everyone
-- who has signed in already keeps their list and doesn't see it.
--
-- Run in the SQL editor (it reads auth.users). Safe to re-run.

BEGIN;

ALTER TABLE district_doctors ADD COLUMN IF NOT EXISTS sites_intro_seen boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION district_doctors_default_interest()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.interested_site_ids = '{}' THEN
    NEW.interested_site_ids := ARRAY(SELECT site_id FROM sites WHERE district_id = NEW.district_id ORDER BY name);
  END IF;
  RETURN NEW;
END;
$$;

UPDATE district_doctors d
SET interested_site_ids = ARRAY(SELECT site_id FROM sites WHERE district_id = d.district_id ORDER BY name)
WHERE (d.user_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = d.user_id AND u.last_sign_in_at IS NOT NULL))
  AND d.interested_site_ids <@ ARRAY[d.home_site_id]
  AND NOT d.sites_intro_seen;

UPDATE district_doctors d
SET sites_intro_seen = true
WHERE EXISTS (SELECT 1 FROM auth.users u WHERE u.id = d.user_id AND u.last_sign_in_at IS NOT NULL)
  AND NOT d.sites_intro_seen;

COMMIT;

SELECT d.name, d.sites_intro_seen, cardinality(d.interested_site_ids) AS sites,
       (SELECT count(*) FROM sites s WHERE s.district_id = d.district_id) AS of_sites
FROM district_doctors d ORDER BY d.sites_intro_seen, d.name;
