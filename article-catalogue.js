// ══════════════════════════════════════════════════════════════════════════
// ARTICLE CATALOGUE
// The FMC article master, read-only. The "second list": what an ingredient is
// really called, what its code is, and what the last sheet valued it at.
//
// SOURCE — `fmc_articles`, the FMC *Manage Articles* master. Every article
// FMC holds, whether or not it has ever been counted or ordered here.
// `stock_take_items` is joined on for the PRICE and nothing else.
//
// ⚠ It read the other way round until 11 Aug 2026 and that was the bug. The
// row source was stock_take_items with the master as an overlay, and the one
// path that let a master-only article through was gated on `on_assortment` —
// written correctly on 9 Aug, when `fmc_articles` WAS the 417-row printed
// assortment. The 1,435-row master load on 10 Aug set on_assortment = false
// on 980 of those rows, so the gate rejected all of them. Every assortment
// article was already on a stock sheet, so that path added exactly ZERO
// articles and the count stayed at 845 — the same number as the day before
// the master arrived. 604 articles were hidden and nothing on screen moved.
// A table changed meaning and the screen was left phrased for the old one.
//
// EVERY article is kept, with no warning of any kind on the older ones.
// July's sheet is short (677 rows against June's 949) and 360 codes are absent
// from it — but that is a stock-take COUNT of what was on hand at 31 July, not
// a catalogue of what can be ordered. Proven 8 Aug 2026: Baby Marrow -GCC is
// one of the 360 and was bought that morning on requisition i26-169305, 5 kg
// at 4.90 from Wahat Alaweer. Marking those articles "not current" would have
// been a lie told 360 times. The sheet a price came from is shown as a plain
// fact beside the price, because a price with no date is the actual danger.
//
// PRICE — TWO of them, and the screen leads with FMC's own from 11 Aug 2026.
// `fmc_articles.price` is what FMC charges per ORDER unit, read off the
// Purchase grid: 456 articles have it, including 450 of the 451 that can
// actually be ordered. `stock_take_items.price` is Aung's month-end valuation
// and fills in behind it for the 389 articles FMC no longer sells but the
// kitchen has counted. They are NOT the same number — 69 of the 456 that have
// both are more than 10% apart (Cucumber Medium -GCC: 4.96 counted, 4.50 at
// FMC) — so the note under every price says which of the two it is, and the
// card shows both side by side rather than warning about the difference in
// prose. 401 articles have neither and show a dash.
// See order-items-fmc-columns.sql.
//
// SUPPLIER — not in the export yet (asked of Aung). The column is read when it
// exists and the screen simply says so when it doesn't; nothing breaks either
// way. See acSelectCols().
// ══════════════════════════════════════════════════════════════════════════

var AC_KEY   = 'article_catalogue';
var AC_LIMIT = 150;                  // rows drawn at once — keep typing to narrow

var acAll      = [];      // [{code,name,group,unit,price,month,supplier}] one per code
var acShown    = [];      // what the current search/filter leaves
var acSearch   = '';
var acGroup    = '';      // '' = all groups
// The master holds three times what the assortment sells, so a search for
// "tomato" answers with articles FMC will refuse as well as ones it will take.
// Both answers are wanted — the module's job is the real name and code, and a
// dropped article still has to be identifiable when it turns up on an old
// recipe. This narrows the list to what can be bought today, and starts OFF so
// the screen opens on the whole truth.
var acOnlyOrder = false;
var acGroupList = [];     // groups in chip order — chips address theirs by index
var acSel      = 0;       // keyboard cursor into acShown (within the drawn slice)
var acHasSupplier = false;
var acLoaded   = false;
var acSearchTimer = null;

// ── sheet keys: 'YYYY-MM-DD' (a dated count) or legacy 'YYYY-MM' (that month's
// last day). Same tolerance as stock-take.js — a half-migrated table must not
// print "Invalid Date". Parsed from LOCAL parts; Dubai is UTC+4 and a UTC parse
// would roll a date back a day.
function acKeyDate(k){
  k = String(k||'');
  if(/^\d{4}-\d{2}-\d{2}$/.test(k)){ var d=k.split('-'); return new Date(+d[0], +d[1]-1, +d[2], 12); }
  if(/^\d{4}-\d{2}$/.test(k)){ var m=k.split('-'); return new Date(+m[0], +m[1], 0, 12); }
  return null;
}
function acSheetLabel(k){
  var d = acKeyDate(k); if(!d) return String(k||'');
  return /^\d{4}-\d{2}-\d{2}$/.test(String(k))
    ? d.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})
    : d.toLocaleDateString('en-GB',{month:'long',year:'numeric'});
}
function acSheetShort(k){
  var d = acKeyDate(k); if(!d) return String(k||'');
  return d.toLocaleDateString('en-GB',{month:'short',year:'numeric'});
}

