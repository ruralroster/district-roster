import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { supabase } from './supabase';
import { formatShiftTime, toLocalDateStr } from './dateUtils';
import { siteHues, siteStyle } from './siteColours';
import { blockedSlots } from './swapSlots';

// The swap marketplace (migrations/2026-10-31_swaps.sql), v3's flow:
// doctors list a shift they're booked on (or a roster-app one, from
// roster-app), others take it or offer one of their own in return, and the
// site's officer approves the pairing. Until then the doctor still works
// it. Every write is an RPC that checks the rules again.

// Pay fortnights start on Mondays two weeks apart from Mon 25 May 2026 (as
// v3 and district_fortnight_start).
const ANCHOR = new Date(2026, 4, 25);
function fortnightDays(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const offset = Math.floor(Math.round((d - ANCHOR) / 86400000) / 14) * 14;
  return Array.from({ length: 14 }, (_, i) => {
    const day = new Date(ANCHOR);
    day.setDate(day.getDate() + offset + i);
    return toLocalDateStr(day);
  });
}

// My shifts covers this many weeks of roster-app shifts (DR Roster ones: all).
const WEEKS_AHEAD = 12;
const addDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return toLocalDateStr(d);
};

// My shifts as a list or a calendar, remembered on this device.
const VIEW_KEY = 'dr-my-shifts-view';
function savedView() {
  try {
    return localStorage.getItem(VIEW_KEY) === 'calendar' ? 'calendar' : 'list';
  } catch {
    return 'list';
  }
}

// Up for swap / Find a swap look at the same site only, unless this is
// ticked. Not remembered: it's off each time.
function SiteScope({ otherSites, setOtherSites }) {
  return (
    <label className="check small">
      <input type="checkbox" checked={otherSites} onChange={(e) => setOtherSites(e.target.checked)} />
      Look across sites
    </label>
  );
}

const dayLabel = (dateStr) =>
  new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
// "2026-11-03:night" -> "Tue 3 Nov night"
const slotLabel = (slot) => {
  const [date, kind] = slot.split(':');
  return `${dayLabel(date)} ${kind}`;
};

