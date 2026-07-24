-- ══════════════════════════════════════════════════════════════════════════
-- MENU DEVELOPMENT PLAN — campaigns + two-lane weighting
--
-- Additive migration. Safe to run once, after menu-plan-schema.sql, on the
-- Kitchen Supabase project. Everything here is IF NOT EXISTS / where-not-exists,
-- so re-running it changes nothing.
--
-- What it adds:
--   1. menu_plan_menus.kind        — 'main' (created) vs 'event' (dated one-off)
--   2. menu_plan_menus.campaign_id — the season an event belongs to
--   3. menu_plan_menus.event_date  — the day an event happens (drives the chip)
--   4. menu_plan_campaigns         — a season: theme + one core menu + a range,
--                                    owning its nights so December is ONE job
--
-- The app derives kind from cadence if these are absent, so it runs before this
-- is applied — this migration just makes the split explicit and adds the season.
-- ══════════════════════════════════════════════════════════════════════════

-- ── 1. new columns on the menus table ──────────────────────────────────────
alter table public.menu_plan_menus
  add column if not exists kind text not null default 'main'
    check (kind in ('main','event'));
alter table public.menu_plan_menus
  add column if not exists event_date date;
-- campaign_id is added after the campaigns table exists (FK below).

-- ── 2. the campaigns table ─────────────────────────────────────────────────
create table if not exists public.menu_plan_campaigns (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,              -- e.g. 'December — Festive'
  season_label  text,                       -- small eyebrow, e.g. 'December · festive'
  theme         text,                       -- the marketing theme (the team writes this)
  blurb         text,                       -- one line describing the theme
  date_from     date,
  date_to       date,
  core_menu_id  uuid references public.menu_plan_menus(id) on delete set null,
  sort_order    int  not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    text
);
create index if not exists menu_plan_campaigns_sort_idx on public.menu_plan_campaigns (sort_order);

alter table public.menu_plan_menus
  add column if not exists campaign_id uuid references public.menu_plan_campaigns(id) on delete set null;
create index if not exists menu_plan_menus_campaign_idx on public.menu_plan_menus (campaign_id);

-- ── 3. RLS (same permissive model as the rest of the module) ───────────────
alter table public.menu_plan_campaigns enable row level security;
drop policy if exists mp_campaigns_all on public.menu_plan_campaigns;
create policy mp_campaigns_all on public.menu_plan_campaigns
  for all to anon, authenticated using (true) with check (true);

-- ── 4. realtime ────────────────────────────────────────────────────────────
alter publication supabase_realtime add table public.menu_plan_campaigns;

-- ── 5. classify existing menus: every one-off dated menu is an event ────────
update public.menu_plan_menus
   set kind = 'event'
 where change_cadence = 'One-off event' and kind <> 'event';

-- give the events with a known day their event_date (from the seeded launch_date)
update public.menu_plan_menus
   set event_date = coalesce(event_date, launch_date)
 where kind = 'event' and event_date is null and launch_date is not null;

-- ── 6. seed the December campaign ──────────────────────────────────────────
-- Title only — the THEME is left blank on purpose. That's the one creative line
-- the team writes; the card invites it rather than inventing it. The core menu
-- is the existing 'Festive' umbrella — the festive menu every night shares.
insert into public.menu_plan_campaigns (title, season_label, date_from, date_to, core_menu_id, sort_order)
select 'December — Festive', 'December · festive', date '2026-12-01', date '2026-12-31',
       (select id from public.menu_plan_menus where name = 'Festive' limit 1), 10
where not exists (select 1 from public.menu_plan_campaigns where title = 'December — Festive');

-- the 'Festive' umbrella is the campaign's core, not a loose event row
update public.menu_plan_menus
   set kind = 'event'
 where name = 'Festive';

-- ── 7. nest December's nights under the campaign ───────────────────────────
update public.menu_plan_menus as m
   set campaign_id = c.id
  from public.menu_plan_campaigns c
 where c.title = 'December — Festive'
   and m.campaign_id is null
   and m.name in (
     'Festive Lunch','Festive Corporate Lunch','Festive Dinner','Festive Corporate Dinner',
     'Christmas Eve · 24 Dec','Christmas Day Lunch · 25 Dec','New Year''s Eve · 31 Dec'
   );
