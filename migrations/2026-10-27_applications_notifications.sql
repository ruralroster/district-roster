-- Step 2, part 2 (roster-app issue #2): doctors apply for district shifts,
-- officers approve or decline, and everyone's told by email and push.
--
--   1. district_applications. Written only through the RPCs below:
--        apply_for_notice      doctor: an open shift their skills fit, from
--                              today on, that doesn't clash with anything
--                              they're already booked on (district shifts
--                              they've filled, and their roster-app roster)
--        withdraw_application  doctor: their own pending one
--        approve_application   site officer: books the doctor (checks the
--                              clash again) and declines everyone else
--        decline_application   site officer, with an optional reason
--      Marking a shift filled, reopening or cancelling it on the Calendar
--      updates its applications to match (see district_notices_sync).
--   2. district_push_subscriptions: phones/browsers that turned on
--      notifications in DR Roster (separate from roster-app's, which go to
--      roster-app's own app).
--   3. What's been notified: district_notices.notified_at (new shifts, to
--      doctors whose skills fit), district_applications.officer_notified_at
--      (applied or withdrawn, to the site's officers) and
--      .doctor_notified_at (approved, declined or booking cancelled, to the
--      doctor). The district-notify Edge Function, run on a timer (every 30
--      minutes, 6:00-21:00 Brisbane; see 2026-10-27b), sends what's waiting, grouped, so
--      posting 20 shifts is one email, not 20. Doctors who've never logged
--      in (imported, not yet invited) are never emailed.
--
-- Run after 2026-10-26b_shift_types.sql, then deploy district-notify
-- (Verify JWT off). Safe to re-run.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

BEGIN;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS district_applications (
  application_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_id uuid NOT NULL REFERENCES district_notices(notice_id) ON DELETE CASCADE,
  doctor_id uuid NOT NULL REFERENCES district_doctors(doctor_id) ON DELETE CASCADE,
  -- cancelled: was approved, then the officer reopened or cancelled the shift.
  status text NOT NULL DEFAULT 'pending',
  note text,
  decline_reason text,
  decided_by uuid REFERENCES profiles(user_id) ON DELETE SET NULL,
  decided_at timestamptz,
  officer_notified_at timestamptz,
  doctor_notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT district_applications_status_check CHECK (status IN ('pending', 'approved', 'declined', 'withdrawn', 'cancelled'))
);

-- One live application per doctor per shift; they can apply again after
-- withdrawing or being declined.
CREATE UNIQUE INDEX IF NOT EXISTS district_applications_live_idx
  ON district_applications (notice_id, doctor_id) WHERE status IN ('pending', 'approved');
CREATE INDEX IF NOT EXISTS district_applications_doctor_idx ON district_applications (doctor_id);
CREATE INDEX IF NOT EXISTS district_applications_officer_todo_idx ON district_applications (created_at) WHERE officer_notified_at IS NULL;
CREATE INDEX IF NOT EXISTS district_applications_doctor_todo_idx ON district_applications (created_at) WHERE doctor_notified_at IS NULL;

ALTER TABLE district_notices ADD COLUMN IF NOT EXISTS notified_at timestamptz;
-- Shifts that exist now were posted before notifications: don't announce them.
UPDATE district_notices SET notified_at = now() WHERE notified_at IS NULL;
CREATE INDEX IF NOT EXISTS district_notices_todo_idx ON district_notices (created_at) WHERE notified_at IS NULL;

CREATE TABLE IF NOT EXISTS district_push_subscriptions (
  push_subscription_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, endpoint)
);

-- ---------------------------------------------------------------------------
-- Clashes
-- ---------------------------------------------------------------------------

-- A shift's start and finish as timestamps (finish next day if it's not
-- after the start; equal is 24 hours).
CREATE OR REPLACE FUNCTION district_shift_range(p_date date, p_start time, p_end time)
RETURNS tsrange
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT tsrange(p_date + p_start, p_date + p_end + CASE WHEN p_end <= p_start THEN interval '1 day' ELSE interval '0' END);
$$;

