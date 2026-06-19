// Get to Know Us — multilingual team survey + honest assessment (admin only sees scoring)
var TEAM_KEY = 'team';
var teamStaff = [];
var teamCurrent = null;
var teamAnswers = {};       // qid -> option key(s) for choices, raw text for text qs, number for scale
var teamSubmissions = [];
var teamMode = 'list';
var teamScrollY = 0;
var teamLang = 'en';        // current display language

// ── Survey round config (quarterly cycle) ──
// Update these each round. teamDeadline = when Danilo must have the team finished.
var TEAM_ROUND = {
  label: 'Round 1 · June 2026',
  deadline: '2026-06-20',     // team must complete by this date
  nextTest: '2026-09-30'      // next quarterly test
};

var TEAM_STATION_LABEL = {
  'management':'Management','pass':'Management','raw_bar':'Crudo','pasta':'Pasta',
  'main':'Main Course','pastry_pizza':'Pastry & Pizza','stewarding':'Stewarding','other':'Team'
};
var TEAM_SECTIONS = [
  { key:'management', label:'Management', stations:['management','pass'] },
  { key:'raw_bar',    label:'Crudo',          stations:['raw_bar'] },
  { key:'pasta',      label:'Pasta',          stations:['pasta'] },
  { key:'main',       label:'Main Course',    stations:['main'] },
  { key:'pastry_pizza', label:'Pastry & Pizza', stations:['pastry_pizza'] },
  { key:'stewarding', label:'Stewarding',     stations:['stewarding'] },
  { key:'other',      label:'Team',           stations:['other'] }
];
function teamSectionFor(stationKey){
  var k = stationKey || 'other';
  for (var i=0;i<TEAM_SECTIONS.length;i++){ if (TEAM_SECTIONS[i].stations.indexOf(k)!==-1) return TEAM_SECTIONS[i]; }
  return TEAM_SECTIONS[TEAM_SECTIONS.length-1];
}
// ── Question set: stable keys, multi-language. Scoring reads option KEYS, never display text. ──
// Each option: { k:'a', score:{dim:val} }. Display text lives in TEAM_I18N[lang].
var TEAM_QUESTIONS = [
  { id:'motivate', type:'multi', max:2,
    opts:[{k:'a'},{k:'b',score:{loy:1}},{k:'c',score:{flight:0.5}},{k:'d',score:{eng:0.5}},{k:'e',score:{eng:1}},{k:'f'}] },
  { id:'drains', type:'multi', max:2,
    opts:[{k:'a'},{k:'b',score:{concern:0.5}},{k:'c',score:{concern:1}},{k:'d',score:{concern:1,flight:0.5}},{k:'e',score:{concern:1}},{k:'f',score:{concern:0.5}}] },
  { id:'annoys', type:'single',
    opts:[{k:'a'},{k:'b',score:{int:1}},{k:'c',score:{loy:0.5}},{k:'d',score:{rel:0.5}}] },
  { id:'lead', type:'single',
    opts:[{k:'a'},{k:'b'},{k:'c'},{k:'d'}] },
  { id:'priority_change', type:'single',
    opts:[{k:'a',score:{rel:1}},{k:'b',score:{rel:0.5}},{k:'c',score:{rel:-0.3,concern:0.3}},{k:'d',score:{rel:-0.6,concern:0.5}}] },
  { id:'trust', type:'single',
    opts:[{k:'a',score:{int:1}},{k:'b',score:{int:0.4}},{k:'c',score:{int:-0.3}},{k:'d',score:{int:-1}}] },
  { id:'pressure', type:'scale', low:true, high:true, score:{ dim:'rel', map:{1:-1,2:-0.5,3:0,4:0.5,5:1} } },
  { id:'promise', type:'single',
    opts:[{k:'a',score:{rel:1}},{k:'b',score:{rel:0}},{k:'c',score:{rel:-0.5}},{k:'d',score:{rel:-1}}] },
  { id:'protect', type:'single',
    opts:[{k:'a',score:{loy:1}},{k:'b',score:{loy:0.2}},{k:'c',score:{loy:-1}},{k:'d',score:{loy:0}}] },
  { id:'autonomy', type:'single',
    opts:[{k:'a',score:{rel:0}},{k:'b',score:{rel:0.3}},{k:'c',score:{rel:0.6}},{k:'d',score:{rel:0.8}}] },
  { id:'team_mood', type:'single',
    opts:[{k:'a',score:{eng:1}},{k:'b',score:{eng:0.2}},{k:'c',score:{eng:-0.7,concern:0.7}},{k:'d',score:{eng:-1,flight:1,concern:0.5}}] },
  { id:'fairness', type:'single',
    opts:[{k:'a',score:{loy:0.5}},{k:'b'},{k:'c'},{k:'d',score:{concern:0.7,loy:-0.3}}] },
  { id:'next_year', type:'single',
    opts:[{k:'a',score:{loy:1,flight:-0.5}},{k:'b',score:{loy:0.5,eng:0.5}},{k:'c',score:{flight:1.5,loy:-0.5}},{k:'d',score:{flight:0.7}}] },
  { id:'stay', type:'multi', max:2,
    opts:[{k:'a',score:{loy:0.3}},{k:'b',score:{flight:0.3}},{k:'c',score:{loy:0.5}},{k:'d',score:{eng:0.5}},{k:'e',score:{eng:0.4}},{k:'f'}] },
  { id:'energy', type:'single',
    opts:[{k:'a',score:{eng:0.7}},{k:'b',score:{eng:0.3}},{k:'c',score:{eng:-0.7,concern:0.5}},{k:'d'}] },
  { id:'rules', type:'single',
    opts:[{k:'a',score:{int:1}},{k:'b',score:{int:0.4}},{k:'c',score:{int:-0.3}},{k:'d',score:{int:-1}}] },
  { id:'remember', type:'single',
    opts:[{k:'a',score:{rel:0.5}},{k:'b',score:{rel:0.8}},{k:'c',score:{rel:0.3}},{k:'d',score:{rel:-0.5}}] },
  { id:'change_one', type:'text' },
  { id:'anything', type:'text', optional:true }
];

// Cross-check pairs: when answers contradict, raise a soft flag AND soften the dimension.
var TEAM_CROSSCHECKS = [
  { id:'flight', a:'team_mood', b:'next_year',
    contradiction:function(ans){
      var settled = (ans.team_mood==='a');           // says team happy here
      var leaving = (ans.next_year==='c');            // but plans to go elsewhere
      return settled && leaving;
    },
    dim:'loyalty', note:'Says the team is happy here, but plans to leave — answers do not line up.' },
  { id:'integrity', a:'annoys', b:'trust',
    contradiction:function(ans){
      // Hates liars most (values honesty) BUT believes almost nobody can be trusted
      return ans.annoys==='b' && ans.trust==='d';
    },
    dim:'integrity', note:'Says they hate dishonesty most, yet trusts almost no one — worth a closer read.' }
];
// ── UI strings + all question text per language. Keys map to TEAM_QUESTIONS option keys. ──
var TEAM_LANGS = [
  { code:'en', label:'English' },
  { code:'hi', label:'हिन्दी (Hindi)' },
  { code:'ne', label:'नेपाली (Nepali)' },
  { code:'it', label:'Italiano' },
  { code:'tl', label:'Tagalog' }
];

