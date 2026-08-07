-- Micros requests — the record of what was sent to Aung, and what was on it.
--
-- Until now the Micros request was built on screen, sent, and forgotten: the only
-- trace it ever existed was the email in Outlook. There was no way to answer "did
-- the Valentine dishes go, when, who sent them, and what price was on the line" —
-- so the same request got rebuilt and re-sent, and nobody could review one.
--
-- Two tables, and the second one is the important one: the ITEMS ARE A SNAPSHOT.
-- The cost and the price are written as they were on the day it went, not read back
-- off the recipe. A recipe changes the week after; reviewing what Aung was sent has
-- to show what Aung was sent, or the review is worse than none at all.
--
-- Status is not a column anybody ticks. A request with no sent_at is a draft; one
-- with a sent_at has been sent. There is nothing to keep in step and nothing to lie.
--
-- Run it once in the KITCHEN Supabase project (zrpglswalgjbtghudmhu) → SQL editor.
-- https://supabase.com/dashboard/project/zrpglswalgjbtghudmhu/sql/new
-- Nothing existing is touched. The app falls back to "no requests yet" until it runs.

create table if not exists public.micros_requests (
  id            uuid primary key default gen_random_uuid(),
  venue_id      text not null default 'robertos-difc',
  dept          text not null default 'kitchen',

  menu_id       uuid references public.menus(id) on delete set null,
  -- the name as it read on the day. A menu renamed later must not rewrite history.
  menu_name     text not null,

  prefix        text,                 -- the till-name prefix used (Valen, RA…)
  dish_count    int  not null default 0,

  -- who it went to. Held on the request, not in the code, so the list can be changed
  -- on the send screen and the next request remembers it.
  send_to       text,
  send_cc       text[],

  -- the whole of the status. null = draft, set = sent.
  sent_at       timestamptz,
  sent_by       text,                 -- emp_id if we have one
  sent_by_name  text,

  note          text,
  created_at    timestamptz not null default now(),
  created_by_name text,
  updated_at    timestamptz not null default now()
);

create index if not exists micros_requests_recent
  on public.micros_requests (venue_id, dept, created_at desc);

-- One line per dish, exactly as it went out on the sheet.
create table if not exists public.micros_request_items (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references public.micros_requests(id) on delete cascade,

  -- kept so the dish can be reopened from the review screen; the request survives
  -- the recipe being deleted, which is why nothing here is read back through it.
  recipe_id    uuid,

  position     int not null default 0,
  name         text not null,        -- the name as it reads on the menu
  section      text,                 -- the Micros family it sat under
  family_code  int,                  -- the family code that went on the sheet
  till_name    text,                 -- the 16-character name, as edited
  cost         numeric,              -- cost per portion ON THE DAY
  price        numeric,              -- menu price ON THE DAY (all taxes in)
  net_price    numeric               -- the same net the sheet's own formula gives
);

create index if not exists micros_request_items_req
  on public.micros_request_items (request_id, position);

-- Access — same posture as the rest of the Kitchen app (anon key, beta).
alter table public.micros_requests      enable row level security;
alter table public.micros_request_items enable row level security;

drop policy if exists micros_requests_all on public.micros_requests;
create policy micros_requests_all on public.micros_requests
  for all using (true) with check (true);

drop policy if exists micros_request_items_all on public.micros_request_items;
create policy micros_request_items_all on public.micros_request_items
  for all using (true) with check (true);

-- Make PostgREST pick up the new tables immediately.
notify pgrst, 'reload schema';
