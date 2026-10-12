// ──────────────────────────────────────────────────────────────────────────
// Roberto's Kitchen — Find.  One box on the home screen that gives people what
// is ALREADY in the app: a screen, a dish, a batch, or the recipes that use an
// ingredient.
//
// Why it exists (12 Oct 2026, inbox 873e8292): somebody typed "show me lemon zest
// recipe" into the feedback button, because nothing else on the screen looked
// like a place to ask. There is no recipe called lemon zest — but four dishes
// and several batches use it, and nothing in the app could say so.
//
// Three rules it keeps:
// 1. It only ever returns what exists. No AI, no written answers — a kitchen
//    cannot cook from a recipe a search box made up.
// 2. Nothing is copied here. The screens are read off the home tiles and
//    RECIPE_SCREENS at the moment of the search; the recipes are read from the
//    same tables the Recipe card reads. Add a tile or write a dish and Find has
//    it, with no list in this file to remember.
// 3. It reads, and never writes. Every request below is a GET.
//
// The matching is the Recipe card's own rule (recipe-card.html: words / stem /
// posIn / SYN) — every word typed has to be there, any order, plurals ignored —
// so what finds a dish there finds it here.
// ──────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  var SYN = { branzino:['seabass'], seabass:['branzino'], ricciola:['amberjack','hamachi'],
    amberjack:['ricciola','hamachi'], hamachi:['ricciola','amberjack'],
    aubergine:['eggplant'], eggplant:['aubergine'], courgette:['zucchini'], zucchini:['courgette'],
    prawn:['shrimp','gambero','gamberi'], shrimp:['prawn','gambero','gamberi'],
    gambero:['prawn','shrimp'], gamberi:['prawn','shrimp'],
    rocket:['rucola','arugula'], rucola:['rocket','arugula'], arugula:['rocket','rucola'],
    coriander:['cilantro'], cilantro:['coriander'], chilli:['chili'], chili:['chilli'],
    manzo:['beef'], beef:['manzo'], vitello:['veal'], veal:['vitello'],
    tonno:['tuna'], tuna:['tonno'], polpo:['octopus'], octopus:['polpo'],
    patate:['potato'], potato:['patate'], funghi:['mushroom'], mushroom:['funghi'],
    pollo:['chicken'], polletto:['chicken'], chicken:['pollo','polletto'],
    agnello:['lamb'], lamb:['agnello'], limone:['lemon'], lemon:['limone'],
    pomodoro:['tomato'], pomodori:['tomato'], tomato:['pomodoro','pomodori'],
    formaggio:['cheese'], cheese:['formaggio'] };
  var STOP = { of:1, the:1, and:1, a:1, al:1, alla:1, con:1, di:1, e:1, '':1 };
  // What people say around the thing they want. Dropped from the question only.
  var FILLER = { show:1, me:1, recipe:1, recipes:1, find:1, give:1, please:1, want:1, need:1,
    get:1, how:1, to:1, make:1, i:1, we:1, 'for':1, 'with':1, where:1, is:1, what:1, dish:1, dishes:1,
    open:1, go:1, screen:1, page:1 };
  function words(s) {
    return String(s).toLowerCase().replace(/\bsea\s+bass\b/g, 'seabass')
      .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(function (w) { return w && !STOP[w]; });
  }
  function asked(q) { return words(q).filter(function (w) { return !FILLER[w]; }); }
  function stem(w) { return w.length > 3 ? w.replace(/ies$/, 'y').replace(/(es|s)$/, '') : w; }
  function same(n, a) { var sn = stem(n), sa = stem(a); return sn.indexOf(sa) === 0 || (sa.indexOf(sn) === 0 && sn.length > 3); }
  function hitAt(nw, w) {
    var alts = [w].concat(SYN[w] || []);
    for (var i = 0; i < nw.length; i++) for (var j = 0; j < alts.length; j++) if (same(nw[i], alts[j])) return i;
    return -1;
  }
  function posIn(qw, txt) {
    var nw = words(txt || ''), pos = [];
    for (var i = 0; i < qw.length; i++) { var p = hitAt(nw, qw[i]); if (p < 0) return null; pos.push(p); }
    return Math.min.apply(null, pos);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // ── the recipes, read when somebody first uses the box ───────────────────
  var DATA = null, loading = null, loadErr = '', loadedAt = 0;
  var FRESH_MS = 5 * 60 * 1000;      // a dish written this morning is here by the next search
  function getAll(path) {
    // PostgREST stops at 1,000 rows and says nothing; recipe_lines passed that on 14 Sep.
    var out = [], sep = path.indexOf('?') < 0 ? '?' : '&';
    function page(off) {
      return fetch(SUPABASE_URL + '/rest/v1/' + path + sep + 'limit=1000&offset=' + off, {
        headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }, cache: 'no-store'
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (rows) {
        out = out.concat(rows || []);
        return (rows || []).length === 1000 ? page(off + 1000) : out;
      });
    }
    return page(0);
  }
  function load() {
    if (DATA && Date.now() - loadedAt < FRESH_MS) return Promise.resolve(DATA);
    if (loading) return loading;
    loading = Promise.all([
      getAll('recipes?select=id,name,kind,section,show_team&archived=is.false&order=name,id'),
      getAll('recipe_lines?select=recipe_id,child_recipe_id,stock_name,typed_text&order=id')
    ]).then(function (res) {
      var byId = {}, LINKS = {}, ING = {};
      res[0].forEach(function (r) { byId[r.id] = r; });
      res[1].forEach(function (l) {
        if (!byId[l.recipe_id]) return;                       // a line of an archived recipe
        if (l.child_recipe_id) (LINKS[l.recipe_id] = LINKS[l.recipe_id] || []).push(l.child_recipe_id);
        else { var nm = l.stock_name || l.typed_text; if (nm) (ING[l.recipe_id] = ING[l.recipe_id] || []).push(nm); }
      });
      // Only what the Recipe card itself would show the team.
      var list = res[0].filter(function (r) { return r.show_team !== false; }).map(function (r) {
        var ingr = [], seen = {};
        (function walk(id, via) {
          if (!id || seen[id] || !byId[id]) return; seen[id] = 1;
          (ING[id] || []).forEach(function (t) { ingr.push({ t: t, via: via }); });
          (LINKS[id] || []).forEach(function (c) { walk(c, (byId[c] && byId[c].name) || via); });
        })(r.id, null);
        return { id: r.id, name: r.name || '', kind: r.kind, section: r.section || '', ingr: ingr };
      });
      DATA = list; loadedAt = Date.now(); loadErr = ''; loading = null;
      return DATA;
    }).catch(function (e) { loading = null; loadErr = (e && e.message) || 'could not be read'; throw e; });
    return loading;
  }

  // ── the screens, read off the page ──────────────────────────────────────
  function screens() {
    var out = [];
    Array.prototype.forEach.call(document.querySelectorAll('#home-view .home-tile'), function (t) {
      var n = t.querySelector('.home-name'), m = t.querySelector('.home-meta');
      if (!n || t.classList.contains('disabled')) return;
      out.push({ name: n.textContent.trim(), meta: m ? m.textContent.trim() : '', go: function () { t.click(); } });
    });
    if (typeof RECIPE_SCREENS !== 'undefined' && typeof openRecipeScreen === 'function') {
      RECIPE_SCREENS.forEach(function (s) {
        out.push({ name: s.name, meta: s.meta, go: function () { openRecipeScreen(s.view); } });
      });
    }
    return out;
  }

  // ── the answer ──────────────────────────────────────────────────────────
  var MAXROWS = 6, GO = [];
  function search(q) {
    var qw = asked(q), r = { screens: [], named: [], uses: [] };
    if (!qw.length) return r;
    screens().forEach(function (s, ix) {
      var f = posIn(qw, s.name);
      if (f != null) r.screens.push({ s: s, rank: f, ix: ix });
    });
    r.screens.sort(function (a, b) { return (a.rank - b.rank) || (a.ix - b.ix); });
    (DATA || []).forEach(function (d, ix) {
      var f = posIn(qw, d.name);
      if (f != null) { r.named.push({ d: d, rank: f + (d.kind === 'main' ? 0 : 100), ix: ix }); return; }
      var got = null;
      d.ingr.forEach(function (i) {
        if (posIn(qw, i.t) == null) return;
        if (!got || (got.via && !i.via)) got = i;
      });
      if (got) r.uses.push({ d: d, why: got, rank: (d.kind === 'main' ? 0 : 100) + (got.via ? 1 : 0), ix: ix });
    });
    r.named.sort(function (a, b) { return (a.rank - b.rank) || (a.ix - b.ix); });
    r.uses.sort(function (a, b) { return (a.rank - b.rank) || (a.ix - b.ix); });
    return r;
  }
  function kindWord(d) { return d.kind === 'main' ? 'Dish' : 'Batch'; }
  function row(label, name, note, fn) {
    GO.push(fn);
    return '<button type="button" class="kfind-row" data-kfgo="' + (GO.length - 1) + '">' +
      '<span class="kfind-kind">' + esc(label) + '</span>' +
      '<span class="kfind-main"><span class="kfind-name">' + esc(name) + '</span>' +
      (note ? '<span class="kfind-note">' + esc(note) + '</span>' : '') + '</span>' +
      '<span class="kfind-go">Open &rarr;</span></button>';
  }
  // A long group folds after six and opens in place - the rest is one tap away, never
  // on another screen, and never silently cut.
  var WIDE = {};
  function group(key, title, list, each) {
    if (!list.length) return '';
    var h = '<div class="kfind-h">' + esc(title) + ' <span>' + list.length + '</span></div>';
    h += (WIDE[key] ? list : list.slice(0, MAXROWS)).map(each).join('');
    if (list.length > MAXROWS && !WIDE[key]) {
      GO.push(function () { WIDE[key] = 1; paint(); });
      h += '<button type="button" class="kfind-row kfind-more" data-kfgo="' + (GO.length - 1) + '">Show the other ' + (list.length - MAXROWS) + '</button>';
    }
    return h;
  }
  function paint() {
    var box = document.getElementById('kfind-q'), out = document.getElementById('kfind-out');
    if (!box || !out) return;
    var q = box.value, qw = asked(q);
    var clr = document.getElementById('kfind-clr'); if (clr) clr.hidden = !q;
    GO = [];
    if (!qw.length) { out.hidden = true; out.innerHTML = ''; return; }
    var r = search(q), h = '';
    h += group('s', 'Screens', r.screens, function (x) {
      return row('Screen', x.s.name, x.s.meta, x.s.go);
    });
    h += group('n', 'Recipes', r.named, function (x) {
      return row(kindWord(x.d), x.d.name, x.d.section, function () { openCard(x.d.id); });
    });
    h += group('u', 'Recipes that use it', r.uses, function (x) {
      return row(kindWord(x.d), x.d.name, 'uses ' + x.why.t + (x.why.via ? ' · in ' + x.why.via : ''), function () { openCard(x.d.id); });
    });
    if (!h) {
      if (loading && !DATA) h = '<div class="kfind-none">Reading the recipes&hellip;</div>';
      else {
        GO.push(function () { ask(q); });
        h = '<div class="kfind-none"><b>Nothing in the app matches &ldquo;' + esc(q.trim()) + '&rdquo;.</b>' +
          (loadErr && !DATA ? '<br>The recipes could not be read just now (' + esc(loadErr) + '), so only the screens were searched.'
            : '<br>No screen has that name, no dish or batch is called that, and no recipe lists it as an ingredient.') +
          '<br><button type="button" class="kfind-ask" data-kfgo="' + (GO.length - 1) + '">Ask for it &mdash; send feedback &rarr;</button></div>';
      }
    } else if (loading && !DATA) h += '<div class="kfind-tail">Reading the recipes&hellip;</div>';
    else if (loadErr && !DATA) h += '<div class="kfind-tail">The recipes could not be read just now, so only the screens were searched.</div>';
    out.innerHTML = h; out.hidden = false;
  }

  // ── opening things ──────────────────────────────────────────────────────
  function cardFrame(then) {
    if (typeof openRecipeScreen !== 'function') return;
    openRecipeScreen('recipecard-view');
    var f = document.querySelector('#recipecard-view iframe'); if (!f) return;
    var go = function () { try { then(f.contentWindow); } catch (e) {} };
    var ready = false;
    try { ready = !!(f.contentWindow && f.contentWindow.__rcpOpen); } catch (e) {}
    if (ready) go(); else f.addEventListener('load', go, { once: true });
  }
  function openCard(id) { cardFrame(function (w) { w.__rcpOpen(id); }); }
  function ask(q) {
    var t = 'I looked for "' + String(q).trim() + '" and it is not in the app. ';
    if (window.FBI && typeof window.FBI.open === 'function') window.FBI.open(t);
  }

  // ── on the page ─────────────────────────────────────────────────────────
  function mount() {
    var home = document.getElementById('home-view');
    if (!home || document.getElementById('kfind')) return;
    var st = document.createElement('style');
    st.textContent = [
      // Solid paper under everything: the home screen stands on a photograph of the
      // room (body.roomstep), and words straight on a photograph are how headings
      // here have gone invisible before.
      '#kfind{max-width:760px;margin:16px 0 20px;position:relative;z-index:2}',
      '#kfind .kfind-bar{display:flex;align-items:center;gap:8px;background:#FBF7F1;border:1.5px solid #400207;border-radius:10px;padding:4px 6px 4px 14px;box-shadow:0 2px 10px rgba(44,24,16,.18)}',
      '#kfind .kfind-ico{font:600 11px/1 Inter,system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#400207;flex:0 0 auto}',
      // 16px: anything smaller and iOS zooms the page on focus
      '#kfind-q{flex:1 1 auto;min-width:0;border:0;outline:0;background:transparent;color:#2c1810;font:400 16px/1.3 Inter,system-ui,sans-serif;padding:12px 4px}',
      '#kfind-q::placeholder{color:#6b5744;opacity:1}',
      // the browser's own little x would sit beside Clear and do the same job
      '#kfind-q::-webkit-search-cancel-button{-webkit-appearance:none;display:none}',
      '#kfind-clr{flex:0 0 auto;border:1px solid rgba(64,2,7,.35);background:#fff;color:#400207;border-radius:7px;font:600 13px/1 Inter,system-ui,sans-serif;padding:10px 12px;cursor:pointer}',
      '#kfind-out{margin-top:6px;background:#FBF7F1;border:1px solid #cfc0ad;border-radius:10px;padding:6px 8px 8px;box-shadow:0 6px 22px rgba(44,24,16,.22)}',
      '#kfind .kfind-h{font:700 10.5px/1 Inter,system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#5a3a1e;padding:12px 8px 7px}',
      '#kfind .kfind-h span{font-weight:600;color:#6b5744;letter-spacing:0}',
      '#kfind .kfind-row{display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:#fff;border:1px solid #e3d5c2;border-radius:8px;padding:10px 12px;margin-top:5px;cursor:pointer;min-height:52px;font-family:Inter,system-ui,sans-serif;color:#2c1810}',
      '#kfind .kfind-row:hover,#kfind .kfind-row:focus-visible{border-color:#400207;background:#fdf9f3}',
      '#kfind .kfind-kind{flex:0 0 54px;font:700 9.5px/1 Inter,system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#5a3a1e}',
      '#kfind .kfind-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px}',
      '#kfind .kfind-name{font:600 16px/1.25 Georgia,serif;color:#400207}',
      '#kfind .kfind-note{font:400 12.5px/1.35 Inter,system-ui,sans-serif;color:#5a4632}',
      '#kfind .kfind-go{flex:0 0 auto;font:700 10.5px/1 Inter,system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#400207;white-space:nowrap}',
      '#kfind .kfind-more{justify-content:center;font:600 13.5px/1.3 Inter,system-ui,sans-serif;color:#400207;background:#f3e9da}',
      '#kfind .kfind-tail{font:400 12.5px/1.4 Inter,system-ui,sans-serif;color:#5a4632;padding:9px 8px 2px}',
      '#kfind .kfind-none{font:400 14px/1.55 Inter,system-ui,sans-serif;color:#2c1810;padding:12px 10px 8px}',
      '#kfind .kfind-none b{color:#400207}',
      '#kfind .kfind-ask{margin-top:11px;background:#400207;color:#E8D9C7;border:0;border-radius:22px;padding:12px 18px;font:600 14px/1 Inter,system-ui,sans-serif;cursor:pointer}',
      '@media(max-width:520px){#kfind .kfind-go{display:none}#kfind .kfind-kind{flex-basis:44px}#kfind .kfind-ico{display:none}}',
      '@media print{#kfind{display:none !important}}'
    ].join('');
    document.head.appendChild(st);

    var w = document.createElement('div');
    w.id = 'kfind';
    w.innerHTML = '<div class="kfind-bar"><span class="kfind-ico" aria-hidden="true">Find</span>' +
      '<input id="kfind-q" type="search" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" ' +
        'aria-label="Find a recipe, an ingredient or a screen" placeholder="Find a recipe, an ingredient or a screen&hellip;">' +
      '<button type="button" id="kfind-clr" hidden>Clear</button></div>' +
      '<div id="kfind-out" role="region" aria-live="polite" aria-label="What was found" hidden></div>';
    var sub = home.querySelector('.home-subtitle');
    if (sub && sub.parentNode === home) home.insertBefore(w, sub.nextSibling); else home.insertBefore(w, home.firstChild);

    var box = document.getElementById('kfind-q');
    function need() { load().then(paint, paint); }
    box.addEventListener('focus', need);
    box.addEventListener('input', function () { WIDE = {}; need(); paint(); });
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { box.value = ''; WIDE = {}; paint(); }
      if (e.key === 'Enter') { var first = document.querySelector('#kfind-out [data-kfgo]'); if (first) first.click(); }
    });
    w.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-kfgo]') : null;
      if (b) { var fn = GO[+b.dataset.kfgo]; if (fn) fn(); return; }
      if (e.target.id === 'kfind-clr') { box.value = ''; WIDE = {}; paint(); box.focus(); }
    });
  }

  // The feedback sheet points here ("Use Find"), from whatever screen they are on.
  window.KFIND = {
    open: function (q) {
      try { if (typeof openHome === 'function') openHome(); } catch (e) {}
      var box = document.getElementById('kfind-q'); if (!box) return;
      box.value = q || ''; paint();
      try { box.scrollIntoView({ block: 'center' }); box.focus(); } catch (e) {}
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