var TEAM_I18N = {
  en: {
    ui:{ title:'Get to Know Us',
      intro:'Help me understand the team better. Pick your language, then your name, answer a few quick questions, and tap send. About 5 minutes. There are no wrong answers — just be honest.',
      pickLang:'Choose your language', notMe:'Not me', send:'Send', sending:'Sending…',
      answerAll:'Please answer the highlighted question', of:'of', answered:'answered',
      thanks:'Grazie', thanksMsg:'Your answers are saved. Thank you for being honest — it really helps.', done:'Done',
      passPrompt:'Enter your Employee ID to start', passPromptCode:'Enter your passcode to start',
      passWrong:'That does not match. Please check and try again.',
      confirmNoId:'We do not have an ID for you. Tap OK to confirm this is you and start.',
      scaleLow:'I find it very hard', scaleHigh:'I work even better' },
    q:{
      motivate:{ q:'What gives you energy at work? (pick up to 2)', o:{a:'People say I did well',b:'Being part of a team',c:'Money and a stable job',d:'Learning new things',e:'Doing the work to a high standard',f:'Freedom to do it my way'} },
      drains:{ q:'What makes your job hard or upsets you? (pick up to 2)', o:{a:'The plan changes too many times',b:'Too much work, not enough people',c:'Nobody listens to me',d:'People promise things but don\u2019t do them',e:'Someone shouts at me or is rude',f:'I don\u2019t know what I should do'} },
      annoys:{ q:'What do you not like when someone works with you?', o:{a:'They are lazy',b:'They lie or make excuses',c:'They say my work is theirs',d:'They waste food or things'} },
      lead:{ q:'How do you like your leader to work with you?', o:{a:'Tell me exactly what to do',b:'Tell me the goal, I find the way',c:'Check on me often',d:'Leave me alone unless I need help'} },
      priority_change:{ q:'The plan changes fast during your shift. How do you feel?', o:{a:'No problem, I change fast',b:'Not happy, but I do it',c:'I feel stressed, I need a minute',d:'It makes my day very hard'} },
      trust:{ q:'How many people can you really trust?', o:{a:'Almost everyone, most people are good',b:'Many people',c:'Only a few',d:'Almost nobody, people lie a lot'} },
      pressure:{ q:'When the kitchen is very busy and short of people, how do you work?' },
      promise:{ q:'Someone says they will do something, but they don\u2019t. Why?', o:{a:'Something real stopped them',b:'They forgot',c:'They did not really care',d:'Everyone does this, it is normal'} },
      protect:{ q:'When there is a problem at work, most people protect\u2026', o:{a:'The team',b:'Their close friends only',c:'Themselves first',d:'The leader'} },
      autonomy:{ q:'You need to decide something and the leader is not there. What do you do?', o:{a:'I wait and ask first',b:'I ask a senior near me',c:'I decide the small things myself',d:'I decide myself, I am sure'} },
      team_mood:{ q:'Most people in this kitchen feel\u2026', o:{a:'Happy to be here',b:'Okay, it is a job',c:'Tired and stressed',d:'Like they want to leave'} },
      fairness:{ q:'Two people do the same work. One gets praised more. The other should\u2026', o:{a:'Be happy for him',b:'Say nothing, keep working',c:'Feel it is not fair',d:'Work less next time'} },
      next_year:{ q:'Where do you see yourself in one year?', o:{a:'Here, growing in this team',b:'Here, but doing more',c:'In a new place',d:'I don\u2019t know yet'} },
      stay:{ q:'What makes you want to stay in a job? (pick 2)', o:{a:'People respect me',b:'Good money',c:'A team I trust',d:'Chance to learn and grow',e:'My work means something',f:'A calm place, no stress'} },
      energy:{ q:'At the end of a normal shift, how do you feel?', o:{a:'Still strong',b:'Tired but happy',c:'Very tired',d:'Some days good, some days tired'} },
      rules:{ q:'What do you think about rules at work?', o:{a:'Rules keep everyone safe and fair',b:'Rules are mostly good',c:'Some rules waste time',d:'Rules are made to be broken'} },
      remember:{ q:'You have many small things to remember in one day. What is true for you?', o:{a:'I remember everything',b:'I write things down so I never forget',c:'I remember only the important things',d:'Sometimes I forget small things'} },
      change_one:{ q:'If you could change ONE thing here to make your work better, what would it be?', ph:'Write freely, in any language you like.' },
      anything:{ q:'Anything else you want me to know? (optional)', ph:'Optional — leave blank if nothing. Any language is fine.' }
    }
  },
  it: {
    ui:{ title:'Conosciamoci Meglio',
      intro:'Aiutami a conoscere meglio il team. Scegli la lingua, poi il tuo nome, rispondi a poche domande veloci e premi invia. Circa 5 minuti. Non ci sono risposte sbagliate — sii sincero.',
      pickLang:'Scegli la tua lingua', notMe:'Non sono io', send:'Invia', sending:'Invio…',
      answerAll:'Rispondi alla domanda evidenziata', of:'di', answered:'risposte',
      thanks:'Grazie', thanksMsg:'Le tue risposte sono salvate. Grazie per la sincerità — aiuta davvero.', done:'Fatto',
      passPrompt:'Inserisci il tuo ID dipendente per iniziare', passPromptCode:'Inserisci il tuo codice per iniziare',
      passWrong:'Non corrisponde. Controlla e riprova.',
      confirmNoId:'Non abbiamo un ID per te. Tocca OK per confermare che sei tu e iniziare.',
      scaleLow:'Lo trovo molto difficile', scaleHigh:'Lavoro ancora meglio' },
    q:{
      motivate:{ q:'Cosa ti dà energia al lavoro? (scegli fino a 2)', o:{a:'Quando dicono che ho fatto bene',b:'Far parte di una squadra',c:'Soldi e un lavoro stabile',d:'Imparare cose nuove',e:'Fare il lavoro a un alto livello',f:'Libertà di farlo a modo mio'} },
      drains:{ q:'Cosa rende difficile il tuo lavoro o ti disturba? (scegli fino a 2)', o:{a:'Il piano cambia troppe volte',b:'Troppo lavoro, poche persone',c:'Nessuno mi ascolta',d:'Promettono ma non mantengono',e:'Qualcuno mi urla contro o è scortese',f:'Non so cosa devo fare'} },
      annoys:{ q:'Cosa non ti piace quando qualcuno lavora con te?', o:{a:'È pigro',b:'Mente o trova scuse',c:'Dice che il mio lavoro è suo',d:'Spreca cibo o cose'} },
      lead:{ q:'Come vuoi che il tuo responsabile lavori con te?', o:{a:'Dimmi esattamente cosa fare',b:'Dimmi l\u2019obiettivo, trovo io il modo',c:'Controllami spesso',d:'Lasciami in pace se non chiedo aiuto'} },
      priority_change:{ q:'Il piano cambia in fretta durante il turno. Come ti senti?', o:{a:'Nessun problema, cambio veloce',b:'Non contento, ma lo faccio',c:'Mi sento stressato, mi serve un minuto',d:'Mi rende la giornata molto dura'} },
      trust:{ q:'Di quante persone ti puoi davvero fidare?', o:{a:'Quasi tutti, la gente è buona',b:'Molte persone',c:'Solo poche',d:'Quasi nessuno, la gente mente molto'} },
      pressure:{ q:'Quando la cucina è molto piena e manca personale, come lavori?' },
      promise:{ q:'Qualcuno dice che farà una cosa, ma non la fa. Perché?', o:{a:'Qualcosa di vero glielo ha impedito',b:'Ha dimenticato',c:'Non gli importava davvero',d:'Lo fanno tutti, è normale'} },
      protect:{ q:'Quando c\u2019è un problema al lavoro, la maggior parte protegge\u2026', o:{a:'La squadra',b:'Solo i loro amici stretti',c:'Prima se stessi',d:'Il responsabile'} },
      autonomy:{ q:'Devi decidere qualcosa e il responsabile non c\u2019è. Cosa fai?', o:{a:'Aspetto e chiedo prima',b:'Chiedo a un senior vicino',c:'Decido io le piccole cose',d:'Decido io, sono sicuro'} },
      team_mood:{ q:'La maggior parte delle persone in questa cucina si sente\u2026', o:{a:'Felice di essere qui',b:'Va bene, è un lavoro',c:'Stanca e stressata',d:'Come se volesse andarsene'} },
      fairness:{ q:'Due persone fanno lo stesso lavoro. Una viene lodata di più. L\u2019altra dovrebbe\u2026', o:{a:'Essere felice per lui',b:'Non dire niente, continuare a lavorare',c:'Sentire che non è giusto',d:'Lavorare meno la prossima volta'} },
      next_year:{ q:'Dove ti vedi tra un anno?', o:{a:'Qui, a crescere in questa squadra',b:'Qui, ma facendo di più',c:'In un posto nuovo',d:'Non lo so ancora'} },
      stay:{ q:'Cosa ti fa voler restare in un lavoro? (scegli 2)', o:{a:'Le persone mi rispettano',b:'Buoni soldi',c:'Una squadra di cui mi fido',d:'Possibilità di imparare e crescere',e:'Il mio lavoro conta qualcosa',f:'Un posto tranquillo, senza stress'} },
      energy:{ q:'Alla fine di un turno normale, come ti senti?', o:{a:'Ancora forte',b:'Stanco ma contento',c:'Molto stanco',d:'Certi giorni bene, certi stanco'} },
      rules:{ q:'Cosa pensi delle regole al lavoro?', o:{a:'Le regole tengono tutti al sicuro e giusti',b:'Le regole sono per lo più buone',c:'Alcune regole fanno perdere tempo',d:'Le regole sono fatte per essere infrante'} },
      remember:{ q:'Hai molte piccole cose da ricordare in un giorno. Cosa è vero per te?', o:{a:'Ricordo tutto',b:'Scrivo le cose per non dimenticare mai',c:'Ricordo solo le cose importanti',d:'A volte dimentico le piccole cose'} },
      change_one:{ q:'Se potessi cambiare UNA cosa qui per migliorare il tuo lavoro, quale sarebbe?', ph:'Scrivi liberamente, nella lingua che preferisci.' },
      anything:{ q:'Qualcos\u2019altro che vuoi dirmi? (facoltativo)', ph:'Facoltativo — lascia vuoto se niente. Va bene qualsiasi lingua.' }
    }
  },
  hi: {
    ui:{ title:'हमें जानिए',
      intro:'टीम को बेहतर समझने में मेरी मदद करें। अपनी भाषा चुनें, फिर अपना नाम, कुछ छोटे सवालों के जवाब दें और भेजें दबाएँ। लगभग 5 मिनट। कोई गलत जवाब नहीं है — बस सच बताएँ।',
      pickLang:'अपनी भाषा चुनें', notMe:'मैं नहीं', send:'भेजें', sending:'भेज रहे हैं…',
      answerAll:'कृपया हाइलाइट किए गए सवाल का जवाब दें', of:'में से', answered:'उत्तर दिए',
      thanks:'धन्यवाद', thanksMsg:'आपके जवाब सेव हो गए हैं। सच बताने के लिए धन्यवाद — इससे बहुत मदद मिलती है।', done:'पूरा',
      passPrompt:'शुरू करने के लिए अपना कर्मचारी ID डालें', passPromptCode:'शुरू करने के लिए अपना पासकोड डालें',
      passWrong:'यह मेल नहीं खाता। कृपया जाँचें और फिर कोशिश करें।',
      confirmNoId:'हमारे पास आपका ID नहीं है। यह आप हैं इसकी पुष्टि के लिए OK दबाएँ और शुरू करें।',
      scaleLow:'मुझे यह बहुत मुश्किल लगता है', scaleHigh:'मैं और भी अच्छा काम करता हूँ' },
    q:{
      motivate:{ q:'काम में आपको ऊर्जा क्या देता है? (2 तक चुनें)', o:{a:'लोग कहें कि मैंने अच्छा किया',b:'टीम का हिस्सा होना',c:'पैसा और स्थिर नौकरी',d:'नई चीज़ें सीखना',e:'काम को ऊँचे स्तर पर करना',f:'अपने तरीके से करने की आज़ादी'} },
      drains:{ q:'आपका काम कठिन या परेशान क्या करता है? (2 तक चुनें)', o:{a:'योजना बहुत बार बदलती है',b:'बहुत काम, कम लोग',c:'कोई मेरी नहीं सुनता',d:'लोग वादा करते हैं पर नहीं करते',e:'कोई मुझ पर चिल्लाता या बदतमीज़ी करता है',f:'मुझे नहीं पता मुझे क्या करना है'} },
      annoys:{ q:'जब कोई आपके साथ काम करता है तो आपको क्या पसंद नहीं?', o:{a:'वह आलसी है',b:'वह झूठ बोलता या बहाने बनाता है',c:'वह कहता है मेरा काम उसका है',d:'वह खाना या चीज़ें बर्बाद करता है'} },
      lead:{ q:'आप चाहते हैं आपका लीडर आपके साथ कैसे काम करे?', o:{a:'मुझे ठीक-ठीक बताएँ क्या करना है',b:'लक्ष्य बताएँ, रास्ता मैं ढूँढ लूँगा',c:'मुझ पर बार-बार ध्यान दें',d:'जब तक मैं मदद न माँगूँ, मुझे छोड़ दें'} },
      priority_change:{ q:'शिफ्ट के दौरान योजना तेज़ी से बदलती है। आप कैसा महसूस करते हैं?', o:{a:'कोई बात नहीं, मैं जल्दी बदल लेता हूँ',b:'खुश नहीं, पर कर लेता हूँ',c:'मुझे तनाव होता है, एक मिनट चाहिए',d:'मेरा दिन बहुत मुश्किल हो जाता है'} },
      trust:{ q:'आप सच में कितने लोगों पर भरोसा कर सकते हैं?', o:{a:'लगभग सब पर, ज़्यादातर लोग अच्छे हैं',b:'कई लोगों पर',c:'सिर्फ़ कुछ पर',d:'लगभग किसी पर नहीं, लोग बहुत झूठ बोलते हैं'} },
      pressure:{ q:'जब रसोई बहुत व्यस्त हो और लोग कम हों, तो आप कैसे काम करते हैं?' },
      promise:{ q:'कोई कहता है कि वह कुछ करेगा, पर नहीं करता। क्यों?', o:{a:'कोई सच्ची वजह ने रोक दिया',b:'वह भूल गया',c:'उसे सच में परवाह नहीं थी',d:'सब ऐसा करते हैं, यह आम बात है'} },
      protect:{ q:'जब काम में समस्या होती है, तो ज़्यादातर लोग किसे बचाते हैं\u2026', o:{a:'टीम को',b:'सिर्फ़ अपने करीबी दोस्तों को',c:'पहले खुद को',d:'लीडर को'} },
      autonomy:{ q:'आपको कुछ तय करना है और लीडर वहाँ नहीं है। आप क्या करते हैं?', o:{a:'मैं रुकता हूँ और पहले पूछता हूँ',b:'पास के किसी सीनियर से पूछता हूँ',c:'छोटी बातें खुद तय करता हूँ',d:'मैं खुद तय करता हूँ, मुझे यकीन है'} },
      team_mood:{ q:'इस रसोई में ज़्यादातर लोग महसूस करते हैं\u2026', o:{a:'यहाँ होकर खुश',b:'ठीक है, नौकरी है',c:'थके और तनाव में',d:'जैसे वे जाना चाहते हैं'} },
      fairness:{ q:'दो लोग एक ही काम करते हैं। एक की ज़्यादा तारीफ़ होती है। दूसरे को\u2026', o:{a:'उसके लिए खुश होना चाहिए',b:'कुछ न कहे, काम करता रहे',c:'लगे कि यह ठीक नहीं',d:'अगली बार कम काम करे'} },
      next_year:{ q:'एक साल बाद आप खुद को कहाँ देखते हैं?', o:{a:'यहीं, इस टीम में आगे बढ़ते हुए',b:'यहीं, पर ज़्यादा करते हुए',c:'किसी नई जगह',d:'अभी पता नहीं'} },
      stay:{ q:'किस वजह से आप नौकरी में रुकना चाहते हैं? (2 चुनें)', o:{a:'लोग मेरी इज़्ज़त करते हैं',b:'अच्छा पैसा',c:'जिस टीम पर भरोसा है',d:'सीखने और बढ़ने का मौका',e:'मेरे काम का मतलब है',f:'शांत जगह, कोई तनाव नहीं'} },
      energy:{ q:'सामान्य शिफ्ट के अंत में आप कैसा महसूस करते हैं?', o:{a:'अब भी मज़बूत',b:'थका पर खुश',c:'बहुत थका',d:'कुछ दिन अच्छे, कुछ दिन थके'} },
      rules:{ q:'काम के नियमों के बारे में आप क्या सोचते हैं?', o:{a:'नियम सबको सुरक्षित और निष्पक्ष रखते हैं',b:'नियम ज़्यादातर अच्छे हैं',c:'कुछ नियम समय बर्बाद करते हैं',d:'नियम तोड़ने के लिए बने हैं'} },
      remember:{ q:'एक दिन में आपको कई छोटी बातें याद रखनी होती हैं। आपके लिए क्या सच है?', o:{a:'मुझे सब याद रहता है',b:'मैं लिख लेता हूँ ताकि कभी न भूलूँ',c:'सिर्फ़ ज़रूरी बातें याद रखता हूँ',d:'कभी-कभी छोटी बातें भूल जाता हूँ'} },
      change_one:{ q:'अगर आप यहाँ एक चीज़ बदल सकें जिससे आपका काम बेहतर हो, तो वह क्या होगी?', ph:'खुलकर लिखें, जिस भाषा में चाहें।' },
      anything:{ q:'कुछ और जो आप मुझे बताना चाहते हैं? (वैकल्पिक)', ph:'वैकल्पिक — कुछ नहीं तो खाली छोड़ें। कोई भी भाषा ठीक है।' }
    }
  },
  ne: {
    ui:{ title:'हामीलाई चिन्नुहोस्',
      intro:'टोलीलाई राम्ररी बुझ्न मलाई मद्दत गर्नुहोस्। आफ्नो भाषा छान्नुहोस्, त्यसपछि आफ्नो नाम, केही छोटा प्रश्नको जवाफ दिनुहोस् र पठाउनुहोस् थिच्नुहोस्। लगभग ५ मिनेट। कुनै गलत जवाफ छैन — साँचो भन्नुहोस्।',
      pickLang:'आफ्नो भाषा छान्नुहोस्', notMe:'म होइन', send:'पठाउनुहोस्', sending:'पठाउँदै…',
      answerAll:'कृपया हाइलाइट गरिएको प्रश्नको जवाफ दिनुहोस्', of:'मध्ये', answered:'जवाफ दिइयो',
      thanks:'धन्यवाद', thanksMsg:'तपाईंका जवाफ सुरक्षित भए। साँचो भनिदिनुभएकोमा धन्यवाद — यसले धेरै मद्दत गर्छ।', done:'भयो',
      passPrompt:'सुरु गर्न आफ्नो कर्मचारी ID हाल्नुहोस्', passPromptCode:'सुरु गर्न आफ्नो पासकोड हाल्नुहोस्',
      passWrong:'यो मिलेन। कृपया जाँच गरेर फेरि प्रयास गर्नुहोस्।',
      confirmNoId:'हामीसँग तपाईंको ID छैन। यो तपाईं नै हो भनी पुष्टि गर्न OK थिच्नुहोस् र सुरु गर्नुहोस्।',
      scaleLow:'मलाई धेरै गाह्रो लाग्छ', scaleHigh:'म झन् राम्रो काम गर्छु' },
    q:{
      motivate:{ q:'काममा तपाईंलाई ऊर्जा के दिन्छ? (२ सम्म छान्नुहोस्)', o:{a:'मैले राम्रो गरें भनेर मानिसहरूले भन्दा',b:'टोलीको हिस्सा हुनु',c:'पैसा र स्थिर जागिर',d:'नयाँ कुरा सिक्नु',e:'काम उच्च स्तरमा गर्नु',f:'आफ्नै तरिकाले गर्ने स्वतन्त्रता'} },
      drains:{ q:'तपाईंको काम कठिन वा दिक्क के बनाउँछ? (२ सम्म छान्नुहोस्)', o:{a:'योजना धेरै पटक बदलिन्छ',b:'धेरै काम, थोरै मानिस',c:'कसैले मेरो कुरा सुन्दैन',d:'मानिसहरू वाचा गर्छन् तर गर्दैनन्',e:'कसैले मलाई कराउँछ वा रुखो गर्छ',f:'मलाई के गर्नुपर्छ थाहा छैन'} },
      annoys:{ q:'कसैले तपाईंसँग काम गर्दा के मन पर्दैन?', o:{a:'ऊ अल्छी छ',b:'ऊ झूट बोल्छ वा बहाना बनाउँछ',c:'ऊ मेरो काम आफ्नो हो भन्छ',d:'ऊ खाना वा सामान खेर फाल्छ'} },
      lead:{ q:'तपाईंको लिडरले तपाईंसँग कसरी काम गरेको चाहनुहुन्छ?', o:{a:'मलाई ठ्याक्कै के गर्ने भन्नुहोस्',b:'लक्ष्य भन्नुहोस्, बाटो म खोज्छु',c:'मलाई बारम्बार हेर्नुहोस्',d:'मैले मद्दत नमागेसम्म मलाई छाड्नुहोस्'} },
      priority_change:{ q:'शिफ्टमा योजना छिटो बदलिन्छ। तपाईंलाई कस्तो लाग्छ?', o:{a:'समस्या छैन, म छिटो बदल्छु',b:'खुसी छैन, तर गर्छु',c:'मलाई तनाव हुन्छ, एक मिनेट चाहिन्छ',d:'मेरो दिन धेरै गाह्रो हुन्छ'} },
      trust:{ q:'तपाईं साँच्चै कति मानिसलाई विश्वास गर्न सक्नुहुन्छ?', o:{a:'लगभग सबैलाई, धेरैजसो मानिस राम्रा छन्',b:'धेरै मानिसलाई',c:'केहीलाई मात्र',d:'लगभग कसैलाई पनि होइन, मानिस धेरै झूट बोल्छन्'} },
      pressure:{ q:'भान्सा धेरै व्यस्त र मानिस कम हुँदा तपाईं कसरी काम गर्नुहुन्छ?' },
      promise:{ q:'कसैले केही गर्छु भन्छ, तर गर्दैन। किन?', o:{a:'साँचो कारणले रोक्यो',b:'उसले बिर्सियो',c:'उसलाई साँच्चै वास्ता थिएन',d:'सबैले यसो गर्छन्, यो सामान्य हो'} },
      protect:{ q:'काममा समस्या हुँदा, धेरैजसो मानिस कसलाई जोगाउँछन्\u2026', o:{a:'टोलीलाई',b:'आफ्ना नजिकका साथीलाई मात्र',c:'पहिले आफूलाई',d:'लिडरलाई'} },
      autonomy:{ q:'तपाईंले केही निर्णय गर्नुपर्छ र लिडर त्यहाँ छैन। तपाईं के गर्नुहुन्छ?', o:{a:'म पर्खन्छु र पहिले सोध्छु',b:'नजिकको सिनियरलाई सोध्छु',c:'साना कुरा आफैं निर्णय गर्छु',d:'म आफैं निर्णय गर्छु, मलाई यकिन छ'} },
      team_mood:{ q:'यो भान्सामा धेरैजसो मानिस महसुस गर्छन्\u2026', o:{a:'यहाँ भएर खुसी',b:'ठीक छ, जागिर हो',c:'थकित र तनावमा',d:'जान चाहेजस्तो'} },
      fairness:{ q:'दुई जना उही काम गर्छन्। एक जनाको बढी प्रशंसा हुन्छ। अर्कोले\u2026', o:{a:'उसको लागि खुसी हुनुपर्छ',b:'केही नभनी काम गरिरहनुपर्छ',c:'यो ठीक छैन भन्ने महसुस गर्नुपर्छ',d:'अर्को पटक कम काम गर्नुपर्छ'} },
      next_year:{ q:'एक वर्षपछि तपाईं आफूलाई कहाँ देख्नुहुन्छ?', o:{a:'यहीं, यो टोलीमा बढ्दै',b:'यहीं, तर बढी गर्दै',c:'नयाँ ठाउँमा',d:'अहिले थाहा छैन'} },
      stay:{ q:'कुन कुराले तपाईंलाई जागिरमा रहन मन लगाउँछ? (२ छान्नुहोस्)', o:{a:'मानिसहरूले मलाई सम्मान गर्छन्',b:'राम्रो पैसा',c:'विश्वास गर्ने टोली',d:'सिक्ने र बढ्ने मौका',e:'मेरो कामको अर्थ छ',f:'शान्त ठाउँ, तनाव छैन'} },
      energy:{ q:'सामान्य शिफ्टको अन्त्यमा तपाईंलाई कस्तो लाग्छ?', o:{a:'अझै बलियो',b:'थकित तर खुसी',c:'धेरै थकित',d:'कुनै दिन राम्रो, कुनै दिन थकित'} },
      rules:{ q:'काममा नियमबारे तपाईं के सोच्नुहुन्छ?', o:{a:'नियमले सबैलाई सुरक्षित र निष्पक्ष राख्छ',b:'नियम धेरैजसो राम्रा छन्',c:'केही नियमले समय खेर फाल्छ',d:'नियम तोड्नकै लागि बनेका हुन्'} },
      remember:{ q:'एक दिनमा तपाईंले धेरै साना कुरा सम्झनुपर्छ। तपाईंको लागि के सही हो?', o:{a:'मलाई सबै सम्झना हुन्छ',b:'म लेख्छु ताकि कहिल्यै नबिर्सूँ',c:'महत्त्वपूर्ण कुरा मात्र सम्झन्छु',d:'कहिलेकाहीं साना कुरा बिर्सन्छु'} },
      change_one:{ q:'तपाईंले यहाँ एउटा कुरा बदल्न सक्नुभयो भने जसले तपाईंको काम राम्रो बनाओस्, त्यो के हुन्थ्यो?', ph:'खुलेर लेख्नुहोस्, जुन भाषामा मन लाग्छ।' },
      anything:{ q:'अरू केही जो तपाईं मलाई भन्न चाहनुहुन्छ? (वैकल्पिक)', ph:'वैकल्पिक — केही छैन भने खाली छाड्नुहोस्। जुनसुकै भाषा ठीक छ।' }
    }
  },
  tl: {
    ui:{ title:'Kilalanin Mo Kami',
      intro:'Tulungan mo akong mas makilala ang team. Piliin ang iyong wika, tapos ang pangalan mo, sagutin ang ilang mabilis na tanong, at pindutin ang send. Mga 5 minuto. Walang maling sagot — maging tapat lang.',
      pickLang:'Piliin ang iyong wika', notMe:'Hindi ako', send:'Ipadala', sending:'Ipinapadala…',
      answerAll:'Pakisagot ang naka-highlight na tanong', of:'sa', answered:'nasagot',
      thanks:'Salamat', thanksMsg:'Naka-save na ang iyong mga sagot. Salamat sa pagiging tapat — malaking tulong ito.', done:'Tapos',
      passPrompt:'Ilagay ang iyong Employee ID para magsimula', passPromptCode:'Ilagay ang iyong passcode para magsimula',
      passWrong:'Hindi tugma. Pakisuri at subukan ulit.',
      confirmNoId:'Wala kaming ID mo. Pindutin ang OK para kumpirmahing ikaw ito at magsimula.',
      scaleLow:'Mahirap ito para sa akin', scaleHigh:'Mas mahusay akong magtrabaho' },
    q:{
      motivate:{ q:'Ano ang nagbibigay sa iyo ng lakas sa trabaho? (pumili hanggang 2)', o:{a:'Sinasabi nilang magaling ako',b:'Pagiging bahagi ng team',c:'Pera at matatag na trabaho',d:'Matuto ng bagong bagay',e:'Gawin ang trabaho nang maayos',f:'Kalayaang gawin ito sa sarili kong paraan'} },
      drains:{ q:'Ano ang nagpapahirap o nakakainis sa trabaho mo? (pumili hanggang 2)', o:{a:'Madalas magbago ang plano',b:'Sobrang dami ng trabaho, kulang sa tao',c:'Walang nakikinig sa akin',d:'Nangangako pero hindi tinutupad',e:'May sumisigaw o bastos sa akin',f:'Hindi ko alam ang dapat kong gawin'} },
      annoys:{ q:'Ano ang ayaw mo kapag may katrabaho ka?', o:{a:'Tamad siya',b:'Nagsisinungaling o nagdadahilan',c:'Inaangkin niya ang trabaho ko',d:'Nag-aaksaya ng pagkain o gamit'} },
      lead:{ q:'Paano mo gusto makipagtrabaho ang iyong lider sa iyo?', o:{a:'Sabihin mo nang eksakto ang gagawin',b:'Sabihin ang layunin, ako na ang bahala sa paraan',c:'Madalas akong tingnan',d:'Hayaan mo ako maliban kung humingi ng tulong'} },
      priority_change:{ q:'Mabilis na nagbago ang plano habang shift mo. Ano ang nararamdaman mo?', o:{a:'Walang problema, mabilis akong nakakaangkop',b:'Hindi masaya, pero ginagawa ko',c:'Na-stress ako, kailangan ko ng sandali',d:'Pinapahirap nito ang araw ko'} },
      trust:{ q:'Ilang tao ba talaga ang mapagkakatiwalaan mo?', o:{a:'Halos lahat, mabuti ang karamihan',b:'Maraming tao',c:'Iilan lang',d:'Halos wala, madalas magsinungaling ang tao'} },
      pressure:{ q:'Kapag sobrang busy ang kusina at kulang sa tao, paano ka magtrabaho?' },
      promise:{ q:'May nagsabing gagawin niya ang isang bagay, pero hindi. Bakit?', o:{a:'May totoong dahilan na pumigil',b:'Nakalimutan niya',c:'Wala talaga siyang pakialam',d:'Ginagawa ito ng lahat, normal lang'} },
      protect:{ q:'Kapag may problema sa trabaho, kadalasan ang pinoprotektahan ng tao ay\u2026', o:{a:'Ang team',b:'Ang malalapit na kaibigan lang',c:'Ang sarili muna',d:'Ang lider'} },
      autonomy:{ q:'May kailangan kang ipasya at wala ang lider. Ano ang gagawin mo?', o:{a:'Maghihintay ako at magtatanong muna',b:'Magtatanong sa senior na malapit',c:'Ako na ang magpapasya sa maliliit',d:'Ako na ang magpapasya, sigurado ako'} },
      team_mood:{ q:'Karamihan sa kusinang ito ay nararamdaman\u2026', o:{a:'Masaya na nandito',b:'Okay lang, trabaho naman',c:'Pagod at na-stress',d:'Parang gustong umalis'} },
      fairness:{ q:'Dalawang tao ang gumagawa ng parehong trabaho. Mas pinupuri ang isa. Ang isa ay dapat\u2026', o:{a:'Matuwa para sa kanya',b:'Manahimik, magtrabaho lang',c:'Maramdamang hindi patas',d:'Magtrabaho nang mas kaunti sa susunod'} },
      next_year:{ q:'Saan mo nakikita ang sarili mo sa loob ng isang taon?', o:{a:'Dito, lumalago sa team na ito',b:'Dito, pero mas marami nang ginagawa',c:'Sa bagong lugar',d:'Hindi ko pa alam'} },
      stay:{ q:'Ano ang nagpapagusto sa iyong manatili sa trabaho? (pumili ng 2)', o:{a:'Iginagalang ako ng tao',b:'Magandang sahod',c:'Team na pinagkakatiwalaan ko',d:'Pagkakataong matuto at lumago',e:'May kahulugan ang trabaho ko',f:'Tahimik na lugar, walang stress'} },
      energy:{ q:'Sa dulo ng normal na shift, ano ang pakiramdam mo?', o:{a:'Malakas pa rin',b:'Pagod pero masaya',c:'Sobrang pagod',d:'May araw na okay, may araw na pagod'} },
      rules:{ q:'Ano ang iniisip mo tungkol sa mga patakaran sa trabaho?', o:{a:'Pinapanatili ng patakaran na ligtas at patas ang lahat',b:'Karamihan ng patakaran ay maganda',c:'May patakarang sayang sa oras',d:'Ang patakaran ay para labagin'} },
      remember:{ q:'Maraming maliliit na bagay na dapat mong tandaan sa isang araw. Ano ang totoo sa iyo?', o:{a:'Natatandaan ko lahat',b:'Isinusulat ko para hindi makalimutan',c:'Natatandaan ko lang ang mahahalaga',d:'Minsan nakakalimutan ko ang maliliit'} },
      change_one:{ q:'Kung may ISANG bagay kang mababago dito para gumanda ang trabaho mo, ano iyon?', ph:'Magsulat nang malaya, kahit anong wika.' },
      anything:{ q:'May iba ka pa bang gustong sabihin sa akin? (opsyonal)', ph:'Opsyonal — iwan na blangko kung wala. Kahit anong wika ay okay.' }
    }
  },

};

