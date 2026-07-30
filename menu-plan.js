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
// The drag handle. It used to be ❦ — a floral heart, which reads as decoration,
// not as "hold this and move the row". Drawn instead, in the app's own colour,
// so it looks the same on every phone: emoji are rendered by the OS and each
// one arrives in a different style nobody chose.
const MP_GRIP_SVG =
  '<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true" focusable="false">' +
    '<g fill="currentColor">' +
      '<circle cx="2" cy="3" r="1.35"/><circle cx="8" cy="3" r="1.35"/>' +
      '<circle cx="2" cy="8" r="1.35"/><circle cx="8" cy="8" r="1.35"/>' +
      '<circle cx="2" cy="13" r="1.35"/><circle cx="8" cy="13" r="1.35"/>' +
    '</g>' +
  '</svg>';
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
// The Plan is the first thing he sees: everything the kitchen is developing,
// with the box to add to it at the top. Dishes is where the day-to-day happens,
// but the plan is what he opens the module to look at.
let mpTab      = 'home'; // home (The Plan) | plan (Progress) | dishes | calendar | briefs | tastings

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
// Only menus that are actually on the plan can be tagged, scheduled or listed.
// A menu sitting in the pick-list is real but nobody has started it, so showing
// it on the Calendar, on Menus, or in a dish's tags puts work on screen that
// does not exist yet — the confusion Francesco caught: The Plan said nothing
// had started while two other tabs were full.
function mpMenuTagOptions(){
  return mpMenus.filter(mpOnPlan).map(function(m){ return m.name; });
}