export default function Swaps({ districtId, sites, me, officerSiteIds }) {
  const [mine, setMine] = useState([]); // shifts I'm booked on, from today
  const [rosterShifts, setRosterShifts] = useState([]); // my roster-app shifts at the district's sites
  const [listings, setListings] = useState([]);
  const [offers, setOffers] = useState([]);
  const [market, setMarket] = useState([]);
  const [notices, setNotices] = useState(new Map());
  const [doctors, setDoctors] = useState(new Map());
  const [listing, setListing] = useState(null); // the shift being listed
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [otherSites, setOtherSites] = useState(false);
  const today = toLocalDateStr(new Date());
  const hues = siteHues(sites);

  const load = useCallback(async () => {
    const [mineRes, listingsRes, offersRes, marketRes, doctorsRes, rosterRes] = await Promise.all([
      me
        ? supabase.from('district_notices').select('*').eq('filled_by_doctor_id', me.doctor_id).eq('status', 'filled')
          .gte('shift_date', today).order('shift_date').order('start_time')
        : { data: [] },
      supabase.from('district_swap_listings').select('*').eq('district_id', districtId).order('created_at', { ascending: false }).limit(300),
      supabase.from('district_swap_offers').select('*').order('created_at', { ascending: false }).limit(300),
      me ? supabase.rpc('my_swap_market', { p_district_id: districtId, p_other_sites: otherSites }) : { data: [] },
      supabase.from('district_doctors').select('doctor_id, name').eq('district_id', districtId),
      me ? supabase.rpc('my_roster_swap_shifts', { p_from: today, p_to: addDays(today, WEEKS_AHEAD * 7) }) : { data: [] },
    ]);
    const firstError = [mineRes, listingsRes, offersRes, marketRes, rosterRes].find((r) => r.error)?.error;
    if (firstError) setError(firstError.message);
    const ls = listingsRes.data ?? [];
    const os = offersRes.data ?? [];
    setMine(mineRes.data ?? []);
    setRosterShifts(rosterRes.data ?? []);
    setListings(ls);
    setOffers(os);
    setMarket(marketRes.data ?? []);
    setDoctors(new Map((doctorsRes.data ?? []).map((d) => [d.doctor_id, d.name])));
    // Every shift the page mentions.
    const ids = [
      ...new Set([
        ...ls.map((l) => l.notice_id),
        ...os.map((o) => o.offered_notice_id).filter(Boolean),
      ]),
    ];
    const { data: ns } = ids.length ? await supabase.from('district_notices').select('*').in('notice_id', ids) : { data: [] };
    setNotices(new Map([...(ns ?? []), ...(mineRes.data ?? [])].map((n) => [n.notice_id, n])));
  }, [districtId, me, today, otherSites]);

  useEffect(() => {
    load();
  }, [load]);

  async function rpc(name, args, done) {
    setBusy(true);
    setError('');
    setMessage('');
    const { error } = await supabase.rpc(name, args);
    setBusy(false);
    if (error) setError(error.message);
    else if (done) setMessage(done);
    load();
    return !error;
  }

  const siteName = (id) => sites.find((s) => s.site_id === id)?.name ?? '';
  // Across sites: has my side approved already (waiting for the other)?
  const approvedByMe = (o, n) => {
    const offered = notices.get(o.offered_notice_id);
    if (!offered || offered.site_id === n.site_id) return false;
    const mine = [
      officerSiteIds.has(n.site_id) && !o.listing_site_approved_by,
      officerSiteIds.has(offered.site_id) && !o.offered_site_approved_by,
    ];
    return !mine.some(Boolean);
  };
  const name = (doctorId) => doctors.get(doctorId) ?? 'A doctor';
  const ShiftText = ({ notice }) =>
    notice ? (
      <span>
        <strong className="site-name">{siteName(notice.site_id) || notice.site_name}</strong> {dayLabel(notice.shift_date)} · {notice.title && `${notice.title} `}
        {formatShiftTime(notice.start_time, notice.end_time)}
      </span>
    ) : (
      <span className="muted">A shift</span>
    );

  const openListing = (noticeId) => listings.find((l) => l.notice_id === noticeId && l.status === 'open');
  const myOffers = me ? offers.filter((o) => o.doctor_id === me.doctor_id) : [];
  const marketShown = market.filter((m) => m.swap_options?.length);
  // Find a swap: listings up for swap where this shift of mine (key 'n:…'
  // or 'a:…', as in My shifts) is a valid trade, not already offered.
  const swapsFor = (key) =>
    marketShown
      .filter((m) => m.swap_options.some((o) => (o.notice_id ? `n:${o.notice_id}` : `a:${o.assignment_id}`) === key))
      .filter((m) => !myOffers.some((o) => o.listing_id === m.listing_id && o.status === 'pending'))
      .map((m) => listings.find((l) => l.listing_id === m.listing_id))
      .filter((l) => l && notices.get(l.notice_id));
  // Every shift I work: DR Roster bookings, and roster-app shifts at the
  // district's sites (my primary site's roster included). A DR Roster
  // booking that's also on a roster-app card shows once, as the DR one.
  const siteIdByName = new Map(sites.map((s) => [s.name, s.site_id]));
  const drShifts = mine.filter((n) => n.source !== 'roster_shift');
  const sameShift = (a, b) =>
    a.site_id === b.site_id && a.shift_date === b.shift_date && a.start_time === b.start_time && a.end_time === b.end_time;
  const myShifts = [
    ...drShifts.map((n) => ({ key: `n:${n.notice_id}`, noticeId: n.notice_id, shift: n, listing: openListing(n.notice_id) })),
    ...rosterShifts
      .map((r) => ({
        key: `a:${r.assignment_id}`,
        assignmentId: r.assignment_id,
        shift: {
          site_id: siteIdByName.get(r.site_name), site_name: r.site_name, shift_date: r.date,
          title: r.label, start_time: r.start_time, end_time: r.end_time,
        },
        listing: r.listing_id
          ? listings.find((l) => l.listing_id === r.listing_id) ?? { listing_id: r.listing_id, available_slots: [] }
          : null,
      }))
      .filter((r) => !drShifts.some((n) => sameShift(n, r.shift))),
  ].sort((a, b) => a.shift.shift_date.localeCompare(b.shift.shift_date) || a.shift.start_time.localeCompare(b.shift.start_time));
  // Listings at my sites, and ones elsewhere with an offer of a shift at
  // one of my sites (a swap across sites: both sites' officers approve).
  const offeredHere = (o) => o.status === 'pending' && officerSiteIds.has(notices.get(o.offered_notice_id)?.site_id);
  const officerListings = listings.filter((l) => {
    const n = notices.get(l.notice_id);
    return l.status === 'open' && n
      && (officerSiteIds.has(n.site_id) || offers.some((o) => o.listing_id === l.listing_id && offeredHere(o)));
  });

  return (
    <div className="stack">
      {(error || message) && (
        <div className="card">
          {error && <p className="error">{error}</p>}
          {message && <p className="ok">{message}</p>}
        </div>
      )}

      {officerSiteIds.size > 0 && (
        <div className="card">
          <h2>Swaps at your sites</h2>
          {officerListings.length === 0 && <p className="muted">No shifts are up for swap at your sites.</p>}
          <ul className="rows">
            {officerListings.map((l) => {
              const n = notices.get(l.notice_id);
              const mySite = officerSiteIds.has(n.site_id);
              const pending = offers.filter((o) => o.listing_id === l.listing_id && o.status === 'pending' && (mySite || offeredHere(o)));
              return (
                <li key={l.listing_id} className="row column site-stripe" style={siteStyle(hues, n.site_id)}>
                  <div>
                    <ShiftText notice={n} /> · listed by <strong>{name(l.doctor_id)}</strong>
                    {l.note && <div className="small muted">"{l.note}"</div>}
                    {l.available_slots.length > 0 && (
                      <div className="small muted">Can work in return: {l.available_slots.map(slotLabel).join(', ')}</div>
                    )}
                  </div>
                  {pending.length === 0 && <div className="small muted">No offers yet.</div>}
                  <ul className="rows small">
                    {pending.map((o) => (
                      <li key={o.offer_id} className="row">
                        <span>
                          <strong>{name(o.doctor_id)}</strong>{' '}
                          {o.offered_notice_id ? (
                            <>offers their <ShiftText notice={notices.get(o.offered_notice_id)} /> in return</>
                          ) : (
                            'will take it'
                          )}
                          {o.note && <span className="muted"> "{o.note}"</span>}
                          <CrossSiteStatus offer={o} notice={n} offered={notices.get(o.offered_notice_id)} siteName={siteName} />
                        </span>
                        <span className="inline">
                          {!approvedByMe(o, n) && (
                            <button disabled={busy} onClick={() => rpc('approve_swap_offer', { p_offer_id: o.offer_id }, 'Approved.')}>
                              Approve
                            </button>
                          )}
                          <button
                            className="secondary"
                            disabled={busy}
                            onClick={() => {
                              const reason = window.prompt(`Decline ${name(o.doctor_id)}'s offer? Add a reason for them if you like.`, '');
                              if (reason !== null) rpc('decline_swap_offer', { p_offer_id: o.offer_id, p_reason: reason }, 'Declined.');
                            }}
                          >
                            Decline
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div hidden={!mySite}>
                    <button
                      className="link danger"
                      disabled={busy}
                      onClick={() => {
                        const reason = window.prompt('Take this shift off the swap list? Add a reason for the doctor if you like.', '');
                        if (reason !== null) rpc('remove_swap_listing', { p_listing_id: l.listing_id, p_reason: reason }, 'Taken down.');
                      }}
                    >
                      Take it off the swap list
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {me && (
        <div className="card">
          <div className="card-head">
            <h2>Up for swap</h2>
            <SiteScope otherSites={otherSites} setOtherSites={setOtherSites} />
          </div>
          <p className="small muted">
            Only swaps you could actually do: their shift for one of yours on a day or night they can work, with both of you
            passing the rules afterwards (your Rstar roster counts). Same site only, unless you tick <strong>Look across
            sites</strong>: then one of yours at another site they've said they'd go to. It's always one for one, so nobody's shifts in the fortnight
            go down. The officers approve every swap: both sites' for a swap across sites.
          </p>
          {marketShown.length === 0 && <p className="muted">Nothing up for swap that you could do.</p>}
          <ul className="rows">
            {marketShown.map((m) => {
              const l = listings.find((x) => x.listing_id === m.listing_id);
              const n = l && notices.get(l.notice_id);
              if (!l || !n) return null;
              const already = myOffers.find((o) => o.listing_id === l.listing_id && o.status === 'pending');
              return (
                <MarketRow
                  key={m.listing_id}
                  listing={l}
                  notice={n}
                  row={m}
                  already={already}
                  lister={name(l.doctor_id)}
                  notices={notices}
                  ShiftText={ShiftText}
                  style={siteStyle(hues, n.site_id)}
                  busy={busy}
                  rpc={rpc}
                />
              );
            })}
          </ul>
        </div>
      )}

      {me && (
        <MyShifts
          shifts={myShifts}
          swapsFor={swapsFor}
          otherSites={otherSites}
          setOtherSites={setOtherSites}
          today={today}
          offers={offers}
          name={name}
          notices={notices}
          ShiftText={ShiftText}
          hues={hues}
          listing={listing}
          setListing={setListing}
          busy={busy}
          rpc={rpc}
        />
      )}

      {me && myOffers.length > 0 && (
        <div className="card">
          <h2>My offers</h2>
          <ul className="rows">
            {myOffers.map((o) => {
              const l = listings.find((x) => x.listing_id === o.listing_id);
              const n = l && notices.get(l.notice_id);
              return (
                <li key={o.offer_id} className="row">
                  <span>
                    <ShiftText notice={n} />
                    {o.offered_notice_id && <> for your <ShiftText notice={notices.get(o.offered_notice_id)} /></>}
                    <span className={`badge ${o.status === 'approved' ? 'open' : o.status === 'pending' ? 'applied' : ''}`}>
                      {{ pending: 'Waiting for an officer', approved: 'Approved', declined: 'Not approved', withdrawn: 'Withdrawn', cancelled: 'Closed' }[o.status]}
                    </span>
                    {o.decline_reason && <span className="small muted"> {o.decline_reason}</span>}
                  </span>
                  {o.status === 'pending' && (
                    <button
                      className="link"
                      disabled={busy}
                      onClick={() => window.confirm('Withdraw your offer?') && rpc('withdraw_swap_offer', { p_offer_id: o.offer_id }, 'Withdrawn.')}
                    >
                      Withdraw
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// My shifts: every shift I work, as a list or a calendar (tap a day for
// its shifts). Each can be listed for swap or withdrawn.
function MyShifts({ shifts, swapsFor, otherSites, setOtherSites, today, offers, name, notices, ShiftText, hues, listing, setListing, busy, rpc }) {
  const [view, setView] = useState(savedView);
  const [day, setDay] = useState(null);
  const choose = (v) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Not remembered; fine.
    }
  };
  const row = (item) => (
    <MyShiftRow
      key={item.key}
      item={item}
      swaps={swapsFor(item.key)}
      otherSites={otherSites}
      setOtherSites={setOtherSites}
      offers={offers}
      name={name}
      notices={notices}
      ShiftText={ShiftText}
      style={siteStyle(hues, item.shift.site_id)}
      listing={listing}
      setListing={setListing}
      busy={busy}
      rpc={rpc}
      allShifts={shifts}
    />
  );

  return (
    <div className="card">
      <div className="card-head">
        <h2>My shifts</h2>
        <div className="view-switch" role="group" aria-label="Show my shifts as">
          {['list', 'calendar'].map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => choose(v)}>
              {v === 'list' ? 'List' : 'Calendar'}
            </button>
          ))}
        </div>
      </div>
      <p className="small muted">
        Every shift you work: DR Roster shifts you've been approved for and, if you're on Rstar, your roster there. List
        one for swap if you can't do it; you still work it unless a swap is approved.
      </p>
      {shifts.length === 0 && <p className="muted">No upcoming shifts.</p>}
      {view === 'list' ? (
        <ul className="rows">{shifts.map(row)}</ul>
      ) : (
        shifts.length > 0 && (
          <>
            <ShiftCalendar shifts={shifts} today={today} hues={hues} day={day} setDay={setDay} />
            {day && (
              <>
                <h3 className="day-heading">{dayLabel(day)}</h3>
                {shifts.some((i) => i.shift.shift_date === day) ? (
                  <ul className="rows">{shifts.filter((i) => i.shift.shift_date === day).map(row)}</ul>
                ) : (
                  <p className="muted">No shifts this day.</p>
                )}
              </>
            )}
          </>
        )
      )}
    </div>
  );
}

// Four weeks at a time from this Monday, moved with the arrows or a
// swipe, as far as the last shift. Each day has a bar per shift in its
// site's colour (striped amber when it's up for swap).
const CAL_WEEKS = 4;
function ShiftCalendar({ shifts, today, hues, day, setDay }) {
  const [page, setPage] = useState(0);
  const touchX = useRef(null);
  const monday = addDays(today, -((new Date(`${today}T00:00:00`).getDay() + 6) % 7));
  const last = shifts[shifts.length - 1].shift.shift_date;
  const totalWeeks = Math.floor((new Date(`${last}T00:00:00`) - new Date(`${monday}T00:00:00`)) / (7 * 86400000)) + 1;
  const lastPage = Math.max(0, Math.ceil(totalWeeks / CAL_WEEKS) - 1);
  const shown = Math.min(page, lastPage);
  const first = addDays(monday, shown * CAL_WEEKS * 7);
  const days = Array.from({ length: CAL_WEEKS * 7 }, (_, i) => addDays(first, i));
  const go = (n) => setPage(Math.max(0, Math.min(lastPage, shown + n)));
  const range = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });

  return (
    <div
      onTouchStart={(e) => { touchX.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => {
        const dx = e.changedTouches[0].clientX - (touchX.current ?? e.changedTouches[0].clientX);
        if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
        touchX.current = null;
      }}
    >
      <div className="my-cal-nav">
        <button type="button" className="cal-nav" onClick={() => go(-1)} disabled={shown === 0} aria-label="Earlier weeks">
          <ChevronLeft size={20} />
        </button>
        <span className="small">{range(days[0])} – {range(days[days.length - 1])}</span>
        <button type="button" className="cal-nav" onClick={() => go(1)} disabled={shown === lastPage} aria-label="Later weeks">
          <ChevronRight size={20} />
        </button>
      </div>
      <div className="my-cal">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="my-cal-head">{d}</div>)}
        {days.map((d) => {
          const onDay = shifts.filter((i) => i.shift.shift_date === d);
          const date = new Date(`${d}T00:00:00`);
          const classes = ['my-cal-day', d < today && 'past', d === today && 'today', d === day && 'selected'].filter(Boolean).join(' ');
          return (
            <button
              key={d}
              type="button"
              className={classes}
              onClick={() => setDay(d === day ? null : d)}
              aria-label={`${dayLabel(d)}: ${onDay.length} shift${onDay.length === 1 ? '' : 's'}`}
            >
              <span>
                {date.getDate()}
                {(date.getDate() === 1 || d === days[0]) && (
                  <span className="my-cal-month"> {date.toLocaleDateString('en-AU', { month: 'short' })}</span>
                )}
              </span>
              {onDay.map((i) => (
                <span key={i.key} className={`my-cal-bar${i.listing ? ' swap' : ''}`} style={siteStyle(hues, i.shift.site_id)} />
              ))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// One of my shifts: up for swap (offers so far, withdraw), or list it.
function MyShiftRow({ item, swaps, otherSites, setOtherSites, offers, name, notices, ShiftText, style, listing, setListing, busy, rpc, allShifts }) {
  const [finding, setFinding] = useState(false);
  const l = item.listing;
  const pending = l ? offers.filter((o) => o.listing_id === l.listing_id && o.status === 'pending') : [];
  return (
    <li className="row column site-stripe" style={style}>
      <div>
        <ShiftText notice={item.shift} />
        {item.assignmentId && <span className="small muted"> (Rstar)</span>}
        {l && <span className="badge applied">Up for swap</span>}
      </div>
      {l ? (
        <>
          {l.available_slots.length > 0 && (
            <div className="small muted">
              You can work in return: {l.available_slots.map(slotLabel).join(', ')}
            </div>
          )}
          <div className="small">
            {pending.length === 0
              ? 'No offers yet.'
              : pending.map((o) => (
                <div key={o.offer_id}>
                  {name(o.doctor_id)}{' '}
                  {o.offered_notice_id ? <>offers their <ShiftText notice={notices.get(o.offered_notice_id)} /></> : 'will take it'}
                  {' '}(waiting for an officer)
                </div>
              ))}
          </div>
          <div>
            <button
              className="link"
              disabled={busy}
              onClick={() => window.confirm('Take this shift off the swap list?') && rpc('withdraw_swap_listing', { p_listing_id: l.listing_id }, 'Withdrawn.')}
            >
              Withdraw from swaps
            </button>
          </div>
        </>
      ) : listing === item.key ? (
        <ListForm
          date={item.shift.shift_date}
          blocked={blockedSlots(allShifts.map((i) => i.shift), item.shift, fortnightDays(item.shift.shift_date), toLocalDateStr(new Date()), dayLabel)}
          busy={busy}
          onCancel={() => setListing(null)}
          onSubmit={async (args) => {
            const ok = item.assignmentId
              ? await rpc('list_roster_shift_for_swap', { p_assignment_id: item.assignmentId, ...args }, 'Listed. Doctors who could do it will be told.')
              : await rpc('list_shift_for_swap', { p_notice_id: item.noticeId, ...args }, 'Listed. Doctors who could do it will be told.');
            if (ok) setListing(null);
          }}
        />
      ) : (
        <>
          <div className="inline">
            <button className="secondary" onClick={() => setFinding(!finding)}>
              Find a swap{swaps.length > 0 ? ` (${swaps.length})` : ''}
            </button>
            <button className="secondary" onClick={() => setListing(item.key)}>List for swap</button>
          </div>
          {finding && (
            <FoundSwaps
              item={item}
              swaps={swaps}
              otherSites={otherSites}
              setOtherSites={setOtherSites}
              name={name}
              notices={notices}
              ShiftText={ShiftText}
              busy={busy}
              rpc={rpc}
            />
          )}
        </>
      )}
    </li>
  );
}

// One listing on the marketplace: take it, or offer a shift in return.
function MarketRow({ listing: l, notice: n, row, already, lister, notices, ShiftText, style, busy, rpc }) {
  const [offered, setOffered] = useState(''); // 'n:<notice_id>' or 'a:<roster-app assignment_id>'
  const options = row.swap_options ?? [];
  const optionValue = (o) => (o.notice_id ? `n:${o.notice_id}` : `a:${o.assignment_id}`);
  const ask = (what) => window.prompt(`${what} Add a note for the officer if you like.`, '');
  return (
    <li className="row column site-stripe" style={style}>
      <div>
        <ShiftText notice={n} /> · from <strong>{lister}</strong>
        {l.note && <div className="small muted">"{l.note}"</div>}
        {l.available_slots.length > 0 && <div className="small muted">They can work in return: {l.available_slots.map(slotLabel).join(', ')}</div>}
      </div>
      {already ? (
        <div className="small">
          You've offered {already.offered_notice_id ? <>your <ShiftText notice={notices.get(already.offered_notice_id)} /></> : 'to take it'}, waiting for an
          officer (see My offers).
        </div>
      ) : (
        <div className="inline small">
          {options.length > 0 && (
            <>
              <select value={offered} onChange={(e) => setOffered(e.target.value)} aria-label="Your shift to swap">
                <option value="">Swap for one of mine…</option>
                {options.map((o) => (
                  <option key={optionValue(o)} value={optionValue(o)}>{o.label}</option>
                ))}
              </select>
              {offered && (
                <button
                  disabled={busy}
                  onClick={() => {
                    const note = ask(`Offer this shift to ${lister} in return?`);
                    const [kind, id] = offered.split(':');
                    if (note !== null) {
                      rpc('offer_for_swap', {
                        p_listing_id: l.listing_id,
                        p_offered_notice_id: kind === 'n' ? id : null,
                        p_offered_assignment_id: kind === 'a' ? id : null,
                        p_note: note,
                      }, 'Swap offered. An officer will approve or decline it.');
                    }
                  }}
                >
                  Offer swap
                </button>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

// A swap across sites, for the officers: which sites have approved.
function CrossSiteStatus({ offer: o, notice: n, offered, siteName }) {
  if (!offered || offered.site_id === n.site_id) return null;
  const sides = [
    [n.site_id, o.listing_site_approved_by],
    [offered.site_id, o.offered_site_approved_by],
  ];
  return (
    <div className="small muted">
      Across sites, so both approve:{' '}
      {sides.map(([siteId, by]) => `${siteName(siteId)} ${by ? 'approved' : 'waiting'}`).join(', ')}
    </div>
  );
}

// Find a swap: shifts already up for swap that this shift of mine can be
// traded for straight away (on one of their days, both passing the rules).
function FoundSwaps({ item, swaps, otherSites, setOtherSites, name, notices, ShiftText, busy, rpc }) {
  const scope = <SiteScope otherSites={otherSites} setOtherSites={setOtherSites} />;
  if (swaps.length === 0) {
    return (
      <div className="stack small">
        {scope}
        <p className="muted">
          Nothing up for swap fits this shift yet{otherSites ? '' : ' at this site'}. List it for swap, and doctors who could
          swap with you will be told.
        </p>
      </div>
    );
  }
  return (
    <div className="stack small">
      {scope}
      <div>Up for swap now, and you could give this shift in return:</div>
      <ul className="rows">
        {swaps.map((l) => (
          <li key={l.listing_id} className="row">
            <span>
              {name(l.doctor_id)}'s <ShiftText notice={notices.get(l.notice_id)} />
              {l.note && <span className="muted"> "{l.note}"</span>}
            </span>
            <button
              disabled={busy}
              onClick={() => {
                const note = window.prompt(`Offer this shift to ${name(l.doctor_id)} for theirs? Add a note for the officer if you like.`, '');
                if (note !== null) {
                  rpc('offer_for_swap', {
                    p_listing_id: l.listing_id,
                    p_offered_notice_id: item.noticeId ?? null,
                    p_offered_assignment_id: item.assignmentId ?? null,
                    p_note: note,
                  }, 'Swap offered. An officer will approve or decline it.');
                }
              }}
            >
              Offer swap
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Listing a shift: the days/nights of its pay
// fortnight you could work in return (at least one: a swap never changes
// anyone's number of shifts).
function ListForm({ date, blocked, busy, onCancel, onSubmit }) {
  const [slots, setSlots] = useState([]);
  const [note, setNote] = useState('');
  const [otherSites, setOtherSites] = useState(false);
  const days = fortnightDays(date);
  const toggle = (slot) => setSlots((s) => (s.includes(slot) ? s.filter((x) => x !== slot) : [...s, slot]));

  return (
    <form
      className="stack small"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ p_service_disruption: false, p_slots: slots.sort(), p_note: note, p_other_sites: otherSites });
      }}
    >
      <div>
        <div>
          Days or nights you could work in return (this pay fortnight): tick at least one. Whoever takes your shift gives you one of
          theirs on one of them, so neither of you ends up with fewer shifts. Greyed out: you're working then, or too close to
          another shift for 10 hours' rest. To swap a day for a night (or back) on the same date, tick the other one that day.
        </div>
        <div className="slot-grid">
          <span />
          <span className="muted">Day</span>
          <span className="muted">Night</span>
          {days.map((d) => (
            <SlotRow key={d} date={d} slots={slots} toggle={toggle} isShift={d === date} blocked={blocked} />
          ))}
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={otherSites} onChange={(e) => setOtherSites(e.target.checked)} />
        I'd take a shift in return at another site I'd work at (not just this one)
      </label>
      <label>
        Note (optional)
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Family wedding" />
      </label>
      <div className="inline">
        <button type="submit" disabled={busy || slots.length === 0}>List for swap</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function SlotRow({ date, slots, toggle, isShift, blocked }) {
  return (
    <>
      <span className={isShift ? 'slot-shift' : ''}>{dayLabel(date)}{isShift && ' (this shift)'}</span>
      {['day', 'night'].map((kind) => {
        const slot = `${date}:${kind}`;
        return (
          <input
            key={kind}
            type="checkbox"
            checked={slots.includes(slot)}
            disabled={blocked.has(slot)}
            title={blocked.get(slot)}
            onChange={() => toggle(slot)}
            aria-label={`${dayLabel(date)} ${kind}${blocked.has(slot) ? `: ${blocked.get(slot)}` : ''}`}
          />
        );
      })}
    </>
  );
}
