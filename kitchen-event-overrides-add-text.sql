-- Kitchen prep overrides: allow a TEXT note instead of a number -----------------
-- e.g. "guests choose on the night", "order to take", "a la carte". Either a
-- number (portions) OR a note (label) is stored; the app shows one or the other,
-- always alongside the events count. Run in the KITCHEN project (zrpglswalgjbtghudmhu).

alter table public.kitchen_event_overrides add column if not exists label text;
alter table public.kitchen_event_overrides alter column portions drop not null;

-- A row must carry at least one of: a number, or a non-empty note.
alter table public.kitchen_event_overrides
  drop constraint if exists kitchen_event_overrides_has_value;
alter table public.kitchen_event_overrides
  add constraint kitchen_event_overrides_has_value
  check (portions is not null or (label is not null and length(btrim(label)) > 0));