// i18n helpers
function T(){ return (TEAM_I18N[teamLang]||TEAM_I18N.en); }
function Tui(k){ var t=T().ui; return (t&&t[k]!=null)?t[k]:(TEAM_I18N.en.ui[k]||k); }
function Tq(qid){ var t=T().q[qid]; return t||TEAM_I18N.en.q[qid]; }
function Topt(qid,key){ var t=Tq(qid); return (t&&t.o&&t.o[key]!=null)?t.o[key]:(TEAM_I18N.en.q[qid].o[key]||key); }

async function openTeam() {
  activeStation = TEAM_KEY;
  hideAllPages();
  var el = document.getElementById('team-view');
  el.style.display = 'block';
  document.querySelector('.footer-bar').style.display = 'flex';
  document.getElementById('foot-label').textContent = 'Get to Know Us';
  teamMode = 'list'; teamCurrent = null; teamAnswers = {};
  await teamLoadStaff();
  await teamLoadCompletion();
  teamRender();
}

// Lightweight: which staff have submitted this round (names only)
var teamDoneNames = {};
var teamCompletionLoaded = false;
async function teamLoadCompletion(){
  try {
    var res = await sb.from('team_survey').select('staff_id,staff_name,submitted_at');
    teamDoneNames = {};
    (res.data||[]).forEach(function(r){ teamDoneNames[r.staff_id||r.staff_name]=true; });
    teamCompletionLoaded = true;
  } catch(e){ teamCompletionLoaded = false; }
}
function teamCompletionPct(){
  var total = teamStaff.length || 0;
  if(!total) return { pct:0, done:0, total:0 };
  var done = teamStaff.filter(function(s){ return teamDoneNames[s.id]||teamDoneNames[s.name]; }).length;
  return { pct: Math.round(done/total*100), done:done, total:total };
}
function teamFmtDate(iso){
  try { var d=new Date(iso+'T00:00:00'); return d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}); }
  catch(e){ return iso; }
}

