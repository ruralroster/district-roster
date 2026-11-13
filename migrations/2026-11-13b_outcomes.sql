-- Every vacancy gets an outcome, so Insights can say where each one went.
--
-- New reasons (district_notices.cancel_reason):
--   'rostered_locally'  the officer rostered a local doctor on Rstar
--   'went_unfilled'     nobody covered it; the service ran short
--   'withdrawn'         an escalated Rstar offer was taken back on Rstar
-- 'covered_locally' now only means an escalated Rstar offer that a local
-- doctor took. Rstar deletes an offer as soon as someone's rostered onto
-- the card, so "offer gone" can't tell taken from withdrawn: each
-- escalation now keeps how many were on the card in that role when it
-- escalated (filled_baseline), and more than that means a local took it.
--
-- record_shift_outcome(notice, outcome, doctor) is for shifts that started
-- while still open, from Calendar's "What happened to these shifts?": the
-- officer says who did it, or why nobody did. Nobody is emailed about a
-- shift that's already happened.
--
-- district_insights changes to match: fill rate is shifts filled in DR App
-- out of shifts that needed cover (started, not cancelled as no longer
-- needed or withdrawn), and every needed shift is accounted for as filled,
-- rostered locally, agency, filled some other way, service closed, went
-- unfilled, or no outcome recorded yet. Fill timings only use fills made
-- before the shift (one recorded afterwards says nothing about speed).
--
-- Run after 2026-11-13_insights.sql. Safe to re-run.

BEGIN;

ALTER TABLE district_notices DROP CONSTRAINT IF EXISTS district_notices_cancel_reason_check;
ALTER TABLE district_notices ADD CONSTRAINT district_notices_cancel_reason_check
  CHECK (cancel_reason IS NULL OR cancel_reason IN (
    'agency', 'outside_app', 'not_needed', 'service_closed', 'covered_locally',
    'rostered_locally', 'went_unfilled', 'withdrawn'));

-- ---------------------------------------------------------------------------
-- Taken on Rstar, or withdrawn there.

ALTER TABLE district_escalations ADD COLUMN IF NOT EXISTS filled_baseline int;

