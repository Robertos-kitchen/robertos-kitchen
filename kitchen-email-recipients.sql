-- ═══════════════════════════════════════════════════════════════════════════
-- WHO GETS THE KITCHEN EMAILS — 7 Aug 2026
--
-- The Stock Take recipients were four addresses typed into stock-take.js, so a
-- leaver kept receiving it until someone edited the file and redeployed. This
-- table holds them instead, and the Stock Take screen edits it in-app
-- (Send → Manage recipients, admin codes only).
--
-- SAFE TO RUN BEFORE OR AFTER THE APP DEPLOY, in either order:
--   · app deployed, table missing  → the send falls back to the built-in list,
--                                    exactly as it behaved before. Nothing breaks.
--   · table present, app not yet   → nothing reads it. Nothing breaks.
--
-- Built as a general list (list_key), not a stock-take-only table, so the Market
-- Order and anything else that emails can move off its hardcoded list the same
-- way without a second migration.
--
-- Kitchen database: zrpglswalgjbtghudmhu   (NOT the FOH project)
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.kitchen_email_recipients (
  id          bigserial primary key,
  list_key    text    not null,                       -- 'kitchen_stock_take', later 'kitchen_market_order', …
  email       text    not null,
  name        text,                                   -- what the app calls them on the send ("Send to Aung")
  role        text    not null default 'cc'
              check (role in ('to','cc')),            -- exactly one 'to' per list; the rest are copies
  sort_order  integer not null default 100,
  active      boolean not null default true,          -- removals deactivate, never delete: who used to
                                                      -- receive it stays answerable later
  created_at  timestamptz not null default now()
);

-- One row per person per list, so "Add" can never create a silent duplicate
-- that emails someone twice.
create unique index if not exists kitchen_email_recipients_list_email_idx
  on public.kitchen_email_recipients (list_key, lower(email));

create index if not exists kitchen_email_recipients_list_active_idx
  on public.kitchen_email_recipients (list_key, active, sort_order);

-- ── The current Stock Take list, moved across exactly as it stands today ──
-- Re-running this file will not duplicate them (on conflict do nothing).
insert into public.kitchen_email_recipients (list_key, email, name, role, sort_order) values
  ('kitchen_stock_take', 'ahtwe@robertos.ae',        'Aung',      'to', 10),
  ('kitchen_stock_take', 'dvalla@robertos.ae',       'Danilo',    'cc', 20),
  ('kitchen_stock_take', 'astellacci@robertos.ae',   'Antonio',   'cc', 30),
  ('kitchen_stock_take', 'amohamed@robertos.ae',     'Asarudeen', 'cc', 40),
  ('kitchen_stock_take', 'fguarracino@robertos.ae',  'Francesco', 'cc', 50)
on conflict do nothing;

-- ── Access ──
-- Beta posture, same as the rest of the Kitchen tables: the app holds the anon
-- key and the Manage-recipients panel is gated client-side on the admin codes.
-- RLS is left off here so it matches its neighbours rather than being the one
-- table that silently returns zero rows (see app_users RLS, which does exactly
-- that in FOH). Tighten it in the security hardening pass, with the others.

-- ── Check it landed ──
select role, sort_order, name, email, active
from public.kitchen_email_recipients
where list_key = 'kitchen_stock_take'
order by role desc, sort_order;
