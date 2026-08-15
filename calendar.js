// ══════════════════════════════════════════════════════════════════════════
// CALENDAR MODULE — the kitchen's planning months
//
// Built from Danilo's own `calendar date.xlsx`, which is NOT a page of notes:
// it is the same chain repeated per seasonal ingredient — TASTING, then PUSH
// about a week later, then LIVE about a week after that — plus a weekly event
// and two standing monthly lines.
//
//   • kitchen_cal_notes = one row per note. `chain_id` ties an anchor to its
//     followers. `series_id` marks occurrences made by one repeat.
//   • kitchen_cal_types = the buttons themselves. Tasting/Push/Live/Event were
//     four hardcoded strings; renaming one meant a deploy. They are rows now,
//     and the chef edits them on the Types screen: rename, recolour, reorder,
//     add his own, and decide which one starts a chain.
//   • THE ANCHOR TOWS ITS CHAIN. Whichever type carries role='anchor' — it is
//     Tasting today, it need not stay Tasting — moving one moves its followers
//     with it, keeping their gaps. A follower moves alone. A chain is only ever
//     driven from the front. That is Francesco's rule: the tasting is the start
//     of everything they plan.
//   • Month / 3 months / Year. A chain routinely crosses a month boundary — the
//     dentex tasting is 22 Oct and its live is 2 Nov — so one month at a time
//     hid the shape of the plan and made that drag impossible.
//   • Confirmed private events come from the FOH events desk, read-only.
//
// Every change puts up a message carrying UNDO, hung off <body> because our own
// write echoes back through realtime and re-renders the view — which used to
// wipe the button about a second after it appeared.
// ══════════════════════════════════════════════════════════════════════════

const CAL_KEY    = 'calendar';
const CAL_TABLE  = 'kitchen_cal_notes';
const CAL_TYPES  = 'kitchen_cal_types';

// The events-desk layer is not a row in kitchen_cal_types — it is not the
// kitchen's to edit, so it carries its own fixed colours.
const CAL_FOH = { id:'foh', label:'From the events desk', bg:'#6A5B4C', fg:'#F3EBE1', role:'plain' };

// Colours a new type can take. Kept to the Solid set Francesco chose, so a type
// the chef invents at 6am still looks like the rest of the app.
const CAL_SWATCHES = [
  ['#5E0A10','#FBEFE9'], ['#A33A10','#FFEFE7'], ['#1D4E4A','#E6F2EF'],
  ['#3E4A1D','#F0F4E0'], ['#6A5B4C','#F3EBE1'], ['#7A5E00','#FFF8E2'],
  ['#2F3E55','#E4ECF5'], ['#5A2A55','#F5E6F2']
];

let calRows      = [];
let calTypes     = [];
let calFoh       = [];
let calY         = 0;
let calM         = 0;
let calChannel   = null;
let calBooted    = false;
let calDrag      = null;
let calSheetKind = null;
let calView      = 'month';   // month | quarter | year
let calTypeDraft = [];

function calEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function calAttr(s){ return calEsc(s).replace(/'/g,'&#39;'); }

// ── dates ──────────────────────────────────────────────────────────────────
// Plain yyyy-mm-dd throughout. The midday anchor keeps a timezone from ever
// shifting a note by a day.
const CAL_MN  = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const CAL_MNS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const CAL_DN  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function calToday(){ return (typeof TODAY !== 'undefined' && TODAY) ? TODAY : new Date().toISOString().slice(0,10); }
function calD(iso){ return new Date(iso + 'T12:00:00'); }
function calKey(d){ return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
function calShift(iso, days){ const d = calD(iso); d.setDate(d.getDate() + days); return calKey(d); }
function calGap(a, b){ return Math.round((calD(b) - calD(a)) / 86400000); }
function calPretty(iso){ const d = calD(iso); return d.getDate() + ' ' + CAL_MNS[d.getMonth()]; }
function calUuid(){
  if(window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){
    const r = Math.random()*16|0, v = c === 'x' ? r : (r&0x3|0x8);
    return v.toString(16);
  });
}
function calSlug(s){
  const base = String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,24) || 'type';
  let id = base, n = 2;
  while(calTypes.some(t => t.id === id)) id = base + '-' + (n++);
  return id;
}

// ── the types ──────────────────────────────────────────────────────────────
function calType(id){
  if(id === 'foh') return CAL_FOH;
  return calTypes.find(t => t.id === id) ||
         { id:id, label:id, bg:'#6E5B4A', fg:'#F5EDE0', role:'plain' };
}
function calActive(){ return calTypes.filter(t => t.active !== false); }
function calAnchorType(){ return calTypes.find(t => t.role === 'anchor' && t.active !== false) || null; }
function calFollowerTypes(){
  return calTypes.filter(t => t.role === 'follower' && t.active !== false)
                 .sort((a,b) => (a.offset_days||0) - (b.offset_days||0));
}

// ── the model ──────────────────────────────────────────────────────────────
function calOnDay(iso){
  return calRows.filter(r => r.note_date === iso)
                .concat(calFoh.filter(e => e.date === iso));
}
// An anchor is whatever the types table says starts a chain, not the word
// "tasting" — the chef can rename it or move the role somewhere else.
function calIsAnchor(r){
  if(!r.chain_id) return false;
  return calType(r.kind).role === 'anchor';
}
function calChain(id){ return id ? calRows.filter(r => r.chain_id === id) : []; }
function calFollowers(r){ return calIsAnchor(r) ? calChain(r.chain_id).filter(o => o.id !== r.id) : []; }
// A chain is whole when every follower type is present. Anything less is the
// state that goes stale unnoticed, so the anchor says so on the grid.
function calMissing(id){
  const got = calChain(id).map(r => r.kind);
  return calFollowerTypes().filter(t => got.indexOf(t.id) < 0).map(t => t.id);
}

// ── load ───────────────────────────────────────────────────────────────────
function calNoTable(err){
  if(!err) return false;
  const code = String(err.code || '');
  // PostgREST answers a missing table with PGRST205, not the Postgres 42P01.
  // Checking only 42P01 turned "not set up yet" into "check the connection",
  // which sends someone hunting a network fault that is not there.
  return code === 'PGRST205' || code === '42P01' || /schema cache/i.test(String(err.message || ''));
}

async function calLoadTypes(){
  const res = await sb.from(CAL_TYPES).select('*').order('sort');
  if(res.error) throw res.error;
  calTypes = res.data || [];
}

async function calLoad(){
  // One month either side of whatever is on screen, so a drag across a boundary
  // always has its neighbour loaded and a chain never half-disappears.
  const span  = calView === 'year' ? 12 : (calView === 'quarter' ? 3 : 1);
  const start = calView === 'year' ? new Date(calY, 0, 1) : new Date(calY, calM, 1);
  const from  = calKey(new Date(start.getFullYear(), start.getMonth() - 1, 1));
  const to    = calKey(new Date(start.getFullYear(), start.getMonth() + span + 1, 0));
  const res   = await sb.from(CAL_TABLE).select('*').gte('note_date', from).lte('note_date', to).limit(3000);
  if(res.error){ calRows = []; throw res.error; }
  calRows = res.data || [];
}

// The events desk is a courtesy layer: if it is down the calendar still works,
// so nothing here is allowed to throw.
async function calLoadFoh(){
  try{
    const res = await fetch(FOH_EVENTS_URL, { headers:{ 'x-proxy-secret': KITCHEN_PROXY_SECRET } });
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if(data && data.error) throw new Error(data.error);
    calFoh = (data.events || []).map(function(e){
      const pax = e.guests ? (' · ' + e.guests + ' pax') : '';
      return { id:'foh-'+e.id, date:String(e.date).slice(0,10), kind:'foh', body:(e.name || 'Private event') + pax, readonly:true };
    });
  }catch(err){
    console.warn('[calendar] events desk unavailable', err);
    calFoh = [];
  }
}

// ── render ─────────────────────────────────────────────────────────────────
function calHost(){ return document.getElementById('calendar-view'); }
function calChipStyle(t){ return 'background:' + t.bg + ';color:' + t.fg; }

// One month's 42 cells. Split out because the quarter draws three of these.
function calMonthCells(y, m, phone){
  const today = calToday();
  const first = new Date(y, m, 1).getDay();
  const days  = new Date(y, m + 1, 0).getDate();
  const prev  = new Date(y, m, 0).getDate();
  const cells = [];
  for(let i = first - 1; i >= 0; i--) cells.push({ y:y, m:m - 1, d:prev - i, out:true });
  for(let d = 1; d <= days; d++)      cells.push({ y:y, m:m,     d:d,        out:false });
  let n = 1;
  while(cells.length < 42) cells.push({ y:y, m:m + 1, d:n++, out:true });

  return cells.map(function(c){
    let yy = c.y, mm = c.m;
    if(mm < 0){ mm = 11; yy--; }
    if(mm > 11){ mm = 0;  yy++; }
    const iso   = calKey(new Date(yy, mm, c.d));
    const items = calOnDay(iso);
    const cls   = ['cal-cell'];
    if(c.out) cls.push('out');
    if(items.length) cls.push('has');
    if(iso === today) cls.push('today');

    let inner = '<div class="cal-dnum"><b>' + c.d + '</b>' + (iso === today ? '<span class="cal-tod">today</span>' : '') + '</div>';
    if(phone){
      if(items.length) inner += '<div class="cal-dots">' + items.map(function(i){
        return '<span class="cal-dot" style="background:' + calType(i.kind).bg + '"></span>';
      }).join('') + '</div>';
    } else {
      inner += items.map(function(r){
        const t    = calType(r.kind);
        const miss = calIsAnchor(r) ? calMissing(r.chain_id) : [];
        return '<div class="cal-chip" style="' + calChipStyle(t) + '" data-id="' + calAttr(r.id) + '"' +
               (r.chain_id ? ' data-ch="' + calAttr(r.chain_id) + '"' : '') + '>' +
               (r.readonly ? '<span class="cal-grip ro"></span>'
                           : '<span class="cal-grip" title="Drag to another day">&#10287;</span>') +
               '<span class="cal-txt">' + calEsc(r.body) + (r.series_id ? ' &#8635;' : '') + '</span>' +
               (miss.length ? '<span class="cal-warn" title="No ' + calAttr(miss.map(k => calType(k).label.toLowerCase()).join(' and no ')) + ' planned yet">!</span>' : '') +
               (calIsAnchor(r) ? '<span class="cal-anch" title="Anchor &mdash; moving this moves the chain">&#9875;</span>' : '') +
               '</div>';
      }).join('');
    }
    const label = CAL_DN[new Date(yy, mm, c.d).getDay()] + ' ' + c.d + ' ' + CAL_MN[mm] + ', ' +
                  (items.length ? items.length + ' note' + (items.length > 1 ? 's' : '') : 'nothing on') + '. Open the day.';
    return '<div class="' + cls.join(' ') + '" data-k="' + iso + '" role="button" tabindex="0" aria-label="' + calAttr(label) + '">' + inner + '</div>';
  }).join('');
}

function calDowRow(){ return '<div class="cal-dow">' + CAL_DN.map(d => '<span>' + d + '</span>').join('') + '</div>'; }

// The year is a map, not a worksheet: no text, no dragging, a dot per note and
// a count per month, so an empty month is obvious from across the room.
function calYearBlock(y, m){
  const first = new Date(y, m, 1).getDay();
  const days  = new Date(y, m + 1, 0).getDate();
  let n = 0, cells = '';
  for(let i = 0; i < first; i++) cells += '<span class="cal-y-d empty"></span>';
  for(let d = 1; d <= days; d++){
    const iso   = calKey(new Date(y, m, d));
    const items = calOnDay(iso);
    n += items.length;
    cells += '<span class="cal-y-d' + (items.length ? ' on' : '') + (iso === calToday() ? ' today' : '') + '">' +
      items.slice(0,3).map(function(i){ return '<i class="cal-y-dot" style="background:' + calType(i.kind).bg + '"></i>'; }).join('') +
      '</span>';
  }
  return '<button type="button" class="cal-y-month" onclick="calOpenMonth(' + y + ',' + m + ')" aria-label="' +
    CAL_MN[m] + ' ' + y + ', ' + (n ? n + ' notes' : 'nothing planned') + '. Open it.">' +
    '<span class="cal-y-h"><b>' + CAL_MN[m] + '</b><span class="cal-y-n">' + (n ? n : '&mdash;') + '</span></span>' +
    '<span class="cal-y-grid">' + cells + '</span></button>';
}

function calRangeLabel(){
  if(calView === 'year') return String(calY);
  if(calView === 'quarter'){
    const a = new Date(calY, calM, 1), b = new Date(calY, calM + 2, 1);
    return CAL_MNS[a.getMonth()] + ' &ndash; ' + CAL_MNS[b.getMonth()] + ' ' +
           (a.getFullYear() === b.getFullYear() ? a.getFullYear() : a.getFullYear() + '/' + String(b.getFullYear()).slice(2));
  }
  return CAL_MN[calM] + ' ' + calY;
}

function calRender(){
  const host = calHost(); if(!host) return;
  const phone = window.matchMedia('(max-width: 700px)').matches;

  let body = '';
  if(calView === 'year'){
    let blocks = '';
    for(let m = 0; m < 12; m++) blocks += calYearBlock(calY, m);
    body = '<div class="cal-year">' + blocks + '</div>';
  } else if(calView === 'quarter'){
    let blocks = '';
    for(let i = 0; i < 3; i++){
      const d = new Date(calY, calM + i, 1);
      blocks += '<div class="cal-qm"><div class="cal-qm-h">' + CAL_MN[d.getMonth()] + ' ' + d.getFullYear() + '</div>' +
                calDowRow() + '<div class="cal-grid">' + calMonthCells(d.getFullYear(), d.getMonth(), phone) + '</div></div>';
    }
    body = '<div class="cal-quarter">' + blocks + '</div>';
  } else {
    body = calDowRow() + '<div class="cal-grid">' + calMonthCells(calY, calM, phone) + '</div>';
  }

  const seg = [['month','Month'],['quarter','3 months'],['year','Year']].map(function(v){
    return '<button type="button" class="' + (calView === v[0] ? 'on' : '') +
           '" onclick="calSetView(&#39;' + v[0] + '&#39;)" aria-pressed="' + (calView === v[0]) + '">' + v[1] + '</button>';
  }).join('');

  host.innerHTML = CAL_STYLE +
    '<div class="cal-top">' +
      '<div class="cal-nav">' +
        '<button class="cal-navbtn" type="button" onclick="calStep(-1)" aria-label="Back">&#8249;</button>' +
        '<span class="cal-month">' + calRangeLabel() + '</span>' +
        '<button class="cal-navbtn" type="button" onclick="calStep(1)" aria-label="Forward">&#8250;</button>' +
      '</div>' +
      '<div class="cal-tools">' +
        '<span class="cal-seg" role="group" aria-label="How many months">' + seg + '</span>' +
        '<button class="cal-tbtn" type="button" onclick="calGoToday()">Today</button>' +
        '<button class="cal-tbtn" type="button" onclick="calOpenTypes()">Types</button>' +
        '<button class="cal-tbtn" type="button" onclick="window.print()">Print</button>' +
      '</div>' +
    '</div>' +
    '<div class="cal-legend">' +
      calActive().map(function(t){
        return '<span class="cal-lg" style="' + calChipStyle(t) + '">' + calEsc(t.label) +
               (t.role === 'anchor' ? ' &#9875;' : '') +
               (t.role === 'follower' ? ' +' + (t.offset_days == null ? 0 : t.offset_days) + 'd' : '') + '</span>';
      }).join('') +
      '<span class="cal-lg" style="' + calChipStyle(CAL_FOH) + '">' + CAL_FOH.label + '</span>' +
      (calView === 'year' ? '' : '<span class="cal-anchnote">&#9875; anchor &mdash; moving it moves the chain</span>') +
    '</div>' +
    '<div class="cal-body" id="cal-body">' + body + '</div>' +
    (calView === 'year' ? '' :
      '<div class="cal-standing">' +
        '<span class="cal-sl">Every month</span>' +
        '<span class="cal-si">Recipes, costing, menu, training, photoshoot</span>' +
        '<span class="cal-si">Floor staff training + 1 dish of the day</span>' +
      '</div>');

  calWire();
}

function calSetView(v){
  if(calView === v) return;
  calView = v;
  calRender();
  calLoad().then(calRender).catch(calFail);
}
function calOpenMonth(y, m){
  calY = y; calM = m; calView = 'month';
  calRender();
  calLoad().then(calRender).catch(calFail);
}
function calStep(n){
  const by = calView === 'year' ? 12 : (calView === 'quarter' ? 3 : 1);
  calM += n * by;
  while(calM < 0){ calM += 12; calY--; }
  while(calM > 11){ calM -= 12; calY++; }
  calRender();
  calLoad().then(calRender).catch(calFail);
}
function calGoToday(){
  const t = calD(calToday());
  calY = t.getFullYear(); calM = t.getMonth();
  calRender();
  calLoad().then(calRender).catch(calFail);
}
function calFail(err){
  console.warn('[calendar] load failed', err);
  const b = document.getElementById('cal-body');
  if(b) b.insertAdjacentHTML('beforebegin',
    '<div class="cal-err">Could not load the calendar &mdash; check the connection and try again.</div>');
}

// ── the message that carries undo ──────────────────────────────────────────
// It hangs off <body>, NOT off the calendar view. calRender() replaces the
// view's innerHTML, and a write of our own echoes straight back through
// realtime and triggers exactly that — which wiped the Undo button about a
// second after it appeared. A message you cannot reach is worse than no
// message: it reads as "saved, and there is nothing you can do about it".
function calToast(msg, undo){
  const old = document.querySelector('.cal-toast'); if(old) old.remove();
  const t = document.createElement('div');
  t.className = 'cal-toast';
  t.setAttribute('role','status');
  t.innerHTML = '<span>' + msg + '</span>';
  if(undo){
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'Undo';
    b.onclick = async function(){
      t.remove();
      try{ await undo(); }catch(err){ console.warn('[calendar] undo failed', err); }
      await calLoad().catch(function(){});
      calRender();
      calToast('Put back.');
    };
    t.appendChild(b);
  }
  document.body.appendChild(t);
  const life = setTimeout(function(){ if(t.parentNode) t.remove(); }, undo ? 12000 : 4000);
  t.addEventListener('pointerenter', function(){ clearTimeout(life); });
}

// ── wiring ─────────────────────────────────────────────────────────────────
function calWire(){
  const body = document.getElementById('cal-body'); if(!body) return;
  body.addEventListener('pointerover', function(e){
    if(calDrag) return;
    const chip = e.target.closest && e.target.closest('.cal-chip');
    const ch   = chip && chip.dataset.ch;
    calClearKin();
    if(!ch) return;
    body.querySelectorAll('.cal-chip[data-ch="' + ch + '"]').forEach(function(c){
      c.classList.add('kin');
      const cell = c.closest('.cal-cell'); if(cell) cell.classList.add('kincell');
    });
  });
  body.addEventListener('pointerleave', calClearKin);
  body.addEventListener('pointerdown', calGripDown);
  body.addEventListener('click', function(e){
    if(e.target.closest('.cal-grip')) return;
    if(e.target.closest('.cal-y-month')) return;
    const cell = e.target.closest('.cal-cell');
    if(cell) calOpenDay(cell.dataset.k);
  });
  body.addEventListener('keydown', function(e){
    if(e.key !== 'Enter' && e.key !== ' ') return;
    const cell = e.target.closest('.cal-cell'); if(!cell) return;
    e.preventDefault();
    calOpenDay(cell.dataset.k);
  });
}
function calClearKin(){
  document.querySelectorAll('.cal-chip.kin').forEach(c => c.classList.remove('kin'));
  document.querySelectorAll('.cal-cell.kincell').forEach(c => c.classList.remove('kincell'));
}
function calCells(){ return document.querySelectorAll('#cal-body .cal-cell'); }

// ── drag, glued to the pointer ─────────────────────────────────────────────
// The row must sit under the finger with a constant offset for the whole drag.
// A gap that grows and snaps back is the sawtooth the team felt in the other
// four lists before 13 Aug.
function calGripDown(e){
  const g = e.target.closest('.cal-grip');
  if(!g || g.classList.contains('ro')) return;
  const chip = g.closest('.cal-chip'); if(!chip) return;
  const row = calRows.find(r => String(r.id) === chip.dataset.id); if(!row) return;
  e.preventDefault();

  const host = calHost();
  const r  = chip.getBoundingClientRect();
  const hr = host.getBoundingClientRect();
  const ghost = chip.cloneNode(true);
  ghost.classList.add('ghost');
  ghost.style.width = r.width + 'px';
  host.appendChild(ghost);

  calDrag = {
    row: row, chip: chip, ghost: ghost, hr: hr,
    dx: e.clientX - r.left, dy: e.clientY - r.top,
    follow: calFollowers(row).map(o => ({ row:o, gap: calGap(row.note_date, o.note_date) }))
  };
  chip.classList.add('lifting');
  calDrag.follow.forEach(function(f){
    const c = document.querySelector('.cal-chip[data-id="' + f.row.id + '"]');
    if(c) c.classList.add('tow');
  });
  calMove(e);
  try{ g.setPointerCapture(e.pointerId); calDrag.pid = e.pointerId; calDrag.grip = g; }catch(_){}
  document.addEventListener('pointermove', calMove, { passive:false });
  document.addEventListener('pointerup', calDrop, true);
  document.addEventListener('pointercancel', calDrop, true);
}

function calMove(e){
  if(!calDrag) return;
  if(e.preventDefault) e.preventDefault();
  calDrag.ghost.style.left = (e.clientX - calDrag.dx - calDrag.hr.left) + 'px';
  calDrag.ghost.style.top  = (e.clientY - calDrag.dy - calDrag.hr.top)  + 'px';

  calCells().forEach(c => c.classList.remove('drop','willmove'));

  // Edge auto-scroll, so a drag can reach a month further down the quarter.
  const pad = 60;
  if(e.clientY < pad) window.scrollBy(0, -16);
  else if(e.clientY > window.innerHeight - pad) window.scrollBy(0, 16);

  const t = document.elementFromPoint(e.clientX, e.clientY);
  const cell = t && t.closest ? t.closest('.cal-cell') : null;
  calDrag.target = cell;
  if(!cell) return;
  cell.classList.add('drop');
  const delta = calGap(calDrag.row.note_date, cell.dataset.k);
  calDrag.follow.forEach(function(f){
    const c = document.querySelector('#cal-body .cal-cell[data-k="' + calShift(f.row.note_date, delta) + '"]');
    if(c && c !== cell) c.classList.add('willmove');
  });
}

async function calDrop(){
  if(!calDrag) return;
  const d = calDrag; calDrag = null;
  document.removeEventListener('pointermove', calMove, { passive:false });
  document.removeEventListener('pointerup', calDrop, true);
  document.removeEventListener('pointercancel', calDrop, true);
  try{ d.grip.releasePointerCapture(d.pid); }catch(_){}

  const to = d.target && d.target.dataset.k;
  d.ghost.remove();
  d.chip.classList.remove('lifting');
  calCells().forEach(c => c.classList.remove('drop','willmove','kincell'));
  if(!to || to === d.row.note_date) return;

  const delta = calGap(d.row.note_date, to);
  const was   = [{ row:d.row, date:d.row.note_date }].concat(d.follow.map(f => ({ row:f.row, date:f.row.note_date })));
  const moves = [{ id:d.row.id, date:to }].concat(d.follow.map(f => ({ id:f.row.id, date:calShift(f.row.note_date, delta) })));

  // Optimistic on screen, then written. A failure puts the rows back and says so.
  was.forEach(function(w, i){ w.row.note_date = moves[i].date; });
  calRender();

  const ok = await calWriteDates(moves);
  if(!ok){
    was.forEach(function(w){ w.row.note_date = w.date; });
    calRender();
    calToast('Could not save that move &mdash; put back. Check the connection.');
    return;
  }
  const undo = async function(){
    await calWriteDates(was.map(w => ({ id:w.row.id, date:w.date })));
    was.forEach(function(w){ w.row.note_date = w.date; });
  };
  const label = calType(d.row.kind).label;
  if(d.follow.length){
    calToast(label + ' moved to <b>' + calPretty(to) + '</b>. ' +
      d.follow.map(f => calType(f.row.kind).label.toLowerCase() + ' ' + calPretty(f.row.note_date)).join(', ') +
      ' &mdash; moved with it.', undo);
  } else {
    calToast(label + ' moved to <b>' + calPretty(to) + '</b>.', undo);
  }
}

async function calWriteDates(moves){
  for(const m of moves){
    const res = await sb.from(CAL_TABLE).update({ note_date: m.date, updated_at: new Date().toISOString() }).eq('id', m.id);
    if(res.error){ console.warn('[calendar] move failed', res.error); return false; }
  }
  return true;
}

// ── sheets ─────────────────────────────────────────────────────────────────
function calSheet(inner, label){
  const scrim = document.createElement('div');
  scrim.className = 'cal-scrim';
  scrim.innerHTML = '<div class="cal-sheet" role="dialog" aria-modal="true" aria-label="' + calAttr(label) + '">' + inner + '</div>';
  calHost().appendChild(scrim);
  scrim.addEventListener('click', function(e){ if(e.target === scrim) scrim.remove(); });
  return scrim;
}

function calOpenDay(iso){
  const d = calD(iso), have = calOnDay(iso);
  const types = calActive();
  if(!types.length){ calToast('No note types yet. Open <b>Types</b> and add one.'); return; }
  const anchor = calAnchorType();
  const follow = calFollowerTypes();
  calSheetKind = (anchor || types[0]).id;

  const list = have.length
    ? '<div class="cal-ex-wrap">' + have.map(function(r){
        const t = calType(r.kind);
        return '<div class="cal-ex" style="' + calChipStyle(t) + '">' +
          '<span>' + calEsc(r.body) + (r.series_id ? ' &#8635;' : '') + '</span>' +
          '<span class="cal-ex-tag">' + (calIsAnchor(r) ? '&#9875; ' : '') + calEsc(t.label) + '</span>' +
          (r.readonly ? '' : '<button class="cal-del" type="button" onclick="calDelete(&#39;' + calAttr(r.id) + '&#39;)" aria-label="Remove this note">&times;</button>') +
          '</div>';
      }).join('') + '</div>'
    : '';

  // A finger cannot hover, so the chain is written out here in full.
  const chId = (have.find(r => r.chain_id) || {}).chain_id;
  let chainHtml = '';
  if(chId){
    const mem = calChain(chId);
    const order = (anchor ? [anchor] : []).concat(follow);
    chainHtml = '<div class="cal-chainline"><span class="cal-cl-h">This chain</span>' +
      order.map(function(t){
        const m = mem.find(r => r.kind === t.id);
        return m
          ? '<span class="cal-cl' + (have.indexOf(m) > -1 ? ' here' : '') + '" style="' + calChipStyle(t) + '">' + calEsc(t.label) + ' ' + calPretty(m.note_date) + '</span>'
          : '<span class="cal-cl miss">' + calEsc(t.label) + ' not planned yet</span>';
      }).join('') + '</div>';
  }

  const chainNote = anchor
    ? '<div class="cal-chainbox" id="cal-cb">' + calEsc(anchor.label) + ' starts a chain: ' +
      (follow.length
        ? follow.map(f => '<b>' + calEsc(f.label.toLowerCase()) + '</b> ' + (f.offset_days == null ? 0 : f.offset_days) + ' days later').join(', ') +
          '. Move the ' + calEsc(anchor.label.toLowerCase()) + ' afterwards and they all follow.'
        : 'nothing follows it yet &mdash; add a follower on the Types screen.') + '</div>'
    : '';

  const scrim = calSheet(
    '<h4>' + CAL_DN[d.getDay()] + ' ' + d.getDate() + ' ' + CAL_MN[d.getMonth()] + '</h4>' +
    '<p class="cal-sub">' + (have.length
        ? (have.length === 1 ? 'One thing on.' : have.length + ' things on.') + ' Add another below.'
        : 'Nothing on yet.') + '</p>' +
    list + chainHtml +
    '<div class="cal-types">' +
      types.map(function(t){
        return '<button type="button" data-t="' + calAttr(t.id) + '" aria-pressed="' + (t.id === calSheetKind) +
               '" style="' + (t.id === calSheetKind ? calChipStyle(t) : '') + '">' + calEsc(t.label) + '</button>';
      }).join('') +
    '</div>' +
    '<input type="text" class="cal-in" placeholder="White truffle menu" aria-label="What is happening" />' +
    chainNote +
    '<label class="cal-chk" id="cal-rep"><input type="checkbox" /> <span>Repeat every week to the end of the month</span></label>' +
    '<div class="cal-err-msg" hidden></div>' +
    '<div class="cal-acts">' +
      '<button type="button" class="cal-btn pri" data-save>Save</button>' +
      '<button type="button" class="cal-btn" data-cancel>Cancel</button>' +
    '</div>', 'The day');

  const inp = scrim.querySelector('.cal-in');
  const err = scrim.querySelector('.cal-err-msg');
  const cb  = scrim.querySelector('#cal-cb');
  const rep = scrim.querySelector('#cal-rep');
  const sync = function(){
    const isAnchor = !!(anchor && calSheetKind === anchor.id);
    if(cb) cb.hidden = !isAnchor;
    rep.hidden = isAnchor;
  };
  sync();
  setTimeout(function(){ inp.focus(); }, 30);

  scrim.querySelectorAll('.cal-types button').forEach(function(b){
    b.onclick = function(){
      calSheetKind = b.dataset.t;
      scrim.querySelectorAll('.cal-types button').forEach(function(x){
        const on = x === b;
        x.setAttribute('aria-pressed', String(on));
        x.setAttribute('style', on ? calChipStyle(calType(x.dataset.t)) : '');
      });
      sync();
    };
  });
  inp.oninput = function(){ err.hidden = true; };
  scrim.querySelector('[data-cancel]').onclick = function(){ scrim.remove(); };
  scrim.querySelector('[data-save]').onclick = async function(){
    const v = inp.value.trim();
    if(!v){ err.textContent = 'Write what is happening first.'; err.hidden = false; inp.focus(); return; }
    const btn = scrim.querySelector('[data-save]');
    btn.disabled = true; btn.textContent = 'Saving…';
    const made = await calSave(iso, calSheetKind, v, rep.querySelector('input').checked);
    if(!made){
      btn.disabled = false; btn.textContent = 'Save';
      err.textContent = 'Could not save — check the connection and try again.';
      err.hidden = false;
      return;
    }
    scrim.remove();
    calRender();
    const undo = async function(){ await calRemove(made.map(r => r.id)); };
    if(anchor && calSheetKind === anchor.id){
      calToast('Chain started. ' + calEsc(anchor.label) + ' <b>' + calPretty(iso) + '</b>' +
        (follow.length ? ', ' + follow.map(f => calEsc(f.label.toLowerCase()) + ' ' + calPretty(calShift(iso, f.offset_days == null ? 0 : f.offset_days))).join(', ') : '') + '.', undo);
    } else if(made.length > 1){
      calToast('Saved on <b>' + made.length + ' days</b> this month.', undo);
    } else {
      calToast('Saved on <b>' + calPretty(iso) + '</b>.', undo);
    }
  };
}

async function calSave(iso, kind, body, repeat){
  const rows = [];
  const anchor = calAnchorType();
  if(anchor && kind === anchor.id){
    const ch = calUuid();
    rows.push({ id:calUuid(), note_date:iso, kind:anchor.id, body:anchor.label + ': ' + body, chain_id:ch });
    calFollowerTypes().forEach(function(f){
      rows.push({ id:calUuid(), note_date:calShift(iso, f.offset_days == null ? 0 : f.offset_days), kind:f.id, body:f.label + ': ' + body, chain_id:ch });
    });
  } else {
    const series = repeat ? calUuid() : null;
    rows.push({ id:calUuid(), note_date:iso, kind:kind, body:body, series_id:series });
    if(repeat){
      const base = calD(iso);
      const last = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
      for(let day = base.getDate() + 7; day <= last; day += 7){
        rows.push({ id:calUuid(), note_date:calKey(new Date(base.getFullYear(), base.getMonth(), day)), kind:kind, body:body, series_id:series });
      }
    }
  }
  const res = await sb.from(CAL_TABLE).insert(rows);
  if(res.error){ console.warn('[calendar] save failed', res.error); return null; }
  calRows = calRows.concat(rows);
  return rows;
}

async function calRemove(ids){
  const res = await sb.from(CAL_TABLE).delete().in('id', ids);
  if(res.error){ console.warn('[calendar] remove failed', res.error); return false; }
  calRows = calRows.filter(r => ids.indexOf(r.id) < 0);
  return true;
}

// Deleting an anchor is the one destructive act worth a question: followers
// with nothing in front of them are exactly the state nobody notices.
async function calDelete(id){
  const row = calRows.find(r => String(r.id) === String(id)); if(!row) return;
  let ids = [row.id];
  if(calIsAnchor(row)){
    const rest = calFollowers(row);
    if(rest.length){
      const both = confirm('This ' + calType(row.kind).label.toLowerCase() + ' starts a chain.\n\nOK — remove it and its ' +
        rest.map(r => calType(r.kind).label.toLowerCase()).join(' and ') +
        '.\nCancel — keep them and remove only this one.');
      if(both) ids = ids.concat(rest.map(r => r.id));
    }
  } else if(row.series_id){
    const all = confirm('This repeats every week.\n\nOK — remove the whole series.\nCancel — remove only this one.');
    if(all) ids = calRows.filter(r => r.series_id === row.series_id).map(r => r.id);
  }
  const gone = calRows.filter(r => ids.indexOf(r.id) > -1).map(function(r){
    return { id:r.id, note_date:r.note_date, kind:r.kind, body:r.body, chain_id:r.chain_id, series_id:r.series_id };
  });
  const ok = await calRemove(ids);
  const scrim = document.querySelector('.cal-scrim'); if(scrim) scrim.remove();
  calRender();
  if(!ok){ calToast('Could not remove that — check the connection.'); return; }
  calToast('Removed ' + (gone.length > 1 ? gone.length + ' notes' : '1 note') + '.', async function(){
    const res = await sb.from(CAL_TABLE).insert(gone);
    if(!res.error) calRows = calRows.concat(gone);
  });
}

// ── the types screen ───────────────────────────────────────────────────────
// The buttons are his to change: rename, recolour, reorder, add his own, and
// move which one starts a chain.
function calOpenTypes(){
  calTypeDraft = calTypes.map(t => Object.assign({}, t));
  calRenderTypes();
}

function calRenderTypes(){
  const old = document.querySelector('.cal-scrim'); if(old) old.remove();
  const rows = calTypeDraft.map(function(t, i){
    const used = calRows.filter(r => r.kind === t.id).length;
    return '<div class="cal-t-row" data-i="' + i + '">' +
      '<span class="cal-t-grip" title="Drag to reorder">&#10287;</span>' +
      '<span class="cal-t-swatch" style="' + calChipStyle(t) + '">' + calEsc(String(t.label || '?').slice(0,2)) + '</span>' +
      '<input class="cal-t-name" type="text" value="' + calAttr(t.label) + '" aria-label="Name" oninput="calTypeEdit(' + i + ',&#39;label&#39;,this.value)" />' +
      '<select class="cal-t-role" aria-label="How it behaves" onchange="calTypeEdit(' + i + ',&#39;role&#39;,this.value)">' +
        ['anchor','follower','plain'].map(function(r){
          const lbl = r === 'anchor' ? 'Starts a chain' : (r === 'follower' ? 'Follows the start' : 'On its own');
          return '<option value="' + r + '"' + (t.role === r ? ' selected' : '') + '>' + lbl + '</option>';
        }).join('') +
      '</select>' +
      '<span class="cal-t-off">' + (t.role === 'follower'
        ? '<input type="number" min="0" max="365" value="' + (t.offset_days == null ? 0 : t.offset_days) + '" aria-label="Days after the start" oninput="calTypeEdit(' + i + ',&#39;offset_days&#39;,this.value)" /> days after'
        : '') + '</span>' +
      '<span class="cal-t-colours">' + CAL_SWATCHES.map(function(c, ci){
        return '<button type="button" class="cal-t-c' + (t.bg === c[0] ? ' on' : '') + '" style="background:' + c[0] + '" ' +
               'onclick="calTypeColour(' + i + ',' + ci + ')" aria-label="Colour ' + (ci+1) + '"></button>';
      }).join('') + '</span>' +
      '<button type="button" class="cal-t-del" onclick="calTypeDelete(' + i + ')" ' +
        (used ? 'title="' + used + ' notes use this — rename it instead" disabled' : 'title="Remove"') + '>&times;</button>' +
      '</div>';
  }).join('');

  const scrim = calSheet(
    '<h4>Note types</h4>' +
    '<p class="cal-sub">These are the buttons on every day. Rename them, recolour them, drag to reorder, or add your own.</p>' +
    '<div class="cal-t-list" id="cal-t-list">' + rows + '</div>' +
    '<button type="button" class="cal-btn cal-t-add" onclick="calTypeAdd()">+ Add a type</button>' +
    '<div class="cal-chainbox">Exactly one type <b>starts a chain</b>. Everything set to <b>follows the start</b> is created with it, the given number of days later, and travels with it when it moves.</div>' +
    '<div class="cal-err-msg" hidden></div>' +
    '<div class="cal-acts">' +
      '<button type="button" class="cal-btn pri" data-save>Save types</button>' +
      '<button type="button" class="cal-btn" data-cancel>Cancel</button>' +
    '</div>', 'Note types');

  scrim.querySelector('[data-cancel]').onclick = function(){ scrim.remove(); };
  scrim.querySelector('[data-save]').onclick = calTypesSave;
  calTypesWireDrag(scrim);
}

function calTypeEdit(i, field, val){
  if(!calTypeDraft[i]) return;
  if(field === 'offset_days') val = Math.max(0, parseInt(val, 10) || 0);
  calTypeDraft[i][field] = val;
  if(field !== 'role') return;
  // Only one type can start a chain. Demoting the old one silently would be a
  // change he never saw, so the list redraws and he watches it happen.
  if(val === 'anchor'){
    calTypeDraft.forEach(function(t, j){ if(j !== i && t.role === 'anchor') t.role = 'plain'; });
  } else if(val === 'follower' && calTypeDraft[i].offset_days == null){
    calTypeDraft[i].offset_days = 7;
  }
  calRenderTypes();
}
function calTypeColour(i, ci){
  calTypeDraft[i].bg = CAL_SWATCHES[ci][0];
  calTypeDraft[i].fg = CAL_SWATCHES[ci][1];
  calRenderTypes();
}
function calTypeAdd(){
  const c = CAL_SWATCHES[calTypeDraft.length % CAL_SWATCHES.length];
  calTypeDraft.push({ id:null, label:'New type', bg:c[0], fg:c[1], role:'plain', offset_days:null, sort:calTypeDraft.length + 1, active:true });
  calRenderTypes();
}
function calTypeDelete(i){
  calTypeDraft.splice(i, 1);
  calRenderTypes();
}

// Reorder is a drag, never arrows — same rule as every other list in the app.
function calTypesWireDrag(scrim){
  const list = scrim.querySelector('#cal-t-list');
  let d = null;
  list.addEventListener('pointerdown', function(e){
    const g = e.target.closest('.cal-t-grip'); if(!g) return;
    const row = g.closest('.cal-t-row'); if(!row) return;
    e.preventDefault();
    d = { row: row };
    row.classList.add('lifting');
    try{ g.setPointerCapture(e.pointerId); d.pid = e.pointerId; d.g = g; }catch(_){}
    document.addEventListener('pointermove', mv, { passive:false });
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
  });
  function mv(e){
    if(!d) return;
    e.preventDefault();
    const rows = [...list.querySelectorAll('.cal-t-row')];
    const over = rows.find(function(r){
      const b = r.getBoundingClientRect();
      return e.clientY >= b.top && e.clientY <= b.bottom;
    });
    if(over && over !== d.row){
      const b = over.getBoundingClientRect();
      list.insertBefore(d.row, (e.clientY < b.top + b.height/2) ? over : over.nextSibling);
    }
  }
  function up(){
    if(!d) return;
    document.removeEventListener('pointermove', mv, { passive:false });
    document.removeEventListener('pointerup', up, true);
    document.removeEventListener('pointercancel', up, true);
    try{ d.g.releasePointerCapture(d.pid); }catch(_){}
    d.row.classList.remove('lifting');
    const order = [...list.querySelectorAll('.cal-t-row')].map(r => +r.dataset.i);
    calTypeDraft = order.map(i => calTypeDraft[i]);
    d = null;
    calRenderTypes();
  }
}

async function calTypesSave(){
  const scrim = document.querySelector('.cal-scrim');
  const err = scrim.querySelector('.cal-err-msg');
  const btn = scrim.querySelector('[data-save]');
  if(!calTypeDraft.length){ err.textContent = 'Keep at least one type.'; err.hidden = false; return; }
  if(calTypeDraft.some(t => !String(t.label || '').trim())){
    err.textContent = 'Every type needs a name.'; err.hidden = false; return;
  }
  if(calTypeDraft.filter(t => t.role === 'anchor').length > 1){
    err.textContent = 'Only one type can start a chain.'; err.hidden = false; return;
  }
  btn.disabled = true; btn.textContent = 'Saving…';

  const rows = calTypeDraft.map(function(t, i){
    return { id: t.id || calSlug(t.label), label: String(t.label).trim(), bg: t.bg, fg: t.fg,
             role: t.role, offset_days: t.role === 'follower' ? (t.offset_days == null ? 7 : t.offset_days) : null,
             sort: i + 1, active: true };
  });
  const keep = rows.map(r => r.id);
  const dropped = calTypes.filter(t => keep.indexOf(t.id) < 0);

  const up = await sb.from(CAL_TYPES).upsert(rows, { onConflict:'id' });
  if(up.error){
    btn.disabled = false; btn.textContent = 'Save types';
    err.textContent = 'Could not save — check the connection and try again.';
    err.hidden = false;
    console.warn('[calendar] types save failed', up.error);
    return;
  }
  for(const t of dropped){
    // The foreign key refuses to drop a type that notes still point at, which
    // is the right answer — the button vanishing would take the meaning of
    // those notes with it. Hide it instead of letting the error escape.
    const del = await sb.from(CAL_TYPES).delete().eq('id', t.id);
    if(del.error){
      await sb.from(CAL_TYPES).update({ active:false }).eq('id', t.id);
      console.warn('[calendar] type still in use, hidden instead', t.id, del.error);
    }
  }
  scrim.remove();
  await calLoadTypes().catch(function(){});
  calRender();
  calToast('Types saved.');
}

// ── realtime, so two chefs never overwrite each other quietly ─────────────
function calSubscribe(){
  try{
    if(calChannel) return;
    calChannel = sb.channel('cal-notes')
      .on('postgres_changes', { event:'*', schema:'public', table:CAL_TABLE }, function(){
        if(calHost() && calHost().style.display === 'block' && !calDrag && !document.querySelector('.cal-scrim')){
          calLoad().then(calRender).catch(function(){});
        }
      })
      .on('postgres_changes', { event:'*', schema:'public', table:CAL_TYPES }, function(){
        if(calHost() && calHost().style.display === 'block' && !document.querySelector('.cal-scrim')){
          calLoadTypes().then(calRender).catch(function(){});
        }
      })
      .subscribe();
  }catch(err){ console.warn('[calendar] realtime unavailable', err); }
}

// ── open ───────────────────────────────────────────────────────────────────
async function openCalendar(){
  activeStation = CAL_KEY;
  hideAllPages();
  const stray = document.querySelector('.cal-toast'); if(stray) stray.remove();
  const host = calHost();
  host.style.display = 'block';
  document.querySelector('.footer-bar').style.display = 'flex';
  document.getElementById('foot-label').textContent = 'Calendar';

  if(!calBooted){
    const t = calD(calToday());
    calY = t.getFullYear(); calM = t.getMonth();
    calBooted = true;
  }
  host.innerHTML = CAL_STYLE + '<div class="ops-title">Calendar</div><div class="ops-subtitle">Loading…</div>';
  try{
    await calLoadTypes();
    await calLoad();
  }catch(err){
    host.innerHTML = CAL_STYLE + '<div class="ops-title">Calendar</div>' +
      '<div class="cal-err">' + (calNoTable(err)
        ? 'The calendar tables have not been created on this database yet. Run kitchen-calendar.sql and kitchen-calendar-types.sql, then reopen this screen.'
        : 'Could not load the calendar &mdash; check the connection and try again.') + '</div>';
    console.warn('[calendar] boot failed', err);
    return;
  }
  calRender();
  calSubscribe();
  calLoadFoh().then(calRender);
}

// ══ styles ═══════════════════════════════════════════════════════════════════
const CAL_STYLE = `<style id="cal-style">
.cal-top{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:0 0 12px}
.cal-nav{display:flex;align-items:center;gap:8px}
.cal-navbtn{width:34px;height:34px;border:1px solid var(--sabbia-dark);background:var(--cream);color:var(--vino);border-radius:8px;font-size:17px;line-height:1;cursor:pointer}
.cal-navbtn:hover{background:var(--sabbia-light)}
.cal-month{font-family:var(--font-serif);font-size:21px;color:var(--vino);min-width:168px;text-align:center}
.cal-tools{display:flex;gap:7px;flex-wrap:wrap;align-items:center}
.cal-tbtn{border:1px solid var(--sabbia-dark);background:var(--cream);color:var(--vino);border-radius:8px;padding:8px 14px;font-family:var(--font-sans);font-size:12px;letter-spacing:.5px;text-transform:uppercase;font-weight:600;cursor:pointer}
.cal-tbtn:hover{background:var(--sabbia-light)}
.cal-seg{display:inline-flex;border:1px solid var(--sabbia-dark);border-radius:8px;overflow:hidden}
.cal-seg button{border:0;background:var(--cream);color:var(--vino-light);font-family:var(--font-sans);font-size:12px;letter-spacing:.5px;text-transform:uppercase;font-weight:600;padding:8px 13px;cursor:pointer}
.cal-seg button+button{border-left:1px solid var(--sabbia-dark)}
.cal-seg button.on{background:var(--vino);color:var(--cream)}

.cal-legend{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:0 0 10px}
.cal-lg{font-size:11px;padding:4px 11px;border-radius:999px;white-space:nowrap;font-weight:600;letter-spacing:.3px}
.cal-anchnote{font-size:11px;color:var(--vino-light);margin-left:auto}

.cal-dow{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:3px;font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:var(--vino-light);font-weight:600;margin-bottom:4px}
.cal-dow span{text-align:center}
.cal-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:3px}
.cal-cell{min-height:104px;background:var(--sabbia-light);border:1px solid var(--sabbia-dark);border-radius:8px;padding:4px 4px 6px;cursor:pointer}
.cal-cell:hover{border-color:var(--vino)}
.cal-cell.out{opacity:.42}
.cal-cell.has{background:var(--cream)}
.cal-cell.today{box-shadow:inset 0 0 0 2px var(--vino)}
.cal-cell.drop{outline:2px solid var(--vino);outline-offset:-1px}
.cal-cell.willmove,.cal-cell.kincell{background:#f0e2df}
.cal-dnum{font-size:11px;color:var(--vino-light);padding:1px 3px 3px;display:flex;justify-content:space-between;align-items:center}
.cal-dnum b{font-weight:700;color:var(--vino);font-size:12px}
.cal-tod{font-size:9px;letter-spacing:.8px;text-transform:uppercase;color:var(--vino)}

.cal-chip{display:flex;gap:4px;align-items:flex-start;border-radius:6px;padding:4px 5px;margin-bottom:3px;font-size:11px;line-height:1.3;touch-action:none}
.cal-chip .cal-grip{opacity:.6;cursor:grab;flex:0 0 auto;line-height:1.3;font-size:11px}
.cal-chip .cal-grip.ro{width:0;overflow:hidden}
.cal-txt{flex:1;min-width:0;overflow-wrap:anywhere}
.cal-anch{flex:0 0 auto;opacity:.9;font-size:10px}
.cal-warn{flex:0 0 auto;width:13px;height:13px;line-height:11px;text-align:center;border:1px solid currentColor;border-radius:50%;font-size:9px;font-weight:700}
.cal-chip.ghost{position:absolute;z-index:60;box-shadow:0 8px 22px rgba(42,26,16,.34);pointer-events:none;margin:0}
.cal-chip.lifting{opacity:.25}
.cal-chip.tow{outline:2px dashed var(--vino);outline-offset:1px}
.cal-chip.kin{outline:2px solid var(--vino);outline-offset:1px}
.cal-dots{display:flex;gap:3px;flex-wrap:wrap;padding:0 3px}
.cal-dot{width:8px;height:8px;border-radius:50%}

/* three months side by side — the view that makes a chain crossing a month
   boundary visible, and draggable */
.cal-quarter{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.cal-qm{min-width:0}
.cal-qm-h{font-family:var(--font-serif);font-size:17px;color:var(--vino);margin:0 0 6px}
.cal-quarter .cal-cell{min-height:72px}
.cal-quarter .cal-chip{font-size:9.5px;padding:3px 4px;align-items:center}
.cal-quarter .cal-dow{font-size:9px;letter-spacing:.6px}
/* 21 day-columns across a laptop is ~55px each. overflow-wrap:anywhere then
   breaks EVERY character and a chip becomes a vertical column of letters 280px
   tall. At this density the chip is a coloured strip, not a sentence: one line,
   clipped. The full text is one tap away on the day. */
.cal-quarter .cal-txt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;overflow-wrap:normal}
.cal-quarter .cal-warn,.cal-quarter .cal-anch{display:none}

/* the year is a map: no text, a dot per note, a count per month */
.cal-year{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.cal-y-month{display:block;width:100%;text-align:left;background:var(--sabbia-light);border:1px solid var(--sabbia-dark);border-radius:10px;padding:10px;cursor:pointer;font-family:var(--font-sans)}
.cal-y-month:hover{border-color:var(--vino);background:var(--cream)}
.cal-y-h{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:7px}
.cal-y-h b{font-family:var(--font-serif);font-size:15px;color:var(--vino);font-weight:400}
.cal-y-n{font-size:11px;color:var(--vino-light);font-weight:600}
.cal-y-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
.cal-y-d{height:15px;border-radius:3px;background:var(--cream);display:flex;align-items:center;justify-content:center;gap:1px}
.cal-y-d.empty{background:transparent}
.cal-y-d.today{box-shadow:inset 0 0 0 1.5px var(--vino)}
.cal-y-dot{width:4px;height:4px;border-radius:50%;display:block}

.cal-standing{display:flex;flex-wrap:wrap;gap:7px;align-items:center;margin-top:14px;padding-top:12px;border-top:1px solid var(--sabbia-dark);font-size:12px;color:var(--vino-light)}
.cal-sl{font-size:10px;letter-spacing:1.4px;text-transform:uppercase;font-weight:600}
.cal-si{background:var(--cream);border:1px solid var(--sabbia-dark);border-radius:7px;padding:5px 10px}
.cal-err{background:#fbe3d9;border:1px solid #A33A10;color:#7a2a08;border-radius:8px;padding:12px 14px;margin:10px 0;font-size:14px}

.cal-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:78px;z-index:400;background:var(--vino);color:var(--cream);border-radius:10px;padding:11px 11px 11px 16px;font-size:13.5px;box-shadow:0 8px 26px rgba(42,26,16,.4);display:flex;gap:12px;align-items:center;max-width:92vw}
.cal-toast span{flex:1;min-width:0}
.cal-toast button{flex:0 0 auto;border:1px solid rgba(245,237,224,.4);background:transparent;color:inherit;font-family:var(--font-sans);font-size:12.5px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;padding:6px 13px;border-radius:7px;cursor:pointer}
.cal-toast button:hover{background:rgba(245,237,224,.16)}

.cal-scrim{position:fixed;inset:0;background:rgba(42,26,16,.5);z-index:500;display:flex;align-items:flex-end;justify-content:center}
.cal-sheet{width:100%;max-width:560px;background:var(--cream);border:1px solid var(--sabbia-dark);border-radius:14px 14px 0 0;padding:18px;max-height:92vh;overflow-y:auto}
.cal-sheet h4{margin:0 0 3px;font-family:var(--font-serif);font-size:20px;color:var(--vino);font-weight:400}
.cal-sub{margin:0 0 14px;font-size:12.5px;color:var(--vino-light)}
.cal-ex-wrap{display:flex;flex-direction:column;gap:5px;margin:0 0 14px}
.cal-ex{display:flex;gap:8px;align-items:center;border-radius:8px;padding:8px 11px;font-size:13px}
.cal-ex-tag{margin-left:auto;font-size:10px;letter-spacing:.9px;text-transform:uppercase;opacity:.8;white-space:nowrap}
.cal-del{flex:0 0 auto;border:0;background:transparent;color:inherit;font-size:19px;line-height:1;cursor:pointer;opacity:.75;padding:0 2px}
.cal-chainline{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px;padding:11px 12px;border:1px solid var(--sabbia-dark);border-radius:9px;background:var(--sabbia-light)}
.cal-cl-h{flex:1 0 100%;font-size:10px;letter-spacing:1.3px;text-transform:uppercase;color:var(--vino-light);font-weight:600}
.cal-cl{font-size:12.5px;padding:5px 10px;border-radius:7px}
.cal-cl.miss{background:transparent;border:1px dashed var(--sabbia-dark);color:var(--vino-light);font-style:italic}
.cal-cl.here{box-shadow:0 0 0 2px var(--vino)}
.cal-types{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.cal-types button{border:1px solid var(--sabbia-dark);background:var(--sabbia-light);color:var(--vino-light);font-family:var(--font-sans);font-size:12.5px;font-weight:600;padding:8px 14px;border-radius:999px;cursor:pointer}
.cal-in{width:100%;font-family:var(--font-sans);font-size:16px;padding:11px 13px;border:1px solid var(--sabbia-dark);border-radius:9px;background:#fff;color:var(--ink)}
.cal-chainbox{margin:11px 0 0;padding:11px 13px;border:1px solid var(--sabbia-dark);border-radius:9px;background:var(--sabbia-light);font-size:12.5px;color:var(--vino-light);line-height:1.5}
.cal-chainbox b{color:var(--vino)}
.cal-chk{display:flex;align-items:flex-start;gap:9px;margin:12px 0 0;font-size:13.5px;color:var(--vino-light)}
.cal-err-msg{color:#A33A10;font-size:13px;margin:9px 0 0;font-weight:600}
.cal-acts{display:flex;gap:9px;margin-top:16px}
.cal-btn{font-family:var(--font-sans);font-size:14px;font-weight:600;padding:11px 20px;border-radius:9px;cursor:pointer;border:1px solid var(--sabbia-dark);background:var(--sabbia-light);color:var(--vino)}
.cal-btn.pri{background:var(--vino);border-color:var(--vino);color:var(--cream)}
.cal-btn[disabled]{opacity:.6;cursor:default}

.cal-t-list{display:flex;flex-direction:column;gap:7px;margin-bottom:12px}
.cal-t-row{display:flex;align-items:center;gap:8px;background:var(--sabbia-light);border:1px solid var(--sabbia-dark);border-radius:9px;padding:8px 10px;flex-wrap:wrap;touch-action:none}
.cal-t-row.lifting{opacity:.4}
.cal-t-grip{cursor:grab;opacity:.6;flex:0 0 auto;font-size:14px;color:var(--vino)}
.cal-t-swatch{flex:0 0 auto;width:30px;height:30px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;text-transform:uppercase}
.cal-t-name{flex:1 1 120px;min-width:96px;font-family:var(--font-sans);font-size:14px;padding:8px 10px;border:1px solid var(--sabbia-dark);border-radius:7px;background:#fff;color:var(--ink)}
.cal-t-role{flex:0 0 auto;font-family:var(--font-sans);font-size:12.5px;padding:8px 8px;border:1px solid var(--sabbia-dark);border-radius:7px;background:#fff;color:var(--ink)}
.cal-t-off{font-size:12px;color:var(--vino-light);display:flex;align-items:center;gap:5px}
.cal-t-off input{width:56px;font-family:var(--font-sans);font-size:13px;padding:7px 8px;border:1px solid var(--sabbia-dark);border-radius:7px;background:#fff;color:var(--ink)}
.cal-t-colours{display:flex;gap:3px;flex-wrap:wrap}
.cal-t-c{width:19px;height:19px;border-radius:5px;border:1px solid var(--sabbia-dark);cursor:pointer;padding:0}
.cal-t-c.on{box-shadow:0 0 0 2px var(--vino)}
.cal-t-del{margin-left:auto;border:0;background:transparent;color:var(--vino);font-size:20px;line-height:1;cursor:pointer;padding:0 4px}
.cal-t-del[disabled]{opacity:.28;cursor:not-allowed}
.cal-t-add{width:100%}

@media (max-width:900px){ .cal-quarter{grid-template-columns:1fr;gap:20px} .cal-year{grid-template-columns:repeat(3,minmax(0,1fr))} }
@media (max-width:700px){
  .cal-cell,.cal-quarter .cal-cell{min-height:56px}
  .cal-month{font-size:18px;min-width:120px}
  .cal-anchnote{display:none}
  .cal-year{grid-template-columns:repeat(2,minmax(0,1fr))}
  .cal-sheet{max-width:none}
}
@media print{
  .cal-top,.cal-toast,.footer-bar,.cal-scrim{display:none !important}
  .cal-cell{min-height:118px;break-inside:avoid}
  .cal-chip{font-size:10px}
  .cal-grid{gap:2px}
  .cal-quarter{grid-template-columns:1fr}
}
</style>`;