async function teamLoadStaff() {
  try {
    var res = await sb.from('staff').select('*').eq('active', true).order('sort_order');
    teamStaff = res.data || [];
  } catch (e) { teamStaff = []; }
  var hasF = teamStaff.some(function(s){ return (s.name||'').toLowerCase().indexOf('francesco') !== -1; });
  if (!hasF) {
    teamStaff.unshift({ id:'francesco-mgmt', name:'Francesco Guarracino', designation:'Management', station_key:'management', _virtual:true });
  }
}

function teamRender() {
  var el = document.getElementById('team-view');
  if (teamMode === 'list')   { el.innerHTML = teamListHTML(); return; }
  if (teamMode === 'survey') { el.innerHTML = teamSurveyHTML(); teamUpdateProgress(); return; }
  if (teamMode === 'thanks') { el.innerHTML = teamThanksHTML(); return; }
  if (teamMode === 'admin')  { el.innerHTML = teamAdminHTML(); setTimeout(function(){ teamAiRenderChat(false); var t=document.getElementById('ai-names-toggle'); if(t&&teamAiIncludeNames){t.classList.add('on');t.textContent='Names: ON';} }, 0); return; }
  if (teamMode === 'chairman'){ el.innerHTML = teamChairmanHTML(); return; }
}

function teamSetLang(code){ teamLang = code; teamRender(); }

function teamListHTML() {
  var byStation = {};
  var order = ['management','pass','raw_bar','pasta','main','pastry_pizza','stewarding','other'];
  teamStaff.forEach(function(s) { var k=s.station_key||'other'; if(!byStation[k])byStation[k]=[]; byStation[k].push(s); });
  var html = '<div class="team-wrap"><div class="team-head">';
  html += '<div class="team-title">'+Tui('title')+'<span class="team-corner" id="team-corner" onclick="teamCornerTap()"></span></div>';
  html += '<div class="team-sub">'+Tui('intro')+'</div></div>';
  // deadline banner — nudges Danilo/Antonio as the deadline approaches (shows when app is opened)
  if (teamCompletionLoaded) {
    var ccb = teamCompletionPct();
    var pendingB = ccb.total - ccb.done;
    var dlB = new Date(TEAM_ROUND.deadline+'T23:59:59');
    var nowB = new Date();
    var daysLeftB = Math.ceil((dlB - nowB) / 86400000);
    if (pendingB > 0 && daysLeftB <= 3) {
      var clsB, msgB;
      if (daysLeftB < 0) { clsB='overdue'; msgB='OVERDUE — '+pendingB+' still not done. Deadline was '+teamFmtDate(TEAM_ROUND.deadline)+'.'; }
      else if (daysLeftB === 0) { clsB='today'; msgB='DEADLINE TODAY — '+pendingB+' still need to finish the survey.'; }
      else { clsB='soon'; msgB=daysLeftB+' day'+(daysLeftB===1?'':'s')+' left — '+pendingB+' still to complete by '+teamFmtDate(TEAM_ROUND.deadline)+'.'; }
      html += '<div class="team-deadline '+clsB+'">⏰ '+msgB+'</div>';
    }
  }
  // completion strip — visible to everyone so the team sees progress; drives Danilo's task
  if (teamCompletionLoaded) {
    var c = teamCompletionPct();
    html += '<div class="team-progress-strip"><div class="tps-top"><span class="tps-pct">'+c.pct+'%</span><span class="tps-count">'+c.done+' / '+c.total+' done</span></div>';
    html += '<div class="tps-bar"><span class="tps-fill" style="width:'+c.pct+'%"></span></div>';
    html += '<div class="tps-dates"><span>Finish by '+teamFmtDate(TEAM_ROUND.deadline)+'</span><span>Next test '+teamFmtDate(TEAM_ROUND.nextTest)+'</span></div></div>';
  }
  // language picker
  html += '<div class="team-langbar"><div class="team-langlbl">'+Tui('pickLang')+'</div><div class="team-langs">';
  TEAM_LANGS.forEach(function(l){
    html += '<button class="team-lang'+(l.code===teamLang?' active':'')+'" onclick="teamSetLang(\''+l.code+'\')">'+l.label+'</button>';
  });
  html += '</div></div>';
  if (!teamStaff.length) { html += '<div class="team-empty">No team members loaded.</div>'; }
  else {
    function renderStation(k){
      if (!byStation[k]) return '';
      var h = '<div class="team-station">' + (TEAM_STATION_LABEL[k]||k) + '</div><div class="team-names">';
      byStation[k].forEach(function(s){
        var isDone = teamDoneNames[s.id]||teamDoneNames[s.name];
        h += '<button class="team-name-btn'+(isDone?' is-done':'')+'" onclick="teamStart(\'' + s.id + '\')"><span class="tn-name">' + (s.name||'') + (isDone?' <span class="tn-check">\u2713</span>':'') + '</span><span class="tn-role">' + (s.designation||'') + '</span></button>';
      });
      return h + '</div>';
    }
    order.forEach(function(k){ html += renderStation(k); });
    Object.keys(byStation).forEach(function(k){ if (order.indexOf(k)===-1) html += renderStation(k); });
  }
  html += '<div class="team-admin-link"><button onclick="teamAdminGate()">Admin view</button></div>';
  html += '</div>';
  return html;
}

// Passcode-gated admin entry (button visible, but team can't get in)
var teamAdminAnon = false;   // true = anonymous mode (no names shown)
function teamAdminGate(){
  var code = prompt('Admin passcode:');
  if (code === null) return;
  var c = String(code).trim();
  if (c === '1212') { teamAdminAnon = true; teamAiIncludeNames = false; teamOpenAdmin(); }
  else if (c === '121212') { teamAdminAnon = false; teamOpenAdmin(); }
  else { alert('Incorrect passcode.'); return; }
}

function teamStart(staffId) {
  var person = teamStaff.find(function(s){ return s.id === staffId; });
  if (!person) return;
  // One per cycle: if this person already submitted this round, do not let them in again.
  var alreadyDone = teamDoneNames[person.id] || teamDoneNames[person.name];
  if (alreadyDone) {
    alert(person.name.split(' ')[0] + ', you have already completed this survey. Thank you — one per person each time. The next test is ' + teamFmtDate(TEAM_ROUND.nextTest) + '.');
    return;
  }
  var OVERRIDES = [ { match:'andrea', code:'100084' }, { match:'francesco', code:'1212' } ];
  var override = null;
  var lname = (person.name || '').toLowerCase();
  for (var oi=0; oi<OVERRIDES.length; oi++){ if (lname.indexOf(OVERRIDES[oi].match) !== -1){ override = OVERRIDES[oi]; break; } }
  var fn = person.name.split(' ')[0];
  if (override) {
    var oc = prompt(Tui('passPromptCode') + ', ' + fn + ':');
    if (oc === null) return;
    if (String(oc).trim() !== override.code) { alert(Tui('passWrong')); return; }
  } else if (person.emp_id) {
    var code = prompt(Tui('passPrompt') + ', ' + fn + ':');
    if (code === null) return;
    if (String(code).trim() !== String(person.emp_id).trim()) { alert(Tui('passWrong')); return; }
  } else {
    var ok = confirm(Tui('confirmNoId'));
    if (!ok) return;
  }
  teamCurrent = person;
  teamAnswers = {}; teamMode = 'survey'; teamScrollY = 0;
  teamRender();
  var v = document.getElementById('team-view'); if (v) v.scrollTop = 0;
}

function teamSurveyHTML() {
  var html = '<div class="team-wrap"><div class="team-head">';
  html += '<button class="team-back" onclick="teamBackToList()">&#8592; '+Tui('notMe')+'</button>';
  html += '<div class="team-title">' + (teamCurrent?teamCurrent.name:'') + '</div>';
  html += '<div class="team-sub">' + (teamCurrent?(teamCurrent.designation||''):'') + '</div></div>';
  TEAM_QUESTIONS.forEach(function(qq, idx) {
    var qt = Tq(qq.id);
    html += '<div class="team-q" id="tq-' + qq.id + '"><div class="team-q-num">' + (idx+1) + ' / ' + TEAM_QUESTIONS.length + '</div>';
    html += '<div class="team-q-text">' + qt.q + '</div>';
    if (qq.type==='single' || qq.type==='multi') {
      html += '<div class="team-opts">';
      qq.opts.forEach(function(opt){
        var sel = teamIsSelected(qq,opt.k) ? ' selected' : '';
        html += '<button class="team-opt' + sel + '" onclick="teamPick(\'' + qq.id + '\',\'' + opt.k + '\',\'' + qq.type + '\',' + (qq.max||1) + ')">' + Topt(qq.id,opt.k) + '</button>';
      });
      html += '</div>';
    } else if (qq.type==='scale') {
      html += '<div class="team-scale"><span class="team-scale-lbl">' + Tui('scaleLow') + '</span>';
      for (var n=1;n<=5;n++){ var ssel=(teamAnswers[qq.id]===n)?' selected':''; html += '<button class="team-scale-btn' + ssel + '" onclick="teamScale(\'' + qq.id + '\',' + n + ')">' + n + '</button>'; }
      html += '<span class="team-scale-lbl">' + Tui('scaleHigh') + '</span></div>';
    } else if (qq.type==='text') {
      html += '<textarea class="team-text" id="tt-' + qq.id + '" placeholder="' + (qt.ph||'') + '" oninput="teamTextInput(\'' + qq.id + '\', this.value)">' + (teamAnswers[qq.id]||'') + '</textarea>';
    }
    html += '</div>';
  });
  html += '<div class="team-submit-wrap"><div class="team-progress" id="team-progress"></div>';
  html += '<button class="team-submit" id="team-submit-btn" onclick="teamSubmit()">'+Tui('send')+'</button></div></div>';
  return html;
}

function teamIsSelected(qq,key){ var v=teamAnswers[qq.id]; if(qq.type==='multi')return Array.isArray(v)&&v.indexOf(key)!==-1; return v===key; }
function teamPick(qid,key,type,max){
  if(type==='single'){ teamAnswers[qid]=key; }
  else { var arr=Array.isArray(teamAnswers[qid])?teamAnswers[qid]:[]; var i=arr.indexOf(key); if(i!==-1)arr.splice(i,1); else{ if(arr.length>=max)arr.shift(); arr.push(key);} teamAnswers[qid]=arr; }
  teamRender(); teamRestoreScroll();
}
function teamScale(qid,n){ teamAnswers[qid]=n; teamRender(); teamRestoreScroll(); }
function teamTextInput(qid,val){ teamAnswers[qid]=val; teamUpdateProgress(); }
function teamRestoreScroll(){ var v=document.getElementById('team-view'); if(v)v.scrollTop=teamScrollY; teamUpdateProgress(); }
function teamUpdateProgress(){
  var required = TEAM_QUESTIONS.filter(function(q){return !q.optional;});
  var done = required.filter(function(q){ var v=teamAnswers[q.id]; if(Array.isArray(v))return v.length>0; if(q.type==='text')return v&&v.trim().length>0; return v!==undefined&&v!==null&&v!==''; }).length;
  var p=document.getElementById('team-progress'); if(p)p.textContent=done+' '+Tui('of')+' '+required.length+' '+Tui('answered');
  var btn=document.getElementById('team-submit-btn');
  if(btn){ if(done>=required.length){btn.classList.add('ready');btn.textContent=Tui('send');} else {btn.classList.remove('ready');btn.textContent=Tui('answerAll');} }
}
document.addEventListener('scroll', function(e){ if(teamMode==='survey'&&e.target&&e.target.id==='team-view')teamScrollY=e.target.scrollTop; }, true);
function teamBackToList(){ teamMode='list'; teamCurrent=null; teamAnswers={}; teamRender(); }

async function teamSubmit() {
  var required = TEAM_QUESTIONS.filter(function(q){return !q.optional;});
  var missing = required.filter(function(q){ var v=teamAnswers[q.id]; if(Array.isArray(v))return v.length===0; if(q.type==='text')return !v||!v.trim().length; return v===undefined||v===null||v===''; });
  if(missing.length){
    var first = missing[0];
    var el = document.getElementById('tq-' + first.id);
    if (el) { el.scrollIntoView({ behavior:'smooth', block:'center' }); el.classList.add('team-q-missing'); setTimeout(function(){ el.classList.remove('team-q-missing'); }, 2200); }
    return;
  }
  var btn=document.getElementById('team-submit-btn'); if(btn){btn.disabled=true;btn.textContent=Tui('sending');}
  var row = { staff_id:(teamCurrent._virtual?null:teamCurrent.id), staff_name:teamCurrent.name, designation:teamCurrent.designation||null, station_key:teamCurrent.station_key||null, answers:teamAnswers, lang:teamLang, submitted_at:new Date().toISOString() };
  try { var res=await sb.from('team_survey').insert(row); if(res.error)throw res.error; teamMode='thanks'; teamRender(); }
  catch(e){ if(btn){btn.disabled=false;btn.textContent=Tui('send');} alert('Could not send — please try again.\n'+(e.message||'')); }
}

function teamThanksHTML(){
  return '<div class="team-wrap team-thanks"><div class="team-thanks-tick">&#10003;</div>' +
    '<div class="team-title">' + Tui('thanks') + ', ' + (teamCurrent?teamCurrent.name.split(' ')[0]:'') + '</div>' +
    '<div class="team-sub">' + Tui('thanksMsg') + '</div>' +
    '<button class="team-submit ready" onclick="teamBackToList()">'+Tui('done')+'</button></div>';
}

