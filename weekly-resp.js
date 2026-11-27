// ══════════════════════════════════════════════════════════════════════════
// WEEKLY RESPONSIBILITIES — a small box under the rota (25 Nov 2026)
// Asked by Antonio (Send feedback 22 Nov): each week give a few specific jobs
// (basement cold rooms, dry store, other areas) to 2–4 people, WITHOUT touching
// the rota itself, so the cleaning and organising becomes a daily habit instead
// of a deep clean every two weeks.
//   • sched_week_tasks = one row per week (week_start = the Monday), doc.rows =
//     [{ task, people:[{id,name}] }]. Nothing in `roster` or `staff` is written.
//   • Read by everyone who opens the Schedule; changed only with the Schedule
//     unlocked (the same edit code as the rota, and the master codes with it).
//   • 27 Nov 2026 (Antonio, Send feedback 26 Nov): each job says HOW OFTEN —
//     freq 'daily' | 'weekly' (+ the one day) | 'days' (+ the chosen days);
//     days = 0..6 counted from the Monday. Jobs saved before this have no freq
//     and show none (never guessed). The Today view marks the jobs due today.
// It hangs itself under the week grid and the Today view by wrapping
// renderSchedView, so the schedule code itself is not edited.
// ══════════════════════════════════════════════════════════════════════════
(function(){
  var MAX_PEOPLE = 4, MAX_ROWS = 12;
  var week = null, rows = [], draft = null, loaded = false, loadFailed = false, busy = false, pickFor = -1;

  function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function warn(msg, ok){ if (typeof kToast === 'function') kToast(msg, !ok); else console.warn(msg); }
  function weekKey(){ return (typeof schedWeekStart !== 'undefined' && schedWeekStart) ? formatDate(schedWeekStart) : null; }
  var FREQS = ['daily', 'weekly', 'days'];
  var DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var DAYL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  function cleanDays(d){
    var out = [];
    (Array.isArray(d) ? d : []).forEach(function(x){ x = +x; if (x >= 0 && x <= 6 && x === Math.floor(x) && out.indexOf(x) < 0) out.push(x); });
    return out.sort(function(a, b){ return a - b; });
  }
  function clean(list){
    return (Array.isArray(list) ? list : []).map(function(r){
      var f = (r && FREQS.indexOf(r.freq) >= 0) ? r.freq : null;
      var days = (f === 'weekly' || f === 'days') ? cleanDays(r.days) : [];
      if (f === 'weekly') days = days.slice(0, 1);
      return { task: String((r && r.task) || '').slice(0, 140),
               people: (Array.isArray(r && r.people) ? r.people : []).filter(function(p){ return p && p.name; }).slice(0, MAX_PEOPLE)
                         .map(function(p){ return { id: p.id == null ? null : p.id, name: String(p.name) }; }),
               freq: f, days: days };
    }).slice(0, MAX_ROWS);
  }
  // the date of day d (0 = Monday) of the week on screen, e.g. "10 Dec"
  function dayDate(d){
    if (typeof schedWeekStart === 'undefined' || !schedWeekStart) return '';
    return addDays(schedWeekStart, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  // "Every day" · "Once a week · Thursday 10 Dec" · "Mon · Wed · Fri" · '' (not set)
  function freqLabel(r){
    if (r.freq === 'daily') return 'Every day';
    if (r.freq === 'weekly') return r.days.length ? 'Once a week · ' + DAYL[r.days[0]] + ' ' + dayDate(r.days[0]) : 'Once a week';
    if (r.freq === 'days'){
      if (r.days.length === 7) return 'Every day';
      return r.days.length ? r.days.map(function(d){ return DAY[d]; }).join(' · ') : '';
    }
    return '';
  }
  // which day of the week on screen today is (0..6), or -1 when today is not in it
  function todayIdx(){
    if (typeof schedWeekStart === 'undefined' || !schedWeekStart) return -1;
    for (var d = 0; d < 7; d++) if (formatDate(addDays(schedWeekStart, d)) === formatDate(new Date())) return d;
    return -1;
  }
  // true / false when the job says how often, null when it does not
  function dueOn(r, d){
    if (r.freq === 'daily') return true;
    if (r.freq === 'weekly' || r.freq === 'days') return r.days.indexOf(d) >= 0;
    return null;
  }
  function staffList(){
    var s = (typeof schedStaff !== 'undefined' && Array.isArray(schedStaff)) ? schedStaff : [];
    return s.filter(function(p){ return p && p.name; }).map(function(p){ return { id: p.id, name: String(p.name) }; })
            .sort(function(a, b){ return a.name.localeCompare(b.name); });
  }

  async function load(k){
    var r = await sb.from('sched_week_tasks').select('doc').eq('week_start', k).maybeSingle();
    if (weekKey() !== k) return;                       // the week moved on while this was loading
    loadFailed = !!r.error;
    rows = clean(r.data && r.data.doc && r.data.doc.rows);
    week = k; loaded = true; draft = null; pickFor = -1;
  }

  function box(){
    var view = (typeof schedView !== 'undefined' && schedView === 'day') ? 'sch-day-view' : 'sch-week-view';
    var parent = document.getElementById(view); if (!parent) return null;
    var el = document.getElementById('wkr-box');
    if (!el){ el = document.createElement('div'); el.id = 'wkr-box'; el.addEventListener('click', onClick); el.addEventListener('input', onInput); el.addEventListener('change', onChange); }
    if (el.parentNode !== parent) parent.appendChild(el);
    return el;
  }

  function viewHtml(){
    var label = (typeof schedWeekStart !== 'undefined' && schedWeekStart)
      ? 'Week of ' + schedWeekStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
    var head = '<div class="wkr-head"><div><div class="wkr-title">Weekly Responsibilities</div><div class="wkr-sub">' + esc(label) + '</div></div>' +
      '<button type="button" class="wkr-btn" data-a="edit">' + (rows.length ? 'Change' : 'Set this week') + '</button></div>';
    if (loadFailed) return head + '<div class="wkr-empty">This week’s responsibilities could not be loaded. Reopen the Schedule.</div>';
    if (!rows.length) return head + '<div class="wkr-empty">Nothing set for this week yet.</div>';
    var t = (typeof schedView !== 'undefined' && schedView === 'day') ? todayIdx() : -1;
    return head + '<div class="wkr-list">' + rows.map(function(r){
      var fl = freqLabel(r), due = t >= 0 ? dueOn(r, t) : null;
      var mark = due === true ? '<span class="wkr-today">Today</span>' : due === false ? '<span class="wkr-nottoday">Not today</span>' : '';
      return '<div class="wkr-row"><div><div class="wkr-task">' + esc(r.task || '—') + '</div>' +
        ((fl || mark) ? '<div class="wkr-freq">' + mark + esc(fl) + '</div>' : '') + '</div><div class="wkr-people">' +
        (r.people.length ? r.people.map(function(p){ return '<span class="wkr-chip">' + esc(p.name) + '</span>'; }).join('') : '<span class="wkr-none">nobody yet</span>') +
      '</div></div>'; }).join('') + '</div>';
  }

  function oftenHtml(r, i){
    var opts = [['daily', 'Every day'], ['weekly', 'Once a week'], ['days', 'Chosen days']];
    var out = '<div class="wkr-often" role="group" aria-label="How often"><span class="wkr-fl">How often</span>' +
      opts.map(function(o){
        var on = r.freq === o[0];
        return '<button type="button" class="wkr-opt" data-a="freq" data-f="' + o[0] + '" data-i="' + i + '" aria-pressed="' + on + '">' + o[1] + '</button>'; }).join('') + '</div>';
    if (r.freq === 'weekly' || r.freq === 'days'){
      out += '<div class="wkr-often wkr-days" role="group" aria-label="' + (r.freq === 'weekly' ? 'Which day' : 'Which days') + '">' +
        '<span class="wkr-fl">' + (r.freq === 'weekly' ? 'Which day' : 'Which days') + '</span>' +
        DAY.map(function(d, k){
          var on = r.days.indexOf(k) >= 0;
          return '<button type="button" class="wkr-opt wkr-day" data-a="day" data-d="' + k + '" data-i="' + i + '" aria-pressed="' + on + '" aria-label="' + DAYL[k] + ' ' + esc(dayDate(k)) + '">' +
            d + '<small>' + esc(dayDate(k).split(' ')[0]) + '</small></button>'; }).join('') + '</div>';
    }
    return out;
  }

  function editHtml(){
    var staff = staffList();
    var out = '<div class="wkr-head"><div><div class="wkr-title">Weekly Responsibilities</div><div class="wkr-sub">Changing this week — the rota is not touched</div></div></div>';
    out += draft.map(function(r, i){
      var taken = r.people.map(function(p){ return String(p.id); });
      var free = staff.filter(function(p){ return taken.indexOf(String(p.id)) < 0; });
      var picker = '';
      if (r.people.length < MAX_PEOPLE){
        picker = pickFor === i
          ? '<select class="wkr-sel" data-i="' + i + '" aria-label="Add a person"><option value="">Choose a person…</option>' +
              free.map(function(p){ return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>'; }).join('') + '</select>'
          : '<button type="button" class="wkr-add" data-a="pick" data-i="' + i + '">+ person</button>';
      }
      return '<div class="wkr-erow">' +
        '<input class="wkr-in" data-i="' + i + '" maxlength="140" placeholder="The job — e.g. Basement cold rooms: clean and organise" value="' + esc(r.task) + '">' +
        oftenHtml(r, i) +
        '<div class="wkr-people">' + r.people.map(function(p, j){
          return '<span class="wkr-chip wkr-chip-e">' + esc(p.name) + '<button type="button" data-a="unp" data-i="' + i + '" data-j="' + j + '" aria-label="Take ' + esc(p.name) + ' off this job">&times;</button></span>'; }).join('') + picker +
          '<button type="button" class="wkr-rm" data-a="rm" data-i="' + i + '">Remove this job</button></div>' +
      '</div>';
    }).join('');
    out += '<div class="wkr-foot">' +
      (draft.length < MAX_ROWS ? '<button type="button" class="wkr-btn" data-a="addrow">+ Add a job</button>' : '') +
      '<button type="button" class="wkr-btn" data-a="copy">Copy last week</button>' +
      '<span class="wkr-gap"></span>' +
      '<button type="button" class="wkr-btn" data-a="cancel">Cancel</button>' +
      '<button type="button" class="wkr-btn wkr-go" data-a="save"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Saving…' : 'Save') + '</button></div>';
    return out;
  }

  function render(){
    var el = box(); if (!el) return;
    if (!loaded){ el.innerHTML = STYLE + '<div class="wkr-card"><div class="wkr-empty">Loading the weekly responsibilities…</div></div>'; return; }
    el.innerHTML = STYLE + '<div class="wkr-card' + (draft ? ' wkr-editing' : '') + '">' + (draft ? editHtml() : viewHtml()) + '</div>';
  }

  function startEdit(){
    draft = clean(rows); if (!draft.length) draft.push({ task: '', people: [], freq: 'daily', days: [] });
    pickFor = -1; render();
    var f = document.querySelector('#wkr-box .wkr-in'); if (f && !f.value) f.focus();
  }

  async function save(){
    var out = clean(draft).map(function(r){ r.task = r.task.trim().replace(/\s+/g, ' '); return r; })
                          .filter(function(r){ return r.task || r.people.length; });
    if (out.some(function(r){ return !r.task; })){ warn('One job has people but no name — write what the job is, or remove it.'); return; }
    var noDay = out.filter(function(r){ return (r.freq === 'weekly' || r.freq === 'days') && !r.days.length; })[0];
    if (noDay){ warn('Pick the day for “' + noDay.task.slice(0, 40) + '” — or choose Every day.'); return; }
    if (window.DEV_READ_ONLY){ warn('DEV site is read-only — nothing was saved. Tap the DEV badge (bottom-left) to test saving.'); return; }
    var k = week; busy = true; render();
    var res = await sb.from('sched_week_tasks').upsert({ week_start: k, doc: { rows: out }, updated_by: (window.CURRENT_USER || null), updated_at: new Date().toISOString() }, { onConflict: 'week_start' });
    busy = false;
    if (res.error){ console.warn('sched_week_tasks save failed', res.error); warn('NOT saved — check the connection and press Save again.'); render(); return; }
    // read it back: the screen shows what the database holds, not what was typed
    var back = await sb.from('sched_week_tasks').select('doc').eq('week_start', k).maybeSingle();
    if (back.error || !back.data){ warn('Saved, but it could not be read back — reopen the Schedule to check.'); rows = out; }
    else rows = clean(back.data.doc && back.data.doc.rows);
    draft = null; pickFor = -1; render();
    warn('Weekly responsibilities saved.', true);
  }

  async function copyLast(){
    var prev = formatDate(addDays(schedWeekStart, -7));
    var r = await sb.from('sched_week_tasks').select('doc').eq('week_start', prev).maybeSingle();
    var got = clean(r.data && r.data.doc && r.data.doc.rows);
    if (r.error){ warn('Last week could not be read — check the connection.'); return; }
    if (!got.length){ warn('Last week had nothing set.'); return; }
    draft = got; pickFor = -1; render();
    warn('Last week copied — change the names, then Save.', true);
  }

  function onClick(e){
    var b = e.target.closest ? e.target.closest('button[data-a]') : null; if (!b) return;
    var a = b.dataset.a, i = +b.dataset.i;
    if (a === 'edit'){
      // the same lock as the rota: the edit code, or a master code
      if (typeof schedGuard === 'function' && !schedGuard(function(){ startEdit(); })) return;
      startEdit(); return;
    }
    if (!draft) return;
    if (typeof schedTouchLock === 'function' && typeof schedUnlocked !== 'undefined' && schedUnlocked) schedTouchLock();
    if (a === 'addrow'){ draft.push({ task: '', people: [], freq: 'daily', days: [] }); pickFor = -1; render(); var ins = document.querySelectorAll('#wkr-box .wkr-in'); if (ins.length) ins[ins.length - 1].focus(); return; }
    if (a === 'rm'){ draft.splice(i, 1); pickFor = -1; render(); return; }
    if (a === 'pick'){ pickFor = i; render(); var s = document.querySelector('#wkr-box .wkr-sel'); if (s) s.focus(); return; }
    if (a === 'unp'){ draft[i].people.splice(+b.dataset.j, 1); render(); return; }
    if (a === 'freq'){
      var f = b.dataset.f, r = draft[i]; r.freq = f;
      if (f === 'daily') r.days = [];
      else if (f === 'weekly') r.days = r.days.slice(0, 1);
      render(); return;
    }
    if (a === 'day'){
      var d = +b.dataset.d, rr = draft[i];
      if (rr.freq === 'weekly') rr.days = [d];
      else { var at = rr.days.indexOf(d); if (at >= 0) rr.days.splice(at, 1); else rr.days.push(d); rr.days = cleanDays(rr.days); }
      render(); return;
    }
    if (a === 'copy'){ copyLast(); return; }
    if (a === 'cancel'){ draft = null; pickFor = -1; render(); return; }
    if (a === 'save'){ if (!busy) save(); return; }
  }
  function onInput(e){ var t = e.target; if (draft && t.classList && t.classList.contains('wkr-in')) draft[+t.dataset.i].task = t.value; }
  function onChange(e){
    var t = e.target; if (!draft || !t.classList || !t.classList.contains('wkr-sel')) return;
    var i = +t.dataset.i, p = staffList().filter(function(x){ return String(x.id) === String(t.value); })[0];
    if (p && draft[i].people.length < MAX_PEOPLE) draft[i].people.push(p);
    pickFor = -1; render();
  }

  // ── printed with the rota: schedPrint (app.js) asks for this ───────────────
  // Only the SAVED list of the week on screen; a half-written change is not printed.
  // Styles are inline because the rota prints in its own window with its own sheet.
  window.wkrPrintHtml = function(){
    if (!loaded || loadFailed || week !== weekKey() || !rows.length) return '';
    var td = 'border:1px solid #999;padding:3px 7px;font-size:13px;text-align:left;vertical-align:top;';
    return '<table style="width:100%;border-collapse:collapse;margin-top:6px;page-break-inside:avoid;break-inside:avoid">' +
      '<tr><td colspan="2" style="' + td + 'background:#410207;color:#fff;font-weight:700;letter-spacing:1px;text-transform:uppercase;font-size:12px;-webkit-print-color-adjust:exact;print-color-adjust:exact">Weekly Responsibilities</td></tr>' +
      rows.map(function(r){
        var fl = freqLabel(r);
        return '<tr><td style="' + td + 'width:55%;font-weight:700">' + esc(r.task || '—') +
          (fl ? '<div style="font-size:11.5px;font-weight:600;margin-top:1px">' + esc(fl) + '</div>' : '') + '</td><td style="' + td + 'font-weight:600">' +
          (r.people.length ? r.people.map(function(p){ return esc(p.name); }).join(' · ') : '—') + '</td></tr>'; }).join('') +
      '</table>';
  };

  // ── hang under the schedule ────────────────────────────────────────────────
  function sync(){
    var k = weekKey(); if (!k) return;
    // the Roster tool draws over the schedule; the box belongs to the live week only
    if (typeof schedPlanMode !== 'undefined' && schedPlanMode){ var el = document.getElementById('wkr-box'); if (el) el.style.display = 'none'; return; }
    var cur = document.getElementById('wkr-box'); if (cur) cur.style.display = '';
    if (k !== week){
      if (draft && week){ render(); return; }           // never drop a half-written week by accident
      loaded = false; render();
      load(k).then(function(){ if (weekKey() === k) render(); });
      return;
    }
    render();
  }
  if (typeof window.renderSchedView === 'function'){
    var orig = window.renderSchedView;
    window.renderSchedView = function(){ var r = orig.apply(this, arguments); try { sync(); } catch (e){ console.warn('weekly responsibilities', e); } return r; };
  }
  // locking the schedule ends an edit that was never saved
  if (typeof window.schedLockNow === 'function'){
    var origLock = window.schedLockNow;
    window.schedLockNow = function(){ var r = origLock.apply(this, arguments); if (draft){ draft = null; pickFor = -1; try { render(); } catch (e){} } return r; };
  }

  var STYLE = '<style id="wkr-style">' +
    /* the bottom room is for the two round buttons fixed bottom-right (back to top, Send
       feedback): without it Save sat underneath them at the end of the page */
    '#wkr-box{padding:14px 16px 120px;max-width:980px}' +
    '.wkr-card{background:#f7f1e7;border:1px solid var(--sabbia-dark);border-left:4px solid var(--vino);border-radius:10px;padding:12px 14px}' +
    '.wkr-head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px}' +
    '.wkr-title{font-family:var(--font-serif);font-size:19px;color:var(--vino);letter-spacing:.3px}' +
    '.wkr-sub{font-size:12px;color:#4a3526;margin-top:1px}' +
    '.wkr-btn{padding:8px 13px;min-height:38px;border-radius:7px;border:1.5px solid var(--vino);background:transparent;color:var(--vino);font-size:12.5px;font-weight:600;cursor:pointer;font-family:var(--font-sans)}' +
    '.wkr-btn:hover{background:var(--vino);color:#fbf3e9}.wkr-btn.wkr-go{background:var(--vino);color:#fbf3e9}.wkr-btn[disabled]{opacity:.6;cursor:default}' +
    '.wkr-empty{font-size:14px;color:#4a3526;padding:4px 0 2px}' +
    '.wkr-row{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--sabbia-dark)}' +
    '.wkr-task{font-size:15.5px;color:#2a1a12;font-weight:500;overflow-wrap:anywhere}' +
    '.wkr-people{display:flex;flex-wrap:wrap;gap:6px;align-items:center}' +
    '.wkr-chip{display:inline-flex;align-items:center;gap:4px;background:var(--vino);color:#fbf3e9;border-radius:999px;padding:5px 11px;font-size:13px;font-weight:600}' +
    '.wkr-chip-e{padding-right:4px}.wkr-chip-e button{width:24px;height:24px;border-radius:50%;border:0;background:rgba(255,255,255,.2);color:#fff;font-size:15px;line-height:1;cursor:pointer}' +
    '.wkr-none{font-size:13px;color:#5e4636;font-style:italic}' +
    '.wkr-freq{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:3px;font-size:13px;font-weight:600;color:#4a3526}' +
    '.wkr-today{background:#1f5f3a;color:#fff;border-radius:5px;padding:1px 7px;font-size:12px;font-weight:700}' +
    '.wkr-nottoday{border:1px solid #8a7462;color:#4a3526;border-radius:5px;padding:0 6px;font-size:12px;font-weight:600}' +
    '.wkr-often{display:flex;flex-wrap:wrap;gap:6px;align-items:center}' +
    '.wkr-fl{font-size:12.5px;font-weight:700;color:#4a3526;min-width:78px}' +
    '.wkr-opt{min-height:36px;padding:5px 12px;border-radius:7px;border:1.5px solid var(--vino);background:#fff;color:var(--vino);font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font-sans)}' +
    '.wkr-opt[aria-pressed=true]{background:var(--vino);color:#fbf3e9}' +
    '.wkr-day{min-width:46px;padding:3px 6px;display:inline-flex;flex-direction:column;align-items:center;line-height:1.1}.wkr-day small{font-size:11px;font-weight:600}' +
    '.wkr-erow{padding:10px 0;border-top:1px solid var(--sabbia-dark);display:flex;flex-direction:column;gap:8px}' +
    '.wkr-in{width:100%;box-sizing:border-box;min-height:42px;padding:7px 10px;font-size:15px;color:#2a1a12;background:#fff;border:1.5px solid #b9a58e;border-radius:7px;font-family:var(--font-sans)}' +
    '.wkr-in::placeholder{color:#6b5443}.wkr-in:focus,.wkr-sel:focus{outline:none;border-color:var(--vino);box-shadow:0 0 0 2px rgba(65,2,7,.18)}' +
    '.wkr-add{padding:6px 12px;min-height:34px;border-radius:999px;border:1.5px dashed var(--vino);background:transparent;color:var(--vino);font-size:13px;font-weight:600;cursor:pointer}' +
    '.wkr-sel{min-height:36px;padding:5px 8px;font-size:14px;color:#2a1a12;background:#fff;border:1.5px solid #b9a58e;border-radius:7px;max-width:100%}' +
    '.wkr-rm{margin-left:auto;padding:6px 10px;min-height:34px;border:0;background:transparent;color:#7a1218;font-size:12.5px;font-weight:600;text-decoration:underline;cursor:pointer}' +
    '.wkr-foot{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding-top:12px;border-top:1px solid var(--sabbia-dark)}.wkr-gap{flex:1}' +
    '@media(max-width:640px){.wkr-row{grid-template-columns:1fr;gap:6px}#wkr-box{padding:12px 10px 120px}' +
    '.wkr-fl{flex-basis:100%;min-width:0}.wkr-often{gap:5px}.wkr-opt{padding:5px 10px}.wkr-day{min-width:0;flex:1 1 0;padding:3px 2px}}' +
    '@media print{#wkr-box{display:none}}' +
    '</style>';
})();
