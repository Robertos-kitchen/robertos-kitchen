-- Kitchen Maintenance → Tools (Chef Andrea, Send feedback inbox 9d2beffc, 16 Oct 2026):
-- "Need to create a Inventory list for Oliver that have to be carried out every end of the month
--  for tools. so we have always on track the number of tools we have, what we have and the value
--  of item purchase."
--
-- maint_tools         the list: what we have, how many were bought, the purchase price.
-- maint_tool_counts   the month-end count: how many the technician found, one row per tool per month.
-- maint_tool_months   a month the technician signed off (locked).
--
-- RLS on, no policies, anon revoked, like every maint_* table: the page reaches them only through
-- the security-definer maint_tool* functions below. Technician or chef (maint_has → master codes too).
-- A price nobody knows stays NULL, never 0, and the page says how many lines have no price.

create table if not exists maint_tools (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) >= 2),
  used_for text not null default '',
  qty int not null default 1 check (qty between 0 and 99999),
  price numeric(10,2) check (price is null or price >= 0),
  bought_on date,
  notes text not null default '',
  sort int not null default 0,
  active boolean not null default true,
  created_by text not null default '',
  created_at timestamptz not null default now(),
  retired_by text,
  retired_at timestamptz
);
create table if not exists maint_tool_counts (
  month date not null check (extract(day from month) = 1),
  tool_id uuid not null references maint_tools(id),
  qty int not null check (qty between 0 and 99999),
  counted_by text not null,
  counted_at timestamptz not null default now(),
  primary key (month, tool_id)
);
create table if not exists maint_tool_months (
  month date primary key check (extract(day from month) = 1),
  closed_by text not null,
  closed_at timestamptz not null default now()
);
alter table maint_tools enable row level security;
alter table maint_tool_counts enable row level security;
alter table maint_tool_months enable row level security;
revoke all on maint_tools, maint_tool_counts, maint_tool_months from anon, authenticated;

-- 'YYYY-MM' → first of month; refuses a future month
create or replace function maint_tool_month(p text) returns date
language plpgsql stable security definer set search_path = public as $$
declare m date;
begin
  if coalesce(p,'') !~ '^\d{4}-\d{2}$' then raise exception 'bad_month' using errcode = 'P0001'; end if;
  m := (p || '-01')::date;
  if m > date_trunc('month', (now() at time zone 'Asia/Dubai'))::date then raise exception 'bad_month' using errcode = 'P0001'; end if;
  return m;
end $$;

-- The month to count: this month, except in the first 7 days while last month is still unsigned.
create or replace function maint_tool_open_month() returns date
language sql stable security definer set search_path = public as $$
  select case when extract(day from d) <= 7 and not exists(select 1 from maint_tool_months where month = (date_trunc('month', d) - interval '1 month')::date)
              then (date_trunc('month', d) - interval '1 month')::date else date_trunc('month', d)::date end
    from (select (now() at time zone 'Asia/Dubai')::date d) x;
$$;

create or replace function maint_tools_get(p_emp text, p_month text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s staff; m date; pm date; om date; today date := (now() at time zone 'Asia/Dubai')::date;
begin
  s := learn_who(p_emp);
  if not (maint_has(s.id,'technician') or maint_has(s.id,'chef')) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  om := maint_tool_open_month();
  m := case when coalesce(p_month,'') = '' then om else maint_tool_month(p_month) end;
  pm := (m - interval '1 month')::date;
  return jsonb_build_object(
    'today', today, 'month', to_char(m,'YYYY-MM'), 'open_month', to_char(om,'YYYY-MM'),
    'last_day', (date_trunc('month', om) + interval '1 month - 1 day')::date,
    'closed', (select jsonb_build_object('by', closed_by, 'at', closed_at) from maint_tool_months where month = m),
    'tools', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'used_for', t.used_for, 'qty', t.qty,
                 'price', t.price, 'bought_on', t.bought_on, 'notes', t.notes, 'active', t.active,
                 'found', c.qty, 'counted_by', c.counted_by, 'counted_at', c.counted_at, 'prev', p.qty)
                 order by t.sort, t.name), '[]'::jsonb)
              from maint_tools t
              left join maint_tool_counts c on c.tool_id = t.id and c.month = m
              left join maint_tool_counts p on p.tool_id = t.id and p.month = pm
             where (t.active and t.created_at < (m + interval '1 month') at time zone 'Asia/Dubai') or c.tool_id is not null),
    'months', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(x.month,'YYYY-MM'), 'closed_by', x.closed_by, 'closed_at', x.closed_at,
                 'found', x.found, 'value', x.value, 'unpriced', x.unpriced) order by x.month desc), '[]'::jsonb)
              from (select mm.month, mm.closed_by, mm.closed_at, sum(c.qty) found,
                           sum(c.qty * t.price) value, count(*) filter (where t.price is null and c.qty > 0) unpriced
                      from maint_tool_months mm join maint_tool_counts c on c.month = mm.month join maint_tools t on t.id = c.tool_id
                     group by 1,2,3) x));
