// ══════════════════════════════════════════════════════════════════════════
// ARTICLE CATALOGUE
// The FMC article master, read-only. The "second list": what an ingredient is
// really called, what its code is, and what the last sheet valued it at.
//
// SOURCE — stock_take_items. Aung uploads an FMC export every month; four
// sheets are held. One row per CODE, taking the newest sheet that carries it.
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
// PRICE — stock_take_items.price is the cost controller's monthly valuation,
// not the FMC purchase price. Measured: Cucumber Medium -GCC reads 4.96 here
// and 4.50 in FMC, out by 10%. So it is labelled as his figure, with its
// month, everywhere it appears. See order-items-fmc-columns.sql.
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
// TWO TABLES, TWO DIFFERENT JOBS — and only one of them says what is orderable
//
// `fmc_articles` (harvested from the Kitchen Market List assortment) decides
// IDENTITY and AVAILABILITY: the article's real name, the unit FMC counts it
// in, its supplier, and whether it can be ordered at all.
//
// `stock_take_items` supplies the PRICE and nothing else. It is an inventory
// export and it keeps discontinued articles indefinitely, so it can never be
// asked whether something is orderable. The note this file used to carry —
// that a short July sheet does not mean an article is gone — was right, and
// this is the fix it was waiting for: the assortment answers that question
// properly, so absence from a stock sheet no longer has to mean anything.
//
// What that changes on screen: an article FMC has dropped is now SAID to be
// dropped instead of being listed as if it could be bought. Four were proved
// dead on 8 Aug 2026 (4029044, 4017171, 4017201, 4017263) and this screen
// showed all four as ordinary articles.
// ══════════════════════════════════════════════════════════════════════════
async function acLoad(){
  // Ask for one row with supplier in it. A column that doesn't exist is a 400
  // from PostgREST, so this settles the question for a single tiny request
  // instead of throwing away a full four-sheet read to find out.
  var probe = await sb.from('stock_take_items').select('code,supplier').limit(1);
  acHasSupplier = !probe.error;

  var res = await acFetchAllPaged(function(){
    return sb.from('stock_take_items').select(acSelectCols())
      .eq('venue_id', STOCK_VENUE_AC).eq('dept', STOCK_DEPT_AC).eq('active', true).order('id');
  });
  if(res.error){
    acAll = [];
    return res.error;
  }

  // The assortment. If this fails the screen still works off the stock sheets
  // alone, exactly as it did before — but then nothing claims to know what is
  // orderable, because it doesn't.
  var arts = {}, haveArts = false;
  var ares = await acFetchAllPaged(function(){
    return sb.from('fmc_articles').select('code,name,unit,supplier,on_assortment,retiring')
      .eq('venue_id','robertos-difc').order('code');
  });
  if(!ares.error && ares.data && ares.data.length){
    haveArts = true;
    ares.data.forEach(function(a){ arts[String(a.code).trim()] = a; });
  }

  // one row per code, from the NEWEST sheet that carries it
  var by = {};
  (res.data||[]).forEach(function(r){
    var code = String(r.code||'').trim();
    if(!code) return;                       // hand-added count lines carry no article
    if(acIsBatch(r.item_group)) return;     // made in-house, never ordered
    var prev = by[code];
    if(!prev){ by[code] = r; return; }
    var a = acKeyDate(r.month), b = acKeyDate(prev.month);
    if(a && b && a > b) by[code] = r;
  });

  acAll = Object.keys(by).map(function(c){
    var r = by[c];
    var art = arts[c];
    return {
      code:c,
      // FMC's own name wins where we have it — that is the name on an order,
      // an invoice and a delivery note, and it is the one a chef should learn.
      name:(art && art.name) || r.name || '',
      group:r.item_group||'Other',
      unit:(art && art.unit) || r.unit || '',
      price:r.price, month:r.month,
      supplier:(art && art.supplier) || r.supplier || '',
      orderable: haveArts ? !!(art && art.on_assortment) : null,   // null = unknown
      retiring: !!(art && art.retiring)
    };
  });

  // Articles on the assortment that no stock sheet carries are still orderable
  // and still belong here — they simply have no valuation yet.
  if(haveArts){
    Object.keys(arts).forEach(function(c){
      if(by[c]) return;
      var a = arts[c];
      if(!a.on_assortment) return;
      acAll.push({ code:c, name:a.name||'', group:'Other', unit:a.unit||'',
                   price:null, month:null, supplier:a.supplier||'',
                   orderable:true, retiring:!!a.retiring });
    });
  }
  // group then name — so the headings read top to bottom instead of jumping
  acAll.sort(function(a,b){
    return a.group===b.group ? a.name.localeCompare(b.name) : a.group.localeCompare(b.group);
  });
  acLoaded = true;
  return null;
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
    '<div class="ops-subtitle">Every article FMC can order · read-only · look here for the real name and code' +
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
    cEl.innerHTML = '<span>'+acShown.length+' of '+acAll.length+' articles'+(acGroup?' · '+acEsc(acGroup):'')+'</span>' +
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
            // the assortment did not load, and then nothing is claimed either
            // way — a wrong "dropped" would stop a chef ordering something
            // perfectly good.
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
        '<div class="ac-price">'+acMoney(r.price)+' <span class="ac-cur">AED</span>' +
          '<div class="ac-pricenote">'+(r.month ? acSheetShort(r.month)+' sheet' : 'no sheet price')+'</div></div>' +
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
        acKv('Cost controller\'s price', acMoney(r.price)+' AED') +
        acKv('From the sheet of', acSheetLabel(r.month)) +
        acKv('Supplier', supplierLine) +
        '<div class="ac-caution">This is Aung\'s monthly valuation, not the price FMC puts on the order — ' +
        'the two drift by up to about 10%. Use it to judge, not to quote.</div>' +
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

function acOpenUpload(){
  var old = document.getElementById('ac-sheet'); if(old) old.remove();
  acuParsed = { assortment:null, master:null };

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
          'Clear any group filter first or drinks are left out.' +
        '</div>' +
        '<label class="ac-kv" style="cursor:pointer"><span>Assortment List (PDF)</span>' +
          '<span id="acu-s1" style="text-align:right">choose&hellip;' +
          '<input type="file" accept=".pdf,application/pdf" id="acu-f1" style="display:none"></span></label>' +
        '<label class="ac-kv" style="cursor:pointer"><span>Manage Articles (XLS)</span>' +
          '<span id="acu-s2" style="text-align:right">choose&hellip;' +
          '<input type="file" accept=".xls,.xlsx" id="acu-f2" style="display:none"></span></label>' +
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

/* A disabled button always says what it is waiting for. */
function acuReady(){
  var why = [];
  if(!acuParsed.assortment) why.push('the Assortment List');
  if(!acuParsed.master) why.push('the Manage Articles file');
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
                           dryRun:dryRun, assortment:acuParsed.assortment, master:acuParsed.master })
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
    acuShow(j.report);
  }).catch(function(e){
    go.textContent = 'See what changes'; go.disabled = false;
    acuFail({ problems:[e.message] });
  });
}

