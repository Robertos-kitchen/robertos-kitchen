// k-frame.js — the header card for the Kitchen screens that had none, and the footer fix (7 Oct 2026).
//
// Francesco approved the Kitchen Maintenance header card for Learning, Training, Tasting and the
// Closing report. Lesson of the same day (the FOH frame broke Reservations on LIVE when it
// forced a column width): THIS FILE NEVER CHANGES A WIDTH. The card is put inside each screen's own
// column and takes that column's width; the only other change is hiding a heading that repeats the
// card word for word. Nothing can get wider. Checked on real data at 1440, 820 and 390 before release.
//
// Also: on short screens the footer strip sat halfway up the page; the page is now a column and the
// footer takes the space left, so it sits at the bottom.
(function(){
  var page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  // [where the card goes, kicker, title, line]
  var CARD = {
    'learning.html': ['#root',            'Kitchen · Learning',       'Learning',       'Questions on our dishes and our kitchen. Sign in with your employee ID to start.'],
    'tasting.html':  ['#root',            'Recipes · Tasting',        'Tasting',        'Score the dishes waiting for the à la carte. Chef Francesco approves, and the dish moves onto the menu.'],
    'closing-view':  ['#closing-view .cr-wrap', 'Kitchen · Closing report', 'Closing Report', 'Tonight’s service, revenue, complaints and 86s, sent to the chefs by email.']
    // NOT the Team survey: its heading changes language with the reader and carries the hidden admin
    // tap-corner that opens the results — hiding it would remove that.
  };
  var css =
    '.kf-hero{background:#410207;color:#fff;border-radius:8px;padding:26px 22px 22px;margin:0 0 16px;position:relative;overflow:hidden;box-sizing:border-box;font-family:"DM Sans",-apple-system,"Segoe UI",Roboto,sans-serif;text-align:left}' +
    '.kf-hero::after{content:"";position:absolute;right:-70px;top:-70px;width:260px;height:260px;border-radius:50%;border:1px solid rgba(201,168,76,.2);pointer-events:none}' +
    '.kf-k{font-size:10.5px;letter-spacing:.26em;text-transform:uppercase;color:#e9d58a;font-weight:700}' +
    '.kf-t{font-family:"Cormorant Garamond",Georgia,serif;font-size:30px;line-height:1.15;margin-top:8px;font-weight:500}' +
    '.kf-s{font-size:13.5px;color:rgba(255,255,255,.9);margin-top:8px;max-width:600px;line-height:1.5}' +
    '@media (max-width:700px){.kf-hero{padding:20px 16px 16px}.kf-t{font-size:26px}}';
  if (page === 'learning.html' || page === 'tasting.html') css += '#root>.kf-hero{margin-bottom:0}';   // these pages space items with a grid gap already
  if (page === 'training.html') {
    // Training's own header carries the signed-in name and "Not you?": it becomes the card, same width.
    css += '#root .bar{border-radius:8px;padding:26px 22px 22px;position:relative;overflow:hidden;margin-top:16px}' +
           '#root .bar::after{content:"";position:absolute;right:-70px;top:-70px;width:260px;height:260px;border-radius:50%;border:1px solid rgba(201,168,76,.2);pointer-events:none}' +
           '#root .bar .bt::before{content:"Kitchen · Training";display:block;font-size:10.5px;letter-spacing:.26em;text-transform:uppercase;color:#e9d58a;font-weight:700;margin-bottom:8px;font-family:"DM Sans",sans-serif}' +
           '#root .bar .t{font-size:30px;font-weight:500}#root .bar .s{font-size:13.5px;margin-top:8px;opacity:.9}#root .bar .me{position:relative;z-index:1}' +
           '@media (max-width:700px){#root .bar{padding:20px 16px 16px;margin:12px 12px 0}#root .bar .t{font-size:26px}}';
  }
  if (page === 'index.html' || page === 'kview.html' || page === '') {
    css += 'body{display:flex;flex-direction:column}body>.footer-bar{margin-top:auto}';
  }
  var st = document.createElement('style'); st.id = 'k-frame-css'; st.textContent = css;
  (document.head || document.documentElement).appendChild(st);

  function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function frame(sel, c){
    var box = document.querySelector(sel); if (!box) return;
    var kids = [].filter.call(box.children, function(e){ return e.tagName !== 'STYLE' && e.tagName !== 'SCRIPT'; });
    if (!kids.length) return;
    if (!kids[0].classList.contains('kf-hero')) {
      var old = box.querySelector(':scope > .kf-hero'); if (old) old.remove();
      var h = document.createElement('div'); h.className = 'kf-hero';
      h.innerHTML = '<div class="kf-k">' + esc(c[1]) + '</div><div class="kf-t">' + esc(c[2]) + '</div><div class="kf-s">' + esc(c[3]) + '</div>';
      box.insertBefore(h, kids[0]);
    }
    // hide a heading that only repeats the card's title (and a wrapper it leaves empty)
    [].forEach.call(box.querySelectorAll('h1,h2,.ops-title'), function(e){
      if (e.closest('.kf-hero') || e.textContent.trim() !== c[2]) return;
      e.style.display = 'none';
      var w = e.parentNode;
      if (w && w !== box && ![].some.call(w.children, function(x){ return x.style.display !== 'none'; })) w.style.display = 'none';
    });
  }
  function watch(key){
    var c = CARD[key], sel = c[0];
    // watch the view (or the frame page's root): its content is redrawn, the card is put back
    var host = document.querySelector(sel.split(' ')[0]);
    if (!host) return;
    new MutationObserver(function(){ frame(sel, c); }).observe(host, { childList:true, subtree: sel.indexOf(' ') > 0 });
    frame(sel, c);
  }
  function start(){
    if (CARD[page]) watch(page);
    else if (page !== 'training.html') ['closing-view'].forEach(watch);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
