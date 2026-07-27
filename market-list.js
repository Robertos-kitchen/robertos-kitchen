// ══════════════════════════════════════════════════════
// MARKET LIST MODULE
// Weekly shared order list (Mon–Sat), realtime, Supabase-backed.
// Reads order_items (master, seeded) + order_quantities (shared, per week).
// Replaces the old localStorage/price-based Order Inventory.
// ══════════════════════════════════════════════════════

const ML_DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat']; // weekday 1..6
const ML_HIDE_KEY = 'robertos-ml-hidden-days';          // per-device view pref
const ML_CAT_ORDER = ['BEEF','POULTRY','LAMB','VEAL','SEAFOOD','CHARCUTIERE','DAIRY','EGG','TRUFFLE','FRUIT FROZEN','BUTTER & CHEESE','VEGETABLE FROZEN','PASTRY','OIL & COOKING OIL','DRY GOODS','FRUIT FRESH','HERBS','VEGETABLES','CUSTOM'];

let mlItems = [];            // [{id,name,category,unit,sort_order,active}]
let mlQty = {};              // key `${item_id}|${weekday}` -> qty (number)
let mlQtyMeta = {};          // same key -> {custom_name}
let mlWeekStart = null;      // 'YYYY-MM-DD' Monday of the currently-viewed week
let mlWeekOffset = 0;        // weeks ahead of the current service week (0 = this week, 1 = next week…)
let mlChannel = null;
let mlOrderedOnly = false;
let mlActiveDay = null;      // mobile day-switcher (1..6); null = full grid (tablet)
let mlSearch = '';
let mlCatFilter = '';
let mlHiddenDays = [];       // array of weekday ints hidden on this device

// ── week math: Monday of the current service week (06:00 Dubai boundary) ──
function mlComputeWeekStart(){
  // TODAY is the app's service date 'YYYY-MM-DD' (already 06:00-boundary adjusted).
  const d = new Date(TODAY + 'T00:00:00');
  let dow = d.getDay();              // 0=Sun..6=Sat
  // Map to Monday-start. If Sunday(0), treat as the upcoming Monday (venue closed Sun).
  let diff = (dow === 0) ? 1 : (1 - dow);
  const mon = new Date(d);
  mon.setDate(d.getDate() + diff + (mlWeekOffset * 7));   // shift by the chosen week offset
  // format from LOCAL parts — .toISOString() would convert to UTC and, east of GMT
  // (Dubai UTC+4), roll the date back a day, shifting every weekday label by one.
  const pad = n => String(n).padStart(2,'0');
  return mon.getFullYear() + '-' + pad(mon.getMonth()+1) + '-' + pad(mon.getDate());
}
function mlWeekdayToday(){
  if(mlWeekOffset !== 0) return null;  // "today" only exists when viewing the current week
  const d = new Date(TODAY + 'T00:00:00');
  const dow = d.getDay();            // 0..6
  return dow === 0 ? null : dow;     // Sun -> null (closed); else 1..6 == Mon..Sat
}
// Navigate between weeks (this week .. 6 weeks ahead). Lets the team pre-order the
// new week before the service date rolls into it (e.g. order Mon 22nd on Fri 19th).
function mlChangeWeek(delta){
  mlWeekOffset = Math.max(0, Math.min(6, mlWeekOffset + Number(delta)));
  loadMarketList().then(function(){
    subscribeMarketList();                       // re-bind realtime to the new week
    if(activeStation === ORDER_KEY) renderMarketList();
  });
}
function mlWeekLabel(){
  const mon = new Date(mlWeekStart + 'T00:00:00');
  const sat = new Date(mon); sat.setDate(mon.getDate()+5);
  const fmt = dt => dt.toLocaleDateString('en-GB',{day:'numeric',month:'short'});
  return `${fmt(mon)} – ${fmt(sat)}`;
}
function mlDateForWeekday(wd){
  const mon = new Date(mlWeekStart + 'T00:00:00');
  const dt = new Date(mon); dt.setDate(mon.getDate() + (wd-1));
  return dt.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'});
}

