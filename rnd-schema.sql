-- ══════════════════════════════════════════════════════════════════════════
-- R&D — dishes in development (Kitchen app, Recipes → R&D)
--
-- Chef Antonio's idea through Tell us, 25 Oct 2026 (inbox 0b3353c1): a section
-- apart from the catalogue, easy on a tablet and with a pen. One card per new
-- dish, with its name; the team writes the ingredients, quantities, trials and
-- changes while working, then tidies it all into a precise recipe at the end.
-- No loose sheets, the dish's whole development in one place, and quantities
-- written exactly so the food cost can be worked out.
--
-- · rnd_dishes  — one card per dish. status developing → final. The final
--                 recipe (lines, method, how much it makes) lives on the card.
-- · rnd_entries — the dish's diary: a trial (ingredients + quantities), a
--                 change, or a note; each can carry a handwritten sketch.
--                 One row per entry, newest on top on screen. Never rewritten
--                 by anyone else: the history IS the point.
--
-- Nothing here touches recipes, recipe_lines, menus or the catalogue. An R&D
-- card never appears in the Recipe book and never reaches the till.
--
-- Cost: every line keeps the FMC article code (or MINE-… for the chefs' own
-- ingredients) it was picked from, and the screen prices it from fmc_articles /
-- ingredients at the moment it is shown — never a stored number, so a price
-- change re-costs the trial. A line with no article carries no cost and the
-- total then says "at least".
--
-- ADDITIVE ONLY. Removing a card or an entry is archived = true, never DELETE.
-- RLS: the same open posture as the rest of the Recipes module (ARCHITECTURE.md
-- §1 — open by decision on the shared kitchen screens).
-- ══════════════════════════════════════════════════════════════════════════

create table if not exists public.rnd_dishes (
  id              uuid primary key default gen_random_uuid(),
  venue_id        text not null default 'robertos-difc',
  name            text not null check (length(btrim(name)) between 2 and 80),
  idea            text,                                   -- what the dish is meant to be
  status          text not null default 'developing'
                  check (status in ('developing','final')),
  -- the tidy recipe, written at the end. lines = [{name, code, qty, unit}]
  final_lines     jsonb not null default '[]'::jsonb,
  final_method    text,
  final_portions  numeric,                                -- how many portions the recipe makes
  finalised_by    text,
  finalised_at    timestamptz,
  created_by      text not null,
  created_at      timestamptz not null default now(),
  updated_by      text,
  updated_at      timestamptz not null default now(),
  archived        boolean not null default false,
  archived_by     text,
  archived_at     timestamptz
);
create index if not exists rnd_dishes_venue on public.rnd_dishes (venue_id, archived, updated_at desc);

create table if not exists public.rnd_entries (
  id          uuid primary key default gen_random_uuid(),
  dish_id     uuid not null references public.rnd_dishes(id) on delete cascade,
  kind        text not null check (kind in ('trial','change','note')),
  body        text,                                       -- what was done / what changed / why
  lines       jsonb not null default '[]'::jsonb,         -- [{name, code, qty, unit}]
  sketch      text,                                       -- PNG data URL, handwriting or a drawing
  created_by  text not null,
  created_at  timestamptz not null default now(),
  archived    boolean not null default false,
  archived_by text,
  archived_at timestamptz
);
create index if not exists rnd_entries_dish on public.rnd_entries (dish_id, created_at desc);

alter table public.rnd_dishes  enable row level security;
alter table public.rnd_entries enable row level security;
do $$ begin
  create policy rnd_dishes_all on public.rnd_dishes for all to anon, authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy rnd_entries_all on public.rnd_entries for all to anon, authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
