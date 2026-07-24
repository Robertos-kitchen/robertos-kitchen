// ══════════════════════════════════════════════════════════════════════════
// MENU DEVELOPMENT PLAN
//
// Two things kept deliberately separate:
//   1. DISH BANK      — chefs log every dish they develop. The creative engine.
//                       Filling it is the team's whole job for the sprint.
//   2. MENU CALENDAR  — leadership schedules each menu across the year and
//                       pulls dishes from the bank.
// Plus a Sprint tracker, Menu Briefs, Tasting sessions, and a comment thread
// so the plan can be SUBMITTED by the chefs and APPROVED by Francesco in-app.
//
// Identity: this module has its own tap-your-name picker, limited to the people
// in menu_plan_members (Danilo, Antonio, Andrea Falcone = chefs; Francesco =
// approver). No code, no password — his call: the team must feel zero friction.
// Every write is stamped with the name, so the audit trail survives.
//
// Reads every list from the DB (members, menus, months present on rows) — no
// hardcoded mirror of table data anywhere, so adding a person or a menu is an
// INSERT, not a redeploy. Schema: menu-plan-schema.sql
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
const MP_CELL_STATES = ['Develop','Testing','Photoshooting','Launch','Live','Changing'];
// Two-letter codes for the tiny calendar squares — single letters collided
// (Launch/Live both 'L', Testing/... ). Kept in workflow order.
const MP_CELL_CODE = { Develop:'De', Testing:'Te', Photoshooting:'Ph', Launch:'La', Live:'Li', Changing:'Ch' };
const MP_DECISIONS = ['Approve','Rework','Reject'];

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
let mpSprint   = null;
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
let mpTab      = 'plan'; // plan | dishes | calendar | briefs | tastings
let mpBoardView = 'list';// list | board  (list is the phone default)
let mpFilter   = { section:'', menu:'', status:'', q:'' };
let mpDishFiles = {};    // dish_id -> [ cost-sheet file rows ]
let mpGroupSel  = {};    // menu_group -> selected variant menu id (calendar/briefs)
let mpLoaded   = false;

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
    sb.from('menu_plan_dish_files').select('*').order('created_at')
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
  var tables = ['menu_plan_dishes','menu_plan_menus','menu_plan_calendar','menu_plan_comments','menu_plan_sprint','menu_plan_menu_files','menu_plan_dish_files','menu_plan_tastings','menu_plan_tasting_items'];
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
  var tabs = [
    { k:'plan',     label:'The Plan' },
    { k:'dishes',   label:'Dishes',     badge: mpDishes.length },
    { k:'calendar', label:'Calendar' },
    { k:'briefs',   label:'Menus' },
    { k:'tastings', label:'Tastings',   badge: mpTastings.length }
  ];
  var body = mpTab === 'plan'     ? mpRenderPlan()
           : mpTab === 'dishes'   ? mpRenderDishes()
           : mpTab === 'calendar' ? mpRenderCalendar()
           : mpTab === 'briefs'   ? mpRenderBriefs()
           :                        mpRenderTastings();

  host.innerHTML = MP_STYLE +
    '<div class="mp-wrap">' +
      '<div class="mp-top">' +
        '<div>' +
          '<div class="mp-h1">Menu Development Plan</div>' +
          '<div class="mp-h1sub">' + mpEsc(mpStatusLine()) + '</div>' +
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

function mpStatusLine(){
  var s = (mpSprint && mpSprint.status) || 'draft';
  if (s === 'approved')          return 'Approved by ' + (mpSprint.approved_by || 'Francesco') + ' · ' + mpDateLabel(mpSprint.approved_at);
  if (s === 'submitted')         return 'Submitted ' + mpDateLabel(mpSprint.submitted_at) + ' · waiting for Francesco';
  if (s === 'changes_requested') return 'Francesco asked for changes — see the comments';
  return 'Draft · not submitted yet';
}

