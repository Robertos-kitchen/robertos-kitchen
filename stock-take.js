// ══════════════════════════════════════════════════════════════════════════
// STOCK TAKE MODULE — monthly inventory count (Kitchen = food).
// Mirrors market-list.js: master items + per-item counts, realtime, optimistic
// save with rollback, print, email. Items + prices come from the cost
// controller's monthly Excel (uploaded in-app); staff enter quantities live.
//
// Tables: stock_take_sheets (month header) · stock_take_items (the list) ·
//         stock_take_counts (one row per item — last writer wins + realtime).
// Scale-ready: every row carries venue_id + dept + month (see THE-GOAL.md).
// Reuses app.js globals: sb, SUPABASE_URL, SUPABASE_KEY, activeStation,
//   hideAllPages(), kToast(), flashSync().
// ══════════════════════════════════════════════════════════════════════════

var STOCK_KEY   = '__stocktake__';
var STOCK_VENUE = 'robertos-difc';
var STOCK_DEPT  = 'kitchen';

// Review & send recipients (Kitchen). Beverage/FOH build uses its own list.
var STOCK_EMAIL_TO = 'ahtwe@robertos.ae';
var STOCK_EMAIL_CC = ['dvalla@robertos.ae','astellacci@robertos.ae','amohamed@robertos.ae','fguarracino@robertos.ae'];

// Super-user passcodes — grant stock-take access on their own, NOT linked to any
// staff/roster record (so the holder never appears on the kitchen schedule). Used
// by Francesco + shared with the cost controller as an admin code. Beta: security
// deferred, so this lives client-side. Counts are attributed to this label.
var STOCK_SUPER = { '1212': 'Stock Take Admin', '0000': 'Cost Controller', '2468': 'Stock Take Supervisor' };
// Destructive actions (Clear all counts, Upload/replace the month's list) are
// limited to these admin codes so a regular counter can't wipe a live count.
function stIsSuper(){ return !!(stUser && STOCK_SUPER[stUser.emp_id]); }
// Locking/unlocking a finalized month is Aung's call alone (his code, 0000) —
// not shared with the other admin codes, so it can't be triggered by mistake.
function stCanLock(){ return !!(stUser && stUser.emp_id==='0000'); }

// Previous-month reference (the grey "Last month: …" line + last-month closing
// total) is BUILT but hidden for now. Flip to true to switch it back on — planned
// for July once June's inventory is done. When false, no prior-month data is even
// loaded, so the display naturally shows nothing.
var STOCK_SHOW_PREV = false;

// ── yield: premium items are weighed CLEANED, but valued at the ORIGINAL purchase
// weight (the money actually spent). e.g. 8 kg cleaned ÷ (1-0.30) = 11.43 kg bought.
// Applies to wild seafood (Seafood group + "wild" in the name) and tenderloin.
var STOCK_YIELD = 0.30;
function stIsYield(it){
  var n=(it.name||'').toLowerCase(), g=(it.item_group||'').toLowerCase();
  if(g==='seafood' && n.indexOf('wild')>-1) return true;
  if(n.indexOf('tenderloin')>-1) return true;
  return false;
}
function stYieldFactor(it){ return stIsYield(it)?STOCK_YIELD:0; }
// effective (originally-purchased) quantity used for all valuation
function stEffQty(it, qty){ var f=stYieldFactor(it); var q=Number(qty)||0; return f? q/(1-f) : q; }
function stEffQtyRound(it, qty){ return Math.round(stEffQty(it,qty)*1000)/1000; }

// ── state ──
var stSheet   = null;        // { month, status, ... }
var stMonth   = null;        // 'YYYY-MM'
var stItems   = [];          // [{id,item_group,code,name,unit,price,units,is_added}]
var stCounts  = {};          // item_id -> { qty, unit, counted_by, counted_by_name }
var stUser    = null;        // { emp_id, name }  (null until signed in)
var stSearch  = '';
var stCatFilters = [];       // [] = all categories, else list of item_group names to show
var stCountFilter = '';      // '' | 'counted' | 'uncounted' — which items to show
var stSortBy = '';           // '' | 'value' — highest value first, to spot mis-entries fast
var stUnitSel = {};          // item_id -> chosen unit (for 2-unit items)
var stChannel = null;

// ── previous-month reference (read-only): what each item closed at last month ──
var stPrevRef   = {};        // ref-key -> { qty, unit, value }
var stPrevTotal = 0;         // previous month's closing total value
var stPrevMonth = null;      // 'YYYY-MM' of the previous sheet (null if none)
var stPrevLabel = '';        // e.g. 'May 2026'

function stMoney(n){ return 'AED ' + (Number(n)||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function stEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function stJs(s){ return String(s==null?'':s).replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }

// price for an item given the currently-chosen unit
function stItemPrice(it){
  var u = stUnitSel[it.id];
  if(u && Array.isArray(it.units)){
    var hit = it.units.find(function(x){ return x.unit===u; });
    if(hit) return Number(hit.price)||0;
  }
  return Number(it.price)||0;
}
function stItemUnit(it){ return stUnitSel[it.id] || it.unit || ''; }

// price for a given item + a specific unit (used for previous-month history,
// independent of the current session's unit picks)
function stPriceForUnit(it, unit){
  if(unit && Array.isArray(it.units)){
    var hit = it.units.find(function(x){ return x.unit===unit; });
    if(hit) return Number(hit.price)||0;
  }
  return Number(it.price)||0;
}
// stable identity across monthly re-uploads: article code if present, else name
function stRefKey(it){
  var c = (it.code==null?'':String(it.code)).trim();
  if(c) return 'c:'+c.toLowerCase();
  return 'n:'+String(it.name||'').trim().toLowerCase();
}
// the small grey "Last month: …" line under an item (empty if no prior count)
function stPrevText(it){
  var r = stPrevRef[stRefKey(it)];
  if(!r) return '';
  return '<div class="st-prev">Last month: '+stEsc(String(r.qty))+(r.unit?' '+stEsc(r.unit):'')+' · '+stMoney(r.value)+'</div>';
}

// ── data load ──
async function stLoadSheet(){
  var res = await sb.from('stock_take_sheets').select('*')
    .eq('venue_id',STOCK_VENUE).eq('dept',STOCK_DEPT)
    .order('month',{ascending:false}).limit(1);
  stSheet = (res.data && res.data[0]) || null;
  stMonth = stSheet ? stSheet.month : null;
}
// Page through PostgREST's 1000-rows-per-request cap. WITHOUT this, a month with
// more than 1000 items (or counts) silently loads only the first 1000 — no error —
// and the rest vanish from the totals, Excel and email. Each page rebuilds the
// query (a range can't be reused across awaits); we stop on the first short page.
// A stable secondary sort on id keeps pages from overlapping/skipping rows.
async function stFetchAllPaged(makeQuery){
  var out=[], from=0, PAGE=1000;
  for(;;){
    var res = await makeQuery().range(from, from+PAGE-1);
    if(res && res.error) return { data:out, error:res.error };
    var batch = (res && res.data) || [];
    out = out.concat(batch);
    if(batch.length < PAGE) break;
    from += PAGE;
  }
  return { data:out, error:null };
}
async function stLoadItems(){
  if(!stMonth){ stItems = []; return; }
  var res = await stFetchAllPaged(function(){
    return sb.from('stock_take_items').select('*')
      .eq('venue_id',STOCK_VENUE).eq('dept',STOCK_DEPT).eq('month',stMonth)
      .eq('active',true).order('sort_order').order('id');
  });
  stItems = res.data || [];
  if(res.error && typeof kToast==='function')
    kToast('Not all items loaded ('+stItems.length+' so far) — the total may be incomplete. Reopen Stock Take.', true);
}
async function stLoadCounts(){
  stCounts = {};
  if(!stMonth) return;
  var res = await stFetchAllPaged(function(){
    return sb.from('stock_take_counts').select('*')
      .eq('venue_id',STOCK_VENUE).eq('dept',STOCK_DEPT).eq('month',stMonth).order('id');
  });
  if(res.error && typeof kToast==='function')
    kToast('Not all counts loaded — reopen Stock Take to be sure the total is right.', true);
  (res.data||[]).forEach(function(r){
    stCounts[r.item_id] = { qty:r.qty, unit:r.unit, counted_by:r.counted_by, counted_by_name:r.counted_by_name };
    if(r.unit) stUnitSel[r.item_id] = r.unit;
  });
}

// ── previous-month reference: load the most recent EARLIER sheet (same dept) and
// build a per-item lookup of what it closed at. Yield items carry the same 30%
// gross-up in qty + value as they did in the report. Read-only — no realtime. ──
async function stLoadPrevMonth(){
  stPrevRef = {}; stPrevTotal = 0; stPrevMonth = null; stPrevLabel = '';
  if(!STOCK_SHOW_PREV) return;   // feature built but hidden — flip STOCK_SHOW_PREV to re-enable
  if(!stMonth) return;
  var sres = await sb.from('stock_take_sheets').select('month')
    .eq('venue_id',STOCK_VENUE).eq('dept',STOCK_DEPT).lt('month',stMonth)
    .order('month',{ascending:false}).limit(1);
  var prev = sres.data && sres.data[0];
  if(!prev) return;
  stPrevMonth = prev.month;
  stPrevLabel = new Date(stPrevMonth+'-01T12:00:00').toLocaleDateString('en-GB',{month:'long',year:'numeric'});
  var ires = await stFetchAllPaged(function(){
    return sb.from('stock_take_items').select('id,code,name,item_group,unit,price,units')
      .eq('venue_id',STOCK_VENUE).eq('dept',STOCK_DEPT).eq('month',stPrevMonth).eq('active',true);
  });
  var cres = await stFetchAllPaged(function(){
    return sb.from('stock_take_counts').select('item_id,qty,unit')
      .eq('venue_id',STOCK_VENUE).eq('dept',STOCK_DEPT).eq('month',stPrevMonth);
  });
  var countByItem = {};
  (cres.data||[]).forEach(function(c){ if(c.qty!=null) countByItem[c.item_id] = c; });
  (ires.data||[]).forEach(function(it){
    var c = countByItem[it.id]; if(!c) return;
    var price = stPriceForUnit(it, c.unit);
    var qtyShown = stIsYield(it) ? stEffQtyRound(it, c.qty) : Number(c.qty);   // grossed-up purchase weight
    var val = price * stEffQty(it, c.qty);
    stPrevRef[stRefKey(it)] = { qty:qtyShown, unit:c.unit||it.unit||'', value:val };
    stPrevTotal += val;
  });
}

// ── realtime: live multi-person counting ──
function stSubscribe(){
  if(stChannel){ sb.removeChannel(stChannel); stChannel = null; }
  if(!stMonth) return;
  stChannel = sb.channel('stock_take_'+stMonth)
    .on('postgres_changes', { event:'*', schema:'public', table:'stock_take_counts', filter:'month=eq.'+stMonth },
      function(payload){
        var r = payload.new || payload.old; if(!r) return;
        if(payload.eventType==='DELETE'){ delete stCounts[r.item_id]; }
        else { stCounts[r.item_id] = { qty:r.qty, unit:r.unit, counted_by:r.counted_by, counted_by_name:r.counted_by_name }; }
        if(activeStation===STOCK_KEY){ stUpdateRowUI(r.item_id); stRenderTotals(); }
        if(typeof flashSync==='function') flashSync();
      })
    .on('postgres_changes', { event:'*', schema:'public', table:'stock_take_items', filter:'month=eq.'+stMonth },
      function(){ if(activeStation===STOCK_KEY){ stLoadItems().then(function(){ if(activeStation===STOCK_KEY) stSafeRenderRows(); }); } })
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'stock_take_sheets', filter:'month=eq.'+stMonth },
      function(payload){
        // an admin locked/unlocked this sheet on another device — freeze/unfreeze here too, instantly
        var r = payload.new; if(!r || !stSheet || r.id!==stSheet.id) return;
        var wasLocked = !!stSheet.locked;
        stSheet = r;
        if(!!r.locked!==wasLocked && activeStation===STOCK_KEY) stRender();
      })
    .subscribe(function(status){
      var dot=document.getElementById('realtime-dot');
      if(dot) dot.classList.toggle('live', status==='SUBSCRIBED');
    });
}