// ── Scoring (reads option KEYS, language-independent) ──
function teamScoreOne(answers){
  var raw={rel:0,int:0,loy:0,eng:0,flight:0,concern:0};
  var maxAbs={rel:0,int:0,loy:0,eng:0,flight:0,concern:0};
  TEAM_QUESTIONS.forEach(function(q){
    var v=answers[q.id];
    if(q.type==='scale'&&q.score&&q.score.map){
      var dim=q.score.dim;
      var contribs=Object.keys(q.score.map).map(function(k){return Math.abs(q.score.map[k]);});
      maxAbs[dim]+=Math.max.apply(null,contribs);
      if(v&&q.score.map[v]!==undefined)raw[dim]+=q.score.map[v];
      return;
    }
    if(!q.opts)return;
    // max possible per dim from this question's options
    var perDim={};
    q.opts.forEach(function(o){ if(!o.score)return; Object.keys(o.score).forEach(function(d){ perDim[d]=Math.max(perDim[d]||0,Math.abs(o.score[d])); }); });
    Object.keys(perDim).forEach(function(d){ maxAbs[d]+=perDim[d]; });
    var sel=Array.isArray(v)?v:(v!=null?[v]:[]);
    sel.forEach(function(key){
      var o=null; for(var i=0;i<q.opts.length;i++){ if(q.opts[i].k===key){o=q.opts[i];break;} }
      if(o&&o.score)Object.keys(o.score).forEach(function(d){ raw[d]+=o.score[d]; });
    });
  });
  // ── Cross-check pairs: contradiction softens the dimension toward caution ──
  var contradictions=[];
  TEAM_CROSSCHECKS.forEach(function(cc){
    if(cc.contradiction(answers)){
      contradictions.push(cc);
      // soften: pull the raw score for that dim toward 0 (neutral/cautious)
      var dimMap={loyalty:'loy',integrity:'int',reliability:'rel',engagement:'eng'};
      var d=dimMap[cc.dim]; if(d!=null){ raw[d]=raw[d]*0.4; }
    }
  });
  function norm(d){ if(!maxAbs[d])return null; var v=Math.round(50+(raw[d]/maxAbs[d])*50); return Math.max(0,Math.min(100,v)); }
  return { reliability:norm('rel'), integrity:norm('int'), loyalty:norm('loy'), engagement:norm('eng'),
           flightRaw:raw.flight, flightMax:maxAbs.flight, concernRaw:raw.concern, contradictions:contradictions };
}

function teamFlags(s,answers){
  var flags=[];
  // Flight risk — strong if direct (plans to leave), else soft from accumulated signal
  if(s.flightMax>0){
    var fr=s.flightRaw/s.flightMax;
    if(answers.next_year==='c'||answers.team_mood==='d') flags.push({k:'Flight risk',level:'strong',txt:'Signs they may be leaving'});
    else if(fr>=0.5) flags.push({k:'Flight risk',level:'soft',txt:'Some signs of looking elsewhere'});
  }
  if(s.integrity!==null){
    if(s.integrity<=28)flags.push({k:'Integrity',level:'strong',txt:'Concerning pattern on the honesty questions'});
    else if(s.integrity<=40)flags.push({k:'Integrity',level:'soft',txt:'One or two self-serving answers — worth a normal eye'});
    else if(s.integrity>=82)flags.push({k:'Integrity',level:'good',txt:'Clear, settled honesty'});
  }
  if(s.engagement!==null){
    if(s.engagement<=28)flags.push({k:'Burnout / low engagement',level:'strong',txt:'Running on empty'});
    else if(s.engagement<=42)flags.push({k:'Engagement dip',level:'soft',txt:'Energy is fading'});
    else if(s.engagement>=80)flags.push({k:'Engaged',level:'good',txt:'Genuinely invested'});
  }
  if(s.reliability!==null){
    if(s.reliability<=32)flags.push({k:'Reliability',level:'soft',txt:'May struggle to follow through under pressure'});
    else if(s.reliability>=80)flags.push({k:'Reliable',level:'good',txt:'Dependable under pressure'});
  }
  if(s.loyalty!==null&&s.loyalty>=78)flags.push({k:'Loyal',level:'good',txt:'Wants to stay and build here'});
  if(s.concernRaw>=2)flags.push({k:'Concerns raised',level:'soft',txt:'Flagged several frustrations'});
  // Cross-check contradictions → their own soft flag
  (s.contradictions||[]).forEach(function(cc){
    flags.push({k:'Answers don\u2019t line up',level:'soft',txt:cc.note});
  });
  return flags;
}

async function teamOpenAdmin(){
  teamMode='admin';
  try { var res=await sb.from('team_survey').select('*').order('submitted_at',{ascending:false}); teamSubmissions=res.data||[]; }
  catch(e){ teamSubmissions=[]; }
  await teamLoadSummary();
  teamRender();
  // translate non-English free-text in the background, then re-render
  teamTranslateFreeText();
}

// Cache of translated free text: key = original string, value = English
var teamTransCache = {};
async function teamTranslateFreeText(){
  // collect non-English free-text answers needing translation
  var toTranslate = [];
  teamSubmissions.forEach(function(r){
    if(!r.lang || r.lang==='en') return;
    var a=r.answers||{};
    ['change_one','anything'].forEach(function(f){
      var v=a[f];
      if(v && v.trim() && teamTransCache[v]===undefined){ toTranslate.push(v.trim()); }
    });
  });
  // de-dupe
  toTranslate = toTranslate.filter(function(v,i){ return toTranslate.indexOf(v)===i; });
  if(!toTranslate.length) return;
  try{
    var resp = await fetch(TEAM_AI_PROXY_URL, {
      method:'POST', headers: teamAiProxyHeaders(),
      body: JSON.stringify({ action:'translate', items: toTranslate })
    });
    var data = await resp.json();
    var arr = data.translations || [];
    toTranslate.forEach(function(orig,i){ if(arr[i]) teamTransCache[orig]=arr[i]; });
    if(teamMode==='admin') teamRender(); // re-render with translations
  }catch(e){ /* leave originals if translation fails */ }
}
// ── AI proxy (secure Supabase Edge Function — keeps the Anthropic key server-side) ──
var TEAM_AI_PROXY_URL = 'https://zrpglswalgjbtghudmhu.supabase.co/functions/v1/survey-assistant';
var TEAM_AI_PROXY_SECRET = 'Kitchen';
function teamAiProxyHeaders(){
  return {
    'Content-Type':'application/json',
    'Authorization':'Bearer '+SUPABASE_KEY,
    'apikey':SUPABASE_KEY,
    'x-proxy-secret':TEAM_AI_PROXY_SECRET
  };
}

// Return English text for a free-text answer (translated if available)
function teamEnText(v){ if(!v)return v; return teamTransCache[v.trim()] || v; }

function teamBar(label,val){
  if(val===null)return '<div class="ta-bar-row"><span>'+label+'</span><span class="ta-na">no data</span></div>';
  var cls=val>=70?'hi':(val>=45?'mid':'lo');
  return '<div class="ta-bar-row"><span>'+label+'</span><span class="ta-bar"><span class="ta-bar-fill '+cls+'" style="width:'+val+'%"></span></span><span class="ta-val">'+val+'</span></div>';
}

// Word label for a 0-100 score by dimension
function teamWord(dim,v){
  if(v===null)return 'no data';
  if(dim==='integrity'){ if(v>=80)return 'Strong'; if(v>=60)return 'Solid'; if(v>=45)return 'Mixed'; return 'Watch'; }
  if(dim==='engagement'){ if(v>=75)return 'Engaged'; if(v>=55)return 'Good'; if(v>=40)return 'Tiring'; return 'Watch'; }
  if(dim==='loyalty'){ if(v>=75)return 'High'; if(v>=55)return 'Good'; if(v>=40)return 'Mixed'; return 'Low'; }
  // reliability
  if(v>=75)return 'High'; if(v>=55)return 'Solid'; if(v>=40)return 'Mixed'; return 'Watch';
}
// One sentence explaining a person's dimension, driven by their actual answers
function teamExplain(dim,v,a){
  if(v===null)return '';
  if(dim==='reliability'){
    if(v>=70)return 'Copes under pressure and follows through. You can lean on them.';
    if(v>=45)return 'Mostly steady, but can wobble when things pile up.';
    return 'May struggle to follow through when it gets hard — needs structure.';
  }
  if(dim==='integrity'){
    if(v>=80)return 'Consistently chose the honest line on the everyday questions. (Self-report — proof is behaviour over time.)';
    if(v>=60)return 'Largely honest answers, nothing concerning.';
    if(v>=45)return 'One or two self-serving answers — worth a normal eye, not alarm.';
    return 'Several self-serving choices on everyday situations — keep an eye, never treat as proof.';
  }
  if(dim==='loyalty'){
    if(v>=75)return 'Wants to stay and build here — invest in them.';
    if(v>=55)return 'Reasonably settled, open to growing here.';
    if(v>=40)return 'Mixed feelings about staying — could go either way.';
    return 'Little attachment — at risk of drifting away.';
  }
  // engagement
  if(v>=75)return 'Genuinely invested and energised.';
  if(v>=55)return 'Engaged but feeling the load — watch it does not slide.';
  if(v>=40)return 'Energy is fading — tired more than inspired.';
  return 'Running on empty — burnout risk.';
}
// One-line verdict for a person
function teamVerdict(s,flags){
  var strong=flags.filter(function(f){return f.level==='strong';});
  var leaving=flags.some(function(f){return f.k==='Flight risk';});
  var burn=flags.some(function(f){return f.k.indexOf('Burnout')!==-1;});
  var intg=flags.some(function(f){return f.k==='Integrity'&&f.level!=='good';});
  var loyalPos=(s.loyalty!==null&&s.loyalty>=75);
  if(intg&&strong.length)return 'Capable but gave concerning honesty answers — watch closely before trusting further.';
  if(burn&&leaving)return 'Burning out AND looking around — act soon or you will lose them.';
  if(burn)return 'Doing the work but running on empty — relieve the load before it becomes a resignation.';
  if(leaving)return 'Showing they may be on the way out — have the conversation now.';
  if(loyalPos&&(s.reliability===null||s.reliability>=60))return 'Dependable and committed — a keeper, give them a path.';
  if(!flags.length||flags.every(function(f){return f.level==='good';}))return 'Settled and positive across the board. No concerns.';
  return 'Mostly solid with a couple of soft signals worth a casual check-in.';
}

// Display name respecting anonymous mode. In anon mode, returns "Section #n".
var _teamAnonMap = null;
function teamBuildAnonMap(subs){
  _teamAnonMap = {};
  var counters = {};
  subs.forEach(function(r){
    var sec = teamSectionFor(r.station_key).label;
    counters[sec] = (counters[sec]||0)+1;
    _teamAnonMap[r.staff_id||r.staff_name] = sec + ' #' + counters[sec];
  });
}
function teamDisplayName(r){
  if(!teamAdminAnon) return r.staff_name;
  if(_teamAnonMap){ return _teamAnonMap[r.staff_id||r.staff_name] || 'Anonymous'; }
  return 'Anonymous';
}

