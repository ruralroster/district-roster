import { useEffect, useState } from 'react';
import { supabase, arrivedToSetPassword } from './supabase';
import SignIn from './SignIn';
import SetPassword from './SetPassword';
import Profile from './Profile';
import Doctors from './Doctors';
import Sites from './Sites';
import Help from './Help';
import Swaps from './Swaps';
import DigestSettings from './DigestSettings';
import Admin from './Admin';
import Notifications from './Notifications';
import Calendar from './Calendar';
import { needsTwoFactor, TwoFactorChallenge, TwoFactorSettings } from './TwoFactor';

export default function App() {
  const [session, setSession] = useState(undefined);
  const [needsPassword, setNeedsPassword] = useState(arrivedToSetPassword);
  // null while checking; true until the 2FA code is entered.
  const [needsCode, setNeedsCode] = useState(null);
  const userId = session?.user?.id;

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'PASSWORD_RECOVERY') setNeedsPassword(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // A one-time password from an officer (here or in Rstar) also lands on
  // Choose a password, before anything else.
  useEffect(() => {
    setNeedsCode(null);
    if (!userId) return;
    Promise.all([needsTwoFactor(), supabase.rpc('my_must_reset_password')]).then(([code, reset]) => {
      if (reset.data) setNeedsPassword(true);
      setNeedsCode(code);
    });
  }, [userId]);

  async function passwordChosen() {
    await supabase.rpc('clear_my_must_reset_password');
    setNeedsPassword(false);
  }

  if (session === undefined) return <p className="page">Loading…</p>;
  if (!session) return <SignIn />;
  if (needsCode === null) return <p className="page">Loading…</p>;
  if (needsPassword) return <SetPassword onDone={passwordChosen} />;
  if (needsCode) return <TwoFactorChallenge onVerified={() => setNeedsCode(false)} />;
  return <Home user={session.user} />;
}

