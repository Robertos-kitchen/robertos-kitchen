// ══════════════════════════════════════════════════════════════════════════
// CROCKERY COUNT — the monthly plate count, off the crockery shelf.
//
// Why this is not a second department inside stock-take.js: that module is the
// monthly FOOD count, it is 109KB the kitchen depends on, and its count is ONE
// number per item (stock_take_counts.qty). Every crockery count this restaurant
// has ever kept — all three workbooks — counts TWO places, because the store and
// the floor are counted by different people in different rooms. Bending a live,
// business-critical module into a shape it was not built for, to save writing a
// screen, is how the food stock take gets broken in November.
//
// Tables: crockery (the shelf, with its photographs and its price)
//         crockery_takes  (the month header — open or closed)
//         crockery_counts (one row per piece per month: store + opp, total is
//                          GENERATED in the database so no screen can add it up
//                          wrongly)
//
// Reuses app.js globals: sb (supabase-js client), hideAllPages(), kToast(),
//   activeStation, lazyLoad().
//
// The anchoring rule is taken straight from the food stock take and it matters
// more here, not less: a counter is NEVER shown last month's number while
// counting. Somebody who can see "68" before counting counts to 68. Last month,
// the breakage and the money live on the summary, behind an admin code.
// ══════════════════════════════════════════════════════════════════════════

var CRKC_KEY   = '__crockerycount__';
var CRKC_VENUE = 'robertos-difc';
// the same three codes the food stock take uses — Antonio and Aung already carry
// them, and a second set of numbers to remember is a second set to forget
var CRKC_SUPER = { '1212':'Stock Take Admin', '0000':'Cost Controller',
                   '2468':'Stock Take Supervisor' };

var crkcUser   = null;    // { emp_id, name } — null until signed in
var crkcShelf  = [];      // the live pieces, in shelf order
var crkcMonths = [];      // every month that has ever been counted
var crkcMonth  = null;    // the one on screen
var crkcTake   = null;    // its header row
var crkcCounts = {};      // crockery_id -> { store, opp, total }
var crkcPrev   = {};      // crockery_id -> total, the month before
var crkcPrevM  = null;
var crkcTab    = 'count'; // count | summary
var crkcQ      = '';
var crkcBusy   = false;
var crkcErr    = '';

