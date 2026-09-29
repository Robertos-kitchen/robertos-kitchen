-- Learning: a test has a time limit (Chef Francesco, 29 Sep 2026: "they could cheat by
-- using ai" ... "go with the time based on question length, don't be too rigid").
-- Each question earns 15 s + 0.7 s a word (question + the four answers), 25..90 s, plus
-- 10 s for a plate question (photos to look at). The seconds are added up into ONE clock
-- for the whole test, so a hard question can borrow from an easy one. The screen counts
-- down and hands in when it reaches 0; the database allows 30 s of grace for a slow
-- connection and after that the attempt cannot pass.

alter table learn_attempts add column if not exists time_limit int;
alter table learn_attempts add column if not exists late boolean not null default false;

create or replace function public.learn_q_secs(p_id uuid) returns int
language sql stable security definer set search_path to 'public' as $$
  select least(90, greatest(25, round(15 + 0.7 * coalesce(array_length(regexp_split_to_array(trim(
           q.q || ' ' || q.answer || ' ' || coalesce((select string_agg(x, ' ') from jsonb_array_elements_text(q.wrong) x), '')), '\s+'), 1), 0))))::int
       + case when q.gen_key like 'plate:%' then 10 else 0 end
  from learn_questions q where q.id = p_id;
$$;
revoke execute on function public.learn_q_secs(uuid) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.learn_start(p_emp text, p_topic text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare s staff; lv text; t learn_topics; ids uuid[]; served jsonb := '[]'::jsonb; shown jsonb := '[]'::jsonb;
        one jsonb; sh jsonb; r record; aid uuid; secs int; lim int := 0;
begin
  s := learn_who(p_emp); lv := learn_level(s.designation);
  select * into t from learn_topics where id = p_topic and active;
  if t.id is null or (t.senior_only and lv <> 'senior') then raise exception 'no_topic' using errcode = 'P0001'; end if;
  select array_agg(id) into ids from (
    select id from learn_questions where topic_id = p_topic and status = 'approved' and learn_level_ok(lv, level)
    order by random() limit 5) z;
  if coalesce(array_length(ids,1),0) < 5 then raise exception 'not_ready' using errcode = 'P0001'; end if;
  for r in select q.id, q.q, q.answer, q.wrong,
      (select jsonb_agg(c order by random()) from jsonb_array_elements_text(jsonb_build_array(q.answer) || q.wrong) c) choices
    from learn_questions q join unnest(ids) with ordinality u(id, n) on u.id = q.id order by u.n
  loop
    one := jsonb_build_object('id', r.id, 'q', r.q, 'choices', r.choices);
    served := served || one; -- what is kept: the words only
    -- the photographs of the plate, one set per answer, so nobody has to know
    -- the technical name of a plate to answer (Chef Andrea, 22 Sep 2026)
    sh := learn_q_shots(r.answer, r.wrong);
    secs := learn_q_secs(r.id); lim := lim + secs;
    shown := shown || ((case when sh is null then one else one || jsonb_build_object('shots', sh) end) || jsonb_build_object('secs', secs));
  end loop;
  insert into learn_attempts(staff_id, name, topic_id, qids, served, time_limit)
    values (s.id, s.name, p_topic, ids, served, lim) returning id into aid;
  return jsonb_build_object('attempt', aid, 'title', t.title, 'questions', shown, 'limit', lim);
end $function$;

CREATE OR REPLACE FUNCTION public.learn_finish(p_emp text, p_attempt uuid, p_answers jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare s staff; a learn_attempts; res jsonb := '[]'::jsonb; i int; q learn_questions; pick text; sh jsonb; ok int := 0; lt boolean;
begin
  s := learn_who(p_emp);
  select * into a from learn_attempts where id = p_attempt and staff_id = s.id;
  if a.id is null then raise exception 'no_attempt' using errcode = 'P0001'; end if;
  if a.finished_at is not null then raise exception 'already_finished' using errcode = 'P0001'; end if;
  -- the clock is the database's, not the phone's: 30 s of grace for a slow connection
  lt := a.time_limit is not null and now() > a.started_at + make_interval(secs => a.time_limit + 30);
  for i in 1 .. array_length(a.qids,1) loop
    select * into q from learn_questions where id = a.qids[i];
    pick := p_answers ->> (i-1);
    if coalesce(pick = q.answer, false) then ok := ok + 1; end if;
    sh := learn_q_shots(q.answer, q.wrong);
    res := res || jsonb_build_object('q', q.q, 'picked', pick, 'answer', q.answer, 'right', coalesce(pick = q.answer, false), 'why', q.why,
      'shot', case when sh is null then null else sh -> q.answer end,
      'pshot', case when sh is null or pick is null then null else sh -> pick end);
  end loop;
  update learn_attempts set answers = p_answers, score = ok, total = array_length(a.qids,1), passed = ok >= 4 and not lt, late = lt, finished_at = now()
    where id = a.id;
  return jsonb_build_object('score', ok, 'total', array_length(a.qids,1), 'passed', ok >= 4 and not lt, 'late', lt, 'results', res);
end $function$;

-- A late attempt keeps its answers but is not a score: the best score shown on the
-- person's home and in Scores ignores it, so "5/5" never appears without a pass.
do $$
declare d text; n text;
begin
  select pg_get_functiondef('public.learn_home(text)'::regprocedure) into d;
  n := replace(d, 'a.topic_id = t.id and a.finished_at is not null) best', 'a.topic_id = t.id and a.finished_at is not null and not a.late) best');
  if n = d then raise exception 'learn_home: pattern not found'; end if;
  execute n;
  select pg_get_functiondef('public.learn_scores(text,text)'::regprocedure) into d;
  n := replace(d, 'max(score) best', 'max(score) filter (where not late) best');
  if n = d then raise exception 'learn_scores: pattern not found'; end if;
  execute n;
end $$;
