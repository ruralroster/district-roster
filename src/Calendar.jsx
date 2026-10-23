import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { supabase, SKILLS } from './supabase';
import { getMondayOfWeek, toLocalDateStr, isSameDate, formatShiftTime } from './dateUtils';

// Same look as roster-app's officer Calendar tab: 4 weeks of square day
// tiles, coloured by status, with a legend.
const CALENDAR_WEEKS_SHOWN = 4;

const STATUS_STYLES = {
  officer: {
    none: { label: 'No district shifts' },
    open: { label: 'Open shift' },
    filled: { label: 'All filled' },
  },
  doctor: {
    none: { label: 'Nothing for you' },
    available: { label: 'Shifts you can apply for' },
    booked: { label: "You're booked" },
  },
};

export default function Calendar({ districtId, sites, me, officerSiteIds }) {
  const isOfficer = officerSiteIds.size > 0;
  // Officers' sites load after this mounts, so the default is worked out
  // on each render rather than fixed in the initial state.
  const [viewChoice, setView] = useState(null);
  const view = !me ? 'officer' : !isOfficer ? 'doctor' : viewChoice ?? 'officer';
  const [weekStart, setWeekStart] = useState(() => getMondayOfWeek(new Date()));
  const [selectedDate, setSelectedDate] = useState(null);
  const [notices, setNotices] = useState([]);
  const [doctors, setDoctors] = useState([]);
  const [error, setError] = useState('');

  const days = [];
  for (let i = 0; i < CALENDAR_WEEKS_SHOWN * 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  const weeks = [];
  for (let w = 0; w < CALENDAR_WEEKS_SHOWN; w++) weeks.push(days.slice(w * 7, w * 7 + 7));
  const rangeStart = toLocalDateStr(days[0]);
  const rangeEnd = toLocalDateStr(days[days.length - 1]);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('district_notices')
      .select('*')
      .eq('district_id', districtId)
      .gte('shift_date', rangeStart)
      .lte('shift_date', rangeEnd)
      .neq('status', 'cancelled')
      .order('shift_date')
      .order('start_time');
    if (error) setError(error.message);
    setNotices(data ?? []);
  }, [districtId, rangeStart, rangeEnd]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!isOfficer) return;
    supabase
      .from('district_doctors')
      .select('doctor_id, name')
      .eq('district_id', districtId)
      .eq('active', true)
      .order('name')
      .then(({ data }) => setDoctors(data ?? []));
  }, [districtId, isOfficer]);

  // The notices this view is about: officers see their own sites'; doctors
  // see open ones their skills fit, plus anything they're booked on.
  const relevant = notices.filter((n) =>
    view === 'officer'
      ? officerSiteIds.has(n.site_id)
      : (n.status === 'open' && me?.skills.includes(n.required_skill)) || (me && n.filled_by_doctor_id === me.doctor_id),
  );

  function dayStatus(dateStr) {
    const list = relevant.filter((n) => n.shift_date === dateStr);
    const openCount = list.filter((n) => n.status === 'open').length;
    if (view === 'officer') {
      if (openCount > 0) return { status: 'open', count: openCount };
      return { status: list.length > 0 ? 'filled' : 'none', count: 0 };
    }
    if (list.some((n) => n.filled_by_doctor_id === me?.doctor_id)) return { status: 'booked', count: openCount };
    return { status: openCount > 0 ? 'available' : 'none', count: openCount };
  }

  const today = new Date();
  const styles = STATUS_STYLES[view];
  const shiftWeeks = (n) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + n * 7);
    setWeekStart(d);
  };

  return (
    <div className="stack">
      {isOfficer && me && (
        <div className="segmented">
          <button className={view === 'officer' ? 'active' : ''} onClick={() => setView('officer')}>My sites</button>
          <button className={view === 'doctor' ? 'active' : ''} onClick={() => setView('doctor')}>Shifts for me</button>
        </div>
      )}

      <div className="cal-card">
        <div className="cal-header">
          <button className="cal-nav" onClick={() => shiftWeeks(-1)} aria-label="Previous week">
            <ChevronLeft size={24} />
          </button>
          <h2>
            {days[0].toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}
            {' – '}
            {days[days.length - 1].toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}
          </h2>
          <button className="cal-nav" onClick={() => shiftWeeks(1)} aria-label="Next week">
            <ChevronRight size={24} />
          </button>
        </div>

        <div className="cal-grid cal-daynames">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
            <div key={d}>{d}</div>
          ))}
        </div>

        {weeks.map((week) => (
          <div key={toLocalDateStr(week[0])} className="cal-grid cal-week">
            {week.map((date) => {
              const dateStr = toLocalDateStr(date);
              const { status, count } = dayStatus(dateStr);
              const classes = ['cal-day', `cal-${status}`];
              if (isSameDate(date, today)) classes.push('cal-today');
              if (selectedDate && isSameDate(date, selectedDate)) classes.push('cal-selected');
              return (
                <button
                  key={dateStr}
                  className={classes.join(' ')}
                  title={[styles[status].label, count > 0 ? `${count} open` : null].filter(Boolean).join(' — ')}
                  onClick={() => setSelectedDate(date)}
                >
                  {date.getDate() === 1 && (
                    <span className="cal-month">{date.toLocaleDateString('en-AU', { month: 'short' })}</span>
                  )}
                  {date.getDate()}
                  {count > 0 && <span className="cal-count">{count}</span>}
                </button>
              );
            })}
          </div>
        ))}

        <div className="cal-legend">
          {Object.entries(styles).map(([key, style]) => (
            <div key={key}>
              <span className={`cal-swatch cal-${key}`} />
              {style.label}
            </div>
          ))}
          <div>
            <span className="cal-count static">2</span>
            Open shifts that day
          </div>
        </div>
        {error && <p className="error">{error}</p>}
      </div>

      {selectedDate && (
        <DayPanel
          date={selectedDate}
          notices={relevant.filter((n) => n.shift_date === toLocalDateStr(selectedDate))}
          view={view}
          sites={sites}
          doctors={doctors}
          me={me}
          onChanged={load}
        />
      )}

      {view === 'officer' && (
        <PostShift
          sites={sites.filter((s) => officerSiteIds.has(s.site_id))}
          defaultDate={selectedDate ? toLocalDateStr(selectedDate) : ''}
          onPosted={load}
        />
      )}
    </div>
  );
}

