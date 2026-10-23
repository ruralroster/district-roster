import { useEffect, useState } from 'react';
import { supabase } from './supabase';

export default function Sites({ districtId, sites }) {
  const [officers, setOfficers] = useState([]);

  useEffect(() => {
    const ids = sites.map((s) => s.site_id);
    if (ids.length === 0) {
      setOfficers([]);
      return;
    }
    supabase
      .from('site_officers')
      .select('site_id, email')
      .in('site_id', ids)
      .then(({ data }) => setOfficers(data ?? []));
  }, [districtId, sites]);

  return (
    <div className="card">
      <h2>Sites</h2>
      {sites.length === 0 && <p className="muted">No sites in this district yet.</p>}
      <ul className="rows">
        {sites.map((s) => {
          const names = [
            ...(s.department_id ? ['roster-app officers'] : []),
            ...officers.filter((o) => o.site_id === s.site_id).map((o) => o.email),
          ];
          return (
            <li key={s.site_id} className="row">
              <div>
                <strong>{s.name}</strong>
                {s.department_id && <span className="badge">On roster-app</span>}
                <div className="muted small">
                  {names.length > 0 ? `Officers: ${names.join(', ')}` : 'No officer yet'}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
