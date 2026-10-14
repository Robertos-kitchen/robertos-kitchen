-- Maintenance: Follow up (Chef Andrea, Send feedback ba7f8e65, 14 Oct 2026).
-- A job card nobody has touched for a day gets a "Follow up" button, for the people in
-- maint_people with role 'followup' (Danilo Valla, Antonio Stellacci) and the master codes.
-- Pressing it emails the technician who has the card (or every technician if nobody has
-- opened it yet) and shows "Update asked by ..." on the card until the technician moves it.
-- Adding or removing who may follow up = one maint_people row, no code.

create or replace function public.maint_followup_after() returns interval
language sql immutable as $$ select interval '24 hours' $$;

alter table public.maint_cards
  add column if not exists followup_at timestamptz,
  add column if not exists followup_by text,
  add column if not exists followup_count int not null default 0;

alter table public.maint_mail drop constraint maint_mail_kind_check;
alter table public.maint_mail add constraint maint_mail_kind_check check (kind = any (array['new','check','followup']));

alter table public.maint_people drop constraint maint_people_role_check;
alter table public.maint_people add constraint maint_people_role_check check (role = any (array['technician','chef','followup']));

insert into public.maint_people(staff_id, role, email, active)
select mp.staff_id, 'followup', mp.email, true
  from public.maint_people mp join public.staff st on st.id = mp.staff_id
 where mp.role = 'chef' and st.emp_id in ('000835','100168')
on conflict (staff_id, role) do update set active = true, email = excluded.email;

create or replace function public.maint_queue(p_card uuid, p_kind text)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
declare c maint_cards; v_to text[]; v_id bigint;
begin
  select * into c from maint_cards where id = p_card;
  if c.is_test then v_to := array['fguarracino@robertos.ae'];
  else
    if p_kind = 'followup' and c.tech_id is not null then
      select array_agg(distinct lower(email)) into v_to from maint_people
       where active and role = 'technician' and staff_id = c.tech_id;
    end if;
    if v_to is null or cardinality(v_to) = 0 then
      select array_agg(distinct lower(email)) into v_to from maint_people
       where active and role = case when p_kind in ('new','followup') then 'technician' else 'chef' end;
    end if;
  end if;
  if v_to is null or cardinality(v_to) = 0 then return; end if;
  insert into maint_mail(card_id, kind, to_list, is_test) values (p_card, p_kind, v_to, c.is_test) returning id into v_id;
  if p_kind <> 'new' then perform maint_kick(v_id); end if;
end $function$;

create or replace function public.maint_me(p_emp text)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare s staff;
begin
  s := learn_who(p_emp);
  return jsonb_build_object('staff_id', s.id, 'name', s.name, 'designation', s.designation,
    'tech', maint_has(s.id,'technician'), 'chef', maint_has(s.id,'chef'), 'followup', maint_has(s.id,'followup'),
    'followup_after_h', extract(epoch from maint_followup_after())::int / 3600,
    'techs', (select coalesce(jsonb_agg(st.name order by st.name), '[]'::jsonb) from maint_people mp join staff st on st.id = mp.staff_id where mp.role='technician' and mp.active),
    'chefs', (select coalesce(jsonb_agg(st.name order by st.name), '[]'::jsonb) from maint_people mp join staff st on st.id = mp.staff_id where mp.role='chef' and mp.active),
    'followers', (select coalesce(jsonb_agg(st.name order by st.name), '[]'::jsonb) from maint_people mp join staff st on st.id = mp.staff_id where mp.role='followup' and mp.active));
end $function$;

create or replace function public.maint_get(p_emp text, p_id uuid)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare s staff; c maint_cards;
begin
  s := learn_who(p_emp);
  select * into c from maint_cards where id = p_id;
  if c.id is null then raise exception 'no_card' using errcode = 'P0001'; end if;
  return jsonb_build_object('card', maint_card_row(c),
    'me', jsonb_build_object('tech', maint_has(s.id,'technician'), 'chef', maint_has(s.id,'chef'), 'followup', maint_has(s.id,'followup'),
                             'signed_as_tech', c.tech_signed_id = s.id));
end $function$;

create or replace function public.maint_list(p_emp text)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare s staff;
begin
  s := learn_who(p_emp);
  return jsonb_build_object(
    'cards', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'card_no', c.card_no, 'status', c.status, 'source', c.source,
        'location', c.location, 'equipment', c.equipment, 'problem', left(c.problem, 140), 'reported_by', c.reported_by, 'reported_at', c.reported_at,
        'tech_name', c.tech_name, 'hold_reason', c.hold_reason, 'completed_at', c.completed_at, 'checked_at', c.checked_at, 'checked_by', c.checked_by,
        'sent_back_at', c.sent_back_at, 'media', jsonb_array_length(c.media), 'is_test', c.is_test,
        'updated_at', c.updated_at, 'followup_at', c.followup_at, 'followup_by', c.followup_by,
        'photos', (select count(*) from jsonb_array_elements(c.media) m where m->>'kind' = 'photo'),
        'videos', (select count(*) from jsonb_array_elements(c.media) m where m->>'kind' = 'video'),
        'thumb', (select m->>'path' from jsonb_array_elements(c.media) m where m->>'kind' = 'photo' limit 1),
        'due', (select t.next_due from maint_tasks t where t.id = c.task_id))
      order by c.reported_at desc) from maint_cards c
      where c.checked_at is null or c.checked_at > now() - interval '120 days'), '[]'::jsonb));
end $function$;

