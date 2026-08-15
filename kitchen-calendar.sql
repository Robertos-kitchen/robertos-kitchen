-- ═══════════════════════════════════════════════════════════════════════════
-- CALENDAR MODULE — one table, nothing else.
--
-- One row per note. `chain_id` ties a tasting to its push and its live, which
-- is what lets the tasting tow them when it moves. `series_id` marks the
-- occurrences one repeat rule produced, so "remove the whole series" is one
-- delete rather than sixteen.
--
-- Safe to run twice.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists "pgcrypto";

create table if not exists public.kitchen_cal_notes (
  id         uuid primary key default gen_random_uuid(),
  note_date  date not null,
  kind       text not null check (kind in ('tasting','push','live','event')),
  body       text not null,
  chain_id   uuid,
  series_id  uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists kitchen_cal_notes_date_idx   on public.kitchen_cal_notes (note_date);
create index if not exists kitchen_cal_notes_chain_idx  on public.kitchen_cal_notes (chain_id);
create index if not exists kitchen_cal_notes_series_idx on public.kitchen_cal_notes (series_id);

-- The Kitchen app talks to PostgREST with the anon key straight from the
-- browser, exactly like sched_events and prep_status. Same posture here, made
-- explicit rather than left to RLS being off — and flagged for the security
-- hardening pass, which will move all of these together.
alter table public.kitchen_cal_notes enable row level security;

drop policy if exists kitchen_cal_notes_all on public.kitchen_cal_notes;
create policy kitchen_cal_notes_all
  on public.kitchen_cal_notes
  for all
  to anon, authenticated
  using (true)
  with check (true);

-- Realtime, so two chefs planning at once see each other's changes.
alter publication supabase_realtime add table public.kitchen_cal_notes;