end $$;

create or replace function maint_tool_save(p_emp text, p_args jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s staff; a jsonb := coalesce(p_args,'{}'::jsonb); v_id uuid; v_price numeric; v_on date;
begin
  s := learn_who(p_emp);
  if not (maint_has(s.id,'technician') or maint_has(s.id,'chef')) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  if length(btrim(coalesce(a->>'name',''))) < 2 then raise exception 'no_name' using errcode = 'P0001'; end if;
  if coalesce(a->>'qty','') !~ '^\d{1,5}$' then raise exception 'bad_qty' using errcode = 'P0001'; end if;
  if btrim(coalesce(a->>'price','')) = '' then v_price := null;
  elsif btrim(a->>'price') ~ '^\d{1,7}(\.\d{1,2})?$' then v_price := btrim(a->>'price')::numeric;
  else raise exception 'bad_amount' using errcode = 'P0001'; end if;
  if coalesce(a->>'bought_on','') = '' then v_on := null;
  elsif a->>'bought_on' ~ '^\d{4}-\d{2}-\d{2}$' then v_on := (a->>'bought_on')::date;
  else raise exception 'no_date' using errcode = 'P0001'; end if;
  if nullif(a->>'id','') is null then
    insert into maint_tools(name, used_for, qty, price, bought_on, notes, sort, created_by)
    values (left(btrim(a->>'name'),120), left(btrim(coalesce(a->>'used_for','')),120), (a->>'qty')::int, v_price, v_on,
            left(btrim(coalesce(a->>'notes','')),500), coalesce((select max(sort) from maint_tools),0) + 10, s.name)
    returning id into v_id;
  else
    update maint_tools set name = left(btrim(a->>'name'),120), used_for = left(btrim(coalesce(a->>'used_for','')),120),
      qty = (a->>'qty')::int, price = v_price, bought_on = v_on, notes = left(btrim(coalesce(a->>'notes','')),500)
     where id = (a->>'id')::uuid and active returning id into v_id;
    if v_id is null then raise exception 'no_tool' using errcode = 'P0001'; end if;
  end if;
  return jsonb_build_object('id', v_id);
end $$;

-- Retire, never delete: past counts keep pointing at it.
create or replace function maint_tool_retire(p_emp text, p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s staff;
begin
  s := learn_who(p_emp);
  if not (maint_has(s.id,'technician') or maint_has(s.id,'chef')) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  update maint_tools set active = false, retired_by = s.name, retired_at = now() where id = p_id and active;
  if not found then raise exception 'no_tool' using errcode = 'P0001'; end if;
  return jsonb_build_object('id', p_id);
end $$;

-- One tool, one month. An empty box takes the count back off.
create or replace function maint_tool_count(p_emp text, p_month text, p_tool uuid, p_qty text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s staff; m date;
begin
  s := learn_who(p_emp);
  if not (maint_has(s.id,'technician') or maint_has(s.id,'chef')) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  m := maint_tool_month(p_month);
  if exists(select 1 from maint_tool_months where month = m) then raise exception 'month_closed' using errcode = 'P0001'; end if;
  if not exists(select 1 from maint_tools where id = p_tool) then raise exception 'no_tool' using errcode = 'P0001'; end if;
  if btrim(coalesce(p_qty,'')) = '' then
    delete from maint_tool_counts where month = m and tool_id = p_tool;
    return jsonb_build_object('found', null);
  end if;
  if btrim(p_qty) !~ '^\d{1,5}$' then raise exception 'bad_qty' using errcode = 'P0001'; end if;
  insert into maint_tool_counts(month, tool_id, qty, counted_by) values (m, p_tool, btrim(p_qty)::int, s.name)
  on conflict (month, tool_id) do update set qty = excluded.qty, counted_by = excluded.counted_by, counted_at = now();
  return jsonb_build_object('found', btrim(p_qty)::int, 'counted_by', s.name);
end $$;

-- Sign the month off with your own staff code (the same rule as signing a job card). Every tool on
-- the list must have a number first, 0 included.
create or replace function maint_tool_close(p_emp text, p_month text, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s staff; m date; n int;
begin
  s := learn_who(p_emp);
  if not (maint_has(s.id,'technician') or maint_has(s.id,'chef')) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  if btrim(coalesce(p_code,'')) = '' or btrim(p_code) <> btrim(p_emp) then raise exception 'bad_code' using errcode = 'P0001'; end if;
  m := maint_tool_month(p_month);
  if exists(select 1 from maint_tool_months where month = m) then raise exception 'month_closed' using errcode = 'P0001'; end if;
  select count(*) into n from maint_tools t where t.active and t.created_at < (m + interval '1 month') at time zone 'Asia/Dubai'
     and not exists(select 1 from maint_tool_counts c where c.month = m and c.tool_id = t.id);
  if n > 0 then raise exception 'not_all_counted:%', n using errcode = 'P0001'; end if;
  insert into maint_tool_months(month, closed_by) values (m, s.name);
  return jsonb_build_object('month', to_char(m,'YYYY-MM'), 'closed_by', s.name);
end $$;

revoke all on function maint_tool_month(text), maint_tool_open_month(), maint_tools_get(text,text), maint_tool_save(text,jsonb),
  maint_tool_retire(text,uuid), maint_tool_count(text,text,uuid,text), maint_tool_close(text,text,text) from public;
grant execute on function maint_tools_get(text,text), maint_tool_save(text,jsonb), maint_tool_retire(text,uuid),
  maint_tool_count(text,text,uuid,text), maint_tool_close(text,text,text) to anon, authenticated;

-- ── 16 Oct 2026 (Francesco: "Oliver should get it by email, like the job cards") ──
-- The month-end reminder rides the job-card mail queue. A 'tools' row has no card, it carries the month.
-- maint_tools_remind() runs daily at 09:00 Dubai (cron maint-tools-remind, 0 5 * * * UTC):
--   from 3 days before month end -> one email to every active technician ("Month-end tools count")
--   after month end, still unsigned -> one more ("... is not signed yet"). Nothing once the month is signed.
-- maint_tools_remind(true) sends a [TEST] to Francesco only. maint-notify v4 builds the email.
alter table maint_mail alter column card_id drop not null;
alter table maint_mail add column if not exists month date;
alter table maint_mail drop constraint if exists maint_mail_kind_check;
alter table maint_mail add constraint maint_mail_kind_check check (kind in ('new','check','followup','tools'));
alter table maint_mail add constraint maint_mail_tools_shape check ((kind = 'tools') = (card_id is null and month is not null));

create or replace function maint_tools_remind(p_test boolean default false) returns text
language plpgsql security definer set search_path = public as $$
declare today date := (now() at time zone 'Asia/Dubai')::date; om date; last date; v_to text[]; v_id bigint;
begin
  om := maint_tool_open_month();
  last := (om + interval '1 month - 1 day')::date;
  if p_test then
    insert into maint_mail(card_id, month, kind, to_list, is_test) values (null, om, 'tools', array['fguarracino@robertos.ae'], true) returning id into v_id;
    perform maint_kick(v_id);
    return 'test ' || v_id;
  end if;
  if exists(select 1 from maint_tool_months where month = om) then return 'signed'; end if;
  if not exists(select 1 from maint_tools where active) then return 'no tools'; end if;
  if today between last - 2 and last then
    if exists(select 1 from maint_mail where kind = 'tools' and month = om and not is_test) then return 'already sent'; end if;
  elsif today > last then
    if exists(select 1 from maint_mail where kind = 'tools' and month = om and not is_test and (created_at at time zone 'Asia/Dubai')::date > last) then return 'already sent late'; end if;
  else
    return 'not due';
  end if;
  select array_agg(distinct lower(email)) into v_to from maint_people where active and role = 'technician';
  if v_to is null or cardinality(v_to) = 0 then return 'no technician'; end if;
  insert into maint_mail(card_id, month, kind, to_list, is_test) values (null, om, 'tools', v_to, false) returning id into v_id;
  perform maint_kick(v_id);
  return 'sent ' || v_id;
end $$;
revoke all on function maint_tools_remind(boolean) from public, anon, authenticated;
select cron.schedule('maint-tools-remind', '0 5 * * *', 'select maint_tools_remind()');
