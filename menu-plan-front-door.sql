-- ══════════════════════════════════════════════════════════════════════════
-- MENU DEVELOPMENT PLAN — the new front door
--
-- Run ONCE in the Supabase SQL editor for the KITCHEN project
-- (zrpglswalgjbtghudmhu), after menu-plan-schema.sql and menu-plan-campaigns.sql.
--
-- Additive and idempotent. No DROP TABLE, no DELETE of any row, no column
-- removed. Re-running it changes nothing (ARCHITECTURE.md §2.1).
--
-- WHAT THIS IS FOR
-- The old calendar could hold ONE stage per menu per month — `unique (menu_id,
-- month)` with a not-null month. That is why Development and Photoshoot could
-- never overlap, and why a job that runs six months could not be written down
-- as anything other than six separate squares. The new timeline needs real
-- date ranges with overlaps allowed.
--
-- BEFORE YOU RUN IT
-- The app already checks whether these columns exist and works either way:
--   • Before: home, the intake box and the read-back all work; the "how long
--     have you got" step saves the ready-by date onto the menu, and the app
--     says plainly that the timeline itself cannot be saved yet.
--   • After: the timeline saves real date ranges and the stages appear on home.
-- Nothing that works today stops working. The old month grid keeps its unique
-- constraint and keeps saving exactly as before.
--
-- AFTER YOU RUN IT
-- Nothing else to do — the app picks up the new columns on the next page load.
-- ══════════════════════════════════════════════════════════════════════════


-- ══ 1. THE CALENDAR: real date ranges, overlaps allowed ═══════════════════
--
-- How the two live side by side, deliberately:
--   • An OLD row (the month grid) has month + state, and stage/starts_on null.
--   • A NEW row (the timeline) has stage + starts_on + ends_on, and month null.
-- Postgres treats NULLs as distinct in a unique index, so `unique (menu_id,
-- month)` still protects the month grid — one square per menu per month — while
-- putting no limit at all on how many timeline rows a menu can carry, or on
-- whether they overlap. That is why month and state only lose NOT NULL here;
-- the unique constraint is deliberately LEFT IN PLACE, because the existing
-- Calendar tab upserts on it (on_conflict=menu_id,month) and dropping it would
-- break a screen that works today.

alter table public.menu_plan_calendar alter column month drop not null;
alter table public.menu_plan_calendar alter column state drop not null;

alter table public.menu_plan_calendar add column if not exists stage     text;
alter table public.menu_plan_calendar add column if not exists starts_on date;
alter table public.menu_plan_calendar add column if not exists ends_on   date;

-- The five stages of a job: Development → Testing → Approval → Costing, with
-- Photoshoot floating anywhere in between. There is no Simphony stage.
-- `stage is null or …` so every existing month-grid row still passes.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'menu_plan_calendar_stage_chk' and conrelid = 'public.menu_plan_calendar'::regclass) then
    alter table public.menu_plan_calendar
      add constraint menu_plan_calendar_stage_chk
      check (stage is null or stage in ('Development','Testing','Approval','Costing','Photoshoot'));
  end if;
end $$;

-- A row is either a month square or a timeline block — never neither.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'menu_plan_calendar_shape_chk' and conrelid = 'public.menu_plan_calendar'::regclass) then
    alter table public.menu_plan_calendar
      add constraint menu_plan_calendar_shape_chk
      check (month is not null or stage is not null);
  end if;
end $$;

-- A timeline block that has a stage must have a start, and must not end before
-- it starts. Left permissive for the old rows, which have neither.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'menu_plan_calendar_range_chk' and conrelid = 'public.menu_plan_calendar'::regclass) then
    alter table public.menu_plan_calendar
      add constraint menu_plan_calendar_range_chk
      check (stage is null or (starts_on is not null and (ends_on is null or ends_on >= starts_on)));
  end if;
end $$;

create index if not exists menu_plan_calendar_stage_idx
  on public.menu_plan_calendar (menu_id, starts_on);

-- menu_plan_calendar is already in the supabase_realtime publication (added by
-- menu-plan-schema.sql), so there is nothing to add here. Adding it again would
-- throw 42710 and abort the rest of this script.


-- ══ 2. THE MENUS: where the work came from ════════════════════════════════
--
-- Work reaches the kitchen two ways. Most of it is HANDED to Danilo — Francesco
-- asks for an activation or a menu and Danilo then comes up with the dates and
-- the plan. The rest he starts himself. Both end up as an ordinary
-- menu_plan_menus row; only the origin differs, and that is all these columns
-- record.
--
--   origin       'self' (he started it) | 'requested' (Francesco asked)
--   requested_by who asked
--   request_note what they asked for, in their words — often a pasted email
--   needed_by    optional: when they need it. Blank means Danilo proposes it.
--   plan_state   null      = no timeline yet
--                'proposed' = Danilo has given it a timeline, Francesco to look
--                'accepted' = Francesco has accepted the timeline

alter table public.menu_plan_menus add column if not exists origin       text not null default 'self';
alter table public.menu_plan_menus add column if not exists requested_by text;
alter table public.menu_plan_menus add column if not exists request_note text;
alter table public.menu_plan_menus add column if not exists needed_by    date;
alter table public.menu_plan_menus add column if not exists plan_state   text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'menu_plan_menus_origin_chk' and conrelid = 'public.menu_plan_menus'::regclass) then
    alter table public.menu_plan_menus
      add constraint menu_plan_menus_origin_chk check (origin in ('self','requested'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'menu_plan_menus_planstate_chk' and conrelid = 'public.menu_plan_menus'::regclass) then
    alter table public.menu_plan_menus
      add constraint menu_plan_menus_planstate_chk
      check (plan_state is null or plan_state in ('proposed','accepted'));
  end if;
end $$;

create index if not exists menu_plan_menus_origin_idx on public.menu_plan_menus (origin, plan_state);


-- ══ 3. THE COST CONTROLLER'S NAME ═════════════════════════════════════════
-- ahtwe@robertos.ae is Aung Htwe. 'Aht We' was a misreading of the email
-- address; the FOH app has always had it right. One row, name field only —
-- nothing points at the old spelling (no dish, tasting or comment was ever
-- written under it), so this is a straight rename.

update public.menu_plan_members
   set name = 'Aung Htwe'
 where name = 'Aht We';
