// Reads vacancies out of pasted text (an email, a WhatsApp message) for one
// site, using that site's shift types. Runs in the browser; nothing is
// sent anywhere. It's a best guess: the Calendar shows what it found to
// check and correct before anything is posted.
//
// Understands, a line at a time:
//   dates     27/10, 27/10/26, 27.10.2026, 27 Oct, Tue 27th October,
//             October 27, 27-29 Oct, 27/10-29/10, today, tomorrow,
//             tonight, and a weekday on its own (the next one).
//   shifts    a shift type's name, or enough of it ("night", "late on
//             call", "anaes OC"); else times like 0800-2000 or 8am-8pm.
// A line with dates but no shift uses the shift on the following lines
// (and a line with a shift but no date uses the last date), so
//   Mon 3 Nov
//   - Day
//   - Night
// is two shifts.

import { toLocalDateStr } from './dateUtils';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?';
const WEEKDAY = '\\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\\b';

// Words that mean the same thing in shift names and messages.
const ALIASES = [
  [/\bon[\s-]?call\b|\boc\b/g, ' oncall '],
  [/\banaesthetics?\b|\banaes\b|\banaesth\b|\bgas\b/g, ' anaes '],
  [/\bobstetrics?\b|\bobtetrics\b|\bobs\b|\bo\s*&\s*g\b|\bmaternity\b/g, ' obs '],
  [/\bemergency\b/g, ' ed '],
  [/\bnights?\b|\bovernight\b/g, ' night '],
  [/\bdays?\b/g, ' day '],
  [/\blates?\b|\bevening\b/g, ' late '],
  [/\bearly\b|\bam\b/g, ' early '],
];
const IGNORED = new Set(['shift', 'the', 'plus', 'and', 'with', 'of', 'a', 'cover']);

function words(text) {
  let t = ` ${text.toLowerCase().replace(/[()/,:;.!?'"+]/g, ' ')} `;
  for (const [pattern, replacement] of ALIASES) t = t.replace(pattern, replacement);
  return t.split(/\s+/).filter((w) => w && !IGNORED.has(w) && !/^\d/.test(w));
}

const fullYear = (y) => (y < 100 ? 2000 + y : y);

// A date without a year is this year's, unless that's over two months ago
// (then next year's: "3 Jan" posted in December).
function withYear(month, day, today) {
  const d = new Date(today.getFullYear(), month, day);
  const twoMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 2, today.getDate());
  if (d < twoMonthsAgo) d.setFullYear(d.getFullYear() + 1);
  return d;
}

function dateOf(year, month, day, today) {
  const d = year ? new Date(fullYear(year), month, day) : withYear(month, day, today);
  return d.getMonth() === month && d.getDate() === day ? d : null;
}

function range(first, last) {
  const out = [];
  if (!first || !last || last < first) return first ? [first] : [];
  for (const d = new Date(first); d <= last && out.length < 62; d.setDate(d.getDate() + 1)) out.push(new Date(d));
  return out;
}

// Every date on a line, in order. weekdays: whether a weekday on its own
// ("Tue") counts as the next one.
export function datesIn(line, today = new Date(), { weekdays = true } = {}) {
  const text = line.toLowerCase();
  const found = [];
  const taken = [];
  const add = (index, length, dates) => {
    if (taken.some(([s, e]) => index < e && index + length > s)) return;
    taken.push([index, index + length]);
    dates.filter(Boolean).forEach((d) => found.push({ index, date: d }));
  };
  const monthIndex = (name) => MONTHS.indexOf(name.slice(0, 3));
  const each = (pattern, fn) => {
    for (const m of text.matchAll(new RegExp(pattern, 'gi'))) add(m.index, m[0].length, fn(m));
  };

  // 27/10/26-29/10/26, 27/10-29/10
  each('\\b(\\d{1,2})[/.](\\d{1,2})(?:[/.](\\d{2,4}))?\\s*(?:-|–|to)\\s*(\\d{1,2})[/.](\\d{1,2})(?:[/.](\\d{2,4}))?\\b', (m) =>
    range(dateOf(+m[3] || +m[6] || 0, m[2] - 1, +m[1], today), dateOf(+m[6] || +m[3] || 0, m[5] - 1, +m[4], today)));
  // 27-29/10
  each('\\b(\\d{1,2})\\s*(?:-|–)\\s*(\\d{1,2})[/.](\\d{1,2})(?:[/.](\\d{2,4}))?\\b', (m) =>
    range(dateOf(+m[4] || 0, m[3] - 1, +m[1], today), dateOf(+m[4] || 0, m[3] - 1, +m[2], today)));
  // 27/10, 27/10/2026, 27.10.26
  each('\\b(\\d{1,2})[/.](\\d{1,2})(?:[/.](\\d{2,4}))?\\b', (m) => [dateOf(+m[3] || 0, m[2] - 1, +m[1], today)]);
  // 27th-29th Oct, 27 to 29 October 2026
  each(`\\b${DAY}\\s*(?:-|–|to)\\s*${DAY}\\s+(?:of\\s+)?${MONTH}\\b(?:\\s+(20\\d{2}))?`, (m) =>
    range(dateOf(+m[4] || 0, monthIndex(m[3]), +m[1], today), dateOf(+m[4] || 0, monthIndex(m[3]), +m[2], today)));
  // 27 Oct, 27th of October 2026
  each(`\\b${DAY}\\s+(?:of\\s+)?${MONTH}\\b(?:\\s+(20\\d{2}))?`, (m) => [dateOf(+m[3] || 0, monthIndex(m[2]), +m[1], today)]);
  // October 27th, Oct 27 2026
  each(`\\b${MONTH}\\s+${DAY}\\b(?:,?\\s+(20\\d{2}))?`, (m) => [dateOf(+m[3] || 0, monthIndex(m[1]), +m[2], today)]);
  // today, tonight, tomorrow
  each('\\b(today|tonight|tomorrow|tmrw)\\b', (m) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (m[1].startsWith('t') && m[1] !== 'today' && m[1] !== 'tonight') d.setDate(d.getDate() + 1);
    return [d];
  });
  // A weekday with no date next to it: the next one, today included.
  if (weekdays && !found.length) {
    each(WEEKDAY, (m) => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      d.setDate(d.getDate() + ((WEEKDAYS.indexOf(m[1]) - d.getDay() + 7) % 7));
      return [d];
    });
  }

  return found.sort((a, b) => a.index - b.index).map((f) => toLocalDateStr(f.date));
}

