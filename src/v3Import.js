// Reads the v3 Google Sheet export (File > Download > .xlsx) into the
// people and sites to import. Only the Users and Rostering Officers tabs are
// read, and of Users only Email, Name, Locations, Role and AST: never the
// Password column or the TOTP, Login Sessions and Password Resets tabs.
//
// What the v3 sheet looks like:
//   - Users: one row per person per role (someone who's an officer and also
//     works shifts has an Officer row and a Staff row). The column after AST
//     is a primary site for some people, "Done" for most. Below the users,
//     in the spare columns to the right, is a list of real addresses: name,
//     site or title, email. Those win over everything else.
//   - Rostering Officers: Location, Officer Name, Email.
//   - Test rows use one address for many different people; an address
//     shared by more than two names is treated as a placeholder.
//   Anyone without a real address gets firstname.lastname@health.qld.gov.au,
//   marked as a guess for checking.

import { SKILLS } from './supabase';

// Not Queensland Health district sites: a test site, the RFDS base and the
// virtual one. Unticked to start with in the preview.
export const SITES_LEFT_OUT = ['TestHub', 'Cairns', 'Telehealth'];

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const keyOf = (name) => clean(name).toLowerCase();
const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(value));
const splitList = (value) => clean(value).split(',').map(clean).filter(Boolean);

// The same rule as roster-app's staff_default_emails.sql: title dropped,
// first and last word, letters and hyphens only.
export function guessEmail(name) {
  const words = clean(name).replace(/^(dr|prof|a\/prof|mr|mrs|ms|miss)\.?\s+/i, '').split(' ');
  const part = (w) => (w || '').toLowerCase().replace(/[^a-z-]/g, '');
  return `${part(words[0])}.${part(words[words.length - 1])}@health.qld.gov.au`;
}

// "Emergency, on, Anaesthetics" -> ['Emergency', 'Anaesthetics']. Emergency
// is always held.
export function readSkills(ast) {
  const found = new Set(['Emergency']);
  for (const word of splitList(ast)) {
    if (/^emerg/i.test(word)) found.add('Emergency');
    else if (/^ana?esth/i.test(word)) found.add('Anaesthetics');
    else if (/^(o\s*&\s*g|obs|obt)/i.test(word)) found.add('O&G'); // obt: v3's "Obtetrics"
    else if (/^(endo|scope)/i.test(word)) found.add('Endoscopy');
  }
  return SKILLS.filter((s) => found.has(s));
}

// sheets: { [tab name]: rows as arrays, header row first }.
// Returns { sites, people } with every site the sheet mentions; planImport
// then applies the sites chosen in the preview.
export function readV3(sheets) {
  const users = sheets['Users'];
  const officerRows = sheets['Rostering Officers'];
  if (!users) throw new Error('No "Users" tab. Is this the v3 roster sheet?');

  const header = users[0].map(clean);
  const col = (name) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const [cEmail, cName, cLocations, cRole, cAst] = ['Email', 'Name', 'Locations', 'Role', 'AST'].map(col);
  if ([cEmail, cName, cLocations, cRole].includes(-1)) {
    throw new Error('The Users tab is missing an Email, Name, Locations or Role column.');
  }
  const cPrimary = Math.max(cEmail, cName, cLocations, cRole, cAst) + 1;

  const people = new Map();
  const person = (name) => {
    const key = keyOf(name);
    if (!people.has(key)) {
      people.set(key, { key, name: clean(name), sheetEmails: [], realEmail: '', doctor: null, officerSites: [] });
    }
    return people.get(key);
  };
  const addAll = (list, items) => items.forEach((i) => !list.includes(i) && list.push(i));
  const sites = [];

  for (const row of users.slice(1)) {
    const name = clean(row[cName]);
    if (!name) {
      // The list of real addresses: name, site or title, email.
      const extra = row.slice(cPrimary).map(clean);
      const at = extra.findIndex(isEmail);
      const sideName = extra.slice(0, at).find((v) => v && v !== 'Done');
      if (at > 0 && sideName) person(sideName).realEmail = extra[at].toLowerCase();
      continue;
    }
    const p = person(name);
    if (isEmail(row[cEmail])) p.sheetEmails.push(clean(row[cEmail]).toLowerCase());
    const locations = splitList(row[cLocations]);
    addAll(sites, locations);
    if (/^officer$/i.test(clean(row[cRole]))) {
      addAll(p.officerSites, locations);
    } else {
      p.doctor ??= { sites: [], primary: '', skills: ['Emergency'] };
      addAll(p.doctor.sites, locations);
      p.doctor.skills = readSkills([...p.doctor.skills, ...splitList(row[cAst])].join(','));
      const primary = clean(row[cPrimary]);
      if (locations.includes(primary)) p.doctor.primary = primary;
    }
  }

  if (officerRows) {
    const oHeader = officerRows[0].map(clean);
    const [oSite, oName, oEmail] = ['Location', 'Officer Name', 'Email'].map((n) => oHeader.indexOf(n));
    for (const row of officerRows.slice(1)) {
      const name = clean(row[oName]);
      const site = clean(row[oSite]);
      if (!name || !site) continue;
      const p = person(name);
      addAll(p.officerSites, [site]);
      addAll(sites, [site]);
      if (isEmail(row[oEmail])) p.sheetEmails.push(clean(row[oEmail]).toLowerCase());
    }
  }

  // An address on more than two people's rows is a test placeholder.
  const namesPerEmail = new Map();
  for (const p of people.values()) {
    for (const e of new Set(p.sheetEmails)) namesPerEmail.set(e, (namesPerEmail.get(e) || 0) + 1);
  }

  const result = [...people.values()].map((p) => {
    const sheetEmail = p.sheetEmails.find((e) => namesPerEmail.get(e) <= 2);
    const email = p.realEmail || sheetEmail || guessEmail(p.name);
    return {
      key: p.key,
      name: p.name,
      email,
      emailSource: p.realEmail ? 'real' : sheetEmail ? 'sheet' : 'guess',
      doctor: p.doctor,
      officerSites: p.officerSites,
    };
  });

  return { sites: sites.sort(), people: result.sort((a, b) => a.name.localeCompare(b.name)) };
}

