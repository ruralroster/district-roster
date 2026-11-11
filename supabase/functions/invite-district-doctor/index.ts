// Adds a doctor to a district and sends them an invite (or links their
// existing login, e.g. someone already on roster-app). Runs server-side
// because creating an auth.users row needs the service_role key.
//
// Only a district officer (is_district_officer, the same check the RLS
// policies use) can call it.
//
// Deploy: `supabase functions deploy invite-district-doctor`
// Uses the same SUPABASE_SERVICE_ROLE_KEY secret as roster-app's
// invite-staff.
//
// Two jobs:
//
//   New doctor
//     Request:  { districtId, name, email, homeSiteId?, skills?, redirectTo? }
//     Response: { data: { doctorId, invited, emailed } } | { error }
//
//   Invite people already on the list with no login yet (doctors added by
//   the v3 import, and officers waiting in site_officer_pending)
//     Request:  { districtId, doctorIds?: [...], officerEmails?: [...], redirectTo? }
//     Response: { data: { results: [{ email, invited, linked, emailed, error? }] } }
//   Each person is done on their own, so one failure doesn't stop the rest.
//   Someone who already has a login (e.g. roster-app) is linked, and sent
//   the same email without the password link: it says to sign in with
//   their Rstar email and password (emailed: false if that email fails;
//   they're still linked).
//
// The invite email is DR Roster's own, sent through Gmail (the project's
// GMAIL_USER / GMAIL_APP_PASSWORD, like district-notify), with a sign-up
// link from Supabase (generateLink). That avoids Supabase's built-in email
// limit of a few an hour, and its invite template, which is shared with
// roster-app.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import nodemailer from 'npm:nodemailer@6.9.16';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const GMAIL_USER = Deno.env.get('GMAIL_USER');
const GMAIL_APP_PASSWORD = Deno.env.get('GMAIL_APP_PASSWORD');
const APP_URL = 'https://ruralroster.github.io/district-roster/';