// "0800-2000", "08:00 - 20:00", "8am-8pm", "8:30pm to 8am" -> times.
export function timesIn(line) {
  const t = '(\\d{1,2})(?::?(\\d{2}))?\\s*(am|pm)?';
  const m = line.toLowerCase().match(new RegExp(`\\b${t}\\s*(?:-|–|to)\\s*${t}\\b`));
  if (!m) return null;
  const hhmm = (h, min, ampm) => {
    let hour = +h;
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (hour > 23 || +(min || 0) > 59) return null;
    return `${String(hour).padStart(2, '0')}:${min || '00'}`;
  };
  // Bare numbers like 27-29 are dates, not times: need 4 digits, a colon or am/pm.
  const looksLikeTime = (h, min, ampm) => ampm || min !== undefined;
  if (!looksLikeTime(m[1], m[2], m[3]) || !looksLikeTime(m[4], m[5], m[6])) return null;
  const start = hhmm(m[1], m[2], m[3]);
  const end = hhmm(m[4], m[5], m[6]);
  return start && end ? { start, end } : null;
}

// The site's shift type that the line names best, or null. Each word of a
// shift type's name found in the line counts for it, each missing one half
// against (the site's own name is ignored: "Tully Night" is "night" at
// Tully). So "late anaes on call" picks "Late Emergency (Anaesthetics on
// call)" over "Late Emergency ED (on call)".
export function shiftTypeIn(line, shiftTypes, siteName = '') {
  const lineWords = new Set(words(line));
  const siteWords = new Set(words(siteName));
  let best = null;
  let bestScore = -Infinity;
  for (const type of shiftTypes) {
    const needed = [...new Set(words(type.name))].filter((w) => !siteWords.has(w));
    const matched = needed.filter((w) => lineWords.has(w)).length;
    const score = matched - (needed.length - matched) / 2;
    if (matched > 0 && score > bestScore) {
      best = type;
      bestScore = score;
    }
  }
  return best;
}

// The vacancies in a pasted message: [{ date, shiftType, times, line }]
// where shiftType is one of shiftTypes or null, and times is { start, end }
// when the line gave times instead. Neither means a date was given with no
// shift to go with it. unread: lines naming a shift with no date to use.
// The level a line asks for: "reg", "registrar" or "PHO" is a registrar
// shift; "intern" an intern one; "RMO", "junior", "JHO", "SHO" or
// "resident" an RMO one; anything else a consultant shift.
export function positionIn(text) {
  if (/\b(reg|regs|registrar|registrars|pho)\b/i.test(text)) return 'registrar';
  if (/\b(intern|interns)\b/i.test(text)) return 'intern';
  if (/\b(rmo|rmos|junior|jho|sho|resident)\b/i.test(text)) return 'rmo';
  return 'consultant';
}

export function readPastedVacancies(text, shiftTypes, siteName, today = new Date()) {
  const vacancies = [];
  const unread = [];
  // Dates from a line with no shift on it: for the lines below.
  let heading = [];
  let headingUsed = true;
  const endHeading = () => {
    if (!headingUsed) heading.forEach((date) => vacancies.push({ date, shiftType: null, times: null, line: '' }));
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // "Nights 10/11-12/11, day tomorrow" is two lots; "Tue, 28/10 late"
    // is one. Split at commas only when more than one part has a date.
    const parts = line.split(/[,;]/);
    const dated = parts.filter((p) => datesIn(p, today, { weekdays: false }).length);
    const pieces = dated.length > 1 ? parts : [line];

    // Within a line, dates with no shift take the next part's shift:
    // "1/11, 2/11 late obs on call" is both days.
    let pending = [];
    for (const piece of pieces) {
      const dates = datesIn(piece, today, { weekdays: pieces.length === 1 });
      const shiftType = shiftTypeIn(piece, shiftTypes, siteName);
      const times = shiftType ? null : timesIn(piece);
      if (!shiftType && !times) {
        pending.push(...dates);
        continue;
      }
      let useDates = [...pending, ...dates];
      pending = [];
      if (!useDates.length) {
        useDates = heading;
        headingUsed = true;
      }
      if (!useDates.length) unread.push(piece.trim());
      useDates.forEach((date) => vacancies.push({ date, shiftType, times, line }));
    }
    if (pending.length) {
      endHeading();
      heading = pending;
      headingUsed = false;
    }
  }
  endHeading();
  return { vacancies, unread };
}
