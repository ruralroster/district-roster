import { useEffect, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { supabase } from './supabase';

// Phone notifications for this device (each phone or browser turns them
// on itself), and a test. Same approach as roster-app's
// NotificationSettings.jsx; the subscriptions are DR Roster's own
// (district_push_subscriptions) so taps open DR Roster.

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

// The VAPID public key is base64url; pushManager.subscribe wants bytes.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const raw = window.atob((base64String + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((ch) => ch.charCodeAt(0)));
}

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

export default function Notifications({ userId, intro }) {
  // 'checking' | 'unsupported' | 'ios-install' | 'not-configured' | 'no-worker' | 'off' | 'on' | 'blocked'
  const [state, setState] = useState('checking');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let next;
      const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
      if (!supported) next = isIos() ? 'ios-install' : 'unsupported';
      else if (!VAPID_PUBLIC_KEY) next = 'not-configured';
      else if (Notification.permission === 'denied') next = 'blocked';
      else {
        // Only registered in the published app (main.jsx).
        const registration = await navigator.serviceWorker.getRegistration();
        if (!registration) next = 'no-worker';
        else {
          const subscription = await registration.pushManager.getSubscription();
          const { data } = subscription
            ? await supabase.from('district_push_subscriptions').select('push_subscription_id').eq('endpoint', subscription.endpoint).maybeSingle()
            : { data: null };
          next = data && Notification.permission === 'granted' ? 'on' : 'off';
        }
      }
      if (!cancelled) setState(next);
    })().catch(() => !cancelled && setState('unsupported'));
    return () => {
      cancelled = true;
    };
  }, [userId]);

  async function turnOn() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'blocked' : 'off');
        return;
      }
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) {
        setState('no-worker');
        return;
      }
      const subscription =
        (await registration.pushManager.getSubscription()) ||
        (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) }));
      const { endpoint, keys } = subscription.toJSON();
      const { error: saveError } = await supabase
        .from('district_push_subscriptions')
        .upsert({ user_id: userId, endpoint, p256dh: keys.p256dh, auth: keys.auth, user_agent: navigator.userAgent }, { onConflict: 'user_id,endpoint' });
      if (saveError) throw saveError;
      setState('on');
      setMessage('Phone notifications are on for this device.');
    } catch (err) {
      setError(`Couldn't turn on notifications: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = registration && (await registration.pushManager.getSubscription());
      if (subscription) {
        const { error: deleteError } = await supabase.from('district_push_subscriptions').delete().eq('endpoint', subscription.endpoint);
        if (deleteError) throw deleteError;
      }
      setState('off');
      setMessage('Phone notifications are off for this device.');
    } catch (err) {
      setError(`Couldn't turn off notifications: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setError('');
    setMessage('');
    const { data, error: testError } = await supabase.functions.invoke('district-notify', { body: { test: true } });
    setBusy(false);
    if (testError) {
      setError(`Test failed: ${testError.message}`);
      return;
    }
    const parts = [];
    if (data?.data?.emailed) parts.push('an email');
    if (data?.data?.pushed) parts.push(`${data.data.pushed} phone notification${data.data.pushed === 1 ? '' : 's'}`);
    setMessage(parts.length ? `Sent ${parts.join(' and ')}.` : 'Nothing could be sent.');
  }

  const help = {
    'ios-install': 'On iPhone, phone notifications only work once DR Roster is on your Home Screen: tap Share → Add to Home Screen, then open it from there and come back here.',
    unsupported: "This browser can't show phone notifications.",
    'not-configured': "Phone notifications aren't set up for this app yet.",
    'no-worker': 'Phone notifications only work in the published app.',
    blocked: 'Notifications are blocked for this site. Allow them in your browser or phone settings, then reload.',
  }[state];

  return (
    <div className="card stack">
      <h2>Notifications on this device</h2>
      {intro && <p className="small muted">{intro}</p>}
      <div className="inline">
        {state === 'off' && (
          <button onClick={turnOn} disabled={busy}>
            <Bell size={16} /> Turn on phone notifications
          </button>
        )}
        {state === 'on' && (
          <>
            <span className="ok inline"><Bell size={16} /> On for this device</span>
            <button className="secondary" onClick={turnOff} disabled={busy}>
              <BellOff size={14} /> Turn off
            </button>
          </>
        )}
        <button className="secondary" onClick={sendTest} disabled={busy}>Send me a test</button>
      </div>
      {help && <p className="small muted">{help}</p>}
      {message && <p className="ok">{message}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
