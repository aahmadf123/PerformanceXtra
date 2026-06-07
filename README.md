# PerformanceXtra — Mental Workout Repository

A single-page, **static** web app that consolidates PerformanceXtra's mental-performance
training resources into one tagged, searchable repository — with a workout builder and
per-student completion tracking. No backend, no build step: it's one self-contained
`index.html` that runs anywhere (open it directly, or host it on any static server).

## What it does

- **Repository** — browse all 190 activities. Search by name/topic/subtopic and filter by
  Topic, Subtopic, Content Type, Progression (Week 1–17 / Extra), and Frequency. Each card
  shows its tags and time, links to the resource, and expands to show instructions and
  reflection prompts.
- **Workout Builder** — assemble a session from criteria like *“Month 1, Confidence.”* Choose
  a progression scope (any / month / week / extra), topic, content type, how many activities,
  and an optional time budget. Optionally exclude activities the active student already
  completed. Print, copy, or download the workout as text.
- **My Students** — create student profiles and mark activities complete to avoid assigning
  the same thing twice. See per-student progress (overall %, by topic, by progression).

> **Storage note:** student tracking is saved in the browser's `localStorage` — it lives on
> the device/browser that recorded it and is **not** shared across computers. Use the
> **Export / Import JSON** buttons (My Students tab) to back it up or move it.

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
