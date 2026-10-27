-- roster-app is now called Rostar. DR Roster's database functions build some
-- of the words people see (swap labels like "… (roster-app)", "On the
-- roster-app card", day reasons, error messages); this rewrites every
-- function that says "roster-app" to say "Rostar" instead, and the same in
-- existing shift notes.
--
-- The one place that matches on the words (stripping "On the roster-app
-- card…" from notes when a doctor comes off a card) is kept matching both
-- spellings, so notes written before this still get tidied.
--
-- Safe to re-run: once nothing says roster-app, it does nothing.

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
    WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosrc LIKE '%roster-app%'
  LOOP
    v_def := pg_get_functiondef(f.oid);
    -- Keep the note-stripping pattern matching the old wording too.
    v_def := replace(v_def, 'On the roster-app card[^·]*|Add [^·]* to the roster-app card by hand[^·]*',
                            'On the @@BOTH@@ card[^·]*|Add [^·]* to the @@BOTH@@ card by hand[^·]*');
    v_def := replace(v_def, 'roster-app', 'Rostar');
    v_def := replace(v_def, '@@BOTH@@', '(?:roster-app|Rostar)');
    EXECUTE v_def;
    v_count := v_count + 1;
    RAISE NOTICE 'Reworded %', f.proname;
  END LOOP;
  RAISE NOTICE '% functions reworded', v_count;
END $$;

UPDATE district_notices SET notes = replace(notes, 'roster-app', 'Rostar') WHERE notes LIKE '%roster-app%';

-- What still says roster-app (should be none).
SELECT p.proname AS still_says_roster_app
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosrc LIKE '%roster-app%'
  AND p.prosrc NOT LIKE '%(?:roster-app|Rostar)%';

COMMIT;