function teamAdminHTML(){
  var latest={};
  teamSubmissions.forEach(function(r){ var key=r.staff_id||r.staff_name; if(!latest[key])latest[key]=r; });
  var subs=Object.keys(latest).map(function(k){return latest[k];});
  teamBuildAnonMap(subs);
  var total=teamStaff.length;
  var completedIds={}; subs.forEach(function(r){ completedIds[r.staff_id||r.staff_name]=true; });
  var completed=teamStaff.filter(function(s){return completedIds[s.id]||completedIds[s.name];}).length;
  function avg(arr){ return arr.length?Math.round(arr.reduce(function(x,y){return x+y;},0)/arr.length):null; }

  var html='<div class="team-wrap"><div class="team-head"><button class="team-back" onclick="openTeam()">&#8592; Back</button>';
  html+='<div class="team-title">Team Report'+(teamAdminAnon?' <span class="ta-mode anon">Anonymous</span>':' <span class="ta-mode named">Named</span>')+'</div>';
  html+='<div class="team-sub">'+TEAM_ROUND.label+'. Honest signals, not verdicts — strong flags are reliable, soft ones are conversations to have.</div></div>';
  // completion banner
  var pct = total ? Math.round(completed/total*100) : 0;
  html+='<div class="ta-completion"><div class="tps-top"><span class="tps-pct">'+pct+'%</span><span class="tps-count">'+completed+' / '+total+' completed</span></div>';
  html+='<div class="tps-bar"><span class="tps-fill" style="width:'+pct+'%"></span></div>';
  html+='<div class="tps-dates"><span>Deadline '+teamFmtDate(TEAM_ROUND.deadline)+'</span><span>Next test '+teamFmtDate(TEAM_ROUND.nextTest)+'</span></div></div>';
  html+='<button class="cd-open-btn" onclick="openTeamChairman()">&#128202; Open Dashboard (presentation mode)</button>';

  if(subs.length){ html += teamAiPanelHTML(); }

  if(subs.length){
    // global aggregates + flag tallies
    var agg={reliability:[],integrity:[],loyalty:[],engagement:[]};
    var flightStrong=[],flightSoft=[],integritySoft=[],integrityStrong=[],burnout=[],loyal=[];
    var concernsText=[];
    subs.forEach(function(r){
      var s=teamScoreOne(r.answers||{});
      ['reliability','integrity','loyalty','engagement'].forEach(function(d){ if(s[d]!==null)agg[d].push(s[d]); });
      teamFlags(s,r.answers||{}).forEach(function(f){
        if(f.k==='Flight risk'&&f.level==='strong')flightStrong.push(teamDisplayName(r));
        if(f.k==='Flight risk'&&f.level==='soft')flightSoft.push(teamDisplayName(r));
        if(f.k==='Integrity'&&f.level==='soft')integritySoft.push(teamDisplayName(r));
        if(f.k==='Integrity'&&f.level==='strong')integrityStrong.push(teamDisplayName(r));
        if(f.k.indexOf('Burnout')!==-1)burnout.push(teamDisplayName(r));
        if(f.k==='Loyal')loyal.push(teamDisplayName(r));
      });
      var c1=(r.answers||{}).change_one; if(c1&&c1.trim())concernsText.push({n:teamDisplayName(r),t:teamEnText(c1.trim())});
    });

    // ── headline ──
    html+='<div class="ta-overview"><div class="ta-section-title">Where you stand today</div>';
    html+='<div class="ta-headline">';
    var head=[];
    head.push('Honesty looks '+(avg(agg.integrity)>=60?'solid':'mixed')+' and the team is '+(avg(agg.reliability)>=60?'dependable':'uneven')+' under pressure.');
    if(burnout.length||flightStrong.length) head.push('The real risk is energy and retention — '+(burnout.length?burnout.length+' running low':'')+(burnout.length&&flightStrong.length?', and ':'')+(flightStrong.length?flightStrong.length+' may be on the way out':'')+'.');
    else head.push('No urgent flight or burnout signals right now.');
    html+=head.join(' ')+'</div>';

    // ── team averages ──
    html+='<div class="ta-section-title" style="margin-top:14px">Team averages</div>';
    [['reliability','Reliability'],['integrity','Integrity'],['loyalty','Loyalty'],['engagement','Engagement']].forEach(function(d){
      var v=avg(agg[d[0]]);
      html+='<div class="ta-avgrow">'+teamBar(d[1]+' &middot; '+teamWord(d[0],v),v)+'</div>';
    });

    // ── what needs attention (prioritised) ──
    html+='<div class="ta-section-title" style="margin-top:16px">What needs your attention</div><div class="ta-attn">';
    if(burnout.length) html+='<div class="ta-attn-row hi"><b>'+burnout.length+' burning out</b> — '+burnout.join(', ')+'. Energy is the most urgent thing; burnout becomes resignation if ignored.</div>';
    if(flightStrong.length) html+='<div class="ta-attn-row hi"><b>'+flightStrong.length+' clear flight risk</b> — '+flightStrong.join(', ')+'. Have the conversation now.</div>';
    if(flightSoft.length) html+='<div class="ta-attn-row mid"><b>'+flightSoft.length+' restless (soft)</b> — '+flightSoft.join(', ')+'. A quiet one-to-one before it hardens.</div>';
    if(integrityStrong.length) html+='<div class="ta-attn-row hi"><b>'+integrityStrong.length+' integrity concern</b> — '+integrityStrong.join(', ')+'. Watch closely (still not proof).</div>';
    if(integritySoft.length) html+='<div class="ta-attn-row mid"><b>'+integritySoft.length+' integrity worth a look (soft)</b> — '+integritySoft.join(', ')+'. Normal eye, no alarm.</div>';
    if(loyal.length) html+='<div class="ta-attn-row good"><b>'+loyal.length+' solid and committed</b> — '+loyal.join(', ')+'. Your dependable core — give the growth-minded ones a path.</div>';
    if(!burnout.length&&!flightStrong.length&&!flightSoft.length&&!integritySoft.length&&!integrityStrong.length&&!loyal.length) html+='<div class="ta-attn-row good">No flags raised. A calm, settled set of responses.</div>';
    html+='</div>';

    // ── their words ──
    if(concernsText.length){
      html+='<div class="ta-section-title" style="margin-top:16px">In their words — what they would change</div>';
      concernsText.slice(0,15).forEach(function(o){ html+='<div class="ta-quote">"'+o.t+'" <span>— '+o.n+'</span></div>'; });
    }
    html+='</div>';

    // ── PER-SECTION breakdown ──
    html+='<div class="team-station">By section</div>';
    TEAM_SECTIONS.forEach(function(sec){
      var members=subs.filter(function(r){ return teamSectionFor(r.station_key).key===sec.key; });
      if(!members.length)return;
      var sa={reliability:[],integrity:[],loyalty:[],engagement:[]};
      members.forEach(function(r){ var s=teamScoreOne(r.answers||{}); ['reliability','integrity','loyalty','engagement'].forEach(function(d){ if(s[d]!==null)sa[d].push(s[d]); }); });
      html+='<div class="ta-section-card"><div class="ta-section-head">'+sec.label+' <span>'+members.length+(members.length===1?' person':' people')+'</span></div>';
      html+=teamBar('Reliability',avg(sa.reliability))+teamBar('Integrity',avg(sa.integrity))+teamBar('Loyalty',avg(sa.loyalty))+teamBar('Engagement',avg(sa.engagement));
      html+='</div>';
    });
  }

  // ── completion ──
  if(teamAdminAnon){
    html+='<div class="team-station">Completion</div><div class="team-admin-status"><div class="team-status-row is-done"><span>'+completed+' of '+total+' completed</span><span>'+(total?Math.round(completed/total*100):0)+'%</span></div></div>';
  } else {
    html+='<div class="team-station">Completion</div><div class="team-admin-status">';
    TEAM_SECTIONS.forEach(function(sec){
      var inSec=teamStaff.filter(function(s){ return teamSectionFor(s.station_key).key===sec.key; });
      if(!inSec.length)return;
      inSec.forEach(function(s){ var ok=completedIds[s.id]||completedIds[s.name]; html+='<div class="team-status-row '+(ok?'is-done':'is-pending')+'"><span>'+s.name+' <em style="opacity:.5;font-style:normal;font-size:11px">'+sec.label+'</em></span><span>'+(ok?'✓ done':'waiting')+'</span></div>'; });
    });
    html+='</div>';
  }

  // ── INDIVIDUAL readouts, grouped by section ──
  html+='<div class="team-station">Individual reports</div>';
  if(!subs.length)html+='<div class="team-empty">No responses yet.</div>';
  TEAM_SECTIONS.forEach(function(sec){
    var members=subs.filter(function(r){ return teamSectionFor(r.station_key).key===sec.key; });
    if(!members.length)return;
    html+='<div class="ta-secdiv">'+sec.label+'</div>';
    members.forEach(function(r){
      var a=r.answers||{}; var s=teamScoreOne(a); var flags=teamFlags(s,a);
      var nameHtml = teamAdminAnon ? teamDisplayName(r) : (r.staff_name + ' <span>'+(r.designation||'')+'</span>');
      html+='<div class="ta-person"><div class="ta-person-name">'+nameHtml+'</div>';
      html+='<div class="ta-oneline">'+teamVerdict(s,flags)+'</div>';
      [['reliability','Reliability'],['integrity','Integrity'],['loyalty','Loyalty'],['engagement','Engagement']].forEach(function(d){
        var v=s[d[0]];
        html+='<div class="ta-dim"><div class="ta-dim-top"><span class="ta-dim-name">'+d[1]+'</span><span class="ta-dim-word">'+(v===null?'no data':v+' &middot; '+teamWord(d[0],v))+'</span></div>';
        html+=teamBar('',v);
        html+='<div class="ta-dim-exp">'+teamExplain(d[0],v,a)+'</div></div>';
      });
      if(flags.length){
        html+='<div class="ta-flags">';
        flags.forEach(function(f){ html+='<span class="ta-flag lv-'+f.level+'">'+f.k+' <em>'+f.level+'</em></span>'; });
        html+='</div>';
      }
      // motivators / drains in words
      if(Array.isArray(a.motivate)&&a.motivate.length) html+='<div class="ta-said"><b>Motivated by:</b> '+a.motivate.map(function(k){return TEAM_I18N.en.q.motivate.o[k]||k;}).join(', ')+'</div>';
      if(Array.isArray(a.drains)&&a.drains.length) html+='<div class="ta-said"><b>Drained by:</b> '+a.drains.map(function(k){return TEAM_I18N.en.q.drains.o[k]||k;}).join(', ')+'</div>';
      if(a.change_one&&a.change_one.trim())html+='<div class="ta-said"><b>Would change:</b> '+teamEnText(a.change_one.trim())+'</div>';
      if(a.anything&&a.anything.trim())html+='<div class="ta-said"><b>Also said:</b> '+teamEnText(a.anything.trim())+'</div>';
      html+='</div>';
    });
  });

  html+='<div class="ta-footer">A short survey points, it does not prove. Strong flags are reliable; soft flags are conversations to have, never verdicts to act on alone. Re-run every 3 months to see who is trending up or down.</div>';
  html+='</div>';
  return html;
}

// ── Secret admin access: tap the title's top-right corner 5x within 3s ──
var teamCornerTaps = [];
function teamCornerTap() {
  var now = Date.now();
  teamCornerTaps = teamCornerTaps.filter(function(t){ return now - t < 3000; });
  teamCornerTaps.push(now);
  if (teamCornerTaps.length >= 5) {
    teamCornerTaps = [];
    teamAdminAnon = false;
    teamOpenAdmin();
  }
}

// ── Home screen collapsible panels (Daily Operations / Management) ──
function toggleHomePanel(which){
  var panel = document.getElementById(which + '-panel');
  var chev  = document.getElementById(which + '-chev');
  var sect  = document.getElementById(which + '-section');
  if (!panel) return;
  var isOpen = panel.style.display !== 'none' && panel.style.display !== '';
  panel.style.display = isOpen ? 'none' : 'grid';
  if (chev) chev.classList.toggle('open', !isOpen);
  if (sect) sect.classList.toggle('open', !isOpen);
}

// ── Inject survey completion card into the Dashboard (non-invasive wrapper) ──
(function(){
  if (typeof window === 'undefined') return;
  function injectCompletionCard(){
    var view = document.getElementById('dashboard-view');
    if (!view) return;
    if (document.getElementById('dash-survey-card')) return; // already added
    var grid = view.querySelector('.ops-grid');
    if (!grid) return;
    // fetch completion if not loaded
    var render = function(){
      var c = teamCompletionPct();
      var card = document.createElement('div');
      card.className = 'ops-card';
      card.id = 'dash-survey-card';
      card.style.cursor = 'pointer';
      card.onclick = function(){ openTeam(); };
      card.innerHTML = '<div class="ops-num">'+c.pct+'%</div><div class="ops-label">Survey done ('+c.done+'/'+c.total+')</div>';
      grid.appendChild(card);
    };
    if (teamCompletionLoaded && teamStaff.length){ render(); }
    else {
      Promise.resolve().then(async function(){
        try { if(!teamStaff.length) await teamLoadStaff(); await teamLoadCompletion(); render(); } catch(e){}
      });
    }
  }
  var _wrapDashboard = function(){
    if (typeof window.openDashboard !== 'function' || window.openDashboard.__teamWrapped) return;
    var _orig = window.openDashboard;
    window.openDashboard = function(){ _orig.apply(this, arguments); setTimeout(injectCompletionCard, 60); };
    window.openDashboard.__teamWrapped = true;
  };
  if (document.readyState !== 'loading') setTimeout(_wrapDashboard, 0);
  document.addEventListener('DOMContentLoaded', _wrapDashboard);
  window.addEventListener('load', _wrapDashboard);
})();

// ════════════════════════════════════════════════════════════
//  AI ASSISTANT (admin only — reasons from real survey data)
// ════════════════════════════════════════════════════════════
var teamAiIncludeNames = false;   // toggle: include individual names or team-only
var teamAiHistory = [];           // [{role, content}]
var teamAiBusy = false;
var teamAiArea = 'all';           // 'all' or a TEAM_SECTIONS key

// Compile the survey results into a compact text briefing for the model.
function teamAiBriefing(includeNames){
  var latest={};
  teamSubmissions.forEach(function(r){ var k=r.staff_id||r.staff_name; if(!latest[k])latest[k]=r; });
  var subs=Object.keys(latest).map(function(k){return latest[k];});
  // area scope
  var areaLabel='the whole team';
  if(teamAiArea && teamAiArea!=='all'){
    subs = subs.filter(function(r){ return teamSectionFor(r.station_key).key===teamAiArea; });
    var sec=null; for(var i=0;i<TEAM_SECTIONS.length;i++){ if(TEAM_SECTIONS[i].key===teamAiArea){sec=TEAM_SECTIONS[i];break;} }
    areaLabel = sec? ('the '+sec.label+' area') : 'this area';
  }
  if(!subs.length) return 'No survey responses yet for '+areaLabel+'.';

  var agg={reliability:[],integrity:[],loyalty:[],engagement:[]};
  var lines=[];
  function enText(qid,key){ try{ return TEAM_I18N.en.q[qid].o[key]||key; }catch(e){ return key; } }

  lines.push('SCOPE OF THIS ANALYSIS: '+areaLabel+'.');
  // team + section aggregates
  subs.forEach(function(r){ var s=teamScoreOne(r.answers||{}); ['reliability','integrity','loyalty','engagement'].forEach(function(d){ if(s[d]!==null)agg[d].push(s[d]); }); });
  function avg(a){ return a.length?Math.round(a.reduce(function(x,y){return x+y;},0)/a.length):null; }
  lines.push((teamAiArea==='all'?'TEAM SIZE: ':'AREA SIZE: ')+subs.length+' responses'+(teamAiArea==='all'?' of '+teamStaff.length+' staff':'')+'.');
  lines.push('AVERAGES (0-100): Reliability '+avg(agg.reliability)+', Integrity '+avg(agg.integrity)+', Loyalty '+avg(agg.loyalty)+', Engagement '+avg(agg.engagement)+'.');

  // by section (only when looking at whole team)
  if(teamAiArea==='all'){
    lines.push('\nBY SECTION:');
    TEAM_SECTIONS.forEach(function(sec){
      var members=subs.filter(function(r){ return teamSectionFor(r.station_key).key===sec.key; });
      if(!members.length)return;
      var sa={reliability:[],integrity:[],loyalty:[],engagement:[]};
      members.forEach(function(r){ var s=teamScoreOne(r.answers||{}); ['reliability','integrity','loyalty','engagement'].forEach(function(d){ if(s[d]!==null)sa[d].push(s[d]); }); });
      lines.push('- '+sec.label+' ('+members.length+'): Rel '+avg(sa.reliability)+', Int '+avg(sa.integrity)+', Loy '+avg(sa.loyalty)+', Eng '+avg(sa.engagement));
    });
  }

  // flags tally
  var tally={};
  subs.forEach(function(r){ var s=teamScoreOne(r.answers||{}); teamFlags(s,r.answers||{}).forEach(function(f){ var key=f.k+' ('+f.level+')'; tally[key]=(tally[key]||0)+1; }); });
  lines.push('\nFLAGS'+(teamAiArea==='all'?' ACROSS TEAM':' IN THIS AREA')+':');
  Object.keys(tally).forEach(function(k){ lines.push('- '+k+': '+tally[k]); });

  // what they'd change (always include, anonymised unless names on)
  lines.push('\nWHAT THEY WOULD CHANGE (their own words):');
  subs.forEach(function(r){ var c=(r.answers||{}).change_one; if(c&&c.trim()) lines.push('- '+(includeNames?r.staff_name+': ':'')+'"'+teamEnText(c.trim())+'"'); });

  // individual detail only if names allowed
  if(includeNames){
    lines.push('\nINDIVIDUAL DETAIL:');
    subs.forEach(function(r){
      var a=r.answers||{}; var s=teamScoreOne(a); var fl=teamFlags(s,a);
      lines.push('• '+r.staff_name+' ('+(r.designation||'')+', '+teamSectionFor(r.station_key).label+'): Rel '+s.reliability+' Int '+s.integrity+' Loy '+s.loyalty+' Eng '+s.engagement+(fl.length?'; flags: '+fl.map(function(f){return f.k+'/'+f.level;}).join(', '):'; no flags')
        +'; motivated by: '+((a.motivate||[]).map(function(k){return enText('motivate',k);}).join(', ')||'-')
        +'; drained by: '+((a.drains||[]).map(function(k){return enText('drains',k);}).join(', ')||'-'));
    });
  }
  return lines.join('\n');
}