// ── employee-ID gate (validated against the clock-in/out staff list) ──
async function stSignIn(){
  var inp = document.getElementById('st-empid');
  var id = inp ? (inp.value||'').trim() : '';
  if(!id){ if(inp) inp.focus(); return; }
  // super-user passcode (e.g. 1212) — access without any staff/roster record
  if(STOCK_SUPER[id]){ stUser = { emp_id:id, name:STOCK_SUPER[id] }; stRender(); return; }
  var res = await sb.from('staff').select('id,name,emp_id').eq('emp_id', id).eq('active', true).limit(1);
  var staff = res.data && res.data[0];
  if(!staff){
    if(typeof kToast==='function') kToast('Employee ID '+id+' not recognised — check and try again.', true);
    else alert('Employee ID not recognised.');
    return;
  }
  stUser = { emp_id:id, name:staff.name };
  stRender();
}
function stSignOut(){ stUser = null; stRender(); }

// ── write one item's count (upsert / delete on empty), optimistic + rollback ──
async function stSetQty(itemId, value){
  if(!stUser) return;
  if(stIsLocked()){ if(typeof kToast==='function') kToast('This month is locked — counts can no longer be changed.', true); stUpdateRowUI(itemId); return; }
  var prev = stCounts[itemId] ? Object.assign({}, stCounts[itemId]) : null;
  var it = stItems.find(function(x){ return x.id===itemId; });
  var unit = it ? stItemUnit(it) : null;
  // normalise: trim + accept a decimal comma ("4,5" -> "4.5"). Only a BLANK box
  // clears the count; garbage (letters, "4,5,6", negatives) is rejected WITHOUT
  // touching the saved number — never silently delete a real count.
  var raw = (value==null?'':String(value)).trim().replace(',', '.');
  var res;
  if(raw === ''){
    delete stCounts[itemId];
    res = await sb.from('stock_take_counts').delete().eq('item_id', itemId);
  } else {
    var qty = Number(raw);
    if(isNaN(qty) || qty < 0){
      if(typeof kToast==='function') kToast('"'+value+'" is not a valid number — count left unchanged.', true);
      stUpdateRowUI(itemId);   // put the saved value back in the box
      return res || {};
    }
    stCounts[itemId] = { qty:qty, unit:unit, counted_by:stUser.emp_id, counted_by_name:stUser.name };
    var row = { item_id:itemId, venue_id:STOCK_VENUE, dept:STOCK_DEPT, month:stMonth,
                qty:qty, unit:unit, counted_by:stUser.emp_id, counted_by_name:stUser.name,
                updated_at:new Date().toISOString() };
    res = await sb.from('stock_take_counts').upsert(row, { onConflict:'item_id' });
  }
  if(res && res.error){
    if(prev) stCounts[itemId] = prev; else delete stCounts[itemId];
    if(typeof kToast==='function') kToast('That count did NOT save — check the connection and tap again.', true);
    console.warn('stock_take_counts save failed', res.error);
  }
  stUpdateRowUI(itemId);
  stRenderTotals();
  return res || {};
}

// ── ADD to a count (the "+ add" box): sum what you just found onto the running
// total. The add happens ATOMICALLY on the server (stock_take_add RPC) so two
// people adding at the same moment never lose stock. The delta is the CLEANED
// counted weight; the yield gross-up is applied on top by stLineValue/stEffText.
// We show the change optimistically, then trust the server's returned total. ──
async function stAddQty(itemId, value){
  if(!stUser) return;
  if(stIsLocked()){ if(typeof kToast==='function') kToast('This month is locked — counts can no longer be changed.', true); var b=document.getElementById('st-add-'+itemId); if(b) b.value=''; return; }
  var addBox = document.getElementById('st-add-'+itemId);
  var raw = (value==null?'':String(value)).trim().replace(',', '.');   // accept "2,5"
  var delta = Number(raw);
  if(raw==='' || isNaN(delta) || delta===0){ if(addBox) addBox.value=''; return; }
  var it = stItems.find(function(x){ return x.id===itemId; });
  var unit = it ? stItemUnit(it) : null;
  var prev = stCounts[itemId] ? Object.assign({}, stCounts[itemId]) : null;
  // optimistic: bump the local running total straight away
  var base = (prev && prev.qty!=null) ? Number(prev.qty) : 0;
  stCounts[itemId] = { qty:base+delta, unit:unit, counted_by:stUser.emp_id, counted_by_name:stUser.name };
  stUpdateRowUI(itemId); stRenderTotals();
  var res = await sb.rpc('stock_take_add', {
    p_item_id:itemId, p_venue_id:STOCK_VENUE, p_dept:STOCK_DEPT, p_month:stMonth,
    p_delta:delta, p_unit:unit, p_counted_by:stUser.emp_id, p_counted_by_name:stUser.name });
  if(res && res.error){
    if(prev) stCounts[itemId]=prev; else delete stCounts[itemId];
    stUpdateRowUI(itemId); stRenderTotals();
    if(typeof kToast==='function') kToast('That add did NOT save — check the connection and try again.', true);
    console.warn('stock_take_add failed', res.error);
    return;
  }
  // server is the source of truth for the running total
  if(res && res.data!=null){
    stCounts[itemId].qty = Number(res.data);
    stUpdateRowUI(itemId); stRenderTotals();
  }
  if(addBox){ addBox.value=''; }   // clear, ready for the next person
}

// ── derived ──
function stFilteredItems(){
  var q = stSearch.toLowerCase();
  var out = stItems.filter(function(it){
    if(stCatFilters.length && stCatFilters.indexOf(it.item_group||'Other')===-1) return false;
    var c=stCounts[it.id], counted = !!(c && c.qty!=null);
    if(stCountFilter==='counted' && !counted) return false;
    if(stCountFilter==='uncounted' && counted) return false;
    if(q && it.name.toLowerCase().indexOf(q)===-1 && String(it.code||'').indexOf(q)===-1) return false;
    return true;
  });
  if(stSortBy==='value') out = out.slice().sort(function(a,b){ return stLineValue(b)-stLineValue(a); });
  return out;
}
function stCats(){ return Array.from(new Set(stItems.map(function(i){ return i.item_group||'Other'; }))); }
// quantity shown in reports/Excel — grossed up to purchase weight for yield items
function stDisplayQty(it){ var c=stCounts[it.id]; if(!c||c.qty==null) return null; return stIsYield(it)? stEffQtyRound(it,c.qty) : Number(c.qty); }
// Line value = EXACTLY the Excel line (display qty × price, rounded to fils per
// line), so the screen, the email and the Excel TOTAL always agree to the fil.
// (Was unrounded yield math summed then rounded once — drifted a few fils vs the
// Excel on yield items, which a cost controller comparing totals will notice.)
function stLineValue(it){ var c = stCounts[it.id]; if(!c||c.qty==null) return 0; return Math.round(stDisplayQty(it)*stItemPrice(it)*100)/100; }
function stGrandTotal(){ var t=0; stItems.forEach(function(it){ t+=stLineValue(it); }); return t; }
function stCountedCount(){ var n=0; stItems.forEach(function(it){ var c=stCounts[it.id]; if(c&&c.qty!=null) n++; }); return n; }
function stCategoryTotal(){ var t=0; stItems.forEach(function(it){ if(!stCatFilters.length||stCatFilters.indexOf(it.item_group||'Other')>-1) t+=stLineValue(it); }); return t; }
// label for the category bar: "All categories" · a single name · "N categories"
function stCatLabelText(){
  if(!stCatFilters.length) return 'All categories';
  if(stCatFilters.length===1) return stCatFilters[0];
  return stCatFilters.length+' categories';
}
// once the cost controller finalizes a month, it's locked — no more entering/adjusting/clearing counts
function stIsLocked(){ return !!(stSheet && stSheet.locked); }

