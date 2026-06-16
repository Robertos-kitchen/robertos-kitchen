const SUPABASE_URL = 'https://zrpglswalgjbtghudmhu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpycGdsc3dhbGdqYnRnaHVkbWh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5MTIyMjQsImV4cCI6MjA5NjQ4ODIyNH0.pfABN-so4xINK7nHxXUlVeTO4g0h0l6ILHVwpoKrbds';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const DEV_READ_ONLY = false;

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
function getServiceDate(){
  var d = new Date();
  if(d.getHours() < 6){ d.setDate(d.getDate() - 1); }
  return formatDate(d);
}
function getToday(){ return getServiceDate(); }
const TODAY = getServiceDate();

// Check every 60s: 1) if service date changed (at 06:00), 2) if new app version available
const APP_VERSION = 1781613597;
setInterval(function(){
  // Service-day rollover at 06:00 - not at midnight
  if(getServiceDate() !== TODAY){
    window.location.reload();
    return;
  }
  // Version check — only auto-reload between midnight and 6am (off-peak hours)
  var hour = new Date().getHours();
  if(hour >= 0 && hour < 6){
    fetch(window.location.pathname + '?_=' + Date.now(), {cache:'no-store'})
      .then(function(r){ return r.text(); })
      .then(function(html){
        var m = html.match(/app\.js\?v=(\d+)/);
        if(m && parseInt(m[1]) > APP_VERSION){
          window.location.reload();
        }
      }).catch(function(){});
  }
}, 60000);
const CHECK_STORAGE_KEY = 'robertos-chef-checks-' + TODAY;
const ORDER_STORAGE_PREFIX = 'robertos-order-list-';

let STATIONS = [];
let state = {};
let chefChecks = [];
let orderQuantities = {};
let activeOrderDate = TODAY;
let activeRecipeId = null;
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
  loadOrderQuantities();
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
    const [r1, r2, r3, r4] = await Promise.all([
      sb.from('stations').select('*').eq('active', true).order('sort_order'),
      sb.from('subsections').select('*').eq('active', true).order('sort_order'),
      sb.from('dishes').select('*').eq('active', true).order('sort_order'),
      sb.from('dish_components').select('*').eq('active', true).order('sort_order')
    ]);
    const stationsData   = r1.data;
    const subsectionsData = r2.data;
    const dishesData     = r3.data;
    const componentsData = r4.data;

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
    const { data: todayRows } = await sb.from('prep_status').select('*').eq('service_date', TODAY);

    if (todayRows && todayRows.length > 0) {
      todayRows.forEach(row => {
        const id = mkId(row.station_key, row.subsection_key, row.dish_name, row.component_name);
        state[id] = row.status;
      });
      return;
    }

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

    await sb.from('prep_status').upsert(newRows, {
      onConflict: 'service_date,station_key,subsection_key,dish_name,component_name'
    });

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
  try{await sb.from('chef_checks').upsert(chefCheckToRow(check),{onConflict:'service_date,check_id'});}
  catch(e){console.warn('Chef checklist Supabase sync failed',e);}
}
async function deleteChefCheck(id){
  chefChecks=chefChecks.filter(c=>c.id!==id);
  saveChefChecks();
  if(DEV_READ_ONLY)return;
  try{await sb.from('chef_checks').delete().eq('service_date',TODAY).eq('check_id',id);}
  catch(e){console.warn('Chef checklist delete sync failed',e);}
}
function renderAfterChefCheckSync(){
  renderTabs();
  if(activeStation===CHECK_KEY)renderCheckView();
  else if(activeStation===DASHBOARD_KEY)renderDashboard();
  else if(activeStation===REPORTS_KEY)renderReports();
  else if(activeStation!==HOME_KEY&&activeStation!==ORDER_KEY&&activeStation!==RECIPES_KEY&&activeStation!==SCHED_KEY)renderContent();
}
function orderStorageKey(date){return ORDER_STORAGE_PREFIX + date;}
function loadOrderQuantities(){
  try{orderQuantities=JSON.parse(localStorage.getItem(orderStorageKey(activeOrderDate))||'{}');}
  catch(e){orderQuantities={};}
}
function saveOrderQuantities(){
  localStorage.setItem(orderStorageKey(activeOrderDate),JSON.stringify(orderQuantities));
}

