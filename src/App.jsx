import { useEffect, useState } from 'react';
import { supabase, arrivedToSetPassword } from './supabase';
import SignIn from './SignIn';
import SetPassword from './SetPassword';
import Profile from './Profile';
import Doctors from './Doctors';
import Sites from './Sites';
import Admin from './Admin';

export default function App() {
  const [session, setSession] = useState(undefined);
  const [needsPassword, setNeedsPassword] = useState(arrivedToSetPassword);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'PASSWORD_RECOVERY') setNeedsPassword(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) return <p className="page">Loading…</p>;
  if (!session) return <SignIn />;
  if (needsPassword) return <SetPassword onDone={() => setNeedsPassword(false)} />;
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
      setSites(sitesRes.data ?? []);
    })();
  }, [districtId, user.id, reloadKey]);

  const tabs = [
    me && ['profile', 'My profile'],
    isOfficer && ['doctors', 'Doctors'],
    districtId && ['sites', 'Sites'],
    isSuperAdmin && ['admin', 'Admin'],
  ].filter(Boolean);
  const activeTab = tabs.some(([k]) => k === tab) ? tab : tabs[0]?.[0];
  const district = districts.find((d) => d.district_id === districtId);

  return (
    <div className="page">
      <header className="topbar">
        <h1>District Roster</h1>
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

      {!loading && tabs.length === 0 && (
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

      {activeTab === 'profile' && me && <Profile doctor={me} sites={sites} onSaved={reload} />}
      {activeTab === 'doctors' && <Doctors districtId={districtId} sites={sites} />}
      {activeTab === 'sites' && <Sites districtId={districtId} sites={sites} />}
      {activeTab === 'admin' && <Admin districts={districts} onChanged={reload} />}
    </div>
  );
}
