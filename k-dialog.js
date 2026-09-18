// ──────────────────────────────────────────────────────────────────────────
// The app's own dialogs — THE ONLY COPY. Never the browser's grey pop-up.
//
// Francesco, 18 Sep 2026: the white Chrome box headed "guarracinofamily.github.io
// says" looks amateur on a Roberto's screen. Every confirm() / prompt() / alert()
// in the Kitchen app now goes through here, in the same cream-and-burgundy panel
// the Interviews module uses (ivsAsk).
//
//   await kAsk({ title, body, ok, cancel, danger })        -> true / false
//   await kAskText({ title, body, value, placeholder,
//                    ok, cancel, secret, numeric, check })  -> string / null
//   kNotice(msg | { title, body, ok })                      -> Promise (resolves on OK)
//
// A plain string is split on its first blank line: the part before is the
// heading, the rest the body — so old confirm() wording drops straight in.
// check(v) may return an error string: it shows under the box and the panel
// stays open (a wrong PIN no longer throws a second pop-up).
//
// window.alert is pointed at kNotice, so a missed or future alert() still comes
// up branded. confirm()/prompt() cannot be replaced that way (they block and
// return a value) — every call site awaits kAsk / kAskText instead.
//
// Everything is set on window by ASSIGNMENT (see dev-guard.js for why).
// ──────────────────────────────────────────────────────────────────────────
(function () {
  var CSS = [
    // !important: index.html's `body.roomstep > *{position:relative}` outranks a bare class
    // and dropped the panel into the page flow, half off-screen (seen 18 Sep 2026)
    '.kdlg{position:fixed!important;inset:0!important;z-index:100000!important;margin:0!important;background:rgba(30,6,8,.55);display:flex;align-items:center;justify-content:center;padding:16px;font-family:"DM Sans",system-ui,sans-serif;-webkit-text-size-adjust:100%}',
    '.kdlg .kdp{background:#faf4ea;border-radius:12px;max-width:440px;width:100%;max-height:calc(100vh - 32px);overflow:auto;padding:22px 22px 18px;box-shadow:0 24px 60px -20px rgba(20,4,4,.9);color:#2a1a10;text-align:left}',
    '.kdlg h4{font-family:"Cormorant Garamond",Georgia,serif;font-size:25px;font-weight:600;color:#410207;margin:0 0 8px;line-height:1.15;letter-spacing:0;text-transform:none;white-space:pre-line}',
    '.kdlg p{font-size:15px;line-height:1.45;color:#4a3a2a;margin:0 0 16px;white-space:pre-line}',
    '.kdlg input{display:block;width:100%;box-sizing:border-box;font-family:"DM Sans",system-ui,sans-serif;font-size:17px;min-height:48px;border:1px solid #410207;border-radius:4px;padding:0 12px;color:#2a1a10;background:#fff;margin:0 0 6px}',
    '.kdlg input:focus{outline:3px solid #ba9b02;outline-offset:1px}',
    '.kdlg input.kdsec{-webkit-text-security:disc;letter-spacing:.2em}',
    '.kdlg .kderr{font-size:13.5px;color:#8c1a14;font-weight:600;min-height:18px;margin:0 0 10px}',
    '.kdlg .kdb{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:4px}',
    '.kdlg .kdb button{min-width:110px;font-family:"DM Sans",system-ui,sans-serif;font-size:14px;font-weight:600;border-radius:4px;padding:0 18px;min-height:46px;cursor:pointer;border:1px solid #410207}',
    '.kdlg .kdok{background:#410207;color:#f5ede0}.kdlg .kdok:hover{background:#5e0a10}',
    '.kdlg .kdok.danger{background:#8c1a14;border-color:#8c1a14}.kdlg .kdok.danger:hover{background:#6e120d}',
    '.kdlg .kdno{background:#fff;color:#410207}.kdlg .kdno:hover{background:#ede5d8}',
    '.kdlg button:focus-visible{outline:3px solid #ba9b02;outline-offset:2px}'
  ].join('\n');

  function css() {
    if (document.getElementById('kdlg-css')) return;
    var s = document.createElement('style'); s.id = 'kdlg-css'; s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // 'Heading\n\nbody…' -> { title, body }. A single line is all heading.
  function split(o) {
    if (o && typeof o === 'object') return o;
    var t = String(o == null ? '' : o), i = t.indexOf('\n\n');
    return i < 0 ? { title: t } : { title: t.slice(0, i), body: t.slice(i + 2) };
  }
  function whenBody(fn) {
    if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn);
  }

  // kind: 'ask' | 'text' | 'notice'
  function open(kind, o, extra) {
    o = split(o);
    if (extra) { var m = {}; for (var k in o) m[k] = o[k]; for (var j in extra) m[j] = extra[j]; o = m; }
    return new Promise(function (done) {
      whenBody(function () {
        css();
        var w = document.createElement('div'); w.className = 'kdlg';
        var hasCancel = kind !== 'notice';
        w.innerHTML = '<div class="kdp" role="' + (kind === 'text' ? 'dialog' : 'alertdialog') + '" aria-modal="true">' +
          '<h4>' + esc(o.title) + '</h4>' + (o.body ? '<p>' + esc(o.body) + '</p>' : '') +
          (kind === 'text' ? '<input type="text" autocomplete="off" autocapitalize="off" spellcheck="false"' +
            (o.numeric ? ' inputmode="numeric"' : '') + (o.secret ? ' class="kdsec"' : '') +
            ' placeholder="' + esc(o.placeholder || '') + '"><div class="kderr" aria-live="polite"></div>' : '') +
          '<div class="kdb">' +
          (hasCancel ? '<button type="button" class="kdno" data-a="0">' + esc(o.cancel || 'Cancel') + '</button>' : '') +
          '<button type="button" class="kdok' + (o.danger ? ' danger' : '') + '" data-a="1">' + esc(o.ok || 'OK') + '</button>' +
          '</div></div>';
        var inp = w.querySelector('input'), err = w.querySelector('.kderr');
        if (inp && o.value != null) inp.value = String(o.value);
        var close = function (v) { document.removeEventListener('keydown', key, true); w.remove(); done(v); };
        var submit = function () {
          if (kind === 'notice') return close(undefined);
          if (kind === 'ask') return close(true);
          var v = inp.value;
          var msg = typeof o.check === 'function' ? o.check(v) : '';
          if (msg) { err.textContent = msg; inp.select(); inp.focus(); return; }
          close(v);
        };
        var cancel = function () { close(kind === 'ask' ? false : kind === 'text' ? null : undefined); };
        var key = function (e) {
          if (!document.body.contains(w)) return;
          // only the top-most dialog answers the keyboard
          var all = document.querySelectorAll('.kdlg'); if (all[all.length - 1] !== w) return;
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
          else if (e.key === 'Enter' && inp && e.target === inp) { e.preventDefault(); e.stopPropagation(); submit(); }
        };
        w.addEventListener('click', function (e) {
          var b = e.target.closest && e.target.closest('button[data-a]');
          if (b) { if (b.getAttribute('data-a') === '1') submit(); else cancel(); }
          else if (e.target === w && hasCancel) cancel();
        });
        if (inp) inp.addEventListener('input', function () { if (err) err.textContent = ''; });
        document.addEventListener('keydown', key, true);
        document.body.appendChild(w);
        if (inp) { inp.focus(); inp.select(); }
        else {
          // a destructive ask starts on Cancel, so a stray Enter never deletes anything
          var first = w.querySelector('button[data-a="' + (o.danger ? '0' : '1') + '"]');
          if (first) first.focus();
        }
      });
    });
  }

  window.kAsk = function (o, extra) { return open('ask', o, extra); };
  window.kAskText = function (o) { return open('text', o); };
  window.kNotice = function (o) { return open('notice', o); };
  window.alert = function (m) { window.kNotice(m); };
})();
