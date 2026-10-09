-- Kitchen Learning shared with Roberto's Mare (9 Oct 2026).
-- Francesco: "yes add 10 shared topic". Ten Dubai topics are also Mare's: history, dishes,
-- ingredients, knife, techniques, stocks, pasta, meat-fish, taste, organisation. Not shared:
-- food-safety (Dubai Municipality code; Mare has six Montenegrin topics) and finance (AED, senior).
-- One place of truth: what Danilo/Antonio check and Francesco approves here is what Mare gets.
-- Mare's server (edge fn mare-learn, FOH project) calls learn_mare_pool with a shared key; the
-- answers never go to a phone. Dubai Municipality code references are dropped for Mare (the rule
-- itself is the Roberto's standard); questions that only hold in Dubai are tagged dubai_only.
-- Our Dishes: only dishes the Dubai chef ticked "Mare" (recipes.show_mare).
-- All four question types pass through (learning-mixed.sql added them, 9 Oct 2026).

alter table public.learn_questions add column if not exists dubai_only boolean not null default false;
update public.learn_questions set dubai_only = true
 where id in ('4542f0b1-f557-434b-b069-a67d905801a5',   -- crudo: what the menu must say (DM 3.2.9 c)
              'cfd97688-b1c2-4df2-a232-05ab3ea90b40');  -- raw fish: parasite controls (DM 3.2.9 b)

create table if not exists public.learn_share_keys (name text primary key, key text not null, created_at timestamptz not null default now());
alter table public.learn_share_keys enable row level security;
revoke all on public.learn_share_keys from anon, authenticated;
insert into public.learn_share_keys(name, key) values ('mare', encode(extensions.gen_random_bytes(24), 'hex')) on conflict (name) do nothing;

create or replace function public.learn_strip_dm(t text) returns text
language sql immutable as $$
  select nullif(btrim(regexp_replace(regexp_replace(coalesce(t, ''),
           '\s*\((Dubai Municipality|DM) Food Code[^)]*\)', '', 'g'),
           '(^|\s)(Dubai Municipality|DM) Food Code [0-9][0-9.]*( ?[a-z]( and [0-9.]+ ?[a-z]*)?)?[.:]?', ' ', 'g')), '')
$$;

create or replace function public.learn_mare_pool(p_key text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare shared text[] := array['history','dishes','ingredients','knife','techniques','stocks','pasta','meat-fish','taste','organisation'];
begin
  if p_key is null or p_key is distinct from (select key from public.learn_share_keys where name = 'mare') then
    return jsonb_build_object('ok', false, 'error', 'key'); end if;
  return jsonb_build_object('ok', true, 'topics', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', 'k:' || t.id, 'title', t.title, 'summary', t.summary,
      'pages', coalesce((select jsonb_agg(jsonb_build_object('title', p.title, 'body', learn_strip_dm(p.body), 'photo', p.photo) order by p.pos)
                         from learn_pages p where p.topic_id = t.id and p.status = 'approved'), '[]'::jsonb),
      'questions', coalesce((select jsonb_agg(jsonb_build_object('id', 'k:' || q.id, 'type', q.qtype, 'q', q.q, 'why', learn_strip_dm(q.why)) ||
                                   case q.qtype
                                     when 'multi' then jsonb_build_object('answers', q.data->'answers', 'wrong', q.wrong)
                                     when 'order' then jsonb_build_object('items', q.data->'items')
                                     when 'match' then jsonb_build_object('pairs', q.data->'pairs')
                                     else jsonb_build_object('answer', q.answer, 'wrong', q.wrong, 'shots', learn_q_shots(q.answer, q.wrong)) end)
                         from learn_questions q
                        where q.topic_id = t.id and q.status = 'approved' and q.level = 'all' and not q.dubai_only
                          and (t.id <> 'dishes' or q.recipe_id is null or exists (select 1 from recipes r where r.id = q.recipe_id and r.show_mare))
                          and (t.id <> 'dishes' or q.recipe_id is not null or q.gen_key like 'plate:%'
                               and exists (select 1 from recipes r where r.show_mare and not r.archived and lower(btrim(r.name)) = lower(btrim(q.answer))))), '[]'::jsonb))
      order by t.pos)
    from learn_topics t where t.id = any(shared) and t.active and not t.senior_only), '[]'::jsonb));
end $$;

revoke all on function public.learn_strip_dm(text), public.learn_mare_pool(text) from public;
grant execute on function public.learn_mare_pool(text) to anon, authenticated;