function acEsc(s){
  return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function acMoney(n){
  // null/undefined/'' must NOT fall through to Number(), which turns all three
  // into 0 and prints a confident "0.00 AED". Found on the live screen 11 Aug
  // 2026 the moment the master brought in articles no stock sheet has ever
  // carried: 190 rows quoting a price of zero. A missing price is a dash.
  if(n === null || n === undefined || n === '') return '—';
  var v = Number(n);
  if(!isFinite(v)) return '—';
  return v.toFixed(2);
}
// Batch Recipe groups are made in-house and are never ordered — they are not
// articles and must not appear in a list used to place an order.
function acIsBatch(g){ return /^batch recipe/i.test(String(g||'')); }

// ── data ──────────────────────────────────────────────────────────────────
// PostgREST caps a select at 1000 rows; four sheets are ~3,600 rows, so a
// single unpaged read would silently drop two thirds of the catalogue.
async function acFetchAllPaged(build){
  var all=[], from=0, size=1000;
  for(;;){
    var r = await build().range(from, from+size-1);
    if(r.error){ return { error:r.error, data:all }; }
    var rows = r.data||[];
    all = all.concat(rows);
    if(rows.length < size) break;
    from += size;
  }
  return { data:all };
}

// supplier is not in the export yet. Ask for it, and fall back to the columns
// we know exist if the table hasn't got it — a missing column is a hard 400
// from PostgREST, not an empty field.
function acSelectCols(){
  return acHasSupplier
    ? 'code,name,item_group,unit,price,month,supplier'
    : 'code,name,item_group,unit,price,month';
}
// ══════════════════════════════════════════════════════════════════════════
// TWO TABLES, TWO DIFFERENT JOBS — and the master is the list
//
// `fmc_articles` IS the catalogue: every article FMC holds, its real name, the
// unit FMC counts it in, its supplier, its group, and whether it is on the
// assortment today. It is the source of truth and it decides which rows exist.
//
// `stock_take_items` supplies the PRICE and nothing else. It is an inventory
// export and it keeps discontinued articles indefinitely, so it can never be
// asked whether something is orderable — nor which articles exist, which is
// the mistake this file made until 11 Aug 2026. A code that is only ever on a
// stock sheet is still listed (14 of them), because the kitchen has counted it
// and a chef may search for it — but nothing is claimed about ordering it.
//
// ORDERABLE is three-state and never guessed:
//   true  — on the assortment. FMC will accept it today.
//   false — in the master, off the assortment. FMC has dropped it. Four were
//           proved dead on 8 Aug 2026 (4029044, 4017171, 4017201, 4017263).
//   null  — we have no master row, or the master failed to load. Nothing said.
// The old code collapsed the last two into a red "not orderable", which is a
// guess printed as a fact.
// ══════════════════════════════════════════════════════════════════════════
async function acLoad(){
  // Ask for one row with supplier in it. A column that doesn't exist is a 400
  // from PostgREST, so this settles the question for a single tiny request
  // instead of throwing away a full four-sheet read to find out.
  var probe = await sb.from('stock_take_items').select('code,supplier').limit(1);
  acHasSupplier = !probe.error;

  // THE LIST. Read first, because it is the one that decides what exists.
  var arts = {}, haveArts = false;
  var ares = await acFetchAllPaged(function(){
    return sb.from('fmc_articles')
      .select('code,name,unit,supplier,on_assortment,retiring,item_group,price')
      .eq('venue_id','robertos-difc').order('code');
  });
  if(!ares.error && ares.data && ares.data.length){
    haveArts = true;
    ares.data.forEach(function(a){ arts[String(a.code).trim()] = a; });
  }

  // THE PRICES. A stock-take failure must not empty the catalogue — the master
  // stands on its own and every price simply reads "no sheet price".
  var res = await acFetchAllPaged(function(){
    return sb.from('stock_take_items').select(acSelectCols())
      .eq('venue_id', STOCK_VENUE_AC).eq('dept', STOCK_DEPT_AC).eq('active', true).order('id');
  });
  // Only a total failure of BOTH reads leaves nothing to show.
  if(res.error && !haveArts){
    acAll = [];
    return res.error;
  }

  // one row per code, from the NEWEST sheet that carries it
  var by = {};
  ((res.error ? [] : res.data)||[]).forEach(function(r){
    var code = String(r.code||'').trim();
    if(!code) return;                       // hand-added count lines carry no article
    var prev = by[code];
    if(!prev){ by[code] = r; return; }
    var a = acKeyDate(r.month), b = acKeyDate(prev.month);
    if(a && b && a > b) by[code] = r;
  });

  // Every master article, priced from the newest sheet that carries it. The
  // batch filter runs on the master's OWN group — reading it off the stock
  // sheet would let a Batch Recipe article the kitchen has never counted
  // through, and those are made in-house and can never be ordered.
  acAll = [];
  Object.keys(arts).forEach(function(c){
    var a = arts[c], r = by[c];
    var group = a.item_group || (r && r.item_group) || 'Other';
    if(acIsBatch(group)) return;
    acAll.push({
      code:c,
      // FMC's own name wins — that is the name on an order, an invoice and a
      // delivery note, and it is the one a chef should learn.
      name:a.name || (r && r.name) || '',
      group:group,
      unit:a.unit || (r && r.unit) || '',
      // TWO prices, kept apart on purpose. fmcPrice is what FMC charges on the
      // order, read off the Purchase grid per ORDER unit — the number a chef is
      // actually spending. price is Aung's month-end valuation, which drifts:
      // 69 of the 456 articles that have both are more than 10% apart.
      fmcPrice:(a.price == null ? null : a.price),
      price:(r ? r.price : null), month:(r ? r.month : null),
      supplier:a.supplier || (r && r.supplier) || '',
      orderable: !!a.on_assortment,
      retiring: !!a.retiring
    });
  });

  // Counted here but not in the master. Kept — the kitchen has it on a sheet
  // and a chef may well search for it — with orderable left UNKNOWN, because
  // an absent master row is not evidence that FMC has dropped anything.
  Object.keys(by).forEach(function(c){
    if(arts[c]) return;
    var r = by[c];
    var group = r.item_group || 'Other';
    if(acIsBatch(group)) return;
    acAll.push({ code:c, name:r.name||'', group:group, unit:r.unit||'',
                 fmcPrice:null,          // no master row, so no FMC price either
                 price:r.price, month:r.month, supplier:r.supplier||'',
                 orderable:null, retiring:false });
  });

  // The master failing to load is the one case where nothing may be claimed
  // about ordering at all — the screen falls back to the stock sheets exactly
  // as it did before, and says nothing either way.
  if(!haveArts) acAll.forEach(function(r){ r.orderable = null; });
  // group then name — so the headings read top to bottom instead of jumping
  acAll.sort(function(a,b){
    return a.group===b.group ? a.name.localeCompare(b.name) : a.group.localeCompare(b.group);
  });
  acLoaded = true;
  return null;
}

// ── who may be OFFERED ────────────────────────────────────────────────────
// The catalogue LISTS everything FMC holds, because its job is the real name
// and code and a dropped article still has to be identifiable on an old recipe.
// Anything that puts an article on an ORDER must not see the dropped ones —
// `fmc-match.js` builds the market-list matcher's candidates from this.
//
// It excludes `orderable === false` only. `null` (counted here, not in the FMC
// list) stays offerable: it is 14 articles nobody has ruled on, and hiding them
// would silently shrink what a chef can match against.
function acOfferable(){
  return acAll.filter(function(r){ return r.orderable !== false; });
}

// ── filtering ─────────────────────────────────────────────────────────────
function acGroups(){
  var seen = {}, out = [];
  acAll.forEach(function(r){ if(!seen[r.group]){ seen[r.group]=1; out.push(r.group); } });
  return out.sort();
}
function acFiltered(){
  var q = acSearch.trim().toLowerCase();
  return acAll.filter(function(r){
    // `orderable !== true` and not `=== false`: an article whose status is
    // unknown is not something to offer as buyable.
    if(acOnlyOrder && r.orderable !== true) return false;
    if(acGroup && r.group !== acGroup) return false;
    if(!q) return true;
    return r.name.toLowerCase().indexOf(q) > -1
        || r.code.indexOf(q) > -1
        || r.group.toLowerCase().indexOf(q) > -1;
  });
}

// ── render ────────────────────────────────────────────────────────────────
function acRender(){
  var v = document.getElementById('catalogue-view');
  if(!v) return;
  // chips address their group by INDEX, never by writing the name into an
  // onclick — a group like "Condiments (Food)" is fine, but a quote or an
  // apostrophe in a future FMC group name would break the handler silently.
  acGroupList = acGroups();
  var chips = ['<button class="ac-chip'+(acGroup===''?' on':'')+'" onclick="acPickGroup(-1)">All groups</button>']
    .concat(acGroupList.map(function(g, i){
      return '<button class="ac-chip'+(acGroup===g?' on':'')+'" onclick="acPickGroup('+i+')">'+acEsc(g)+'</button>';
    })).join('');

  v.innerHTML =
    '<div class="ops-title">Article Catalogue</div>' +
    // NOT "every article FMC can order" — it was that until 11 Aug 2026 and it
    // was wrong twice over: the list held 401 fewer articles than FMC sells, and
    // 390 of the ones it did hold are articles FMC will refuse.
    '<div class="ops-subtitle">Every article FMC holds · read-only · look here for the real name and code' +
      ' <button class="report-btn" style="margin-left:8px" onclick="openFmcMatch()">Match the market list</button>' +
      ' <button class="report-btn" style="margin-left:6px" onclick="acOpenUpload()">Update from FMC</button></div>' +

    '<div class="ac-searchbar">' +
      '<div class="ac-sfield">' +
        '<span class="ac-mag">&#8981;</span>' +
        '<input class="check-input ac-input" id="ac-q" placeholder="Search name, code or group…" ' +
               'autocomplete="off" value="'+acEsc(acSearch)+'" oninput="acOnSearch(this.value)">' +
      '</div>' +
      '<div class="ac-hint">' +
        '<span><kbd>/</kbd> search</span><span><kbd>&uarr;</kbd><kbd>&darr;</kbd> move</span>' +
        '<span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> clear</span>' +
      '</div>' +
    '</div>' +

    '<div class="ac-chips">'+chips+'</div>' +
    '<div class="ac-countline" id="ac-count"></div>' +
    '<div class="ac-list" id="ac-list"></div>' +
    '<button class="ml-top" id="ac-top" onclick="document.getElementById(\'catalogue-view\').scrollTo({top:0,behavior:\'smooth\'})" aria-label="Scroll to top">&uarr;</button>';

  var view = document.getElementById('catalogue-view');
  view.onscroll = function(){
    var b = document.getElementById('ac-top');
    if(b) b.style.display = view.scrollTop > 200 ? 'flex' : 'none';
  };
  acRenderRows();
  var q = document.getElementById('ac-q');
  if(q && window.innerWidth >= 760) q.focus();   // desktop is keyboard-first; a phone must not pop the keyboard on open
}

function acRenderRows(){
  acShown = acFiltered();
  if(acSel >= acShown.length) acSel = Math.max(0, acShown.length-1);

  var cEl = document.getElementById('ac-count');
  if(cEl){
    // How many of the whole catalogue FMC will actually sell today. Said out
    // loud because the list is now three times the assortment, and a chef who
    // does not know that would read every row as buyable.
    var sellable = 0, unknown = 0;
    acAll.forEach(function(r){ if(r.orderable === true) sellable++; else if(r.orderable === null) unknown++; });
    cEl.innerHTML = '<span>'+acShown.length+' of '+acAll.length+' articles'+(acGroup?' · '+acEsc(acGroup):'')+'</span>' +
      '<button class="ac-chip'+(acOnlyOrder?' on':'')+'" style="margin-left:10px" onclick="acToggleOrderable()">' +
        (acOnlyOrder?'&#10003; ':'') + 'Only the '+sellable+' FMC sells today</button>' +
      (unknown ? '<span class="ac-note">'+unknown+' counted here but not in the FMC list — status unknown</span>' : '') +
      (acHasSupplier ? '' : '<span class="ac-note">supplier is not in the stock-take export yet</span>');
  }

  var el = document.getElementById('ac-list'); if(!el) return;
  var slice = acShown.slice(0, AC_LIMIT), html = '', lastG = null;

  if(!slice.length){
    el.innerHTML = '<div class="report-no-data">Nothing matches. Try a shorter word, or the FMC code.</div>';
    return;
  }
  slice.forEach(function(r, i){
    if(!acGroup && r.group !== lastG){ html += '<div class="ac-cat">'+acEsc(r.group)+'</div>'; lastG = r.group; }
    html +=
      '<div class="ac-row'+(i===acSel?' sel':'')+'" id="ac-row-'+i+'" onclick="acOpen('+i+')">' +
        '<div>' +
          '<div class="ac-name">'+acEsc(r.name)+
            // `orderable === false` is a fact off the assortment. `null` means
            // no master row, or the master did not load — nothing is claimed
            // either way, because a wrong "dropped" would stop a chef ordering
            // something perfectly good.
            (r.orderable === false ? '<span class="ac-flag dead">not orderable</span>' : '') +
            (r.retiring ? '<span class="ac-flag retiring">retiring</span>' : '') +
          '</div>' +
          '<div class="ac-meta">' +
            '<span class="ac-code">'+acEsc(r.code)+'</span>' +
            '<span>'+acEsc(r.group)+'</span>' +
            (r.supplier ? '<span>'+acEsc(r.supplier)+'</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="ac-unit">'+acEsc(r.unit)+'</div>' +
        // FMC's own price leads wherever we have it — 450 of the 451 orderable
        // articles. Aung's valuation fills in behind it (389 articles FMC no
        // longer sells but the kitchen has counted), and the note always says
        // WHICH of the two is on screen, because they are not the same number.
        // "— AED" reads like a currency with a missing amount. No number, no
        // currency.
        '<div class="ac-price">'+acMoney(r.fmcPrice == null ? r.price : r.fmcPrice) +
          (r.fmcPrice == null && r.price == null ? '' : ' <span class="ac-cur">AED</span>') +
          '<div class="ac-pricenote">'+(r.fmcPrice != null ? 'FMC price'
             : (r.month ? acSheetShort(r.month)+' count' : 'no price'))+'</div></div>' +
      '</div>';
  });
  if(acShown.length > AC_LIMIT){
    html += '<div class="ac-more">Showing the first '+AC_LIMIT+' — keep typing to narrow it down</div>';
  }
  el.innerHTML = html;
}

// ── one article ───────────────────────────────────────────────────────────
function acOpen(i){
  var r = acShown[i]; if(!r) return;
  acSel = i;
  var old = document.getElementById('ac-sheet'); if(old) old.remove();

  var supplierLine = acHasSupplier
    ? (r.supplier ? acEsc(r.supplier) : '<span class="ac-dash">not named on the sheet</span>')
    : '<span class="ac-dash">not in the stock-take export yet</span>';

  // Three states, worded as what to DO about it. The unknown one must not read
  // like a refusal: the article may be perfectly orderable and nobody has asked.
  var orderLine = r.orderable === true
    ? 'Yes — on the FMC assortment'
    : (r.orderable === false
        ? '<b>No — FMC has dropped it.</b> The code still identifies it on an old recipe, but an order will be refused.'
        : '<span class="ac-dash">Not known — it is not in the FMC list we hold. Ask before ordering.</span>');

  // BOTH prices, each named, and never merged into one figure. Where an article
  // has both, a chef can see the drift for himself rather than being told about
  // it in a footnote — 69 of the 456 that have both are more than 10% apart.
  var fmcLine = (r.fmcPrice == null)
    ? '<span class="ac-dash">not priced on the FMC list</span>'
    : '<b>'+acMoney(r.fmcPrice)+' AED</b> per '+(acEsc(r.unit)||'unit');
  var priceLine = (r.price == null || r.price === '')
    ? '<span class="ac-dash">never counted here</span>'
    : acMoney(r.price)+' AED'+(r.month ? ' · '+acSheetLabel(r.month) : '');

  var box = document.createElement('div');
  box.className = 'ml-daypick-overlay';
  box.id = 'ac-sheet';
  box.innerHTML =
    '<div class="ac-modal" onclick="event.stopPropagation()">' +
      '<div class="ac-modal-head">' +
        '<div class="ac-modal-group">'+acEsc(r.group)+'</div>' +
        '<div class="ac-modal-name">'+acEsc(r.name)+'</div>' +
      '</div>' +
      '<div class="ac-modal-body">' +
        acKv('FMC code', '<span class="ac-code big">'+acEsc(r.code)+'</span>') +
        acKv('Unit', acEsc(r.unit)||'—') +
        acKv('Can you order it', orderLine) +
        acKv('What FMC charges', fmcLine) +
        acKv('Aung\'s stock-take count', priceLine) +
        acKv('Supplier', supplierLine) +
        // The caution belongs only where the FMC price is missing and Aung's
        // figure is the only number a chef has. Where FMC's own price is on
        // screen there is nothing to warn about — it is the real one.
        (r.fmcPrice == null && r.price != null ?
          '<div class="ac-caution">FMC does not price this one, so the only figure here is Aung\'s ' +
          'month-end count. It is a valuation, not what you would pay — use it to judge, not to quote.</div>' : '') +
      '</div>' +
      '<div class="ac-modal-foot">' +
        '<button type="button" class="ml-ed-btn ml-ed-cancel" onclick="acCloseSheet()">Close</button>' +
      '</div>' +
    '</div>';
  box.addEventListener('click', acCloseSheet);
  document.body.appendChild(box);
}
function acKv(k, v){ return '<div class="ac-kv"><span>'+k+'</span><span>'+v+'</span></div>'; }
function acCloseSheet(){ var el=document.getElementById('ac-sheet'); if(el) el.remove(); }

// ── handlers ──────────────────────────────────────────────────────────────
function acOnSearch(v){
  acSearch = v; acSel = 0;
  clearTimeout(acSearchTimer);
  acSearchTimer = setTimeout(acRenderRows, 120);
}
function acPickGroup(i){
  acGroup = (i < 0) ? '' : (acGroupList[i] || '');
  acSel = 0;
  acRender();
}
// acRenderRows, not acRender: the button lives on the count line and a full
// re-render would rebuild the search box under the chef's cursor and lose focus.
function acToggleOrderable(){
  acOnlyOrder = !acOnlyOrder;
  acSel = 0;
  acRenderRows();
}
function acMove(n){
  var max = Math.min(acShown.length, AC_LIMIT) - 1;
  if(max < 0) return;
  acSel = Math.max(0, Math.min(max, acSel + n));
  acRenderRows();
  var row = document.getElementById('ac-row-'+acSel);
  if(row) row.scrollIntoView({ block:'nearest' });
}

document.addEventListener('keydown', function(e){
  if(typeof activeStation === 'undefined' || activeStation !== AC_KEY) return;
  if(document.getElementById('ac-sheet')){
    if(e.key === 'Escape'){ e.preventDefault(); acCloseSheet(); }
    return;
  }
  var q = document.getElementById('ac-q');
  if(e.key === '/' && document.activeElement !== q){ e.preventDefault(); if(q){ q.focus(); q.select(); } return; }
  if(e.key === 'Escape'){ e.preventDefault(); acSearch=''; acSel=0; if(q) q.value=''; acRenderRows(); if(q) q.focus(); return; }
  if(e.key === 'ArrowDown'){ e.preventDefault(); acMove(1); return; }
  if(e.key === 'ArrowUp'){ e.preventDefault(); acMove(-1); return; }
  if(e.key === 'Enter'){ e.preventDefault(); acOpen(acSel); return; }
});

// ── css (injected once, so index.html stays light) ────────────────────────
function acInjectCss(){
  if(document.getElementById('ac-css')) return;
  var s = document.createElement('style');
  s.id = 'ac-css';
  s.textContent = [
    '#catalogue-view{position:relative;overflow-y:auto;-webkit-overflow-scrolling:touch}',
    '.ac-searchbar{position:sticky;top:0;z-index:6;background:#F5F0E8;padding:8px 0 6px}',
    '.ac-sfield{position:relative}',
    '.ac-input{width:100%;padding:13px 14px 13px 38px !important;font-size:16px}',
    '.ac-mag{position:absolute;left:13px;top:12px;color:#8B7355;font-size:15px;pointer-events:none}',
    '.ac-hint{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:#8B7355;margin-top:6px}',
    '.ac-hint kbd{background:#fff;border:1px solid rgba(107,31,42,.15);border-bottom-width:2px;border-radius:4px;padding:0 5px;font:600 10px inherit;color:#2C1810}',
    '.ac-chips{display:flex;gap:6px;overflow-x:auto;padding:2px 0 8px;-webkit-overflow-scrolling:touch}',
    '.ac-chip{white-space:nowrap;border:1px solid rgba(107,31,42,.15);background:#fff;color:#8B7355;border-radius:20px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer}',
    '.ac-chip.on{background:#6B1F2A;border-color:#6B1F2A;color:#fff}',
    '.ac-countline{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:12px;color:#8B7355;margin:2px 0 8px}',
    '.ac-note{font-style:italic}',
    '.ac-list{background:#fff;border:1px solid rgba(107,31,42,.15);border-radius:10px;overflow:hidden}',
    '.ac-cat{background:#efe6da;color:#6B1F2A;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;padding:7px 12px}',
    '.ac-row{display:grid;grid-template-columns:1fr 108px 96px;gap:10px;align-items:center;padding:10px 12px;border-bottom:1px solid #f0e9df;cursor:pointer}',
    '.ac-row:last-child{border-bottom:0}',
    '.ac-row.sel{background:#fbf6ee;box-shadow:inset 3px 0 0 #C9A84C}',
    '.ac-name{font-size:14px;font-weight:600;color:#2C1810}',
    '.ac-meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:11px;color:#8B7355;margin-top:2px}',
    '.ac-code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:#6B1F2A;background:#f6efe6;border-radius:4px;padding:1px 5px}',
    '.ac-code.big{font-size:13px;padding:2px 7px}',
    '.ac-flag{display:inline-block;margin-left:6px;font-size:9.5px;font-weight:700;border-radius:20px;padding:1px 7px;vertical-align:middle}',
    '.ac-flag.dead{background:#FDECEA;color:#b3261e;border:1px solid #F2B8B2}',
    '.ac-flag.retiring{background:#EEF2FA;color:#2a4a7a;border:1px solid #C3D2EA}',
    '.ac-unit{font-size:12px;color:#8B7355;text-align:right}',
    '.ac-price{text-align:right;font-weight:700;font-size:14px;color:#2C1810}',
    '.ac-cur{font-size:10px;color:#8B7355;font-weight:600}',
    '.ac-pricenote{font-size:10px;color:#8B7355;font-weight:500;margin-top:1px}',
    '.ac-more{padding:10px;text-align:center;color:#8B7355;font-size:12px;background:#fbf7f1}',
    '.ac-modal{background:#fff;border-radius:12px;max-width:460px;width:100%;overflow:hidden}',
    '.ac-modal-head{background:#6B1F2A;padding:13px 16px;color:#fff}',
    '.ac-modal-group{font-size:11px;letter-spacing:1.2px;text-transform:uppercase;opacity:.75}',
    '.ac-modal-name{font-family:Georgia,serif;font-size:17px;margin-top:2px}',
    '.ac-modal-body{padding:4px 16px 12px}',
    '.ac-kv{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid #f0e9df;font-size:13px}',
    '.ac-kv span:first-child{color:#8B7355}',
    '.ac-kv span:last-child{font-weight:600;text-align:right;color:#2C1810}',
    '.ac-dash{color:#b9ac99;font-style:italic;font-weight:500}',
    '.ac-caution{font-size:11px;color:#8B7355;background:#faf6f0;border-left:3px solid #C9A84C;border-radius:0 6px 6px 0;padding:8px 10px;margin-top:10px;line-height:1.4}',
    '.ac-modal-foot{padding:10px 16px;background:#faf6f0;display:flex;justify-content:flex-end}',
    '@media(max-width:640px){',
      '.ac-row{grid-template-columns:1fr 92px}',
      '.ac-unit{display:none}',
    '}'
  ].join('\n');
  document.head.appendChild(s);
}

// ── entry point ───────────────────────────────────────────────────────────
// Read from the same venue/dept the stock take writes. Declared here, not
// borrowed from stock-take.js — the catalogue must open whether or not that
// module has ever been loaded in this session.
var STOCK_VENUE_AC = 'robertos-difc';
var STOCK_DEPT_AC  = 'kitchen';

async function openArticleCatalogue(){
  activeStation = AC_KEY;
  hideAllPages();
  acInjectCss();
  var v = document.getElementById('catalogue-view');
  v.style.display = 'block';
  document.querySelector('.footer-bar').style.display = 'flex';
  document.getElementById('foot-label').textContent = 'Article Catalogue';
  v.innerHTML = '<div style="padding:40px;text-align:center;opacity:.6">Loading the article list…</div>';

  if(!acLoaded){
    var err = await acLoad();
    if(err){
      v.innerHTML = '<div class="report-no-data">Could not load the article list — check the connection and open it again.</div>';
      if(typeof kToast === 'function') kToast('Could not load the article list.', true);
      console.warn('article catalogue load failed', err);
      return;
    }
  }
  acRender();
}

/* ══════════════════════════════════════════════════════════════════════════
   UPDATE FROM FMC — the two exports, read here, written by an edge function
   ══════════════════════════════════════════════════════════════════════════
   Assortment List PDF  -> what the kitchen may ORDER
   Manage Articles xls  -> what an article IS and what a RECIPE costs on

   The write cannot happen in the browser: a PATCH to `fmc_articles` with the
   app's key matches the row, changes nothing and returns 204 — success to
   look at, nothing done. So this parses and `fmc-upload` writes.

   Nothing saves on the first press. The chef reads what moves, then decides;
   a per-kilo price landing here recosts every dish using it.

   The two parser libraries are ~1.2MB and are fetched only when this panel is
   opened — the catalogue itself is a search screen and must stay quick. */

var ACU_LIBS = [
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js'
];
var acuParsed = { assortment:null, master:null };
var acuLibsIn = null;

function acuLoadLibs(){
  if (acuLibsIn) return acuLibsIn;
  acuLibsIn = Promise.all(ACU_LIBS.map(function(src){
    return new Promise(function(res, rej){
      var t = document.createElement('script');
      t.src = src; t.onload = res;
      t.onerror = function(){ rej(new Error('could not load the file readers — is the tablet online?')); };
      document.head.appendChild(t);
    });
  })).then(function(){
    if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  });
  return acuLibsIn;
}

/* The Article column is read by POSITION. Flattened to a string a row reads
   "Beef Topside MB2 Riverina -Australia Kilogram" with nothing marking the
   join, so splitting it would mean owning a list of every packing unit FMC
   uses and hoping none of them ever ends an article name. */
var ACU_X_MAX = 340;
var ACU_FURNITURE = /^(Assortment List|Assortment:|Article|Qty|Packing Unit|Order Date:|Deliv\. Loc\.:|KITCHEN|Robertos|Page \d|\d{2}-\d{2}-\d{4})/i;

function acuReadAssortment(file){
  return file.arrayBuffer().then(function(buf){
    return pdfjsLib.getDocument({ data:buf }).promise;
  }).then(function(pdf){
    var pages = []; for (var p=1; p<=pdf.numPages; p++) pages.push(p);
    return pages.reduce(function(chain, p){
      return chain.then(function(acc){
        return pdf.getPage(p).then(function(pg){ return pg.getTextContent(); }).then(function(tc){
          var rows = {};
          tc.items.forEach(function(it){
            var t = (it.str||'').trim(); if(!t) return;
            var y = Math.round(it.transform[5]);
            (rows[y] = rows[y] || []).push({ x:it.transform[4], t:t });
          });
          Object.keys(rows).sort(function(a,b){ return b-a; }).forEach(function(y){
            var left = rows[y].sort(function(a,b){ return a.x-b.x; })
              .filter(function(c){ return c.x < ACU_X_MAX; })
              .map(function(c){ return c.t; }).join(' ').trim();
            if (left && !ACU_FURNITURE.test(left)) acc.push(left);
          });
          return acc;
        });
      });
    }, Promise.resolve([]));
  }).then(function(names){
    if(!names.length) throw new Error('no article lines could be read from that PDF');
    return names;
  });
}

function acuReadMaster(file){
  return file.arrayBuffer().then(function(buf){
    var wb = XLSX.read(buf, { type:'array' });
    if (wb.SheetNames.indexOf('Data') < 0)
      throw new Error('that file has no "Data" sheet — it is not a Manage Articles export');
    var rows = XLSX.utils.sheet_to_json(wb.Sheets['Data'], { defval:'' });
    var need = ['Article No.','Article','Item Group','Base Unit','Store Unit','Last Purchase Price'];
    var miss = need.filter(function(h){ return !(h in (rows[0]||{})); });
    if (miss.length) throw new Error('the export is missing ' + miss.join(', '));
    var out = [];
    rows.forEach(function(r){
      var code = String(r['Article No.']).trim().replace(/\.0$/,'');
      var name = String(r['Article']).trim();
      if(!code || !name) return;
      var pr = parseFloat(r['Last Purchase Price']);
      out.push({ code:code, name:name,
                 item_group:String(r['Item Group']).trim(),
                 base_unit:String(r['Base Unit']).trim(),
                 store_unit:String(r['Store Unit']).trim(),
                 price_per_base_unit: isFinite(pr) ? pr : null,
                 retired: /^z{2,}/i.test(name) });
    });
    if(!out.length) throw new Error('no articles could be read from that file');
    return out;
  });
}

/* ── the Price Quotes export: who FMC will take an order from ───────────────
   Purchase | Price Quotes, every filter cleared, the green Excel button. It is
   the only place that answers "will FMC accept an order from this supplier",
   and the answer is not the same as who we last bought from: on 15 Aug 2026
   Turbot 4026100 had been bought from Simply Gourmet and FMC offered only Wisk.

   Only the rows FMC has switched ON are sent. A row that is off is not a
   supplier a chef can be offered, and sending it would put the app back to
   naming suppliers that refuse the order - which is what 61 market-list lines
   were doing with Zurich Foodstuff.

   The Article No. column here is the SUPPLIER's number, not FMC's. It is
   usually FMC's code because we filled it in, but not always, so the article
   NAME is sent alongside and the function decides which to believe. */
function acuReadQuotes(file){
  return file.arrayBuffer().then(function(buf){
    var wb = XLSX.read(buf, { type:'array', cellDates:true });
    if (wb.SheetNames.indexOf('Data') < 0)
      throw new Error('that file has no "Data" sheet — it is not a Price Quotes export');
    var rows = XLSX.utils.sheet_to_json(wb.Sheets['Data'], { defval:'' });
    var need = ['Supplier','Article','Unit','E/D','Price/Unit'];
    var miss = need.filter(function(h){ return !(h in (rows[0]||{})); });
    if (miss.length) throw new Error('the export is missing ' + miss.join(', '));

    function day(v){
      if (v instanceof Date && isFinite(v))
        return v.getFullYear() + '-' + String(v.getMonth()+1).padStart(2,'0') +
               '-' + String(v.getDate()).padStart(2,'0');
      var s = String(v || '').trim();
      var m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);   // FMC prints d/m/Y
      if (m) return m[3] + '-' + m[2] + '-' + m[1];
      return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0,10) : null;
    }
    function num(v){ var n = parseFloat(v); return isFinite(n) ? n : null; }

    var out = [], off = 0;
    rows.forEach(function(r){
      var sup = String(r['Supplier']).trim(), art = String(r['Article']).trim();
      if(!sup || !art) return;
      if(Number(r['E/D']) !== 1){ off++; return; }
      out.push({ code:String(r['Article No.']||'').trim().replace(/\.0$/,''),
                 article:art, supplier:sup, unit:String(r['Unit']).trim(),
                 price:num(r['Price/Unit']), priceBase:num(r['Price/BU']),
                 priced:day(r['Last Price Update']),
                 group:String(r['Item Group']||'').trim() });
    });
    if(!out.length) throw new Error('no switched-on price quotes could be read from that file');
    out.switchedOffInFile = off;
    return out;
  });
}

