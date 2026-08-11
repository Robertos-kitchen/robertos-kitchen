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
// Takes the offset as an argument rather than reading mlWeekOffset, so a caller
// that needs a week OTHER than the one on screen — the orphan guard needs this
// week's Monday while the chef may be looking at week +3 — gets it without
// assigning to the global and putting it back, which would leave the wrong week
// loaded if anything in between threw.
function mlWeekStartFor(offset){
  // TODAY is the app's service date 'YYYY-MM-DD' (already 06:00-boundary adjusted).
  const d = new Date(TODAY + 'T00:00:00');
  let dow = d.getDay();              // 0=Sun..6=Sat
  // Map to Monday-start. If Sunday(0), treat as the upcoming Monday (venue closed Sun).
  let diff = (dow === 0) ? 1 : (1 - dow);
  const mon = new Date(d);
  mon.setDate(d.getDate() + diff + (Number(offset||0) * 7));
  // format from LOCAL parts — .toISOString() would convert to UTC and, east of GMT
  // (Dubai UTC+4), roll the date back a day, shifting every weekday label by one.
  const pad = n => String(n).padStart(2,'0');
  return mon.getFullYear() + '-' + pad(mon.getMonth()+1) + '-' + pad(mon.getDate());
}
function mlComputeWeekStart(){ return mlWeekStartFor(mlWeekOffset); }
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
  await Promise.all([loadMarketQuantities(), loadFmcPrices(), loadRequisitions()]);
}

// ── what the order is worth, and what it became in Materials Control ───────
// Both read their table. Neither keeps a copy of a number that lives in the
// database, so a price change or a new requisition shows up here by itself.
const ML_VENUE = 'robertos-difc';
let mlPrices = {};   // FMC article code -> contract price
let mlReqs   = [];   // fmc_requisitions rows for this week, newest first

// The value is worked out from fmc_articles.price - FMC's own contract price,
// harvested off the assortment. It is INDICATIVE and says so on screen: the
// prices are a snapshot, and any line whose article has no price yet is
// counted separately rather than quietly left out. On Monday 10 Aug 2026 seven
// of sixty-eight lines had no price, worth 1,919.96 at FMC's own figures - a
// total that dropped them without a word would have read 8,206 for an order
// really worth 10,126, and nothing on screen would have said so.
async function loadFmcPrices(){
  mlPrices = {};
  const rows = await mlFetchAllPaged(function(){
    return sb.from('fmc_articles').select('code,price').eq('venue_id', ML_VENUE);
  });
  (rows||[]).forEach(r=>{
    if(r.code && r.price != null) mlPrices[String(r.code).trim()] = Number(r.price);
  });
}

// Append-only ledger: a requisition that was created and later deleted in FMC
// has two rows, so the newest row for a number is its current state. Written
// only by the FMC helper - this app never writes here.
async function loadRequisitions(){
  mlReqs = [];
  const r = await sb.from('fmc_requisitions').select('*')
    .eq('venue_id', ML_VENUE).eq('week_start', mlWeekStart)
    .order('id', { ascending:false });
  if(r.error){ console.warn('fmc_requisitions load failed', r.error); return; }
  mlReqs = r.data || [];
}

function mlMoney(n){
  return Number(n||0).toLocaleString('en-GB', { maximumFractionDigits:0 });
}

function mlOrderValue(days){
  let total=0, priced=0, unpriced=0;
  mlItems.forEach(it=>{
    const code = (it.code||'').trim();
    const price = code ? mlPrices[code] : undefined;
    days.forEach(wd=>{
      const qty = Number(mlQty[it.id+'|'+wd]);
      if(!qty) return;
      if(price == null){ unpriced++; return; }
      total += qty * price; priced++;
    });
  });
  return { total, priced, unpriced };
}