-- What the doctor is already booked on that overlaps this shift, as text
-- for the error ("Tully Night on 2026-11-03"), or NULL if nothing.
-- Looks at district shifts they've filled and, where they're on
-- roster-app (same login), their roster-app shifts.
CREATE OR REPLACE FUNCTION district_clash(p_doctor_id uuid, p_notice_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH target AS (
    SELECT district_shift_range(shift_date, start_time, end_time) AS r, shift_date
    FROM district_notices WHERE notice_id = p_notice_id
  ),
  doctor AS (
    SELECT user_id FROM district_doctors WHERE doctor_id = p_doctor_id
  )
  SELECT clash FROM (
    SELECT format('%s %s on %s', s.name, coalesce(n.title, to_char(n.start_time, 'HH24:MI')), n.shift_date) AS clash
    FROM district_notices n
    JOIN sites s ON s.site_id = n.site_id, target t
    WHERE n.filled_by_doctor_id = p_doctor_id
      AND n.status = 'filled'
      AND n.notice_id <> p_notice_id
      AND n.shift_date BETWEEN t.shift_date - 1 AND t.shift_date + 1
      AND district_shift_range(n.shift_date, n.start_time, n.end_time) && t.r
    UNION ALL
    SELECT format('your %s roster (%s-%s on %s)', d.name, to_char(sh.start_time, 'HH24:MI'), to_char(sh.end_time, 'HH24:MI'), a.date)
    FROM doctor doc
    JOIN staff st ON st.user_id = doc.user_id
    JOIN staff_assignments a ON a.staff_id = st.staff_id
    JOIN shifts sh ON sh.shift_id = a.shift_id
    JOIN departments d ON d.department_id = a.department_id, target t
    WHERE doc.user_id IS NOT NULL
      AND a.date BETWEEN t.shift_date - 1 AND t.shift_date + 1
      AND district_shift_range(a.date, sh.start_time, sh.end_time) && t.r
  ) clashes
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION district_clash(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION apply_for_notice(p_notice_id uuid, p_note text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_notice district_notices%ROWTYPE;
  v_doctor district_doctors%ROWTYPE;
  v_clash text;
  v_id uuid;
BEGIN
  SELECT * INTO v_notice FROM district_notices WHERE notice_id = p_notice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That shift no longer exists';
  END IF;
  SELECT * INTO v_doctor FROM district_doctors
  WHERE district_id = v_notice.district_id AND user_id = auth.uid() AND active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only doctors in this district can apply';
  END IF;
  IF v_notice.status <> 'open' THEN
    RAISE EXCEPTION 'This shift has already been filled or cancelled';
  END IF;
  IF v_notice.shift_date < (now() AT TIME ZONE 'Australia/Brisbane')::date THEN
    RAISE EXCEPTION 'This shift is in the past';
  END IF;
  IF NOT v_notice.required_skill = ANY (v_doctor.skills) THEN
    RAISE EXCEPTION 'This shift needs %, which isn''t on your profile', v_notice.required_skill;
  END IF;
  IF EXISTS (
    SELECT 1 FROM district_applications
    WHERE notice_id = p_notice_id AND doctor_id = v_doctor.doctor_id AND status IN ('pending', 'approved')
  ) THEN
    RAISE EXCEPTION 'You''ve already applied for this shift';
  END IF;
  v_clash := district_clash(v_doctor.doctor_id, p_notice_id);
  IF v_clash IS NOT NULL THEN
    RAISE EXCEPTION 'This clashes with %', v_clash;
  END IF;

  INSERT INTO district_applications (notice_id, doctor_id, note)
  VALUES (p_notice_id, v_doctor.doctor_id, nullif(trim(p_note), ''))
  RETURNING application_id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION withdraw_application(p_application_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE district_applications a SET status = 'withdrawn'
  FROM district_doctors d
  WHERE a.application_id = p_application_id
    AND d.doctor_id = a.doctor_id AND d.user_id = auth.uid()
    AND a.status = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only your own application that''s still waiting can be withdrawn. Once you''re booked, ask the site''s officer.';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION approve_application(p_application_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_app district_applications%ROWTYPE;
  v_notice district_notices%ROWTYPE;
  v_clash text;
BEGIN
  SELECT * INTO v_app FROM district_applications WHERE application_id = p_application_id;
  SELECT * INTO v_notice FROM district_notices WHERE notice_id = v_app.notice_id;
  IF v_notice.notice_id IS NULL OR NOT is_site_officer(v_notice.site_id) THEN
    RAISE EXCEPTION 'Only this site''s officers can approve';
  END IF;
  IF v_app.status <> 'pending' THEN
    RAISE EXCEPTION 'This application has already been dealt with';
  END IF;
  IF v_notice.status <> 'open' THEN
    RAISE EXCEPTION 'This shift has already been filled or cancelled';
  END IF;
  v_clash := district_clash(v_app.doctor_id, v_notice.notice_id);
  IF v_clash IS NOT NULL THEN
    RAISE EXCEPTION 'They''re now booked on % at the same time', v_clash;
  END IF;
  -- district_notices_sync approves this application and declines the rest.
  UPDATE district_notices SET status = 'filled', filled_by_doctor_id = v_app.doctor_id
  WHERE notice_id = v_notice.notice_id;
END;
$$;

CREATE OR REPLACE FUNCTION decline_application(p_application_id uuid, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE district_applications a
  SET status = 'declined', decline_reason = nullif(trim(p_reason), ''), decided_by = auth.uid(), decided_at = now()
  FROM district_notices n
  WHERE a.application_id = p_application_id AND n.notice_id = a.notice_id
    AND is_site_officer(n.site_id) AND a.status = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only this site''s officers can decline, and only an application that''s waiting';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION apply_for_notice(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION withdraw_application(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION approve_application(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION decline_application(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION apply_for_notice(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION withdraw_application(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION approve_application(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION decline_application(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Keeping applications in step with their shift, and who needs telling
-- ---------------------------------------------------------------------------

-- When a shift is filled (by approving, or "Mark filled by" on the
-- Calendar): that doctor's application is approved, everyone else's
-- declined. Reopened or cancelled: an approved booking is cancelled and
-- waiting applications declined.
CREATE OR REPLACE FUNCTION district_notices_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.filled_by_doctor_id IS NOT DISTINCT FROM OLD.filled_by_doctor_id THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'filled' THEN
    UPDATE district_applications SET status = 'approved', decided_by = auth.uid(), decided_at = now()
    WHERE notice_id = NEW.notice_id AND doctor_id = NEW.filled_by_doctor_id AND status = 'pending';
    -- Booked without applying: an approved application all the same, so
    -- they're told and it shows as theirs.
    IF NEW.filled_by_doctor_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM district_applications
      WHERE notice_id = NEW.notice_id AND doctor_id = NEW.filled_by_doctor_id AND status = 'approved'
    ) THEN
      INSERT INTO district_applications (notice_id, doctor_id, status, note, decided_by, decided_at, officer_notified_at)
      VALUES (NEW.notice_id, NEW.filled_by_doctor_id, 'approved', 'Booked by an officer', auth.uid(), now(), now());
    END IF;
    UPDATE district_applications SET status = 'cancelled', decided_by = auth.uid(), decided_at = now()
    WHERE notice_id = NEW.notice_id AND doctor_id IS DISTINCT FROM NEW.filled_by_doctor_id AND status = 'approved';
    UPDATE district_applications
    SET status = 'declined', decline_reason = 'Filled by someone else', decided_by = auth.uid(), decided_at = now()
    WHERE notice_id = NEW.notice_id AND doctor_id IS DISTINCT FROM NEW.filled_by_doctor_id AND status = 'pending';
  ELSE
    UPDATE district_applications SET status = 'cancelled', decided_by = auth.uid(), decided_at = now()
    WHERE notice_id = NEW.notice_id AND status = 'approved';
    IF NEW.status = 'cancelled' THEN
      UPDATE district_applications
      SET status = 'declined', decline_reason = 'Shift cancelled', decided_by = auth.uid(), decided_at = now()
      WHERE notice_id = NEW.notice_id AND status = 'pending';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION district_notices_sync() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS district_notices_sync ON district_notices;
CREATE TRIGGER district_notices_sync
  AFTER UPDATE ON district_notices
  FOR EACH ROW EXECUTE FUNCTION district_notices_sync();

-- A status change queues the right person: the doctor for a decision, the
-- officers for a withdrawal. (A new application waits for the officers
-- because officer_notified_at starts empty.)
CREATE OR REPLACE FUNCTION district_applications_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status IN ('approved', 'declined', 'cancelled') THEN
      NEW.doctor_notified_at := NULL;
    ELSIF NEW.status = 'withdrawn' THEN
      NEW.officer_notified_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS district_applications_touch ON district_applications;
CREATE TRIGGER district_applications_touch
  BEFORE UPDATE ON district_applications
  FOR EACH ROW EXECUTE FUNCTION district_applications_touch();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE district_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE district_push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Doctors see their own applications; officers see their sites'.
DROP POLICY IF EXISTS "district_applications_select" ON district_applications;
CREATE POLICY "district_applications_select" ON district_applications
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM district_doctors d WHERE d.doctor_id = district_applications.doctor_id AND d.user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM district_notices n WHERE n.notice_id = district_applications.notice_id AND is_site_officer(n.site_id))
  );

REVOKE ALL ON district_applications FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON district_applications FROM authenticated;

DROP POLICY IF EXISTS "district_push_subscriptions_own" ON district_push_subscriptions;
CREATE POLICY "district_push_subscriptions_own" ON district_push_subscriptions
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

REVOKE ALL ON district_push_subscriptions FROM anon;

COMMIT;

-- ---------------------------------------------------------------------------
-- The timer (same pattern as roster-app's coffee-order)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'district_notify_secret') THEN
    PERFORM vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'district_notify_secret');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION district_notify_secret_ok(p_secret text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'district_notify_secret' AND decrypted_secret = p_secret);
$$;

REVOKE EXECUTE ON FUNCTION district_notify_secret_ok(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION district_notify_secret_ok(text) TO service_role;

-- Every 5 minutes, 6:00-21:55 Brisbane (UTC+10) = 20:00-11:55 UTC. 2026-10-27b_notify_rules.sql
-- changes this to every 30 minutes, 6:00-21:00.
-- Anything after 22:00 waits for the morning.
SELECT cron.schedule(
  'district-notify',
  '*/5 0-11,20-23 * * *',
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

-- To check it's running:
--   SELECT * FROM cron.job_run_details WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'district-notify') ORDER BY start_time DESC LIMIT 5;
--   SELECT status_code, content FROM net._http_response ORDER BY created DESC LIMIT 5;
-- To stop it:
--   SELECT cron.unschedule('district-notify');
