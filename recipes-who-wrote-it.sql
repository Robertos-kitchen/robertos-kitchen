-- Who wrote the recipe, and who last changed it.
--
-- `created_by` and `created_by_name` already exist on `recipes` (recipes-module-001.sql)
-- and have never been written to — all 77 rows are NULL in both. Nothing to add there.
--
-- These two are new. Text, not a foreign key to `staff`, for the same reason
-- `created_by` is text: a chef who leaves is deactivated on the staff list, and a
-- recipe must not lose the name of the person who wrote it when that happens.
--
-- Kitchen database: zrpglswalgjbtghudmhu  (NOT the FOH one)

alter table recipes add column if not exists updated_by      text;
alter table recipes add column if not exists updated_by_name text;

-- What it looks like afterwards.
select column_name, data_type
from information_schema.columns
where table_name = 'recipes'
  and column_name in ('created_by','created_by_name','updated_by','updated_by_name')
order by column_name;
