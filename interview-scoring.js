// ══════════════════════════════════════════════════════════════════════════
// INTERVIEW SCORING — Commis Open Day, 17 Sep 2026.
//
// Built from Chef Andrea's "Commis Open Day — Live Scoring" draft: the same
// ten interview questions, the same five practical lines, the same 40/60
// weighting, the same Score / Leaderboard tabs. What changed is where the
// numbers live: in the Kitchen database, so the four chefs interviewing see
// one board on four phones and on the kitchen screen.
//
// Candidate names, scores and notes are personal data and the kitchen app has
// no logins, so nothing here touches a table. The anon key cannot read
// interview_candidates at all; every read and write is an RPC that checks the
// interviewers' passcode inside the database (interview-scoring-schema.sql).
//
// Live: a light poll every 4s while the screen is open. Scores are merged key
// by key in the database, so two chefs scoring the same candidate at the same
// time cannot wipe each other's questions.
//
// A candidate gets a final score and a verdict only when all 15 lines are
// scored. Until then the board says "In progress" and shows how many are
// left — a half-scored candidate never ranks above a finished one.
//
// CVs (16 Sep 2026): Word, PDF or a photo of a paper CV, per candidate, stored
// in the database behind the same passcode and opened IN the app — PDF drawn
// page by page with the app's own pdf.js (an iPhone iframe shows page 1 only),
// .docx turned into readable text by mammoth. An old .doc cannot be read in a
// browser, so it says so and offers the download instead of a blank panel.
//
// Candidate details (16 Sep 2026, Chef Andrea via "Tell us"): salary
// expectation, position applied for, notice period, visa status. Kept as the
// words the interviewer typed — "4,500 + accommodation" or "1 month" — so the
// app never turns 4.500 into 4.5. Each field saves on its own, like the name.
//
// Bulk CVs + search (16 Sep 2026, Chef Andrea via Tell us): "add in bulk all
// the cv saved in a folder" and "a window where we can search the candidate".
// The bulk window takes a whole folder (or many files, or a drag-and-drop),
// reads each candidate's name off the CV's first page (biggest name-shaped
// line of a PDF, first name-shaped line of a .docx, else the file name) and
// shows every name for the chef to correct BEFORE anything is written. A CV
// already on the board (same file name and size) is skipped, and a name that
// matches an existing candidate gets the CV attached instead of a duplicate —
// so running the same folder twice adds nothing.
//
// Candidate emails (17 Sep 2026, Francesco): the candidate's email is read off
// the CV next to the name, for the chef to check. Three buttons — Reject,
// Shortlist, Send to HR for hiring — each open a window: check name / email /
// position, then a preview of exactly what will go (recipients, CC, Reply-To,
// subject, body, attachments), then Confirm & Send. The wording, the HR list
// and the CC addresses live in the interview-email edge function, NOT here: the
// preview shown is that function's own answer, and a CV can only ever go to the
// addresses written there. Every send is a row in interview_actions, shown on
// the candidate's sheet, and a repeat of the same action has to be ticked.
//
// The hiring form HR receives is the Candidate Evaluation Form, and the chef fills
// it HERE (17 Sep 2026, Francesco: "cannot go to HR empty") — interviewers, Hired or
// On Hold, department, the eleven ratings, the overall rating, comments. Nothing is
// uploaded. The function writes those answers into the restaurant's own Word form
// and refuses until every rating is in; the preview hands the finished file back so
// the chef can open exactly what HR will get.
//
// A permanent tool (18 Sep 2026, Francesco): hiring ROUNDS instead of one hardwired
// event (a round = position + dates + a question set, chosen on entry; closed rounds
// stay readable); the question sets live in the database and a set used by a scored
// round is frozen; the interviewer picks their NAME on unlock and every score, email
// and new candidate carries it; a candidate's STAGE is worked out from what already
// happened (scores + the email log), never typed; the same email seen in another
// round shows its history; the HR / CC / Reply-To lists and the interviewer names
// are edited in Set-up, not in code (own domains only — the database refuses the
// rest); an Emails tab lists everything sent this round.
//
// Folders (18 Sep 2026, Francesco): inside a round, candidates go in a folder the
// chef names when adding CVs — "Monday 21st interview" — so a day's candidates sit
// together. A folder is the old `wave` column with a typed name instead of Wave 1–4.
// Tap a folder chip above the list to see only it; the search finds it by name.
//
// CV database + archive (22 Sep 2026, Chef Andrea via Tell us): "a Database where we
// can move all the cv once they are finished" and "an archive where we can keep CV of
// good candidate that we were not able to hire at that moment", each with "a small
// note ... why are kept". A candidate's `shelf` is '' (in the round), 'database'
// (finished) or 'archive' (a future hire — the database refuses it without a note).
// A shelved candidate leaves the round's working list and counters but stays on the
// leaderboard; nothing is deleted, and "Back to the round" undoes it. The CV database
// screen lists every shelved candidate from EVERY round, with their CVs.
//
// No show (22 Sep 2026, Chef Andrea via Tell us): "a voice NO show which will give us
// a red flag in the future if apply again". A candidate who did not turn up is marked
// on their sheet (who and when is kept; Undo clears it). The mark lives on the
// candidate row in the database, so it outlives the round: whenever someone with the
// same email, or the same full name, is on any board later, their row carries a red
// flag and their sheet says where and when they did not show. Same email is a match;
// same name is said as "same name" so the chef checks it is the same person.
//
// Reuses app.js globals: sb, hideAllPages(), kToast(), activeStation, lazyLoad(),
// SUPABASE_URL, SUPABASE_KEY.
// ══════════════════════════════════════════════════════════════════════════

var IVS_KEY   = '__interviews__';
var IVS_EVENT = '';                 // the chosen round's key — set by ivsRoundUse()
var IVS_CODE_STORE = 'kitchen-interview-code';
var IVS_ME_STORE = 'kitchen-interview-me';
var IVS_ROUND_STORE = 'kitchen-interview-round';

// the built-in commis set: the fallback when the sets table cannot be read
var IVS_COMMIS_SECTIONS = [
  { title:'Interview — behavioural', part:'int', items:[
    ['B1','Tell me about a time you made a mistake during a shift.','Ownership without excuses; corrects and learns from it.'],
    ['B2','Describe coping with a genuinely busy, high-pressure service.','Stays organized, prioritizes, doesn\'t panic or blame others.'],
    ['B3','How do you react when a senior chef corrects you sharply?','Takes feedback professionally, respects kitchen hierarchy.'],
    ['B4','Tell me about supporting a struggling teammate during service.','Team-first instinct, notices and helps, puts service ahead of ego.'],
    ['B5','Why Roberto\'s, and where in a year?','Genuine motivation; some awareness of Roberto\'s modern-Italian identity.']
  ]},
  { title:'Interview — technical', part:'int', items:[
    ['T1','Basic knife cuts (brunoise/julienne/chiffonade) and knife care.','Correct technique, mentions sharpening, safe handling.'],
    ['T2','Cooking methods and when to use each.','Matches method to ingredient/cut, not just definitions.'],
    ['T3','Key food safety points (temps, cross-contamination, allergens, FIFO).','Concrete habits, not vague "I\'m careful."'],
    ['T4','How they set up and organize mise en place.','Systematic, anticipates service flow, station stays stocked.'],
    ['T5','What is \'al dente\' and pasta/sauce finishing pitfalls.','Timing/texture, tasting as verification — Italian fundamentals.']
  ]},
  { title:'Practical demonstration', part:'prac', items:[
    ['P1','Knife skills & precision','Cut uniformity, correct grip/technique, safe handling.'],
    ['P2','Speed & time management','Finishes within 10 minutes, sensible order of operations.'],
    ['P3','Organization & cleanliness','Mise en place discipline, tidy while working, waste controlled.'],
    ['P4','Cooking technique & doneness','Heat control, correct doneness, seasoning judged & tasted.'],
    ['P5','Taste, presentation & plating','Balanced flavour, clean simple plating.']
  ]}
];
// [column, label, placeholder, suggestions — tap one or type anything]
var IVS_DETAILS = [
  ['email',              'Email', 'Read from the CV — or type it', []],
  ['position_applied',   'Position applied / expected', 'e.g. Commis II',
    ['Commis III','Commis II','Commis I','Demi Chef de Partie','Chef de Partie']],
  ['salary_expectation', 'Salary expectation', 'e.g. AED 4,500 / month + accommodation', []],
  ['notice_period',      'Notice period', 'e.g. 1 month',
    ['Immediate','1 week','2 weeks','1 month','2 months','3 months']],
  ['visa_status',        'Visa status', 'e.g. Visit visa',
    ['Visit visa','Employment visa — current employer','Cancelled visa / grace period','Family / spouse visa','Own visa (freelance / golden)','Outside the UAE']]
];
var ivsFolderQ = '';      // the folder chip tapped above the list ('' = all, IVS_NOFOLDER = the ones with none)
var IVS_NOFOLDER = '__none__';
var ivsStageQ = '';       // the counter tapped in the header ('' = every stage)
var ivsAddOpen = false;   // the "+ Add" menu
var ivsRen = null;        // { old, val } while a folder is being renamed

// the app's own "are you sure?" — never the browser's grey pop-up. Resolves true / false.
function ivsAsk(o){
  return new Promise(function(done){
    var old = document.getElementById('ivs-ask'); if (old) old.remove();
    var w = document.createElement('div'); w.id = 'ivs-ask';
    w.innerHTML = '<div class="ivask" role="alertdialog" aria-modal="true" aria-labelledby="ivs-ask-t">'+
      '<h4 id="ivs-ask-t">'+ivsEsc(o.title)+'</h4>'+(o.body ? '<p>'+ivsEsc(o.body)+'</p>' : '')+
      '<div class="ivaskb"><button type="button" class="ivb2" data-a="0">'+ivsEsc(o.cancel || 'Cancel')+'</button>'+
      '<button type="button" class="ivb'+(o.danger ? ' danger' : '')+'" data-a="1">'+ivsEsc(o.ok || 'OK')+'</button></div></div>';
    var close = function(v){ document.removeEventListener('keydown', key, true); w.remove(); done(v); };
    var key = function(e){ if (e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); close(false); } };
    w.addEventListener('click', function(e){
      var b = e.target.closest && e.target.closest('button[data-a]');
      if (b) close(b.getAttribute('data-a') === '1'); else if (e.target === w) close(false);
    });
    document.addEventListener('keydown', key, true);
    document.body.appendChild(w);
    // a destructive ask starts on Cancel, so a stray Enter never deletes anything
    var first = w.querySelector('button[data-a="' + (o.danger ? '0' : '1') + '"]'); if (first) first.focus();
  });
}
var ivsWaveT = null;      // debounce for the folder box on the sheet
var IVS_SECTIONS = IVS_COMMIS_SECTIONS;   // the current round's questions (ivsRoundUse)
var IVS_WEIGHTS = { int: 40, prac: 60 };
var IVS_LINES = 15;
var ivsMe = '';            // the interviewer's name picked on unlock
var ivsRounds = [];        // every round, open first
var ivsRound = null;       // the round on screen
var ivsSets = [];          // question sets from the database
var ivsSettings = null;    // interviewers + recipient lists
var ivsScreen = 'main';    // main | name | rounds | shelf
var ivsHist = {};          // email -> rows from other rounds (or 'loading')
var ivsHistT = null;
var ivsSetEdit = null;     // the question-set editor's state while open
var ivsRoundNew = null;    // the new-round form's state while open
var ivsShelved = [];       // this round's candidates already moved to the CV database / archive
var ivsShelfRows = null;   // the CV database screen: every shelved candidate of every round (null = not loaded)
var ivsShelfQ = '';        // its search
var ivsShelfTab = 'archive';   // archive | database | all
var ivsShelfEdit = null;   // { id, to, note } while a note is being written (sheet or database screen)
var IVS_SHELVES = { database: 'CV database', archive: 'Archive — future hire' };
var IVS_STAGES = [['new','New'],['scoring','Being scored'],['decide','To decide'],['shortlist','Shortlisted'],['hr','Sent to HR'],['future','Kept for the future'],['reject','Rejected'],['noshow','No show']];
var ivsNoShows = [];       // every candidate marked no-show, in ANY round — the red flag on a re-application

var ivsCode  = null;
var ivsRows  = [];
var ivsSel   = null;
var ivsTab   = 'score';   // score | board | emails | setup
var ivsErr   = '';
var ivsTimer = null;
var ivsPending = {};      // id -> number of saves in flight (the poll leaves those rows alone)
var ivsNameT = null, ivsNotesT = null;
var ivsDetT = {};          // column -> debounce timer for a detail field not sent yet
function ivsDetTyping(){ for (var k in ivsDetT) if (ivsDetT[k]) return true; return false; }
var ivsCvs = [];          // CV metadata for this event (never the file bytes)
var ivsCvBusy = null;     // candidate id with an upload in flight
var IVS_CV_MAX = 8 * 1024 * 1024;
var ivsQ = '';            // candidate search, kept across re-renders
var ivsBulk = null;       // the bulk-CV window's state while it is open
var IVS_MAMMOTH = 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js';
var IVS_OCR = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';     // only for a scanned CV
var IVS_OCR_LANG = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int';
var ivsActs = [];         // the email log for this event: one row per Reject / Shortlist / HR attempt
var ivsMail = null;       // the email window's state while it is open
var ivsMailRead = {};     // candidate id -> the email on the sheet came off the CV and nobody has typed over it
var ivsMailScan = {};     // candidate id -> { mail, img } read off a scanned CV: shown with its picture, saved only on a tap
var ivsMailTried = {};    // candidate id -> the stored CV was already searched for an email this session
var ivsStatusAt = 0;
var IVS_FN = '/functions/v1/interview-email';
// the Candidate Evaluation Form, row by row, in the form's own words
var IVS_EV_ROWS = [
  ['r1',  '1. Job knowledge', 'Knowledge and skills related to the area of work'],
  ['r2',  '2. Qualification and experience', 'Relevance of experience and educational attainment to the area of work'],
  ['r3',  '3. Employment achievement', 'Demonstrated achievements in previous assignments held'],
  ['r4',  '4. Intelligence', 'Analytical ability, mental alertness and general awareness'],
  ['r5',  '5. Persuasiveness', 'Determination and ability to influence others, ability to get things done'],
  ['r6',  '6. Communication', 'Clarity and expression of ideas in a fluent manner'],
  ['r7',  '7. Interpersonal', 'Good working relationships with colleagues, supervisors and customers; handles feedback or criticism'],
  ['r8',  '8. Teamwork', 'Cooperative and supportive in a team environment'],
  ['r9',  '9. Motivation and resilience', 'Energy, drive and motivation; handles pressure'],
  ['r10', '10. Personality and character', 'Dress, impact and general impression; good attitude towards work'],
  ['r11', '11. Management & leadership', 'Management-level candidates only: strategy, people management, delegation, conflict and decisions, business acumen']
];
var IVS_EV_RATES = [['E','Excellent'],['G','Good'],['A','Average'],['P','Poor']];
var ivsEvT = null;        // debounce for the form's typed fields
var IVS_ACTIONS = {
  reject:    { btn:'Reject',                 done:'Rejected',    title:'Reject — email the candidate' },
  shortlist: { btn:'Shortlist',              done:'Shortlisted', title:'Shortlist — email the candidate' },
  future:    { btn:'Keep for the future',    done:'Kept for the future', title:'Keep for the future — email the candidate' },
  hr:        { btn:'Send to HR for hiring',  done:'Sent to HR',  title:'Send to HR for hiring' }
};

