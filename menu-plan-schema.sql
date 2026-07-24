-- ══════════════════════════════════════════════════════════════════════════
-- MENU DEVELOPMENT PLAN — Kitchen DB (zrpglswalgjbtghudmhu)
-- Run ONCE in the Supabase SQL editor for the KITCHEN project.
--
-- Two things kept deliberately separate (see menu-plan.js):
--   • menu_plan_dishes    = the Dish Bank. The creative engine. Chefs log every
--                           dish they develop. Status drives everything.
--   • menu_plan_menus     + menu_plan_calendar = leadership's schedule of WHICH
--                           menu is developed / tasted / launched / changed WHEN.
-- Plus: sprint config, tasting sessions, and a comment thread so Francesco can
-- review and approve the proposal in the app.
--
-- Every list this module shows is READ FROM THESE TABLES — the JS never carries
-- a hardcoded mirror. Adding a person, a menu or a month is an INSERT, not a
-- redeploy.
--
-- Additive only. No DROP TABLE, no DELETE of existing rows (ARCHITECTURE.md §2.1).
-- ══════════════════════════════════════════════════════════════════════════

-- ── who may use this module ─────────────────────────────────────────────────
-- role: 'chef'            = add/edit dishes, calendar, briefs, tastings, comments
--       'approver'        = the above PLUS approve / send back  (Francesco)
--       'cost_controller' = opens a Costing dish and marks it Costed ✓ + notes
--                           the Simphony input (Aht We). Not a chef, not an approver.
create table if not exists public.menu_plan_members (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  role        text not null default 'chef'   check (role in ('chef','approver','cost_controller')),
  email       text,
  sort_order  int  not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ── the menus leadership schedules across the year ──────────────────────────
-- status is the PROPOSAL state of this menu's brief:
--   draft → submitted → approved | changes_requested (→ back to submitted)
create table if not exists public.menu_plan_menus (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  identity       text,                       -- one line: what this menu IS
  structure      text,                       -- e.g. "5 antipasti · 4 paste · 3 secondi"
  price          text,                       -- text: "AED 295" / "295 pp" / "TBC"
  change_cadence text default 'Seasonal'     check (change_cadence in ('Monthly','Quarterly','Seasonal','One-off event','Not sure')),
  -- Grouping: menus that share a menu_group (e.g. 'Set Menu') collapse into ONE
  -- calendar row + one brief card with an A/B/C dropdown. variant_label is the
  -- short tag shown in that dropdown. Both null for a standalone menu.
  menu_group     text,
  variant_label  text,
  lead_chef      text,
  testing_date   date,
  launch_date    date,
  status         text not null default 'draft'
                 check (status in ('draft','submitted','approved','changes_requested')),
  approved_by    text,
  approved_at    timestamptz,
  sort_order     int  not null default 0,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     text
);
create index if not exists menu_plan_menus_sort_idx on public.menu_plan_menus (sort_order);

-- ── the Dish Bank ───────────────────────────────────────────────────────────
-- for_menus / allergens are text[] so a dish can serve several menus at once.
-- allergen codes: V vegetarian · D dairy · N nuts · R raw · S shellfish
--                 E egg · H honey/pork · G gluten
create table if not exists public.menu_plan_dishes (
  id             uuid primary key default gen_random_uuid(),
  name_it        text not null,              -- Italian name
  description_en text,                       -- plain-English description
  section        text not null default 'Other',
  for_menus      text[] not null default '{}',
  season         text,                       -- kept for old rows; no longer shown in the UI
  status         text not null default 'Idea'
                 check (status in ('Idea','Trying','Testing','Approved','Costing','Retired')),
  allergens      text[] not null default '{}',
  created_by     text,                       -- kept for audit; no longer shown ("one team")
  photo_url      text,
  tasting_score  numeric(2,1),               -- overall (kept for old rows)
  taste_score        numeric(2,1),           -- latest tasting: Taste 1–5
  presentation_score numeric(2,1),           -- latest tasting: Presentation 1–5
  approved_date  date,                       -- auto-stamped when status hits Approved
  -- Costing: a chef attaches an Excel cost sheet (menu_plan_dish_files) + a
  -- selling price, then sends it to the cost controller, who marks it Costed.
  selling_price  text,                       -- text so "AED 120" or "120" both fit
  costing_status text check (costing_status in ('sent','costed')),
  costing_note   text,                       -- cost controller's Simphony note
  costed_by      text,
  costed_at      timestamptz,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     text
);
create index if not exists menu_plan_dishes_status_idx  on public.menu_plan_dishes (status);
create index if not exists menu_plan_dishes_section_idx on public.menu_plan_dishes (section);

-- ── dish photos, kept OUT of the dish row on purpose ────────────────────────
-- A phone photo is the fastest way for a chef to log a dish, but an inline
-- base64 image on every dish row would make the Dish Bank list query heavy for
-- everyone. One row per dish, fetched only when the Dish Bank is opened.
-- The app downscales to ~720px JPEG before saving (≈40–80KB per dish).
create table if not exists public.menu_plan_dish_photos (
  dish_id    uuid primary key references public.menu_plan_dishes(id) on delete cascade,
  data_url   text not null,
  updated_by text,
  updated_at timestamptz not null default now()
);

-- ── cost sheets a chef uploads for a dish (Excel) ───────────────────────────
-- Same model as menu_plan_menu_files: metadata here, bytes in Storage. Sent to
-- the cost controller for review + Simphony input.
create table if not exists public.menu_plan_dish_files (
  id          uuid primary key default gen_random_uuid(),
  dish_id     uuid not null references public.menu_plan_dishes(id) on delete cascade,
  file_name   text not null,
  file_path   text not null,          -- object path inside the 'menu-plan' bucket
  mime        text,
  size_bytes  bigint,
  uploaded_by text,
  created_at  timestamptz not null default now()
);
create index if not exists menu_plan_dish_files_dish_idx on public.menu_plan_dish_files (dish_id, created_at);

-- ── the year grid: one cell per menu per month ──────────────────────────────
-- month is the FIRST DAY of the month ('2026-07-01' … '2027-06-01'), so the
-- window can be widened later without touching stored rows.
-- state: Develop | Testing | Photoshooting | Launch | Live | Changing (absent = None)
-- date_from / date_to optionally pin the cell to a specific day or range inside
-- the month (Bartolini 2–3 Nov, Art Nights 13–16 Nov). Both null = month-level.
create table if not exists public.menu_plan_calendar (
  id         uuid primary key default gen_random_uuid(),
  menu_id    uuid not null references public.menu_plan_menus(id) on delete cascade,
  month      date not null,
  state      text not null check (state in ('Develop','Testing','Photoshooting','Launch','Live','Changing')),
  date_from  date,
  date_to    date,
  updated_by text,
  updated_at timestamptz not null default now(),
  unique (menu_id, month)
);

-- ── tasting sessions ────────────────────────────────────────────────────────
create table if not exists public.menu_plan_tastings (
  id           uuid primary key default gen_random_uuid(),
  session_date date not null,
  session_time text,                       -- "HH:MM" — booked with a time now
  title        text,
  notes        text,
  created_by   text,
  created_at   timestamptz not null default now()
);
-- A tasting item is EITHER a real dish (dish_id) OR a typed placeholder
-- (manual_name) for something not yet in the bank. Scored on two categories.
create table if not exists public.menu_plan_tasting_items (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.menu_plan_tastings(id) on delete cascade,
  dish_id      uuid references public.menu_plan_dishes(id) on delete cascade,   -- nullable now
  manual_name  text,                       -- set when dish_id is null (typed by hand)
  score        numeric(2,1),               -- legacy single score (kept for old rows)
  taste_score        numeric(2,1),         -- Taste 1–5  (1 very bad · 5 very good)
  presentation_score numeric(2,1),         -- Presentation 1–5
  decision     text check (decision in ('Approve','Rework','Reject')),
  comment      text,
  created_at   timestamptz not null default now(),
  constraint mp_ti_dish_or_manual check (dish_id is not null or manual_name is not null)
);
create index if not exists menu_plan_tasting_items_session_idx on public.menu_plan_tasting_items (session_id);

-- ── comments (Francesco reviews here; chefs reply) ──────────────────────────
-- target_type: 'plan' (whole proposal) | 'menu' | 'dish'
-- target_id is null for 'plan'.
create table if not exists public.menu_plan_comments (
  id          uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('plan','menu','dish')),
  target_id   uuid,
  author      text not null,
  body        text not null,
  resolved    boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists menu_plan_comments_target_idx on public.menu_plan_comments (target_type, target_id, created_at);

-- ── menu documents (Word / PDF a chef already wrote) ────────────────────────
-- Only METADATA lives here. The file bytes live in Supabase Storage (bucket
-- 'menu-plan', configured at the bottom of this file), NOT base64 in the row —
-- a real menu PDF is megabytes and has no place in the DB or its backups.
create table if not exists public.menu_plan_menu_files (
  id          uuid primary key default gen_random_uuid(),
  menu_id     uuid not null references public.menu_plan_menus(id) on delete cascade,
  file_name   text not null,          -- the original name, shown to people
  file_path   text not null,          -- object path inside the 'menu-plan' bucket
  mime        text,
  size_bytes  bigint,
  uploaded_by text,
  created_at  timestamptz not null default now()
);
create index if not exists menu_plan_menu_files_menu_idx on public.menu_plan_menu_files (menu_id, created_at);

-- ── sprint config + the proposal's overall submit/approve state ─────────────
-- Single row, id = 1. The 45-day push to fill the Dish Bank.
create table if not exists public.menu_plan_sprint (
  id            int primary key default 1 check (id = 1),
  start_date      date,
  end_date        date,
  target_tried    int not null default 60,
  target_approved int not null default 30,   -- was target_banked; banking is gone
  status          text not null default 'draft'
                check (status in ('draft','submitted','approved','changes_requested')),
  submitted_by  text,
  submitted_at  timestamptz,
  approved_by   text,
  approved_at   timestamptz,
  updated_at    timestamptz not null default now()
);

-- ── RLS: same posture as the rest of the Kitchen app (anon read + write) ────
alter table public.menu_plan_members       enable row level security;
alter table public.menu_plan_menus         enable row level security;
alter table public.menu_plan_dishes        enable row level security;
alter table public.menu_plan_dish_photos   enable row level security;
alter table public.menu_plan_menu_files    enable row level security;
alter table public.menu_plan_dish_files    enable row level security;
alter table public.menu_plan_calendar      enable row level security;
alter table public.menu_plan_tastings      enable row level security;
alter table public.menu_plan_tasting_items enable row level security;
alter table public.menu_plan_comments      enable row level security;
alter table public.menu_plan_sprint        enable row level security;

drop policy if exists mp_members_all on public.menu_plan_members;
create policy mp_members_all on public.menu_plan_members
  for all to anon, authenticated using (true) with check (true);
drop policy if exists mp_menus_all on public.menu_plan_menus;
create policy mp_menus_all on public.menu_plan_menus
  for all to anon, authenticated using (true) with check (true);
drop policy if exists mp_dishes_all on public.menu_plan_dishes;
create policy mp_dishes_all on public.menu_plan_dishes
  for all to anon, authenticated using (true) with check (true);
drop policy if exists mp_dish_photos_all on public.menu_plan_dish_photos;
create policy mp_dish_photos_all on public.menu_plan_dish_photos
  for all to anon, authenticated using (true) with check (true);
drop policy if exists mp_menu_files_all on public.menu_plan_menu_files;
create policy mp_menu_files_all on public.menu_plan_menu_files
  for all to anon, authenticated using (true) with check (true);
drop policy if exists mp_dish_files_all on public.menu_plan_dish_files;
create policy mp_dish_files_all on public.menu_plan_dish_files
  for all to anon, authenticated using (true) with check (true);
drop policy if exists mp_calendar_all on public.menu_plan_calendar;
create policy mp_calendar_all on public.menu_plan_calendar
  for all to anon, authenticated using (true) with check (true);
drop policy if exists mp_tastings_all on public.menu_plan_tastings;
create policy mp_tastings_all on public.menu_plan_tastings
  for all to anon, authenticated using (true) with check (true);
drop policy if exists mp_tasting_items_all on public.menu_plan_tasting_items;
create policy mp_tasting_items_all on public.menu_plan_tasting_items
  for all to anon, authenticated using (true) with check (true);
drop policy if exists mp_comments_all on public.menu_plan_comments;
create policy mp_comments_all on public.menu_plan_comments
  for all to anon, authenticated using (true) with check (true);
drop policy if exists mp_sprint_all on public.menu_plan_sprint;
create policy mp_sprint_all on public.menu_plan_sprint
  for all to anon, authenticated using (true) with check (true);

-- ── realtime (so two chefs on two phones see each other's work) ────────────
alter publication supabase_realtime add table public.menu_plan_menus;
alter publication supabase_realtime add table public.menu_plan_dishes;
alter publication supabase_realtime add table public.menu_plan_calendar;
alter publication supabase_realtime add table public.menu_plan_comments;
alter publication supabase_realtime add table public.menu_plan_sprint;
alter publication supabase_realtime add table public.menu_plan_menu_files;
alter publication supabase_realtime add table public.menu_plan_dish_files;
alter publication supabase_realtime add table public.menu_plan_tastings;
alter publication supabase_realtime add table public.menu_plan_tasting_items;

-- ══════════════════════════════════════════════════════════════════════════
-- STORAGE — the bucket that holds the uploaded Word / PDF menu documents.
-- Public read (same open posture as the rest of the Kitchen app — a menu doc is
-- not sensitive), anon write so a chef on a shared screen can upload with no
-- login. The 20 MB cap matches MP_MAX_FILE_MB in menu-plan.js.
-- ══════════════════════════════════════════════════════════════════════════
insert into storage.buckets (id, name, public, file_size_limit)
values ('menu-plan', 'menu-plan', true, 20971520)
on conflict (id) do update
  set public = true, file_size_limit = 20971520;

drop policy if exists mp_bucket_read   on storage.objects;
drop policy if exists mp_bucket_write  on storage.objects;
drop policy if exists mp_bucket_delete on storage.objects;
create policy mp_bucket_read on storage.objects
  for select to anon, authenticated using (bucket_id = 'menu-plan');
create policy mp_bucket_write on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'menu-plan');
create policy mp_bucket_delete on storage.objects
  for delete to anon, authenticated using (bucket_id = 'menu-plan');

-- ══════════════════════════════════════════════════════════════════════════
-- SEED (idempotent — safe to re-run)
-- ══════════════════════════════════════════════════════════════════════════

-- who can use it. ⚠ afalcone@robertos.ae is INFERRED from the house pattern
-- (dvalla / astellacci / fguarracino) — confirm it before the first email send.
-- ⚠ 'Aht We' name spelling is INFERRED (the cost controller who gets the stock
-- take at ahtwe@robertos.ae) — confirm it before the first cost-sheet email.
insert into public.menu_plan_members (name, role, email, sort_order)
select v.name, v.role, v.email, v.sort_order
from (values
  ('Danilo Valla',            'chef',            'dvalla@robertos.ae',      10),
  ('Antonio Stellacci',       'chef',            'astellacci@robertos.ae',  20),
  ('Andrea Falcone',          'chef',            'afalcone@robertos.ae',    30),
  ('Francesco Guarracino',    'approver',        'fguarracino@robertos.ae', 40),
  ('Aht We',                  'cost_controller', 'ahtwe@robertos.ae',       50)
) as v(name, role, email, sort_order)
where not exists (select 1 from public.menu_plan_members m where m.name = v.name);

-- the menus to plan across Jul 2026 → Jun 2027.
-- Rows 130–220 are the Q4 slots named in the marketing email of 23 Jul 2026
-- (Sep/Oct/Nov/Dec). 'Festive' (100) stays as the umbrella TAG for a dish that
-- works across the whole of December; the seven December rows are the actual
-- sellable menus, each with its own price, structure and lead chef.
insert into public.menu_plan_menus (name, change_cadence, menu_group, variant_label, sort_order)
select v.name, v.cadence, v.grp, v.variant, v.sort_order
from (values
  ('À la carte',                     'Seasonal',      null,       null, 10),
  ('Scala / Lounge',                 'Seasonal',      null,       null, 20),
  ('Business Lunch',                 'Monthly',       null,       null, 30),
  -- Set Menu A/B/C are variants of ONE group; they collapse to a single row
  -- with an A/B/C dropdown on the calendar and the briefs.
  ('Set Menu A',                     'Quarterly',     'Set Menu', 'A',  40),
  ('Set Menu B',                     'Quarterly',     'Set Menu', 'B',  50),
  ('Set Menu C',                     'Quarterly',     'Set Menu', 'C',  60),
  ('Canapé',                         'One-off event', null,       null, 70),
  ('Vegan',                          'Seasonal',      null,       null, 80),
  ('Truffle',                        'Seasonal',      null,       null, 90),
  ('Festive',                        'One-off event', null,       null,100),
  ('Dessert',                        'Seasonal',      null,       null,110),
  ('Bartolini Dinner · 2–3 Nov',     'One-off event', null,       null,120),
  -- September
  ('Aperitivo',                      'Seasonal',      null,       null,130),
  -- October
  ('Family Brunch',                  'One-off event', null,       null,140),
  -- November
  ('Art Nights · 13–16 Nov',         'One-off event', null,       null,150),
  -- December — Festive Month
  ('Festive Lunch',                  'One-off event', null,       null,160),
  ('Festive Corporate Lunch',        'One-off event', null,       null,170),
  ('Festive Dinner',                 'One-off event', null,       null,180),
  ('Festive Corporate Dinner',       'One-off event', null,       null,190),
  ('Christmas Eve · 24 Dec',         'One-off event', null,       null,200),
  ('Christmas Day Lunch · 25 Dec',   'One-off event', null,       null,210),
  ('New Year''s Eve · 31 Dec',       'One-off event', null,       null,220)
) as v(name, cadence, grp, variant, sort_order)
where not exists (select 1 from public.menu_plan_menus m where m.name = v.name);

-- Hard dates from the email. Only the dates the email actually states are set —
-- identity, structure, price and lead chef are deliberately left blank, because
-- those are what the three of them are meant to decide at the table.
-- Alias the target table + qualify the right-hand columns: identity and
-- launch_date exist on BOTH the table and the values list, so the unqualified
-- names inside coalesce() were ambiguous (ERROR 42702). The SET targets on the
-- left stay bare (that side is unambiguous).
update public.menu_plan_menus as m set
  identity    = coalesce(m.identity, v.identity),
  launch_date = coalesce(m.launch_date, v.launch_date)
from (values
  ('Art Nights · 13–16 Nov',       'Art Nights, 13–16 November 2026',      date '2026-11-13'),
  ('Christmas Eve · 24 Dec',       'Christmas Eve, 24 December 2026',      date '2026-12-24'),
  ('Christmas Day Lunch · 25 Dec', 'Christmas Day lunch / brunch, 25 December 2026', date '2026-12-25'),
  ('New Year''s Eve · 31 Dec',     'New Year''s Eve, 31 December 2026',    date '2026-12-31')
) as v(name, identity, launch_date)
where m.name = v.name;

-- the Bartolini dinner is a fixed two-night event: pre-fill its identity and
-- put Develop on Oct 2026 + Launch on Nov 2026 so the row is not blank.
update public.menu_plan_menus
   set identity = coalesce(identity, 'Two-night guest dinner, 2–3 November 2026'),
       launch_date = coalesce(launch_date, date '2026-11-02')
 where name = 'Bartolini Dinner · 2–3 Nov';

-- Q4 calendar, straight from the marketing email: each slot gets LAUNCH in the
-- month the email names, and nothing else. The Develop and Taste squares are
-- left empty ON PURPOSE — working backwards from the launch is the decision the
-- three of them make, and an empty square is what drives the "Still to do" list
-- on the module's home screen.
insert into public.menu_plan_calendar (menu_id, month, state, date_from, date_to)
select m.id, v.month::date, v.state, v.dfrom::date, v.dto::date
from public.menu_plan_menus m
join (values
  -- September
  ('Business Lunch',               '2026-09-01', 'Launch',  null,         null),
  ('À la carte',                   '2026-09-01', 'Launch',  null,         null),   -- winter ALC menu
  ('Aperitivo',                    '2026-09-01', 'Launch',  null,         null),
  -- October
  ('Family Brunch',                '2026-10-01', 'Launch',  null,         null),
  -- November — the two events with fixed dates from the email
  ('Bartolini Dinner · 2–3 Nov',   '2026-10-01', 'Develop', null,         null),
  ('Bartolini Dinner · 2–3 Nov',   '2026-11-01', 'Launch',  '2026-11-02', '2026-11-03'),
  ('Art Nights · 13–16 Nov',       '2026-11-01', 'Launch',  '2026-11-13', '2026-11-16'),
  ('Truffle',                      '2026-11-01', 'Launch',  null,         null),   -- Truffle Week
  -- December — Festive Month
  ('Festive Lunch',                '2026-12-01', 'Launch',  null,         null),
  ('Festive Corporate Lunch',      '2026-12-01', 'Launch',  null,         null),
  ('Festive Dinner',               '2026-12-01', 'Launch',  null,         null),
  ('Festive Corporate Dinner',     '2026-12-01', 'Launch',  null,         null),
  ('Christmas Eve · 24 Dec',       '2026-12-01', 'Launch',  '2026-12-24', null),
  ('Christmas Day Lunch · 25 Dec', '2026-12-01', 'Launch',  '2026-12-25', null),
  ('New Year''s Eve · 31 Dec',     '2026-12-01', 'Launch',  '2026-12-31', null)
) as v(menu, month, state, dfrom, dto) on m.name = v.menu
where not exists (
  select 1 from public.menu_plan_calendar c
   where c.menu_id = m.id and c.month = v.month::date);

-- the 45-day sprint config (single row)
insert into public.menu_plan_sprint (id, start_date, end_date, target_tried, target_approved)
values (1, current_date, current_date + 45, 60, 30)
on conflict (id) do nothing;