const SKILLS = ['Emergency', 'Anaesthetics', 'O&G', 'Endoscopy'];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return json({ error: 'Missing Authorization header' }, 401);
  }

  let body: {
    districtId?: string; name?: string; email?: string; homeSiteId?: string; skills?: string[]; redirectTo?: string;
    doctorIds?: string[]; officerEmails?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { districtId, homeSiteId, redirectTo } = body;
  const inviting = Array.isArray(body.doctorIds) || Array.isArray(body.officerEmails);
  const name = body.name?.trim();
  const email = body.email?.trim().toLowerCase();
  if (!districtId || (!inviting && (!name || !email))) {
    return json({ error: 'districtId, and name and email (or doctorIds/officerEmails), are required' }, 400);
  }
  // Emergency is always held (v3's rule); ignore anything not on the list.
  const skills = ['Emergency', ...(body.skills ?? []).filter((s) => SKILLS.includes(s) && s !== 'Emergency')];

  const userClient = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) {
    return json({ error: 'Not authenticated' }, 401);
  }

  const { data: isOfficer, error: officerCheckError } = await userClient.rpc('is_district_officer', {
    p_district_id: districtId,
  });
  if (officerCheckError) {
    return json({ error: `Officer check failed: ${officerCheckError.message}` }, 500);
  }
  if (!isOfficer) {
    return json({ error: 'Only district officers can invite doctors' }, 403);
  }

  const adminClient = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);

  if (inviting) {
    const results = [];
    // Doctors in this district who have no login yet.
    const { data: doctors } = await adminClient
      .from('district_doctors')
      .select('doctor_id, email, name')
      .eq('district_id', districtId)
      .is('user_id', null)
      .in('doctor_id', body.doctorIds?.length ? body.doctorIds : ['00000000-0000-0000-0000-000000000000']);
    for (const d of doctors ?? []) {
      try {
        const { userId, invited, emailed } = await loginFor(adminClient, d.email, redirectTo, d.name);
        const { error } = await adminClient.from('district_doctors').update({ user_id: userId }).eq('doctor_id', d.doctor_id);
        if (error) throw error;
        results.push({ email: d.email, invited, linked: !invited, emailed });
      } catch (e) {
        results.push({ email: d.email, invited: false, linked: false, error: e.message ?? String(e) });
      }
    }
    // Officers waiting for a login at this district's sites. Creating their
    // profile turns them into site officers (site_officer_pending_claim).
    const emails = (body.officerEmails ?? []).map((e) => e.trim().toLowerCase());
    const { data: pending } = emails.length
      ? await adminClient
        .from('site_officer_pending')
        .select('site_id, email, name, sites!inner(district_id)')
        .eq('sites.district_id', districtId)
        .in('email', emails)
      : { data: [] };
    for (const officerEmail of [...new Set((pending ?? []).map((p) => p.email))]) {
      try {
        const officerName = (pending ?? []).find((x) => x.email === officerEmail && x.name)?.name;
        const { userId, invited, emailed } = await loginFor(adminClient, officerEmail, redirectTo, officerName, true);
        if (!invited) {
          // Their profile already existed, so the claim trigger won't fire.
          for (const p of (pending ?? []).filter((x) => x.email === officerEmail)) {
            await adminClient.from('site_officers').upsert(
              { site_id: p.site_id, user_id: userId, email: officerEmail },
              { onConflict: 'site_id,user_id', ignoreDuplicates: true },
            );
            await adminClient.from('site_officer_pending').delete().eq('site_id', p.site_id).eq('email', officerEmail);
          }
        }
        results.push({ email: officerEmail, invited, linked: !invited, emailed });
      } catch (e) {
        results.push({ email: officerEmail, invited: false, linked: false, error: e.message ?? String(e) });
      }
    }
    return json({ data: { results } });
  }

  const { data: existingDoctor } = await adminClient
    .from('district_doctors')
    .select('doctor_id')
    .eq('district_id', districtId)
    .eq('email', email)
    .maybeSingle();
  if (existingDoctor) {
    return json({ error: `${email} is already a doctor in this district` }, 409);
  }

  // Already has a login (roster-app or another district): link, no invite.
  let invited: boolean;
  let emailed: boolean;
  let targetUserId: string;
  try {
    ({ userId: targetUserId, invited, emailed } = await loginFor(adminClient, email, redirectTo, name));
  } catch (e) {
    return json({ error: e.message ?? String(e) }, 500);
  }

  const { data: doctor, error: doctorError } = await adminClient
    .from('district_doctors')
    .insert([{
      district_id: districtId,
      user_id: targetUserId,
      email,
      name,
      home_site_id: homeSiteId || null,
      skills,
    }])
    .select('doctor_id')
    .single();
  if (doctorError) {
    return json({ error: `Doctor record failed: ${doctorError.message}` }, 500);
  }

  return json({ data: { doctorId: doctor.doctor_id, invited, emailed } });
});

// The login for an email: an existing one (emailed to say their Rstar
// password works here), or a new one with DR Roster's invite email. Makes sure the profile row exists. If the
// email can't be sent, the new login is removed again, so trying later
// starts afresh rather than finding a login nobody was told about.
async function loginFor(adminClient, email: string, redirectTo?: string, name?: string, asOfficer = false) {
  const { data: existingProfile } = await adminClient
    .from('profiles')
    .select('user_id')
    .ilike('email', email)
    .maybeSingle();
  if (existingProfile) {
    let emailed = false;
    if (GMAIL_USER && GMAIL_APP_PASSWORD) {
      try {
        await sendInvite(email, null, name, asOfficer);
        emailed = true;
      } catch (e) {
        console.error(`Welcome email to ${email} failed:`, e);
      }
    }
    return { userId: existingProfile.user_id, invited: false, emailed };
  }

  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD not set');
  const { data: link, error: linkError } = await adminClient.auth.admin.generateLink({
    type: 'invite',
    email,
    options: redirectTo ? { redirectTo } : undefined,
  });
  if (linkError) throw new Error(`Invite failed: ${linkError.message}`);
  const userId = link.user.id;

  try {
    await sendInvite(email, link.properties.action_link, name, asOfficer);
  } catch (e) {
    await adminClient.auth.admin.deleteUser(userId).catch(() => {});
    throw new Error(`Invite email failed: ${e.message ?? e}`);
  }

  const { error: profileError } = await adminClient.from('profiles').upsert({ user_id: userId, email });
  if (profileError) throw new Error(`Profile link failed: ${profileError.message}`);
  return { userId, invited: true, emailed: true };
}

