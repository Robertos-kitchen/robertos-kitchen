-- Learning: the mixed test and new question formats (9 Oct 2026).
-- Francesco: "can each test have 20 questions with 5 topics mixed?"; picked four formats: pick all
-- that apply, put in the right order, match the pairs, photo questions (plate photos already exist).
--
-- ONE production database serves the DEV and LIVE Kitchen screens, so everything here is ADDITIVE:
-- · the LIVE screen keeps its per-topic test (learn_start/learn_finish) and only ever sees classic
--   pick-one questions: learn_start, learn_home and the 2-argument learn_queue now skip any other type;
-- · the new screen (DEV first) calls learn_start_mix / learn_finish_mix and the 3-argument learn_queue.
-- Question types: one (answer + wrong[3]) · multi (data.answers[] + wrong[>=1]) ·
-- order (data.items[] in the right order) · match (data.pairs[[left,right]]).

alter table public.learn_questions add column if not exists qtype text not null default 'one';
alter table public.learn_questions add column if not exists data jsonb;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'learn_questions_qtype_check') then
    alter table public.learn_questions add constraint learn_questions_qtype_check check (qtype in ('one','multi','order','match'));
  end if;
end $$;
-- the old rule "exactly 3 wrong answers" now holds for pick-one only
do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid = 'public.learn_questions'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%jsonb_array_length(wrong) = 3%' loop
    execute format('alter table public.learn_questions drop constraint %I', c);
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'learn_questions_shape_check') then
    alter table public.learn_questions add constraint learn_questions_shape_check check (
      (qtype = 'one'   and jsonb_typeof(wrong) = 'array' and jsonb_array_length(wrong) = 3) or
      (qtype = 'multi' and jsonb_typeof(wrong) = 'array' and jsonb_array_length(wrong) >= 1 and jsonb_array_length(coalesce(data->'answers','[]')) >= 2) or
      (qtype = 'order' and jsonb_array_length(coalesce(data->'items','[]')) >= 3) or
      (qtype = 'match' and jsonb_array_length(coalesce(data->'pairs','[]')) >= 3));
  end if;
end $$;

alter table public.learn_attempts add column if not exists per_topic jsonb;
alter table public.learn_attempts add column if not exists topics text[];
-- mixed attempts need a topic row for the foreign key; inactive, so no screen lists it
insert into public.learn_topics(id, pos, title, summary, senior_only, active) values ('mixed', 999, 'Mixed test', '20 questions from 5 topics', false, false)
  on conflict (id) do nothing;

-- ── LIVE screen protection: classic pick-one only ──
create or replace function public.learn_start(p_emp text, p_topic text)
 returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare s staff; lv text; t learn_topics; ids uuid[]; served jsonb := '[]'::jsonb; shown jsonb := '[]'::jsonb;
        one jsonb; sh jsonb; r record; aid uuid; secs int; lim int := 0;
begin
  s := learn_student(p_emp); lv := learn_level(s.designation);
  select * into t from learn_topics where id = p_topic and active;
  if t.id is null or (t.senior_only and lv <> 'senior') then raise exception 'no_topic' using errcode = 'P0001'; end if;
  select array_agg(id) into ids from (
    select id from learn_questions where topic_id = p_topic and status = 'approved' and qtype = 'one' and learn_level_ok(lv, level)
    order by random() limit 5) z;
  if coalesce(array_length(ids,1),0) < 5 then raise exception 'not_ready' using errcode = 'P0001'; end if;
  for r in select q.id, q.q, q.answer, q.wrong,
      (select jsonb_agg(c order by random()) from jsonb_array_elements_text(jsonb_build_array(q.answer) || q.wrong) c) choices
    from learn_questions q join unnest(ids) with ordinality u(id, n) on u.id = q.id order by u.n
  loop
    one := jsonb_build_object('id', r.id, 'q', r.q, 'choices', r.choices);
    served := served || one;
    sh := learn_q_shots(r.answer, r.wrong);
    secs := learn_q_secs(r.id); lim := lim + secs;
    shown := shown || ((case when sh is null then one else one || jsonb_build_object('shots', sh) end) || jsonb_build_object('secs', secs));
  end loop;
  insert into learn_attempts(staff_id, name, topic_id, qids, served, time_limit)
    values (s.id, s.name, p_topic, ids, served, lim) returning id into aid;
  return jsonb_build_object('attempt', aid, 'title', t.title, 'questions', shown, 'limit', lim);