function acOpenUpload(){
  var old = document.getElementById('ac-sheet'); if(old) old.remove();
  acuParsed = { assortment:null, master:null, quotes:null };

  var box = document.createElement('div');
  box.className = 'ml-daypick-overlay';
  box.id = 'ac-sheet';
  box.innerHTML =
    '<div class="ac-modal" onclick="event.stopPropagation()" style="max-width:640px">' +
      '<div class="ac-modal-head">' +
        '<div class="ac-modal-group">From FMC</div>' +
        '<div class="ac-modal-name">Update the article list</div>' +
      '</div>' +
      '<div class="ac-modal-body" id="acu-body">' +
        '<div class="ac-caution" style="margin-bottom:12px">' +
          '<b>Assortment List</b> — File, Print, save as PDF. Sets what can be ordered.<br>' +
          '<b>Manage Articles</b> — the green Excel button. Sets names, units and recipe costs. ' +
          'Clear any group filter first or drinks are left out.<br>' +
          '<b>Price Quotes</b> — Purchase, Price Quotes, the green Excel button. Sets who each ' +
          'item can be ordered from. Clear <i>every</i> filter, especially Supplier Group.' +
        '</div>' +
        '<div class="ac-dash" style="margin:-4px 0 10px;font-size:12px">' +
          'Any of these can be loaded on its own — you do not need all three. Without the ' +
          'Assortment List, what can be ordered is left exactly as it is.' +
        '</div>' +
        '<label class="ac-kv" style="cursor:pointer"><span>Assortment List (PDF)</span>' +
          '<span id="acu-s1" style="text-align:right">choose&hellip;' +
          '<input type="file" accept=".pdf,application/pdf" id="acu-f1" style="display:none"></span></label>' +
        '<label class="ac-kv" style="cursor:pointer"><span>Manage Articles (XLS)</span>' +
          '<span id="acu-s2" style="text-align:right">choose&hellip;' +
          '<input type="file" accept=".xls,.xlsx" id="acu-f2" style="display:none"></span></label>' +
        '<label class="ac-kv" style="cursor:pointer"><span>Price Quotes (XLSM)</span>' +
          '<span id="acu-s3" style="text-align:right">choose&hellip;' +
          '<input type="file" accept=".xls,.xlsx,.xlsm" id="acu-f3" style="display:none"></span></label>' +
        '<div class="ac-kv"><span>Your code</span>' +
          '<span><input type="password" id="acu-pin" inputmode="numeric" placeholder="&bull;&bull;&bull;&bull;" ' +
          'style="width:90px;text-align:center;letter-spacing:3px;padding:7px" oninput="acuReady()"></span></div>' +
        '<div id="acu-why" class="ac-dash" style="margin-top:8px;font-size:12.5px"></div>' +
        '<div id="acu-out"></div>' +
      '</div>' +
      '<div class="ac-modal-foot">' +
        '<button type="button" class="ml-ed-btn ml-ed-cancel" onclick="acCloseSheet()">Close</button>' +
        '<button type="button" class="ml-ed-btn" id="acu-go" disabled onclick="acuCheck()">See what changes</button>' +
      '</div>' +
    '</div>';
  box.addEventListener('click', acCloseSheet);
  document.body.appendChild(box);

  acuLoadLibs().then(acuReady).catch(function(e){
    var w = document.getElementById('acu-why'); if(w) w.textContent = e.message;
  });
  acuWire('acu-f1','acu-s1', acuReadAssortment, 'assortment', 'lines');
  acuWire('acu-f2','acu-s2', acuReadMaster,     'master',     'articles');
  acuWire('acu-f3','acu-s3', acuReadQuotes,     'quotes',     'supplier prices');
  acuReady();
}

