-- Each site's shift types (v3's "Shift Types" tab), and importing v3's
-- vacancies as open district shifts.
--
--   1. site_shift_types: a site's regular shifts, e.g. Mareeba "Late
--      Emergency (Anaesthetics on call)" 12:30-08:00, needs Anaesthetics.
--      Posting a shift picks one to fill in the times and skill. Site
--      officers manage their own; everyone in the district can see them.
--   2. district_notices.title: the shift's name ("Emergency (Plus
--      On-call)"); source 'v3' for imported vacancies; a start equal to the
--      finish now means a 24-hour shift instead of being refused.
--   3. import_v3_shifts(): super admin only. Finds or creates the sites,
--      adds or updates their shift types (matched by name), and posts each
--      vacancy as an open shift using its site's shift type. A vacancy
--      that's already posted (same site, date and name, not cancelled) is
--      skipped, so it's safe to import the same file twice.
--
-- Run after 2026-10-24b_district_notices.sql. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS site_shift_types (
  shift_type_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(site_id) ON DELETE CASCADE,
  name text NOT NULL,
  -- Finish earlier than start: ends the next day. Equal: 24 hours.
  start_time time NOT NULL,
  end_time time NOT NULL,
  required_skill text NOT NULL DEFAULT 'Emergency',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_shift_types_skill_check CHECK (required_skill IN ('Emergency', 'Anaesthetics', 'O&G'))
);

CREATE UNIQUE INDEX IF NOT EXISTS site_shift_types_site_name_idx ON site_shift_types (site_id, lower(name));

ALTER TABLE site_shift_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "site_shift_types_select_member" ON site_shift_types;
CREATE POLICY "site_shift_types_select_member" ON site_shift_types
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM sites s WHERE s.site_id = site_shift_types.site_id AND is_district_member(s.district_id))
  );

DROP POLICY IF EXISTS "site_shift_types_write_site_officer" ON site_shift_types;
CREATE POLICY "site_shift_types_write_site_officer" ON site_shift_types
  FOR ALL TO authenticated USING (is_site_officer(site_id)) WITH CHECK (is_site_officer(site_id));

REVOKE ALL ON site_shift_types FROM anon;

ALTER TABLE district_notices ADD COLUMN IF NOT EXISTS title text;

ALTER TABLE district_notices DROP CONSTRAINT IF EXISTS district_notices_source_check;
ALTER TABLE district_notices ADD CONSTRAINT district_notices_source_check
  CHECK (source IN ('officer', 'roster_app', 'v3'));

ALTER TABLE district_notices DROP CONSTRAINT IF EXISTS district_notices_times_check;

-- p_data: {
--   sites: ["Yarrabah", ...],
--   shift_types: [{ site, name, start_time: "08:00", end_time: "08:00", required_skill, notes }],
--   vacancies: [{ site, date: "2026-10-31", name }]
-- }
CREATE OR REPLACE FUNCTION import_v3_shifts(p_district_id uuid, p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_site_name text;
  v_site_id uuid;
  v_sites jsonb := '{}';
  v_item jsonb;
  v_type site_shift_types%ROWTYPE;
  v_sites_created int := 0;
  v_types_saved int := 0;
  v_posted int := 0;
  v_already int := 0;
  v_no_type text[] := '{}';
BEGIN
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'Only a super admin can import';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM districts WHERE district_id = p_district_id) THEN
    RAISE EXCEPTION 'No such district';
  END IF;

  FOR v_site_name IN SELECT trim(value) FROM jsonb_array_elements_text(p_data->'sites') LOOP
    SELECT site_id INTO v_site_id FROM sites
    WHERE district_id = p_district_id AND lower(name) = lower(v_site_name);
    IF v_site_id IS NULL THEN
      INSERT INTO sites (district_id, name) VALUES (p_district_id, v_site_name) RETURNING site_id INTO v_site_id;
      v_sites_created := v_sites_created + 1;
    END IF;
    v_sites := v_sites || jsonb_build_object(lower(v_site_name), v_site_id);
  END LOOP;

  FOR v_item IN SELECT value FROM jsonb_array_elements(coalesce(p_data->'shift_types', '[]')) LOOP
    v_site_id := (v_sites->>lower(trim(v_item->>'site')))::uuid;
    CONTINUE WHEN v_site_id IS NULL;
    INSERT INTO site_shift_types (site_id, name, start_time, end_time, required_skill, notes)
    VALUES (
      v_site_id,
      trim(v_item->>'name'),
      (v_item->>'start_time')::time,
      (v_item->>'end_time')::time,
      coalesce(v_item->>'required_skill', 'Emergency'),
      nullif(trim(v_item->>'notes'), '')
    )
    ON CONFLICT (site_id, lower(name)) DO UPDATE SET
      start_time = EXCLUDED.start_time,
      end_time = EXCLUDED.end_time,
      required_skill = EXCLUDED.required_skill,
      notes = EXCLUDED.notes;
    v_types_saved := v_types_saved + 1;
  END LOOP;

  FOR v_item IN SELECT value FROM jsonb_array_elements(coalesce(p_data->'vacancies', '[]')) LOOP
    v_site_id := (v_sites->>lower(trim(v_item->>'site')))::uuid;
    CONTINUE WHEN v_site_id IS NULL;
    SELECT * INTO v_type FROM site_shift_types
    WHERE site_id = v_site_id AND lower(name) = lower(trim(v_item->>'name'));
    IF NOT FOUND THEN
      v_no_type := v_no_type || format('%s %s %s', v_item->>'site', v_item->>'date', v_item->>'name');
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM district_notices
      WHERE site_id = v_site_id AND shift_date = (v_item->>'date')::date
        AND lower(title) = lower(v_type.name) AND status <> 'cancelled'
    ) THEN
      v_already := v_already + 1;
      CONTINUE;
    END IF;
    INSERT INTO district_notices (district_id, site_id, shift_date, start_time, end_time, required_skill, title, notes, source)
    VALUES (p_district_id, v_site_id, (v_item->>'date')::date, v_type.start_time, v_type.end_time,
            v_type.required_skill, v_type.name, v_type.notes, 'v3');
    v_posted := v_posted + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'sites_created', v_sites_created,
    'shift_types_saved', v_types_saved,
    'vacancies_posted', v_posted,
    'vacancies_already_posted', v_already,
    'vacancies_without_shift_type', to_jsonb(v_no_type)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION import_v3_shifts(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION import_v3_shifts(uuid, jsonb) TO authenticated;

COMMIT;

-- To undo the vacancies import:
--   UPDATE district_notices SET status = 'cancelled' WHERE source = 'v3' AND status = 'open';
