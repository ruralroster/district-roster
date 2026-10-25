-- How long a site's gaps stay local before going to the district.
--
-- sites.escalate_after_hours: a gap offered locally on roster-app goes to
-- the district once it's been unfilled this long (72 by default, the
-- original rule); one starting sooner than this goes straight away. Set
-- per site by its officers (Sites tab), through set_site_escalation()
-- because sites are otherwise only writable by the super admin.
--
-- Run after 2026-10-24_district_foundation.sql. Safe to re-run.

BEGIN;

ALTER TABLE sites ADD COLUMN IF NOT EXISTS escalate_after_hours integer NOT NULL DEFAULT 72;

ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_escalate_after_hours_check;
ALTER TABLE sites ADD CONSTRAINT sites_escalate_after_hours_check CHECK (escalate_after_hours BETWEEN 0 AND 720);

CREATE OR REPLACE FUNCTION set_site_escalation(p_site_id uuid, p_hours integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_site_officer(p_site_id) THEN
    RAISE EXCEPTION 'Only this site''s officers can change this';
  END IF;
  IF p_hours IS NULL OR p_hours NOT BETWEEN 0 AND 720 THEN
    RAISE EXCEPTION 'Choose between 0 and 720 hours (30 days)';
  END IF;
  UPDATE sites SET escalate_after_hours = p_hours WHERE site_id = p_site_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION set_site_escalation(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_site_escalation(uuid, integer) TO authenticated;

COMMIT;
