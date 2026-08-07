-- ──────────────────────────────────────────────────────────────────────────
-- kitchen_terms — the answers the kitchen has already given.
--
-- A word nobody recognises is asked about ONCE, by one person, and the answer
-- is then free for everybody, offline, for ever. "papin bag" appears in six
-- recipes: that is one decision, not six.
--
-- The Recipes screen works perfectly well WITHOUT this table — answers are
-- kept on the device until it exists, and upload themselves once it does. So
-- running this is not urgent and nothing breaks if it waits.
--
-- Run in: Kitchen project (zrpglswalgjbtghudmhu)
--   https://supabase.com/dashboard/project/zrpglswalgjbtghudmhu/sql/new
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.kitchen_terms (
  term        text primary key,                 -- always stored lower-case
  verdict     text not null check (verdict in ('fix','house')),
  meant       text,                             -- the replacement, when verdict = 'fix'
  answered_by text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.kitchen_terms is
  'Writing help: words the kitchen has ruled on. verdict=fix -> meant holds the correct text; verdict=house -> it is this kitchen''s own word and is never raised again.';

-- A 'fix' has to say what it is a fix TO. A 'house' word must not carry one.
alter table public.kitchen_terms drop constraint if exists kitchen_terms_meant_ck;
alter table public.kitchen_terms add constraint kitchen_terms_meant_ck
  check ((verdict = 'fix' and meant is not null and length(btrim(meant)) > 0)
      or (verdict = 'house' and meant is null));

create or replace function public.kitchen_terms_touch() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists kitchen_terms_touch on public.kitchen_terms;
create trigger kitchen_terms_touch before update on public.kitchen_terms
  for each row execute function public.kitchen_terms_touch();

-- ── access ────────────────────────────────────────────────────────────────
-- Read by every chef on the Recipes screen; written when somebody answers a
-- question. This is a shared kitchen glossary, not personal data — there is
-- nothing here to scope per user, and scoping it per user would defeat the
-- whole point (an answer given once must serve everybody).
alter table public.kitchen_terms enable row level security;

drop policy if exists kitchen_terms_read on public.kitchen_terms;
create policy kitchen_terms_read on public.kitchen_terms
  for select using (true);

drop policy if exists kitchen_terms_write on public.kitchen_terms;
create policy kitchen_terms_write on public.kitchen_terms
  for insert with check (true);

drop policy if exists kitchen_terms_update on public.kitchen_terms;
create policy kitchen_terms_update on public.kitchen_terms
  for update using (true) with check (true);

-- ── seed: what the 7 Aug pass over the live recipes already established ───
-- Only the answers that were verified against every context the word appears
-- in. Anything the pass returned as "ask" is deliberately NOT here — an
-- unanswered question is better than a guessed answer.
insert into public.kitchen_terms (term, verdict, meant, answered_by) values
  ('papin bag',       'fix',   'piping bag',      'writing-review 7 Aug'),
  ('sifon',           'fix',   'siphon',          'writing-review 7 Aug'),
  ('tree fingers',    'fix',   'three fingers',   'writing-review 7 Aug'),
  ('chilly',          'fix',   'chilli',          'writing-review 7 Aug'),
  ('mortar',          'house',  null,             'writing-review 7 Aug'),
  ('excalibur',       'house',  null,             'writing-review 7 Aug'),
  ('silicasec',       'house',  null,             'writing-review 7 Aug'),
  ('pacojet',         'house',  null,             'writing-review 7 Aug'),
  ('lupini',          'house',  null,             'writing-review 7 Aug')
on conflict (term) do nothing;

-- Check it landed:
--   select term, verdict, coalesce(meant,'—') from public.kitchen_terms order by verdict, term;
