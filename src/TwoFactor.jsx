import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { supabase } from './supabase';

// Two-factor authentication: the same Supabase auth.mfa TOTP factor as
// roster-app (one login for both apps), so turning it on in either app
// turns it on for both. Same behaviour as roster-app's MfaChallenge.jsx and
// TwoFactorSettings.jsx.

const verifiedTotp = (data) => (data?.totp || []).find((f) => f.status === 'verified');

async function verify(factorId, code) {
  const { data: challenge, error } = await supabase.auth.mfa.challenge({ factorId });
  if (error) return { error };
  return supabase.auth.mfa.verify({ factorId, challengeId: challenge.id, code });
}

// True when this sign-in still needs the code (a password sign-in only
// reaches aal1; someone with 2FA on needs aal2).
export async function needsTwoFactor() {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) return false;
  return data.nextLevel === 'aal2' && data.currentLevel !== 'aal2';
}

// After the password, before the app: asks for the authenticator code.
export function TwoFactorChallenge({ onVerified }) {
  const [factorId, setFactorId] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    supabase.auth.mfa.listFactors().then(({ data, error }) => {
      if (error) return setError(error.message);
      const totp = verifiedTotp(data);
      // Removed from another session: nothing to ask for.
      if (!totp) onVerified();
      else setFactorId(totp.id);
    });
    // Once, on arrival (onVerified is a new function each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { error } = await verify(factorId, code.trim());
    setBusy(false);
    if (error) setError('Incorrect code. Check the time on your phone and try again.');
    else onVerified();
  }

  return (
    <div className="page narrow">
      <h1>DR Roster</h1>
      <form className="card stack" onSubmit={submit}>
        <h2>Enter your code</h2>
        <p className="muted small">Open your authenticator app and enter the current 6-digit code.</p>
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          placeholder="000000"
          className="code-input"
          autoFocus
        />
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy || !factorId || code.length !== 6}>{busy ? 'Checking…' : 'Continue'}</button>
        <button type="button" className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </form>
    </div>
  );
}

// On/off, with the QR code to set it up.
export function TwoFactorSettings() {
  const [loading, setLoading] = useState(true);
  const [factor, setFactor] = useState(null);
  const [enrollment, setEnrollment] = useState(null); // { factorId, qrCode, secret }
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) setError(error.message);
    setFactor(verifiedTotp(data) ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function start() {
    setBusy(true);
    setError('');
    // Clear half-finished setups from earlier attempts.
    const { data: existing } = await supabase.auth.mfa.listFactors();
    for (const f of existing?.totp || []) {
      if (f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id });
    }
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
    setBusy(false);
    if (error) return setError(`Couldn't start setup: ${error.message}`);
    setEnrollment({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
    setCode('');
  }

  async function cancel() {
    await supabase.auth.mfa.unenroll({ factorId: enrollment.factorId }).catch(() => {});
    setEnrollment(null);
  }

  async function confirm(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { error } = await verify(enrollment.factorId, code.trim());
    setBusy(false);
    if (error) return setError("That code didn't work. Check the time on your phone and try again.");
    setEnrollment(null);
    load();
  }

  async function turnOff() {
    if (!window.confirm('Turn off two-factor authentication? Signing in to DR Roster and Rostar will only need your password.')) return;
    setBusy(true);
    setError('');
    const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
    setBusy(false);
    if (error) setError(`Couldn't turn it off: ${error.message}`);
    load();
  }

  return (
    <div className="card stack">
      <h2>Two-factor authentication</h2>
      <p className="small muted">
        A code from an authenticator app (like Google Authenticator or Authy) as well as your password when you sign in.
        It's the same setting as in Rostar.
      </p>
      {loading ? (
        <p className="muted">Loading…</p>
      ) : enrollment ? (
        <form className="stack" onSubmit={confirm}>
          <p className="small">Scan this with your authenticator app:</p>
          <img src={enrollment.qrCode} alt="Two-factor QR code" className="qr" />
          <p className="small muted">
            Can't scan it? Enter this key: <code className="secret">{enrollment.secret}</code>
          </p>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            placeholder="6-digit code"
            className="code-input"
          />
          <div className="inline">
            <button type="submit" disabled={busy || code.length !== 6}>Turn on</button>
            <button type="button" className="secondary" onClick={cancel} disabled={busy}>Cancel</button>
          </div>
        </form>
      ) : factor ? (
        <div className="inline">
          <span className="ok inline"><ShieldCheck size={16} /> On</span>
          <button className="secondary" onClick={turnOff} disabled={busy}>Turn off</button>
        </div>
      ) : (
        <div className="inline">
          <span className="muted">Off</span>
          <button onClick={start} disabled={busy}>Turn on</button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
