-- Who's told about a new shift, and how often the check runs.
--
-- A doctor hears about a new open shift only if all of these hold:
--   - active, has logged in, and their skills fit;
--   - it's at a site they'd work at (district_doctors.interested_site_ids,
--     ticked on My profile; v3's Locations on import; their home site by
--     default);
--   - they haven't marked themselves unavailable that day
--     (district_unavailable_days, from the Calendar);
--   - rested (district_rested): the shift doesn't start within 10 hours of
--     the end of a shift they're already on, and doesn't finish within 10
--     hours of the start of a shift at their primary site. Shifts they're
--     on = district shifts they've filled and their roster-app roster;
--     primary site = their roster-app roster and district shifts at their
--     home site. Roster-app on-call assignments don't count.
-- (Applying still only refuses an actual overlap; these rules decide who's
-- told.)
--
-- The check now runs every 30 minutes from 6:00 to 21:00 Brisbane.
--
-- Run after 2026-10-27_applications_notifications.sql. Safe to re-run.

BEGIN;

ALTER TABLE district_doctors ADD COLUMN IF NOT EXISTS interested_site_ids uuid[] NOT NULL DEFAULT '{}';

-- Everyone so far: their home site.
UPDATE district_doctors SET interested_site_ids = ARRAY[home_site_id]
WHERE interested_site_ids = '{}' AND home_site_id IS NOT NULL;

-- New doctors (invited one at a time): their home site to start with.
CREATE OR REPLACE FUNCTION district_doctors_default_interest()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.interested_site_ids = '{}' AND NEW.home_site_id IS NOT NULL THEN
    NEW.interested_site_ids := ARRAY[NEW.home_site_id];
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS district_doctors_default_interest ON district_doctors;
CREATE TRIGGER district_doctors_default_interest
  BEFORE INSERT ON district_doctors
  FOR EACH ROW EXECUTE FUNCTION district_doctors_default_interest();

CREATE TABLE IF NOT EXISTS district_unavailable_days (
  doctor_id uuid NOT NULL REFERENCES district_doctors(doctor_id) ON DELETE CASCADE,
  date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doctor_id, date)
);

ALTER TABLE district_unavailable_days ENABLE ROW LEVEL SECURITY;

-- Each doctor manages their own.
DROP POLICY IF EXISTS "district_unavailable_days_own" ON district_unavailable_days;
CREATE POLICY "district_unavailable_days_own" ON district_unavailable_days
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM district_doctors d WHERE d.doctor_id = district_unavailable_days.doctor_id AND d.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM district_doctors d WHERE d.doctor_id = district_unavailable_days.doctor_id AND d.user_id = auth.uid()));

REVOKE ALL ON district_unavailable_days FROM anon;

