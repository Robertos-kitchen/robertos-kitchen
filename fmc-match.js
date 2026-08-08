// ══════════════════════════════════════════════════════════════════════════
// MATCH TO FMC
// Give every market-list line the FMC article behind it: the code, the group,
// and the cost controller's price with the sheet it came from.
//
// WHY IT IS IN THE APP — Danilo and Antonio do this work, and they should reach
// it the same way they reach everything else: Market List → Match to FMC, or
// Article Catalogue → Match the market list. No external link, no separate tool.
//
// WHAT IT NEVER DOES
//   · It never changes a market-list NAME. `Octofus` stays `Octofus`; it simply
//     learns which article it means. Renaming would move the line out from under
//     the person who types it every week.
//   · It never writes until Save is pressed. Every decision sits in memory first,
//     and the undo steps back through them one at a time.
//   · It never deactivates a line on its own. The duplicate tab proposes; a
//     person presses.
//
// "NOT AN FMC ARTICLE" is a real answer, not a skip. Four items have no article
// at all (Taleggio Valsana, gold leaves, bread improver, Hokkaido milk). Those
// get `fmc_verified_at` set with `code` left null — a human looked and there is
// nothing to find — so they stop coming back round the queue. A skip records
// nothing and returns tomorrow.
// ══════════════════════════════════════════════════════════════════════════

var FM_KEY = 'fmc_match';
var FM_SUPER = { '1212':'Admin', '0000':'Cost Controller', '2468':'Supervisor' };

var fmUser     = null;    // { emp_id, name } — who is deciding
var fmItems    = [];      // active order_items
var fmQueue    = [];      // the ones needing a person, hardest last
var fmExact    = [];      // proposed automatically, name for name
var fmDupes    = [];      // same name twice on the market list
var fmIdx      = 0;
var fmSel      = 0;
var fmDecided  = [];      // [{id,name,code,group,price,month,supplier,to}]
var fmUndo     = [];      // [{at,decided}] — steps back to the ITEM, not the last answer
var fmTab      = 'decide';
var fmSaving   = false;
var fmLoaded   = false;