// â”€â”€ SAVE STATUS TO SUPABASE â”€â”€
async function saveStatus(stKey, ssKey, dishName, component, newStatus, prevStatus) {
  if (DEV_READ_ONLY) return;
  const row = { service_date: TODAY, station_key: stKey, subsection_key: ssKey, dish_name: dishName, component_name: component, status: newStatus, updated_at: new Date().toISOString() };
  await sb.from('prep_status').upsert(row, { onConflict: 'service_date,station_key,subsection_key,dish_name,component_name' });
  await sb.from('prep_status_log').insert({ service_date: TODAY, station_key: stKey, subsection_key: ssKey, dish_name: dishName, component_name: component, status: newStatus, previous_status: prevStatus });
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
async function resetChefChecklist(){
  if(!confirm('Reset all chef checklist checks for today?'))return;
  chefChecks=[];
  saveChefChecks();
  if(!DEV_READ_ONLY){
    try{await sb.from('chef_checks').delete().eq('service_date',TODAY);}
    catch(e){console.warn('Chef checklist reset sync failed',e);}
  }
  renderAfterChefCheckSync();
}
function renderStationChecks(stKey){
  const checks=chefChecks.filter(c=>c.stationKey===stKey);
  if(!checks.length)return '';
  return `<div class="station-checks">
    <div class="station-checks-head">Chef checklist for this station</div>
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

async function loadCovers() {
  const { data } = await sb.from('covers').select('*').gte('service_date', TODAY).order('service_date');
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
  const coversUpdated = tonight ? new Date(tonight.updated_at).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}) : null;

  // Next 6 days covers
  const upcomingDays = [];
  for (var di = 0; di < 7; di++) {
    var d = new Date(); d.setDate(d.getDate() + di);
    var ds = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    var row = dashCovers[ds];
    if (row) upcomingDays.push({
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
    return '<div class="dash-cover-day' + (d.label==='Tonight'?' dash-cover-today':'') + '">' +
      '<div class="dash-cover-label">' + d.label + '</div>' +
      '<div class="dash-cover-num">' + d.night + '</div>' +
      '<div class="dash-cover-sub">night</div>' +
    '</div>';
  }).join('');

  const coversCard = nightCovers !== null
    ? `<div class="ops-card dark dash-covers-card">
        <div class="ops-num">${nightCovers}</div>
        <div class="ops-label">Tonight's covers</div>
        ${coversUpdated ? '<div class="dash-covers-sync">SevenRooms · updated ' + coversUpdated + '</div>' : ''}
       </div>`
    : `<div class="ops-card dash-covers-card dash-no-covers">
        <div class="ops-num">—</div>
        <div class="ops-label">Tonight's covers</div>
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
      <div class="ops-panel-head">Upcoming covers <span style="font-size:10px;opacity:.6;font-weight:400;margin-left:8px">from SevenRooms</span></div>
      <div class="dash-covers-row">${coversRow}</div>
    </div>` : ''}
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
        'x-proxy-secret': 'Kitchen'
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
function applyReports(){
  const single=document.getElementById('report-single-date')?.value||TODAY;
  const from=document.getElementById('report-from-date')?.value||'';
  const to=document.getElementById('report-to-date')?.value||'';
  const station=document.getElementById('report-station')?.value||'';
  const status=document.getElementById('report-status')?.value||'';
  const search=(document.getElementById('report-search')?.value||'').toLowerCase();
  const rows=currentReportRows().filter(r=>{
    const dateOk=dateInReportRange(r.date,from||to?'':single,from,to);
    const stationOk=!station||r.stationKey===station;
    const statusOk=!status||r.status===status;
    const text=(r.station+' '+r.subsection+' '+r.dish+' '+r.item+' '+r.note).toLowerCase();
    return dateOk&&stationOk&&statusOk&&(!search||text.includes(search));
  });
  const prepCount=rows.filter(r=>r.type==='Prep').length;
  const checkCount=rows.filter(r=>r.type==='Chef check').length;
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
    ${table}`;
}

// â”€â”€ ORDER INVENTORY â”€â”€
function orderItems(){return Array.isArray(window.ORDER_ITEMS)?window.ORDER_ITEMS:[];}
function orderCategories(){
  return [...new Set(orderItems().map(i=>i.category||'Market List'))].sort();
}
function orderRowsFiltered(){
  const q=(document.getElementById('order-search')?.value||'').toLowerCase();
  const cat=document.getElementById('order-category')?.value||'';
  const only=document.getElementById('order-only')?.checked||false;
  return orderItems().filter(i=>{
    const qty=Number(orderQuantities[i.article]||0);
    const text=(i.article+' '+i.name+' '+i.unit+' '+i.category).toLowerCase();
    return (!q||text.includes(q))&&(!cat||i.category===cat)&&(!only||qty>0);
  });
}
function orderTotals(){
  let lines=0,total=0;
  orderItems().forEach(i=>{
    const qty=Number(orderQuantities[i.article]||0), price=Number(i.price||0);
    if(qty>0){lines++;total+=qty*price;}
  });
  return {lines,total};
}
function money(v){return 'AED '+Number(v||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});}
function orderedLines(){
  return orderItems().filter(i=>Number(orderQuantities[i.article]||0)>0).map(i=>{
    const qty=Number(orderQuantities[i.article]||0), price=Number(i.price||0);
    return {...i,qty,lineTotal:qty*price};
  });
}
function renderOrderInventory(){
  const cats=['<option value="">All categories</option>',...orderCategories().map(c=>`<option value="${c}">${c}</option>`)].join('');
  document.getElementById('order-view').innerHTML=`
    <div class="ops-title">Order Inventory</div>
    <div class="ops-subtitle">${activeOrderDate} · prices from latest inventory file</div>
    <div class="order-toolbar">
      <div class="order-filter-grid">
        <div class="check-field"><div class="check-label">Order date</div><input class="check-input" id="order-date" type="date" value="${activeOrderDate}" onchange="changeOrderDate(this.value)"></div>
        <div class="check-field"><div class="check-label">Search item</div><input class="check-input" id="order-search" placeholder="Beef, tomato, flour..." oninput="renderOrderRows()"></div>
        <div class="check-field"><div class="check-label">Category</div><select class="check-select" id="order-category" onchange="renderOrderRows()">${cats}</select></div>
        <label class="check-label" style="display:flex;gap:7px;align-items:center;height:37px"><input id="order-only" type="checkbox" onchange="renderOrderRows()"> Ordered only</label>
        <button class="check-reset" onclick="resetOrderList()">Reset order</button>
      </div>
      <div class="order-actions">
        <button class="report-btn" onclick="showOrderedOnly()">Show ordered list</button>
        <button class="report-btn" onclick="printOrderList()">Print ordered</button>
        <button class="report-btn" onclick="emailOrderList()">Email ordered</button>
      </div>
    </div>
    <div id="order-summary"></div>
    <div id="order-content"></div>`;
  renderOrderRows();
}
function renderOrderRows(){
  const rows=orderRowsFiltered();
  const totals=orderTotals();
  document.getElementById('order-summary').innerHTML=`
    <div class="ops-grid">
      <div class="ops-card dark"><div class="ops-num">${money(totals.total)}</div><div class="ops-label">Total order value</div></div>
      <div class="ops-card"><div class="ops-num">${totals.lines}</div><div class="ops-label">Ordered lines</div></div>
      <div class="ops-card"><div class="ops-num">${orderItems().length}</div><div class="ops-label">Inventory items</div></div>
      <div class="ops-card"><div class="ops-num">${rows.length}</div><div class="ops-label">Visible rows</div></div>
    </div>`;
  const table=rows.length?`<div class="order-table">
    <div class="order-row head"><div>Article</div><div>Item</div><div>Unit</div><div>Price</div><div>Qty</div><div>Total</div><div>Action</div></div>
    ${rows.slice(0,350).map(i=>{
      const qty=Number(orderQuantities[i.article]||0), total=qty*Number(i.price||0);
      return `<div class="order-row">
        <div>${i.article}</div>
        <div><div class="order-name">${i.name}</div><div class="order-meta">${i.category||'Market List'}</div></div>
        <div>${i.unit||''}</div>
        <div class="order-money">${money(i.price)}</div>
        <div><input class="order-qty" type="number" min="0" step="0.01" value="${qty||''}" onchange="setOrderQty('${i.article}',this.value)"></div>
        <div class="order-money">${money(total)}</div>
        <div>${qty>0?`<button class="check-remove" onclick="clearOrderItem('${i.article}')">Clear</button>`:''}</div>
      </div>`;
    }).join('')}
  </div>`:`<div class="report-no-data">No inventory items match these filters</div>`;
  document.getElementById('order-content').innerHTML=table+(rows.length>350?`<div class="report-no-data">Showing first 350 rows. Use search or category to narrow the list.</div>`:'');
}
function setOrderQty(article,value){
  const qty=Number(value||0);
  if(qty>0)orderQuantities[article]=qty;
  else delete orderQuantities[article];
  saveOrderQuantities();
  renderOrderRows();
}
function clearOrderItem(article){
  delete orderQuantities[article];
  saveOrderQuantities();
  renderOrderRows();
}
function changeOrderDate(date){
  if(!date)return;
  activeOrderDate=date;
  loadOrderQuantities();
  renderOrderInventory();
}
function showOrderedOnly(){
  const cb=document.getElementById('order-only');
  if(cb)cb.checked=true;
  renderOrderRows();
}
function orderText(){
  const lines=orderedLines(), totals=orderTotals();
  const rows=lines.map(i=>`${i.qty} ${i.unit||''} - ${i.name} (${i.article}) @ ${money(i.price)} = ${money(i.lineTotal)}`);
  return [`Roberto's Kitchen Order`, `Date: ${activeOrderDate}`, `Lines: ${lines.length}`, `Total: ${money(totals.total)}`, '', ...rows].join('\\n');
}
function printOrderList(){
  const lines=orderedLines();
  if(!lines.length){alert('No ordered items to print.');return;}
  const totals=orderTotals();
  const rows=lines.map(i=>`<tr><td>${i.article}</td><td>${i.name}</td><td>${i.unit||''}</td><td>${i.qty}</td><td>${money(i.price)}</td><td>${money(i.lineTotal)}</td></tr>`).join('');
  const w=window.open('','_blank');
  if(!w)return;
  w.document.write(`<html><head><title>Roberto's Kitchen Order ${activeOrderDate}</title><style>body{font-family:Arial,sans-serif;margin:28px;color:#2a1a10}h1{font-family:Georgia,serif;color:#410207}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #cfc0ad;padding:8px;text-align:left}th{background:#410207;color:#f5ede0}.total{font-size:20px;margin:12px 0;color:#410207}</style></head><body><h1>Roberto's Kitchen Order</h1><div>Date: ${activeOrderDate}</div><div class="total">Total: ${money(totals.total)}</div><table><thead><tr><th>Article</th><th>Item</th><th>Unit</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table></body></html>`);
  w.document.close();w.focus();w.print();
}
function emailOrderList(){
  const lines=orderedLines();
  if(!lines.length){alert('No ordered items to email.');return;}
  const subject=encodeURIComponent(`Roberto's Kitchen Order ${activeOrderDate}`);
  const body=encodeURIComponent(orderText());
  window.location.href=`mailto:?subject=${subject}&body=${body}`;
}
function resetOrderList(){
  if(!confirm('Reset all order quantities for '+activeOrderDate+'?'))return;
  orderQuantities={};
  saveOrderQuantities();
  renderOrderInventory();
}

