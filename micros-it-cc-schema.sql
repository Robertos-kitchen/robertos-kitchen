-- The IT team, copied on every Micros request.
--
-- Antonio, 2 Sep 2026: a dish that goes into Micros has to appear on the Annoncer
-- kitchen display too, on the right section — and only IT can say which section SEES
-- it and which section may MODIFY it. So IT rides on the request itself instead of
-- being chased afterwards, and the mail asks that question naming the sections the
-- request actually touches.
--
-- Why a column and not a hardcoded list in the page: the addresses on this request
-- have moved twice already, and a list in the code keeps mailing whoever left until
-- somebody redeploys. This is the same table, the same admin panel, one more box.
--
-- '{}' means NOBODY from IT is copied and the question is not asked. That is the
-- supported way to switch it off — emptying the box on the admin panel does exactly
-- this. It is NOT the same as the column not existing: until this file is run, the
-- page falls back to the two addresses below on its own.
--
-- Run it once in the KITCHEN Supabase project (zrpglswalgjbtghudmhu) → SQL editor.
-- https://supabase.com/dashboard/project/zrpglswalgjbtghudmhu/sql/new

alter table public.micros_settings
  add column if not exists it_cc text[] not null default '{}';

-- Seeded with the two people who actually carry Annoncer: Muhammed Mansoor, IT Admin
-- at Skelmore, who owns the Annoncer tickets with CADD, and Niyaz Ahamed, who issued
-- the my.annonceronline.com logins on 1 Sep 2026. Pier Blanco is IT too but has no
-- Annoncer traffic — add him on the admin panel if that changes; no deploy needed.
-- Only seeds a row that has never been set, so re-running this cannot undo a change
-- somebody made on the panel.
update public.micros_settings
   set it_cc = array['mmansoor@skelmore.com','nahamed@skelmore.com']
 where id = 1 and (it_cc is null or it_cc = '{}');

notify pgrst, 'reload schema';
