-- For the business case: what a shift costs each site, so Insights can
-- estimate the agency cost avoided. Each site's officers set two figures
-- on the Sites tab: what an agency or locum doctor costs for a shift
-- (fees, travel, accommodation), and what the same shift costs with a
-- district doctor. Insights: shifts filled in DR App x the difference,
-- labelled as an estimate that assumes each fill would otherwise have gone
-- to agency.
--
-- Run in the Supabase SQL Editor. Safe to re-run.

BEGIN;

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS agency_shift_cost numeric CHECK (agency_shift_cost IS NULL OR agency_shift_cost >= 0),
  ADD COLUMN IF NOT EXISTS internal_shift_cost numeric CHECK (internal_shift_cost IS NULL OR internal_shift_cost >= 0);

CREATE OR REPLACE FUNCTION set_site_shift_costs(p_site_id uuid, p_agency numeric, p_internal numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_site_officer(p_site_id) THEN
    RAISE EXCEPTION 'Only this site''s officers can change this';
  END IF;
  IF (p_agency IS NOT NULL AND p_agency NOT BETWEEN 0 AND 100000) OR (p_internal IS NOT NULL AND p_internal NOT BETWEEN 0 AND 100000) THEN
    RAISE EXCEPTION 'Costs are dollars a shift, between 0 and 100,000';
  END IF;
  UPDATE sites SET agency_shift_cost = p_agency, internal_shift_cost = p_internal WHERE site_id = p_site_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION set_site_shift_costs(uuid, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_site_shift_costs(uuid, numeric, numeric) TO authenticated;

COMMIT;
