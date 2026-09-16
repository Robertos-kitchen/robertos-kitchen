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

-- ══════════════════════════════════════════════════════════════════════════
-- CVs (added 16 Sep 2026) — Word, PDF or a photo of a paper CV, attached to a
-- candidate. Stored in the database behind the same passcode, NOT in a storage
-- bucket: a bucket would need its own access rules or signed URLs, and a CV
-- is exactly the file that must never sit at a guessable public address.
-- Deleting a candidate deletes their CVs (on delete cascade).
-- ══════════════════════════════════════════════════════════════════════════
create table if not exists public.interview_cvs (
  id            uuid primary key default gen_random_uuid(),
  candidate_id  uuid not null references public.interview_candidates(id) on delete cascade,
  filename      text not null,
  mime          text not null default '',
  size_bytes    int  not null,
  data          bytea not null,
  uploaded_at   timestamptz not null default now()
);
create index if not exists interview_cvs_cand_idx on public.interview_cvs(candidate_id);
alter table public.interview_cvs enable row level security;

create or replace function public.interview_cv_add(p_code text, p_candidate uuid, p_filename text, p_mime text, p_b64 text)
returns table(id uuid, candidate_id uuid, filename text, mime text, size_bytes int, uploaded_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare d bytea;
begin
  if not interview_ok(p_code) then raise exception 'wrong passcode'; end if;
  d := decode(p_b64, 'base64');
  if length(d) > 10*1024*1024 then raise exception 'file is over 10 MB'; end if;
  return query insert into interview_cvs(candidate_id, filename, mime, size_bytes, data)
    values (p_candidate, left(p_filename,200), left(coalesce(p_mime,''),120), length(d), d)
    returning interview_cvs.id, interview_cvs.candidate_id, interview_cvs.filename,
              interview_cvs.mime, interview_cvs.size_bytes, interview_cvs.uploaded_at;
end $$;

create or replace function public.interview_cv_list(p_code text, p_event text)
returns table(id uuid, candidate_id uuid, filename text, mime text, size_bytes int, uploaded_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not interview_ok(p_code) then raise exception 'wrong passcode'; end if;
  return query select v.id, v.candidate_id, v.filename, v.mime, v.size_bytes, v.uploaded_at
    from interview_cvs v join interview_candidates c on c.id = v.candidate_id
    where c.event = p_event order by v.uploaded_at;
end $$;

create or replace function public.interview_cv_get(p_code text, p_id uuid)
returns text
language plpgsql stable security definer set search_path = public as $$
declare d bytea;
begin
  if not interview_ok(p_code) then raise exception 'wrong passcode'; end if;
  select data into d from interview_cvs where id = p_id;
  if d is null then raise exception 'CV not found'; end if;
  return translate(encode(d, 'base64'), E'\n', '');
end $$;

create or replace function public.interview_cv_delete(p_code text, p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not interview_ok(p_code) then raise exception 'wrong passcode'; end if;
  delete from interview_cvs where id = p_id;
end $$;

grant execute on function public.interview_cv_add(text,uuid,text,text,text) to anon, authenticated;
grant execute on function public.interview_cv_list(text,text)  to anon, authenticated;
grant execute on function public.interview_cv_get(text,uuid)    to anon, authenticated;
grant execute on function public.interview_cv_delete(text,uuid) to anon, authenticated;
notify pgrst, 'reload schema';

-- ══════════════════════════════════════════════════════════════════════════
-- Candidate details (added 16 Sep 2026, Chef Andrea via "Tell us"):
-- salary expectation, position applied/expected, notice period, visa status.
-- Plain text, kept as typed — the app never parses a salary.
-- Applied to the Kitchen project 16 Sep 2026; existing rows default to ''.
-- ══════════════════════════════════════════════════════════════════════════
alter table public.interview_candidates
  add column if not exists salary_expectation text not null default '',
  add column if not exists position_applied   text not null default '',
  add column if not exists notice_period      text not null default '',
  add column if not exists visa_status        text not null default '';

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
    salary_expectation = case when p_patch ? 'salary_expectation' then left(coalesce(p_patch->>'salary_expectation',''), 120) else salary_expectation end,
    position_applied   = case when p_patch ? 'position_applied'   then left(coalesce(p_patch->>'position_applied',''), 120)   else position_applied end,
    notice_period      = case when p_patch ? 'notice_period'      then left(coalesce(p_patch->>'notice_period',''), 120)      else notice_period end,
    visa_status        = case when p_patch ? 'visa_status'        then left(coalesce(p_patch->>'visa_status',''), 120)        else visa_status end,
    scores = case when p_patch ? 'scores'
                  then jsonb_strip_nulls(scores || (p_patch->'scores')) else scores end,
    updated_at = now()
  where id = p_id returning * into r;
  return r;
end $$;
notify pgrst, 'reload schema';
