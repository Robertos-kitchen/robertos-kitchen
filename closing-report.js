// ══════════════════════════════════════════════════════
// CLOSING REPORT MODULE
// Daily kitchen closing report — structured, tap-first.
// Saves to Supabase (closing_reports + closing_report_entries)
// and emails Francesco on submit via edge function.
// ══════════════════════════════════════════════════════

const CLOSING_KEY = 'closing_report';

const CR_CATEGORIES = {
  complaint: ['Taste / Seasoning','Temperature','Slow service','Wrong order','Portion','Quality','Other'],
  operation: ['POS / Punching','Staffing / Runners','Equipment','Supply / Delivery','Timing / Pass','FOH–BOH coordination','Other'],
  team:      ['Attendance','HR matter','Conflict','Performance','Wellbeing','Other'],
  unavailable: ['Ran out during service','Supplier issue','Quality rejected','Prep shortfall','Other']
};
const CR_TYPE_META = {
  complaint:   { label: 'Complaints',        icon: '⚠️', empty: 'No complaints tonight', hasItem: true,  itemLabel: 'Dish',  hasAction: true },
  operation:   { label: 'Operation issues',  icon: '🔧', empty: 'No operation issues',   hasItem: false, itemLabel: '',      hasAction: true },
  team:        { label: 'Team issues',       icon: '👥', empty: 'No team issues',        hasItem: false, itemLabel: '',      hasAction: true },
  unavailable: { label: '86 / Not available',icon: '🚫', empty: 'Everything available',  hasItem: true,  itemLabel: 'Item',  hasAction: false }
};

let crEntries = [];        // {id|null, entry_type, category, item_name, detail, action_taken}
let crRemovedIds = [];     // db ids the user explicitly removed (deleted on submit)
let crReportId = null;     // existing report id for today (if already submitted)
let crChefsOn = [];        // selected names
let crChefsOff = [];
let crSeniorPool = [];     // [{name, designation, scheduledWorking:bool}]
let crRating = 0;
let crTab = 'tonight';
let crLoaded = false;
let crAddOpenType = null;

const CR_DRAFT_KEY = 'robertos-closing-draft-';

