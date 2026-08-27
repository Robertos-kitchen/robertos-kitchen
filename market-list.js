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
  await Promise.all([loadMarketQuantities(), loadFmcPrices(), loadRequisitions(), loadFmcQuotes()]);
  mlApplyFmcFacts();   // FMC owns the name and the unit - see mlApplyFmcFacts
}

// ── what the order is worth, and what it became in Materials Control ───────
// Both read their table. Neither keeps a copy of a number that lives in the
// database, so a price change or a new requisition shows up here by itself.
const ML_VENUE = 'robertos-difc';
let mlPrices = {};   // FMC article code -> the QUOTED price per order unit
let mlPpbu   = {};   // FMC article code -> what we LAST PAID, per base unit
let mlArtName = {};  // FMC article code -> the name FMC holds
let mlArtUnit = {};  // FMC article code -> the purchase unit FMC holds
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
  mlPpbu = {};
  mlArtName = {};
  mlArtUnit = {};
  const rows = await mlFetchAllPaged(function(){
    return sb.from('fmc_articles')
      .select('code,price,price_per_base_unit,name,unit').eq('venue_id', ML_VENUE);
  });
  (rows||[]).forEach(r=>{
    const c = r.code != null ? String(r.code).trim() : '';
    if(!c) return;
    if(r.price != null) mlPrices[c] = Number(r.price);
    if(r.price_per_base_unit != null) mlPpbu[c] = Number(r.price_per_base_unit);
    if(r.name) mlArtName[c] = String(r.name).trim();
    if(r.unit) mlArtUnit[c] = String(r.unit).trim();
  });
}

// ── who FMC will actually take the order from ──────────────────────────────
// fmc_price_quotes is FMC's own Purchase | Price Quotes list, exported from the
// screen that decides this and loaded per article. It holds ONLY the links FMC
// has switched on (E/D), so a supplier in here is one an order will be accepted
// for. This matters because the two disagree: on 15 Aug 2026 Turbot 4026100 had
// been bought from Simply Gourmet, and FMC offers only Wisk - buying history
// says who we USED, this says who we CAN use.
//
// order_items.supplier is our own choice and stays stored, because the choice is
// ours to make. What is NOT stored is whether that choice is still possible -
// that is read from here on every load. On 15 Aug 2026 sixty-one lines still
// named Zurich Foodstuff Trading, whose every FMC link had been switched off, so
// the app was naming a supplier no order could go to and nothing said so.
let mlQuotes = {};   // FMC article code -> [{supplier, unit, price, priced}], newest priced first
// False until the quotes actually arrive. mlOffListFlag says "FMC holds it but
// has no supplier linked to it" off an EMPTY list for that code, and an empty
// list is also what a failed fetch looks like — so without this the flag would
// state as fact something it never checked. Same rule as mlArtLoaded above.
let mlQuotesLoaded = false;
async function loadFmcQuotes(){
  mlQuotes = {};
  mlQuotesLoaded = false;
  const rows = await mlFetchAllPaged(function(){
    return sb.from('fmc_price_quotes')
      .select('code,supplier,unit,price_per_unit,price_per_base_unit,last_price_update')
      .eq('venue_id', ML_VENUE);
  });
  if(rows && rows.length) mlQuotesLoaded = true;
  (rows||[]).forEach(function(r){
    const c = r.code != null ? String(r.code).trim() : '';
    if(!c || !r.supplier) return;
    (mlQuotes[c] = mlQuotes[c] || []).push({
      supplier: String(r.supplier).trim(),
      unit: r.unit ? String(r.unit).trim() : '',
      price: r.price_per_unit == null ? null : Number(r.price_per_unit),
      base: r.price_per_base_unit == null ? null : Number(r.price_per_base_unit),
      priced: r.last_price_update || ''
    });
  });
  // Newest price first. FMC dates every quote itself, so this needs no history.
  Object.keys(mlQuotes).forEach(function(c){
    mlQuotes[c].sort(function(a,b){ return String(b.priced).localeCompare(String(a.priced)); });
  });
}

// What FMC will accept for this line, and whether our stored choice is among it.
// An empty list means the catalogue has nothing for the code - NOT that the item
// cannot be ordered - so the caller shows the stored supplier unchanged rather
// than inventing a warning. A missing match is not a missing capability.
function mlSupplierState(it){
  const c = it && it.code != null ? String(it.code).trim() : '';
  const opts = (c && mlQuotes[c]) || [];
  const stored = it && it.supplier ? String(it.supplier).trim() : '';
  if(!opts.length){
    // No options is two different situations and they must not look alike.
    // If the article catalogue knows this code, FMC holds the article and has
    // simply switched every supplier link off - nobody can order it, and that
    // has to be said. Apple Cider Vinegar 4017238 is the live example: its only
    // supplier was Zurich, now discontinued, and the line still read normally.
    // If the catalogue does not know the code either, we know nothing - show
    // the stored supplier unchanged rather than invent a warning.
    const inCatalogue = !!(c && mlArtName[c]);
    return { opts:[], stored:stored, known:false, none:inCatalogue, ok:!inCatalogue, chosen:null };
  }
  const chosen = opts.find(function(o){ return o.supplier === stored; }) || null;
  return { opts:opts, stored:stored, known:true, none:false, ok:(!stored || !!chosen), chosen:chosen };
}

// mlMoney rounds to whole dirhams, which is right for an order worth 38,072 and
// wrong here: it printed Ali Gholami's 2.85 as "3" against Wahat's 4.00, hiding
// the fils the comparison is actually made of.
function mlUnitPrice(n){
  if(n == null) return '';
  return Number(n).toLocaleString('en-GB', { minimumFractionDigits:2, maximumFractionDigits:2 });
}

function mlPricedLabel(d){
  if(!d) return '';
  const p = String(d).split('-');
  if(p.length !== 3) return String(d);
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return 'priced ' + Number(p[2]) + ' ' + (M[Number(p[1])-1] || p[1]);
}

