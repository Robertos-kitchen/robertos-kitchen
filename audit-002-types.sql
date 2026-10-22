-- Audit types (22 Oct 2026, Francesco). Additive only.
-- Three kinds of audit: 'venue' (Chef Enrico, whole venue), 'restaurant' (a guest visit to the
-- restaurant, booking included) and 'scala' (bar & lounge). Each question says which kinds it
-- belongs to. New sections: Booking (prenota), Washroom (bagno), Bill & goodbye (congedo), plus
-- four bar standards and "acknowledged within 1 minute" for Scala. Approved by Francesco 22 Oct
-- after the research (LQA / Forbes-style restaurant and bar checklists). Enrico's audit gets
-- Washroom + Bill & goodbye too (his choice).
-- The 2022 visit is no longer a comparison ("different restaurant, different standard"): it is
-- removed (kept, with the reason), and only visits under the new standard are compared.

alter table public.audit_catalog add column if not exists kinds text[] not null default '{venue}';
alter table public.audit_visits add column if not exists kind text not null default 'venue';
alter table public.audit_visits add column if not exists removed_at timestamptz;
alter table public.audit_visits add column if not exists removed_by text;
alter table public.audit_visits add column if not exists removed_reason text;

-- Existing questions: which kinds they belong to.
update public.audit_catalog set kinds = '{venue,restaurant,scala}' where code in ('arr.door','arr.hostess');
update public.audit_catalog set kinds = '{venue,restaurant}' where code in ('arr.desk','arr.walk','arr.first',
  'cuc.menu','cuc.product','cuc.technique','cuc.crockery',
  'ris.service','ris.knowledge','ris.light','ris.music','ris.table','ris.bread','ris.atmos',
  'vin.list','vin.glass','vin.service','vin.glassware');
update public.audit_catalog set kinds = '{venue}' where code in ('cuc.mep','cuc.clean','cuc.org','cuc.speed','cuc.consist');
update public.audit_catalog set kinds = '{venue,scala}' where code like 'sca.%';

insert into public.audit_catalog (code, area, position, label_it, label_en, active, kinds) values
  ('pre.answer',   'prenota', 1, 'Risposta entro 3 squilli / 10 secondi (o risposta a una prenotazione online entro 1 ora)', 'Answered within 3 rings / 10 seconds (or a reply to an online booking within 1 hour)', false, '{restaurant,scala}'),
  ('pre.greet',    'prenota', 2, 'Saluto cordiale; il mio nome preso e usato', 'Warm greeting; my name taken and used', false, '{restaurant,scala}'),
  ('pre.repeat',   'prenota', 3, 'Dettagli ripetuti: data, ora, persone, telefono', 'Details repeated back: date, time, guests, phone', false, '{restaurant,scala}'),
  ('pre.occasion', 'prenota', 4, 'Chiesto se c''è un''occasione e se ci sono allergie', 'Asked about the occasion and allergies', false, '{restaurant,scala}'),
  ('pre.confirm',  'prenota', 5, 'Conferma ricevuta, dettagli corretti', 'Confirmation received, details correct', false, '{restaurant,scala}'),
  ('pre.ready',    'prenota', 6, 'Tavolo pronto all''ora prenotata (attesa non oltre 5 minuti)', 'Table ready at the booked time (no wait over 5 minutes)', false, '{restaurant,scala}'),
  ('arr.ack',      'arrivo',  6, 'Accolto entro 1 minuto', 'Acknowledged within 1 minute', false, '{scala}'),
  ('sca.speed',    'scala',   9, 'Ordine preso entro 3 minuti da quando ci si siede', 'Order taken within 3 minutes of sitting', false, '{scala}'),
  ('sca.drink',    'scala',  10, 'Qualità del drink: equilibrio, temperatura, guarnizione', 'Drink quality: balance, temperature, garnish', false, '{scala}'),
  ('sca.glass',    'scala',  11, 'Bicchieri: perfetti, freddi dove serve', 'Glassware: spotless, chilled where it should be', false, '{scala}'),
  ('sca.round',    'scala',  12, 'Nuovo giro proposto prima che il bicchiere sia vuoto', 'Next round offered before the glass is empty', false, '{scala}'),
  ('bag.clean',    'bagno',   1, 'Pulito, asciutto, nessun odore', 'Clean, dry, no smell', false, '{venue,restaurant,scala}'),
  ('bag.stock',    'bagno',   2, 'Fornito: sapone, asciugamani, amenities', 'Stocked: soap, towels, amenities', false, '{venue,restaurant,scala}'),
  ('bag.upkeep',   'bagno',   3, 'Arredo, luce e manutenzione all''altezza del ristorante', 'Decor, light and upkeep match the restaurant', false, '{venue,restaurant,scala}'),
  ('con.bill',     'congedo', 1, 'Conto portato subito quando richiesto', 'Bill brought promptly when asked', false, '{venue,restaurant}'),
  ('con.correct',  'congedo', 2, 'Conto corretto, niente di aggiunto', 'Bill correct, nothing added', false, '{venue,restaurant,scala}'),
  ('con.discreet', 'congedo', 3, 'Pagamento gestito con discrezione al tavolo', 'Payment handled discreetly at the table', false, '{venue,restaurant,scala}'),
  ('con.bye',      'congedo', 4, 'Ringraziato e salutato alla porta', 'Thanked and said goodbye at the door', false, '{venue,restaurant,scala}')
on conflict (code) do nothing;
-- The new questions go in inactive; they are switched on (active = true) once audit-api v8,
-- which hides the new sections from older pages, is live:
--   update public.audit_catalog set active = true where code in (pre.*, arr.ack, sca.speed/drink/glass/round, bag.*, con.*);

-- Nov 2022: not a comparison any more. Kept, marked removed, with the reason.
update public.audit_visits set removed_at = now(), removed_by = 'fguarracino@robertos.ae',
  removed_reason = 'Nov 2022: different restaurant, different standard. Not compared (Francesco, 22 Oct 2026).'
where id = 'ff022ed3-4fe9-4eba-ae93-da7d4bf21d67' and removed_at is null;

select kinds, count(*) from public.audit_catalog where active group by kinds order by 1;
