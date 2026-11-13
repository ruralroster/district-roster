-- Insights: what officers (and an LHD manager) need to see whether DR App
-- is filling vacancies, and the records that make it measurable.
--
--   district_notices.filled_at / fill_method   when a shift was filled, and
--     how: 'applied' (a doctor applied in the app) or 'officer' (an officer
--     marked it filled by someone who hadn't applied).
--   district_notices.cancelled_at / cancel_reason   why a shift was
--     cancelled: 'agency' (an agency or locum took it), 'outside_app'
--     (filled some other way, e.g. by phone), 'not_needed', 'service_closed',
--     or 'covered_locally' (an escalated roster-app offer that was covered
--     at its own site, set automatically).
--   district_site_daily   a nightly count per site: doctors with it ticked
--     under Sites I'd work at, active doctors in the district, and open
--     vacancies. Ticks get overwritten, so this is the only record of how
--     big each site's pool was over time.
--   district_insights(district, from, to)   the report, for officers.
--
-- Vacancies are district shifts posted by officers, from the v3 import, or
-- escalated from roster-app; shifts listed for swap (source roster_shift)
-- aren't vacancies and are counted separately as swaps.
--
-- Run after 2026-11-12c_innisfail_home_site_only.sql. Safe to re-run.

BEGIN;

ALTER TABLE district_notices ADD COLUMN IF NOT EXISTS filled_at timestamptz;
ALTER TABLE district_notices ADD COLUMN IF NOT EXISTS fill_method text;
ALTER TABLE district_notices ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE district_notices ADD COLUMN IF NOT EXISTS cancel_reason text;
ALTER TABLE district_notices DROP CONSTRAINT IF EXISTS district_notices_fill_method_check;
ALTER TABLE district_notices ADD CONSTRAINT district_notices_fill_method_check
  CHECK (fill_method IS NULL OR fill_method IN ('applied', 'officer'));
ALTER TABLE district_notices DROP CONSTRAINT IF EXISTS district_notices_cancel_reason_check;
ALTER TABLE district_notices ADD CONSTRAINT district_notices_cancel_reason_check
  CHECK (cancel_reason IS NULL OR cancel_reason IN ('agency', 'outside_app', 'not_needed', 'service_closed', 'covered_locally'));

-- Stamps the fill and the cancel as they happen. Runs before
-- district_notices_sync (AFTER UPDATE) approves the application, so a
-- pending application from the filling doctor is what marks it 'applied'.
CREATE OR REPLACE FUNCTION district_notices_outcome()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'filled' AND (TG_OP = 'INSERT' OR OLD.status <> 'filled') THEN
    NEW.filled_at := now();
    NEW.fill_method := CASE WHEN EXISTS (
      SELECT 1 FROM district_applications a
      WHERE a.notice_id = NEW.notice_id AND a.doctor_id = NEW.filled_by_doctor_id AND a.status IN ('pending', 'approved')
    ) THEN 'applied' ELSE 'officer' END;
  ELSIF NEW.status <> 'filled' THEN
    NEW.filled_at := NULL;
    NEW.fill_method := NULL;
  END IF;

  IF NEW.status = 'cancelled' AND (TG_OP = 'INSERT' OR OLD.status <> 'cancelled') THEN
    NEW.cancelled_at := now();
    IF NEW.cancel_reason IS NULL AND NEW.source = 'roster_app' AND NEW.notes LIKE '%Covered or withdrawn on roster-app%' THEN
      NEW.cancel_reason := 'covered_locally';
    END IF;
  ELSIF NEW.status <> 'cancelled' THEN
    NEW.cancelled_at := NULL;
    NEW.cancel_reason := NULL;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION district_notices_outcome() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS district_notices_outcome ON district_notices;
CREATE TRIGGER district_notices_outcome
  BEFORE INSERT OR UPDATE OF status ON district_notices
  FOR EACH ROW EXECUTE FUNCTION district_notices_outcome();

-- What's already there: filled when the application was approved (or the
-- last change, if an officer filled it directly); cancelled at the last
-- change, reason unknown unless it was covered on roster-app.
UPDATE district_notices n
SET filled_at = coalesce(
      (SELECT max(a.decided_at) FROM district_applications a
       WHERE a.notice_id = n.notice_id AND a.doctor_id = n.filled_by_doctor_id AND a.status = 'approved'),
      n.updated_at),
    fill_method = CASE WHEN EXISTS (
      SELECT 1 FROM district_applications a
      WHERE a.notice_id = n.notice_id AND a.doctor_id = n.filled_by_doctor_id AND a.status = 'approved'
    ) THEN 'applied' ELSE 'officer' END
WHERE n.status = 'filled' AND n.filled_at IS NULL;

UPDATE district_notices n
SET cancelled_at = n.updated_at,
    cancel_reason = CASE WHEN n.source = 'roster_app' AND n.notes LIKE '%Covered or withdrawn on roster-app%' THEN 'covered_locally' END
WHERE n.status = 'cancelled' AND n.cancelled_at IS NULL;

-- ---------------------------------------------------------------------------
-- Nightly pool size per site.

CREATE TABLE IF NOT EXISTS district_site_daily (
  day date NOT NULL,
  site_id uuid NOT NULL REFERENCES sites(site_id) ON DELETE CASCADE,
  district_id uuid NOT NULL REFERENCES districts(district_id) ON DELETE CASCADE,
  doctors_ticked int NOT NULL,
  active_doctors int NOT NULL,
  open_vacancies int NOT NULL,
  PRIMARY KEY (day, site_id)
);