function acuSay(labelId, text){
  var el = document.getElementById(labelId); if(!el) return;
  el.childNodes[0].nodeValue = text;
}

function acuWire(inputId, labelId, reader, key, unit){
  var inp = document.getElementById(inputId);
  inp.addEventListener('change', function(){
    var f = inp.files[0]; if(!f) return;
    acuSay(labelId, 'reading…');
    acuLoadLibs().then(function(){ return reader(f); }).then(function(v){
      acuParsed[key] = v;
      acuSay(labelId, v.length + ' ' + unit + ' ✓');
      acuReady();
    }).catch(function(e){
      acuParsed[key] = null;
      acuSay(labelId, e.message);
      acuReady();
    });
  });
}

/* A disabled button always says what it is waiting for.
   Three files, two jobs. The article list needs BOTH the assortment and the
   master - one without the other would let a single file overrule the two
   questions they answer between them. The price quotes answer their own
   question and go alone. */
function acuReady(){
  var a = !!acuParsed.assortment, m = !!acuParsed.master, q = !!acuParsed.quotes;
  var why = [];
  if(!a && !m && !q) why.push('a file');
  /* The Assortment List needs the article file to read against — it carries
     names, not codes, so on its own it can identify nothing.
     The reverse is no longer true. The article file used to be held back until
     the printed list came with it, because writing it alone would have marked
     every article unorderable; the function now leaves that column untouched
     when the printed list is absent, so the half that rots can be refreshed by
     itself. That is the whole point — the file nobody can be bothered to
     produce was gating the file that goes stale. */
  else if(a && !m) why.push('the Manage Articles file');
  var pin = document.getElementById('acu-pin');
  if(!pin || !pin.value.trim()) why.push('your code');
  var b = document.getElementById('acu-go'); if(!b) return;
  b.disabled = why.length > 0;
  var w = document.getElementById('acu-why');
  if(w) w.textContent = why.length ? 'Still needs ' + why.join(' and ') : '';
}

