// district-notify: DR Roster's emails and phone notifications.
//
// Run every 30 minutes (6:00-21:00 Brisbane) by pg_cron with the
// x-cron-secret header (see migrations/2026-10-27b_notify_rules.sql). Each
// run sends whatever's waiting, one email and one push per person; a run
// with nothing new sends nothing:
//   - new open shifts, to doctors who'd work at that site, whose skills
//     fit, who aren't marked unavailable and are rested (10 hours either
//     side; the rules are in SQL: district_notice_recipients)
//   - applications and withdrawals, to the site's officers (its
//     site_officers, plus roster-app officers of a linked department)
//   - approved / declined / booking cancelled, to the doctor
// Each item is marked sent before sending, so a run that fails part-way
// never repeats itself. Doctors who've never logged in (imported, not yet
// invited) get nothing. Doctors' Email / Phone notifications settings are
// honoured; officers get both.
//
// Also: POST { test: true } with a signed-in user's token sends them a test.
//
// Single file so it can be pasted into the Supabase web editor. Deploy with
// Verify JWT off. Uses the project's GMAIL_USER, GMAIL_APP_PASSWORD,
// VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY secrets (shared with roster-app).

// @ts-nocheck
import { createClient } from 'jsr:@supabase/supabase-js@2';
import nodemailer from 'npm:nodemailer@6.9.16';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GMAIL_USER = Deno.env.get('GMAIL_USER');
const GMAIL_APP_PASSWORD = Deno.env.get('GMAIL_APP_PASSWORD');
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY');
const APP_URL = (Deno.env.get('DR_APP_URL') || 'https://ruralroster.github.io/district-roster/').replace(/\/?$/, '/');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Today in Brisbane (UTC+10, no daylight saving), "2026-10-27".
const brisbaneToday = () => new Date(Date.now() + 10 * 3600 * 1000).toISOString().slice(0, 10);

// "Mon 3 Nov"
const dayLabel = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

function times(n) {
  const s = n.start_time.slice(0, 5);
  const e = n.end_time.slice(0, 5);
  return `${s}–${e}${e === s ? ' (24h)' : e < s ? ' (+1)' : ''}`;
}

// "Mon 3 Nov · Yarrabah · Emergency (Plus On-call) 08:00–08:00 (24h)"
// "Registrar"/"RMO"/"Intern" unless the title already says so (escalated shifts'
// titles do); consultant is the default and goes unsaid.
const LEVEL = { registrar: 'Registrar', rmo: 'RMO', intern: 'Intern' };
const levelText = (n) => (LEVEL[n.position] && !(n.title ?? '').includes(LEVEL[n.position]) ? `${LEVEL[n.position]} ` : '');
const shiftLine = (n) => `${dayLabel(n.shift_date)} · ${n.sites?.name ?? ''} · ${levelText(n)}${n.title ? `${n.title} ` : ''}${times(n)}`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

let transporter;
async function sendEmail(to: string, subject: string, intro: string, lines: string[]) {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !to) return false;
  transporter ??= nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  const html = `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #1c2730;">
<p>${escapeHtml(intro)}</p>
<ul>${lines.map((l) => `<li style="margin-bottom: 4px;">${escapeHtml(l)}</li>`).join('')}</ul>
<p><a href="${APP_URL}" style="color: #1f5f8b;">Open DR Roster</a></p>
<p style="color: #5f6d78; font-size: 12px;">You can change which emails you get in DR Roster, under My profile.</p>
</div>`;
  const text = [intro, '', ...lines.map((l) => `- ${l}`), '', `Open DR Roster: ${APP_URL}`].join('\n');
  try {
    await transporter.sendMail({ from: `"DR Roster" <${GMAIL_USER}>`, to, subject, text, html });
    return true;
  } catch (err) {
    console.error(`Email to ${to} failed:`, err);
    return false;
  }
}

