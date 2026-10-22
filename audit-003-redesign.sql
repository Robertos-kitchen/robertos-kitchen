-- Audit redesign (22 Oct 2026, approved by Francesco "as written, timings and 85% target included").
-- Every guest question is either a STANDARD (Yes / No / didn't see; Yes = 5, No = 0 in audit_scores.score,
-- so the % stays score/5) or a QUALITY score 1-5 with what 5 / 3 / 1 look like. Enrico's 33 stay as they
-- are (venue only); Restaurant and Scala get their own guest-worded questions. Additive: nothing deleted.

alter table public.audit_catalog add column if not exists qtype text not null default 'quality';
alter table public.audit_catalog add column if not exists hint_en text;
alter table public.audit_catalog add column if not exists hint_it text;
alter table public.audit_catalog add column if not exists a5_en text;
alter table public.audit_catalog add column if not exists a3_en text;
alter table public.audit_catalog add column if not exists a1_en text;
alter table public.audit_catalog add column if not exists a5_it text;
alter table public.audit_catalog add column if not exists a3_it text;
alter table public.audit_catalog add column if not exists a1_it text;

-- Enrico's original 33 are his alone now.
update public.audit_catalog set kinds = '{venue}' where code in ('arr.door','arr.hostess','arr.desk','arr.walk','arr.first',
  'cuc.menu','cuc.product','cuc.technique','cuc.mep','cuc.clean','cuc.org','cuc.speed','cuc.consist','cuc.crockery',
  'ris.service','ris.knowledge','ris.light','ris.music','ris.table','ris.bread','ris.atmos',
  'vin.list','vin.glass','vin.service','vin.glassware',
  'sca.service','sca.knowledge','sca.light','sca.music','sca.table','sca.cocktail','sca.cigar','sca.atmos');

-- Booking (restaurant + scala): standards.
update public.audit_catalog set qtype='standard', kinds='{restaurant,scala}', label_en='The phone was answered within 3 rings', label_it='Al telefono hanno risposto entro 3 squilli',
  hint_en='Or 10 seconds. Booked online: a reply within 1 hour.', hint_it='O 10 secondi. Prenotato online: una risposta entro 1 ora.' where code='pre.answer';
update public.audit_catalog set qtype='standard', kinds='{restaurant,scala}', label_en='They gave their name and used yours', label_it='Si sono presentati e hanno usato il tuo nome',
  hint_en='Introduced themselves, took your name and used it at least once.', hint_it='Si sono presentati, hanno preso il tuo nome e lo hanno usato almeno una volta.' where code='pre.greet';
update public.audit_catalog set qtype='standard', kinds='{restaurant,scala}', label_en='The booking was repeated back to you', label_it='La prenotazione ti è stata ripetuta',
  hint_en='Date, time, number of guests and your phone number.', hint_it='Data, ora, numero di persone e il tuo telefono.' where code='pre.repeat';
update public.audit_catalog set qtype='standard', kinds='{restaurant,scala}', label_en='You were asked about the occasion and any allergies', label_it='Ti hanno chiesto dell''occasione e di eventuali allergie',
  hint_en='Both asked, without you bringing them up.', hint_it='Entrambe chieste, senza che fossi tu a dirlo.' where code='pre.occasion';
update public.audit_catalog set qtype='standard', kinds='{restaurant,scala}', label_en='A confirmation arrived with the right details', label_it='È arrivata una conferma con i dettagli giusti',
  hint_en='Message or email the same day; date, time and guests correct.', hint_it='Messaggio o email lo stesso giorno; data, ora e persone corrette.' where code='pre.confirm';
update public.audit_catalog set qtype='standard', kinds='{restaurant,scala}', label_en='Your table was ready at the time you booked', label_it='Il tavolo era pronto all''ora prenotata',
  hint_en='Seated within 5 minutes of arriving.', hint_it='Seduti entro 5 minuti dall''arrivo.' where code='pre.ready';

