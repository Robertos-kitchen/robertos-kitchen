-- ══════════════════════════════════════════════════════════════════════════
-- FISH DISPLAY (Fish of the Day) — Kitchen DB (zrpglswalgjbtghudmhu)
-- Run once in the Supabase SQL editor for the KITCHEN project.
--   • fish_display_items  = the standing template list (fish + caviar), grows
--                           when the team types a new item ("saved for next time")
--   • fish_display_sheet  = one row per business date, the whole day's editable
--                           state as JSONB (entries, oyster, 85, 86, to-push,
--                           blank write-in rows). Shared live via realtime.
-- Mirrors the Market List model (order_items + order_quantities). Anon can read
-- and write the raw-bar sheet, exactly like the rest of the Kitchen app; the DEV
-- host is already blocked from writing in the browser (app.js guard).
-- ══════════════════════════════════════════════════════════════════════════

-- ── standing template list ──────────────────────────────────────────────────
create table if not exists public.fish_display_items (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  kind        text not null default 'fish'  check (kind in ('fish','caviar')),
  sort_order  int  not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists fish_display_items_kind_idx on public.fish_display_items (kind, sort_order);

-- ── one editable sheet per business date ────────────────────────────────────
create table if not exists public.fish_display_sheet (
  biz_date    date primary key,
  doc         jsonb not null default '{}'::jsonb,
  updated_by  text,
  updated_at  timestamptz not null default now()
);

-- ── RLS: same posture as the rest of the Kitchen app (anon read + write) ─────
alter table public.fish_display_items  enable row level security;
alter table public.fish_display_sheet  enable row level security;

drop policy if exists fdi_all on public.fish_display_items;
create policy fdi_all on public.fish_display_items
  for all to anon, authenticated using (true) with check (true);

drop policy if exists fds_all on public.fish_display_sheet;
create policy fds_all on public.fish_display_sheet
  for all to anon, authenticated using (true) with check (true);

-- ── realtime ────────────────────────────────────────────────────────────────
alter publication supabase_realtime add table public.fish_display_items;
alter publication supabase_realtime add table public.fish_display_sheet;

-- ── seed the standing list (idempotent) ─────────────────────────────────────
insert into public.fish_display_items (name, kind, sort_order) values
  ('Seabass',             'fish', 10),
  ('Big seabass',         'fish', 20),
  ('Gamberone',           'fish', 30),
  ('Scallop',             'fish', 40),
  ('Turbot',              'fish', 50),
  ('Lobster',             'fish', 60),
  ('Red porgy',           'fish', 70),
  ('Razor clams',         'fish', 80),
  ('Rock lobster',        'fish', 90),
  ('Red mullet',          'fish', 100),
  ('Sea urchins',         'fish', 110),
  ('Dover sole',          'fish', 120),
  ('Black spot seabream', 'fish', 130),
  ('Seabream',            'fish', 140),
  ('Grunt fish',          'fish', 150),
  ('Brown crab',          'fish', 160),
  ('John dory',           'fish', 170),
  ('Dentex',              'fish', 180),
  ('Scorpion fish',       'fish', 190),
  ('Ars Italica Oscietra','caviar', 10),
  ('Calvisius Beluga',    'caviar', 20),
  ('Calvisius Tradition', 'caviar', 30)
on conflict do nothing;