function acuShow(r){
  var h = '<div style="margin-top:12px">';
  h += acKv('Articles', r.articles);
  h += acKv('You can order', r.orderable);
  h += acKv('New to the list', r.addedCount);
  h += acKv('Costs that moved', r.priceMoved.length);

  if(!r.addedCount && !r.priceMoved.length && !r.noLongerOrderable.length && !r.nowOrderable.length)
    h += '<div class="ac-caution">Nothing has changed since the last update.</div>';

  if(r.unmatchedAssortmentLines.length)
    h += '<div class="ac-caution"><b>' + r.unmatchedAssortmentLines.length + ' lines on the assortment ' +
      'match no article</b> — usually a group filter left on the Manage Articles export. They stay ' +
      'exactly as they are; nothing is switched off.</div>';

  if(r.noLongerOrderable.length)
    h += '<div class="ac-caution"><b>No longer orderable (' + r.noLongerOrderable.length + ')</b><br>' +
      r.noLongerOrderable.map(acEsc).join('<br>') +
      '<br><span class="ac-dash">Nothing is deleted — recipes keep costing them.</span></div>';

  if(r.nowOrderable.length)
    h += '<div class="ac-caution"><b>Newly orderable (' + r.nowOrderable.length + ')</b><br>' +
      r.nowOrderable.slice(0,15).map(acEsc).join('<br>') + '</div>';

  if(r.priceMoved.length){
    h += '<div class="ac-caution" style="max-height:210px;overflow:auto"><b>Costs moved more than 2%</b>' +
      '<br><span class="ac-dash">Per kilo or litre — every dish using one recosts when you save.</span><br>' +
      r.priceMoved.slice(0,40).map(function(p){
        var up = p.now > p.before;
        return '<div>' + acEsc(p.name) + ' &middot; ' + p.before.toFixed(2) + ' &rarr; <b style="color:' +
          (up ? '#b3261e' : '#2e7d32') + '">' + p.now.toFixed(2) + '</b></div>';
      }).join('') + '</div>';
  }
  h += '<button type="button" class="ml-ed-btn" style="margin-top:12px" onclick="acuSave(this)">Save it</button>' +
       ' <span class="ac-dash">Nothing has been saved yet.</span></div>';
  document.getElementById('acu-out').innerHTML = h;
}

function acuSave(btn){
  btn.disabled = true; btn.textContent = 'Saving…';
  acuCall(false).then(function(j){
    if(j.error) return acuFail(j);
    document.getElementById('acu-out').innerHTML =
      '<div class="ac-caution" style="border-color:#BFE0BF;background:#F4FAF4;color:#245c26">' +
      '<b>Saved.</b> ' + j.rowsInTable + ' articles, ' + j.report.orderable + ' of them orderable.' +
      '<br><span class="ac-dash">Recipes and the market list read this table, so they are already ' +
      'showing it.</span></div>';
    acLoaded = false;                 // the screen behind is now out of date
    acLoad().then(acRender);
  }).catch(function(e){ acuFail({ problems:[e.message] }); });
}
