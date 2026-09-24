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

-- ══════════════════════════════════════════════════════════════════════════
-- Candidate emails (added 17 Sep 2026): Reject / Shortlist / Send to HR.
-- The candidate's email is read off the CV and checked by the chef; every
-- email goes out through the interview-email edge function, which checks the
-- same passcode, holds the HR / CC addresses itself (the browser cannot name
-- them) and writes one row here per attempt — sent or failed.
-- The log keeps its row when a candidate is deleted (candidate_id goes null).
-- Applied to the Kitchen project 17 Sep 2026; additive only.
-- ══════════════════════════════════════════════════════════════════════════
alter table public.interview_candidates
  add column if not exists email text not null default '';

create table if not exists public.interview_actions (
  id               uuid primary key default gen_random_uuid(),
  candidate_id     uuid references public.interview_candidates(id) on delete set null,
  event            text not null default '',
  action           text not null check (action in ('reject','shortlist','future','hr')),
  candidate_name   text not null,
  candidate_email  text not null,
  position         text not null,
  status           text not null check (status in ('sent','failed')),
  sent_to          text[] not null default '{}',
  sent_cc          text[] not null default '{}',
  reply_to         text[] not null default '{}',
  subject          text not null default '',
  attachments      text[] not null default '{}',
  resend_id        text,
  error            text,
  delivery         text,
  delivery_checked_at timestamptz,
  is_test          boolean not null default false,
  created_at       timestamptz not null default now()
);
create index if not exists interview_actions_cand_idx  on public.interview_actions(candidate_id);
create index if not exists interview_actions_event_idx on public.interview_actions(event, created_at);
alter table public.interview_actions enable row level security;
-- no policies: the edge function (service role) writes, interview_actions_list reads

create or replace function public.interview_actions_list(p_code text, p_event text)
returns setof public.interview_actions
language plpgsql stable security definer set search_path = public as $$
begin
  if not interview_ok(p_code) then raise exception 'wrong passcode'; end if;
  return query select * from interview_actions where event = p_event order by created_at;
end $$;
grant execute on function public.interview_actions_list(text,text) to anon, authenticated;

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
    email  = case when p_patch ? 'email' then left(coalesce(p_patch->>'email',''), 200) else email end,
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

-- ══════════════════════════════════════════════════════════════════════════
-- Candidate Evaluation Form (added 17 Sep 2026, Francesco): the hiring form HR
-- receives is filled IN the app, never uploaded, so it cannot arrive blank.
-- The answers live with the candidate: interviewers, decision (hired / hold),
-- department, ratings r1..r11 (E/G/A/P, r11 may be "na"), overall, comments.
-- Keys are merged one by one like scores, so two chefs filling different rows
-- do not wipe each other. The interview-email function turns them into the
-- Word form. Applied to the Kitchen project 17 Sep 2026; additive only.
-- ══════════════════════════════════════════════════════════════════════════
alter table public.interview_candidates
  add column if not exists evaluation jsonb not null default '{}'::jsonb;

create or replace function public.interview_patch(p_code text, p_id uuid, p_patch jsonb)
returns public.interview_candidates
language plpgsql security definer set search_path = public as $$
declare r interview_candidates;
begin
  if not interview_ok(p_code) then raise exception 'wrong passcode'; end if;
  if p_patch ? 'evaluation' and length((p_patch->'evaluation')::text) > 6000 then raise exception 'evaluation is too long'; end if;
  update interview_candidates set
    name   = case when p_patch ? 'name'  then left(p_patch->>'name', 120) else name end,
    wave   = case when p_patch ? 'wave'  then left(p_patch->>'wave', 40)  else wave end,
    notes  = case when p_patch ? 'notes' then left(p_patch->>'notes', 4000) else notes end,
    email  = case when p_patch ? 'email' then left(coalesce(p_patch->>'email',''), 200) else email end,
    salary_expectation = case when p_patch ? 'salary_expectation' then left(coalesce(p_patch->>'salary_expectation',''), 120) else salary_expectation end,
    position_applied   = case when p_patch ? 'position_applied'   then left(coalesce(p_patch->>'position_applied',''), 120)   else position_applied end,
    notice_period      = case when p_patch ? 'notice_period'      then left(coalesce(p_patch->>'notice_period',''), 120)      else notice_period end,
    visa_status        = case when p_patch ? 'visa_status'        then left(coalesce(p_patch->>'visa_status',''), 120)        else visa_status end,
    scores = case when p_patch ? 'scores'
                  then jsonb_strip_nulls(scores || (p_patch->'scores')) else scores end,
    evaluation = case when p_patch ? 'evaluation' and jsonb_typeof(p_patch->'evaluation') = 'object'
                  then jsonb_strip_nulls(
                         (evaluation || ((p_patch->'evaluation') - 'ratings'))
                         || jsonb_build_object('ratings', coalesce(evaluation->'ratings','{}'::jsonb) || coalesce(p_patch->'evaluation'->'ratings','{}'::jsonb)))
                  else evaluation end,
    updated_at = now()
  where id = p_id returning * into r;
  return r;
