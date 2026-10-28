import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import ImportV3 from './ImportV3';

// Super admins only: districts, sites, roster-app links and site officers.
export default function Admin({ districts, onChanged }) {
  const [newDistrict, setNewDistrict] = useState('');
  const [sites, setSites] = useState([]);
  const [officers, setOfficers] = useState([]);
  const [pending, setPending] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [sRes, oRes, dRes, pRes] = await Promise.all([
      supabase.from('sites').select('*').order('name'),
      supabase.from('site_officers').select('*').order('email'),
      supabase.rpc('list_departments_for_linking'),
      supabase.from('site_officer_pending').select('*').order('email'),
    ]);
    const firstError = sRes.error || oRes.error || dRes.error;
    if (firstError) setError(firstError.message);
    setSites(sRes.data ?? []);
    setOfficers(oRes.data ?? []);
    setDepartments(dRes.data ?? []);
    // Missing until 2026-10-26_v3_import.sql is run.
    setPending(pRes.data ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Runs a write, shows its error if any, then refreshes this tab and the app.
  async function run(promise) {
    setError('');
    const { error } = await promise;
    if (error) setError(error.message);
    await load();
    onChanged();
    return !error;
  }

  async function addDistrict(e) {
    e.preventDefault();
    if (await run(supabase.from('districts').insert({ name: newDistrict.trim() }))) setNewDistrict('');
  }

  const linkedDepartments = new Set(sites.map((s) => s.department_id).filter(Boolean));

  return (
    <div className="stack">
      {error && <p className="error">{error}</p>}

      {districts.map((d) => (
        <div key={d.district_id} className="card stack">
          <h2>{d.name}</h2>
          <ul className="rows">
            {sites
              .filter((s) => s.district_id === d.district_id)
              .map((s) => (
                <SiteRow
                  key={s.site_id}
                  site={s}
                  officers={officers.filter((o) => o.site_id === s.site_id)}
                  pending={pending.filter((o) => o.site_id === s.site_id)}
                  departments={departments.filter((dep) => dep.department_id === s.department_id || !linkedDepartments.has(dep.department_id))}
                  run={run}
                />
              ))}
          </ul>
          <AddSite districtId={d.district_id} run={run} />
        </div>
      ))}

      <ImportV3 districts={districts} onImported={() => { load(); onChanged(); }} />

      <form className="card inline" onSubmit={addDistrict}>
        <input placeholder="New district name" value={newDistrict} onChange={(e) => setNewDistrict(e.target.value)} required />
        <button type="submit">Add district</button>
      </form>
    </div>
  );
}

function SiteRow({ site, officers, pending, departments, run }) {
  const [email, setEmail] = useState('');
  const [deleting, setDeleting] = useState(false);

  async function addOfficer(e) {
    e.preventDefault();
    if (await run(supabase.rpc('add_site_officer', { p_site_id: site.site_id, p_email: email }))) setEmail('');
  }

  return (
    <li className="row column">
      <div className="inline">
        <strong>{site.name}</strong>
        <select
          value={site.department_id ?? ''}
          onChange={(e) => run(supabase.from('sites').update({ department_id: e.target.value || null }).eq('site_id', site.site_id))}
        >
          <option value="">Not on Rstar</option>
          {departments.map((dep) => (
            <option key={dep.department_id} value={dep.department_id}>Rstar: {dep.name}</option>
          ))}
        </select>
        <button className="link danger" onClick={() => setDeleting(true)}>Delete site</button>
      </div>
      <div className="small">
        {officers.length === 0 && pending.length === 0 && <span className="muted">No extra officers</span>}
        {officers.map((o) => (
          <span key={o.user_id} className="chip">
            {o.email}
            <button
              className="link"
              aria-label={`Remove ${o.email}`}
              onClick={() => run(supabase.from('site_officers').delete().eq('site_id', site.site_id).eq('user_id', o.user_id))}
            >
              ×
            </button>
          </span>
        ))}
        {pending.map((o) => (
          <span key={o.email} className="chip" title="Becomes an officer when they first get a login">
            {o.email} <span className="muted">&nbsp;(no login yet)</span>
            <button
              className="link"
              aria-label={`Remove ${o.email}`}
              onClick={() => run(supabase.from('site_officer_pending').delete().eq('site_id', site.site_id).eq('email', o.email))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <form className="inline" onSubmit={addOfficer}>
        <input type="email" placeholder="Officer's email (must already have a login)" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <button type="submit" className="secondary">Add officer</button>
      </form>
      {deleting && <DeleteSite site={site} run={run} onClose={() => setDeleting(false)} />}
    </li>
  );
}

// Deleting a site: what will go, with counts, and the site's name typed
// in before it can be deleted, so a stray tap can't do it.
function DeleteSite({ site, run, onClose }) {
  const [counts, setCounts] = useState(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const count = (query) => query.then((r) => r.count ?? 0);
    const notices = () => supabase.from('district_notices').select('notice_id', { count: 'exact', head: true }).eq('site_id', site.site_id);
    Promise.all([
      count(notices()),
      count(notices().eq('status', 'open')),
      count(notices().eq('status', 'filled')),
      count(supabase.from('district_doctors').select('doctor_id', { count: 'exact', head: true }).eq('home_site_id', site.site_id)),
    ]).then(([all, open, filled, home]) => setCounts({ all, open, filled, home }));
  }, [site.site_id]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const matches = typed.trim().toLowerCase() === site.name.trim().toLowerCase();
  async function remove() {
    setBusy(true);
    const ok = await run(supabase.from('sites').delete().eq('site_id', site.site_id));
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog card stack" role="dialog" aria-modal="true" aria-labelledby="delete-site-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="delete-site-title">Delete {site.name}?</h2>
        <p>This can't be undone. From DR Roster, it deletes:</p>
        <ul>
          <li>
            {counts ? `${counts.all} district shift${counts.all === 1 ? '' : 's'}` : 'All its district shifts'}
            {counts && counts.all > 0 && ` (${counts.open} open, ${counts.filled} filled)`}, with their applications and history
          </li>
          <li>swap listings and offers involving its shifts</li>
          <li>its shift types and its officer list</li>
          {counts?.home > 0 && <li>{counts.home} doctor{counts.home === 1 ? '' : 's'} with it as their home site will have no home site</li>}
        </ul>
        <p>
          <strong>Rstar isn't touched</strong>: the department, staff, roster and cards all stay.
          {site.department_id && ' To only disconnect it from Rstar, cancel and choose "Not on Rstar" instead.'}
        </p>
        <label>
          Type {site.name} to confirm
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </label>
        <div className="inline">
          <button className="danger-fill" disabled={!matches || busy} onClick={remove}>Delete {site.name}</button>
          <button className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function AddSite({ districtId, run }) {
  const [name, setName] = useState('');

  async function add(e) {
    e.preventDefault();
    if (await run(supabase.from('sites').insert({ district_id: districtId, name: name.trim() }))) setName('');
  }

  return (
    <form className="inline" onSubmit={add}>
      <input placeholder="New site name" value={name} onChange={(e) => setName(e.target.value)} required />
      <button type="submit" className="secondary">Add site</button>
    </form>
  );
}
