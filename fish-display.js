// ══════════════════════════════════════════════════════════════════════════
// FISH DISPLAY MODULE — "Fish of the Day" raw-bar sheet
// A living daily template the raw-bar team edits and prints on A3.
//   • fish_display_items  = standing list (fish + caviar); grows when someone
//                           types a new item (saved for next time)
//   • fish_display_sheet  = one JSONB doc per business date, shared live
// Same model as Market List (master list + shared per-period values), same
// realtime + DEV-write-guard behaviour. Reads the tables — never a hardcoded
// mirror — so the standing list can change with zero redeploy.
// ══════════════════════════════════════════════════════════════════════════

const FISH_KEY = 'fish_display';

let fdItems = [];      // [{id,name,kind,sort_order,active}]
let fdDoc   = null;    // { entries:{item_id:{qty,kg,price|gr}}, oyster, low85:[], out86:[], push:[], blank_rows }
let fdChannel = null;
let fdCtx = null;      // active editor context
let fdBizDate = null;  // 'YYYY-MM-DD' — the sheet's business date (= TODAY)
let fdPendingRender = false;  // a remote change arrived while a cell was focused; apply on blur
function fdGridFocused(){ const a=document.activeElement; return !!(a && a.classList && a.classList.contains('fd-in')); }

// -- why this tab has a name, and why it remembers what it typed ---------------
// The whole sheet is ONE json document and every keystroke saves all of it.
// Supabase sends that write straight back to the tab that made it, and until
// 21 Aug 2026 the echo handler replaced fdDoc with it unconditionally - with a
// snapshot that was already half a second stale. Anything typed in the meantime
// was dropped from memory, and the NEXT keystroke's save then wrote the
// shortened document back over the database, so the quantity was gone for good.
// The screen kept showing it (the redraw is deferred while a cell has focus),
// which is why it only seemed to change when the cook left the cell to print.
// Measured on the deployed build: a 515ms echo against a 150ms debounce, so any
// cell filled in under half a second was at risk. Antonio reported it as the
// quantity "changing automatically when I try to print".
//   FD_TAB  - lets this tab recognise its own echo and ignore it.
//   fdDirty - every cell typed here since this tab's last CONFIRMED save, so
//             another device's whole-document write cannot silently undo it.
const FD_TAB = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const FD_CLAIM_MS = 10000;     // how long a just-typed cell is defended (echoes take <1s)
const FD_CLAIM_PUSHES = 2;     // and how many times we re-assert it, so two people
                               // fighting over ONE cell settles instead of ping-ponging
const fdDirty = new Map();     // 'e|item|field' . 'l|list|row' . 'o' . 'b'  ->  {v,at,pushes}

function fdReadKey(doc, k){
  const p = k.split('|');
  if(p[0]==='e'){ const e = doc.entries[p[1]]; return (e && e[p[2]]!=null) ? e[p[2]] : ''; }
  if(p[0]==='l'){ const a = doc[p[1]]; return (Array.isArray(a) && a[+p[2]]!=null) ? a[+p[2]] : ''; }
  if(p[0]==='o') return doc.oyster || '';
  if(p[0]==='b') return String(doc.blank_rows==null ? 3 : doc.blank_rows);
  return '';
}
function fdWriteKey(doc, k, v){
  const p = k.split('|');
  if(p[0]==='e'){
    if(v===''){ if(doc.entries[p[1]]){ delete doc.entries[p[1]][p[2]];
                  if(!Object.keys(doc.entries[p[1]]).length) delete doc.entries[p[1]]; } }
    else { if(!doc.entries[p[1]]) doc.entries[p[1]] = {}; doc.entries[p[1]][p[2]] = v; }
    return;
  }
  if(p[0]==='l'){ if(!Array.isArray(doc[p[1]])) doc[p[1]]=[];
                  while(doc[p[1]].length <= +p[2]) doc[p[1]].push('');
                  doc[p[1]][+p[2]] = v; return; }
  if(p[0]==='o'){ doc.oyster = v; return; }
  if(p[0]==='b'){ doc.blank_rows = +v || 0; return; }
}
function fdMark(k, v){ fdDirty.set(k, { v: v==null ? '' : String(v), at: Date.now(), pushes: 0 }); }
function fdPruneClaims(){
  const now = Date.now();
  fdDirty.forEach((c,k)=>{ if(now - c.at > FD_CLAIM_MS) fdDirty.delete(k); });
}

function fdEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fdBlankDoc(){ return { entries:{}, oyster:'', low85:['',''], out86:['',''], push:['',''], blank_rows:3 }; }
function fdNormalise(d){
  d = d || {};
  return {
    entries: (d.entries && typeof d.entries==='object') ? d.entries : {},
    oyster: d.oyster || '',
    low85: Array.isArray(d.low85) ? d.low85 : ['',''],
    out86: Array.isArray(d.out86) ? d.out86 : ['',''],
    push:  Array.isArray(d.push)  ? d.push  : ['',''],
    blank_rows: (typeof d.blank_rows==='number') ? d.blank_rows : 3
  };
}

// ── data load ──────────────────────────────────────────────────────────────
async function loadFishDisplay(){
  fdBizDate = TODAY;
  fdDirty.clear();                 // whatever we were defending, we are about to replace
  const it = await sb.from('fish_display_items').select('*').eq('active', true).order('kind').order('sort_order');
  fdItems = (it.data || []);
  const sh = await sb.from('fish_display_sheet').select('doc').eq('biz_date', fdBizDate).maybeSingle();
  if(sh && sh.data){
    fdDoc = fdNormalise(sh.data.doc);
  } else {
    // No sheet for today yet — carry the most recent previous day's sheet forward so the
    // Fish of the Day list stays exactly as the team left it (they adjust/clear what changed),
    // instead of resetting to blank every morning. Yesterday's row is left untouched; the
    // moment anyone edits today, an upsert creates today's own row (biz_date=TODAY).
    const prev = await sb.from('fish_display_sheet').select('doc')
      .lt('biz_date', fdBizDate).order('biz_date',{ ascending:false }).limit(1).maybeSingle();
    fdDoc = fdNormalise(prev && prev.data ? prev.data.doc : null);
  }
}
function fdFish(){ return fdItems.filter(i=>i.kind==='fish'); }
function fdCav(){ return fdItems.filter(i=>i.kind==='caviar'); }

// ── realtime ─────────────────────────────────────────────────────────────────
function subscribeFishDisplay(){
  if(fdChannel){ sb.removeChannel(fdChannel); fdChannel = null; }
  fdChannel = sb.channel('fish_display_changes')
    .on('postgres_changes', { event:'*', schema:'public', table:'fish_display_sheet', filter:`biz_date=eq.${fdBizDate}` },
      payload => {
        const r = payload.new; if(!r) return;
        fdFlashSync();
        // Our OWN write coming back. It can only be older than what we hold, never
        // newer, so there is nothing to learn from it - and applying it is exactly
        // what used to erase the cell typed while it was still in flight.
        if(r.doc && r.doc._tab === FD_TAB) return;

        // Someone else's write. It carries the WHOLE sheet, including their stale
        // copy of the cells we have just typed, so put ours back before adopting it.
        const remote = fdNormalise(r.doc);
        const now = Date.now();
        let ours = false;
        fdDirty.forEach((c,k)=>{
          // A claim is NOT released just because our own save succeeded: another
          // device's save can already be in flight, built on the sheet as it was
          // BEFORE ours landed, and it will overwrite us when it arrives. Hold the
          // cell until a document written by someone else comes back carrying it.
          if(now - c.at > FD_CLAIM_MS || c.pushes >= FD_CLAIM_PUSHES){ fdDirty.delete(k); return; }
          if(fdReadKey(remote,k) === c.v){ fdDirty.delete(k); return; }   // shared sheet agrees
          fdWriteKey(remote, k, c.v); c.pushes++; ours = true;
        });
        fdDoc = remote;
        // NEVER re-render while a cell is focused - that would destroy the input
        // the user is typing in. Defer instead.
        if(activeStation === FISH_KEY){ if(fdGridFocused()) fdPendingRender = true; else renderFishDisplay(); }
        // Their document did not carry our cells. Write ours back, so the database
        // ends up agreeing with the screen instead of the screen holding it alone.
        if(ours) fdSaveSoon();
      })
    .on('postgres_changes', { event:'*', schema:'public', table:'fish_display_items' },
      () => { if(activeStation === FISH_KEY){ loadFishDisplay().then(()=>{ if(activeStation!==FISH_KEY) return; if(fdGridFocused()) fdPendingRender=true; else renderFishDisplay(); }); } })
    .subscribe(status=>{
      const dot=document.getElementById('realtime-dot');
      if(dot) dot.classList.toggle('live', status==='SUBSCRIBED');
    });
}
function fdFlashSync(){ const dot=document.getElementById('realtime-dot'); if(!dot) return; dot.classList.add('flash'); setTimeout(()=>dot.classList.remove('flash'),400); }