end $$;
notify pgrst, 'reload schema';

-- ══════════════════════════════════════════════════════════════════════════
-- Interviews as a permanent tool (18 Sep 2026, Francesco: "do all aside 6").
--
-- Rounds: a hiring round is a position with an opened / closed date. The
-- candidates keep their `event` column — a round's `event` is that key — so
-- the Commis Open Day of 17 Sep 2026 becomes the first round, untouched.
-- Question sets: the 15 commis lines move from the code into a table, chosen
-- per round; a set used by a scored round is frozen (copy it to change it).
-- Who scored: each score, each email and each new candidate carries the name
-- picked on unlock (scores_by, sent_by, added_by) — a name, not a login.
-- History: interview_history() finds the same email in any round.
-- Recipients: the HR list, CC and Reply-To move from the function into
-- interview_settings, editable in the app; every address must belong to
-- robertos.ae or skelmore.com, so the passcode cannot send a CV elsewhere.
-- Names of interviewers: interview_settings.interviewers, editable in the app.
-- Applied to the Kitchen project 18 Sep 2026; additive only.
-- ══════════════════════════════════════════════════════════════════════════

-- ── rounds ──
create table if not exists public.interview_rounds (
  id            uuid primary key default gen_random_uuid(),
  event         text not null unique,
  title         text not null,
  position      text not null default '',
  question_set  text not null default 'commis',
  opened_on     date not null default (now() at time zone 'Asia/Dubai')::date,
  closed_on     date,
  created_by    text not null default '',
  created_at    timestamptz not null default now()
);
alter table public.interview_rounds enable row level security;

-- ── question sets ──
create table if not exists public.interview_question_sets (
  key         text primary key,
  title       text not null,
  sections    jsonb not null,          -- [{title, part:'int'|'prac', items:[[code, question, hint], …]}]
  weights     jsonb not null default '{"int":40,"prac":60}'::jsonb,
  updated_at  timestamptz not null default now()
);
alter table public.interview_question_sets enable row level security;

insert into public.interview_question_sets(key, title, sections) values ('commis', 'Commis — interview + practical', $set$[
 {"title":"Interview — behavioural","part":"int","items":[
  ["B1","Tell me about a time you made a mistake during a shift.","Ownership without excuses; corrects and learns from it."],
  ["B2","Describe coping with a genuinely busy, high-pressure service.","Stays organized, prioritizes, doesn't panic or blame others."],
  ["B3","How do you react when a senior chef corrects you sharply?","Takes feedback professionally, respects kitchen hierarchy."],
  ["B4","Tell me about supporting a struggling teammate during service.","Team-first instinct, notices and helps, puts service ahead of ego."],
  ["B5","Why Roberto's, and where in a year?","Genuine motivation; some awareness of Roberto's modern-Italian identity."]]},
 {"title":"Interview — technical","part":"int","items":[
  ["T1","Basic knife cuts (brunoise/julienne/chiffonade) and knife care.","Correct technique, mentions sharpening, safe handling."],
  ["T2","Cooking methods and when to use each.","Matches method to ingredient/cut, not just definitions."],
  ["T3","Key food safety points (temps, cross-contamination, allergens, FIFO).","Concrete habits, not vague \"I'm careful.\""],
  ["T4","How they set up and organize mise en place.","Systematic, anticipates service flow, station stays stocked."],
  ["T5","What is 'al dente' and pasta/sauce finishing pitfalls.","Timing/texture, tasting as verification — Italian fundamentals."]]},
 {"title":"Practical demonstration","part":"prac","items":[
  ["P1","Knife skills & precision","Cut uniformity, correct grip/technique, safe handling."],
  ["P2","Speed & time management","Finishes within 10 minutes, sensible order of operations."],
  ["P3","Organization & cleanliness","Mise en place discipline, tidy while working, waste controlled."],
  ["P4","Cooking technique & doneness","Heat control, correct doneness, seasoning judged & tasted."],
  ["P5","Taste, presentation & plating","Balanced flavour, clean simple plating."]]}
]$set$::jsonb) on conflict (key) do nothing;