// The newest row per requisition number, for the days on screen.
function mlReqsForDays(days){
  const latest = {};
  mlReqs.forEach(r=>{ if(!latest[r.requisition_no]) latest[r.requisition_no] = r; });
  return Object.keys(latest).map(k=>latest[k])
    .filter(r=>days.indexOf(r.weekday) !== -1)
    .sort((a,b)=>a.weekday-b.weekday);
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

// ══════════════════════════════════════════════════════════════════════════
// THE FMC ARTICLE CATALOGUE
//
// ⛔ NEVER MATCH AN ORDER LINE AGAINST `stock_take_items`. ⛔
//
// `stock_take_items` is an INVENTORY EXPORT. It records what was counted on a
// shelf, which is a different question from "will FMC let me order this", and
// it carries discontinued articles indefinitely. Four were confirmed dead in
// one afternoon on 8 Aug 2026 — 4029044 Fennel -Europe, 4017171 Tomato Peeled
// Casar, 4017201 Porcini Dried Cepes, 4017263 Dates Sugar — each one looking
// perfectly healthy in the export and each one refused by FMC on an order.
// Matching against it is what put them on the list in the first place.
//
// The Kitchen Market List ASSORTMENT is the only list that knows what is
// orderable. `fmc_articles` is harvested from it (see fmc-helper/) and is the
// single source of truth for creating an item here, for recipes, and for the
// order helper. `stock_take_items` keeps its stock-take role and nothing else.
//
// If you are about to add a lookup against stock_take_items to "fill a gap":
// the gap is the point. An article missing from the assortment cannot be
// ordered, and finding a name for it elsewhere only hides that.
// ══════════════════════════════════════════════════════════════════════════

var mlArticles   = [];        // [{code,name,unit,supplier,on_assortment,retiring}]
var mlArtByCode  = {};        // code -> article, for flagging existing lines
var mlArtLoaded  = false;     // false until the fetch lands (or fails)

// Loaded once per open, after the grid is drawn. The market list must work at
// full speed whether or not this ever arrives: with no catalogue the add box
// falls back to plain free text, which is exactly what it did before, and no
// row gets a flag it cannot justify.
async function mlLoadArticles(){
  var rows = await mlFetchAllPaged(function(){
    return sb.from('fmc_articles')
      .select('code,name,unit,supplier,on_assortment,retiring')
      .eq('venue_id','robertos-difc')
      .eq('on_assortment', true)
      .order('name');
  });
  if(!rows || !rows.length) return;          // no catalogue -> no claims
  mlArticles = rows;
  mlArtByCode = {};
  rows.forEach(function(a){ mlArtByCode[String(a.code).trim()] = a; });
  mlArtLoaded = true;
  if(activeStation === ORDER_KEY){ mlRenderRows(mlVisibleDays()); }
}

// What is wrong with this line's article, if anything. Returns null when the
// line is fine, when it has no code at all, when it was deliberately created
// with no FMC article, or when the catalogue never loaded — a flag we cannot
// stand behind is worse than no flag.
function mlArticleFlag(it){
  if(!mlArtLoaded) return null;
  if(it.fmc_none) return { kind:'none', label:'not in FMC',
    why:'No FMC article — ordered the way it always has been.' };
  var code = (it.code||'').trim();
  if(!code) return null;
  var art = mlArtByCode[code];
  if(!art) return { kind:'dead', label:'dead code ' + code,
    why:'FMC will not accept ' + code + ' — it is not on the assortment. Repoint this line to the right article.' };
  if(art.retiring) return { kind:'retiring', label:'retiring',
    why:'FMC is withdrawing this article. It can still be ordered today.' };
  return null;
}

// ── search ────────────────────────────────────────────────────────────────
// Name-starts-with first, then anything containing it, then code and supplier.
// A chef typing "tom" wants Tomato before Beef Tenderloin Side Strap.
function mlSearchArticles(q){
  q = (q||'').trim().toLowerCase();
  if(q.length < 2) return [];
  var starts = [], contains = [];
  for(var i=0;i<mlArticles.length;i++){
    var a = mlArticles[i], n = (a.name||'').toLowerCase();
    if(n.indexOf(q)===0 || String(a.code).indexOf(q)===0) starts.push(a);
    else if(n.indexOf(q)>=0 || String(a.code).indexOf(q)>=0 ||
            (a.supplier||'').toLowerCase().indexOf(q)>=0) contains.push(a);
    if(starts.length + contains.length > 300) break;
  }
  return starts.concat(contains).slice(0, 30);
}

var mlPickState = {};   // safe(category) -> { hits:[], sel:0, picked:article|null }

function mlEsc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

function mlAddInput(category, safe, value){
  var st = mlPickState[safe] || (mlPickState[safe] = { hits:[], sel:0, picked:null });
  st.picked = null;                       // typing again abandons the last pick
  st.hits = mlSearchArticles(value);
  st.sel = 0;
  mlRenderPickMenu(category, safe);
}

function mlRenderPickMenu(category, safe){
  var st = mlPickState[safe]; if(!st) return;
  var box = document.getElementById('mlpick-' + safe); if(!box) return;
  var inp = document.getElementById('mladd-' + safe);
  var q = inp ? (inp.value||'').trim() : '';
  if(q.length < 2 || !mlArtLoaded){ box.style.display='none'; box.innerHTML=''; return; }

  var html = st.hits.map(function(a,i){
    return '<div class="ml-pick-opt' + (i===st.sel?' sel':'') + '" data-i="' + i + '">' +
      '<div class="ml-pick-nm">' + mlEsc(a.name) +
        (a.retiring ? '<span class="ml-flag retiring">retiring</span>' : '') +
        '<div class="ml-pick-meta">' + mlEsc(a.unit||'—') +
        (a.supplier ? ' · ' + mlEsc(a.supplier) : '') + '</div></div>' +
      '<span class="ml-pick-code">' + mlEsc(a.code) + '</span></div>';
  }).join('');

  // Free text is ALWAYS offered when CREATING a line, whether or not anything
  // matched: eleven lines genuinely have no FMC article and blocking them
  // would be wrong. Repointing is the opposite case — it exists to put a real
  // article behind a line, so "none of these" is not an answer there.
  if(safe === 'repoint'){
    if(!st.hits.length) html = '<div class="ml-pick-free">Nothing on the FMC assortment matches.</div>';
    box.innerHTML = html;
    box.style.display = 'block';
    Array.prototype.forEach.call(box.querySelectorAll('[data-i]'), function(el){
      el.onclick = function(e){ e.stopPropagation(); mlPickChoose('', 'repoint', +el.dataset.i); };
    });
    return;
  }
  html += '<div class="ml-pick-free' + (st.sel===st.hits.length?' sel':'') +
    '" data-i="' + st.hits.length + '"><b>Add “' + mlEsc(q) + '” anyway</b>' +
    '<span>' + (st.hits.length ? 'None of these is right' : 'No FMC article matches') +
    ' — the item is created and marked <b>not in FMC</b>.</span></div>';

  box.innerHTML = html;
  box.style.display = 'block';
  Array.prototype.forEach.call(box.querySelectorAll('[data-i]'), function(el){
    el.onclick = function(e){ e.stopPropagation(); mlPickChoose(category, safe, +el.dataset.i); };
  });
  var sel = box.querySelector('.sel'); if(sel && sel.scrollIntoView) sel.scrollIntoView({block:'nearest'});
}

function mlAddKey(e, category, safe){
  var st = mlPickState[safe]; if(!st) return;
  var box = document.getElementById('mlpick-' + safe);
  var open = box && box.style.display === 'block';
  if(e.key === 'ArrowDown' && open){ e.preventDefault(); st.sel = Math.min(st.hits.length, st.sel+1); mlRenderPickMenu(category, safe); }
  else if(e.key === 'ArrowUp' && open){ e.preventDefault(); st.sel = Math.max(0, st.sel-1); mlRenderPickMenu(category, safe); }
  else if(e.key === 'Escape' && open){ e.preventDefault(); box.style.display='none'; }
  else if(e.key === 'Enter'){
    e.preventDefault();
    if(open) mlPickChoose(category, safe, st.sel);
    else mlAddCustom(category, safe);        // catalogue never loaded — plain add
  }
}

function mlPickChoose(category, safe, i){
  var st = mlPickState[safe]; if(!st) return;
  var box = document.getElementById('mlpick-' + safe);
  var inp = document.getElementById('mladd-' + safe);
  if(i < st.hits.length){
    st.picked = st.hits[i];
    if(inp) inp.value = st.picked.name;
  } else {
    st.picked = null;                        // free text: keep what was typed
  }
  if(box) box.style.display = 'none';
  // The repoint picker shares this menu but not its destination: it changes
  // the article behind an existing line instead of creating one, and it has no
  // free-text option to fall through to.
  if(safe === 'repoint'){
    if(st.picked) mlRepoint(mlRepointFor, st.picked);
    return;
  }
  mlAddCustom(category, safe);
}

// ── add an item ───────────────────────────────────────────────────────────
// Two ways in, and both are legitimate:
//   picked from the catalogue -> code, fmc_unit and supplier are filled here,
//     with no second step for anybody. The pick IS the confirmation, so
//     fmc_verified_at is stamped: a line resolved against the assortment is at
//     least as trustworthy as one matched by hand on the Match-to-FMC screen,
//     and leaving it blank would send it back into that queue to be answered
//     a second time.
//   free text -> fmc_none, which says a PERSON decided there is no article.
//     That is a different fact from silence, and it keeps the line out of the
//     Match-to-FMC count for ever instead of asking the same question weekly.
async function mlAddCustom(category, safe){
  const inp = document.getElementById('mladd-' + safe);
  if(!inp) return;
  const typed = (inp.value||'').trim();
  if(!typed) return;
  const st = mlPickState[safe] || {};
  const art = st.picked || null;

  // sort it just after the last existing item in this category
  const inCat = mlItems.filter(i=>i.category===category);
  const maxSort = inCat.length ? Math.max(...inCat.map(i=>i.sort_order||0)) : 0;

  const row = { name: art ? art.name : typed, category,
                unit: art ? (art.unit||'') : '',
                sort_order: maxSort + 1, active:true };
  if(art){
    row.code = art.code;
    row.fmc_unit = art.unit || null;
    row.supplier = art.supplier || null;
    row.fmc_verified_at = new Date().toISOString();
    row.fmc_verified_by = 'catalogue';
  } else if(mlArtLoaded){
    row.fmc_none = true;         // only claim this when we actually looked
  }

  const { data, error } = await sb.from('order_items').insert(row).select().single();
  if(error){ alert('Could not add item: ' + error.message); return; }
  data.custom = true;
  mlItems.push(data);
  mlItems.sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));
  inp.value='';
  if(st) { st.picked = null; st.hits = []; st.sel = 0; }
  const menu = document.getElementById('mlpick-' + safe); if(menu) menu.style.display='none';
  mlRenderRows(mlVisibleDays());
  mlRenderSummary();
  if(typeof kToast === 'function'){
    kToast(art ? ('✓ ' + art.name + ' added · ' + art.code + ' · ' + (art.unit||''))
               : ('✓ ' + typed + ' added — marked not in FMC'));
  }
  // keep focus flowing: re-focus the same category's add box
  const again = document.getElementById('mladd-' + safe);
  if(again) again.focus();
}

