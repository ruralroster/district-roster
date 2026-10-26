import { useCallback, useEffect, useState } from 'react';
import { supabase, SKILLS } from './supabase';
import { formatShiftTime } from './dateUtils';
import { HUE_CHOICES, hueStyle, siteHues, siteStyle } from './siteColours';

const skillText = (skill) => (skill === 'Emergency' ? 'Any doctor' : `Needs ${skill}`);

export default function Sites({ districtId, sites, officerSiteIds, onChanged }) {
  const [officers, setOfficers] = useState([]);
  const [shiftTypes, setShiftTypes] = useState([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const ids = sites.map((s) => s.site_id);
    if (ids.length === 0) {
      setOfficers([]);
      setShiftTypes([]);
      return;
    }
    const [oRes, tRes] = await Promise.all([
      supabase.from('site_officers').select('site_id, email').in('site_id', ids),
      supabase.from('site_shift_types').select('*').in('site_id', ids).order('start_time').order('name'),
    ]);
    setOfficers(oRes.data ?? []);
    setShiftTypes(tRes.data ?? []);
  }, [sites]);

  useEffect(() => {
    load();
  }, [districtId, load]);

  async function run(promise) {
    setError('');
    const { error } = await promise;
    if (error) setError(error.message);
    load();
    return !error;
  }

  const hues = siteHues(sites);
  return (
    <div className="card">
      <h2>Sites</h2>
      {error && <p className="error">{error}</p>}
      {sites.length === 0 && <p className="muted">No sites in this district yet.</p>}
      <ul className="rows">
        {sites.map((s) => {
          const names = [
            ...(s.department_id ? ['roster-app officers'] : []),
            ...officers.filter((o) => o.site_id === s.site_id).map((o) => o.email),
          ];
          const types = shiftTypes.filter((t) => t.site_id === s.site_id);
          const canEdit = officerSiteIds.has(s.site_id);
          return (
            <li key={s.site_id} className="row column site-stripe" style={siteStyle(hues, s.site_id)}>
              <div>
                <strong className="site-name">{s.name}</strong>
                {s.department_id && <span className="badge">On roster-app</span>}
                <div className="muted small">
                  {names.length > 0 ? `Officers: ${names.join(', ')}` : 'No officer yet'}
                </div>
              </div>
              {types.length > 0 && (
                <ul className="rows small">
                  {types.map((t) => (
                    <li key={t.shift_type_id} className="row">
                      <span>{t.name}</span>
                      <span className="inline">
                        <span className="muted">{formatShiftTime(t.start_time, t.end_time)} · {skillText(t.required_skill)}</span>
                        {canEdit && (
                          <button
                            className="link danger"
                            aria-label={`Remove ${t.name}`}
                            onClick={() =>
                              window.confirm(`Remove the ${t.name} shift type? Shifts already posted stay.`) &&
                              run(supabase.from('site_shift_types').delete().eq('shift_type_id', t.shift_type_id))
                            }
                          >
                            ×
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {canEdit && <AddShiftType siteId={s.site_id} run={run} />}
              {canEdit && <SiteColour site={s} hue={hues.get(s.site_id)} onChanged={onChanged} />}
              <Escalation site={s} canEdit={canEdit} onChanged={onChanged} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AddShiftType({ siteId, run }) {
  const blank = { name: '', start_time: '08:00', end_time: '17:00', required_skill: 'Emergency' };
  const [form, setForm] = useState(blank);
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  async function add(e) {
    e.preventDefault();
    if (await run(supabase.from('site_shift_types').insert({ ...form, name: form.name.trim(), site_id: siteId }))) setForm(blank);
  }

  return (
    <form className="inline small" onSubmit={add}>
      <input placeholder="New shift type, e.g. ED Late" value={form.name} onChange={set('name')} required />
      <input type="time" value={form.start_time} onChange={set('start_time')} required aria-label="Start" />
      <input type="time" value={form.end_time} onChange={set('end_time')} required aria-label="Finish" />
      <select value={form.required_skill} onChange={set('required_skill')} aria-label="Needs">
        {SKILLS.map((k) => (
          <option key={k} value={k}>{skillText(k)}</option>
        ))}
      </select>
      <button type="submit" className="secondary">Add shift type</button>
    </form>
  );
}

// How long the site's gaps stay local (offered on roster-app) before
// going to the district.
function Escalation({ site, canEdit, onChanged }) {
  const saved = site.escalate_after_hours ?? 72;
  const [hours, setHours] = useState(String(saved));
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function save(e) {
    e.preventDefault();
    setError('');
    setMessage('');
    const { error } = await supabase.rpc('set_site_escalation', { p_site_id: site.site_id, p_hours: Number(hours) });
    if (error) return setError(error.message);
    setMessage('Saved.');
    onChanged();
  }

  const explain = `Gaps offered on roster-app go to the district after ${saved} hours unfilled, or straight away if the shift starts within ${saved} hours. Shifts posted here in DR Roster go to the district at once.`;
  if (!canEdit) return <p className="small muted">{explain}</p>;
  return (
    <form className="inline small" onSubmit={save}>
      <label className="inline">
        Keep gaps local for
        <input type="number" min="0" max="720" step="1" value={hours} onChange={(e) => setHours(e.target.value)} className="hours-input" />
        hours before sending them to the district
      </label>
      {String(saved) !== hours && <button type="submit" className="secondary">Save</button>}
      {message && <span className="ok">{message}</span>}
      {error && <span className="error">{error}</span>}
      <span className="muted">{explain}</span>
    </form>
  );
}
