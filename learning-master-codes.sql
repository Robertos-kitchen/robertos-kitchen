-- Master codes open everything (Francesco, 9 Oct 2026): "i want to be able to open every module with
-- 1212 by default ... same for the code we created for Andrea Sacchi". 1212 is now a master_codes row.
-- Here a master code typed into the employee-ID box acts as Chef Francesco: approver in Chef's corner,
-- checker, and Team-scores viewer; in Training it signs off like 1212 always could.

create or replace function public.learn_role(p_emp text, p_code text)
 returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare s staff;
begin
  if coalesce(p_code,'') <> '' then
    if tasting_code_ok(p_code) then return jsonb_build_object('role','francesco','name', coalesce(public.master_name(p_code),'Francesco')); end if;
    raise exception 'wrong_code' using errcode = 'P0001';
  end if;
  if public.master_name(p_emp) is not null then
    return jsonb_build_object('role','francesco','name', public.master_name(p_emp)); end if;
  s := learn_who(p_emp);
  if exists(select 1 from learn_checkers where staff_id = s.id) then
    return jsonb_build_object('role','checker','name',s.name,'staff_id',s.id); end if;
  if learn_level(s.designation) = 'senior' then
    return jsonb_build_object('role','writer','name',s.name,'staff_id',s.id); end if;
  raise exception 'not_allowed' using errcode = 'P0001';
end $function$;

create or replace function public.learn_me(p_emp text)
 returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare s staff; m boolean := public.master_name(p_emp) is not null;
begin
  s := learn_student(p_emp);
  return jsonb_build_object('staff_id', s.id, 'name', s.name, 'designation', s.designation,
    'level', learn_level(s.designation),
    'checker', m or exists(select 1 from learn_checkers where staff_id = s.id),
    'viewer',  m or exists(select 1 from learn_viewers  where staff_id = s.id));
end $function$;

-- Team scores: a master code typed as the employee ID opens them too
do $$ declare d text; begin
  select pg_get_functiondef(p.oid) into d from pg_proc p where proname = 'learn_scores';
  if position('master_name(p_emp)' in d) = 0 then
    d := replace(d, 'if not exists(select 1 from learn_viewers where staff_id = s.id) then',
                    'if public.master_name(p_emp) is null and not exists(select 1 from learn_viewers where staff_id = s.id) then');
    execute d;
  end if;
end $$;

create or replace function public.train_who(p_emp text)
 returns staff language plpgsql stable security definer set search_path to 'public' as $function$
declare s staff;
begin
  if btrim(coalesce(p_emp,'')) = '1212' or public.master_name(p_emp) is not null then
    s.id := '00000000-0000-0000-0000-000000001212'; s.name := coalesce(public.master_name(p_emp), 'Admin'); s.designation := 'Admin';
    s.active := true; s.venue_id := 'robertos-difc'; s.emp_id := null; s.station_key := null;
    return s;
  end if;
  return learn_who(p_emp);
end $function$;