-- the board that already exists becomes round one
insert into public.interview_rounds(event, title, position, question_set, opened_on)
values ('commis-open-day-2026-09', 'Commis Open Day — 17 Sep 2026', 'Commis', 'commis', date '2026-09-17')
on conflict (event) do nothing;

-- ── who ──
alter table public.interview_candidates
  add column if not exists scores_by jsonb not null default '{}'::jsonb,   -- code -> name of who last scored it
  add column if not exists added_by  text  not null default '';
alter table public.interview_actions
  add column if not exists sent_by text not null default '';

-- ── settings: interviewers and recipients, editable in the app ──
alter table public.interview_settings
  add column if not exists interviewers  jsonb  not null default '[]'::jsonb,
  add column if not exists hr_to         text[] not null default '{}',
  add column if not exists shortlist_cc  text[] not null default '{}',
  add column if not exists shortlist_reply_to text[] not null default '{}',
  add column if not exists hr_reply_to   text[] not null default '{}';
update public.interview_settings set
  interviewers = case when interviewers = '[]'::jsonb then '["Andrea Falcone","Danilo Valla","Antonio Stellacci","Francesco Guarracino"]'::jsonb else interviewers end,
  hr_to        = case when hr_to = '{}' then array['lmadlag@robertos.ae','slhanzom@robertos.ae','dsaxena@skelmore.com'] else hr_to end,
  shortlist_cc = case when shortlist_cc = '{}' then array['dvalla@robertos.ae','lmadlag@robertos.ae'] else shortlist_cc end,
  shortlist_reply_to = case when shortlist_reply_to = '{}' then array['dvalla@robertos.ae','lmadlag@robertos.ae'] else shortlist_reply_to end,
  hr_reply_to  = case when hr_reply_to = '{}' then array['dvalla@robertos.ae','lmadlag@robertos.ae'] else hr_reply_to end
where id = 1;

-- an address the passcode may send a CV to: our own domains only
create or replace function public.interview_addr_ok(p text) returns boolean
language sql immutable as $$
  select p ~* '^[a-z0-9._+-]+@(robertos\.ae|skelmore\.com)$';
$$;

-- ── RPCs ──
create or replace function public.interview_settings_get(p_code text)
returns table(interviewers jsonb, hr_to text[], shortlist_cc text[], shortlist_reply_to text[], hr_reply_to text[])
language plpgsql stable security definer set search_path = public as $$
begin
  if not interview_ok(p_code) then raise exception 'wrong passcode'; end if;
  return query select s.interviewers, s.hr_to, s.shortlist_cc, s.shortlist_reply_to, s.hr_reply_to from interview_settings s where s.id = 1;
end $$;

