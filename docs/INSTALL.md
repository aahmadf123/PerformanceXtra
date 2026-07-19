# Installing PerformanceXtra on a production server

PerformanceXtra runs on **Cloudflare Workers** — there is no traditional server to
install, no OS packages, and nothing to keep patched. "Installing to production" means
provisioning three Cloudflare resources (a Worker, a D1 database, an R2 bucket) and
deploying the code. This guide takes a blank Cloudflare account to a running site.

The scripted path below does everything; the manual path is the same steps spelled out.
Day-to-day operations (making changes, applying future migrations, debugging) live in
`MAINTENANCE.md`; the feature tour is in `README.md`.

## What you need

- A Cloudflare account (the free plan works — Workers, D1 and R2 all have free tiers).
- Node.js 18+ and npm on the machine you're installing from.
- This repository, cloned locally.

## Scripted install (recommended)

```bash
./build/provision.sh            # fresh install (new, empty database)
./build/provision.sh --existing # database that already has data: apply migrations instead
./build/provision.sh --local    # set up wrangler's local dev database only
```

The script is idempotent and asks before touching a remote database. It will:

1. Check you're logged in to Cloudflare (`wrangler login` opens a browser if not).
2. Create the D1 database `performancextra` if it doesn't exist. **First run stops here**
   so you can paste the printed `database_id` into `wrangler.toml` and commit it;
   re-run the script to continue.
3. Create the R2 bucket `performancextra-media` (CMS media uploads) if missing.
4. Load the database:
   - **Fresh install:** applies `db/schema.sql` (the complete current schema) and
     `db/seed_activities.sql` (the 190 base activities). Fresh installs do **not** run
     the numbered migrations — those exist to evolve databases created before each
     change, and `db/schema.sql` already includes all of them.
   - **`--existing`:** applies every file in `db/migrations/` in order. Re-running is
     safe: migrations a database already has fail with a harmless "duplicate column /
     already exists" error, which the script recognizes and skips (SQLite has no
     `ADD COLUMN IF NOT EXISTS`); any other error aborts the run. Back up first:
     `npx wrangler d1 export performancextra --remote --output backup.sql`.
5. Offer to set `SESSION_SECRET` (signs session cookies; recommended for production —
   without it the app auto-provisions a secret into D1 on first request).
6. Deploy with `npm run deploy` and print the finish-in-browser checklist.

## First run (browser)

1. Open the deployed URL. With an empty `users` table the sign-in screen shows
   **"Create the admin account"** — use it to create the super admin. No credentials
   are ever committed to the repo.
2. Sign in. Create students from the Students tab (or CMS → Users); each student gets a
   one-time sign-in code to hand out. Assign work from the Repository.
3. Smoke test end-to-end: create a student → assign an activity → sign in as the student
   (email + code) → complete it and write a reflection → check it shows on your side.

## Manual install (what the script does)

```bash
npm install
npx wrangler login
npx wrangler d1 create performancextra          # paste database_id into wrangler.toml
npx wrangler r2 bucket create performancextra-media
npx wrangler d1 execute performancextra --file db/schema.sql --remote
npx wrangler d1 execute performancextra --file db/seed_activities.sql --remote
npx wrangler secret put SESSION_SECRET          # e.g. openssl rand -base64 32
npm run deploy
```

## After the install

- **Auto-deploys:** in Cloudflare → Workers & Pages → your Worker → connect to Git,
  branch `main`. Merging to `main` then builds and deploys automatically (this is how
  the original production site is set up). `npm run deploy` remains available for
  manual deploys.
- **Custom domain:** Worker → Settings → Domains & Routes → add your domain.
- **Backups:** `npx wrangler d1 export performancextra --remote --output backup.sql`
  before risky changes; see `MAINTENANCE.md` §5.
- **Future migrations:** new numbered files land in `db/migrations/`; apply them in
  order with `--remote` (or re-run `./build/provision.sh --existing`).

## Notes

- One origin serves the site, the API and the database access, so sessions are
  first-party cookies and there is no CORS to configure.
- The Worker name (`performance-xtra`) and the database name (`performancextra`) are
  intentionally different — don't "fix" one to match the other (`MAINTENANCE.md` §2).
- The app can run without the R2 bucket, but CMS media upload/picker features return
  configuration errors until the `MEDIA` binding exists.
