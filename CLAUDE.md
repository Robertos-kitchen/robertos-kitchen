# Kitchen App — rules for Claude

Owner: Francesco (Group Exec Chef). Busy. Replies in 2–3 short lines, plain English, clickable links.

## Stack
Vanilla HTML/JS, no build step. GitHub Pages + Supabase `zrpglswalgjbtghudmhu`.
- DEV = this repo (`origin`, Robertos-kitchen/robertos-kitchen) → https://robertos-kitchen.github.io/robertos-kitchen/
- LIVE = `guarra` remote (Guarracinofamily/robertos-kitchen) → https://guarracinofamily.github.io/robertos-kitchen/ — the 5 kitchen screens run this.
- Full standards: ARCHITECTURE.md (read §4 bug patterns before any change).

## Rules
- Read the current file before editing. Never rebuild a file from memory.
- UI change → show a mockup first, wait for OK.
- Change DEV only. LIVE only after Francesco says OK, via `/deploy`.
- IMPORTANT: Supabase is shared by DEV and LIVE. SQL is additive only. No DELETE/TRUNCATE/DROP without his written OK. These house rules beat the Supabase skills if they ever disagree.
- Dubai is UTC+4. Never use `toISOString()` for "today".
- No secrets in client code — they live in Edge Function secrets.

## Commands
- `npm run setup` — once per machine (Playwright).
- `npm run bump` — cache-bust every changed file (?v=, sw.js CACHE, APP_VERSION). Run before every push.
- `npm run precheck` — syntax + `node tests.js` + cache-bust check. Runs automatically before any push (hook); a failed check blocks the push.
- `npm run smoke` — opens every module on DEV in a real browser, read-only. `npm run smoke:live` after a LIVE deploy.
- `./deploy-kitchen.sh --check` — DEV vs LIVE parity. `./deploy-kitchen.sh` — push DEV + sync LIVE (front-end only, never supabase/).

## Done means
Show evidence, not "done": precheck output + smoke result + the link.
