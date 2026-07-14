-- Kitchen schedule: sections list (lets a chef add / rename sections in the Roster tool).
-- Run once in the KITCHEN Supabase project (zrpglswalgjbtghudmhu) → SQL editor.
-- The keys below MUST match the station_key values already on the staff rows, so the
-- existing team stays grouped correctly. The app falls back to its built-in list until
-- this table exists, so nothing breaks before you run it.

create table if not exists sched_sections (
  section_key text primary key,          -- stable id used by staff.station_key (never changes on rename)
  label       text not null,             -- the display name (this is what "rename" changes)
  sort_order  int  not null default 0,
  active      boolean not null default true,
  updated_at  timestamptz default now()
);

-- Seed with the sections that are currently hardcoded in the app.
insert into sched_sections (section_key, label, sort_order) values
  ('pass',         'Pass Area',         1),
  ('raw_bar',      'Raw Bar / Starter', 2),
  ('pasta',        'Pasta',             3),
  ('main',         'Main Course',       4),
  ('basement',     'Basement (Prep)',   5),
  ('pastry_pizza', 'Pastry & Pizza',    6),
  ('stewarding',   'Stewarding',        7)
on conflict (section_key) do nothing;

-- Same access model as the staff / roster / sched_events tables (PIN-gated anon layer).
alter table sched_sections enable row level security;
drop policy if exists sched_sections_all on sched_sections;
create policy sched_sections_all on sched_sections for all using (true) with check (true);

-- Make PostgREST pick up the new table immediately.
notify pgrst, 'reload schema';