// ── hidden-days pref (per device) ──
function mlLoadHidden(){
  try{ mlHiddenDays = JSON.parse(localStorage.getItem(ML_HIDE_KEY)||'[]'); }
  catch(e){ mlHiddenDays = []; }
}
function mlSaveHidden(){ localStorage.setItem(ML_HIDE_KEY, JSON.stringify(mlHiddenDays)); }
function mlToggleDayHidden(wd){
  wd = Number(wd);
  if(mlHiddenDays.includes(wd)) mlHiddenDays = mlHiddenDays.filter(x=>x!==wd);
  else mlHiddenDays.push(wd);
  mlSaveHidden();
  renderMarketList();
}
function mlVisibleDays(){
  if(mlActiveDay) return [mlActiveDay];               // mobile: single day
  return [1,2,3,4,5,6].filter(wd=>!mlHiddenDays.includes(wd));
}

// ── data load ──
// Page a select so the 1000-row PostgREST cap can't silently drop items or a
// busy week's quantity cells (438 items x 6 days can exceed 1000 filled rows).
async function mlFetchAllPaged(build){
  var all=[], from=0, size=1000;
  for(;;){
    var r=await build().range(from, from+size-1);
    if(r.error){ if(typeof kToast==='function') kToast('Could not load the full list — check connection.', true); return all; }
    var rows=r.data||[]; all=all.concat(rows);
    if(rows.length<size) break;
    from+=size;
  }
  return all;
}
async function loadMarketList(){
  mlWeekStart = mlComputeWeekStart();
  mlItems = await mlFetchAllPaged(function(){ return sb.from('order_items').select('*').eq('active', true).order('sort_order'); });
  await loadMarketQuantities();
}
async function loadMarketQuantities(){
  mlQty = {}; mlQtyMeta = {};
  const data = await mlFetchAllPaged(function(){ return sb.from('order_quantities').select('*').eq('week_start', mlWeekStart); });
  (data||[]).forEach(r=>{
    const k = r.item_id + '|' + r.weekday;
    mlQty[k] = r.qty;
    if(r.custom_name) mlQtyMeta[k] = { custom_name: r.custom_name };
  });
}

// ── realtime ──
function subscribeMarketList(){
  if(mlChannel){ sb.removeChannel(mlChannel); mlChannel = null; }
  mlChannel = sb.channel('market_list_changes')
    .on('postgres_changes', { event:'*', schema:'public', table:'order_quantities', filter:`week_start=eq.${mlWeekStart}` },
      payload => {
        const r = payload.new || payload.old; if(!r) return;
        const k = r.item_id + '|' + r.weekday;
        if(payload.eventType === 'DELETE'){ delete mlQty[k]; delete mlQtyMeta[k]; }
        else { mlQty[k] = r.qty; if(r.custom_name) mlQtyMeta[k]={custom_name:r.custom_name}; }
        if(activeStation === ORDER_KEY){ mlUpdateCellUI(k); mlRenderSummary(); }
        flashSync();
      })
    .on('postgres_changes', { event:'*', schema:'public', table:'order_items' },
      payload => {
        if(activeStation === ORDER_KEY){
          loadMarketList().then(()=>{ if(activeStation===ORDER_KEY) renderMarketList(); });
        }
      })
    .subscribe(status=>{
      const dot=document.getElementById('realtime-dot');
      if(dot) dot.classList.toggle('live', status==='SUBSCRIBED');
    });
}