// ── render ──
function stInjectCss(){
  if(document.getElementById('st-css')) return;
  var s = document.createElement('style'); s.id='st-css';
  s.textContent =
    '#stocktake-view{padding:0 0 60px}'+
    '.st-gate{margin:12px 14px;padding:12px;background:#fbe7d8;border:1px solid #e3c79a;border-radius:10px}'+
    '.st-gate b{color:#7a1218}'+
    '.st-gate input{height:36px}'+
    '.st-who{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:12px 14px;font-size:13px;color:#7a6a55}'+
    '.st-who b{color:#410207}'+
    '.st-toolbar{display:flex;gap:8px;flex-wrap:wrap;padding:0 14px;margin:8px 0}'+
    '.st-toolbar .check-input,.st-toolbar .check-select{height:36px}'+
    '.st-catbar{display:flex;align-items:center;justify-content:space-between;padding:8px 14px 2px;font-size:13px}'+
    '.st-catbar b{color:#410207}'+
    '.st-cat{background:#410207;color:#f5ede0;font-size:11px;letter-spacing:1.2px;text-transform:uppercase;padding:6px 14px;margin-top:6px}'+
    '.st-row{padding:9px 14px;border-bottom:1px solid #e8ddc9;transition:background .12s}'+
    '.st-row.locked{opacity:.55}'+
    '.st-row.active{background:#fbe7cf}'+
    '.st-main{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:12px}'+
    '.st-namecol{min-width:0}'+
    '.st-name{font-size:14px;font-weight:600;color:#2a1a10;line-height:1.25}'+
    '.st-tag{font-size:10px;font-weight:700;color:#7a4a00;background:#f6d79a;border-radius:5px;padding:1px 6px;margin-left:6px}'+
    '.st-eff{display:inline-block;font-size:11px;font-weight:600;color:#7a4a00;background:#f6e3c0;border-radius:5px;padding:1px 6px;margin-top:4px}'+
    '.st-danger{color:#7a1218!important;border-color:#d98a8a!important}'+
    '.st-meta{margin-top:4px}'+
    '.st-prev{margin-top:3px;font-size:11px;color:#9a8a6a;font-style:italic}'+
    '.st-prevtotal{padding:6px 14px 0;font-size:12px;color:#8a7a55}'+
    '.st-prevtotal b{color:#410207}'+
    '.st-lockbanner{margin:10px 14px 0;padding:10px 12px;background:#f3eee6;border:1px solid #c9a84c;border-radius:10px;font-size:13px;color:#5a4a2a;line-height:1.4}'+
    '.st-muted{font-size:12px;color:#8a7a55}'+
    '.st-qtywrap{justify-self:center;display:flex;flex-direction:column;align-items:center;gap:4px}'+
    '.st-qty{width:72px;height:38px;text-align:center;border:1px solid #c9a84c;border-radius:8px;font-size:16px;background:#fff}'+
    '.st-add{width:72px;height:30px;text-align:center;border:1px dashed #1d7a4a;border-radius:8px;font-size:13px;color:#1d7a4a;background:#f3faf5}'+
    '.st-add::placeholder{color:#69a883}'+
    '.st-unit{height:30px;background:#e1d3c2;border:1px solid #cbb892;border-radius:6px;font-size:12px;color:#8a7a55;max-width:160px;padding:0 4px}'+
    '.st-line{justify-self:end;min-width:90px;text-align:right;font-weight:700;color:#410207;font-size:13px;font-variant-numeric:tabular-nums}'+
    '.st-actions{display:flex;gap:8px;padding:6px 14px 10px;flex-wrap:wrap}'+
    '.st-actions .report-btn{flex:1;min-width:108px}'+
    '.st-addbtn{margin:14px;width:calc(100% - 28px)}'+
    '.st-input,.st-select{height:38px;border:1px solid #c9a84c;border-radius:8px;padding:0 10px;font-size:14px;background:#fff}'+
    '.st-btn{flex:1;min-width:108px;height:40px;border:1px solid #c9a84c;background:#fff;color:#410207;font-weight:700;font-size:13px;border-radius:9px;cursor:pointer;padding:0 12px}'+
    '.st-btn:hover{background:#fbf4e6}'+
    '.st-modal{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:99999}'+
    '.st-modal-box{background:#fff;border-radius:12px;padding:18px;width:90%;max-width:360px}'+
    '.st-modal input{width:100%;height:38px;border:1px solid #c9a84c;border-radius:8px;padding:0 10px;font-size:14px;box-sizing:border-box}';
  document.head.appendChild(s);
}

function stRender(){
  stInjectCss();
  var view = document.getElementById('stocktake-view'); if(!view) return;
  if(!stMonth){
    view.innerHTML = '<div class="ops-title" style="padding:14px 14px 0">Stock Take</div>'+
      '<div class="ops-subtitle" style="padding:0 14px;color:#8a7a55;font-size:12px">No month loaded yet</div>'+
      stGateHtml()+
      (stIsSuper()
        ? '<div style="padding:14px"><button class="report-btn" onclick="stShowUpload()">Upload this month\'s list (.xls)</button></div>'
        : stUser
          ? '<div class="report-no-data">No list for this month yet — ask the cost controller or an admin (code 1212 / 0000 / 2468) to upload it.</div>'
          : '<div class="report-no-data">Enter your employee ID, then ask an admin to upload this month\'s list.</div>');
    return;
  }
  var monLabel = new Date(stMonth+'-01T12:00:00').toLocaleDateString('en-GB',{month:'long',year:'numeric'});

  var gate = stGateHtml();

  view.innerHTML =
    '<div class="ops-title" style="padding:14px 14px 0">Stock Take · '+stEsc(monLabel)+'</div>'+
    '<div class="ops-subtitle" style="padding:0 14px;color:#8a7a55;font-size:12px">'+stItems.length+' items · shared live · tap a quantity to count</div>'+
    (stIsLocked() ? '<div class="st-lockbanner">🔒 This month is <b>locked</b>'+(stSheet.locked_by_name?' by '+stEsc(stSheet.locked_by_name):'')+' — counts can no longer be entered, added to, or cleared. Email/Excel/Print still work.</div>' : '')+
    gate+
    '<div class="ops-grid" style="padding:0 14px">'+
      '<div class="ops-card dark"><div class="ops-num" id="st-grand">'+stMoney(stGrandTotal())+'</div><div class="ops-label">Counted value (all)</div></div>'+
      '<div class="ops-card"><div class="ops-num"><span id="st-counted">'+stCountedCount()+'</span> / '+stItems.length+'</div><div class="ops-label">Items counted</div></div>'+
    '</div>'+
    (stPrevTotal>0 ? '<div class="st-prevtotal">Last month ('+stEsc(stPrevLabel)+') closing value: <b>'+stMoney(stPrevTotal)+'</b> · shown per item below for reference</div>' : '')+
    '<div class="st-toolbar">'+
      '<input class="check-input" id="st-search" placeholder="Search items…" value="'+stEsc(stSearch)+'" oninput="stOnSearch(this.value)" style="flex:1;min-width:140px">'+
      '<button class="check-select" id="st-cat-btn" onclick="stShowCatFilter()" style="text-align:left;cursor:pointer">'+stEsc(stCatLabelText())+' ▾</button>'+
      '<select class="check-select" id="st-countfilter" onchange="stOnCountFilter(this.value)">'+
        '<option value=""'+(stCountFilter===''?' selected':'')+'>All items</option>'+
        '<option value="counted"'+(stCountFilter==='counted'?' selected':'')+'>Counted only</option>'+
        '<option value="uncounted"'+(stCountFilter==='uncounted'?' selected':'')+'>Not counted yet</option>'+
      '</select>'+
      '<select class="check-select" id="st-sortby" onchange="stOnSort(this.value)">'+
        '<option value=""'+(stSortBy===''?' selected':'')+'>List order</option>'+
        '<option value="value"'+(stSortBy==='value'?' selected':'')+'>Highest value first</option>'+
      '</select>'+
      (stIsSuper()?'<button class="report-btn" onclick="stShowUpload()">Upload month</button>':'')+
    '</div>'+
    '<div class="st-catbar"><span id="st-catlabel">'+stEsc(stCatLabelText())+'</span>'+
      '<span class="st-muted">category total <b id="st-catsub">'+stMoney(stCategoryTotal())+'</b></span></div>'+
    (stUser? '<div class="st-actions">'+
        '<button class="report-btn" onclick="stReviewSend()">Email to Aung</button>'+
        '<button class="report-btn" onclick="stExportExcel()">Download Excel</button>'+
        '<button class="report-btn" onclick="stPrint()">Print</button>'+
        (stIsSuper() && !stIsLocked() ?'<button class="report-btn st-danger" onclick="stClearAllCounts()">Clear all counts</button>':'')+
        (stCanLock() ? (stIsLocked()
          ? '<button class="report-btn" onclick="stUnlockMonth()">🔓 Unlock this month</button>'
          : '<button class="report-btn" onclick="stLockMonth()">🔒 Lock this month</button>') : '')+
      '</div>' : '')+
    (stUser && !stIsLocked() && stVoiceSupported() ? '<div style="display:flex;gap:8px;margin:8px 14px 0">'+
        '<button class="report-btn" style="flex:1;height:46px;font-size:15px" onclick="stVoiceStart()">🎤 Count by voice</button>'+
        '<select class="check-select" style="flex:none;height:46px" title="Voice language — set it to the section you are counting" onchange="stVoiceLang=this.value">'+
          ['en-GB','fr-FR','it-IT'].map(function(L){ var lbl={'en-GB':'EN','fr-FR':'FR','it-IT':'IT'}[L]; return '<option value="'+L+'"'+(stVoiceLang===L?' selected':'')+'>'+lbl+'</option>'; }).join('')+
        '</select></div>' : '')+
    (stUser && !stIsLocked() ?'<div style="padding:4px 14px 0;font-size:12px;color:#8a7a55;line-height:1.4">Type the <b>total</b> you counted in the white box. Use the green <b>+ add</b> box to add onto a count someone already started (e.g. a second person or the store-room).'+(stVoiceSupported()?' Or tap <b>🎤 Count by voice</b> and say the item and how many.':'')+'</div>':'')+
    '<div id="st-rows"></div>'+
    '<button class="report-btn st-addbtn" onclick="stShowAdd()">+ Add missing item</button>';

  stRenderRows();
}

