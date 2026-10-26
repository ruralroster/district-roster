import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { supabase, SKILLS, POSITIONS, POSITION_LABEL } from './supabase';
import { getMondayOfWeek, toLocalDateStr, isSameDate, formatShiftTime } from './dateUtils';
import BulkShifts from './BulkShifts';

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
    applied: { label: "You've applied" },
    booked: { label: "You're booked" },
    unavailable: { label: 'Not available' },
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
  // Doctors see their own; officers their sites' (RLS).
  const [applications, setApplications] = useState([]);
  // Days the doctor has marked themselves unavailable ("2026-11-03").
  const [unavailable, setUnavailable] = useState(new Set());
  // For the doctor: notice_id -> { interested, problem } for open shifts
  // their skills fit. problem is why they can't do it (rest, unavailable).
  const [availability, setAvailability] = useState(new Map());
  const [doctors, setDoctors] = useState([]);
  const [shiftTypes, setShiftTypes] = useState([]);
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
    const ids = (data ?? []).map((n) => n.notice_id);
    const { data: apps } = ids.length
      ? await supabase.from('district_applications').select('*').in('notice_id', ids).order('created_at')
      : { data: [] };
    setApplications(apps ?? []);
    if (me) {
      const { data: days } = await supabase
        .from('district_unavailable_days')
        .select('date')
        .eq('doctor_id', me.doctor_id)
        .gte('date', rangeStart)
        .lte('date', rangeEnd);
      setUnavailable(new Set((days ?? []).map((d) => d.date)));
      const { data: avail } = await supabase.rpc('my_shift_availability', {
        p_district_id: districtId,
        p_from: rangeStart,
        p_to: rangeEnd,
      });
      setAvailability(new Map((avail ?? []).map((a) => [a.notice_id, a])));
    }
  }, [districtId, rangeStart, rangeEnd, me]);

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
    supabase
      .from('site_shift_types')
      .select('*')
      .in('site_id', [...officerSiteIds])
      .order('start_time')
      .order('name')
      .then(({ data }) => setShiftTypes(data ?? []));
  }, [districtId, isOfficer, officerSiteIds]);

  // My latest application for a notice, if any.
  const myApplication = (noticeId) =>
    me && applications.filter((a) => a.notice_id === noticeId && a.doctor_id === me.doctor_id).at(-1);

  // The notices this view is about: officers see their own sites'; doctors
  // see only open ones they can do (skills, a site they'd work at, rested,
  // not marked unavailable), plus anything they've applied for or are
  // booked on.
  const canDo = (n) => n.status === 'open' && availability.has(n.notice_id) && !availability.get(n.notice_id).problem;
  const relevant = notices.filter((n) =>
    view === 'officer'
      ? officerSiteIds.has(n.site_id)
      : (canDo(n) && !!availability.get(n.notice_id)?.interested) ||
        (me && n.filled_by_doctor_id === me.doctor_id) ||
        !!myApplication(n.notice_id),
  );

  function dayStatus(dateStr) {
    const list = relevant.filter((n) => n.shift_date === dateStr);
    const openCount = list.filter((n) => n.status === 'open').length;
    if (view === 'officer') {
      if (openCount > 0) return { status: 'open', count: openCount };
      return { status: list.length > 0 ? 'filled' : 'none', count: 0 };
    }
    const canCount = list.filter(canDo).length;
    if (list.some((n) => n.filled_by_doctor_id === me?.doctor_id)) return { status: 'booked', count: canCount };
    if (list.some((n) => myApplication(n.notice_id)?.status === 'pending')) return { status: 'applied', count: canCount };
    if (unavailable.has(dateStr)) return { status: 'unavailable', count: 0 };
    return { status: canCount > 0 ? 'available' : 'none', count: canCount };
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
          applications={applications}
          availability={availability}
          unavailable={unavailable.has(toLocalDateStr(selectedDate))}
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
          shiftTypes={shiftTypes}
          defaultDate={selectedDate ? toLocalDateStr(selectedDate) : ''}
          onPosted={load}
        />
      )}

      {view === 'officer' && (
        <BulkShifts sites={sites.filter((s) => officerSiteIds.has(s.site_id))} shiftTypes={shiftTypes} onPosted={load} />
      )}
    </div>
  );
}