// The people as they'd be imported with only the chosen sites: doctors
// whose sites are all left out aren't doctors here, officers lose left-out
// sites, and anyone left with nothing is in `skipped`.
export function planImport({ people }, chosenSites) {
  const chosen = new Set(chosenSites);
  const included = [];
  const skipped = [];
  for (const p of people) {
    const doctorSites = p.doctor ? p.doctor.sites.filter((s) => chosen.has(s)) : [];
    const officerSites = p.officerSites.filter((s) => chosen.has(s));
    // Home site: the sheet's primary site, else where they're an officer,
    // else the first they work at. Changeable in the preview.
    const doctor = doctorSites.length
      ? {
          sites: doctorSites,
          homeSite: [p.doctor.primary, ...officerSites, ...doctorSites].find((s) => doctorSites.includes(s)),
          skills: p.doctor.skills,
        }
      : null;
    (doctor || officerSites.length ? included : skipped).push({ ...p, doctor, officerSites });
  }
  return { included, skipped };
}

// ============================================================
// SHIFT TYPES AND VACANCIES
// ============================================================

// A time cell: a fraction of a day (0.3333 = 08:00, 1 = midnight) or
// "12:20" text. "" if neither.
export function readTime(value) {
  if (typeof value === 'number') {
    const minutes = Math.round(value * 24 * 60) % (24 * 60);
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }
  const m = clean(value).match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
}

// A date cell: an Excel day number or "27/06/2026" (v3 writes dd/mm/yyyy).
// "2026-06-27", or "" if neither.
export function readDate(value) {
  if (typeof value === 'number') {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const m = clean(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
}

// v3's "Required AST" column, or, when it's blank, the shift's name
// ("Anaesthetics Day" needs Anaesthetics). guessed says which.
function shiftSkill(requiredAst, name) {
  const fromAst = readSkills(requiredAst).find((s) => s !== 'Emergency');
  if (fromAst) return { skill: fromAst, guessed: false };
  if (clean(requiredAst)) return { skill: 'Emergency', guessed: false };
  const fromName = readSkills(name.replace(/\s+/g, ',').replace(/[()]/g, '')).find((s) => s !== 'Emergency');
  return { skill: fromName || 'Emergency', guessed: !!fromName };
}

// sheets: the "Shift Types" tab and every "Vacancies - <site>" and "Master
// Vacancies" tab, read with raw values (numbers stay numbers).
// Returns { shiftTypes, vacancies } for every site; vacancies are one per
// site, date and name, each with the matching shift type if there is one.
export function readV3Shifts(sheets) {
  const types = sheets['Shift Types'];
  if (!types) throw new Error('No "Shift Types" tab. Is this the v3 roster sheet?');
  const header = types[0].map(clean);
  const [cName, cSite, cStart, cEnd, cAst, cNotes] = ['Job Type', 'Location', 'Start Time', 'End Time', 'Required AST', 'Notes'].map(
    (n) => header.indexOf(n),
  );

  const shiftTypes = [];
  const typeKey = (site, name) => `${site.toLowerCase()}|${name.toLowerCase()}`;
  const byKey = new Map();
  for (const row of types.slice(1)) {
    const name = clean(row[cName]);
    const site = clean(row[cSite]);
    const start = readTime(row[cStart]);
    const end = readTime(row[cEnd]);
    if (!name || !site || !start || !end || byKey.has(typeKey(site, name))) continue;
    const { skill, guessed } = shiftSkill(row[cAst], name);
    const type = { site, name, start, end, skill, skillGuessed: guessed, notes: clean(row[cNotes]) };
    byKey.set(typeKey(site, name), type);
    shiftTypes.push(type);
  }

  const seen = new Set();
  const vacancies = [];
  for (const [tab, rows] of Object.entries(sheets)) {
    if (!/^vacancies - |^master vacancies$/i.test(tab)) continue;
    const h = rows[0].map(clean);
    const [cDate, cJob, cLoc] = ['Date', 'Job Type', 'Location'].map((n) => h.indexOf(n));
    for (const row of rows.slice(1)) {
      const date = readDate(row[cDate]);
      const name = clean(row[cJob]);
      const site = clean(row[cLoc]);
      const key = `${site.toLowerCase()}|${date}|${name.toLowerCase()}`;
      if (!date || !name || !site || seen.has(key)) continue;
      seen.add(key);
      vacancies.push({ site, date, name, shiftType: byKey.get(typeKey(site, name)) ?? null });
    }
  }
  vacancies.sort((a, b) => a.date.localeCompare(b.date) || a.site.localeCompare(b.site));
  return { shiftTypes, vacancies };
}
