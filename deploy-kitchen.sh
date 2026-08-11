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
#
# ⚠ 7 Aug 2026 — THIS LIST BROKE THE LIVE APP. dev-guard.js was created that day
# and is the FIRST script index.html loads. It was not in this list, so LIVE was
# given an index.html requesting a file that was never pushed: 404, then a
# ReferenceError in app.js on the globals that file defines, and the app stopped
# working for the team. The parity check below compared only this same list, so
# it cheerfully reported "LIVE matches DEV for every front-end file" while a
# required file was missing. A hand-maintained list cannot see what it omits.
#
# So the list is no longer hand-maintained for scripts: every <script src> and
# <link href> in index.html is now read straight out of index.html, and anything
# new is picked up automatically. EXTRAS covers files index.html does not name
# (loaded on demand, or by another page).
FILES="index.html sw.js manifest.json"
# Everything index.html actually loads, local files only, ?v= stripped.
# ANY src=/href=, not just <script>/<link> — the first version of this only read
# those two tags and promptly missed <img src="logo.jpg">, which the check below
# then caught. Images count.
# ⚠ 8 Aug 2026 — a tag scan alone would have shipped a broken LIVE again. A lazy
# loaded module is named ONLY inside a single-quoted JS string —
#   lazyLoad('article-catalogue.js?v=…')
# — which no src=/href= grep can see. So single-quoted local .js/.html/.css
# references are read too, and any new lazy module ships automatically.
FROM_HTML=$( { grep -aoE '(src|href)="[^"]+"' index.html | sed -E 's/.*="//; s/"$//' || true;
          grep -aoE "'[A-Za-z0-9._/-]+[.](js|html|css)([?][^']*)?'" index.html | tr -d "'" || true; } \
  | sed -E 's/[?].*//; s|^[.]/||' \
  | grep -vE '^(https?:)?//|^data:|^mailto:|^tel:|^#|^$|[+()]' | sort -u || true)
# Lazy-loaded or referenced from another page — not named by a tag in index.html.
# writing-help.js is the same shape of trap as the dev-guard.js outage above:
# it is loaded by recipe-create.html, NOT by index.html, so the FROM_HTML scan
# cannot see it. Shipping recipe-create.html without it would put a page on LIVE
# that 404s on its first script and then throws on WritingHelp — the Recipes
# screen would open and do nothing. It ships here or it does not ship.
# downloads/ is named only inside market-list.js as a string, so neither the
# index.html scan nor the HTML reference check can see it. Left out, LIVE
# would serve a Download button that 404s - the same shape of omission that
# took the app down on 7 Aug, just quieter.
EXTRAS="downloads/FMC-order-helper.exe my-tasks.js team.js closing-report.js stock-take.js menu-plan.js recipes.js recipe-create.html recipe-card.html food-bible.html menu-pdfs.html photo-options.html writing-help.js writing-review.html"

# Images and other assets the PAGES reference. Caught the same day as the
# dev-guard.js outage: food-bible.html names its room photos inside a JavaScript
# object ("terrace":"img/room-terrace.jpg"), not in a src= attribute, so a scan
# for tags misses them entirely. Syncing food-bible.html without these would put
# a page on LIVE whose photographs 404. Anything under img/ ships.
# lib/ ships for the same reason img/ does: recipe-create.html names exceljs,
# pdf.js and xlsx from single-quoted JS strings, and a page whose libraries 404
# opens and then does nothing. Both repos already hold identical copies, so
# including them costs nothing and puts them under the parity check.
ASSETS=$(ls img/* lib/* 2>/dev/null || true)

EXIST=""
for f in $FILES $FROM_HTML $EXTRAS $ASSETS; do
  case " $EXIST " in *" $f "*) continue;; esac      # de-dupe
  [ -f "$f" ] && EXIST="$EXIST $f"
done

# Refuse to deploy if any page we are shipping asks for a local file that is not
# in the shipment. A hand-maintained list cannot see what it omits — so this
# checks the real references instead, across every HTML file being sent, and
# catches them in JS strings as well as in tags.
MISSING=""
for page in $(echo "$EXIST" | tr ' ' '\n' | grep -E '\.html$'); do
  # `|| true` on every stage: the script runs under `set -euo pipefail`, and a
  # grep that simply finds nothing exits 1, which would kill the whole deploy.
  # "no matches" is a normal answer here, not a failure.
  refs=$( { grep -aoE '(src|href)="[^"]+"' "$page" 2>/dev/null | sed -E 's/.*="//; s/"$//' || true;
            grep -aoE '"(img|lib)/[A-Za-z0-9._/-]+"' "$page" 2>/dev/null | tr -d '"' || true;
            grep -aoE "'[A-Za-z0-9._/-]+[.](js|html|css)([?][^']*)?'" "$page" 2>/dev/null | tr -d "'" || true; } \
          | sed -E 's/[?].*//; s|^[.]/||' \
          | grep -vE '^(https?:)?//|^data:|^mailto:|^tel:|^#|^$|[+()]' \
          | sort -u || true )
  for r in $refs; do
    [ -f "$r" ] || continue                              # not a local file we own
    case " $EXIST " in *" $r "*) ;; *) MISSING="$MISSING $page->$r";; esac
  done
done
if [ -n "$MISSING" ]; then
  echo "❌ These pages reference files that would NOT be deployed:"
  for m in $MISSING; do echo "     $m"; done
  echo "   Add them above before deploying. Shipping a page without its files is"
  echo "   what took LIVE down on 7 Aug."
  exit 1
fi

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
