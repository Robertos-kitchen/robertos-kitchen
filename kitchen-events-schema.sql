-- Kitchen schedule: day-events (up to 2 per day, shown at the top of the roster).
-- Run once in the KITCHEN Supabase project (zrpglswalgjbtghudmhu) → SQL editor.
-- Separate from the FOH events table — kitchen keeps its own.

create table if not exists sched_events (
  id          uuid primary key default gen_random_uuid(),
  event_date  date not null,
  slot        smallint not null default 1,   -- 1 or 2 (two events per day)
  name        text not null,
  updated_at  timestamptz default now(),
  unique (event_date, slot)
);

-- The schedule writes from the PIN-gated (anon) layer — allow anon read/write,
-- same model as the staff / roster tables.
alter table sched_events enable row level security;
drop policy if exists sched_events_all on sched_events;
create policy sched_events_all on sched_events for all using (true) with check (true);

-- Make PostgREST pick up the new table immediately.
notify pgrst, 'reload schema';
