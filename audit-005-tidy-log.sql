-- Audit dictation clean-up log (audit-api v13 'tidy', 22 Oct 2026). Applied to the Kitchen DB on 22 Oct 2026.
create table if not exists audit_tidy_log (
  id bigint generated always as identity primary key,
  visit_id uuid references audit_visits(id) on delete cascade,
  target text, ref text, lang text, raw text not null, tidy text, model text, ms int,
  created_at timestamptz not null default now()
);
alter table audit_tidy_log enable row level security;
comment on table audit_tidy_log is 'Audit dictation clean-up: what was said and what it became (audit-api tidy, 22 Oct 2026). Service role only.';