end $function$;

create or replace function public.learn_home(p_emp text)
 returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare s staff; lv text;
begin
  s := learn_student(p_emp); lv := learn_level(s.designation);
  return coalesce((select jsonb_agg(x order by x.pos) from (
    select t.id, t.pos, t.title, t.summary, t.senior_only, t.expires_months,
      (select count(*) from learn_pages p where p.topic_id = t.id and p.status = 'approved') pages,
      (select count(*) from learn_questions q where q.topic_id = t.id and q.status = 'approved' and q.qtype = 'one'
         and learn_level_ok(lv, q.level)) questions,
      (select count(*) from learn_questions q where q.topic_id = t.id and q.status = 'approved'
         and learn_level_ok(lv, q.level)) questions_all,
      (select max(a.score) from learn_attempts a where a.staff_id = s.id and a.topic_id = t.id and a.finished_at is not null and not a.late) best,
      (select max(a.finished_at) from learn_attempts a where a.staff_id = s.id and a.topic_id = t.id and a.passed) passed_at,
      (select count(*) from learn_attempts a where a.staff_id = s.id and a.topic_id = t.id and a.finished_at is not null) tries
    from learn_topics t
    where t.active and (not t.senior_only or lv = 'senior')) x), '[]'::jsonb);
end $function$;

-- the 2-argument queue (LIVE screen) shows pick-one only; the new screen asks with p_all => true
create or replace function public.learn_queue(p_emp text, p_code text, p_all boolean)
 returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare r jsonb;
begin
  r := learn_role(p_emp, p_code);
  return jsonb_build_object('role', r,
    'topics', (select jsonb_agg(jsonb_build_object('id',id,'title',title,'pos',pos) order by pos) from learn_topics where active),
    'pages', coalesce((select jsonb_agg(to_jsonb(p) order by t.pos, p.pos) from learn_pages p join learn_topics t on t.id = p.topic_id), '[]'::jsonb),
    'questions', coalesce((select jsonb_agg(to_jsonb(lq) - 'gen_sig' order by t.pos, lq.source, lq.updated_at) from learn_questions lq join learn_topics t on t.id = lq.topic_id
                            where coalesce(p_all, false) or lq.qtype = 'one'), '[]'::jsonb));
end $function$;
create or replace function public.learn_queue(p_emp text, p_code text)
 returns jsonb language sql stable security definer set search_path to 'public' as $function$
  select public.learn_queue(p_emp, p_code, false)
$function$;

-- a checker can fix a new-format question's items too (old screen never sends data)
create or replace function public.learn_step(p_emp text, p_code text, p_kind text, p_id uuid, p_action text, p_fields jsonb, p_note text)
 returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare r jsonb; v_role text; who text; cur text;