// ── Styles (self-contained) ──
(function(){
  var css = ''
  + '.cr-wrap{max-width:760px;margin:0 auto;padding:18px 16px 110px}'
  + '.cr-tabs{display:flex;gap:8px;margin-bottom:16px}'
  + '.cr-tab{flex:1;padding:10px;border:1px solid var(--sabbia-dark);background:var(--cream);border-radius:10px;font-family:var(--font-sans);font-size:13px;font-weight:600;color:var(--vino);cursor:pointer}'
  + '.cr-tab.active{background:var(--vino);color:#fff;border-color:var(--vino)}'
  + '.cr-card{background:var(--cream);border:1px solid var(--sabbia-dark);border-radius:12px;padding:14px;margin-bottom:14px}'
  + '.cr-card-title{font-family:var(--font-serif);font-size:17px;color:var(--vino);font-weight:700;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center}'
  + '.cr-sub{font-size:11px;color:var(--vino-light);opacity:.8;font-weight:400;font-family:var(--font-sans)}'
  + '.cr-chips{display:flex;flex-wrap:wrap;gap:8px}'
  + '.cr-chip{padding:8px 14px;border-radius:18px;border:1px solid var(--sabbia-dark);background:#fff;font-size:13px;color:var(--ink);cursor:pointer;user-select:none}'
  + '.cr-chip.on{background:var(--oliva);border-color:var(--oliva);color:#fff;font-weight:600}'
  + '.cr-chip.dim{opacity:.55}'
  + '.cr-rating{display:flex;gap:10px;justify-content:space-between}'
  + '.cr-rate-btn{flex:1;padding:10px 0;font-size:22px;border-radius:10px;border:1px solid var(--sabbia-dark);background:#fff;cursor:pointer;filter:grayscale(1);opacity:.6}'
  + '.cr-rate-btn.sel{filter:none;opacity:1;background:#fff;border-color:var(--oliva);box-shadow:0 0 0 2px var(--oliva)}'
  + '.cr-field-label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--vino-light);margin:10px 0 4px;font-weight:600}'
  + '.cr-input,.cr-select,.cr-textarea{width:100%;padding:10px;border:1px solid var(--sabbia-dark);border-radius:8px;font-family:var(--font-sans);font-size:14px;background:#fff;color:var(--ink);box-sizing:border-box}'
  + '.cr-textarea{min-height:70px;resize:vertical}'
  + '.cr-empty{font-size:13px;color:var(--oliva);font-weight:600;padding:4px 0}'
  + '.cr-entry{background:#fff;border:1px solid var(--sabbia-dark);border-radius:10px;padding:10px 12px;margin-bottom:8px;position:relative}'
  + '.cr-entry-cat{display:inline-block;font-size:11px;font-weight:700;color:#fff;background:var(--vino-light);border-radius:10px;padding:2px 10px;margin-right:6px}'
  + '.cr-entry-item{font-size:12px;font-weight:700;color:var(--vino)}'
  + '.cr-entry-detail{font-size:13px;color:var(--ink);margin-top:4px}'
  + '.cr-entry-action{font-size:12px;color:var(--oliva);margin-top:3px}'
  + '.cr-entry-del{position:absolute;top:8px;right:10px;color:var(--pomodoro);font-size:16px;cursor:pointer;background:none;border:none;padding:0 4px}'
  + '.cr-add-btn{width:100%;padding:9px;border:1px dashed var(--vino-light);background:transparent;border-radius:10px;color:var(--vino);font-size:13px;font-weight:600;cursor:pointer;margin-top:6px}'
  + '.cr-add-panel{background:#fff;border:1px solid var(--sabbia-dark);border-radius:10px;padding:12px;margin-top:8px}'
  + '.cr-cat-row{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}'
  + '.cr-cat-chip{padding:6px 12px;border-radius:14px;border:1px solid var(--sabbia-dark);background:var(--sabbia-light);font-size:12px;cursor:pointer}'
  + '.cr-cat-chip.sel{background:var(--vino);color:#fff;border-color:var(--vino);font-weight:600}'
  + '.cr-panel-btns{display:flex;gap:8px;margin-top:10px}'
  + '.cr-save-entry{flex:1;padding:9px;background:var(--oliva);color:#fff;border:none;border-radius:8px;font-weight:600;font-size:13px;cursor:pointer}'
  + '.cr-cancel-entry{padding:9px 16px;background:transparent;border:1px solid var(--sabbia-dark);border-radius:8px;font-size:13px;cursor:pointer;color:var(--ink)}'
  + '.cr-submit{position:fixed;bottom:60px;left:0;right:0;padding:0 16px;z-index:50}'
  + '.cr-submit-inner{max-width:760px;margin:0 auto}'
  + '.cr-submit-btn{width:100%;padding:15px;background:var(--vino);color:#fff;border:none;border-radius:12px;font-size:16px;font-weight:700;font-family:var(--font-sans);cursor:pointer;box-shadow:0 4px 14px rgba(65,2,7,.35)}'
  + '.cr-submit-btn:disabled{opacity:.6}'
  + '.cr-saved-banner{background:var(--oliva);color:#fff;border-radius:10px;padding:10px 14px;font-size:13px;font-weight:600;margin-bottom:14px}'
  + '.cr-hist-row{background:var(--cream);border:1px solid var(--sabbia-dark);border-radius:10px;padding:12px;margin-bottom:8px;cursor:pointer}'
  + '.cr-hist-date{font-weight:700;color:var(--vino);font-size:14px}'
  + '.cr-hist-meta{font-size:12px;color:var(--ink);opacity:.8;margin-top:3px}'
  + '.cr-agg-bar{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:12px}'
  + '.cr-agg-label{width:150px;flex-shrink:0;color:var(--ink)}'
  + '.cr-agg-fill{height:14px;background:var(--vino-light);border-radius:7px;min-width:6px}'
  + '.cr-agg-n{font-weight:700;color:var(--vino)}'
  + '.cr-two-col{display:grid;grid-template-columns:1fr 1fr;gap:10px}'
  + '@media(max-width:520px){.cr-two-col{grid-template-columns:1fr}}';
  var s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
})();

// ── Open module ──
async function openClosingReport() {
  activeStation = CLOSING_KEY;
  hideAllPages();
  var el = document.getElementById('closing-view');
  el.style.display = 'block';
  document.querySelector('.footer-bar').style.display = 'flex';
  document.getElementById('foot-label').textContent = 'Closing Report';
  el.innerHTML = '<div class="cr-wrap"><div style="text-align:center;padding:40px;color:var(--vino)">Loading…</div></div>';
  crTab = 'tonight';
  await crLoadToday();
  crRender();
}

// ── Load today's data: schedule + existing report ──
let crCovers = null; // actual covers served (SevenRooms COMPLETE bookings), fetched on load

async function crFetchCovers(sd) {
  try {
    var r = await fetch(SUPABASE_URL + '/functions/v1/sevenrooms-sync?covers_actual=' + sd, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'x-proxy-secret': 'Kitchen'
      }
    });
    var d = await r.json();
    if (r.ok && d.ok && typeof d.covers === 'number') return d.covers;
  } catch(e) { console.warn('[closing] covers fetch failed', e); }
  return null;
}

