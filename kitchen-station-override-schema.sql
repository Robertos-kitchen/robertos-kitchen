-- One-day "cover another section" support for the schedule + Roster tool.
-- Adds a single optional column to the existing roster table: when set, that
-- person is working in a DIFFERENT section for that ONE day only. Their real
-- section (staff.station_key) never changes. NULL = normal (their own section).
--
-- Safe to run once. Does nothing if the column already exists.

ALTER TABLE roster ADD COLUMN IF NOT EXISTS station_override text;

-- Let PostgREST see the new column immediately.
NOTIFY pgrst, 'reload schema';