function DayPanel({ date, notices, view, sites, doctors, me, onChanged }) {
  const [error, setError] = useState('');
  const siteName = (id) => sites.find((s) => s.site_id === id)?.name ?? '';
  const doctorName = (id) => doctors.find((d) => d.doctor_id === id)?.name ?? (id === me?.doctor_id ? 'You' : 'A district doctor');

  async function update(notice, changes) {
    setError('');
    const { error } = await supabase.from('district_notices').update(changes).eq('notice_id', notice.notice_id);
    if (error) setError(error.message);
    onChanged();
  }

  return (
    <div className="card">
      <h2>{date.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
      {notices.length === 0 && <p className="muted">{view === 'officer' ? 'No district shifts at your sites.' : 'No shifts for you.'}</p>}
      <ul className="rows">
        {notices.map((n) => (
          <li key={n.notice_id} className="row">
            <div>
              <strong>{siteName(n.site_id)}</strong> {formatShiftTime(n.start_time, n.end_time)}
              <span className={n.status === 'open' ? 'badge open' : 'badge'}>
                {n.status === 'open' ? 'Open' : `Filled: ${doctorName(n.filled_by_doctor_id)}`}
              </span>
              <div className="muted small">
                {n.required_skill === 'Emergency' ? 'Any doctor' : `Needs ${n.required_skill}`}
                {n.notes && ` · ${n.notes}`}
              </div>
            </div>
            {view === 'officer' && (
              <div className="inline">
                {n.status === 'open' ? (
                  <select
                    value=""
                    onChange={(e) => e.target.value && update(n, { status: 'filled', filled_by_doctor_id: e.target.value })}
                  >
                    <option value="">Mark filled by…</option>
                    {doctors.map((d) => (
                      <option key={d.doctor_id} value={d.doctor_id}>{d.name}</option>
                    ))}
                  </select>
                ) : (
                  <button className="secondary" onClick={() => update(n, { status: 'open', filled_by_doctor_id: null })}>Reopen</button>
                )}
                <button
                  className="link danger"
                  onClick={() => window.confirm('Cancel this shift?') && update(n, { status: 'cancelled' })}
                >
                  Cancel
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {view === 'doctor' && notices.some((n) => n.status === 'open') && (
        <p className="muted small">Applying for shifts arrives in the next update.</p>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function PostShift({ sites, defaultDate, onPosted }) {
  const blank = { site_id: '', shift_date: '', start_time: '08:00', end_time: '17:00', required_skill: 'Emergency', notes: '' };
  const [form, setForm] = useState(blank);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const siteId = form.site_id || (sites.length === 1 ? sites[0].site_id : '');
  const shiftDate = form.shift_date || defaultDate;

  async function post(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    const { error } = await supabase.from('district_notices').insert({
      ...form,
      site_id: siteId,
      shift_date: shiftDate,
      notes: form.notes.trim() || null,
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setMessage('Shift posted.');
    setForm(blank);
    onPosted();
  }

  return (
    <form className="card stack" onSubmit={post}>
      <h2>Post a shift</h2>
      <div className="form-grid">
        <label>
          Site
          <select value={siteId} onChange={set('site_id')} required>
            <option value="">Choose…</option>
            {sites.map((s) => (
              <option key={s.site_id} value={s.site_id}>{s.name}</option>
            ))}
          </select>
        </label>
        <label>
          Date
          <input type="date" value={shiftDate} onChange={set('shift_date')} required />
        </label>
        <label>
          Start
          <input type="time" value={form.start_time} onChange={set('start_time')} required />
        </label>
        <label>
          Finish
          <input type="time" value={form.end_time} onChange={set('end_time')} required />
        </label>
        <label>
          Needs
          <select value={form.required_skill} onChange={set('required_skill')}>
            {SKILLS.map((s) => (
              <option key={s} value={s}>{s === 'Emergency' ? 'Any doctor' : s}</option>
            ))}
          </select>
        </label>
        <label>
          Notes
          <input value={form.notes} onChange={set('notes')} placeholder="Optional" />
        </label>
      </div>
      <p className="muted small">A finish earlier than the start means it ends the next day.</p>
      {error && <p className="error">{error}</p>}
      {message && <p className="ok">{message}</p>}
      <button type="submit" disabled={busy}>Post shift</button>
    </form>
  );
}
