import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { formatShiftTime, toLocalDateStr } from './dateUtils';
import { siteHues, siteStyle } from './siteColours';

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

const dayLabel = (dateStr) =>
  new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
// "2026-11-03:night" -> "Tue 3 Nov night"
const slotLabel = (slot) => {
  const [date, kind] = slot.split(':');
  return `${dayLabel(date)} ${kind}`;
};

export default function Swaps({ districtId, sites, me, officerSiteIds }) {
  const [mine, setMine] = useState([]); // shifts I'm booked on, from today
  const [listings, setListings] = useState([]);
  const [offers, setOffers] = useState([]);
  const [market, setMarket] = useState([]);
  const [notices, setNotices] = useState(new Map());
  const [doctors, setDoctors] = useState(new Map());
  const [listing, setListing] = useState(null); // the shift being listed
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const today = toLocalDateStr(new Date());
  const hues = siteHues(sites);

  const load = useCallback(async () => {
    const [mineRes, listingsRes, offersRes, marketRes, doctorsRes] = await Promise.all([
      me
        ? supabase.from('district_notices').select('*').eq('filled_by_doctor_id', me.doctor_id).eq('status', 'filled')
          .gte('shift_date', today).order('shift_date').order('start_time')
        : { data: [] },
      supabase.from('district_swap_listings').select('*').eq('district_id', districtId).order('created_at', { ascending: false }).limit(300),
      supabase.from('district_swap_offers').select('*').order('created_at', { ascending: false }).limit(300),
      me ? supabase.rpc('my_swap_market', { p_district_id: districtId }) : { data: [] },
      supabase.from('district_doctors').select('doctor_id, name').eq('district_id', districtId),
    ]);
    const firstError = [mineRes, listingsRes, offersRes, marketRes].find((r) => r.error)?.error;
    if (firstError) setError(firstError.message);
    const ls = listingsRes.data ?? [];
    const os = offersRes.data ?? [];
    setMine(mineRes.data ?? []);
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
  }, [districtId, me, today]);

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
  const name = (doctorId) => doctors.get(doctorId) ?? 'A doctor';
  const ShiftText = ({ notice }) =>
    notice ? (
      <span>
        <strong className="site-name">{siteName(notice.site_id)}</strong> {dayLabel(notice.shift_date)} · {notice.title && `${notice.title} `}
        {formatShiftTime(notice.start_time, notice.end_time)}
      </span>
    ) : (
      <span className="muted">A shift</span>
    );

  const openListing = (noticeId) => listings.find((l) => l.notice_id === noticeId && l.status === 'open');
  const myOffers = me ? offers.filter((o) => o.doctor_id === me.doctor_id) : [];
  const marketShown = market.filter((m) => !m.problem || m.swap_options?.length);
  // Roster-app shifts appear only once listed (from roster-app).
  const myShifts = mine.filter((n) => n.source !== 'roster_shift' || openListing(n.notice_id));
  const officerListings = listings.filter((l) => {
    const n = notices.get(l.notice_id);
    return l.status === 'open' && n && officerSiteIds.has(n.site_id);
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
              const pending = offers.filter((o) => o.listing_id === l.listing_id && o.status === 'pending');
              return (
                <li key={l.listing_id} className="row column site-stripe" style={siteStyle(hues, n.site_id)}>
                  <div>
                    <ShiftText notice={n} /> · listed by <strong>{name(l.doctor_id)}</strong>
                    {l.service_disruption && <span className="badge danger-badge">Service disruption</span>}
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
                        </span>
                        <span className="inline">
                          <button disabled={busy} onClick={() => rpc('approve_swap_offer', { p_offer_id: o.offer_id }, 'Swap approved. Both doctors have been told.')}>
                            Approve
                          </button>
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
                  <div>
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
          <h2>Up for swap</h2>
          <p className="small muted">
            Shifts other doctors want to give up that you could do. Take one outright, or swap one of your own shifts at the
            same site for it, on a day they can work. An officer approves every swap.
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
        <div className="card">
          <h2>My shifts</h2>
          <p className="small muted">
            Your booked DR Roster shifts. List one for swap if you can't do it; you still work it unless a swap is approved.
            To list a roster-app shift, use Variation → Swap a shift in roster-app.
          </p>
          {myShifts.length === 0 && <p className="muted">You're not booked on any district shifts.</p>}
          <ul className="rows">
            {myShifts.map((n) => {
              const l = openListing(n.notice_id);
              const pending = l ? offers.filter((o) => o.listing_id === l.listing_id && o.status === 'pending') : [];
              return (
                <li key={n.notice_id} className="row column site-stripe" style={siteStyle(hues, n.site_id)}>
                  <div>
                    <ShiftText notice={n} />
                    {n.source === 'roster_shift' && <span className="small muted"> (roster-app shift)</span>}
                    {l && <span className="badge applied">Up for swap</span>}
                    {l?.service_disruption && <span className="badge danger-badge">Service disruption</span>}
                  </div>
                  {l ? (
                    <>
                      {l.available_slots.length > 0 && (
                        <div className="small muted">You can work in return: {l.available_slots.map(slotLabel).join(', ')}</div>
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
                  ) : listing === n.notice_id ? (
                    <ListForm
                      notice={n}
                      busy={busy}
                      onCancel={() => setListing(null)}
                      onSubmit={async (args) => {
                        if (await rpc('list_shift_for_swap', { p_notice_id: n.notice_id, ...args }, 'Listed. Doctors who could do it, and the site\'s officers, will be told.')) setListing(null);
                      }}
                    />
                  ) : (
                    <div>
                      <button className="secondary" onClick={() => setListing(n.notice_id)}>List for swap</button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
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
        {l.service_disruption && <span className="badge danger-badge">Service disruption</span>}
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
          {row.problem ? (
            <span className="muted">You can't take it outright: {row.problem}.</span>
          ) : (
            <button
              disabled={busy}
              onClick={() => {
                const note = ask(`Take ${lister}'s shift?`);
                if (note !== null) rpc('offer_for_swap', { p_listing_id: l.listing_id, p_offered_notice_id: null, p_offered_assignment_id: null, p_note: note }, 'Offer sent. An officer will approve or decline it.');
              }}
            >
              Take it
            </button>
          )}
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

// Listing a shift: service disruption, and the days/nights of its pay
// fortnight you could work in return (none: they can only take it).
function ListForm({ notice, busy, onCancel, onSubmit }) {
  const [disruption, setDisruption] = useState(false);
  const [slots, setSlots] = useState([]);
  const [note, setNote] = useState('');
  const days = fortnightDays(notice.shift_date);
  const toggle = (slot) => setSlots((s) => (s.includes(slot) ? s.filter((x) => x !== slot) : [...s, slot]));

  return (
    <form
      className="stack small"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ p_service_disruption: disruption, p_slots: slots.sort(), p_note: note });
      }}
    >
      <label className="check">
        <input type="checkbox" checked={disruption} onChange={(e) => setDisruption(e.target.checked)} />
        Service disruption: if nobody takes it, the shift goes uncovered
      </label>
      <div>
        <div>Days or nights you could work in return (this pay fortnight). Leave them all clear if you only want someone to take it.</div>
        <div className="slot-grid">
          <span />
          <span className="muted">Day</span>
          <span className="muted">Night</span>
          {days.map((d) => (
            <SlotRow key={d} date={d} slots={slots} toggle={toggle} isShift={d === notice.shift_date} />
          ))}
        </div>
      </div>
      <label>
        Note (optional)
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Family wedding" />
      </label>
      <div className="inline">
        <button type="submit" disabled={busy}>List for swap</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function SlotRow({ date, slots, toggle, isShift }) {
  return (
    <>
      <span className={isShift ? 'slot-shift' : ''}>{dayLabel(date)}{isShift && ' (this shift)'}</span>
      {['day', 'night'].map((kind) => {
        const slot = `${date}:${kind}`;
        return (
          <input key={kind} type="checkbox" checked={slots.includes(slot)} onChange={() => toggle(slot)} aria-label={`${dayLabel(date)} ${kind}`} />
        );
      })}
    </>
  );
}
