-- Kitchen master code (30 Sep 2026). A personal code that opens and edits every module.
-- Stored HASHED in a table the app cannot read (RLS on, no policies). The app only asks
-- kitchen_master_check(code) -> the person's name, or null.
create table if not exists public.master_codes (
  name text not null,
  code_hash text primary key,
  sid uuid not null default gen_random_uuid(),   -- stands in for a staff id inside learn_/train_/maint_ modules
  created_at timestamptz not null default now()
);
alter table public.master_codes enable row level security;
revoke all on public.master_codes from anon, authenticated;

create or replace function public.master_row(p_code text)
returns public.master_codes language sql stable security definer set search_path = public as $$
  select m.* from master_codes m
   where m.code_hash = encode(sha256(convert_to('robertos-master:' || btrim(coalesce(p_code,'')), 'utf8')), 'hex') limit 1;
$$;
create or replace function public.master_name(p_code text)
returns text language sql stable security definer set search_path = public as $$
  select (public.master_row(p_code)).name;
$$;
create or replace function public.kitchen_master_check(p_code text)
returns text language sql stable security definer set search_path = public as $$
  select public.master_name(p_code);
$$;
revoke all on function public.master_row(text), public.master_name(text) from public, anon, authenticated;
grant execute on function public.kitchen_master_check(text) to anon, authenticated;

-- Interviews + Tasting (also gates Learning approver + viewer setting): master code passes.
create or replace function public.interview_ok(p_code text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from interview_settings where id = 1 and passcode = coalesce(p_code,''))
      or public.master_name(p_code) is not null;
$$;
create or replace function public.tasting_code_ok(p_code text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from tasting_secret where venue_id = 'robertos-difc' and code = coalesce(p_code, ''))
      or public.master_name(p_code) is not null;
$$;

-- Learning / Training / Maintenance identify people by employee ID through learn_who().
-- The master code resolves to a stand-in staff record (Executive Chef level, never listed anywhere).
create or replace function public.learn_who(p_emp text)
returns staff language plpgsql stable security definer set search_path = public as $$
declare s staff; m master_codes;
begin
  m := public.master_row(p_emp);
  if m.sid is not null then
    s.id := m.sid; s.name := m.name; s.designation := 'Executive Chef';
    s.active := true; s.venue_id := 'robertos-difc'; s.emp_id := null; s.station_key := null;
    return s;
  end if;
  select * into s from staff where active and emp_id is not null and trim(emp_id) = trim(coalesce(p_emp,'')) limit 1;
  if s.id is null then raise exception 'no_emp' using errcode = 'P0001'; end if;
  return s;
end $$;

create or replace function public.learn_role(p_emp text, p_code text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s staff;
begin
  if coalesce(p_code,'') <> '' then
    if tasting_code_ok(p_code) then return jsonb_build_object('role','francesco','name', coalesce(public.master_name(p_code),'Francesco')); end if;
    raise exception 'wrong_code' using errcode = 'P0001';
  end if;
  s := learn_who(p_emp);
  if exists(select 1 from learn_checkers where staff_id = s.id) then
    return jsonb_build_object('role','checker','name',s.name,'staff_id',s.id); end if;
  if learn_level(s.designation) = 'senior' then
    return jsonb_build_object('role','writer','name',s.name,'staff_id',s.id); end if;
  raise exception 'not_allowed' using errcode = 'P0001';
end $$;

-- Maintenance technician/chef rights without adding a row that would receive job-card emails.
create or replace function public.maint_has(p_staff uuid, p_role text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from maint_people where staff_id = p_staff and role = p_role and active)
      or exists(select 1 from master_codes where sid = p_staff)
$$;
