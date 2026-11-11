-- Innisfail doctors go back to Innisfail only under "Sites I'd work at",
-- unless they've used DR App themselves, so a new Babinda (or any other
-- site's) shift doesn't email every Innisfail doctor who's on Rstar.
--
-- "Used DR App" is anything only DR App records: applying for a shift,
-- marking a day unavailable, offering a swap, or turning on DR App's phone
-- notifications. (A profile change alone isn't recorded anywhere, so
-- someone who only changed their sites and did nothing else is reset too;
-- they can tick them again.) Swap listings don't count: those can be made
-- from Rstar.
--
-- Anyone reset sees the first-time pop-up again, now saying they only see
-- Innisfail shifts and can add other sites in My profile.
--
-- Run in the SQL editor. Safe to re-run.

BEGIN;

CREATE TEMP TABLE innisfail_doctors ON COMMIT DROP AS
SELECT d.doctor_id, d.name, d.home_site_id,
  EXISTS (SELECT 1 FROM district_applications a WHERE a.doctor_id = d.doctor_id)
  OR EXISTS (SELECT 1 FROM district_unavailable_days u WHERE u.doctor_id = d.doctor_id)
  OR EXISTS (SELECT 1 FROM district_swap_offers o WHERE o.doctor_id = d.doctor_id)
  OR EXISTS (SELECT 1 FROM district_push_subscriptions p WHERE p.user_id = d.user_id) AS used_dr_app,
  d.interested_site_ids <> ARRAY[d.home_site_id] AS has_other_sites
FROM district_doctors d
JOIN sites s ON s.site_id = d.home_site_id
WHERE s.name ILIKE 'Innisfail%';

UPDATE district_doctors d
SET interested_site_ids = ARRAY[d.home_site_id], sites_intro_seen = false
FROM innisfail_doctors i
WHERE i.doctor_id = d.doctor_id AND i.has_other_sites AND NOT i.used_dr_app;

-- Who was reset, and who was left alone because they've used DR App.
SELECT i.name,
  CASE WHEN NOT i.has_other_sites THEN 'already Innisfail only'
       WHEN i.used_dr_app THEN 'kept: has used DR App'
       ELSE 'reset to Innisfail only' END AS result,
  (SELECT string_agg(s.name, ', ' ORDER BY s.name) FROM sites s WHERE s.site_id = ANY (d.interested_site_ids)) AS sites_now
FROM innisfail_doctors i JOIN district_doctors d ON d.doctor_id = i.doctor_id
ORDER BY result, i.name;

COMMIT;