begin
  r := learn_role(p_emp, p_code); v_role := r->>'role'; who := r->>'name';
  if p_kind = 'q' then select status into cur from learn_questions where id = p_id;
  elsif p_kind = 'p' then select status into cur from learn_pages where id = p_id;
  else raise exception 'bad_kind' using errcode = 'P0001'; end if;
  if cur is null then raise exception 'not_found' using errcode = 'P0001'; end if;
  if p_fields is not null and p_fields <> '{}'::jsonb then
    if v_role = 'writer' then raise exception 'not_allowed' using errcode = 'P0001'; end if;
    if p_kind = 'q' then
      update learn_questions set
        q = coalesce(p_fields->>'q', q), answer = coalesce(p_fields->>'answer', answer),
        wrong = coalesce(p_fields->'wrong', wrong), why = coalesce(p_fields->>'why', why),
        level = coalesce(p_fields->>'level', level), data = coalesce(p_fields->'data', data),
        status = 'draft', checked_by = null, checked_at = null, approved_by = null, approved_at = null,
        updated_at = now() where id = p_id;
    else
      update learn_pages set
        title = coalesce(p_fields->>'title', title), body = coalesce(p_fields->>'body', body),
        photo = case when p_fields ? 'photo' then nullif(p_fields->>'photo','') else photo end,
        status = 'draft', checked_by = null, checked_at = null, approved_by = null, approved_at = null,
        updated_at = now() where id = p_id;
    end if;
    cur := 'draft';
  end if;
  if p_action = 'ok' then
    if v_role <> 'checker' then raise exception 'not_allowed' using errcode = 'P0001'; end if;
    if cur <> 'draft' then raise exception 'not_draft' using errcode = 'P0001'; end if;
    if p_kind = 'q' then update learn_questions set status='checked', checked_by=who, checked_at=now(), note=nullif(trim(coalesce(p_note,'')),''), updated_at=now() where id=p_id;
    else update learn_pages set status='checked', checked_by=who, checked_at=now(), note=nullif(trim(coalesce(p_note,'')),''), updated_at=now() where id=p_id; end if;
  elsif p_action = 'approve' then
    if v_role <> 'francesco' then raise exception 'not_allowed' using errcode = 'P0001'; end if;
    if cur <> 'checked' then raise exception 'not_checked' using errcode = 'P0001'; end if;
    if p_kind = 'q' then update learn_questions set status='approved', approved_by=who, approved_at=now(), updated_at=now() where id=p_id;
    else update learn_pages set status='approved', approved_by=who, approved_at=now(), updated_at=now() where id=p_id; end if;
  elsif p_action in ('reject','back') then
    if v_role not in ('checker','francesco') then raise exception 'not_allowed' using errcode = 'P0001'; end if;
    if p_kind = 'q' then update learn_questions set status = case when p_action='reject' then 'rejected' else 'draft' end,
        checked_by=null, checked_at=null, approved_by=null, approved_at=null,
        note = nullif(trim(coalesce(p_note,'')),'') , updated_at=now() where id=p_id;
    else update learn_pages set status = case when p_action='reject' then 'rejected' else 'draft' end,
        checked_by=null, checked_at=null, approved_by=null, approved_at=null,
        note = nullif(trim(coalesce(p_note,'')),'') , updated_at=now() where id=p_id; end if;
  elsif p_action <> 'edit' then
    raise exception 'bad_action' using errcode = 'P0001';
  end if;
  return jsonb_build_object('ok', true);
end $function$;

-- seconds for any question: Dubai's formula on all of its words; order and match get 15 s more
create or replace function public.learn_q_secs2(p_q jsonb) returns int
language sql immutable as $$
  select least(120, greatest(25, round(15 + 0.7 * coalesce(array_length(regexp_split_to_array(trim(
    coalesce(p_q->>'q','') || ' ' || coalesce(p_q->>'answer','') || ' ' ||
    coalesce((select string_agg(x, ' ') from jsonb_array_elements_text(coalesce(p_q->'wrong','[]') || coalesce(p_q->'data'->'answers','[]') || coalesce(p_q->'data'->'items','[]')) x), '') || ' ' ||
    coalesce((select string_agg((p->>0) || ' ' || (p->>1), ' ') from jsonb_array_elements(coalesce(p_q->'data'->'pairs','[]')) p), '')), '\s+'), 1), 0))))::int
    + case when p_q->>'qtype' in ('order','match') then 15 else 0 end
    + case when p_q->>'gen_key' like 'plate:%' then 10 else 0 end
$$;
create or replace function public.learn_shuffle(p jsonb) returns jsonb
language sql volatile as $$ select coalesce(jsonb_agg(x order by random()), '[]'::jsonb) from jsonb_array_elements(coalesce(p,'[]')) x $$;

-- ── the mixed test: 20 questions = 5 random topics x 4 random questions ──
create or replace function public.learn_start_mix(p_emp text)
 returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare s staff; lv text; tp record; q record; qj jsonb; served jsonb := '[]'::jsonb; shown jsonb := '[]'::jsonb; ids uuid[] := '{}';
        picked text[] := '{}'; lim int := 0; aid uuid; sh jsonb; item jsonb; srv jsonb;
