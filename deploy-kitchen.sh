#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Deploy the kitchen front-end to BOTH repos: dev (origin) and live (guarra).
#
# WHY: the kitchen SCREENS load the `guarra` repo (guarracinofamily/robertos-
# kitchen). A plain `git push origin` only updates DEV and never reaches the
# screens. This script does the dev->live sync the safe way (front-end files
# only, leaving supabase/ untouched) and then VERIFIES the two repos match —
# which is the exact thing that silently broke and stranded weeks of work.
#
# Usage:
#   ./deploy-kitchen.sh --check    # only compare DEV vs LIVE (no pushing) — always safe
#   ./deploy-kitchen.sh            # push DEV, sync LIVE, then verify they match
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

# Self-clean: each git push here spawns a throwaway "auto-deploy-<id>/" folder
# (a git-credential-manager / dotnet-suggest sentinel). Sweep any such stray
# folders on exit — whether this script succeeds OR fails — so they never pile
# up. Nothing real is ever named this; the temp git branch of the same name is
# deleted separately below, and this only ever touches directories on disk.
trap 'rm -rf auto-deploy-*/ 2>/dev/null || true' EXIT

# Front-end files the screens actually load. supabase/ is deliberately EXCLUDED
# (LIVE holds COSEC fixes that DEV is behind on — never overwrite it from here).
FILES="index.html common.js app.js floorplan.js market-list.js fish-display.js stock-take.js recipes.js team.js closing-report.js sw.js manifest.json"
EXIST=""
for f in $FILES; do [ -f "$f" ] && EXIST="$EXIST $f"; done

git fetch origin --quiet || true
git fetch guarra --quiet || true

parity() {
  local d; d=$(git diff --stat origin/main guarra/main -- $EXIST || true)
  if [ -z "$d" ]; then
    echo "✅ LIVE (guarra) matches DEV (origin) for every front-end file."
    return 0
  else
    echo "⚠️  LIVE and DEV DIFFER on these front-end files:"
    echo "$d"
    return 1
  fi
}

# --check: read-only comparison, safe to run anytime.
if [ "${1:-}" = "--check" ]; then parity; exit $?; fi

# Full deploy ----------------------------------------------------------------
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "❌ Not on main. Aborting."; exit 1; }
git diff --quiet || { echo "❌ You have uncommitted changes — commit them first."; exit 1; }

DEV=$(git rev-parse HEAD)

# Cache-bust guard: warn if a JS file shipped without bumping index.html's ?v=.
CHANGED=$(git diff --name-only HEAD~1 HEAD || true)
for js in app.js floorplan.js market-list.js fish-display.js closing-report.js team.js recipes.js stock-take.js; do
  if echo "$CHANGED" | grep -qx "$js"; then
    if ! echo "$CHANGED" | grep -qx "index.html"; then
      echo "⚠️  $js changed but index.html (?v= cache-bust) was NOT in the same commit — screens may keep running stale code."
    fi
  fi
done

echo "→ Pushing to DEV (origin)…"
git push origin main

echo "→ Syncing front-end to LIVE (guarra)…"
TMP="auto-deploy-$(git rev-parse --short HEAD)"
git checkout -B "$TMP" guarra/main --quiet
git checkout "$DEV" -- $EXIST
if git diff --cached --quiet; then
  echo "ℹ️  LIVE already current — nothing to sync."
else
  git commit -m "sync from dev ($(git rev-parse --short "$DEV"))" --quiet
  git push guarra "$TMP":main
  echo "✅ Front-end pushed to LIVE."
fi
git checkout main --quiet
git branch -D "$TMP" --quiet

git fetch guarra --quiet || true
echo "→ Verifying…"
parity
