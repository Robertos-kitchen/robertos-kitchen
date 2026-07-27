// ══════════════════════════════════════════════════════════════════════════
// MENU DEVELOPMENT PLAN
//
// THE WAY IN is "What's on": everything the kitchen is developing, when it goes
// live, and ONE next action each. It opens on the commitments already in the
// database — the Q4 slots from the marketing email, the standing menus — because
// those ARE what Danilo is required to develop, and a blank box would be the
// failure this rebuild exists to fix.
//
// Work reaches him two ways, and both end up as the same kind of row:
//   REQUESTED      Francesco asks (often pasting a marketing email). It lands on
//                  Danilo's list; DANILO then gives it the dates and the plan,
//                  and Francesco accepts that plan. This per-item loop is what
//                  replaced the old whole-plan Submit / Approve ceremony.
//   SELF-INITIATED He writes it in the box: "what do you want to develop?"
//
// Two rules the code holds to:
//   1. The assistant reads his words; THE APP DOES THE DATES. Turning a sentence
//      into a list of things is the model's job. Every date, duration and stage
//      boundary is integer arithmetic in this file (mpAddDays / mpBuildTimeline).
//      No date this module shows was ever produced by a model.
//   2. Nothing is saved that he hasn't confirmed. The read-back screen shows what
//      was understood as editable chips; only after he confirms does anything
//      write.
//
// Stages: Development → Testing → Approval → Costing, with Photoshoot floating.
// No Simphony stage. No fixed durations — six months or one week, same four
// stages stretched or squeezed. The layout is a proposal; every edge drags.
//
// One kitchen team, identical access (Danilo, Antonio, Andrea). There is no
// per-menu lead chef.
//
// Underneath, two things kept deliberately separate:
//   1. DISH BANK      — chefs log every dish they develop. The creative engine.
//                       Filling it is the team's whole job for the sprint.
//   2. MENU CALENDAR  — leadership schedules each menu across the year and
//                       pulls dishes from the bank.
// Plus Menu Briefs, Tasting sessions, and a comment thread per item, so the two
// of them can settle one activation without booking a meeting.
//
// Identity: this module has its own tap-your-name picker, limited to the people
// in menu_plan_members (Danilo, Antonio, Andrea Falcone = chefs; Francesco =
// approver; Aung Htwe = cost controller). No code, no password — his call: the
// team must feel zero friction.
// Every write is stamped with the name, so the audit trail survives.
//
// Reads every list from the DB (members, menus, months present on rows) — no
// hardcoded mirror of table data anywhere, so adding a person or a menu is an
// INSERT, not a redeploy.
// Schema: menu-plan-schema.sql, then menu-plan-campaigns.sql, then
// menu-plan-front-door.sql. The app checks for the last one's columns rather
// than assuming them, so it keeps working before it has been run.
//
// Reuses app.js globals: sb, SUPABASE_URL, SUPABASE_KEY, activeStation,
// hideAllPages, escHtml.
// ══════════════════════════════════════════════════════════════════════════

const MENUPLAN_KEY = 'menu_plan';

// ── UI vocabulary (presentation lists, not copies of table rows) ────────────
const MP_SECTIONS = ['Crudo – Frollato','Crudo – Naturale','Crudo – Marinato','Carne','Insalate',
  'Antipasti','Pizza','Paste & Riso','Secondi – Pesce','Secondi – Carne','Scala bite',
  'Dolce – plated','Dolce – trolley','Other'];
const MP_STATUSES = ['Idea','Trying','Testing','Approved','Costing','Retired'];
// The board columns. Retired is reachable from the status menu but is not a
// column — a retired dish should leave the board, not sit on it. "Costing" is
// the last column: an Approved dish moves here to get its cost sheet + price and
// go to the cost controller (there is no "Banked" any more).
const MP_BOARD    = ['Idea','Trying','Testing','Approved','Costing'];
const MP_ALLERGENS = [
  {code:'V', label:'Vegetarian'}, {code:'D', label:'Dairy'},   {code:'N', label:'Nuts'},
  {code:'R', label:'Raw'},        {code:'S', label:'Shellfish'},{code:'E', label:'Egg'},
  {code:'H', label:'Pork'},       {code:'G', label:'Gluten'}
];
const MP_CADENCES = ['Monthly','Quarterly','Seasonal','One-off event','Not sure'];
// Field caps. A dish name is a dish name — a 600-character one (pasted by
// accident) pushed the page 16× wider than the phone it was on.
const MP_MAX_NAME = 120, MP_MAX_DESC = 400, MP_MAX_LINE = 300, MP_MAX_PRICE = 60, MP_MAX_NOTE = 2000;
const MP_CELL_STATES = ['Develop','Testing','Photoshooting','Launch','Live','Changing'];
// Two-letter codes for the tiny calendar squares — single letters collided
// (Launch/Live both 'L', Testing/... ). Kept in workflow order.
const MP_CELL_CODE = { Develop:'De', Testing:'Te', Photoshooting:'Ph', Launch:'La', Live:'Li', Changing:'Ch' };
const MP_DECISIONS = ['Approve','Rework','Reject'];

// ── the stages of a job ─────────────────────────────────────────────────────
// Development → Testing → Approval → Costing, in that order, with Photoshoot
// floating: it can sit anywhere in between, and it is allowed to overlap.
// There is no Simphony stage — it was considered and dropped. There are no
// fixed durations either: a job might be six months or one week, and it is the
// same four stages stretched or squeezed. Nothing here counts weeks back from a
// launch.
const MP_STAGES = ['Development','Testing','Approval','Costing'];
const MP_PHOTO_STAGE = 'Photoshoot';
const MP_ALL_STAGES = MP_STAGES.concat([MP_PHOTO_STAGE]);
// How the app first splits a window. This is a PROPOSAL, never a rule — every
// edge drags and every stage can be dropped.
const MP_STAGE_WEIGHT = { Development:0.50, Testing:0.20, Approval:0.15, Costing:0.15 };
const MP_STAGE_NOTE = {
  Development:  'building the dishes',
  Testing:      'tasting and deciding',
  Approval:     'Francesco says yes',
  Costing:      'the cost sheet and the price',
  Photoshoot:   'photographing the dishes'
};

// The planning window: Jul 2026 → Jun 2027 (12 months) — the same Jul→Jun year
// the Events report uses, not the calendar year. It starts in July, not
// September, because a September launch is DEVELOPED in July and August: a grid
// that begins at the launch month has nowhere to record the work that gets you
// there. Stored as first-of-month dates so the window can move again later
// without rewriting a single stored row.
const MP_MONTHS = (function(){
  var out = [], y = 2026, m = 7;
  for (var i = 0; i < 12; i++){
    out.push({ key: y + '-' + String(m).padStart(2,'0') + '-01', y: y, m: m });
    m++; if (m > 12){ m = 1; y++; }
  }
  return out;
})();
const MP_MON_NAMES = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── state ───────────────────────────────────────────────────────────────────
let mpMe       = null;   // {name, role} — who is using the module on this device
let mpMembers  = [];
let mpMenus    = [];
let mpDishes   = [];
let mpCal      = [];     // calendar cells
let mpComments = [];
let mpTastings = [];     // [{...session, items:[...]}]
let mpTastingScores = {};// tasting item id -> [ one score row PER PERSON ]
let mpScoresTable = true;// false once we learn menu_plan_tasting_scores isn't there yet
let mpSprint   = null;
let mpCampaigns = [];    // seasons/marketing periods that OWN their event dates
let mpPhotos   = {};     // dish_id -> data URL (loaded only with the Dish Bank)
let mpMenuFiles = {};    // menu_id -> [ {id,file_name,file_path,mime,size_bytes,uploaded_by} ]
let mpChannel  = null;

// Where uploaded menu documents (Word / PDF) live. The bytes go to Supabase
// Storage — NOT base64 in a table like the dish photos — because a real menu
// PDF is megabytes, not a downscaled thumbnail, and blobs that big have no place
// in Postgres backups. One small metadata row per file is all the DB keeps.
const MP_BUCKET = 'menu-plan';
const MP_MAX_FILE_MB = 20;
const MP_DOC_TYPES = '.pdf,.doc,.docx,.pages,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*';
function mpFilesFor(menuId){ return mpMenuFiles[menuId] || []; }
function mpPublicUrl(path){ return SUPABASE_URL + '/storage/v1/object/public/' + MP_BUCKET + '/' + String(path).split('/').map(encodeURIComponent).join('/'); }
function mpFileIcon(mime, name){
  var n = (name || '').toLowerCase();
  if ((mime || '').indexOf('pdf') >= 0 || /\.pdf$/.test(n)) return 'PDF';
  if ((mime || '').indexOf('word') >= 0 || (mime || '').indexOf('officedocument') >= 0 || /\.docx?$/.test(n)) return 'DOC';
  if ((mime || '').indexOf('image') >= 0 || /\.(png|jpe?g|heic|webp)$/.test(n)) return 'IMG';
  return 'FILE';
}
function mpFileSize(bytes){
  if (!bytes) return '';
  return bytes < 1024*1024 ? Math.max(1, Math.round(bytes/1024)) + ' KB' : (bytes/1048576).toFixed(1) + ' MB';
}
let mpTab      = 'home'; // home | plan | dishes | calendar | briefs | tastings

// ── the new front door ──────────────────────────────────────────────────────
// Two capabilities the app checks for rather than assumes, so it keeps working
// on a DB where menu-plan-front-door.sql has not been run yet.
let mpHasStages   = true;  // menu_plan_calendar carries stage / starts_on / ends_on
let mpHasRequests = true;  // menu_plan_menus carries origin / request_note / plan_state
let mpHasOnPlan   = true;  // menu_plan_menus carries on_plan
let mpIntake = null;       // the one-box flow while it is open
let mpTl     = null;       // the timeline being dragged
let mpBoardView = 'list';// list | board  (list is the phone default)
let mpCalView  = 'list'; // list | grid  (list is the calm phone default)
let mpFilter   = { section:'', menu:'', status:'', q:'' };
let mpDishFiles = {};    // dish_id -> [ cost-sheet file rows ]
let mpGroupSel  = {};    // menu_group -> selected variant menu id (calendar/briefs)
let mpLoaded   = false;
let mpDuplicateSeed = null;   // one-shot: fields to pre-fill when mpAddDish() opens next

// ── guesses & templates: reduce blank-page thinking, never override a manual pick ──
// \bpizza\b, not /pizza/ — "Pizzaiola di manzo" is a beef dish, and the loose
// pattern claimed it for Pizza before the word "manzo" was even typed.
const MP_SECTION_GUESS = [
  [/risotto|riso\b/i, 'Paste & Riso'],
  [/pasta|spaghett|tagliatelle|raviol|gnocchi|tortell|linguine|orecchiette|penne|fettuccine|paccheri|rigatoni|lasagn|cannellon|pappardelle|maccheron/i, 'Paste & Riso'],
  [/frollat/i, 'Crudo – Frollato'],
  [/marinat/i, 'Crudo – Marinato'],
  [/crudo|tartare|carpaccio/i, 'Crudo – Naturale'],
  [/\bpizza\b|pizzette|calzone/i, 'Pizza'],
  [/insalat|salad/i, 'Insalate'],
  [/tiramis|semifreddo|torta|gelato|sorbet|panna cotta|dolce|panettone|pandoro|cannol|cassata|bab[aà]\b|sfogliatell|crostata|budino|zabaione|zeppol|profiterol|millefoglie/i, 'Dolce – plated'],
  [/vitello|manzo|agnello|maiale|pollo|guancia|josper|cappone|anatra|cinghiale|quaglia|coniglio|faraona|tacchino|cervo|capriolo|ossobuco|brasato/i, 'Carne'],
  [/branzino|orata|pesce|gambero|scampi|capesante|tonno|salmone|baccal[aà]|polpo|moscardin|seppi|calamar|ricciola|rombo|sogliola|cernia|spigola|astice|aragosta/i, 'Secondi – Pesce'],
  [/antipast|bruschetta|crostini|zuppa|minestr|vellutata|sformato|parmigiana|caponata|tortino|carciof/i, 'Antipasti']
];
const MP_ALLERGEN_GUESS = [
  [/dairy|cheese|formaggio|burrata|parmig|pecorino|butter|burro|cream|panna|mozzarella|gorgonzola|castelmagno|ricotta|stracciatella/i, 'D'],
  [/gluten|pasta|bread|pane|flour|farina|\bpizza\b|grissini|focaccia|tortell|raviol|gnocchi|crostini|panzerotti/i, 'G'],
  [/nocciola|mandorla|almond|hazelnut|pistacchio|pistachio|walnut|noce|pinoli|pine nut/i, 'N'],
  [/gambero|scampi|capesante|shrimp|prawn|granchio|crab|lobster|astice|vongole|clam|cozze|mussel/i, 'S'],
  [/\buovo\b|\buova\b|maionese|mayo|egg/i, 'E'],
  [/maiale|guanciale|pancetta|prosciutto|salame|lardo|miele|honey|pork/i, 'H'],
  [/crudo|tartare|carpaccio/i, 'R']
];
function mpGuessSectionFor(name){
  var n = (name || '').toLowerCase();
  for (var i = 0; i < MP_SECTION_GUESS.length; i++) if (MP_SECTION_GUESS[i][0].test(n)) return MP_SECTION_GUESS[i][1];
  return null;
}
// True while the section box holds the app's own guess and no person has touched
// it. Without it the guard that protects a manual pick also protected the guess,
// so the first thing typed ("Pizzaiola…") locked the section and the rest of the
// name ("…di manzo") could never correct it.
let mpSectionIsGuess = false;
function mpGuessSection(name){
  var sel = document.getElementById('mpf-section');
  if (!sel) return;
  if (sel.value && !mpSectionIsGuess) return;   // never override a person's pick
  var guess = mpGuessSectionFor(name);
  if (guess && guess !== sel.value){
    sel.value = guess;
    mpSectionIsGuess = true;
    var q = document.getElementById('mpf-section-q'); if (q) q.value = guess;   // keep the visible search box in sync
    var hint = document.getElementById('mpf-section-hint');
    if (hint) hint.textContent = 'Guessed from the name — change if wrong.';
  }
}
// SUGGESTS allergens, never ticks them. An allergen nobody consciously tapped is
// a liability however good the guess is, so each one costs one tap to accept —
// and the hint only ever names the text it actually read.
function mpSuggestAllergens(){
  var wrap = document.getElementById('mpf-allerg');
  var hint = document.getElementById('mpf-allerg-hint');
  if (!wrap || !hint) return;
  var name = ((document.getElementById('mpf-name') || {}).value || '').trim();
  var desc = ((document.getElementById('mpf-desc') || {}).value || '').trim();
  var text = (name + ' ' + desc).toLowerCase();
  var hit = [];
  MP_ALLERGEN_GUESS.forEach(function(pair){
    if (!pair[0].test(text)) return;
    var btn = wrap.querySelector('.mp-pill[data-v="' + pair[1] + '"]');
    if (btn && !btn.classList.contains('on')) hit.push(pair[1]);   // don't suggest what's already ticked
  });
  if (!hit.length){ hint.innerHTML = ''; return; }
  var read = name && desc ? 'the name and description' : (desc ? 'the description' : 'the name');
  hint.innerHTML = 'Possible from ' + read + ' — tap to add: ' +
    hit.map(function(code){
      var a = MP_ALLERGENS.find(function(x){ return x.code === code; });
      return '<button type="button" class="mp-suggest" onclick="mpAddSuggestedAllergen(\'' + code + '\')">+ ' + mpEsc(a ? a.label : code) + '</button>';
    }).join(' ');
}
function mpAddSuggestedAllergen(code){
  var btn = document.querySelector('#mpf-allerg .mp-pill[data-v="' + code + '"]');
  if (btn) btn.classList.add('on');
  mpSuggestAllergens();
}
// Starter text for a brief — filled into the FIELD as real, editable text (not a
// placeholder), so writing a menu starts from a sentence instead of a blank page.
const MP_BRIEF_TEMPLATES = [
  { test:/business lunch/i, identity:'Fast, focused lunch for the business crowd nearby.', structure:'2 courses, quick service', price:'AED 145' },
  { test:/^à la carte$|a la carte/i, identity:'The full seasonal menu — coastal Italian, ingredient-led.', structure:'6 antipasti · 5 paste · 4 secondi · 4 dolci', price:'à la carte' },
  { test:/scala|lounge/i, identity:'Relaxed lounge bites and shareable plates.', structure:'8–10 small plates', price:'à la carte' },
  { test:/set menu/i, identity:'A set sequence, the same for the whole table.', structure:'4 courses', price:'AED 295 per person' },
  { test:/canap/i, identity:'Bite-sized canapés for a standing reception.', structure:'8 pieces per person', price:'AED 95 per person' },
  { test:/vegan/i, identity:'Fully plant-based, same ambition as the main menu.', structure:'5 antipasti · 4 paste · 3 secondi · 3 dolci', price:'à la carte' },
  { test:/aperitivo/i, identity:'Early-evening drinks with small bites.', structure:'4–5 sharing bites', price:'AED 85 per person' },
  { test:/truffle/i, identity:'A short truffle-forward menu for the season.', structure:'4–5 dishes built around truffle', price:'AED 350 per person' },
  { test:/festive|christmas|new year/i, identity:'A festive set menu for the season.', structure:'4 courses', price:'AED 395 per person' },
  { test:/dessert/i, identity:'The dessert selection.', structure:'5–6 dolci', price:'à la carte' },
  { test:/brunch/i, identity:'Family-style weekend brunch.', structure:'Shared starters + main + dessert', price:'AED 275 per person' },
  { test:/dinner|event/i, identity:'A one-off guest dinner.', structure:'Multi-course set menu', price:'TBC' }
];
function mpBriefTemplate(name){
  for (var i = 0; i < MP_BRIEF_TEMPLATES.length; i++) if (MP_BRIEF_TEMPLATES[i].test.test(name || '')) return MP_BRIEF_TEMPLATES[i];
  return null;
}
// Remember the last cadence / price picked, so writing a run of similar menus
// (the four Festive ones) doesn't mean re-picking every time.
function mpRememberMenuDefaults(row){
  try {
    if (row.change_cadence) localStorage.setItem('menu-plan-last-cadence', row.change_cadence);
    if (row.price) localStorage.setItem('menu-plan-last-price', row.price);
  } catch(e){}
}
function mpLastMenuDefaults(){
  try {
    return {
      change_cadence: localStorage.getItem('menu-plan-last-cadence') || null,
      price: localStorage.getItem('menu-plan-last-price') || null
    };
  } catch(e){ return {}; }
}

function mpEsc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function mpIsApprover(){ return !!(mpMe && mpMe.role === 'approver'); }
function mpIsCostController(){ return !!(mpMe && mpMe.role === 'cost_controller'); }
// A cost controller is a reviewer, not an author — they can't add/edit dishes,
// menus, calendar or tastings; their one job is marking a dish Costed.
function mpCanAuthor(){ return !!(mpMe && (mpMe.role === 'chef' || mpMe.role === 'approver')); }
const MP_ROLE_LABEL = { chef:'Develops dishes', approver:'Approves the plan', cost_controller:'Costs the dishes' };
function mpToday(){ return (typeof TODAY !== 'undefined' && TODAY) ? TODAY : new Date().toISOString().slice(0,10); }
function mpMonthLabel(key){ var p = key.split('-'); return MP_MON_NAMES[+p[1]] + ' ' + p[0]; }
function mpDateLabel(d){
  if (!d) return '';
  var p = String(d).slice(0,10).split('-');
  return p[2].replace(/^0/,'') + ' ' + MP_MON_NAMES[+p[1]] + ' ' + p[0];
}

// ── errors: always say what to do next, never a bare failure ────────────────
function mpErr(res, what){
  if (!res || !res.error) return false;
  var m = String(res.error.message || res.error);
  console.warn('[menu-plan] ' + what + ' failed', res.error);
  mpToast(m.indexOf('read-only') >= 0
    ? 'DEV site is read-only — tap the DEV badge (bottom-left) to enable test writes.'
    : 'Could not save ' + what + '. Check the connection and try again.', true);
  return true;
}
let mpToastTimer = null;
function mpToast(msg, bad){
  var el = document.getElementById('mp-toast');
  if (!el) return;
  el.className = 'mp-toast show' + (bad ? ' bad' : '');
  el.innerHTML = (bad ? '' : '<span class="mp-tick">&#10003;</span> ') + mpEsc(msg);
  if (mpToastTimer) clearTimeout(mpToastTimer);
  mpToastTimer = setTimeout(function(){ el.className = 'mp-toast'; }, bad ? 5200 : 2200);
}

// ══ DATA ═══════════════════════════════════════════════════════════════════
// Dishes and comments are the two tables that grow without a ceiling, so they
// go through the paged fetch — PostgREST silently truncates a single response
// at 1000 rows, which is the bug class that once hid clock-ins from the roster.
async function mpLoadAll(){
  var r = await Promise.all([
    sb.from('menu_plan_members').select('*').eq('active', true).order('sort_order'),
    sb.from('menu_plan_menus').select('*').eq('active', true).order('sort_order'),
    (typeof kFetchAllPaged === 'function'
      ? kFetchAllPaged(function(){ return sb.from('menu_plan_dishes').select('*').order('created_at', { ascending:false }); })
      : sb.from('menu_plan_dishes').select('*').order('created_at', { ascending:false })),
    sb.from('menu_plan_calendar').select('*'),
    (typeof kFetchAllPaged === 'function'
      ? kFetchAllPaged(function(){ return sb.from('menu_plan_comments').select('*').order('created_at'); })
      : sb.from('menu_plan_comments').select('*').order('created_at')),
    sb.from('menu_plan_sprint').select('*').eq('id', 1).maybeSingle(),
    sb.from('menu_plan_tastings').select('*').order('session_date', { ascending:false }),
    sb.from('menu_plan_tasting_items').select('*'),
    sb.from('menu_plan_menu_files').select('*').order('created_at'),
    sb.from('menu_plan_dish_files').select('*').order('created_at'),
    sb.from('menu_plan_campaigns').select('*').order('sort_order'),
    sb.from('menu_plan_tasting_scores').select('*').order('created_at'),
    // Two probes, not two guesses. Naming the columns makes PostgREST fail
    // loudly if menu-plan-front-door.sql has not been run, and a failure here
    // is the signal — not an excuse to break the rest of the page.
    sb.from('menu_plan_calendar').select('id,stage,starts_on,ends_on').limit(1),
    sb.from('menu_plan_menus').select('id,origin,plan_state,request_note,needed_by,requested_by').limit(1),
    sb.from('menu_plan_menus').select('id,on_plan').limit(1)
  ]);
  mpMembers  = r[0].data || [];
  mpMenus    = r[1].data || [];
  mpDishes   = r[2].data || [];
  mpCal      = r[3].data || [];
  mpComments = r[4].data || [];
  mpSprint   = r[5].data || { id:1, target_tried:60, target_approved:30, status:'draft' };
  var items  = r[7].data || [];
  mpTastings = (r[6].data || []).map(function(s){
    return Object.assign({}, s, { items: items.filter(function(i){ return i.session_id === s.id; }) });
  });
  mpMenuFiles = {}; mpDishFiles = {};
  // Optional tables — an older DB without the files migration must not break the
  // whole module, so a load error here is swallowed, not surfaced.
  (r[8] && !r[8].error ? r[8].data : []).forEach(function(f){
    (mpMenuFiles[f.menu_id] = mpMenuFiles[f.menu_id] || []).push(f);
  });
  (r[9] && !r[9].error ? r[9].data : []).forEach(function(f){
    (mpDishFiles[f.dish_id] = mpDishFiles[f.dish_id] || []).push(f);
  });
  // Optional table — a DB without the campaigns migration still runs; the menus
  // just fall back to the two lanes with no season grouping.
  mpCampaigns = (r[10] && !r[10].error ? r[10].data : []) || [];
  // Optional table — before menu-plan-tasting-scores.sql is run there is nowhere
  // to keep a score per person, so scoring falls back to the single shared row
  // it used to write. Same swallow-the-error habit as the two above.
  mpScoresTable = !!(r[11] && !r[11].error);
  mpTastingScores = {};
  (mpScoresTable ? r[11].data : []).forEach(function(sc){
    (mpTastingScores[sc.item_id] = mpTastingScores[sc.item_id] || []).push(sc);
  });
  mpHasStages   = !!(r[12] && !r[12].error);
  mpHasRequests = !!(r[13] && !r[13].error);
  mpHasOnPlan   = !!(r[14] && !r[14].error);
  mpLoaded = true;
  // A failed members load would empty the picker and lock everyone out — say so.
  if (r[0].error) mpToast('Could not load the team list. Check the connection.', true);
}
async function mpLoadPhotos(){
  var res = await sb.from('menu_plan_dish_photos').select('dish_id,data_url');
  if (res.error) return;
  mpPhotos = {};
  (res.data || []).forEach(function(p){ mpPhotos[p.dish_id] = p.data_url; });
}

function mpSubscribe(){
  if (mpChannel){ sb.removeChannel(mpChannel); mpChannel = null; }
  var tables = ['menu_plan_dishes','menu_plan_menus','menu_plan_calendar','menu_plan_comments','menu_plan_sprint','menu_plan_menu_files','menu_plan_dish_files','menu_plan_tastings','menu_plan_tasting_items','menu_plan_tasting_scores','menu_plan_campaigns'];
  mpChannel = sb.channel('menu_plan_changes');
  tables.forEach(function(t){
    mpChannel = mpChannel.on('postgres_changes', { event:'*', schema:'public', table:t }, function(){
      if (activeStation !== MENUPLAN_KEY) return;
      // Never blow away a field someone is typing in (their own save echoes back
      // here). Reload the data, redraw only when nothing is focused.
      mpLoadAll().then(function(){
        if (activeStation !== MENUPLAN_KEY) return;
        if (mpTyping() || document.getElementById('mp-sheet')) return;
        mpRender();
      });
    });
  });
  mpChannel.subscribe(function(status){
    var dot = document.getElementById('realtime-dot');
    if (dot) dot.classList.toggle('live', status === 'SUBSCRIBED');
  });
}
function mpTyping(){
  var a = document.activeElement;
  return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
}

// ── derived counts ──────────────────────────────────────────────────────────
const MP_RANK = { Idea:0, Trying:1, Testing:2, Approved:3, Costing:4, Retired:-1 };
function mpTriedCount(){ return mpDishes.filter(function(d){ return MP_RANK[d.status] >= 1; }).length; }
// "approved" for the sprint goal = reached Approved OR beyond (Costing counts too).
function mpApprovedCount(){ return mpDishes.filter(function(d){ return MP_RANK[d.status] >= 3; }).length; }
function mpCostingCount(){ return mpDishes.filter(function(d){ return d.status === 'Costing'; }).length; }
function mpNextTasting(){
  var t = mpToday();
  var up = mpTastings.filter(function(s){ return s.session_date >= t; })
                     .sort(function(a,b){ return a.session_date < b.session_date ? -1 : 1; });
  return up[0] || null;
}
function mpCellState(menuId, monthKey){
  var c = mpCal.find(function(x){ return x.menu_id === menuId && String(x.month).slice(0,10) === monthKey; });
  return c ? c.state : '';
}
function mpCommentsFor(type, id){
  return mpComments.filter(function(c){ return c.target_type === type && (id ? c.target_id === id : !c.target_id); });
}
function mpOpenCommentCount(type, id){
  return mpCommentsFor(type, id).filter(function(c){ return !c.resolved; }).length;
}
// The menu names a dish can be tagged for come from the menus table, so a new
// menu (Bartolini) is instantly taggable with no redeploy. Grouped variants
// (Set Menu A/B/C) are still tagged individually.
function mpMenuTagOptions(){ return mpMenus.map(function(m){ return m.name; }); }

// ── menu grouping (Set Menu A/B/C collapse to one row + dropdown) ────────────
// mpMenuRows() turns the flat menu list into display rows: a standalone menu is
// its own row; menus sharing a menu_group become ONE row carrying every variant.
// The calendar and the briefs both render from this, so grouping is defined once.
function mpMenuRows(){
  var rows = [], seen = {};
  mpMenus.forEach(function(m){
    if (m.menu_group){
      if (seen[m.menu_group]) return;
      seen[m.menu_group] = true;
      var variants = mpMenus.filter(function(x){ return x.menu_group === m.menu_group; })
        .sort(function(a,b){ return (a.variant_label || '') < (b.variant_label || '') ? -1 : 1; });
      rows.push({ group: m.menu_group, variants: variants, sort: m.sort_order || 0 });
    } else {
      rows.push({ menu: m, sort: m.sort_order || 0 });
    }
  });
  return rows.sort(function(a,b){ return a.sort - b.sort; });
}
// Which variant of a group is currently selected in the dropdown (defaults to
// the first). Returns the menu object.
function mpSelVariant(row){
  var id = mpGroupSel[row.group];
  return row.variants.find(function(v){ return v.id === id; }) || row.variants[0];
}
function mpNextVariantLabel(variants){
  // A, B, C … next unused letter, then fall back to a number.
  var used = variants.map(function(v){ return (v.variant_label || '').toUpperCase(); });
  for (var i = 0; i < 26; i++){ var L = String.fromCharCode(65 + i); if (used.indexOf(L) === -1) return L; }
  return String(variants.length + 1);
}

// ── main vs event: two kinds of work, weighted differently on screen ─────────
// A MAIN menu is created (à la carte, seasonal) — it earns a full card and the
// dish-development treatment. An EVENT menu is a dated one-off (Christmas Eve, a
// guest dinner) — lighter work: pick dishes from the bank + set a price. The
// kind is stored on the row; if an older row has none, we derive it so the split
// works before the migration is run (a one-off cadence = an event).
function mpMenuKind(m){
  if (m && (m.kind === 'main' || m.kind === 'event')) return m.kind;
  return (m && m.change_cadence === 'One-off event') ? 'event' : 'main';
}
function mpIsEventMenu(m){ return mpMenuKind(m) === 'event'; }
// The date an event happens — its own event_date, else the launch it was seeded
// with. Drives the date chip and the "in N weeks" countdown.
function mpMenuEventDate(m){ return (m && (m.event_date || m.launch_date)) || null; }
// Which campaign (season) an event belongs to: an explicit campaign_id wins; if
// none is set we fall back to the event's date landing inside a campaign's range,
// so December's nights nest under the December campaign with no per-row linking.
function mpCampaignFor(m){
  if (!m || !mpIsEventMenu(m)) return null;
  if (m.campaign_id){ var direct = mpCampaigns.find(function(c){ return c.id === m.campaign_id; }); if (direct) return direct; }
  var d = mpMenuEventDate(m); if (!d) return null;
  d = String(d).slice(0,10);
  return mpCampaigns.find(function(c){
    return c.date_from && c.date_to && d >= String(c.date_from).slice(0,10) && d <= String(c.date_to).slice(0,10);
  }) || null;
}
function mpWeeksUntil(dateStr){
  if (!dateStr) return null;
  var t = mpToday(), d = String(dateStr).slice(0,10);
  if (d < t) return null;
  var ms = new Date(d + 'T00:00:00') - new Date(t + 'T00:00:00');
  return Math.max(0, Math.round(ms / (7 * 864e5)));
}
// Dishes assembled onto a menu = dishes tagged for it (the existing for_menus
// mechanism). Approved-and-beyond count is what "N dishes chosen" reports.
function mpMenuDishPool(name){ return mpDishes.filter(function(d){ return (d.for_menus || []).includes(name); }); }

// Split the whole menu list into the two lanes + the campaigns that own dates.
// A campaign's core menu is pulled out of the lists and shown in its header, so
// it never doubles as a loose card. Grouped menus (Set Menu A/B/C) are mains.
function mpPlanGroups(){
  var coreIds = {};
  mpCampaigns.forEach(function(c){ if (c.core_menu_id) coreIds[c.core_menu_id] = c.id; });
  var buckets = {};
  mpCampaigns.forEach(function(c){ buckets[c.id] = { campaign:c, core:null, events:[] }; });
  var mains = [], looseEvents = [];
  mpMenuRows().forEach(function(row){
    if (row.group){ mains.push(row); return; }          // Set Menu group = a main
    var m = row.menu;
    if (coreIds[m.id]){ var b = buckets[coreIds[m.id]]; if (b) b.core = m; return; }
    if (mpIsEventMenu(m)){
      var c = mpCampaignFor(m);
      if (c && buckets[c.id]) buckets[c.id].events.push(m);
      else looseEvents.push(m);
    } else {
      mains.push(row);
    }
  });
  var campaigns = mpCampaigns
    .map(function(c){ return buckets[c.id]; })
    .filter(function(b){ return b.core || b.events.length; });
  campaigns.forEach(function(b){
    b.events.sort(function(a,c){ return (mpMenuEventDate(a) || '') < (mpMenuEventDate(c) || '') ? -1 : 1; });
  });
  looseEvents.sort(function(a,c){ return (mpMenuEventDate(a) || '') < (mpMenuEventDate(c) || '') ? -1 : 1; });
  return { mains:mains, campaigns:campaigns, looseEvents:looseEvents };
}

// ══ IDENTITY — tap your name ═══════════════════════════════════════════════
// No code by design. Everything is stamped with the name so the trail is intact.
function mpRestoreMe(){
  try {
    var raw = localStorage.getItem('menu-plan-me');
    if (!raw) return null;
    var me = JSON.parse(raw);
    // Re-resolve against the live list: a role change in the DB must win over
    // whatever this device remembered.
    var m = mpMembers.find(function(x){ return x.name === me.name; });
    return m ? { name:m.name, role:m.role } : null;
  } catch(e){ return null; }
}
function mpAskWhoAmI(){
  return new Promise(function(resolve){
    var done = false;
    function finish(v){
      if (done) return; done = true;
      var o = document.getElementById('mp-who'); if (o) o.remove();
      resolve(v);
    }
    var ov = document.createElement('div');
    ov.id = 'mp-who'; ov.className = 'mp-ovl';
    ov.innerHTML =
      '<div class="mp-ovl-box">' +
        '<div class="mp-ovl-title">Who are you?</div>' +
        '<div class="mp-ovl-sub">Tap your name. Everything you add is saved under it.</div>' +
        '<div class="mp-who-list">' +
          mpMembers.map(function(m, i){
            var ini = (m.name || '').trim().split(/\s+/).map(function(p){ return (p[0] || '').toUpperCase(); }).slice(0,2).join('');
            return '<button class="mp-who-btn" data-i="' + i + '">' +
              '<span class="mp-who-ini">' + mpEsc(ini) + '</span>' +
              '<span><span class="mp-who-name">' + mpEsc(m.name) + '</span>' +
              '<span class="mp-who-role">' + (MP_ROLE_LABEL[m.role] || 'Develops dishes') + '</span></span>' +
            '</button>';
          }).join('') +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.querySelectorAll('.mp-who-btn').forEach(function(b){
      b.onclick = function(){
        var m = mpMembers[+b.getAttribute('data-i')];
        try { localStorage.setItem('menu-plan-me', JSON.stringify({ name:m.name })); } catch(e){}
        finish({ name:m.name, role:m.role });
      };
    });
  });
}
function mpSwitchUser(){
  try { localStorage.removeItem('menu-plan-me'); } catch(e){}
  mpMe = null;
  mpAskWhoAmI().then(function(me){
    if (!me){ openHome(); return; }
    mpMe = me; mpRender();
  });
}

// ══ ENTRY POINT ════════════════════════════════════════════════════════════
async function openMenuPlan(){
  activeStation = MENUPLAN_KEY;
  hideAllPages();
  var host = document.getElementById('menuplan-view');
  host.style.display = 'block';
  document.querySelector('.footer-bar').style.display = 'flex';
  document.getElementById('foot-label').textContent = 'Menu Development Plan';
  host.innerHTML = MP_STYLE + '<div class="mp-wrap"><div class="mp-h1">Menu Development Plan</div><div class="mp-loading">Loading…</div></div>';
  await mpLoadAll();
  if (activeStation !== MENUPLAN_KEY) return;
  // No members = the one-time SQL has not been run (or the connection is down).
  // Say exactly that instead of showing an empty picker nobody can get past.
  if (!mpMembers.length){
    host.innerHTML = MP_STYLE +
      '<div class="mp-wrap"><div class="mp-h1">Menu Development Plan</div>' +
      '<div class="mp-body"><div class="mp-empty big">' +
        'This module is not set up yet.<br/>' +
        'Run <strong>menu-plan-schema.sql</strong> once in the Kitchen Supabase project, then reopen this page.' +
      '</div>' +
      '<button class="mp-btn ghost" onclick="openHome()">Back to the kitchen</button></div></div>';
    return;
  }
  mpMe = mpRestoreMe();
  if (!mpMe){
    mpMe = await mpAskWhoAmI();
    if (!mpMe){ openHome(); return; }
  }
  mpSubscribe();
  mpRender();
  mpLoadPhotos().then(function(){ if (activeStation === MENUPLAN_KEY && mpTab === 'dishes' && !document.getElementById('mp-sheet')) mpRender(); });
}

