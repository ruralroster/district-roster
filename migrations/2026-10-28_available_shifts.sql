-- The same "can this doctor do it" rules as notifications, now also for
-- the Calendar's "Shifts for me" and for applying.
--
--   district_rest_problem()   why the doctor can't do the shift for rest
--                             ("Starts less than 10 hours after your
--                             Innisfail Hospital roster, 08:00-18:30 Mon 3
--                             Nov"), or NULL. Replaces district_rested's
--                             yes/no with a reason; same rules.
--   district_day_unavailable() they've marked the day (or the morning a
--                             night runs into) unavailable.
--   my_shift_availability()   for the signed-in doctor: each open shift
--                             in a date range their skills fit, whether
--                             it's at a site they'd work at, and the
--                             reason they can't do it (NULL if they can).
--   apply_for_notice()        now also refuses a shift they're not rested
--                             for, with the reason.
--
-- Run after 2026-10-27b_notify_rules.sql. Safe to re-run.

BEGIN;

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
    WHERE doc.user_id IS NOT NULL AND NOT a.on_call
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

CREATE OR REPLACE FUNCTION district_rested(p_doctor_id uuid, p_notice_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT district_rest_problem(p_doctor_id, p_notice_id) IS NULL;
$$;

CREATE OR REPLACE FUNCTION district_day_unavailable(p_doctor_id uuid, p_notice_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM district_unavailable_days u, district_notices n
    WHERE n.notice_id = p_notice_id AND u.doctor_id = p_doctor_id
      AND (u.date = n.shift_date
           -- a night that runs into a day they're unavailable
           OR (n.end_time < n.start_time AND n.end_time > time '00:00' AND u.date = n.shift_date + 1))
  );
$$;

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
    AND NOT district_day_unavailable(d.doctor_id, n.notice_id)
    AND district_rested(d.doctor_id, n.notice_id);
$$;

CREATE OR REPLACE FUNCTION my_shift_availability(p_district_id uuid, p_from date, p_to date)
RETURNS TABLE (notice_id uuid, interested boolean, problem text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT n.notice_id,
         n.site_id = ANY (d.interested_site_ids),
         CASE
           WHEN district_day_unavailable(d.doctor_id, n.notice_id) THEN 'You''ve marked this day unavailable'
           ELSE district_rest_problem(d.doctor_id, n.notice_id)
         END
  FROM district_notices n
  JOIN district_doctors d ON d.district_id = n.district_id AND d.user_id = auth.uid() AND d.active
  WHERE n.district_id = p_district_id
    AND n.status = 'open'
    AND n.shift_date BETWEEN p_from AND p_to
    AND n.required_skill = ANY (d.skills);
$$;

REVOKE EXECUTE ON FUNCTION district_rest_problem(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_rested(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_day_unavailable(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_notice_recipients(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION district_notice_recipients(uuid[]) TO service_role;
REVOKE EXECUTE ON FUNCTION my_shift_availability(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_shift_availability(uuid, date, date) TO authenticated;

-- Applying: as before, plus the rest rules.
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
  IF EXISTS (
    SELECT 1 FROM district_applications
    WHERE notice_id = p_notice_id AND doctor_id = v_doctor.doctor_id AND status IN ('pending', 'approved')
  ) THEN
    RAISE EXCEPTION 'You''ve already applied for this shift';
  END IF;
  v_problem := district_rest_problem(v_doctor.doctor_id, p_notice_id);
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