// ── write a single cell (upsert / delete on empty) ──
async function mlSetQty(itemId, weekday, value){
  const k = itemId + '|' + weekday;
  const had = (mlQty[k] != null);
  const prev = mlQty[k];
  const qty = value === '' ? null : Number(value);
  let res;
  if(qty === null || isNaN(qty) || qty <= 0){
    delete mlQty[k];
    res = await sb.from('order_quantities').delete()
      .eq('item_id', itemId).eq('week_start', mlWeekStart).eq('weekday', weekday);
  } else {
    mlQty[k] = qty;
    const row = { item_id:itemId, week_start:mlWeekStart, weekday:weekday, qty:qty,
                  updated_by:(window.CURRENT_USER||null), updated_at:new Date().toISOString() };
    const meta = mlQtyMeta[k];
    if(meta && meta.custom_name) row.custom_name = meta.custom_name;
    res = await sb.from('order_quantities').upsert(row, { onConflict:'item_id,week_start,weekday' });
  }
  if(res && res.error){
    // Write didn't reach the server — put the cell back to what it was so the
    // grid never shows an order the database doesn't actually have.
    if(had) mlQty[k] = prev; else delete mlQty[k];
    console.warn('order_quantities save failed', res.error);
  }
  mlRenderSummary();
  return res || {};
}

// ── add a custom item (not on master list) ──
async function mlAddCustom(category, safe){
  const inp = document.getElementById('mladd-' + safe);
  if(!inp) return;
  const name = (inp.value||'').trim();
  if(!name) return;
  // sort it just after the last existing item in this category
  const inCat = mlItems.filter(i=>i.category===category);
  const maxSort = inCat.length ? Math.max(...inCat.map(i=>i.sort_order||0)) : 0;
  const { data, error } = await sb.from('order_items')
    .insert({ name, category, unit:'', sort_order: maxSort + 1, active:true })
    .select().single();
  if(error){ alert('Could not add item: ' + error.message); return; }
  data.custom = true;
  mlItems.push(data);
  mlItems.sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));
  inp.value='';
  mlRenderRows(mlVisibleDays());
  mlRenderSummary();
  // keep focus flowing: re-focus the same category's add box
  const again = document.getElementById('mladd-' + safe);
  if(again) again.focus();
}

// ── filtered rows ──
function mlFilteredItems(){
  const q = mlSearch.toLowerCase();
  return mlItems.filter(it=>{
    if(mlCatFilter && it.category !== mlCatFilter) return false;
    if(q && !it.name.toLowerCase().includes(q) && !it.category.toLowerCase().includes(q)) return false;
    if(mlOrderedOnly){
      const days = mlVisibleDays();
      const has = days.some(wd => mlQty[it.id+'|'+wd] != null);
      if(!has) return false;
    }
    return true;
  });
}
function mlCatsPresent(){
  const present = [...new Set(mlItems.map(i=>i.category))];
  const known = ML_CAT_ORDER.filter(c=>present.includes(c));
  // A category saved on an item but missing from ML_CAT_ORDER must still show up
  // (and stay orderable) instead of silently disappearing — append it, sorted.
  const unknown = present.filter(c=>!ML_CAT_ORDER.includes(c)).sort();
  return known.concat(unknown);
}
function mlOrderedCount(){
  const days = mlVisibleDays();
  let n=0;
  mlItems.forEach(it=>days.forEach(wd=>{ if(mlQty[it.id+'|'+wd]!=null) n++; }));
  return n;
}

