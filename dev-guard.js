// ──────────────────────────────────────────────────────────────────────────
// DEV-site write protection — THE ONLY COPY. Load this FIRST, everywhere.
//
// The SAME files serve DEV (robertos-kitchen.github.io) and LIVE
// (guarracinofamily.github.io) against ONE production database, so testing on
// the dev site was silently writing to the real roster. On the dev host every
// database write AND every real email is blocked in the browser (403 before it
// leaves the device) unless deliberately unlocked via the DEV badge (schedule
// PIN). localhost (the local preview) stays writable.
//
// WHY THIS IS ITS OWN FILE (7 Aug 2026): this code used to be pasted into the
// top of app.js AND into recipe-create.html. app.js got the Edge-Function
// blocklist; recipe-create.html never did, so the Recipes screen still let a
// real Stock Take email out from the dev site. Two copies of a safety guard
// means one of them is always the old one. There is now one copy — add a new
// Edge Function to MUTATING_FUNCTIONS below and every screen is covered.
//
// MUST run BEFORE supabase.createClient() — supabase-js captures window.fetch
// when the client is created, so a later override never reaches it.
//
// Everything here is set on `window` by ASSIGNMENT, never `const`/`var`. A
// top-level `const IS_DEV_HOST` in another script file would collide with a
// declaration here and throw "Identifier has already been declared", killing
// the whole page. Assignment cannot collide.
// ──────────────────────────────────────────────────────────────────────────
(function () {
  window.IS_DEV_HOST = location.hostname === 'robertos-kitchen.github.io';
  window.DEV_READ_ONLY = window.IS_DEV_HOST && localStorage.getItem('kitchen-dev-writes') !== '1';

  var DEV_UNLOCK_PIN = '2468';   // same as SCHED_PIN — kept here so this file stands alone

  // Edge Functions that write to the database or send a REAL email when called.
  // The /rest/v1/ block below never sees them: they are a different URL path,
  // and several are plain fetch() calls that never touch the supabase client.
  // Anything NOT listed here is treated as a harmless read.
  var MUTATING_FUNCTIONS = [
    'cosec-sync',            // upserts attendance + cosec_sync_state
    'kitchen-guard',         // inserts team_survey, updates clock-outs
    'send-roster',           // emails the roster to the team
    'send-stock-take',       // emails the stock take to the cost controller + team
    'send-market-order',     // emails the market order to the chefs
    'send-closing-report',   // emails the closing report
    'survey-assistant'       // paid AI proxy — not a write, but a real cost per call
  ];

  // sevenrooms-sync is BOTH: ?upcoming= / ?floorplan= / ?coverflow= are
  // read-only reads the live dashboard needs on dev; any other shape upserts
  // covers and must be blocked.
  var SR_READ_ONLY_PARAMS = ['?upcoming=', '?floorplan=', '?coverflow=', '?covers_actual='];

  function isMutatingFunctionCall(urlStr) {
    if (urlStr.indexOf('/functions/v1/') === -1) return false;
    for (var i = 0; i < MUTATING_FUNCTIONS.length; i++) {
      if (urlStr.indexOf('/functions/v1/' + MUTATING_FUNCTIONS[i]) !== -1) return true;
    }
    if (urlStr.indexOf('/functions/v1/sevenrooms-sync') !== -1) {
      for (var j = 0; j < SR_READ_ONLY_PARAMS.length; j++) {
        if (urlStr.indexOf(SR_READ_ONLY_PARAMS[j]) !== -1) return false;
      }
      return true;
    }
    return false;
  }
  window.isMutatingFunctionCall = isMutatingFunctionCall;

  if (window.DEV_READ_ONLY) {
    var _realFetch = window.fetch.bind(window);
    window.fetch = function (url, opts) {
      var method = ((opts && opts.method) || 'GET').toUpperCase();
      var urlStr = String(url);
      var blocked = (method !== 'GET' && method !== 'HEAD' && urlStr.indexOf('/rest/v1/') !== -1) ||
                    isMutatingFunctionCall(urlStr);
      if (blocked) {
        console.warn('[DEV read-only] blocked ' + method + ' ' + urlStr);
        return Promise.resolve(new Response(
          JSON.stringify({
            ok: false,
            error: 'DEV site is read-only',
            message: 'The DEV site is read-only — nothing was saved and no email was sent. ' +
                     'Tap the DEV badge (bottom-left) and enter the schedule PIN to allow test writes.'
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }));
      }
      return _realFetch(url, opts);
    };
  }

  // DEV badge: shows on the dev site only. Tap it to unlock test writes
  // (schedule PIN) or to lock them again; the choice sticks per browser.
  if (window.IS_DEV_HOST) {
    var mount = function () {
      if (document.getElementById('devbadge')) return;
      var b = document.createElement('div');
      b.id = 'devbadge';
      b.textContent = window.DEV_READ_ONLY ? 'DEV · read-only' : 'DEV · WRITES ON';
      b.style.cssText = 'position:fixed;bottom:8px;left:8px;z-index:99999;padding:5px 12px;border-radius:14px;' +
        'font:700 11px/1.3 Inter,system-ui,sans-serif;letter-spacing:.4px;cursor:pointer;color:#fff;' +
        'box-shadow:0 2px 8px rgba(0,0,0,.25);background:' + (window.DEV_READ_ONLY ? '#6B1F2A' : '#B00020');
      b.onclick = function () {
        if (window.DEV_READ_ONLY) {
          var p = prompt('DEV site is read-only.\nEnter the schedule PIN to enable TEST WRITES (and real emails) against the production database:');
          if (p === null) return;
          if (p.trim() !== DEV_UNLOCK_PIN) { alert('Wrong PIN.'); return; }
          localStorage.setItem('kitchen-dev-writes', '1');
        } else {
          localStorage.removeItem('kitchen-dev-writes');
        }
        location.reload();
      };
      document.body.appendChild(b);
    };
    if (document.body) mount();
    else window.addEventListener('DOMContentLoaded', mount);
  }
})();
