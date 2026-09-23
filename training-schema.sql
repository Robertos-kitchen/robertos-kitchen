-- Training sheets (Kitchen app) — Chef Danilo's idea through Tell us, 23 Sep 2026
-- (inbox b32d24e6): "the training format in the app for each section, same as a prep list,
-- with the chance to edit it and personalize with the name of the chef that will have the
-- training". The paper original is CHEF TRAINING LIST.xlsx (04 People & HR/training staff):
-- per section, a training day, then each dish, its components and "Assembly of the plate",
-- with Trainee / Trainer / Comment columns and the Executive Chef signing at the end.
--
-- One sheet = one trainee on one prep-list section. It is SEEDED from the live prep list
-- (dishes + dish_components) when it is made, then it is its own copy: editing a sheet never
-- touches the prep list, and a prep-list change never rewrites a sheet someone is ticking.
-- A dish that is new on the prep list is offered on the edit screen instead ("New on the menu").
--
-- Every table is RLS-on with NO policy; everything goes through the security-definer train_*
-- functions below. Sign-in is the employee ID, like Learning (learn_who).
--
-- Who can do what
--   · Editors = learn_checkers (Chef Danilo, Chef Antonio, Chef Andrea): make, edit, see every sheet.
--   · The sheet's trainee ticks the Trainee column; the sheet's trainer (or an editor) ticks the
--     Trainer column. Only the trainer's ticks count as progress.
--   · Sign-off = the Executive Chef (designation "Executive Chef" — Chef Danilo), only once every
--     line has the trainer's tick. A signed sheet is read-only.
--   · Anyone else signed in sees only the sheets they are trainee or trainer on.

create table if not exists train_sheets (
  id uuid primary key default gen_random_uuid(),
  station_key text not null,
  trainee_id uuid not null, trainee_name text not null, trainee_role text not null default '',
  trainer_id uuid not null, trainer_name text not null, trainer_role text not null default '',
  start_date date not null default current_date,
  status text not null default 'open' check (status in ('open','signed')),
  signed_by text, signed_at timestamptz,
  created_by text not null, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived boolean not null default false
);
create index if not exists train_sheets_station on train_sheets(station_key, archived);

create table if not exists train_groups (
  id uuid primary key default gen_random_uuid(),
  sheet_id uuid not null references train_sheets(id) on delete cascade,
  dish_id int,                              -- the prep-list dish it was copied from; null = own topic
  name text not null,
  day text check (day in ('Mon','Tue','Wed','Thu','Fri','Sat','Sun')),
  pos numeric not null default 0
);
create index if not exists train_groups_sheet on train_groups(sheet_id);

create table if not exists train_lines (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references train_groups(id) on delete cascade,
  name text not null,
  is_assembly boolean not null default false,
  pos numeric not null default 0,
  trainee_at timestamptz,
  trainer_at timestamptz, trainer_by text,
  comment text, comment_by text, comment_at timestamptz
);
create index if not exists train_lines_group on train_lines(group_id);

alter table train_sheets enable row level security;
alter table train_groups enable row level security;
alter table train_lines  enable row level security;
revoke all on train_sheets, train_groups, train_lines from anon, authenticated;

-- ── who is signing in ──────────────────────────────────────────────────────
create or replace function train_is_editor(p_staff uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select exists(select 1 from learn_checkers where staff_id = p_staff)
$$;
create or replace function train_is_exec(p_designation text) returns boolean
language sql immutable as $$
  select coalesce(p_designation,'') ~* '^\s*executive chef\s*$'
$$;

create or replace function train_me(p_emp text) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare s staff;
begin
  s := learn_who(p_emp);
  return jsonb_build_object('staff_id', s.id, 'name', s.name, 'designation', s.designation,
    'editor', train_is_editor(s.id), 'exec', train_is_exec(s.designation));
end $$;

-- The people a sheet can name: everyone active in the kitchen staff list.
create or replace function train_people(p_emp text) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare s staff;
begin
  s := learn_who(p_emp);
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'designation', designation) order by name)
    from staff where active and coalesce(designation,'') !~* 'steward'), '[]'::jsonb);
end $$;

-- ── lists ──────────────────────────────────────────────────────────────────
create or replace function train_sheet_counts(p_sheet uuid) returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object('lines', count(l.id), 'trainer', count(l.trainer_at), 'trainee', count(l.trainee_at))
  from train_groups g join train_lines l on l.group_id = g.id where g.sheet_id = p_sheet
$$;