begin
  s := learn_student(p_emp); lv := learn_level(s.designation);
  for tp in
    select t.id, t.title from learn_topics t
     where t.active and (not t.senior_only or lv = 'senior')
       and (select count(*) from learn_questions x where x.topic_id = t.id and x.status = 'approved' and learn_level_ok(lv, x.level)) >= 4
     order by random() limit 5
  loop
    picked := picked || tp.title;
    for q in select * from learn_questions x where x.topic_id = tp.id and x.status = 'approved' and learn_level_ok(lv, x.level) order by random() limit 4 loop
      qj := to_jsonb(q);
      ids := ids || q.id;
      if q.qtype = 'multi' then
        item := jsonb_build_object('id', q.id, 'topic', tp.title, 'type', 'multi', 'q', q.q, 'choices', learn_shuffle((q.data->'answers') || q.wrong));
      elsif q.qtype = 'order' then
        item := jsonb_build_object('id', q.id, 'topic', tp.title, 'type', 'order', 'q', q.q, 'items', learn_shuffle(q.data->'items'));
      elsif q.qtype = 'match' then
        item := jsonb_build_object('id', q.id, 'topic', tp.title, 'type', 'match', 'q', q.q,
                  'lefts', (select jsonb_agg(p->0 order by n) from jsonb_array_elements(q.data->'pairs') with ordinality u(p, n)),
                  'rights', learn_shuffle((select jsonb_agg(p->1) from jsonb_array_elements(q.data->'pairs') p)));
      else
        sh := learn_q_shots(q.answer, q.wrong);
        item := jsonb_build_object('id', q.id, 'topic', tp.title, 'type', 'one', 'q', q.q, 'choices', learn_shuffle(jsonb_build_array(q.answer) || (q.wrong)));
        if sh is not null then item := item || jsonb_build_object('shots', sh); end if;
      end if;
      served := served || jsonb_build_array(jsonb_build_object('id', q.id, 'topic', tp.title, 'type', q.qtype) || case when q.qtype in ('order','match') then jsonb_build_object('shown', item) else '{}'::jsonb end);
      shown := shown || jsonb_build_array(item);
      lim := lim + learn_q_secs2(qj);
    end loop;
  end loop;
  if jsonb_array_length(shown) = 0 then raise exception 'not_ready' using errcode = 'P0001'; end if;
  -- mix the topics together, keeping each question beside its record
  select jsonb_agg(a order by r), jsonb_agg(b order by r), array_agg((a->>'id')::uuid order by r) into served, shown, ids
    from (select a, b, random() r from jsonb_array_elements(served) with ordinality sa(a, n) join jsonb_array_elements(shown) with ordinality sb(b, m) on n = m) z;
  insert into learn_attempts(staff_id, name, topic_id, qids, served, time_limit, topics)
    values (s.id, s.name, 'mixed', ids, served, lim, picked) returning id into aid;
  return jsonb_build_object('attempt', aid, 'title', 'Mixed test', 'questions', shown, 'limit', lim, 'pass', ceil(jsonb_array_length(shown) * 0.8)::int, 'topics', to_jsonb(picked));
end $function$;

create or replace function public.learn_finish_mix(p_emp text, p_attempt uuid, p_answers jsonb)
 returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare s staff; a learn_attempts; res jsonb := '[]'::jsonb; i int; q learn_questions; pick jsonb; good boolean; ok int := 0; lt boolean; n int; pass_at int;
        per jsonb := '{}'::jsonb; tt text; key_txt text; pick_txt text; sh jsonb; key jsonb; lefts jsonb;
