-- DR Roster is now called DR App. Like 2026-11-06_rstar_wording.sql, this
-- rewrites every database function that says "DR Roster" (error messages)
-- to say "DR App".
--
-- Safe to re-run: once nothing says DR Roster, it does nothing.

BEGIN;

DO $$
DECLARE
  f record;
  v_count int := 0;
BEGIN
  FOR f IN
    SELECT p.oid, p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosrc LIKE '%DR Roster%'
  LOOP
    EXECUTE replace(pg_get_functiondef(f.oid), 'DR Roster', 'DR App');
    v_count := v_count + 1;
    RAISE NOTICE 'Reworded %', f.proname;
  END LOOP;
  RAISE NOTICE '% functions reworded', v_count;
END $$;

UPDATE district_notices SET notes = replace(notes, 'DR Roster', 'DR App') WHERE notes LIKE '%DR Roster%';

COMMIT;

-- What still says DR Roster (should be none).
SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosrc LIKE '%DR Roster%';
