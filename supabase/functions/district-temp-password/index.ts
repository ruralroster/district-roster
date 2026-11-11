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
// No login yet: one is made (no email sent) and linked, as an invite would.
// Two-factor is cleared, because Supabase won't change the password of an
// account that has it, and someone locked out is usually locked out of that
// too; they can turn it back on in My profile.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

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

  let body: { districtId?: string; doctorId?: string; officerEmail?: string };
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