begin
  s := learn_student(p_emp);
  select * into a from learn_attempts where id = p_attempt and staff_id = s.id and topic_id = 'mixed';
  if a.id is null then raise exception 'no_attempt' using errcode = 'P0001'; end if;
  if a.finished_at is not null then raise exception 'already_finished' using errcode = 'P0001'; end if;
  lt := a.time_limit is not null and now() > a.started_at + make_interval(secs => a.time_limit + 30);
  n := array_length(a.qids, 1);
  for i in 1 .. n loop
    select * into q from learn_questions where id = a.qids[i];
    pick := case when jsonb_typeof(p_answers) = 'array' then p_answers -> (i-1) end;
    tt := coalesce(a.served -> (i-1) ->> 'topic', '?');
    sh := null;
    if q.qtype = 'multi' then
      key := q.data->'answers';
      good := jsonb_typeof(pick) = 'array' and (select coalesce(array_agg(x order by x), '{}') from jsonb_array_elements_text(pick) x) = (select array_agg(x order by x) from jsonb_array_elements_text(key) x);
      key_txt := (select string_agg(x, ' · ') from jsonb_array_elements_text(key) x);
      pick_txt := case when jsonb_typeof(pick) = 'array' then (select string_agg(x, ' · ') from jsonb_array_elements_text(pick) x) end;
    elsif q.qtype = 'order' then
      key := q.data->'items'; good := pick = key;
      key_txt := (select string_agg(x, ' → ') from jsonb_array_elements_text(key) x);
      pick_txt := case when jsonb_typeof(pick) = 'array' then (select string_agg(x, ' → ') from jsonb_array_elements_text(pick) x) end;
    elsif q.qtype = 'match' then
      key := (select jsonb_agg(p->1 order by k) from jsonb_array_elements(q.data->'pairs') with ordinality u(p, k));
      lefts := (select jsonb_agg(p->0 order by k) from jsonb_array_elements(q.data->'pairs') with ordinality u(p, k));
      good := pick = key;
      key_txt := (select string_agg((lefts->>(k-1)::int) || ' → ' || x, ' · ' order by k) from jsonb_array_elements_text(key) with ordinality u(x, k));
      pick_txt := case when jsonb_typeof(pick) = 'array' then (select string_agg((lefts->>(k-1)::int) || ' → ' || coalesce(x, '?'), ' · ' order by k) from jsonb_array_elements_text(pick) with ordinality u(x, k)) end;
    else
      good := pick #>> '{}' = q.answer; key_txt := q.answer; pick_txt := pick #>> '{}';
      sh := learn_q_shots(q.answer, q.wrong);
    end if;
    good := coalesce(good, false);
    if good then ok := ok + 1; end if;
    per := jsonb_set(per, array[tt], jsonb_build_object('right', coalesce((per->tt->>'right')::int, 0) + case when good then 1 else 0 end, 'of', coalesce((per->tt->>'of')::int, 0) + 1));
    res := res || jsonb_build_array(jsonb_build_object('q', q.q, 'topic', tt, 'type', q.qtype, 'picked', pick_txt, 'answer', key_txt, 'right', good, 'why', q.why,
      'shot', case when sh is null then null else sh -> q.answer end,
      'pshot', case when sh is null or pick_txt is null then null else sh -> pick_txt end));
  end loop;
  pass_at := ceil(n * 0.8)::int;
  update learn_attempts set answers = p_answers, score = ok, total = n, passed = ok >= pass_at and not lt, late = lt, per_topic = per, finished_at = now() where id = a.id;
  return jsonb_build_object('score', ok, 'total', n, 'pass', pass_at, 'passed', ok >= pass_at and not lt, 'late', lt, 'per_topic', per, 'results', res);
end $function$;

-- my mixed-test results, for the new home screen
create or replace function public.learn_mix_history(p_emp text)
 returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare s staff;
begin
  s := learn_student(p_emp);
  return coalesce((select jsonb_agg(jsonb_build_object('at', finished_at, 'score', score, 'total', total, 'passed', passed, 'late', late, 'per_topic', per_topic) order by finished_at desc)
    from (select * from learn_attempts where staff_id = s.id and topic_id = 'mixed' and finished_at is not null order by finished_at desc limit 10) x), '[]'::jsonb);
end $function$;

revoke all on function public.learn_shuffle(jsonb), public.learn_q_secs2(jsonb) from public;
grant execute on function public.learn_start_mix(text), public.learn_finish_mix(text,uuid,jsonb), public.learn_mix_history(text),
  public.learn_queue(text,text,boolean) to anon, authenticated;
