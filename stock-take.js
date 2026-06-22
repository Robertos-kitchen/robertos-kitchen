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
var STOCK_EMAIL_CC = ['dvalla@robertos.ae','astellacci@robertos.ae','amohamed@robertos.ae','francescoguarracino@hotmail.com'];

// ── state ──
var stSheet   = null;        // { month, status, ... }
var stMonth   = null;        // 'YYYY-MM'
var stItems   = [];          // [{id,item_group,code,name,unit,price,units,is_added}]
var stCounts  = {};          // item_id -> { qty, unit, counted_by, counted_by_name }
var stUser    = null;        // { emp_id, name }  (null until signed in)
var stSearch  = '';
var stCatFilter = '';
var stUnitSel = {};          // item_id -> chosen unit (for 2-unit items)
var stChannel = null;

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

// ── data load ──
async function stLoadSheet(){
  var res = await sb.from('stock_take_sheets').select('*')
    .eq('venue_id',STOCK_VENUE).eq('dept',STOCK_DEPT)
    .order('month',{ascending:false}).limit(1);
  stSheet = (res.data && res.data[0]) || null;
  stMonth = stSheet ? stSheet.month : null;
}
async function stLoadItems(){
  if(!stMonth){ stItems = []; return; }
  var res = await sb.from('stock_take_items').select('*')
    .eq('venue_id',STOCK_VENUE).eq('dept',STOCK_DEPT).eq('month',stMonth)
    .eq('active',true).order('sort_order');
  stItems = res.data || [];
}
async function stLoadCounts(){
  stCounts = {};
  if(!stMonth) return;
  var res = await sb.from('stock_take_counts').select('*')
    .eq('venue_id',STOCK_VENUE).eq('dept',STOCK_DEPT).eq('month',stMonth);
  (res.data||[]).forEach(function(r){
    stCounts[r.item_id] = { qty:r.qty, unit:r.unit, counted_by:r.counted_by, counted_by_name:r.counted_by_name };
    if(r.unit) stUnitSel[r.item_id] = r.unit;
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
      function(){ if(activeStation===STOCK_KEY){ stLoadItems().then(function(){ if(activeStation===STOCK_KEY) stRenderRows(); }); } })
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
  var prev = stCounts[itemId] ? Object.assign({}, stCounts[itemId]) : null;
  var qty = value === '' ? null : Number(value);
  var it = stItems.find(function(x){ return x.id===itemId; });
  var unit = it ? stItemUnit(it) : null;
  var res;
  if(qty===null || isNaN(qty) || qty < 0){
    delete stCounts[itemId];
    res = await sb.from('stock_take_counts').delete().eq('item_id', itemId);
  } else {
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

// ── derived ──
function stFilteredItems(){
  var q = stSearch.toLowerCase();
  return stItems.filter(function(it){
    if(stCatFilter && it.item_group !== stCatFilter) return false;
    if(q && it.name.toLowerCase().indexOf(q)===-1 && String(it.code||'').indexOf(q)===-1) return false;
    return true;
  });
}
function stCats(){ return Array.from(new Set(stItems.map(function(i){ return i.item_group||'Other'; }))); }
function stLineValue(it){ var c = stCounts[it.id]; if(!c||c.qty==null) return 0; return stItemPrice(it)*Number(c.qty); }
function stGrandTotal(){ var t=0; stItems.forEach(function(it){ t+=stLineValue(it); }); return t; }
function stCountedCount(){ var n=0; stItems.forEach(function(it){ var c=stCounts[it.id]; if(c&&c.qty!=null) n++; }); return n; }
function stCategoryTotal(){ var t=0; stItems.forEach(function(it){ if(!stCatFilter||it.item_group===stCatFilter) t+=stLineValue(it); }); return t; }

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
    '.st-meta{margin-top:4px}'+
    '.st-muted{font-size:12px;color:#8a7a55}'+
    '.st-qty{justify-self:center;width:72px;height:38px;text-align:center;border:1px solid #c9a84c;border-radius:8px;font-size:16px;background:#fff}'+
    '.st-unit{height:30px;background:#e1d3c2;border:1px solid #cbb892;border-radius:6px;font-size:12px;color:#8a7a55;max-width:160px;padding:0 4px}'+
    '.st-line{justify-self:end;min-width:90px;text-align:right;font-weight:700;color:#410207;font-size:13px;font-variant-numeric:tabular-nums}'+
    '.st-actions{display:flex;gap:8px;padding:6px 14px 10px;flex-wrap:wrap}'+
    '.st-actions .report-btn{flex:1;min-width:108px}'+
    '.st-addbtn{margin:14px;width:calc(100% - 28px)}';
  document.head.appendChild(s);
}

function stRender(){
  stInjectCss();
  var view = document.getElementById('stocktake-view'); if(!view) return;
  if(!stMonth){
    view.innerHTML = '<div class="ops-title" style="padding:14px 14px 0">Stock Take</div>'+
      '<div class="ops-subtitle" style="padding:0 14px;color:#8a7a55;font-size:12px">No month loaded yet</div>'+
      stGateHtml()+
      (stUser
        ? '<div style="padding:14px"><button class="report-btn" onclick="stShowUpload()">Upload this month\'s list (.xls)</button></div>'
        : '<div class="report-no-data">Enter your employee ID, then upload this month\'s list from the cost controller.</div>');
    return;
  }
  var monLabel = new Date(stMonth+'-01T12:00:00').toLocaleDateString('en-GB',{month:'long',year:'numeric'});
  var cats = ['<option value="">All categories</option>'].concat(stCats().map(function(c){
    return '<option value="'+stEsc(c)+'"'+(c===stCatFilter?' selected':'')+'>'+stEsc(c)+'</option>';
  })).join('');

  var gate = stGateHtml();

  view.innerHTML =
    '<div class="ops-title" style="padding:14px 14px 0">Stock Take · '+stEsc(monLabel)+'</div>'+
    '<div class="ops-subtitle" style="padding:0 14px;color:#8a7a55;font-size:12px">'+stItems.length+' items · shared live · tap a quantity to count</div>'+
    gate+
    '<div class="ops-grid" style="padding:0 14px">'+
      '<div class="ops-card dark"><div class="ops-num" id="st-grand">'+stMoney(stGrandTotal())+'</div><div class="ops-label">Counted value (all)</div></div>'+
      '<div class="ops-card"><div class="ops-num"><span id="st-counted">'+stCountedCount()+'</span> / '+stItems.length+'</div><div class="ops-label">Items counted</div></div>'+
    '</div>'+
    '<div class="st-toolbar">'+
      '<input class="check-input" id="st-search" placeholder="Search items…" value="'+stEsc(stSearch)+'" oninput="stOnSearch(this.value)" style="flex:1;min-width:140px">'+
      '<select class="check-select" id="st-cat" onchange="stOnCat(this.value)">'+cats+'</select>'+
      (stUser?'<button class="report-btn" onclick="stShowUpload()">Upload month</button>':'')+
    '</div>'+
    '<div class="st-catbar"><span id="st-catlabel">'+(stCatFilter?stEsc(stCatFilter):'All categories')+'</span>'+
      '<span class="st-muted">category total <b id="st-catsub">'+stMoney(stCategoryTotal())+'</b></span></div>'+
    (stUser? '<div class="st-actions">'+
        '<button class="report-btn" onclick="stReviewSend()">Email to Aung</button>'+
        '<button class="report-btn" onclick="stExportExcel()">Download Excel</button>'+
        '<button class="report-btn" onclick="stPrint()">Print</button>'+
      '</div>' : '')+
    '<div id="st-rows"></div>'+
    '<button class="report-btn st-addbtn" onclick="stShowAdd()">+ Add missing item</button>';

  stRenderRows();
}

function stRenderRows(){
  var c = document.getElementById('st-rows'); if(!c) return;
  var items = stFilteredItems();
  if(!items.length){ c.innerHTML = '<div class="report-no-data">No items match your search.</div>'; return; }
  var locked = !stUser;
  var html = '';
  var lastCat = null;
  items.forEach(function(it){
    var cat = it.item_group||'Other';
    if(cat!==lastCat){ html += '<div class="st-cat">'+stEsc(cat)+'</div>'; lastCat = cat; }
    var c2 = stCounts[it.id];
    var qv = (c2&&c2.qty!=null) ? c2.qty : '';
    var multi = Array.isArray(it.units) && it.units.length>1;
    var unitCtl = multi
      ? '<select class="st-unit" '+(locked?'disabled':'')+' onchange="stPickUnit(\''+it.id+'\',this.value)">'+
        it.units.map(function(u){ return '<option value="'+stEsc(u.unit)+'"'+(stItemUnit(it)===u.unit?' selected':'')+'>'+stEsc(u.unit)+' · '+stMoney(u.price)+'</option>'; }).join('')+'</select>'
      : '<span class="st-muted">'+stEsc(it.unit||'')+' · '+stMoney(stItemPrice(it))+'</span>';
    html +=
      '<div class="st-row'+(locked?' locked':'')+'" id="st-row-'+it.id+'">'+
        '<div class="st-main">'+
          '<div class="st-namecol">'+
            '<div class="st-name">'+stEsc(it.name)+(it.is_added?'<span class="st-tag">added</span>':'')+'</div>'+
            '<div class="st-meta">'+unitCtl+'</div>'+
          '</div>'+
          '<input class="st-qty" inputmode="decimal" placeholder="0" value="'+qv+'" '+(locked?'disabled':'')+
            ' onfocus="stFocusRow(\''+it.id+'\',true)" onblur="stFocusRow(\''+it.id+'\',false)" onchange="stSetQty(\''+it.id+'\',this.value)">'+
          '<span class="st-line" id="st-line-'+it.id+'">'+stMoney(stLineValue(it))+'</span>'+
        '</div>'+
      '</div>';
  });
  c.innerHTML = html;
}

function stUpdateRowUI(itemId){
  var it = stItems.find(function(x){ return x.id===itemId; });
  if(!it) return;
  var line = document.getElementById('st-line-'+itemId);
  if(line) line.textContent = stMoney(stLineValue(it));
  var row = document.getElementById('st-row-'+itemId);
  if(row){ var inp = row.querySelector('.st-qty'); var c=stCounts[itemId];
    if(inp && document.activeElement!==inp){ inp.value = (c&&c.qty!=null)?c.qty:''; } }
}
function stRenderTotals(){
  var g=document.getElementById('st-grand'); if(g) g.textContent = stMoney(stGrandTotal());
  var n=document.getElementById('st-counted'); if(n) n.textContent = stCountedCount();
  var s=document.getElementById('st-catsub'); if(s) s.textContent = stMoney(stCategoryTotal());
  var l=document.getElementById('st-catlabel'); if(l) l.textContent = stCatFilter||'All categories';
}

// ── toolbar handlers ──
var stSearchTimer=null;
function stOnSearch(v){ stSearch=v; clearTimeout(stSearchTimer); stSearchTimer=setTimeout(stRenderRows,120); }
function stOnCat(v){ stCatFilter=v; stRenderRows(); stRenderTotals(); }
function stFocusRow(itemId, on){ var r=document.getElementById('st-row-'+itemId); if(r) r.classList.toggle('active', on); }
function stPickUnit(itemId, unit){ stUnitSel[itemId]=unit; stUpdateRowUI(itemId); stRenderTotals(); if(stCounts[itemId]&&stCounts[itemId].qty!=null) stSetQty(itemId, stCounts[itemId].qty); }

// ── add a missing item (anyone signed in) ──
function stShowAdd(){
  if(!stUser){ if(typeof kToast==='function') kToast('Enter your employee ID first.', true); return; }
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
  var cat = stCatFilter || 'Added items';
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
      return '<tr><td style="padding:5px 8px;border-bottom:1px solid #ddd">'+stEsc(it.name)+'</td>'+
        '<td style="padding:5px 8px;border-bottom:1px solid #ddd;text-align:right">'+c.qty+' '+stEsc(stItemUnit(it))+'</td>'+
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
    var qty = (c && c.qty!=null) ? Number(c.qty) : '';
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
  var existing=await sb.from('stock_take_sheets').select('id').eq('venue_id',STOCK_VENUE).eq('dept',STOCK_DEPT).eq('month',month).limit(1);
  if(existing.data && existing.data.length){
    if(!confirm('A stock take for '+month+' already exists. Replacing it clears any counts already entered for that month. Continue?')) throw new Error('cancelled');
  }
  await sb.from('stock_take_counts').delete().eq('venue_id',STOCK_VENUE).eq('dept',STOCK_DEPT).eq('month',month);
  await sb.from('stock_take_items').delete().eq('venue_id',STOCK_VENUE).eq('dept',STOCK_DEPT).eq('month',month);
  await sb.from('stock_take_sheets').delete().eq('venue_id',STOCK_VENUE).eq('dept',STOCK_DEPT).eq('month',month);
  await sb.from('stock_take_sheets').insert({ venue_id:STOCK_VENUE, dept:STOCK_DEPT, month:month, status:'counting', source_filename:filename, item_count:items.length, uploaded_by:stUser.emp_id, uploaded_by_name:stUser.name });
  var rowsToInsert=items.map(function(it){ return { venue_id:STOCK_VENUE, dept:STOCK_DEPT, month:month, item_group:it.item_group, code:it.code, name:it.name, unit:it.unit, price:it.price, units:it.units, sort_order:it.sort_order, active:true }; });
  for(var i=0;i<rowsToInsert.length;i+=500){
    var res=await sb.from('stock_take_items').insert(rowsToInsert.slice(i,i+500));
    if(res.error) throw new Error(res.error.message);
  }
  stMonth=month; stUnitSel={};
  await stLoadItems(); await stLoadCounts();
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
  stSubscribe();
  stRender();
}
