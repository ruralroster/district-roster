import { useState } from 'react';
import { supabase } from './supabase';

// Shown after following an invite or password-reset email.
export default function SetPassword({ onDone }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save(e) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    setError('');
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    window.history.replaceState(null, '', window.location.pathname);
    onDone();
  }

  return (
    <div className="page narrow">
      <h1>Choose a password</h1>
      <form className="card stack" onSubmit={save}>
        <label>
          New password
          <input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <label>
          Confirm password
          <input type="password" autoComplete="new-password" minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>Save password</button>
      </form>
    </div>
  );
}
