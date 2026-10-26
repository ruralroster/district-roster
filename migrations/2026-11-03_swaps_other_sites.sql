-- Swaps across sites.
--
-- A doctor listing a shift can say they'd also take a shift in return at
-- another of the sites they'd work at (district_swap_listings.other_sites).
-- A doctor looking for a swap can then look at other sites too (Up for
-- swap and Find a swap's "Look across sites" checkbox, off by default;
-- p_other_sites): e.g.
-- give your Innisfail anaesthetic shift to an Atherton doctor who'll come
-- to Innisfail, and do their Atherton shift. All the usual rules apply to
-- both doctors (level, skills, blocked days, 10-hour rest, same pay
-- fortnight, one shift for one shift), and each must be a site the doctor
-- would work at.
--
-- Each site is getting a different doctor, so both sites' officers
-- approve (district_swap_offers.listing_site_approved_by /
-- offered_site_approved_by); the swap happens on the second approval.
-- Either site's officers can decline it.
--
-- Run after 2026-11-02_swaps_one_for_one.sql. Safe to re-run.

BEGIN;

ALTER TABLE district_swap_listings ADD COLUMN IF NOT EXISTS other_sites boolean NOT NULL DEFAULT false;
ALTER TABLE district_swap_offers ADD COLUMN IF NOT EXISTS listing_site_approved_by uuid REFERENCES profiles(user_id) ON DELETE SET NULL;
ALTER TABLE district_swap_offers ADD COLUMN IF NOT EXISTS offered_site_approved_by uuid REFERENCES profiles(user_id) ON DELETE SET NULL;

