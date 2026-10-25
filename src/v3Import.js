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
    else if (/^(o\s*&\s*g|obs|obstet)/i.test(word)) found.add('O&G');
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
