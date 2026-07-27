-- ══════════════════════════════════════════════════════════════════════════
-- MENU DEVELOPMENT PLAN — RESTORE the Q4 2026 seed
--
-- A snapshot of exactly what was in the module on 27 Jul 2026, taken before it
-- was cleared so Francesco and Danilo could build the list together.
--
-- You only need this if you want the 22 seeded menus BACK. Paste the whole
-- file into the Kitchen SQL editor (project zrpglswalgjbtghudmhu) and run it.
-- Safe to run twice — every row is `on conflict (id) do nothing`.
--
-- It restores: 22 menus, 15 calendar squares, 1 campaign (December — Festive),
-- with their original ids, so anything that pointed at them still lines up.
-- It does NOT touch the 5 people, and nothing else in the Kitchen app.
--
-- ORDER MATTERS, and not the obvious way. A menu points at its campaign
-- (campaign_id) and the campaign points back at its core menu (core_menu_id),
-- so neither table can go in first with both columns filled. The campaign goes
-- in with core_menu_id empty, then the menus, then one update joins them up.
-- ══════════════════════════════════════════════════════════════════════════

begin;

-- ══ 1. the campaign, without its core menu yet ════════════════════════════
insert into public.menu_plan_campaigns (id, title, season_label, theme, blurb, date_from, date_to, core_menu_id, sort_order, active, created_at, updated_at, updated_by) values
  ('912c5800-50a5-482d-94d0-6ae2f2550122', 'December — Festive', 'December · festive', null, null, '2026-12-01', '2026-12-31', null, 10, true, '2026-07-24T14:49:18.544995+00:00', '2026-07-24T14:49:18.544995+00:00', null)
on conflict (id) do nothing;

