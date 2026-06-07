# PerformanceXtra — Mental Workout Repository

A single-page, **static** web app that consolidates PerformanceXtra's mental-performance
training resources into one tagged, searchable repository — with a workout builder,
per-student completion tracking, and a **coach (admin) / student split**. No backend, no
build step: it's one self-contained `index.html` that runs anywhere (open it directly, or
host it on any static server).

## Two views: coach and student

The app opens in the **student view** by default. A coach unlocks the **admin tools** with a
passcode (top-right **Admin login**).

- **Coach / admin** can: browse the repository, build workouts, **assign** activities and
  workouts to specific students, **add** their own custom activities, **edit or hide** any
  activity, manage students, and change the passcode.
- **Students** see only their own assigned workouts, the repository (to browse and mark
  things done), and their progress. They can't assign, add, edit, or manage anything.

The coach can hit **Student view** to preview exactly what an athlete sees (one click back to
admin), or **Log out** to lock the device down to the student view before handing it over.

> **Default passcode:** `pxadmin`. Change it from **Settings → Admin passcode** before
> sharing the site.
>
> **Security note:** the site is fully static, so the passcode gate is enforced *in the
> browser*. That keeps students out of the coach tools, but it is **not** server-enforced
> security — a determined, technical user could bypass a client-side gate. For true
> account-level access control you'd need a backend.

## What it does

- **Repository** — browse all activities. Search by name/topic/subtopic and filter by Topic,
  Subtopic, Content Type, Progression (Week 1–17 / Extra), and Frequency. Each card shows its
  tags and time, links to the resource, and expands to show instructions and reflection
  prompts. Coaches also get per-card **Edit / Hide / Assign** controls and an **+ Add
  activity** button.
- **Workout Builder** *(coach)* — assemble a session from criteria like *“Month 1,
  Confidence.”* Choose a progression scope (any / month / week / extra), topic, content type,
  how many activities, and an optional time budget. Optionally exclude activities the active
  student already completed. Print, copy, download, or **Assign to a student**.
- **Students** *(coach)* — create student profiles, build **assignments** (a titled set of
  activities with an optional note), and track per-student progress (overall %, by topic, by
  progression).
- **My Workouts** *(student)* — the activities the coach assigned, with a progress bar per
  assignment and a **Mark done** button on each item.

> **Storage note:** all coaching data (students, assignments, custom activities, the passcode
> hash) is saved in the browser's `localStorage` — it lives on the device/browser that
> recorded it and is **not** shared across computers. Use the **Export / Import JSON** buttons
> (Settings tab) to back it up or move it. Existing v1 student tracking is migrated forward
> automatically.

## Project structure

```
index.html                       # the entire app (HTML + CSS + JS + embedded data)
.nojekyll                        # tells GitHub Pages to serve files as-is
.github/workflows/deploy-pages.yml  # CI that publishes the site to GitHub Pages
build/
  generate_data.py               # regenerates the embedded data from the spreadsheet
  PerformanceXtra_Master_Sheet.xlsx  # source spreadsheet (dev-only, not served)
```

## Run it locally

Just open `index.html` in a browser (double-click works — the data is embedded, so there's
no `fetch`/CORS issue under `file://`). To serve it like production:

```bash
python3 -m http.server   # then visit http://localhost:8000
```

## Update the activities

The activity data and filter taxonomy are generated from the spreadsheet and embedded into
`index.html` between marker comments. After editing `build/PerformanceXtra_Master_Sheet.xlsx`:

```bash
pip install openpyxl
python3 build/generate_data.py
```

The script reads the **Master Repository** and **Dropdown Options** sheets, prefers each
cell's hyperlink target over its display text, derives week/month/time fields, and rewrites
the embedded JSON. It prints a summary (e.g. `Activities: 190`) so you can sanity-check.

## Deploy to GitHub Pages

1. Push to `main` (or merge the PR).
2. In the repo: **Settings → Pages → Build and deployment → Source: “GitHub Actions.”**
3. The included workflow (`.github/workflows/deploy-pages.yml`) builds and publishes on every
   push to `main`; the live URL appears in the workflow run. You can also trigger it manually
   from the **Actions** tab (“Run workflow”).

The site is plain static files, so it works equally well on Netlify, Cloudflare Pages, Vercel,
or any static host — point them at the repo root with no build command.