// ══ SHELL ══════════════════════════════════════════════════════════════════
function mpRender(){
  var host = document.getElementById('menuplan-view');
  if (!host || activeStation !== MENUPLAN_KEY) return;
  // What's on is the way in now. The old five tabs are still here and still
  // work — if the new front door reads wrong to the team, nothing is lost.
  var tabs = [
    { k:'home',     label:'What’s on' },
    { k:'plan',     label:'The Plan' },
    { k:'dishes',   label:'Dishes',     badge: mpDishes.length },
    { k:'calendar', label:'Calendar' },
    { k:'briefs',   label:'Menus' },
    { k:'tastings', label:'Tastings',   badge: mpTastings.length }
  ];
  var body = mpTab === 'home'     ? mpRenderHome()
           : mpTab === 'plan'     ? mpRenderPlan()
           : mpTab === 'dishes'   ? mpRenderDishes()
           : mpTab === 'calendar' ? mpRenderCalendar()
           : mpTab === 'briefs'   ? mpRenderBriefs()
           :                        mpRenderTastings();

  host.innerHTML = MP_STYLE +
    '<div class="mp-wrap">' +
      '<div class="mp-top">' +
        '<div>' +
          '<div class="mp-h1">Menu Development Plan</div>' +
          '<div class="mp-h1sub">' + mpEsc(mpTab === 'home' ? 'Everything on, and what’s next.' : mpStatusLine()) + '</div>' +
        '</div>' +
        '<button class="mp-me" onclick="mpSwitchUser()" title="Not you? Tap to switch">' +
          mpEsc(mpMe.name.split(' ')[0]) + ' <span>switch</span></button>' +
      '</div>' +
      '<div class="mp-tabs">' +
        tabs.map(function(t){
          return '<button class="mp-tab' + (mpTab === t.k ? ' on' : '') + '" onclick="mpGo(\'' + t.k + '\')">' +
            mpEsc(t.label) + (t.badge ? '<i>' + t.badge + '</i>' : '') + '</button>';
        }).join('') +
      '</div>' +
      body +
    '</div>' +
    '<div id="mp-toast" class="mp-toast"></div>';
}
function mpGo(tab){ mpTab = tab; mpRender(); window.scrollTo(0,0); }

// The subtitle on every tab except What's on. The first three lines only ever
// show on a DB row left behind by the old whole-plan ceremony — nothing can set
// those states any more. The last line is the one that actually renders, so it
// says where the work is agreed instead of promising a submission that can
// never happen.
function mpStatusLine(){
  var s = (mpSprint && mpSprint.status) || 'draft';
  if (s === 'approved')          return 'Approved by ' + (mpSprint.approved_by || 'Francesco') + ' · ' + mpDateLabel(mpSprint.approved_at);
  if (s === 'submitted')         return 'Submitted ' + mpDateLabel(mpSprint.submitted_at) + ' · waiting for Francesco';
  if (s === 'changes_requested') return 'Francesco asked for changes — see the comments';
  return 'Each thing is agreed on What’s on';
}

// ══ 0. WHAT'S ON — the way in ══════════════════════════════════════════════
// Work reaches the kitchen two ways. Most of it is HANDED to Danilo: Francesco
// asks for a menu or an activation and Danilo then comes up with the dates and
// the plan. The rest he starts himself, through the box. Both end up as an
// ordinary menu_plan_menus row — only the origin differs — so everything made
// here is a first-class record the old five tabs can still see.
//
// This screen is never empty. It opens on the 22 commitments the business has
// already made, because those ARE the things he is required to develop.

// ── date arithmetic. Every date in this module comes from here. ─────────────
// The assistant reads his words; the app does the dates. Nothing below ever
// asks a model for a day, a duration or a boundary.
function mpAddDays(iso, n){
  var d = new Date(String(iso).slice(0,10) + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function mpDaysBetween(a, b){
  return Math.round((new Date(String(b).slice(0,10) + 'T00:00:00') - new Date(String(a).slice(0,10) + 'T00:00:00')) / 864e5);
}
// "in 3 weeks", not "21 days" — the way he'd say it out loud.
function mpHowFar(iso){
  if (!iso) return '';
  var d = mpDaysBetween(mpToday(), iso);
  if (d < 0)   return d > -14 ? 'just gone' : 'passed';
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d < 14)  return 'in ' + d + ' days';
  if (d < 70)  return 'in ' + Math.round(d / 7) + ' weeks';
  return 'in ' + Math.round(d / 30) + ' months';
}

// ── reading the rows ────────────────────────────────────────────────────────
function mpIsRequested(m){ return !!(m && m.origin === 'requested'); }
// The day this thing is live. An event's own day wins; otherwise the launch it
// carries, otherwise the day it was asked for.
function mpWhenLive(m){
  if (!m) return null;
  var d = m.event_date || m.launch_date || m.needed_by || null;
  return d ? String(d).slice(0,10) : null;
}
// A date the SYSTEM already knows, so the flow must not ask him for it again.
// Only a dated one-off counts (Bartolini, 2–3 Nov) — a seasonal menu's launch
// is a plan, not a fixture, and he is allowed to move it.
function mpKnownDate(m){
  return (m && mpIsEventMenu(m)) ? mpMenuEventDate(m) : null;
}
// ══ ON THE PLAN, OR IN THE LIST ════════════════════════════════════════════
// Two different things share this table. A menu ON THE PLAN is work someone
// has decided to do — it shows on What's on. A menu in THE LIST is one the
// restaurant simply runs (à la carte, Business Lunch, the Set Menus) or a date
// already in the diary (Christmas Eve). It is not work until someone picks it,
// so it stays off the home screen and waits in the intake box instead.
//
// Nothing is deleted to achieve that — it is one flag. Before the migration
// adds the column, every menu counts as on the plan, which is exactly how the
// module behaved before this existed.
function mpOnPlan(m){ return !mpHasOnPlan || !m || m.on_plan !== false; }
function mpCatalogueMenus(){
  return mpMenus.filter(function(m){ return !mpOnPlan(m); })
                .sort(function(a, b){ return (a.sort_order || 0) - (b.sort_order || 0); });
}
// Picking a thing out of the list is what puts it on the plan. It happens when
// he commits — saves a timeline, or says he isn't sure yet — never when he is
// only browsing, so backing out of the sheet leaves the plan as it was.
async function mpPutOnPlan(menuId){
  if (!mpHasOnPlan || !menuId) return true;
  var m = mpMenus.filter(function(x){ return x.id === menuId; })[0];
  if (!m || mpOnPlan(m)) return true;
  var res = await sb.from('menu_plan_menus')
    .update({ on_plan:true, updated_at:new Date().toISOString(), updated_by:mpMe.name })
    .eq('id', menuId);
  return !mpErr(res, 'it');
}
function mpStagesFor(menuId){
  return mpCal.filter(function(c){ return c.menu_id === menuId && c.stage; })
              .sort(function(a, b){ return String(a.starts_on) < String(b.starts_on) ? -1 : 1; });
}
// The stage running today, or the next one due. Returns null once they're done.
function mpCurrentStage(menuId){
  var t = mpToday(), st = mpStagesFor(menuId);
  var now = st.filter(function(c){
    return String(c.starts_on).slice(0,10) <= t && t <= String(c.ends_on || c.starts_on).slice(0,10);
  })[0];
  if (now) return { c:now, live:true };
  var next = st.filter(function(c){ return String(c.starts_on).slice(0,10) > t; })[0];
  return next ? { c:next, live:false } : null;
}
// The old month grid still holds something real for most of the 22: a Launch
// square in September IS a commitment, even though it is not a timeline. Say
// what it says rather than "no plan yet" next to a date that plainly exists.
function mpLegacyLine(menuId){
  var rows = mpCal.filter(function(c){ return c.menu_id === menuId && c.month && c.state; })
                  .sort(function(a, b){ return String(a.month) < String(b.month) ? -1 : 1; });
  if (!rows.length) return '';
  var pick = rows.filter(function(c){ return c.state === 'Launch'; })[0] || rows[rows.length - 1];
  return pick.state + ' ' + mpMonthLabel(String(pick.month).slice(0,10));
}
// ONE next action per thing. Never a list of what he owes.
function mpNextAction(m){
  var stages = mpStagesFor(m.id);
  var legacy = stages.length ? '' : mpLegacyLine(m.id);
  // Aung reads; he doesn't plan. Send him to the same sheet without the button.
  if (!mpCanAuthor()) return { text: stages.length ? 'Planned' : (legacy || 'No plan yet'), label:'Look', go:"mpReviewPlan('" + m.id + "')" };
  if (!stages.length){
    return { text: mpIsRequested(m) ? 'Waiting on your dates and plan'
                 : legacy ? legacy + ' — needs a timeline'
                 : 'No plan yet',
             label:'Plan it', go:"mpPlanThing('" + m.id + "')" };
  }
  if (m.plan_state === 'proposed'){
    return { text: mpIsApprover() ? 'A plan is ready for you to look at' : 'Sent to Francesco',
             label: mpIsApprover() ? 'Look at it' : 'See the plan', go:"mpReviewPlan('" + m.id + "')" };
  }
  var cur = mpCurrentStage(m.id);
  if (!cur) return { text:'Every stage done', label:'See the plan', go:"mpReviewPlan('" + m.id + "')" };
  return {
    text: cur.live ? cur.c.stage + ' now — ' + MP_STAGE_NOTE[cur.c.stage]
                   : cur.c.stage + ' from ' + mpDateLabel(cur.c.starts_on),
    label:'See the plan', go:"mpReviewPlan('" + m.id + "')"
  };
}

// Sort the whole plan into what the screen shows, in the order it shows it.
// Campaigns and grouped menus (Set Menu A/B/C) come straight from the existing
// mpPlanGroups(), so December stays ONE job and the set menus stay ONE row.
function mpHomeGroups(){
  var g = mpPlanGroups();
  var waiting = [], dated = [], undated = [], held = {};
  mpMenus.forEach(function(m){
    if (!mpOnPlan(m)) return;
    if (mpIsRequested(m) && !mpStagesFor(m.id).length){ waiting.push(m); held[m.id] = true; }
  });
  waiting.sort(function(a, b){ return String(a.created_at) < String(b.created_at) ? 1 : -1; });

  // Anything still in the list rather than on the plan is skipped everywhere
  // below. A Set Menu group survives if ANY of its variants is on the plan —
  // the row is the group, and the A/B/C switcher still reaches the others.
  g.campaigns.forEach(function(b){
    var events = b.events.filter(function(m){ return !held[m.id] && mpOnPlan(m); });
    var core   = (b.core && !held[b.core.id] && mpOnPlan(b.core)) ? b.core : null;
    if (!core && !events.length) return;
    dated.push({ type:'campaign', campaign:b.campaign, core:core, events:events,
      when: b.campaign.date_from ? String(b.campaign.date_from).slice(0,10) : (mpWhenLive(events[0]) || '') });
  });
  g.mains.forEach(function(row){
    if (row.group ? !row.variants.some(mpOnPlan) : !mpOnPlan(row.menu)) return;
    if (!row.group && held[row.menu.id]) return;
    var m = row.group ? mpSelVariant(row) : row.menu;
    var when = mpWhenLive(m);
    (when ? dated : undated).push({ type:'row', row:row, menu:m, when:when || '' });
  });
  g.looseEvents.forEach(function(m){
    if (held[m.id] || !mpOnPlan(m)) return;
    var when = mpWhenLive(m);
    (when ? dated : undated).push({ type:'row', row:{ menu:m }, menu:m, when:when || '' });
  });
  dated.sort(function(a, b){ return a.when < b.when ? -1 : a.when > b.when ? 1 : 0; });
  return { waiting:waiting, dated:dated, undated:undated };
}

function mpRenderHome(){
  var g = mpHomeGroups();
  var canAsk = mpIsApprover();
  return '<div class="mp-body">' +

    // ── Francesco's own surface: ask the kitchen for something ──
    (canAsk
      ? '<button class="mp-askbox ask" onclick="mpRequestSheet()">' +
          '<span class="mp-askbox-q">Ask the kitchen for something</span>' +
          '<span class="mp-askbox-h">A new activation or a menu. Paste the marketing email if that&rsquo;s easier.</span>' +
        '</button>'
      : '') +

    // ── requested and not planned yet: top of the screen, always ──
    (g.waiting.length
      ? '<div class="mp-hsec wait">Asked for &mdash; needs your plan</div>' +
        g.waiting.map(mpHomeRow).join('')
      : '') +

    // ── the one box ──
    (mpCanAuthor()
      ? '<button class="mp-askbox" onclick="mpOpenIntake()">' +
          '<span class="mp-askbox-q">What do you want to develop?</span>' +
          '<span class="mp-askbox-h">Write it how you&rsquo;d say it. You can name a few things at once.</span>' +
        '</button>'
      : '') +

    (mpIsCostController()
      ? '<div class="mp-card"><div class="mp-card-h">Your job</div>' +
        '<div class="mp-hint">Open <button class="mp-link" onclick="mpGo(\'dishes\')">Dishes</button>, filter to <strong>Costing</strong>, ' +
        'read each cost sheet and mark it Costed.</div></div>'
      : '') +

    // ── what's coming, nearest first ──
    (g.dated.length
      ? '<div class="mp-hsec">Coming up</div>' +
        g.dated.map(function(b){ return b.type === 'campaign' ? mpHomeCampaign(b) : mpHomeRow(b.menu, b.row); }).join('')
      : '') +

    // ── no date yet. A prompt, not a debt. ──
    (g.undated.length
      ? '<div class="mp-hsec">No date yet</div>' +
        '<div class="mp-hint">These need you to say when. Tap one and give it a window.</div>' +
        g.undated.map(function(b){ return mpHomeRow(b.menu, b.row); }).join('')
      : '') +

    (!g.waiting.length && !g.dated.length && !g.undated.length
      ? '<div class="mp-empty big">Nothing on the plan yet.</div>' : '') +
  '</div>';
}

// One line per thing: what it is, when it's live, how far away, one next action.
// A grouped row (Set Menu A/B/C) keeps its variant switcher, so three menus stay
// one line on a phone.
function mpHomeRow(m, row){
  var when = mpWhenLive(m);
  var next = mpNextAction(m);
  var far  = mpHowFar(when);
  return '<div class="mp-hrow' + (mpIsRequested(m) && !mpStagesFor(m.id).length ? ' wait' : '') + '">' +
    '<div class="mp-hrow-top">' +
      (row && row.group
        ? '<span class="mp-hrow-name">' + mpEsc(row.group) +
          '<select class="mp-varsel" onchange="mpSelectVariant(\'' + mpEsc(row.group) + '\', this.value)">' +
            row.variants.map(function(v){ return '<option value="' + v.id + '"' + (v.id === m.id ? ' selected' : '') + '>' + mpEsc(v.variant_label || v.name) + '</option>'; }).join('') +
          '</select></span>'
        : '<span class="mp-hrow-name">' + mpEsc(m.name) + '</span>') +
      (when ? '<span class="mp-hrow-when">' + mpEsc(mpDateLabel(when)) + '<em>' + mpEsc(far) + '</em></span>' : '') +
    '</div>' +
    (mpIsRequested(m) && m.requested_by
      ? '<div class="mp-hrow-from">' + mpEsc(m.requested_by.split(' ')[0]) + ' asked for this</div>' : '') +
    '<button class="mp-hrow-next" onclick="' + next.go + '">' +
      '<span>' + mpEsc(next.text) + '</span><span class="mp-hrow-go">' + mpEsc(next.label) + ' &rsaquo;</span></button>' +
  '</div>';
}
// A campaign is ONE job with its nights nested — December is not seven jobs.
function mpHomeCampaign(b){
  var c = b.campaign;
  var range = (c.date_from ? mpDateLabel(c.date_from) : '') + (c.date_to ? ' – ' + mpDateLabel(c.date_to) : '');
  return '<div class="mp-hcamp">' +
    '<div class="mp-hcamp-h">' +
      '<span class="mp-hcamp-t">' + mpEsc(c.theme || c.title || 'Campaign') + '</span>' +
      (range ? '<span class="mp-hcamp-r">' + mpEsc(range) + '</span>' : '') +
    '</div>' +
    (b.core ? mpHomeRow(b.core) : '') +
    (b.events.length
      ? '<div class="mp-hcamp-n">' + b.events.length + ' night' + (b.events.length === 1 ? '' : 's') + ' inside it</div>' +
        b.events.map(function(m){ return mpHomeRow(m); }).join('')
      : '') +
  '</div>';
}

// ══ THE ONE BOX ════════════════════════════════════════════════════════════
function mpSpeechCtor(){ return window.SpeechRecognition || window.webkitSpeechRecognition || null; }
let mpRec = null;
function mpOpenIntake(seed){
  mpSheet('What do you want to develop?',
    '<textarea class="mp-in mp-askin" id="mpik-text" rows="4" maxlength="' + MP_MAX_NOTE + '" ' +
      'placeholder="New à la carte for autumn, and the Bartolini dinner"></textarea>' +
    '<div class="mp-hint">One per line, or just write it as a sentence. Nothing is saved until you have checked it.</div>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpRunIntake(this)">Continue</button>' +
      (mpSpeechCtor() ? '<button class="mp-btn ghost" id="mpik-mic" onclick="mpDictate()">&#127908; Speak</button>' : '') +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">Cancel</button>' +
    '</div>' +
    mpCatalogueBlock());
  setTimeout(function(){
    var t = document.getElementById('mpik-text');
    if (!t) return;
    if (seed) t.value = seed;
    try { t.focus(); } catch(e){}
  }, 60);
}
// ── the menus we already run ───────────────────────────────────────────────
// Under the box, not instead of it. Typing is still the way in — this is for
// the things that don't need describing, because they already exist: à la
// carte, Business Lunch, the Set Menus, and the nights already in the diary.
// Tapping one takes it straight to "how long have you got?" — there is nothing
// to read back about a menu the app already holds, and no chance of ending up
// with two à la cartes.
function mpCatalogueBlock(){
  var cat = mpCatalogueMenus();
  if (!cat.length) return '';
  return '<div class="mp-cat">' +
    '<div class="mp-cat-h">Or pick one we already run</div>' +
    '<input class="mp-in mp-cat-q" type="text" id="mpik-cat-q" placeholder="Start typing to narrow it down" ' +
      'autocomplete="off" oninput="mpCatFilter()"/>' +
    '<div class="mp-cat-list" id="mpik-cat-list">' +
      cat.map(function(m){
        var when = mpKnownDate(m);
        return '<button type="button" class="mp-cat-row" data-n="' + mpEsc(String(m.name).toLowerCase()) + '" ' +
          'onclick="mpPickFromCatalogue(\'' + m.id + '\')">' +
          '<span class="mp-cat-n">' + mpEsc(m.name) + '</span>' +
          (when ? '<span class="mp-cat-d">' + mpEsc(mpDateLabel(when)) + '</span>'
                : '<span class="mp-cat-d quiet">' + mpEsc(m.change_cadence || '') + '</span>') +
        '</button>';
      }).join('') +
    '</div>' +
    '<div class="mp-cat-none" id="mpik-cat-none" style="display:none">Nothing by that name — write it in the box above instead.</div>' +
  '</div>';
}
function mpCatFilter(){
  var q = (document.getElementById('mpik-cat-q') || {}).value || '';
  q = q.trim().toLowerCase();
  var rows = document.querySelectorAll('#mpik-cat-list .mp-cat-row'), shown = 0;
  for (var i = 0; i < rows.length; i++){
    var hit = !q || rows[i].getAttribute('data-n').indexOf(q) >= 0;
    rows[i].style.display = hit ? '' : 'none';
    if (hit) shown++;
  }
  var none = document.getElementById('mpik-cat-none');
  if (none) none.style.display = shown ? 'none' : '';
}
// A menu the app already holds needs no read-back: its name, its kind and its
// date are already right. Straight to the window question, or straight to the
// timeline if the date is already in the diary.
function mpPickFromCatalogue(menuId){
  var m = mpMenus.filter(function(x){ return x.id === menuId; })[0];
  if (!m) return;
  mpIntake = { mode:'develop', raw:m.name, i:0,
    items:[{ name:m.name, kind:mpMenuKind(m), menu_id:m.id, date:mpKnownDate(m) }] };
  mpNextIntakeStep();
}

// Dictation if the browser offers it, silently absent if not. He works service
// with one hand — talking to it beats typing on a wet phone.
function mpDictate(){
  var C = mpSpeechCtor(); if (!C) return;
  var btn = document.getElementById('mpik-mic'), box = document.getElementById('mpik-text');
  if (mpRec){ try { mpRec.stop(); } catch(e){} return; }
  try { mpRec = new C(); } catch(e){ mpRec = null; return; }
  mpRec.lang = 'en-GB'; mpRec.interimResults = false; mpRec.continuous = false;
  mpRec.onresult = function(ev){
    var said = '';
    for (var i = 0; i < ev.results.length; i++) said += ev.results[i][0].transcript;
    if (box) box.value = (box.value ? box.value.replace(/\s*$/, '') + ' ' : '') + said.trim();
    mpSheetDirty = true;
  };
  mpRec.onerror = function(){ mpToast('Could not hear that — type it instead.', true); };
  mpRec.onend   = function(){ mpRec = null; if (btn) btn.innerHTML = '&#127908; Speak'; };
  try { mpRec.start(); if (btn) btn.innerHTML = 'Listening&hellip; tap to stop'; }
  catch(e){ mpRec = null; }
}

async function mpRunIntake(btn){
  var el = document.getElementById('mpik-text');
  var text = (el && el.value || '').trim();
  if (!text){ mpToast('Write what you want to develop first.', true); return; }
  var free = mpLock(btn); if (!free) return;
  try {
    var items = await mpUnderstand(text);
    if (!items.length){ mpToast('Could not make anything out of that — try naming the menu or the event.', true); return; }
    mpIntake = { mode:'develop', raw:text, items:items, i:0 };
    mpReadBack();
  } finally { free(); }
}

// ── understanding his words ────────────────────────────────────────────────
// The assistant reads the words. It is never asked for a date and never
// believed about one — a date only reaches the screen if it came out of a menu
// row we already hold, or out of the plain-text scan below.
const MP_AI_URL = 'https://zrpglswalgjbtghudmhu.supabase.co/functions/v1/survey-assistant';
async function mpUnderstand(text){
  var read = await mpAiUnderstand(text);
  if (!read || !read.length) read = mpFallbackUnderstand(text);
  return read.map(function(it){
    var known = it.menu_id ? mpMenus.filter(function(m){ return m.id === it.menu_id; })[0] : null;
    return {
      name:    known ? known.name : String(it.name || '').trim().slice(0, MP_MAX_NAME),
      kind:    known ? mpMenuKind(known) : (it.kind === 'event' ? 'event' : 'main'),
      menu_id: known ? known.id : null,
      date:    known ? mpKnownDate(known) : mpScanDate(it.source || it.name || '')
    };
  }).filter(function(it){ return !!it.name; });
}
async function mpAiUnderstand(text){
  try {
    var names = mpMenus.map(function(m){ return m.name; });
    var sys =
      'You turn a chef\'s note into a short list of things he needs to develop.\n' +
      'Reply with ONLY a JSON array and nothing else. Each entry is ' +
      '{"name": a short plain title in his own words, "kind": "main" or "event", ' +
      '"matches": the exact name from the "Already on the plan" list if he means one of those, otherwise null, ' +
      '"source": the exact words from his note that this entry came from}.\n' +
      '"main" is a menu that runs (à la carte, lounge, business lunch, vegan). ' +
      '"event" is something that happens on a day or a few days (a guest dinner, an activation, a festive night).\n' +
      'NEVER give a date, a deadline, a month or a duration, in any field. The app works those out itself.\n' +
      'One entry per thing. If he names one thing, return one entry.';
    var resp = await fetch(MP_AI_URL, {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'Authorization':'Bearer ' + SUPABASE_KEY,
        'apikey': SUPABASE_KEY,
        'x-proxy-secret': (typeof KITCHEN_PROXY_SECRET !== 'undefined' ? KITCHEN_PROXY_SECRET : '')
      },
      body: JSON.stringify({
        action:'chat', model:'claude-sonnet-4-6', max_tokens:1000, system:sys,
        messages:[{ role:'user', content:'Already on the plan:\n' + names.join('\n') + '\n\nHe wrote:\n' + text }]
      })
    });
    if (!resp.ok) return null;
    var data = await resp.json();
    var hit = String((data && data.text) || '').match(/\[[\s\S]*\]/);
    if (!hit) return null;
    var arr = JSON.parse(hit[0]);
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr.slice(0, 8).map(function(o){
      var m = (o && o.matches) ? mpMenus.filter(function(x){ return x.name === o.matches; })[0] : null;
      return { name:(o && o.name) || '', kind:(o && o.kind) || '', menu_id:m ? m.id : null, source:(o && o.source) || '' };
    }).filter(function(o){ return o.name; });
  } catch(e){ return null; }
}

// The deterministic read. The proxy will be down sometimes and the box still
// has to do something sensible, so this is not a fallback in name only — it
// runs the same read-back screen and produces the same kind of list.
const MP_STOP_RE  = /^(a|an|the|new|another|some|do|make|create|develop|building|build|start|write|need|needs|needed|want|we|i|to|for|of|plus|and|also|please)\b\s*/i;
const MP_EVENT_RE = /\b(dinner|night|nights|eve|day|activation|event|party|week|gala|takeover|celebration|christmas|new year|guest chef|pop.?up)\b/i;
// Months and seasons are thrown away before matching. They say WHEN, never
// WHICH — leaving "Dec" in made "Christmas party menu for 12 Dec" line up with
// "Christmas Eve · 24 Dec", which then took 24 December as its date.
const MP_TIME_WORD = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|spring|summer|autumn|winter)$/;
function mpWords(s){
  return String(s || '').toLowerCase()
    .replace(/[^a-zà-ÿ0-9 ]+/gi, ' ')
    .split(/\s+/)
    .filter(function(w){ return w.length > 2 && !/^(the|and|for|new|menu|our|its|with)$/.test(w) && !MP_TIME_WORD.test(w); });
}
// How many menu names use each word — so the matcher can tell a word that
// picks one thing out ("bartolini") from one half the plan shares ("christmas").
function mpWordOwners(){
  var idx = {};
  mpMenus.forEach(function(m){
    var seen = {};
    mpWords(m.name).forEach(function(w){ if (seen[w]) return; seen[w] = 1; idx[w] = (idx[w] || 0) + 1; });
  });
  return idx;
}
// Does this fragment name something already on the plan? It counts as a match
// when two meaningful words line up, or when ONE word does that only that menu
// uses. Anything looser claims the wrong menu, and claiming the wrong menu
// hands him the wrong date.
function mpMatchMenu(frag){
  var words = mpWords(frag);
  if (!words.length) return null;
  var owners = mpWordOwners();
  var best = null, bestHits = 0, bestRare = false;
  mpMenus.forEach(function(m){
    var overlap = mpWords(m.name).filter(function(w){ return words.indexOf(w) >= 0; });
    if (!overlap.length) return;
    var rare = overlap.some(function(w){ return owners[w] === 1; });
    if (overlap.length < 2 && !rare) return;
    if (overlap.length > bestHits || (overlap.length === bestHits && rare && !bestRare)){
      bestHits = overlap.length; bestRare = rare; best = m;
    }
  });
  return best;
}
function mpFallbackUnderstand(text){
  var frags = String(text).split(/[\n;,•]|\s+\band\b\s+|\s+\+\s+/i)
    .map(function(s){ return s.trim(); })
    .filter(function(s){ return s.length > 2; });
  if (!frags.length) frags = [String(text).trim()];
  return frags.slice(0, 8).map(function(frag){
    var name = frag;
    for (var i = 0; i < 5; i++){ var n = name.replace(MP_STOP_RE, ''); if (n === name) break; name = n; }
    name = name.replace(/\s+/g, ' ').trim().slice(0, MP_MAX_NAME);
    var m = mpMatchMenu(frag);
    return {
      name: m ? m.name : (name.charAt(0).toUpperCase() + name.slice(1)),
      kind: m ? mpMenuKind(m) : (MP_EVENT_RE.test(frag) ? 'event' : 'main'),
      menu_id: m ? m.id : null,
      source: frag
    };
  }).filter(function(o){ return o.name; });
}
// The app's own date reader — an explicit day and month only. A season ("for
// autumn") is not a date, and inventing one from it would be the app guessing.
const MP_MON_KEYS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
function mpScanDate(text){
  var s = String(text || '');
  var iso = s.match(/\b(20\d\d)-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];
  var day = null, mon = null;
  var a = s.match(/\b(\d{1,2})\s*(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i);
  if (a){ day = +a[1]; mon = a[2]; }
  else {
    var b = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})\b/i);
    if (b){ day = +b[2]; mon = b[1]; }
  }
  if (!day || !mon) return null;
  var idx = MP_MON_KEYS.indexOf(String(mon).toLowerCase().slice(0,3)) + 1;
  if (!idx || day < 1 || day > 31) return null;
  // The app picks the year too: the next time that day comes round.
  var t = mpToday(), y = +t.slice(0,4);
  var pad = String(idx).padStart(2,'0') + '-' + String(day).padStart(2,'0');
  var cand = y + '-' + pad;
  return cand < t ? (y + 1) + '-' + pad : cand;
}

// ══ THE READ-BACK — nothing is saved that he hasn't confirmed ══════════════
function mpReadBack(){
  var req = mpIntake.mode === 'request';
  mpSheet(req ? 'Is this what you’re asking for?' : 'Is this right?',
    '<div class="mp-hint">This is what I understood. Change anything that&rsquo;s wrong &mdash; nothing is saved until you tap the button below.</div>' +
    '<div class="mp-chips">' + mpIntake.items.map(mpChipCard).join('') + '</div>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpConfirmReadBack(this)">' + (req ? 'Send it' : 'Yes, that’s right') + '</button>' +
      '<button class="mp-btn ghost" onclick="mpBackToBox()">Start again</button>' +
    '</div>');
}
function mpBackToBox(){
  var raw = mpIntake ? mpIntake.raw : '';
  if (mpIntake && mpIntake.mode === 'request'){ mpRequestSheet(raw); return; }
  mpOpenIntake(raw);
}
function mpChipCard(it, i){
  var known = it.menu_id ? mpMenus.filter(function(m){ return m.id === it.menu_id; })[0] : null;
  return '<div class="mp-chip">' +
    (mpIntake.items.length > 1 ? '<button class="mp-chip-x" onclick="mpChipDrop(' + i + ')" title="Take this one off">&times;</button>' : '') +
    '<input class="mp-in mp-chip-name" id="mpik-n' + i + '" maxlength="' + MP_MAX_NAME + '" value="' + mpEsc(it.name) + '" oninput="mpChipEdit(' + i + ',this.value)"/>' +
    '<div class="mp-pills mp-chip-kinds">' +
      '<button type="button" class="mp-pill' + (it.kind === 'main'  ? ' on' : '') + '" onclick="mpChipKind(' + i + ',\'main\')">A menu that runs</button>' +
      '<button type="button" class="mp-pill' + (it.kind === 'event' ? ' on' : '') + '" onclick="mpChipKind(' + i + ',\'event\')">Happens on a day</button>' +
    '</div>' +
    (known
      ? '<div class="mp-chip-known">Already on your plan' +
          (it.date ? ' &middot; ' + mpEsc(mpDateLabel(it.date)) : '') +
          '<button class="mp-link" onclick="mpChipDetach(' + i + ')">not this one</button></div>'
      : it.date
        ? '<div class="mp-chip-known">Reads as ' + mpEsc(mpDateLabel(it.date)) +
          '<button class="mp-link" onclick="mpChipClearDate(' + i + ')">no date</button></div>'
        : '') +
  '</div>';
}
// Typing only stores. Re-drawing on every keystroke would take the cursor away
// from him mid-word.
function mpChipEdit(i, v){ if (mpIntake && mpIntake.items[i]) mpIntake.items[i].name = v; mpSheetDirty = true; }
function mpChipsRefresh(){
  var host = document.querySelector('#mp-sheet .mp-chips');
  if (host) host.innerHTML = mpIntake.items.map(mpChipCard).join('');
}
function mpChipKind(i, k){ mpIntake.items[i].kind = k; mpSheetDirty = true; mpChipsRefresh(); }
function mpChipDetach(i){
  var it = mpIntake.items[i];
  it.menu_id = null; it.date = null; mpSheetDirty = true; mpChipsRefresh();
}
function mpChipClearDate(i){ mpIntake.items[i].date = null; mpSheetDirty = true; mpChipsRefresh(); }
function mpChipDrop(i){
  mpIntake.items.splice(i, 1); mpSheetDirty = true;
  if (!mpIntake.items.length){ mpIntake = null; mpCloseSheet(); return; }
  mpChipsRefresh();
}

function mpNextSort(){
  return mpMenus.reduce(function(a, m){ return Math.max(a, m.sort_order || 0); }, 0) + 10;
}
// Create the row for one confirmed chip. Everything made here is an ordinary
// menu_plan_menus row, so the old Menus / Calendar / Dishes tabs see it too.
async function mpCreateThing(it, extra){
  var row = {
    name: it.name,
    kind: it.kind,
    change_cadence: it.kind === 'event' ? 'One-off event' : 'Seasonal',
    sort_order: mpNextSort(),
    updated_by: mpMe.name
  };
  if (it.date){ row.launch_date = it.date; if (it.kind === 'event') row.event_date = it.date; }
  if (mpHasRequests) Object.keys(extra || {}).forEach(function(k){ row[k] = extra[k]; });
  var res = await sb.from('menu_plan_menus').insert(row).select().single();
  if (res && res.error){ mpErr(res, 'it'); return null; }
  return (res && res.data && res.data.id) || null;
}

async function mpConfirmReadBack(btn){
  var req = mpIntake.mode === 'request';
  for (var i = 0; i < mpIntake.items.length; i++){
    mpIntake.items[i].name = String(mpIntake.items[i].name || '').trim();
    if (!mpIntake.items[i].name){ mpToast('Every one needs a name.', true); return; }
  }
  var free = mpLock(btn); if (!free) return;
  try {
    var extra = req
      ? { origin:'requested', requested_by:mpMe.name, request_note:mpIntake.raw, needed_by:mpIntake.neededBy || null }
      : { origin:'self' };
    for (var j = 0; j < mpIntake.items.length; j++){
      var it = mpIntake.items[j];
      if (it.menu_id){
        // Already on the plan. A request against an existing thing still has to
        // say who asked and what for, or it lands on his home as a mystery.
        if (req && mpHasRequests){
          var up = await sb.from('menu_plan_menus').update({
            origin:'requested', requested_by:mpMe.name, request_note:mpIntake.raw,
            needed_by: mpIntake.neededBy || null, updated_at:new Date().toISOString(), updated_by:mpMe.name
          }).eq('id', it.menu_id);
          if (mpErr(up, 'the request')) return;
        }
        continue;
      }
      var id = await mpCreateThing(it, extra);
      if (!id) return;
      it.menu_id = id;
    }
    await mpLoadAll();
    if (req){
      mpIntake = null; mpCloseSheet(); mpRender();
      mpToast('Sent to the kitchen');
      return;
    }
    mpIntake.i = 0;
    mpNextIntakeStep();
  } finally { free(); }
}

// ══ HOW LONG HAVE YOU GOT? — the only duration input in the product ════════
function mpNextIntakeStep(){
  if (!mpIntake) return;
  if (mpIntake.i >= mpIntake.items.length){
    mpIntake = null; mpCloseSheet(); mpRender(); mpToast('Saved');
    return;
  }
  var it = mpIntake.items[mpIntake.i];
  var m  = mpMenus.filter(function(x){ return x.id === it.menu_id; })[0];
  var known = m ? mpKnownDate(m) : null;
  // A date the system already holds is never asked for again.
  if (known) mpOpenTimeline(it.menu_id, mpToday(), String(known).slice(0,10));
  else mpAskWindow();
}
function mpAskWindow(){
  var it = mpIntake.items[mpIntake.i];
  var t  = mpToday();
  var opts = [['1 week', 7], ['1 month', 30], ['3 months', 90], ['6 months', 180]];
  mpSheet('How long have you got?',
    '<div class="mp-hint">For <strong>' + mpEsc(it.name) + '</strong>' +
      (mpIntake.items.length > 1 ? ' &mdash; ' + (mpIntake.i + 1) + ' of ' + mpIntake.items.length : '') + '</div>' +
    '<div class="mp-windows">' + opts.map(function(o){
      return '<button class="mp-window" onclick="mpPickWindow(' + o[1] + ')">' + o[0] +
        '<em>ready ' + mpEsc(mpDateLabel(mpAddDays(t, o[1]))) + '</em></button>';
    }).join('') + '</div>' +
    '<label class="mp-lab">Or ready by a date</label>' +
    '<input class="mp-in" type="date" id="mpik-by" min="' + mpAddDays(t, 1) + '"/>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpPickWindowDate()">Use this date</button>' +
      '<button class="mp-btn ghost" onclick="mpSkipWindow()">Not sure yet</button>' +
    '</div>');
}
function mpPickWindow(days){
  var it = mpIntake.items[mpIntake.i];
  mpOpenTimeline(it.menu_id, mpToday(), mpAddDays(mpToday(), days));
}
function mpPickWindowDate(){
  var el = document.getElementById('mpik-by');
  var v = el && el.value;
  if (!v){ mpToast('Pick a date, or tap one of the four above.', true); return; }
  if (v <= mpToday()){ mpToast('That date has already gone — pick a later one.', true); return; }
  mpOpenTimeline(mpIntake.items[mpIntake.i].menu_id, mpToday(), v);
}
async function mpSkipWindow(){
  // It stays on his list under "No date yet". That is a prompt, not a debt —
  // and "not sure when" is still a decision to do it, so it comes out of the
  // list onto the plan just as a dated one would.
  var it = mpIntake.items[mpIntake.i];
  if (it && it.menu_id){
    if (!(await mpPutOnPlan(it.menu_id))) return;
    await mpLoadAll();
  }
  mpIntake.i++; mpNextIntakeStep();
}

// ══ THE TIMELINE ═══════════════════════════════════════════════════════════
// The four stages spread across the window he gave, Photoshoot floating. Every
// number here is integer day arithmetic done in this file.
// ══ THE TIMELINE ═══════════════════════════════════════════════════════════
// Every block carries its OWN two dates. That is the whole point: changing when
// Testing finishes changes Testing and nothing else. Blocks may overlap, and
// may leave a gap between them — both happen in a real kitchen, and pretending
// otherwise is what made adjusting a single date impossible.
//
// The first suggestion is still the four stages back to back across the window
// he gave. From then on he moves whichever dates he means to move.
function mpTlBlocks(){
  var b = mpTl.parts.slice();
  if (mpTl.photo.on) b.push(mpTl.photo);
  return b;
}
function mpTlStart(){
  return mpTlBlocks().reduce(function(a, p){ return !a || p.from < a ? p.from : a; }, null) || mpToday();
}
function mpTlEnd(){
  return mpTlBlocks().reduce(function(a, p){ return !a || p.to > a ? p.to : a; }, null) || mpToday();
}
function mpTlTotal(){ return Math.max(1, mpDaysBetween(mpTlStart(), mpTlEnd()) + 1); }
function mpTlLen(p){ return Math.max(1, mpDaysBetween(p.from, p.to) + 1); }
function mpTlShift(p, days){ p.from = mpAddDays(p.from, days); p.to = mpAddDays(p.to, days); }

