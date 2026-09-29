-- Learning is for the kitchen brigade: stewarding is left out (Chef Francesco, 29 Sep 2026:
-- "remove stewarding"). Only Learning's own steps refuse them; learn_who stays as it is,
-- because Maintenance and Training sign in through it too.
create or replace function public.learn_student(p_emp text) returns staff
language plpgsql stable security definer set search_path to 'public' as $$
declare s staff;
begin
  s := learn_who(p_emp);
  if s.station_key = 'stewarding' then raise exception 'not_learning' using errcode = 'P0001'; end if;
  return s;
end $$;
revoke execute on function public.learn_student(text) from public, anon, authenticated;

do $$
declare f text; d text; n text;
begin
  foreach f in array array['learn_me(text)','learn_home(text)','learn_start(text,text)','learn_finish(text,uuid,jsonb)'] loop
    select pg_get_functiondef(('public.' || f)::regprocedure) into d;
    n := replace(d, 's := learn_who(p_emp);', 's := learn_student(p_emp);');
    if n = d then raise exception '%: pattern not found', f; end if;
    execute n;
  end loop;
  select pg_get_functiondef('public.learn_pages_for(text,text)'::regprocedure) into d;
  n := replace(d, 'perform learn_who(p_emp);', 'perform learn_student(p_emp);');
  if n = d then raise exception 'learn_pages_for: pattern not found'; end if;
  execute n;
  select pg_get_functiondef('public.learn_scores(text,text)'::regprocedure) into d;
  n := replace(d, 'from staff st where st.active)', 'from staff st where st.active and st.station_key is distinct from ''stewarding'')');
  if n = d then raise exception 'learn_scores: pattern not found'; end if;
  execute n;
end $$;