// ══ 1. THE PLAN (home) ═════════════════════════════════════════════════════
function mpRenderPlan(){
  var tried = mpTriedCount(), approved = mpApprovedCount();
  var tT = (mpSprint && mpSprint.target_tried)    || 60;
  var tA = (mpSprint && mpSprint.target_approved) || 30;
  var next = mpNextTasting();
  var s = (mpSprint && mpSprint.status) || 'draft';
  var isChef = mpMe && mpMe.role === 'chef';
  var noDates = !mpSprint || (!mpSprint.start_date && !mpSprint.end_date);

  // What is still missing, in plain words. This is the whole "easy for them"
  // idea: never make them hunt for what is not done.
  var todo = [];
  if (noDates) todo.push({ n:'!', what:'propose your start date, end date and dish goal', go:'plan-sprint' });
  var noBrief = mpMenus.filter(function(m){ return !m.identity || !m.structure; });
  if (noBrief.length) todo.push({ n: noBrief.length, what: noBrief.length === 1 ? 'menu still has no identity or structure' : 'menus still have no identity or structure', go:'briefs' });
  var noLead = mpMenus.filter(function(m){ return !m.lead_chef; });
  if (noLead.length) todo.push({ n: noLead.length, what: noLead.length === 1 ? 'menu has no lead chef' : 'menus have no lead chef', go:'briefs' });
  var emptyRows = mpMenus.filter(function(m){ return !mpCal.some(function(c){ return c.menu_id === m.id; }); });
  if (emptyRows.length) todo.push({ n: emptyRows.length, what: emptyRows.length === 1 ? 'menu has nothing on the calendar' : 'menus have nothing on the calendar', go:'calendar' });
  if (tried < tT)    todo.push({ n: tT - tried,    what: 'more dishes to try', go:'dishes' });
  if (approved < tA) todo.push({ n: tA - approved, what: 'more dishes to approve', go:'dishes' });

  var canSubmit = mpDishes.length > 0;
  var openC = mpOpenCommentCount('plan', null);

  return '<div class="mp-body">' +

    (s === 'changes_requested'
      ? '<div class="mp-banner warn"><strong>Francesco asked for changes.</strong> Read his comments below, fix what he asked, then submit again.</div>' : '') +
    (s === 'approved'
      ? '<div class="mp-banner ok"><strong>Plan approved.</strong> Keep developing dishes — that never stops.</div>' : '') +

    // ── the guide (chefs only) ──
    (isChef ? mpGuideCard() : '') +

    // ── the two bars ──
    '<div class="mp-card" id="plan-sprint">' +
      '<div class="mp-card-h">The sprint</div>' +
      mpBar('Dishes tried', tried, tT, 'var(--mp-trying)') +
      mpBar('Dishes approved', approved, tA, 'var(--mp-approved)') +
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

    // ── what's left ──
    '<div class="mp-card">' +
      '<div class="mp-card-h">Still to do</div>' +
      (todo.length
        ? '<div class="mp-todo">' + todo.map(function(t){
            var go = t.go === 'plan-sprint' ? "document.getElementById('plan-sprint').scrollIntoView({behavior:'smooth'})" : "mpGo('" + t.go + "')";
            return '<button class="mp-todo-row" onclick="' + go + '">' +
              '<span class="mp-todo-n">' + t.n + '</span><span>' + mpEsc(t.what) + '</span><span class="mp-todo-go">&rsaquo;</span></button>';
          }).join('') + '</div>'
        : '<div class="mp-empty ok">Nothing outstanding. Good to submit.</div>') +
    '</div>' +

    // ── the calendar, here for approval ──
    '<div class="mp-card">' +
      '<div class="mp-card-h">The year calendar</div>' +
      '<div class="mp-hint">Tap any square to set what happens that month. Same grid as the Calendar tab.</div>' +
      mpCalendarGrid() +
      (mpCanAuthor() ? '<button class="mp-btn ghost" onclick="mpAddMenu()">+ Add a menu</button>' : '') +
    '</div>' +

    // ── submit / approve ──
    (mpIsCostController()
      ? '<div class="mp-card"><div class="mp-card-h">Your job</div><div class="mp-hint">Open the <button class="mp-link" onclick="mpGo(\'dishes\')">Dishes</button> tab, filter to <strong>Costing</strong>, review each cost sheet and mark it Costed.</div></div>'
      : '<div class="mp-card">' +
        '<div class="mp-card-h">Submit &amp; approve</div>' +
        '<div class="mp-statusline">' + mpEsc(mpStatusLine()) + '</div>' +
        (mpIsApprover()
          ? '<div class="mp-actions">' +
              '<button class="mp-btn go" onclick="mpApprovePlan()"' + (s === 'approved' ? ' disabled title="Already approved"' : '') + '>Approve the plan</button>' +
              '<button class="mp-btn warn" onclick="mpRequestChanges()">Ask for changes</button>' +
            '</div>'
          : '<div class="mp-actions">' +
              '<button class="mp-btn go" onclick="mpSubmitPlan()"' +
                (canSubmit ? '' : ' disabled title="Add at least one dish before submitting"') + '>' +
                (s === 'draft' ? 'Submit to Francesco' : 'Submit again') + '</button>' +
            '</div>' +
            (canSubmit ? '' : '<div class="mp-why">Add at least one dish before submitting.</div>')) +
      '</div>') +

    // ── plan-level comments (two-way) ──
    mpCommentBlock('plan', null, 'Comments on the whole plan' + (openC ? ' (' + openC + ')' : '')) +
  '</div>';
}

