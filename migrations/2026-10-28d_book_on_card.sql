-- Approved district doctors go onto the roster-app card themselves, and
-- shifts posted in DR Roster are matched to roster-app offers instead of
-- being posted a second time.
--
-- 1. Booking onto the card. When a district shift that came from a
--    roster-app offer is filled (approved, or booked by an officer):
--      - the doctor is staff in that roster-app department: booked on the
--        card in the offer's role, working the card's hours (the Planner
--        fits them into a place, like any booking without one);
--      - otherwise: their name goes in a free visitor (or staff-or-visitor)
--        place for that role on the card's job;
--      - no place for them: nothing is added and the shift's notes say to
--        add them by hand, and why.
--    The outcome is added to the shift's notes ("On the roster-app card").
--    The roster-app offer is removed at the same time. If the shift is
--    reopened, cancelled or given to someone else, the booking comes off
--    the card again, and reopening puts the offer back.
--
-- 2. Shifts posted in DR Roster (the Calendar, Add several shifts, the v3
--    import) are open to the district at once, as before; nothing is held
--    local. New here: if a roster-app offer is for the same site, date and
--    hours as one of them, the offer is linked to that shift instead of
--    being escalated as a second copy, so filling it books the doctor onto
--    the card. As with escalated shifts, if the gap is then covered or
--    withdrawn on roster-app, the district shift is cancelled.
--
-- Run after 2026-10-28c_escalation.sql. Safe to re-run.

BEGIN;

ALTER TABLE district_escalations
  ADD COLUMN IF NOT EXISTS assignment_id uuid,
  ADD COLUMN IF NOT EXISTS visitor_id uuid;
-- A posted shift can be linked to at most one offer.
CREATE UNIQUE INDEX IF NOT EXISTS district_escalations_notice_idx ON district_escalations (notice_id);

