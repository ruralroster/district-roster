import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';

// Super admins only: districts, sites, roster-app links and site officers.
export default function Admin({ districts, onChanged }) {
  const [newDistrict, setNewDistrict] = useState('');
  const [sites, setSites] = useState([]);
  const [officers, setOfficers] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [sRes, oRes, dRes] = await Promise.all([
      supabase.from('sites').select('*').order('name'),
      supabase.from('site_officers').select('*').order('email'),
      supabase.rpc('list_departments_for_linking'),
    ]);
    const firstError = sRes.error || oRes.error || dRes.error;
    if (firstError) setError(firstError.message);
    setSites(sRes.data ?? []);
    setOfficers(oRes.data ?? []);
    setDepartments(dRes.data ?? []);
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
                  departments={departments.filter((dep) => dep.department_id === s.department_id || !linkedDepartments.has(dep.department_id))}
                  run={run}
                />
              ))}
          </ul>
          <AddSite districtId={d.district_id} run={run} />
        </div>
      ))}

      <form className="card inline" onSubmit={addDistrict}>
        <input placeholder="New district name" value={newDistrict} onChange={(e) => setNewDistrict(e.target.value)} required />
        <button type="submit">Add district</button>
      </form>
    </div>
  );
}

function SiteRow({ site, officers, departments, run }) {
  const [email, setEmail] = useState('');

  async function addOfficer(e) {
    e.preventDefault();
    if (await run(supabase.rpc('add_site_officer', { p_site_id: site.site_id, p_email: email }))) setEmail('');
  }

  function remove() {
    if (window.confirm(`Delete ${site.name}? Doctors with it as their home site will have no home site.`)) {
      run(supabase.from('sites').delete().eq('site_id', site.site_id));
    }
  }

  return (
    <li className="row column">
      <div className="inline">
        <strong>{site.name}</strong>
        <select
          value={site.department_id ?? ''}
          onChange={(e) => run(supabase.from('sites').update({ department_id: e.target.value || null }).eq('site_id', site.site_id))}
        >
          <option value="">Not on roster-app</option>
          {departments.map((dep) => (
            <option key={dep.department_id} value={dep.department_id}>roster-app: {dep.name}</option>
          ))}
        </select>
        <button className="link danger" onClick={remove}>Delete site</button>
      </div>
      <div className="small">
        {officers.length === 0 && <span className="muted">No extra officers</span>}
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
      </div>
      <form className="inline" onSubmit={addOfficer}>
        <input type="email" placeholder="Officer's email (must already have a login)" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <button type="submit" className="secondary">Add officer</button>
      </form>
    </li>
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
