-- Maintenance -> Tools: a photo on each tool, and a tool taken off the list can be put back.
-- Chef Andrea, Send feedback 20574fbe (18 Oct 2026): "Add a button to cancel the items and we
-- need to be able to add a photo of the tools". Additive only: the live page ignores the new keys.

alter table maint_tools add column if not exists photo text;

-- the bucket already takes job-card files under c/<uuid>/; tool photos go under t/<tool id>/
alter policy maint_media_add on storage.objects
  with check (bucket_id = 'maint-media' and name ~ '^(c|t)/[0-9a-f-]{36}/[A-Za-z0-9._-]+$');

-- set or clear (p_path = '') the photo of a tool on the list
create or replace function maint_tool_photo(p_emp text, p_id uuid, p_path text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; v text := btrim(coalesce(p_path,''));
begin
  s := learn_who(p_emp);
  if not (maint_has(s.id,'technician') or maint_has(s.id,'chef')) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  if v <> '' and (v !~ ('^t/' || p_id::text || '/[A-Za-z0-9._-]+$')
                  or not exists (select 1 from storage.objects o where o.bucket_id = 'maint-media' and o.name = v)) then
    raise exception 'bad_media' using errcode = 'P0001';
  end if;
  update maint_tools set photo = nullif(v,'') where id = p_id and active;
  if not found then raise exception 'no_tool' using errcode = 'P0001'; end if;
  return jsonb_build_object('id', p_id, 'photo', nullif(v,''));
end $$;

-- undo a "Remove": the tool comes back on the list as it was
create or replace function maint_tool_restore(p_emp text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff;
begin
  s := learn_who(p_emp);
  if not (maint_has(s.id,'technician') or maint_has(s.id,'chef')) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  update maint_tools set active = true, retired_by = null, retired_at = null where id = p_id and not active;
  if not found then raise exception 'no_tool' using errcode = 'P0001'; end if;
  return jsonb_build_object('id', p_id);
end $$;

revoke all on function maint_tool_photo(text, uuid, text), maint_tool_restore(text, uuid) from public;
grant execute on function maint_tool_photo(text, uuid, text), maint_tool_restore(text, uuid) to anon, authenticated;

-- the read: each tool carries its photo, and the tools taken off the list come back as 'removed'
create or replace function maint_tools_get(p_emp text, p_month text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
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
                 'price', t.price, 'bought_on', t.bought_on, 'notes', t.notes, 'active', t.active, 'photo', t.photo,
                 'found', c.qty, 'counted_by', c.counted_by, 'counted_at', c.counted_at, 'prev', p.qty)
                 order by t.sort, t.name), '[]'::jsonb)
              from maint_tools t
              left join maint_tool_counts c on c.tool_id = t.id and c.month = m
              left join maint_tool_counts p on p.tool_id = t.id and p.month = pm
             where (t.active and t.created_at < (m + interval '1 month') at time zone 'Asia/Dubai') or c.tool_id is not null),
    'removed', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'used_for', t.used_for, 'photo', t.photo,
                 'retired_by', t.retired_by, 'retired_at', t.retired_at) order by t.retired_at desc), '[]'::jsonb)
              from maint_tools t where not t.active),
    'months', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(x.month,'YYYY-MM'), 'closed_by', x.closed_by, 'closed_at', x.closed_at,
                 'found', x.found, 'value', x.value, 'unpriced', x.unpriced) order by x.month desc), '[]'::jsonb)
              from (select mm.month, mm.closed_by, mm.closed_at, sum(c.qty) found,
                           sum(c.qty * t.price) value, count(*) filter (where t.price is null and c.qty > 0) unpriced
                      from maint_tool_months mm join maint_tool_counts c on c.month = mm.month join maint_tools t on t.id = c.tool_id
                     group by 1,2,3) x));
end $$;
