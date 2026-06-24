-- ══════════════════════════════════════════════════════════════════════════
-- Roberto's — STOCK TAKE: atomic "add quantity" helper — KITCHEN
-- Kitchen Supabase project (zrpglswalgjbtghudmhu). Run in the SQL Editor.
-- ADDITIVE ONLY — create or replace. Safe to re-run.
--
-- WHY: the count box is "last writer wins" (one qty per item). The new "+ add"
-- box lets several people add what each of them found (station 2 → walk-in +2 →
-- 4 → dry store +0.5 → 4.5) and have it SUM, not overwrite. Doing that add in the
-- BROWSER would race: two people adding at the same second would each read "2"
-- and write "4", silently losing stock.
--
-- This function does the read-and-add in ONE atomic step on the server, so the
-- second add waits for the first and sums onto the real value — nothing is lost,
-- ever. The app calls it via sb.rpc('stock_take_add', {...}); it returns the new
-- running total (the CLEANED counted weight — the yield gross-up is applied in the
-- app on top, unchanged). Realtime then fans the new qty out to every device.
-- Identical to the FOH helper; both projects keep their own copy.
-- ══════════════════════════════════════════════════════════════════════════

create or replace function stock_take_add(
  p_item_id         uuid,
  p_venue_id        text,
  p_dept            text,
  p_month           text,
  p_delta           numeric,
  p_unit            text,
  p_counted_by      text,
  p_counted_by_name text
) returns numeric
language plpgsql
as $$
declare
  v_qty numeric;
begin
  insert into stock_take_counts
    (item_id, venue_id, dept, month, qty, unit, counted_by, counted_by_name, updated_at)
  values
    (p_item_id, p_venue_id, p_dept, p_month, p_delta, p_unit, p_counted_by, p_counted_by_name, now())
  on conflict (item_id) do update
    set qty             = coalesce(stock_take_counts.qty, 0) + excluded.qty,
        unit            = excluded.unit,
        counted_by      = excluded.counted_by,
        counted_by_name = excluded.counted_by_name,
        updated_at      = now()
  returning qty into v_qty;
  return v_qty;
end;
$$;

grant execute on function stock_take_add(uuid, text, text, text, numeric, text, text, text)
  to anon, authenticated;

notify pgrst, 'reload schema';