create or replace function train_list(p_emp text, p_station text) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare s staff; ed boolean;
begin
  s := learn_who(p_emp); ed := train_is_editor(s.id) or train_is_exec(s.designation);
  return coalesce((select jsonb_agg(x order by x.status, x.start_date desc, x.trainee_name) from (
    select t.id, t.station_key, t.trainee_id, t.trainee_name, t.trainee_role, t.trainer_id, t.trainer_name, t.trainer_role,
      t.start_date, t.status, t.signed_by, t.signed_at, t.created_at,
      (select max(greatest(l.trainee_at, l.trainer_at)) from train_groups g join train_lines l on l.group_id = g.id where g.sheet_id = t.id) last_tick,
      train_sheet_counts(t.id) counts
    from train_sheets t
    where not t.archived and t.station_key = p_station
      and (ed or t.trainee_id = s.id or t.trainer_id = s.id)) x), '[]'::jsonb);
end $$;

create or replace function train_can_see(s staff, t train_sheets) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select train_is_editor(s.id) or train_is_exec(s.designation) or t.trainee_id = s.id or t.trainer_id = s.id
$$;

create or replace function train_get(p_emp text, p_sheet uuid) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare s staff; t train_sheets;
begin
  s := learn_who(p_emp);
  select * into t from train_sheets where id = p_sheet and not archived;
  if t.id is null then raise exception 'no_sheet' using errcode = 'P0001'; end if;
  if not train_can_see(s, t) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  return jsonb_build_object('sheet', to_jsonb(t), 'counts', train_sheet_counts(t.id),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'dish_id', g.dish_id, 'name', g.name, 'day', g.day, 'pos', g.pos,
        'lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'is_assembly', l.is_assembly, 'pos', l.pos,
            'trainee_at', l.trainee_at, 'trainer_at', l.trainer_at, 'trainer_by', l.trainer_by,
            'comment', l.comment, 'comment_by', l.comment_by, 'comment_at', l.comment_at) order by l.pos, l.id)
          from train_lines l where l.group_id = g.id), '[]'::jsonb))
      order by array_position(array['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], g.day) nulls last, g.pos, g.id)
      from train_groups g where g.sheet_id = t.id), '[]'::jsonb),
    -- dishes on this section's prep list today that the sheet does not carry yet
    'new_dishes', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name) order by d.sort_order, d.id)
      from dishes d where d.active and d.station_key = t.station_key
        and not exists(select 1 from train_groups g where g.sheet_id = t.id and g.dish_id = d.id)), '[]'::jsonb),
    'me', jsonb_build_object('trainee', t.trainee_id = s.id, 'trainer', t.trainer_id = s.id,
      'editor', train_is_editor(s.id), 'exec', train_is_exec(s.designation)));
end $$;

-- ── making a sheet ─────────────────────────────────────────────────────────
create or replace function train_seed_dish(p_sheet uuid, p_dish int, p_pos numeric) returns uuid
language plpgsql volatile security definer set search_path to 'public' as $$
declare gid uuid; d dishes;
begin
  select * into d from dishes where id = p_dish;
  insert into train_groups(sheet_id, dish_id, name, pos) values (p_sheet, d.id, trim(d.name), p_pos) returning id into gid;
  insert into train_lines(group_id, name, pos)
    select gid, trim(c.name), row_number() over (order by c.sort_order, c.id) * 10
    from dish_components c where c.dish_id = d.id and c.active and coalesce(trim(c.name),'') <> ''
      and trim(c.name) !~* '^prepare as needed$';
  insert into train_lines(group_id, name, is_assembly, pos)
    values (gid, 'Assembly of the plate', true, 100000);
  return gid;
end $$;

create or replace function train_create(p_emp text, p_station text, p_trainee uuid, p_trainer uuid, p_start date) returns jsonb
language plpgsql volatile security definer set search_path to 'public' as $$
declare s staff; te staff; tr staff; sid uuid; d record; i int := 0;
begin
  s := learn_who(p_emp);
  if not train_is_editor(s.id) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  if not exists(select 1 from stations where key = p_station and active) then raise exception 'no_station' using errcode = 'P0001'; end if;
  select * into te from staff where id = p_trainee and active;
  select * into tr from staff where id = p_trainer and active;
  if te.id is null or tr.id is null then raise exception 'no_person' using errcode = 'P0001'; end if;
  if te.id = tr.id then raise exception 'same_person' using errcode = 'P0001'; end if;
  insert into train_sheets(station_key, trainee_id, trainee_name, trainee_role, trainer_id, trainer_name, trainer_role, start_date, created_by)
    values (p_station, te.id, te.name, coalesce(te.designation,''), tr.id, tr.name, coalesce(tr.designation,''), coalesce(p_start, current_date), s.name)
    returning id into sid;
  for d in select dd.id from dishes dd where dd.active and dd.station_key = p_station order by dd.sort_order, dd.id loop
    i := i + 1; perform train_seed_dish(sid, d.id, i * 10);
  end loop;
  return jsonb_build_object('id', sid);
