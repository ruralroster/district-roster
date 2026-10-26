-- Working vs not working, from roster-app as well as DR Roster.
--
-- The doctor's Calendar shows two kinds of blocked day:
--
--   working      - rostered on a roster-app shift (not on-call, not
--                  leave): the 10-hour rest rules hide the shifts it rules
--                  out; ones it leaves room for (an evening after a short
--                  day) still show; or
--                - marked "working elsewhere" on roster-app's
--                  availability (roster-app's
--                  2026-10-29_availability_working_elsewhere.sql): the
--                  whole day is blocked.
--   unavailable  marked "I'm not available this day" in DR Roster: the
--                whole day is blocked.
--
-- A plain unavailable day on roster-app (leave, a day off) doesn't block
-- anything: someone on leave may want to pick up a district shift. The
-- day panel mentions it.
--
-- Whole-day blocks hide every shift that day, nobody's told about them,
-- and applying is refused.
--
-- Leave-coded roster-app shifts also stop counting as work for the rest
-- and clash checks (district_rest_problem, district_clash). The approval
-- clash check also stops counting on-call, matching the rest rules.
--
--   district_day_off(doctor, date)  why the whole day is blocked, or NULL
--   my_day_status(district, from, to)  for the signed-in doctor, each day
--                                      they're working, unavailable or on
--                                      leave
--
-- Run after 2026-10-28d_book_on_card.sql and roster-app's
-- 2026-10-29_availability_working_elsewhere.sql. Safe to re-run.

BEGIN;

-- Why the whole of p_date is blocked for the doctor, or NULL.
CREATE OR REPLACE FUNCTION district_day_off(p_doctor_id uuid, p_date date)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT reason FROM (
    SELECT 1 AS o, 'You''ve marked this day unavailable' AS reason
    FROM district_unavailable_days u
    WHERE u.doctor_id = p_doctor_id AND u.date = p_date
    UNION ALL
    SELECT 2, 'You''re working elsewhere this day (roster-app)'
    FROM district_doctors d
    JOIN staff st ON st.user_id = d.user_id
    JOIN staff_availability sa ON sa.staff_id = st.staff_id AND sa.date = p_date AND sa.working_elsewhere
    WHERE d.doctor_id = p_doctor_id AND d.user_id IS NOT NULL
  ) x
  ORDER BY o
  LIMIT 1;
$$;

-- Leave or a plain unavailable day on roster-app, which doesn't block
-- district shifts: for the day panel ("Annual Leave on roster-app").
CREATE OR REPLACE FUNCTION district_day_leave(p_doctor_id uuid, p_date date)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT reason FROM (
    SELECT 1 AS o, coalesce(lt.name, 'Unavailable') || ' on roster-app' AS reason
    FROM district_doctors d
    JOIN staff st ON st.user_id = d.user_id
    JOIN staff_availability sa ON sa.staff_id = st.staff_id AND sa.date = p_date
      AND sa.available = false AND NOT sa.working_elsewhere
    LEFT JOIN leave_types lt ON lt.leave_type_id = sa.leave_type_id
    WHERE d.doctor_id = p_doctor_id AND d.user_id IS NOT NULL
    UNION ALL
    SELECT 2, a.leave_code || ' on roster-app'
    FROM district_doctors d
    JOIN staff st ON st.user_id = d.user_id
    JOIN staff_assignments a ON a.staff_id = st.staff_id AND a.date = p_date AND a.leave_code IS NOT NULL
    WHERE d.doctor_id = p_doctor_id AND d.user_id IS NOT NULL
  ) x
  ORDER BY o
  LIMIT 1;
$$;

-- The shift's day (or the morning a night runs into) is a day off.
CREATE OR REPLACE FUNCTION district_day_unavailable(p_doctor_id uuid, p_notice_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM district_notices n
    WHERE n.notice_id = p_notice_id
      AND (district_day_off(p_doctor_id, n.shift_date) IS NOT NULL
           OR (n.end_time < n.start_time AND n.end_time > time '00:00'
               AND district_day_off(p_doctor_id, n.shift_date + 1) IS NOT NULL))
  );
$$;

