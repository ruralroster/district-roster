import { useState } from 'react';
import { supabase } from './supabase';
import { readV3, readV3Shifts, planImport, SITES_LEFT_OUT } from './v3Import';
import { formatShiftTime, toLocalDateStr } from './dateUtils';

const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

// Super admins only: the v3 Google Sheet's people, shift types and
// vacancies into a district, with a preview to check first. Nobody is
// invited or emailed.
export default function ImportV3({ districts, onImported }) {
  const [districtId, setDistrictId] = useState(districts[0]?.district_id ?? '');
  const [read, setRead] = useState(null);
  const [shifts, setShifts] = useState(null);
  const [chosenSites, setChosenSites] = useState([]);
  // Per person (by key): { left: true } to leave out, email, homeSite.
  const [edits, setEdits] = useState({});
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  async function openFile(e) {
    const file = e.target.files[0];
    setError('');
    setResult(null);
    setRead(null);
    setShifts(null);
    setEdits({});
    if (!file) return;
    try {
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(await file.arrayBuffer());
      // Only these tabs are read; the rest (passwords, sessions) never are.
      const wanted = /^(users|rostering officers|shift types|master vacancies)$|^vacancies - /i;
      const sheets = {};
      for (const name of workbook.SheetNames.filter((n) => wanted.test(n))) {
        sheets[name] = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '' });
      }
      const found = readV3(sheets);
      const foundShifts = readV3Shifts(sheets);
      const sites = [...new Set([...found.sites, ...foundShifts.shiftTypes.map((t) => t.site)])].sort();
      setRead({ ...found, sites });
      setShifts(foundShifts);
      setChosenSites(sites.filter((s) => !SITES_LEFT_OUT.includes(s)));
    } catch (err) {
      setError(err.message);
    }
  }

  if (!districts.length) return null;

  const plan = read ? planImport(read, chosenSites) : null;
  const people = (plan?.included ?? []).map((p) => {
    const edit = edits[p.key] ?? {};
    return {
      ...p,
      left: !!edit.left,
      email: edit.email ?? p.email,
      emailChanged: edit.email !== undefined && edit.email !== p.email,
      homeSite: edit.homeSite ?? p.doctor?.homeSite,
    };
  });
  const going = people.filter((p) => !p.left);
  const emailCounts = going.reduce((m, p) => m.set(p.email.trim().toLowerCase(), (m.get(p.email.trim().toLowerCase()) || 0) + 1), new Map());
  const problem = (p) =>
    !isEmail(p.email) ? 'Not an email address' : emailCounts.get(p.email.trim().toLowerCase()) > 1 ? 'Same email as someone else' : '';
  const blocked = going.some(problem);
  const doctorCount = going.filter((p) => p.doctor).length;
  const officerCount = going.filter((p) => p.officerSites.length).length;

  const edit = (key, change) => setEdits((all) => ({ ...all, [key]: { ...all[key], ...change } }));
  const toggleSite = (site) =>
    setChosenSites((sites) => (sites.includes(site) ? sites.filter((s) => s !== site) : [...sites, site].sort()));

  async function runImport() {
    setBusy(true);
    setError('');
    const data = {
      sites: chosenSites,
      people: going.map((p) => ({
        name: p.name,
        email: p.email.trim().toLowerCase(),
        doctor: p.doctor ? { home_site: p.homeSite, skills: p.doctor.skills, sites: p.doctor.sites } : null,
        officer_sites: p.officerSites,
      })),
    };
    const { data: counts, error } = await supabase.rpc('import_v3_people', { p_district_id: districtId, p_data: data });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setResult(counts);
    onImported();
  }

  return (
    <div className="card stack">
      <h2>Import from v3</h2>
      <p className="small muted">
        In the v3 Google Sheet: File &gt; Download &gt; Microsoft Excel (.xlsx), then choose that file here. You'll see
        everything before anything is saved. Nobody is invited or emailed.
      </p>
      <div className="inline">
        <select value={districtId} onChange={(e) => setDistrictId(e.target.value)}>
          {districts.map((d) => (
            <option key={d.district_id} value={d.district_id}>{d.name}</option>
          ))}
        </select>
        <input type="file" accept=".xlsx" onChange={openFile} />
      </div>
      {error && <p className="error">{error}</p>}
      {result && (
        <p className="ok">
          Imported: {result.sites_created} new sites, {result.doctors_added} doctors
          {result.doctors_existing > 0 && ` (${result.doctors_existing} already here, left as they were)`},{' '}
          {result.officers_added} officers with a login, {result.officers_pending} officers waiting for a login.
        </p>
      )}

      {read && (
        <>
          <div className="stack">
            <strong>Sites</strong>
            <div className="inline">
              {read.sites.map((site) => (
                <label key={site} className="chip check">
                  <input type="checkbox" checked={chosenSites.includes(site)} onChange={() => toggleSite(site)} />
                  {site}
                </label>
              ))}
            </div>
            <p className="small muted">Existing sites with the same name are used, not duplicated.</p>
          </div>

          <div className="stack">
            <strong>People ({going.length})</strong>
            <p className="small muted">
              <span className="badge guess">guessed</span> means the sheet had no real address, so it's
              firstname.lastname@health.qld.gov.au. Check those before anyone is invited.
            </p>
            <ul className="rows">
              {people.map((p) => (
                <li key={p.key} className={`row column${p.left ? ' inactive' : ''}`}>
                  <div className="inline">
                    <label className="inline">
                      <input type="checkbox" checked={!p.left} onChange={() => edit(p.key, { left: !p.left })} />
                      <strong>{p.name}</strong>
                    </label>
                    <input
                      type="email"
                      value={p.email}
                      disabled={p.left}
                      onChange={(e) => edit(p.key, { email: e.target.value })}
                    />
                    {p.emailSource === 'guess' && !p.emailChanged && <span className="badge guess">guessed</span>}
                  </div>
                  {!p.left && problem(p) && <span className="error small">{problem(p)}</span>}
                  <div className="small">
                    {p.doctor && (
                      <div className="inline">
                        <span>Doctor ({p.doctor.skills.join(', ')}), home site</span>
                        <select value={p.homeSite} disabled={p.left} onChange={(e) => edit(p.key, { homeSite: e.target.value })}>
                          {p.doctor.sites.map((s) => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                        </select>
                        {p.doctor.sites.length > 1 && <span className="muted">works at {p.doctor.sites.join(', ')}</span>}
                      </div>
                    )}
                    {p.officerSites.length > 0 && <div>Officer for {p.officerSites.join(', ')}</div>}
                  </div>
                </li>
              ))}
            </ul>
            {plan.skipped.length > 0 && (
              <p className="small muted">
                Not imported (only at sites left out): {plan.skipped.map((p) => p.name).join(', ')}
              </p>
            )}
          </div>

          <button onClick={runImport} disabled={busy || blocked || !going.length}>
            {busy ? 'Importing…' : `Import ${chosenSites.length} sites, ${doctorCount} doctors, ${officerCount} officers`}
          </button>

          {shifts && <ShiftsImport districtId={districtId} shifts={shifts} chosenSites={chosenSites} onImported={onImported} />}
        </>
      )}
    </div>
  );
}

// The chosen sites' shift types, and their vacancies from today on, posted
// as open shifts. Separate from the people so either can be redone.
function ShiftsImport({ districtId, shifts, chosenSites, onImported }) {
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const today = toLocalDateStr(new Date());
  const chosen = new Set(chosenSites);
  const types = shifts.shiftTypes.filter((t) => chosen.has(t.site));
  const atSites = shifts.vacancies.filter((v) => chosen.has(v.site));
  const vacancies = atSites.filter((v) => v.date >= today);
  const pastCount = atSites.length - vacancies.length;
  const postable = vacancies.filter((v) => v.shiftType);
  const typeSites = chosenSites.filter((site) => types.some((t) => t.site === site));
  const skillText = (skill) => (skill === 'Emergency' ? 'Any doctor' : `Needs ${skill}`);

  async function runImport() {
    setBusy(true);
    setError('');
    const data = {
      sites: typeSites,
      shift_types: types.map((t) => ({
        site: t.site, name: t.name, start_time: t.start, end_time: t.end, required_skill: t.skill, notes: t.notes,
      })),
      vacancies: postable.map((v) => ({ site: v.site, date: v.date, name: v.name })),
    };
    const { data: counts, error } = await supabase.rpc('import_v3_shifts', { p_district_id: districtId, p_data: data });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setResult(counts);
    onImported();
  }

  return (
    <div className="stack">
      <strong>Shift types ({types.length})</strong>
      {typeSites.map((site) => (
        <div key={site} className="small">
          <div><strong>{site}</strong></div>
          <ul className="rows">
            {types.filter((t) => t.site === site).map((t) => (
              <li key={t.name} className="row">
                <span>{t.name}</span>
                <span className="muted">
                  {formatShiftTime(t.start, t.end)} · {skillText(t.skill)}
                  {t.skillGuessed && <span className="badge guess">from the name</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="small muted">
        <span className="badge guess">from the name</span> v3 had no required skill for these, so it's worked out from the
        shift's name. Officers can change shift types on the Sites tab.
      </p>

      <strong>Vacancies from today ({vacancies.length})</strong>
      <ul className="rows small">
        {vacancies.map((v) => (
          <li key={`${v.site}|${v.date}|${v.name}`} className="row">
            <span>{new Date(`${v.date}T00:00`).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span>
            <span>{v.site}: {v.name}</span>
            {v.shiftType ? (
              <span className="muted">{formatShiftTime(v.shiftType.start, v.shiftType.end)}</span>
            ) : (
              <span className="error">No {v.site} shift type with this name, so not imported</span>
            )}
          </li>
        ))}
      </ul>
      {pastCount > 0 && <p className="small muted">{pastCount} vacancies before today aren't imported.</p>}

      {error && <p className="error">{error}</p>}
      {result && (
        <p className="ok">
          Imported: {result.shift_types_saved} shift types, {result.vacancies_posted} open shifts posted
          {result.vacancies_already_posted > 0 && ` (${result.vacancies_already_posted} were already posted)`}.
          {result.vacancies_without_shift_type.length > 0 && ` Not posted: ${result.vacancies_without_shift_type.join('; ')}.`}
        </p>
      )}
      <button onClick={runImport} disabled={busy || !types.length}>
        {busy ? 'Importing…' : `Import ${types.length} shift types and ${postable.length} vacancies`}
      </button>
    </div>
  );
}
