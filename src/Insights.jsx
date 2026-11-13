import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { toLocalDateStr } from './dateUtils';

// For district officers, and for showing an LHD what DR App does: how many
// vacancies are filled before the shift, how fast and how far ahead, closures
// averted, work covered by doctors from other sites, and the pool of doctors
// each site has. From district_insights (migrations/2026-11-13_insights.sql).

const PERIODS = [
  ['30', 'Last 30 days'],
  ['90', 'Last 90 days'],
  ['365', 'Last 12 months'],
];

const pct = (n, of) => (of ? `${Math.round((100 * n) / of)}%` : '–');
const num = (v, unit) => (v === null || v === undefined ? '–' : `${v}${unit ? ` ${unit}` : ''}`);

// The per-site table (the first SHOWN), and the CSV (all of them).
const COLUMNS = [
  ['name', 'Site'],
  ['doctors_ticked', 'Doctors willing to work there'],
  ['posted', 'Vacancies'],
  ['needed', 'Needed cover'],
  ['filled', 'Filled in DR App'],
  ['fill_rate', 'Fill rate'],
  ['covered_on_rstar', 'Covered locally on Rstar'],
  ['agency', 'Agency or locum'],
  ['no_outcome', 'No outcome recorded'],
  ['median_hours_to_fill', 'Median hours to fill'],
  ['median_hours_to_first_applicant', 'Median hours to first applicant'],
  ['median_days_filled_ahead', 'Median days filled ahead'],
  ['filled_last_48h', 'Filled in the last 48 hours'],
  ['applicants_per_vacancy', 'Applicants per vacancy'],
  ['filled_by_applying', 'Filled by a doctor applying'],
  ['filled_by_officer', 'Filled by an officer booking'],
  ['filled_from_other_sites', 'Filled by doctors from other sites'],
  ['outside_app', 'Filled some other way'],
  ['service_closed', 'Service closed'],
  ['went_unfilled', 'Went unfilled (ran short)'],
  ['not_needed', 'No longer needed'],
  ['withdrawn', 'Withdrawn on Rstar'],
  ['upcoming_open', 'Upcoming, still open'],
  ['escalated', 'Escalated from Rstar'],
  ['escalated_filled', 'Escalated and filled'],
  ['disruption_flagged', 'Service would close'],
  ['disruption_averted', 'Closures averted'],
  ['swaps_done', 'Swaps done'],
  ['swaps_cross_site', 'Swaps across sites'],
];
const SHOWN = 12;

// Where every vacancy that needed cover went; these add up to needed.
const WENT = [
  ['filled', 'Filled in DR App'],
  ['covered_on_rstar', 'Covered locally on Rstar'],
  ['agency', 'Agency or locum'],
  ['outside_app', 'Filled some other way'],
  ['service_closed', 'Service closed'],
  ['went_unfilled', 'Nobody covered it (ran short)'],
  ['no_outcome', 'No outcome recorded yet'],
];

const cell = (row, key) => (key === 'fill_rate' ? pct(row.filled, row.needed) : row[key] ?? '');

