-- ════════════════════════════════════════════════════════════════════════
-- SECURITY BATCH B — Kitchen database locks (items #3, #5 of the ranked list)
-- Project: KITCHEN Supabase (zrpglswalgjbtghudmhu). Run in ITS SQL Editor.
-- Rollback: kitchen-security-batch-b-rollback.sql (keep it open in a tab).
--
-- ⚠ ORDER MATTERS: run this ONLY AFTER the kitchen-guard edge function is
--   deployed AND the new kitchen app build is live — the app's survey and
--   manual-clock-out now go through kitchen-guard (service role), and this
--   SQL closes the direct table access they used before.
--
-- What this does:
--   team_survey          NO client access at all (was: anyone with the URL
--                        could read every named psychometric answer). All
--                        reads/writes now via kitchen-guard only.
--   team_survey_summary  same (the AI summary aggregates those answers).
--   attendance           read stays open (the schedule screen shows clock
--                        times on the no-login kitchen display); writes are
--                        service-role only (cosec-sync + kitchen-guard
--                        manual_out) — was open read+write+insert to anyone.
--
-- NOT here (documented decision, needs Francesco's product call same as the
-- FOH schedule): kitchen staff / roster / closing_reports stay open — the
-- kitchen app has NO logins and its whole operational surface reads and
-- writes them; locking them = putting the kitchen display behind a login.
-- ════════════════════════════════════════════════════════════════════════
do $$
declare t text; p record;
begin
  foreach t in array array['team_survey','team_survey_summary','attendance'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

-- team_survey + team_survey_summary: no policies at all = service role only.

-- attendance: the schedule display still reads clock times without a login.
create policy attendance_read on attendance for select using (true);

notify pgrst, 'reload schema';