function ivsEsc(s){ return String(s==null?'':s)
  .replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

// ── the arithmetic, in one place ──
// A line marked N/A (stored as 0) counts as answered but is left out of the
// average: its 5 points leave the max, so the candidate is judged only on the
// lines they could actually be tested on.
function ivsCalc(r){
  var sc = (r && r.scores) || {}, i = 0, p = 0, n = 0, iMax = 0, pMax = 0, na = 0, iAll = 0, pAll = 0;
  IVS_SECTIONS.forEach(function(s){ s.items.forEach(function(it){
    var raw = sc[it[0]], v = +raw;
    if (s.part === 'int') iAll++; else pAll++;
    if (raw != null && v === 0){ n++; na++; return; }
    if (s.part === 'int') iMax += 5; else pMax += 5;
    if (v >= 1 && v <= 5){ n++; if (s.part === 'int') i += v; else p += v; }
  }); });
  // a part with no rated lines (none in the set, or all N/A) carries no weight — the other takes it all
  var wI = iMax ? IVS_WEIGHTS.int : 0, wP = pMax ? IVS_WEIGHTS.prac : 0, wT = wI + wP;
  var done = n === IVS_LINES && n > 0 && wT > 0;
  var fin = done ? Math.round(((iMax ? (i/iMax)*wI : 0) + (pMax ? (p/pMax)*wP : 0)) * 100 / wT) : null;
  return { int:i, prac:p, iMax:iMax, pMax:pMax, iAll:iAll, pAll:pAll, na:na, scored:n, done:done, final:fin, verdict: done ? ivsVerdict(fin) : null };
}
// Send to HR needs the whole score sheet: every line 1-5 or N/A, and at least one line really scored
function ivsHrBlock(r){
  var c = ivsCalc(r); if (c.done) return '';
  var left = IVS_LINES - c.scored;
  if (left > 0) return 'Finish the score sheet first — ' + left + ' of ' + IVS_LINES + ' line' + (IVS_LINES === 1 ? '' : 's') + ' still to score. Tap N/A on a line that could not be tested.';
  return 'Every line is N/A, so there is no score to send. Score at least one line first.';
}
function ivsPart(got, max, all){ return max ? got+'/'+max : (all ? 'N/A' : '—'); }
// the same arithmetic for a candidate of another round (history)
function ivsCalcWith(r, set){
  var keepS = IVS_SECTIONS, keepW = IVS_WEIGHTS, keepL = IVS_LINES;
  ivsUseSet(set); var c = ivsCalc(r);
  IVS_SECTIONS = keepS; IVS_WEIGHTS = keepW; IVS_LINES = keepL;
  return c;
}
function ivsUseSet(set){
  IVS_SECTIONS = (set && set.sections) || IVS_COMMIS_SECTIONS;
  IVS_WEIGHTS = (set && set.weights) || { int: 40, prac: 60 };
  IVS_LINES = IVS_SECTIONS.reduce(function(a, s){ return a + s.items.length; }, 0);
}
function ivsSetByKey(k){ return ivsSets.filter(function(x){ return x.key === k; })[0] || null; }
// where a candidate stands, from what has happened — nobody types a status
function ivsStage(r){
  var sent = ivsActsFor(r.id).filter(function(a){ return a.status === 'sent'; });
  if (sent.length){ var last = sent[sent.length - 1].action; return last === 'hr' ? 'hr' : last === 'reject' ? 'reject' : last === 'future' ? 'future' : 'shortlist'; }
  if (r.no_show_at) return 'noshow';
  var c = ivsCalc(r);
  return c.done ? 'decide' : c.scored ? 'scoring' : 'new';
}
function ivsStageWord(k){ return (IVS_STAGES.filter(function(x){ return x[0] === k; })[0] || ['', ''])[1]; }

function ivsVerdict(f){
  if (f >= 80) return { t:'Strong hire', c:'strong', hire:true };
  if (f >= 65) return { t:'Hire',        c:'hire',   hire:true };
  if (f >= 50) return { t:'Maybe',       c:'maybe',  hire:false };
  return            { t:'No hire',      c:'no',     hire:false };
}

// ══════════════════════════════════════════════════════════════════════════
function ivsInjectCss(){
  if (document.getElementById('ivs-css')) return;
  var s = document.createElement('style'); s.id = 'ivs-css';
  s.textContent = [
    '#interviews-view,#ivs-bulk,#ivs-mail,#ivs-ask{--iv:#410207;--ivm:#5e0a10;--ivl:#7a1218;--is:#e1d3c2;--isl:#ede5d8;--isd:#cfc0ad;',
    '  --ik:#2a1a10;--icr:#f5ede0;--igo:#ba9b02;--iol:#4b5128}',
    '.ivwrap{max-width:1440px;margin:0 auto;padding:18px 24px 90px;font-family:"DM Sans",sans-serif;color:var(--ik)}',
    // the terrace by day behind the whole module (the Recipes device: room, vino wash, work on paper).
    // On the view itself, so it goes the moment the view is hidden — nothing to take off.
    '#interviews-view::before,#interviews-view::after{content:"";position:fixed;inset:0;z-index:0;pointer-events:none}',
    '#interviews-view::before{background:#cdbba6 url(venue-terrace-day.jpg) center/cover}',
    '#interviews-view::after{background:linear-gradient(180deg,rgba(43,1,4,.76) 0,rgba(43,1,4,.52) 200px,rgba(43,1,4,.38) 55%,rgba(43,1,4,.62) 100%)}',
    '#interviews-view>*{position:relative;z-index:1}',
    // the heading sits on the room, in cream
    '.ivhd small{color:#f2d3b8!important}',
    '.ivhd h2{color:#fbf3e9!important;text-shadow:0 1px 14px rgba(20,2,4,.45)}',
    '.ivwho{color:rgba(251,243,233,.86)!important}.ivwho b{color:#fbf3e9}.ivwho button{color:#f2d3b8!important}',
    '.ivsync{color:rgba(251,243,233,.82)!important}',
    '.ivwrap>.iverr{background:#fbf3e9;border-radius:6px;padding:9px 12px}',
    // the tabs on a strip of the wash, so they read over any part of the photo
    '.ivtabs{background:rgba(43,1,4,.58);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);border-bottom:0!important;border-radius:10px;padding:0 16px}',
    '.ivtabn{color:rgba(251,243,233,.78)!important}.ivtabn:hover{color:#fbf3e9!important}',
    '.ivtabn.on{color:#fbf3e9!important;border-bottom-color:#f2d3b8!important}',
    '.ivlock{color:#f2d3b8!important}',
    // everything that is work goes on cream paper
    '.ivcard,.ivgate,.ivround,.ivtab{background:#faf4ea!important;border:0!important;box-shadow:0 18px 40px -22px rgba(20,4,4,.8),0 1px 0 rgba(255,255,255,.5) inset}',
    '.ivcard{border-radius:10px!important}.ivgate{border-radius:10px}.ivround{border-radius:8px}',
    '.ivround.closed{background:#ece2d3!important}',
    '.ivcand{background:#fff}',
    '.ivstat{background:rgba(250,244,234,.96)!important;border-color:transparent!important;box-shadow:0 10px 24px -16px rgba(20,4,4,.8)}',
    '.ivstat.on{background:var(--iv)!important;box-shadow:0 0 0 2px #f2d3b8}',
    '.ivovb{background:#fff;border-color:#eadfce!important}',
    // folder rename, in place
    '.ivren{background:#fff;border:1px solid var(--isd);border-radius:8px;padding:10px 12px;margin-top:10px}',
    '.ivren label{display:block;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--ivl);font-weight:700;margin-bottom:6px}',
    '.ivren .r{display:flex;gap:6px}.ivren input{flex:1 1 auto;min-width:0;font-family:"DM Sans",sans-serif;font-size:16px;min-height:46px;border:1px solid var(--iv);border-radius:4px;padding:0 10px;color:var(--ik)}',
    '.ivren .ivb,.ivren .ivb2{padding:0 14px}',
    '.ivren small{display:block;font-size:12.5px;color:#5a4a3a;margin-top:6px}',
    // the confirm
    '#ivs-ask{position:fixed;inset:0;z-index:9500;background:rgba(30,6,8,.55);display:flex;align-items:center;justify-content:center;padding:16px;font-family:"DM Sans",sans-serif}',
    '.ivask{background:#faf4ea;border-radius:12px;max-width:420px;width:100%;padding:22px 22px 18px;box-shadow:0 24px 60px -20px rgba(20,4,4,.9);color:var(--ik)}',
    '.ivask h4{font-family:"Cormorant Garamond",Georgia,serif;font-size:25px;font-weight:600;color:var(--iv);margin:0 0 8px;line-height:1.15}',
    '.ivask p{font-size:15px;line-height:1.45;color:#4a3a2a;margin:0 0 16px}',
    '.ivaskb{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}.ivaskb button{min-width:110px}',
    '.ivb.danger{background:#8c1a14;border-color:#8c1a14}.ivb.danger:hover{background:#6e120d}',
    '.ivhd{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;justify-content:space-between;margin-bottom:12px}',
    '.ivhd small{display:block;font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--ivl);font-weight:700}',
    '.ivhd h2{font-family:"Cormorant Garamond",Georgia,serif;font-size:30px;margin:2px 0 0;font-weight:600;color:var(--iv);line-height:1.1}',
    '.ivstats{display:flex;gap:8px}',
    '.ivstat{background:#fff;border:1px solid var(--isd);border-radius:8px;padding:9px 14px;min-width:104px;text-align:center;cursor:pointer;font-family:"DM Sans",sans-serif}',
    '.ivstat:hover{border-color:var(--iv)}',
    '.ivstat.on{background:var(--iv);border-color:var(--iv)}.ivstat.on b,.ivstat.on span{color:#fff}',
    '.ivstat:focus-visible,.ivtabn:focus-visible,.ivcand:focus-visible,.ivchips button:focus-visible,.ivmini:focus-visible{outline:3px solid var(--igo);outline-offset:2px}',
    '.ivstat b{display:block;font-family:"DM Sans",sans-serif;font-variant-numeric:lining-nums tabular-nums;font-weight:600;font-size:22px;color:var(--iv);line-height:1}',
    '.ivstat span{display:block;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--ivl);font-weight:700;margin-top:3px}',
    '.ivtabs{display:flex;gap:26px;margin-bottom:16px;align-items:center;border-bottom:1px solid var(--isd);overflow-x:auto;overflow-y:hidden}',
    '.ivtabn{background:none;border:0;border-bottom:3px solid transparent;margin-bottom:-1px;padding:12px 2px;min-height:46px;font-family:"DM Sans",sans-serif;font-size:15.5px;font-weight:600;color:#5a4a3a;white-space:nowrap;cursor:pointer}',
    '.ivtabn:hover{color:var(--ik)}.ivtabn.on{color:var(--iv);border-bottom-color:var(--iv)}',
    '.ivb{font-family:"DM Sans",sans-serif;font-size:14px;font-weight:600;background:var(--iv);color:var(--icr);',
    '  border:1px solid var(--iv);border-radius:4px;padding:0 18px;min-height:46px;cursor:pointer}',
    '.ivb:hover{background:var(--ivm)}',
    '.ivb2{font-family:"DM Sans",sans-serif;font-size:14px;font-weight:600;background:#fff;color:var(--iv);',
    '  border:1px solid var(--isd);border-radius:4px;padding:0 16px;min-height:46px;cursor:pointer}',
    '.ivb2.on{background:var(--iv);color:var(--icr);border-color:var(--iv)}',
    '.ivb:focus-visible,.ivb2:focus-visible,.ivs button:focus-visible{outline:3px solid var(--igo);outline-offset:2px}',
    '.ivlock{margin-left:auto;background:none;border:0;color:var(--iv);font-family:"DM Sans",sans-serif;font-size:14px;font-weight:600;cursor:pointer;min-height:44px;display:flex;align-items:center;gap:6px;white-space:nowrap}',
    '.ivgrid{display:grid;grid-template-columns:minmax(290px,370px) minmax(0,1fr);gap:18px;align-items:start}',
    '.ivside{box-sizing:border-box;position:sticky;top:calc(var(--ivhd,0px) + 12px);max-height:calc(100vh - var(--ivhd,0px) - 24px);display:flex;flex-direction:column;padding:14px}',
    '.ivside #ivs-list{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}',
    '.ivlrows{flex:1 1 auto;min-height:0;overflow-y:auto;padding-right:4px}',
    '#ivs-editor{padding:20px 24px}',
    '.ivbar1{display:flex;gap:8px}.ivbar1 .ivfind{flex:1 1 auto;margin-top:0}',
    '.ivaddw{position:relative;flex:0 0 auto}.ivaddw .ivb{padding:0 16px;font-size:15px;font-weight:700}',
    '.ivaddm{position:absolute;right:0;top:52px;z-index:20;background:#fff;border:1px solid var(--isd);border-radius:8px;box-shadow:0 8px 24px rgba(65,2,7,.16);padding:6px;display:flex;flex-direction:column;width:210px}',
    '.ivaddm[hidden]{display:none}',
    '.ivaddm button{background:none;border:0;text-align:left;padding:0 12px;min-height:46px;border-radius:5px;font-family:"DM Sans",sans-serif;font-size:15px;color:var(--ik);cursor:pointer}',
    '.ivaddm button:hover{background:var(--isl)}',
    '.ivdot.s-new{background:#b5a591}.ivdot.s-scoring{background:#c99a1e}.ivdot.s-decide{background:#a3261c}.ivdot.s-shortlist{background:#3e6b24}.ivdot.s-hr{background:var(--iv)}.ivdot.s-reject{background:#7a6a5a}.ivdot.s-future{background:#2f5d73}.ivdot.s-noshow{background:#1f1a17}',
    '.ivspill{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;border-radius:20px;padding:5px 11px;white-space:nowrap;background:#efe7dc;color:#4a3a2a}',
    '.ivspill.s-scoring{background:#f6e7b8;color:#4f3b00}.ivspill.s-decide{background:#f5dcd5;color:#6a1410}.ivspill.s-shortlist{background:#dce8cf;color:#2f4a1e}.ivspill.s-hr{background:var(--iv);color:#fff}.ivspill.s-reject{background:#e4dcd2;color:#3a2e24}.ivspill.s-future{background:#d6e6ee;color:#173848}.ivspill.s-noshow{background:#2a2320;color:#fff}',
    '.ivselbar{display:flex;align-items:center;gap:10px;margin:0 0 8px}',
    '.ivback{order:3;margin-left:auto;background:none;border:0;padding:0;min-height:40px;color:var(--iv);font-family:"DM Sans",sans-serif;font-size:14px;font-weight:600;text-decoration:underline;cursor:pointer}',
    '.ivback .m{display:none}.ivselsc{display:none}',
    '.ivovh{font-family:"Cormorant Garamond",Georgia,serif;font-size:28px;font-weight:600;color:var(--ik);margin:0 0 14px;line-height:1.15}',
    '.ivov{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px}',
    '.ivovb{border:1px solid var(--is);border-radius:8px;padding:14px 16px;min-width:0}',
    '.ivovb .t{display:flex;justify-content:space-between;align-items:baseline;gap:8px}.ivovb .t b{font-size:15.5px}.ivovb .t span{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums}',
    '.ivovb p{margin:2px 0 6px;font-size:13px;color:#5a4a3a;line-height:1.4}',
    '.ivmini{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:none;border:0;border-top:1px solid var(--isl);padding:8px 2px;min-height:44px;font-family:"DM Sans",sans-serif;font-size:14.5px;color:var(--ik);cursor:pointer}',
    '.ivmini:hover{background:var(--isl)}',
    '.ivmini .g{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ivmini .rk{width:16px;color:#5a4a3a;font-weight:700}',
    '.ivmini b{color:var(--iv);font-variant-numeric:tabular-nums;white-space:nowrap}.ivmini .ivbar{width:70px;margin:0}',
    '.ivovnone{font-size:13.5px;color:#5a4a3a;border-top:1px solid var(--isl);padding:10px 2px}',
    '.ivovall{background:none;border:0;padding:8px 0 0;min-height:36px;color:var(--iv);font-family:"DM Sans",sans-serif;font-size:13.5px;font-weight:600;text-decoration:underline;cursor:pointer}',
    '.ivovnew{margin-top:14px;border:1px dashed var(--isd);border-radius:8px;padding:13px 16px;font-size:14.5px;color:#4a3a2a}',
    '.ivcard{background:#fff;border:1px solid var(--isd);border-radius:6px;padding:12px}',
    '.ivlbl{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--ivl);font-weight:700;margin-bottom:8px}',
    '.ivcand{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:#fff;border:1px solid transparent;',
    '  border-radius:6px;padding:8px 10px;margin-top:2px;min-height:54px;cursor:pointer;font-family:"DM Sans",sans-serif;font-size:14.5px;color:var(--ik)}',
    '.ivcand:hover{background:var(--isl)}',
    '.ivcand.on{background:var(--icr);border-color:var(--iv)}',
    '.ivcand b{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ivcand i{font-style:normal;font-size:14.5px;font-weight:700;color:var(--iv);font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.ivdot{width:9px;height:9px;border-radius:50%;background:var(--isd);flex:0 0 auto}',
    '.ivdot.done{background:var(--iol)}.ivdot.part{background:var(--igo)}',
    '.ivtop{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
    '.ivname{flex:1 1 220px;min-width:0;font-family:"Cormorant Garamond",Georgia,serif;font-size:25px;color:var(--ik);',
    '  border:0;border-bottom:2px solid var(--is);background:none;padding:6px 2px;min-height:46px}',
    '.ivname:focus{outline:none;border-bottom-color:var(--iv)}',
    '.ivdet{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px;margin-top:10px}',
    '.ivdf{display:block;min-width:0}',
    '.ivdf span{display:block;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ivl);font-weight:700;margin-bottom:3px}',
    '.ivdf input{width:100%;box-sizing:border-box;font-family:"DM Sans",sans-serif;font-size:15px;min-height:46px;border:1px solid var(--isd);border-radius:4px;background:var(--isl);padding:0 10px;color:var(--ik)}',
    '.ivdf input:focus{outline:none;border-color:var(--iv);background:#fff}',
    '.ivtab td.ivdc{font-size:13px;max-width:150px;overflow-wrap:anywhere}',
    '.ivsel{font-family:"DM Sans",sans-serif;font-size:15px;min-height:46px;border:1px solid var(--isd);border-radius:4px;background:var(--isl);padding:0 10px;color:var(--ik)}',
    '.ivdel{background:#fff;border:1px solid var(--isd);color:var(--iv);border-radius:4px;min-height:46px;padding:0 14px;font-weight:600;cursor:pointer}',
    '.ivsum{display:flex;flex-wrap:wrap;gap:12px;align-items:center;background:var(--isl);border-radius:6px;padding:12px 14px;margin:12px 0 4px}',
    '.ivsum .big{font-family:"DM Sans",sans-serif;font-variant-numeric:lining-nums tabular-nums;font-size:36px;color:var(--iv);line-height:1;font-weight:600}',
    '.ivsum .big small{font-family:"DM Sans",sans-serif;font-size:13px;color:#6b5a48;font-weight:400}',
    '.ivsum .parts{margin-left:auto;display:flex;gap:18px;text-align:right}',
    '.ivsum .parts b{display:block;font-size:19px;font-variant-numeric:tabular-nums}',
    '.ivsum .parts span{display:block;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#6b5a48}',
    '.ivpill{display:inline-block;font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;border-radius:20px;padding:5px 11px;background:#fff;color:#5a4a3a;border:1px solid var(--isd)}',
    '.ivpill.strong{background:#2f4a1e;color:#fff;border-color:#2f4a1e}',
    '.ivpill.hire{background:var(--iol);color:#fff;border-color:var(--iol)}',
    '.ivpill.maybe{background:#8a6d00;color:#fff;border-color:#8a6d00}',
    '.ivpill.no{background:var(--iv);color:#fff;border-color:var(--iv)}',
    '.ivsec{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--ivl);font-weight:700;padding:18px 0 4px;border-top:1px solid var(--isl);margin-top:10px}',
    '.ivq{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;padding:10px 0;border-bottom:1px dashed var(--isd)}',
    '.ivq .t{flex:1 1 260px;min-width:0}',
    '.ivq .t b{display:block;font-size:14.5px;font-weight:600;line-height:1.35}',
    '.ivq .t span{display:block;font-size:12.5px;color:#6b5a48;margin-top:2px;line-height:1.4}',
    '.ivs{display:flex;gap:6px;flex:0 0 auto}',
    '.ivs button{width:46px;height:46px;border:1px solid var(--isd);background:#fff;border-radius:5px;font-size:16px;font-weight:600;color:var(--ik);cursor:pointer;font-family:"DM Sans",sans-serif}',
    '.ivs button.on{background:var(--iv);color:#fff;border-color:var(--iv)}',
    '.ivs button.na{width:54px;font-size:13.5px;font-weight:700;letter-spacing:.02em;border-style:dashed;border-color:#8a7a68;color:#4a3a2a}',
    '.ivs button.na.on{background:#4a3a2a;color:#fff;border-style:solid;border-color:#4a3a2a}',
    '.ivnotes{width:100%;box-sizing:border-box;min-height:90px;font-family:"DM Sans",sans-serif;font-size:15px;border:1px solid var(--isd);border-radius:5px;background:var(--isl);padding:10px;color:var(--ik)}',
    '.ivempty{padding:26px 10px;color:#6b5a48;font-size:14px}',
    '.ivgate{max-width:420px;margin:30px auto;background:#fff;border:2px solid var(--iv);border-radius:6px;padding:18px}',
    '.ivgate b{display:block;font-size:16px;margin-bottom:10px}',
    '.ivgate input{font-size:22px;letter-spacing:.3em;text-align:center;width:150px;min-height:48px;border:1px solid var(--isd);border-radius:4px;margin-right:8px}',
    '.iverr{color:var(--iv);font-weight:600;font-size:13.5px;margin-top:10px}',
    '.ivtab{width:100%;border-collapse:collapse;font-size:14px;background:#fff;border:1px solid var(--isd);border-radius:6px;overflow:hidden}',
    '.ivtab th{text-align:left;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--ivl);background:var(--isl);padding:10px}',
    '.ivtab td{padding:11px 10px;border-top:1px solid var(--isl);vertical-align:middle}',
    '.ivtab td.n{font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.ivtab tr{cursor:pointer}',
    '.ivbar{display:inline-block;width:80px;height:6px;background:var(--isl);border-radius:3px;vertical-align:middle;margin-right:8px;overflow:hidden}',
    '.ivbar i{display:block;height:100%;background:var(--iv)}',
    '.ivsync{font-size:11.5px;color:#6b5a48;text-align:right;margin-top:10px}',
    '.ivcvs{background:var(--icr);border:1px solid var(--isd);border-radius:6px;padding:10px 12px;margin:10px 0 2px}',
    '.ivcvs .hd{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
    '.ivcvs .hd b{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--ivl)}',
    '.ivcvup{margin-left:auto;display:inline-flex;align-items:center;font-size:14px;font-weight:600;background:var(--iv);color:var(--icr);border-radius:4px;padding:0 16px;min-height:46px;cursor:pointer}',
    '.ivcvup input{display:none}',
    '.ivcvup.busy{opacity:.6;pointer-events:none}',
    '.ivcvf{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:#fff;border:1px solid var(--isd);border-radius:5px;padding:6px 8px;margin-top:8px}',
    '.ivcvf .nm{flex:1 1 160px;min-width:0;font-size:14px;font-weight:600;overflow-wrap:anywhere}',
    '.ivcvf .nm span{display:block;font-size:11.5px;font-weight:400;color:#6b5a48}',
    '.ivcvf button{min-height:44px;padding:0 14px;border-radius:4px;font-weight:600;cursor:pointer;font-family:"DM Sans",sans-serif;font-size:14px}',
    '.ivcvf .v{background:var(--iv);color:#fff;border:1px solid var(--iv)}',
    '.ivcvf .x{background:#fff;color:var(--iv);border:1px solid var(--isd)}',
    '.ivcvnone{font-size:13px;color:#6b5a48;margin-top:6px}',
    '.ivcand .cv{font-size:10px;font-weight:700;letter-spacing:.08em;color:var(--iol);border:1px solid var(--iol);border-radius:3px;padding:1px 4px}',
    '#ivs-viewer{position:fixed;inset:0;z-index:9000;background:rgba(20,10,5,.72);display:flex;flex-direction:column}',
    '#ivs-viewer .bar{display:flex;align-items:center;gap:8px;background:#410207;color:#f5ede0;padding:8px 10px;font-family:"DM Sans",sans-serif}',
    '#ivs-viewer .bar b{flex:1;min-width:0;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#ivs-viewer .bar a,#ivs-viewer .bar button{min-height:44px;display:inline-flex;align-items:center;padding:0 14px;border-radius:4px;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none;font-family:"DM Sans",sans-serif}',
    '#ivs-viewer .bar a{background:#f5ede0;color:#410207;border:0}',
    '#ivs-viewer .bar button{background:transparent;color:#f5ede0;border:1px solid rgba(245,237,224,.6)}',
    '#ivs-viewer .body{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;padding:12px}',
    '#ivs-viewer .page{display:block;max-width:900px;width:100%;height:auto;margin:0 auto 12px;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.3)}',
    '#ivs-viewer .doc{max-width:820px;margin:0 auto;background:#fff;padding:22px 20px;border-radius:4px;font-family:"DM Sans",sans-serif;font-size:15px;line-height:1.55;color:#2a1a10;overflow-wrap:anywhere}',
    '#ivs-viewer .doc img{max-width:100%;height:auto}',
    '#ivs-viewer .doc table{border-collapse:collapse;max-width:100%}#ivs-viewer .doc td{border:1px solid #ddd;padding:4px 6px;vertical-align:top}',
    '#ivs-viewer .msg{max-width:520px;margin:40px auto;background:#fff;padding:20px;border-radius:6px;font-family:"DM Sans",sans-serif;font-size:15px;line-height:1.5;color:#2a1a10}',
    '.ivfind{position:relative;margin-top:10px}',
    '.ivfind input{width:100%;box-sizing:border-box;font-family:"DM Sans",sans-serif;font-size:15px;min-height:46px;border:1px solid var(--isd);border-radius:4px;background:var(--isl);padding:0 38px 0 10px;color:var(--ik)}',
    '.ivfind input:focus{outline:3px solid var(--igo);outline-offset:1px;background:#fff}',
    '.ivfind input::-webkit-search-cancel-button{-webkit-appearance:none;display:none}',   // ours is the one clear button
    '.ivfind button{position:absolute;right:2px;top:1px;width:44px;height:44px;border:0;background:none;color:var(--ivl);font-size:20px;cursor:pointer}',
    '.ivfindn{display:flex;align-items:center;gap:12px;font-size:13px;color:#5a4a3a;margin:8px 0 2px;min-height:32px}.ivfindn span{flex:1}',
    '.ivfindn button{background:none;border:0;padding:0;min-height:32px;color:var(--iv);font-family:"DM Sans",sans-serif;font-size:13px;font-weight:600;text-decoration:underline;cursor:pointer;white-space:nowrap}',
    '.ivcand small{display:block;font-size:12.5px;font-weight:400;color:#5a4a3a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}',
    '.ivcand .nmw{flex:1;min-width:0}.ivcand .nmw b{display:block}',
    // the bottom strip stays clear so the "Tell us" pill never sits on the Add button
    '#ivs-bulk{position:fixed;inset:0;z-index:9000;background:rgba(20,10,5,.72);display:flex;flex-direction:column;padding-bottom:56px;box-sizing:border-box}',
    '#ivs-bulk .bar{display:flex;align-items:center;gap:8px;background:#410207;color:#f5ede0;padding:8px 10px;font-family:"DM Sans",sans-serif}',
    '#ivs-bulk .bar b{flex:1;min-width:0;font-size:15px}',
    '#ivs-bulk .bar button{min-height:44px;padding:0 14px;border-radius:4px;font-size:14px;font-weight:600;cursor:pointer;background:transparent;color:#f5ede0;border:1px solid rgba(245,237,224,.6);font-family:"DM Sans",sans-serif}',
    '#ivs-bulk .body{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;padding:12px}',
    '.ivbk{max-width:900px;margin:0 auto;background:#fff;border-radius:6px;padding:16px;font-family:"DM Sans",sans-serif;color:var(--ik)}',
    '.ivdrop{border:2px dashed var(--isd);border-radius:6px;background:var(--isl);padding:26px 14px;text-align:center}',
    '.ivdrop.over{border-color:var(--iv);background:var(--icr)}',
    '.ivdrop p{margin:0 0 14px;font-size:15px;line-height:1.45}',
    '.ivdrop .btns{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}',
    '.ivdrop label{display:inline-flex;align-items:center}.ivdrop input{display:none}',
    '.ivbkhd{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:10px}',
    '.ivbkhd .msg{flex:1 1 240px;font-size:14px;line-height:1.4}',
    '.ivbkr{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;border-top:1px solid var(--isl);padding:9px 0}',
    '.ivbkr .f{flex:1 1 200px;min-width:0;font-size:12.5px;color:#6b5a48;overflow-wrap:anywhere}',
    '.ivbkr input{flex:1 1 220px;min-width:0;font-family:"DM Sans",sans-serif;font-size:15px;min-height:44px;border:1px solid var(--isd);border-radius:4px;padding:0 10px;color:var(--ik);background:#fff}',
    '.ivbkr input:disabled{background:var(--isl);color:#6b5a48}',
    '.ivbkr .st{flex:0 0 auto;font-size:12px;font-weight:700;border-radius:20px;padding:5px 10px;background:var(--isl);color:#5a4a3a;max-width:100%;overflow-wrap:anywhere}',
    '.ivbkr .st.new{background:#e3e7d3;color:#2f4a1e}.ivbkr .st.add{background:#f3e9c4;color:#5c4700}',
    '.ivbkr .st.skip{background:#eee;color:#555}.ivbkr .st.bad{background:#f6dcdc;color:#7a1218}',
    '.ivbkr .st.ok{background:#2f4a1e;color:#fff}.ivbkr .st.run{background:var(--igo);color:#fff}',
    '.ivbkr .out{flex:0 0 auto;min-height:44px;background:#fff;border:1px solid var(--isd);color:var(--iv);border-radius:4px;padding:0 10px;font-weight:600;cursor:pointer;font-family:"DM Sans",sans-serif}',
    '.ivbkft{position:sticky;bottom:-12px;background:#fff;display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-top:2px solid var(--isd);padding:12px 0 4px;margin-top:6px}',
    '.ivbkft .sum{flex:1 1 200px;font-size:13.5px;color:#5a4a3a}',
    '.ivb:disabled{opacity:.5;cursor:default}',
    '.ivdf.wide{grid-column:1/-1}',
    '.ivscan{grid-column:1/-1;background:#fff;border:1px solid var(--isd);border-radius:5px;padding:10px 12px}',
    '.ivscan .t{font-size:13px;color:#4a3a2a}',
    '.ivscan img{display:block;max-width:100%;height:auto;margin:8px 0;border:1px solid var(--isd);border-radius:3px}',
    '.ivscan .row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px}',
    '.ivscan b{flex:1 1 200px;min-width:0;font-size:17px;overflow-wrap:anywhere;color:var(--ik)}',
    '.ivscan button{min-height:44px;padding:0 16px;border-radius:4px;font-weight:600;cursor:pointer;font-family:"DM Sans",sans-serif;font-size:14px;background:var(--iv);color:#fff;border:1px solid var(--iv)}',
    '.ivdf em{display:block;font-style:normal;font-size:12.5px;color:#5a4a3a;margin-top:3px;min-height:16px}',
    '.ivbkr .em{flex:1 1 100%;font-size:12.5px;color:#5a4a3a;overflow-wrap:anywhere}',
    // decision card — the three emails
    '.ivacts{background:#fff;border:1px solid var(--isd);border-radius:6px;padding:10px 12px;margin:10px 0 2px}',
    '.ivacts .hd b{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--ivl)}',
    '.ivacts .btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}',
    '.ivacts .btns button{flex:1 1 150px}',
    '.ivhrno{margin-top:8px;font-size:14px;font-weight:600;line-height:1.4;color:#5e0a10;background:#f6dcdc;border-radius:5px;padding:8px 10px}',
    '.ivactl{font-size:13.5px;line-height:1.45;border-top:1px solid var(--isl);padding:7px 0 0;margin-top:8px;color:var(--ik);overflow-wrap:anywhere}',
    '.ivactl b{font-weight:700}.ivactl.bad{color:#7a1218}.ivactl span{color:#5a4a3a}',
    // the email window
    '#ivs-mail{position:fixed;inset:0;z-index:9000;background:rgba(20,10,5,.72);display:flex;flex-direction:column;padding-bottom:56px;box-sizing:border-box}',
    '#ivs-mail .bar{display:flex;align-items:center;gap:8px;background:#410207;color:#f5ede0;padding:8px 10px;font-family:"DM Sans",sans-serif}',
    '#ivs-mail .bar b{flex:1;min-width:0;font-size:15px}',
    '#ivs-mail .bar button{min-height:44px;padding:0 14px;border-radius:4px;font-size:14px;font-weight:600;cursor:pointer;background:transparent;color:#f5ede0;border:1px solid rgba(245,237,224,.6);font-family:"DM Sans",sans-serif}',
    '#ivs-mail .body{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;padding:12px}',
    '.ivml{max-width:720px;margin:0 auto;background:#fff;border-radius:6px;padding:16px;font-family:"DM Sans",sans-serif;color:var(--ik);font-size:15px}',
    '.ivml h3{font-family:"Cormorant Garamond",Georgia,serif;font-size:24px;font-weight:600;color:var(--iv);margin:0 0 4px}',
    '.ivml .lead{font-size:14px;color:#5a4a3a;margin:0 0 12px;line-height:1.45}',
    '.ivml .ivdf{margin-top:10px}',
    '.ivml .ivdf input.bad{border-color:#7a1218;background:#fbeeee}',
    '.ivmlerr{background:#f6dcdc;color:#5e0a10;border-radius:5px;padding:9px 11px;font-size:14px;font-weight:600;margin-top:10px;line-height:1.4}',
    '.ivmlwarn{background:#f3e9c4;color:#4a3900;border-radius:5px;padding:9px 11px;font-size:14px;margin-top:10px;line-height:1.45}',
    '.ivmlwarn label{display:flex;gap:9px;align-items:center;margin-top:8px;font-weight:700;min-height:44px;cursor:pointer}',
    '.ivmlwarn input{width:22px;height:22px;flex:0 0 auto}',
    '.ivmltest{background:#2f4a1e;color:#fff;border-radius:5px;padding:9px 11px;font-size:14px;font-weight:600;margin-top:10px;line-height:1.4}',
    '.ivmlbox{border:1px solid var(--isd);border-radius:6px;margin-top:10px;overflow:hidden}',
    '.ivmlrow{display:flex;gap:10px;padding:8px 11px;border-top:1px solid var(--isl);font-size:14.5px;line-height:1.4}',
    '.ivmlrow:first-child{border-top:0}',
    '.ivmlrow i{flex:0 0 84px;font-style:normal;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ivl);font-weight:700;padding-top:3px}',
    '.ivmlrow div{flex:1;min-width:0;overflow-wrap:anywhere}',
    '.ivmlrow .none{color:#5a4a3a}',
    '.ivmlbody{white-space:pre-wrap;background:var(--icr);padding:12px;font-size:14.5px;line-height:1.5;border-top:1px solid var(--isd)}',
    '.ivmlfile{display:flex;gap:8px;align-items:center;flex-wrap:wrap;border:1px solid var(--isd);border-radius:5px;padding:8px 10px;margin-top:8px;min-height:46px;box-sizing:border-box}',
    '.ivmlfile input[type=checkbox]{width:22px;height:22px;flex:0 0 auto}',
    '.ivmlfile .nm{flex:1 1 180px;min-width:0;font-weight:600;font-size:14px;overflow-wrap:anywhere}',
    '.ivmlfile .nm span{display:block;font-weight:400;font-size:12px;color:#5a4a3a}',
    '.ivmlfile.need{border-color:#7a1218;border-width:2px}',
    '.ivmlfile.slot{border-style:dashed;background:var(--isl);color:#5a4a3a}',
    '.ivmlfile label.pick{display:inline-flex;align-items:center;min-height:44px;padding:0 14px;border-radius:4px;background:var(--iv);color:var(--icr);font-weight:600;font-size:14px;cursor:pointer}',
    '.ivmlfile label.pick input{display:none}',
    '.ivmlft{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-top:16px}',
    '.ivmlft button{flex:0 1 auto}',
    '.ivev{border:1px solid var(--isd);border-radius:6px;padding:10px 12px;margin-top:8px}',
    '.ivev.need{border-color:#7a1218;border-width:2px}',
    '.ivev .q b{display:block;font-size:14.5px;font-weight:600;line-height:1.35}',
    '.ivev .q span{display:block;font-size:12.5px;color:#5a4a3a;margin-top:2px;line-height:1.4}',
    '.ivevb{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}',
    '.ivevb button{flex:1 1 86px;min-height:46px;border:1px solid var(--isd);background:#fff;border-radius:5px;font-size:14px;font-weight:600;color:var(--ik);cursor:pointer;font-family:"DM Sans",sans-serif;padding:0 6px}',
    '.ivevb button.on{background:var(--iv);color:#fff;border-color:var(--iv)}',
    '.ivevb button:focus-visible{outline:3px solid var(--igo);outline-offset:2px}',
    '.ivevprog{font-size:13px;color:#5a4a3a;margin-top:6px}',
    '.ivml textarea{width:100%;box-sizing:border-box;min-height:84px;font-family:"DM Sans",sans-serif;font-size:15px;border:1px solid var(--isd);border-radius:4px;background:var(--isl);padding:10px;color:var(--ik)}',
    '.ivml textarea:focus{outline:none;border-color:var(--iv);background:#fff}',
    '.ivmlans{display:flex;gap:10px;padding:6px 11px;border-top:1px solid var(--isl);font-size:14px;line-height:1.4}',
    '.ivmlans:first-child{border-top:0}.ivmlans i{flex:1 1 60%;font-style:normal;color:#5a4a3a}.ivmlans b{flex:1 1 40%;font-weight:600;overflow-wrap:anywhere;white-space:pre-wrap}',
    '.ivmldl{display:inline-flex;align-items:center;min-height:46px;padding:0 16px;border-radius:4px;background:#fff;color:var(--iv);border:1px solid var(--iv);font-weight:600;font-size:14px;text-decoration:none;margin-top:8px}',
    '.ivmlsec{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--ivl);font-weight:700;margin-top:16px}',
    '.ivwho{font-size:12.5px;color:#5a4a3a;margin-top:4px}.ivwho button{background:none;border:0;color:var(--ivl);font-weight:700;text-decoration:underline;cursor:pointer;font-family:"DM Sans",sans-serif;font-size:12.5px;min-height:32px;padding:0 4px}',
    '.ivstg{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--ivl);font-weight:700;margin:14px 0 2px;display:flex;justify-content:space-between}',
    '.ivstg:first-child{margin-top:6px}',
    '.ivchips{display:flex;flex-wrap:nowrap;gap:6px;margin-top:10px;overflow-x:auto;padding-bottom:4px;scrollbar-width:thin}',
    '.ivchips button{flex:0 0 auto;min-height:38px;padding:0 13px;border-radius:20px;border:1px solid var(--isd);background:#fff;color:var(--iv);font-size:13.5px;font-weight:600;cursor:pointer;font-family:"DM Sans",sans-serif;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ivchips button.on{background:var(--iv);color:#fff;border-color:var(--iv)}',
    '.ivby{display:inline-block;font-size:11px;color:#5a4a3a;margin-left:6px;font-weight:400}',
    '.ivhist{background:#f3e9c4;color:#4a3900;border-radius:5px;padding:9px 11px;font-size:13.5px;margin-top:10px;line-height:1.45}',
    '.ivhist b{font-weight:700}',
    '.ivflag{background:#fbe3e1;color:#6a0f0c;border:1px solid #c9362b;border-left:6px solid #b3261e;border-radius:5px;padding:10px 12px;font-size:14px;margin-top:10px;line-height:1.45}',
    '.ivflag b{font-weight:700}.ivflag small{display:block;font-size:12.5px;color:#6a0f0c;margin-top:3px}',
    '.ivrf{display:inline-block;background:#b3261e;color:#fff;font-size:11px;font-weight:700;letter-spacing:.04em;border-radius:4px;padding:2px 7px;margin-right:6px;vertical-align:1px;white-space:nowrap}',
    '.ivns{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-top:12px;padding-top:12px;border-top:1px solid var(--is);font-size:14px}',
    '.ivns.on{background:#2a2320;color:#fff;border-radius:6px;padding:10px 12px;border-top:0}',
    '.ivns .ivb2{min-height:44px}',
    '.ivrounds{max-width:720px;margin:0 auto}',
    '.ivshbox{background:#fff;border:1px solid var(--isd);border-radius:6px;padding:10px 12px;margin:10px 0 2px}',
    '.ivshbox .hd b{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--ivl)}',
    '.ivshbox p{font-size:13.5px;line-height:1.45;color:#5a4a3a;margin:6px 0 0}',
    '.ivshbox .btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.ivshbox .btns button{flex:1 1 180px}',
    '.ivshnote{width:100%;box-sizing:border-box;min-height:74px;font-family:"DM Sans",sans-serif;font-size:15px;border:1px solid var(--iv);border-radius:5px;background:#fff;padding:9px 10px;color:var(--ik);margin-top:8px}',
    '.ivshkept{background:#e9efe0;color:#2f4a1e;border-radius:5px;padding:9px 11px;font-size:14px;line-height:1.45;margin-top:8px;white-space:pre-wrap;overflow-wrap:anywhere}',
    '.ivshkept b{font-weight:700}',
    '.ivshline{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;font-size:13px;color:#5a4a3a;padding:6px 0 2px}',
    '.ivshline button{background:none;border:0;padding:0;min-height:36px;color:var(--iv);font-family:"DM Sans",sans-serif;font-size:13.5px;font-weight:600;text-decoration:underline;cursor:pointer}',
    '.ivshc{background:#faf4ea;border-radius:8px;padding:12px 14px;margin-top:10px;box-shadow:0 18px 40px -22px rgba(20,4,4,.8)}',
    '.ivshc .t{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px}.ivshc .t b{font-size:17px;color:var(--iv)}',
    '.ivshc .m{font-size:13px;color:#5a4a3a;margin-top:3px;line-height:1.45;overflow-wrap:anywhere}',
    '.ivshc .btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.ivshc .btns button{flex:0 1 auto;padding:0 14px}',
    '.ivshtabs{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0 8px}',
    '.ivshq{width:100%;box-sizing:border-box;font-family:"DM Sans",sans-serif;font-size:16px;min-height:46px;border:1px solid var(--isd);border-radius:4px;background:#fff;padding:0 12px;color:var(--ik)}',
    '.ivshc .btns .ivdiscard{margin-left:auto;color:#7a1218;border-color:#c9a9a4}',
    '.ivshempty{background:#faf4ea;border-radius:8px;padding:20px 14px;margin-top:10px;color:#5a4a3a;font-size:14px}',
    '.ivround{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:#fff;border:1px solid var(--isd);border-radius:6px;padding:12px 14px;margin-top:8px;min-height:60px;cursor:pointer;font-family:"DM Sans",sans-serif;color:var(--ik)}',
    '.ivround:hover{border-color:var(--iv)}.ivround.closed{background:var(--isl)}',
    '.ivround .t{flex:1;min-width:0}.ivround .t b{display:block;font-size:16px;font-weight:600}.ivround .t span{display:block;font-size:12.5px;color:#5a4a3a;margin-top:2px}',
    '.ivround i{font-style:normal;font-size:12px;font-weight:700;border-radius:20px;padding:5px 10px;background:var(--icr);color:var(--iv);white-space:nowrap}',
    '.ivnames{display:flex;flex-wrap:wrap;gap:8px}.ivnames button{flex:1 1 200px}',
    '.ivsetup{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;align-items:start}',
    '.ivsetup .ivcard h4{font-family:"Cormorant Garamond",Georgia,serif;font-size:21px;font-weight:600;color:var(--iv);margin:0 0 8px}',
    '.ivsetup .ivdf{margin-top:8px}.ivsetup textarea{width:100%;box-sizing:border-box;min-height:70px;font-family:"DM Sans",sans-serif;font-size:14px;border:1px solid var(--isd);border-radius:4px;background:var(--isl);padding:8px 10px;color:var(--ik)}',
    '.ivsetup textarea:focus{outline:none;border-color:var(--iv);background:#fff}',
    '.ivchip{display:inline-flex;align-items:center;gap:6px;background:var(--isl);border-radius:20px;padding:0 4px 0 12px;font-size:14px;margin:4px 6px 0 0;min-height:36px}',
    '.ivchip button{width:32px;height:32px;border:0;background:none;color:var(--iv);font-size:18px;cursor:pointer;border-radius:50%}',
    '.ivsetl{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-top:1px solid var(--isl);padding:8px 0}.ivsetl b{flex:1 1 160px;font-weight:600}.ivsetl span{font-size:12.5px;color:#5a4a3a}',
    '.ivsetl button{min-height:40px}',
    '.ivnote{font-size:12.5px;color:#5a4a3a;margin-top:6px;line-height:1.4}',
    '.ivsec2{border:1px solid var(--isd);border-radius:6px;padding:10px;margin-top:8px}',
    '.ivsec2 .row{display:flex;gap:8px;flex-wrap:wrap}.ivsec2 .row .ivdf{flex:1 1 180px;margin-top:0}',
    '@media(max-width:760px){',
    '  .ivmlrow{flex-direction:column;gap:1px}.ivmlrow i{flex:none}',
    '  .ivmlft button{flex:1 1 100%}',
    '  .ivwrap{padding:14px 14px 90px}',
    '  .ivgrid{grid-template-columns:minmax(0,1fr)}',
    '  .ivside{position:static;max-height:none}.ivlrows{overflow:visible;padding-right:0}',
    '  .ivgrid.sel .ivside{display:none}.ivgrid:not(.sel) #ivs-editor{display:none}',
    '  .ivwrap.ivopen .ivhd,.ivwrap.ivopen .ivtabs{display:none}',
    '  #ivs-editor{padding:0 14px 14px}',
    '  .ivselbar{position:sticky;top:var(--ivhd,0px);z-index:6;background:#fff;margin:0 -14px 10px;padding:4px 14px;border-bottom:1px solid var(--isl);border-radius:6px 6px 0 0}',
    '  .ivback{order:0;margin-left:0;text-decoration:none;min-height:44px;font-size:15px}.ivback .m{display:inline}.ivback .d{display:none}',
    '  .ivselsc{display:block;margin-left:auto;font-size:20px;font-weight:700;color:var(--iv);font-variant-numeric:tabular-nums}.ivselsc small{font-size:12px;color:#5a4a3a;font-weight:500}',
    '  .ivtabs{gap:18px}.ivlock span{display:none}',
    '  .ivstat{padding:8px 4px}.ivstat span{font-size:9px;letter-spacing:.06em}',
    '  .ivdet{grid-template-columns:1fr}',
    '  .ivstats{width:100%}.ivstat{flex:1;min-width:0}',
    '  .ivs{width:100%}.ivs button{flex:1;width:auto}',
    '  .ivsum .parts{margin-left:0}',
    '  .ivtab .hm{display:none}',
    '}'
  ].join('\n');
  document.head.appendChild(s);
}

// ══════════════════════════════════════════════════════════════════════════
async function openInterviews(){
  activeStation = IVS_KEY;
  hideAllPages();
  var v = document.getElementById('interviews-view');
  v.style.display = 'block';
  document.querySelector('.footer-bar').style.display = 'flex';
  var fl = document.getElementById('foot-label'); if (fl) fl.textContent = 'Interviews';
  ivsInjectCss();
  if (!ivsCode){ try { ivsCode = localStorage.getItem(IVS_CODE_STORE) || null; } catch(e){} }
  if (!ivsMe){ try { ivsMe = localStorage.getItem(IVS_ME_STORE) || ''; } catch(e){} }
  if (!ivsCode){ ivsRender(); return; }
  v.innerHTML = '<div style="padding:40px;text-align:center;opacity:.6">Opening the hiring rounds…</div>';
  var ok = await ivsBoot();
  if (!ok){ ivsRender(); return; }
  ivsRender();
  if (ivsRound) ivsStartPoll();
}

// after the passcode: rounds, question sets, settings — then the remembered round
async function ivsBoot(){
  var all = await Promise.all([
    sb.rpc('interview_rounds_list', { p_code: ivsCode }),
    sb.rpc('interview_sets_list',   { p_code: ivsCode }),
    sb.rpc('interview_settings_get', { p_code: ivsCode })
  ]);
  if (all[0].error){
    if (/passcode/i.test(all[0].error.message || '')){
      ivsCode = null; try { localStorage.removeItem(IVS_CODE_STORE); } catch(e){}
      ivsErr = 'That passcode is not right.';
    } else ivsErr = 'Could not read the rounds: ' + (all[0].error.message || 'no connection');
    return false;
  }
  ivsErr = '';
  ivsRounds = all[0].data || [];
  if (!all[1].error) ivsSets = all[1].data || [];
  if (!all[2].error) ivsSettings = (all[2].data || [])[0] || null;
  var want = '';
  try { want = localStorage.getItem(IVS_ROUND_STORE) || ''; } catch(e){}
  var open = ivsRounds.filter(function(r){ return !r.closed_on; });
  var pick = ivsRounds.filter(function(r){ return r.event === want; })[0] || (open.length === 1 ? open[0] : null);
  if (!ivsMe) ivsScreen = 'name';
  else if (pick){ if (!(await ivsRoundUse(pick))) return false; }
  else ivsScreen = 'rounds';
  return true;
}

async function ivsRoundUse(r){
  ivsRound = r; IVS_EVENT = r.event;
  ivsUseSet(ivsSetByKey(r.question_set));
  ivsRows = []; ivsShelved = []; ivsShelfEdit = null; ivsCvs = []; ivsActs = []; ivsSel = null; ivsQ = ''; ivsFolderQ = ''; ivsStageQ = ''; ivsAddOpen = false; ivsRen = null; ivsHist = {}; ivsTab = 'score';
  try { localStorage.setItem(IVS_ROUND_STORE, r.event); } catch(e){}
  var ok = await ivsLoad();
  if (ok){ ivsScreen = 'main'; ivsStartPoll(); }
  return ok;
}
async function ivsRoundPick(ev){
  var r = ivsRounds.filter(function(x){ return x.event === ev; })[0]; if (!r) return;
  var v = document.getElementById('interviews-view');
  if (v) v.innerHTML = '<div style="padding:40px;text-align:center;opacity:.6">Opening ' + ivsEsc(r.title) + '…</div>';
  await ivsRoundUse(r);
  ivsRender();
}
async function ivsRoundsOpen(){
  if (ivsTimer){ clearInterval(ivsTimer); ivsTimer = null; }
  var l = await sb.rpc('interview_rounds_list', { p_code: ivsCode });
  if (!l.error) ivsRounds = l.data || [];
  ivsScreen = 'rounds'; ivsRender();
}
function ivsMePick(name){
  name = String(name || '').replace(/\s+/g, ' ').trim();
  if (name.replace(/[^A-Za-zÀ-ɏ]/g, '').length < 2){ kToast('Type your name.', true); return; }
  ivsMe = name.slice(0, 60);
  try { localStorage.setItem(IVS_ME_STORE, ivsMe); } catch(e){}
  if (ivsRound){ ivsScreen = 'main'; ivsRender(); ivsStartPoll(); } else { ivsScreen = 'rounds'; ivsRender(); }
}
function ivsMeChange(){ if (ivsTimer){ clearInterval(ivsTimer); ivsTimer = null; } ivsScreen = 'name'; ivsRender(); }

function ivsVisible(){
  var v = document.getElementById('interviews-view');
  return !!(v && v.style.display !== 'none' && activeStation === IVS_KEY);
}
function ivsStartPoll(){
  if (ivsTimer) clearInterval(ivsTimer);
  ivsTimer = setInterval(async function(){
    if (!ivsVisible() || !ivsCode || !ivsRound || ivsScreen !== 'main'){ clearInterval(ivsTimer); ivsTimer = null; return; }
    if (document.hidden) return;
    if (await ivsLoad(true)) ivsRender(true);
  }, 4000);
}

// a phone put in a pocket and taken out again catches up at once, not 4s later
document.addEventListener('visibilitychange', async function(){
  if (document.hidden || !ivsCode || !ivsRound || ivsScreen !== 'main' || !ivsVisible()) return;
  if (await ivsLoad(true)) ivsRender(true);
  if (!ivsTimer) ivsStartPoll();
});

async function ivsLoad(quiet){
  var both = await Promise.all([
    sb.rpc('interview_list',    { p_code: ivsCode, p_event: IVS_EVENT }),
    sb.rpc('interview_cv_list', { p_code: ivsCode, p_event: IVS_EVENT }),
    sb.rpc('interview_actions_list', { p_code: ivsCode, p_event: IVS_EVENT }),
    sb.rpc('interview_noshows', { p_code: ivsCode })
  ]);
  var r = both[0];
  if (!both[1].error) ivsCvs = both[1].data || [];
  if (!both[2].error) ivsActs = both[2].data || [];
  if (!both[3].error) ivsNoShows = both[3].data || [];
  if (r.error){
    if (/passcode/i.test(r.error.message || '')){
      ivsCode = null; try { localStorage.removeItem(IVS_CODE_STORE); } catch(e){}
      ivsErr = 'That passcode is not right.';
      return false;
    }
    if (!quiet) ivsErr = 'Could not read the scores: ' + (r.error.message || 'no connection');
    return false;
  }
  ivsErr = '';
  var fresh = r.data || [];
  // a row with a save still in flight keeps what this phone already shows
  var mine = {};
  ivsRows.forEach(function(x){ if (ivsPending[x.id]) mine[x.id] = x; });
  ivsRows.forEach(function(x){
    if (x.id === ivsSel && (ivsNameT || ivsWaveT || ivsNotesT || ivsDetTyping()) && !mine[x.id]) mine[x.id] = { old:x, partial:true };
  });
  ivsRows = fresh.map(function(x){
    var m = mine[x.id];
    if (!m) return x;
    if (!m.partial) return m;
    ivsKeepTyping(x, m.old);                 // not sent yet — the typing wins
    return x;
  });
  ivsShelved = ivsRows.filter(function(x){ return x.shelf; });
  ivsRows = ivsRows.filter(function(x){ return !x.shelf; });
  if (ivsSel && !ivsRows.some(function(x){ return x.id === ivsSel; })) ivsSel = null;
  ivsMailStatus();
  return true;
}

async function ivsUnlock(){
  var inp = document.getElementById('ivs-code');
  var c = inp ? (inp.value || '').trim() : '';
  if (!c){ if (inp) inp.focus(); return; }
  ivsCode = c;
  var ok = await ivsBoot();
  if (!ok){ ivsRender(); return; }
  try { localStorage.setItem(IVS_CODE_STORE, c); } catch(e){}
  ivsRender();
}
function ivsLock(){
  if (ivsBulk && ivsBulk.running){ kToast('CVs are still uploading — wait for them to finish, then lock.', true); return; }
  if (ivsMail && ivsMail.step === 'sending'){ kToast('An email is being sent — wait for it to finish, then lock.', true); return; }
  ivsCode = null; ivsRows = []; ivsShelved = []; ivsShelfRows = null; ivsShelfEdit = null; ivsSel = null; ivsCvs = []; ivsActs = []; ivsQ = ''; ivsRound = null; IVS_EVENT = ''; ivsHist = {}; ivsScreen = 'main'; ivsViewerClose(); ivsBulkClose(true); ivsMailClose(true);
  try { localStorage.removeItem(IVS_CODE_STORE); } catch(e){}
  if (ivsTimer){ clearInterval(ivsTimer); ivsTimer = null; }
  ivsRender();
}

function ivsRow(id){ for (var i=0;i<ivsRows.length;i++) if (ivsRows[i].id === id) return ivsRows[i]; return null; }

var ivsSaveSeq = {};      // id -> number of the last save issued; only ITS answer may replace the row
async function ivsSave(id, patch){
  ivsPending[id] = (ivsPending[id] || 0) + 1;
  var seq = ivsSaveSeq[id] = (ivsSaveSeq[id] || 0) + 1;
  var r = await sb.rpc('interview_patch', { p_code: ivsCode, p_id: id, p_patch: patch, p_by: ivsMe || '' });
  ivsPending[id]--;
  if (!ivsPending[id]) delete ivsPending[id];
  if (r.error){
    kToast('Not saved — ' + (r.error.message || 'no connection') + '. Tap it again.', true);
    await ivsLoad(true); ivsRender(true);
    return;
  }
  // four quick taps = four answers, not always in order: an earlier answer arriving
  // last carried a row without the later taps and wiped them until the next poll
  if (r.data && !ivsPending[id] && seq === ivsSaveSeq[id]){
    var i = ivsRows.findIndex(function(x){ return x.id === id; });
    if (i >= 0){
      // keep whatever the chef is typing right now
      var cur = ivsRows[i];
      ivsRows[i] = r.data;
      if (cur) ivsKeepTyping(ivsRows[i], cur);
    }
  }
}

// copy onto a fresh row every field this phone has typed but not sent yet
function ivsKeepTyping(to, from){
  if (!from) return;
  if (ivsEvT) to.evaluation = from.evaluation;
  if (ivsNameT) to.name = from.name;
  if (ivsWaveT) to.wave = from.wave;
  if (ivsNotesT) to.notes = from.notes;
  IVS_DETAILS.forEach(function(d){ if (ivsDetT[d[0]]) to[d[0]] = from[d[0]]; });
}

async function ivsAdd(){
  var r = await sb.rpc('interview_add', { p_code: ivsCode, p_event: IVS_EVENT, p_by: ivsMe || '' });
  if (r.error){ kToast('Could not add — ' + (r.error.message || 'no connection'), true); return; }
  if (ivsFolderQ && ivsFolderQ !== IVS_NOFOLDER){ r.data.wave = ivsFolderQ; ivsSave(r.data.id, { wave: ivsFolderQ }); }   // the folder on screen is where they go
  ivsRows.push(r.data);
  ivsQ = '';                                        // a search would hide the new, unnamed row
  ivsSel = r.data.id; ivsTab = 'score';
  ivsRender();
  var n = document.getElementById('ivs-name'); if (n) n.focus();
}

function ivsPick(id){
  ivsSel = id; ivsTab = 'score'; ivsRender();
  ivsMailBackfill(id);
  ivsHistLoad(id);
  window.scrollTo(0, 0);
}
// back to the list (phone) / the overview (laptop)
function ivsBack(){ ivsSel = null; ivsRender(); window.scrollTo(0, 0); }

function ivsScore(key, val){
  var row = ivsRow(ivsSel); if (!row) return;
  var sc = Object.assign({}, row.scores || {});
  var next = (sc[key] != null && +sc[key] === val) ? null : val;   // tap the same one again to clear it (0 = N/A)
  if (next === null) delete sc[key]; else sc[key] = next;
  row.scores = sc;
  row.scores_by = Object.assign({}, row.scores_by || {}); if (next === null) delete row.scores_by[key]; else if (ivsMe) row.scores_by[key] = ivsMe;
  var p = {}; p[key] = next;
  ivsSave(row.id, { scores: p });
  ivsRender(true);
}

function ivsName(el){
  var row = ivsRow(ivsSel); if (!row) return;
  row.name = el.value;
  var id = row.id, val = el.value;
  clearTimeout(ivsNameT);
  ivsNameT = setTimeout(function(){ ivsNameT = null; ivsSave(id, { name: val }); }, 600);
  ivsRenderList();
}
function ivsNotes(el){
  var row = ivsRow(ivsSel); if (!row) return;
  row.notes = el.value;
  var id = row.id, val = el.value;
  clearTimeout(ivsNotesT);
  ivsNotesT = setTimeout(function(){ ivsNotesT = null; ivsSave(id, { notes: val }); }, 800);
}
function ivsDetail(el){
  var row = ivsRow(ivsSel); if (!row) return;
  var key = el.getAttribute('data-k');
  row[key] = el.value;
  var id = row.id, val = el.value;
  if (key === 'email'){                                // typed over: no longer "read from the CV"
    delete ivsMailRead[id];
    clearTimeout(ivsHistT); ivsHistT = setTimeout(function(){ ivsHistLoad(id); }, 900);
    var hint = document.getElementById('ivs-mailhint'); if (hint) hint.textContent = ivsMailHint(row);
  }
  clearTimeout(ivsDetT[key]);
  ivsDetT[key] = setTimeout(function(){
    ivsDetT[key] = null;
    var p = {}; p[key] = val;
    ivsSave(id, p);
  }, 700);
}
// leaving the field sends it at once — a chef who types and walks away loses nothing
function ivsDetailFlush(el){
  var key = el.getAttribute('data-k');
  if (!ivsDetT[key]) return;
  clearTimeout(ivsDetT[key]); ivsDetT[key] = null;
  var row = ivsRow(ivsSel); if (!row) return;
  var p = {}; p[key] = el.value;
  ivsSave(row.id, p);
}
function ivsDetailsHtml(r){
  var h = '<div class="ivdet">';
  IVS_DETAILS.forEach(function(d){
    var list = d[3].length ? ' list="ivs-dl-'+d[0]+'"' : '';
    var mail = d[0] === 'email';
    h += '<label class="ivdf'+(mail?' wide':'')+'"><span>'+ivsEsc(d[1])+'</span>'+
      '<input id="ivs-d-'+d[0]+'" data-k="'+d[0]+'" maxlength="120" autocomplete="off"'+list+
      (mail ? ' type="email" inputmode="email" autocapitalize="off" spellcheck="false"' : '')+
      ' placeholder="'+ivsEsc(d[2])+'" value="'+ivsEsc(r[d[0]])+'" oninput="ivsDetail(this)" onchange="ivsDetailFlush(this)">'+
      (mail ? '<em id="ivs-mailhint">'+ivsEsc(ivsMailHint(r))+'</em>' : '')+'</label>';
    if (mail) h += ivsMailScanHtml(r);
    if (d[3].length) h += '<datalist id="ivs-dl-'+d[0]+'">'+d[3].map(function(o){ return '<option value="'+ivsEsc(o)+'">'; }).join('')+'</datalist>';
  });
  return h + '</div>';
}

function ivsWave(el){
  var row = ivsRow(ivsSel); if (!row) return;
  row.wave = el.value;
  var id = row.id, val = el.value;
  clearTimeout(ivsWaveT);
  ivsWaveT = setTimeout(function(){ ivsWaveT = null; ivsSave(id, { wave: val.trim() }); ivsRenderList(); }, 700);
}
function ivsWaveFlush(el){
  if (!ivsWaveT) return;
  clearTimeout(ivsWaveT); ivsWaveT = null;
  var row = ivsRow(ivsSel); if (!row) return;
  row.wave = el.value.trim(); ivsSave(row.id, { wave: row.wave }); ivsRenderList();
}
// the folders of this round, most used first
function ivsFolders(){
  var n = {}; ivsRows.forEach(function(r){ var w = (r.wave || '').trim(); if (w) n[w] = (n[w] || 0) + 1; });
  return Object.keys(n).sort(function(a, b){ return n[b] - n[a] || a.localeCompare(b); }).map(function(k){ return { name: k, n: n[k] }; });
}
function ivsFolderListHtml(){ return '<datalist id="ivs-dl-folder">'+ivsFolders().map(function(f){ return '<option value="'+ivsEsc(f.name)+'">'; }).join('')+'</datalist>'; }
function ivsFolderPick(name){ ivsFolderQ = name; ivsRenderList(); }
function ivsFolderRename(){
  if (!ivsFolderQ || ivsFolderQ === IVS_NOFOLDER) return;
  ivsRen = { old: ivsFolderQ, val: ivsFolderQ };
  ivsRender();
  var i = document.getElementById('ivs-ren'); if (i){ i.focus(); i.select(); }
}
function ivsFolderRenameKey(e){
  if (e.key === 'Enter'){ e.preventDefault(); ivsFolderRenameSave(); }
  if (e.key === 'Escape'){ e.preventDefault(); ivsRen = null; ivsRender(); }
}
function ivsFolderRenameSave(){
  if (!ivsRen) return;
  var old = ivsRen.old, nw = (ivsRen.val || '').trim().slice(0, 80);
  ivsRen = null;
  if (!nw || nw === old){ ivsRender(); return; }
  var n = 0;
  ivsRows.forEach(function(r){ if ((r.wave || '').trim() === old){ r.wave = nw; ivsSave(r.id, { wave: nw }); n++; } });
  ivsFolderQ = nw; ivsRender();
  kToast('Folder renamed — ' + n + ' candidate' + (n === 1 ? '' : 's') + ' now in “' + nw + '”.');
}
// the header counters filter the list; "Candidates" clears every filter
function ivsStagePick(k){
  if (!k){ ivsStageQ = ''; ivsFolderQ = ''; ivsQ = ''; }
  else ivsStageQ = ivsStageQ === k ? '' : k;
  ivsSel = null; ivsTab = 'score'; ivsRender();
}
function ivsFiltersClear(){ ivsStageQ = ''; ivsFolderQ = ''; ivsQ = ''; ivsRender(); }
function ivsAddMenu(){
  ivsAddOpen = !ivsAddOpen;
  var m = document.getElementById('ivs-addm'), b = document.getElementById('ivs-addb');
  if (m) m.hidden = !ivsAddOpen;
  if (b) b.setAttribute('aria-expanded', ivsAddOpen);
  if (ivsAddOpen) setTimeout(function(){ document.addEventListener('click', ivsAddMenuOff, true); }, 0);
  else document.removeEventListener('click', ivsAddMenuOff, true);
}
function ivsAddMenuOff(e){
  if (e && e.target && e.target.closest && e.target.closest('.ivaddw')) return;   // its own button toggles it
  ivsAddOpen = true; ivsAddMenu();
}
function ivsAddPick(which){
  if (ivsAddOpen) ivsAddMenu();
  if (which === 'bulk') ivsBulkOpen(); else ivsAdd();
}

async function ivsDelete(){
  var row = ivsRow(ivsSel); if (!row) return;
  var nm = row.name || 'this unnamed candidate';
  if (!(await ivsAsk({ title:'Delete ' + nm + '?', body:'Their scores, notes and CVs go too — for all four interviewers. This cannot be undone.', ok:'Delete', danger:true }))) return;
  var r = await sb.rpc('interview_delete', { p_code: ivsCode, p_id: row.id });
  if (r.error){ kToast('Not deleted — ' + (r.error.message || 'no connection'), true); return; }
  ivsRows = ivsRows.filter(function(x){ return x.id !== row.id; });
  ivsCvs = ivsCvs.filter(function(x){ return x.candidate_id !== row.id; });
  ivsSel = null;
  ivsRender();
}

// ══════════════════════════════════════════════════════════════════════════
// rendering
// ══════════════════════════════════════════════════════════════════════════
function ivsStatsHtml(){
  var st = {}; ivsRows.forEach(function(r){ var k = ivsStage(r); st[k] = (st[k] || 0) + 1; });
  var none = !ivsStageQ && !ivsFolderQ && !ivsQ.trim();
  var b = function(k, n, label){
    var on = k ? ivsStageQ === k : none;
    return '<button type="button" class="ivstat'+(on ? ' on' : '')+'" aria-pressed="'+on+'" onclick="ivsStagePick(\''+k+'\')"'+
      ' title="'+(k ? 'Show only: '+label : 'Show everyone')+'"><b>'+n+'</b><span>'+label+'</span></button>';
  };
  return '<div class="ivstats">'+b('', ivsRows.length, 'Candidates')+b('decide', st.decide || 0, 'To decide')+
    b('shortlist', st.shortlist || 0, 'Shortlisted')+b('hr', st.hr || 0, 'Sent to HR')+'</div>';
}

function ivsCandLabel(r){ return r.name && r.name.trim() ? r.name : 'Unnamed candidate'; }

// the buttons and the search box sit OUTSIDE #ivs-list, so a poll redrawing the
// list never takes the search box out from under the chef's typing
function ivsListShellHtml(){
  return '<div class="ivbar1">'+
    '<div class="ivfind"><input id="ivs-search" type="search" placeholder="Search '+ivsRows.length+' candidates" aria-label="Search candidates" autocomplete="off" value="'+ivsEsc(ivsQ)+'" oninput="ivsSearch(this)" onkeydown="ivsSearchKey(event)">'+
    (ivsQ ? '<button type="button" aria-label="Clear search" onclick="ivsSearchClear()">&times;</button>' : '')+'</div>'+
    '<div class="ivaddw"><button type="button" id="ivs-addb" class="ivb" aria-haspopup="true" aria-expanded="'+ivsAddOpen+'" onclick="ivsAddMenu()">+ Add</button>'+
      '<div class="ivaddm" id="ivs-addm"'+(ivsAddOpen ? '' : ' hidden')+'>'+
        '<button type="button" onclick="ivsAddPick(\'one\')">One candidate</button>'+
        '<button type="button" onclick="ivsAddPick(\'bulk\')">CVs in bulk…</button></div></div>'+
  '</div>'+
  (ivsRen ? '<div class="ivren"><label for="ivs-ren">Rename folder “'+ivsEsc(ivsRen.old)+'”</label>'+
    '<div class="r"><input id="ivs-ren" maxlength="80" autocomplete="off" value="'+ivsEsc(ivsRen.val)+'" oninput="ivsRen.val=this.value" onkeydown="ivsFolderRenameKey(event)">'+
    '<button type="button" class="ivb" onclick="ivsFolderRenameSave()">Save</button>'+
    '<button type="button" class="ivb2" onclick="ivsRen=null;ivsRender()">Cancel</button></div>'+
    '<small>Every candidate in this folder moves to the new name.</small></div>' : '')+
  '<div id="ivs-list">'+ivsListHtml()+'</div>';
}

// lower-case, accents off, anything that is not a letter or digit becomes a space
function ivsNorm(s){
  return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
// every word typed must appear somewhere: name, wave, notes, the candidate details or a CV file name
function ivsMatches(r, q){
  var words = ivsNorm(q).split(' ').filter(Boolean);
  if (!words.length) return true;
  var hay = ' ' + ivsNorm([ivsCandLabel(r), r.wave, r.notes]
    .concat(IVS_DETAILS.map(function(d){ return r[d[0]]; }))
    .concat(ivsCvsFor(r.id).map(function(c){ return c.filename; })).join(' '));
  return words.every(function(w){ return hay.indexOf(w) >= 0; });
}
// a hit that is not in the name says where it was found, or the row looks like a wrong match
function ivsWhere(r, q){
  var words = ivsNorm(q).split(' ').filter(Boolean);
  var nm = ivsNorm(ivsCandLabel(r));
  if (words.every(function(w){ return nm.indexOf(w) >= 0; })) return '';
  if (words.some(function(w){ return ivsNorm(r.notes).indexOf(w) >= 0; })) return 'found in notes';
  if (words.some(function(w){ return ivsNorm(r.wave).indexOf(w) >= 0; })) return r.wave;
  var det = IVS_DETAILS.filter(function(d){ return words.some(function(w){ return ivsNorm(r[d[0]]).indexOf(w) >= 0; }); })[0];
  if (det) return det[1] + ': ' + r[det[0]];
  return 'found in CV file name';
}
function ivsFiltered(){ return ivsRows.filter(function(r){
  var w = (r.wave || '').trim();
  if (ivsFolderQ === IVS_NOFOLDER ? w : (ivsFolderQ && w !== ivsFolderQ)) return false;
  if (ivsStageQ && ivsStage(r) !== ivsStageQ) return false;
  return ivsMatches(r, ivsQ);
}); }

function ivsSearch(el){
  ivsQ = el.value;
  var keep = ivsScrollGrab();
  var el2 = document.getElementById('ivs-list'); if (el2) el2.innerHTML = ivsListHtml();
  ivsScrollPut(keep, false);
  var box = el.parentNode, x = box.querySelector('button');
  if (ivsQ && !x) box.insertAdjacentHTML('beforeend', '<button type="button" aria-label="Clear search" onclick="ivsSearchClear()">&times;</button>');
  if (!ivsQ && x) x.remove();
}
function ivsSearchKey(e){
  if (e.key === 'Escape' && ivsQ){ e.preventDefault(); ivsSearchClear(); }
  if (e.key === 'Enter'){
    var hits = ivsFiltered();
    if (hits.length){ e.preventDefault(); e.target.blur(); ivsPick(hits[0].id); }
  }
}
function ivsSearchClear(){
  ivsQ = '';
  var el = document.getElementById('ivs-search');
  if (el){ el.value = ''; ivsSearch(el); el.focus(); }
}

function ivsListHtml(){
  if (!ivsRows.length) return '<div class="ivempty">'+(ivsShelved.length ? 'Every candidate of this round is in the CV database.' : 'No candidates yet. Add the first one above, or add a folder of CVs in bulk.')+'</div>'+ivsShelfLineHtml();
  var folders = ivsFolders(), h = '';
  if (ivsFolderQ && ivsFolderQ !== IVS_NOFOLDER && !folders.some(function(f){ return f.name === ivsFolderQ; })) ivsFolderQ = '';   // the folder was renamed away
  var unfiled = ivsRows.filter(function(r){ return !(r.wave || '').trim(); }).length;
  if (ivsFolderQ === IVS_NOFOLDER && !unfiled) ivsFolderQ = '';
  var hits = ivsFiltered();
  h += '<div class="ivlhead">';
  if (folders.length){
    var chip = function(val, label, on){ return '<button type="button" class="'+(on ? 'on' : '')+'" aria-pressed="'+on+'" onclick="ivsFolderPick(this.getAttribute(\'data-f\'))" data-f="'+ivsEsc(val)+'">'+ivsEsc(label)+'</button>'; };
    h += '<div class="ivchips" role="group" aria-label="Folders">'+chip('', 'All · '+ivsRows.length, !ivsFolderQ)+
      folders.map(function(f){ return chip(f.name, f.name+' · '+f.n, ivsFolderQ === f.name); }).join('')+
      (unfiled ? chip(IVS_NOFOLDER, 'No folder · '+unfiled, ivsFolderQ === IVS_NOFOLDER) : '')+'</div>';
  }
  var filtered = !!(ivsStageQ || ivsFolderQ || ivsQ.trim());
  h += '<div class="ivfindn"><span>'+(filtered ? hits.length+' of '+ivsRows.length+(ivsStageQ ? ' · '+ivsEsc(ivsStageWord(ivsStageQ)) : '') : 'All '+ivsRows.length)+'</span>'+
    (ivsFolderQ && ivsFolderQ !== IVS_NOFOLDER && !ivsRen ? '<button type="button" onclick="ivsFolderRename()">Rename folder</button>' : '')+
    (filtered ? '<button type="button" onclick="ivsFiltersClear()">Clear filters</button>' : '')+'</div>'+ivsShelfLineHtml()+'</div><div class="ivlrows">';
  if (!hits.length) h += '<div class="ivempty">'+(ivsQ.trim() ? 'No candidate matches “'+ivsEsc(ivsQ.trim())+'”.' : 'No candidates here.')+'</div>';
  var groups = {}; hits.forEach(function(r){ var k = ivsStage(r); (groups[k] = groups[k] || []).push(r); });
  // what needs a decision first, then what is half-done, then the rest
  ['decide','scoring','new','shortlist','hr','future','reject','noshow'].map(function(k){ return [k, ivsStageWord(k)]; }).forEach(function(st){
    var rows = groups[st[0]]; if (!rows || !rows.length) return;
    // the ones to decide best first; the ones being scored nearest to done first
    if (st[0] === 'decide') rows = rows.slice().sort(function(a, b){ return ivsCalc(b).final - ivsCalc(a).final; });
    if (st[0] === 'scoring') rows = rows.slice().sort(function(a, b){ return ivsCalc(b).scored - ivsCalc(a).scored; });
    h += '<div class="ivstg"><span>'+ivsEsc(st[1])+'</span><span>'+rows.length+'</span></div>';
    rows.forEach(function(r){
      var c = ivsCalc(r), w = (r.wave || '').trim();
      var where = [ivsQ.trim() ? ivsWhere(r, ivsQ) : '', ivsFolderQ ? '' : (w || 'No folder'), ivsCvsFor(r.id).length ? 'CV' : 'No CV', ivsActLine(r.id)]
        .filter(function(x, i, arr){ return x && arr.indexOf(x) === i; }).join(' · ');   // a search hit in the folder name is not said twice
      h += '<button type="button" class="ivcand'+(r.id===ivsSel?' on':'')+'" onclick="ivsPick(\''+r.id+'\')">'+
        '<span class="ivdot s-'+st[0]+'"></span>'+
        '<span class="nmw"><b>'+(ivsFlagFor(r).length ? '<span class="ivrf" title="Did not show up before">⚑ No-show before</span>' : '')+ivsEsc(ivsCandLabel(r))+'</b><small>'+ivsEsc(where)+'</small></span>'+
        '<i>'+(c.done ? c.final : (c.scored ? c.scored+'/'+IVS_LINES : ''))+'</i></button>';
    });
  });
  return h + '</div>';
}
// redrawing the list makes new elements, which start scrolled to 0 — so a chef who had
// scrolled the folder chips (or the list) was thrown back to the start by every 4s refresh
function ivsScrollGrab(){
  var c = document.querySelector('#interviews-view .ivchips'), l = document.querySelector('#interviews-view .ivlrows');
  return { c: c ? c.scrollLeft : 0, l: l ? l.scrollTop : 0 };
}
function ivsScrollPut(p, list){
  var c = document.querySelector('#interviews-view .ivchips'); if (c && p.c) c.scrollLeft = p.c;
  var l = document.querySelector('#interviews-view .ivlrows'); if (list && l && p.l) l.scrollTop = p.l;
}
function ivsRenderList(){
  var keep = ivsScrollGrab();
  var el = document.getElementById('ivs-list'); if (el) el.innerHTML = ivsListHtml();
  var st = document.getElementById('ivs-stats'); if (st) st.outerHTML = '<div id="ivs-stats">'+ivsStatsHtml()+'</div>';
  ivsScrollPut(keep, true);
}

function ivsSumHtml(r){
  var c = ivsCalc(r);
  var pill = c.done ? '<span class="ivpill '+c.verdict.c+'">'+c.verdict.t+'</span>'
                    : '<span class="ivpill">'+(c.scored === IVS_LINES ? 'All N/A — nothing to average' : c.scored ? 'In progress · '+(IVS_LINES-c.scored)+' to score' : 'Not scored')+'</span>';
  return '<div class="ivsum" id="ivs-sum">'+
    '<div class="big">'+(c.done ? c.final : '—')+'<small> / 100</small></div>'+ pill +
    '<div class="parts">'+(c.iAll ? '<div><b>'+ivsPart(c.int, c.iMax, c.iAll)+'</b><span>Interview ('+IVS_WEIGHTS.int+'%)</span></div>' : '')+
    (c.pAll ? '<div><b>'+ivsPart(c.prac, c.pMax, c.pAll)+'</b><span>Practical ('+IVS_WEIGHTS.prac+'%)</span></div>' : '')+
    (c.na ? '<div><b>'+c.na+'</b><span>N/A — not counted</span></div>' : '')+'</div>'+
  '</div>';
}

function ivsOverviewHtml(){
  if (!ivsRows.length) return '<div id="ivs-ov" class="ivempty">No candidates yet — add one with “+ Add”, or add a folder of CVs in bulk.</div>';
  var all = ivsRows.map(function(r){ return { r:r, c:ivsCalc(r), s:ivsStage(r) }; });
  var dec = all.filter(function(x){ return x.s === 'decide'; }).sort(function(a, b){ return b.c.final - a.c.final; });
  var scg = all.filter(function(x){ return x.s === 'scoring'; }).sort(function(a, b){ return b.c.scored - a.c.scored; });
  var top = all.filter(function(x){ return x.c.done; }).sort(function(a, b){ return b.c.final - a.c.final; }).slice(0, 5);
  var fresh = all.filter(function(x){ return x.s === 'new'; }).length;
  var mini = function(x, rank){
    return '<button type="button" class="ivmini" onclick="ivsPick(\''+x.r.id+'\')">'+(rank ? '<span class="rk">'+rank+'</span>' : '')+
      '<span class="g">'+ivsEsc(ivsCandLabel(x.r))+'</span>'+
      (rank ? '<span class="ivbar"><i style="width:'+x.c.final+'%"></i></span>' : '')+
      '<b>'+(x.c.done ? x.c.final : x.c.scored+'/'+IVS_LINES)+'</b></button>';
  };
  var box = function(title, n, color, lead, list, stage, ranked){
    return '<div class="ivovb"><div class="t"><b>'+title+'</b>'+(n != null ? '<span style="color:'+color+'">'+n+'</span>' : '')+'</div><p>'+lead+'</p>'+
      (list.length ? list.slice(0, 5).map(function(x, i){ return mini(x, ranked ? i + 1 : 0); }).join('') : '<div class="ivovnone">None yet.</div>')+
      (stage && list.length > 5 ? '<button type="button" class="ivovall" onclick="ivsStagePick(\''+stage+'\')">See all '+list.length+'</button>' : '')+'</div>';
  };
  return '<div id="ivs-ov"><div class="ivlbl">Overview</div><h3 class="ivovh">Where the round stands</h3><div class="ivov">'+
    box('To decide', dec.length, '#a3261c', 'Fully scored — waiting for shortlist or reject.', dec, 'decide', false)+
    box('Being scored', scg.length, '#7a5b00', 'Started, lines still open — pick up where it stopped.', scg, 'scoring', false)+
    box('Top of the leaderboard', null, '', 'Final score out of 100.', top, '', true)+'</div>'+
    (fresh ? '<div class="ivovnew"><b>'+fresh+' not started.</b> Pick a name to score, or tap a folder to see one interview day.</div>' : '')+
  '</div>';
}
function ivsSelBarHtml(r){
  var c = ivsCalc(r), k = ivsStage(r);
  return '<div class="ivselbar"><button type="button" class="ivback" onclick="ivsBack()"><span class="m">‹ Candidates</span><span class="d">Back to overview</span></button>'+
    '<span class="ivspill s-'+k+'">'+ivsEsc(ivsStageWord(k))+'</span>'+
    '<span class="ivselsc" id="ivs-selsc">'+(c.done ? c.final+'<small> /100</small>' : c.scored ? c.scored+'/'+IVS_LINES : '')+'</span></div>';
}

function ivsEditorHtml(){
  var r = ivsRow(ivsSel);
  if (!r) return ivsOverviewHtml();
  var sc = r.scores || {};
  var h = ivsSelBarHtml(r) + '<div class="ivtop">'+
    '<input id="ivs-name" class="ivname" placeholder="Candidate name" value="'+ivsEsc(r.name)+'" oninput="ivsName(this)" autocomplete="off">'+
    '<input id="ivs-wave" class="ivsel" style="flex:1 1 200px;min-width:0" list="ivs-dl-folder" maxlength="80" autocomplete="off" placeholder="Folder — e.g. Monday 21st interview" aria-label="Folder" value="'+ivsEsc(r.wave||'')+'" oninput="ivsWave(this)" onchange="ivsWaveFlush(this)">'+
    ivsFolderListHtml()+
    '<button class="ivdel" onclick="ivsDelete()">Delete</button>'+
  '</div>' + '<div id="ivs-flag">'+ivsFlagHtml(r)+'</div>' + ivsDetailsHtml(r) + '<div id="ivs-hist">'+ivsHistHtml(r)+'</div>' + ivsSumHtml(r) + ivsCvsHtml(r) + ivsActsHtml(r) + ivsShelfBoxHtml(r);
  IVS_SECTIONS.forEach(function(s){
    h += '<div class="ivsec">'+ivsEsc(s.title)+'</div>';
    s.items.forEach(function(it){
      var cur = sc[it[0]] == null ? -1 : +sc[it[0]];
      var by = (r.scores_by || {})[it[0]];
      h += '<div class="ivq"><div class="t"><b>'+(s.part==='prac'?'':ivsEsc(it[0])+'. ')+ivsEsc(it[1])+(by && cur >= 0 ? '<span class="ivby" data-by="'+it[0]+'">'+ivsEsc(by)+'</span>' : '<span class="ivby" data-by="'+it[0]+'"></span>')+'</b><span>'+ivsEsc(it[2] || '')+'</span></div><div class="ivs" data-k="'+it[0]+'">';
      for (var n=1;n<=5;n++) h += '<button type="button" data-v="'+n+'" class="'+(cur===n?'on':'')+'" aria-pressed="'+(cur===n)+'" onclick="ivsScore(\''+it[0]+'\','+n+')">'+n+'</button>';
      h += '<button type="button" data-v="0" class="na'+(cur===0?' on':'')+'" aria-pressed="'+(cur===0)+'" title="Could not be assessed — left out of the average" onclick="ivsScore(\''+it[0]+'\',0)">N/A</button>';
      h += '</div></div>';
    });
  });
  h += '<div class="ivsec">Notes</div>'+
    '<textarea id="ivs-notes" class="ivnotes" placeholder="Anything worth remembering — knife confidence, attitude, timing issues…" oninput="ivsNotes(this)">'+ivsEsc(r.notes)+'</textarea>';
  return h;
}

// ══════════════════════════════════════════════════════════════════════════
// CVs
// ══════════════════════════════════════════════════════════════════════════
function ivsCvsFor(id){ return ivsCvs.filter(function(c){ return c.candidate_id === id; }); }
function ivsKb(n){ return n >= 1048576 ? (n/1048576).toFixed(1)+' MB' : Math.max(1, Math.round(n/1024))+' KB'; }
function ivsCvKind(name, mime){
  var n = String(name||'').toLowerCase(), m = String(mime||'').toLowerCase();
  if (/\.pdf$/.test(n) || m === 'application/pdf') return 'pdf';
  if (/\.docx$/.test(n) || m.indexOf('wordprocessingml') >= 0) return 'docx';
  if (/\.doc$/.test(n) || m === 'application/msword') return 'doc';
  if (/\.(jpe?g|png|webp|heic|heif)$/.test(n) || m.indexOf('image/') === 0) return 'image';
  return '';
}

function ivsCvsHtml(r){
  var list = ivsCvsFor(r.id), busy = ivsCvBusy === r.id;
  var h = '<div class="ivcvs" id="ivs-cvs"><div class="hd"><b>CV</b>'+
    '<label class="ivcvup'+(busy?' busy':'')+'">'+(busy ? 'Uploading…' : (list.length ? '+ Add another' : 'Upload CV'))+
    '<input type="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*" onchange="ivsCvUpload(this,\''+r.id+'\')"></label></div>';
  if (!list.length) h += '<div class="ivcvnone">No CV yet — Word, PDF, or a photo of a paper CV.</div>';
  list.forEach(function(c){
    h += '<div class="ivcvf"><div class="nm">'+ivsEsc(c.filename)+'<span>'+ivsKb(c.size_bytes)+'</span></div>'+
      '<button class="v" onclick="ivsCvView(\''+c.id+'\')">Open</button>'+
      '<button class="x" onclick="ivsCvDelete(\''+c.id+'\')">Remove</button></div>';
  });
  return h + '</div>';
}
function ivsCvRefresh(){
  var r = ivsRow(ivsSel), el = document.getElementById('ivs-cvs');
  if (r && el) el.outerHTML = ivsCvsHtml(r);
  ivsRenderList();
}

function ivsCvUpload(input, candId){
  var f = input.files && input.files[0];
  input.value = '';
  if (!f) return;
  if (!ivsCvKind(f.name, f.type)){ kToast('That file type cannot be opened here. Use Word, PDF or a photo.', true); return; }
  if (f.size > IVS_CV_MAX){ kToast(f.name+' is '+ivsKb(f.size)+'. The limit is 8 MB — save it smaller or take a photo.', true); return; }
  var rd = new FileReader();
  rd.onerror = function(){ kToast('Could not read that file on this device.', true); };
  rd.onload = async function(){
    var b64 = String(rd.result).split(',')[1] || '';
    ivsCvBusy = candId; ivsCvRefresh();
    var r = await sb.rpc('interview_cv_add', { p_code: ivsCode, p_candidate: candId,
      p_filename: f.name, p_mime: f.type || '', p_b64: b64 });
    ivsCvBusy = null;
    if (r.error){ ivsCvRefresh(); kToast('CV not saved — ' + (r.error.message || 'no connection') + '. Try again.', true); return; }
    var row = Array.isArray(r.data) ? r.data[0] : r.data;
    if (row) ivsCvs.push(row);
    ivsCvRefresh();
    kToast('CV saved — ' + f.name);
    ivsCvReadInto(candId, f);
  };
  rd.readAsDataURL(f);
}

// a CV has just been loaded: read the name and the email off it for the chef to check
async function ivsCvReadInto(candId, f){
  var kind = ivsCvKind(f.name, f.type);
  if (kind !== 'pdf' && kind !== 'docx') return;
  var cand = ivsRow(candId); if (!cand) return;
  ivsMailTried[candId] = true;
  var got = [], scanned = false;
  try {
    if (!(cand.name || '').trim() && !ivsNameT){
      var nm = await ivsReadName(f, kind);
      cand = ivsRow(candId);
      if (nm && cand && !(cand.name || '').trim() && !ivsNameT){
        cand.name = nm; ivsSave(candId, { name: nm }); got.push('name');
        var ni = document.getElementById('ivs-name');
        if (ni && ivsSel === candId && !ni.value.trim()) ni.value = nm;   // empty box, focused or not ("+ Add" leaves the cursor in it)
        ivsRenderList();
      }
    }
    var mail = await ivsReadEmail(f, kind, (ivsRow(candId) || {}).name);
    if (ivsMailApply(candId, mail)) got.push('email');
    else if (!mail && kind === 'pdf') scanned = await ivsMailScanFor(candId, f, (ivsRow(candId) || {}).name);
  } catch(e){ /* unreadable here — the chef types them */ }
  if (got.length) kToast('Read from the CV: ' + got.join(' and ') + ' — check ' + (got.length > 1 ? 'them' : 'it') + '.');
  else if (!scanned && ivsSel === candId && !((ivsRow(candId) || {}).email || '').trim()){
    var hint = document.getElementById('ivs-mailhint'); if (hint) hint.textContent = 'No email found on the CV — type it here.';
  }
}

async function ivsCvDelete(id){
  var c = ivsCvs.filter(function(x){ return x.id === id; })[0]; if (!c) return;
  if (!(await ivsAsk({ title:'Remove this CV?', body:c.filename + ' is removed for all four interviewers.', ok:'Remove', danger:true }))) return;
  var r = await sb.rpc('interview_cv_delete', { p_code: ivsCode, p_id: id });
  if (r.error){ kToast('Not removed — ' + (r.error.message || 'no connection'), true); return; }
  ivsCvs = ivsCvs.filter(function(x){ return x.id !== id; });
  ivsCvRefresh();
}

function ivsViewerClose(){
  var v = document.getElementById('ivs-viewer');
  if (v){ if (v._url) URL.revokeObjectURL(v._url); v.remove(); }
  document.removeEventListener('keydown', ivsViewerKey);
}
function ivsViewerKey(e){ if (e.key === 'Escape') ivsViewerClose(); }

async function ivsCvView(id){
  var c = ivsCvs.concat(ivsShelfCvs()).filter(function(x){ return x.id === id; })[0]; if (!c) return;
  ivsViewerClose();
  var kind = ivsCvKind(c.filename, c.mime);
  var v = document.createElement('div'); v.id = 'ivs-viewer';
  v.innerHTML = '<div class="bar"><b>'+ivsEsc(c.filename)+'</b><span id="ivs-dl"></span>'+
    '<button onclick="ivsViewerClose()">Close</button></div><div class="body"><div class="msg">Opening the CV…</div></div>';
  document.body.appendChild(v);
  document.addEventListener('keydown', ivsViewerKey);
  var body = v.querySelector('.body');

  var r = await sb.rpc('interview_cv_get', { p_code: ivsCode, p_id: id });
  if (!document.body.contains(v)) return;
  if (r.error){ body.innerHTML = '<div class="msg">Could not open it — '+ivsEsc(r.error.message || 'no connection')+'.</div>'; return; }
  var bin = atob(r.data), bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  var mime = c.mime || ({pdf:'application/pdf', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc:'application/msword'})[kind] || 'application/octet-stream';
  v._url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  v.querySelector('#ivs-dl').innerHTML = '<a href="'+v._url+'" download="'+ivsEsc(c.filename)+'">Download</a>';

  try {
    if (kind === 'image'){
      body.innerHTML = '<img class="page" alt="CV" src="'+v._url+'">';
    } else if (kind === 'pdf'){
      var P = await ivsLib('lib/pdf.min.js', 'pdfjsLib');
      try { P.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js'; } catch(e){}
      var pdf = await P.getDocument({ data: bytes.slice() }).promise;
      body.innerHTML = '';
      for (var pg = 1; pg <= pdf.numPages; pg++){
        if (!document.body.contains(v)) return;
        var page = await pdf.getPage(pg);
        var vp = page.getViewport({ scale: 2 });
        var cv = document.createElement('canvas');
        cv.className = 'page'; cv.width = vp.width; cv.height = vp.height;
        body.appendChild(cv);
        await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
      }
    } else if (kind === 'docx'){
      var M = await ivsLib(IVS_MAMMOTH, 'mammoth');
      var out = await M.convertToHtml({ arrayBuffer: bytes.buffer });
      var d = document.createElement('div'); d.className = 'doc';
      d.innerHTML = out.value || '<p><i>This Word file has no readable text.</i></p>';
      d.querySelectorAll('script,iframe,object,embed,link,style').forEach(function(x){ x.remove(); });
      d.querySelectorAll('*').forEach(function(x){
        [].slice.call(x.attributes).forEach(function(a){
          if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) x.removeAttribute(a.name);
        });
      });
      body.innerHTML = ''; body.appendChild(d);
    } else {
      body.innerHTML = '<div class="msg"><b>This is an old Word file (.doc).</b> A browser cannot show it. '+
        'Tap <b>Download</b> above to open it in Word, or ask the candidate for a PDF.</div>';
    }
  } catch(e){
    body.innerHTML = '<div class="msg">This file could not be shown here ('+ivsEsc(e && e.message || 'unknown error')+'). '+
      'Tap <b>Download</b> above to open it.</div>';
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Bulk CVs — a folder (or a pile of files) in, one candidate per CV out.
// Nothing is written until the chef has seen every name and pressed Add.
// ══════════════════════════════════════════════════════════════════════════
var IVS_NOT_NAME = ['resume','curriculum','vitae','cv','biodata','profile','objective','contact','summary',
  'personal','details','detail','information','info','experience','education','skills','career','address',
  'email','phone','mobile','nationality','reference','references','declaration','languages','hobbies',
  'commis','chef','cook','kitchen','helper','steward','dubai','uae','name','job','new','seeking','position',
  'application','cover','letter','hotel','restaurant','cuisine','dining','and','the','with','for','exposure'];   // never countries: "Dhanraj Nepal" is a name

function ivsPdf(){
  return ivsLib('lib/pdf.min.js', 'pdfjsLib').then(function(P){
    try { P.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js'; } catch(e){}
    return P;
  });
}

// "BHUP BAHADUR" -> "Bhup Bahadur"; initials such as "B.K" or "S." stay as they are
function ivsTitle(s){
  var t = String(s||'').replace(/\s+/g, ' ').trim();
  var letters = t.replace(/[^A-Za-z]/g, '');
  if (letters !== letters.toUpperCase() && letters !== letters.toLowerCase()) return t;   // already mixed case
  return t.split(' ').map(function(w){
    return w.replace(/[^A-Za-z]/g, '').length <= 2 && /[.]/.test(w) ? w.toUpperCase()
      : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}
// a line that could be a person's name: 2-5 words of letters, no digits, no CV headings
function ivsNameish(line){
  var t = String(line||'').replace(/\s+/g, ' ').trim();
  if (t.length < 4 || t.length > 48) return '';
  if (!/^[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ.'’\- ]+$/.test(t)) return '';
  var words = t.split(' ');
  if (words.length < 2 || words.length > 5) return '';
  if (/[A-Za-z]{3,}\.$/.test(t)) return '';                 // ends like a sentence, not like "S." or "B.K."
  if (words.some(function(w){ return IVS_NOT_NAME.indexOf(w.toLowerCase().replace(/[^a-z]/g, '')) >= 0; })) return '';
  return t;
}
// "Name: John Doe" beats any guess
function ivsLabelledName(lines){
  for (var i = 0; i < lines.length; i++){
    var m = /^\s*(full\s+)?name\s*[:\-]\s*(.+)$/i.exec(lines[i]);
    if (m && ivsNameish(m[2])) return ivsNameish(m[2]);
  }
  return '';
}
// the file name as a last resort: "ResumeJamilKajumba.pdf" -> "Jamil Kajumba"
function ivsNameFromFile(fn){
  var t = String(fn||'').replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-.,+()\[\]]+/g, ' ').replace(/\d+/g, ' ');
  t = t.split(/\s+/).filter(function(w){
    return w && ['resume','cv','curriculum','vitae','final','updated','new','copy','of'].indexOf(w.toLowerCase()) < 0;
  }).join(' ');
  t = t.replace(/^(resume|cv)(?=[A-Z])/i, '');
  return ivsTitle(t);
}

// How many of the line's words also sit in the file name. "ResumeDhanrajNepal.pdf"
// backs "DHANRAJ NEPAL" and not the heading "Italian Fine Dining" in bigger type.
function ivsFileHits(text, fn){
  var f = ivsNorm(fn).replace(/ /g, '');
  // 4+ letters: "new" in "Someone new.pdf" must not crown the heading "New Job"
  return ivsNorm(text).split(' ').filter(function(w){ return w.length >= 4 && f.indexOf(w) >= 0; }).length;
}
// most file-name words, then biggest type, then more of the name, then nearest the top
function ivsBestName(cands, fn){
  var best = null;
  cands.forEach(function(c){
    var t = ivsNameish(c.text); if (!t) return;
    c.hits = ivsFileHits(t, fn); c.words = t.split(' ').length; c.text = t;
    if (!best || c.hits > best.hits || (c.hits === best.hits && (c.size > best.size ||
        (c.size === best.size && (c.words > best.words || (c.words === best.words && c.y > best.y)))))) best = c;
  });
  // no line agrees with the file name, but the file name is itself a clean name: trust it
  var fromFile = ivsNameish(ivsNameFromFile(fn));
  if (fromFile && (!best || (!best.hits && ivsFileHits(fromFile, fn) >= 2))) return fromFile;
  return best ? best.text : '';
}

async function ivsReadName(file, kind){
  if (kind === 'pdf'){
    var P = await ivsPdf();
    var pdf = await P.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    try {
      var page = await pdf.getPage(1), tc = await page.getTextContent(), byY = {};
      // one line per baseline, whatever the type size ("YOGENDERA" 15pt + "SINGH" 16pt)
      tc.items.forEach(function(it){
        if (!it.str || !it.str.trim()) return;
        var size = Math.round(Math.hypot(it.transform[2], it.transform[3]) * 2) / 2 || Math.round(it.height);
        var y = Math.round(it.transform[5]);
        var L = byY[y] || byY[y-1] || byY[y+1];
        if (!L){ L = byY[y] = { y: y, size: 0, parts: [] }; }
        L.size = Math.max(L.size, size);
        L.parts.push({ x: it.transform[4], s: it.str });
      });
      var lines = Object.keys(byY).map(function(k){
        var L = byY[k];
        L.text = L.parts.sort(function(a,b){ return a.x - b.x; }).map(function(p){ return p.s; }).join(' ').replace(/\s+/g, ' ').trim();
        if (/^([A-Za-z] )+[A-Za-z]$/.test(L.text)) L.text = L.text.replace(/ /g, '');   // "J O H N" letter-spaced
        return L;
      }).sort(function(a,b){ return b.y - a.y; });
      var lab = ivsLabelledName(lines.map(function(L){ return L.text; }));
      if (lab) return ivsTitle(lab);
      // a name set over two or three lines in the same type: "DHANRAJ" / "NEPAL"
      var cands = lines.map(function(L){ return { text: L.text, size: L.size, y: L.y }; });
      lines.forEach(function(L, i){
        var txt = L.text, last = L, joined = 0;
        for (var j = i + 1; j < lines.length && joined < 2; j++){
          var N = lines[j];
          if (last.y - N.y > L.size * 1.9) break;
          if (Math.abs(N.size - L.size) > 0.5) continue;   // a phone number in the next column, smaller type
          if (!/^[A-Za-zÀ-ɏ.'’\- ]+$/.test(N.text) || N.text.split(' ').length > 3) break;
          txt += ' ' + N.text; last = N; joined++;
          cands.push({ text: txt, size: L.size, y: L.y });
        }
      });
      var got = ivsBestName(cands, file.name);
      return got ? ivsTitle(got) : '';
    } finally { try { pdf.destroy(); } catch(e){} }
  }
  if (kind === 'docx'){
    var M = await ivsLib(IVS_MAMMOTH, 'mammoth');
    var out = await M.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    var ls = String(out.value || '').split(/\n+/).map(function(s){ return s.trim(); }).filter(Boolean).slice(0, 20);
    var l2 = ivsLabelledName(ls);
    if (l2) return ivsTitle(l2);
    // no type sizes in raw text: earlier lines rank higher
    var got2 = ivsBestName(ls.map(function(s, i){ return { text: s, size: 0, y: -i }; }), file.name);
    return got2 ? ivsTitle(got2) : '';
  }
  return '';
}

// ── the candidate's email, off the same CV ──
// Kept apart from the name reader on purpose: that one was tuned CV by CV and
// must not move. An address is either a mailto: link in the PDF or text shaped
// like one. CVs print "name @gmail.com" and "name@gmail. com", so the text is
// also searched with the gaps around @ and the dots closed up.
var IVS_MAIL_RE = /[A-Za-z0-9][A-Za-z0-9._+\-]*@[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}/g;
function ivsMailValid(e){
  var t = String(e||'').trim();
  if (!t || t.length > 200 || /\s/.test(t) || /\.\./.test(t) || /\.@/.test(t)) return false;
  var m = t.match(IVS_MAIL_RE);
  return !!(m && m.length === 1 && m[0] === t);
}
function ivsMailsIn(text){
  var t = String(text||''), out = [];
  function tight(s){ return s.replace(/\s*@\s*/g, '@').replace(/(@[A-Za-z0-9.\-]*[A-Za-z0-9])\s*\.\s*(com|net|org|ae|in|np|ph|pk|lk|bd|it|uk|co)\b/gi, '$1.$2'); }
  // "s r e e r a g @ g m a i l . c o m": a letter-spaced line, one character per word
  var spaced = t.replace(/(^|\s)((?:\S ){3,}\S)(?=\s|$)/g, function(m, a, run){ return a + run.replace(/ /g, ''); });
  [t, tight(t), tight(spaced)].forEach(function(v){
    (v.match(IVS_MAIL_RE) || []).forEach(function(m){
      m = m.replace(/^[._\-]+/, '').replace(/[.\-]+$/, '').toLowerCase();
      if (ivsMailValid(m) && out.indexOf(m) < 0) out.push(m);
    });
  });
  return out;
}
// first page first; an address carrying one of the candidate's names beats a referee's
function ivsBestMail(found, name){
  if (!found.length) return '';
  var words = ivsNorm(name).split(' ').filter(function(w){ return w.length >= 3; });
  var best = null;
  found.forEach(function(f, i){
    var local = f.mail.split('@')[0].replace(/[^a-z]/g, '');
    var hits = words.filter(function(w){ return local.indexOf(w) >= 0; }).length;
    var score = (hits ? 100 : 0) - f.page * 10 - i * 0.01;
    if (!best || score > best.score) best = { mail: f.mail, score: score };
  });
  return best.mail;
}
async function ivsReadEmail(file, kind, name){
  var found = [];
  if (kind === 'pdf'){
    var P = await ivsPdf();
    var pdf = await P.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    try {
      for (var pg = 1; pg <= Math.min(3, pdf.numPages); pg++){
        var page = await pdf.getPage(pg);
        var ann = []; try { ann = await page.getAnnotations(); } catch(e){}
        ann.forEach(function(a){
          var u = a && (a.url || a.unsafeUrl) || '';
          if (/^mailto:/i.test(u)) ivsMailsIn(decodeURIComponent(u.replace(/^mailto:/i, '').split('?')[0])).forEach(function(m){ found.push({ mail:m, page:pg }); });
        });
        var tc = await page.getTextContent(), byY = {};
        tc.items.forEach(function(it){
          if (!it.str) return;
          var y = Math.round(it.transform[5]);
          var L = byY[y] || byY[y-1] || byY[y+1];
          if (!L){ L = byY[y] = { y:y, parts:[] }; }
          L.parts.push({ x: it.transform[4], w: it.width || 0, s: it.str, h: Math.hypot(it.transform[2], it.transform[3]) || it.height || 10 });
        });
        var rows = Object.keys(byY).map(function(k){ return byY[k]; }).sort(function(a,b){ return b.y - a.y; });
        rows.forEach(function(L){
          var txt = '', end = null, toks = [], cur = null;
          L.h = 10;
          L.parts.sort(function(a,b){ return a.x - b.x; }).forEach(function(p){
            // pieces of one word arrive as separate items: close the gap when there is none on the page
            var gap = !(end === null || p.x - end < p.h * 0.18);
            txt += (gap ? ' ' : '') + p.s;
            end = p.x + p.w; L.h = p.h;
            // the same line as words with where they start, for an address that wraps onto the next line
            var bits = p.s.split(/(\s+)/), at = 0, len = p.s.length || 1;
            bits.forEach(function(b){
              var bx = p.x + p.w * at / len; at += b.length;
              if (/^\s+$/.test(b)){ cur = null; return; }
              if (!b) return;
              if (!cur || (gap && at - b.length === 0)){ cur = { s:'', x:bx }; toks.push(cur); }
              cur.s += b;
            });
            if (/\s$/.test(p.s)) cur = null;
          });
          L.toks = toks;
          ivsMailsIn(txt).forEach(function(m){ found.push({ mail:m, page:pg }); });
        });
        // "mongarcia30146@" with "gmail.com" under it: a narrow column wrapped the address
        rows.forEach(function(L, i){
          L.toks.forEach(function(T){
            var head = /@$/.test(T.s) || /@[^@]*\.$/.test(T.s);
            for (var j = i + 1; j < rows.length && L.y - rows[j].y <= L.h * 2.6; j++){
              var U = null;
              rows[j].toks.forEach(function(k){ if (Math.abs(k.x - T.x) <= L.h * 2 && (!U || Math.abs(k.x - T.x) < Math.abs(U.x - T.x))) U = k; });
              if (!U) continue;
              if (head || /^@/.test(U.s)) ivsMailsIn(T.s + U.s).forEach(function(m){ found.push({ mail:m, page:pg }); });
              break;
            }
          });
        });
      }
    } finally { try { pdf.destroy(); } catch(e){} }
  } else if (kind === 'docx'){
    var M = await ivsLib(IVS_MAMMOTH, 'mammoth');
    var buf = await file.arrayBuffer();
    var out = await M.extractRawText({ arrayBuffer: buf });
    ivsMailsIn(out.value).forEach(function(m){ found.push({ mail:m, page:1 }); });
    if (!found.length){                                 // an address kept only as a link
      try {
        var html = await M.convertToHtml({ arrayBuffer: buf });
        (String(html.value).match(/mailto:[^"'?\s<>]+/gi) || []).forEach(function(u){
          ivsMailsIn(decodeURIComponent(u.replace(/^mailto:/i, ''))).forEach(function(m){ found.push({ mail:m, page:1 }); });
        });
      } catch(e){}
    }
  }
  return ivsBestMail(found, name || ivsNameFromFile(file.name));
}

// a scanned CV has no text at all: read the picture. OCR mixes up 1/l and q/g (measured on the
// board's 4 scans: 2 of 4 wrong), so the answer comes back WITH the strip of the page it was read
// from — the chef compares the two and taps; nothing is saved from here on its own.
async function ivsReadEmailScan(file, name){
  var P = await ivsPdf();
  var pdf = await P.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  var hits = [], worker = null;
  try {
    for (var pg = 1; pg <= Math.min(2, pdf.numPages); pg++){
      var page = await pdf.getPage(pg);
      var tc = await page.getTextContent();
      if (tc.items.some(function(it){ return (it.str || '').trim(); })) return null;   // it has text: not a scan
      var vp = page.getViewport({ scale: 200 / 72 });
      var cv = document.createElement('canvas');
      cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
      var cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: cx, viewport: vp }).promise;
      if (!worker){
        var T = await ivsLib(IVS_OCR, 'Tesseract');
        worker = await T.createWorker('eng', 1, { langPath: IVS_OCR_LANG });
      }
      var r = await worker.recognize(cv);
      (r.data.lines || []).forEach(function(L){
        ivsMailsIn(L.text).forEach(function(m){ hits.push({ mail:m, page:pg, b:ivsScanBox(L, m), cv:cv }); });
      });
      if (hits.length) break;
    }
  } finally {
    try { pdf.destroy(); } catch(e){}
    if (worker) try { worker.terminate(); } catch(e){}
  }
  if (!hits.length) return { mail:'', img:'' };
  var best = ivsBestMail(hits, name || ivsNameFromFile(file.name));
  var h = hits.filter(function(x){ return x.mail === best; })[0];
  var pad = 14, x0 = Math.max(0, h.b.x0 - pad), y0 = Math.max(0, h.b.y0 - pad);
  var cw = Math.min(h.cv.width, h.b.x1 + pad) - x0, ch = Math.min(h.cv.height, h.b.y1 + pad) - y0;
  var strip = document.createElement('canvas'); strip.width = cw; strip.height = ch;
  strip.getContext('2d').drawImage(h.cv, x0, y0, cw, ch, 0, 0, cw, ch);
  return { mail: best, img: strip.toDataURL('image/png') };
}
// the picture shows the address alone: a scanned "line" can run across both columns of the page
function ivsScanBox(L, mail){
  var ws = (L.words || []).filter(function(w){ return (w.text || '').trim(); });
  var i = -1, local = mail.split('@')[0];
  ws.forEach(function(w, k){ if (i < 0 && w.text.indexOf('@') >= 0) i = k; });
  if (i < 0) return L.bbox;
  var b = { x0: ws[i].bbox.x0, y0: ws[i].bbox.y0, x1: ws[i].bbox.x1, y1: ws[i].bbox.y1 };
  var h = Math.max(8, b.y1 - b.y0), txt = ws[i].text.toLowerCase();
  // "a1 products 1286@gmail.com": the name part may have been read as more than one word
  for (var k = i - 1; k >= 0 && txt.split('@')[0].length < local.length; k--){
    if (b.x0 - ws[k].bbox.x1 > h * 1.2) break;
    txt = ws[k].text.toLowerCase() + txt;
    b.x0 = Math.min(b.x0, ws[k].bbox.x0); b.y0 = Math.min(b.y0, ws[k].bbox.y0); b.y1 = Math.max(b.y1, ws[k].bbox.y1);
  }
  for (var j = i + 1; j < ws.length && !/\.[a-z]{2,}$/i.test(txt); j++){
    if (ws[j].bbox.x0 - b.x1 > h * 1.2) break;
    txt += ws[j].text.toLowerCase();
    b.x1 = Math.max(b.x1, ws[j].bbox.x1); b.y0 = Math.min(b.y0, ws[j].bbox.y0); b.y1 = Math.max(b.y1, ws[j].bbox.y1);
  }
  return b;
}
async function ivsMailScanFor(candId, file, name){
  var hint = document.getElementById('ivs-mailhint');
  if (hint && ivsSel === candId) hint.textContent = 'This CV is a scanned picture — reading it…';
  var res = null;
  try { res = await ivsReadEmailScan(file, name); } catch(e){ res = null; }
  var row = ivsRow(candId);
  if (!res || !row) return false;
  if (res.mail) ivsMailScan[candId] = res;
  if (ivsSel === candId){
    var el = document.getElementById('ivs-mailscan'); if (el) el.outerHTML = ivsMailScanHtml(row);
    hint = document.getElementById('ivs-mailhint');
    if (hint) hint.textContent = (row.email || '').trim() ? ivsMailHint(row)
      : res.mail ? '' : 'No email found on the scanned CV — type it here.';
  }
  return true;
}
function ivsMailScanHtml(r){
  var s = r && ivsMailScan[r.id];
  if (!s || (r.email || '').trim()) return '<div id="ivs-mailscan" hidden></div>';
  return '<div id="ivs-mailscan" class="ivscan">'+
    '<div class="t">The CV is a scanned picture. Compare the address with the picture, letter by letter:</div>'+
    '<img src="'+s.img+'" alt="The email line on the CV">'+
    '<div class="row"><b>'+ivsEsc(s.mail)+'</b>'+
    '<button type="button" class="v" onclick="ivsMailScanUse(\''+r.id+'\')">Use this address</button></div>'+
    '<div class="t">If one letter is different, type the address in the box above instead.</div></div>';
}
function ivsMailScanUse(candId){
  var s = ivsMailScan[candId], row = ivsRow(candId);
  if (!s || !row) return;
  delete ivsMailScan[candId];
  row.email = s.mail;
  ivsSave(candId, { email: s.mail });
  ivsHistLoad(candId);
  var inp = document.getElementById('ivs-d-email'); if (inp) inp.value = s.mail;
  var el = document.getElementById('ivs-mailscan'); if (el) el.outerHTML = ivsMailScanHtml(row);
  var hint = document.getElementById('ivs-mailhint'); if (hint) hint.textContent = '';
}

function ivsMailHint(r){
  if (!r) return '';
  if (r.email && ivsMailRead[r.id]) return 'Read from the CV — check it before sending anything.';
  if (r.email && !ivsMailValid(r.email)) return 'This does not look like an email address.';
  return '';
}
// put an address found on a CV onto the sheet — never over one that is already there
function ivsMailApply(candId, mail){
  var row = ivsRow(candId);
  if (!row || !mail || (row.email || '').trim() || ivsDetT.email) return false;
  row.email = mail; ivsMailRead[candId] = true;
  ivsSave(candId, { email: mail });
  ivsHistLoad(candId);
  if (ivsSel === candId){
    var inp = document.getElementById('ivs-d-email');
    if (inp && !inp.value.trim()) inp.value = mail;
    var hint = document.getElementById('ivs-mailhint'); if (hint) hint.textContent = ivsMailHint(row);
  }
  return true;
}
// a CV loaded before the email was read: look once, when the candidate is opened
async function ivsMailBackfill(candId){
  var row = ivsRow(candId);
  if (!row || (row.email || '').trim() || ivsMailTried[candId]) return;
  var cv = ivsCvsFor(candId).filter(function(c){ var k = ivsCvKind(c.filename, c.mime); return k === 'pdf' || k === 'docx'; })[0];
  if (!cv) return;
  ivsMailTried[candId] = true;
  var hint = document.getElementById('ivs-mailhint');
  if (hint && ivsSel === candId) hint.textContent = 'Looking for the email on the CV…';
  var mail = '', file = null, kind = ivsCvKind(cv.filename, cv.mime);
  try {
    var r = await sb.rpc('interview_cv_get', { p_code: ivsCode, p_id: cv.id });
    if (r.error) throw r.error;
    var bin = atob(r.data), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    file = new File([bytes], cv.filename);
    mail = await ivsReadEmail(file, kind, row.name);
  } catch(e){ delete ivsMailTried[candId]; }                // no connection: try again next time
  var ok = ivsMailApply(candId, mail);
  if (!ok && !mail && file && kind === 'pdf' && await ivsMailScanFor(candId, file, row.name)) return;
  hint = document.getElementById('ivs-mailhint');
  if (hint && ivsSel === candId && !ok){
    var now = ivsRow(candId);
    hint.textContent = now && now.email ? ivsMailHint(now) : 'No email found on the CV — type it here.';
  }
}

// everything a dropped folder holds, subfolders included
function ivsEntryFiles(entry){
  return new Promise(function(resolve){
    if (entry.isFile){
      entry.file(function(f){
        try { Object.defineProperty(f, 'ivsPath', { value: (entry.fullPath || f.name).replace(/^\//, '') }); } catch(e){}
        resolve([f]);
      }, function(){ resolve([]); });
      return;
    }
    if (!entry.isDirectory){ resolve([]); return; }
    var rd = entry.createReader(), got = [];
    (function more(){
      rd.readEntries(async function(ents){
        if (!ents.length){
          var lists = [];
          for (var i = 0; i < got.length; i++) lists.push(await ivsEntryFiles(got[i]));
          resolve([].concat.apply([], lists));
          return;
        }
        got = got.concat([].slice.call(ents)); more();
      }, function(){ resolve([]); });
    })();
  });
}

function ivsBulkOpen(){
  if (ivsBulk) return;
  ivsBulk = { rows: [], reading: false, running: false, stopped: false, wave: (ivsFolderQ !== IVS_NOFOLDER && ivsFolderQ) || '', seq: 0 };
  var v = document.createElement('div'); v.id = 'ivs-bulk';
  v.setAttribute('role', 'dialog'); v.setAttribute('aria-label', 'Add CVs in bulk');
  document.body.appendChild(v);
  document.addEventListener('keydown', ivsBulkKey);
  ivsBulkRender();
}
function ivsBulkKey(e){ if (e.key === 'Escape' && !(e.target && e.target.closest && e.target.closest('.ivbkr'))) ivsBulkClose(); }
async function ivsBulkClose(force){
  var b = ivsBulk;
  if (!b) return;
  if (!force && b.running){
    if (!(await ivsAsk({ title:'CVs are still uploading', body:'Stop after the one in progress? The ones already added stay on the board.', ok:'Stop uploading', cancel:'Keep going' }))) return;
    b.stopped = true; return;
  }
  if (!force && !b.running && b.rows.some(function(r){ return r.state === 'ready'; }) &&
      !(await ivsAsk({ title:'Close without adding these CVs?', ok:'Close', cancel:'Go back' }))) return;
  if (ivsBulk !== b) return;
  ivsBulk = null;
  var v = document.getElementById('ivs-bulk'); if (v) v.remove();
  document.removeEventListener('keydown', ivsBulkKey);
  ivsRenderList();
}

function ivsCvDupe(file){
  var fn = file.name.toLowerCase();
  return ivsCvs.filter(function(c){ return String(c.filename).toLowerCase() === fn && +c.size_bytes === file.size; })[0] || null;
}
function ivsCandByName(name){
  var n = ivsNorm(name); if (!n) return null;
  return ivsRows.filter(function(r){ return ivsNorm(r.name) === n; })[0] || null;
}

// what will happen to this row if Add is pressed — worked out again every time a name changes
function ivsBulkPlan(row){
  if (row.state === 'done' || row.state === 'run' || row.state === 'fail') return;
  if (row.problem){ row.state = 'bad'; return; }
  var dupe = ivsCvDupe(row.file);
  if (dupe){
    var owner = ivsRow(dupe.candidate_id);
    row.state = 'skip'; row.note = 'Already on the board' + (owner ? ' — ' + ivsCandLabel(owner) : ''); return;
  }
  var twin = ivsBulk.rows.filter(function(o){
    return o !== row && o.seq < row.seq && !o.problem && o.file.name.toLowerCase() === row.file.name.toLowerCase() && o.file.size === row.file.size;
  })[0];
  if (twin){ row.state = 'skip'; row.note = 'Same file twice in this folder'; return; }
  if (!row.left) {
    var name = (row.name || '').trim();
    if (!name){ row.state = 'bad'; row.note = 'Type the candidate’s name'; return; }
    var ex = ivsCandByName(name);
    row.state = 'ready';
    row.note = ex ? 'CV goes to ' + ivsCandLabel(ex) + ' (already on the board)' : 'New candidate';
    var ns = ivsFlagFor({ id: ex ? ex.id : '', name: name, email: ex ? ex.email : '' })[0];
    if (ns) row.note += ' — ⚑ did not show up before (' + (ns.round_title || 'another round') + ')';
    row.cls = ex ? 'add' : 'new';
  } else { row.state = 'skip'; row.note = 'Left out'; }
}

async function ivsBulkAddFiles(list){
  var b = ivsBulk; if (!b || b.running) return;
  var files = [].slice.call(list || []);
  if (!files.length) return;
  files.forEach(function(f){
    var kind = ivsCvKind(f.name, f.type), row = { seq: ++b.seq, file: f, kind: kind, path: f.ivsPath || f.webkitRelativePath || f.name,
      name: ivsNameFromFile(f.name), edited: false, reading: !!kind && (kind === 'pdf' || kind === 'docx') && f.size <= IVS_CV_MAX };
    if (/^\./.test(f.name) || /^~\$/.test(f.name)) return;       // .DS_Store, Word lock files
    if (!kind) row.problem = 'Not a CV file — skipped';
    else if (f.size > IVS_CV_MAX) row.problem = 'Over 8 MB (' + ivsKb(f.size) + ') — save it smaller';
    else if (!f.size) row.problem = 'Empty file';
    if (row.problem){ row.note = row.problem; row.reading = false; }
    b.rows.push(row);
  });
  b.rows.forEach(ivsBulkPlan);
  ivsBulkRender();
  if (b.reading) return;                                  // the loop already running picks the new rows up
  b.reading = true;
  for (;;){
    if (ivsBulk !== b) return;
    var next = b.rows.filter(function(r){ return r.reading; })[0];
    if (!next) break;
    try {
      var got = await ivsReadName(next.file, next.kind);
      if (got && !next.edited) next.name = got;
    } catch(e){ /* unreadable here — the file name stands and the chef can type it */ }
    try { next.email = await ivsReadEmail(next.file, next.kind, next.name); } catch(e){ next.email = ''; }
    next.reading = false;
    ivsBulkPlan(next);
    ivsBulkRender();
  }
  b.reading = false;
  b.rows.forEach(ivsBulkPlan);
  ivsBulkRender();
}

function ivsBulkPick(input){ var f = input.files; ivsBulkAddFiles(f); input.value = ''; }

async function ivsBulkDrop(e){
  e.preventDefault();
  var z = document.getElementById('ivs-drop'); if (z) z.classList.remove('over');
  var dt = e.dataTransfer; if (!dt) return;
  var items = dt.items ? [].slice.call(dt.items) : [];
  var entries = items.map(function(it){ return it.webkitGetAsEntry ? it.webkitGetAsEntry() : null; }).filter(Boolean);
  if (entries.length){
    var lists = [];
    for (var i = 0; i < entries.length; i++) lists.push(await ivsEntryFiles(entries[i]));
    ivsBulkAddFiles([].concat.apply([], lists));
  } else ivsBulkAddFiles(dt.files);
}
function ivsBulkOver(e, on){
  e.preventDefault();
  var z = document.getElementById('ivs-drop'); if (z) z.classList.toggle('over', on);
}

function ivsBulkName(el, seq){
  var row = ivsBulk && ivsBulk.rows.filter(function(r){ return r.seq === seq; })[0]; if (!row) return;
  row.name = el.value; row.edited = true;
  ivsBulkPlan(row);
  var st = document.getElementById('ivs-bst-' + seq);
  if (st){ st.className = 'st ' + ivsBulkCls(row); st.textContent = row.note || ''; }
  ivsBulkFoot();
}
function ivsBulkLeave(seq){
  var row = ivsBulk && ivsBulk.rows.filter(function(r){ return r.seq === seq; })[0]; if (!row) return;
  row.left = !row.left;
  if (!row.left) row.state = '';
  ivsBulkPlan(row); ivsBulkRender();
}
function ivsBulkCls(r){
  return r.reading ? 'run' : r.state === 'ready' ? (r.cls || 'new') : r.state === 'done' ? 'ok' : r.state === 'run' ? 'run'
    : r.state === 'fail' || r.state === 'bad' ? 'bad' : 'skip';
}

function ivsBulkCounts(){
  var b = ivsBulk, c = { ready:0, newc:0, attach:0, done:0, fail:0, skip:0, bad:0, reading:0 };
  b.rows.forEach(function(r){
    if (r.reading) c.reading++;
    if (r.state === 'ready'){ c.ready++; if (r.cls === 'add') c.attach++; else c.newc++; }
    else if (r.state === 'done') c.done++;
    else if (r.state === 'fail') c.fail++;
    else if (r.state === 'bad') c.bad++;
    else if (r.state === 'skip') c.skip++;
  });
  return c;
}
function ivsBulkFoot(){
  var el = document.getElementById('ivs-bft'); if (!el || !ivsBulk) return;
  el.outerHTML = ivsBulkFootHtml();
}
function ivsBulkFootHtml(){
  var b = ivsBulk, c = ivsBulkCounts(), bits = [];
  if (b.running){
    var total = c.ready + c.done + c.fail + b.rows.filter(function(r){ return r.state === 'run'; }).length;
    return '<div class="ivbkft" id="ivs-bft"><div class="sum"><b>Uploading '+(c.done + c.fail + 1 > total ? total : c.done + c.fail + 1)+' of '+total+'…</b> Keep this window open.</div>'+
      '<button class="ivb2" onclick="ivsBulkClose()">Stop</button></div>';
  }
  if (c.done) bits.push(c.done + ' added');
  if (c.fail) bits.push(c.fail + ' failed');
  if (c.newc) bits.push(c.newc + ' new candidate' + (c.newc === 1 ? '' : 's'));
  if (c.attach) bits.push(c.attach + ' CV' + (c.attach === 1 ? '' : 's') + ' for candidates already on the board');
  if (c.skip) bits.push(c.skip + ' skipped');
  if (c.bad) bits.push(c.bad + ' need' + (c.bad === 1 ? 's' : '') + ' attention');
  var label = c.reading ? 'Reading names… ' + c.reading + ' left'
    : c.ready ? 'Add ' + c.ready + ' CV' + (c.ready === 1 ? '' : 's') : (c.done || c.fail ? 'Done' : 'Add');
  var h = '<div class="ivbkft" id="ivs-bft"><div class="sum">'+ivsEsc(bits.join(' · ') || 'Nothing chosen yet.')+'</div>';
  if (c.fail) h += '<button class="ivb2" onclick="ivsBulkRetry()">Try the failed ones again</button>';
  if (!c.ready && (c.done || c.fail)) h += '<button class="ivb" onclick="ivsBulkClose(true)">Close</button>';
  else h += '<button class="ivb" '+(c.reading || !c.ready ? 'disabled' : '')+' onclick="ivsBulkRun()">'+ivsEsc(label)+'</button>';
  return h + '</div>';
}

function ivsBulkRender(){
  var v = document.getElementById('ivs-bulk'), b = ivsBulk;
  if (!v || !b) return;
  var keep = document.activeElement && document.activeElement.id && v.contains(document.activeElement) ? document.activeElement.id : null;
  var sy = v.querySelector('.body') ? v.querySelector('.body').scrollTop : 0;
  var folderOk = 'webkitdirectory' in document.createElement('input') && !window.matchMedia('(pointer:coarse)').matches;
  var accept = '.pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*';
  var h = '<div class="bar"><b>Add CVs in bulk</b><button onclick="ivsBulkClose()">'+(b.running ? 'Stop' : 'Close')+'</button></div>'+
    '<div class="body"><div class="ivbk">';
  if (!b.running){
    h += '<div class="ivdrop" id="ivs-drop" ondragover="ivsBulkOver(event,true)" ondragenter="ivsBulkOver(event,true)" ondragleave="ivsBulkOver(event,false)" ondrop="ivsBulkDrop(event)">'+
      '<p><b>'+(b.rows.length ? 'Add more CVs' : 'Choose the folder where the CVs are saved')+'</b><br>'+
      '<span style="font-size:13.5px;color:#6b5a48">'+(folderOk ? 'Or drag the folder or the files here. ' : 'Select them all at once. ')+'Word, PDF or photos, up to 8 MB each. '+
      'Each CV becomes one candidate — you check every name before anything is added.</span></p><div class="btns">'+
      (folderOk ? '<label class="ivb">Choose a folder<input type="file" webkitdirectory directory multiple onchange="ivsBulkPick(this)"></label>' : '')+
      '<label class="'+(folderOk ? 'ivb2' : 'ivb')+'">Choose files<input type="file" multiple accept="'+accept+'" onchange="ivsBulkPick(this)"></label>'+
      '</div></div>';
  }
  if (b.rows.length){
    h += '<div class="ivbkhd" style="margin-top:14px"><div class="msg">Check each name — it was read from the CV. Fix any that are wrong.</div>'+
      '<input class="ivsel" style="flex:1 1 220px;min-width:0" list="ivs-dl-folder-bulk" maxlength="80" autocomplete="off" aria-label="Folder for these candidates" placeholder="Folder — e.g. Monday 21st interview" '+(b.running?'disabled ':'')+'value="'+ivsEsc(b.wave)+'" oninput="ivsBulk.wave=this.value">'+
      '<datalist id="ivs-dl-folder-bulk">'+ivsFolders().map(function(f){ return '<option value="'+ivsEsc(f.name)+'">'; }).join('')+'</datalist></div>'+
      '<p class="ivnote" style="margin:0 0 6px">Every CV added now goes in that folder; a CV attached to a candidate already on the board keeps theirs.</p>';
    b.rows.forEach(function(r){
      var locked = b.running || r.problem || r.state === 'done' || r.state === 'run' || (r.state === 'skip' && !r.left) || r.left;
      var canLeave = !b.running && !r.problem && r.state !== 'done' && !(r.state === 'skip' && !r.left);
      h += '<div class="ivbkr"><div class="f">'+ivsEsc(r.path)+' · '+ivsKb(r.file.size)+'</div>'+
        '<input id="ivs-bn-'+r.seq+'" value="'+ivsEsc(r.name)+'" placeholder="Candidate name" aria-label="Candidate name for '+ivsEsc(r.file.name)+'" '+
          (locked ? 'disabled ' : '')+'oninput="ivsBulkName(this,'+r.seq+')" autocomplete="off">'+
        '<span class="st '+ivsBulkCls(r)+'" id="ivs-bst-'+r.seq+'">'+ivsEsc(r.reading ? 'Reading the name…' : (r.note || ''))+'</span>'+
        (canLeave ? '<button class="out" onclick="ivsBulkLeave('+r.seq+')">'+(r.left ? 'Put back' : 'Leave out')+'</button>' : '')+
        (!r.reading && !r.problem && (r.kind === 'pdf' || r.kind === 'docx') ? '<div class="em">'+(r.email ? 'Email on the CV: <b>'+ivsEsc(r.email)+'</b>' : 'No email found on this CV — type it on the candidate’s sheet.')+'</div>' : '')+
      '</div>';
    });
    h += ivsBulkFootHtml();
  }
  h += '</div></div>';
  v.innerHTML = h;
  var body = v.querySelector('.body'); if (body) body.scrollTop = sy;
  if (keep){ var k = document.getElementById(keep); if (k){ k.focus(); try { var n = k.value.length; k.setSelectionRange(n, n); } catch(e){} } }
}

function ivsB64(file){
  return new Promise(function(resolve, reject){
    var rd = new FileReader();
    rd.onerror = function(){ reject(new Error('could not read the file on this device')); };
    rd.onload = function(){ resolve(String(rd.result).split(',')[1] || ''); };
    rd.readAsDataURL(file);
  });
}

async function ivsBulkRun(){
  var b = ivsBulk; if (!b || b.running) return;
  b.rows.forEach(ivsBulkPlan);
  if (!b.rows.some(function(r){ return r.state === 'ready'; })) return;
  b.running = true; b.stopped = false;
  ivsBulkRender();
  for (var i = 0; i < b.rows.length; i++){
    var row = b.rows[i];
    if (ivsBulk !== b || b.stopped) break;
    ivsBulkPlan(row);                                  // a candidate added earlier in this run may now own this name
    if (row.state !== 'ready') continue;
    row.state = 'run'; row.note = 'Uploading…'; ivsBulkRender();
    try {
      if (!row.candId){
        var ex = ivsCandByName(row.name);
        if (ex) row.candId = ex.id;
        else {
          var a = await sb.rpc('interview_add', { p_code: ivsCode, p_event: IVS_EVENT, p_by: ivsMe || '' });
          if (a.error) throw a.error;
          var patch = { name: row.name.trim() }; if (b.wave.trim()) patch.wave = b.wave.trim().slice(0, 80);
          if (row.email){ patch.email = row.email; ivsMailRead[a.data.id] = true; }
          ivsPending[a.data.id] = 1;                   // the poll must not show it nameless meanwhile
          var fresh = Object.assign({}, a.data, patch);
          ivsRows.push(fresh);
          row.candId = a.data.id;
          var p = await sb.rpc('interview_patch', { p_code: ivsCode, p_id: a.data.id, p_patch: patch, p_by: ivsMe || '' });
          delete ivsPending[a.data.id];
          if (p.error) throw p.error;
          var k = ivsRows.findIndex(function(x){ return x.id === a.data.id; });
          if (k >= 0 && p.data) ivsRows[k] = p.data;
        }
      }
      var b64 = await ivsB64(row.file);
      var r = await sb.rpc('interview_cv_add', { p_code: ivsCode, p_candidate: row.candId,
        p_filename: row.file.name, p_mime: row.file.type || '', p_b64: b64 });
      if (r.error) throw r.error;
      var cvRow = Array.isArray(r.data) ? r.data[0] : r.data;
      if (cvRow) ivsCvs.push(cvRow);
      ivsMailTried[row.candId] = true;
      if (row.email) ivsMailApply(row.candId, row.email);   // a candidate already on the board with no email yet
      var owner = ivsRow(row.candId);
      row.state = 'done'; row.note = 'Added' + (owner ? ' — ' + ivsCandLabel(owner) : '');
    } catch(e){
      row.state = 'fail'; row.note = 'Not added — ' + ((e && e.message) || 'no connection');
    }
    if (ivsBulk === b){ ivsBulkRender(); ivsRenderList(); }
  }
  b.running = false;
  if (ivsBulk !== b) return;
  if (b.stopped) b.rows.forEach(function(r){ if (r.state === 'ready') { r.state = 'skip'; r.note = 'Not added — stopped'; r.left = true; } });
  ivsBulkRender(); ivsRenderList();
  var c = ivsBulkCounts();
  kToast(c.done + ' CV' + (c.done === 1 ? '' : 's') + ' added' + (c.fail ? ' · ' + c.fail + ' failed' : ''), !!c.fail);
}
function ivsBulkRetry(){
  if (!ivsBulk || ivsBulk.running) return;
  ivsBulk.rows.forEach(function(r){ if (r.state === 'fail'){ r.state = ''; ivsBulkPlan(r); } });
  ivsBulkRun();
}

// ══════════════════════════════════════════════════════════════════════════
// Candidate emails — Reject / Shortlist / Send to HR for hiring.
// Nothing here knows the wording or the HR addresses: the window asks the
// interview-email function for a preview and shows its answer.
// ══════════════════════════════════════════════════════════════════════════
function ivsActsFor(id){ return ivsActs.filter(function(a){ return a.candidate_id === id; }); }
function ivsWhen(iso){
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Dubai', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit', hour12:false }).format(new Date(iso));
  } catch(e){ return String(iso||'').slice(0,16).replace('T',' '); }
}
// the list and the leaderboard: the last email that really went
function ivsActLine(id){
  var sent = ivsActsFor(id).filter(function(a){ return a.status === 'sent'; });
  if (!sent.length) return '';
  var last = sent[sent.length - 1];
  return (IVS_ACTIONS[last.action] || {}).done + ' · ' + ivsWhen(last.created_at).split(',')[0];
}
function ivsDeliveryWord(a){
  var d = a.delivery || '';
  if (d === 'delivered') return 'delivered';
  if (d === 'bounced') return 'BOUNCED — the address is wrong or full';
  if (d === 'complained') return 'marked as spam by the recipient';
  if (d === 'delivery_delayed') return 'delayed — still trying';
  return '';
}
function ivsActsHtml(r){
  var list = ivsActsFor(r.id), hrNo = ivsHrBlock(r);
  var h = '<div class="ivacts" id="ivs-acts"><div class="hd"><b>Decision — send the email</b></div><div class="btns">'+
    '<button class="ivb2" onclick="ivsMailOpen(\'reject\')">'+IVS_ACTIONS.reject.btn+'</button>'+
    '<button class="ivb2" onclick="ivsMailOpen(\'shortlist\')">'+IVS_ACTIONS.shortlist.btn+'</button>'+
    '<button class="ivb2" onclick="ivsMailOpen(\'future\')">'+IVS_ACTIONS.future.btn+'</button>'+
    '<button class="ivb" '+(hrNo ? 'disabled aria-describedby="ivs-hrno" ' : '')+'onclick="ivsMailOpen(\'hr\')">'+IVS_ACTIONS.hr.btn+'</button></div>'+
    (hrNo ? '<div class="ivhrno" id="ivs-hrno">'+ivsEsc(hrNo)+'</div>' : '');
  list.forEach(function(a){
    var A = IVS_ACTIONS[a.action] || { done:a.action, btn:a.action };
    if (a.status === 'sent'){
      var dw = ivsDeliveryWord(a), bad = a.delivery === 'bounced' || a.delivery === 'complained';
      h += '<div class="ivactl'+(bad?' bad':'')+'"><b>'+ivsEsc(A.done)+'</b> — email sent '+ivsEsc(ivsWhen(a.created_at))+
        ' <span>to '+ivsEsc((a.sent_to||[]).join(', '))+(a.position ? ' · '+ivsEsc(a.position) : '')+(a.sent_by ? ' · by '+ivsEsc(a.sent_by) : '')+(a.is_test ? ' · TEST' : '')+'</span>'+
        (dw ? ' · <b>'+ivsEsc(dw)+'</b>' : '')+'</div>';
    } else {
      h += '<div class="ivactl bad"><b>'+ivsEsc(A.btn)+' — NOT sent</b> '+ivsEsc(ivsWhen(a.created_at))+' <span>'+ivsEsc(a.error || '')+'</span></div>';
    }
  });
  h += r.no_show_at
    ? '<div class="ivns on"><span><b>No show</b> — marked '+ivsEsc(ivsWhen(r.no_show_at))+(r.no_show_by ? ' by '+ivsEsc(r.no_show_by) : '')+'. Flagged if they apply again.</span>'+
      '<button type="button" class="ivb2" onclick="ivsNoShow(false)">Undo — they came</button></div>'
    : '<div class="ivns"><span>Did not turn up?</span><button type="button" class="ivb2" onclick="ivsNoShow(true)">Mark as no-show</button></div>';
  return h + '</div>';
}

// ── No show: the mark, and the red flag when the same person is on a board again ──
async function ivsNoShow(on){
  var row = ivsRow(ivsSel); if (!row) return;
  var id = row.id, keep = { at: row.no_show_at, by: row.no_show_by };
  row.no_show_at = on ? new Date().toISOString() : null; row.no_show_by = on ? (ivsMe || '') : null;
  ivsNoShows = ivsNoShows.filter(function(n){ return n.candidate_id !== id; });
  if (on) ivsNoShows.unshift({ candidate_id:id, event:IVS_EVENT, round_title:(ivsRound && ivsRound.title) || '', name:row.name || '', email:(row.email || '').trim().toLowerCase(), no_show_at:row.no_show_at, no_show_by:row.no_show_by });
  ivsRender(true);
  ivsPending[id] = (ivsPending[id] || 0) + 1;
  var q = await sb.rpc('interview_patch', { p_code: ivsCode, p_id: id, p_patch: { no_show: !!on }, p_by: ivsMe || '' });
  ivsPending[id]--; if (!ivsPending[id]) delete ivsPending[id];
  if (q.error){
    var back = ivsRow(id); if (back){ back.no_show_at = keep.at; back.no_show_by = keep.by; }
    kToast('Not saved — ' + (q.error.message || 'no connection') + '. Tap it again.', true);
    await ivsLoad(true); ivsRender(true); return;
  }
  await ivsLoad(true); ivsRender(true);
  kToast(on ? ivsCandLabel(row) + ' marked as no-show — flagged if they apply again.' : 'No-show mark taken off.');
}
// other candidates, in any round, marked no-show who look like this one: same email, or same full name
function ivsFlagFor(r){
  if (!r || !ivsNoShows.length) return [];
  var em = (r.email || '').trim().toLowerCase(), nm = ivsNorm(r.name);
  var nameOk = nm.split(' ').length >= 2;          // one word ("Ali") is not enough to call it the same person
  return ivsNoShows.filter(function(n){
    if (n.candidate_id === r.id) return false;
    return (ivsMailValid(em) && n.email === em) || (nameOk && ivsNorm(n.name) === nm);
  }).map(function(n){
    return Object.assign({ how: ivsMailValid(em) && n.email === em ? 'email' : 'name' }, n);
  });
}
function ivsFlagHtml(r){
  var f = ivsFlagFor(r); if (!f.length) return '';
  return '<div class="ivflag" role="alert"><b>⚑ Did not show up before</b> — '+f.map(function(n){
    return ivsEsc(n.round_title || 'another round')+', '+ivsEsc(ivsWhen(n.no_show_at).split(',')[0])+(n.no_show_by ? ' (marked by '+ivsEsc(n.no_show_by)+')' : '')+
      ' · '+(n.how === 'email' ? 'same email' : 'same name — check it is the same person');
  }).join('; ')+'.</div>';
}
function ivsActsRefresh(){
  var r = ivsRow(ivsSel), el = document.getElementById('ivs-acts');
  if (r && el) el.outerHTML = ivsActsHtml(r);
  ivsRenderList();
}

async function ivsMailCall(body){
  body.code = ivsCode;
  var res;
  try {
    res = await fetch(SUPABASE_URL + IVS_FN, { method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + SUPABASE_KEY, 'apikey': SUPABASE_KEY },
      body: JSON.stringify(body) });
  } catch(e){ return { status:0, data:{ error:'No connection — nothing was sent.' } }; }
  var data = {};
  try { data = await res.json(); } catch(e){}
  if (!res.ok && !data.error) data.error = data.message || ('The email service answered ' + res.status + '.');
  if (!res.ok && data.message && /read-only/i.test(data.error || '')) data.error = data.message;   // the DEV guard's own words
  return { status: res.status, data: data };
}

// ask now and then what happened to the emails already sent (delivered / bounced)
async function ivsMailStatus(){
  if (!ivsCode || Date.now() - ivsStatusAt < 60000) return;
  // only emails of the last day: one that never reports is not asked about for ever
  var open = ivsActs.some(function(a){ return a.status === 'sent' && a.resend_id && Date.now() - new Date(a.created_at).getTime() < 86400000 &&
    (!a.delivery || /^(sent|queued|scheduled|delivery_delayed)$/.test(a.delivery)); });
  if (!open) return;
  ivsStatusAt = Date.now();
  var r = await ivsMailCall({ mode:'status', event: IVS_EVENT });
  if (r.data && r.data.readable === false) ivsStatusAt = Date.now() + 3600000;   // this key cannot read deliveries: stop asking
}

function ivsMailOpen(action){
  var r = ivsRow(ivsSel); if (!r || ivsMail) return;
  if (action === 'hr' && ivsHrBlock(r)){ kToast(ivsHrBlock(r), true); return; }
  // anything typed on the sheet a moment ago goes to the database before the window opens
  ['email','position_applied'].forEach(function(k){ var el = document.getElementById('ivs-d-'+k); if (el) ivsDetailFlush(el); });
  if (ivsNameT){ clearTimeout(ivsNameT); ivsNameT = null; ivsSave(r.id, { name: r.name }); }
  ivsMail = { action: action, candId: r.id, step: 'form',
    name: (r.name || '').trim(), email: (r.email || '').trim(), position: (r.position_applied || '').trim(),
    fromCv: !!ivsMailRead[r.id], cvIds: ivsCvsFor(r.id).map(function(c){ return c.id; }),
    ev: ivsEvStart(r), problems: [], preview: null, again: false, error: '' };
  var v = document.createElement('div'); v.id = 'ivs-mail';
  v.setAttribute('role', 'dialog'); v.setAttribute('aria-label', IVS_ACTIONS[action].title);
  document.body.appendChild(v);
  document.addEventListener('keydown', ivsMailKey);
  ivsMailRender();
  var first = document.getElementById(!ivsMail.name ? 'ivs-m-name' : !ivsMail.email ? 'ivs-m-email' : !ivsMail.position ? 'ivs-m-position' : '');
  if (first) first.focus();
}
function ivsMailKey(e){ if (e.key === 'Escape') ivsMailClose(); }
function ivsMailClose(force){
  var m = ivsMail; if (!m) return;
  if (m.step === 'sending' && !force) return;
  ivsEvFlush();
  if (m.formUrl){ try { URL.revokeObjectURL(m.formUrl); } catch(e){} }
  ivsMail = null;
  var v = document.getElementById('ivs-mail'); if (v) v.remove();
  document.removeEventListener('keydown', ivsMailKey);
}
function ivsMailField(el){
  if (!ivsMail) return;
  ivsMail[el.getAttribute('data-f')] = el.value;
  if (el.getAttribute('data-f') === 'email') ivsMail.fromCv = false;
  el.classList.remove('bad');
}
function ivsMailCv(el, id){
  var m = ivsMail; if (!m) return;
  m.cvIds = m.cvIds.filter(function(x){ return x !== id; });
  if (el.checked) m.cvIds.push(id);
}
// what the form starts with: whatever is already saved on the candidate, else the
// two answers the button itself implies — a hiring request is "Hired", in the Kitchen
function ivsEvStart(r){
  var e = (r && r.evaluation) || {}, rt = e.ratings || {}, out = { interviewers: e.interviewers || ivsMe || '', decision: e.decision || 'hired',
    department: e.department || 'Kitchen', salary: e.salary || '', overall: e.overall || '', comments: e.comments || '', ratings: {} };
  IVS_EV_ROWS.forEach(function(row){ out.ratings[row[0]] = rt[row[0]] || (row[0] === 'r11' ? 'na' : ''); });
  return out;
}
function ivsEvLeft(ev){
  var n = IVS_EV_ROWS.filter(function(row){ return !ev.ratings[row[0]]; }).length;
  return n + (ev.overall ? 0 : 1);
}
// every answer is saved on the candidate as it is given — closing the window loses nothing
function ivsEvSave(patch){ if (ivsMail) ivsSave(ivsMail.candId, { evaluation: patch }); }
function ivsEvPaint(group, val){
  var box = document.querySelector('#ivs-mail [data-ev="'+group+'"]'); if (!box) return;
  box.querySelectorAll('button').forEach(function(b){ var on = b.getAttribute('data-v') === val; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  var card = box.closest('.ivev'); if (card && val) card.classList.remove('need');
  var pr = document.getElementById('ivs-evprog'); if (pr) pr.textContent = ivsEvProgress(ivsMail.ev);
}
function ivsEvProgress(ev){ var n = ivsEvLeft(ev); return n ? n + ' of 12 ratings still to give.' : 'All 12 ratings given.'; }
function ivsEvRate(key, val){
  var m = ivsMail; if (!m || m.step !== 'form') return;
  m.ev.ratings[key] = val; var r = {}; r[key] = val;
  ivsEvSave({ ratings: r }); ivsEvPaint(key, val);
}
function ivsEvPick(field, val){
  var m = ivsMail; if (!m || m.step !== 'form') return;
  m.ev[field] = val; var p = {}; p[field] = val;
  ivsEvSave(p); ivsEvPaint(field, val);
}
function ivsEvType(el){
  var m = ivsMail; if (!m) return;
  var f = el.getAttribute('data-e'); m.ev[f] = el.value; el.classList.remove('bad');
  if (f === 'comments'){ var c = document.getElementById('ivs-evcount'); if (c) c.textContent = el.value.length + ' / 600'; }
  clearTimeout(ivsEvT);
  ivsEvT = setTimeout(function(){ ivsEvT = null; if (ivsMail === m) ivsEvSave({ interviewers: m.ev.interviewers, department: m.ev.department, salary: m.ev.salary, comments: m.ev.comments }); }, 700);
}
function ivsEvFlush(){
  var m = ivsMail; if (!m || !ivsEvT) return;
  clearTimeout(ivsEvT); ivsEvT = null;
  ivsEvSave({ interviewers: m.ev.interviewers, department: m.ev.department, salary: m.ev.salary, comments: m.ev.comments });
}
function ivsEvButtons(group, cur, opts, handler){
  return '<div class="ivevb" data-ev="'+group+'" role="group">'+opts.map(function(o){
    return '<button type="button" data-v="'+o[0]+'" class="'+(cur===o[0]?'on':'')+'" aria-pressed="'+(cur===o[0])+'" onclick="'+handler+'(\''+group+'\',\''+o[0]+'\')">'+ivsEsc(o[1])+'</button>';
  }).join('')+'</div>';
}
// Recommended salary (22 Sep 2026): what the chef proposes to HR, typed as HR should read it; the
// candidate's own expectation (Details) sits under it for comparison. Required for Hired.
function ivsEvSalaryHtml(m, bad){
  var r = ivsRow(m.candId), exp = r && r.salary_expectation ? String(r.salary_expectation).trim() : '';
  return '<label class="ivdf"><span>Recommended salary</span><input id="ivs-e-salary" data-e="salary" maxlength="120" autocomplete="off" placeholder="e.g. AED 4,500 / month + accommodation" class="'+(bad.salary?'bad':'')+'" value="'+ivsEsc(m.ev.salary)+'" oninput="ivsEvType(this)" onchange="ivsEvFlush()">'+
    '<em>'+(exp ? 'Candidate expects: '+ivsEsc(exp) : 'No salary expectation on the candidate\u2019s details.')+'</em></label>';
}
function ivsEvFormHtml(m, bad){
  var ev = m.ev;
  var h = '<div class="ivmlsec">2 · Candidate Evaluation Form — fill it here</div>'+
    '<p class="lead" style="margin:4px 0 0">This is the hiring form HR receives, as a Word file, with your answers in it. HR is not emailed until it is complete.</p>'+
    '<label class="ivdf"><span>Name of interviewer(s)</span><input id="ivs-e-interviewers" data-e="interviewers" maxlength="160" autocomplete="off" placeholder="e.g. Andrea Falcone, Danilo Valla" class="'+(bad.interviewers?'bad':'')+'" value="'+ivsEsc(ev.interviewers)+'" oninput="ivsEvType(this)" onchange="ivsEvFlush()"></label>'+
    '<label class="ivdf"><span>Department</span><input id="ivs-e-department" data-e="department" maxlength="80" autocomplete="off" class="'+(bad.department?'bad':'')+'" value="'+ivsEsc(ev.department)+'" oninput="ivsEvType(this)" onchange="ivsEvFlush()"></label>'+
    ivsEvSalaryHtml(m, bad)+
    '<div class="ivev"><div class="q"><b>Decision</b><span>Ticked at the top of the form.</span></div>'+ivsEvButtons('decision', ev.decision, [['hired','Hired'],['hold','On Hold']], 'ivsEvPick')+'</div>';
  IVS_EV_ROWS.forEach(function(row){
    var opts = row[0] === 'r11' ? IVS_EV_RATES.concat([['na','Not applicable']]) : IVS_EV_RATES;
    h += '<div class="ivev'+(bad.ratings && !ev.ratings[row[0]] ? ' need' : '')+'"><div class="q"><b>'+ivsEsc(row[1])+'</b><span>'+ivsEsc(row[2])+'</span></div>'+ivsEvButtons(row[0], ev.ratings[row[0]], opts, 'ivsEvRate')+'</div>';
  });
  h += '<div class="ivev'+(bad.ratings && !ev.overall ? ' need' : '')+'"><div class="q"><b>Overall rating</b><span>Your own judgement — the app does not work it out.</span></div>'+ivsEvButtons('overall', ev.overall, IVS_EV_RATES, 'ivsEvPick')+'</div>'+
    '<div class="ivevprog" id="ivs-evprog">'+ivsEsc(ivsEvProgress(ev))+'</div>'+
    '<label class="ivdf"><span>General comments and recommendations</span><textarea id="ivs-e-comments" data-e="comments" maxlength="600" placeholder="Optional — what HR should know" oninput="ivsEvType(this)" onchange="ivsEvFlush()">'+ivsEsc(ev.comments)+'</textarea><em id="ivs-evcount">'+ev.comments.length+' / 600</em></label>'+
    '<p class="lead" style="margin:8px 0 0">Signature and date are filled with the interviewer name(s) and today’s date.</p>';
  return h;
}

// the same three checks the function makes — here only so the chef hears at once
function ivsMailLocalProblems(m){
  var p = [];
  if (!m.name.trim() || /^unnamed candidate$/i.test(m.name.trim())) p.push(['name', 'The candidate’s name is missing.']);
  else if (/[@\d<>]/.test(m.name) || m.name.replace(/[^A-Za-zÀ-ɏ]/g, '').length < 2) p.push(['name', 'The name does not look like a person’s name.']);
  if (!m.email.trim()) p.push(['email', 'The candidate’s email address is missing.']);
  else if (!ivsMailValid(m.email)) p.push(['email', 'The email address does not look right.']);
  if (m.position.trim().replace(/[^A-Za-zÀ-ɏ]/g, '').length < 2) p.push(['position', m.position.trim() ? 'The position does not look right.' : 'The position is missing — type it.']);
  if (m.action === 'hr'){
    var hrNo = ivsHrBlock(ivsRow(m.candId)); if (hrNo) p.push(['score', hrNo]);
    if (!m.cvIds.length) p.push(['cv', ivsCvsFor(m.candId).length ? 'Tick the CV to send.' : 'No CV is attached. Close this window and upload the candidate’s CV first.']);
    if (m.ev.interviewers.replace(/[^A-Za-zÀ-ɏ]/g, '').length < 2) p.push(['interviewers', 'Evaluation form: type the name of the interviewer(s).']);
    if (m.ev.department.replace(/[^A-Za-zÀ-ɏ]/g, '').length < 2) p.push(['department', 'Evaluation form: the department is missing.']);
    if (m.ev.decision === 'hired' && !/\d/.test(m.ev.salary || '')) p.push(['salary', 'Evaluation form: type the recommended salary.']);
    if (ivsEvLeft(m.ev)) p.push(['ratings', 'Evaluation form: ' + ivsEvProgress(m.ev) + ' They are marked in red — HR is not emailed with a blank rating.']);
  }
  return p;
}
function ivsMailBody(m){
  var b = { action: m.action, candidate_id: m.candId, name: m.name.trim(), email: m.email.trim(), position: m.position.trim(), sent_by: ivsMe || '' };
  if (m.action === 'hr'){ b.cv_ids = m.cvIds.slice(); b.evaluation = m.ev; }
  return b;
}

async function ivsMailPreview(){
  var m = ivsMail; if (!m || m.step !== 'form') return;
  m.name = m.name.replace(/\s+/g, ' ').trim(); m.email = m.email.trim(); m.position = m.position.replace(/\s+/g, ' ').trim();
  ivsEvFlush();
  var local = ivsMailLocalProblems(m);
  if (local.length){ m.problems = local; ivsMailRender(); return; }
  m.step = 'asking'; m.problems = []; m.error = ''; ivsMailRender();
  var b = ivsMailBody(m); b.mode = 'preview';
  var r = await ivsMailCall(b);
  if (ivsMail !== m) return;
  if (r.status !== 200 || !r.data.preview){ m.step = 'form'; m.error = (r.data && r.data.error) || 'Could not prepare the email.'; ivsMailRender(); return; }
  if (r.data.preview.problems && r.data.preview.problems.length){
    m.step = 'form'; m.problems = r.data.preview.problems.map(function(t){ return ['', t]; }); ivsMailRender(); return;
  }
  // what the chef corrected here belongs on the candidate's sheet too
  var row = ivsRow(m.candId), patch = {};
  if (row){
    if ((row.name || '').trim() !== m.name) patch.name = m.name;
    if ((row.email || '').trim() !== m.email) patch.email = m.email;
    if ((row.position_applied || '').trim() !== m.position) patch.position_applied = m.position;
    if (Object.keys(patch).length){ Object.assign(row, patch); if (!m.fromCv) delete ivsMailRead[m.candId]; ivsSave(m.candId, patch); ivsRender(); }
  }
  m.preview = r.data.preview; m.again = false; m.step = 'preview';
  ivsMailFormUrl(m);
  ivsMailRender();
}
// the finished Word form as a link the chef can open — the very bytes HR will get
function ivsMailFormUrl(m){
  if (m.formUrl){ try { URL.revokeObjectURL(m.formUrl); } catch(e){} m.formUrl = null; }
  var f = m.preview && m.preview.form_file; if (!f || !f.b64) return;
  try {
    var bin = atob(f.b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    m.formUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
  } catch(e){}
}
function ivsMailBack(){ if (ivsMail && (ivsMail.step === 'preview' || ivsMail.step === 'failed')){ ivsMail.step = 'form'; ivsMail.error = ''; ivsMailRender(); } }

async function ivsMailSend(){
  var m = ivsMail; if (!m || m.step !== 'preview') return;
  if (m.action === 'hr' && ivsHrBlock(ivsRow(m.candId))){ m.step = 'form'; m.problems = ivsMailLocalProblems(m); ivsMailRender(); kToast(ivsHrBlock(ivsRow(m.candId)), true); return; }
  if (m.preview.repeats && !m.again){ kToast('Tick “Send it again” first — this was already sent.', true); return; }
  m.step = 'sending'; ivsMailRender();
  var b = ivsMailBody(m); b.mode = 'send'; b.confirm_repeat = !!m.again;
  var r = await ivsMailCall(b);
  if (ivsMail !== m) return;
  await ivsLoad(true);                                   // the log row, sent or failed
  if (r.status === 200 && r.data.ok){
    m.step = 'done'; m.result = r.data;
    ivsMailRender(); ivsActsRefresh();
    kToast(IVS_ACTIONS[m.action].done + ' — email sent.');
    return;
  }
  m.step = 'failed'; m.error = (r.data && r.data.error) || 'The email was not sent.';
  ivsMailRender(); ivsActsRefresh();
}

function ivsMailRowHtml(label, val, none){
  var txt = Array.isArray(val) ? val.join(', ') : (val || '');
  return '<div class="ivmlrow"><i>'+label+'</i><div'+(txt ? '' : ' class="none"')+'>'+ivsEsc(txt || none)+'</div></div>';
}
function ivsMailRender(){
  var v = document.getElementById('ivs-mail'), m = ivsMail;
  if (!v || !m) return;
  var A = IVS_ACTIONS[m.action], h = '';
  var sy = v.querySelector('.body') ? v.querySelector('.body').scrollTop : 0;
  var bad = {}; m.problems.forEach(function(p){ if (p[0]) bad[p[0]] = true; });
  h += '<div class="bar"><b>'+ivsEsc(A.title)+'</b>'+(m.step === 'sending' ? '' : '<button onclick="ivsMailClose()">'+(m.step === 'done' ? 'Close' : 'Cancel')+'</button>')+'</div><div class="body"><div class="ivml">';

  if (m.step === 'form' || m.step === 'asking'){
    var posList = (IVS_DETAILS.filter(function(d){ return d[0] === 'position_applied'; })[0] || [0,0,0,[]])[3];
    h += '<h3>1 · Check the details</h3><p class="lead">'+
      (m.action === 'hr' ? 'These go in the email to HR, with the CV and the evaluation form you fill below.' : 'The email goes to this address, addressed to this name. Correct anything that is wrong.')+'</p>'+
      '<label class="ivdf"><span>Candidate’s full name</span><input id="ivs-m-name" data-f="name" maxlength="120" autocomplete="off" class="'+(bad.name?'bad':'')+'" value="'+ivsEsc(m.name)+'" oninput="ivsMailField(this)"></label>'+
      '<label class="ivdf"><span>Candidate’s email</span><input id="ivs-m-email" data-f="email" type="email" inputmode="email" autocapitalize="off" spellcheck="false" maxlength="200" autocomplete="off" class="'+(bad.email?'bad':'')+'" value="'+ivsEsc(m.email)+'" oninput="ivsMailField(this)">'+
        '<em>'+(m.fromCv && m.email ? 'Read from the CV — check it letter by letter.' : '')+'</em></label>'+
      '<label class="ivdf"><span>Position</span><input id="ivs-m-position" data-f="position" maxlength="120" autocomplete="off" list="ivs-m-pos" placeholder="e.g. Commis II" class="'+(bad.position?'bad':'')+'" value="'+ivsEsc(m.position)+'" oninput="ivsMailField(this)"></label>'+
      '<datalist id="ivs-m-pos">'+posList.map(function(o){ return '<option value="'+ivsEsc(o)+'">'; }).join('')+'</datalist>';
    if (m.action === 'hr'){
      var cvs = ivsCvsFor(m.candId);
      h += '<div class="ivmlsec">Attachments</div>';
      if (!cvs.length) h += '<div class="ivmlfile need"><div class="nm">1 · Candidate’s CV<span>None on this candidate. Close this window and upload the CV first.</span></div></div>';
      cvs.forEach(function(c){
        h += '<label class="ivmlfile'+(bad.cv?' need':'')+'"><input type="checkbox" '+(m.cvIds.indexOf(c.id) >= 0 ? 'checked ' : '')+'onchange="ivsMailCv(this,\''+c.id+'\')">'+
          '<div class="nm">1 · Candidate’s CV<span>'+ivsEsc(c.filename)+' · '+ivsKb(c.size_bytes)+'</span></div></label>';
      });
      h += ivsEvFormHtml(m, bad);
      h += '<div class="ivmlfile slot"><div class="nm">3 · Interview Form<span>Slot reserved — to be added later. Nothing is attached here yet.</span></div></div>';
    }
    m.problems.forEach(function(p){ h += '<div class="ivmlerr">'+ivsEsc(p[1])+'</div>'; });
    if (m.error) h += '<div class="ivmlerr">'+ivsEsc(m.error)+'</div>';
    h += '<div class="ivmlft"><button class="ivb2" onclick="ivsMailClose()">Cancel</button>'+
      '<button class="ivb" '+(m.step === 'asking' ? 'disabled' : '')+' onclick="ivsMailPreview()">'+(m.step === 'asking' ? 'Preparing the preview…' : 'Preview the email')+'</button></div>';
  }

  if (m.step === 'preview' || m.step === 'sending' || m.step === 'failed'){
    var p = m.preview;
    h += '<h3>2 · Preview — nothing has been sent yet</h3><p class="lead">This is exactly what will go. Read it, then press Confirm &amp; Send.</p>';
    if (p.is_test) h += '<div class="ivmltest">TEST candidate — this email goes ONLY to '+ivsEsc(p.to.join(', '))+'. On a real candidate it would go to: '+
      ivsEsc(p.real_recipients.to.join(', '))+(p.real_recipients.cc.length ? ' · CC '+ivsEsc(p.real_recipients.cc.join(', ')) : '')+
      (p.real_recipients.reply_to.length ? ' · Reply-To '+ivsEsc(p.real_recipients.reply_to.join(', ')) : '')+'.</div>';
    var others = (p.previous || []).filter(function(x){ return x.action !== m.action; });
    if (p.repeats){
      var same = p.previous.filter(function(x){ return x.action === m.action; });
      h += '<div class="ivmlwarn"><b>Already done.</b> “'+ivsEsc(A.done)+'” was sent for this candidate '+
        same.map(function(x){ return ivsEsc(ivsWhen(x.created_at))+' to '+ivsEsc(x.candidate_email); }).join('; ')+'. Sending again puts a second email in the same inbox.'+
        '<label><input type="checkbox" '+(m.again?'checked ':'')+(m.step==='sending'?'disabled ':'')+'onchange="ivsMail.again=this.checked;ivsMailRender()">Send it again anyway</label></div>';
    }
    if (others.length) h += '<div class="ivmlwarn">Earlier for this candidate: '+others.map(function(x){ return '<b>'+ivsEsc((IVS_ACTIONS[x.action]||{}).done || x.action)+'</b> '+ivsEsc(ivsWhen(x.created_at)); }).join(' · ')+'.</div>';
    (p.hints || []).forEach(function(t){ h += '<div class="ivmlwarn">'+ivsEsc(t)+'</div>'; });
    h += '<div class="ivmlbox">'+
      ivsMailRowHtml('From', p.from)+
      ivsMailRowHtml('To', p.to)+
      ivsMailRowHtml('CC', p.cc, 'Nobody')+
      ivsMailRowHtml('Reply-To', p.reply_to, 'None — a reply to this email reaches nobody')+
      ivsMailRowHtml('Subject', p.subject)+
      '<div class="ivmlbody">'+ivsEsc(p.body)+'</div></div>';
    h += '<div class="ivmlsec">Attachments</div>';
    if (!p.attachments.length) h += '<div class="ivmlfile"><div class="nm">None<span>No file goes with this email.</span></div></div>';
    p.attachments.forEach(function(a, i){ h += '<div class="ivmlfile"><div class="nm">'+(i+1)+' · '+ivsEsc(a.label)+'<span>'+ivsEsc(a.filename)+' · '+ivsKb(a.size_bytes)+'</span></div></div>'; });
    if (p.form_answers){
      h += '<div class="ivmlsec">What the evaluation form says</div><div class="ivmlbox">'+p.form_answers.map(function(a){ return '<div class="ivmlans"><i>'+ivsEsc(a[0])+'</i><b>'+ivsEsc(a[1])+'</b></div>'; }).join('')+'</div>';
      if (m.formUrl) h += '<a class="ivmldl" href="'+m.formUrl+'" download="'+ivsEsc(p.form_file.filename)+'">Open the filled form (Word)</a>';
    }
    if (p.interview_form_slot) h += '<div class="ivmlfile slot"><div class="nm">'+(p.attachments.length+1)+' · Interview Form<span>Slot reserved — to be added later. Not attached.</span></div></div>';
    if (m.step === 'failed') h += '<div class="ivmlerr">NOT sent — '+ivsEsc(m.error)+'</div>';
    h += '<div class="ivmlft"><button class="ivb2" '+(m.step==='sending'?'disabled ':'')+'onclick="ivsMailBack()">Back</button>'+
      '<button class="ivb" '+(m.step==='sending' || (p.repeats && !m.again) ? 'disabled ' : '')+'onclick="ivsMailSend()">'+
      (m.step === 'sending' ? 'Sending…' : m.step === 'failed' ? 'Try again — Confirm & Send' : 'Confirm &amp; Send')+'</button></div>';
  }

  if (m.step === 'done'){
    var row = m.result && m.result.row;
    h += '<h3>Sent</h3><p class="lead"><b>'+ivsEsc(A.done)+'</b> — the email went to '+ivsEsc((row && row.sent_to || m.preview.to).join(', '))+
      (m.preview.cc.length ? ', copy to '+ivsEsc(m.preview.cc.join(', ')) : '')+'.'+
      (m.preview.attachments.length ? ' Attached: '+ivsEsc(m.preview.attachments.map(function(a){ return a.filename; }).join(', '))+'.' : '')+'</p>'+
      (m.result && m.result.logged === false ? '<div class="ivmlerr">The email went, but it could not be written to the log. Tell Francesco.</div>' : '<p class="lead">It is written on the candidate’s sheet with the time.</p>')+
      '<div class="ivmlft"><button class="ivb" onclick="ivsMailClose()">Close</button></div>';
  }
  h += '</div></div>';
  var keep = document.activeElement && document.activeElement.id && v.contains(document.activeElement) ? document.activeElement.id : null;
  v.innerHTML = h;
  // a new step starts at its top; a tick or an error inside a step leaves the page where the chef is reading
  var stage = m.step === 'asking' ? 'form' : (m.step === 'sending' || m.step === 'failed') ? 'preview' : m.step;
  var body = v.querySelector('.body'); if (body) body.scrollTop = stage === m.stage ? sy : 0;
  m.stage = stage;
  if (keep){ var k = document.getElementById(keep); if (k) k.focus(); }
}


// ══════════════════════════════════════════════════════════════════════════
// Who is scoring, which round — and the Emails / Set-up tabs
// ══════════════════════════════════════════════════════════════════════════
function ivsNameHtml(){
  var names = (ivsSettings && ivsSettings.interviewers) || [];
  return '<div class="ivrounds"><div class="ivcard"><div class="ivlbl">Who is scoring on this device?</div>'+
    '<p class="ivnote" style="margin:0 0 10px">Every score, note and email you send carries this name. Tap yours.</p>'+
    '<div class="ivnames">'+names.map(function(n){ return '<button class="ivb'+(n===ivsMe?'':'2')+'" onclick="ivsMePick(this.textContent)">'+ivsEsc(n)+'</button>'; }).join('')+'</div>'+
    '<label class="ivdf" style="margin-top:12px"><span>Not in the list — type your name</span><input id="ivs-me-new" maxlength="60" autocomplete="off" placeholder="First and last name" onkeydown="if(event.key===\'Enter\')ivsMePick(this.value)"></label>'+
    '<div class="ivmlft" style="justify-content:flex-start"><button class="ivb" onclick="ivsMePick(document.getElementById(\'ivs-me-new\').value)">Continue</button>'+
    (ivsRound ? '<button class="ivb2" onclick="ivsScreen=\'main\';ivsRender();ivsStartPoll()">Back</button>' : '')+'</div></div></div>';
}

function ivsDate(d){
  if (!d) return '';
  try { return new Intl.DateTimeFormat('en-GB', { day:'numeric', month:'short', year:'numeric' }).format(new Date(d + 'T00:00:00')); } catch(e){ return d; }
}
function ivsRoundsHtml(){
  var open = ivsRounds.filter(function(r){ return !r.closed_on; }), closed = ivsRounds.filter(function(r){ return r.closed_on; });
  var row = function(r){
    return '<button class="ivround'+(r.closed_on?' closed':'')+'" onclick="ivsRoundPick(\''+ivsEsc(r.event)+'\')"><span class="t"><b>'+ivsEsc(r.title)+'</b>'+
      '<span>'+ivsEsc(r.position || 'Position not set')+' · opened '+ivsDate(r.opened_on)+(r.closed_on ? ' · closed '+ivsDate(r.closed_on) : '')+' · '+r.candidates+' candidate'+(r.candidates===1?'':'s')+'</span></span>'+
      (!r.closed_on && r.to_decide ? '<i>'+r.to_decide+' to decide</i>' : '')+'</button>';
  };
  var h = '<div class="ivrounds"><div class="ivhd"><div><small>Roberto\'s Dubai · Kitchen</small><h2>Hiring rounds</h2>'+
    '<div class="ivwho">Scoring as <b>'+ivsEsc(ivsMe)+'</b><button onclick="ivsMeChange()">change</button></div></div>'+
    '<div><button class="ivlock" onclick="ivsLock()">Lock</button></div></div>';
  if (ivsRoundNew) h += ivsRoundNewHtml();
  else h += '<button class="ivb" style="width:100%" onclick="ivsRoundNewOpen()">+ New round</button>';
  h += '<button class="ivb2" style="width:100%;margin-top:8px" onclick="ivsShelfOpen()">CV database &amp; archive</button>';
  h += '<div class="ivlbl" style="margin-top:16px">Open</div>';
  h += open.length ? open.map(row).join('') : '<div class="ivnote">No open round. Start one above.</div>';
  if (closed.length) h += '<details style="margin-top:16px"><summary class="ivlbl" style="cursor:pointer">Past rounds · '+closed.length+'</summary>'+closed.map(row).join('')+'</details>';
  return h + '</div>';
}
function ivsRoundNewOpen(){ ivsRoundNew = { title:'', position:'', set: (ivsSets[0] || {}).key || 'commis', busy:false }; ivsRender(); var t = document.getElementById('ivs-rn-title'); if (t) t.focus(); }
function ivsRoundNewHtml(){
  var n = ivsRoundNew;
  return '<div class="ivcard"><div class="ivlbl">New round</div>'+
    '<label class="ivdf"><span>Position</span><input id="ivs-rn-pos" maxlength="80" autocomplete="off" list="ivs-dl-position_applied" placeholder="e.g. Chef de Partie" value="'+ivsEsc(n.position)+'" oninput="ivsRoundNew.position=this.value"></label>'+
    '<datalist id="ivs-dl-position_applied">'+(IVS_DETAILS.filter(function(d){ return d[0]==='position_applied'; })[0][3]).map(function(o){ return '<option value="'+ivsEsc(o)+'">'; }).join('')+'</datalist>'+
    '<label class="ivdf"><span>Title</span><input id="ivs-rn-title" maxlength="120" autocomplete="off" placeholder="e.g. CDP interviews — October 2026" value="'+ivsEsc(n.title)+'" oninput="ivsRoundNew.title=this.value"></label>'+
    '<label class="ivdf"><span>Questions</span><select class="ivsel" style="width:100%" onchange="ivsRoundNew.set=this.value">'+
      ivsSets.map(function(s){ return '<option value="'+ivsEsc(s.key)+'"'+(s.key===n.set?' selected':'')+'>'+ivsEsc(s.title)+' · '+s.sections.reduce(function(a,x){ return a+x.items.length; },0)+' lines</option>'; }).join('')+
    '</select></label><p class="ivnote">The questions can be changed in Set-up until the first score is given. New sets are made in Set-up.</p>'+
    '<div class="ivmlft"><button class="ivb2" onclick="ivsRoundNew=null;ivsRender()">Cancel</button><button class="ivb" '+(n.busy?'disabled':'')+' onclick="ivsRoundCreate()">'+(n.busy?'Starting…':'Start the round')+'</button></div></div>';
}
async function ivsRoundCreate(){
  var n = ivsRoundNew; if (!n || n.busy) return;
  if (n.title.trim().length < 2){ kToast('Give the round a title.', true); return; }
  n.busy = true; ivsRender();
  var r = await sb.rpc('interview_round_add', { p_code: ivsCode, p_title: n.title.trim(), p_position: n.position.trim(), p_set: n.set, p_by: ivsMe || '' });
  if (r.error){ n.busy = false; ivsRender(); kToast('Not started — ' + (r.error.message || 'no connection'), true); return; }
  ivsRoundNew = null;
  var row = Object.assign({ candidates: 0, to_decide: 0 }, r.data);
  ivsRounds.unshift(row);
  await ivsRoundUse(row);
  ivsRender();
  kToast('Round started — ' + row.title);
}
async function ivsRoundPatch(patch, okMsg){
  var r = await sb.rpc('interview_round_patch', { p_code: ivsCode, p_id: ivsRound.id, p_patch: patch });
  if (r.error){ kToast('Not saved — ' + (r.error.message || 'no connection'), true); ivsRender(); return false; }
  Object.assign(ivsRound, r.data);
  var i = ivsRounds.findIndex(function(x){ return x.id === ivsRound.id; }); if (i >= 0) Object.assign(ivsRounds[i], r.data);
  if (patch.question_set){ ivsUseSet(ivsSetByKey(ivsRound.question_set)); }
  ivsRender();
  if (okMsg) kToast(okMsg);
  return true;
}
async function ivsRoundClose(){
  if (!(await ivsAsk({ title:'Close ' + ivsRound.title + '?', body:'It moves to Past rounds. Everything stays readable and it can be reopened.', ok:'Close round' }))) return;
  ivsRoundPatch({ closed_on: new Date(Date.now() + 4*3600000).toISOString().slice(0,10) }, 'Round closed.');
}

// ── history: the same address in another round ──
async function ivsHistLoad(candId){
  var r = ivsRow(candId); if (!r) return;
  var em = (r.email || '').trim().toLowerCase();
  if (!ivsMailValid(em)){ ivsHistPaint(candId); return; }
  if (ivsHist[em] === undefined){
    ivsHist[em] = 'loading';
    var q = await sb.rpc('interview_history', { p_code: ivsCode, p_email: em, p_not_event: IVS_EVENT });
    ivsHist[em] = q.error ? undefined : (q.data || []);
    if (q.error) return;
  }
  ivsHistPaint(candId);
}
function ivsHistPaint(candId){
  var el = document.getElementById('ivs-hist'), r = ivsRow(candId);
  if (el && r && ivsSel === candId) el.innerHTML = ivsHistHtml(r);
}
function ivsHistHtml(r){
  var em = (r.email || '').trim().toLowerCase(), rows = ivsHist[em];
  if (!Array.isArray(rows) || !rows.length) return '';
  return '<div class="ivhist"><b>Seen before</b> — the same email in '+(rows.length === 1 ? 'another round' : rows.length + ' other rounds')+': '+rows.map(function(x){
    var c = ivsCalcWith(x, ivsSetByKey(x.question_set));
    var bits = [ivsEsc(x.round_title)];
    bits.push(c.done ? c.final + '/100 · ' + c.verdict.t : c.scored ? 'part-scored' : 'not scored');
    if (x.last_action) bits.push((IVS_ACTIONS[x.last_action] || { done: x.last_action }).done + ' ' + ivsWhen(x.last_action_at).split(',')[0]);
    if (ivsNoShows.some(function(n){ return n.candidate_id === x.candidate_id; })) bits.push('NO SHOW');
    return bits.join(' · ');
  }).join('; ')+'.</div>';
}

// ══════════════════════════════════════════════════════════════════════════
// CV database + archive — where a finished candidate goes, from every round
// ══════════════════════════════════════════════════════════════════════════
function ivsFinished(r){ var k = ivsStage(r); return k === 'hr' || k === 'reject'; }
function ivsShelfCvs(){ var out = []; (ivsShelfRows || []).forEach(function(r){ out = out.concat(r.cvs || []); }); return out; }
function ivsShelfWhen(iso){ return iso ? ivsWhen(iso).split(',')[0] : ''; }

// the working list says where the moved ones went, and offers to move the finished ones
function ivsShelfLineHtml(){
  var fin = ivsRows.filter(ivsFinished).length, gone = ivsShelved.length;
  if (!fin && !gone) return '';
  return '<div class="ivshline">'+
    (fin ? '<span>'+fin+' finished (sent to HR or rejected)</span><button type="button" onclick="ivsShelfMoveFinished()">Move '+(fin === 1 ? 'it' : 'all '+fin)+' to the CV database</button>' : '')+
    (gone ? '<span>'+gone+' already in the CV database</span><button type="button" onclick="ivsShelfOpen()">Open it</button>' : '')+'</div>';
}

// the box at the foot of a candidate's sheet
function ivsShelfBoxHtml(r){
  var ed = ivsShelfEdit && ivsShelfEdit.id === r.id ? ivsShelfEdit : null;
  var h = '<div class="ivshbox" id="ivs-shbox"><div class="hd"><b>Finished with this candidate?</b></div>';
  if (ed) return h + '<p>Why are we keeping <b>'+ivsEsc(ivsCandLabel(r))+'</b> for a future hire? This note goes with the CV into the archive.</p>'+
    '<textarea id="ivs-shnote" class="ivshnote" maxlength="1000" placeholder="e.g. Strong on pasta, calm under pressure — no CDP opening in September. Call for the next one." oninput="ivsShelfEdit.note=this.value">'+ivsEsc(ed.note)+'</textarea>'+
    '<div class="btns"><button type="button" class="ivb2" onclick="ivsShelfEdit=null;ivsShelfBoxPaint()">Cancel</button>'+
    '<button type="button" class="ivb" onclick="ivsShelfSave()">Keep in the archive</button></div></div>';
  return h + '<p>Move them out of this round\'s list. Nothing is deleted — the CV, scores and emails go with them, and they can be brought back.</p>'+
    '<div class="btns"><button type="button" class="ivb2" onclick="ivsShelfTo(\''+r.id+'\',\'database\')">Move to the CV database</button>'+
    '<button type="button" class="ivb" onclick="ivsShelfNote(\''+r.id+'\',\'archive\')">Keep in the archive — future hire…</button></div></div>';
}
function ivsShelfBoxPaint(){
  var r = ivsRow(ivsSel), el = document.getElementById('ivs-shbox');
  if (r && el) el.outerHTML = ivsShelfBoxHtml(r);
  var t = document.getElementById('ivs-shnote'); if (t){ t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
}
function ivsShelfNote(id, to){
  var r = ivsRow(id) || (ivsShelfRows || []).filter(function(x){ return x.id === id; })[0];
  ivsShelfEdit = { id: id, to: to, note: (r && r.shelf_note) || '' };
  if (ivsScreen === 'shelf'){ ivsRender(); var t = document.getElementById('ivs-shnote'); if (t){ t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }
  else ivsShelfBoxPaint();
}
function ivsShelfSave(){
  var ed = ivsShelfEdit; if (!ed) return;
  var note = String(ed.note || '').trim();
  if (note.length < 3){ kToast('Write a line on why we are keeping them.', true); var t = document.getElementById('ivs-shnote'); if (t) t.focus(); return; }
  ivsShelfTo(ed.id, ed.to, note);
}
// one move: into the database, into the archive (with its note), or back to the round ('')
async function ivsShelfTo(id, to, note){
  var patch = { shelf: to };
  if (note != null) patch.shelf_note = note;
  var r = await sb.rpc('interview_patch', { p_code: ivsCode, p_id: id, p_patch: patch, p_by: ivsMe || '' });
  if (r.error){ kToast('Not moved — ' + (r.error.message || 'no connection') + '. Try again.', true); return false; }
  var row = r.data, wasShelf = (ivsRow(id) || ivsShelved.concat(ivsShelfRows || []).filter(function(x){ return x.id === id; })[0] || {}).shelf;
  ivsShelfEdit = null;
  // this round's lists
  if (row.event === IVS_EVENT){
    ivsRows = ivsRows.filter(function(x){ return x.id !== id; });
    ivsShelved = ivsShelved.filter(function(x){ return x.id !== id; });
    (row.shelf ? ivsShelved : ivsRows).push(row);
    if (ivsSel === id && row.shelf) ivsSel = null;
  }
  // the database screen
  if (ivsShelfRows){
    var i = ivsShelfRows.findIndex(function(x){ return x.id === id; });
    if (i >= 0){ if (row.shelf) Object.assign(ivsShelfRows[i], { shelf: row.shelf, shelf_note: row.shelf_note, shelved_at: row.shelved_at, shelved_by: row.shelved_by }); else ivsShelfRows.splice(i, 1); }
  }
  kToast(!row.shelf ? (ivsCandLabel(row) + ' is back in the round.') : wasShelf === row.shelf ? 'Note saved.' : ivsCandLabel(row) + (row.shelf === 'archive' ? ' kept in the archive.' : ' moved to the CV database.'));
  ivsRender();
  return true;
}
async function ivsShelfMoveFinished(){
  var list = ivsRows.filter(ivsFinished);
  if (!list.length) return;
  if (!(await ivsAsk({ title: 'Move ' + list.length + ' finished candidate' + (list.length === 1 ? '' : 's') + ' to the CV database?',
    body: 'Everyone sent to HR or rejected leaves this list. Their CVs, scores and emails go with them, and each can be brought back. To keep someone for a future hire, open them and choose Archive instead.',
    ok: 'Move ' + list.length })) ) return;
  var ok = 0, bad = 0;
  for (var i = 0; i < list.length; i++){
    var r = await sb.rpc('interview_patch', { p_code: ivsCode, p_id: list[i].id, p_patch: { shelf: 'database' }, p_by: ivsMe || '' });
    if (r.error) bad++; else ok++;
  }
  await ivsLoad(true);
  ivsRender();
  kToast(ok + ' moved to the CV database.' + (bad ? ' ' + bad + ' not moved — try again.' : ''), !!bad);
}

// Discard (22 Sep 2026, Francesco: archived CVs stay until someone discards them by hand,
// and the panel must say clearly the CV will not be kept). The same delete as the sheet's
// Delete: the candidate row and their CVs go; the emails already sent stay in the round's
// Emails log under their name; a no-show mark lives on the row, so it goes too.
async function ivsShelfDiscard(id){
  var r = (ivsShelfRows || []).filter(function(x){ return x.id === id; })[0]; if (!r) return;
  var nm = ivsCandLabel(r), n = (r.cvs || []).length;
  if (!(await ivsAsk({ title: 'Discard ' + nm + '?',
    body: (r.shelf === 'archive' ? 'They will NOT be kept in the archive. ' : '') +
      'Their CV' + (n > 1 ? 's' : '') + ', scores and notes' + (r.shelf === 'archive' ? ', and the note on why we kept them,' : '') +
      ' are deleted for good. Nobody can bring them back, and we will have no record of them if they apply again. ' +
      'The emails already sent stay in the round\'s Emails log.',
    ok: 'Discard for good', danger: true }))) return;
  var q = await sb.rpc('interview_delete', { p_code: ivsCode, p_id: id });
  if (q.error){ kToast('Not discarded — ' + (q.error.message || 'no connection') + '. Try again.', true); return; }
  ivsShelfRows = ivsShelfRows.filter(function(x){ return x.id !== id; });
  ivsShelved = ivsShelved.filter(function(x){ return x.id !== id; });
  if (ivsShelfEdit && ivsShelfEdit.id === id) ivsShelfEdit = null;
  ivsRender();
  kToast(nm + ' discarded — the CV is not kept.');
}

// ── the CV database screen ──
async function ivsShelfOpen(focusId){
  if (ivsTimer){ clearInterval(ivsTimer); ivsTimer = null; }
  ivsScreen = 'shelf'; ivsShelfEdit = null;
  var v = document.getElementById('interviews-view');
  if (v) v.innerHTML = '<div style="padding:40px;text-align:center;opacity:.6">Opening the CV database…</div>';
  var r = await sb.rpc('interview_shelf_list', { p_code: ivsCode });
  if (ivsScreen !== 'shelf') return;
  if (r.error){ ivsShelfRows = []; kToast('Could not read the CV database — ' + (r.error.message || 'no connection'), true); }
  else ivsShelfRows = r.data || [];
  if (focusId){
    var f = ivsShelfRows.filter(function(x){ return x.id === focusId; })[0];
    if (f){ ivsShelfTab = f.shelf; ivsShelfQ = f.name || ''; }
  }
  ivsRender();
  window.scrollTo(0, 0);
}
async function ivsShelfBack(){
  ivsShelfEdit = null;
  if (ivsRound){
    ivsScreen = 'main';
    await ivsLoad(true);
    ivsRender(); ivsStartPoll();
  } else { ivsScreen = 'rounds'; ivsRender(); }
}
function ivsShelfTabPick(k){ ivsShelfTab = k; ivsShelfEdit = null; ivsRender(); }
function ivsShelfSearch(el){
  ivsShelfQ = el.value;
  var l = document.getElementById('ivs-shl'); if (l) l.innerHTML = ivsShelfListHtml();
}
function ivsShelfHits(){
  var words = ivsNorm(ivsShelfQ).split(' ').filter(Boolean);
  return (ivsShelfRows || []).filter(function(r){
    if (ivsShelfTab !== 'all' && r.shelf !== ivsShelfTab) return false;
    if (!words.length) return true;
    var hay = ' ' + ivsNorm([r.name, r.email, r.round_title, r.round_position, r.position_applied, r.shelf_note, r.notes, r.visa_status]
      .concat((r.cvs || []).map(function(c){ return c.filename; })).join(' '));
    return words.every(function(w){ return hay.indexOf(w) >= 0; });
  });
}
function ivsShelfHtml(){
  var all = ivsShelfRows || [];
  var n = { archive: 0, database: 0 }; all.forEach(function(r){ n[r.shelf] = (n[r.shelf] || 0) + 1; });
  var tab = function(k, label, c){ return '<button type="button" class="ivb2'+(ivsShelfTab === k ? ' on' : '')+'" aria-pressed="'+(ivsShelfTab === k)+'" onclick="ivsShelfTabPick(\''+k+'\')">'+label+' · '+c+'</button>'; };
  return '<div class="ivrounds"><div class="ivhd"><div><small>Roberto\'s Dubai · Kitchen · every round</small><h2>CV database</h2>'+
    '<div class="ivwho"><button onclick="ivsShelfBack()">‹ Back to '+(ivsRound ? ivsEsc(ivsRound.title) : 'the rounds')+'</button></div></div>'+
    '<div><button class="ivlock" onclick="ivsLock()">Lock</button></div></div>'+
    '<div class="ivshtabs" role="group" aria-label="Which shelf">'+tab('archive', 'Archive — future hires', n.archive)+tab('database', 'Finished', n.database)+tab('all', 'All', all.length)+'</div>'+
    '<input id="ivs-shq" class="ivshq" type="search" placeholder="Search name, email, position, round or note" aria-label="Search the CV database" autocomplete="off" value="'+ivsEsc(ivsShelfQ)+'" oninput="ivsShelfSearch(this)">'+
    '<div id="ivs-shl">'+ivsShelfListHtml()+'</div></div>';
}
function ivsShelfListHtml(){
  var hits = ivsShelfHits();
  if (!hits.length) return '<div class="ivshempty">'+(ivsShelfQ.trim() ? 'Nobody here matches “'+ivsEsc(ivsShelfQ.trim())+'”.'
    : ivsShelfTab === 'archive' ? 'No one kept for a future hire yet. Open a candidate in a round and choose “Keep in the archive — future hire”.'
    : 'No CVs here yet. Open a candidate in a round and choose “Move to the CV database”, or move every finished one from the round\'s list.')+'</div>';
  return hits.map(ivsShelfCardHtml).join('');
}
function ivsShelfCardHtml(r){
  var c = ivsCalcWith(r, ivsSetByKey(r.question_set));
  var ed = ivsShelfEdit && ivsShelfEdit.id === r.id ? ivsShelfEdit : null;
  var act = r.last_action ? (IVS_ACTIONS[r.last_action] || { done: r.last_action }).done + ' ' + ivsShelfWhen(r.last_action_at) : 'No email sent';
  var h = '<div class="ivshc"><div class="t"><b>'+ivsEsc(ivsCandLabel(r))+'</b><span class="ivpill'+(c.done ? ' '+c.verdict.c : '')+'">'+(c.done ? c.final+'/100 · '+c.verdict.t : c.scored ? 'Part-scored' : 'Not scored')+'</span>'+
    (ivsShelfTab === 'all' ? '<span class="ivpill">'+ivsEsc(r.shelf === 'archive' ? 'Archive' : 'Finished')+'</span>' : '')+'</div>'+
    '<div class="m">'+[r.position_applied || r.round_position, r.round_title, act].filter(Boolean).map(ivsEsc).join(' · ')+'</div>'+
    '<div class="m">'+[r.email, r.visa_status && 'Visa: '+r.visa_status, r.salary_expectation && 'Salary: '+r.salary_expectation, r.notice_period && 'Notice: '+r.notice_period].filter(Boolean).map(ivsEsc).join(' · ')+'</div>';
  if (ed) h += '<textarea id="ivs-shnote" class="ivshnote" maxlength="1000" placeholder="Why are we keeping them for a future hire?" oninput="ivsShelfEdit.note=this.value">'+ivsEsc(ed.note)+'</textarea>'+
    '<div class="btns"><button type="button" class="ivb2" onclick="ivsShelfEdit=null;ivsRender()">Cancel</button><button type="button" class="ivb" onclick="ivsShelfSave()">'+(r.shelf === 'archive' ? 'Save the note' : 'Keep in the archive')+'</button></div>';
  else if (r.shelf === 'archive') h += '<div class="ivshkept"><b>Why we kept them:</b> '+ivsEsc(r.shelf_note)+'</div>';
  h += '<div class="m">'+(r.shelf === 'archive' ? 'Archived' : 'Moved here')+' '+ivsEsc(ivsShelfWhen(r.shelved_at))+(r.shelved_by ? ' by '+ivsEsc(r.shelved_by) : '')+'</div>';
  if (!ed){
    h += '<div class="btns">'+(r.cvs || []).map(function(cv){ return '<button type="button" class="ivb" onclick="ivsCvView(\''+cv.id+'\')" title="'+ivsEsc(cv.filename)+'">Open CV'+((r.cvs || []).length > 1 ? ' · '+ivsEsc(cv.filename) : '')+'</button>'; }).join('')+
      (!(r.cvs || []).length ? '<span class="m">No CV on file.</span>' : '')+
      (r.shelf === 'archive' ? '<button type="button" class="ivb2" onclick="ivsShelfNote(\''+r.id+'\',\'archive\')">Edit the note</button>'+
                               '<button type="button" class="ivb2" onclick="ivsShelfTo(\''+r.id+'\',\'database\')">Move to Finished</button>'
                             : '<button type="button" class="ivb2" onclick="ivsShelfNote(\''+r.id+'\',\'archive\')">Keep in the archive…</button>')+
      '<button type="button" class="ivb2" onclick="ivsShelfTo(\''+r.id+'\',\'\')">Back to the round</button>'+
      '<button type="button" class="ivb2 ivdiscard" onclick="ivsShelfDiscard(\''+r.id+'\')">Discard</button></div>';
  }
  return h + '</div>';
}

// ── Emails tab ──
function ivsEmailsHtml(){
  if (!ivsActs.length) return '<div class="ivcard"><div class="ivempty">No email has been sent in this round yet. Open a candidate and choose Reject, Shortlist, Keep for the future or Send to HR.</div></div>';
  var rows = ivsActs.slice().sort(function(a,b){ return String(b.created_at).localeCompare(String(a.created_at)); });
  var h = '<table class="ivtab"><thead><tr><th>When</th><th>Candidate</th><th>Email</th><th class="hm">To</th><th class="hm">By</th><th>Status</th></tr></thead><tbody>';
  rows.forEach(function(a){
    var A = IVS_ACTIONS[a.action] || { done:a.action, btn:a.action };
    var st = a.status === 'sent' ? (ivsDeliveryWord(a) || 'sent') : 'NOT sent — ' + (a.error || '');
    h += '<tr'+(a.candidate_id ? ' onclick="ivsTab=\'score\';ivsPick(\''+a.candidate_id+'\')"' : '')+'>'+
      '<td class="n">'+ivsEsc(ivsWhen(a.created_at))+'</td><td><b>'+ivsEsc(a.candidate_name)+'</b><br><span style="font-size:12px;color:#5a4a3a">'+ivsEsc(a.candidate_email)+'</span></td>'+
      '<td>'+ivsEsc(A.done)+(a.is_test ? ' · TEST' : '')+'</td><td class="hm ivdc">'+ivsEsc((a.sent_to||[]).join(', '))+(a.sent_cc && a.sent_cc.length ? '<br><span style="font-size:12px">cc '+ivsEsc(a.sent_cc.join(', '))+'</span>' : '')+'</td>'+
      '<td class="hm">'+ivsEsc(a.sent_by || '—')+'</td><td'+(a.status !== 'sent' || /BOUNCED|spam/.test(st) ? ' style="color:#7a1218;font-weight:700"' : '')+'>'+ivsEsc(st)+'</td></tr>';
  });
  return h + '</tbody></table>';
}

// ── Set-up tab: this round, the people, the recipients, the question sets ──
function ivsSetupHtml(){
  var S = ivsSettings || { interviewers: [], hr_to: [], hr_cc: [], shortlist_cc: [], shortlist_reply_to: [], hr_reply_to: [] };
  var scored = ivsRows.some(function(r){ return ivsCalc(r).scored > 0; });
  var h = '<div class="ivsetup">';
  // this round
  h += '<div class="ivcard"><h4>This round</h4>'+
    '<label class="ivdf"><span>Title</span><input maxlength="120" value="'+ivsEsc(ivsRound.title)+'" onchange="ivsRoundPatch({title:this.value.trim()},\'Saved.\')"></label>'+
    '<label class="ivdf"><span>Position</span><input maxlength="80" value="'+ivsEsc(ivsRound.position)+'" onchange="ivsRoundPatch({position:this.value.trim()},\'Saved.\')"></label>'+
    '<label class="ivdf"><span>Questions</span><select class="ivsel" style="width:100%" '+(scored?'disabled':'')+' onchange="ivsRoundPatch({question_set:this.value},\'Questions changed.\')">'+
      ivsSets.map(function(x){ return '<option value="'+ivsEsc(x.key)+'"'+(x.key===ivsRound.question_set?' selected':'')+'>'+ivsEsc(x.title)+'</option>'; }).join('')+'</select></label>'+
    (scored ? '<p class="ivnote">Scores have been given on these questions, so they stay.</p>' : '')+
    '<div class="ivmlft" style="justify-content:flex-start">'+(ivsRound.closed_on
      ? '<button class="ivb2" onclick="ivsRoundPatch({closed_on:\'\'},\'Round reopened.\')">Reopen this round</button>'
      : '<button class="ivb2" onclick="ivsRoundClose()">Close this round</button>')+'</div></div>';
  // interviewers
  h += '<div class="ivcard"><h4>Interviewers</h4><p class="ivnote" style="margin:0">The names offered on unlock.</p><div id="ivs-names">'+
    (S.interviewers||[]).map(function(n, i){ return '<span class="ivchip">'+ivsEsc(n)+'<button aria-label="Remove '+ivsEsc(n)+'" onclick="ivsNamesRemove('+i+')">&times;</button></span>'; }).join('')+'</div>'+
    '<div class="ivdf" style="display:flex;gap:8px;align-items:flex-end"><label style="flex:1"><span>Add a name</span><input id="ivs-name-add" maxlength="60" autocomplete="off" onkeydown="if(event.key===\'Enter\')ivsNamesAdd()"></label><button class="ivb2" onclick="ivsNamesAdd()">Add</button></div></div>';
  // recipients
  var list = function(key, label, note){
    return '<label class="ivdf"><span>'+label+'</span><textarea data-list="'+key+'" placeholder="one address per line">'+ivsEsc((S[key]||[]).join('\n'))+'</textarea></label>'+(note ? '<p class="ivnote" style="margin:2px 0 0">'+note+'</p>' : '');
  };
  h += '<div class="ivcard"><h4>Who receives the emails</h4><p class="ivnote" style="margin:0">Only @robertos.ae and @skelmore.com addresses — the database refuses anything else, so a CV can never leave the company.</p>'+
    list('hr_to', 'Hiring request — To', 'HR, with the CV and the evaluation form.')+
    list('hr_cc', 'Hiring request — copy to', 'Copied on the email to HR.')+
    list('hr_reply_to', 'Hiring request — replies go to', '')+
    list('shortlist_cc', 'Shortlist email — copy to', '')+
    list('shortlist_reply_to', 'Shortlist email — the candidate\'s reply goes to', 'Reject emails come from a no-reply address: nobody receives a reply.')+
    '<div class="ivmlft" style="justify-content:flex-start"><button class="ivb" onclick="ivsListsSave(this)">Save the addresses</button></div></div>';
  // question sets
  h += '<div class="ivcard"><h4>Question sets</h4>';
  ivsSets.forEach(function(x){
    var n = x.sections.reduce(function(a, sct){ return a + sct.items.length; }, 0);
    h += '<div class="ivsetl"><b>'+ivsEsc(x.title)+'</b><span>'+n+' lines · interview '+(x.weights.int)+'% / practical '+(x.weights.prac)+'%'+(x.frozen ? ' · in use, frozen' : '')+'</span>'+
      (x.frozen ? '<button class="ivb2" onclick="ivsSetEditOpen(\''+ivsEsc(x.key)+'\',true)">Copy to a new set</button>' : '<button class="ivb2" onclick="ivsSetEditOpen(\''+ivsEsc(x.key)+'\',false)">Edit</button>')+'</div>';
  });
  h += '<div class="ivmlft" style="justify-content:flex-start"><button class="ivb" onclick="ivsSetEditOpen(\'\',true)">New question set</button></div>';
  if (ivsSetEdit) h += ivsSetEditHtml();
  h += '</div></div>';
  return h;
}
async function ivsSettingsPatch(patch, okMsg){
  var r = await sb.rpc('interview_settings_patch', { p_code: ivsCode, p_patch: patch });
  if (r.error){ kToast('Not saved — ' + (r.error.message || 'no connection'), true); return false; }
  ivsSettings = (r.data || [])[0] || ivsSettings;
  if (okMsg) kToast(okMsg);
  return true;
}
async function ivsNamesAdd(){
  var el = document.getElementById('ivs-name-add'), n = el ? el.value.replace(/\s+/g, ' ').trim() : '';
  if (n.replace(/[^A-Za-zÀ-ɏ]/g, '').length < 2){ kToast('Type a name.', true); return; }
  var names = ((ivsSettings && ivsSettings.interviewers) || []).slice();
  if (names.some(function(x){ return x.toLowerCase() === n.toLowerCase(); })){ kToast(n + ' is already in the list.'); return; }
  names.push(n);
  if (await ivsSettingsPatch({ interviewers: names }, n + ' added.')) ivsRender();
}
async function ivsNamesRemove(i){
  var names = ((ivsSettings && ivsSettings.interviewers) || []).slice(), n = names[i]; if (!n) return;
  if (!(await ivsAsk({ title:'Remove ' + n + ' from the interviewers?', ok:'Remove', danger:true }))) return;
  names.splice(i, 1);
  if (await ivsSettingsPatch({ interviewers: names }, n + ' removed.')) ivsRender();
}
async function ivsListsSave(btn){
  var patch = {}, bad = [];
  document.querySelectorAll('#interviews-view textarea[data-list]').forEach(function(t){
    var arr = t.value.split(/[\n,;]+/).map(function(x){ return x.trim().toLowerCase(); }).filter(Boolean);
    arr.forEach(function(a){ if (!/^[a-z0-9._+\-]+@(robertos\.ae|skelmore\.com)$/.test(a)) bad.push(a); });
    patch[t.getAttribute('data-list')] = arr;
  });
  if (bad.length){ kToast('Not saved — ' + bad.join(', ') + ': only @robertos.ae and @skelmore.com addresses.', true); return; }
  if (!patch.hr_to.length){ kToast('Not saved — HR needs at least one address.', true); return; }
  btn.disabled = true;
  if (await ivsSettingsPatch(patch, 'Addresses saved — the next email uses them.')) ivsRender(); else btn.disabled = false;
}

// ── the question-set editor: sections as plain lines, "question — what to look for" ──
function ivsSetEditOpen(key, copy){
  var src = key ? ivsSetByKey(key) : null;
  var secs = src ? src.sections.map(function(x){ return { title: x.title, part: x.part, text: x.items.map(function(it){ return it[1] + (it[2] ? ' — ' + it[2] : ''); }).join('\n') }; })
    : [{ title:'Interview', part:'int', text:'' }, { title:'Practical', part:'prac', text:'' }];
  ivsSetEdit = { key: copy ? '' : key, from: src ? src.key : '', title: src ? (copy ? src.title + ' (copy)' : src.title) : '', wInt: src ? src.weights.int : 40, sections: secs, busy:false };
  ivsRender();
  var t = document.getElementById('ivs-se-title'); if (t){ t.scrollIntoView({ block:'center' }); t.focus(); }
}
function ivsSetEditHtml(){
  var e = ivsSetEdit;
  var h = '<div class="ivsec2" id="ivs-se"><div class="ivlbl">'+(e.key ? 'Edit set' : 'New set')+'</div>'+
    '<div class="row"><label class="ivdf" style="flex:2 1 220px"><span>Name</span><input id="ivs-se-title" maxlength="120" value="'+ivsEsc(e.title)+'" oninput="ivsSetEdit.title=this.value"></label>'+
    '<label class="ivdf"><span>Interview weight %</span><input type="number" min="0" max="100" value="'+e.wInt+'" oninput="ivsSetEdit.wInt=+this.value"></label></div>'+
    '<p class="ivnote">Practical takes the rest. One line per question: <i>the question — what a good answer shows</i>. Scores are 1–5 per line.</p>';
  e.sections.forEach(function(sc, i){
    h += '<div class="ivsec2"><div class="row"><label class="ivdf"><span>Section title</span><input maxlength="80" value="'+ivsEsc(sc.title)+'" oninput="ivsSetEdit.sections['+i+'].title=this.value"></label>'+
      '<label class="ivdf" style="flex:0 1 180px"><span>Part</span><select class="ivsel" style="width:100%" onchange="ivsSetEdit.sections['+i+'].part=this.value"><option value="int"'+(sc.part==='int'?' selected':'')+'>Interview</option><option value="prac"'+(sc.part==='prac'?' selected':'')+'>Practical</option></select></label></div>'+
      '<textarea placeholder="One question per line" oninput="ivsSetEdit.sections['+i+'].text=this.value">'+ivsEsc(sc.text)+'</textarea>'+
      (e.sections.length > 1 ? '<button class="ivb2" style="margin-top:6px" onclick="ivsSetEdit.sections.splice('+i+',1);ivsRender()">Remove section</button>' : '')+'</div>';
  });
  h += '<div class="ivmlft" style="justify-content:flex-start"><button class="ivb2" onclick="ivsSetEdit.sections.push({title:\'\',part:\'int\',text:\'\'});ivsRender()">+ Section</button>'+
    '<button class="ivb2" onclick="ivsSetEdit=null;ivsRender()">Cancel</button><button class="ivb" '+(e.busy?'disabled':'')+' onclick="ivsSetSave()">'+(e.busy?'Saving…':'Save the set')+'</button></div></div>';
  return h;
}
// codes are given here: I1… for interview lines, P1… for practical — a set is only ever saved before any score exists
function ivsSetBuild(e){
  var ni = 0, np = 0, sections = [];
  e.sections.forEach(function(sc){
    var items = sc.text.split('\n').map(function(l){ return l.trim(); }).filter(Boolean).map(function(l){
      var m = l.split(/\s+[—–-]{1,2}\s+/); var q = m[0].trim(), hint = m.slice(1).join(' — ').trim();
      var code = sc.part === 'prac' ? 'P' + (++np) : 'I' + (++ni);
      return [code, q, hint];
    });
    if (items.length) sections.push({ title: sc.title.trim() || (sc.part === 'prac' ? 'Practical' : 'Interview'), part: sc.part, items: items });
  });
  var wInt = Math.max(0, Math.min(100, Math.round(+e.wInt || 0)));
  if (!ni) wInt = 0; if (!np) wInt = 100;                   // a part with no lines carries no weight
  return { sections: sections, weights: { int: wInt, prac: 100 - wInt }, lines: ni + np };
}
async function ivsSetSave(){
  var e = ivsSetEdit; if (!e || e.busy) return;
  var built = ivsSetBuild(e);
  if (e.title.trim().length < 2){ kToast('Give the set a name.', true); return; }
  if (!built.lines){ kToast('Type at least one question.', true); return; }
  var key = e.key || e.title;
  if (!e.key && ivsSetByKey(key.toLowerCase().replace(/[^a-z0-9]+/g, '-'))){ kToast('A set with this name exists — choose another name.', true); return; }
  e.busy = true; ivsRender();
  var r = await sb.rpc('interview_set_upsert', { p_code: ivsCode, p_key: key, p_title: e.title.trim(), p_sections: built.sections, p_weights: built.weights });
  if (r.error){ e.busy = false; ivsRender(); kToast('Not saved — ' + (r.error.message || 'no connection'), true); return; }
  var row = (r.data || [])[0];
  var i = ivsSets.findIndex(function(x){ return x.key === row.key; }); if (i >= 0) ivsSets[i] = row; else ivsSets.push(row);
  if (ivsRound && ivsRound.question_set === row.key) ivsUseSet(row);
  ivsSetEdit = null; ivsRender();
  kToast('Set saved — ' + row.title + ', ' + built.lines + ' lines.');
}

function ivsLib(src, globalName){
  if (window[globalName]) return Promise.resolve(window[globalName]);
  return lazyLoad(src).then(function(){
    if (!window[globalName]) throw new Error('viewer did not load');
    return window[globalName];
  });
}

function ivsBoardHtml(){
  if (!ivsRows.length && !ivsShelved.length) return '<div class="ivcard"><div class="ivempty">No candidates yet.</div></div>';
  var rows = ivsRows.concat(ivsShelved).map(function(r){ return { r:r, c:ivsCalc(r) }; });
  rows.sort(function(a,b){
    if (a.c.done !== b.c.done) return a.c.done ? -1 : 1;
    if (a.c.done) return b.c.final - a.c.final;
    return b.c.scored - a.c.scored;
  });
  var h = '<table class="ivtab"><thead><tr><th>Rank</th><th>Candidate</th><th class="hm">Folder</th>'+
    '<th class="hm">Position</th><th class="hm">Salary exp.</th><th class="hm">Notice</th><th class="hm">Visa</th>'+
    '<th class="hm">Interview</th><th class="hm">Practical</th><th>Final</th><th>Verdict</th><th class="hm">Stage</th></tr></thead><tbody>';
  var rank = 0;
  rows.forEach(function(x){
    if (x.c.done) rank++;
    h += '<tr onclick="'+(x.r.shelf ? 'ivsShelfOpen(\''+x.r.id+'\')' : 'ivsPick(\''+x.r.id+'\')')+'">'+
      '<td class="n">'+(x.c.done ? rank : '—')+'</td>'+
      '<td><b>'+ivsEsc(ivsCandLabel(x.r))+'</b></td>'+
      '<td class="hm">'+ivsEsc(x.r.wave || '—')+'</td>'+
      IVS_DETAILS.filter(function(d){ return d[0] !== 'email'; }).map(function(d){ return '<td class="hm ivdc">'+ivsEsc(x.r[d[0]] || '—')+'</td>'; }).join('')+
      '<td class="n hm">'+ivsPart(x.c.int, x.c.iMax, x.c.iAll)+'</td><td class="n hm">'+ivsPart(x.c.prac, x.c.pMax, x.c.pAll)+'</td>'+
      '<td class="n">'+(x.c.done ? '<span class="ivbar"><i style="width:'+x.c.final+'%"></i></span><b>'+x.c.final+'</b>' : '—')+'</td>'+
      '<td>'+(x.c.done ? '<span class="ivpill '+x.c.verdict.c+'">'+x.c.verdict.t+'</span>'
                       : '<span class="ivpill">'+(x.c.scored === IVS_LINES ? 'All N/A' : x.c.scored ? (IVS_LINES-x.c.scored)+' to score' : 'Not scored')+'</span>')+'</td>'+
      '<td class="hm ivdc">'+ivsEsc(x.r.shelf ? IVS_SHELVES[x.r.shelf] : ivsStageWord(ivsStage(x.r)))+(ivsActLine(x.r.id) ? '<br><span style="font-size:12px;color:#5a4a3a">'+ivsEsc(ivsActLine(x.r.id))+'</span>' : '')+'</td>'+
    '</tr>';
  });
  return h + '</tbody></table>';
}

function ivsRender(fromPoll){
  var v = document.getElementById('interviews-view');
  if (!v) return;
  if (!ivsCode){
    v.innerHTML = '<div class="ivwrap"><div class="ivgate"><b>Interview scoring</b>'+
      '<div style="font-size:13.5px;color:#6b5a48;margin-bottom:12px">Candidate names and scores are private. Enter the interviewers\' passcode.</div>'+
      '<input id="ivs-code" type="password" inputmode="numeric" autocomplete="off" onkeydown="if(event.key===\'Enter\')ivsUnlock()">'+
      '<button class="ivb" onclick="ivsUnlock()">Open</button>'+
      (ivsErr ? '<div class="iverr">'+ivsEsc(ivsErr)+'</div>' : '')+
    '</div></div>';
    var ci = document.getElementById('ivs-code'); if (ci) ci.focus();
    return;
  }
  // while a chef is typing, a poll only refreshes the parts that are not under their thumb
  var ae = document.activeElement;
  var typing = ae && (ae.id === 'ivs-name' || ae.id === 'ivs-wave' || ae.id === 'ivs-notes' || ae.id === 'ivs-search' || ae.id === 'ivs-ren' || ae.id === 'ivs-shnote' || /^ivs-d-/.test(ae.id || ''));
  if (fromPoll && typing){
    ivsRenderList();
    var r = ivsRow(ivsSel), sumEl = document.getElementById('ivs-sum');
    if (r && sumEl) sumEl.outerHTML = ivsSumHtml(r);
    var ovEl = document.getElementById('ivs-ov');
    if (!r && ovEl) ovEl.outerHTML = ivsOverviewHtml();
    var sbEl = document.querySelector('#interviews-view .ivselbar');
    if (r && sbEl) sbEl.outerHTML = ivsSelBarHtml(r);
    var cvEl = document.getElementById('ivs-cvs');
    if (r && cvEl) cvEl.outerHTML = ivsCvsHtml(r);
    var acEl = document.getElementById('ivs-acts');
    if (r && acEl) acEl.outerHTML = ivsActsHtml(r);
    var flEl = document.getElementById('ivs-flag');
    if (r && flEl) flEl.innerHTML = ivsFlagHtml(r);
    // another chef's detail edits land in the fields this chef is not typing in
    if (r) IVS_DETAILS.forEach(function(d){
      var inp = document.getElementById('ivs-d-'+d[0]);
      if (inp && inp !== ae && !ivsDetT[d[0]] && inp.value !== (r[d[0]]||'')) inp.value = r[d[0]]||'';
    });
    var msEl = document.getElementById('ivs-mailscan');
    if (r && msEl && ivsMailScan[r.id] && (r.email || '').trim()) msEl.outerHTML = ivsMailScanHtml(r);   // another chef filled it
    if (r) document.querySelectorAll('#interviews-view .ivs').forEach(function(g){
      var k = g.getAttribute('data-k'), raw = (r.scores||{})[k], cur = raw == null ? -1 : +raw;
      g.querySelectorAll('button').forEach(function(b){ var on = cur === +b.getAttribute('data-v'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
      var by = document.querySelector('#interviews-view .ivby[data-by="'+k+'"]'); if (by) by.textContent = cur >= 0 ? ((r.scores_by||{})[k] || '') : '';
    });
    return;
  }
  var y = window.scrollY, keep = ivsScrollGrab();
  if (ivsScreen === 'name'){ v.innerHTML = '<div class="ivwrap">'+ivsNameHtml()+'</div>'; var ni = document.getElementById('ivs-me-new'); if (ni && !(ivsSettings && (ivsSettings.interviewers||[]).length)) ni.focus(); return; }
  if (ivsScreen === 'shelf'){ v.innerHTML = '<div class="ivwrap">'+ivsShelfHtml()+'</div>'; return; }
  if (ivsScreen === 'rounds' || !ivsRound){ v.innerHTML = '<div class="ivwrap">'+ivsRoundsHtml()+'</div>'; return; }
  var open = ivsTab === 'score' && !!ivsRow(ivsSel);
  var body = ivsTab === 'board' ? ivsBoardHtml() : ivsTab === 'emails' ? ivsEmailsHtml() : ivsTab === 'setup' ? ivsSetupHtml()
    : '<div class="ivgrid'+(open ? ' sel' : '')+'"><div class="ivcard ivside">'+ivsListShellHtml()+'</div>'+
      '<div class="ivcard" id="ivs-editor">'+ivsEditorHtml()+'</div></div>';
  var tab = function(k, label){ return '<button type="button" class="ivtabn'+(ivsTab===k?' on':'')+'" aria-pressed="'+(ivsTab===k)+'" onclick="ivsTab=\''+k+'\';ivsRender()">'+label+'</button>'; };
  // the kitchen app's own header is sticky: the list column sticks just below it, whatever its height
  var hd = document.querySelector('.app-header');
  v.style.setProperty('--ivhd', ((hd && hd.offsetHeight) || 0) + 'px');
  v.innerHTML = '<div class="ivwrap'+(open ? ' ivopen' : '')+'">'+
    '<div class="ivhd"><div><small>Roberto\'s Dubai · Kitchen · '+ivsEsc(ivsRound.position || 'Hiring')+(ivsRound.closed_on ? ' · closed' : '')+'</small><h2>'+ivsEsc(ivsRound.title)+'</h2>'+
      '<div class="ivwho">Scoring as <b>'+ivsEsc(ivsMe)+'</b><button onclick="ivsMeChange()">change</button> · <button onclick="ivsRoundsOpen()">other rounds</button> · <button onclick="ivsShelfOpen()">CV database</button></div></div>'+
      '<div id="ivs-stats">'+ivsStatsHtml()+'</div></div>'+
    '<div class="ivtabs">'+tab('score','Score')+tab('board','Leaderboard')+tab('emails','Emails')+tab('setup','Set-up')+
      '<button type="button" class="ivlock" onclick="ivsLock()" aria-label="Lock the board"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg><span>Lock</span></button>'+
    '</div>'+
    (ivsErr ? '<div class="iverr" style="margin-bottom:10px">'+ivsEsc(ivsErr)+'</div>' : '')+
    body +
    '<div class="ivsync">Synced live — shared with everyone scoring. Final = interview '+IVS_WEIGHTS.int+'% + practical '+IVS_WEIGHTS.prac+'%, given once all '+IVS_LINES+' lines are scored or marked N/A — N/A lines are left out of the average.</div>'+
  '</div>';
  ivsScrollPut(keep, !!fromPoll);   // the chips always stay put; the list only on a refresh
  if (fromPoll) window.scrollTo(0, y);
}
