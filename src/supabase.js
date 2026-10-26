import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (see .env.example)');
}

// Read before supabase-js consumes the hash: invite and password-reset links
// land here signed in, and the person still has to choose a password.
export const arrivedToSetPassword = /type=(invite|recovery)/.test(window.location.hash);

export const supabase = createClient(url, anonKey);

// Where invite and reset emails send people back to. Must match the
// Redirect URLs entry https://ruralroster.github.io/district-roster/*
export const appUrl = window.location.origin + window.location.pathname;

export const SKILLS = ['Emergency', 'Anaesthetics', 'O&G', 'Endoscopy'];

// A district shift's level. Anything below consultant books the doctor
// onto a roster-app card as a registrar.
export const POSITIONS = ['consultant', 'registrar', 'rmo', 'intern'];
export const POSITION_LABEL = { consultant: 'Consultant', registrar: 'Registrar', rmo: 'RMO', intern: 'Intern' };

// A doctor's level: they see shifts at it or below, ranked consultant =
// advanced trainee > registrar > RMO > intern (district_level_rank).
export const LEVELS = ['consultant', 'advanced_trainee', 'registrar', 'rmo', 'intern'];
export const LEVEL_LABEL = { ...POSITION_LABEL, advanced_trainee: 'Advanced trainee' };
