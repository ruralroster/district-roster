// district-notify: DR Roster's emails and phone notifications.
//
// Run every 30 minutes (6:00-21:00 Brisbane) by pg_cron with the
// x-cron-secret header (see migrations/2026-10-27b_notify_rules.sql). Each
// run sends whatever's waiting, one email and one push per person; a run
// with nothing new sends nothing:
//   - a shift posted on DR Roster, once, straight away, to doctors who'd
//     work at that site, at or above its level, whose skills fit, who
//     aren't marked unavailable and are rested (10 hours either side; the
//     rules are in SQL: district_notice_recipients). One escalated from
//     roster-app isn't sent on its own: it waits for the Monday summary.
//   - Mondays from 9:00, each doctor's summary: every open shift they can
//     do (same rules) at the sites they'd work at, for the next 6 weeks
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

// Shifts posted on DR Roster since the last run. Escalated ones
// (source 'roster_app') are marked too but left for the Monday summary.
async function newShifts(admin) {
  const { data: claimed, error } = await admin
    .from('district_notices')
    .update({ notified_at: new Date().toISOString() })
    .is('notified_at', null)
    .select('*, sites(name)');
  if (error) throw error;
  const today = brisbaneToday();
  const notices = (claimed ?? [])
    .filter((n) => n.status === 'open' && n.source !== 'roster_app' && n.shift_date >= today)
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

// Swap news, queued by the swap functions in SQL (district_swap_messages):
// one email/push per person with all their lines.
async function swapNews(admin) {
  const { data: claimed, error } = await admin
    .from('district_swap_messages')
    .update({ sent_at: new Date().toISOString() })
    .is('sent_at', null)
    .select('user_id, line, push_title, created_at');
  if (error) throw error;
  if (!claimed?.length) return 0;

  const byUser = new Map();
  for (const m of claimed.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    byUser.set(m.user_id, [...(byUser.get(m.user_id) ?? []), m]);
  }
  const userIds = [...byUser.keys()];
  const [{ data: profiles }, { data: doctors }] = await Promise.all([
    admin.from('profiles').select('user_id, email').in('user_id', userIds),
    admin.from('district_doctors').select('user_id, name, notify_email, notify_push').in('user_id', userIds),
  ]);
  for (const [userId, messages] of byUser) {
    const email = profiles?.find((p) => p.user_id === userId)?.email;
    // As a doctor, their own email/push settings; officers always hear.
    const doctor = doctors?.find((d) => d.user_id === userId);
    const lines = messages.map((m) => m.line);
    await tell(admin, { email, userId, wantsEmail: doctor?.notify_email, wantsPush: doctor?.notify_push }, {
      subject: lines.length === 1 ? lines[0] : `${plural(lines.length, 'swap update')}`,
      intro: `${doctor ? `Hi ${doctor.name.split(' ')[0]}, h` : 'H'}ere's what's happening with shift swaps. See the Swaps tab.`,
      lines,
      pushTitle: messages.length === 1 ? messages[0].push_title : `${plural(messages.length, 'swap update')}`,
      tag: 'swaps',
    });
  }
  return byUser.size;
}

// Brisbane is UTC+10 all year.
const brisbaneNow = () => new Date(Date.now() + 10 * 3600 * 1000);
const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const startsAt = (n) => Date.parse(`${n.shift_date}T${n.start_time.slice(0, 5)}:00+10:00`);

// Officers of each site: site_id -> [user_id].
async function officersBySite(admin) {
  const { data, error } = await admin.rpc('district_site_officer_pairs');
  if (error) throw error;
  const bySite = new Map();
  for (const p of data ?? []) bySite.set(p.site_id, [...(bySite.get(p.site_id) ?? []), p.user_id]);
  return bySite;
}

async function emailsFor(admin, userIds: string[]) {
  if (!userIds.length) return new Map();
  const { data } = await admin.from('profiles').select('user_id, email').in('user_id', userIds);
  return new Map((data ?? []).map((p) => [p.user_id, p.email]));
}

// A shift still open with under 72 hours to go: the site's officers are
// told at once, once. (Not one posted in the last 6 hours: the officer
// who posted it knows.)
async function urgentShifts(admin) {
  const today = brisbaneToday();
  const { data, error } = await admin
    .from('district_notices')
    .select('*, sites(name)')
    .eq('status', 'open')
    .neq('source', 'roster_shift')
    .is('urgent_notified_at', null)
    .gte('shift_date', today)
    .lte('shift_date', addDays(today, 3));
  if (error) throw error;
  const now = Date.now();
  const due = (data ?? []).filter((n) =>
    startsAt(n) > now && startsAt(n) - now < 72 * 3600 * 1000 && now - Date.parse(n.created_at) > 6 * 3600 * 1000);
  if (!due.length) return 0;
  await admin.from('district_notices').update({ urgent_notified_at: new Date().toISOString() }).in('notice_id', due.map((n) => n.notice_id));

  const bySite = await officersBySite(admin);
  const linesFor = new Map();
  for (const n of due) {
    for (const userId of new Set(bySite.get(n.site_id) ?? [])) linesFor.set(userId, [...(linesFor.get(userId) ?? []), shiftLine(n)]);
  }
  const emails = await emailsFor(admin, [...linesFor.keys()]);
  for (const [userId, lines] of linesFor) {
    await tell(admin, { email: emails.get(userId), userId }, {
      subject: lines.length === 1 ? `Still unfilled, under 72 hours to go: ${lines[0]}` : `${plural(lines.length, 'shift')} still unfilled, under 72 hours to go`,
      intro: 'These district shifts at your sites start within 72 hours and nobody has been booked. A locum might be needed.',
      lines,
      pushTitle: 'Unfilled shift: under 72 hours to go',
      tag: 'urgent',
    });
  }
  return linesFor.size;
}

// The weekly digest, on each officer's chosen day(s) (Monday unless
// they've changed it), from 7:00: their sites' open shifts for the next 6
// weeks, "locum might be required" (under 3 weeks away) first, and swaps
// waiting for them.
async function digests(admin) {
  const now = brisbaneNow();
  if (now.getUTCHours() < 7) return 0;
  const today = brisbaneToday();
  const weekday = (now.getUTCDay() + 6) % 7; // 0 = Monday

  const bySite = await officersBySite(admin);
  const officerIds = [...new Set([...bySite.values()].flat())];
  if (!officerIds.length) return 0;
  const { data: settings } = await admin.from('district_officer_settings').select('*').in('user_id', officerIds);
  const settingsOf = new Map((settings ?? []).map((r) => [r.user_id, r]));
  const dueToday = officerIds.filter((id) => {
    const r = settingsOf.get(id);
    return (r?.digest_days ?? [0]).includes(weekday) && r?.digest_sent_on !== today;
  });
  if (!dueToday.length) return 0;
  // Claim first, so an overlapping run can't send twice.
  await admin.from('district_officer_settings').upsert(dueToday.map((user_id) => ({ user_id, digest_sent_on: today })), { onConflict: 'user_id' });

  const { data: open } = await admin
    .from('district_notices')
    .select('*, sites(name)')
    .eq('status', 'open')
    .neq('source', 'roster_shift')
    .gte('shift_date', today)
    .lte('shift_date', addDays(today, 42))
    .order('shift_date')
    .order('start_time');
  const { data: offers } = await admin
    .from('district_swap_offers')
    .select('offer_id, district_swap_listings!inner(notice_id, district_notices!inner(site_id))')
    .eq('status', 'pending');
  const locumBy = addDays(today, 21);

  const emails = await emailsFor(admin, dueToday);
  let sent = 0;
  for (const userId of dueToday) {
    const mySites = new Set([...bySite].filter(([, ids]) => ids.includes(userId)).map(([siteId]) => siteId));
    const mine = (open ?? []).filter((n) => mySites.has(n.site_id));
    const swaps = (offers ?? []).filter((o) => mySites.has(o.district_swap_listings?.district_notices?.site_id)).length;
    if (!mine.length && !swaps) continue;
    const locum = mine.filter((n) => n.shift_date <= locumBy);
    const later = mine.filter((n) => n.shift_date > locumBy);
    const lines = [
      ...locum.map((n) => `LOCUM MIGHT BE REQUIRED: ${shiftLine(n)}`),
      ...later.map((n) => `Open: ${shiftLine(n)}`),
      ...(swaps ? [`${plural(swaps, 'swap')} waiting for your approval on the Swaps tab`] : []),
    ];
    await tell(admin, { email: emails.get(userId), userId }, {
      subject: locum.length
        ? `Weekly digest: ${plural(locum.length, 'shift')} might need a locum`
        : `Weekly digest: ${plural(mine.length, 'open shift')} at your sites`,
      intro: 'Your sites\' district shifts still open over the next 6 weeks. Shifts less than 3 weeks away with nobody booked might need a locum.',
      lines,
      pushTitle: locum.length ? `${plural(locum.length, 'shift')} might need a locum` : 'Weekly digest',
      tag: 'digest',
    });
    sent++;
  }
  return sent;
}

// Mondays from 9:00: each doctor's summary of every open shift they can
// do over the next 6 weeks (the same rules as a new shift), leaving out
// ones they've already applied for. Claimed per doctor
// (district_doctors.digest_sent_on), so it's sent once.
async function doctorDigests(admin) {
  const now = brisbaneNow();
  if (now.getUTCDay() !== 1 || now.getUTCHours() < 9) return 0;
  const today = brisbaneToday();

  const { data: doctors, error } = await admin
    .from('district_doctors')
    .update({ digest_sent_on: today })
    .eq('active', true)
    .not('user_id', 'is', null)
    .or(`digest_sent_on.is.null,digest_sent_on.neq.${today}`)
    .select('doctor_id, user_id, email, name, notify_email, notify_push');
  if (error) throw error;
  if (!doctors?.length) return 0;

  const { data: open } = await admin
    .from('district_notices')
    .select('*, sites(name)')
    .eq('status', 'open')
    .gte('shift_date', today)
    .lte('shift_date', addDays(today, 42))
    .order('shift_date')
    .order('start_time');
  const notices = (open ?? []).filter((n) => startsAt(n) > Date.now());
  if (!notices.length) return 0;

  const { data: pairs, error: pairsError } = await admin.rpc('district_notice_recipients', {
    p_notice_ids: notices.map((n) => n.notice_id),
  });
  if (pairsError) throw pairsError;
  const { data: applied } = await admin
    .from('district_applications')
    .select('doctor_id, notice_id')
    .in('status', ['pending', 'approved'])
    .in('notice_id', notices.map((n) => n.notice_id));
  const appliedFor = new Set((applied ?? []).map((a) => `${a.doctor_id}:${a.notice_id}`));

  let sent = 0;
  for (const d of doctors) {
    const mine = new Set((pairs ?? []).filter((p) => p.doctor_id === d.doctor_id).map((p) => p.notice_id));
    const fits = notices.filter((n) => mine.has(n.notice_id) && !appliedFor.has(`${d.doctor_id}:${n.notice_id}`));
    if (!fits.length) continue;
    await tell(admin, { email: d.email, userId: d.user_id, wantsEmail: d.notify_email, wantsPush: d.notify_push }, {
      subject: `This week: ${plural(fits.length, 'district shift')} you can do`,
      intro: `Hi ${d.name.split(' ')[0]}, here are the open shifts over the next 6 weeks at the sites you'd work at that you can do. Apply on the Calendar.`,
      lines: fits.map(shiftLine),
      pushTitle: `${plural(fits.length, 'district shift')} you can do`,
      tag: 'doctor-digest',
    });
    sent++;
  }
  return sent;
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
    const swaps = await swapNews(admin);
    const urgent = await urgentShifts(admin);
    const digest = await digests(admin);
    const doctorDigest = await doctorDigests(admin);
    return json({
      data: {
        doctorsToldOfNewShifts: shifts, officersTold: officers, doctorsToldOfDecisions: doctors, toldOfSwaps: swaps,
        officersToldOfUrgent: urgent, digestsSent: digest, doctorSummariesSent: doctorDigest,
      },
    });
  } catch (err) {
    console.error('district-notify failed:', err);
    return json({ error: String(err?.message ?? err) }, 500);
  }
});
