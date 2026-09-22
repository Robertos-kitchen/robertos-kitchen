-- Learning (Kitchen app) — Chef Andrea's learning section, built 22 Sep 2026 to his answers
-- in the feedback round `learning-andrea`.
--
-- Every table is RLS-on with NO policy: the anon key can read or write none of it. Everything
-- goes through the security-definer functions below, so the right answer to a test question
-- never reaches a phone until the test is handed in.
--
-- Who is who
--   · Anyone in `staff` with an employee ID signs in with it (Andrea: "a login to start the test").
--   · Level comes from staff.designation: sous/executive/development/head = senior,
--     CDP/DCDP = cdp, everything else = commis. Senior-only topics are hidden below senior.
--   · Checkers = learn_checkers (Chef Danilo, Chef Antonio; Chef Andrea added 22 Sep 2026 on Francesco's word). They check every page and question
--     FIRST; Francesco approves SECOND with his code (tasting_secret — the same code as Tasting).
--     Nothing reaches the team before both.
--   · Scores are visible only to people ticked in learn_viewers, or with Francesco's code.

create table if not exists learn_topics (
  id text primary key,
  pos int not null,
  title text not null,
  summary text not null default '',
  senior_only boolean not null default false,
  expires_months int,                       -- null = a pass never expires
  active boolean not null default true
);

create table if not exists learn_pages (
  id uuid primary key default gen_random_uuid(),
  topic_id text not null references learn_topics(id),
  pos int not null default 0,
  title text not null,
  body text not null,
  photo text,                               -- a data: URL, like recipes.photos
  source text not null default 'general' check (source in ('recipe','general','sop','chef')),
  status text not null default 'draft' check (status in ('draft','checked','approved','rejected')),
  written_by text not null default 'Claude',
  checked_by text, checked_at timestamptz,
  approved_by text, approved_at timestamptz,
  note text,
  updated_at timestamptz not null default now()
);

create table if not exists learn_questions (
  id uuid primary key default gen_random_uuid(),
  topic_id text not null references learn_topics(id),
  source text not null default 'general' check (source in ('recipe','general','sop','chef')),
  level text not null default 'all' check (level in ('all','cdp','senior')),
  q text not null,
  answer text not null,
  wrong jsonb not null check (jsonb_typeof(wrong) = 'array' and jsonb_array_length(wrong) = 3),
  why text not null default '',
  recipe_id uuid,
  gen_key text unique,                      -- recipe questions: 'store:<id>', 'plate:<id>', 'allerg:<id>'
  gen_sig text,                             -- the recipe text it was built from; a change re-drafts it
  status text not null default 'draft' check (status in ('draft','checked','approved','rejected')),
  written_by text not null default 'Claude',
  checked_by text, checked_at timestamptz,
  approved_by text, approved_at timestamptz,
  note text,
  updated_at timestamptz not null default now()
);

create table if not exists learn_attempts (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null,
  name text not null,
  topic_id text not null references learn_topics(id),
  qids uuid[] not null,
  served jsonb not null,                    -- the four choices of each question, in the order shown
  answers jsonb,
  score int, total int, passed boolean,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists learn_attempts_staff on learn_attempts(staff_id, topic_id);

create table if not exists learn_checkers (staff_id uuid primary key);
create table if not exists learn_viewers  (staff_id uuid primary key, added_at timestamptz not null default now());

alter table learn_topics    enable row level security;
alter table learn_pages     enable row level security;
alter table learn_questions enable row level security;
alter table learn_attempts  enable row level security;
alter table learn_checkers  enable row level security;
alter table learn_viewers   enable row level security;

insert into learn_checkers(staff_id)
  select id from staff where active and name in ('Danilo Valla','Antonio Stellacci','Andrea Falcone')
  on conflict do nothing;

-- ── who is signing in ──────────────────────────────────────────────────────
create or replace function learn_level(p_designation text) returns text
language sql immutable as $$
  select case
    when coalesce(p_designation,'') ~* '(sous|executive|development|head|chef de cuisine)' then 'senior'
    when coalesce(p_designation,'') ~* '(^|[^a-z])d?cdp([^a-z]|$)|chef de partie' then 'cdp'
    else 'commis' end
$$;

create or replace function learn_who(p_emp text) returns staff
language plpgsql stable security definer set search_path to 'public' as $$
declare s staff;
begin
  select * into s from staff where active and emp_id is not null and trim(emp_id) = trim(coalesce(p_emp,'')) limit 1;
  if s.id is null then raise exception 'no_emp' using errcode = 'P0001'; end if;
  return s;
end $$;

create or replace function learn_level_ok(p_level text, q_level text) returns boolean
language sql immutable as $$
  select case q_level when 'all' then true
                      when 'cdp' then p_level in ('cdp','senior')
                      else p_level = 'senior' end
$$;

create or replace function learn_me(p_emp text) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare s staff;
begin
  s := learn_who(p_emp);
  return jsonb_build_object('staff_id', s.id, 'name', s.name, 'designation', s.designation,
    'level', learn_level(s.designation),
    'checker', exists(select 1 from learn_checkers where staff_id = s.id),
    'viewer',  exists(select 1 from learn_viewers  where staff_id = s.id));
end $$;

-- ── the team's side ────────────────────────────────────────────────────────
create or replace function learn_home(p_emp text) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare s staff; lv text;
begin
  s := learn_who(p_emp); lv := learn_level(s.designation);
  return coalesce((select jsonb_agg(x order by x.pos) from (
    select t.id, t.pos, t.title, t.summary, t.senior_only, t.expires_months,
      (select count(*) from learn_pages p where p.topic_id = t.id and p.status = 'approved') pages,
      (select count(*) from learn_questions q where q.topic_id = t.id and q.status = 'approved'
         and learn_level_ok(lv, q.level)) questions,
      (select max(a.score) from learn_attempts a where a.staff_id = s.id and a.topic_id = t.id and a.finished_at is not null) best,
      (select max(a.finished_at) from learn_attempts a where a.staff_id = s.id and a.topic_id = t.id and a.passed) passed_at,
      (select count(*) from learn_attempts a where a.staff_id = s.id and a.topic_id = t.id and a.finished_at is not null) tries
    from learn_topics t
    where t.active and (not t.senior_only or lv = 'senior')) x), '[]'::jsonb);
end $$;

create or replace function learn_pages_for(p_emp text, p_topic text) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform learn_who(p_emp);
  return coalesce((select jsonb_agg(jsonb_build_object('id',id,'title',title,'body',body,'photo',photo) order by pos, title)
    from learn_pages where topic_id = p_topic and status = 'approved'), '[]'::jsonb);
end $$;

-- Five approved questions at random from the ones this person's level may see; the four
-- choices shuffled. The answer is NOT in what comes back.
create or replace function learn_start(p_emp text, p_topic text) returns jsonb
language plpgsql volatile security definer set search_path to 'public' as $$
declare s staff; lv text; t learn_topics; ids uuid[]; served jsonb := '[]'::jsonb; r record; aid uuid;
begin
  s := learn_who(p_emp); lv := learn_level(s.designation);
  select * into t from learn_topics where id = p_topic and active;
  if t.id is null or (t.senior_only and lv <> 'senior') then raise exception 'no_topic' using errcode = 'P0001'; end if;
  select array_agg(id) into ids from (
    select id from learn_questions where topic_id = p_topic and status = 'approved' and learn_level_ok(lv, level)
    order by random() limit 5) z;
  if coalesce(array_length(ids,1),0) < 5 then raise exception 'not_ready' using errcode = 'P0001'; end if;
  for r in select q.id, q.q, (select jsonb_agg(c order by random())
             from jsonb_array_elements_text(jsonb_build_array(q.answer) || q.wrong) c) choices
           from learn_questions q join unnest(ids) with ordinality u(id, n) on u.id = q.id order by u.n loop
    served := served || jsonb_build_object('id', r.id, 'q', r.q, 'choices', r.choices);
  end loop;
  insert into learn_attempts(staff_id, name, topic_id, qids, served)
  values (s.id, s.name, p_topic, ids, served) returning id into aid;
  return jsonb_build_object('attempt', aid, 'title', t.title, 'questions', served);
end $$;

-- p_answers = the choice TEXT picked for each question, in order. Marked here, not on the phone.
create or replace function learn_finish(p_emp text, p_attempt uuid, p_answers jsonb) returns jsonb
language plpgsql volatile security definer set search_path to 'public' as $$
declare s staff; a learn_attempts; res jsonb := '[]'::jsonb; i int; q learn_questions; pick text; ok int := 0;
begin
  s := learn_who(p_emp);
  select * into a from learn_attempts where id = p_attempt and staff_id = s.id;
  if a.id is null then raise exception 'no_attempt' using errcode = 'P0001'; end if;
  if a.finished_at is not null then raise exception 'already_finished' using errcode = 'P0001'; end if;
  for i in 1 .. array_length(a.qids,1) loop
    select * into q from learn_questions where id = a.qids[i];
    pick := p_answers ->> (i-1);
    if coalesce(pick = q.answer, false) then ok := ok + 1; end if;
    res := res || jsonb_build_object('q', q.q, 'picked', pick, 'answer', q.answer, 'right', coalesce(pick = q.answer, false), 'why', q.why);
  end loop;
  update learn_attempts set answers = p_answers, score = ok, total = array_length(a.qids,1),
    passed = ok >= 4, finished_at = now() where id = a.id;
  return jsonb_build_object('score', ok, 'total', array_length(a.qids,1), 'passed', ok >= 4, 'results', res);
end $$;

-- ── the chefs' side ────────────────────────────────────────────────────────
-- role: 'francesco' with the code; 'checker' for Danilo/Antonio/Andrea; 'writer' for any senior.
create or replace function learn_role(p_emp text, p_code text) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare s staff;
begin
  if coalesce(p_code,'') <> '' then
    if tasting_code_ok(p_code) then return jsonb_build_object('role','francesco','name','Francesco'); end if;
    raise exception 'wrong_code' using errcode = 'P0001';
  end if;
  s := learn_who(p_emp);
  if exists(select 1 from learn_checkers where staff_id = s.id) then
    return jsonb_build_object('role','checker','name',s.name,'staff_id',s.id); end if;
  if learn_level(s.designation) = 'senior' then
    return jsonb_build_object('role','writer','name',s.name,'staff_id',s.id); end if;
  raise exception 'not_allowed' using errcode = 'P0001';
end $$;

create or replace function learn_queue(p_emp text, p_code text) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare r jsonb;
begin
  r := learn_role(p_emp, p_code);
  return jsonb_build_object('role', r,
    'topics', (select jsonb_agg(jsonb_build_object('id',id,'title',title,'pos',pos) order by pos) from learn_topics where active),
    'pages', coalesce((select jsonb_agg(to_jsonb(p) order by t.pos, p.pos) from learn_pages p join learn_topics t on t.id = p.topic_id), '[]'::jsonb),
    'questions', coalesce((select jsonb_agg(to_jsonb(lq) - 'gen_sig' order by t.pos, lq.source, lq.updated_at) from learn_questions lq join learn_topics t on t.id = lq.topic_id), '[]'::jsonb));
end $$;

-- One step on one page or question.
--   checker:   ok (draft -> checked), reject; a fix + ok in one call counts as the check.
--   francesco: approve (checked -> approved), back (-> draft with a note), reject. He does NOT check:
--              a fix he makes goes back to draft for the checkers.
-- p_fields edits the text first (q, answer, wrong, why, level, title, body, photo) — an edit to an
-- approved item sends it back through both checks, so nothing changes on the team's screen unseen.
create or replace function learn_step(p_emp text, p_code text, p_kind text, p_id uuid, p_action text, p_fields jsonb, p_note text)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $$
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
        level = coalesce(p_fields->>'level', level),
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
    -- Francesco's rule, 22 Sep 2026: the checkers (Danilo, Antonio, Andrea) check FIRST, he approves SECOND.
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
end $$;

-- A chef writes their own page or question (Andrea: "Written by you, for what only you know").
create or replace function learn_add(p_emp text, p_code text, p_kind text, p_topic text, p_fields jsonb)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $$
declare r jsonb; nid uuid;
begin
  r := learn_role(p_emp, p_code);
  if not exists(select 1 from learn_topics where id = p_topic) then raise exception 'no_topic' using errcode = 'P0001'; end if;
  if p_kind = 'q' then
    insert into learn_questions(topic_id, source, level, q, answer, wrong, why, written_by)
    values (p_topic, 'chef', coalesce(p_fields->>'level','all'), p_fields->>'q', p_fields->>'answer',
            p_fields->'wrong', coalesce(p_fields->>'why',''), r->>'name') returning id into nid;
  elsif p_kind = 'p' then
    insert into learn_pages(topic_id, pos, source, title, body, photo, written_by)
    values (p_topic, coalesce((select max(pos)+1 from learn_pages where topic_id = p_topic),0), 'chef',
            p_fields->>'title', p_fields->>'body', nullif(p_fields->>'photo',''), r->>'name') returning id into nid;
  else raise exception 'bad_kind' using errcode = 'P0001'; end if;
  return jsonb_build_object('id', nid);
end $$;

-- ── questions from our own recipes ─────────────────────────────────────────
-- A recipe makes a question ONLY for a field somebody actually filled in: "how is it stored"
-- from a batch's written storage line, "which plate" from a dish's crockery line, "which
-- allergens" from a dish whose allergens (its own ticks plus every batch inside it) are
-- ticked. A blank field makes no question — a blank is "nobody wrote it down", never "none".
-- If the recipe text changes, the question is rebuilt and goes back to draft for checking.
create or replace function learn_recipe_facts() returns table(kind text, recipe_id uuid, name text, fact text)
language sql stable security definer set search_path to 'public' as $$
  with recursive walk(root, rid, depth) as (
      select r.id, r.id, 0 from recipes r where not r.archived and r.kind = 'main'
    union
      select w.root, l.child_recipe_id, w.depth + 1 from walk w join recipe_lines l on l.recipe_id = w.rid
      where l.child_recipe_id is not null and w.depth < 8)
  select 'store', r.id, r.name, trim(r.method->>'store') from recipes r
    where not r.archived and r.kind = 'batch' and coalesce(trim(r.method->>'store'),'') <> ''
  union all
  select 'plate', r.id, r.name, trim(r.method->>'crockery') from recipes r
    where not r.archived and r.kind = 'main' and coalesce(trim(r.method->>'crockery'),'') <> ''
  union all
  select 'allerg', w.root, (select name from recipes where id = w.root),
         string_agg(distinct a, ', ' order by a)
    from walk w join recipes x on x.id = w.rid and not x.archived, unnest(x.allergens) a
    group by w.root
$$;

create or replace function learn_allergen_word(k text) returns text language sql immutable as $$
  select case k when 'gluten' then 'Gluten' when 'crustacean' then 'Crustaceans' when 'egg' then 'Egg'
    when 'fish' then 'Fish' when 'peanut' then 'Peanuts' when 'soy' then 'Soya' when 'milk' then 'Milk'
    when 'nuts' then 'Tree nuts' when 'celery' then 'Celery' when 'mustard' then 'Mustard'
    when 'sesame' then 'Sesame' when 'sulphites' then 'Sulphites' when 'lupin' then 'Lupin'
    when 'mollusc' then 'Molluscs' else initcap(k) end
$$;

create or replace function learn_make_recipe_questions(p_emp text, p_code text) returns jsonb
language plpgsql volatile security definer set search_path to 'public' as $$
declare r jsonb; f record; v_key text; v_q text; v_ans text; v_wr jsonb; v_why text;
        made int := 0; redone int := 0; same int := 0; ex learn_questions;
begin
  r := learn_role(p_emp, p_code);
  if r->>'role' not in ('checker','francesco') then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  create temp table if not exists _lf(kind text, recipe_id uuid, name text, fact text, shown text) on commit drop;
  truncate _lf;   -- not DELETE: the API refuses a DELETE with no WHERE
  insert into _lf select x.kind, x.recipe_id, x.name, x.fact,
      case when x.kind = 'allerg'
        then (select string_agg(learn_allergen_word(t), ', ' order by learn_allergen_word(t)) from unnest(string_to_array(x.fact, ', ')) t)
        else x.fact end
    from learn_recipe_facts() x;
  for f in select * from _lf loop
    v_key := f.kind || ':' || f.recipe_id;
    v_ans := f.shown;
    -- three wrong answers: the same field from three other recipes, each different from the right one
    select jsonb_agg(z.v) into v_wr from (
      select min(g.shown) v from _lf g
      where g.kind = f.kind and g.recipe_id <> f.recipe_id and lower(g.shown) <> lower(v_ans)
      group by lower(g.shown) order by random() limit 3) z;
    if coalesce(jsonb_array_length(v_wr),0) < 3 then continue; end if;
    v_q := case f.kind when 'store' then 'How is the ' || f.name || ' stored once it is made?'
                       when 'plate' then 'Which plate does ' || f.name || ' go out on?'
                       else 'Which allergens are in ' || f.name || '?' end;
    v_why := case f.kind when 'store' then 'From the recipe for ' || f.name || ' in the Recipe book.'
                         when 'plate' then 'From the crockery on the recipe for ' || f.name || '.'
                         else 'Every allergen ticked on ' || f.name || ' and on the batches inside it.' end;
    select * into ex from learn_questions where gen_key = v_key;
    if ex.id is null then
      insert into learn_questions(topic_id, source, level, q, answer, wrong, why, recipe_id, gen_key, gen_sig, written_by)
      values ('dishes', 'recipe', 'all', v_q, v_ans, v_wr, v_why, f.recipe_id, v_key, f.fact, 'Recipe book');
      made := made + 1;
    elsif ex.gen_sig is distinct from f.fact then
      update learn_questions set q = v_q, answer = v_ans, wrong = v_wr, why = v_why, gen_sig = f.fact,
        status = 'draft', checked_by = null, checked_at = null, approved_by = null, approved_at = null,
        note = 'The recipe changed, so this question was rebuilt and needs checking again.', updated_at = now()
        where id = ex.id;
      redone := redone + 1;
    else same := same + 1; end if;
  end loop;
  return jsonb_build_object('made', made, 'rebuilt', redone, 'unchanged', same);
end $$;

-- What is missing from the recipe book, so the learning section pushes it to be finished.
create or replace function learn_recipe_gaps(p_emp text, p_code text) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform learn_role(p_emp, p_code);
  return jsonb_build_object(
    'dishes', (select count(*) from recipes where not archived and kind = 'main'),
    'batches', (select count(*) from recipes where not archived and kind = 'batch'),
    'rows', coalesce((select jsonb_agg(x order by x.kind desc, x.name) from (
      select r.name, r.kind,
        array_remove(array[
          case when r.kind = 'batch' and coalesce(trim(r.method->>'store'),'') = '' then 'how it is stored' end,
          case when r.kind = 'main' and coalesce(trim(r.method->>'crockery'),'') = '' then 'the plate' end,
          case when r.kind = 'main' and not (r.id = any(al.ids)) then 'allergens' end,
          case when r.kind = 'main' and jsonb_array_length(coalesce(r.photos,'[]'::jsonb)) = 0 then 'a photo' end
        ], null) missing
      from recipes r, (select coalesce(array_agg(recipe_id),'{}') ids from learn_recipe_facts() where kind = 'allerg') al
      where not r.archived) x where array_length(x.missing,1) > 0), '[]'::jsonb));
end $$;

-- ── scores ─────────────────────────────────────────────────────────────────
create or replace function learn_scores(p_emp text, p_code text) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare s staff;
begin
  if coalesce(p_code,'') <> '' then
    if not tasting_code_ok(p_code) then raise exception 'wrong_code' using errcode = 'P0001'; end if;
  else
    s := learn_who(p_emp);
    if not exists(select 1 from learn_viewers where staff_id = s.id) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  end if;
  return jsonb_build_object(
    'topics', (select jsonb_agg(jsonb_build_object('id',id,'title',title,'expires_months',expires_months) order by pos) from learn_topics where active),
    'people', coalesce((select jsonb_agg(x order by x.name) from (
      select st.id, st.name, st.designation,
        (select jsonb_object_agg(t.topic_id, jsonb_build_object('best', t.best, 'tries', t.tries, 'passed_at', t.passed_at))
           from (select topic_id, max(score) best, count(*) tries, max(finished_at) filter (where passed) passed_at
                 from learn_attempts where staff_id = st.id and finished_at is not null group by topic_id) t) topics
      from staff st where st.active) x), '[]'::jsonb),
    'viewers', coalesce((select jsonb_agg(staff_id) from learn_viewers), '[]'::jsonb));
end $$;

create or replace function learn_set_viewer(p_code text, p_staff uuid, p_on boolean) returns jsonb
language plpgsql volatile security definer set search_path to 'public' as $$
begin
  if not tasting_code_ok(p_code) then raise exception 'wrong_code' using errcode = 'P0001'; end if;
  if p_on then insert into learn_viewers(staff_id) values (p_staff) on conflict do nothing;
  else delete from learn_viewers where staff_id = p_staff; end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function learn_recipe_facts() from public, anon, authenticated;
grant execute on function learn_me(text), learn_home(text), learn_pages_for(text,text), learn_start(text,text),
  learn_finish(text,uuid,jsonb), learn_role(text,text), learn_queue(text,text),
  learn_step(text,text,text,uuid,text,jsonb,text), learn_add(text,text,text,text,jsonb),
  learn_make_recipe_questions(text,text), learn_recipe_gaps(text,text), learn_scores(text,text),
  learn_set_viewer(text,uuid,boolean) to anon, authenticated;
revoke execute on function learn_who(text) from public, anon, authenticated;