// â”€â”€ RECIPES â”€â”€
function recipeItems(){return Array.isArray(window.RECIPES)?window.RECIPES:[];}
function escHtml(v){return String(v??'').replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];});}
function recipeQualityLabel(q){
  return {good:'Full recipe',ingredients_only:'Ingredients only',needs_cleanup:'Needs cleanup',menu_text:'Menu text'}[q]||q;
}
function recipeOptions(field,label){
  return [`<option value="">All ${label}</option>`,...[...new Set(recipeItems().map(r=>r[field]||'Unsorted'))].sort().map(v=>`<option value="${escHtml(v)}">${escHtml(v)}</option>`)].join('');
}
function recipeRowsFiltered(){
  const q=(document.getElementById('recipe-search')?.value||'').toLowerCase();
  const menu=document.getElementById('recipe-menu')?.value||'';
  const station=document.getElementById('recipe-station')?.value||'';
  const quality=document.getElementById('recipe-quality')?.value||'';
  return recipeItems().filter(r=>{
    const text=[r.title,r.sourceFile,r.menu,r.category,r.station,(r.ingredients||[]).join(' '),(r.method||[]).join(' ')].join(' ').toLowerCase();
    return (!q||text.includes(q))&&(!menu||r.menu===menu)&&(!station||r.station===station)&&(!quality||r.quality===quality);
  });
}
function renderRecipes(){
  document.getElementById('recipes-view').innerHTML=`
    <div class="ops-title">Recipes</div>
    <div class="ops-subtitle">${recipeItems().length} extracted recipe records · searchable library</div>
    <div class="order-toolbar">
      <div class="report-filter-grid">
        <div class="check-field"><div class="check-label">Search recipe</div><input class="check-input" id="recipe-search" placeholder="Ricciola, basil oil, tiramisu..." oninput="renderRecipeRows()"></div>
        <div class="check-field"><div class="check-label">Menu</div><select class="check-select" id="recipe-menu" onchange="renderRecipeRows()">${recipeOptions('menu','menus')}</select></div>
        <div class="check-field"><div class="check-label">Station</div><select class="check-select" id="recipe-station" onchange="renderRecipeRows()">${recipeOptions('station','stations')}</select></div>
        <div class="check-field"><div class="check-label">Status</div><select class="check-select" id="recipe-quality" onchange="renderRecipeRows()"><option value="">All statuses</option><option value="good">Full recipe</option><option value="ingredients_only">Ingredients only</option><option value="needs_cleanup">Needs cleanup</option><option value="menu_text">Menu text</option></select></div>
      </div>
    </div>
    <div class="recipe-layout">
      <div id="recipe-list" class="recipe-list"></div>
      <div id="recipe-detail" class="recipe-detail"></div>
    </div>`;
  renderRecipeRows();
}
function renderRecipeRows(){
  const rows=recipeRowsFiltered();
  if(!rows.find(r=>r.id===activeRecipeId))activeRecipeId=rows[0]?.id||null;
  const list=rows.length?rows.slice(0,220).map(r=>`
    <button class="recipe-row${r.id===activeRecipeId?' active':''}" onclick="selectRecipe('${r.id}')">
      <div class="recipe-title">${escHtml(r.title)}</div>
      <div class="recipe-meta">${escHtml(r.menu)} · ${escHtml(r.category)} · ${escHtml(r.station)}</div>
      <span class="recipe-quality ${escHtml(r.quality)}">${recipeQualityLabel(r.quality)}</span>
    </button>`).join(''):`<div class="recipe-empty">No recipes match these filters</div>`;
  document.getElementById('recipe-list').innerHTML=list+(rows.length>220?`<div class="recipe-empty">Showing first 220 recipes. Use search or filters to narrow the list.</div>`:'');
  renderRecipeDetail();
}
function selectRecipe(id){
  activeRecipeId=id;
  renderRecipeRows();
}
function renderRecipeDetail(){
  const el=document.getElementById('recipe-detail');
  const r=recipeItems().find(x=>x.id===activeRecipeId);
  if(!r){el.innerHTML='<div class="recipe-empty">Select a recipe to view details</div>';return;}
  const ingredients=(r.ingredients||[]).length?(r.ingredients||[]).map(x=>`<li>${escHtml(x)}</li>`).join(''):'<li>Ingredient detail needs cleanup from source file.</li>';
  const method=(r.method||[]).length?(r.method||[]).map(x=>`<li>${escHtml(x)}</li>`).join(''):'<li>Method not available in extracted sheet yet.</li>';
  const notes=(r.notes||[]).length?`<div style="grid-column:1/-1"><div class="recipe-section-title">Notes</div><ul>${r.notes.map(x=>`<li>${escHtml(x)}</li>`).join('')}</ul></div>`:'';
  el.innerHTML=`
    <div class="recipe-detail-head">
      <div class="recipe-detail-title">${escHtml(r.title)}</div>
      <div class="recipe-detail-meta">${escHtml(r.menu)} · ${escHtml(r.category)} · ${escHtml(r.station)} · ${recipeQualityLabel(r.quality)}</div>
    </div>
    <div class="recipe-detail-body">
      <div><div class="recipe-section-title">Ingredients</div><ul>${ingredients}</ul></div>
      <div><div class="recipe-section-title">Method</div><ol>${method}</ol></div>
      ${notes}
    </div>
    <div class="recipe-source">Source: ${escHtml(r.sourceFile)} · ${escHtml(r.relativePath)}</div>`;
}