function stRenderRows(){
  var c = document.getElementById('st-rows'); if(!c) return;
  var items = stFilteredItems();
  if(!items.length){ c.innerHTML = '<div class="report-no-data">No items match your search.</div>'; return; }
  var disabled = !stUser || stIsLocked();   // no user signed in, OR this month is finalized/locked
  var flat = stSortBy==='value';   // sorted-by-value is a flat ranked list — category dividers would be meaningless, show the category inline instead
  var html = '';
  var lastCat = null;
  items.forEach(function(it){
    var cat = it.item_group||'Other';
    if(!flat && cat!==lastCat){ html += '<div class="st-cat">'+stEsc(cat)+'</div>'; lastCat = cat; }
    var c2 = stCounts[it.id];
    var qv = (c2&&c2.qty!=null) ? c2.qty : '';
    var multi = Array.isArray(it.units) && it.units.length>1;
    var unitCtl = multi
      ? '<select class="st-unit" '+(disabled?'disabled':'')+' onchange="stPickUnit(\''+it.id+'\',this.value)">'+
        it.units.map(function(u){ return '<option value="'+stEsc(u.unit)+'"'+(stItemUnit(it)===u.unit?' selected':'')+'>'+stEsc(u.unit)+' · '+stMoney(u.price)+'</option>'; }).join('')+'</select>'
      : '<span class="st-muted">'+stEsc(it.unit||'')+' · '+stMoney(stItemPrice(it))+'</span>';
    html +=
      '<div class="st-row'+(disabled?' locked':'')+'" id="st-row-'+it.id+'">'+
        '<div class="st-main">'+
          '<div class="st-namecol">'+
            '<div class="st-name">'+stEsc(it.name)+(it.is_added?'<span class="st-tag">added</span>':'')+'</div>'+
            (flat?'<div class="st-muted" style="margin-top:1px">'+stEsc(cat)+'</div>':'')+
            '<div class="st-meta">'+unitCtl+'<span id="st-eff-'+it.id+'">'+stEffText(it)+'</span></div>'+
            stPrevText(it)+
          '</div>'+
          '<div class="st-qtywrap">'+
            '<input class="st-qty" inputmode="decimal" placeholder="0" value="'+qv+'" '+(disabled?'disabled':'')+
              ' onfocus="stFocusRow(\''+it.id+'\',true)" onblur="stFocusRow(\''+it.id+'\',false)" onchange="stSetQty(\''+it.id+'\',this.value)">'+
            '<input class="st-add" id="st-add-'+it.id+'" inputmode="decimal" placeholder="+ add" '+(disabled?'disabled':'')+
              ' title="Add what you just found — it sums onto the count" onfocus="stFocusRow(\''+it.id+'\',true)" onblur="stFocusRow(\''+it.id+'\',false)" onchange="stAddQty(\''+it.id+'\',this.value)">'+
          '</div>'+
          '<span class="st-line" id="st-line-'+it.id+'">'+stMoney(stLineValue(it))+'</span>'+
        '</div>'+
      '</div>';
  });
  c.innerHTML = html;
}

// A remote item-add rebuilds every row. Count edits only commit on blur, so defer
// the rebuild while a quantity field is focused — then refresh once they move on —
// to avoid clearing a number someone is mid-typing. (stUpdateRowUI already guards
// the per-count path the same way via document.activeElement.)
var stRowsTimer = null;
function stSafeRenderRows(){
  var ae = document.activeElement;
  if(ae && ae.classList && (ae.classList.contains('st-qty') || ae.classList.contains('st-add'))){
    clearTimeout(stRowsTimer);
    stRowsTimer = setTimeout(function(){ if(activeStation===STOCK_KEY) stSafeRenderRows(); }, 400);
    return;
  }
  stRenderRows();
}

// yield badge under the name: shows the grossed-up purchase weight once counted
function stEffText(it){
  if(!stIsYield(it)) return '';
  var c=stCounts[it.id], u=stEsc(stItemUnit(it)), p=Math.round(STOCK_YIELD*100);
  if(!c||c.qty==null) return '<span class="st-eff">'+p+'% yield — count the cleaned weight; the system figure adds '+p+'%</span>';
  // show BOTH numbers clearly: what was counted vs the number Aung enters
  return '<span class="st-eff">You counted <b>'+c.qty+'</b> '+u+' · Aung enters <b>'+stEffQtyRound(it,c.qty)+'</b> '+u+' <span style="opacity:.8">(+'+p+'% yield)</span></span>';
}
function stUpdateRowUI(itemId){
  var it = stItems.find(function(x){ return x.id===itemId; });
  if(!it) return;
  var line = document.getElementById('st-line-'+itemId);
  if(line) line.textContent = stMoney(stLineValue(it));
  var eff = document.getElementById('st-eff-'+itemId);
  if(eff) eff.innerHTML = stEffText(it);
  var row = document.getElementById('st-row-'+itemId);
  if(row){ var inp = row.querySelector('.st-qty'); var c=stCounts[itemId];
    if(inp && document.activeElement!==inp){ inp.value = (c&&c.qty!=null)?c.qty:''; } }
}
function stRenderTotals(){
  var g=document.getElementById('st-grand'); if(g) g.textContent = stMoney(stGrandTotal());
  var n=document.getElementById('st-counted'); if(n) n.textContent = stCountedCount();
  var s=document.getElementById('st-catsub'); if(s) s.textContent = stMoney(stCategoryTotal());
  var l=document.getElementById('st-catlabel'); if(l) l.textContent = stCatLabelText();
  var b=document.getElementById('st-cat-btn'); if(b) b.textContent = stCatLabelText()+' ▾';
}

// ── toolbar handlers ──
var stSearchTimer=null;
function stOnSearch(v){ stSearch=v; clearTimeout(stSearchTimer); stSearchTimer=setTimeout(stRenderRows,120); }
// ── category filter: pick as many categories as you like (checkbox popup) ──
function stShowCatFilter(){
  var old=document.getElementById('st-catf-modal'); if(old) old.remove();
  var cats = stCats();
  var box=document.createElement('div');
  box.id='st-catf-modal';
  box.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999';
  var rows = cats.map(function(c){
    var checked = stCatFilters.indexOf(c)>-1 ? ' checked' : '';
    return '<label style="display:flex;align-items:center;gap:8px;padding:7px 4px;font-size:14px;color:#2a1a10">'+
      '<input type="checkbox" class="st-catf-box" value="'+stEsc(c)+'"'+checked+'> '+stEsc(c)+'</label>';
  }).join('');
  box.innerHTML='<div style="background:#fff;border-radius:12px;padding:18px;width:90%;max-width:340px;max-height:80vh;display:flex;flex-direction:column" onclick="event.stopPropagation()">'+
    '<div style="font-weight:700;color:#410207;margin-bottom:10px">Filter by category</div>'+
    '<div style="overflow-y:auto;flex:1;border-top:1px solid #eee2cf;border-bottom:1px solid #eee2cf">'+rows+'</div>'+
    '<div style="display:flex;gap:8px;justify-content:space-between;margin-top:12px">'+
      '<button class="report-btn" onclick="stCatFilterSetAll(this)">Clear (show all)</button>'+
      '<div style="display:flex;gap:8px">'+
        '<button class="report-btn" onclick="document.getElementById(\'st-catf-modal\').remove()">Cancel</button>'+
        '<button class="report-btn" onclick="stApplyCatFilter(this)">Apply</button>'+
      '</div>'+
    '</div></div>';
  box.addEventListener('click', function(){ box.remove(); });
  document.body.appendChild(box);
}
function stCatFilterSetAll(btn){
  var box = btn.closest('#st-catf-modal');
  box.querySelectorAll('.st-catf-box').forEach(function(cb){ cb.checked=false; });
}
function stApplyCatFilter(btn){
  var box = btn.closest('#st-catf-modal');
  var checked = Array.prototype.slice.call(box.querySelectorAll('.st-catf-box:checked')).map(function(cb){ return cb.value; });
  stCatFilters = checked;
  box.remove();
  stRenderRows(); stRenderTotals();
}
function stOnCountFilter(v){ stCountFilter=v; stRenderRows(); }
function stOnSort(v){ stSortBy=v; stRenderRows(); }
// ── lock / unlock a finalized month: once locked, nobody can enter, add-to,
// clear, add-missing-item, or re-upload over this month. Email/Excel/Print
// still work so the cost controller can re-send the final numbers any time. ──
async function stLockMonth(){
  if(!stCanLock()){ if(typeof kToast==='function') kToast('Only Aung\'s code (0000) can lock a month.', true); return; }
  if(!stSheet){ return; }
  if(!confirm('Lock '+stMonth+'?\n\nNobody will be able to enter, add, or clear counts until an admin unlocks it again.')) return;
  var res=await sb.from('stock_take_sheets').update({ locked:true, locked_by:stUser.emp_id, locked_by_name:stUser.name, locked_at:new Date().toISOString() }).eq('id', stSheet.id);
  if(res.error){ if(typeof kToast==='function') kToast('Could not lock: '+res.error.message, true); return; }
  stSheet.locked=true; stSheet.locked_by_name=stUser.name;
  stRender();
  if(typeof kToast==='function') kToast('🔒 '+stMonth+' is now locked.');
}
async function stUnlockMonth(){
  if(!stCanLock()){ if(typeof kToast==='function') kToast('Only Aung\'s code (0000) can unlock a month.', true); return; }
  if(!stSheet){ return; }
  if(!confirm('Unlock '+stMonth+'?\n\nCounts can be entered, added to, or cleared again until it is re-locked.')) return;
  var res=await sb.from('stock_take_sheets').update({ locked:false }).eq('id', stSheet.id);
  if(res.error){ if(typeof kToast==='function') kToast('Could not unlock: '+res.error.message, true); return; }
  stSheet.locked=false;
  stRender();
  if(typeof kToast==='function') kToast('🔓 '+stMonth+' unlocked.');
}

