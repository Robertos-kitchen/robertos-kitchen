-- ════════════════════════════════════════════════════════════
-- REVENUE-GAP-WATCHDOG — daily digest cron (pg_cron + pg_net)
-- Run in: https://supabase.com/dashboard/project/zrpglswalgjbtghudmhu/sql/new
--
-- Fires once a day and POSTs the revenue-gap-watchdog edge function, which
-- emails Francesco how much of the previous night's revenue SevenRooms
-- captured vs the truth, plus the suspected unlinked checks. The function
-- defaults its target to YESTERDAY (Dubai).
--
-- Timing: 06:30 UTC = 10:30 Dubai. LATER than the attendance watchdog (06:00)
-- so the night is fully closed and post-midnight bar tabs are settled before
-- we read SevenRooms. (Truth net still depends on the manager filing the
-- Closing Report — if it isn't filed yet, the email shows tracked net + the
-- leak list and marks the truth line "pending".)
-- ════════════════════════════════════════════════════════════


-- B1. Extensions (safe to re-run)
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

-- B2. Remove any previous version of this job (safe to re-run)
SELECT cron.unschedule('revenue-gap-watchdog-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'revenue-gap-watchdog-daily');

-- B3. Schedule: 06:30 UTC daily (= 10:30 Dubai).
SELECT cron.schedule(
  'revenue-gap-watchdog-daily',
  '30 6 * * *',
  $$
  SELECT net.http_post(
    url    := 'https://zrpglswalgjbtghudmhu.supabase.co/functions/v1/revenue-gap-watchdog',
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
WHERE jobname = 'revenue-gap-watchdog-daily';
-- Expect 1 row, active = true:  revenue-gap-watchdog-daily   30 6 * * *

-- Recent runs (after it has fired at least once):
-- SELECT j.jobname, r.status, r.start_time, left(r.return_message,200) AS message
-- FROM cron.job_run_details r JOIN cron.job j ON j.jobid = r.jobid
-- WHERE j.jobname = 'revenue-gap-watchdog-daily' ORDER BY r.start_time DESC LIMIT 10;
