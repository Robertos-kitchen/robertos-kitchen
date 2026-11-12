-- ═══════════════════════════════════════════════════════════════════════════
-- KITCHEN DESIGN — ACCESS BY CODE (12 Nov 2026)
-- Only three people may open or change Kitchen Design: Chef Francesco, Andrea Sacchi
-- (both already hold MASTER codes) and Andrea Falcone (his own Kitchen Design code,
-- stored HASHED in kd_access; it does NOT open any other module).
--
-- After this file the two tables kd_projects / kd_docs cannot be read or written by the
-- anon key at all. Every read and write goes through the functions below, and each of
-- them refuses unless kd_who(code) knows the code.
--
-- Touches only the tables made for Kitchen Design on 12 Nov. Safe to run twice.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.kd_access (
  name text not null,
  code_hash text primary key,
  created_at timestamptz not null default now()
);
alter table public.kd_access enable row level security;
revoke all on public.kd_access from anon, authenticated;

create or replace function public.kd_who(p_code text)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    public.master_name(p_code),
    (select a.name from public.kd_access a
      where a.code_hash = encode(sha256(convert_to('robertos-kd:' || btrim(coalesce(p_code,'')), 'utf8')), 'hex') limit 1));
$$;
revoke all on function public.kd_who(text) from public, anon, authenticated;

create or replace function public.kd_check(p_code text)
returns text language sql stable security definer set search_path = public as $$
  select public.kd_who(p_code);
$$;

create or replace function public.kd_projects_list(p_code text)
returns setof public.kd_projects language plpgsql stable security definer set search_path = public as $$
begin
  if public.kd_who(p_code) is null then raise exception 'no_access' using errcode = 'P0001'; end if;
  return query select * from public.kd_projects where not archived order by created_at;
end $$;

create or replace function public.kd_project_create(p_code text, p_name text, p_place text)
returns public.kd_projects language plpgsql volatile security definer set search_path = public as $$
declare r public.kd_projects;
begin
  if public.kd_who(p_code) is null then raise exception 'no_access' using errcode = 'P0001'; end if;
  if btrim(coalesce(p_name,'')) = '' then raise exception 'no_name' using errcode = 'P0001'; end if;
  insert into public.kd_projects (name, place) values (btrim(p_name), nullif(btrim(coalesce(p_place,'')), '')) returning * into r;
  return r;
end $$;

create or replace function public.kd_doc_get(p_code text, p_project uuid, p_coll text, p_id text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r public.kd_docs;
begin
  if public.kd_who(p_code) is null then raise exception 'no_access' using errcode = 'P0001'; end if;
  select * into r from public.kd_docs where project_id = p_project and coll = p_coll and doc_id = p_id;
  if not found then return null; end if;
  return jsonb_build_object('data', r.data, 'at', r.updated_at);
end $$;

create or replace function public.kd_doc_put(p_code text, p_project uuid, p_coll text, p_id text, p_data jsonb)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if public.kd_who(p_code) is null then raise exception 'no_access' using errcode = 'P0001'; end if;
  insert into public.kd_docs (project_id, coll, doc_id, data, updated_at) values (p_project, p_coll, p_id, p_data, now())
  on conflict (project_id, coll, doc_id) do update set data = excluded.data, updated_at = now();
end $$;

create or replace function public.kd_doc_del(p_code text, p_project uuid, p_coll text, p_id text)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if public.kd_who(p_code) is null then raise exception 'no_access' using errcode = 'P0001'; end if;
  delete from public.kd_docs where project_id = p_project and coll = p_coll and doc_id = p_id;
end $$;

create or replace function public.kd_doc_list(p_code text, p_project uuid, p_coll text)
returns table (doc_id text, data jsonb, updated_at timestamptz) language plpgsql stable security definer set search_path = public as $$
begin
  if public.kd_who(p_code) is null then raise exception 'no_access' using errcode = 'P0001'; end if;
  return query select d.doc_id, d.data, d.updated_at from public.kd_docs d where d.project_id = p_project and d.coll = p_coll limit 2000;
end $$;

revoke all on function public.kd_check(text), public.kd_projects_list(text), public.kd_project_create(text,text,text),
  public.kd_doc_get(text,uuid,text,text), public.kd_doc_put(text,uuid,text,text,jsonb),
  public.kd_doc_del(text,uuid,text,text), public.kd_doc_list(text,uuid,text) from public;
grant execute on function public.kd_check(text), public.kd_projects_list(text), public.kd_project_create(text,text,text),
  public.kd_doc_get(text,uuid,text,text), public.kd_doc_put(text,uuid,text,text,jsonb),
  public.kd_doc_del(text,uuid,text,text), public.kd_doc_list(text,uuid,text) to anon, authenticated;

-- Close the open doors: the tables are reachable ONLY through the functions above.
drop policy if exists kd_projects_all on public.kd_projects;
drop policy if exists kd_docs_all on public.kd_docs;
revoke all on public.kd_projects from anon, authenticated;
revoke all on public.kd_docs from anon, authenticated;

-- Andrea Falcone's Kitchen Design code is added separately, as a HASH only:
--   insert into public.kd_access (name, code_hash) values ('Andrea Falcone', '<sha256 of "robertos-kd:" + code>')
--   on conflict (code_hash) do nothing;
