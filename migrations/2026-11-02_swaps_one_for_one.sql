-- Swaps are always one shift for one shift.
--
-- Listing a shift must never reduce anyone's shifts in a pay fortnight
-- (that would change their FTE and contract). So:
--   - a listing must tick at least one day/night of that fortnight the
--     lister could work in return;
--   - nobody can take a listed shift outright: an offer must give the
--     lister one of your shifts at that site on one of those days;
--   - Up for swap (my_swap_market) and the "swap available" notice only
--     reach doctors with such a shift, both passing the rules as if the
--     swap had happened (district_swap_options: the check Up for swap
--     already made, now shared).
-- Picking up extra shifts is still done by applying for open district
-- shifts, not through swaps.
--
-- Open listings with no days ticked are closed (the lister is told to list
-- again), and pending take-it-outright offers are cancelled.
--
-- Run after 2026-11-01_officer_digest.sql. Safe to re-run.

BEGIN;

-- The doctor's shifts they could give the lister in return: at the same
-- site, on one of the lister's days/nights, with both of them passing the
-- rules afterwards. DR Roster bookings and roster-app shifts.
CREATE OR REPLACE FUNCTION district_swap_options(p_doctor_id uuid, p_listing_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (SELECT * FROM district_doctors WHERE doctor_id = p_doctor_id AND active),
  l AS (SELECT * FROM district_swap_listings WHERE listing_id = p_listing_id),
  n AS (SELECT dn.* FROM district_notices dn JOIN l ON dn.notice_id = l.notice_id),
  today AS (SELECT (now() AT TIME ZONE 'Australia/Brisbane')::date AS d)
  SELECT coalesce((
           -- Their DR Roster shifts at that site.
           SELECT jsonb_agg(jsonb_build_object('notice_id', o.notice_id, 'label', district_shift_text(o.notice_id))
                            ORDER BY o.shift_date, o.start_time)
           FROM district_notices o, today, me, l, n
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
             CROSS JOIN l
             CROSS JOIN n
             CROSS JOIN LATERAL district_assignment_facts(a.assignment_id, l.district_id) f
             WHERE st.user_id = (SELECT user_id FROM me) AND f.site_id = n.site_id
               AND a.date >= (SELECT d FROM today)
             ORDER BY a.staff_id, a.date, a.shift_id, a.location_id, a.assignment_id
           ) r
           JOIN sites s2 ON s2.site_id = r.site_id
           CROSS JOIN me
           CROSS JOIN l
           CROSS JOIN n
           WHERE (r.date::text || ':' || district_shift_kind(r.start_time, r.end_time)) = ANY (l.available_slots)
             AND NOT EXISTS (
               SELECT 1 FROM district_roster_shifts rs
               WHERE rs.notice_id = n.notice_id AND rs.staff_id = r.staff_id AND rs.date = r.date AND rs.shift_id IS NOT DISTINCT FROM r.shift_id)
             AND district_swap_problem_at(me.doctor_id, n.shift_date, n.start_time, n.end_time, n.position, n.required_skill,
                                          n.notice_id, NULL, r.assignment_id) IS NULL
             AND district_swap_problem_at(l.doctor_id, r.date, r.start_time, r.end_time, r.shift_position, r.skill,
                                          NULL, n.notice_id, NULL) IS NULL
         ), '[]'::jsonb);
$$;
REVOKE EXECUTE ON FUNCTION district_swap_options(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Up for swap: listings at my sites and my shifts I could give back. The
-- Swaps tab shows only those with at least one. (problem is kept for the
-- Swaps tab's sake: nobody can take one outright any more.)
CREATE OR REPLACE FUNCTION my_swap_market(p_district_id uuid)
RETURNS TABLE (listing_id uuid, problem text, swap_options jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (
    SELECT * FROM district_doctors WHERE district_id = p_district_id AND user_id = auth.uid() AND active
  )
  SELECT l.listing_id,
         'they want a shift in return'::text,
         district_swap_options(me.doctor_id, l.listing_id)
  FROM district_swap_listings l
  JOIN district_notices n ON n.notice_id = l.notice_id
  CROSS JOIN me
  WHERE l.district_id = p_district_id AND l.status = 'open' AND l.doctor_id <> me.doctor_id
    AND n.site_id = ANY (me.interested_site_ids)
    AND n.shift_date >= (now() AT TIME ZONE 'Australia/Brisbane')::date;
$$;

-- Listing: at least one day or night in return. Told: doctors who could
-- give the lister a shift back.
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
  IF cardinality(coalesce(p_slots, '{}')) = 0 THEN
    RAISE EXCEPTION 'Tick at least one day or night you could work in return: a swap has to keep your shifts in the fortnight the same';
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

  -- Doctors who could close the loop. The officer hears once someone
  -- offers (offer_for_swap).
  FOR v_doc IN
    SELECT d.doctor_id FROM district_doctors d
    WHERE d.district_id = v_notice.district_id AND d.active AND d.user_id IS NOT NULL
      AND d.doctor_id <> p_doctor_id
      AND v_notice.site_id = ANY (d.interested_site_ids)
      AND district_swap_options(d.doctor_id, v_id) <> '[]'::jsonb
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

-- Every offer gives the lister a shift back.
CREATE OR REPLACE FUNCTION district_swap_offer_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.offered_notice_id IS NULL THEN
    RAISE EXCEPTION 'A swap needs one of your shifts in return, on a day or night they can work';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION district_swap_offer_check() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS district_swap_offer_check ON district_swap_offers;
CREATE TRIGGER district_swap_offer_check
  BEFORE INSERT ON district_swap_offers
  FOR EACH ROW EXECUTE FUNCTION district_swap_offer_check();

-- What's already there under the old rules.
DO $$
DECLARE
  v_row record;
BEGIN
  FOR v_row IN
    UPDATE district_swap_offers
    SET status = 'cancelled', decline_reason = 'Swaps are now one shift for one shift', decided_at = now()
    WHERE status = 'pending' AND offered_notice_id IS NULL
    RETURNING doctor_id, listing_id
  LOOP
    PERFORM district_swap_tell_doctor(v_row.doctor_id,
      format('Your offer to take %s was cancelled: swaps are now one shift for one shift, so offer one of yours in return',
             (SELECT district_shift_text(l.notice_id) FROM district_swap_listings l WHERE l.listing_id = v_row.listing_id)),
      'Swap offer cancelled');
  END LOOP;

  FOR v_row IN
    UPDATE district_swap_listings
    SET status = 'closed', closed_at = now(),
        closed_reason = 'Swaps are now one shift for one shift: list it again with the days you could work in return'
    WHERE status = 'open' AND cardinality(available_slots) = 0
    RETURNING listing_id, doctor_id, notice_id
  LOOP
    PERFORM district_swap_tell_doctor(v_row.doctor_id,
      format('Your swap listing for %s was closed: swaps are now one shift for one shift. List it again with the days or nights you could work in return',
             district_shift_text(v_row.notice_id)),
      'Swap listing closed');
    PERFORM district_swap_cancel_offers(v_row.listing_id, 'the listing was closed', NULL);
  END LOOP;
END;
$$;

COMMIT;
