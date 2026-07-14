-- Kitchen schedule: 4 shared quick-fill shift presets (shown in the shift editor).
-- Run once in the KITCHEN Supabase project (zrpglswalgjbtghudmhu) → SQL editor.
-- The app falls back to built-in defaults until this table exists, so nothing breaks
-- before you run it.

create table if not exists sched_shift_presets (
  slot        int primary key,            -- 1..4 (the four buttons)
  label       text not null,              -- button name (e.g. Lunch)
  status      text not null default 'working',
  shift_start text, shift_end text,       -- 'HH:MM'
  shift_start2 text, shift_end2 text,     -- optional split-shift second block
  updated_at  timestamptz default now()
);

-- Seed the four defaults (edit them later from the "Edit presets" link in the app).
insert into sched_shift_presets (slot, label, status, shift_start, shift_end, shift_start2, shift_end2) values
  (1, 'Lunch',    'working', '10:00', '15:00', '19:00', '00:00'),
  (2, 'Dinner',   'working', '15:00', '03:00', null,    null),
  (3, 'Straight', 'working', '14:00', '00:00', null,    null),
  (4, 'Day off',  'off',     null,    null,    null,    null)
on conflict (slot) do nothing;

-- Same access model as the staff / roster / sched_events / sched_sections tables.
alter table sched_shift_presets enable row level security;
drop policy if exists sched_shift_presets_all on sched_shift_presets;
create policy sched_shift_presets_all on sched_shift_presets for all using (true) with check (true);

notify pgrst, 'reload schema';
