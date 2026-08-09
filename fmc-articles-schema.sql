-- ══════════════════════════════════════════════════════════════════════════
-- FMC ARTICLE CATALOGUE — the single source of truth for item creation.
--
-- Harvested from the Kitchen Market List ASSORTMENT, never from
-- stock_take_items. stock_take_items is an inventory export: it keeps
-- discontinued articles indefinitely, and four were confirmed dead in one
-- afternoon on 8 Aug 2026 (4029044 Fennel -Europe, 4017171 Tomato Peeled
-- Casar, 4017201 Porcini Dried Cepes, 4017263 Dates Sugar) — every one of
-- them healthy-looking in the export and every one refused by FMC.
--
-- ADDITIVE ONLY. No DELETE, no TRUNCATE, no DROP. An article that leaves the
-- assortment is MARKED (on_assortment = false), never removed: market-list
-- lines and recipes still point at it and each one is a human decision.
--
-- Run order: this file first, then fmc-articles.sql (the harvested rows).
-- ══════════════════════════════════════════════════════════════════════════

create table if not exists public.fmc_articles (
  code           text primary key,
  name           text not null,          -- FMC's own name, verbatim off the grid
  unit           text,                   -- the unit FMC counts and orders it in
  supplier       text,
  on_assortment  boolean not null default true,
  -- FMC retires an article by renaming it `zzz…` rather than removing it.
  -- Still orderable, being withdrawn. A third state: flagging these as dead
  -- would wrongly flag live market-list lines; ignoring it would offer a chef
  -- an article on its way out.
  retiring       boolean not null default false,
  code_source    text,                   -- grid | order_items | stock_take_items
  venue_id       text not null default 'robertos-difc',
  harvested_at   timestamptz not null default now()
);

create index if not exists fmc_articles_name_idx on public.fmc_articles (lower(name));
create index if not exists fmc_articles_assort_idx on public.fmc_articles (venue_id, on_assortment);

alter table public.fmc_articles enable row level security;

do $$ begin
  create policy fmc_articles_read on public.fmc_articles for select using (true);
exception when duplicate_object then null; end $$;


-- ── order_items.fmc_none ──────────────────────────────────────────────────
-- Eleven market-list lines genuinely have no FMC article — gold leaves, bread
-- improver, Hokkaido milk, charcoal. They are ALLOWED and must stay allowed.
--
-- Without this column they are indistinguishable from "not matched yet", so
-- they would sit in the Match-to-FMC queue for ever, each one asking a
-- question that has already been answered. `fmc_none = true` says a person
-- decided there is no article, which is a different fact from silence.
alter table public.order_items
  add column if not exists fmc_none boolean not null default false;

comment on column public.order_items.fmc_none is
  'True when a person deliberately created this line with no FMC article. Not the same as an unmatched line: it is excluded from the Match to FMC count.';

-- ── order_items.code — what it must NOT be matched against ────────────────
comment on column public.order_items.code is
  'FMC article number. Resolve it against fmc_articles (the assortment), NEVER against stock_take_items — that is an inventory export and carries discontinued articles.';
