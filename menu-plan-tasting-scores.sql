-- ══════════════════════════════════════════════════════════════════════════
-- MENU DEVELOPMENT PLAN — a tasting score PER PERSON
--
-- Additive migration. Run ONCE in the Supabase SQL editor for the KITCHEN
-- project, after menu-plan-schema.sql. Everything here is IF NOT EXISTS /
-- guarded, so re-running it changes nothing. It creates no columns on, and
-- deletes nothing from, the existing tables.
--
-- WHY:
--   menu_plan_tasting_items holds ONE row per (session, dish), carrying one
--   taste_score, one presentation_score and one comment, with no record of who
--   wrote them. A tasting is several people tasting the same dish — so the
--   second person to score silently overwrote the first person's score AND
--   their written note, with nothing on screen to say it had happened.
--
-- WHAT CHANGES:
--   • scores and comments become one row per (tasting item, person)
--   • the OUTCOME (Approve / Rework / Reject) stays exactly where it is, on
--     menu_plan_tasting_items.decision — it is one call on the dish, made by
--     the approver, not an opinion per person.
--   • the old taste_score / presentation_score / comment on the item row are
--     left untouched. The app shows them as one more voice, labelled "scored
--     before this update", so no note written before today is lost or
--     misattributed to somebody.
--
-- The app runs before this is applied: it treats the table as optional and
-- falls back to writing the single shared row, exactly as it does today.
-- ══════════════════════════════════════════════════════════════════════════

create table if not exists public.menu_plan_tasting_scores (
  id                 uuid primary key default gen_random_uuid(),
  item_id            uuid not null references public.menu_plan_tasting_items(id) on delete cascade,
  scored_by          text not null,           -- the name from menu_plan_members
  taste_score        numeric(2,1),            -- Taste 1–5  (1 very bad · 5 very good)
  presentation_score numeric(2,1),            -- Presentation 1–5
  comment            text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- one row per person per dish per session; item_id already identifies the
  -- (session, dish) pair, including the typed-by-hand items.
  unique (item_id, scored_by)
);
create index if not exists menu_plan_tasting_scores_item_idx on public.menu_plan_tasting_scores (item_id);

-- ── RLS: same posture as the rest of the module ───────────────────────────
alter table public.menu_plan_tasting_scores enable row level security;
drop policy if exists mp_tasting_scores_all on public.menu_plan_tasting_scores;
create policy mp_tasting_scores_all on public.menu_plan_tasting_scores
  for all to anon, authenticated using (true) with check (true);

-- ── realtime (two chefs scoring on two phones see each other) ─────────────
-- Guarded: "alter publication ... add table" is NOT idempotent and throws
-- 42710 on a re-run, which would abort the rest of a re-applied script.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename  = 'menu_plan_tasting_scores'
  ) then
    alter publication supabase_realtime add table public.menu_plan_tasting_scores;
  end if;
end $$;
