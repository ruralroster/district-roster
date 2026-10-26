// The Help tab: how DR Roster works, in plain English, for each kind of
// user. Keep it in step with the app when a feature changes; it's the only
// place DR Roster explains itself (roster-app's own help covers the
// roster-app side of escalation and visitors).

function Section({ title, open = false, children }) {
  return (
    <details className="help-section" open={open}>
      <summary>{title}</summary>
      <div className="help-body">{children}</div>
    </details>
  );
}

export default function Help({ isDoctor, isOfficer, isSuperAdmin }) {
  return (
    <div className="stack">
      <div className="card">
        <h2>Help</h2>
        <p className="muted">
          DR Roster is the district's shift board: sites post shifts they can't fill locally, and district doctors
          pick them up. It shares logins with roster-app. Tap a section to open it.
        </p>
      </div>

      <div className="card">
        <h3>Everyone</h3>
        <Section title="Signing in and two-factor" open={!isDoctor && !isOfficer && !isSuperAdmin}>
          <ul>
            <li>You're invited by email: the link takes you to a page to set your password. If you already use roster-app, it's the same login and password.</li>
            <li>Two-factor (a 6-digit code from an authenticator app) is under <strong>My profile</strong> or <strong>My account</strong>. It's the same setting as roster-app, so turning it on in one turns it on in both.</li>
            <li>Forgotten your password? Use <strong>Forgot password</strong> on the sign-in page.</li>
          </ul>
        </Section>
        <Section title="Putting DR Roster on your phone">
          <ul>
            <li><strong>iPhone</strong>: open the site in Safari, tap Share, then <strong>Add to Home Screen</strong>. Phone notifications only work once you've done this.</li>
            <li><strong>Android</strong>: open it in Chrome, tap the menu, then <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li>
            <li>It opens like an app, called DR Roster.</li>
          </ul>
        </Section>
        <Section title="Notifications">
          <ul>
            <li>You get emails, and phone notifications on any device you turn them on for under <strong>Notifications on this device</strong>. <strong>Send me a test</strong> checks it's working.</li>
            <li>DR Roster checks for news every 30 minutes from 6:00 to 21:00, so nothing arrives overnight.</li>
            <li>Email and phone notifications can each be turned off in your profile.</li>
          </ul>
        </Section>
        <Section title="Site colours">
          <p>Each site has its own colour, used for the dots on Calendar days, the stripe beside each shift and on the Sites tab. The key under the Calendar says which is which.</p>
        </Section>
      </div>

      {isDoctor && (
        <div className="card">
          <h3>Doctors</h3>
          <Section title="Your profile: level, skills and sites" open>
            <ul>
              <li><strong>Level</strong>: consultant, advanced trainee, registrar, RMO or intern. You see shifts at your level and below. An advanced trainee sees consultant shifts like a consultant.</li>
              <li><strong>Skills</strong>: Emergency (everyone), plus Anaesthetics, O&amp;G and Endoscopy. A shift that needs a skill only shows if you hold it.</li>
              <li><strong>Sites I'd work at</strong>: you only see, and are only told about, shifts at the sites you tick.</li>
              <li><strong>Home site</strong>: your primary site. It matters for the rest rule below.</li>
            </ul>
          </Section>
          <Section title="Which shifts you see">
            <p>The Calendar's <strong>Shifts for me</strong> only shows open shifts you can actually do:</p>
            <ul>
              <li>at a site you'd work at, at or below your level, and needing a skill you hold;</li>
              <li><strong>10 hours' rest</strong>: it starts at least 10 hours after any shift you're working (roster-app or DR Roster, not on-call), and finishes at least 10 hours before a shift at your home site or on your roster-app roster;</li>
              <li>not on a day that's blocked (next section).</li>
            </ul>
            <p>Shifts you've applied for or are booked on always show.</p>
          </Section>
          <Section title="Calendar colours">
            <ul>
              <li><span className="help-swatch cal-available" /> <strong>Blue</strong>: shifts you can apply for (the number is how many).</li>
              <li><span className="help-swatch cal-applied" /> <strong>Amber</strong>: you've applied.</li>
              <li><span className="help-swatch cal-booked" /> <strong>Green</strong>: you're booked.</li>
              <li><span className="help-swatch cal-working" /> <strong>Slate</strong>: you're working: rostered on roster-app, or marked working elsewhere there. A short roster-app shift can still leave room for a district one, which then shows blue instead.</li>
              <li><span className="help-swatch cal-off" /> <strong>Grey, struck through</strong>: you've marked the day not available here.</li>
              <li><span className="help-swatch cal-none" /> <strong>White</strong>: nothing for you.</li>
            </ul>
            <p>Tap a day to see its shifts and why it's coloured that way.</p>
          </Section>
          <Section title="Days you can't work">
            <ul>
              <li>Tap a day, then <strong>I'm not available this day</strong>. Its shifts are hidden and you're not told about new ones. Tap <strong>I'm available after all</strong> to undo it.</li>
              <li>On roster-app's availability calendar, a <strong>dark grey</strong> day (unavailable, working elsewhere) blocks the day here too.</li>
              <li>A <strong>red</strong> roster-app day (leave, a day off) doesn't: you might want to pick up a shift while you're off. The day says so when you tap it.</li>
              <li>A night shift is blocked if the morning it runs into is blocked.</li>
            </ul>
          </Section>
          <Section title="Applying, and what happens next">
            <ol>
              <li>Tap the day, then <strong>Apply</strong> on the shift. You can add a note for the officer.</li>
              <li>The site's officers are told. You can <strong>Withdraw</strong> while it's waiting.</li>
              <li>You're emailed (and notified) when you're approved or declined, or if the shift is later cancelled or given to someone else.</li>
              <li>If the shift came from roster-app, approving puts you on that roster-app card: as an ordinary booking if you're staff there, or as a visitor marked "From DR Roster".</li>
            </ol>
            <p>If applying says no, the message says why: a clash, the rest rule, your level or skills, or a blocked day.</p>
          </Section>
        </div>
      )}

      {isOfficer && (
        <div className="card">
          <h3>Rostering officers</h3>
          <Section title="Your Calendar" open={!isDoctor}>
            <ul>
              <li><strong>My sites</strong> shows your sites' shifts: <strong>red</strong> days have an open shift, <strong>green</strong> ones are all filled. If you're also a district doctor, switch to <strong>Shifts for me</strong> at the top.</li>
              <li>Tap a day to see its shifts, who's applied, and to fill, reopen or cancel them.</li>
            </ul>
          </Section>
          <Section title="Posting shifts">
            <ul>
              <li><strong>Post a shift</strong>: pick the site and a shift type (it fills in the times and skill), the date, the <strong>position</strong> (consultant, registrar, RMO or intern) and any notes. A finish earlier than the start runs into the next day; the same as the start is 24 hours.</li>
              <li><strong>Add several shifts</strong>: paste a message (email, WhatsApp) and DR Roster reads the dates, shift types and positions out of it. "reg" or "PHO" means a registrar shift, "intern" an intern one, and "RMO", "junior", "JHO", "SHO" or "resident" an RMO one; anything else is a consultant shift. Or upload a spreadsheet with a tab per site and Date and Shift columns (Start, Finish and Position optional). Check the preview, untick anything wrong, then post.</li>
              <li>Shifts you post go to the district straight away. Shifts already posted are marked so you don't post them twice.</li>
            </ul>
          </Section>
          <Section title="Applicants: approving, declining, filling">
            <ul>
              <li>Each applicant shows their level and note. <strong>Approve</strong> books them; everyone else who applied is told it's been filled. <strong>Decline</strong> asks for an optional reason for them.</li>
              <li>For a consultant shift from a roster-app card, DR Roster says which skill the card's consultant needs, and whether each applicant holds it on roster-app. You can still approve someone it can't confirm; you're asked first.</li>
              <li><strong>Mark filled by…</strong> books a doctor directly, without an application. <strong>Reopen</strong> puts a filled shift back up; <strong>Cancel</strong> takes it down and tells anyone involved.</li>
              <li>You're emailed (and notified) when someone applies or withdraws.</li>
            </ul>
          </Section>
          <Section title="Gaps from roster-app">
            <ul>
              <li>At a site linked to roster-app, a shift offered for volunteering there that nobody local takes comes here as an open district shift, titled e.g. "ED Day (Consultant)".</li>
              <li>It comes up after the site's <strong>keep local</strong> time (Sites tab, 72 hours by default), or straight away if the shift starts sooner. Only roster-app's volunteering offers come up, never other empty places.</li>
              <li>Its position matches the offer. A consultant shift needs the card's consultant skill; registrar and lower ones are open to any doctor at that level or above.</li>
              <li>If it's then covered on roster-app, or the offer's withdrawn, it's cancelled here.</li>
              <li>When it's filled here, the doctor goes onto the roster-app card by themselves and the offer comes off. The shift's notes say how ("On the roster-app card"). Reopening or cancelling takes them off the card again.</li>
              <li>If you've already posted the same shift here (same site, date and hours), the roster-app offer is linked to yours instead of posting a second copy.</li>
            </ul>
          </Section>
          <Section title="Sites and doctors">
            <ul>
              <li><strong>Sites</strong>: add and remove each site's shift types, and set how long gaps stay local before coming here.</li>
              <li><strong>Doctors</strong>: invite doctors, set their level, and deactivate anyone who's left.</li>
            </ul>
          </Section>
        </div>
      )}

      {isSuperAdmin && (
        <div className="card">
          <h3>Super admin</h3>
          <Section title="Districts, sites and officers">
            <ul>
              <li>The <strong>Admin</strong> tab creates districts and sites, links a site to its roster-app department (so its officers are officers here and its gaps can come up), and adds site officers.</li>
              <li>You can see every district and site.</li>
            </ul>
          </Section>
          <Section title="Importing from v3">
            <ul>
              <li><strong>Import from v3</strong> reads the v3 roster sheet export: people (doctors and officers, with their real email addresses), shift types and vacancies from today on. TestHub, Cairns and Telehealth are left out.</li>
              <li>Check the preview: guessed emails are marked. Nobody is emailed an invite by the import.</li>
              <li>Doctors start as consultants with the skills from v3; set their levels on the Doctors tab.</li>
            </ul>
          </Section>
        </div>
      )}
    </div>
  );
}