function fmEsc(s){
  return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmMoney(n){ var v=Number(n); return isFinite(v)? v.toFixed(2) : '—'; }
function fmSheetShort(m){
  var d = (typeof acKeyDate==='function') ? acKeyDate(m) : null;
  return d ? d.toLocaleDateString('en-GB',{month:'short',year:'numeric'}) : String(m||'');
}

// ── matching ──────────────────────────────────────────────────────────────
// Names are typed by hand at a stove, so nothing matches on punctuation or
// case. Words of 3+ letters are compared both ways: how much of what the chef
// typed the article covers, and how much of the article the chef's words
// account for — "Rice" alone must not win a 5-word article on one hit.
function fmNorm(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
function fmToks(s){ return fmNorm(s).split(' ').filter(function(w){ return w.length>2; }); }
function fmScore(qToks, artToks){
  if(!qToks.length || !artToks.length) return 0;
  var hit = 0;
  qToks.forEach(function(w){
    if(artToks.indexOf(w) > -1){ hit += 1; return; }
    // a plural, a pack size stuck to a word, a truncation: worth most of a hit
    for(var i=0;i<artToks.length;i++){
      var a = artToks[i];
      if(a.indexOf(w)===0 || w.indexOf(a)===0){ hit += 0.6; return; }
    }
  });
  var covered = hit / qToks.length;
  var back = artToks.filter(function(w){ return qToks.indexOf(w) > -1; }).length / artToks.length;
  return covered*0.8 + back*0.2;
}

function fmBuildQueue(){
  var arts = (typeof acAll !== 'undefined' ? acAll : []).map(function(a){
    return { a:a, n:fmNorm(a.name), t:fmToks(a.name) };
  });

  fmQueue = []; fmExact = [];
  fmItems.forEach(function(it){
    if(it.code) return;                  // already carries an article
    if(it.fmc_verified_at) return;       // a person already said "no article here"
    var q = fmNorm(it.name), qt = fmToks(it.name);

    var exact = null;
    for(var i=0;i<arts.length;i++){ if(arts[i].n === q){ exact = arts[i].a; break; } }
    if(exact){ fmExact.push({ item:it, art:exact }); return; }

    var ranked = arts.map(function(e){ return { art:e.a, s:fmScore(qt, e.t) }; })
                     .sort(function(x,y){ return y.s - x.s; })
                     .slice(0, 5)
                     .filter(function(r){ return r.s >= 0.3; });
    var band = 'none';
    if(ranked.length && ranked[0].s >= 0.85 && (!ranked[1] || ranked[0].s - ranked[1].s >= 0.15)) band = 'near';
    else if(ranked.length && ranked[0].s >= 0.45) band = 'choose';
    fmQueue.push({ item:it, band:band, cands:ranked });
  });

  var ord = { near:0, choose:1, none:2 };
  fmQueue.sort(function(a,b){
    return (ord[a.band]-ord[b.band]) || a.item.name.localeCompare(b.item.name);
  });

  // the same name typed twice — a human decides which one the kitchen keeps
  var seen = {};
  fmDupes = [];
  fmItems.forEach(function(it){
    var k = fmNorm(it.name);
    if(seen[k]){ fmDupes.push([seen[k], it]); } else { seen[k] = it; }
  });
}

// ── data ──────────────────────────────────────────────────────────────────
async function fmLoad(){
  // the catalogue module owns the article list and the sheet-date tolerance;
  // load it rather than keeping a second copy of both here
  if(typeof acAll === 'undefined' || !acAll.length){
    if(typeof acLoad !== 'function'){
      await lazyLoad('article-catalogue.js?v=' + FM_BUILD);
    }
    var err = await acLoad();
    if(err) return err;
  }
  var res = await sb.from('order_items')
    .select('id,name,category,unit,code,item_group,cc_price,cc_price_month,supplier,fmc_verified_at,active')
    .eq('active', true).order('sort_order').range(0, 1999);
  if(res.error) return res.error;
  fmItems = res.data || [];
  fmBuildQueue();
  fmLoaded = true;
  return null;
}

// How many still need a person — for the count beside the button that opens this.
async function fmPendingCount(){
  var res = await sb.from('order_items').select('id', { count:'exact', head:true })
    .eq('active', true).is('code', null).is('fmc_verified_at', null);
  return res.error ? null : (res.count || 0);
}

// ── writing ───────────────────────────────────────────────────────────────
// One update per row. The market list is 459 rows and a session decides tens of
// them, so a row at a time is honest and lets a single failure name itself
// instead of a whole batch failing silently.
async function fmSave(){
  if(fmSaving || !fmDecided.length) return;
  fmSaving = true; fmRender();
  var failed = [];
  for(var i=0;i<fmDecided.length;i++){
    var d = fmDecided[i];
    var patch = { fmc_verified_at: new Date().toISOString() };
    if(fmUser) patch.fmc_verified_by = fmUser.emp_id;
    if(d.code){
      patch.code = d.code;
      patch.item_group = d.group;
      patch.cc_price = d.price;
      patch.cc_price_month = d.month;
      if(d.supplier) patch.supplier = d.supplier;
    }
    var res = await sb.from('order_items').update(patch).eq('id', d.id);
    if(res.error) failed.push(d.name + ' — ' + res.error.message);
  }
  fmSaving = false;
  if(failed.length){
    if(typeof kToast === 'function') kToast(failed.length + ' did NOT save — nothing lost, press Save again.', true);
    else alert(failed.join('\n'));
    fmRender();
    return;
  }
  var n = fmDecided.length;
  fmDecided = []; fmUndo = []; fmIdx = 0; fmSel = 0;
  await fmLoad();
  fmRender();
  if(typeof kToast === 'function') kToast('Saved ' + n + ' to the market list.');
}

// Accept every name-for-name match in one press. Shown as a list first — this
// is the one action that touches hundreds of rows, so it is never automatic.
async function fmAcceptExact(){
  if(fmSaving || !fmExact.length) return;
  if(!confirm('Write the FMC code onto ' + fmExact.length + ' lines whose name matches an article exactly?\n\nNames are not changed. You can still fix any of them afterwards.')) return;
  fmSaving = true; fmRender();
  var failed = 0;
  for(var i=0;i<fmExact.length;i++){
    var e = fmExact[i];
    var patch = { code:e.art.code, item_group:e.art.group, cc_price:e.art.price,
                  cc_price_month:e.art.month, fmc_verified_at:new Date().toISOString() };
    if(fmUser) patch.fmc_verified_by = fmUser.emp_id;
    if(e.art.supplier) patch.supplier = e.art.supplier;
    var res = await sb.from('order_items').update(patch).eq('id', e.item.id);
    if(res.error) failed++;
  }
  fmSaving = false;
  await fmLoad();
  fmRender();
  if(typeof kToast === 'function'){
    kToast(failed ? (failed + ' did not save — press again.') : 'Codes written. Now spot-check them.', !!failed);
  }
}

// A duplicate is retired, never deleted: `active = false` takes it off the
// market list and leaves every quantity ever ordered against it intact.
async function fmRetire(id, name){
  if(!confirm('Take "' + name + '" off the market list?\n\nIt stays in the database with everything ordered against it — it just stops appearing as a line to fill.')) return;
  var res = await sb.from('order_items').update({ active:false }).eq('id', id);
  if(res.error){
    if(typeof kToast === 'function') kToast('Could not remove it — ' + res.error.message, true);
    return;
  }
  await fmLoad(); fmRender();
  if(typeof kToast === 'function') kToast('"' + name + '" is off the list.');
}

// ── decisions ─────────────────────────────────────────────────────────────
function fmPick(n){ fmSel = n; fmRender(); }
function fmConfirm(){
  var r = fmQueue[fmIdx]; if(!r) return;
  var c = (r.cands||[])[fmSel]; if(!c) return;
  var a = c.art;
  fmDecided.push({ id:r.item.id, name:r.item.name, to:a.name, code:a.code,
                   group:a.group, price:a.price, month:a.month, supplier:a.supplier });
  fmUndo.push({ at:fmIdx, decided:true });
  fmIdx++; fmSel = 0; fmRender();
}
function fmNoArticle(){
  var r = fmQueue[fmIdx]; if(!r) return;
  fmDecided.push({ id:r.item.id, name:r.item.name, to:'no FMC article', code:null });
  fmUndo.push({ at:fmIdx, decided:true });
  fmIdx++; fmSel = 0; fmRender();
}
function fmSkip(){
  if(fmIdx >= fmQueue.length) return;
  fmUndo.push({ at:fmIdx, decided:false });
  fmIdx++; fmSel = 0; fmRender();
}
function fmUndoLast(){
  var last = fmUndo.pop(); if(!last) return;
  if(last.decided) fmDecided.pop();
  fmIdx = last.at; fmSel = 0; fmRender();
}

// ── render ────────────────────────────────────────────────────────────────
function fmRender(){
  var v = document.getElementById('fmcmatch-view'); if(!v) return;

  if(!fmUser){ v.innerHTML = fmSignInHtml(); fmFocusFirst('fm-empid'); return; }

  var tabs = [['decide','Decide',fmQueue.length - fmIdx],
              ['exact','Name-for-name',fmExact.length],
              ['dupes','Same name twice',fmDupes.length]];
  v.innerHTML =
    '<div class="ops-title">Match to FMC</div>' +
    '<div class="ops-subtitle">Deciding as <b>'+fmEsc(fmUser.name)+'</b> · the market list keeps its own names — this only adds the article behind each one</div>' +
    '<div class="fm-tabs">' + tabs.map(function(t){
      return '<button class="fm-tab'+(fmTab===t[0]?' on':'')+'" onclick="fmGo(\''+t[0]+'\')">'+t[1]+
             '<span class="fm-badge">'+t[2]+'</span></button>';
    }).join('') + '</div>' +
    '<div id="fm-body" tabindex="-1" style="outline:none"></div>';

  var b = document.getElementById('fm-body');
  if(fmTab === 'decide')      b.innerHTML = fmDecideHtml();
  else if(fmTab === 'exact')  b.innerHTML = fmExactHtml();
  else                        b.innerHTML = fmDupesHtml();
  // the decide screen is worked entirely from the keyboard, so it takes the
  // keyboard the moment it is drawn — otherwise the number keys do nothing
  // until someone happens to click the page.
  if(fmTab === 'decide') b.focus({ preventScroll:true });
}
function fmFocusFirst(id){ setTimeout(function(){ var e=document.getElementById(id); if(e) e.focus(); }, 50); }
function fmGo(t){ fmTab = t; fmRender(); }

function fmSignInHtml(){
  return '<div class="ops-title">Match to FMC</div>' +
    '<div class="ops-subtitle">The market list learns which FMC article each line means</div>' +
    '<div class="fm-signin">' +
      '<div class="fm-signin-t">Who is deciding?</div>' +
      '<div class="fm-signin-p">Your employee ID. The app records who chose each article, so a wrong one can be traced and fixed rather than argued about.</div>' +
      '<div style="display:flex;gap:8px;margin-top:10px">' +
        '<input class="check-input" id="fm-empid" inputmode="numeric" placeholder="e.g. 1042" style="flex:1" onkeydown="if(event.key===\'Enter\')fmSignIn()">' +
        '<button class="report-btn" onclick="fmSignIn()">Start</button>' +
      '</div>' +
    '</div>';
}
async function fmSignIn(){
  var inp = document.getElementById('fm-empid');
  var id = inp ? (inp.value||'').trim() : '';
  if(!id){ if(inp) inp.focus(); return; }
  if(FM_SUPER[id]){ fmUser = { emp_id:id, name:FM_SUPER[id] }; fmRender(); return; }
  var res = await sb.from('staff').select('name,emp_id').eq('emp_id', id).eq('active', true).limit(1);
  var staff = res.data && res.data[0];
  if(!staff){
    if(typeof kToast === 'function') kToast('Employee ID ' + id + ' not recognised — check and try again.', true);
    return;
  }
  fmUser = { emp_id:id, name:staff.name };
  fmRender();
}

function fmSavedHtml(){
  if(!fmDecided.length) return '';
  return '<div class="fm-saved">' +
    '<h3>Decided, not yet written — ' + fmDecided.length + '</h3>' +
    fmDecided.slice().reverse().slice(0, 12).map(function(d){
      return '<div class="fm-srow"><div>'+fmEsc(d.name)+'</div>' +
        '<div class="fm-arrow">&rarr; '+fmEsc(d.to)+'</div>' +
        '<div>'+(d.code?'<span class="fm-pill">'+fmEsc(d.code)+'</span>':'<span class="fm-pill no">no article</span>')+'</div></div>';
    }).join('') +
    '<div class="fm-savebar">' +
      '<button class="fm-btn primary" onclick="fmSave()"'+(fmSaving?' disabled':'')+'>' +
        (fmSaving ? 'Saving…' : 'Save ' + fmDecided.length + ' to the market list') + '</button>' +
    '</div></div>';
}

function fmDecideHtml(){
  if(!fmQueue.length){
    return '<div class="fm-card"><div class="fm-done"><div class="fm-done-big">Nothing left to decide.</div>' +
      '<div class="fm-done-sub">Every line either carries an FMC code or has been looked at and marked as having none.</div></div></div>' + fmSavedHtml();
  }
  if(fmIdx >= fmQueue.length){
    return '<div class="fm-card"><div class="fm-done"><div class="fm-done-big">That is the whole queue.</div>' +
      '<div class="fm-done-sub">'+fmDecided.length+' decided. Nothing is written until you press Save.</div></div></div>' + fmSavedHtml();
  }

  var r = fmQueue[fmIdx], it = r.item;
  var BAND = { near:'near certain', choose:'needs you', none:'nothing close' };
  var cands = r.cands || [];
  var rows = cands.length ? cands.map(function(c, n){
    var a = c.art;
    return '<div class="fm-cand'+(n===fmSel?' sel':'')+'" onclick="fmPick('+n+')">' +
      '<div class="fm-key">'+(n+1)+'</div>' +
      '<div><div class="fm-cn">'+fmEsc(a.name)+'</div>' +
        '<div class="fm-cm"><span class="ac-code">'+fmEsc(a.code)+'</span><span>'+fmEsc(a.group)+'</span>' +
        (a.supplier?'<span>'+fmEsc(a.supplier)+'</span>':'') + '</div></div>' +
      '<div class="fm-unit">'+fmEsc(a.unit)+'</div>' +
      '<div class="fm-price">'+fmMoney(a.price)+' <span class="fm-cur">AED</span>' +
        '<div class="fm-pnote">'+fmSheetShort(a.month)+' sheet</div></div>' +
    '</div>';
  }).join('')
  : '<div class="fm-nothing">Nothing in the catalogue comes close. Either it is bought outside FMC, or an article needs creating — mark it below and it stays on the market list either way.</div>';

  return '<div class="fm-bar">' +
      '<span class="fm-pos">'+(fmIdx+1)+' of '+fmQueue.length+'</span>' +
      '<span class="fm-band '+r.band+'">'+BAND[r.band]+'</span>' +
      '<div class="fm-track"><div class="fm-fill" style="width:'+Math.round(fmIdx/fmQueue.length*100)+'%"></div></div>' +
      '<span class="fm-pos">'+(fmQueue.length-fmIdx)+' left</span>' +
    '</div>' +
    '<div class="fm-card">' +
      '<div class="fm-asked">' +
        '<div class="fm-lab">The market list says</div>' +
        '<div class="fm-nm">'+fmEsc(it.name)+'</div>' +
        '<div class="fm-meta">'+fmEsc(it.category)+(it.unit?' · '+fmEsc(it.unit):'')+' · the name does not change</div>' +
      '</div>' +
      '<div>'+rows+'</div>' +
      '<div class="fm-acts">' +
        (cands.length?'<button class="fm-btn primary" onclick="fmConfirm()">Confirm '+(fmSel+1)+'<small>Enter</small></button>':'') +
        '<button class="fm-btn" onclick="fmNoArticle()">Not an FMC article<small>N</small></button>' +
        '<button class="fm-btn" onclick="fmSkip()">Skip for now<small>S</small></button>' +
        (fmUndo.length?'<button class="fm-btn" onclick="fmUndoLast()" style="margin-left:auto">Undo last<small>&larr;</small></button>':'') +
      '</div>' +
    '</div>' +
    '<div class="fm-keys"><span><kbd>1</kbd>–<kbd>5</kbd> pick</span><span><kbd>&uarr;</kbd><kbd>&darr;</kbd> move</span>' +
      '<span><kbd>Enter</kbd> confirm</span><span><kbd>N</kbd> no article</span><span><kbd>S</kbd> skip</span><span><kbd>&larr;</kbd> undo</span></div>' +
    fmSavedHtml();
}

function fmExactHtml(){
  if(!fmExact.length){
    return '<div class="fm-card"><div class="fm-done"><div class="fm-done-big">None waiting.</div>' +
      '<div class="fm-done-sub">Every name-for-name match has already been written.</div></div></div>';
  }
  return '<div class="fm-note">These <b>'+fmExact.length+'</b> market-list names are the same as an FMC article, word for word. ' +
      'Read down the list first — anything that looks wrong, leave it and fix it on Decide afterwards.</div>' +
    '<div class="fm-card"><div class="fm-acts" style="border-bottom:1px solid #f0e9df;border-top:0">' +
      '<button class="fm-btn primary" onclick="fmAcceptExact()"'+(fmSaving?' disabled':'')+'>' +
      (fmSaving?'Writing…':'Write the code onto all '+fmExact.length)+'</button>' +
      '<span class="fm-hintline">Names are never changed. Any line can be corrected afterwards.</span>' +
    '</div>' +
    fmExact.slice(0, 120).map(function(e){
      return '<div class="fm-exrow"><div>'+fmEsc(e.item.name)+'</div>' +
        '<div class="fm-arrow">&rarr; '+fmEsc(e.art.name)+'</div>' +
        '<div><span class="ac-code">'+fmEsc(e.art.code)+'</span></div></div>';
    }).join('') +
    (fmExact.length > 120 ? '<div class="fm-more">…and '+(fmExact.length-120)+' more</div>' : '') +
    '</div>';
}

function fmDupesHtml(){
  if(!fmDupes.length){
    return '<div class="fm-card"><div class="fm-done"><div class="fm-done-big">No name appears twice.</div></div></div>';
  }
  return '<div class="fm-note">The same name is on the market list more than once. Nothing is removed automatically — ' +
      'keep the one the kitchen actually fills in, and take the other off. Everything ever ordered against it is kept.</div>' +
    fmDupes.map(function(pair){
      return '<div class="fm-card" style="margin-bottom:10px">' +
        pair.map(function(it){
          return '<div class="fm-duprow"><div><div class="fm-cn">'+fmEsc(it.name)+'</div>' +
            '<div class="fm-cm"><span>'+fmEsc(it.category)+'</span>'+(it.unit?'<span>'+fmEsc(it.unit)+'</span>':'')+
            (it.code?'<span class="ac-code">'+fmEsc(it.code)+'</span>':'<span>no article yet</span>')+'</div></div>' +
            '<button class="fm-btn" onclick="fmRetire('+it.id+',&quot;'+fmEsc(it.name)+'&quot;)">Take this one off</button></div>';
        }).join('') +
      '</div>';
    }).join('');
}

// ── keyboard ──────────────────────────────────────────────────────────────
document.addEventListener('keydown', function(e){
  if(typeof activeStation === 'undefined' || activeStation !== FM_KEY) return;
  if(fmTab !== 'decide' || !fmUser) return;
  var t = e.target;
  if(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  var r = fmQueue[fmIdx]; if(!r) return;
  var n = Number(e.key);
  if(n >= 1 && n <= 5 && (r.cands||[]).length >= n){ e.preventDefault(); fmSel = n-1; fmRender(); return; }
  if(e.key === 'Enter'){ e.preventDefault(); fmConfirm(); return; }
  if(e.key === 'ArrowDown'){ e.preventDefault(); fmSel = Math.min(fmSel+1, (r.cands||[]).length-1); fmRender(); return; }
  if(e.key === 'ArrowUp'){ e.preventDefault(); fmSel = Math.max(fmSel-1, 0); fmRender(); return; }
  if(e.key === 'ArrowLeft'){ e.preventDefault(); fmUndoLast(); return; }
  var k = String(e.key||'').toLowerCase();
  if(k === 'n'){ e.preventDefault(); fmNoArticle(); return; }
  if(k === 's'){ e.preventDefault(); fmSkip(); return; }
});

// ── css ───────────────────────────────────────────────────────────────────
function fmInjectCss(){
  if(document.getElementById('fm-css')) return;
  var s = document.createElement('style');
  s.id = 'fm-css';
  s.textContent = [
    '#fmcmatch-view{position:relative;overflow-y:auto;-webkit-overflow-scrolling:touch}',
    '.fm-signin{background:#fff;border:1px solid rgba(107,31,42,.15);border-radius:10px;padding:16px;max-width:460px;margin-top:10px}',
    '.fm-signin-t{font-family:Georgia,serif;font-size:17px;color:#2C1810}',
    '.fm-signin-p{font-size:12px;color:#8B7355;margin-top:4px;line-height:1.45}',
    '.fm-tabs{display:flex;gap:6px;margin:8px 0 10px;flex-wrap:wrap}',
    '.fm-tab{border:1px solid rgba(107,31,42,.15);background:#fff;color:#8B7355;border-radius:20px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;display:flex;gap:6px;align-items:center}',
    '.fm-tab.on{background:#6B1F2A;border-color:#6B1F2A;color:#fff}',
    '.fm-badge{background:rgba(0,0,0,.08);border-radius:9px;padding:0 6px;font-size:11px}',
    '.fm-tab.on .fm-badge{background:rgba(255,255,255,.22)}',
    '.fm-note{background:#fff;border:1px solid rgba(107,31,42,.15);border-left:3px solid #C9A84C;border-radius:6px;padding:10px 12px;font-size:13px;color:#8B7355;margin-bottom:10px}',
    '.fm-note b{color:#2C1810}',
    '.fm-bar{display:flex;align-items:center;gap:12px;margin-bottom:10px;flex-wrap:wrap}',
    '.fm-pos{font-size:12px;color:#8B7355;font-weight:600}',
    '.fm-track{flex:1;min-width:120px;height:8px;background:#e6dccd;border-radius:5px;overflow:hidden}',
    '.fm-fill{height:100%;background:#C9A84C}',
    '.fm-band{font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;border-radius:4px;padding:2px 7px}',
    '.fm-band.near{background:#e7f0e4;color:#3f6b39;border:1px solid #cfe1c9}',
    '.fm-band.choose{background:#f7edd2;color:#8a6a1f;border:1px solid #e6d7a8}',
    '.fm-band.none{background:#f6e6e4;color:#8a3226;border:1px solid #e8cdc8}',
    '.fm-card{background:#fff;border:1px solid rgba(107,31,42,.15);border-radius:12px;overflow:hidden}',
    '.fm-asked{padding:14px 16px;border-bottom:1px solid #f0e9df;background:#faf6f0}',
    '.fm-lab{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#8B7355}',
    '.fm-nm{font-family:Georgia,serif;font-size:22px;margin-top:3px;color:#2C1810}',
    '.fm-meta{font-size:12px;color:#8B7355;margin-top:3px}',
    '.fm-cand{display:grid;grid-template-columns:26px 1fr 108px 96px;gap:10px;align-items:center;padding:10px 16px;border-bottom:1px solid #f4ece1;cursor:pointer}',
    '.fm-cand:last-child{border-bottom:0}',
    '.fm-cand.sel{background:#fbf6ee;box-shadow:inset 3px 0 0 #C9A84C}',
    '.fm-key{width:22px;height:22px;border-radius:5px;border:1px solid rgba(107,31,42,.15);background:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;color:#6B1F2A}',
    '.fm-cn{font-size:14px;font-weight:600;color:#2C1810}',
    '.fm-cm{font-size:11px;color:#8B7355;margin-top:2px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
    '.fm-unit{font-size:12px;color:#8B7355;text-align:right}',
    '.fm-price{text-align:right;font-weight:700;font-size:14px;color:#2C1810}',
    '.fm-cur{font-size:10px;color:#8B7355}',
    '.fm-pnote{font-size:10px;color:#8B7355;font-weight:500}',
    '.fm-nothing{padding:18px 16px;color:#8B7355;font-size:13px;line-height:1.5}',
    '.fm-acts{display:flex;gap:8px;padding:12px 16px;background:#faf6f0;border-top:1px solid #f0e9df;flex-wrap:wrap;align-items:center}',
    '.fm-btn{border:1px solid rgba(107,31,42,.15);background:#fff;color:#2C1810;border-radius:7px;padding:9px 14px;font-size:13px;font-weight:600;cursor:pointer}',
    '.fm-btn.primary{background:#6B1F2A;border-color:#6B1F2A;color:#fff}',
    '.fm-btn[disabled]{opacity:.55;cursor:default}',
    '.fm-btn small{display:block;font-weight:500;font-size:10px;opacity:.7}',
    '.fm-hintline{font-size:11px;color:#8B7355}',
    '.fm-keys{margin-top:10px;font-size:11px;color:#8B7355;display:flex;gap:14px;flex-wrap:wrap}',
    '.fm-keys kbd{background:#fff;border:1px solid rgba(107,31,42,.15);border-bottom-width:2px;border-radius:4px;padding:0 5px;font-size:10px;font-weight:600;color:#2C1810}',
    '.fm-saved{margin-top:12px;background:#fff;border:1px solid rgba(107,31,42,.15);border-radius:10px;overflow:hidden}',
    '.fm-saved h3{margin:0;padding:9px 12px;background:#efe6da;color:#6B1F2A;font-size:11px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase}',
    '.fm-srow,.fm-exrow{display:grid;grid-template-columns:1fr 1fr 96px;gap:8px;padding:8px 12px;border-bottom:1px solid #f4ece1;font-size:12px;align-items:center}',
    '.fm-arrow{color:#8B7355}',
    '.fm-pill{font-size:10px;font-weight:700;border-radius:4px;padding:1px 6px;background:#e7f0e4;color:#3f6b39}',
    '.fm-pill.no{background:#f6e6e4;color:#8a3226}',
    '.fm-savebar{padding:12px;background:#faf6f0;border-top:1px solid #f0e9df}',
    '.fm-duprow{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:11px 14px;border-bottom:1px solid #f4ece1}',
    '.fm-duprow:last-child{border-bottom:0}',
    '.fm-done{padding:28px;text-align:center}',
    '.fm-done-big{font-family:Georgia,serif;font-size:24px;color:#2C1810}',
    '.fm-done-sub{color:#8B7355;font-size:13px;margin-top:6px}',
    '.fm-more{padding:10px;text-align:center;color:#8B7355;font-size:12px;background:#fbf7f1}',
    '@media(max-width:640px){',
      '.fm-cand{grid-template-columns:26px 1fr 84px}',
      '.fm-unit{display:none}',
      '.fm-srow,.fm-exrow{grid-template-columns:1fr 1fr}',
      '.fm-srow div:last-child,.fm-exrow div:last-child{display:none}',
    '}'
  ].join('\n');
  document.head.appendChild(s);
}

// ── entry point ───────────────────────────────────────────────────────────
var FM_BUILD = '1791000000';   // kept in step with index.html's ?v= on this file

async function openFmcMatch(){
  activeStation = FM_KEY;
  hideAllPages();
  fmInjectCss();
  if(typeof acInjectCss === 'function') acInjectCss();   // the code chip is the catalogue's
  var v = document.getElementById('fmcmatch-view');
  v.style.display = 'block';
  document.querySelector('.footer-bar').style.display = 'flex';
  document.getElementById('foot-label').textContent = 'Match to FMC';
  v.innerHTML = '<div style="padding:40px;text-align:center;opacity:.6">Loading the market list and the articles…</div>';

  var err = await fmLoad();
  if(err){
    v.innerHTML = '<div class="report-no-data">Could not load the list — check the connection and open it again.</div>';
    console.warn('fmc match load failed', err);
    return;
  }
  fmIdx = 0; fmSel = 0; fmDecided = []; fmUndo = []; fmTab = 'decide';
  fmRender();
}
