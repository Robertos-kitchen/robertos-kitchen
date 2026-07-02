-- ════════════════════════════════════════════════════════════
-- COSEC AUTO-SYNC — scheduled pulls (pg_cron + pg_net)
-- Run in: https://supabase.com/dashboard/project/zrpglswalgjbtghudmhu/sql/new
--
-- THIS FILE MIRRORS THE LIVE JOBS (verified against cron.job on 2 Jul 2026).
-- Re-running it recreates production exactly. If you change a job in the
-- dashboard/SQL editor, change it HERE too — this file drifted from live
-- once before and it cost a review half a day chasing a gap that was
-- already covered.
--
-- Why these jobs: COSEC files an out-punch under the day the shift STARTED,
-- and only serves one working day at a time. The team works 14:00 → as late
-- as ~05:00 (events). So we pull TODAY continuously through service, then
-- keep re-pulling YESTERDAY overnight (post-midnight out-punches land on
-- yesterday's working day), with a final yesterday sweep in the morning.
-- The cosec-sync function MERGES: earliest in / latest out ever seen wins,
-- a real value is never overwritten with null. `date=` pulls use the
-- confirmed CENTRA "date-range" format (semicolons, DDMMYYYY).
--
-- Schedule (pg_cron runs in UTC; Dubai = UTC+4, no DST):
--   cosec-sync-service      */15 10-23 UTC  → TODAY, every 15 min, 14:00–03:59 Dubai
--   cosec-sync-postmidnight */20 20-23,0-1  → YESTERDAY, every 20 min, 00:00–05:59 Dubai
--   cosec-sync-yesterday    0 5 UTC         → YESTERDAY, final sweep, 09:00 Dubai
--
-- Note: service uses the new publishable key, the other two use the legacy
-- anon JWT — both are accepted by the edge function gateway today. Align on
-- one when keys are rotated at IT handover.
-- ════════════════════════════════════════════════════════════

-- 1. Enable the extensions (safe to re-run)
CREATE EXTENSION IF NOT EXISTS pg_cron  WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net   WITH SCHEMA extensions;

-- 2. Remove previous versions, including the retired 2-Jul-2026 duplicates
--    (night/morning/midday) — safe to re-run
SELECT cron.unschedule(jobname) FROM cron.job
 WHERE jobname IN ('cosec-sync-service','cosec-sync-postmidnight','cosec-sync-yesterday',
                   'cosec-sync-night','cosec-sync-morning','cosec-sync-midday');

-- 3. TODAY pull — every 15 min through service (14:00–03:59 Dubai)
SELECT cron.schedule(
  'cosec-sync-service',
  '*/15 10-23 * * *',
  $$
  select net.http_post(
    url     := 'https://zrpglswalgjbtghudmhu.supabase.co/functions/v1/cosec-sync?force=1',
    headers := '{"Content-Type":"application/json","apikey":"sb_publishable_5nQCJfW8z5a4HYXTQ2JBJw_YocOU-Jo","Authorization":"Bearer sb_publishable_5nQCJfW8z5a4HYXTQ2JBJw_YocOU-Jo"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);

-- 4. YESTERDAY re-pull — every 20 min, 00:00–05:59 Dubai (post-midnight
--    out-punches belong to the working day that started yesterday)
SELECT cron.schedule(
  'cosec-sync-postmidnight',
  '*/20 20-23,0-1 * * *',
  $$
  SELECT net.http_post(
    url := 'https://zrpglswalgjbtghudmhu.supabase.co/functions/v1/cosec-sync?force=1&date='
           || to_char(((now() AT TIME ZONE 'Asia/Dubai')::date - 1), 'YYYY-MM-DD'),
    headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpycGdsc3dhbGdqYnRnaHVkbWh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5MTIyMjQsImV4cCI6MjA5NjQ4ODIyNH0.pfABN-so4xINK7nHxXUlVeTO4g0h0l6ILHVwpoKrbds"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- 5. YESTERDAY final sweep — 09:00 Dubai
SELECT cron.schedule(
  'cosec-sync-yesterday',
  '0 5 * * *',
  $$
  select net.http_post(
    url := 'https://zrpglswalgjbtghudmhu.supabase.co/functions/v1/cosec-sync?date=' || to_char((now() at time zone 'Asia/Dubai')::date - 1, 'YYYY-MM-DD'),
    headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpycGdsc3dhbGdqYnRnaHVkbWh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5MTIyMjQsImV4cCI6MjA5NjQ4ODIyNH0.pfABN-so4xINK7nHxXUlVeTO4g0h0l6ILHVwpoKrbds"}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

-- 6. Verify: expect exactly 3 rows — service, postmidnight, yesterday
SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname LIKE 'cosec-sync-%';
