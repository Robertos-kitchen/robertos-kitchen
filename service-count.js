// ══════════════════════════════════════════════════════════════════════════
// SERVICE COUNT — the meat and fish count the kitchen does on paper (25 Nov 2026)
// Asked by Antonio (Send feedback 21 Nov, with a photo of the paper sheet): counted
// at mid-service to know what is 85 / 86 and to fill Fish of the Day for the floor,
// then again at night to know what must be ordered urgently.
//   • service_count_items  = the standing list (Meat / Fish / Business Lunch / Brunch);
//                            grows when someone types a new line (saved for next time)
//   • service_count_sheet  = one row per business date AND count (mid | night)
// Every cell is saved on its own through the database function service_count_set,
// which changes that one cell inside the document. So two people counting at the
// same time can never overwrite each other's lines — the fault Fish of the Day had
// to be repaired for in August cannot happen here by construction.
// Reads the tables — never a hardcoded copy of the list.
// ══════════════════════════════════════════════════════════════════════════
(function(){
  var SECTIONS = ['Meat', 'Fish', 'Business Lunch', 'Brunch'];
  var SLOTS = { mid: 'Mid-service', night: 'End of night' };
  var items = [], docs = { mid: {}, night: {} }, slot = 'mid', bizDate = null;
  var loadFailed = false, pending = 0, pollTimer = null, askDel = null, timers = {};

  function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function host(){
    var h = document.getElementById('count-view');
    if (!h){
      h = document.createElement('div'); h.id = 'count-view'; h.className = 'ops-view'; h.style.display = 'none';
      var ref = document.getElementById('fish-view');
      if (ref && ref.parentNode) ref.parentNode.insertBefore(h, ref.nextSibling); else document.body.appendChild(h);
    }
    return h;
  }
  function shown(){ var h = document.getElementById('count-view'); return !!(h && h.style.display !== 'none'); }
  function warn(msg){ if (typeof kToast === 'function') kToast(msg, true); else console.warn(msg); }
  function readOnly(){ return !!window.DEV_READ_ONLY; }
  function who(){ return window.CURRENT_USER || null; }
  function cell(s, id){ return (docs[s] && docs[s][id]) || {}; }
  function typing(){ var a = document.activeElement; return !!(a && a.classList && a.classList.contains('sc-in')); }

  // Any other screen opening must close this one. The app keeps its own list of
  // screens in two places; rather than edit both, this screen takes itself down.
  ['hideAllPages', 'switchStation'].forEach(function(fn){
    var orig = window[fn];
    if (typeof orig !== 'function') return;
    window[fn] = function(){
      var h = document.getElementById('count-view'); if (h) h.style.display = 'none';
      stopPoll();
      return orig.apply(this, arguments);
    };
  });

  async function load(){
    bizDate = (typeof TODAY !== 'undefined' && TODAY) ? TODAY : new Date().toISOString().slice(0, 10);
    var res = await Promise.all([
      sb.from('service_count_items').select('*').eq('active', true).order('sort_order').order('created_at'),
      sb.from('service_count_sheet').select('slot,doc').eq('biz_date', bizDate)
    ]);
    loadFailed = !!(res[0].error || res[1].error);
    if (res[0].error) warn('The count list could not be loaded — reopen Service Count.');
    else items = res[0].data || [];
    if (res[1].error) warn('Today’s count could not be loaded — reopen before typing, so nothing is lost.');
    else {
      var next = { mid: {}, night: {} };
      (res[1].data || []).forEach(function(r){ if (next[r.slot]) next[r.slot] = r.doc || {}; });
      docs = next;
    }
  }

  // ── one cell, saved on its own ─────────────────────────────────────────────
  async function save(id, field, value){
    if (loadFailed){ warn('Not saved — today’s count did not load. Reopen Service Count first.'); return; }
    var s = slot;
    if (!docs[s][id]) docs[s][id] = {};
    docs[s][id][field] = value;
    if (readOnly()){ warn('DEV site is read-only — nothing is saved here. Tap the DEV badge (bottom-left) to test saving.'); return; }
    pending++;
    try {
      var r = await sb.rpc('service_count_set', { p_date: bizDate, p_slot: s, p_item: id, p_field: field, p_value: String(value == null ? '' : value), p_by: who() });
      if (r.error){ console.warn('service_count_set failed', r.error); warn('That line was NOT saved — check the connection and type it again.'); }
      else if (r.data && !typing() && pending === 1){ docs[s] = r.data; }
    } catch (e){ console.warn(e); warn('That line was NOT saved — check the connection and type it again.'); }
    pending--;
  }
  function saveSoon(id, field, value){
    var k = slot + '|' + id + '|' + field;
    if (timers[k]) clearTimeout(timers[k]);
    timers[k] = setTimeout(function(){ delete timers[k]; save(id, field, value); summary(); }, 450);
  }

  // ── the standing list ──────────────────────────────────────────────────────
  async function addItem(section, name){
    name = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!name) return;
    if (items.some(function(i){ return i.section === section && i.name.toLowerCase() === name.toLowerCase(); })){ warn('"' + name + '" is already on the ' + section + ' list.'); return; }
    if (readOnly()){ warn('DEV site is read-only — the line was not added.'); return; }
    var ord = items.filter(function(i){ return i.section === section; }).reduce(function(m, i){ return Math.max(m, i.sort_order || 0); }, 0) + 1;
    var r = await sb.from('service_count_items').insert({ section: section, name: name, sort_order: ord }).select().single();
    if (r.error || !r.data){ warn('The line could not be added — check the connection.'); return; }
    items.push(r.data); render();
    var f = document.querySelector('.sc-add[data-sec="' + section + '"]'); if (f) f.focus();
  }
  async function removeItem(id){
    if (readOnly()){ warn('DEV site is read-only — the line was not removed.'); return; }
    var r = await sb.from('service_count_items').update({ active: false }).eq('id', id);
    if (r.error){ warn('The line could not be removed — check the connection.'); return; }
    items = items.filter(function(i){ return i.id !== id; }); askDel = null; render();
  }

  // ── what the count says ────────────────────────────────────────────────────
  function isZero(v){ v = String(v == null ? '' : v).trim().replace(',', '.'); return v !== '' && !isNaN(parseFloat(v)) && parseFloat(v) === 0; }
  function summaryHtml(){
    var d = docs[slot] || {}, out = [], ord = [];
    items.forEach(function(i){ var c = d[i.id] || {}; if (isZero(c.portions)) out.push(i.name); if (c.order === '1') ord.push(i.name); });
    // both lines are always there: a line that appeared only once something was 86 pushed the
    // whole list down under the finger of whoever was still counting (seen while testing)
    return '<div class="sc-sum sc-sum86' + (out.length ? '' : ' sc-quiet') + '"><b>86 — none left</b><span>' + (out.length ? out.map(esc).join(' · ') : 'nothing') + '</span></div>' +
           '<div class="sc-sum sc-sumord' + (ord.length ? '' : ' sc-quiet') + '"><b>To order</b><span>' + (ord.length ? ord.map(esc).join(' · ') : 'nothing ticked') + '</span></div>';
  }
  function summary(){ var el = document.getElementById('sc-summary'); if (el) el.innerHTML = summaryHtml(); }

  function rowHtml(i){
    var c = cell(slot, i.id), m = slot === 'night' ? cell('mid', i.id) : null;
    var hint = function(v, unit){ v = (v == null ? '' : String(v)).trim(); return (m && v !== '') ? '<span class="sc-mid">mid ' + esc(v) + (unit || '') + '</span>' : ''; };
    var del = askDel === i.id
      ? '<span class="sc-delask">Take off the list? <button type="button" data-delyes="' + i.id + '">Yes</button><button type="button" data-delno="1">No</button></span>'
      : '<button type="button" class="sc-del" data-del="' + i.id + '" title="Take this line off the list" aria-label="Take ' + esc(i.name) + ' off the list">&times;</button>';
    return '<div class="sc-row' + (isZero(c.portions) ? ' sc-out' : '') + '" data-id="' + i.id + '">' +
      '<div class="sc-name"><span>' + esc(i.name) + '</span>' + del + '</div>' +
      '<label class="sc-num"><span class="sc-lab">KG</span><input class="sc-in" inputmode="decimal" autocomplete="off" data-id="' + i.id + '" data-f="kg" value="' + esc(c.kg) + '">' + hint(m && m.kg, ' kg') + '</label>' +
      '<label class="sc-num"><span class="sc-lab">Portions</span><input class="sc-in" inputmode="decimal" autocomplete="off" data-id="' + i.id + '" data-f="portions" value="' + esc(c.portions) + '">' + hint(m && m.portions) + '</label>' +
      '<button type="button" class="sc-tick' + (c.order === '1' ? ' on' : '') + '" data-id="' + i.id + '" data-t="order" aria-pressed="' + (c.order === '1') + '">Order</button>' +
      '<button type="button" class="sc-tick sc-dont' + (c.dont === '1' ? ' on' : '') + '" data-id="' + i.id + '" data-t="dont" aria-pressed="' + (c.dont === '1') + '">Don’t order</button>' +
    '</div>';
  }

  function render(){
    var h = host();
    var dateLabel = new Date(bizDate + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    var secs = SECTIONS.slice();
    items.forEach(function(i){ if (secs.indexOf(i.section) < 0) secs.push(i.section); });
    h.innerHTML = STYLE +
      '<div class="ops-title">Service Count</div>' +
      '<div class="ops-subtitle">' + esc(dateLabel) + '</div>' +
      '<div class="sc-bar">' +
        '<div class="sc-tabs" role="tablist">' + Object.keys(SLOTS).map(function(k){
          return '<button type="button" role="tab" aria-selected="' + (k === slot) + '" class="sc-tab' + (k === slot ? ' on' : '') + '" data-slot="' + k + '">' + SLOTS[k] + '</button>'; }).join('') + '</div>' +
        '<div class="sc-acts"><button type="button" class="sc-btn" data-act="fish">Fish of the Day</button>' +
        '<button type="button" class="sc-btn" data-act="print">Print</button></div>' +
      '</div>' +
      '<div id="sc-summary">' + summaryHtml() + '</div>' +
      secs.map(function(sec){
        var list = items.filter(function(i){ return i.section === sec; });
        return '<div class="sc-sec"><div class="sc-sechead"><span>' + esc(sec) + '</span><small>' + list.length + (list.length === 1 ? ' line' : ' lines') + '</small></div>' +
          list.map(rowHtml).join('') +
          '<div class="sc-addrow"><input class="sc-add" data-sec="' + esc(sec) + '" maxlength="60" placeholder="Add a line to ' + esc(sec) + '…" autocomplete="off">' +
          '<button type="button" class="sc-btn sc-addbtn" data-addsec="' + esc(sec) + '">Add</button></div></div>';
      }).join('');
  }

  // ── printing: the same sheet as the paper one ──────────────────────────────
  function print(){
    var d = docs[slot] || {};
    var dateLabel = new Date(bizDate + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    var secs = SECTIONS.slice(); items.forEach(function(i){ if (secs.indexOf(i.section) < 0) secs.push(i.section); });
    var body = secs.map(function(sec){
      var list = items.filter(function(i){ return i.section === sec; });
      var rows = list.map(function(i){ var c = d[i.id] || {};
        return '<tr><td>' + esc(i.name) + '</td><td class="n">' + esc(c.kg) + '</td><td class="n">' + esc(c.portions) + '</td><td class="n">' + (c.order === '1' ? '&#10003;' : '') + '</td><td class="n">' + (c.dont === '1' ? '&#10003;' : '') + '</td></tr>'; }).join('');
      for (var b = 0; b < (list.length ? 2 : 5); b++) rows += '<tr><td>&nbsp;</td><td></td><td></td><td></td><td></td></tr>';
      return '<tr class="s"><td colspan="5">' + esc(sec) + '</td></tr>' + rows;
    }).join('');
    var html = '<!doctype html><html><head><meta charset="utf-8"><title>Service count ' + esc(bizDate) + ' ' + esc(SLOTS[slot]) + '</title><style>' +
      '@page{size:A4;margin:12mm}body{font-family:Arial,Helvetica,sans-serif;color:#000}h1{font-family:Georgia,serif;font-weight:400;letter-spacing:6px;text-align:center;font-size:20pt;margin:0 0 2mm}' +
      'p{text-align:center;margin:0 0 5mm;font-size:10.5pt}table{width:100%;border-collapse:collapse}td,th{border:.6pt solid #000;padding:2.2pt 5pt;font-size:10pt}' +
      'th{font-size:9pt;text-align:center}th:first-child{border-top:none;border-left:none}td.n{text-align:center;width:17%}tr.s td{font-weight:700;font-size:11.5pt;padding-top:4pt}' +
      '</style></head><body><h1>ROBERTO’S</h1><p>' + esc(SLOTS[slot]) + ' count · ' + esc(dateLabel) + '</p>' +
      '<table><tr><th></th><th>KG</th><th>Portions</th><th>Order</th><th>Don’t order</th></tr>' + body + '</table></body></html>';
    var f = document.getElementById('sc-printframe');
    if (!f){ f = document.createElement('iframe'); f.id = 'sc-printframe'; f.setAttribute('aria-hidden', 'true');
      f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'; document.body.appendChild(f); }
    var w = f.contentWindow; w.document.open(); w.document.write(html); w.document.close();
    setTimeout(function(){ try { w.focus(); w.print(); } catch (e){ warn('Could not open the print window.'); } }, 150);
  }

  // ── events (one set, on the host) ──────────────────────────────────────────
  var wired = false;
  function wire(){
    if (wired) return; wired = true;
    var h = host();
    h.addEventListener('input', function(e){
      var t = e.target; if (!t.classList || !t.classList.contains('sc-in')) return;
      var row = t.closest('.sc-row'); if (row && t.dataset.f === 'portions') row.classList.toggle('sc-out', isZero(t.value));
      saveSoon(t.dataset.id, t.dataset.f, t.value.trim());
    });
    h.addEventListener('keydown', function(e){
      var t = e.target; if (e.key !== 'Enter' || !t.classList) return;
      if (t.classList.contains('sc-add')){ e.preventDefault(); var v = t.value; t.value = ''; addItem(t.dataset.sec, v); return; }
      if (!t.classList.contains('sc-in')) return;
      e.preventDefault();
      var all = Array.prototype.slice.call(h.querySelectorAll('.sc-in[data-f="' + t.dataset.f + '"]'));
      var n = all[all.indexOf(t) + 1]; if (n){ n.focus(); n.select(); } else t.blur();
    });
    h.addEventListener('focusout', function(){ setTimeout(function(){ if (!typing() && shown() && !pending) { summary(); } }, 60); });
    h.addEventListener('click', function(e){
      var b = e.target.closest ? e.target.closest('button') : null; if (!b) return;
      if (b.dataset.slot){ slot = b.dataset.slot; askDel = null; try { sessionStorage.setItem('sc-slot-' + bizDate, slot); } catch (x){} refresh(true); return; }
      if (b.dataset.act === 'print'){ print(); return; }
      if (b.dataset.act === 'fish'){ if (typeof openFishDisplay === 'function') openFishDisplay(); return; }
      if (b.dataset.t){
        var id = b.dataset.id, f = b.dataset.t, other = f === 'order' ? 'dont' : 'order', c = cell(slot, id);
        var on = c[f] === '1' ? '' : '1';
        save(id, f, on).then(summary);
        if (on === '1' && c[other] === '1') save(id, other, '');     // one or the other, like the two columns on the paper
        var row = b.closest('.sc-row');
        if (row){ row.querySelectorAll('.sc-tick').forEach(function(x){ var isOn = (cell(slot, id)[x.dataset.t] === '1'); x.classList.toggle('on', isOn); x.setAttribute('aria-pressed', String(isOn)); }); }
        summary(); return;
      }
      if (b.dataset.addsec){ var inp = h.querySelector('.sc-add[data-sec="' + b.dataset.addsec + '"]'); if (inp){ var v = inp.value; inp.value = ''; addItem(b.dataset.addsec, v); } return; }
      if (b.dataset.del){ askDel = b.dataset.del; render(); return; }
      if (b.dataset.delno){ askDel = null; render(); return; }
      if (b.dataset.delyes){ removeItem(b.dataset.delyes); return; }
    });
  }

  // another tablet's lines arrive here; never while someone is typing or a save is on its way
  async function refresh(force){
    if (!shown()) return;
    if (!force && (typing() || pending || Object.keys(timers).length || askDel)) return;
    await load(); if (shown() && (force || !typing())) render();
  }
  function stopPoll(){ if (pollTimer){ clearInterval(pollTimer); pollTimer = null; } }

  window.openServiceCount = async function(){
    if (typeof activeStation !== 'undefined') { try { activeStation = 'service_count'; } catch (e){} }
    hideAllPages();
    var h = host(); h.style.display = 'block';
    var fb = document.querySelector('.footer-bar'); if (fb) fb.style.display = 'flex';
    var fl = document.getElementById('foot-label'); if (fl) fl.textContent = 'Service Count';
    h.innerHTML = STYLE + '<div class="ops-title">Service Count</div><div class="ops-subtitle">Loading…</div>';
    wire();
    await load();
    var saved = null; try { saved = sessionStorage.getItem('sc-slot-' + bizDate); } catch (x){}
    // the first count is at mid-service; from 6 in the evening (Dubai) it opens on the night count
    var hr = new Date(Date.now() + 4 * 3600000).getUTCHours();
    slot = SLOTS[saved] ? saved : ((hr >= 18 || hr < 6) ? 'night' : 'mid');
    render();
    stopPoll(); pollTimer = setInterval(function(){ refresh(false); }, 20000);
  };

  var STYLE = '<style id="sc-style">' +
    '.sc-bar{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin:4px 0 12px}' +
    '.sc-tabs{display:inline-flex;border:1.5px solid var(--vino);border-radius:8px;overflow:hidden}' +
    '.sc-tab{padding:10px 16px;font-size:13px;font-weight:600;letter-spacing:.4px;background:transparent;color:var(--vino);border:0;cursor:pointer;font-family:var(--font-sans);min-height:42px}' +
    '.sc-tab.on{background:var(--vino);color:#fbf3e9}' +
    '.sc-acts{display:flex;gap:8px;flex-wrap:wrap}' +
    '.sc-btn{padding:9px 14px;min-height:40px;border-radius:7px;border:1.5px solid var(--vino);background:transparent;color:var(--vino);font-size:12.5px;font-weight:600;cursor:pointer;font-family:var(--font-sans)}' +
    '.sc-btn:hover{background:var(--vino);color:#fbf3e9}' +
    '.sc-sum{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;padding:9px 12px;border-radius:8px;margin-bottom:8px;font-size:14px;line-height:1.45;color:#2a1a12}' +
    '.sc-sum b{font-size:11px;letter-spacing:1.6px;text-transform:uppercase;white-space:nowrap}' +
    '.sc-sum86{background:#f6dcd9;border:1px solid #c98c86}.sc-sum86 b{color:#7a1218}' +
    '.sc-sumord{background:#f3ead0;border:1px solid #c9b274}.sc-sumord b{color:#5c4300}' +
    '.sc-sum.sc-quiet{background:#f7f1e7;border-color:var(--sabbia-dark)}.sc-sum.sc-quiet b,.sc-sum.sc-quiet span{color:#4a3526}' +
    '.sc-sec{background:#f7f1e7;border:1px solid var(--sabbia-dark);border-radius:10px;margin-bottom:14px;overflow:hidden}' +
    '.sc-sechead{display:flex;justify-content:space-between;align-items:baseline;padding:10px 14px;background:var(--vino);color:#fbf3e9;font-family:var(--font-serif);font-size:18px;letter-spacing:.5px}' +
    '.sc-sechead small{font-family:var(--font-sans);font-size:11px;letter-spacing:1px;color:#e9d6c2}' +
    '.sc-row{display:grid;grid-template-columns:minmax(0,1fr) 92px 92px 84px 118px;gap:8px;align-items:center;padding:7px 12px;border-bottom:1px solid var(--sabbia-dark)}' +
    '.sc-row.sc-out{background:#f6dcd9}' +
    '.sc-name{display:flex;align-items:center;gap:8px;min-width:0;font-size:16px;color:#2a1a12;font-weight:500}' +
    '.sc-name>span:first-child{overflow-wrap:anywhere}' +
    '.sc-row.sc-out .sc-name>span:first-child::after{content:"86";margin-left:8px;font-size:11px;font-weight:700;letter-spacing:1px;color:#fff;background:#7a1218;border-radius:4px;padding:2px 6px}' +
    '.sc-del{flex-shrink:0;width:28px;height:28px;border-radius:50%;border:0;background:transparent;color:#7a5c48;font-size:18px;line-height:1;cursor:pointer}' +
    '.sc-del:hover{background:var(--vino);color:#fbf3e9}' +
    '.sc-delask{font-size:12.5px;color:#2a1a12;white-space:nowrap}.sc-delask button{margin-left:6px;padding:5px 10px;border-radius:6px;border:1.5px solid var(--vino);background:transparent;color:var(--vino);font-weight:600;cursor:pointer}' +
    '.sc-num{display:flex;flex-direction:column;gap:2px;min-width:0}' +
    '.sc-lab{display:none;font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:#5e4636}' +
    '.sc-in{width:100%;box-sizing:border-box;min-height:42px;padding:6px 8px;font-size:17px;font-weight:600;text-align:center;color:#2a1a12;background:#fff;border:1.5px solid #b9a58e;border-radius:7px;font-family:var(--font-sans)}' +
    '.sc-in:focus{outline:none;border-color:var(--vino);box-shadow:0 0 0 2px rgba(65,2,7,.18)}' +
    '.sc-mid{font-size:11px;color:#5e4636;text-align:center}' +
    '.sc-tick{min-height:42px;padding:6px 8px;border-radius:7px;border:1.5px solid #b9a58e;background:#fff;color:#4a3526;font-size:12.5px;font-weight:600;cursor:pointer;font-family:var(--font-sans)}' +
    '.sc-tick.on{background:#1f5c35;border-color:#1f5c35;color:#fff}.sc-tick.sc-dont.on{background:#7a1218;border-color:#7a1218;color:#fff}' +
    '.sc-tick.on::before{content:"\\2713  "}' +
    '.sc-addrow{display:flex;gap:8px;padding:9px 12px}' +
    '.sc-add{flex:1;min-width:0;min-height:40px;padding:6px 10px;font-size:14.5px;color:#2a1a12;background:#fff;border:1.5px dashed #b9a58e;border-radius:7px;font-family:var(--font-sans)}' +
    '.sc-add::placeholder{color:#6b5443}' +
    '.sc-add:focus{outline:none;border-style:solid;border-color:var(--vino)}' +
    '@media(min-width:701px){.sc-sechead + .sc-row .sc-lab{display:block;text-align:center}}' +
    '@media(max-width:700px){' +
      '.sc-row{grid-template-columns:1fr 1fr;row-gap:6px}.sc-name{grid-column:1/-1}.sc-lab{display:block}' +
      '.sc-tabs{width:100%}.sc-tab{flex:1}' +
    '}' +
    '</style>';
})();