let transporter;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Written like roster-app's one-time password email (StaffAccountsTab's
// tempPasswordMailto). No link: they already have a login (Rstar), so it
// says to sign in with that instead of choosing a password.
async function sendInvite(to: string, link: string | null, name?: string, asOfficer = false) {
  transporter ??= nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  const firstName = (name || '').split(/\s+/).filter((w) => w && !/^(Dr|Mr|Mrs|Ms|Prof)\.?$/i.test(w))[0] || 'there';
  const intro = asOfficer
    ? "You've been set up as a rostering officer on DR Roster, the district's shift board, where your site's shifts go out to doctors across the district."
    : "You've been invited to DR Roster, the district's shift board. You'll see shifts at the sites you'd work at that fit your level, skills and roster, and can apply for them from your phone.";
  const existing = "You can sign in to DR Roster with your Rstar email and password. You don't need a new password.";
  const signIn = link
    ? `After that, sign in at ${APP_URL} using this email address as your username and the password you chose. If you already use Rstar, it's the same login.`
    : `Sign in at ${APP_URL} using this email address as your username and your Rstar password. If you've forgotten it, tap "Forgot password?" on the sign-in screen.`;
  const iphone = `iPhone: open ${APP_URL} in Safari (not Chrome or the Gmail browser), tap the Share button (the square with an arrow), then "Add to Home Screen" and "Add". Open DR Roster from your Home Screen from then on: phone notifications only work from there.`;
  const android = `Android: open ${APP_URL} in Chrome, tap the ⋮ menu (top right), then "Install app" or "Add to Home screen".`;
  const notify = 'Then turn on notifications in My profile, so you hear about new shifts.';
  const help = "If there are any issues, or anything you'd like changed or added to the app, please don't hesitate to get in touch at ruralroster@gmail.com.";
  const text = [
    `Dear ${firstName},`,
    '',
    ...(link ? [] : [existing, '']),
    intro,
    '',
    ...(link ? ['Tap the link below to choose your password:', '', link, ''] : []),
    signIn,
    '',
    'To put DR Roster on your phone like an app:',
    '',
    iphone,
    '',
    android,
    '',
    notify,
    '',
    help,
    '',
    'Cheers,',
    'Rural Roster Team',
  ].join('\n');
  const html = [
    `<p>Dear ${escapeHtml(firstName)},</p>`,
    ...(link ? [] : [`<p><strong>${escapeHtml(existing)}</strong></p>`]),
    `<p>${escapeHtml(intro)}</p>`,
    ...(link ? [`<p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#1f6fb2;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">Choose your password</a></p>`] : []),
    `<p>${escapeHtml(signIn)}</p>`,
    '<p>To put DR Roster on your phone like an app:</p>',
    `<p>${escapeHtml(iphone)}</p>`,
    `<p>${escapeHtml(android)}</p>`,
    `<p>${escapeHtml(notify)}</p>`,
    `<p>${escapeHtml(help)}</p>`,
    '<p>Cheers,<br>Rural Roster Team</p>',
  ].join('\n');
  await transporter.sendMail({ from: `"DR Roster" <${GMAIL_USER}>`, to, subject: link ? "You're invited to DR Roster" : "You're on DR Roster: use your Rstar login", text, html });
}