-- ══ 2. the 22 menus ═══════════════════════════════════════════════════════
insert into public.menu_plan_menus (id, name, identity, structure, price, change_cadence, lead_chef, testing_date, launch_date, status, sort_order, active, menu_group, variant_label, kind, campaign_id, event_date, approved_by, approved_at, created_at, updated_at, updated_by) values
  ('b0cc2f61-565e-40f4-958f-3cfd36df1b36', 'À la carte', null, null, null, 'Seasonal', null, null, null, 'draft', 10, true, null, null, 'main', null, null, null, null, '2026-07-24T06:19:59.122938+00:00', '2026-07-24T06:19:59.122938+00:00', null),
  ('23253ad2-4644-464a-bd4a-c344e784189f', 'Scala / Lounge', null, null, null, 'Seasonal', null, null, null, 'draft', 20, true, null, null, 'main', null, null, null, null, '2026-07-24T06:19:59.122938+00:00', '2026-07-24T06:19:59.122938+00:00', null),
  ('d7058665-7154-46d6-9cfc-370acb58703b', 'Business Lunch', null, null, null, 'Monthly', null, null, null, 'draft', 30, true, null, null, 'main', null, null, null, null, '2026-07-24T06:19:59.122938+00:00', '2026-07-24T06:19:59.122938+00:00', null),
  ('26a481ba-23d0-4f16-b759-87acead1fbb7', 'Set Menu A', null, null, null, 'Quarterly', null, null, null, 'draft', 40, true, 'Set Menu', 'A', 'main', null, null, null, null, '2026-07-24T06:19:59.122938+00:00', '2026-07-24T06:19:59.122938+00:00', null),
  ('2efafbdc-9acc-4dda-846f-26851119584b', 'Set Menu B', null, null, null, 'Quarterly', null, null, null, 'draft', 50, true, 'Set Menu', 'B', 'main', null, null, null, null, '2026-07-24T06:19:59.122938+00:00', '2026-07-24T06:19:59.122938+00:00', null),
  ('24fb56e7-a098-4d72-b9f2-b11e380cf3b9', 'Set Menu C', null, null, null, 'Quarterly', null, null, null, 'draft', 60, true, 'Set Menu', 'C', 'main', null, null, null, null, '2026-07-24T06:19:59.122938+00:00', '2026-07-24T06:19:59.122938+00:00', null),
  ('bbbdb2e5-eb35-48bb-a7d2-040331eb7a70', 'Canapé', null, null, null, 'One-off event', null, null, null, 'draft', 70, true, null, null, 'event', null, null, null, null, '2026-07-24T06:19:59.122938+00:00', '2026-07-24T06:19:59.122938+00:00', null),
  ('7289a50a-6efd-409e-872a-377c79c09008', 'Vegan', null, null, null, 'Seasonal', null, null, null, 'draft', 80, true, null, null, 'main', null, null, null, null, '2026-07-24T06:19:59.122938+00:00', '2026-07-24T06:19:59.122938+00:00', null),
  ('13702422-0bd8-4ea6-ac26-50582f83e744', 'Truffle', null, null, null, 'Seasonal', null, null, null, 'draft', 90, true, null, null, 'main', null, null, null, null, '2026-07-24T06:19:59.122938+00:00', '2026-07-24T06:19:59.122938+00:00', null),
  ('f2bc5405-bb3b-4746-b5cd-bc16fa2cae66', 'Festive', null, null, null, 'One-off event', null, null, null, 'draft', 100, true, null, null, 'event', null, null, null, null, '2026-07-24T06:19:59.122938+00:00', '2026-07-24T06:19:59.122938+00:00', null),
  ('8bd3443e-e8c9-485c-a76a-19f3de76e832', 'Dessert', null, null, null, 'Seasonal', null, null, null, 'draft', 110, true, null, null, 'main', null, null, null, null, '2026-07-24T06:19:59.122938+00:00', '2026-07-24T06:19:59.122938+00:00', null),
  ('a259787b-c295-4d7d-b8ad-7761323b5d2a', 'Bartolini Dinner · 2–3 Nov', 'Two-night guest dinner, 2–3 November 2026', null, null, 'One-off event', null, null, '2026-11-02', 'draft', 120, true, null, null, 'event', null, '2026-11-02', null, null, '2026-07-24T06:19:59.122938+00:00', '2026-07-24T06:19:59.122938+00:00', null),
  ('7e9fa467-6292-4ff6-85cd-289f9fe557b7', 'Aperitivo', null, null, null, 'Seasonal', null, null, null, 'draft', 130, true, null, null, 'main', null, null, null, null, '2026-07-24T06:19:59.122938+00:00', '2026-07-24T06:19:59.122938+00:00', null),
  ('a3e4d1df-01c5-4d01-8af6-2f5ad220a525', 'Family Brunch', null, null, null, 'One-off event', null, null, null, 'draft', 140, true, null, null, 'event', null, null, null, null, '2026-07-24T06:19:59.122938+00:00', '2026-07-24T06:19:59.122938+00:00', null),
  ('39a60bee-898b-4d8c-8e22-ec96478448c9', 'Art Nights · 13–16 Nov', 'Art Nights, 13–16 November 2026', null, null, 'One-off event', null, null, '2026-11-13', 'draft', 150, true, null, null, 'event', null, '2026-11-13', null, null, '2026-07-24T06:19:59.122938+00:00', '2026-07-24T06:19:59.122938+00:00', null),
  ('31a6431a-96cf-41d9-a4d4-7c834e71c55b', 'Festive Lunch', null, null, null, 'One-off event', null, null, null, 'draft', 160, true, null, null, 'event', '912c5800-50a5-482d-94d0-6ae2f2550122', null, null, null, '2026-07-24T06:19:59.122938+00:00', '2026-07-24T06:19:59.122938+00:00', null),
  ('a317389f-121a-4435-aa9b-52bc54bb3ba8', 'Festive Corporate Lunch', null, null, null, 'One-off event', null, null, null, 'draft', 170, true, null, null, 'event', '912c5800-50a5-482d-94d0-6ae2f2550122', null, null, null, '2026-07-24T06:19:59.122938+00:00', '2026-07-24T06:19:59.122938+00:00', null),
  ('2ee73639-b3d4-4266-8a37-461c47105c24', 'Festive Dinner', null, null, null, 'One-off event', null, null, null, 'draft', 180, true, null, null, 'event', '912c5800-50a5-482d-94d0-6ae2f2550122', null, null, null, '2026-07-24T06:19:59.122938+00:00', '2026-07-24T06:19:59.122938+00:00', null),
  ('9ee62ccd-b276-4f0f-8666-5fe4efd7a186', 'Festive Corporate Dinner', null, null, null, 'One-off event', null, null, null, 'draft', 190, true, null, null, 'event', '912c5800-50a5-482d-94d0-6ae2f2550122', null, null, null, '2026-07-24T06:19:59.122938+00:00', '2026-07-24T06:19:59.122938+00:00', null),
  ('34e8b168-054c-4009-8983-57db68adc893', 'Christmas Eve · 24 Dec', 'Christmas Eve, 24 December 2026', null, null, 'One-off event', null, null, '2026-12-24', 'draft', 200, true, null, null, 'event', '912c5800-50a5-482d-94d0-6ae2f2550122', '2026-12-24', null, null, '2026-07-24T06:19:59.122938+00:00', '2026-07-24T06:19:59.122938+00:00', null),
  ('d425bf9b-5fd3-4199-a5a3-c8ea53d90d64', 'Christmas Day Lunch · 25 Dec', 'Christmas Day lunch / brunch, 25 December 2026', null, null, 'One-off event', null, null, '2026-12-25', 'draft', 210, true, null, null, 'event', '912c5800-50a5-482d-94d0-6ae2f2550122', '2026-12-25', null, null, '2026-07-24T06:19:59.122938+00:00', '2026-07-24T06:19:59.122938+00:00', null),
  ('3d84ac9b-8a48-4df9-9e79-26b1a10bd6fa', 'New Year''s Eve · 31 Dec', 'New Year''s Eve, 31 December 2026', null, null, 'One-off event', null, null, '2026-12-31', 'draft', 220, true, null, null, 'event', '912c5800-50a5-482d-94d0-6ae2f2550122', '2026-12-31', null, null, '2026-07-24T06:19:59.122938+00:00', '2026-07-24T06:19:59.122938+00:00', null)