// ── save the whole day's doc (shared live) ───────────────────────────────────
let fdSaveTimer = null;
async function fdSave(){
  const snapshot = JSON.parse(JSON.stringify(fdDoc));
  snapshot._tab = FD_TAB;            // so this tab knows its own echo; fdNormalise drops it on read
  fdPruneClaims();
  const row = { biz_date: fdBizDate, doc: snapshot, updated_by:(window.CURRENT_USER||null), updated_at:new Date().toISOString() };
  const res = await sb.from('fish_display_sheet').upsert(row, { onConflict:'biz_date' });
  if(res && res.error){
    console.warn('fish_display_sheet save failed', res.error);
    // pull the server's truth back so the screen never shows what the DB doesn't have
    const sh = await sb.from('fish_display_sheet').select('doc').eq('biz_date', fdBizDate).maybeSingle();
    fdDoc = fdNormalise(sh && sh.data ? sh.data.doc : null);
    fdDirty.clear();                 // we are deliberately discarding local state
    renderFishDisplay();
    if(String(res.error.message||'').indexOf('read-only')===-1) alert('Could not save — check connection.');
    else alert('DEV site is read-only — tap the DEV badge (bottom-left) to enable test writes.');
  }
}
function fdSaveSoon(){ if(fdSaveTimer) clearTimeout(fdSaveTimer); fdSaveTimer = setTimeout(fdSave, 150); }

// ── add a new item to the standing list (typed, "saved for next time") ───────
async function fdAddMaster(name, kind){
  const pool = fdItems.filter(i=>i.kind===kind);
  const maxSort = pool.length ? Math.max(...pool.map(i=>i.sort_order||0)) : 0;
  const { data, error } = await sb.from('fish_display_items')
    .insert({ name, kind, sort_order:maxSort+10, active:true }).select().single();
  if(error){ alert('Could not add item: '+error.message); return null; }
  fdItems.push(data);
  return data;
}
// ── drag-to-reorder (touch + mouse) ──────────────────────────────────────────
// Grab a row's grip and drop it anywhere in its list — no more one-step arrows.
// Works with finger or mouse via Pointer Events. On drop it renumbers the
// standing pool (sort_order *10 so duplicates self-heal) and writes only the
// rows that changed. Fish and caviar live in separate columns, so a drag can
// never cross between the two kinds.
//
// HOW IT MOVES (rewritten 13 Aug 2026 — Antonio, "not very smooth" on a laptop).
// The first version left the dragged row sitting in the layout and re-inserted
// it in the DOM as you crossed each mid-point: on a mouse the row never
// followed the cursor (measured: it lagged the pointer by 39px on a 40px row),
// so it read as a row that jumps a whole line late rather than one you are
// carrying. And nothing scrolled: on a 900px laptop with 18 fish, 471px of the
// list sat below the fold and holding the pointer at the bottom edge moved the
// page 0px — the bottom of the list was simply unreachable in one drag.
//
// Now: geometry is measured ONCE on grab (in document coordinates, so scrolling
// mid-drag cannot corrupt it); the dragged row is glued to the pointer with a
// transform; the rows it displaces slide out of the way with a short CSS
// transition; and the page auto-scrolls when the pointer nears either edge. The
// DOM is not touched until the drop, so there is no per-move layout thrash and
// no flicker when you hover a boundary.
let fdDrag = null;
const FD_EDGE = 72;        // px from a viewport edge where auto-scroll starts
const FD_EDGE_MAX = 20;    // px per frame at the very edge

