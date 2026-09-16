-- ══════════════════════════════════════════════════════════════════════════
-- INTERVIEW SCORING — Commis Open Day (17 Sep 2026), from Chef Andrea's draft.
-- Project: KITCHEN Supabase (zrpglswalgjbtghudmhu).
--
-- Candidate names, scores and notes are personal data, and the kitchen app has
-- no logins. So the table has NO client policies at all: the anon key cannot
-- read or write it. Everything goes through the four functions below, and
-- every one of them checks the interviewers' passcode inside the database.
-- The passcode lives in interview_settings, never in the client source.
--
-- Scores are merged key by key (scores || patch), so two chefs scoring the
-- same candidate on two phones cannot overwrite each other's questions.
-- ══════════════════════════════════════════════════════════════════════════

create table if not exists public.interview_settings (
  id        int primary key default 1 check (id = 1),
  passcode  text not null
);
alter table public.interview_settings enable row level security;

create table if not exists public.interview_candidates (
  id          uuid primary key default gen_random_uuid(),
  event       text        not null default 'commis-open-day-2026-09',
  name        text        not null default '',
  wave        text        not null default '',
  scores      jsonb       not null default '{}'::jsonb,
  notes       text        not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.interview_candidates enable row level security;
-- no policies: service role and the security-definer functions only

create or replace function public.interview_ok(p_code text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from interview_settings where id = 1 and passcode = coalesce(p_code,''));
$$;

create or replace function public.interview_list(p_code text, p_event text)
returns setof public.interview_candidates
language plpgsql stable security definer set search_path = public as $$
begin
  if not interview_ok(p_code) then raise exception 'wrong passcode'; end if;
  return query select * from interview_candidates where event = p_event order by created_at;
end $$;

create or replace function public.interview_add(p_code text, p_event text)
returns public.interview_candidates
language plpgsql security definer set search_path = public as $$
declare r interview_candidates;
begin
  if not interview_ok(p_code) then raise exception 'wrong passcode'; end if;
  insert into interview_candidates(event) values (p_event) returning * into r;
  return r;
end $$;

create or replace function public.interview_patch(p_code text, p_id uuid, p_patch jsonb)
returns public.interview_candidates
language plpgsql security definer set search_path = public as $$
declare r interview_candidates;
begin
  if not interview_ok(p_code) then raise exception 'wrong passcode'; end if;
  update interview_candidates set
    name   = case when p_patch ? 'name'  then left(p_patch->>'name', 120) else name end,
    wave   = case when p_patch ? 'wave'  then left(p_patch->>'wave', 40)  else wave end,
    notes  = case when p_patch ? 'notes' then left(p_patch->>'notes', 4000) else notes end,
    scores = case when p_patch ? 'scores'
                  then jsonb_strip_nulls(scores || (p_patch->'scores')) else scores end,
    updated_at = now()
  where id = p_id returning * into r;
  return r;
end $$;

create or replace function public.interview_delete(p_code text, p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not interview_ok(p_code) then raise exception 'wrong passcode'; end if;
  delete from interview_candidates where id = p_id;
end $$;

revoke all on function public.interview_ok(text) from public, anon, authenticated;
grant execute on function public.interview_list(text,text)      to anon, authenticated;
grant execute on function public.interview_add(text,text)       to anon, authenticated;
grant execute on function public.interview_patch(text,uuid,jsonb) to anon, authenticated;
grant execute on function public.interview_delete(text,uuid)    to anon, authenticated;

notify pgrst, 'reload schema';

-- The passcode row is inserted separately, never committed to the repo:
--   insert into interview_settings(id, passcode) values (1, '....')
--   on conflict (id) do update set passcode = excluded.passcode;
