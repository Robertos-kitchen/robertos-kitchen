-- ════════════════════════════════════════════════════════════
-- COSEC AUTO-SYNC — scheduled overnight pulls (pg_cron + pg_net)
-- Run once in: https://supabase.com/dashboard/project/zrpglswalgjbtghudmhu/sql/new
--
-- Why: COSEC only serves the CURRENT working day and rejects past-date
-- queries. The team works 14:00 → ~01:00. Out-punches land after midnight,
-- but COSEC keeps them under the day the shift STARTED. The app's manual
-- (app-open) sync usually runs in the evening, BEFORE anyone clocks out,
-- so it froze each day as "no clock-out". These cron jobs re-pull while
-- COSEC still serves that working day, and the function now MERGES
-- (keeps earliest in / latest out, never nulls a real value).
--
-- Schedule (pg_cron runs in UTC; Dubai = UTC+4, no DST):
--   02:30 Dubai = 22:30 UTC  → catches the night's out-punches
--   14:30 Dubai = 10:30 UTC  → daily safety net + morning arrivals
-- ════════════════════════════════════════════════════════════

-- 1. Enable the extensions (safe to re-run)
CREATE EXTENSION IF NOT EXISTS pg_cron  WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net   WITH SCHEMA extensions;

-- 2. Remove any previous versions of these jobs (safe to re-run)
SELECT cron.unschedule('cosec-sync-night')  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='cosec-sync-night');
SELECT cron.unschedule('cosec-sync-midday') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='cosec-sync-midday');

-- 3. Night pull — 22:30 UTC (02:30 Dubai)
SELECT cron.schedule(
  'cosec-sync-night',
  '30 22 * * *',
  $$
  SELECT net.http_post(
    url    := 'https://zrpglswalgjbtghudmhu.supabase.co/functions/v1/cosec-sync?force=1',
    headers:= '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpycGdsc3dhbGdqYnRnaHVkbWh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5MTIyMjQsImV4cCI6MjA5NjQ4ODIyNH0.pfABN-so4xINK7nHxXUlVeTO4g0h0l6ILHVwpoKrbds"}'::jsonb,
    body   := '{}'::jsonb
  );
  $$
);

-- 4. Midday safety net — 10:30 UTC (14:30 Dubai)
SELECT cron.schedule(
  'cosec-sync-midday',
  '30 10 * * *',
  $$
  SELECT net.http_post(
    url    := 'https://zrpglswalgjbtghudmhu.supabase.co/functions/v1/cosec-sync?force=1',
    headers:= '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpycGdsc3dhbGdqYnRnaHVkbWh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5MTIyMjQsImV4cCI6MjA5NjQ4ODIyNH0.pfABN-so4xINK7nHxXUlVeTO4g0h0l6ILHVwpoKrbds"}'::jsonb,
    body   := '{}'::jsonb
  );
  $$
);

-- 5. Verify the jobs are registered
SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname LIKE 'cosec-sync-%';