function acuCall(dryRun){
  // SUPABASE_URL / SUPABASE_KEY are the app's own globals from app.js. The
  // standalone page used SB_URL / SB_KEY, which do not exist in here — that
  // mismatch threw on the first real click and is exactly what testing the
  // whole path in the app, rather than the panel on its own, is for.
  return fetch(SUPABASE_URL + '/functions/v1/fmc-upload', {
    method:'POST',
    headers:{ 'Content-Type':'application/json',
              'Authorization':'Bearer ' + SUPABASE_KEY, apikey: SUPABASE_KEY },
    body: JSON.stringify({ passcode:document.getElementById('acu-pin').value.trim(),
                           dryRun:dryRun, assortment:acuParsed.assortment, master:acuParsed.master,
                           quotes:acuParsed.quotes })
  }).then(function(r){ return r.json(); });
}

function acuFail(j){
  document.getElementById('acu-out').innerHTML =
    '<div class="ac-caution" style="border-color:#F2B8B2;background:#FDECEA;color:#8a1c14">' +
    '<b>Nothing was saved.</b><br>' +
    (j.problems || [j.error || 'that did not work']).map(acEsc).join('<br>') + '</div>';
}

function acuCheck(){
  var go = document.getElementById('acu-go');
  go.disabled = true; go.textContent = 'Working it out…';
  acuCall(true).then(function(j){
    go.textContent = 'See what changes'; go.disabled = false;
    if(j.error) return acuFail(j);
    acuShowAll(j);
  }).catch(function(e){
    go.textContent = 'See what changes'; go.disabled = false;
    acuFail({ problems:[e.message] });
  });
}