// ── repointing a dead code ────────────────────────────────────────────────
// NEVER deactivate a line to clean up a dead code. Deactivating orphans the
// quantities: the app loads with .eq('active', true), so the row vanishes from
// every screen while order_quantities still holds the numbers. That is how 3kg
// of heirloom tomatoes were lost on 7 Aug 2026.
//
// Repointing keeps `item_id` exactly where it is, so every quantity ever
// ordered against this line — past weeks included — stays attached to it.
// Only the article behind it changes.
// The article is CHOSEN FROM A LIST, never typed and matched behind the
// person's back. A repoint writes a new article code onto a line that already
// carries quantities, so a wrong pick here orders the wrong thing and invoices
// for it — the exact failure this whole catalogue exists to stop. Chained
// prompt() boxes, where somebody types a name and the code silently takes the
// first match, are how that happens. The same picker as the add box, showing
// code, unit and supplier on every option, means the choice is visible.
var mlRepointFor = null;      // item id the picker is open for

function mlRepointOpen(itemId){
  var it = mlItems.find(function(x){ return x.id === itemId; });
  if(!it) return;
  if(!mlArtLoaded){ alert('The article catalogue has not loaded yet — give it a moment and try again.'); return; }
  mlRepointFor = itemId;
  mlPickState.repoint = { hits:[], sel:0, picked:null };
  var host = document.getElementById('ml-repoint-host'); if(!host) return;
  host.innerHTML =
    '<div class="ml-catadd-combo" style="margin-top:8px">' +
      '<input class="check-input ml-catadd-input" id="mladd-repoint" autocomplete="off" ' +
        'placeholder="Find the right FMC article…" ' +
        'oninput="mlAddInput(\'\',\'repoint\',this.value)" ' +
        'onkeydown="mlRepointKey(event)">' +
      '<div class="ml-pick-menu" id="mlpick-repoint"></div>' +
    '</div>';
  var inp = document.getElementById('mladd-repoint'); if(inp) inp.focus();
}

