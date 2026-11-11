// Gives a doctor (or an officer waiting for a login) a one-time password,
// for when the invite email never arrives, or they've forgotten their
// password. The officer passes it on themselves (email, SMS, in person);
// nothing is sent from here. Like roster-app's generate-temp-password, and
// it uses the same must_reset_password flag, so the next sign-in, in either
// app, asks them to choose their own password.
//
// Only a district officer (is_district_officer) can call it, and only for
// people in that district. Someone who is a super admin can only be reset
// by a super admin.
//
// Deploy: `supabase functions deploy district-temp-password`
// Uses the same SUPABASE_SERVICE_ROLE_KEY secret as invite-district-doctor.
//
// Request:  { districtId, doctorId } or { districtId, officerEmail }
// Response: { data: { tempPassword, name, email, mfaWasReset } } | { error }
//
// Emailing it (the panel's "Email it to them"): sent from GMAIL_USER
// (ruralroster@gmail.com, as the invites are), so it works on any device
// and a copy is in that account's Sent.
// Request:  the same, plus { emailPassword }
// Response: { data: { emailed: true, email } } | { error }
// Only a password in this function's own format, to someone who still has
// to change theirs (must_reset_password), so it can't be used to email
// anything else.
//
// No login yet: one is made (no email sent) and linked, as an invite would.
// Two-factor is cleared, because Supabase won't change the password of an
// account that has it, and someone locked out is usually locked out of that
// too; they can turn it back on in My profile.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import nodemailer from 'npm:nodemailer@6.9.16';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const GMAIL_USER = Deno.env.get('GMAIL_USER');
const GMAIL_APP_PASSWORD = Deno.env.get('GMAIL_APP_PASSWORD');
const APP_URL = 'https://ruralroster.github.io/district-roster/';

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

