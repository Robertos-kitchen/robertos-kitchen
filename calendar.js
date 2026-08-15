// ══════════════════════════════════════════════════════════════════════════
// CALENDAR MODULE — the kitchen's planning month
//
// Built from Danilo's own `calendar date.xlsx`, which is NOT a page of notes:
// it is the same three-step campaign repeated per seasonal ingredient —
// TASTING, then PUSH about a week later, then LIVE about a week after that —
// plus a weekly event (meat night) and two standing monthly lines.
//
//   • kitchen_cal_notes = one row per note. `chain_id` ties a tasting to its
//     push and its live. `series_id` marks occurrences made by one repeat.
//   • THE TASTING IS THE ANCHOR. Drag a tasting and its push and live move
//     with it, keeping their gaps. Drag a push or a live and it moves alone —
//     a chain is only ever driven from the front. This is Francesco's rule,
//     not an invention: the tasting is the start of everything they plan.
//   • Confirmed private events are drawn from the FOH events desk, read-only.
//     Nobody retypes those, and they cannot be dragged.
//   • Six rows always. A five-row month hides the days either side, and a
//     chain dragged past the 31st would land off-screen with nothing to see.
//
// Every change puts up a message carrying UNDO. One drag can move three rows,
// which is one fat-fingered gesture away from rescheduling a campaign nobody
// meant to touch, so getting back has to be one press.
// ══════════════════════════════════════════════════════════════════════════

const CAL_KEY   = 'calendar';
const CAL_TABLE = 'kitchen_cal_notes';

// Chain rhythm, measured off his own Aug–Dec sheet: tasting → push → live.
const CAL_PUSH_GAP = 8;
const CAL_LIVE_GAP = 13;

const CAL_KIND = {
  tasting: 'Tasting',
  push:    'Push',
  live:    'Live',
  event:   'Event',
  foh:     'Events desk'
};
const CAL_ORDER = ['tasting','push','live','event'];

let calRows      = [];     // kitchen_cal_notes
let calFoh       = [];     // read-only layer from the events desk
let calY         = 0;
let calM         = 0;
let calChannel   = null;
let calBooted    = false;
let calDrag      = null;
let calSheetKind = 'tasting';

function calEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function calAttr(s){ return calEsc(s).replace(/'/g,'&#39;'); }

// ── dates ──────────────────────────────────────────────────────────────────
// Everything is a plain yyyy-mm-dd string. Times are never involved, so the
// midday anchor keeps a timezone from ever shifting a note by a day.
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

// ── the model ──────────────────────────────────────────────────────────────
function calOnDay(iso){
  const own = calRows.filter(r => r.note_date === iso);
  const foh = calFoh.filter(e => e.date === iso);
  return own.concat(foh);
}
function calIsAnchor(r){ return r.kind === 'tasting' && !!r.chain_id; }
function calChain(id){ return id ? calRows.filter(r => r.chain_id === id) : []; }
function calFollowers(r){ return calIsAnchor(r) ? calChain(r.chain_id).filter(o => o.id !== r.id) : []; }
// A chain is whole when it has a tasting, a push and a live. Anything less is
// the state that goes stale unnoticed, so the anchor says so on the grid.
function calMissing(id){
  const got = calChain(id).map(r => r.kind);
  return ['push','live'].filter(k => got.indexOf(k) < 0);
}

// ── load ───────────────────────────────────────────────────────────────────
async function calLoad(){
  // Two months either side, so dragging across a boundary always has its
  // neighbours loaded and a chain never half-disappears.
  const from = calKey(new Date(calY, calM - 2, 1));
  const to   = calKey(new Date(calY, calM + 3, 0));
  const res  = await sb.from(CAL_TABLE).select('*').gte('note_date', from).lte('note_date', to).limit(2000);
  if(res.error){
    calRows = [];
    throw res.error;
  }
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

function calNoTable(err){
  if(!err) return false;
  const code = String(err.code || '');
  return code === 'PGRST205' || code === '42P01' || /schema cache/i.test(String(err.message || ''));
}

// ── render ─────────────────────────────────────────────────────────────────
function calHost(){ return document.getElementById('calendar-view'); }

function calRender(){
  const host = calHost(); if(!host) return;
  const phone  = window.matchMedia('(max-width: 700px)').matches;
  const today  = calToday();
  const first  = new Date(calY, calM, 1).getDay();
  const days   = new Date(calY, calM + 1, 0).getDate();
  const prev   = new Date(calY, calM, 0).getDate();

  const cells = [];
  for(let i = first - 1; i >= 0; i--) cells.push({ y:calY, m:calM - 1, d:prev - i, out:true });
  for(let d = 1; d <= days; d++)      cells.push({ y:calY, m:calM,     d:d,        out:false });
  let n = 1;
  while(cells.length < 42) cells.push({ y:calY, m:calM + 1, d:n++, out:true });

  const grid = cells.map(function(c){
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
      if(items.length){
        inner += '<div class="cal-dots">' + items.map(i => '<span class="cal-dot ' + i.kind + '"></span>').join('') + '</div>';
      }
    } else {
      inner += items.map(function(r){
        const miss = calIsAnchor(r) ? calMissing(r.chain_id) : [];
        return '<div class="cal-chip ' + r.kind + '" data-id="' + calAttr(r.id) + '"' +
               (r.chain_id ? ' data-ch="' + calAttr(r.chain_id) + '"' : '') + '>' +
               (r.readonly ? '<span class="cal-grip ro"></span>'
                           : '<span class="cal-grip" title="Drag to another day">⠿</span>') +
               '<span class="cal-txt">' + calEsc(r.body) + (r.series_id ? ' ↻' : '') + '</span>' +
               (miss.length ? '<span class="cal-warn" title="No ' + miss.map(k => CAL_KIND[k].toLowerCase()).join(' and no ') + ' planned yet">!</span>' : '') +
               (calIsAnchor(r) ? '<span class="cal-anch" title="Anchor — moving this moves the chain">⚓</span>' : '') +
               '</div>';
      }).join('');
    }
    const label = CAL_DN[new Date(yy, mm, c.d).getDay()] + ' ' + c.d + ' ' + CAL_MN[mm] + ', ' +
                  (items.length ? items.length + ' note' + (items.length > 1 ? 's' : '') : 'nothing on') + '. Open the day.';
    return '<div class="' + cls.join(' ') + '" data-k="' + iso + '" role="button" tabindex="0" aria-label="' + calAttr(label) + '">' + inner + '</div>';
  }).join('');

  host.innerHTML = CAL_STYLE +
    '<div class="cal-top">' +
      '<div class="cal-nav">' +
        '<button class="cal-navbtn" type="button" onclick="calStep(-1)" aria-label="Previous month">‹</button>' +
        '<span class="cal-month">' + CAL_MN[calM] + ' ' + calY + '</span>' +
        '<button class="cal-navbtn" type="button" onclick="calStep(1)" aria-label="Next month">›</button>' +
      '</div>' +
      '<div class="cal-tools">' +
        '<button class="cal-tbtn" type="button" onclick="calGoToday()">Today</button>' +
        '<button class="cal-tbtn" type="button" onclick="window.print()">Print</button>' +
      '</div>' +
    '</div>' +
    '<div class="cal-legend">' +
      CAL_ORDER.map(k => '<span class="cal-lg ' + k + '">' + CAL_KIND[k] + '</span>').join('') +
      '<span class="cal-lg foh">From the events desk</span>' +
      '<span class="cal-anchnote">⚓ anchor — moving it moves the chain</span>' +
    '</div>' +
    '<div class="cal-dow">' + CAL_DN.map(d => '<span>' + d + '</span>').join('') + '</div>' +
    '<div class="cal-grid" id="cal-grid">' + grid + '</div>' +
    '<div class="cal-standing">' +
      '<span class="cal-sl">Every month</span>' +
      '<span class="cal-si">Recipes, costing, menu, training, photoshoot</span>' +
      '<span class="cal-si">Floor staff training + 1 dish of the day</span>' +
    '</div>';

  calWire();
}

function calStep(n){
  calM += n;
  if(calM < 0){ calM = 11; calY--; }
  if(calM > 11){ calM = 0;  calY++; }
  calRender();
  calLoad().then(calRender).catch(function(err){ calFail(err); });
}
function calGoToday(){
  const t = calD(calToday());
  calY = t.getFullYear(); calM = t.getMonth();
  calRender();
  calLoad().then(calRender).catch(function(err){ calFail(err); });
}

function calFail(err){
  console.warn('[calendar] load failed', err);
  const g = document.getElementById('cal-grid');
  if(g) g.insertAdjacentHTML('beforebegin',
    '<div class="cal-err">Could not load the calendar — check the connection and try again.</div>');
}

// ── the message that carries undo ──────────────────────────────────────────
// The toast hangs off <body>, NOT off the calendar view. calRender() replaces
// the view's innerHTML, and a write of our own echoes straight back through
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
  const grid = document.getElementById('cal-grid'); if(!grid) return;

  grid.addEventListener('pointerover', function(e){
    if(calDrag) return;
    const chip = e.target.closest && e.target.closest('.cal-chip');
    const ch   = chip && chip.dataset.ch;
    calClearKin(grid);
    if(!ch) return;
    grid.querySelectorAll('.cal-chip[data-ch="' + ch + '"]').forEach(function(c){
      c.classList.add('kin');
      const cell = c.closest('.cal-cell'); if(cell) cell.classList.add('kincell');
    });
  });
  grid.addEventListener('pointerleave', function(){ calClearKin(grid); });

  grid.addEventListener('pointerdown', calGripDown);
  grid.addEventListener('click', function(e){
    if(e.target.closest('.cal-grip')) return;
    const cell = e.target.closest('.cal-cell');
    if(cell) calOpenDay(cell.dataset.k);
  });
  grid.addEventListener('keydown', function(e){
    if(e.key !== 'Enter' && e.key !== ' ') return;
    const cell = e.target.closest('.cal-cell'); if(!cell) return;
    e.preventDefault();
    calOpenDay(cell.dataset.k);
  });
}
function calClearKin(grid){
  grid.querySelectorAll('.cal-chip.kin').forEach(c => c.classList.remove('kin'));
  grid.querySelectorAll('.cal-cell.kincell').forEach(c => c.classList.remove('kincell'));
}

// ── drag, glued to the pointer ─────────────────────────────────────────────
// The row must sit under the finger with a constant offset for the whole drag.
// A gap that grows and snaps back is the sawtooth the team felt in the other
// four lists before 13 Aug — same approach here, on purpose.
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
    row: row, chip: chip, ghost: ghost, host: host, hr: hr,
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

  const grid = document.getElementById('cal-grid'); if(!grid) return;
  grid.querySelectorAll('.cal-cell').forEach(c => c.classList.remove('drop','willmove'));

  // Edge auto-scroll, so a drag can reach a row that is off the screen.
  const pad = 60;
  if(e.clientY < pad) window.scrollBy(0, -14);
  else if(e.clientY > window.innerHeight - pad) window.scrollBy(0, 14);

  const t = document.elementFromPoint(e.clientX, e.clientY);
  const cell = t && t.closest ? t.closest('.cal-cell') : null;
  calDrag.target = cell;
  if(!cell) return;
  cell.classList.add('drop');
  const delta = calGap(calDrag.row.note_date, cell.dataset.k);
  calDrag.follow.forEach(function(f){
    const c = grid.querySelector('.cal-cell[data-k="' + calShift(f.row.note_date, delta) + '"]');
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
  const grid = document.getElementById('cal-grid');
  if(grid) grid.querySelectorAll('.cal-cell').forEach(c => c.classList.remove('drop','willmove','kincell'));

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
    calToast('Could not save that move — put back. Check the connection.');
    return;
  }

  const undo = async function(){
    await calWriteDates(was.map(w => ({ id:w.row.id, date:w.date })));
    was.forEach(function(w){ w.row.note_date = w.date; });
  };
  if(d.follow.length){
    calToast('Tasting moved to <b>' + calPretty(to) + '</b>. ' +
      d.follow.map(f => CAL_KIND[f.row.kind].toLowerCase() + ' ' + calPretty(f.row.note_date)).join(', ') +
      ' — moved with it.', undo);
  } else {
    calToast(CAL_KIND[d.row.kind] + ' moved to <b>' + calPretty(to) + '</b>.', undo);
  }
}

async function calWriteDates(moves){
  for(const m of moves){
    const res = await sb.from(CAL_TABLE).update({ note_date: m.date, updated_at: new Date().toISOString() }).eq('id', m.id);
    if(res.error){ console.warn('[calendar] move failed', res.error); return false; }
  }
  return true;
}

// ── the day ────────────────────────────────────────────────────────────────
function calOpenDay(iso){
  const host = calHost(); if(!host) return;
  const d    = calD(iso);
  const have = calOnDay(iso);

  const list = have.length
    ? '<div class="cal-ex-wrap">' + have.map(function(r){
        return '<div class="cal-ex ' + r.kind + '">' +
          '<span>' + calEsc(r.body) + (r.series_id ? ' ↻' : '') + '</span>' +
          '<span class="cal-ex-tag">' + (calIsAnchor(r) ? '⚓ ' : '') + CAL_KIND[r.kind] + '</span>' +
          (r.readonly ? '' : '<button class="cal-del" type="button" onclick="calDelete(\'' + calAttr(r.id) + '\')" aria-label="Remove this note">×</button>') +
          '</div>';
      }).join('') + '</div>'
    : '';

  // A finger cannot hover, so the chain is written out here in full.
  const chId = (have.find(r => r.chain_id) || {}).chain_id;
  let chainHtml = '';
  if(chId){
    const mem = calChain(chId);
    chainHtml = '<div class="cal-chainline"><span class="cal-cl-h">This chain</span>' +
      ['tasting','push','live'].map(function(k){
        const m = mem.find(r => r.kind === k);
        return m
          ? '<span class="cal-cl ' + k + (have.indexOf(m) > -1 ? ' here' : '') + '">' + CAL_KIND[k] + ' ' + calPretty(m.note_date) + '</span>'
          : '<span class="cal-cl miss">' + CAL_KIND[k] + ' not planned yet</span>';
      }).join('') + '</div>';
  }

  const scrim = document.createElement('div');
  scrim.className = 'cal-scrim';
  scrim.innerHTML =
    '<div class="cal-sheet" role="dialog" aria-modal="true" aria-label="The day">' +
      '<h4>' + CAL_DN[d.getDay()] + ' ' + d.getDate() + ' ' + CAL_MN[d.getMonth()] + '</h4>' +
      '<p class="cal-sub">' + (have.length
          ? (have.length === 1 ? 'One thing on.' : have.length + ' things on.') + ' Add another below.'
          : 'Nothing on yet.') + '</p>' +
      list + chainHtml +
      '<div class="cal-types">' +
        CAL_ORDER.map(k => '<button type="button" class="' + k + '" data-t="' + k + '" aria-pressed="' + (k === 'tasting') + '">' + CAL_KIND[k] + '</button>').join('') +
      '</div>' +
      '<input type="text" class="cal-in" placeholder="White truffle menu" aria-label="What is happening" />' +
      '<div class="cal-chainbox" id="cal-cb">A tasting starts a chain: the <b>push</b> lands ' + CAL_PUSH_GAP +
        ' days later and the <b>live</b> ' + CAL_LIVE_GAP + ' days later. Move the tasting afterwards and both follow.</div>' +
      '<label class="cal-chk" id="cal-rep"><input type="checkbox" /> <span>Repeat every week to the end of the month</span></label>' +
      '<div class="cal-err-msg" hidden></div>' +
      '<div class="cal-acts">' +
        '<button type="button" class="cal-btn pri" data-save>Save</button>' +
        '<button type="button" class="cal-btn" data-cancel>Cancel</button>' +
      '</div>' +
    '</div>';
  host.appendChild(scrim);

  calSheetKind = 'tasting';
  const inp = scrim.querySelector('.cal-in');
  const err = scrim.querySelector('.cal-err-msg');
  const cb  = scrim.querySelector('#cal-cb');
  const rep = scrim.querySelector('#cal-rep');
  const sync = function(){ cb.hidden = calSheetKind !== 'tasting'; rep.hidden = calSheetKind === 'tasting'; };
  sync();
  setTimeout(function(){ inp.focus(); }, 30);

  scrim.querySelectorAll('.cal-types button').forEach(function(b){
    b.onclick = function(){
      calSheetKind = b.dataset.t;
      scrim.querySelectorAll('.cal-types button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      sync();
    };
  });
  inp.oninput = function(){ err.hidden = true; };

  const close = function(){ scrim.remove(); };
  scrim.querySelector('[data-cancel]').onclick = close;
  scrim.onclick = function(e){ if(e.target === scrim) close(); };
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
    close();
    calRender();
    const undo = async function(){ await calRemove(made.map(r => r.id)); };
    if(calSheetKind === 'tasting'){
      calToast('Chain started. Tasting <b>' + calPretty(iso) + '</b>, push ' +
        calPretty(calShift(iso, CAL_PUSH_GAP)) + ', live ' + calPretty(calShift(iso, CAL_LIVE_GAP)) + '.', undo);
    } else if(made.length > 1){
      calToast('Saved on <b>' + made.length + ' days</b> this month.', undo);
    } else {
      calToast('Saved on <b>' + calPretty(iso) + '</b>.', undo);
    }
  };
}

async function calSave(iso, kind, body, repeat){
  const rows = [];
  if(kind === 'tasting'){
    const ch = calUuid();
    rows.push({ id:calUuid(), note_date:iso, kind:'tasting', body:'Tasting: ' + body, chain_id:ch });
    rows.push({ id:calUuid(), note_date:calShift(iso, CAL_PUSH_GAP), kind:'push', body:'Push: ' + body, chain_id:ch });
    rows.push({ id:calUuid(), note_date:calShift(iso, CAL_LIVE_GAP), kind:'live', body:'Live: ' + body, chain_id:ch });
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

// Deleting an anchor is the one destructive act worth a question: a push and a
// live with no tasting in front of them is exactly the state nobody notices.
async function calDelete(id){
  const row = calRows.find(r => String(r.id) === String(id)); if(!row) return;
  let ids = [row.id];
  if(calIsAnchor(row)){
    const rest = calFollowers(row);
    if(rest.length){
      const both = confirm('This tasting starts a chain.\n\nOK — remove the tasting and its ' +
        rest.map(r => CAL_KIND[r.kind].toLowerCase()).join(' and ') +
        '.\nCancel — keep them and remove only the tasting.');
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

// ── realtime, so two chefs never overwrite each other quietly ─────────────
function calSubscribe(){
  try{
    if(calChannel) return;
    calChannel = sb.channel('cal-notes')
      .on('postgres_changes', { event:'*', schema:'public', table:CAL_TABLE }, function(){
        if(calHost() && calHost().style.display === 'block' && !calDrag){
          calLoad().then(calRender).catch(function(){});
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
    await calLoad();
  }catch(err){
    host.innerHTML = CAL_STYLE + '<div class="ops-title">Calendar</div>' +
      '<div class="cal-err">' + (calNoTable(err)
        ? 'The calendar table has not been created on this database yet. Run kitchen-calendar.sql, then reopen this screen.'
        : 'Could not load the calendar — check the connection and try again.') + '</div>';
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
.cal-tools{display:flex;gap:7px}
.cal-tbtn{border:1px solid var(--sabbia-dark);background:var(--cream);color:var(--vino);border-radius:8px;padding:8px 14px;font-family:var(--font-sans);font-size:12px;letter-spacing:.5px;text-transform:uppercase;font-weight:600;cursor:pointer}
.cal-tbtn:hover{background:var(--sabbia-light)}

.cal-legend{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:0 0 10px}
.cal-lg{font-size:11px;padding:4px 11px;border-radius:999px;white-space:nowrap;font-weight:600;letter-spacing:.3px}
.cal-anchnote{font-size:11px;color:var(--vino-light);margin-left:auto}

.cal-lg.tasting,.cal-chip.tasting,.cal-ex.tasting,.cal-cl.tasting,.cal-types button.tasting[aria-pressed="true"]{background:#5E0A10;color:#FBEFE9}
.cal-lg.push,.cal-chip.push,.cal-ex.push,.cal-cl.push,.cal-types button.push[aria-pressed="true"]{background:#A33A10;color:#FFEFE7}
.cal-lg.live,.cal-chip.live,.cal-ex.live,.cal-cl.live,.cal-types button.live[aria-pressed="true"]{background:#1D4E4A;color:#E6F2EF}
.cal-lg.event,.cal-chip.event,.cal-ex.event,.cal-cl.event,.cal-types button.event[aria-pressed="true"]{background:#3E4A1D;color:#F0F4E0}
.cal-lg.foh,.cal-chip.foh,.cal-ex.foh{background:#6A5B4C;color:#F3EBE1}
.cal-dot.tasting{background:#5E0A10}.cal-dot.push{background:#A33A10}.cal-dot.live{background:#1D4E4A}
.cal-dot.event{background:#3E4A1D}.cal-dot.foh{background:#6A5B4C}

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

.cal-standing{display:flex;flex-wrap:wrap;gap:7px;align-items:center;margin-top:14px;padding-top:12px;border-top:1px solid var(--sabbia-dark);font-size:12px;color:var(--vino-light)}
.cal-sl{font-size:10px;letter-spacing:1.4px;text-transform:uppercase;font-weight:600}
.cal-si{background:var(--cream);border:1px solid var(--sabbia-dark);border-radius:7px;padding:5px 10px}

.cal-err{background:#fbe3d9;border:1px solid #A33A10;color:#7a2a08;border-radius:8px;padding:12px 14px;margin:10px 0;font-size:14px}

.cal-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:78px;z-index:400;background:var(--vino);color:var(--cream);border-radius:10px;padding:11px 11px 11px 16px;font-size:13.5px;box-shadow:0 8px 26px rgba(42,26,16,.4);display:flex;gap:12px;align-items:center;max-width:92vw}
.cal-toast span{flex:1;min-width:0}
.cal-toast button{flex:0 0 auto;border:1px solid rgba(245,237,224,.4);background:transparent;color:inherit;font-family:var(--font-sans);font-size:12.5px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;padding:6px 13px;border-radius:7px;cursor:pointer}
.cal-toast button:hover{background:rgba(245,237,224,.16)}

.cal-scrim{position:fixed;inset:0;background:rgba(42,26,16,.5);z-index:500;display:flex;align-items:flex-end;justify-content:center}
.cal-sheet{width:100%;max-width:440px;background:var(--cream);border:1px solid var(--sabbia-dark);border-radius:14px 14px 0 0;padding:18px;max-height:92vh;overflow-y:auto}
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

@media (max-width:700px){
  .cal-cell{min-height:56px}
  .cal-month{font-size:18px;min-width:130px}
  .cal-anchnote{display:none}
  .cal-sheet{max-width:none}
}
@media print{
  .cal-top,.cal-toast,.footer-bar,.cal-scrim{display:none !important}
  .cal-cell{min-height:118px;break-inside:avoid}
  .cal-chip{font-size:10px}
  .cal-grid{gap:2px}
}
</style>`;
