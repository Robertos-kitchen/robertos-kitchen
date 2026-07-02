-- ════════════════════════════════════════════════════════════
-- ATTENDANCE-WATCHDOG — daily digest cron (pg_cron + pg_net)
-- Run in: https://supabase.com/dashboard/project/zrpglswalgjbtghudmhu/sql/new
--
-- Fires once a day and POSTs the attendance-watchdog edge function, which
-- emails Francesco the previous service day's anomalies (no clock-out / >14h)
-- or an "all clear". The function defaults its target to YESTERDAY (Dubai).
--
-- Timing: 06:00 UTC = 10:00 Dubai. This is AFTER the 09:00-UTC service
-- catch-up (cosec-sync-service starts 09:00 UTC) and the 02:30-Dubai night
-- backstop, so yesterday's post-midnight out-punches are already merged in
-- before the watchdog reads them.
-- ════════════════════════════════════════════════════════════


-- B1. Extensions (safe to re-run)
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

-- B2. Remove any previous version of this job (safe to re-run)
SELECT cron.unschedule('attendance-watchdog-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'attendance-watchdog-daily');

-- B3. Schedule: 06:00 UTC daily (= 10:00 Dubai).
SELECT cron.schedule(
  'attendance-watchdog-daily',
  '0 6 * * *',
  $$
  SELECT net.http_post(
    url    := 'https://zrpglswalgjbtghudmhu.supabase.co/functions/v1/attendance-watchdog',
    headers:= '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpycGdsc3dhbGdqYnRnaHVkbWh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5MTIyMjQsImV4cCI6MjA5NjQ4ODIyNH0.pfABN-so4xINK7nHxXUlVeTO4g0h0l6ILHVwpoKrbds"}'::jsonb,
    body   := '{}'::jsonb
  );
  $$
);


-- ════════════════════════════════════════════════════════════
-- VERIFY (run after the schedule above)
-- ════════════════════════════════════════════════════════════
SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname = 'attendance-watchdog-daily';
-- Expect 1 row, active = true:  attendance-watchdog-daily   0 6 * * *

-- Recent runs (after it has fired at least once):
-- SELECT j.jobname, r.status, r.start_time, left(r.return_message,200) AS message
-- FROM cron.job_run_details r JOIN cron.job j ON j.jobid = r.jobid
-- WHERE j.jobname = 'attendance-watchdog-daily' ORDER BY r.start_time DESC LIMIT 10;