// Every device the user turned notifications on for. Returns how many got it.
async function sendPush(admin, userId: string, title: string, body: string, tag: string) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !userId) return 0;
  webpush.setVapidDetails(`mailto:${GMAIL_USER || 'ruralroster@gmail.com'}`, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  const { data: subs } = await admin
    .from('district_push_subscriptions')
    .select('push_subscription_id, endpoint, p256dh, auth')
    .eq('user_id', userId);
  const payload = JSON.stringify({ title, body, url: APP_URL, tag });
  let sent = 0;
  for (const sub of subs ?? []) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
      sent++;
    } catch (err) {
      const status = err?.statusCode;
      if (status === 404 || status === 410) {
        await admin.from('district_push_subscriptions').delete().eq('push_subscription_id', sub.push_subscription_id);
      } else {
        console.error('Push failed:', err);
      }
    }
  }
  return sent;
}

// Email and/or push one person a list of lines.
async function tell(admin, person, { subject, intro, lines, pushTitle, tag }) {
  if (person.email && person.wantsEmail !== false) await sendEmail(person.email, subject, intro, lines);
  if (person.userId && person.wantsPush !== false) {
    const body = lines.length > 3 ? `${lines.slice(0, 3).join('\n')}\n…and ${lines.length - 3} more` : lines.join('\n');
    await sendPush(admin, person.userId, pushTitle, body, tag);
  }
}

// ---------------------------------------------------------------------------

async function newShifts(admin) {
  const { data: claimed, error } = await admin
    .from('district_notices')
    .update({ notified_at: new Date().toISOString() })
    .is('notified_at', null)
    .select('*, sites(name)');
  if (error) throw error;
  const today = brisbaneToday();
  const notices = (claimed ?? [])
    .filter((n) => n.status === 'open' && n.shift_date >= today)
    .sort((a, b) => a.shift_date.localeCompare(b.shift_date) || a.start_time.localeCompare(b.start_time));
  if (!notices.length) return 0;

  const { data: pairs, error: pairsError } = await admin.rpc('district_notice_recipients', {
    p_notice_ids: notices.map((n) => n.notice_id),
  });
  if (pairsError) throw pairsError;
  const doctorIds = [...new Set((pairs ?? []).map((p) => p.doctor_id))];
  if (!doctorIds.length) return 0;
  const { data: doctors } = await admin
    .from('district_doctors')
    .select('doctor_id, user_id, email, name, notify_email, notify_push')
    .in('doctor_id', doctorIds);

  let told = 0;
  for (const d of doctors ?? []) {
    const mine = new Set(pairs.filter((p) => p.doctor_id === d.doctor_id).map((p) => p.notice_id));
    const fits = notices.filter((n) => mine.has(n.notice_id));
    if (!fits.length) continue;
    const lines = fits.map(shiftLine);
    const one = fits.length === 1;
    await tell(admin, { email: d.email, userId: d.user_id, wantsEmail: d.notify_email, wantsPush: d.notify_push }, {
      subject: one ? `New shift: ${fits[0].sites?.name} ${dayLabel(fits[0].shift_date)}` : `${plural(fits.length, 'new shift')} you can do`,
      intro: `Hi ${d.name.split(' ')[0]}, ${one ? 'a new shift has' : `${fits.length} new shifts have`} been posted that you can do:`,
      lines,
      pushTitle: one ? 'New shift you can do' : `${plural(fits.length, 'new shift')} you can do`,
      tag: 'new-shifts',
    });
    told++;
  }
  return told;
}