function crkcSuper(){ return !!(crkcUser && CRKC_SUPER[crkcUser.emp_id]); }
function crkcEsc(s){ return String(s==null?'':s)
  .replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function crkcOpen(){ return !!(crkcTake && crkcTake.status !== 'closed'); }

// ── the month, as the food count writes it: the last day of it ──
function crkcMonthEnd(d){
  d = d || new Date();
  var e = new Date(d.getFullYear(), d.getMonth()+1, 0);
  return e.getFullYear()+'-'+String(e.getMonth()+1).padStart(2,'0')+'-'+
         String(e.getDate()).padStart(2,'0');
}
function crkcMonthName(m){
  if (!m) return '';
  var p = String(m).split('-'), d = new Date(+p[0], +p[1]-1, +p[2]);
  return d.toLocaleDateString('en-GB', { month:'long', year:'numeric' });
}

// ══════════════════════════════════════════════════════════════════════════
function crkcInjectCss(){
  if (document.getElementById('crkc-css')) return;
  var s = document.createElement('style'); s.id = 'crkc-css';
  s.textContent = [
    '#crockerycount-view{--cv:#410207;--cvm:#5e0a10;--cvl:#7a1218;--cs:#e1d3c2;',
    '  --csl:#ede5d8;--csd:#cfc0ad;--ck:#2a1a10;--ccr:#f5ede0;--cgo:#ba9b02;--col:#4b5128;}',
    '.cvwrap{max-width:1040px;margin:0 auto;padding:14px 14px 90px;font-family:"DM Sans",sans-serif;color:var(--ck)}',
    '.cvhd{background:var(--cv);color:var(--ccr);border-radius:5px;padding:16px 18px;margin-bottom:12px}',
    '.cvhd h2{font-family:"Cormorant Garamond",Georgia,serif;font-size:27px;margin:0 0 3px;font-weight:600}',
    '.cvhd p{margin:0;font-size:13px;color:rgba(245,237,224,.88);line-height:1.5}',
    '.cvgate{background:#fff;border:2px solid var(--cv);border-radius:5px;padding:16px;margin-bottom:12px}',
    '.cvgate b{display:block;font-size:15px;margin-bottom:9px}',
    '.cvrow{display:flex;gap:9px;flex-wrap:wrap;align-items:center}',
    '.cvin{font-family:"DM Sans",sans-serif;font-size:16px;color:var(--ck);background:#fff;',
    '  border:1px solid var(--csd);border-radius:3px;padding:10px 12px;min-height:46px}',
    '.cvin:focus{border-color:var(--cv);outline:none}',
    '.cvb{font-family:"DM Sans",sans-serif;font-size:14px;font-weight:600;background:var(--cv);',
    '  color:var(--ccr);border:1px solid var(--cv);border-radius:3px;padding:0 18px;min-height:46px;cursor:pointer}',
    '.cvb:hover{background:var(--cvm)}',
    '.cvb:focus-visible,.cvb2:focus-visible{outline:3px solid var(--cgo);outline-offset:2px}',
    '.cvb[disabled]{opacity:.55;cursor:default}',
    '.cvb2{font-family:"DM Sans",sans-serif;font-size:14px;font-weight:600;background:#fff;',
    '  color:var(--cv);border:1px solid var(--csd);border-radius:3px;padding:0 16px;min-height:46px;cursor:pointer}',
    '.cvb2:hover{border-color:var(--cv)}',
    '.cvb2.on{background:var(--cv);color:var(--ccr);border-color:var(--cv)}',
    '.cvwho{display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:var(--csl);',
    '  border-radius:4px;padding:9px 12px;margin-bottom:12px;font-size:13.5px}',
    '.cvtabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}',
    '.cvtools{display:flex;gap:9px;flex-wrap:wrap;align-items:center;margin-bottom:12px}',
    '.cvtools .cvin{flex:1 1 220px;min-width:0}',
    '.cvnote{background:var(--ccr);border-left:3px solid var(--col);padding:11px 13px;',
    '  border-radius:0 3px 3px 0;font-size:13.5px;line-height:1.55;margin-bottom:12px}',
    '.cvnote.warn{border-left-color:var(--cv)}',
    '.cvgh{font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--cvl);',
    '  font-weight:700;padding:16px 0 7px}',
    '.cvr{display:flex;align-items:center;gap:12px;background:#fff;border:1px solid var(--csd);',
    '  border-radius:4px;padding:9px;margin-bottom:8px}',
    '.cvr img,.cvr .cvno{width:58px;height:58px;flex:0 0 auto;object-fit:contain;',
    '  background:var(--csl);border-radius:3px}',
    '.cvnm{flex:1 1 150px;min-width:0}',
    '.cvnm b{display:block;font-size:14.5px;font-weight:600;line-height:1.3}',
    '.cvnm span{display:block;font-size:11.5px;color:var(--cvl);margin-top:3px}',
    '.cvq{flex:0 0 auto;display:flex;gap:8px;align-items:flex-end}',
    '.cvqb{display:flex;flex-direction:column;gap:3px}',
    '.cvqb label{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--cvl);font-weight:700}',
    '.cvqb input{width:74px;font-family:"Cormorant Garamond",Georgia,serif;font-size:23px;text-align:center;',
    '  color:var(--cv);background:#fff;border:1px solid var(--csd);border-radius:3px;min-height:48px}',
    '.cvqb input:focus{border-color:var(--cv);outline:none}',
    '.cvqb input.set{background:var(--ccr);font-weight:600}',
    '.cvtot{flex:0 0 auto;min-width:62px;text-align:right}',
    '.cvtot b{display:block;font-family:"Cormorant Garamond",Georgia,serif;font-size:25px;color:var(--ck)}',
    '.cvtot span{display:block;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--cvl);font-weight:700}',
    '.cvsum{background:#fff;border:1px solid var(--csd);border-radius:4px;padding:14px;margin-bottom:12px}',
    '.cvsum h3{font-family:"Cormorant Garamond",Georgia,serif;font-size:21px;color:var(--cv);margin:0 0 10px;font-weight:600}',
    '.cvfig{display:flex;flex-wrap:wrap;gap:10px}',
    '.cvfig div{flex:1 1 130px;background:var(--csl);border-radius:4px;padding:11px 13px}',
    '.cvfig b{display:block;font-family:"Cormorant Garamond",Georgia,serif;font-size:27px;color:var(--cv);line-height:1.1}',
    '.cvfig span{display:block;font-size:10px;letter-spacing:.1em;text-transform:uppercase;',
    '  color:var(--cvl);font-weight:700;margin-top:4px}',
    '.cvtab{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:10px}',
    '.cvtab th{text-align:left;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;',
    '  color:var(--cvl);font-weight:700;padding:7px 8px;border-bottom:1px solid var(--csd)}',
    '.cvtab td{padding:8px;border-bottom:1px solid rgba(207,192,173,.55);vertical-align:middle}',
    '.cvtab td.n{text-align:right;font-variant-numeric:tabular-nums}',
    '.cvtab tr.bad td{background:rgba(65,2,7,.055)}',
    '.cvtab td.br{font-weight:700;color:var(--cv)}',
    '.cvmini{width:34px;height:34px;object-fit:contain;background:var(--csl);border-radius:2px;vertical-align:middle;margin-right:8px}',
    '.cvfold{border:0;background:none;color:var(--cvl);font-size:12.5px;font-weight:600;',
    '  cursor:pointer;padding:6px 0;text-decoration:underline;text-underline-offset:3px}',
    '.cvsaving{font-size:11px;color:var(--col);font-weight:700}',
    '@media(max-width:620px){',
    '  .cvr{flex-wrap:wrap}.cvnm{flex:1 1 100%}',
    '  .cvq{flex:1 1 auto}.cvqb input{width:100%}.cvqb{flex:1 1 0}',
    '  .cvtot{flex:0 0 auto}',
    '  .cvtab .hidemob{display:none}',
    '}',
    '@media print{',
    '  .cvhd,.cvtabs,.cvtools,.cvwho,.cvgate,.cvfold,.cvb,.cvb2,.footer-bar{display:none!important}',
    '  .cvwrap{padding:0;max-width:none}.cvsum{border:none;padding:0}',
    '}'
  ].join('');
  document.head.appendChild(s);
}

// ══════════════════════════════════════════════════════════════════════════
// loading
// ══════════════════════════════════════════════════════════════════════════
async function crkcLoadShelf(){
  // the picture and the price come with it: the picture is what stops somebody
  // counting the wrong plate, and the price is what turns breakage into a number
  // anybody outside the kitchen can act on
  var r = await sb.from('crockery')
    .select('id,name,code,source,thumb,price,sort_order')
    .eq('venue_id', CRKC_VENUE).eq('archived', false)
    .order('source').order('sort_order');
  if (r.error){ crkcErr = r.error.message; crkcShelf = []; return; }
  crkcShelf = r.data || [];
}
async function crkcLoadMonths(){
  var r = await sb.from('crockery_takes').select('*')
    .eq('venue_id', CRKC_VENUE).order('month', { ascending:false });
  crkcMonths = (r.error ? [] : (r.data || []));
  if (r.error && typeof kToast === 'function') kToast('Crockery months could not be loaded — reopen before counting.', true);
}
async function crkcLoadCounts(month, into){
  var r = await sb.from('crockery_counts').select('crockery_id,store,opp,total')
    .eq('venue_id', CRKC_VENUE).eq('month', month);
  var out = {};
  (r.error ? [] : (r.data || [])).forEach(function(c){ out[c.crockery_id] = c; });
  // Without this a failed read showed "0 of 76 counted" and breakage of AED 0 as if real.
  if (r.error && typeof kToast === 'function') kToast((into === 'prev' ? 'Last month’s counts' : 'This month’s counts') + ' could not be loaded — the figures shown are incomplete. Reopen to retry.', true);
  if (into === 'prev'){ crkcPrev = out; } else { crkcCounts = out; }
}
async function crkcOpenMonth(month){
  crkcMonth = month;
  crkcTake = crkcMonths.filter(function(t){ return t.month === month; })[0] || null;
  await crkcLoadCounts(month);
  // the month before this one, for the breakage — loaded whoever is signed in,
  // but only ever DRAWN on the summary behind an admin code
  var older = crkcMonths.filter(function(t){ return t.month < month; });
  crkcPrevM = older.length ? older[0].month : null;
  crkcPrev = {};
  if (crkcPrevM) await crkcLoadCounts(crkcPrevM, 'prev');
}

async function openCrockeryCount(){
  activeStation = CRKC_KEY;
  hideAllPages();
  var v = document.getElementById('crockerycount-view');
  v.style.display = 'block';
  document.querySelector('.footer-bar').style.display = 'flex';
  document.getElementById('foot-label').textContent = 'Crockery count';
  crkcInjectCss();
  v.innerHTML = '<div style="padding:40px;text-align:center;opacity:.6">Opening the crockery count…</div>';
  crkcErr = '';
  await crkcLoadShelf();
  await crkcLoadMonths();
  // the newest month there is — the one somebody is counting, or the last one closed
  await crkcOpenMonth(crkcMonths.length ? crkcMonths[0].month : crkcMonthEnd());
  crkcRender();
}

// ══════════════════════════════════════════════════════════════════════════
// signing in — the same employee ID the food count asks for
// ══════════════════════════════════════════════════════════════════════════
async function crkcSignIn(){
  var inp = document.getElementById('crkc-empid');
  var id = inp ? (inp.value||'').trim() : '';
  if (!id){ if (inp) inp.focus(); return; }
  if (CRKC_SUPER[id]){ crkcUser = { emp_id:id, name:CRKC_SUPER[id] }; crkcRender(); return; }
  var r = await sb.from('staff').select('id,name,emp_id')
    .eq('emp_id', id).eq('active', true).limit(1);
  var s = r.data && r.data[0];
  if (!s){
    if (typeof kToast === 'function') kToast('Employee ID '+id+' not recognised — check and try again.', true);
    return;
  }
  crkcUser = { emp_id:id, name:s.name }; crkcRender();
}
function crkcSignOut(){ crkcUser = null; crkcRender(); }

// ══════════════════════════════════════════════════════════════════════════
// writing a count — optimistic, with the row put back if the write is refused
// ══════════════════════════════════════════════════════════════════════════
async function crkcSet(id, which, raw){
  if (!crkcUser){ if (typeof kToast === 'function') kToast('Enter your employee ID first.', true); return; }
  if (!crkcOpen()){ if (typeof kToast === 'function') kToast('This month is closed. Reopen it to change a count.', true); return; }
  var el = document.getElementById('cv-'+which+'-'+id);
  var txt = String(raw == null ? (el ? el.value : '') : raw).trim();
  // empty is "not counted yet", which is a different thing from counted as zero
  var n = txt === '' ? null : Math.round(Number(txt.replace(/[^\d.-]/g,'')));
  if (n != null && (!isFinite(n) || n < 0)){
    if (typeof kToast === 'function') kToast('That is not a number of plates.', true);
    if (el) el.value = '';
    return;
  }
  var was = crkcCounts[id] ? { store:crkcCounts[id].store, opp:crkcCounts[id].opp } : null;
  var row = crkcCounts[id] || { store:null, opp:null };
  row[which] = n;
  row.total = (row.store||0) + (row.opp||0);
  crkcCounts[id] = row;
  crkcPaintRow(id);
  var body = { venue_id:CRKC_VENUE, month:crkcMonth, crockery_id:id,
               store:row.store, opp:row.opp,
               counted_by:crkcUser.emp_id, counted_by_name:crkcUser.name,
               source:'counted in the app', updated_at:new Date().toISOString() };
  var r = await sb.from('crockery_counts').upsert(body, { onConflict:'venue_id,month,crockery_id' });
  if (r.error){
    // put it back. A number that looks saved and is not is the one thing a stock
    // take must never do.
    if (was){ crkcCounts[id].store = was.store; crkcCounts[id].opp = was.opp;
              crkcCounts[id].total = (was.store||0)+(was.opp||0); }
    else delete crkcCounts[id];
    crkcPaintRow(id);
    if (typeof kToast === 'function') kToast('Not saved — '+(r.error.message||'the write was refused'), true);
  }
}
// just the one row, so a screen full of boxes never loses what is being typed in
// another of them
function crkcPaintRow(id){
  var c = crkcCounts[id] || {};
  ['store','opp'].forEach(function(k){
    var el = document.getElementById('cv-'+k+'-'+id);
    if (el && document.activeElement !== el) el.value = (c[k] == null ? '' : c[k]);
    if (el) el.classList.toggle('set', c[k] != null);
  });
  var t = document.getElementById('cv-tot-'+id);
  if (t) t.textContent = (c.store == null && c.opp == null) ? '—' : ((c.store||0)+(c.opp||0));
  var d = document.getElementById('cv-done');
  if (d) d.textContent = crkcDone() + ' of ' + crkcShelf.length + ' counted';
}
function crkcDone(){
  var n = 0;
  crkcShelf.forEach(function(p){
    var c = crkcCounts[p.id];
    if (c && (c.store != null || c.opp != null)) n++;
  });
  return n;
}

// ══════════════════════════════════════════════════════════════════════════
// the month: start one, close one, reopen one
// ══════════════════════════════════════════════════════════════════════════
async function crkcStartMonth(){
  if (!crkcSuper()){ if (typeof kToast === 'function')
    kToast('Only an admin code (1212 / 0000 / 2468) can start a count.', true); return; }
  var m = crkcMonthEnd();
  if (crkcMonths.filter(function(t){ return t.month === m; }).length){
    await crkcOpenMonth(m); crkcRender(); return;
  }
  crkcBusy = true; crkcRender();
  var r = await sb.from('crockery_takes').insert({
    venue_id:CRKC_VENUE, month:m, status:'counting', opened_by:crkcUser.name });
  crkcBusy = false;
  if (r.error){ if (typeof kToast === 'function') kToast('Not started — '+r.error.message, true);
                crkcRender(); return; }
  await crkcLoadMonths(); await crkcOpenMonth(m); crkcRender();
  if (typeof kToast === 'function') kToast(crkcMonthName(m)+' is open for counting.');
}
async function crkcCloseMonth(reopen){
  if (!crkcSuper()){ if (typeof kToast === 'function')
    kToast('Only an admin code (1212 / 0000 / 2468) can close a count.', true); return; }
  if (!crkcTake) return;
  crkcBusy = true; crkcRender();
  var r = await sb.from('crockery_takes').update({
      status: reopen ? 'counting' : 'closed',
      closed_by: reopen ? '' : crkcUser.name,
      closed_at: reopen ? null : new Date().toISOString(),
      updated_at: new Date().toISOString() })
    .eq('id', crkcTake.id);
  crkcBusy = false;
  if (r.error){ if (typeof kToast === 'function') kToast('Not changed — '+r.error.message, true);
                crkcRender(); return; }
  await crkcLoadMonths();
  crkcTake = crkcMonths.filter(function(t){ return t.month === crkcMonth; })[0] || null;
  crkcRender();
}

// ══════════════════════════════════════════════════════════════════════════
// what it all adds up to
// ══════════════════════════════════════════════════════════════════════════
function crkcTotals(){
  var t = { store:0, opp:0, total:0, counted:0, value:0, priced:0, unpriced:0,
            lost:0, lostValue:0, lostLines:0, gained:0, unpricedLost:0,
            /* how many of the lines actually COUNTED carry a price. Without this a
               screen cannot tell "nothing was worth anything" from "nothing counted
               has a price yet", and AED 0 would be printed for both. */
            valued:0, lostValued:0 };
  crkcShelf.forEach(function(p){
    var c = crkcCounts[p.id];
    var has = c && (c.store != null || c.opp != null);
    if (has){
      t.counted++;
      t.store += (c.store||0); t.opp += (c.opp||0);
      t.total += (c.store||0) + (c.opp||0);
    }
    if (p.price != null) t.priced++; else t.unpriced++;
    if (has && p.price != null){
      t.value += ((c.store||0)+(c.opp||0)) * Number(p.price); t.valued++;
    }
    var prev = crkcPrev[p.id];
    if (has && prev && prev.total != null){
      var d = prev.total - ((c.store||0)+(c.opp||0));
      if (d > 0){
        t.lost += d; t.lostLines++;
        if (p.price != null){ t.lostValue += d * Number(p.price); t.lostValued++; }
        else t.unpricedLost += d;
      } else if (d < 0) t.gained += -d;
    }
  });
  return t;
}
function crkcMoney(n){
  return 'AED ' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ══════════════════════════════════════════════════════════════════════════
// drawing
// ══════════════════════════════════════════════════════════════════════════
function crkcGateHtml(){
  return crkcUser
    ? '<div class="cvwho"><span><span style="color:#1d7a4a">●</span> Counting as <b>'+
      crkcEsc(crkcUser.name)+'</b> · #'+crkcEsc(crkcUser.emp_id)+'</span>'+
      '<button class="cvb2" onclick="crkcSignOut()">Switch</button></div>'
    : '<div class="cvgate"><b>Enter your employee ID to count</b>'+
      '<div class="cvrow"><input class="cvin" id="crkc-empid" inputmode="numeric" '+
        'placeholder="e.g. 1042" style="flex:1 1 160px" '+
        'onkeydown="if(event.key===\'Enter\')crkcSignIn()">'+
      '<button class="cvb" onclick="crkcSignIn()">Start</button></div></div>';
}
function crkcMonthPicker(){
  var opts = crkcMonths.map(function(t){
    return '<option value="'+t.month+'"'+(t.month===crkcMonth?' selected':'')+'>'+
      crkcEsc(crkcMonthName(t.month))+(t.status==='closed'?' — closed':' — counting')+'</option>';
  }).join('');
  if (!crkcMonths.length) opts = '<option>no count yet</option>';
  return '<select class="cvin" onchange="crkcPick(this.value)" '+
    'aria-label="Which count">'+opts+'</select>';
}
async function crkcPick(m){ await crkcOpenMonth(m); crkcRender(); }

function crkcCountHtml(){
  var q = crkcQ.trim().toLowerCase();
  var list = crkcShelf.filter(function(p){
    return !q || (p.name+' '+(p.code||'')+' '+(p.source||'')).toLowerCase().indexOf(q) > -1; });
  if (!list.length) return '<div class="cvnote">Nothing on the shelf matches “'+
    crkcEsc(crkcQ)+'”.</div>';
  var out = '', last = null;
  list.forEach(function(p){
    if (p.source !== last){ last = p.source;
      out += '<div class="cvgh">'+crkcEsc(last||'No group')+'</div>'; }
    var c = crkcCounts[p.id] || {};
    var tot = (c.store == null && c.opp == null) ? '—' : ((c.store||0)+(c.opp||0));
    var dis = crkcOpen() && crkcUser ? '' : ' disabled';
    out += '<div class="cvr">'+
      (p.thumb ? '<img src="'+crkcEsc(p.thumb)+'" alt="" loading="lazy">'
               : '<span class="cvno"></span>')+
      '<div class="cvnm"><b>'+crkcEsc(p.name)+'</b><span>'+
        (p.code ? crkcEsc(p.code)+' · ' : '')+
        (p.price != null ? crkcMoney(p.price)+' each' : 'no price yet')+
      '</span></div>'+
      '<div class="cvq">'+
        '<div class="cvqb"><label for="cv-store-'+p.id+'">Store</label>'+
          '<input id="cv-store-'+p.id+'" inputmode="numeric" value="'+
            (c.store == null ? '' : c.store)+'"'+(c.store!=null?' class="set"':'')+dis+
            ' onchange="crkcSet(\''+p.id+'\',\'store\')"'+
            ' onkeydown="if(event.key===\'Enter\')this.blur()"></div>'+
        '<div class="cvqb"><label for="cv-opp-'+p.id+'">In use</label>'+
          '<input id="cv-opp-'+p.id+'" inputmode="numeric" value="'+
            (c.opp == null ? '' : c.opp)+'"'+(c.opp!=null?' class="set"':'')+dis+
            ' onchange="crkcSet(\''+p.id+'\',\'opp\')"'+
            ' onkeydown="if(event.key===\'Enter\')this.blur()"></div>'+
      '</div>'+
      '<div class="cvtot"><b id="cv-tot-'+p.id+'">'+tot+'</b><span>total</span></div>'+
    '</div>';
  });
  return out;
}

function crkcSummaryHtml(){
  var t = crkcTotals();
  var out = '<div class="cvsum"><h3>'+crkcEsc(crkcMonthName(crkcMonth))+'</h3>'+
    '<div class="cvfig">'+
      '<div><b>'+t.total+'</b><span>pieces counted</span></div>'+
      '<div><b>'+t.store+'</b><span>in the store</span></div>'+
      '<div><b>'+t.opp+'</b><span>in use</span></div>'+
      '<div><b>'+t.counted+' / '+crkcShelf.length+'</b><span>lines done</span></div>'+
    '</div>';
  // ── the money. It says what it CANNOT price, every time, in the same breath.
  /* AED 0 is a number. "None of what has been counted has a price" is the truth.
     Printing the first when the second is the case is how a screen lies without
     anything on it being wrong. */
  out += '<div class="cvfig" style="margin-top:10px">'+
      '<div><b>'+(t.valued ? crkcMoney(t.value) : '—')+'</b>'+
        '<span>'+(t.valued ? 'value counted' : 'no priced line counted yet')+'</span></div>'+
      '<div><b>'+t.priced+' / '+crkcShelf.length+'</b><span>lines with a price</span></div>'+
    '</div>';
  if (t.counted && !t.valued) out += '<div class="cvnote warn">Nothing counted so far '+
    'has a price on it, so there is no value to show — that is not the same as '+
    'nothing being worth anything.</div>';
  if (t.unpriced) out += '<div class="cvnote warn"><b>'+t.unpriced+' of the '+crkcShelf.length+
    ' pieces have no price yet</b>, so the value above covers only the '+t.priced+
    ' that do. Put a price on a piece in <b>Recipes → Create → Pick off the shelf → '+
    'Manage the shelf → Correct</b>, and it is counted from then on. The count itself is '+
    'complete either way — it is only the money that is short.</div>';
  out += '</div>';

  if (!crkcSuper()){
    out += '<div class="cvnote">What was counted last month, and what is missing since, '+
      'is on an admin code (1212 / 0000 / 2468). Not to keep it secret — because '+
      'somebody who sees last month\'s number before counting counts to it.</div>';
    return out;
  }
  if (!crkcPrevM) return out + '<div class="cvnote">There is no earlier count to compare '+
    'this one with, so nothing can be called breakage yet.</div>';

  out += '<div class="cvsum"><h3>Against '+crkcEsc(crkcMonthName(crkcPrevM))+'</h3>'+
    '<div class="cvfig">'+
      '<div><b>'+t.lost+'</b><span>pieces short</span></div>'+
      '<div><b>'+(t.lostValued ? crkcMoney(t.lostValue) : '—')+'</b>'+
        '<span>'+(t.lostValued ? 'what that cost'
                               : 'none of it priced')+'</span></div>'+
      '<div><b>'+t.lostLines+'</b><span>lines affected</span></div>'+
      (t.gained ? '<div><b>'+t.gained+'</b><span>more than last time</span></div>' : '')+
    '</div>';
  if (t.unpricedLost) out += '<div class="cvnote warn">'+t.unpricedLost+' of the pieces '+
    'short have no price, so they are in the count above and not in the money.</div>';

  var rows = crkcShelf.map(function(p){
    var c = crkcCounts[p.id], pv = crkcPrev[p.id];
    if (!c || (c.store == null && c.opp == null) || !pv || pv.total == null) return null;
    var now = (c.store||0)+(c.opp||0), d = pv.total - now;
    if (!d) return null;
    return { p:p, was:pv.total, now:now, d:d,
             v: p.price != null ? d*Number(p.price) : null };
  }).filter(Boolean).sort(function(a,b){ return (b.v||0)-(a.v||0) || b.d-a.d; });

  if (rows.length){
    out += '<table class="cvtab"><thead><tr><th>Piece</th>'+
      '<th class="n">Was</th><th class="n">Now</th><th class="n">Diff</th>'+
      '<th class="n hidemob">Cost</th></tr></thead><tbody>'+
      rows.map(function(r){
        return '<tr'+(r.d>0?' class="bad"':'')+'><td>'+
          (r.p.thumb ? '<img class="cvmini" src="'+crkcEsc(r.p.thumb)+'" alt="">' : '')+
          crkcEsc(r.p.name)+'</td>'+
          '<td class="n">'+r.was+'</td><td class="n">'+r.now+'</td>'+
          '<td class="n br">'+(r.d>0?'−'+r.d:'+'+(-r.d))+'</td>'+
          '<td class="n hidemob">'+(r.v == null ? '<i>no price</i>'
            : (r.d>0 ? crkcMoney(r.v) : '—'))+'</td></tr>';
      }).join('')+'</tbody></table>';
  } else {
    out += '<div class="cvnote">Nothing has moved since '+crkcEsc(crkcMonthName(crkcPrevM))+
      ' on any line counted so far.</div>';
  }
  return out + '</div>';
}

function crkcRender(){
  var v = document.getElementById('crockerycount-view');
  if (!v) return;
  if (crkcErr){
    v.innerHTML = '<div class="cvwrap"><div class="cvnote warn"><b>The crockery shelf '+
      'could not be read.</b> '+crkcEsc(crkcErr)+'</div></div>';
    return;
  }
  var open = crkcOpen(), t = crkcTotals();
  var head = '<div class="cvhd"><h2>Crockery count</h2>'+
    '<p>The plates, counted where they are — what is in the store and what is out in '+
    'operation. Every line has its photograph, so nobody counts the wrong plate.</p></div>';

  var tools = '<div class="cvtools">'+crkcMonthPicker()+
    '<button class="cvb2'+(crkcTab==='count'?' on':'')+'" onclick="crkcTab=\'count\';crkcRender()">Count</button>'+
    '<button class="cvb2'+(crkcTab==='summary'?' on':'')+'" onclick="crkcTab=\'summary\';crkcRender()">Summary</button>'+
    (crkcSuper()
      ? (crkcTake
          ? '<button class="cvb2" onclick="crkcCloseMonth('+(open?'false':'true')+')"'+
            (crkcBusy?' disabled':'')+'>'+(open?'Close this count':'Reopen it')+'</button>'
          : '')+
        '<button class="cvb" onclick="crkcStartMonth()"'+(crkcBusy?' disabled':'')+
          '>Start this month\'s count</button>'
      : '')+
    '<button class="cvb2" onclick="window.print()">Print</button>'+
  '</div>';

  var state = '';
  if (!crkcTake){
    state = '<div class="cvnote warn"><b>No count is open.</b> '+
      (crkcSuper() ? 'Press <b>Start this month\'s count</b> and the whole shelf appears, '+
                     'ready to be counted.'
                   : 'An admin code (1212 / 0000 / 2468) starts one.')+'</div>';
  } else if (!open){
    state = '<div class="cvnote"><b>'+crkcEsc(crkcMonthName(crkcMonth))+' is closed.</b> '+
      (crkcTake.note ? crkcEsc(crkcTake.note)+' ' : '')+
      (crkcTake.closed_by ? 'Closed by '+crkcEsc(crkcTake.closed_by)+'. ' : '')+
      'Nothing on it can change until it is reopened.</div>';
  } else {
    state = '<div class="cvnote"><b id="cv-done">'+crkcDone()+' of '+crkcShelf.length+
      ' counted</b> · '+crkcEsc(crkcMonthName(crkcMonth))+' is open. '+
      'Leave a box empty if you have not counted it yet — empty is not the same as zero.</div>';
  }

  var body;
  if (crkcTab === 'summary') body = crkcSummaryHtml();
  else if (!crkcTake) body = '';
  else body = '<div class="cvtools"><input class="cvin" placeholder="Search the shelf…" '+
      'value="'+crkcEsc(crkcQ)+'" aria-label="Search the shelf" '+
      'oninput="crkcQ=this.value;crkcDraw()"></div><div id="cv-list">'+crkcCountHtml()+'</div>';

  v.innerHTML = '<div class="cvwrap">'+head+crkcGateHtml()+tools+state+body+'</div>';
}
// redraw only the list, so the search box keeps its cursor
function crkcDraw(){
  var l = document.getElementById('cv-list');
  if (l) l.innerHTML = crkcCountHtml();
}
