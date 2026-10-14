-- ════════════════════════════════════════════════════════════════════════════
-- Chef Bartolini Audit (14 Oct 2026, Francesco)
--
-- Enrico audits Roberto's DIFC on his iPhone from a private link (audit.html?k=…),
-- types or dictates in Italian, adds photos. Every note is translated to English
-- (original Italian kept). Francesco opens the report link (audit.html?a=…),
-- checks the English, sets owner + date on the actions, and emails it to Amin.
--
-- The anon key can read or write NOTHING here: RLS is on with no policies. Every
-- read and write goes through the audit-api Edge Function, which checks the
-- visit's token. Additive only.
-- ════════════════════════════════════════════════════════════════════════════

-- The fixed list of what Enrico scores. area: arrivo | cucina | ristorante | vino | scala
create table if not exists audit_catalog (
  code      text primary key,
  area      text not null,
  position  int  not null,
  label_it  text not null,
  label_en  text not null,
  active    boolean not null default true
);

-- One row per visit. status: archived (an old paper audit, kept for trend) | open | submitted | sent
create table if not exists audit_visits (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  visit_date    date,
  auditor       text not null default 'Chef Enrico Bartolini',
  enrico_token  text unique,
  admin_token   text unique,
  status        text not null default 'open',
  overall_pct   numeric,
  area_pct      jsonb not null default '{}'::jsonb,
  source_note   text,
  submitted_at  timestamptz,
  sent_at       timestamptz,
  sent_to       text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One score per item per visit. verdict: ok | fix | urgent
create table if not exists audit_scores (
  id          uuid primary key default gen_random_uuid(),
  visit_id    uuid not null references audit_visits(id) on delete cascade,
  code        text not null references audit_catalog(code),
  score       smallint check (score between 1 and 5),
  na          boolean not null default false,
  verdict     text,
  note_it     text,
  note_en     text,
  en_src      text,          -- the Italian the English was made from; differs = needs translating again
  photos      jsonb not null default '[]'::jsonb,
  owner       text,
  due         date,
  done        boolean not null default false,
  updated_at  timestamptz not null default now(),
  unique (visit_id, code)
);

-- Dish by dish. verdict: keep | fix | remove
create table if not exists audit_dishes (
  id          uuid primary key default gen_random_uuid(),
  visit_id    uuid not null references audit_visits(id) on delete cascade,
  recipe_id   uuid,
  dish_name   text not null,
  score       smallint check (score between 1 and 5),
  verdict     text,
  note_it     text,
  note_en     text,
  en_src      text,
  photos      jsonb not null default '[]'::jsonb,
  owner       text,
  due         date,
  done        boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Quick photo flags at any moment. area: piatto | cucina | ristorante | scala. kind: keep | attention
create table if not exists audit_flags (
  id          uuid primary key default gen_random_uuid(),
  visit_id    uuid not null references audit_visits(id) on delete cascade,
  area        text not null,
  recipe_id   uuid,
  dish_name   text,
  kind        text not null default 'attention',
  note_it     text,
  note_en     text,
  en_src      text,
  photos      jsonb not null default '[]'::jsonb,
  owner       text,
  due         date,
  done        boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Final comment. key: overall | improve | p1 | p2 | p3
create table if not exists audit_texts (
  visit_id    uuid not null references audit_visits(id) on delete cascade,
  key         text not null,
  it          text,
  en          text,
  en_src      text,
  photos      jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (visit_id, key)
);

-- Every email sent, kept.
create table if not exists audit_mail (
  id          uuid primary key default gen_random_uuid(),
  visit_id    uuid not null references audit_visits(id) on delete cascade,
  sent_to     text,
  cc          text,
  subject     text,
  status      text,
  error       text,
  created_at  timestamptz not null default now()
);

alter table audit_catalog enable row level security;
alter table audit_visits  enable row level security;
alter table audit_scores  enable row level security;
alter table audit_dishes  enable row level security;
alter table audit_flags   enable row level security;
alter table audit_texts   enable row level security;
alter table audit_mail    enable row level security;
-- No policies on purpose: only the audit-api function (service role) touches these.

-- Private photo bucket (signed links only).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('audit-photos', 'audit-photos', false, 10485760, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

-- The 33 items.
insert into audit_catalog (code, area, position, label_it, label_en) values
 ('arr.door',      'arrivo',     1, 'Benvenuto alla porta (security)',                'Welcome at the door (security)'),
 ('arr.hostess',   'arrivo',     2, 'Desk hostess: sorriso, saluto, attenzione',      'Hostess desk: smile, greeting, attention'),
 ('arr.desk',      'arrivo',     3, 'Allestimento del desk: fiori, ordine',           'Desk set-up: flowers, no clutter'),
 ('arr.walk',      'arrivo',     4, 'Accompagnamento al tavolo e racconto di Roberto''s', 'Walk to the table and the Roberto''s story'),
 ('arr.first',     'arrivo',     5, 'Tempo del primo contatto al tavolo',             'Time to first contact at the table'),
 ('cuc.menu',      'cucina',     1, 'Selezione del menu e identità',                  'Menu selection & identity'),
 ('cuc.product',   'cucina',     2, 'Qualità dei prodotti e stagionalità',            'Product quality & seasonality'),
 ('cuc.technique', 'cucina',     3, 'Tecnica',                                        'Technique'),
 ('cuc.mep',       'cucina',     4, 'Standard della mise en place',                   'Mise en place standard'),
 ('cuc.clean',     'cucina',     5, 'Pulizia e disciplina in servizio',               'Cleanliness & discipline during service'),
 ('cuc.org',       'cucina',     6, 'Organizzazione: stoccaggio, etichette, plonge',  'Organisation: storage, labelling, pot wash'),
 ('cuc.speed',     'cucina',     7, 'Velocità e coordinamento cucina–sala',           'Speed & kitchen–floor coordination'),
 ('cuc.consist',   'cucina',     8, 'Costanza da inizio a fine servizio',             'Consistency from start to end of service'),
 ('cuc.crockery',  'cucina',     9, 'Stoviglie e presentazione',                      'Crockery & presentation'),
 ('ris.service',   'ristorante', 1, 'Qualità del servizio e coordinamento',           'Service quality & team coordination'),
 ('ris.knowledge', 'ristorante', 2, 'Conoscenza del team e storytelling',             'Team knowledge & storytelling'),
 ('ris.light',     'ristorante', 3, 'Luci',                                           'Lighting'),
 ('ris.music',     'ristorante', 4, 'Volume della musica',                            'Music volume'),
 ('ris.table',     'ristorante', 5, 'Mise en place del tavolo e centrotavola',        'Table set-up & centrepieces'),
 ('ris.bread',     'ristorante', 6, 'Servizio pane e olio',                           'Bread & olive oil service'),
 ('ris.atmos',     'ristorante', 7, 'Atmosfera e identità',                           'Atmosphere & identity'),
 ('vin.list',      'vino',       1, 'Profondità della carta e annate',                'Wine list depth & vintages'),
 ('vin.glass',     'vino',       2, 'Vini al calice',                                 'Wines by the glass'),
 ('vin.service',   'vino',       3, 'Conoscenza e servizio del vino',                 'Wine knowledge & service'),
 ('vin.glassware', 'vino',       4, 'Bicchieri',                                      'Glassware'),
 ('sca.service',   'scala',      1, 'Qualità del servizio',                           'Service quality'),
 ('sca.knowledge', 'scala',      2, 'Conoscenza del team e vendita',                  'Team knowledge & upselling'),
 ('sca.light',     'scala',      3, 'Luci',                                           'Lighting'),
 ('sca.music',     'scala',      4, 'Musica',                                         'Music'),
 ('sca.table',     'scala',      5, 'Mise en place in base all''ordine',              'Table set-up matched to the order'),
 ('sca.cocktail',  'scala',      6, 'Carta cocktail e qualità',                       'Cocktail list & quality'),
 ('sca.cigar',     'scala',      7, 'Selezione sigari',                               'Cigar selection'),
 ('sca.atmos',     'scala',      8, 'Atmosfera e bancone bar',                        'Atmosphere & bar counter')
on conflict (code) do nothing;

-- 14 Oct 2026: a dish or flag Enrico takes back is hidden, never deleted.
alter table audit_dishes add column if not exists removed boolean not null default false;
alter table audit_flags  add column if not exists removed boolean not null default false;
