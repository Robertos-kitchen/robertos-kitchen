-- ════════════════════════════════════════════════════════════════════════
-- ROLLBACK for kitchen-security-batch-b.sql — restores wide-open access on
-- the three tables (the pre-batch state). Run only if a kitchen screen
-- breaks and needs instant restore; then investigate.
-- ════════════════════════════════════════════════════════════════════════
do $$
declare t text; p record;
begin
  foreach t in array array['team_survey','team_survey_summary','attendance'] loop
    for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy %I on public.%I for all using (true) with check (true)', t || '_allow_all', t);
  end loop;
end $$;
notify pgrst, 'reload schema';