// wipe EVERY quantity entered for this month (all counters) — confirmed first
async function stClearAllCounts(){
  if(!stUser){ if(typeof kToast==='function') kToast('Enter your employee ID first.', true); return; }
  if(!stIsSuper()){ if(typeof kToast==='function') kToast('Only an admin code (1212 / 0000 / 2468) can clear all counts.', true); return; }
  if(stIsLocked()){ if(typeof kToast==='function') kToast('This month is locked — unlock it first to clear counts.', true); return; }
  if(!stCountedCount()){ if(typeof kToast==='function') kToast('Nothing counted yet.'); return; }
  if(!confirm('Clear ALL counts for '+stMonth+'?\n\nThis erases every quantity entered this month — by everyone — and cannot be undone. The item list stays.')) return;
  var res=await sb.from('stock_take_counts').delete().eq('venue_id',STOCK_VENUE).eq('dept',STOCK_DEPT).eq('month',stMonth);
  if(res && res.error){ if(typeof kToast==='function') kToast('Could not clear counts: '+res.error.message, true); return; }
  stCounts={};
  stRender();
  if(typeof kToast==='function') kToast('✓ All counts cleared for '+stMonth+'.');
}
function stFocusRow(itemId, on){ var r=document.getElementById('st-row-'+itemId); if(r) r.classList.toggle('active', on); }
function stPickUnit(itemId, unit){ stUnitSel[itemId]=unit; stUpdateRowUI(itemId); stRenderTotals(); if(stCounts[itemId]&&stCounts[itemId].qty!=null) stSetQty(itemId, stCounts[itemId].qty); }

// ── add a missing item (anyone signed in) ──
function stShowAdd(){
  if(!stUser){ if(typeof kToast==='function') kToast('Enter your employee ID first.', true); return; }
  if(stIsLocked()){ if(typeof kToast==='function') kToast('This month is locked — no items can be added.', true); return; }
  var old=document.getElementById('st-add-modal'); if(old) old.remove();
  var box=document.createElement('div');
  box.id='st-add-modal';
  box.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999';
  box.innerHTML='<div style="background:#fff;border-radius:12px;padding:18px;width:90%;max-width:340px" onclick="event.stopPropagation()">'+
    '<div style="font-weight:700;color:#410207;margin-bottom:10px">Add missing item</div>'+
    '<input class="check-input" id="st-add-name" placeholder="Item name" style="width:100%;height:38px;margin-bottom:8px">'+
    '<div style="display:flex;gap:8px;margin-bottom:8px"><input class="check-input" id="st-add-unit" placeholder="Unit (e.g. Each)" style="flex:1;height:38px">'+
    '<input class="check-input" id="st-add-price" inputmode="decimal" placeholder="Price" style="width:90px;height:38px"></div>'+
    '<div style="display:flex;gap:8px;justify-content:flex-end"><button class="report-btn" onclick="document.getElementById(\'st-add-modal\').remove()">Cancel</button>'+
    '<button class="report-btn" onclick="stAddItem()">Add</button></div></div>';
  box.addEventListener('click', function(){ box.remove(); });
  document.body.appendChild(box);
  setTimeout(function(){ var f=document.getElementById('st-add-name'); if(f) f.focus(); }, 50);
}
async function stAddItem(){
  var name=(document.getElementById('st-add-name').value||'').trim();
  if(!name){ document.getElementById('st-add-name').focus(); return; }
  var unit=(document.getElementById('st-add-unit').value||'').trim();
  var price=Number(document.getElementById('st-add-price').value)||0;
  var cat = stCatFilters.length===1 ? stCatFilters[0] : 'Added items';
  var maxSort = stItems.length ? Math.max.apply(null, stItems.map(function(i){ return i.sort_order||0; })) : 0;
  var res = await sb.from('stock_take_items').insert({
    venue_id:STOCK_VENUE, dept:STOCK_DEPT, month:stMonth, item_group:cat, code:'',
    name:name, unit:unit, price:price, units:[{unit:unit,price:price}],
    sort_order:maxSort+1, is_added:true, added_by:stUser.emp_id, active:true
  }).select().single();
  if(res.error){ if(typeof kToast==='function') kToast('Could not add item: '+res.error.message, true); return; }
  stItems.push(res.data);
  stItems.sort(function(a,b){ return (a.sort_order||0)-(b.sort_order||0); });
  var m=document.getElementById('st-add-modal'); if(m) m.remove();
  stRenderRows();
}

// ── build printable / emailable HTML ──
function stReportHtml(){
  var monLabel = new Date(stMonth+'-01T12:00:00').toLocaleDateString('en-GB',{month:'long',year:'numeric'});
  var byCat = {};
  stItems.forEach(function(it){ var c=stCounts[it.id]; if(!c||c.qty==null) return;
    (byCat[it.item_group||'Other']=byCat[it.item_group||'Other']||[]).push(it); });
  var cats = Object.keys(byCat);
  var grand = stGrandTotal();
  var body = cats.length ? cats.map(function(cat){
    var rows = byCat[cat].map(function(it){
      var c=stCounts[it.id];
      var yld = stIsYield(it) ? ' <span style="color:#7a4a00;font-size:11px">('+Math.round(STOCK_YIELD*100)+'% yield)</span>' : '';
      return '<tr><td style="padding:5px 8px;border-bottom:1px solid #ddd">'+stEsc(it.name)+yld+'</td>'+
        '<td style="padding:5px 8px;border-bottom:1px solid #ddd;text-align:right">'+stDisplayQty(it)+' '+stEsc(stItemUnit(it))+'</td>'+
        '<td style="padding:5px 8px;border-bottom:1px solid #ddd;text-align:right">'+stMoney(stItemPrice(it))+'</td>'+
        '<td style="padding:5px 8px;border-bottom:1px solid #ddd;text-align:right;font-weight:bold">'+stMoney(stLineValue(it))+'</td></tr>';
    }).join('');
    var catTotal = byCat[cat].reduce(function(t,it){ return t+stLineValue(it); },0);
    return '<tr><td colspan="4" style="background:#410207;color:#f5ede0;font-size:11px;letter-spacing:1.2px;padding:6px 8px;text-transform:uppercase">'+stEsc(cat)+' — '+stMoney(catTotal)+'</td></tr>'+rows;
  }).join('') : '<tr><td colspan="4" style="padding:20px;text-align:center">Nothing counted yet.</td></tr>';
  return {
    countedLines: stCountedCount(),
    html: '<div style="font-family:Arial,Helvetica,sans-serif;color:#2a1a10;max-width:680px">'+
      '<h1 style="font-family:Georgia,serif;color:#410207;margin:0 0 2px">Roberto\'s — Kitchen Stock Take</h1>'+
      '<div style="font-size:13px;color:#7a1218;margin-bottom:6px">'+stEsc(monLabel)+' · '+stCountedCount()+' of '+stItems.length+' items counted</div>'+
      '<div style="font-size:16px;color:#410207;font-weight:bold;margin-bottom:12px">Total stock value: '+stMoney(grand)+'</div>'+
      '<table style="border-collapse:collapse;width:100%;font-size:13px"><thead><tr>'+
        '<th style="text-align:left;padding:5px 8px;border-bottom:2px solid #410207">Item</th>'+
        '<th style="text-align:right;padding:5px 8px;border-bottom:2px solid #410207">Counted</th>'+
        '<th style="text-align:right;padding:5px 8px;border-bottom:2px solid #410207">Price</th>'+
        '<th style="text-align:right;padding:5px 8px;border-bottom:2px solid #410207">Value</th></tr></thead>'+
        '<tbody>'+body+'</tbody></table>'+
      '<div style="font-size:11px;color:#999;margin-top:14px">Sent from Roberto\'s Kitchen App · Stock Take</div></div>'
  };
}

// ── Excel export (matches the cost controller's layout so it drops back in) ──
function stExcelAoa(){
  var monLabel = new Date(stMonth+'-01T12:00:00').toLocaleDateString('en-GB',{month:'long',year:'numeric'});
  var aoa = [["ROBERTO'S DIFC"], ['Stock Take List - Kitchen — '+monLabel], [],
    ['Item Group','Article','Article Name','Unit','Ave.Price','Qty','Total Value']];
  var grand = 0;
  stItems.forEach(function(it){
    var c = stCounts[it.id];
    // Qty = originally-purchased weight (grossed up for yield items) so Qty×Price = Value.
    // This IS the number Aung enters — already converted, no note or math needed from him.
    // Article Name is left EXACTLY as supplied (no appended text) so it still matches
    // his system's article lookup if he cross-references by name, not just by code.
    var qty = (c && c.qty!=null) ? stDisplayQty(it) : '';
    var price = stItemPrice(it);
    var val = qty==='' ? 0 : Math.round(qty*price*100)/100;
    grand += val;
    aoa.push([it.item_group||'', it.code||'', it.name, stItemUnit(it), price, qty, val]);
  });
  aoa.push([]);
  aoa.push(['','','','','','TOTAL', Math.round(grand*100)/100]);
  return aoa;
}
function stExcelBook(){
  var ws = XLSX.utils.aoa_to_sheet(stExcelAoa());
  ws['!cols'] = [{wch:22},{wch:12},{wch:42},{wch:16},{wch:10},{wch:8},{wch:12}];
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Kitchen');
  return wb;
}
function stExcelName(){ return "Roberto's Kitchen Stock Take "+stMonth+".xlsx"; }
async function stExportExcel(){
  try{
    await stLoadXLSX();
    XLSX.writeFile(stExcelBook(), stExcelName());
  }catch(e){ if(typeof kToast==='function') kToast('Could not build Excel: '+e.message, true); else alert('Could not build Excel: '+e.message); }
}

