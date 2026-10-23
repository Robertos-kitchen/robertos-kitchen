---
name: deploy
description: Ship a Kitchen App change DEV → LIVE the safe way. Use when Francesco says deploy, push live, ship it, or OK after a DEV link.
disable-model-invocation: true
---
Ship the current change. Stop at the first failure and say what broke in one line.

1. `npm run bump` — cache-bust everything that changed.
2. `npm run precheck` — must pass.
3. Commit with a plain message (what changed, for whom). Push DEV: `git push origin main`.
4. Wait ~60s, then `npm run smoke` against DEV. Must pass.
5. Send Francesco the DEV link https://robertos-kitchen.github.io/robertos-kitchen/ and **wait for his OK**. Stop here unless he already said OK for LIVE.
6. `./deploy-kitchen.sh` — syncs front-end files to LIVE (never supabase/) and verifies parity.
7. Wait ~60s, `npm run smoke:live`. Must pass.
8. Reply in 2–3 lines: version stamp, LIVE link https://guarracinofamily.github.io/robertos-kitchen/, smoke result.
