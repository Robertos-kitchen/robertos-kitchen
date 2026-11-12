-- ═══════════════════════════════════════════════════════════════════════════
-- KITCHEN DESIGN MODULE — two tables, nothing else, nothing existing touched.
--
-- kd_projects  one row per kitchen project (Marrakech villa first).
-- kd_docs      every saved document of the planner, keyed by project:
--                coll 'plans'     doc 'main'      the team plan (both floors)
--                coll 'planhist'  doc 'h00012_…'  earlier versions
--                coll 'requests'  doc '<id>'      requests and replies
--                coll 'photos'    doc '<item>'    reference photos
--              The equipment bank is shared by ALL projects: it lives under the
--              reserved project id 00000000-0000-0000-0000-000000000000,
--              coll 'equipment'.
--
-- Same posture as kitchen_cal_notes: the Kitchen app talks to PostgREST with the
-- anon key straight from the browser, so the policy is explicit and flagged for
-- the security hardening pass, which moves all of these together.
--
-- Additive only. Safe to run twice. DEV and LIVE share this one database.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists "pgcrypto";

create table if not exists public.kd_projects (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  place      text,
  notes      text,
  archived   boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.kd_docs (
  project_id uuid not null,
  coll       text not null,
  doc_id     text not null,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (project_id, coll, doc_id)
);

create index if not exists kd_docs_coll_idx on public.kd_docs (project_id, coll, updated_at desc);

alter table public.kd_projects enable row level security;
alter table public.kd_docs     enable row level security;

drop policy if exists kd_projects_all on public.kd_projects;
create policy kd_projects_all on public.kd_projects for all to anon, authenticated using (true) with check (true);

drop policy if exists kd_docs_all on public.kd_docs;
create policy kd_docs_all on public.kd_docs for all to anon, authenticated using (true) with check (true);

-- The first project. Fixed id so the pages and the seed can name it.
insert into public.kd_projects (id, name, place, notes)
values ('a0000000-0000-4000-8000-000000000001', 'Marrakech villa kitchens', 'Marrakech',
        'Downstairs production kitchen and upstairs service kitchen. Permit drawing of 31 Oct 2026.')
on conflict (id) do nothing;
