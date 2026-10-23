-- Step 2, part 1 (roster-app issue #2): district shifts ("notices", v3's
-- vacancies), which fill the Calendar tab. Applications, escalation from
-- roster-app and notifications come in later migrations.
--
-- A notice is one shift at one site. end_time earlier than start_time
-- means it finishes the next day (a night). required_skill is one of the
-- doctor skills; Emergency means any doctor.
--
-- Who can do what:
--   - district members (doctors and officers) read the district's notices;
--     the app shows doctors only the ones their skills fit.
--   - a site officer posts, edits, cancels and marks filled their site's
--     notices. No deletes: cancel instead, so there's a history.
--
-- Run after 2026-10-24_district_foundation.sql. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS district_notices (
  notice_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(district_id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES sites(site_id) ON DELETE CASCADE,
  shift_date date NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  required_skill text NOT NULL DEFAULT 'Emergency',
  notes text,
  status text NOT NULL DEFAULT 'open',
  -- 'officer' = posted in district-roster; 'roster_app' = escalated gap.
  source text NOT NULL DEFAULT 'officer',
  filled_by_doctor_id uuid REFERENCES district_doctors(doctor_id) ON DELETE SET NULL,
  created_by uuid REFERENCES profiles(user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT district_notices_skill_check CHECK (required_skill IN ('Emergency', 'Anaesthetics', 'O&G')),
  CONSTRAINT district_notices_status_check CHECK (status IN ('open', 'filled', 'cancelled')),
  CONSTRAINT district_notices_source_check CHECK (source IN ('officer', 'roster_app')),
  CONSTRAINT district_notices_times_check CHECK (start_time <> end_time)
);

CREATE INDEX IF NOT EXISTS district_notices_district_date_idx ON district_notices (district_id, shift_date);
CREATE INDEX IF NOT EXISTS district_notices_site_idx ON district_notices (site_id);

-- district_id always follows the site, so a notice can't be filed under
-- another district; the filling doctor must be in the same district.
CREATE OR REPLACE FUNCTION district_notices_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  SELECT district_id INTO NEW.district_id FROM sites WHERE site_id = NEW.site_id;

  IF NEW.filled_by_doctor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM district_doctors WHERE doctor_id = NEW.filled_by_doctor_id AND district_id = NEW.district_id
  ) THEN
    RAISE EXCEPTION 'The filling doctor must be in the notice''s district';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_by := COALESCE(NEW.created_by, auth.uid());
  ELSE
    NEW.updated_at := now();
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION district_notices_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS district_notices_guard ON district_notices;
CREATE TRIGGER district_notices_guard
  BEFORE INSERT OR UPDATE ON district_notices
  FOR EACH ROW EXECUTE FUNCTION district_notices_guard();

ALTER TABLE district_notices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "district_notices_select_member" ON district_notices;
CREATE POLICY "district_notices_select_member" ON district_notices
  FOR SELECT TO authenticated USING (is_district_member(district_id));

DROP POLICY IF EXISTS "district_notices_insert_site_officer" ON district_notices;
CREATE POLICY "district_notices_insert_site_officer" ON district_notices
  FOR INSERT TO authenticated WITH CHECK (is_site_officer(site_id));

DROP POLICY IF EXISTS "district_notices_update_site_officer" ON district_notices;
CREATE POLICY "district_notices_update_site_officer" ON district_notices
  FOR UPDATE TO authenticated
  USING (is_site_officer(site_id))
  WITH CHECK (is_site_officer(site_id));

REVOKE ALL ON district_notices FROM anon;
REVOKE DELETE, TRUNCATE ON district_notices FROM authenticated;

COMMIT;