// The chef's guide: what to do, in order, and what happens after Submit. Folds
// away once read, but stays reachable — no stress, nothing to hunt for.
function mpGuideCard(){
  var steps = [
    ['1', 'Add your dishes', 'Log every dish you develop in Dishes — even the ones that don’t work.'],
    ['2', 'Write each menu', 'On Menus, give each one an identity, a structure, a price and a lead chef.'],
    ['3', 'Set the calendar', 'On the grid below, say which month each menu is developed, tested, launched.'],
    ['4', 'Propose dates & goal', 'Set the sprint’s start, end and how many dishes you’re aiming for.'],
    ['5', 'Submit', 'Send it to Francesco. He reads it, comments, and approves — or sends it back.']
  ];
  return '<details class="mp-guide" open>' +
    '<summary><span class="mp-guide-k">How this works</span><span class="mp-guide-hint">tap to hide</span></summary>' +
    '<div class="mp-guide-steps">' +
      steps.map(function(s){
        return '<div class="mp-guide-step"><span class="mp-guide-n">' + s[0] + '</span>' +
          '<span><strong>' + mpEsc(s[1]) + '</strong><span>' + mpEsc(s[2]) + '</span></span></div>';
      }).join('') +
    '</div></details>';
}
function mpBar(label, n, target, colour){
  var pct = target > 0 ? Math.min(100, Math.round(n / target * 100)) : 0;
  return '<div class="mp-bar-wrap">' +
    '<div class="mp-bar-top"><span>' + mpEsc(label) + '</span><strong>' + n + ' / ' + target + '</strong></div>' +
    '<div class="mp-bar"><i style="width:' + pct + '%;background:' + colour + '"></i></div>' +
  '</div>';
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
      '<div><label class="mp-lab">Goal — dishes tried</label><input class="mp-in" type="number" inputmode="numeric" id="mps-tt" value="' + (s.target_tried || 60) + '"/></div>' +
      '<div><label class="mp-lab">Goal — dishes approved</label><input class="mp-in" type="number" inputmode="numeric" id="mps-ta" value="' + (s.target_approved || 30) + '"/></div>' +
    '</div>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpSaveSprint()">Save</button>' +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">Cancel</button>' +
    '</div>');
}
async function mpSaveSprint(){
  var row = {
    id:1,
    start_date: document.getElementById('mps-start').value || null,
    end_date:   document.getElementById('mps-end').value || null,
    target_tried:    +document.getElementById('mps-tt').value || 60,
    target_approved: +document.getElementById('mps-ta').value || 30,
    updated_at: new Date().toISOString()
  };
  var res = await sb.from('menu_plan_sprint').upsert(row, { onConflict:'id' });
  if (mpErr(res, 'the sprint')) return;
  mpCloseSheet(); await mpLoadAll(); mpRender(); mpToast('Sprint updated');
}

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
    (mpCanAuthor() ? '<button class="mp-big" onclick="mpAddDish()">+ Add a dish</button>' : '') +

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
        (mpFilter.q || mpFilter.section || mpFilter.menu || mpFilter.status
          ? '<button class="mp-link" onclick="mpClearFilter()">Clear filters</button>' : '') +
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
function mpCanSetStatus(status){
  if (!mpCanAuthor()) return false;
  if (status === 'Approved') return mpIsApprover();
  return true;
}
function mpStatusMenu(id, ev){
  if (ev) ev.stopPropagation();
  var d = mpDishes.find(function(x){ return x.id === id; });
  if (!d) return;
  if (!mpCanAuthor()){ mpToast('Only chefs and Francesco change a dish’s stage.', true); return; }
  mpSheet('Move “' + d.name_it + '”',
    '<div class="mp-statuslist">' + MP_STATUSES.map(function(s){
      var allowed = mpCanSetStatus(s);
      return '<button class="mp-statusrow' + (d.status === s ? ' now' : '') + (allowed ? '' : ' locked') + '"' +
        (allowed ? ' onclick="mpCloseSheet();mpSetDishStatus(\'' + id + '\',\'' + s + '\')"' : ' disabled') + '>' +
        '<span class="mp-chip s-' + s.toLowerCase() + '">' + s + '</span>' +
        '<span class="mp-statusnote">' + mpEsc(MP_STATUS_NOTE[s]) + '</span>' +
        (allowed ? '' : '<span class="mp-locked">Only Francesco can do this</span>') +
      '</button>';
    }).join('') + '</div>');
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
  if (!mpCanSetStatus(status)){ mpToast('Only Francesco can approve a dish.', true); return; }
  var patch = { status:status, updated_at:new Date().toISOString(), updated_by:mpMe.name };
  if (status === 'Approved' && !d.approved_date) patch.approved_date = mpToday();
  var res = await sb.from('menu_plan_dishes').update(patch).eq('id', id);
  if (mpErr(res, 'the dish')) return;
  Object.assign(d, patch);
  mpRender();
  mpToast(d.name_it + ' → ' + status);
}

// ── add / edit a dish ───────────────────────────────────────────────────────
// Only two fields are required. Everything else is optional and folded away —
// a chef with flour on their hands must be able to log a dish in ten seconds.
function mpAddDish(){ mpDishForm(null); }
function mpOpenDish(id){ mpDishForm(mpDishes.find(function(x){ return x.id === id; }) || null); }