create or replace function public.interview_settings_patch(p_code text, p_patch jsonb)
returns table(interviewers jsonb, hr_to text[], shortlist_cc text[], shortlist_reply_to text[], hr_reply_to text[])
language plpgsql security definer set search_path = public as $$
declare k text; arr text[]; a text; names jsonb;
begin
  if not interview_ok(p_code) then raise exception 'wrong passcode'; end if;
  foreach k in array array['hr_to','shortlist_cc','shortlist_reply_to','hr_reply_to'] loop
    if p_patch ? k then
      select coalesce(array_agg(lower(trim(x))), '{}') into arr from jsonb_array_elements_text(p_patch->k) x where trim(x) <> '';
      foreach a in array arr loop
        if not interview_addr_ok(a) then raise exception 'Only @robertos.ae and @skelmore.com addresses can receive candidate data (%)', a; end if;
      end loop;
      if k = 'hr_to' and cardinality(arr) = 0 then raise exception 'HR needs at least one address'; end if;
      execute format('update interview_settings set %I = $1 where id = 1', k) using arr;
    end if;
  end loop;
  if p_patch ? 'interviewers' then
    select coalesce(jsonb_agg(left(trim(x), 60)), '[]'::jsonb) into names from jsonb_array_elements_text(p_patch->'interviewers') x where trim(x) <> '';
    update interview_settings set interviewers = names where id = 1;
  end if;
  return query select s.interviewers, s.hr_to, s.shortlist_cc, s.shortlist_reply_to, s.hr_reply_to from interview_settings s where s.id = 1;
end $$;