end $$;

-- ── ticking ────────────────────────────────────────────────────────────────
-- p_col: 'trainee' | 'trainer'; p_on: tick or untick.
create or replace function train_tick(p_emp text, p_line uuid, p_col text, p_on boolean) returns jsonb
language plpgsql volatile security definer set search_path to 'public' as $$
declare s staff; t train_sheets; ed boolean;
begin
  s := learn_who(p_emp); ed := train_is_editor(s.id);
  select ts.* into t from train_lines l join train_groups g on g.id = l.group_id join train_sheets ts on ts.id = g.sheet_id where l.id = p_line;
  if t.id is null then raise exception 'no_sheet' using errcode = 'P0001'; end if;
  if t.status = 'signed' then raise exception 'signed' using errcode = 'P0001'; end if;
  if p_col = 'trainee' then
    if not (t.trainee_id = s.id or t.trainer_id = s.id or ed) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
    update train_lines set trainee_at = case when p_on then coalesce(trainee_at, now()) end where id = p_line;
  elsif p_col = 'trainer' then
    if not (t.trainer_id = s.id or ed) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
    update train_lines set trainer_at = case when p_on then coalesce(trainer_at, now()) end,
                           trainer_by = case when p_on then coalesce(trainer_by, s.name) end where id = p_line;
  else raise exception 'bad_col' using errcode = 'P0001'; end if;
  update train_sheets set updated_at = now() where id = t.id;
  return jsonb_build_object('ok', true, 'counts', train_sheet_counts(t.id));
end $$;

create or replace function train_comment(p_emp text, p_line uuid, p_text text) returns jsonb
language plpgsql volatile security definer set search_path to 'public' as $$
declare s staff; t train_sheets;
begin
  s := learn_who(p_emp);
  select ts.* into t from train_lines l join train_groups g on g.id = l.group_id join train_sheets ts on ts.id = g.sheet_id where l.id = p_line;
  if t.id is null then raise exception 'no_sheet' using errcode = 'P0001'; end if;
  if t.status = 'signed' then raise exception 'signed' using errcode = 'P0001'; end if;
  if not train_can_see(s, t) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  update train_lines set comment = nullif(trim(coalesce(p_text,'')), ''),
    comment_by = case when nullif(trim(coalesce(p_text,'')), '') is null then null else s.name end,
    comment_at = case when nullif(trim(coalesce(p_text,'')), '') is null then null else now() end
  where id = p_line;
  return jsonb_build_object('ok', true);
end $$;

create or replace function train_signoff(p_emp text, p_sheet uuid) returns jsonb
language plpgsql volatile security definer set search_path to 'public' as $$
declare s staff; t train_sheets; c jsonb;
begin
  s := learn_who(p_emp);
  if not train_is_exec(s.designation) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  select * into t from train_sheets where id = p_sheet and not archived;
  if t.id is null then raise exception 'no_sheet' using errcode = 'P0001'; end if;
  if t.status = 'signed' then raise exception 'signed' using errcode = 'P0001'; end if;
  c := train_sheet_counts(t.id);
  if (c->>'lines')::int = 0 or (c->>'trainer')::int < (c->>'lines')::int then raise exception 'not_finished' using errcode = 'P0001'; end if;
  update train_sheets set status = 'signed', signed_by = s.name, signed_at = now(), updated_at = now() where id = t.id;
  return jsonb_build_object('ok', true);
end $$;