// ── render ──
function renderMarketList(){
  const ov = document.getElementById('order-view');
  const savedScroll = ov ? ov.scrollTop : 0;
  const days = mlVisibleDays();
  const cats = ['<option value="">All categories</option>',
    ...mlCatsPresent().map(c=>`<option value="${c}"${c===mlCatFilter?' selected':''}>${c}</option>`)].join('');

  // day chips (hide/show) — only meaningful on full grid
  const dayChips = [1,2,3,4,5,6].map(wd=>{
    const hidden = mlHiddenDays.includes(wd);
    return `<button class="ml-daychip${hidden?' off':''}" onclick="mlToggleDayHidden(${wd})">${ML_DAYS[wd-1]}<span class="ml-daychip-date">${mlDateForWeekday(wd).split(' ').slice(1).join(' ')}</span></button>`;
  }).join('');

  const todayWd = mlWeekdayToday();
  const isMobile = window.innerWidth < 760;

  document.getElementById('order-view').innerHTML = `
    <div class="ops-title">Market List</div>
    <div class="ops-subtitle" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      <button onclick="mlChangeWeek(-1)" ${mlWeekOffset<=0?'disabled':''} style="border:1px solid #c9a84c;background:#fff;color:#410207;border-radius:6px;min-width:28px;height:26px;font-size:16px;line-height:1;cursor:pointer;${mlWeekOffset<=0?'opacity:.3;cursor:default;':''}" aria-label="Previous week">&lsaquo;</button>
      <b>Week ${mlWeekLabel()}</b>
      <span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:9px;${mlWeekOffset===0?'background:#ece3d3;color:#7a6a45;':'background:#410207;color:#fff;'}">${mlWeekOffset===0?'this week':(mlWeekOffset===1?'next week':'+'+mlWeekOffset+' weeks')}</span>
      <button onclick="mlChangeWeek(1)" style="border:1px solid #c9a84c;background:#fff;color:#410207;border-radius:6px;min-width:28px;height:26px;font-size:16px;line-height:1;cursor:pointer;" aria-label="Next week">&rsaquo;</button>
      <span style="color:#8a7a55;font-size:12px;">· shared live · tap an item to set quantities</span>
    </div>

    <div class="ml-toolbar">
      <div class="ml-search-wrap">
        <input class="check-input" id="ml-search" placeholder="Type to find an item…" value="${mlSearch.replace(/"/g,'&quot;')}" oninput="mlOnSearch(this.value)">
      </div>
      <select class="check-select" id="ml-category" onchange="mlOnCat(this.value)">${cats}</select>
      <label class="ml-check"><input id="ml-only" type="checkbox" ${mlOrderedOnly?'checked':''} onchange="mlOnOnly(this.checked)"> Ordered only</label>
      <div class="ml-actions">
        <button class="report-btn" onclick="mlPrint()">Print</button>
        <button class="report-btn" onclick="mlEmailPrompt()">Email chefs</button>
      </div>
    </div>

    ${isMobile ? `
      <div class="ml-dayswitch">
        ${[1,2,3,4,5,6].map(wd=>`<button class="ml-dayswitch-btn${(mlActiveDay||todayWd||1)===wd?' active':''}" onclick="mlPickDay(${wd})">${ML_DAYS[wd-1]}${wd===todayWd?' •':''}</button>`).join('')}
      </div>` : `
      <div class="ml-dayhide">
        <span class="ml-dayhide-label">Show days:</span> ${dayChips}
      </div>`}

    <div id="ml-summary"></div>
    <div id="ml-content"></div>

    <button class="ml-top" id="ml-top" onclick="document.getElementById('order-view').scrollTo({top:0,behavior:'smooth'})" aria-label="Scroll to top">↑</button>
  `;

  // wire scroll-to-top visibility and restore scroll position
  const ovAfter = document.getElementById('order-view');
  if(ovAfter){
    ovAfter.onscroll = ()=>{ const b=document.getElementById('ml-top'); if(b) b.style.display = ovAfter.scrollTop>200?'flex':'none'; };
    ovAfter.scrollTop = savedScroll;
  }

  mlRenderRows(days);
  mlRenderSummary();
}

function mlRenderSummary(){
  const el = document.getElementById('ml-summary'); if(!el) return;
  const days = mlVisibleDays();
  el.innerHTML = `
    <div class="ops-grid ml-grid">
      <div class="ops-card dark"><div class="ops-num">${mlOrderedCount()}</div><div class="ops-label">Lines ordered (${mlActiveDay?ML_DAYS[mlActiveDay-1]:'shown days'})</div></div>
      <div class="ops-card"><div class="ops-num">${mlItems.length}</div><div class="ops-label">Market list items</div></div>
      <div class="ops-card"><div class="ops-num">${days.length}</div><div class="ops-label">Days shown</div></div>
    </div>`;
}

