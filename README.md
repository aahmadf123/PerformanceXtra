# PerformanceXtra — Mental Workout Repository

A web app that consolidates PerformanceXtra's mental-performance training resources
into one tagged, searchable repository — with assignment building, per-athlete completion
tracking, and **super-admin / admin / coach / athlete** roles.

It runs against a **Cloudflare Worker + D1 database**: a super admin creates coach accounts,
coaches manage their own athletes, everyone has **real accounts**, data is **shared across
every device**, and roles are **enforced on the server** — an athlete can't become a coach by
poking at the browser.

The app is **login-first**: opening the link shows a sign-in screen. After signing in, a
coach lands on their coaching tools and an athlete lands on their own workouts — nothing
else is shown until you authenticate.

The app boots by probing `GET /api/me`. If the Cloudflare backend answers, it runs normally.
If the backend is unreachable (e.g. the file is opened directly with no Worker running), it
still shows the sign-in screen, with a notice that the server is unavailable.

## Project structure

```
index.html              # markup only (loads styles.css, data.js, app.js)
styles.css              # all styles
app.js                  # the whole app (one IIFE; no build step)
data.js                 # generated dataset: window.PX_DATA + window.PX_TAXONOMY
worker.js               # Cloudflare Worker entrypoint (serves assets + API)
functions/api/[[route]].js  # API logic used by the Worker entrypoint
db/schema.sql           # D1 schema (kept for version control / reproducibility)
wrangler.toml           # Worker config + asset + D1 binding
build/
  generate_data.py      # regenerates data.js from the spreadsheet
  PerformanceXtra_Master_Sheet.xlsx  # source spreadsheet (dev-only, not served)
```

## Roles: super admin, admin, coach, athlete

A strict ladder — **coach < admin < super admin** — where each higher tier can do everything
the one below it can, plus more. All three sign in to the same tabbed app; the tab set grows
with the role.

- **Coach** can: browse the repository, build & **assign** workouts to specific athletes,
  **add** custom activities, **edit or hide** any activity, manage athletes, manage their
  **own** private content (Content tab), and export rosters/assignments.
- **Admin** can do everything a coach can, **plus create and manage coach accounts** (from the
  **Team** tab). Admins work in their **own** private content only — the shared **global
  library** and the site's **Appearance** are super-admin-only.
- **Super admin** can do everything an admin can, **plus**: **create and manage admins and
  other super admins** (alongside coaches, all from the **Team** tab); curate the **global
  content library** — a shared set of activities and taxonomy that every coach and athlete sees,
  edited from the Content tab's **Global library** scope; and control the site's **Appearance** —
  a built-in CMS to change colors, fonts and sizes (saved to the database and applied site-wide)
  and build the landing page from drag-ordered content blocks (hero, heading, text, image,
  cards, button, spacer). The production super admin is seeded by a migration (see Deploy).

Internally, admin and super admin are flag columns (`is_admin` / `is_superadmin`) on a
`role='coach'` row — the FK-referenced `role` column is never changed (see `db/schema.sql`).

### Adding coaches, admins & super admins

An **admin or super admin** adds a coach by **name + email** from the **Team** tab; a **super
admin** adds admins and other super admins from that same **Team** tab. In every case the server
generates a one-time passcode, shown **once**; you send the person their email + passcode, they
sign in, and can change their password in Settings. A creator can never mint an account **above**
their own role. **Reset passcode** on any row issues a fresh one if it's lost.

### Adding athletes

A coach adds an athlete by **name + email**. The server **generates a random passcode**,
stores only its hash, and returns the passcode to the coach **once** — with a one-click
“Email them” button (prefilled `mailto:`) and a copy button. The coach sends the athlete
their **email + passcode**; the athlete signs in with those and lands on **My Workouts**.
There's no shared passcode to leak and no link to set a password. If a passcode is lost,
the coach uses **Reset passcode** on the athlete's row to issue a fresh one.

## What it does

- **Repository** — browse all activities. Search by name/topic/subtopic and filter by Topic,
  Subtopic, Content Type, Progression (Week 1–17 / Extra), and Frequency. The Topic, Subtopic
  and Content Type lists are **alphabetical**, and picking a Topic narrows the Subtopic list to
  only those that exist under it (no dead-end searches). Each card shows its tags and time,
  links to the resource, and expands to show instructions and reflection prompts. Coaches also
  get per-card **Edit / Hide / Assign** controls and **+ Add activity**.
