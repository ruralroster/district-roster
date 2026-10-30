// Matches each row to a shift already posted (same site, date, shift and
// level, not cancelled), one for one: two ED nights pasted when one is
// already posted leaves the second still to post. A row that repeats an
// earlier row in the same upload is marked too, but left ticked: it may
// really be two doctors needed. Rows the officer has ticked back on after
// seeing "Already posted" (kept) aren't re-checked.
export function checkAgainstPosted(rows, posted, shiftTypes) {
  const pool = [...posted];
  const seen = [];
  const same = (r, n) => {
    if (n.site_id !== r.site_id || n.shift_date !== r.date || (n.position ?? 'consultant') !== r.position) return false;
    const type = shiftTypes.find((t) => t.shift_type_id === r.type);
    return type
      ? (n.title || '').toLowerCase() === type.name.toLowerCase()
      : (n.start_time || '').slice(0, 5) === r.start_time && (n.end_time || '').slice(0, 5) === r.end_time;
  };
  return rows.map((r) => {
    if (r.kept) return r;
    const asNotice = { site_id: r.site_id, shift_date: r.date, position: r.position, start_time: r.start_time, end_time: r.end_time,
      title: shiftTypes.find((t) => t.shift_type_id === r.type)?.name ?? null };
    const i = pool.findIndex((n) => same(r, n));
    const repeat = seen.some((n) => same(r, n));
    seen.push(asNotice);
    if (i !== -1) {
      pool.splice(i, 1);
      return { ...r, post: false, already: true, repeat };
    }
    return { ...r, already: false, repeat };
  });
}
