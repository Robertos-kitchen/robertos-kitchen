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

-- ── 8 Aug 2026, second pass ───────────────────────────────────────────────
-- Who decided. `fmc_verified_at` records WHEN a person confirmed the article
-- behind a line; without a name beside it, a wrong code can only be argued
-- about. Danilo and Antonio sign in with their employee ID to do the matching,
-- so the app already knows — it just needs somewhere to put it.
alter table order_items add column if not exists fmc_verified_by text;
comment on column order_items.fmc_verified_by is 'emp_id of whoever last confirmed this row''s article (see fmc_verified_at). Matches staff.emp_id; 1212/0000/2468 are the admin codes.';

-- ── 8 Aug 2026, third pass: the unit FMC actually orders in ────────────────
-- THE PROBLEM THESE SOLVE. `order_items.unit` is the kitchen's unit — what the
-- chef counts in when he writes the market list. For 180 of the 345 lines that
-- match an FMC article name for name, it is NOT the unit FMC sells in. The line
-- says "Kilogram"; FMC ships a 15 kg carton and the LPO goes out for 15 cartons
-- instead of 15 kilos. Both numbers are right and the order is wrong.
--
-- SOURCE — FMC's own Assortment List report, pulled 8 Aug 2026. NOT the stock
-- take. The stock take is wrong on roughly one line in thirty: it has Bread
-- Crumbs Panko (4017014) as Ctn/16x1 Kg where the assortment says Ctn/6x1 Kg —
-- a 2.7x error sitting in the article catalogue right now, because that
-- catalogue is built from stock_take_items (see article-catalogue.js). These
-- columns exist so the ordering unit has ONE home and it is the assortment.
--
-- The kitchen's own `unit` is not touched, now or ever. The chef keeps counting
-- in what he counts in; the app learns to translate. Where the two differ the
-- market list says so in red, and Match to FMC can filter to just those.
alter table order_items add column if not exists fmc_unit  text;
alter table order_items add column if not exists pack_size text;

comment on column order_items.fmc_unit  is 'The unit FMC actually ORDERS AND SELLS IN, verbatim from FMC''s Assortment List report (e.g. ''Ctn/1x15 Kg'', ''Kilogram'', ''Pkt/1x500 Gm''). Source of truth for anything that becomes an LPO quantity. NOT from stock_take_items — that sheet is wrong on ~1 article in 30 (4017014 Panko reads Ctn/16x1 Kg there against Ctn/6x1 Kg in the assortment). Null = the assortment did not cover this line. Compare against order_items.unit, which is the kitchen''s counting unit and is deliberately left alone.';
comment on column order_items.pack_size is 'fmc_unit written out for a human, generated from it, never typed: ''a pack (1 carton = 15kg)'' for ''Ctn/1x15 Kg''. Shown beside the red flag on the market list so nobody has to decode FMC''s shorthand at a stove. Null when fmc_unit is null or is already a plain unit needing no expansion (''Kilogram'', ''Each'').';

-- The mismatch review is a whole-list question — "show me every line where the
-- two units disagree" — so it is asked of every active row at once.
create index if not exists order_items_fmc_unit_idx on order_items (fmc_unit) where fmc_unit is not null;