// The picker's own Enter/arrows, minus the free-text escape hatch: repointing
// at "no article" is not a thing. Clearing a dead code is what fmc_none is for.
function mlRepointKey(e){
  var st = mlPickState.repoint; if(!st) return;
  var box = document.getElementById('mlpick-repoint');
  var open = box && box.style.display === 'block';
  if(e.key === 'ArrowDown' && open){ e.preventDefault(); st.sel = Math.min(st.hits.length-1, st.sel+1); mlRenderPickMenu('', 'repoint'); }
  else if(e.key === 'ArrowUp' && open){ e.preventDefault(); st.sel = Math.max(0, st.sel-1); mlRenderPickMenu('', 'repoint'); }
  else if(e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); var h=document.getElementById('ml-repoint-host'); if(h) h.innerHTML=''; mlRepointFor=null; }
  // stopPropagation matters: the module's document-level keydown treats Enter
  // inside an open editor as "Save", so without it choosing an article here
  // would also save and close the popup underneath.
  else if(e.key === 'Enter'){ e.preventDefault(); e.stopPropagation(); if(open && st.hits[st.sel]) mlRepoint(mlRepointFor, st.hits[st.sel]); }
}

async function mlRepoint(itemId, art){
  var it = mlItems.find(function(x){ return x.id === itemId; });
  if(!it || !art) return;

  var ordered = [1,2,3,4,5,6].filter(function(wd){ return mlQty[itemId+'|'+wd] != null; }).length;
  if(!confirm('Point "' + it.name + '" at:\n\n' + art.name + '\n' + art.code + ' · ' + (art.unit||'') +
      (art.supplier ? '\n' + art.supplier : '') +
      '\n\nThe line keeps its place and every quantity on it' +
      (ordered ? ' — including ' + ordered + ' day' + (ordered===1?'':'s') + ' this week' : '') + '.')) return;

  var res = await sb.from('order_items').update({
    code: art.code, fmc_unit: art.unit || null, supplier: art.supplier || null,
    fmc_none: false,
    fmc_verified_at: new Date().toISOString(), fmc_verified_by: 'catalogue'
  }).eq('id', itemId);
  if(res && res.error){
    var m = 'Could not repoint it — ' + res.error.message;
    if(typeof kToast === 'function') kToast(m, true); else alert(m);
    return;
  }
  it.code = art.code; it.fmc_unit = art.unit || null; it.supplier = art.supplier || null; it.fmc_none = false;
  mlRepointFor = null;
  mlCloseEditor();
  mlRenderRows(mlVisibleDays());
  if(typeof kToast === 'function') kToast('✓ "' + it.name + '" now points at ' + art.code + ' · ' + art.name);
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
        <button class="report-btn" id="ml-fmc" onclick="openFmcMatch()">Match to FMC</button>
        <button class="report-btn" onclick="mlOrderHelper()">Order helper</button>
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
  mlFmcCount();
}

// How many lines still have no FMC article behind them. Fetched after the grid
// is drawn, never before — the market list must open at full speed whether or
// not this answer ever arrives, and the button works the same either way.
// When it reaches zero the button stops carrying a number, so a finished job
// stops asking for attention.
async function mlFmcCount(){
  var btn = document.getElementById('ml-fmc'); if(!btn) return;
  // `fmc_none` lines are excluded on purpose: a person has already decided
  // there is no FMC article for them. Counting them would ask the same
  // answered question every week and the number would never reach zero.
  //
  // Falls back to the old count if the column isn't there yet. PostgREST
  // answers an unknown column with a 400, so without this the button would
  // quietly stop showing its number on any deploy that landed before the
  // migration — the front-end and the schema ship separately and neither can
  // wait for the other.
  var res = await sb.from('order_items').select('id', { count:'exact', head:true })
    .eq('active', true).is('code', null).is('fmc_verified_at', null).eq('fmc_none', false);
  if(res.error){
    res = await sb.from('order_items').select('id', { count:'exact', head:true })
      .eq('active', true).is('code', null).is('fmc_verified_at', null);
  }
  if(res.error) return;                       // no number is better than a wrong one
  var b = document.getElementById('ml-fmc'); if(!b) return;
  b.textContent = res.count ? ('Match to FMC · ' + res.count) : 'Match to FMC';
}