create or replace function public.maint_step(p_emp text, p_id uuid, p_op text, p_args jsonb)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare s staff; c maint_cards; a jsonb := coalesce(p_args,'{}'::jsonb); v_tech boolean; v_chef boolean;
begin
  s := learn_who(p_emp);
  v_tech := maint_has(s.id,'technician'); v_chef := maint_has(s.id,'chef');
  select * into c from maint_cards where id = p_id for update;
  if c.id is null then raise exception 'no_card' using errcode = 'P0001'; end if;
  if c.checked_at is not null then raise exception 'closed' using errcode = 'P0001'; end if;

  if p_op in ('start','hold','resume','assess','complete') then
    if not v_tech then raise exception 'not_tech' using errcode = 'P0001'; end if;
    if c.status = 'completed' then raise exception 'completed' using errcode = 'P0001'; end if;
    update maint_cards set read_at = coalesce(read_at, now()), read_by = coalesce(read_by, s.name),
           tech_id = coalesce(tech_id, s.id), tech_name = coalesce(tech_name, s.name) where id = p_id;
  end if;

  if p_op = 'start' then
    update maint_cards set status = 'in_progress', started_at = coalesce(started_at, now()), hold_reason = null, updated_at = now() where id = p_id;
  elsif p_op = 'hold' then
    update maint_cards set status = 'on_hold', hold_at = now(), hold_reason = nullif(left(trim(coalesce(a->>'reason','')),200),''), updated_at = now() where id = p_id;
  elsif p_op = 'resume' then
    if c.status <> 'on_hold' then raise exception 'not_on_hold' using errcode = 'P0001'; end if;
    update maint_cards set status = 'in_progress', started_at = coalesce(started_at, now()), hold_reason = null, updated_at = now() where id = p_id;
  elsif p_op = 'assess' then
    update maint_cards set
      diagnosis = nullif(left(trim(coalesce(a->>'diagnosis','')),2000),''),
      cause     = nullif(left(trim(coalesce(a->>'cause','')),1000),''),
      solution  = nullif(left(trim(coalesce(a->>'solution','')),1000),''),
      est_cost  = maint_amount(a->>'est_cost'),
      est_time  = nullif(left(trim(coalesce(a->>'est_time','')),120),''),
      parts     = nullif(left(trim(coalesce(a->>'parts','')),1000),''),
      notes     = nullif(left(trim(coalesce(a->>'notes','')),2000),''),
      assessed_at = now(), assessed_by = s.name, updated_at = now()
    where id = p_id;
  elsif p_op = 'complete' then
    if trim(coalesce(a->>'code','')) <> trim(s.emp_id) then raise exception 'bad_code' using errcode = 'P0001'; end if;
    if length(trim(coalesce(a->>'work_done',''))) < 3 then raise exception 'no_work' using errcode = 'P0001'; end if;
    if maint_amount(a->>'final_cost') is null then raise exception 'no_cost' using errcode = 'P0001'; end if;
    update maint_cards set status = 'completed', work_done = left(trim(a->>'work_done'),2000), final_cost = maint_amount(a->>'final_cost'),
           completed_at = now(), tech_signed_id = s.id, tech_signed_by = s.name, hold_reason = null, updated_at = now()
     where id = p_id;
    perform maint_queue(p_id, 'check');
  elsif p_op = 'check' then
    if not v_chef then raise exception 'not_chef' using errcode = 'P0001'; end if;
    if c.status <> 'completed' then raise exception 'not_completed' using errcode = 'P0001'; end if;
    if trim(coalesce(a->>'code','')) <> trim(s.emp_id) then raise exception 'bad_code' using errcode = 'P0001'; end if;
    if c.tech_signed_id = s.id then raise exception 'same_person' using errcode = 'P0001'; end if;
    update maint_cards set checked_at = now(), checked_id = s.id, checked_by = s.name, updated_at = now() where id = p_id;
    if c.task_id is not null then perform maint_task_did(c.task_id, (c.completed_at at time zone 'Asia/Dubai')::date, c.tech_signed_by, 'Job card JC-' || lpad(c.card_no::text, 4, '0'), c.id); end if;
  elsif p_op = 'send_back' then
    if not v_chef then raise exception 'not_chef' using errcode = 'P0001'; end if;
    if c.status <> 'completed' then raise exception 'not_completed' using errcode = 'P0001'; end if;
    if length(trim(coalesce(a->>'note',''))) < 3 then raise exception 'no_note' using errcode = 'P0001'; end if;
    update maint_cards set status = 'in_progress', completed_at = null, tech_signed_id = null, tech_signed_by = null,
           sent_back_at = now(), sent_back_by = s.name, sent_back_note = left(trim(a->>'note'),500), updated_at = now() where id = p_id;
  elsif p_op = 'followup' then
    -- a reminder is not an update: updated_at stays, so the card still reads as untouched
    if not maint_has(s.id,'followup') then raise exception 'not_followup' using errcode = 'P0001'; end if;
    if c.status = 'completed' then raise exception 'completed' using errcode = 'P0001'; end if;
    if coalesce(c.updated_at, c.reported_at) > now() - maint_followup_after() then raise exception 'not_stale' using errcode = 'P0001'; end if;
    if c.followup_at is not null and c.followup_at > now() - maint_followup_after() then raise exception 'followed_up' using errcode = 'P0001'; end if;
    update maint_cards set followup_at = now(), followup_by = s.name, followup_count = followup_count + 1 where id = p_id;
    perform maint_queue(p_id, 'followup');
  else
    raise exception 'bad_op' using errcode = 'P0001';
  end if;
  select * into c from maint_cards where id = p_id;
  return maint_card_row(c);
end $function$;