function mlRenderRows(days){
  const items = mlFilteredItems();
  const c = document.getElementById('ml-content'); if(!c) return;

  const cols = days.length;
  const todayWd = mlWeekdayToday();
  let html = `<div class="ml-table" style="--ml-cols:${cols}">`;
  // header
  html += `<div class="ml-row ml-head"><div class="ml-cell-name">Item</div>${days.map(wd=>`<div class="ml-cell-day${wd===todayWd?' today':''}">${ML_DAYS[wd-1]}<span class="ml-cell-day-date">${mlDateForWeekday(wd).split(' ').slice(1).join(' ')}</span></div>`).join('')}</div>`;

  // group items by category, preserving ML_CAT_ORDER
  const present = mlCatsPresent();
  // when searching/ordered-only, only show categories that have matching items;
  // when browsing the full list, show every present category (so its add box is reachable)
  const filtering = !!(mlSearch || mlCatFilter || mlOrderedOnly);
  const byCat = {};
  items.forEach(it=>{ (byCat[it.category]=byCat[it.category]||[]).push(it); });

  let any = false;
  present.forEach(cat=>{
    const rows = byCat[cat] || [];
    if(filtering && rows.length===0) return;   // hide empty cats while filtering
    if(mlCatFilter && cat!==mlCatFilter) return;
    any = true;
    const safe = cat.replace(/[^a-z0-9]/gi,'_');
    html += `<div class="ml-cat" id="ml-cat-${safe}">${cat}</div>`;
    rows.forEach(it=>{
      html += `<div class="ml-row ml-row-tap" onclick="mlOpenEditor(${it.id})">
        <div class="ml-cell-name"><div class="ml-name">${it.name}${it.category==='CUSTOM'||it.custom?'':''}</div><div class="ml-unit">${it.unit||''}</div></div>
        ${days.map(wd=>{
          const k = it.id+'|'+wd;
          const v = mlQty[k]; const has = v!=null;
          return `<div class="ml-cell-day${wd===todayWd?' today':''}">
            <div class="ml-qty${has?' filled':''}" id="mlq-${k}" data-item="${it.id}" data-wd="${wd}">${has?v:'·'}</div>
          </div>`;
        }).join('')}
      </div>`;
    });
    // per-category add box (hidden while ordered-only, to keep the chef view clean)
    if(!mlOrderedOnly){
      html += `<div class="ml-catadd">
        <input class="check-input ml-catadd-input" id="mladd-${safe}" placeholder="Add item to ${cat}…" onkeydown="if(event.key==='Enter')mlAddCustom('${cat.replace(/'/g,"\\'")}','${safe}')">
        <button class="ml-catadd-btn" onclick="mlAddCustom('${cat.replace(/'/g,"\\'")}','${safe}')">Add</button>
      </div>`;
    }
  });
  html += `</div>`;

  if(!any){ c.innerHTML = `<div class="report-no-data">${mlOrderedOnly?'Nothing ordered for the shown days yet.':'No items match your search.'}</div>`; return; }
  c.innerHTML = html;
}

// ── EDIT POPUP: tap an item's name OR any of its cells to open ──
// Shows all 6 days for that item with steppers + a number field per day.
// Local edits buffer in mlEditBuf; "Save" writes every changed day via mlSetQty.
let mlEditItemId = null;
let mlEditBuf = {};   // weekday -> value (string)

