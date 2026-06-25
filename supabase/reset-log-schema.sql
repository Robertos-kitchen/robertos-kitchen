-- ──────────────────────────────────────────────────────────────────────────
-- reset_log — audit trail for "Reset all" actions.
--
-- WHY: bulk resets (prep-station reset, chef-checklist reset, stock-take clear)
-- wipe shared data for everyone. As of 25 Jun 2026 they require a validated
-- Employee ID; this table records WHO did each one so an accidental/test reset
-- (e.g. the 25 Jun crudo reset) can always be traced.
--
-- Run this once in the KITCHEN Supabase project (zrpglswalgjbtghudmhu).
-- The FOH app uses a different project — run the same file there too when the
-- FOH leader-task reset gate ships.
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists reset_log (
  id         bigint generated always as identity primary key,
  app        text        not null,            -- 'kitchen' | 'foh'
  action     text        not null,            -- e.g. 'prep_reset_station'
  scope      text,                            -- station / dept / date label
  item_count int,                             -- how many items were wiped
  emp_id     text        not null,
  emp_name   text        not null,
  at         timestamptz not null default now()
);

create index if not exists reset_log_at_idx on reset_log (at desc);

-- The apps talk to Supabase with the anon key, so anon must be able to write
-- (and read back for an in-app audit view later).
alter table reset_log enable row level security;

drop policy if exists reset_log_insert on reset_log;
create policy reset_log_insert on reset_log for insert to anon with check (true);

drop policy if exists reset_log_read on reset_log;
create policy reset_log_read on reset_log for select to anon using (true);
