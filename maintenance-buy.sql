-- Maintenance -> To buy: a purchase request for a spare part or a tool.
-- Chef Andrea, Send feedback 2ce28fd4 + 0dbd7f59 (19 Oct 2026): "it has to work like a purchase
-- request, Oliver will place photo exact descriptions and price range and it will go
-- afalcone@robertos.ae and i will provide him with the spare part he needs."
-- The technician (or a chef) asks: what, the exact model, how many, a price range, photos, and
-- optionally the job card it is for. The people in maint_people with role 'buyer' get an email at
-- once and mark it Provided when the part is handed over. Additive only.

alter table maint_people drop constraint maint_people_role_check;
alter table maint_people add constraint maint_people_role_check check (role in ('technician','chef','followup','buyer'));
insert into maint_people(staff_id, role, email, active)
  select staff_id, 'buyer', email, true from maint_people where role = 'technician' and lower(email) = 'afalcone@robertos.ae'
  on conflict do nothing;

create table if not exists maint_buys (
  id uuid primary key default gen_random_uuid(),
  buy_no serial,
  is_test boolean not null default false,
  item text not null,
  model text not null,
  qty int not null default 1 check (qty between 1 and 9999),
  price_min numeric(10,2) not null check (price_min >= 0),
  price_max numeric(10,2) not null,
  note text,
  card_id uuid references maint_cards(id) on delete set null,
  media jsonb not null default '[]'::jsonb,
  asked_by_id uuid not null references staff(id),
  asked_by text not null,
  asked_at timestamptz not null default now(),
  status text not null default 'asked' check (status in ('asked','provided','cancelled')),
  done_by text,
  done_at timestamptz,
  done_note text,
  paid numeric(10,2),
  check (price_max >= price_min)
);
alter table maint_buys enable row level security;
revoke all on maint_buys from anon, authenticated;

alter table maint_mail add column if not exists buy_id uuid references maint_buys(id) on delete cascade;
alter table maint_mail drop constraint maint_mail_kind_check;
alter table maint_mail add constraint maint_mail_kind_check check (kind in ('new','check','followup','tools','buy'));
alter table maint_mail add constraint maint_mail_buy_shape check ((kind = 'buy') = (buy_id is not null and card_id is null));

-- the bucket takes job-card files under c/, tool photos under t/, and purchase photos under b/
alter policy maint_media_add on storage.objects
  with check (bucket_id = 'maint-media' and name ~ '^(c|t|b)/[0-9a-f-]{36}/[A-Za-z0-9._-]+$');

create or replace function maint_buy_row(b maint_buys) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', b.id, 'buy_no', b.buy_no, 'is_test', b.is_test, 'item', b.item, 'model', b.model, 'qty', b.qty,
    'price_min', b.price_min, 'price_max', b.price_max, 'note', b.note, 'media', b.media,
    'card_id', b.card_id, 'card_no', (select card_no from maint_cards where id = b.card_id),
    'card_title', (select equipment from maint_cards where id = b.card_id),
    'asked_by', b.asked_by, 'asked_by_id', b.asked_by_id, 'asked_at', b.asked_at, 'status', b.status,
    'done_by', b.done_by, 'done_at', b.done_at, 'done_note', b.done_note, 'paid', b.paid)
$$;

