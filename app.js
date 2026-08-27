const SUPABASE_URL = 'https://zrpglswalgjbtghudmhu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpycGdsc3dhbGdqYnRnaHVkbWh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5MTIyMjQsImV4cCI6MjA5NjQ4ODIyNH0.pfABN-so4xINK7nHxXUlVeTO4g0h0l6ILHVwpoKrbds';
// ── DEV-site write protection ──
// MOVED OUT, 7 Aug 2026. The guard and the DEV badge now live in dev-guard.js,
// which index.html loads FIRST (before the supabase CDN, before this file).
// It used to be pasted here AND in recipe-create.html; only this copy ever got
// the Edge-Function blocklist, so the Recipes screen still let a real Stock
// Take email out from the dev site. One copy now — add new Edge Functions to
// MUTATING_FUNCTIONS in dev-guard.js and every screen is covered.
//
// `IS_DEV_HOST` and `DEV_READ_ONLY` are globals set there; the references
// throughout this file still read exactly the same. They are deliberately NOT
// re-declared here — a `const` would collide with the window property and
// throw "Identifier has already been declared", killing the page.
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const PASS_KEY = 'pass';
const REPORT_KEY = 'reports';
const CHECK_KEY = 'checks';
const HOME_KEY = 'home';
const DASHBOARD_KEY = 'dashboard';
const REPORTS_KEY = 'reports_module';
const ORDER_KEY = 'order_inventory';
const RECIPES_KEY = 'recipes';
const SCHED_KEY = 'scheduling';
function formatDate(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }

// Service date: before 06:00 still belongs to the previous night's service.
// Team marks statuses at 23:45 -> saved as Tuesday. Morning team at 07:00 -> reads Tuesday. Clean handover.
// Uses DUBAI wall-clock (common.js), not the device clock — a tablet with a
// wrong timezone must not file prep/checklist writes under the wrong night.
function getServiceDate(){
  if (typeof RC !== 'undefined' && RC.dubaiBusinessDate) return RC.dubaiBusinessDate(new Date());
  var d = new Date();
  if(d.getHours() < 6){ d.setDate(d.getDate() - 1); }
  return formatDate(d);
}
function getToday(){ return getServiceDate(); }
const TODAY = getServiceDate();

// Fetch EVERY row of a query in 1000-row pages. PostgREST caps one response at
// 1000 rows and silently truncates past it — the bug class that hid clock-ins.
// Same pattern as stFetchAllPaged in stock-take.js. buildQuery must return a
// fresh filtered+ordered query each call (a stable order keeps pages aligned).
async function kFetchAllPaged(buildQuery, pageSize){
  pageSize = pageSize || 1000;
  var all = [], from = 0, error = null;
  for(;;){
    var res = await buildQuery().range(from, from + pageSize - 1);
    if (res.error) { error = res.error; break; }
    var rows = res.data || [];
    all = all.concat(rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return { data: all, error: error };
}

// Check every 60s: 1) if service date changed (at 06:00), 2) if new app version available
// Proxy secret for the sevenrooms-sync / kitchen-events / survey-assistant
// functions. The kitchen app has no logins, so this ships in page source by
// design - its job is scoping those functions, not authentication. Must match
// the SEVENROOMS_PROXY_SECRET / KITCHEN_PROXY_SECRET function secrets.
const KITCHEN_PROXY_SECRET = '8c8223b1916d98aefb0d95018ac5e8e9fc11de64dec1ffc5';
// APP_VERSION kept for reference only. The old midnight–6am version-check that
// used it was REMOVED: it compared this hardcoded number to the live app.js?v,
// so once index.html's ?v was bumped without also bumping APP_VERSION it saw a
// "newer version" every 60s and reloaded in a LOOP all night — wiping the closing
// report (written 2–4am). Version updates now come solely from the ETag guard in
// index.html, which IS guarded by busy()/__closingActive/__schedEditing and runs
// at any hour. Do NOT re-add a hardcoded-version reload here.
const APP_VERSION = 1786343605;

// True while someone is mid-task, so the timer below never force-refreshes over
// live work: a focused field, editing the schedule, or writing the closing report
// (done late at night — exactly when this timer runs). Mirrors index.html's
// busy() guard — the half of the earlier fix that was never wired into app.js.
function kReloadBusy(){
  var el = document.activeElement;
  if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
  if (window.__closingActive && window.__closingActive()) return true;
  if (window.__schedEditing && window.__schedEditing()) return true;
  return false;
}
setInterval(function(){
  // Service-day rollover at 06:00 (not midnight): reload so TODAY re-derives and
  // the app shows the new night — but never while mid-task, so it can't wipe a
  // closing report still being written past 6am (the report keys off its own date
  // picker, so waiting until they finish is safe).
  if(getServiceDate() !== TODAY && !kReloadBusy()){
    window.location.reload();
  }
}, 60000);
const CHECK_STORAGE_KEY = 'robertos-chef-checks-' + TODAY;

let STATIONS = [];
let state = {};
let chefChecks = [];
let activeCheckStation = null;
let activeStation = PASS_KEY;
let activeFilter = null;
let undoStack = null;
let undoTimer = null;
let realtimeChannel = null;
let structureRefreshTimer = null;
let saving = false;

// â”€â”€ INIT â”€â”€
async function init() {
  setDate();
  await loadPrepList();
  await loadTodayStatus();
  await loadChefChecks();
  if (!DEV_READ_ONLY) subscribeRealtime();
  populateSelects();
  openHome();
  document.getElementById('loading').classList.add('hidden');
  const legacyReportDate=document.getElementById('report-date');
  if(legacyReportDate)legacyReportDate.value = TODAY;
}

// â”€â”€ LOAD PREP LIST FROM SUPABASE â”€â”€
const STATIONS_CACHE_KEY = 'robertos-stations-cache';

function savePrepListCache(stations) {
  try { localStorage.setItem(STATIONS_CACHE_KEY, JSON.stringify(stations)); } catch(e) {}
}
function loadPrepListCache() {
  try { return JSON.parse(localStorage.getItem(STATIONS_CACHE_KEY) || 'null'); } catch(e) { return null; }
}

async function loadPrepList() {
  try {
    // Paged loads: dish_components already runs in the hundreds — the moment it
    // passes 1000 a plain select would silently drop dishes from the prep list.
    const [r1, r2, r3, r4] = await Promise.all([
      kFetchAllPaged(() => sb.from('stations').select('*').eq('active', true).order('sort_order').order('id')),
      kFetchAllPaged(() => sb.from('subsections').select('*').eq('active', true).order('sort_order').order('id')),
      kFetchAllPaged(() => sb.from('dishes').select('*').eq('active', true).order('sort_order').order('id')),
      kFetchAllPaged(() => sb.from('dish_components').select('*').eq('active', true).order('sort_order').order('id'))
    ]);
    // A load that errored is treated as missing (falls into the keep-cache path
    // below) — never build the prep list from a partially fetched table.
    const stationsData   = r1.error ? null : r1.data;
    const subsectionsData = r2.error ? null : r2.data;
    const dishesData     = r3.error ? null : r3.data;
    const componentsData = r4.error ? null : r4.data;

    // If any query came back null/empty, do NOT wipe STATIONS — keep whatever we have
    if (!stationsData || !subsectionsData || !dishesData || !componentsData) {
      console.warn('[loadPrepList] One or more queries returned null — keeping existing STATIONS');
      showPrepError('Could not reach database. Showing last known prep list.');
      const cached = loadPrepListCache();
      if (cached && cached.length > 0 && STATIONS.length === 0) {
        STATIONS = cached;
        console.log('[loadPrepList] Restored ' + STATIONS.length + ' stations from cache');
      }
      return;
    }

    // Build the new structure
    const built = stationsData.map(st => ({
      key: st.key,
      label: st.label,
      subsections: subsectionsData
        .filter(ss => ss.station_key === st.key)
        .map(ss => ({
          key: ss.key,
          label: ss.label,
          dishes: dishesData
            .filter(d => d.station_key === st.key && d.subsection_key === ss.key)
            .map(d => ({
              id: d.id,
              name: d.name,
              extra: false,
              items: componentsData.filter(c => c.dish_id === d.id).map(c => c.name),
              components: componentsData.filter(c => c.dish_id === d.id).map(c => ({id: c.id, name: c.name}))
            }))
        }))
    }));

    // Only commit if we actually got stations — never swap good data for empty
    if (built.length === 0 && STATIONS.length > 0) {
      console.warn('[loadPrepList] Supabase returned 0 stations — keeping existing STATIONS, not overwriting');
      showPrepError('Database returned empty station list. Showing last known prep list.');
      return;
    }

    STATIONS = built;
    savePrepListCache(STATIONS);
    hidePrepError();
  } catch(err) {
    console.error('[loadPrepList] Exception:', err);
    showPrepError('Connection error. Showing last known prep list.');
    const cached = loadPrepListCache();
    if (cached && cached.length > 0 && STATIONS.length === 0) {
      STATIONS = cached;
      console.log('[loadPrepList] Exception fallback: restored ' + STATIONS.length + ' stations from cache');
    }
  }
}

function showPrepError(msg) {
  let el = document.getElementById('prep-load-warning');
  if (!el) {
    el = document.createElement('div');
    el.id = 'prep-load-warning';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#b45309;color:#fff;font-size:13px;text-align:center;padding:6px 12px;z-index:9999;';
    document.body.prepend(el);
  }
  el.textContent = '⚠ ' + msg;
  el.style.display = 'block';
}
function hidePrepError() {
  const el = document.getElementById('prep-load-warning');
  if (el) el.style.display = 'none';
}

// â”€â”€ LOAD TODAY'S STATUS â”€â”€
async function loadTodayStatus() {
  try {
    const todayRes = await kFetchAllPaged(() => sb.from('prep_status').select('*').eq('service_date', TODAY).order('id'));
    const todayRows = todayRes.data;

    if (todayRows && todayRows.length > 0) {
      todayRows.forEach(row => {
        const id = mkId(row.station_key, row.subsection_key, row.dish_name, row.component_name);
        state[id] = row.status;
      });
      return;
    }
    // A FAILED load must not be mistaken for "day not started": the carryover
    // below would upsert yesterday's statuses over today's real ones.
    if (todayRes.error) { console.warn('[loadTodayStatus] load failed — skipping carryover', todayRes.error); return; }

    // Today is empty: carry forward OK, SOS and BU from previous service date so the morning % reflects real readiness
    const prevDate = getPreviousServiceDate();
    console.log('[loadTodayStatus] No rows for ' + TODAY + ' — checking ' + prevDate + ' for carryover');
    const { data: prevRows } = await sb.from('prep_status').select('*').eq('service_date', prevDate);

    if (!prevRows || prevRows.length === 0) return;

    const toCarry = prevRows.filter(r => r.status === 'sos' || r.status === 'bu' || r.status === 'ok');
    if (toCarry.length === 0) return;

    console.log('[loadTodayStatus] Carrying forward ' + toCarry.length + ' items from ' + prevDate);

    const newRows = toCarry.map(r => ({
      service_date: TODAY,
      station_key: r.station_key,
      subsection_key: r.subsection_key,
      dish_name: r.dish_name,
      component_name: r.component_name,
      status: r.status,
      updated_at: new Date().toISOString()
    }));

    const up = await sb.from('prep_status').upsert(newRows, {
      onConflict: 'service_date,station_key,subsection_key,dish_name,component_name'
    });
    if (up.error) {
      // The carry-forward write didn't reach the server. Don't paint items as
      // "carried" — the DB has nothing for today, so other screens would diverge.
      // Leave the board accurate (empty) and let the next load retry.
      console.warn('[loadTodayStatus] carry-forward upsert failed', up.error);
      if (typeof kToast === 'function') kToast('Could not carry forward yesterday — reopen to retry.', true);
      return;
    }

    newRows.forEach(row => {
      state[mkId(row.station_key, row.subsection_key, row.dish_name, row.component_name)] = row.status;
    });

    const urgentCount = toCarry.filter(r => r.status === 'sos' || r.status === 'bu').length;
    const okCount = toCarry.length - urgentCount;
    showCarryoverBanner(toCarry.length, prevDate, okCount, urgentCount);

  } catch(err) {
    console.error('[loadTodayStatus] Error:', err);
  }
}

function getPreviousServiceDate() {
  const d = new Date();
  d.setDate(d.getDate() - (d.getHours() < 6 ? 2 : 1));
  return formatDate(d);
}

function showCarryoverBanner(count, fromDate, okCount, urgentCount) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#410207;color:#e1d3c2;text-align:center;padding:12px 20px;z-index:9998;font-size:13px;font-family:DM Sans,sans-serif;letter-spacing:0.02em;';
  var parts = [];
  if (okCount) parts.push(okCount + ' still OK from yesterday');
  if (urgentCount) parts.push(urgentCount + ' unresolved (SOS + BU) \u2014 work SOS first');
  el.innerHTML = '\ud83d\udccb Carried from ' + fromDate + ': ' + parts.join(' \u00b7 ');
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 7000);
}

// â”€â”€ REALTIME SYNC â”€â”€
function subscribeRealtime() {
  realtimeChannel = sb.channel('prep_status_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'prep_status', filter: `service_date=eq.${TODAY}` },
      payload => {
        const r = payload.new || payload.old;
        if (!r) return;
        const id = mkId(r.station_key, r.subsection_key, r.dish_name, r.component_name);
        const newStatus = payload.eventType === 'DELETE' ? 'none' : r.status;
        if (state[id] !== newStatus) {
          state[id] = newStatus;
          flashSync();
          if (activeStation === PASS_KEY) renderPassView();
          else { renderCounter(); updateRowUI(id, newStatus); applyFilter(); renderTabs(); }
        }
      })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'dishes' }, payload => { console.log('[RT] dishes INSERT', payload); refreshPrepStructureFromRealtime(); })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'dishes' }, payload => { console.log('[RT] dishes UPDATE', payload); refreshPrepStructureFromRealtime(); })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'dishes' }, payload => { console.log('[RT] dishes DELETE', payload); refreshPrepStructureFromRealtime(); })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'dish_components' }, payload => { console.log('[RT] dish_components INSERT', payload); refreshPrepStructureFromRealtime(); })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'dish_components' }, payload => { console.log('[RT] dish_components UPDATE', payload); refreshPrepStructureFromRealtime(); })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'dish_components' }, payload => { console.log('[RT] dish_components DELETE', payload); refreshPrepStructureFromRealtime(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chef_checks', filter: `service_date=eq.${TODAY}` },
      payload => {
        const row = payload.new || payload.old;
        if(!row || !row.check_id)return;
        if(payload.eventType === 'DELETE')chefChecks=chefChecks.filter(c=>c.id!==row.check_id);
        else{
          const incoming=chefCheckFromRow(row);
          const existing=chefChecks.find(c=>c.id===incoming.id);
          if(existing)Object.assign(existing,incoming);
          else chefChecks.unshift(incoming);
        }
        saveChefChecks();
        flashSync();
        renderAfterChefCheckSync();
      })
    .subscribe(status => {
      console.log('[RT] channel status:', status);
      document.getElementById('realtime-dot').classList.toggle('live', status === 'SUBSCRIBED');
    });
}

function refreshPrepStructureFromRealtime(){
  if(structureRefreshTimer)clearTimeout(structureRefreshTimer);
  structureRefreshTimer=setTimeout(async()=>{
    await loadPrepList();
    flashSync();
    renderTabs();
    if(activeStation===PASS_KEY)renderPassView();
    else if(activeStation===CHECK_KEY)renderCheckView();
    else if(activeStation===DASHBOARD_KEY)renderDashboard();
    else if(activeStation===REPORTS_KEY)renderReports();
    else if(activeStation!==HOME_KEY&&activeStation!==ORDER_KEY&&activeStation!==RECIPES_KEY&&activeStation!==SCHED_KEY){renderCounter();renderContent();}
    // Second reload after 1.5s to catch read-replica lag
    setTimeout(async()=>{
      await loadPrepList();
      renderTabs();
      if(activeStation===PASS_KEY)renderPassView();
      else if(activeStation!==HOME_KEY&&activeStation!==ORDER_KEY&&activeStation!==RECIPES_KEY&&activeStation!==SCHED_KEY&&activeStation!==CHECK_KEY&&activeStation!==DASHBOARD_KEY&&activeStation!==REPORTS_KEY){renderCounter();renderContent();}
    },1500);
  },400);
}

function flashSync() {
  const el = document.getElementById('sync-flash');
  el.classList.add('active');
  setTimeout(() => el.classList.remove('active'), 500);
}
// Lightweight non-blocking toast for save failures. supabase-js returns {error}
// instead of throwing, so without an explicit check a failed write looks like a
// success on screen — this is how the user finds out a tap didn't reach the server.
//
// THE THIRD ARGUMENT — an action the toast can carry (18 Aug 2026).
// Antonio: "don't show this message everytime I try do delete something,
// important is that I can undo it". The way out of asking before is answering
// after, so the toast that says what happened is also the thing that reverses
// it. `action` is { label, onClick, ms }, all optional together:
//
//   kToast('✓ "X" taken off the list.', false, { label:'Undo', onClick: fn });
//
// Callers that pass nothing behave exactly as before.
function kToast(msg, isError, action) {
  var t = document.getElementById('k-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'k-toast';
    // CENTRED WITH left/right/margin, NOT left:50% + translateX.
    // The old rule capped the toast at HALF the screen: a fixed box with
    // width:auto shrink-to-fits into the space from its `left` edge to the
    // viewport's right edge, which at left:50% is 195px on a 390px phone.
    // Measured 18 Aug 2026 — "taken off the list by Admin" came out one word
    // per line down a narrow green column. Harmless while a toast was only
    // ever a message; not harmless now the way back from a delete lives in it.
    t.style.cssText = 'position:fixed;left:16px;right:16px;bottom:84px;margin:0 auto;'
      + 'width:fit-content;max-width:calc(100vw - 32px);z-index:99999;'
      + 'padding:12px 18px;border-radius:10px;font:600 14px/1.35 system-ui,-apple-system,sans-serif;'
      + 'color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.32);text-align:center;display:none;'
      + 'align-items:center;justify-content:center;gap:14px';
    document.body.appendChild(t);
  }
  t.style.background = isError ? '#b00020' : '#2e7d32';
  // Rebuilt every time rather than assigning textContent: the node is reused
  // across toasts, and a previous toast's Undo button left sitting on the next
  // message would offer to reverse something else entirely.
  t.textContent = '';
  var say = document.createElement('span');
  say.textContent = msg;
  // Free to take the width it needs, and free to wrap. Without min-width:0 a
  // flex item refuses to shrink below its longest word, which on a phone
  // pushes the button off the end of the toast.
  say.style.cssText = 'flex:1 1 auto;min-width:0';
  t.appendChild(say);

  var live = action && action.label && typeof action.onClick === 'function';
  // 4.5s is enough to read a confirmation and far too short to decide whether
  // you meant it — so a toast carrying an action stays up longer.
  var ms = live ? (action.ms || 12000) : 4500;
  if (live) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    // White on the toast's own green, not a tinted overlay: this is the way
    // back from a delete and it has to read at arm's length on a pass screen.
    // Sized for a thumb — the ✕ that got here is reachable on a phone and so
    // must this be.
    b.style.cssText = 'flex:0 0 auto;background:#fff;color:#1b5e20;border:0;border-radius:8px;'
      + 'padding:9px 16px;min-height:38px;font:700 14px/1 system-ui,-apple-system,sans-serif;'
      + 'cursor:pointer;-webkit-appearance:none';
    b.onclick = function () {
      clearTimeout(window._kToastTimer);
      t.style.display = 'none';
      action.onClick();
    };
    t.appendChild(b);
  }
  // Ragged-right beside the button: centred text against a left-aligned button
  // reads as two things that were not made for each other.
  t.style.textAlign = live ? 'left' : 'center';
  t.style.display = live ? 'flex' : 'block';
  clearTimeout(window._kToastTimer);
  window._kToastTimer = setTimeout(function () { t.style.display = 'none'; }, ms);
}

// â”€â”€ CHEF CHECKLIST STORAGE â”€â”€
function chefCheckFromRow(row){
  return {
    id: row.check_id,
    stationKey: row.station_key,
    subsectionKey: row.subsection_key,
    dish: row.dish_name,
    item: row.component_name,
    status: row.status,
    note: row.note || '',
    createdAt: row.updated_at ? new Date(row.updated_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : ''
  };
}
function chefCheckToRow(check){
  return {
    service_date: TODAY,
    check_id: check.id,
    station_key: check.stationKey,
    subsection_key: check.subsectionKey,
    dish_name: check.dish,
    component_name: check.item,
    status: check.status,
    note: check.note || '',
    updated_at: new Date().toISOString()
  };
}
function saveChefChecks(){
  localStorage.setItem(CHECK_STORAGE_KEY,JSON.stringify(chefChecks));
}
async function loadChefChecks(){
  try{
    const { data, error } = await sb.from('chef_checks').select('*').eq('service_date', TODAY);
    if(error)throw error;
    chefChecks=(data||[]).map(chefCheckFromRow);
    saveChefChecks();
  }catch(e){
    try{chefChecks=JSON.parse(localStorage.getItem(CHECK_STORAGE_KEY)||'[]');}
    catch(err){chefChecks=[];}
  }
}
async function upsertChefCheck(check){
  saveChefChecks();
  if(DEV_READ_ONLY)return;
  // supabase-js resolves with {error} on a DB/RLS failure — it does NOT throw —
  // so the old try/catch never fired and the local cache silently diverged from
  // the server. Check the result explicitly and warn the user instead.
  const res=await sb.from('chef_checks').upsert(chefCheckToRow(check),{onConflict:'service_date,check_id'});
  if(res.error){console.warn('Chef checklist sync failed',res.error);kToast('Checklist not saved — check connection.',true);}
}
async function deleteChefCheck(id){
  chefChecks=chefChecks.filter(c=>c.id!==id);
  saveChefChecks();
  if(DEV_READ_ONLY)return;
  const res=await sb.from('chef_checks').delete().eq('service_date',TODAY).eq('check_id',id);
  if(res.error){console.warn('Chef checklist delete sync failed',res.error);kToast('Checklist change not saved — check connection.',true);}
}
function renderAfterChefCheckSync(){
  renderTabs();
  if(activeStation===CHECK_KEY)renderCheckView();
  else if(activeStation===DASHBOARD_KEY)renderDashboard();
  else if(activeStation===REPORTS_KEY)renderReports();
  else if(activeStation!==HOME_KEY&&activeStation!==ORDER_KEY&&activeStation!==RECIPES_KEY&&activeStation!==SCHED_KEY)renderContent();
}

// â”€â”€ SAVE STATUS TO SUPABASE â”€â”€
async function saveStatus(stKey, ssKey, dishName, component, newStatus, prevStatus) {
  if (DEV_READ_ONLY) return { error: null };
  const row = { service_date: TODAY, station_key: stKey, subsection_key: ssKey, dish_name: dishName, component_name: component, status: newStatus, updated_at: new Date().toISOString() };
  // The upsert is the source of truth — return its result so the caller can
  // detect a silent failure and revert. The log insert is secondary audit data;
  // only write it once the status itself actually saved.
  const up = await sb.from('prep_status').upsert(row, { onConflict: 'service_date,station_key,subsection_key,dish_name,component_name' });
  if (!up.error) {
    await sb.from('prep_status_log').insert({ service_date: TODAY, station_key: stKey, subsection_key: ssKey, dish_name: dishName, component_name: component, status: newStatus, previous_status: prevStatus });
  }
  return up;
}

function mkId(stk, ssk, dn, item) { return `${stk}||${ssk}||${dn}||${item}`; }
function parseId(id) { const [stk,ssk,dn,...rest] = id.split('||'); return {stk,ssk,dn,item:rest.join('||')}; }

// â”€â”€ COUNTS â”€â”€
function allCounts() {
  const c={sos:0,bu:0,ok:0,none:0,total:0};
  STATIONS.forEach(st=>st.subsections.forEach(ss=>ss.dishes.forEach(d=>d.items.forEach(i=>{const s=state[mkId(st.key,ss.key,d.name,i)]||'none';c[s]++;c.total++;}))));
  return c;
}
function stationCounts(st) {
  const c={sos:0,bu:0,ok:0,none:0};
  st.subsections.forEach(ss=>ss.dishes.forEach(d=>d.items.forEach(i=>{c[state[mkId(st.key,ss.key,d.name,i)]||'none']++;})));
  return c;
}
function allCheckCounts(){
  const c={ok:0,review:0,discard:0,none:0,total:0};
  STATIONS.forEach(st=>{
    const sc=checkCounts(st.key);
    c.ok+=sc.ok;c.review+=sc.review;c.discard+=sc.discard;c.none+=sc.none;
  });
  c.total=c.ok+c.review+c.discard+c.none;
  return c;
}
function stationReadiness(st){
  const c=stationCounts(st), total=c.sos+c.bu+c.ok+c.none;
  return total?Math.round(c.ok/total*100):0;
}
function prepRows(){
  const rows=[];
  STATIONS.forEach(st=>st.subsections.forEach(ss=>ss.dishes.forEach(d=>d.items.forEach(item=>{
    const id=mkId(st.key,ss.key,d.name,item);
    rows.push({type:'Prep',date:TODAY,stationKey:st.key,station:st.label,subsection:ss.label,dish:d.name,item,status:state[id]||'none',note:''});
  }))));
  return rows;
}
function checklistRows(){
  return chefChecks.map(c=>({type:'Chef check',date:TODAY,stationKey:c.stationKey,station:stationLabel(c.stationKey),subsection:subsectionLabel(c.stationKey,c.subsectionKey),dish:c.dish,item:c.item,status:c.status,note:c.note||''}));
}
function currentReportRows(){
  return [...prepRows(),...checklistRows()];
}
function criticalRows(){
  const order={sos:0,discard:0,review:1};
  return currentReportRows()
    .filter(r=>['sos','review','discard'].includes(r.status))
    .sort((a,b)=>order[a.status]-order[b.status]);
}

// â”€â”€ TABS â”€â”€
function renderTabs() {
  const tabs=[{key:PASS_KEY,label:'The Pass',pass:true},...STATIONS];
  document.getElementById('section-tabs').innerHTML=tabs.map(t=>{
    if(t.pass){const c=allCounts();const sb=c.sos>0?`<span class="stab-badge tb-sos">${c.sos}</span>`:'';return `<button class="stab pass-tab${activeStation===PASS_KEY?' active':''}" onclick="switchStation('${PASS_KEY}')">${t.label}${sb}</button>`;}
    
    const c=stationCounts(t);
    const sb2=c.sos>0?`<span class="stab-badge tb-sos">${c.sos}</span>`:'';
    const bb=c.bu>0?`<span class="stab-badge tb-bu">${c.bu}</span>`:'';
    return `<button class="stab${activeStation===t.key?' active':''}" onclick="switchStation('${t.key}')">${t.label}${sb2}${bb}</button>`;
  }).join('');
}

// â”€â”€ PASS VIEW â”€â”€
// The status words only ever appeared on the station screens' legend bar, but Prep List
// opens on the Pass view and the Chef Checklist is a page of its own — people go straight
// to both during service and meet SOS / BU / Discard with nothing to read them by.
// <details> so it folds shut by default and costs a tap to open, no JS and no state to keep.
function kLegend(items){
  return `<details class="k-legend"><summary class="k-legend-sum">What do these mean?</summary>`
    + `<div class="k-legend-body">`
    + items.map(i=>`<div class="leg-item"><div class="leg-sq ${i.sq}">${i.code}</div> ${i.text}</div>`).join('')
    + `</div></details>`;
}
const PREP_LEGEND = [
  {sq:'sq-sos',    code:'SOS',  text:'Not enough — prioritise now'},
  {sq:'sq-bu',     code:'BU',   text:'Backup: enough to start, need more'},
  {sq:'sq-ok',     code:'OK',   text:'Good for the full day'},
  {sq:'sq-pending',code:'—',    text:'Pending — nobody has checked it yet'}
];
const CHECK_LEGEND = [
  {sq:'sq-ok',     code:'OK',   text:'Good to serve'},
  {sq:'sq-check',  code:'CHK',  text:'To check — a chef must look at it'},
  {sq:'sq-discard',code:'BIN',  text:'Discard — do not serve it'}
];
function renderPassView() {
  const c=allCounts();
  const pct=(v)=>c.total?Math.round(v/c.total*100):0;
  const stationRows=STATIONS.map(st=>{
    const sc=stationCounts(st);
    const combined=[];
    st.subsections.forEach(ss=>ss.dishes.forEach(d=>d.items.forEach(item=>{
      const s=state[mkId(st.key,ss.key,d.name,item)]||'none';
      if(s==='sos'||s==='bu')combined.push({item,dish:d.name,type:s});
    })));
    const badges=`${sc.sos>0?`<span class="pass-badge pb-sos">${sc.sos} SOS</span>`:''}${sc.bu>0?`<span class="pass-badge pb-bu">${sc.bu} BU</span>`:''}${sc.ok>0?`<span class="pass-badge pb-ok">${sc.ok} OK</span>`:''}${combined.length===0&&sc.none===0?`<span class="pb-all-ok">All clear</span>`:''}`;
    const rows=combined.length>0?combined.map(x=>`<div class="pass-sos-item"><div class="pass-sos-dot dot-${x.type}"></div><span class="pass-sos-text">${x.item}</span><span class="pass-sos-dish">${x.dish}</span></div>`).join(''):`<div class="pass-empty">${sc.none>0?`${sc.none} items pending check`:'All items accounted for'}</div>`;
    return `<div class="pass-station-card"><div class="pass-station-header"><span class="pass-station-name">${st.label}</span><div class="pass-station-badges">${badges}</div></div><div class="pass-station-body"><div class="pass-sos-list">${rows}</div></div></div>`;
  }).join('');
  document.getElementById('pass-view').innerHTML=`
    <div class="pass-hero">
      <div class="pass-hero-card c-sos"><span class="pass-hero-num">${c.sos}</span><span class="pass-hero-label">SOS</span></div>
      <div class="pass-hero-card c-bu"><span class="pass-hero-num">${c.bu}</span><span class="pass-hero-label">Backup</span></div>
      <div class="pass-hero-card c-ok"><span class="pass-hero-num">${c.ok}</span><span class="pass-hero-label">OK</span></div>
      <div class="pass-hero-card c-pending"><span class="pass-hero-num">${c.none}</span><span class="pass-hero-label">Pending</span></div>
    </div>
    <div class="pass-progress-section">
      <div class="pass-progress-label"><span>Overall kitchen readiness</span><span>${c.total>0?Math.round(c.ok/c.total*100):0}% ready</span></div>
      <div class="pass-progress-track"><div class="pass-progress-ok" style="width:${pct(c.ok)}%"></div><div class="pass-progress-bu" style="width:${pct(c.bu)}%"></div><div class="pass-progress-sos" style="width:${pct(c.sos)}%"></div></div>
    </div>
    <div style="height:18px"></div>
    ${kLegend(PREP_LEGEND)}
    <div class="pass-section-title">Station by station</div>
    <div class="pass-station-grid">${stationRows}</div>`;
}

// â”€â”€ CHEF CHECKLIST VIEW â”€â”€
function renderCheckView(){
  if(!activeCheckStation&&STATIONS.length)activeCheckStation=STATIONS[0].key;
  const st=STATIONS.find(s=>s.key===activeCheckStation)||STATIONS[0];
  if(!st){document.getElementById('check-view').innerHTML='';return;}
  const stOptions=STATIONS.map(x=>`<option value="${x.key}"${x.key===st.key?' selected':''}>${x.label}</option>`).join('');
  const total=checkCounts(st.key);
  const body=st.subsections.map(ss=>`
    <div class="subsec-title">${ss.label}<div class="subsec-line"></div></div>
    ${ss.dishes.map(dish=>`
      <div class="check-dish-block">
        <div class="check-dish-label">${dish.name}</div>
        ${dish.items.map(item=>renderCheckItem(st.key,ss.key,dish.name,item)).join('')}
      </div>`).join('')}
  `).join('');
  document.getElementById('check-view').innerHTML=`
    <div class="check-toolbar">
      <div class="check-field"><div class="check-label">Station to inspect</div><select class="check-select" id="check-station" onchange="switchCheckStation(this.value)">${stOptions}</select></div>
      <div class="check-card-meta">${total.ok} OK · ${total.review} To check · ${total.discard} Discard · ${total.none} not checked</div>
      <button class="check-reset" onclick="resetChefChecklist()">Reset checklist</button>
    </div>
    ${kLegend(CHECK_LEGEND)}
    ${body}`;
}
function checkStatusLabel(status){return {ok:'OK',review:'To check',discard:'Discard'}[status]||'To check';}
function stationLabel(key){const st=STATIONS.find(s=>s.key===key);return st?st.label:key;}
function subsectionLabel(stKey,ssKey){const st=STATIONS.find(s=>s.key===stKey);const ss=st&&st.subsections.find(s=>s.key===ssKey);return ss?ss.label:ssKey;}
function checkId(stKey,ssKey,dish,item){return mkId(stKey,ssKey,dish,item);}
function getChefCheck(id){return chefChecks.find(c=>c.id===id);}
function checkCounts(stKey){
  const c={ok:0,review:0,discard:0,none:0};
  const st=STATIONS.find(s=>s.key===stKey);if(!st)return c;
  st.subsections.forEach(ss=>ss.dishes.forEach(d=>d.items.forEach(item=>{
    const chk=getChefCheck(checkId(st.key,ss.key,d.name,item));
    c[chk?chk.status:'none']++;
  })));
  return c;
}
function renderCheckItem(stKey,ssKey,dish,item){
  const id=checkId(stKey,ssKey,dish,item);
  const chk=getChefCheck(id);
  const status=chk?chk.status:'none';
  const esc=id.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  const noteId='note-'+encodeURIComponent(id);
  return `<div class="check-prep-row">
    <div class="check-prep-main">
      <div class="check-prep-name">${item}</div>
      ${chk&&chk.note?`<div class="check-prep-note">${chk.note}</div>`:''}
    </div>
    <div class="check-command-btns">
      <button class="check-command ok${status==='ok'?' active':''}" onclick="setItemCheck('${esc}','ok')">OK</button>
      <button class="check-command review${status==='review'?' active':''}" onclick="setItemCheck('${esc}','review')">To check</button>
      <button class="check-command discard${status==='discard'?' active':''}" onclick="setItemCheck('${esc}','discard')">Discard</button>
      <button class="check-note-btn" onclick="showItemCheckNote('${noteId}')">Note</button>
    </div>
  </div>
  <div class="check-note-panel" id="${noteId}">
    <textarea class="check-note-input" id="${noteId}-input" placeholder="Chef note...">${chk&&chk.note?chk.note:''}</textarea>
    <button class="check-note-save" onclick="saveItemCheckNote('${esc}','${noteId}')">Save</button>
    <button class="check-note-cancel" onclick="hideItemCheckNote('${noteId}')">Cancel</button>
  </div>`;
}
function switchCheckStation(stKey){activeCheckStation=stKey;renderCheckView();}
async function setItemCheck(id,status){
  const existing=getChefCheck(id);
  if(existing&&existing.status===status&&!existing.note)await deleteChefCheck(id);
  else{
    const p=parseId(id);
    const now=new Date();
    const payload={id,stationKey:p.stk,subsectionKey:p.ssk,dish:p.dn,item:p.item,status,note:existing?existing.note:'',createdAt:now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})};
    if(existing)Object.assign(existing,payload);
    else chefChecks.unshift(payload);
    await upsertChefCheck(existing||payload);
  }
  renderAfterChefCheckSync();
}
function showItemCheckNote(noteId){
  const panel=document.getElementById(noteId);
  if(panel)panel.classList.add('visible');
}
function hideItemCheckNote(noteId){
  const panel=document.getElementById(noteId);
  if(panel)panel.classList.remove('visible');
}
async function saveItemCheckNote(id,noteId){
  const p=parseId(id);
  const existing=getChefCheck(id);
  const input=document.getElementById(noteId+'-input');
  const note=input?input.value:'';
  const now=new Date();
  if(existing){existing.note=note.trim();existing.createdAt=now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});}
  else chefChecks.unshift({id,stationKey:p.stk,subsectionKey:p.ssk,dish:p.dn,item:p.item,status:'review',note:note.trim(),createdAt:now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})});
  await upsertChefCheck(getChefCheck(id));
  renderAfterChefCheckSync();
}
async function addChefCheck(){
  const now=new Date();
  const check={id:'manual-'+Date.now(),stationKey:activeCheckStation||STATIONS[0].key,subsectionKey:'manual',dish:'Manual check',item:'Manual check',note:'',status:'review',createdAt:now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})};
  chefChecks.unshift(check);
  await upsertChefCheck(check);
  renderAfterChefCheckSync();
}
async function removeChefCheck(id){
  await deleteChefCheck(id);
  renderAfterChefCheckSync();
}
// ── Tap-your-name identity picker (kitchen) ─────────────────────────────────
// Accountable actions (checklist / station reset, closing report, Send-to-HR,
// stock-take sign-in) used to ask the user to TYPE an Employee ID. Instead, the
// team taps their name from the active kitchen `staff` list; an on-brand keypad
// fallback ("I'm someone else") still accepts a typed Employee ID or a super-
// user passcode (1212). Resolves to the SAME {emp_id,name} shape the old
// resetIdentity() returned, so logging / accountability is unchanged.
//   opts: { superMap, superOnly, codeOnly, title }
const RESET_SUPER = { '1212': 'Admin' };
function kPickPerson(actionLabel, opts){
  opts = opts || {};
  var superMap = opts.superMap || RESET_SUPER;
  return new Promise(function(resolve){
    var done=false, people=[], code='';
    function onKey(e){ if(e.key==='Escape') finish(null); }
    function finish(v){ if(done) return; done=true; var o=document.getElementById('kpk-ovl'); if(o) o.remove(); document.removeEventListener('keydown',onKey); resolve(v); }
    function box(){ return document.getElementById('kpk-box'); }
    function initials(n){ var p=(n||'').trim().split(/\s+/); return (((p[0]||'')[0]||'')+((p[1]||'')[0]||'')).toUpperCase(); }
    var ov=document.createElement('div'); ov.id='kpk-ovl';
    ov.setAttribute('style','position:fixed;inset:0;z-index:100050;background:rgba(65,2,7,.55);display:flex;align-items:flex-start;justify-content:center;padding:22px 14px;overflow:auto;');
    ov.onclick=function(e){ if(e.target===ov) finish(null); };
    ov.innerHTML='<div id="kpk-box" style="background:var(--cream,#f5ede0);border-radius:14px;max-width:520px;width:100%;padding:18px 18px 16px;box-shadow:0 14px 50px rgba(65,2,7,.35);"><div style="color:#9c8a72;font-size:13px;padding:8px;">Loading…</div></div>';
    document.body.appendChild(ov);
    document.addEventListener('keydown',onKey);

    function showNames(filter){
      var b=box(); if(!b) return;
      var q=(filter||'').trim().toLowerCase();
      var useSearch=people.length>8;
      var html=people.filter(function(p){ return !q || (p.name||'').toLowerCase().indexOf(q)!==-1 || (p.designation||'').toLowerCase().indexOf(q)!==-1; })
        .map(function(p){ var idx=people.indexOf(p);
          return '<button class="kpk-name" data-i="'+idx+'" style="display:flex;align-items:center;gap:9px;text-align:left;padding:9px 10px;border:1px solid var(--sabbia-dark,#cfc0ad);border-radius:9px;background:#fff;cursor:pointer;">'
            +'<span style="width:32px;height:32px;border-radius:50%;background:var(--sabbia,#e1d3c2);color:var(--vino,#410207);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;flex:none;">'+escHtml(initials(p.name))+'</span>'
            +'<span style="min-width:0;"><span style="display:block;font-size:14px;font-weight:600;color:var(--ink,#2a1a10);">'+escHtml(p.name||'')+'</span><span style="display:block;font-size:11.5px;color:#8a7a62;">'+escHtml(p.designation||'')+'</span></span></button>';
        }).join('');
      b.innerHTML='<div style="font-family:var(--font-serif,Georgia,serif);color:var(--vino,#410207);font-size:22px;">Who’s doing this?</div>'
        +'<div style="font-size:12.5px;color:#8a7a62;margin:2px 0 12px;">Tap your name to '+escHtml(actionLabel)+'. It’s recorded.</div>'
        +(useSearch?'<input id="kpk-search" placeholder="Search your name…" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--sabbia-dark,#cfc0ad);border-radius:9px;font-size:15px;margin-bottom:12px;font-family:inherit;">':'')
        +'<div id="kpk-list" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px;max-height:44vh;overflow:auto;">'+(html||'<div style="color:#9c8a72;font-size:13px;padding:8px;">No match.</div>')+'</div>'
        +'<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:14px;border-top:1px solid var(--sabbia-dark,#cfc0ad);padding-top:12px;">'
          +'<button id="kpk-other" style="font-size:13px;color:var(--vino,#410207);border:1px solid var(--vino,#410207);background:transparent;border-radius:9px;padding:9px 13px;cursor:pointer;">I’m someone else — use my ID</button>'
          +'<button id="kpk-cancel" style="font-size:13px;color:#8a7a62;border:1px solid var(--sabbia-dark,#cfc0ad);background:#fff;border-radius:9px;padding:9px 13px;cursor:pointer;">Cancel</button></div>';
      var s=document.getElementById('kpk-search'); if(s){ s.value=filter||''; s.oninput=function(){ showNames(s.value); }; setTimeout(function(){ try{s.focus();}catch(e){} },20); }
      var btns=b.querySelectorAll('.kpk-name'); for(var j=0;j<btns.length;j++){ btns[j].onclick=function(){ var pp=people[+this.getAttribute('data-i')]; finish({emp_id: pp.emp_id?String(pp.emp_id):null, name: pp.name}); }; }
      document.getElementById('kpk-other').onclick=function(){ code=''; showKeypad(); };
      document.getElementById('kpk-cancel').onclick=function(){ finish(null); };
    }
    function showKeypad(){
      var b=box(); if(!b) return;
      var cells='';
      for(var i=0;i<6;i++){ var ch=code[i]; var active=(i===code.length);
        cells+='<span style="width:34px;height:42px;border:'+(active?'2px solid var(--vino,#410207)':'1px solid '+(ch?'var(--sabbia-dark,#cfc0ad)':'#e4dccd'))+';border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:20px;color:var(--ink,#2a1a10);">'+(ch||(active?'<span style=\"color:#bbab92\">_</span>':''))+'</span>'; }
      function k(d){ return '<button class="kpk-k" data-d="'+d+'" style="padding:13px 0;font-size:18px;color:var(--ink,#2a1a10);border:1px solid var(--sabbia-dark,#cfc0ad);border-radius:9px;background:#fff;cursor:pointer;">'+d+'</button>'; }
      var pad=''; ['1','2','3','4','5','6','7','8','9'].forEach(function(d){ pad+=k(d); });
      pad+='<button id="kpk-bk" style="padding:13px 0;font-size:20px;color:#8a7a62;border:1px solid var(--sabbia-dark,#cfc0ad);border-radius:9px;background:#fff;cursor:pointer;">⌫</button>';
      pad+=k('0');
      pad+='<button id="kpk-ok" style="padding:13px 0;font-size:18px;color:#fff;background:var(--vino,#410207);border:1px solid var(--vino,#410207);border-radius:9px;cursor:pointer;">✓</button>';
      var ktitle=opts.title||'Enter your employee ID';
      b.innerHTML='<div style="font-family:var(--font-serif,Georgia,serif);color:var(--vino,#410207);font-size:22px;">'+escHtml(ktitle)+'</div>'
        +'<div style="font-size:12.5px;color:#8a7a62;margin:2px 0 12px;">'+(opts.superOnly?'Manager / super-user code, to ':'Your ID or manager code, to ')+escHtml(actionLabel)+'.</div>'
        +'<div style="display:flex;gap:7px;justify-content:center;margin-bottom:12px;">'+cells+'</div>'
        +'<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">'+pad+'</div>'
        +'<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:14px;border-top:1px solid var(--sabbia-dark,#cfc0ad);padding-top:12px;">'
          +(opts.codeOnly?'<span></span>':'<button id="kpk-back" style="font-size:13px;color:var(--vino,#410207);background:none;border:none;cursor:pointer;padding:0;">← Back to names</button>')
          +'<button id="kpk-cancel2" style="font-size:13px;color:#8a7a62;border:1px solid var(--sabbia-dark,#cfc0ad);background:#fff;border-radius:9px;padding:9px 13px;cursor:pointer;">Cancel</button></div>';
      var ks=b.querySelectorAll('.kpk-k'); for(var j=0;j<ks.length;j++){ ks[j].onclick=function(){ if(code.length<6){ code+=this.getAttribute('data-d'); showKeypad(); } }; }
      document.getElementById('kpk-bk').onclick=function(){ code=code.slice(0,-1); showKeypad(); };
      document.getElementById('kpk-ok').onclick=submitCode;
      var bk2=document.getElementById('kpk-back'); if(bk2) bk2.onclick=function(){ showNames(''); };
      document.getElementById('kpk-cancel2').onclick=function(){ finish(null); };
    }
    function submitCode(){
      var id=(code||'').trim(); if(!id) return;
      if(superMap[id]){ finish({emp_id:id,name:superMap[id]}); return; }
      if(opts.superOnly){ alert('That isn’t a manager / super-user code.'); code=''; showKeypad(); return; }
      sb.from('staff').select('name,emp_id').eq('emp_id',id).eq('active',true).limit(1).then(function(r){
        var s=r.data&&r.data[0]; if(s) finish({emp_id:id,name:s.name}); else { alert('ID "'+id+'" was not found. Try again or tap Cancel.'); code=''; showKeypad(); }
      });
    }
    if(opts.codeOnly){ showKeypad(); return; }   // skip names, go straight to the keypad
    sb.from('staff').select('id,name,emp_id,designation,station_key,sort_order').eq('active',true).order('sort_order').then(function(res){
      people=(res&&res.error)?[]:((res&&res.data)||[]);
      people.sort(function(a,b){ return ((a.sort_order==null?9999:a.sort_order)-(b.sort_order==null?9999:b.sort_order))||(a.name||'').localeCompare(b.name||''); });
      showNames('');
    });
  });
}
async function resetIdentity(actionLabel, opts){
  if(typeof kPickPerson==='function') return await kPickPerson(actionLabel, opts);
  // Fallback: typed Employee ID (kept in case app.js's picker fails to load).
  var id = (prompt('Enter your Employee ID to '+actionLabel+'.\n\nThis is recorded.')||'').trim();
  if(!id) return null;
  if(RESET_SUPER[id]) return { emp_id:id, name:RESET_SUPER[id] };
  var res = await sb.from('staff').select('name,emp_id').eq('emp_id', id).eq('active', true).limit(1);
  var s = res.data && res.data[0];
  if(!s){ alert('Employee ID "'+id+'" was not found in the staff list.\nReset cancelled.'); return null; }
  return { emp_id:id, name:s.name };
}
// Best-effort audit — if the reset_log table isn't created yet the insert just
// fails silently; the ID gate above is the real protection either way.
async function logReset(who, action, scope, count){
  try{ await sb.from('reset_log').insert({ app:'kitchen', action:action, scope:scope||null, item_count:(count==null?null:count), emp_id:who.emp_id, emp_name:who.name }); }
  catch(e){ console.warn('[logReset] not recorded', e); }
}

async function resetChefChecklist(){
  var who = await resetIdentity('reset all chef checklist checks for today');
  if(!who) return;
  chefChecks=[];
  saveChefChecks();
  if(!DEV_READ_ONLY){
    try{await sb.from('chef_checks').delete().eq('service_date',TODAY);}
    catch(e){console.warn('Chef checklist reset sync failed',e);}
  }
  logReset(who, 'chef_checklist_reset', TODAY, null);
  renderAfterChefCheckSync();
}
function renderStationChecks(stKey){
  const checks=chefChecks.filter(c=>c.stationKey===stKey&&c.status!=='ok');
  if(!checks.length)return '';
  return `<div class="station-checks">
    <div class="station-checks-head">Chef checklist — needs attention</div>
    <div class="station-checks-body">
      ${checks.map(c=>`<div class="station-check-item">
        <span class="check-badge ${c.status}">${checkStatusLabel(c.status)}</span>
        <div class="check-card-main">
          <div class="check-card-title">${c.item}</div>
          <div class="check-card-meta">${subsectionLabel(c.stationKey,c.subsectionKey)} · ${c.dish||'Mise en place'} · ${c.createdAt}</div>
          ${c.note?`<div class="check-card-note">${c.note}</div>`:''}
        </div>
      </div>`).join('')}
    </div>
  </div>`;
}

// â”€â”€ DASHBOARD â”€â”€
function statusLabel(s){return {none:'Pending',sos:'SOS',bu:'Backup',ok:'OK',review:'To check',discard:'Discard'}[s]||s;}
let dashCovers = {};
// Which day the flow grid is showing. null = tonight. The team asked to be able
// to click any day in the "Upcoming covers" strip and see that day's flow grid.
let flowDate = null;
// Future days don't change second-to-second, so cache them (5 min) — the
// dashboard repaints on every realtime prep update and would otherwise hit the
// edge function on each repaint. Today is always fetched live.
let flowCache = {};

async function loadCovers() {
  // Only the next ~3 weeks are ever shown. An unbounded .gte(TODAY) keeps every
  // future row forever and would eventually hit the 1000-row default cap (and
  // truncate the wrong end). Window it and cap it.
  var coversTo = formatDate(addDays(new Date(TODAY + 'T12:00:00'), 21));
  const { data } = await sb.from('covers').select('*').gte('service_date', TODAY).lte('service_date', coversTo).order('service_date').limit(60);
  dashCovers = {};
  if (data) data.forEach(function(r){ dashCovers[r.service_date] = r; });
}

async function renderDashboard(){
  await loadCovers();
  const prep=allCounts();
  const checks=allCheckCounts();
  const ready=prep.total?Math.round(prep.ok/prep.total*100):0;
  const critical=criticalRows();

  // Tonight's covers
  const tonight = dashCovers[TODAY];
  const nightCovers = tonight ? tonight.night_covers : null;
  // A sync stamp that carries its DAY, not just a time of day. "updated 23:26" read as
  // "a few minutes ago" at 10am on 20 Aug when it was in fact last night's sync.
  const coversUpdated = tonight ? (function(){
    const d = new Date(tonight.updated_at);
    const t = d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
    return formatDate(d) === TODAY ? t : d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}) + ' ' + t;
  })() : null;

  // Live "still expected" breakdown straight from SevenRooms (read-only)
  const flowFor = flowDate || TODAY;
  const srLive = await Promise.all([fetchUpcomingTonight(), fetchCoverFlow(flowFor)]);
  const liveTonight = srLive[0];
  const coverFlow = srLive[1];

  // Next 6 days covers
  const upcomingDays = [];
  for (var di = 0; di < 7; di++) {
    var d = new Date(); d.setDate(d.getDate() + di);
    var ds = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    var row = dashCovers[ds];
    if (row) upcomingDays.push({
      date: ds,
      label: di === 0 ? 'Tonight' : d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}),
      night: row.night_covers,
      day: row.day_covers
    });
  }

  const stationMeters=STATIONS.map(st=>{
    const c=stationCounts(st), total=c.sos+c.bu+c.ok+c.none||1;
    return `<div class="station-meter">
      <div class="station-meter-name">${st.label}</div>
      <div class="meter-track">
        <div class="meter-ok" style="width:${Math.round(c.ok/total*100)}%"></div>
        <div class="meter-bu" style="width:${Math.round(c.bu/total*100)}%"></div>
        <div class="meter-sos" style="width:${Math.round(c.sos/total*100)}%"></div>
      </div>
      <div class="meter-pct">${stationReadiness(st)}%</div>
    </div>`;
  }).join('');

  const criticalList=critical.length?critical.slice(0,18).map(r=>`
    <div class="critical-item">
      <span class="check-badge ${r.status==='sos'?'discard':r.status==='bu'?'review':r.status}">${statusLabel(r.status)}</span>
      <div>
        <div class="critical-text">${r.item}</div>
        <div class="critical-meta">${r.type} · ${r.station} · ${r.dish}</div>
        ${r.note?`<div class="check-card-note">${r.note}</div>`:''}
      </div>
    </div>`).join(''):`<div class="report-no-data">No critical items at the moment</div>`;

  const coversRow = upcomingDays.map(function(d){
    // Every tile opens that day's flow grid below (team request 22 Jul).
    var sel = d.date === flowFor ? ' is-flow-day' : '';
    var open = ' data-flow-date="' + d.date + '" onclick="selectFlowDate(\'' + d.date + '\')"' +
               ' title="Show ' + (d.label === 'Tonight' ? "tonight's" : d.label + "'s") + ' flow grid"';
    // Tonight is already the big card on top — repurpose its strip tile to show
    // the live "still expected" number instead of repeating tonight's total.
    if (d.label === 'Tonight') {
      var stillNum = (liveTonight && liveTonight.upcoming != null) ? liveTonight.upcoming : '—';
      return '<div class="dash-cover-day dash-cover-today' + sel + '"' + open + '>' +
        '<div class="dash-cover-label">Tonight</div>' +
        '<div class="dash-cover-num">' + stillNum + '</div>' +
        '<div class="dash-cover-sub">upcoming</div>' +
      '</div>';
    }
    return '<div class="dash-cover-day' + sel + '"' + open + '>' +
      '<div class="dash-cover-label">' + d.label + '</div>' +
      '<div class="dash-cover-num">' + d.night + '</div>' +
      '<div class="dash-cover-sub">night</div>' +
    '</div>';
  }).join('');

  // "booked", not just "covers": the Closing Report shows covers SERVED (COMPLETE
  // bookings only), so 88 here against 0 there is normal before service ends. Both
  // numbers are right — only the labels were missing, and a careful reader already
  // read the pair as a bug. The figures below are untouched.
  // LIVE WINS. Both figures are already in hand on this render — liveTonight came back from
  // SevenRooms a few lines above, and nightCovers is whatever the last laptop sync wrote to the
  // `covers` table. Preferring the cached row meant that on 20 Aug this tile read 52 while the
  // flow footer on the SAME screen read 56, then 58 half an hour later. This is the number the
  // pass preps to, so it must be the freshest one we have, and the fallback must say plainly
  // that it is a stored figure rather than wear a "SevenRooms" caption that implies live.
  const liveBooked = (liveTonight && liveTonight.booked != null) ? liveTonight.booked : null;
  const coversCard = liveBooked !== null
    ? `<div class="ops-card dark dash-covers-card">
        <div class="ops-num">${liveBooked}</div>
        <div class="ops-label">Tonight's covers booked</div>
        <div class="dash-covers-sync">Live from SevenRooms</div>
       </div>`
    : nightCovers !== null
    ? `<div class="ops-card dark dash-covers-card">
        <div class="ops-num">${nightCovers}</div>
        <div class="ops-label">Tonight's covers booked</div>
        <div class="dash-covers-sync">${coversUpdated ? 'Last synced ' + coversUpdated + ' — not live' : 'Stored figure — not live'}</div>
       </div>`
    : `<div class="ops-card dash-covers-card dash-no-covers">
        <div class="ops-num">—</div>
        <div class="ops-label">Tonight's covers booked</div>
        <div class="dash-covers-sync">Not synced — use laptop to sync</div>
       </div>`;

  document.getElementById('dashboard-view').innerHTML=`
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:4px">
      <div>
        <div class="ops-title" style="margin-bottom:2px">Dashboard</div>
        <div class="ops-subtitle">${TODAY} · Live kitchen overview</div>
      </div>
      <button id="sr-sync-btn" class="sr-sync-btn" onclick="syncSevenRoomsCovers()">↻ Sync SevenRooms</button>
    </div>
    <div class="ops-grid">
      ${coversCard}
      <div class="ops-card dark"><div class="ops-num">${ready}%</div><div class="ops-label">Prep readiness</div></div>
      <div class="ops-card"><div class="ops-num">${prep.sos}</div><div class="ops-label">SOS items</div></div>
      <div class="ops-card"><div class="ops-num">${checks.review + checks.discard}</div><div class="ops-label">Chef attention</div></div>
    </div>
    ${upcomingDays.length > 1 ? `
    <div class="ops-panel" style="margin-bottom:16px">
      <div class="ops-panel-head">Upcoming covers booked <span style="font-size:10px;opacity:.6;font-weight:400;margin-left:8px">from SevenRooms · tap a day to see its flow</span></div>
      <div class="dash-covers-row">${coversRow}</div>
    </div>` : ''}
    <div class="dash-live-row">
      <div id="flow-panel-wrap" class="dash-live-flow">${flowPanelHtml(coverFlow, flowFor)}</div>
      <div id="floorplan-panel-wrap" class="dash-live-map">${floorplanPanelHtml(null, flowFor)}</div>
    </div>
    <div class="ops-two">
      <div class="ops-panel">
        <div class="ops-panel-head">Station readiness</div>
        <div class="ops-panel-body">${stationMeters}</div>
      </div>
      <div class="ops-panel">
        <div class="ops-panel-head">Needs attention</div>
        <div class="ops-panel-body"><div class="critical-list">${criticalList}</div></div>
      </div>
    </div>`;

  // The map paints after the shell so the rest of the dashboard isn't held up
  // waiting on SevenRooms.
  paintFloorplan(flowFor);
  startFloorplanTimer();
}

// Fetch live "still expected tonight" breakdown straight from SevenRooms
// (booked / here / upcoming). Read-only, does not write to the covers table.
async function fetchUpcomingTonight() {
  try {
    var res = await fetch(SUPABASE_URL + '/functions/v1/sevenrooms-sync?upcoming=' + TODAY, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'x-proxy-secret': KITCHEN_PROXY_SECRET
      }
    });
    var data = await res.json();
    if (!res.ok || !data.ok) return null;
    return { booked: data.booked, here: data.here, upcoming: data.upcoming };
  } catch (err) {
    console.error('Upcoming fetch error:', err);
    return null;
  }
}

// ── Flow grid: one day at a time, any day in the strip ──
function flowDayLabel(ds){
  if (ds === TODAY) return 'Tonight';
  return new Date(ds + 'T12:00:00').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'});
}

function flowPanelHead(ds){
  var title = ds === TODAY ? "Tonight's flow" : flowDayLabel(ds) + ' — flow';
  return '<div class="ops-panel-head">' + title +
    '<span style="font-size:10px;opacity:.6;font-weight:400;margin-left:8px">from SevenRooms · party sizes per time slot</span></div>';
}

// Build the flow panel for one date. Returns '' only for tonight-with-no-data
// (the panel simply never appears, as before). If a chef deliberately picked a
// day, always show the panel so the tap isn't silently ignored.
function flowPanelHtml(flow, ds){
  if (!flow) {
    if (ds === TODAY) return '';
    return '<div class="ops-panel" style="margin-bottom:16px">' + flowPanelHead(ds) +
      '<div class="flow-empty">No bookings in SevenRooms for ' + flowDayLabel(ds) + ' yet</div></div>';
  }
  var t = flow.totals || {};
  var live = ds === TODAY;
  return '<div class="ops-panel" style="margin-bottom:16px">' + flowPanelHead(ds) +
    '<div class="flow-grid">' + flow.slots.map(function(s){
      return '<div class="flow-col">' +
        '<div class="flow-time">' + s.t + '</div>' +
        '<div class="flow-covers">' + s.covers + '</div>' +
        s.parties.map(function(p){ return '<div class="flow-party ' + p.state + '">' + p.size + '</div>'; }).join('') +
        '<div class="flow-count">' + s.parties.length + '</div>' +
      '</div>';
    }).join('') + '</div>' +
    '<div class="flow-totals">' +
      '<span><strong>' + t.booked + '</strong> booked</span>' +
      '<span class="ft-upcoming"><strong>' + t.upcoming + '</strong> upcoming</span>' +
      // Future days have nobody seated or finished — don't print two zeros.
      (live || t.seated ? '<span class="ft-seated"><strong>' + t.seated + '</strong> seated</span>' : '') +
      (live || t.completed ? '<span class="ft-completed"><strong>' + t.completed + '</strong> completed</span>' : '') +
    '</div>' +
  '</div>';
}

// Clicking a day in the "Upcoming covers" strip swaps the flow grid below it.
// Only the flow panel is repainted — no full dashboard reload, so the rest of
// the screen doesn't flicker mid-service.
async function selectFlowDate(ds){
  flowDate = ds;
  Array.prototype.forEach.call(document.querySelectorAll('.dash-cover-day'), function(el){
    el.classList.toggle('is-flow-day', el.getAttribute('data-flow-date') === ds);
  });
  var wrap = document.getElementById('flow-panel-wrap');
  if (wrap) wrap.innerHTML = '<div class="ops-panel" style="margin-bottom:16px">' + flowPanelHead(ds) +
    '<div class="flow-empty">Loading ' + flowDayLabel(ds) + '’s flow…</div></div>';
  var fw = document.getElementById('floorplan-panel-wrap');
  if (fw && floorplanSupported) fw.innerHTML = floorplanPanelHtml(null, ds);
  paintFloorplan(ds);                        // the map follows the chosen day
  var flow = await fetchCoverFlow(ds);
  if (flowDate !== ds) return;               // a later tap already won
  var w = document.getElementById('flow-panel-wrap');
  if (w) w.innerHTML = flowPanelHtml(flow, ds);
}

// ── Live floorplan: who is sat where ──
// The map geometry lives in floorplan.js. This fetches the live feed, paints
// it, and refreshes once a minute while the dashboard is open on today.
let floorplanTimer = null;
let floorplanSupported = true;   // flipped off if the edge function is older

async function fetchFloorplan(date){
  var d = date || TODAY;
  if (!floorplanSupported) return null;
  try {
    var res = await fetch(SUPABASE_URL + '/functions/v1/sevenrooms-sync?floorplan=' + d, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'x-proxy-secret': KITCHEN_PROXY_SECRET
      }
    });
    var data = await res.json();
    // GUARD: an edge function that predates floorplan mode ignores the unknown
    // param and falls through to the NORMAL sync, which WRITES the covers table.
    // If we don't see a floorplan payload, assume that's what happened, switch
    // the panel off for good and stop the timer — never poll a write every minute.
    if (!res.ok || !data.ok || !Array.isArray(data.reservations)) {
      floorplanSupported = false;
      if (floorplanTimer) { clearInterval(floorplanTimer); floorplanTimer = null; }
      return null;
    }
    return data;
  } catch (err) {
    console.error('Floorplan fetch error:', err);
    return null;
  }
}

function floorplanPanelHtml(fp, ds){
  if (!floorplanSupported) return '';
  var title = ds === TODAY ? 'Live floorplan' : flowDayLabel(ds) + ' — floorplan';
  var head = '<div class="ops-panel-head">' + title +
    '<span style="font-size:10px;opacity:.6;font-weight:400;margin-left:8px">from SevenRooms · tap a table for the name</span>' +
    '<button id="fp-size-btn" class="fp-size-btn" onclick="toggleFloorplanSize()">' +
      (floorplanFull ? 'Shrink map' : 'Make map bigger') + '</button></div>';
  if (!fp) return '<div class="ops-panel fp-panel">' + head + '<div class="flow-empty">Loading the floorplan…</div></div>';
  var built = fpSvg(fp.reservations);
  var stamp = new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  return '<div class="ops-panel fp-panel">' + head +
    '<div class="fp-wrap">' + built.svg + '</div>' +
    '<div class="fp-legend">' +
      '<span><i class="fp-key fp-key-seated"></i>Seated</span>' +
      '<span><i class="fp-key fp-key-upcoming"></i>Booked, not in yet</span>' +
      '<span><i class="fp-key fp-key-completed"></i>Finished</span>' +
      '<span class="fp-stamp">' + fp.seated_tables + ' tables · ' + fp.seated_pax + ' guests seated · updated ' + stamp + '</span>' +
    '</div>' +
    // Never lose a party quietly: anything the feed placed on a table this map
    // doesn't know, or with no table at all, is called out here.
    (built.unmapped.length ? '<div class="fp-warn">Not on the map: ' +
      built.unmapped.map(function(u){ return 'table ' + fpEsc(u.table) + ' (' + fpEsc(fpShortName(u.name)) + ')'; }).join(', ') +
      '</div>' : '') +
    (fp.unassigned ? '<div class="fp-warn">' + fp.unassigned + ' booking' + (fp.unassigned>1?'s':'') + ' with no table assigned yet</div>' : '') +
  '</div>';
}

// Squeezed into half a dashboard row the table numbers get small. One tap gives
// the map the full width and back again; the choice survives the minute refresh.
let floorplanFull = false;
function applyFloorplanSize(){
  var row = document.querySelector('.dash-live-row');
  if (row) row.classList.toggle('fp-full', floorplanFull);
}
function toggleFloorplanSize(){
  floorplanFull = !floorplanFull;
  applyFloorplanSize();
  var b = document.getElementById('fp-size-btn');
  if (b) b.textContent = floorplanFull ? 'Shrink map' : 'Make map bigger';
}

async function paintFloorplan(ds){
  var fp = await fetchFloorplan(ds);
  if ((flowDate || TODAY) !== ds) return;            // day changed under us
  var w = document.getElementById('floorplan-panel-wrap');
  if (w) w.innerHTML = floorplanPanelHtml(fp, ds);
  applyFloorplanSize();
}

// Refresh once a minute — enough for "who's seated", and a quarter of the
// edge-function calls a 15-second poll would burn. Only ticks while the
// dashboard is the open view and the map is showing today.
function startFloorplanTimer(){
  if (floorplanTimer) clearInterval(floorplanTimer);
  if (!floorplanSupported) return;
  floorplanTimer = setInterval(function(){
    if (activeStation !== DASHBOARD_KEY) return;
    if ((flowDate || TODAY) !== TODAY) return;
    if (document.hidden) return;                     // don't poll a sleeping screen
    paintFloorplan(TODAY);
  }, 60000);
}

// Fetch the SevenRooms "Cover Flow" for one date: covers per 15-min slot with
// every party's size and live state (upcoming / seated / completed). The edge
// function strips all guest data server-side, so this is safe on the wall
// screen. Read-only; returns null on any failure so the panel simply hides.
async function fetchCoverFlow(date) {
  var d = date || TODAY;
  // Tonight must stay live (parties move to seated/completed during service).
  // Other days are cached for 5 minutes so realtime repaints don't re-hit the
  // edge function for a day whose bookings barely move.
  var cached = flowCache[d];
  if (d !== TODAY && cached && (Date.now() - cached.t) < 300000) return cached.v;
  try {
    var res = await fetch(SUPABASE_URL + '/functions/v1/sevenrooms-sync?coverflow=' + d, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'x-proxy-secret': KITCHEN_PROXY_SECRET
      }
    });
    var data = await res.json();
    var out = (!res.ok || !data.ok || !data.slots || !data.slots.length) ? null : data;
    if (d !== TODAY) flowCache[d] = { t: Date.now(), v: out };
    return out;
  } catch (err) {
    console.error('Cover flow fetch error:', err);
    return null;
  }
}

async function syncSevenRoomsCovers() {
  var btn = document.getElementById('sr-sync-btn');
  if (btn) { btn.textContent = '⟳ Syncing...'; btn.disabled = true; }

  try {
    // Call the sevenrooms-sync Edge Function (server-side OAuth + reservations pull).
    // The function authenticates to SevenRooms, sums covers per date, and writes
    // them into the 'covers' table. No browser CORS issues, no scraping.
    var res = await fetch(SUPABASE_URL + '/functions/v1/sevenrooms-sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'x-proxy-secret': KITCHEN_PROXY_SECRET
      }
    });

    var data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error((data && data.error) ? data.error : ('HTTP ' + res.status));
    }

    var nDays = (data.written && data.written.length) || data.days || 0;

    // renderDashboard() reloads the covers table via loadCovers() and repaints
    await renderDashboard();

    if (btn) {
      btn.textContent = '✓ Synced ' + nDays + ' days';
      btn.style.background = 'var(--oliva)';
      btn.style.borderColor = 'var(--oliva)';
      setTimeout(function(){
        btn.textContent = '↻ Sync SevenRooms';
        btn.style.background = '';
        btn.style.borderColor = '';
        btn.disabled = false;
      }, 3000);
    }

  } catch(err) {
    console.error('SevenRooms sync error:', err);
    if (btn) {
      btn.textContent = '↻ Sync SevenRooms';
      btn.disabled = false;
    }
    alert('Sync failed: ' + (err.message || 'Unknown error'));
  }
}


// â”€â”€ REPORTS â”€â”€
function renderReports(){
  const stationOptions=['<option value="">All stations</option>',...STATIONS.map(st=>`<option value="${st.key}">${st.label}</option>`)].join('');
  document.getElementById('reports-view').innerHTML=`
    <div class="ops-title">Reports</div>
    <div class="ops-subtitle">Filter by date, station, item, and status</div>
    <div class="report-filter-panel">
      <div class="report-filter-grid">
        <div class="check-field"><div class="check-label">Single date</div><input class="check-input" id="report-single-date" type="date" value="${TODAY}"></div>
        <div class="check-field"><div class="check-label">From</div><input class="check-input" id="report-from-date" type="date"></div>
        <div class="check-field"><div class="check-label">To</div><input class="check-input" id="report-to-date" type="date"></div>
        <div class="check-field"><div class="check-label">Station</div><select class="check-select" id="report-station">${stationOptions}</select></div>
        <div class="check-field"><div class="check-label">Status</div><select class="check-select" id="report-status"><option value="">All</option><option value="sos">SOS</option><option value="bu">Backup</option><option value="ok">OK</option><option value="none">Pending</option><option value="review">To check</option><option value="discard">Discard</option></select></div>
        <div class="check-field"><div class="check-label">Item / dish</div><input class="check-input" id="report-search" placeholder="Ricciola, dill, pasta..."></div>
      </div>
      <div style="height:10px"></div>
      <button class="report-btn" onclick="applyReports()">Apply filters</button>
    </div>
    <div id="reports-content"></div>`;
  applyReports();
}
function dateInReportRange(date,single,from,to){
  if(single)return date===single;
  if(from&&date<from)return false;
  if(to&&date>to)return false;
  return true;
}
// Load saved prep results for past dates from the change-log (prep_status_log).
// Returns rows in the same shape as prepRows(); null on a failed load so the
// caller can show "couldn't load" instead of a misleading "no records".
async function loadPrepHistoryRows(single,from,to){
  // Paged: the log grows with every status tap, so a date-range report passes
  // the 1000-row response cap within days and would silently under-report.
  const {data:logs,error}=await kFetchAllPaged(function(){
    let q=sb.from('prep_status_log').select('service_date,station_key,subsection_key,dish_name,component_name,status,logged_at');
    if(from||to){ if(from)q=q.gte('service_date',from); if(to)q=q.lte('service_date',to); }
    else { q=q.eq('service_date',single); }
    return q.order('logged_at',{ascending:true}).order('id',{ascending:true});
  });
  if(error){ console.warn('report history load failed',error); return null; }
  if(!logs) return [];
  // Latest log entry per item per day wins (ascending order → last write).
  const finalByKey={};
  logs.forEach(l=>{ finalByKey[l.service_date+'||'+l.station_key+'||'+l.subsection_key+'||'+l.dish_name+'||'+l.component_name]=l; });
  return Object.values(finalByKey).map(l=>({
    type:'Prep',date:l.service_date,stationKey:l.station_key,
    station:stationLabel(l.station_key),subsection:subsectionLabel(l.station_key,l.subsection_key),
    dish:l.dish_name,item:l.component_name,status:l.status,note:''
  }));
}
async function applyReports(){
  const single=document.getElementById('report-single-date')?.value||TODAY;
  const from=document.getElementById('report-from-date')?.value||'';
  const to=document.getElementById('report-to-date')?.value||'';
  const station=document.getElementById('report-station')?.value||'';
  const status=document.getElementById('report-status')?.value||'';
  const search=(document.getElementById('report-search')?.value||'').toLowerCase();
  // Today (the default) uses the live in-memory board, which includes chef
  // checks. Any past date / range loads saved prep history from the database.
  const useRange=!!(from||to);
  const isLiveToday=!useRange && single===TODAY;
  let sourceRows;
  if(isLiveToday){
    sourceRows=currentReportRows();
  } else {
    const content=document.getElementById('reports-content');
    if(content)content.innerHTML='<div class="report-no-data">Loading saved history…</div>';
    sourceRows=await loadPrepHistoryRows(single,from,to);
    if(sourceRows===null){
      if(content)content.innerHTML='<div class="report-no-data">Couldn’t load history — check the connection and tap Apply filters again.</div>';
      return;
    }
  }
  const rows=sourceRows.filter(r=>{
    const dateOk=dateInReportRange(r.date,useRange?'':single,from,to);
    const stationOk=!station||r.stationKey===station;
    const statusOk=!status||r.status===status;
    const text=(r.station+' '+r.subsection+' '+r.dish+' '+r.item+' '+r.note).toLowerCase();
    return dateOk&&stationOk&&statusOk&&(!search||text.includes(search));
  });
  const prepCount=rows.filter(r=>r.type==='Prep').length;
  const checkCount=rows.filter(r=>r.type==='Chef check').length;
  const histNote=isLiveToday?'':'<div class="ops-subtitle" style="margin:2px 0 10px">Saved prep history · chef-checks are only kept for today</div>';
  const table=rows.length?`<div class="report-table">
    <div class="report-row head"><div>Type</div><div>Station</div><div>Item</div><div>Status</div><div>Date</div></div>
    ${rows.map(r=>`<div class="report-row">
      <div>${r.type}</div>
      <div>${r.station}</div>
      <div><div class="report-cell-main">${r.item}</div><div class="critical-meta">${r.dish} · ${r.subsection}${r.note?' · '+r.note:''}</div></div>
      <div><span class="check-badge ${r.status==='sos'?'discard':r.status==='bu'?'review':r.status}">${statusLabel(r.status)}</span></div>
      <div>${r.date}</div>
    </div>`).join('')}
  </div>`:`<div class="report-no-data">No records match these filters</div>`;
  document.getElementById('reports-content').innerHTML=`
    <div class="ops-grid">
      <div class="ops-card dark"><div class="ops-num">${rows.length}</div><div class="ops-label">Matching records</div></div>
      <div class="ops-card"><div class="ops-num">${prepCount}</div><div class="ops-label">Prep records</div></div>
      <div class="ops-card"><div class="ops-num">${checkCount}</div><div class="ops-label">Chef checks</div></div>
      <div class="ops-card"><div class="ops-num">${rows.filter(r=>['sos','review','discard'].includes(r.status)).length}</div><div class="ops-label">Needs attention</div></div>
    </div>
    ${histNote}
    ${table}`;
}

// â”€â”€ RECIPES â”€â”€
// escHtml stays here — 23 other places in this file use it.
function escHtml(v){return String(v??'').replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];});}

// The old Recipes library — a searchable dump of 524 extracted sheets, most of them
// with no method at all — was replaced on 2 Aug 2026 by three screens that share ONE
// live record: write the dish, how it is made, for the floor. Each is its own page
// and its own tile on the home screen. See openRecipeCreate / openRecipeCard /
// openFoodBible below; the data file recipes.js is gone with it.

// â”€â”€ REPORT VIEW â”€â”€
async function loadReport() {
  const date = document.getElementById('report-date').value;
  if (!date) return;
  const el = document.getElementById('report-content');
  el.innerHTML = '<div class="report-no-data">Loading...</div>';
  const { data: logs } = await kFetchAllPaged(() => sb.from('prep_status_log').select('*').eq('service_date', date).order('logged_at', {ascending: false}).order('id', {ascending: false}));
  if (!logs || logs.length === 0) { el.innerHTML = `<div class="report-no-data">No data recorded for ${date}</div>`; return; }

  // Get final status per item (latest log entry wins)
  const finalStatus = {};
  [...logs].reverse().forEach(l => {
    const key = `${l.station_key}||${l.subsection_key}||${l.dish_name}||${l.component_name}`;
    finalStatus[key] = l.status;
  });

  const counts = {sos:0,bu:0,ok:0,none:0};
  Object.values(finalStatus).forEach(s=>counts[s]++);
  const total = Object.values(counts).reduce((a,b)=>a+b,0);

  // Per station breakdown
  const byStation = {};
  Object.entries(finalStatus).forEach(([key, status]) => {
    const [stk,ssk,dn,comp] = key.split('||');
    if (!byStation[stk]) byStation[stk] = {};
    if (!byStation[stk][dn]) byStation[stk][dn] = {sos:0,bu:0,ok:0,none:0,items:[]};
    byStation[stk][dn][status]++;
    if (status === 'sos' || status === 'bu') byStation[stk][dn].items.push({comp, status});
  });

  const stationBlocks = STATIONS.map(st => {
    if (!byStation[st.key]) return '';
    const dishes = byStation[st.key];
    const stCounts = {sos:0,bu:0,ok:0};
    Object.values(dishes).forEach(d=>{stCounts.sos+=d.sos;stCounts.bu+=d.bu;stCounts.ok+=d.ok;});
    const dishRows = Object.entries(dishes).map(([dname, dc]) => {
      const badges = `${dc.sos>0?`<span class="rsc-badge rsc-sos">${dc.sos} SOS</span>`:''}${dc.bu>0?`<span class="rsc-badge rsc-bu">${dc.bu} BU</span>`:''}${dc.ok>0?`<span class="rsc-badge rsc-ok">${dc.ok} OK</span>`:''}`;
      return `<div class="report-dish-row"><span class="report-dish-name">${dname}</span><div class="report-dish-badges">${badges}</div></div>`;
    }).join('');
    return `<div class="report-station-block"><div class="report-station-header"><span class="report-station-name">${st.label}</span><div class="report-station-counts">${stCounts.sos>0?`<span class="rsc-badge rsc-sos">${stCounts.sos} SOS</span>`:''}${stCounts.bu>0?`<span class="rsc-badge rsc-bu">${stCounts.bu} BU</span>`:''}${stCounts.ok>0?`<span class="rsc-badge rsc-ok">${stCounts.ok} OK</span>`:''}
    </div></div>${dishRows}</div>`;
  }).join('');

  el.innerHTML = `
    <div class="report-summary">
      <div class="report-card c-sos"><span class="report-card-num">${counts.sos}</span><span class="report-card-label">SOS</span></div>
      <div class="report-card c-bu"><span class="report-card-num">${counts.bu}</span><span class="report-card-label">Backup</span></div>
      <div class="report-card c-ok"><span class="report-card-num">${counts.ok}</span><span class="report-card-label">OK</span></div>
      <div class="report-card c-total"><span class="report-card-num">${total}</span><span class="report-card-label">Total</span></div>
    </div>
    ${stationBlocks || '<div class="report-no-data">No station data found</div>'}`;
}

// â”€â”€ COUNTER â”€â”€
function renderCounter() {
  const st=STATIONS.find(s=>s.key===activeStation);
  if(!st)return;
  const c=stationCounts(st);
  const total=c.sos+c.bu+c.ok+c.none;
  document.getElementById('sec-counter').innerHTML=[
    {cls:'c-sos',key:'sos',num:c.sos,label:'SOS'},
    {cls:'c-bu',key:'bu',num:c.bu,label:'Backup'},
    {cls:'c-ok',key:'ok',num:c.ok,label:'OK'},
    {cls:'c-pending',key:'none',num:c.none,label:'Pending'},
  ].map(card=>`<div class="sc-card ${card.cls}${activeFilter===card.key?' filter-active':''}" onclick="toggleFilter('${card.key}')"><span class="sc-num">${card.num}</span><span class="sc-label">${card.label}</span></div>`).join('');
  document.getElementById('foot-label').textContent=`${st.label} · ${total} items total`;
  const rb=document.getElementById('reset-bar');
  if(rb){rb.classList.add('visible');cancelResetConfirm();}
  const fb=document.getElementById('filter-bar');
  if(activeFilter){fb.classList.add('visible');document.getElementById('filter-label-text').textContent={sos:'SOS only',bu:'Backup only',ok:'OK only',none:'Pending only'}[activeFilter];}
  else fb.classList.remove('visible');
}

function applyFilter() {
  const st=STATIONS.find(s=>s.key===activeStation);
  if(!st)return;
  st.subsections.forEach(ss=>ss.dishes.forEach(dish=>{
    let vis=false;
    dish.items.forEach(item=>{
      const id=mkId(st.key,ss.key,dish.name,item);
      const show=!activeFilter||(state[id]||'none')===activeFilter;
      const row=document.getElementById('pr-'+encodeURIComponent(id));
      if(row)row.classList.toggle('hidden-row',!show);
      if(show)vis=true;
    });
    const db=document.getElementById('db-'+st.key+'-'+ss.key+'-'+dish.name.replace(/[^a-z0-9]/gi,'_'));
    if(db)db.classList.toggle('hidden-block',!vis);
  }));
}

function toggleFilter(k){activeFilter=activeFilter===k?null:k;renderCounter();applyFilter();}
function clearFilter(){activeFilter=null;renderCounter();applyFilter();}

// ── RESET ALL (active station → Pending) ──
function showResetConfirm(){
  const st=STATIONS.find(s=>s.key===activeStation); if(!st)return;
  const c=stationCounts(st); const set=c.sos+c.bu+c.ok;
  const lbl=document.getElementById('reset-confirm-label');
  if(lbl)lbl.textContent=set>0?`Reset ${set} item${set>1?'s':''} in ${st.label} back to Pending?`:`Nothing to reset in ${st.label}.`;
  document.getElementById('reset-all-btn').classList.add('hidden');
  document.getElementById('reset-confirm').classList.add('visible');
}
function cancelResetConfirm(){
  const b=document.getElementById('reset-all-btn'); const c=document.getElementById('reset-confirm');
  if(b)b.classList.remove('hidden'); if(c)c.classList.remove('visible');
}
async function resetActiveStation(){
  const st=STATIONS.find(s=>s.key===activeStation); if(!st){cancelResetConfirm();return;}
  const who = await resetIdentity('reset all of '+st.label);
  if(!who){ cancelResetConfirm(); return; }
  const changed=[];
  st.subsections.forEach(ss=>ss.dishes.forEach(d=>d.items.forEach(item=>{
    const id=mkId(st.key,ss.key,d.name,item);
    const prev=state[id]||'none';
    if(prev!=='none'){state[id]='none';changed.push({ss:ss.key,dn:d.name,item,prev});}
  })));
  cancelResetConfirm();
  if(!changed.length)return;
  renderTabs();renderCounter();renderContent();applyFilter();
  if(DEV_READ_ONLY)return;
  const rows=changed.map(ch=>({service_date:TODAY,station_key:st.key,subsection_key:ch.ss,dish_name:ch.dn,component_name:ch.item,status:'none',updated_at:new Date().toISOString()}));
  const logs=changed.map(ch=>({service_date:TODAY,station_key:st.key,subsection_key:ch.ss,dish_name:ch.dn,component_name:ch.item,status:'none',previous_status:ch.prev}));
  // supabase-js resolves with {error} and never throws, so a try/catch can't see
  // a failed write. Check .error explicitly and, on failure, put every item back
  // to what it was so the board never shows a reset the database didn't accept.
  const up = await sb.from('prep_status').upsert(rows,{onConflict:'service_date,station_key,subsection_key,dish_name,component_name'});
  if (up.error) {
    changed.forEach(ch=>{ state[mkId(st.key,ch.ss,ch.dn,ch.item)]=ch.prev; });
    renderTabs();renderCounter();renderContent();applyFilter();
    console.warn('[resetActiveStation] prep_status save failed', up.error);
    kToast('Reset NOT saved — check connection and try again.', true);
    return;
  }
  // Audit log is secondary — record it, but don't fail the reset if only it errors.
  const lg = await sb.from('prep_status_log').insert(logs);
  if (lg.error) console.warn('[resetActiveStation] prep_status_log insert failed', lg.error);
  logReset(who, 'prep_reset_station', st.label, changed.length);
}

// â”€â”€ CONTENT â”€â”€
function renderContent() {
  const st=STATIONS.find(s=>s.key===activeStation);
  if(!st){document.getElementById('content').innerHTML='';return;}
  document.getElementById('content').innerHTML=renderStationChecks(st.key)+st.subsections.map(ss=>`
    <div class="subsec-title">${ss.label}<div class="subsec-line"></div></div>
    ${ss.dishes.map(dish=>{
      const dk='db-'+st.key+'-'+ss.key+'-'+dish.name.replace(/[^a-z0-9]/gi,'_');
      const eS=st.key.replace(/'/g,"\\'"),eSS=ss.key.replace(/'/g,"\\'"),eDN=dish.name.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
      const did='dc-'+st.key+'-'+ss.key+'-'+dish.name.replace(/[^a-z0-9]/gi,'_');
      const mid='mv-'+st.key+'-'+ss.key+'-'+dish.name.replace(/[^a-z0-9]/gi,'_');
      const apid='ap-'+st.key+'-'+ss.key+'-'+dish.name.replace(/[^a-z0-9]/gi,'_');
      const stationOptions=STATIONS.map(x=>`<option value="${x.key}"${x.key===st.key?' selected':''}>${x.label}</option>`).join('');
      const subsectionOptions=st.subsections.map(x=>`<option value="${x.key}"${x.key===ss.key?' selected':''}>${x.label}</option>`).join('');
      return `<div class="dish-block" id="${dk}">
        <div class="dish-label">
          <span class="dish-name-text">${dish.name}${dish.extra?'<span class="dish-extra-tag"> · EXTRA</span>':''}</span>
          <div class="dish-actions" id="${mid}-actions">
            <button class="dish-addprep-btn" onclick="showAddPrepPanel('${apid}')">+ Add prep</button>
            <button class="dish-move-btn" onclick="showMovePanel('${mid}','${did}')">Move dish</button>
            <button class="dish-delete-btn" id="${did}-btn" onclick="showDishConfirm('${did}','${eS}','${eSS}','${eDN}')">Remove dish</button>
            <div class="dish-confirm-row" id="${did}-confirm">
              <span class="dish-confirm-label">Remove entire dish?</span>
              <button class="dish-confirm-yes" onclick="deleteDish('${eS}','${eSS}','${eDN}','${did}')">Yes, remove</button>
              <button class="dish-confirm-no" onclick="cancelDishConfirm('${did}')">Cancel</button>
            </div>
          </div>
        </div>
        <div class="dish-move-panel" id="${apid}">
          <span class="dish-move-label">New prep item</span>
          <input type="text" class="addprep-inp" id="${apid}-inp" placeholder="e.g. Basil oil" onkeydown="if(event.key==='Enter')addPrepItem('${eS}','${eSS}','${eDN}','${apid}');if(event.key==='Escape')cancelAddPrepPanel('${apid}')" />
          <button class="dish-move-yes" onclick="addPrepItem('${eS}','${eSS}','${eDN}','${apid}')">Add</button>
          <button class="dish-move-no" onclick="cancelAddPrepPanel('${apid}')">Cancel</button>
          <div class="dish-move-note" id="${apid}-note"></div>
        </div>
        <div class="dish-move-panel" id="${mid}">
          <span class="dish-move-label">Move to</span>
          <select class="dish-move-select" id="${mid}-station" onchange="updateMoveSubsections('${mid}')">${stationOptions}</select>
          <select class="dish-move-select" id="${mid}-subsection">${subsectionOptions}</select>
          <button class="dish-move-yes" onclick="moveDish('${eS}','${eSS}','${eDN}','${mid}')">Move</button>
          <button class="dish-move-no" onclick="cancelMovePanel('${mid}')">Cancel</button>
          <div class="dish-move-note" id="${mid}-note"></div>
        </div>
        ${dish.items.map((item,idx)=>{
          const id=mkId(st.key,ss.key,dish.name,item);
          const s=state[id]||'none';
          const esc=id.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
          const bc=s==='none'?'sbtn-none':'sbtn-colored';
          const ikey='ic-'+encodeURIComponent(id);
          return `<div class="prep-row status-${s}" id="pr-${encodeURIComponent(id)}">
            <span class="prep-name">${item}</span>
            <div class="row-right">
              <div class="item-confirm-inline" id="${ikey}">
                <span class="ic-label">Remove?</span>
                <button class="ic-yes" onclick="deleteItem('${esc}','${eS}','${eSS}','${eDN}',${idx},'${ikey}')">Yes</button>
                <button class="ic-no" onclick="cancelItemConfirm('${ikey}','${encodeURIComponent(id)}')">No</button>
              </div>
              <div class="status-btns" id="sb-${encodeURIComponent(id)}">
                <button class="sbtn ${bc}${s==='sos'?' active-sos':''}" onclick="setS('${esc}','sos')">SOS</button>
                <button class="sbtn ${bc}${s==='bu'?' active-bu':''}" onclick="setS('${esc}','bu')">BU</button>
                <button class="sbtn ${bc}${s==='ok'?' active-ok':''}" onclick="setS('${esc}','ok')">OK</button>
              </div>
              <button class="item-del-btn" id="idb-${encodeURIComponent(id)}" onclick="showItemConfirm('${ikey}','${encodeURIComponent(id)}')" aria-label="Remove item" title="Remove item">X</button>
            </div>
          </div>`;
        }).join('')}
      </div>`;
    }).join('')}
  `).join('');
  applyFilter();
}

// â”€â”€ UPDATE SINGLE ROW WITHOUT FULL RE-RENDER (for realtime) â”€â”€
function updateRowUI(id, s) {
  const row = document.getElementById('pr-'+encodeURIComponent(id));
  if (!row) return;
  row.className='prep-row status-'+s;
  const bc=s==='none'?'sbtn-none':'sbtn-colored';
  const btns=row.querySelectorAll('.sbtn');
  if(btns[0]){btns[0].className=`sbtn ${bc}`+(s==='sos'?' active-sos':'');btns[1].className=`sbtn ${bc}`+(s==='bu'?' active-bu':'');btns[2].className=`sbtn ${bc}`+(s==='ok'?' active-ok':'');}
}

// â”€â”€ SET STATUS â”€â”€
async function setS(id, val) {
  const prev = state[id]||'none';
  const newVal = prev===val?'none':val;
  state[id]=newVal;
  updateRowUI(id, newVal);
  renderTabs();renderCounter();applyFilter();
  const {stk,ssk,dn,item}=parseId(id);
  const res = await saveStatus(stk,ssk,dn,item,newVal,prev);
  if (res && res.error) {
    // Save didn't reach the server — revert the optimistic change so the board
    // never shows a status the database doesn't have, and tell the chef.
    state[id]=prev;
    updateRowUI(id, prev);
    renderTabs();renderCounter();applyFilter();
    console.warn('prep_status save failed', res.error);
    kToast('Not saved — check connection and tap again.', true);
  }
}

// â”€â”€ MOVE DISH â”€â”€
function showMovePanel(mid,did){
  const panel=document.getElementById(mid);
  const actions=document.getElementById(mid+'-actions');
  const confirm=document.getElementById(did+'-confirm');
  const deleteBtn=document.getElementById(did+'-btn');
  if(confirm)confirm.classList.remove('visible');
  if(deleteBtn)deleteBtn.style.display='';
  if(panel)panel.classList.add('visible');
  if(actions)actions.style.display='none';
}
function cancelMovePanel(mid){
  const panel=document.getElementById(mid);
  const actions=document.getElementById(mid+'-actions');
  if(panel)panel.classList.remove('visible');
  if(actions)actions.style.display='';
}
function updateMoveSubsections(mid){
  const stationKey=document.getElementById(mid+'-station').value;
  const st=STATIONS.find(s=>s.key===stationKey);
  const select=document.getElementById(mid+'-subsection');
  if(!st||!select)return;
  select.innerHTML=st.subsections.map(ss=>`<option value="${ss.key}">${ss.label}</option>`).join('');
}
async function persistMoveDish(dish, fromStKey, fromSsKey, toStKey, toSsKey, savedState){
  if(DEV_READ_ONLY)return {};
  let err=null;
  if(dish.id){const r=await sb.from('dishes').update({station_key:toStKey,subsection_key:toSsKey}).eq('id',dish.id);if(r&&r.error)err=r.error;}
  const oldRows=Object.entries(savedState).map(([component,status])=>({
    service_date:TODAY,station_key:toStKey,subsection_key:toSsKey,dish_name:dish.name,component_name:component,status,updated_at:new Date().toISOString()
  }));
  if(oldRows.length){const r=await sb.from('prep_status').upsert(oldRows,{onConflict:'service_date,station_key,subsection_key,dish_name,component_name'});if(r&&r.error)err=r.error;}
  const r2=await sb.from('prep_status').delete().eq('service_date',TODAY).eq('station_key',fromStKey).eq('subsection_key',fromSsKey).eq('dish_name',dish.name);if(r2&&r2.error)err=r2.error;
  if(err){console.warn('move dish save failed',err);kToast('Move may not have fully saved — check connection and refresh.', true);}
  return err?{error:err}:{};
}
async function moveDish(fromStKey,fromSsKey,dishName,mid){
  const toStKey=document.getElementById(mid+'-station').value;
  const toSsKey=document.getElementById(mid+'-subsection').value;
  const note=document.getElementById(mid+'-note');
  if(fromStKey===toStKey&&fromSsKey===toSsKey){cancelMovePanel(mid);return;}
  const fromSt=STATIONS.find(s=>s.key===fromStKey);
  const fromSs=fromSt&&fromSt.subsections.find(s=>s.key===fromSsKey);
  const toSt=STATIONS.find(s=>s.key===toStKey);
  const toSs=toSt&&toSt.subsections.find(s=>s.key===toSsKey);
  if(!fromSt||!fromSs||!toSt||!toSs)return;
  if(toSs.dishes.find(d=>d.name===dishName)){
    if(note){note.textContent=`"${dishName}" already exists in ${toSs.label}.`;note.style.display='block';}
    return;
  }
  const idx=fromSs.dishes.findIndex(d=>d.name===dishName);
  if(idx===-1)return;
  const dish=fromSs.dishes.splice(idx,1)[0];
  const savedState={};
  const movedChecks=[];
  dish.items.forEach(item=>{
    const oldId=mkId(fromStKey,fromSsKey,dish.name,item);
    const newId=mkId(toStKey,toSsKey,dish.name,item);
    savedState[item]=state[oldId]||'none';
    state[newId]=savedState[item];
    delete state[oldId];
    const existingCheck=getChefCheck(oldId);
    if(existingCheck){
      existingCheck.id=newId;
      existingCheck.stationKey=toStKey;
      existingCheck.subsectionKey=toSsKey;
      movedChecks.push({oldId,newCheck:{...existingCheck}});
    }
  });
  toSs.dishes.push(dish);
  saveChefChecks();
  for(const item of movedChecks){
    await deleteChefCheck(item.oldId);
    const existing=chefChecks.find(c=>c.id===item.newCheck.id);
    if(existing)Object.assign(existing,item.newCheck);
    else chefChecks.unshift(item.newCheck);
    await upsertChefCheck(item.newCheck);
  }
  await persistMoveDish(dish,fromStKey,fromSsKey,toStKey,toSsKey,savedState);
  undoStack={type:'move',fromStKey,fromSsKey,toStKey,toSsKey,dishName:dish.name,idx};
  activeFilter=null;
  switchStation(toStKey);
  showUndo(`"${dish.name}" moved to ${toSt.label} / ${toSs.label}`);
}


// ADD PREP ITEM
function showAddPrepPanel(apid){
  document.querySelectorAll('.dish-move-panel.visible').forEach(p=>p.classList.remove('visible'));
  const el=document.getElementById(apid);
  if(el){el.classList.add('visible');const inp=document.getElementById(apid+'-inp');if(inp){inp.value='';setTimeout(()=>inp.focus(),50);}}
}
function cancelAddPrepPanel(apid){
  const el=document.getElementById(apid);
  if(el)el.classList.remove('visible');
}
async function addPrepItem(stKey,ssKey,dishName,apid){
  const inp=document.getElementById(apid+'-inp');
  const note=document.getElementById(apid+'-note');
  const name=inp?inp.value.trim():'';
  if(!name){if(note){note.style.display='block';note.textContent='Enter a prep name.';}return;}
  const st=STATIONS.find(s=>s.key===stKey);if(!st)return;
  const ss=st.subsections.find(s=>s.key===ssKey);if(!ss)return;
  const dish=ss.dishes.find(d=>d.name===dishName);if(!dish)return;
  if(dish.items.some(i=>i.toLowerCase()===name.toLowerCase())){
    if(note){note.style.display='block';note.textContent='"'+name+'" is already in this dish.';}
    return;
  }
  cancelAddPrepPanel(apid);
  if(DEV_READ_ONLY){
    dish.items.push(name);
    if(dish.components)dish.components.push({id:null,name});
    state[mkId(stKey,ssKey,dishName,name)]='none';
  }else{
    const {data:comp,error}=await sb.from('dish_components').insert({dish_id:dish.id,name,sort_order:dish.items.length+1,active:true}).select().single();
    if(error||!comp){console.error('Add prep error:',error);showUndo('Could not save "'+name+'" - try again');return;}
    dish.items.push(name);
    if(dish.components)dish.components.push({id:comp.id,name:comp.name});
    state[mkId(stKey,ssKey,dishName,name)]='none';
  }
  renderTabs();renderCounter();renderContent();
  showUndo('"'+name+'" added to '+dishName);
}

// â”€â”€ DELETE DISH â”€â”€
function showDishConfirm(did,stKey,ssKey,dishName){document.getElementById(did+'-btn').style.display='none';document.getElementById(did+'-confirm').classList.add('visible');}
function cancelDishConfirm(did){document.getElementById(did+'-btn').style.display='';document.getElementById(did+'-confirm').classList.remove('visible');}
async function deleteDish(stKey,ssKey,dishName,did){
  const st=STATIONS.find(s=>s.key===stKey);const ss=st.subsections.find(s=>s.key===ssKey);
  const di=ss.dishes.findIndex(d=>d.name===dishName);if(di===-1)return;
  const removed=ss.dishes.splice(di,1)[0];
  const savedState={};removed.items.forEach(item=>{const id=mkId(stKey,ssKey,dishName,item);savedState[item]=state[id]||'none';delete state[id];});
  undoStack={type:'dish',stKey,ssKey,dish:removed,idx:di,savedState};
  showUndo(`"${dishName}" removed`);renderTabs();renderCounter();renderContent();
  // Sync to Supabase. If the delete fails, put the dish back so the board never
  // shows it gone while the database still has it.
  if(!DEV_READ_ONLY && removed.id){
    const res=await sb.from('dishes').delete().eq('id',removed.id);
    if(res && res.error){
      ss.dishes.splice(di,0,removed);
      removed.items.forEach(item=>{state[mkId(stKey,ssKey,dishName,item)]=savedState[item]||'none';});
      undoStack=null;hideUndoToast();
      console.warn('dish delete failed',res.error);
      renderTabs();renderCounter();renderContent();
      kToast('Not removed — check connection and tap again.', true);
    }
  }
}

// â”€â”€ DELETE ITEM â”€â”€
function showItemConfirm(ikey,encId){document.getElementById(ikey).classList.add('visible');document.getElementById('sb-'+encId).style.display='none';document.getElementById('idb-'+encId).style.display='none';}
function cancelItemConfirm(ikey,encId){document.getElementById(ikey).classList.remove('visible');document.getElementById('sb-'+encId).style.display='';document.getElementById('idb-'+encId).style.display='';}
async function deleteItem(id,stKey,ssKey,dishName,idx,ikey){
  const st=STATIONS.find(s=>s.key===stKey);const ss=st.subsections.find(s=>s.key===ssKey);const dish=ss.dishes.find(d=>d.name===dishName);
  if(!dish)return;const itemName=dish.items[idx];const savedStatus=state[id]||'none';delete state[id];
  const removedComp=dish.components?dish.components[idx]:null;
  dish.items.splice(idx,1);
  if(dish.components)dish.components.splice(idx,1);
  let emptied=false, di=-1, rd=null;
  if(dish.items.length===0){di=ss.dishes.findIndex(d=>d.name===dishName);rd=ss.dishes.splice(di,1)[0];undoStack={type:'dish',stKey,ssKey,dish:rd,idx:di,savedState:{}};emptied=true;}
  else undoStack={type:'item',stKey,ssKey,dishName,itemName,idx,savedStatus};
  showUndo(`"${itemName}" removed`);renderTabs();renderCounter();renderContent();
  // Sync to Supabase. If the item delete fails, put it back so the board never
  // shows it gone while the database still has it.
  if(!DEV_READ_ONLY && removedComp && removedComp.id){
    const res=await sb.from('dish_components').delete().eq('id',removedComp.id);
    if(res && res.error){
      if(emptied && rd){ss.dishes.splice(di,0,rd);}
      dish.items.splice(idx,0,itemName);
      if(dish.components)dish.components.splice(idx,0,removedComp);
      state[id]=savedStatus;
      undoStack=null;hideUndoToast();
      console.warn('item delete failed',res.error);
      renderTabs();renderCounter();renderContent();
      kToast('Not removed — check connection and tap again.', true);
      return;
    }
  }
  // Item delete reached the server; if that emptied the dish, remove the now-empty dish row too.
  if(emptied && !DEV_READ_ONLY && rd && rd.id){
    const res2=await sb.from('dishes').delete().eq('id',rd.id);
    if(res2 && res2.error){ console.warn('empty-dish delete failed (item already removed)',res2.error); }
  }
}

// â”€â”€ UNDO â”€â”€
function showUndo(msg){
  if(undoTimer)clearTimeout(undoTimer);
  document.getElementById('undo-msg').textContent=msg;
  document.getElementById('undo-toast').classList.add('visible');
  undoTimer=setTimeout(()=>{document.getElementById('undo-toast').classList.remove('visible');undoStack=null;},6000);
}
function hideUndoToast(){ if(undoTimer)clearTimeout(undoTimer); const t=document.getElementById('undo-toast'); if(t)t.classList.remove('visible'); }
async function undoDelete(){
  if(!undoStack)return;clearTimeout(undoTimer);document.getElementById('undo-toast').classList.remove('visible');
  const u=undoStack;undoStack=null;
  if(u.type==='move'){
    const fromSt=STATIONS.find(s=>s.key===u.fromStKey),toSt=STATIONS.find(s=>s.key===u.toStKey);
    const fromSs=fromSt&&fromSt.subsections.find(s=>s.key===u.fromSsKey),toSs=toSt&&toSt.subsections.find(s=>s.key===u.toSsKey);
    if(fromSs&&toSs){
      const di=toSs.dishes.findIndex(d=>d.name===u.dishName);
      if(di!==-1){
        const dish=toSs.dishes.splice(di,1)[0];
        const savedState={};
        dish.items.forEach(item=>{
          const oldId=mkId(u.toStKey,u.toSsKey,dish.name,item);
          const newId=mkId(u.fromStKey,u.fromSsKey,dish.name,item);
          savedState[item]=state[oldId]||'none';
          state[newId]=savedState[item];
          delete state[oldId];
        });
        fromSs.dishes.splice(Math.min(u.idx,fromSs.dishes.length),0,dish);
        await persistMoveDish(dish,u.toStKey,u.toSsKey,u.fromStKey,u.fromSsKey,savedState);
        switchStation(u.fromStKey);
        return;
      }
    }
  }
  const st=STATIONS.find(s=>s.key===u.stKey);const ss=st.subsections.find(s=>s.key===u.ssKey);
  if(u.type==='dish'){ss.dishes.splice(u.idx,0,u.dish);u.dish.items.forEach(item=>{state[mkId(u.stKey,u.ssKey,u.dish.name,item)]=u.savedState[item]||'none';});}
  else{const dish=ss.dishes.find(d=>d.name===u.dishName);if(dish){dish.items.splice(u.idx,0,u.itemName);state[mkId(u.stKey,u.ssKey,u.dishName,u.itemName)]=u.savedStatus||'none';}}
  renderTabs();renderCounter();renderContent();
}

// â”€â”€ APP PAGES â”€â”€
function hideAllPages(){
  if (typeof schedLockNow === 'function' && typeof schedUnlocked !== 'undefined' && schedUnlocked) schedLockNow();
  ['home-view','pass-view','report-view','dashboard-view','reports-view','order-view','fish-view','stocktake-view','catalogue-view','fmcmatch-view','recipes-view','recipecreate-view','recipecard-view','foodbible-view','menupdf-view','micros-view','recipebook-view','todo-view','check-view','scheduling-view','closing-view','team-view','menuplan-view','calendar-view','mytasks-view','content','legend-bar','sec-counter-wrap','add-section-wrap'].forEach(function(id){
    var el=document.getElementById(id);if(el)el.style.display='none';
  });
  document.getElementById('section-tabs').style.display='none';
  document.querySelector('.footer-bar').style.display='none';
  kRoom(false);
}
// The room is scoped to the front door: it goes on for home and comes off the
// moment you walk through any station door. `?room=venue-x.jpg` swaps the frame
// so a room can be reviewed without a rebuild — see room-contrast.py.
var HOME_ROOM = 'venue-windowwall.jpg';
function kRoom(on){
  var b=document.body;
  b.classList.toggle('roomstep', !!on);
  if(!on) return;
  var q=new URLSearchParams(location.search).get('room');
  b.style.setProperty('--room', 'url(' + (/^venue-[a-z0-9]+\.jpg$/.test(q||'') ? q : HOME_ROOM) + ')');
  b.style.setProperty('--scrim', 1);
}
function openHome(){
  activeStation=HOME_KEY;
  hideAllPages();
  document.getElementById('home-view').style.display='block';
  document.getElementById('foot-label').textContent='Kitchen App';
  kRoom(true);
  loadKitchenEvents();
}
// ══ KITCHEN EVENTS STRIP ══════════════════════════════════════════════
// Every confirmed FOH event whose team brief has been sent, from today onward,
// grouped this-week / next-2-weeks / later and capped. Reads a scoped read-only
// feed from the FOH project — kitchen-safe fields only (name, date, time, area,
// guests, dietary, menu + quantities); never prices or client data. Handles
// canapé menus AND plated set menus; flags beverage-only events; shows a note
// (not a silent blank) if the feed can't be reached. Tap a row to expand its
// prep list; Print menu prints it.
const FOH_EVENTS_URL = 'https://paoaivwtkzujmrgrfjuq.supabase.co/functions/v1/kitchen-events';
const KEV_ALG = {D:'dairy',E:'egg',H:'homemade',N:'nuts',R:'raw',S:'shellfish',V:'vegetarian'};
// Plated set-menu dishes are NOT kept here any more. They are data-driven in the
// FOH Chef Corner (event_set_menus) and resolved server-side by the kitchen-events
// function, which sends the ready prep rows in e.menu — exactly like canapEs. This
// is the single source of truth: a hardcoded mirror here silently went stale the
// moment a menu was created or edited, and the kitchen showed "No dishes listed".
let KEV_CACHE = {};
function kevEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function kevAlg(a){ return (a||[]).map(function(c){ return KEV_ALG[c]||String(c).toLowerCase(); }).join(', '); }
function kevDate(ds){ if(!ds) return {day:'',mon:'',full:''}; var d=new Date(String(ds).slice(0,10)+'T12:00:00');
  return { day:d.getDate(), mon:d.toLocaleDateString('en-GB',{weekday:'short',month:'short'}),
           full:d.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'}) }; }
// One model for both canapé + plated set-menu events → rows + a total label.
// kevMenuModelRaw = the events-desk truth; kevMenuModel layers the kitchen's own
// prep overrides on top (see KEV_OVR) WITHOUT ever hiding the events number.
function kevMenuModelRaw(e){
  var g = Number(e.guests)||0;
  if(e.kind==='set'){
    // Prep rows are resolved server-side from the live event_set_menus library
    // and arrive in e.menu. No local menu table — so any menu the events desk
    // creates or edits reaches the kitchen with zero redeploy.
    if(e.menu && e.menu.length){
      var smName = (e.set_menu && e.set_menu.name) ? e.set_menu.name : 'Set menu';
      return { rows:e.menu, total_label:(g?g+' guests · ':'')+smName, empty_msg:null };
    }
    return { rows:[], total_label:'', empty_msg:'Set menu selected — its dishes couldn’t be loaded. Check with the events desk.' };
  }
  if(e.kind==='canape' && e.menu && e.menu.length){
    var rows2 = e.menu.map(function(m){
      return {name:m.name, group:m.group, qty:m.qty, unit:m.unit||'pcs', sub:(m.per_guest?m.per_guest+' / guest':''), desc:m.desc||'', allergens:m.allergens||[], comp:m.comp, unconfirmed:m.unconfirmed, min_flag:m.min_flag}; });
    return { rows:rows2, total_label:(e.total_pcs||0)+' pcs'+(e.pcs_per_guest?' · '+e.pcs_per_guest+' / guest':''), empty_msg:null };
  }
  return { rows:[], total_label:'', empty_msg: e.bev_only ? 'Beverage only — no kitchen prep' : 'No dishes listed yet — check with the events desk' };
}
// ── Kitchen prep overrides ──────────────────────────────────────────────────
// A chef can override how many portions to actually cook for a dish (e.g. spares
// or extra staff portions). Overrides live in the KITCHEN db (kitchen owns its
// prep numbers; the events desk still owns the menu). The override NEVER hides
// the events count — the row shows both, so the two can't silently disagree.
const KEV_EDIT_CODE = '2468';           // kitchen prep-override code (change here) — same as stock-take supervisor
let KEV_OVR = {};                        // key(event_id, dish_name) -> portions (number)
let KEV_TODAY = null;                    // last "today" from the feed, for re-render
let KEV_CAN_EDIT = false;                // unlocked this session after the code
function kevOvrKey(eid, name){ return String(eid)+' '+String(name); }
// Events-desk portion for one dish (before any override) — used to show "events: N".
function kevBaseQty(e, name){
  var raw = kevMenuModelRaw(e);
  for(var i=0;i<raw.rows.length;i++){ if(raw.rows[i].name===name) return raw.rows[i].qty; }
  return null;
}
// Layer overrides on top of the raw model. Always returns FRESH row objects so
// the KEV_CACHE feed data is never mutated.
function kevMenuModel(e){
  var mm = kevMenuModelRaw(e);
  var rows = mm.rows.map(function(m){
    var o = KEV_OVR[kevOvrKey(e.id, m.name)];
    if(o==null) return m;
    if(o.label!=null && String(o.label)!=='') return Object.assign({}, m, { ovr:true, ovr_label:o.label, base_qty:m.qty, qty:null });
    return Object.assign({}, m, { qty:o.portions, base_qty:m.qty, ovr:true });
  });
  return { rows:rows, total_label:mm.total_label, empty_msg:mm.empty_msg };
}
async function loadKevOverrides(ids){
  KEV_OVR = {};
  if(!ids || !ids.length) return;
  try{
    var r = await sb.from('kitchen_event_overrides').select('event_id,dish_name,portions,label').in('event_id', ids);
    if(r && r.error) throw r.error;
    (r.data||[]).forEach(function(o){ KEV_OVR[kevOvrKey(o.event_id, o.dish_name)] = { portions:o.portions, label:o.label }; });
  }catch(err){ console.warn('[kev-ovr] load skipped', err && err.message||err); }  // table missing / offline → no overrides, strip still works
}
function kevUnlockEdit(){
  if(KEV_CAN_EDIT) return true;
  var p = prompt('Enter the kitchen prep code to change portions:');
  if(p===null) return false;
  if(String(p).trim() !== KEV_EDIT_CODE){ kToast('Wrong code — portions stay as the events count.', true); return false; }
  KEV_CAN_EDIT = true; return true;
}
// Re-render just one event's prep block, keeping the card open (no full reload).
function rerenderKevEvent(eid){
  var e = KEV_CACHE[eid]; if(!e) return;
  var el = document.getElementById('kev-prep-'+eid);
  if(el){ el.innerHTML = kevPrepRows(e); }
  else if(KEV_TODAY!=null){ renderKitchenEvents(Object.keys(KEV_CACHE).map(function(k){return KEV_CACHE[k];}), KEV_TODAY); }
}
async function kevEditPortion(eid, idx){
  if(!kevUnlockEdit()) return;
  var e = KEV_CACHE[eid]; if(!e) return;
  var raw = kevMenuModelRaw(e); var row = raw.rows[idx]; if(!row) return;
  var name = row.name, base = row.qty;
  var oCur = KEV_OVR[kevOvrKey(eid,name)];
  var curStr = oCur ? ((oCur.label!=null && oCur.label!=='') ? String(oCur.label) : (oCur.portions!=null?String(oCur.portions):'')) : (base==null?'':String(base));
  var v = prompt('What to cook for “'+name+'” — '+e.name+'\nEvents count: '+(base==null?'—':base)+'\n\nEnter a number (e.g. 15) OR a note (e.g. guests choose on the night).\nBlank = back to the events count.', curStr);
  if(v===null) return;
  v = String(v).trim();
  if(v===''){ return kevResetPortion(eid, name); }
  var isNum = /^\d+$/.test(v);                 // pure digits = a portion count; anything else = a note
  if(isNum && Number(v)>100000){ kToast('That number is too large.', true); return; }
  var payload = isNum
    ? { event_id:eid, dish_name:name, portions:Number(v), label:null, set_by:'kitchen', updated_at:new Date().toISOString() }
    : { event_id:eid, dish_name:name, portions:null, label:v, set_by:'kitchen', updated_at:new Date().toISOString() };
  var res = await sb.from('kitchen_event_overrides').upsert(payload, { onConflict:'event_id,dish_name' });
  if(res && res.error){ kToast('Could not save: '+res.error.message+(String(res.error.message).indexOf('read-only')>=0?' (unlock the DEV badge).':''), true); return; }
  KEV_OVR[kevOvrKey(eid,name)] = isNum ? { portions:Number(v), label:null } : { portions:null, label:v };
  kToast('Saved ✓ — '+name+' set to “'+(isNum?v+' portions':v)+'” (events: '+(base==null?'—':base)+')');
  rerenderKevEvent(eid);
}
async function kevResetPortion(eid, name){
  var res = await sb.from('kitchen_event_overrides').delete().eq('event_id',eid).eq('dish_name',name);
  if(res && res.error){ kToast('Could not reset: '+res.error.message, true); return; }
  delete KEV_OVR[kevOvrKey(eid,name)];
  kToast('Reset ✓ — '+name+' back to the events count.');
  rerenderKevEvent(eid);
}
async function loadKitchenEvents(){
  var box = document.getElementById('kev-strip'); if(!box) return;
  try{
    var res = await fetch(FOH_EVENTS_URL, { headers:{ 'x-proxy-secret': KITCHEN_PROXY_SECRET } });
    if(!res.ok) throw new Error('HTTP '+res.status);
    var data = await res.json();
    if(data && data.error) throw new Error(data.error);
    KEV_CACHE = {};
    (data.events||[]).forEach(function(e){ KEV_CACHE[e.id]=e; });
    KEV_TODAY = data.today;
    await loadKevOverrides((data.events||[]).map(function(e){ return e.id; }));
    renderKitchenEvents(data.events||[], data.today);
  }catch(err){
    console.warn('[kitchen-events] load failed', err);
    box.innerHTML = '<div class="kev-err">Couldn’t load upcoming events — check the connection.</div>';
  }
}
function kevDaysUntil(d, today){ return Math.round((new Date(String(d).slice(0,10)+'T12:00:00') - new Date(today+'T12:00:00'))/86400000); }
function renderKitchenEvents(events, today){
  var box = document.getElementById('kev-strip'); if(!box) return;
  if(!events || !events.length){ box.innerHTML=''; return; }
  var todayEv=[], up=[];
  events.forEach(function(e){ if(kevDaysUntil(e.date, today)<=0) todayEv.push(e); else up.push(e); });
  var h = '<div class="kev-band"><span class="kev-band-t">Events</span></div>';
  todayEv.forEach(function(e){ h += kevTodayCard(e); });
  // Upcoming: grouped by proximity, nearest first, capped so the home screen
  // never floods (the feed is sorted by date, so the cap keeps the soonest).
  var MAX = 6, shown = 0, hidden = 0, lastLb = null;
  function bucket(n){ return n<=7 ? 'This week' : (n<=21 ? 'Next 2 weeks' : 'Later'); }
  up.forEach(function(e){
    if(shown >= MAX){ hidden++; return; }
    var lb = bucket(kevDaysUntil(e.date, today));
    if(lb !== lastLb){ lastLb = lb; h += '<div class="kev-up-h">'+lb+'</div>'; }
    h += kevUpRow(e); shown++;
  });
  if(hidden>0) h += '<div class="kev-more">+ '+hidden+' more event'+(hidden>1?'s':'')+' further out</div>';
  box.innerHTML = h;
}
// Shared prep list (dishes/courses + quantities + allergens + total + dietary).
function kevPrepRows(e){
  var mm = kevMenuModel(e);
  if(!mm.rows.length){ return '<div class="kev-empty">'+kevEsc(mm.empty_msg||'')+'</div>'; }
  var h = '', lastG = null;
  mm.rows.forEach(function(m, idx){
    if(m.group && m.group!==lastG){ lastG = m.group; h += '<div class="kev-grp">'+kevEsc(m.group)+'</div>'; }
    h += '<div class="kev-prow"><div class="kev-dish"><b>'+kevEsc(m.name)+'</b>'+
      (m.comp?' <span class="kev-comp">on the house</span>':'')+
      (m.allergens&&m.allergens.length?' <span class="kev-alg">'+kevEsc(kevAlg(m.allergens))+'</span>':'')+
      (m.sub?' <span class="kev-sub">'+kevEsc(m.sub)+'</span>':'')+
      (m.unconfirmed?' <span class="kev-def">to confirm</span>':'')+
      // The dish name alone cannot be cooked from, and cannot be handed to the
      // pass as a menu. The wording is recorded in Chef Corner (canapes) or on
      // the menu itself (set menus) and now arrives on the feed, so it belongs
      // here, under the name, on the chef's own screen.
      (m.desc?'<div class="kev-desc">'+kevEsc(m.desc)+'</div>':'')+
      '</div><div class="kev-qty">'+
        (m.ovr?'<b class="kev-ovr-n">'+(m.ovr_label!=null?kevEsc(m.ovr_label):(m.qty!=null?m.qty+' '+(m.unit||'pcs'):'—'))+'</b> <span class="kev-ovr-was">events: '+(m.base_qty==null?'—':m.base_qty)+'</span>'
             :(m.qty!=null?m.qty+' '+(m.unit||'pcs'):'—'))+
        (m.min_flag?' <span class="kev-min">min '+m.min_flag+'</span>':'')+
        ' <button class="kev-edit" title="Change portions to cook" onclick="event.stopPropagation();kevEditPortion(\''+e.id+'\','+idx+')">edit</button>'+
      '</div></div>';
  });
  h += '<div class="kev-total"><span>Total</span><b>'+kevEsc(mm.total_label)+'</b></div>';
  if(e.dietary) h += '<div class="kev-diet"><b>Dietary:</b> '+kevEsc(e.dietary)+'</div>';
  return h;
}
// A briefed event the events desk has not confirmed yet. The kitchen sees it
// LABELLED rather than not at all: the brief email already told them to cook it,
// so hiding it here is what made the two disagree. Strictly === false, so an old
// cached feed without the field shows no label rather than labelling everything.
function kevDraftTag(e){ return e && e.confirmed === false ? '<span class="kev-draft">Draft &mdash; not confirmed</span>' : ''; }
function kevTodayCard(e){
  var meta = [ (e.guests!=null?('<b>'+e.guests+' guests</b>'):''), [e.time_from,e.time_to].filter(Boolean).join('–'), kevEsc(e.area||'') ].filter(Boolean).join(' · ');
  // The menu starts CLOSED, like every upcoming event. Several events on one
  // day opened expanded one under the other, so reaching the second one meant
  // scrolling past the whole first menu. Tap the card to open it.
  return '<div class="kev-today"><div class="kev-today-top clickable" onclick="kevToggle(\''+e.id+'\',this)"><div><span class="kev-chip">Event today</span>'+
    '<div class="kev-name">'+kevEsc(e.name)+kevDraftTag(e)+' <span class="kev-chev">&#9662;</span></div><div class="kev-meta">'+meta+'</div></div>'+
    '<button class="kev-print" onclick="event.stopPropagation();kevPrintMenu(\''+e.id+'\')">Print menu</button></div>'+
    '<div class="kev-prep" id="kevb-'+e.id+'" style="display:none"><div id="kev-prep-'+e.id+'">'+kevPrepRows(e)+'</div></div></div>';
}
function kevUpRow(e){
  var d = kevDate(e.date);
  var meta = [ (e.guests!=null?e.guests+' guests':''), [e.time_from,e.time_to].filter(Boolean).join('–'), kevEsc(e.area||'') ].filter(Boolean).join(' · ');
  return '<div class="kev-up-wrap">'+
    '<div class="kev-up clickable" onclick="kevToggle(\''+e.id+'\',this)">'+
      '<div class="kev-badge"><div class="kev-bd-day">'+d.day+'</div><div class="kev-bd-mon">'+d.mon+'</div></div>'+
      '<div class="kev-up-mid"><div class="kev-up-name">'+kevEsc(e.name)+kevDraftTag(e)+' <span class="kev-chev">&#9662;</span></div><div class="kev-up-meta">'+meta+'</div></div>'+
      '<button class="kev-print sm" onclick="event.stopPropagation();kevPrintMenu(\''+e.id+'\')">Print menu</button></div>'+
    '<div class="kev-up-body" id="kevb-'+e.id+'" style="display:none"><div id="kev-prep-'+e.id+'">'+kevPrepRows(e)+'</div></div>'+
  '</div>';
}
function kevToggle(id, rowEl){
  var b = document.getElementById('kevb-'+id); if(!b) return;
  var open = (b.style.display==='none' || !b.style.display);
  b.style.display = open ? 'block' : 'none';
  var wrap = rowEl && rowEl.parentNode; if(wrap) wrap.classList.toggle('open', open);
  var c = rowEl && rowEl.querySelector('.kev-chev'); if(c) c.style.transform = open ? 'rotate(180deg)' : '';
}
function kevPrintMenu(id){
  var e = KEV_CACHE[id]; if(!e) return;
  var d = kevDate(e.date), mm = kevMenuModel(e);
  var rows = '', lastG = null;
  if(!mm.rows.length){ rows = '<tr><td colspan="2" style="color:#8A6A4F">'+kevEsc(mm.empty_msg||'No dishes')+'</td></tr>'; }
  mm.rows.forEach(function(m){
    if(m.group && m.group!==lastG){ lastG = m.group; rows += '<tr><td colspan="2" style="background:#F3E9DA;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#8A6A4F">'+kevEsc(m.group)+'</td></tr>'; }
    var note = [kevAlg(m.allergens), m.sub].filter(Boolean).join(' · ');
    rows += '<tr><td>'+kevEsc(m.name)+(m.comp?' — on the house':'')+(note?' <span style="color:#9a7b5f;font-size:11px">'+kevEsc(note)+'</span>':'')+
      (m.desc?'<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#6B4A33;line-height:1.4;margin-top:3px">'+kevEsc(m.desc)+'</div>':'')+'</td>'+
      '<td style="text-align:right"><b>'+(m.ovr_label!=null?kevEsc(m.ovr_label):(m.qty!=null?m.qty+' '+(m.unit||'pcs'):'—'))+'</b>'+
      (m.ovr?' <span style="color:#9a7b5f;font-size:11px">(events: '+(m.base_qty==null?'—':m.base_qty)+')</span>':'')+
      (m.min_flag?' <span style="color:#b00020;font-size:11px">min '+m.min_flag+'</span>':'')+'</td></tr>';
  });
  var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Kitchen menu — '+kevEsc(e.name)+'</title>'+
    '<style>@page{margin:16mm}body{font-family:Georgia,serif;color:#2C1810;max-width:640px;margin:0 auto;padding:20px}'+
    '.b{font-size:22px;letter-spacing:7px;color:#400207;text-align:center;margin:4px 0}'+
    '.r{width:66px;height:1px;background:#C9A84C;margin:9px auto}'+
    '.h{background:#400207;color:#E8D9C7;text-align:center;padding:7px;font-size:13px;letter-spacing:2px;margin-top:12px}'+
    '.meta{text-align:center;font-size:13px;color:#6B4A33;margin:8px 0 4px}'+
    'table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}td{padding:6px 8px;border:1px solid #E3D5C2}'+
    'th{background:#F3E9DA;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#8A6A4F;padding:6px 8px;border:1px solid #E3D5C2;text-align:left}'+
    '.tl{text-align:center;font-size:13px;color:#400207;margin-top:10px;font-weight:bold}.diet{color:#b00020;font-size:12px;margin-top:8px}.btn{position:fixed;top:10px;right:10px}@media print{.btn{display:none}}'+
    '</style></head><body>'+
    '<div class="btn"><button onclick="window.print()" style="background:#400207;color:#E8D9C7;border:none;border-radius:8px;padding:10px 18px;font-family:Georgia,serif;font-size:14px;cursor:pointer">Print</button></div>'+
    '<div class="b">R O B E R T O ’ S</div><div class="r"></div><div class="h">KITCHEN — MENU &amp; QUANTITIES</div>'+
    '<div class="meta"><b>'+kevEsc(e.name)+'</b><br>'+d.full+(e.guests!=null?' · '+e.guests+' guests':'')+([e.time_from,e.time_to].filter(Boolean).length?' · '+[e.time_from,e.time_to].filter(Boolean).join('–'):'')+(e.area?' · '+kevEsc(e.area):'')+'</div>'+
    '<table><tr><th>Dish</th><th style="text-align:right">To prepare</th></tr>'+rows+'</table>'+
    (mm.total_label?'<div class="tl">'+kevEsc(mm.total_label)+'</div>':'')+
    (e.dietary?'<div class="diet"><b>Dietary — read before prep:</b> '+kevEsc(e.dietary)+'</div>':'')+
    '</body></html>';
  var w = window.open('','_blank'); if(!w){ alert('Allow pop-ups to print the menu'); return; }
  w.document.write(html); w.document.close(); setTimeout(function(){ try{ w.print(); }catch(err){} }, 350);
}
function openPrep(key){
  document.getElementById('section-tabs').style.display='flex';
  document.querySelector('.footer-bar').style.display='flex';
  renderTabs();
  switchStation(key||PASS_KEY);
}
function openChecklist(){
  activeStation=CHECK_KEY;
  hideAllPages();
  document.getElementById('check-view').style.display='block';
  document.querySelector('.footer-bar').style.display='flex';
  document.getElementById('foot-label').textContent='Chef Checklist';
  renderCheckView();
}
function openDashboard(){
  activeStation=DASHBOARD_KEY;
  hideAllPages();
  document.getElementById('dashboard-view').style.display='block';
  document.querySelector('.footer-bar').style.display='flex';
  document.getElementById('foot-label').textContent='Dashboard';
  renderDashboard();
}
function openReports(){
  activeStation=REPORTS_KEY;
  hideAllPages();
  document.getElementById('reports-view').style.display='block';
  document.querySelector('.footer-bar').style.display='flex';
  document.getElementById('foot-label').textContent='Reports';
  renderReports();
}
function openOrderInventory(){ openMarketList(); }
// â”€â”€ RECIPES â€” three screens, one record â”€â”€
// The dish is written once and read by the pass and the floor. Each screen gets its
// own tile and its own view, so any of the three is one tap from home â€” nobody has
// to go "into recipes" and then hunt for the right one.
//
// Each is a page of its own, shown in its view. It is only built the first time that
// tile is opened, and then left alone: rebuilding it on every open would throw away a
// half-written recipe, which is the one thing this module must never do.
// The way in. Three screens, one dish, one record — so they live together behind one
// door rather than as three unrelated things on the home screen.
// ONE door changed, 25 Aug 2026 — Danilo and Antonio. The Micros request came off the
// page and the RECIPE BOOK took its place. The rest of the page is exactly as it was.
//
// The Micros request was never a PLACE. It is a thing you do to a dish or to a menu, and
// giving it a door meant that asking for one dish to go to the till started by leaving
// the dish. It is a button on the recipe's card in the book, and a button inside a menu.
// Same screen, same code; only the way in is different.
var RECIPE_SCREENS=[
  {code:'RCP', view:'recipecreate-view', page:'recipe-create.html?embed=1',
   name:'Create new recipes',
   meta:'Ingredients off the stock take, method, allergens, photo — and the half the floor reads.'},
  {code:'PASS', view:'recipecard-view', page:'recipe-card.html?embed=1',
   name:'Recipe card',
   meta:'The station card: the dish and every batch inside it, scaled, printable.'},
  {code:'FOH', view:'foodbible-view', page:'food-bible.html?embed=1',
   name:'Food Bible',
   meta:'One dish, one A4 — the menu line, what to say, allergens, what to set.'},
  {code:'MENU', view:'menupdf-view', page:'menu-pdfs.html?embed=1',
   name:'Current menu',
   meta:'Every menu we print, kept ready for the printer — à la carte, wine, set menus.'},
  {code:'FIX', view:'todo-view', page:'recipe-create.html?embed=1&todo=1',
   name:'Needs finishing',
   meta:'Every recipe and batch that is not done \u2014 a line with no ingredient, no amount, a batch that has been removed. Tap one to put it right.'},
  // Where the Micros request used to be. It is the saved recipes, filed by menu — the
  // screen they actually wanted quick access to, and the one every other way in already
  // went through. Micros is now a button on the cards inside it.
  {code:'BOOK', view:'recipebook-view', page:'recipe-create.html?embed=1&saved=1',
   name:'Recipe book',
   meta:'Every dish we have written, filed by menu. Open one to change it, send one to the till, or send a whole menu to Aung.'}
];
function openRecipes(){
  activeStation=RECIPES_KEY;
  hideAllPages();
  var v=document.getElementById('recipes-view');
  v.style.cssText='';
  // The room at the top, then the doors on paper. `aria-label` is on the button because
  // a <button> only takes phrasing content — the name inside a heading announced as
  // nothing at all on a screen reader.
  v.innerHTML='<div class="rcp-paper">'+
    '<div class="rcp-hero">'+
      '<img src="img/recipes-terrace.jpg" alt="The terrace at Roberto\'s DIFC at night">'+
      '<div class="rcp-hero-in">'+
        '<div class="rcp-eyebrow">Roberto\'s Kitchen</div>'+
        '<h2>Recipes</h2>'+
        '<div class="rcp-hero-rule"></div>'+
        '<p>One dish, written once. The pass and the floor read the same record.</p>'+
      '</div>'+
    '</div>'+
    '<div class="rcp-doors">'+RECIPE_SCREENS.map(function(s){
      return '<button class="rcp-door" type="button" data-rcp="'+s.view+'" '+
        'aria-label="Open '+escHtml(s.name)+'">'+
        '<span class="rcp-top">'+
          '<span class="rcp-code">'+s.code+'</span>'+
          '<span class="rcp-name">'+escHtml(s.name)+'</span>'+
        '</span>'+
        '<span class="rcp-meta">'+escHtml(s.meta)+'</span>'+
        '<span class="rcp-go">Open<span class="rcp-arw">&rarr;</span></span></button>';
    }).join('')+'</div>'+
  '</div>';
  document.querySelector('.footer-bar').style.display='flex';
  document.getElementById('foot-label').textContent='Recipes';
}
function openRecipeScreen(viewId){
  var s=RECIPE_SCREENS.filter(function(x){return x.view===viewId;})[0];
  if(!s) return;
  activeStation=RECIPES_KEY;
  hideAllPages();
  var v=document.getElementById(viewId);
  if(v){
    // A column: a slim bar back to Recipes, then the screen filling what is left.
    v.style.cssText='padding:0;display:flex;flex-direction:column';
    if(!v.firstChild){
      var bar=document.createElement('div');
      bar.className='rcp-bar';
      bar.innerHTML='<button class="home-btn" onclick="openRecipes()">&lsaquo; Recipes</button>'+
        '<span class="rcp-bar-name">'+escHtml(s.name)+'</span>';
      var f=document.createElement('iframe');
      f.src=s.page; f.title=s.name; f.loading='eager';
      f.style.cssText='display:block;width:100%;flex:1 1 auto;min-height:0;border:none;background:var(--sabbia)';
      v.appendChild(bar); v.appendChild(f);
    }
    v.style.display='flex';
    // The page is built once and then left alone, so tapping "Create new recipes" a
    // second time showed whatever was last on the screen - a workbook he had opened, a
    // half-written sheet - instead of a new recipe. The tile has to mean what it says.
    // The page drops anything unsaved into its own Unsaved work list first, so a clean
    // start never costs him what he had.
    //
    // The Recipe book is deliberately NOT reset this way. A book that forgets where you
    // were is a worse book: coming back to the menu you were reading is the point, and
    // starting a new recipe from in there is its own button.
    if(s.code==='RCP'){
      var fr=v.querySelector('iframe');
      var go=function(){ try{ if(fr.contentWindow&&fr.contentWindow.__rcpNew) fr.contentWindow.__rcpNew(); }catch(e){} };
      if(fr){ if(fr.contentWindow&&fr.contentWindow.__rcpNew) go();
              else fr.addEventListener('load',go,{once:true}); }
    }
  }
  document.querySelector('.footer-bar').style.display='flex';
  document.getElementById('foot-label').textContent=s.name;
  fitRecipeScreen();
}
// The header wraps on a phone and the footer is a different height on a tablet, so a
// fixed "100vh minus 116px" is wrong on most devices — it either leaves a dead strip
// or pushes the last line under the footer bar. Measure where the open view actually
// starts and how tall the footer actually is, every time one opens and on every turn
// of the screen.
function fitRecipeScreen(){
  var v=['recipecreate-view','recipecard-view','foodbible-view','menupdf-view','micros-view','recipebook-view','todo-view']
    .map(function(id){return document.getElementById(id);})
    .filter(function(el){return el&&el.style.display==='flex';})[0];
  if(!v) return;
  var foot=document.querySelector('.footer-bar');
  var footH=(foot&&getComputedStyle(foot).display!=='none')?foot.getBoundingClientRect().height:0;
  var h=window.innerHeight - v.getBoundingClientRect().top - footH;
  v.style.height=Math.max(320,Math.round(h))+'px';
}
window.addEventListener('resize', fitRecipeScreen);
window.addEventListener('orientationchange', function(){ setTimeout(fitRecipeScreen, 250); });
// The three doors on the Recipes page.
document.addEventListener('click', function(e){
  var d=e.target.closest ? e.target.closest('[data-rcp]') : null;
  if(d) openRecipeScreen(d.dataset.rcp);
});

// â”€â”€ SWITCH STATION â”€â”€
function switchStation(key){
  if(key===CHECK_KEY){openChecklist();return;}
  activeStation=key;activeFilter=null;
  const isPass=key===PASS_KEY;
  ['home-view','pass-view','report-view','dashboard-view','reports-view','order-view','fish-view','stocktake-view','recipes-view','recipecreate-view','recipecard-view','foodbible-view','menupdf-view','micros-view','recipebook-view','todo-view','check-view','scheduling-view','closing-view','team-view','menuplan-view','calendar-view','mytasks-view','content','legend-bar','sec-counter-wrap','add-section-wrap'].forEach(function(id){
    var el=document.getElementById(id);if(el)el.style.display='none';
  });
  document.getElementById('section-tabs').style.display='flex';
  document.querySelector('.footer-bar').style.display='flex';
  kRoom(false);
  if(isPass){
    var pv=document.getElementById('pass-view');if(pv)pv.style.display='block';
    document.getElementById('foot-label').textContent='The Pass · All stations';
    renderPassView();
  } else {
    var show={'content':'block','legend-bar':'flex','sec-counter-wrap':'block','add-section-wrap':'block'};
    Object.keys(show).forEach(function(id){var el=document.getElementById(id);if(el)el.style.display=show[id];});
    document.getElementById('foot-label').textContent='';
    var ss=document.getElementById('add-dish-section');if(ss)ss.value=key;
    updateSubsectionSelect();renderCounter();renderContent();
  }
  renderTabs();
}
function populateSelects(){
  if(!STATIONS.length)return;
  const stSel=document.getElementById('add-dish-section');
  if(!stSel)return;
  stSel.innerHTML=STATIONS.map(s=>`<option value="${s.key}">${s.label}</option>`).join('');
  stSel.value=activeStation!==PASS_KEY?activeStation:STATIONS[0].key;
  stSel.onchange=updateSubsectionSelect;updateSubsectionSelect();
}
function updateSubsectionSelect(){
  const stKey=document.getElementById('add-dish-section').value;
  const st=STATIONS.find(s=>s.key===stKey);
  if(!st)return;
  document.getElementById('add-dish-subsection').innerHTML=st.subsections.map(ss=>`<option value="${ss.key}">${ss.label}</option>`).join('');
}
async function addDish(){
  const nameEl=document.getElementById('add-dish-name'),itemsEl=document.getElementById('add-dish-items');
  const stKey=document.getElementById('add-dish-section').value,ssKey=document.getElementById('add-dish-subsection').value;
  const noteEl=document.getElementById('add-note'),name=nameEl.value.trim();
  if(!name){noteEl.style.display='block';noteEl.textContent='Please enter a dish or prep name.';return;}
  const items=itemsEl.value.trim()?itemsEl.value.trim().split('\n').map(i=>i.trim()).filter(i=>i):['Prepare as needed'];
  const st=STATIONS.find(s=>s.key===stKey),ss=st.subsections.find(s=>s.key===ssKey);
  if(ss.dishes.find(d=>d.name===name)){noteEl.style.display='block';noteEl.textContent=`"${name}" already exists.`;return;}
  if (DEV_READ_ONLY) {
    ss.dishes.push({id:'dev-'+Date.now(),name,items,extra:true});
    items.forEach(item=>{state[mkId(stKey,ssKey,name,item)]='none';});
  } else {
    const {data:dish} = await sb.from('dishes').insert({station_key:stKey,subsection_key:ssKey,name,sort_order:ss.dishes.length+1,active:true}).select().single();
    if(dish){
      const comps=items.map((c,i)=>({dish_id:dish.id,name:c,sort_order:i+1,active:true}));
      const {data:insertedComps}=await sb.from('dish_components').insert(comps).select();
      const compList=(insertedComps||[]).slice().sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)).map(c=>({id:c.id,name:c.name}));
      ss.dishes.push({id:dish.id,name,items,extra:true,components:compList});
      items.forEach(item=>{state[mkId(stKey,ssKey,name,item)]='none';});
    }
  }
  nameEl.value='';itemsEl.value='';noteEl.style.display='block';noteEl.textContent=`"${name}" added.`;
  setTimeout(()=>{noteEl.style.display='none';},3000);
  if(activeStation!==stKey)switchStation(stKey);else{renderTabs();renderCounter();renderContent();}
}

function setDate(){
  const d=new Date();
  const days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
  document.getElementById('hdr-date').textContent=days[d.getDay()]+' '+d.getDate()+' '+months[d.getMonth()]+' '+d.getFullYear();
}

init();


// ══════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════
// SCHEDULING MODULE
// ══════════════════════════════════════════════════════

const STATIONS_SCH = [
  { key: 'pass',         label: 'Pass Area' },
  { key: 'raw_bar',      label: 'Raw Bar / Starter' },
  { key: 'pasta',        label: 'Pasta' },
  { key: 'main',         label: 'Main Course' },
  { key: 'basement',     label: 'Basement (Prep)' },
  { key: 'pastry_pizza', label: 'Pastry & Pizza' },
  { key: 'stewarding',   label: 'Stewarding' },
];
// Section band colours — taken from the chefs' Excel, toned down to a calm rail.
const SEC_COLOR = {
  pass:'#b98f3e', raw_bar:'#3f92a8', pasta:'#9a9088', main:'#9c2b2b',
  basement:'#c98a63', pastry_pizza:'#a9861f', stewarding:'#a7962b', __other:'#8a7d70'
};

const STATUS_META = {
  working: { label: '',    bg: 'working' },
  off:     { label: 'OFF', bg: 'off' },
  wo:      { label: 'WO',  bg: 'wo' },
  sl:      { label: 'SL',  bg: 'sl' },
  al:      { label: 'AL',  bg: 'al' },
  ph:      { label: 'PH',  bg: 'ph' },
  em:      { label: 'EM',  bg: 'em' },
  tr:      { label: 'TR',  bg: 'tr' },
  cdo:     { label: 'CDO', bg: 'cdo' },
  cat:     { label: 'CAT', bg: 'cat' },
};

let schedWeekStart   = null;
let schedRoster      = {};
let schedStaff       = [];
let schedView        = 'week';
let schedEditTarget  = null;
let schedRTChannel   = null;
let schedClipboard   = null;  // copied shift {status,times…,srcStaff,srcDate,label}
let schedUndoStack   = [];    // Excel-style undo: [{label, cells:[{staffId,date,key,prev}]}], newest last
let schedPasteMode   = false; // while true, tapping a cell pastes instead of opening the editor
let schedEvents      = {};    // date(YYYY-MM-DD) -> [{slot,name}] (max 2 per day)
let schedEventDate   = null;  // day being edited in the events modal
let schedEventSel    = [];    // names currently selected in the events modal (max 2)
const KITCHEN_EVENT_PRESETS = ['Private Event','Brunch','Breakfast','Buffet','Set Menu','Wine Dinner','Large Booking','Catering'];
function schEvEsc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Edit lock ──
const SCHED_PIN = '2468'; // schedule edit passcode
const SCHED_LOCK_TIMEOUT_MS = 5 * 60 * 1000; // auto-relock after 5 min idle
let schedUnlocked      = false;
let schedLockTimer     = null;
let schedPendingAction = null;

// Auto-update guard hook: the ETag watcher and the service-worker reload (in
// index.html) must NOT reload the whole page while a manager is editing the
// schedule. Editing happens by tapping cells/buttons/native prompts, so the
// focus-based busy() check misses it and a mid-edit deploy would wipe the work.
// Expose an "editing now" signal: unlocked for edits, paste mode armed, or a
// schedule modal open. The reload is deferred until this returns false.
window.__schedEditing = function(){
  try {
    if (schedUnlocked || schedPasteMode) return true;
    var modals = document.querySelectorAll('.sch-modal-overlay');
    for (var i = 0; i < modals.length; i++){
      if (modals[i].style.display !== 'none' && modals[i].offsetParent !== null) return true;
    }
  } catch(e){}
  return false;
};

// ── COSEC attendance (face recognition) ──
var schedAttendance = {};      // "emp_id|date" -> attendance row
var schedLastSyncInfo = '';

// ── Row-cap warning, on the SCREEN ──
// The roster and attendance loads are capped (3000 / 2000 rows). If a load ever
// fills its cap, rows were dropped and the hours totals undercount — quietly,
// and the screen looks completely normal. It used to say so in console.warn,
// which no chef will ever open. Now it says so where the numbers are.
var schedCapWarn = {};                       // { shifts:true, 'clock-ins':true }
function schedCapHit(what) { schedCapWarn[what] = true; }
function schedCapBannerHtml() {
  var kinds = Object.keys(schedCapWarn);
  if (!kinds.length) return '';
  var list = kinds.length === 2 ? (kinds[0] + ' and ' + kinds[1]) : kinds[0];
  return '<div style="margin:0 0 12px;padding:10px 14px;border-radius:10px;background:#fdf1d6;' +
    'border:1px solid #d9a441;color:#6b4a10;font:500 13px/1.45 Inter,system-ui,sans-serif">' +
    '<strong>These hours may be short.</strong> Too many ' + list + ' came back at once, so some were left out. ' +
    'Do not use these totals for payroll — show this to Francesco.' +
    '</div>';
}
// Attendance tracking began on this date; before it we have no punch data,
// so earlier days fall back to the planned shift (never flagged absent).
var ATT_TRACKING_START = '2026-06-13';
function schedAttKey(empId, dateStr) { return empId + '|' + dateStr; }
function schedTodayStr() { return formatDate(new Date()); }

// ── Helpers ──
function getMonday(d) {
  var dt = new Date(d); var day = dt.getDay();
  dt.setDate(dt.getDate() + (day === 0 ? -6 : 1 - day));
  dt.setHours(12,0,0,0); return dt;
}
function addDays(d, n) { var dt = new Date(d); dt.setDate(dt.getDate() + n); dt.setHours(12,0,0,0); return dt; }
function formatTime(t) { return t ? String(t).substring(0,5) : ''; }
function calcHours(start, end, start2, end2) {
  if (!start || !end) return 0;
  var sp = start.split(':'), ep = end.split(':');
  var mins = (parseInt(ep[0])*60 + parseInt(ep[1]||0)) - (parseInt(sp[0])*60 + parseInt(sp[1]||0));
  if (mins <= 0) mins += 1440;
  if (start2 && end2) {
    var sp2 = start2.split(':'), ep2 = end2.split(':');
    var mins2 = (parseInt(ep2[0])*60 + parseInt(ep2[1]||0)) - (parseInt(sp2[0])*60 + parseInt(sp2[1]||0));
    if (mins2 <= 0) mins2 += 1440;
    mins += mins2;
  }
  return Math.round(mins/6)/10;
}
// Extract HH:MM from an attendance time value. The `attendance` table stores
// first_in/last_out/manual_out/punches as "HH:MM" strings, but tolerate ISO too.
// Mirrors FOH's attHHMM so both apps normalise punches identically.
function attHHMM(t){
  if (!t) return '';
  var m = String(t).match(/(\d{2}):(\d{2})/);
  return m ? m[1] + ':' + m[2] : String(t).slice(0,5);
}
function schedRosterKey(staffId, date) { return staffId + '|' + date; }

// ── Edit lock: guard + PIN modal ──
function schedGuard(replayFn) {
  if (schedUnlocked) { schedTouchLock(); return true; }
  schedPendingAction = replayFn || null;
  schedOpenPin();
  return false;
}
function schedTouchLock() {
  if (schedLockTimer) clearTimeout(schedLockTimer);
  schedLockTimer = setTimeout(schedLockNow, SCHED_LOCK_TIMEOUT_MS);
}
function schedLockNow() {
  schedUnlocked = false;
  if (schedLockTimer) { clearTimeout(schedLockTimer); schedLockTimer = null; }
  schedUpdateLockBtn();
  schedUndoStack = []; if (typeof schedRenderUndoBtn === 'function') schedRenderUndoBtn();   // locking ends the edit session
}
function schedUpdateLockBtn() {
  var b = document.getElementById('sch-lock-btn');
  if (!b) return;
  b.innerHTML = schedUnlocked ? '&#128275; Editing' : '&#128274; Locked';
  b.classList.toggle('unlocked', schedUnlocked);
}
function schedToggleLock() {
  if (schedUnlocked) schedLockNow();
  else schedGuard(null);
}
function schedOpenPin() {
  var inp = document.getElementById('sch-pin-inp');
  inp.value = '';
  document.getElementById('sch-pin-err').style.display = 'none';
  document.getElementById('sch-pin-modal').style.display = 'flex';
  setTimeout(function(){ inp.focus(); }, 60);
}
function schedClosePin(e) {
  if (e && e.target !== document.getElementById('sch-pin-modal')) return;
  document.getElementById('sch-pin-modal').style.display = 'none';
  schedPendingAction = null;
}
function schedCancelPin() {
  document.getElementById('sch-pin-modal').style.display = 'none';
  schedPendingAction = null;
}
function schedSubmitPin() {
  var v = document.getElementById('sch-pin-inp').value.trim();
  if (v === SCHED_PIN) {
    schedUnlocked = true;
    schedTouchLock();
    schedUpdateLockBtn();
    if (typeof schedRenderUndoBtn === 'function') schedRenderUndoBtn();
    document.getElementById('sch-pin-modal').style.display = 'none';
    var fn = schedPendingAction;
    schedPendingAction = null;
    if (fn) fn();
  } else {
    document.getElementById('sch-pin-err').style.display = 'block';
    var inp = document.getElementById('sch-pin-inp');
    inp.value = '';
    inp.focus();
  }
}

// ── Data loading ──
// Sections used to be hardcoded (STATIONS_SCH). They now live in the `sched_sections`
// table so a chef can add/rename them. If the table isn't there yet (SQL not run),
// we keep the hardcoded list — nothing breaks before the migration.
async function loadSchedSections() {
  try {
    var res = await sb.from('sched_sections').select('*').eq('active', true).order('sort_order');
    if (res.error || !res.data || !res.data.length) return;   // table missing/empty → keep defaults
    var loaded = res.data.map(function(r){ return { key: r.section_key, label: r.label }; });
    STATIONS_SCH.length = 0; loaded.forEach(function(s){ STATIONS_SCH.push(s); });
  } catch (e) { /* keep the hardcoded defaults */ }
}

async function loadSchedData() {
  var weekEnd = formatDate(addDays(schedWeekStart, 13));
  var weekFrom = formatDate(addDays(schedWeekStart, -7));
  var res = await Promise.all([
    sb.from('staff').select('*').eq('active', true).order('sort_order'),
    sb.from('roster').select('*').gte('work_date', weekFrom).lte('work_date', weekEnd).limit(3000),
    sb.from('sched_events').select('*').gte('event_date', weekFrom).lte('event_date', weekEnd).limit(2000)
  ]);
  schedStaff = (res[0].data || []).filter(function(s){ return s.in_schedule!==false; });   // FOH Admin "show in schedule" toggle (staff.in_schedule); null/absent = shown
  schedRoster = {};
  var rosterRows = res[1].data || [];
  // Guard against the 1000-row API cap silently truncating the window as staff
  // grow (the same class of bug that hid clock-ins). Warn if we hit the limit.
  if (rosterRows.length >= 3000) { schedCapHit('shifts'); console.warn('roster load hit the row cap — some shifts may be missing; raise .limit().'); }
  rosterRows.forEach(function(r) {
    schedRoster[schedRosterKey(r.staff_id, r.work_date)] = r;
  });
  // Events (table is optional — if it isn't created yet, res[2].error is set and we just show none)
  schedEvents = {};
  if (res[2] && !res[2].error) {
    (res[2].data || []).forEach(function(e) {
      var d = String(e.event_date).substring(0,10);
      (schedEvents[d] = schedEvents[d] || []).push({ slot: e.slot || 1, name: e.name });
    });
    Object.keys(schedEvents).forEach(function(d) {
      schedEvents[d].sort(function(a,b){ return a.slot - b.slot; });
    });
  }
}

// ── COSEC attendance loading & sync ──
async function loadAttendance() {
  var from = formatDate(addDays(schedWeekStart, -1));
  var to = formatDate(addDays(schedWeekStart, 8));
  // Only load the kitchen team's IDs. The attendance table holds the WHOLE
  // company (~350 punch rows/day), so a multi-day window exceeds the server's
  // 1000-row response cap and silently truncates the newest rows (today's) —
  // which made fresh clock-ins vanish. Filtering to our staff keeps the result
  // small (~80 rows) and always complete. Requires schedStaff loaded first.
  var ids = schedStaff.map(function(s){ return s.emp_id; }).filter(Boolean);
  if (!ids.length) { schedAttendance = {}; return; }
  var res = await sb.from('attendance').select('*')
    .in('emp_id', ids).gte('att_date', from).lte('att_date', to).limit(2000);
  // Same row-cap guard as the roster load above: if this window ever fills the
  // limit, punches are being silently dropped and hours totals would undercount.
  // A console.warn is invisible to a chef, so this also puts a strip on the
  // screen — a wrong hours total that nobody was told about is the whole risk.
  if ((res.data || []).length >= 2000) { schedCapHit('clock-ins'); console.warn('attendance load hit the row cap (2000) — some punches may be missing; hours totals could undercount. Raise .limit() or page it.'); }
  schedAttendance = {};
  (res.data || []).forEach(function(a) { schedAttendance[schedAttKey(a.emp_id, a.att_date)] = a; });
}

function triggerCosecSync(force) {
  var btn = document.getElementById('sch-sync-btn');
  if (btn) { btn.textContent = 'Syncing\u2026'; btn.classList.remove('live','err'); }
  var syncOk = false;
  fetch(SUPABASE_URL + '/functions/v1/cosec-sync' + (force ? '?force=1' : ''), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_KEY },
    body: '{}'
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    syncOk = !!(d && d.ok);
    schedLastSyncInfo = syncOk ? ('Live \u00B7 ' + new Date().toTimeString().substring(0,5)) : 'Offline';
  })
  .catch(function() { schedLastSyncInfo = 'Offline'; })
  .then(function() { return loadAttendance(); })
  .catch(function(){})
  .then(function() {
    if (btn) { btn.textContent = schedLastSyncInfo || 'Live'; btn.classList.add(syncOk ? 'live' : 'err'); }
    if (activeStation === SCHED_KEY) { if (schedView === 'week') renderSchedWeek(); else renderSchedDay(); }
  });
}
function schedForceSync() { triggerCosecSync(true); }

// Resolve attendance state for a staff member on a date.
function schedAttState(staff, dateStr) {
  if (!staff.emp_id) return { kind: 'none' };
  var rrow = schedRoster[schedRosterKey(staff.id, dateStr)];
  var scheduled = (!rrow || rrow.status === 'working');
  var a = schedAttendance[schedAttKey(staff.emp_id, dateStr)];
  var isToday = dateStr === schedTodayStr();
  var isPast = dateStr < schedTodayStr();

  if (a && a.first_in) {
    // Build worked segments from the full punch list so a mid-shift break is NOT
    // counted as worked. Split shifts carry >2 punches (1st=in,2nd=out,3rd=in,4th=out…);
    // legacy rows with only first_in/last_out fall back to a single segment.
    // manual_out closes the final segment (manual override wins over the machine
    // punch, so a manager's correction of a wrong/missing clock-out takes effect).
    // Mirrors FOH's fohSchedAttState so both apps report identical worked hours.
    var rawP = (a.punches && a.punches.length >= 2) ? a.punches.map(attHHMM) : null;
    if (!rawP) {
      var effOut0 = a.manual_out || a.last_out || null;
      rawP = effOut0 ? [attHHMM(a.first_in), attHHMM(effOut0)] : [attHHMM(a.first_in)];
    }
    var segs = [];
    for (var pi = 0; pi < rawP.length; pi += 2) {
      segs.push({ in: rawP[pi], out: (pi + 1 < rawP.length) ? rawP[pi + 1] : null });
    }
    if (a.manual_out) segs[segs.length - 1].out = attHHMM(a.manual_out);
    var lastSeg = segs[segs.length - 1];
    var hrs = 0;
    segs.forEach(function(s){ if (s.in && s.out) hrs += calcHours(s.in, s.out); });
    hrs = Math.round(hrs * 10) / 10;
    var isSplit = segs.length > 1;
    if (lastSeg.out) return { kind: 'done', in: attHHMM(a.first_in), out: lastSeg.out,
                              segs: segs, split: isSplit, manual: !!a.manual_out, hours: hrs };
    if (isToday) return { kind: 'in', in: attHHMM(a.first_in), segs: segs, split: isSplit, hours: hrs };
    var pe = rrow ? formatTime(rrow.shift_end) : '';
    return { kind: 'open', in: attHHMM(a.first_in), segs: segs, split: isSplit, hours: hrs, plannedEnd: pe };
  }
  if (scheduled && (isPast || isToday) && dateStr >= ATT_TRACKING_START) {
    if (isPast) return { kind: 'absent' };
    if (rrow && rrow.shift_start) {
      var now = new Date();
      var nowM = now.getHours() * 60 + now.getMinutes();
      var sp = String(rrow.shift_start).substring(0,5).split(':');
      var startM = parseInt(sp[0]) * 60 + parseInt(sp[1] || 0);
      if (nowM > startM + 15 && nowM < startM + 720) return { kind: 'absent' };
    }
  }
  return { kind: 'none' };
}

// Effective hours: actual when completed (today/past), else planned.
function schedEffHours(staff, dateStr) {
  var rr = schedRoster[schedRosterKey(staff.id, dateStr)];
  if (rr && rr.status !== 'working') return 0;
  var att = schedAttState(staff, dateStr);
  if (att.kind === 'done') return att.hours;
  if (att.kind === 'in' || att.kind === 'open' || att.kind === 'absent') return 0;
  var ts = rr ? formatTime(rr.shift_start) : '';
  var te = rr ? formatTime(rr.shift_end) : '';
  if (!ts || !te) return 0;
  return calcHours(ts, te, rr ? formatTime(rr.shift_start2) : '', rr ? formatTime(rr.shift_end2) : '');
}

// Close an open shift (past day, no clock-out) using planned end. Lock-gated.
function schedCloseShift(event, staffId, dateStr) {
  event.stopPropagation();
  if (schedPlanMode) return;   // closing a real clock-out is a live action, not planning
  if (!schedGuard(function(){ schedCloseShift(event, staffId, dateStr); })) return;
  var staff = schedStaff.find(function(s){ return s.id === staffId; });
  if (!staff || !staff.emp_id) return;
  var rrow = schedRoster[schedRosterKey(staffId, dateStr)];
  var plannedEnd = rrow ? formatTime(rrow.shift_end) : '';
  var a = schedAttendance[schedAttKey(staff.emp_id, dateStr)];
  if (!a || !a.first_in) return;
  var out = prompt('Close shift for ' + staff.name + ' on ' + dateStr +
    '\nClocked in at ' + a.first_in + '. Clock-out time (planned end pre-filled):', plannedEnd || '00:00');
  if (out === null) return;
  out = out.trim();
  if (!/^\d{1,2}:\d{2}$/.test(out)) { alert('Please use HH:MM (e.g. 00:00)'); return; }
  var prevOut = a.manual_out, prevClosedAt = a.closed_at;
  a.manual_out = out; a.closed_at = new Date().toISOString();
  renderSchedView();
  // attendance writes are service-role-only now — the manual clock-out goes
  // through the kitchen-guard function (kitchen-security-batch-b.sql).
  fetch(SUPABASE_URL + '/functions/v1/kitchen-guard', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'manual_out', emp_id: staff.emp_id, att_date: dateStr, out: out, closed_at: a.closed_at })
  }).then(function(r){ return r.json(); })
    .then(function(d){
      if (d && d.error) throw new Error(d.error);
      if (d && d.message && !d.ok) throw new Error(d.message);
    })
    .catch(function(e){
      console.error('Close shift error:', e);
      a.manual_out = prevOut; a.closed_at = prevClosedAt;
      renderSchedView();
      alert('Close shift for ' + staff.name + ' did not save: ' + (e && e.message ? e.message : e));
    });
}

// Inline edit of COSEC employee ID. Lock-gated.
function schedEditEmpId(event, staffId) {
  event.stopPropagation();
  if (schedPlanMode) return;   // employee IDs are managed on the live schedule, not in the plan
  if (!schedGuard(function(){ schedEditEmpId(event, staffId); })) return;
  var staff = schedStaff.find(function(s){ return s.id === staffId; });
  if (!staff) return;
  var v = prompt('Employee ID (COSEC) for ' + staff.name + '\nLeave empty = no clock-in tracking:', staff.emp_id || '');
  if (v === null) return;
  v = (v || '').trim();
  staff.emp_id = v || null;
  renderSchedWeek();
  sb.from('staff').update({ emp_id: v || null }).eq('id', staffId)
    .then(function(res){ if (res.error) { console.error('Emp ID update error:', res.error); loadSchedData().then(renderSchedWeek); } });
}

// ── Realtime ──
function subscribeSchedRealtime() {
  if (schedRTChannel) return;
  schedRTChannel = sb.channel('roster_rt')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'roster' }, function(payload) {
      var r = payload.new || payload.old;
      if (!r) return;
      // work_date from Supabase realtime may include time component — normalise to YYYY-MM-DD
      var workDate = r.work_date ? String(r.work_date).substring(0, 10) : '';
      var k = schedRosterKey(r.staff_id, workDate);
      if (payload.eventType === 'DELETE') {
        delete schedRoster[k];
      } else {
        // Normalise work_date on the stored object too
        var normalised = Object.assign({}, payload.new, { work_date: workDate });
        schedRoster[k] = normalised;
      }
      if (activeStation === SCHED_KEY) schedRealtimeRerender();
    })
    .subscribe(function(status) {
      // Log realtime status for debugging
      console.log('Roster realtime:', status);
    });
}

// Re-render the schedule after a realtime roster change WITHOUT wiping a manager
// who is mid-typing — e.g. entering a new staff name/role in the inline add panel,
// or choosing a station in the move panel. The roster state above is already
// updated; we only defer the visual rebuild (which replaces the whole grid) until
// the field is no longer focused. Mirrors the FOH hub's safeToRefresh() pattern.
var schedRerenderTimer = null;
function schedSafeToRerender() {
  var ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT')) {
    var wv = document.getElementById('sch-week-view');
    var dv = document.getElementById('sch-day-view');
    if ((wv && wv.contains(ae)) || (dv && dv.contains(ae))) return false;
  }
  return true;
}
function schedRealtimeRerender() {
  clearTimeout(schedRerenderTimer);
  schedRerenderTimer = setTimeout(function() {
    if (activeStation !== SCHED_KEY) return;
    if (!schedSafeToRerender()) { schedRealtimeRerender(); return; }  // retry once idle
    if (schedView === 'week') renderSchedWeek();
    else renderSchedDay();
  }, 250);
}

// ── Open page ──
async function openScheduling() {
  schedEndPaste();   // clear any leftover paste mode from a previous visit
  schedUndoStack = []; if (typeof schedRenderUndoBtn === 'function') schedRenderUndoBtn();   // fresh session — no stale undo history
  activeStation = SCHED_KEY;
  hideAllPages();
  var el = document.getElementById('scheduling-view');
  el.style.display = 'flex';
  el.style.flexDirection = 'column';
  document.querySelector('.footer-bar').style.display = 'flex';
  document.getElementById('foot-label').textContent = 'Scheduling';
  if (!schedWeekStart) schedWeekStart = getMonday(new Date());
  schedUpdateLockBtn();
  await loadSchedSections();        // section list (add/rename) — before rendering
  loadShiftPresets();               // quick-fill presets for the shift editor (non-blocking)
  await loadSchedData();            // must load staff (emp_ids) BEFORE attendance,
  await loadAttendance();           // which now filters by those ids
  subscribeSchedRealtime();
  renderSchedView();
  triggerCosecSync(false);
  if (!window.schedAttTimer) {
    window.schedAttTimer = setInterval(function() {
      // Stop the always-on COSEC poll once the user leaves the schedule, instead
      // of letting a no-op interval live for the rest of the day. openScheduling
      // recreates it on next entry (guarded above).
      if (activeStation === SCHED_KEY) triggerCosecSync(false);
      else { clearInterval(window.schedAttTimer); window.schedAttTimer = null; }
    }, 5 * 60 * 1000);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  KITCHEN PLANNER — multi-week draft canvas (Phase 1, full build)
//  A separate draft workspace spanning many weeks. It NEVER touches the live
//  roster until you Publish. Draft lives in localStorage (autosaved); Publish
//  upserts the plan into the live `roster` for the chosen dates only, taking a
//  snapshot first so it can be reverted. Reads: staff + roster (read-only until
//  publish). Grounded in: STATIONS_SCH (1797), STATUS_META (1806), roster
//  onConflict staff_id,work_date (2552), DEV_READ_ONLY (13).
// ══════════════════════════════════════════════════════════════════════════

var kplFrom       = null;    // Monday of first week in the span
var kplNumWeeks   = 0;       // span length (1..8)
var kplVisible    = '';      // weeks shown on screen at once: '1'|'2'|'4'|'6'|'fit'
var kplFilterSec  = 'all';
var kplFilterPer  = 'all';
var kplStaff      = [];       // active + in_schedule staff (own copy)
var kplLive       = {};       // 'staffId|date' -> live roster row (read-only)
var kplDraft      = {};       // 'staffId|date' -> {status,shift_start,...,notes}
var kplMode       = 'preview';// 'preview' (live, read-only) | 'draft' (editable)
var kplDirty      = false;
var kplEditKey    = null;     // cell being edited
var kplPaint      = null;     // {status} while paint mode armed
var kplPainting   = false;
var kplPaintStroke= null;     // {label, cells:[{key,prev}], seen} — collects one drag stroke so it undoes as a single step
var kplMins       = {};       // sectionKey -> {wd,we} coverage minimums
var kplEnt        = {};       // staffId -> {off,al,ph} entitlement targets over the span
var kplWkClip     = null;     // copied week index for copy→paste
var kplMoreOpen   = false;    // is the "More" tool group expanded

var KPL_STATUSES  = ['working','off','wo','al','ph','tr','em','sl','cdo'];
// Colours taken straight from the chefs' Excel legend so the tool speaks their colour language.
// off=red, WO=grey, holiday(al)=pink, PH=green, training=blue, emergency=purple, sick=orange, cancel-day-off=yellow.
var KPL_COLOR     = { off:'#d21f1f', wo:'#8a7d70', al:'#d63aa0', ph:'#1f9d4d', tr:'#0070C0', em:'#7030A0', sl:'#c05a1e', cdo:'#c9a400', cat:'#c2410c' };
// Plain-English names a diploma chef reads in 2 seconds (Valentina Rule 5 — no jargon).
// The short code (OFF/WO/AL…) still shows small so it ties to the printed roster.
var KPL_FRIENDLY  = { working:'Working', off:'Day off', wo:'Weekly off', al:'Holiday', ph:'Public holiday', tr:'Training', em:'Emergency', sl:'Sick', cdo:'Cancel day off', cat:'Catering' };
function kplFriendly(st){ return KPL_FRIENDLY[st] || (STATUS_META[st]?(STATUS_META[st].label||st.toUpperCase()):st.toUpperCase()); }
function kplCode(st){ return st==='working'?'':((STATUS_META[st]&&STATUS_META[st].label)||st.toUpperCase()); }
var KPL_DEF_START = '14:00', KPL_DEF_END = '00:00';
var KPL_DRAFT_LS  = 'kitchenPlanDraft';
var KPL_VIEW_LS   = 'kitchenPlanView';
var KPL_SNAP_LS   = 'kitchenPlanSnapshot';

function kplKey(sid, ds){ return sid + '|' + ds; }
function kplDateISO(wk, d){ return formatDate(addDays(kplFrom, wk*7 + d)); }
function kplToday(){ return formatDate(new Date()); }
function kplEntry(sid, ds){ return kplMode==='draft' ? kplDraft[kplKey(sid,ds)] : kplLive[kplKey(sid,ds)]; }
// ── Draft-only team changes (held in the plan, applied on Publish) ──
var kplDraftSec = {};   // staffId -> overridden station_key (a move you haven't published yet)
var kplDraftOrd = {};   // staffId -> order number within its section (a reorder you haven't published yet)
var kplNewStaff = [];   // brand-new people you added: {id:'new-<n>', name, designation, station_key, _new:true}
var kplNewSeq   = 0;
function kplAllPeople(){ return kplStaff.concat(kplNewStaff); }              // everyone shown on the board
function kplEffSec(s){ return (kplMode==='draft' && kplDraftSec[s.id]) ? kplDraftSec[s.id] : s.station_key; }  // section after any draft move
function kplEffOrd(s){ return (kplDraftOrd[s.id]!=null) ? kplDraftOrd[s.id] : (s.sort_order!=null ? s.sort_order : 9999); }
function kplSections(){
  var list = STATIONS_SCH.slice();
  var known = {}; list.forEach(function(s){ known[s.key]=1; });
  var extra = false;
  kplAllPeople().forEach(function(s){ var k=kplEffSec(s); if(k && !known[k]) extra = true; });
  if(extra) list = list.concat([{ key:'__other', label:'Other / Unassigned' }]);
  return list;
}
function kplStaffInSec(secKey){
  return kplAllPeople().filter(function(s){
    var sk = kplEffSec(s);
    var inSec = secKey==='__other' ? (!sk || !STATIONS_SCH.some(function(x){return x.key===sk;})) : (sk===secKey);
    if(!inSec) return false;
    if(kplFilterPer!=='all' && s.id!==kplFilterPer) return false;
    return true;
  }).sort(function(a,b){ return (kplEffOrd(a)-kplEffOrd(b)) || (a.name||'').localeCompare(b.name||''); });
}

// ── Open / close (Roster tool = the SAME schedule grid) ──
var krtWeeks = 1;    // how many weeks shown at once (1 = single, else several)
var krtSpanN = 4;    // remembered "several weeks" count

// ════════════════════════════════════════════════════════════════════════
//  PLANNING SANDBOX
//  The Roster tool is a private draft. Every edit made while it is open goes
//  into a draft held in memory + saved on this device — the REAL schedule is
//  never touched until the chef presses "Bring live" (which publishes the
//  week(s) they pick, names what changes, and can be undone).
//
//  How it works with zero change to how editing FEELS:
//   • The tool reuses the exact schedule grid + editors (schedOpenEdit,
//     schedMoveStaff, fill-teams…). Those write to the in-memory globals
//     (schedRoster / schedStaff) and, normally, to the database.
//   • While schedPlanMode is true, every one of those DB writes is skipped
//     (one guard added at each write site) — so the edits live only in memory.
//   • renderSchedWeek() then CAPTURES the difference (globals vs the live copy
//     kept in kplLive/kplStaff) into the draft stores and saves them.
//   • "Bring live" reuses the proven publish/undo (kplOpenPublish/kplDoPublish/
//     kplRevert) to write only the ticked weeks and snapshot for undo.
// ════════════════════════════════════════════════════════════════════════
var schedPlanMode = false;              // true only while the Roster tool is open
var SCHED_PLAN_LS = 'kitchenRosterDraftV2';
// ── Keeping the plan on this device and the live schedule saying the same thing ──
// The plan holds only the cells that DIFFER from live. Each planned cell now remembers
// the live value it was planned ON TOP OF (its "base"). If live later moves under that
// cell — someone edited the real schedule directly — the live change wins and the cell
// drops out of the plan, so both read the same. A cell whose live value has NOT moved is
// left completely alone, so planning weeks ahead of an empty rota still works as before.
var kplDraftBase = {};   // draft key -> schedPlanSig(live) at the moment the cell was planned

// ── Section (add / rename / reorder / delete) held in the plan until Bring live ──
var kplSecLive   = null;   // snapshot of the live section list [{key,label}] (baseline)
var kplSecRename = {};      // liveKey -> new label (a rename you haven't brought live)
var kplSecNew    = [];      // [{key,label}] brand-new sections added in the plan
var kplSecOrder  = [];      // desired order of section keys (empty = default). Deleted keys are simply absent.
// What section changes are in the plan (used by the counter, publish and the confirm text).
function schedPlanSectionDiff(){
  var live = (kplSecLive||[]);
  var liveKeys = live.map(function(s){ return s.key; });
  var defaultOrder = liveKeys.concat((kplSecNew||[]).map(function(s){ return s.key; }));
  var order = (kplSecOrder && kplSecOrder.length) ? kplSecOrder.slice() : defaultOrder;
  var deletes = liveKeys.filter(function(k){ return order.indexOf(k) < 0; });
  var orderChanged = order.join(',') !== defaultOrder.filter(function(k){ return order.indexOf(k) >= 0; }).join(',');
  var renames = Object.keys(kplSecRename||{});
  return { order:order, deletes:deletes, orderChanged:orderChanged, renames:renames, adds:(kplSecNew||[]),
           total: renames.length + (kplSecNew||[]).length + deletes.length + (orderChanged ? 1 : 0) };
}
// Make a stable, unique key for a new section from its name.
function krtSectionKey(label){
  var base = (label||'sec').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,24) || 'sec';
  var exists = function(kk){ return STATIONS_SCH.some(function(s){return s.key===kk;}) || (kplSecLive||[]).some(function(s){return s.key===kk;}); };
  var k = base, n = 2; while(exists(k)){ k = base+'_'+n; n++; }
  return k;
}
// Show the plan's sections (live list + renames + new + reorder − deletes) in the grid.
function schedPlanApplySections(){
  if(!kplSecLive) return;
  var liveByKey = {}; kplSecLive.forEach(function(s){ liveByKey[s.key]=s; });
  var newByKey  = {}; (kplSecNew||[]).forEach(function(s){ newByKey[s.key]=s; });
  var d = schedPlanSectionDiff();
  STATIONS_SCH.length = 0;
  d.order.forEach(function(key){
    if(!liveByKey[key] && !newByKey[key]) return;                 // gone (deleted) — skip
    var label = (kplSecRename[key]!=null) ? kplSecRename[key]
              : (newByKey[key] ? newByKey[key].label : liveByKey[key].label);
    STATIONS_SCH.push({ key:key, label:label });
    if(!SEC_COLOR[key]) SEC_COLOR[key] = '#8a7d70';
  });
}
// Put the section list back to exactly the live one (used when the tool closes).
function schedPlanRestoreLiveSections(){
  if(!kplSecLive) return;
  STATIONS_SCH.length = 0; kplSecLive.forEach(function(s){ STATIONS_SCH.push({ key:s.key, label:s.label }); });
}

function schedPlanWeeksCount(){ return (typeof krtWeeks !== 'undefined' && krtWeeks > 0) ? krtWeeks : 1; }

// A single canonical signature per cell, so an empty "working" cell and a blank
// cell count as the SAME (no false "changed" mark), and only real differences show.
function schedPlanSig(row){
  if(!row) return 'EMPTY';
  var st = row.status || 'working';
  if(st === 'working'){
    var s=formatTime(row.shift_start), e=formatTime(row.shift_end), s2=formatTime(row.shift_start2), e2=formatTime(row.shift_end2), n=(row.notes||''), o=(row.station_override||'');
    if(!s && !e && !s2 && !e2 && !n && !o) return 'EMPTY';
    return 'W|'+s+'|'+e+'|'+s2+'|'+e2+'|'+n+'|'+o;
  }
  return st + '|' + (row.notes||'');
}
function schedPlanEntry(row){
  return { status: row.status || 'working',
    shift_start: row.shift_start||null, shift_end: row.shift_end||null,
    shift_start2: row.shift_start2||null, shift_end2: row.shift_end2||null,
    station_override: row.station_override||null, notes: row.notes||null };
}
function schedPlanRowFromEntry(sid, ds, e){
  return Object.assign({ staff_id: sid, work_date: ds }, e);
}

// Save / load the draft on this device (survives closing the tool and reopening).
function schedPlanSaveDraft(){ krtScheduleCheckpoint(); schedPlanPersist(); }
function schedPlanPersist(){
  kplDirty = true;
  schedPlanSeedMissingBases();   // every planned cell records the live value it sits on
  try{
    localStorage.setItem(SCHED_PLAN_LS, JSON.stringify({
      entries: kplDraft, secMoves: kplDraftSec, order: kplDraftOrd,
      newStaff: kplNewStaff, newSeq: kplNewSeq, base: kplDraftBase,
      secRename: kplSecRename, secNew: kplSecNew, secOrder: kplSecOrder, updatedAt: new Date().toISOString()
    }));
  }catch(e){ console.warn('plan draft save failed', e); }
  schedPlanUpdateBadge();
}

// ── Comprehensive Excel-style undo for the Roster PLANNING tool ───────────────
// The tool is the sched grid in plan mode; every draft change — cell edit, paste,
// paint, fill, week copy/paste/clear, section add/rename/delete/move, add/move/
// remove person — funnels through schedPlanSaveDraft. So we snapshot the WHOLE
// draft there (coalesced to ONE step per action via a next-tick checkpoint) and
// undo restores it. Draft-only: nothing here touches the live DB (that's Bring
// live). This supersedes the per-path sched undo while the tool is open.
var krtUndoStack = [];      // [{label, state}] newest last
var krtUndoBase  = null;    // JSON snapshot as of the last checkpoint
var krtUndoPending = false;
var krtNextLabel = null;    // optional friendly label for the next checkpoint
function krtStateSnap(){
  return JSON.stringify({
    d:kplDraft||{}, sec:kplDraftSec||{}, ord:kplDraftOrd||{},
    ns:kplNewStaff||[], nseq:kplNewSeq||0,
    sr:kplSecRename||{}, sn:kplSecNew||[], so:kplSecOrder||[]
  });
}
function krtUndoReset(){ krtUndoStack=[]; krtUndoBase=krtStateSnap(); krtNextLabel=null; krtUndoPending=false; krtRenderUndoBtn(); }
function krtUndoCheckpoint(){
  var cur = krtStateSnap();
  if(krtUndoBase===null){ krtUndoBase=cur; krtNextLabel=null; return; }
  if(cur!==krtUndoBase){
    krtUndoStack.push({ label: krtNextLabel||'change', state: krtUndoBase });
    if(krtUndoStack.length>60) krtUndoStack.shift();
    krtUndoBase = cur;
  }
  krtNextLabel = null;
  krtRenderUndoBtn();
}
// Coalesce every synchronous save in one user action (e.g. Fill week = 7 writes)
// into a single undo step by deferring the checkpoint to the next tick.
function krtScheduleCheckpoint(){ if(krtUndoPending) return; krtUndoPending=true; setTimeout(function(){ krtUndoPending=false; krtUndoCheckpoint(); }, 0); }
function krtUndoLast(){
  if(!krtUndoStack.length) return;
  var u = krtUndoStack.pop();
  var s; try{ s=JSON.parse(u.state); }catch(e){ return; }
  kplDraft=s.d||{}; kplDraftSec=s.sec||{}; kplDraftOrd=s.ord||{};
  kplNewStaff=s.ns||[]; kplNewSeq=s.nseq||0;
  kplSecRename=s.sr||{}; kplSecNew=s.sn||[]; kplSecOrder=s.so||[];
  krtUndoBase = u.state;                 // baseline is now the restored state
  schedPlanPersist();                    // persist WITHOUT re-checkpointing
  if(typeof schedPlanApplySections==='function') schedPlanApplySections();
  schedPlanOverlay(); krtRender(); schedPlanUpdateBadge();
  krtRenderUndoBtn();
}
// Excel-style: the Undo button lives permanently in the tool's top bar (part of
// KRT_SHELL). It's always visible while planning — enabled with the last action in
// its tooltip when there's something to undo, greyed/disabled when there isn't.
function krtRenderUndoBtn(){
  var btn = document.getElementById('krt-undo-btn');
  if(!btn) return;
  var has = schedPlanMode && krtUndoStack.length>0;
  btn.disabled = !has;
  if(has){
    var last = krtUndoStack[krtUndoStack.length-1];
    btn.title = 'Undo: '+last.label+(krtUndoStack.length>1?('  ('+krtUndoStack.length+' changes can be undone)'):'');
    btn.innerHTML = '&#8630; Undo'+(krtUndoStack.length>1?(' ('+krtUndoStack.length+')'):'');
  } else {
    btn.title = 'Nothing to undo yet';
    btn.innerHTML = '&#8630; Undo';
  }
}
function schedPlanLoadDraft(){ try{ return JSON.parse(localStorage.getItem(SCHED_PLAN_LS)||'null'); }catch(e){ return null; } }

// Take a clean copy of the live roster/team as the "before" the draft sits on top of.
function schedPlanSnapshotLive(){
  kplLive = {}; Object.keys(schedRoster).forEach(function(k){ kplLive[k] = Object.assign({}, schedRoster[k]); });
  kplStaff = schedStaff.map(function(s){ return Object.assign({}, s); });
}
// Paint the draft on top of the freshly loaded live data so the grid shows the plan.
function schedPlanOverlay(){
  schedStaff = kplStaff.map(function(s){ return Object.assign({}, s); });
  var byId = {}; schedStaff.forEach(function(s){ byId[s.id] = s; });
  (kplNewStaff||[]).forEach(function(np){ if(!byId[np.id]){ var c = Object.assign({}, np); schedStaff.push(c); byId[np.id] = c; } });
  Object.keys(kplDraftSec||{}).forEach(function(id){ if(byId[id]) byId[id].station_key = kplDraftSec[id]; });
  Object.keys(kplDraftOrd||{}).forEach(function(id){ if(byId[id]) byId[id].sort_order = kplDraftOrd[id]; });
  schedStaff.sort(function(a,b){ return ((a.sort_order==null?9999:a.sort_order) - (b.sort_order==null?9999:b.sort_order)); });
  schedRoster = {}; Object.keys(kplLive).forEach(function(k){ schedRoster[k] = Object.assign({}, kplLive[k]); });
  Object.keys(kplDraft||{}).forEach(function(k){ var p = k.split('|'); schedRoster[k] = schedPlanRowFromEntry(p[0], p[1], kplDraft[k]); });
}
// After loading live for a new week/range, keep the draft and re-apply it.
function schedPlanReseedFromLive(){
  schedPlanSnapshotLive();
  schedPlanSeedMissingBases();                     // a plan saved before this change gets its baseline here
  var moved = schedPlanAdoptLiveChanges();         // live edits made since you planned come in
  schedPlanApplySections();
  schedPlanOverlay();
  if(moved.length){ schedPlanPersist(); schedPlanLiveNote(moved); }
}
// Give every planned cell a baseline, and forget baselines for cells no longer planned.
// A cell with no baseline is never adopted — we do not guess what live used to say.
function schedPlanSeedMissingBases(){
  Object.keys(kplDraft||{}).forEach(function(k){
    if(kplDraftBase[k] === undefined) kplDraftBase[k] = schedPlanSig(kplLive[k] || null);
  });
  Object.keys(kplDraftBase).forEach(function(k){ if(!(kplDraft||{})[k]) delete kplDraftBase[k]; });
}
// The live schedule moved under a planned cell → the live value wins and the cell leaves
// the plan, so the plan on this device and the live schedule always match. Returns the
// cells a person would notice changing, so we can say so out loud.
function schedPlanAdoptLiveChanges(){
  var moved = [];
  Object.keys(kplDraft||{}).forEach(function(k){
    var base = kplDraftBase[k];
    if(base === undefined) return;                       // no baseline — leave it exactly as it is
    var now = schedPlanSig(kplLive[k] || null);
    if(now === base) return;                             // live has not moved under this cell
    var planned = schedPlanSig(kplDraft[k]);
    delete kplDraft[k]; delete kplDraftBase[k];          // live wins
    if(now !== planned) moved.push(k);                   // live catching up with the plan is not news
  });
  return moved;
}
// Say what came in, by name and day — never change someone's plan silently.
function schedPlanLiveNote(keys){
  var host = document.getElementById('kpl-full'); if(!host || !keys || !keys.length) return;
  var note = document.getElementById('krt-livenote');
  if(!note){
    note = document.createElement('div');
    note.id = 'krt-livenote';
    note.style.cssText = 'margin:8px 18px 0;padding:9px 12px;border-radius:8px;background:#fdf3d9;'
      + 'border:1px solid #d9b95f;color:#4a3906;font-size:13px;line-height:1.55;display:flex;gap:10px;align-items:flex-start';
    var grid = host.querySelector('.krt-grid-wrap');
    if(grid && grid.parentElement) grid.parentElement.insertBefore(note, grid); else host.appendChild(note);
  }
  var byId = {}; (kplStaff||[]).concat(kplNewStaff||[]).forEach(function(s){ byId[s.id] = s; });
  var bits = keys.slice(0,6).map(function(k){
    var p = k.split('|'), who = (byId[p[0]] && byId[p[0]].name) || 'Someone';
    var d = new Date(p[1] + 'T12:00:00');
    return who + ' ' + d.toLocaleDateString('en-GB', {weekday:'short', day:'numeric', month:'short'});
  });
  if(keys.length > 6) bits.push('and ' + (keys.length - 6) + ' more');
  note.innerHTML = '<span>Taken from the live schedule so your plan matches it: <b>' + bits.join('</b>, <b>')
    + '</b>. Change them here if you want them different.</span>'
    + '<button type="button" title="Hide this" onclick="var n=document.getElementById(\'krt-livenote\'); if(n&&n.parentElement) n.parentElement.removeChild(n);"'
    + ' style="margin-left:auto;background:none;border:0;font-size:17px;line-height:1;cursor:pointer;color:#4a3906;padding:0 2px">&times;</button>';
}

// ── Watch the live schedule while the tool is open ─────────────────────────
// So a change made on the real schedule (another tab, another device, the phone in the
// kitchen) reaches this plan on its own, instead of waiting for the next week change.
var krtLiveTimer = null, krtLiveBusy = false;
var KRT_LIVE_POLL_MS = 45000;
function schedPlanRosterSig(map){
  var ks = Object.keys(map||{}); ks.sort();
  var out = [];
  for(var i=0;i<ks.length;i++){ var s = schedPlanSig(map[ks[i]]); if(s !== 'EMPTY') out.push(ks[i] + ':' + s); }
  return out.join(';');
}
// Never pull the grid out from under someone mid-action.
function krtLiveBlocked(){
  if(!schedPlanMode) return true;
  if(document.hidden) return true;
  var m = document.getElementById('sch-modal-box'); if(m && m.offsetParent !== null) return true;
  var host = document.getElementById('kpl-modalhost'); if(host && host.innerHTML.trim()) return true;
  if(typeof krtWeekClip !== 'undefined' && krtWeekClip) return true;
  return false;
}
function krtLiveRefresh(){
  if(krtLiveBusy || krtLiveBlocked()) return;
  krtLiveBusy = true;
  var before = schedPlanRosterSig(kplLive);
  Promise.resolve().then(krtLoad).then(function(){
    if(schedPlanRosterSig(schedRoster) === before){
      schedPlanSnapshotLive(); schedPlanOverlay();          // nothing moved — re-apply, don't repaint
      return;
    }
    var sc = document.querySelector('#kpl-full .krt-grid-wrap');
    var top = sc ? sc.scrollTop : 0, left = sc ? sc.scrollLeft : 0;
    krtAfterLoad();                                          // reseed (adopts) + render
    if(sc){ sc.scrollTop = top; sc.scrollLeft = left; }      // stay where they were reading
  }).catch(function(e){
    console.warn('[Roster tool] live check skipped', (e && e.message) || e);   // offline → try again next tick
  }).then(function(){ krtLiveBusy = false; });
}
function krtLiveWatchStart(){
  krtLiveWatchStop();
  krtLiveTimer = setInterval(krtLiveRefresh, KRT_LIVE_POLL_MS);
  window.addEventListener('focus', krtLiveRefresh);
  document.addEventListener('visibilitychange', krtLiveRefresh);
}
function krtLiveWatchStop(){
  if(krtLiveTimer){ clearInterval(krtLiveTimer); krtLiveTimer = null; }
  window.removeEventListener('focus', krtLiveRefresh);
  document.removeEventListener('visibilitychange', krtLiveRefresh);
}

// Rebuild the draft from what's on screen vs the live copy. Only touches the
// dates currently loaded, so edits made on weeks you've navigated away from stay.
function schedPlanCapture(){
  var liveById = {}; kplStaff.forEach(function(s){ liveById[s.id] = s; });
  var newStaff = [], secMoves = {}, order = {};
  schedStaff.forEach(function(s){
    var live = liveById[s.id];
    if(!live){ newStaff.push({ id:s.id, name:s.name, designation:s.designation, station_key:s.station_key, sort_order:s.sort_order, _new:true }); return; }
    if(s.station_key !== live.station_key) secMoves[s.id] = s.station_key;
    var so = (s.sort_order==null?null:s.sort_order), lso = (live.sort_order==null?null:live.sort_order);
    if(so !== lso && so != null) order[s.id] = s.sort_order;
  });
  kplNewStaff = newStaff; kplDraftSec = secMoves; kplDraftOrd = order;
  // roster diffs, windowed to the loaded span
  var winStart = addDays(schedWeekStart, -7);
  var winDays  = schedPlanWeeksCount()*7 + 14;
  for(var i=0;i<schedStaff.length;i++){
    var sid = schedStaff[i].id;
    for(var d=0; d<winDays; d++){
      var ds = formatDate(addDays(winStart, d)), k = schedRosterKey(sid, ds);
      if(schedPlanSig(schedRoster[k]) !== schedPlanSig(kplLive[k])) kplDraft[k] = schedPlanEntry(schedRoster[k] || {});
      else if(kplDraft[k]) delete kplDraft[k];
    }
  }
  schedPlanSaveDraft();
}
function schedPlanCountChanges(){
  return Object.keys(kplDraft||{}).length + (kplNewStaff||[]).length +
         Object.keys(kplDraftSec||{}).length + Object.keys(kplDraftOrd||{}).length +
         schedPlanSectionDiff().total;
}
function schedPlanUpdateBadge(){
  var n = schedPlanCountChanges();
  var chip = document.getElementById('krt-changecount');
  if(chip){ chip.textContent = n ? (n + ' change' + (n>1?'s':'') + ' not live') : 'No changes yet'; }
  var btn = document.getElementById('krt-bringlive'); if(btn){ btn.style.opacity = n ? '1' : '.5'; }
}

// Turn on the sandbox when the tool opens: load any saved draft, then show live+draft.
function schedPlanEnter(){
  schedPlanMode = true;
  kplMode = 'draft';
  var saved = schedPlanLoadDraft();
  kplDraft    = (saved && saved.entries)  || {};
  kplDraftBase = (saved && saved.base)    || {};
  kplDraftSec = (saved && saved.secMoves) || {};
  kplDraftOrd = (saved && saved.order)    || {};
  kplNewStaff = (saved && saved.newStaff) || [];
  kplNewSeq   = (saved && saved.newSeq)   || 0;
  kplSecRename = (saved && saved.secRename) || {};
  kplSecNew    = (saved && saved.secNew)    || [];
  kplSecOrder  = (saved && saved.secOrder)  || [];
  kplSecLive   = STATIONS_SCH.map(function(s){ return { key:s.key, label:s.label }; });  // live baseline
  schedPlanReseedFromLive();
  schedPlanUpdateBadge();
  // The undo stack is shared with the live schedule; start the planning session clean so a
  // live-schedule edit can never be "undone" into the draft. Cleared again on close (krtClose).
  schedUndoStack = []; if (typeof schedRenderUndoBtn === 'function') schedRenderUndoBtn();
  krtUndoReset();   // comprehensive draft undo — fresh baseline for this planning session
  krtLiveWatchStart();   // from here on, a live edit reaches this plan on its own
}
// ── Sections manager (in the tool): rename, add, reorder (▲▼), delete — held in the plan ──
function krtSectionRowHtml(key, label, isNew){
  return '<div class="krt-sec-row" data-key="'+String(key||'')+'">' +
    '<span class="krt-sec-move"><button type="button" onclick="krtSecMove(this,-1)" title="Move up">&#9650;</button>' +
    '<button type="button" onclick="krtSecMove(this,1)" title="Move down">&#9660;</button></span>' +
    '<input type="text" class="krt-sec-inp" value="'+String(label||'').replace(/"/g,'&quot;')+'"'+(label?'':' placeholder="New section name (e.g. Grill)"')+' />' +
    (isNew ? '<span class="krt-sec-tag">new</span>' : '') +
    '<button type="button" class="krt-sec-del" onclick="krtSecDelete(this)" title="Delete this section">&times;</button>' +
    '</div>';
}
function krtOpenSections(){
  if(typeof krtCloseActions === 'function') krtCloseActions();
  var rows = STATIONS_SCH.map(function(s){
    return krtSectionRowHtml(s.key, s.label, kplSecNew.some(function(n){ return n.key===s.key; }));
  }).join('');
  document.getElementById('kpl-modalhost').innerHTML =
    '<div class="kpl-ov" onclick="krtCloseModal(event)"><div class="kpl-modal" onclick="event.stopPropagation()">'
    + '<h3>Sections</h3>'
    + '<div style="font-size:12px;color:var(--vino-light);margin-bottom:12px">Type over a name to rename it, use <b>&#9650;&#9660;</b> to reorder, <b>&times;</b> to delete, or add a new one below. Nothing changes on the real schedule until you press <b>Bring live</b>.</div>'
    + '<div id="krt-sec-list">'+rows+'</div>'
    + '<button class="kpl-btn" onclick="krtAddSectionRow()" style="margin-top:10px">+ Add a section</button>'
    + '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px"><button class="kpl-btn" onclick="krtCloseModal()">Cancel</button><button class="kpl-btn primary" onclick="krtSaveSections()">Save to plan</button></div>'
    + '</div></div>';
}
function krtAddSectionRow(){
  var list = document.getElementById('krt-sec-list'); if(!list) return;
  list.insertAdjacentHTML('beforeend', krtSectionRowHtml('', '', true));
  var inp = list.lastElementChild.querySelector('input'); if(inp) inp.focus();
}
function krtSecMove(btn, dir){
  var row = btn.closest('.krt-sec-row'); if(!row) return; var list = row.parentElement;
  if(dir < 0 && row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
  else if(dir > 0 && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
}
function krtSecDelete(btn){
  var row = btn.closest('.krt-sec-row'); if(!row) return;
  var key = row.getAttribute('data-key');
  var name = (row.querySelector('input').value || '').trim() || 'this section';
  // Don't orphan people — a section with anyone in it must be emptied first.
  var count = key ? schedStaff.filter(function(s){ return s.station_key === key; }).length : 0;
  if(count > 0){ alert('“'+name+'” has '+count+' '+(count===1?'person':'people')+' in it.\n\nMove them to another section first (the ↔ Move button on each person), then you can delete it.'); return; }
  if(key && !confirm('Delete the section “'+name+'”? It goes when you press Bring live — and you can still undo it.')) return;
  row.parentElement.removeChild(row);
}
function krtSaveSections(){
  var liveByKey = {}; (kplSecLive||[]).forEach(function(s){ liveByKey[s.key]=s; });
  var prevNewByKey = {}; (kplSecNew||[]).forEach(function(n){ prevNewByKey[n.key]=n; });
  var rename = {}, adds = [], order = [];
  Array.prototype.forEach.call(document.querySelectorAll('#krt-sec-list .krt-sec-row'), function(r){
    var key = r.getAttribute('data-key');
    var label = (r.querySelector('input').value || '').trim();
    if(!label) return;                                   // blank row = skip
    if(key && liveByKey[key]){                            // existing live section
      if(label !== liveByKey[key].label) rename[key] = label;
      order.push(key);
    } else {                                              // a new section (added this plan)
      var k = key || krtSectionKey(label);
      adds.push({ key:k, label:label });
      order.push(k);
    }
  });
  kplSecRename = rename; kplSecNew = adds; kplSecOrder = order;
  schedPlanApplySections();
  schedPlanSaveDraft();
  renderSchedWeek();
  krtCloseModal();
}

// ── Copy a whole week → paste into another, right on the week header (several-weeks view) ──
var krtWeekClip = null;   // Monday ISO of the week you've copied, ready to paste
function krtWeekCopy(mon){ krtWeekClip = mon; krtRender(); }
function krtWeekCancelCopy(){ krtWeekClip = null; krtRender(); }
// The Copy / Paste / Clear tabs for ONE week — used by BOTH the one-week bar and the
// several-weeks header so they can never drift apart.
function krtWeekTabsHtml(wmon){
  var tab;
  if(!krtWeekClip){ tab = '<button class="krt-wk-btn" onclick="krtWeekCopy(\''+wmon+'\')" title="Copy this whole week">Copy</button>'; }
  else if(krtWeekClip === wmon){ tab = '<span class="krt-wk-copied">Copied</span><button class="krt-wk-btn" onclick="krtWeekCancelCopy()">Cancel</button>'; }
  else { tab = '<button class="krt-wk-btn paste" onclick="krtWeekPaste(\''+wmon+'\')" title="Replace this week with the copied one">Paste here</button>'; }
  tab += '<button class="krt-wk-btn clear" onclick="krtClearWeek(\''+wmon+'\')" title="Clear this week — remove all shifts, keep the names">Clear</button>';
  return tab;
}
function krtWeekPaste(tgtMon){
  if(!krtWeekClip || krtWeekClip === tgtMon) return;
  var srcMon = getMonday(new Date(krtWeekClip + 'T12:00:00'));
  var tMon   = getMonday(new Date(tgtMon      + 'T12:00:00'));
  var srcLabel = srcMon.toLocaleDateString('en-GB',{day:'numeric',month:'short'});
  var tLabel   = tMon.toLocaleDateString('en-GB',{day:'numeric',month:'short'});
  if(!confirm('Paste the week of '+srcLabel+' into the week of '+tLabel+'?\n\nIt replaces that week in your plan. (Nothing goes live until you Bring live.)')) return;
  for(var d=0; d<7; d++){
    var sds = formatDate(addDays(srcMon, d)), tds = formatDate(addDays(tMon, d));
    schedStaff.forEach(function(s){
      var sk = schedRosterKey(s.id, sds), tk = schedRosterKey(s.id, tds);
      var src = schedRoster[sk] || null;   // effective plan for the source week (live + your draft)
      var e = src ? { status:src.status||'working', shift_start:src.shift_start||null, shift_end:src.shift_end||null,
                      shift_start2:src.shift_start2||null, shift_end2:src.shift_end2||null, notes:src.notes||null }
                  : { status:'working', shift_start:null, shift_end:null, shift_start2:null, shift_end2:null, notes:null };
      if(schedPlanSig(e) !== schedPlanSig(kplLive[tk] || null)){ kplDraft[tk] = e; }
      else if(kplDraft[tk]){ delete kplDraft[tk]; }
    });
  }
  krtWeekClip = null;
  krtNextLabel = 'paste week of '+srcLabel+' → '+tLabel;
  schedPlanSaveDraft(); schedPlanApplySections(); schedPlanOverlay(); krtRender(); schedPlanUpdateBadge();
}
// Clear a whole week back to empty — names stay, every shift removed. Draft only.
function krtClearWeek(mon){
  if(typeof krtCloseActions === 'function') krtCloseActions();
  var m = getMonday(new Date(mon + 'T12:00:00'));
  var mLabel = m.toLocaleDateString('en-GB',{day:'numeric',month:'short'});
  if(!confirm('Clear the whole week of '+mLabel+'?\n\nEvery shift that week is removed — the names stay, but the week is empty. This is in your plan; nothing goes live until Bring live, and you can undo.')) return;
  for(var d=0; d<7; d++){
    var ds = formatDate(addDays(m, d));
    schedStaff.forEach(function(s){
      var k = schedRosterKey(s.id, ds);
      if(schedPlanSig(kplLive[k] || null) !== 'EMPTY'){ kplDraft[k] = { status:'working', shift_start:null, shift_end:null, shift_start2:null, shift_end2:null, notes:null }; }
      else if(kplDraft[k]){ delete kplDraft[k]; }
    });
  }
  krtWeekClip = null;
  krtNextLabel = 'clear week '+mLabel;
  schedPlanSaveDraft(); schedPlanApplySections(); schedPlanOverlay(); krtRender(); schedPlanUpdateBadge();
}

// "Bring live" — reuse the proven publish dialog (week checkboxes + undo).
function schedPlanOpenPublish(){
  if(typeof krtCloseActions === 'function') krtCloseActions();
  if(!schedPlanCountChanges()){ alert('There are no changes to bring live yet.\n\nPlan some shifts first — set times, days off, teams — then press Bring live.'); return; }
  kplMode = 'draft';
  kplFrom = schedWeekStart;
  kplNumWeeks = schedPlanWeeksCount();
  kplOpenPublish();
}
// After a publish or undo, reload clean live and re-derive the draft (published
// weeks now match live, so their "changed" marks clear on their own).
async function schedPlanAfterWrite(){
  await loadSchedSections();                 // pick up any section add/rename that just went live
  if(schedPlanWeeksCount() > 1){ await krtLoadRange(schedPlanWeeksCount()); } else { await loadSchedData(); }
  kplSecLive = STATIONS_SCH.map(function(s){ return { key:s.key, label:s.label }; });   // new live baseline
  kplSecRename = {}; kplSecNew = []; kplSecOrder = [];   // section draft is now live
  schedPlanSnapshotLive();
  schedPlanApplySections();
  schedPlanOverlay();
  schedPlanCapture();
  if(typeof krtRender === 'function') krtRender();
  schedPlanUpdateBadge();
}
function kplOpen(){
  var sview = document.getElementById('scheduling-view'); if(sview) sview.style.display = 'none';
  var fb = document.querySelector('.footer-bar'); if(fb) fb.style.display='none';
  // Empty the (hidden) live grid while the tool is open — its stale HTML carries the
  // same element ids (add-staff panels/inputs), so getElementById would hit the hidden
  // copy and the tool's own panels would never open. Re-rendered on close.
  var lgrid = document.getElementById('sch-grid-wrap'); if(lgrid) lgrid.innerHTML = '';
  // grid emptied → nothing to scroll, so drop the fade/hint that sit over it
  if(typeof schedScrollAffordance === 'function') schedScrollAffordance();
  if(!schedWeekStart) schedWeekStart = getMonday(new Date());
  var el = document.getElementById('kpl-full');
  if(!el){
    el = document.createElement('div');
    el.id = 'kpl-full';
    el.style.cssText = 'position:fixed;inset:0;z-index:4000;display:flex;flex-direction:column;background:var(--cream);overflow:hidden';
    el.innerHTML = KRT_SHELL();
    document.body.appendChild(el);
    document.addEventListener('click', function(e){ var m=document.getElementById('krt-actmenu'); if(m&&m.classList.contains('open')&&!(e.target.closest&&e.target.closest('.krt-act-wrap'))) m.classList.remove('open'); });
  } else { el.style.display='flex'; }
  document.getElementById('krt-grid').innerHTML = '<div style="padding:40px;text-align:center;color:var(--vino-light);font-style:italic">Loading the schedule…</div>';
  krtRender();
  loadShiftPresets();
  loadSchedSections().then(loadSchedData).then(function(){ schedPlanEnter(); krtRender(); });
}
function krtWeekLabel(){
  var e = addDays(schedWeekStart,6);
  return schedWeekStart.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}) + ' – ' + e.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric'});
}
function krtRender(){
  var lbl = document.getElementById('krt-weeklabel'); if(lbl) lbl.textContent = krtWeekLabel();
  var s1=document.getElementById('krt-seg-1'), sn=document.getElementById('krt-seg-n');
  if(s1&&sn){ s1.classList.toggle('on', krtWeeks===1); sn.classList.toggle('on', krtWeeks>1); }
  var step=document.getElementById('krt-stepper'); if(step) step.style.display = krtWeeks>1 ? 'inline-flex' : 'none';
  var wrap = document.getElementById('krt-grid'); if(!wrap) return;
  if(krtWeeks===1){
    var ws1=schedWeekStart, we1=addDays(ws1,6);
    var lbl1='Week of '+ws1.toLocaleDateString('en-GB',{day:'numeric',month:'short'})+' &ndash; '+we1.toLocaleDateString('en-GB',{day:'numeric',month:'short'});
    var bar='<div class="krt-oneweek-bar"><span>'+lbl1+'</span><span class="krt-wk-actions">'+krtWeekTabsHtml(formatDate(ws1))+'</span></div>';
    wrap.innerHTML = bar + schedWeekTableHtml(schedWeekStart, {controls:true});   // the exact same grid the team uses, with the week bar on top
    return;
  }
  // Several weeks side by side — one grid, weeks flow left→right (fully interactive).
  wrap.innerHTML = schedMultiWeekTableHtml(schedWeekStart, krtWeeks);
}
function krtBusy(){ document.getElementById('krt-grid').innerHTML='<div style="padding:36px;text-align:center;color:var(--vino-light);font-style:italic">Loading…</div>'; }
function krtLoad(){ return krtWeeks>1 ? krtLoadRange(krtWeeks) : loadSchedData(); }
async function krtLoadRange(numWeeks){
  var from = formatDate(addDays(schedWeekStart,-7));
  var to   = formatDate(addDays(schedWeekStart, numWeeks*7+6));
  var res = await Promise.all([
    sb.from('staff').select('*').eq('active',true).order('sort_order'),
    sb.from('roster').select('*').gte('work_date',from).lte('work_date',to).limit(8000),
    sb.from('sched_events').select('*').gte('event_date',from).lte('event_date',to).limit(3000)
  ]);
  schedStaff = (res[0].data||[]).filter(function(s){ return s.in_schedule!==false; });
  schedRoster = {}; (res[1].data||[]).forEach(function(r){ schedRoster[schedRosterKey(r.staff_id, String(r.work_date).slice(0,10))]=r; });
  schedEvents = {}; if(res[2] && !res[2].error){ (res[2].data||[]).forEach(function(e){ var d=String(e.event_date).slice(0,10); (schedEvents[d]=schedEvents[d]||[]).push({slot:e.slot||1,name:e.name}); }); }
}
// After (re)loading live for a week/range: in planning mode keep the draft on top.
function krtAfterLoad(){ if(schedPlanMode) schedPlanReseedFromLive(); krtRender(); schedPlanUpdateBadge(); }
function krtSetWeeks(n){ n=parseInt(n,10)||1; krtWeeks=n; if(n>1) krtSpanN=n; krtBusy(); krtLoad().then(krtAfterLoad); }
function krtShift(n){ schedWeekStart = addDays(schedWeekStart, n*7); krtBusy(); krtLoad().then(krtAfterLoad); }
function krtToday(){ schedWeekStart = getMonday(new Date()); krtBusy(); krtLoad().then(krtAfterLoad); }
// Read-only coverage check across the weeks on screen — flags any section that has
// NOBODY on duty on a given day. Nothing else, nothing changes.
function krtCoverage(){
  var weeks = krtWeeks<1?1:krtWeeks;
  var holes=[];
  var isWorking=function(sid, ds){ var r=schedRoster[schedRosterKey(sid,ds)]; return r && r.status==='working' && r.shift_start && r.shift_end; };
  for(var w=0; w<weeks; w++){
    for(var d=0; d<7; d++){
      var day=addDays(schedWeekStart, w*7+d), ds=formatDate(day);
      // Closed day? If nobody is working anywhere in the kitchen, treat it as closed and
      // skip it — no point flagging every section as empty when we're simply not open.
      var kitchenOpen=schedStaff.some(function(s){ return isWorking(s.id, ds); });
      if(!kitchenOpen) continue;
      STATIONS_SCH.forEach(function(st){
        var people=schedStaff.filter(function(s){ return s.station_key===st.key; });
        var working=people.filter(function(s){ return isWorking(s.id, ds); });
        if(people.length && working.length===0) holes.push({sec:st.label, day:day});
      });
    }
  }
  function dfmt(dt){ return dt.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}); }
  var body = !holes.length
    ? '<div style="background:#eef3ec;border:1px solid #a9d8bf;border-radius:8px;padding:10px 12px;color:#0f5132">Every section has someone on duty every day.</div>'
    : '<div class="kpl-lbl" style="margin-bottom:5px">Sections with nobody on duty</div><ul style="margin:0;padding-left:18px;font-size:13px;color:#a8342a">'
        + holes.slice(0,14).map(function(h){ return '<li>'+h.sec+' — '+dfmt(h.day)+'</li>'; }).join('')
        + (holes.length>14?'<li>…and '+(holes.length-14)+' more</li>':'') + '</ul>';
  document.getElementById('kpl-modalhost').innerHTML =
    '<div class="kpl-ov" onclick="krtCloseModal(event)"><div class="kpl-modal" onclick="event.stopPropagation()">'
    + '<h3>Coverage — '+(weeks===1?'this week':weeks+' weeks')+'</h3>'
    + '<div style="font-size:12px;color:var(--vino-light);margin-bottom:12px">A quick read of the weeks on screen. Nothing changes — this just points out gaps.</div>'
    + body
    + '<div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="kpl-btn primary" onclick="krtCloseModal()">Close</button></div>'
    + '</div></div>';
}
function krtCloseModal(ev){ if(ev && ev.target && !ev.target.classList.contains('kpl-ov')) return; document.getElementById('kpl-modalhost').innerHTML=''; }

// ── One-tap planning helpers (write LIVE, always after a clear confirm — Francesco's choice) ──
function krtWeekDates(weekStart){ var a=[]; for(var d=0;d<7;d++) a.push(formatDate(addDays(weekStart,d))); return a; }
function krtSectionPeople(stKey){ return schedStaff.filter(function(s){ return s.station_key===stKey; })
  .sort(function(a,b){ return ((a.sort_order==null?9999:a.sort_order)-(b.sort_order==null?9999:b.sort_order)) || (a.name||'').localeCompare(b.name||''); }); }
function krtRosterPayload(sid, ds, status, s1, e1, s2, e2){
  var working = status==='working';
  return { staff_id:sid, work_date:ds, status:status,
    shift_start:working?(s1||null):null, shift_end:working?(e1||null):null,
    shift_start2:working?(s2||null):null, shift_end2:working?(e2||null):null,
    updated_at:new Date().toISOString() };
}
// Pure builders (no writes) — easy to reason about and to check.
function krtBuildFillTeams(weekStart){
  var dates=krtWeekDates(weekStart), payloads=[];
  STATIONS_SCH.forEach(function(st){
    krtSectionPeople(st.key).forEach(function(s, idx){
      dates.forEach(function(ds){
        if(idx===0) payloads.push(krtRosterPayload(s.id, ds, 'working','10:00','15:00','19:00','00:00'));  // lunch split
        else        payloads.push(krtRosterPayload(s.id, ds, 'working','15:00','03:00', null, null));       // dinner
      });
    });
  });
  return payloads;
}
// TOP UP each person to 2 days off — counting the days off / leave they ALREADY have
// that week, so it never stacks extra on someone who already has one. Only the quiet
// days (Mon/Tue/Wed/Sun) are used, never the busy nights (Thu–Sat), and only a plain
// working day is turned into a day off (an existing shift-swap/training day is left alone).
var KRT_DAYSOFF_TARGET = 2;   // max weekly days off per person
function krtBuildDaysOff(weekStart){
  var dates=krtWeekDates(weekStart), payloads=[];
  var DAYOFF=['off','wo'];                   // ONLY genuine days off count toward the 2 — annual leave / PH are separate, not counted
  var quiet=[0,1,2,6];                       // Mon, Tue, Wed, Sun (indexes) — never Thu(3)/Fri(4)/Sat(5)
  var gi=0;
  STATIONS_SCH.forEach(function(st){
    krtSectionPeople(st.key).forEach(function(s){
      var statusOn=function(di){ var r=schedRoster[schedRosterKey(s.id,dates[di])]; return (r&&r.status)||'working'; };
      var have=0; for(var d=0; d<7; d++){ if(DAYOFF.indexOf(statusOn(d))>=0) have++; }
      var need=KRT_DAYSOFF_TARGET - have;
      if(need<=0){ gi++; return; }            // already has 2 days off — add nothing
      // a day off can only replace a PLAIN WORKING quiet day — never a busy night, and never
      // an annual-leave / PH / sick day the chef has already put in.
      var eligible=quiet.filter(function(di){ return statusOn(di)==='working'; });
      var start=gi % (eligible.length||1);    // stagger which quiet days each person gets
      for(var k=0; k<eligible.length && need>0; k++){ payloads.push(krtRosterPayload(s.id, dates[eligible[(start+k)%eligible.length]], 'off')); need--; }
      gi++;
    });
  });
  return payloads;
}
// Give each person ONE full week off (Holiday), spread SECTION BY SECTION across the weeks
// on screen — within a section people go on different weeks, and sections are offset so no
// single week gets overloaded and no section is gutted in one week.
function krtBuildWeekOff(){
  var payloads=[];
  var groups=[], known={};
  STATIONS_SCH.forEach(function(st){ known[st.key]=1; groups.push(krtSectionPeople(st.key)); });
  var others=schedStaff.filter(function(s){ return !known[s.station_key]; })
    .sort(function(a,b){ return ((a.sort_order==null?9999:a.sort_order)-(b.sort_order==null?9999:b.sort_order)); });
  if(others.length) groups.push(others);
  groups.forEach(function(people, si){
    people.forEach(function(s, j){
      var wk=(j + si) % krtWeeks;                          // rotate within the section, offset per section
      var ws=addDays(schedWeekStart, wk*7);
      krtWeekDates(ws).forEach(function(ds){ payloads.push(krtRosterPayload(s.id, ds, 'al')); });
    });
  });
  return payloads;
}
async function krtWriteRoster(payloads){
  if(!payloads.length) return 0;
  payloads.forEach(function(p){ var k=schedRosterKey(p.staff_id,p.work_date); schedRoster[k]=Object.assign({}, schedRoster[k]||{}, p); });
  if(schedPlanMode){ schedPlanCapture(); krtRender(); return payloads.length; }   // planning: into the draft, not the live DB
  krtRender();
  if(!DEV_READ_ONLY){
    var res = await sb.from('roster').upsert(payloads,{onConflict:'staff_id,work_date'});
    if(res.error){ alert('Could not save: '+res.error.message+(String(res.error.message).indexOf('read-only')>=0?' (unlock the DEV badge on the dev site).':'')); return -1; }
  }
  return payloads.length;
}
async function krtFillTeams(){
  krtCloseActions();
  if(!schedStaff.length) return;
  if(!confirm('Set lunch & dinner teams for '+krtWeekLabel()+'?\n\nThis REPLACES everyone’s shifts that week — 1 person per section on the lunch split (10:00–15:00 / 19:00–00:00), the rest on dinner (15:00–03:00), for '+schedStaff.length+' people. Set days off afterwards with “Give everyone their days off”.')) return;
  await krtWriteRoster(krtBuildFillTeams(schedWeekStart));
}
async function krtGiveDaysOff(){
  krtCloseActions();
  if(!schedStaff.length) return;
  var payloads = krtBuildDaysOff(schedWeekStart);
  if(!payloads.length){ alert('Everyone already has their 2 days off in '+krtWeekLabel()+' — nothing to add.'); return; }
  if(!confirm('Top everyone up to 2 days off in '+krtWeekLabel()+'?\n\nOnly real days off count toward the 2 — annual leave and public holidays are left as they are. Anyone already on 2 gets nothing more. New days off land on the quiet days, never Thu–Sat. This adds '+payloads.length+' day(s) off across the team.')) return;
  await krtWriteRoster(payloads);
}
async function krtGiveWeekOff(){
  krtCloseActions();
  if(krtWeeks<2){ alert('Switch to “Several weeks” first — then everyone gets a staggered week off spread across those weeks.'); return; }
  if(!schedStaff.length) return;
  if(!confirm('Give everyone a staggered week off across the '+krtWeeks+' weeks on screen?\n\nEach person gets one full week marked as Holiday, spread section by section so no section is left short in the same week. This replaces those days for '+schedStaff.length+' people.')) return;
  await krtWriteRoster(krtBuildWeekOff());
}
function krtToggleActions(ev){
  if(ev) ev.stopPropagation();
  var m=document.getElementById('krt-actmenu'); if(!m) return;
  m.classList.toggle('open');
  // Keep the menu on screen: on a narrow view the button can sit near the left edge,
  // and a right-aligned menu would run off the left. Flip it left when that happens.
  if(m.classList.contains('open')){
    m.style.left=''; m.style.right='0';
    var r=m.getBoundingClientRect();
    if(r.left < 8){
      var wrap=m.parentElement.getBoundingClientRect();
      m.style.right='auto';
      m.style.left=(8 - wrap.left)+'px';
    }
  }
}
function krtCloseActions(){ var m=document.getElementById('krt-actmenu'); if(m) m.classList.remove('open'); }
function krtClose(){
  schedPlanMode = false;                 // back to live editing on the real schedule
  krtLiveWatchStop();                    // stop watching live — the tool is shut
  schedPlanRestoreLiveSections();        // drop any draft section add/rename from the live list
  // End the planning session cleanly: stop any paste-in-progress and drop the draft-only undo
  // history so it can't be replayed against the live DB once we're back on the real schedule.
  if (typeof schedEndPaste === 'function') schedEndPaste();
  schedUndoStack = [];
  krtUndoStack = []; krtUndoBase = null; if (typeof krtRenderUndoBtn === 'function') krtRenderUndoBtn();   // drop the draft undo history + hide its button
  var ln=document.getElementById('krt-livenote'); if(ln && ln.parentElement) ln.parentElement.removeChild(ln);
  var el=document.getElementById('kpl-full'); if(el) el.style.display='none';
  var sview=document.getElementById('scheduling-view'); if(sview) sview.style.display='flex';
  if (typeof schedRenderUndoBtn === 'function') schedRenderUndoBtn();
  var fb=document.querySelector('.footer-bar'); if(fb) fb.style.display='flex';
  // Reload the untouched live data so the real schedule never shows the draft.
  if(typeof loadSchedData==='function' && schedWeekStart) loadSchedData().then(renderSchedView);
  else if(typeof renderSchedView==='function') renderSchedView();
}
function KRT_SHELL(){
  return `
  <style>
  #kpl-full *{box-sizing:border-box}
  #kpl-full{font-family:var(--font-sans)}
  #kpl-full .krt-top{background:var(--vino);color:#f6ece0;display:flex;align-items:center;gap:16px;padding:11px 18px;flex-shrink:0;border-bottom:3px solid var(--sabbia);flex-wrap:wrap}
  #kpl-full .krt-back{background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.3);color:#f6ece0;padding:6px 12px;border-radius:7px;cursor:pointer;font-size:11px;letter-spacing:1px;text-transform:uppercase}
  #kpl-full .krt-brand{display:flex;flex-direction:column;line-height:1.05}
  #kpl-full .krt-brand .n{font-family:var(--font-serif);font-size:20px;letter-spacing:2px}
  #kpl-full .krt-brand .s{font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#d9c3ad;margin-top:2px}
  #kpl-full .krt-nav{display:flex;align-items:center;gap:8px}
  #kpl-full .krt-nav button{background:transparent;border:1px solid rgba(255,255,255,.28);color:#f6ece0;width:30px;height:30px;border-radius:7px;cursor:pointer;font-size:15px;line-height:1}
  #kpl-full .krt-nav button:hover{background:rgba(255,255,255,.12)}
  #kpl-full .krt-nav .today{width:auto;padding:0 10px;font-size:11px}
  #kpl-full .krt-lbl{font-family:var(--font-serif);font-size:15px;min-width:220px;text-align:center}
  #kpl-full .krt-seg{display:inline-flex;background:rgba(0,0,0,.16);border-radius:9px;padding:3px}
  #kpl-full .krt-seg button{background:transparent;border:0;color:#e7d3bf;padding:6px 13px;border-radius:7px;cursor:pointer;font-size:12.5px}
  #kpl-full .krt-seg button.on{background:var(--sabbia);color:var(--vino);font-weight:600}
  #kpl-full .krt-stepper{display:none;align-items:center;gap:6px;color:#e7d3bf;font-size:12px}
  #kpl-full .krt-stepper select{font-size:12.5px;padding:5px 7px;border:1px solid rgba(255,255,255,.3);border-radius:7px;color:var(--vino);background:var(--sabbia)}
  #kpl-full .krt-weekband{background:var(--vino);color:#f6ece0;font-family:var(--font-serif);font-size:15px;padding:8px 14px;border-radius:10px 10px 0 0;margin-top:20px;letter-spacing:.4px}
  #kpl-full .krt-weekband .sub{font-family:var(--font-sans);font-size:11px;color:#d9c3ad;letter-spacing:.3px;margin-left:8px;text-transform:none}
  #kpl-full .krt-act-wrap{position:relative}
  #kpl-full .krt-act-btn{background:var(--sabbia);color:var(--vino);border:0;border-radius:8px;padding:8px 15px;font-size:13.5px;font-weight:600;cursor:pointer}
  #kpl-full .krt-changed-chip{margin-left:auto;display:inline-flex;align-items:center;gap:7px;background:rgba(0,0,0,.16);color:#f6ece0;font-size:11.5px;padding:6px 11px;border-radius:20px;white-space:nowrap}
  #kpl-full .krt-changed-chip::before{content:'';width:8px;height:8px;border-radius:50%;background:var(--oro)}
  #kpl-full .krt-bring{background:var(--oro);color:#2a1a10;border:0;border-radius:8px;padding:9px 17px;font-size:13.5px;font-weight:700;cursor:pointer;letter-spacing:.3px}
  #kpl-full .krt-undo{background:#fff;color:var(--vino);border:1.5px solid #fff;border-radius:8px;padding:8px 14px;font-size:13.5px;font-weight:700;cursor:pointer;white-space:nowrap}
  #kpl-full .krt-undo:disabled{background:rgba(255,255,255,.5);color:rgba(65,2,7,.45);border-color:rgba(255,255,255,.55);cursor:default}
  #kpl-full .krt-bring:hover{filter:brightness(1.06)}
  #kpl-full .sch-plan-changed{position:relative}
  #kpl-full .sch-plan-changed .sch-shift{box-shadow:0 0 0 2px var(--oro)}
  #kpl-full .sch-plan-changed::after{content:'';position:absolute;top:3px;right:3px;width:9px;height:9px;background:var(--oro);border-radius:50%;border:2px solid var(--cream);z-index:2}
  #kpl-full .sch-plan-newbadge{font-size:9px;background:var(--vino);color:#f6ece0;padding:1px 6px;border-radius:10px;margin-left:6px;vertical-align:middle;letter-spacing:.5px}
  #kpl-full .sch-multi thead th{position:static}
  #kpl-full .sch-multi thead th.sch-th-name{position:sticky;left:0;z-index:6;min-width:190px}
  #kpl-full .sch-multi td.sch-td-name{z-index:3;min-width:190px;max-width:190px}
  #kpl-full .sch-multi .sch-events-label{z-index:3}
  #kpl-full .sch-multi .sch-td-namemulti{display:flex;align-items:center;gap:3px}
  #kpl-full .sch-multi .sch-multi-info{display:flex;flex-direction:column;line-height:1.15;min-width:0;overflow:hidden}
  #kpl-full .sch-multi .sch-multi-nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #kpl-full .sch-multi .sch-multi-role{font-size:10px;color:var(--vino-light);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:400}
  #kpl-full .sch-multi .sch-weekgroup{background:var(--vino);color:var(--cream);font-family:var(--font-serif);font-size:13px;letter-spacing:.4px;border-left:3px solid var(--sabbia)}
  #kpl-full .sch-multi .sch-weekstart{border-left:3px solid var(--vino-light)}
  #kpl-full .krt-sec-row{display:flex;align-items:center;gap:8px;margin:6px 0}
  #kpl-full .krt-sec-row .krt-sec-inp{flex:1;font-size:14px;padding:8px 10px;border:1px solid rgba(65,2,7,.25);border-radius:8px;background:var(--cream);color:var(--ink);font-family:var(--font-sans)}
  #kpl-full .krt-sec-tag{font-size:10px;background:var(--oro);color:#2a1a10;padding:2px 7px;border-radius:10px;font-weight:700;letter-spacing:.5px}
  #kpl-full .krt-sec-move{display:inline-flex;flex-direction:column;line-height:.7}
  #kpl-full .krt-sec-move button{background:transparent;border:0;color:var(--vino-light);cursor:pointer;font-size:11px;padding:1px 3px;border-radius:3px}
  #kpl-full .krt-sec-move button:hover{color:#fff;background:var(--vino)}
  #kpl-full .krt-sec-del{background:transparent;border:1px solid rgba(65,2,7,.2);color:var(--vino);cursor:pointer;font-size:16px;line-height:1;width:30px;height:32px;border-radius:8px;flex-shrink:0}
  #kpl-full .krt-sec-del:hover{background:#7f1d1d;color:#fff;border-color:#7f1d1d}
  #kpl-full .krt-oneweek-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;background:var(--vino);color:#f6ece0;font-family:var(--font-serif);font-size:15px;padding:8px 14px;border-radius:10px 10px 0 0;margin-bottom:0}
  #kpl-full .krt-wk-hd{display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap}
  #kpl-full .krt-wk-actions{display:inline-flex;align-items:center;gap:6px}
  #kpl-full .krt-wk-btn{background:var(--sabbia);color:var(--vino);border:0;border-radius:6px;padding:3px 11px;font-size:11px;font-weight:600;cursor:pointer;font-family:var(--font-sans);text-transform:none;letter-spacing:0}
  #kpl-full .krt-wk-btn:hover{filter:brightness(1.05)}
  #kpl-full .krt-wk-btn.paste{background:var(--oro);color:#2a1a10}
  #kpl-full .krt-wk-btn.clear{background:transparent;color:var(--sabbia);border:1px solid rgba(255,255,255,.4)}
  #kpl-full .krt-wk-btn.clear:hover{background:#7f1d1d;color:#fff;border-color:#7f1d1d;filter:none}
  #kpl-full .krt-wk-copied{font-size:11px;color:var(--sabbia);font-style:italic;text-transform:none;letter-spacing:0}
  #kpl-full .krt-act-menu{position:absolute;right:0;top:calc(100% + 8px);width:250px;max-width:calc(100vw - 24px);background:var(--cream);border:1px solid var(--sabbia-dark);border-radius:12px;box-shadow:0 14px 40px rgba(65,2,7,.22);padding:8px;z-index:4300;display:none}
  #kpl-full .krt-act-menu.open{display:block}
  #kpl-full .krt-act-menu .grp{font-family:var(--font-serif);font-size:12px;letter-spacing:1.4px;text-transform:uppercase;color:var(--vino);padding:9px 12px 5px}
  #kpl-full .krt-act-menu .item{padding:9px 12px;border-radius:8px;font-size:13.5px;color:var(--ink);cursor:pointer}
  #kpl-full .krt-act-menu .item:hover{background:var(--sabbia-light)}
  #kpl-full .krt-hint{font-size:12px;color:var(--vino-light);padding:9px 18px 0}
  #kpl-full .krt-grid-wrap{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;padding:12px 16px 30px}
  #kpl-full .kpl-ov{position:fixed;inset:0;z-index:4400;background:rgba(30,10,10,.42);display:flex;align-items:center;justify-content:center;padding:16px}
  #kpl-full .kpl-modal{background:var(--cream);border-radius:14px;max-width:520px;width:100%;max-height:88vh;overflow:auto;padding:20px;box-shadow:0 18px 50px rgba(0,0,0,.35)}
  #kpl-full .kpl-modal h3{margin:0 0 10px;font-family:var(--font-serif);color:var(--vino);font-size:19px}
  #kpl-full .kpl-btn{border:1px solid rgba(65,2,7,.28);background:var(--cream);color:var(--vino);border-radius:7px;padding:7px 13px;font-size:12.5px;cursor:pointer;font-weight:600}
  #kpl-full .kpl-btn.primary{background:var(--vino);color:#fff;border-color:var(--vino)}
  #kpl-full .kpl-lbl{font-size:10px;letter-spacing:.5px;text-transform:uppercase;color:var(--vino-light)}
  #kpl-full .kpl-qbtn{border:1px solid rgba(65,2,7,.2);background:var(--cream);border-radius:9px;padding:9px 10px;font-size:12.5px;cursor:pointer;font-weight:600;text-align:center}
  #kpl-full .kpl-sel{font-family:var(--font-sans);font-size:12px;padding:5px 7px;border:1px solid rgba(65,2,7,.25);border-radius:6px;color:var(--vino);background:var(--cream)}
  #kpl-full input[type=time],#kpl-full input[type=text],#kpl-full input[type=number]{font-family:var(--font-sans);font-size:14px;padding:8px 9px;border:1px solid rgba(65,2,7,.25);border-radius:8px;background:var(--cream);color:var(--ink)}
  </style>
  <div class="krt-top">
    <button class="krt-back" onclick="krtClose()">&#8592; Schedule</button>
    <div class="krt-brand"><span class="n">ROBERTO'S</span><span class="s">Kitchen Roster &mdash; Planning</span></div>
    <div class="krt-nav">
      <button onclick="krtShift(-1)" title="Previous week">&#8249;</button>
      <span class="krt-lbl" id="krt-weeklabel"></span>
      <button onclick="krtShift(1)" title="Next week">&#8250;</button>
      <button class="today" onclick="krtToday()">This week</button>
    </div>
    <div class="krt-seg">
      <button id="krt-seg-1" class="on" onclick="krtSetWeeks(1)">One week</button>
      <button id="krt-seg-n" onclick="krtSetWeeks(krtSpanN)">Several weeks</button>
    </div>
    <span class="krt-stepper" id="krt-stepper">weeks&nbsp;<select onchange="krtSetWeeks(this.value)"><option value="2">2</option><option value="3">3</option><option value="4" selected>4</option><option value="6">6</option></select></span>
    <span class="krt-changed-chip" id="krt-changecount">No changes yet</span>
    <button class="krt-undo" id="krt-undo-btn" onclick="krtUndoLast()" disabled title="Nothing to undo yet">&#8630; Undo</button>
    <button class="krt-bring" id="krt-bringlive" onclick="schedPlanOpenPublish()" title="Put the week(s) you pick onto the real schedule the team sees">Bring live</button>
    <div class="krt-act-wrap">
      <button class="krt-act-btn" onclick="krtToggleActions(event)">Actions &#9660;</button>
      <div class="krt-act-menu" id="krt-actmenu">
        <div class="grp">Build</div>
        <div class="item" onclick="krtFillTeams()">Fill lunch &amp; dinner teams</div>
        <div class="item" onclick="krtGiveDaysOff()">Give everyone their days off</div>
        <div class="item" onclick="krtGiveWeekOff()">Give everyone a week off</div>
        <div class="grp">Check</div>
        <div class="item" onclick="krtCoverage();krtCloseActions()">Coverage check</div>
        <div class="item" onclick="kplOpenCalc();krtCloseActions()">How many people do I need?</div>
        <div class="grp">Sections</div>
        <div class="item" onclick="krtOpenSections()">Add, rename or delete a section</div>
      </div>
    </div>
  </div>
  <div class="krt-hint">You're planning &mdash; the live schedule is untouched. Change anything you like (tap a day, <b>+ Add staff</b>, <b>&#8596; Move</b>, the arrows to plan weeks ahead). Nothing reaches the team until you press <b>Bring live</b>. Gold marks a change that isn't live yet.</div>
  <div class="krt-grid-wrap"><div id="krt-grid"></div><div id="kpl-modalhost"></div></div>`;
}
// First-time welcome + on-demand help (a top-market app explains itself once).
function kplShowHelp(force){
  if(!force){ try{ if(localStorage.getItem('kitchenPlanSeen')==='1') return; }catch(e){} }
  var host=document.getElementById('kpl-modalhost'); if(!host) return;
  host.innerHTML = '<div class="kpl-ov" onclick="kplCloseHelp(event)"><div class="kpl-modal" onclick="event.stopPropagation()">'
    + '<h3>Welcome to the Roster tool</h3>'
    + '<div style="font-size:13.5px;line-height:1.7;color:var(--ink)">'
    +   '<p style="margin:0 0 12px;background:#e9f6ef;border:1px solid #a9d8bf;border-radius:8px;padding:9px 11px">It opens on the real schedule, ready to change. Edit freely — <b>nothing reaches the team</b> until you choose <b>Put on the live schedule</b>, and you can always undo it.</p>'
    +   '<ol style="margin:0 0 12px;padding-left:20px">'
    +     '<li><b>Tap any day</b> to set the hours, a day off, holiday, and so on. Hours and days add up on their own.</li>'
    +     '<li>Tap the <b>&#8942;</b> next to a name to move that person, reorder them, or remove them; use <b>+ Add person</b> to add someone to a section.</li>'
    +     '<li>Switch <b>One week</b> and <b>Several weeks</b> at the top to plan further ahead.</li>'
    +     '<li>Everything else lives in one <b>Actions</b> menu — grouped Build, Check, Finish.</li>'
    +     '<li>Happy with it? <b>Actions &rarr; Put on the live schedule</b> — and undo is right there if you need it.</li>'
    +   '</ol>'
    + '</div>'
    + '<div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="kpl-btn primary" onclick="kplCloseHelp()">Got it</button></div>'
    + '</div></div>';
}
function kplCloseHelp(ev){ if(ev && ev.target && !ev.target.classList.contains('kpl-ov')) return; try{ localStorage.setItem('kitchenPlanSeen','1'); }catch(e){} var h=document.getElementById('kpl-modalhost'); if(h) h.innerHTML=''; }
function kplClose(){
  if(kplDirty){ if(!confirm('You have unsaved planning in this draft.\n\nIt is saved on this device and will still be here next time — close the Roster tool?')) return; }
  kplEndPaste();
  var el = document.getElementById('kpl-full'); if(el) el.style.display='none';
  var sview = document.getElementById('scheduling-view'); if(sview) sview.style.display='flex';
  var fb = document.querySelector('.footer-bar'); if(fb) fb.style.display='flex';
  // the live schedule state was never touched; re-render it as-is
  if(typeof renderSchedView==='function' && schedWeekStart) renderSchedView();
}

// ── Data ──
async function kplLoad(){
  var fromISO = formatDate(kplFrom);
  var toISO   = formatDate(addDays(kplFrom, kplNumWeeks*7 - 1));
  try{
    var res = await Promise.all([
      sb.from('staff').select('*').eq('active', true).order('sort_order'),
      sb.from('roster').select('*').gte('work_date', fromISO).lte('work_date', toISO).limit(8000)
    ]);
    kplStaff = (res[0].data||[]).filter(function(s){ return s.in_schedule!==false; });
    kplLive = {};
    (res[1].data||[]).forEach(function(r){ kplLive[kplKey(r.staff_id, String(r.work_date).slice(0,10))] = r; });
  }catch(err){ console.error('Planner load error', err); kplStaff=[]; kplLive={}; }
  kplRenderControls();
}

// ── Draft store ──
function kplSaveDraft(){
  kplDirty = true;
  try{
    localStorage.setItem(KPL_DRAFT_LS, JSON.stringify({
      from: formatDate(kplFrom), numWeeks: kplNumWeeks,
      entries: kplDraft, mins: kplMins, ent: kplEnt,
      secOverrides: kplDraftSec, order: kplDraftOrd, newStaff: kplNewStaff, newSeq: kplNewSeq,
      updatedAt: new Date().toISOString()
    }));
  }catch(e){ console.warn('draft save failed', e); }
  var s = document.getElementById('kpl-saved'); if(s){ s.textContent='✓ Saved'; s.style.opacity='1'; setTimeout(function(){ if(s) s.style.opacity='.45'; }, 1200); }
}
function kplReadDraft(){ try{ return JSON.parse(localStorage.getItem(KPL_DRAFT_LS)||'null'); }catch(e){ return null; } }
function kplPullFromLive(){
  kplDraft = {};
  Object.keys(kplLive).forEach(function(k){
    var r = kplLive[k];
    kplDraft[k] = { status:r.status||'working', shift_start:r.shift_start||null, shift_end:r.shift_end||null,
                    shift_start2:r.shift_start2||null, shift_end2:r.shift_end2||null, notes:r.notes||null };
  });
  kplDraftSec = {}; kplDraftOrd = {}; kplNewStaff = []; kplNewSeq = 0;
}
function kplEnterDraft(fresh){
  var saved = kplReadDraft();
  if(fresh || !saved || saved.from!==formatDate(kplFrom) || saved.numWeeks!==kplNumWeeks){
    kplPullFromLive(); kplMins = {}; kplEnt = {};
  } else {
    kplDraft = saved.entries||{}; kplMins = saved.mins||{}; kplEnt = saved.ent||{};
    kplDraftSec = saved.secOverrides||{}; kplDraftOrd = saved.order||{}; kplNewStaff = saved.newStaff||[]; kplNewSeq = saved.newSeq||0;
  }
  kplMode = 'draft';
  kplUndoStack = []; if (typeof kplRenderUndoBtn === 'function') kplRenderUndoBtn();   // fresh draft session — no stale undo
  kplSaveDraft();
  kplRenderControls(); kplRender();
}
function kplMaybeOfferResume(){
  var saved = kplReadDraft();
  var banner = document.getElementById('kpl-resume');
  if(!banner) return;
  if(saved && saved.from===formatDate(kplFrom) && saved.numWeeks===kplNumWeeks && saved.entries && Object.keys(saved.entries).length){
    var when = ''; try{ when = new Date(saved.updatedAt).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}); }catch(e){}
    banner.style.display='flex';
    banner.querySelector('#kpl-resume-txt').textContent = 'You have a saved draft for these weeks (last edited '+when+').';
  } else { banner.style.display='none'; }
}
function kplResumeYes(){ document.getElementById('kpl-resume').style.display='none'; kplEnterDraft(false); }
function kplResumeFresh(){ if(!confirm('Discard the saved draft for these weeks and start again from the live roster?')) return; document.getElementById('kpl-resume').style.display='none'; kplEnterDraft(true); }
function kplExitDraft(){ if(!confirm('Switch back to the read-only preview? Your draft stays saved on this device.')) return; kplMode='preview'; kplPaintOff(); kplEndPaste(); kplRenderControls(); kplRender(); }

// ── Shell / CSS ──
function KPL_SHELL(){
  return `
  <style>
  #kpl-full *{box-sizing:border-box}
  #kpl-full{font-family:var(--font-sans)}
  #kpl-full .kpl-scroll{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;padding:16px 18px 30px}
  /* ── board ── */
  #kpl-full table.kpl{border-collapse:separate;border-spacing:0;background:var(--cream);width:100%;
    border:1px solid var(--sabbia-dark);border-radius:12px;overflow:hidden}
  #kpl-full .kpl th,#kpl-full .kpl td{border-bottom:1px solid #ece2d0;border-right:1px solid #efe7d7;padding:0;text-align:center;vertical-align:middle}
  #kpl-full .kpl-name{position:sticky;left:0;z-index:3;background:var(--cream);text-align:left;padding:7px 10px;box-shadow:2px 0 0 rgba(65,2,7,.06);min-width:186px;max-width:186px}
  #kpl-full .kpl-name.narrow{min-width:128px;max-width:128px}
  #kpl-full thead .kpl-name{z-index:6;background:var(--sabbia)}
  #kpl-full .kpl-wkhdr{background:var(--sabbia);color:var(--vino);font-family:var(--font-serif);font-size:14px;letter-spacing:.4px;padding:8px 6px;font-weight:600;border-left:2px solid var(--sabbia-dark)}
  #kpl-full .kpl-wkhdr button{background:rgba(65,2,7,.10);border:none;color:var(--vino);border-radius:4px;cursor:pointer;font-size:11px;padding:2px 7px;margin-left:5px;font-weight:600}
  #kpl-full .kpl-dhdr{background:var(--sabbia);font-family:var(--font-serif);font-size:12.5px;color:var(--vino);padding:6px 2px;line-height:1.15;font-weight:600}
  #kpl-full .kpl-dhdr .dt{display:block;font-family:var(--font-sans);font-weight:400;font-size:10.5px;color:var(--vino-light);margin-top:1px}
  #kpl-full .kpl-dhdr.busy .dt{color:#8a1414;font-weight:700}
  #kpl-full .kpl-dhdr.wk{border-left:2px solid var(--sabbia-dark)}
  #kpl-full .kpl-sec td{background:var(--sabbia-light);text-align:left;padding:0;position:sticky;left:0}
  #kpl-full .kpl-secinner{display:flex;align-items:center;gap:10px;padding:7px 12px}
  #kpl-full .kpl-secinner .rail{width:11px;height:16px;border-radius:3px;flex:none}
  #kpl-full .kpl-secinner .nm{font-family:var(--font-serif);font-size:13.5px;letter-spacing:.8px;text-transform:uppercase;color:var(--ink)}
  #kpl-full .kpl-secinner .need{margin-left:auto;font-size:11px;color:var(--vino-light)}
  #kpl-full .kpl-secinner .addp{margin-left:12px;border:1px dashed var(--sabbia-dark);background:transparent;color:var(--vino);border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer;font-weight:600}
  #kpl-full .kpl-secinner .addp:hover{background:var(--cream)}
  #kpl-full .kpl-namewrap{display:flex;align-items:center;gap:6px}
  #kpl-full .kpl-nameblock{flex:1;min-width:0}
  #kpl-full .kpl-nm{font-size:13px;color:var(--ink);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #kpl-full .kpl-role{font-size:11px;color:var(--vino-light);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #kpl-full .kpl-eid{font-size:10px;color:var(--vino-light);font-weight:400}
  #kpl-full .kpl-rowopt{flex:none;border:1px solid var(--sabbia-dark);background:var(--cream);color:var(--vino);border-radius:6px;width:26px;height:26px;line-height:1;cursor:pointer;font-size:16px;font-weight:700;padding:0}
  #kpl-full .kpl-rowopt:hover{background:var(--sabbia-light)}
  #kpl-full .kpl-newbadge{display:inline-block;font-size:8.5px;letter-spacing:.5px;text-transform:uppercase;background:var(--sabbia);color:var(--vino);border-radius:8px;padding:1px 6px;margin-left:5px;vertical-align:middle}
  #kpl-full .kpl-ordbtn{border:1px solid var(--sabbia-dark);background:var(--cream);color:var(--vino);border-radius:7px;padding:8px 12px;font-size:14px;cursor:pointer;font-weight:600}
  #kpl-full .kpl-ordbtn:hover{background:var(--sabbia-light)}
  #kpl-full .kpl-ordbtn:disabled{opacity:.4;cursor:not-allowed}
  #kpl-full .kpl-cell{font-size:12px;line-height:1.05;overflow:hidden;white-space:nowrap;cursor:default}
  #kpl-full.draft .kpl-cell{cursor:pointer}
  #kpl-full.paint .kpl-cell{cursor:crosshair}
  #kpl-full .kpl-cell.we{background:rgba(120,90,40,.03)}
  #kpl-full .kpl-cell.today{outline:2px solid var(--oro);outline-offset:-2px}
  #kpl-full .kpl-cell.wk{border-left:2px solid var(--sabbia-dark)}
  #kpl-full.draft .kpl-cell:hover{outline:2px solid var(--sabbia-dark);outline-offset:-2px}
  #kpl-full .kpl-pill{width:100%;height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:1px;position:relative;padding:4px 2px}
  #kpl-full .kpl-t{color:var(--ink);font-variant-numeric:tabular-nums}
  #kpl-full .kpl-t2{font-size:10px;color:var(--vino-light);font-variant-numeric:tabular-nums}
  #kpl-full .kpl-split{font-size:8.5px;letter-spacing:.4px;color:#b4703f;text-transform:uppercase}
  #kpl-full .kpl-chip{font-size:10.5px;font-weight:700;letter-spacing:.4px;padding:3px 9px;border-radius:20px;text-transform:uppercase}
  #kpl-full .kpl-add{color:#c9b7a4;font-weight:400;font-size:13px}
  #kpl-full .kpl-chg{position:absolute;top:2px;right:2px;width:5px;height:5px;border-radius:50%;background:#c9a84c;box-shadow:0 0 0 1px var(--cream)}
  #kpl-full .kpl-tot{font-size:12px;color:var(--ink);background:var(--sabbia-light);padding:4px 8px;min-width:52px;position:sticky;right:0;box-shadow:-2px 0 0 rgba(65,2,7,.05);font-variant-numeric:tabular-nums}
  #kpl-full .kpl-tot.hrs{font-weight:600}
  #kpl-full .kpl-tot.warn{background:#fbe4e1;color:#a8342a}
  #kpl-full thead .kpl-tot{background:var(--sabbia);z-index:6;font-family:var(--font-serif);font-weight:600;font-size:12px}
  #kpl-full .kpl-cov td{font-size:9px;font-weight:700;color:#5a4a33;background:#faf6ee;padding:1px 0}
  #kpl-full .kpl-cov td.low{background:#fbe4e1;color:#a8342a}
  #kpl-full .kpl-cov .kpl-name{background:#faf6ee;font-weight:700;color:#7a6a4a;font-size:9px;text-transform:uppercase;letter-spacing:.5px}
  #kpl-full .kpl-grand td{background:var(--sabbia);border-bottom:0;padding:8px 4px;font-size:12px}
  #kpl-full .kpl-grand .lbl{position:sticky;left:0;z-index:3;text-align:left;font-family:var(--font-serif);letter-spacing:.5px;color:var(--vino);padding-left:12px;background:var(--sabbia)}
  #kpl-full .kpl-grand .cnt{font-variant-numeric:tabular-nums;color:var(--ink)}
  #kpl-full .kpl-grand .cnt.short{color:#a8342a;font-weight:700}
  #kpl-full .kpl-grand .cnt .req{display:block;font-size:9.5px;color:var(--vino-light);font-weight:400}
  /* ── header controls ── */
  #kpl-full .kpl-btn{border:1px solid rgba(65,2,7,.28);background:var(--cream);color:var(--vino);border-radius:7px;padding:7px 13px;font-size:12.5px;cursor:pointer;font-weight:600}
  #kpl-full .kpl-btn:hover{background:var(--sabbia-light)}
  #kpl-full .kpl-btn.primary{background:var(--vino);color:#fff;border-color:var(--vino)}
  #kpl-full .kpl-btn.go{background:#0f766e;color:#fff;border-color:#0f766e}
  #kpl-full .kpl-btn:disabled{opacity:.45;cursor:not-allowed}
  #kpl-full .knav button{background:transparent;border:1px solid rgba(255,255,255,.28);color:#f6ece0;width:30px;height:30px;border-radius:7px;cursor:pointer;font-size:15px;line-height:1}
  #kpl-full .knav button:hover{background:rgba(255,255,255,.12)}
  #kpl-full .knav .lbl{font-family:var(--font-serif);font-size:15px;color:#f6ece0;min-width:190px;text-align:center}
  #kpl-full .kseg{display:inline-flex;background:rgba(0,0,0,.16);border-radius:9px;padding:3px}
  #kpl-full .kseg button{background:transparent;border:0;color:#e7d3bf;padding:6px 13px;border-radius:7px;cursor:pointer;font-size:12.5px}
  #kpl-full .kseg button.on{background:var(--sabbia);color:var(--vino);font-weight:600}
  #kpl-full .kstep{display:inline-flex;align-items:center;gap:6px;color:#e7d3bf;font-size:12px}
  #kpl-full .kstep select{font-family:var(--font-sans);font-size:12.5px;padding:5px 7px;border:1px solid rgba(255,255,255,.3);border-radius:7px;color:var(--vino);background:var(--sabbia)}
  #kpl-full .kact-wrap{position:relative}
  #kpl-full .kact-btn{background:var(--sabbia);color:var(--vino);border:0;border-radius:8px;padding:8px 15px;font-size:13.5px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:8px}
  #kpl-full .kact-btn .car{font-size:9px;opacity:.7}
  #kpl-full .kact-menu{position:absolute;right:0;top:calc(100% + 8px);width:260px;background:var(--cream);border:1px solid var(--sabbia-dark);border-radius:12px;box-shadow:0 14px 40px rgba(65,2,7,.22);padding:8px;z-index:4300;display:none}
  #kpl-full .kact-menu.open{display:block}
  #kpl-full .kact-menu .grp{font-family:var(--font-serif);font-size:12px;letter-spacing:1.4px;text-transform:uppercase;color:var(--vino);padding:9px 12px 5px}
  #kpl-full .kact-menu .item{padding:9px 12px;border-radius:8px;font-size:13.5px;color:var(--ink);cursor:pointer}
  #kpl-full .kact-menu .item:hover{background:var(--sabbia-light)}
  #kpl-full .kact-menu .item.dim{color:#b3a595;cursor:default}
  #kpl-full .kact-menu .item.dim:hover{background:transparent}
  #kpl-full .kact-menu .rule{height:1px;background:var(--sabbia-dark);opacity:.5;margin:6px 6px}
  /* ── legend + modals ── */
  #kpl-full .kpl-legendbar{display:flex;flex-wrap:wrap;gap:7px 16px;align-items:center;margin:16px 2px 0;padding:12px 16px;background:var(--sabbia-light);border:1px solid #ece2d0;border-radius:12px}
  #kpl-full .kpl-legendbar .lg{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--vino-light)}
  #kpl-full .kpl-legendbar .sw{width:12px;height:12px;border-radius:4px;flex:none}
  #kpl-full .kpl-legendbar .ttl{font-family:var(--font-serif);font-size:11.5px;letter-spacing:1px;text-transform:uppercase;color:var(--vino)}
  #kpl-full .kpl-lbl{font-size:10px;letter-spacing:.5px;text-transform:uppercase;color:var(--vino-light)}
  #kpl-full select.kpl-sel{font-family:var(--font-sans);font-size:12px;padding:5px 7px;border:1px solid rgba(65,2,7,.25);border-radius:6px;color:var(--vino);background:var(--cream)}
  #kpl-full .kpl-ov{position:fixed;inset:0;z-index:4400;background:rgba(30,10,10,.42);display:flex;align-items:center;justify-content:center;padding:16px}
  #kpl-full .kpl-modal{background:var(--cream);border-radius:14px;max-width:520px;width:100%;max-height:88vh;overflow:auto;padding:20px;box-shadow:0 18px 50px rgba(0,0,0,.35)}
  #kpl-full .kpl-modal h3{margin:0 0 10px;font-family:var(--font-serif);color:var(--vino);font-size:19px}
  #kpl-full .kpl-qbtn{border:1px solid rgba(65,2,7,.2);background:var(--cream);border-radius:9px;padding:9px 10px;font-size:12.5px;cursor:pointer;font-weight:600;text-align:center}
  #kpl-full .kpl-qbtn.on{outline:3px solid rgba(65,2,7,.25)}
  #kpl-full input[type=time],#kpl-full input[type=text],#kpl-full input[type=number]{font-family:var(--font-sans);font-size:14px;padding:8px 9px;border:1px solid rgba(65,2,7,.25);border-radius:8px;background:var(--cream);color:var(--ink)}
  @media (max-width:760px){ #kpl-full .kpl-scroll{padding:12px 8px 24px} #kpl-full .kpl-qbtn{font-size:13px;padding:11px 12px} #kpl-full .kpl-btn{padding:9px 12px} #kpl-full input[type=time]{font-size:16px} #kpl-full .kpl-modal{padding:16px 14px} #kpl-full .knav .lbl{min-width:130px;font-size:13px} }
  </style>
  <div class="kpl-top" style="background:var(--vino);color:#f6ece0;display:flex;align-items:center;gap:18px;padding:11px 18px;flex-shrink:0;border-bottom:3px solid var(--sabbia)">
    <button onclick="kplClose()" title="Back to the live schedule" style="background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.3);color:#f6ece0;padding:6px 12px;border-radius:7px;cursor:pointer;font-size:11px;letter-spacing:1px;text-transform:uppercase">&#8592; Schedule</button>
    <div style="display:flex;flex-direction:column;line-height:1.05">
      <span style="font-family:var(--font-serif);font-size:20px;letter-spacing:2px">ROBERTO'S</span>
      <span style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#d9c3ad;margin-top:2px">Kitchen Roster</span>
    </div>
    <span id="kpl-modebadge" style="font-size:10px;padding:3px 9px;border-radius:10px;background:rgba(255,255,255,.16)"></span>
    <div id="kpl-controls" style="display:flex;align-items:center;gap:14px;flex:1;justify-content:flex-end;flex-wrap:wrap"></div>
    <span id="kpl-saved" style="font-size:11px;opacity:.45;min-width:52px">&nbsp;</span>
  </div>
  <div id="kpl-resume" style="display:none;align-items:center;gap:12px;background:#fff7e6;border-bottom:1px solid #f0d98a;padding:8px 16px;flex-shrink:0">
    <span id="kpl-resume-txt" style="font-size:12px;color:#7a5a12"></span>
    <button class="kpl-btn primary" onclick="kplResumeYes()">Resume draft</button>
    <button class="kpl-btn" onclick="kplResumeFresh()">Start fresh from live</button>
  </div>
  <div class="kpl-scroll"><div id="kpl-wrap" style="min-width:100%"></div><div id="kpl-legend"></div></div>
  <div id="kpl-modalhost"></div>`;
}

// ── Controls (calm: week nav · One-week/Several-weeks toggle · single Actions menu) ──
var kplLastMulti = 4;   // remembers how many weeks "Several weeks" showed last
function kplRenderControls(){
  var box = document.getElementById('kpl-controls'); if(!box) return;
  var badge = document.getElementById('kpl-modebadge');
  if(badge) badge.textContent = 'Tap a day to edit';
  var several = kplNumWeeks>1;
  var wkEnd = addDays(kplFrom, kplNumWeeks*7-1);
  var span = several
    ? kplFrom.toLocaleDateString('en-GB',{day:'numeric',month:'short'}) + ' – ' + wkEnd.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})
    : kplFrom.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}) + ' – ' + wkEnd.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'});

  var nav = '<div class="knav" style="display:flex;align-items:center;gap:8px">'
    + '<button onclick="kplShift(-1)" title="Previous week">&#8249;</button>'
    + '<span class="lbl">'+span+'</span>'
    + '<button onclick="kplShift(1)" title="Next week">&#8250;</button>'
    + '<button onclick="kplGoToday()" title="Jump to this week" style="width:auto;padding:0 10px;font-size:11px">This week</button>'
    + '</div>';
  var toggle = '<div class="kseg">'
    + '<button class="'+(several?'':'on')+'" onclick="kplSetView(\'week\')">One week</button>'
    + '<button class="'+(several?'on':'')+'" onclick="kplSetView(\'multi\')">Several weeks</button>'
    + '</div>';
  var stepper = several ? '<span class="kstep">weeks&nbsp;<select onchange="kplSetSpan(this.value)">'
    + [2,3,4,6,8].map(function(n){ return '<option value="'+n+'"'+(kplNumWeeks===n?' selected':'')+'>'+n+'</option>'; }).join('')
    + '</select></span>' : '';
  box.innerHTML = nav + toggle + stepper + kplActionsMenu();
  document.getElementById('kpl-full').classList.add('draft');
}
// The one tidy Actions menu — grouped Build → Check → Finish (design direction §4).
function kplActionsMenu(){
  function item(label, fn){ return '<div class="item" onclick="'+fn+';kplCloseActions()">'+label+'</div>'; }
  var build = item('Fill lunch &amp; dinner teams','kplOpenOpeners()')
      + item('Give everyone their days off','kplGiveEveryoneDaysOff()')
      + item('Give everyone a week off','kplGiveEveryoneWeekOff()')
      + item('Fill many days at once','kplOpenBulk()')
      + item('Start fresh from the live schedule','kplResetToLive()');
  var check = item('Coverage &amp; problems','kplOpenRisk()')
    + item('How many people do I need?','kplOpenCalc()');
  var finish = item('Print / Save as PDF','kplPrintPlan()') + item('Put on the live schedule…','kplOpenPublish()');
  return '<div class="kact-wrap">'
    + '<button class="kact-btn" onclick="kplToggleActions(event)">Actions <span class="car">&#9660;</span></button>'
    + '<div class="kact-menu" id="kpl-actmenu">'
    +   '<div class="grp">Build</div>'+build
    +   '<div class="rule"></div><div class="grp">Check</div>'+check
    +   '<div class="rule"></div><div class="grp">Finish</div>'+finish
    + '</div></div>';
}
function kplToggleActions(ev){ if(ev) ev.stopPropagation(); var m=document.getElementById('kpl-actmenu'); if(m) m.classList.toggle('open'); }
function kplCloseActions(){ var m=document.getElementById('kpl-actmenu'); if(m) m.classList.remove('open'); }
function kplSetView(v){ if(v==='week') kplSetSpan('1'); else kplSetSpan(String(kplLastMulti||4)); }
// Discard the working plan and start again from what's really on the schedule.
function kplResetToLive(){
  if(!confirm('Start again from the live schedule?\n\nThis clears the changes in your plan. Nothing on the real schedule changes.')) return;
  kplEndPaste(); kplPullFromLive(); kplMins={}; kplEnt={}; kplSaveDraft(); kplRender();
}

function kplShift(n){ kplFrom = addDays(kplFrom, n*7); kplRenderControls(); kplLoad().then(function(){ kplSeedFromLive(); kplRender(); }); }
function kplGoToday(){ kplFrom = getMonday(new Date()); kplRenderControls(); kplLoad().then(function(){ kplSeedFromLive(); kplRender(); }); }
function kplSetSpan(v){ kplNumWeeks = parseInt(v,10)||4; if(kplNumWeeks>1) kplLastMulti=kplNumWeeks; kplVisible='fit'; kplPersistView(); kplRenderControls(); kplLoad().then(function(){ kplSeedFromLive(); kplRender(); }); }
function kplSetVisible(v){ kplVisible = v; kplPersistView(); kplRenderControls(); kplRender(); }
function kplSetSec(v){ kplFilterSec = v; kplRender(); }
function kplSetPer(v){ kplFilterPer = v; kplRender(); }
function kplPersistView(){ try{ localStorage.setItem(KPL_VIEW_LS, JSON.stringify({visible:kplVisible, numWeeks:kplNumWeeks})); }catch(e){} }
function kplSyncDraftKeys(){ /* when span changes in draft, keep existing entries; new dates just start empty */ }

// ── Render canvas (the Excel-familiar board, made calm) ──
var KPL_DAY3 = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
var KPL_DAY1 = ['M','T','W','T','F','S','S'];
var KPL_BUSY_NEED = 18;   // Francesco's stated manning on the busy nights Thu–Sat (§3)
function kplBusyDow(dow){ return dow===4 || dow===5 || dow===6; }  // Thu/Fri/Sat
function kplRender(){
  var wrap = document.getElementById('kpl-wrap'); if(!wrap) return;
  if(!kplStaff.length){ wrap.innerHTML = '<div style="padding:40px;text-align:center;color:var(--vino-light);font-style:italic">No staff to show yet.</div>'; return; }
  var narrow = (window.innerWidth||1000) < 760;
  var nameW = narrow?128:186;
  var avail = Math.max(320, (wrap.clientWidth||(window.innerWidth||1000)) - nameW - 120);
  var dayW = Math.max(30, Math.min(Math.floor(avail/(kplNumWeeks*7)), kplNumWeeks===1?128:78));
  var detail = dayW >= 62;
  var today = kplToday();
  var nDays = kplNumWeeks*7;
  var grand = []; for(var g=0; g<nDays; g++) grand.push(0);

  // ── header ──
  var h = '<thead><tr>';
  h += '<th class="kpl-name'+(narrow?' narrow':'')+'" rowspan="2" style="vertical-align:bottom;padding-bottom:6px">Name &amp; role</th>';
  for(var w=0; w<kplNumWeeks; w++){
    var ws=addDays(kplFrom,w*7), we=addDays(kplFrom,w*7+6);
    var tools = kplMode==='draft' ? ' <button onclick="kplCopyWeek('+w+')" title="Copy this week">Copy</button>'+(kplWkClip!==null?'<button onclick="kplPasteWeek('+w+')" title="Paste the copied week here">Paste</button>':'') : '';
    var wlab = kplNumWeeks===1 ? ws.toLocaleDateString('en-GB',{day:'numeric',month:'short'})+' – '+we.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})
                               : 'Week '+(w+1)+' &middot; '+ws.toLocaleDateString('en-GB',{day:'numeric',month:'short'});
    h += '<th class="kpl-wkhdr" colspan="7">'+wlab+tools+'</th>';
  }
  h += '<th class="kpl-tot" rowspan="2" style="vertical-align:bottom">Hours</th><th class="kpl-tot" rowspan="2" style="vertical-align:bottom">Days</th>';
  h += '</tr><tr>';
  for(var w2=0; w2<kplNumWeeks; w2++){ for(var d=0; d<7; d++){
    var dd=addDays(kplFrom,w2*7+d); var busy=kplBusyDow(dd.getDay());
    var dl = detail ? KPL_DAY3[d] : KPL_DAY1[d];
    h += '<th class="kpl-dhdr'+(busy?' busy':'')+(d===0?' wk':'')+'" style="min-width:'+dayW+'px;max-width:'+dayW+'px">'+dl+'<span class="dt">'+dd.getDate()+' '+dd.toLocaleDateString('en-GB',{month:'short'})+'</span></th>';
  } }
  h += '</tr></thead>';

  // ── body ──
  var body='<tbody>';
  var totalCols = nDays + 3;
  kplSections().forEach(function(sec){
    if(kplFilterSec!=='all' && kplFilterSec!==sec.key) return;
    var people = kplStaffInSec(sec.key);
    if(!people.length) return;
    var rail = SEC_COLOR[sec.key]||'#8a7d70';
    var addBtn = (kplMode==='draft' && sec.key!=='__other') ? '<button class="addp" onclick="kplOpenAddPerson(\''+sec.key+'\')">+ Add person</button>' : '';
    body += '<tr class="kpl-sec"><td colspan="'+totalCols+'"><div class="kpl-secinner"><span class="rail" style="background:'+rail+'"></span><span class="nm">'+sec.label+'</span><span class="need">'+people.length+' '+(people.length===1?'person':'people')+'</span>'+addBtn+'</div></td></tr>';
    people.forEach(function(s){
      var tot = { days:0, off:0, hrs:0, al:0, ph:0 };
      var isNew = !!s._new;
      var optBtn = (kplMode==='draft') ? '<button class="kpl-rowopt" title="Move, reorder or remove this person" onclick="kplOpenPerson(\''+s.id+'\')">&#8942;</button>' : '';
      body += '<tr>';
      body += '<td class="kpl-name'+(narrow?' narrow':'')+'"><div class="kpl-namewrap"><div class="kpl-nameblock">'
        + '<div class="kpl-nm">'+schEvEsc(s.name)+(isNew?'<span class="kpl-newbadge">new</span>':'')+(s.emp_id?' <span class="kpl-eid">#'+schEvEsc(String(s.emp_id))+'</span>':'')+'</div>'
        + (s.designation?'<div class="kpl-role">'+schEvEsc(s.designation)+'</div>':'')
        + '</div>'+optBtn+'</div></td>';
      for(var w3=0; w3<kplNumWeeks; w3++){ for(var d2=0; d2<7; d2++){
        var ds = kplDateISO(w3,d2); var col=w3*7+d2;
        var wk = kplEntry(s.id, ds);
        if(wk && wk.status==='working' && wk.shift_start && wk.shift_end) grand[col]++;
        var dow = addDays(kplFrom,col).getDay();
        body += kplCellHtml(s, ds, dayW, detail, d2===0, kplBusyDow(dow), today, tot);
      }}
      var offWarn = tot.off===0;
      body += '<td class="kpl-tot hrs">'+(tot.hrs?Math.round(tot.hrs):'')+'</td>';
      body += '<td class="kpl-tot'+(offWarn?' warn':'')+'">'+(tot.days||'')+'</td>';
      body += '</tr>';
    });
  });
  // ── grand headcount row (like the Excel's bottom totals) ──
  body += '<tr class="kpl-grand"><td class="lbl">On the floor</td>';
  for(var gc=0; gc<nDays; gc++){
    var gdow = addDays(kplFrom,gc).getDay(); var busy2 = kplBusyDow(gdow);
    var need = busy2 ? '<span class="req">need '+KPL_BUSY_NEED+'</span>' : '';
    var shortCls = (busy2 && grand[gc]<KPL_BUSY_NEED) ? ' short' : '';
    body += '<td class="cnt'+shortCls+'">'+grand[gc]+need+'</td>';
  }
  body += '<td class="kpl-tot" style="background:var(--sabbia)"></td><td class="kpl-tot" style="background:var(--sabbia)"></td></tr>';
  body += '</tbody>';
  wrap.innerHTML = '<table class="kpl">'+h+body+'</table>';

  kplRenderLegend();
}

// Their colour language, quietly stated at the foot.
function kplRenderLegend(){
  var leg = document.getElementById('kpl-legend'); if(!leg) return;
  function lg(lbl,col){ return '<span class="lg"><span class="sw" style="background:'+col+'"></span>'+lbl+'</span>'; }
  var secs = kplSections().filter(function(s){ return s.key!=='__other'; })
     .map(function(s){ return lg(s.label, SEC_COLOR[s.key]||'#8a7d70'); }).join('');
  var away = lg('Day off',KPL_COLOR.off)+lg('Weekly off',KPL_COLOR.wo)+lg('Holiday',KPL_COLOR.al)
     +lg('Training',KPL_COLOR.tr)+lg('Emergency',KPL_COLOR.em)+lg('Public holiday',KPL_COLOR.ph)
     +lg('Sick',KPL_COLOR.sl)+lg('Cancel day off',KPL_COLOR.cdo);
  leg.className='kpl-legendbar';
  leg.innerHTML = '<span class="ttl">Sections</span>'+secs
    + '<span class="ttl" style="margin-left:6px">Away</span>'+away
    + (kplMode==='draft' ? '<span class="lg" style="margin-left:auto"><span class="sw" style="background:#c9a84c;border-radius:50%"></span>you changed it</span>' : '');
}

function kplCellHtml(s, ds, dayW, detail, isWk, isWe, today, tot){
  var e = kplEntry(s.id, ds);
  var cls = 'kpl-cell'+(isWk?' wk':'')+(isWe?' we':'')+(ds===today?' today':'');
  var hgt = dayW>=62?46:38;
  var chg = '';
  if(kplMode==='draft'){
    var live = kplLive[kplKey(s.id,ds)];
    if(kplCellDiff(e, live)) chg = '<span class="kpl-chg"></span>';
  }
  var inner;
  if(!e || (!e.status)){
    inner = '<div class="kpl-pill"><span class="kpl-add">'+(kplMode==='draft'?'+':'&middot;')+'</span>'+chg+'</div>';
  } else if(e.status==='working'){
    var st=formatTime(e.shift_start), et=formatTime(e.shift_end), split=e.shift_start2&&e.shift_end2;
    var hh = calcHours(st, et, formatTime(e.shift_start2), formatTime(e.shift_end2));
    if(st&&et){ tot.days++; tot.hrs+=hh; }
    if(detail){
      var line1 = st ? st+(et?' &ndash; '+et:'') : 'On';
      var line2 = split ? '<span class="kpl-t2">'+formatTime(e.shift_start2)+' &ndash; '+formatTime(e.shift_end2)+'</span><span class="kpl-split">split</span>' : '';
      inner = '<div class="kpl-pill"><span class="kpl-t">'+line1+'</span>'+line2+chg+'</div>';
    } else {
      var compact = st ? (st.split(':')[0]+'-'+(et?et.split(':')[0]:'')+(split?' L':'')) : '&bull;';
      inner = '<div class="kpl-pill"><span class="kpl-t" style="font-size:10px">'+compact+'</span>'+chg+'</div>';
    }
  } else {
    var col = KPL_COLOR[e.status]||'#8a7d70';
    var txt = e.status==='cdo' ? '#7a6400' : col;
    if(e.status!=='off') tot.days++;
    if(e.status==='off'||e.status==='wo') tot.off++;
    if(e.status==='al') tot.al++;
    if(e.status==='ph') tot.ph++;
    var label = detail ? kplFriendly(e.status) : (kplCode(e.status)||'&bull;');
    inner = '<div class="kpl-pill"><span class="kpl-chip" style="background:'+col+'22;color:'+txt+'">'+label+'</span>'+chg+'</div>';
  }
  var handler = kplMode==='draft' ? ' onpointerdown="kplCellDown(event,\''+s.id+'\',\''+ds+'\')" onpointerenter="kplCellEnter(\''+s.id+'\',\''+ds+'\')" onclick="kplCellClick(\''+s.id+'\',\''+ds+'\')"' : '';
  return '<td class="'+cls+'" data-k="'+kplKey(s.id,ds)+'" style="height:'+hgt+'px;min-width:'+dayW+'px;max-width:'+dayW+'px"'+handler+'>'+inner+'</td>';
}
function kplCellDiff(e, live){
  var a = e||{}; var b = live||{};
  if((a.status||'')!==(b.status||'')) return true;
  if(a.status==='working'){
    return formatTime(a.shift_start)!==formatTime(b.shift_start) || formatTime(a.shift_end)!==formatTime(b.shift_end)
      || formatTime(a.shift_start2)!==formatTime(b.shift_start2) || formatTime(a.shift_end2)!==formatTime(b.shift_end2);
  }
  return false;
}

// ── Person options: reorder within section · move section · remove (draft-only until Publish) ──
function kplFindPerson(id){ return kplAllPeople().find(function(s){ return s.id===id; }); }
function kplOpenPerson(id){
  var s = kplFindPerson(id); if(!s) return;
  var secKey = kplEffSec(s);
  var mates = kplStaffInSec(secKey);
  var idx = mates.findIndex(function(x){ return x.id===id; });
  var canUp = idx>0, canDown = idx>=0 && idx<mates.length-1;
  var secLabel = (STATIONS_SCH.find(function(x){return x.key===secKey;})||{label:'Other / Unassigned'}).label;
  var secOpts = STATIONS_SCH.map(function(sec){
    var on = sec.key===secKey;
    return '<button class="kpl-qbtn'+(on?' on':'')+'" style="text-align:left" onclick="kplMoveTo(\''+id+'\',\''+sec.key+'\')">'+sec.label+(on?' <span style="opacity:.55;font-size:10px">(now)</span>':'')+'</button>';
  }).join('');
  var removeBtn = s._new ? '<button class="kpl-btn" style="border-color:#a8342a;color:#a8342a" onclick="kplRemoveNew(\''+id+'\')">Remove this person</button>' : '';
  var host = document.getElementById('kpl-modalhost');
  host.innerHTML = '<div class="kpl-ov" onclick="kplCloseMove(event)"><div class="kpl-modal" onclick="event.stopPropagation()">'
    + '<h3>'+schEvEsc(s.name)+'</h3>'
    + '<div style="font-size:12px;color:var(--vino-light);margin-bottom:14px">In <b>'+schEvEsc(secLabel)+'</b>. These changes stay in your plan until you press <b>Put on the live schedule</b>.</div>'
    + '<div class="kpl-lbl" style="margin-bottom:6px">Order in this section</div>'
    + '<div style="display:flex;gap:8px;margin-bottom:16px">'
    +   '<button class="kpl-ordbtn" '+(canUp?'':'disabled')+' onclick="kplMoveUp(\''+id+'\')">&#8593;&nbsp; Move up</button>'
    +   '<button class="kpl-ordbtn" '+(canDown?'':'disabled')+' onclick="kplMoveDown(\''+id+'\')">&#8595;&nbsp; Move down</button>'
    + '</div>'
    + '<div class="kpl-lbl" style="margin-bottom:6px">Put in another section</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">'+secOpts+'</div>'
    + '<div style="display:flex;justify-content:space-between;gap:8px">'+removeBtn+'<button class="kpl-btn primary" style="margin-left:auto" onclick="kplCloseMove()">Done</button></div>'
    + '</div></div>';
}
function kplMoveUp(id){ kplReorder(id,-1); }
function kplMoveDown(id){ kplReorder(id,1); }
function kplReorder(id, dir){
  var s = kplFindPerson(id); if(!s) return;
  var secKey = kplEffSec(s);
  var mates = kplStaffInSec(secKey);
  var idx = mates.findIndex(function(x){ return x.id===id; });
  var j = idx+dir; if(idx<0 || j<0 || j>=mates.length) return;
  var tmp = mates[idx]; mates[idx]=mates[j]; mates[j]=tmp;
  mates.forEach(function(m,i){ kplDraftOrd[m.id]=i; });   // re-number this section cleanly
  kplSaveDraft(); kplRender(); kplOpenPerson(id);          // keep the panel open so you can keep nudging
}
function kplMoveTo(id, secKey){
  var s = kplFindPerson(id); if(!s) return;
  if(secKey===kplEffSec(s)){ kplCloseMove(); return; }
  if(s._new){ s.station_key = secKey; }               // a brand-new person just changes its own section
  else if(secKey===s.station_key){ delete kplDraftSec[id]; }  // back to where they started = no override
  else { kplDraftSec[id] = secKey; }
  // drop them at the bottom of the section they land in
  var maxOrd=-1; kplStaffInSec(secKey).forEach(function(m){ if(m.id!==id){ var o=kplEffOrd(m); if(o>maxOrd) maxOrd=o; } });
  kplDraftOrd[id] = maxOrd+1;
  kplCloseMove(); kplSaveDraft(); kplRender();
}
function kplRemoveNew(id){
  var s = kplFindPerson(id); if(!s || !s._new) return;
  if(!confirm('Remove '+schEvEsc(s.name)+' from the plan? (They were only ever in this draft — nothing on the live schedule changes.)')) return;
  kplNewStaff = kplNewStaff.filter(function(x){ return x.id!==id; });
  // drop any shifts drafted for them
  Object.keys(kplDraft).forEach(function(k){ if(k.indexOf(id+'|')===0) delete kplDraft[k]; });
  kplCloseMove(); kplSaveDraft(); kplRender();
}
function kplCloseMove(ev){ if(ev && ev.target && !ev.target.classList.contains('kpl-ov')) return; document.getElementById('kpl-modalhost').innerHTML=''; }

// ── Add a brand-new person to a section (draft-only until Publish) ──
function kplOpenAddPerson(secKey){
  var sec = STATIONS_SCH.find(function(x){return x.key===secKey;}) || {label:secKey};
  var host = document.getElementById('kpl-modalhost');
  host.innerHTML = '<div class="kpl-ov" onclick="kplCloseAddPerson(event)"><div class="kpl-modal" onclick="event.stopPropagation()">'
    + '<h3>Add a person to '+schEvEsc(sec.label)+'</h3>'
    + '<div style="font-size:12px;color:var(--vino-light);margin-bottom:12px">They join your plan now. They only appear on the live schedule once you press <b>Put on the live schedule</b>.</div>'
    + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><span class="kpl-lbl" style="width:52px">Name</span><input type="text" id="kpl-ap-name" placeholder="e.g. Marco Rossi — or “new” for an open role" style="flex:1"></div>'
    + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px"><span class="kpl-lbl" style="width:52px">Role</span><input type="text" id="kpl-ap-role" placeholder="e.g. CDP, DCDP, Commis" style="flex:1"></div>'
    + '<div style="display:flex;justify-content:flex-end;gap:8px"><button class="kpl-btn" onclick="kplCloseAddPerson()">Cancel</button><button class="kpl-btn primary" onclick="kplAddPerson(\''+secKey+'\')">Add to plan</button></div>'
    + '</div></div>';
  setTimeout(function(){ var n=document.getElementById('kpl-ap-name'); if(n) n.focus(); }, 30);
}
function kplAddPerson(secKey){
  var name = (document.getElementById('kpl-ap-name').value||'').trim();
  var role = (document.getElementById('kpl-ap-role').value||'').trim();
  if(!name){ alert('Please type a name (or “new” for an open role to hire into).'); return; }
  kplNewSeq++;
  kplNewStaff.push({ id:'new-'+kplNewSeq, name:name, designation:role||null, station_key:secKey, _new:true });
  kplCloseAddPerson(); kplSaveDraft(); kplRender();
}
function kplCloseAddPerson(ev){ if(ev && ev.target && !ev.target.classList.contains('kpl-ov')) return; document.getElementById('kpl-modalhost').innerHTML=''; }
function kplCoverageRow(sec, people, dayW, totalCols){
  var row = '<tr class="kpl-cov"><td class="kpl-name">How many on <span style="cursor:pointer;opacity:.75;text-decoration:underline" onclick="kplEditMin(\''+sec.key+'\')" title="Set how many you need each day">need '+kplMinFor(sec.key,false)+' &#9998;</span></td>';
  for(var w=0; w<kplNumWeeks; w++){ for(var d=0; d<7; d++){
    var ds = kplDateISO(w,d);
    var c = kplSecDay(people, ds);
    var min = kplMinFor(sec.key, d>=5);
    if(c.any===0){ row += '<td style="color:#c9b89c">·</td>'; }   // nothing planned yet — not flagged
    else { row += '<td class="'+(c.work<min?'low':'')+'">'+c.work+'</td>'; }
  }}
  row += '<td class="kpl-tot" style="background:#faf6ee"></td></tr>';
  return row;
}
function kplMinFor(secKey, weekend){ var m=kplMins[secKey]||{}; return weekend ? (m.we!=null?m.we:1) : (m.wd!=null?m.wd:1); }
function kplEditMin(secKey){
  var m = kplMins[secKey]||{wd:1,we:1};
  var wd = prompt('Minimum people working on a WEEKDAY for '+ (kplSections().find(function(x){return x.key===secKey;})||{label:secKey}).label +':', m.wd!=null?m.wd:1);
  if(wd===null) return;
  var we = prompt('Minimum on a WEEKEND (Sat/Sun):', m.we!=null?m.we:1);
  if(we===null) return;
  kplMins[secKey] = { wd: Math.max(0,parseInt(wd,10)||0), we: Math.max(0,parseInt(we,10)||0) };
  kplSaveDraft(); kplRender();
}

// ── Cell editing (draft) ──
var kplDownAt = 0;
function kplCellDown(ev, sid, ds){ if(!kplPaint) return; kplPainting=true; kplPaintStroke={ label:kplPaintLabel(), cells:[], seen:{} }; kplApplyPaint(sid, ds); ev.preventDefault(); }
function kplCellEnter(sid, ds){ if(kplPaint && kplPainting){ kplApplyPaint(sid, ds); } }
function kplPaintLabel(){ if(!kplPaint) return 'paint'; return kplPaint.status==='__clear' ? 'clear' : (kplPaint.status==='working' ? 'paint shift' : ('paint ' + kplFriendly(kplPaint.status))); }
// End a paint drag: reset the flag, fold the WHOLE stroke into one undo step, then save + render.
// (Attached once at load — the old kplWirePaint was never called, so paint had no pointerup at all.)
document.addEventListener('pointerup', function(){
  if(!kplPainting) return;
  kplPainting = false;
  if(kplPaintStroke && kplPaintStroke.cells.length){
    var lbl = kplPaintStroke.label + (kplPaintStroke.cells.length>1 ? (' ('+kplPaintStroke.cells.length+' days)') : '');
    kplUndoStack.push({ label: lbl, cells: kplPaintStroke.cells });
    if (kplUndoStack.length > 30) kplUndoStack.shift();
  }
  kplPaintStroke = null;
  kplSaveDraft(); kplRender(); if(typeof kplRenderUndoBtn==='function') kplRenderUndoBtn();
});
function kplApplyPaint(sid, ds){
  var k = kplKey(sid,ds);
  if(kplPaintStroke && !kplPaintStroke.seen[k]){ kplPaintStroke.seen[k]=1; kplPaintStroke.cells.push({ key:k, prev: kplDraft[k] ? JSON.parse(JSON.stringify(kplDraft[k])) : null }); }
  if(kplPaint.status==='working') kplDraft[k]={status:'working', shift_start:KPL_DEF_START, shift_end:KPL_DEF_END, shift_start2:null, shift_end2:null, notes:(kplDraft[k]&&kplDraft[k].notes)||null};
  else if(kplPaint.status==='__clear') delete kplDraft[k];
  else kplDraft[k]={status:kplPaint.status, shift_start:null, shift_end:null, shift_start2:null, shift_end2:null, notes:(kplDraft[k]&&kplDraft[k].notes)||null};
  var td = document.querySelector('#kpl-wrap td[data-k="'+k+'"]');
  if(td){ // lightweight in-place repaint of just this cell for snappy drag
    var s = kplStaff.find(function(x){return x.id===sid;});
    if(s){ var tmp={days:0,off:0,hrs:0,al:0,ph:0}; td.outerHTML = kplCellHtml(s, ds, td.offsetWidth||30, (td.offsetWidth||30)>=46, td.classList.contains('wk'), td.classList.contains('we'), kplToday(), tmp); }
  }
}
var kplPaintCurrent='off';
function kplTogglePaint(){ if(kplPaint) kplPaintOff(); else { kplPaint={status:(kplPaintCurrent||'off')}; var f=document.getElementById('kpl-full'); if(f) f.classList.add('paint'); kplRenderControls(); kplRender(); } }
function kplPaintPick(v){ kplPaintCurrent=v; if(kplPaint){ kplPaint={status:v}; } document.getElementById('kpl-full').classList.toggle('paint', !!kplPaint); }
function kplPaintOff(){ kplPaint=null; var f=document.getElementById('kpl-full'); if(f) f.classList.remove('paint'); kplRenderControls(); }
function kplCellClick(sid, ds){ if(kplPasteOn){ kplPasteInto(sid, ds); return; } if(kplPaint) return; if(Date.now()-kplDownAt<0) return; kplOpenCellEditor(sid, ds); }

function kplOpenCellEditor(sid, ds){
  kplEditKey = kplKey(sid,ds);
  var s = kplStaff.find(function(x){return x.id===sid;});
  var e = kplDraft[kplEditKey] || {};
  var d = new Date(ds+'T12:00:00');
  var statusBtns = KPL_STATUSES.map(function(st){
    var code = kplCode(st);
    var lbl = kplFriendly(st) + (code?' <span style="opacity:.55;font-size:9px;font-weight:600">'+code+'</span>':'');
    var col = KPL_COLOR[st]||'#8a7d70';
    var bg = st==='working'?'#e9f1ea':(col+'22'); var fg = st==='working'?'#2f5233':(st==='cdo'?'#7a6400':col);
    return '<button class="kpl-qbtn'+((e.status||'working')===st?' on':'')+'" style="background:'+bg+';color:'+fg+'" onclick="kplPickStatus(\''+st+'\')">'+lbl+'</button>';
  }).join(' ');
  var st0=formatTime(e.shift_start)||KPL_DEF_START, et0=formatTime(e.shift_end)||KPL_DEF_END;
  var hasSplit = e.shift_start2&&e.shift_end2;
  var host = document.getElementById('kpl-modalhost');
  host.innerHTML = '<div class="kpl-ov" onclick="kplCloseCell(event)"><div class="kpl-modal" onclick="event.stopPropagation()">'
    + '<h3>'+(s?schEvEsc(s.name):'')+' &middot; '+d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'})+'</h3>'
    + '<div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--vino-light);margin-bottom:4px">Quick set — one tap</div>'
    + '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">'
    +   '<button class="kpl-qbtn" style="background:#f4e7c4;color:#77560f;text-align:center" onclick="kplApplyPreset(\'lunch\')">Lunch team<br><span style="font-size:9px;opacity:.75">10–15 · 19–00</span></button>'
    +   '<button class="kpl-qbtn" style="background:#e9f1ea;color:#2f5233;text-align:center" onclick="kplApplyPreset(\'dinner\')">Dinner team<br><span style="font-size:9px;opacity:.75">15–03</span></button>'
    +   '<button class="kpl-qbtn" style="background:#dbecea;color:#0f5b54;text-align:center" onclick="kplApplyPreset(\'evening\')">Evening<br><span style="font-size:9px;opacity:.75">14–00</span></button>'
    +   '<button class="kpl-qbtn" style="background:#f6dcd9;color:#8f2d24" onclick="kplApplyPreset(\'off\')">Day off</button>'
    + '</div>'
    + '<div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--vino-light);margin-bottom:4px">Or set it yourself</div>'
    + '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px" id="kpl-statusbtns">'+statusBtns+'</div>'
    + '<div id="kpl-timefields" style="display:'+((e.status||'working')==='working'?'block':'none')+'">'
    +   '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span class="kpl-lbl" style="width:52px">Shift</span>'
    +     '<input type="time" id="kpl-st" value="'+st0+'"> <span>–</span> <input type="time" id="kpl-et" value="'+et0+'"></div>'
    +   '<div id="kpl-split2" style="display:'+(hasSplit?'flex':'none')+';align-items:center;gap:8px;margin-bottom:8px"><span class="kpl-lbl" style="width:52px">Split</span>'
    +     '<input type="time" id="kpl-st2" value="'+(hasSplit?formatTime(e.shift_start2):'18:00')+'"> <span>–</span> <input type="time" id="kpl-et2" value="'+(hasSplit?formatTime(e.shift_end2):'00:00')+'"></div>'
    +   '<button class="kpl-btn" id="kpl-splitbtn" onclick="kplToggleSplit2()">'+(hasSplit?'− Remove split':'+ Add split shift')+'</button>'
    + '</div>'
    + '<div style="display:flex;align-items:center;gap:8px;margin:12px 0"><span class="kpl-lbl" style="width:52px">Note</span><input type="text" id="kpl-note" value="'+schEvEsc(e.notes||'')+'" placeholder="optional" style="flex:1"></div>'
    + '<div style="display:flex;justify-content:space-between;gap:8px;margin-top:6px;flex-wrap:wrap">'
    +   '<div style="display:flex;gap:8px"><button class="kpl-btn" onclick="kplClearCell()">Clear day</button><button class="kpl-btn" onclick="kplCopyShiftFromEditor()" title="Copy this shift, then tap other days to paste it">Copy to other days</button></div>'
    +   '<div style="display:flex;gap:8px"><button class="kpl-btn" onclick="kplCloseCell()">Cancel</button><button class="kpl-btn primary" onclick="kplSaveCell()">Save</button></div>'
    + '</div></div></div>';
  kplPickStatus._cur = e.status||'working';
}
function kplPickStatus(st){
  kplPickStatus._cur = st;
  var host=document.getElementById('kpl-statusbtns');
  Array.prototype.forEach.call(host.querySelectorAll('.kpl-qbtn'), function(b){ b.classList.remove('on'); });
  var idx = KPL_STATUSES.indexOf(st); if(idx>=0) host.children[idx].classList.add('on');
  document.getElementById('kpl-timefields').style.display = st==='working'?'block':'none';
}
function kplToggleSplit2(){ var f=document.getElementById('kpl-split2'), b=document.getElementById('kpl-splitbtn'); var open=f.style.display!=='none'; f.style.display=open?'none':'flex'; b.textContent=open?'+ Add split shift':'− Remove split'; }
function kplClearCell(){ if(kplEditKey){ kplPushUndo([kplEditKey], 'clear ' + kplKeyLabel(kplEditKey)); delete kplDraft[kplEditKey]; } kplCloseCell(); kplSaveDraft(); kplRender(); }
function kplApplyPreset(kind){
  if(!kplEditKey) return;
  kplPushUndo([kplEditKey], 'set ' + kplKeyLabel(kplEditKey));
  var prev=kplDraft[kplEditKey]||{}; var e;
  if(kind==='lunch')        e={status:'working',shift_start:'10:00',shift_end:'15:00',shift_start2:'19:00',shift_end2:'00:00'};
  else if(kind==='dinner')  e={status:'working',shift_start:'15:00',shift_end:'03:00',shift_start2:null,shift_end2:null};
  else if(kind==='evening') e={status:'working',shift_start:'14:00',shift_end:'00:00',shift_start2:null,shift_end2:null};
  else                      e={status:'off',shift_start:null,shift_end:null,shift_start2:null,shift_end2:null};
  e.notes=prev.notes||null;
  kplDraft[kplEditKey]=e; kplCloseCell(); kplSaveDraft(); kplRender();
}
function kplReadEditorEntry(){
  var st = kplPickStatus._cur||'working';
  var e = { status:st, shift_start:null, shift_end:null, shift_start2:null, shift_end2:null, notes:(document.getElementById('kpl-note').value.trim()||null) };
  if(st==='working'){
    e.shift_start = document.getElementById('kpl-st').value||null;
    e.shift_end   = document.getElementById('kpl-et').value||null;
    if(document.getElementById('kpl-split2').style.display!=='none'){ e.shift_start2=document.getElementById('kpl-st2').value||null; e.shift_end2=document.getElementById('kpl-et2').value||null; }
  }
  return e;
}
function kplSaveCell(){
  if(!kplEditKey) return;
  kplPushUndo([kplEditKey], 'edit ' + kplKeyLabel(kplEditKey));
  kplDraft[kplEditKey] = kplReadEditorEntry();
  kplCloseCell(); kplSaveDraft(); kplRender();
}
function kplCloseCell(ev){ if(ev && ev.target && !ev.target.classList.contains('kpl-ov')) return; document.getElementById('kpl-modalhost').innerHTML=''; kplEditKey=null; }

// ── Copy one shift, then tap other cells to paste it (Excel-style fill) ──
var kplShiftClip = null;    // { status, shift_start…, srcStaff, srcDate, label }
var kplPasteOn   = false;
var kplPasteCount= 0;
var kplUndoStack = [];      // Excel-style undo for the planning draft: [{label, cells:[{key, prev}]}], newest last
function kplShiftLabel(e){
  if(e.status==='working') return (e.shift_start||'')+(e.shift_end?'–'+e.shift_end:'')+(e.shift_start2&&e.shift_end2?' + '+e.shift_start2+'–'+e.shift_end2:'');
  return kplFriendly(e.status);
}
function kplCopyShiftFromEditor(){
  if(!kplEditKey) return;
  var e = kplReadEditorEntry();
  kplPushUndo([kplEditKey], 'edit ' + kplKeyLabel(kplEditKey));
  kplDraft[kplEditKey] = e;                 // keep the cell you copied from set too
  var parts = kplEditKey.split('|');
  kplShiftClip = Object.assign({}, e, { srcStaff:parts[0], srcDate:parts[1], label:kplShiftLabel(e) });
  kplCloseCell(); kplSaveDraft(); kplRender();
  kplPasteOn = true; kplPasteCount = 0; kplShowPasteBar();
}
function kplPasteInto(sid, ds, _noUndo){
  if(!kplShiftClip) return;
  var key = kplKey(sid,ds);
  if(!_noUndo) kplPushUndo([key], 'paste to ' + kplStaffName(sid) + ', ' + kplDayLbl(ds));
  kplDraft[key] = { status:kplShiftClip.status, shift_start:kplShiftClip.shift_start, shift_end:kplShiftClip.shift_end,
    shift_start2:kplShiftClip.shift_start2, shift_end2:kplShiftClip.shift_end2, notes:kplShiftClip.notes||null };
  kplPasteCount++; kplSaveDraft(); kplRender(); kplShowPasteBar();
}
function kplFillPersonWeek(){
  if(!kplShiftClip) return;
  var mon = getMonday(new Date(kplShiftClip.srcDate+'T12:00:00'));
  var keys = []; for(var i=0;i<7;i++){ keys.push(kplKey(kplShiftClip.srcStaff, formatDate(addDays(mon,i)))); }
  kplPushUndo(keys, 'fill ' + kplStaffName(kplShiftClip.srcStaff) + '’s week');   // one undo step for the whole fill
  for(var d=0; d<7; d++){ kplPasteInto(kplShiftClip.srcStaff, formatDate(addDays(mon,d)), true); }
}
function kplFillDay(){
  if(!kplShiftClip) return;
  var ppl = kplAllPeople();
  kplPushUndo(ppl.map(function(s){ return kplKey(s.id, kplShiftClip.srcDate); }), 'fill whole day ' + kplDayLbl(kplShiftClip.srcDate));
  ppl.forEach(function(s){ kplPasteInto(s.id, kplShiftClip.srcDate, true); });
}
function kplShowPasteBar(){
  var host = document.getElementById('kpl-full') || document.body;
  var bar = document.getElementById('kpl-paste-bar');
  if(!bar){
    bar = document.createElement('div'); bar.id='kpl-paste-bar';
    bar.style.cssText='position:fixed;left:50%;transform:translateX(-50%);bottom:20px;z-index:4350;background:var(--vino);color:#f6ece0;padding:10px 14px;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.35);display:flex;align-items:center;gap:9px;font-family:var(--font-sans);font-size:13px;max-width:94vw;flex-wrap:wrap;justify-content:center';
    host.appendChild(bar);
  }
  var bs='padding:7px 12px;border:1px solid rgba(255,255,255,.5);background:rgba(255,255,255,.12);color:#f6ece0;border-radius:7px;cursor:pointer;font:inherit;font-weight:600';
  var msg = kplPasteCount
    ? ('Pasted to '+kplPasteCount+' '+(kplPasteCount===1?'day':'days')+' &middot; keep tapping cells, or stop below')
    : ('Copied <b>'+(kplShiftClip?kplShiftClip.label:'')+'</b> &middot; tap any day to paste it');
  bar.innerHTML = '<span>'+msg+'</span>'
    + '<button style="'+bs+'" onclick="kplFillPersonWeek()">Fill this person’s week</button>'
    + '<button style="'+bs+'" onclick="kplFillDay()">Fill this whole day</button>'
    + '<button style="'+bs+';background:var(--sabbia);color:var(--vino)" onclick="kplEndPaste()">&#10005; Stop pasting (Esc)</button>';
  bar.style.display='flex';
}
function kplEndPaste(){ kplPasteOn=false; kplShiftClip=null; kplPasteCount=0; var b=document.getElementById('kpl-paste-bar'); if(b) b.style.display='none'; }

// ── Excel-style undo for the planning tool ────────────────────────────────────
// Every draft change (cell edit, preset, clear, paste, fill week/day) snapshots
// the affected cells' prior draft state before writing. Undo restores it and
// re-renders. Draft-only — nothing here touches the live DB (that happens on
// Bring live), so undo is a pure in-memory restore. Multi-level, newest-first.
function kplStaffName(id){ var s = kplAllPeople().find(function(x){ return x.id===id; }); return s ? s.name : 'staff'; }
function kplDayLbl(ds){ try { return new Date(ds+'T12:00:00').toLocaleDateString('en-GB',{ weekday:'short', day:'numeric' }); } catch(e){ return ds; } }
function kplKeyLabel(key){ var p = String(key).split('|'); return kplStaffName(p[0]) + ', ' + kplDayLbl(p[1]); }
function kplPushUndo(keys, label){
  var cells = keys.map(function(k){ return { key:k, prev: kplDraft[k] ? JSON.parse(JSON.stringify(kplDraft[k])) : null }; });
  kplUndoStack.push({ label: label || 'change', cells: cells });
  if (kplUndoStack.length > 30) kplUndoStack.shift();
  kplRenderUndoBtn();
}
function kplUndoLast(){
  if (!kplUndoStack.length) return;
  var u = kplUndoStack.pop();
  u.cells.forEach(function(c){ if (c.prev) kplDraft[c.key] = c.prev; else delete kplDraft[c.key]; });
  kplSaveDraft(); kplRender(); kplRenderUndoBtn();
}
function kplRenderUndoBtn(){
  var host = document.getElementById('kpl-full');
  var show = host && host.style.display !== 'none' && kplMode === 'draft' && kplUndoStack.length > 0;
  var btn = document.getElementById('kpl-undo-btn');
  if (!show){ if (btn) btn.style.display = 'none'; return; }
  if (!btn){
    btn = document.createElement('button'); btn.id = 'kpl-undo-btn'; btn.type = 'button'; btn.onclick = kplUndoLast;
    btn.style.cssText = 'position:fixed;left:14px;bottom:20px;z-index:4400;background:#fff;color:var(--vino);border:1.5px solid var(--vino);padding:9px 14px;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.28);font-family:var(--font-sans);font-size:13px;font-weight:700;cursor:pointer;max-width:60vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    host.appendChild(btn);
  }
  var last = kplUndoStack[kplUndoStack.length - 1];
  btn.title = 'Undo: ' + last.label + (kplUndoStack.length > 1 ? ('  (' + kplUndoStack.length + ' changes can be undone)') : '');
  btn.innerHTML = '&#8630; Undo' + (kplUndoStack.length > 1 ? (' (' + kplUndoStack.length + ')') : '') + ' &middot; ' + last.label;
  btn.style.display = 'block';
}
// Ctrl/Cmd+Z in the planning tool — but let text fields keep their native undo.
document.addEventListener('keydown', function(e){
  if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey){
    var host = document.getElementById('kpl-full');
    if (!host || host.style.display === 'none' || kplMode !== 'draft') return;
    var el = document.activeElement;
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    if (!kplUndoStack.length) return;
    e.preventDefault(); kplUndoLast();
  }
});
document.addEventListener('keydown', function(e){ if(e.key==='Escape' && kplPasteOn) kplEndPaste(); });

// ── Copy / paste week ──
function kplCopyWeek(w){ kplWkClip=w; kplRender(); var s=document.getElementById('kpl-saved'); if(s){ s.textContent='Week '+(w+1)+' copied'; s.style.opacity='1'; } }
function kplPasteWeek(w){
  if(kplWkClip===null || kplWkClip===w) return;
  if(!confirm('Paste week '+(kplWkClip+1)+' onto week '+(w+1)+'? This overwrites week '+(w+1)+' in the draft (all people shown or hidden).')) return;
  var affected = kplFilterPer==='all' ? kplStaff : kplStaff.filter(function(s){return s.id===kplFilterPer;});
  var _wk=[]; affected.forEach(function(s){ for(var d=0; d<7; d++){ _wk.push(kplKey(s.id,kplDateISO(w,d))); } });
  kplPushUndo(_wk, 'paste week '+(kplWkClip+1)+' → week '+(w+1));
  affected.forEach(function(s){ for(var d=0; d<7; d++){ var src=kplDraft[kplKey(s.id,kplDateISO(kplWkClip,d))]; var dk=kplKey(s.id,kplDateISO(w,d)); if(src) kplDraft[dk]=Object.assign({},src); else delete kplDraft[dk]; } });
  kplSaveDraft(); kplRender();
}

// ── Bulk fill / patterns ──
function kplOpenBulk(){
  var host=document.getElementById('kpl-modalhost');
  var wkChecks=''; for(var w=0; w<kplNumWeeks; w++) wkChecks+='<label style="display:inline-flex;align-items:center;gap:3px;margin-right:8px;font-size:12px"><input type="checkbox" class="kpl-wkchk" value="'+w+'" checked> W'+(w+1)+'</label>';
  var secOpts = kplSections().map(function(s){return '<option value="'+s.key+'">'+s.label+'</option>';}).join('');
  var perOpts = kplStaff.map(function(s){return '<option value="'+s.id+'">'+schEvEsc(s.name)+'</option>';}).join('');
  var days=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  function patRow(prefix,label){
    var cells=days.map(function(dn,i){
      var opts=['','working','off','wo','al','ph','tr'].map(function(o){ var t=o===''?'leave as is':kplFriendly(o); return '<option value="'+o+'">'+t+'</option>'; }).join('');
      return '<td style="padding:2px"><div style="font-size:9px;color:var(--vino-light)">'+dn+'</div><select class="kpl-sel '+prefix+'" data-d="'+i+'" style="padding:2px 3px;font-size:11px">'+opts+'</select></td>';
    }).join('');
    return '<div style="margin:6px 0"><div class="kpl-lbl" style="margin-bottom:2px">'+label+'</div><table><tr>'+cells+'</tr></table></div>';
  }
  host.innerHTML = '<div class="kpl-ov" onclick="kplCloseBulk(event)"><div class="kpl-modal" style="max-width:640px" onclick="event.stopPropagation()">'
    + '<h3>&#9776; Fill many days at once</h3>'
    + '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:8px">'
    +   '<span class="kpl-lbl">Who</span>'
    +   '<select class="kpl-sel" id="kpl-bulk-who" onchange="kplBulkWhoChange()"><option value="all">Everyone shown</option><option value="section">A section…</option><option value="person">One person…</option></select>'
    +   '<select class="kpl-sel" id="kpl-bulk-sec" style="display:none">'+secOpts+'</select>'
    +   '<select class="kpl-sel" id="kpl-bulk-per" style="display:none">'+perOpts+'</select>'
    + '</div>'
    + '<div style="margin-bottom:8px"><span class="kpl-lbl">Weeks</span><br>'+wkChecks+'</div>'
    + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">'
    +   '<span class="kpl-lbl">Working time</span><input type="time" id="kpl-bulk-st" value="'+KPL_DEF_START+'"> – <input type="time" id="kpl-bulk-et" value="'+KPL_DEF_END+'">'
    +   '<label style="font-size:12px;margin-left:auto;display:inline-flex;align-items:center;gap:4px"><input type="checkbox" id="kpl-bulk-alt" onchange="document.getElementById(\'kpl-patB\').style.display=this.checked?\'block\':\'none\'"> Make every other week different</label>'
    + '</div>'
    + '<div style="border:1px solid var(--sabbia-dark);border-radius:8px;padding:6px 8px">'
    +   patRow('kpl-patA','Set each day')
    +   '<div id="kpl-patB" style="display:none">'+patRow('kpl-patB','Every other week (different)')+'</div>'
    +   '<div style="font-size:11px;color:var(--vino-light);margin-top:4px">Leave a day on “leave as is” to keep what’s already there.</div>'
    + '</div>'
    + '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px"><button class="kpl-btn" onclick="kplCloseBulk()">Cancel</button><button class="kpl-btn primary" onclick="kplApplyBulk()">Apply to draft</button></div>'
    + '</div></div>';
}
function kplBulkWhoChange(){ var v=document.getElementById('kpl-bulk-who').value; document.getElementById('kpl-bulk-sec').style.display=v==='section'?'inline-block':'none'; document.getElementById('kpl-bulk-per').style.display=v==='person'?'inline-block':'none'; }
function kplCloseBulk(ev){ if(ev && ev.target && !ev.target.classList.contains('kpl-ov')) return; document.getElementById('kpl-modalhost').innerHTML=''; }
function kplReadPattern(prefix){ var p={}; Array.prototype.forEach.call(document.querySelectorAll('.'+prefix), function(sel){ p[parseInt(sel.getAttribute('data-d'),10)] = sel.value; }); return p; }
function kplApplyBulk(){
  var who=document.getElementById('kpl-bulk-who').value;
  var people;
  if(who==='section'){ var sk=document.getElementById('kpl-bulk-sec').value; people=kplStaffInSecAll(sk); }
  else if(who==='person'){ var pid=document.getElementById('kpl-bulk-per').value; people=kplStaff.filter(function(s){return s.id===pid;}); }
  else { people = kplFilterPer==='all' ? (kplFilterSec==='all'?kplStaff:kplStaffInSecAll(kplFilterSec)) : kplStaff.filter(function(s){return s.id===kplFilterPer;}); }
  var weeks=[]; Array.prototype.forEach.call(document.querySelectorAll('.kpl-wkchk'), function(c){ if(c.checked) weeks.push(parseInt(c.value,10)); });
  if(!weeks.length){ alert('Pick at least one week.'); return; }
  var st=document.getElementById('kpl-bulk-st').value||KPL_DEF_START, et=document.getElementById('kpl-bulk-et').value||KPL_DEF_END;
  var alt=document.getElementById('kpl-bulk-alt').checked;
  var patA=kplReadPattern('kpl-patA'), patB=alt?kplReadPattern('kpl-patB'):patA;
  var _bk=[]; people.forEach(function(s){ weeks.forEach(function(w){ var pat=(alt && (w%2===1))?patB:patA; for(var d=0; d<7; d++){ var v=pat[d]; if(v===undefined||v==='') continue; _bk.push(kplKey(s.id,kplDateISO(w,d))); } }); });
  if(_bk.length) kplPushUndo(_bk, 'bulk fill ('+_bk.length+' cells)');
  var n=0;
  people.forEach(function(s){ weeks.forEach(function(w){ var pat=(alt && (w%2===1))?patB:patA; for(var d=0; d<7; d++){ var v=pat[d]; if(v===undefined||v==='') continue; var k=kplKey(s.id,kplDateISO(w,d)); if(v==='working') kplDraft[k]={status:'working',shift_start:st,shift_end:et,shift_start2:null,shift_end2:null,notes:(kplDraft[k]&&kplDraft[k].notes)||null}; else kplDraft[k]={status:v,shift_start:null,shift_end:null,shift_start2:null,shift_end2:null,notes:(kplDraft[k]&&kplDraft[k].notes)||null}; n++; } }); });
  kplCloseBulk(); kplSaveDraft(); kplRender();
  var sv=document.getElementById('kpl-saved'); if(sv){ sv.textContent='✓ Applied '+n+' cells'; sv.style.opacity='1'; }
}
function kplStaffInSecAll(secKey){ return kplAllPeople().filter(function(s){ var sk=kplEffSec(s); return secKey==='__other' ? (!sk||!STATIONS_SCH.some(function(x){return x.key===sk;})) : sk===secKey; }); }
// Working vs any-entry count for a section on a day (used so a totally-blank day
// reads as "not planned yet", not "short-staffed").
function kplSecDay(people, ds){ var work=0, any=0; people.forEach(function(s){ var e=kplEntry(s.id,ds); if(e&&e.status){ any++; if(e.status==='working'&&e.shift_start&&e.shift_end) work++; } }); return {work:work, any:any}; }

// ── One-tap: give everyone a week off, spread out (app does the math — rule-based, no guessing) ──
function kplAutoWeekOff(){
  var weeks=[]; for(var w=0; w<kplNumWeeks; w++) weeks.push(w);
  var assigned=0, maxPerSecWeek=1;
  kplSections().forEach(function(sec){
    var people=kplStaffInSecAll(sec.key); if(!people.length) return;
    var load={}; weeks.forEach(function(w){ load[w]=0; });
    var already={};
    // respect any full-week vacation the planner already set
    people.forEach(function(s){ for(var w=0; w<kplNumWeeks; w++){ var full=true; for(var d=0;d<7;d++){ if((kplDraft[kplKey(s.id,kplDateISO(w,d))]||{}).status!=='al'){ full=false; break; } } if(full){ already[s.id]=w; load[w]++; break; } } });
    people.forEach(function(s){
      if(already[s.id]!=null) return;
      var best=weeks[0]; weeks.forEach(function(w){ if(load[w]<load[best]) best=w; });   // least-loaded week
      for(var d=0; d<7; d++) kplDraft[kplKey(s.id,kplDateISO(best,d))]={status:'al',shift_start:null,shift_end:null,shift_start2:null,shift_end2:null,notes:null};
      load[best]++; assigned++;
    });
    weeks.forEach(function(w){ if(load[w]>maxPerSecWeek) maxPerSecWeek=load[w]; });
  });
  return { assigned:assigned, maxPerSecWeek:maxPerSecWeek };
}
function kplGiveEveryoneWeekOff(){
  if(kplMode!=='draft'){ alert('Press “Start planning” first, then try again.'); return; }
  var n=kplStaff.length;
  if(!confirm('Give each of the '+n+' people ONE week off (Vacation), spread across the '+kplNumWeeks+' weeks so as few as possible are off together?\n\nThis only changes your draft — nothing goes to the team until you press “Put on schedule”. You can adjust anyone afterwards.')) return;
  var r=kplAutoWeekOff();
  kplSaveDraft(); kplRender();
  var sv=document.getElementById('kpl-saved'); if(sv){ sv.textContent='✓ Everyone has a week off'; sv.style.opacity='1'; }
  setTimeout(function(){ alert('Done ✓\n\nEveryone now has one week off (Vacation), spread out.\nAt most '+r.maxPerSecWeek+' person from the same section is off in any single week.\n\nTip: tap “Check for problems” to see coverage, or tap any week to fine-tune.'); }, 60);
}

// ── One-tap: give everyone their 2 days off a week, staggered off the busy days ──
function kplAutoDaysOff(){
  var quiet=[0,1,2,6];   // Mon,Tue,Wed,Sun preferred (keep Thu–Sat busy fully staffed)
  var assigned=0;
  kplSections().forEach(function(sec){
    var ppl=kplStaffInSecAll(sec.key);
    ppl.forEach(function(s, idx){
      var a=quiet[(idx*2)%quiet.length], b=quiet[(idx*2+1)%quiet.length];
      for(var w=0; w<kplNumWeeks; w++){
        [a,b].forEach(function(d){ var k=kplKey(s.id,kplDateISO(w,d)); var cur=kplDraft[k]||{}; if(cur.status==='al') return; kplDraft[k]={status:'off',shift_start:null,shift_end:null,shift_start2:null,shift_end2:null,notes:cur.notes||null}; assigned++; });
      }
    });
  });
  return {assigned:assigned};
}
function kplGiveEveryoneDaysOff(){
  if(kplMode!=='draft'){ alert('Press “Start planning” first, then try again.'); return; }
  if(!confirm('Give everyone 2 days off each week, spread out so the busy days (Thu–Sat) stay covered?\n\nThis marks the days off in your draft — you can move anyone’s days after. Vacation weeks are left alone.')) return;
  kplAutoDaysOff();
  kplSaveDraft(); kplRender();
  var sv=document.getElementById('kpl-saved'); if(sv){ sv.textContent='✓ Days off added'; sv.style.opacity='1'; }
  setTimeout(function(){ alert('Done ✓  Everyone now has 2 days off a week, kept off the busy Thu–Sat where possible.\n\nCheck the bottom row (or “Check for problems”) for coverage, and tap any day to move a day off.'); },60);
}

// ── Print / Save-PDF the plan straight from the tool (the Excel-killer) ──
function kplPrintPlan(){
  var dl=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  var dates=[]; for(var i=0;i<kplNumWeeks*7;i++) dates.push(kplDateISO(Math.floor(i/7),i%7));
  var draft = (kplMode==='draft');
  function cell(e){
    if(!e||!e.status) return {t:'', c:'#fff', x:'#bbb'};
    if(e.status==='al') return {t:'VAC', c:'#cfe8d6', x:'#0d5030'};
    if(e.status==='off'||e.status==='wo') return {t:'OFF', c:'#f6dcd9', x:'#8f2d24'};
    if(e.status==='working'){
      var a=(formatTime(e.shift_start)||'').replace(':00',''), b=(formatTime(e.shift_end)||'').replace(':00','');
      var split=e.shift_start2&&e.shift_end2;
      if(split){ var a2=(formatTime(e.shift_start2)||'').replace(':00',''), b2=(formatTime(e.shift_end2)||'').replace(':00',''); return {t:a+'–'+b+' / '+a2+'–'+b2, c:'#f4e7c4', x:'#77560f'}; }
      return {t:(a?a+'–'+b:'ON'), c:'#e9f1ea', x:'#2f5233'};
    }
    return {t:e.status.toUpperCase(), c:'#eee', x:'#555'};
  }
  var head='<tr><th class="nm">Chef</th>';
  for(var w=0;w<kplNumWeeks;w++) head+='<th class="wk" colspan="7">Week '+(w+1)+' · '+new Date(dates[w*7]+'T12:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'short'})+'</th>';
  head+='</tr><tr><th class="nm"></th>';
  for(var i=0;i<dates.length;i++){ var g=new Date(dates[i]+'T12:00:00').getDay(); head+='<th class="dh">'+['S','M','T','W','T','F','S'][g]+'<br>'+new Date(dates[i]+'T12:00:00').getDate()+'</th>'; }
  head+='</tr>';
  var body='';
  kplSections().forEach(function(sec){
    var ppl=kplStaffInSecAll(sec.key); if(!ppl.length) return;
    body+='<tr class="sec"><td colspan="'+(dates.length+1)+'">'+sec.label+'</td></tr>';
    ppl.forEach(function(s){
      body+='<tr><td class="nm">'+s.name+'</td>';
      for(var i=0;i<dates.length;i++){ var c=cell(kplDraft[kplKey(s.id,dates[i])]||kplLive[kplKey(s.id,dates[i])]); body+='<td style="background:'+c.c+';color:'+c.x+'">'+(c.t||'·')+'</td>'; }
      body+='</tr>';
    });
  });
  var span=new Date(dates[0]+'T12:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'short'})+' – '+new Date(dates[dates.length-1]+'T12:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
  var doc='<!doctype html><html><head><meta charset="utf-8"><title>Kitchen roster '+span+'</title><style>'
    +'@page{size:A3 landscape;margin:9mm}body{font-family:Arial,Helvetica,sans-serif;color:#2b2320;margin:16px}'
    +'h1{font-family:Georgia,serif;color:#400207;margin:0 0 2px;font-size:20px}.s{color:#8c7d6d;font-style:italic;margin:0 0 12px;font-size:13px}'
    +'table{border-collapse:collapse;font-size:9.5px;width:100%}th,td{border:1px solid #e7dccb;padding:2px 3px;text-align:center;white-space:nowrap}'
    +'.nm{text-align:left;font-weight:bold;min-width:120px;font-size:11px}.wk{background:#400207;color:#fff;font-size:10px}.dh{background:#FBF8F2;color:#400207;font-size:9px}'
    +'.sec td{background:#E8D9C7;color:#400207;text-align:left;font-weight:bold;letter-spacing:1px;text-transform:uppercase;font-size:9px}'
    +'.legend{margin-top:10px;font-size:11px;color:#555}.legend span{display:inline-block;padding:1px 6px;border-radius:3px;margin-right:8px}'
    +'</style></head><body>'
    +'<h1>Roberto’s Kitchen — Roster'+(draft?' (DRAFT)':'')+'</h1><p class="s">'+span+' · '+(draft?'Draft plan — not on the live schedule':'From the live schedule')+'</p>'
    +'<table>'+head+body+'</table>'
    +'<div class="legend"><span style="background:#f4e7c4;color:#77560f">10–15 / 19–00 Lunch (split)</span><span style="background:#e9f1ea;color:#2f5233">Dinner</span><span style="background:#cfe8d6;color:#0d5030">VAC</span><span style="background:#f6dcd9;color:#8f2d24">OFF</span></div>'
    +'</body></html>';
  var wpop=window.open('','_blank');
  if(!wpop){ alert('Please allow pop-ups so the roster can open for printing — or use your browser’s Print (Ctrl/Cmd + P).'); return; }
  wpop.document.write(doc); wpop.document.close(); wpop.focus();
  setTimeout(function(){ try{ wpop.print(); }catch(e){} }, 400);
}
function kplV(id){ var el=document.getElementById(id); return el?el.value:''; }

// ── Openers: 1 per section starts early, everyone else the normal shift (two shift-tiers on a day) ──
function kplOpenOpeners(){
  if(kplMode!=='draft'){ alert('Press “Start planning” first, then try again.'); return; }
  var days=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  var dayChecks=days.map(function(dn,i){ return '<label style="display:inline-flex;align-items:center;gap:3px;margin-right:8px;font-size:12px"><input type="checkbox" class="kpl-opday" value="'+i+'"'+(i<6?' checked':'')+'> '+dn+'</label>'; }).join('');
  var host=document.getElementById('kpl-modalhost');
  host.innerHTML='<div class="kpl-ov" onclick="kplCloseOpeners(event)"><div class="kpl-modal" onclick="event.stopPropagation()">'
    + '<h3>Set lunch &amp; dinner teams</h3>'
    + '<div style="font-size:12px;color:var(--vino-light);margin-bottom:10px">On the days you pick, <b>1 person per section</b> is on the <b>lunch team</b> (early, split shift) and <b>everyone else</b> is on the <b>dinner team</b>. People already on a day off or vacation are left alone.</div>'
    + '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap"><span class="kpl-lbl" style="width:150px">Lunch team (1 per section)</span><input type="time" id="kpl-lun-s" value="10:00"> – <input type="time" id="kpl-lun-e" value="15:00"> <span style="color:var(--vino-light);font-size:11px">break, then</span> <input type="time" id="kpl-lun2-s" value="19:00"> – <input type="time" id="kpl-lun2-e" value="00:00"></div>'
    + '<div style="display:flex;align-items:center;gap:6px;margin-bottom:10px"><span class="kpl-lbl" style="width:150px">Dinner team (the rest)</span><input type="time" id="kpl-din-s" value="15:00"> – <input type="time" id="kpl-din-e" value="03:00"></div>'
    + '<div style="margin-bottom:6px"><span class="kpl-lbl">On these days</span><br>'+dayChecks+'</div>'
    + '<div style="font-size:11px;color:var(--vino-light)">Applies to all '+kplNumWeeks+' weeks. This puts everyone shown in on those days — add days off after (or use “Give everyone their days off”). Leave a day unticked to plan it yourself.</div>'
    + '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px"><button class="kpl-btn" onclick="kplCloseOpeners()">Cancel</button><button class="kpl-btn primary" onclick="kplApplyOpeners()">Apply to draft</button></div>'
    + '</div></div>';
}
function kplCloseOpeners(ev){ if(ev&&ev.target&&!ev.target.classList.contains('kpl-ov'))return; document.getElementById('kpl-modalhost').innerHTML=''; }
function kplApplyOpeners(){
  var ls=kplV('kpl-lun-s')||'10:00', le=kplV('kpl-lun-e')||'15:00', ls2=kplV('kpl-lun2-s')||'19:00', le2=kplV('kpl-lun2-e')||'00:00';
  var ds=kplV('kpl-din-s')||'15:00', de=kplV('kpl-din-e')||'03:00';
  var days=[]; document.querySelectorAll('.kpl-opday').forEach(function(c){ if(c.checked) days.push(parseInt(c.value,10)); });
  if(!days.length){ alert('Pick at least one day.'); return; }
  var leave={off:1,wo:1,al:1,ph:1,sl:1,em:1};   // don't drag people off leave into work
  var lunch=0, dinner=0;
  kplSections().forEach(function(sec){
    var people=kplStaffInSecAll(sec.key); if(!people.length) return;
    for(var w=0; w<kplNumWeeks; w++){ days.forEach(function(d){ var dd=kplDateISO(w,d); var firstDone=false;
      people.forEach(function(s){ var k=kplKey(s.id,dd); var cur=kplDraft[k]||{}; if(cur.status && leave[cur.status]) return;
        if(!firstDone){ kplDraft[k]={status:'working',shift_start:ls,shift_end:le,shift_start2:ls2,shift_end2:le2,notes:cur.notes||null}; firstDone=true; lunch++; }
        else { kplDraft[k]={status:'working',shift_start:ds,shift_end:de,shift_start2:null,shift_end2:null,notes:cur.notes||null}; dinner++; }
      });
    }); }
  });
  kplCloseOpeners(); kplSaveDraft(); kplRender();
  var sv=document.getElementById('kpl-saved'); if(sv){ sv.textContent='✓ Teams set ('+lunch+' lunch, '+dinner+' dinner)'; sv.style.opacity='1'; }
}

// ── Staffing calculator: how many people to run this operating model (pure math, no guessing) ──
function kplOpenCalc(){
  var secN=STATIONS_SCH.length;
  var host=document.getElementById('kpl-modalhost');
  function num(lbl,id,val,hint){ return '<div style="display:flex;align-items:center;gap:8px;margin:5px 0"><span class="kpl-lbl" style="width:210px">'+lbl+'</span><input type="number" min="0" id="'+id+'" value="'+val+'" style="width:70px">'+(hint?'<span style="font-size:11px;color:var(--vino-light)">'+hint+'</span>':'')+'</div>'; }
  host.innerHTML='<div class="kpl-ov" onclick="kplCloseCalc(event)"><div class="kpl-modal" onclick="event.stopPropagation()">'
    + '<h3>How many people do we need?</h3>'
    + '<div style="font-size:12px;color:var(--vino-light);margin-bottom:10px">A quick estimate for an operating plan (e.g. open 7 days, lunch & dinner, everyone gets days off). Change the numbers to match what the head chef wants.</div>'
    + num('Open days per week','kc-days','7','')
    + num('Services per day','kc-serv','2','lunch + dinner = 2')
    + num('People needed per section, each service','kc-min','1','')
    + num('Days off per person, per week','kc-off','2','')
    + num('How many sections','kc-sec',String(secN),'')
    + '<div style="display:flex;align-items:center;gap:8px;margin:8px 0"><input type="checkbox" id="kc-double" style="width:16px;height:16px"><span style="font-size:12px">One person can cover <b>both</b> lunch &amp; dinner the same day (double shift)</span></div>'
    + '<div style="display:flex;justify-content:flex-end;gap:8px;margin:6px 0"><button class="kpl-btn primary" onclick="kplRunCalc()">Calculate</button></div>'
    + '<div id="kc-result" style="margin-top:8px"></div>'
    + '<div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="kpl-btn" onclick="kplCloseCalc()">Close</button></div>'
    + '</div></div>';
  kplRunCalc();
}
function kplCloseCalc(ev){ if(ev&&ev.target&&!ev.target.classList.contains('kpl-ov'))return; document.getElementById('kpl-modalhost').innerHTML=''; }
function kplRunCalc(){
  var days=Math.max(1,parseInt(kplV('kc-days'),10)||7), serv=Math.max(1,parseInt(kplV('kc-serv'),10)||2), min=Math.max(1,parseInt(kplV('kc-min'),10)||1), off=Math.min(6,Math.max(0,parseInt(kplV('kc-off'),10)||2)), sec=Math.max(1,parseInt(kplV('kc-sec'),10)||1);
  var dbl=document.getElementById('kc-double') && document.getElementById('kc-double').checked;
  var workDays=Math.max(1, 7-off);
  var shiftsPerSection = days*serv*min;                 // service-slots to cover per section per week
  var perPerson = workDays*(dbl?serv:1);                // service-slots one person can cover per week
  var perSection = Math.ceil(shiftsPerSection/perPerson);
  var total = perSection*sec;
  var have = schedStaff.length;
  var gap = total-have;
  var box=document.getElementById('kc-result'); if(!box) return;
  box.innerHTML='<div style="background:#eef3ec;border:1px solid #a9d8bf;border-radius:8px;padding:10px 12px">'
    + '<div style="font-size:15px;color:#0f5132;font-weight:700">≈ '+perSection+' people per section &times; '+sec+' sections = '+total+' people</div>'
    + '<div style="font-size:12px;color:#356;margin-top:6px">Each person works '+workDays+' days/week and covers '+(dbl?'both services':'one service')+' a day. To open '+days+' days with '+min+' per section per service, that’s '+shiftsPerSection+' service-slots each week per section.</div>'
    + '<div style="font-size:12px;margin-top:6px;color:'+(gap>0?'#a8342a':'#0f5132')+'">You have '+have+' people now — '+(gap>0?('you’d need about '+gap+' more.'):(gap===0?'that’s exactly enough.':('that’s '+(-gap)+' to spare.')))+'</div>'
    + '</div>';
}

// ── Risks & totals ──
function kplOpenRisk(){
  var issues = kplComputeRisks();
  var host=document.getElementById('kpl-modalhost');
  var rows = issues.length ? issues.map(function(i){ return '<li style="margin:4px 0;color:'+(i.sev==='high'?'#a8342a':'#7a5a12')+'"><b>'+i.tag+'</b> — '+i.msg+'</li>'; }).join('') : '<li style="color:#0f766e">No problems found across these weeks. ✓</li>';
  // per-person totals table
  var trs = kplStaff.filter(function(s){ return kplFilterSec==='all' || (s.station_key===kplFilterSec) || (kplFilterSec==='__other' && !STATIONS_SCH.some(function(x){return x.key===s.station_key;})); }).map(function(s){
    var t=kplPersonTotals(s.id); var ent=kplEnt[s.id]||{};
    var offTgt = ent.off!=null?ent.off:'';
    return '<tr><td style="text-align:left;padding:2px 6px">'+schEvEsc(s.name)+'</td><td>'+t.days+'</td><td'+(t.off===0?' style="color:#a8342a;font-weight:700"':'')+'>'+t.off+'</td><td>'+(Math.round(t.hrs*10)/10)+'</td><td>'+t.al+'</td><td>'+t.ph+'</td>'
      + '<td><input type="number" min="0" style="width:44px;padding:2px" value="'+offTgt+'" onchange="kplSetEnt(\''+s.id+'\',\'off\',this.value)" title="target off-days"></td></tr>';
  }).join('');
  host.innerHTML = '<div class="kpl-ov" onclick="kplCloseRisk(event)"><div class="kpl-modal" style="max-width:640px" onclick="event.stopPropagation()">'
    + '<h3>&#9888; Risks &amp; totals <span style="font-size:12px;color:var(--vino-light)">('+kplNumWeeks+' weeks)</span></h3>'
    + '<ul style="margin:0 0 14px;padding-left:18px;font-size:13px">'+rows+'</ul>'
    + '<div class="kpl-lbl" style="margin-bottom:4px">Per person over the span</div>'
    + '<div style="max-height:44vh;overflow:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">'
    +   '<thead><tr style="color:var(--vino-light);font-size:10px;text-transform:uppercase"><th style="text-align:left;padding:2px 6px">Name</th><th>Days</th><th>Off</th><th>Hrs</th><th>AL</th><th>PH</th><th>Off target</th></tr></thead>'
    +   '<tbody>'+trs+'</tbody></table></div>'
    + '<div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="kpl-btn primary" onclick="kplCloseRisk()">Close</button></div>'
    + '</div></div>';
}
function kplCloseRisk(ev){ if(ev && ev.target && !ev.target.classList.contains('kpl-ov')) return; document.getElementById('kpl-modalhost').innerHTML=''; }
function kplSetEnt(sid, field, val){ kplEnt[sid]=kplEnt[sid]||{}; kplEnt[sid][field]= val===''?null:(parseInt(val,10)||0); kplSaveDraft(); }
function kplPersonTotals(sid){
  var t={days:0,work:0,off:0,hrs:0,al:0,ph:0};
  for(var w=0; w<kplNumWeeks; w++) for(var d=0; d<7; d++){ var e=kplEntry(sid,kplDateISO(w,d)); if(!e||!e.status) continue;
    if(e.status==='working'){ if(e.shift_start&&e.shift_end){ t.days++; t.work++; t.hrs+=calcHours(formatTime(e.shift_start),formatTime(e.shift_end),formatTime(e.shift_start2),formatTime(e.shift_end2)); } }
    else { if(e.status!=='off') t.days++; if(e.status==='off'||e.status==='wo') t.off++; if(e.status==='al') t.al++; if(e.status==='ph') t.ph++; }
  }
  return t;
}
function kplComputeRisks(){
  var out=[];
  // understaffed section-days
  kplSections().forEach(function(sec){
    var people=kplStaffInSecAll(sec.key); if(!people.length) return;
    for(var w=0; w<kplNumWeeks; w++) for(var d=0; d<7; d++){ var ds=kplDateISO(w,d); var c=kplSecDay(people, ds); var min=kplMinFor(sec.key,d>=5); if(c.any>0 && c.work<min){ out.push({sev:'high',tag:sec.label,msg:'only '+c.work+' working on '+new Date(ds+'T12:00:00').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'})+' (need '+min+')'}); } }
  });
  // people who work with no rest day at all in the span (vacation & PH count as rest)
  kplStaff.forEach(function(s){ var t=kplPersonTotals(s.id); if(t.work>0 && (t.off+t.al+t.ph)===0){ out.push({sev:'high',tag:s.name,msg:'works with no day off, vacation or holiday in the whole span'}); }
    // >6 consecutive working days
    var streak=0, maxStreak=0; for(var w=0; w<kplNumWeeks; w++) for(var d=0; d<7; d++){ var e=kplEntry(s.id,kplDateISO(w,d)); var working=e&&e.status==='working'&&e.shift_start; if(working){ streak++; maxStreak=Math.max(maxStreak,streak); } else streak=0; }
    if(maxStreak>=7) out.push({sev:'high',tag:s.name,msg:maxStreak+' days in a row without a break'});
    // entitlement gap
    var ent=kplEnt[s.id]||{}; if(ent.off!=null && t.off<ent.off) out.push({sev:'low',tag:s.name,msg:'off-days '+t.off+' below target '+ent.off}); });
  // collapse understaffed to a count if too many
  if(out.length>40){ var high=out.filter(function(o){return o.sev==='high';}).slice(0,30); out=high.concat([{sev:'low',tag:'…',msg:(out.length-high.length)+' more issues not shown'}]); }
  return out;
}

// ── Publish / revert ──
function kplOpenPublish(){
  var host=document.getElementById('kpl-modalhost');
  var wkChecks=''; for(var w=0; w<kplNumWeeks; w++){ var ws=addDays(kplFrom,w*7),we=addDays(kplFrom,w*7+6); wkChecks+='<label style="display:flex;align-items:center;gap:6px;font-size:12px;margin:2px 0"><input type="checkbox" class="kpl-pubwk" value="'+w+'" checked onchange="kplPubRecalc()"> W'+(w+1)+' &middot; '+ws.toLocaleDateString('en-GB',{day:'numeric',month:'short'})+' – '+we.toLocaleDateString('en-GB',{day:'numeric',month:'short'})+'</label>'; }
  var snap=kplReadSnap();
  var revertBtn = snap ? '<button class="kpl-btn" onclick="kplRevert()" style="border-color:#a8342a;color:#a8342a">&#8630; Undo the last send ('+snap.label+')</button>' : '';
  host.innerHTML = '<div class="kpl-ov" onclick="kplClosePublish(event)"><div class="kpl-modal" onclick="event.stopPropagation()">'
    + '<h3>&#10003; Put your plan on the real schedule</h3>'
    + '<div style="background:#fff7e6;border:1px solid #f0d98a;border-radius:8px;padding:8px 10px;font-size:12px;color:#7a5a12;margin-bottom:10px">This puts the weeks you tick onto the <b>real schedule</b> — the kitchen team and HR will see them. It saves a copy of what was there first, so you can <b>undo</b> right after. Clock-ins are never overwritten.</div>'
    + '<div class="kpl-lbl" style="margin-bottom:2px">Weeks to publish</div>'+wkChecks
    + '<div id="kpl-pub-short" style="margin-top:8px"></div>'
    + '<div id="kpl-pub-status" style="font-size:12px;color:var(--vino-light);margin-top:8px"></div>'
    + '<div style="display:flex;justify-content:space-between;gap:8px;margin-top:14px">'+revertBtn+'<div style="display:flex;gap:8px;margin-left:auto"><button class="kpl-btn" onclick="kplClosePublish()">Cancel</button><button class="kpl-btn go" id="kpl-pub-go" onclick="kplDoPublish()">Put these weeks on the schedule</button></div></div>'
    + '</div></div>';
  kplPubRecalc();
}
// Short-night warning shown right in the Publish dialog (mockup screen 5).
function kplPubSelectedWeeks(){ var weeks=[]; Array.prototype.forEach.call(document.querySelectorAll('.kpl-pubwk'), function(c){ if(c.checked) weeks.push(parseInt(c.value,10)); }); return weeks; }
function kplShortNights(weeks){
  var out=[];
  kplSections().forEach(function(sec){
    var people=kplStaffInSecAll(sec.key); if(!people.length) return;
    weeks.forEach(function(w){ for(var d=0; d<7; d++){ var ds=kplDateISO(w,d); var c=kplSecDay(people, ds); var min=kplMinFor(sec.key,d>=5); if(c.any>0 && c.work<min) out.push({ds:ds, sec:sec.label, n:c.work, min:min}); } });
  });
  return out;
}
function kplPubRecalc(){
  var box=document.getElementById('kpl-pub-short'); if(!box) return;
  var weeks=kplPubSelectedWeeks();
  if(!weeks.length){ box.innerHTML=''; return; }
  var shorts=kplShortNights(weeks);
  if(!shorts.length){ box.innerHTML='<div style="background:#e9f6ef;border:1px solid #a9d8bf;border-radius:8px;padding:6px 10px;font-size:12px;color:#0f5132">&#10003; Every section meets its minimum on the selected dates.</div>'; return; }
  var show=shorts.slice(0,6).map(function(s){ return '<li>'+s.sec+' — '+new Date(s.ds+'T12:00:00').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'})+': '+s.n+' working (min '+s.min+')</li>'; }).join('');
  var more=shorts.length>6?'<li>…and '+(shorts.length-6)+' more short slots</li>':'';
  box.innerHTML='<div style="background:#fbe4e1;border:1px solid #e6a79f;border-radius:8px;padding:6px 10px;font-size:12px;color:#a8342a"><b>&#9888; '+shorts.length+' short slot'+(shorts.length>1?'s':'')+' in the selected weeks</b> — you can still publish, just so you know:<ul style="margin:4px 0 0;padding-left:18px">'+show+more+'</ul></div>';
}
function kplClosePublish(ev){ if(ev && ev.target && !ev.target.classList.contains('kpl-ov')) return; document.getElementById('kpl-modalhost').innerHTML=''; }
function kplReadSnap(){ try{ return JSON.parse(localStorage.getItem(KPL_SNAP_LS)||'null'); }catch(e){ return null; } }
function kplRosterRow(id, ds, e){
  return { staff_id:id, work_date:ds, status:e.status,
    shift_start:e.status==='working'?(e.shift_start||null):null, shift_end:e.status==='working'?(e.shift_end||null):null,
    shift_start2:e.status==='working'?(e.shift_start2||null):null, shift_end2:e.status==='working'?(e.shift_end2||null):null,
    station_override:e.status==='working'?(e.station_override||null):null,
    notes:e.notes||null, updated_at:new Date().toISOString() };
}
async function kplDoPublish(){
  var weeks=[]; Array.prototype.forEach.call(document.querySelectorAll('.kpl-pubwk'), function(c){ if(c.checked) weeks.push(parseInt(c.value,10)); });
  var secDiff = schedPlanSectionDiff();
  var secRenames = secDiff.renames;
  var newSecs = secDiff.adds.slice();
  var hasSecChanges = secDiff.total > 0;
  if(!weeks.length && !hasSecChanges){ alert('Nothing to bring live yet. Tick a week to publish, or make a change first.'); return; }
  var dates=[]; weeks.forEach(function(w){ for(var d=0; d<7; d++) dates.push(kplDateISO(w,d)); });
  var minD = dates.length ? dates.slice().sort()[0] : null;
  var maxD = dates.length ? dates.slice().sort()[dates.length-1] : null;
  var existingIds = kplStaff.map(function(s){return s.id;});
  // team changes held in the draft
  var moves = Object.keys(kplDraftSec).filter(function(id){ var s=kplStaff.find(function(x){return x.id===id;}); return s && kplDraftSec[id]!==s.station_key; });
  var reorders = Object.keys(kplDraftOrd).filter(function(id){ var s=kplStaff.find(function(x){return x.id===id;}); return s && kplDraftOrd[id]!==s.sort_order; });
  var newPeople = kplNewStaff.slice();
  // shift payloads for existing staff in the chosen dates. The publish replaces the
  // whole week range, so write the FULL plan: the draft where a cell was changed,
  // otherwise the untouched live row — so unchanged shifts are preserved, not wiped.
  var payloads=[];
  if(dates.length){ kplStaff.forEach(function(s){ dates.forEach(function(ds){
    var k=kplKey(s.id,ds), e=kplDraft[k];
    if(e && e.status){ payloads.push(kplRosterRow(s.id,ds,e)); }
    else { var lv=kplLive[k]; if(lv && lv.status){ payloads.push(kplRosterRow(s.id,ds,lv)); } }
  }); }); }
  var lbl = weeks.length ? ('W'+(weeks[0]+1)+(weeks.length>1?'–W'+(weeks[weeks.length-1]+1):'')) : 'section changes';
  var extra=[]; if(moves.length) extra.push(moves.length+' moved to a different section'); if(reorders.length) extra.push(reorders.length+' reordered'); if(newPeople.length) extra.push(newPeople.length+' new '+(newPeople.length===1?'person':'people')+' added');
  if(newSecs.length) extra.push(newSecs.length+' new section'+(newSecs.length>1?'s':'')+' ('+newSecs.map(function(s){return s.label;}).join(', ')+')');
  if(secRenames.length) extra.push(secRenames.length+' section'+(secRenames.length>1?'s':'')+' renamed');
  if(secDiff.deletes.length) extra.push(secDiff.deletes.length+' section'+(secDiff.deletes.length>1?'s':'')+' deleted');
  if(secDiff.orderChanged) extra.push('sections reordered');
  var extraTxt = extra.length ? '\n\nAlso going live: '+extra.join(' · ')+'.' : '';
  var rangeTxt = weeks.length ? (' ('+minD+' → '+maxD+')') : '';
  var mainTxt = weeks.length ? (payloads.length+' shift-days for the team will go onto the live schedule — the team and HR will see them.') : 'Your section changes will go onto the live schedule for everyone.';
  if(!confirm('Bring '+lbl+rangeTxt+' live?\n\n'+mainTxt+extraTxt+'\n\nYou can undo this straight after.')) return;
  var goBtn=document.getElementById('kpl-pub-go'); if(goBtn){ goBtn.disabled=true; goBtn.textContent='Publishing…'; }
  var statusEl=document.getElementById('kpl-pub-status');
  try{
    // 1) snapshot current live rows in range (for revert)
    var snapRows=[];
    if(dates.length){ var snapRes = await sb.from('roster').select('*').gte('work_date',minD).lte('work_date',maxD).in('staff_id', existingIds).limit(8000); if(snapRes.error) throw snapRes.error; snapRows = snapRes.data||[]; }
    // remember prior sections + order of changed people, and prior section labels (for undo)
    var priorSections={}; moves.forEach(function(id){ var s=kplStaff.find(function(x){return x.id===id;}); priorSections[id]=s?s.station_key:null; });
    var priorOrders={}; reorders.forEach(function(id){ var s=kplStaff.find(function(x){return x.id===id;}); priorOrders[id]=s?s.sort_order:null; });
    // 2) sections FIRST (so people can sit in new ones). Snapshot the whole table for undo,
    //    then add / rename / delete / reorder.
    var secSnapRows=[]; var insertedSecKeys=[];
    if(hasSecChanges){
      var ssnap = await sb.from('sched_sections').select('*'); if(ssnap.error) throw ssnap.error; secSnapRows = ssnap.data||[];
      for(var ns=0; ns<newSecs.length; ns++){ var sc=newSecs[ns];
        var sres=await sb.from('sched_sections').insert({ section_key:sc.key, label:sc.label, sort_order:(secDiff.order.indexOf(sc.key)+1)||999, active:true }); if(sres.error) throw sres.error;
        insertedSecKeys.push(sc.key);
      }
      for(var rn=0; rn<secRenames.length; rn++){ var rk=secRenames[rn]; var rres=await sb.from('sched_sections').update({ label:kplSecRename[rk] }).eq('section_key',rk); if(rres.error) throw rres.error; }
      if(secDiff.deletes.length){ var sdd=await sb.from('sched_sections').update({ active:false }).in('section_key', secDiff.deletes); if(sdd.error) throw sdd.error; }
      for(var so=0; so<secDiff.order.length; so++){ var ok=secDiff.order[so]; var sor=await sb.from('sched_sections').update({ sort_order:so+1 }).eq('section_key',ok); if(sor.error) throw sor.error; }
    }
    // 3) insert the brand-new people, so their shifts get a real id
    var insertedIds=[];
    for(var i=0;i<newPeople.length;i++){ var np=newPeople[i];
      var res=await sb.from('staff').insert({ name:np.name, designation:np.designation||null, station_key:np.station_key, active:true, in_schedule:true, sort_order:(kplDraftOrd[np.id]!=null?kplDraftOrd[np.id]:999) }).select().single();
      if(res.error) throw res.error;
      insertedIds.push(res.data.id);
      dates.forEach(function(ds){ var e=kplDraft[kplKey(np.id,ds)]; if(e && e.status){ payloads.push(kplRosterRow(res.data.id,ds,e)); } });
    }
    // 4) persist the undo snapshot
    localStorage.setItem(KPL_SNAP_LS, JSON.stringify({ label:lbl, minD:minD, maxD:maxD, staffIds:existingIds, rows:snapRows, priorSections:priorSections, priorOrders:priorOrders, insertedIds:insertedIds, secRows:secSnapRows, insertedSecKeys:insertedSecKeys, at:new Date().toISOString() }));
    // 5) apply section moves + reorders (team-list change)
    for(var m=0;m<moves.length;m++){ var mid=moves[m]; var mr=await sb.from('staff').update({ station_key:kplDraftSec[mid] }).eq('id',mid); if(mr.error) throw mr.error; }
    for(var q=0;q<reorders.length;q++){ var rid=reorders[q]; var rr=await sb.from('staff').update({ sort_order:kplDraftOrd[rid] }).eq('id',rid); if(rr.error) throw rr.error; }
    // 6) replace the roster rows in range, then insert the plan
    if(dates.length){
      var del = await sb.from('roster').delete().gte('work_date',minD).lte('work_date',maxD).in('staff_id', existingIds);
      if(del.error) throw del.error;
      if(payloads.length){ var ins = await sb.from('roster').upsert(payloads,{onConflict:'staff_id,work_date'}); if(ins.error) throw ins.error; }
    }
    // applied — clear the draft team + section changes so they don't re-apply
    kplDraftSec={}; kplDraftOrd={}; kplNewStaff=[]; kplSecRename={}; kplSecNew=[]; schedPlanSaveDraft();
    if(statusEl){ statusEl.style.color='#0f766e'; statusEl.textContent='✓ Brought live'+(weeks.length?(' '+payloads.length+' shift-days'):'')+(extra.length?' + '+extra.join(' + '):'')+'. The live schedule is updated'+(weeks.length?(' for '+minD+' → '+maxD):'')+'.'; }
    if(goBtn){ goBtn.textContent='✓ Live'; }
    await schedPlanAfterWrite();
  }catch(err){
    console.error('Publish error', err);
    if(statusEl){ statusEl.style.color='#a8342a'; statusEl.textContent='Could not publish: '+(err.message||err)+(String(err.message||err).indexOf('read-only')>=0?' (unlock the DEV badge to write on the dev site).':''); }
    if(goBtn){ goBtn.disabled=false; goBtn.textContent='Put these weeks on the schedule'; }
  }
}
async function kplRevert(){
  var snap=kplReadSnap(); if(!snap){ alert('Nothing to undo.'); return; }
  var extra=[]; if(snap.priorSections && Object.keys(snap.priorSections).length) extra.push('section moves'); if(snap.priorOrders && Object.keys(snap.priorOrders).length) extra.push('reordering'); if(snap.insertedIds && snap.insertedIds.length) extra.push(snap.insertedIds.length+' added '+(snap.insertedIds.length===1?'person':'people')); if(snap.secRows && snap.secRows.length) extra.push('section changes');
  var rangeTxt = snap.minD ? (' for '+snap.minD+' → '+snap.maxD) : '';
  if(!confirm('Undo the last Bring live ('+snap.label+')?\n\nThe live schedule'+rangeTxt+' goes back to exactly what it was before'+(extra.length?', and '+extra.join(' + ')+' are reversed':'')+'.')) return;
  try{
    if(snap.minD){
      var allIds = (snap.staffIds||[]).concat(snap.insertedIds||[]);
      var del = await sb.from('roster').delete().gte('work_date',snap.minD).lte('work_date',snap.maxD).in('staff_id', allIds);
      if(del.error) throw del.error;
      if(snap.rows && snap.rows.length){ var rows=snap.rows.map(function(r){ return Object.assign({},r); }); var ins=await sb.from('roster').upsert(rows,{onConflict:'staff_id,work_date'}); if(ins.error) throw ins.error; }
    }
    // restore prior sections + order
    var ps = snap.priorSections||{};
    for(var id in ps){ if(ps.hasOwnProperty(id)){ var r=await sb.from('staff').update({ station_key:ps[id] }).eq('id',id); if(r.error) throw r.error; } }
    var po = snap.priorOrders||{};
    for(var oid in po){ if(po.hasOwnProperty(oid)){ var r2=await sb.from('staff').update({ sort_order:po[oid] }).eq('id',oid); if(r2.error) throw r2.error; } }
    // restore sections to exactly the snapshot (undoes rename / reorder / delete),
    // then deactivate any section we added (it wasn't in the snapshot).
    if(snap.secRows && snap.secRows.length){
      var srows = snap.secRows.map(function(r){ return Object.assign({}, r); });
      var sup = await sb.from('sched_sections').upsert(srows,{onConflict:'section_key'}); if(sup.error) throw sup.error;
    }
    if(snap.insertedSecKeys && snap.insertedSecKeys.length){ var sdel=await sb.from('sched_sections').update({ active:false }).in('section_key', snap.insertedSecKeys); if(sdel.error) throw sdel.error; }
    // remove the people we added (soft: take them off the team list so no FK trouble)
    if(snap.insertedIds && snap.insertedIds.length){
      var rd=await sb.from('roster').delete().in('staff_id', snap.insertedIds); if(rd.error) throw rd.error;
      var sd=await sb.from('staff').update({ active:false, in_schedule:false }).in('id', snap.insertedIds); if(sd.error) throw sd.error;
    }
    localStorage.removeItem(KPL_SNAP_LS);
    alert('Done — the live schedule'+(snap.minD?(' for '+snap.minD+' → '+snap.maxD):'')+' is back to how it was before you brought it live.');
    await schedPlanAfterWrite(); kplClosePublish();
  }catch(err){ console.error('Revert error', err); alert('Could not undo: '+(err.message||err)); }
}

// ── Navigation ──
function schedWeekOffset(n) {
  schedWeekStart = addDays(schedWeekStart, n * 7);
  loadSchedData().then(renderSchedView);
}
function schedGoToday() {
  schedWeekStart = getMonday(new Date());
  loadSchedData().then(renderSchedView);
}
function schedSetView(v) {
  schedView = v;
  document.querySelectorAll('.sch-vtab').forEach(function(b) { b.classList.remove('active'); });
  document.getElementById('svt-' + v).classList.add('active');
  renderSchedView();
}

// ── Render view ──
function renderSchedView() {
  var days = []; for (var i = 0; i < 7; i++) days.push(addDays(schedWeekStart, i));
  var opts = { day:'numeric', month:'short' };
  document.getElementById('sch-week-label').textContent =
    days[0].toLocaleDateString('en-GB', opts) + ' – ' +
    days[6].toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
  if (schedView === 'week') {
    document.getElementById('sch-week-view').style.display = 'block';
    document.getElementById('sch-day-view').style.display = 'none';
    renderSchedWeek();
  } else {
    document.getElementById('sch-week-view').style.display = 'none';
    document.getElementById('sch-day-view').style.display = 'block';
    renderSchedDay();
  }
}

// ── Weekly grid ──
function renderSchedWeek() {
  // In planning mode, record the change into the draft (never the live DB) first.
  if (schedPlanMode) schedPlanCapture();
  var tool = document.getElementById('kpl-full');
  var toolOpen = tool && tool.style.display !== 'none';
  // While the Roster tool is open the real grid is hidden — don't render it (saves
  // work and avoids duplicate element ids for the Move/Add panels). Just sync the tool.
  if (toolOpen) { if (typeof krtRender === 'function') krtRender(); return; }
  document.getElementById('sch-grid-wrap').innerHTML = schedCapBannerHtml() + schedWeekTableHtml(schedWeekStart);
  schedScrollAffordance();
}
// The week grid has always scrolled sideways; nothing ever said so. Measure the scroller
// and let CSS show a right-edge fade while there is more week to the right, plus a "More
// days →" pill until the first scroll. Purely additive — no day-picker, no grid rebuild,
// and when the whole week already fits (laptop) neither ever appears.
function schedScrollAffordance(){
  var wrap = document.getElementById('sch-grid-wrap');
  var shell = document.getElementById('sch-scroll-shell');
  if(!wrap || !shell) return;
  var slack = wrap.scrollWidth - wrap.clientWidth;
  // 4px, not 0: sub-pixel layout leaves a hairline of "scroll" on grids that really do fit.
  shell.classList.toggle('can-scroll-right', slack > 4 && wrap.scrollLeft < slack - 4);
  shell.classList.toggle('at-start', wrap.scrollLeft <= 4);
  if(!wrap._schScrollBound){
    wrap._schScrollBound = true;
    wrap.addEventListener('scroll', schedScrollAffordance, { passive:true });
    window.addEventListener('resize', schedScrollAffordance);
  }
}
// One day cell for a person — shared by the single-week grid and the several-weeks
// grid so both look and behave identically. Returns the <td> + its hours/days count.
// "Working in section" picker — cover a different section for ONE day only.
function schedSectionOptions(selKey){
  return STATIONS_SCH.map(function(x){
    return '<option value="' + x.key + '"' + (x.key === selKey ? ' selected' : '') + '>' + x.label + '</option>';
  }).join('');
}
function schedSecLabel(key){ var x = STATIONS_SCH.find(function(s){ return s.key === key; }); return x ? x.label : ''; }

function schedDayCellHtml(staff, sid, ds2, today) {
  var rrow = schedRoster[schedRosterKey(sid, ds2)];
  var isTod = ds2 === today;
  var planChg = (schedPlanMode && kplDraft && kplDraft[schedRosterKey(sid, ds2)]) ? ' sch-plan-changed' : '';
  var wHours = 0, wDays = 0, inner = '';
  if (!rrow || rrow.status === 'working') {
    var ts = rrow ? formatTime(rrow.shift_start) : '';
    var te = rrow ? formatTime(rrow.shift_end) : '';
    var ts2 = rrow ? formatTime(rrow.shift_start2) : '';
    var te2 = rrow ? formatTime(rrow.shift_end2)   : '';
    var plannedH = calcHours(ts, te, ts2, te2);
    // In the Roster tool (planning) show the PLANNED shift, never clock-in data — attendance
    // belongs on the live schedule. This makes Clear/empty actually look empty here.
    var att = schedPlanMode ? { kind: 'plan' } : schedAttState(staff, ds2);
    if (att.kind === 'done') {
      wHours += att.hours; wDays++;
      inner = '<div class="sch-shift actual"><span>' + att.in + '</span><span>' + att.out + '</span>' +
        (att.manual ? '<span class="sch-actual-tag">closed</span>' : '') + '</div>';
    } else if (att.kind === 'in') {
      wDays++;
      inner = '<div class="sch-shift actual-live"><span>' + att.in + '</span>' +
        '<span class="sch-actual-open">working</span></div>';
    } else if (att.kind === 'open') {
      wDays++;
      inner = '<div class="sch-shift actual-open-flag" onclick="schedCloseShift(event,\'' + sid + '\',\'' + ds2 + '\')">' +
        '<span>' + att.in + '</span><span class="sch-actual-close">tap to close</span></div>';
    } else if (att.kind === 'absent') {
      wDays++;
      inner = '<div class="sch-shift actual-absent">' +
        (ts && te ? '<span>' + ts + '</span><span>' + te + '</span>' : '') +
        '<span class="sch-actual-tag">no clock-in</span></div>';
    } else {
      if (ts && te) { wHours += plannedH; wDays++; }
      var splitLabel = (ts2 && te2) ? '<span style="opacity:.8;font-size:9px">' + ts2 + '–' + te2 + '</span>' : '';
      inner = '<div class="sch-shift working">' +
        (ts && te ? '<span>' + ts + '–' + te + '</span>' + splitLabel : '<span style="color:#bbb;font-size:10px">+ add</span>') + '</div>';
    }
  } else {
    var meta = STATUS_META[rrow.status] || { label: rrow.status.toUpperCase(), bg: 'off' };
    if (rrow.status !== 'off') wDays++;
    inner = '<div class="sch-shift ' + meta.bg + '">' + meta.label + '</div>';
  }
  var coverKey = rrow && rrow.station_override;
  var homeKey = staff ? staff.station_key : '';
  if (coverKey && coverKey !== homeKey) {
    inner += '<div class="sch-cover-tag">&rarr; ' + schedSecLabel(coverKey) + '</div>';
  }
  var html = '<td class="sch-cell' + (isTod ? ' sch-cell-today' : '') + planChg +
    '" onclick="schedOpenEdit(\'' + sid + '\',\'' + ds2 + '\')">' + inner + '</td>';
  return { html: html, hours: wHours, days: wDays };
}

// The exact same weekly grid the team already uses — reused by the Roster tool so
// there is only ever ONE way to set times, add people and move people.
function schedWeekTableHtml(weekStart, opts) {
  opts = opts || {};
  var controls = opts.controls !== false;   // per-row Move + Add-staff rows (off for stacked weeks)
  var today = formatDate(new Date());
  var days = []; for (var i = 0; i < 7; i++) days.push(addDays(weekStart, i));
  var dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  var html = '<table class="sch-grid"><thead><tr>';
  html += '<th class="sch-th-name">Name</th><th class="sch-th-role">Role</th>';
  for (var di = 0; di < days.length; di++) {
    var ds = formatDate(days[di]);
    html += '<th class="' + (ds === today ? 'sch-th-today' : '') + '">' + dayNames[di] +
      '<br><span style="font-size:10px;opacity:.8">' +
      days[di].toLocaleDateString('en-GB',{day:'numeric',month:'short'}) + '</span></th>';
  }
  html += '<th>Hrs</th><th>Days</th>' + (controls ? '<th></th>' : '') + '</tr></thead><tbody>';

  // Events strip — one cell per day, up to 2 events each
  html += '<tr class="sch-events-row"><td class="sch-events-label" colspan="2">Events</td>';
  for (var ei = 0; ei < days.length; ei++) {
    var eds = formatDate(days[ei]);
    var evs = schedEvents[eds] || [];
    html += '<td class="sch-events-cell' + (eds === today ? ' sch-cell-today' : '') + '" onclick="schedOpenEvents(\'' + eds + '\')">';
    if (evs.length) {
      for (var evi = 0; evi < evs.length; evi++) html += '<div class="sch-event-chip">' + schEvEsc(evs[evi].name) + '</div>';
    } else {
      html += '<div class="sch-event-add">+</div>';
    }
    html += '</td>';
  }
  html += '<td colspan="3"></td></tr>';

  for (var si = 0; si < STATIONS_SCH.length; si++) {
    var st = STATIONS_SCH[si];
    var allStaff = schedStaff.filter(function(s){ return s.station_key === st.key; });
    if (!allStaff.length) {
      // Still show add button even if no staff
      html += '<tr class="sch-station-hdr"><td colspan="11">' + st.label + '</td></tr>';
    } else {
      html += '<tr class="sch-station-hdr"><td colspan="11">' + st.label + '</td></tr>';
      for (var xi = 0; xi < allStaff.length; xi++) {
        var staff = allStaff[xi];
        var sid = staff.id;
        var mpid = 'smp' + sid.replace(/-/g,'');
        var wHours = 0, wDays = 0;

        var upBtn = xi>0 ? '<span class="sch-ord-btn" onclick="schedMoveStaff(event,\'' + sid + '\',-1)" title="Move up">&#9650;</span>' : '<span class="sch-ord-btn sch-ord-off">&#9650;</span>';
        var dnBtn = xi<allStaff.length-1 ? '<span class="sch-ord-btn" onclick="schedMoveStaff(event,\'' + sid + '\',1)" title="Move down">&#9660;</span>' : '<span class="sch-ord-btn sch-ord-off">&#9660;</span>';
        html += '<tr>';
        html += '<td class="sch-td-name" onclick="schedEditEmpId(event,\'' + sid + '\')" title="Tap to set employee ID" style="cursor:pointer">' +
          '<span class="sch-ord">' + upBtn + dnBtn + '</span>' +
          '<span class="sch-del-btn" onclick="schedConfirmDelete(event,\'' + sid + '\')" title="Remove">×</span>' +
          staff.name +
          ((schedPlanMode && kplStaff && !kplStaff.some(function(x){ return x.id === sid; })) ? '<span class="sch-plan-newbadge">NEW</span>' : '') +
          (staff.emp_id ? '<span class="sch-emp-id">' + staff.emp_id + '</span>' : '') + '</td>';
        html += '<td class="sch-td-role" onclick="schedEditRole(event,\'' + sid + '\')" title="Click to edit" style="cursor:pointer">' +
          staff.designation + ' <span style="opacity:.3;font-size:10px">✎</span></td>';

        for (var dj = 0; dj < days.length; dj++) {
          var cell = schedDayCellHtml(staff, sid, formatDate(days[dj]), today);
          html += cell.html; wHours += cell.hours; wDays += cell.days;
        }

        html += '<td class="sch-td-hours">' + (wHours > 0 ? (Math.round(wHours * 10) / 10) + 'h' : '—') + '</td>';
        html += '<td class="sch-td-days">' + (wDays > 0 ? wDays : '—') + '</td>';

        if (controls) {
          var stOpts = '';
          for (var oi = 0; oi < STATIONS_SCH.length; oi++) {
            stOpts += '<option value="' + STATIONS_SCH[oi].key + '"' +
              (STATIONS_SCH[oi].key === staff.station_key ? ' selected' : '') + '>' +
              STATIONS_SCH[oi].label + '</option>';
          }
          html += '<td class="sch-td-move">' +
            '<button class="sch-move-btn" onclick="schedShowMove(\'' + mpid + '\')">&#8596; Move</button>' +
            '<div class="sch-move-panel" id="' + mpid + '">' +
              '<span class="sch-move-label">Move to</span>' +
              '<select class="dish-move-select" id="' + mpid + 'sel">' + stOpts + '</select>' +
              '<button class="dish-move-yes" onclick="schedMoveStation(\'' + sid + '\',\'' + mpid + '\')">Move</button>' +
              '<button class="dish-move-no" onclick="schedHideMove(\'' + mpid + '\')">Cancel</button>' +
            '</div></td>';
        }
        html += '</tr>';
      }
    }

    // Add staff row at bottom of each station (only in the fully-interactive grid)
    if (controls) {
      html += '<tr class="sch-add-row"><td colspan="11">' +
        '<button class="sch-add-staff-btn" onclick="schedShowAddStaff(\'' + st.key + '\')">+ Add staff to ' + st.label + '</button>' +
        '<div class="sch-add-staff-panel" id="sadd-' + st.key + '">' +
          '<input type="text" class="sch-add-name-inp" id="sadd-name-' + st.key + '" placeholder="Full name" />' +
          '<input type="text" class="sch-add-role-inp" id="sadd-role-' + st.key + '" placeholder="Role (CDP, Commis 1...)" />' +
          '<button class="dish-move-yes" onclick="schedSaveNewStaff(\'' + st.key + '\')">Add</button>' +
          '<button class="dish-move-no" onclick="schedHideAddStaff(\'' + st.key + '\')">Cancel</button>' +
        '</div>' +
      '</td></tr>';
    }
  }

  html += '</tbody>';

  // Week summary row — effective hours (actual for today/past, planned future)
  html += '<tfoot><tr class="sch-summary-row"><td class="sum-label">Total hours</td><td></td>';
  var grandTotal = 0;
  for (var sumDi = 0; sumDi < days.length; sumDi++) {
    var sumDs = formatDate(days[sumDi]);
    var dayTotal = 0;
    schedStaff.forEach(function(s) { dayTotal += schedEffHours(s, sumDs); });
    dayTotal = Math.round(dayTotal * 10) / 10;
    grandTotal += dayTotal;
    html += '<td>' + (dayTotal > 0 ? dayTotal + 'h' : '—') + '</td>';
  }
  grandTotal = Math.round(grandTotal * 10) / 10;
  html += '<td>' + (grandTotal > 0 ? grandTotal + 'h' : '—') + '</td><td>—</td>' + (controls ? '<td></td>' : '') + '</tr></tfoot>';

  html += '</table>';
  return html;
}

// Several weeks SIDE BY SIDE — one grid, one Name column, the weeks flow left→right
// (like the chefs' Excel) instead of stacking down the page. Same cells/editing.
function schedMultiWeekTableHtml(weekStart, numWeeks) {
  var today = formatDate(new Date());
  var dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  var COLS = 1 + 7 * numWeeks + 3;   // name(+role), all days, hrs, days, move
  var weeks = []; for (var w = 0; w < numWeeks; w++) weeks.push(addDays(weekStart, w * 7));

  var html = '<table class="sch-grid sch-multi"><thead>';
  html += '<tr><th class="sch-th-name" rowspan="2">Name</th>';
  weeks.forEach(function(ws){ var we = addDays(ws, 6); var wmon = formatDate(ws);
    var lbl = 'Week of ' + ws.toLocaleDateString('en-GB',{day:'numeric',month:'short'}) + ' &ndash; ' + we.toLocaleDateString('en-GB',{day:'numeric',month:'short'});
    html += '<th class="sch-weekgroup" colspan="7"><div class="krt-wk-hd"><span>'+lbl+'</span><span class="krt-wk-actions">'+krtWeekTabsHtml(wmon)+'</span></div></th>';
  });
  html += '<th rowspan="2">Hrs</th><th rowspan="2">Days</th><th rowspan="2"></th></tr><tr>';
  weeks.forEach(function(ws){ for (var d = 0; d < 7; d++){ var day = addDays(ws, d), ds = formatDate(day);
    html += '<th class="' + (ds === today ? 'sch-th-today' : '') + (d === 0 ? ' sch-weekstart' : '') + '">' + dayNames[d] +
      '<br><span style="font-size:10px;opacity:.8">' + day.toLocaleDateString('en-GB',{day:'numeric',month:'short'}) + '</span></th>';
  }});
  html += '</tr></thead><tbody>';

  // Events strip across every week
  html += '<tr class="sch-events-row"><td class="sch-events-label" colspan="1">Events</td>';
  weeks.forEach(function(ws){ for (var d = 0; d < 7; d++){ var eds = formatDate(addDays(ws, d)); var evs = schedEvents[eds] || [];
    html += '<td class="sch-events-cell' + (eds === today ? ' sch-cell-today' : '') + (d === 0 ? ' sch-weekstart' : '') + '" onclick="schedOpenEvents(\'' + eds + '\')">';
    if (evs.length) { for (var evi = 0; evi < evs.length; evi++) html += '<div class="sch-event-chip">' + schEvEsc(evs[evi].name) + '</div>'; }
    else html += '<div class="sch-event-add">+</div>';
    html += '</td>';
  }});
  html += '<td colspan="3"></td></tr>';

  for (var si = 0; si < STATIONS_SCH.length; si++) {
    var st = STATIONS_SCH[si];
    var allStaff = schedStaff.filter(function(s){ return s.station_key === st.key; });
    html += '<tr class="sch-station-hdr"><td colspan="' + COLS + '">' + st.label + '</td></tr>';
    for (var xi = 0; xi < allStaff.length; xi++) {
      var staff = allStaff[xi], sid = staff.id, mpid = 'smpM' + sid.replace(/-/g,'');
      var wHours = 0, wDays = 0;
      var upBtn = xi > 0 ? '<span class="sch-ord-btn" onclick="schedMoveStaff(event,\'' + sid + '\',-1)" title="Move up">&#9650;</span>' : '<span class="sch-ord-btn sch-ord-off">&#9650;</span>';
      var dnBtn = xi < allStaff.length - 1 ? '<span class="sch-ord-btn" onclick="schedMoveStaff(event,\'' + sid + '\',1)" title="Move down">&#9660;</span>' : '<span class="sch-ord-btn sch-ord-off">&#9660;</span>';
      html += '<tr>';
      html += '<td class="sch-td-name sch-td-namemulti" onclick="schedEditEmpId(event,\'' + sid + '\')" title="Tap to set employee ID" style="cursor:pointer">' +
        '<span class="sch-ord">' + upBtn + dnBtn + '</span>' +
        '<span class="sch-del-btn" onclick="schedConfirmDelete(event,\'' + sid + '\')" title="Remove">×</span>' +
        '<span class="sch-multi-info"><span class="sch-multi-nm">' + staff.name +
          ((schedPlanMode && kplStaff && !kplStaff.some(function(x){ return x.id === sid; })) ? '<span class="sch-plan-newbadge">NEW</span>' : '') +
          (staff.emp_id ? '<span class="sch-emp-id">' + staff.emp_id + '</span>' : '') + '</span>' +
          '<span class="sch-multi-role" onclick="schedEditRole(event,\'' + sid + '\')" title="Click to edit role">' + staff.designation + ' <span style="opacity:.3;font-size:9px">✎</span></span>' +
        '</span></td>';
      weeks.forEach(function(ws){ for (var d = 0; d < 7; d++){
        var cell = schedDayCellHtml(staff, sid, formatDate(addDays(ws, d)), today);
        html += (d === 0) ? cell.html.replace('class="sch-cell', 'class="sch-cell sch-weekstart') : cell.html;
        wHours += cell.hours; wDays += cell.days;
      }});
      html += '<td class="sch-td-hours">' + (wHours > 0 ? (Math.round(wHours * 10) / 10) + 'h' : '—') + '</td>';
      html += '<td class="sch-td-days">' + (wDays > 0 ? wDays : '—') + '</td>';
      var stOpts = ''; for (var oi = 0; oi < STATIONS_SCH.length; oi++){ stOpts += '<option value="' + STATIONS_SCH[oi].key + '"' + (STATIONS_SCH[oi].key === staff.station_key ? ' selected' : '') + '>' + STATIONS_SCH[oi].label + '</option>'; }
      html += '<td class="sch-td-move"><button class="sch-move-btn" onclick="schedShowMove(\'' + mpid + '\')">&#8596; Move</button>' +
        '<div class="sch-move-panel" id="' + mpid + '"><span class="sch-move-label">Move to</span>' +
        '<select class="dish-move-select" id="' + mpid + 'sel">' + stOpts + '</select>' +
        '<button class="dish-move-yes" onclick="schedMoveStation(\'' + sid + '\',\'' + mpid + '\')">Move</button>' +
        '<button class="dish-move-no" onclick="schedHideMove(\'' + mpid + '\')">Cancel</button></div></td>';
      html += '</tr>';
    }
    html += '<tr class="sch-add-row"><td colspan="' + COLS + '">' +
      '<button class="sch-add-staff-btn" onclick="schedShowAddStaff(\'' + st.key + '\')">+ Add staff to ' + st.label + '</button>' +
      '<div class="sch-add-staff-panel" id="sadd-' + st.key + '">' +
        '<input type="text" class="sch-add-name-inp" id="sadd-name-' + st.key + '" placeholder="Full name" />' +
        '<input type="text" class="sch-add-role-inp" id="sadd-role-' + st.key + '" placeholder="Role (CDP, Commis 1...)" />' +
        '<button class="dish-move-yes" onclick="schedSaveNewStaff(\'' + st.key + '\')">Add</button>' +
        '<button class="dish-move-no" onclick="schedHideAddStaff(\'' + st.key + '\')">Cancel</button>' +
      '</div></td></tr>';
  }
  html += '</tbody></table>';
  return html;
}

// ── Day view ──
function renderSchedDay() {
  var today = formatDate(new Date());
  var total = 0;
  var html = '<h3 style="font-family:var(--font-serif);color:var(--vino);font-size:18px;margin:0 0 16px">' +
    new Date(today + 'T12:00:00').toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'}) + '</h3>';
  var sections = '';
  STATIONS_SCH.forEach(function(st) {
    var working = schedStaff.filter(function(s) {
      if (s.station_key !== st.key) return false;
      var row = schedRoster[schedRosterKey(s.id, today)];
      return !row || row.status === 'working';
    });
    if (!working.length) return;
    total += working.length;
    working.sort(function(a,b) {
      var ra = schedRoster[schedRosterKey(a.id,today)];
      var rb = schedRoster[schedRosterKey(b.id,today)];
      return (ra&&ra.shift_start?ra.shift_start:'99').localeCompare(rb&&rb.shift_start?rb.shift_start:'99');
    });
    sections += '<div class="sch-day-section"><div class="sch-day-section-title">' + st.label + '</div>';
    working.forEach(function(staff) {
      var row = schedRoster[schedRosterKey(staff.id, today)];
      var ts = row ? formatTime(row.shift_start) : '';
      var te = row ? formatTime(row.shift_end) : '';
      var att = schedAttState(staff, today);
      var attTxt = '', attCls = '';
      if (att.kind === 'done') { attTxt = 'Worked ' + att.in + '–' + att.out; attCls = 'sch-att-out'; }
      else if (att.kind === 'in') { attTxt = 'In ' + att.in; attCls = 'sch-att-in'; }
      else if (att.kind === 'open') { attTxt = 'In ' + att.in + ' · no clock-out'; attCls = 'sch-att-miss'; }
      else if (att.kind === 'absent') { attTxt = 'No clock-in'; attCls = 'sch-att-miss'; }
      var hVal = (att.kind === 'done') ? att.hours : calcHours(ts, te);
      sections += '<div class="sch-day-row">' +
        '<span class="sch-day-name">' + staff.name + '</span>' +
        '<span class="sch-day-role">' + staff.designation + '</span>' +
        '<span class="sch-day-shift">' + (ts && te ? ts + ' – ' + te : '<em style="color:#bbb">No time set</em>') + '</span>' +
        '<span class="sch-day-hours">' + (hVal > 0 ? hVal + 'h' : '') + '</span>' +
        '<span class="sch-day-att' + (attTxt ? ' sch-att ' + attCls : '') + '">' + attTxt + '</span>' +
        '</div>';
    });
    sections += '</div>';
  });
  var clockedIn = 0;
  schedStaff.forEach(function(s) {
    if (!s.emp_id) return;
    var a = schedAttendance[schedAttKey(s.emp_id, today)];
    if (a && a.first_in && !a.last_out && !a.manual_out) clockedIn++;
  });
  document.getElementById('sch-day-content').innerHTML =
    schedCapBannerHtml() +
    '<div style="margin-bottom:12px;font-size:13px;color:var(--vino-light)">' + total + ' staff in today' +
    ' \u00B7 <span style="color:#4a7c59;font-weight:600">' + clockedIn + ' clocked in</span>' +
    (schedLastSyncInfo ? ' \u00B7 <span style="opacity:.55;font-size:12px">' + schedLastSyncInfo + '</span>' : '') +
    '</div>' + sections;
}

// ── Edit modal ──
// ══════════════════════════════════════════════════════════════════════════
//  QUICK-FILL SHIFT PRESETS — 4 shared, editable buttons in the shift editor.
//  Shown on BOTH the real schedule and the Roster tool (same editor). One tap
//  fills + saves the shift. "Edit" changes the 4 presets for the whole team.
// ══════════════════════════════════════════════════════════════════════════
var SCHED_PRESET_DEFAULTS = [
  { slot:1, label:'Lunch',    status:'working', shift_start:'10:00', shift_end:'15:00', shift_start2:'19:00', shift_end2:'00:00' },
  { slot:2, label:'Dinner',   status:'working', shift_start:'15:00', shift_end:'03:00', shift_start2:null,    shift_end2:null },
  { slot:3, label:'Straight', status:'working', shift_start:'14:00', shift_end:'00:00', shift_start2:null,    shift_end2:null },
  { slot:4, label:'Day off',  status:'off',     shift_start:null,    shift_end:null,    shift_start2:null,    shift_end2:null }
];
var schedShiftPresets = SCHED_PRESET_DEFAULTS.map(function(p){ return Object.assign({}, p); });
async function loadShiftPresets(){
  try{
    var res = await sb.from('sched_shift_presets').select('*').order('slot');
    if(res.error || !res.data || !res.data.length) return;   // table not there yet → keep defaults
    var byslot={}; res.data.forEach(function(r){ byslot[r.slot]=r; });
    schedShiftPresets = [1,2,3,4].map(function(n){ var r=byslot[n]||SCHED_PRESET_DEFAULTS[n-1]; return { slot:n, label:r.label, status:r.status||'working', shift_start:r.shift_start||null, shift_end:r.shift_end||null, shift_start2:r.shift_start2||null, shift_end2:r.shift_end2||null }; });
  }catch(e){}
}
function schedPresetSub(p){
  if(p.status==='working'){ return (p.shift_start||'—')+'–'+(p.shift_end||'—') + (p.shift_start2&&p.shift_end2 ? ' · '+p.shift_start2+'–'+p.shift_end2 : ''); }
  return (STATUS_META[p.status] && STATUS_META[p.status].label) || String(p.status).toUpperCase();
}
function schedRenderPresets(){
  var host=document.getElementById('sch-preset-row'); if(!host) return;
  var html='<div class="sch-preset-hd"><span>Quick fill</span><button type="button" class="sch-preset-edit" onclick="schedOpenPresetEditor()">&#9998; Edit</button></div><div class="sch-preset-grid">';
  schedShiftPresets.forEach(function(p, i){
    html += '<button type="button" class="sch-preset-btn" onclick="schedApplyPreset('+i+')"><span class="nm">'+schEvEsc(p.label)+'</span><span class="sub">'+schEvEsc(schedPresetSub(p))+'</span></button>';
  });
  html += '</div>';
  host.innerHTML=html;
}
function schedSetHM(hid, mid, t){ if(!t) return; var parts=String(t).split(':'); var h=document.getElementById(hid), m=document.getElementById(mid); if(h) h.value=parts[0]; if(m) m.value=(parts[1]||'00'); }
// One tap: fill the editor from a preset AND save it (draft in the tool, live on the schedule).
function schedApplyPreset(i){
  var p=schedShiftPresets[i]; if(!p || !schedEditTarget) return;
  document.getElementById('sch-status-sel').value = p.status;
  schedStatusChange();
  if(p.status==='working'){
    schedSetHM('sch-start-h','sch-start-m', p.shift_start||'14:00');
    schedSetHM('sch-end-h','sch-end-m', p.shift_end||'00:00');
    var hasSplit=!!(p.shift_start2 && p.shift_end2);
    var sf=document.getElementById('sch-split-fields'), tg=document.getElementById('sch-split-toggle');
    if(sf) sf.style.display = hasSplit?'block':'none';
    if(tg){ tg.textContent = hasSplit?'− Remove split shift':'+ Add split shift'; tg.classList.toggle('active', hasSplit); }
    if(hasSplit){ schedSetHM('sch-start2-h','sch-start2-m', p.shift_start2); schedSetHM('sch-end2-h','sch-end2-m', p.shift_end2); }
  }
  schedSaveShift();
}
// ── Edit the 4 presets (shared with the team) ──
function schedOpenPresetEditor(){
  var host=document.getElementById('sch-preset-editor');
  if(!host){ host=document.createElement('div'); host.id='sch-preset-editor'; document.body.appendChild(host); }
  var STATS=[['working','Working'],['off','Day off'],['wo','Week off'],['sl','Sick leave'],['al','Annual leave'],['ph','Public holiday'],['em','Emergency'],['tr','Training'],['cat','Catering']];
  function hOpts(sel){ var o=''; for(var h=0;h<24;h++){ var hh=(h<10?'0':'')+h; o+='<option value="'+hh+'"'+(hh===sel?' selected':'')+'>'+hh+'</option>'; } return o; }
  function mOpts(sel){ return ['00','15','30','45'].map(function(m){ return '<option value="'+m+'"'+(m===sel?' selected':'')+'>'+m+'</option>'; }).join(''); }
  function pt(t,part){ if(!t) return part==='h'?'14':'00'; var p=String(t).split(':'); return part==='h'?(p[0]||'14'):(p[1]||'00'); }
  function sOpts(sel){ return STATS.map(function(s){ return '<option value="'+s[0]+'"'+(s[0]===sel?' selected':'')+'>'+s[1]+'</option>'; }).join(''); }
  var rows=schedShiftPresets.map(function(p,i){
    var w=p.status==='working', hasSplit=!!(p.shift_start2&&p.shift_end2);
    return '<div class="sch-pe-row" data-i="'+i+'">'
      +'<input type="text" class="sch-pe-label" value="'+String(p.label||'').replace(/"/g,'&quot;')+'" placeholder="Name" />'
      +'<select class="sch-pe-status" onchange="schedPresetEditorToggle('+i+')">'+sOpts(p.status)+'</select>'
      +'<div class="sch-pe-times" id="sch-pe-times-'+i+'" style="display:'+(w?'block':'none')+'">'
        +'<div class="sch-pe-time"><span>Start</span><select class="sch-pe-sh">'+hOpts(pt(p.shift_start,'h'))+'</select>:<select class="sch-pe-sm">'+mOpts(pt(p.shift_start,'m'))+'</select>'
        +'<span style="margin-left:8px">End</span><select class="sch-pe-eh">'+hOpts(pt(p.shift_end,'h'))+'</select>:<select class="sch-pe-em">'+mOpts(pt(p.shift_end,'m'))+'</select></div>'
        +'<label class="sch-pe-splitlbl"><input type="checkbox" class="sch-pe-split-chk" '+(hasSplit?'checked':'')+' onchange="schedPresetEditorToggle('+i+')"> split shift</label>'
        +'<div class="sch-pe-time sch-pe-split2" id="sch-pe-split2-'+i+'" style="display:'+(hasSplit?'block':'none')+'"><span>Again</span><select class="sch-pe-s2h">'+hOpts(pt(p.shift_start2,'h'))+'</select>:<select class="sch-pe-s2m">'+mOpts(pt(p.shift_start2,'m'))+'</select>'
        +'<span style="margin-left:8px">to</span><select class="sch-pe-e2h">'+hOpts(pt(p.shift_end2,'h'))+'</select>:<select class="sch-pe-e2m">'+mOpts(pt(p.shift_end2,'m'))+'</select></div>'
      +'</div></div>';
  }).join('');
  host.innerHTML='<div class="sch-pe-ov" onclick="schedClosePresetEditor(event)"><div class="sch-pe-box" onclick="event.stopPropagation()">'
    +'<div class="sch-pe-title">Edit quick-fill presets</div>'
    +'<div style="font-size:12px;color:var(--vino-light);margin-bottom:12px">These 4 buttons are shared with the whole team. Change the name, what it does, and the times.</div>'
    +rows
    +'<div class="sch-pe-actions"><button class="sch-modal-cancel" onclick="schedClosePresetEditor()">Cancel</button><button class="sch-modal-save" onclick="schedSavePresets()">Save presets</button></div>'
  +'</div></div>';
}
function schedPresetEditorToggle(i){
  var row=document.querySelector('#sch-preset-editor .sch-pe-row[data-i="'+i+'"]'); if(!row) return;
  var working=row.querySelector('.sch-pe-status').value==='working';
  document.getElementById('sch-pe-times-'+i).style.display = working?'block':'none';
  var chk=row.querySelector('.sch-pe-split-chk');
  document.getElementById('sch-pe-split2-'+i).style.display = (working && chk && chk.checked)?'block':'none';
}
function schedClosePresetEditor(ev){ if(ev && ev.target && !ev.target.classList.contains('sch-pe-ov')) return; var h=document.getElementById('sch-preset-editor'); if(h) h.innerHTML=''; }
async function schedSavePresets(){
  var rows=document.querySelectorAll('#sch-preset-editor .sch-pe-row'); var out=[];
  Array.prototype.forEach.call(rows, function(r,i){
    var label=(r.querySelector('.sch-pe-label').value||'').trim() || ('Preset '+(i+1));
    var status=r.querySelector('.sch-pe-status').value;
    var p={ slot:i+1, label:label, status:status, shift_start:null, shift_end:null, shift_start2:null, shift_end2:null };
    if(status==='working'){
      p.shift_start=r.querySelector('.sch-pe-sh').value+':'+r.querySelector('.sch-pe-sm').value;
      p.shift_end  =r.querySelector('.sch-pe-eh').value+':'+r.querySelector('.sch-pe-em').value;
      var chk=r.querySelector('.sch-pe-split-chk');
      if(chk && chk.checked){ p.shift_start2=r.querySelector('.sch-pe-s2h').value+':'+r.querySelector('.sch-pe-s2m').value; p.shift_end2=r.querySelector('.sch-pe-e2h').value+':'+r.querySelector('.sch-pe-e2m').value; }
    }
    out.push(p);
  });
  schedShiftPresets=out; schedRenderPresets(); schedClosePresetEditor();
  if(!DEV_READ_ONLY){
    var res=await sb.from('sched_shift_presets').upsert(out.map(function(p){ return { slot:p.slot, label:p.label, status:p.status, shift_start:p.shift_start, shift_end:p.shift_end, shift_start2:p.shift_start2, shift_end2:p.shift_end2, updated_at:new Date().toISOString() }; }), { onConflict:'slot' });
    if(res.error){ alert('Presets are set on this screen, but couldn’t be saved for the team: '+res.error.message+(res.error.code==='42P01'?'\n\nRun kitchen-shift-presets-schema.sql once first.':'')); }
  }
}

function schedOpenEdit(staffId, date) {
  if (!schedGuard(function(){ schedOpenEdit(staffId, date); })) return;
  if (schedPasteMode) { schedPasteToCell(staffId, date); return; }   // paste mode: tap = paste
  schedEditTarget = { staffId: staffId, date: date };
  var staff = schedStaff.find(function(s){ return s.id === staffId; });
  var row = schedRoster[schedRosterKey(staffId, date)];
  var d = new Date(date + 'T12:00:00');
  document.getElementById('sch-modal-title').textContent =
    (staff ? staff.name : '') + ' · ' + d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'});
  document.getElementById('sch-status-sel').value = row ? row.status : 'working';

  // Parse existing times
  var startTime = row && row.shift_start ? formatTime(row.shift_start) : '14:00';
  var endTime   = row && row.shift_end   ? formatTime(row.shift_end)   : '00:00';
  var startParts = startTime.split(':');
  var endParts   = endTime.split(':');

  document.getElementById('sch-start-h').value = startParts[0] || '14';
  document.getElementById('sch-start-m').value = startParts[1] || '00';
  document.getElementById('sch-end-h').value   = endParts[0]   || '00';
  document.getElementById('sch-end-m').value   = endParts[1]   || '00';
  document.getElementById('sch-notes-inp').value = row && row.notes ? row.notes : '';

  // Split shift
  var hasSplit = row && row.shift_start2 && row.shift_end2;
  var start2Time = hasSplit ? formatTime(row.shift_start2) : '18:00';
  var end2Time   = hasSplit ? formatTime(row.shift_end2)   : '00:00';
  var s2p = start2Time.split(':'), e2p = end2Time.split(':');
  document.getElementById('sch-start2-h').value = s2p[0] || '18';
  document.getElementById('sch-start2-m').value = s2p[1] || '00';
  document.getElementById('sch-end2-h').value   = e2p[0] || '00';
  document.getElementById('sch-end2-m').value   = e2p[1] || '00';

  var splitFields = document.getElementById('sch-split-fields');
  var splitToggle = document.getElementById('sch-split-toggle');
  if (hasSplit) {
    splitFields.style.display = 'block';
    splitToggle.textContent = '− Remove split shift';
    splitToggle.classList.add('active');
  } else {
    splitFields.style.display = 'none';
    splitToggle.textContent = '+ Add split shift';
    splitToggle.classList.remove('active');
  }

  // "Working in section" — defaults to their home section; pick another to cover it for this day only.
  var homeSec = staff ? (staff.station_key || '') : '';
  var secSel = document.getElementById('sch-section-sel');
  if (secSel) {
    secSel.innerHTML = schedSectionOptions((row && row.station_override) ? row.station_override : homeSec);
    secSel.setAttribute('data-home', homeSec);
  }

  schedStatusChange();
  schedRenderPresets();
  document.getElementById('sch-modal').style.display = 'flex';
}

function schedToggleSplit() {
  var fields = document.getElementById('sch-split-fields');
  var btn = document.getElementById('sch-split-toggle');
  var isOpen = fields.style.display !== 'none';
  if (isOpen) {
    fields.style.display = 'none';
    btn.textContent = '+ Add split shift';
    btn.classList.remove('active');
  } else {
    fields.style.display = 'block';
    btn.textContent = '− Remove split shift';
    btn.classList.add('active');
  }
}

function schedStatusChange() {
  var status = document.getElementById('sch-status-sel').value;
  document.getElementById('sch-time-fields').style.display = status === 'working' ? 'block' : 'none';
}
function schedCloseModal(e) {
  if (e && e.target !== document.getElementById('sch-modal')) return;
  document.getElementById('sch-modal').style.display = 'none';
  schedEditTarget = null;
}
async function schedSaveShift() {
  if (!schedEditTarget) return;
  var staffId = schedEditTarget.staffId;
  var date    = schedEditTarget.date;
  var status  = document.getElementById('sch-status-sel').value;
  var startH = document.getElementById('sch-start-h').value;
  var startM = document.getElementById('sch-start-m').value;
  var endH   = document.getElementById('sch-end-h').value;
  var endM   = document.getElementById('sch-end-m').value;
  var start  = startH + ':' + startM;
  var end    = endH   + ':' + endM;
  var hasSplit2 = document.getElementById('sch-split-fields').style.display !== 'none';
  var start2H = document.getElementById('sch-start2-h').value;
  var start2M = document.getElementById('sch-start2-m').value;
  var end2H   = document.getElementById('sch-end2-h').value;
  var end2M   = document.getElementById('sch-end2-m').value;
  var start2  = hasSplit2 ? (start2H + ':' + start2M) : null;
  var end2    = hasSplit2 ? (end2H   + ':' + end2M)   : null;
  var notes   = document.getElementById('sch-notes-inp').value.trim();
  var secSel  = document.getElementById('sch-section-sel');
  var homeSec = secSel ? (secSel.getAttribute('data-home') || '') : '';
  var chosenSec = secSel ? secSel.value : '';
  var stationOverride = (status === 'working' && chosenSec && chosenSec !== homeSec) ? chosenSec : null;
  document.getElementById('sch-modal').style.display = 'none';
  var key = schedRosterKey(staffId, date);
  var payload = Object.assign({}, schedRoster[key] || {}, {
    staff_id: staffId, work_date: date, status: status,
    shift_start:  status === 'working' ? (start||null)  : null,
    shift_end:    status === 'working' ? (end||null)    : null,
    shift_start2: status === 'working' ? (start2||null) : null,
    shift_end2:   status === 'working' ? (end2||null)   : null,
    station_override: stationOverride,
    notes: notes || null, updated_at: new Date().toISOString()
  });
  var prev = schedRoster[key];   // undefined when this day had no shift yet
  schedPushUndo([{ staffId: staffId, date: date }], 'edit ' + schedStaffName(staffId) + ', ' + schedDayLabel(date));
  schedRoster[key] = payload;
  renderSchedWeek();
  if (!DEV_READ_ONLY && !schedPlanMode) {
    var res = await sb.from('roster').upsert(payload, { onConflict: 'staff_id,work_date' });
    if (res.error) {
      // Save didn't reach the server — revert the optimistic change so the roster
      // never shows a shift the database doesn't have, and tell whoever edited it.
      // Silent here meant a failed edit stayed on screen looking saved until a
      // reload, and surfaced days later as wrong hours.
      if (prev === undefined) delete schedRoster[key]; else schedRoster[key] = prev;
      renderSchedWeek();
      console.error('Save error:', res.error);
      kToast('Shift not saved — check connection and tap the day again.', true);
    }
  }
  schedEditTarget = null;
}

// ── Day events (up to 2 per day, shown at the top of the schedule) ──
function schedOpenEvents(date) {
  if (schedPlanMode) { alert('Events (brunch, wine dinners…) are set on the live schedule, not while planning shifts.'); return; }
  if (!schedGuard(function(){ schedOpenEvents(date); })) return;
  schedEventDate = date;
  var evs = schedEvents[date] || [];
  schedEventSel = evs.map(function(e){ return e.name; }).slice(0,2);
  var d = new Date(date + 'T12:00:00');
  document.getElementById('sch-ev-title').textContent =
    d.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'short'}) + ' · events';
  document.getElementById('sch-ev-custom').value = '';
  schedRenderEventPicker();
  document.getElementById('sch-ev-modal').style.display = 'flex';
}
function schedRenderEventPicker() {
  document.getElementById('sch-ev-presets').innerHTML = KITCHEN_EVENT_PRESETS.map(function(p) {
    var on = schedEventSel.indexOf(p) >= 0;
    return '<button type="button" class="sch-ev-preset' + (on?' on':'') + '" onclick="schedToggleEvent(\'' + p + '\')">' + p + '</button>';
  }).join('');
  var sel = document.getElementById('sch-ev-selected');
  if (schedEventSel.length) {
    sel.innerHTML = schedEventSel.map(function(n,i) {
      return '<span class="sch-ev-selchip">' + schEvEsc(n) + '<span class="sch-ev-x" onclick="schedRemoveEvent(' + i + ')">&times;</span></span>';
    }).join('');
  } else {
    sel.innerHTML = '<span style="font-size:11px;color:var(--vino-light);font-family:var(--font-sans)">No events yet — tap up to 2.</span>';
  }
}
function schedToggleEvent(name) {
  var i = schedEventSel.indexOf(name);
  if (i >= 0) { schedEventSel.splice(i,1); }
  else {
    if (schedEventSel.length >= 2) { alert('Up to 2 events per day — remove one first.'); return; }
    schedEventSel.push(name);
  }
  schedRenderEventPicker();
}
function schedRemoveEvent(i) { schedEventSel.splice(i,1); schedRenderEventPicker(); }
function schedAddCustomEvent() {
  var inp = document.getElementById('sch-ev-custom');
  var v = inp.value.trim();
  if (!v) return;
  if (schedEventSel.length >= 2) { alert('Up to 2 events per day — remove one first.'); return; }
  if (schedEventSel.indexOf(v) < 0) schedEventSel.push(v);
  inp.value = '';
  schedRenderEventPicker();
}
function schedEventCustomKey(e) { if (e && e.key === 'Enter') { e.preventDefault(); schedAddCustomEvent(); } }
function schedCloseEvents(e) {
  if (e && e.target !== document.getElementById('sch-ev-modal')) return;
  document.getElementById('sch-ev-modal').style.display = 'none';
  schedEventDate = null;
}
function schedClearDayEvents() { schedEventSel = []; schedSaveEvents(); }
async function schedSaveEvents() {
  if (!schedEventDate) return;
  var date = schedEventDate;
  var inp = document.getElementById('sch-ev-custom');
  if (inp) { var pend = inp.value.trim(); if (pend && schedEventSel.length < 2 && schedEventSel.indexOf(pend) < 0) schedEventSel.push(pend); }
  var names = schedEventSel.slice(0,2);
  if (names.length) schedEvents[date] = names.map(function(n,i){ return {slot:i+1, name:n}; });
  else delete schedEvents[date];
  document.getElementById('sch-ev-modal').style.display = 'none';
  schedEventDate = null;
  renderSchedWeek();
  if (DEV_READ_ONLY) return;
  var del = await sb.from('sched_events').delete().eq('event_date', date);
  if (del.error) {
    console.error('Events clear error:', del.error);
    alert('Could not save events: ' + del.error.message + (del.error.code === '42P01' ? '\n\nCreate the sched_events table in Supabase first (run kitchen-events-schema.sql).' : ''));
    return;
  }
  if (names.length) {
    var rows = names.map(function(n,i){ return {event_date:date, slot:i+1, name:n, updated_at:new Date().toISOString()}; });
    var ins = await sb.from('sched_events').insert(rows);
    if (ins.error) { console.error('Events save error:', ins.error); alert('Could not save events: ' + ins.error.message); }
  }
}

// ── Copy / paste shifts (Excel-style: copy a cell, then tap others to paste) ──
function schedCopyShift() {
  if (!schedEditTarget) return;
  var status = document.getElementById('sch-status-sel').value;
  var start  = document.getElementById('sch-start-h').value + ':' + document.getElementById('sch-start-m').value;
  var end    = document.getElementById('sch-end-h').value   + ':' + document.getElementById('sch-end-m').value;
  var hasSplit2 = document.getElementById('sch-split-fields').style.display !== 'none';
  var start2 = hasSplit2 ? (document.getElementById('sch-start2-h').value + ':' + document.getElementById('sch-start2-m').value) : null;
  var end2   = hasSplit2 ? (document.getElementById('sch-end2-h').value   + ':' + document.getElementById('sch-end2-m').value)   : null;
  var working = status === 'working';
  schedClipboard = {
    status: status,
    shift_start:  working ? start  : null, shift_end:  working ? end  : null,
    shift_start2: working ? start2 : null, shift_end2: working ? end2 : null,
    srcStaff: schedEditTarget.staffId, srcDate: schedEditTarget.date,
    label: working ? (start + '–' + end + (start2 && end2 ? (' + ' + start2 + '–' + end2) : ''))
                   : ((STATUS_META[status] || {label:status}).label || status)
  };
  document.getElementById('sch-modal').style.display = 'none';
  schedEditTarget = null;
  schedPasteMode = true;
  schedWriteClipboard([{ staffId: schedClipboard.srcStaff, date: schedClipboard.srcDate }]); // keep the source cell
  schedShowPasteBar();
}
async function schedWriteClipboard(targets, undoLabel) {
  if (!schedClipboard || !targets.length) return 0;
  if (undoLabel) schedPushUndo(targets, undoLabel);   // snapshot BEFORE overwriting, so this paste is undoable
  var c = schedClipboard, now = new Date().toISOString(), payloads = [];
  targets.forEach(function(t) {
    var key = schedRosterKey(t.staffId, t.date);
    var payload = Object.assign({}, schedRoster[key] || {}, {
      staff_id: t.staffId, work_date: t.date, status: c.status,
      shift_start: c.shift_start, shift_end: c.shift_end,
      shift_start2: c.shift_start2, shift_end2: c.shift_end2, updated_at: now
    });
    schedRoster[key] = payload; payloads.push(payload);
  });
  renderSchedWeek();
  if (!DEV_READ_ONLY && !schedPlanMode) {
    var res = await sb.from('roster').upsert(payloads, { onConflict: 'staff_id,work_date' });
    if (res.error) { console.error('Paste error:', res.error); alert('Could not paste the shift: ' + res.error.message); return 0; }
  }
  return payloads.length;
}
function schedPasteToCell(staffId, date) {
  schedWriteClipboard([{ staffId: staffId, date: date }], 'paste to ' + schedStaffName(staffId) + ', ' + schedDayLabel(date)).then(function(n){ if (n) schedShowPasteBar(n); });
}
function schedFillWeek() {
  if (!schedClipboard) return;
  var t = []; for (var i = 0; i < 7; i++) t.push({ staffId: schedClipboard.srcStaff, date: formatDate(addDays(schedWeekStart, i)) });
  schedWriteClipboard(t, 'fill ' + schedStaffName(schedClipboard.srcStaff) + '’s week').then(function(n){ if (n) schedShowPasteBar(n); });
}
function schedFillDay() {
  if (!schedClipboard) return;
  var t = schedStaff.map(function(s){ return { staffId: s.id, date: schedClipboard.srcDate }; });
  schedWriteClipboard(t, 'fill whole day ' + schedDayLabel(schedClipboard.srcDate)).then(function(n){ if (n) schedShowPasteBar(n); });
}
function schedShowPasteBar(pastedCount) {
  // While the Roster tool is open the live schedule (#scheduling-view) is display:none,
  // and a position:fixed child of a hidden parent won't render — so host the bar in the
  // tool overlay whenever it's open, else on the live schedule as before.
  var tool = document.getElementById('kpl-full');
  var host = (tool && tool.style.display !== 'none') ? tool : (document.getElementById('scheduling-view') || document.body);
  var bar = document.getElementById('sch-paste-bar');
  if (!bar) {
    bar = document.createElement('div'); bar.id = 'sch-paste-bar';
    bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:9500;background:var(--vino,#410207);color:#fff;padding:9px 12px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.3);display:flex;align-items:center;gap:8px;font-family:var(--font-sans),sans-serif;font-size:13px;max-width:94vw;flex-wrap:wrap;justify-content:center';
    host.appendChild(bar);
  } else if (bar.parentElement !== host) {
    host.appendChild(bar);   // move it onto whichever surface is on top now
  }
  var bs = 'padding:6px 11px;border:1px solid rgba(255,255,255,.55);background:rgba(255,255,255,.12);color:#fff;border-radius:6px;cursor:pointer;font:inherit;font-weight:600';
  var msg = pastedCount ? ('&#9989; Pasted to ' + pastedCount + ' cell' + (pastedCount === 1 ? '' : 's') + ' &middot; keep tapping cells, or stop below')
                        : ('&#128203; Copied <b>' + (schedClipboard ? schedClipboard.label : '') + '</b> &middot; tap cells to paste');
  bar.innerHTML = '<span style="margin-right:2px">' + msg + '</span>' +
    '<button onclick="schedFillWeek()" style="' + bs + '">Fill person’s week</button>' +
    '<button onclick="schedFillDay()" style="' + bs + '">Fill whole day</button>' +
    '<button onclick="schedEndPaste()" style="' + bs + ';background:#fff;color:var(--vino,#410207)">&#10005; Stop pasting (Esc)</button>';
  bar.style.display = 'flex';
}
function schedEndPaste() {
  schedPasteMode = false; schedClipboard = null;
  var bar = document.getElementById('sch-paste-bar'); if (bar) bar.style.display = 'none';
}
document.addEventListener('keydown', function(e){ if (e.key === 'Escape' && schedPasteMode) schedEndPaste(); });

// ── Excel-style undo for the schedule ─────────────────────────────────────────
// Every cell change (edit, paste, fill week/day) snapshots the affected cells'
// PRIOR state before writing. Undo restores them on screen AND in the database:
// it puts the old shift back, or clears a cell that was newly filled. Multi-level,
// newest-first, capped so memory never grows without bound.
function schedStaffName(id){ var s = (schedStaff || []).find(function(x){ return x.id === id; }); return s ? s.name : 'staff'; }
function schedDayLabel(ds){ try { return new Date(ds + 'T12:00:00').toLocaleDateString('en-GB', { weekday:'short', day:'numeric' }); } catch(e){ return ds; } }
function schedPushUndo(targets, label){
  if (schedPlanMode) { krtNextLabel = label || krtNextLabel; return; }   // in the tool, the comprehensive krtUndo handles it
  var cells = targets.map(function(t){
    var key = schedRosterKey(t.staffId, t.date);
    return { staffId:t.staffId, date:t.date, key:key, prev: schedRoster[key] ? JSON.parse(JSON.stringify(schedRoster[key])) : null };
  });
  schedUndoStack.push({ label: label || 'last change', cells: cells });
  if (schedUndoStack.length > 25) schedUndoStack.shift();
  schedRenderUndoBtn();
}
async function schedUndoLast(){
  if (!schedUndoStack.length) return;
  var u = schedUndoStack.pop();
  var upserts = [], deletes = [];
  u.cells.forEach(function(c){
    if (c.prev){ schedRoster[c.key] = c.prev; upserts.push(c.prev); }
    else { delete schedRoster[c.key]; deletes.push(c); }
  });
  renderSchedWeek();
  schedRenderUndoBtn();
  if (!DEV_READ_ONLY && !schedPlanMode){
    try {
      if (upserts.length){ var r = await sb.from('roster').upsert(upserts, { onConflict:'staff_id,work_date' }); if (r.error) throw r.error; }
      for (var i = 0; i < deletes.length; i++){ var d = deletes[i]; var dr = await sb.from('roster').delete().eq('staff_id', d.staffId).eq('work_date', d.date); if (dr.error) throw dr.error; }
    } catch(e){ console.error('Undo sync error', e); alert('Undo could not reach the server: ' + (e.message || e) + '\nReopen the schedule to be sure it matches.'); }
  }
}
// Excel-style: the schedule's Undo button lives permanently in the toolbar (next to
// the lock, in index.html). Always visible — enabled with the last action in its
// tooltip when there's something to undo, greyed/disabled otherwise. On the live
// schedule this reverses real DB writes (schedUndoLast); the planning tool has its
// own krtUndo, so schedUndoStack stays empty there (schedPushUndo is guarded).
function schedRenderUndoBtn(){
  var btn = document.getElementById('sch-undo-btn');
  if (!btn) return;
  var unlocked = (typeof schedUnlocked === 'undefined' || schedUnlocked);
  var has = schedUndoStack.length > 0 && unlocked;
  btn.disabled = !has;
  if (has){
    var last = schedUndoStack[schedUndoStack.length - 1];
    btn.title = 'Undo: ' + last.label + (schedUndoStack.length > 1 ? ('  (' + schedUndoStack.length + ' changes can be undone)') : '');
    btn.innerHTML = '&#8630; Undo' + (schedUndoStack.length > 1 ? (' (' + schedUndoStack.length + ')') : '');
  } else {
    btn.title = unlocked ? 'Nothing to undo yet' : 'Unlock the schedule to edit, then Undo appears here';
    btn.innerHTML = '&#8630; Undo';
  }
}
// Ctrl/Cmd+Z on the schedule — but let text fields keep their own native undo.
document.addEventListener('keydown', function(e){
  if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey){
    var view = document.getElementById('scheduling-view');
    var tool = document.getElementById('kpl-full');
    var toolOpen = tool && tool.style.display !== 'none';
    if (!toolOpen && (!view || view.style.display === 'none')) return;   // only on the schedule or in the Roster tool
    var el = document.activeElement;
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    if (schedPlanMode){ if(!krtUndoStack.length) return; e.preventDefault(); krtUndoLast(); return; }   // in the tool: comprehensive draft undo
    if (!schedUndoStack.length) return;
    e.preventDefault(); schedUndoLast();
  }
});

// ── Move panel ──
function schedShowMove(mpid) {
  if (!schedGuard(function(){ schedShowMove(mpid); })) return;
  document.querySelectorAll('.sch-move-panel.show').forEach(function(p){ p.classList.remove('show'); });
  var el = document.getElementById(mpid);
  if (el) el.classList.add('show');
}
function schedHideMove(mpid) {
  var el = document.getElementById(mpid);
  if (el) el.classList.remove('show');
}
async function schedMoveStation(staffId, mpid) {
  var sel = document.getElementById(mpid + 'sel');
  if (!sel) return;
  var targetStation = sel.value;
  schedHideMove(mpid);
  var staff = schedStaff.find(function(s){ return s.id === staffId; });
  if (!staff || targetStation === staff.station_key) return;
  // Permanent move — update staff.station_key in Supabase
  staff.station_key = targetStation; // optimistic local update
  renderSchedWeek();
  if (!DEV_READ_ONLY && !schedPlanMode) {
    var res = await sb.from('staff').update({ station_key: targetStation }).eq('id', staffId);
    if (res.error) {
      console.error('Move error:', res.error);
      // revert on error
      loadSchedData().then(renderSchedWeek);
    }
  }
}


// ── Reorder staff within a section (↑/↓), mirrors FOH's fohSchedMoveStaff ──
// Renumber a section's members 1..N by array order; persist only rows that changed.
async function schedPersistSectionOrder(orderedMates) {
  var updates = [];
  orderedMates.forEach(function(s, i){ var want = i + 1; if (s.sort_order !== want) { s.sort_order = want; updates.push(s); } });
  for (var i = 0; i < updates.length; i++) {
    if (DEV_READ_ONLY || schedPlanMode) continue;
    var res = await sb.from('staff').update({ sort_order: updates[i].sort_order }).eq('id', updates[i].id);
    if (res.error) { console.error('Reorder error:', res.error); loadSchedData().then(renderSchedWeek); return; }
  }
}
function schedMoveStaff(event, staffId, dir) {
  event.stopPropagation();
  if (!schedGuard(function(){ schedMoveStaff(event, staffId, dir); })) return;
  var staff = schedStaff.find(function(s){ return s.id === staffId; });
  if (!staff) return;
  var mates = schedStaff.filter(function(s){ return s.station_key === staff.station_key; });
  var idx = mates.indexOf(staff), swapIdx = idx + dir;
  if (swapIdx < 0 || swapIdx >= mates.length) return;   // already at the top/bottom
  var other = mates[swapIdx];
  var gi = schedStaff.indexOf(staff), gj = schedStaff.indexOf(other);
  schedStaff[gi] = other; schedStaff[gj] = staff;        // swap so the render reflects it
  renderSchedWeek();
  schedPersistSectionOrder(schedStaff.filter(function(s){ return s.station_key === staff.station_key; }));
}

// ── Edit role inline ──
function schedEditRole(event, staffId) {
  event.stopPropagation();
  if (!schedGuard(null)) return;
  var staff = schedStaff.find(function(s){ return s.id === staffId; });
  if (!staff) return;
  var td = event.currentTarget;
  var current = staff.designation;
  td.innerHTML = '<input type="text" class="sch-role-input" value="' + current + '" ' +
    'onblur="schedSaveRole(\'' + staffId + '\',this)" ' +
    'onkeydown="if(event.key===\'Enter\')this.blur();if(event.key===\'Escape\')schedCancelRole(\'' + staffId + '\',this)" ' +
    'style="width:110px;padding:3px 6px;border:1px solid var(--vino);border-radius:3px;font-size:12px;font-family:var(--font-sans);background:var(--cream)"' +
    '/>';
  td.querySelector('input').focus();
  td.querySelector('input').select();
}

async function schedSaveRole(staffId, input) {
  var newRole = input.value.trim();
  var staff = schedStaff.find(function(s){ return s.id === staffId; });
  if (!staff || !newRole || newRole === staff.designation) {
    renderSchedWeek(); return;
  }
  staff.designation = newRole;
  renderSchedWeek();
  if (!DEV_READ_ONLY && !schedPlanMode) {
    var res = await sb.from('staff').update({ designation: newRole }).eq('id', staffId);
    if (res.error) { console.error('Role update error:', res.error); loadSchedData().then(renderSchedWeek); }
  }
}

function schedCancelRole(staffId, input) {
  renderSchedWeek();
}



// ── Delete staff ──
function schedConfirmDelete(event, staffId) {
  event.stopPropagation();
  if (!schedGuard(null)) return;
  var staff = schedStaff.find(function(s){ return s.id === staffId; });
  if (!staff) return;
  if (schedPlanMode) {
    // In planning you can only remove a person you ADDED in this plan; a real
    // teammate is removed on the live schedule (and you can move them instead).
    var isNew = (kplNewStaff||[]).some(function(n){ return n.id === staffId; });
    if (!isNew) { alert('Removing a teammate from the roster is done on the live schedule, not while planning.\n\nIn the plan you can move ' + staff.name + ' to another section instead.'); return; }
    if (!confirm('Remove ' + staff.name + ' from your plan? (They were only added here — nothing on the live schedule changes.)')) return;
    schedStaff = schedStaff.filter(function(s){ return s.id !== staffId; });
    kplNewStaff = kplNewStaff.filter(function(n){ return n.id !== staffId; });
    Object.keys(kplDraft).forEach(function(k){ if (k.indexOf(staffId + '|') === 0) delete kplDraft[k]; });
    renderSchedWeek(); schedPlanSaveDraft();
    return;
  }
  if (!confirm('Remove ' + staff.name + ' from the roster? This cannot be undone.')) return;
  schedStaff = schedStaff.filter(function(s){ return s.id !== staffId; });
  renderSchedWeek();
  if (!DEV_READ_ONLY) {
    sb.from('staff').update({ active: false }).eq('id', staffId).then(function(res) {
      if (res.error) { console.error('Delete error:', res.error); loadSchedData().then(renderSchedWeek); }
    });
  }
}

// ── Add staff ──
function schedShowAddStaff(stationKey) {
  if (!schedGuard(function(){ schedShowAddStaff(stationKey); })) return;
  document.querySelectorAll('.sch-add-staff-panel.show').forEach(function(p){ p.classList.remove('show'); });
  var panel = document.getElementById('sadd-' + stationKey);
  if (panel) { panel.classList.add('show'); panel.querySelector('.sch-add-name-inp').focus(); }
}
function schedHideAddStaff(stationKey) {
  var panel = document.getElementById('sadd-' + stationKey);
  if (panel) { panel.classList.remove('show'); }
}
async function schedSaveNewStaff(stationKey) {
  var nameInp = document.getElementById('sadd-name-' + stationKey);
  var roleInp = document.getElementById('sadd-role-' + stationKey);
  var name = nameInp ? nameInp.value.trim() : '';
  var role = roleInp ? roleInp.value.trim() : '';
  if (!name || !role) { alert('Please enter both name and role.'); return; }
  schedHideAddStaff(stationKey);
  var sortOrder = schedStaff.filter(function(s){ return s.station_key === stationKey; }).length + 1;
  // Optimistic add with temp id
  var tempId = 'temp-' + Date.now();
  var newStaff = { id: tempId, name: name, designation: role, station_key: stationKey, sort_order: sortOrder, active: true };
  schedStaff.push(newStaff);
  renderSchedWeek();
  if (!DEV_READ_ONLY && !schedPlanMode) {
    var res = await sb.from('staff').insert({ name: name, designation: role, station_key: stationKey, sort_order: sortOrder, active: true }).select().single();
    if (res.error) {
      console.error('Add staff error:', res.error);
      schedStaff = schedStaff.filter(function(s){ return s.id !== tempId; });
      renderSchedWeek();
    } else {
      // Replace temp id with real id
      var idx = schedStaff.findIndex(function(s){ return s.id === tempId; });
      if (idx !== -1) schedStaff[idx].id = res.data.id;
      renderSchedWeek();
    }
  }
}

// ── Copy to next week ──
function schedDuplicateWeek() {
  if (!schedGuard(function(){ schedDuplicateWeek(); })) return;
  var fmt = function(d){ return d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}); };
  document.getElementById('sch-dup-src').textContent =
    'Source: ' + fmt(schedWeekStart) + ' \u2013 ' + fmt(addDays(schedWeekStart, 6));
  document.getElementById('sch-dup-date').value = formatDate(addDays(schedWeekStart, 7));
  document.getElementById('sch-dup-overwrite').checked = false;
  document.getElementById('sch-dup-modal').style.display = 'flex';
}
function schedCloseDup(e) {
  if (e && e.target !== document.getElementById('sch-dup-modal')) return;
  document.getElementById('sch-dup-modal').style.display = 'none';
}
function schedCancelDup() {
  document.getElementById('sch-dup-modal').style.display = 'none';
}

async function schedDeleteWeek() {
  if (!schedGuard(function(){ schedDeleteWeek(); })) return;
  var from = formatDate(schedWeekStart);
  var to   = formatDate(addDays(schedWeekStart, 6));
  var fmt = function(d){ return d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}); };
  if (!confirm('Delete ALL roster entries for ' + fmt(schedWeekStart) + ' – ' + fmt(addDays(schedWeekStart,6)) + '?\n\nStaff names stay — only the shifts of this week are removed. This cannot be undone.')) return;
  // Optimistic local removal
  Object.keys(schedRoster).forEach(function(k) {
    var d = k.split('|')[1];
    if (d >= from && d <= to) delete schedRoster[k];
  });
  renderSchedView();
  if (!DEV_READ_ONLY) {
    var res = await sb.from('roster').delete().gte('work_date', from).lte('work_date', to);
    if (res.error) {
      console.error('Delete week error:', res.error);
      kToast('Could not delete the week — restoring.', true);
      loadSchedData().then(renderSchedView);
    }
  }
}
function schedDismissCopy() {
  document.getElementById('sch-copy-banner').style.display = 'none';
}
async function schedConfirmDuplicate() {
  var v = document.getElementById('sch-dup-date').value;
  if (!v) { alert('Pick a target week first.'); return; }
  var target = getMonday(new Date(v + 'T12:00:00'));
  var tFrom = formatDate(target);
  var tTo   = formatDate(addDays(target, 6));
  if (tFrom === formatDate(schedWeekStart)) { alert('Target week is the same as the source week.'); return; }
  var overwrite = document.getElementById('sch-dup-overwrite').checked;
  document.getElementById('sch-dup-modal').style.display = 'none';

  var offsetDays = Math.round((target - schedWeekStart) / 86400000);
  var days = []; for (var i = 0; i < 7; i++) days.push(addDays(schedWeekStart, i));

  // Existing entries in target week (queried live, works for any week)
  var existingSet = {};
  if (overwrite) {
    if (!DEV_READ_ONLY) {
      var del = await sb.from('roster').delete().gte('work_date', tFrom).lte('work_date', tTo);
      if (del.error) { console.error('Overwrite clear error:', del.error); alert('Could not clear the target week. Nothing was copied.'); return; }
    }
  } else {
    var ex = await sb.from('roster').select('staff_id,work_date').gte('work_date', tFrom).lte('work_date', tTo);
    (ex.data || []).forEach(function(r) {
      existingSet[r.staff_id + '|' + String(r.work_date).substring(0,10)] = true;
    });
  }

  var upserts = [];
  schedStaff.forEach(function(staff) {
    days.forEach(function(d) {
      var srcDate = formatDate(d);
      var tgtDate = formatDate(addDays(d, offsetDays));
      var existing = schedRoster[schedRosterKey(staff.id, srcDate)];
      if (!existing) return;
      if (!overwrite && existingSet[staff.id + '|' + tgtDate]) return;
      upserts.push({
        staff_id: staff.id, work_date: tgtDate,
        status: existing.status,
        shift_start:  existing.shift_start  || null,
        shift_end:    existing.shift_end    || null,
        shift_start2: existing.shift_start2 || null,
        shift_end2:   existing.shift_end2   || null,
        notes: existing.notes || null,
        station_override: existing.station_override || null,
        updated_at: new Date().toISOString()
      });
    });
  });
  if (!upserts.length) { alert('Nothing to duplicate \u2014 the source week is empty or the target is fully set.'); return; }
  if (!DEV_READ_ONLY) {
    var res = await sb.from('roster').upsert(upserts, { onConflict: 'staff_id,work_date', ignoreDuplicates: !overwrite });
    if (res.error) console.error('Duplicate error:', res.error);
  }
  // Duplicate the day-events to the target week (best-effort; table is optional)
  if (!DEV_READ_ONLY) {
    try {
      var evRows = [];
      for (var ek = 0; ek < 7; ek++) {
        var esd = formatDate(addDays(schedWeekStart, ek));
        var etgt = formatDate(addDays(new Date(esd + 'T12:00:00'), offsetDays));
        (schedEvents[esd] || []).forEach(function(ev) {
          evRows.push({ event_date: etgt, slot: ev.slot, name: ev.name, updated_at: new Date().toISOString() });
        });
      }
      if (overwrite) await sb.from('sched_events').delete().gte('event_date', tFrom).lte('event_date', tTo);
      if (evRows.length) await sb.from('sched_events').upsert(evRows, { onConflict: 'event_date,slot', ignoreDuplicates: !overwrite });
    } catch (err) { console.error('Event duplicate error:', err); }
  }
  // Jump to the target week to review
  schedWeekStart = target;
  await loadSchedData();
  renderSchedView();
}

// ── Print ──
function schedPrint() {
  var today = formatDate(new Date());
  var days = []; for (var i = 0; i < 7; i++) days.push(addDays(schedWeekStart, i));
  var dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  var weekStr = days[0].toLocaleDateString('en-GB',{day:'numeric',month:'short'}) + ' – ' +
    days[6].toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
  var html = '<div class="sch-print-header"><h2>Roberto\'s DIFC — Kitchen Roster</h2>' +
    '<p>Week: ' + weekStr + ' &nbsp;|&nbsp; Printed: ' +
    new Date().toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) + '</p></div>';
  html += '<table class="sch-print-table"><thead><tr><th class="pt-name">Name</th><th class="pt-role">Role</th>';
  for (var di2 = 0; di2 < days.length; di2++) {
    html += '<th' + (formatDate(days[di2]) === today ? ' class="pt-today"' : '') + '>' +
      dayNames[di2] + ' ' + days[di2].toLocaleDateString('en-GB',{day:'numeric',month:'short'}) + '</th>';
  }
  html += '<th>Hours</th><th>Days</th></tr></thead><tbody>';
  // Events strip — one row across the top, up to 2 events per day
  html += '<tr class="pt-events"><td colspan="2" class="pt-events-label">Events</td>';
  for (var pev = 0; pev < days.length; pev++) {
    var pevDs = formatDate(days[pev]);
    var pevList = schedEvents[pevDs] || [];
    html += '<td class="pt-events-cell">' + (pevList.length ? pevList.map(function(e){ return schEvEsc(e.name); }).join('<br>') : '') + '</td>';
  }
  html += '<td colspan="2" class="pt-events-cell"></td></tr>';
  STATIONS_SCH.forEach(function(st) {
    var stStaff = schedStaff.filter(function(s){ return s.station_key === st.key; });
    if (!stStaff.length) return;
    html += '<tr class="pt-station"><td colspan="11">' + st.label.toUpperCase() + '</td></tr>';
    stStaff.forEach(function(staff) {
      var wh = 0, wd = 0;
      html += '<tr><td class="pt-name">' + staff.name + '</td><td class="pt-role">' + staff.designation + '</td>';
      days.forEach(function(d) {
        var ds = formatDate(d);
        var row = schedRoster[schedRosterKey(staff.id, ds)];
        var isToday = ds === today;
        if (!row || row.status === 'working') {
          var ts = row ? formatTime(row.shift_start) : '';
          var te = row ? formatTime(row.shift_end) : '';
          var ts2 = row ? formatTime(row.shift_start2) : '';
          var te2 = row ? formatTime(row.shift_end2) : '';
          var h = calcHours(ts, te, ts2, te2);
          if (ts && te) { wh += h; wd++; }
          var cell = ts && te ? (ts + '–' + te + (ts2 && te2 ? '<br><span class="pt-split">' + ts2 + '–' + te2 + '</span>' : '')) : '';
          html += '<td' + (isToday ? ' class="pt-today"' : '') + '>' + cell + '</td>';
        } else {
          var meta = STATUS_META[row.status] || { label: row.status.toUpperCase() };
          if (row.status !== 'off') wd++;
          html += '<td class="pt-off pt-leave">' + meta.label + '</td>';
        }
      });
      html += '<td><strong>' + (wh > 0 ? (Math.round(wh * 10) / 10) + 'h' : '—') + '</strong></td><td>' + (wd||'—') + '</td></tr>';
    });
  });
  html += '</tbody></table>';
  var printDoc = '<!doctype html><html><head><title>Robertos Kitchen Roster</title>' +
    '<style>' +
    '@page{size:A3 landscape;margin:6mm}' +
    'body{font-family:Arial,sans-serif;color:#2a1a10;margin:0;font-size:14px}' +
    '.sch-print-header{margin-bottom:6px}' +
    '.sch-print-header h2{font-size:18px;margin:0 0 2px;color:#410207}' +
    '.sch-print-header p{font-size:10px;color:#666;margin:0}' +
    '.sch-print-table{width:100%;border-collapse:collapse;font-size:14px;table-layout:fixed}' +
    '.sch-print-table th{background:#410207;color:#fff;padding:4px 4px;text-align:center;border:1px solid #999;font-size:13px;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
    '.sch-print-table th.pt-name{text-align:left;padding-left:6px;width:14%}' +
    '.sch-print-table th.pt-role{text-align:left;width:11%}' +
    '.sch-print-table td{padding:2px 4px;border:1px solid #ccc;text-align:center;font-size:14px;font-weight:600;white-space:nowrap;line-height:1.1}' +
    '.sch-print-table td.pt-name{text-align:left;padding-left:6px;font-weight:700;white-space:normal}' +
    '.sch-print-table td.pt-role{text-align:left;font-size:12px;color:#444;font-weight:700;white-space:normal}' +
    '.sch-print-table .pt-split{font-size:12px;color:#444;font-weight:400}' +
    '.sch-print-table tr.pt-station td{background:#ece3d3;font-weight:800;font-size:13px;letter-spacing:1px;text-transform:uppercase;padding:3px 8px;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
    '.sch-print-table td.pt-today{background:#e8f5e9;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
    '.sch-print-table td.pt-off{color:#999}' +
    '.sch-print-table td.pt-leave{background:#fff9c4;font-weight:700;font-size:13px;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
    '.sch-print-table td.pt-events-label{background:#5e0a10;color:#fff;font-weight:700;font-size:12px;letter-spacing:1px;text-transform:uppercase;text-align:left;padding:3px 7px;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
    '.sch-print-table td.pt-events-cell{background:#f6eedd;color:#410207;font-weight:700;font-size:12px;white-space:normal;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
    '.sch-print-table tr{page-break-inside:avoid}' +
    '</style></head><body>' + html + '</body></html>';
  var w = window.open('', '_blank');
  if (!w) {
    document.getElementById('sch-print-area').innerHTML = html;
    setTimeout(function(){ window.print(); }, 100);
    return;
  }
  w.document.open();
  w.document.write(printDoc);
  w.document.close();
  w.focus();
  setTimeout(function(){ w.print(); }, 150);
}

// ── Download the roster as an Excel file (so the team can print from Excel, ──
// not only the wall poster). Reuses the exact same branded workbook that
// Send to HR builds — schedSendToHR(true) builds it and returns the file
// instead of emailing it.
async function schedDownloadXlsx(){
  var dbtn = document.getElementById('svt-dl');
  if(dbtn){ dbtn.textContent = '⏳ Building...'; dbtn.disabled = true; }
  try {
    var built = await schedSendToHR(true);
    if(!built){ if(dbtn){ dbtn.innerHTML='&#11015; Excel'; dbtn.disabled=false; } return; }
    var blob = new Blob([built.xlsxBuffer], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = built.fileName;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1500);
    if(dbtn){ dbtn.textContent = '✓ Downloaded'; setTimeout(function(){ dbtn.innerHTML='&#11015; Excel'; dbtn.disabled=false; }, 2500); }
  } catch(err){
    console.error('Kitchen Download Excel error:', err);
    alert('Could not build the Excel file: ' + (err.message||err));
    if(dbtn){ dbtn.innerHTML='&#11015; Excel'; dbtn.disabled=false; }
  }
}

// ── Where a Send-to-HR test goes ────────────────────────────────────────────
// On the local preview only, the roster email is addressed to one mailbox and
// nobody else — not HR, not the Cc list. The Edge Function has had a `testTo`
// for this since the recipients moved into Admin → Emails; nothing was wired to
// it, so the only way to see what the email looked like was to send a real one
// to HR. Live and dev hosts are untouched: dev-guard.js already blocks the send
// there outright, and on the two real sites this returns null.
function schedRosterTestTo(){
  var h = location.hostname;
  return (h === 'localhost' || h === '127.0.0.1') ? 'fguarracino@robertos.ae' : null;
}

// ── "What changed in this roster?" ──────────────────────────────────────────
// Replaces a yes/no confirm box. Antonio (10 Aug 2026): he had already sent the
// week to HR when Gaejindra asked to swap his day off with Joker, so the sheet
// changed by two cells and the email had no way to say which. Re-sending it
// meant HR checking every person; telling Leverina on WhatsApp instead is what
// actually happened, which puts the change outside the record entirely.
//
// The note is OPTIONAL — an unchanged first send should not have to invent a
// sentence. Resolves {note, update} or null if cancelled.
function schedHRNoteAsk(wkStr, wasSent){
  return new Promise(function(resolve){
    var done=false, testTo=schedRosterTestTo();
    function onKey(e){ if(e.key==='Escape') finish(null); }
    function finish(v){ if(done) return; done=true; var o=document.getElementById('hrn-ovl'); if(o) o.remove(); document.removeEventListener('keydown',onKey); resolve(v); }
    var ov=document.createElement('div'); ov.id='hrn-ovl';
    ov.setAttribute('style','position:fixed;inset:0;z-index:100050;background:rgba(65,2,7,.55);display:flex;align-items:flex-start;justify-content:center;padding:22px 14px;overflow:auto;');
    ov.onclick=function(e){ if(e.target===ov) finish(null); };
    ov.innerHTML='<div style="background:var(--cream,#f5ede0);border-radius:14px;max-width:540px;width:100%;padding:18px 18px 16px;box-shadow:0 14px 50px rgba(65,2,7,.35);">'
      +'<div style="font-family:var(--font-serif,Georgia,serif);color:var(--vino,#410207);font-size:22px;">Send the roster to HR</div>'
      +'<div style="font-size:12.5px;color:#8a7a62;margin:2px 0 14px;">Week of '+escHtml(wkStr)+'.</div>'
      // Ticked for them when we already have a record of sending this week, but
      // still theirs to change: the record is only as good as what got logged,
      // and they know whether HR has seen this week better than the log does.
      +'<label style="display:flex;gap:9px;align-items:flex-start;background:#fff;border:1px solid var(--sabbia-dark,#cfc0ad);border-radius:9px;padding:11px 12px;cursor:pointer;">'
        +'<input type="checkbox" id="hrn-upd" '+(wasSent?'checked':'')+' style="margin-top:2px;width:18px;height:18px;flex:none;">'
        +'<span style="font-size:13.5px;color:var(--ink,#2a1a10);line-height:1.4;">This replaces a roster I already sent for this week'
          +'<span style="display:block;font-size:11.5px;color:#8a7a62;margin-top:2px;">Adds a line telling HR to discard the earlier one.</span></span></label>'
      +'<div style="font-size:13.5px;color:var(--ink,#2a1a10);font-weight:600;margin:15px 0 3px;">What changed? <span style="font-weight:400;color:#8a7a62;">(optional)</span></div>'
      +'<div style="font-size:11.5px;color:#8a7a62;margin-bottom:7px;">HR read this at the top of the email, so they don&rsquo;t have to check every person to find it.</div>'
      +'<textarea id="hrn-note" rows="4" placeholder="e.g. Gaejindra&rsquo;s day off moved to next week, swapped with Joker. Everyone else is unchanged." '
        +'style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--sabbia-dark,#cfc0ad);border-radius:9px;font-size:15px;font-family:inherit;line-height:1.45;resize:vertical;"></textarea>'
      +'<div id="hrn-count" style="font-size:11px;color:#a89880;text-align:right;margin-top:3px;">&nbsp;</div>'
      +(testTo?'<div style="margin-top:10px;background:#fdeaea;border:1px solid #e0a9a9;border-radius:9px;padding:9px 11px;font-size:12.5px;color:#7f1d1d;">Local preview &mdash; this goes only to '+escHtml(testTo)+'. HR will not receive it.</div>':'')
      +'<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;border-top:1px solid var(--sabbia-dark,#cfc0ad);padding-top:13px;">'
        +'<button id="hrn-cancel" style="font-size:13px;color:#8a7a62;border:1px solid var(--sabbia-dark,#cfc0ad);background:#fff;border-radius:9px;padding:10px 15px;cursor:pointer;">Cancel</button>'
        +'<button id="hrn-send" style="font-size:13px;font-weight:600;color:#fff;background:var(--vino,#410207);border:1px solid var(--vino,#410207);border-radius:9px;padding:10px 17px;cursor:pointer;">'+(testTo?'Send test':'Send to HR')+'</button></div></div>';
    document.body.appendChild(ov);
    document.addEventListener('keydown',onKey);
    var ta=document.getElementById('hrn-note'), cnt=document.getElementById('hrn-count');
    // 2000 is the Edge Function's own limit. Saying so here means nothing is ever
    // silently cut off after they have pressed Send.
    ta.oninput=function(){ var n=ta.value.length; cnt.textContent = n>1700 ? (2000-n)+' characters left' : ' '; if(n>2000) ta.value=ta.value.slice(0,2000); };
    setTimeout(function(){ try{ ta.focus(); }catch(e){} }, 30);
    document.getElementById('hrn-cancel').onclick=function(){ finish(null); };
    document.getElementById('hrn-send').onclick=function(){
      finish({ note: ta.value.trim(), update: document.getElementById('hrn-upd').checked });
    };
  });
}

// ── Send to HR (email-ready roster, no manual attachment) ──
// Pass _downloadOnly=true to build the workbook and return {xlsxBuffer,fileName,...}
// without emailing — used by the Download Excel button above.
async function schedSendToHR(_downloadOnly) {
  var _wkEnd = addDays(schedWeekStart, 6);
  var _wkStr = schedWeekStart.toLocaleDateString('en-GB',{day:'numeric',month:'short'}) + ' to ' + _wkEnd.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
  var _note = '', _isUpdate = false;
  if(!_downloadOnly){
    var who = await resetIdentity('email the roster to HR');
    if (!who) return;
    // Have we sent this week before? Only pre-ticks the box in the dialog — the
    // person sending decides, so a missing or unreadable log costs nothing.
    var _wasSent = false;
    try {
      var _prior = await sb.from('reset_log').select('id')
        .eq('app','kitchen').eq('action','roster_send').eq('scope',_wkStr).limit(1);
      _wasSent = !!(_prior && _prior.data && _prior.data.length);
    } catch(e){ console.warn('[roster] re-send check failed', e); }
    var _ask = await schedHRNoteAsk(_wkStr, _wasSent);
    if (!_ask) return;                       // Cancel means nothing is sent.
    _note = _ask.note; _isUpdate = _ask.update;
  }
  var btn = _downloadOnly ? null : document.getElementById('svt-hr');
  if (btn) { btn.textContent = '⏳ Generating...'; btn.disabled = true; }
  try {
    var days = [];
    for (var i = 0; i < 7; i++) days.push(addDays(schedWeekStart, i));
    var dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    var weekStr = days[0].toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}) +
      ' to ' + days[6].toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});

    await schedLoadScript('https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js');

    var workbook = new ExcelJS.Workbook();
    workbook.creator = "Roberto's Kitchen";
    workbook.created = new Date();

    var sheet = workbook.addWorksheet('Roster', {
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 }
    });

    var VINO   = '6B1F2A';
    var SABBIA = 'F5F0E8';
    var GOLD   = 'C9A84C';
    var DARK   = '3D0F15';
    var LIGHT  = 'F0EBE2';

    function vinoBorder() {
      return { top:{style:'thin',color:{argb:'FF'+GOLD}}, bottom:{style:'thin',color:{argb:'FF'+GOLD}}, left:{style:'thin',color:{argb:'FF'+GOLD}}, right:{style:'thin',color:{argb:'FF'+GOLD}} };
    }
    function hairBorder() {
      return { top:{style:'hair',color:{argb:'FFDDDDDD'}}, bottom:{style:'hair',color:{argb:'FFDDDDDD'}}, left:{style:'hair',color:{argb:'FFDDDDDD'}}, right:{style:'hair',color:{argb:'FFDDDDDD'}} };
    }

    // Column widths
    sheet.columns = [
      {width:28}, {width:22}, {width:14}, {width:14}, {width:14},
      {width:14}, {width:14}, {width:14}, {width:14}, {width:13}, {width:11}
    ];

    var totalCols = 11;

    // Title row
    var titleRow = sheet.addRow(["ROBERTO'S DIFC — Kitchen Roster: " + weekStr]);
    titleRow.height = 36;
    sheet.mergeCells(titleRow.number, 1, titleRow.number, totalCols);
    titleRow.getCell(1).style = {
      font: { bold:true, size:16, color:{argb:'FF'+SABBIA}, name:'Calibri' },
      fill: { type:'pattern', pattern:'solid', fgColor:{argb:'FF'+VINO} },
      alignment: { horizontal:'center', vertical:'middle' }
    };

    // Subtitle
    var subRow = sheet.addRow(["Generated: " + new Date().toLocaleString('en-GB') + "   |   Week: " + weekStr]);
    subRow.height = 18;
    sheet.mergeCells(subRow.number, 1, subRow.number, totalCols);
    subRow.getCell(1).style = {
      font: { size:9, color:{argb:'FF'+VINO}, italic:true, name:'Calibri' },
      fill: { type:'pattern', pattern:'solid', fgColor:{argb:'FF'+SABBIA} },
      alignment: { horizontal:'center', vertical:'middle' }
    };

    // Blank separator
    sheet.addRow([]);

    // Column header row
    var hdrCells = ['Name','Role'];
    for (var di = 0; di < days.length; di++) hdrCells.push(dayNames[di] + ' ' + days[di].toLocaleDateString('en-GB',{day:'numeric',month:'short'}));
    hdrCells.push('Total Hours'); hdrCells.push('Days Worked');
    var hdrRow = sheet.addRow(hdrCells);
    hdrRow.height = 32;
    hdrRow.eachCell(function(cell) {
      cell.style = {
        font: { bold:true, size:10, color:{argb:'FF'+SABBIA}, name:'Calibri' },
        fill: { type:'pattern', pattern:'solid', fgColor:{argb:'FF'+VINO} },
        alignment: { horizontal:'center', vertical:'middle', wrapText:true },
        border: vinoBorder()
      };
    });

    // Data rows
    STATIONS_SCH.forEach(function(st) {
      var stStaff = schedStaff.filter(function(s){ return s.station_key === st.key; });
      if (!stStaff.length) return;

      // Station header
      var stRow = sheet.addRow([st.label.toUpperCase()]);
      stRow.height = 20;
      sheet.mergeCells(stRow.number, 1, stRow.number, totalCols);
      stRow.getCell(1).style = {
        font: { bold:true, size:10, color:{argb:'FFFFFFF0'}, name:'Calibri' },
        fill: { type:'pattern', pattern:'solid', fgColor:{argb:'FF'+DARK} },
        alignment: { horizontal:'left', vertical:'middle', indent:1 }
      };

      stStaff.forEach(function(staff) {
        var rowData = [staff.name, staff.designation];
        var wHours = 0, wDays = 0;
        var cellStatuses = [];

        for (var dj = 0; dj < days.length; dj++) {
          var ds = formatDate(days[dj]);
          var entry = schedRoster[schedRosterKey(staff.id, ds)];
          if (!entry || entry.status === 'working') {
            var ts = entry ? formatTime(entry.shift_start) : '';
            var te = entry ? formatTime(entry.shift_end) : '';
            var ts2 = entry ? formatTime(entry.shift_start2) : '';
            var te2 = entry ? formatTime(entry.shift_end2) : '';
            if (ts && te) {
              var h = calcHours(ts, te, ts2, te2);
              wHours += h; wDays++;
              rowData.push(ts + '-' + te + (ts2&&te2?' / '+ts2+'-'+te2:''));
              cellStatuses.push('working');
            } else { rowData.push(''); cellStatuses.push('empty'); }
          } else {
            var meta = STATUS_META[entry.status]||{label:entry.status.toUpperCase()};
            if (entry.status !== 'off') wDays++;
            rowData.push(meta.label);
            cellStatuses.push(entry.status);
          }
        }
        rowData.push(wHours > 0 ? (Math.round(wHours * 10) / 10) + 'h' : '');
        rowData.push(wDays || '');

        var dataRow = sheet.addRow(rowData);
        dataRow.height = 18;

        dataRow.eachCell({includeEmpty:true}, function(cell, colNumber) {
          var baseFont = { size:10, name:'Calibri' };
          var baseBorder = hairBorder();
          var col = colNumber - 1; // 0-indexed

          if (col === 0) {
            cell.style = { font:Object.assign({bold:true},baseFont), fill:{type:'pattern',pattern:'solid',fgColor:{argb:'FF'+SABBIA}}, border:baseBorder, alignment:{vertical:'middle'} };
          } else if (col === 1) {
            cell.style = { font:Object.assign({italic:true,color:{argb:'FF888888'}},baseFont), fill:{type:'pattern',pattern:'solid',fgColor:{argb:'FF'+SABBIA}}, border:baseBorder, alignment:{vertical:'middle'} };
          } else if (col >= rowData.length - 2) {
            cell.style = { font:Object.assign({bold:true,color:{argb:'FF'+VINO}},baseFont), fill:{type:'pattern',pattern:'solid',fgColor:{argb:'FF'+LIGHT}}, border:baseBorder, alignment:{horizontal:'center',vertical:'middle'} };
          } else {
            var status = cellStatuses[col-2];
            var fills = { working:'FFFFFFFF', off:'FFF5F5F5', wo:'FFDBEAFE', sl:'FFFFF3C7', al:'FFD1FAE5', ph:'FFEDE9FE', em:'FFFEE2E2', tr:'FFCCFBF1', cat:'FFFFEDD5', empty:'FFFFFFFF' };
            var fgColors = { working:'FF333333', off:'FF999999', wo:'FF1e40af', sl:'FF92400e', al:'FF065f46', ph:'FF5b21b6', em:'FF991b1b', tr:'FF134e4a', cat:'FF9a3412', empty:'FFCCCCCC' };
            cell.style = {
              font: Object.assign({ bold: status !== 'working' && status !== 'empty', color:{argb: fgColors[status]||'FF333333'} }, baseFont),
              fill: { type:'pattern', pattern:'solid', fgColor:{argb: fills[status]||'FFFFFFFF'} },
              border: baseBorder,
              alignment: { horizontal:'center', vertical:'middle' }
            };
          }
        });
      });

      // Blank row between stations
      sheet.addRow([]);
    });

    // Generate the file
    var xlsxBuffer = await workbook.xlsx.writeBuffer();
    var fileName = 'Roster_' + formatDate(days[0]) + '_to_' + formatDate(days[6]) + '.xlsx';
    if(_downloadOnly){ return { xlsxBuffer:xlsxBuffer, fileName:fileName, weekStr:weekStr, days:days }; }
    var xlsxBase64 = btoa(String.fromCharCode.apply(null, new Uint8Array(xlsxBuffer)));

    if (btn) btn.textContent = '📧 Sending...';

    // Route through Supabase Edge Function to avoid CORS
    var emailRes = await fetch('https://zrpglswalgjbtghudmhu.supabase.co/functions/v1/send-roster', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + SUPABASE_KEY
      },
      body: JSON.stringify({
        weekStr: weekStr,
        fileName: fileName,
        xlsxBase64: xlsxBase64,
        note: _note,
        update: _isUpdate,
        sentBy: who && who.name,
        testTo: schedRosterTestTo() || undefined
      })
    });

    var emailData = await emailRes.json();
    if (!emailRes.ok) throw new Error(emailData.message || 'Email failed: ' + emailRes.status);
    // The function reports back how much of the note it actually printed. If we
    // typed one and it arrived empty, the tick must not say it went.
    if (_note && !emailData.noted) throw new Error('The roster was sent, but your note did not reach the email. Please tell HR the change directly.');

    if (typeof logReset === 'function') logReset(who, 'roster_send', _wkStr, null);

    // The roster reached HR either way, so this is not a failure — but if the Cc
    // list did not come from the FOH app's Admin → Emails screen, then whoever was
    // ticked there was ignored, and a green tick says the opposite of what happened.
    //
    // Not hypothetical: between 1 and 14 Aug 2026 the key that reads that screen
    // was the wrong one, every roster went to a list hardcoded in the function,
    // and this button said '✓ Sent to HR' every time. The function had been
    // reporting usedFallback the whole time and nothing displayed it. A flag
    // nobody shows is the same as no flag at all.
    var fellBack = emailData.usedFallback === true;
    var copied = (emailData.recipients || []);

    if (fellBack) {
      alert('The roster WAS sent to HR — but the copy list did not come from Admin → Emails.\n\n'
        + (emailData.fallbackReason ? 'Reason: ' + emailData.fallbackReason + '.\n\n' : '')
        + 'The app used its built-in list instead, so these ' + copied.length + ' were copied:\n\n'
        + copied.join('\n')
        + '\n\nAnyone added or removed on that screen was ignored on this send. '
        + 'HR has the roster, so nothing needs re-sending — but please report this so the list can be fixed.');
    }

    if (btn) {
      // Says who, not just that it went — which people got it is the whole point,
      // and it is the thing that was silently wrong.
      var okLabel = (_note ? '✓ Sent with your note' : '✓ Sent to HR')
                  + (copied.length ? ' · ' + copied.length + ' copied' : '');
      btn.textContent = fellBack ? '⚠ Sent — wrong copy list' : okLabel;
      btn.style.background = fellBack ? '#b45309' : 'var(--oliva)';
      btn.style.borderColor = fellBack ? '#b45309' : 'var(--oliva)';
      // A warning has to outlast a glance; a tick does not.
      setTimeout(function(){ btn.textContent = '📧 Send to HR'; btn.style.background=''; btn.style.borderColor=''; btn.disabled=false; }, fellBack ? 12000 : 3000);
    }
  } catch(err) {
    console.error('Send to HR error:', err);
    alert('Failed: ' + (err.message || err));
    if (btn) { btn.textContent = '📧 Send to HR'; btn.disabled = false; }
  }
}


function schedLoadScript(src) {
  return new Promise(function(resolve, reject) {
    if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
    var s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}