function teamAiSystemPrompt(){
  return 'You are Francesco\'s trusted advisor: a rare blend of two things. First, a veteran luxury-hospitality operator who has run Michelin-level kitchens and floor operations for 25 years — you think in covers, spend-per-head, service flow, brigade dynamics, and margins, and you have seen every kind of kitchen politics. Second, an organisational psychologist who reads people accurately — motivation, trust, burnout, flight risk, the gap between what people say and what they mean. You advise Francesco the way a sharp, expensive consultant who actually knows his restaurant would: direct, specific, and unafraid to name the real issue.\n\n'
    + 'WHO FRANCESCO IS: senior leader at Roberto\'s, a luxury Italian restaurant in DIFC, Dubai. He runs operations, guest experience, the team, and strategy under real financial pressure. He is Italian, exacting, protective of his people, and thinks like an owner. He does not need motivational fluff — he needs an edge he doesn\'t already have.\n\n'
    + 'HOW TO THINK:\n'
    + '- Read BENEATH the data. Do not just restate scores — interpret them. A low integrity score next to a high engagement score tells a story; tell it. Connect dots across questions (e.g. someone who wants autonomy but distrusts the team is signalling something specific).\n'
    + '- Distinguish the SIGNAL from the noise. With few responses, say so once, briefly, then give your best read anyway — Francesco wants your judgement, not endless caveats.\n'
    + '- Be psychologically precise. Instead of "improve engagement," name the mechanism: what is draining it, for whom, and the lever that actually moves it.\n'
    + '- Give advice only a real F&B operator would give — tied to service, stations, covers, brigade hierarchy, the specific cultural mix (India, Nepal, Italy, Philippines), and the realities of a Dubai luxury venue. No generic HR playbook lines like "run a weekly briefing" unless you make it specific and explain exactly why it fits THIS data.\n'
    + '- When you spot a real risk (a key person leaving, a trust problem, a brewing resentment), say it plainly and tell him what to do this week.\n'
    + '- Prioritise ruthlessly. Francesco has limited time and energy. Tell him the ONE thing that matters most, then the rest.\n\n'
    + 'GROUND RULES:\n'
    + '- Base everything on the actual data. Quote their real words and the real numbers. Never invent names, scores, or quotes. If asked about someone not in the data, say so.\n'
    + '- Soft signals are conversations to have, not verdicts. Be honest about the difference between what the data suggests and what it proves.\n\n'
    + 'OUTPUT FORMAT — IMPORTANT:\n'
    + '- Write in plain, clean prose. This is shown in a simple chat box that does NOT render markdown. Do NOT use #, ##, **bold**, tables with |, or > quotes — they show up as ugly raw symbols.\n'
    + '- Use short paragraphs. For lists, use simple dashes (-) at the start of a line, nothing fancier.\n'
    + '- When you quote what someone wrote, just put it in quotation marks inline.\n'
    + '- Keep it tight and high-value. Lead with the most important insight in the first sentence. Sound like a brilliant colleague talking, not a report being filed.\n\n'
    + '=== SURVEY DATA ===\n' + teamAiBriefing(teamAiIncludeNames);
}

async function teamAiAsk(question){
  if(teamAiBusy) return;
  if(!question || !question.trim()) return;
  teamAiBusy = true;
  teamAiHistory.push({role:'user', content:question.trim()});
  teamAiRenderChat(true);
  try{
    var messages = teamAiHistory.slice(-10); // keep context bounded
    var resp = await fetch(TEAM_AI_PROXY_URL, {
      method:'POST', headers: teamAiProxyHeaders(),
      body: JSON.stringify({
        action:'chat', model:'claude-sonnet-4-6', max_tokens:1000,
        system: teamAiSystemPrompt(),
        messages: messages
      })
    });
    var data = await resp.json();
    var text = (data.text||'').trim();
    if(!text && data.error) text = 'Assistant error: '+data.error;
    if(!text) text = 'No answer came back. Try rephrasing.';
    teamAiHistory.push({role:'assistant', content:text});
  }catch(e){
    teamAiHistory.push({role:'assistant', content:'Could not reach the assistant just now. Please try again.'});
  }
  teamAiBusy = false;
  teamAiRenderChat(false);
}

function teamAiQuick(q){ teamAiAsk(q); }
function teamAiToggleNames(){ if(teamAdminAnon){ alert('This report was opened in Anonymous mode. To analyse by name, open the report with the named passcode.'); return; } teamAiIncludeNames = !teamAiIncludeNames; var b=document.getElementById('ai-names-toggle'); if(b){ b.classList.toggle('on', teamAiIncludeNames); b.textContent = teamAiIncludeNames?'Names: ON':'Names: off'; } }
function teamAiSend(){ var inp=document.getElementById('ai-input'); if(!inp)return; var v=inp.value; inp.value=''; teamAiAsk(v); }
function teamAiInputKey(e){ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); teamAiSend(); } }
function teamAiClear(){ teamAiHistory=[]; teamAiRenderChat(false); }