async function officerNews(admin) {
  const { data: claimed, error } = await admin
    .from('district_applications')
    .update({ officer_notified_at: new Date().toISOString() })
    .is('officer_notified_at', null)
    .in('status', ['pending', 'withdrawn'])
    .select('status, note, district_notices(site_id, shift_date, start_time, end_time, title, position, sites(name, department_id)), district_doctors(name)');
  if (error) throw error;
  if (!claimed?.length) return 0;

  // Who the officers of each site are.
  const siteIds = [...new Set(claimed.map((a) => a.district_notices.site_id))];
  const { data: siteOfficers } = await admin.from('site_officers').select('site_id, user_id').in('site_id', siteIds);
  const deptIds = [...new Set(claimed.map((a) => a.district_notices.sites?.department_id).filter(Boolean))];
  const { data: deptOfficers } = deptIds.length
    ? await admin.from('staff').select('department_id, user_id').in('department_id', deptIds).eq('role', 'officer').eq('active', true).not('user_id', 'is', null)
    : { data: [] };
  const officersOf = (notice) => [
    ...(siteOfficers ?? []).filter((o) => o.site_id === notice.site_id).map((o) => o.user_id),
    ...(deptOfficers ?? []).filter((o) => o.department_id === notice.sites?.department_id).map((o) => o.user_id),
  ];

  const linesFor = new Map();
  for (const a of claimed) {
    const n = a.district_notices;
    const who = a.district_doctors?.name ?? 'A doctor';
    const line = a.status === 'withdrawn'
      ? `${who} withdrew from ${shiftLine(n)}`
      : `${who} applied for ${shiftLine(n)}${a.note ? ` ("${a.note}")` : ''}`;
    for (const userId of new Set(officersOf(n))) linesFor.set(userId, [...(linesFor.get(userId) ?? []), line]);
  }
  if (!linesFor.size) return 0;

  const { data: profiles } = await admin.from('profiles').select('user_id, email').in('user_id', [...linesFor.keys()]);
  for (const [userId, lines] of linesFor) {
    const email = profiles?.find((p) => p.user_id === userId)?.email;
    await tell(admin, { email, userId }, {
      subject: lines.length === 1 ? lines[0] : `${plural(lines.length, 'update')} on your district shifts`,
      intro: 'Applications for your sites\' shifts. Approve or decline them on the Calendar.',
      lines,
      pushTitle: lines.length === 1 ? 'Shift application' : `${plural(lines.length, 'shift application update')}`,
      tag: 'applications',
    });
  }
  return linesFor.size;
}

async function doctorNews(admin) {
  const { data: claimed, error } = await admin
    .from('district_applications')
    .update({ doctor_notified_at: new Date().toISOString() })
    .is('doctor_notified_at', null)
    .in('status', ['approved', 'declined', 'cancelled'])
    .select('status, decline_reason, doctor_id, district_notices(shift_date, start_time, end_time, title, position, sites(name)), district_doctors(user_id, email, name, notify_email, notify_push)');
  if (error) throw error;

  const byDoctor = new Map();
  for (const a of claimed ?? []) {
    if (!a.district_doctors?.user_id) continue;
    const n = a.district_notices;
    const line = {
      approved: `You're booked: ${shiftLine(n)}`,
      declined: `Not this time: ${shiftLine(n)}${a.decline_reason ? ` (${a.decline_reason})` : ''}`,
      cancelled: `Your booking was cancelled: ${shiftLine(n)}`,
    }[a.status];
    const entry = byDoctor.get(a.doctor_id) ?? { doctor: a.district_doctors, lines: [], booked: 0 };
    entry.lines.push(line);
    if (a.status === 'approved') entry.booked++;
    byDoctor.set(a.doctor_id, entry);
  }

  for (const { doctor: d, lines, booked } of byDoctor.values()) {
    const subject = lines.length === 1 ? lines[0] : booked ? `You're booked on ${plural(booked, 'shift')}` : 'Updates on your shift applications';
    await tell(admin, { email: d.email, userId: d.user_id, wantsEmail: d.notify_email, wantsPush: d.notify_push }, {
      subject,
      intro: `Hi ${d.name.split(' ')[0]}, here's what's happened with your district shifts:`,
      lines,
      pushTitle: booked ? "You're booked" : 'Shift application update',
      tag: 'my-applications',
    });
  }
  return byDoctor.size;
}

async function sendTest(admin, token: string) {
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return json({ error: 'Not signed in' }, 401);
  const lines = ['This is a test from DR Roster. If you can read this, notifications are working.'];
  const emailed = await sendEmail(user.email, 'DR Roster test', 'Hi,', lines);
  const pushed = await sendPush(admin, user.id, 'DR Roster test', lines[0], 'test');
  return json({ data: { emailed, pushed } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const body = await req.json().catch(() => ({}));

  if (body.test) {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    return sendTest(admin, token);
  }

  const { data: ok } = await admin.rpc('district_notify_secret_ok', { p_secret: req.headers.get('x-cron-secret') ?? '' });
  if (!ok) return json({ error: 'Forbidden' }, 403);

  try {
    const shifts = await newShifts(admin);
    const officers = await officerNews(admin);
    const doctors = await doctorNews(admin);
    return json({ data: { doctorsToldOfNewShifts: shifts, officersTold: officers, doctorsToldOfDecisions: doctors } });
  } catch (err) {
    console.error('district-notify failed:', err);
    return json({ error: String(err?.message ?? err) }, 500);
  }
});
