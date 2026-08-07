-- Who Micros requests go to, by default.
--
-- The addresses used to live in the code, then briefly on "whatever the last request
-- used" — which is worse: one test sent to yourself quietly became the address every
-- request after it opened on. The default is a SETTING now. Changing it is a deliberate
-- act on the admin panel; editing the address on the send screen changes THAT send only
-- and nothing after it.
--
-- One row, ever. `id = 1` with a check constraint, so there is nothing to pick between.
--
-- Run it once in the KITCHEN Supabase project (zrpglswalgjbtghudmhu) → SQL editor.
-- https://supabase.com/dashboard/project/zrpglswalgjbtghudmhu/sql/new
-- The app falls back to the addresses it has always used until this exists.

create table if not exists public.micros_settings (
  id           int primary key default 1 check (id = 1),
  send_to      text not null,
  send_cc      text[] not null default '{}',
  updated_at   timestamptz not null default now(),
  updated_by_name text
);

-- Seeded with exactly who it has been going to all along.
insert into public.micros_settings (id, send_to, send_cc) values
  (1, 'ahtwe@robertos.ae',
      array['dvalla@robertos.ae','astellacci@robertos.ae','afalcone@robertos.ae',
            'amohamed@robertos.ae','fguarracino@robertos.ae'])
on conflict (id) do nothing;

alter table public.micros_settings enable row level security;
drop policy if exists micros_settings_all on public.micros_settings;
create policy micros_settings_all on public.micros_settings
  for all using (true) with check (true);

notify pgrst, 'reload schema';