// â”€â”€ REPORT VIEW â”€â”€
async function loadReport() {
  const date = document.getElementById('report-date').value;
  if (!date) return;
  const el = document.getElementById('report-content');
  el.innerHTML = '<div class="report-no-data">Loading...</div>';
  const { data: logs } = await sb.from('prep_status_log').select('*').eq('service_date', date).order('logged_at', {ascending: false});
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
  await saveStatus(stk,ssk,dn,item,newVal,prev);
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
  if(DEV_READ_ONLY)return;
  if(dish.id)await sb.from('dishes').update({station_key:toStKey,subsection_key:toSsKey}).eq('id',dish.id);
  const oldRows=Object.entries(savedState).map(([component,status])=>({
    service_date:TODAY,station_key:toStKey,subsection_key:toSsKey,dish_name:dish.name,component_name:component,status,updated_at:new Date().toISOString()
  }));
  if(oldRows.length)await sb.from('prep_status').upsert(oldRows,{onConflict:'service_date,station_key,subsection_key,dish_name,component_name'});
  await sb.from('prep_status').delete().eq('service_date',TODAY).eq('station_key',fromStKey).eq('subsection_key',fromSsKey).eq('dish_name',dish.name);
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
function deleteDish(stKey,ssKey,dishName,did){
  const st=STATIONS.find(s=>s.key===stKey);const ss=st.subsections.find(s=>s.key===ssKey);
  const di=ss.dishes.findIndex(d=>d.name===dishName);if(di===-1)return;
  const removed=ss.dishes.splice(di,1)[0];
  const savedState={};removed.items.forEach(item=>{const id=mkId(stKey,ssKey,dishName,item);savedState[item]=state[id]||'none';delete state[id];});
  undoStack={type:'dish',stKey,ssKey,dish:removed,idx:di,savedState};
  // Sync to Supabase so all screens reflect the removal
  if(!DEV_READ_ONLY && removed.id){
    sb.from('dishes').delete().eq('id',removed.id).then(()=>{});
  }
  showUndo(`"${dishName}" removed`);renderTabs();renderCounter();renderContent();
}

// â”€â”€ DELETE ITEM â”€â”€
function showItemConfirm(ikey,encId){document.getElementById(ikey).classList.add('visible');document.getElementById('sb-'+encId).style.display='none';document.getElementById('idb-'+encId).style.display='none';}
function cancelItemConfirm(ikey,encId){document.getElementById(ikey).classList.remove('visible');document.getElementById('sb-'+encId).style.display='';document.getElementById('idb-'+encId).style.display='';}
function deleteItem(id,stKey,ssKey,dishName,idx,ikey){
  const st=STATIONS.find(s=>s.key===stKey);const ss=st.subsections.find(s=>s.key===ssKey);const dish=ss.dishes.find(d=>d.name===dishName);
  if(!dish)return;const itemName=dish.items[idx];const savedStatus=state[id]||'none';delete state[id];
  const removedComp=dish.components?dish.components[idx]:null;
  dish.items.splice(idx,1);
  if(dish.components)dish.components.splice(idx,1);
  // Sync to Supabase so all screens reflect the removal
  if(!DEV_READ_ONLY && removedComp && removedComp.id){
    sb.from('dish_components').delete().eq('id',removedComp.id).then(()=>{});
  }
  if(dish.items.length===0){const di=ss.dishes.findIndex(d=>d.name===dishName);const rd=ss.dishes.splice(di,1)[0];undoStack={type:'dish',stKey,ssKey,dish:rd,idx:di,savedState:{}};
    if(!DEV_READ_ONLY && rd.id)sb.from('dishes').delete().eq('id',rd.id).then(()=>{});
  }
  else undoStack={type:'item',stKey,ssKey,dishName,itemName,idx,savedStatus};
  showUndo(`"${itemName}" removed`);renderTabs();renderCounter();renderContent();
}

// â”€â”€ UNDO â”€â”€
function showUndo(msg){
  if(undoTimer)clearTimeout(undoTimer);
  document.getElementById('undo-msg').textContent=msg;
  document.getElementById('undo-toast').classList.add('visible');
  undoTimer=setTimeout(()=>{document.getElementById('undo-toast').classList.remove('visible');undoStack=null;},6000);
}
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
  ['home-view','pass-view','report-view','dashboard-view','reports-view','order-view','recipes-view','check-view','scheduling-view','closing-view','team-view','content','legend-bar','sec-counter-wrap','add-section-wrap'].forEach(function(id){
    var el=document.getElementById(id);if(el)el.style.display='none';
  });
  document.getElementById('section-tabs').style.display='none';
  document.querySelector('.footer-bar').style.display='none';
}
function openHome(){
  activeStation=HOME_KEY;
  hideAllPages();
  document.getElementById('home-view').style.display='block';
  document.getElementById('foot-label').textContent='Kitchen App';
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
function openOrderInventory(){
  activeStation=ORDER_KEY;
  hideAllPages();
  document.getElementById('order-view').style.display='block';
  document.querySelector('.footer-bar').style.display='flex';
  document.getElementById('foot-label').textContent='Order Inventory';
  renderOrderInventory();
}
function openRecipes(){
  activeStation=RECIPES_KEY;
  hideAllPages();
  document.getElementById('recipes-view').style.display='block';
  document.querySelector('.footer-bar').style.display='flex';
  document.getElementById('foot-label').textContent='Recipes';
  renderRecipes();
}

// â”€â”€ SWITCH STATION â”€â”€
function switchStation(key){
  if(key===CHECK_KEY){openChecklist();return;}
  activeStation=key;activeFilter=null;
  const isPass=key===PASS_KEY;
  ['home-view','pass-view','report-view','dashboard-view','reports-view','order-view','recipes-view','check-view','scheduling-view','closing-view','team-view','content','legend-bar','sec-counter-wrap','add-section-wrap'].forEach(function(id){
    var el=document.getElementById(id);if(el)el.style.display='none';
  });
  document.getElementById('section-tabs').style.display='flex';
  document.querySelector('.footer-bar').style.display='flex';
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
  { key: 'pastry_pizza', label: 'Pastry & Pizza' },
  { key: 'stewarding',   label: 'Stewarding' },
];

const STATUS_META = {
  working: { label: '',    bg: 'working' },
  off:     { label: 'OFF', bg: 'off' },
  wo:      { label: 'WO',  bg: 'wo' },
  sl:      { label: 'SL',  bg: 'sl' },
  al:      { label: 'AL',  bg: 'al' },
  ph:      { label: 'PH',  bg: 'ph' },
  em:      { label: 'EM',  bg: 'em' },
  tr:      { label: 'TR',  bg: 'tr' },
  cat:     { label: 'CAT', bg: 'cat' },
};

let schedWeekStart   = null;
let schedRoster      = {};
let schedStaff       = [];
let schedView        = 'week';
let schedEditTarget  = null;
let schedRTChannel   = null;

// ── Edit lock ──
const SCHED_PIN = '2468'; // schedule edit passcode
const SCHED_LOCK_TIMEOUT_MS = 5 * 60 * 1000; // auto-relock after 5 min idle
let schedUnlocked      = false;
let schedLockTimer     = null;
let schedPendingAction = null;

// ── COSEC attendance (face recognition) ──
var schedAttendance = {};      // "emp_id|date" -> attendance row
var schedLastSyncInfo = '';
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
async function loadSchedData() {
  var weekEnd = formatDate(addDays(schedWeekStart, 13));
  var weekFrom = formatDate(addDays(schedWeekStart, -7));
  var res = await Promise.all([
    sb.from('staff').select('*').eq('active', true).order('sort_order'),
    sb.from('roster').select('*').gte('work_date', weekFrom).lte('work_date', weekEnd)
  ]);
  schedStaff = res[0].data || [];
  schedRoster = {};
  (res[1].data || []).forEach(function(r) {
    schedRoster[schedRosterKey(r.staff_id, r.work_date)] = r;
  });
}

// ── COSEC attendance loading & sync ──
async function loadAttendance() {
  var from = formatDate(addDays(schedWeekStart, -1));
  var to = formatDate(addDays(schedWeekStart, 8));
  var res = await sb.from('attendance').select('*').gte('att_date', from).lte('att_date', to).limit(2000);
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
    var effOut = a.last_out || a.manual_out || null;
    if (effOut) {
      return { kind: 'done', in: a.first_in, out: effOut,
               manual: !a.last_out && !!a.manual_out, hours: calcHours(a.first_in, effOut) };
    }
    if (isToday) return { kind: 'in', in: a.first_in };
    var pe = rrow ? formatTime(rrow.shift_end) : '';
    return { kind: 'open', in: a.first_in, plannedEnd: pe };
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
  a.manual_out = out; a.closed_at = new Date().toISOString();
  renderSchedView();
  sb.from('attendance').update({ manual_out: out, closed_by: 'manager', closed_at: a.closed_at })
    .eq('emp_id', staff.emp_id).eq('att_date', dateStr)
    .then(function(res){ if (res.error) console.error('Close shift error:', res.error); });
}

// Inline edit of COSEC employee ID. Lock-gated.
function schedEditEmpId(event, staffId) {
  event.stopPropagation();
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
      if (activeStation === SCHED_KEY) {
        if (schedView === 'week') renderSchedWeek();
        else renderSchedDay();
      }
    })
    .subscribe(function(status) {
      // Log realtime status for debugging
      console.log('Roster realtime:', status);
    });
}