function mpBuildTimeline(start, end){
  var total = Math.max(4, mpDaysBetween(start, end) + 1);
  var days = MP_STAGES.map(function(s){ return Math.max(1, Math.floor(total * MP_STAGE_WEIGHT[s])); });
  // Rounding must never leak or invent a day: the slack lands on Development,
  // and if that would take it below one day we take it back off the longest.
  var used = days.reduce(function(a, d){ return a + d; }, 0);
  days[0] += (total - used);
  while (days[0] < 1){
    var bi = 1, bd = 0;
    for (var k = 1; k < days.length; k++) if (days[k] > bd){ bd = days[k]; bi = k; }
    if (bd <= 1) break;
    days[bi]--; days[0]++;
  }
  var acc = 0;
  var parts = MP_STAGES.map(function(s, i){
    var from = mpAddDays(start, acc);
    acc += days[i];
    return { stage:s, from:from, to:mpAddDays(start, acc - 1) };
  });
  // Photoshoot starts where Testing ends and runs into Approval — the overlap
  // the old one-stage-per-month calendar could never hold.
  var pd = Math.max(1, Math.round(total * 0.08));
  var pOff = Math.max(0, Math.min(days[0] + days[1], total - pd));
  return { parts:parts,
           photo:{ stage:MP_PHOTO_STAGE, on:true, from:mpAddDays(start, pOff), to:mpAddDays(start, pOff + pd - 1) } };
}
// Rebuild the working timeline from what is actually saved, so going back to a
// plan opens THAT plan. It used to spread a fresh one from today every time,
// which quietly threw away every date he had set — the reason he could never
// go back and adjust one stage.
function mpTlFromSaved(menuId){
  var st = mpStagesFor(menuId);
  if (!st.length) return null;
  var day = function(v){ return String(v).slice(0, 10); };
  var main  = st.filter(function(c){ return c.stage !== MP_PHOTO_STAGE; });
  var photo = st.filter(function(c){ return c.stage === MP_PHOTO_STAGE; })[0];
  if (!main.length) return null;
  var parts = main.map(function(c){
    return { stage:c.stage, from:day(c.starts_on), to:day(c.ends_on || c.starts_on) };
  });
  var ph = photo
    ? { stage:MP_PHOTO_STAGE, on:true, from:day(photo.starts_on), to:day(photo.ends_on || photo.starts_on) }
    : { stage:MP_PHOTO_STAGE, on:false, from:parts[0].from, to:parts[0].from };
  var have = parts.map(function(p){ return p.stage; });
  return { menuId:menuId, parts:parts, photo:ph, was:{},
           skipped: MP_STAGES.filter(function(s){ return have.indexOf(s) < 0; }) };
}
function mpOpenTimeline(menuId, start, end){
  var m = mpMenus.filter(function(x){ return x.id === menuId; })[0];
  if (!m) return;
  var saved = mpTlFromSaved(menuId);
  if (saved){ mpTl = saved; mpTimelineSheet(); return; }
  var built = mpBuildTimeline(start, end);
  mpTl = { menuId:menuId, parts:built.parts, photo:built.photo, skipped:[], was:{} };
  mpTimelineSheet();
}
function mpTimelineSheet(){
  var m = mpMenus.filter(function(x){ return x.id === mpTl.menuId; })[0];
  mpSheet('Plan ' + (m ? m.name : ''), mpTimelineBody());
}