function fdDragRows(container, dragEl){
  return Array.from(container.querySelectorAll('.fd-row[data-id]'))
    .filter(r=>r!==dragEl && !r.classList.contains('fd-writein'));
}
function fdGripDown(e, id, kind){
  if(e.button && e.button!==0) return;                 // primary button / touch only
  if(fdDrag) return;
  e.preventDefault(); e.stopPropagation();
  const host = document.getElementById('fish-view'); if(!host) return;
  const rowEl = host.querySelector('.fd-row[data-id="'+id+'"]'); if(!rowEl) return;
  const container = rowEl.parentNode;
  const others = fdDragRows(container, rowEl);
  const sy = window.scrollY;
  const box = rowEl.getBoundingClientRect();
  // document-coordinate geometry, measured once — immune to mid-drag scrolling
  const geo = others.map(r=>{ const b=r.getBoundingClientRect(); return { el:r, mid:b.top+sy+b.height/2 }; });
  // extents of the whole column. The carried row's centre is allowed to reach
  // the very top and the very bottom edge — clamping it to the first/last
  // mid-point instead would make the last slot unreachable (it needs a centre
  // strictly past the last row's mid-point).
  const tops = others.map(r=>r.getBoundingClientRect().top+sy).concat([box.top+sy]);
  const bots = others.map(r=>{const b=r.getBoundingClientRect(); return b.bottom+sy;}).concat([box.bottom+sy]);
  fdDrag = {
    id, kind, rowEl, container, others: geo,
    h: box.height,
    from: others.filter(r=>r.compareDocumentPosition(rowEl)&Node.DOCUMENT_POSITION_FOLLOWING).length,
    startDocY: e.clientY + sy,
    startMid: box.top + sy + box.height/2,
    minDocY: Math.min.apply(null, tops),              // clamp: never leave its own column
    maxDocY: Math.max.apply(null, bots),
    clientY: e.clientY, dy: 0, to: 0, raf: 0
  };
  fdDrag.to = fdDrag.from;
  rowEl.classList.add('fd-dragging');
  document.body.classList.add('fd-dragging-active');
  fdDrag.others.forEach(g=>g.el.classList.add('fd-shift'));
  try{ e.target.setPointerCapture(e.pointerId); fdDrag.grip = e.target; fdDrag.pid = e.pointerId; }catch(_){}
  document.addEventListener('pointermove', fdGripMove, { passive:false });
  document.addEventListener('pointerup', fdGripUp, true);
  document.addEventListener('pointercancel', fdGripUp, true);
  fdDrag.raf = requestAnimationFrame(fdDragFrame);
}
function fdGripMove(e){
  if(!fdDrag) return;
  if(e.cancelable) e.preventDefault();                 // stop the page scrolling under the finger
  fdDrag.clientY = e.clientY;
}
// One frame of the drag: auto-scroll near an edge, glue the row to the pointer,
// then slide the displaced rows. Runs off rAF so a fast mouse cannot outpace it.
function fdDragFrame(){
  if(!fdDrag) return;
  const d = fdDrag;
  const vh = window.innerHeight;
  let step = 0;                                        // ── edge auto-scroll ──
  if(d.clientY < FD_EDGE)            step = -Math.ceil(FD_EDGE_MAX * (FD_EDGE - d.clientY) / FD_EDGE);
  else if(d.clientY > vh - FD_EDGE)  step =  Math.ceil(FD_EDGE_MAX * (d.clientY - (vh - FD_EDGE)) / FD_EDGE);
  if(step) window.scrollBy(0, step);

  const docY = d.clientY + window.scrollY;
  let dy = docY - d.startDocY;                         // pointer travel, scroll included
  const mid = d.startMid + dy;                         // where the row now sits
  if(mid < d.minDocY) dy += d.minDocY - mid;           // clamp inside its own column
  if(mid > d.maxDocY) dy += d.maxDocY - mid;
  if(dy !== d.dy){ d.dy = dy; d.rowEl.style.transform = 'translateY(' + dy + 'px)'; }

  const c = d.startMid + d.dy;
  let to = 0; for(const g of d.others) if(g.mid < c) to++;   // slot the row would land in
  if(to !== d.to){
    d.to = to;
    d.others.forEach((g,i)=>{                          // open the gap at `to`
      const shift = (i >= to && i < d.from) ?  d.h
                  : (i >= d.from && i < to) ? -d.h : 0;
      g.el.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
    });
  }
  d.raf = requestAnimationFrame(fdDragFrame);
}
async function fdGripUp(){
  if(!fdDrag) return;
  const { container, rowEl, kind, others, from, to } = fdDrag;
  cancelAnimationFrame(fdDrag.raf);
  document.removeEventListener('pointermove', fdGripMove, { passive:false });
  document.removeEventListener('pointerup', fdGripUp, true);
  document.removeEventListener('pointercancel', fdGripUp, true);
  try{ if(fdDrag.grip) fdDrag.grip.releasePointerCapture(fdDrag.pid); }catch(_){}
  rowEl.style.transform = '';
  others.forEach(g=>{ g.el.style.transform=''; g.el.classList.remove('fd-shift'); });
  rowEl.classList.remove('fd-dragging');
  document.body.classList.remove('fd-dragging-active');
  fdDrag = null;
  // rebuild the order from the slot the row was dropped in — the DOM was never
  // reordered during the drag, so this is the only place order changes
  const pool = fdItems.filter(i=>i.kind===kind);
  const domIds = Array.from(container.querySelectorAll('.fd-row[data-id]'))
    .filter(r=>!r.classList.contains('fd-writein')).map(r=>r.getAttribute('data-id'));
  if(domIds.length!==pool.length || String(pool[from]&&pool[from].id)!==String(rowEl.getAttribute('data-id'))){
    await loadFishDisplay(); renderFishDisplay(); return;   // list moved under us — reload rather than guess
  }
  const reordered = pool.slice();
  reordered.splice(to, 0, reordered.splice(from, 1)[0]);
  const changed = [];
  reordered.forEach((p,k)=>{ const want=(k+1)*10; if(p.sort_order!==want){ p.sort_order=want; changed.push(p); } });
  fdItems.sort((a,b)=> a.kind===b.kind ? (a.sort_order||0)-(b.sort_order||0) : (a.kind<b.kind?-1:1));
  renderFishDisplay();
  if(!changed.length) return;                          // dropped back where it started
  const res = await Promise.all(changed.map(p=>sb.from('fish_display_items').update({sort_order:p.sort_order}).eq('id',p.id)));
  if(res.some(r=>r&&r.error)){ await loadFishDisplay(); renderFishDisplay(); }
}
// soft-delete a standing item (removes the row from the template going forward)
async function fdDelItem(id){
  fdItems = fdItems.filter(i=>i.id!==id);
  delete fdDoc.entries[id];
  Array.from(fdDirty.keys()).forEach(k=>{ if(k.indexOf('e|'+id+'|')===0) fdDirty.delete(k); });
  renderFishDisplay();
  const res = await sb.from('fish_display_items').update({ active:false }).eq('id', id);
  if(res && res.error){ await loadFishDisplay(); renderFishDisplay(); }
  fdSaveSoon();
}

// ── render (inline, Excel-style editable grid) ───────────────────────────────
// Every cell is a real <input>: type straight in, Enter drops to the cell below,
// Tab moves across, paste a column fills down, and it auto-saves (no Save button).
function fdNumIn(grid, r, c, id, field, val, dis){
  return `<input class="fd-in fd-num" type="text" inputmode="decimal" data-grid="${grid}" data-r="${r}" data-c="${c}"`
    + (id?` data-id="${id}"`:'') + ` data-f="${field}"${dis?' disabled':''} value="${fdEsc(val||'')}">`;
}
function renderFishDisplay(){
  const host = document.getElementById('fish-view');
  if(!host) return;
  const fish = fdFish(), cav = fdCav();
  const dateLabel = new Date(fdBizDate+'T12:00:00').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric'});
  const dl = (id,list)=>`<datalist id="${id}">${list.map(n=>`<option value="${fdEsc(n)}">`).join('')}</datalist>`;

  const fishRows = fish.map((it,r)=>{
    const e = fdDoc.entries[it.id] || {};
    return `<div class="fd-row" data-id="${it.id}">
      <div class="fd-namecell"><input class="fd-in fd-namein" list="fd-dl-fish" data-grid="fish" data-r="${r}" data-c="0" data-id="${it.id}" data-f="name" value="${fdEsc(it.name)}"><span class="fd-grip" title="Drag to reorder" onpointerdown="fdGripDown(event,'${it.id}','fish')">⠿</span><span class="fd-del" title="Remove from list" onclick="fdDelItem('${it.id}')">×</span></div>
      ${fdNumIn('fish',r,1,it.id,'qty',e.qty)}${fdNumIn('fish',r,2,it.id,'kg',e.kg)}${fdNumIn('fish',r,3,it.id,'price',e.price)}
    </div>`;
  }).join('');

  let blanks='';
  const base = fish.length;
  for(let b=0;b<(fdDoc.blank_rows||0);b++){ const r=base+b;
    blanks += `<div class="fd-row fd-writein">
      <div class="fd-namecell"><input class="fd-in fd-namein" list="fd-dl-fish" placeholder="＋ new fish…" data-grid="fish" data-r="${r}" data-c="0" data-f="newfish" value=""><span class="fd-del" title="Remove line" onclick="fdRemoveBlank()">×</span></div>
      ${fdNumIn('fish',r,1,'','qty','',true)}${fdNumIn('fish',r,2,'','kg','',true)}${fdNumIn('fish',r,3,'','price','',true)}
    </div>`;
  }

  const cavRows = cav.map((it,r)=>{
    const e = fdDoc.entries[it.id] || {};
    return `<div class="fd-row fd-cav" data-id="${it.id}">
      <div class="fd-namecell"><input class="fd-in fd-namein" list="fd-dl-cav" data-grid="cav" data-r="${r}" data-c="0" data-id="${it.id}" data-f="name" value="${fdEsc(it.name)}"><span class="fd-grip" title="Drag to reorder" onpointerdown="fdGripDown(event,'${it.id}','caviar')">⠿</span><span class="fd-del" title="Remove" onclick="fdDelItem('${it.id}')">×</span></div>
      ${fdNumIn('cav',r,1,it.id,'qty',e.qty)}${fdNumIn('cav',r,2,it.id,'gr',e.gr)}
    </div>`;
  }).join('');
  // always-present trailing row to add a new caviar type (saved to the standing list)
  const cavBlank = `<div class="fd-row fd-cav fd-writein">
    <div class="fd-namecell"><input class="fd-in fd-namein" list="fd-dl-cav" placeholder="＋ new caviar…" data-grid="cav" data-r="${cav.length}" data-c="0" data-f="newcav" value=""></div>
    ${fdNumIn('cav',cav.length,1,'','qty','',true)}${fdNumIn('cav',cav.length,2,'','gr','',true)}
  </div>`;

  host.innerHTML = `
    ${FD_STYLE}
    ${dl('fd-dl-fish', fish.map(i=>i.name))}
    ${dl('fd-dl-cav', cav.map(i=>i.name))}
    ${dl('fd-dl-all', fdItems.map(i=>i.name))}
    <div class="ops-title">Fish of the Day</div>
    <div class="ops-subtitle">Raw Bar · shared live · type in a cell · Enter = next row · paste a column · auto-saves · ${fdEsc(dateLabel)}</div>

    <div class="fd-actions">
      <button class="report-btn" onclick="fdPrint()">Print A3</button>
      <button class="report-btn" onclick="fdAddBlank()">＋ Blank write-in line</button>
    </div>

    <div class="fd-grid">
      <div class="fd-left">
        <div class="fd-coltitle">Fish <small>type in a cell · Enter drops down · × removes a fish</small></div>
        <div class="fd-head fd-head-fish"><span>Fish</span><span>Qty</span><span>Kg</span><span>Price</span></div>
        ${fishRows || '<div class="fd-empty-note">No items yet.</div>'}
        ${blanks}
      </div>
      <div class="fd-right">
        <div class="fd-coltitle">Caviar</div>
        <div class="fd-head fd-head-cav"><span>Type</span><span>Qty</span><span>Gr</span></div>
        ${cavRows}${cavBlank}
        <div class="fd-oyster"><span>Oyster N.</span><input class="fd-in" type="text" inputmode="numeric" data-grid="oyster" data-r="0" data-c="0" data-f="oyster" value="${fdEsc(fdDoc.oyster)}" placeholder="—"></div>
        ${fdListBlock('85 · Running Low','low85','short — order more')}
        ${fdListBlock('86 · Out of Stock','out86','not available tonight','b86')}
        ${fdListBlock('★ To Push Tonight','push','','push')}
      </div>
    </div>`;
  fdEnsureHandlers();
}
function fdListBlock(title, key, sub, cls){
  const arr = [...(fdDoc[key]||[])];
  while(arr.length && arr[arr.length-1]==='') arr.pop();   // trim trailing empties
  const lines = [...arr, '', '', ''];                      // + 3 spare write-in lines
  const cells = lines.map((v,i)=>`<div class="fd-lb-cell"><input class="fd-in fd-lbin" list="fd-dl-all" data-grid="${key}" data-r="${i}" data-c="0" data-f="list" value="${fdEsc(v||'')}" placeholder="+ add item">${v?`<span class="fd-del" onclick="fdDelList('${key}',${i})">×</span>`:''}</div>`).join('');
  return `<div class="fd-lb ${cls||''}"><div class="fd-lb-head">${title}${sub?` <small>— ${sub}</small>`:''}</div>${cells}</div>`;
}

