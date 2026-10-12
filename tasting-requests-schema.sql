-- Tasting times (12 Oct 2026, Francesco): a chef asks Chef Francesco to taste one or more
-- waiting dishes on a day and time. He gets an email, accepts the time or picks another with
-- his code, and the confirmed time goes to his Outlook as a calendar invite.
--
-- Additive only: two new tables, two new columns with defaults, new functions. Nothing that
-- exists is changed. DEV and LIVE share this database.
--
-- The DATABASE decides who gets mail (the maint-notify pattern): the RPCs queue a row in
-- tasting_mail and call the tasting-notify function through pg_net with {mail:<id>}. The app
-- never calls the function, and the function only ever sends an already-queued row, once.

alter table public.tasting_settings
  add column if not exists askers text[] not null default array['Andrea Falcone','Antonio Stellacci','Danilo Valla'];
alter table public.tasting_secret
  add column if not exists notify_email text;
update public.tasting_secret set notify_email = 'fguarracino@robertos.ae'
 where venue_id = 'robertos-difc' and notify_email is null;

create table if not exists public.tasting_requests (
  id uuid primary key default gen_random_uuid(),
  venue_id text not null default 'robertos-difc',
  recipe_ids uuid[] not null check (cardinality(recipe_ids) between 1 and 30),
  asked_by text not null check (length(asked_by) between 1 and 80),
  emp_id text,
  proposed_at timestamptz not null,
  note text check (note is null or length(note) <= 300),
  status text not null default 'proposed' check (status in ('proposed','confirmed','cancelled')),
  confirmed_at timestamptz,
  decided_by text,
  decided_at timestamptz,
  cal_seq int not null default 0,
  is_test boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists tasting_requests_open on public.tasting_requests(status, proposed_at);

create table if not exists public.tasting_mail (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.tasting_requests(id) on delete cascade,
  kind text not null check (kind in ('ask','invite','cancel')),
  to_list text[] not null,
  is_test boolean not null default false,
  status text not null default 'queued' check (status in ('queued','sending','sent','failed')),
  tries int not null default 0,
  resend_id text,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

alter table public.tasting_requests enable row level security;
alter table public.tasting_mail enable row level security;
drop policy if exists tasting_requests_read on public.tasting_requests;
create policy tasting_requests_read on public.tasting_requests for select to anon, authenticated using (true);
grant select on public.tasting_requests to anon, authenticated;
revoke all on public.tasting_mail from anon, authenticated;

create or replace function public.tasting_mail_kick(p_mail bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://zrpglswalgjbtghudmhu.supabase.co/functions/v1/tasting-notify',
    headers := jsonb_build_object('Content-Type','application/json',
      'Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpycGdsc3dhbGdqYnRnaHVkbWh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5MTIyMjQsImV4cCI6MjA5NjQ4ODIyNH0.pfABN-so4xINK7nHxXUlVeTO4g0h0l6ILHVwpoKrbds'),
    body := jsonb_build_object('mail', p_mail));
end $$;
revoke all on function public.tasting_mail_kick(bigint) from public, anon, authenticated;

create or replace function public.tasting_mail_queue(p_request uuid, p_kind text, p_test boolean) returns void
language plpgsql security definer set search_path = public as $$
declare addr text; mid bigint;
begin
  select notify_email into addr from tasting_secret where venue_id = 'robertos-difc';
  if addr is null or addr = '' then return; end if;
  insert into tasting_mail (request_id, kind, to_list, is_test) values (p_request, p_kind, array[addr], p_test)
  returning id into mid;
  perform tasting_mail_kick(mid);
end $$;
revoke all on function public.tasting_mail_queue(uuid, text, boolean) from public, anon, authenticated;

-- A chef asks. Only a name on tasting_settings.askers may ask; at most 5 open asks at once.
create or replace function public.tasting_request_new(p_by text, p_emp text, p_recipes uuid[], p_at timestamptz, p_note text, p_test boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s tasting_settings; ids uuid[]; rid uuid; who text := trim(coalesce(p_by, ''));
begin
  select * into s from tasting_settings where venue_id = 'robertos-difc';
  if who = '' or not (who = any(s.askers)) then raise exception 'not_asker' using errcode = 'P0001'; end if;
  if p_at is null or p_at < now() or p_at > now() + interval '180 days' then raise exception 'bad_time' using errcode = 'P0001'; end if;
  select array_agg(distinct r.id) into ids from recipes r where r.id = any(coalesce(p_recipes, '{}')) and r.archived = false;
  if ids is null or cardinality(ids) < 1 then raise exception 'no_dishes' using errcode = 'P0001'; end if;
  if cardinality(ids) > 30 then raise exception 'too_many_dishes' using errcode = 'P0001'; end if;
  if (select count(*) from tasting_requests where status = 'proposed' and proposed_at > now()) >= 5 then
    raise exception 'too_many_open' using errcode = 'P0001'; end if;
  insert into tasting_requests (recipe_ids, asked_by, emp_id, proposed_at, note, is_test)
  values (ids, who, nullif(trim(coalesce(p_emp, '')), ''), p_at, nullif(trim(coalesce(p_note, '')), ''), coalesce(p_test, false))
  returning id into rid;
  perform tasting_mail_queue(rid, 'ask', coalesce(p_test, false));
  return jsonb_build_object('id', rid);
end $$;

-- Chef Francesco accepts the proposed time (p_at null) or sets another one. His code only.
-- Every confirmation bumps cal_seq, so a later change UPDATES the same Outlook entry.
create or replace function public.tasting_request_decide(p_code text, p_id uuid, p_at timestamptz, p_by text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r tasting_requests; t timestamptz;
begin
  if not tasting_code_ok(p_code) then raise exception 'wrong_code' using errcode = 'P0001'; end if;
  select * into r from tasting_requests where id = p_id for update;
  if r.id is null then raise exception 'no_request' using errcode = 'P0001'; end if;
  if r.status = 'cancelled' then raise exception 'cancelled' using errcode = 'P0001'; end if;
  t := coalesce(p_at, r.proposed_at);
  if t < now() or t > now() + interval '180 days' then raise exception 'bad_time' using errcode = 'P0001'; end if;
  if r.status = 'confirmed' and r.confirmed_at = t then raise exception 'same_time' using errcode = 'P0001'; end if;
  update tasting_requests set status = 'confirmed', confirmed_at = t, cal_seq = cal_seq + 1,
         decided_by = coalesce(nullif(trim(p_by), ''), 'Francesco'), decided_at = now()
   where id = p_id;
  perform tasting_mail_queue(p_id, 'invite', r.is_test);
  return jsonb_build_object('id', p_id, 'confirmed_at', t);
end $$;

-- Cancel: Chef Francesco with his code, or the chef who asked taking it back.
-- A confirmed one also takes the entry off the Outlook calendar.
create or replace function public.tasting_request_cancel(p_code text, p_id uuid, p_by text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r tasting_requests; who text := trim(coalesce(p_by, ''));
begin
  select * into r from tasting_requests where id = p_id for update;
  if r.id is null then raise exception 'no_request' using errcode = 'P0001'; end if;
  if not (tasting_code_ok(p_code) or (who <> '' and who = r.asked_by)) then
    raise exception 'wrong_code' using errcode = 'P0001'; end if;
  if r.status = 'cancelled' then return jsonb_build_object('id', p_id); end if;
  update tasting_requests set status = 'cancelled', cal_seq = cal_seq + 1,
         decided_by = coalesce(nullif(who, ''), 'Francesco'), decided_at = now()
   where id = p_id;
  if r.status = 'confirmed' then perform tasting_mail_queue(p_id, 'cancel', r.is_test); end if;
  return jsonb_build_object('id', p_id);
end $$;

revoke all on function public.tasting_request_new(text, text, uuid[], timestamptz, text, boolean) from public;
revoke all on function public.tasting_request_decide(text, uuid, timestamptz, text) from public;
revoke all on function public.tasting_request_cancel(text, uuid, text) from public;
grant execute on function public.tasting_request_new(text, text, uuid[], timestamptz, text, boolean) to anon, authenticated;
grant execute on function public.tasting_request_decide(text, uuid, timestamptz, text) to anon, authenticated;
grant execute on function public.tasting_request_cancel(text, uuid, text) to anon, authenticated;

notify pgrst, 'reload schema';