/* ⚠ Every list is read through a `|| []` and the counts through locals, on
   purpose. Each of the three files may now arrive on its own, so a field that
   is always present on one upload shape is absent on another — and reading
   `.length` off an absent one throws into the catch that prints failure. That
   is precisely how "Nothing was saved" came to be printed over 1,144 saved
   rows. The shape of the answer is allowed to vary; the wording is not allowed
   to decide the outcome. */
function acuShow(r){
  var moved     = r.priceMoved || [],
      gone      = r.noLongerOrderable || [],
      fresh     = r.nowOrderable || [],
      unmatched = r.unmatchedAssortmentLines || [],
      /* null, never 0. An update with no printed Assortment List did not ask
         whether anything is orderable, and printing 0 would answer it wrongly
         in the most alarming possible direction. */
      noAssort  = !!r.assortmentUntouched;

  var h = '<div style="margin-top:12px">';
  h += acKv('Articles', r.articles);
  h += acKv('You can order', noAssort ? 'not checked' : r.orderable);
  h += acKv('New to the list', r.addedCount);
  h += acKv('Costs that moved', moved.length);

  if(noAssort)
    h += '<div class="ac-caution">Names, units and costs are being refreshed, and so is ' +
      'FMC\'s mark for a retired article. <b>What can be ordered is not.</b> That only comes ' +
      'from the printed Assortment List and there is none in this update, so it is left ' +
      'exactly as it stands — nothing is switched on or off.</div>';

  if(!r.addedCount && !moved.length && !gone.length && !fresh.length)
    h += '<div class="ac-caution">Nothing has changed since the last update.</div>';

  if(unmatched.length)
    h += '<div class="ac-caution"><b>' + unmatched.length + ' lines on the assortment ' +
      'match no article</b> — usually a group filter left on the Manage Articles export. They stay ' +
      'exactly as they are; nothing is switched off.</div>';

  if(gone.length)
    h += '<div class="ac-caution"><b>No longer orderable (' + gone.length + ')</b><br>' +
      gone.map(acEsc).join('<br>') +
      '<br><span class="ac-dash">Nothing is deleted — recipes keep costing them.</span></div>';

  if(fresh.length)
    h += '<div class="ac-caution"><b>Newly orderable (' + fresh.length + ')</b><br>' +
      fresh.slice(0,15).map(acEsc).join('<br>') + '</div>';

  if(moved.length){
    h += '<div class="ac-caution" style="max-height:210px;overflow:auto"><b>Costs moved more than 2%</b>' +
      '<br><span class="ac-dash">Per kilo or litre — every dish using one recosts when you save.</span><br>' +
      moved.slice(0,40).map(function(p){
        var up = p.now > p.before;
        return '<div>' + acEsc(p.name) + ' &middot; ' + p.before.toFixed(2) + ' &rarr; <b style="color:' +
          (up ? '#b3261e' : '#2e7d32') + '">' + p.now.toFixed(2) + '</b></div>';
      }).join('') + '</div>';
  }
  return h + '</div>';
}

