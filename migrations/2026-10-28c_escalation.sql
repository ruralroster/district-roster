-- Gaps offered for volunteering on roster-app go to the district when
-- nobody local has taken them in time.
--
-- Only roster-app volunteer_offers are escalated (an officer offered the
-- gap), and only at sites linked to a roster-app department. An offer
-- goes up once it's been open for the site's escalate_after_hours (72 by
-- default, Sites tab), or straight away if the shift starts within that
-- many hours. It becomes an open district shift (source 'roster_app'), so
-- matching district doctors are told by district-notify as usual.
--
-- Kept in step every run:
--   - taken locally (someone new on the card in the offer's role) or the
--     offer withdrawn on roster-app: the district shift is cancelled, and
--     anyone who applied is told.
--   - filled in DR Roster: the roster-app offer is removed, so local staff
--     stop volunteering for a gap that's covered. The officer adds the
--     district doctor to the roster-app card (the approval email says who).
--
-- district_escalate_offers() does it all; pg_cron runs it every 15 minutes.
-- Run after 2026-10-28b_site_escalation.sql. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS district_escalations (
  -- No foreign key: the offer can be deleted on roster-app, which is how
  -- we know it was withdrawn.
  volunteer_offer_id uuid PRIMARY KEY,
  theatre_activity_id uuid NOT NULL,
  role text NOT NULL,
  notice_id uuid NOT NULL REFERENCES district_notices(notice_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Only the timer uses it.
ALTER TABLE district_escalations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON district_escalations FROM anon, authenticated;

-- Taken locally: more people in the offer's role on the card than when it
-- was offered (roster-app's offerIsFilled).
CREATE OR REPLACE FUNCTION district_offer_filled(p_offer_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (
    SELECT count(*) FROM staff_assignments a
    WHERE a.theatre_activity_id = o.theatre_activity_id AND a.role = o.role
  ) > o.filled_baseline
  FROM volunteer_offers o WHERE o.volunteer_offer_id = p_offer_id;
$$;

CREATE OR REPLACE FUNCTION district_escalate_offers()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
  v_notice_id uuid;
  v_escalated int := 0;
  v_cancelled int := 0;
  v_offers_removed int := 0;
BEGIN
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

  -- 2. Filled in DR Roster: take the offer off roster-app.
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
           -- The card's required skills, in district terms: anaesthetics or
           -- obstetrics if it asks for one, otherwise any doctor.
           CASE
             WHEN EXISTS (SELECT 1 FROM advanced_skills k WHERE k.advanced_skill_id = ANY (offers.required_advanced_skills) AND k.name ~* 'an(a)?esth') THEN 'Anaesthetics'
             WHEN EXISTS (SELECT 1 FROM advanced_skills k WHERE k.advanced_skill_id = ANY (offers.required_advanced_skills) AND k.name ~* 'obst|o\s*&\s*g|\mobs\M') THEN 'O&G'
             ELSE 'Emergency'
           END AS skill
    FROM offers
    WHERE offers.start_time IS NOT NULL AND offers.end_time IS NOT NULL
      AND ((offers.date + offers.start_time) AT TIME ZONE 'Australia/Brisbane') > now()
      AND NOT district_offer_filled(offers.volunteer_offer_id)
      AND (now() >= offers.created_at + make_interval(hours => offers.escalate_after_hours)
           OR ((offers.date + offers.start_time) AT TIME ZONE 'Australia/Brisbane') <= now() + make_interval(hours => offers.escalate_after_hours))
  LOOP
    INSERT INTO district_notices (site_id, shift_date, start_time, end_time, required_skill, title, notes, source)
    VALUES (
      v_row.site_id, v_row.date, v_row.start_time, v_row.end_time, v_row.skill,
      format('%s (%s)', v_row.job, initcap(v_row.role)),
      concat_ws(' · ', 'Not filled locally', CASE v_row.required_grade WHEN 'smo' THEN 'Needs an SMO' WHEN 'registrar' THEN 'Registrar or above' END),
      'roster_app'
    )
    RETURNING notice_id INTO v_notice_id;
    INSERT INTO district_escalations (volunteer_offer_id, theatre_activity_id, role, notice_id)
    VALUES (v_row.volunteer_offer_id, v_row.theatre_activity_id, v_row.role, v_notice_id);
    v_escalated := v_escalated + 1;
  END LOOP;

  RETURN jsonb_build_object('escalated', v_escalated, 'cancelled', v_cancelled, 'offers_removed', v_offers_removed);
END;
$$;

REVOKE EXECUTE ON FUNCTION district_offer_filled(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_escalate_offers() FROM PUBLIC, anon, authenticated;

COMMIT;

-- Every 15 minutes, all day (the emails and pushes about it still only go
-- out 6:00-21:00).
SELECT cron.schedule('district-escalate', '*/15 * * * *', $$SELECT district_escalate_offers()$$);

-- To see what it's done:
--   SELECT e.created_at, n.shift_date, n.title, n.status FROM district_escalations e JOIN district_notices n USING (notice_id) ORDER BY e.created_at DESC LIMIT 20;
-- To run it now:
--   SELECT district_escalate_offers();
-- To stop it:
--   SELECT cron.unschedule('district-escalate');
