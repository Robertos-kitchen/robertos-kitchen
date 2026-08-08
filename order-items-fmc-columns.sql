-- ═══════════════════════════════════════════════════════════════════════════
-- order_items — the FMC columns
-- Kitchen App · Supabase zrpglswalgjbtghudmhu · 8 August 2026
--
-- Additive only (ARCHITECTURE §2.1). Nothing is dropped, renamed or reseeded.
-- `code` already exists on the table and is null on all 459 rows; the review
-- screen fills it. These columns give a market-list line the rest of what FMC
-- knows about the article behind it.
--
-- ON THE PRICE COLUMN — this is deliberately NOT called last_price.
-- `stock_take_items.price` is the cost controller's monthly VALUATION, not the
-- price that lands on the LPO. Measured 8 Aug 2026 against FMC's own grid:
--     Cucumber Medium -GCC   FMC 4.50   stock take 4.96   (out by 10%)
--     Potato Idaho           FMC 18.75  stock take 18.80
--     Baby Marrow -GCC       FMC 4.90   stock take 4.90
-- So it is cc_price ("cost controller's price"), it always travels with the
-- sheet it came from (cc_price_month), and anything totalled from it is an
-- ESTIMATE, never a total. The name `last_price` is left free on purpose: an
-- FMC row copy returns a real Last Price alongside the supplier, and that is
-- what should eventually own the name.
-- ═══════════════════════════════════════════════════════════════════════════

alter table order_items add column if not exists supplier        text;
alter table order_items add column if not exists cc_price        numeric;
alter table order_items add column if not exists cc_price_month  text;
alter table order_items add column if not exists item_group      text;
alter table order_items add column if not exists fmc_verified_at timestamptz;

comment on column order_items.supplier        is 'Supplier name as FMC holds it. Null until the stock-take export carries a supplier column (asked of Aung, 8 Aug 2026).';
comment on column order_items.cc_price        is 'Cost controller''s price from the stock-take sheet named in cc_price_month. A monthly valuation, NOT the FMC purchase price — drifts by up to ~10%. Anything summed from it is an estimate.';
comment on column order_items.cc_price_month  is 'Which stock_take_items sheet cc_price came from: ''YYYY-MM-DD'' (or legacy ''YYYY-MM''). Never show cc_price without it.';
comment on column order_items.item_group      is 'FMC item group (e.g. ''Vegetables Fresh''). FMC''s own vocabulary — the market list keeps its own `category` (''VEGETABLES''), which the kitchen navigates by. Mapped, not replaced.';
comment on column order_items.fmc_verified_at is 'When a human last confirmed this row''s code really is this article in FMC. Null = never confirmed.';

-- Finding a line by its article is the one lookup every later step makes
-- (add-from-catalogue, the review screen, the helper).
create index if not exists order_items_code_idx on order_items (code) where code is not null;