-- The notes without an earlier booking outcome.
CREATE OR REPLACE FUNCTION district_strip_card_note(p_notes text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT nullif(trim(BOTH ' ·' FROM regexp_replace(
    coalesce(p_notes, ''),
    '(\s·\s)?(On the roster-app card[^·]*|Add [^·]* to the roster-app card by hand[^·]*)',
    '', 'g')), '');
$$;

-- Puts the doctor on the card of the escalation's offer and takes the
-- offer off roster-app. Returns the note for the shift.
CREATE OR REPLACE FUNCTION district_book_on_card(p_notice_id uuid, p_doctor_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_esc district_escalations%ROWTYPE;
  v_card theatre_activities%ROWTYPE;
  v_doc district_doctors%ROWTYPE;
  v_start time;
  v_end time;
  v_staff_id uuid;
  v_shift_id uuid;
  v_place_id uuid;
  v_slot int;
  v_id uuid;
BEGIN
  SELECT * INTO v_esc FROM district_escalations WHERE notice_id = p_notice_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_doc FROM district_doctors WHERE doctor_id = p_doctor_id;
  SELECT * INTO v_card FROM theatre_activities WHERE theatre_activity_id = v_esc.theatre_activity_id;
  IF NOT FOUND THEN
    RETURN format('Add %s to the roster-app card by hand (the card has been deleted)', v_doc.name);
  END IF;

  BEGIN
    SELECT coalesce(v_card.start_time, sh.start_time), coalesce(v_card.end_time, sh.end_time)
    INTO v_start, v_end
    FROM (SELECT 1) x LEFT JOIN shifts sh ON sh.shift_id = v_card.shift_id;

    -- Staff in that department: an ordinary booking.
    SELECT staff_id INTO v_staff_id FROM staff
    WHERE user_id = v_doc.user_id AND department_id = v_card.department_id AND active
    LIMIT 1;
    IF v_doc.user_id IS NOT NULL AND v_staff_id IS NOT NULL THEN
      v_shift_id := coalesce(v_card.shift_id, (
        SELECT shift_id FROM shifts
        WHERE department_id = v_card.department_id AND start_time = v_start AND end_time = v_end AND active
        LIMIT 1));
      IF v_shift_id IS NOT NULL THEN
        INSERT INTO staff_assignments (department_id, date, location_id, staff_id, shift_id, role, theatre_activity_id, place_id, on_call)
        VALUES (v_card.department_id, v_card.date, v_card.location_id, v_staff_id, v_shift_id, v_esc.role, v_card.theatre_activity_id, NULL, false)
        RETURNING assignment_id INTO v_id;
        UPDATE district_escalations SET assignment_id = v_id WHERE notice_id = p_notice_id;
        DELETE FROM volunteer_offers WHERE volunteer_offer_id = v_esc.volunteer_offer_id;
        RETURN 'On the roster-app card';
      END IF;
    END IF;

    -- Anyone else: a visitor place for the role, if the card's job has one
    -- free. A senior place is a consultant's, a junior place a registrar's.
    SELECT p.place_id, s.slot INTO v_place_id, v_slot
    FROM job_places p
    CROSS JOIN LATERAL generate_series(0, p.min_count - 1) AS s(slot)
    WHERE p.job_type_id = v_card.job_type_id
      AND p.kind IN ('visitor', 'either')
      AND (p.grade = 'any' OR (p.grade = 'senior') = (v_esc.role = 'consultant'))
      AND NOT EXISTS (
        SELECT 1 FROM theatre_activity_visitors v
        WHERE v.theatre_activity_id = v_card.theatre_activity_id AND v.place_id = p.place_id AND v.slot = s.slot)
    ORDER BY (p.kind = 'visitor'), p.sort_order, s.slot
    LIMIT 1;
    IF v_place_id IS NOT NULL THEN
      INSERT INTO theatre_activity_visitors (department_id, theatre_activity_id, place_id, slot, name)
      VALUES (v_card.department_id, v_card.theatre_activity_id, v_place_id, v_slot, v_doc.name)
      RETURNING visitor_id INTO v_id;
      UPDATE district_escalations SET visitor_id = v_id WHERE notice_id = p_notice_id;
      DELETE FROM volunteer_offers WHERE volunteer_offer_id = v_esc.volunteer_offer_id;
      RETURN 'On the roster-app card as a visitor';
    END IF;

    DELETE FROM volunteer_offers WHERE volunteer_offer_id = v_esc.volunteer_offer_id;
    RETURN format('Add %s to the roster-app card by hand (%s)', v_doc.name,
      CASE WHEN v_staff_id IS NOT NULL THEN 'no roster-app shift matches the card''s hours'
           ELSE 'they aren''t staff there and the card has no free visitor place' END);
  EXCEPTION WHEN OTHERS THEN
    -- Never stop the approval because roster-app said no.
    RETURN format('Add %s to the roster-app card by hand (%s)', v_doc.name, SQLERRM);
  END;
END;
$$;

-- Takes our booking back off the card; when the shift is open again, puts
-- the roster-app offer back (as filled as the card now is).
CREATE OR REPLACE FUNCTION district_unbook_from_card(p_notice_id uuid, p_reoffer boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_esc district_escalations%ROWTYPE;
  v_offer_id uuid;
BEGIN
  SELECT * INTO v_esc FROM district_escalations WHERE notice_id = p_notice_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  DELETE FROM staff_assignments WHERE assignment_id = v_esc.assignment_id;
  DELETE FROM theatre_activity_visitors WHERE visitor_id = v_esc.visitor_id;
  UPDATE district_escalations SET assignment_id = NULL, visitor_id = NULL WHERE notice_id = p_notice_id;

  IF p_reoffer THEN
    INSERT INTO volunteer_offers (volunteer_offer_id, department_id, theatre_activity_id, role, filled_baseline)
    SELECT v_esc.volunteer_offer_id, ta.department_id, ta.theatre_activity_id, v_esc.role,
           (SELECT count(*) FROM staff_assignments a WHERE a.theatre_activity_id = ta.theatre_activity_id AND a.role = v_esc.role)
    FROM theatre_activities ta WHERE ta.theatre_activity_id = v_esc.theatre_activity_id
    -- An officer already offered it again: link to that offer instead.
    ON CONFLICT (theatre_activity_id, role) DO UPDATE SET role = EXCLUDED.role
    RETURNING volunteer_offer_id INTO v_offer_id;
    IF v_offer_id IS NOT NULL AND v_offer_id <> v_esc.volunteer_offer_id THEN
      UPDATE district_escalations SET volunteer_offer_id = v_offer_id WHERE notice_id = p_notice_id;
    END IF;
  END IF;
END;
$$;

-- Before the shift's status or filler changes, so the outcome goes in the
-- same update's notes.
CREATE OR REPLACE FUNCTION district_notices_card()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_was_booked boolean := OLD.status = 'filled' AND OLD.filled_by_doctor_id IS NOT NULL;
  v_now_booked boolean := NEW.status = 'filled' AND NEW.filled_by_doctor_id IS NOT NULL;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM district_escalations WHERE notice_id = NEW.notice_id) THEN
    RETURN NEW;
  END IF;
  IF v_was_booked = v_now_booked AND OLD.filled_by_doctor_id IS NOT DISTINCT FROM NEW.filled_by_doctor_id THEN
    RETURN NEW;
  END IF;

  IF v_was_booked THEN
    PERFORM district_unbook_from_card(NEW.notice_id, NEW.status = 'open');
    NEW.notes := district_strip_card_note(NEW.notes);
  END IF;
  IF v_now_booked THEN
    NEW.notes := concat_ws(' · ', district_strip_card_note(NEW.notes), district_book_on_card(NEW.notice_id, NEW.filled_by_doctor_id));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS district_notices_card ON district_notices;
CREATE TRIGGER district_notices_card
  BEFORE UPDATE OF status, filled_by_doctor_id ON district_notices
  FOR EACH ROW EXECUTE FUNCTION district_notices_card();

REVOKE EXECUTE ON FUNCTION district_book_on_card(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_unbook_from_card(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION district_notices_card() FROM PUBLIC, anon, authenticated;

-- As in 2026-10-28c, with a new first step: link offers to shifts already
-- posted in DR Roster.
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
     AND n.source <> 'roster_app'
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

  RETURN jsonb_build_object('linked', v_linked, 'escalated', v_escalated, 'cancelled', v_cancelled, 'offers_removed', v_offers_removed);
END;
$$;

REVOKE EXECUTE ON FUNCTION district_escalate_offers() FROM PUBLIC, anon, authenticated;

COMMIT;