function mpTimelineBody(){
  var start = mpTlStart(), total = mpTlTotal();
  var pos = function(p){
    return 'left:' + ((mpDaysBetween(start, p.from) / total) * 100).toFixed(3) + '%;' +
           'width:' + ((mpTlLen(p) / total) * 100).toFixed(3) + '%';
  };
  var segs = mpTl.parts.map(function(p, i){
    return '<span class="mp-tl-seg s-' + p.stage.toLowerCase() + '" style="' + pos(p) + '" ' +
      'onpointerdown="mpTlDown(event,' + i + ',&quot;part&quot;)" title="Drag to move this block">' +
      '<b>' + mpEsc(p.stage) + '</b></span>';
  }).join('');
  var ph = mpTl.photo;
  return '<div class="mp-hint">' + total + ' days &mdash; ' + mpEsc(mpDateLabel(start)) +
      ' to ' + mpEsc(mpDateLabel(mpTlEnd())) + '. Drag a block to move it, or set its dates below. ' +
      'Each phase is on its own &mdash; changing one date changes only that phase.</div>' +
    '<div class="mp-tl">' +
      '<div class="mp-tl-track" id="mp-tl-track">' + segs + '</div>' +
      '<div class="mp-tl-track photo" id="mp-tl-photo">' +
        (ph.on
          ? '<span class="mp-tl-seg s-photoshoot" style="' + pos(ph) + '" ' +
            'onpointerdown="mpTlDown(event,-1,&quot;photo&quot;)"><b>' + MP_PHOTO_STAGE + '</b></span>'
          : '<span class="mp-tl-off">No photoshoot</span>') +
      '</div>' +
    '</div>' +
    '<div class="mp-stagelist" id="mp-stagelist">' + mpTlStageRows() + '</div>' +
    (mpHasStages ? ''
      : '<div class="mp-banner warn">This plan can&rsquo;t be saved yet &mdash; ' +
        '<strong>menu-plan-front-door.sql</strong> has to be run once in Supabase. ' +
        'Saving now records only the date it needs to be ready by.</div>') +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpSaveTimeline(this)">Save this plan</button>' +
      '<button class="mp-btn ghost" onclick="mpTlCancel()">Cancel</button>' +
    '</div>';
}
// Every phase says, in words, when it starts and when it finishes — and both
// are fields, not labels. Dragging the bar is for shaping it roughly; this is
// for saying "Testing finishes on the 8th" and meaning it.
function mpTlDateCell(id, label, value, handler){
  return '<label class="mp-tld">' +
    '<span>' + label + '</span>' +
    '<input class="mp-in mp-tld-in" type="date" id="' + id + '" value="' + mpEsc(value) + '" onchange="' + handler + '"/>' +
  '</label>';
}
function mpTlStageRows(){
  var rows = mpTl.parts.map(function(p, i){
    var n = mpTlLen(p);
    return '<div class="mp-stagerow wide">' +
      '<div class="mp-stagerow-t">' +
        '<i class="mp-swatch s-' + p.stage.toLowerCase() + '"></i>' +
        '<span class="mp-stage-n"><strong>' + mpEsc(p.stage) + '</strong>' +
          '<em>' + n + ' day' + (n === 1 ? '' : 's') + '</em></span>' +
        (mpTl.parts.length > 1 ? '<button class="mp-btn ghost small" onclick="mpTlSkip(&quot;' + p.stage + '&quot;)">Skip</button>' : '') +
      '</div>' +
      '<div class="mp-tldates">' +
        mpTlDateCell('mp-tl-f' + i, 'Starts',   p.from, 'mpTlSetDate(' + i + ',&quot;from&quot;,this)') +
        mpTlDateCell('mp-tl-t' + i, 'Finishes', p.to,   'mpTlSetDate(' + i + ',&quot;to&quot;,this)') +
      '</div>' +
    '</div>';
  }).join('');
  var ph = mpTl.photo, pn = mpTlLen(ph);
  rows += '<div class="mp-stagerow wide">' +
    '<div class="mp-stagerow-t">' +
      '<i class="mp-swatch s-photoshoot"></i>' +
      '<span class="mp-stage-n"><strong>' + MP_PHOTO_STAGE + '</strong>' +
        (ph.on ? '<em>' + pn + ' day' + (pn === 1 ? '' : 's') + ' &middot; can sit inside the others</em>'
               : '<em>skipped</em>') + '</span>' +
      (ph.on
        ? '<button class="mp-btn ghost small" onclick="mpTlPhotoOff()">Skip</button>'
        : '<button class="mp-btn ghost small" onclick="mpTlPhotoOn()">Add it back</button>') +
    '</div>' +
    (ph.on
      ? '<div class="mp-tldates">' +
          mpTlDateCell('mp-tl-pf', 'Starts',   ph.from, 'mpTlSetDate(-1,&quot;from&quot;,this)') +
          mpTlDateCell('mp-tl-pt', 'Finishes', ph.to,   'mpTlSetDate(-1,&quot;to&quot;,this)') +
        '</div>'
      : '') +
  '</div>';
  if (mpTl.skipped.length){
    rows += '<div class="mp-stage-skipped">' + mpTl.skipped.map(function(s){
      return '<button class="mp-btn ghost small" onclick="mpTlUnskip(&quot;' + s + '&quot;)">Add ' + mpEsc(s) + ' back</button>';
    }).join('') + '</div>';
  }
  return rows;
}
// ── setting one date ───────────────────────────────────────────────────────
// Only the block he touched moves. The single rule is that a phase cannot
// finish before it starts; everything else — overlapping Testing with
// Development, leaving three empty weeks before Costing — is his call to make.
function mpTlSetDate(i, which, el){
  var v = el && el.value;
  if (!v){ mpTlRefresh(); return; }
  var p = i < 0 ? mpTl.photo : mpTl.parts[i];
  if (!p){ mpTlRefresh(); return; }
  if (which === 'from'){
    if (v > p.to){ mpToast(p.stage + ' would finish before it starts. Move the finish date first.', true); mpTlRefresh(); return; }
    p.from = v;
  } else {
    if (v < p.from){ mpToast(p.stage + ' would finish before it starts. Move the start date first.', true); mpTlRefresh(); return; }
    p.to = v;
  }
  mpSheetDirty = true;
  mpTlRefresh();
}
function mpTlRefresh(){
  var s = document.querySelector('#mp-sheet .mp-sheet-body');
  if (s) s.innerHTML = mpTimelineBody();
}
// Dragging repaints in place instead. Rebuilding the sheet mid-drag threw away
// the very track the finger was being measured against — the first move read a
// zero-width box and collapsed the stage to nothing.
function mpTlPaint(){
  var start = mpTlStart(), total = mpTlTotal();
  var place = function(el, p){
    if (!el) return;
    el.style.left  = ((mpDaysBetween(start, p.from) / total) * 100).toFixed(3) + '%';
    el.style.width = ((mpTlLen(p) / total) * 100).toFixed(3) + '%';
  };
  var track = document.getElementById('mp-tl-track');
  if (track){
    var segs = track.querySelectorAll('.mp-tl-seg');
    mpTl.parts.forEach(function(p, i){ place(segs[i], p); });
  }
  if (mpTl.photo.on) place(document.querySelector('#mp-tl-photo .mp-tl-seg'), mpTl.photo);
  var list = document.getElementById('mp-stagelist');
  if (list) list.innerHTML = mpTlStageRows();
}
// ── dragging ───────────────────────────────────────────────────────────────
// Same pointer-events habit as the calendar grip, so a finger works exactly
// like a mouse. A block slides whole, keeping its length — the dates below are
// where a phase gets longer or shorter.
let mpTlDrag = null;
function mpTlDown(e, idx, what){
  if (e.button && e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  var track = mpTlTrack(what);
  if (!track) return;
  var p = what === 'photo' ? mpTl.photo : mpTl.parts[idx];
  var at = mpTlDayAt(e.clientX, track);
  if (!p || at === null) return;
  mpTlDrag = { idx:idx, what:what, grabbed: at - mpDaysBetween(mpTlStart(), p.from) };
  document.addEventListener('pointermove', mpTlMove, { passive:false });
  document.addEventListener('pointerup', mpTlUp, true);
  document.addEventListener('pointercancel', mpTlUp, true);
}
function mpTlTrack(what){ return document.getElementById(what === 'photo' ? 'mp-tl-photo' : 'mp-tl-track'); }
function mpTlDayAt(clientX, track){
  var box = track && track.getBoundingClientRect();
  if (!box || !box.width) return null;
  return Math.round(((clientX - box.left) / box.width) * mpTlTotal());
}
function mpTlMove(e){
  if (!mpTlDrag) return;
  e.preventDefault();
  // Look the track up again every time. Holding a reference across a repaint is
  // how the finger ends up measured against an element that is no longer there.
  var day = mpTlDayAt(e.clientX, mpTlTrack(mpTlDrag.what));
  if (day === null) return;
  var p = mpTlDrag.what === 'photo' ? mpTl.photo : mpTl.parts[mpTlDrag.idx];
  if (!p) return;
  var delta = (day - mpTlDrag.grabbed) - mpDaysBetween(mpTlStart(), p.from);
  if (!delta) return;
  mpTlShift(p, delta);
  mpSheetDirty = true;
  mpTlPaint();
}
function mpTlUp(){
  if (!mpTlDrag) return;
  mpTlDrag = null;
  document.removeEventListener('pointermove', mpTlMove, { passive:false });
  document.removeEventListener('pointerup', mpTlUp, true);
  document.removeEventListener('pointercancel', mpTlUp, true);
}
// ── skipping ───────────────────────────────────────────────────────────────
// A skipped stage keeps its dates in `was`, so adding it back puts it where it
// was rather than guessing. Nothing else moves: the gap it leaves is a gap.
function mpTlSkip(stage){
  var i = mpTl.parts.map(function(p){ return p.stage; }).indexOf(stage);
  if (i < 0 || mpTl.parts.length < 2) return;
  mpTl.was[stage] = { from:mpTl.parts[i].from, to:mpTl.parts[i].to };
  mpTl.parts.splice(i, 1);
  mpTl.skipped.push(stage);
  mpSheetDirty = true; mpTlRefresh();
}
function mpTlUnskip(stage){
  var k = mpTl.skipped.indexOf(stage);
  if (k < 0) return;
  var was = mpTl.was[stage];
  if (!was){
    // Never had dates: a week straight after whatever runs before it.
    var want = MP_STAGES.indexOf(stage);
    var before = mpTl.parts.filter(function(p){ return MP_STAGES.indexOf(p.stage) < want; });
    var prev = before.length ? before[before.length - 1] : null;
    var from = prev ? mpAddDays(prev.to, 1) : mpTlStart();
    was = { from:from, to:mpAddDays(from, 6) };
  }
  mpTl.skipped.splice(k, 1);
  // Back into its proper place in the order, not on the end.
  var w = MP_STAGES.indexOf(stage);
  var at = mpTl.parts.findIndex(function(p){ return MP_STAGES.indexOf(p.stage) > w; });
  mpTl.parts.splice(at < 0 ? mpTl.parts.length : at, 0, { stage:stage, from:was.from, to:was.to });
  mpSheetDirty = true; mpTlRefresh();
}
function mpTlPhotoOff(){ mpTl.photo.on = false; mpSheetDirty = true; mpTlRefresh(); }
function mpTlPhotoOn(){ mpTl.photo.on = true; mpSheetDirty = true; mpTlRefresh(); }
function mpTlCancel(){
  mpTl = null;
  if (mpIntake){ mpIntake.i++; mpNextIntakeStep(); return; }
  mpCloseSheet();
}

async function mpSaveTimeline(btn){
  var menuId = mpTl.menuId;
  var m = mpMenus.filter(function(x){ return x.id === menuId; })[0];
  if (!m){ mpCloseSheet(); return; }
  var free = mpLock(btn); if (!free) return;
  try {
    var end = mpTlEnd();
    // The ready-by date goes on the menu whichever way round the DB is, so the
    // thing still shows up on his list with a date before the SQL is run. The
    // window END is that date, always — he was just asked when it has to be
    // ready and a stale seeded launch must not outrank his answer. For anything
    // with a fixed day (Bartolini) the end already IS that day, so this moves
    // nothing.
    var upd = { launch_date:end, updated_at:new Date().toISOString(), updated_by:mpMe.name };
    if (mpMenuKind(m) === 'event') upd.event_date = end;
    if (mpHasRequests) upd.plan_state = mpIsApprover() ? 'accepted' : 'proposed';
    // Planning it is what moves it out of the list and onto What's on. Same
    // write, so it cannot half-happen.
    if (mpHasOnPlan) upd.on_plan = true;

    if (mpHasStages){
      var old = mpStagesFor(menuId);
      for (var i = 0; i < old.length; i++){
        var del = await sb.from('menu_plan_calendar').delete().eq('id', old[i].id);
        if (mpErr(del, 'the plan')) return;
      }
      // Each block writes its own two dates, exactly as they read on screen.
      var rows = mpTlBlocks().map(function(p){
        return { menu_id:menuId, stage:p.stage, starts_on:p.from, ends_on:p.to,
                 updated_by:mpMe.name, updated_at:new Date().toISOString() };
      });
      if (rows.length){
        var ins = await sb.from('menu_plan_calendar').insert(rows);
        if (mpErr(ins, 'the plan')) return;
      }
    }
    var res = await sb.from('menu_plan_menus').update(upd).eq('id', menuId);
    if (mpErr(res, 'the plan')) return;
    mpTl = null;
    await mpLoadAll();
    mpToast(mpHasStages ? m.name + ' planned' : 'Ready-by date saved');
    if (mpIntake){ mpIntake.i++; mpNextIntakeStep(); return; }
    mpCloseSheet(); mpRender();
  } finally { free(); }
}

// ══ ONE THING: its plan, its thread, and Francesco's accept ════════════════
// This is what replaced the whole-plan Submit ceremony. Francesco's oversight
// is per item now: he asks for a thing, Danilo plans it, he accepts that plan —
// and the two of them argue it out in the thread without booking a meeting.
function mpPlanThing(menuId){
  var m = mpMenus.filter(function(x){ return x.id === menuId; })[0];
  if (!m) return;
  if (!mpCanAuthor()){ mpToast('Only the chefs and Francesco plan the work.', true); return; }
  mpIntake = { mode:'develop', raw:'', items:[{ name:m.name, kind:mpMenuKind(m), menu_id:m.id, date:mpKnownDate(m) }], i:0 };
  mpNextIntakeStep();
}
function mpReviewPlan(menuId){
  var m = mpMenus.filter(function(x){ return x.id === menuId; })[0];
  if (!m) return;
  var stages = mpStagesFor(menuId);
  var when = mpWhenLive(m);
  mpSheet(m.name,
    (m.request_note
      ? '<div class="mp-reqnote"><div class="mp-reqnote-h">' +
          mpEsc((m.requested_by || 'Francesco').split(' ')[0]) + ' asked for this</div>' +
          mpEsc(m.request_note) +
          (m.needed_by ? '<div class="mp-reqnote-by">Needed by ' + mpEsc(mpDateLabel(m.needed_by)) + '</div>' : '') +
        '</div>'
      : '') +
    (when ? '<div class="mp-hint">Live ' + mpEsc(mpDateLabel(when)) + ' &middot; ' + mpEsc(mpHowFar(when)) + '</div>' : '') +
    (stages.length
      ? '<div class="mp-stagelist">' + stages.map(function(c){
          return '<div class="mp-stagerow">' +
            '<i class="mp-swatch s-' + String(c.stage).toLowerCase() + '"></i>' +
            '<span class="mp-stage-n"><strong>' + mpEsc(c.stage) + '</strong>' +
            '<em>' + mpEsc(mpDateLabel(c.starts_on)) + ' &rarr; ' + mpEsc(mpDateLabel(c.ends_on || c.starts_on)) + '</em></span>' +
          '</div>';
        }).join('') + '</div>' +
        (m.plan_state === 'accepted'
          ? '<div class="mp-why">Francesco accepted this plan.</div>'
          : m.plan_state === 'proposed' && !mpIsApprover()
            ? '<div class="mp-why">Francesco has it — he can accept it or write here.</div>' : '')
      : '<div class="mp-empty">No plan on it yet.</div>') +
    '<div class="mp-sheet-actions">' +
      (mpIsApprover() && m.plan_state === 'proposed' && stages.length
        ? '<button class="mp-btn go" onclick="mpAcceptPlan(\'' + m.id + '\')">Accept this plan</button>' : '') +
      (mpCanAuthor() ? '<button class="mp-btn ghost" onclick="mpPlanThing(\'' + m.id + '\')">' +
        (stages.length ? 'Change the plan' : 'Plan it') + '</button>' : '') +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">Close</button>' +
    '</div>' +
    mpCommentBlock('menu', m.id, 'Talk about this one', true));
}
async function mpAcceptPlan(menuId){
  var m = mpMenus.filter(function(x){ return x.id === menuId; })[0];
  if (!mpIsApprover() || !m) return;
  if (!mpHasRequests){ mpToast('This needs menu-plan-front-door.sql run once first.', true); return; }
  var ok = await mpConfirm('Accept the plan for “' + m.name + '”?',
    'The kitchen sees it accepted and gets on with it. You can still write on it afterwards.', 'Accept');
  if (!ok) return;
  var res = await sb.from('menu_plan_menus').update({
    plan_state:'accepted', updated_at:new Date().toISOString(), updated_by:mpMe.name
  }).eq('id', menuId);
  if (mpErr(res, 'the plan')) return;
  mpCloseSheet(); await mpLoadAll(); mpRender(); mpToast('Accepted');
}

// ══ FRANCESCO'S REQUEST PAGE ═══════════════════════════════════════════════
// What he wants, in his words — usually pasted straight out of a marketing
// email. When it's needed by is optional: leave it blank and Danilo proposes it.
function mpRequestSheet(seed){
  if (!mpIsApprover()) return;
  mpSheet('Ask the kitchen for something',
    (mpHasRequests ? ''
      : '<div class="mp-banner warn">Requests need <strong>menu-plan-front-door.sql</strong> run once in Supabase. ' +
        'Until then this would land on the kitchen&rsquo;s list with no note saying who asked or why.</div>') +
    '<label class="mp-lab">What do you want them to develop?</label>' +
    '<textarea class="mp-in mp-askin" id="mpr-note" rows="5" maxlength="' + MP_MAX_NOTE + '" ' +
      'placeholder="A new activation for December"></textarea>' +
    '<label class="mp-lab">Needed by <em>(optional — leave it blank and Danilo proposes the date)</em></label>' +
    '<input class="mp-in" type="date" id="mpr-by" min="' + mpAddDays(mpToday(), 1) + '"/>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpRunRequest(this)"' + (mpHasRequests ? '' : ' disabled') + '>Continue</button>' +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">Cancel</button>' +
    '</div>');
  setTimeout(function(){
    var t = document.getElementById('mpr-note');
    if (!t) return;
    if (seed) t.value = seed;
    try { t.focus(); } catch(e){}
  }, 60);
}
async function mpRunRequest(btn){
  var el = document.getElementById('mpr-note'), by = document.getElementById('mpr-by');
  var text = (el && el.value || '').trim();
  if (!text){ mpToast('Say what you want first.', true); return; }
  var neededBy = (by && by.value) || null;
  if (neededBy && neededBy <= mpToday()){ mpToast('That date has already gone — pick a later one.', true); return; }
  var free = mpLock(btn); if (!free) return;
  try {
    var items = await mpUnderstand(text);
    if (!items.length){ mpToast('Could not make anything out of that — name the menu or the event.', true); return; }
    mpIntake = { mode:'request', raw:text, items:items, i:0, neededBy:neededBy };
    mpReadBack();
  } finally { free(); }
}

// ══ 1. THE PLAN ════════════════════════════════════════════════════════════
function mpRenderPlan(){
  var tried = mpTriedCount(), approved = mpApprovedCount();
  var tT = (mpSprint && mpSprint.target_tried)    || 60;
  var tA = (mpSprint && mpSprint.target_approved) || 30;
  var next = mpNextTasting();
  var s = (mpSprint && mpSprint.status) || 'draft';
  var isChef = mpMe && mpMe.role === 'chef';
  var noDates = !mpSprint || (!mpSprint.start_date && !mpSprint.end_date);

  // Next steps, worded as things TO DO (not deficits). Only MAIN menus are
  // "written" — an event menu borrows its campaign's theme, so nagging a chef to
  // give Christmas Eve an identity/structure/lead is exactly the busywork we cut.
  var mainMenus = mpMenus.filter(function(m){ return !mpIsEventMenu(m); });
  var menusWritten = mainMenus.filter(function(m){ return m.identity && m.structure; }).length;
  var todo = [];
  if (noDates) todo.push({ label:'Set my dates and dish goal', go:'plan-sprint' });
  var noBrief = mainMenus.filter(function(m){ return !m.identity || !m.structure; });
  if (noBrief.length) todo.push({ label:'Write ' + noBrief.length + ' menu' + (noBrief.length === 1 ? '' : 's') + ' — what it is and its structure', go:'briefs' });
  var emptyRows = mainMenus.filter(function(m){ return !mpCal.some(function(c){ return c.menu_id === m.id; }); });
  if (emptyRows.length) todo.push({ label:'Put ' + emptyRows.length + ' menu' + (emptyRows.length === 1 ? '' : 's') + ' on the calendar', go:'calendar' });
  var bareIdeas = mpBareIdeas();
  if (bareIdeas.length) todo.push({ label:'Finish ' + bareIdeas.length + ' quick idea' + (bareIdeas.length === 1 ? '' : 's') + ' — just needs a section', go:'dishes' });

  return '<div class="mp-body">' +

    (s === 'changes_requested'
      ? '<div class="mp-banner warn"><strong>Francesco asked for changes.</strong> Read his comments below, fix what he asked, then submit again.</div>' : '') +
    (s === 'approved'
      ? '<div class="mp-banner ok"><strong>Plan approved.</strong> Keep developing dishes — that never stops.</div>' : '') +

    // ── the guide (chefs only) ──
    (isChef ? mpGuideCard() : '') +

    // ── where you're at (lead with what's DONE, not what's missing) ──
    '<div class="mp-card">' +
      '<div class="mp-card-h">Where you&rsquo;re at</div>' +
      '<div class="mp-progress">' +
        mpStat(mpDishes.length, 'dishes logged') +
        mpStat(approved, 'approved') +
        mpStat(menusWritten + ' / ' + mainMenus.length, 'menus written') +
        mpStat(mpTastings.length, 'tasting' + (mpTastings.length === 1 ? '' : 's')) +
      '</div>' +
      '<div class="mp-progress-note">Add things as they come — there&rsquo;s no rush.</div>' +
    '</div>' +

    // ── the two bars ── (his own goal, phrased as ambition — not a scorecard)
    '<div class="mp-card" id="plan-sprint">' +
      '<div class="mp-card-h">' + (isChef ? 'My goal this season' : 'The sprint') + '</div>' +
      (tried >= tT && approved >= tA
        ? '<div class="mp-celebrate">&#127881; <strong>Goal hit.</strong> Both targets reached — keep going or ease off, your call.</div>'
        : '') +
      mpBar(isChef ? 'Dishes I’ve tried' : 'Dishes tried', tried, tT, 'var(--mp-trying)') +
      mpBar(isChef ? 'Dishes approved' : 'Dishes approved', approved, tA, 'var(--mp-approved)') +
      '<div class="mp-sprint-meta">' +
        (mpSprint && (mpSprint.start_date || mpSprint.end_date)
          ? (mpSprint.start_date ? mpEsc(mpDateLabel(mpSprint.start_date)) : '?') + ' → ' + (mpSprint.end_date ? mpEsc(mpDateLabel(mpSprint.end_date)) : '?')
          : '<em>no dates set yet</em>') +
      '</div>' +
      (mpCanAuthor()
        ? '<button class="mp-btn ghost" onclick="mpEditSprint()">' + (noDates ? 'Propose dates &amp; goal' : 'Edit dates &amp; goal') + '</button>'
        : '') +
    '</div>' +

    // ── quick add ──
    (mpCanAuthor() ? '<button class="mp-big" onclick="mpAddDish()">+ Add a dish</button>' : '') +

    // ── next tasting ──
    '<div class="mp-card">' +
      '<div class="mp-card-h">Next tasting</div>' +
      (next
        ? '<div class="mp-next"><strong>' + mpEsc(mpDateLabel(next.session_date)) + (next.session_time ? ' · ' + mpEsc(next.session_time) : '') + '</strong>' +
          (next.title ? ' · ' + mpEsc(next.title) : '') +
          '<span>' + next.items.length + ' dish' + (next.items.length === 1 ? '' : 'es') + ' attached</span></div>'
        : '<div class="mp-empty">No tasting booked yet.</div>') +
      '<button class="mp-btn ghost" onclick="mpGo(\'tastings\')">Open tastings</button>' +
    '</div>' +

    // ── next steps (gentle, capped at 3 — never a wall of deficits) ──
    '<div class="mp-card">' +
      '<div class="mp-card-h">Next steps</div>' +
      (todo.length
        ? '<div class="mp-todo">' + todo.slice(0, 3).map(function(t){
            var go = t.go === 'plan-sprint' ? "document.getElementById('plan-sprint').scrollIntoView({behavior:'smooth'})" : "mpGo('" + t.go + "')";
            return '<button class="mp-todo-row" onclick="' + go + '">' +
              '<span>' + mpEsc(t.label) + '</span><span class="mp-todo-go">&rsaquo;</span></button>';
          }).join('') + '</div>' +
          (todo.length > 3 ? '<div class="mp-progress-note">&hellip;and ' + (todo.length - 3) + ' more, whenever you&rsquo;re ready.</div>' : '')
        : '<div class="mp-empty ok">You&rsquo;re all set — nothing waiting on you here.</div>') +
    '</div>' +

    // ── the calendar, here for approval ──
    '<div class="mp-card">' +
      '<div class="mp-card-h">The year calendar</div>' +
      '<div class="mp-hint">Tap any square to set what happens that month. Same grid as the Calendar tab.</div>' +
      mpCalendarGrid() +
      (mpCanAuthor() ? '<button class="mp-btn ghost" onclick="mpAddMenu()">+ Add a menu</button>' : '') +
    '</div>' +

    // ── the plan is agreed one thing at a time now ──
    // The whole-plan Submit / Approve ceremony and the comment box that went
    // with it are gone. Francesco asks for a thing, Danilo plans that thing,
    // Francesco accepts that plan — all on What's on, per item, with the
    // thread attached to the item rather than to a document nobody opens.
    (mpIsCostController()
      ? '<div class="mp-card"><div class="mp-card-h">Your job</div><div class="mp-hint">Open the <button class="mp-link" onclick="mpGo(\'dishes\')">Dishes</button> tab, filter to <strong>Costing</strong>, review each cost sheet and mark it Costed.</div></div>'
      : '<div class="mp-card">' +
        '<div class="mp-card-h">Agreeing the work</div>' +
        '<div class="mp-hint">Each menu and each event is agreed on its own, on ' +
          '<button class="mp-link" onclick="mpGo(\'home\')">What&rsquo;s on</button>' +
          (mpIsApprover()
            ? ' — ask for something, read the plan the kitchen sends back, accept it.'
            : ' — give each one a timeline and Francesco accepts it there.') +
        '</div>' +
      '</div>') +
  '</div>';
}

// The chef's guide: what to do, in order. Folds away once read, but stays
// reachable — no stress, nothing to hunt for.
// Rewritten with the front door: there is no whole-plan Submit any more, so the
// old steps 3–5 (month grid → propose a sprint → submit it) were telling chefs
// to go looking for a flow that no longer exists. Each thing is agreed on its
// own now, on What's on.
function mpGuideCard(){
  var steps = [
    ['1', 'Start on What’s on', 'Everything the kitchen has already committed to is there, nearest first.'],
    ['2', 'Plan one thing', 'Open it, say how long you’ve got, and the app lays out Development, Testing, Approval and Costing. Drag anything that looks wrong.'],
    ['3', 'Francesco accepts it', 'He reads that one plan and accepts it, or writes to you in its thread. One thing at a time — nothing to submit.'],
    ['4', 'Add your dishes', 'Log every dish you develop in Dishes — even the ones that don’t work.'],
    ['5', 'Book a tasting', 'Score them together. Francesco approves a dish, then it goes to Aung for costing.']
  ];
  // Folded away for good once they close it — it is 48% of the first screen, and
  // it was reopening itself on every single visit. Same localStorage habit as
  // the last-cadence / last-price / tap-your-name memories.
  var open = mpGuideIsOpen();
  return '<details class="mp-guide"' + (open ? ' open' : '') + ' ontoggle="mpGuideToggled(this)">' +
    '<summary><span class="mp-guide-k">How this works</span><span class="mp-guide-hint">' + (open ? 'tap to hide' : 'tap to read') + '</span></summary>' +
    '<div class="mp-guide-steps">' +
      steps.map(function(s){
        return '<div class="mp-guide-step"><span class="mp-guide-n">' + s[0] + '</span>' +
          '<span><strong>' + mpEsc(s[1]) + '</strong><span>' + mpEsc(s[2]) + '</span></span></div>';
      }).join('') +
    '</div></details>';
}
function mpGuideIsOpen(){
  try { return localStorage.getItem('menu-plan-guide') !== 'closed'; } catch(e){ return true; }
}
function mpGuideToggled(el){
  try { localStorage.setItem('menu-plan-guide', el.open ? 'open' : 'closed'); } catch(e){}
  var h = el.querySelector('.mp-guide-hint');
  if (h) h.textContent = el.open ? 'tap to hide' : 'tap to read';
}
function mpBar(label, n, target, colour){
  var pct = target > 0 ? Math.min(100, Math.round(n / target * 100)) : 0;
  var hit = target > 0 && n >= target;
  return '<div class="mp-bar-wrap' + (hit ? ' hit' : '') + '">' +
    '<div class="mp-bar-top"><span>' + mpEsc(label) + '</span><strong>' + n + ' / ' + target + (hit ? ' <i class="mp-hitmark">&#10003;</i>' : '') + '</strong></div>' +
    '<div class="mp-bar"><i style="width:' + pct + '%;background:' + (hit ? 'var(--mp-banked)' : colour) + '"></i></div>' +
  '</div>';
}
function mpStat(value, label){
  return '<div class="mp-stat"><b>' + mpEsc(String(value)) + '</b><span>' + mpEsc(label) + '</span></div>';
}

// Propose (chef) or edit (approver) the sprint dates + goals. One sheet, all
// four fields at once — friendlier than four back-to-back prompts.
function mpEditSprint(){
  var s = mpSprint || {};
  mpSheet(mpMe.role === 'chef' ? 'Propose your dates & goal' : 'Sprint dates & goal',
    '<div class="mp-two">' +
      '<div><label class="mp-lab">Start date</label><input class="mp-in" type="date" id="mps-start" value="' + mpEsc((s.start_date || '').slice(0,10)) + '"/></div>' +
      '<div><label class="mp-lab">End date</label><input class="mp-in" type="date" id="mps-end" value="' + mpEsc((s.end_date || '').slice(0,10)) + '"/></div>' +
    '</div>' +
    '<div class="mp-two">' +
      '<div><label class="mp-lab">Goal — dishes tried</label><input class="mp-in" type="number" inputmode="numeric" min="1" step="1" id="mps-tt" value="' + (s.target_tried || 60) + '"/></div>' +
      '<div><label class="mp-lab">Goal — dishes approved</label><input class="mp-in" type="number" inputmode="numeric" min="1" step="1" id="mps-ta" value="' + (s.target_approved || 30) + '"/></div>' +
    '</div>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpSaveSprint()">Save</button>' +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">Cancel</button>' +
    '</div>');
}
// Checked before anything is written: a backwards date range and a goal of 0 or
// -5 all used to save (or silently not save) and still show "✓ Sprint updated".
function mpWholeNumber(id, what){
  var raw = (document.getElementById(id).value || '').trim();
  var n = Number(raw);
  if (!raw || !isFinite(n) || n < 1 || Math.floor(n) !== n){
    mpToast(what + ' needs to be a whole number, 1 or more — a goal of ' + (raw || 'nothing') + ' is not a goal.', true);
    document.getElementById(id).focus();
    return null;
  }
  return n;
}
async function mpSaveSprint(){
  var start = document.getElementById('mps-start').value || null;
  var end   = document.getElementById('mps-end').value || null;
  if (start && end && end < start){
    mpToast('The end date is before the start date — check them.', true);
    document.getElementById('mps-end').focus(); return;
  }
  var tried = mpWholeNumber('mps-tt', 'The dishes-tried goal');    if (tried === null) return;
  var appr  = mpWholeNumber('mps-ta', 'The dishes-approved goal'); if (appr === null) return;
  var row = {
    id:1,
    start_date: start,
    end_date:   end,
    target_tried:    tried,
    target_approved: appr,
    updated_at: new Date().toISOString()
  };
  var res = await sb.from('menu_plan_sprint').upsert(row, { onConflict:'id' });
  if (mpErr(res, 'the sprint')) return;
  mpCloseSheet(); await mpLoadAll(); mpRender(); mpToast('Sprint updated');
}

// The three below, and the email they send, are no longer reachable: the
// whole-plan Submit / Approve ceremony was replaced by the per-item
// request → plan → accept loop on What's on. Kept, unwired, so nothing that
// still points at menu_plan_sprint.status breaks; nothing calls them.
async function mpSubmitPlan(){
  var ok = await mpConfirm('Submit the plan to Francesco?',
    'He gets an email with the whole plan — calendar, menus and every dish — and can comment on each one. You can keep editing after you submit.',
    'Submit');
  if (!ok) return;
  var res = await sb.from('menu_plan_sprint').upsert({
    id:1, status:'submitted', submitted_by:mpMe.name, submitted_at:new Date().toISOString(),
    updated_at:new Date().toISOString()
  }, { onConflict:'id' });
  if (mpErr(res, 'the submission')) return;
  await mpLoadAll(); mpRender();
  mpToast('Submitted to Francesco');
  mpEmailPlan('submitted');
}
async function mpApprovePlan(){
  var ok = await mpConfirm('Approve this plan?',
    'The team sees it marked approved. They can still add dishes — developing never stops.',
    'Approve');
  if (!ok) return;
  var res = await sb.from('menu_plan_sprint').upsert({
    id:1, status:'approved', approved_by:mpMe.name, approved_at:new Date().toISOString(),
    updated_at:new Date().toISOString()
  }, { onConflict:'id' });
  if (mpErr(res, 'the approval')) return;
  await mpLoadAll(); mpRender(); mpToast('Plan approved');
  mpEmailPlan('approved');
}
async function mpRequestChanges(){
  var note = await mpPrompt('What needs changing?', 'textarea', '');
  if (note === null || !String(note).trim()) return;
  var a = await sb.from('menu_plan_comments').insert({ target_type:'plan', target_id:null, author:mpMe.name, body:String(note).trim() });
  if (mpErr(a, 'the comment')) return;
  var res = await sb.from('menu_plan_sprint').upsert({
    id:1, status:'changes_requested', updated_at:new Date().toISOString()
  }, { onConflict:'id' });
  if (mpErr(res, 'the request')) return;
  await mpLoadAll(); mpRender(); mpToast('Sent back with your note');
  mpEmailPlan('changes_requested', String(note).trim());
}

// ══ 2. DISH BANK ═══════════════════════════════════════════════════════════
// A "bare" quick idea: fast to capture, but still owes a section/menus/
// allergens. The tray below pays that debt back without reopening the full form.
function mpBareIdeas(){
  return mpDishes.filter(function(d){
    return d.status === 'Idea' && d.section === 'Other' &&
      !((d.for_menus || []).length) && !((d.allergens || []).length);
  });
}
function mpIdeaTray(){
  if (!mpCanAuthor()) return '';
  var bare = mpBareIdeas();
  if (!bare.length) return '';
  // Say how many actually got a guess — it claimed every one of them had a
  // section pre-picked when half the list was still on "Section…".
  var guessed = bare.filter(function(d){ return !!mpGuessSectionFor(d.name_it); }).length;
  var guessNote = !guessed ? ''
    : guessed === bare.length ? ' — a guess is already picked for each'
    : ' — ' + guessed + ' of ' + bare.length + ' already have a guess picked';
  return '<div class="mp-card mp-tray">' +
    '<div class="mp-card-h">Finish these ideas <i>' + bare.length + '</i></div>' +
    '<div class="mp-hint">Give each a section' + guessNote + ' and it&rsquo;s off this list. Tap the name for everything else.</div>' +
    '<div class="mp-traylist">' + bare.map(function(d){
      var guess = mpGuessSectionFor(d.name_it) || '';
      return '<div class="mp-trayrow">' +
        '<button class="mp-trayname" onclick="mpOpenDish(\'' + d.id + '\')">' + mpEsc(d.name_it) + '</button>' +
        '<select class="mp-trayselect" id="mptray-' + d.id + '">' +
          '<option value="">Section&hellip;</option>' +
          MP_SECTIONS.map(function(s){ return '<option' + (guess === s ? ' selected' : '') + '>' + mpEsc(s) + '</option>'; }).join('') +
        '</select>' +
        '<button class="mp-btn go small" onclick="mpFinishIdea(\'' + d.id + '\')">Done</button>' +
      '</div>';
    }).join('') + '</div>' +
  '</div>';
}
async function mpFinishIdea(dishId){
  var sel = document.getElementById('mptray-' + dishId);
  var section = sel ? sel.value : '';
  if (!section){ mpToast('Pick a section first.', true); return; }
  var res = await sb.from('menu_plan_dishes').update({ section:section, updated_at:new Date().toISOString(), updated_by:mpMe.name }).eq('id', dishId);
  if (mpErr(res, 'the dish')) return;
  await mpLoadAll(); mpRender(); mpToast('Sorted');
}
function mpFilteredDishes(){
  var f = mpFilter, q = (f.q || '').trim().toLowerCase();
  return mpDishes.filter(function(d){
    if (f.section && d.section !== f.section) return false;
    if (f.status  && d.status  !== f.status)  return false;
    if (f.menu    && !(d.for_menus || []).includes(f.menu)) return false;
    if (q){
      var hay = [d.name_it, d.description_en, d.notes, d.section, (d.for_menus || []).join(' ')].join(' ').toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  });
}
function mpRenderDishes(){
  var list = mpFilteredDishes();
  var costingReady = mpDishes.filter(function(d){ return d.status === 'Costing' && mpDishFilesFor(d.id).length; });

  var sel = function(id, label, opts, val){
    return '<select class="mp-sel" id="' + id + '" onchange="mpSetFilter()">' +
      '<option value="">' + label + '</option>' +
      opts.map(function(o){ return '<option value="' + mpEsc(o) + '"' + (val === o ? ' selected' : '') + '>' + mpEsc(o) + '</option>'; }).join('') +
    '</select>';
  };

  return '<div class="mp-body">' +
    (mpCanAuthor()
      ? '<div class="mp-addrow-two">' +
          '<button class="mp-big" onclick="mpQuickIdea()">&#9889; Quick idea</button>' +
          '<button class="mp-big ghost" onclick="mpAddDish()">+ Add a dish</button>' +
        '</div>' : '') +

    mpIdeaTray() +

    // cost controller / anyone: send the ready cost sheets on to costing
    (mpCanAuthor() && costingReady.length
      ? '<button class="mp-big ghost" onclick="mpSendCosting()">&#128233; Send cost sheets to cost controller (' + costingReady.length + ' ready)</button>' : '') +
    (mpIsCostController()
      ? '<div class="mp-banner ok" style="margin-bottom:2px">You’re the cost controller. Review each dish’s cost sheet, then mark it <strong>Costed ✓</strong>.</div>' : '') +

    '<div class="mp-filters">' +
      '<input class="mp-search" id="mp-f-q" placeholder="Search dishes…" value="' + mpEsc(mpFilter.q) + '" oninput="mpSetFilter()"/>' +
      '<div class="mp-filter-row">' +
        sel('mp-f-section', 'All sections', MP_SECTIONS,        mpFilter.section) +
        sel('mp-f-menu',    'All menus',    mpMenuTagOptions(), mpFilter.menu) +
        sel('mp-f-status',  'All statuses', MP_STATUSES,        mpFilter.status) +
      '</div>' +
      '<div class="mp-filter-foot">' +
        '<span id="mp-count">' + list.length + ' of ' + mpDishes.length + ' dishes</span>' +
        '<span class="mp-viewtog">' +
          '<button class="' + (mpBoardView === 'list'  ? 'on' : '') + '" onclick="mpSetView(\'list\')">List</button>' +
          '<button class="' + (mpBoardView === 'board' ? 'on' : '') + '" onclick="mpSetView(\'board\')">Board</button>' +
        '</span>' +
        // In its own span so the partial redraw can put it there too — it used
        // to appear only on a full render, which is never what filtering does,
        // so the one control that undoes a filter was unreachable.
        '<span id="mp-clearwrap">' + mpClearFilterBtn() + '</span>' +
      '</div>' +
    '</div>' +

    (mpDishes.length === 0
      ? '<div class="mp-empty big">No dishes yet.<br/>Every dish you develop goes here — even the ones that do not work.</div>'
      : list.length === 0
        ? '<div class="mp-empty big">No dish matches these filters.</div>'
        : (mpBoardView === 'board' ? mpRenderBoard(list) : mpRenderDishList(list))) +
  '</div>';
}
function mpSetView(v){ mpBoardView = v; mpRender(); }
function mpSetFilter(){
  mpFilter = {
    q:       (document.getElementById('mp-f-q')       || {}).value || '',
    section: (document.getElementById('mp-f-section') || {}).value || '',
    menu:    (document.getElementById('mp-f-menu')    || {}).value || '',
    status:  (document.getElementById('mp-f-status')  || {}).value || ''
  };
  // Redraw only the results, so the search box keeps focus and the caret.
  var host = document.getElementById('mp-results');
  var list = mpFilteredDishes();
  if (host) host.innerHTML = (list.length ? (mpBoardView === 'board' ? mpRenderBoard(list, true) : mpRenderDishList(list, true))
                                          : '<div class="mp-empty big">No dish matches these filters.</div>');
  var cnt = document.getElementById('mp-count');
  if (cnt) cnt.textContent = list.length + ' of ' + mpDishes.length + ' dishes';
  var clr = document.getElementById('mp-clearwrap');
  if (clr) clr.innerHTML = mpClearFilterBtn();
}
function mpClearFilterBtn(){
  return (mpFilter.q || mpFilter.section || mpFilter.menu || mpFilter.status)
    ? '<button class="mp-link" onclick="mpClearFilter()">Clear filters</button>' : '';
}
function mpClearFilter(){ mpFilter = { section:'', menu:'', status:'', q:'' }; mpRender(); }
function mpDishFilesFor(dishId){ return mpDishFiles[dishId] || []; }

function mpRenderDishList(list, inner){
  var html = list.map(function(d){ return mpDishCard(d); }).join('');
  return inner ? html : '<div id="mp-results" class="mp-dishlist">' + html + '</div>';
}
function mpRenderBoard(list, inner){
  var html = '<div class="mp-board">' + MP_BOARD.map(function(st){
    var col = list.filter(function(d){ return d.status === st; });
    return '<div class="mp-col" data-status="' + st + '" ondragover="mpDragOver(event)" ondrop="mpDrop(event,\'' + st + '\')" ondragleave="mpDragLeave(event)">' +
      '<div class="mp-col-h"><span class="mp-chip s-' + st.toLowerCase() + '">' + st + '</span><i>' + col.length + '</i></div>' +
      '<div class="mp-col-body">' + (col.length ? col.map(function(d){ return mpDishCard(d, true); }).join('') : '<div class="mp-col-empty">—</div>') + '</div>' +
    '</div>';
  }).join('') + '</div>';
  return inner ? html : '<div id="mp-results">' + html + '</div>';
}
function mpDishCard(d, onBoard){
  var photo = mpPhotos[d.id];
  var tags = (d.for_menus || []).slice(0, 3).map(function(t){ return '<span class="mp-tag">' + mpEsc(t) + '</span>'; }).join('');
  var more = (d.for_menus || []).length > 3 ? '<span class="mp-tag more">+' + ((d.for_menus || []).length - 3) + '</span>' : '';
  var all = (d.allergens || []).map(function(a){
    var f = MP_ALLERGENS.find(function(x){ return x.code === a; });
    return '<span class="mp-all" title="' + mpEsc(f ? f.label : a) + '">' + mpEsc(a) + '</span>';
  }).join('');
  var oc = mpOpenCommentCount('dish', d.id);
  var scoreBits = [];
  if (d.taste_score) scoreBits.push('T ' + d.taste_score);
  if (d.presentation_score) scoreBits.push('P ' + d.presentation_score);
  var costBits = [];
  if (d.status === 'Costing' || d.costing_status){
    if (d.selling_price) costBits.push(mpEsc(d.selling_price));
    var nf = mpDishFilesFor(d.id).length;
    if (nf) costBits.push(nf + ' sheet' + (nf === 1 ? '' : 's'));
    if (d.costing_status === 'costed') costBits.push('<span class="mp-costed">Costed &#10003;</span>');
    else if (d.costing_status === 'sent') costBits.push('sent to costing');
  }
  return '<div class="mp-dish' + (onBoard ? ' on-board' : '') + '"' +
      (onBoard ? ' draggable="true" ondragstart="mpDragStart(event,\'' + d.id + '\')" ondragend="mpDragEnd(event)"' : '') + '>' +
    '<div class="mp-dish-main" onclick="mpOpenDish(\'' + d.id + '\')">' +
      (photo ? '<img class="mp-dish-img" src="' + photo + '" alt=""/>' : '') +
      '<div class="mp-dish-txt">' +
        '<div class="mp-dish-name">' + mpEsc(d.name_it) + (oc ? '<em class="mp-cbadge">' + oc + '</em>' : '') + '</div>' +
        (d.description_en ? '<div class="mp-dish-desc">' + mpEsc(d.description_en) + '</div>' : '') +
        '<div class="mp-dish-meta">' + mpEsc(d.section) +
          (scoreBits.length ? ' · ' + scoreBits.join(' · ') : '') + '</div>' +
        (tags || more ? '<div class="mp-dish-tags">' + tags + more + '</div>' : '') +
        (all ? '<div class="mp-dish-all">' + all + '</div>' : '') +
        (costBits.length ? '<div class="mp-dish-cost">' + costBits.join(' · ') + '</div>' : '') +
      '</div>' +
    '</div>' +
    '<button class="mp-chip s-' + d.status.toLowerCase() + ' tapme" onclick="mpStatusMenu(\'' + d.id + '\',event)">' + mpEsc(d.status) + ' &#9662;</button>' +
  '</div>';
}

// ── drag to change status (desktop). Phones use the status chip menu. ───────
let mpDragId = null;
function mpDragStart(e, id){ mpDragId = id; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', id); } catch(err){} }
function mpDragEnd(){ mpDragId = null; document.querySelectorAll('.mp-col.over').forEach(function(c){ c.classList.remove('over'); }); }
function mpDragOver(e){ e.preventDefault(); e.dataTransfer.dropEffect = 'move'; e.currentTarget.classList.add('over'); }
function mpDragLeave(e){ e.currentTarget.classList.remove('over'); }
function mpDrop(e, status){
  e.preventDefault();
  e.currentTarget.classList.remove('over');
  var id = mpDragId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
  if (id) mpSetDishStatus(id, status);
  mpDragId = null;
}

// Chefs move a dish as far as Testing, and can move an Approved dish into
// Costing. Only the approver sets Approved — that boundary is the whole point.
// The cost controller changes no statuses at all.
// Costing is the step AFTER Approved — it means a cost sheet and a price go to
// the cost controller, so a brand-new Idea must not be able to jump there.
function mpCanSetStatus(status, d){
  if (!mpCanAuthor()) return false;
  if (status === 'Approved') return mpIsApprover();
  if (status === 'Costing')  return !!(d && (d.status === 'Approved' || d.status === 'Costing'));
  return true;
}
function mpStatusMenu(id, ev){
  if (ev) ev.stopPropagation();
  var d = mpDishes.find(function(x){ return x.id === id; });
  if (!d) return;
  if (!mpCanAuthor()){ mpToast('Only chefs and Francesco change a dish’s stage.', true); return; }
  // A locked stage (Approved, for a chef) is NOT a dead button — it stays
  // tappable and explains the path instead of just sitting there greyed.
  mpSheet('Move “' + d.name_it + '”',
    '<div class="mp-statuslist">' + MP_STATUSES.map(function(s){
      var allowed = mpCanSetStatus(s, d);
      var costingLocked = !allowed && s === 'Costing';
      return '<button class="mp-statusrow' + (d.status === s ? ' now' : '') + (allowed ? '' : ' locked') + '"' +
        (allowed ? ' onclick="mpCloseSheet();mpSetDishStatus(\'' + id + '\',\'' + s + '\')"'
                 : costingLocked ? ' onclick="mpExplainCosting(\'' + id + '\')"'
                                 : ' onclick="mpExplainApprove(\'' + id + '\')"') + '>' +
        '<span class="mp-chip s-' + s.toLowerCase() + '">' + s + '</span>' +
        '<span class="mp-statusnote">' + mpEsc(MP_STATUS_NOTE[s]) + '</span>' +
        (allowed ? '' : '<span class="mp-locked">' + (costingLocked ? 'Approved first &rsaquo;' : 'Francesco approves &rsaquo;') + '</span>') +
      '</button>';
    }).join('') + '</div>');
}
// The "handle" on the locked Approved row: tell the chef exactly how it gets
// approved, and offer the action that leads there (book it into a tasting).
function mpExplainApprove(dishId){
  var d = mpDishes.find(function(x){ return x.id === dishId; });
  mpSheet('Getting “' + (d ? d.name_it : 'this') + '” approved',
    '<div class="mp-hint">You take a dish as far as <strong>Testing</strong>. Francesco does the final <strong>Approve</strong> — usually at a tasting, once he’s tried it. Your work up to then is all saved.</div>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpCloseSheet();mpGo(\'tastings\')">Book it into a tasting</button>' +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">Got it</button>' +
    '</div>');
}
// The other locked row: Costing is where a dish goes to be priced and sent to
// the cost controller, so it only opens once Francesco has approved the dish.
function mpExplainCosting(dishId){
  var d = mpDishes.find(function(x){ return x.id === dishId; });
  mpSheet('Costing “' + (d ? d.name_it : 'this') + '”',
    '<div class="mp-hint">Costing is the step after <strong>Approved</strong> — it is what sends the cost sheet and the price to the cost controller. ' +
      'This dish is still <strong>' + mpEsc(d ? d.status : '') + '</strong>, so there is nothing to cost yet.</div>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpCloseSheet();mpGo(\'tastings\')">Book it into a tasting</button>' +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">Got it</button>' +
    '</div>');
}
const MP_STATUS_NOTE = {
  Idea:     'Written down, not cooked yet',
  Trying:   'Being cooked and played with',
  Testing:  'Ready to put in front of someone',
  Approved: 'Tasted and approved',
  Costing:  'Cost sheet + price, off to the cost controller',
  Retired:  'Off the table, kept for the record'
};
async function mpSetDishStatus(id, status){
  var d = mpDishes.find(function(x){ return x.id === id; });
  if (!d || d.status === status) return;
  if (!mpCanSetStatus(status, d)){
    mpToast(status === 'Costing'
      ? 'A dish goes to Costing once it is Approved — this one is still ' + d.status + '.'
      : 'Only Francesco can approve a dish.', true);
    return;
  }
  // Undoing an approval is a real decision, not a mis-tap: name it, and leave a
  // trace on the dish saying who moved it and where from.
  var unApproving = d.status === 'Approved' && status !== 'Costing';
  if (unApproving){
    var ok = await mpConfirm('Take “' + d.name_it + '” back to ' + status + '?',
      'It stops being an approved dish for everyone' +
      (d.approved_date ? ' — it was approved on ' + mpDateLabel(d.approved_date) : '') +
      ', and Francesco has to approve it again. Your name is saved against the change.',
      'Move it back', { cancelLabel:'Leave it approved', safeFirst:true });
    if (!ok) return;
  }
  var patch = { status:status, updated_at:new Date().toISOString(), updated_by:mpMe.name };
  if (status === 'Approved' && !d.approved_date) patch.approved_date = mpToday();
  var res = await sb.from('menu_plan_dishes').update(patch).eq('id', id);
  if (mpErr(res, 'the dish')) return;
  if (unApproving){
    await sb.from('menu_plan_comments').insert({ target_type:'dish', target_id:id, author:mpMe.name,
      body:'Moved out of Approved (Approved → ' + status + ').' });
    await mpLoadAll();
  }
  Object.assign(d, patch);
  mpRender();
  mpToast(d.name_it + ' → ' + status);
}

// ── add / edit a dish ───────────────────────────────────────────────────────
// Only two fields are required. Everything else is optional and folded away —
// a chef with flour on their hands must be able to log a dish in ten seconds.
function mpAddDish(){ mpDishForm(null); }
function mpOpenDish(id){ mpDishForm(mpDishes.find(function(x){ return x.id === id; }) || null); }

// "New like this" — start a fresh dish carrying over section/menus/allergens/
// notes from an existing one, so a near-identical dish isn't typed from scratch.
function mpDuplicateDish(dishId){
  var src = mpDishes.find(function(x){ return x.id === dishId; });
  if (!src) return;
  mpDuplicateSeed = {
    fromName: src.name_it, section: src.section,
    for_menus: (src.for_menus || []).slice(), allergens: (src.allergens || []).slice(),
    notes: src.notes || ''
  };
  mpAddDish();
}

// One-tap capture for mid-service: just a name, straight into Idea. Everything
// else (section, photo, allergens) gets filled in later — a chef with flour on
// their hands must be able to save a thought in five seconds.
function mpQuickIdea(){
  mpSheet('Quick idea',
    '<div class="mp-hint">Just the name for now — you can flesh it out anytime.</div>' +
    '<input class="mp-in" id="mpq-name" maxlength="' + MP_MAX_NAME + '" placeholder="e.g. Scampi crudo, lime &amp; pink pepper" autocomplete="off"/>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpSaveQuickIdea(this)">Save idea</button>' +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">Cancel</button>' +
    '</div>');
  setTimeout(function(){ var el = document.getElementById('mpq-name'); if (el) el.focus(); }, 40);
}
async function mpSaveQuickIdea(btn){
  var name = (document.getElementById('mpq-name').value || '').trim();
  if (!name){ mpToast('Type a name first.', true); document.getElementById('mpq-name').focus(); return; }
  var free = mpLock(btn); if (!free) return;
  try {
    var res = await sb.from('menu_plan_dishes').insert({
      name_it:name, section:'Other', status:'Idea', created_by:mpMe.name, updated_by:mpMe.name
    }).select().single();
    if (mpErr(res, 'the idea')) return;
    if (res && res.data) mpDishes.unshift(res.data);
    mpCloseSheet(); mpRender(); mpToast(name + ' saved — flesh it out anytime');
  } finally { free(); }
}

function mpDishForm(d){
  var isNew = !d;
  d = d || { name_it:'', description_en:'', section:'', for_menus:[], status:'Idea',
             allergens:[], notes:'' };
  // "Duplicate" seed — a one-shot carry-over from mpDuplicateDish, consumed once.
  var dupFrom = null;
  if (isNew && mpDuplicateSeed){
    dupFrom = mpDuplicateSeed.fromName;
    d = Object.assign({}, d, {
      section: mpDuplicateSeed.section, for_menus: mpDuplicateSeed.for_menus,
      allergens: mpDuplicateSeed.allergens, notes: mpDuplicateSeed.notes
    });
    mpDuplicateSeed = null;
  }
  // A section already on the row was chosen by a person (or confirmed by them
  // when they last saved) — the guess may not touch it.
  mpSectionIsGuess = false;
  var photo = d.id ? mpPhotos[d.id] : null;
  var oc = d.id ? mpCommentsFor('dish', d.id) : [];
  var canEdit = mpCanAuthor();
  var inCosting = d.id && (d.status === 'Approved' || d.status === 'Costing');

  // A cost controller gets a slim, read-only view focused on the costing block —
  // they review the sheet and mark it Costed, they don't rewrite the dish.
  if (d.id && mpIsCostController()){
    mpSheet(d.name_it,
      '<div class="mp-dishfoot"><span class="mp-chip s-' + d.status.toLowerCase() + '">' + mpEsc(d.status) + '</span>' +
        (d.description_en ? '<span class="mp-fine">' + mpEsc(d.description_en) + '</span>' : '') + '</div>' +
      mpCostingBlock(d) +
      '<div class="mp-sheet-actions"><button class="mp-btn ghost" onclick="mpCloseSheet()">Close</button></div>' +
      mpCommentBlock('dish', d.id, 'Comments on this dish' + (oc.length ? ' (' + oc.length + ')' : '')));
    return;
  }

  var ro = canEdit ? '' : ' disabled';
  var body =
    (dupFrom ? '<div class="mp-hint">Starting from <strong>' + mpEsc(dupFrom) + '</strong> — section, menus, allergens and notes copied. Give it a new name.</div>' : '') +

    '<label class="mp-lab">Dish name <em>(Italian)</em></label>' +
    '<input class="mp-in" id="mpf-name" maxlength="' + MP_MAX_NAME + '" value="' + mpEsc(d.name_it) + '" placeholder="e.g. Tortello di burrata"' + ro +
      (canEdit ? ' oninput="mpGuessSection(this.value)" onblur="mpSuggestAllergens()"' : '') + '/>' +

    '<label class="mp-lab">Section</label>' +
    (canEdit ? mpSearchPicker('mpf-section', MP_SECTIONS, d.section, 'Search or tap a section…')
             : '<div class="mp-readval">' + mpEsc(d.section || '—') + '</div>') +
    '<div class="mp-fine" id="mpf-section-hint"></div>' +

    '<label class="mp-lab">What it is <em>(plain English — optional)</em></label>' +
    '<textarea class="mp-in" id="mpf-desc" rows="2" maxlength="' + MP_MAX_DESC + '" placeholder="Burrata tortello, tomato water, basil oil"' + ro +
      (canEdit ? ' onblur="mpSuggestAllergens()"' : '') + '>' + mpEsc(d.description_en) + '</textarea>' +

    '<div class="mp-photo-row">' +
      (photo ? '<img class="mp-photo-prev" id="mpf-prev" src="' + photo + '"/>' : '<div class="mp-photo-prev empty" id="mpf-prev">no photo</div>') +
      (canEdit ? '<div>' +
        '<input type="file" accept="image/*" id="mpf-photo" style="display:none" onchange="mpPickPhoto(this)"/>' +
        '<button class="mp-btn ghost" onclick="document.getElementById(\'mpf-photo\').click()">' + (photo ? 'Change photo' : 'Add a photo') + '</button>' +
        (photo ? '<button class="mp-btn ghost danger" onclick="mpDropPhoto()">Remove</button>' : '') +
      '</div>' : '') +
    '</div>' +

    '<details class="mp-more"' + (isNew && !dupFrom ? '' : ' open') + '>' +
      '<summary>Add more detail</summary>' +

      '<label class="mp-lab">For which menus <em>(tap any that apply)</em></label>' +
      '<div class="mp-pills" id="mpf-menus">' +
        mpMenuTagOptions().map(function(m){
          return '<button type="button" class="mp-pill' + ((d.for_menus || []).includes(m) ? ' on' : '') + '" data-v="' + mpEsc(m) + '"' + (canEdit ? ' onclick="this.classList.toggle(\'on\')"' : ' disabled') + '>' + mpEsc(m) + '</button>';
        }).join('') +
      '</div>' +

      '<label class="mp-lab">Allergens</label>' +
      '<div class="mp-pills" id="mpf-allerg">' +
        MP_ALLERGENS.map(function(a){
          return '<button type="button" class="mp-pill' + ((d.allergens || []).includes(a.code) ? ' on' : '') + '" data-v="' + a.code + '"' + (canEdit ? ' onclick="this.classList.toggle(\'on\')"' : ' disabled') + '>' + a.code + ' · ' + mpEsc(a.label) + '</button>';
        }).join('') +
      '</div>' +
      '<div class="mp-fine" id="mpf-allerg-hint"></div>' +

      '<label class="mp-lab">Notes</label>' +
      '<textarea class="mp-in" id="mpf-notes" rows="3" maxlength="' + MP_MAX_NOTE + '" placeholder="What to fix, what worked, supplier…"' + ro + '>' + mpEsc(d.notes || '') + '</textarea>' +
    '</details>' +

    (d.id
      ? '<div class="mp-dishfoot">' +
          '<span class="mp-chip s-' + d.status.toLowerCase() + '">' + mpEsc(d.status) + '</span>' +
          (d.approved_date ? '<span class="mp-fine">approved ' + mpEsc(mpDateLabel(d.approved_date)) + '</span>' : '') +
        '</div>'
      : '') +

    // ── costing (only once a dish is Approved / in Costing) ──
    (inCosting ? mpCostingBlock(d) : '') +

    // ── what's yours vs whose (reassurance, chefs only) ──
    (canEdit && mpMe.role === 'chef'
      ? '<div class="mp-owns">You can change everything on this dish. <strong>Francesco</strong> does the final Approve; <strong>Aung</strong> does the costing.</div>'
      : '') +

    (canEdit
      ? '<div class="mp-sheet-actions">' +
          '<button class="mp-btn go" onclick="mpSaveDish(' + (d.id ? "'" + d.id + "'" : 'null') + ',this)">' + (isNew ? 'Add it' : 'Save') + '</button>' +
          (d.id ? '<button class="mp-btn ghost" onclick="mpCloseSheet();mpDuplicateDish(\'' + d.id + '\')">Duplicate</button>' : '') +
          (d.id ? '<button class="mp-btn ghost danger" onclick="mpDeleteDish(\'' + d.id + '\')">Delete</button>' : '') +
          '<button class="mp-btn ghost" onclick="mpCloseSheet()">Cancel</button>' +
        '</div>'
      : '<div class="mp-sheet-actions"><button class="mp-btn ghost" onclick="mpCloseSheet()">Close</button></div>') +

    (d.id ? mpCommentBlock('dish', d.id, 'Comments on this dish' + (oc.length ? ' (' + oc.length + ')' : '')) : '');

  mpSheet(isNew ? 'New dish' : d.name_it, body);
}

// The costing block: selling price + Excel cost sheet(s) + the send / Costed
// controls. Shown on an Approved or Costing dish. Chefs upload + send; the cost
// controller marks Costed and notes the Simphony input.
function mpCostingBlock(d){
  var canEdit = mpCanAuthor();
  var isCC = mpIsCostController();
  var files = mpDishFilesFor(d.id);
  return '<div class="mp-costing">' +
    '<div class="mp-card-h">Costing</div>' +

    '<label class="mp-lab">Selling price <em>(what it sells for on the menu)</em></label>' +
    (canEdit
      ? '<input class="mp-in" id="mpf-price" maxlength="' + MP_MAX_PRICE + '" value="' + mpEsc(d.selling_price || '') + '" placeholder="e.g. AED 120"/>'
      : '<div class="mp-readval">' + (d.selling_price ? mpEsc(d.selling_price) : '<em>not set</em>') + '</div>') +

    '<label class="mp-lab">Cost sheet <em>(Excel)</em></label>' +
    (files.length
      ? '<div class="mp-files">' + files.map(function(f){
          return '<div class="mp-file">' +
            '<a class="mp-file-open" href="' + mpEsc(mpPublicUrl(f.file_path)) + '" target="_blank" rel="noopener">' +
              '<span class="mp-file-ic ' + mpFileIcon(f.mime, f.file_name).toLowerCase() + '">' + mpFileIcon(f.mime, f.file_name) + '</span>' +
              '<span class="mp-file-meta"><span class="mp-file-name">' + mpEsc(f.file_name) + '</span>' +
              '<span class="mp-file-sub">' + mpEsc(mpFileSize(f.size_bytes)) + (f.uploaded_by ? ' · ' + mpEsc(f.uploaded_by.split(' ')[0]) : '') + '</span></span></a>' +
            (canEdit ? '<button class="mp-file-x" title="Remove" onclick="mpRemoveDishFile(\'' + d.id + '\',\'' + f.id + '\')">&times;</button>' : '') +
          '</div>';
        }).join('') + '</div>'
      : '<div class="mp-empty">No cost sheet yet.</div>') +
    (canEdit ? '<button class="mp-btn ghost" onclick="mpPickDishFile(\'' + d.id + '\')">&#128206; Upload Excel cost sheet</button>' : '') +

    // costed state
    (d.costing_status === 'costed'
      ? '<div class="mp-banner ok" style="margin-top:10px"><strong>Costed &#10003;</strong>' +
          (d.costed_by ? ' by ' + mpEsc(d.costed_by) : '') + (d.costed_at ? ' · ' + mpEsc(mpDateLabel(d.costed_at)) : '') +
          (d.costing_note ? '<br/>' + mpEsc(d.costing_note) : '') + '</div>'
      : d.costing_status === 'sent'
        ? '<div class="mp-fine" style="margin-top:8px">Sent to the cost controller — waiting for review.</div>'
        : '') +

    // actions
    (isCC
      ? '<div class="mp-sheet-actions"><button class="mp-btn go" onclick="mpMarkCosted(\'' + d.id + '\')">' + (d.costing_status === 'costed' ? 'Update costed note' : 'Mark Costed ✓') + '</button></div>'
      : canEdit && files.length
        ? '<div class="mp-sheet-actions"><button class="mp-btn go" onclick="mpCloseSheet();mpSendCosting(\'' + d.id + '\')">Send this to the cost controller</button></div>'
        : '') +
  '</div>';
}

// Downscale on the device before saving. A raw phone photo is 3–6MB; this lands
// around 40–80KB, which is what makes a photo-per-dish affordable at all.
let mpPendingPhoto;           // undefined = untouched · null = remove · string = new
function mpPickPhoto(input){
  var f = input.files && input.files[0];
  if (!f) return;
  var rd = new FileReader();
  rd.onload = function(){
    var img = new Image();
    img.onload = function(){
      var max = 720, w = img.width, h = img.height;
      if (w > h && w > max){ h = Math.round(h * max / w); w = max; }
      else if (h >= w && h > max){ w = Math.round(w * max / h); h = max; }
      var c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      mpPendingPhoto = c.toDataURL('image/jpeg', 0.65);
      var prev = document.getElementById('mpf-prev');
      if (prev){
        if (prev.tagName === 'IMG'){ prev.src = mpPendingPhoto; }
        else { var i2 = document.createElement('img'); i2.className = 'mp-photo-prev'; i2.id = 'mpf-prev'; i2.src = mpPendingPhoto; prev.replaceWith(i2); }
      }
    };
    img.onerror = function(){ mpToast('Could not read that photo. Try another one.', true); };
    img.src = rd.result;
  };
  rd.onerror = function(){ mpToast('Could not read that photo. Try another one.', true); };
  rd.readAsDataURL(f);
}
function mpDropPhoto(){
  mpPendingPhoto = null;
  var prev = document.getElementById('mpf-prev');
  if (prev && prev.tagName === 'IMG'){
    var dv = document.createElement('div'); dv.className = 'mp-photo-prev empty'; dv.id = 'mpf-prev'; dv.textContent = 'no photo';
    prev.replaceWith(dv);
  }
}

async function mpSaveDish(id, btn){
  var name = (document.getElementById('mpf-name').value || '').trim();
  var section = document.getElementById('mpf-section').value || '';
  if (!name){ mpToast('Give the dish a name first.', true); document.getElementById('mpf-name').focus(); return; }
  if (!section){ mpToast('Choose a section first.', true); document.getElementById('mpf-section').focus(); return; }
  var free = mpLock(btn); if (!free) return;
  try {
    var pick = function(wrapId){
      var w = document.getElementById(wrapId);
      return w ? [].slice.call(w.querySelectorAll('.mp-pill.on')).map(function(b){ return b.getAttribute('data-v'); }) : [];
    };
    var priceEl = document.getElementById('mpf-price');   // only present on a Costing dish
    var row = {
      name_it: name,
      section: section,
      description_en: (document.getElementById('mpf-desc').value || '').trim() || null,
      for_menus: pick('mpf-menus'),
      allergens: pick('mpf-allerg'),
      notes: ((document.getElementById('mpf-notes') || {}).value || '').trim() || null,
      updated_at: new Date().toISOString(),
      updated_by: mpMe.name
    };
    if (priceEl) row.selling_price = (priceEl.value || '').trim() || null;
    var res, dishId = id;
    if (id){
      res = await sb.from('menu_plan_dishes').update(row).eq('id', id);
    } else {
      row.created_by = mpMe.name;
      row.status = 'Idea';
      res = await sb.from('menu_plan_dishes').insert(row).select().single();
      if (res && res.data) dishId = res.data.id;
    }
    if (mpErr(res, 'the dish')) return;

    if (dishId && mpPendingPhoto !== undefined){
      if (mpPendingPhoto === null){
        await sb.from('menu_plan_dish_photos').delete().eq('dish_id', dishId);
        delete mpPhotos[dishId];
      } else {
        var pr = await sb.from('menu_plan_dish_photos')
          .upsert({ dish_id:dishId, data_url:mpPendingPhoto, updated_by:mpMe.name, updated_at:new Date().toISOString() }, { onConflict:'dish_id' });
        if (!mpErr(pr, 'the photo')) mpPhotos[dishId] = mpPendingPhoto;
      }
    }
    mpPendingPhoto = undefined;
    mpCloseSheet();
    await mpLoadAll();
    mpRender();
    mpToast(id ? 'Saved' : name + ' added');
  } finally { free(); }
}
async function mpDeleteDish(id){
  var d = mpDishes.find(function(x){ return x.id === id; });
  var nc = mpCommentsFor('dish', id).length;
  var ok = await mpConfirm('Delete “' + (d ? d.name_it : 'this dish') + '”?',
    'It disappears for everyone, and from any tasting it was attached to' +
    (nc ? ', and takes ' + nc + ' comment' + (nc === 1 ? '' : 's') + ' on it with it' : '') +
    '. This cannot be undone. If you just want it off the board, set it to Retired instead.',
    'Delete');
  if (!ok) return;
  var res = await sb.from('menu_plan_dishes').delete().eq('id', id);
  if (mpErr(res, 'the delete')) return;
  // comments carry no foreign key, so nothing cascades — clear the thread here
  // or it survives invisibly forever.
  if (nc) await sb.from('menu_plan_comments').delete().eq('target_type', 'dish').eq('target_id', id);
  mpCloseSheet();
  await mpLoadAll(); mpRender(); mpToast('Deleted');
}

// ── cost-sheet upload (Excel), same Storage model as the menu documents ─────
function mpPickDishFile(dishId){
  var inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.xls,.xlsx,.xlsm,.csv,.numbers,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,' + MP_DOC_TYPES;
  inp.style.display = 'none';
  inp.onchange = function(){ var f = inp.files && inp.files[0]; inp.remove(); if (f) mpUploadDishFile(dishId, f); };
  document.body.appendChild(inp);
  inp.click();
}
async function mpUploadDishFile(dishId, file){
  if (file.size > MP_MAX_FILE_MB * 1048576){
    mpToast('That file is ' + mpFileSize(file.size) + ' — the limit is ' + MP_MAX_FILE_MB + ' MB.', true); return;
  }
  mpToast('Uploading ' + file.name + '…');
  var safe = file.name.replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_').slice(-80);
  var rand = (self.crypto && crypto.randomUUID) ? crypto.randomUUID().slice(0, 8) : String(Math.abs(Date.now() % 1e8));
  var path = 'dish/' + dishId + '/' + rand + '-' + safe;
  if (!sb.storage || !sb.storage.from){ mpToast('File storage is not available in this build.', true); return; }
  var up = await sb.storage.from(MP_BUCKET).upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
  if (up && up.error){
    var msg = String(up.error.message || up.error);
    mpToast(msg.toLowerCase().indexOf('bucket') >= 0
      ? 'The "' + MP_BUCKET + '" storage bucket is not set up yet — run the storage section of menu-plan-schema.sql.'
      : 'Upload failed: ' + msg, true);
    return;
  }
  var row = { dish_id:dishId, file_name:file.name, file_path:path, mime:file.type || null, size_bytes:file.size || null, uploaded_by:mpMe.name, created_at:new Date().toISOString() };
  var res = await sb.from('menu_plan_dish_files').insert(row).select().single();
  if (res && res.error){ try { await sb.storage.from(MP_BUCKET).remove([path]); } catch(e){} mpErr(res, 'the cost sheet'); return; }
  (mpDishFiles[dishId] = mpDishFiles[dishId] || []).push(res.data || row);
  // Re-open the dish so the new sheet shows in the costing block.
  var d = mpDishes.find(function(x){ return x.id === dishId; });
  if (d) mpDishForm(d);
  mpToast('Cost sheet attached');
}
async function mpRemoveDishFile(dishId, fileId){
  var f = mpDishFilesFor(dishId).find(function(x){ return x.id === fileId; });
  if (!f) return;
  var ok = await mpConfirm('Remove “' + f.file_name + '”?', 'It comes off this dish for everyone. The dish itself is untouched.', 'Remove');
  if (!ok) return;
  var res = await sb.from('menu_plan_dish_files').delete().eq('id', fileId);
  if (mpErr(res, 'the cost sheet')) return;
  try { if (sb.storage && sb.storage.from) await sb.storage.from(MP_BUCKET).remove([f.file_path]); } catch(e){}
  mpDishFiles[dishId] = mpDishFilesFor(dishId).filter(function(x){ return x.id !== fileId; });
  var d = mpDishes.find(function(x){ return x.id === dishId; });
  if (d) mpDishForm(d);
  mpToast('Removed');
}

// ── send cost sheets to the cost controller (one dish or a group) ───────────
function mpSendCosting(preselectId){
  // Everything ready to cost = has a sheet, and is Approved or in Costing.
  var pool = mpDishes.filter(function(d){ return (d.status === 'Approved' || d.status === 'Costing') && mpDishFilesFor(d.id).length; });
  if (!pool.length){ mpToast('Nothing to send yet — a dish needs a cost sheet first.', true); return; }
  var pre = preselectId ? [preselectId] : pool.map(function(d){ return d.id; });
  mpSheet('Send to cost controller',
    '<div class="mp-hint">Tick the dishes to send. ' + mpEsc((mpMembers.find(function(m){return m.role==='cost_controller';})||{}).name || 'The cost controller') + ' gets the cost sheets and selling prices to review and input into Simphony.</div>' +
    '<div class="mp-sendlist">' + pool.map(function(d){
      var noPrice = !d.selling_price;
      return '<label class="mp-sendrow">' +
        '<input type="checkbox" class="mp-sendck" value="' + d.id + '"' + (pre.indexOf(d.id) >= 0 ? ' checked' : '') + '/>' +
        '<span class="mp-sendmeta"><span class="mp-sendname">' + mpEsc(d.name_it) + '</span>' +
        '<span class="mp-sendsub">' + mpEsc(d.section) + ' · ' + mpDishFilesFor(d.id).length + ' sheet(s) · ' +
          (noPrice ? '<em class="mp-warn">no selling price</em>' : 'price ' + mpEsc(d.selling_price)) + '</span></span>' +
      '</label>';
    }).join('') + '</div>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpDoSendCosting()">Send</button>' +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">Cancel</button>' +
    '</div>');
}
async function mpDoSendCosting(){
  var ids = [].slice.call(document.querySelectorAll('.mp-sendck:checked')).map(function(c){ return c.value; });
  if (!ids.length){ mpToast('Tick at least one dish.', true); return; }
  var dishes = ids.map(function(id){ return mpDishes.find(function(x){ return x.id === id; }); }).filter(Boolean);
  var cc = mpMembers.filter(function(m){ return m.role === 'cost_controller' && m.email; });
  if (!cc.length){ mpToast('No cost controller email is set.', true); return; }
  var chefs = mpMembers.filter(function(m){ return m.role === 'chef' && m.email; }).map(function(m){ return m.email; });

  mpCloseSheet();
  mpToast('Sending…');
  try {
    var r = await fetch(SUPABASE_URL + '/functions/v1/send-stock-take', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + SUPABASE_KEY },
      body: JSON.stringify({
        to: cc.map(function(m){ return m.email; }),
        cc: chefs,
        subject: 'Cost sheets for review — ' + dishes.length + ' dish' + (dishes.length === 1 ? '' : 'es'),
        html: mpCostingEmailHtml(dishes)
      })
    });
    if (!r.ok) throw new Error('send failed');
  } catch(e){
    mpToast('Could not send the email. The dishes were not marked sent.', true);
    return;
  }
  // mark each as sent + move Approved dishes into Costing
  for (var i = 0; i < dishes.length; i++){
    var patch = { costing_status:'sent', updated_at:new Date().toISOString(), updated_by:mpMe.name };
    if (dishes[i].status === 'Approved') patch.status = 'Costing';
    await sb.from('menu_plan_dishes').update(patch).eq('id', dishes[i].id);
  }
  await mpLoadAll(); mpRender();
  mpToast('Sent ' + dishes.length + ' to the cost controller');
}
function mpCostingEmailHtml(dishes){
  return '<div style="font-family:Georgia,serif;color:#2C2422;max-width:760px">' +
    '<h2 style="color:#450207;font-weight:400;margin:0 0 4px">Cost sheets for review</h2>' +
    '<p style="font-size:13px;color:#6a5c4a;margin:0 0 16px">' + mpEsc(mpMe.name) + ' sent ' + dishes.length + ' dish' + (dishes.length === 1 ? '' : 'es') +
      ' for costing. Selling prices and the Excel cost sheet(s) are below — please review and input into Simphony.</p>' +
    '<table style="border-collapse:collapse;width:100%">' +
      '<tr>' + ['Dish','Section','Selling price','Cost sheet'].map(function(h){
        return '<th style="border:1px solid #d8cbb6;padding:6px 9px;font-size:11px;text-align:left">' + h + '</th>'; }).join('') + '</tr>' +
      dishes.map(function(d){
        var links = mpDishFilesFor(d.id).map(function(f){ return '<a href="' + mpEsc(mpPublicUrl(f.file_path)) + '" style="color:#450207">' + mpEsc(f.file_name) + '</a>'; }).join('<br/>') || '—';
        return '<tr>' +
          '<td style="border:1px solid #d8cbb6;padding:6px 9px;font-size:12px"><b>' + mpEsc(d.name_it) + '</b></td>' +
          '<td style="border:1px solid #d8cbb6;padding:6px 9px;font-size:12px">' + mpEsc(d.section) + '</td>' +
          '<td style="border:1px solid #d8cbb6;padding:6px 9px;font-size:12px">' + mpEsc(d.selling_price || '—') + '</td>' +
          '<td style="border:1px solid #d8cbb6;padding:6px 9px;font-size:12px">' + links + '</td>' +
        '</tr>';
      }).join('') +
    '</table></div>';
}

// ── cost controller marks a dish Costed + notes the Simphony input ──────────
function mpMarkCosted(dishId){
  var d = mpDishes.find(function(x){ return x.id === dishId; });
  if (!d) return;
  mpSheet('Mark “' + d.name_it + '” Costed',
    '<label class="mp-lab">Note <em>(optional — e.g. entered in Simphony, food cost %)</em></label>' +
    '<textarea class="mp-in" id="mpcc-note" rows="3" maxlength="' + MP_MAX_NOTE + '" placeholder="Costed and entered in Simphony">' + mpEsc(d.costing_note || '') + '</textarea>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpSaveCosted(\'' + dishId + '\')">Mark Costed ✓</button>' +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">Cancel</button>' +
    '</div>');
}
async function mpSaveCosted(dishId){
  var note = (document.getElementById('mpcc-note').value || '').trim() || null;
  var res = await sb.from('menu_plan_dishes').update({
    costing_status:'costed', costing_note:note, costed_by:mpMe.name, costed_at:new Date().toISOString(),
    updated_at:new Date().toISOString(), updated_by:mpMe.name
  }).eq('id', dishId);
  if (mpErr(res, 'the costing')) return;
  mpCloseSheet(); await mpLoadAll(); mpRender(); mpToast('Marked Costed ✓');
}

// ══ 3. MENU CALENDAR ═══════════════════════════════════════════════════════
function mpRenderCalendar(){
  var isList = mpCalView === 'list';
  return '<div class="mp-body">' +
    '<div class="mp-calhead">' +
      '<div class="mp-hint">' + (isList
        ? 'Each menu and when it happens. Tap a month to change it, or add one.' +
          (mpCanAuthor() ? ' Drag the &#10086; to put the menus in the order you want — or tap it.' : '')
        : 'Rows are menus, columns are months. Tap a square to set it; tap a menu name to edit or delete.') + '</div>' +
      '<span class="mp-viewtog">' +
        '<button class="' + (isList ? 'on' : '') + '" onclick="mpSetCalView(\'list\')">List</button>' +
        '<button class="' + (isList ? '' : 'on') + '" onclick="mpSetCalView(\'grid\')">Wide grid</button>' +
      '</span>' +
    '</div>' +
    '<div class="mp-legend">' + MP_CELL_STATES.map(function(s){
      return '<span class="mp-leg"><i class="mp-sw c-' + s.toLowerCase() + '"></i>' + s + '</span>';
    }).join('') + '<span class="mp-leg"><i class="mp-sw c-none"></i>Nothing</span></div>' +
    (isList ? mpCalendarList() : mpCalendarGrid()) +
    (mpMenus.length === 0 ? '<div class="mp-empty big">No menus yet — add one below.</div>' : '') +
    (mpCanAuthor() ? '<button class="mp-big ghost" onclick="mpAddMenu()">+ Add a menu</button>' : '') +
  '</div>';
}
function mpSetCalView(v){ mpCalView = v; mpRender(); }

// Per-menu list — the calm, phone-first view. One card per menu (grouped menus
// keep the A/B/C dropdown); its scheduled months shown as tappable chips.
function mpCalendarList(){
  var canOrder = mpCanAuthor();
  return '<div class="mp-callist" id="mp-callist">' + mpMenuRows().map(function(row){
    var menu = row.group ? mpSelVariant(row) : row.menu;
    var key = row.group ? 'g:' + row.group : 'm:' + row.menu.id;
    var cells = mpCal.filter(function(c){ return c.menu_id === menu.id; })
      .map(function(c){ return { c:c, i: MP_MONTHS.findIndex(function(m){ return m.key === String(c.month).slice(0,10); }) }; })
      .filter(function(x){ return x.i >= 0; })
      .sort(function(a,b){ return a.i - b.i; });
    return '<div class="mp-calrow" data-row="' + mpEsc(key) + '">' +
      (canOrder ? '<span class="mp-grip" title="Drag to reorder — or tap to move it" onpointerdown="mpGripDown(event,\'' + mpEsc(key) + '\')">&#10086;</span>' : '') +
      '<div class="mp-calrow-h">' +
        (row.group
          ? '<span class="mp-cal-group"><button class="mp-cal-namebtn" onclick="mpGroupManage(\'' + mpEsc(row.group) + '\')">' + mpEsc(row.group) + '</button>' +
            '<select class="mp-varsel" onchange="mpSelectVariant(\'' + mpEsc(row.group) + '\', this.value)">' +
              row.variants.map(function(v){ return '<option value="' + v.id + '"' + (v.id === menu.id ? ' selected' : '') + '>' + mpEsc(v.variant_label || v.name) + '</option>'; }).join('') +
            '</select></span>'
          : '<button class="mp-cal-namebtn" onclick="mpMenuActions(\'' + menu.id + '\')">' + mpEsc(menu.name) + '</button>') +
        (mpCanAuthor() ? '<button class="mp-btn ghost small" onclick="mpMenuLifecycle(\'' + menu.id + '\')">&#128197; Schedule</button>' : '') +
      '</div>' +
      '<div class="mp-calchips">' +
        (cells.length
          ? cells.map(function(x){
              var day = mpCellDayLabel(x.c);
              return '<button class="mp-calchip c-' + x.c.state.toLowerCase() + '" onclick="mpCellMenu(\'' + menu.id + '\',\'' + MP_MONTHS[x.i].key + '\')">' +
                MP_MON_NAMES[MP_MONTHS[x.i].m] + ' · ' + x.c.state + (day ? ' ' + day : '') + '</button>';
            }).join('')
          : '<span class="mp-fine">Nothing scheduled yet.</span>') +
        (mpCanAuthor() ? '<button class="mp-calchip add" onclick="mpAddCalMonth(\'' + menu.id + '\')">+ month</button>' : '') +
      '</div>' +
    '</div>';
  }).join('') + '</div>';
}
// ── put the menus in the order you want them (list view) ───────────────────
// Same grip-and-drag as the Fish Display board, on Pointer Events so a finger
// works exactly like a mouse. A grip that is TAPPED rather than dragged opens a
// move sheet instead — on a phone, asking for a precise drag is asking for a
// mis-tap. A grouped row (Set Menu A/B/C) moves as one block.
let mpDrag = null;   // { key, rowEl, container, startY, moved }
function mpGripDown(e, key){
  if (e.button && e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  var container = document.getElementById('mp-callist'); if (!container) return;
  var rowEl = container.querySelector('.mp-calrow[data-row="' + key + '"]'); if (!rowEl) return;
  mpDrag = { key:key, rowEl:rowEl, container:container, startY:e.clientY, moved:false };
  rowEl.classList.add('mp-dragging');
  document.body.classList.add('mp-dragging-active');
  document.addEventListener('pointermove', mpGripMove, { passive:false });
  document.addEventListener('pointerup', mpGripUp, true);
  document.addEventListener('pointercancel', mpGripUp, true);
}
function mpGripMove(e){
  if (!mpDrag) return;
  e.preventDefault();                                   // stop the page scrolling under the finger
  if (Math.abs(e.clientY - mpDrag.startY) > 6) mpDrag.moved = true;
  var container = mpDrag.container, rowEl = mpDrag.rowEl, y = e.clientY;
  var before = null, closest = -Infinity;               // nearest row whose mid-point is below the pointer
  [].forEach.call(container.querySelectorAll('.mp-calrow[data-row]'), function(r){
    if (r === rowEl) return;
    var box = r.getBoundingClientRect();
    var off = y - (box.top + box.height / 2);
    if (off < 0 && off > closest){ closest = off; before = r; }
  });
  if (before){ if (rowEl.nextSibling !== before) container.insertBefore(rowEl, before); }
  else container.appendChild(rowEl);
}
function mpGripUp(){
  if (!mpDrag) return;
  var d = mpDrag; mpDrag = null;
  document.removeEventListener('pointermove', mpGripMove, { passive:false });
  document.removeEventListener('pointerup', mpGripUp, true);
  document.removeEventListener('pointercancel', mpGripUp, true);
  d.rowEl.classList.remove('mp-dragging');
  document.body.classList.remove('mp-dragging-active');
  if (!d.moved){ mpMoveMenuSheet(d.key); return; }       // a tap, not a drag
  mpSaveMenuOrder([].map.call(d.container.querySelectorAll('.mp-calrow[data-row]'), function(r){ return r.getAttribute('data-row'); }));
}
// The tap route: move one place at a time, or straight to the top or bottom.
function mpMoveMenuSheet(key){
  var keys = mpMenuRows().map(mpRowKey);
  var i = keys.indexOf(key);
  if (i < 0) return;
  var label = key.indexOf('g:') === 0 ? key.slice(2) : (mpMenus.find(function(m){ return m.id === key.slice(2); }) || {}).name;
  var btn = function(to, txt, off){
    return '<button class="mp-statusrow"' + (off ? ' disabled' : ' onclick="mpMoveMenuTo(\'' + mpEsc(key) + '\',' + to + ')"') +
      '><span class="mp-statusnote">' + txt + '</span></button>';
  };
  mpSheet('Move ' + (label || 'this menu'),
    '<div class="mp-hint">It is number ' + (i + 1) + ' of ' + keys.length + '. This is the order everyone sees, on the calendar and in the plan.</div>' +
    '<div class="mp-statuslist">' +
      btn(0, '<strong>To the top</strong>', i === 0) +
      btn(i - 1, '<strong>Up one</strong> — above ' + mpEsc(mpRowLabel(keys[i - 1])), i === 0) +
      btn(i + 1, '<strong>Down one</strong> — below ' + mpEsc(mpRowLabel(keys[i + 1])), i === keys.length - 1) +
      btn(keys.length - 1, '<strong>To the bottom</strong>', i === keys.length - 1) +
    '</div>');
}
function mpRowKey(row){ return row.group ? 'g:' + row.group : 'm:' + row.menu.id; }
function mpRowLabel(key){
  if (!key) return '';
  if (key.indexOf('g:') === 0) return key.slice(2);
  var m = mpMenus.find(function(x){ return x.id === key.slice(2); });
  return m ? m.name : '';
}
function mpMoveMenuTo(key, index){
  var keys = mpMenuRows().map(mpRowKey);
  var from = keys.indexOf(key);
  if (from < 0) return;
  keys.splice(from, 1);
  keys.splice(Math.max(0, Math.min(keys.length, index)), 0, key);
  mpCloseSheet();
  mpSaveMenuOrder(keys);
}
// Renumber in tens so a later insert has room; a grouped row's variants keep
// their A/B/C order inside the block. Only the rows that actually moved get a
// write.
async function mpSaveMenuOrder(keys){
  var want = {}, n = 0;
  keys.forEach(function(key){
    n++;
    if (key.indexOf('g:') === 0){
      mpMenus.filter(function(m){ return m.menu_group === key.slice(2); })
        .sort(function(a, b){ return (a.variant_label || '') < (b.variant_label || '') ? -1 : 1; })
        .forEach(function(v, i){ want[v.id] = n * 10 + i; });
    } else {
      want[key.slice(2)] = n * 10;
    }
  });
  var changed = mpMenus.filter(function(m){ return want[m.id] != null && m.sort_order !== want[m.id]; });
  if (!changed.length){ mpRender(); return; }
  changed.forEach(function(m){ m.sort_order = want[m.id]; });
  mpRender();
  var res = await Promise.all(changed.map(function(m){
    return sb.from('menu_plan_menus').update({ sort_order:m.sort_order, updated_at:new Date().toISOString(), updated_by:mpMe.name }).eq('id', m.id);
  }));
  if (res.some(function(r){ return r && r.error; })){
    mpToast('Could not save the new order — putting it back.', true);
    await mpLoadAll(); mpRender(); return;
  }
  mpToast('Order saved');
}

// Pick which month to set for a menu (used by the list view's "+ month").
function mpAddCalMonth(menuId){
  var menu = mpMenus.find(function(m){ return m.id === menuId; });
  mpSheet((menu ? mpEsc(menu.name) : '') + ' — which month?',
    '<div class="mp-monthgrid">' + MP_MONTHS.map(function(m){
      var set = mpCellObj(menuId, m.key);
      return '<button class="mp-monthbtn' + (set ? ' set c-' + set.state.toLowerCase() : '') + '" onclick="mpCloseSheet();mpCellMenu(\'' + menuId + '\',\'' + m.key + '\')">' +
        MP_MON_NAMES[m.m] + '<em>' + String(m.y).slice(2) + '</em></button>';
    }).join('') + '</div>');
}

// The shared grid — used by the Calendar tab AND The Plan. Grouped menus
// (Set Menu A/B/C) show as ONE row with an A/B/C dropdown; the row's squares
// are the selected variant's.
function mpCalendarGrid(){
  var rows = mpMenuRows();
  return '<div class="mp-calwrap"><table class="mp-cal">' +
    '<thead><tr><th class="mp-cal-menu">Menu</th>' +
      MP_MONTHS.map(function(m){ return '<th><span>' + MP_MON_NAMES[m.m] + '</span><em>' + String(m.y).slice(2) + '</em></th>'; }).join('') +
    '</tr></thead>' +
    '<tbody>' +
      rows.map(function(row){
        var menu = row.group ? mpSelVariant(row) : row.menu;
        var nameCell;
        if (row.group){
          nameCell = '<div class="mp-cal-group">' +
            '<button class="mp-cal-namebtn" onclick="mpGroupManage(\'' + mpEsc(row.group) + '\')">' + mpEsc(row.group) + '</button>' +
            '<select class="mp-varsel" onchange="mpSelectVariant(\'' + mpEsc(row.group) + '\', this.value)">' +
              row.variants.map(function(v){ return '<option value="' + v.id + '"' + (v.id === menu.id ? ' selected' : '') + '>' + mpEsc(v.variant_label || v.name) + '</option>'; }).join('') +
            '</select></div>';
        } else {
          nameCell = '<button class="mp-cal-namebtn" onclick="mpMenuActions(\'' + menu.id + '\')">' + mpEsc(menu.name) + '</button>';
        }
        return '<tr><th class="mp-cal-menu">' + nameCell + '</th>' +
          MP_MONTHS.map(function(m){
            var c = mpCellObj(menu.id, m.key);
            var day = mpCellDayLabel(c);
            return '<td><button class="mp-cell c-' + (c ? c.state.toLowerCase() : 'none') + '"' +
              ' onclick="mpCellMenu(\'' + menu.id + '\',\'' + m.key + '\')"' +
              ' title="' + mpEsc(menu.name + ' · ' + mpMonthLabel(m.key) + (c ? ' · ' + c.state + (day ? ' ' + day : '') : '')) + '">' +
              (c ? MP_CELL_CODE[c.state] + (day ? '<small>' + day + '</small>' : '') : '') + '</button></td>';
          }).join('') +
        '</tr>';
      }).join('') +
    '</tbody>' +
  '</table></div>';
}
function mpCellObj(menuId, monthKey){
  return mpCal.find(function(c){ return c.menu_id === menuId && String(c.month).slice(0,10) === monthKey; }) || null;
}
function mpCellDayLabel(c){
  if (!c || !c.date_from) return '';
  var a = String(c.date_from).slice(8,10).replace(/^0/,'');
  if (c.date_to && String(c.date_to).slice(0,10) !== String(c.date_from).slice(0,10)){
    return a + '–' + String(c.date_to).slice(8,10).replace(/^0/,'');
  }
  return a;
}
function mpSelectVariant(group, menuId){ mpGroupSel[group] = menuId; mpRender(); }

// Tap a menu name → edit or delete it (honours "add or delete items" on the grid).
function mpMenuActions(menuId){
  var m = mpMenus.find(function(x){ return x.id === menuId; });
  if (!m || !mpCanAuthor()) return;
  mpSheet(m.name,
    '<div class="mp-statuslist">' +
      '<button class="mp-statusrow" onclick="mpCloseSheet();mpMenuLifecycle(\'' + menuId + '\')"><span class="mp-statusnote"><strong>Set the whole schedule</strong> — Develop, Testing, Photoshooting, Launch, one sheet</span></button>' +
      '<button class="mp-statusrow" onclick="mpCloseSheet();mpDuplicateMenu(\'' + menuId + '\')"><span class="mp-statusnote"><strong>Duplicate this menu</strong> — start a new one from its structure and price</span></button>' +
      '<button class="mp-statusrow" onclick="mpCloseSheet();mpEditMenu(\'' + menuId + '\')"><span class="mp-statusnote"><strong>Edit this menu</strong> — identity, price, dates</span></button>' +
      '<button class="mp-statusrow" onclick="mpCloseSheet();mpDeleteMenu(\'' + menuId + '\')"><span class="mp-statusnote"><strong>Delete this menu</strong> — remove it from the plan</span></button>' +
    '</div>');
}
function mpGroupManage(group){
  var variants = mpMenus.filter(function(m){ return m.menu_group === group; })
    .sort(function(a,b){ return (a.variant_label || '') < (b.variant_label || '') ? -1 : 1; });
  mpSheet(group + ' — variants',
    '<div class="mp-hint">Each variant (' + variants.map(function(v){ return mpEsc(v.variant_label || v.name); }).join(', ') + ') has its own dishes and its own schedule.</div>' +
    '<div class="mp-statuslist">' +
      variants.map(function(v){
        return '<div class="mp-varrow">' +
          '<span class="mp-varlbl">' + mpEsc(v.variant_label || '?') + '</span>' +
          '<span class="mp-varname">' + mpEsc(v.name) + '</span>' +
          '<button class="mp-btn ghost small" onclick="mpCloseSheet();mpMenuLifecycle(\'' + v.id + '\')">Schedule</button>' +
          '<button class="mp-btn ghost small" onclick="mpCloseSheet();mpEditMenu(\'' + v.id + '\')">Edit</button>' +
          '<button class="mp-btn ghost small danger" onclick="mpCloseSheet();mpDeleteMenu(\'' + v.id + '\')">Delete</button>' +
        '</div>';
      }).join('') +
    '</div>' +
    (mpCanAuthor() ? '<button class="mp-btn go" onclick="mpAddVariant(\'' + mpEsc(group) + '\',this)">+ Add a variant</button>' : ''));
}

// ── one-sheet menu lifecycle: Develop/Testing/Photoshooting/Launch in ONE save,
// instead of the month→phase→save sheet repeated once per stage. "Live" and
// "Changing" stay on the per-cell editor since they're ongoing ranges, not a
// single milestone month. ─────────────────────────────────────────────────
const MP_LIFECYCLE_STATES = ['Develop', 'Testing', 'Photoshooting', 'Launch'];
function mpMenuLifecycle(menuId){
  var menu = mpMenus.find(function(m){ return m.id === menuId; });
  if (!menu || !mpCanAuthor()) return;
  var current = {};
  MP_LIFECYCLE_STATES.forEach(function(s){
    var hit = mpCal.find(function(c){ return c.menu_id === menuId && c.state === s; });
    current[s] = hit ? String(hit.month).slice(0, 10) : '';
  });
  mpSheet('Schedule ' + menu.name,
    '<div class="mp-hint">Set the whole timeline at once. Leave any stage blank to skip it — one Save for the lot.</div>' +
    MP_LIFECYCLE_STATES.map(function(s){
      return '<label class="mp-lab"><i class="mp-swatch c-' + s.toLowerCase() + '"></i> ' + s + '</label>' +
        '<select class="mp-in" id="mpml-' + s + '">' +
          '<option value="">&mdash; not set &mdash;</option>' +
          MP_MONTHS.map(function(m){ return '<option value="' + m.key + '"' + (current[s] === m.key ? ' selected' : '') + '>' + MP_MON_NAMES[m.m] + ' ' + m.y + '</option>'; }).join('') +
        '</select>';
    }).join('') +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpSaveLifecycle(\'' + menuId + '\')">Save</button>' +
      '<button class="mp-btn ghost" onclick="mpSaveLifecycle(\'' + menuId + '\',true)">Save &amp; copy to other menus</button>' +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">Cancel</button>' +
    '</div>');
}
async function mpSaveLifecycle(menuId, andCopy){
  var picks = {};
  MP_LIFECYCLE_STATES.forEach(function(s){ var el = document.getElementById('mpml-' + s); picks[s] = el ? el.value : ''; });

  var usedBy = {};
  for (var s in picks){
    if (picks[s]){
      if (usedBy[picks[s]] && usedBy[picks[s]] !== s){
        mpToast('Two stages can’t share the same month — ' + usedBy[picks[s]] + ' and ' + s + ' are both set to the same one.', true);
        return;
      }
      usedBy[picks[s]] = s;
    }
  }

  var existing = mpCal.filter(function(c){ return c.menu_id === menuId && MP_LIFECYCLE_STATES.indexOf(c.state) >= 0; });
  var ops = [];
  MP_LIFECYCLE_STATES.forEach(function(s){
    var wantMonth = picks[s];
    var have = existing.find(function(c){ return c.state === s; });
    if (wantMonth){
      if (have && String(have.month).slice(0, 10) === wantMonth) return;   // unchanged
      if (have) ops.push(sb.from('menu_plan_calendar').delete().eq('id', have.id));
      ops.push(sb.from('menu_plan_calendar').upsert(
        { menu_id: menuId, month: wantMonth, state: s, updated_by: mpMe.name, updated_at: new Date().toISOString() },
        { onConflict: 'menu_id,month' }));
    } else if (have){
      ops.push(sb.from('menu_plan_calendar').delete().eq('id', have.id));
    }
  });
  if (ops.length){
    var results = await Promise.all(ops);
    if (results.some(function(r){ return r && r.error; })){ mpToast('Could not save the schedule. Check the connection.', true); return; }
  }
  mpCloseSheet();
  await mpLoadAll();
  if (andCopy) mpCopySchedule(menuId);
  else { mpRender(); mpToast('Schedule saved'); }
}
// "Copy schedule to…" — duplicate the just-saved Develop/Testing/Photoshooting/
// Launch months onto other menus in one go, for a run of near-identical menus
// (the four Festive menus, the corporate lunches).
function mpCopySchedule(sourceMenuId){
  var source = mpMenus.find(function(m){ return m.id === sourceMenuId; });
  var targets = mpMenus.filter(function(m){ return m.id !== sourceMenuId; });
  mpSheet('Copy the schedule to…',
    '<div class="mp-hint">Pick the menus that should follow ' + mpEsc(source ? source.name : 'this menu') + '’s Develop / Testing / Photoshooting / Launch months.</div>' +
    '<div class="mp-pills" id="mpcs-pick">' +
      targets.map(function(m){ return '<button type="button" class="mp-pill" data-v="' + m.id + '" onclick="this.classList.toggle(\'on\')">' + mpEsc(m.name) + '</button>'; }).join('') +
    '</div>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpDoCopySchedule(\'' + sourceMenuId + '\')">Copy</button>' +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">Skip — just this menu</button>' +
    '</div>');
}
async function mpDoCopySchedule(sourceMenuId){
  var picks = [].slice.call(document.querySelectorAll('#mpcs-pick .mp-pill.on')).map(function(b){ return b.getAttribute('data-v'); });
  if (!picks.length){ mpToast('Pick at least one menu to copy to.', true); return; }
  var source = mpCal.filter(function(c){ return c.menu_id === sourceMenuId && MP_LIFECYCLE_STATES.indexOf(c.state) >= 0; });
  if (!source.length){ mpCloseSheet(); mpToast('Nothing to copy — this menu has no schedule set yet.', true); return; }
  var ops = [];
  picks.forEach(function(targetId){
    source.forEach(function(c){
      ops.push(sb.from('menu_plan_calendar').upsert(
        { menu_id: targetId, month: String(c.month).slice(0, 10), state: c.state, updated_by: mpMe.name, updated_at: new Date().toISOString() },
        { onConflict: 'menu_id,month' }));
    });
  });
  var results = await Promise.all(ops);
  mpCloseSheet();
  await mpLoadAll(); mpRender();
  mpToast(results.some(function(r){ return r && r.error; })
    ? 'Copied, but something failed to save — check the calendar.'
    : 'Copied to ' + picks.length + ' menu' + (picks.length === 1 ? '' : 's'));
}
async function mpAddVariant(group, btn){
  var free = mpLock(btn); if (!free) return;
  try {
    var variants = mpMenus.filter(function(m){ return m.menu_group === group; });
    var label = mpNextVariantLabel(variants);
    var max = mpMenus.reduce(function(a, m){ return Math.max(a, m.sort_order || 0); }, 0);
    var res = await sb.from('menu_plan_menus').insert({
      name: group + ' ' + label, menu_group: group, variant_label: label,
      change_cadence: (variants[0] && variants[0].change_cadence) || 'Quarterly',
      sort_order: max + 10, updated_by: mpMe.name
    });
    if (mpErr(res, 'the variant')) return;
    mpCloseSheet(); await mpLoadAll(); mpRender(); mpToast(group + ' ' + label + ' added');
  } finally { free(); }
}

// First Sat/Sun of the given 'YYYY-MM' — used by the "Weekend" quick-date chip.
function mpFirstWeekend(mk){
  var y = +mk.slice(0, 4), m = +mk.slice(5, 7);
  var d = new Date(y, m - 1, 1);
  while (d.getDay() !== 6) d.setDate(d.getDate() + 1);
  var sat = new Date(d), sun = new Date(d); sun.setDate(sat.getDate() + 1);
  function iso(x){ return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); }
  return { from: iso(sat), to: iso(sun) };
}
function mpSetDateInputs(from, to){
  var f = document.getElementById('mpcell-from'), t = document.getElementById('mpcell-to');
  if (f) f.value = from || ''; if (t) t.value = to || '';
}
function mpCellMenu(menuId, monthKey){
  if (!mpCanAuthor()){ mpToast('Only chefs and Francesco edit the calendar.', true); return; }
  var menu = mpMenus.find(function(m){ return m.id === menuId; });
  var c = mpCellObj(menuId, monthKey) || {};
  var mk = monthKey.slice(0,7);            // 'YYYY-MM'
  var last = new Date(+mk.slice(0,4), +mk.slice(5,7), 0).getDate();
  var min = mk + '-01', max = mk + '-' + String(last).padStart(2,'0');
  var weekend = mpFirstWeekend(mk);
  var launchInMonth = menu && menu.launch_date && String(menu.launch_date).slice(0,7) === mk;
  mpSheet(mpEsc(menu ? menu.name : '') + ' · ' + mpMonthLabel(monthKey),
    '<label class="mp-lab">What happens this month</label>' +
    '<div class="mp-pills" id="mpcell-state">' +
      MP_CELL_STATES.map(function(s){
        return '<button type="button" class="mp-pill cell' + (c.state === s ? ' on' : '') + '" data-v="' + s + '" onclick="mpPickOne(this)">' +
          '<i class="mp-swatch c-' + s.toLowerCase() + '"></i>' + s + '</button>';
      }).join('') +
    '</div>' +
    '<label class="mp-lab">Specific date <em>(optional — leave blank for the whole month)</em></label>' +
    '<div class="mp-datechips">' +
      '<button type="button" class="mp-datechip" onclick="mpSetDateInputs(\'' + mk + '-01\',\'\')">1st</button>' +
      '<button type="button" class="mp-datechip" onclick="mpSetDateInputs(\'' + mk + '-15\',\'\')">15th</button>' +
      '<button type="button" class="mp-datechip" onclick="mpSetDateInputs(\'' + weekend.from + '\',\'' + weekend.to + '\')">Weekend</button>' +
      (launchInMonth ? '<button type="button" class="mp-datechip" onclick="mpSetDateInputs(\'' + menu.launch_date + '\',\'\')">Launch day</button>' : '') +
      '<button type="button" class="mp-datechip ghost" onclick="mpSetDateInputs(\'\',\'\')">Clear</button>' +
    '</div>' +
    '<div class="mp-two">' +
      '<div><span class="mp-fine">From</span><input class="mp-in" type="date" id="mpcell-from" min="' + min + '" max="' + max + '" value="' + mpEsc((c.date_from || '').slice(0,10)) + '"/></div>' +
      '<div><span class="mp-fine">To</span><input class="mp-in" type="date" id="mpcell-to" min="' + min + '" max="' + max + '" value="' + mpEsc((c.date_to || '').slice(0,10)) + '"/></div>' +
    '</div>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpSaveCell(\'' + menuId + '\',\'' + monthKey + '\')">Save</button>' +
      (c.state ? '<button class="mp-btn ghost danger" onclick="mpSaveCell(\'' + menuId + '\',\'' + monthKey + '\',true)">Clear month</button>' : '') +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">Cancel</button>' +
    '</div>');
}
const MP_CELL_NOTE = {
  Develop:       'building the dishes this month',
  Testing:       'tasting and deciding this month',
  Photoshooting: 'photographing the dishes for the menu',
  Launch:        'the menu goes out this month',
  Live:          'running as normal',
  Changing:      'swapping dishes in and out'
};
async function mpSaveCell(menuId, monthKey, clear){
  var res;
  if (clear){
    res = await sb.from('menu_plan_calendar').delete().eq('menu_id', menuId).eq('month', monthKey);
    if (mpErr(res, 'the calendar')) return;
    mpCal = mpCal.filter(function(c){ return !(c.menu_id === menuId && String(c.month).slice(0,10) === monthKey); });
    mpCloseSheet(); mpRender(); mpToast(mpMonthLabel(monthKey) + ' cleared'); return;
  }
  var on = document.querySelector('#mpcell-state .mp-pill.on');
  if (!on){ mpToast('Pick what happens, or Clear the month.', true); return; }
  var state = on.getAttribute('data-v');
  var from  = document.getElementById('mpcell-from').value || null;
  var to    = document.getElementById('mpcell-to').value || null;
  if (to && !from){ from = to; to = null; }              // a lone "to" makes no sense
  res = await sb.from('menu_plan_calendar')
    .upsert({ menu_id:menuId, month:monthKey, state:state, date_from:from, date_to:to, updated_by:mpMe.name, updated_at:new Date().toISOString() },
            { onConflict:'menu_id,month' });
  if (mpErr(res, 'the calendar')) return;
  var ex = mpCellObj(menuId, monthKey);
  if (ex){ ex.state = state; ex.date_from = from; ex.date_to = to; }
  else mpCal.push({ menu_id:menuId, month:monthKey, state:state, date_from:from, date_to:to });
  mpCloseSheet(); mpRender();
  mpToast(mpMonthLabel(monthKey) + ' → ' + state);
}

// ══ 4. MENU BRIEFS ═════════════════════════════════════════════════════════
function mpRenderBriefs(){
  var g = mpPlanGroups();
  var mainCard = function(row){
    if (row.group){
      var m = mpSelVariant(row);
      return '<div class="mp-card menu">' +
        '<div class="mp-group-bar">' +
          '<span class="mp-group-name">' + mpEsc(row.group) + '</span>' +
          '<select class="mp-varsel" onchange="mpSelectVariant(\'' + mpEsc(row.group) + '\', this.value)">' +
            row.variants.map(function(v){ return '<option value="' + v.id + '"' + (v.id === m.id ? ' selected' : '') + '>' + mpEsc(v.variant_label ? 'Variant ' + v.variant_label : v.name) + '</option>'; }).join('') +
          '</select>' +
          (mpCanAuthor() ? '<button class="mp-btn ghost small" onclick="mpGroupManage(\'' + mpEsc(row.group) + '\')">Variants</button>' : '') +
        '</div>' +
        mpBriefInner(m) +
      '</div>';
    }
    return '<div class="mp-card menu">' + mpBriefInner(row.menu) + '</div>';
  };

  return '<div class="mp-body">' +

    // ── lane 1: MAIN MENUS — the creative work, full cards ──
    '<div class="mp-lane-h"><span class="mp-lane-title">My menus</span><span class="mp-lane-note">ongoing · you create these</span></div>' +
    (g.mains.length
      ? g.mains.map(mainCard).join('')
      : '<div class="mp-empty">No menus of your own yet — add one below.</div>') +
    (mpCanAuthor() ? '<button class="mp-big ghost" onclick="mpAddMenu()">+ Add a menu of my own</button>' : '') +

    // ── lane 2: CAMPAIGNS — a theme with its dates nested inside ──
    (g.campaigns.length
      ? '<div class="mp-lane-h camp"><span class="mp-lane-title">Campaigns</span><span class="mp-lane-note">a season · a theme · its nights</span></div>' +
        g.campaigns.map(mpCampaignCard).join('')
      : '') +

    // ── loose events (dated one-offs not tied to a season) ──
    (g.looseEvents.length
      ? '<div class="mp-lane-h camp"><span class="mp-lane-title">Events to cook for</span><span class="mp-lane-note">fixed dates · build from your dishes</span></div>' +
        '<div class="mp-card menu"><div class="mp-eventlist">' + g.looseEvents.map(mpEventRow).join('') + '</div></div>'
      : '') +
  '</div>';
}
// A campaign: theme header, the one core menu every night shares, then the
// nested date rows. The heavy creative work is the core; the nights are light.
function mpCampaignCard(b){
  var c = b.campaign, core = b.core;
  var pool = core ? mpMenuDishPool(core.name) : [];
  var approved = pool.filter(function(d){ return MP_RANK[d.status] >= 3; }).length;
  var range = (c.date_from ? mpDateLabel(c.date_from) : '') + (c.date_to ? ' – ' + mpDateLabel(c.date_to) : '');
  return '<div class="mp-card camp">' +
    '<div class="mp-camp-head">' +
      '<div class="mp-camp-eyebrow">' + mpEsc(c.season_label || 'Campaign') + '</div>' +
      '<div class="mp-camp-title">' + mpEsc(c.theme || c.title || 'Untitled campaign') + '</div>' +
      (range ? '<div class="mp-camp-range">' + mpEsc(range) + '</div>' : '') +
      (c.blurb ? '<div class="mp-camp-blurb">' + mpEsc(c.blurb) + '</div>' : '') +
    '</div>' +
    '<div class="mp-camp-body">' +
      (core
        ? '<button class="mp-camp-core" onclick="mpEditMenu(\'' + core.id + '\')">' +
            '<div><div class="mp-camp-core-t">The festive menu</div>' +
            '<div class="mp-camp-core-s">' + pool.length + ' dish' + (pool.length === 1 ? '' : 'es') + ' · ' + approved + ' approved · the core all nights share</div></div>' +
            '<span class="mp-camp-core-go">Develop &rsaquo;</span>' +
          '</button>'
        : '') +
      '<div class="mp-camp-datesh">Particular dates</div>' +
      '<div class="mp-eventlist">' +
        (b.events.length ? b.events.map(mpEventRow).join('') : '<div class="mp-empty">No dates yet.</div>') +
      '</div>' +
    '</div>' +
  '</div>';
}
// One dated event as a light row: date block, name, and the small job it needs.
function mpEventRow(m){
  var d = mpMenuEventDate(m);
  var pool = mpMenuDishPool(m.name);
  var wk = mpWeeksUntil(d);
  var dishWord = pool.length + ' dish' + (pool.length === 1 ? '' : 'es');
  var need = pool.length
    ? (m.price ? dishWord + ' · ' + mpEsc(m.price)
               : dishWord + ' chosen · set the price')
    : (wk === 0 ? 'this week · build the menu' : 'not started · pick the dishes');
  var needClass = pool.length && m.price ? 'ok' : (pool.length ? 'part' : '');
  var dd = d ? String(d).slice(8,10).replace(/^0/,'') : '';
  var mm = d ? MP_MON_NAMES[+String(d).slice(5,7)] : '';
  return '<button class="mp-eventrow" onclick="mpEventBuild(\'' + m.id + '\')">' +
    '<span class="mp-event-date">' + (d ? '<b>' + dd + '</b><em>' + mm + '</em>' : '<i class="mp-event-cal">&#128197;</i>') + '</span>' +
    '<span class="mp-event-main"><span class="mp-event-name">' + mpEsc(m.name) + '</span>' +
      '<span class="mp-event-need ' + needClass + '">' + mpEsc(need) + (wk !== null && wk > 0 ? ' · in ' + wk + ' wk' + (wk === 1 ? '' : 's') : '') + '</span></span>' +
    '<span class="mp-event-go">&rsaquo;</span>' +
  '</button>';
}
// The inner of a menu brief card (shared by standalone menus and group variants).
function mpBriefInner(m){
  var oc = mpOpenCommentCount('menu', m.id);
  var approved = mpDishes.filter(function(d){ return (d.for_menus || []).includes(m.name) && MP_RANK[d.status] >= 3; }).length;
  var pool     = mpDishes.filter(function(d){ return (d.for_menus || []).includes(m.name); }).length;
  return '<div class="mp-menu-h">' +
      '<div><div class="mp-menu-name">' + mpEsc(m.name) + '</div>' +
      '<div class="mp-menu-sub">' + mpEsc(m.change_cadence || '—') + '</div></div>' +
      '<span class="mp-mstatus s-' + (m.status || 'draft') + '">' + mpEsc(MP_MSTATUS_LABEL[m.status || 'draft']) + '</span>' +
    '</div>' +
    '<div class="mp-menu-body">' +
      (m.identity  ? '<p class="mp-menu-id">' + mpEsc(m.identity) + '</p>'   : '<p class="mp-menu-id missing">No identity yet — one line: what is this menu?</p>') +
      (m.structure ? '<p class="mp-menu-st">' + mpEsc(m.structure) + '</p>'  : '<p class="mp-menu-st missing">No structure yet.</p>') +
      '<div class="mp-menu-facts">' +
        '<span><b>' + mpEsc(m.price || '—') + '</b>price</span>' +
        '<span><b>' + (m.testing_date ? mpEsc(mpDateLabel(m.testing_date)) : '—') + '</b>testing</span>' +
        '<span><b>' + (m.launch_date  ? mpEsc(mpDateLabel(m.launch_date))  : '—') + '</b>launch</span>' +
        '<span><b>' + approved + ' / ' + pool + '</b>dishes approved</span>' +
      '</div>' +
      mpFilesStrip(m.id) +
    '</div>' +
    '<div class="mp-menu-actions">' +
      (mpCanAuthor() ? '<button class="mp-btn ghost" onclick="mpEditMenu(\'' + m.id + '\')">Edit</button>' +
        '<button class="mp-btn ghost" onclick="mpPickMenuFile(\'' + m.id + '\')">&#128206; Attach Word / PDF</button>' : '') +
      '<button class="mp-btn ghost" onclick="mpMenuDishes(\'' + m.id + '\')">See its dishes (' + pool + ')</button>' +
      (mpIsApprover()
        // Approved menus show the fact as text, not as a grey button whose only
        // explanation is a tooltip nobody on a phone can see.
        ? (m.status === 'approved'
            ? '<span class="mp-why">Approved' + (m.approved_by ? ' by ' + mpEsc(m.approved_by.split(' ')[0]) : '') +
              (m.approved_at ? ' · ' + mpEsc(mpDateLabel(m.approved_at)) : '') + '</span>'
            : '<button class="mp-btn go small" onclick="mpApproveMenu(\'' + m.id + '\')">Approve</button>') +
          '<button class="mp-btn warn small" onclick="mpCommentOn(\'menu\',\'' + m.id + '\',true)">Ask for changes</button>'
        : '<button class="mp-btn ghost" onclick="mpCommentOn(\'menu\',\'' + m.id + '\')">Comment' + (oc ? ' (' + oc + ')' : '') + '</button>') +
      (mpCanAuthor() ? '<button class="mp-btn ghost danger" onclick="mpDeleteMenu(\'' + m.id + '\')">Delete</button>' : '') +
    '</div>' +
    (mpCommentsFor('menu', m.id).length ? mpCommentBlock('menu', m.id, 'Comments (' + mpCommentsFor('menu', m.id).length + ')', true) : '');
}
const MP_MSTATUS_LABEL = { draft:'Draft', submitted:'Submitted', approved:'Approved', changes_requested:'Changes asked' };

// The LIGHT build for an event menu — different, smaller work than a main menu.
// The date is FIXED (it comes from the events calendar), so it's shown, not
// edited. No identity/structure/cadence to fill: an event borrows its campaign's
// theme. The job is just — pick dishes from the bank, set a price.
function mpEventBuild(id){
  var m = mpMenus.find(function(x){ return x.id === id; });
  if (!m) return;
  var canEdit = mpCanAuthor();
  var d = mpMenuEventDate(m);
  var camp = mpCampaignFor(m);
  var pool = mpMenuDishPool(m.name);
  var approved = pool.filter(function(x){ return MP_RANK[x.status] >= 3; }).length;
  var oc = mpCommentsFor('menu', m.id);
  mpSheet(m.name,
    (camp ? '<div class="mp-hint">Part of <strong>' + mpEsc(camp.theme || camp.title) + '</strong> — it borrows that theme. You just pick the dishes and set the price.</div>' : '') +
    '<div class="mp-eventfixed">' +
      '<i class="mp-event-cal">&#128197;</i>' +
      '<div><div class="mp-eventfixed-d">' + (d ? mpEsc(mpDateLabel(d)) : 'No date set') + '</div>' +
      '<div class="mp-eventfixed-n">Fixed date — comes from the events calendar</div></div>' +
    '</div>' +

    '<div class="mp-eventdishes">' +
      '<div class="mp-eventdishes-h"><span>Its dishes</span><b>' + pool.length + ' chosen · ' + approved + ' approved</b></div>' +
      (pool.length
        ? '<div class="mp-eventdishes-list">' + pool.slice(0,6).map(function(x){ return '<span class="mp-tag">' + mpEsc(x.name_it) + '</span>'; }).join('') +
          (pool.length > 6 ? '<span class="mp-tag more">+' + (pool.length - 6) + '</span>' : '') + '</div>'
        : '<div class="mp-empty">No dishes on it yet.</div>') +
      '<button class="mp-btn ghost" onclick="mpCloseSheet();mpMenuDishes(\'' + m.id + '\')">' + (pool.length ? 'See / choose its dishes' : 'Choose its dishes') + '</button>' +
    '</div>' +

    '<label class="mp-lab">Price <em>(per person)</em></label>' +
    (canEdit
      ? '<input class="mp-in" id="mpev-price" maxlength="' + MP_MAX_PRICE + '" value="' + mpEsc(m.price || '') + '" placeholder="AED 395 per person"/>'
      : '<div class="mp-readval">' + (m.price ? mpEsc(m.price) : '<em>not set</em>') + '</div>') +

    mpFilesStrip(m.id) +

    '<div class="mp-sheet-actions">' +
      (canEdit ? '<button class="mp-btn go" onclick="mpSaveEventBuild(\'' + m.id + '\')">Save</button>' +
        '<button class="mp-btn ghost" onclick="mpCloseSheet();mpPickMenuFile(\'' + m.id + '\')">&#128206; Attach menu doc</button>' : '') +
      (mpIsApprover()
        ? (m.status === 'approved'
            ? '<span class="mp-why">Approved' + (m.approved_by ? ' by ' + mpEsc(m.approved_by.split(' ')[0]) : '') +
              (m.approved_at ? ' · ' + mpEsc(mpDateLabel(m.approved_at)) : '') + '</span>'
            : '<button class="mp-btn go small" onclick="mpApproveMenu(\'' + m.id + '\')">Approve</button>')
        : '') +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">' + (canEdit ? 'Cancel' : 'Close') + '</button>' +
    '</div>' +
    (oc.length ? mpCommentBlock('menu', m.id, 'Comments (' + oc.length + ')', true) : ''));
}
async function mpSaveEventBuild(id){
  var el = document.getElementById('mpev-price');
  var res = await sb.from('menu_plan_menus').update({
    price: (el && el.value || '').trim() || null,
    updated_at: new Date().toISOString(), updated_by: mpMe.name
  }).eq('id', id);
  if (mpErr(res, 'the menu')) return;
  mpCloseSheet(); await mpLoadAll(); mpRender(); mpToast('Saved');
}

// Delete a menu — names the consequence (calendar row, docs, dish tags) first.
async function mpDeleteMenu(id){
  var m = mpMenus.find(function(x){ return x.id === id; });
  if (!m || !mpCanAuthor()) return;
  var tagged = mpDishes.filter(function(d){ return (d.for_menus || []).includes(m.name); }).length;
  var nc = mpCommentsFor('menu', id).length;
  var ok = await mpConfirm('Delete “' + m.name + '”?',
    'It clears this menu’s calendar row and any uploaded documents' +
    (tagged ? ', and untags it from ' + tagged + ' dish' + (tagged === 1 ? '' : 'es') : '') +
    (nc ? ', and deletes the ' + nc + ' comment' + (nc === 1 ? '' : 's') + ' written on it' : '') +
    '. Your dishes themselves stay in Dishes — nothing you cooked is lost. This cannot be undone.', 'Delete');
  if (!ok) return;
  // clean up storage objects for this menu's docs (DB rows cascade)
  var files = mpFilesFor(id);
  if (files.length && sb.storage && sb.storage.from){
    try { await sb.storage.from(MP_BUCKET).remove(files.map(function(f){ return f.file_path; })); } catch(e){}
  }
  var res = await sb.from('menu_plan_menus').delete().eq('id', id);
  if (mpErr(res, 'the menu')) return;
  // comments carry no foreign key, so nothing cascades — clear the thread here
  // or it survives invisibly forever.
  if (nc) await sb.from('menu_plan_comments').delete().eq('target_type', 'menu').eq('target_id', id);
  // strip the menu name from any dish's for_menus array
  var toFix = mpDishes.filter(function(d){ return (d.for_menus || []).includes(m.name); });
  for (var i = 0; i < toFix.length; i++){
    var next = toFix[i].for_menus.filter(function(x){ return x !== m.name; });
    await sb.from('menu_plan_dishes').update({ for_menus: next }).eq('id', toFix[i].id);
  }
  mpCloseSheet(); await mpLoadAll(); mpRender(); mpToast(m.name + ' deleted');
}

// ── menu documents (Word / PDF uploaded by a chef) ──────────────────────────
// Shown on the brief. Tap to open in a new tab; the little × removes it. A chef
// who already wrote the menu in Word does not have to retype it into the fields.
function mpFilesStrip(menuId){
  var files = mpFilesFor(menuId);
  if (!files.length) return '';   // the Attach button in the actions row is the entry point
  return '<div class="mp-files">' +
    '<div class="mp-files-h">Menu documents</div>' +
    files.map(function(f){
      return '<div class="mp-file">' +
        '<a class="mp-file-open" href="' + mpEsc(mpPublicUrl(f.file_path)) + '" target="_blank" rel="noopener">' +
          '<span class="mp-file-ic ' + mpFileIcon(f.mime, f.file_name).toLowerCase() + '">' + mpFileIcon(f.mime, f.file_name) + '</span>' +
          '<span class="mp-file-meta"><span class="mp-file-name">' + mpEsc(f.file_name) + '</span>' +
          '<span class="mp-file-sub">' + mpEsc(mpFileSize(f.size_bytes)) + (f.uploaded_by ? ' · ' + mpEsc(f.uploaded_by.split(' ')[0]) : '') + '</span></span>' +
        '</a>' +
        '<button class="mp-file-x" title="Remove" onclick="mpRemoveMenuFile(\'' + menuId + '\',\'' + f.id + '\')">&times;</button>' +
      '</div>';
    }).join('') +
  '</div>';
}

// Hidden <input type=file> per menu, triggered by the Attach button. Kept out of
// the innerHTML string so a re-render never wipes a selection mid-upload.
function mpPickMenuFile(menuId){
  var inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = MP_DOC_TYPES;
  inp.style.display = 'none';
  inp.onchange = function(){ var f = inp.files && inp.files[0]; inp.remove(); if (f) mpUploadMenuFile(menuId, f); };
  document.body.appendChild(inp);
  inp.click();
}

async function mpUploadMenuFile(menuId, file){
  if (file.size > MP_MAX_FILE_MB * 1048576){
    mpToast('That file is ' + mpFileSize(file.size) + ' — the limit is ' + MP_MAX_FILE_MB + ' MB. Export a lighter PDF and try again.', true);
    return;
  }
  mpToast('Uploading ' + file.name + '…');
  // A collision-proof path: menu folder + random id + the original (sanitised)
  // name, so two chefs uploading "menu.pdf" at once never overwrite each other.
  var safe = file.name.replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_').slice(-80);
  var rand = (self.crypto && crypto.randomUUID) ? crypto.randomUUID().slice(0, 8) : String(Math.abs(Date.now() % 1e8));
  var path = menuId + '/' + rand + '-' + safe;

  if (!sb.storage || !sb.storage.from){
    mpToast('File storage is not available in this build.', true);
    return;
  }
  var up = await sb.storage.from(MP_BUCKET).upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
  if (up && up.error){
    var msg = String(up.error.message || up.error);
    mpToast(msg.toLowerCase().indexOf('bucket') >= 0
      ? 'The "' + MP_BUCKET + '" storage bucket is not set up yet — run the storage section of menu-plan-schema.sql.'
      : 'Upload failed: ' + msg, true);
    return;
  }
  var row = { menu_id: menuId, file_name: file.name, file_path: path,
              mime: file.type || null, size_bytes: file.size || null,
              uploaded_by: mpMe.name, created_at: new Date().toISOString() };
  var res = await sb.from('menu_plan_menu_files').insert(row).select().single();
  if (res && res.error){
    // roll back the orphaned object so a failed row-write leaves nothing behind
    try { await sb.storage.from(MP_BUCKET).remove([path]); } catch(e){}
    mpErr(res, 'the file');
    return;
  }
  (mpMenuFiles[menuId] = mpMenuFiles[menuId] || []).push(res.data || row);
  mpRender();
  mpToast(file.name + ' attached');
}

async function mpRemoveMenuFile(menuId, fileId){
  var f = mpFilesFor(menuId).find(function(x){ return x.id === fileId; });
  if (!f) return;
  var ok = await mpConfirm('Remove “' + f.file_name + '”?', 'It comes off this menu for everyone. The dishes and the rest of the brief are untouched.', 'Remove');
  if (!ok) return;
  var res = await sb.from('menu_plan_menu_files').delete().eq('id', fileId);
  if (mpErr(res, 'the file')) return;
  try { if (sb.storage && sb.storage.from) await sb.storage.from(MP_BUCKET).remove([f.file_path]); } catch(e){}
  mpMenuFiles[menuId] = mpFilesFor(menuId).filter(function(x){ return x.id !== fileId; });
  mpRender();
  mpToast('Removed');
}

function mpEditMenu(id){
  var m = mpMenus.find(function(x){ return x.id === id; }) || {};
  // A menu that's never been written (identity/structure/price all blank) opens
  // with STARTER TEXT already in the boxes — real, editable text, not a grey
  // placeholder — so writing a brief starts from a sentence, not a blank page.
  var blank = !m.identity && !m.structure && !m.price;
  var tmpl = blank ? mpBriefTemplate(m.name) : null;
  var last = mpLastMenuDefaults();
  var identityVal  = m.identity  || (tmpl ? tmpl.identity  : '');
  var structureVal = m.structure || (tmpl ? tmpl.structure : '');
  var priceVal     = m.price     || (tmpl ? tmpl.price : (blank ? (last.price || '') : ''));
  mpSheet('Edit ' + (m.name || 'menu'),
    (tmpl ? '<div class="mp-hint">Starter text below, based on this kind of menu — tweak or replace it.</div>' : '') +
    '<label class="mp-lab">Menu name</label>' +
    '<input class="mp-in" id="mpm-name" maxlength="' + MP_MAX_NAME + '" value="' + mpEsc(m.name || '') + '"/>' +
    '<label class="mp-lab">Identity <em>(one line — what is this menu?)</em></label>' +
    '<textarea class="mp-in" id="mpm-identity" rows="2" maxlength="' + MP_MAX_LINE + '" placeholder="Coastal southern Italy, simple, ingredient-led">' + mpEsc(identityVal) + '</textarea>' +
    '<label class="mp-lab">Structure</label>' +
    '<textarea class="mp-in" id="mpm-structure" rows="2" maxlength="' + MP_MAX_LINE + '" placeholder="5 antipasti · 4 paste · 3 secondi · 3 dolci">' + mpEsc(structureVal) + '</textarea>' +
    '<label class="mp-lab">Price</label>' +
    '<input class="mp-in" id="mpm-price" maxlength="' + MP_MAX_PRICE + '" value="' + mpEsc(priceVal) + '" placeholder="AED 295 per person"/>' +
    '<label class="mp-lab">How often it changes</label>' +
    '<select class="mp-in" id="mpm-cadence">' + MP_CADENCES.map(function(c){
      return '<option' + (m.change_cadence === c ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select>' +
    '<div class="mp-two">' +
      '<div><label class="mp-lab">Testing date</label><input class="mp-in" type="date" id="mpm-testing" value="' + mpEsc((m.testing_date || '').slice(0,10)) + '"/></div>' +
      '<div><label class="mp-lab">Launch date</label><input class="mp-in" type="date" id="mpm-launch" value="' + mpEsc((m.launch_date || '').slice(0,10)) + '"/></div>' +
    '</div>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpSaveMenu(\'' + id + '\')">Save</button>' +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">Cancel</button>' +
    '</div>');
}
function mpAddMenu(){
  mpSheet('New menu',
    '<label class="mp-lab">Menu name</label>' +
    '<input class="mp-in" id="mpm-new" maxlength="' + MP_MAX_NAME + '" placeholder="e.g. Bartolini Dinner · 2–3 Nov"/>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpCreateMenu(this)">Add menu</button>' +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">Cancel</button>' +
    '</div>');
}
async function mpCreateMenu(btn){
  var name = (document.getElementById('mpm-new').value || '').trim();
  if (!name){ mpToast('Give the menu a name first.', true); return; }
  var free = mpLock(btn); if (!free) return;
  try {
    var max = mpMenus.reduce(function(a, m){ return Math.max(a, m.sort_order || 0); }, 0);
    var last = mpLastMenuDefaults();
    var res = await sb.from('menu_plan_menus').insert({
      name:name, sort_order:max + 10, updated_by:mpMe.name,
      change_cadence: last.change_cadence || 'Seasonal'
    });
    if (mpErr(res, 'the menu')) return;
    mpCloseSheet(); await mpLoadAll(); mpRender(); mpToast(name + ' added');
  } finally { free(); }
}
// "New like this" for menus — a blank name, everything else (structure/price/
// cadence) carried over so a run of similar menus (the four Festive ones)
// doesn't start from nothing each time.
function mpDuplicateMenu(sourceId){
  var src = mpMenus.find(function(m){ return m.id === sourceId; });
  if (!src) return;
  mpSheet('New menu — like ' + src.name,
    '<div class="mp-hint">Structure, price and cadence copied from ' + mpEsc(src.name) + ' — tweak as needed.</div>' +
    '<label class="mp-lab">Menu name</label>' +
    '<input class="mp-in" id="mpm-new" maxlength="' + MP_MAX_NAME + '" placeholder="e.g. ' + mpEsc(src.name) + ' — variant"/>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpCreateDuplicateMenu(\'' + sourceId + '\',this)">Create</button>' +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">Cancel</button>' +
    '</div>');
}
async function mpCreateDuplicateMenu(sourceId, btn){
  var src = mpMenus.find(function(m){ return m.id === sourceId; }) || {};
  var name = (document.getElementById('mpm-new').value || '').trim();
  if (!name){ mpToast('Give the new menu a name first.', true); return; }
  var free = mpLock(btn); if (!free) return;
  try {
    var max = mpMenus.reduce(function(a, m){ return Math.max(a, m.sort_order || 0); }, 0);
    var row = {
      name:name, sort_order:max + 10, updated_by:mpMe.name,
      structure: src.structure || null, price: src.price || null,
      change_cadence: src.change_cadence || 'Seasonal'
    };
    var res = await sb.from('menu_plan_menus').insert(row);
    if (mpErr(res, 'the menu')) return;
    mpRememberMenuDefaults(row);
    mpCloseSheet(); await mpLoadAll(); mpRender(); mpToast(name + ' created from ' + (src.name || 'that menu'));
  } finally { free(); }
}
async function mpSaveMenu(id){
  var row = {
    name:      (document.getElementById('mpm-name').value || '').trim(),
    identity:  (document.getElementById('mpm-identity').value || '').trim() || null,
    structure: (document.getElementById('mpm-structure').value || '').trim() || null,
    price:     (document.getElementById('mpm-price').value || '').trim() || null,
    change_cadence: document.getElementById('mpm-cadence').value,
    testing_date: document.getElementById('mpm-testing').value || null,
    launch_date:  document.getElementById('mpm-launch').value || null,
    updated_at: new Date().toISOString(), updated_by: mpMe.name
  };
  if (!row.name){ mpToast('The menu needs a name.', true); return; }
  var res = await sb.from('menu_plan_menus').update(row).eq('id', id);
  if (mpErr(res, 'the menu')) return;
  mpRememberMenuDefaults(row);
  mpCloseSheet(); await mpLoadAll(); mpRender(); mpToast('Saved');
}
async function mpApproveMenu(id){
  var m = mpMenus.find(function(x){ return x.id === id; });
  var ok = await mpConfirm('Approve “' + (m ? m.name : '') + '”?', 'The team sees this menu marked approved.', 'Approve');
  if (!ok) return;
  var res = await sb.from('menu_plan_menus').update({
    status:'approved', approved_by:mpMe.name, approved_at:new Date().toISOString(),
    updated_at:new Date().toISOString(), updated_by:mpMe.name
  }).eq('id', id);
  if (mpErr(res, 'the approval')) return;
  await mpLoadAll(); mpRender(); mpToast((m ? m.name : 'Menu') + ' approved');
}
function mpMenuDishes(id){
  var m = mpMenus.find(function(x){ return x.id === id; });
  if (!m) return;
  mpFilter = { section:'', menu:m.name, status:'', season:'', chef:'', q:'' };
  mpTab = 'dishes'; mpRender(); window.scrollTo(0,0);
}

// ══ 5. TASTING SESSIONS ════════════════════════════════════════════════════
function mpItemName(i){
  if (i.dish_id){ var d = mpDishes.find(function(x){ return x.id === i.dish_id; }); return d ? d.name_it : 'Dish removed'; }
  return i.manual_name || 'Untitled';
}
// A tasting is several people tasting the same dish, so the scores and the notes
// live one row per person. The item row still carries the score of any tasting
// held before that table existed — shown as one more voice, never overwritten.
function mpItemScoreRows(item){
  var rows = (mpTastingScores[item.id] || []).slice();
  if (item.taste_score || item.presentation_score || item.comment){
    rows.push({ scored_by:null, taste_score:item.taste_score, presentation_score:item.presentation_score,
                comment:item.comment, legacy:true });
  }
  return rows;
}
// "That table isn't there yet" vs "the connection dropped" — PostgREST says the
// first with 42P01, or PGRST205 when the schema cache has never seen it.
function mpTableMissing(err){
  var m = String((err && (err.message || err.code)) || '').toLowerCase();
  return m.indexOf('does not exist') >= 0 || m.indexOf('42p01') >= 0 ||
         m.indexOf('pgrst205') >= 0 || m.indexOf('schema cache') >= 0;
}
function mpMyScoreRow(item){
  return (mpTastingScores[item.id] || []).find(function(r){ return r.scored_by === mpMe.name; }) || null;
}
function mpItemScored(i){ return !!(mpItemScoreRows(i).length || i.decision); }
// The average across everyone who scored — what the tasting list shows.
function mpItemAvg(item, field){
  var vals = mpItemScoreRows(item).map(function(r){ return r[field]; }).filter(function(v){ return v != null && v !== ''; });
  if (!vals.length) return null;
  var sum = vals.reduce(function(a, v){ return a + Number(v); }, 0);
  return { avg: Math.round(sum / vals.length * 10) / 10, n: vals.length };
}
function mpRenderTastings(){
  var canEdit = mpCanAuthor();
  return '<div class="mp-body">' +
    (canEdit ? '<button class="mp-big" onclick="mpNewTasting()">+ Book a tasting</button>' : '') +
    (mpTastings.length === 0
      ? '<div class="mp-empty big">No tastings yet.<br/>Book one, attach the dishes, and score them on the day.</div>'
      : mpTastings.map(function(s){
          var done = s.items.filter(mpItemScored).length;
          return '<div class="mp-card">' +
            '<div class="mp-menu-h">' +
              '<div><div class="mp-menu-name">' + mpEsc(mpDateLabel(s.session_date)) + (s.session_time ? ' · ' + mpEsc(s.session_time) : '') + '</div>' +
              '<div class="mp-menu-sub">' + mpEsc(s.title || 'Tasting') + ' · ' + s.items.length + ' dish' + (s.items.length === 1 ? '' : 'es') +
              (s.items.length ? ' · ' + done + ' scored' : '') + '</div></div>' +
              (s.session_date >= mpToday() ? '<span class="mp-mstatus s-submitted">Upcoming</span>' : '') +
            '</div>' +
            (s.items.length
              ? '<div class="mp-tlist">' + s.items.map(function(i){
                  var t = mpItemAvg(i, 'taste_score'), p = mpItemAvg(i, 'presentation_score');
                  var sc = [];
                  if (t) sc.push('T' + t.avg);
                  if (p) sc.push('P' + p.avg);
                  var voices = Math.max(t ? t.n : 0, p ? p.n : 0);
                  if (voices > 1) sc.push('<em class="mp-manual">' + voices + ' people</em>');
                  return '<button class="mp-trow" onclick="mpScoreDish(\'' + s.id + '\',\'' + i.id + '\')">' +
                    '<span class="mp-tname">' + mpEsc(mpItemName(i)) + (i.dish_id ? '' : ' <em class="mp-manual">typed</em>') + '</span>' +
                    '<span class="mp-tscore">' + (sc.length ? sc.join(' ') : '—') + '</span>' +
                    '<span class="mp-tdec' + (i.decision ? ' d-' + i.decision.toLowerCase() : '') + '">' + mpEsc(i.decision || 'score it') + '</span>' +
                  '</button>';
                }).join('') + '</div>'
              : '<div class="mp-empty">No dishes attached yet.</div>') +
            (canEdit ? '<div class="mp-menu-actions">' +
              '<button class="mp-btn ghost" onclick="mpAttachDishes(\'' + s.id + '\')">Attach dishes</button>' +
              '<button class="mp-btn ghost danger" onclick="mpDeleteTasting(\'' + s.id + '\')">Delete</button>' +
            '</div>' : '') +
          '</div>';
        }).join('')) +
  '</div>';
}
function mpNewTasting(){
  mpSheet('Book a tasting',
    '<div class="mp-two">' +
      '<div><label class="mp-lab">Date</label><input class="mp-in" type="date" id="mpt-date" value="' + mpToday() + '"/></div>' +
      '<div><label class="mp-lab">Time</label><input class="mp-in" type="time" id="mpt-time" value="11:00"/></div>' +
    '</div>' +
    '<label class="mp-lab">What is it for <em>(optional)</em></label>' +
    '<input class="mp-in" id="mpt-title" maxlength="' + MP_MAX_NAME + '" placeholder="e.g. Autumn à la carte round 1"/>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpSaveTasting(this)">Book it</button>' +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">Cancel</button>' +
    '</div>');
}
async function mpSaveTasting(btn){
  var date = document.getElementById('mpt-date').value;
  if (!date){ mpToast('Pick a date first.', true); return; }
  // Back-dating is legitimate — you record the tasting you already held — so
  // this warns and lets them through rather than blocking.
  if (date < mpToday()){
    var ok = await mpConfirm('Book it on ' + mpDateLabel(date) + '?',
      'That date has already passed, so it lands in the list as a past tasting, not an upcoming one. That is right if you are writing up one you already held.',
      'Book it anyway', { cancelLabel:'Pick another date', safeFirst:true });
    if (!ok) return;
  }
  var free = mpLock(btn); if (!free) return;
  try {
    var res = await sb.from('menu_plan_tastings').insert({
      session_date:date, session_time:(document.getElementById('mpt-time').value || '') || null,
      title:(document.getElementById('mpt-title').value || '').trim() || null, created_by:mpMe.name });
    if (mpErr(res, 'the tasting')) return;
    mpCloseSheet(); await mpLoadAll(); mpRender(); mpToast('Tasting booked for ' + mpDateLabel(date));
  } finally { free(); }
}
async function mpDeleteTasting(id){
  var ok = await mpConfirm('Delete this tasting?', 'The session and all its scores go for everyone. The dishes themselves stay.', 'Delete');
  if (!ok) return;
  var res = await sb.from('menu_plan_tastings').delete().eq('id', id);
  if (mpErr(res, 'the delete')) return;
  await mpLoadAll(); mpRender(); mpToast('Tasting deleted');
}
// keepPicks (optional) = dish ids the chef had ticked but not saved yet, carried
// across a re-render (adding/removing a typed dish) so their in-flight list
// selection is never silently lost.
function mpAttachDishes(sessionId, keepPicks){
  var s = mpTastings.find(function(x){ return x.id === sessionId; });
  if (!s) return;
  var already = s.items.filter(function(i){ return i.dish_id; }).map(function(i){ return i.dish_id; });
  var picked = already.concat(keepPicks || []).filter(function(v, i, a){ return a.indexOf(v) === i; });
  var manual = s.items.filter(function(i){ return !i.dish_id; });
  var pool = mpDishes.filter(function(d){ return d.status !== 'Retired'; });
  mpSheet('Attach dishes',
    '<div class="mp-hint">Tap the dishes being tasted on ' + mpEsc(mpDateLabel(s.session_date)) + '.</div>' +
    (pool.length
      ? // the same search the Dishes tab has — a flat list of 16 is already a
        // scroll, and the season goal is 60
        '<input class="mp-in" id="mpt-search" placeholder="Search dishes…" autocomplete="off" oninput="mpFilterAttach()"/>' +
        '<div class="mp-pills" id="mpt-pick">' +
          pool.map(function(d){
            return '<button type="button" class="mp-pill' + (picked.includes(d.id) ? ' on' : '') + '" data-v="' + d.id + '" data-q="' + mpEsc((d.name_it + ' ' + (d.section || '')).toLowerCase()) + '" onclick="this.classList.toggle(\'on\')">' + mpEsc(d.name_it) + '</button>';
          }).join('') +
        '</div>' +
        '<div class="mp-fine" id="mpt-nomatch" style="display:none">No dish matches that.</div>'
      : '<div class="mp-empty">No dishes in the bank yet — type one below.</div>') +

    '<label class="mp-lab">Not in the bank yet? Type it in</label>' +
    (manual.length
      ? '<div class="mp-manual-list">' + manual.map(function(i){
          return '<div class="mp-manual-row"><span>' + mpEsc(i.manual_name) + '</span>' +
            '<button class="mp-file-x" onclick="mpRemoveManualItem(\'' + i.id + '\',\'' + sessionId + '\')">&times;</button></div>';
        }).join('') + '</div>'
      : '') +
    '<div class="mp-addrow">' +
      '<input class="mp-in" id="mpt-manual" maxlength="' + MP_MAX_NAME + '" placeholder="e.g. New scallop dish"/>' +
      '<button class="mp-btn ghost" onclick="mpAddManualItem(\'' + sessionId + '\',this)">Add</button>' +
    '</div>' +

    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpSaveAttach(\'' + sessionId + '\',this)">Save</button>' +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">Cancel</button>' +
    '</div>');
}
// A typed dish is inserted straight away (its own row) so it survives the Save
// diff, which only touches linked dishes. It lives on the tasting only.
function mpCurrentPicks(){
  var el = document.getElementById('mpt-pick');
  return el ? [].slice.call(el.querySelectorAll('.mp-pill.on')).map(function(b){ return b.getAttribute('data-v'); }) : [];
}
// Narrows the pill list only — a ticked dish that scrolls out of the filter is
// still ticked, so searching can never silently drop one from the tasting.
function mpFilterAttach(){
  var box = document.getElementById('mpt-search'), wrap = document.getElementById('mpt-pick');
  if (!box || !wrap) return;
  var q = (box.value || '').trim().toLowerCase(), shown = 0;
  [].forEach.call(wrap.querySelectorAll('.mp-pill'), function(b){
    var hit = !q || (b.getAttribute('data-q') || '').indexOf(q) >= 0;
    b.style.display = hit ? '' : 'none';
    if (hit) shown++;
  });
  var none = document.getElementById('mpt-nomatch');
  if (none) none.style.display = shown ? 'none' : '';
}
async function mpAddManualItem(sessionId, btn){
  var name = (document.getElementById('mpt-manual').value || '').trim();
  if (!name){ mpToast('Type a name first.', true); return; }
  var free = mpLock(btn); if (!free) return;
  try {
    var picks = mpCurrentPicks();                 // keep the chef's in-flight list ticks
    var res = await sb.from('menu_plan_tasting_items').insert({ session_id:sessionId, manual_name:name });
    if (mpErr(res, 'the dish')) return;
    await mpLoadAll(); mpAttachDishes(sessionId, picks); mpToast(name + ' added');
  } finally { free(); }
}
async function mpRemoveManualItem(itemId, sessionId){
  var picks = mpCurrentPicks();
  var res = await sb.from('menu_plan_tasting_items').delete().eq('id', itemId);
  if (mpErr(res, 'the dish')) return;
  await mpLoadAll(); mpAttachDishes(sessionId, picks);
}
async function mpSaveAttach(sessionId, btn){
  var free = mpLock(btn); if (!free) return;
  try {
    var s = mpTastings.find(function(x){ return x.id === sessionId; });
    var pickEl = document.getElementById('mpt-pick');
    var want = pickEl ? [].slice.call(pickEl.querySelectorAll('.mp-pill.on')).map(function(b){ return b.getAttribute('data-v'); }) : [];
    var have = s.items.filter(function(i){ return i.dish_id; }).map(function(i){ return i.dish_id; });
    var add  = want.filter(function(id){ return !have.includes(id); });
    var drop = have.filter(function(id){ return !want.includes(id); });
    if (add.length){
      var r1 = await sb.from('menu_plan_tasting_items').insert(add.map(function(id){ return { session_id:sessionId, dish_id:id }; }));
      if (mpErr(r1, 'the dishes')) return;
    }
    if (drop.length){
      var r2 = await sb.from('menu_plan_tasting_items').delete().eq('session_id', sessionId).in('dish_id', drop);
      if (mpErr(r2, 'the dishes')) return;
    }
    mpCloseSheet(); await mpLoadAll(); mpRender(); mpToast('Dishes updated');
  } finally { free(); }
}
// Score one item on TWO categories (Taste, Presentation) 1–5 + an outcome.
function mpScoreDish(sessionId, itemId){
  var s = mpTastings.find(function(x){ return x.id === sessionId; });
  var it = s ? s.items.find(function(i){ return i.id === itemId; }) : null;
  if (!it) return;
  var canEdit = mpCanAuthor();
  var mine = mpMyScoreRow(it);
  // What I scored last time, if anything — never anybody else's numbers, so
  // saving can't quietly rewrite them.
  var myTaste = mine ? mine.taste_score : (mpScoresTable ? null : it.taste_score);
  var myPres  = mine ? mine.presentation_score : (mpScoresTable ? null : it.presentation_score);
  var myComment = mine ? (mine.comment || '') : (mpScoresTable ? '' : (it.comment || ''));
  var others = mpItemScoreRows(it).filter(function(r){ return r.scored_by !== mpMe.name; });
  var scale = function(id, val){
    return '<div class="mp-pills" id="' + id + '">' +
      [1,2,3,4,5].map(function(n){
        return '<button type="button" class="mp-pill score' + (Number(val) === n ? ' on' : '') + '"' + (canEdit ? ' onclick="mpPickOne(this)"' : ' disabled') + ' data-v="' + n + '">' + n + '</button>';
      }).join('') + '</div>';
  };
  mpSheet('Score “' + mpItemName(it) + '”',
    // everyone else's scores, side by side and named — a tasting is a room full
    // of opinions, and one person's Save must never flatten the rest
    (others.length
      ? '<div class="mp-scoreothers">' +
          '<div class="mp-files-h">What the others scored</div>' +
          others.map(function(r){
            var bits = [];
            if (r.taste_score) bits.push('Taste ' + r.taste_score);
            if (r.presentation_score) bits.push('Presentation ' + r.presentation_score);
            return '<div class="mp-scorerow">' +
              '<div class="mp-scorewho"><strong>' + mpEsc(r.legacy ? 'Scored before this update' : r.scored_by) + '</strong>' +
                (bits.length ? '<span>' + mpEsc(bits.join(' · ')) + '</span>' : '<span>no score</span>') + '</div>' +
              (r.comment ? '<div class="mp-scorenote">' + mpEsc(r.comment) + '</div>' : '') +
            '</div>';
          }).join('') +
        '</div>'
      : '') +
    '<div class="mp-fine">1 = very bad · 5 = very good' + (others.length ? ' · this is your own score, theirs stays as it is' : '') + '</div>' +
    '<label class="mp-lab">Taste</label>' + scale('mps-taste', myTaste) +
    '<label class="mp-lab">Presentation</label>' + scale('mps-pres', myPres) +
    '<label class="mp-lab">Outcome <em>(one call for the dish, not per person)</em></label>' +
    '<div class="mp-pills" id="mps-dec">' +
      MP_DECISIONS.map(function(x){
        return '<button type="button" class="mp-pill' + (it.decision === x ? ' on' : '') + '"' + (canEdit ? ' onclick="mpPickOne(this)"' : ' disabled') + ' data-v="' + x + '">' + x + '</button>';
      }).join('') +
    '</div>' +
    '<label class="mp-lab">Your comment</label>' +
    '<textarea class="mp-in" id="mps-comment" rows="3" maxlength="' + MP_MAX_NOTE + '" placeholder="What to change"' + (canEdit ? '' : ' disabled') + '>' + mpEsc(myComment) + '</textarea>' +
    (it.dish_id
      ? (mpIsApprover()
          ? '<div class="mp-hint">Choosing <strong>Approve</strong> moves the dish to Approved.</div>'
          : '<div class="mp-hint">Only Francesco’s Approve moves the dish — your scores and notes are still saved.</div>')
      : '<div class="mp-hint">This is a typed dish — scoring is saved on the tasting only.</div>') +
    (canEdit
      ? '<div class="mp-sheet-actions">' +
          '<button class="mp-btn go" onclick="mpSaveScore(\'' + sessionId + '\',\'' + itemId + '\')">Save</button>' +
          '<button class="mp-btn ghost" onclick="mpCloseSheet()">Cancel</button>' +
        '</div>'
      : '<div class="mp-sheet-actions"><button class="mp-btn ghost" onclick="mpCloseSheet()">Close</button></div>'));
}
function mpPickOne(btn){
  var wrap = btn.parentElement;
  wrap.querySelectorAll('.mp-pill').forEach(function(b){ b.classList.remove('on'); });
  btn.classList.add('on');
}

// ── searchable single-pick control ─────────────────────────────────────────
// Replaces a native <select> for long lists (Section, Lead chef) — type to
// filter, tap to choose, beats open-scroll-pick on a phone. The real value
// lives in a hidden input with the given fieldId, so every existing
// `document.getElementById(fieldId).value` read elsewhere keeps working
// unchanged — only the widget around it changed.
function mpSearchPicker(fieldId, options, current, placeholder){
  return '<div class="mp-searchpick">' +
    '<input class="mp-in" type="text" id="' + fieldId + '-q" placeholder="' + mpEsc(placeholder) + '" value="' + mpEsc(current || '') + '" autocomplete="off" ' +
      'oninput="mpFilterPicker(\'' + fieldId + '\')" onfocus="mpOpenPicker(\'' + fieldId + '\')" onblur="mpBlurPicker(\'' + fieldId + '\')"/>' +
    '<input type="hidden" id="' + fieldId + '" value="' + mpEsc(current || '') + '"/>' +
    '<div class="mp-picklist" id="' + fieldId + '-list" style="display:none">' +
      options.map(function(o){ return '<button type="button" class="mp-pickopt" data-v="' + mpEsc(o) + '" onmousedown="mpChoosePicker(this,\'' + fieldId + '\')">' + mpEsc(o) + '</button>'; }).join('') +
    '</div>' +
  '</div>';
}
function mpChoosePicker(btn, fieldId){
  var val = btn.getAttribute('data-v');
  var hidden = document.getElementById(fieldId), q = document.getElementById(fieldId + '-q'), list = document.getElementById(fieldId + '-list');
  if (hidden) hidden.value = val;
  if (q) q.value = val;
  if (list) list.style.display = 'none';
  if (fieldId === 'mpf-section'){
    mpSectionIsGuess = false;              // a person chose it — the guess stops here
    var h = document.getElementById('mpf-section-hint'); if (h) h.textContent = '';
  }
}
function mpFilterPicker(fieldId){
  // Just narrows the visible list as they type. Deliberately does NOT touch the
  // hidden value mid-keystroke — a stray tap-away must never silently blank out
  // an already-confirmed pick (Section, Lead chef) the way it would if typing
  // itself invalidated the saved value.
  var q = (document.getElementById(fieldId + '-q').value || '').toLowerCase();
  var list = document.getElementById(fieldId + '-list');
  if (!list) return;
  list.style.display = 'block';
  [].forEach.call(list.querySelectorAll('.mp-pickopt'), function(btn){
    btn.style.display = (!q || (btn.getAttribute('data-v') || '').toLowerCase().indexOf(q) >= 0) ? '' : 'none';
  });
}
function mpOpenPicker(fieldId){ var list = document.getElementById(fieldId + '-list'); if (list) list.style.display = 'block'; }
// A delayed close so a tap on an option (onmousedown, fires before blur) still
// lands before the list disappears.
function mpBlurPicker(fieldId){
  setTimeout(function(){
    var list = document.getElementById(fieldId + '-list'), hidden = document.getElementById(fieldId), q = document.getElementById(fieldId + '-q');
    if (list) list.style.display = 'none';
    if (!hidden || !q) return;
    var typed = (q.value || '').trim();
    // Typing in the box (or emptying it) is a person taking the field over —
    // only then does the section guess stop revising itself.
    if (!typed){ hidden.value = ''; if (fieldId === 'mpf-section') mpSectionIsGuess = false; return; }   // deliberately cleared = cleared
    // typed the full, exact option (case-insensitive) without tapping it — accept
    // it rather than punish them for not tapping. Anything else: it didn't match
    // a real option, so revert the visible text to whatever was last confirmed —
    // never leave a half-typed guess sitting in a value that gets saved.
    var opts = list ? [].slice.call(list.querySelectorAll('.mp-pickopt')) : [];
    var match = opts.find(function(b){ return (b.getAttribute('data-v') || '').toLowerCase() === typed.toLowerCase(); });
    if (match){
      hidden.value = match.getAttribute('data-v'); q.value = hidden.value;
      if (fieldId === 'mpf-section') mpSectionIsGuess = false;
    }
    else q.value = hidden.value || '';
  }, 150);
}
async function mpSaveScore(sessionId, itemId){
  var s = mpTastings.find(function(x){ return x.id === sessionId; });
  var it = s ? s.items.find(function(i){ return i.id === itemId; }) : null;
  if (!it) return;
  var pick = function(id){ var on = document.querySelector('#' + id + ' .mp-pill.on'); return on ? on.getAttribute('data-v') : null; };
  var taste = pick('mps-taste'), pres = pick('mps-pres'), dec = pick('mps-dec');
  var note = (document.getElementById('mps-comment').value || '').trim() || null;
  var res;
  if (mpScoresTable){
    // My row, keyed on (item, me). Everyone else's scores and notes are not in
    // this statement at all, so they cannot be lost.
    res = await sb.from('menu_plan_tasting_scores').upsert({
      item_id: itemId, scored_by: mpMe.name,
      taste_score: taste ? +taste : null,
      presentation_score: pres ? +pres : null,
      comment: note, updated_at: new Date().toISOString()
    }, { onConflict:'item_id,scored_by' });
    // Only a MISSING TABLE drops us back to the shared row. A dropped
    // connection must not silently downgrade us for the rest of the session —
    // that is how one person's note would end up overwriting another's.
    if (res && res.error && mpTableMissing(res.error)) mpScoresTable = false;
    else if (mpErr(res, 'the score')) return;
    // the outcome is one call on the dish, so it stays on the item row
    if (mpScoresTable){
      var dr0 = await sb.from('menu_plan_tasting_items').update({ decision: dec }).eq('id', itemId);
      if (mpErr(dr0, 'the outcome')) return;
    }
  }
  if (!mpScoresTable){
    // Before menu-plan-tasting-scores.sql is run there is only the one shared
    // row to write to — the module keeps working, on the old terms.
    res = await sb.from('menu_plan_tasting_items').update({
      taste_score: taste ? +taste : null,
      presentation_score: pres ? +pres : null,
      decision: dec,
      comment: note
    }).eq('id', itemId);
    if (mpErr(res, 'the score')) return;
  }

  // Only a REAL dish moves, and only on the approver's Approve → Approved.
  if (it.dish_id && dec === 'Approve' && mpIsApprover()){
    var dr = await sb.from('menu_plan_dishes').update({
      status:'Approved', approved_date:mpToday(),
      taste_score: taste ? +taste : null, presentation_score: pres ? +pres : null,
      updated_at:new Date().toISOString(), updated_by:mpMe.name
    }).eq('id', it.dish_id);
    if (mpErr(dr, 'the dish')) return;
  } else if (it.dish_id && (taste || pres)){
    await sb.from('menu_plan_dishes').update({ taste_score: taste ? +taste : null, presentation_score: pres ? +pres : null }).eq('id', it.dish_id);
  }
  mpCloseSheet(); await mpLoadAll(); mpRender();
  mpToast(it.dish_id && dec === 'Approve' && mpIsApprover() ? 'Approved' : 'Score saved');
}

// ══ COMMENTS ═══════════════════════════════════════════════════════════════
function mpCommentBlock(type, id, title, compact){
  var list = mpCommentsFor(type, id);
  return '<div class="mp-comments' + (compact ? ' compact' : ' mp-card') + '">' +
    '<div class="mp-card-h">' + mpEsc(title) + '</div>' +
    (list.length
      ? list.map(function(c){
          return '<div class="mp-cmt' + (c.resolved ? ' done' : '') + '">' +
            '<div class="mp-cmt-h"><strong>' + mpEsc(c.author) + '</strong><span>' + mpEsc(mpDateLabel(c.created_at)) + '</span></div>' +
            '<div class="mp-cmt-b">' + mpEsc(c.body) + '</div>' +
            (c.resolved ? '<div class="mp-cmt-done">Done</div>'
                        : '<button class="mp-link" onclick="mpResolveComment(\'' + c.id + '\')">Mark as done</button>') +
          '</div>';
        }).join('')
      : '<div class="mp-empty">No comments yet.</div>') +
    '<button class="mp-btn ghost" onclick="mpCommentOn(\'' + type + '\',' + (id ? "'" + id + "'" : 'null') + ')">Write a comment</button>' +
  '</div>';
}
function mpCommentOn(type, id, alsoFlag){
  mpSheet('Comment',
    '<textarea class="mp-in" id="mpc-body" rows="4" maxlength="' + MP_MAX_NOTE + '" placeholder="Say what you think, or what needs changing"></textarea>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpSaveComment(\'' + type + '\',' + (id ? "'" + id + "'" : 'null') + ',' + (alsoFlag ? 'true' : 'false') + ',this)">Post</button>' +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">Cancel</button>' +
    '</div>');
}
async function mpSaveComment(type, id, alsoFlag, btn){
  var body = (document.getElementById('mpc-body').value || '').trim();
  if (!body){ mpToast('Write something first.', true); return; }
  var free = mpLock(btn); if (!free) return;
  try {
    var res = await sb.from('menu_plan_comments').insert({ target_type:type, target_id:id, author:mpMe.name, body:body });
    if (mpErr(res, 'the comment')) return;
    if (alsoFlag && type === 'menu'){
      await sb.from('menu_plan_menus').update({ status:'changes_requested', updated_at:new Date().toISOString(), updated_by:mpMe.name }).eq('id', id);
    }
    mpCloseSheet(); await mpLoadAll(); mpRender(); mpToast('Comment posted');
  } finally { free(); }
}
async function mpResolveComment(id){
  var res = await sb.from('menu_plan_comments').update({ resolved:true }).eq('id', id);
  if (mpErr(res, 'the comment')) return;
  await mpLoadAll(); mpRender(); mpToast('Marked as done');
}

// ══ EMAIL SUMMARY ══════════════════════════════════════════════════════════
// Reuses the generic send-stock-take mailer (to / cc / subject / html) so this
// module needs NO new Edge Function deploy. Recipients come from
// menu_plan_members — never a hardcoded list that can drift.
async function mpEmailPlan(kind, note){
  var approvers = mpMembers.filter(function(m){ return m.role === 'approver' && m.email; }).map(function(m){ return m.email; });
  var chefs     = mpMembers.filter(function(m){ return m.role === 'chef'     && m.email; }).map(function(m){ return m.email; });
  if (!approvers.length && !chefs.length){ mpToast('Saved, but no email addresses are set for the team.', true); return; }

  var to = kind === 'submitted' ? approvers : chefs;
  var cc = kind === 'submitted' ? chefs     : approvers;
  var subject = kind === 'submitted'     ? "Menu Development Plan — submitted by " + mpMe.name
              : kind === 'approved'      ? "Menu Development Plan — approved"
              :                            "Menu Development Plan — changes requested";

  try {
    var r = await fetch(SUPABASE_URL + '/functions/v1/send-stock-take', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + SUPABASE_KEY },
      body: JSON.stringify({ to:to, cc:cc, subject:subject, html: mpEmailHtml(kind, note) })
    });
    if (r.ok) mpToast('Emailed to ' + to.join(', '));
    else mpToast('Saved in the app, but the email did not send.', true);
  } catch(e){
    mpToast('Saved in the app, but the email did not send.', true);
  }
}
function mpEmailHtml(kind, note){
  var tried = mpTriedCount(), approved = mpApprovedCount();
  var head = kind === 'submitted'  ? mpEsc(mpMe.name) + ' submitted the Menu Development Plan.'
           : kind === 'approved'   ? mpEsc(mpMe.name) + ' approved the Menu Development Plan.'
           :                         mpEsc(mpMe.name) + ' asked for changes to the Menu Development Plan.';

  var rows = mpMenus.map(function(m){
    var cells = MP_MONTHS.map(function(mo){
      var c = mpCellObj(m.id, mo.key);
      var day = mpCellDayLabel(c);
      return '<td style="border:1px solid #d8cbb6;padding:4px 5px;text-align:center;font-size:9px;' +
        (c ? 'background:' + MP_CELL_HEX[c.state] + ';color:#fff;font-weight:700;' : 'color:#bbb;') + '">' +
        (c ? MP_CELL_CODE[c.state] + (day ? '<br/>' + day : '') : '·') + '</td>';
    }).join('');
    return '<tr><td style="border:1px solid #d8cbb6;padding:4px 8px;font-size:11px;white-space:nowrap">' + mpEsc(m.name) + '</td>' + cells + '</tr>';
  }).join('');

  var briefs = mpMenus.map(function(m){
    var files = mpFilesFor(m.id);
    var docs = files.length
      ? '<div style="margin-top:4px;font-size:11px">' + files.map(function(f){
          return '&#128206; <a href="' + mpEsc(mpPublicUrl(f.file_path)) + '" style="color:#450207">' + mpEsc(f.file_name) + '</a>';
        }).join(' &nbsp; ') + '</div>'
      : '';
    return '<tr>' +
      '<td style="border:1px solid #d8cbb6;padding:6px 8px;font-size:12px"><b>' + mpEsc(m.name) + '</b>' + docs + '</td>' +
      '<td style="border:1px solid #d8cbb6;padding:6px 8px;font-size:12px">' + mpEsc(m.identity || '—') + '</td>' +
      '<td style="border:1px solid #d8cbb6;padding:6px 8px;font-size:12px">' + mpEsc(m.structure || '—') + '</td>' +
      '<td style="border:1px solid #d8cbb6;padding:6px 8px;font-size:12px">' + mpEsc(m.price || '—') + '</td>' +
    '</tr>';
  }).join('');

  var bySection = {};
  mpDishes.forEach(function(d){ (bySection[d.section] = bySection[d.section] || []).push(d); });
  var dishes = Object.keys(bySection).sort().map(function(sec){
    return '<p style="margin:12px 0 4px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#450207"><b>' + mpEsc(sec) + '</b></p>' +
      '<ul style="margin:0 0 4px 18px;padding:0">' + bySection[sec].map(function(d){
        return '<li style="font-size:12px;margin:2px 0">' + mpEsc(d.name_it) +
          ' <span style="color:#8a7a62">— ' + mpEsc(d.status) + (d.selling_price ? ' · ' + mpEsc(d.selling_price) : '') + '</span></li>';
      }).join('') + '</ul>';
  }).join('');

  return '<div style="font-family:Georgia,serif;color:#2C2422;max-width:820px">' +
    '<h2 style="color:#450207;font-weight:400;margin:0 0 4px">Menu Development Plan</h2>' +
    '<p style="font-size:13px;color:#6a5c4a;margin:0 0 16px">' + head + '</p>' +
    (note ? '<div style="background:#F5EEE1;border-left:4px solid #FA4700;padding:10px 14px;font-size:13px;margin-bottom:16px">' + mpEsc(note) + '</div>' : '') +
    '<p style="font-size:13px"><b>Sprint:</b> ' + tried + ' dishes tried (target ' + ((mpSprint && mpSprint.target_tried) || 60) + ') · ' +
      approved + ' approved (target ' + ((mpSprint && mpSprint.target_approved) || 30) + ')</p>' +

    '<h3 style="color:#450207;font-weight:400;margin:20px 0 6px">The year</h3>' +
    '<table style="border-collapse:collapse"><tr><th style="border:1px solid #d8cbb6;padding:4px 8px;font-size:10px">Menu</th>' +
      MP_MONTHS.map(function(mo){ return '<th style="border:1px solid #d8cbb6;padding:4px 5px;font-size:10px">' + MP_MON_NAMES[mo.m] + '</th>'; }).join('') +
    '</tr>' + rows + '</table>' +
    '<p style="font-size:10px;color:#8a7a62">De develop · Te testing · Ph photoshoot · La launch · Li live · Ch changing</p>' +

    '<h3 style="color:#450207;font-weight:400;margin:20px 0 6px">The menus</h3>' +
    '<table style="border-collapse:collapse;width:100%"><tr>' +
      ['Menu','Identity','Structure','Price'].map(function(h){
        return '<th style="border:1px solid #d8cbb6;padding:5px 8px;font-size:10px;text-align:left">' + h + '</th>'; }).join('') +
    '</tr>' + briefs + '</table>' +

    '<h3 style="color:#450207;font-weight:400;margin:20px 0 6px">The dishes (' + mpDishes.length + ')</h3>' +
    (dishes || '<p style="font-size:12px;color:#8a7a62">No dishes logged yet.</p>') +
  '</div>';
}
const MP_CELL_HEX = { Develop:'#C08A55', Testing:'#3D6E9E', Photoshooting:'#8E5AA8', Launch:'#FA4700', Live:'#3F7A4B', Changing:'#450207' };

// ══ SHEETS, CONFIRM, PROMPT ════════════════════════════════════════════════
// One bottom sheet pattern for everything. Never a browser alert()/prompt() —
// they look nothing like the app and are hostile on a phone.
function mpSheet(title, bodyHtml){
  mpCloseSheet();
  var ov = document.createElement('div');
  ov.id = 'mp-sheet'; ov.className = 'mp-ovl sheet';
  ov.innerHTML = '<div class="mp-sheet-box">' +
    '<div class="mp-sheet-h"><span>' + mpEsc(title) + '</span><button class="mp-x" onclick="mpDismissSheet()">&times;</button></div>' +
    '<div class="mp-sheet-body">' + bodyHtml + '</div></div>';
  ov.onclick = function(e){ if (e.target === ov) mpDismissSheet(); };
  document.body.appendChild(ov);
  // Anything typed, picked or tapped in here counts as work worth protecting on
  // the way out. Pills are buttons, not fields, so they need their own listener.
  mpSheetDirty = false;
  ov.addEventListener('input',  function(){ mpSheetDirty = true; }, true);
  ov.addEventListener('change', function(){ mpSheetDirty = true; }, true);
  ov.addEventListener('click', function(e){
    if (e.target && e.target.closest && e.target.closest('.mp-pill,.mp-datechip,.mp-pickopt')) mpSheetDirty = true;
  }, true);
  setTimeout(function(){ ov.classList.add('in'); }, 10);
}
// The SILENT close. Called by mpSheet itself and by every save handler that has
// just finished writing — it must never ask a question.
function mpCloseSheet(){
  var s = document.getElementById('mp-sheet');
  if (s) s.remove();
  mpPendingPhoto = undefined;
  mpSheetDirty = false;
}
// The close a PERSON asks for — the backdrop and the ×. One stray tap on the
// backdrop band used to bin a half-written dish, photo and all.
let mpSheetDirty = false;
function mpDismissSheet(){
  if (!mpSheetDirty && mpPendingPhoto === undefined){ mpCloseSheet(); return; }
  mpConfirm('Close without saving?', 'What you have typed here is not saved yet, and closing loses it.',
    'Discard it', { cancelLabel:'Keep editing', safeFirst:true })
    .then(function(ok){ if (ok) mpCloseSheet(); });
}
// One guard for every insert path. A save round-trip is ~840ms — long enough
// that tapping again is the sensible thing to do, and every one of those taps
// used to create a second row. Returns null if a save is already in flight;
// call the returned function to release the button (it re-enables on failure,
// because a permanently dead button is worse than the duplicate).
function mpLock(btn){
  if (!btn || !btn.tagName) return function(){};
  if (btn.disabled) return null;
  var was = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = 'Saving&hellip;';
  return function(){
    if (!document.body.contains(btn)) return;   // the sheet closed on success
    btn.disabled = false;
    btn.innerHTML = was;
  };
}
// Confirms NAME THE CONSEQUENCE — never "Are you sure?".
// opts (optional): { cancelLabel, safeFirst } — safeFirst puts the way back
// before the destructive button, for the ones where carrying on loses work.
function mpConfirm(title, what, actionLabel, opts){
  opts = opts || {};
  return new Promise(function(resolve){
    var yes = '<button class="mp-btn go" id="mpc-yes">' + mpEsc(actionLabel) + '</button>';
    var no  = '<button class="mp-btn ghost" id="mpc-no">' + mpEsc(opts.cancelLabel || 'Cancel') + '</button>';
    var ov = document.createElement('div');
    ov.className = 'mp-ovl confirm';
    ov.innerHTML = '<div class="mp-ovl-box small">' +
      '<div class="mp-ovl-title">' + mpEsc(title) + '</div>' +
      '<div class="mp-ovl-sub">' + mpEsc(what) + '</div>' +
      '<div class="mp-sheet-actions">' +
        (opts.safeFirst ? no + yes : yes + no) +
      '</div></div>';
    document.body.appendChild(ov);
    function done(v){ ov.remove(); resolve(v); }
    ov.querySelector('#mpc-yes').onclick = function(){ done(true); };
    ov.querySelector('#mpc-no').onclick  = function(){ done(false); };
    ov.onclick = function(e){ if (e.target === ov) done(false); };
  });
}
function mpPrompt(label, type, value){
  return new Promise(function(resolve){
    var field = type === 'textarea'
      ? '<textarea class="mp-in" id="mpp-in" rows="4" maxlength="' + MP_MAX_NOTE + '">' + mpEsc(value || '') + '</textarea>'
      : '<input class="mp-in" id="mpp-in" type="' + type + '" value="' + mpEsc(value == null ? '' : value) + '"/>';
    var ov = document.createElement('div');
    ov.className = 'mp-ovl confirm';
    ov.innerHTML = '<div class="mp-ovl-box small">' +
      '<div class="mp-ovl-title">' + mpEsc(label) + '</div>' + field +
      '<div class="mp-sheet-actions">' +
        '<button class="mp-btn go" id="mpp-ok">Save</button>' +
        '<button class="mp-btn ghost" id="mpp-no">Cancel</button>' +
      '</div></div>';
    document.body.appendChild(ov);
    function done(v){ ov.remove(); resolve(v); }
    ov.querySelector('#mpp-ok').onclick = function(){ done(document.getElementById('mpp-in').value); };
    ov.querySelector('#mpp-no').onclick = function(){ done(null); };
    ov.onclick = function(e){ if (e.target === ov) done(null); };
    setTimeout(function(){ try { document.getElementById('mpp-in').focus(); } catch(e){} }, 30);
  });
}

// ══ STYLE ══════════════════════════════════════════════════════════════════
// Scoped to this module. Uses the SOP brand palette (maroon / orange / cream /
// ink, Forum + Outfit) rather than the app-wide kitchen tokens, on purpose —
// this is the document leadership reads, and it should look like the SOPs.
const MP_STYLE = `<style id="mp-style">
@import url('https://fonts.googleapis.com/css2?family=Forum&family=Outfit:wght@300;400;500;600;700&display=swap');
#menuplan-view,.mp-ovl{
  --mp-maroon:#450207; --mp-orange:#FA4700; --mp-cream:#E8D9C7; --mp-cream-l:#F5EEE1;
  --mp-ink:#2C2422; --mp-line:#DCCDB8; --mp-mute:#8A7A66;
  --mp-idea:#9A938C; --mp-trying:#E8A33D; --mp-testing:#3D6E9E; --mp-approved:#2F8F83; --mp-costing:#B06A1E; --mp-banked:#3F7A4B; --mp-retired:#BDB4A8;
  --mp-develop:#C08A55; --mp-photoshooting:#8E5AA8; --mp-launch:#FA4700; --mp-live:#3F7A4B; --mp-changing:#450207;
  font-family:'Outfit',system-ui,sans-serif; color:var(--mp-ink);
  /* one pasted 600-character "name" must never widen the page it sits on */
  overflow-wrap:anywhere;
}
#menuplan-view{background:var(--mp-cream-l);padding:0 0 60px}
.mp-wrap{max-width:1180px;margin:0 auto;padding:14px 14px 0}
.mp-loading{color:var(--mp-mute);font-size:14px;padding:20px 0}
.mp-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.mp-h1{font-family:'Forum',Georgia,serif;font-size:27px;line-height:1.05;color:var(--mp-maroon)}
.mp-h1sub{font-size:11.5px;color:var(--mp-mute);margin-top:3px}
.mp-me{flex:none;background:#fff;border:1px solid var(--mp-line);border-radius:20px;padding:7px 13px;font:600 12.5px 'Outfit',sans-serif;color:var(--mp-maroon);cursor:pointer}
.mp-me span{display:block;font-weight:400;font-size:9.5px;color:var(--mp-mute);letter-spacing:.6px;text-transform:uppercase}

/* tabs — they WRAP rather than scroll: the strip hid its own scrollbar, so the
   fifth tab sat 30px off the right of a phone screen with nothing to say so */
.mp-tabs{display:flex;flex-wrap:wrap;gap:0 4px;margin:13px 0 0;padding:0 0 1px}
.mp-tab{flex:none;background:transparent;border:none;border-bottom:2.5px solid transparent;padding:9px 3px;margin-right:12px;font:500 14px 'Outfit',sans-serif;color:var(--mp-mute);cursor:pointer;white-space:nowrap}
.mp-tab.on{color:var(--mp-maroon);border-bottom-color:var(--mp-orange);font-weight:600}
.mp-tab i{display:inline-block;margin-left:5px;font-style:normal;font-size:10.5px;background:var(--mp-cream);color:var(--mp-maroon);border-radius:9px;padding:1px 6px;font-weight:600}
.mp-body{padding-top:14px;display:flex;flex-direction:column;gap:12px}

/* cards */
.mp-card{background:#fff;border:1px solid var(--mp-line);border-radius:12px;padding:14px}
.mp-card-h{font-family:'Forum',Georgia,serif;font-size:17px;color:var(--mp-maroon);margin-bottom:10px}
.mp-hint{font-size:12.5px;color:var(--mp-mute);line-height:1.45}
.mp-hint em{font-style:italic}
.mp-empty{font-size:13px;color:var(--mp-mute);padding:8px 0;font-style:italic}
.mp-empty.ok{color:var(--mp-banked);font-style:normal;font-weight:500}
.mp-empty.big{background:#fff;border:1px dashed var(--mp-line);border-radius:12px;padding:26px 18px;text-align:center;line-height:1.6;font-style:normal}
.mp-fine{font-size:11px;color:var(--mp-mute)}
.mp-why{font-size:11.5px;color:var(--mp-mute);margin-top:7px}
.mp-statusline{font-size:13px;color:var(--mp-ink);margin-bottom:10px}

/* banners */
.mp-banner{border-radius:12px;padding:12px 14px;font-size:13.5px;line-height:1.5}
.mp-banner.warn{background:#FFF3E8;border:1px solid #F5C79C;color:#8A3B00}
.mp-banner.ok{background:#EAF3EC;border:1px solid #B6D4BC;color:#2C5C36}

/* buttons */
.mp-btn{font:600 13px 'Outfit',sans-serif;border-radius:9px;padding:10px 15px;cursor:pointer;border:1px solid var(--mp-line);background:#fff;color:var(--mp-maroon);-webkit-tap-highlight-color:transparent}
.mp-btn.go{background:var(--mp-maroon);border-color:var(--mp-maroon);color:#fff}
.mp-btn.warn{background:var(--mp-orange);border-color:var(--mp-orange);color:#fff}
.mp-btn.ghost{background:#fff}
.mp-btn.small{padding:8px 12px;font-size:12px}
.mp-btn.danger{color:#A32A1A;border-color:#E3BDB5}
.mp-btn:disabled{opacity:.45;cursor:not-allowed}
.mp-btn:active:not(:disabled){transform:translateY(1px)}
.mp-big{width:100%;background:var(--mp-maroon);color:#fff;border:none;border-radius:12px;padding:15px;font:600 15.5px 'Outfit',sans-serif;cursor:pointer;-webkit-tap-highlight-color:transparent}
.mp-big.ghost{background:#fff;color:var(--mp-maroon);border:1px dashed var(--mp-line)}
.mp-big:active{transform:translateY(1px)}
/* padded so the tap target clears 32px on a phone even though it reads as text */
.mp-link{background:none;border:none;color:var(--mp-orange);font:500 12.5px 'Outfit',sans-serif;cursor:pointer;padding:8px 2px;text-decoration:underline;-webkit-tap-highlight-color:transparent}
.mp-actions{display:flex;gap:8px;flex-wrap:wrap}

/* sprint bars */
.mp-bar-wrap{margin-bottom:13px}
.mp-bar-top{display:flex;justify-content:space-between;align-items:baseline;font-size:13px;margin-bottom:5px}
.mp-bar-top strong{font-family:'Forum',Georgia,serif;font-size:17px;color:var(--mp-maroon)}
.mp-bar-wrap.hit .mp-bar-top strong{color:var(--mp-banked)}
.mp-hitmark{font-style:normal;color:var(--mp-banked);font-size:14px}
.mp-bar{height:11px;background:var(--mp-cream);border-radius:6px;overflow:hidden}
.mp-bar i{display:block;height:100%;border-radius:6px;transition:width .35s ease}
.mp-celebrate{background:linear-gradient(135deg,var(--mp-cream-l),var(--mp-cream));border:1px solid var(--mp-banked);border-radius:10px;padding:10px 12px;font-size:13px;color:var(--mp-ink);margin-bottom:13px;line-height:1.4}
.mp-celebrate strong{color:var(--mp-banked)}
.mp-sprint-meta{font-size:11.5px;color:var(--mp-mute);border-top:1px solid var(--mp-line);padding-top:9px}
.mp-next{font-size:14px;margin-bottom:10px}
.mp-next span{display:block;font-size:11.5px;color:var(--mp-mute);margin-top:2px}

/* where you're at — positive progress row */
.mp-progress{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.mp-stat{background:var(--mp-cream-l);border:1px solid var(--mp-line);border-radius:10px;padding:10px 6px;text-align:center;display:flex;flex-direction:column;gap:2px}
.mp-stat b{font-family:'Forum',Georgia,serif;font-size:20px;color:var(--mp-maroon);line-height:1}
.mp-stat span{font-size:10px;color:var(--mp-mute);letter-spacing:.3px}
.mp-progress-note{font-size:12px;color:var(--mp-mute);margin-top:10px;font-style:italic}
@media(max-width:420px){.mp-progress{grid-template-columns:repeat(2,1fr)}}
/* next steps */
.mp-todo{display:flex;flex-direction:column;gap:6px}
.mp-todo-row{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:var(--mp-cream-l);border:1px solid var(--mp-line);border-radius:9px;padding:10px 12px;font:400 13.5px 'Outfit',sans-serif;color:var(--mp-ink);cursor:pointer}
.mp-todo-n{flex:none;min-width:26px;height:26px;border-radius:50%;background:var(--mp-orange);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12.5px;padding:0 6px}
.mp-todo-go{margin-left:auto;color:var(--mp-mute);font-size:19px;line-height:1}

/* filters */
.mp-filters{background:#fff;border:1px solid var(--mp-line);border-radius:12px;padding:11px}
.mp-search{width:100%;border:1px solid var(--mp-line);border-radius:9px;padding:11px 13px;font:400 15px 'Outfit',sans-serif;color:var(--mp-ink);background:var(--mp-cream-l)}
.mp-filter-row{display:flex;gap:6px;overflow-x:auto;margin-top:8px;padding-bottom:2px;scrollbar-width:none}
.mp-filter-row::-webkit-scrollbar{display:none}
.mp-sel{flex:none;border:1px solid var(--mp-line);border-radius:8px;padding:8px 9px;font:400 12.5px 'Outfit',sans-serif;background:#fff;color:var(--mp-ink);max-width:160px}
.mp-filter-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:9px;font-size:11.5px;color:var(--mp-mute)}
.mp-viewtog{margin-left:auto;display:inline-flex;border:1px solid var(--mp-line);border-radius:8px;overflow:hidden}
.mp-viewtog button{background:#fff;border:none;padding:6px 12px;font:500 12px 'Outfit',sans-serif;color:var(--mp-mute);cursor:pointer}
.mp-viewtog button.on{background:var(--mp-maroon);color:#fff}

/* dish cards */
.mp-dishlist{display:flex;flex-direction:column;gap:9px}
.mp-dish{background:#fff;border:1px solid var(--mp-line);border-radius:12px;padding:11px;display:flex;align-items:flex-start;gap:10px}
.mp-dish-main{display:flex;gap:11px;flex:1;min-width:0;cursor:pointer;background:none;border:none;text-align:left;padding:0}
.mp-dish-img{width:58px;height:58px;border-radius:9px;object-fit:cover;flex:none;background:var(--mp-cream)}
.mp-dish-txt{min-width:0;flex:1}
.mp-dish-name{font-family:'Forum',Georgia,serif;font-size:17px;color:var(--mp-maroon);line-height:1.15}
.mp-cbadge{display:inline-block;margin-left:6px;font-style:normal;font-family:'Outfit',sans-serif;font-size:10px;font-weight:700;background:var(--mp-orange);color:#fff;border-radius:9px;padding:1px 6px;vertical-align:middle}
.mp-dish-desc{font-size:12.5px;color:var(--mp-ink);opacity:.8;margin-top:2px;line-height:1.35}
.mp-dish-meta{font-size:11px;color:var(--mp-mute);margin-top:4px}
.mp-dish-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}
.mp-tag{font-size:10px;background:var(--mp-cream);color:var(--mp-maroon);border-radius:5px;padding:2px 6px;font-weight:500}
.mp-tag.more{background:transparent;color:var(--mp-mute)}
.mp-dish-all{display:flex;gap:3px;margin-top:5px}
.mp-all{width:18px;height:18px;border-radius:50%;background:var(--mp-cream-l);border:1px solid var(--mp-line);color:var(--mp-maroon);font-size:9.5px;font-weight:700;display:flex;align-items:center;justify-content:center}

/* status chips */
.mp-chip{display:inline-block;border-radius:20px;padding:4px 10px;font:600 11px 'Outfit',sans-serif;color:#fff;border:none;white-space:nowrap}
.mp-chip.tapme{cursor:pointer;flex:none;align-self:flex-start}
.mp-chip.s-idea{background:var(--mp-idea)}
.mp-chip.s-trying{background:var(--mp-trying)}
.mp-chip.s-testing{background:var(--mp-testing)}
.mp-chip.s-approved{background:var(--mp-approved)}
.mp-chip.s-costing{background:var(--mp-costing)}
.mp-chip.s-retired{background:var(--mp-retired)}

/* kanban */
.mp-board{display:flex;gap:9px;overflow-x:auto;padding-bottom:8px;scrollbar-width:thin}
.mp-col{flex:none;width:238px;background:#fff;border:1px solid var(--mp-line);border-radius:12px;padding:9px;display:flex;flex-direction:column}
.mp-col.over{border-color:var(--mp-orange);box-shadow:0 0 0 2px rgba(250,71,0,.18)}
/* on a laptop all five columns should be on screen at once — the board is only
   useful if you can see the whole flow without scrolling sideways */
@media(min-width:1080px){.mp-board{overflow-x:visible}.mp-col{width:auto;flex:1 1 0;min-width:0}}
.mp-col-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.mp-col-h i{font-style:normal;font-size:12px;color:var(--mp-mute);font-weight:600}
.mp-col-body{display:flex;flex-direction:column;gap:7px;min-height:60px}
.mp-col-empty{color:var(--mp-line);text-align:center;padding:14px 0}
.mp-dish.on-board{flex-direction:column;align-items:stretch;gap:8px;cursor:grab}
.mp-dish.on-board .mp-dish-img{width:100%;height:92px}
.mp-dish.on-board .mp-dish-main{flex-direction:column}

/* calendar */
.mp-calhead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mp-calhead .mp-hint{flex:1;min-width:160px}
.mp-legend{display:flex;gap:11px;flex-wrap:wrap;font-size:11.5px;color:var(--mp-mute)}
.mp-leg{display:inline-flex;align-items:center;gap:5px}
/* two-up action row (Quick idea / Add a dish) */
.mp-addrow-two{display:flex;gap:8px}
.mp-addrow-two .mp-big{flex:1}
/* finish-this-idea tray */
.mp-tray{border-color:var(--mp-orange)}
.mp-traylist{display:flex;flex-direction:column;gap:7px}
.mp-trayrow{display:flex;align-items:center;gap:7px;background:var(--mp-cream-l);border:1px solid var(--mp-line);border-radius:9px;padding:7px 8px;flex-wrap:wrap}
.mp-trayname{background:none;border:none;font-family:'Forum',Georgia,serif;font-size:15px;color:var(--mp-maroon);text-align:left;cursor:pointer;padding:2px 0;flex:1;min-width:110px}
.mp-trayselect{border:1px solid var(--mp-line);border-radius:7px;padding:6px 7px;font:400 12px 'Outfit',sans-serif;background:#fff;color:var(--mp-ink);max-width:150px}
/* ownership reassurance */
.mp-owns{font-size:12px;color:var(--mp-mute);background:var(--mp-cream-l);border:1px solid var(--mp-line);border-radius:9px;padding:9px 11px;margin-top:14px;line-height:1.45}
.mp-owns strong{color:var(--mp-maroon)}
/* calendar LIST view */
.mp-callist{display:flex;flex-direction:column;gap:8px}
.mp-calrow{background:#fff;border:1px solid var(--mp-line);border-radius:11px;padding:11px 12px}
.mp-calrow-h{margin-bottom:7px}
.mp-calrow-h .mp-cal-namebtn{font-family:'Forum',Georgia,serif;font-size:17px;color:var(--mp-maroon);text-decoration:none;padding:0}
.mp-calchips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.mp-calchip{border:none;color:#fff;border-radius:20px;padding:6px 11px;font:600 11.5px 'Outfit',sans-serif;cursor:pointer;-webkit-tap-highlight-color:transparent}
.mp-calchip.add{background:#fff;color:var(--mp-maroon);border:1px dashed var(--mp-line);font-weight:500}
.mp-calchip:active{transform:scale(.96)}
/* month picker */
.mp-monthgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:7px}
.mp-monthbtn{background:var(--mp-cream-l);border:1px solid var(--mp-line);border-radius:9px;padding:11px 4px;font:600 13px 'Outfit',sans-serif;color:var(--mp-ink);cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:1px}
.mp-monthbtn em{font-style:normal;font-size:9px;color:var(--mp-mute)}
.mp-monthbtn.set{color:#fff;border-color:transparent}.mp-monthbtn.set em{color:rgba(255,255,255,.85)}
.mp-sw,.mp-swatch{width:13px;height:13px;border-radius:3px;display:inline-block;flex:none;border:1px solid rgba(0,0,0,.08)}
.mp-swatch{width:20px;height:20px}
.c-develop{background:var(--mp-develop)}.c-testing{background:var(--mp-testing)}.c-photoshooting{background:var(--mp-photoshooting)}
.c-launch{background:var(--mp-launch)}.c-live{background:var(--mp-live)}.c-changing{background:var(--mp-changing)}.c-none{background:var(--mp-cream-l)}
.mp-calwrap{overflow-x:auto;background:#fff;border:1px solid var(--mp-line);border-radius:12px;padding:8px}
.mp-cal{border-collapse:separate;border-spacing:3px;width:100%}
.mp-cal th{font-weight:500;font-size:11px;color:var(--mp-mute);text-align:center;padding:2px}
.mp-cal th span{display:block;font-weight:600;color:var(--mp-maroon);font-size:11.5px}
.mp-cal th em{font-style:normal;font-size:9px;opacity:.7}
.mp-cal-menu{text-align:left!important;font-size:12px!important;color:var(--mp-ink)!important;white-space:nowrap;padding-right:9px!important;position:sticky;left:0;background:#fff;z-index:2;min-width:118px}
.mp-cell{width:100%;min-width:38px;height:38px;border:1px solid var(--mp-line);border-radius:6px;cursor:pointer;font:700 11px 'Outfit',sans-serif;color:#fff;-webkit-tap-highlight-color:transparent;line-height:1.05;padding:0 1px}
.mp-cell small{display:block;font-size:8.5px;font-weight:600;opacity:.92}
.mp-cell.c-none{color:transparent}
.mp-cell:active{transform:scale(.94)}
/* grouped calendar row: name button + variant dropdown */
.mp-cal-namebtn{background:none;border:none;font:inherit;color:var(--mp-ink);text-align:left;cursor:pointer;padding:9px 2px;text-decoration:underline;text-decoration-color:var(--mp-line);-webkit-tap-highlight-color:transparent}
.mp-cal-group{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.mp-varsel{border:1px solid var(--mp-line);border-radius:6px;padding:2px 4px;font:600 11px 'Outfit',sans-serif;background:var(--mp-cream-l);color:var(--mp-maroon)}
/* grouped brief card bar */
.mp-group-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:11px 14px 0}
.mp-group-name{font-family:'Forum',Georgia,serif;font-size:16px;color:var(--mp-maroon)}
.mp-varrow{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--mp-line)}
.mp-varlbl{width:26px;height:26px;flex:none;border-radius:50%;background:var(--mp-maroon);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600}
.mp-varname{flex:1;font-size:13.5px;min-width:0}
/* guide card */
.mp-guide{background:#fff;border:1px solid var(--mp-line);border-radius:12px;padding:4px 14px}
.mp-guide summary{display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:10px 0;list-style:none}
.mp-guide summary::-webkit-details-marker{display:none}
.mp-guide-k{font-family:'Forum',Georgia,serif;font-size:17px;color:var(--mp-maroon)}
.mp-guide-hint{font-size:11px;color:var(--mp-mute)}
.mp-guide-steps{display:flex;flex-direction:column;gap:9px;padding:4px 0 14px}
.mp-guide-step{display:flex;gap:11px;align-items:flex-start}
.mp-guide-n{flex:none;width:24px;height:24px;border-radius:50%;background:var(--mp-orange);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px}
.mp-guide-step strong{display:block;font-size:13.5px;color:var(--mp-ink)}
.mp-guide-step span span{font-size:12px;color:var(--mp-mute);line-height:1.4}
/* costing block */
.mp-costing{margin-top:16px;border-top:2px solid var(--mp-line);padding-top:12px}
.mp-readval{font-size:14px;color:var(--mp-ink);padding:2px 0}
.mp-costed{color:var(--mp-banked);font-weight:600}
.mp-dish-cost{font-size:11px;color:var(--mp-costing);margin-top:5px;font-weight:500}
/* send-to-costing list */
.mp-sendlist{display:flex;flex-direction:column;gap:7px;max-height:44vh;overflow:auto}
.mp-sendrow{display:flex;align-items:center;gap:10px;background:var(--mp-cream-l);border:1px solid var(--mp-line);border-radius:9px;padding:9px 11px;cursor:pointer}
.mp-sendck{width:20px;height:20px;flex:none}
.mp-sendname{display:block;font-size:14px;color:var(--mp-ink);font-weight:500}
.mp-sendsub{display:block;font-size:11.5px;color:var(--mp-mute)}
.mp-warn{color:#A32A1A;font-style:normal}
/* typed tasting dishes */
.mp-manual{font-style:normal;font-size:9.5px;background:var(--mp-cream);color:var(--mp-mute);border-radius:5px;padding:1px 5px;vertical-align:middle}
.mp-manual-list{display:flex;flex-direction:column;gap:5px;margin-bottom:8px}
.mp-manual-row{display:flex;align-items:center;justify-content:space-between;gap:8px;background:var(--mp-cream-l);border:1px solid var(--mp-line);border-radius:8px;padding:7px 11px;font-size:13.5px}
.mp-addrow{display:flex;gap:7px}
.mp-addrow .mp-in{flex:1}
.mp-pill.cell i{margin-right:5px}

/* menu briefs */
.mp-card.menu{padding:0;overflow:hidden}
.mp-menu-h{display:flex;align-items:flex-start;justify-content:space-between;gap:9px;padding:13px 14px 10px;background:var(--mp-cream-l);border-bottom:1px solid var(--mp-line)}
.mp-menu-name{font-family:'Forum',Georgia,serif;font-size:19px;color:var(--mp-maroon);line-height:1.1}
.mp-menu-sub{font-size:11.5px;color:var(--mp-mute);margin-top:2px}
.mp-mstatus{flex:none;font-size:10px;font-weight:600;border-radius:20px;padding:3px 9px;background:var(--mp-cream);color:var(--mp-maroon)}
.mp-mstatus.s-approved{background:var(--mp-banked);color:#fff}
.mp-mstatus.s-submitted{background:var(--mp-testing);color:#fff}
.mp-mstatus.s-changes_requested{background:var(--mp-orange);color:#fff}
.mp-menu-body{padding:12px 14px}
.mp-menu-id{font-size:14px;line-height:1.45}
.mp-menu-st{font-size:12.5px;color:var(--mp-mute);margin-top:5px}
.mp-menu-id.missing,.mp-menu-st.missing{color:#B08A6A;font-style:italic}
.mp-menu-facts{display:flex;gap:16px;flex-wrap:wrap;margin-top:11px;border-top:1px solid var(--mp-line);padding-top:10px}
.mp-menu-facts span{font-size:10px;letter-spacing:.8px;text-transform:uppercase;color:var(--mp-mute);display:flex;flex-direction:column;gap:1px}
.mp-menu-facts b{font-family:'Forum',Georgia,serif;font-size:15px;letter-spacing:0;text-transform:none;color:var(--mp-maroon)}
.mp-menu-actions{display:flex;gap:7px;flex-wrap:wrap;padding:0 14px 13px}

/* two lanes: main menus (heavy) vs campaigns/events (light) */
.mp-lane-h{display:flex;align-items:baseline;gap:9px;margin:6px 2px 2px}
.mp-lane-h.camp{margin-top:16px}
.mp-lane-title{font-family:'Forum',Georgia,serif;font-size:18px;color:var(--mp-maroon)}
.mp-lane-note{font-size:11px;color:var(--mp-mute)}
/* campaign card — a season with a theme + nested dates */
.mp-card.camp{padding:0;overflow:hidden}
.mp-camp-head{background:var(--mp-maroon);padding:14px 15px}
.mp-camp-eyebrow{font-size:10px;letter-spacing:1.4px;text-transform:uppercase;color:#E0B5A0}
.mp-camp-title{font-family:'Forum',Georgia,serif;font-size:21px;color:#fff;line-height:1.1;margin-top:2px}
.mp-camp-range{font-size:11px;color:#EBC7B6;margin-top:3px}
.mp-camp-blurb{font-size:12px;color:#F0DCCF;margin-top:6px;line-height:1.45}
.mp-camp-body{padding:12px 14px 13px}
.mp-camp-core{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:var(--mp-cream-l);border:1px solid var(--mp-line);border-radius:11px;padding:11px 12px;cursor:pointer}
.mp-camp-core-t{font-family:'Forum',Georgia,serif;font-size:15px;color:var(--mp-maroon)}
.mp-camp-core-s{font-size:11px;color:var(--mp-mute);margin-top:2px}
.mp-camp-core-go{margin-left:auto;font-size:12px;color:var(--mp-orange);font-weight:600;white-space:nowrap}
.mp-camp-datesh{font-size:9.5px;letter-spacing:.8px;text-transform:uppercase;color:var(--mp-mute);margin:13px 0 6px}
/* event rows — light, date-led */
.mp-eventlist{display:flex;flex-direction:column;gap:7px}
.mp-eventrow{display:flex;align-items:center;gap:11px;width:100%;text-align:left;background:var(--mp-cream-l);border:1px solid var(--mp-line);border-radius:10px;padding:9px 11px;cursor:pointer;font-family:'Outfit',sans-serif}
.mp-event-date{flex:none;width:38px;text-align:center;line-height:1}
.mp-event-date b{font-family:'Forum',Georgia,serif;font-size:16px;color:var(--mp-maroon);display:block}
.mp-event-date em{font-style:normal;font-size:9px;text-transform:uppercase;letter-spacing:.5px;color:var(--mp-mute)}
.mp-event-cal{font-size:17px;filter:grayscale(.2)}
.mp-event-main{flex:1;min-width:0;border-left:1px solid var(--mp-line);padding-left:11px}
.mp-event-name{display:block;font-size:13.5px;color:var(--mp-ink);font-weight:500}
.mp-event-need{display:block;font-size:10.5px;color:var(--mp-mute);margin-top:1px}
.mp-event-need.ok{color:var(--mp-banked)}
.mp-event-need.part{color:var(--mp-costing)}
.mp-event-go{flex:none;color:var(--mp-mute);font-size:20px;line-height:1}
/* event build sheet — fixed date + light job */
.mp-eventfixed{display:flex;align-items:center;gap:11px;background:var(--mp-cream-l);border:1px solid var(--mp-line);border-radius:11px;padding:11px 12px;margin:6px 0 2px}
.mp-eventfixed .mp-event-cal{font-size:22px}
.mp-eventfixed-d{font-family:'Forum',Georgia,serif;font-size:16px;color:var(--mp-maroon)}
.mp-eventfixed-n{font-size:10.5px;color:var(--mp-mute);margin-top:1px}
.mp-eventdishes{margin-top:14px;border-top:1px solid var(--mp-line);padding-top:12px}
.mp-eventdishes-h{display:flex;justify-content:space-between;align-items:baseline;font-size:11px;letter-spacing:.8px;text-transform:uppercase;color:var(--mp-mute);margin-bottom:8px}
.mp-eventdishes-h b{font-family:'Forum',Georgia,serif;font-size:13px;letter-spacing:0;text-transform:none;color:var(--mp-maroon)}
.mp-eventdishes-list{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:9px}

/* menu documents (uploaded Word / PDF) */
.mp-files{margin-top:11px;border-top:1px solid var(--mp-line);padding-top:10px;display:flex;flex-direction:column;gap:6px}
.mp-files-h{font-size:10px;letter-spacing:1.1px;text-transform:uppercase;color:var(--mp-mute)}
.mp-file{display:flex;align-items:center;gap:8px;background:var(--mp-cream-l);border:1px solid var(--mp-line);border-radius:9px;padding:7px 9px}
.mp-file-open{display:flex;align-items:center;gap:9px;flex:1;min-width:0;text-decoration:none}
.mp-file-ic{flex:none;width:34px;height:34px;border-radius:7px;display:flex;align-items:center;justify-content:center;font:700 9px 'Outfit',sans-serif;color:#fff;letter-spacing:.3px;background:var(--mp-mute)}
.mp-file-ic.pdf{background:#C0392B}.mp-file-ic.doc{background:#2B5797}.mp-file-ic.img{background:#2F8F83}
.mp-file-meta{min-width:0}
.mp-file-name{display:block;font-size:13px;color:var(--mp-ink);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mp-file-sub{display:block;font-size:11px;color:var(--mp-mute)}
.mp-file-x{flex:none;background:none;border:none;font-size:20px;line-height:1;color:var(--mp-mute);cursor:pointer;padding:0 4px}
.mp-file-x:hover{color:#A32A1A}

/* tastings */
.mp-tlist{display:flex;flex-direction:column;gap:5px;padding:0 14px}
.mp-trow{display:flex;align-items:center;gap:9px;background:var(--mp-cream-l);border:1px solid var(--mp-line);border-radius:8px;padding:9px 11px;cursor:pointer;text-align:left;width:100%}
.mp-tname{flex:1;font-size:13.5px;color:var(--mp-ink);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mp-tscore{font-family:'Forum',Georgia,serif;font-size:14px;color:var(--mp-maroon)}
.mp-tdec{font-size:10.5px;font-weight:600;border-radius:20px;padding:3px 9px;background:var(--mp-cream);color:var(--mp-mute)}
.mp-tdec.d-approve{background:var(--mp-banked);color:#fff}
.mp-tdec.d-rework{background:var(--mp-trying);color:#fff}
.mp-tdec.d-reject{background:var(--mp-retired);color:#fff}

/* comments */
.mp-comments.compact{border-top:1px solid var(--mp-line);padding:12px 14px 14px;background:var(--mp-cream-l)}
.mp-cmt{border-left:3px solid var(--mp-orange);background:var(--mp-cream-l);border-radius:0 8px 8px 0;padding:9px 11px;margin-bottom:7px}
.mp-comments.compact .mp-cmt{background:#fff}
.mp-cmt.done{border-left-color:var(--mp-line);opacity:.62}
.mp-cmt-h{display:flex;justify-content:space-between;gap:8px;font-size:11.5px;color:var(--mp-mute);margin-bottom:3px}
.mp-cmt-h strong{color:var(--mp-maroon);font-weight:600}
.mp-cmt-b{font-size:13.5px;line-height:1.45;white-space:pre-wrap}
.mp-cmt-done{font-size:10.5px;color:var(--mp-banked);font-weight:600;margin-top:4px}

/* forms */
.mp-lab{display:block;font-size:11px;letter-spacing:1.1px;text-transform:uppercase;color:var(--mp-mute);margin:13px 0 5px}
.mp-lab em{text-transform:none;letter-spacing:0;font-style:italic;opacity:.85}
.mp-in{width:100%;border:1px solid var(--mp-line);border-radius:9px;padding:11px 12px;font:400 15px 'Outfit',sans-serif;color:var(--mp-ink);background:#fff;-webkit-appearance:none}
.mp-in:focus{outline:none;border-color:var(--mp-maroon);box-shadow:0 0 0 2px rgba(69,2,7,.1)}
textarea.mp-in{resize:vertical;line-height:1.45}
.mp-two{display:flex;gap:9px}.mp-two>div{flex:1;min-width:0}
/* searchable single-pick — replaces a native select for long lists */
.mp-searchpick{position:relative}
.mp-picklist{position:relative;margin-top:5px;max-height:180px;overflow-y:auto;border:1px solid var(--mp-line);border-radius:9px;background:#fff;box-shadow:0 6px 18px rgba(44,36,34,.12);display:flex;flex-direction:column}
.mp-pickopt{background:#fff;border:none;border-bottom:1px solid var(--mp-cream-l);text-align:left;padding:10px 12px;font:400 14px 'Outfit',sans-serif;color:var(--mp-ink);cursor:pointer}
.mp-pickopt:last-child{border-bottom:none}
.mp-pickopt:hover,.mp-pickopt:active{background:var(--mp-cream-l)}
.mp-pills{display:flex;gap:6px;flex-wrap:wrap}
.mp-pill{border:1px solid var(--mp-line);background:#fff;border-radius:20px;padding:8px 13px;font:500 12.5px 'Outfit',sans-serif;color:var(--mp-mute);cursor:pointer;-webkit-tap-highlight-color:transparent}
.mp-pill.on{background:var(--mp-maroon);border-color:var(--mp-maroon);color:#fff}
/* the control a chef uses most, standing, at a tasting — 44px minimum on both
   sides, not the 46×37 it was */
.mp-pill.score{min-width:46px;min-height:44px;padding:0 13px;font-size:15px;display:inline-flex;align-items:center;justify-content:center}
/* allergen suggestions: never pre-ticked, one tap each to accept */
.mp-suggest{background:#fff;border:1px solid var(--mp-line);border-radius:20px;padding:6px 11px;margin:3px 2px 0 0;font:600 11.5px 'Outfit',sans-serif;color:var(--mp-maroon);cursor:pointer;-webkit-tap-highlight-color:transparent}
.mp-suggest:active{transform:translateY(1px)}
/* a tasting is several people scoring the same dish, side by side */
.mp-scoreothers{background:var(--mp-cream);border:1px solid var(--mp-line);border-radius:11px;padding:10px 12px;margin-top:10px}
.mp-scorerow{padding:6px 0;border-top:1px solid var(--mp-line)}
.mp-scorerow:first-of-type{border-top:none}
.mp-scorewho{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--mp-mute)}
.mp-scorewho strong{color:var(--mp-maroon);font-weight:600}
.mp-scorenote{font-size:12.5px;color:var(--mp-ink);margin-top:2px;line-height:1.4;white-space:pre-wrap}
/* drag (or tap) a menu into the order you want */
.mp-calrow{position:relative}
.mp-grip{position:absolute;right:8px;top:8px;width:44px;height:44px;line-height:42px;text-align:center;border-radius:8px;background:var(--mp-cream-l);border:1px solid var(--mp-line);color:var(--mp-maroon);font-size:15px;cursor:grab;user-select:none;touch-action:none;-webkit-tap-highlight-color:transparent}
.mp-calrow.mp-dragging{background:var(--mp-cream-l);box-shadow:0 6px 18px rgba(69,2,7,.22);position:relative;z-index:50}
body.mp-dragging-active{cursor:grabbing;user-select:none}
.mp-calrow-h{padding-right:56px}
.mp-more{margin-top:14px;border-top:1px solid var(--mp-line);padding-top:6px}
.mp-more summary{font-size:13px;color:var(--mp-orange);cursor:pointer;padding:6px 0;font-weight:500}
.mp-photo-row{display:flex;align-items:center;gap:12px;margin-top:14px}
.mp-photo-prev{width:74px;height:74px;border-radius:10px;object-fit:cover;flex:none;background:var(--mp-cream)}
.mp-photo-prev.empty{display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--mp-mute);border:1px dashed var(--mp-line)}
.mp-dishfoot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:14px;border-top:1px solid var(--mp-line);padding-top:11px}

/* status / cell pickers */
.mp-statuslist{display:flex;flex-direction:column;gap:7px}
.mp-statusrow{display:flex;align-items:center;gap:11px;width:100%;text-align:left;background:#fff;border:1px solid var(--mp-line);border-radius:10px;padding:11px 13px;cursor:pointer;font-family:'Outfit',sans-serif}
.mp-statusrow.now{border-color:var(--mp-maroon);box-shadow:0 0 0 1px var(--mp-maroon)}
.mp-statusrow.locked{opacity:.5;cursor:not-allowed}
.mp-statusnote{font-size:12.5px;color:var(--mp-mute);flex:1}
.mp-statusnote strong{color:var(--mp-ink);font-weight:600}
.mp-locked{font-size:10.5px;color:var(--mp-orange);font-weight:600}

/* overlays + sheets */
.mp-ovl{position:fixed;inset:0;z-index:100060;background:rgba(44,36,34,.55);display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto;font-family:'Outfit',system-ui,sans-serif}
.mp-ovl.sheet{align-items:flex-end;padding:0}
@media(min-width:760px){.mp-ovl.sheet{align-items:center;padding:20px}}
.mp-ovl-box{background:var(--mp-cream-l);border-radius:14px;max-width:520px;width:100%;padding:20px;box-shadow:0 16px 50px rgba(44,36,34,.3)}
.mp-ovl-box.small{max-width:420px}
.mp-ovl-title{font-family:'Forum',Georgia,serif;font-size:22px;color:var(--mp-maroon);line-height:1.15}
.mp-ovl-sub{font-size:13px;color:var(--mp-mute);margin:5px 0 14px;line-height:1.5}
.mp-sheet-box{background:var(--mp-cream-l);width:100%;max-width:620px;max-height:92vh;display:flex;flex-direction:column;border-radius:16px 16px 0 0;box-shadow:0 -8px 40px rgba(44,36,34,.3);transform:translateY(14px);transition:transform .18s ease}
@media(min-width:760px){.mp-sheet-box{border-radius:16px}}
.mp-ovl.sheet.in .mp-sheet-box{transform:none}
.mp-sheet-h{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:15px 16px 12px;border-bottom:1px solid var(--mp-line)}
.mp-sheet-h span{font-family:'Forum',Georgia,serif;font-size:19px;color:var(--mp-maroon);line-height:1.15}
.mp-x{background:none;border:none;font-size:27px;line-height:1;color:var(--mp-mute);cursor:pointer;padding:0 4px}
.mp-sheet-body{padding:4px 16px 22px;overflow-y:auto;-webkit-overflow-scrolling:touch}
.mp-sheet-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}
.mp-sheet-actions .mp-btn{flex:1;min-width:110px}

/* who-am-I */
.mp-who-list{display:flex;flex-direction:column;gap:8px}
.mp-who-btn{display:flex;align-items:center;gap:11px;text-align:left;background:#fff;border:1px solid var(--mp-line);border-radius:11px;padding:12px 13px;cursor:pointer;font-family:'Outfit',sans-serif}
.mp-who-btn:active{background:var(--mp-cream)}
.mp-who-ini{width:38px;height:38px;border-radius:50%;background:var(--mp-maroon);color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;flex:none}
.mp-who-name{display:block;font-size:15px;font-weight:600;color:var(--mp-ink)}
.mp-who-role{display:block;font-size:11.5px;color:var(--mp-mute)}

/* toast */
.mp-toast{position:fixed;left:50%;bottom:22px;transform:translate(-50%,90px);z-index:100070;background:var(--mp-maroon);color:#fff;border-radius:22px;padding:11px 20px;font:500 13.5px 'Outfit',sans-serif;box-shadow:0 8px 26px rgba(44,36,34,.32);opacity:0;transition:transform .22s ease,opacity .22s ease;max-width:88vw;text-align:center;pointer-events:none}
.mp-toast.show{transform:translate(-50%,0);opacity:1}
.mp-toast.bad{background:#8A2A1A}
.mp-tick{font-weight:700}

/* ══ WHAT'S ON — the front door. Built for a 375px phone held in one hand:
   nothing he needs in the first ten seconds sits below the fold, and every
   tappable thing clears 44px. ══════════════════════════════════════════════ */
.mp-askbox{display:block;width:100%;text-align:left;background:#fff;border:1.5px dashed var(--mp-line);border-radius:14px;padding:15px 16px;cursor:pointer;font-family:'Outfit',sans-serif;-webkit-tap-highlight-color:transparent}
/* the menus we already run — under the box, never instead of it */
.mp-cat{margin-top:18px;padding-top:14px;border-top:1px solid var(--mp-line)}
.mp-cat-h{font:600 12px 'Outfit',sans-serif;letter-spacing:.05em;text-transform:uppercase;color:var(--mp-maroon);opacity:.75;margin-bottom:8px}
.mp-cat-q{margin-bottom:8px}
.mp-cat-list{max-height:266px;overflow-y:auto;-webkit-overflow-scrolling:touch;display:flex;flex-direction:column;gap:6px}
.mp-cat-row{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;min-height:44px;text-align:left;background:#fff;border:1px solid var(--mp-line);border-radius:10px;padding:9px 12px;cursor:pointer;font-family:'Outfit',sans-serif;-webkit-tap-highlight-color:transparent}
.mp-cat-row:active{background:var(--mp-cream-l)}
.mp-cat-n{font:500 14px 'Outfit',sans-serif;color:var(--mp-ink)}
.mp-cat-d{font:500 12px 'Outfit',sans-serif;color:var(--mp-maroon);white-space:nowrap}
.mp-cat-d.quiet{opacity:.5;font-weight:400}
.mp-cat-none{font:400 13px 'Outfit',sans-serif;color:var(--mp-ink);opacity:.7;padding:8px 2px}
/* a phase says when it starts and when it finishes, and both are fields */
.mp-stagerow.wide{display:block}
.mp-stagerow-t{display:flex;align-items:center;gap:9px}
.mp-tldates{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0 2px 25px}
.mp-tld{display:flex;flex-direction:column;gap:3px}
.mp-tld>span{font:600 10.5px 'Outfit',sans-serif;letter-spacing:.05em;text-transform:uppercase;color:var(--mp-maroon);opacity:.7}
.mp-tld-in{min-height:44px;padding:8px 10px;font:500 13.5px 'Outfit',sans-serif}
@media(max-width:380px){.mp-tldates{grid-template-columns:1fr;margin-left:0}}
.mp-askbox:active{background:var(--mp-cream)}
.mp-askbox.ask{border-style:solid;border-color:var(--mp-maroon);background:var(--mp-maroon)}
.mp-askbox.ask .mp-askbox-q{color:#fff}
.mp-askbox.ask .mp-askbox-h{color:rgba(255,255,255,.72)}
.mp-askbox-q{display:block;font-family:'Forum',Georgia,serif;font-size:19px;color:var(--mp-maroon);line-height:1.2}
.mp-askbox-h{display:block;font-size:12.5px;color:var(--mp-mute);margin-top:5px;line-height:1.4}
.mp-askin{min-height:96px}

.mp-hsec{font-family:'Forum',Georgia,serif;font-size:16px;color:var(--mp-maroon);margin:6px 0 -4px;letter-spacing:.2px}
.mp-hsec.wait{color:var(--mp-orange)}

.mp-hrow{background:#fff;border:1px solid var(--mp-line);border-radius:12px;padding:12px 13px 6px}
.mp-hrow.wait{border-color:#F5C79C;background:#FFF9F4}
.mp-hrow-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.mp-hrow-name{font-size:15.5px;font-weight:600;color:var(--mp-ink);line-height:1.25;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.mp-hrow-when{flex:none;text-align:right;font-size:12.5px;font-weight:600;color:var(--mp-maroon);line-height:1.25}
.mp-hrow-when em{display:block;font-style:normal;font-size:11px;font-weight:400;color:var(--mp-mute)}
.mp-hrow-from{font-size:11.5px;color:var(--mp-orange);margin-top:4px;font-weight:500}
.mp-hrow-next{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;min-height:44px;margin-top:8px;background:none;border:none;border-top:1px solid var(--mp-line);padding:11px 0 10px;font:500 13px 'Outfit',sans-serif;color:var(--mp-ink);text-align:left;cursor:pointer;-webkit-tap-highlight-color:transparent}
.mp-hrow-next:active{opacity:.6}
.mp-hrow-go{flex:none;color:var(--mp-orange);font-weight:600;white-space:nowrap}

.mp-hcamp{background:var(--mp-cream);border:1px solid var(--mp-line);border-radius:14px;padding:11px;display:flex;flex-direction:column;gap:8px}
.mp-hcamp-h{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:2px 3px}
.mp-hcamp-t{font-family:'Forum',Georgia,serif;font-size:17px;color:var(--mp-maroon)}
.mp-hcamp-r{font-size:11.5px;color:var(--mp-mute)}
.mp-hcamp-n{font-size:11.5px;color:var(--mp-mute);padding:0 3px}

/* read-back chips — what the system understood, editable */
.mp-chips{display:flex;flex-direction:column;gap:10px;margin-top:10px}
.mp-chip{position:relative;background:#fff;border:1px solid var(--mp-line);border-radius:12px;padding:11px 12px}
/* room for the × so a 44px target doesn't sit on top of the name he's typing */
.mp-chip-name{font-size:15px;font-weight:600;margin-bottom:8px;padding-right:46px}
.mp-chip-kinds{margin-bottom:6px}
.mp-chip-known{font-size:11.5px;color:var(--mp-mute);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mp-chip-x{position:absolute;top:2px;right:2px;width:44px;height:44px;background:none;border:none;font-size:21px;line-height:1;color:var(--mp-mute);cursor:pointer}

/* how long have you got */
.mp-windows{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin:12px 0 4px}
.mp-window{min-height:60px;background:#fff;border:1px solid var(--mp-line);border-radius:11px;padding:11px 10px;font:600 15px 'Outfit',sans-serif;color:var(--mp-maroon);cursor:pointer;text-align:left}
.mp-window:active{background:var(--mp-cream)}
.mp-window em{display:block;font-style:normal;font-size:11px;font-weight:400;color:var(--mp-mute);margin-top:3px}

/* the timeline */
.mp-tl{margin:14px 0 4px;touch-action:none}
.mp-tl-track{position:relative;height:44px;background:var(--mp-cream);border-radius:9px;margin-bottom:8px;overflow:visible}
.mp-tl-track.photo{height:34px;background:repeating-linear-gradient(45deg,var(--mp-cream),var(--mp-cream) 6px,#efe4d3 6px,#efe4d3 12px)}
.mp-tl-seg{position:absolute;top:0;bottom:0;border-radius:7px;display:flex;align-items:center;justify-content:center;overflow:hidden;color:#fff;box-shadow:inset 0 0 0 1px rgba(255,255,255,.35)}
.mp-tl-seg b{font-size:10px;font-weight:600;letter-spacing:.2px;padding:0 4px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
.mp-tl-track.photo .mp-tl-seg{cursor:grab}
.mp-tl-seg.s-development{background:var(--mp-develop)}
.mp-tl-seg.s-testing{background:var(--mp-testing)}
.mp-tl-seg.s-approval{background:var(--mp-approved)}
.mp-tl-seg.s-costing{background:var(--mp-costing)}
.mp-tl-seg.s-photoshoot{background:var(--mp-photoshooting)}
/* the grab area is 28px wide even though the line reads as 3px — a 3px target
   on a phone is a target you miss */
.mp-tl-h{position:absolute;top:-5px;bottom:-5px;width:28px;margin-left:-14px;cursor:col-resize;z-index:3;touch-action:none}
.mp-tl-h::after{content:'';position:absolute;left:50%;margin-left:-1.5px;top:0;bottom:0;width:3px;border-radius:2px;background:var(--mp-maroon);box-shadow:0 0 0 2px rgba(255,255,255,.7)}
.mp-tl-off{font-size:11.5px;color:var(--mp-mute);padding:9px 10px;display:block;font-style:italic}

.mp-stagelist{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.mp-stagerow{display:flex;align-items:center;gap:9px;background:#fff;border:1px solid var(--mp-line);border-radius:10px;padding:9px 10px;min-height:48px}
.mp-stage-n{flex:1;min-width:0}
.mp-stage-n strong{display:block;font-size:13.5px;color:var(--mp-ink)}
.mp-stage-n em{display:block;font-style:normal;font-size:11.5px;color:var(--mp-mute);margin-top:2px}
/* Skip / − / + are the controls he uses most on this screen — they get a real
   thumb-sized target, not the 33px the shared .small button gives them */
.mp-stagerow .mp-btn{min-height:44px;min-width:44px;padding:8px 10px}
.mp-stage-skipped{display:flex;gap:7px;flex-wrap:wrap;margin-top:4px}
.mp-stage-skipped .mp-btn{min-height:44px}
.mp-swatch.s-development{background:var(--mp-develop)}
.mp-swatch.s-testing{background:var(--mp-testing)}
.mp-swatch.s-approval{background:var(--mp-approved)}
.mp-swatch.s-costing{background:var(--mp-costing)}
.mp-swatch.s-photoshoot{background:var(--mp-photoshooting)}

/* what Francesco asked for, shown to the kitchen in his words */
.mp-reqnote{background:#FFF3E8;border:1px solid #F5C79C;border-radius:11px;padding:11px 13px;font-size:13px;line-height:1.5;color:#5a3a1a;white-space:pre-wrap;margin-bottom:10px}
.mp-reqnote-h{font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:#8A3B00;margin-bottom:5px;font-weight:600}
.mp-reqnote-by{font-size:11.5px;color:#8A3B00;margin-top:7px;font-weight:600}

@media(max-width:520px){
  .mp-h1{font-size:23px}
  .mp-sel{max-width:132px}
  .mp-menu-facts{gap:12px}
  .mp-windows{grid-template-columns:1fr 1fr}
}
</style>`;
