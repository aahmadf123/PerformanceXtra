# PerformanceXtra — Maintenance Guide

This guide is for whoever maintains the app next — a developer, or the owner working
with an AI coding assistant. It explains how the pieces fit together, how to make and
ship a change safely, and how to diagnose the failure modes we've already met.
Read `README.md` first for the feature tour; read `PRODUCT.md` and `DESIGN.md` before
changing anything user-facing.

## 1. What this app is (one paragraph)

A mental-performance training app for student athletes. The super admin assigns sets of
activities from a tagged library; athletes complete them, write reflections, do a
daily wellbeing check-in, and message the super admin. Everything runs on
**Cloudflare Workers + D1 (SQLite)** — no other services, no email, no third-party
trackers.

## 2. Architecture map

| File | Role |
|---|---|
| `index.html` | All markup. No build step — what you see is what ships. |
| `app.js` | The whole frontend (one IIFE, ~5k lines). Renders every view, talks to `/api/*`. |
| `styles.css` | All styles. Design tokens (colors/fonts/spacing) are CSS variables at the top; the super-admin Appearance tab overrides them at runtime. |
| `data.js` | **Generated** — the 190 base activities + taxonomy. Regenerate, never hand-edit. |
| `worker.js` | Cloudflare Worker entry: serves static assets, routes `/api/*` to the API. |
| `functions/api/[[route]].js` | The entire backend: routing, auth, sessions, every handler. |
| `db/schema.sql` | Reference schema for a FRESH database. The live DB is evolved by `db/migrations/*` instead. |
| `db/migrations/` | Numbered one-shot migrations, applied manually in order (see §5). |
| `db/seed_activities.sql` | Generated INSERTs for the 190 base activities (from `build/generate_seed.mjs`). |
| `build/` | Dev-only tooling: spreadsheet → `data.js` (`generate_data.py`), `data.js` → seed SQL (`generate_seed.mjs`), password hasher (`hash_password.mjs`). |
| `wrangler.toml` | Worker config + D1 binding. **Gotcha:** the database is named `performancextra`, the worker is `performance-xtra` — they are independent names. |

One origin serves the site, the API and the DB access, so sessions are first-party
cookies and there is no CORS anywhere.

## 3. Local development

```bash
npm install
npm run dev            # wrangler dev: serves assets + /api/* + a LOCAL D1
```

The local D1 starts empty. To make it usable:

```bash
npx wrangler d1 execute performancextra --file db/schema.sql --local
npx wrangler d1 execute performancextra --file db/seed_activities.sql --local
```

Then open the printed localhost URL and use the sign-in screen's
**"Create the admin account"** link (it appears because no super admin exists yet) to
bootstrap a local super admin. From there create a test athlete via the UI.

Quick syntax check without running anything:

```bash
node --check app.js
node -e "import('./functions/api/[[route]].js').then(()=>console.log('ok'))"
```

## 4. Shipping a change (the golden path)

1. Make the change on a branch.
2. `npm run dev`, walk through the affected flow as each relevant role
  (super admin / athlete). There is **no automated test suite** — the manual
   walkthrough *is* the test. Minimum smoke test: sign in as each role, open every tab,
   assign + complete + reflect on one activity.
3. If the change needs a schema change, write a **new numbered migration**
   (see §5) — never edit an already-applied migration except to redact secrets.
4. Open a PR into `main`. Merging to `main` auto-deploys via Cloudflare's Git
   integration.
5. **Apply migrations to production BEFORE merging code that depends on them**
   (the code is written to tolerate a missing column/table, but don't rely on it).

## 5. Database operations

**Always back up first:**

```bash
npx wrangler d1 export performancextra --remote --output backup-$(date +%F).sql
```

Apply a migration to production:

```bash
npx wrangler d1 execute performancextra --file db/migrations/00XX_name.sql --remote
```

Conventions used in this repo:

- Migrations are **applied manually, in order, exactly once** — there is no migration
  tracker table. Write them idempotently where SQLite allows (`CREATE TABLE IF NOT
  EXISTS`, `INSERT OR IGNORE`, `UPDATE OR IGNORE` + `DELETE` move-or-merge). An
  `ALTER TABLE ADD COLUMN` re-run fails with "duplicate column" — that error just
  means "already applied".
- `db/schema.sql` must be kept in sync by hand so a fresh database matches an evolved
  one. When you add a migration, mirror it there.
- To change a table's PRIMARY KEY (SQLite can't alter PKs): create `<table>_new`,
  `INSERT OR IGNORE ... SELECT` the data across, `DROP` the old, `RENAME` — see
  `0015_completions_per_assignment.sql` for the pattern.
- Ad-hoc queries: `npx wrangler d1 execute performancextra --remote --command "SELECT ..."`.

## 6. Content pipeline (the spreadsheet)

The 190 base activities come from `build/PerformanceXtra_Master_Sheet.xlsx`:

