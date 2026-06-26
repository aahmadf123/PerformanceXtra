# PerformanceXtra — Mental Workout Repository

A web app that consolidates PerformanceXtra's mental-performance training resources
into one tagged, searchable repository — with a workout builder, per-athlete completion
tracking, and a **coach / athlete split**.

It runs against a **Cloudflare Worker + D1 database**: coaches and athletes have **real
accounts**, data is **shared across every device**, and roles are **enforced on the
server** — an athlete can't become a coach by poking at the browser.

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

## Two views: coach and athlete

- **Coach** can: browse the repository, build workouts, **assign** activities to specific
  athletes, **add** custom activities, **edit or hide** any activity, manage athletes, and
  export rosters/assignments.
- **Athletes** see only their own assigned workouts (with instructions and reflection prompts
  inline), the repository, and their progress. They can't assign, add, edit, or manage
  anything.

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
- **Workout Builder** *(coach)* — assemble a session from criteria like *“Month 1,
  Confidence.”* Print, copy, download, or **Assign to an athlete**.
- **Students** *(coach)* — manage athletes, build **assignments** (a titled set of
  activities with an optional note), track per-athlete progress, and **export the roster to
  CSV** or a single assignment to a printable PDF. Progress is measured **out of what's assigned**
  to each athlete. URLs typed into an assignment note render as **clickable links**, and any
  assigned activity can be given a **per-student custom link** (e.g. a doc in that athlete's
  private folder) that overrides the activity's default link for that student only.
- **Content** *(coach)* — a built-in CMS to manage the activity library **and** the Topic /
  Subtopic / Content-type vocabularies entirely in-app: add, edit, hide, or delete activities,
  and add / rename / merge / remove taxonomy values (renames cascade across every activity).
  Everything is stored in D1, so it survives redeploys — no spreadsheet edit or developer needed.
- **My Workouts** *(athlete)* — assigned activities with a progress bar, inline instructions,
  and a **Mark done** button on each item.
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

### Default demo admin login

To make first-run access immediate, the API auto-creates one coach account if no coaches
exist yet:

- Email: `admin@performancextra.demo`
- Password: `Admin12345!`

You can override these per environment with Worker vars:

- `DEMO_COACH_NAME`
- `DEMO_COACH_EMAIL`
- `DEMO_COACH_PASSWORD`

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

   On an **existing** database, also apply the incremental migrations (the app degrades
   gracefully until they're applied — custom links and in-app taxonomy editing simply stay
   off):

   ```bash
   wrangler d1 execute performancextra --file db/migrations/0001_assignment_item_custom_url.sql --remote
   wrangler d1 execute performancextra --file db/migrations/0002_taxonomy.sql --remote
   ```
3. In **Worker → Settings → Environment variables**, set `SESSION_SECRET` to a long random
   string (used to sign session cookies). **Do not commit it.**
  If unset, the app now falls back to a built-in demo secret so shared links still work,
  but you should set your own `SESSION_SECRET` for real use.
4. Push to `main` → Cloudflare builds and deploys the Worker. The first visitor creates the
  head-coach account; the coach then adds athletes, who sign in with the email + passcode
  the coach emails them.

> Because the site, API and database share **one origin**, sessions are first-party cookies
> and there's **no CORS** to configure.

### Security model

- Roles come **only** from the signed, HTTP-only session cookie — never from the request body.
- A coach can only read/write their own rows (or athletes whose `coach_id` is theirs); an
  athlete can only read their own assignments and write their own completions.
- Passwords are hashed with PBKDF2 (WebCrypto). Session cookies are JWT (HS256), `HttpOnly`,
  `Secure`, `SameSite=Lax`.
