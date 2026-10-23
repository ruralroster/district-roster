import { SKILLS } from './supabase';

// Emergency is always held (v3's rule), so it's shown ticked and locked.
export default function SkillPicker({ value, onChange }) {
  return (
    <div className="checks">
      {SKILLS.map((skill) => (
        <label key={skill} className="check">
          <input
            type="checkbox"
            checked={skill === 'Emergency' || value.includes(skill)}
            disabled={skill === 'Emergency'}
            onChange={(e) => {
              const others = value.filter((s) => s !== skill && s !== 'Emergency');
              onChange(['Emergency', ...(e.target.checked ? [...others, skill] : others)]);
            }}
          />
          {skill}
        </label>
      ))}
    </div>
  );
}