create or replace function public.interview_rounds_list(p_code text)
returns table(id uuid, event text, title text, position text, question_set text, opened_on date, closed_on date, created_by text,
              candidates int, to_decide int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not interview_ok(p_code) then raise exception 'wrong passcode'; end if;
  return query
    select r.id, r.event, r.title, r.position, r.question_set, r.opened_on, r.closed_on, r.created_by,
      (select count(*)::int from interview_candidates c where c.event = r.event),
      (select count(*)::int from interview_candidates c where c.event = r.event and c.scores <> '{}'::jsonb
         and not exists (select 1 from interview_actions a where a.candidate_id = c.id and a.status = 'sent'))
    from interview_rounds r order by (r.closed_on is null) desc, r.opened_on desc, r.created_at desc;
end $$;

create or replace function public.interview_round_add(p_code text, p_title text, p_position text, p_set text, p_by text)
returns public.interview_rounds
language plpgsql security definer set search_path = public as $$
declare r interview_rounds; ev text;
begin
  if not interview_ok(p_code) then raise exception 'wrong passcode'; end if;
  if length(trim(p_title)) < 2 then raise exception 'the round needs a title'; end if;
  if not exists (select 1 from interview_question_sets where key = p_set) then raise exception 'unknown question set'; end if;
  ev := regexp_replace(lower(trim(coalesce(p_position,'') || ' ' || p_title)), '[^a-z0-9]+', '-', 'g');
  ev := trim(both '-' from ev) || '-' || to_char(now() at time zone 'Asia/Dubai', 'YYYYMMDD-HH24MI');
  insert into interview_rounds(event, title, position, question_set, created_by)
    values (ev, left(trim(p_title), 120), left(trim(coalesce(p_position,'')), 80), p_set, left(coalesce(p_by,''), 60))
    returning * into r;
  return r;
end $$;

create or replace function public.interview_round_patch(p_code text, p_id uuid, p_patch jsonb)
returns public.interview_rounds
language plpgsql security definer set search_path = public as $$
declare r interview_rounds;
begin
  if not interview_ok(p_code) then raise exception 'wrong passcode'; end if;
  if p_patch ? 'question_set' and not exists (select 1 from interview_question_sets where key = p_patch->>'question_set') then raise exception 'unknown question set'; end if;
  -- the questions cannot change under scores already given
  if p_patch ? 'question_set' and exists (select 1 from interview_rounds x join interview_candidates c on c.event = x.event
       where x.id = p_id and c.scores <> '{}'::jsonb and x.question_set <> p_patch->>'question_set') then
    raise exception 'this round already has scores on its current questions';
  end if;
  update interview_rounds set
    title        = case when p_patch ? 'title'        then left(p_patch->>'title', 120) else title end,
    position     = case when p_patch ? 'position'     then left(coalesce(p_patch->>'position',''), 80) else position end,
    question_set = case when p_patch ? 'question_set' then p_patch->>'question_set' else question_set end,
    closed_on    = case when p_patch ? 'closed_on'    then nullif(p_patch->>'closed_on','')::date else closed_on end
  where id = p_id returning * into r;
  return r;
end $$;

create or replace function public.interview_sets_list(p_code text)
returns table(key text, title text, sections jsonb, weights jsonb, updated_at timestamptz, frozen boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not interview_ok(p_code) then raise exception 'wrong passcode'; end if;
  return query select s.key, s.title, s.sections, s.weights, s.updated_at,
    exists (select 1 from interview_rounds r join interview_candidates c on c.event = r.event where r.question_set = s.key and c.scores <> '{}'::jsonb)
    from interview_question_sets s order by s.updated_at;
end $$;

-- a set is checked here, not only in the browser: codes unique, 1..40 lines, a
-- part for every section, weights that add to 100
create or replace function public.interview_set_upsert(p_code text, p_key text, p_title text, p_sections jsonb, p_weights jsonb)
returns table(key text, title text, sections jsonb, weights jsonb, updated_at timestamptz, frozen boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare n int; codes text[]; sec jsonb; it jsonb; k text;
begin
  if not interview_ok(p_code) then raise exception 'wrong passcode'; end if;
  k := regexp_replace(lower(trim(p_key)), '[^a-z0-9]+', '-', 'g');
  if length(k) < 2 then raise exception 'the set needs a name'; end if;
  if exists (select 1 from interview_rounds r join interview_candidates c on c.event = r.event where r.question_set = k and c.scores <> '{}'::jsonb) then
    raise exception 'this set is used by a round with scores — copy it to a new set instead';
  end if;
  if jsonb_typeof(p_sections) <> 'array' or jsonb_array_length(p_sections) = 0 then raise exception 'no sections'; end if;
  n := 0; codes := '{}';
  for sec in select * from jsonb_array_elements(p_sections) loop
    if coalesce(sec->>'part','') not in ('int','prac') then raise exception 'each section is interview or practical'; end if;
    if length(trim(coalesce(sec->>'title',''))) = 0 then raise exception 'a section has no title'; end if;
    for it in select * from jsonb_array_elements(sec->'items') loop
      if jsonb_typeof(it) <> 'array' or jsonb_array_length(it) < 2 or length(trim(it->>1)) = 0 then raise exception 'a line has no question'; end if;
      if (it->>0) = any(codes) then raise exception 'code % is used twice', it->>0; end if;
      codes := codes || (it->>0); n := n + 1;
    end loop;
  end loop;
  if n = 0 or n > 40 then raise exception 'a set has between 1 and 40 lines'; end if;
  if coalesce((p_weights->>'int')::int, -1) + coalesce((p_weights->>'prac')::int, -1) <> 100 then raise exception 'the weights must add up to 100'; end if;
  insert into interview_question_sets(key, title, sections, weights) values (k, left(trim(p_title), 120), p_sections, p_weights)
    on conflict (key) do update set title = excluded.title, sections = excluded.sections, weights = excluded.weights, updated_at = now();
  return query select s.key, s.title, s.sections, s.weights, s.updated_at, false from interview_question_sets s where s.key = k;
end $$;

-- the same email in any other round
create or replace function public.interview_history(p_code text, p_email text, p_not_event text)
returns table(candidate_id uuid, event text, round_title text, round_position text, question_set text, scores jsonb, name text,
              created_at timestamptz, last_action text, last_action_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not interview_ok(p_code) then raise exception 'wrong passcode'; end if;
  if length(trim(coalesce(p_email,''))) < 5 then return; end if;
  return query
    select c.id, c.event, coalesce(r.title, c.event), coalesce(r.position, ''), coalesce(r.question_set, 'commis'), c.scores, c.name, c.created_at,
      (select a.action from interview_actions a where a.candidate_id = c.id and a.status = 'sent' order by a.created_at desc limit 1),
      (select a.created_at from interview_actions a where a.candidate_id = c.id and a.status = 'sent' order by a.created_at desc limit 1)
    from interview_candidates c left join interview_rounds r on r.event = c.event
    where lower(c.email) = lower(trim(p_email)) and c.event <> coalesce(p_not_event, '')
    order by c.created_at desc;
end $$;

-- add / patch carry the name
create or replace function public.interview_add(p_code text, p_event text, p_by text default '')
returns public.interview_candidates
language plpgsql security definer set search_path = public as $$
declare r interview_candidates;
begin
  if not interview_ok(p_code) then raise exception 'wrong passcode'; end if;
  insert into interview_candidates(event, added_by) values (p_event, left(coalesce(p_by,''), 60)) returning * into r;
  return r;
end $$;

create or replace function public.interview_patch(p_code text, p_id uuid, p_patch jsonb, p_by text default '')
returns public.interview_candidates
language plpgsql security definer set search_path = public as $$
declare r interview_candidates; who jsonb;
begin
  if not interview_ok(p_code) then raise exception 'wrong passcode'; end if;
  if p_patch ? 'evaluation' and length((p_patch->'evaluation')::text) > 6000 then raise exception 'evaluation is too long'; end if;
  -- every score in this patch is stamped with the name that gave it
  who := '{}'::jsonb;
  if p_patch ? 'scores' and coalesce(p_by,'') <> '' then
    select coalesce(jsonb_object_agg(k, left(p_by, 60)), '{}'::jsonb) into who from jsonb_object_keys(p_patch->'scores') k;
  end if;
  update interview_candidates set
    name   = case when p_patch ? 'name'  then left(p_patch->>'name', 120) else name end,
    wave   = case when p_patch ? 'wave'  then left(p_patch->>'wave', 80)  else wave end,
    notes  = case when p_patch ? 'notes' then left(p_patch->>'notes', 4000) else notes end,
    email  = case when p_patch ? 'email' then left(coalesce(p_patch->>'email',''), 200) else email end,
    salary_expectation = case when p_patch ? 'salary_expectation' then left(coalesce(p_patch->>'salary_expectation',''), 120) else salary_expectation end,
    position_applied   = case when p_patch ? 'position_applied'   then left(coalesce(p_patch->>'position_applied',''), 120)   else position_applied end,
    notice_period      = case when p_patch ? 'notice_period'      then left(coalesce(p_patch->>'notice_period',''), 120)      else notice_period end,
    visa_status        = case when p_patch ? 'visa_status'        then left(coalesce(p_patch->>'visa_status',''), 120)        else visa_status end,
    scores = case when p_patch ? 'scores'
                  then jsonb_strip_nulls(scores || (p_patch->'scores')) else scores end,
    scores_by = case when p_patch ? 'scores' then jsonb_strip_nulls(scores_by || who) else scores_by end,
    evaluation = case when p_patch ? 'evaluation' and jsonb_typeof(p_patch->'evaluation') = 'object'
                  then jsonb_strip_nulls(
                         (evaluation || ((p_patch->'evaluation') - 'ratings'))
                         || jsonb_build_object('ratings', coalesce(evaluation->'ratings','{}'::jsonb) || coalesce(p_patch->'evaluation'->'ratings','{}'::jsonb)))
                  else evaluation end,
    updated_at = now()
  where id = p_id returning * into r;
  return r;
end $$;

revoke all on function public.interview_addr_ok(text) from public, anon, authenticated;
grant execute on function public.interview_settings_get(text) to anon, authenticated;
grant execute on function public.interview_settings_patch(text,jsonb) to anon, authenticated;
grant execute on function public.interview_rounds_list(text) to anon, authenticated;
grant execute on function public.interview_round_add(text,text,text,text,text) to anon, authenticated;
grant execute on function public.interview_round_patch(text,uuid,jsonb) to anon, authenticated;
grant execute on function public.interview_sets_list(text) to anon, authenticated;
grant execute on function public.interview_set_upsert(text,text,text,jsonb,jsonb) to anon, authenticated;
grant execute on function public.interview_history(text,text,text) to anon, authenticated;
grant execute on function public.interview_add(text,text,text) to anon, authenticated;
grant execute on function public.interview_patch(text,uuid,jsonb,text) to anon, authenticated;
notify pgrst, 'reload schema';
-- the 2- and 3-argument originals would make PostgREST's overload choice ambiguous
drop function if exists public.interview_add(text,text);
drop function if exists public.interview_patch(text,uuid,jsonb);
notify pgrst, 'reload schema';

-- ══════════════════════════════════════════════════════════════════════════
-- 18 Sep 2026, Francesco: Leverina (HR) can use the module — she is offered as a
-- name on unlock; and the Hiring Request can carry a copy list (hr_cc), edited
-- in Set-up like the other lists. Applied to the Kitchen project 18 Sep 2026.
-- ══════════════════════════════════════════════════════════════════════════
alter table public.interview_settings
  add column if not exists hr_cc text[] not null default '{}';
update public.interview_settings set
  interviewers = case when interviewers @> '["Leverina (HR)"]'::jsonb then interviewers else interviewers || '["Leverina (HR)"]'::jsonb end,
  -- starts with the shortlist copy people who are not already the HR address
  hr_cc = case when hr_cc = '{}' then (select coalesce(array_agg(x), '{}') from unnest(shortlist_cc) x where not (x = any(hr_to))) else hr_cc end
where id = 1;

-- the row type grows a column: Postgres wants the old shape dropped first
drop function if exists public.interview_settings_get(text);
drop function if exists public.interview_settings_patch(text,jsonb);
create or replace function public.interview_settings_get(p_code text)
returns table(interviewers jsonb, hr_to text[], hr_cc text[], shortlist_cc text[], shortlist_reply_to text[], hr_reply_to text[])
language plpgsql stable security definer set search_path = public as $$
begin
  if not interview_ok(p_code) then raise exception 'wrong passcode'; end if;
  return query select s.interviewers, s.hr_to, s.hr_cc, s.shortlist_cc, s.shortlist_reply_to, s.hr_reply_to from interview_settings s where s.id = 1;
end $$;

create or replace function public.interview_settings_patch(p_code text, p_patch jsonb)
returns table(interviewers jsonb, hr_to text[], hr_cc text[], shortlist_cc text[], shortlist_reply_to text[], hr_reply_to text[])
language plpgsql security definer set search_path = public as $$
declare k text; arr text[]; a text; names jsonb;
begin
  if not interview_ok(p_code) then raise exception 'wrong passcode'; end if;
  foreach k in array array['hr_to','hr_cc','shortlist_cc','shortlist_reply_to','hr_reply_to'] loop
    if p_patch ? k then
      select coalesce(array_agg(lower(trim(x))), '{}') into arr from jsonb_array_elements_text(p_patch->k) x where trim(x) <> '';
      foreach a in array arr loop
        if not interview_addr_ok(a) then raise exception 'Only @robertos.ae and @skelmore.com addresses can receive candidate data (%)', a; end if;
      end loop;
      if k = 'hr_to' and cardinality(arr) = 0 then raise exception 'HR needs at least one address'; end if;
      execute format('update interview_settings set %I = $1 where id = 1', k) using arr;
    end if;
  end loop;
  if p_patch ? 'interviewers' then
    select coalesce(jsonb_agg(left(trim(x), 60)), '[]'::jsonb) into names from jsonb_array_elements_text(p_patch->'interviewers') x where trim(x) <> '';
    update interview_settings set interviewers = names where id = 1;
  end if;
  return query select s.interviewers, s.hr_to, s.hr_cc, s.shortlist_cc, s.shortlist_reply_to, s.hr_reply_to from interview_settings s where s.id = 1;
end $$;
notify pgrst, 'reload schema';

-- 18 Sep 2026: a folder inside a round ("Monday 21st interview") is the wave column with a typed name — 80 characters.

-- 24 Sep 2026: "Keep for the future" email (Chef Andrea, Tell us 70e28770) — run on the live DB:
-- alter table public.interview_actions drop constraint interview_actions_action_check,
--   add constraint interview_actions_action_check check (action = any (array['reject','shortlist','future','hr']));