-- The reason, for the Calendar and applying.
CREATE OR REPLACE FUNCTION district_day_unavailable_reason(p_doctor_id uuid, p_notice_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    district_day_off(p_doctor_id, n.shift_date),
    CASE WHEN n.end_time < n.start_time AND n.end_time > time '00:00'
         THEN district_day_off(p_doctor_id, n.shift_date + 1) || ' (the morning this night runs into)' END)
  FROM district_notices n WHERE n.notice_id = p_notice_id;
$$;

-- As in 2026-10-28_available_shifts.sql, without leave-coded shifts.
CREATE OR REPLACE FUNCTION district_rest_problem(p_doctor_id uuid, p_notice_id uuid)
RETURNS text
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
           n.site_id IS NOT DISTINCT FROM doc.home_site_id AS primary_site,
           format('your %s %s shift, %s-%s %s', s.name, coalesce(n.title, ''), to_char(n.start_time, 'HH24:MI'),
                  to_char(n.end_time, 'HH24:MI'), to_char(n.shift_date, 'Dy FMDD Mon')) AS what
    FROM district_notices n
    JOIN sites s ON s.site_id = n.site_id, doc, t
    WHERE n.filled_by_doctor_id = p_doctor_id AND n.status = 'filled' AND n.notice_id <> p_notice_id
      AND n.shift_date BETWEEN t.shift_date - 2 AND t.shift_date + 2
    UNION ALL
    SELECT district_shift_range(a.date, sh.start_time, sh.end_time), true,
           format('your %s roster, %s-%s %s', d.name, to_char(sh.start_time, 'HH24:MI'),
                  to_char(sh.end_time, 'HH24:MI'), to_char(a.date, 'Dy FMDD Mon'))
    FROM doc
    JOIN staff st ON st.user_id = doc.user_id
    JOIN staff_assignments a ON a.staff_id = st.staff_id
    JOIN shifts sh ON sh.shift_id = a.shift_id
    JOIN departments d ON d.department_id = a.department_id, t
    WHERE doc.user_id IS NOT NULL AND NOT a.on_call AND a.leave_code IS NULL
      AND a.date BETWEEN t.shift_date - 2 AND t.shift_date + 2
  )
  SELECT CASE
           WHEN busy.r && t.r THEN 'Clashes with ' || replace(busy.what, '  ', ' ')
           WHEN lower(t.r) >= upper(busy.r) AND lower(t.r) < upper(busy.r) + interval '10 hours'
             THEN 'Starts less than 10 hours after ' || replace(busy.what, '  ', ' ')
           ELSE 'Finishes less than 10 hours before ' || replace(busy.what, '  ', ' ')
         END
  FROM busy, t
  WHERE busy.r && t.r
     OR (lower(t.r) >= upper(busy.r) AND lower(t.r) < upper(busy.r) + interval '10 hours')
     OR (busy.primary_site AND lower(busy.r) >= upper(t.r) AND lower(busy.r) < upper(t.r) + interval '10 hours')
  ORDER BY lower(busy.r)
  LIMIT 1;
$$;

-- As in 2026-10-27_applications_notifications.sql, without on-call or
-- leave-coded roster-app shifts.
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
    WHERE doc.user_id IS NOT NULL AND NOT a.on_call AND a.leave_code IS NULL
      AND a.date BETWEEN t.shift_date - 1 AND t.shift_date + 1
      AND district_shift_range(a.date, sh.start_time, sh.end_time) && t.r
  ) clashes
  LIMIT 1;
$$;