function mlOpenEditor(itemId){
  const it = mlItems.find(x=>x.id===itemId);
  if(!it) return;
  mlEditItemId = itemId;
  mlEditBuf = {};
  const editDays = mlVisibleDays();   // match what's shown in the grid (1 day on phone / single-day mode, else the shown days)
  editDays.forEach(wd=>{
    const v = mlQty[itemId+'|'+wd];
    mlEditBuf[wd] = (v!=null) ? String(v) : '';
  });
  const todayWd = mlWeekdayToday();
  const old = document.getElementById('ml-editor'); if(old) old.remove();

  const single = editDays.length === 1;
  const dayRows = editDays.map(wd=>{
    const isToday = wd===todayWd;
    const val = mlEditBuf[wd];
    const has = val!=='' && Number(val)>0;
    return `<div class="ml-ed-row${has?' has-qty':''}${single?' ml-ed-single':''}" id="ml-ed-row-${wd}">
      <div class="ml-ed-day">${single?mlDateForWeekday(wd):ML_DAYS[wd-1]}${isToday?'<span class="ml-ed-today">today</span>':''}</div>
      <div class="ml-ed-stepper">
        <button type="button" class="ml-ed-step" onclick="mlEdBump(${wd},-1)" aria-label="decrease">−</button>
        <input class="ml-ed-input" id="ml-ed-q${wd}" type="number" min="0" step="0.1" inputmode="decimal"
               value="${has?val:''}" placeholder="0" oninput="mlEdInput(${wd},this.value)">
        <button type="button" class="ml-ed-step" onclick="mlEdBump(${wd},1)" aria-label="increase">+</button>
      </div>
      <button type="button" class="ml-ed-clear" onclick="mlEdClear(${wd})">clear</button>
    </div>`;
  }).join('');

  const box = document.createElement('div');
  box.className = 'ml-daypick-overlay';
  box.id = 'ml-editor';
  box.innerHTML = `
    <div class="ml-ed-modal" onclick="event.stopPropagation()">
      <div class="ml-ed-head">
        <div class="ml-ed-cat">${it.category}</div>
        <div class="ml-ed-name">${it.name}</div>
        ${it.unit?`<div class="ml-ed-unit">${it.unit}</div>`:''}
      </div>
      <div class="ml-ed-body">${dayRows}</div>
      <div class="ml-ed-foot">
        <button type="button" class="ml-ed-btn ml-ed-cancel" onclick="mlCloseEditor()">Cancel</button>
        <button type="button" class="ml-ed-btn ml-ed-save" onclick="mlSaveEditor()">Save</button>
      </div>
    </div>`;
  box.addEventListener('click', mlCloseEditor); // click backdrop closes
  document.body.appendChild(box);
  setTimeout(()=>{ const f=document.getElementById('ml-ed-q1'); if(f) f.focus(); }, 60);
}

function mlEdRowToggle(wd){
  const has = mlEditBuf[wd]!=='' && Number(mlEditBuf[wd])>0;
  const row = document.getElementById('ml-ed-row-'+wd);
  if(row) row.classList.toggle('has-qty', has);
}
function mlEdInput(wd, v){ mlEditBuf[wd] = v; mlEdRowToggle(wd); }
function mlEdBump(wd, n){
  const cur = Number(mlEditBuf[wd]) || 0;
  const next = Math.max(0, Math.round((cur + n)*10)/10);
  mlEditBuf[wd] = next>0 ? String(next) : '';
  const inp = document.getElementById('ml-ed-q'+wd);
  if(inp) inp.value = mlEditBuf[wd];
  mlEdRowToggle(wd);
}
function mlEdClear(wd){
  mlEditBuf[wd] = '';
  const inp = document.getElementById('ml-ed-q'+wd);
  if(inp) inp.value = '';
  mlEdRowToggle(wd);
}
async function mlSaveEditor(){
  const id = mlEditItemId;
  if(id==null){ mlCloseEditor(); return; }
  const writes = [];
  Object.keys(mlEditBuf).forEach(wd=>{
    const newVal = mlEditBuf[wd]==='' ? '' : String(Number(mlEditBuf[wd]));
    const oldVal = mlQty[id+'|'+wd]!=null ? String(mlQty[id+'|'+wd]) : '';
    if(newVal !== oldVal){ writes.push(mlSetQty(id, Number(wd), mlEditBuf[wd])); }
  });
  const results = await Promise.all(writes);
  const failed = results.filter(r=>r && r.error).length;
  if(failed){
    // Some quantities didn't save — mlSetQty already put those cells back to
    // their old value. Keep the editor open so the chef can just tap Save again.
    mlRenderSummary();
    const msg = failed===1 ? 'One quantity did NOT save — check the connection and tap Save again.'
                           : failed+' quantities did NOT save — check the connection and tap Save again.';
    if(typeof kToast==='function') kToast(msg, true); else alert(msg);
    return;
  }
  mlCloseEditor();
  mlRenderRows(mlVisibleDays());   // refresh grid cells with new values
  mlRenderSummary();
}
function mlCloseEditor(){
  const el = document.getElementById('ml-editor'); if(el) el.remove();
  mlEditItemId = null; mlEditBuf = {};
}

