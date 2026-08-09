-- ══════════════════════════════════════════════════════════════════════════
-- MY TASKS — personal task list (Francesco's private module)
-- Run once in the Supabase SQL editor for project zrpglswalgjbtghudmhu.
-- ══════════════════════════════════════════════════════════════════════════

create table if not exists public.my_tasks (
  id          uuid primary key default gen_random_uuid(),
  owner       text        not null default 'francesco',
  title       text        not null,
  note        text,
  kind        text,                       -- e.g. 'Meeting'
  tag         text,                       -- e.g. 'Kitchen', 'Teams'
  due_date    date,
  due_time    time,
  priority    int         not null default 3,   -- 1 urgent, 2 high, 3 normal
  done        boolean     not null default false,
  done_at     timestamptz,
  source      text,                       -- 'outlook' when created from calendar
  source_ref  text,                       -- calendar event id, to avoid duplicates
  created_at  timestamptz not null default now()
);

create index if not exists my_tasks_owner_due_idx  on public.my_tasks (owner, done, due_date);
create unique index if not exists my_tasks_source_uq on public.my_tasks (owner, source_ref)
  where source_ref is not null;

alter table public.my_tasks enable row level security;

-- NOTE: matches the current platform-wide model (anon key + open policy).
-- When real auth lands (see ARCHITECTURE.md §1), replace this with an
-- owner-scoped policy: using (auth.uid() = user_id).
drop policy if exists my_tasks_all on public.my_tasks;
create policy my_tasks_all on public.my_tasks
  for all using (true) with check (true);

alter publication supabase_realtime add table public.my_tasks;
