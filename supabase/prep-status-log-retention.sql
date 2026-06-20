-- ════════════════════════════════════════════════════════════
-- PREP_STATUS_LOG RETENTION — keep the audit log from growing forever
-- Run in: https://supabase.com/dashboard/project/zrpglswalgjbtghudmhu/sql/new
--
-- Why: every prep status tap inserts one row into prep_status_log (app.js:375,
-- 1058). On 5 always-on screens, 10h/day, this table only grows — nothing ever
-- deletes from it. The app only ever reads ONE day at a time (loadReport →
-- .eq('service_date', date), app.js:942), so old rows are dead weight that
-- slows queries and bloats storage. This adds a daily cleanup + a one-time
-- purge, keeping the most recent RETENTION_DAYS of history.
--
-- RETENTION WINDOW: 180 days (≈6 months). The Reports view reads a single day,
-- and the closing-report history only looks back 90 days, so 180 is generous.
-- To change it, edit the two "180 days" literals below (B2 + B3).
--
-- DELETION IS PERMANENT. Run Section A first to see what would be removed.
-- pg_cron runs in UTC; Dubai = UTC+4, no DST.
-- ════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════
-- SECTION A — DIAGNOSE (run FIRST; nothing here deletes anything)
-- ════════════════════════════════════════════════════════════

-- A1. How big is the table, and how far back does it go?
SELECT count(*)                         AS total_rows,
       min(service_date)                AS oldest_date,
       max(service_date)                AS newest_date,
       count(*) FILTER (WHERE service_date < current_date - interval '180 days') AS rows_older_than_180d
FROM prep_status_log;

-- A2. Is a retention job already installed?
SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname = 'prep-status-log-retention';


-- ════════════════════════════════════════════════════════════
-- SECTION B — FIX (run to install retention). Safe to re-run.
-- ════════════════════════════════════════════════════════════

-- B1. Extension + an index on service_date so both the daily reads and the
--     cleanup delete stay fast as the table grows. (Additive, safe to re-run.)
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE INDEX IF NOT EXISTS prep_status_log_service_date_idx
  ON prep_status_log (service_date);

-- B2. ONE-TIME purge of everything older than the window (shrinks the table now,
--     not just going forward). Comment out if you'd rather only clean forward.
DELETE FROM prep_status_log
WHERE service_date < current_date - interval '180 days';

-- B3. DAILY cleanup at 03:00 UTC (07:00 Dubai — after service, before next prep).
--     Re-installs cleanly: unschedule any prior copy first.
SELECT cron.unschedule('prep-status-log-retention')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='prep-status-log-retention');

SELECT cron.schedule(
  'prep-status-log-retention',
  '0 3 * * *',
  $$ DELETE FROM prep_status_log WHERE service_date < current_date - interval '180 days'; $$
);


-- ════════════════════════════════════════════════════════════
-- SECTION C — VERIFY (run after Section B)
-- ════════════════════════════════════════════════════════════
SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname = 'prep-status-log-retention';
-- Expect 1 row, active = true, schedule '0 3 * * *'.

-- Confirm nothing older than the window remains:
SELECT count(*) AS rows_older_than_180d
FROM prep_status_log
WHERE service_date < current_date - interval '180 days';
-- Expect 0.