// update a single cell after realtime without full re-render
function mlUpdateCellUI(k){
  const cell = document.getElementById('mlq-'+k);
  if(!cell) return;
  const v = mlQty[k];
  if(v==null){ cell.textContent='·'; cell.classList.remove('filled'); }
  else { cell.textContent = v; cell.classList.add('filled'); }
}

// ── toolbar handlers ──
let mlSearchTimer=null;
function mlOnSearch(v){ mlSearch=v; clearTimeout(mlSearchTimer); mlSearchTimer=setTimeout(()=>mlRenderRows(mlVisibleDays()),120); }
function mlOnCat(v){ mlCatFilter=v; mlRenderRows(mlVisibleDays()); }
function mlOnOnly(v){ mlOrderedOnly=v; mlRenderRows(mlVisibleDays()); mlRenderSummary(); }
function mlPickDay(wd){ mlActiveDay=Number(wd); renderMarketList(); }

// ── consolidated order for a given weekday: [{category, items:[{name,unit,qty}]}] ──
function mlConsolidate(weekday){
  const groups = [];
  let cur = null;
  mlItems.forEach(it=>{
    const v = mlQty[it.id+'|'+weekday];
    if(v==null) return;
    if(!cur || cur.category !== it.category){ cur = {category:it.category, items:[]}; groups.push(cur); }
    cur.items.push({ name:it.name, unit:it.unit||'', qty:v });
  });
  return groups;
}
function mlDayHasOrders(weekday){
  return mlItems.some(it=>mlQty[it.id+'|'+weekday]!=null);
}

// ── day picker (used by both print and email) ──
function mlAskDay(action, cb){
  const wd = mlActiveDay; // if in single-day mode, use it directly
  if(wd){ cb(wd); return; }
  // build a small inline picker
  const existing = document.getElementById('ml-daypick'); if(existing) existing.remove();
  const todayWd = mlWeekdayToday();
  const wrap = document.createElement('div');
  wrap.id = 'ml-daypick';
  wrap.className = 'ml-daypick-overlay';
  wrap.innerHTML = `<div class="ml-daypick-box">
    <div class="ml-daypick-title">${action}: which day?</div>
    <div class="ml-daypick-btns">
      ${[1,2,3,4,5,6].map(d=>`<button class="ml-daypick-btn${d===todayWd?' today':''}${mlDayHasOrders(d)?'':' empty'}" onclick="mlDayPicked(${d})">${ML_DAYS[d-1]}<span class="ml-daypick-date">${mlDateForWeekday(d).split(' ').slice(1).join(' ')}</span>${mlDayHasOrders(d)?'':'<span class="ml-daypick-none">empty</span>'}</button>`).join('')}
    </div>
    <button class="ml-daypick-cancel" onclick="document.getElementById('ml-daypick').remove()">Cancel</button>
  </div>`;
  document.getElementById('order-view').appendChild(wrap);
  mlDayPickCb = cb;
}
let mlDayPickCb = null;
function mlDayPicked(wd){
  const ov = document.getElementById('ml-daypick'); if(ov) ov.remove();
  if(mlDayPickCb){ const cb = mlDayPickCb; mlDayPickCb = null; cb(wd); }
}