// ── inline editing: delegated handlers (bound once on the persistent host) ────
function fdEnsureHandlers(){
  const host = document.getElementById('fish-view');
  if(!host || host._fdBound) return;
  host._fdBound = true;
  host.addEventListener('input', fdOnInput);
  host.addEventListener('change', fdOnChange);
  host.addEventListener('keydown', fdOnKey);
  host.addEventListener('paste', fdOnPaste, true);
  // when the user leaves the grid, apply any remote change that arrived mid-edit
  host.addEventListener('focusout', function(){ setTimeout(function(){ if(fdPendingRender && !fdGridFocused()){ fdPendingRender=false; renderFishDisplay(); } }, 80); });
}
function fdIsCell(t){ return t && t.classList && t.classList.contains('fd-in'); }
function fdFocusCell(grid, r, c){
  const host = document.getElementById('fish-view'); if(!host) return false;
  const el = host.querySelector('.fd-in[data-grid="'+grid+'"][data-r="'+r+'"][data-c="'+c+'"]');
  if(el && !el.disabled){ el.focus(); if(el.select) el.select(); return true; }
  return false;
}
function fdSetNum(id, field, val){
  if(!id) return;
  if(!fdDoc.entries[id]) fdDoc.entries[id] = {};
  val = (val==null?'':String(val)).trim();
  if(val==='') delete fdDoc.entries[id][field]; else fdDoc.entries[id][field] = val;
  if(!Object.keys(fdDoc.entries[id]).length) delete fdDoc.entries[id];
  fdMark('e|'+id+'|'+field, val);
}
function fdSetList(key, r, val){
  if(!Array.isArray(fdDoc[key])) fdDoc[key]=[];
  while(fdDoc[key].length <= r) fdDoc[key].push('');
  fdDoc[key][r] = (val==null?'':String(val));
  fdMark('l|'+key+'|'+r, fdDoc[key][r]);
}
function fdOnInput(e){
  const t=e.target; if(!fdIsCell(t)) return;
  const f=t.dataset.f;
  if(f==='name' || f==='newfish') return;             // committed on change (blur/Enter)
  if(f==='oyster'){ fdDoc.oyster = t.value.trim(); fdMark('o', fdDoc.oyster); fdSaveSoon(); return; }
  if(f==='list'){ fdSetList(t.dataset.grid, +t.dataset.r, t.value); fdSaveSoon(); return; }
  fdSetNum(t.dataset.id, f, t.value); fdSaveSoon();    // qty/kg/price/gr
}
async function fdOnChange(e){
  const t=e.target; if(!fdIsCell(t)) return;
  const f=t.dataset.f;
  if(f==='newfish'){ await fdCommitNewFish(t); return; }
  if(f==='newcav'){ await fdCommitNewCav(t); return; }
  if(f==='name'){
    const id=t.dataset.id, v=t.value.trim(), it=fdItems.find(i=>i.id===id);
    if(!v){ if(it) t.value=it.name; return; }          // don't let a blank wipe a standing item
    if(it && v!==it.name){ it.name=v; const r=await sb.from('fish_display_items').update({name:v}).eq('id',id); if(r&&r.error){ await loadFishDisplay(); renderFishDisplay(); } }
  }
}
function fdOnKey(e){
  const t=e.target; if(!fdIsCell(t)) return;
  if(e.key==='Enter'){
    e.preventDefault();
    const f=t.dataset.f, grid=t.dataset.grid, r=+t.dataset.r, c=+t.dataset.c;
    if(f==='newfish'){ fdCommitNewFish(t); return; }
    if(f==='newcav'){ fdCommitNewCav(t); return; }
    if(f==='name'){ t.dispatchEvent(new Event('change')); }
    if(!fdFocusCell(grid, r+1, c)) t.blur();            // last row → just commit
  }
}
function fdOnPaste(e){
  const t=e.target; if(!fdIsCell(t)) return;
  const grid=t.dataset.grid;
  if(['fish','cav','low85','out86','push'].indexOf(grid)===-1) return;
  const text=(e.clipboardData||window.clipboardData).getData('text');
  if(!text || !/[\n\t]/.test(text)) return;             // single value → normal paste
  e.preventDefault();
  const host=document.getElementById('fish-view');
  const rows=text.replace(/\r/g,'').split('\n'); while(rows.length && rows[rows.length-1]==='') rows.pop();
  const r0=+t.dataset.r, c0=+t.dataset.c;
  rows.forEach((line,ri)=>{ line.split('\t').forEach((val,ci)=>{
    const el=host.querySelector('.fd-in[data-grid="'+grid+'"][data-r="'+(r0+ri)+'"][data-c="'+(c0+ci)+'"]');
    if(!el || el.disabled) return;
    const f=el.dataset.f; if(f==='name'||f==='newfish') return;   // never paste over names
    el.value = val.trim();
    if(f==='list') fdSetList(grid, r0+ri, val.trim());
    else if(f==='oyster'){ fdDoc.oyster = val.trim(); fdMark('o', fdDoc.oyster); }
    else fdSetNum(el.dataset.id, f, val.trim());
  }); });
  fdSaveSoon();
}
async function fdCommitNewFish(el){
  const name=(el.value||'').trim(); if(!name) return;
  if(!fdItems.some(i=>i.kind==='fish' && i.name.toLowerCase()===name.toLowerCase())) await fdAddMaster(name,'fish');
  renderFishDisplay();
  const idx=fdFish().findIndex(i=>i.name.toLowerCase()===name.toLowerCase());
  if(idx>=0) fdFocusCell('fish', idx, 1);               // jump to the new fish's Qty
}
async function fdCommitNewCav(el){
  const name=(el.value||'').trim(); if(!name) return;
  if(!fdItems.some(i=>i.kind==='caviar' && i.name.toLowerCase()===name.toLowerCase())) await fdAddMaster(name,'caviar');
  renderFishDisplay();
  const idx=fdCav().findIndex(i=>i.name.toLowerCase()===name.toLowerCase());
  if(idx>=0) fdFocusCell('cav', idx, 1);                // jump to the new caviar's Qty
}