ALTER TABLE district_site_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "district_site_daily_select_officer" ON district_site_daily;
CREATE POLICY "district_site_daily_select_officer" ON district_site_daily
  FOR SELECT TO authenticated USING (is_district_officer(district_id));
REVOKE ALL ON district_site_daily FROM anon;
GRANT SELECT ON district_site_daily TO authenticated;
GRANT ALL ON district_site_daily TO service_role;

CREATE OR REPLACE FUNCTION district_snapshot_sites()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO district_site_daily (day, site_id, district_id, doctors_ticked, active_doctors, open_vacancies)
  SELECT (now() AT TIME ZONE 'Australia/Brisbane')::date, s.site_id, s.district_id,
    (SELECT count(*) FROM district_doctors d
     WHERE d.district_id = s.district_id AND d.active AND d.user_id IS NOT NULL AND s.site_id = ANY (d.interested_site_ids)),
    (SELECT count(*) FROM district_doctors d WHERE d.district_id = s.district_id AND d.active AND d.user_id IS NOT NULL),
    (SELECT count(*) FROM district_notices n
     WHERE n.site_id = s.site_id AND n.status = 'open' AND n.source <> 'roster_shift'
       AND n.shift_date >= (now() AT TIME ZONE 'Australia/Brisbane')::date)
  FROM sites s
  ON CONFLICT (day, site_id) DO UPDATE SET
    doctors_ticked = EXCLUDED.doctors_ticked, active_doctors = EXCLUDED.active_doctors, open_vacancies = EXCLUDED.open_vacancies;
$$;

REVOKE EXECUTE ON FUNCTION district_snapshot_sites() FROM PUBLIC, anon, authenticated;

-- 23:55 in Brisbane (13:55 UTC), so each day's row is that day's end.
SELECT cron.unschedule('district-snapshot-sites') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'district-snapshot-sites');
SELECT cron.schedule('district-snapshot-sites', '55 13 * * *', $$SELECT district_snapshot_sites()$$);

SELECT district_snapshot_sites();

-- ---------------------------------------------------------------------------
-- The report. Shifts dated from p_from to p_to; outcomes count only shifts
-- that have started (an upcoming one isn't late yet). Per site, and the
-- whole district (site_id null).

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
  ), m AS (
    SELECT v.site_id,
      count(*) AS posted,
      count(*) FILTER (WHERE starts_at <= now() AND status <> 'cancelled') AS started,
      count(*) FILTER (WHERE starts_at <= now() AND status = 'filled' AND filled_at <= starts_at) AS filled_in_time,
      count(*) FILTER (WHERE starts_at <= now() AND (status = 'open' OR (status = 'filled' AND filled_at > starts_at))) AS unfilled,
      count(*) FILTER (WHERE status = 'filled' AND fill_method = 'applied') AS filled_by_applying,
      count(*) FILTER (WHERE status = 'filled' AND fill_method = 'officer') AS filled_by_officer,
      count(*) FILTER (WHERE status = 'filled' AND filler_home IS DISTINCT FROM site_id) AS filled_from_other_sites,
      count(*) FILTER (WHERE starts_at > now() AND status = 'open') AS upcoming_open,
      count(*) FILTER (WHERE status = 'cancelled' AND cancel_reason = 'agency') AS cancelled_agency,
      count(*) FILTER (WHERE status = 'cancelled' AND cancel_reason = 'outside_app') AS cancelled_outside_app,
      count(*) FILTER (WHERE status = 'cancelled' AND cancel_reason = 'not_needed') AS cancelled_not_needed,
      count(*) FILTER (WHERE status = 'cancelled' AND cancel_reason = 'service_closed') AS cancelled_service_closed,
      count(*) FILTER (WHERE status = 'cancelled' AND cancel_reason = 'covered_locally') AS cancelled_covered_locally,
      count(*) FILTER (WHERE status = 'cancelled' AND cancel_reason IS NULL) AS cancelled_no_reason,
      count(*) FILTER (WHERE service_disruption) AS disruption_flagged,
      count(*) FILTER (WHERE service_disruption AND status = 'filled' AND filled_at <= starts_at) AS disruption_averted,
      count(*) FILTER (WHERE service_disruption AND starts_at <= now()
        AND (status = 'open' OR (status = 'filled' AND filled_at > starts_at) OR cancel_reason = 'service_closed')) AS disruption_not_averted,
      count(*) FILTER (WHERE source = 'roster_app') AS escalated,
      count(*) FILTER (WHERE source = 'roster_app' AND status = 'filled') AS escalated_filled,
      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM filled_at - created_at)::float8 / 3600)
        FILTER (WHERE status = 'filled'))::numeric, 1) AS median_hours_to_fill,
      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_applied_at - created_at)::float8 / 3600)
        FILTER (WHERE first_applied_at IS NOT NULL))::numeric, 1) AS median_hours_to_first_applicant,
      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM starts_at - filled_at)::float8 / 86400)
        FILTER (WHERE status = 'filled'))::numeric, 1) AS median_days_filled_ahead,
      count(*) FILTER (WHERE status = 'filled' AND starts_at - filled_at < interval '48 hours') AS filled_last_48h,
      round(avg(applicants)::numeric, 1) AS applicants_per_vacancy
    FROM v
    GROUP BY GROUPING SETS ((v.site_id), ())
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

-- Check: filled and cancelled shifts so far.
SELECT status, fill_method, cancel_reason, count(*) FROM district_notices
WHERE source <> 'roster_shift' AND status <> 'open' GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
