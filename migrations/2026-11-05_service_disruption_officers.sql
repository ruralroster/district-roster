-- Service disruption belongs to officers, not to the doctor giving a shift
-- away. It means "if we don't find a doctor for this shift, the service
-- closes" (e.g. obstetrics goes on bypass), so it's set when an officer
-- posts a shift in DR Roster or offers one in Rostar, and doctors see it
-- marked. It's no longer something a doctor sets on a swap listing.
--
-- 1. district_notices.service_disruption: set on Post a shift.
-- 2. volunteer_offers.service_disruption: set on a Rostar offer, with an
--    officer UPDATE policy so it can be changed after offering; escalation
--    copies it onto the DR Roster shift.
-- 3. Swap listings: the two listing functions now always pass false, and
--    existing listings are cleared.
--
-- The functions are patched from their live definitions (like
-- 2026-11-04_rostar_wording.sql) so later rewording is kept. Each patch
-- fails loudly if the text it expects isn't there. Safe to re-run.

BEGIN;

ALTER TABLE district_notices ADD COLUMN IF NOT EXISTS service_disruption boolean NOT NULL DEFAULT false;
ALTER TABLE volunteer_offers ADD COLUMN IF NOT EXISTS service_disruption boolean NOT NULL DEFAULT false;

DROP POLICY IF EXISTS "volunteer_offers_update_officer" ON volunteer_offers;
CREATE POLICY "volunteer_offers_update_officer" ON volunteer_offers
  FOR UPDATE USING (is_department_officer(department_id))
  WITH CHECK (is_department_officer(department_id));

DO $$
DECLARE
  v_def text;
  v_new text;
BEGIN
  -- Escalation carries the offer's flag onto the DR Roster shift.
  v_def := pg_get_functiondef('district_escalate_offers()'::regprocedure);
  IF position('service_disruption' IN v_def) = 0 THEN
    -- Whitespace-tolerant: the live text's spacing can differ from the files.
    v_new := regexp_replace(v_def, 'o\.role,\s*o\.created_at,', 'o.role, o.service_disruption, o.created_at,');
    IF v_new = v_def THEN
      RAISE EXCEPTION 'district_escalate_offers(): offer columns (o.role, o.created_at) not found; not patched';
    END IF;
    v_def := v_new;
    v_new := regexp_replace(v_def, 'notes,\s*source\s*\)', 'notes, source, service_disruption)');
    IF v_new = v_def THEN
      RAISE EXCEPTION 'district_escalate_offers(): INSERT column list (notes, source) not found; not patched';
    END IF;
    v_def := v_new;
    v_new := regexp_replace(v_def, '''roster_app''(\s*)\)', '''roster_app'', v_row.service_disruption\1)');
    IF v_new = v_def THEN
      RAISE EXCEPTION 'district_escalate_offers(): VALUES ending ''roster_app'') not found; not patched';
    END IF;
    EXECUTE v_new;
  END IF;

  -- Doctors can't mark a swap listing as a service disruption.
  v_def := pg_get_functiondef('list_shift_for_swap(uuid, boolean, text[], text, boolean)'::regprocedure);
  v_new := regexp_replace(v_def, 'v_me\.doctor_id,(\s*)p_service_disruption,(\s*)p_slots', 'v_me.doctor_id,\1false,\2p_slots');
  IF v_new = v_def AND v_def !~ 'v_me\.doctor_id,\s*false,\s*p_slots' THEN
    RAISE EXCEPTION 'list_shift_for_swap() is not as expected; not patched';
  END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('list_roster_shift_for_swap(uuid, boolean, text[], text, boolean)'::regprocedure);
  v_new := regexp_replace(v_def, 'v_me\.doctor_id,(\s*)p_service_disruption,(\s*)p_slots', 'v_me.doctor_id,\1false,\2p_slots');
  IF v_new = v_def AND v_def !~ 'v_me\.doctor_id,\s*false,\s*p_slots' THEN
    RAISE EXCEPTION 'list_roster_shift_for_swap() is not as expected; not patched';
  END IF;
  EXECUTE v_new;
END;
$$;

UPDATE district_swap_listings SET service_disruption = false WHERE service_disruption;

COMMIT;