-- the list: open ones first, then the last 60 days of provided / cancelled
create or replace function maint_buys_get(p_emp text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s staff;
begin
  s := learn_who(p_emp);
  if not (maint_has(s.id,'technician') or maint_has(s.id,'chef') or maint_has(s.id,'buyer')) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  return jsonb_build_object(
    'buyers', (select coalesce(jsonb_agg(st.name order by st.name), '[]'::jsonb) from maint_people mp join staff st on st.id = mp.staff_id where mp.role='buyer' and mp.active),
    'buys', (select coalesce(jsonb_agg(maint_buy_row(b) order by (b.status = 'asked') desc, b.asked_at desc), '[]'::jsonb)
               from maint_buys b where b.status = 'asked' or b.done_at > now() - interval '60 days'));
end $$;

-- ask to buy. Photos must already be in maint-media under b/<folder>/.
create or replace function maint_buy_ask(p_emp text, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; b maint_buys; v_media jsonb := '[]'::jsonb; m jsonb; v_to text[]; v_id bigint;
        lo numeric; hi numeric; q int; v_card uuid;
begin
  s := learn_who(p_emp);
  if not (maint_has(s.id,'technician') or maint_has(s.id,'chef')) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  if length(btrim(coalesce(p_args->>'item',''))) < 2 then raise exception 'no_item' using errcode = 'P0001'; end if;
  if length(btrim(coalesce(p_args->>'model',''))) < 3 then raise exception 'no_model' using errcode = 'P0001'; end if;
  if coalesce(p_args->>'qty','') !~ '^\d{1,4}$' or (p_args->>'qty')::int < 1 then raise exception 'bad_qty' using errcode = 'P0001'; end if;
  q := (p_args->>'qty')::int;
  if coalesce(p_args->>'price_min','') !~ '^\d{1,7}(\.\d{1,2})?$' or coalesce(p_args->>'price_max','') !~ '^\d{1,7}(\.\d{1,2})?$' then raise exception 'bad_range' using errcode = 'P0001'; end if;
  lo := (p_args->>'price_min')::numeric; hi := (p_args->>'price_max')::numeric;
  if hi < lo then raise exception 'bad_range' using errcode = 'P0001'; end if;
  if coalesce(p_args->>'card_id','') <> '' then
    select id into v_card from maint_cards where id = (p_args->>'card_id')::uuid;
    if v_card is null then raise exception 'no_card' using errcode = 'P0001'; end if;
  end if;
  if jsonb_typeof(coalesce(p_args->'media','[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_args->'media','[]'::jsonb)) > 6 then raise exception 'bad_media' using errcode = 'P0001'; end if;
  for m in select * from jsonb_array_elements(coalesce(p_args->'media','[]'::jsonb)) loop
    if coalesce(m->>'path','') !~ '^b/[0-9a-f-]{36}/[A-Za-z0-9._-]+$'
       or not exists(select 1 from storage.objects o where o.bucket_id = 'maint-media' and o.name = m->>'path') then
      raise exception 'bad_media' using errcode = 'P0001'; end if;
    v_media := v_media || jsonb_build_array(jsonb_build_object('path', m->>'path', 'kind', 'photo'));
  end loop;
  insert into maint_buys(is_test, item, model, qty, price_min, price_max, note, card_id, media, asked_by_id, asked_by)
  values (s.name ~* '^zz' or btrim(p_args->>'item') ~* '^zz', left(btrim(p_args->>'item'),120), left(btrim(p_args->>'model'),1000), q, lo, hi,
          nullif(left(btrim(coalesce(p_args->>'note','')),1000),''), v_card, v_media, s.id, s.name)
  returning * into b;
  if b.is_test then v_to := array['fguarracino@robertos.ae'];
  else select array_agg(distinct lower(email)) into v_to from maint_people where active and role = 'buyer';
  end if;
  if v_to is not null and cardinality(v_to) > 0 then
    insert into maint_mail(card_id, buy_id, kind, to_list, is_test) values (null, b.id, 'buy', v_to, b.is_test) returning id into v_id;
    perform maint_kick(v_id);
  end if;
  return maint_buy_row(b);
end $$;

-- provided (the buyer, with an optional note and what it cost) or cancelled (whoever asked, a chef, or the buyer)
create or replace function maint_buy_step(p_emp text, p_id uuid, p_op text, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; b maint_buys; v_paid numeric;
begin
  s := learn_who(p_emp);
  select * into b from maint_buys where id = p_id;
  if b.id is null then raise exception 'no_buy' using errcode = 'P0001'; end if;
  if p_op = 'provided' then
    if not maint_has(s.id,'buyer') then raise exception 'not_buyer' using errcode = 'P0001'; end if;
    if b.status <> 'asked' then raise exception 'buy_done' using errcode = 'P0001'; end if;
    if coalesce(p_args->>'paid','') <> '' then
      if p_args->>'paid' !~ '^\d{1,7}(\.\d{1,2})?$' then raise exception 'bad_amount' using errcode = 'P0001'; end if;
      v_paid := (p_args->>'paid')::numeric;
    end if;
    update maint_buys set status = 'provided', done_by = s.name, done_at = now(), paid = v_paid,
           done_note = nullif(left(btrim(coalesce(p_args->>'note','')),1000),'') where id = p_id returning * into b;
  elsif p_op = 'cancel' then
    if not (b.asked_by_id = s.id or maint_has(s.id,'chef') or maint_has(s.id,'buyer')) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
    if b.status <> 'asked' then raise exception 'buy_done' using errcode = 'P0001'; end if;
    update maint_buys set status = 'cancelled', done_by = s.name, done_at = now(),
           done_note = nullif(left(btrim(coalesce(p_args->>'note','')),1000),'') where id = p_id returning * into b;
  elsif p_op = 'reopen' then
    if not (maint_has(s.id,'buyer') or maint_has(s.id,'chef') or b.asked_by_id = s.id) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
    if b.status = 'asked' then raise exception 'buy_open' using errcode = 'P0001'; end if;
    update maint_buys set status = 'asked', done_by = null, done_at = null, done_note = null, paid = null where id = p_id returning * into b;
  else raise exception 'bad_op' using errcode = 'P0001';
  end if;
  return maint_buy_row(b);
end $$;

-- who I am now also says whether I am a buyer
create or replace function public.maint_me(p_emp text)
 returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare s staff;
begin
  s := learn_who(p_emp);
  return jsonb_build_object('staff_id', s.id, 'name', s.name, 'designation', s.designation,
    'tech', maint_has(s.id,'technician'), 'chef', maint_has(s.id,'chef'), 'followup', maint_has(s.id,'followup'),
    'buyer', maint_has(s.id,'buyer'),
    'followup_after_h', extract(epoch from maint_followup_after())::int / 3600,
    'techs', (select coalesce(jsonb_agg(st.name order by st.name), '[]'::jsonb) from maint_people mp join staff st on st.id = mp.staff_id where mp.role='technician' and mp.active),
    'chefs', (select coalesce(jsonb_agg(st.name order by st.name), '[]'::jsonb) from maint_people mp join staff st on st.id = mp.staff_id where mp.role='chef' and mp.active),
    'followers', (select coalesce(jsonb_agg(st.name order by st.name), '[]'::jsonb) from maint_people mp join staff st on st.id = mp.staff_id where mp.role='followup' and mp.active),
    'buyers', (select coalesce(jsonb_agg(st.name order by st.name), '[]'::jsonb) from maint_people mp join staff st on st.id = mp.staff_id where mp.role='buyer' and mp.active),
    'buys_open', (select count(*) from maint_buys where status = 'asked' and not is_test));
end $function$;

revoke all on function maint_buy_row(maint_buys), maint_buys_get(text), maint_buy_ask(text, jsonb), maint_buy_step(text, uuid, text, jsonb) from public;
grant execute on function maint_buys_get(text), maint_buy_ask(text, jsonb), maint_buy_step(text, uuid, text, jsonb) to anon, authenticated;
