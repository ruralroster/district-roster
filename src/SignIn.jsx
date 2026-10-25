import { useState } from 'react';
import { supabase, appUrl } from './supabase';

export default function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function signIn(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) setError(error.message);
    setBusy(false);
  }

  async function resetPassword() {
    if (!email.trim()) {
      setError('Enter your email first.');
      return;
    }
    setBusy(true);
    setError('');
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: appUrl });
    if (error) setError(error.message);
    else setMessage('Check your email for a link to set a new password.');
    setBusy(false);
  }

  return (
    <div className="page narrow">
      <h1>DR Roster</h1>
      <form className="card stack" onSubmit={signIn}>
        <label>
          Email
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="error">{error}</p>}
        {message && <p className="ok">{message}</p>}
        <button type="submit" disabled={busy}>Sign in</button>
        <button type="button" className="link" onClick={resetPassword} disabled={busy}>Forgot password?</button>
      </form>
      <p className="muted small">Uses the same login as roster-app.</p>
    </div>
  );
}
