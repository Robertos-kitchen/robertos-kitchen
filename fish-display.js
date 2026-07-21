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
  const it = await sb.from('fish_display_items').select('*').eq('active', true).order('kind').order('sort_order');
  fdItems = (it.data || []);
  const sh = await sb.from('fish_display_sheet').select('doc').eq('biz_date', fdBizDate).maybeSingle();
  fdDoc = fdNormalise(sh && sh.data ? sh.data.doc : null);
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
        fdDoc = fdNormalise(r.doc);
        if(activeStation === FISH_KEY && !fdCtx) renderFishDisplay();   // don't yank the sheet out from under an open editor
        fdFlashSync();
      })
    .on('postgres_changes', { event:'*', schema:'public', table:'fish_display_items' },
      () => { if(activeStation === FISH_KEY){ loadFishDisplay().then(()=>{ if(activeStation===FISH_KEY && !fdCtx) renderFishDisplay(); }); } })
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
  const row = { biz_date: fdBizDate, doc: snapshot, updated_by:(window.CURRENT_USER||null), updated_at:new Date().toISOString() };
  const res = await sb.from('fish_display_sheet').upsert(row, { onConflict:'biz_date' });
  if(res && res.error){
    console.warn('fish_display_sheet save failed', res.error);
    // pull the server's truth back so the screen never shows what the DB doesn't have
    const sh = await sb.from('fish_display_sheet').select('doc').eq('biz_date', fdBizDate).maybeSingle();
    fdDoc = fdNormalise(sh && sh.data ? sh.data.doc : null);
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
// soft-delete a standing item (removes the row from the template going forward)
async function fdDelItem(id){
  fdItems = fdItems.filter(i=>i.id!==id);
  delete fdDoc.entries[id];
  renderFishDisplay();
  const res = await sb.from('fish_display_items').update({ active:false }).eq('id', id);
  if(res && res.error){ await loadFishDisplay(); renderFishDisplay(); }
  fdSaveSoon();
}

// ── render ───────────────────────────────────────────────────────────────────
function fdMeta(e, kind){
  if(!e) return '';
  const parts=[];
  if(e.qty) parts.push('<b>'+fdEsc(e.qty)+'</b>');
  if(kind==='caviar'){ if(e.gr) parts.push(fdEsc(e.gr)+' g'); }
  else { if(e.kg) parts.push(fdEsc(e.kg)+' kg'); if(e.price) parts.push('AED '+fdEsc(e.price)); }
  return parts.join('<span class="fd-dot">·</span>');
}
function renderFishDisplay(){
  const host = document.getElementById('fish-view');
  if(!host) return;
  const dateLabel = new Date(fdBizDate+'T12:00:00').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric'});

  const fishRows = fdFish().map(it=>{
    const e = fdDoc.entries[it.id];
    const set = e && (e.qty||e.kg||e.price);
    return `<div class="fd-row${set?' set':''}">
      <div class="fd-name" onclick="fdEditItem('${it.id}')">${fdEsc(it.name)}<span class="fd-del" title="Remove from list" onclick="event.stopPropagation();fdDelItem('${it.id}')">×</span></div>
      <div class="fd-cell${(e&&e.qty)?'':' empty'}" onclick="fdEditNum('${it.id}','qty')">${(e&&e.qty)?fdEsc(e.qty):'·'}</div>
      <div class="fd-cell${(e&&e.kg)?'':' empty'}" onclick="fdEditNum('${it.id}','kg')">${(e&&e.kg)?fdEsc(e.kg):'·'}</div>
      <div class="fd-cell${(e&&e.price)?'':' empty'}" onclick="fdEditNum('${it.id}','price')">${(e&&e.price)?fdEsc(e.price):'·'}</div>
    </div>`;
  }).join('');

  let blanks='';
  for(let b=0;b<(fdDoc.blank_rows||0);b++){
    blanks += `<div class="fd-row fd-writein">
      <div class="fd-name empty fd-writein-name" onclick="fdEditNewFish()">＋ blank line (write-in)<span class="fd-del" title="Remove line" onclick="event.stopPropagation();fdRemoveBlank()">×</span></div>
      <div class="fd-cell empty" onclick="fdEditNewFish()">·</div><div class="fd-cell empty" onclick="fdEditNewFish()">·</div><div class="fd-cell empty" onclick="fdEditNewFish()">·</div>
    </div>`;
  }

  const cavRows = fdCav().map(it=>{
    const e = fdDoc.entries[it.id];
    const set = e && (e.qty||e.gr);
    return `<div class="fd-row fd-cav${set?' set':''}">
      <div class="fd-name" onclick="fdEditItem('${it.id}')">${fdEsc(it.name)}<span class="fd-del" title="Remove" onclick="event.stopPropagation();fdDelItem('${it.id}')">×</span></div>
      <div class="fd-cell${(e&&e.qty)?'':' empty'}" onclick="fdEditNum('${it.id}','qty')">${(e&&e.qty)?fdEsc(e.qty):'·'}</div>
      <div class="fd-cell${(e&&e.gr)?'':' empty'}" onclick="fdEditNum('${it.id}','gr')">${(e&&e.gr)?fdEsc(e.gr):'·'}</div>
    </div>`;
  }).join('');

  host.innerHTML = `
    ${FD_STYLE}
    <div class="ops-title">Fish of the Day</div>
    <div class="ops-subtitle">Raw Bar · shared live · tap a cell to fill · ${fdEsc(dateLabel)}</div>

    <div class="fd-actions">
      <button class="report-btn" onclick="fdPrint()">Print A3</button>
      <button class="report-btn" onclick="fdAddBlank()">＋ Blank write-in line</button>
    </div>

    <div class="fd-grid">
      <div class="fd-left">
        <div class="fd-coltitle">Fish <small>tap a name to change · tap a blank line to add</small></div>
        <div class="fd-head fd-head-fish"><span>Fish</span><span>Qty</span><span>Kg</span><span>Price</span></div>
        ${fishRows || '<div class="fd-empty-note">No items yet.</div>'}
        ${blanks}
      </div>
      <div class="fd-right">
        <div class="fd-coltitle">Caviar</div>
        <div class="fd-head fd-head-cav"><span>Type</span><span>Qty</span><span>Gr</span></div>
        ${cavRows}
        <div class="fd-oyster"><span>Oyster N.</span><b onclick="fdEditOyster()">${fdDoc.oyster?fdEsc(fdDoc.oyster):'—'}</b></div>
        ${fdListBlock('85 · Running Low','low85','short — order more')}
        ${fdListBlock('86 · Out of Stock','out86','not available tonight','b86')}
        ${fdListBlock('★ To Push Tonight','push','','push')}
      </div>
    </div>`;
}
function fdListBlock(title, key, sub, cls){
  const arr = [...(fdDoc[key]||[])];
  if(arr.length===0 || arr[arr.length-1]!=='') arr.push('');
  const cells = arr.map((v,i)=>`<div class="fd-lb-cell${v?'':' empty'}" onclick="fdEditList('${key}',${i})">${v?fdEsc(v):'+ add item'}${v?`<span class="fd-del" onclick="event.stopPropagation();fdDelList('${key}',${i})">×</span>`:''}</div>`).join('');
  return `<div class="fd-lb ${cls||''}"><div class="fd-lb-head">${title}${sub?` <small>— ${sub}</small>`:''}</div>${cells}</div>`;
}

// ── editors ──────────────────────────────────────────────────────────────────
function fdOpenPop(title, html){
  let ov = document.getElementById('fd-ov');
  if(!ov){ ov=document.createElement('div'); ov.id='fd-ov'; ov.className='fd-ov'; document.body.appendChild(ov);
    ov.addEventListener('click',e=>{ if(e.target.id==='fd-ov') fdClosePop(); }); }
  ov.innerHTML = `<div class="fd-pop"><h4>${fdEsc(title)}</h4><div class="fd-pb" id="fd-pb">${html}</div>
    <div class="fd-acts"><button class="fd-clr" onclick="fdClearCell()">Clear</button><button class="fd-sv" onclick="fdSaveCell()">Save</button></div></div>`;
  ov.classList.add('show');
  const inp = document.getElementById('fd-q'); if(inp){ inp.focus(); inp.select && inp.select(); }
}
function fdClosePop(){ const ov=document.getElementById('fd-ov'); if(ov) ov.classList.remove('show'); fdCtx=null; }

function fdEditItem(id){
  const it = fdItems.find(i=>i.id===id); if(!it) return;
  fdCtx = { type:'item', id, kind:it.kind };
  fdOpenPop(it.name, `<input id="fd-q" placeholder="Search or type a new name…" oninput="fdSugg()" value="${fdEsc(it.name)}"><div class="fd-sugg" id="fd-sg"></div>`);
  fdSugg();
}
function fdEditNewFish(){
  fdCtx = { type:'newfish', kind:'fish' };
  fdOpenPop('Add fish', `<input id="fd-q" placeholder="Search or type a new item…" oninput="fdSugg()" value=""><div class="fd-sugg" id="fd-sg"></div>`);
  fdSugg();
}
function fdSugg(){
  const q = (document.getElementById('fd-q').value||'').trim();
  const ql = q.toLowerCase();
  const pool = fdItems.filter(i=>i.kind===fdCtx.kind).map(i=>i.name);
  const matches = pool.filter(n=>n.toLowerCase().includes(ql));
  let html = matches.map(n=>`<div class="fd-sg" onclick="fdPick(${JSON.stringify(n).replace(/"/g,'&quot;')})">${fdEsc(n)}</div>`).join('');
  if(q && !pool.some(n=>n.toLowerCase()===ql)) html = `<div class="fd-sg add" onclick="fdPickNew()">➕ Add “<b>${fdEsc(q)}</b>” as new item</div>`+html;
  document.getElementById('fd-sg').innerHTML = html || '<div class="fd-sg muted">type to add a new item…</div>';
}
async function fdPick(name){
  if(fdCtx.type==='newfish'){ const m = await fdAddMaster(name,'fish'); if(m){ /* named as existing → nothing extra */ } }
  else if(fdCtx.type==='item'){
    // rename an existing standing item
    const it = fdItems.find(i=>i.id===fdCtx.id); if(it && it.name!==name){ it.name=name; await sb.from('fish_display_items').update({name}).eq('id',it.id); }
  }
  renderFishDisplay(); fdClosePop();
}
async function fdPickNew(){
  const name = (document.getElementById('fd-q').value||'').trim(); if(!name) return;
  if(fdCtx.type==='newfish' || fdCtx.type==='item'){
    const kind = fdCtx.kind;
    if(fdCtx.type==='item'){ const it=fdItems.find(i=>i.id===fdCtx.id); if(it){ it.name=name; await sb.from('fish_display_items').update({name}).eq('id',it.id); } }
    else { await fdAddMaster(name, kind); }
  }
  renderFishDisplay(); fdClosePop();
}

function fdEditNum(id, field){
  const it = fdItems.find(i=>i.id===id);
  fdCtx = { type:'num', id, field };
  const e = fdDoc.entries[id] || {};
  fdOpenPop((it?it.name+' — ':'')+field.toUpperCase(), `<input id="fd-q" type="number" inputmode="decimal" placeholder="0" value="${fdEsc(e[field]||'')}">`);
}
function fdEditOyster(){ fdCtx={type:'oyster'}; fdOpenPop('Oyster N.', `<input id="fd-q" type="number" inputmode="numeric" placeholder="0" value="${fdEsc(fdDoc.oyster)}">`); }
function fdEditList(key,i){
  fdCtx={type:'list',key,i};
  const cur = (fdDoc[key]||[])[i]||'';
  const title = key==='out86'?'86 · Out of stock':key==='low85'?'85 · Running low':'To push tonight';
  fdOpenPop(title, `<input id="fd-q" placeholder="Pick or type…" oninput="fdSuggList()" value="${fdEsc(cur)}"><div class="fd-sugg" id="fd-sg"></div>`);
  fdSuggList();
}
function fdSuggList(){
  const q=(document.getElementById('fd-q').value||'').trim(); const ql=q.toLowerCase();
  const pool = fdItems.map(i=>i.name);
  const matches = pool.filter(n=>n.toLowerCase().includes(ql));
  let html = matches.map(n=>`<div class="fd-sg" onclick="fdPickList(${JSON.stringify(n).replace(/"/g,'&quot;')})">${fdEsc(n)}</div>`).join('');
  if(q && !pool.some(n=>n.toLowerCase()===ql)) html = `<div class="fd-sg add" onclick="fdPickList(document.getElementById('fd-q').value.trim())">Use “<b>${fdEsc(q)}</b>”</div>`+html;
  document.getElementById('fd-sg').innerHTML = html;
}
function fdPickList(name){ fdDoc[fdCtx.key][fdCtx.i]=name; fdSave(); renderFishDisplay(); fdClosePop(); }

function fdSaveCell(){
  const inp = document.getElementById('fd-q');
  if(!inp){ fdClosePop(); return; }
  const v = inp.value.trim();
  if(fdCtx.type==='num'){ if(!fdDoc.entries[fdCtx.id]) fdDoc.entries[fdCtx.id]={}; if(v==='') delete fdDoc.entries[fdCtx.id][fdCtx.field]; else fdDoc.entries[fdCtx.id][fdCtx.field]=v; if(!Object.keys(fdDoc.entries[fdCtx.id]).length) delete fdDoc.entries[fdCtx.id]; fdSave(); renderFishDisplay(); fdClosePop(); return; }
  if(fdCtx.type==='oyster'){ fdDoc.oyster=v; fdSave(); renderFishDisplay(); fdClosePop(); return; }
  if(fdCtx.type==='list'){ fdDoc[fdCtx.key][fdCtx.i]=v; fdSave(); renderFishDisplay(); fdClosePop(); return; }
  if(fdCtx.type==='item' || fdCtx.type==='newfish'){ if(!v){ fdClosePop(); return; } const exists = fdItems.some(i=>i.kind===fdCtx.kind && i.name.toLowerCase()===v.toLowerCase()); if(exists && fdCtx.type==='newfish') fdPick(v); else fdPickNew(); return; }
  fdClosePop();
}
function fdClearCell(){
  if(!fdCtx){ fdClosePop(); return; }
  if(fdCtx.type==='num'){ if(fdDoc.entries[fdCtx.id]){ delete fdDoc.entries[fdCtx.id][fdCtx.field]; if(!Object.keys(fdDoc.entries[fdCtx.id]).length) delete fdDoc.entries[fdCtx.id]; } fdSave(); }
  else if(fdCtx.type==='oyster'){ fdDoc.oyster=''; fdSave(); }
  else if(fdCtx.type==='list'){ fdDoc[fdCtx.key].splice(fdCtx.i,1); if(!fdDoc[fdCtx.key].length) fdDoc[fdCtx.key]=['']; fdSave(); }
  renderFishDisplay(); fdClosePop();
}

function fdDelList(key,i){ fdDoc[key].splice(i,1); if(!fdDoc[key].length) fdDoc[key]=['']; fdSave(); renderFishDisplay(); }
function fdAddBlank(){ fdDoc.blank_rows=(fdDoc.blank_rows||0)+1; fdSave(); renderFishDisplay(); }
function fdRemoveBlank(){ fdDoc.blank_rows=Math.max(0,(fdDoc.blank_rows||0)-1); fdSave(); renderFishDisplay(); }

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

document.addEventListener('keydown', function(e){
  const ov=document.getElementById('fd-ov'); if(!ov||!ov.classList.contains('show')) return;
  if(e.key==='Escape'){ e.preventDefault(); fdClosePop(); }
  else if(e.key==='Enter'){ e.preventDefault(); fdSaveCell(); }
});

// ══ styles (screen) ══════════════════════════════════════════════════════════
const FD_STYLE = `<style id="fd-style">
.fd-actions{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.fd-grid{display:flex;gap:20px;align-items:flex-start}
@media(max-width:820px){.fd-grid{flex-direction:column}}
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
.fd-name{position:relative;font-family:var(--font-serif);font-size:19px;color:var(--ink);padding:8px 10px;cursor:pointer;text-transform:capitalize}
.fd-row.set .fd-name{color:var(--vino);font-weight:600}
.fd-row.fd-cav .fd-name{font-size:16px}
.fd-name.empty.fd-writein-name{color:#c9a48a;font-style:italic;font-size:13px;font-family:var(--font-sans);text-transform:none}
.fd-cell{text-align:center;font-size:16px;font-weight:600;color:var(--ink);padding:8px 4px;border-left:1px solid var(--sabbia-dark);cursor:pointer}
.fd-cell.empty{color:var(--sabbia-dark)}
.fd-name:hover,.fd-cell:hover{background:var(--sabbia-light)}
.fd-del{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:20px;height:20px;line-height:18px;text-align:center;border-radius:50%;background:var(--sabbia-dark);color:var(--vino);font-size:15px;opacity:0;transition:opacity .12s}
.fd-row:hover .fd-del,.fd-lb-cell:hover .fd-del{opacity:1}.fd-del:hover{background:var(--vino);color:var(--cream)}
.fd-oyster{display:flex;justify-content:space-between;align-items:center;border:1.5px solid var(--vino);border-radius:4px;padding:8px 12px}
.fd-oyster span{font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:var(--vino-light)}
.fd-oyster b{font-family:var(--font-serif);font-size:22px;color:var(--vino);cursor:pointer;min-width:44px;text-align:right}
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
