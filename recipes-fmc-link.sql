-- ═══════════════════════════════════════════════════════════════════════════
-- Remember which FMC article a batch recipe IS
--
-- 28 Aug 2026. The "Our cost against FMC" screen (Article Catalogue → Against
-- FMC) can only compare a batch when its name matches an FMC article exactly.
-- Ten do. Another ten have a name that is nearly right — "Chocolate sorbet"
-- against "RF Chocolate Sorbert (PA)", "Raspberry gel" against "RF Raspbery
-- Gel (PA)" — and the screen shows those as a QUESTION and never as a pair,
-- because the same scoring puts "Rice cream" next to "RF Garlic Cream (PA)"
-- and "Cauliflower clean" next to "RF Cauliflower Caramel (PA)". Pairing on a
-- score would print a confident cost gap between two different things, which
-- is the failure the screen exists to catch.
--
-- So a person answers it once, and these columns are where that answer lives.
--
-- The shape is copied from `order_items`, which has answered exactly this
-- question about market-list lines since the Match to FMC module shipped —
-- same column names, same meaning, so there is one convention in this
-- database and not two.
--
--   fmc_code         the article this batch IS
--   fmc_none         TRUE = a person looked and there is no FMC article for it.
--                    A REAL ANSWER, not a skip: pastry and prep that FMC has
--                    never carried are most of the list, and without this they
--                    come back round the queue every time the screen is opened.
--   fmc_verified_at  when a person decided. NULL = nobody has looked yet.
--   fmc_verified_by  who decided (emp_id), the same way created_by is stored.
--
-- Safe to run twice. Adds nothing to any read path that does not ask for it,
-- and no existing query selects these names.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.recipes add column if not exists fmc_code        text;
alter table public.recipes add column if not exists fmc_none        boolean not null default false;
alter table public.recipes add column if not exists fmc_verified_at timestamptz;
alter table public.recipes add column if not exists fmc_verified_by text;

comment on column public.recipes.fmc_code is
  'The FMC article code this batch recipe is, decided by a person on the Against FMC screen. Never set by a name score.';
comment on column public.recipes.fmc_none is
  'TRUE when a person looked and there is no FMC article for this batch. A real answer, so it stops being asked.';
comment on column public.recipes.fmc_verified_at is
  'When a person answered. NULL means nobody has looked yet.';
comment on column public.recipes.fmc_verified_by is
  'emp_id of whoever answered.';

-- Only batches are ever asked the question, and only ~112 rows exist, so this
-- index is about intent rather than speed: it says out loud that "answered"
-- and "not answered" is the split this table is now read by.
create index if not exists recipes_fmc_unanswered_idx
  on public.recipes (venue_id)
  where kind = 'batch' and archived = false and fmc_verified_at is null;

-- ── check it ───────────────────────────────────────────────────────────────
-- Should return the four new columns, then 0 answered / 57-ish unanswered.
select column_name, data_type, column_default
  from information_schema.columns
 where table_schema = 'public' and table_name = 'recipes'
   and column_name like 'fmc%'
 order by column_name;

select count(*) filter (where fmc_verified_at is not null) as answered,
       count(*) filter (where fmc_verified_at is null)     as not_yet_asked
  from public.recipes
 where kind = 'batch' and archived = false;