-- ---------------------------------------------------------------------------
-- The rules
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION district_rested(p_doctor_id uuid, p_notice_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH t AS (
    SELECT district_shift_range(shift_date, start_time, end_time) AS r, shift_date
    FROM district_notices WHERE notice_id = p_notice_id
  ),
  doc AS (
    SELECT user_id, home_site_id FROM district_doctors WHERE doctor_id = p_doctor_id
  ),
  busy AS (
    SELECT district_shift_range(n.shift_date, n.start_time, n.end_time) AS r,
           n.site_id IS NOT DISTINCT FROM doc.home_site_id AS primary_site
    FROM district_notices n, doc, t
    WHERE n.filled_by_doctor_id = p_doctor_id AND n.status = 'filled' AND n.notice_id <> p_notice_id
      AND n.shift_date BETWEEN t.shift_date - 2 AND t.shift_date + 2
    UNION ALL
    SELECT district_shift_range(a.date, sh.start_time, sh.end_time), true
    FROM doc
    JOIN staff st ON st.user_id = doc.user_id
    JOIN staff_assignments a ON a.staff_id = st.staff_id
    JOIN shifts sh ON sh.shift_id = a.shift_id, t
    WHERE doc.user_id IS NOT NULL AND NOT a.on_call
      AND a.date BETWEEN t.shift_date - 2 AND t.shift_date + 2
  )
  SELECT NOT EXISTS (
    SELECT 1 FROM busy, t
    WHERE busy.r && t.r
       -- starts within 10 hours of the end of a shift they're on
       OR (lower(t.r) >= upper(busy.r) AND lower(t.r) < upper(busy.r) + interval '10 hours')
       -- finishes within 10 hours of the start of a primary-site shift
       OR (busy.primary_site AND lower(busy.r) >= upper(t.r) AND lower(busy.r) < upper(t.r) + interval '10 hours')
  );
$$;

-- Who to tell about these new shifts: (notice, doctor) pairs.
CREATE OR REPLACE FUNCTION district_notice_recipients(p_notice_ids uuid[])
RETURNS TABLE (notice_id uuid, doctor_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT n.notice_id, d.doctor_id
  FROM district_notices n
  JOIN district_doctors d ON d.district_id = n.district_id
  WHERE n.notice_id = ANY (p_notice_ids)
    AND n.status = 'open'
    AND d.active
    AND d.user_id IS NOT NULL
    AND n.required_skill = ANY (d.skills)
    AND n.site_id = ANY (d.interested_site_ids)
    AND NOT EXISTS (
      SELECT 1 FROM district_unavailable_days u
      WHERE u.doctor_id = d.doctor_id
        AND (u.date = n.shift_date
             -- a night that runs into a day they're unavailable
             OR (n.end_time < n.start_time AND n.end_time > time '00:00' AND u.date = n.shift_date + 1))
    )
    AND district_rested(d.doctor_id, n.notice_id);
$$;

REVOKE EXECUTE ON FUNCTION district_rested(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_notice_recipients(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION district_notice_recipients(uuid[]) TO service_role;

-- ---------------------------------------------------------------------------
-- The v3 import also fills in the sites each doctor would work at (v3's
-- Locations). Re-importing sets them for doctors already here whose list
-- is still just their home site. Same as 2026-10-26_v3_import.sql otherwise.
-- ---------------------------------------------------------------------------

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
  v_interest uuid[];
  v_home uuid;
  v_inserted boolean;
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
      v_home := (v_sites->>lower(v_person->'doctor'->>'home_site'))::uuid;
      v_interest := ARRAY(
        SELECT DISTINCT (v_sites->>lower(trim(s)))::uuid
        FROM jsonb_array_elements_text(coalesce(v_person->'doctor'->'sites', '[]')) s
        WHERE v_sites ? lower(trim(s))
      );
      IF v_home IS NOT NULL AND NOT v_home = ANY (v_interest) THEN
        v_interest := v_interest || v_home;
      END IF;

      INSERT INTO district_doctors AS dd (district_id, user_id, email, name, home_site_id, skills, interested_site_ids)
      VALUES (
        p_district_id,
        v_user_id,
        v_email,
        trim(v_person->>'name'),
        v_home,
        ARRAY(SELECT jsonb_array_elements_text(v_person->'doctor'->'skills')),
        v_interest
      )
      ON CONFLICT (district_id, email) DO UPDATE SET interested_site_ids = EXCLUDED.interested_site_ids
        WHERE dd.interested_site_ids <@ ARRAY[dd.home_site_id] AND cardinality(EXCLUDED.interested_site_ids) > 0
      RETURNING (xmax = 0) INTO v_inserted;
      IF v_inserted THEN v_doctors_added := v_doctors_added + 1; ELSE v_doctors_existing := v_doctors_existing + 1; END IF;
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

-- ---------------------------------------------------------------------------
-- Every 30 minutes, 6:00-21:00 Brisbane (UTC+10): 20:00-10:30 UTC, plus
-- 21:00 itself as its own job. Replaces the 5-minute schedule.
-- ---------------------------------------------------------------------------

SELECT cron.schedule(
  'district-notify',
  '*/30 0-10,20-23 * * *',
  $$
  SELECT net.http_post(
    url := 'https://cmchorwjojvihlahknxk.supabase.co/functions/v1/district-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'district_notify_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

SELECT cron.schedule(
  'district-notify-2100',
  '0 11 * * *',
  $$
  SELECT net.http_post(
    url := 'https://cmchorwjojvihlahknxk.supabase.co/functions/v1/district-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'district_notify_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
