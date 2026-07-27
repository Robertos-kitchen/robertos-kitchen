-- ══════════════════════════════════════════════════════════════════════════
-- MENU DEVELOPMENT PLAN — start the module empty
--
-- Run ONCE in the Supabase SQL editor for the KITCHEN project
-- (zrpglswalgjbtghudmhu).
--
-- WHY
-- The module was seeded with 22 menus taken from the Q4 marketing email.
-- Francesco and Danilo are going to build that list together instead, so the
-- module opens with nothing in it and they fill it as they talk.
--
-- WHAT THIS CLEARS  — three tables, all of them Menu-Plan-only
--   menu_plan_menus      22 rows   the menus and events themselves
--   menu_plan_calendar   15 rows   their month squares (would go anyway — the
--                                  rows cascade when a menu is deleted)
--   menu_plan_campaigns   1 row    'December — Festive'
--
-- WHAT IT DOES NOT TOUCH
--   • menu_plan_members — the 5 people. Tap-your-name still works.
--   • menu_plan_sprint  — the goal row.
--   • Dishes, tastings, comments, files — all already empty, nobody has used
--     the module.
--   • Every other part of the Kitchen app — roster, stock take, recipes,
--     closing report, fish display. Not one of them reads these tables.
--
-- WHAT STAYS READY TO USE
-- Nothing that makes the module work lives in these tables. The four stages
-- (Development · Testing · Approval · Costing) and floating Photoshoot, the
-- request page, the brief templates, the dish sections and allergens, the
-- costing and tasting flows are all in menu-plan.js — they are there on an
-- empty module exactly as they are on a full one.
--
-- TO UNDO
-- Run menu-plan-restore-q4.sql, in this same folder. It puts all 38 rows back
-- exactly as they were on 27 Jul 2026, same ids and all.
-- ══════════════════════════════════════════════════════════════════════════

begin;

-- Calendar first so it is explicit, not a silent cascade.
delete from public.menu_plan_calendar;
delete from public.menu_plan_campaigns;
delete from public.menu_plan_menus;

commit;


-- ══ check it did what it said ═════════════════════════════════════════════
-- Expect: menus 0 · calendar 0 · campaigns 0 · people 5.
select 'menus'     as what, count(*) from public.menu_plan_menus
union all select 'calendar',  count(*) from public.menu_plan_calendar
union all select 'campaigns', count(*) from public.menu_plan_campaigns
union all select 'people',    count(*) from public.menu_plan_members;