on conflict (id) do nothing;

-- ══ 3. now the campaign can point at its core menu ════════════════════════
update public.menu_plan_campaigns set core_menu_id = 'f2bc5405-bb3b-4746-b5cd-bc16fa2cae66' where id = '912c5800-50a5-482d-94d0-6ae2f2550122';

-- ══ 4. the 15 month squares ═══════════════════════════════════════════════
insert into public.menu_plan_calendar (id, menu_id, month, state, date_from, date_to, updated_at, updated_by) values
  ('09a53adb-e00a-42ec-901f-3c079e810f96', 'a317389f-121a-4435-aa9b-52bc54bb3ba8', '2026-12-01', 'Launch', null, null, '2026-07-24T06:19:59.122938+00:00', null),
  ('1ca946cd-6a28-4020-a4c2-15a3e5cced84', '13702422-0bd8-4ea6-ac26-50582f83e744', '2026-11-01', 'Launch', null, null, '2026-07-24T06:19:59.122938+00:00', null),
  ('db2ace40-9a5f-4574-b468-031c8abbed2a', '7e9fa467-6292-4ff6-85cd-289f9fe557b7', '2026-09-01', 'Launch', null, null, '2026-07-24T06:19:59.122938+00:00', null),
  ('5fb87ebe-25b9-48fb-8f63-d88c1416f629', 'b0cc2f61-565e-40f4-958f-3cfd36df1b36', '2026-09-01', 'Launch', null, null, '2026-07-24T06:19:59.122938+00:00', null),
  ('b1cc9c0e-b6f7-4b56-b5c2-d4f9dfc4c4ca', 'd7058665-7154-46d6-9cfc-370acb58703b', '2026-09-01', 'Launch', null, null, '2026-07-24T06:19:59.122938+00:00', null),
  ('c7a0e90b-5e06-40a8-8964-4e10cae39d2f', '9ee62ccd-b276-4f0f-8666-5fe4efd7a186', '2026-12-01', 'Launch', null, null, '2026-07-24T06:19:59.122938+00:00', null),
  ('60043d1c-dcdb-4901-8f49-96955bf08156', 'a3e4d1df-01c5-4d01-8af6-2f5ad220a525', '2026-10-01', 'Launch', null, null, '2026-07-24T06:19:59.122938+00:00', null),
  ('9d34a3cc-fe5b-4344-ae3f-ba8a2f25b023', '31a6431a-96cf-41d9-a4d4-7c834e71c55b', '2026-12-01', 'Launch', null, null, '2026-07-24T06:19:59.122938+00:00', null),
  ('0ddc1598-1c28-4f8e-97dc-aaa13ac79eb5', '2ee73639-b3d4-4266-8a37-461c47105c24', '2026-12-01', 'Launch', null, null, '2026-07-24T06:19:59.122938+00:00', null),
  ('d3d0d123-f1c6-438f-95ac-bb4df4ef148f', 'd425bf9b-5fd3-4199-a5a3-c8ea53d90d64', '2026-12-01', 'Launch', '2026-12-25', null, '2026-07-24T06:19:59.122938+00:00', null),
  ('18379471-1878-4f5c-972c-48d3d1117e1e', '39a60bee-898b-4d8c-8e22-ec96478448c9', '2026-11-01', 'Launch', '2026-11-13', '2026-11-16', '2026-07-24T06:19:59.122938+00:00', null),
  ('2510850e-2d14-4625-93c2-8d14466e9bff', '34e8b168-054c-4009-8983-57db68adc893', '2026-12-01', 'Launch', '2026-12-24', null, '2026-07-24T06:19:59.122938+00:00', null),
  ('706c560a-fa81-4e67-ad43-ab2c71622456', '3d84ac9b-8a48-4df9-9e79-26b1a10bd6fa', '2026-12-01', 'Launch', '2026-12-31', null, '2026-07-24T06:19:59.122938+00:00', null),
  ('6e4ed698-278b-4b75-89e4-6eb897fbaf6d', 'a259787b-c295-4d7d-b8ad-7761323b5d2a', '2026-11-01', 'Launch', '2026-11-02', '2026-11-03', '2026-07-24T06:19:59.122938+00:00', null),
  ('75f5ed89-6a82-4ebf-b1e2-c7c4224576ff', 'a259787b-c295-4d7d-b8ad-7761323b5d2a', '2026-10-01', 'Develop', null, null, '2026-07-24T06:19:59.122938+00:00', null)
on conflict (id) do nothing;

commit;


-- ══ check it did what it said ═════════════════════════════════════════════
-- Expect: menus 22 · calendar 15 · campaigns 1 · people 5.
select 'menus'     as what, count(*) from public.menu_plan_menus
union all select 'calendar',  count(*) from public.menu_plan_calendar
union all select 'campaigns', count(*) from public.menu_plan_campaigns
union all select 'people',    count(*) from public.menu_plan_members;
