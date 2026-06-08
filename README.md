# PerformanceXtra — Mental Workout Repository

A web app that consolidates PerformanceXtra's mental-performance training resources
into one tagged, searchable repository — with a workout builder, per-athlete completion
tracking, and a **coach / athlete split**.

It runs in **two modes from the same code**:

- **Shared mode (Cloudflare Worker):** hosted on a Cloudflare Worker with static assets,
  an API route, and a D1 database. Coaches and athletes have **real accounts**, data is
  **shared across every device**, and roles are **enforced on the server** — an athlete
  can't become a coach by poking at the browser.
- **Offline mode (static):** open `index.html` directly (or on any static host) with no
  backend. Data lives in `localStorage` on that device and a client passcode gates the coach
  tools. This is the original behaviour, kept as a fallback/demo.

The app auto-detects which mode to use: on boot it probes `GET /api/me`. If a Cloudflare
backend answers, it runs in shared mode; otherwise it falls back to offline mode.

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

### Adding athletes (shared mode)

A coach adds an athlete by name + email and gets a **private invite link**. The athlete opens
it, sets their own password, and lands on **My Workouts**. There's no shared passcode to leak,
and each athlete only ever sees their own work.

## What it does

- **Repository** — browse all activities. Search by name/topic/subtopic and filter by Topic,
  Subtopic, Content Type, Progression (Week 1–17 / Extra), and Frequency. Each card shows its
  tags and time, links to the resource, and expands to show instructions and reflection
  prompts. Coaches also get per-card **Edit / Hide / Assign** controls and **+ Add activity**.
- **Workout Builder** *(coach)* — assemble a session from criteria like *“Month 1,
  Confidence.”* Print, copy, download, or **Assign to an athlete**.
- **Students** *(coach)* — manage athletes, build **assignments** (a titled set of
  activities with an optional note), track per-athlete progress, and **export the roster to
  CSV** or a single assignment to a printable PDF.
- **My Workouts** *(athlete)* — assigned activities with a progress bar, inline instructions,
  and a **Mark done** button on each item.
- **Onboarding tour** — a `?` button in the header launches a short guided tour; it also runs
  automatically the first time a coach or athlete signs in.

## Run it locally

Offline (no backend): just open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server   # then visit http://localhost:8000
```

With the full backend (Worker + D1 + assets) locally:

```bash
npm install
npm run dev               # serves the Worker + assets + /api/*
```

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
3. In **Worker → Settings → Environment variables**, set `SESSION_SECRET` to a long random
   string (used to sign session cookies). **Do not commit it.**
4. Push to `main` → Cloudflare builds and deploys the Worker. The first visitor creates the
  head-coach account; everyone else joins by invite.

> Because the site, API and database share **one origin**, sessions are first-party cookies
> and there's **no CORS** to configure.

### Security model

- Roles come **only** from the signed, HTTP-only session cookie — never from the request body.
- A coach can only read/write their own rows (or athletes whose `coach_id` is theirs); an
  athlete can only read their own assignments and write their own completions.
- Passwords are hashed with PBKDF2 (WebCrypto). Session cookies are JWT (HS256), `HttpOnly`,
  `Secure`, `SameSite=Lax`.
