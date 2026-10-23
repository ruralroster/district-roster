# District Roster

District-level rostering for rural sites: district doctors, notices, applications and swaps. It replaces rural-rosters-v3 and shares a Supabase project (and logins) with [roster-app](https://github.com/ruralroster/roster-app). The build list is in [roster-app#2](https://github.com/ruralroster/roster-app/issues/2).

Live: https://ruralroster.github.io/district-roster/

## Setup

- `migrations/`: run each file in the Supabase SQL Editor, in date order, after roster-app's migrations.
- `supabase/functions/`: deploy with `supabase functions deploy <name>`. They use the same `SUPABASE_SERVICE_ROLE_KEY` secret as roster-app.
- Supabase Auth → URL Configuration → Redirect URLs must include `https://ruralroster.github.io/district-roster/*`.
- Local: copy `.env.example` to `.env`, then `npm install` and `npm run dev`.
- Deploys to GitHub Pages on every push to `main`. It needs the repo secrets `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

## Who can do what

- **Super admin** (`profiles.is_super_admin`): creates districts and sites, links sites to roster-app departments, adds site officers.
- **Site officer**: officers of the linked roster-app department, plus anyone added to the site. Invites, edits and deactivates the district's doctors.
- **District doctor**: sees their district's sites and doctors and edits their own profile (home site, skills, contact, notifications).
