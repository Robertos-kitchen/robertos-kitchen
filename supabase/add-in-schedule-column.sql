-- "Show in the schedule" per-person toggle (set from the FOH Admin control centre).
-- Run once in the KITCHEN Supabase project (zrpglswalgjbtghudmhu).
-- Additive + safe: every existing person defaults to TRUE (shows in the roster),
-- so nothing changes until you turn someone OFF in Admin.

alter table staff add column if not exists in_schedule boolean not null default true;
notify pgrst, 'reload schema';