CREATE OR REPLACE FUNCTION district_escalations_baseline()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.filled_baseline IS NULL THEN
    NEW.filled_baseline := (SELECT o.filled_baseline FROM volunteer_offers o WHERE o.volunteer_offer_id = NEW.volunteer_offer_id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION district_escalations_baseline() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS district_escalations_baseline ON district_escalations;
CREATE TRIGGER district_escalations_baseline
  BEFORE INSERT ON district_escalations
  FOR EACH ROW EXECUTE FUNCTION district_escalations_baseline();

-- Escalations whose offer is still there.
UPDATE district_escalations e SET filled_baseline = o.filled_baseline
FROM volunteer_offers o
WHERE o.volunteer_offer_id = e.volunteer_offer_id AND e.filled_baseline IS NULL;

-- More on the card in the offer's role than when it escalated. Without a
-- baseline (escalated before this, offer since deleted), anyone on the
-- card in that role counts.
CREATE OR REPLACE FUNCTION district_escalation_taken(p_offer_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (
    SELECT count(*) FROM staff_assignments a
    WHERE a.theatre_activity_id = e.theatre_activity_id AND a.role = e.role
  ) > coalesce(e.filled_baseline, 0)
  FROM district_escalations e WHERE e.volunteer_offer_id = p_offer_id;
$$;
REVOKE EXECUTE ON FUNCTION district_escalation_taken(uuid) FROM PUBLIC, anon, authenticated;

-- The 15-minute sync says which it was when it cancels the district shift.
DO $$
DECLARE
  v_old text := $q$SET status = 'cancelled', notes = concat_ws(' · ', notes, 'Covered or withdrawn on roster-app')$q$;
  v_new text := $q$SET status = 'cancelled',
        cancel_reason = CASE WHEN district_escalation_taken(v_row.volunteer_offer_id) THEN 'covered_locally' ELSE 'withdrawn' END,
        notes = concat_ws(' · ', notes, 'Covered or withdrawn on roster-app')$q$;
  v_def text := pg_get_functiondef('district_escalate_offers()'::regprocedure);
BEGIN
  IF position('district_escalation_taken' IN v_def) > 0 THEN
    RAISE NOTICE 'district_escalate_offers already records taken or withdrawn';
  ELSIF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'district_escalate_offers has changed: its cancel step wasn''t found';
  ELSE
    EXECUTE replace(v_def, v_old, v_new);
  END IF;
END $$;

-- Ones already cancelled.
UPDATE district_notices n
SET cancel_reason = CASE WHEN district_escalation_taken(e.volunteer_offer_id) THEN 'covered_locally' ELSE 'withdrawn' END
FROM district_escalations e
WHERE e.notice_id = n.notice_id AND n.status = 'cancelled' AND n.cancel_reason = 'covered_locally';

-- ---------------------------------------------------------------------------
-- What happened to a shift that started while still open.

CREATE OR REPLACE FUNCTION record_shift_outcome(p_notice_id uuid, p_outcome text, p_doctor_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_notice district_notices;
BEGIN
  SELECT * INTO v_notice FROM district_notices WHERE notice_id = p_notice_id FOR UPDATE;
  IF NOT FOUND OR NOT is_site_officer(v_notice.site_id) THEN
    RAISE EXCEPTION 'Only an officer at this shift''s site can record what happened';
  END IF;
  IF v_notice.status <> 'open' OR v_notice.source = 'roster_shift' THEN
    RAISE EXCEPTION 'This shift already has an outcome';
  END IF;

  IF p_outcome = 'filled' THEN
    IF NOT EXISTS (SELECT 1 FROM district_doctors d WHERE d.doctor_id = p_doctor_id AND d.district_id = v_notice.district_id) THEN
      RAISE EXCEPTION 'Choose who did the shift';
    END IF;
    UPDATE district_notices SET status = 'filled', filled_by_doctor_id = p_doctor_id WHERE notice_id = p_notice_id;
  ELSIF p_outcome IN ('rostered_locally', 'agency', 'outside_app', 'went_unfilled', 'service_closed', 'not_needed') THEN
    UPDATE district_notices SET status = 'cancelled', cancel_reason = p_outcome WHERE notice_id = p_notice_id;
  ELSE
    RAISE EXCEPTION 'Unknown outcome %', p_outcome;
  END IF;

  -- Already happened: nobody needs an email about it.
  IF (v_notice.shift_date + v_notice.start_time) AT TIME ZONE 'Australia/Brisbane' <= now() THEN
    UPDATE district_applications
    SET doctor_notified_at = coalesce(doctor_notified_at, now()), officer_notified_at = coalesce(officer_notified_at, now())
    WHERE notice_id = p_notice_id;
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION record_shift_outcome(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION record_shift_outcome(uuid, text, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- The report.

CREATE OR REPLACE FUNCTION district_insights(p_district_id uuid, p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sites jsonb;
  v_trend jsonb;
BEGIN
  IF NOT is_district_officer(p_district_id) THEN
    RAISE EXCEPTION 'Only district officers can see insights';
  END IF;

  WITH v AS (
    SELECT n.*,
      (n.shift_date + n.start_time) AT TIME ZONE 'Australia/Brisbane' AS starts_at,
      (SELECT min(a.created_at) FROM district_applications a WHERE a.notice_id = n.notice_id) AS first_applied_at,
      (SELECT count(*) FROM district_applications a WHERE a.notice_id = n.notice_id AND a.status <> 'withdrawn') AS applicants,
      (SELECT d.home_site_id FROM district_doctors d WHERE d.doctor_id = n.filled_by_doctor_id) AS filler_home
    FROM district_notices n
    WHERE n.district_id = p_district_id AND n.source <> 'roster_shift'
      AND n.shift_date BETWEEN p_from AND p_to
  ), w AS (
    -- needed: started, and still wanted (not cancelled as no longer
    -- needed, or withdrawn on Rstar). ahead: filled before it started.
    SELECT v.*,
      starts_at <= now() AND NOT (status = 'cancelled' AND cancel_reason IN ('not_needed', 'withdrawn')) AS needed,
      status = 'filled' AND filled_at <= starts_at AS ahead
    FROM v
  ), m AS (
    SELECT w.site_id,
      count(*) AS posted,
      count(*) FILTER (WHERE needed) AS needed,
      count(*) FILTER (WHERE needed AND status = 'filled') AS filled,
      count(*) FILTER (WHERE needed AND status = 'filled' AND fill_method = 'applied') AS filled_by_applying,
      count(*) FILTER (WHERE needed AND status = 'filled' AND fill_method = 'officer') AS filled_by_officer,
      count(*) FILTER (WHERE needed AND status = 'filled' AND filler_home IS DISTINCT FROM site_id) AS filled_from_other_sites,
      count(*) FILTER (WHERE needed AND cancel_reason IN ('covered_locally', 'rostered_locally')) AS covered_on_rstar,
      count(*) FILTER (WHERE needed AND cancel_reason = 'agency') AS agency,
      count(*) FILTER (WHERE needed AND cancel_reason = 'outside_app') AS outside_app,
      count(*) FILTER (WHERE needed AND cancel_reason = 'service_closed') AS service_closed,
      count(*) FILTER (WHERE needed AND cancel_reason = 'went_unfilled') AS went_unfilled,
      count(*) FILTER (WHERE needed AND (status = 'open' OR (status = 'cancelled' AND cancel_reason IS NULL))) AS no_outcome,
      count(*) FILTER (WHERE starts_at <= now() AND cancel_reason = 'not_needed') AS not_needed,
      count(*) FILTER (WHERE starts_at <= now() AND cancel_reason = 'withdrawn') AS withdrawn,
      count(*) FILTER (WHERE starts_at > now() AND status = 'open') AS upcoming_open,
      count(*) FILTER (WHERE needed AND service_disruption) AS disruption_flagged,
      count(*) FILTER (WHERE needed AND service_disruption AND status = 'filled') AS disruption_averted,
      count(*) FILTER (WHERE source = 'roster_app') AS escalated,
      count(*) FILTER (WHERE source = 'roster_app' AND status = 'filled') AS escalated_filled,
      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM filled_at - created_at)::float8 / 3600)
        FILTER (WHERE ahead))::numeric, 1) AS median_hours_to_fill,
      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_applied_at - created_at)::float8 / 3600)
        FILTER (WHERE first_applied_at IS NOT NULL))::numeric, 1) AS median_hours_to_first_applicant,
      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM starts_at - filled_at)::float8 / 86400)
        FILTER (WHERE ahead))::numeric, 1) AS median_days_filled_ahead,
      count(*) FILTER (WHERE ahead AND starts_at - filled_at < interval '48 hours') AS filled_last_48h,
      round(avg(applicants)::numeric, 1) AS applicants_per_vacancy
    FROM w
    GROUP BY GROUPING SETS ((w.site_id), ())
  ), sw AS (
    SELECT n.site_id,
      count(*) AS swaps_done,
      count(*) FILTER (WHERE o.offered_notice_id IS NOT NULL AND n2.site_id <> n.site_id) AS swaps_cross_site
    FROM district_swap_listings l
    JOIN district_notices n ON n.notice_id = l.notice_id
    LEFT JOIN district_swap_offers o ON o.listing_id = l.listing_id AND o.status = 'approved'
    LEFT JOIN district_notices n2 ON n2.notice_id = o.offered_notice_id
    WHERE l.district_id = p_district_id AND l.status = 'taken' AND n.shift_date BETWEEN p_from AND p_to
    GROUP BY GROUPING SETS ((n.site_id), ())
  ), pool AS (
    SELECT s.site_id,
      (SELECT count(*) FROM district_doctors d
       WHERE d.district_id = p_district_id AND d.active AND d.user_id IS NOT NULL AND s.site_id = ANY (d.interested_site_ids)) AS doctors_ticked
    FROM sites s WHERE s.district_id = p_district_id
  )
  -- Every site, with or without vacancies, then the whole district.
  SELECT jsonb_agg(
    coalesce(to_jsonb(m), '{}'::jsonb) || jsonb_build_object(
      'site_id', k.site_id,
      'posted', coalesce(m.posted, 0),
      'name', coalesce(s.name, 'Whole district'),
      'doctors_ticked', CASE WHEN k.site_id IS NULL
        THEN (SELECT count(*) FROM district_doctors d WHERE d.district_id = p_district_id AND d.active AND d.user_id IS NOT NULL)
        ELSE p.doctors_ticked END,
      'swaps_done', coalesce(sw.swaps_done, 0),
      'swaps_cross_site', coalesce(sw.swaps_cross_site, 0)
    ) ORDER BY k.site_id IS NOT NULL, s.name)
  INTO v_sites
  FROM (SELECT site_id FROM sites WHERE district_id = p_district_id UNION ALL SELECT NULL::uuid) k
  LEFT JOIN m ON m.site_id IS NOT DISTINCT FROM k.site_id
  LEFT JOIN sites s ON s.site_id = k.site_id
  LEFT JOIN pool p ON p.site_id = k.site_id
  LEFT JOIN sw ON sw.site_id IS NOT DISTINCT FROM k.site_id;

  SELECT jsonb_agg(jsonb_build_object('day', day, 'site_id', site_id, 'doctors_ticked', doctors_ticked,
           'active_doctors', active_doctors, 'open_vacancies', open_vacancies) ORDER BY day)
  INTO v_trend
  FROM district_site_daily
  WHERE district_id = p_district_id AND day BETWEEN p_from AND greatest(p_to, p_from);

  RETURN jsonb_build_object('sites', coalesce(v_sites, '[]'), 'trend', coalesce(v_trend, '[]'));
END;
$$;

REVOKE EXECUTE ON FUNCTION district_insights(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION district_insights(uuid, date, date) TO authenticated;

COMMIT;

-- Check: outcomes so far, and shifts that started open (Calendar will ask about these).
SELECT status, fill_method, cancel_reason, count(*) FROM district_notices
WHERE source <> 'roster_shift' AND status <> 'open' GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
SELECT count(*) AS started_still_open FROM district_notices
WHERE source <> 'roster_shift' AND status = 'open'
  AND (shift_date + start_time) AT TIME ZONE 'Australia/Brisbane' <= now();
