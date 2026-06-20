-- ════════════════════════════════════════════════════════════
-- COSEC AUTO-SYNC — scheduled pulls (pg_cron + pg_net)
-- Run in: https://supabase.com/dashboard/project/zrpglswalgjbtghudmhu/sql/new
--
-- Why: COSEC only serves the CURRENT working day and rejects past-date
-- queries. The team works 14:00 → ~03:00. Out-punches land after midnight,
-- but COSEC keeps them under the day the shift STARTED. The function MERGES
-- (keeps earliest in / latest out, never nulls a real value), so re-pulling
-- the same day repeatedly is safe.
--
-- 2026-06-19 change: clock-ins stopped appearing during service. Root cause
-- is the recording only ran twice a day (+ when someone opened the app), so a
-- single missed cron blanks a whole service. Fix = a FREQUENT service-hours
-- pull every 10 min, so one miss is invisible and clock-ins show within minutes.
--
-- pg_cron runs in UTC; Dubai = UTC+4, no DST.
--   Dubai 13:00 → 05:00 service window  ==  UTC 09:00 → 01:00
-- ════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════
-- SECTION A — DIAGNOSE (run this FIRST; tells you WHY it stopped today)
-- ════════════════════════════════════════════════════════════

-- A1. Are the jobs even registered, and are they active?
SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname LIKE 'cosec-sync-%'
ORDER BY jobname;

-- A2. Did they actually run, and did they fail? (last 30 runs)
--     status 'failed' or a stale start_time = the reason recording stopped.
SELECT j.jobname, r.status, r.start_time, r.end_time,
       left(r.return_message, 200) AS message
FROM cron.job_run_details r
JOIN cron.job j ON j.jobid = r.jobid
WHERE j.jobname LIKE 'cosec-sync-%'
ORDER BY r.start_time DESC
LIMIT 30;


-- ════════════════════════════════════════════════════════════
-- SECTION B — FIX (run this to (re)install reliable recording)
-- ════════════════════════════════════════════════════════════

-- B1. Extensions (safe to re-run)
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

-- B2. Remove any previous versions of these jobs (safe to re-run)
SELECT cron.unschedule('cosec-sync-night')   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='cosec-sync-night');
SELECT cron.unschedule('cosec-sync-midday')  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='cosec-sync-midday');
SELECT cron.unschedule('cosec-sync-service') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='cosec-sync-service');

-- B3. PRIMARY: frequent service-hours pull — every 10 min during
--     UTC 09:00–01:00  (= Dubai 13:00 → 05:00 working-day boundary).
--     This is what makes clock-ins appear live and survives a missed run.
SELECT cron.schedule(
  'cosec-sync-service',
  '*/10 0-1,9-23 * * *',
  $$
  SELECT net.http_post(
    url    := 'https://zrpglswalgjbtghudmhu.supabase.co/functions/v1/cosec-sync?force=1',
    headers:= '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpycGdsc3dhbGdqYnRnaHVkbWh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5MTIyMjQsImV4cCI6MjA5NjQ4ODIyNH0.pfABN-so4xINK7nHxXUlVeTO4g0h0l6ILHVwpoKrbds"}'::jsonb,
    body   := '{}'::jsonb
  );
  $$
);

-- B4. BACKSTOP: night catch-all 22:30 UTC (02:30 Dubai) — late out-punches.
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

-- B5. BACKSTOP: midday safety net 10:30 UTC (14:30 Dubai).
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


-- ════════════════════════════════════════════════════════════
-- SECTION C — VERIFY (run after Section B)
-- ════════════════════════════════════════════════════════════
SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname LIKE 'cosec-sync-%'
ORDER BY jobname;
-- Expect 3 rows, all active = true:
--   cosec-sync-service  */10 0-1,9-23 * * *
--   cosec-sync-night    30 22 * * *
--   cosec-sync-midday   30 10 * * *
