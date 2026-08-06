// ══════════════════════════════════════════════════════════════════════════
// MY TASKS MODULE — Francesco's personal task list (private view)
//
//   • my_tasks = one row per task, owned by a single user key
//   • Tabs: Today / Tomorrow / All / Done
//   • Priority shows as a coloured left bar (p1 pomodoro, p2 oro, p3 oliva)
//   • PIN-gated: this is a personal list, not a shared kitchen tool
//
// Written to be updated by Claude (via Supabase) as well as by hand here.
// Same visual language as the rest of the app — sabbia/vino, serif titles.
// ══════════════════════════════════════════════════════════════════════════

const MT_KEY   = 'my_tasks';
const MT_PIN   = '3105';           // personal view passcode
const MT_OWNER = 'francesco';      // owner key on every row
const MT_UNLOCK_MS = 12 * 60 * 60 * 1000;   // stay unlocked half a day

let mtRows      = [];
let mtTab       = 'today';
let mtChannel   = null;
let mtUnlocked  = false;

function mtEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── dates ──────────────────────────────────────────────────────────────────
function mtToday(){ return (typeof TODAY!=='undefined' && TODAY) ? TODAY : new Date().toISOString().slice(0,10); }
function mtShift(iso, days){
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0,10);
}
function mtDayLabel(iso){
  if(!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' });
}
function mtTimeLabel(r){
  if(!r.due_time) return '—';
  return r.due_time.slice(0,5);
}

// ── data ───────────────────────────────────────────────────────────────────
async function mtLoad(){
  const res = await sb.from('my_tasks')
    .select('*')
    .eq('owner', MT_OWNER)
    .order('due_date', { ascending:true, nullsFirst:false })
    .order('due_time', { ascending:true, nullsFirst:true });
  mtRows = res.data || [];
}

function mtSubscribe(){
  if(mtChannel) return;
  mtChannel = sb.channel('my-tasks-rt')
    .on('postgres_changes', { event:'*', schema:'public', table:'my_tasks' }, async () => {
      await mtLoad();
      if(document.getElementById('mytasks-view').style.display === 'block') mtRender();
    })
    .subscribe();
}

async function mtToggleDone(id){
  const row = mtRows.find(r => r.id === id);
  if(!row) return;
  const next = !row.done;
  row.done = next;                       // optimistic
  mtRender();
  await sb.from('my_tasks').update({
    done: next,
    done_at: next ? new Date().toISOString() : null
  }).eq('id', id);
  await mtLoad(); mtRender();
}

// -- editor sheet (replaces browser prompts) --------------------------------
let mtEditing = null;   // task id, or null for a new task

function mtOpenSheet(id){
  mtEditing = id || null;
  const r = id ? mtRows.find(x => x.id === id) : null;
  const t = mtToday();
  const cur = r ? (r.due_date || '') : t;
  const quick = [['Today', t], ['Tomorrow', mtShift(t,1)], ['No date', '']];

  document.getElementById('mt-sheet').innerHTML =
  '<div class="mt-sheet-box" onclick="event.stopPropagation()">' +
    '<div class="mt-sheet-h">' + (r ? 'Edit task' : 'New task') + '</div>' +

    '<label class="mt-lab">Task</label>' +
    '<input class="mt-in" id="mt-f-title" value="' + mtEsc(r ? r.title : '') + '" placeholder="What needs doing" autocomplete="off">' +

    '<label class="mt-lab">Note</label>' +
    '<textarea class="mt-in mt-ta" id="mt-f-note" rows="2" placeholder="Context, prep, who is involved">' + mtEsc(r && r.note ? r.note : '') + '</textarea>' +

    '<label class="mt-lab">When</label>' +
    '<div class="mt-quick" id="mt-q-date">' +
      quick.map(function(q){
        return '<button class="mt-q' + (cur === q[1] ? ' on' : '') + '" data-d="' + q[1] + '" onclick="mtSetDate(this)">' + q[0] + '</button>';
      }).join('') +
    '</div>' +
    '<div class="mt-when-row">' +
      '<input class="mt-in" type="date" id="mt-f-date" value="' + cur + '" onchange="mtSyncQuick()">' +
      '<input class="mt-in" type="time" id="mt-f-time" value="' + (r && r.due_time ? r.due_time.slice(0,5) : '') + '">' +
    '</div>' +

    '<label class="mt-lab">Priority</label>' +
    '<div class="mt-quick">' +
      [[1,'Urgent'],[2,'High'],[3,'Normal']].map(function(x){
        return '<button class="mt-q pr' + x[0] + ((r ? r.priority : 3) === x[0] ? ' on' : '') + '" data-p="' + x[0] + '" onclick="mtSetPri(' + x[0] + ')">' + x[1] + '</button>';
      }).join('') +
    '</div>' +
    '<input type="hidden" id="mt-f-pri" value="' + (r ? r.priority : 3) + '">' +

    '<div class="mt-sheet-foot">' +
      (r ? '<button class="mt-btn del" onclick="mtDelete(\'' + r.id + '\')">Delete</button>' : '<span></span>') +
      '<div class="mt-sheet-actions">' +
        '<button class="mt-btn ghost" onclick="mtCloseSheet()">Cancel</button>' +
        '<button class="mt-btn" onclick="mtSaveSheet()">Save</button>' +
      '</div>' +
    '</div>' +
  '</div>';

  document.getElementById('mt-sheet').classList.add('open');
  setTimeout(function(){ const el = document.getElementById('mt-f-title'); if(el) el.focus(); }, 30);
}

function mtCloseSheet(){
  const s = document.getElementById('mt-sheet');
  if(!s) return;
  s.classList.remove('open'); s.innerHTML = ''; mtEditing = null;
}

function mtSetDate(btn){
  document.getElementById('mt-f-date').value = btn.dataset.d;
  mtSyncQuick();
}

function mtSyncQuick(){
  const v = document.getElementById('mt-f-date').value || '';
  const box = document.getElementById('mt-q-date');
  if(!box) return;
  Array.prototype.forEach.call(box.querySelectorAll('.mt-q'), function(b){
    b.classList.toggle('on', b.dataset.d === v);
  });
}

function mtSetPri(v){
  document.getElementById('mt-f-pri').value = v;
  Array.prototype.forEach.call(document.querySelectorAll('#mt-sheet .mt-q[data-p]'), function(b){
    b.classList.toggle('on', Number(b.dataset.p) === v);
  });
}

async function mtSaveSheet(){
  const titleEl = document.getElementById('mt-f-title');
  const title = titleEl.value.trim();
  if(!title){ titleEl.classList.add('bad'); titleEl.focus(); return; }
  const payload = {
    title: title,
    note:     document.getElementById('mt-f-note').value.trim() || null,
    due_date: document.getElementById('mt-f-date').value || null,
    due_time: document.getElementById('mt-f-time').value || null,
    priority: Number(document.getElementById('mt-f-pri').value) || 3
  };
  if(mtEditing){
    await sb.from('my_tasks').update(payload).eq('id', mtEditing);
  } else {
    payload.owner = MT_OWNER; payload.done = false;
    await sb.from('my_tasks').insert(payload);
  }
  mtCloseSheet();
  await mtLoad(); mtRender();
}

async function mtDelete(id){
  const btn = document.querySelector('.mt-sheet-foot .mt-btn.del');
  if(btn && !btn.dataset.armed){
    btn.dataset.armed = '1';
    btn.textContent = 'Delete — sure?';
    setTimeout(function(){ if(btn){ btn.dataset.armed = ''; btn.textContent = 'Delete'; } }, 4000);
    return;
  }
  await sb.from('my_tasks').delete().eq('id', id);
  mtCloseSheet();
  await mtLoad(); mtRender();
}

function mtAdd(){ mtOpenSheet(null); }

// ── filtering ──────────────────────────────────────────────────────────────
function mtVisible(){
  const t = mtToday(), tm = mtShift(t, 1);
  if(mtTab === 'done')     return mtRows.filter(r => r.done);
  const open = mtRows.filter(r => !r.done);
  if(mtTab === 'today')    return open.filter(r => r.due_date && r.due_date <= t);
  if(mtTab === 'tomorrow') return open.filter(r => r.due_date === tm);
  return open;
}

function mtGroups(){
  const t = mtToday(), tm = mtShift(t, 1);
  const list = mtVisible();
  if(mtTab === 'today')    return [{ label:'Today',    sub:mtDayLabel(t),  items:list }];
  if(mtTab === 'tomorrow') return [{ label:'Tomorrow', sub:mtDayLabel(tm), items:list }];
  if(mtTab === 'done')     return [{ label:'Done',     sub:'',             items:list }];

  const overdue = list.filter(r => r.due_date && r.due_date <  t);
  const today   = list.filter(r => r.due_date === t);
  const tomo    = list.filter(r => r.due_date === tm);
  const later   = list.filter(r => r.due_date && r.due_date >  tm);
  const undated = list.filter(r => !r.due_date);
  return [
    { label:'Overdue',  sub:'',              items:overdue, hot:true },
    { label:'Today',    sub:mtDayLabel(t),   items:today },
    { label:'Tomorrow', sub:mtDayLabel(tm),  items:tomo },
    { label:'Later',    sub:'',              items:later },
    { label:'No date',  sub:'',              items:undated }
  ].filter(g => g.items.length);
}

// ── render ─────────────────────────────────────────────────────────────────
function mtRow(r){
  const p = 'p' + (r.priority || 3);
  const tags = [];
  if(r.kind)  tags.push(`<span class="mt-chip">${mtEsc(r.kind)}</span>`);
  if(r.tag)   tags.push(`<span class="mt-chip ghost">${mtEsc(r.tag)}</span>`);
  return `
  <div class="mt-row ${p}${r.done ? ' done' : ''}">
    <button class="mt-tick" onclick="mtToggleDone('${r.id}')">${r.done ? '&#10003;' : ''}</button>
    <div class="mt-mid" onclick="mtOpenSheet('${r.id}')">
      <div class="mt-name">${mtEsc(r.title)}</div>
      ${r.note ? `<div class="mt-note">${mtEsc(r.note)}</div>` : ''}
      ${tags.length ? `<div class="mt-tags">${tags.join('')}</div>` : ''}
    </div>
    <div class="mt-when">${mtTimeLabel(r)}<small>${r.due_date ? mtDayLabel(r.due_date).split(' ').slice(1).join(' ') : 'no date'}</small></div>
  </div>`;
}

function mtRender(){
  const host = document.getElementById('mytasks-view');
  const t = mtToday();
  const open   = mtRows.filter(r => !r.done);
  const urgent = open.filter(r => r.priority === 1).length;
  const week   = open.filter(r => r.due_date && r.due_date >= t && r.due_date <= mtShift(t, 6)).length;

  const tabs = [['today','Today'],['tomorrow','Tomorrow'],['all','All'],['done','Done']]
    .map(([k,l]) => `<button class="mt-tab${mtTab===k?' on':''}" onclick="mtSetTab('${k}')">${l}</button>`).join('');

  const body = mtGroups().map(g => `
    <div class="mt-band">
      <span class="mt-band-t${g.hot?' hot':''}">${g.label}</span>
      <span class="mt-band-line"></span>
      <span class="mt-band-c">${g.sub}${g.sub && g.items.length ? ' · ' : ''}${g.items.length ? g.items.length + ' items' : ''}</span>
    </div>
    ${g.items.map(mtRow).join('')}
  `).join('') || `<div class="mt-empty">Nothing here.</div>`;

  host.innerHTML = `${MT_STYLE}
    <div class="mt-tabs">${tabs}</div>
    <div class="mt-counters">
      <div class="mt-sc hot"><div class="mt-sc-n">${urgent}</div><div class="mt-sc-l">Urgent</div></div>
      <div class="mt-sc"><div class="mt-sc-n">${open.length}</div><div class="mt-sc-l">Open</div></div>
      <div class="mt-sc"><div class="mt-sc-n">${week}</div><div class="mt-sc-l">This week</div></div>
    </div>
    ${body}
    <button class="mt-add" onclick="mtAdd()">+ Add task</button>
    <div class="mt-foot">Updated automatically each morning · 07:00</div>
    <div class="mt-sheet" id="mt-sheet" onclick="mtCloseSheet()"></div>`;
}

function mtSetTab(k){ mtTab = k; mtRender(); }

// ── entry point ────────────────────────────────────────────────────────────
function mtIsUnlocked(){
  if(mtUnlocked) return true;
  try{
    const until = parseInt(localStorage.getItem('mt_unlock_until') || '0', 10);
    if(until && Date.now() < until){ mtUnlocked = true; return true; }
  }catch(e){}
  return false;
}

function mtRenderLock(msg){
  const host = document.getElementById('mytasks-view');
  host.innerHTML = MT_STYLE +
  '<div class="mt-lock">' +
    '<div class="mt-lock-box">' +
      '<div class="mt-lock-t">My Tasks</div>' +
      '<div class="mt-lock-s">Private view</div>' +
      '<input class="mt-in mt-lock-in" id="mt-pin" type="password" inputmode="numeric" ' +
        'autocomplete="off" placeholder="Passcode" onkeydown="if(event.key===\'Enter\')mtTryUnlock()">' +
      (msg ? '<div class="mt-lock-err">' + msg + '</div>' : '') +
      '<button class="mt-btn mt-lock-btn" onclick="mtTryUnlock()">Enter</button>' +
    '</div>' +
  '</div>';
  setTimeout(function(){ const el = document.getElementById('mt-pin'); if(el) el.focus(); }, 30);
}

async function mtTryUnlock(){
  const el = document.getElementById('mt-pin');
  if(!el) return;
  if(el.value === MT_PIN){
    mtUnlocked = true;
    try{ localStorage.setItem('mt_unlock_until', String(Date.now() + MT_UNLOCK_MS)); }catch(e){}
    await mtBoot();
  } else {
    mtRenderLock('Incorrect passcode.');
  }
}

async function mtBoot(){
  const host = document.getElementById('mytasks-view');
  host.innerHTML = MT_STYLE + '<div class="ops-title">My Tasks</div><div class="ops-subtitle">Loading…</div>';
  await mtLoad();
  mtSubscribe();
  mtRender();
}

async function openMyTasks(){
  activeStation = MT_KEY;
  hideAllPages();
  const host = document.getElementById('mytasks-view');
  host.style.display = 'block';
  document.querySelector('.footer-bar').style.display = 'flex';
  document.getElementById('foot-label').textContent = 'My Tasks';
  if(!mtIsUnlocked()){ mtRenderLock(''); return; }
  await mtBoot();
}

// ══ styles ═══════════════════════════════════════════════════════════════════
const MT_STYLE = `<style id="mt-style">
.mt-tabs{display:flex;gap:6px;margin:2px 0 16px;overflow-x:auto}
.mt-tab{background:none;border:none;border-bottom:3px solid transparent;color:var(--vino-light);font-family:var(--font-sans);font-size:12px;font-weight:600;letter-spacing:.6px;padding:8px 12px;cursor:pointer;white-space:nowrap;text-transform:uppercase}
.mt-tab.on{color:var(--vino);border-bottom-color:var(--vino)}

.mt-counters{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:20px}
.mt-sc{border-radius:4px;padding:12px 8px;display:flex;flex-direction:column;align-items:center;gap:3px;background:var(--sabbia-light);border:1px solid var(--sabbia-dark)}
.mt-sc-n{font-family:var(--font-serif);font-size:28px;line-height:1;color:var(--vino)}
.mt-sc-l{font-size:9px;letter-spacing:1.4px;text-transform:uppercase;color:var(--vino-light);font-weight:600}
.mt-sc.hot .mt-sc-n{color:var(--pomodoro)}

.mt-band{display:flex;align-items:center;gap:10px;margin:26px 0 10px}
.mt-band-t{font-size:12px;letter-spacing:2px;text-transform:uppercase;color:var(--vino-light);font-weight:600}
.mt-band-t.hot{color:var(--pomodoro)}
.mt-band-line{flex:1;height:1px;background:var(--sabbia-dark)}
.mt-band-c{font-size:11px;color:var(--vino-light)}

.mt-row{background:var(--cream);border:1px solid var(--sabbia-dark);border-left:6px solid var(--sabbia-dark);border-radius:0 10px 10px 0;padding:13px 15px;margin-bottom:9px;display:flex;gap:13px;align-items:flex-start}
.mt-row.p1{border-left-color:var(--pomodoro)}
.mt-row.p2{border-left-color:var(--oro)}
.mt-row.p3{border-left-color:var(--oliva)}
.mt-row.done{opacity:.45}
.mt-row.done .mt-name{text-decoration:line-through}

.mt-tick{width:22px;height:22px;border:1.5px solid var(--sabbia-dark);border-radius:4px;background:transparent;flex:0 0 auto;margin-top:2px;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--oliva);font-size:14px;font-weight:700;line-height:1}
.mt-row.done .mt-tick{background:var(--oliva);border-color:var(--oliva);color:#fff}

.mt-mid{flex:1;min-width:0;cursor:pointer}
.mt-name{font-family:var(--font-serif);font-size:20px;color:var(--vino);line-height:1.15}
.mt-note{font-size:12px;color:var(--vino-light);margin-top:4px;line-height:1.45}
.mt-tags{margin-top:7px;display:flex;gap:6px;flex-wrap:wrap}
.mt-chip{display:inline-block;background:var(--vino);color:var(--cream);font-size:9px;letter-spacing:1.4px;text-transform:uppercase;padding:3px 9px;border-radius:20px}
.mt-chip.ghost{background:transparent;color:var(--vino-light);border:1px solid var(--sabbia-dark)}

.mt-when{font-family:var(--font-serif);font-size:19px;color:var(--vino);flex:0 0 62px;text-align:right;line-height:1.1}
.mt-when small{display:block;font-family:var(--font-sans);font-size:9px;letter-spacing:1.2px;text-transform:uppercase;color:var(--vino-light);margin-top:2px}

.mt-empty{background:var(--sabbia-light);border:1px dashed var(--sabbia-dark);border-radius:6px;padding:18px;text-align:center;color:var(--vino-light);font-size:13px}
.mt-add{margin-top:20px;width:100%;background:var(--vino);color:var(--cream);border:none;border-radius:6px;padding:14px;font-family:var(--font-sans);font-size:13px;font-weight:600;letter-spacing:1px;text-transform:uppercase;cursor:pointer}
.mt-foot{text-align:center;font-size:11px;color:var(--vino-light);margin-top:16px;letter-spacing:.5px}
/* -- editor sheet -- */
.mt-sheet{position:fixed;inset:0;background:rgba(42,26,16,.42);backdrop-filter:blur(2px);display:none;align-items:flex-end;justify-content:center;z-index:400}
.mt-sheet.open{display:flex}
@media(min-width:640px){.mt-sheet.open{align-items:center}}
.mt-sheet-box{background:var(--sabbia-light);border:1px solid var(--sabbia-dark);border-top:4px solid var(--vino);border-radius:14px 14px 0 0;width:100%;max-width:480px;padding:20px 20px 18px;max-height:92vh;overflow:auto;box-shadow:0 -8px 34px rgba(65,2,7,.22)}
@media(min-width:640px){.mt-sheet-box{border-radius:12px;box-shadow:0 10px 40px rgba(65,2,7,.28)}}
.mt-sheet-h{font-family:var(--font-serif);font-size:25px;color:var(--vino);line-height:1;margin-bottom:16px}
.mt-lab{display:block;font-size:9.5px;letter-spacing:1.6px;text-transform:uppercase;color:var(--vino-light);font-weight:600;margin:14px 0 5px}
.mt-lab:first-of-type{margin-top:0}
.mt-in{width:100%;background:var(--cream);border:1px solid var(--sabbia-dark);border-radius:6px;padding:11px 12px;font-family:var(--font-sans);font-size:15px;color:var(--ink);outline:none}
.mt-in:focus{border-color:var(--vino)}
.mt-in.bad{border-color:var(--pomodoro)}
.mt-ta{resize:vertical;line-height:1.45;font-size:14px}
.mt-when-row{display:grid;grid-template-columns:1.4fr 1fr;gap:8px;margin-top:8px}
.mt-quick{display:flex;gap:7px;flex-wrap:wrap}
.mt-q{background:var(--cream);border:1px solid var(--sabbia-dark);border-radius:20px;padding:7px 14px;font-family:var(--font-sans);font-size:12px;color:var(--vino);cursor:pointer;transition:all .12s}
.mt-q:hover{border-color:var(--vino)}
.mt-q.on{background:var(--vino);border-color:var(--vino);color:var(--cream)}
.mt-q.pr1.on{background:var(--pomodoro);border-color:var(--pomodoro);color:#fff}
.mt-q.pr2.on{background:var(--oro);border-color:var(--oro);color:#fff}
.mt-q.pr3.on{background:var(--oliva);border-color:var(--oliva);color:#fff}
.mt-sheet-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:22px;padding-top:16px;border-top:1px solid var(--sabbia-dark)}
.mt-sheet-actions{display:flex;gap:8px}
.mt-btn{background:var(--vino);color:var(--cream);border:1px solid var(--vino);border-radius:6px;padding:10px 20px;font-family:var(--font-sans);font-size:12px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;cursor:pointer}
.mt-btn.ghost{background:transparent;color:var(--vino-light);border-color:var(--sabbia-dark)}
.mt-btn.del{background:transparent;color:#a3251f;border-color:#d9b3ae;padding:10px 14px}
/* -- lock screen -- */
.mt-lock{display:flex;align-items:center;justify-content:center;padding:48px 0 60px}
.mt-lock-box{background:var(--cream);border:1px solid var(--sabbia-dark);border-top:4px solid var(--vino);border-radius:12px;padding:30px 26px 26px;width:100%;max-width:330px;text-align:center}
.mt-lock-t{font-family:var(--font-serif);font-size:30px;color:var(--vino);line-height:1}
.mt-lock-s{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--vino-light);margin-top:5px}
.mt-lock-in{margin-top:22px;text-align:center;letter-spacing:7px;font-size:20px;padding:13px 12px}
.mt-lock-err{color:var(--pomodoro);font-size:11.5px;margin-top:9px;letter-spacing:.4px}
.mt-lock-btn{margin-top:16px;width:100%;padding:13px}


</style>`;
