-- Step 4: officer extras.
--
--   1. "Locum might be required": an open district shift less than 3 weeks
--      away is flagged on the officer's Calendar and leads their digest.
--   2. Urgent: a shift still open with under 72 hours to go is pushed and
--      emailed to the site's officers straight away, once
--      (district_notices.urgent_notified_at).
--   3. Weekly digest: on the day(s) each officer chooses (My account, Monday
--      by default), one email and push listing their sites' open district
--      shifts for the next 6 weeks, "locum might be required" ones first,
--      plus swaps waiting for them. Sent by district-notify from 7:00.
--
-- Run after 2026-10-31_swaps.sql. Safe to re-run.

BEGIN;

ALTER TABLE district_notices ADD COLUMN IF NOT EXISTS urgent_notified_at timestamptz;

-- An officer's digest days: 0 = Monday … 6 = Sunday. No row = Monday.
CREATE TABLE IF NOT EXISTS district_officer_settings (
  user_id uuid PRIMARY KEY REFERENCES profiles(user_id) ON DELETE CASCADE,
  digest_days int[] NOT NULL DEFAULT '{0}',
  digest_sent_on date,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT district_officer_settings_days_check CHECK (digest_days <@ ARRAY[0, 1, 2, 3, 4, 5, 6])
);

ALTER TABLE district_officer_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON district_officer_settings FROM anon;

DROP POLICY IF EXISTS "district_officer_settings_own" ON district_officer_settings;
CREATE POLICY "district_officer_settings_own" ON district_officer_settings
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Who's an officer of which site: the site's own officers, and the linked
-- roster-app department's (the same people is_site_officer lets in).
-- For district-notify.
CREATE OR REPLACE FUNCTION district_site_officer_pairs()
RETURNS TABLE (site_id uuid, user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT site_id, user_id FROM site_officers
  UNION
  SELECT s.site_id, st.user_id
  FROM sites s JOIN staff st ON st.department_id = s.department_id
  WHERE st.role = 'officer' AND st.active AND st.user_id IS NOT NULL;
$$;

REVOKE EXECUTE ON FUNCTION district_site_officer_pairs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION district_site_officer_pairs() TO service_role;

COMMIT;
