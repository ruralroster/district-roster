// Listing a shift for swap: which of the fortnight's days and nights the
// doctor couldn't work in return, so they can't tick them. Only the slot
// kind is known at this point (day or night), not the hours, so this uses
// the usual shape of each: a day can't follow a night that morning, a
// night can't come before a day the next morning, and nobody works twice
// on the same date. The exact rules (10 hours' rest, levels, skills) are
// still checked on both doctors when someone offers a shift in return.

// 'night' for a shift that runs past midnight or starts from 18:00
// (district_shift_kind).
export const shiftKind = (start, end) =>
  end.slice(0, 5) <= start.slice(0, 5) || start.slice(0, 5) >= '18:00' ? 'night' : 'day';

const addDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// shifts: [{ shift_date, start_time, end_time }], every shift the doctor
// works; listed: the one being listed; days: the fortnight's dates; today:
// days before it are gone. Returns slot ('2026-11-03:night') -> why it
// can't be ticked.
export function blockedSlots(shifts, listed, days = [], today = '', dayLabel = (d) => d) {
  const blocked = new Map();
  const block = (slot, why) => {
    if (!blocked.has(slot)) blocked.set(slot, why);
  };
  for (const d of days) {
    if (d < today) ['day', 'night'].forEach((k) => block(`${d}:${k}`, "That day's gone"));
  }
  block(`${listed.shift_date}:${shiftKind(listed.start_time, listed.end_time)}`, "That's the shift you're giving away");
  const isListed = (s) =>
    s.shift_date === listed.shift_date && s.start_time === listed.start_time && s.end_time === listed.end_time;
  for (const s of shifts) {
    if (isListed(s)) continue;
    const kind = shiftKind(s.start_time, s.end_time);
    const d = s.shift_date;
    block(`${d}:day`, `You're already working ${dayLabel(d)}`);
    block(`${d}:night`, `You're already working ${dayLabel(d)}`);
    if (kind === 'night') block(`${addDays(d, 1)}:day`, `Too soon after your night on ${dayLabel(d)}`);
    else block(`${addDays(d, -1)}:night`, `Too close to your day on ${dayLabel(d)}`);
  }
  return blocked;
}