// ── print ──
function stPrint(){
  var out = stReportHtml();
  var w = window.open('','_blank');
  if(!w){ alert('Pop-up blocked — allow pop-ups to print.'); return; }
  w.document.write('<html><head><title>Roberto\'s Kitchen Stock Take</title></head><body style="margin:28px">'+out.html+'</body></html>');
  w.document.close(); w.focus(); setTimeout(function(){ w.print(); }, 250);
}

// ── review & send: choose Excel attachment OR the in-app digital layout ──
function stReviewSend(){
  if(!stCountedCount()){ alert('Nothing counted yet — enter some quantities first.'); return; }
  var old=document.getElementById('st-send-modal'); if(old) old.remove();
  var box=document.createElement('div');
  box.id='st-send-modal';
  box.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999';
  box.innerHTML='<div style="background:#fff;border-radius:12px;padding:18px;width:90%;max-width:360px" onclick="event.stopPropagation()">'+
    '<div style="font-weight:700;color:#410207;margin-bottom:4px">Send stock take to Aung</div>'+
    '<div style="font-size:12px;color:#8a7a55;margin-bottom:14px">cc Danilo, Antonio, Asarudeen &amp; you. Choose a format:</div>'+
    '<button class="report-btn" style="width:100%;margin-bottom:10px;text-align:left" onclick="stSendEmail(\'excel\')"><b>Excel file</b><br><span style="font-size:11px;color:#8a7a55">attached spreadsheet — for Aung\'s system</span></button>'+
    '<button class="report-btn" style="width:100%;margin-bottom:14px;text-align:left" onclick="stSendEmail(\'digital\')"><b>Digital format</b><br><span style="font-size:11px;color:#8a7a55">the in-app layout, inside the email</span></button>'+
    '<div id="st-send-status" style="font-size:12px;min-height:16px;color:#7a1218;margin-bottom:8px"></div>'+
    '<div style="display:flex;justify-content:flex-end"><button class="report-btn" onclick="document.getElementById(\'st-send-modal\').remove()">Cancel</button></div></div>';
  box.addEventListener('click', function(){ box.remove(); });
  document.body.appendChild(box);
}
async function stSendEmail(mode){
  var statusEl=document.getElementById('st-send-status');
  var monLabel = new Date(stMonth+'-01T12:00:00').toLocaleDateString('en-GB',{month:'long',year:'numeric'});
  var body={ to:STOCK_EMAIL_TO, cc:STOCK_EMAIL_CC, subject:'Kitchen Stock Take — '+monLabel };
  try{
    if(statusEl){ statusEl.style.color='#8a7a55'; statusEl.textContent='Sending…'; }
    if(mode==='excel'){
      await stLoadXLSX();
      body.html='<p style="font-family:Arial,Helvetica,sans-serif;color:#2a1a10">Please find attached the Kitchen Stock Take for '+monLabel+'.<br>Total stock value: <b>'+stMoney(stGrandTotal())+'</b> · '+stCountedCount()+' of '+stItems.length+' items counted.</p>';
      body.attachments=[{ filename:stExcelName(), content:XLSX.write(stExcelBook(), {type:'base64', bookType:'xlsx'}) }];
    } else {
      body.html=stReportHtml().html;
    }
    var r=await fetch(SUPABASE_URL+'/functions/v1/send-stock-take', { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_KEY}, body:JSON.stringify(body) });
    var d=await r.json().catch(function(){return{};});
    if(r.ok){ var m=document.getElementById('st-send-modal'); if(m) m.remove(); if(typeof kToast==='function') kToast('✓ Sent to Aung ('+(mode==='excel'?'Excel':'digital')+').'); else alert('Sent.'); }
    else if(statusEl){ statusEl.style.color='#7a1218'; statusEl.textContent='Send failed: '+(d.error||r.status); }
  }catch(e){ if(statusEl){ statusEl.style.color='#7a1218'; statusEl.textContent='Send failed: '+e.message; } }
}

// ── employee-ID gate / signed-in chip (shared by full + empty states) ──
function stGateHtml(){
  return stUser
    ? '<div class="st-who"><span><span style="color:#1d7a4a">●</span> Counting as <b>'+stEsc(stUser.name)+'</b> · #'+stEsc(stUser.emp_id)+'</span>'+
      '<button class="report-btn" onclick="stSignOut()">Switch</button></div>'
    : '<div class="st-gate"><div><b>Enter your employee ID to count</b></div>'+
      '<div style="display:flex;gap:8px;margin-top:8px"><input class="check-input" id="st-empid" inputmode="numeric" placeholder="e.g. 1042" style="flex:1" onkeydown="if(event.key===\'Enter\')stSignIn()">'+
      '<button class="report-btn" onclick="stSignIn()">Start</button></div></div>';
}

// ══ Excel upload — anyone with a valid employee ID loads the new month's list ══
function stLoadXLSX(){
  if(window.XLSX) return Promise.resolve();
  var url='https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  if(typeof lazyLoad==='function') return lazyLoad(url);
  return new Promise(function(res,rej){ var s=document.createElement('script'); s.src=url; s.onload=res; s.onerror=rej; document.body.appendChild(s); });
}
// guess 'YYYY-MM' from a dd.mm.yyyy in the first rows (e.g. "as of 31.05.2026")
function stGuessMonth(rows){
  for(var r=0;r<Math.min(6,rows.length);r++){
    var line=(rows[r]||[]).join(' ');
    var m=line.match(/(\d{2})[.\/](\d{2})[.\/](\d{4})/);
    if(m) return m[3]+'-'+m[2];
  }
  var d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
}
function stShowUpload(){
  if(!stUser){ if(typeof kToast==='function') kToast('Enter your employee ID first.', true); return; }
  if(!stIsSuper()){ if(typeof kToast==='function') kToast('Only an admin code (1212 / 0000 / 2468) can upload/replace the month\'s list.', true); return; }
  var old=document.getElementById('st-up-modal'); if(old) old.remove();
  var box=document.createElement('div');
  box.id='st-up-modal';
  box.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999';
  box.innerHTML='<div style="background:#fff;border-radius:12px;padding:18px;width:90%;max-width:360px" onclick="event.stopPropagation()">'+
    '<div style="font-weight:700;color:#410207;margin-bottom:6px">Upload month\'s stock take</div>'+
    '<div style="font-size:12px;color:#8a7a55;margin-bottom:10px">Pick the Excel file the cost controller sent (.xls or .xlsx). It becomes this month\'s count sheet.</div>'+
    '<input type="file" id="st-up-file" accept=".xls,.xlsx" style="width:100%;margin-bottom:10px" onchange="stUploadPreview()">'+
    '<label style="font-size:12px;color:#8a7a55">Month</label>'+
    '<input class="check-input" id="st-up-month" type="month" style="width:100%;height:38px;margin:4px 0 12px">'+
    '<div id="st-up-status" style="font-size:12px;color:#7a1218;min-height:16px;margin-bottom:8px"></div>'+
    '<div style="display:flex;gap:8px;justify-content:flex-end"><button class="report-btn" onclick="document.getElementById(\'st-up-modal\').remove()">Cancel</button>'+
    '<button class="report-btn" id="st-up-go" onclick="stHandleUpload()">Upload</button></div></div>';
  box.addEventListener('click', function(){ box.remove(); });
  document.body.appendChild(box);
  var d=new Date(); document.getElementById('st-up-month').value=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
}
// peek at the chosen file to auto-fill the month + an item-count preview
async function stUploadPreview(){
  var statusEl=document.getElementById('st-up-status');
  var f=document.getElementById('st-up-file').files[0]; if(!f) return;
  try{
    statusEl.style.color='#8a7a55'; statusEl.textContent='Reading…';
    await stLoadXLSX();
    var rows=stReadRows(await f.arrayBuffer());
    var guess=stGuessMonth(rows); var monthEl=document.getElementById('st-up-month'); if(guess) monthEl.value=guess;
    var items=stParseRows(rows);
    statusEl.textContent=items.length?(items.length+' items found for '+monthEl.value+'.'):'No items found — is this the right file?';
  }catch(e){ statusEl.style.color='#7a1218'; statusEl.textContent='Could not read: '+e.message; }
}
function stReadRows(buf){
  var wb=XLSX.read(new Uint8Array(buf), {type:'array'});
  var ws=wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, {header:1, raw:true, defval:''});
}
function stParseRows(rows){
  var hdr=-1;
  for(var r=0;r<rows.length;r++){
    var joined=(rows[r]||[]).join('|').toLowerCase();
    if(joined.indexOf('item group')>-1 && joined.indexOf('article')>-1){ hdr=r; break; }
  }
  var start=hdr>-1?hdr+1:0, items=[];
  for(var i=start;i<rows.length;i++){
    var c=rows[i]||[];
    var group=(c[0]==null?'':String(c[0])).trim();
    var code=(c[1]==null?'':String(c[1])).trim();
    var name=(c[2]==null?'':String(c[2])).trim();
    var unit=(c[3]==null?'':String(c[3])).trim();
    var price=Math.round((Number(c[4])||0)*100)/100;
    var isAlt=(code===''||code==='0')&&name==='';
    if(isAlt){ if(items.length) items[items.length-1].units.push({unit:unit,price:price}); continue; }
    if(name==='') continue;
    items.push({item_group:group,code:code,name:name,unit:unit,price:price,units:[{unit:unit,price:price}],sort_order:items.length+1});
  }
  return items;
}
async function stHandleUpload(){
  var statusEl=document.getElementById('st-up-status');
  var f=document.getElementById('st-up-file').files[0];
  if(!f){ statusEl.style.color='#7a1218'; statusEl.textContent='Choose a file first.'; return; }
  try{
    statusEl.style.color='#8a7a55'; statusEl.textContent='Reading file…';
    await stLoadXLSX();
    var rows=stReadRows(await f.arrayBuffer());
    var month=document.getElementById('st-up-month').value||stGuessMonth(rows);
    var items=stParseRows(rows);
    if(!items.length){ statusEl.style.color='#7a1218'; statusEl.textContent='No items found — is this the right file?'; return; }
    statusEl.textContent='Saving '+items.length+' items for '+month+'…';
    await stApplyUpload(month, items, f.name);
    var m=document.getElementById('st-up-modal'); if(m) m.remove();
    if(typeof kToast==='function') kToast('✓ Loaded '+items.length+' items for '+month+'.');
  }catch(e){
    if(String(e.message)==='cancelled'){ statusEl.textContent='Cancelled.'; return; }
    statusEl.style.color='#7a1218'; statusEl.textContent='Upload failed: '+e.message;
  }
}
async function stApplyUpload(month, items, filename){
  var existing=await sb.from('stock_take_sheets').select('id,locked').eq('venue_id',STOCK_VENUE).eq('dept',STOCK_DEPT).eq('month',month).limit(1);
  if(existing.data && existing.data.length){
    if(existing.data[0].locked) throw new Error(month+' is LOCKED — an admin must unlock it before it can be replaced.');
    if(!confirm('A stock take for '+month+' already exists. Replacing it clears any counts already entered for that month. Continue?')) throw new Error('cancelled');
  }
  // supabase-js never throws — check each destructive step's .error and abort
  // BEFORE the next one, so a blocked delete can't leave the month half-wiped
  // (new items against stale counts = wrong totals shown as real). Mirrors FOH.
  var dC=await sb.from('stock_take_counts').delete().eq('venue_id',STOCK_VENUE).eq('dept',STOCK_DEPT).eq('month',month);
  if(dC.error) throw new Error('Could not clear old counts: '+dC.error.message);
  var dI=await sb.from('stock_take_items').delete().eq('venue_id',STOCK_VENUE).eq('dept',STOCK_DEPT).eq('month',month);
  if(dI.error) throw new Error('Could not clear old items: '+dI.error.message);
  var dS=await sb.from('stock_take_sheets').delete().eq('venue_id',STOCK_VENUE).eq('dept',STOCK_DEPT).eq('month',month);
  if(dS.error) throw new Error('Could not clear old sheet: '+dS.error.message);
  var iS=await sb.from('stock_take_sheets').insert({ venue_id:STOCK_VENUE, dept:STOCK_DEPT, month:month, status:'counting', source_filename:filename, item_count:items.length, uploaded_by:stUser.emp_id, uploaded_by_name:stUser.name });
  if(iS.error) throw new Error('Could not create the sheet: '+iS.error.message);
  var rowsToInsert=items.map(function(it){ return { venue_id:STOCK_VENUE, dept:STOCK_DEPT, month:month, item_group:it.item_group, code:it.code, name:it.name, unit:it.unit, price:it.price, units:it.units, sort_order:it.sort_order, active:true }; });
  for(var i=0;i<rowsToInsert.length;i+=500){
    var res=await sb.from('stock_take_items').insert(rowsToInsert.slice(i,i+500));
    if(res.error) throw new Error(res.error.message);
  }
  stMonth=month; stUnitSel={};
  await stLoadItems(); await stLoadCounts(); await stLoadPrevMonth();
  stSubscribe(); stRender();
}