// ── Open page ──
async function openScheduling() {
  activeStation = SCHED_KEY;
  hideAllPages();
  var el = document.getElementById('scheduling-view');
  el.style.display = 'flex';
  el.style.flexDirection = 'column';
  document.querySelector('.footer-bar').style.display = 'flex';
  document.getElementById('foot-label').textContent = 'Scheduling';
  if (!schedWeekStart) schedWeekStart = getMonday(new Date());
  schedUpdateLockBtn();
  await Promise.all([loadSchedData(), loadAttendance()]);
  subscribeSchedRealtime();
  renderSchedView();
  triggerCosecSync(false);
  if (!window.schedAttTimer) {
    window.schedAttTimer = setInterval(function() {
      if (activeStation === SCHED_KEY) triggerCosecSync(false);
    }, 5 * 60 * 1000);
  }
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
  var today = formatDate(new Date());
  var days = []; for (var i = 0; i < 7; i++) days.push(addDays(schedWeekStart, i));
  var dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  var html = '<table class="sch-grid"><thead><tr>';
  html += '<th class="sch-th-name">Name</th><th class="sch-th-role">Role</th>';
  for (var di = 0; di < days.length; di++) {
    var ds = formatDate(days[di]);
    html += '<th class="' + (ds === today ? 'sch-th-today' : '') + '">' + dayNames[di] +
      '<br><span style="font-size:10px;opacity:.8">' +
      days[di].toLocaleDateString('en-GB',{day:'numeric',month:'short'}) + '</span></th>';
  }
  html += '<th>Hrs</th><th>Days</th><th></th></tr></thead><tbody>';

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

        html += '<tr>';
        html += '<td class="sch-td-name" onclick="schedEditEmpId(event,\'' + sid + '\')" title="Tap to set employee ID" style="cursor:pointer">' +
          '<span class="sch-del-btn" onclick="schedConfirmDelete(event,\'' + sid + '\')" title="Remove">×</span>' +
          staff.name +
          (staff.emp_id ? '<span class="sch-emp-id">' + staff.emp_id + '</span>' : '') + '</td>';
        html += '<td class="sch-td-role" onclick="schedEditRole(event,\'' + sid + '\')" title="Click to edit" style="cursor:pointer">' +
          staff.designation + ' <span style="opacity:.3;font-size:10px">✎</span></td>';

        for (var dj = 0; dj < days.length; dj++) {
          var ds2 = formatDate(days[dj]);
          var rrow = schedRoster[schedRosterKey(sid, ds2)];
          var isTod = ds2 === today;
          html += '<td class="sch-cell' + (isTod ? ' sch-cell-today' : '') +
            '" onclick="schedOpenEdit(\'' + sid + '\',\'' + ds2 + '\')">';
          if (!rrow || rrow.status === 'working') {
            var ts = rrow ? formatTime(rrow.shift_start) : '';
            var te = rrow ? formatTime(rrow.shift_end) : '';
            var ts2 = rrow ? formatTime(rrow.shift_start2) : '';
            var te2 = rrow ? formatTime(rrow.shift_end2)   : '';
            var plannedH = calcHours(ts, te, ts2, te2);
            var att = schedAttState(staff, ds2);

            if (att.kind === 'done') {
              wHours += att.hours; wDays++;
              html += '<div class="sch-shift actual">' + att.in + '<br>' + att.out +
                (att.manual ? '<span class="sch-actual-tag">closed</span>' : '') + '</div>';
            } else if (att.kind === 'in') {
              wDays++;
              html += '<div class="sch-shift actual-live">' + att.in + '<br>' +
                '<span class="sch-actual-open">working</span></div>';
            } else if (att.kind === 'open') {
              wDays++;
              html += '<div class="sch-shift actual-open-flag" onclick="schedCloseShift(event,\'' + sid + '\',\'' + ds2 + '\')">' +
                att.in + '<br><span class="sch-actual-close">tap to close</span></div>';
            } else if (att.kind === 'absent') {
              wDays++;
              html += '<div class="sch-shift actual-absent">' +
                (ts && te ? ts + '<br>' + te : '') +
                '<span class="sch-actual-tag">no clock-in</span></div>';
            } else {
              if (ts && te) { wHours += plannedH; wDays++; }
              var splitLabel = (ts2 && te2) ? '<br><span style="opacity:.6;font-size:9px">' + ts2 + '–' + te2 + '</span>' : '';
              html += '<div class="sch-shift working">' +
                (ts && te ? ts + '<br>' + te + splitLabel : '<span style="color:#bbb;font-size:10px">+ add</span>') + '</div>';
            }
          } else {
            var meta = STATUS_META[rrow.status] || { label: rrow.status.toUpperCase(), bg: 'off' };
            if (rrow.status !== 'off') wDays++;
            html += '<div class="sch-shift ' + meta.bg + '">' + meta.label + '</div>';
          }
          html += '</td>';
        }

        html += '<td class="sch-td-hours">' + (wHours > 0 ? wHours + 'h' : '—') + '</td>';
        html += '<td class="sch-td-days">' + (wDays > 0 ? wDays : '—') + '</td>';

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
        html += '</tr>';
      }
    }

    // Add staff row at bottom of each station
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
  html += '<td>' + (grandTotal > 0 ? grandTotal + 'h' : '—') + '</td><td>—</td><td></td></tr></tfoot>';

  html += '</table>';
  document.getElementById('sch-grid-wrap').innerHTML = html;
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
    '<div style="margin-bottom:12px;font-size:13px;color:var(--vino-light)">' + total + ' staff in today' +
    ' \u00B7 <span style="color:#4a7c59;font-weight:600">' + clockedIn + ' clocked in</span>' +
    (schedLastSyncInfo ? ' \u00B7 <span style="opacity:.55;font-size:12px">' + schedLastSyncInfo + '</span>' : '') +
    '</div>' + sections;
}