-- As in 2026-10-28d_book_on_card.sql, with the day-off reason.
CREATE OR REPLACE FUNCTION my_shift_availability(p_district_id uuid, p_from date, p_to date)
RETURNS TABLE (notice_id uuid, interested boolean, problem text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT n.notice_id,
         n.site_id = ANY (d.interested_site_ids),
         coalesce(district_day_unavailable_reason(d.doctor_id, n.notice_id), district_rest_problem(d.doctor_id, n.notice_id))
  FROM district_notices n
  JOIN district_doctors d ON d.district_id = n.district_id AND d.user_id = auth.uid() AND d.active
  WHERE n.district_id = p_district_id
    AND n.status = 'open'
    AND n.shift_date BETWEEN p_from AND p_to
    AND n.required_skill = ANY (d.skills)
    AND district_level_rank(d.level) >= district_level_rank(n.position);
$$;

-- For the signed-in doctor, each day in the range that's:
--   working  rostered on roster-app ("Innisfail Hospital 08:00-18:30") or
--            marked working elsewhere there
--   off      blocked in DR Roster ("You've marked this day unavailable")
--   on_leave leave or unavailable on roster-app, which doesn't block
DROP FUNCTION IF EXISTS my_day_status(uuid, date, date);
CREATE OR REPLACE FUNCTION my_day_status(p_district_id uuid, p_from date, p_to date)
RETURNS TABLE (day date, working text, off text, on_leave text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH doc AS (
    SELECT doctor_id, user_id FROM district_doctors
    WHERE district_id = p_district_id AND user_id = auth.uid() AND active
  ),
  days AS (
    SELECT g::date AS day FROM generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g
  ),
  work AS (
    SELECT a.date AS day,
           string_agg(DISTINCT format('%s %s-%s', dep.name, to_char(sh.start_time, 'HH24:MI'), to_char(sh.end_time, 'HH24:MI')), ', ') AS working
    FROM doc
    JOIN staff st ON st.user_id = doc.user_id
    JOIN staff_assignments a ON a.staff_id = st.staff_id
    JOIN shifts sh ON sh.shift_id = a.shift_id
    JOIN departments dep ON dep.department_id = a.department_id
    WHERE doc.user_id IS NOT NULL AND NOT a.on_call AND a.leave_code IS NULL
      AND a.date BETWEEN p_from AND p_to
    GROUP BY a.date
  )
  , status AS (
    SELECT days.day AS d, work.working AS w,
           district_day_off(doc.doctor_id, days.day) AS blocked,
           district_day_leave(doc.doctor_id, days.day) AS away
    FROM days CROSS JOIN doc
    LEFT JOIN work ON work.day = days.day
  )
  SELECT st.d,
         coalesce(st.w, CASE WHEN st.blocked LIKE 'You''re working elsewhere%' THEN 'Working elsewhere (marked on roster-app)' END),
         CASE WHEN st.blocked NOT LIKE 'You''re working elsewhere%' THEN st.blocked END,
         st.away
  FROM status st
  WHERE st.w IS NOT NULL OR st.blocked IS NOT NULL OR st.away IS NOT NULL;
$$;

REVOKE EXECUTE ON FUNCTION district_day_off(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_day_leave(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_day_unavailable(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_day_unavailable_reason(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_rest_problem(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_clash(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION my_shift_availability(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_shift_availability(uuid, date, date) TO authenticated;
REVOKE EXECUTE ON FUNCTION my_day_status(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_day_status(uuid, date, date) TO authenticated;

-- Applying: as in 2026-10-28d_book_on_card.sql, plus days off.
CREATE OR REPLACE FUNCTION apply_for_notice(p_notice_id uuid, p_note text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_notice district_notices%ROWTYPE;
  v_doctor district_doctors%ROWTYPE;
  v_problem text;
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
  IF district_level_rank(v_doctor.level) < district_level_rank(v_notice.position) THEN
    RAISE EXCEPTION 'This is a % shift, above the level on your profile', replace(v_notice.position, 'rmo', 'RMO');
  END IF;
  IF EXISTS (
    SELECT 1 FROM district_applications
    WHERE notice_id = p_notice_id AND doctor_id = v_doctor.doctor_id AND status IN ('pending', 'approved')
  ) THEN
    RAISE EXCEPTION 'You''ve already applied for this shift';
  END IF;
  v_problem := coalesce(district_day_unavailable_reason(v_doctor.doctor_id, p_notice_id),
                        district_rest_problem(v_doctor.doctor_id, p_notice_id));
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problem;
  END IF;

  INSERT INTO district_applications (notice_id, doctor_id, note)
  VALUES (p_notice_id, v_doctor.doctor_id, nullif(trim(p_note), ''))
  RETURNING application_id INTO v_id;
  RETURN v_id;
END;
$$;

COMMIT;