function DayPanel({ date, notices, applications, availability, unavailable, view, sites, doctors, me, onChanged }) {
  const [error, setError] = useState('');
  const siteName = (id) => sites.find((s) => s.site_id === id)?.name ?? '';
  const doctorName = (id) => doctors.find((d) => d.doctor_id === id)?.name ?? (id === me?.doctor_id ? 'You' : 'A district doctor');

  async function update(notice, changes) {
    setError('');
    const { error } = await supabase.from('district_notices').update(changes).eq('notice_id', notice.notice_id);
    if (error) setError(error.message);
    onChanged();
  }

  async function setAvailable(available) {
    setError('');
    const dateStr = toLocalDateStr(date);
    const { error } = available
      ? await supabase.from('district_unavailable_days').delete().eq('doctor_id', me.doctor_id).eq('date', dateStr)
      : await supabase.from('district_unavailable_days').insert({ doctor_id: me.doctor_id, date: dateStr });
    if (error) setError(error.message);
    onChanged();
  }

  // Runs an application RPC, then refreshes.
  async function rpc(name, args) {
    setError('');
    const { error } = await supabase.rpc(name, args);
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
              <strong>{siteName(n.site_id)}</strong> {n.title && `${n.title} `}{formatShiftTime(n.start_time, n.end_time)}
              <span className={n.status === 'open' ? 'badge open' : 'badge'}>
                {n.status === 'open' ? 'Open' : `Filled: ${doctorName(n.filled_by_doctor_id)}`}
              </span>
              <div className="muted small">
                {POSITION_LABEL[n.position] ?? 'Consultant'} · {n.required_skill === 'Emergency' ? 'Any doctor' : `Needs ${n.required_skill}`}
                {n.notes && ` · ${n.notes}`}
              </div>
              {view === 'doctor' && (
                <MyApplication notice={n} me={me} applications={applications} problem={availability.get(n.notice_id)?.problem} rpc={rpc} />
              )}
              {view === 'officer' && n.status === 'open' && (
                <Applicants notice={n} applications={applications} doctors={doctors} rpc={rpc} />
              )}
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
      {view === 'doctor' && me && (
        <div className="inline small">
          {unavailable ? (
            <>
              <span className="badge">You've marked this day unavailable</span>
              <button className="link" onClick={() => setAvailable(true)}>I'm available after all</button>
            </>
          ) : (
            <button className="secondary" onClick={() => setAvailable(false)}>I'm not available this day</button>
          )}
          <span className="muted">You won't be told about new shifts on days you're not available.</span>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

// Doctor: apply (with an optional note), see where it's up to, withdraw.
function MyApplication({ notice, me, applications, problem, rpc }) {
  const [applying, setApplying] = useState(false);
  const [note, setNote] = useState('');
  const mine = applications.filter((a) => a.notice_id === notice.notice_id && a.doctor_id === me?.doctor_id).at(-1);

  if (notice.filled_by_doctor_id === me?.doctor_id) return <span className="badge booked">You're booked</span>;
  if (mine?.status === 'pending') {
    return (
      <div className="inline small">
        <span className="badge applied">Applied</span>
        <button className="link" onClick={() => window.confirm('Withdraw your application?') && rpc('withdraw_application', { p_application_id: mine.application_id })}>
          Withdraw
        </button>
      </div>
    );
  }
  const before = mine && {
    declined: `Not this time${mine.decline_reason ? `: ${mine.decline_reason}` : ''}`,
    cancelled: 'Your booking was cancelled',
    withdrawn: 'You withdrew',
  }[mine.status];
  if (notice.status !== 'open') return before ? <div className="small muted">{before}</div> : null;
  if (problem) return <div className="small muted">Not for you: {problem}</div>;

  return (
    <div className="stack small">
      {before && <span className="muted">{before}</span>}
      {applying ? (
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            rpc('apply_for_notice', { p_notice_id: notice.notice_id, p_note: note });
            setApplying(false);
            setNote('');
          }}
        >
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the officer (optional)" />
          <button type="submit">Send application</button>
          <button type="button" className="link" onClick={() => setApplying(false)}>Cancel</button>
        </form>
      ) : (
        <div>
          <button onClick={() => setApplying(true)}>{before ? 'Apply again' : 'Apply'}</button>
        </div>
      )}
    </div>
  );
}

// Officer: who's applied for an open shift, to approve or decline.
function Applicants({ notice, applications, doctors, rpc }) {
  const waiting = applications.filter((a) => a.notice_id === notice.notice_id && a.status === 'pending');
  // From a roster-app card: the skills it needs for the role, and who's
  // known to hold one (staff there). Approving someone else asks first.
  const [cardSkills, setCardSkills] = useState({ skills: [], holders: [] });
  // Posted shifts can be linked to a roster-app offer too, so always ask.
  const fromCard = waiting.length > 0;
  useEffect(() => {
    if (!fromCard) return;
    supabase.rpc('district_card_skills', { p_notice_id: notice.notice_id }).then(({ data }) => {
      if (data) setCardSkills(data);
    });
  }, [fromCard, notice.notice_id]);

  if (!waiting.length) return <div className="small muted">No applications yet</div>;
  const doctorName = (id) => doctors.find((d) => d.doctor_id === id)?.name ?? 'A doctor';
  const needs = cardSkills.skills.join(' or ');
  const holds = (id) => cardSkills.holders.includes(id);
  function approve(a) {
    if (needs && !holds(a.doctor_id) &&
        !window.confirm(`This card needs ${needs}. Check ${doctorName(a.doctor_id)} has it. Approve them?`)) return;
    rpc('approve_application', { p_application_id: a.application_id });
  }
  return (
    <ul className="applicants small">
      {needs && <li className="muted">The roster-app card needs {needs}.</li>}
      {waiting.map((a) => (
        <li key={a.application_id}>
          <span className="badge applied">Applied</span>
          <strong>{doctorName(a.doctor_id)}</strong>
          {needs && (holds(a.doctor_id)
            ? <span className="ok">Has {needs} on roster-app</span>
            : <span className="warn">Check they have {needs}</span>)}
          {a.note && <span className="muted">"{a.note}"</span>}
          <button onClick={() => approve(a)}>Approve</button>
          <button
            className="secondary"
            onClick={() => {
              const reason = window.prompt(`Decline ${doctorName(a.doctor_id)}? Add a reason for them if you like.`, '');
              if (reason !== null) rpc('decline_application', { p_application_id: a.application_id, p_reason: reason });
            }}
          >
            Decline
          </button>
        </li>
      ))}
    </ul>
  );
}

function PostShift({ sites, shiftTypes, defaultDate, onPosted }) {
  const blank = { site_id: '', shift_date: '', title: '', start_time: '08:00', end_time: '17:00', required_skill: 'Emergency', position: 'consultant', notes: '' };
  const [form, setForm] = useState(blank);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const siteId = form.site_id || (sites.length === 1 ? sites[0].site_id : '');
  const shiftDate = form.shift_date || defaultDate;
  const siteTypes = shiftTypes.filter((t) => t.site_id === siteId);
  // Picking a shift type fills in its times and skill.
  function pickType(e) {
    const type = siteTypes.find((t) => t.shift_type_id === e.target.value);
    setForm((f) =>
      type
        ? { ...f, title: type.name, start_time: type.start_time.slice(0, 5), end_time: type.end_time.slice(0, 5), required_skill: type.required_skill }
        : { ...f, title: '' },
    );
  }

  async function post(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    const { error } = await supabase.from('district_notices').insert({
      ...form,
      site_id: siteId,
      shift_date: shiftDate,
      title: form.title || null,
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
        {siteTypes.length > 0 && (
          <label>
            Shift
            <select value={siteTypes.find((t) => t.name === form.title)?.shift_type_id ?? ''} onChange={pickType}>
              <option value="">Other times…</option>
              {siteTypes.map((t) => (
                <option key={t.shift_type_id} value={t.shift_type_id}>{t.name}</option>
              ))}
            </select>
          </label>
        )}
        <label>
          Start
          <input type="time" value={form.start_time} onChange={set('start_time')} required />
        </label>
        <label>
          Finish
          <input type="time" value={form.end_time} onChange={set('end_time')} required />
        </label>
        <label>
          Position
          <select value={form.position} onChange={set('position')}>
            {POSITIONS.map((k) => (
              <option key={k} value={k}>{POSITION_LABEL[k]}</option>
            ))}
          </select>
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
      <p className="muted small">A finish earlier than the start means it ends the next day; the same as the start, 24 hours.</p>
      {error && <p className="error">{error}</p>}
      {message && <p className="ok">{message}</p>}
      <button type="submit" disabled={busy}>Post shift</button>
    </form>
  );
}