function csv(rows, from, to) {
  const quote = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [COLUMNS.map(([, label]) => quote(label)).join(','), ...rows.map((r) => COLUMNS.map(([k]) => quote(cell(r, k))).join(','))];
  const blob = new Blob([`DR App insights ${from} to ${to}\n${lines.join('\n')}\n`], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `dr-app-insights-${from}-to-${to}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function Insights({ districtId, districtName }) {
  const [period, setPeriod] = useState('90');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const to = toLocalDateStr(new Date());
  const from = (() => {
    const d = new Date();
    d.setDate(d.getDate() - Number(period));
    return toLocalDateStr(d);
  })();

  useEffect(() => {
    setData(null);
    setError('');
    supabase.rpc('district_insights', { p_district_id: districtId, p_from: from, p_to: to }).then(({ data, error }) => {
      if (error) setError(error.message);
      else setData(data);
    });
  }, [districtId, from, to]);

  const rows = data?.sites ?? [];
  const all = rows.find((r) => r.site_id === null);
  const sites = rows.filter((r) => r.site_id !== null);

  return (
    <div className="stack">
      <div className="card stack">
        <div className="inline" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Insights{districtName ? `: ${districtName}` : ''}</h2>
          <div className="inline">
            <select value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Period">
              {PERIODS.map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
            <button className="secondary" disabled={!rows.length} onClick={() => csv(rows, from, to)}>Download CSV</button>
          </div>
        </div>
        <p className="small muted">
          District vacancies dated {from} to {to}. Outcomes count only shifts that have started.
        </p>
        {error && <p className="error">{error}</p>}
        {!data && !error && <p className="muted">Loading…</p>}
        {all?.posted > 0 && (
          <div className="tiles">
            <Tile label="Filled in DR App" value={pct(all.filled, all.needed)} detail={`${all.filled} of ${all.needed} shifts that needed cover`} />
            <Tile label="Median time to fill" value={num(all.median_hours_to_fill, 'h')} detail={`first applicant ${num(all.median_hours_to_first_applicant, 'h')}`} />
            <Tile label="Median days filled ahead" value={num(all.median_days_filled_ahead)} detail={`${all.filled_last_48h} filled in the last 48 hours`} />
            <Tile label="Closures averted" value={`${all.disruption_averted}`} detail={`of ${all.disruption_flagged} flagged "service would close"`} />
            <Tile label="Filled by doctors from other sites" value={`${all.filled_from_other_sites}`} detail="work a single site couldn't cover" />
            <Tile label="Escalated from Rstar, then filled" value={`${all.escalated_filled}`} detail={`of ${all.escalated} escalated`} />
            <Tile label="Went to agency or locum" value={`${all.agency}`} detail={`${all.service_closed} closed the service, ${all.went_unfilled} ran short`} />
            <Tile label="Doctors on DR App" value={`${all.doctors_ticked}`} detail={`${all.applicants_per_vacancy ?? 0} applicants per vacancy`} />
          </div>
        )}
        {data && !(all?.posted > 0) && <p className="muted">No district vacancies in this period yet.</p>}
        {all?.no_outcome > 0 && (
          <p className="small">
            <strong>{all.no_outcome} shift{all.no_outcome === 1 ? '' : 's'} started open with no outcome recorded.</strong> Calendar asks
            each site's officers what happened; until they answer, those count against the fill rate.
          </p>
        )}
      </div>

      {all?.needed > 0 && (
        <div className="card stack">
          <h2>Where every vacancy went</h2>
          <p className="small muted">
            The {all.needed} shift{all.needed === 1 ? '' : 's'} that started and still needed cover.
            {all.not_needed + all.withdrawn > 0 && ` ${all.not_needed + all.withdrawn} more were no longer needed or withdrawn, and aren't counted.`}
          </p>
          <div className="table-wrap">
            <table className="insights">
              <tbody>
                {WENT.map(([k, label]) => (
                  <tr key={k}>
                    <td>{label}</td>
                    <td>{all[k]}</td>
                    <td>{pct(all[k], all.needed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {sites.length > 0 && (
        <div className="card stack">
          <h2>By site</h2>
          <p className="small muted">
            Sites with more doctors willing to work there should fill faster and more often: that's the network DR App builds.
          </p>
          <div className="table-wrap">
            <table className="insights">
              <thead>
                <tr>
                  {COLUMNS.slice(0, SHOWN).map(([k, label]) => <th key={k}>{label}</th>)}
                </tr>
              </thead>
              <tbody>
                {sites.map((r) => (
                  <tr key={r.site_id}>
                    {COLUMNS.slice(0, SHOWN).map(([k]) => <td key={k}>{cell(r, k)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">The CSV has every measure, including closures, agency, swaps and escalations per site.</p>
        </div>
      )}

      <PoolTrend trend={data?.trend ?? []} sites={sites} />

      <details className="card">
        <summary><strong>How these are measured</strong></summary>
        <ul className="small">
          <li><strong>Vacancies</strong> are district shifts posted by officers, imported, or escalated from Rstar. Shifts listed for swap are counted as swaps instead.</li>
          <li><strong>Needed cover</strong>: vacancies that have started, less those cancelled as no longer needed or withdrawn on Rstar.</li>
          <li><strong>Fill rate</strong>: of those, the share filled in DR App (a doctor applied and was approved, or an officer booked a DR App doctor). Every other one is accounted for under Where every vacancy went.</li>
          <li><strong>Covered locally on Rstar</strong>: an escalated Rstar gap a local doctor then took (recorded automatically), or a shift the officer says they rostered a local onto. These count separately, not as DR App fills: the ad may have helped, but that can't be shown.</li>
          <li><strong>No outcome recorded</strong>: started while still open, and nobody has said what happened. Calendar asks the site's officers.</li>
          <li><strong>Time to fill</strong> runs from posting to filling; <strong>days filled ahead</strong> from filling to the shift's start. Only fills made before the shift count; one recorded afterwards says nothing about speed. Late fills are where agency rates sit.</li>
          <li><strong>Closures averted</strong>: shifts flagged "service would close if unfilled" that were filled in DR App.</li>
          <li><strong>Agency or locum</strong>, <strong>filled some other way</strong>, <strong>service closed</strong> and <strong>ran short</strong> come from the reason given when a shift is cancelled, or from Calendar's What happened.</li>
          <li><strong>Doctors willing to work there</strong>: doctors with a login who have the site ticked under Sites I'd work at. It's recorded every night, for the trend below.</li>
          <li>For an avoided-cost estimate, multiply shifts filled by the difference between the agency day rate and the internal rate.</li>
        </ul>
      </details>
    </div>
  );
}

function Tile({ label, value, detail }) {
  return (
    <div className="tile">
      <div className="small muted">{label}</div>
      <div className="tile-value">{value}</div>
      {detail && <div className="small muted">{detail}</div>}
    </div>
  );
}

// Doctors willing to work at each site, from the nightly counts: first and
// latest in the period.
function PoolTrend({ trend, sites }) {
  if (!trend.length || !sites.length) return null;
  const days = [...new Set(trend.map((t) => t.day))].sort();
  const first = days[0];
  const last = days[days.length - 1];
  const at = (siteId, day) => trend.find((t) => t.site_id === siteId && t.day === day);
  return (
    <div className="card stack">
      <h2>Pool of doctors</h2>
      <p className="small muted">
        Doctors willing to work at each site, {first === last ? `on ${first}` : `${first} and ${last}`}. Counted every night from 13 November 2026.
      </p>
      <div className="table-wrap">
        <table className="insights">
          <thead>
            <tr>
              <th>Site</th>
              {first !== last && <th>{first}</th>}
              <th>{last}</th>
              <th>Open vacancies now</th>
            </tr>
          </thead>
          <tbody>
            {sites.map((s) => (
              <tr key={s.site_id}>
                <td>{s.name}</td>
                {first !== last && <td>{at(s.site_id, first)?.doctors_ticked ?? '–'}</td>}
                <td>{at(s.site_id, last)?.doctors_ticked ?? '–'}</td>
                <td>{at(s.site_id, last)?.open_vacancies ?? '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