- **Students** *(coach)* — manage athletes, build **assignments** (a titled set of
  activities with an optional note) — picking activities by hand or with the built-in
  **Generate by criteria** helper that auto-assembles a balanced set from the library —
  set an optional **due date** per assignment, see a **Needs attention** overview (overdue work,
  a stale check-in, a low recent mood, or unread messages), save any assignment as a reusable
  **template** and **bulk-assign** one template to several athletes at once, see at-a-glance
  per-athlete **completion % + streak** on the roster, track per-athlete progress, and
  **export the roster to
  CSV** or a single assignment to a printable PDF. Progress is measured **out of what's assigned**
  to each athlete. Assignment notes support **clickable links** — both bare URLs and
  `[label](https://…)` markdown — and any activity can be given a **student-level custom link**
  (e.g. a doc in that athlete's private folder): set it once per student and it overrides the
  activity's default link for that student across **every** assignment.
- **Content** *(coach / admin / super admin)* — a built-in CMS to manage the activity library
  **and** the Topic / Subtopic / Content-type vocabularies entirely in-app: add, edit, hide, or
  delete activities, and add / rename / merge / remove taxonomy values (renames cascade across
  every activity). Coaches and admins edit their **own private** content; **super admins** get a
  **Global library** scope switch to edit the shared library every coach/athlete sees (the
  switch loads a global-only view, so a super admin's private items never leak into the shared
  library). Each coach still sees the global library **merged** with their own private items, and
  a coach's private edit always wins over the global one. Everything is stored in D1, so it
  survives redeploys — no spreadsheet edit or developer needed.
- **Appearance** *(super admin)* — change the site's **colors, fonts, text size, spacing and
  corner radius** (mapped to the CSS variables in `styles.css`, saved to D1 and applied
  site-wide for everyone, including the signed-out login page), and a **page builder** to
  assemble the landing page from ordered content blocks with a live preview and draft/publish.
  Block text renders as plain text and links are forced to `https://`, so builder content can't
  inject script.
- **My Workouts** *(athlete)* — assigned activities with a progress bar, inline instructions,
  and a **Mark done** button on each item. Assignments with a **due date** show an **Overdue** or
  **Due soon** badge so nothing is missed.
- **Check-in** *(athlete)* — a calm daily **mood / energy / stress** check-in (each 1–5, plus an
  optional note), a running **streak**, and a free-form **journal**. It's deliberately low-pressure
  and supportive — a mindset tool, not a clinical form. The coach sees it read-only in a per-athlete
  **Wellbeing** panel (recent check-ins, 14-day averages, streak, and journal entries), so patterns
  surface without anyone exchanging emails.
- **Messages** *(coach ↔ athlete)* — a direct in-app thread per athlete: the athlete gets a
  **Messages** tab (with an unread count), the coach gets a thread plus a **private note** (never
  shown to the athlete) in the Students detail. Unread counts surface on the athlete's tab and on
  each coach roster row. It's **in-app only — no email/SMS is sent** (see *Notifications* below);
  this replaces the email/text back-and-forth that used to live outside the app.
- **Onboarding tour** — a `?` button in the header launches a short guided tour; it also runs
  automatically the first time a coach or athlete signs in.

## Run it locally

The app needs its backend to sign in, so run the Worker + D1 + assets locally:

```bash
npm install
npm run dev               # serves the Worker + assets + /api/*
```

Opening `index.html` directly (no Worker) still shows the sign-in screen, but it can't
authenticate — it just displays a “server unavailable” notice.

### First-run setup

The production **super-admin** account is created by applying the seed migration
(`db/migrations/0004_seed_superadmin.sql`) — see Deploy. Sign in with those credentials and
**change the password immediately** in Settings. The super admin then creates coach accounts,
and each coach adds their own athletes (email + one-time passcode).

If the seed was never applied and **no super admin exists**, the sign-in screen shows a
**“Create the admin account”** link so the first visitor can bootstrap one. No credentials are
hard-coded or shown on the page.

## Update the activities

The dataset is generated from the spreadsheet into `data.js`. After editing
`build/PerformanceXtra_Master_Sheet.xlsx`:

```bash
pip install openpyxl
python3 build/generate_data.py
```

It reads the **Master Repository** and **Dropdown Options** sheets, prefers each cell's
hyperlink target over its display text, derives week/month/time fields, drops subtopics that
merely repeat the topic (so the Topic and Subtopic filters stay unambiguous), and rewrites the
JSON in `data.js` between marker comments. It prints a summary (e.g. `Activities: 190`).

## Deploy to Cloudflare Workers

1. In Cloudflare → **Workers & Pages → Create → Worker → Connect to Git**, select this repo
  and branch `main`. Use the Wrangler config in `wrangler.toml`.
2. The D1 database `performancextra` is bound as `DB` via `wrangler.toml`. Apply the schema
   once (already applied to the live DB; safe to re-run):

   ```bash
   wrangler d1 execute performancextra --file db/schema.sql --remote
   ```

   On an **existing** database, also apply the incremental migrations in order (the app
   degrades gracefully until they're applied):

   ```bash
   wrangler d1 execute performancextra --file db/migrations/0001_assignment_item_custom_url.sql --remote
   wrangler d1 execute performancextra --file db/migrations/0002_taxonomy.sql --remote
   wrangler d1 execute performancextra --file db/migrations/0003_superadmin_role.sql --remote
   wrangler d1 execute performancextra --file db/migrations/0004_seed_superadmin.sql --remote
   wrangler d1 execute performancextra --file db/migrations/0005_student_activity_links.sql --remote
   wrangler d1 execute performancextra --file db/migrations/0006_admin_role.sql --remote
   wrangler d1 execute performancextra --file db/migrations/0007_site_builder.sql --remote
   wrangler d1 execute performancextra --file db/migrations/0008_checkins_journal.sql --remote
   wrangler d1 execute performancextra --file db/migrations/0009_messages.sql --remote
   wrangler d1 execute performancextra --file db/migrations/0010_assignment_templates.sql --remote
   ```

   `0003` adds the super-admin role, `0004` seeds the super-admin login (email
   `firas.azfar@gmail.com`, password `PXtra-SuperAdmin-2026!` — **change it after first
   sign-in**; edit the migration first if you want different credentials), `0005` moves
   custom links to the student level, `0006` adds the **admin** tier plus the global-library
   owner row, `0007` adds the **Appearance** CMS tables (`site_settings`, `pages`), `0008`
   adds the **check-in** + **journal** tables (`checkins`, `journal_entries`), `0009` adds the
   **messaging** tables (`messages`, `athlete_notes`), and `0010` adds the **assignment_templates**
   table.
   Validate the role migrations against a local copy (`--local`) first.
3. In **Worker → Settings → Environment variables**, set `SESSION_SECRET` to a long random
   string (used to sign session cookies). **Do not commit it.**
  If unset, the app auto-provisions a strong random secret once and stores it in D1, so
  sign-in still works securely — but setting your own `SESSION_SECRET` is recommended for
  production so the secret is under your control and survives a database reset.
4. Push to `main` → Cloudflare builds and deploys the Worker. Sign in as the seeded super
  admin, change the password, then create coach accounts; each coach adds their own athletes,
  who sign in with the email + passcode the coach sends them.

> Because the site, API and database share **one origin**, sessions are first-party cookies
> and there's **no CORS** to configure.

### Notifications (in-app only — no email yet)

Everything that "notifies" — unread message counts, the wellbeing panel, and the
scheduling/overdue cues — is **surfaced inside the app**; the project sends **no email or SMS**.
That's deliberate: it keeps the app dependency-free (no domain, no Resend/SMTP key, no DKIM/SPF
setup). When you're ready to add real notifications, the data is already shaped for it:

- **Unread messages** are rows in `messages` with `read_at IS NULL` — query them per athlete/coach.
- **Overdue work** is any `assignments.due_at` in the past without completions for the athlete.

A future developer can add a scheduled Worker (Cron Trigger) that reads those and calls an email
provider — no schema change required. Nothing in the current code path makes an outbound email call.

### Security model

- Roles come **only** from the signed, HTTP-only session cookie — never from the request body.
- A coach can only read/write their own rows (or athletes whose `coach_id` is theirs); an
  athlete can only read their own assignments and write their own completions. Messages and the
  coach-private note are scoped to the coach↔athlete pair; the private note is never sent to the
  athlete's own bootstrap.
- Passwords are hashed with PBKDF2 (WebCrypto). Session cookies are JWT (HS256), `HttpOnly`,
  `Secure`, `SameSite=Lax`.
