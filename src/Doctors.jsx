import { useCallback, useEffect, useState } from 'react';
import { supabase, appUrl, LEVELS, LEVEL_LABEL } from './supabase';
import SkillPicker from './SkillPicker';

const emptyInvite = { name: '', email: '', homeSiteId: '', skills: ['Emergency'] };

export default function Doctors({ districtId, sites }) {
  const [doctors, setDoctors] = useState([]);
  const [invite, setInvite] = useState(emptyInvite);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const siteName = (id) => sites.find((s) => s.site_id === id)?.name ?? '';

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('district_doctors')
      .select('*')
      .eq('district_id', districtId)
      .order('name');
    if (error) setError(error.message);
    setDoctors(data ?? []);
  }, [districtId]);

  useEffect(() => {
    load();
  }, [load]);

  async function sendInvite(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    const { data, error } = await supabase.functions.invoke('invite-district-doctor', {
      body: { districtId, ...invite, redirectTo: appUrl },
    });
    setBusy(false);
    const failure = error ? await functionError(error) : data?.error;
    if (failure) {
      setError(failure);
      return;
    }
    setMessage(
      data.data.invited
        ? `Invite sent to ${invite.email}.`
        : `${invite.email} already has a login, so they've been added without a new invite. Let them know.`,
    );
    setInvite(emptyInvite);
    load();
  }

  async function setActive(doctor, active) {
    update(doctor, { active });
  }

  async function update(doctor, changes) {
    setError('');
    const { error } = await supabase.from('district_doctors').update(changes).eq('doctor_id', doctor.doctor_id);
    if (error) setError(error.message);
    load();
  }

  return (
    <div className="stack">
      <div className="card">
        <h2>Doctors</h2>
        {doctors.length === 0 && <p className="muted">No doctors yet.</p>}
        <ul className="rows">
          {doctors.map((d) => (
            <li key={d.doctor_id} className={d.active ? 'row' : 'row inactive'}>
              <div>
                <strong>{d.name}</strong>
                {!d.active && <span className="badge">Inactive</span>}
                <div className="muted small">
                  {d.email}
                  {d.phone && ` · ${d.phone}`}
                  {d.home_site_id && ` · Home: ${siteName(d.home_site_id)}`}
                </div>
                <div className="small">{d.skills.join(', ')}</div>
              </div>
              <select value={d.level ?? 'consultant'} onChange={(e) => update(d, { level: e.target.value })} aria-label={`${d.name}'s level`}>
                {LEVELS.map((k) => (
                  <option key={k} value={k}>{LEVEL_LABEL[k]}</option>
                ))}
              </select>
              <button className="secondary" onClick={() => setActive(d, !d.active)}>
                {d.active ? 'Deactivate' : 'Reactivate'}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <form className="card stack" onSubmit={sendInvite}>
        <h2>Invite a doctor</h2>
        <label>
          Name
          <input value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} required />
        </label>
        <label>
          Email
          <input type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} required />
        </label>
        <label>
          Home site
          <select value={invite.homeSiteId} onChange={(e) => setInvite({ ...invite, homeSiteId: e.target.value })}>
            <option value="">None</option>
            {sites.map((s) => (
              <option key={s.site_id} value={s.site_id}>{s.name}</option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>Skills</legend>
          <SkillPicker value={invite.skills} onChange={(skills) => setInvite({ ...invite, skills })} />
        </fieldset>
        {error && <p className="error">{error}</p>}
        {message && <p className="ok">{message}</p>}
        <button type="submit" disabled={busy}>Send invite</button>
      </form>
    </div>
  );
}

// supabase-js hides the function's own { error } body behind a generic
// message on non-2xx responses; dig it out so the officer sees the reason.
async function functionError(error) {
  try {
    const body = await error.context.json();
    return body.error ?? error.message;
  } catch {
    return error.message;
  }
}