function mpDishForm(d){
  var isNew = !d;
  d = d || { name_it:'', description_en:'', section:'', for_menus:[], status:'Idea',
             allergens:[], notes:'' };
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
    '<label class="mp-lab">Dish name <em>(Italian)</em></label>' +
    '<input class="mp-in" id="mpf-name" value="' + mpEsc(d.name_it) + '" placeholder="e.g. Tortello di burrata"' + ro + '/>' +

    '<label class="mp-lab">Section</label>' +
    '<select class="mp-in" id="mpf-section"' + ro + '>' +
      '<option value="">Choose a section…</option>' +
      MP_SECTIONS.map(function(s){ return '<option' + (d.section === s ? ' selected' : '') + '>' + mpEsc(s) + '</option>'; }).join('') +
    '</select>' +

    '<label class="mp-lab">What it is <em>(plain English — optional)</em></label>' +
    '<textarea class="mp-in" id="mpf-desc" rows="2" placeholder="Burrata tortello, tomato water, basil oil"' + ro + '>' + mpEsc(d.description_en) + '</textarea>' +

    '<div class="mp-photo-row">' +
      (photo ? '<img class="mp-photo-prev" id="mpf-prev" src="' + photo + '"/>' : '<div class="mp-photo-prev empty" id="mpf-prev">no photo</div>') +
      (canEdit ? '<div>' +
        '<input type="file" accept="image/*" id="mpf-photo" style="display:none" onchange="mpPickPhoto(this)"/>' +
        '<button class="mp-btn ghost" onclick="document.getElementById(\'mpf-photo\').click()">' + (photo ? 'Change photo' : 'Add a photo') + '</button>' +
        (photo ? '<button class="mp-btn ghost danger" onclick="mpDropPhoto()">Remove</button>' : '') +
      '</div>' : '') +
    '</div>' +

    '<details class="mp-more"' + (isNew ? '' : ' open') + '>' +
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

      '<label class="mp-lab">Notes</label>' +
      '<textarea class="mp-in" id="mpf-notes" rows="3" placeholder="What to fix, what worked, supplier…"' + ro + '>' + mpEsc(d.notes || '') + '</textarea>' +
    '</details>' +

    (d.id
      ? '<div class="mp-dishfoot">' +
          '<span class="mp-chip s-' + d.status.toLowerCase() + '">' + mpEsc(d.status) + '</span>' +
          (d.approved_date ? '<span class="mp-fine">approved ' + mpEsc(mpDateLabel(d.approved_date)) + '</span>' : '') +
        '</div>'
      : '') +

    // ── costing (only once a dish is Approved / in Costing) ──
    (inCosting ? mpCostingBlock(d) : '') +

    (canEdit
      ? '<div class="mp-sheet-actions">' +
          '<button class="mp-btn go" onclick="mpSaveDish(' + (d.id ? "'" + d.id + "'" : 'null') + ')">' + (isNew ? 'Add it' : 'Save') + '</button>' +
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
      ? '<input class="mp-in" id="mpf-price" value="' + mpEsc(d.selling_price || '') + '" placeholder="e.g. AED 120"/>'
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

async function mpSaveDish(id){
  var name = (document.getElementById('mpf-name').value || '').trim();
  var section = document.getElementById('mpf-section').value || '';
  if (!name){ mpToast('Give the dish a name first.', true); document.getElementById('mpf-name').focus(); return; }
  if (!section){ mpToast('Choose a section first.', true); document.getElementById('mpf-section').focus(); return; }
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
}
async function mpDeleteDish(id){
  var d = mpDishes.find(function(x){ return x.id === id; });
  var ok = await mpConfirm('Delete “' + (d ? d.name_it : 'this dish') + '”?',
    'It disappears for everyone, and from any tasting it was attached to. This cannot be undone. If you just want it off the board, set it to Retired instead.',
    'Delete');
  if (!ok) return;
  var res = await sb.from('menu_plan_dishes').delete().eq('id', id);
  if (mpErr(res, 'the delete')) return;
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
    '<textarea class="mp-in" id="mpcc-note" rows="3" placeholder="Costed and entered in Simphony">' + mpEsc(d.costing_note || '') + '</textarea>' +
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
  return '<div class="mp-body">' +
    '<div class="mp-hint">Rows are menus, columns are months. Tap a square to set what happens; tap a menu name to edit or delete it.</div>' +
    '<div class="mp-legend">' + MP_CELL_STATES.map(function(s){
      return '<span class="mp-leg"><i class="mp-sw c-' + s.toLowerCase() + '"></i>' + s + '</span>';
    }).join('') + '<span class="mp-leg"><i class="mp-sw c-none"></i>Nothing</span></div>' +
    mpCalendarGrid() +
    (mpMenus.length === 0 ? '<div class="mp-empty big">No menus yet — add one below.</div>' : '') +
    (mpCanAuthor() ? '<button class="mp-big ghost" onclick="mpAddMenu()">+ Add a menu</button>' : '') +
  '</div>';
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
      '<button class="mp-statusrow" onclick="mpCloseSheet();mpEditMenu(\'' + menuId + '\')"><span class="mp-statusnote"><strong>Edit this menu</strong> — identity, price, dates, lead chef</span></button>' +
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
          '<button class="mp-btn ghost small" onclick="mpCloseSheet();mpEditMenu(\'' + v.id + '\')">Edit</button>' +
          '<button class="mp-btn ghost small danger" onclick="mpCloseSheet();mpDeleteMenu(\'' + v.id + '\')">Delete</button>' +
        '</div>';
      }).join('') +
    '</div>' +
    (mpCanAuthor() ? '<button class="mp-btn go" onclick="mpAddVariant(\'' + mpEsc(group) + '\')">+ Add a variant</button>' : ''));
}
async function mpAddVariant(group){
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
}

