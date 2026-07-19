#!/usr/bin/env bash
# PerformanceXtra — one-shot production provisioning for a Cloudflare account.
#
#   ./build/provision.sh            # fresh install: create D1 + R2, schema, seed, deploy
#   ./build/provision.sh --existing # existing DB: apply pending migrations, then deploy
#   ./build/provision.sh --local    # same steps against wrangler's LOCAL dev database
#
# Idempotent: every step checks before it creates, and asks before anything that
# writes to a REMOTE database. Companion doc: docs/INSTALL.md.
set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="performancextra"
BUCKET_NAME="performancextra-media"
MODE="fresh"
TARGET="--remote"
for arg in "$@"; do
  case "$arg" in
    --existing) MODE="existing" ;;
    --local)    TARGET="--local" ;;
    -h|--help)  sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (use --existing, --local, or --help)"; exit 1 ;;
  esac
done

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask()  { read -r -p "$1 [y/N] " a; [ "${a:-n}" = "y" ] || [ "${a:-n}" = "Y" ]; }

say "PerformanceXtra provisioning — mode: $MODE, target: ${TARGET#--}"

command -v npx >/dev/null || { echo "Node.js/npm is required (npx not found)."; exit 1; }
[ -d node_modules ] || { say "Installing dependencies (npm install)…"; npm install; }

if [ "$TARGET" = "--remote" ]; then
  say "Checking Cloudflare login…"
  npx wrangler whoami >/dev/null 2>&1 || npx wrangler login

  say "Ensuring D1 database '$DB_NAME' exists…"
  if npx wrangler d1 info "$DB_NAME" >/dev/null 2>&1; then
    echo "✓ D1 database '$DB_NAME' already exists."
  else
    npx wrangler d1 create "$DB_NAME"
    echo
    echo "⚠  Copy the database_id printed above into wrangler.toml ([[d1_databases]])"
    echo "   and commit that change, then re-run this script."
    exit 0
  fi

  say "Ensuring R2 bucket '$BUCKET_NAME' exists (CMS media uploads)…"
  if npx wrangler r2 bucket create "$BUCKET_NAME" 2>/dev/null; then
    echo "✓ Created bucket '$BUCKET_NAME'."
  else
    echo "✓ Bucket '$BUCKET_NAME' already exists (or create it in the dashboard)."
  fi
fi

if [ "$MODE" = "fresh" ]; then
  # db/schema.sql is the CURRENT full schema (kept in sync with the migrations), so a
  # fresh database needs schema + seed only — the numbered migrations are for databases
  # created before those changes and must NOT be replayed here (0004 would try to seed
  # a placeholder super-admin hash, etc.).
  say "Applying full schema + seeding the base activity library…"
  if [ "$TARGET" = "--remote" ]; then
    ask "This writes schema + seed data to the REMOTE '$DB_NAME'. A fresh/empty DB only. Continue?" || exit 1
  fi
  npx wrangler d1 execute "$DB_NAME" --file db/schema.sql "$TARGET" -y
  npx wrangler d1 execute "$DB_NAME" --file db/seed_activities.sql "$TARGET" -y
else
  # Existing database: apply the numbered migrations in order (the directory is read
  # dynamically so this list never goes stale). Most migrations are idempotent
  # (CREATE TABLE IF NOT EXISTS / INSERT OR IGNORE), but SQLite has no
  # "ADD COLUMN IF NOT EXISTS" — an already-applied ALTER migration fails with
  # "duplicate column name". That error just means "this one is done", so it's
  # detected and skipped; any other failure still aborts the run.
  say "Applying migrations from db/migrations/ in order…"
  if [ "$TARGET" = "--remote" ]; then
    echo "Tip: back up first:  npx wrangler d1 export $DB_NAME --remote --output backup.sql"
    ask "Apply all migrations to the REMOTE '$DB_NAME'?" || exit 1
  fi
  for f in $(ls db/migrations/*.sql | sort); do
    echo "— $f"
    if out=$(npx wrangler d1 execute "$DB_NAME" --file "$f" "$TARGET" -y 2>&1); then
      continue
    fi
    if printf '%s' "$out" | grep -qiE 'duplicate column name|already exists'; then
      echo "  already applied — skipped"
    else
      printf '%s\n' "$out"
      echo "✘ Migration failed: $f"
      exit 1
    fi
  done
fi

if [ "$TARGET" = "--local" ]; then
  say "Local database ready. Start the app with:  npm run dev"
  echo "Then open the printed localhost URL and use “Create the admin account”."
  exit 0
fi

say "Session secret…"
echo "The app signs session cookies with SESSION_SECRET. If unset it auto-provisions one"
echo "into D1, but setting your own is recommended for production."
if ask "Set SESSION_SECRET now (a random value will be suggested)?"; then
  SECRET="$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64)"
  echo "Suggested value (paste when prompted, or use your own): $SECRET"
  npx wrangler secret put SESSION_SECRET
fi

say "Deploying the Worker…"
npm run deploy

say "Done. Finish in the browser:"
cat <<'EOF'
  1. Open the deployed URL (wrangler printed it above).
  2. On a fresh database the sign-in screen shows “Create the admin account” —
     use it to create the super admin (this replaces any seeded credential).
  3. Smoke test: sign in → create a student → assign an activity → sign in as
     the student (email + one-time code) → complete it and write a reflection.
  4. Optional: custom domain (Worker → Settings → Domains & Routes), and connect
     the repo to Git so merging to main auto-deploys (see docs/INSTALL.md).
EOF
