-- Learning Scores show the time taken (Chef Francesco, 29 Sep 2026: "show time taken in the
-- score"). For each person and topic: how long the best attempt took (best score, then the
-- fastest of those) and the time it was given, plus how many attempts were late. Late
-- attempts never count as the best.
do $$
declare d text; n text;
begin
  select pg_get_functiondef('public.learn_scores(text,text)'::regprocedure) into d;
  n := replace(d, 'max(finished_at) filter (where passed) passed_at',
    'max(finished_at) filter (where passed) passed_at, '
    || '(array_agg(extract(epoch from finished_at - started_at)::int order by score desc, finished_at - started_at) filter (where not late))[1] secs, '
    || '(array_agg(time_limit order by score desc, finished_at - started_at) filter (where not late))[1] lim, '
    || 'count(*) filter (where late) late');
  if n = d then raise exception 'learn_scores: select not found'; end if;
  d := n;
  n := replace(d, '''passed_at'', t.passed_at)', '''passed_at'', t.passed_at, ''secs'', t.secs, ''lim'', t.lim, ''late'', t.late)');
  if n = d then raise exception 'learn_scores: object not found'; end if;
  execute n;
end $$;
