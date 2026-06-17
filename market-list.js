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
let mlWeekStart = null;      // 'YYYY-MM-DD' Monday of current week
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
  mon.setDate(d.getDate() + diff);
  return mon.toISOString().slice(0,10);
}
function mlWeekdayToday(){
  const d = new Date(TODAY + 'T00:00:00');
  const dow = d.getDay();            // 0..6
  return dow === 0 ? null : dow;     // Sun -> null (closed); else 1..6 == Mon..Sat
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
async function loadMarketList(){
  mlWeekStart = mlComputeWeekStart();
  const { data: items } = await sb.from('order_items')
    .select('*').eq('active', true).order('sort_order');
  mlItems = items || [];
  await loadMarketQuantities();
}
async function loadMarketQuantities(){
  mlQty = {}; mlQtyMeta = {};
  const { data } = await sb.from('order_quantities')
    .select('*').eq('week_start', mlWeekStart);
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
  const qty = value === '' ? null : Number(value);
  if(qty === null || isNaN(qty) || qty <= 0){
    delete mlQty[k];
    await sb.from('order_quantities').delete()
      .eq('item_id', itemId).eq('week_start', mlWeekStart).eq('weekday', weekday);
  } else {
    mlQty[k] = qty;
    const row = { item_id:itemId, week_start:mlWeekStart, weekday:weekday, qty:qty,
                  updated_by:(window.CURRENT_USER||null), updated_at:new Date().toISOString() };
    const meta = mlQtyMeta[k];
    if(meta && meta.custom_name) row.custom_name = meta.custom_name;
    await sb.from('order_quantities').upsert(row, { onConflict:'item_id,week_start,weekday' });
  }
  mlRenderSummary();
}

// ── add a custom item (not on master list) ──
async function mlAddCustom(){
  const inp = document.getElementById('ml-custom-name');
  const name = (inp.value||'').trim();
  if(!name) return;
  const { data, error } = await sb.from('order_items')
    .insert({ name, category:'CUSTOM', unit:'', sort_order: 9000 + mlItems.filter(i=>i.category==='CUSTOM').length, active:true })
    .select().single();
  if(error){ alert('Could not add item: ' + error.message); return; }
  mlItems.push(data);
  inp.value='';
  mlSearch=''; const s=document.getElementById('ml-search'); if(s) s.value='';
  renderMarketList();
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
  return ML_CAT_ORDER.filter(c=>present.includes(c));
}
function mlOrderedCount(){
  const days = mlVisibleDays();
  let n=0;
  mlItems.forEach(it=>days.forEach(wd=>{ if(mlQty[it.id+'|'+wd]!=null) n++; }));
  return n;
}

// ── render ──
function renderMarketList(){
  const days = mlVisibleDays();
  const cats = ['<option value="">All categories</option>',
    ...mlCatsPresent().map(c=>`<option value="${c}"${c===mlCatFilter?' selected':''}>${c}</option>`)].join('');

  // day chips (hide/show) — only meaningful on full grid
  const dayChips = [1,2,3,4,5,6].map(wd=>{
    const hidden = mlHiddenDays.includes(wd);
    return `<button class="ml-daychip${hidden?' off':''}" onclick="mlToggleDayHidden(${wd})">${ML_DAYS[wd-1]}</button>`;
  }).join('');

  const todayWd = mlWeekdayToday();
  const isMobile = window.innerWidth < 760;

  document.getElementById('order-view').innerHTML = `
    <div class="ops-title">Market List</div>
    <div class="ops-subtitle">Week ${mlWeekLabel()} · shared live · Sun closed</div>

    <div class="ml-toolbar">
      <div class="ml-search-wrap">
        <input class="check-input" id="ml-search" placeholder="Type to find an item…" value="${mlSearch.replace(/"/g,'&quot;')}" oninput="mlOnSearch(this.value)">
      </div>
      <select class="check-select" id="ml-category" onchange="mlOnCat(this.value)">${cats}</select>
      <label class="ml-check"><input id="ml-only" type="checkbox" ${mlOrderedOnly?'checked':''} onchange="mlOnOnly(this.checked)"> Ordered only</label>
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

    <div class="ml-addcustom">
      <input class="check-input" id="ml-custom-name" placeholder="Item not on the list? Type its name…" onkeydown="if(event.key==='Enter')mlAddCustom()">
      <button class="report-btn" onclick="mlAddCustom()">Add item</button>
    </div>

    <button class="ml-top" id="ml-top" onclick="document.getElementById('order-view').scrollTo({top:0,behavior:'smooth'})" aria-label="Scroll to top">↑</button>
  `;

  // wire scroll-to-top visibility
  const ov = document.getElementById('order-view');
  ov.onscroll = ()=>{ const b=document.getElementById('ml-top'); if(b) b.style.display = ov.scrollTop>200?'flex':'none'; };

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
  if(!items.length){ c.innerHTML = `<div class="report-no-data">${mlOrderedOnly?'Nothing ordered for the shown days yet.':'No items match. Use “Add item” below for anything off-list.'}</div>`; return; }

  const cols = days.length;
  const todayWd = mlWeekdayToday();
  let html = `<div class="ml-table" style="--ml-cols:${cols}">`;
  // header
  html += `<div class="ml-row ml-head"><div class="ml-cell-name">Item</div>${days.map(wd=>`<div class="ml-cell-day${wd===todayWd?' today':''}">${ML_DAYS[wd-1]}</div>`).join('')}</div>`;

  let curCat = null;
  items.forEach(it=>{
    if(it.category !== curCat){
      curCat = it.category;
      html += `<div class="ml-cat" id="ml-cat-${curCat.replace(/[^a-z0-9]/gi,'_')}">${curCat}</div>`;
    }
    html += `<div class="ml-row">
      <div class="ml-cell-name"><div class="ml-name">${it.name}</div><div class="ml-unit">${it.unit||''}</div></div>
      ${days.map(wd=>{
        const k = it.id+'|'+wd;
        const v = mlQty[k]; const has = v!=null;
        return `<div class="ml-cell-day${wd===todayWd?' today':''}">
          <input class="ml-qty${has?' filled':''}" id="mlq-${k}" type="number" min="0" step="0.1" inputmode="decimal" value="${has?v:''}" placeholder="·" onchange="mlSetQty(${it.id},${wd},this.value)">
        </div>`;
      }).join('')}
    </div>`;
  });
  html += `</div>`;
  c.innerHTML = html;
}

// update a single cell after realtime without full re-render
function mlUpdateCellUI(k){
  const inp = document.getElementById('mlq-'+k);
  if(!inp) return;
  const v = mlQty[k];
  if(v==null){ inp.value=''; inp.classList.remove('filled'); }
  else { inp.value = v; inp.classList.add('filled'); }
}

// ── toolbar handlers ──
let mlSearchTimer=null;
function mlOnSearch(v){ mlSearch=v; clearTimeout(mlSearchTimer); mlSearchTimer=setTimeout(()=>mlRenderRows(mlVisibleDays()),120); }
function mlOnCat(v){ mlCatFilter=v; mlRenderRows(mlVisibleDays()); }
function mlOnOnly(v){ mlOrderedOnly=v; mlRenderRows(mlVisibleDays()); mlRenderSummary(); }
function mlPickDay(wd){ mlActiveDay=Number(wd); renderMarketList(); }

// ── open / entry point ──
async function openMarketList(){
  activeStation = ORDER_KEY;
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
