-- Kitchen prep overrides ------------------------------------------------------
-- Lets a chef override how many portions to actually cook for a dish on an event
-- (spares, extra staff portions, etc.). The KITCHEN owns this table; the events
-- desk still owns the menu. The app always shows the events count alongside the
-- override, so the two numbers can never silently disagree.
-- Run this in the KITCHEN Supabase project (zrpglswalgjbtghudmhu).

create table if not exists public.kitchen_event_overrides (
  event_id   text        not null,   -- FOH events_desk id (from the kitchen-events feed)
  dish_name  text        not null,   -- dish as shown on the kitchen brief
  portions   integer     not null check (portions >= 0 and portions <= 100000),
  set_by     text,                   -- who/what set it (currently 'kitchen')
  updated_at timestamptz not null default now(),
  primary key (event_id, dish_name)
);

alter table public.kitchen_event_overrides enable row level security;

-- The kitchen screens talk to the DB with the anon key, exactly like prep_status
-- and chef_checks. Allow read + write for the app.
drop policy if exists kitchen_event_overrides_rw on public.kitchen_event_overrides;
create policy kitchen_event_overrides_rw on public.kitchen_event_overrides
  for all to anon, authenticated using (true) with check (true);