// ── menu grouping (Set Menu A/B/C collapse to one row + dropdown) ────────────
// mpMenuRows() turns the flat menu list into display rows: a standalone menu is
// its own row; menus sharing a menu_group become ONE row carrying every variant.
// The calendar and the briefs both render from this, so grouping is defined once.
function mpMenuRows(){
  var rows = [], seen = {};
  mpMenus.filter(mpOnPlan).forEach(function(m){
    if (m.menu_group){
      if (seen[m.menu_group]) return;
      seen[m.menu_group] = true;
      var variants = mpMenus.filter(function(x){ return x.menu_group === m.menu_group && mpOnPlan(x); })
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
  // Two tabs used to both claim to be the plan. The list of what the kitchen is
  // developing IS the plan, so it takes the name and comes first; the old
  // overview becomes Progress, which is what it was always really showing.
  var tabs = [
    { k:'home',     label:'The Plan' },
    { k:'plan',     label:'Progress' },
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
    // The mic follows him from tab to tab — it is the one control in this
    // module that is in the same place on every screen.
    mpMicFab() +
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
  return 'Each thing is agreed on The Plan';
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
          // Tap the phase itself to move it. Going through "Change the plan" to
          // shift one photoshoot was the long way round for the commonest job
          // there is — the date moved, everything else stayed put.
          var inner =
            '<i class="mp-swatch s-' + String(c.stage).toLowerCase() + '"></i>' +
            '<span class="mp-stage-n"><strong>' + mpEsc(c.stage) + '</strong>' +
            '<em>' + mpEsc(mpDateLabel(c.starts_on)) + ' &rarr; ' + mpEsc(mpDateLabel(c.ends_on || c.starts_on)) + '</em></span>';
          return mpCanAuthor()
            ? '<button class="mp-stagerow tap" onclick="mpEditStage(\'' + c.id + '\')">' + inner +
                '<span class="mp-stage-go">Change &rsaquo;</span></button>'
            : '<div class="mp-stagerow">' + inner + '</div>';
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
// ── moving one phase, on its own ───────────────────────────────────────────
// One phase, its two dates, Save. It writes that single calendar row and
// nothing else — the other phases are not read, not rewritten, not shifted.
// This is the short way round for the job that comes up most: the photoshoot
// moved, the rest of the plan did not.
function mpEditStage(rowId){
  var c = mpCal.filter(function(x){ return x.id === rowId; })[0];
  if (!c) return;
  if (!mpCanAuthor()){ mpToast('Only the chefs and Francesco change the dates.', true); return; }
  var m = mpMenus.filter(function(x){ return x.id === c.menu_id; })[0];
  var from = String(c.starts_on).slice(0, 10);
  var to   = String(c.ends_on || c.starts_on).slice(0, 10);
  mpSheet(c.stage,
    '<div class="mp-hint">' + mpEsc(m ? m.name : '') + ' &middot; moving this changes ' +
      '<strong>' + mpEsc(c.stage) + '</strong> only. The other phases stay where they are.</div>' +
    '<div class="mp-tldates">' +
      mpTlDateCell('mp-es-f', 'Starts',   from, '') +
      mpTlDateCell('mp-es-t', 'Finishes', to,   '') +
    '</div>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpSaveStage(this,\'' + c.id + '\')">Save</button>' +
      '<button class="mp-btn ghost" onclick="mpEditStageBack(\'' + c.menu_id + '\')">Cancel</button>' +
    '</div>');
}
function mpEditStageBack(menuId){ mpCloseSheet(); mpReviewPlan(menuId); }
async function mpSaveStage(btn, rowId){
  var c = mpCal.filter(function(x){ return x.id === rowId; })[0];
  if (!c) return;
  var f = document.getElementById('mp-es-f'), t = document.getElementById('mp-es-t');
  var from = f && f.value, to = t && t.value;
  if (!from){ mpToast('It needs a start date.', true); return; }
  if (!to) to = from;
  if (to < from){ mpToast(c.stage + ' would finish before it starts. Check the two dates.', true); return; }
  var free = mpLock(btn); if (!free) return;
  try {
    var res = await sb.from('menu_plan_calendar')
      .update({ starts_on:from, ends_on:to, updated_at:new Date().toISOString(), updated_by:mpMe.name })
      .eq('id', rowId);
    if (mpErr(res, c.stage)) return;
    await mpLoadAll();
    mpToast(c.stage + ' moved');
    mpCloseSheet(); mpRender(); mpReviewPlan(c.menu_id);
  } finally { free(); }
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

// ══ PROGRESS ═══════════════════════════════════════════════════════════════
// What progress actually means in this kitchen, in Francesco's own words: work
// arrives as an idea and a rhythm, Danilo proposes dishes, they get tested —
// "could be 1 dish or 15" — and approved ones go to costing. So progress is
// dishes moving, menu by menu.
//
// It used to be a scoreboard: "60 tried / 30 approved" against a target nobody
// set. That measured a sprint the kitchen does not run. Gone, with the tutorial
// card that explained a flow that no longer exists and the year grid that the
// Calendar tab already owns.
function mpStageCounts(dishes){
  var c = { Idea:0, Trying:0, Testing:0, Approved:0, Costing:0 };
  dishes.forEach(function(d){ if (c[d.status] !== undefined) c[d.status]++; });
  return c;
}
function mpCountChips(c){
  return ['Idea','Trying','Testing','Approved','Costing'].filter(function(k){ return c[k]; })
    .map(function(k){
      return '<span class="mp-pchip s-' + k.toLowerCase() + '"><b>' + c[k] + '</b>' + k.toLowerCase() + '</span>';
    }).join('');
}
function mpRenderPlan(){
  var all = mpStageCounts(mpDishes);
  var next = mpNextTasting();

  // A menu is worth a row once it has a dish on it. The rest are named at the
  // bottom rather than hidden — an empty menu is a fact, not a failure.
  var rows = mpMenus.map(function(m){ return { m:m, dishes:mpMenuDishPool(m.name) }; });
  var withDishes = rows.filter(function(r){ return r.dishes.length; });
  var empty      = rows.filter(function(r){ return !r.dishes.length && mpOnPlan(r.m); });
  withDishes.sort(function(a, b){
    var aw = mpWhenLive(a.m) || '9999', bw = mpWhenLive(b.m) || '9999';
    return aw < bw ? -1 : aw > bw ? 1 : 0;
  });

  return '<div class="mp-body">' +

    // ── everything, at a glance ──
    '<div class="mp-card">' +
      '<div class="mp-card-h">Dishes right now</div>' +
      '<div class="mp-progress">' +
        mpStat(mpDishes.length, 'in total') +
        mpStat(all.Testing, 'testing') +
        mpStat(all.Approved, 'approved') +
        mpStat(all.Costing, 'costing') +
      '</div>' +
    '</div>' +

    // ── menu by menu ──
    '<div class="mp-card">' +
      '<div class="mp-card-h">Menu by menu</div>' +
      (withDishes.length
        ? withDishes.map(function(r){
            var when = mpWhenLive(r.m);
            var ready = r.dishes.filter(function(d){ return MP_RANK[d.status] >= 3; }).length;
            return '<button class="mp-prow" onclick="mpMenuPage(\'' + r.m.id + '\')">' +
              '<div class="mp-prow-t">' +
                '<span class="mp-prow-n">' + mpEsc(r.m.name) + '</span>' +
                (when ? '<span class="mp-prow-w">' + mpEsc(mpDateLabel(when)) + ' &middot; ' + mpEsc(mpHowFar(when)) + '</span>' : '') +
              '</div>' +
              '<div class="mp-prow-c">' + mpCountChips(mpStageCounts(r.dishes)) + '</div>' +
              '<div class="mp-prow-s">' + ready + ' of ' + r.dishes.length + ' ready to go on it</div>' +
            '</button>';
          }).join('')
        : '<div class="mp-empty">No dishes on any menu yet. They show up here as soon as one is tagged.</div>') +
      (empty.length
        ? '<div class="mp-progress-note">Nothing on yet: ' +
            empty.map(function(r){ return mpEsc(r.m.name); }).join(' &middot; ') + '</div>'
        : '') +
    '</div>' +

    // ── the only date that matters day to day ──
    '<div class="mp-card">' +
      '<div class="mp-card-h">Next tasting</div>' +
      (next
        ? '<div class="mp-next"><strong>' + mpEsc(mpDateLabel(next.session_date)) + (next.session_time ? ' &middot; ' + mpEsc(next.session_time) : '') + '</strong>' +
          (next.title ? ' &middot; ' + mpEsc(next.title) : '') +
          '<span>' + next.items.length + ' dish' + (next.items.length === 1 ? '' : 'es') + ' attached</span></div>'
        : '<div class="mp-empty">No tasting booked yet.</div>') +
      '<button class="mp-btn ghost" onclick="mpGo(\'tastings\')">Open tastings</button>' +
    '</div>' +

    (mpIsCostController()
      ? '<div class="mp-card"><div class="mp-card-h">Your job</div><div class="mp-hint">Open ' +
        '<button class="mp-link" onclick="mpGo(\'dishes\')">Dishes</button>, filter to <strong>Costing</strong>, ' +
        'read each cost sheet and mark it Costed.</div></div>'
      : '') +
  '</div>';
}
function mpStat(value, label){
  return '<div class="mp-stat"><b>' + mpEsc(String(value)) + '</b><span>' + mpEsc(label) + '</span></div>';
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
          (mpCanAuthor() ? ' Drag the handle on the right to put them in the order you want — or tap it.' : '')
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
      (canOrder ? '<span class="mp-grip" title="Drag to reorder — or tap to move it" onpointerdown="mpGripDown(event,\'' + mpEsc(key) + '\')">' + MP_GRIP_SVG + '</span>' : '') +
      '<div class="mp-calrow-h">' +
        (row.group
          ? '<span class="mp-cal-group"><button class="mp-cal-namebtn" onclick="mpGroupManage(\'' + mpEsc(row.group) + '\')">' + mpEsc(row.group) + '</button>' +
            '<select class="mp-varsel" onchange="mpSelectVariant(\'' + mpEsc(row.group) + '\', this.value)">' +
              row.variants.map(function(v){ return '<option value="' + v.id + '"' + (v.id === menu.id ? ' selected' : '') + '>' + mpEsc(v.variant_label || v.name) + '</option>'; }).join('') +
            '</select></span>'
          : '<button class="mp-cal-namebtn" onclick="mpMenuActions(\'' + menu.id + '\')">' + mpEsc(menu.name) + '</button>') +
        (mpCanAuthor() ? '<button class="mp-btn ghost small mp-sched" onclick="mpMenuLifecycle(\'' + menu.id + '\')">Schedule</button>' : '') +
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
      '<button class="mp-btn go" onclick="mpMenuPage(\'' + m.id + '\')">See the menu (' + pool + ' dish' + (pool === 1 ? '' : 'es') + ')</button>' +
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

// ══ THE MENU ITSELF ════════════════════════════════════════════════════════
// One menu, on one page: what it is, and what it reads like with the dishes
// currently in it. Nothing in the module showed this — you could tag dishes to
// Family Brunch and never see Family Brunch. Sections come out in kitchen
// order, and a dish that is not approved yet is still shown, just marked, so
// he watches the menu fill up instead of waiting for it.
function mpMenuPage(id){
  var m = mpMenus.find(function(x){ return x.id === id; });
  if (!m) return;
  var pool = mpMenuDishPool(m.name);
  var bySection = MP_SECTIONS.map(function(sec){
    return { sec:sec, dishes: pool.filter(function(d){ return (d.section || 'Other') === sec; }) };
  }).filter(function(g){ return g.dishes.length; });
  var ready = pool.filter(function(d){ return MP_RANK[d.status] >= 3; }).length;

  mpSheet(m.name,
    // ── what it is ──
    '<div class="mp-mp-id">' +
      (m.identity
        ? mpEsc(m.identity)
        : '<span class="missing">No concept yet &mdash; one line: what is this menu?</span>') +
      (m.structure ? '<div class="mp-mp-st">' + mpEsc(m.structure) + '</div>' : '') +
      (m.price ? '<div class="mp-mp-st">' + mpEsc(m.price) + '</div>' : '') +
    '</div>' +
    (mpCanAuthor()
      ? '<div class="mp-sheet-actions"><button class="mp-btn ghost" onclick="mpEditMenu(\'' + m.id + '\')">Edit what it is</button></div>'
      : '') +

    // ── the menu as it reads ──
    '<div class="mp-mp-h">The menu' +
      (pool.length ? '<em>' + ready + ' of ' + pool.length + ' approved</em>' : '') + '</div>' +
    (bySection.length
      ? '<div class="mp-mp-menu">' + bySection.map(function(g){
          return '<div class="mp-mp-sec">' + mpEsc(g.sec) + '</div>' +
            g.dishes.map(function(d){
              var on = MP_RANK[d.status] >= 3;
              return '<div class="mp-mp-dish' + (on ? '' : ' soft') + '">' +
                '<div class="mp-mp-n">' + mpEsc(d.name_it || 'Untitled') +
                  (d.selling_price ? '<span class="mp-mp-p">' + mpEsc(d.selling_price) + '</span>' : '') + '</div>' +
                (d.description_en ? '<div class="mp-mp-d">' + mpEsc(d.description_en) + '</div>' : '') +
                (on ? '' : '<div class="mp-mp-w">' + mpEsc(d.status) + ' &mdash; not approved yet</div>') +
                (mpCanAuthor()
                  ? '<div class="mp-mp-acts">' +
                      '<button class="mp-btn ghost small" onclick="mpOpenDish(\'' + d.id + '\')">Open</button>' +
                      '<button class="mp-btn ghost small" onclick="mpDropFromMenu(\'' + d.id + '\',\'' + m.id + '\')">Take off</button>' +
                    '</div>'
                  : '') +
              '</div>';
            }).join('');
        }).join('') + '</div>'
      : '<div class="mp-empty">Nothing on it yet. Put a dish on it below, and the menu builds itself here.</div>') +

    // ── putting dishes on it ──
    (mpCanAuthor()
      ? '<div class="mp-sheet-actions">' +
          '<button class="mp-btn go" onclick="mpAddToMenu(\'' + m.id + '\')">Put a dish on this menu</button>' +
          '<button class="mp-btn ghost" onclick="mpCloseSheet()">Close</button>' +
        '</div>'
      : '<div class="mp-sheet-actions"><button class="mp-btn ghost" onclick="mpCloseSheet()">Close</button></div>') +
    mpCommentBlock('menu', m.id, 'Talk about this menu', true));
}
// Pick from the dishes that exist, or start a new one — either way it lands on
// this menu. Search, because by December there will be a lot of them.
function mpAddToMenu(menuId){
  var m = mpMenus.find(function(x){ return x.id === menuId; });
  if (!m) return;
  var off = mpDishes.filter(function(d){ return !(d.for_menus || []).includes(m.name); })
                    .sort(function(a, b){ return String(a.name_it || '').localeCompare(String(b.name_it || '')); });
  mpSheet('Put a dish on ' + m.name,
    '<button class="mp-big" onclick="mpNewDishFor(\'' + m.id + '\')">+ A dish that doesn&rsquo;t exist yet</button>' +
    (off.length
      ? '<div class="mp-cat">' +
          '<div class="mp-cat-h">Or one you have already logged</div>' +
          '<input class="mp-in mp-cat-q" type="text" id="mpik-cat-q" placeholder="Start typing to narrow it down" ' +
            'autocomplete="off" oninput="mpCatFilter()"/>' +
          '<div class="mp-cat-list" id="mpik-cat-list">' +
            off.map(function(d){
              return '<button type="button" class="mp-cat-row" data-n="' + mpEsc(String(d.name_it || '').toLowerCase()) + '" ' +
                'onclick="mpPutOnMenu(\'' + d.id + '\',\'' + m.id + '\')">' +
                '<span class="mp-cat-n">' + mpEsc(d.name_it || 'Untitled') + '</span>' +
                '<span class="mp-cat-d quiet">' + mpEsc(d.section || '') + '</span></button>';
            }).join('') +
          '</div>' +
          '<div class="mp-cat-none" id="mpik-cat-none" style="display:none">Nothing by that name &mdash; add it as a new dish above.</div>' +
        '</div>'
      : '') +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn ghost" onclick="mpMenuPage(\'' + m.id + '\')">Back to the menu</button>' +
    '</div>');
}
// A new dish started from a menu arrives already tagged to it. Reuses the
// one-shot seed the Duplicate button already uses, so there is one way in.
function mpNewDishFor(menuId){
  var m = mpMenus.find(function(x){ return x.id === menuId; });
  if (!m) return;
  mpCloseSheet();
  mpDuplicateSeed = { fromName:null, section:'', for_menus:[m.name], allergens:[], notes:'' };
  mpDishForm(null);
}
async function mpPutOnMenu(dishId, menuId){
  var d = mpDishes.find(function(x){ return x.id === dishId; });
  var m = mpMenus.find(function(x){ return x.id === menuId; });
  if (!d || !m) return;
  var next = (d.for_menus || []).slice();
  if (next.indexOf(m.name) < 0) next.push(m.name);
  var res = await sb.from('menu_plan_dishes')
    .update({ for_menus:next, updated_at:new Date().toISOString() }).eq('id', dishId);
  if (mpErr(res, 'the dish')) return;
  await mpLoadAll();
  mpToast(d.name_it + ' is on ' + m.name);
  mpMenuPage(menuId);
}
// Taking a dish off a menu never deletes the dish — it loses the tag and stays
// in Dishes. Said out loud, because "Take off" next to a dish reads like delete.
async function mpDropFromMenu(dishId, menuId){
  var d = mpDishes.find(function(x){ return x.id === dishId; });
  var m = mpMenus.find(function(x){ return x.id === menuId; });
  if (!d || !m) return;
  var ok = await mpConfirm('Take “' + d.name_it + '” off ' + m.name + '?',
    'The dish stays in Dishes with everything on it — it just comes off this menu.', 'Take it off');
  if (!ok) return;
  var next = (d.for_menus || []).filter(function(x){ return x !== m.name; });
  var res = await sb.from('menu_plan_dishes')
    .update({ for_menus:next, updated_at:new Date().toISOString() }).eq('id', dishId);
  if (mpErr(res, 'the dish')) return;
  await mpLoadAll();
  mpToast('Taken off ' + m.name);
  mpMenuPage(menuId);
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
.mp-calrow-h{display:flex;align-items:center;gap:10px;margin-bottom:7px}
.mp-sched{margin-left:auto;flex:0 0 auto}
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
.mp-grip{position:absolute;right:8px;top:8px;width:44px;height:44px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:var(--mp-cream-l);border:1px solid var(--mp-line);color:var(--mp-maroon);opacity:.65;cursor:grab;user-select:none;touch-action:none;-webkit-tap-highlight-color:transparent}
.mp-grip:active{opacity:1;cursor:grabbing}
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
/* a phase in the saved plan is tappable — that IS how you move it */
.mp-stagerow.tap{display:flex;align-items:center;gap:9px;width:100%;min-height:56px;text-align:left;background:#fff;border:1px solid var(--mp-line);border-radius:10px;padding:9px 12px;cursor:pointer;font-family:'Outfit',sans-serif;-webkit-tap-highlight-color:transparent}
.mp-stagerow.tap:active{background:var(--mp-cream-l)}
.mp-stage-go{margin-left:auto;font:600 12px 'Outfit',sans-serif;color:var(--mp-maroon);white-space:nowrap}
/* the menu itself — what it reads like with the dishes currently on it */
.mp-mp-id{font:400 14.5px 'Outfit',sans-serif;color:var(--mp-ink);line-height:1.5;padding:2px 0 4px}
.mp-mp-id .missing{opacity:.55;font-style:italic}
.mp-mp-st{font:400 13px 'Outfit',sans-serif;opacity:.7;margin-top:3px}
.mp-mp-h{display:flex;align-items:baseline;gap:8px;margin:16px 0 8px;font:600 12px 'Outfit',sans-serif;letter-spacing:.06em;text-transform:uppercase;color:var(--mp-maroon)}
.mp-mp-h em{margin-left:auto;font:400 11.5px 'Outfit',sans-serif;text-transform:none;letter-spacing:0;opacity:.65}
.mp-mp-menu{background:#fff;border:1px solid var(--mp-line);border-radius:12px;padding:14px 15px}
.mp-mp-sec{font:600 11px 'Outfit',sans-serif;letter-spacing:.08em;text-transform:uppercase;color:var(--mp-maroon);opacity:.75;margin:14px 0 7px;padding-bottom:4px;border-bottom:1px solid var(--mp-line)}
.mp-mp-sec:first-child{margin-top:0}
.mp-mp-dish{padding:8px 0}
.mp-mp-dish.soft{opacity:.62}
.mp-mp-n{display:flex;gap:10px;font:600 15px 'Cormorant Garamond',Georgia,serif;color:var(--mp-ink)}
.mp-mp-p{margin-left:auto;font:500 13px 'Outfit',sans-serif;color:var(--mp-maroon);white-space:nowrap}
.mp-mp-d{font:400 13px 'Outfit',sans-serif;opacity:.75;margin-top:2px}
.mp-mp-w{font:500 11.5px 'Outfit',sans-serif;color:var(--mp-maroon);opacity:.8;margin-top:3px}
.mp-mp-acts{display:flex;gap:6px;margin-top:6px}
/* Progress: one row per menu, dishes counted by stage */
.mp-prow{display:block;width:100%;text-align:left;background:#fff;border:1px solid var(--mp-line);border-radius:11px;padding:11px 13px;margin-bottom:8px;cursor:pointer;font-family:'Outfit',sans-serif;-webkit-tap-highlight-color:transparent}
.mp-prow:active{background:var(--mp-cream-l)}
.mp-prow-t{display:flex;align-items:baseline;gap:10px}
.mp-prow-n{font:600 14.5px 'Outfit',sans-serif;color:var(--mp-ink)}
.mp-prow-w{margin-left:auto;font:500 11.5px 'Outfit',sans-serif;color:var(--mp-maroon);white-space:nowrap}
.mp-prow-c{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.mp-prow-s{font:400 12px 'Outfit',sans-serif;opacity:.65;margin-top:7px}
.mp-pchip{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;font:500 11.5px 'Outfit',sans-serif;background:var(--mp-cream-l);color:var(--mp-ink)}
.mp-pchip b{font:700 12.5px 'Outfit',sans-serif}
.mp-pchip.s-trying{background:#FBE8CC}
.mp-pchip.s-testing{background:#D8E7F3}
.mp-pchip.s-approved{background:#D6EBDC}
.mp-pchip.s-costing{background:#E6DCEE}
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

/* ── the mic, on every screen ──────────────────────────────────────────── */
/* Bottom-right, above the thumb, clear of the tab strip at the top. It is the
   only thing in this module that follows him from tab to tab. */
.mp-mic-fab{position:fixed;right:16px;bottom:22px;z-index:60;width:62px;height:62px;border-radius:50%;
  border:none;background:var(--mp-maroon,#400207);color:#fff;font-size:26px;line-height:1;
  box-shadow:0 6px 20px rgba(0,0,0,.28);cursor:pointer;display:flex;align-items:center;justify-content:center}
.mp-mic-fab:active{transform:scale(.94)}
.mp-mic-fab.live{background:#B3261E;animation:mp-pulse 1.4s ease-in-out infinite}
@keyframes mp-pulse{0%,100%{box-shadow:0 6px 20px rgba(179,38,30,.35)}50%{box-shadow:0 6px 30px rgba(179,38,30,.85)}}
/* the way in to the guide, for anyone who wants to read it cold */
.mp-mic-help{position:fixed;right:16px;bottom:90px;z-index:60;border:1px solid #D8C3A5;background:rgba(255,255,255,.96);
  color:#6a5c4a;font-size:12px;font-weight:600;border-radius:999px;padding:6px 11px;cursor:pointer;
  box-shadow:0 2px 8px rgba(0,0,0,.12)}

/* the listening screen */
.mp-vlive{min-height:76px;background:#FFF8F0;border:1px dashed #D8C3A5;border-radius:12px;padding:12px 13px;
  font-size:16px;line-height:1.5;color:#3a2c1c;white-space:pre-wrap}
.mp-vlive .interim{color:#9a8a72}
.mp-vlive.empty{color:#9a8a72;font-style:italic}
.mp-vlangs{display:flex;gap:6px;margin:0 0 10px}
.mp-vlang{flex:1;height:38px;border-radius:9px;border:1.5px solid #D8C3A5;background:#fff;font-size:14px;font-weight:600;color:#6a5c4a;cursor:pointer}
.mp-vlang.on{background:var(--mp-maroon,#400207);border-color:var(--mp-maroon,#400207);color:#fff}

/* the guide — what he can say, built from his own menus and dishes */
.mp-vguide{margin-top:12px;background:#F6F1E7;border-radius:12px;padding:12px 13px}
.mp-vguide-h{font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:#8A3B00;font-weight:600;margin-bottom:8px}
.mp-vguide-l{font-size:13.5px;line-height:1.75;color:#4a3c2c}
.mp-vguide-l b{color:#2e2318}
.mp-vsteps{font-size:13.5px;line-height:1.6;color:#4a3c2c;margin-bottom:12px}
.mp-vsteps strong{color:#2e2318}

/* the read-back card: what it understood, before anything is written */
.mp-vdo{background:#fff;border:1.5px solid #E3D5BF;border-radius:12px;padding:13px 14px;margin-bottom:10px}
.mp-vdo.danger{border-color:#E5A6A2;background:#FFF4F3}
.mp-vdo-k{font-size:11px;letter-spacing:1.2px;text-transform:uppercase;font-weight:700;color:#8A3B00;margin-bottom:6px}
.mp-vdo.danger .mp-vdo-k{color:#B3261E}
.mp-vdo-n{font-family:Forum,serif;font-size:21px;line-height:1.25;color:#2e2318;margin-bottom:4px}
.mp-vdo-s{font-size:13px;color:#6a5c4a;line-height:1.5}
.mp-vheard{font-size:12.5px;color:#8a7a62;font-style:italic;margin-bottom:10px}

/* undo, after a delete */
.mp-undo{position:fixed;left:50%;transform:translateX(-50%);bottom:26px;z-index:80;display:none;
  align-items:center;gap:14px;background:#2e2318;color:#fff;border-radius:12px;padding:12px 14px;
  font-size:14px;box-shadow:0 8px 26px rgba(0,0,0,.34);max-width:92vw}
.mp-undo.show{display:flex}
.mp-undo button{background:#fff;color:#2e2318;border:none;border-radius:8px;height:34px;padding:0 14px;font-size:14px;font-weight:700;cursor:pointer}
</style>`;

// ══════════════════════════════════════════════════════════════════════════
// VOICE — one mic, every screen, add / change / delete
//
// WHY THIS EXISTS. The module was solid and Danilo would not use it: too much
// typing, too many screens to learn before anything happened. The mic is the
// answer to that — he talks, the app fills the form, he checks it and taps once.
//
// THE RULES IT KEEPS (all of them are older than this feature):
//   1. It NEVER writes on its own. Every single path ends at a read-back card
//      with a button on it. Same rule as the typed box above.
//   2. It NEVER guesses allergens onto a dish. The model may SUGGEST them; they
//      arrive switched off and he taps the ones that are real. Auto-ticking
//      allergens was defect D3 and is not coming back.
//   3. It NEVER guesses WHICH dish he meant. One clear match, or it asks.
//      Changing the wrong dish is worse than one extra tap.
//   4. It NEVER produces a date. Nothing here asks the model for one, the same
//      way mpAiUnderstand doesn't — the app owns every date in this file.
//   5. A delete can be undone. Everything else he can just say again.
//
// ANDROID ONLY, deliberately: Apple does not give web apps the Web Speech API,
// so the button is feature-detected and simply is not there on an iPhone —
// exactly how stock-take.js handles the same problem. Danilo is on Android.
// ══════════════════════════════════════════════════════════════════════════

const MP_VOICE_LANGS = [{ code:'en-GB', label:'EN' }, { code:'it-IT', label:'IT' }];
const MP_VOICE_LANG_KEY = 'menu-plan-voice-lang';
// Italian is the DEFAULT, and that is a deliberate choice, not a preference.
// He mixes the two languages whatever this is set to, so the only question is
// which half survives the transcription — and the half that must survive is the
// dish name, which is always Italian. An English recogniser turns "riccio" into
// something unrecognisable; an Italian one mangles "is approved" instead, and a
// mangled command is recoverable from context where a mangled dish name is not.
let mpVoiceLang = (function(){
  try { var v = localStorage.getItem(MP_VOICE_LANG_KEY); return v === 'en-GB' ? 'en-GB' : 'it-IT'; }
  catch(e){ return 'it-IT'; }
})();
let mpVRec = null, mpVFinal = '', mpVInterim = '', mpVIntent = null, mpVUndo = null, mpVUndoTimer = null;
// Everything he has finished saying this session, banked outside the recogniser
// so that no restart — and no language switch — can take it away from him.
let mpVCommitted = '', mpVRestarts = 0, mpVLastSaid = '';

function mpVoiceSupported(){ return !!mpSpeechCtor(); }
// The mic belongs to the people who author work. A cost controller reviews; it
// would only ever tell them no.
function mpVoiceAllowed(){ return mpVoiceSupported() && mpCanAuthor(); }
function mpVoiceIt(){ return mpVoiceLang === 'it-IT'; }

// The floating button, painted by mpRender onto whichever tab he is on.
function mpMicFab(){
  if (!mpVoiceAllowed()) return '';
  return '<button class="mp-mic-help" onclick="mpVoiceHelp()" ' +
           'aria-label="What can I say?">' + (mpVoiceIt() ? 'Cosa posso dire?' : 'What can I say?') + '</button>' +
         '<button class="mp-mic-fab" id="mp-mic-fab" onclick="mpVoiceStart()" ' +
           'title="Say what you want to do" aria-label="Say what you want to do">&#127908;</button>' +
         '<div class="mp-undo" id="mp-undo"><span id="mp-undo-txt"></span>' +
           '<button onclick="mpVoiceUndo()">Undo</button></div>';
}

function mpSetVoiceLang(code){
  mpVoiceLang = code === 'it-IT' ? 'it-IT' : 'en-GB';
  try { localStorage.setItem(MP_VOICE_LANG_KEY, mpVoiceLang); } catch(e){}
  // Switching language mid-sentence restarts the ear, otherwise it keeps
  // listening in the language he just rejected. What he has ALREADY said is
  // kept — switching language is him fixing the app, and it must not cost him
  // the sentence he just got out.
  var listening = !!mpVRec;
  if (listening){ mpVoiceStopEar(); mpVInterim = ''; mpVRestarts = 0; }
  mpVoicePaint();
  if (listening){ mpVoiceStartEar(); mpVoiceShowText(); }
}

// ── the guide ──────────────────────────────────────────────────────────────
// It sits INSIDE the listening screen, above the live text, because the only
// moment he wants to know what he can say is the moment before he says it.
// Every example is built from his own menus and dishes, read from the DB — the
// last "how this works" card in this module was hand-written, went stale the
// first time the plan moved, and was wrong by the time he read it. This one
// cannot go stale, because there is nothing in it to update.
function mpVoiceSampleMenu(){
  var main = mpMenus.filter(function(m){ return m.active !== false && mpMenuKind(m) === 'main'; })[0];
  var any  = main || mpMenus[0];
  return any ? any.name : (mpVoiceIt() ? 'il menù d’autunno' : 'the autumn menu');
}
function mpVoiceSampleDish(){
  var d = mpDishes.filter(function(x){ return x.status !== 'Retired'; })[0] || mpDishes[0];
  return d ? d.name_it : (mpVoiceIt() ? 'branzino al finocchio' : 'sea bass with fennel');
}
function mpVoiceGuideHtml(){
  var menu = mpVoiceSampleMenu(), dish = mpVoiceSampleDish(), it = mpVoiceIt();
  // Written the way they actually speak — half Italian, half English, no
  // command words. If the examples were tidy sentences he would think he had to
  // say tidy sentences, and that is the thing that makes people stop using it.
  var lines = it ? [
    ['Aggiungere',  'Piatto nuovo, ' + dish + ', per ' + menu],
    ['Cambiare',    dish + ' is ready, finito'],
    ['Togliere',    'Togli ' + dish + ' from ' + menu],
    ['Cancellare',  'Cancella ' + dish]
  ] : [
    ['To add',      'Piatto nuovo, ' + dish + ', for ' + menu],
    ['To change',   dish + ' is done, ready for testing'],
    ['To take off', 'Take ' + dish + ' off ' + menu],
    ['To delete',   'Cancella ' + dish]
  ];
  return '<div class="mp-vguide">' +
    '<div class="mp-vguide-h">' + (it ? 'Prova a dire' : 'Try saying') + '</div>' +
    '<div class="mp-vguide-l">' +
      lines.map(function(l){
        return '<div><b>' + mpEsc(l[0]) + '</b> &mdash; &ldquo;' + mpEsc(l[1]) + '&rdquo;</div>';
      }).join('') +
      '<div style="margin-top:8px;color:#8a7a62">' + (it
        ? 'Non devi dirlo così — dillo come viene.'
        : 'You don’t have to say it like this — say it however it comes out.') + '</div>' +
    '</div></div>';
}
// The three-line version, always on screen above the live text. Not a tutorial:
// it is the contract — talk, check, tap. Three lines is the whole guide.
function mpVoiceStepsHtml(){
  return '<div class="mp-vsteps">' + (mpVoiceIt()
    ? '<strong>Parla normalmente.</strong> Poi ti mostro cosa ho capito. <strong>Non salvo niente</strong> finché non tocchi il pulsante.'
    : '<strong>Just talk.</strong> Then I show you what I understood. <strong>Nothing is saved</strong> until you tap the button.') +
  '</div>';
}
// Reachable from outside the mic too, for anyone who wants to read it cold.
function mpVoiceHelp(){
  mpSheet(mpVoiceIt() ? 'Come funziona la voce' : 'How the voice works',
    mpVoiceStepsHtml() + mpVoiceGuideHtml() +
    '<div class="mp-hint">' + (mpVoiceIt()
      ? 'Non devi imparare le frasi — dillo come ti viene. Se non capisco, te lo dico e non tocco niente.'
      : 'You don’t have to learn the phrases — say it however it comes out. If I can’t work it out I tell you, and I change nothing.') + '</div>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpVoiceStart()">' + (mpVoiceIt() ? 'Parla' : 'Start talking') + '</button>' +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">' + (mpVoiceIt() ? 'Chiudi' : 'Close') + '</button>' +
    '</div>');
}

// ── listening ──────────────────────────────────────────────────────────────
// continuous + interim, exactly like the stock-take voice count: he is a chef
// thinking mid-sentence, and an ear that stops at the first pause cuts him off
// halfway through the dish. He decides when he has finished, by tapping Done.
function mpVoiceStart(){
  if (!mpVoiceSupported()){
    mpToast('Voice needs Android Chrome. On iPhone, tap a box and use the keyboard mic.', true); return;
  }
  if (!mpCanAuthor()){ mpToast('Voice adds and changes dishes — your access is review only.', true); return; }
  mpVFinal = ''; mpVInterim = ''; mpVCommitted = ''; mpVRestarts = 0; mpVIntent = null;
  mpVoicePaint();
  mpVoiceStartEar();
}
function mpVoicePaint(){
  var it = mpVoiceIt();
  mpSheet(it ? 'Dimmi' : 'Tell me',
    '<div class="mp-vlangs">' +
      MP_VOICE_LANGS.map(function(L){
        return '<button type="button" class="mp-vlang' + (mpVoiceLang === L.code ? ' on' : '') + '" ' +
          'onclick="mpSetVoiceLang(\'' + L.code + '\')">' + L.label + '</button>';
      }).join('') +
    '</div>' +
    // Not a mode he has to get right. He mixes the two languages either way and
    // the app copes; this only tips the ear one way or the other.
    '<div class="mp-fine" style="margin:-4px 0 10px">' + (it
      ? 'Mischia pure italiano e inglese — capisco lo stesso. Scegli solo quella che parli di più.'
      : 'Mix Italian and English however you like — it still understands. This just picks which one it leans on.') +
    '</div>' +
    mpVoiceStepsHtml() +
    '<div class="mp-vlive empty" id="mp-vlive">' + (it ? 'Ti ascolto…' : 'Listening…') + '</div>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" id="mp-vdone" onclick="mpVoiceDone(this)">' + (it ? 'Fatto' : 'Done') + '</button>' +
      '<button class="mp-btn ghost" onclick="mpVoiceTypeInstead(mpVFinal)">' + (it ? 'Scrivilo' : 'Type it') + '</button>' +
      '<button class="mp-btn ghost" onclick="mpVoiceCancel()">' + (it ? 'Annulla' : 'Cancel') + '</button>' +
    '</div>' +
    mpVoiceGuideHtml());
  var fab = document.getElementById('mp-mic-fab'); if (fab) fab.classList.add('live');
}
function mpVoiceStartEar(){
  var C = mpSpeechCtor(); if (!C) return;
  try { mpVRec = new C(); } catch(e){ mpVRec = null; return; }
  mpVRec.lang = mpVoiceLang;
  mpVRec.continuous = true;
  mpVRec.interimResults = true;
  mpVRec.maxAlternatives = 1;
  // ⚠ THE ONE THAT MADE IT USELESS. Android's recogniser ends itself at every
  // pause, and each restart hands back a FRESH `ev.results` that starts empty.
  // Rebuilding mpVFinal from ev.results alone therefore wiped everything he had
  // already said the moment he stopped to think — he watched his own sentence
  // disappear. So finished speech is banked in mpVCommitted, which no restart
  // can touch, and ev.results only ever rebuilds the CURRENT burst on top of it.
  mpVRec.onresult = function(ev){
    var fin = '', int = '';
    for (var i = ev.resultIndex || 0; i < ev.results.length; i++){
      var r = ev.results[i];
      if (r.isFinal) fin += r[0].transcript + ' '; else int += r[0].transcript;
    }
    if (fin) mpVCommitted += fin;                 // banked — survives every restart
    mpVFinal = mpVCommitted;
    mpVInterim = int;
    mpVoiceShowText();
  };
  // Back on after every pause, until he taps Done or Cancel. The restart is
  // deferred: calling start() synchronously inside onend throws InvalidStateError
  // on Chrome and the ear never comes back. The counter is a dead-mic backstop —
  // without it a permanently failing recogniser spins forever.
  mpVRec.onend = function(){
    if (!mpVRec) return;                          // he stopped it himself
    if (++mpVRestarts > 60){ mpVoiceStopEar(); return; }
    setTimeout(function(){
      if (!mpVRec) return;
      try { mpVRec.start(); } catch(e){}
    }, 250);
  };
  mpVRec.onerror = function(ev){
    var e = ev && ev.error;
    // Silence is not a failure, and neither is the restart churn — onend brings
    // it back. Only a real fault is worth interrupting him for.
    if (e === 'no-speech' || e === 'aborted' || e === 'audio-capture') return;
    mpVoiceStopEar();
    mpToast(e === 'not-allowed'
      ? 'The microphone is blocked — allow it for this site in Chrome, then try again.'
      : 'Could not hear that — try again, or type it instead.', true);
  };
  try { mpVRec.start(); } catch(e){}
}
function mpVoiceStopEar(){
  var r = mpVRec; mpVRec = null;                              // clear FIRST so onend doesn't restart it
  if (r){ try { r.onend = null; r.stop(); } catch(e){} }
  var fab = document.getElementById('mp-mic-fab'); if (fab) fab.classList.remove('live');
}
function mpVoiceShowText(){
  var el = document.getElementById('mp-vlive'); if (!el) return;
  var said = (mpVFinal + mpVInterim).trim();
  el.className = 'mp-vlive' + (said ? '' : ' empty');
  el.innerHTML = said
    ? mpEsc(mpVFinal) + '<span class="interim">' + mpEsc(mpVInterim) + '</span>'
    : (mpVoiceIt() ? 'Ti ascolto…' : 'Listening…');
}
function mpVoiceCancel(){ mpVoiceStopEar(); mpCloseSheet(); }

async function mpVoiceDone(btn){
  var said = (mpVFinal + ' ' + mpVInterim).replace(/\s+/g,' ').trim();
  mpVoiceStopEar();
  if (!said){
    mpToast(mpVoiceIt() ? 'Non ho sentito niente — riprova.' : 'I didn’t hear anything — try again.', true);
    return;
  }
  return mpVoiceProcess(said, btn);
}

// Typing is the way through when the microphone is having a bad day — a noisy
// pass, a bad line, an accent the recogniser refuses. Everything downstream is
// identical, so he gets the same read-back and the same one-tap save; only the
// way the words arrived is different. Without this, a mic that mishears him
// leaves him with nothing, which is how a tool loses someone for good.
function mpVoiceTypeInstead(seed){
  var it = mpVoiceIt();
  mpVoiceStopEar();
  mpSheet(it ? 'Scrivilo' : 'Type it',
    '<div class="mp-hint">' + (it
      ? 'Scrivilo come lo diresti — italiano, inglese, come viene. Non salvo niente finché non controlli.'
      : 'Write it the way you would say it — Italian, English, however it comes. Nothing is saved until you check it.') + '</div>' +
    '<textarea class="mp-in" id="mpv-typed" rows="3" maxlength="' + MP_MAX_NOTE + '">' + mpEsc(seed || '') + '</textarea>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpVoiceRunTyped(this)">' + (it ? 'Continua' : 'Continue') + '</button>' +
      '<button class="mp-btn ghost" onclick="mpVoiceStart()">' + (it ? 'Torna alla voce' : 'Back to talking') + '</button>' +
    '</div>' +
    mpVoiceGuideHtml());
  setTimeout(function(){ var el = document.getElementById('mpv-typed'); if (el) el.focus(); }, 60);
}
function mpVoiceRunTyped(btn){
  var el = document.getElementById('mpv-typed');
  var said = ((el && el.value) || '').replace(/\s+/g,' ').trim();
  if (!said){ mpToast(mpVoiceIt() ? 'Scrivi qualcosa prima.' : 'Write something first.', true); return; }
  return mpVoiceProcess(said, btn);
}

// One pipeline, whether the words were spoken or typed.
async function mpVoiceProcess(said, btn){
  mpVLastSaid = said;                      // so "type it instead" opens on his own words
  var free = mpLock(btn); if (!free) return;
  try {
    var intent = await mpVoiceUnderstand(said);
    if (!intent || intent.action === 'unknown'){ mpVoiceStuck(said); return; }
    intent.heard = said;
    // One clear dish, or he picks. Never a guess.
    if (intent.action !== 'add'){
      var cands = mpVoiceFindDishes(intent.dish || intent.name || said);
      if (!cands.length){ mpVoiceNoDish(said, intent); return; }
      if (cands.length > 1){ mpVoicePickDish(cands, intent); return; }
      intent.dish_id = cands[0].id;
    }
    mpVIntent = intent;
    mpVoiceReadBack();
  } finally { free(); }
}

// When it cannot work out what he wants, it says so plainly and puts the
// examples back in front of him — it never half-does something instead.
function mpVoiceStuck(said){
  var it = mpVoiceIt();
  mpSheet(it ? 'Non ho capito' : 'I didn’t get that',
    '<div class="mp-vheard">' + (it ? 'Ho sentito: ' : 'I heard: ') + '&ldquo;' + mpEsc(said) + '&rdquo;</div>' +
    '<div class="mp-hint">' + (it
      ? 'Non ho cambiato niente. Prova a dire il nome del piatto e cosa devo farne.'
      : 'I have changed nothing. Try naming the dish and what to do with it.') + '</div>' +
    mpVoiceGuideHtml() +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpVoiceStart()">' + (it ? 'Riprova' : 'Try again') + '</button>' +
      // His words are already there — fixing two letters beats saying it a third time.
      '<button class="mp-btn ghost" onclick="mpVoiceTypeInstead(mpVLastSaid)">' + (it ? 'Scrivilo' : 'Type it') + '</button>' +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">' + (it ? 'Chiudi' : 'Close') + '</button>' +
    '</div>');
}
function mpVoiceNoDish(said, intent){
  var it = mpVoiceIt();
  mpSheet(it ? 'Quale piatto?' : 'Which dish?',
    '<div class="mp-vheard">' + (it ? 'Ho sentito: ' : 'I heard: ') + '&ldquo;' + mpEsc(said) + '&rdquo;</div>' +
    '<div class="mp-hint">' + (it
      ? 'Non ho trovato nessun piatto con quel nome, quindi non ho toccato niente.'
      : 'I couldn’t find a dish by that name, so I haven’t touched anything.') + '</div>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpVoiceStart()">' + (it ? 'Riprova' : 'Try again') + '</button>' +
      (intent && intent.name
        ? '<button class="mp-btn ghost" onclick="mpVoiceAddInstead()">' + (it ? 'Aggiungilo come nuovo' : 'Add it as new') + '</button>' : '') +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">' + (it ? 'Chiudi' : 'Close') + '</button>' +
    '</div>');
  mpVIntent = intent;
}
function mpVoiceAddInstead(){
  if (!mpVIntent) return;
  mpVIntent = Object.assign({}, mpVIntent, { action:'add', name: mpVIntent.dish || mpVIntent.name });
  mpVoiceReadBack();
}
// Two dishes could be the one he meant, so the app asks instead of picking.
function mpVoicePickDish(cands, intent){
  var it = mpVoiceIt();
  mpVIntent = intent;
  mpVoicePickList = cands;
  mpSheet(it ? 'Quale dei due?' : 'Which one do you mean?',
    '<div class="mp-vheard">' + (it ? 'Ho sentito: ' : 'I heard: ') + '&ldquo;' + mpEsc(intent.heard || '') + '&rdquo;</div>' +
    '<div class="mp-cat-list">' +
      cands.map(function(d, i){
        return '<button type="button" class="mp-cat-row" onclick="mpVoiceChoseDish(' + i + ')">' +
          '<span class="mp-cat-n">' + mpEsc(d.name_it) + '</span>' +
          '<span class="mp-cat-d quiet">' + mpEsc(d.status + ' · ' + (d.section || '')) + '</span>' +
        '</button>';
      }).join('') +
    '</div>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">' + (it ? 'Annulla' : 'Cancel') + '</button>' +
    '</div>');
}
let mpVoicePickList = [];
function mpVoiceChoseDish(i){
  var d = mpVoicePickList[i]; if (!d || !mpVIntent) return;
  mpVIntent.dish_id = d.id;
  mpVoiceReadBack();
}

// ── understanding one spoken instruction ───────────────────────────────────
// Same shape as mpAiUnderstand above, and the same hard limits: the model reads
// his words and NOTHING else. It is not asked for a date, and any date it
// volunteers is dropped on the floor — the app owns every date in this file.
const MP_VOICE_ACTIONS = ['add','status','attach','detach','edit','delete'];
async function mpVoiceUnderstand(text){
  var read = await mpVoiceAiUnderstand(text);
  if (!read) read = mpVoiceFallback(text);
  if (!read) return null;
  // Whatever came back, it is scrubbed against the app's own vocabulary before
  // it is allowed anywhere near the screen.
  if (MP_VOICE_ACTIONS.indexOf(read.action) < 0) read.action = 'unknown';
  read.name    = String(read.name || '').trim().slice(0, MP_MAX_NAME);
  read.section = MP_SECTIONS.indexOf(read.section) >= 0 ? read.section : null;
  read.status  = MP_STATUSES.indexOf(read.status)  >= 0 ? read.status  : null;
  read.menu    = mpMenus.some(function(m){ return m.name === read.menu; }) ? read.menu : null;
  read.description = String(read.description || '').trim().slice(0, MP_MAX_DESC) || null;
  read.notes   = String(read.notes || '').trim().slice(0, MP_MAX_NOTE) || null;
  // SUGGESTED allergens only. They arrive switched off and stay off until he
  // taps them — see rule 2 at the top of this section.
  var codes = MP_ALLERGENS.map(function(a){ return a.code; });
  read.suggest_allergens = (Array.isArray(read.allergens) ? read.allergens : [])
    .map(function(c){ return String(c || '').trim().toUpperCase(); })
    .filter(function(c){ return codes.indexOf(c) >= 0; });
  delete read.allergens;
  if (read.action === 'add' && !read.name) read.action = 'unknown';
  return read;
}
async function mpVoiceAiUnderstand(text){
  try {
    var sys =
      'A chef in an Italian restaurant in Dubai is talking to his menu-planning app. Turn ONE spoken ' +
      'instruction into ONE JSON object and reply with the object and nothing else.\n' +
      '\n' +
      'HOW HE TALKS — read this before anything else:\n' +
      '· His English is not strong. Expect broken grammar, missing words, wrong tenses, no punctuation. ' +
      'Judge what he MEANT, never what the sentence technically says.\n' +
      '· He mixes Italian and English in one sentence — "piatto nuovo, spaghetti al riccio, is ready for ' +
      'testing". That is normal, not an error.\n' +
      '· This is phone dictation, so the words arrive mangled, ESPECIALLY the Italian dish names: ' +
      '"spaghetti al ritchie the mare" is "Spaghetti al riccio di mare". Read the transcript for SOUND, ' +
      'not spelling, and match it to the dish list below — the list is right, the transcript is not.\n' +
      '· He will not use command words. "the branzino is done" and "branzino ok Francesco liked it" both ' +
      'mean the stage moved. Work out the intent from ordinary talk.\n' +
      '· If he says a dish name that is close to one on the list, it IS that dish — do not invent a new one.\n' +
      '· He is a native ITALIAN speaker. When he speaks English it carries a strong Italian accent, and the ' +
      'recogniser mishears it badly: "approved" arrives as "approvd" / "epruved" / "a proved", "delete" as ' +
      '"dilit", "ready" as "redi". Decode it phonetically as an Italian would pronounce the English.\n' +
      '· The transcript below was produced by a recogniser set to ' +
      (mpVoiceIt() ? 'ITALIAN, so any ENGLISH words he used have been forced into Italian-looking spellings — read them back out loud in your head to recover them.'
                   : 'ENGLISH, so any ITALIAN words he used (especially dish names) have been forced into English-looking spellings — read them back out loud in your head to recover them.') + '\n' +
      '\n' +
      '{"action": one of "add" | "status" | "attach" | "detach" | "edit" | "delete" | "unknown",\n' +
      ' "dish": the exact name from the "Dishes he already has" list if he is talking about one of those, else null,\n' +
      ' "name": for "add" only — the new dish name in his own words (keep it in Italian if he said it in Italian),\n' +
      ' "menu": the exact name from the "Menus" list if he named one, else null,\n' +
      ' "section": one of the sections listed, if he said which part of the menu it is, else null,\n' +
      ' "status": one of the stages listed, if he said where it has got to, else null,\n' +
      ' "description": a short description if he described the dish, else null,\n' +
      ' "notes": anything else worth keeping, else null,\n' +
      ' "allergens": codes you think MIGHT apply, from the list, else []}\n' +
      'What the actions mean: "add" a new dish · "status" it has reached a stage · "attach" put an existing dish ' +
      'onto a menu · "detach" take it off a menu but keep the dish · "edit" change its words or section · ' +
      '"delete" get rid of the dish entirely. If you cannot tell, use "unknown" — do not guess.\n' +
      'NEVER give a date, a deadline, a month or a duration in any field. The app works those out itself.\n' +
      'The allergens are a SUGGESTION for a human to confirm — never claim they are certain.';
    var ctx =
      'Menus:\n' + mpMenus.map(function(m){ return m.name; }).join('\n') +
      '\n\nSections:\n' + MP_SECTIONS.join(', ') +
      '\n\nStages:\n' + MP_STATUSES.join(', ') +
      '\n\nAllergen codes:\n' + MP_ALLERGENS.map(function(a){ return a.code + '=' + a.label; }).join(', ') +
      '\n\nDishes he already has:\n' + mpDishes.slice(0, 400).map(function(d){ return d.name_it; }).join('\n') +
      '\n\nHe said:\n' + text;
    var resp = await fetch(MP_AI_URL, {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'Authorization':'Bearer ' + SUPABASE_KEY,
        'apikey': SUPABASE_KEY,
        'x-proxy-secret': (typeof KITCHEN_PROXY_SECRET !== 'undefined' ? KITCHEN_PROXY_SECRET : '')
      },
      body: JSON.stringify({
        action:'chat', model:'claude-sonnet-4-6', max_tokens:600, system:sys,
        messages:[{ role:'user', content: ctx }]
      })
    });
    if (!resp.ok) return null;
    var data = await resp.json();
    var hit = String((data && data.text) || '').match(/\{[\s\S]*\}/);
    if (!hit) return null;
    var o = JSON.parse(hit[0]);
    return (o && typeof o === 'object') ? o : null;
  } catch(e){ return null; }
}
// The proxy will be down sometimes and the mic still has to do something
// honest. This reads the few phrasings that carry their own meaning in both
// languages; anything else comes back "unknown", which is a real answer.
// These run on the SOUND-normalised sentence, not the raw one, so a mangled
// transcript still trips them ("aprovato", "approvatto", "finito" all land).
// They are deliberately generous: this only ever proposes, and he reads the
// read-back card before anything is written.
// These are matched against the SOUND-normalised sentence, so the patterns must
// go through the same normaliser — written out longhand they silently never
// match ("togli" normalises to "toli", "cancella" to "kansela"), which is a
// bug that looks exactly like "it just didn't understand him".
// Two words are the same word if they sound the same once normalised. Short
// words must match exactly (mpSoundsLike refuses under 4 letters) or "on" and
// "un" become the same instruction.
function mpTokenLike(a, b){ return a === b || mpSoundsLike(a, b); }
// Does this sentence contain any of these phrases — allowing for the accent?
//
// THE POINT OF THIS: he is Italian, and Chrome's English recogniser does not
// handle Italian-accented English. "approved" comes back as "approvd",
// "epruved", "a proved"; "delete" as "dilit". Matching those literally fails,
// which is what "it doesn't fully recognise my accent" actually was — the DISH
// names already matched by sound, but the command words did not. Now they do.
function mpVHasPhrase(sentence, phrases){
  var toks = String(sentence || '').split(' ').filter(Boolean);
  if (!toks.length) return false;
  for (var p = 0; p < phrases.length; p++){
    var pw = mpVoiceNorm(phrases[p]).split(' ').filter(Boolean);
    if (!pw.length) continue;
    for (var i = 0; i + pw.length <= toks.length; i++){
      var all = true;
      for (var j = 0; j < pw.length; j++){
        if (!mpTokenLike(pw[j], toks[i + j])){ all = false; break; }
      }
      if (all) return true;
    }
  }
  return false;
}
// Kept for anything that still wants a plain regex.
function mpVRe(words){
  var parts = words
    .map(function(w){ return mpVoiceNorm(w).replace(/ /g, '\\s+'); })
    .filter(function(w){ return !!w; });
  return new RegExp('(?:^|\\s)(?:' + parts.join('|') + ')(?:\\s|$)');
}
const MP_V_DELETE = ['delete','deleted','remove it','get rid','bin it','cancella','cancellare','elimina','buttalo'];
const MP_V_OFF    = ['off','out','fuori','leva','levare','togli','togliere','toglie','via'];
const MP_V_ON     = ['on','onto','into','put','add','metti','mettere','mettiamo','aggiungi','aggiungere','va su','vanno'];
// Deliberately STRICT, unlike the rest. Everything else here acts on a dish we
// already hold; this one CREATES a row, so a stray verb in a sentence of
// thinking-out-loud must not become a new dish.
const MP_V_ADD    = ['new dish','a new dish','add a dish','piatto nuovo','nuovo piatto','aggiungi piatto','aggiungiamo piatto'];
const MP_V_STATUS_WORDS = {
  // "done / finito / pronto / ok / va bene" all mean the same thing in this
  // kitchen — nobody is going to say "set the status to Approved".
  Approved: ['approved','approvato','approvata','okay','ok','va bene','piaciuto','gli e piaciuto'],
  Testing:  ['testing','test','tasting','prova','provare','proviamo','assaggio','assaggiare','pronto','pronta','finito','finita','done','ready'],
  Trying:   ['trying','ci lavoro','lavorando','provando','in corso'],
  Costing:  ['costing','cost','costo','costare','price','prezzo'],
  Retired:  ['retired','ritirato','ritirata','fuori menu','levato'],
  Idea:     ['solo un idea','just an idea','only an idea','un idea']
};
const MP_V_STATUS = (function(){
  // Each stage becomes a tester that matches by sound, so an accented "approved"
  // still lands on Approved.
  var out = {};
  Object.keys(MP_V_STATUS_WORDS).forEach(function(k){
    out[k] = { test: function(n){ return mpVHasPhrase(n, MP_V_STATUS_WORDS[k]); } };
  });
  return out;
})();
// The offline read. It is not a phrase book — it looks for a dish it recognises
// and a word that says what to do with it, in whichever language that word
// arrived in, and gives up honestly when it finds neither.
function mpVoiceFallback(text){
  var s = String(text || ''), n = mpVoiceNorm(s);
  var menu = mpMatchMenu(s);
  var out = { action:'unknown', dish:null, name:'', menu:menu ? menu.name : null,
              section:null, status:null, description:null, notes:null, allergens:[] };
  var known = mpVoiceFindDishes(s);          // does he name a dish we already hold?
  var namesADish = known.length > 0;

  for (var k in MP_V_STATUS){ if (MP_V_STATUS[k].test(n)){ out.status = k; break; } }

  // "New dish / piatto nuovo" wins over everything, and it has to: half his new
  // dishes share a word with one he already has ("new dish, sea urchin
  // SPAGHETTI" against an existing "SPAGHETTI al riccio"), and without this the
  // app reads a brand-new dish as an edit to the old one.
  var saysNew = mpVHasPhrase(n, MP_V_ADD);
  if (saysNew)                                                out.action = 'add';
  else if (mpVHasPhrase(n, MP_V_DELETE) && namesADish)        out.action = 'delete';
  else if (namesADish && menu && mpVHasPhrase(n, MP_V_OFF))   out.action = 'detach';
  else if (namesADish && menu && mpVHasPhrase(n, MP_V_ON))    out.action = 'attach';
  else if (namesADish && out.status)                          out.action = 'status';
  // Either he said "new dish", or he is talking about something we do not hold
  // while naming a menu — both mean a dish that needs creating.
  if (out.action === 'add' || (out.action === 'unknown' && !namesADish && menu)){
    // He is talking about something we do not hold — so it is a new dish. Strip
    // the lead-in and the trailing "for <menu>" and keep his own words as the
    // name; he can correct it on the read-back.
    out.action = 'add';
    out.name = s.replace(/^[^a-zà-ÿ]*/i, '')
      .replace(/^(new dish|a new dish|add a dish|piatto nuovo|nuovo piatto|aggiungi(?: il)? piatto|facciamo|voglio fare)\b/i, '')
      .split(/\bfor\b|\bper\b|\bsul\b|\bsu\b/i)[0]
      .replace(/^[\s,.:;-]+/, '').replace(/[\s,.:;-]+$/, '')
      .replace(/\s+/g, ' ').trim().slice(0, MP_MAX_NAME);
    if (!out.name) out.action = 'unknown';
  }
  // Anything that got this far still 'unknown' — a dish named with nothing
  // decipherable to do with it, or plain thinking-out-loud — stays unknown on
  // purpose. It ends at "I didn't get that", which changes nothing.
  if (out.action !== 'unknown' && out.action !== 'add') out.dish = s;   // matched again by mpVoiceFindDishes
  if (out.action !== 'status') out.status = out.action === 'add' ? out.status : null;
  return out;
}

// ── which dish did he mean ─────────────────────────────────────────────────
// THE HARD PART, and the reason this is not a simple string compare.
//
// Two things are true about this kitchen: their English is not strong, and they
// speak Italian and English in the same sentence ("piatto nuovo, spaghetti al
// riccio, is ready for testing"). On top of that, phone dictation mangles the
// word that matters most — the dish name — because it is an Italian noun being
// guessed at by a recogniser. "Spaghetti al riccio di mare" comes back as
// "spaghetti al ritchie the mare", "spagetti al riccio dimare", "spaghetti
// alriccio". A literal match finds none of those.
//
// So the matcher listens for how a word SOUNDS, not how it was spelled. It
// still refuses to pick between two — it just gets far closer to the shortlist.

// Strip a word down to roughly the sounds in it, so the Italian and the
// mis-heard English collapse onto the same key: accents dropped, doubled
// letters flattened (riccio → ricio), and the spellings that differ between the
// two languages folded together (ch/c/q → k, gli → li, gn → n, z → s, ph → f).
function mpVoiceNorm(s){
  var t = String(s || '').toLowerCase();
  // accents off: è/é/ì → e/e/i, so "è approvato" and "e approvato" are one word
  t = t.normalize ? t.normalize('NFD').replace(/[̀-ͯ]/g, '') : t;
  return t
    .replace(/[^a-z ]+/g, ' ')
    .replace(/ph/g, 'f').replace(/gli/g, 'li').replace(/gn/g, 'n')
    .replace(/ch/g, 'k').replace(/c/g, 'k').replace(/q/g, 'k')
    .replace(/z/g, 's').replace(/w/g, 'v').replace(/y/g, 'i').replace(/h/g, '')
    .replace(/(.)\1+/g, '$1')          // riccio → ricio, spagghetti → spagheti
    .replace(/\s+/g, ' ').trim();
}
// Ordinary edit distance, capped — the strings here are dish names, not essays.
function mpLev(a, b){
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  var prev = [], cur = [], i, j;
  for (j = 0; j <= b.length; j++) prev[j] = j;
  for (i = 1; i <= a.length; i++){
    cur[0] = i;
    for (j = 1; j <= b.length; j++){
      cur[j] = Math.min(prev[j] + 1, cur[j-1] + 1, prev[j-1] + (a.charAt(i-1) === b.charAt(j-1) ? 0 : 1));
    }
    for (j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}
// Close enough to be the same word once you allow for a bad transcription:
// about one slip in four characters, and short words must match nearly exactly
// (otherwise "mare" matches "carne" and the wrong dish gets changed).
// The consonant skeleton. An Italian accent moves the VOWELS almost entirely —
// "delete" arrives as "dilit", "approved" as "epruved" — while the consonants
// survive: dlt = dlt, prvd = prvd. Edit distance alone scores those as far
// apart because it weighs a vowel like any other letter, which is exactly why
// English commands were failing for him while Italian ones worked.
function mpSkeleton(s){ return String(s || '').replace(/[aeiou]/g, ''); }
function mpSoundsLike(a, b){
  if (!a || !b) return false;
  if (a === b) return true;
  // Short words must match exactly, or "on" and "un" become one instruction.
  if (a.length < 4 || b.length < 4) return false;
  var longest = Math.max(a.length, b.length);
  var sa = mpSkeleton(a), sb = mpSkeleton(b);
  // Short words (4–5 letters) are where the wrong-dish accidents live: one
  // letter apart is most of the word. "carne" and "carte" are one edit apart
  // and are NOT the same thing, so a short word must also agree on its
  // consonants. ("mare"/"more" do agree, and genuinely do sound alike.)
  // …and on the last letter, because in Italian the final vowel is where the
  // meaning lives: "pesce" (fish) against "pesca" (peach) is one edit and the
  // same consonants, and putting a peach in the fish section is the kind of
  // wrong this whole matcher exists to avoid.
  if (longest <= 5) return mpLev(a, b) <= 1 && sa === sb && a.slice(-1) === b.slice(-1);
  if (mpLev(a, b) <= Math.round(longest / 3)) return true;
  // Longer words get a second chance on the skeleton alone — this is what
  // rescues "delete"/"dilit" and "approved"/"epruved". Three consonants
  // minimum, so it can never fire on something as thin as "mr".
  return sa.length >= 3 && sa === sb;
}
// Words worth matching on — the noise words of BOTH languages dropped, so
// "di/de/the/al/con/with" never carry a match on their own.
const MP_V_NOISE = /^(the|and|for|with|new|dish|menu|our|its|di|de|da|del|della|al|alla|allo|ai|con|in|su|un|una|uno|il|lo|la|le|gli|piatto|nuovo|nuova|questo|questa)$/;
function mpVoiceTokens(s){
  return mpVoiceNorm(s).split(' ').filter(function(w){ return w.length > 2 && !MP_V_NOISE.test(w); });
}
function mpVoiceFindDishes(frag){
  var live = mpDishes.filter(function(d){ return d && d.name_it; });
  var raw = String(frag || '').toLowerCase().trim();
  if (!raw) return [];

  // 1. said it exactly
  var exact = live.filter(function(d){ return d.name_it.toLowerCase() === raw; });
  if (exact.length) return exact;

  // 2. the whole name sits inside the sentence, allowing for the transcription
  //    running words together ("alriccio") — compare on sound, spaces removed
  var qFlat = mpVoiceNorm(raw).replace(/ /g,'');
  var inside = live.filter(function(d){ return qFlat.indexOf(mpVoiceNorm(d.name_it).replace(/ /g,'')) >= 0; });
  if (inside.length === 1) return inside;
  if (inside.length > 1) return inside.sort(function(a,b){ return b.name_it.length - a.name_it.length; }).slice(0, 6);

  // 3. word by word, by sound. Each dish scores the number of its own words it
  //    can hear in what he said, weighted so a long distinctive word ("riccio",
  //    "finocchio") counts for more than a short common one.
  var qt = mpVoiceTokens(raw);
  if (!qt.length) return [];
  var scored = live.map(function(d){
    var dt = mpVoiceTokens(d.name_it), score = 0;
    dt.forEach(function(w){
      var hit = qt.some(function(q){ return mpSoundsLike(w, q); });
      if (hit) score += Math.min(w.length, 9);
    });
    return { d:d, score:score, need:dt.length };
  }).filter(function(x){
    // at least one solid word heard — a single 3-letter coincidence is not a match
    return x.score >= 5;
  }).sort(function(a,b){ return b.score - a.score; });
  if (!scored.length) return [];

  // Outright winner only. Anything within a whisker of the top is offered as a
  // choice instead — changing the wrong dish is worse than one extra tap.
  var top = scored[0].score;
  var close = scored.filter(function(x){ return x.score >= top - 2; });
  return close.slice(0, 6).map(function(x){ return x.d; });
}

// ══ THE READ-BACK — the mic never writes without this screen ═══════════════
// Same promise the typed box makes: this is what I understood, change what is
// wrong, nothing is saved until you tap the button.
function mpVoiceDishOf(intent){
  return mpDishes.find(function(x){ return x.id === (intent && intent.dish_id); }) || null;
}
function mpVoiceReadBack(){
  var v = mpVIntent; if (!v) return;
  var it = mpVoiceIt(), d = mpVoiceDishOf(v);
  var heard = '<div class="mp-vheard">' + (it ? 'Ho sentito: ' : 'I heard: ') +
              '&ldquo;' + mpEsc(v.heard || '') + '&rdquo;</div>';
  var body, title, go;

  if (v.action === 'add'){
    title = it ? 'Aggiungo questo?' : 'Add this?';
    go    = it ? 'Sì, aggiungilo' : 'Yes, add it';
    body = heard +
      '<label class="mp-lab">' + (it ? 'Piatto' : 'Dish') + '</label>' +
      '<input class="mp-in" id="mpv-name" maxlength="' + MP_MAX_NAME + '" value="' + mpEsc(v.name) + '"/>' +
      '<label class="mp-lab">' + (it ? 'Sezione' : 'Section') + '</label>' +
      '<select class="mp-in" id="mpv-section">' +
        MP_SECTIONS.map(function(s){
          return '<option value="' + mpEsc(s) + '"' + (s === (v.section || 'Other') ? ' selected' : '') + '>' + mpEsc(s) + '</option>';
        }).join('') +
      '</select>' +
      '<label class="mp-lab">' + (it ? 'Stadio' : 'Stage') + '</label>' +
      '<select class="mp-in" id="mpv-status">' +
        MP_STATUSES.filter(function(s){ return mpCanSetStatus(s, null) || s === 'Idea'; }).map(function(s){
          return '<option value="' + mpEsc(s) + '"' + (s === (v.status || 'Idea') ? ' selected' : '') + '>' + mpEsc(s) + '</option>';
        }).join('') +
      '</select>' +
      (v.description
        ? '<label class="mp-lab">' + (it ? 'Descrizione' : 'Description') + '</label>' +
          '<textarea class="mp-in" id="mpv-desc" rows="2" maxlength="' + MP_MAX_DESC + '">' + mpEsc(v.description) + '</textarea>'
        : '') +
      '<label class="mp-lab">' + (it ? 'Su quali menù' : 'On which menus') + '</label>' +
      '<div class="mp-pills" id="mpv-menus">' +
        mpMenus.map(function(m){
          return '<button type="button" class="mp-pill' + (m.name === v.menu ? ' on' : '') + '" data-v="' + mpEsc(m.name) + '" ' +
            'onclick="this.classList.toggle(\'on\')">' + mpEsc(m.name) + '</button>';
        }).join('') +
      '</div>' +
      // Allergens: SUGGESTED, never ticked. Defect D3 — the app used to tick
      // these itself and under-state them, while telling him it had "guessed
      // from the description". A wrong allergen reaches a guest.
      '<label class="mp-lab">' + (it ? 'Allergeni' : 'Allergens') + '</label>' +
      '<div class="mp-hint">' + (it
        ? 'Non ne spunto nessuno io. Tocca quelli veri.'
        : 'I don’t tick any of these for you. Tap the ones that are real.') + '</div>' +
      '<div class="mp-pills" id="mpv-allerg">' +
        MP_ALLERGENS.map(function(a){
          var sug = v.suggest_allergens.indexOf(a.code) >= 0;
          return '<button type="button" class="mp-pill" data-v="' + a.code + '" ' +
            'onclick="this.classList.toggle(\'on\')">' + mpEsc(a.label) +
            (sug ? ' <span class="mp-tag">?</span>' : '') + '</button>';
        }).join('') +
      '</div>';

  } else if (v.action === 'status'){
    if (!v.status){ mpVoiceStuck(v.heard || ''); return; }
    // Never offer a button that is going to refuse him. Approving is Francesco's
    // alone, and Costing only opens once a dish is Approved — say that here,
    // rather than letting him tap Yes and get a red toast.
    if (!mpCanSetStatus(v.status, d)){
      mpSheet(it ? 'Questo non posso farlo' : 'That one isn’t yours to set',
        heard + '<div class="mp-vdo"><div class="mp-vdo-n">' + mpEsc(d ? d.name_it : '') + '</div>' +
          '<div class="mp-vdo-s">' + (v.status === 'Approved'
            ? (it ? 'Solo Francesco può approvare un piatto. Il piatto resta ' + mpEsc(d ? d.status : '') + '.'
                  : 'Only Francesco can approve a dish. This one stays ' + mpEsc(d ? d.status : '') + '.')
            : (it ? 'Un piatto va in Costing dopo essere stato approvato — questo è ancora ' + mpEsc(d ? d.status : '') + '.'
                  : 'A dish goes to Costing once it is Approved — this one is still ' + mpEsc(d ? d.status : '') + '.')) +
          '</div></div>' +
        '<div class="mp-hint">' + (it ? 'Non ho cambiato niente.' : 'I have changed nothing.') + '</div>' +
        '<div class="mp-sheet-actions">' +
          '<button class="mp-btn go" onclick="mpVoiceStart()">' + (it ? 'Dimmi altro' : 'Say something else') + '</button>' +
          '<button class="mp-btn ghost" onclick="mpCloseSheet()">' + (it ? 'Chiudi' : 'Close') + '</button>' +
        '</div>');
      return;
    }
    title = it ? 'Cambio lo stadio?' : 'Change the stage?';
    go    = it ? 'Sì, cambialo' : 'Yes, change it';
    body = heard + '<div class="mp-vdo"><div class="mp-vdo-k">' + (it ? 'Stadio' : 'Stage') + '</div>' +
      '<div class="mp-vdo-n">' + mpEsc(d ? d.name_it : '') + '</div>' +
      '<div class="mp-vdo-s">' + mpEsc((d ? d.status : '') + ' → ' + v.status) + ' &middot; ' +
        mpEsc(MP_STATUS_NOTE[v.status] || '') + '</div></div>';

  } else if (v.action === 'attach' || v.action === 'detach'){
    if (!v.menu){ mpVoiceStuck(v.heard || ''); return; }
    var on = v.action === 'attach';
    title = it ? (on ? 'Lo metto sul menù?' : 'Lo tolgo dal menù?') : (on ? 'Put it on the menu?' : 'Take it off the menu?');
    go    = it ? (on ? 'Sì, mettilo' : 'Sì, toglilo') : (on ? 'Yes, put it on' : 'Yes, take it off');
    body = heard + '<div class="mp-vdo"><div class="mp-vdo-k">' + (on ? (it ? 'Aggiungi al menù' : 'On to the menu') : (it ? 'Togli dal menù' : 'Off the menu')) + '</div>' +
      '<div class="mp-vdo-n">' + mpEsc(d ? d.name_it : '') + '</div>' +
      '<div class="mp-vdo-s">' + mpEsc((on ? (it ? 'Va su: ' : 'Goes on: ') : (it ? 'Esce da: ' : 'Comes off: ')) + v.menu) + '<br>' +
        (it ? 'Il piatto resta nella lista.' : 'The dish itself stays in the list.') + '</div></div>';

  } else if (v.action === 'edit'){
    title = it ? 'Cambio questo?' : 'Change this?';
    go    = it ? 'Sì, salva' : 'Yes, save it';
    body = heard +
      '<div class="mp-vdo"><div class="mp-vdo-n">' + mpEsc(d ? d.name_it : '') + '</div></div>' +
      '<label class="mp-lab">' + (it ? 'Sezione' : 'Section') + '</label>' +
      '<select class="mp-in" id="mpv-section">' +
        MP_SECTIONS.map(function(s){
          var cur = v.section || (d && d.section) || 'Other';
          return '<option value="' + mpEsc(s) + '"' + (s === cur ? ' selected' : '') + '>' + mpEsc(s) + '</option>';
        }).join('') +
      '</select>' +
      '<label class="mp-lab">' + (it ? 'Descrizione' : 'Description') + '</label>' +
      '<textarea class="mp-in" id="mpv-desc" rows="3" maxlength="' + MP_MAX_DESC + '">' +
        mpEsc(v.description || (d && d.description_en) || '') + '</textarea>' +
      (v.notes ? '<label class="mp-lab">' + (it ? 'Note' : 'Notes') + '</label>' +
        '<textarea class="mp-in" id="mpv-notes" rows="2" maxlength="' + MP_MAX_NOTE + '">' + mpEsc(v.notes) + '</textarea>' : '');

  } else if (v.action === 'delete'){
    // The one that can hurt. Red, the name spelled out, the consequence named,
    // the safe way out first — and an Undo afterwards, because "riccio" and
    // "riso" are one misheard syllable apart.
    var nc = d ? mpCommentsFor('dish', d.id).length : 0;
    title = it ? 'Lo cancello?' : 'Delete it?';
    go    = it ? 'Sì, cancella' : 'Yes, delete it';
    body = heard + '<div class="mp-vdo danger"><div class="mp-vdo-k">' + (it ? 'Cancella' : 'Delete') + '</div>' +
      '<div class="mp-vdo-n">' + mpEsc(d ? d.name_it : '') + '</div>' +
      '<div class="mp-vdo-s">' + (it
        ? 'Sparisce per tutti' + (nc ? ', con ' + nc + ' commento' + (nc === 1 ? '' : 'i') : '') +
          '. Avrai qualche secondo per annullare.'
        : 'It disappears for everyone' + (nc ? ', and takes ' + nc + ' comment' + (nc === 1 ? '' : 's') + ' with it' : '') +
          '. You get a few seconds to undo.') + '</div></div>';
  } else { mpVoiceStuck(v.heard || ''); return; }

  mpSheet(title, body +
    '<div class="mp-sheet-actions">' +
      (v.action === 'delete'
        ? '<button class="mp-btn ghost" onclick="mpVoiceCancel()">' + (it ? 'No, lascialo' : 'No, keep it') + '</button>' +
          '<button class="mp-btn go" onclick="mpVoiceCommit(this)">' + mpEsc(go) + '</button>'
        : '<button class="mp-btn go" onclick="mpVoiceCommit(this)">' + mpEsc(go) + '</button>' +
          '<button class="mp-btn ghost" onclick="mpVoiceStart()">' + (it ? 'Ridillo' : 'Say it again') + '</button>') +
    '</div>');
}

// ── the write. Everything above this line changes nothing. ─────────────────
async function mpVoiceCommit(btn){
  var v = mpVIntent; if (!v) return;
  var free = mpLock(btn); if (!free) return;
  try {
    var it = mpVoiceIt(), d = mpVoiceDishOf(v), res;

    if (v.action === 'add'){
      var name = (document.getElementById('mpv-name').value || '').trim();
      if (!name){ mpToast(it ? 'Serve un nome.' : 'It needs a name.', true); return; }
      var wantStatus = (document.getElementById('mpv-status') || {}).value || 'Idea';
      if (!mpCanSetStatus(wantStatus, null)) wantStatus = 'Idea';
      var pick = function(wrapId){
        var w = document.getElementById(wrapId);
        return w ? [].slice.call(w.querySelectorAll('.mp-pill.on')).map(function(b){ return b.getAttribute('data-v'); }) : [];
      };
      var row = {
        name_it: name,
        section: (document.getElementById('mpv-section') || {}).value || 'Other',
        description_en: ((document.getElementById('mpv-desc') || {}).value || '').trim() || null,
        for_menus: pick('mpv-menus'),
        allergens: pick('mpv-allerg'),
        notes: v.notes || null,
        status: wantStatus,
        created_by: mpMe.name, updated_by: mpMe.name
      };
      if (wantStatus === 'Approved') row.approved_date = mpToday();
      res = await sb.from('menu_plan_dishes').insert(row).select().single();
      if (mpErr(res, 'the dish')) return;
      mpVoiceFinish(name + (it ? ' aggiunto' : ' added'));

    } else if (v.action === 'status'){
      if (!d) return;
      // Straight through the existing gate — it owns the approver rule and the
      // "taking it back out of Approved" confirmation.
      mpVoiceStopEar(); mpCloseSheet(); mpVIntent = null;
      await mpSetDishStatus(d.id, v.status);
      return;

    } else if (v.action === 'attach' || v.action === 'detach'){
      if (!d) return;
      var cur = (d.for_menus || []).slice();
      var next = v.action === 'attach'
        ? (cur.indexOf(v.menu) >= 0 ? cur : cur.concat([v.menu]))
        : cur.filter(function(x){ return x !== v.menu; });
      res = await sb.from('menu_plan_dishes')
        .update({ for_menus: next, updated_at:new Date().toISOString(), updated_by:mpMe.name }).eq('id', d.id);
      if (mpErr(res, 'the dish')) return;
      mpVoiceFinish(d.name_it + ' → ' + (v.action === 'attach' ? v.menu : (it ? 'tolto da ' : 'off ') + v.menu));

    } else if (v.action === 'edit'){
      if (!d) return;
      var patch = {
        section: (document.getElementById('mpv-section') || {}).value || d.section,
        description_en: ((document.getElementById('mpv-desc') || {}).value || '').trim() || null,
        updated_at: new Date().toISOString(), updated_by: mpMe.name
      };
      var nEl = document.getElementById('mpv-notes');
      if (nEl) patch.notes = (nEl.value || '').trim() || null;
      res = await sb.from('menu_plan_dishes').update(patch).eq('id', d.id);
      if (mpErr(res, 'the dish')) return;
      mpVoiceFinish(it ? 'Salvato' : 'Saved');

    } else if (v.action === 'delete'){
      if (!d) return;
      // Everything needed to put it back is kept in memory FIRST — the row and
      // its comments — because after the delete there is nothing to read.
      var comments = mpCommentsFor('dish', d.id).slice();
      var keep = Object.assign({}, d);
      res = await sb.from('menu_plan_dishes').delete().eq('id', d.id);
      if (mpErr(res, 'the delete')) return;
      if (comments.length) await sb.from('menu_plan_comments').delete().eq('target_type','dish').eq('target_id', d.id);
      mpVUndo = { dish:keep, comments:comments };
      mpVoiceFinish('');
      mpVoiceShowUndo((it ? 'Cancellato: ' : 'Deleted: ') + keep.name_it);
    }
  } finally { free(); }
}
async function mpVoiceFinish(msg){
  mpVoiceStopEar();
  mpCloseSheet();
  mpVIntent = null;
  await mpLoadAll();
  mpRender();
  if (msg) mpToast(msg);
}

// ── undo, for the one thing that cannot be said again ──────────────────────
function mpVoiceShowUndo(text){
  var bar = document.getElementById('mp-undo'), txt = document.getElementById('mp-undo-txt');
  if (!bar || !txt) return;
  txt.textContent = text;
  bar.classList.add('show');
  if (mpVUndoTimer) clearTimeout(mpVUndoTimer);
  mpVUndoTimer = setTimeout(function(){ mpVoiceHideUndo(); mpVUndo = null; }, 9000);
}
function mpVoiceHideUndo(){
  var bar = document.getElementById('mp-undo');
  if (bar) bar.classList.remove('show');
  if (mpVUndoTimer){ clearTimeout(mpVUndoTimer); mpVUndoTimer = null; }
}
async function mpVoiceUndo(){
  var u = mpVUndo; mpVUndo = null;
  mpVoiceHideUndo();
  if (!u) return;
  // Put it back exactly as it was, id included, so anything pointing at it — a
  // tasting item, a photo row — still finds it.
  var res = await sb.from('menu_plan_dishes').insert(u.dish);
  if (mpErr(res, 'putting it back')) return;
  if (u.comments.length){
    await sb.from('menu_plan_comments').insert(u.comments.map(function(c){
      return { id:c.id, target_type:c.target_type, target_id:c.target_id,
               author:c.author, body:c.body, created_at:c.created_at };
    }));
  }
  await mpLoadAll(); mpRender();
  mpToast((mpVoiceIt() ? 'Rimesso: ' : 'Put back: ') + u.dish.name_it);
}