function fdDelList(key,i){
  if(Array.isArray(fdDoc[key])){ fdDoc[key].splice(i,1); }
  // the splice shifts every row after i, so the old row-keyed claims now point at
  // the wrong lines - drop them and re-claim the list exactly as it now stands
  Array.from(fdDirty.keys()).forEach(k=>{ if(k.indexOf('l|'+key+'|')===0) fdDirty.delete(k); });
  (fdDoc[key]||[]).forEach((v,r)=> fdMark('l|'+key+'|'+r, v));
  fdSaveSoon(); renderFishDisplay();
}
function fdAddBlank(){ fdDoc.blank_rows=(fdDoc.blank_rows||0)+1; fdMark('b', fdDoc.blank_rows); fdSaveSoon(); renderFishDisplay(); }
function fdRemoveBlank(){ fdDoc.blank_rows=Math.max(0,(fdDoc.blank_rows||0)-1); fdMark('b', fdDoc.blank_rows); fdSaveSoon(); renderFishDisplay(); }

// ── print (A3 landscape, white paper / black ink / bold clear font) ──────────
function fdPrint(){
  const dateLabel = new Date(fdBizDate+'T12:00:00').toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const cq=v=>v?fdEsc(v):'<span style="color:#fff">·</span>';
  const fishBody = fdFish().map(it=>{ const e=fdDoc.entries[it.id]||{};
    return `<tr><td class="fn">${fdEsc(it.name)}</td><td class="c">${cq(e.qty)}</td><td class="c">${cq(e.kg)}</td><td class="c">${cq(e.price)}</td></tr>`; }).join('');
  let blanks=''; for(let b=0;b<(fdDoc.blank_rows||0);b++) blanks+=`<tr><td class="fn">&nbsp;</td><td class="c"></td><td class="c"></td><td class="c"></td></tr>`;
  const cavBody = fdCav().map(it=>{ const e=fdDoc.entries[it.id]||{};
    return `<tr><td class="fn">${fdEsc(it.name)}</td><td class="c">${cq(e.qty)}</td><td class="c">${cq(e.gr)}</td></tr>`; }).join('');
  const lb=(title,key,cls)=>{ const items=(fdDoc[key]||[]).filter(x=>x&&x.trim());
    const cells = items.map(x=>`<div class="pl-item">${fdEsc(x)}</div>`).join('') || '<div class="pl-item">&nbsp;</div><div class="pl-item">&nbsp;</div>';
    return `<div class="pl ${cls||''}"><div class="pl-h">${title}</div>${cells}</div>`; };

  const html = `<div class="sheet">
    <div class="head">${FD_LOGO_SVG}<div class="datebox"><span class="lab">Date</span><div class="val">${fdEsc(dateLabel)}</div></div></div>
    <div class="sub">Fish of the Day · Raw Bar</div>
    <div class="body">
      <div class="left"><div class="ct">Fish</div>
        <table><colgroup><col><col style="width:14%"><col style="width:14%"><col style="width:17%"></colgroup>
        <thead><tr><th class="fh">Fish</th><th>Qty</th><th>Kg</th><th>Price</th></tr></thead>
        <tbody>${fishBody}${blanks}</tbody></table>
      </div>
      <div class="right">
        <div class="ct">Caviar</div>
        <table><colgroup><col><col style="width:22%"><col style="width:22%"></colgroup>
        <thead><tr><th class="fh">Type</th><th>Qty</th><th>Grams</th></tr></thead>
        <tbody>${cavBody}</tbody></table>
        <div class="oy"><span>Oyster N.</span><b>${fdDoc.oyster?fdEsc(fdDoc.oyster):''}</b></div>
        ${lb('85 · Running Low','low85')}
        ${lb('86 · Out of Stock','out86','b86')}
        ${lb('★ To Push Tonight','push','push')}
        <div class="foot"><span>Prepared by ______________</span><span>Roberto's DIFC</span></div>
      </div>
    </div>
  </div>`;

  const w = window.open('','_blank');
  if(!w){ alert('Pop-up blocked — allow pop-ups to print.'); return; }
  w.document.write(`<html><head><title>Fish of the Day — ${fdEsc(dateLabel)}</title><style>${FD_PRINT_CSS}</style></head><body>${html}<scr`+`ipt>window.onload=function(){setTimeout(function(){window.print();},250);}</scr`+`ipt></body></html>`);
  w.document.close(); w.focus();
}

// ── entry point ──────────────────────────────────────────────────────────────
async function openFishDisplay(){
  activeStation = FISH_KEY;
  hideAllPages();
  const host = document.getElementById('fish-view');
  host.style.display='block';
  document.querySelector('.footer-bar').style.display='flex';
  document.getElementById('foot-label').textContent='Fish Display';
  host.innerHTML = `${FD_STYLE}<div class="ops-title">Fish of the Day</div><div class="ops-subtitle">Loading…</div>`;
  await loadFishDisplay();
  subscribeFishDisplay();
  renderFishDisplay();
}