async function crLoadToday() {
  var sd = getServiceDate();
  try {
    // Pull actual covers served for the service date (non-blocking if it fails)
    crCovers = await crFetchCovers(sd);
    var res = await Promise.all([
      sb.from('staff').select('*').eq('active', true).order('sort_order'),
      sb.from('roster').select('*').eq('work_date', sd),
      sb.from('closing_reports').select('*').eq('service_date', sd),
      sb.from('closing_report_entries').select('*').eq('service_date', sd).order('created_at')
    ]);
    var staff = res[0].data || [];
    var roster = {};
    (res[1].data || []).forEach(function(r){ roster[r.staff_id] = r; });

    // Senior chefs from designation; fallback to full staff list if none match
    var seniorRe = /(exec|sous|head|senior|chef de cuisine|cdc)/i;
    var seniors = staff.filter(function(s){ return seniorRe.test(s.designation || ''); });
    if (!seniors.length) seniors = staff;
    crSeniorPool = seniors.map(function(s){
      var r = roster[s.id];
      var working = !r || r.status === 'working';
      return { name: s.name, designation: s.designation || '', scheduledWorking: working };
    });

    var report = (res[2].data || [])[0] || null;
    var entries = res[3].data || [];

    if (report) {
      // Existing report: load it for editing
      crReportId = report.id;
      crChefsOn = report.chefs_on_duty || [];
      crChefsOff = report.chefs_off_duty || [];
      crRating = report.day_rating || 0;
      crEntries = entries.map(function(e){ return { id: e.id, entry_type: e.entry_type, category: e.category, item_name: e.item_name, detail: e.detail, action_taken: e.action_taken }; });
      crDraft = {
        revenue: report.revenue_aed != null ? String(report.revenue_aed) : '',
        briefing_foh: report.briefing_foh || '',
        briefing_boh: report.briefing_boh || '',
        feedback: report.general_feedback || '',
        submitted_by: report.submitted_by || ''
      };
    } else {
      crReportId = null;
      crEntries = [];
      // Pre-fill chefs from schedule
      crChefsOn = crSeniorPool.filter(function(s){ return s.scheduledWorking; }).map(function(s){ return s.name; });
      crChefsOff = crSeniorPool.filter(function(s){ return !s.scheduledWorking; }).map(function(s){ return s.name; });
      crRating = 0;
      // Restore local draft if one exists for today
      var draft = null;
      try { draft = JSON.parse(localStorage.getItem(CR_DRAFT_KEY + sd) || 'null'); } catch(e){}
      if (draft) {
        crDraft = draft.fields || crEmptyDraft();
        crEntries = draft.entries || [];
        if (draft.chefsOn) crChefsOn = draft.chefsOn;
        if (draft.chefsOff) crChefsOff = draft.chefsOff;
        if (draft.rating) crRating = draft.rating;
      } else {
        crDraft = crEmptyDraft();
      }
    }
    crRemovedIds = [];
    crLoaded = true;
  } catch (err) {
    console.error('[closing] load error', err);
    crLoaded = false;
  }
}

let crDraft = null;
function crEmptyDraft(){ return { revenue:'', briefing_foh:'', briefing_boh:'', feedback:'', submitted_by:'' }; }

function crSaveDraftLocal(){
  if (crReportId) return; // once submitted, Supabase is the source of truth
  var sd = getServiceDate();
  crCollectFields();
  try { localStorage.setItem(CR_DRAFT_KEY + sd, JSON.stringify({ fields: crDraft, entries: crEntries, chefsOn: crChefsOn, chefsOff: crChefsOff, rating: crRating })); } catch(e){}
}
function crCollectFields(){
  ['revenue','briefing_foh','briefing_boh','feedback','submitted_by'].forEach(function(f){
    var el = document.getElementById('cr-f-' + f);
    if (el) crDraft[f] = el.value;
  });
}

// ── Render ──
function crRender() {
  var el = document.getElementById('closing-view');
  if (!crLoaded) {
    el.innerHTML = '<div class="cr-wrap"><div class="cr-card">Could not load data. Check connection and reopen.</div></div>';
    return;
  }
  var html = '<div class="cr-wrap">';
  html += '<div class="cr-tabs">'
    + '<button class="cr-tab' + (crTab==='tonight'?' active':'') + '" onclick="crSetTab(\'tonight\')">Tonight</button>'
    + '<button class="cr-tab' + (crTab==='history'?' active':'') + '" onclick="crSetTab(\'history\')">History & Trends</button>'
    + '</div>';
  html += crTab === 'tonight' ? crRenderTonight() : '<div id="cr-history">Loading…</div>';
  html += '</div>';
  if (crTab === 'tonight') {
    html += '<div class="cr-submit"><div class="cr-submit-inner"><button class="cr-submit-btn" id="cr-submit-btn" onclick="crSubmit()">' + (crReportId ? 'Update report' : 'Submit closing report') + ' → Francesco</button></div></div>';
  }
  el.innerHTML = html;
  if (crTab === 'history') crLoadHistory();
}

