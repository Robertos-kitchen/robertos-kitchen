-- Learning: a test that is about the page just read (Chef Andrea, Tell us 26a8a78c, 5 Nov 2026).
-- 1. Reading a topic then taking its test gives 10 questions on THAT topic + 20 general knowledge
--    (questions with source 'general' from the other topics). 80% passes (24 of 30).
-- 2. learn_mix_history now returns every finished test (was the last 10), each with its topic and time.
-- 3. learn_scores picks a person's best by percentage, because tests are now 20 or 30 questions long.
-- ONE database serves DEV and LIVE: everything is additive. learn_start_mix / learn_finish_mix are untouched
-- (finish works as is: it reads each question's label from the attempt).

alter table public.learn_attempts add column if not exists focus text;

create or replace function public.learn_start_topic(p_emp text, p_topic text)
 returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare s staff; lv text; t learn_topics; q record; qj jsonb; item jsonb; sh jsonb; lbl text;
        served jsonb := '[]'::jsonb; shown jsonb := '[]'::jsonb; ids uuid[] := '{}'; lim int := 0; aid uuid;
        n_topic int := 0; n_gen int := 0;
begin
  s := learn_student(p_emp); lv := learn_level(s.designation);
  select * into t from learn_topics where id = p_topic and active and id not in ('mixed','topictest');
  if t.id is null or (t.senior_only and lv <> 'senior') then raise exception 'no_topic' using errcode = 'P0001'; end if;
  for q in
    select * from (
      (select x.*, 1 as grp, random() as r from learn_questions x
        where x.topic_id = p_topic and x.status = 'approved' and learn_level_ok(lv, x.level) order by r limit 10)
      union all
      (select x.*, 2 as grp, random() as r from learn_questions x join learn_topics gt on gt.id = x.topic_id
        where x.source = 'general' and x.topic_id <> p_topic and gt.active and gt.id not in ('mixed','topictest')
          and (not gt.senior_only or lv = 'senior') and x.status = 'approved' and learn_level_ok(lv, x.level) order by r limit 20)
    ) u order by grp, r
  loop
    if q.grp = 1 then n_topic := n_topic + 1; lbl := t.title; else n_gen := n_gen + 1; lbl := 'General knowledge'; end if;
    qj := to_jsonb(q);
    ids := ids || q.id;
    if q.qtype = 'multi' then
      item := jsonb_build_object('id', q.id, 'topic', lbl, 'type', 'multi', 'q', q.q, 'choices', learn_shuffle((q.data->'answers') || q.wrong));
    elsif q.qtype = 'order' then
      item := jsonb_build_object('id', q.id, 'topic', lbl, 'type', 'order', 'q', q.q, 'items', learn_shuffle(q.data->'items'));
    elsif q.qtype = 'match' then
      item := jsonb_build_object('id', q.id, 'topic', lbl, 'type', 'match', 'q', q.q,
                'lefts', (select jsonb_agg(p->0 order by n) from jsonb_array_elements(q.data->'pairs') with ordinality u(p, n)),
                'rights', learn_shuffle((select jsonb_agg(p->1) from jsonb_array_elements(q.data->'pairs') p)));
    else
      sh := learn_q_shots(q.answer, q.wrong);
      item := jsonb_build_object('id', q.id, 'topic', lbl, 'type', 'one', 'q', q.q, 'choices', learn_shuffle(jsonb_build_array(q.answer) || (q.wrong)));
      if sh is not null then item := item || jsonb_build_object('shots', sh); end if;
    end if;
    served := served || jsonb_build_array(jsonb_build_object('id', q.id, 'topic', lbl, 'type', q.qtype) || case when q.qtype in ('order','match') then jsonb_build_object('shown', item) else '{}'::jsonb end);
    shown := shown || jsonb_build_array(item);
    lim := lim + learn_q_secs2(qj);
  end loop;
  if n_topic < 5 or n_gen < 10 then raise exception 'not_ready' using errcode = 'P0001'; end if;
  insert into learn_attempts(staff_id, name, topic_id, qids, served, time_limit, topics, focus)
    values (s.id, s.name, 'mixed', ids, served, lim, array[t.title, 'General knowledge'], p_topic) returning id into aid;
  return jsonb_build_object('attempt', aid, 'title', t.title, 'focus', p_topic, 'questions', shown, 'limit', lim,
           'pass', ceil(jsonb_array_length(shown) * 0.8)::int, 'n_topic', n_topic, 'n_general', n_gen);
end $function$;

create or replace function public.learn_mix_history(p_emp text)
 returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare s staff;
begin
  s := learn_student(p_emp);
  return coalesce((select jsonb_agg(jsonb_build_object('at', x.finished_at, 'score', x.score, 'total', x.total, 'passed', x.passed, 'late', x.late,
      'per_topic', x.per_topic, 'focus', x.focus, 'focus_title', (select title from learn_topics where id = x.focus),
      'secs', extract(epoch from x.finished_at - x.started_at)::int) order by x.finished_at desc)
    from (select * from learn_attempts where staff_id = s.id and topic_id = 'mixed' and finished_at is not null order by finished_at desc limit 500) x), '[]'::jsonb);
end $function$;

create or replace function public.learn_scores(p_emp text, p_code text)
 returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare s staff;
begin
  if coalesce(p_code,'') <> '' then
    if not tasting_code_ok(p_code) then raise exception 'wrong_code' using errcode = 'P0001'; end if;
  else
    s := learn_who(p_emp);
    if public.master_name(p_emp) is null and not exists(select 1 from learn_viewers where staff_id = s.id) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  end if;
  return jsonb_build_object(
    'topics', (select jsonb_agg(jsonb_build_object('id',id,'title',title,'expires_months',expires_months) order by pos) from learn_topics where id = 'mixed'),
    'people', coalesce((select jsonb_agg(x order by x.name) from (
      select st.id, st.name, st.designation,
        (select jsonb_object_agg(t.topic_id, jsonb_build_object('best', t.best, 'tries', t.tries, 'passed_at', t.passed_at, 'secs', t.secs, 'lim', t.lim, 'late', t.late, 'outof', t.outof))
           from (select topic_id,
                   (array_agg(score order by score::numeric / nullif(total,0) desc, finished_at - started_at) filter (where not late))[1] best,
                   count(*) tries, max(finished_at) filter (where passed) passed_at,
                   (array_agg(extract(epoch from finished_at - started_at)::int order by score::numeric / nullif(total,0) desc, finished_at - started_at) filter (where not late))[1] secs,
                   (array_agg(time_limit order by score::numeric / nullif(total,0) desc, finished_at - started_at) filter (where not late))[1] lim,
                   count(*) filter (where late) late,
                   (array_agg(total order by score::numeric / nullif(total,0) desc, finished_at - started_at) filter (where not late))[1] outof
                 from learn_attempts where staff_id = st.id and finished_at is not null group by topic_id) t) topics
      from staff st where st.active and st.station_key is distinct from 'stewarding') x), '[]'::jsonb),
    'viewers', coalesce((select jsonb_agg(staff_id) from learn_viewers), '[]'::jsonb));
end $function$;

grant execute on function public.learn_start_topic(text,text), public.learn_mix_history(text), public.learn_scores(text,text) to anon, authenticated;
