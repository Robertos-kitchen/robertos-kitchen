// ──────────────────────────────────────────────────────────────────────────
// Recipes & menus lock — THE ONLY COPY. Load it on every page that can change
// a recipe or a menu.
//
// Asked for through "Tell us" on 25 Sep 2026 (inbox 312145d3): "block the access
// to the team to every section where is possible to modify the recipes and
// menus". So those sections now open only with the chef code:
//
//   recipe-create.html  — Create new recipes, Needs finishing, Recipe book. The
//                         whole page: every door into it can change a dish.
//                         guardPage() covers it until the code is entered.
//   tasting.html        — "put it on the upcoming menu". Scoring stays open:
//                         tasting a dish is the team's job, not a change to it.
//   food-bible.html     — putting a photograph on a dish, or taking one off.
//   menu-pdfs.html      — uploading or deleting a printed menu.
//
// READING stays open to everyone: the Recipe card, the Food Bible and the
// Current menu still open with no code, because cooking from the recipe is the
// point of having one. Nothing was removed — with the code, every screen does
// exactly what it did before.
//
// THE CHEF CODE IS 2468 (Francesco, 26 Sep 2026): the code the chefs already
// use for the schedule, stock take and portion changes, so there is one code to
// remember, not two. 1212 does not open it. Kept here as a SHA-256 hash like every
// key below. To change a key: sha256('robertos-recipe-lock:' + newCode) → CODES.
//
// ANDREA FALCONE (Development Chef, writes the recipes) opens it with their own
// employee ID (Francesco, 26 Sep 2026). A separate key, so it can be taken away
// alone — delete that line in CODES. The name shows on the "unlocked" pill.
//
// HONEST LIMIT: this is a lock on the app's screens, the same kind as the
// schedule lock — the database itself still accepts writes from the app's key
// (ARCHITECTURE.md: open RLS, security deliberately deferred). It stops the
// team changing recipes from the app; it is not protection from someone who
// sets out to get round it.
//
// Unlocking lasts for this browser tab (every recipe screen inside it shares it)
// and closes itself after IDLE_MIN minutes with nobody touching a recipe screen —
// the kitchen runs on shared screens, and a chef who walks away must not leave
// the recipes open behind him. "Lock" on the pill closes it at once.
//
// Everything is set on window by ASSIGNMENT (see dev-guard.js for why).
// ──────────────────────────────────────────────────────────────────────────
(function () {
  var CODES = {
    'bbc94fdb46b4892f886f7fa134ef7641c52bf42f484e0347932afbe337a367f3': 'Chef',
    'd299df0faa05bc94a453b9d44c1dfda9332a3f87e1e3449d47526f1e58b5aa33': 'Andrea Falcone'      // employee ID
  };
  var KEY = 'kitchen-recipe-edit-until';
  var WHO_KEY = 'kitchen-recipe-edit-who';
  var IDLE_MIN = 20;

  function now(){ return Date.now(); }
  function until(){ try { return +sessionStorage.getItem(KEY) || 0; } catch(e){ return 0; } }
  function isOpen(){ return until() > now(); }
  function setUntil(t){
    try { if (t) sessionStorage.setItem(KEY, String(t)); else sessionStorage.removeItem(KEY); } catch(e){}
  }
  function touch(){ if (isOpen()) setUntil(now() + IDLE_MIN * 60000); }

  function sha256hex(s){
    if (!(window.crypto && crypto.subtle)) return Promise.reject(new Error('no crypto'));
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)).then(function(buf){
      return Array.prototype.map.call(new Uint8Array(buf), function(b){ return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }
  function whoOpened(){ try { return sessionStorage.getItem(WHO_KEY) || ''; } catch(e){ return ''; } }
  // Resolves to the key holder's name, or '' for a wrong code.
  // A master code is checked by the database, never stored here.
  function masterName(v){
    try {
      var u = window.SB_URL, k = window.SB_KEY; v = String(v || '').trim();
      if (!u || !k || !v) return Promise.resolve('');
      return fetch(u + '/rest/v1/rpc/kitchen_master_check', { method:'POST',
        headers:{ apikey:k, Authorization:'Bearer ' + k, 'Content-Type':'application/json' },
        body: JSON.stringify({ p_code: v }) })
        .then(function(r){ return r.ok ? r.json() : ''; }).then(function(n){ return n || ''; }, function(){ return ''; });
    } catch(e){ return Promise.resolve(''); }
  }
  function checkCode(v){
    return sha256hex('robertos-recipe-lock:' + String(v || '').trim()).then(function(h){ return CODES[h] || masterName(v); });
  }

  var CSS = [
    '.rlk{position:fixed!important;inset:0!important;z-index:100040!important;margin:0!important;background:rgba(30,6,8,.55);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}',
    '.rlk.rlk-page{background:#e1d3c2}',
    '.rlk .rlkp{background:#faf4ea;border-radius:12px;max-width:440px;width:100%;max-height:calc(100vh - 32px);overflow:auto;padding:22px 22px 18px;box-shadow:0 12px 40px rgba(30,6,8,.3);box-sizing:border-box;font-family:"DM Sans",system-ui,sans-serif}',
    '.rlk h4{font-family:"Cormorant Garamond",Georgia,serif;font-size:25px;font-weight:600;color:#410207;margin:0 0 8px;line-height:1.15}',
    '.rlk p{font-size:15px;line-height:1.45;color:#4a3a2a;margin:0 0 14px}',
    '.rlk input{display:block;width:100%;box-sizing:border-box;font-family:inherit;font-size:17px;min-height:48px;border:1px solid #410207;border-radius:4px;padding:0 12px;margin:0 0 6px;background:#fff;color:#2c1810;-webkit-text-security:disc;letter-spacing:.2em}',
    '.rlk input:focus{outline:3px solid #ba9b02;outline-offset:1px}',
    '.rlk .rlkerr{font-size:13.5px;color:#8c1a14;font-weight:600;min-height:18px;margin:0 0 10px}',
    '.rlk .rlkb{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}',
    '.rlk button{min-width:110px;font-family:inherit;font-size:14px;font-weight:600;border-radius:4px;padding:0 18px;min-height:46px;cursor:pointer;border:1px solid #410207}',
    '.rlk .rlkok{background:#410207;color:#f5ede0}.rlk .rlkok:hover{background:#5e0a10}',
    '.rlk .rlkno{background:transparent;color:#410207}',
    '#rlk-pill{position:fixed;left:50%;transform:translateX(-50%);bottom:10px;z-index:99997;display:flex;align-items:center;gap:8px;background:#410207;color:#f5ede0;border-radius:18px;padding:5px 6px 5px 13px;font:600 12.5px/1.3 "DM Sans",system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25)}',
    '#rlk-pill button{background:#f5ede0;color:#410207;border:none;border-radius:14px;padding:5px 12px;min-height:30px;font:700 12px/1 "DM Sans",system-ui,sans-serif;cursor:pointer}',
    '@media print{#rlk-pill,.rlk{display:none!important}}'
  ].join('');
  function css(){
    if (document.getElementById('rlk-css')) return;
    var s = document.createElement('style'); s.id = 'rlk-css'; s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]; }); }

  // The code panel. `page` = the full-page cover (no Cancel: there is nowhere to
  // go back to inside the page — the bar above the frame is the way out).
  function panel(opts){
    css();
    var ov = document.createElement('div');
    ov.className = 'rlk' + (opts.page ? ' rlk-page' : '');
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'rlk-h');
    ov.innerHTML = '<div class="rlkp"><h4 id="rlk-h">' + esc(opts.title) + '</h4><p>' + esc(opts.body) + '</p>' +
      '<form autocomplete="off"><input type="text" style="-webkit-text-security:disc" inputmode="numeric" autocomplete="off" aria-label="Chef code" placeholder="Chef code">' +
      '<div class="rlkerr" aria-live="polite"></div><div class="rlkb">' +
      (opts.page ? '' : '<button type="button" class="rlkno">Cancel</button>') +
      '<button type="submit" class="rlkok">Unlock</button></div></form></div>';
    var inp = ov.querySelector('input'), err = ov.querySelector('.rlkerr'), f = ov.querySelector('form');
    var busy = false;
    f.onsubmit = function(e){
      e.preventDefault(); if (busy) return; busy = true;
      checkCode(inp.value).then(function(who){
        var ok = !!who;
        busy = false;
        if (!ok){ err.textContent = 'That code does not open the recipes.'; inp.value = ''; inp.focus(); return; }
        setUntil(now() + IDLE_MIN * 60000);
        try { sessionStorage.setItem(WHO_KEY, who); } catch(e){}
        opts.done(true);
        try { window.dispatchEvent(new Event('recipelock-open')); } catch(e){}
      }, function(){
        busy = false;
        err.textContent = 'This browser cannot check the code. Open the app over https.';
      });
    };
    var no = ov.querySelector('.rlkno');
    if (no) no.onclick = function(){ opts.done(false); };
    if (!opts.page) ov.addEventListener('keydown', function(e){ if (e.key === 'Escape') opts.done(false); });
    document.body.appendChild(ov);
    setTimeout(function(){ try { inp.focus(); } catch(e){} }, 30);
    return ov;
  }

  // Ask once before one change. Resolves true when it may go ahead.
  function ask(what){
    if (isOpen()){ touch(); return Promise.resolve(true); }
    return new Promise(function(resolve){
      var ov = panel({
        title: 'Chef code',
        body: (what ? what + ' ' : '') + 'Changing recipes and menus is for the head chef. Enter the chef code to go on.',
        done: function(ok){ ov.remove(); pill(); resolve(ok); }
      });
    });
  }

  // The small "unlocked" pill, on any page that loads this file while it is open.
  function pill(){
    var p = document.getElementById('rlk-pill');
    if (!isOpen()){ if (p) p.remove(); return; }
    if (p || !document.body) return;
    css();
    p = document.createElement('div'); p.id = 'rlk-pill';
    var who = whoOpened();
    p.innerHTML = '<span>&#128275; Recipes unlocked' + (who && who !== 'Chef' ? ' · ' + esc(who) : '') + '</span><button type="button">Lock</button>';
    p.querySelector('button').onclick = function(){ lockNow(); };
    document.body.appendChild(p);
  }

  var cover = null, guarded = false;
  function setInert(on){
    Array.prototype.forEach.call(document.body.children, function(el){
      if (el === cover || el.id === 'devbadge') return;
      if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert');
    });
  }
  function showCover(){
    if (cover || isOpen()) return;
    cover = panel({
      page: true,
      title: 'Recipes are locked',
      body: 'Writing and changing recipes and menus is for the head chef. To read a recipe, use Recipe card or Food Bible — they stay open to everyone.',
      done: function(){ hideCover(); }
    });
    setInert(true);
  }
  function hideCover(){
    if (!cover) return;
    cover.remove(); cover = null; setInert(false); pill();
  }
  function refresh(){
    if (guarded){ if (isOpen()) hideCover(); else showCover(); }
    pill();
  }
  // Covers the whole page until the code is entered, and again once it lapses.
  function guardPage(){
    guarded = true;
    if (document.body) refresh(); else document.addEventListener('DOMContentLoaded', refresh);
  }
  function lockNow(){ setUntil(0); try { sessionStorage.removeItem(WHO_KEY); } catch(e){} refresh(); }

  // Working on a recipe keeps it open; the idle clock only runs while nobody is.
  ['pointerdown', 'keydown'].forEach(function(t){
    document.addEventListener(t, function(e){ if (!cover || !cover.contains(e.target)) touch(); }, true);
  });
  // Every recipe screen is its own frame in the same tab: unlocking or locking in
  // one reaches the others through the storage event, and the clock through this.
  window.addEventListener('storage', function(e){ if (!e.key || e.key === KEY) refresh(); });
  setInterval(refresh, 15000);
  document.addEventListener('DOMContentLoaded', pill);

  window.RecipeLock = { isOpen: isOpen, ask: ask, guardPage: guardPage, lockNow: lockNow };
})();
