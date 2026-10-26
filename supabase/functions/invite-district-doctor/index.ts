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
//     Response: { data: { doctorId, invited } } | { error }
//
//   Invite people already on the list with no login yet (doctors added by
//   the v3 import, and officers waiting in site_officer_pending)
//     Request:  { districtId, doctorIds?: [...], officerEmails?: [...], redirectTo? }
//     Response: { data: { results: [{ email, invited, linked, error? }] } }
//   Each person is done on their own, so one failure doesn't stop the rest.
//   Someone who already has a login (e.g. roster-app) is linked without an
//   email.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

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
      .select('doctor_id, email')
      .eq('district_id', districtId)
      .is('user_id', null)
      .in('doctor_id', body.doctorIds?.length ? body.doctorIds : ['00000000-0000-0000-0000-000000000000']);
    for (const d of doctors ?? []) {
      try {
        const { userId, invited } = await loginFor(adminClient, d.email, redirectTo);
        const { error } = await adminClient.from('district_doctors').update({ user_id: userId }).eq('doctor_id', d.doctor_id);
        if (error) throw error;
        results.push({ email: d.email, invited, linked: !invited });
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
        .select('site_id, email, sites!inner(district_id)')
        .eq('sites.district_id', districtId)
        .in('email', emails)
      : { data: [] };
    for (const officerEmail of [...new Set((pending ?? []).map((p) => p.email))]) {
      try {
        const { userId, invited } = await loginFor(adminClient, officerEmail, redirectTo);
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
        results.push({ email: officerEmail, invited, linked: !invited });
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

  const { data: existingProfile } = await adminClient
    .from('profiles')
    .select('user_id')
    .ilike('email', email)
    .maybeSingle();

  let invited = false;
  let targetUserId: string;

  if (existingProfile) {
    // Already has a login (roster-app or another district): link, no invite.
    targetUserId = existingProfile.user_id;
  } else {
    const { data: inviteData, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(
      email,
      redirectTo ? { redirectTo } : undefined,
    );
    if (inviteError) {
      return json({ error: `Invite failed: ${inviteError.message}` }, 500);
    }
    targetUserId = inviteData.user.id;
    invited = true;

    const { error: profileError } = await adminClient
      .from('profiles')
      .upsert({ user_id: targetUserId, email });
    if (profileError) {
      return json({ error: `Profile link failed: ${profileError.message}` }, 500);
    }
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

  return json({ data: { doctorId: doctor.doctor_id, invited } });
});

// The login for an email: an existing one (no email sent), or a new one
// with an invite email. Makes sure the profile row exists.
async function loginFor(adminClient, email: string, redirectTo?: string) {
  const { data: existingProfile } = await adminClient
    .from('profiles')
    .select('user_id')
    .ilike('email', email)
    .maybeSingle();
  if (existingProfile) return { userId: existingProfile.user_id, invited: false };

  const { data: inviteData, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(
    email,
    redirectTo ? { redirectTo } : undefined,
  );
  if (inviteError) throw new Error(`Invite failed: ${inviteError.message}`);
  const { error: profileError } = await adminClient
    .from('profiles')
    .upsert({ user_id: inviteData.user.id, email });
  if (profileError) throw new Error(`Profile link failed: ${profileError.message}`);
  return { userId: inviteData.user.id, invited: true };
}
