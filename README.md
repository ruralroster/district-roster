# District Roster

District-level rostering for rural sites: district doctors, notices, applications and swaps. It replaces rural-rosters-v3 and shares a Supabase project (and logins) with [roster-app](https://github.com/ruralroster/roster-app). The build list is in [roster-app#2](https://github.com/ruralroster/roster-app/issues/2).

Live: https://ruralroster.github.io/district-roster/

## Setup

- `migrations/`: run each file in the Supabase SQL Editor, in date order, after roster-app's migrations.
- `supabase/functions/`: deploy with `supabase functions deploy <name>`. They use the same secrets as roster-app (`SUPABASE_SERVICE_ROLE_KEY`; `district-notify` also `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`). Each is one self-contained `index.ts`, so it can be pasted into the Supabase web editor. `district-notify` needs Verify JWT off (pg_cron calls it with its own secret).
- Supabase Auth → URL Configuration → Redirect URLs must include `https://ruralroster.github.io/district-roster/*`.
- Local: copy `.env.example` to `.env`, then `npm install` and `npm run dev`.
- Deploys to GitHub Pages on every push to `main`. It needs the repo secrets `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, and the repo variable `VITE_VAPID_PUBLIC_KEY` (roster-app's public push key).

## Who can do what

- **Super admin** (`profiles.is_super_admin`): creates districts and sites, links sites to roster-app departments, adds site officers.
- **Site officer**: officers of the linked roster-app department, plus anyone added to the site. Invites, edits and deactivates the district's doctors.
- **District doctor**: sees their district's sites and doctors and edits their own profile (home site, skills, contact, notifications).
