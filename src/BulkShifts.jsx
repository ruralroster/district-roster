import { useState } from 'react';
import { supabase, SKILLS } from './supabase';
import { formatShiftTime, toLocalDateStr } from './dateUtils';
import { readPastedVacancies, shiftTypeIn } from './pasteVacancies';
import { readDate, readTime } from './v3Import';

const skillText = (skill) => (skill === 'Emergency' ? 'Any doctor' : `Needs ${skill}`);
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

// Officers: several shifts at once, from a pasted email or WhatsApp
// message (one site), or a spreadsheet with a tab per site. Everything
// found is shown to check and correct before it's posted.
export default function BulkShifts({ sites, shiftTypes, onPosted }) {
  const [mode, setMode] = useState('paste');
  const [siteId, setSiteId] = useState(sites.length === 1 ? sites[0].site_id : '');
  const [text, setText] = useState('');
  const [rows, setRows] = useState(null);
  const [notes, setNotes] = useState([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const typesAt = (id) => shiftTypes.filter((t) => t.site_id === id);
  const siteName = (id) => sites.find((s) => s.site_id === id)?.name ?? '';
  const today = toLocalDateStr(new Date());

  // A preview row: one shift, editable. type is a shift_type_id or 'custom'.
  function makeRow(site_id, date, type, times, from) {
    return {
      key: `${site_id}|${date}|${Math.random()}`,
      site_id,
      date: date || '',
      type: type ? type.shift_type_id : times ? 'custom' : '',
      start_time: type?.start_time.slice(0, 5) ?? times?.start ?? '08:00',
      end_time: type?.end_time.slice(0, 5) ?? times?.end ?? '17:00',
      required_skill: type?.required_skill ?? 'Emergency',
      from,
      post: !!date && date >= today && !!(type || times),
    };
  }

  // Unticks rows already posted (same site, date and shift, not cancelled).
  async function markPosted(found) {
    const dates = found.map((r) => r.date).filter(Boolean).sort();
    if (!dates.length) return found;
    const { data } = await supabase
      .from('district_notices')
      .select('site_id, shift_date, title, start_time')
      .in('site_id', [...new Set(found.map((r) => r.site_id))])
      .gte('shift_date', dates[0])
      .lte('shift_date', dates[dates.length - 1])
      .neq('status', 'cancelled');
    return found.map((r) => {
      const type = shiftTypes.find((t) => t.shift_type_id === r.type);
      const already = (data ?? []).some(
        (n) => n.site_id === r.site_id && n.shift_date === r.date &&
          (type ? (n.title || '').toLowerCase() === type.name.toLowerCase() : n.start_time.slice(0, 5) === r.start_time),
      );
      return already ? { ...r, post: false, already: true } : r;
    });
  }

  async function readText() {
    setError('');
    setMessage('');
    const { vacancies, unread } = readPastedVacancies(text, typesAt(siteId), siteName(siteId));
    setRows(await markPosted(vacancies.map((v) => makeRow(siteId, v.date, v.shiftType, v.times, v.line))));
    setNotes(unread.map((line) => `No date found for: ${line}`));
  }

  async function readFile(e) {
    const file = e.target.files[0];
    setError('');
    setMessage('');
    setRows(null);
    if (!file) return;
    try {
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(await file.arrayBuffer());
      const found = [];
      const skipped = [];
      for (const tab of workbook.SheetNames) {
        const site = sites.find((s) => s.name.toLowerCase() === clean(tab).toLowerCase());
        if (!site) {
          skipped.push(tab);
          continue;
        }
        const table = XLSX.utils.sheet_to_json(workbook.Sheets[tab], { header: 1, defval: '' });
        const header = (table[0] ?? []).map((h) => clean(h).toLowerCase());
        const col = (...names) => header.findIndex((h) => names.includes(h));
        const cDate = col('date');
        const cShift = col('shift', 'shift type', 'job type', 'job');
        const cStart = col('start', 'start time');
        const cEnd = col('finish', 'end', 'end time', 'finish time');
        if (cDate === -1) {
          skipped.push(`${tab} (no Date column)`);
          continue;
        }
        for (const line of table.slice(1)) {
          const date = readDate(line[cDate]);
          const shiftName = cShift === -1 ? '' : clean(line[cShift]);
          if (!date && !shiftName) continue;
          const types = typesAt(site.site_id);
          const type =
            types.find((t) => t.name.toLowerCase() === shiftName.toLowerCase()) ??
            (shiftName ? shiftTypeIn(shiftName, types, site.name) : null);
          const start = cStart === -1 ? '' : readTime(line[cStart]);
          const end = cEnd === -1 ? '' : readTime(line[cEnd]);
          const times = !type && start && end ? { start, end } : null;
          found.push(makeRow(site.site_id, date, type, times, [tab, clean(line[cDate]), shiftName].filter(Boolean).join(' · ')));
        }
      }
      found.sort((a, b) => a.date.localeCompare(b.date));
      setRows(await markPosted(found));
      setNotes(skipped.length ? [`Tabs not read (no site with that name): ${skipped.join(', ')}`] : []);
    } catch (err) {
      setError(err.message);
    }
  }

  const edit = (key, change) =>
    setRows((all) =>
      all.map((r) => {
        if (r.key !== key) return r;
        const next = { ...r, ...change };
        const type = shiftTypes.find((t) => t.shift_type_id === change.type);
        if (type) {
          Object.assign(next, { start_time: type.start_time.slice(0, 5), end_time: type.end_time.slice(0, 5), required_skill: type.required_skill });
        }
        return next;
      }),
    );

  const toPost = (rows ?? []).filter((r) => r.post);
  const incomplete = toPost.some((r) => !r.date || !r.type);

  async function post() {
    setBusy(true);
    setError('');
    const { error } = await supabase.from('district_notices').insert(
      toPost.map((r) => {
        const type = shiftTypes.find((t) => t.shift_type_id === r.type);
        return {
          site_id: r.site_id,
          shift_date: r.date,
          start_time: r.start_time,
          end_time: r.end_time,
          required_skill: r.required_skill,
          title: type?.name ?? null,
          notes: type?.notes ?? null,
        };
      }),
    );
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setMessage(`${toPost.length} shift${toPost.length === 1 ? '' : 's'} posted.`);
    setRows(null);
    setText('');
    onPosted();
  }

  return (
    <div className="card stack">
      <h2>Add several shifts</h2>
      <div className="inline">
        <button className={mode === 'paste' ? '' : 'secondary'} onClick={() => { setMode('paste'); setRows(null); }}>Paste a message</button>
        <button className={mode === 'file' ? '' : 'secondary'} onClick={() => { setMode('file'); setRows(null); }}>Upload a spreadsheet</button>
      </div>

      {mode === 'paste' ? (
        <>
          <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            <option value="">Which site?</option>
            {sites.map((s) => (
              <option key={s.site_id} value={s.site_id}>{s.name}</option>
            ))}
          </select>
          <textarea
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'Paste the email or message, e.g.\nTue 28/10 late anaes on call\n1/11 and 2/11 nights'}
          />
          <button onClick={readText} disabled={!siteId || !text.trim()}>Read it</button>
          {siteId && typesAt(siteId).length === 0 && (
            <p className="small muted">This site has no shift types yet, so only times like 0800-2000 can be read. Add them on the Sites tab.</p>
          )}
        </>
      ) : (
        <>
          <p className="small muted">
            One tab per site, named exactly as the site (e.g. "Yarrabah"), with a <strong>Date</strong> column and a{' '}
            <strong>Shift</strong> column naming the site's shift type. Start and Finish columns are optional, for shifts
            that aren't a regular type.
          </p>
          <input type="file" accept=".xlsx,.xls,.csv" onChange={readFile} />
        </>
      )}

      {error && <p className="error">{error}</p>}
      {message && <p className="ok">{message}</p>}
      {notes.map((n) => (
        <p key={n} className="small muted">{n}</p>
      ))}

      {rows && (
        <>
          {rows.length === 0 && <p className="muted">No shifts found.</p>}
          <ul className="rows">
            {rows.map((r) => (
              <li key={r.key} className={`row column${r.post ? '' : ' inactive'}`}>
                <div className="inline">
                  <input type="checkbox" checked={r.post} onChange={() => edit(r.key, { post: !r.post })} aria-label="Post this shift" />
                  {mode === 'file' && <strong>{siteName(r.site_id)}</strong>}
                  <input type="date" value={r.date} onChange={(e) => edit(r.key, { date: e.target.value })} />
                  <select value={r.type} onChange={(e) => edit(r.key, { type: e.target.value })}>
                    <option value="">Which shift?</option>
                    {typesAt(r.site_id).map((t) => (
                      <option key={t.shift_type_id} value={t.shift_type_id}>
                        {t.name} ({formatShiftTime(t.start_time, t.end_time)})
                      </option>
                    ))}
                    <option value="custom">Other times…</option>
                  </select>
                  {r.type === 'custom' && (
                    <>
                      <input type="time" value={r.start_time} onChange={(e) => edit(r.key, { start_time: e.target.value })} aria-label="Start" />
                      <input type="time" value={r.end_time} onChange={(e) => edit(r.key, { end_time: e.target.value })} aria-label="Finish" />
                      <select value={r.required_skill} onChange={(e) => edit(r.key, { required_skill: e.target.value })} aria-label="Needs">
                        {SKILLS.map((k) => (
                          <option key={k} value={k}>{skillText(k)}</option>
                        ))}
                      </select>
                    </>
                  )}
                </div>
                <div className="small muted">
                  {r.already && 'Already posted. '}
                  {r.date && r.date < today && 'In the past. '}
                  {r.from && `From: "${r.from}"`}
                </div>
              </li>
            ))}
          </ul>
          {incomplete && <p className="small error">Every ticked shift needs a date and a shift.</p>}
          <button onClick={post} disabled={busy || incomplete || !toPost.length}>
            {busy ? 'Posting…' : `Post ${toPost.length} shift${toPost.length === 1 ? '' : 's'}`}
          </button>
        </>
      )}
    </div>
  );
}