function teamAiRenderChat(thinking){
  var box=document.getElementById('ai-chat'); if(!box)return;
  var html='';
  teamAiHistory.forEach(function(m, idx){
    if(m.role==='assistant'){
      html += '<div class="ai-msg ai-assistant"><div class="ai-msg-body">'+teamAiFormat(m.content)+'</div>'
        +'<button class="ai-copy" onclick="teamAiCopy('+idx+')" title="Copy answer">Copy</button></div>';
    } else {
      html += '<div class="ai-msg ai-user">'+teamAiFormat(m.content)+'</div>';
    }
  });
  if(thinking) html += '<div class="ai-msg ai-assistant ai-thinking"><span class="ai-dot"></span><span class="ai-dot"></span><span class="ai-dot"></span></div>';
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
}
function teamAiCopy(idx){
  var m=teamAiHistory[idx]; if(!m)return;
  var txt=m.content;
  if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(txt).then(function(){ teamAiToast('Copied'); }); }
  else { var ta=document.createElement('textarea'); ta.value=txt; document.body.appendChild(ta); ta.select(); try{document.execCommand('copy');teamAiToast('Copied');}catch(e){} document.body.removeChild(ta); }
}
function teamAiToast(msg){
  var t=document.getElementById('ai-toast'); if(!t){ t=document.createElement('div'); t.id='ai-toast'; t.className='ai-toast'; document.body.appendChild(t); }
  t.textContent=msg; t.classList.add('show'); setTimeout(function(){ t.classList.remove('show'); },1400);
}
function teamAiFormat(t){
  // escape HTML first
  var s = t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  var lines = s.split('\n');
  var out = [];
  var inList = false;
  lines.forEach(function(line){
    var l = line.replace(/\s+$/,'');
    // strip leading markdown table pipes / separators — render tables as plain lines
    if(/^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.indexOf('|')!==-1){ return; } // table separator row
    // headers (#, ##, ###) -> bold line
    var h = l.match(/^\s*#{1,6}\s+(.*)$/);
    if(h){ if(inList){out.push('</ul>');inList=false;} out.push('<div class="ai-h">'+teamAiInline(h[1])+'</div>'); return; }
    // bullet (- or *)
    var b = l.match(/^\s*[-*]\s+(.*)$/);
    if(b){ if(!inList){out.push('<ul class="ai-ul">');inList=true;} out.push('<li>'+teamAiInline(b[1])+'</li>'); return; }
    if(inList){ out.push('</ul>'); inList=false; }
    // blockquote
    var q = l.match(/^\s*&gt;\s*(.*)$/);
    if(q){ out.push('<div class="ai-quote">'+teamAiInline(q[1])+'</div>'); return; }
    // table row -> join cells with spacing
    if(l.indexOf('|')!==-1 && (l.match(/\|/g)||[]).length>=2){
      var cells = l.split('|').map(function(c){return c.trim();}).filter(function(c){return c.length;});
      out.push('<div class="ai-row">'+cells.map(function(c){return teamAiInline(c);}).join(' &nbsp;·&nbsp; ')+'</div>'); return;
    }
    if(l.trim()===''){ out.push('<div class="ai-sp"></div>'); return; }
    out.push('<div>'+teamAiInline(l)+'</div>');
  });
  if(inList) out.push('</ul>');
  return out.join('');
}
// inline: bold, italics
function teamAiInline(s){
  return s
    .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g,'$1<em>$2</em>')
    .replace(/`([^`]+)`/g,'<code>$1</code>');
}

function teamAiAreaOptions(){
  var subs={};
  teamSubmissions.forEach(function(r){ var k=teamSectionFor(r.station_key).key; subs[k]=(subs[k]||0)+1; });
  var h='<option value="all">Whole team</option>';
  TEAM_SECTIONS.forEach(function(sec){ if(subs[sec.key]) h+='<option value="'+sec.key+'"'+(teamAiArea===sec.key?' selected':'')+'>'+sec.label+' ('+subs[sec.key]+')</option>'; });
  return h;
}
function teamAiSetArea(v){ teamAiArea=v; }

function teamAiPanelHTML(){
  var h='<div class="ai-panel">';
  // header row
  h+='<div class="ai-head"><span class="ai-title">Ask the Assistant</span>';
  h+= teamAdminAnon ? '<span class="ai-anon-tag">Anonymous</span>' : '<button class="ai-names-toggle" id="ai-names-toggle" onclick="teamAiToggleNames()">Names: off</button>';
  h+='</div>';
  // scope selector
  h+='<div class="ai-scope"><label class="ai-scope-lbl">Focus on</label><select class="ai-scope-sel" onchange="teamAiSetArea(this.value)">'+teamAiAreaOptions()+'</select></div>';
  // quick actions
  h+='<div class="ai-quick">';
  [['⚡','What changes would make the team more efficient?'],['⚠️','Where are we most at risk?'],['↗️','Who should I develop or promote?'],['🔥','How do I improve engagement?'],['💬','What are the common themes in their words?']].forEach(function(q){
    h+='<button class="ai-qbtn" onclick="teamAiQuick(\''+q[1].replace(/'/g,"\\'")+'\')"><span class="ai-qicon">'+q[0]+'</span>'+q[1]+'</button>';
  });
  h+='</div>';
  // chat
  h+='<div class="ai-chat" id="ai-chat"></div>';
  // input
  h+='<div class="ai-inputbar"><textarea id="ai-input" class="ai-input" rows="1" placeholder="Ask anything about the results…" onkeydown="teamAiInputKey(event)"></textarea>';
  h+='<button class="ai-send" onclick="teamAiSend()">Ask</button></div>';
  // footer
  h+='<div class="ai-foot"><button class="ai-clear" onclick="teamAiClear()">Clear chat</button><span class="ai-note">Grounded in your survey data. Soft signals are conversations, not verdicts.</span></div>';
  h+='</div>';
  return h;
}

// ════════════════════════════════════════════════════════════
//  CHAIRMAN DASHBOARD — clean presentation mode (anonymous, aggregate + by-area)
// ════════════════════════════════════════════════════════════
var teamChairView = 'aggregate';   // 'aggregate' | 'byarea'

function teamChairStats(){
  var latest={};
  teamSubmissions.forEach(function(r){ var k=r.staff_id||r.staff_name; if(!latest[k])latest[k]=r; });
  var subs=Object.keys(latest).map(function(k){return latest[k];});
  var total=teamStaff.length;
  function avg(a){ return a.length?Math.round(a.reduce(function(x,y){return x+y;},0)/a.length):null; }

  var dims=['reliability','integrity','loyalty','engagement'];
  var agg={reliability:[],integrity:[],loyalty:[],engagement:[]};
  var flightStrong=0, flightSoft=0, burnout=0, loyal=0, engagedHi=0, integrityLow=0;
  var themes={};
  subs.forEach(function(r){
    var a=r.answers||{}; var s=teamScoreOne(a); var fl=teamFlags(s,a);
    dims.forEach(function(d){ if(s[d]!==null)agg[d].push(s[d]); });
    fl.forEach(function(f){
      if(f.k==='Flight risk'&&f.level==='strong')flightStrong++;
      if(f.k==='Flight risk'&&f.level==='soft')flightSoft++;
      if(f.k.indexOf('Burnout')!==-1)burnout++;
      if(f.k==='Loyal')loyal++;
      if(f.k==='Engaged')engagedHi++;
      if(f.k==='Integrity'&&(f.level==='soft'||f.level==='strong'))integrityLow++;
    });
    // themes from drains (structured, language-independent)
    (a.drains||[]).forEach(function(k){ var t=TEAM_I18N.en.q.drains.o[k]; if(t){themes[t]=(themes[t]||0)+1;} });
  });
  // section-level
  var sections=[];
  TEAM_SECTIONS.forEach(function(sec){
    var mem=subs.filter(function(r){ return teamSectionFor(r.station_key).key===sec.key; });
    if(!mem.length)return;
    var sa={reliability:[],integrity:[],loyalty:[],engagement:[]};
    mem.forEach(function(r){ var s=teamScoreOne(r.answers||{}); dims.forEach(function(d){ if(s[d]!==null)sa[d].push(s[d]); }); });
    sections.push({ label:sec.label, n:mem.length,
      reliability:avg(sa.reliability), integrity:avg(sa.integrity), loyalty:avg(sa.loyalty), engagement:avg(sa.engagement) });
  });
  var themeList=Object.keys(themes).map(function(k){return {t:k,n:themes[k]};}).sort(function(a,b){return b.n-a.n;});
  return {
    total:total, responded:subs.length, pct: total?Math.round(subs.length/total*100):0,
    avg:{ reliability:avg(agg.reliability), integrity:avg(agg.integrity), loyalty:avg(agg.loyalty), engagement:avg(agg.engagement) },
    overall: avg([].concat(agg.reliability,agg.integrity,agg.loyalty,agg.engagement)),
    flightStrong:flightStrong, flightSoft:flightSoft, burnout:burnout, loyal:loyal, engagedHi:engagedHi, integrityLow:integrityLow,
    sections:sections, themes:themeList, subs:subs
  };
}

// ── SVG helpers ──
function teamColorFor(v){ if(v===null)return '#cfc0ad'; return v>=70?'#4b5128':(v>=50?'#caa23a':'#a8321a'); }
function teamDonut(v,label){
  var r=52, c=2*Math.PI*r, pct=(v||0)/100, dash=c*pct;
  var col=teamColorFor(v);
  return '<div class="cd-donut"><svg viewBox="0 0 130 130">'
    +'<circle cx="65" cy="65" r="'+r+'" fill="none" stroke="#ece3d5" stroke-width="13"/>'
    +'<circle cx="65" cy="65" r="'+r+'" fill="none" stroke="'+col+'" stroke-width="13" stroke-linecap="round" stroke-dasharray="'+dash+' '+c+'" transform="rotate(-90 65 65)"/>'
    +'<text x="65" y="60" text-anchor="middle" class="cd-donut-num">'+(v===null?'–':v)+'</text>'
    +'<text x="65" y="82" text-anchor="middle" class="cd-donut-lbl">/100</text></svg>'
    +'<div class="cd-donut-name">'+label+'</div></div>';
}
function teamBarChart(rows, maxv){
  maxv = maxv || 100;
  var h='<div class="cd-barchart">';
  rows.forEach(function(row){
    var w = row.v===null?0:Math.round(row.v/maxv*100);
    h+='<div class="cd-bc-row"><div class="cd-bc-label">'+row.label+'</div>'
      +'<div class="cd-bc-track"><div class="cd-bc-fill" style="width:'+w+'%;background:'+(row.color||teamColorFor(row.v))+'"></div></div>'
      +'<div class="cd-bc-val">'+(row.v===null?'–':row.v)+'</div></div>';
  });
  return h+'</div>';
}

function teamChairmanHTML(){
  var st = teamChairStats();
  var lowSample = st.pct < 60;
  var h='<div class="cd-wrap" id="cd-wrap">';

  // ── header / controls (hidden in print) ──
  h+='<div class="cd-controls no-print">';
  h+='<button class="team-back" onclick="openTeam()">&#8592; Back</button>';
  h+='<div class="cd-toggle">';
  h+='<button class="cd-tg'+(teamChairView==='aggregate'?' on':'')+'" onclick="teamChairSet(\'aggregate\')">Whole organisation</button>';
  h+='<button class="cd-tg'+(teamChairView==='byarea'?' on':'')+'" onclick="teamChairSet(\'byarea\')">By area</button>';
  h+='</div>';
  h+='<button class="cd-print" onclick="teamPrintDash()">Print / Export PDF</button>';
  h+='</div>';

  // ── title block ──
  h+='<div class="cd-page">';
  h+='<div class="cd-titlebar"><div><div class="cd-brand">Roberto\'s DIFC</div><div class="cd-title">Team Health Report</div><div class="cd-sub">'+TEAM_ROUND.label+' · Confidential · Anonymous aggregate</div></div>';
  h+='<div class="cd-resp"><div class="cd-resp-pct">'+st.pct+'%</div><div class="cd-resp-lbl">'+st.responded+' of '+st.total+' responded</div></div></div>';

  if(lowSample){
    h+='<div class="cd-warn no-print">⚠ Only '+st.pct+'% of the team has responded. This report is not yet representative — wait for fuller completion before presenting to the chairman.</div>';
  }

  if(!st.responded){ h+='<div class="team-empty">No responses yet.</div></div></div>'; return h; }

  if(teamChairView==='aggregate'){
    // ── headline donuts ──
    h+='<div class="cd-section-title">Organisation health</div>';
    h+='<div class="cd-donuts">';
    h+=teamDonut(st.avg.reliability,'Reliability');
    h+=teamDonut(st.avg.integrity,'Integrity');
    h+=teamDonut(st.avg.loyalty,'Loyalty');
    h+=teamDonut(st.avg.engagement,'Engagement');
    h+='</div>';
    h+='<div class="cd-overall">Overall team health: <b>'+(st.overall===null?'–':st.overall)+'/100</b></div>';

    // ── stability / risk band ──
    h+='<div class="cd-section-title">Stability &amp; risk</div>';
    h+='<div class="cd-stats">';
    h+='<div class="cd-stat good"><div class="cd-stat-num">'+st.loyal+'</div><div class="cd-stat-lbl">Want to stay &amp; build</div></div>';
    h+='<div class="cd-stat good"><div class="cd-stat-num">'+st.engagedHi+'</div><div class="cd-stat-lbl">Highly engaged</div></div>';
    h+='<div class="cd-stat '+(st.flightStrong?'bad':'mid')+'"><div class="cd-stat-num">'+st.flightStrong+'</div><div class="cd-stat-lbl">Strong flight-risk signals</div></div>';
    h+='<div class="cd-stat '+(st.burnout?'bad':'mid')+'"><div class="cd-stat-num">'+st.burnout+'</div><div class="cd-stat-lbl">Burnout signals</div></div>';
    h+='</div>';

    // ── top themes ──
    if(st.themes.length){
      h+='<div class="cd-section-title">What the team finds hardest</div>';
      var maxn=st.themes[0].n;
      h+=teamBarChart(st.themes.slice(0,6).map(function(t){return {label:t.t, v:t.n, color:'#7a1218'};}), maxn);
      h+='<div class="cd-note">Number of people citing each issue. Higher = more widely felt.</div>';
    }

  } else {
    // ── BY AREA ──
    h+='<div class="cd-section-title">Health by area</div>';
    h+='<div class="cd-area-grid"><div class="cd-area-head"><span>Area</span><span>Team</span><span>Reliability</span><span>Integrity</span><span>Loyalty</span><span>Engagement</span></div>';
    st.sections.forEach(function(s){
      h+='<div class="cd-area-row"><span class="cd-area-name">'+s.label+'</span><span class="cd-area-n">'+s.n+'</span>';
      ['reliability','integrity','loyalty','engagement'].forEach(function(d){
        h+='<span class="cd-area-cell"><span class="cd-pill" style="background:'+teamColorFor(s[d])+'">'+(s[d]===null?'–':s[d])+'</span></span>';
      });
      h+='</div>';
    });
    h+='</div>';
    h+='<div class="cd-note">Each cell is the area average (0–100). Green ≥70, amber 50–69, red &lt;50.</div>';

    // per-area engagement bar comparison
    h+='<div class="cd-section-title">Engagement across areas</div>';
    h+=teamBarChart(st.sections.map(function(s){return {label:s.label, v:s.engagement};}));
  }

  // ── what's being done (framing for chairman) ──
  h+='<div class="cd-section-title">What this tells us</div>';
  h+='<div class="cd-narr" id="cd-narr">'+teamChairNarrative(st)+'</div>';

  // ── AI executive summary (draft → approve → save) ──
  h+='<div class="cd-section-title">Executive summary</div>';
  if(teamSummaryDraft){
    // pending review
    h+='<div class="cd-sum-draft no-print"><div class="cd-sum-draftlabel">DRAFT — review before saving</div>';
    h+='<div class="cd-sum-body">'+teamAiFormat(teamSummaryDraft)+'</div>';
    h+='<div class="cd-sum-actions"><button class="cd-sum-approve" onclick="teamApproveSummary()">Approve &amp; save to Dashboard</button>';
    h+='<button class="cd-sum-regen" onclick="teamGenerateSummary()">Redraft</button>';
    h+='<button class="cd-sum-discard" onclick="teamDiscardSummary()">Discard</button></div></div>';
  } else if(teamSummary){
    // approved summary (shows in print)
    h+='<div class="cd-sum-final"><div class="cd-sum-body">'+teamAiFormat(teamSummary)+'</div>';
    h+='<button class="cd-sum-redo no-print" onclick="teamEditSummaryAgain()">Regenerate</button></div>';
  } else {
    h+='<div class="cd-sum-empty no-print"><p>Generate an AI-written executive summary (key findings + recommended actions) based on the survey. You review it before it\u2019s saved here.</p>';
    h+='<button class="cd-sum-btn" id="cd-sum-btn" onclick="teamGenerateSummary()">Generate summary</button></div>';
  }

  h+='<div class="cd-foot">Generated '+teamFmtDate(new Date().toISOString().slice(0,10))+' · Based on a confidential team self-assessment · Individual responses are not disclosed.</div>';
  h+='</div></div>';
  return h;
}

function teamChairNarrative(st){
  // plain, factual board-level summary built from the numbers
  var parts=[];
  var strongest=null, weakest=null;
  ['reliability','integrity','loyalty','engagement'].forEach(function(d){
    var v=st.avg[d]; if(v===null)return;
    if(strongest===null||v>st.avg[strongest])strongest=d;
    if(weakest===null||v<st.avg[weakest])weakest=d;
  });
  var nm={reliability:'reliability',integrity:'integrity',loyalty:'loyalty',engagement:'engagement'};
  if(strongest)parts.push('The team\u2019s strongest dimension is '+nm[strongest]+' ('+st.avg[strongest]+'/100).');
  if(weakest&&weakest!==strongest)parts.push('The area needing most attention is '+nm[weakest]+' ('+st.avg[weakest]+'/100).');
  if(st.loyal)parts.push(st.loyal+' team member'+(st.loyal>1?'s':'')+' clearly want'+(st.loyal>1?'':'s')+' to stay and grow here.');
  if(st.flightStrong)parts.push(st.flightStrong+' show'+(st.flightStrong>1?'':'s')+' strong signs of looking elsewhere — worth proactive retention conversations.');
  if(st.burnout)parts.push(st.burnout+' show signs of fatigue or burnout.');
  if(st.themes.length)parts.push('The most widely felt frustration is \u201c'+st.themes[0].t+'\u201d.');
  return parts.map(function(p){return '<div class="cd-narr-line">\u2022 '+p+'</div>';}).join('');
}

function teamChairSet(v){ teamChairView=v; teamRender(); }
function openTeamChairman(){ teamMode='chairman'; teamRender(); }
// Print the chairman dashboard only: tag the body so the team print rules apply
// (not the schedule print rules), then clean up after printing.
function teamPrintDash(){ document.body.classList.add('pmode-team'); window.print(); }
window.addEventListener('afterprint', function(){ document.body.classList.remove('pmode-team'); });

// ════════════════════════════════════════════════════════════
//  AI SUMMARY → DASHBOARD (draft → approve → save)
// ════════════════════════════════════════════════════════════
var teamSummary = null;        // approved summary text (loaded from storage)
var teamSummaryDraft = null;   // pending draft awaiting approval
var teamSummaryBusy = false;

async function teamLoadSummary(){
  try {
    var res = await sb.from('team_survey_summary').select('*').order('created_at',{ascending:false}).limit(1);
    if(res.data && res.data.length){ teamSummary = res.data[0].summary; }
  } catch(e){ /* table may not exist yet; summary stays null */ }
}

async function teamGenerateSummary(){
  if(teamSummaryBusy) return;
  teamSummaryBusy = true;
  var btn=document.getElementById('cd-sum-btn'); if(btn){btn.disabled=true;btn.textContent='Drafting…';}
  try{
    var sys = teamAiSystemPrompt();
    var ask = 'Write an executive summary of this team survey for a board-level reader (the chairman). '
      + 'Use exactly two sections with these plain headings on their own line: "KEY FINDINGS" and "RECOMMENDED ACTIONS". '
      + 'Under KEY FINDINGS: 3-5 short bullet points (start each with a dash) stating the most important things the data shows about the organisation, in plain language, no names. '
      + 'Under RECOMMENDED ACTIONS: 3-4 short bullet points (start each with a dash) of concrete, prioritised actions. '
      + 'Keep the whole thing tight and confident. No preamble, no markdown symbols other than dashes for bullets.';
    var resp = await fetch(TEAM_AI_PROXY_URL, {
      method:'POST', headers: teamAiProxyHeaders(),
      body: JSON.stringify({ action:'chat', model:'claude-sonnet-4-6', max_tokens:900, system: sys, messages:[{role:'user', content: ask}] })
    });
    var data = await resp.json();
    var text = (data.text||'').trim();
    if(!text && data.error) text='Could not generate: '+data.error;
    teamSummaryDraft = text || 'No summary generated. Try again.';
  }catch(e){ teamSummaryDraft = 'Could not reach the assistant. Try again.'; }
  teamSummaryBusy=false;
  teamRender();
}

async function teamApproveSummary(){
  if(!teamSummaryDraft) return;
  var text = teamSummaryDraft;
  teamSummary = text;
  teamSummaryDraft = null;
  // persist (best-effort; if table missing it still shows this session)
  try{
    await sb.from('team_survey_summary').insert({ summary:text, round:TEAM_ROUND.label, created_at:new Date().toISOString() });
  }catch(e){ /* not fatal */ }
  teamRender();
  teamAiToast('Summary saved to Dashboard');
}
function teamDiscardSummary(){ teamSummaryDraft=null; teamRender(); }
function teamEditSummaryAgain(){ teamSummary=null; teamRender(); }