// ══ styles (screen) ══════════════════════════════════════════════════════════
const FD_STYLE = `<style id="fd-style">
.fd-actions{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.fd-grid{display:flex;gap:20px;align-items:flex-start}
/* stretch, not flex-start: once the flex direction is column, align-items sizes the
   panels across, and flex-start left them shrink-to-fit — so the name column could never
   claim the width the stacked layout had just freed up. */
@media(max-width:820px){.fd-grid{flex-direction:column;align-items:stretch}}
.fd-left{flex:2;min-width:0}.fd-right{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px}
.fd-coltitle{font-size:11px;letter-spacing:3px;text-transform:uppercase;color:var(--vino-light);border-bottom:1.5px solid var(--vino);padding-bottom:5px;margin-bottom:2px;display:flex;justify-content:space-between;align-items:baseline}
.fd-coltitle small{font-size:9px;letter-spacing:.5px;color:var(--vino-light);opacity:.6;text-transform:none}
.fd-head{display:grid;gap:1px;margin-bottom:2px}
.fd-head-fish{grid-template-columns:1fr .5fr .5fr .6fr}.fd-head-cav{grid-template-columns:1fr .5fr .5fr}
.fd-head span{font-size:9px;letter-spacing:1.2px;text-transform:uppercase;color:var(--vino-light);padding:4px 8px;text-align:center}
.fd-head span:first-child{text-align:left}
.fd-row{display:grid;gap:1px;border-bottom:1px solid var(--sabbia-dark);align-items:stretch}
.fd-row{grid-template-columns:1fr .5fr .5fr .6fr}
.fd-row.fd-cav{grid-template-columns:1fr .5fr .5fr}
/* Phone: four columns inside 375px left the name 129px, so "Seabass Wild Line Caught"
   was cut to a few letters — unreadable on the sheet the raw bar works off during
   service. Below 560px the name takes its own full-width line above the figures, and
   the header keeps only the numeric labels (the panel title above already says which
   list it is). Column count still matches the header, so Qty/Kg/Price stay aligned. */
@media(max-width:560px){
  .fd-head-fish{grid-template-columns:repeat(3,1fr)}
  .fd-head-cav{grid-template-columns:repeat(2,1fr)}
  .fd-head span:first-child{display:none}
  .fd-row{grid-template-columns:repeat(3,1fr)}
  .fd-row.fd-cav{grid-template-columns:repeat(2,1fr)}
  .fd-namecell{grid-column:1/-1;border-bottom:1px dotted var(--sabbia-dark)}
  .fd-namecell+.fd-num{border-left:none}
}
/* Tablet band: the panels already stack full-width at 820px, but the figure columns kept
   their desktop share — 132px each to hold "12.5", while the name was squeezed to 265px
   and still lost a long one. Cap the figures instead of stacking; the name then gets the
   rest and the sheet stays one line per fish (a 25-row raw-bar list read at a glance). */
@media(min-width:561px) and (max-width:820px){
  .fd-head-fish,.fd-row{grid-template-columns:minmax(0,1fr) 84px 84px 96px}
  .fd-head-cav,.fd-row.fd-cav{grid-template-columns:minmax(0,1fr) 84px 84px}
}
.fd-name{position:relative;font-family:var(--font-serif);font-size:19px;color:var(--ink);padding:8px 10px;cursor:pointer;text-transform:capitalize}
.fd-row.set .fd-name{color:var(--vino);font-weight:600}
.fd-row.fd-cav .fd-name{font-size:16px}
.fd-name.empty.fd-writein-name{color:#c9a48a;font-style:italic;font-size:13px;font-family:var(--font-sans);text-transform:none}
.fd-cell{text-align:center;font-size:16px;font-weight:600;color:var(--ink);padding:8px 4px;border-left:1px solid var(--sabbia-dark);cursor:pointer}
.fd-cell.empty{color:var(--sabbia-dark)}
.fd-name:hover,.fd-cell:hover{background:var(--sabbia-light)}
.fd-del{position:absolute;right:5px;top:50%;transform:translateY(-50%);width:19px;height:19px;line-height:17px;text-align:center;border-radius:50%;background:var(--sabbia-dark);color:var(--vino);font-size:14px;opacity:.4;transition:opacity .12s;cursor:pointer;z-index:2}
.fd-row:hover .fd-del,.fd-lb-cell:hover .fd-del{opacity:1}.fd-del:hover{background:var(--vino);color:var(--cream);opacity:1}
.fd-grip{position:absolute;right:30px;top:50%;transform:translateY(-50%);width:28px;height:28px;line-height:28px;text-align:center;border-radius:6px;background:var(--sabbia-dark);color:var(--vino);font-size:16px;opacity:.55;transition:opacity .12s,background .12s;cursor:grab;z-index:2;user-select:none;touch-action:none}
.fd-row:hover .fd-grip{opacity:1}.fd-grip:hover{background:var(--vino);color:var(--cream);opacity:1}.fd-grip:active{cursor:grabbing;background:var(--vino);color:var(--cream);opacity:1}
/* the row you are carrying: glued to the pointer, so no transition on it */
.fd-row.fd-dragging{opacity:.97;background:var(--sabbia-light);box-shadow:0 8px 22px rgba(66,2,7,.26);border-radius:6px;position:relative;z-index:50;transition:none;will-change:transform;border-bottom-color:transparent}
/* the rows it displaces: slide aside instead of snapping */
.fd-row.fd-shift{transition:transform .16s cubic-bezier(.2,.7,.3,1);will-change:transform}
body.fd-dragging-active{cursor:grabbing;user-select:none}
body.fd-dragging-active .fd-in{pointer-events:none}
@media (prefers-reduced-motion: reduce){ .fd-row.fd-shift{transition:none} }
/* inline Excel-style inputs */
.fd-namecell{position:relative;display:flex;align-items:center;overflow:hidden}
.fd-in{width:100%;border:none;background:transparent;font-family:var(--font-sans);color:var(--ink);padding:8px 6px;-webkit-appearance:none;border-radius:0}
.fd-in:focus{outline:none;background:#fff;box-shadow:inset 0 0 0 2px var(--vino)}
.fd-in::placeholder{color:var(--sabbia-dark);font-style:italic}
.fd-num{text-align:center;font-size:16px;font-weight:600;border-left:1px solid var(--sabbia-dark)}
.fd-num:disabled{background:transparent}
.fd-namein{font-family:var(--font-serif);font-size:19px;text-align:left;padding-right:70px;text-transform:capitalize}
.fd-row.fd-cav .fd-namein{font-size:16px}
.fd-namein[data-f="newfish"],.fd-namein[data-f="newcav"]{color:#b98a6a;font-style:italic;font-size:14px;font-family:var(--font-sans);text-transform:none}
.fd-lbin{font-size:15px;font-weight:600;padding:8px 12px;padding-right:24px}
.fd-lb.b86 .fd-lbin{color:#c00000}
.fd-oyster{display:flex;justify-content:space-between;align-items:center;border:1.5px solid var(--vino);border-radius:4px;padding:6px 8px 6px 12px}
.fd-oyster span{font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:var(--vino-light)}
.fd-oyster input{width:90px;text-align:right;font-family:var(--font-serif);font-size:22px;color:var(--vino);font-weight:600}
.fd-lb{border:1.5px solid var(--vino);border-radius:4px;overflow:hidden}
.fd-lb.b86{border-color:#c00000}.fd-lb.push{border-color:var(--oro)}
.fd-lb-head{font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#fff;background:var(--vino);padding:6px 12px}
.fd-lb.b86 .fd-lb-head{background:#c00000}.fd-lb.push .fd-lb-head{background:var(--oro);color:var(--ink)}
.fd-lb-head small{font-weight:400;opacity:.85;letter-spacing:.3px;text-transform:none;font-size:9px}
.fd-lb-cell{position:relative;padding:8px 12px;border-bottom:1px solid var(--sabbia-dark);font-size:15px;font-weight:600;color:var(--ink);cursor:pointer}
.fd-lb-cell:last-child{border-bottom:none}
.fd-lb-cell.empty{color:var(--sabbia-dark);font-weight:400;font-style:italic;font-size:12px}
.fd-lb.b86 .fd-lb-cell:not(.empty){color:#c00000}
.fd-lb-cell:hover{background:var(--sabbia-light)}
.fd-dot{color:var(--sabbia-dark);margin:0 5px}
.fd-empty-note{color:var(--vino-light);padding:14px;font-size:13px}
.fd-ov{position:fixed;inset:0;background:rgba(42,26,16,.5);display:none;align-items:flex-end;justify-content:center;z-index:9000}
.fd-ov.show{display:flex}
.fd-pop{background:var(--sabbia-light);width:100%;max-width:520px;border-radius:14px 14px 0 0;overflow:hidden;box-shadow:0 -8px 40px rgba(0,0,0,.3)}
@media(min-width:640px){.fd-ov{align-items:center}.fd-pop{border-radius:14px}}
.fd-pop h4{background:var(--vino);color:var(--cream);font-family:var(--font-serif);font-size:22px;padding:14px 18px;text-transform:capitalize}
.fd-pb{padding:16px 18px}
.fd-pb input{width:100%;font-size:17px;padding:11px 12px;border:1.5px solid var(--sabbia-dark);border-radius:8px;font-family:var(--font-sans);background:var(--cream);color:var(--ink)}
.fd-pb input:focus{outline:none;border-color:var(--vino)}
.fd-sugg{max-height:200px;overflow:auto;margin-top:8px;border:1px solid var(--sabbia-dark);border-radius:8px;background:var(--cream)}
.fd-sg{padding:10px 12px;font-size:15px;cursor:pointer;border-bottom:1px solid var(--sabbia);text-transform:capitalize;color:var(--ink)}
.fd-sg:hover{background:var(--sabbia-light)}.fd-sg.add{color:var(--vino);font-weight:700;text-transform:none}.fd-sg.muted{color:#aaa;cursor:default}
.fd-acts{display:flex;justify-content:space-between;align-items:center;padding:0 18px 18px}
.fd-clr{background:none;border:none;color:var(--vino-light);font-size:13px;cursor:pointer}
.fd-sv{background:var(--vino);color:var(--cream);border:none;border-radius:8px;padding:11px 30px;font-size:14px;font-weight:600;cursor:pointer;font-family:var(--font-sans)}
</style>`;