function mpCellMenu(menuId, monthKey){
  if (!mpCanAuthor()){ mpToast('Only chefs and Francesco edit the calendar.', true); return; }
  var menu = mpMenus.find(function(m){ return m.id === menuId; });
  var c = mpCellObj(menuId, monthKey) || {};
  var mk = monthKey.slice(0,7);            // 'YYYY-MM'
  var last = new Date(+mk.slice(0,4), +mk.slice(5,7), 0).getDate();
  var min = mk + '-01', max = mk + '-' + String(last).padStart(2,'0');
  mpSheet(mpEsc(menu ? menu.name : '') + ' · ' + mpMonthLabel(monthKey),
    '<label class="mp-lab">What happens this month</label>' +
    '<div class="mp-pills" id="mpcell-state">' +
      MP_CELL_STATES.map(function(s){
        return '<button type="button" class="mp-pill cell' + (c.state === s ? ' on' : '') + '" data-v="' + s + '" onclick="mpPickOne(this)">' +
          '<i class="mp-swatch c-' + s.toLowerCase() + '"></i>' + s + '</button>';
      }).join('') +
    '</div>' +
    '<label class="mp-lab">Specific date <em>(optional — leave blank for the whole month)</em></label>' +
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
  return '<div class="mp-body">' +
    '<div class="mp-hint">One card per menu. Say what it <em>is</em>, what it is made of, and who leads it. Set Menu shows one card — pick A, B or C at the top.</div>' +
    mpMenuRows().map(function(row){
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
    }).join('') +
    (mpCanAuthor() ? '<button class="mp-big ghost" onclick="mpAddMenu()">+ Add a menu</button>' : '') +
  '</div>';
}
// The inner of a menu brief card (shared by standalone menus and group variants).
function mpBriefInner(m){
  var oc = mpOpenCommentCount('menu', m.id);
  var approved = mpDishes.filter(function(d){ return (d.for_menus || []).includes(m.name) && MP_RANK[d.status] >= 3; }).length;
  var pool     = mpDishes.filter(function(d){ return (d.for_menus || []).includes(m.name); }).length;
  return '<div class="mp-menu-h">' +
      '<div><div class="mp-menu-name">' + mpEsc(m.name) + '</div>' +
      '<div class="mp-menu-sub">' + mpEsc(m.change_cadence || '—') + (m.lead_chef ? ' · ' + mpEsc(m.lead_chef) : ' · no lead chef') + '</div></div>' +
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
        ? '<button class="mp-btn go small" onclick="mpApproveMenu(\'' + m.id + '\')"' + (m.status === 'approved' ? ' disabled title="Already approved"' : '') + '>Approve</button>' +
          '<button class="mp-btn warn small" onclick="mpCommentOn(\'menu\',\'' + m.id + '\',true)">Ask for changes</button>'
        : '<button class="mp-btn ghost" onclick="mpCommentOn(\'menu\',\'' + m.id + '\')">Comment' + (oc ? ' (' + oc + ')' : '') + '</button>') +
      (mpCanAuthor() ? '<button class="mp-btn ghost danger" onclick="mpDeleteMenu(\'' + m.id + '\')">Delete</button>' : '') +
    '</div>' +
    (mpCommentsFor('menu', m.id).length ? mpCommentBlock('menu', m.id, 'Comments (' + mpCommentsFor('menu', m.id).length + ')', true) : '');
}
const MP_MSTATUS_LABEL = { draft:'Draft', submitted:'Submitted', approved:'Approved', changes_requested:'Changes asked' };