/* The supplier report. `switchedOff` is the line that matters: a supplier FMC
   has turned off stops being offered when this saves, and a chef whose line
   named them starts seeing the warning. That is the whole point, so it is
   spelled out rather than counted. */
function acuShowQuotes(q){
  var h = '<div style="margin-top:12px">';
  h += acKv('Supplier prices', q.rows);
  h += acKv('Suppliers', q.suppliers);
  h += acKv('Items covered', q.articles);
  h += acKv('New supplier links', q.newLinks);

  /* Most of these are real and expected — FMC quotes 2,492 articles and the
     kitchen's catalogue carries 1,435, so the drinks range alone accounts for
     most of it. A bare count that big reads like a fault and gets ignored,
     which is how a genuine gap would hide inside it. So it says what they are
     and shows some, and the reader can tell one from the other. */
  if(q.couldNotMatch)
    h += '<div class="ac-caution" style="max-height:170px;overflow:auto">' +
      '<b>' + q.couldNotMatch + ' rows are for articles this catalogue does not carry</b> ' +
      '— mostly the drinks range, which is normal. Left out rather than guessed at. ' +
      'If you see a food item you order in here, its article is missing from the list.' +
      ((q.couldNotMatchNames && q.couldNotMatchNames.length)
        ? '<br><span class="ac-dash">' +
          q.couldNotMatchNames.slice(0,12).map(acEsc).join('<br>') + '</span>'
        : '') +
      '</div>';

  if(q.switchedOff.length)
    h += '<div class="ac-caution" style="max-height:190px;overflow:auto">' +
      '<b>FMC has switched these off (' + q.switchedOff.length + ')</b><br>' +
      '<span class="ac-dash">They stop being offered. Any item still set to one ' +
      'will show a warning until somebody picks another.</span><br>' +
      q.switchedOff.slice(0,40).map(acEsc).join('<br>') + '</div>';

  if(q.priceMoved.length)
    h += '<div class="ac-caution" style="max-height:190px;overflow:auto">' +
      '<b>Supplier prices moved more than 2%</b><br>' +
      q.priceMoved.slice(0,40).map(function(p){
        var up = p.now > p.before;
        return '<div>' + acEsc(p.supplier) + ' &middot; ' + acEsc(p.code) + ' &middot; ' +
          p.before.toFixed(2) + ' &rarr; <b style="color:' + (up?'#b3261e':'#2e7d32') + '">' +
          p.now.toFixed(2) + '</b></div>';
      }).join('') + '</div>';

  if(!q.newLinks && !q.switchedOff.length && !q.priceMoved.length)
    h += '<div class="ac-caution">No supplier or price has changed since the last update.</div>';
  return h + '</div>';
}