-- Washroom (all three kinds, Enrico's too) and Bill & goodbye.
update public.audit_catalog set qtype='standard', kinds='{venue,restaurant,scala}', label_en='Clean and dry, no smell', label_it='Pulito e asciutto, nessun odore',
  hint_en='Floor, basin and mirror clean; bins not full.', hint_it='Pavimento, lavabo e specchio puliti; cestini non pieni.' where code='bag.clean';
update public.audit_catalog set qtype='standard', kinds='{venue,restaurant,scala}', label_en='Fully stocked', label_it='Completo di tutto',
  hint_en='Soap, hand towels, tissue and hand lotion.', hint_it='Sapone, asciugamani, carta e crema mani.' where code='bag.stock';
update public.audit_catalog set qtype='quality', kinds='{venue,restaurant,scala}', label_en='It matched the restaurant', label_it='All''altezza del ristorante',
  a5_en='As elegant as the dining room', a3_en='Clean but plain or worn', a1_en='It let the evening down',
  a5_it='Elegante come la sala', a3_it='Pulito ma semplice o usurato', a1_it='Ha rovinato la serata' where code='bag.upkeep';
update public.audit_catalog set qtype='standard', kinds='{venue,restaurant}', label_en='The bill came within 5 minutes of asking', label_it='Il conto è arrivato entro 5 minuti dalla richiesta',
  hint_en=null, hint_it=null where code='con.bill';
update public.audit_catalog set qtype='standard', kinds='{venue,restaurant,scala}', label_en='The bill was correct', label_it='Il conto era corretto',
  hint_en='Nothing added; any service charge shown clearly.', hint_it='Niente di aggiunto; il servizio, se c''è, indicato chiaramente.' where code='con.correct';
update public.audit_catalog set qtype='standard', kinds='{venue,restaurant,scala}', label_en='Payment was handled at the table, discreetly', label_it='Pagamento al tavolo, con discrezione',
  hint_en='Bill in a folder, card machine brought to you.', hint_it='Conto in cartellina, POS portato al tavolo.' where code='con.discreet';
update public.audit_catalog set qtype='standard', kinds='{venue,restaurant,scala}', label_en='You were thanked and said goodbye at the door', label_it='Ringraziato e salutato alla porta',
  hint_en='By name where possible, and invited back.', hint_it='Per nome se possibile, e invitato a tornare.' where code='con.bye';

-- Scala's earlier extra questions, reworded.
update public.audit_catalog set qtype='standard', kinds='{scala}', position=3, label_en='Someone came to you within 1 minute of sitting', label_it='Qualcuno è venuto da te entro 1 minuto',
  hint_en='Took your order or told you they''d be right with you.', hint_it='Ha preso l''ordine o ti ha detto che arrivava subito.' where code='arr.ack';
update public.audit_catalog set qtype='standard', kinds='{scala}', position=2, label_en='Your order was taken within 3 minutes of sitting', label_it='L''ordine è stato preso entro 3 minuti',
  hint_en=null, hint_it=null where code='sca.speed';
update public.audit_catalog set qtype='quality', kinds='{scala}', position=5, label_en='The drinks', label_it='I drink',
  a5_en='Balanced, right temperature, fresh garnish, the second round as good as the first', a3_en='Fine but forgettable', a1_en='Watery, warm or wrong',
  a5_it='Equilibrati, alla giusta temperatura, guarnizione fresca, il secondo giro buono come il primo', a3_it='Buoni ma niente di speciale', a1_it='Annacquati, caldi o sbagliati' where code='sca.drink';
update public.audit_catalog set qtype='standard', kinds='{scala}', position=6, label_en='Glasses spotless, chilled where they should be', label_it='Bicchieri perfetti, freddi dove serve',
  hint_en='No marks or chips; martini and coupe glasses frosted.', hint_it='Niente aloni o scheggiature; coppe e martini ghiacciati.' where code='sca.glass';
update public.audit_catalog set qtype='standard', kinds='{scala}', position=7, label_en='The next round was offered before your glass was empty', label_it='Il giro successivo proposto prima che il bicchiere fosse vuoto',
  hint_en=null, hint_it=null where code='sca.round';

insert into public.audit_catalog (code, area, position, qtype, kinds, label_en, label_it, hint_en, hint_it, a5_en, a3_en, a1_en, a5_it, a3_it, a1_it, active) values
-- Arrival (restaurant; door and welcome also Scala)
 ('ra.door','arrivo',1,'standard','{restaurant,scala}','You were greeted at the door within 30 seconds','Accolto alla porta entro 30 secondi','Eye contact and a welcome, even when busy.','Uno sguardo e un benvenuto, anche se c''era gente.',null,null,null,null,null,null,true),
 ('ra.welcome','arrivo',2,'quality','{restaurant,scala}','The welcome at the host desk','L''accoglienza al desk',null,null,'A smile, your name, seated at once, you felt expected','Polite but routine','Ignored, or kept waiting without a word','Un sorriso, il tuo nome, accompagnato subito: eri atteso','Cortese ma di routine','Ignorato, o lasciato aspettare senza una parola',true),
 ('ra.desk','arrivo',3,'standard','{restaurant}','The host desk looked right','Il desk era in ordine','Fresh flowers, nothing personal, no paperwork or phones on show.','Fiori freschi, niente di personale, nessun foglio o telefono in vista.',null,null,null,null,null,null,true),
 ('ra.walk','arrivo',4,'standard','{restaurant}','You were walked to your table and told about Roberto''s','Accompagnato al tavolo, con due parole su Roberto''s','Walked, not pointed; a line or two about the restaurant on the way or at the table.','Accompagnato, non indicato; due parole sul ristorante strada facendo o al tavolo.',null,null,null,null,null,null,true),
 ('ra.first','arrivo',5,'standard','{restaurant}','Someone came to your table within 2 minutes','Qualcuno al tavolo entro 2 minuti','Water or a drink offered within 2 minutes of sitting.','Acqua o un drink offerti entro 2 minuti.',null,null,null,null,null,null,true),
-- At the table
 ('rt.service','ristorante',1,'quality','{restaurant}','Service through the evening','Il servizio durante la serata',null,null,'Attentive without hovering, plates and glasses handled before you ask, the team clearly works together','Correct, but you had to look for someone at least once','Forgotten, or had to ask again and again','Attento senza essere invadente, piatti e bicchieri gestiti prima di chiedere, la squadra lavora insieme','Corretto, ma almeno una volta hai dovuto cercare qualcuno','Dimenticato, o hai dovuto chiedere più volte',true),
 ('rt.knowledge','ristorante',2,'quality','{restaurant}','The team''s knowledge of the menu','La conoscenza del menu',null,null,'Explained dishes and where they come from with confidence, recommended with a reason','Answered, but read it off the menu','Couldn''t answer, or guessed','Hanno spiegato piatti e provenienza con sicurezza, consigliato con un perché','Hanno risposto leggendo il menu','Non sapevano rispondere, o hanno tirato a indovinare',true),
 ('rt.bread','ristorante',3,'standard','{restaurant}','Bread and olive oil were served and explained','Pane e olio serviti e spiegati','Within 10 minutes of sitting, with a word about the oil.','Entro 10 minuti, con una parola sull''olio.',null,null,null,null,null,null,true),
 ('rt.table','ristorante',4,'standard','{restaurant}','The table was set correctly','La mise en place era corretta','Clean surface, polished glasses and cutlery, centrepiece in place, nothing missing.','Tavolo pulito, bicchieri e posate lucidi, centrotavola al suo posto, non mancava nulla.',null,null,null,null,null,null,true),
 ('rt.pace','ristorante',5,'standard','{restaurant}','Courses were well paced','I tempi tra le portate erano giusti','No more than 20 minutes between a course cleared and the next served; nothing rushed.','Non più di 20 minuti tra una portata e l''altra; niente fretta.',null,null,null,null,null,null,true),
 ('rt.mood','ristorante',6,'quality','{restaurant}','Lighting and music','Luci e musica',null,null,'Dimmed for dinner, every candle lit, music heard but never over the conversation','Fine, but you noticed it: too bright, too loud, or candles out','It spoiled the evening','Luci basse per la cena, tutte le candele accese, musica che si sente ma non copre la conversazione','Bene, ma si notava: troppa luce, troppo volume, o candele spente','Ha rovinato la serata',true),
 ('rt.feel','ristorante',7,'quality','{restaurant}','It felt like Roberto''s','Si sentiva Roberto''s',null,null,'Elegant, lively and Italian; you would bring an important guest','Pleasant, but could be anywhere','Flat, empty or uncomfortable','Elegante, vivace e italiano: ci porteresti un ospite importante','Piacevole, ma potrebbe essere ovunque','Piatto, vuoto o scomodo',true),
-- Wine
 ('rw.advice','vino',1,'quality','{restaurant}','Wine advice','Il consiglio sul vino',null,null,'Asked what you like, offered two choices at different prices, explained the match','Took the order, little advice','No help, or pushed the most expensive','Ti hanno chiesto i tuoi gusti, proposto due scelte a prezzi diversi, spiegato l''abbinamento','Hanno preso l''ordine, pochi consigli','Nessun aiuto, o hanno spinto la bottiglia più cara',true),
 ('rw.serve','vino',2,'standard','{restaurant}','The bottle was served properly','La bottiglia servita come si deve','Shown to you, opened at the table, you tasted first, then poured.','Mostrata, aperta al tavolo, fatta assaggiare a te, poi versata.',null,null,null,null,null,null,true),
 ('rw.temp','vino',3,'standard','{restaurant}','The wine was at the right temperature','Il vino alla giusta temperatura','Whites and sparkling cold, reds cool, never warm.','Bianchi e bollicine freddi, rossi freschi, mai caldi.',null,null,null,null,null,null,true),
 ('rw.glass','vino',4,'standard','{restaurant}','The glasses were right and spotless','Bicchieri giusti e perfetti','A glass that suits the wine; no marks or chips.','Il bicchiere adatto al vino; niente aloni o scheggiature.',null,null,null,null,null,null,true),
-- The food
 ('rf.avail','cucina',1,'standard','{restaurant}','Everything you ordered was available','Tutto quello che hai ordinato era disponibile','Nothing "finished" or swapped without asking.','Niente "finito" o sostituito senza chiedere.',null,null,null,null,null,null,true),
 ('rf.quality','cucina',2,'quality','{restaurant}','Ingredients and quality','Ingredienti e qualità',null,null,'Clearly top produce, in season, clean flavours','Good but forgettable','Tired, frozen or poor','Materia prima chiaramente eccellente, di stagione, sapori netti','Buono ma niente di speciale','Stanco, surgelato o scadente',true),
 ('rf.temp','cucina',3,'standard','{restaurant}','Hot food hot, cold food cold','Caldo il caldo, freddo il freddo','Every plate at the right temperature.','Ogni piatto alla giusta temperatura.',null,null,null,null,null,null,true),
 ('rf.present','cucina',4,'quality','{restaurant}','Presentation','La presentazione',null,null,'Beautiful and precise, plate rims clean','Neat but plain','Messy, or a chipped plate','Bella e precisa, bordi del piatto puliti','Ordinata ma semplice','Disordinata, o un piatto scheggiato',true),
-- At Scala
 ('sc.list','scala',1,'standard','{scala}','The drinks list was offered as you sat down','La carta dei drink offerta appena seduti','Clean, not stained or worn.','Pulita, non macchiata o rovinata.',null,null,null,null,null,null,true),
 ('sc.firstdrink','scala',3,'standard','{scala}','Your first drinks arrived within 7 minutes of ordering','I primi drink arrivati entro 7 minuti',null,null,null,null,null,null,null,null,true),
 ('sc.advice','scala',4,'quality','{scala}','Cocktail advice','Il consiglio sui cocktail',null,null,'Asked what you like, suggested a signature and a bite to go with it','Took the order, no suggestions','No help, or got the order wrong','Ti hanno chiesto i tuoi gusti, proposto un signature e qualcosa da mangiare','Hanno preso l''ordine, nessun consiglio','Nessun aiuto, o ordine sbagliato',true),
 ('sc.table','scala',8,'standard','{scala}','The table was set for what you ordered, and kept clear','Tavolo apparecchiato per l''ordine e tenuto in ordine','Coasters, napkins, plates for bites; empties taken away.','Sottobicchieri, tovaglioli, piattini; il vuoto portato via.',null,null,null,null,null,null,true),
 ('sc.cigar','scala',9,'quality','{scala}','Cigar service (skip if you didn''t have one)','Il servizio sigari (salta se non l''hai preso)',null,null,'Humidor presented, guided by your taste, cut and lit for you','Chosen from a list only','None available, or no knowledge','Humidor presentato, consigliato sui tuoi gusti, tagliato e acceso per te','Scelto solo da una lista','Non disponibile, o nessuna conoscenza',true),
 ('sc.service','scala',10,'quality','{scala}','Service through the evening','Il servizio durante la serata',null,null,'Attentive without hovering, always someone in sight','Correct, but you had to wave once','Forgotten','Attento senza essere invadente, sempre qualcuno in vista','Corretto, ma una volta hai dovuto chiamare','Dimenticato',true),
 ('sc.mood','scala',11,'quality','{scala}','Lighting and music','Luci e musica',null,null,'Low and warm, music with energy that still lets you talk','Fine, but too bright or too loud at times','It spoiled the evening','Luci basse e calde, musica con energia che lascia parlare','Bene, ma a tratti troppa luce o troppo volume','Ha rovinato la serata',true),
 ('sc.atmos','scala',12,'quality','{scala}','The atmosphere and the bar','L''atmosfera e il bancone',null,null,'Buzzing and elegant, the bar spotless and fully stocked','Pleasant but quiet or cluttered','Empty or messy','Vivace ed elegante, bancone perfetto e ben fornito','Piacevole ma vuoto o in disordine','Vuoto o in disordine',true)
on conflict (code) do nothing;

select k, qtype, count(*) from public.audit_catalog, unnest(kinds) k where active group by k, qtype order by 1, 2;

-- Found by the end-to-end test (22 Oct 2026): a standard's No is saved as 0, and the old check allowed 1-5 only,
-- so every No was refused and retried. Answers may now be 0-5 (dishes stay 1-5).
alter table public.audit_scores drop constraint audit_scores_score_check;
alter table public.audit_scores add constraint audit_scores_score_check check (score >= 0 and score <= 5);