// Delete a menu — names the consequence (calendar row, docs, dish tags) first.
async function mpDeleteMenu(id){
  var m = mpMenus.find(function(x){ return x.id === id; });
  if (!m || !mpCanAuthor()) return;
  var tagged = mpDishes.filter(function(d){ return (d.for_menus || []).includes(m.name); }).length;
  var ok = await mpConfirm('Delete “' + m.name + '”?',
    'It clears this menu’s calendar row and any uploaded documents' +
    (tagged ? ', and untags it from ' + tagged + ' dish' + (tagged === 1 ? '' : 'es') + ' (the dishes stay)' : '') +
    '. This cannot be undone.', 'Delete');
  if (!ok) return;
  // clean up storage objects for this menu's docs (DB rows cascade)
  var files = mpFilesFor(id);
  if (files.length && sb.storage && sb.storage.from){
    try { await sb.storage.from(MP_BUCKET).remove(files.map(function(f){ return f.file_path; })); } catch(e){}
  }
  var res = await sb.from('menu_plan_menus').delete().eq('id', id);
  if (mpErr(res, 'the menu')) return;
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
  mpSheet('Edit ' + (m.name || 'menu'),
    '<label class="mp-lab">Menu name</label>' +
    '<input class="mp-in" id="mpm-name" value="' + mpEsc(m.name || '') + '"/>' +
    '<label class="mp-lab">Identity <em>(one line — what is this menu?)</em></label>' +
    '<textarea class="mp-in" id="mpm-identity" rows="2" placeholder="Coastal southern Italy, simple, ingredient-led">' + mpEsc(m.identity || '') + '</textarea>' +
    '<label class="mp-lab">Structure</label>' +
    '<textarea class="mp-in" id="mpm-structure" rows="2" placeholder="5 antipasti · 4 paste · 3 secondi · 3 dolci">' + mpEsc(m.structure || '') + '</textarea>' +
    '<label class="mp-lab">Price</label>' +
    '<input class="mp-in" id="mpm-price" value="' + mpEsc(m.price || '') + '" placeholder="AED 295 per person"/>' +
    '<label class="mp-lab">How often it changes</label>' +
    '<select class="mp-in" id="mpm-cadence">' + MP_CADENCES.map(function(c){
      return '<option' + (m.change_cadence === c ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select>' +
    '<label class="mp-lab">Lead chef</label>' +
    '<select class="mp-in" id="mpm-lead"><option value="">—</option>' +
      mpMembers.map(function(p){ return '<option' + (m.lead_chef === p.name ? ' selected' : '') + '>' + mpEsc(p.name) + '</option>'; }).join('') +
    '</select>' +
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
    '<input class="mp-in" id="mpm-new" placeholder="e.g. Bartolini Dinner · 2–3 Nov"/>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpCreateMenu()">Add menu</button>' +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">Cancel</button>' +
    '</div>');
}
async function mpCreateMenu(){
  var name = (document.getElementById('mpm-new').value || '').trim();
  if (!name){ mpToast('Give the menu a name first.', true); return; }
  var max = mpMenus.reduce(function(a, m){ return Math.max(a, m.sort_order || 0); }, 0);
  var res = await sb.from('menu_plan_menus').insert({ name:name, sort_order:max + 10, updated_by:mpMe.name });
  if (mpErr(res, 'the menu')) return;
  mpCloseSheet(); await mpLoadAll(); mpRender(); mpToast(name + ' added');
}
async function mpSaveMenu(id){
  var row = {
    name:      (document.getElementById('mpm-name').value || '').trim(),
    identity:  (document.getElementById('mpm-identity').value || '').trim() || null,
    structure: (document.getElementById('mpm-structure').value || '').trim() || null,
    price:     (document.getElementById('mpm-price').value || '').trim() || null,
    change_cadence: document.getElementById('mpm-cadence').value,
    lead_chef: document.getElementById('mpm-lead').value || null,
    testing_date: document.getElementById('mpm-testing').value || null,
    launch_date:  document.getElementById('mpm-launch').value || null,
    updated_at: new Date().toISOString(), updated_by: mpMe.name
  };
  if (!row.name){ mpToast('The menu needs a name.', true); return; }
  var res = await sb.from('menu_plan_menus').update(row).eq('id', id);
  if (mpErr(res, 'the menu')) return;
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
function mpItemScored(i){ return !!(i.taste_score || i.presentation_score || i.decision); }
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
                  var sc = [];
                  if (i.taste_score) sc.push('T' + i.taste_score);
                  if (i.presentation_score) sc.push('P' + i.presentation_score);
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
    '<input class="mp-in" id="mpt-title" placeholder="e.g. Autumn à la carte round 1"/>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpSaveTasting()">Book it</button>' +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">Cancel</button>' +
    '</div>');
}
async function mpSaveTasting(){
  var date = document.getElementById('mpt-date').value;
  if (!date){ mpToast('Pick a date first.', true); return; }
  var res = await sb.from('menu_plan_tastings').insert({
    session_date:date, session_time:(document.getElementById('mpt-time').value || '') || null,
    title:(document.getElementById('mpt-title').value || '').trim() || null, created_by:mpMe.name });
  if (mpErr(res, 'the tasting')) return;
  mpCloseSheet(); await mpLoadAll(); mpRender(); mpToast('Tasting booked for ' + mpDateLabel(date));
}
async function mpDeleteTasting(id){
  var ok = await mpConfirm('Delete this tasting?', 'The session and all its scores go for everyone. The dishes themselves stay.', 'Delete');
  if (!ok) return;
  var res = await sb.from('menu_plan_tastings').delete().eq('id', id);
  if (mpErr(res, 'the delete')) return;
  await mpLoadAll(); mpRender(); mpToast('Tasting deleted');
}
function mpAttachDishes(sessionId){
  var s = mpTastings.find(function(x){ return x.id === sessionId; });
  if (!s) return;
  var already = s.items.filter(function(i){ return i.dish_id; }).map(function(i){ return i.dish_id; });
  var manual = s.items.filter(function(i){ return !i.dish_id; });
  var pool = mpDishes.filter(function(d){ return d.status !== 'Retired'; });
  mpSheet('Attach dishes',
    '<div class="mp-hint">Tap the dishes being tasted on ' + mpEsc(mpDateLabel(s.session_date)) + '.</div>' +
    (pool.length
      ? '<div class="mp-pills" id="mpt-pick">' +
          pool.map(function(d){
            return '<button type="button" class="mp-pill' + (already.includes(d.id) ? ' on' : '') + '" data-v="' + d.id + '" onclick="this.classList.toggle(\'on\')">' + mpEsc(d.name_it) + '</button>';
          }).join('') +
        '</div>'
      : '<div class="mp-empty">No dishes in the bank yet — type one below.</div>') +

    '<label class="mp-lab">Not in the bank yet? Type it in</label>' +
    (manual.length
      ? '<div class="mp-manual-list">' + manual.map(function(i){
          return '<div class="mp-manual-row"><span>' + mpEsc(i.manual_name) + '</span>' +
            '<button class="mp-file-x" onclick="mpRemoveManualItem(\'' + i.id + '\',\'' + sessionId + '\')">&times;</button></div>';
        }).join('') + '</div>'
      : '') +
    '<div class="mp-addrow">' +
      '<input class="mp-in" id="mpt-manual" placeholder="e.g. New scallop dish"/>' +
      '<button class="mp-btn ghost" onclick="mpAddManualItem(\'' + sessionId + '\')">Add</button>' +
    '</div>' +

    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpSaveAttach(\'' + sessionId + '\')">Save</button>' +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">Cancel</button>' +
    '</div>');
}
// A typed dish is inserted straight away (its own row) so it survives the Save
// diff, which only touches linked dishes. It lives on the tasting only.
async function mpAddManualItem(sessionId){
  var name = (document.getElementById('mpt-manual').value || '').trim();
  if (!name){ mpToast('Type a name first.', true); return; }
  var res = await sb.from('menu_plan_tasting_items').insert({ session_id:sessionId, manual_name:name });
  if (mpErr(res, 'the dish')) return;
  await mpLoadAll(); mpAttachDishes(sessionId); mpToast(name + ' added');
}
async function mpRemoveManualItem(itemId, sessionId){
  var res = await sb.from('menu_plan_tasting_items').delete().eq('id', itemId);
  if (mpErr(res, 'the dish')) return;
  await mpLoadAll(); mpAttachDishes(sessionId);
}
async function mpSaveAttach(sessionId){
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
}
// Score one item on TWO categories (Taste, Presentation) 1–5 + an outcome.
function mpScoreDish(sessionId, itemId){
  var s = mpTastings.find(function(x){ return x.id === sessionId; });
  var it = s ? s.items.find(function(i){ return i.id === itemId; }) : null;
  if (!it) return;
  var canEdit = mpCanAuthor();
  var scale = function(id, val){
    return '<div class="mp-pills" id="' + id + '">' +
      [1,2,3,4,5].map(function(n){
        return '<button type="button" class="mp-pill score' + (Number(val) === n ? ' on' : '') + '"' + (canEdit ? ' onclick="mpPickOne(this)"' : ' disabled') + ' data-v="' + n + '">' + n + '</button>';
      }).join('') + '</div>';
  };
  mpSheet('Score “' + mpItemName(it) + '”',
    '<div class="mp-fine">1 = very bad · 5 = very good</div>' +
    '<label class="mp-lab">Taste</label>' + scale('mps-taste', it.taste_score) +
    '<label class="mp-lab">Presentation</label>' + scale('mps-pres', it.presentation_score) +
    '<label class="mp-lab">Outcome</label>' +
    '<div class="mp-pills" id="mps-dec">' +
      MP_DECISIONS.map(function(x){
        return '<button type="button" class="mp-pill' + (it.decision === x ? ' on' : '') + '"' + (canEdit ? ' onclick="mpPickOne(this)"' : ' disabled') + ' data-v="' + x + '">' + x + '</button>';
      }).join('') +
    '</div>' +
    '<label class="mp-lab">Comment</label>' +
    '<textarea class="mp-in" id="mps-comment" rows="3" placeholder="What to change"' + (canEdit ? '' : ' disabled') + '>' + mpEsc(it.comment || '') + '</textarea>' +
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
async function mpSaveScore(sessionId, itemId){
  var s = mpTastings.find(function(x){ return x.id === sessionId; });
  var it = s ? s.items.find(function(i){ return i.id === itemId; }) : null;
  if (!it) return;
  var pick = function(id){ var on = document.querySelector('#' + id + ' .mp-pill.on'); return on ? on.getAttribute('data-v') : null; };
  var taste = pick('mps-taste'), pres = pick('mps-pres'), dec = pick('mps-dec');
  var res = await sb.from('menu_plan_tasting_items').update({
    taste_score: taste ? +taste : null,
    presentation_score: pres ? +pres : null,
    decision: dec,
    comment: (document.getElementById('mps-comment').value || '').trim() || null
  }).eq('id', itemId);
  if (mpErr(res, 'the score')) return;

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
    '<textarea class="mp-in" id="mpc-body" rows="4" placeholder="Say what you think, or what needs changing"></textarea>' +
    '<div class="mp-sheet-actions">' +
      '<button class="mp-btn go" onclick="mpSaveComment(\'' + type + '\',' + (id ? "'" + id + "'" : 'null') + ',' + (alsoFlag ? 'true' : 'false') + ')">Post</button>' +
      '<button class="mp-btn ghost" onclick="mpCloseSheet()">Cancel</button>' +
    '</div>');
}
async function mpSaveComment(type, id, alsoFlag){
  var body = (document.getElementById('mpc-body').value || '').trim();
  if (!body){ mpToast('Write something first.', true); return; }
  var res = await sb.from('menu_plan_comments').insert({ target_type:type, target_id:id, author:mpMe.name, body:body });
  if (mpErr(res, 'the comment')) return;
  if (alsoFlag && type === 'menu'){
    await sb.from('menu_plan_menus').update({ status:'changes_requested', updated_at:new Date().toISOString(), updated_by:mpMe.name }).eq('id', id);
  }
  mpCloseSheet(); await mpLoadAll(); mpRender(); mpToast('Comment posted');
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
      '<td style="border:1px solid #d8cbb6;padding:6px 8px;font-size:12px">' + mpEsc(m.lead_chef || '—') + '</td>' +
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
      ['Menu','Identity','Structure','Price','Lead'].map(function(h){
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
    '<div class="mp-sheet-h"><span>' + mpEsc(title) + '</span><button class="mp-x" onclick="mpCloseSheet()">&times;</button></div>' +
    '<div class="mp-sheet-body">' + bodyHtml + '</div></div>';
  ov.onclick = function(e){ if (e.target === ov) mpCloseSheet(); };
  document.body.appendChild(ov);
  setTimeout(function(){ ov.classList.add('in'); }, 10);
}
function mpCloseSheet(){
  var s = document.getElementById('mp-sheet');
  if (s) s.remove();
  mpPendingPhoto = undefined;
}
// Confirms NAME THE CONSEQUENCE — never "Are you sure?".
function mpConfirm(title, what, actionLabel){
  return new Promise(function(resolve){
    var ov = document.createElement('div');
    ov.className = 'mp-ovl confirm';
    ov.innerHTML = '<div class="mp-ovl-box small">' +
      '<div class="mp-ovl-title">' + mpEsc(title) + '</div>' +
      '<div class="mp-ovl-sub">' + mpEsc(what) + '</div>' +
      '<div class="mp-sheet-actions">' +
        '<button class="mp-btn go" id="mpc-yes">' + mpEsc(actionLabel) + '</button>' +
        '<button class="mp-btn ghost" id="mpc-no">Cancel</button>' +
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
      ? '<textarea class="mp-in" id="mpp-in" rows="4">' + mpEsc(value || '') + '</textarea>'
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
}
#menuplan-view{background:var(--mp-cream-l);padding:0 0 60px}
.mp-wrap{max-width:1180px;margin:0 auto;padding:14px 14px 0}
.mp-loading{color:var(--mp-mute);font-size:14px;padding:20px 0}
.mp-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.mp-h1{font-family:'Forum',Georgia,serif;font-size:27px;line-height:1.05;color:var(--mp-maroon)}
.mp-h1sub{font-size:11.5px;color:var(--mp-mute);margin-top:3px}
.mp-me{flex:none;background:#fff;border:1px solid var(--mp-line);border-radius:20px;padding:7px 13px;font:600 12.5px 'Outfit',sans-serif;color:var(--mp-maroon);cursor:pointer}
.mp-me span{display:block;font-weight:400;font-size:9.5px;color:var(--mp-mute);letter-spacing:.6px;text-transform:uppercase}

/* tabs */
.mp-tabs{display:flex;gap:5px;overflow-x:auto;margin:13px -14px 0;padding:0 14px 1px;scrollbar-width:none}
.mp-tabs::-webkit-scrollbar{display:none}
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
.mp-bar{height:11px;background:var(--mp-cream);border-radius:6px;overflow:hidden}
.mp-bar i{display:block;height:100%;border-radius:6px;transition:width .35s ease}
.mp-sprint-meta{font-size:11.5px;color:var(--mp-mute);border-top:1px solid var(--mp-line);padding-top:9px}
.mp-next{font-size:14px;margin-bottom:10px}
.mp-next span{display:block;font-size:11.5px;color:var(--mp-mute);margin-top:2px}

/* still-to-do */
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
.mp-legend{display:flex;gap:11px;flex-wrap:wrap;font-size:11.5px;color:var(--mp-mute)}
.mp-leg{display:inline-flex;align-items:center;gap:5px}
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
.mp-pills{display:flex;gap:6px;flex-wrap:wrap}
.mp-pill{border:1px solid var(--mp-line);background:#fff;border-radius:20px;padding:8px 13px;font:500 12.5px 'Outfit',sans-serif;color:var(--mp-mute);cursor:pointer;-webkit-tap-highlight-color:transparent}
.mp-pill.on{background:var(--mp-maroon);border-color:var(--mp-maroon);color:#fff}
.mp-pill.score{min-width:46px;text-align:center;font-size:15px}
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

@media(max-width:520px){
  .mp-h1{font-size:23px}
  .mp-sel{max-width:132px}
  .mp-menu-facts{gap:12px}
}
</style>`;