function Home({ user }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [districts, setDistricts] = useState([]);
  const [districtId, setDistrictId] = useState(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [isOfficer, setIsOfficer] = useState(false);
  const [me, setMe] = useState(null);
  const [sites, setSites] = useState([]);
  const [officerSiteIds, setOfficerSiteIds] = useState(new Set());
  const [tab, setTab] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    (async () => {
      const [dRes, saRes] = await Promise.all([
        supabase.from('districts').select('*').order('name'),
        supabase.rpc('is_super_admin'),
      ]);
      if (dRes.error) setError(dRes.error.message);
      const list = dRes.data ?? [];
      setDistricts(list);
      setIsSuperAdmin(!!saRes.data);
      setDistrictId((cur) => (list.some((d) => d.district_id === cur) ? cur : list[0]?.district_id ?? null));
      setLoading(false);
    })();
  }, [reloadKey]);

  useEffect(() => {
    if (!districtId) {
      setMe(null);
      setIsOfficer(false);
      setSites([]);
      setOfficerSiteIds(new Set());
      return;
    }
    (async () => {
      const [meRes, offRes, sitesRes] = await Promise.all([
        supabase.from('district_doctors').select('*').eq('district_id', districtId).eq('user_id', user.id).maybeSingle(),
        supabase.rpc('is_district_officer', { p_district_id: districtId }),
        supabase.from('sites').select('*').eq('district_id', districtId).order('name'),
      ]);
      setMe(meRes.data ?? null);
      setIsOfficer(!!offRes.data);
      const siteList = sitesRes.data ?? [];
      setSites(siteList);
      const checks = await Promise.all(siteList.map((st) => supabase.rpc('is_site_officer', { p_site_id: st.site_id })));
      setOfficerSiteIds(new Set(siteList.filter((_, i) => checks[i].data).map((st) => st.site_id)));
    })();
  }, [districtId, user.id, reloadKey]);

  const tabs = [
    (me || officerSiteIds.size > 0) && ['calendar', 'Calendar'],
    (me || officerSiteIds.size > 0) && ['swaps', 'Swaps'],
    (me || officerSiteIds.size > 0 || isSuperAdmin) && ['profile', me ? 'My profile' : 'My account'],
    isOfficer && ['doctors', 'Doctors'],
    officerSiteIds.size > 0 && ['sites', 'Sites'],
    isSuperAdmin && ['admin', 'Admin'],
    ['help', 'Help'],
  ].filter(Boolean);
  const activeTab = tabs.some(([k]) => k === tab) ? tab : tabs[0]?.[0];

  // The first time a doctor opens DR App: they start out seeing every
  // site's shifts, and are pointed at My profile to narrow that down.
  async function sitesIntroDone(chooseSites) {
    setMe((m) => ({ ...m, sites_intro_seen: true }));
    await supabase.from('district_doctors').update({ sites_intro_seen: true }).eq('doctor_id', me.doctor_id);
    if (chooseSites) {
      setTab('profile');
      setTimeout(() => document.getElementById('sites-i-work-at')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    }
  }
  const district = districts.find((d) => d.district_id === districtId);

  return (
    <div className="page">
      <header className="topbar">
        <h1>DR App</h1>
        <div className="topbar-right">
          {districts.length > 1 && (
            <select value={districtId ?? ''} onChange={(e) => setDistrictId(e.target.value)}>
              {districts.map((d) => (
                <option key={d.district_id} value={d.district_id}>{d.name}</option>
              ))}
            </select>
          )}
          {districts.length === 1 && <span className="muted">{district?.name}</span>}
          <button className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}
      {loading && <p>Loading…</p>}

      {me?.active && me.sites_intro_seen === false && sites.length > 0 && (
        <div className="dialog-backdrop">
          <div className="dialog card stack" role="dialog" aria-modal="true" aria-labelledby="sites-intro-title">
            {me.interested_site_ids?.length >= sites.length ? (
              <>
                <h2 id="sites-intro-title">Every site's shifts, in one place</h2>
                <p>
                  You can see all the empty shifts at every site in {district?.name ?? 'the district'} that fit your level and
                  skills, and you'll be told about new ones.
                </p>
                <p>
                  To see only the sites you're happy to work at, go to <strong>My profile</strong> and choose them under{' '}
                  <strong>Sites I'd work at</strong>. You can change it at any time.
                </p>
              </>
            ) : (
              <>
                <h2 id="sites-intro-title">Work at other sites</h2>
                <p>
                  You're seeing empty shifts at{' '}
                  {sites.filter((st) => me.interested_site_ids?.includes(st.site_id)).map((st) => st.name).join(', ') || 'no sites yet'}{' '}
                  that fit your level and skills, and you'll be told about new ones.
                </p>
                <p>
                  There's work at {sites.length} sites in {district?.name ?? 'the district'}. To see shifts at the others you're
                  happy to work at, go to <strong>My profile</strong> and tick them under <strong>Sites I'd work at</strong>.
                </p>
              </>
            )}
            <div className="inline">
              <button onClick={() => sitesIntroDone(true)}>Choose my sites</button>
              <button className="secondary" onClick={() => sitesIntroDone(false)}>
                {me.interested_site_ids?.length >= sites.length ? 'Keep every site' : 'Not now'}
              </button>
            </div>
          </div>
        </div>
      )}

      {!loading && tabs.length === 1 && (
        <p className="card">
          You're signed in as {user.email}, but you're not in a district yet. Ask your rostering officer to
          invite you.
        </p>
      )}

      {tabs.length > 0 && (
        <nav className="tabs">
          {tabs.map(([key, label]) => (
            <button key={key} className={key === activeTab ? 'tab active' : 'tab'} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </nav>
      )}

      {activeTab === 'calendar' && <Calendar districtId={districtId} sites={sites} me={me} officerSiteIds={officerSiteIds} />}
      {activeTab === 'profile' && (
        <div className="stack">
          {me && <Profile doctor={me} sites={sites} onSaved={reload} />}
          <Notifications
            userId={user.id}
            intro={[
              me && "You're told about new shifts your skills fit, and when you're booked or not. Choose email and/or phone above.",
              officerSiteIds.size > 0 && "As an officer, you're emailed and sent a phone notification when someone applies for or withdraws from your sites' shifts, when a swap needs approving, and when a shift is still open with under 72 hours to go.",
            ].filter(Boolean).join(' ')}
          />
          {officerSiteIds.size > 0 && <DigestSettings userId={user.id} />}
          <TwoFactorSettings />
        </div>
      )}
      {activeTab === 'doctors' && <Doctors districtId={districtId} sites={sites} />}
      {activeTab === 'sites' && <Sites districtId={districtId} sites={sites} officerSiteIds={officerSiteIds} onChanged={reload} />}
      {activeTab === 'admin' && <Admin districts={districts} onChanged={reload} />}
      {activeTab === 'swaps' && <Swaps districtId={districtId} sites={sites} me={me} officerSiteIds={officerSiteIds} />}
      {activeTab === 'help' && <Help isDoctor={!!me} isOfficer={officerSiteIds.size > 0} isSuperAdmin={isSuperAdmin} />}
    </div>
  );
}