// ── build printable / email HTML for one day ──
function mlOrderHtml(weekday){
  const groups = mlConsolidate(weekday);
  const dateLabel = mlDateForWeekday(weekday);
  const lineCount = groups.reduce((n,g)=>n+g.items.length,0);
  const body = groups.length ? groups.map(g=>`
    <tr><td colspan="3" style="background:#410207;color:#f5ede0;font-size:11px;letter-spacing:1.5px;padding:7px 10px;text-transform:uppercase">${g.category}</td></tr>
    ${g.items.map(it=>`<tr>
      <td style="padding:7px 10px;border-bottom:1px solid #cfc0ad;width:90px;font-weight:bold;color:#410207">${it.qty}${it.unit?(' '+it.unit):''}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #cfc0ad">${it.name}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #cfc0ad;width:80px"></td>
    </tr>`).join('')}
  `).join('') : `<tr><td colspan="3" style="padding:20px;text-align:center;color:#7a1218">No items ordered for ${dateLabel}.</td></tr>`;
  return {
    lineCount,
    dateLabel,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#2a1a10;max-width:640px">
      <h1 style="font-family:Georgia,serif;color:#410207;margin:0 0 2px">Roberto's — Market Order</h1>
      <div style="font-size:13px;color:#7a1218;margin-bottom:14px">${dateLabel} · ${lineCount} line${lineCount===1?'':'s'} · week ${mlWeekLabel()}</div>
      <table style="border-collapse:collapse;width:100%;font-size:13px"><tbody>${body}</tbody></table>
      <div style="font-size:11px;color:#999;margin-top:14px">Sent from Roberto's Kitchen App · key into FMC by item name</div>
    </div>`
  };
}

// ── print ──
function mlPrint(){
  mlAskDay('Print', wd=>{
    const out = mlOrderHtml(wd);
    if(!out.lineCount){ alert('Nothing ordered for '+out.dateLabel+'.'); return; }
    const w = window.open('','_blank');
    if(!w){ alert('Pop-up blocked — allow pop-ups to print.'); return; }
    w.document.write(`<html><head><title>Roberto's Market Order — ${out.dateLabel}</title></head><body style="margin:28px">${out.html}</body></html>`);
    w.document.close(); w.focus(); setTimeout(()=>w.print(),250);
  });
}

// ── email chefs via Resend edge function ──
function mlEmailPrompt(){
  mlAskDay('Email chefs', async wd=>{
    const out = mlOrderHtml(wd);
    if(!out.lineCount){ alert('Nothing ordered for '+out.dateLabel+' — fill some quantities first.'); return; }
    const status = document.createElement('div');
    status.className = 'ml-email-status'; status.textContent = 'Sending to Danilo & Antonio…';
    document.getElementById('order-view').appendChild(status);
    try {
      const r = await fetch(SUPABASE_URL + '/functions/v1/send-market-order', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+SUPABASE_KEY },
        body: JSON.stringify({
          subject: `Market Order — ${out.dateLabel}`,
          html: out.html
        })
      });
      const data = await r.json().catch(()=>({}));
      if(r.ok){ status.textContent = '✓ Emailed to Danilo & Antonio'; status.classList.add('ok'); }
      else { status.textContent = '✕ Send failed: ' + (data.error||r.status); status.classList.add('err'); }
    } catch(e){
      status.textContent = '✕ Send failed: ' + e.message; status.classList.add('err');
    }
    setTimeout(()=>status.remove(), 4000);
  });
}

// ── open / entry point ──
async function openMarketList(){
  activeStation = ORDER_KEY;
  mlWeekOffset = 0;           // always open on the current week
  hideAllPages();
  document.getElementById('order-view').style.display='block';
  document.querySelector('.footer-bar').style.display='flex';
  document.getElementById('foot-label').textContent='Market List';
  // mobile defaults to today's day (or Monday if Sunday/closed)
  if(window.innerWidth < 760 && !mlActiveDay) mlActiveDay = mlWeekdayToday() || 1;
  if(window.innerWidth >= 760) mlActiveDay = null;
  mlLoadHidden();
  await loadMarketList();
  subscribeMarketList();
  renderMarketList();
}

// ── keyboard handling for the edit popup (Esc closes, Enter saves) ──
document.addEventListener('keydown', function(e){
  if(!document.getElementById('ml-editor')) return;
  if(e.key === 'Escape'){ e.preventDefault(); mlCloseEditor(); }
  else if(e.key === 'Enter'){ e.preventDefault(); mlSaveEditor(); }
});