-- The officers of the site of the shift offered in return see the offer.
CREATE OR REPLACE FUNCTION district_is_offered_site_officer(p_notice_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce((SELECT is_site_officer(site_id) FROM district_notices WHERE notice_id = p_notice_id), false);
$$;
REVOKE EXECUTE ON FUNCTION district_is_offered_site_officer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION district_is_offered_site_officer(uuid) TO authenticated;

DROP POLICY IF EXISTS "district_swap_offers_select_involved" ON district_swap_offers;
CREATE POLICY "district_swap_offers_select_involved" ON district_swap_offers
  FOR SELECT TO authenticated
  USING (district_can_see_swap_offer(listing_id, doctor_id) OR district_is_offered_site_officer(offered_notice_id));

-- Shifts that could be given in return, optionally at other sites.
DROP FUNCTION IF EXISTS district_swap_options(uuid, uuid);
CREATE OR REPLACE FUNCTION district_swap_options(p_doctor_id uuid, p_listing_id uuid, p_other_sites boolean DEFAULT false)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (SELECT * FROM district_doctors WHERE doctor_id = p_doctor_id AND active),
  l AS (SELECT * FROM district_swap_listings WHERE listing_id = p_listing_id),
  n AS (SELECT dn.* FROM district_notices dn JOIN l ON dn.notice_id = l.notice_id),
  -- The sites a shift in return can be at: the listed shift's, or (when
  -- asked, and the lister will) any site the lister would work at.
  ok_sites AS (
    SELECT n.site_id FROM n
    UNION
    SELECT unnest(d.interested_site_ids) FROM l JOIN district_doctors d ON d.doctor_id = l.doctor_id
    WHERE p_other_sites AND l.other_sites
  ),
  today AS (SELECT (now() AT TIME ZONE 'Australia/Brisbane')::date AS d)
  SELECT coalesce((
           -- Their DR Roster shifts at that site.
           SELECT jsonb_agg(jsonb_build_object('notice_id', o.notice_id, 'label', district_shift_text(o.notice_id))
                            ORDER BY o.shift_date, o.start_time)
           FROM district_notices o, today, me, l, n
           WHERE o.filled_by_doctor_id = me.doctor_id AND o.status = 'filled' AND o.source <> 'roster_shift'
             AND o.site_id IN (SELECT site_id FROM ok_sites) AND o.notice_id <> n.notice_id AND o.shift_date >= today.d
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
             WHERE st.user_id = (SELECT user_id FROM me) AND f.site_id IN (SELECT site_id FROM ok_sites)
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
REVOKE EXECUTE ON FUNCTION district_swap_options(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS my_swap_market(uuid);
CREATE OR REPLACE FUNCTION my_swap_market(p_district_id uuid, p_other_sites boolean DEFAULT false)
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
         district_swap_options(me.doctor_id, l.listing_id, p_other_sites)
  FROM district_swap_listings l
  JOIN district_notices n ON n.notice_id = l.notice_id
  CROSS JOIN me
  WHERE l.district_id = p_district_id AND l.status = 'open' AND l.doctor_id <> me.doctor_id
    AND n.site_id = ANY (me.interested_site_ids)
    AND n.shift_date >= (now() AT TIME ZONE 'Australia/Brisbane')::date;
$$;
REVOKE EXECUTE ON FUNCTION my_swap_market(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_swap_market(uuid, boolean) TO authenticated;

DROP FUNCTION IF EXISTS district_create_listing(uuid, uuid, boolean, text[], text);
CREATE OR REPLACE FUNCTION district_create_listing(p_notice_id uuid, p_doctor_id uuid, p_service_disruption boolean, p_slots text[], p_note text,
                                                   p_other_sites boolean)
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

  INSERT INTO district_swap_listings (district_id, notice_id, doctor_id, service_disruption, available_slots, note, other_sites)
  VALUES (v_notice.district_id, p_notice_id, p_doctor_id, coalesce(p_service_disruption, false),
          coalesce(p_slots, '{}'), nullif(trim(p_note), ''), coalesce(p_other_sites, false))
  RETURNING listing_id INTO v_id;

  -- Doctors who could close the loop. The officer hears once someone
  -- offers (offer_for_swap).
  FOR v_doc IN
    SELECT d.doctor_id FROM district_doctors d
    WHERE d.district_id = v_notice.district_id AND d.active AND d.user_id IS NOT NULL
      AND d.doctor_id <> p_doctor_id
      AND v_notice.site_id = ANY (d.interested_site_ids)
      AND district_swap_options(d.doctor_id, v_id, true) <> '[]'::jsonb
  LOOP
    PERFORM district_swap_tell_doctor(v_doc.doctor_id,
      format('%sSwap available from %s: %s', CASE WHEN p_service_disruption THEN 'SERVICE DISRUPTION: ' ELSE '' END,
             v_me.name, district_shift_text(p_notice_id)),
      'Shift up for swap');
  END LOOP;
  RETURN v_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION district_create_listing(uuid, uuid, boolean, text[], text, boolean) FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS list_shift_for_swap(uuid, boolean, text[], text);
CREATE OR REPLACE FUNCTION list_shift_for_swap(p_notice_id uuid, p_service_disruption boolean, p_slots text[], p_note text DEFAULT NULL,
                                               p_other_sites boolean DEFAULT false)
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
  RETURN district_create_listing(p_notice_id, v_me.doctor_id, p_service_disruption, p_slots, p_note, p_other_sites);
END;
$$;

DROP FUNCTION IF EXISTS list_roster_shift_for_swap(uuid, boolean, text[], text);
CREATE OR REPLACE FUNCTION list_roster_shift_for_swap(p_assignment_id uuid, p_service_disruption boolean, p_slots text[], p_note text DEFAULT NULL,
                                                      p_other_sites boolean DEFAULT false)
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
                                 p_service_disruption, p_slots, p_note, p_other_sites);
END;
$$;

REVOKE EXECUTE ON FUNCTION list_shift_for_swap(uuid, boolean, text[], text, boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION list_roster_shift_for_swap(uuid, boolean, text[], text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION list_shift_for_swap(uuid, boolean, text[], text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION list_roster_shift_for_swap(uuid, boolean, text[], text, boolean) TO authenticated;

-- Offering: a shift at another site is fine if the lister said so and
-- would work there; that site's officers are told too.
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
  v_lister district_doctors%ROWTYPE;
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
  SELECT * INTO v_lister FROM district_doctors WHERE doctor_id = v_listing.doctor_id;
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
    IF v_offered.site_id <> v_notice.site_id
       AND NOT (v_listing.other_sites AND v_offered.site_id = ANY (v_lister.interested_site_ids)) THEN
      RAISE EXCEPTION 'A swap has to be for a shift at the same site, unless they''ll take one at another of their sites';
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
  -- A swap across sites: the other site's officers approve too.
  IF v_offered_id IS NOT NULL AND v_offered.site_id <> v_notice.site_id THEN
    PERFORM district_swap_tell_officers(v_offered.site_id,
      format('%s proposed a swap across sites with %s: %s comes to your %s, and %s goes to %s. Both sites'' officers approve it on the Swaps tab',
             v_me.name, v_lister.name, v_lister.name, district_shift_text(v_offered_id), v_me.name, district_shift_text(v_notice.notice_id)),
      'Swap offer to review');
  END IF;
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

-- Approving: across sites, both sites' officers.
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
  v_cross boolean;
  v_waiting uuid;
BEGIN
  SELECT * INTO v_offer FROM district_swap_offers WHERE offer_id = p_offer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That offer no longer exists';
  END IF;
  SELECT * INTO v_listing FROM district_swap_listings WHERE listing_id = v_offer.listing_id;
  SELECT * INTO v_notice FROM district_notices WHERE notice_id = v_listing.notice_id;
  SELECT * INTO v_offered FROM district_notices WHERE notice_id = v_offer.offered_notice_id;
  v_cross := FOUND AND v_offered.site_id <> v_notice.site_id;
  IF NOT (is_site_officer(v_notice.site_id) OR (v_cross AND is_site_officer(v_offered.site_id))) THEN
    RAISE EXCEPTION 'Only the officers of the sites involved can approve swaps';
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

  -- Across sites, each site's officers approve the doctor coming to them;
  -- the swap happens once both have.
  IF v_cross THEN
    IF NOT ((v_offer.listing_site_approved_by IS NULL AND is_site_officer(v_notice.site_id))
            OR (v_offer.offered_site_approved_by IS NULL AND is_site_officer(v_offered.site_id))) THEN
      RAISE EXCEPTION 'Your site has already approved this; it''s waiting for the other site''s officers';
    END IF;
    UPDATE district_swap_offers
    SET listing_site_approved_by = CASE WHEN listing_site_approved_by IS NULL AND is_site_officer(v_notice.site_id)
                                        THEN auth.uid() ELSE listing_site_approved_by END,
        offered_site_approved_by = CASE WHEN offered_site_approved_by IS NULL AND is_site_officer(v_offered.site_id)
                                        THEN auth.uid() ELSE offered_site_approved_by END
    WHERE offer_id = p_offer_id
    RETURNING * INTO v_offer;
    v_waiting := CASE WHEN v_offer.listing_site_approved_by IS NULL THEN v_notice.site_id
                      WHEN v_offer.offered_site_approved_by IS NULL THEN v_offered.site_id END;
    IF v_waiting IS NOT NULL THEN
      PERFORM district_swap_tell_officers(v_waiting,
        format('%s''s officers approved the swap of %s (%s) for %s (%s). It needs your approval too, on the Swaps tab',
               (SELECT name FROM sites WHERE site_id = CASE WHEN v_waiting = v_notice.site_id THEN v_offered.site_id ELSE v_notice.site_id END),
               district_shift_text(v_notice.notice_id), v_lister.name, district_shift_text(v_offered.notice_id), v_taker.name),
        'Swap waiting for you');
      RETURN;
    END IF;
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

-- Declining: either site's officers.
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
  IF NOT (is_site_officer((SELECT site_id FROM district_notices WHERE notice_id = v_listing.notice_id))
          OR is_site_officer((SELECT site_id FROM district_notices WHERE notice_id = v_offer.offered_notice_id))) THEN
    RAISE EXCEPTION 'Only the officers of the sites involved can decline swaps';
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

COMMIT;
