import { useState } from 'react';
import { supabase } from './supabase';
import SkillPicker from './SkillPicker';

export default function Profile({ doctor, sites, onSaved }) {
  const [form, setForm] = useState({
    name: doctor.name,
    phone: doctor.phone ?? '',
    home_site_id: doctor.home_site_id ?? '',
    skills: doctor.skills,
    notify_email: doctor.notify_email,
    notify_push: doctor.notify_push,
    interested_site_ids: doctor.interested_site_ids ?? [],
  });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (field) => (value) => setForm((f) => ({ ...f, [field]: value }));

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    const { error } = await supabase
      .from('district_doctors')
      .update({
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        home_site_id: form.home_site_id || null,
        skills: form.skills,
        notify_email: form.notify_email,
        notify_push: form.notify_push,
        interested_site_ids: form.interested_site_ids,
      })
      .eq('doctor_id', doctor.doctor_id);
    setBusy(false);
    if (error) setError(error.message);
    else {
      setMessage('Saved.');
      onSaved();
    }
  }

  return (
    <form className="card stack" onSubmit={save}>
      <label>
        Name
        <input value={form.name} onChange={(e) => set('name')(e.target.value)} required />
      </label>
      <label>
        Email
        <input value={doctor.email} disabled />
      </label>
      <label>
        Phone
        <input type="tel" value={form.phone} onChange={(e) => set('phone')(e.target.value)} />
      </label>
      <label>
        Home site
        <select value={form.home_site_id} onChange={(e) => set('home_site_id')(e.target.value)}>
          <option value="">None</option>
          {sites.map((s) => (
            <option key={s.site_id} value={s.site_id}>{s.name}</option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>Skills</legend>
        <SkillPicker value={form.skills} onChange={set('skills')} />
      </fieldset>
      <fieldset>
        <legend>Sites I'd work at</legend>
        <div className="checks">
          {sites.map((s) => (
            <label key={s.site_id} className="check">
              <input
                type="checkbox"
                checked={form.interested_site_ids.includes(s.site_id)}
                onChange={(e) =>
                  set('interested_site_ids')(
                    e.target.checked
                      ? [...form.interested_site_ids, s.site_id]
                      : form.interested_site_ids.filter((id) => id !== s.site_id),
                  )
                }
              />
              {s.name}
            </label>
          ))}
        </div>
        <p className="small muted">
          You're only told about new shifts at these sites, and only when you're free: not on a day you've marked
          unavailable, not starting within 10 hours of a shift you're on, and not finishing within 10 hours of a shift at
          your primary site.
        </p>
      </fieldset>
      <fieldset>
        <legend>Notifications</legend>
        <div className="checks">
          <label className="check">
            <input type="checkbox" checked={form.notify_email} onChange={(e) => set('notify_email')(e.target.checked)} />
            Email
          </label>
          <label className="check">
            <input type="checkbox" checked={form.notify_push} onChange={(e) => set('notify_push')(e.target.checked)} />
            Phone notifications
          </label>
        </div>
        <p className="muted small">Shift notices start in the next update.</p>
      </fieldset>
      {error && <p className="error">{error}</p>}
      {message && <p className="ok">{message}</p>}
      <button type="submit" disabled={busy}>Save</button>
    </form>
  );
}