// ── the name and the unit belong to FMC, not to us ────────────────────────
// order_items carries its own `name` and `unit`, and they drift. On 14 Aug 2026
// forty-nine names and two hundred and eleven units disagreed with fmc_articles:
// a chef was reading "Turbot -Portugal" for an article FMC calls "-Spain", and
// units typed by hand - `pun`, `1kg`, `200g`, `1x6` - against FMC's real pack.
// Fixing those once only buys time until the next drift, so the display now
// READS the article table. The stored copy stays untouched as the fallback for
// a line with no code, or one whose code the catalogue has not seen yet.
//
// This overlays the in-memory rows only. Nothing is written back: order_items
// keeps its own values, so nothing is lost and this is reversible by deleting
// the call.
function mlApplyFmcFacts(){
  (mlItems||[]).forEach(function(it){
    const c = it && it.code != null ? String(it.code).trim() : '';
    if(!c) return;
    if(mlArtName[c]) it.name = mlArtName[c];
    if(mlArtUnit[c]) it.fmc_unit = mlArtUnit[c];
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

// A last-paid price that no supplier comes near is a receiving error, not a
// bargain. Radish Red -Holland reads 2.75 a kilo in FMC while every supplier
// quotes 25.00-27.50 - checked 16 Aug 2026. Such a line is still counted, never
// dropped, and the tile says how many are in doubt: a total that quietly
// swallowed it would read 25 AED light with nothing on screen to say so.
function mlPriceLooksWrong(code, ppbu){
  if(ppbu == null) return false;
  const q = (mlQuotes[code]||[]).map(x=>x.base).filter(v=>v!=null && v>0);
  if(!q.length) return false;
  const lo = Math.min.apply(null, q), hi = Math.max.apply(null, q);
  return ppbu < lo/2 || ppbu > hi*2;
}

// ⚠ VALUED ON WHAT WE LAST PAID, AND NOT AS `qty * price`. The old line read the
// QUOTED price per order unit, which only the 15-minute Price Quotes export
// refreshes and which reaches 456 articles; `price_per_base_unit` is FMC's Last
// Purchase Price, comes off the 24-second article export, and covers all 1,435.
//
// The multiplier is the MARKET LIST'S OWN `pack_size`, deliberately - not FMC's.
// The two FMC files disagree about what a pack is: Yeast Dry 500gm is
// `Ctn/20x500 Gm` in the article master and `Pkt/1x500 Gm` in the supplier's
// quote, both 16 a kilo and twenty times apart per pack. The kitchen orders in
// the market list's unit, so that is the one that may do the converting. Checked
// on the real list, 16 Aug 2026: 326 of 402 lines land on exactly today's
// figure, yeast among them at 8.00 rather than 160.00, and the rest are the
// genuine gap between a quote and what we actually paid.
//
// The quoted price stays as the fallback, so a line with no pack size is no
// worse off than it is today.
function mlOrderValue(days){
  let total=0, priced=0, unpriced=0, odd=0;
  mlItems.forEach(it=>{
    const code = (it.code||'').trim();
    const pack = Number(it.pack_size);
    const ppbu = code ? mlPpbu[code] : undefined;
    const paid = (pack && ppbu != null) ? pack * ppbu : null;
    const per  = paid != null ? paid : (code ? mlPrices[code] : undefined);
    const doubt = paid != null && mlPriceLooksWrong(code, ppbu);
    days.forEach(wd=>{
      const qty = Number(mlQty[it.id+'|'+wd]);
      if(!qty) return;
      if(per == null){ unpriced++; return; }
      total += qty * per; priced++;
      if(doubt) odd++;
    });
  });
  return { total, priced, unpriced, odd };
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
        if(activeStation !== ORDER_KEY) return;
        // A drag-reorder can rewrite several rows at once and each one comes
        // back as its own event. Reloading all 425 items once per event would
        // hammer the table and re-render the grid out from under the finger
        // that is still holding a row. The dragger skips its own echo; every
        // other screen coalesces the burst into one reload.
        if(Date.now() < mlReorderEchoUntil) return;
        // Taking a line off and putting it back are the same case as a drag:
        // this browser has already applied the change to mlItems and redrawn
        // the rows, so reloading all 415 items to be told what it just did is
        // pure waste — and the redraw it triggers is what threw Antonio to the
        // top of the list. Every OTHER screen still reloads, as it must.
        if(Date.now() < mlQuickEditEchoUntil) return;
        mlScheduleItemsReload();
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

// Loaded once per open, after the grid is drawn. Everything EXCEPT adding must
// work at full speed whether or not this ever arrives - reading, ordering and
// the quantities all do. Adding cannot: since 21 Aug 2026 a line needs an FMC
// article behind it, so with no catalogue there is nothing to pick from. The
// add box says it is still loading and mlAddCustom refuses rather than
// creating a row it cannot justify.
async function mlLoadArticles(){
  var rows = await mlFetchAllPaged(function(){
    return sb.from('fmc_articles')
      .select('code,name,unit,supplier,on_assortment,retiring')
      .eq('venue_id','robertos-difc')
      .order('name');
  });
  if(!rows || !rows.length) return;          // no catalogue -> no claims

  // ⚠ TWO LISTS OUT OF ONE FETCH, AND THEY ARE NOT THE SAME LIST.
  //
  // Until 19 Aug 2026 this asked for `on_assortment = true` and used that one
  // set for both jobs, which capped what could be ADDED at 451 of the 1,436
  // articles FMC holds. That was right while the FMC assortment was fixed and
  // this app could only describe it. It is backwards now: the market list is
  // mirrored INTO the assortment, so limiting the chef to what is already on
  // the assortment means he can only add what is already there — the exact
  // thing the mirror exists to fix. Antonio hit it building a new list.
  //
  // Excluding `retiring` is what takes 1,436 down to 1,000 rather than any
  // judgement of ours: those 436 are FMC's own withdrawn stock, renamed ZZZ…
  // in its master. Nobody should be offered them.
  mlArticles = rows.filter(function(a){ return !a.retiring; });

  // The FLAGS keep keying off the assortment ALONE. Widening this map as well
  // would have silently switched off every "not on our list" warning — the
  // flag fires on a code being ABSENT from it, so filling it with off-list
  // articles makes the warning unreachable, and a line that cannot be ordered
  // would look perfectly healthy. Two collections, two jobs.
  mlArtByCode = {};
  rows.forEach(function(a){
    if(a.on_assortment) mlArtByCode[String(a.code).trim()] = a;
  });
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
  if(!art) return mlOffListFlag(code);
  if(art.retiring) return { kind:'retiring', label:'retiring',
    why:'FMC is withdrawing this article. It can still be ordered today.' };
  return null;
}

// ── a code that is not on OUR list ────────────────────────────────────────
// ⚠ THIS SAID "dead code NNNNNNN — FMC will not accept it" UNTIL 19 Aug 2026,
// AND BOTH HALVES WERE FALSE. Francesco reported it on 4012124 Activ Dried
// Sourdough 1Kg: FMC holds that article, quotes it through Alba Foodstuff
// Trading LLC at 60.00 per Pkt/1x1 Kg with FMC's own price dated 1 Aug 2026,
// and we paid 60.00 for it on 30 Mar. Nothing about the code is dead, and FMC
// accepts the article perfectly well.
//
// What is true is narrower, and it is OUR gap rather than FMC's: the article
// is not on the Kitchen Market List assortment, so an order raised off that
// list cannot carry it. Saying "FMC will not accept" blamed FMC for a line
// missing from a list we maintain, and a chef reading "dead code" concludes
// the number is wrong or the product is discontinued. Neither is the case.
//
// The old copy also offered exactly one way out — repoint — and for this line
// there is none: all six sourdough articles in FMC are off the assortment,
// three of them ZZZ/retiring. So the single instruction on screen was the one
// thing that could not be done, and the thing that CAN be done (put it on the
// assortment) was never mentioned. Both routes are named now.
//
// Three situations hid behind one message and they need different actions, so
// they are separated here. `mlArtName` is the whole master (loadFmcPrices does
// not filter on the assortment), which is what makes the first two knowable:
//   FMC sells it              -> add it to the assortment, or point elsewhere
//   FMC holds it, no supplier -> point elsewhere; nobody can supply it today
//   FMC has never heard of it -> the NUMBER is wrong, which is the only case
//                                the old wording was ever right about
function mlOffListFlag(code){
  var known = mlArtName[code];
  if(!known) return { kind:'dead', label:'code not in FMC',
    why:'FMC has no article ' + code + '. The number itself looks wrong — point this line at the right article.' };
  var q = mlQuotesLoaded ? (mlQuotes[code] || [])[0] : null;
  if(!mlQuotesLoaded) return { kind:'dead', label:'not on our list',
    why:known + ' is in FMC as ' + code + ', but it is not on the Kitchen Market List assortment, so an order cannot carry it. Add it to the assortment in FMC — search by its NAME, the code will not find it — or point this line at an article that is on it.' };
  // ⚠ THIS SAID "FMC holds it but has no supplier linked to it" for one morning
  // and that was a claim about FMC made from OUR records. It was inferred from
  // an empty `mlQuotes[code]`, and `fmc_price_quotes` is a separate export on
  // its own schedule — four days stale on 19 Aug 2026, when the routine robot
  // run stopped carrying the price half. Holm Oak charcoal 1106015 tripped it
  // while the market list had iGrade stored as its supplier the whole time.
  // What is actually known is what WE have on file, so that is what it says.
  if(!q) return { kind:'dead', label:'not on our list',
    why:known + ' is in FMC as ' + code + ', but it is not on the Kitchen Market List assortment, so an order cannot carry it. We have no supplier price from FMC on file for it either. Add it to the assortment in FMC — search by its NAME, the code will not find it — or point this line at an article that is on the list.' };
  return { kind:'dead', label:'not on our list',
    why:'FMC sells this — ' + q.supplier +
        (q.price != null ? ', ' + q.price.toFixed(2) + (q.unit ? ' per ' + q.unit : '') : '') +
        '. It is just not on the Kitchen Market List assortment, so an order cannot carry it. ' +
        'Add it to the assortment in FMC — search by its NAME, the code will not find it — or point this line at an article that is on it.' };
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

  // Free text used to be offered here when CREATING a line, and is not any
  // more - Francesco removed it 21 Aug 2026. A line with no FMC article
  // cannot be ordered: the mirror's `read_market_list` keeps only lines that
  // carry a code, so an uncoded line is invisible to FMC for ever, and the
  // sync then looks as though it quietly did less than it said. It was
  // already unused - 0 of 404 active lines had no code on the day it went.
  //
  // Adding and repointing now behave the SAME WAY: only a real article will
  // do, and 'nothing matches' is a dead end rather than a way through.
  if(!st.hits.length) html = '<div class="ml-pick-free">Nothing on the FMC assortment matches. '
    + 'An item has to be in the FMC article catalogue before it can go on the market list.</div>';
  if(safe === 'repoint'){
    box.innerHTML = html;
    box.style.display = 'block';
    Array.prototype.forEach.call(box.querySelectorAll('[data-i]'), function(el){
      el.onclick = function(e){ e.stopPropagation(); mlPickChoose('', 'repoint', +el.dataset.i); };
    });
    return;
  }

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
  if(e.key === 'ArrowDown' && open){ e.preventDefault(); st.sel = Math.max(0, Math.min(st.hits.length - 1, st.sel+1)); mlRenderPickMenu(category, safe); }
  else if(e.key === 'ArrowUp' && open){ e.preventDefault(); st.sel = Math.max(0, st.sel-1); mlRenderPickMenu(category, safe); }
  else if(e.key === 'Escape' && open){ e.preventDefault(); box.style.display='none'; }
  else if(e.key === 'Enter'){
    e.preventDefault();
    if(open) mlPickChoose(category, safe, st.sel);
    else mlAddCustom(category, safe);        // refused unless an article is picked; was: catalogue never loaded — plain add
  }
}

function mlPickChoose(category, safe, i){
  var st = mlPickState[safe]; if(!st) return;
  var box = document.getElementById('mlpick-' + safe);
  var inp = document.getElementById('mladd-' + safe);
  if(i >= 0 && i < st.hits.length){
    st.picked = st.hits[i];
    if(inp) inp.value = st.picked.name;
  } else {
    // No row past the last hit exists any more, and with no hits at all the
    // selection sits at -1. Either way this is not a choice: close the menu
    // and add NOTHING. st.hits[-1] would be undefined and throw on .name.
    st.picked = null;
    if(box) box.style.display = 'none';
    return;
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
// ONE way in: the item must be picked from the FMC article catalogue. The
// pick fills code, fmc_unit and supplier here, with no second step for
// anybody, and stamps fmc_verified_at - a line resolved against the
// assortment is at least as trustworthy as one matched by hand on the
// Match-to-FMC screen, and leaving it blank would send it back into that
// queue to be answered a second time.
//
// Free text used to be a second way in, and was removed 21 Aug 2026. An
// uncoded line cannot be ordered and cannot be mirrored into FMC, so it sat
// on the list looking real. Everything below assumes `art` exists; the gate
// that makes that true is the first thing in the function, because all three
// routes in - the Add button, Enter, and a pick from the menu - land here.
async function mlAddCustom(category, safe){
  if(!mlMayEditList('Adding an item')) return;
  const inp = document.getElementById('mladd-' + safe);
  if(!inp) return;
  const typed = (inp.value||'').trim();
  if(!typed) return;
  const st = mlPickState[safe] || {};
  const art = st.picked || null;

  // THE GATE. Nothing goes on the market list without an FMC article behind
  // it. Refuse out loud and say what to do - a silent return on a pressed
  // button reads as the app being broken.
  if(!mlArtLoaded){
    alert('The FMC article list has not loaded yet - give it a moment and try again.');
    return;
  }
  if(!art){
    alert('Choose the item from the list that drops down as you type.\n\n'
        + 'Only items in the FMC article catalogue can go on the market list, so that '
        + 'they can actually be ordered.\n\n'
        + 'If “' + typed + '” is not in that list, it has to be added in Materials '
        + 'Control first.');
    return;
  }

  // ── slot it ALPHABETICALLY inside its category ──────────────────────────
  // This appended to the end of the category until 19 Aug 2026. Antonio had
  // just asked for the whole list in alphabetical order and every one of the
  // 406 lines was renumbered that morning to give him it - so appending would
  // have started undoing that on the very next add, and the person adding is
  // the person who asked for the order.
  //
  // The renumber left a gap of 10 between neighbours, so a new line takes the
  // midpoint and nothing else has to move. If a gap has been used up, it falls
  // back to appending rather than colliding: a line at the end of its category
  // is easy to see and to drag, a duplicate sort_order is neither.
  //
  // Sorted on the name as SHOWN, which for a coded line is FMC's name, not the
  // one typed here - mlApplyFmcFacts overwrites it on every load, so sorting on
  // anything else puts the row somewhere the eye will not find it.
  const newName = ((art ? art.name : typed) || '').trim().toLowerCase();
  const inCat = mlItems.filter(i=>i.category===category)
                       .sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));
  let before = null, after = null;
  for(const i of inCat){
    if(((i.name||'').trim().toLowerCase()) <= newName) before = i;
    else { after = i; break; }
  }
  let slot;
  if(!inCat.length)      slot = 10;
  else if(!before)       slot = (after.sort_order||10) - 5;
  else if(!after)        slot = (before.sort_order||0) + 10;
  else                   slot = Math.floor(((before.sort_order||0) + (after.sort_order||0)) / 2);
  if(before && slot <= (before.sort_order||0)){         // no gap left - append instead
    slot = Math.max(...inCat.map(i=>i.sort_order||0)) + 10;
  }

  const row = { name: art.name, category,
                unit: art.unit || '',
                sort_order: slot, active:true,
                code: art.code,
                fmc_unit: art.unit || null,
                supplier: art.supplier || null,
                fmc_verified_at: new Date().toISOString(),
                fmc_verified_by: 'catalogue' };

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
    kToast('✓ ' + art.name + ' added · ' + art.code + ' · ' + (art.unit||''));
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
  if(!mlMayEditList('Repointing a line at another article')) return;
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
// ── WHY THIS FUNCTION SAVES AND RESTORES THE SCROLL, AND WHY IT USED TO FAIL ──
// Antonio, 18 Aug 2026: "everytime i remove something from the "market list"
// automatically it will bring me on top of the list, and this is not
// comfortable." He was 9000px down a 415-row list every time.
//
// This function already tried to hold the position and could never work, for
// two independent reasons, both measured on the live app (build 1787062218):
//
//   1. WRONG ELEMENT. It saved and restored `#order-view.scrollTop`.
//      #order-view carries overflow-y:auto so it looks like the scroller, but it
//      is never given a height — measured 20960 scrollHeight / 20960 clientHeight
//      — so it cannot scroll and the DOCUMENT moves instead (21056 / 720).
//      Saving it always read 0 and restoring it was a silent no-op.
//   2. WRONG MOMENT. The restore ran immediately after the shell was written,
//      while #ml-content was still empty. The document is 720px tall at that
//      instant, so the browser clamps any restore to 0 — fixing only the element
//      would still have landed at the top. Measured: restore-before-rows 0,
//      restore-after-rows 9000.
//
// Restoring is deliberately NOT done on every render. Opening the market list
// from another view must land at the top, and this function is what draws it on
// open too. Only the realtime path — someone else changing an item under you —
// asks for the position back, by setting mlKeepScrollOnNextRender.
function renderMarketList(){
  const ov = document.getElementById('order-view');
  const sc = mlScroller(ov || document.body);
  const keepScroll = mlKeepScrollOnNextRender;
  mlKeepScrollOnNextRender = false;              // one render only, never sticky
  const savedScroll = keepScroll ? mlScrollTop(sc) : 0;
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
        <button class="report-btn ml-quickedit" id="ml-quickedit" onclick="mlQuickEditToggle()">🔒 Edit list</button>
        <button class="report-btn ml-sortaz" id="ml-sortaz" onclick="mlSortAZ()" style="display:none"
                title="Put every category back into A–Z order — it says how many items move before it moves any">Sort A–Z</button>
        <button class="report-btn ml-undo" id="ml-undo" onclick="mlUndoLast()" disabled>↩ Undo</button>
        <span class="ml-actions-gap"></span>
        <button class="report-btn" onclick="mlPrint()">Print</button>
        <button class="report-btn" onclick="mlEmailPrompt()">Email chefs</button>
        <button class="report-btn" id="ml-fmc" onclick="openFmcMatch()">Match to FMC</button>
        <button class="report-btn" onclick="mlOrderHelper()">Order helper</button>
      </div>
    </div>

    <div id="ml-quickbar"></div>

    ${isMobile ? `
      <div class="ml-dayswitch">
        ${[1,2,3,4,5,6].map(wd=>`<button class="ml-dayswitch-btn${(mlActiveDay||todayWd||1)===wd?' active':''}" onclick="mlPickDay(${wd})">${ML_DAYS[wd-1]}${wd===todayWd?' •':''}</button>`).join('')}
      </div>` : `
      <div class="ml-dayhide">
        <span class="ml-dayhide-label">Show days:</span> ${dayChips}
      </div>`}

    <div id="ml-summary"></div>
    <div id="ml-content"></div>

    <button class="ml-top" id="ml-top" onclick="mlScrollToTop()" aria-label="Scroll to top">↑</button>
  `;

  mlRenderRows(days);
  mlRenderSummary();
  mlFmcCount();
  mlRenderQuickBar();   // the toolbar was just rebuilt — put the two buttons back

  // AFTER the rows, never before: see reason 2 in the note above this function.
  // The rows are in the DOM now, so the document is tall enough to hold the
  // position instead of clamping it to the top.
  if(savedScroll) mlSetScrollTop(sc, savedScroll);

  // Show/hide the ↑ button off the element that actually moves.
  mlBindScrollTop(sc);
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
  const noteBits = [val.unpriced
    ? `${val.priced} of ${val.priced+val.unpriced} lines priced`
    : `${scope} · at what we last paid`];
  if(val.odd) noteBits.push(`${val.odd} to check`);
  const valueNote = noteBits.join(' · ');

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

// ══════════════════════════════════════════════════════════════════════════
// DRAG TO REORDER  (touch + mouse + keyboard)
//
// Antonio asked for this: "we need the chance to move up and down based on our
// need, the item on the market list". The order the items sit in is the order
// the chefs walk the list in, and it never matched anybody's need — it was the
// order they happened to be seeded in.
//
// Ported from fish-display.js (fdGripDown / fdGripMove / fdGripUp): same ⠿
// grip, same "Drag to reorder" title, same Pointer Events. A chef who has
// reordered the fish list must not have to learn a second gesture.
//
// Two things the fish list never had to solve, and this list does:
//   • 425 items in 16 categories. A drag is confined to ONE category's block
//     (`.ml-catrows`). ML_CAT_ORDER decides where a category sits on screen, so
//     a row dragged out of its own block would simply snap back — better that
//     it cannot leave in the first place.
//   • The list is many screens tall. A finger held near the top or bottom of
//     #order-view scrolls it, or dragging something from the bottom of
//     VEGETABLES to the top is impossible on a phone, not merely slow.
//
// `sort_order` is one global sequence (checked against the live table 13 Aug:
// 10, 20, 30 … with the categories in contiguous blocks). So a single move
// normally needs ONE write — the row takes the midpoint of the gap between its
// new neighbours. Only when a gap is used up does the category get respaced,
// and even then strictly inside the span it already occupies, so it can never
// walk into the next category's numbers.
// ══════════════════════════════════════════════════════════════════════════
let mlDrag = null;            // { id, rowEl, container } while a row is held
let mlDragEndedAt = 0;        // the click that follows a drop is not a tap
let mlDragClientY = 0;
let mlAutoScrollTimer = null;
let mlItemsReloadTimer = null;
let mlReorderEchoUntil = 0;   // ignore our own realtime echo until this moment
let mlQuickEditEchoUntil = 0; // ditto for taking a line off / putting it back
let mlKeepScrollOnNextRender = false;  // set only by the realtime reload; see renderMarketList

// Reordering is only offered on the whole list. While a search or "Ordered
// only" is on, the rows on screen are a subset, and renumbering a subset would
// silently shuffle the items it is hiding.
// MOVING A ROW IS A CHANGE TO THE LIST, NOT PART OF ORDERING - 20 Aug 2026.
//
// The 2468 lock of 19 Aug covered adding a line, taking one off, repointing it
// at another article and changing its supplier. It did NOT cover the drag, and
// the team moved rows by accident: eight lines were found sitting on half-step
// sort_order values (110045, 130185, 130195 - the fingerprint of a drop between
// two rows), and the alphabetical order Antonio had just rebuilt had to be
// rebuilt again from the database.
//
// A drag is not a private act. It rewrites the order every other chef sees, and
// the FMC assortment is mirrored FROM this order - so a row dragged here moves
// in Materials Control too, the next time the mirror runs. That is the same
// class of change as adding an ingredient nobody agreed to, which is what
// Antonio asked for the code for.
//
// ORDERING IS UNTOUCHED. Anybody can still type quantities against a day, always
// - that is what the boys are on this screen to do, and no code is ever asked
// for. Only the ORDER OF THE ROWS is behind the code.
//
// Nothing new is drawn for this: the grip already renders `.off` with a reason
// in its tooltip whenever reordering is unavailable (search, Ordered only), and
// a press on a locked grip already toasts mlWhyNoReorder(). Unlocking re-renders
// the rows, so the grips come alive the moment the code is accepted.
function mlCanReorder(){ return mlEditUnlocked && !mlSearch && !mlOrderedOnly; }
function mlWhyNoReorder(){
  if(!mlEditUnlocked)
    return 'The list is locked, so rows cannot be moved. Ordering is not affected '
         + '- you can still type quantities. To change the order, tap the bar at '
         + 'the top of the screen and enter the admin code.';
  return mlSearch ? 'Clear the search box to drag items into a new order.'
                  : 'Untick “Ordered only” to drag items into a new order.';
}
function mlRowEl(id){ return document.querySelector('#ml-content .ml-row-tap[data-id="'+id+'"]'); }

// HOW THE HELD ROW MOVES (rewritten 13 Aug 2026, same day as fish-display.js).
// The first version — ported from the fish list before the fish list was fixed
// — left the held row sitting in the layout and re-inserted it in the DOM as the
// pointer crossed each mid-point. Measured on the fish list, which used the
// identical code: the row finished 39px behind the pointer on a 40px row. On a
// mouse that reads as a row that does not move at all and then jumps a whole
// line, late. Antonio reported exactly that about the fish display.
//
// Now the row is glued to the pointer with a transform and the rows it displaces
// slide aside on a short transition. Geometry is measured ONCE on grab, in
// scroller coordinates, so auto-scrolling mid-drag cannot corrupt it; the DOM is
// not touched until the drop, so there is no per-move layout work over 400 rows
// and no flicker when the pointer hovers a boundary.
function mlScrollTop(sc){
  return (sc === document.scrollingElement || sc === document.documentElement || sc === document.body)
    ? window.scrollY : sc.scrollTop;
}
// Reading the scroll position needed to know which element really moves; so
// does writing it. Without this half, a restore silently wrote to an element
// that does not scroll — which is exactly the bug fixed on 18 Aug 2026.
function mlIsDocScroller(sc){
  return sc === document.scrollingElement || sc === document.documentElement || sc === document.body;
}
function mlSetScrollTop(sc, y){
  if(mlIsDocScroller(sc)) window.scrollTo(0, y); else sc.scrollTop = y;
}

// ── THE ↑ BUTTON, AND WHY IT HAD NEVER APPEARED ───────────────────────────────
// It was wired `ovAfter.onscroll` on #order-view and it hid itself until
// `order-view.scrollTop > 200`. #order-view never scrolls (see mlScroller), so
// that event never fired once, the button sat at display:none for its whole
// life, and its click handler scrolled an element that cannot move. Measured on
// the live app 18 Aug 2026 at scrollY 9000: display "none".
// Same misread element as the scroll-restore below, so it is fixed here with it.
var mlTopScroller = null, mlTopBoundTo = null;
function mlScrollTopSync(){
  var b = document.getElementById('ml-top');
  if(!b || !mlTopScroller) return;
  b.style.display = mlScrollTop(mlTopScroller) > 200 ? 'flex' : 'none';
}
function mlBindScrollTop(sc){
  mlTopScroller = sc;
  // The document's scroll event fires on window, not on documentElement.
  var target = mlIsDocScroller(sc) ? window : sc;
  if(mlTopBoundTo !== target){
    if(mlTopBoundTo) mlTopBoundTo.removeEventListener('scroll', mlScrollTopSync);
    target.addEventListener('scroll', mlScrollTopSync, { passive:true });
    mlTopBoundTo = target;                  // rebound only when the scroller changes, never stacked per render
  }
  mlScrollTopSync();
}
function mlScrollToTop(){
  var sc = mlTopScroller || document.scrollingElement || document.documentElement;
  if(mlIsDocScroller(sc)) window.scrollTo({ top:0, behavior:'smooth' });
  else sc.scrollTo({ top:0, behavior:'smooth' });
}
function mlGripDown(e, id){
  if(e.button && e.button!==0) return;                  // primary button / touch only
  e.preventDefault(); e.stopPropagation();
  if(!mlCanReorder()){ if(typeof kToast==='function') kToast(mlWhyNoReorder()); return; }
  if(mlDrag) return;
  const rowEl = mlRowEl(id); if(!rowEl) return;
  const container = rowEl.closest('.ml-catrows'); if(!container) return;
  const scroller = mlScroller(container);
  const st = mlScrollTop(scroller);
  const box = rowEl.getBoundingClientRect();
  const others = Array.from(container.querySelectorAll('.ml-row-tap[data-id]')).filter(r=>r!==rowEl);
  const geo = others.map(r=>{ const b=r.getBoundingClientRect(); return { el:r, mid:b.top+st+b.height/2 }; });
  // Clamp to the category block's top and bottom EDGES, not to the first and
  // last mid-point: clamping to mid-points leaves the very last slot
  // unreachable, and does it silently.
  const tops = others.map(r=>r.getBoundingClientRect().top+st).concat([box.top+st]);
  const bots = others.map(r=>r.getBoundingClientRect().bottom+st).concat([box.bottom+st]);
  mlDrag = {
    id, rowEl, container, scroller, others: geo,
    h: box.height,
    from: others.filter(r=>r.compareDocumentPosition(rowEl)&Node.DOCUMENT_POSITION_FOLLOWING).length,
    startDocY: e.clientY + st,
    startMid: box.top + st + box.height/2,
    minDocY: Math.min.apply(null, tops),
    maxDocY: Math.max.apply(null, bots),
    dy: 0, to: 0, raf: 0
  };
  mlDrag.to = mlDrag.from;
  mlDragClientY = e.clientY;
  rowEl.classList.add('ml-dragging');
  document.body.classList.add('ml-dragging-active');
  geo.forEach(g=>g.el.classList.add('ml-shift'));
  try{ e.target.setPointerCapture(e.pointerId); mlDrag.grip = e.target; mlDrag.pid = e.pointerId; }catch(_){}
  document.addEventListener('pointermove', mlGripMove, { passive:false });
  document.addEventListener('pointerup', mlGripUp, true);
  document.addEventListener('pointercancel', mlGripUp, true);
  mlDrag.raf = requestAnimationFrame(mlDragFrame);
}

function mlGripMove(e){
  if(!mlDrag) return;
  if(e.cancelable) e.preventDefault();                  // stop the page scrolling under the finger
  mlDragClientY = e.clientY;
}

// One frame: scroll if the pointer is near an edge, glue the row to the pointer,
// then open the gap where it would land. Driven off rAF rather than a 16ms
// interval so it cannot run twice between paints, and so a finger held still
// while the content scrolls under it still re-slots.
function mlDragFrame(){
  if(!mlDrag) return;
  const d = mlDrag;
  mlAutoScrollTick();

  const docY = mlDragClientY + mlScrollTop(d.scroller);
  let dy = docY - d.startDocY;
  const mid = d.startMid + dy;
  if(mid < d.minDocY) dy += d.minDocY - mid;            // stay inside this category
  if(mid > d.maxDocY) dy += d.maxDocY - mid;
  if(dy !== d.dy){ d.dy = dy; d.rowEl.style.transform = 'translateY(' + dy + 'px)'; }

  const c = d.startMid + d.dy;
  let to = 0; for(const g of d.others) if(g.mid < c) to++;
  if(to !== d.to){
    d.to = to;
    d.others.forEach((g,i)=>{
      const shift = (i >= to && i < d.from) ?  d.h
                  : (i >= d.from && i < to) ? -d.h : 0;
      g.el.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
    });
  }
  d.raf = requestAnimationFrame(mlDragFrame);
}

// WHICH element actually scrolls is not obvious and must not be assumed.
// #order-view carries `overflow-y:auto`, so it looks like the scroller — but it
// is never given a height, so its scrollHeight equals its clientHeight and the
// DOCUMENT is what moves. Measured in the running app 13 Aug: order-view
// 21365/21365, documentElement 902/21461. Scrolling `order-view.scrollTop`
// would have been a silent no-op and the auto-scroll simply would not work.
// So: walk up for the first ancestor that can really scroll, else the document.
function mlScroller(el){
  for(let n = el; n && n !== document.body; n = n.parentElement){
    const oy = getComputedStyle(n).overflowY;
    if(/(auto|scroll|overlay)/.test(oy) && n.scrollHeight > n.clientHeight + 2) return n;
  }
  return document.scrollingElement || document.documentElement;
}
function mlScrollerRect(sc){
  return (sc === document.scrollingElement || sc === document.documentElement || sc === document.body)
    ? { top: 0, bottom: window.innerHeight }
    : sc.getBoundingClientRect();
}

// Top threshold clears the sticky category heading; without that the held row
// parks underneath it and the chef cannot see where it is going to land.
function mlAutoScrollTick(){
  if(!mlDrag) return;
  const sc = mlDrag.scroller; if(!sc) return;
  const box = mlScrollerRect(sc);
  const TOP = 96, BOTTOM = 72, MAX = 20;
  const overTop = (box.top + TOP) - mlDragClientY;
  const overBot = mlDragClientY - (box.bottom - BOTTOM);
  let dy = 0;
  if(overTop > 0)      dy = -Math.min(MAX, 3 + Math.round(overTop/5));
  else if(overBot > 0) dy =  Math.min(MAX, 3 + Math.round(overBot/5));
  if(!dy) return;
  const was = mlScrollTop(sc);
  sc.scrollTop = was + dy;                     // mlDragFrame re-slots off the new scrollTop
}

function mlStopDrag(){
  if(mlAutoScrollTimer){ clearInterval(mlAutoScrollTimer); mlAutoScrollTimer = null; }
  if(mlDrag) cancelAnimationFrame(mlDrag.raf);
  document.removeEventListener('pointermove', mlGripMove, { passive:false });
  document.removeEventListener('pointerup', mlGripUp, true);
  document.removeEventListener('pointercancel', mlGripUp, true);
  if(mlDrag){
    try{ if(mlDrag.grip) mlDrag.grip.releasePointerCapture(mlDrag.pid); }catch(_){}
    mlDrag.rowEl.style.transform = '';
    mlDrag.others.forEach(g=>{ g.el.style.transform=''; g.el.classList.remove('ml-shift'); });
    mlDrag.rowEl.classList.remove('ml-dragging');
  }
  document.body.classList.remove('ml-dragging-active');
  const d = mlDrag; mlDrag = null;
  mlDragEndedAt = Date.now();
  return d;
}

function mlGripUp(){
  const d = mlStopDrag(); if(!d) return;
  // The DOM was never reordered during the drag, so the new order comes from
  // the slot it was dropped in, not from reading the rows back.
  const ids = Array.from(d.container.querySelectorAll('.ml-row-tap[data-id]'))
    .map(r=>Number(r.getAttribute('data-id')));
  if(d.from < 0 || d.from >= ids.length || ids[d.from] !== Number(d.id)){
    loadMarketList().then(renderMarketList); return;   // list moved under us — take theirs
  }
  ids.splice(d.to, 0, ids.splice(d.from, 1)[0]);
  mlApplyOrder(d.id, ids);
}

// A keyboard has no drag. Arrow keys on a focused grip nudge one place — enough
// to fix a drop that landed a row out, without becoming the primary gesture.
function mlGripKey(e, id){
  if(e.key!=='ArrowUp' && e.key!=='ArrowDown') return;
  e.preventDefault(); e.stopPropagation();
  if(!mlCanReorder()){ if(typeof kToast==='function') kToast(mlWhyNoReorder()); return; }
  const rowEl = mlRowEl(id); if(!rowEl) return;
  const container = rowEl.closest('.ml-catrows'); if(!container) return;
  const rows = Array.from(container.querySelectorAll('.ml-row-tap[data-id]'));
  const i = rows.indexOf(rowEl);
  const j = e.key==='ArrowUp' ? i-1 : i+1;
  if(i<0 || j<0 || j>=rows.length) return;
  const ids = rows.map(r=>Number(r.getAttribute('data-id')));
  ids.splice(j, 0, ids.splice(i,1)[0]);
  Promise.resolve(mlApplyOrder(id, ids)).then(function(){
    const again = document.querySelector('#ml-content .ml-row-tap[data-id="'+id+'"] .ml-grip');
    if(again) again.focus();
  });
}

// `ids` is one category's rows in their new on-screen order.
async function mlApplyOrder(movedId, ids){
  // THE CHOKE POINT. Both gestures - the drag and the arrow keys - end here, and
  // this is the only place a new order is written to the database. mlCanReorder()
  // already stops both entry points; this is the belt to that pair of braces, so
  // no future caller can reach the write without the code. Reloading puts the row
  // back where the database still says it is, rather than leaving the screen
  // showing a move that was never saved.
  if(!mlEditUnlocked){
    mlMayEditList('Moving a row');
    await loadMarketList(); renderMarketList();
    return;
  }
  const byId = {}; mlItems.forEach(i=>{ byId[i.id]=i; });
  const list = ids.map(id=>byId[id]).filter(Boolean);
  // Somebody else changed the list underneath us — take theirs, not a guess.
  if(list.length !== ids.length){ await loadMarketList(); renderMarketList(); return; }

  const sorted = list.slice().sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));
  if(sorted.every((it,k)=>it.id===list[k].id)) return;          // dropped back where it started

  const k = list.findIndex(i=>i.id===movedId);
  const moved = list[k];
  const lo = k>0 ? (list[k-1].sort_order||0) : 0;
  const hi = k<list.length-1 ? (list[k+1].sort_order||0) : lo + 20;

  let writes = [];
  if(hi - lo >= 2){
    moved.sort_order = Math.floor((lo + hi)/2);                 // one write, whatever the list length
    writes = [moved];
  } else {
    // The gap between the neighbours is used up. Respace the category across
    // the span it ALREADY occupies — never outside it, or the numbers would
    // run into the next category's block.
    const slots = list.map(i=>i.sort_order||0).sort((a,b)=>a-b);
    const step = Math.floor((slots[slots.length-1] - slots[0]) / Math.max(1, list.length-1));
    list.forEach(function(it, i){
      const want = step >= 2 ? (slots[0] + i*step) : slots[i];  // no room to spread → reuse the same numbers
      if(it.sort_order !== want){ it.sort_order = want; writes.push(it); }
    });
  }

  mlItems.sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));
  mlRenderRows(mlVisibleDays());                                // show it moved before the network answers

  mlReorderEchoUntil = Date.now() + 4000;
  const results = [];
  for(let i=0; i<writes.length; i+=5){                          // chunked: never 30 parallel PATCHes
    const chunk = writes.slice(i, i+5);
    results.push(...await Promise.all(chunk.map(p=>
      sb.from('order_items').update({ sort_order: p.sort_order }).eq('id', p.id))));
  }
  if(results.some(r=>r && r.error)){
    mlReorderEchoUntil = 0;
    if(typeof kToast==='function') kToast('Could not save the new order — putting the list back.');
    await loadMarketList(); renderMarketList(); return;
  }
  if(typeof kToast==='function') kToast('✓ ' + moved.name + ' moved — everyone sees the new order');
}

// ── PUT THE WHOLE LIST BACK IN A–Z ────────────────────────────────
// The second half of Antonio’s message, 20 Aug 2026: "il mio suggerimento e’ di
// riordinare ancora una volta la lista". By hand that is 404 drags, and the state
// it produces is exactly the state one stray finger had already undone — so it is
// a button, and it is behind the same admin code as the drag above.
//
// It sorts INSIDE each category and hands the rows back the sort_order numbers
// that category ALREADY occupies. Two things follow, and both matter: one
// category can never walk into the next one’s numbers, and only the rows that
// genuinely move are written — pressed on the live list 20 Aug 2026 it sent 2
// PATCHes, not 404. Which category comes first on screen is ML_CAT_ORDER, and
// this does not touch it.
//
// The comparator is the one the list is ALREADY sorted by — the same
// trim/toLowerCase comparison mlAddCustom has used since 19 Aug to slot a new
// line in. Deliberately NOT localeCompare: its answer changes with the device’s
// language, so two chefs pressing this button would write two different orders
// and each would look wrong to the other.
//
// And it sorts on `it.name` AS SHOWN, which for a coded line is FMC’s name —
// mlApplyFmcFacts overwrites the stored name on every load. That is not a
// detail: the rebuild done straight from the database earlier the same day
// sorted the STORED names, and left the two Langoustine lines crossed over on
// screen — one of them is stored as "langoustine8/11 italy" and shown as
// "Langoustine 8-11 Pcs/kg Whole Drozen". The eye reads the screen, so the
// screen is what has to sort.
function mlByName(a, b){
  const x = String(a.name || '').trim().toLowerCase();
  const y = String(b.name || '').trim().toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

async function mlSortAZ(){
  if(!mlMayEditList('Sorting the list back into A–Z')) return;
  const byCat = {};
  mlItems.forEach(function(it){ (byCat[it.category] = byCat[it.category] || []).push(it); });

  // Nothing is mutated until it has been agreed to — a cancelled confirm must
  // leave the list in memory exactly as the table still has it.
  const plan = [];                                  // [{it, want}]
  Object.keys(byCat).forEach(function(cat){
    const rows  = byCat[cat].slice().sort(function(a,b){ return (a.sort_order||0)-(b.sort_order||0); });
    const slots = rows.map(function(i){ return i.sort_order||0; });   // ascending, and already distinct
    rows.slice().sort(mlByName).forEach(function(it, i){
      if((it.sort_order||0) !== slots[i]) plan.push({ it: it, want: slots[i] });
    });
  });

  if(!plan.length){
    if(typeof kToast === 'function') kToast('The list is already in A–Z order — nothing moved.');
    return;
  }
  // Says how many BEFORE it moves any: the whole complaint was a shared order
  // changing without anybody being told.
  const many = plan.length === 1 ? '1 item' : plan.length + ' items';
  if(!confirm('Put every category back into A–Z order?\n\n' + many + ' of ' + mlItems.length
      + ' move. Categories stay where they are, and nobody’s quantities are touched.\n\n'
      + 'Everyone sees the new order.')) return;

  plan.forEach(function(pl){ pl.it.sort_order = pl.want; });
  mlItems.sort(function(a,b){ return (a.sort_order||0)-(b.sort_order||0); });
  mlRenderRows(mlVisibleDays());                    // show it before the network answers

  const results = [];
  for(let i = 0; i < plan.length; i += 5){          // chunked, exactly as a drag writes
    mlReorderEchoUntil = Date.now() + 4000;         // re-armed per chunk: a long sort must not out-run it
    const chunk = plan.slice(i, i + 5);
    results.push(...await Promise.all(chunk.map(function(pl){
      return sb.from('order_items').update({ sort_order: pl.want }).eq('id', pl.it.id);
    })));
  }
  if(results.some(function(r){ return r && r.error; })){
    mlReorderEchoUntil = 0;
    if(typeof kToast === 'function') kToast('Could not save the new order — putting the list back as it was.', true);
    await loadMarketList(); renderMarketList(); return;
  }
  if(typeof kToast === 'function') kToast('✓ Sorted A–Z — ' + many + ' moved. Everyone sees it.');
}

// Coalesce a burst of order_items events into one reload, and never re-render
// while a row is being held.
function mlScheduleItemsReload(){
  clearTimeout(mlItemsReloadTimer);
  mlItemsReloadTimer = setTimeout(function(){
    if(activeStation !== ORDER_KEY) return;
    if(mlDrag){ mlScheduleItemsReload(); return; }
    loadMarketList().then(function(){
      if(activeStation !== ORDER_KEY) return;
      // Somebody else changed an item while this chef was reading. Redrawing is
      // right; moving them to the top of 415 rows to do it is not.
      mlKeepScrollOnNextRender = true;
      renderMarketList();
    });
  }, 400);
}

function mlRenderRows(days){
  const items = mlFilteredItems();
  const c = document.getElementById('ml-content'); if(!c) return;
  // The rows are about to be replaced, so the menu anchored to one of them
  // must go too — a realtime reload from another screen would otherwise leave
  // it floating over a row that is no longer the row it was opened for.
  mlSupMenuClose();

  const cols = days.length;
  const todayWd = mlWeekdayToday();
  let html = `<div class="ml-table${mlEditUnlocked?' ml-quick':''}" style="--ml-cols:${cols}">`;
  // header
  html += `<div class="ml-row ml-head"><div class="ml-cell-name">Item</div>${days.map(wd=>`<div class="ml-cell-day${wd===todayWd?' today':''}">${ML_DAYS[wd-1]}<span class="ml-cell-day-date">${mlDateForWeekday(wd).split(' ').slice(1).join(' ')}</span></div>`).join('')}</div>`;

  // group items by category, preserving ML_CAT_ORDER
  const present = mlCatsPresent();
  // when searching/ordered-only, only show categories that have matching items;
  // when browsing the full list, show every present category (so its add box is reachable)
  const filtering = !!(mlSearch || mlCatFilter || mlOrderedOnly);
  const canDrag = mlCanReorder();
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
    // Every row of a category lives in its own container: it is the box a drag
    // is allowed to move a row around inside, and nothing else belongs in it —
    // the add box below must not become a drop target.
    html += `<div class="ml-catrows" data-cat="${safe}">`;
    rows.forEach(it=>{
      // The flag is the whole point of the catalogue on this screen: a line
      // pointing at an article our assortment does not carry looks exactly
      // like a healthy one until somebody tries to order it.
      const fl = mlArticleFlag(it);
      const flag = fl ? `<span class="ml-flag ${fl.kind}" title="${mlEsc(fl.why)}">${mlEsc(fl.label)}</span>` : '';
      // The grip is drawn even when the view is filtered, greyed and carrying
      // the reason — a control that silently vanishes teaches nobody why.
      // Antonio's two, drawn only while quick edit is unlocked. stopPropagation
      // on both: the whole row opens the quantity editor, and a ✕ that also
      // opened the popup behind its own confirm box would be worse than no ✕.
      let quick = '';
      if(mlEditUnlocked){
        const sst = mlSupplierState(it);
        // An arrow only where there is a choice to make — more than one supplier
        // FMC will take it from, or a single one that is not the one we store.
        // A line with one agreed supplier has nothing to open.
        if(sst.opts.length > 1 || (sst.opts.length === 1 && !sst.ok)){
          const supNow = sst.chosen ? sst.chosen.supplier : (sst.stored || 'nobody yet');
          const supTitle = sst.ok
            ? 'Ordered from ' + supNow + ' — ' + sst.opts.length + ' suppliers FMC will take it from'
            : 'FMC will not take this from ' + (sst.stored || 'them') + ' any more — pick someone else';
          quick += `<button type="button" class="ml-supbtn${sst.ok?'':' bad'}"
                 title="${mlEsc(supTitle)}"
                 aria-label="Change who ${mlEsc(it.name)} is ordered from"
                 onclick="event.stopPropagation();mlSupMenuOpen(event,${it.id})">▾</button>`;
        }
        quick += `<button type="button" class="ml-x"
               title="Take ${mlEsc(it.name)} off the market list"
               aria-label="Take ${mlEsc(it.name)} off the market list"
               onclick="event.stopPropagation();mlRemoveItem(${it.id})">✕</button>`;
      }
      const grip = `<span class="ml-grip${canDrag?'':' off'}" role="button" tabindex="0"
                 title="${canDrag?'Drag to reorder':mlEsc(mlWhyNoReorder())}"
                 aria-label="Reorder ${mlEsc(it.name)} — drag, or use the arrow keys"
                 onpointerdown="mlGripDown(event,${it.id})"
                 onkeydown="mlGripKey(event,${it.id})"
                 onclick="event.stopPropagation()">⠿</span>`;
      html += `<div class="ml-row ml-row-tap" data-id="${it.id}" onclick="mlOpenEditor(${it.id})">
        <div class="ml-cell-name">${grip}<div class="ml-nametext"><div class="ml-name">${it.name}${flag}</div><div class="ml-unit">${mlUnitFor(it)}</div></div>${quick}</div>
        ${days.map(wd=>{
          const k = it.id+'|'+wd;
          const v = mlQty[k]; const has = v!=null;
          return `<div class="ml-cell-day${wd===todayWd?' today':''}">
            <div class="ml-qty${has?' filled':''}" id="mlq-${k}" data-item="${it.id}" data-wd="${wd}">${has?v:'·'}</div>
          </div>`;
        }).join('')}
      </div>`;
    });
    html += `</div>`;   // close .ml-catrows — the add box is not a drop target
    // per-category add box. Hidden while ordered-only (to keep the chef view
    // clean) and while the list is locked (see mlMayEditList) - adding is the
    // write Antonio asked to put behind the code on 19 Aug 2026.
    if(!mlOrderedOnly && mlEditUnlocked){
      const c1 = cat.replace(/'/g,"\\'");
      html += `<div class="ml-catadd">
        <div class="ml-catadd-combo">
          <input class="check-input ml-catadd-input" id="mladd-${safe}" autocomplete="off"
                 placeholder="${mlArtLoaded?`Add item to ${cat} — type to find an FMC article…`:`Loading the FMC article list…`}"
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
    // "ordered from". Touch targets are 44px so this works on the pass tablet
    // and on a phone, not only under a mouse.
    '.ml-sup{border-top:1px solid #E6DCCB;padding:12px 16px 14px}',
    '.ml-sup-lab{font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:#8a7f70;margin-bottom:6px}',
    '.ml-sup-one{font-size:15px;color:#2b2b2b}',
    '.ml-sup-head{display:flex;align-items:center;gap:10px;width:100%;min-height:44px;',
      'background:none;border:0;padding:0;text-align:left;font:inherit;color:inherit;cursor:pointer}',
    '.ml-sup-cur{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
    '.ml-sup-name{font-size:15px;font-weight:600;color:#2b2b2b;line-height:1.3}',
    '.ml-sup-name.ml-sup-none{font-weight:500;color:#8a7f70}',
    '.ml-sup-meta{font-size:12.5px;color:#6f665b;line-height:1.3}',
    '.ml-sup-price{font-size:16px;font-weight:600;color:#2b2b2b;white-space:nowrap}',
    '.ml-sup-chev{font-size:13px;color:#8a7f70;transition:transform .15s ease}',
    '.ml-sup.open .ml-sup-chev{transform:rotate(180deg)}',
    '.ml-sup-onlyone{font-size:12.5px;color:#6f665b;margin-top:2px}',
    '.ml-sup-list{display:none;margin-top:8px}',
    '.ml-sup.open .ml-sup-list{display:block}',
    '.ml-sup-opt{display:flex;align-items:center;gap:10px;width:100%;min-height:44px;',
      'padding:8px 10px;margin-top:6px;border:1px solid #E6DCCB;border-radius:8px;',
      'background:#fff;text-align:left;font:inherit;cursor:pointer}',
    '.ml-sup-opt:hover{border-color:#C9B79A}',
    '.ml-sup-opt.on{border-color:#410207;background:#F7F1E8}',
    '.ml-sup-tick{width:14px;flex:0 0 14px;color:#410207;font-weight:700}',
    '.ml-sup-optname{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;font-size:14.5px;color:#2b2b2b}',
    '.ml-sup-optprice{font-size:15px;font-weight:600;color:#2b2b2b;white-space:nowrap}',
    '.ml-sup-warn{background:#FDF4E0;color:#6d4700;border-radius:6px;padding:8px 10px;',
      'font-size:12.5px;line-height:1.45;margin-bottom:8px}',
    '@media (prefers-reduced-motion: reduce){.ml-sup-chev{transition:none}}',
    '.ml-ed-repoint{margin-top:7px;background:#fff;border:1px solid #c98d80;color:#8a3226;',
      'border-radius:6px;padding:8px 12px;font:600 12px var(--font-sans,sans-serif);cursor:pointer}',

    // ── drag to reorder ──
    // The grip leads the name cell, which becomes a flex row. `.ml-nametext`
    // needs min-width:0 or the ellipsis on a long article name stops working —
    // a flex child refuses to be clipped below its content width without it.
    '.ml-row-tap .ml-cell-name{display:flex;align-items:center;gap:8px}',
    '.ml-nametext{flex:1;min-width:0}',
    // Fixed height + line-height, never padding: a padding-sized box collapsed
    // to zero content height on laptops once before (memory
    // `pointer-coarse-masks-laptop-defects`), and only on laptops.
    '.ml-grip{flex:0 0 auto;width:26px;height:30px;line-height:30px;text-align:center;',
      'border-radius:6px;background:var(--sabbia-dark,#E8D9C7);color:var(--vino,#400207);',
      'font-size:15px;opacity:.45;cursor:grab;user-select:none;touch-action:none;',
      'transition:opacity .12s,background .12s,color .12s}',
    '.ml-row-tap:hover .ml-grip{opacity:1}',
    '.ml-grip:hover,.ml-grip:focus{background:var(--vino,#400207);color:var(--cream,#FBF6EC);opacity:1;outline:none}',
    '.ml-grip:active{cursor:grabbing;background:var(--vino,#400207);color:var(--cream,#FBF6EC);opacity:1}',
    '.ml-grip.off{opacity:.2;cursor:not-allowed}',
    '.ml-grip.off:hover,.ml-grip.off:focus{background:var(--sabbia-dark,#E8D9C7);color:var(--vino,#400207);opacity:.35}',
    // A finger has no hover, so the grip has to be visible before it is touched.
    '@media(pointer:coarse){.ml-grip{opacity:.8;width:30px;height:34px;line-height:34px}}',
    // The row being carried tracks the pointer 1:1, so it must NOT have a
    // transition; the rows it displaces must, or the gap snaps open.
    '.ml-row.ml-dragging{opacity:.97;background:var(--sabbia-light,#F3EADD);',
      'box-shadow:0 8px 22px rgba(66,2,7,.26);position:relative;z-index:50;',
      'transition:none;will-change:transform}',
    '.ml-row.ml-shift{transition:transform .16s cubic-bezier(.2,.7,.3,1);will-change:transform}',
    '@media (prefers-reduced-motion: reduce){.ml-row.ml-shift{transition:none}}',
    'body.ml-dragging-active{cursor:grabbing;user-select:none}',
    'body.ml-dragging-active .ml-qty{pointer-events:none}',
    '@media print{.ml-grip{display:none}}',

    // ── quick edit: the ✕ and the supplier arrow on the row ──
    // Fixed height + line-height, never padding — the same rule the grip
    // follows, and for the same reason: a padding-sized box collapsed to zero
    // content height on laptops once before, and only on laptops.
    '.ml-x,.ml-supbtn{flex:0 0 auto;width:26px;height:30px;line-height:30px;text-align:center;',
      'border:0;padding:0;border-radius:6px;font:600 14px var(--font-sans,sans-serif);',
      'cursor:pointer;user-select:none;transition:background .12s,color .12s,opacity .12s}',
    '.ml-supbtn{background:var(--sabbia-dark,#E8D9C7);color:var(--vino,#400207);opacity:.6}',
    '.ml-row-tap:hover .ml-supbtn{opacity:1}',
    '.ml-supbtn:hover,.ml-supbtn:focus{background:var(--vino,#400207);color:var(--cream,#FBF6EC);opacity:1;outline:none}',
    // A line FMC will no longer take from the stored supplier is the one case
    // the arrow is not optional, so it stops being quiet.
    '.ml-supbtn.bad{background:#FDECEA;color:#a01c12;opacity:1;box-shadow:inset 0 0 0 1px #F2B8B2}',
    '.ml-supbtn.bad:hover,.ml-supbtn.bad:focus{background:#a01c12;color:#fff}',
    '.ml-x{background:#fff;color:#8a3226;opacity:.55;box-shadow:inset 0 0 0 1px rgba(107,31,42,.28)}',
    '.ml-row-tap:hover .ml-x{opacity:1}',
    '.ml-x:hover,.ml-x:focus{background:#a01c12;color:#fff;opacity:1;outline:none;box-shadow:inset 0 0 0 1px #a01c12}',
    // A finger has no hover, so both have to be visible before they are touched
    // and big enough to hit without catching the row underneath.
    '@media(pointer:coarse){.ml-x,.ml-supbtn{opacity:.85;width:34px;height:34px;line-height:34px;font-size:15px}}',

    // the row's supplier menu — position:fixed, hung off <body>: see mlSupMenuOpen
    '.ml-supmenu{position:fixed;z-index:70;min-width:250px;max-width:min(360px,calc(100vw - 16px));',
      'background:#fff;border:1px solid rgba(64,2,7,.18);border-radius:10px;',
      'box-shadow:0 14px 34px rgba(64,2,7,.22);padding:6px;max-height:60vh;overflow:auto}',
    '.ml-supm-head{font:600 11px var(--font-sans,sans-serif);letter-spacing:.6px;text-transform:uppercase;',
      'color:#7a6f60;padding:7px 9px 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ml-supm-warn{background:#FDF4E0;color:#6d4700;border-radius:6px;padding:7px 9px;',
      'margin:0 3px 5px;font-size:12px;line-height:1.4}',
    '.ml-supm-opt{display:flex;align-items:center;gap:9px;width:100%;min-height:44px;',
      'padding:7px 9px;margin-top:3px;border:1px solid #E6DCCB;border-radius:8px;background:#fff;',
      'text-align:left;font:inherit;cursor:pointer}',
    '.ml-supm-opt:hover,.ml-supm-opt:focus{border-color:#C9B79A;background:#FBF6EC;outline:none}',
    '.ml-supm-opt.on{border-color:#410207;background:#F7F1E8}',
    '.ml-supm-tick{width:13px;flex:0 0 13px;color:#410207;font-weight:700}',
    '.ml-supm-nm{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;font-size:14px;color:#2b2b2b}',
    '.ml-supm-meta{font-size:11.5px;color:#6b6257}',
    '.ml-supm-price{font-size:14px;font-weight:600;color:#2b2b2b;white-space:nowrap}',

    // the toolbar pair. Undo carries the name of what it will undo, so it is
    // clamped rather than allowed to push the rest of the toolbar off a phone.
    '.ml-quickedit.on{background:var(--vino,#400207);color:var(--cream,#FBF6EC);border-color:var(--vino,#400207)}',
    // flex:0 0 auto, and it matters. As flex items these two were shrinkable,
    // and the row squeezed Undo to 88px for an 89px label — one pixel, enough
    // to fire the ellipsis and print "↩ UND…" on the button whose whole job is
    // to say what it will undo. It sizes to its text now, and only the long
    // "Undo the supplier on '…'" label is clamped, which is what the clamp is for.
    '.ml-quickedit,.ml-undo,.ml-sortaz{flex:0 0 auto}',
    '.ml-actions{flex-wrap:wrap}',
    '.ml-undo{max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ml-undo:disabled{opacity:.45;cursor:not-allowed}',
    '@media(max-width:520px){.ml-undo{max-width:150px}}',
    // On a phone the row is ~350px and the two controls take 76px of it out of
    // the name — measured: the name column fell 206px → 122px and the number of
    // truncated names went from 126 of 419 to 258. A chef cannot be asked to
    // take a line off when the app will not show them which line it is, so on a
    // narrow screen the name wraps to two lines instead of being cut. Scoped to
    // .ml-quick: with quick edit locked the row is exactly what it always was.
    '@media(max-width:640px){',
      '.ml-quick .ml-row-tap .ml-cell-name{gap:5px;align-items:center}',
      '.ml-quick .ml-row-tap .ml-name{white-space:normal;display:-webkit-box;',
        '-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.28}',
    '}',
    // the state line. Quiet when locked — it is not an alarm, it is a label —
    // and it takes the brand's own colours when it is on, because "this screen
    // is armed" is worth seeing from across the pass.
    '.ml-qbar{display:flex;align-items:center;gap:10px;margin:0 0 10px;padding:9px 13px;',
      'border:1px solid var(--sabbia-dark,#E8D9C7);border-radius:8px;background:var(--cream,#FBF6EC);',
      'cursor:pointer;font-size:13px;line-height:1.4;color:#5f5344;',
      'transition:border-color .12s,background .12s}',
    '.ml-qbar:hover,.ml-qbar:focus{border-color:#C9B79A;background:#F5EDE0;outline:none}',
    '.ml-qbar b{color:var(--vino,#400207);font-weight:700}',
    '.ml-qbar-ico{flex:0 0 auto;font-size:15px;line-height:1}',
    '.ml-qbar-txt{flex:1;min-width:0}',
    '.ml-qbar-act{flex:0 0 auto;font-weight:700;font-size:12px;letter-spacing:.4px;',
      'text-transform:uppercase;color:var(--vino,#400207);border:1px solid var(--vino,#400207);',
      'border-radius:6px;padding:6px 11px;white-space:nowrap}',
    '.ml-qbar.on{background:var(--vino,#400207);border-color:var(--vino,#400207);color:rgba(251,246,236,.92)}',
    '.ml-qbar.on b{color:var(--cream,#FBF6EC)}',
    '.ml-qbar.on:hover,.ml-qbar.on:focus{background:#520309;border-color:#520309}',
    '.ml-qbar.on .ml-qbar-act{color:var(--vino,#400207);background:var(--cream,#FBF6EC);border-color:var(--cream,#FBF6EC)}',
    // On a phone the sentence needs the width, so the button drops under it
    // rather than squeezing the words into a column.
    '@media(max-width:560px){.ml-qbar{flex-wrap:wrap}.ml-qbar-txt{flex:1 1 100%;order:2}',
      '.ml-qbar-act{order:3;margin-left:auto}.ml-qbar-ico{order:1}}',
    // The lock is a mode switch, not a one-shot action like Print, so it sits
    // first and the gap pushes the report buttons away from it.
    '.ml-actions-gap{flex:1 1 12px;min-width:0}',
    '@media print{.ml-x,.ml-supbtn,.ml-supmenu,.ml-quickedit,.ml-undo,.ml-sortaz,.ml-qbar{display:none}}'
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

// The real calendar date a quantity sits on. week_start is the Monday and
// weekday is 1..6, so the date is Monday + (weekday - 1).
//
// Built from LOCAL parts, never .toISOString() — east of GMT (Dubai UTC+4) that
// converts to UTC and rolls the date back a day, which would move every
// quantity one day earlier and put today's order in the past. The same trap
// mlWeekStartFor already carries a comment about.
function mlRowDate(weekStart, weekday){
  var d = new Date(weekStart + 'T00:00:00');
  d.setDate(d.getDate() + (Number(weekday) - 1));
  var m = d.getMonth() + 1, day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}

// A day the order has NOT gone out on yet: today, or later. Both strings are
// 'YYYY-MM-DD' so the comparison is a plain string compare.
function mlIsStillToCome(r){
  return mlRowDate(r.week_start, r.weekday) >= TODAY;
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

// ══════════════════════════════════════════════════════════════════════════
// QUICK EDIT — the ✕ and the supplier arrow, on the row itself
//
// Antonio asked for both (Tell us, 18 Aug 2026). Taking a line off and changing
// who it comes from are the two things he does over and over, and each one cost
// him a tap into the editor, a scroll to the bottom and a tap back out.
//
// They sit behind a code, in his words, "cosi altre persone non possono
// cambiarlo anche per errore". The same speed that helps him is what makes a
// brushed thumb expensive on a shared pass screen. Locked is the default, and
// while it is locked the rows draw no ✕ and no arrow at all — a control nobody
// on this screen can use is better absent than greyed out on 425 rows. The
// toolbar button is the one thing always on show, so the capability stays
// discoverable to the person who has the code.
//
// The code is an ADMIN code, not any employee ID. mlIdentify() accepts every
// active member of staff, which is right for RECORDING who took a line off and
// wrong for deciding who MAY. Unlocking with an admin code also fills mlWho, so
// the removal that follows does not ask a second time for something it knows.
//
// Nothing about the editor changed. Its "Take off the list" button and its
// "Ordered from" block work exactly as they did, for everybody, locked or not.
// This is a faster lane onto the same two writes, not a gate across the old one.
// ══════════════════════════════════════════════════════════════════════════
var mlEditUnlocked = false;
var mlLockTimer = null;

// ══════════════════════════════════════════════════════════════════════════
// WHO MAY CHANGE THE LIST ITSELF
//
// Antonio, Tell us, 19 Aug 2026: "Togliere la possibilita' ai ragazzi di
// aggiungere elementi sulla market list, perché dovrebbero sempre confrontarsi
// con me e Danilo prima di aggiungere degli items. Perché alcune volte
// aggiungono ingredienti che però sono sbagliati. Quindi si possono fare
// modifiche alla market list, solo con il codice 2468."
//
// So the line between the two jobs this screen does is now drawn in code:
//
//   ORDERING  — typing a quantity against a day. Everybody, always, untouched.
//               It is what the boys are on this screen to do.
//   THE LIST  — adding a line, taking one off, repointing it at another
//               article, changing who it is ordered from, and (20 Aug 2026,
//               Antonio again) MOVING one into a different place. Admin
//               code only.
//
// A wrong ingredient added here is ordered, delivered and invoiced before
// anybody reads it back, which is why the add box is the one that mattered
// most to him. The others are the same kind of write and are gated with it.
//
// ⚠ NOTHING IS REMOVED. Every one of these still works exactly as it did —
// the code opens them, and the same admin codes that already unlocked quick
// edit unlock these (2468 is Supervisor, and was already in ML_ADMIN). This is
// a lock on an existing door, not a door bricked up.
//
// The add box is HIDDEN while locked rather than greyed: the same reasoning
// already written down for the row ✕ a few lines up — a control nobody on this
// screen can use is better absent than disabled under every category heading.
// The bar at the top says why, and how to turn it on, so it stays discoverable.
// ══════════════════════════════════════════════════════════════════════════
function mlMayEditList(what){
  if(mlEditUnlocked) return true;
  var m = 'The market list is locked. ' + (what || 'Changing the list')
        + ' needs the admin code — tap the bar at the top of the screen. '
        + 'Ordering is not affected: you can still type quantities.';
  if(typeof kToast === 'function') kToast(m, true); else alert(m);
  return false;
}
var ML_LOCK_IDLE_MS = 10 * 60 * 1000;   // a pass screen gets walked away from

function mlQuickEditToggle(){
  if(mlEditUnlocked){ mlLock('List locked.'); return; }
  var code = prompt('Unlocking lets you change the MARKET LIST itself - add an item, take '
    + 'one off, change who it is ordered from, move it into a different place.\n\nOrdering '
    + 'is never locked: anybody can type quantities.\n\nEnter the admin code:');
  if(code === null) return;                       // Cancel
  code = String(code).trim();
  if(!ML_ADMIN[code]){
    var m = code ? 'That is not an admin code, so quick edit stays off.'
                 : 'No code entered, so quick edit stays off.';
    if(typeof kToast === 'function') kToast(m, true); else alert(m);
    return;
  }
  mlEditUnlocked = true;
  mlWho = { emp_id:code, name:ML_ADMIN[code] };   // so removing does not ask again
  mlTouchLock();
  mlRenderRows(mlVisibleDays());
  mlRenderQuickBar();
  if(typeof kToast === 'function') kToast('List unlocked for ' + mlWho.name
    + ' - you can add, remove, change suppliers and re-order the list. It locks itself after 10 quiet minutes.');
}

function mlLock(msg){
  mlEditUnlocked = false;
  mlWho = null;                       // identity is not left behind on a shared screen
  clearTimeout(mlLockTimer); mlLockTimer = null;
  mlSupMenuClose();
  if(activeStation === ORDER_KEY){ mlRenderRows(mlVisibleDays()); mlRenderQuickBar(); }
  if(msg && typeof kToast === 'function') kToast(msg);
}

// Every quick edit pushes the lock back; ten quiet minutes lock it again.
function mlTouchLock(){
  clearTimeout(mlLockTimer);
  mlLockTimer = setTimeout(function(){
    mlLock('The list locked itself — nobody had used it for ten minutes.');
  }, ML_LOCK_IDLE_MS);
}

// ── UNDO ──────────────────────────────────────────────────────────────────────────
// "sarebbe anche bello avere un pulsante undo cosi se mi accorgo che ho fatto un
// errore, posso tornare indietro facilmente."
//
// It covers the two writes quick edit makes — taking a line off, and changing
// who it is ordered from — from BOTH lanes, the row and the editor, because a
// mistake does not care which button made it. It does NOT cover the day
// quantities (the editor already shows every day with a "clear" on each one) or
// a drag-reorder (its own grip puts a row straight back). The button NAMES what
// it will undo, so it can never be a mystery tap.
//
// In memory and per session on purpose: an undo that survived a reload would be
// offering to reverse something the person now holding the screen never did.
var mlUndo = [];                       // newest last; { label, fn }
var ML_UNDO_MAX = 20;

// Returns the step it pushed, so a caller can offer to undo THAT act
// specifically rather than whatever happens to be newest by the time the offer
// is taken up.
function mlPushUndo(label, fn){
  var step = { label:label, fn:fn };
  mlUndo.push(step);
  if(mlUndo.length > ML_UNDO_MAX) mlUndo.shift();
  mlRenderQuickBar();
  return step;
}

async function mlUndoLast(){
  return mlUndoStep(mlUndo[mlUndo.length - 1]);
}

// Undo one NAMED step. The toolbar passes the newest; the Undo carried by the
// toast passes its own, because the two can differ — the toast for taking a
// line off is still on screen while a supplier change is made, and "Undo"
// under a sentence about the line must never reverse the supplier instead.
//
// Removed by identity, not by popping: the step being undone is not always the
// top of the stack.
async function mlUndoStep(step){
  if(!step) return;
  var i = mlUndo.indexOf(step);
  if(i === -1) return;     // already undone — an offer that outlived its step
  var btn = document.getElementById('ml-undo');
  if(btn){ btn.disabled = true; btn.textContent = 'Undoing…'; }
  var err = null;
  try { err = await step.fn(); }
  catch(e){ err = (e && e.message) ? e.message : String(e); }
  if(err){
    // The write did not land, so the step STAYS on the stack. Popping it would
    // leave the mistake in place and take away the button that fixes it.
    var m = 'Could not undo it — ' + err + '. Nothing has changed; try again.';
    if(typeof kToast === 'function') kToast(m, true); else alert(m);
    mlRenderQuickBar();
    return;
  }
  mlUndo.splice(i, 1);
  mlRenderRows(mlVisibleDays());
  mlRenderSummary();
  mlRenderQuickBar();
  if(typeof kToast === 'function') kToast('✓ Undone — ' + step.label + ' is back as it was.');
}

// The toolbar is drawn by renderMarketList and the rows by mlRenderRows, and an
// action only redraws the rows — so these two buttons are updated in place. A
// full toolbar re-render would blow away whatever is typed in the search box.
// A LINE THAT SAYS WHY THE ROW HAS NO ✕.
//
// The controls are absent while locked, which is right - 419 greyed buttons on
// a shared pass screen is noise. But absent with nothing said reads as broken,
// and on 18 Aug it did: the list opened, there was no ✕, and the only thing on
// screen that could explain it was a button at the far right of six.
//
// So the state of the surface is stated where the surface is, in one line, and
// the whole line is the control - a 1900px target instead of a 128px one. This
// is the state of his own work, not teaching prose, so it does not fold away.
function mlQuickBarHtml(){
  if(mlEditUnlocked){
    return '<div class="ml-qbar on" role="button" tabindex="0" onclick="mlQuickEditToggle()" '
      + 'onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();mlQuickEditToggle();}" '
      + 'title="Tap to lock quick edit again">'
      + '<span class="ml-qbar-ico">\uD83D\uDD13</span>'
      + '<span class="ml-qbar-txt"><b>The list is unlocked.</b> You can add items, take them '
      + 'off, change who they come from and drag them into a new order. It locks itself '
      + 'after ten quiet minutes.</span>'
      + '<span class="ml-qbar-act">Lock it</span></div>';
  }
  return '<div class="ml-qbar" role="button" tabindex="0" onclick="mlQuickEditToggle()" '
    + 'onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();mlQuickEditToggle();}" '
    + 'title="Tap and enter the admin code to edit from the row">'
    + '<span class="ml-qbar-ico">\uD83D\uDD12</span>'
    + '<span class="ml-qbar-txt"><b>The list is locked</b> - that is why there is no Add box, '
    + 'no cross on a row, and no row can be dragged into a different place. Ordering still '
    + 'works: type quantities as usual. Unlock it to change the list itself.</span>'
    + '<span class="ml-qbar-act">Turn it on</span></div>';
}

function mlRenderQuickBar(){
  var bar = document.getElementById('ml-quickbar');
  if(bar) bar.innerHTML = mlQuickBarHtml();
  var q = document.getElementById('ml-quickedit');
  if(q){
    q.textContent = mlEditUnlocked ? '🔓 List unlocked' : '🔒 Edit list';
    q.classList.toggle('on', mlEditUnlocked);
    q.title = mlEditUnlocked
      ? 'On — ✕ takes a line off the list, ▾ changes who it is ordered from, ⠿ drags it into a new place. Tap to lock it again.'
      : 'Off — tap and enter the admin code to get ✕, ▾ and the drag handle on every row.';
  }
  // Only offered to the person holding the code, and shown/hidden here rather
  // than in renderMarketList: unlocking redraws the rows and this bar, never the
  // toolbar, because a toolbar re-render would blow away whatever is typed in the
  // search box.
  var az = document.getElementById('ml-sortaz');
  if(az) az.style.display = mlEditUnlocked ? '' : 'none';
  var u = document.getElementById('ml-undo');
  if(u){
    var last = mlUndo[mlUndo.length - 1];
    u.disabled = !last;
    u.textContent = last ? '↩ Undo ' + last.label : '↩ Undo';
    u.title = last ? 'Undo ' + last.label
                   : 'Nothing to undo yet — this comes alive after you take a line off or change a supplier.';
  }
}

// ── the row's supplier menu ──────────────────────────────────────────────────────────────────────────
// position:fixed and hung off <body>, never inside the row: .ml-table carries
// overflow:hidden, so a menu positioned inside a row would be clipped off at
// the table's edge and the arrow would look like it had done nothing at all.
var mlSupMenuFor = null;

function mlSupMenuClose(){
  var m = document.getElementById('ml-supmenu'); if(m) m.remove();
  mlSupMenuFor = null;
  document.removeEventListener('pointerdown', mlSupMenuOutside, true);
  window.removeEventListener('scroll', mlSupMenuClose, true);
  window.removeEventListener('resize', mlSupMenuClose);
}
function mlSupMenuOutside(e){
  var m = document.getElementById('ml-supmenu');
  if(m && !m.contains(e.target)) mlSupMenuClose();
}

function mlSupMenuOpen(ev, itemId){
  if(mlSupMenuFor === itemId){ mlSupMenuClose(); return; }   // the same arrow closes it
  mlSupMenuClose();
  var it = (mlItems||[]).find(function(x){ return x.id === itemId; });
  if(!it) return;
  var st = mlSupplierState(it);
  if(!st.opts.length) return;
  var btn = ev && ev.currentTarget;
  var r = (btn && btn.getBoundingClientRect) ? btn.getBoundingClientRect()
                                             : { left:20, right:60, top:60, bottom:90, width:26 };

  var rows = st.opts.map(function(o, i){
    var on = st.chosen && o.supplier === st.chosen.supplier && o.unit === st.chosen.unit;
    return '<button type="button" class="ml-supm-opt' + (on ? ' on' : '') + '"'
      + ' onclick="mlRowPickSupplier(' + it.id + ',' + i + ')">'
      + '<span class="ml-supm-tick">' + (on ? '✓' : '') + '</span>'
      + '<span class="ml-supm-nm">' + mlEsc(o.supplier)
        + '<span class="ml-supm-meta">' + mlEsc(o.unit)
        + (o.priced ? ' · ' + mlPricedLabel(o.priced) : '') + '</span></span>'
      + '<span class="ml-supm-price">' + (o.price != null ? mlUnitPrice(o.price) : '') + '</span></button>';
  }).join('');

  var m = document.createElement('div');
  m.id = 'ml-supmenu';
  m.className = 'ml-supmenu';
  m.innerHTML = '<div class="ml-supm-head">Ordered from — ' + mlEsc(it.name) + '</div>'
    + (st.ok ? '' : '<div class="ml-supm-warn">FMC will not take this from <b>'
        + mlEsc(st.stored) + '</b> any more.</div>')
    + rows;
  document.body.appendChild(m);

  // Placed only after it is in the DOM, so the height being fitted to the
  // window is the real rendered one and not a guess.
  var w = m.offsetWidth, h = m.offsetHeight;
  var left = Math.min(Math.max(8, r.left + r.width - w), window.innerWidth - w - 8);
  var top  = r.bottom + 6;
  if(top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  m.style.left = Math.max(8, left) + 'px';
  m.style.top  = top + 'px';

  mlSupMenuFor = itemId;
  // Registered on the next tick: the pointerdown that OPENED the menu is still
  // travelling, and a listener added now would catch it and shut it again.
  setTimeout(function(){
    document.addEventListener('pointerdown', mlSupMenuOutside, true);
    window.addEventListener('scroll', mlSupMenuClose, true);
    window.addEventListener('resize', mlSupMenuClose);
  }, 0);
}

// The same one-column write as the editor's picker, made from the row.
async function mlRowPickSupplier(itemId, idx){
  var it = (mlItems||[]).find(function(x){ return x.id === itemId; });
  if(!it) return;
  var st = mlSupplierState(it);
  var pick = st.opts[idx];
  if(!pick) return;
  var was = it.supplier || null;
  if(was === pick.supplier){ mlSupMenuClose(); return; }   // nothing written, nothing to undo
  var r = await sb.from('order_items').update({ supplier: pick.supplier }).eq('id', itemId);
  if(r && r.error){
    var m = 'Could not save the supplier — ' + r.error.message;
    if(typeof kToast === 'function') kToast(m, true); else alert(m);
    return;
  }
  it.supplier = pick.supplier;
  mlSupMenuClose();
  mlTouchLock();
  mlPushUndo('the supplier on "' + it.name + '"', function(){ return mlRestoreSupplier(itemId, was); });
  mlRenderRows(mlVisibleDays());
  if(typeof kToast === 'function'){
    kToast(was ? 'Ordering "' + it.name + '" from ' + pick.supplier + ' instead of ' + was + '.'
               : 'Ordering "' + it.name + '" from ' + pick.supplier + '.');
  }
}

// Both undo paths share this. Returns an error STRING, or null when the write
// landed — mlUndoLast keeps the step on the stack whenever this reports a
// failure, so a dropped connection cannot swallow the way back.
async function mlRestoreSupplier(itemId, was){
  var r = await sb.from('order_items').update({ supplier: was }).eq('id', itemId);
  if(r && r.error) return r.error.message;
  var it = (mlItems||[]).find(function(x){ return x.id === itemId; });
  if(it) it.supplier = was;
  return null;
}

// Putting a line back on the list. `active = true` is the whole write, because
// nothing was ever deleted: the quantities, the code, the supplier and the
// line's own place in its category are all still sitting on the row.
async function mlRestoreItem(it){
  mlQuickEditEchoUntil = Date.now() + 3000;      // same reason as mlRemoveItem
  var r = await sb.from('order_items').update({ active:true }).eq('id', it.id);
  if(r && r.error){ mlQuickEditEchoUntil = 0; return r.error.message; }
  if(!(mlItems||[]).some(function(x){ return x.id === it.id; })){
    mlItems.push(it);
    // Re-sorted, not appended: the grid renders mlItems in order, so an
    // appended row would reappear at the bottom of its category rather than
    // where the chef left it.
    mlItems.sort(function(a,b){ return (a.sort_order||0) - (b.sort_order||0); });
  }
  return null;
}

async function mlRemoveItem(itemId){
  if(!mlMayEditList('Taking an item off')) return;
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
  //
  // ── WHERE THE LINE IS DRAWN, AND WHY IT MOVED (18 Aug 2026) ────────────
  // It used to be this week's MONDAY, and that was wrong by its own reasoning.
  // The guard exists to stop a quantity being stranded where nobody can see it
  // and nobody will order it. A quantity on a day that has already gone is not
  // stranded — that order was placed and delivered, and it is history in
  // exactly the way last week is history, which this same function already
  // excludes on purpose.
  //
  // Drawing it at Monday meant yesterday's delivered order blocked the line.
  // Measured on 18 Aug: 46 of the 98 items carrying a quantity from Monday on
  // were refused purely because of Monday, a day already bought and eaten.
  // Antonio hit it and could not take an item off at all.
  //
  // TODAY is the boundary now, and today itself still BLOCKS: the market order
  // for today may not have gone out yet, so a quantity sitting on it is still a
  // live instruction. Only days strictly in the past are treated as history.
  var fromWeek = mlWeekStartFor(0);          // this week's Monday, whatever is on screen
  var all = await mlQuantitiesFrom(itemId, fromWeek);

  // A guard that cannot see is not a guard. supabase-js reports failures on the
  // result rather than throwing, so a dropped connection would otherwise read
  // as "no quantities found" and wave the removal through — the one outcome
  // this must never produce. No answer means refuse.
  if(all === null){
    alert('"' + it.name + '" was not taken off the list.\n\n' +
      'Its quantities could not be checked just now — the connection did not answer. ' +
      'Taking a line off without that check is how quantities get stranded where nobody ' +
      'can see them, so nothing has been changed.\n\nTry again in a moment.');
    return;
  }

  // Only what is still to come can be stranded. What already went is kept and
  // said out loud in the confirm below, never used to refuse.
  var pending = all.filter(mlIsStillToCome);
  var alreadyGone = all.length - pending.length;

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
      'It has ' + pending.length + ' quantit' + (pending.length===1?'y':'ies') +
      ' on it that ' + (pending.length===1?'has':'have') + ' not been ordered yet, ' +
      'across ' + weeks.length + ' week' + (weeks.length===1?'':'s') + ':\n' +
      lines.join('\n') +
      '\n\nSwitching it off now would hide the line while those quantities stayed in the ' +
      'database — they would never be ordered and nobody would see them. Three kilos of ' +
      'heirloom tomatoes were lost that way on 7 August.\n\n' +
      'Either clear those quantities first, or — if this is a duplicate — repoint the line ' +
      'at the right article instead, which keeps everything ever ordered against it.');
    return;
  }
  // ── WHY THERE IS NO "ARE YOU SURE" HERE ANY MORE (18 Aug 2026) ────────
  // Antonio, on the feedback button: "Please don't show this message everytime
  // I try do delete something, important is that I can undo it, no need this
  // message everytime."
  //
  // He is right, and the old confirm proved it in its own last line — it ended
  // "Undo in the toolbar puts the line straight back". A question whose answer
  // is already reversible is not a safeguard, it is a keystroke. The chef
  // taking twenty duplicates off a list read the same five paragraphs twenty
  // times and pressed OK twenty times, which is how people stop reading the
  // dialogs that DO matter.
  //
  // What protects the list is not the asking, it is the two things above this
  // line and the one below it:
  //   • the orphan guard REFUSES a line that still has quantities on it,
  //   • a connection that cannot answer REFUSES rather than waves through,
  //   • and nothing is deleted — `active=false` is reversed by one write.
  // Those all stay. Only the question goes.
  //
  // The safeguard now sits AFTER the act instead of before it, where it costs
  // nothing to the person who meant it: the toast carries Undo itself, so the
  // way back is under the thumb that just pressed ✕ rather than in a toolbar
  // that may be scrolled off a phone — which, after the scroll fix landed the
  // same day, is exactly where the toolbar now stays.
  //
  // A CONFIRM STILL APPEARS IF THERE IS NO WAY BACK. kToast is defined in
  // app.js; market-list.js is also loaded by screens that do not have it. Where
  // the toast cannot be shown the undo cannot be offered, and an unofferable
  // undo must not become a silent delete — so that case, and only that case,
  // still asks first.
  if(typeof kToast !== 'function'){
    if(!confirm('Take "' + it.name + '" off the market list?' +
                '\n\nChecked: nothing is waiting to be ordered on it — not today, and not on ' +
                'any day ahead.' +
                '\n\nNothing is deleted. Everything ever ordered against it is kept, and Undo ' +
                'in the toolbar puts the line straight back.')) return;
  }

  // mlItems is updated and the rows redrawn a few lines below, so our own echo
  // has nothing to tell us. Cleared on failure so a screen that did NOT change
  // still hears about anything else that did.
  mlQuickEditEchoUntil = Date.now() + 3000;
  var res = await sb.from('order_items').update({ active:false }).eq('id', itemId);
  if(res && res.error){
    mlQuickEditEchoUntil = 0;
    var m = 'Could not remove it — ' + res.error.message;
    if(typeof kToast === 'function') kToast(m, true); else alert(m);
    return;
  }
  mlItems = mlItems.filter(function(x){ return x.id !== itemId; });
  mlCloseEditor();
  mlTouchLock();
  // The row OBJECT is kept, not just its id: putting the line back has to
  // restore it to its own place in the category, and sort_order lives on it.
  var step = mlPushUndo('taking "' + it.name + '" off', function(){ return mlRestoreItem(it); });
  mlRenderRows(mlVisibleDays());
  mlRenderSummary();
  if(typeof kToast === 'function'){
    // The one fact the old confirm carried that the act itself does not show:
    // this line HAS been ordered before. It is said here rather than asked
    // beforehand, because it changes nothing about whether taking the line off
    // is safe — those orders went and are kept either way.
    kToast('✓ "' + it.name + '" taken off the list by ' + who.name + '.'
      + (alreadyGone
          ? ' It was ordered ' + alreadyGone + ' time' + (alreadyGone===1?'':'s')
            + ' on days already gone — those orders are kept.'
          : '')
      + ' Nothing is deleted.',
      false,
      { label:'↩ Undo', onClick:function(){ mlUndoStep(step); } });
  }
}

// ── EDIT POPUP: tap an item's name OR any of its cells to open ──
// Shows all 6 days for that item with steppers + a number field per day.
// Local edits buffer in mlEditBuf; "Save" writes every changed day via mlSetQty.
let mlEditItemId = null;
let mlEditBuf = {};   // weekday -> value (string)

function mlOpenEditor(itemId){
  // The whole row opens the quantity editor, so the click a browser fires at
  // the end of a drag would open the editor for the row that was just dropped.
  if(Date.now() - mlDragEndedAt < 400) return;
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
            (fl.kind==='dead' && mlEditUnlocked ? `<br><button type="button" class="ml-ed-repoint" onclick="mlRepointOpen(${it.id})">Point this line at another article…</button><div id="ml-repoint-host"></div>` : '') +
            `</div>`; })()}
      </div>
      <div class="ml-ed-body">${dayRows}</div>
      ${mlSupplierBlock(it)}
      <div class="ml-ed-foot">
        ${mlEditUnlocked ? `<button type="button" class="ml-ed-btn ml-ed-remove" onclick="mlRemoveItem(${it.id})" title="Take this item off the market list">Take off the list</button>` : ''}
        <button type="button" class="ml-ed-btn ml-ed-cancel" onclick="mlCloseEditor()">Cancel</button>
        <button type="button" class="ml-ed-btn ml-ed-save" onclick="mlSaveEditor()">Save</button>
      </div>
    </div>`;
  box.addEventListener('click', mlCloseEditor); // click backdrop closes
  document.body.appendChild(box);
  mlInjectCss();
  setTimeout(()=>{ const f=document.getElementById('ml-ed-q1'); if(f) f.focus(); }, 60);
}

// ── "ordered from" ─────────────────────────────────────────────────────────
// One line when there is nothing to decide, a list when there is. The options
// are folded away by default: the day quantities are the job, this is a thing
// you change occasionally. What never folds is the WARNING - a chef must not
// have to open anything to find out the supplier on the line is one FMC will
// refuse.
function mlSupplierBlock(it){
  const st = mlSupplierState(it);
  if(!st.known){
    if(st.none){
      return `<div class="ml-sup"><div class="ml-sup-lab">Ordered from</div>
        <div class="ml-sup-warn">FMC has no supplier switched on for this item, so it cannot be ordered${st.stored?' — the list still says <b>'+mlEsc(st.stored)+'</b>':''}. It needs a supplier setting up in FMC, or taking off the list.</div></div>`;
    }
    if(!st.stored) return '';
    return `<div class="ml-sup"><div class="ml-sup-lab">Ordered from</div>
      <div class="ml-sup-one">${mlEsc(st.stored)}</div></div>`;
  }
  const only = st.opts.length === 1;
  const cur  = st.chosen || null;
  const head = cur
    ? `<div class="ml-sup-cur"><span class="ml-sup-name">${mlEsc(cur.supplier)}</span>` +
      `<span class="ml-sup-meta">${mlEsc(cur.unit)}${cur.priced?' · '+mlPricedLabel(cur.priced):''}</span></div>` +
      (cur.price!=null?`<div class="ml-sup-price">${mlUnitPrice(cur.price)}</div>`:'')
    : `<div class="ml-sup-cur"><span class="ml-sup-name ml-sup-none">${st.stored?mlEsc(st.stored):'Nobody chosen yet'}</span></div>`;

  const warn = st.ok ? '' :
    `<div class="ml-sup-warn">This list says <b>${mlEsc(st.stored)}</b>, but FMC will not take an order from them any more. Pick someone else.</div>`;

  const rows = st.opts.map(function(o, i){
    const on = cur && o.supplier===cur.supplier && o.unit===cur.unit;
    return `<button type="button" class="ml-sup-opt${on?' on':''}" onclick="mlPickSupplier(${it.id},${i})">
      <span class="ml-sup-tick">${on?'✓':''}</span>
      <span class="ml-sup-optname">${mlEsc(o.supplier)}<span class="ml-sup-meta">${mlEsc(o.unit)}${o.priced?' · '+mlPricedLabel(o.priced):''}</span></span>
      <span class="ml-sup-optprice">${o.price!=null?mlUnitPrice(o.price):''}</span></button>`;
  }).join('');

  // Only one supplier and it is already the stored one: nothing to open.
  if(only && st.ok && cur){
    return `<div class="ml-sup"><div class="ml-sup-lab">Ordered from</div>
      <div class="ml-sup-head">${head}</div>
      <div class="ml-sup-onlyone">only supplier</div></div>`;
  }
  const open = !st.ok;   // a bad choice opens the list without being asked
  return `<div class="ml-sup${open?' open':''}" id="ml-sup-${it.id}">
    <div class="ml-sup-lab">${st.ok?'Ordered from':'Who FMC will take it from'}</div>
    ${warn}
    <button type="button" class="ml-sup-head ml-sup-toggle" onclick="mlSupToggle(${it.id})"
            aria-expanded="${open?'true':'false'}">
      ${head}<span class="ml-sup-chev">▾</span></button>
    <div class="ml-sup-list">${rows}</div></div>`;
}

function mlSupToggle(id){
  const el = document.getElementById('ml-sup-'+id);
  if(!el) return;
  const now = !el.classList.contains('open');
  el.classList.toggle('open', now);
  const b = el.querySelector('.ml-sup-toggle');
  if(b) b.setAttribute('aria-expanded', now?'true':'false');
}

// The choice is ours, so it is stored - on order_items, the same row the rest of
// the line lives on. Written straight away rather than on Save: the day boxes
// have their own buffer and a supplier is not part of it, so folding this into
// Save would make one button mean two different things.
async function mlPickSupplier(itemId, idx){
  if(!mlMayEditList('Changing the supplier')) return;
  const it = (mlItems||[]).find(function(x){ return x.id===itemId; });
  if(!it) return;
  const st = mlSupplierState(it);
  const pick = st.opts[idx];
  if(!pick) return;
  const was = it.supplier;
  const r = await sb.from('order_items').update({ supplier: pick.supplier }).eq('id', itemId);
  if(r.error){
    if(typeof kToast==='function') kToast('Could not save the supplier — check connection.', true);
    return;
  }
  it.supplier = pick.supplier;
  // The editor's picker records an undo step too. A mistake does not care
  // which of the two lanes made it, so both have the same way back.
  mlPushUndo('the supplier on "' + it.name + '"', function(){ return mlRestoreSupplier(itemId, was); });
  const host = document.getElementById('ml-sup-'+itemId);
  if(host){
    const fresh = document.createElement('div');
    fresh.innerHTML = mlSupplierBlock(it);
    const node = fresh.firstElementChild;
    if(node){ node.classList.add('open'); host.replaceWith(node); }
  }
  if(typeof kToast==='function'){
    kToast(was && was!==pick.supplier
      ? 'Ordering from ' + pick.supplier + ' instead of ' + was + '.'
      : 'Ordering from ' + pick.supplier + '.');
  }
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
// ⚠ THE HELPER IS A DOWNLOAD, SO THE BUILD HAS TO BE ON SCREEN IN BOTH PLACES.
//
// Nobody gets a new helper by opening it - it is an exe somebody saved to the
// laptop once. On 19 Aug 2026 Antonio's order stopped at 23:47 on a fault that
// had already been found, and there was no way for him, or for us, to tell
// which build he was running. The date below is the current one; the helper
// prints its own build under its name and on the first line of every run, so
// the two can be compared without asking anybody.
//
// The ?v= is not decoration either: without it the browser is entitled to hand
// back the copy it downloaded in August and call that a fresh download.
var ML_HELPER_BUILD = '2026-08-27e';
var ML_HELPER_EXE = 'downloads/FMC-order-helper.exe?v=' + ML_HELPER_BUILD;

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
    '<div style="margin:-4px 0 10px">The current one is <b>build ' +
      ML_HELPER_BUILD + '</b>. The helper shows its build under its name, top ' +
      'left, and on the first line of every run. If the laptop says an older ' +
      'date, download it again before you order.</div>' +
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
  // Locked on every open. The unlock is held in memory, so walking away from
  // the pass screen and coming back through the menu must not still be armed.
  mlLock();
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
  // Checked before the editor guard: the row menu opens with no editor behind
  // it, so an Escape aimed at it would otherwise fall straight through.
  if(e.key === 'Escape' && document.getElementById('ml-supmenu')){
    e.preventDefault(); mlSupMenuClose(); return;
  }
  if(!document.getElementById('ml-editor')) return;
  if(e.key === 'Escape'){ e.preventDefault(); mlCloseEditor(); }
  else if(e.key === 'Enter'){ e.preventDefault(); mlSaveEditor(); }
});