// ══ the official Roberto's Dubai wordmark (vector) — used on the printout ═════
const FD_LOGO_SVG = `<svg class="logo" viewBox="0 0 2500 757.54" xmlns="http://www.w3.org/2000/svg" aria-label="Roberto's Dubai"><path fill="#fa4700" d="M2062.04,256.92c5.81-1.5,11.07-3.89,15.78-7.15,4.7-3.26,8.72-6.96,12.04-11.1,3.32-4.14,5.74-8.59,7.26-13.35,1.52-4.76,2.14-9.41,1.87-13.92h-23.67c-2.22-3.01-4.01-6.08-5.4-9.22-1.39-3.13-2.08-6.46-2.08-9.97,0-3.02.34-5.83,1.04-8.47.69-2.64,1.59-5.08,2.7-7.34,1.1-2.26,2.35-4.39,3.74-6.4h46.09c2.21,5.02,4.01,9.91,5.4,14.67,1.38,4.77,2.08,9.66,2.08,14.67,0,7.03-1.32,14.43-3.95,22.2-2.63,7.78-6.58,14.67-11.83,20.7-4.15,5.02-9.9,10.03-17.23,15.05-7.34,5.02-16.13,8.53-26.37,10.53l-7.47-10.91Z"/><path fill="#410207" d="M352.22,341.81v3.27h-20.02c-16.38,0-32.76-4.91-42.17-17.2-9.4-12.28-25.78-35.49-37.01-49.41-5.15-6.55-10.92-7.64-16.08-7.64h-28.51v53.51c0,11.47,7.28,17.2,21.84,17.74v3h-66.74v-3c14.56-.55,21.84-6.28,21.84-17.47v-140.05c0-11.2-7.28-17.2-21.84-17.47v-2.73h86.76c40.04,0,64.31,18.29,64.31,52.69,0,27.85-16.08,43.68-37.61,50.23,2.43,2.46,4.85,4.92,6.98,7.37,14.56,17.74,24.27,35.22,32.16,44.5,10.62,11.47,19.71,22.66,36.1,22.66ZM208.44,267.82h36.4c20.02,0,43.68-17.74,43.68-50.78,0-29.21-18.2-49.68-47.02-49.68h-33.06v100.46Z"/><path fill="#410207" d="M523.29,345.63c-45.2,0-93.12-31.94-93.12-90.91s48.84-91.18,97.07-91.18,95.86,31.94,95.86,91.18-55.21,90.91-92.22,90.91h-7.58ZM460.2,254.72c0,39.31,29.42,87.09,66.43,87.09s66.73-40.13,66.73-87.36-29.42-87.36-66.73-87.36-66.43,38.49-66.43,87.63Z"/><path fill="#410207" d="M885.77,295.94c0,32.49-34.88,49.14-75.53,49.14h-91.61v-3c13.65-.27,20.93-5.73,21.84-15.84v-143.32c-.91-10.37-8.19-15.56-21.84-15.83v-2.73h83.42c40.65,0,64.01,13.92,64.01,43.95,0,15.02-12.14,34.94-31.85,39.31,33.06,4.37,51.57,21.57,51.57,48.32ZM763.82,167.63v79.99h38.52c21.23,0,38.22-14.74,38.22-39.31,0-23.2-17.29-40.68-43.07-40.68h-33.67ZM856.65,295.94c0-31.12-23.06-43.95-54.3-43.95h-38.22v90.09h37.61c33.67,0,54.91-17.74,54.91-46.14Z"/><path fill="#410207" d="M1138.74,306.86l5.15-.55-9.7,38.77h-148.64v-3c14.86-.27,21.23-7.1,21.84-22.39l.61-130.49c-.61-15.29-6.97-21.84-21.84-22.11v-2.73l141.97-.27,8.79,38.22h-4.85c-3.03-9.83-23.66-35.22-43.07-35.22h-57.03v80.53h41.25c13.35-.27,19.41-13.1,19.72-25.94h4.85v55.42h-4.85c-.31-12.56-6.37-25.39-19.41-25.66h-41.56v90.64h63.7c26.39,0,40.04-25.39,43.08-35.22Z"/><path fill="#410207" d="M1430.84,341.81v3.27h-20.02c-16.38,0-32.76-4.91-42.17-17.2-9.4-12.28-25.78-35.49-37.01-49.41-5.15-6.55-10.92-7.64-16.08-7.64h-28.51v53.51c0,11.47,7.28,17.2,21.84,17.74v3h-66.74v-3c14.56-.55,21.84-6.28,21.84-17.47v-140.05c0-11.2-7.28-17.2-21.84-17.47v-2.73h86.76c40.04,0,64.31,18.29,64.31,52.69,0,27.85-16.08,43.68-37.61,50.23,2.43,2.46,4.85,4.92,6.98,7.37,14.56,17.74,24.27,35.22,32.16,44.5,10.62,11.47,19.71,22.66,36.1,22.66ZM1287.06,267.82h36.4c20.02,0,43.68-17.74,43.68-50.78,0-29.21-18.2-49.68-47.02-49.68h-33.06v100.46Z"/><path fill="#410207" d="M1663.8,164.36l9.1,37.95h-5.16c-3.03-9.56-23.66-35.22-43.07-35.22h-25.18v157.52c0,11.19,7.58,17.2,21.84,17.47v3h-67.65v-3c13.35-.27,21.84-6.28,21.84-16.93v-158.07h-24.87c-19.41,0-40.04,25.66-43.07,35.22h-5.16l9.1-37.95h152.28Z"/><path fill="#410207" d="M1862.77,345.63c-45.2,0-93.12-31.94-93.12-90.91s48.84-91.18,97.07-91.18,95.85,31.94,95.85,91.18-55.2,90.91-92.21,90.91h-7.58ZM1799.68,254.72c0,39.31,29.42,87.09,66.43,87.09s66.73-40.13,66.73-87.36-29.42-87.36-66.73-87.36-66.43,38.49-66.43,87.63Z"/><path fill="#410207" d="M2336.46,299.04c0,34.61-30.17,46.59-58.57,46.59s-53.84-9.85-68.63-24.49l12.72-22.36s20.71,43.93,55.9,43.93c25.44,0,36.97-21.03,36.97-31.68,0-33.28-29.88-42.59-40.23-46.59,0,0-15.97-6.12-21-8.25-15.38-5.85-38.45-19.97-36.39-48.18,1.18-18.1,15.68-44.46,55.61-44.46s59.46,19.7,59.46,19.7l-16.86,19.17s-10.65-36.47-42-36.47c-19.52,0-35.2,13.58-37.27,30.88-1.77,15.71,10.06,33.54,30.17,42.33,1.77.8,18.04,7.99,21.59,9.58,21.6,8.78,48.51,24.49,48.51,50.31Z"/><path fill="#410207" d="M1007.51,546.18c0-6.33-1.14-12.32-3.43-17.96-2.29-5.64-5.49-10.57-9.6-14.78-4.12-4.2-8.99-7.55-14.59-10.02-5.61-2.47-11.69-3.71-18.24-3.71h-7.59v87.61h7.9c5.36,0,10.74-.82,16.15-2.45,5.41-1.64,10.3-4.16,14.67-7.57,4.37-3.42,7.92-7.7,10.65-12.85,2.73-5.14,4.1-11.23,4.1-18.26M938.6,591.03h.74c.69,0,1.33-.29,1.93-.89.6-.6,1.11-1.29,1.56-2.08.44-.79.76-1.66.97-2.6.19-.94.29-1.8.29-2.59v-79.15c0-.69-.1-1.49-.29-2.37-.2-.89-.5-1.73-.89-2.53-.4-.79-.89-1.46-1.49-2-.59-.54-1.29-.82-2.08-.82h-.74v-1.48h28.66c7.82,0,14.85,1.36,21.09,4.08,6.24,2.72,11.51,6.38,15.81,10.99,4.31,4.6,7.6,9.87,9.88,15.82,2.27,5.94,3.41,12.13,3.41,18.56,0,6.04-1.09,11.95-3.26,17.75-2.18,5.79-5.45,10.97-9.81,15.52-4.35,4.55-9.79,8.24-16.33,11.06-6.53,2.82-14.1,4.24-22.72,4.24h-26.73v-1.49Z"/><path fill="#410207" d="M1095.57,494.51h21.09v1.49h-.74c-.79,0-1.48.27-2.08.81-.6.55-1.11,1.21-1.56,2-.44.8-.76,1.64-.97,2.53-.19.89-.29,1.68-.29,2.37v58.66c0,3.86.4,7.42,1.19,10.69.79,3.26,2.13,6.09,4.01,8.47,1.88,2.37,4.36,4.23,7.43,5.56,3.07,1.34,6.83,2.01,11.29,2.01,4.95,0,8.91-.8,11.88-2.38,2.97-1.58,5.25-3.64,6.83-6.16,1.59-2.53,2.63-5.38,3.12-8.54.49-3.17.74-6.29.74-9.36v-58.96c0-.69-.09-1.48-.29-2.37s-.52-1.73-.97-2.53c-.44-.79-.97-1.45-1.56-2-.59-.54-1.24-.81-1.93-.81h-.74v-1.49h16.19v1.49h-.74c-.8,0-1.46.27-2,.81-.55.55-1.04,1.21-1.49,2-.45.8-.76,1.64-.97,2.53-.2.89-.29,1.68-.29,2.37v58.51c0,6.44-.8,11.71-2.38,15.82-1.58,4.11-3.76,7.35-6.54,9.73-2.77,2.37-6.01,4.01-9.73,4.9-3.71.89-7.65,1.34-11.8,1.34-4.46,0-8.59-.48-12.4-1.41-3.81-.94-7.1-2.6-9.87-4.97-2.77-2.38-4.95-5.62-6.54-9.73-1.58-4.11-2.37-9.28-2.37-15.52v-58.66c0-.69-.1-1.48-.29-2.37-.2-.89-.52-1.73-.97-2.53-.44-.79-.97-1.45-1.55-2-.6-.54-1.24-.81-1.93-.81h-.74v-1.49Z"/><path fill="#410207" d="M1297.52,565.56c-.79-7.65-3.37-13.56-7.72-17.73-4.36-4.17-10.5-6.25-18.42-6.25h-8.31v46.18h8.61c8.02,0,14.33-1.82,18.93-5.44,4.6-3.63,6.91-8.67,6.91-15.13v-1.64ZM1291.43,518.04c-.3-5.76-2.31-10.34-6.02-13.71-3.71-3.38-8.68-5.07-14.92-5.07h-7.43v37.57h7.72c4.16,0,7.55-.55,10.17-1.64,2.62-1.09,4.73-2.51,6.31-4.25,1.58-1.74,2.67-3.65,3.26-5.74.6-2.08.9-4.13.9-6.11v-1.05ZM1247.62,591.03h.74c.69,0,1.33-.29,1.92-.89.6-.6,1.12-1.29,1.56-2.08.45-.79.76-1.66.97-2.6.2-.94.3-1.8.3-2.59v-79c0-.69-.1-1.48-.3-2.37-.2-.89-.52-1.76-.97-2.6-.44-.84-.99-1.53-1.63-2.08-.65-.54-1.36-.82-2.15-.82h-.74v-1.48h24.35c9.2,0,16.41,2.02,21.6,6.09,5.2,4.06,7.8,9.46,7.8,16.19,0,2.87-.5,5.44-1.49,7.72-.99,2.28-2.25,4.3-3.79,6.09-1.53,1.78-3.19,3.29-4.97,4.53-1.78,1.24-3.47,2.25-5.05,3.04,4.16.8,7.62,2.13,10.39,4.01,2.77,1.88,5.01,4.04,6.71,6.46,1.7,2.43,2.89,5.02,3.57,7.8.68,2.77,1.01,5.5,1.01,8.17,0,5.15-.94,9.48-2.81,12.99-1.88,3.51-4.38,6.39-7.48,8.61-3.11,2.23-6.67,3.84-10.66,4.83-4,.99-8.12,1.49-12.37,1.49h-26.52v-1.49Z"/><path fill="#410207" d="M1408.3,544.1h22.87l-11.43-31.03-11.43,31.03ZM1442.31,591.03h.74c2.37,0,3.56-1.09,3.56-3.26,0-.79-.15-1.64-.44-2.53l-13.37-36.08h-25.99l-12.92,35.48c-.3.8-.45,1.53-.45,2.23,0,1.29.35,2.3,1.04,3.04.69.74,1.43,1.11,2.23,1.11h.74v1.49h-16.48v-1.49h.74c1.29,0,2.55-.76,3.79-2.3,1.23-1.53,2.25-3.34,3.04-5.42l34-90.58,33.27,89.69c.69,1.98,1.66,3.91,2.9,5.79,1.23,1.88,2.84,2.82,4.83,2.82h.74v1.49h-21.98v-1.49Z"/><path fill="#410207" d="M1539.12,494.51h21.09v1.49h-.74c-.69,0-1.33.27-1.93.81-.59.55-1.09,1.19-1.48,1.93-.4.74-.72,1.59-.97,2.53-.25.94-.37,1.76-.37,2.45v79.15c0,.79.09,1.66.29,2.6.19.94.52,1.8.97,2.59.44.8.94,1.49,1.49,2.08.54.6,1.21.89,2,.89h.74v1.49h-21.09v-1.49h.74c.79,0,1.49-.27,2.08-.81.59-.55,1.11-1.24,1.56-2.08.44-.84.76-1.73.96-2.67.2-.95.3-1.81.3-2.6v-79.15c0-.69-.1-1.48-.3-2.37-.19-.89-.52-1.73-.96-2.53-.45-.79-.97-1.45-1.56-2-.6-.54-1.29-.81-2.08-.81h-.74v-1.49Z"/></svg>`;