// ── Edit modal ──
function schedOpenEdit(staffId, date) {
  if (!schedGuard(function(){ schedOpenEdit(staffId, date); })) return;
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

  schedStatusChange();
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
  document.getElementById('sch-modal').style.display = 'none';
  var key = schedRosterKey(staffId, date);
  var payload = Object.assign({}, schedRoster[key] || {}, {
    staff_id: staffId, work_date: date, status: status,
    shift_start:  status === 'working' ? (start||null)  : null,
    shift_end:    status === 'working' ? (end||null)    : null,
    shift_start2: status === 'working' ? (start2||null) : null,
    shift_end2:   status === 'working' ? (end2||null)   : null,
    notes: notes || null, updated_at: new Date().toISOString()
  });
  schedRoster[key] = payload;
  renderSchedWeek();
  if (!DEV_READ_ONLY) {
    var res = await sb.from('roster').upsert(payload, { onConflict: 'staff_id,work_date' });
    if (res.error) console.error('Save error:', res.error);
  }
  schedEditTarget = null;
}

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
  if (!DEV_READ_ONLY) {
    var res = await sb.from('staff').update({ station_key: targetStation }).eq('id', staffId);
    if (res.error) {
      console.error('Move error:', res.error);
      // revert on error
      loadSchedData().then(renderSchedWeek);
    }
  }
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
  if (!DEV_READ_ONLY) {
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
  if (!DEV_READ_ONLY) {
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
          var h = calcHours(ts, te);
          if (ts && te) { wh += h; wd++; }
          html += '<td' + (isToday ? ' class="pt-today"' : '') + '>' + (ts && te ? ts + '–' + te : '') + '</td>';
        } else {
          var meta = STATUS_META[row.status] || { label: row.status.toUpperCase() };
          if (row.status !== 'off') wd++;
          html += '<td class="pt-off pt-leave">' + meta.label + '</td>';
        }
      });
      html += '<td><strong>' + (wh > 0 ? wh + 'h' : '—') + '</strong></td><td>' + (wd||'—') + '</td></tr>';
    });
  });
  html += '</tbody></table>';
  var printDoc = '<!doctype html><html><head><title>Robertos Kitchen Roster</title>' +
    '<style>' +
    '@page{size:A4 landscape;margin:8mm}' +
    'body{font-family:Arial,sans-serif;color:#2a1a10;margin:0}' +
    '.sch-print-header{margin-bottom:8px}' +
    '.sch-print-header h2{font-size:13px;margin:0 0 2px;color:#410207}' +
    '.sch-print-header p{font-size:9px;color:#666;margin:0}' +
    '.sch-print-table{width:100%;border-collapse:collapse;font-size:9px}' +
    '.sch-print-table th{background:#410207;color:#fff;padding:5px 4px;text-align:center;border:1px solid #999;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
    '.sch-print-table th.pt-name{text-align:left;padding-left:6px;min-width:130px}' +
    '.sch-print-table td{padding:4px 4px;border:1px solid #ccc;text-align:center;font-size:9px}' +
    '.sch-print-table td.pt-name{text-align:left;padding-left:6px;font-weight:600}' +
    '.sch-print-table td.pt-role{text-align:left;font-size:8px;color:#666}' +
    '.sch-print-table tr.pt-station td{background:#f5f5f5;font-weight:700;font-size:8px;letter-spacing:1px;text-transform:uppercase;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
    '.sch-print-table td.pt-today{background:#e8f5e9;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
    '.sch-print-table td.pt-off{color:#999}' +
    '.sch-print-table td.pt-leave{background:#fff9c4;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
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

// ── Send to HR (email-ready roster, no manual attachment) ──
async function schedSendToHR() {
  var btn = document.getElementById('svt-hr');
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
        rowData.push(wHours > 0 ? wHours + 'h' : '');
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

    // Generate as base64
    var xlsxBuffer = await workbook.xlsx.writeBuffer();
    var xlsxBase64 = btoa(String.fromCharCode.apply(null, new Uint8Array(xlsxBuffer)));

    var fileName = 'Roster_' + formatDate(days[0]) + '_to_' + formatDate(days[6]) + '.xlsx';

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
        xlsxBase64: xlsxBase64
      })
    });

    var emailData = await emailRes.json();
    if (!emailRes.ok) throw new Error(emailData.message || 'Email failed: ' + emailRes.status);

    if (btn) {
      btn.textContent = '✓ Sent to HR';
      btn.style.background = 'var(--oliva)'; btn.style.borderColor = 'var(--oliva)';
      setTimeout(function(){ btn.textContent = '📧 Send to HR'; btn.style.background=''; btn.style.borderColor=''; btn.disabled=false; }, 3000);
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
