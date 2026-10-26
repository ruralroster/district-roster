import { useEffect, useState } from 'react';
import { supabase } from './supabase';

// An officer's weekly digest day(s) (district_officer_settings; Monday
// unless changed). district-notify sends it from 7:00 that morning.
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export default function DigestSettings({ userId }) {
  const [days, setDays] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    supabase
      .from('district_officer_settings')
      .select('digest_days')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data }) => setDays(data?.digest_days ?? [0]));
  }, [userId]);

  async function toggle(day) {
    const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort();
    setDays(next);
    setError('');
    setMessage('');
    const { error } = await supabase
      .from('district_officer_settings')
      .upsert({ user_id: userId, digest_days: next, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) setError(error.message);
    else setMessage(next.length ? 'Saved.' : 'Saved. You won\'t get a digest.');
  }

  return (
    <div className="card stack">
      <h2>Weekly digest</h2>
      <p className="small muted">
        One email and phone notification listing your sites' district shifts still open over the next 6 weeks, with
        those under 3 weeks away marked "locum might be required", and any swaps waiting for you. It comes from 7:00 on the
        days you tick. A shift still open with under 72 hours to go is sent straight away as well.
      </p>
      {days && (
        <div className="checks">
          {DAYS.map((name, i) => (
            <label key={name} className="check">
              <input type="checkbox" checked={days.includes(i)} onChange={() => toggle(i)} />
              {name}
            </label>
          ))}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {message && <p className="ok">{message}</p>}
    </div>
  );
}
