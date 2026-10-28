-- Rstar's Available Shifts calendar shows swaps a staff member could take,
-- alongside shifts offered for volunteering. Only swaps at their own
-- department's site ("internal" swaps); swaps across sites stay in DR Roster.
--
-- my_department_swaps(department) returns the open listings at the site
-- linked to that department, other than the caller's own, where the caller
-- has a shift to give in return (district_swap_options, same site only), or
-- has already offered one. The caller must be a DR Roster doctor in that
-- site's district; otherwise it returns nothing. Offering and withdrawing
-- use the existing offer_for_swap / withdraw_swap_offer.
--
-- Safe to re-run.

BEGIN;

CREATE OR REPLACE FUNCTION my_department_swaps(p_department_id uuid)
RETURNS TABLE (listing_id uuid, shift_date date, start_time time, end_time time, shift_label text,
               lister text, note text, swap_options jsonb, my_offer_id uuid, my_offer_label text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH s AS (
    SELECT site_id, district_id FROM sites WHERE department_id = p_department_id
  ),
  me AS (
    SELECT DISTINCT ON (d.district_id) d.*
    FROM district_doctors d JOIN s ON s.district_id = d.district_id
    WHERE d.user_id = auth.uid() AND d.active
  ),
  rows AS (
    SELECT l.listing_id, n.shift_date, n.start_time, n.end_time, district_shift_text(n.notice_id) AS shift_label,
           ld.name AS lister, l.note,
           district_swap_options(me.doctor_id, l.listing_id, false) AS swap_options,
           o.offer_id AS my_offer_id,
           CASE WHEN o.offered_notice_id IS NOT NULL THEN district_shift_text(o.offered_notice_id) END AS my_offer_label
    FROM district_swap_listings l
    JOIN district_notices n ON n.notice_id = l.notice_id
    JOIN s ON s.site_id = n.site_id AND s.district_id = l.district_id
    JOIN me ON me.district_id = l.district_id
    JOIN district_doctors ld ON ld.doctor_id = l.doctor_id
    LEFT JOIN district_swap_offers o ON o.listing_id = l.listing_id AND o.doctor_id = me.doctor_id AND o.status = 'pending'
    WHERE l.status = 'open' AND l.doctor_id <> me.doctor_id
      AND n.shift_date >= (now() AT TIME ZONE 'Australia/Brisbane')::date
  )
  SELECT * FROM rows
  WHERE swap_options <> '[]'::jsonb OR my_offer_id IS NOT NULL
  ORDER BY shift_date, start_time;
$$;
REVOKE EXECUTE ON FUNCTION my_department_swaps(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_department_swaps(uuid) TO authenticated;

COMMIT;
