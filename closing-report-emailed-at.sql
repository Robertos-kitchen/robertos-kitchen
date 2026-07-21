-- Closing report: duplicate-email guard.
-- Run on the KITCHEN Supabase project (zrpglswalgjbtghudmhu), NOT the FOH one.
-- Adds the column the app stamps after each successful send; a later submit for
-- the same night then asks before emailing the team a second copy.
-- Safe to run anytime — the app tolerates the column being absent (guard just
-- stays dormant until this is applied).

alter table public.closing_reports
  add column if not exists emailed_at timestamptz;