-- ── editing (editors only, open sheets only) ───────────────────────────────
-- One door for every edit, so the rule is written once.
--   op: 'rename_line' {id,name} · 'add_line' {group,name} · 'remove_line' {id}
--       'move_line' {id,pos} · 'rename_group' {id,name} · 'set_day' {id,day|null}
--       'add_group' {name,day} · 'remove_group' {id} · 'add_dish' {dish}
--       'set_people' {trainee,trainer} · 'archive' {}
create or replace function train_edit(p_emp text, p_sheet uuid, p_op text, p_args jsonb) returns jsonb
language plpgsql volatile security definer set search_path to 'public' as $$
declare s staff; t train_sheets; g train_groups; nm text; gid uuid; te staff; tr staff; mx numeric;
begin
  s := learn_who(p_emp);
  if not train_is_editor(s.id) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  select * into t from train_sheets where id = p_sheet and not archived;
  if t.id is null then raise exception 'no_sheet' using errcode = 'P0001'; end if;
  if t.status = 'signed' then raise exception 'signed' using errcode = 'P0001'; end if;
  nm := nullif(trim(coalesce(p_args->>'name','')), '');

  if p_op in ('rename_line','remove_line','move_line') then
    if not exists(select 1 from train_lines l join train_groups gg on gg.id = l.group_id
                  where l.id = (p_args->>'id')::uuid and gg.sheet_id = t.id) then raise exception 'no_line' using errcode = 'P0001'; end if;
  end if;
  if p_op in ('rename_group','set_day','remove_group','add_line') then
    select * into g from train_groups where id = coalesce(p_args->>'id', p_args->>'group')::uuid and sheet_id = t.id;
    if g.id is null then raise exception 'no_group' using errcode = 'P0001'; end if;
  end if;

  if p_op = 'rename_line' then
    if nm is null then raise exception 'no_name' using errcode = 'P0001'; end if;
    update train_lines set name = nm where id = (p_args->>'id')::uuid;
  elsif p_op = 'remove_line' then
    delete from train_lines where id = (p_args->>'id')::uuid;
  elsif p_op = 'move_line' then
    update train_lines set pos = (p_args->>'pos')::numeric where id = (p_args->>'id')::uuid;
  elsif p_op = 'add_line' then
    if nm is null then raise exception 'no_name' using errcode = 'P0001'; end if;
    -- a new line goes above "Assembly of the plate", which stays the last step
    select coalesce(max(pos), 0) into mx from train_lines where group_id = g.id and not is_assembly;
    insert into train_lines(group_id, name, pos) values (g.id, nm, mx + 10);
  elsif p_op = 'rename_group' then
    if nm is null then raise exception 'no_name' using errcode = 'P0001'; end if;
    update train_groups set name = nm where id = g.id;
  elsif p_op = 'set_day' then
    update train_groups set day = nullif(p_args->>'day','') where id = g.id;
  elsif p_op = 'remove_group' then
    delete from train_groups where id = g.id;
  elsif p_op = 'add_group' then
    if nm is null then raise exception 'no_name' using errcode = 'P0001'; end if;
    select coalesce(max(pos), 0) into mx from train_groups where sheet_id = t.id;
    insert into train_groups(sheet_id, name, day, pos) values (t.id, nm, nullif(p_args->>'day',''), mx + 10) returning id into gid;
    return jsonb_build_object('ok', true, 'id', gid);
  elsif p_op = 'add_dish' then
    if not exists(select 1 from dishes where id = (p_args->>'dish')::int and active and station_key = t.station_key) then
      raise exception 'no_dish' using errcode = 'P0001'; end if;
    if exists(select 1 from train_groups where sheet_id = t.id and dish_id = (p_args->>'dish')::int) then
      raise exception 'already_there' using errcode = 'P0001'; end if;
    select coalesce(max(pos), 0) into mx from train_groups where sheet_id = t.id;
    gid := train_seed_dish(t.id, (p_args->>'dish')::int, mx + 10);
    return jsonb_build_object('ok', true, 'id', gid);
  elsif p_op = 'set_people' then
    select * into te from staff where id = (p_args->>'trainee')::uuid and active;
    select * into tr from staff where id = (p_args->>'trainer')::uuid and active;
    if te.id is null or tr.id is null then raise exception 'no_person' using errcode = 'P0001'; end if;
    if te.id = tr.id then raise exception 'same_person' using errcode = 'P0001'; end if;
    update train_sheets set trainee_id = te.id, trainee_name = te.name, trainee_role = coalesce(te.designation,''),
      trainer_id = tr.id, trainer_name = tr.name, trainer_role = coalesce(tr.designation,'') where id = t.id;
  elsif p_op = 'archive' then
    update train_sheets set archived = true where id = t.id;
  else raise exception 'bad_op' using errcode = 'P0001'; end if;

  update train_sheets set updated_at = now() where id = t.id;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function train_seed_dish(uuid,int,numeric), train_can_see(staff,train_sheets), train_sheet_counts(uuid),
  train_is_editor(uuid) from public, anon, authenticated;
grant execute on function train_me(text), train_people(text), train_list(text,text), train_get(text,uuid),
  train_create(text,text,uuid,uuid,date), train_tick(text,uuid,text,boolean), train_comment(text,uuid,text),
  train_signoff(text,uuid), train_edit(text,uuid,text,jsonb) to anon, authenticated;