// No 0/O or 1/l/I: it gets typed in by hand off a phone.
const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function tempPassword(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CHARS[b % CHARS.length]).join('');
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

  let body: { districtId?: string; doctorId?: string; officerEmail?: string; emailPassword?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const { districtId, doctorId } = body;
  const officerEmail = body.officerEmail?.trim().toLowerCase();
  if (!districtId || (!doctorId && !officerEmail)) {
    return json({ error: 'districtId, and doctorId or officerEmail, are required' }, 400);
  }

  const userClient = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) {
    return json({ error: 'Not authenticated' }, 401);
  }
  const [{ data: isOfficer, error: officerCheckError }, { data: callerIsSuperAdmin }] = await Promise.all([
    userClient.rpc('is_district_officer', { p_district_id: districtId }),
    userClient.rpc('is_super_admin'),
  ]);
  if (officerCheckError) {
    return json({ error: `Officer check failed: ${officerCheckError.message}` }, 500);
  }
  if (!isOfficer) {
    return json({ error: 'Only district officers can give a one-time password' }, 403);
  }

  const adminClient = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);

  // Who it's for, and their login if they have one.
  let name: string | null = null;
  let email: string;
  let userId: string | null = null;
  if (doctorId) {
    const { data: doctor } = await adminClient
      .from('district_doctors')
      .select('doctor_id, user_id, name, email')
      .eq('doctor_id', doctorId)
      .eq('district_id', districtId)
      .maybeSingle();
    if (!doctor) return json({ error: 'No such doctor in this district' }, 404);
    ({ name, email, user_id: userId } = doctor);
  } else if (body.emailPassword !== undefined) {
    // By now they're a site officer here (their login was made when the
    // password was).
    const { data: officer } = await adminClient
      .from('site_officers')
      .select('user_id, sites!inner(district_id)')
      .eq('sites.district_id', districtId)
      .ilike('email', officerEmail!)
      .limit(1);
    if (!officer?.length) return json({ error: 'No officer with that email in this district' }, 404);
    userId = officer[0].user_id;
    email = officerEmail!;
  } else {
    const { data: pending } = await adminClient
      .from('site_officer_pending')
      .select('site_id, name, sites!inner(district_id)')
      .eq('sites.district_id', districtId)
      .eq('email', officerEmail);
    if (!pending?.length) return json({ error: 'No officer waiting for a login with that email in this district' }, 404);
    name = pending.find((p) => p.name)?.name ?? null;
    email = officerEmail!;
  }

  if (body.emailPassword !== undefined) {
    const sent = body.emailPassword;
    if (!new RegExp(`^[${CHARS}]{10}$`).test(sent)) return json({ error: "That isn't a one-time password" }, 400);
    if (!userId) return json({ error: 'They have no login yet' }, 400);
    const { data: profile } = await adminClient.from('profiles').select('must_reset_password').eq('user_id', userId).maybeSingle();
    if (!profile?.must_reset_password) return json({ error: "They've already chosen their own password" }, 409);
    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return json({ error: 'GMAIL_USER / GMAIL_APP_PASSWORD not set' }, 500);
    try {
      await sendTempPassword(email, name, sent);
    } catch (e) {
      return json({ error: `Email failed: ${e.message ?? e}` }, 500);
    }
    return json({ data: { emailed: true, email } });
  }

  if (!userId) {
    const { data: existingProfile } = await adminClient
      .from('profiles')
      .select('user_id')
      .ilike('email', email)
      .maybeSingle();
    if (existingProfile) {
      userId = existingProfile.user_id;
    } else {
      const { data: created, error: createError } = await adminClient.auth.admin.createUser({ email, email_confirm: true });
      if (createError) return json({ error: `Account creation failed: ${createError.message}` }, 500);
      userId = created.user.id;
      // A new profile makes a waiting officer a site officer
      // (site_officer_pending_claim).
      const { error: profileError } = await adminClient.from('profiles').upsert({ user_id: userId, email });
      if (profileError) return json({ error: `Profile link failed: ${profileError.message}` }, 500);
    }
    if (doctorId) {
      const { error } = await adminClient.from('district_doctors').update({ user_id: userId }).eq('doctor_id', doctorId);
      if (error) return json({ error: `Doctor link failed: ${error.message}` }, 500);
    } else {
      // Their profile may already have existed, so the claim trigger may
      // not have fired.
      const { data: pending } = await adminClient
        .from('site_officer_pending')
        .select('site_id, sites!inner(district_id)')
        .eq('sites.district_id', districtId)
        .eq('email', email);
      for (const p of pending ?? []) {
        await adminClient.from('site_officers').upsert(
          { site_id: p.site_id, user_id: userId, email },
          { onConflict: 'site_id,user_id', ignoreDuplicates: true },
        );
        await adminClient.from('site_officer_pending').delete().eq('site_id', p.site_id).eq('email', email);
      }
    }
  }

  const { data: target } = await adminClient.from('profiles').select('is_super_admin').eq('user_id', userId).maybeSingle();
  if (target?.is_super_admin && !callerIsSuperAdmin) {
    return json({ error: "That's an administrator's account; only an administrator can reset it" }, 403);
  }

  const { data: factorsData, error: factorsError } = await adminClient.auth.admin.mfa.listFactors({ userId });
  if (factorsError) return json({ error: `Couldn't check two-factor: ${factorsError.message}` }, 500);
  const factors = factorsData?.factors ?? [];
  for (const factor of factors) {
    const { error } = await adminClient.auth.admin.mfa.deleteFactor({ id: factor.id, userId });
    if (error) return json({ error: `Couldn't clear two-factor: ${error.message}` }, 500);
  }

  const password = tempPassword();
  const { error: pwError } = await adminClient.auth.admin.updateUserById(userId, { password });
  if (pwError) return json({ error: `Couldn't set the password: ${pwError.message}` }, 500);

  const { error: flagError } = await adminClient.from('profiles').update({ must_reset_password: true }).eq('user_id', userId);
  if (flagError) return json({ error: `Password set, but couldn't ask them to change it: ${flagError.message}` }, 500);

  return json({ data: { tempPassword: password, name, email, mfaWasReset: factors.length > 0 } });
});

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Written like Rstar's one-time password email.
async function sendTempPassword(to: string, name: string | null, password: string) {
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  const firstName = (name || '').split(/\s+/).filter((w) => w && !/^(Dr|Mr|Mrs|Ms|Prof)\.?$/i.test(w))[0] || 'there';
  const lines = [
    `Dear ${firstName},`,
    '',
    'Please find below your one-time password for DR App:',
    '',
    password,
    '',
    `Sign in at ${APP_URL} using this email address as your username and the password above. If you also use Rstar, it's the same login.`,
    '',
    "The first time you sign in, you'll be asked to choose a new password of your own. The one-time password won't work after that.",
    '',
    'To put DR App on your phone like an app:',
    '',
    `iPhone: open ${APP_URL} in Safari (not Chrome or the Gmail browser), tap the Share button (the square with an arrow), then "Add to Home Screen" and "Add". Open DR App from your Home Screen from then on: phone notifications only work from there.`,
    '',
    `Android: open ${APP_URL} in Chrome, tap the ⋮ menu (top right), then "Install app" or "Add to Home screen".`,
    '',
    'Then turn on notifications in My profile, so you hear about new shifts.',
    '',
    "If there are any issues, or anything you'd like changed or added to the app, please don't hesitate to get in touch at ruralroster@gmail.com.",
    '',
    'Cheers,',
    'Rural Roster Team',
  ];
  const html = lines
    .join('\n')
    .split('\n\n')
    .map((para) => para === password
      ? `<p style="font-family:monospace;font-size:20px;letter-spacing:0.08em"><strong>${escapeHtml(para)}</strong></p>`
      : `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  await transporter.sendMail({ from: `"DR App" <${GMAIL_USER}>`, to, subject: 'Your DR App one-time password', text: lines.join('\n'), html });
}