// ── entry point (replaces the lazy-load shim in index.html) ──
async function openStockTake(){
  activeStation = STOCK_KEY;
  hideAllPages();
  document.getElementById('stocktake-view').style.display='block';
  document.querySelector('.footer-bar').style.display='flex';
  document.getElementById('foot-label').textContent='Stock Take';
  stInjectCss();
  document.getElementById('stocktake-view').innerHTML='<div style="padding:40px;text-align:center;opacity:.6">Loading stock take…</div>';
  await stLoadSheet();
  await stLoadItems();
  await stLoadCounts();
  await stLoadPrevMonth();
  stSubscribe();
  stRender();
}

// ══════════════════════════════════════════════════════════════════════════
// VOICE COUNT (hands-free) — say "item + quantity", e.g. "Grey Goose four".
// ANDROID-ONLY: uses the Web Speech API (webkitSpeechRecognition), which Apple
// does NOT support in web apps — so the 🎤 button only renders where it works
// (feature-detected in stRender). iPhone users keep the keyboard mic.
// SAFETY: it NEVER saves on its own — it always shows a confirm card where the
// person checks/edits the item + quantity first (a mishear can't silently log to
// the wrong item). The quantity ADDS to the running count via the atomic +add.
// Mirrored verbatim from foh-diagnostic/stock-take.js (FOH voice count).
// ══════════════════════════════════════════════════════════════════════════
function stVoiceSupported(){ return ('SpeechRecognition' in window) || ('webkitSpeechRecognition' in window); }

var ST_ONES={zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19};
var ST_TENS={twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90};
var ST_UNITS={bottles:1,bottle:1,btl:1,each:1,kg:1,kilo:1,kilos:1,piece:1,pieces:1,pcs:1,pc:1,unit:1,units:1,case:1,cases:1,box:1,boxes:1,can:1,cans:1,gram:1,grams:1,litre:1,litres:1,liter:1,liters:1,ltr:1,glass:1,glasses:1};
function stIsNumWord(t){ return (t in ST_ONES) || (t in ST_TENS) || t==='point' || /^\d+(\.\d+)?$/.test(t); }
function stIntWords(tokens){
  if(!tokens.length) return null;
  if(tokens.length===1 && /^\d+$/.test(tokens[0])) return parseInt(tokens[0],10);
  var total=0, any=false;
  for(var k=0;k<tokens.length;k++){ var w=tokens[k];
    if(w in ST_TENS){ total+=ST_TENS[w]; any=true; }
    else if(w in ST_ONES){ total+=ST_ONES[w]; any=true; }
    else if(/^\d+$/.test(w)){ total+=parseInt(w,10); any=true; }
    else if(w==='a'||w==='an'){ /* skip filler */ }
    else return null;
  }
  return any?total:null;
}
function stPhraseToNumber(tokens){
  if(!tokens || !tokens.length) return null;
  var pIdx=tokens.indexOf('point');
  if(pIdx>=0){
    var iv=stIntWords(tokens.slice(0,pIdx));
    var dec=tokens.slice(pIdx+1).map(function(x){ return (x in ST_ONES)?ST_ONES[x]:(/^\d$/.test(x)?+x:null); });
    if(dec.some(function(x){return x===null;})) return null;
    return (iv||0) + (dec.length?parseFloat('0.'+dec.join('')):0);
  }
  if(tokens.length===1 && /^\d+(\.\d+)?$/.test(tokens[0])) return parseFloat(tokens[0]);
  return stIntWords(tokens);
}
// pull a quantity + an item-name out of a spoken phrase (handles either order)
function stVoiceExtract(transcript){
  var s=(transcript||'').toLowerCase();
  s=s.replace(/\band a half\b/g,' point five').replace(/\band a quarter\b/g,' point two five').replace(/\band three quarters\b/g,' point seven five').replace(/\bhalf\b/g,' point five');
  s=s.replace(/[,]/g,' ');
  var toks=s.split(/\s+/).filter(Boolean).filter(function(t){ return !ST_UNITS[t]; });
  var qty=null, name='';
  // trailing number run
  var st=toks.length; while(st>0 && stIsNumWord(toks[st-1])) st--;
  var run=toks.slice(st);
  if(run.length){
    var hasPoint=run.indexOf('point')>=0 || run.some(function(x){return /\d\.\d/.test(x);});
    var tensOnes=run.length===2 && (run[0] in ST_TENS) && (run[1] in ST_ONES);
    if(run.length===1 || hasPoint || tensOnes){ qty=stPhraseToNumber(run); name=toks.slice(0,st).join(' '); }
    else { qty=stPhraseToNumber([run[run.length-1]]); name=toks.slice(0,toks.length-1).join(' '); }  // protect names with numbers (e.g. "Macallan 12")
  } else {
    // maybe number-first ("four grey goose")
    var ls=0; while(ls<toks.length && stIsNumWord(toks[ls])) ls++;
    if(ls>0 && ls<toks.length){ qty=stPhraseToNumber(toks.slice(0,ls)); name=toks.slice(ls).join(' '); }
    else name=toks.join(' ');
  }
  return { qty:qty, name:name.trim() };
}
// normalise an item name for matching (drop the trailing " -code", punctuation)
// normalise + DROP ACCENTS so a French/Italian name spoken in English still
// matches: château->chateau, gewürztraminer->gewurztraminer, espadón->espadon.
function stVoiceNorm(s){
  s=String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
  return s.replace(/\s+-\s*\w+\s*$/,'').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
}
// tiny edit-distance (capped) so a near-mishear still matches (montalchino~montalcino)
function stLev(a,b){ var m=a.length,n=b.length; if(Math.abs(m-n)>3) return 9; var d=[],i,j; for(i=0;i<=m;i++)d[i]=[i]; for(j=0;j<=n;j++)d[0][j]=j; for(i=1;i<=m;i++)for(j=1;j<=n;j++){ var c=a.charAt(i-1)===b.charAt(j-1)?0:1; d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+c);} return d[m][n]; }
// loose phonetic key so a sound-alike transcription still matches:
// "sassicaia" and "sasi kaya" both reduce to "sasikaia".
function stPhon(s){
  s=stVoiceNorm(s).replace(/[0-9]/g,'').replace(/\s+/g,'');
  s=s.replace(/ck/g,'k').replace(/q/g,'k').replace(/c/g,'k').replace(/x/g,'ks').replace(/ph/g,'f').replace(/z/g,'s').replace(/y/g,'i').replace(/h/g,'');
  return s.replace(/(.)\1+/g,'$1');
}
function stTokenHit(qt, nts, n){
  if(n.indexOf(qt)>=0) return true;                                        // substring
  var pq=stPhon(qt);
  for(var i=0;i<nts.length;i++){ var w=nts[i];
    if(w.length>=4 && qt.length>=4 && (w.indexOf(qt)===0||qt.indexOf(w)===0)) return true;   // prefix either way
    if(qt.length>=4 && stLev(qt,w)<=Math.max(1,Math.floor(qt.length/4))) return true;        // close mishear
    if(pq.length>=3){ var pw=stPhon(w);                                                       // sound-alike
      if(pw.length>=3 && (pw.indexOf(pq)>=0 || pq.indexOf(pw)===0 || stLev(pq,pw)<=1)) return true; }
  }
  return false;
}
// best item candidates for a spoken name, within the current dept's list
function stVoiceMatch(query){
  var q=stVoiceNorm(query); if(!q) return [];
  var qt=q.split(' ').filter(function(t){ return t.length>1; }); if(!qt.length) qt=[q];
  var scored=[];
  stItems.forEach(function(it){
    var n=stVoiceNorm(it.name); if(!n) return; var nts=n.split(' ');
    var hit=0; qt.forEach(function(t){ if(stTokenHit(t,nts,n)) hit++; });
    var score=hit/qt.length;
    if(n.indexOf(q)>=0) score+=0.5;
    if(nts[0]===qt[0]) score+=0.15;
    if(score>=0.5) scored.push({it:it,score:score});
  });
  scored.sort(function(a,b){ return b.score-a.score; });
  return scored.slice(0,30).map(function(x){ return x.it; });   // show ALL matches (e.g. every "juice"), not just the top few
}

