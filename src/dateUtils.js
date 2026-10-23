// Same helpers as roster-app's dateUtils.js / payrollExport.js.

export function toLocalDateStr(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getMondayOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

export function isSameDate(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// "08:00–17:00", or "22:00–08:00 (+1)" for a shift ending the next day.
export function formatShiftTime(start, end) {
  const s = start.slice(0, 5);
  const e = end.slice(0, 5);
  return `${s}–${e}${e < s ? ' (+1)' : ''}`;
}
