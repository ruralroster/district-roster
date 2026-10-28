-- Rostar is now called Rstar. Like 2026-11-04_rostar_wording.sql, this
-- rewrites every database function that says "Rostar" (swap labels, "On the
-- Rostar card" notes, day reasons, error messages) to say "Rstar", and the
-- same in existing shift notes.
--
-- The note-stripping pattern (which removes "On the … card" from notes when
-- a doctor comes off a card) keeps matching all three spellings, so older
-- notes still get tidied.
--
-- Safe to re-run: once nothing says Rostar, it does nothing.

BEGIN;

DO $$
DECLARE
  f record;
  v_def text;
  v_count int := 0;
BEGIN
  FOR f IN
    SELECT p.oid, p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosrc LIKE '%Rostar%'
      AND p.prosrc NOT LIKE '%(?:roster-app|Rostar|Rstar)%'
  LOOP
    v_def := pg_get_functiondef(f.oid);
    -- Keep the note-stripping pattern matching the old wordings too.
    v_def := replace(v_def, '(?:roster-app|Rostar)', '@@ALL@@');
    v_def := replace(v_def, 'Rostar', 'Rstar');
    v_def := replace(v_def, '@@ALL@@', '(?:roster-app|Rostar|Rstar)');
    EXECUTE v_def;
    v_count := v_count + 1;
    RAISE NOTICE 'Reworded %', f.proname;
  END LOOP;
  RAISE NOTICE '% functions reworded', v_count;
END $$;

UPDATE district_notices SET notes = replace(notes, 'Rostar', 'Rstar') WHERE notes LIKE '%Rostar%';

-- What still says Rostar outside the note-stripping pattern (should be none).
SELECT p.proname AS still_says_rostar
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind = 'f'
  AND replace(p.prosrc, '(?:roster-app|Rostar|Rstar)', '') LIKE '%Rostar%';

COMMIT;
