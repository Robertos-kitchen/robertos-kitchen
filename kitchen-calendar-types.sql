-- ═══════════════════════════════════════════════════════════════════════════
-- CALENDAR — the note types stop being code and become data.
--
-- Tasting / Push / Live / Event were four hardcoded strings, so renaming one or
-- adding a fifth meant a deploy. They are rows now: the chef renames them,
-- recolours them, reorders them and adds his own.
--
-- The chain is described by the rows too, not by the word "tasting":
--   role = 'anchor'    → starts a chain, and towing its followers is ITS job
--   role = 'follower'  → created with the anchor, offset_days after it
--   role = 'plain'     → stands alone
-- So "tasting → push +8 → live +13" is a configuration, not a rule in the code.
--
-- `kind` on kitchen_cal_notes keeps its existing values ('tasting' etc.) — the
-- seeded ids match, so all 41 existing notes stay valid. The CHECK constraint
-- has to go, or a new type could never be used.
--
-- Safe to run twice.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.kitchen_cal_types (
  id          text primary key,
  label       text not null,
  bg          text not null,
  fg          text not null,
  role        text not null default 'plain' check (role in ('anchor','follower','plain')),
  offset_days integer,
  sort        integer not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into public.kitchen_cal_types (id, label, bg, fg, role, offset_days, sort) values
  ('tasting','Tasting','#5E0A10','#FBEFE9','anchor',   null, 1),
  ('push',   'Push',   '#A33A10','#FFEFE7','follower',    8, 2),
  ('live',   'Live',   '#1D4E4A','#E6F2EF','follower',   13, 3),
  ('event',  'Event',  '#3E4A1D','#F0F4E0','plain',    null, 4)
on conflict (id) do nothing;

-- The old constraint pinned the four names into the schema. A type the chef
-- adds himself has to be storable, so the constraint is replaced by the
-- foreign key — which is the real rule: a note's kind must be a type that exists.
alter table public.kitchen_cal_notes drop constraint if exists kitchen_cal_notes_kind_check;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'kitchen_cal_notes_kind_fkey'
  ) then
    alter table public.kitchen_cal_notes
      add constraint kitchen_cal_notes_kind_fkey
      foreign key (kind) references public.kitchen_cal_types (id)
      on update cascade on delete restrict;
  end if;
end $$;

alter table public.kitchen_cal_types enable row level security;
drop policy if exists kitchen_cal_types_all on public.kitchen_cal_types;
create policy kitchen_cal_types_all
  on public.kitchen_cal_types
  for all to anon, authenticated
  using (true) with check (true);

do $$
begin
  alter publication supabase_realtime add table public.kitchen_cal_types;
exception when duplicate_object then null;
end $$;