function acuShowAll(j){
  var h = '';
  if(j.report) h += acuShow(j.report);
  if(j.quotesReport){
    if(j.report) h += '<div class="ac-modal-group" style="margin-top:14px">Suppliers</div>';
    h += acuShowQuotes(j.quotesReport);
  }
  h += '<button type="button" class="ml-ed-btn" style="margin-top:12px" onclick="acuSave(this)">Save it</button>' +
       ' <span class="ac-dash">Nothing has been saved yet.</span>';
  document.getElementById('acu-out').innerHTML = h;
}

/* ⚠ The message is built defensively ON PURPOSE.
   The first version read `j.report.orderable` unconditionally. On a quotes-only
   upload there is no article report, so it threw — and the throw landed in the
   catch below, which printed "Nothing was saved." It had saved: 1,144 rows were
   already in the table while the screen said they were not. A save that lies
   about having happened is worse than one that fails, because the next person
   does it again. So: the outcome is decided by what the function RETURNED, and
   only the wording is allowed to fail. */
function acuSave(btn){
  btn.disabled = true; btn.textContent = 'Saving…';
  acuCall(false).then(function(j){
    if(j.error) return acuFail(j);
    var bits = [];
    if(j.report) bits.push(j.rowsInTable + ' articles' +
      /* Only claimed when this upload actually established it. On an article-only
         refresh `orderable` is null, and "null of them orderable" is worse than
         saying nothing. */
      (j.report.assortmentUntouched || j.report.orderable == null
        ? '' : ', ' + j.report.orderable + ' of them orderable'));
    if(j.quotesReport) bits.push(j.quoteRowsInTable + ' supplier prices across ' +
                                 j.quotesReport.articles + ' items');
    var said = '';
    try {
      said = '<b>Saved.</b> ' + (bits.join('. ') || 'The update went through.') +
        '.<br><span class="ac-dash">Recipes and the market list read these tables, so they ' +
        'are already showing it.</span>';
    } catch(e){ said = '<b>Saved.</b>'; }
    document.getElementById('acu-out').innerHTML =
      '<div class="ac-caution" style="border-color:#BFE0BF;background:#F4FAF4;color:#245c26">' +
      said + '</div>';
    acLoaded = false;                 // the screen behind is now out of date
    acLoad().then(acRender);
  }).catch(function(e){
    // Only a call that never returned lands here. Say what is actually known.
    document.getElementById('acu-out').innerHTML =
      '<div class="ac-caution" style="border-color:#F2B8B2;background:#FDECEA;color:#8a1c14">' +
      '<b>The connection dropped before it answered.</b><br>' + acEsc(e.message) +
      '<br><span class="ac-dash">It may or may not have saved — open the panel again ' +
      'and press See what changes. If it says nothing has changed, it saved.</span></div>';
  });
}
