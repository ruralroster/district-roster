-- The swap marketplace (step 3), after v3's.
--
-- A doctor lists a DR Roster shift they're booked on, saying whether
-- missing it would disrupt the service, and which days and nights of that
-- pay fortnight they could work in return. Other doctors who could do the
-- shift then either take it outright, or offer one of their own shifts at
-- the same site on one of those days or nights in return. The rest and
-- clash rules are checked for both doctors: each as if they'd already
-- given up their own shift. The site's officer approves or declines (with
-- a reason); approving moves the bookings, and the roster-app card follows
-- (district_notices_card).
--
--   district_swap_listings   one per listed shift (open → taken, withdrawn
--                            by the doctor, removed by an officer, or
--                            closed when the shift changes some other way)
--   district_swap_offers     take-it (offered_notice_id NULL) or swap offers
--   district_swap_messages   who to tell what; district-notify sends them
--
-- Everything goes through the functions below; the tables are read-only
-- from the app.
--
-- Run after 2026-10-29_day_status.sql. Safe to re-run.

BEGIN;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

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
-- Helpers
-- ---------------------------------------------------------------------------

-- The rest/clash rule as if the doctor had already given up p_except (the
-- shift they'd swap away). Same rules as 2026-10-29_day_status.sql's
-- district_rest_problem, which is now this with nothing given up.
CREATE OR REPLACE FUNCTION district_rest_problem_except(p_doctor_id uuid, p_notice_id uuid, p_except uuid)
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
      AND n.notice_id IS DISTINCT FROM p_except
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

CREATE OR REPLACE FUNCTION district_rest_problem(p_doctor_id uuid, p_notice_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT district_rest_problem_except(p_doctor_id, p_notice_id, NULL);
$$;

-- Why the doctor couldn't work p_notice_id (giving up p_except), or NULL:
-- level, skill, a blocked day, rest. Sites they'd work at aren't checked:
-- a swap is between two people who've chosen it.
CREATE OR REPLACE FUNCTION district_swap_problem(p_doctor_id uuid, p_notice_id uuid, p_except uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN district_level_rank(d.level) < district_level_rank(n.position)
      THEN format('It''s a %s shift, above %s''s level', replace(n.position, 'rmo', 'RMO'), d.name)
    WHEN NOT n.required_skill = ANY (d.skills)
      THEN format('It needs %s, which %s doesn''t have', n.required_skill, d.name)
    ELSE coalesce(district_day_unavailable_reason(d.doctor_id, n.notice_id),
                  district_rest_problem_except(d.doctor_id, n.notice_id, p_except))
  END
  FROM district_doctors d, district_notices n
  WHERE d.doctor_id = p_doctor_id AND n.notice_id = p_notice_id;
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

REVOKE EXECUTE ON FUNCTION district_rest_problem_except(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_rest_problem(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_swap_problem(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_shift_text(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_swap_tell_doctor(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_swap_tell_officers(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_swap_cancel_offers(uuid, text, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Listing
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION list_shift_for_swap(p_notice_id uuid, p_service_disruption boolean, p_slots text[], p_note text DEFAULT NULL)
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
  v_line text;
  v_doc record;
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
  IF v_notice.shift_date < (now() AT TIME ZONE 'Australia/Brisbane')::date THEN
    RAISE EXCEPTION 'This shift is in the past';
  END IF;
  IF EXISTS (SELECT 1 FROM district_swap_listings WHERE notice_id = p_notice_id AND status = 'open') THEN
    RAISE EXCEPTION 'This shift is already listed';
  END IF;
  v_start := district_fortnight_start(v_notice.shift_date);
  FOREACH v_slot IN ARRAY coalesce(p_slots, '{}') LOOP
    IF v_slot !~ '^\d{4}-\d{2}-\d{2}:(day|night)$'
       OR split_part(v_slot, ':', 1)::date NOT BETWEEN v_start AND v_start + 13 THEN
      RAISE EXCEPTION 'Days you could work in return must be in the same pay fortnight';
    END IF;
  END LOOP;

  INSERT INTO district_swap_listings (district_id, notice_id, doctor_id, service_disruption, available_slots, note)
  VALUES (v_notice.district_id, p_notice_id, v_me.doctor_id, coalesce(p_service_disruption, false),
          coalesce(p_slots, '{}'), nullif(trim(p_note), ''))
  RETURNING listing_id INTO v_id;

  v_line := format('%s%s listed %s for swap', CASE WHEN p_service_disruption THEN 'SERVICE DISRUPTION: ' ELSE '' END,
                   v_me.name, district_shift_text(p_notice_id));
  PERFORM district_swap_tell_officers(v_notice.site_id, v_line, 'Shift listed for swap');

  -- Doctors who could take it, as for a new shift.
  FOR v_doc IN
    SELECT d.doctor_id FROM district_doctors d
    WHERE d.district_id = v_notice.district_id AND d.active AND d.user_id IS NOT NULL
      AND d.doctor_id <> v_me.doctor_id
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
  UPDATE district_swap_listings SET status = 'withdrawn', closed_at = now() WHERE listing_id = p_listing_id;
  PERFORM district_swap_cancel_offers(p_listing_id, 'the listing was withdrawn');
  PERFORM district_swap_tell_officers((SELECT site_id FROM district_notices WHERE notice_id = v_listing.notice_id),
    format('Swap listing withdrawn: %s', district_shift_text(v_listing.notice_id)), 'Swap listing withdrawn');
END;
$$;

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
    RAISE EXCEPTION 'Only this site''s officers can remove it';
  END IF;
  IF v_listing.status <> 'open' THEN
    RAISE EXCEPTION 'It''s no longer listed';
  END IF;
  UPDATE district_swap_listings
  SET status = 'removed', closed_reason = nullif(trim(p_reason), ''), closed_at = now()
  WHERE listing_id = p_listing_id;
  PERFORM district_swap_cancel_offers(p_listing_id, 'the listing was taken down');
  PERFORM district_swap_tell_doctor(v_listing.doctor_id,
    format('Your swap listing was taken down by an officer%s: %s',
           coalesce(' (' || nullif(trim(p_reason), '') || ')', ''), district_shift_text(v_listing.notice_id)),
    'Swap listing taken down');
END;
$$;

-- ---------------------------------------------------------------------------
-- The marketplace, and offering
-- ---------------------------------------------------------------------------

-- For the signed-in doctor: each open listing in the district (not theirs)
-- at a site they'd work at, with why they can't take it outright (NULL if
-- they can) and which of their own shifts they could swap for it.
CREATE OR REPLACE FUNCTION my_swap_market(p_district_id uuid)
RETURNS TABLE (listing_id uuid, problem text, swap_options uuid[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (
    SELECT * FROM district_doctors WHERE district_id = p_district_id AND user_id = auth.uid() AND active
  )
  SELECT l.listing_id,
         district_swap_problem(me.doctor_id, l.notice_id, NULL),
         coalesce((
           SELECT array_agg(o.notice_id ORDER BY o.shift_date, o.start_time)
           FROM district_notices o
           WHERE o.filled_by_doctor_id = me.doctor_id AND o.status = 'filled'
             AND o.site_id = n.site_id AND o.notice_id <> n.notice_id
             AND o.shift_date >= (now() AT TIME ZONE 'Australia/Brisbane')::date
             AND (o.shift_date::text || ':' || district_shift_kind(o.start_time, o.end_time)) = ANY (l.available_slots)
             AND district_swap_problem(me.doctor_id, n.notice_id, o.notice_id) IS NULL
             AND district_swap_problem(l.doctor_id, o.notice_id, n.notice_id) IS NULL
         ), '{}')
  FROM district_swap_listings l
  JOIN district_notices n ON n.notice_id = l.notice_id
  CROSS JOIN me
  WHERE l.district_id = p_district_id AND l.status = 'open' AND l.doctor_id <> me.doctor_id
    AND n.site_id = ANY (me.interested_site_ids)
    AND n.shift_date >= (now() AT TIME ZONE 'Australia/Brisbane')::date;
$$;

CREATE OR REPLACE FUNCTION offer_for_swap(p_listing_id uuid, p_offered_notice_id uuid DEFAULT NULL, p_note text DEFAULT NULL)
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

  IF p_offered_notice_id IS NOT NULL THEN
    SELECT * INTO v_offered FROM district_notices WHERE notice_id = p_offered_notice_id;
    IF NOT FOUND OR v_offered.filled_by_doctor_id IS DISTINCT FROM v_me.doctor_id OR v_offered.status <> 'filled' THEN
      RAISE EXCEPTION 'You can only offer a shift you''re booked on';
    END IF;
    IF v_offered.site_id <> v_notice.site_id THEN
      RAISE EXCEPTION 'A swap has to be for a shift at the same site';
    END IF;
    IF NOT (v_offered.shift_date::text || ':' || district_shift_kind(v_offered.start_time, v_offered.end_time)) = ANY (v_listing.available_slots) THEN
      RAISE EXCEPTION 'That isn''t one of the days or nights they can work in return';
    END IF;
    v_problem := district_swap_problem(v_listing.doctor_id, p_offered_notice_id, v_listing.notice_id);
    IF v_problem IS NOT NULL THEN
      RAISE EXCEPTION 'They couldn''t do your shift: %', v_problem;
    END IF;
  END IF;
  v_problem := district_swap_problem(v_me.doctor_id, v_listing.notice_id, p_offered_notice_id);
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problem;
  END IF;

  INSERT INTO district_swap_offers (listing_id, doctor_id, offered_notice_id, note)
  VALUES (p_listing_id, v_me.doctor_id, p_offered_notice_id, nullif(trim(p_note), ''))
  RETURNING offer_id INTO v_id;

  PERFORM district_swap_tell_officers(v_notice.site_id,
    CASE WHEN p_offered_notice_id IS NULL
      THEN format('%s offered to take %s from %s', v_me.name, district_shift_text(v_notice.notice_id),
                  (SELECT name FROM district_doctors WHERE doctor_id = v_listing.doctor_id))
      ELSE format('%s proposed a swap with %s: their %s for %s', v_me.name,
                  (SELECT name FROM district_doctors WHERE doctor_id = v_listing.doctor_id),
                  district_shift_text(p_offered_notice_id), district_shift_text(v_notice.notice_id))
    END,
    'Swap offer to review');
  PERFORM district_swap_tell_doctor(v_listing.doctor_id,
    CASE WHEN p_offered_notice_id IS NULL
      THEN format('%s offered to take your %s (waiting for an officer)', v_me.name, district_shift_text(v_notice.notice_id))
      ELSE format('%s offered their %s for your %s (waiting for an officer)', v_me.name,
                  district_shift_text(p_offered_notice_id), district_shift_text(v_notice.notice_id))
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
-- Deciding
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

  -- Move the bookings (the roster-app card follows, via district_notices_card).
  UPDATE district_notices SET filled_by_doctor_id = v_taker.doctor_id WHERE notice_id = v_notice.notice_id;
  IF v_offer.offered_notice_id IS NOT NULL THEN
    UPDATE district_notices SET filled_by_doctor_id = v_lister.doctor_id WHERE notice_id = v_offered.notice_id;
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
  v_line text;
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
  v_line := format('Swap not approved%s: %s', coalesce(' (' || nullif(trim(p_reason), '') || ')', ''),
                   district_shift_text(v_listing.notice_id));
  PERFORM district_swap_tell_doctor(v_offer.doctor_id, v_line, 'Swap not approved');
  PERFORM district_swap_tell_doctor(v_listing.doctor_id,
    format('%s''s offer for your shift was not approved%s: %s', (SELECT name FROM district_doctors WHERE doctor_id = v_offer.doctor_id),
           coalesce(' (' || nullif(trim(p_reason), '') || ')', ''), district_shift_text(v_listing.notice_id)),
    'Swap not approved');
END;
$$;

-- A listed shift that changes some other way (an officer reopens,
-- cancels or rebooks it) comes off the marketplace.
CREATE OR REPLACE FUNCTION district_swap_listing_follow()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_listing record;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.filled_by_doctor_id IS NOT DISTINCT FROM OLD.filled_by_doctor_id THEN
    RETURN NEW;
  END IF;
  FOR v_listing IN
    UPDATE district_swap_listings SET status = 'closed', closed_reason = 'The shift changed', closed_at = now()
    WHERE notice_id = NEW.notice_id AND status = 'open'
    RETURNING listing_id, doctor_id
  LOOP
    PERFORM district_swap_cancel_offers(v_listing.listing_id, 'the shift changed');
    PERFORM district_swap_tell_doctor(v_listing.doctor_id,
      format('Your swap listing has closed because the shift changed: %s', district_shift_text(NEW.notice_id)),
      'Swap listing closed');
  END LOOP;
  -- A shift someone offered in return that's no longer theirs: just that
  -- offer goes.
  FOR v_listing IN
    UPDATE district_swap_offers o
    SET status = 'cancelled', decline_reason = 'the shift you offered changed', decided_at = now()
    WHERE o.offered_notice_id = NEW.notice_id AND o.status = 'pending'
      AND (NEW.status <> 'filled' OR NEW.filled_by_doctor_id IS DISTINCT FROM o.doctor_id)
    RETURNING o.listing_id, o.doctor_id
  LOOP
    PERFORM district_swap_tell_doctor(v_listing.doctor_id,
      format('Swap offer closed (the shift you offered changed): %s',
             district_shift_text((SELECT notice_id FROM district_swap_listings WHERE listing_id = v_listing.listing_id))),
      'Swap offer closed');
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS district_swap_listing_follow ON district_notices;
CREATE TRIGGER district_swap_listing_follow
  AFTER UPDATE OF status, filled_by_doctor_id ON district_notices
  FOR EACH ROW EXECUTE FUNCTION district_swap_listing_follow();

REVOKE EXECUTE ON FUNCTION district_swap_listing_follow() FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION list_shift_for_swap(uuid, boolean, text[], text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION withdraw_swap_listing(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION remove_swap_listing(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION my_swap_market(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION offer_for_swap(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION withdraw_swap_offer(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION approve_swap_offer(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION decline_swap_offer(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION list_shift_for_swap(uuid, boolean, text[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION withdraw_swap_listing(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION remove_swap_listing(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION my_swap_market(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION offer_for_swap(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION withdraw_swap_offer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION approve_swap_offer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION decline_swap_offer(uuid, text) TO authenticated;

COMMIT;