var stRec=null, stVFinal='', stVInterim='', stVDone=false, stVoiceMode='full', stVoiceLang='en-GB';
var stVoiceCands=[];
// mode 'full' = item + quantity in one go; mode 'qty' = just the number, into the
// already-open confirm card (so you can say the product first, then the quantity).
function stVoiceStart(mode){
  if(!stUser){ kToast('Enter your employee ID first.', true); return; }
  if(stIsLocked()){ kToast('This month is locked — counts can no longer be changed.', true); return; }
  var SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){ kToast('Voice needs Android Chrome. On iPhone, tap a box and use the keyboard mic.', true); return; }
  stVoiceMode = (mode==='qty') ? 'qty' : 'full';
  if(stVoiceMode!=='qty'){ var old=document.getElementById('st-voice-modal'); if(old) old.remove(); }  // qty mode keeps the confirm card open
  try{ if(stRec) stRec.abort(); }catch(e){}
  stVFinal=''; stVInterim=''; stVDone=false;
  stVoiceShowListening(stVoiceMode);
  // continuous + interim: don't rush the speaker; show live text; act only on Done
  stRec=new SR(); stRec.lang=stVoiceLang; stRec.continuous=true; stRec.interimResults=true; stRec.maxAlternatives=1;
  stRec.onresult=function(e){
    stVFinal=''; stVInterim='';
    for(var i=0;i<e.results.length;i++){ var r=e.results[i]; if(r.isFinal) stVFinal+=r[0].transcript+' '; else stVInterim+=r[0].transcript; }
    var el=document.getElementById('st-listen-text'); if(el) el.textContent=(stVFinal+stVInterim).trim()||'…';
  };
  stRec.onerror=function(e){ if(e.error==='aborted') return; stVDone=true; stVoiceCloseListening();
    if(e.error==='not-allowed'||e.error==='service-not-allowed') kToast('Allow microphone access to use voice.', true);
    else if(e.error==='no-speech') kToast('Didn\'t catch anything — tap 🎤 and try again.', true);
    else kToast('Voice error: '+e.error, true); };
  stRec.onend=function(){ if(stVDone) return; stVDone=true; stVoiceCloseListening(); var t=(stVFinal+' '+stVInterim).trim(); if(t) stVoiceRoute(t); };
  try{ stRec.start(); }catch(err){ stVoiceCloseListening(); kToast('Could not start voice — try again.', true); }
}
function stVoiceStop(){ if(stVDone) return; stVDone=true; var t=(stVFinal+' '+stVInterim).trim(); try{ if(stRec) stRec.stop(); }catch(e){} stVoiceCloseListening(); if(t) stVoiceRoute(t); else kToast('Didn\'t catch anything — tap 🎤 and try again.', true); }
function stVoiceRoute(t){ if(stVoiceMode==='qty') stVoiceFillQty(t); else stVoiceHandle(t); }
function stVoiceFillQty(transcript){
  var ex=stVoiceExtract(transcript); var q=ex.qty;
  if(q==null){ var n=parseFloat(String(transcript).replace(/[^0-9.]/g,'')); if(!isNaN(n)) q=n; }
  if(q==null || isNaN(q)){ kToast('Didn\'t catch a number — say just the quantity, e.g. "twenty four".', true); return; }
  var box=document.getElementById('st-voice-qty'); if(box) box.value=q;
}
function stVoiceCancel(){ stVDone=true; try{ if(stRec) stRec.abort(); }catch(e){} stVoiceCloseListening(); }
function stVoiceShowListening(mode){
  var old=document.getElementById('st-listen-modal'); if(old) old.remove();
  var sub = (mode==='qty') ? 'Say just the quantity, e.g. "twenty four", then tap <b>Done</b>.' : 'Say the item and how many, then tap <b>Done</b>.';
  var b=document.createElement('div'); b.id='st-listen-modal'; b.className='st-modal';
  b.innerHTML='<div class="st-modal-box" style="text-align:center" onclick="event.stopPropagation()">'+
    '<div style="font-size:42px;line-height:1">🎤</div>'+
    '<div style="font-weight:700;color:#410207;margin:8px 0 4px">Listening… take your time</div>'+
    '<div style="font-size:12px;color:#8a7a55;margin-bottom:8px">'+sub+'</div>'+
    '<div id="st-listen-text" style="min-height:22px;font-size:15px;color:#2a1a10;background:#f7f1e6;border-radius:8px;padding:8px;margin-bottom:12px">…</div>'+
    '<div style="display:flex;gap:8px;justify-content:center"><button class="st-btn" style="flex:none" onclick="stVoiceCancel()">Cancel</button>'+
    '<button class="st-btn" style="flex:none;background:#410207;color:#f5ede0" onclick="stVoiceStop()">Done</button></div></div>';
  document.body.appendChild(b);
}
function stVoiceCloseListening(){ var m=document.getElementById('st-listen-modal'); if(m) m.remove(); }
function stVoiceHandle(transcript){
  stVoiceCloseListening();
  var ex=stVoiceExtract(transcript);
  stVoiceCands=stVoiceMatch(ex.name);
  stVoiceShowConfirm(transcript, ex.qty, stVoiceCands);
}
// the CONFIRM card — nothing saves until the person taps Add here
function stVoiceShowConfirm(heard, qty, cands){
  var old=document.getElementById('st-voice-modal'); if(old) old.remove();
  var opts = cands.length
    ? cands.map(function(it,i){ var c=stCounts[it.id]; var now=(c&&c.qty!=null)?(' — now '+c.qty):''; return '<option value="'+i+'">'+stEsc(it.name)+now+'</option>'; }).join('')
    : '<option value="-1">No match — close and search by hand</option>';
  var qv = (qty==null||isNaN(qty)) ? '' : qty;
  var b=document.createElement('div'); b.id='st-voice-modal'; b.className='st-modal';
  b.innerHTML='<div class="st-modal-box" onclick="event.stopPropagation()">'+
    '<div style="font-weight:700;color:#410207;margin-bottom:4px">Check before saving</div>'+
    '<div style="font-size:12px;color:#8a7a55;margin-bottom:12px">Heard: "'+stEsc(heard)+'"</div>'+
    '<label style="font-size:12px;color:#8a7a55">Item'+(cands.length>1?' — '+cands.length+' matches, pick the right one':'')+'</label>'+
    '<select id="st-voice-item" class="st-select" style="width:100%;height:40px;margin:4px 0 12px">'+opts+'</select>'+
    '<label style="font-size:12px;color:#8a7a55">Add this many</label>'+
    '<div style="display:flex;gap:8px;margin:4px 0 14px"><input id="st-voice-qty" class="st-input" inputmode="decimal" value="'+qv+'" placeholder="how many" style="flex:1;height:40px">'+
      '<button class="st-btn" style="flex:none" onclick="stVoiceStart(\'qty\')">🎤 Say number</button></div>'+
    '<div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">'+
      '<button class="st-btn" style="flex:none" onclick="document.getElementById(\'st-voice-modal\').remove()">Cancel</button>'+
      '<button class="st-btn" style="flex:none" onclick="stVoiceStart()">🎤 Try again</button>'+
      '<button class="st-btn" style="flex:none;background:#410207;color:#f5ede0" onclick="stVoiceAdd()">Add</button>'+
    '</div></div>';
  document.body.appendChild(b);
}
function stVoiceAdd(){
  var sel=document.getElementById('st-voice-item'); if(!sel) return;
  var i=parseInt(sel.value,10);
  if(isNaN(i) || i<0 || !stVoiceCands[i]){ kToast('No item picked — close and search by hand.', true); return; }
  var qty=parseFloat(((document.getElementById('st-voice-qty').value||'').trim()).replace(',', '.'));
  if(isNaN(qty) || qty<=0){ kToast('Enter how many to add.', true); return; }
  var it=stVoiceCands[i];
  var m=document.getElementById('st-voice-modal'); if(m) m.remove();
  stAddQty(it.id, qty);                 // atomic +add path (server sums, realtime fans out)
  kToast('✓ Added '+qty+' to '+it.name);
}
