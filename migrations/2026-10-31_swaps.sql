-- The swap marketplace (step 3): v3's flow, for DR Roster shifts and for
-- roster-app shifts alike.
--
-- 1. A doctor lists a shift they're booked on: a DR Roster shift (Swaps
--    tab), or a roster-app shift (from roster-app's Variation tab, for
--    anyone who's in both; the marketplace itself is only in DR Roster).
--    They say whether missing it would disrupt the service, and which days
--    and nights of that pay fortnight they could work in return. It's on
--    the marketplace straight away; the officer isn't told yet. Until a
--    swap is approved the doctor still works the shift.
-- 2. Doctors who could do the shift either take it outright, or offer one
--    of their own shifts at the same site, on one of those days or nights,
--    in return: so the swap stays inside the pay fortnight. The rest and
--    clash rules are checked for both doctors, each as if they'd already
--    given up their own shift.
-- 3. That pairing is what goes to the site's officer, who approves the
--    swap (or declines it, with a reason). Only then do the bookings move.
--    A roster-app shift goes to the new doctor on roster-app: their own
--    booking if they're staff there, otherwise a visitor marked From DR
--    Roster on the card.
--
-- A roster-app shift is represented here by a hidden DR Roster shift
-- (source 'roster_shift', linked in district_roster_shifts), created when
-- it's listed or offered. It never shows on calendars and never counts
-- twice in the rest rules: the roster-app booking itself is what counts.
--
--   district_swap_listings   open → taken; or withdrawn (by the doctor),
--                            removed (taken down by an officer), closed
--                            (the shift changed)
--   district_swap_offers     take it (offered_notice_id NULL) or swap
--   district_swap_messages   who to tell what; district-notify sends them
--
-- Everything goes through the functions below; the tables are read-only
-- from the apps.
--
-- Run after 2026-10-29_day_status.sql. Safe to re-run.

BEGIN;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

ALTER TABLE district_notices DROP CONSTRAINT IF EXISTS district_notices_source_check;
ALTER TABLE district_notices ADD CONSTRAINT district_notices_source_check
  CHECK (source IN ('officer', 'roster_app', 'v3', 'roster_shift'));

-- A roster-app shift in the marketplace. It can be several
-- staff_assignments rows (one per session card), all the same person,
-- date, shift and location: the "siblings" moved together.
CREATE TABLE IF NOT EXISTS district_roster_shifts (
  notice_id uuid PRIMARY KEY REFERENCES district_notices(notice_id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL,
  department_id uuid NOT NULL,
  staff_id uuid,
  date date NOT NULL,
  shift_id uuid,
  location_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS district_roster_shifts_assignment_idx ON district_roster_shifts (assignment_id);
CREATE INDEX IF NOT EXISTS district_roster_shifts_key_idx ON district_roster_shifts (staff_id, date);
ALTER TABLE district_roster_shifts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON district_roster_shifts FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS district_swap_listings (
  listing_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(district_id) ON DELETE CASCADE,
  notice_id uuid NOT NULL REFERENCES district_notices(notice_id) ON DELETE CASCADE,
  doctor_id uuid NOT NULL REFERENCES district_doctors(doctor_id) ON DELETE CASCADE,
  service_disruption boolean NOT NULL DEFAULT false,
  -- 'YYYY-MM-DD:day' / 'YYYY-MM-DD:night', within the shift's pay fortnight.
  available_slots text[] NOT NULL DEFAULT '{}',
  note text,
  status text NOT NULL DEFAULT 'open',
  closed_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CONSTRAINT district_swap_listings_status_check CHECK (status IN ('open', 'taken', 'withdrawn', 'removed', 'closed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS district_swap_listings_open_idx ON district_swap_listings (notice_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS district_swap_listings_district_idx ON district_swap_listings (district_id, status);

CREATE TABLE IF NOT EXISTS district_swap_offers (
  offer_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES district_swap_listings(listing_id) ON DELETE CASCADE,
  doctor_id uuid NOT NULL REFERENCES district_doctors(doctor_id) ON DELETE CASCADE,
  -- Their shift in return; NULL to take the listed shift outright.
  offered_notice_id uuid REFERENCES district_notices(notice_id) ON DELETE CASCADE,
  note text,
  status text NOT NULL DEFAULT 'pending',
  decline_reason text,
  decided_by uuid REFERENCES profiles(user_id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT district_swap_offers_status_check CHECK (status IN ('pending', 'approved', 'declined', 'withdrawn', 'cancelled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS district_swap_offers_live_idx ON district_swap_offers (listing_id, doctor_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS district_swap_messages (
  message_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  line text NOT NULL,
  push_title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS district_swap_messages_unsent_idx ON district_swap_messages (created_at) WHERE sent_at IS NULL;

ALTER TABLE district_swap_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE district_swap_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE district_swap_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON district_swap_messages FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON district_swap_listings FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON district_swap_offers FROM anon, authenticated;

-- Listings: anyone in the district can see them (it's a noticeboard).
DROP POLICY IF EXISTS "district_swap_listings_select_member" ON district_swap_listings;
CREATE POLICY "district_swap_listings_select_member" ON district_swap_listings
  FOR SELECT TO authenticated USING (is_district_member(district_id));

-- Offers: the doctor offering, the doctor who listed, and the site's officers.
CREATE OR REPLACE FUNCTION district_can_see_swap_offer(p_listing_id uuid, p_doctor_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM district_doctors WHERE doctor_id = p_doctor_id AND user_id = auth.uid())
      OR EXISTS (
        SELECT 1 FROM district_swap_listings l
        JOIN district_doctors d ON d.doctor_id = l.doctor_id
        JOIN district_notices n ON n.notice_id = l.notice_id
        WHERE l.listing_id = p_listing_id AND (d.user_id = auth.uid() OR is_site_officer(n.site_id))
      );
$$;
REVOKE EXECUTE ON FUNCTION district_can_see_swap_offer(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION district_can_see_swap_offer(uuid, uuid) TO authenticated;

DROP POLICY IF EXISTS "district_swap_offers_select_involved" ON district_swap_offers;
CREATE POLICY "district_swap_offers_select_involved" ON district_swap_offers
  FOR SELECT TO authenticated USING (district_can_see_swap_offer(listing_id, doctor_id));

-- ---------------------------------------------------------------------------
-- The rules, for any shift (by its times), with what's being given up
-- ---------------------------------------------------------------------------

-- The rest/clash rule for p_doctor working p_date p_start-p_end, as if
-- they'd given up p_except_notice (a DR Roster shift, or the hidden one for
-- a roster-app shift) and/or p_except_assignment (a roster-app shift).
-- p_skip_notice is the shift being checked itself. Hidden roster-shift
-- entries never count: the roster-app booking does.
CREATE OR REPLACE FUNCTION district_rest_problem_at(
  p_doctor_id uuid, p_date date, p_start time, p_end time,
  p_skip_notice uuid, p_except_notice uuid, p_except_assignment uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH t AS (
    SELECT district_shift_range(p_date, p_start, p_end) AS r, p_date AS shift_date
  ),
  doc AS (
    SELECT user_id, home_site_id FROM district_doctors WHERE doctor_id = p_doctor_id
  ),
  -- The roster-app rows given up: the except assignment's, and the one
  -- behind the except notice, with all their siblings.
  given_up AS (
    SELECT x.staff_id, x.date, x.shift_id FROM staff_assignments x
    WHERE x.assignment_id = p_except_assignment
       OR x.assignment_id = (SELECT assignment_id FROM district_roster_shifts WHERE notice_id = p_except_notice)
  ),
  busy AS (
    SELECT district_shift_range(n.shift_date, n.start_time, n.end_time) AS r,
           n.site_id IS NOT DISTINCT FROM doc.home_site_id AS primary_site,
           format('your %s %s shift, %s-%s %s', s.name, coalesce(n.title, ''), to_char(n.start_time, 'HH24:MI'),
                  to_char(n.end_time, 'HH24:MI'), to_char(n.shift_date, 'Dy FMDD Mon')) AS what
    FROM district_notices n
    JOIN sites s ON s.site_id = n.site_id, doc, t
    WHERE n.filled_by_doctor_id = p_doctor_id AND n.status = 'filled' AND n.source <> 'roster_shift'
      AND n.notice_id IS DISTINCT FROM p_skip_notice
      AND n.notice_id IS DISTINCT FROM p_except_notice
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
      AND NOT EXISTS (SELECT 1 FROM given_up g WHERE g.staff_id = a.staff_id AND g.date = a.date AND g.shift_id IS NOT DISTINCT FROM a.shift_id)
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

-- As before (2026-10-29_day_status.sql), now via district_rest_problem_at.
CREATE OR REPLACE FUNCTION district_rest_problem(p_doctor_id uuid, p_notice_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT district_rest_problem_at(p_doctor_id, n.shift_date, n.start_time, n.end_time, n.notice_id, NULL, NULL)
  FROM district_notices n WHERE n.notice_id = p_notice_id;
$$;

-- A blocked day by date (DR Roster's own unavailable days, roster-app
-- "working elsewhere"), including the morning a night runs into.
CREATE OR REPLACE FUNCTION district_day_problem_at(p_doctor_id uuid, p_date date, p_start time, p_end time)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    district_day_off(p_doctor_id, p_date),
    CASE WHEN p_end < p_start AND p_end > time '00:00'
         THEN district_day_off(p_doctor_id, p_date + 1) || ' (the morning this night runs into)' END);
$$;

-- Why p_doctor couldn't work a shift (level, skill, a blocked day, rest),
-- giving up the except shift(s), or NULL. Sites they'd work at aren't
-- checked: a swap is between two people who've chosen it.
CREATE OR REPLACE FUNCTION district_swap_problem_at(
  p_doctor_id uuid, p_date date, p_start time, p_end time, p_position text, p_skill text,
  p_skip_notice uuid, p_except_notice uuid, p_except_assignment uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN district_level_rank(d.level) < district_level_rank(p_position)
      THEN format('It''s a %s shift, above %s''s level', replace(p_position, 'rmo', 'RMO'), d.name)
    WHEN NOT p_skill = ANY (d.skills)
      THEN format('It needs %s, which %s doesn''t have', p_skill, d.name)
    ELSE coalesce(district_day_problem_at(d.doctor_id, p_date, p_start, p_end),
                  district_rest_problem_at(d.doctor_id, p_date, p_start, p_end, p_skip_notice, p_except_notice, p_except_assignment))
  END
  FROM district_doctors d WHERE d.doctor_id = p_doctor_id;
$$;

CREATE OR REPLACE FUNCTION district_swap_problem(p_doctor_id uuid, p_notice_id uuid, p_except uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT district_swap_problem_at(p_doctor_id, n.shift_date, n.start_time, n.end_time, n.position, n.required_skill,
                                  n.notice_id, p_except, NULL)
  FROM district_notices n WHERE n.notice_id = p_notice_id;
$$;

-- A roster-app shift in DR Roster terms: its site (in the doctor's
-- district), the person's own hours (their shift), level and skill (a
-- consultant needs the card's consultant skill), and a title.
CREATE OR REPLACE FUNCTION district_assignment_facts(p_assignment_id uuid, p_district_id uuid)
RETURNS TABLE (site_id uuid, date date, start_time time, end_time time, shift_position text, skill text, title text,
               staff_id uuid, shift_id uuid, location_id uuid, department_id uuid, user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.site_id, a.date, sh.start_time, sh.end_time,
         CASE WHEN a.role = 'consultant' THEN 'consultant' ELSE 'registrar' END,
         CASE WHEN a.role = 'consultant' AND a.theatre_activity_id IS NOT NULL
              THEN district_skill_for(district_consultant_skill_ids(a.theatre_activity_id)) ELSE 'Emergency' END,
         coalesce(jt.name, act.name, l.name, sh.name),
         a.staff_id, a.shift_id, a.location_id, a.department_id, st.user_id
  FROM staff_assignments a
  JOIN staff st ON st.staff_id = a.staff_id
  JOIN shifts sh ON sh.shift_id = a.shift_id
  JOIN sites s ON s.department_id = a.department_id AND s.district_id = p_district_id
  LEFT JOIN theatre_activities ta ON ta.theatre_activity_id = a.theatre_activity_id
  LEFT JOIN job_types jt ON jt.job_type_id = ta.job_type_id
  LEFT JOIN activity_types act ON act.activity_id = ta.activity_id
  LEFT JOIN locations l ON l.location_id = a.location_id
  WHERE a.assignment_id = p_assignment_id AND NOT a.on_call AND a.leave_code IS NULL
  LIMIT 1;
$$;

-- 'night' for a shift that runs past midnight or starts from 18:00.
CREATE OR REPLACE FUNCTION district_shift_kind(p_start time, p_end time)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN p_end <= p_start OR p_start >= time '18:00' THEN 'night' ELSE 'day' END;
$$;

-- The Monday a pay fortnight starts (fortnights from Mon 25 May 2026, as v3).
CREATE OR REPLACE FUNCTION district_fortnight_start(p_date date)
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT date '2026-05-25' + (floor((p_date - date '2026-05-25') / 14.0) * 14)::int;
$$;

-- "Mon 3 Nov · Innisfail · ED Day 08:00-18:00"
CREATE OR REPLACE FUNCTION district_shift_text(p_notice_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT format('%s · %s · %s%s-%s', to_char(n.shift_date, 'Dy FMDD Mon'), s.name,
                coalesce(n.title || ' ', ''), to_char(n.start_time, 'HH24:MI'), to_char(n.end_time, 'HH24:MI'))
  FROM district_notices n JOIN sites s ON s.site_id = n.site_id
  WHERE n.notice_id = p_notice_id;
$$;

-- The hidden DR Roster shift for a doctor's roster-app shift, made the
-- first time it's listed or offered.
CREATE OR REPLACE FUNCTION district_mirror_assignment(p_assignment_id uuid, p_doctor_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doc district_doctors%ROWTYPE;
  v_f record;
  v_id uuid;
BEGIN
  SELECT * INTO v_doc FROM district_doctors WHERE doctor_id = p_doctor_id;
  SELECT * INTO v_f FROM district_assignment_facts(p_assignment_id, v_doc.district_id);
  IF v_f IS NULL OR v_f.site_id IS NULL THEN
    RAISE EXCEPTION 'That roster-app shift can''t be swapped here (on-call, leave, or a department not linked to a DR Roster site)';
  END IF;
  IF v_f.user_id IS DISTINCT FROM v_doc.user_id THEN
    RAISE EXCEPTION 'That roster-app shift isn''t yours';
  END IF;
  IF v_f.date < (now() AT TIME ZONE 'Australia/Brisbane')::date THEN
    RAISE EXCEPTION 'That shift is in the past';
  END IF;

  -- Already made for this shift (any of its sibling rows), still theirs.
  SELECT rs.notice_id INTO v_id
  FROM district_roster_shifts rs JOIN district_notices n ON n.notice_id = rs.notice_id
  WHERE rs.staff_id = v_f.staff_id AND rs.date = v_f.date AND rs.shift_id IS NOT DISTINCT FROM v_f.shift_id
    AND rs.location_id IS NOT DISTINCT FROM v_f.location_id
    AND n.status = 'filled' AND n.filled_by_doctor_id = p_doctor_id
  LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  INSERT INTO district_notices (site_id, shift_date, start_time, end_time, required_skill, position, title, notes,
                                source, status, filled_by_doctor_id, notified_at)
  VALUES (v_f.site_id, v_f.date, v_f.start_time, v_f.end_time, v_f.skill, v_f.shift_position, v_f.title, 'roster-app shift',
          'roster_shift', 'filled', p_doctor_id, now())
  RETURNING notice_id INTO v_id;
  INSERT INTO district_roster_shifts (notice_id, assignment_id, department_id, staff_id, date, shift_id, location_id)
  VALUES (v_id, p_assignment_id, v_f.department_id, v_f.staff_id, v_f.date, v_f.shift_id, v_f.location_id);
  RETURN v_id;
END;
$$;

-- Moves a roster-app shift (all its sibling rows) to another doctor:
-- their own booking if they're staff in that department, otherwise a
-- visitor marked From DR Roster on each card.
CREATE OR REPLACE FUNCTION district_move_roster_shift(p_notice_id uuid, p_to_doctor_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link district_roster_shifts%ROWTYPE;
  v_doc district_doctors%ROWTYPE;
  v_to_staff uuid;
  v_row record;
  v_count int;
BEGIN
  SELECT * INTO v_link FROM district_roster_shifts WHERE notice_id = p_notice_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT * INTO v_doc FROM district_doctors WHERE doctor_id = p_to_doctor_id;
  SELECT count(*) INTO v_count FROM staff_assignments a
  WHERE a.staff_id = v_link.staff_id AND a.date = v_link.date AND a.shift_id IS NOT DISTINCT FROM v_link.shift_id
    AND a.location_id IS NOT DISTINCT FROM v_link.location_id;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'The roster-app shift on % has changed since it was offered', to_char(v_link.date, 'Dy FMDD Mon');
  END IF;

  SELECT staff_id INTO v_to_staff FROM staff
  WHERE user_id = v_doc.user_id AND department_id = v_link.department_id AND active AND v_doc.user_id IS NOT NULL
  LIMIT 1;

  IF v_to_staff IS NOT NULL THEN
    UPDATE staff_assignments a SET staff_id = v_to_staff, fatigue_override_reason = NULL
    WHERE a.staff_id = v_link.staff_id AND a.date = v_link.date AND a.shift_id IS NOT DISTINCT FROM v_link.shift_id
      AND a.location_id IS NOT DISTINCT FROM v_link.location_id;
  ELSE
    FOR v_row IN
      SELECT * FROM staff_assignments a
      WHERE a.staff_id = v_link.staff_id AND a.date = v_link.date AND a.shift_id IS NOT DISTINCT FROM v_link.shift_id
        AND a.location_id IS NOT DISTINCT FROM v_link.location_id
    LOOP
      IF v_row.theatre_activity_id IS NULL THEN
        RAISE EXCEPTION '% isn''t staff in that department, and the roster-app shift isn''t on a card they could be added to', v_doc.name;
      END IF;
      DELETE FROM staff_assignments WHERE assignment_id = v_row.assignment_id;
      INSERT INTO theatre_activity_visitors (department_id, theatre_activity_id, place_id, slot, name, role, source)
      VALUES (v_row.department_id, v_row.theatre_activity_id, NULL, 0, v_doc.name, v_row.role, 'dr_roster');
    END LOOP;
  END IF;
  UPDATE district_roster_shifts SET staff_id = v_to_staff WHERE notice_id = p_notice_id;
END;
$$;

CREATE OR REPLACE FUNCTION district_swap_tell_doctor(p_doctor_id uuid, p_line text, p_title text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO district_swap_messages (user_id, line, push_title)
  SELECT user_id, p_line, p_title FROM district_doctors WHERE doctor_id = p_doctor_id AND user_id IS NOT NULL;
$$;

-- The site's officers: its own, and the linked roster-app department's.
CREATE OR REPLACE FUNCTION district_swap_tell_officers(p_site_id uuid, p_line text, p_title text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO district_swap_messages (user_id, line, push_title)
  SELECT DISTINCT user_id, p_line, p_title FROM (
    SELECT user_id FROM site_officers WHERE site_id = p_site_id
    UNION
    SELECT st.user_id FROM sites s JOIN staff st ON st.department_id = s.department_id
    WHERE s.site_id = p_site_id AND st.role = 'officer' AND st.active AND st.user_id IS NOT NULL
  ) o;
$$;

-- Pending offers on a listing that's no longer open.
CREATE OR REPLACE FUNCTION district_swap_cancel_offers(p_listing_id uuid, p_reason text, p_except uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_offer record;
BEGIN
  FOR v_offer IN
    UPDATE district_swap_offers SET status = 'cancelled', decline_reason = p_reason, decided_at = now()
    WHERE listing_id = p_listing_id AND status = 'pending' AND offer_id IS DISTINCT FROM p_except
    RETURNING doctor_id, listing_id
  LOOP
    PERFORM district_swap_tell_doctor(v_offer.doctor_id,
      format('Swap offer closed (%s): %s', p_reason,
             district_shift_text((SELECT notice_id FROM district_swap_listings WHERE listing_id = v_offer.listing_id))),
      'Swap offer closed');
  END LOOP;
END;
$$;

-- A listing (or its offers) whose shift has changed some other way.
CREATE OR REPLACE FUNCTION district_swap_shift_changed(p_notice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
BEGIN
  FOR v_row IN
    UPDATE district_swap_listings SET status = 'closed', closed_reason = 'The shift changed', closed_at = now()
    WHERE notice_id = p_notice_id AND status = 'open'
    RETURNING listing_id, doctor_id
  LOOP
    PERFORM district_swap_cancel_offers(v_row.listing_id, 'the shift changed');
    PERFORM district_swap_tell_doctor(v_row.doctor_id,
      format('Your swap listing has closed because the shift changed: %s', district_shift_text(p_notice_id)),
      'Swap listing closed');
  END LOOP;
  -- A shift someone offered in return: just that offer goes.
  FOR v_row IN
    UPDATE district_swap_offers o
    SET status = 'cancelled', decline_reason = 'the shift you offered changed', decided_at = now()
    WHERE o.offered_notice_id = p_notice_id AND o.status = 'pending'
    RETURNING o.listing_id, o.doctor_id
  LOOP
    PERFORM district_swap_tell_doctor(v_row.doctor_id,
      format('Swap offer closed (the shift you offered changed): %s',
             district_shift_text((SELECT notice_id FROM district_swap_listings WHERE listing_id = v_row.listing_id))),
      'Swap offer closed');
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION district_rest_problem_at(uuid, date, time, time, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_rest_problem(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_day_problem_at(uuid, date, time, time) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_swap_problem_at(uuid, date, time, time, text, text, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_swap_problem(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_assignment_facts(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_shift_text(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_mirror_assignment(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_move_roster_shift(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_swap_tell_doctor(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_swap_tell_officers(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_swap_cancel_offers(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_swap_shift_changed(uuid) FROM PUBLIC, anon, authenticated;

-- Hidden roster-shift entries don't clash with anything: the roster-app
-- booking does (as in 2026-10-29_day_status.sql otherwise).
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
      AND n.source <> 'roster_shift'
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
REVOKE EXECUTE ON FUNCTION district_clash(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Hidden roster-shift entries are never matched to a roster-app offer
-- (as in 2026-10-28d_book_on_card.sql otherwise).
CREATE OR REPLACE FUNCTION district_escalate_offers()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
  v_notice_id uuid;
  v_linked int := 0;
  v_escalated int := 0;
  v_cancelled int := 0;
  v_offers_removed int := 0;
BEGIN
  -- 0. Already posted in DR Roster (same site, date and hours): link the
  --    offer to that shift instead of posting it again.
  FOR v_row IN
    SELECT DISTINCT ON (o.volunteer_offer_id)
           o.volunteer_offer_id, o.theatre_activity_id, o.role, n.notice_id, n.status, n.filled_by_doctor_id
    FROM volunteer_offers o
    JOIN theatre_activities ta ON ta.theatre_activity_id = o.theatre_activity_id
    JOIN sites s ON s.department_id = o.department_id
    LEFT JOIN shifts sh ON sh.shift_id = ta.shift_id
    JOIN district_notices n
      ON n.site_id = s.site_id AND n.shift_date = ta.date
     AND n.start_time = coalesce(ta.start_time, sh.start_time)
     AND n.end_time = coalesce(ta.end_time, sh.end_time)
     AND n.status IN ('open', 'filled')
     AND n.source NOT IN ('roster_app', 'roster_shift')
     -- Same level: a consultant offer for a consultant shift, a registrar
     -- offer for anything below a consultant shift.
     AND (n.position = 'consultant') = (o.role = 'consultant')
    WHERE NOT EXISTS (SELECT 1 FROM district_escalations e WHERE e.volunteer_offer_id = o.volunteer_offer_id)
      AND NOT EXISTS (SELECT 1 FROM district_escalations e WHERE e.notice_id = n.notice_id)
      AND NOT district_offer_filled(o.volunteer_offer_id)
    ORDER BY o.volunteer_offer_id, n.created_at
  LOOP
    -- Two offers on one card can match the same shift; the first wins.
    CONTINUE WHEN EXISTS (SELECT 1 FROM district_escalations e WHERE e.notice_id = v_row.notice_id);
    INSERT INTO district_escalations (volunteer_offer_id, theatre_activity_id, role, notice_id)
    VALUES (v_row.volunteer_offer_id, v_row.theatre_activity_id, v_row.role, v_row.notice_id);
    IF v_row.status = 'filled' AND v_row.filled_by_doctor_id IS NOT NULL THEN
      UPDATE district_notices
      SET notes = concat_ws(' · ', district_strip_card_note(notes), district_book_on_card(v_row.notice_id, v_row.filled_by_doctor_id))
      WHERE notice_id = v_row.notice_id;
    END IF;
    v_linked := v_linked + 1;
  END LOOP;

  -- 1. Taken locally or withdrawn on roster-app: cancel the open district shift.
  FOR v_row IN
    SELECT e.volunteer_offer_id, e.notice_id
    FROM district_escalations e
    JOIN district_notices n ON n.notice_id = e.notice_id
    WHERE n.status = 'open'
      AND (NOT EXISTS (SELECT 1 FROM volunteer_offers o WHERE o.volunteer_offer_id = e.volunteer_offer_id)
           OR district_offer_filled(e.volunteer_offer_id))
  LOOP
    UPDATE district_notices
    SET status = 'cancelled', notes = concat_ws(' · ', notes, 'Covered or withdrawn on roster-app')
    WHERE notice_id = v_row.notice_id;
    v_cancelled := v_cancelled + 1;
  END LOOP;

  -- 2. Filled in DR Roster: take the offer off roster-app (booking does
  --    this already; kept for anything filled before it existed).
  DELETE FROM volunteer_offers o
  USING district_escalations e, district_notices n
  WHERE o.volunteer_offer_id = e.volunteer_offer_id
    AND n.notice_id = e.notice_id AND n.status = 'filled';
  GET DIAGNOSTICS v_offers_removed = ROW_COUNT;

  -- 3. New: offers past their site's local time, or starting within it.
  FOR v_row IN
    WITH offers AS (
      SELECT o.volunteer_offer_id, o.theatre_activity_id, o.role, o.created_at, ta.date,
             coalesce(ta.start_time, sh.start_time) AS start_time,
             coalesce(ta.end_time, sh.end_time) AS end_time,
             ta.required_grade,
             coalesce(jt.name, act.name, l.name) AS job,
             act.required_advanced_skills, o.department_id,
             s.site_id, s.escalate_after_hours
      FROM volunteer_offers o
      JOIN theatre_activities ta ON ta.theatre_activity_id = o.theatre_activity_id
      JOIN sites s ON s.department_id = o.department_id
      LEFT JOIN shifts sh ON sh.shift_id = ta.shift_id
      LEFT JOIN activity_types act ON act.activity_id = ta.activity_id
      LEFT JOIN locations l ON l.location_id = ta.location_id
      LEFT JOIN job_types jt ON jt.job_type_id = ta.job_type_id
      WHERE NOT EXISTS (SELECT 1 FROM district_escalations e WHERE e.volunteer_offer_id = o.volunteer_offer_id)
    )
    SELECT offers.*,
           -- A consultant needs the card's consultant skill; registrars and
           -- below are open to any doctor.
           CASE WHEN offers.role = 'consultant'
                THEN district_skill_for(district_consultant_skill_ids(offers.theatre_activity_id))
                ELSE 'Emergency' END AS skill,
           CASE WHEN offers.role = 'consultant' THEN 'consultant'
                WHEN offers.required_grade = 'intern' THEN 'intern'
                ELSE 'registrar' END AS position
    FROM offers
    WHERE offers.start_time IS NOT NULL AND offers.end_time IS NOT NULL
      AND ((offers.date + offers.start_time) AT TIME ZONE 'Australia/Brisbane') > now()
      AND NOT district_offer_filled(offers.volunteer_offer_id)
      AND (now() >= offers.created_at + make_interval(hours => offers.escalate_after_hours)
           OR ((offers.date + offers.start_time) AT TIME ZONE 'Australia/Brisbane') <= now() + make_interval(hours => offers.escalate_after_hours))
  LOOP
    INSERT INTO district_notices (site_id, shift_date, start_time, end_time, required_skill, position, title, notes, source)
    VALUES (
      v_row.site_id, v_row.date, v_row.start_time, v_row.end_time, v_row.skill, v_row.position,
      format('%s (%s)', v_row.job, initcap(v_row.position)),
      concat_ws(' · ', 'Not filled locally', CASE v_row.required_grade WHEN 'smo' THEN 'Needs an SMO' WHEN 'registrar' THEN 'Registrar or above' END),
      'roster_app'
    )
    RETURNING notice_id INTO v_notice_id;
    INSERT INTO district_escalations (volunteer_offer_id, theatre_activity_id, role, notice_id)
    VALUES (v_row.volunteer_offer_id, v_row.theatre_activity_id, v_row.role, v_notice_id);
    v_escalated := v_escalated + 1;
  END LOOP;

  RETURN jsonb_build_object('linked', v_linked, 'escalated', v_escalated, 'cancelled', v_cancelled, 'offers_removed', v_offers_removed);
END;
$$;
REVOKE EXECUTE ON FUNCTION district_escalate_offers() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Listing
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION district_create_listing(p_notice_id uuid, p_doctor_id uuid, p_service_disruption boolean, p_slots text[], p_note text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_notice district_notices%ROWTYPE;
  v_me district_doctors%ROWTYPE;
  v_start date;
  v_slot text;
  v_id uuid;
  v_doc record;
BEGIN
  SELECT * INTO v_notice FROM district_notices WHERE notice_id = p_notice_id;
  SELECT * INTO v_me FROM district_doctors WHERE doctor_id = p_doctor_id;
  IF v_notice.shift_date < (now() AT TIME ZONE 'Australia/Brisbane')::date THEN
    RAISE EXCEPTION 'This shift is in the past';
  END IF;
  IF EXISTS (SELECT 1 FROM district_swap_listings WHERE notice_id = p_notice_id AND status = 'open') THEN
    RAISE EXCEPTION 'This shift is already listed';
  END IF;
  v_start := district_fortnight_start(v_notice.shift_date);
  FOREACH v_slot IN ARRAY coalesce(p_slots, '{}') LOOP
    IF v_slot !~ '^\d{4}-\d{2}-\d{2}:(day|night)$' THEN
      RAISE EXCEPTION 'Days you could work in return must be in the same pay fortnight';
    END IF;
    IF split_part(v_slot, ':', 1)::date NOT BETWEEN v_start AND v_start + 13 THEN
      RAISE EXCEPTION 'Days you could work in return must be in the same pay fortnight';
    END IF;
  END LOOP;

  INSERT INTO district_swap_listings (district_id, notice_id, doctor_id, service_disruption, available_slots, note)
  VALUES (v_notice.district_id, p_notice_id, p_doctor_id, coalesce(p_service_disruption, false),
          coalesce(p_slots, '{}'), nullif(trim(p_note), ''))
  RETURNING listing_id INTO v_id;

  -- Doctors who could take it, as for a new shift. The officer hears once
  -- someone offers (offer_for_swap).
  FOR v_doc IN
    SELECT d.doctor_id FROM district_doctors d
    WHERE d.district_id = v_notice.district_id AND d.active AND d.user_id IS NOT NULL
      AND d.doctor_id <> p_doctor_id
      AND v_notice.site_id = ANY (d.interested_site_ids)
      AND district_swap_problem(d.doctor_id, p_notice_id, NULL) IS NULL
  LOOP
    PERFORM district_swap_tell_doctor(v_doc.doctor_id,
      format('%sSwap available from %s: %s', CASE WHEN p_service_disruption THEN 'SERVICE DISRUPTION: ' ELSE '' END,
             v_me.name, district_shift_text(p_notice_id)),
      'Shift up for swap');
  END LOOP;
  RETURN v_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION district_create_listing(uuid, uuid, boolean, text[], text) FROM PUBLIC, anon, authenticated;

-- A DR Roster shift the doctor is booked on (DR Roster's Swaps tab).
CREATE OR REPLACE FUNCTION list_shift_for_swap(p_notice_id uuid, p_service_disruption boolean, p_slots text[], p_note text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_notice district_notices%ROWTYPE;
  v_me district_doctors%ROWTYPE;
BEGIN
  SELECT * INTO v_notice FROM district_notices WHERE notice_id = p_notice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That shift no longer exists';
  END IF;
  SELECT * INTO v_me FROM district_doctors
  WHERE district_id = v_notice.district_id AND user_id = auth.uid() AND active;
  IF NOT FOUND OR v_notice.filled_by_doctor_id IS DISTINCT FROM v_me.doctor_id OR v_notice.status <> 'filled' THEN
    RAISE EXCEPTION 'You can only list a shift you''re booked on';
  END IF;
  RETURN district_create_listing(p_notice_id, v_me.doctor_id, p_service_disruption, p_slots, p_note);
END;
$$;

-- A roster-app shift (roster-app's Variation tab), for a doctor who's in
-- DR Roster too and whose department is linked to a site.
CREATE OR REPLACE FUNCTION list_roster_shift_for_swap(p_assignment_id uuid, p_service_disruption boolean, p_slots text[], p_note text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me district_doctors%ROWTYPE;
BEGIN
  SELECT d.* INTO v_me
  FROM staff_assignments a
  JOIN sites s ON s.department_id = a.department_id
  JOIN district_doctors d ON d.district_id = s.district_id AND d.user_id = auth.uid() AND d.active
  WHERE a.assignment_id = p_assignment_id
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'You need to be a DR Roster doctor in this department''s district to list a shift for swap';
  END IF;
  RETURN district_create_listing(district_mirror_assignment(p_assignment_id, v_me.doctor_id), v_me.doctor_id,
                                 p_service_disruption, p_slots, p_note);
END;
$$;

CREATE OR REPLACE FUNCTION withdraw_swap_listing(p_listing_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_listing district_swap_listings%ROWTYPE;
BEGIN
  SELECT l.* INTO v_listing FROM district_swap_listings l
  JOIN district_doctors d ON d.doctor_id = l.doctor_id
  WHERE l.listing_id = p_listing_id AND d.user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only the doctor who listed it can withdraw it';
  END IF;
  IF v_listing.status <> 'open' THEN
    RAISE EXCEPTION 'It''s no longer listed';
  END IF;
  -- Officers have only heard of it if someone had offered.
  IF EXISTS (SELECT 1 FROM district_swap_offers WHERE listing_id = p_listing_id AND status = 'pending') THEN
    PERFORM district_swap_tell_officers((SELECT site_id FROM district_notices WHERE notice_id = v_listing.notice_id),
      format('Swap withdrawn by %s, so there''s nothing to approve: %s',
             (SELECT name FROM district_doctors WHERE doctor_id = v_listing.doctor_id), district_shift_text(v_listing.notice_id)),
      'Swap withdrawn');
  END IF;
  UPDATE district_swap_listings SET status = 'withdrawn', closed_at = now() WHERE listing_id = p_listing_id;
  PERFORM district_swap_cancel_offers(p_listing_id, 'the listing was withdrawn');
END;
$$;

-- An officer taking a listing down.
CREATE OR REPLACE FUNCTION remove_swap_listing(p_listing_id uuid, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_listing district_swap_listings%ROWTYPE;
BEGIN
  SELECT * INTO v_listing FROM district_swap_listings WHERE listing_id = p_listing_id;
  IF NOT FOUND OR NOT is_site_officer((SELECT site_id FROM district_notices WHERE notice_id = v_listing.notice_id)) THEN
    RAISE EXCEPTION 'Only this site''s officers can do this';
  END IF;
  IF v_listing.status <> 'open' THEN
    RAISE EXCEPTION 'It''s no longer listed';
  END IF;
  UPDATE district_swap_listings
  SET status = 'removed', closed_reason = nullif(trim(p_reason), ''), closed_at = now()
  WHERE listing_id = p_listing_id;
  PERFORM district_swap_cancel_offers(p_listing_id, 'the listing was taken down');
  PERFORM district_swap_tell_doctor(v_listing.doctor_id,
    format('Your swap listing was taken down by an officer%s: %s. You still work it.',
           coalesce(' (' || nullif(trim(p_reason), '') || ')', ''), district_shift_text(v_listing.notice_id)),
    'Swap listing taken down');
END;
$$;

-- ---------------------------------------------------------------------------
-- The marketplace, and offering
-- ---------------------------------------------------------------------------

-- For the signed-in doctor: each open listing in the district (not theirs)
-- at a site they'd work at, why they can't take it outright (NULL if they
-- can), and which of their own shifts at that site they could swap for it:
-- [{ notice_id | assignment_id, label }].
CREATE OR REPLACE FUNCTION my_swap_market(p_district_id uuid)
RETURNS TABLE (listing_id uuid, problem text, swap_options jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (
    SELECT * FROM district_doctors WHERE district_id = p_district_id AND user_id = auth.uid() AND active
  ),
  today AS (SELECT (now() AT TIME ZONE 'Australia/Brisbane')::date AS d)
  SELECT l.listing_id,
         district_swap_problem(me.doctor_id, l.notice_id, NULL),
         coalesce((
           -- Their DR Roster shifts at that site.
           SELECT jsonb_agg(jsonb_build_object('notice_id', o.notice_id, 'label', district_shift_text(o.notice_id))
                            ORDER BY o.shift_date, o.start_time)
           FROM district_notices o, today
           WHERE o.filled_by_doctor_id = me.doctor_id AND o.status = 'filled' AND o.source <> 'roster_shift'
             AND o.site_id = n.site_id AND o.notice_id <> n.notice_id AND o.shift_date >= today.d
             AND (o.shift_date::text || ':' || district_shift_kind(o.start_time, o.end_time)) = ANY (l.available_slots)
             AND district_swap_problem_at(me.doctor_id, n.shift_date, n.start_time, n.end_time, n.position, n.required_skill,
                                          n.notice_id, o.notice_id, NULL) IS NULL
             AND district_swap_problem_at(l.doctor_id, o.shift_date, o.start_time, o.end_time, o.position, o.required_skill,
                                          o.notice_id, n.notice_id, NULL) IS NULL
         ), '[]'::jsonb) ||
         coalesce((
           -- Their roster-app shifts in that site's department (one per shift).
           SELECT jsonb_agg(jsonb_build_object(
                    'assignment_id', r.assignment_id,
                    'label', format('%s · %s · %s %s-%s (roster-app)', to_char(r.date, 'Dy FMDD Mon'), s2.name,
                                    r.title, to_char(r.start_time, 'HH24:MI'), to_char(r.end_time, 'HH24:MI')))
                  ORDER BY r.date, r.start_time)
           FROM (
             SELECT DISTINCT ON (a.staff_id, a.date, a.shift_id, a.location_id) a.assignment_id, f.*
             FROM staff st
             JOIN staff_assignments a ON a.staff_id = st.staff_id
             CROSS JOIN LATERAL district_assignment_facts(a.assignment_id, p_district_id) f
             WHERE st.user_id = me.user_id AND f.site_id = n.site_id
               AND a.date >= (SELECT d FROM today)
             ORDER BY a.staff_id, a.date, a.shift_id, a.location_id, a.assignment_id
           ) r
           JOIN sites s2 ON s2.site_id = r.site_id
           WHERE (r.date::text || ':' || district_shift_kind(r.start_time, r.end_time)) = ANY (l.available_slots)
             AND NOT EXISTS (
               SELECT 1 FROM district_roster_shifts rs
               WHERE rs.notice_id = n.notice_id AND rs.staff_id = r.staff_id AND rs.date = r.date AND rs.shift_id IS NOT DISTINCT FROM r.shift_id)
             AND district_swap_problem_at(me.doctor_id, n.shift_date, n.start_time, n.end_time, n.position, n.required_skill,
                                          n.notice_id, NULL, r.assignment_id) IS NULL
             AND district_swap_problem_at(l.doctor_id, r.date, r.start_time, r.end_time, r.shift_position, r.skill,
                                          NULL, n.notice_id, NULL) IS NULL
         ), '[]'::jsonb)
  FROM district_swap_listings l
  JOIN district_notices n ON n.notice_id = l.notice_id
  CROSS JOIN me
  WHERE l.district_id = p_district_id AND l.status = 'open' AND l.doctor_id <> me.doctor_id
    AND n.site_id = ANY (me.interested_site_ids)
    AND n.shift_date >= (now() AT TIME ZONE 'Australia/Brisbane')::date;
$$;

-- Take a listed shift (no shift in return), or offer one of your own: a DR
-- Roster shift (p_offered_notice_id) or a roster-app one
-- (p_offered_assignment_id).
DROP FUNCTION IF EXISTS offer_for_swap(uuid, uuid, text);
CREATE OR REPLACE FUNCTION offer_for_swap(p_listing_id uuid, p_offered_notice_id uuid DEFAULT NULL, p_note text DEFAULT NULL,
                                          p_offered_assignment_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_listing district_swap_listings%ROWTYPE;
  v_notice district_notices%ROWTYPE;
  v_offered district_notices%ROWTYPE;
  v_me district_doctors%ROWTYPE;
  v_offered_id uuid := p_offered_notice_id;
  v_problem text;
  v_id uuid;
BEGIN
  SELECT * INTO v_listing FROM district_swap_listings WHERE listing_id = p_listing_id;
  IF NOT FOUND OR v_listing.status <> 'open' THEN
    RAISE EXCEPTION 'That shift is no longer up for swap';
  END IF;
  SELECT * INTO v_notice FROM district_notices WHERE notice_id = v_listing.notice_id;
  SELECT * INTO v_me FROM district_doctors
  WHERE district_id = v_listing.district_id AND user_id = auth.uid() AND active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only doctors in this district can offer';
  END IF;
  IF v_me.doctor_id = v_listing.doctor_id THEN
    RAISE EXCEPTION 'That''s your own listing';
  END IF;
  IF EXISTS (SELECT 1 FROM district_swap_offers WHERE listing_id = p_listing_id AND doctor_id = v_me.doctor_id AND status = 'pending') THEN
    RAISE EXCEPTION 'You''ve already made an offer for this shift';
  END IF;

  IF p_offered_assignment_id IS NOT NULL THEN
    v_offered_id := district_mirror_assignment(p_offered_assignment_id, v_me.doctor_id);
  END IF;
  IF v_offered_id IS NOT NULL THEN
    SELECT * INTO v_offered FROM district_notices WHERE notice_id = v_offered_id;
    IF NOT FOUND OR v_offered.filled_by_doctor_id IS DISTINCT FROM v_me.doctor_id OR v_offered.status <> 'filled' THEN
      RAISE EXCEPTION 'You can only offer a shift you''re booked on';
    END IF;
    IF v_offered.site_id <> v_notice.site_id THEN
      RAISE EXCEPTION 'A swap has to be for a shift at the same site';
    END IF;
    IF NOT (v_offered.shift_date::text || ':' || district_shift_kind(v_offered.start_time, v_offered.end_time)) = ANY (v_listing.available_slots) THEN
      RAISE EXCEPTION 'That isn''t one of the days or nights they can work in return';
    END IF;
    v_problem := district_swap_problem(v_listing.doctor_id, v_offered_id, v_listing.notice_id);
    IF v_problem IS NOT NULL THEN
      RAISE EXCEPTION 'They couldn''t do your shift: %', v_problem;
    END IF;
  END IF;
  v_problem := district_swap_problem(v_me.doctor_id, v_listing.notice_id, v_offered_id);
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problem;
  END IF;

  INSERT INTO district_swap_offers (listing_id, doctor_id, offered_notice_id, note)
  VALUES (p_listing_id, v_me.doctor_id, v_offered_id, nullif(trim(p_note), ''))
  RETURNING offer_id INTO v_id;

  PERFORM district_swap_tell_officers(v_notice.site_id,
    CASE WHEN v_offered_id IS NULL
      THEN format('%s offered to take %s from %s: approve or decline it on the Swaps tab', v_me.name,
                  district_shift_text(v_notice.notice_id), (SELECT name FROM district_doctors WHERE doctor_id = v_listing.doctor_id))
      ELSE format('%s proposed a swap with %s: their %s for %s. Approve or decline it on the Swaps tab', v_me.name,
                  (SELECT name FROM district_doctors WHERE doctor_id = v_listing.doctor_id),
                  district_shift_text(v_offered_id), district_shift_text(v_notice.notice_id))
    END,
    'Swap offer to review');
  PERFORM district_swap_tell_doctor(v_listing.doctor_id,
    CASE WHEN v_offered_id IS NULL
      THEN format('%s offered to take your %s (waiting for an officer)', v_me.name, district_shift_text(v_notice.notice_id))
      ELSE format('%s offered their %s for your %s (waiting for an officer)', v_me.name,
                  district_shift_text(v_offered_id), district_shift_text(v_notice.notice_id))
    END,
    'Offer for your swap');
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION withdraw_swap_offer(p_offer_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_offer district_swap_offers%ROWTYPE;
  v_listing district_swap_listings%ROWTYPE;
BEGIN
  SELECT o.* INTO v_offer FROM district_swap_offers o
  JOIN district_doctors d ON d.doctor_id = o.doctor_id
  WHERE o.offer_id = p_offer_id AND d.user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only the doctor who made it can withdraw it';
  END IF;
  IF v_offer.status <> 'pending' THEN
    RAISE EXCEPTION 'It''s already been decided';
  END IF;
  UPDATE district_swap_offers SET status = 'withdrawn', decided_at = now() WHERE offer_id = p_offer_id;
  SELECT * INTO v_listing FROM district_swap_listings WHERE listing_id = v_offer.listing_id;
  PERFORM district_swap_tell_officers((SELECT site_id FROM district_notices WHERE notice_id = v_listing.notice_id),
    format('%s withdrew their swap offer for %s', (SELECT name FROM district_doctors WHERE doctor_id = v_offer.doctor_id),
           district_shift_text(v_listing.notice_id)),
    'Swap offer withdrawn');
END;
$$;

-- ---------------------------------------------------------------------------
-- The officer deciding a swap
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION approve_swap_offer(p_offer_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_offer district_swap_offers%ROWTYPE;
  v_listing district_swap_listings%ROWTYPE;
  v_notice district_notices%ROWTYPE;
  v_offered district_notices%ROWTYPE;
  v_lister district_doctors%ROWTYPE;
  v_taker district_doctors%ROWTYPE;
  v_problem text;
BEGIN
  SELECT * INTO v_offer FROM district_swap_offers WHERE offer_id = p_offer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That offer no longer exists';
  END IF;
  SELECT * INTO v_listing FROM district_swap_listings WHERE listing_id = v_offer.listing_id;
  SELECT * INTO v_notice FROM district_notices WHERE notice_id = v_listing.notice_id;
  IF NOT is_site_officer(v_notice.site_id) THEN
    RAISE EXCEPTION 'Only this site''s officers can approve swaps';
  END IF;
  IF v_offer.status <> 'pending' OR v_listing.status <> 'open' THEN
    RAISE EXCEPTION 'This offer has already been decided';
  END IF;
  SELECT * INTO v_lister FROM district_doctors WHERE doctor_id = v_listing.doctor_id;
  SELECT * INTO v_taker FROM district_doctors WHERE doctor_id = v_offer.doctor_id;
  IF v_notice.status <> 'filled' OR v_notice.filled_by_doctor_id IS DISTINCT FROM v_lister.doctor_id THEN
    RAISE EXCEPTION '%''s shift has changed since it was listed', v_lister.name;
  END IF;
  IF v_offer.offered_notice_id IS NOT NULL THEN
    SELECT * INTO v_offered FROM district_notices WHERE notice_id = v_offer.offered_notice_id;
    IF v_offered.status <> 'filled' OR v_offered.filled_by_doctor_id IS DISTINCT FROM v_taker.doctor_id THEN
      RAISE EXCEPTION '%''s shift has changed since they offered it', v_taker.name;
    END IF;
    v_problem := district_swap_problem(v_lister.doctor_id, v_offered.notice_id, v_notice.notice_id);
    IF v_problem IS NOT NULL THEN
      RAISE EXCEPTION '% can''t now do %: %', v_lister.name, district_shift_text(v_offered.notice_id), v_problem;
    END IF;
  END IF;
  v_problem := district_swap_problem(v_taker.doctor_id, v_notice.notice_id, v_offer.offered_notice_id);
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '% can''t now do %: %', v_taker.name, district_shift_text(v_notice.notice_id), v_problem;
  END IF;

  UPDATE district_swap_offers SET status = 'approved', decided_by = auth.uid(), decided_at = now() WHERE offer_id = p_offer_id;
  UPDATE district_swap_listings SET status = 'taken', closed_at = now() WHERE listing_id = v_listing.listing_id;
  PERFORM district_swap_cancel_offers(v_listing.listing_id, 'someone else''s offer was accepted', p_offer_id);

  -- Move the bookings. A DR Roster shift's roster-app card follows
  -- (district_notices_card); a roster-app shift moves on roster-app.
  UPDATE district_notices SET filled_by_doctor_id = v_taker.doctor_id WHERE notice_id = v_notice.notice_id;
  PERFORM district_move_roster_shift(v_notice.notice_id, v_taker.doctor_id);
  IF v_offer.offered_notice_id IS NOT NULL THEN
    UPDATE district_notices SET filled_by_doctor_id = v_lister.doctor_id WHERE notice_id = v_offered.notice_id;
    PERFORM district_move_roster_shift(v_offered.notice_id, v_lister.doctor_id);
  END IF;
  -- The applications the move just approved and cancelled are told about
  -- below as a swap, not as "booked"/"booking cancelled".
  UPDATE district_applications
  SET doctor_notified_at = now(),
      note = CASE WHEN status = 'approved' THEN 'Swap' ELSE note END
  WHERE notice_id IN (v_notice.notice_id, v_offer.offered_notice_id) AND decided_at = now();

  PERFORM district_swap_tell_doctor(v_taker.doctor_id,
    CASE WHEN v_offer.offered_notice_id IS NULL
      THEN format('Swap approved: you''re now on %s (from %s)', district_shift_text(v_notice.notice_id), v_lister.name)
      ELSE format('Swap approved: you''re now on %s, and %s has your %s', district_shift_text(v_notice.notice_id),
                  v_lister.name, district_shift_text(v_offered.notice_id))
    END,
    'Swap approved');
  PERFORM district_swap_tell_doctor(v_lister.doctor_id,
    CASE WHEN v_offer.offered_notice_id IS NULL
      THEN format('Swap approved: %s is taking your %s', v_taker.name, district_shift_text(v_notice.notice_id))
      ELSE format('Swap approved: %s is taking your %s, and you''re now on %s', v_taker.name,
                  district_shift_text(v_notice.notice_id), district_shift_text(v_offered.notice_id))
    END,
    'Swap approved');
END;
$$;

CREATE OR REPLACE FUNCTION decline_swap_offer(p_offer_id uuid, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_offer district_swap_offers%ROWTYPE;
  v_listing district_swap_listings%ROWTYPE;
BEGIN
  SELECT * INTO v_offer FROM district_swap_offers WHERE offer_id = p_offer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That offer no longer exists';
  END IF;
  SELECT * INTO v_listing FROM district_swap_listings WHERE listing_id = v_offer.listing_id;
  IF NOT is_site_officer((SELECT site_id FROM district_notices WHERE notice_id = v_listing.notice_id)) THEN
    RAISE EXCEPTION 'Only this site''s officers can decline swaps';
  END IF;
  IF v_offer.status <> 'pending' THEN
    RAISE EXCEPTION 'This offer has already been decided';
  END IF;
  UPDATE district_swap_offers
  SET status = 'declined', decline_reason = nullif(trim(p_reason), ''), decided_by = auth.uid(), decided_at = now()
  WHERE offer_id = p_offer_id;
  PERFORM district_swap_tell_doctor(v_offer.doctor_id,
    format('Swap not approved%s: %s', coalesce(' (' || nullif(trim(p_reason), '') || ')', ''),
           district_shift_text(v_listing.notice_id)),
    'Swap not approved');
  PERFORM district_swap_tell_doctor(v_listing.doctor_id,
    format('%s''s offer for your shift was not approved%s: %s. You still work it.',
           (SELECT name FROM district_doctors WHERE doctor_id = v_offer.doctor_id),
           coalesce(' (' || nullif(trim(p_reason), '') || ')', ''), district_shift_text(v_listing.notice_id)),
    'Swap not approved');
END;
$$;

-- ---------------------------------------------------------------------------
-- Keeping listings honest when a shift changes some other way
-- ---------------------------------------------------------------------------

-- A DR Roster shift reopened, cancelled or rebooked by an officer.
CREATE OR REPLACE FUNCTION district_swap_listing_follow()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.filled_by_doctor_id IS NOT DISTINCT FROM OLD.filled_by_doctor_id THEN
    RETURN NEW;
  END IF;
  PERFORM district_swap_shift_changed(NEW.notice_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS district_swap_listing_follow ON district_notices;
CREATE TRIGGER district_swap_listing_follow
  AFTER UPDATE OF status, filled_by_doctor_id ON district_notices
  FOR EACH ROW EXECUTE FUNCTION district_swap_listing_follow();

-- A roster-app shift moved, re-dated or deleted on roster-app.
CREATE OR REPLACE FUNCTION district_swap_roster_follow()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_notice uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.staff_id IS NOT DISTINCT FROM OLD.staff_id AND NEW.date IS NOT DISTINCT FROM OLD.date
     AND NEW.shift_id IS NOT DISTINCT FROM OLD.shift_id THEN
    RETURN NULL;
  END IF;
  FOR v_notice IN
    SELECT rs.notice_id FROM district_roster_shifts rs
    WHERE rs.staff_id = OLD.staff_id AND rs.date = OLD.date AND rs.shift_id IS NOT DISTINCT FROM OLD.shift_id
  LOOP
    PERFORM district_swap_shift_changed(v_notice);
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS district_swap_roster_follow ON staff_assignments;
CREATE TRIGGER district_swap_roster_follow
  AFTER UPDATE OR DELETE ON staff_assignments
  FOR EACH ROW EXECUTE FUNCTION district_swap_roster_follow();

REVOKE EXECUTE ON FUNCTION district_swap_listing_follow() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_swap_roster_follow() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- For roster-app's Variation tab (listing only; the marketplace is DR Roster's)
-- ---------------------------------------------------------------------------

-- The signed-in person's upcoming roster-app shifts that can go on the DR
-- Roster marketplace (they're a DR Roster doctor in the district of a site
-- linked to that department), one row per shift, with any listing.
CREATE OR REPLACE FUNCTION my_roster_swap_shifts(p_from date, p_to date)
RETURNS TABLE (assignment_id uuid, date date, start_time time, end_time time, label text, site_name text,
               listing_id uuid, listing_status text, pending_offers int)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.assignment_id, r.date, r.start_time, r.end_time, r.title, s.name,
         l.listing_id, l.status,
         (SELECT count(*)::int FROM district_swap_offers o WHERE o.listing_id = l.listing_id AND o.status = 'pending')
  FROM (
    SELECT DISTINCT ON (a.staff_id, a.date, a.shift_id, a.location_id) a.assignment_id, f.*, d.doctor_id
    FROM staff st
    JOIN staff_assignments a ON a.staff_id = st.staff_id
    JOIN sites s0 ON s0.department_id = a.department_id
    JOIN district_doctors d ON d.district_id = s0.district_id AND d.user_id = st.user_id AND d.active
    CROSS JOIN LATERAL district_assignment_facts(a.assignment_id, s0.district_id) f
    WHERE st.user_id = auth.uid() AND a.date BETWEEN greatest(p_from, (now() AT TIME ZONE 'Australia/Brisbane')::date) AND p_to
    ORDER BY a.staff_id, a.date, a.shift_id, a.location_id, a.assignment_id
  ) r
  JOIN sites s ON s.site_id = r.site_id
  LEFT JOIN district_roster_shifts rs
    ON rs.staff_id = r.staff_id AND rs.date = r.date AND rs.shift_id IS NOT DISTINCT FROM r.shift_id
   AND rs.location_id IS NOT DISTINCT FROM r.location_id
  LEFT JOIN district_swap_listings l ON l.notice_id = rs.notice_id AND l.status = 'open'
  ORDER BY r.date, r.start_time;
$$;

REVOKE EXECUTE ON FUNCTION list_shift_for_swap(uuid, boolean, text[], text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION list_roster_shift_for_swap(uuid, boolean, text[], text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION withdraw_swap_listing(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION remove_swap_listing(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION my_swap_market(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION offer_for_swap(uuid, uuid, text, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION withdraw_swap_offer(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION approve_swap_offer(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION decline_swap_offer(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION my_roster_swap_shifts(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION list_shift_for_swap(uuid, boolean, text[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION list_roster_shift_for_swap(uuid, boolean, text[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION withdraw_swap_listing(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION remove_swap_listing(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION my_swap_market(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION offer_for_swap(uuid, uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION withdraw_swap_offer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION approve_swap_offer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION decline_swap_offer(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION my_roster_swap_shifts(date, date) TO authenticated;

COMMIT;
