import { useCallback, useEffect, useState } from 'react';
import { supabase, appUrl, LEVELS, LEVEL_LABEL } from './supabase';

const APP_URL = 'https://ruralroster.github.io/district-roster/';
import SkillPicker from './SkillPicker';

const emptyInvite = { name: '', email: '', homeSiteId: '', skills: ['Emergency'] };

export default function Doctors({ districtId, sites }) {
  const [doctors, setDoctors] = useState([]);
  const [invite, setInvite] = useState(emptyInvite);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Officers named (e.g. by the v3 import) who have no login yet.
  const [pendingOfficers, setPendingOfficers] = useState([]);
  const [bulkMessage, setBulkMessage] = useState('');
  const [bulkError, setBulkError] = useState('');
  // The one-time password just made: { name, email, tempPassword, mfaWasReset }.
  const [temp, setTemp] = useState(null);
  const siteName = (id) => sites.find((s) => s.site_id === id)?.name ?? '';

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('district_doctors')
      .select('*')
      .eq('district_id', districtId)
      .order('name');
    if (error) setError(error.message);
    setDoctors(data ?? []);
    const siteIds = sites.map((s) => s.site_id);
    const { data: pending } = siteIds.length
      ? await supabase.from('site_officer_pending').select('site_id, email, name').in('site_id', siteIds).order('email')
      : { data: [] };
    setPendingOfficers(pending ?? []);
  }, [districtId, sites]);

  const uninvited = doctors.filter((d) => d.active && !d.user_id);
  const officerEmails = [...new Set(pendingOfficers.map((o) => o.email))];

  // Invites doctors (by id) and officers (by email) already on the list.
  async function inviteExisting(doctorIds, emails, what) {
    if (!window.confirm(`Send ${what} an invite email to set a password? Anyone who already has a login (e.g. Rstar) is linked, and emailed to sign in with their Rstar password instead.`)) return;
    setBusy(true);
    setBulkError('');
    setBulkMessage('');
    const { data, error } = await supabase.functions.invoke('invite-district-doctor', {
      body: { districtId, doctorIds, officerEmails: emails, redirectTo: appUrl },
    });
    setBusy(false);
    const failure = error ? await functionError(error) : data?.error;
    if (failure) {
      setBulkError(failure);
      load();
      return;
    }
    const results = data.data.results;
    const invited = results.filter((r) => r.invited).length;
    const linked = results.filter((r) => r.linked).length;
    const failed = results.filter((r) => r.error);
    setBulkMessage(
      [
        invited && `${invited} invite${invited === 1 ? '' : 's'} sent.`,
        linked && `${linked} already had a login (e.g. Rstar) and ${linked === 1 ? 'was' : 'were'} linked, and emailed to sign in with their Rstar password.`,
      ].filter(Boolean).join(' ') || 'Nobody needed an invite.',
    );
    const notEmailed = results.filter((r) => r.linked && !r.emailed);
    if (notEmailed.length) failed.push(...notEmailed.map((r) => ({ email: r.email, error: "linked, but the email didn't send; tell them to use their Rstar password" })));
    if (failed.length) setBulkError(`Couldn't invite: ${failed.map((r) => `${r.email} (${r.error})`).join('; ')}`);
    load();
  }

  // For someone whose invite never came, or who's forgotten their password.
  async function giveTempPassword(target, label, hasLogin) {
    const rstar = hasLogin ? `${label} already has a login. If they use Rstar, they can sign in here with their Rstar email and password, and don't need a new one.\n\n` : '';
    if (!window.confirm(`${rstar}Make a one-time password for ${label}? Their current password (if any) stops working straight away, and two-factor is turned off. They choose their own password when they sign in with it.`)) return;
    setBusy(true);
    setBulkError('');
    setBulkMessage('');
    const { data, error } = await supabase.functions.invoke('district-temp-password', { body: { districtId, ...target } });
    setBusy(false);
    const failure = error ? await functionError(error) : data?.error;
    if (failure) setBulkError(failure);
    else setTemp(data.data);
    load();
  }

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
        : data.data.emailed
          ? `${invite.email} already has a login (e.g. Rstar), so they've been emailed to sign in with their Rstar email and password.`
          : `${invite.email} already has a login (e.g. Rstar), but the email didn't send. Let them know they can sign in with their Rstar email and password.`,
    );
    setInvite(emptyInvite);
    load();
  }

  async function setActive(doctor, active) {
    update(doctor, { active });
  }

  async function update(doctor, changes) {
    setBulkError('');
    const { error } = await supabase.from('district_doctors').update(changes).eq('doctor_id', doctor.doctor_id);
    if (error) setBulkError(error.message);
    load();
  }

  return (
    <div className="stack">
      <div className="card">
        <h2>Doctors</h2>
        {(uninvited.length > 0 || officerEmails.length > 0) && (
          <div className="inline small">
            <span>
              {uninvited.length > 0 && `${uninvited.length} doctor${uninvited.length === 1 ? '' : 's'}`}
              {uninvited.length > 0 && officerEmails.length > 0 && ' and '}
              {officerEmails.length > 0 && `${officerEmails.length} officer${officerEmails.length === 1 ? '' : 's'}`}
              {' '}not invited yet.
            </span>
            <button
              disabled={busy}
              onClick={() => inviteExisting(uninvited.map((d) => d.doctor_id), officerEmails, `${uninvited.length + officerEmails.length} people`)}
            >
              Invite everyone not invited yet
            </button>
          </div>
        )}
        {bulkError && <p className="error">{bulkError}</p>}
        {bulkMessage && <p className="ok">{bulkMessage}</p>}
        {temp && <TempPassword {...temp} onClose={() => setTemp(null)} />}
        {doctors.length === 0 && <p className="muted">No doctors yet.</p>}
        <ul className="rows">
          {doctors.map((d) => (
            <li key={d.doctor_id} className={d.active ? 'row' : 'row inactive'}>
              <div>
                <strong>{d.name}</strong>
                {!d.active && <span className="badge">Inactive</span>}
                {d.active && !d.user_id && <span className="badge">Not invited yet</span>}
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
              {d.active && !d.user_id && (
                <button className="secondary" disabled={busy} onClick={() => inviteExisting([d.doctor_id], [], d.name)}>
                  Invite
                </button>
              )}
              {d.active && (
                <button className="secondary" disabled={busy} onClick={() => giveTempPassword({ doctorId: d.doctor_id }, d.name, !!d.user_id)}>
                  One-time password
                </button>
              )}
              <button className="secondary" onClick={() => setActive(d, !d.active)}>
                {d.active ? 'Deactivate' : 'Reactivate'}
              </button>
            </li>
          ))}
        </ul>
      </div>

      {officerEmails.length > 0 && (
        <div className="card">
          <h2>Officers not invited yet</h2>
          <p className="small muted">Named as officers (e.g. from v3) but with no login. Inviting them makes them officers of these sites when they sign up.</p>
          <ul className="rows">
            {officerEmails.map((email) => {
              const rows = pendingOfficers.filter((o) => o.email === email);
              return (
                <li key={email} className="row">
                  <div>
                    <strong>{rows.find((o) => o.name)?.name ?? email}</strong>
                    <div className="muted small">{email} · {rows.map((o) => siteName(o.site_id)).join(', ')}</div>
                  </div>
                  <button className="secondary" disabled={busy} onClick={() => inviteExisting([], [email], rows.find((o) => o.name)?.name ?? email)}>
                    Invite
                  </button>
                  <button className="secondary" disabled={busy} onClick={() => giveTempPassword({ officerEmail: email }, rows.find((o) => o.name)?.name ?? email)}>
                    One-time password
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

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

// Shown once: the officer passes it on. The email is written like Rstar's
// one-time password email.
function TempPassword({ name, email, tempPassword, mfaWasReset, onClose }) {
  const [copied, setCopied] = useState(false);
  const firstName = (name || '').split(/\s+/).filter((w) => w && !/^(Dr|Mr|Mrs|Ms|Prof)\.?$/i.test(w))[0] || 'there';
  const body = [
    `Dear ${firstName},`,
    '',
    'Please find below your one-time password for DR Roster:',
    '',
    tempPassword,
    '',
    `Sign in at ${APP_URL} using this email address as your username and the password above. If you also use Rstar, it's the same login.`,
    '',
    "The first time you sign in, you'll be asked to choose a new password of your own. The one-time password won't work after that.",
    '',
    'To put DR Roster on your phone like an app:',
    '',
    `iPhone: open ${APP_URL} in Safari (not Chrome or the Gmail browser), tap the Share button (the square with an arrow), then "Add to Home Screen" and "Add". Open DR Roster from your Home Screen from then on: phone notifications only work from there.`,
    '',
    `Android: open ${APP_URL} in Chrome, tap the ⋮ menu (top right), then "Install app" or "Add to Home screen".`,
    '',
    'Then turn on notifications in My profile, so you hear about new shifts.',
    '',
    "If there are any issues, or anything you'd like changed or added to the app, please don't hesitate to get in touch at ruralroster@gmail.com.",
    '',
    'Cheers,',
    'Rural Roster Team',
  ].join('\n');
  const mailto = `mailto:${email}?subject=${encodeURIComponent('Your DR Roster one-time password')}&body=${encodeURIComponent(body)}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(tempPassword);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="card stack">
      <p>
        One-time password for <strong>{name ?? email}</strong> ({email}):
      </p>
      <p style={{ fontFamily: 'monospace', fontSize: '1.4rem', letterSpacing: '0.08em', margin: 0 }}>{tempPassword}</p>
      <p className="small muted">
        It's shown only now. Send it by email, or by text or in person.
        {mfaWasReset && ' Their two-factor was turned off; they can turn it back on in My profile.'}
      </p>
      <div className="inline">
        <a className="button" href={mailto}>Email it to them</a>
        <button className="secondary" onClick={copy}>{copied ? 'Copied' : 'Copy password'}</button>
        <button className="secondary" onClick={onClose}>Done</button>
      </div>
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
