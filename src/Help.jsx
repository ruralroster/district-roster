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
            <li>DR Roster checks for news every 30 minutes from 6:00 to 21:00, so nothing arrives overnight. Each thing is only sent once.</li>
            <li><strong>New shifts</strong>: a shift posted on DR Roster is sent once, straight away, to the doctors who can do it at the sites they'd work at. Shifts passed on from a roster-app card nobody locally took aren't sent one by one.</li>
            <li><strong>Monday summary</strong>: every Monday at 9:00, doctors get one email listing all the open shifts over the next 6 weeks they can do at the sites they'd work at (not ones they've already applied for). Nothing is sent if there aren't any.</li>
            <li>Email and phone notifications can each be turned off in your profile.</li>
          </ul>
        </Section>
        <Section title="Site colours">
          <p>Each site has its own colour, used for the dots on Calendar days, the stripe beside each shift and on the Sites tab. The key under the Calendar says which is which. A site's officers can choose its colour on the Sites tab; otherwise one is picked automatically.</p>
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
            <p><strong>Look across sites</strong> starts ticked, showing every site you'd work at; untick it to see only your home site's shifts. (Swaps are the other way round: your own site unless you tick it.) Shifts you've applied for or are booked on always show.</p>
          </Section>
          <Section title="Calendar colours">
            <ul>
              <li><span className="help-swatch cal-available" /> <strong>The site's colour</strong>: shifts you can apply for (the number is how many). Shifts at more than one site that day make it striped in each site's colour.</li>
              <li><span className="help-swatch cal-applied" /> <strong>Amber</strong>: you've applied.</li>
              <li><span className="help-swatch cal-booked" /> <strong>Green</strong>: you're booked.</li>
              <li><span className="help-swatch cal-working" /> <strong>Pale grey</strong>: you're working: rostered on roster-app, or marked working elsewhere there. A short roster-app shift can still leave room for a district one, which then shows in the site's colour instead.</li>
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
          <Section title="Swapping a shift">
            <p>The idea: the two doctors find a pairing that works for both of them on the marketplace, and the rostering officer approves it. Until then you still work your shift, so the site never loses cover.</p>
            <ol>
              <li><strong>List it.</strong> On the <strong>Swaps</strong> tab, <strong>My shifts</strong> has every shift you work: DR Roster shifts you've been approved for and, if you're on roster-app, your roster there. Switch between <strong>List</strong> and <strong>Calendar</strong> (tap a day to see its shifts). Tap <strong>List for swap</strong> on the shift. Roster-app's <strong>Variation → Swap a shift (DR Roster)</strong> does the same. Tick <strong>Service disruption</strong> if the shift goes uncovered when nobody takes it, and tick the days or nights of that pay fortnight you could work in return (at least one). A swap is always one shift for one shift: nobody can reduce their shifts in a fortnight, as that would change their FTE. To pick up extra shifts, apply for open ones on the Calendar. It's on the marketplace straight away.</li>
              <li><strong>Find a pairing.</strong> Only doctors who could close the loop are told, and <strong>Up for swap</strong> only shows them swaps they could do. They choose <strong>Swap for one of mine</strong>: one of their own shifts (DR Roster or roster-app) at the same site, on a day or night you said you could work, so the swap stays in the pay fortnight. Only shifts that pass the rules for both of you are offered: level, skills, blocked days and the 10-hour rest rule, each as if you'd already given up your own shift.</li>
              <li><strong>Or start from your own shift.</strong> Under <strong>My shifts</strong>, <strong>Find a swap</strong> checks everything already up for swap and lists the ones you could trade that shift for straight away: on one of their days, with both of you passing the rules. The number on the button is how many. Tap <strong>Offer swap</strong>; there's no need to list your own shift first.</li>
              <li><strong>Other sites.</strong> When listing, tick <strong>I'd take a shift in return at another site I'd work at</strong> if you'd go elsewhere. Doctors looking for a swap can then tick <strong>Look across sites</strong> on <strong>Up for swap</strong> or <strong>Find a swap</strong> (it's off by default, so they only see their own site): for example, give your Innisfail shift to an Atherton doctor who'll come to Innisfail, and do their Atherton shift. All the same rules apply to both of you, and it has to be a site each of you has ticked under Sites I'd work at. Both sites' officers approve it, since each is getting a different doctor; the swap happens on the second approval.</li>
              <li><strong>The officer approves.</strong> The offer goes to the site's rostering officer, who approves or declines it (with a reason). Only then do the bookings swap over, roster-app included, and you're both told.</li>
            </ol>
            <p>You can withdraw a listing or an offer until the officer decides.</p>
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
          <Section title="Swaps at your sites">
            <ul>
              <li>Doctors list shifts they can't do on the Swaps tab (or roster-app shifts from roster-app) and find a pairing among themselves: someone taking it, or swapping one of their own shifts at the same site in the same pay fortnight. You're told once there's an offer to decide.</li>
              <li>On the <strong>Swaps</strong> tab, each listing shows its offers. <strong>Approve</strong> checks the rules again and moves the bookings (roster-app too: to the doctor's own booking if they're staff there, otherwise as a visitor marked From DR Roster). <strong>Decline</strong> asks for an optional reason. Both doctors are told either way.</li>
              <li>Until you approve, the doctor who listed it still works it.</li>
              <li><strong>Take it off the swap list</strong> removes a listing, with an optional reason for the doctor. A listed shift that's reopened, cancelled, rebooked, or changed on roster-app comes off the list by itself.</li>
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
          <Section title="Locum might be required, urgent alerts and the weekly digest">
            <ul>
              <li>A district shift still open less than 3 weeks before it starts is marked <strong>Locum might be required</strong> on your Calendar.</li>
              <li>One still open with under 72 hours to go is emailed and pushed to you straight away.</li>
              <li>The <strong>weekly digest</strong> lists your sites' shifts still open over the next 6 weeks (locum might be required first) and swaps waiting for you. Choose its day(s) under My account; Monday unless you change it. It arrives from 7:00.</li>
            </ul>
          </Section>
          <Section title="Sites and doctors">
            <ul>
              <li><strong>Sites</strong>: add and remove each site's shift types, choose its colour, and set how long gaps stay local before coming here.</li>
              <li><strong>Doctors</strong>: invite doctors, set their level, and deactivate anyone who's left.</li>
              <li>People added without a login (e.g. by the v3 import) are marked <strong>Not invited yet</strong>. Tap <strong>Invite</strong> beside one, or <strong>Invite everyone not invited yet</strong> at the top, which covers officers waiting for a login too. Anyone who already has a login (e.g. roster-app) is linked without an email.</li>
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
              <li>Check the preview: guessed emails are marked. Nobody is emailed an invite by the import; send invites from the Doctors tab when you're ready.</li>
              <li>Doctors start as consultants with the skills from v3; set their levels on the Doctors tab.</li>
            </ul>
          </Section>
        </div>
      )}
    </div>
  );
}