// ══ print stylesheet (A3 landscape, minimal ink) ═════════════════════════════
const FD_PRINT_CSS = `
@page{ size:A3 landscape; margin:10mm; }
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;color:#000;background:#fff}
.sheet{padding:4mm}
.head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2.5px solid #000;padding-bottom:8px}
.logo{height:44px;width:auto;display:block}
.datebox{text-align:right}.datebox .lab{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#555}
.datebox .val{font-size:20px;font-weight:700;border-bottom:1.5px solid #000;padding:2px 6px 3px;margin-top:3px}
.sub{font-size:12px;letter-spacing:5px;text-transform:uppercase;margin:6px 0 4px}
.body{display:flex;gap:12mm;margin-top:8px}
.left{flex:2}.right{flex:1;display:flex;flex-direction:column;gap:7px}
.ct{font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;border-bottom:1.5px solid #000;padding-bottom:3px;margin-bottom:2px}
table{width:100%;border-collapse:collapse}
th{font-size:9.5px;letter-spacing:1.2px;text-transform:uppercase;text-align:center;padding:3px 5px;border-bottom:1.5px solid #000}
th.fh{text-align:left}
td{border-bottom:1px solid #ccc}
td.fn{font-size:14px;font-weight:700;padding:4.5px 8px;text-transform:capitalize}
td.c{text-align:center;font-size:14px;font-weight:700;padding:4.5px 4px;border-left:1px solid #e0e0e0}
.oy{display:flex;justify-content:space-between;align-items:center;border:1.5px solid #000;padding:7px 12px}
.oy span{font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700}.oy b{font-size:22px}
.pl{border:1.5px solid #000}.pl.b86{border-color:#c00000}
.pl-h{font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#fff;background:#000;padding:5px 10px}
.pl.b86 .pl-h{background:#c00000}
.pl-item{padding:6px 10px;border-bottom:1px solid #ddd;font-size:14px;font-weight:700}
.pl.b86 .pl-item{color:#c00000}.pl-item:last-child{border-bottom:none}
.foot{margin-top:auto;display:flex;justify-content:space-between;font-size:10px;color:#555;letter-spacing:1px;text-transform:uppercase;border-top:1px solid #000;padding-top:5px}
`;