function mlRenderSummary(){
  const el = document.getElementById('ml-summary'); if(!el) return;
  const days = mlVisibleDays();
  const scope = mlActiveDay ? ML_DAYS[mlActiveDay-1] : 'shown days';
  const val = mlOrderValue(days);

  // Never a lone figure. If some lines have no price the tile says how many,
  // because a total that cannot see part of the order must not look complete.
  const valueNote = val.unpriced
    ? `${val.priced} of ${val.priced+val.unpriced} lines priced`
    : `${scope} · at FMC prices`;

  el.innerHTML = `
    ${mlReqHtml(days)}
    <div class="ops-grid ml-grid">
      <div class="ops-card dark"><div class="ops-num">${mlOrderedCount()}</div><div class="ops-label">Lines ordered (${scope})</div></div>
      <div class="ops-card"><div class="ops-num">${mlMoney(val.total)}</div><div class="ops-label">AED · about, ${valueNote}</div></div>
      <div class="ops-card"><div class="ops-num">${mlItems.length}</div><div class="ops-label">Market list items</div></div>
      <div class="ops-card"><div class="ops-num">${days.length}</div><div class="ops-label">Days shown</div></div>
    </div>`;
}

// What each day on screen became in Materials Control. Silent for a day that
// has nothing ordered - the screen shows the state of the work, not a nag.
function mlReqHtml(days){
  const found = mlReqsForDays(days);
  const bits = [];

  found.forEach(r=>{
    const gone = r.status === 'deleted';
    const when = ML_DAYS[r.weekday-1] + ' ' + mlDateForWeekday(r.weekday).split(' ').slice(1).join(' ');
    const parts = [r.line_count ? r.line_count + ' lines' : '',
                   r.total != null ? 'AED ' + mlMoney(r.total) : ''].filter(Boolean).join(' · ');
    bits.push(`<span class="ml-req-item${gone?' gone':''}">
        <b>${when}</b> ·
        <span class="ml-req-no"${gone?' style="text-decoration:line-through;"':''}>${r.requisition_no}</span>
        ${parts?' · '+parts:''}${gone?' · deleted in FMC':''}
        ${r.reconciled === false ? ' · <b style="color:#a11">did not match the order</b>' : ''}
      </span>`);
  });

  // Only for a single day the chef is actually looking at, and only when there
  // is something to request. Six "not yet requested" lines would be noise.
  if(mlActiveDay && !found.length){
    const has = mlItems.some(it=>Number(mlQty[it.id+'|'+mlActiveDay]));
    if(has){
      const when = ML_DAYS[mlActiveDay-1] + ' ' + mlDateForWeekday(mlActiveDay).split(' ').slice(1).join(' ');
      bits.push(`<span class="ml-req-item none"><b>${when}</b> · not yet requested in Materials Control</span>`);
    }
  }

  if(!bits.length) return '';
  return `<div class="ml-req">${bits.join('')}</div>`;
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
      // The flag is the whole point of the catalogue on this screen: a line
      // carrying a code FMC will refuse looks exactly like a healthy one until
      // somebody tries to order it.
      const fl = mlArticleFlag(it);
      const flag = fl ? `<span class="ml-flag ${fl.kind}" title="${mlEsc(fl.why)}">${mlEsc(fl.label)}</span>` : '';
      html += `<div class="ml-row ml-row-tap" onclick="mlOpenEditor(${it.id})">
        <div class="ml-cell-name"><div class="ml-name">${it.name}${flag}</div><div class="ml-unit">${mlUnitFor(it)}</div></div>
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
      const c1 = cat.replace(/'/g,"\\'");
      html += `<div class="ml-catadd">
        <div class="ml-catadd-combo">
          <input class="check-input ml-catadd-input" id="mladd-${safe}" autocomplete="off"
                 placeholder="${mlArtLoaded?`Add item to ${cat} — type to find an FMC article…`:`Add item to ${cat}…`}"
                 oninput="mlAddInput('${c1}','${safe}',this.value)"
                 onkeydown="mlAddKey(event,'${c1}','${safe}')">
          <div class="ml-pick-menu" id="mlpick-${safe}"></div>
        </div>
        <button class="ml-catadd-btn" onclick="mlAddCustom('${c1}','${safe}')">Add</button>
      </div>`;
    }
  });
  html += `</div>`;

  if(!any){ c.innerHTML = `<div class="report-no-data">${mlOrderedOnly?'Nothing ordered for the shown days yet.':'No items match your search.'}</div>`; return; }
  c.innerHTML = html;
}

// ══════════════════════════════════════════════════════════════════════════
// TAKING A LINE OFF THE LIST
//
// Nothing is ever deleted. `active = false` takes the line out of the market
// list and leaves the row — and every quantity ever ordered against it, in
// every past week — exactly where it is. A deleted row would take last April's
// order history with it, and the market list is the record of what the kitchen
// bought.
//
// Who: any employee ID on the roster, or an admin code. It is recorded on the
// toast so the person doing it sees their own name, and the next person can ask
// them rather than guess. Held in memory only — a shared kitchen screen must
// not stay unlocked after someone walks away.
// ══════════════════════════════════════════════════════════════════════════
// Sits to the LEFT of Cancel and Save, quiet and outlined, because the thumb
// that opens this popup fifty times a service is aiming at Save. It is only
// ever reached deliberately.
function mlInjectCss(){
  if(document.getElementById('ml-module-css')) return;
  var s = document.createElement('style');
  s.id = 'ml-module-css';
  s.textContent = [
    // `.ml-ed-btn` is flex:1 — left alone this would make "Take off the list"
    // exactly as wide and as inviting as Save, sitting under the same thumb.
    // It keeps its own width and gives the rest of the row to Cancel and Save.
    '.ml-ed-remove{flex:0 0 auto;margin-right:auto;background:#fff;border:1px solid rgba(107,31,42,.25);color:#8a3226;font-size:13px;padding:12px 12px}',
    '.ml-ed-remove:hover{background:#fdf4f2;border-color:#c98d80}',
    '@media(max-width:420px){.ml-ed-remove{font-size:12px;padding-left:10px;padding-right:10px}}',

    // ── the article picker ──
    // The combo must establish the positioning context, not .ml-catadd: the
    // add row is a flex container and anchoring the menu to it would drop the
    // list under the Add button instead of under the field being typed in.
    '.ml-catadd-combo{position:relative;flex:1;min-width:0}',
    '.ml-catadd-combo .ml-catadd-input{width:100%}',
    '.ml-pick-menu{display:none;position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:60;',
      'background:#fff;border:1px solid rgba(64,2,7,.18);border-radius:8px;',
      'box-shadow:0 10px 26px rgba(64,2,7,.16);max-height:300px;overflow:auto;text-align:left}',
    '.ml-pick-opt{display:flex;gap:9px;align-items:flex-start;padding:8px 11px;cursor:pointer;',
      'border-bottom:1px solid rgba(64,2,7,.06)}',
    '.ml-pick-opt:last-child{border-bottom:0}',
    '.ml-pick-opt.sel,.ml-pick-opt:hover{background:#FBF6EC}',
    '.ml-pick-nm{flex:1;min-width:0;font-size:13px;font-weight:600;color:#2C1810}',
    '.ml-pick-meta{font-size:11px;font-weight:400;color:#8B7355;margin-top:1px}',
    '.ml-pick-code{font:600 11px ui-monospace,Menlo,monospace;color:#400207;background:#F3EADD;',
      'border-radius:4px;padding:2px 6px;white-space:nowrap}',
    '.ml-pick-free{padding:10px 11px;background:#FDF4E0;border-top:1px solid rgba(64,2,7,.1);',
      'cursor:pointer;font-size:12.5px;color:#2C1810}',
    '.ml-pick-free.sel,.ml-pick-free:hover{background:#FAE9C6}',
    '.ml-pick-free b{color:#8a5a00}',
    '.ml-pick-free span{display:block;font-size:11px;color:#8B7355;margin-top:2px}',

    // ── row flags ──
    // Inline-block, never inline-flex: .ml-name is nowrap + ellipsis, and a
    // flex child inside it refuses to be clipped, so a long article name would
    // push the flag off the row instead of truncating.
    '.ml-flag{display:inline-block;margin-left:6px;font:600 9.5px var(--font-sans,sans-serif);',
      'border-radius:20px;padding:1px 7px;vertical-align:middle;letter-spacing:.3px}',
    '.ml-flag.dead{background:#FDECEA;color:#b3261e;border:1px solid #F2B8B2}',
    '.ml-flag.none{background:#FDF4E0;color:#8a5a00;border:1px solid #E4C98A}',
    '.ml-flag.retiring{background:#EEF2FA;color:#2a4a7a;border:1px solid #C3D2EA}',
    '.ml-ed-flagline{margin:8px 0 0;padding:8px 10px;border-radius:6px;font-size:12px;line-height:1.4}',
    '.ml-ed-flagline.dead{background:#FDECEA;color:#8a1c16}',
    '.ml-ed-flagline.none{background:#FDF4E0;color:#6d4700}',
    '.ml-ed-flagline.retiring{background:#EEF2FA;color:#23405f}',
    '.ml-ed-repoint{margin-top:7px;background:#fff;border:1px solid #c98d80;color:#8a3226;',
      'border-radius:6px;padding:8px 12px;font:600 12px var(--font-sans,sans-serif);cursor:pointer}'
  ].join('\n');
  document.head.appendChild(s);
}

var ML_ADMIN = { '1212':'Admin', '0000':'Cost Controller', '2468':'Supervisor' };
var mlWho = null;                      // { emp_id, name } — null until identified

async function mlIdentify(){
  if(mlWho) return mlWho;
  var id = prompt('Your employee ID (or admin code) — so the app can record who took the item off:');
  if(id === null) return null;         // Cancel
  id = String(id).trim();
  if(!id) return null;
  if(ML_ADMIN[id]){ mlWho = { emp_id:id, name:ML_ADMIN[id] }; return mlWho; }
  var res = await sb.from('staff').select('name,emp_id').eq('emp_id', id).eq('active', true).limit(1);
  var staff = res.data && res.data[0];
  if(!staff){
    var msg = 'Employee ID ' + id + ' not recognised — check it and try again.';
    if(typeof kToast === 'function') kToast(msg, true); else alert(msg);
    return null;
  }
  mlWho = { emp_id:id, name:staff.name };
  return mlWho;
}

// Every quantity still standing against this line from `fromWeek` onwards.
// Returns null — never an empty array — when the question could not be
// answered, so a caller cannot read a failure as an all-clear.
//
// `gte` rather than the two named weeks: the week switcher goes six weeks out
// (mlChangeWeek clamps 0..6), so "this week and next" would still leave five
// weeks a chef can type into and this cannot see. Asking for everything from
// today's Monday forward costs the same one query and cannot be outgrown.
// Past weeks are deliberately NOT included — they are history, they have
// already been ordered, and keeping them is the reason a line is switched off
// rather than deleted.
async function mlQuantitiesFrom(itemId, fromWeek){
  var res = await sb.from('order_quantities')
    .select('week_start,weekday,qty')
    .eq('item_id', itemId)
    .gte('week_start', fromWeek);
  if(!res || res.error) return null;
  return (res.data || []).filter(function(r){ return r.qty != null && Number(r.qty) !== 0; });
}

// 'this week' / 'next week' / the date itself, so the refusal names a week the
// chef can navigate to rather than a bare Monday they have to work out.
function mlWeekName(weekStart, thisWeek){
  if(weekStart === thisWeek) return 'this week';
  var a = new Date(thisWeek + 'T00:00:00'), b = new Date(weekStart + 'T00:00:00');
  var n = Math.round((b - a) / 604800000);          // 7 * 24 * 60 * 60 * 1000
  if(n === 1) return 'next week';
  return (n > 1 ? '+' + n + ' weeks' : 'week') + ' (' + weekStart + ')';
}

async function mlRemoveItem(itemId){
  var it = mlItems.find(function(x){ return x.id === itemId; });
  if(!it) return;

  var who = await mlIdentify();
  if(!who) return;

  // ── THE ORPHAN GUARD ──────────────────────────────────────────────────
  // `active = false` does NOT keep the quantities reachable. The app loads
  // with .eq('active', true), so the line disappears from every screen while
  // order_quantities still holds its numbers: nobody can see them, nobody can
  // correct them, and they drop silently out of the order. That is exactly
  // what happened to 3kg of heirloom tomatoes on 7 Aug 2026 — item 431 was
  // switched off as a duplicate with the quantity still on it, and the twin
  // (434) carried nothing.
  //
  // The old warning said "those orders are kept", which is true of the rows
  // and false of the order. So a line with a quantity on it is now REFUSED,
  // and the person is pointed at the two things that actually work: clear the
  // quantities first, or repoint the line and keep its history.
  //
  // Checked against the DATABASE, not against mlQty. mlQty only ever holds the
  // week on screen (loadMarketList filters .eq('week_start', mlWeekStart)), so
  // the in-memory check could only ever see one week of the seven the chef can
  // order into. Standing on this week and taking a line off would have orphaned
  // next week's quantities in exactly the way this guard exists to prevent —
  // the same failure as the heirloom tomatoes, one week displaced, and just as
  // invisible.
  var fromWeek = mlWeekStartFor(0);          // this week's Monday, whatever is on screen
  var pending = await mlQuantitiesFrom(itemId, fromWeek);

  // A guard that cannot see is not a guard. supabase-js reports failures on the
  // result rather than throwing, so a dropped connection would otherwise read
  // as "no quantities found" and wave the removal through — the one outcome
  // this must never produce. No answer means refuse.
  if(pending === null){
    alert('"' + it.name + '" was not taken off the list.\n\n' +
      'Its quantities could not be checked just now — the connection did not answer. ' +
      'Taking a line off without that check is how quantities get stranded where nobody ' +
      'can see them, so nothing has been changed.\n\nTry again in a moment.');
    return;
  }

  if(pending.length){
    var byWeek = {};
    pending.forEach(function(r){ (byWeek[r.week_start] = byWeek[r.week_start] || []).push(r); });
    var weeks = Object.keys(byWeek).sort();
    var lines = weeks.map(function(ws){
      var days = byWeek[ws].slice()
        .sort(function(a,b){ return a.weekday - b.weekday; })
        .map(function(r){ return ML_DAYS[r.weekday-1] + ' ' + r.qty; });
      return '  ' + mlWeekName(ws, fromWeek) + ':  ' + days.join(',  ');
    });
    alert('"' + it.name + '" cannot be taken off the list yet.\n\n' +
      'It still has ' + pending.length + ' quantit' + (pending.length===1?'y':'ies') +
      ' on it, across ' + weeks.length + ' week' + (weeks.length===1?'':'s') + ':\n' +
      lines.join('\n') +
      '\n\nSwitching it off now would hide the line while those quantities stayed in the ' +
      'database — they would never be ordered and nobody would see them. Three kilos of ' +
      'heirloom tomatoes were lost that way on 7 August.\n\n' +
      'Either clear those quantities first, or — if this is a duplicate — repoint the line ' +
      'at the right article instead, which keeps everything ever ordered against it.');
    return;
  }
  if(!confirm('Take "' + it.name + '" off the market list?' +
              '\n\nChecked: it has no quantities on this week or any week ahead. Nothing is ' +
              'deleted — everything ever ordered against it in past weeks is kept. ' +
              'Ask Francesco to put it back.')) return;

  var res = await sb.from('order_items').update({ active:false }).eq('id', itemId);
  if(res && res.error){
    var m = 'Could not remove it — ' + res.error.message;
    if(typeof kToast === 'function') kToast(m, true); else alert(m);
    return;
  }
  mlItems = mlItems.filter(function(x){ return x.id !== itemId; });
  mlCloseEditor();
  mlRenderRows(mlVisibleDays());
  mlRenderSummary();
  if(typeof kToast === 'function') kToast('✓ "' + it.name + '" taken off the list by ' + who.name);
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
        ${mlUnitFor(it)?`<div class="ml-ed-unit">${mlUnitFor(it)}</div>`:''}
        ${(()=>{ const fl = mlArticleFlag(it); if(!fl) return '';
          // Spelled out here, not just as a chip: the grid has room for a
          // label, this is where somebody can actually act on it.
          return `<div class="ml-ed-flagline ${fl.kind}">${mlEsc(fl.why)}` +
            (fl.kind==='dead' ? `<br><button type="button" class="ml-ed-repoint" onclick="mlRepointOpen(${it.id})">Repoint to the right article…</button><div id="ml-repoint-host"></div>` : '') +
            `</div>`; })()}
      </div>
      <div class="ml-ed-body">${dayRows}</div>
      <div class="ml-ed-foot">
        <button type="button" class="ml-ed-btn ml-ed-remove" onclick="mlRemoveItem(${it.id})" title="Take this item off the market list">Take off the list</button>
        <button type="button" class="ml-ed-btn ml-ed-cancel" onclick="mlCloseEditor()">Cancel</button>
        <button type="button" class="ml-ed-btn ml-ed-save" onclick="mlSaveEditor()">Save</button>
      </div>
    </div>`;
  box.addEventListener('click', mlCloseEditor); // click backdrop closes
  document.body.appendChild(box);
  mlInjectCss();
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
// The unit to SHOW on a line. FMC's own order unit wherever we have one.
//
// `unit` is free text a chef typed when the line was created — 'kilogram',
// '2kg', '12x 1l'. `fmc_unit` is the packing unit on FMC's Purchase grid, read
// off the grid and confirmed against FMC's printed Assortment List. On 10 Aug
// 2026, 222 of the 424 active lines disagreed: 'Basil in Pot -GCC' showed
// kilogram against a Dish/1x25 Grm order line, and 'Egg Whole Fresh Medium'
// showed kilogram against Ctn/12Trayx30 Pcs — so a "1" on that line is one
// carton of 360 eggs, and the label said kilo.
//
// The number the chef types IS the number typed into FMC, so the label beside
// it has to be FMC's. Where there is no fmc_unit — 13 lines — nothing is
// invented and the line shows what it always showed.
function mlUnitFor(it){
  return (it && (it.fmc_unit || it.unit)) || '';
}

function mlConsolidate(weekday){
  const groups = [];
  let cur = null;
  mlItems.forEach(it=>{
    const v = mlQty[it.id+'|'+weekday];
    if(v==null) return;
    if(!cur || cur.category !== it.category){ cur = {category:it.category, items:[]}; groups.push(cur); }
    cur.items.push({ name:it.name, unit:mlUnitFor(it), qty:v });
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

// ══════════════════════════════════════════════════════════════════════════
// ORDER HELPER — the download, and what to do with it
//
// The helper is a Windows program that types the day's order into Materials
// Control: about a second a line, against reading all 460 rows of the grid by
// hand. It lives here because this is the screen the order is built on, and a
// tool nobody can find is a tool nobody uses.
//
// It is NOT next to "Match to FMC" by accident and it does not replace it.
// Match to FMC is what gives every market-list line its FMC code, and the
// helper finds each line in Materials Control BY that code. No code, no
// placement — the line comes back on the type-by-hand list instead.
//
// What the helper never does: save, choose a basket, or press Request. It
// types and stops. A person commits the order under their own FMC login.
// ══════════════════════════════════════════════════════════════════════════
var ML_HELPER_EXE = 'downloads/FMC-order-helper.exe';

function mlOrderHelper(){
  var w = document.getElementById('order-view');
  if(!w) return;
  var old = document.getElementById('ml-helper-panel');
  if(old){ old.remove(); return; }

  var d = document.createElement('div');
  d.id = 'ml-helper-panel';
  d.className = 'ac-caution';
  d.style.margin = '12px 0';
  d.innerHTML =
    '<b>Order helper — types this order into Materials Control</b><br>' +
    'For the laptop that has Materials Control on it. Windows only.' +
    '<div style="margin:10px 0"><a class="report-btn" style="text-decoration:none" ' +
      'href="' + ML_HELPER_EXE + '" download>Download the order helper</a></div>' +
    '<b>What to do</b><ol style="margin:6px 0 0 18px;padding:0">' +
      '<li>Open Materials Control on the Kitchen Market List.</li>' +
      '<li>Open the helper, pick the day, read the plan.</li>' +
      '<li>Press <i>Type this order in</i> and leave the mouse alone while it works.</li>' +
      '<li>Check it, then save it yourself and press Request. The helper never does.</li>' +
    '</ol>' +
    '<div style="margin-top:8px">Nobody else should be working in that order ' +
    'at the same time — it aims at the screen, so a second person moves the ' +
    'target. If a line cannot be placed it does not stop; it types the rest ' +
    'and lists what to add by hand.</div>';
  var anchor = document.querySelector('#order-view .ml-actions');
  if(anchor && anchor.parentNode) anchor.parentNode.insertBefore(d, anchor.nextSibling);
  else w.appendChild(d);
}

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
  // Injected before the first render, not on opening the editor: the picker
  // and the row flags are drawn with the grid, so styling them later would
  // show one unstyled frame of raw list on every open.
  mlInjectCss();
  await loadMarketList();
  subscribeMarketList();
  renderMarketList();
  // After the grid is drawn, never before. The list must open at full speed
  // whether or not the catalogue arrives; when it does, the rows re-render
  // with their flags and the add box starts resolving articles.
  mlLoadArticles().catch(function(e){ console.warn('fmc_articles load failed', e); });
}

// ── keyboard handling for the edit popup (Esc closes, Enter saves) ──
document.addEventListener('keydown', function(e){
  if(!document.getElementById('ml-editor')) return;
  if(e.key === 'Escape'){ e.preventDefault(); mlCloseEditor(); }
  else if(e.key === 'Enter'){ e.preventDefault(); mlSaveEditor(); }
});