```
spreadsheet ──python3 build/generate_data.py──▶ data.js
data.js     ──node build/generate_seed.mjs────▶ db/seed_activities.sql
seed SQL    ──wrangler d1 execute (--remote)──▶ base_activities table
```

Run all three steps whenever the spreadsheet changes. The app prefers the D1 copy and
falls back to the bundled `data.js` if the server copy is missing/short — so if a
change "doesn't show up", you probably updated one layer and not the other.

Day-to-day content editing (adding activities, renaming topics) does **not** use this
pipeline — the super admin does it in-app via the Content tab, stored in
`custom_activities` / `activity_overrides` / `taxonomy`.

## 7. Security operations

- **Sessions** are 30-day HS256 JWTs in an `HttpOnly; Secure; SameSite=Lax` cookie,
  signed with `SESSION_SECRET` (Worker environment variable) or an auto-provisioned
  secret stored in D1's `app_meta`. Rotating the secret signs everyone out.
- **Revocation:** `users.token_version` (migration 0013) is embedded in each JWT and
  re-checked on every request. Password changes and passcode resets bump it, which
  kills every other session for that account. To force-sign-out one user manually:
  `UPDATE users SET token_version = token_version + 1 WHERE email = '...';`
- **Login throttling:** `login_attempts` table; 8 tries per account / 30 per IP per
  15 min. Login fails OPEN if the table is somehow unavailable (availability first);
  the authenticated change-password path fails CLOSED. The API self-creates the table
  if migration 0012 was never applied.
- **Compromised-credential guard:** hashes listed in `COMPROMISED_HASHES`
  (`[[route]].js`) can never mint a session; sign-in demands a replacement password
  first. The original seeded super-admin password lives in old git history — that's
  why this guard exists; rotation makes the leak useless, so no history rewrite is
  needed. If another credential ever leaks, add its hash to that list.
- **XSS posture:** every user-authored string is rendered with `textContent`, never
  `innerHTML` — that is the XSS defense. **Never render user content with
  `innerHTML`.** The one HTML-ish surface (the landing-page builder) sanitizes
  server-side (block-type whitelist, `https://`-only links).
- **New-account passcodes** are generated server-side (bias-free), returned exactly
  once, and stored only as PBKDF2 hashes. Lost passcode = reset, not recovery.

## 8. Roles cheat-sheet

This deployment runs with two active role surfaces: `athlete` and `superadmin`.
The backend still contains legacy compatibility paths from the earlier multi-staff
model, but operationally you should treat the app as super-admin-managed.

- Super admin manages students, assignments, content, and appearance.
- Athlete can only read their own assignments and submit completions/reflections/check-ins/messages.
- `usr_global_library` is a non-login sentinel row that owns shared library content.

## 9. Troubleshooting (symptom → cause → check)

| Symptom | Likely cause | Check |
|---|---|---|
| "My edits don't show up for athletes" | Edit saved to a private scope instead of the shared library | Repository-tab banner says *Publishing* or *Private edits*; `SELECT coach_id, COUNT(*) FROM activity_overrides GROUP BY coach_id` — shared rows belong to `usr_global_library` |
| A student is missing from the Students view | Student row is malformed or detached from expected ownership metadata | `SELECT id,name,coach_id FROM users WHERE role='athlete'`; then fix ownership from the Users/Students flows in-app |
| Super admin can't open a student workspace | Student exists but UI state/cache is stale | Refresh Students view, then verify the row exists in `SELECT id,name FROM users WHERE role='athlete'` |
| An activity shows "done" the moment it's assigned | Pre-0015 completion semantics | Confirm migration 0015 applied: `PRAGMA table_info(completions)` should show `assignment_id NOT NULL` |
| Login always says "try again in N min" | Throttle lock active | `DELETE FROM login_attempts WHERE scope = 'email:<their email>';` |
| Everyone signed out at once | `SESSION_SECRET` changed / DB reset regenerated the auto-secret | Expected — they sign back in |
| App loads but "server unavailable" on sign-in | Worker deployed without the D1 binding, or `/api/me` failing | `npx wrangler tail` while loading the page |
| Changes to the spreadsheet don't appear | Only one layer of the content pipeline was run | §6 — regenerate `data.js`, the seed, and re-execute it |

## 10. Known limitations & deliberate decisions

- **No automated tests** — every change needs the manual role walkthrough (§4).
- **No email/SMS** anywhere, on purpose (no domain/DKIM dependencies). The data is
  shaped so a future scheduled Worker could add digests without schema changes.
- **Super admin can read all of an athlete's journal & check-ins** — disclosed to the
  athlete in the UI copy at the point of writing; there is no private-to-self entry.
- **Login throttling fails open** on DB faults (never lock the whole org out);
  change-password fails closed.
- **LOCAL mode** (opening the site with no backend) is a demo/preview shell with a
  client-side passcode — it is not a security boundary and holds no real data.
