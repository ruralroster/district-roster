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
// Request body: { districtId, name, email, homeSiteId?, skills?, redirectTo? }
// Response:     { data: { doctorId, invited } } | { error }

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const SKILLS = ['Emergency', 'Anaesthetics', 'O&G'];

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

  let body: { districtId?: string; name?: string; email?: string; homeSiteId?: string; skills?: string[]; redirectTo?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { districtId, homeSiteId, redirectTo } = body;
  const name = body.name?.trim();
  const email = body.email?.trim().toLowerCase();
  if (!districtId || !name || !email) {
    return json({ error: 'districtId, name and email are required' }, 400);
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