function crSetTab(t){ crCollectIfTonight(); crTab = t; crRender(); }
function crCollectIfTonight(){ if (crTab === 'tonight') { crCollectFields(); crSaveDraftLocal(); } }

function crRenderTonight() {
  var sd = getServiceDate();
  var dLabel = new Date(sd + 'T12:00:00').toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  var html = '';

  if (crReportId) html += '<div class="cr-saved-banner">✓ Report for tonight already submitted — you are editing it.</div>';

  // Date header
  html += '<div class="cr-card"><div class="cr-card-title">' + dLabel + '<span class="cr-sub">Service date ' + sd + '</span></div>';

  // Chefs on duty (from schedule)
  html += '<div class="cr-field-label">Senior chefs on duty <span style="text-transform:none;font-weight:400">(from schedule — tap to correct)</span></div>';
  html += '<div class="cr-chips">';
  crSeniorPool.forEach(function(s){
    var on = crChefsOn.indexOf(s.name) >= 0;
    html += '<span class="cr-chip' + (on?' on':' dim') + '" onclick="crToggleChef(\'' + s.name.replace(/'/g,"\\'") + '\')">' + s.name + (s.designation ? ' <span style="font-size:10px;opacity:.7">' + s.designation + '</span>' : '') + '</span>';
  });
  html += '</div>';

  // Rating
  html += '<div class="cr-field-label" style="margin-top:14px">How was service tonight?</div>';
  html += '<div class="cr-rating">';
  var faces = ['😖','😕','😐','🙂','🔥'];
  for (var i = 1; i <= 5; i++) {
    html += '<button class="cr-rate-btn' + (crRating===i?' sel':'') + '" onclick="crSetRating(' + i + ')">' + faces[i-1] + '</button>';
  }
  html += '</div>';

  // Revenue + Covers + Report by
  var coversDisplay = (crCovers != null)
    ? crCovers + ' <span style="font-size:11px;font-weight:400;color:#4b5128">covers</span>'
    : '<span style="font-size:13px;font-weight:400;color:#7a1218">syncing…</span>';
  html += '<div class="cr-two-col"><div><div class="cr-field-label">Revenue (AED)</div>'
    + '<input class="cr-input" id="cr-f-revenue" type="number" inputmode="numeric" placeholder="e.g. 60000" value="' + crEsc(crDraft.revenue) + '" onchange="crSaveDraftLocal()"></div>'
    + '<div><div class="cr-field-label">Covers served <span style="text-transform:none;font-weight:400">(SevenRooms)</span></div>'
    + '<div class="cr-input" style="background:#ede5d8;display:flex;align-items:center;font-family:Georgia,serif;font-size:20px;color:#410207">' + coversDisplay + '</div></div></div>';
  html += '<div class="cr-two-col" style="margin-top:10px"><div><div class="cr-field-label">Report by</div>'
    + '<input class="cr-input" id="cr-f-submitted_by" type="text" placeholder="Your name" value="' + crEsc(crDraft.submitted_by) + '" onchange="crSaveDraftLocal()"></div><div></div></div>';
  html += '</div>';

  // Entry sections
  ['complaint','unavailable','operation','team'].forEach(function(type){
    html += crRenderEntrySection(type);
  });

  // Briefings
  html += '<div class="cr-card"><div class="cr-card-title">Briefing <span class="cr-sub">optional</span></div>'
    + '<div class="cr-two-col">'
    + '<div><div class="cr-field-label">FOH</div><input class="cr-input" id="cr-f-briefing_foh" type="text" placeholder="e.g. Business lunch of the week" value="' + crEsc(crDraft.briefing_foh) + '" onchange="crSaveDraftLocal()"></div>'
    + '<div><div class="cr-field-label">BOH</div><input class="cr-input" id="cr-f-briefing_boh" type="text" placeholder="e.g. New activation brief" value="' + crEsc(crDraft.briefing_boh) + '" onchange="crSaveDraftLocal()"></div>'
    + '</div></div>';

  // General feedback
  html += '<div class="cr-card"><div class="cr-card-title">General feedback <span class="cr-sub">how the day went — optional</span></div>'
    + '<textarea class="cr-textarea" id="cr-f-feedback" placeholder="Lunch, aperitivo, dinner, late night…" onchange="crSaveDraftLocal()">' + crEsc(crDraft.feedback) + '</textarea></div>';

  return html;
}

function crRenderEntrySection(type) {
  var meta = CR_TYPE_META[type];
  var entries = crEntries.filter(function(e){ return e.entry_type === type; });
  var html = '<div class="cr-card"><div class="cr-card-title">' + meta.icon + ' ' + meta.label + '</div>';
  if (!entries.length) html += '<div class="cr-empty">✓ ' + meta.empty + '</div>';
  entries.forEach(function(e){
    var idx = crEntries.indexOf(e);
    html += '<div class="cr-entry">'
      + '<button class="cr-entry-del" onclick="crRemoveEntry(' + idx + ')">✕</button>'
      + '<span class="cr-entry-cat">' + crEsc(e.category || '') + '</span>'
      + (e.item_name ? '<span class="cr-entry-item">' + crEsc(e.item_name) + '</span>' : '')
      + (e.detail ? '<div class="cr-entry-detail">' + crEsc(e.detail) + '</div>' : '')
      + (e.action_taken ? '<div class="cr-entry-action">Action: ' + crEsc(e.action_taken) + '</div>' : '')
      + '</div>';
  });
  if (crAddOpenType === type) {
    html += crRenderAddPanel(type);
  } else {
    html += '<button class="cr-add-btn" onclick="crOpenAdd(\'' + type + '\')">+ Add</button>';
  }
  html += '</div>';
  return html;
}

function crRenderAddPanel(type) {
  var meta = CR_TYPE_META[type];
  var cats = CR_CATEGORIES[type];
  var html = '<div class="cr-add-panel">';
  html += '<div class="cr-field-label" style="margin-top:0">' + (type==='unavailable'?'Reason':'Category') + '</div><div class="cr-cat-row" id="cr-cat-row">';
  cats.forEach(function(c, i){
    html += '<span class="cr-cat-chip' + (i===0?' sel':'') + '" data-cat="' + crEsc(c) + '" onclick="crPickCat(this)">' + c + '</span>';
  });
  html += '</div>';
  if (meta.hasItem) {
    html += '<div class="cr-field-label">' + meta.itemLabel + '</div>'
      + '<input class="cr-input" id="cr-add-item" list="cr-dish-list" placeholder="Start typing…">'
      + '<datalist id="cr-dish-list">' + crDishOptions() + '</datalist>';
  }
  html += '<div class="cr-field-label">Detail' + (type==='unavailable'?' (optional)':'') + '</div>'
    + '<input class="cr-input" id="cr-add-detail" type="text" placeholder="One line is enough">';
  if (meta.hasAction) {
    html += '<div class="cr-field-label">Action taken (optional)</div>'
      + '<input class="cr-input" id="cr-add-action" type="text" placeholder="What was done about it">';
  }
  html += '<div class="cr-panel-btns">'
    + '<button class="cr-save-entry" onclick="crSaveEntry(\'' + type + '\')">Add</button>'
    + '<button class="cr-cancel-entry" onclick="crCancelAdd()">Cancel</button>'
    + '</div></div>';
  return html;
}

function crDishOptions() {
  var names = [];
  try {
    (STATIONS || []).forEach(function(st){ (st.subsections||[]).forEach(function(ss){ (ss.dishes||[]).forEach(function(d){ if (names.indexOf(d.name) < 0) names.push(d.name); }); }); });
  } catch(e){}
  names.sort();
  return names.map(function(n){ return '<option value="' + crEsc(n) + '">'; }).join('');
}

// ── Interactions ──
function crToggleChef(name) {
  crCollectFields();
  var i = crChefsOn.indexOf(name);
  if (i >= 0) { crChefsOn.splice(i, 1); if (crChefsOff.indexOf(name) < 0) crChefsOff.push(name); }
  else { crChefsOn.push(name); var j = crChefsOff.indexOf(name); if (j >= 0) crChefsOff.splice(j, 1); }
  crSaveDraftLocal(); crRender();
}
function crSetRating(n) { crCollectFields(); crRating = n; crSaveDraftLocal(); crRender(); }
function crOpenAdd(type) { crCollectFields(); crAddOpenType = type; crRender(); var d = document.getElementById('cr-add-detail'); if (d) d.focus(); }
function crCancelAdd() { crAddOpenType = null; crRender(); }
function crPickCat(el) {
  document.querySelectorAll('#cr-cat-row .cr-cat-chip').forEach(function(c){ c.classList.remove('sel'); });
  el.classList.add('sel');
}
function crSaveEntry(type) {
  var catEl = document.querySelector('#cr-cat-row .cr-cat-chip.sel');
  var itemEl = document.getElementById('cr-add-item');
  var detailEl = document.getElementById('cr-add-detail');
  var actionEl = document.getElementById('cr-add-action');
  var meta = CR_TYPE_META[type];
  var item = itemEl ? itemEl.value.trim() : '';
  var detail = detailEl ? detailEl.value.trim() : '';
  if (meta.hasItem && !item && !detail) { alert('Add at least the ' + meta.itemLabel.toLowerCase() + ' or a short detail.'); return; }
  if (!meta.hasItem && !detail) { alert('Add a short detail.'); return; }
  crEntries.push({
    id: null,
    entry_type: type,
    category: catEl ? catEl.getAttribute('data-cat') : '',
    item_name: item || null,
    detail: detail || null,
    action_taken: actionEl && actionEl.value.trim() ? actionEl.value.trim() : null
  });
  crAddOpenType = null;
  crSaveDraftLocal();
  crRender();
}
function crRemoveEntry(idx) {
  var e = crEntries[idx];
  if (!e) return;
  var what = e.item_name || e.category || 'this entry';
  if (!confirm('Remove "' + what + '"? It will be deleted when you submit.')) return;
  if (e.id) crRemovedIds.push(e.id);
  crEntries.splice(idx, 1);
  crSaveDraftLocal();
  crRender();
}

// ── Submit ──
async function crFetchChecklistCounts(sd) {
  try {
    var res = await sb.from('chef_checks').select('status').eq('service_date', sd);
    if (res.error) throw res.error;
    var rows = res.data || [];
    var done = rows.filter(function(r){ return r.status && r.status !== 'none'; }).length;
    var attention = rows.filter(function(r){ return r.status === 'discard'; }).length;
    return { done: done, attention: attention };
  } catch(e) {
    console.warn('[closing] checklist count failed', e);
    return { done: 0, attention: 0 };
  }
}

async function crSubmit() {
  crCollectFields();
  var btn = document.getElementById('cr-submit-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  var sd = getServiceDate();
  var crChecks = await crFetchChecklistCounts(sd);
  try {
    var row = {
      service_date: sd,
      chefs_on_duty: crChefsOn,
      chefs_off_duty: crChefsOff,
      day_rating: crRating || null,
      revenue_aed: crDraft.revenue !== '' ? parseFloat(crDraft.revenue) : null,
      covers_actual: (crCovers != null) ? crCovers : null,
      briefing_foh: crDraft.briefing_foh || null,
      briefing_boh: crDraft.briefing_boh || null,
      general_feedback: crDraft.feedback || null,
      submitted_by: crDraft.submitted_by || null,
      checks_done: crChecks.done,
      checks_attention: crChecks.attention,
      updated_at: new Date().toISOString()
    };
    var res = await sb.from('closing_reports').upsert(row, { onConflict: 'service_date' }).select().single();
    if (res.error) throw res.error;
    crReportId = res.data.id;

    // Insert new entries one-by-one so each returned id maps back to the exact
    // entry it belongs to. A bulk insert's returned rows are NOT guaranteed to
    // come back in input order, which previously attached ids to the wrong line
    // item (so a later edit/delete could hit a different dish).
    var newOnes = crEntries.filter(function(e){ return !e.id; });
    for (var i = 0; i < newOnes.length; i++) {
      var ne = newOnes[i];
      var insRow = { service_date: sd, entry_type: ne.entry_type, category: ne.category, item_name: ne.item_name, detail: ne.detail, action_taken: ne.action_taken };
      var ins = await sb.from('closing_report_entries').insert(insRow).select().single();
      if (ins.error) throw ins.error;
      ne.id = ins.data.id;   // same object reference as in crEntries → updates it in place
    }
    if (crRemovedIds.length) {
      await sb.from('closing_report_entries').delete().in('id', crRemovedIds);
      crRemovedIds = [];
    }

    try { localStorage.removeItem(CR_DRAFT_KEY + sd); } catch(e){}

    // Email Francesco (best effort)
    btn.textContent = 'Sending email…';
    var emailOk = false;
    try {
      var er = await fetch(SUPABASE_URL + '/functions/v1/send-closing-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_KEY },
        body: JSON.stringify({ subject: 'Closing Report — ' + new Date(sd + 'T12:00:00').toLocaleDateString('en-GB', {weekday:'long', day:'numeric', month:'long', year:'numeric'}), html: crBuildEmailHtml(sd, crChecks) })
      });
      emailOk = er.ok;
    } catch(e) { console.warn('[closing] email failed', e); }

    btn.textContent = emailOk ? '✓ Saved & emailed to Francesco' : '✓ Saved (email not sent)';
    btn.style.background = 'var(--oliva)';
    setTimeout(function(){ crRender(); }, 2500);
  } catch (err) {
    console.error('[closing] submit error', err);
    alert('Could not save: ' + (err.message || err));
    btn.disabled = false; btn.textContent = crReportId ? 'Update report → Francesco' : 'Submit closing report → Francesco';
  }
}

function crBuildEmailHtml(sd, checks) {
  checks = checks || { done: 0, attention: 0 };
  var chkBelow = checks.done < 10;
  var chkFlag = chkBelow ? ' ⚠️ below 10 minimum' : ' ✅';
  var chkAtt = checks.attention === 1 ? '1 needs attention' : checks.attention + ' need attention';
  var chkLine = checks.done + ' checked · ' + chkAtt + chkFlag;
  var dLabel = new Date(sd + 'T12:00:00').toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  var faces = ['😖','😕','😐','🙂','🔥'];
  function section(title, inner){ return '<h3 style="font-family:Georgia,serif;color:#410207;margin:18px 0 6px;font-size:16px">' + title + '</h3>' + inner; }
  function entryHtml(type){
    var meta = CR_TYPE_META[type];
    var list = crEntries.filter(function(e){ return e.entry_type === type; });
    if (!list.length) return '<p style="margin:2px 0;color:#4b5128;font-size:14px">✓ ' + meta.empty + '</p>';
    return list.map(function(e){
      return '<p style="margin:4px 0;font-size:14px;color:#2a1a10"><strong>[' + (e.category||'') + ']</strong> '
        + (e.item_name ? '<em>' + e.item_name + '</em> — ' : '')
        + (e.detail || '')
        + (e.action_taken ? '<br><span style="color:#4b5128;font-size:13px">Action: ' + e.action_taken + '</span>' : '')
        + '</p>';
    }).join('');
  }
  var html = '<div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;background:#f5ede0;padding:24px;border-radius:12px">'
    + '<h2 style="font-family:Georgia,serif;color:#410207;margin:0 0 2px">Roberto\'s Kitchen — Closing Report</h2>'
    + '<p style="margin:0 0 14px;color:#7a1218;font-size:14px">' + dLabel + '</p>'
    + '<table style="width:100%;font-size:14px;color:#2a1a10;border-collapse:collapse">'
    + '<tr><td style="padding:3px 0;width:170px;color:#7a1218"><strong>Service rating</strong></td><td>' + (crRating ? faces[crRating-1] + ' (' + crRating + '/5)' : '—') + '</td></tr>'
    + '<tr><td style="padding:3px 0;color:#7a1218"><strong>Revenue</strong></td><td>' + (crDraft.revenue ? 'AED ' + Number(crDraft.revenue).toLocaleString() : '—') + '</td></tr>'
    + '<tr><td style="padding:3px 0;color:#7a1218"><strong>Covers served</strong></td><td>' + (crCovers != null ? crCovers + ' <span style="color:#4b5128;font-size:12px">(SevenRooms)</span>' : '—') + '</td></tr>'
    + '<tr><td style="padding:3px 0;color:#7a1218"><strong>Chefs on duty</strong></td><td>' + (crChefsOn.join(', ') || '—') + '</td></tr>'
    + '<tr><td style="padding:3px 0;color:#7a1218"><strong>Not on duty</strong></td><td>' + (crChefsOff.join(', ') || '—') + '</td></tr>'
    + '<tr><td style="padding:3px 0;color:#7a1218"><strong>Report by</strong></td><td>' + (crDraft.submitted_by || '—') + '</td></tr>'
    + '<tr><td style="padding:3px 0;color:#7a1218"><strong>Checklist</strong></td><td' + (chkBelow ? ' style="color:#b00"' : '') + '>' + chkLine + '</td></tr>'
    + '</table>'
    + section('⚠️ Complaints', entryHtml('complaint'))
    + section('🚫 86 / Not available', entryHtml('unavailable'))
    + section('🔧 Operation issues', entryHtml('operation'))
    + section('👥 Team issues', entryHtml('team'))
    + (crDraft.briefing_foh || crDraft.briefing_boh ? section('Briefing', '<p style="margin:2px 0;font-size:14px">FOH: ' + (crDraft.briefing_foh||'—') + '<br>BOH: ' + (crDraft.briefing_boh||'—') + '</p>') : '')
    + (crDraft.feedback ? section('General feedback', '<p style="margin:2px 0;font-size:14px;white-space:pre-wrap">' + crDraft.feedback + '</p>') : '')
    + '<p style="margin-top:20px;font-size:11px;color:#999">Sent automatically from Roberto\'s Kitchen App</p>'
    + '</div>';
  return html;
}

// ── History & Trends ──
async function crLoadHistory() {
  var el = document.getElementById('cr-history');
  if (!el) return;
  try {
    var since = new Date(); since.setDate(since.getDate() - 90);
    var sinceStr = formatDate(since);
    var res = await Promise.all([
      sb.from('closing_reports').select('*').gte('service_date', sinceStr).order('service_date', { ascending: false }).limit(120),
      sb.from('closing_report_entries').select('*').gte('service_date', sinceStr).limit(5000)
    ]);
    var reports = res[0].data || [];
    var entries = res[1].data || [];

    var html = '';

    // Aggregates
    html += '<div class="cr-card"><div class="cr-card-title">Last 90 days <span class="cr-sub">' + reports.length + ' reports · ' + entries.length + ' logged items</span></div>';
    html += crAggBlock('Complaints by category', entries.filter(function(e){return e.entry_type==='complaint';}), 'category');
    html += crAggBlock('Most 86\'d items', entries.filter(function(e){return e.entry_type==='unavailable';}), 'item_name');
    html += crAggBlock('Operation issues', entries.filter(function(e){return e.entry_type==='operation';}), 'category');
    html += crAggBlock('Team issues', entries.filter(function(e){return e.entry_type==='team';}), 'category');
    html += crAggBlock('Dishes complained about', entries.filter(function(e){return e.entry_type==='complaint' && e.item_name;}), 'item_name');
    html += '</div>';

    // Report list
    html += '<div class="cr-card"><div class="cr-card-title">Reports</div>';
    if (!reports.length) html += '<div style="font-size:13px;color:var(--ink);opacity:.7">No reports yet — tonight will be the first.</div>';
    var faces = ['😖','😕','😐','🙂','🔥'];
    reports.forEach(function(r){
      var rEntries = entries.filter(function(e){ return e.service_date === r.service_date; });
      var nC = rEntries.filter(function(e){return e.entry_type==='complaint';}).length;
      var n86 = rEntries.filter(function(e){return e.entry_type==='unavailable';}).length;
      html += '<div class="cr-hist-row">'
        + '<div class="cr-hist-date">' + new Date(r.service_date + 'T12:00:00').toLocaleDateString('en-GB', {weekday:'short', day:'numeric', month:'short'})
        + (r.day_rating ? ' · ' + faces[r.day_rating-1] : '') + '</div>'
        + '<div class="cr-hist-meta">'
        + (r.revenue_aed ? 'AED ' + Number(r.revenue_aed).toLocaleString() + ' · ' : '')
        + (r.covers_actual != null ? r.covers_actual + ' covers · ' : '')
        + nC + ' complaints · ' + n86 + ' items 86'
        + (r.checks_done != null ? ' · ' + r.checks_done + ' checked' + (r.checks_done < 10 ? ' ⚠️' : '') : '')
        + (r.chefs_on_duty && r.chefs_on_duty.length ? ' · ' + r.chefs_on_duty.join(', ') : '')
        + '</div>'
        + (r.general_feedback ? '<div class="cr-hist-meta" style="margin-top:4px;font-style:italic">' + crEsc(r.general_feedback.substring(0,140)) + (r.general_feedback.length>140?'…':'') + '</div>' : '')
        + '</div>';
    });
    html += '</div>';

    el.innerHTML = html;
  } catch (err) {
    console.error('[closing] history error', err);
    el.innerHTML = '<div class="cr-card">Could not load history. The closing_reports tables may not exist yet.</div>';
  }
}

function crAggBlock(title, list, field) {
  if (!list.length) return '';
  var counts = {};
  list.forEach(function(e){ var k = e[field] || '(none)'; counts[k] = (counts[k] || 0) + 1; });
  var pairs = Object.keys(counts).map(function(k){ return [k, counts[k]]; }).sort(function(a,b){ return b[1]-a[1]; }).slice(0, 6);
  var max = pairs[0][1];
  var html = '<div class="cr-field-label" style="margin-top:14px">' + title + '</div>';
  pairs.forEach(function(p){
    html += '<div class="cr-agg-bar"><span class="cr-agg-label">' + crEsc(p[0]) + '</span><div class="cr-agg-fill" style="width:' + Math.round(p[1]/max*100*0.55) + '%"></div><span class="cr-agg-n">' + p[1] + '</span></div>';
  });
  return html;
}

function crEsc(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
