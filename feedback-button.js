// ──────────────────────────────────────────────────────────────────────────
// Roberto's — "Tell us" button.  ONE file used by BOTH apps (Kitchen + FOH).
//
// KEEP THIS FILE IDENTICAL IN BOTH REPOS, the same rule common.js carries.
// It is the only place the button, the sheet and the send exist; two copies
// would drift and one of them would quietly stop sending.
//
// ── What it is for ─────────────────────────────────────────────────────────
// Admin → Feedback is a PUSH loop: Francesco writes a round and asks. This is
// the PULL lane — the team tell him something the moment it annoys them, from
// wherever they are standing, without being asked and without a login.
//
// ── Three deliberate decisions ─────────────────────────────────────────────
// 1. NO LOGIN, EVER. The Kitchen prep screen is an open screen (THE-GOAL.md)
//    and a login here would mean the shared screens never get to speak. A name
//    is optional; anonymous is allowed on purpose, because a commis who is
//    nervous about signing it still tells you something true.
//
// 2. It writes to the FOH project from BOTH apps. Kitchen has its own Supabase
//    project, so the easy thing would be a Kitchen copy of the table — and then
//    two work lists, one of which goes unread. One inbox, one screen, one habit.
//    FOH already reads the Kitchen project (foh-core.js:30); this is that in
//    reverse. The anon key below is public by design: the table's RLS allows
//    INSERT and nothing else, so this key can post an idea and cannot read one.
//
// 3. The app fills in the context, not the person. Which app, which screen,
//    which build, which kind of device — all captured here. They write one
//    sentence instead of answering "where were you and what version", and the
//    item arrives actionable instead of starting a conversation.
//
// ── It never lies about sending ────────────────────────────────────────────
// supabase-js and fetch do not throw on a failed write, they RETURN the error
// (the trap behind three of this platform's silent-data incidents). So the
// sheet only says "sent" once PostgREST has answered 201, and says exactly what
// went wrong otherwise. On the DEV sites the write guard blocks it with a 403 —
// that is correct, and it is reported as blocked, never as sent.
//
// ── Wiring (each app, before this script loads) ────────────────────────────
//   window.FB_INBOX = {
//     app:    'kitchen' | 'foh',
//     screen: function(){ return 'Market list'; },   // optional
//     who:    function(){ return 'Nicole'; },        // optional — signed-in name
//     build:  function(){ return '2026-08-07.1'; },  // optional
//     above:  '#foh-nav'                             // optional — a fixed bottom bar to sit above
//   };
// Everything is optional except `app`. Each hook is called fresh every time the
// sheet opens, so a screen name is never a stale one from page load.
// ──────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  // The FOH project — the ONE inbox. See decision 2 above.
  var INBOX_URL = 'https://paoaivwtkzujmrgrfjuq.supabase.co/rest/v1/app_feedback_inbox';
  var SHOT_URL  = 'https://paoaivwtkzujmrgrfjuq.supabase.co/storage/v1/object/feedback-shots/';
  // A phone photo is 3–5MB. On the venue wifi mid-service that is a send that
  // appears to hang, and a button that appears to hang is a button nobody
  // presses twice — so it is shrunk HERE, on the device, before anything is
  // sent. 1600px is comfortably enough to read a screen in a photograph.
  var SHOT_MAX_PX = 1600, SHOT_QUALITY = 0.8;
  var INBOX_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBhb2Fpdnd0a3p1am1yZ3JmanVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwNzAxMzAsImV4cCI6MjA5NjY0NjEzMH0.VynG9PBeIaqRG2lkMEuzskkcB11EhR-UfO9eGYsaUxk';
  var MAX = 1500;
  var NAME_KEY = 'rb-fb-who';          // remembered, so nobody types their name twice

  function cfg() { return window.FB_INBOX || {}; }
  function callHook(name) {
    var f = cfg()[name];
    if (typeof f !== 'function') return '';
    try { return String(f() || ''); } catch (e) { return ''; }   // a broken hook must never eat the button
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // One word, and only ever a shape of device. Not a fingerprint: this exists so
  // "the buttons are off the screen" can be read as "on a phone", nothing more.
  function device() {
    var u = navigator.userAgent || '';
    if (/iPad/i.test(u) || (/Macintosh/i.test(u) && navigator.maxTouchPoints > 1)) return 'iPad';
    if (/iPhone|iPod/i.test(u)) return 'iPhone';
    if (/Android/i.test(u)) return /Mobile/i.test(u) ? 'Android phone' : 'Android tablet';
    return 'Laptop';
  }

  // The build they were running. Each app knows its own stamp; failing that, the
  // ?v= on this very script is a real version and is always there.
  function build() {
    var b = callHook('build');
    if (b) return b;
    try {
      var s = document.querySelector('script[src*="feedback-button.js"]');
      var m = s && /[?&]v=([^&]+)/.exec(s.getAttribute('src') || '');
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }

  // Where they were standing. The app's own hook first — it knows which module
  // is on screen; the document title is the honest fallback.
  function screenName() {
    return callHook('screen') || (document.title || '').slice(0, 60);
  }

  var open = false, sending = false, draft = { kind: 'problem', body: '', who: '', shot: null };

  // ── The photo ────────────────────────────────────────────────────────────
  // accept="image/*" is what makes this one tap on a phone: iOS and Android
  // both offer the camera AND the photo library from it, so they can shoot the
  // screen in front of them or attach the screenshot they already took. No
  // capture="camera" — that would FORCE the camera and lock out the screenshot,
  // which is the more common case by far.
  // The input lives IN the sheet (hidden), rather than being built on the fly and
  // clicked. Same one tap for them, but a real element in the page: assistive
  // tech can reach it, and it can be driven by anything that automates a browser.
  function pickPhoto() {
    var inp = document.getElementById('fbi-file');
    if (inp) inp.click();
  }
  function onFile(inp) {
    var f = inp && inp.files && inp.files[0];
    // Clear it, so picking the SAME file again still fires a change event —
    // otherwise a second attempt after a failed shrink silently does nothing.
    if (f) { shrink(f); inp.value = ''; }
  }

  // Down to SHOT_MAX_PX and JPEG — typically 3–5MB becomes ~300KB.
  // imageOrientation:'from-image' applies the EXIF rotation, without which a
  // photo taken holding the phone normally arrives on its side.
  async function shrink(file) {
    say('Getting the photo ready…');
    try {
      var bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      var w = bmp.width, h = bmp.height;
      var scale = Math.min(1, SHOT_MAX_PX / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
      var cv = document.createElement('canvas');
      cv.width = cw; cv.height = ch;
      cv.getContext('2d').drawImage(bmp, 0, 0, cw, ch);
      bmp.close && bmp.close();
      var blob = await new Promise(function (res) { cv.toBlob(res, 'image/jpeg', SHOT_QUALITY); });
      if (!blob) throw new Error('could not read that image');
      draft.shot = { blob: blob, url: URL.createObjectURL(blob), kb: Math.round(blob.size / 1024) };
      say('');
      paintShot();
    } catch (e) {
      // A HEIC that this browser cannot decode is the likely one. Say so plainly
      // rather than attaching nothing and letting them think it worked.
      draft.shot = null;
      paintShot();
      say('Couldn’t read that picture — try a screenshot instead.', true);
    }
    paint();
  }
  function dropPhoto() {
    if (draft.shot && draft.shot.url) URL.revokeObjectURL(draft.shot.url);
    draft.shot = null;
    paintShot(); paint();
  }
  function paintShot() {
    var box = document.getElementById('fbi-shot');
    if (!box) return;
    if (!draft.shot) {
      box.innerHTML = '<button type="button" class="fbi-photo" onclick="window.FBI.photo()">'
        + '<span style="font-size:15px;line-height:1">&#128247;</span> Add a photo</button>';
      return;
    }
    box.innerHTML = '<div style="display:flex;gap:11px;align-items:flex-start">'
      + '<img src="' + draft.shot.url + '" alt="" style="width:74px;height:74px;object-fit:cover;border-radius:9px;border:1px solid #e3d5c2">'
      + '<div style="flex:1;min-width:0">'
      +   '<div style="font-size:12.5px;color:#4a3b2a">Photo attached</div>'
      +   '<div style="font-size:11px;color:#8b7355;margin-top:2px">' + draft.shot.kb + ' KB &mdash; shrunk so it sends fast</div>'
      +   '<button type="button" class="fbi-x" style="font-size:12px;padding:4px 0;color:#8A2A1A" onclick="window.FBI.dropPhoto()">Remove</button>'
      + '</div></div>';
  }

  // Upload, and hand back the object path the row will point at. Throws on any
  // failure, because a message that CLAIMS a photo and has none is worse than
  // one that says the photo did not go.
  async function uploadShot() {
    var id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
           : String(Date.now()) + '-' + Math.round(Math.random() * 1e9);
    var path = String(cfg().app || 'app') + '/' + id + '.jpg';
    var res = await fetch(SHOT_URL + path, {
      method: 'POST',
      headers: {
        'apikey': INBOX_KEY,
        'Authorization': 'Bearer ' + INBOX_KEY,
        'Content-Type': 'image/jpeg',
        'x-upsert': 'false'
      },
      body: draft.shot.blob
    });
    if (!res.ok) {
      var t = await res.text();
      var msg = '';
      try { msg = (JSON.parse(t) || {}).message || ''; } catch (e) {}
      throw new Error(msg || ('upload failed, ' + res.status));
    }
    return path;
  }

  function lift() {
    var b = document.getElementById('fbi-btn');
    if (!b) return;
    var gap = 14, sel = cfg().above;
    if (sel) {
      try {
        var bar = document.querySelector(sel);
        if (bar && bar.offsetParent !== null) gap = 14 + bar.getBoundingClientRect().height;
      } catch (e) {}
    }
    b.style.bottom = gap + 'px';
  }

  // ── The button ───────────────────────────────────────────────────────────
  // Bottom-RIGHT on purpose: both apps put their DEV badge bottom-left, and on a
  // phone the right thumb is where a one-handed tap actually lands. Quiet enough
  // to ignore during service, present on every screen so it is never hunted for.
  function mount() {
    if (document.getElementById('fbi-btn')) return;
    var b = document.createElement('button');
    b.id = 'fbi-btn';
    b.type = 'button';
    b.setAttribute('aria-label', 'Tell us — send an idea or a problem');
    b.innerHTML = '<span style="font-size:14px;line-height:1">&#9998;</span><span class="fbi-btn-word">Tell us</span>';
    b.onclick = function () { openSheet(); };
    document.body.appendChild(b);

    // A fixed bottom nav (FOH's public surface has one) would sit ON TOP of the
    // button on exactly the screens the floor team use most. Measure it and sit
    // above it — and re-measure after any tap, because the nav appears and
    // disappears as they move between the public and manager surfaces.
    lift();
    window.addEventListener('resize', lift);
    document.addEventListener('click', function () { setTimeout(lift, 0); }, true);

    var st = document.createElement('style');
    st.textContent = [
      '#fbi-btn{position:fixed;right:14px;bottom:14px;z-index:99998;display:flex;align-items:center;gap:7px;',
      'padding:10px 15px;border-radius:24px;border:1px solid rgba(232,217,199,.35);cursor:pointer;',
      'background:#400207;color:#E8D9C7;font:600 13px/1 Inter,system-ui,-apple-system,sans-serif;',
      'box-shadow:0 3px 14px rgba(44,24,16,.28);-webkit-tap-highlight-color:transparent;}',
      '#fbi-btn:active{transform:translateY(1px)}',
      // Below 420px the word costs more than it says — the pencil is the whole
      // control on a phone, and the aria-label still names it for a screen reader.
      '@media(max-width:420px){#fbi-btn{padding:12px;border-radius:50%}.fbi-btn-word{display:none}}',
      // Anything printed is a document for someone else. The button is not part of it.
      '@media print{#fbi-btn,#fbi-wrap{display:none !important}}',
      '#fbi-wrap{position:fixed;inset:0;z-index:99999;display:flex;align-items:flex-end;justify-content:center;',
      'background:rgba(28,16,10,.45);padding:0;}',
      '@media(min-width:560px){#fbi-wrap{align-items:center;padding:20px}}',
      '#fbi-card{background:#FBF7F1;color:#2c1810;width:100%;max-width:520px;border-radius:16px 16px 0 0;',
      'padding:18px 18px calc(18px + env(safe-area-inset-bottom));max-height:92vh;overflow-y:auto;',
      'font-family:Inter,system-ui,-apple-system,sans-serif;box-shadow:0 -6px 30px rgba(44,24,16,.3);}',
      '@media(min-width:560px){#fbi-card{border-radius:16px;padding-bottom:18px}}',
      '#fbi-card textarea,#fbi-card input{width:100%;box-sizing:border-box;border:1.5px solid #e3d5c2;border-radius:9px;',
      'padding:10px 11px;font-family:inherit;font-size:16px;background:#fff;color:#2c1810;resize:vertical;}',
      // 16px above is not a style choice: anything smaller and iOS zooms the whole
      // page in on focus, and they finish typing on a page they then have to pinch back.
      '#fbi-card .fbi-seg{display:flex;border:1.5px solid #e3d5c2;border-radius:9px;overflow:hidden}',
      '#fbi-card .fbi-seg button{flex:1;border:0;padding:11px 6px;font:600 13.5px/1.2 inherit;cursor:pointer;background:#fff;color:#8b7355}',
      '#fbi-card .fbi-seg button.on{background:#400207;color:#E8D9C7}',
      '#fbi-card .fbi-go{background:#400207;color:#E8D9C7;border:0;border-radius:22px;padding:12px 24px;',
      'font:600 14px/1 inherit;cursor:pointer}',
      '#fbi-card .fbi-go:disabled{opacity:.45;cursor:not-allowed}',
      '#fbi-card .fbi-x{background:transparent;border:0;color:#9c8a72;font-size:20px;cursor:pointer;padding:2px 6px}',
      '#fbi-card .fbi-lbl{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:#9c8a72;margin:14px 0 5px}',
      '#fbi-card .fbi-photo{display:inline-flex;align-items:center;gap:8px;background:#fff;border:1.5px dashed #e3d5c2;',
      'border-radius:9px;padding:11px 15px;font:600 13.5px/1 inherit;color:#8b7355;cursor:pointer}',
      '#fbi-card .fbi-photo:active{background:#f7f2e8}',
      '#fbi-card .fbi-more{font-size:12px;color:#8b7355;line-height:1.5;margin-top:10px}',
      '#fbi-card summary{cursor:pointer;color:#9c8a72;font-size:12px;list-style:none}',
      '#fbi-card summary::-webkit-details-marker{display:none}'
    ].join('');
    document.head.appendChild(st);
  }

  // ── The sheet ────────────────────────────────────────────────────────────
  function openSheet() {
    if (open) return;
    open = true; sending = false;
    draft.body = '';
    // The photo clears with the words, not separately — a picture left over from
    // a sheet they abandoned would silently ride along on the next message.
    if (draft.shot && draft.shot.url) URL.revokeObjectURL(draft.shot.url);
    draft.shot = null;
    draft.who = draft.who || (function () { try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; } })()
                          || callHook('who');
    var w = document.createElement('div');
    w.id = 'fbi-wrap';
    w.onclick = function (e) { if (e.target === w) closeSheet(); };
    w.innerHTML = cardHTML();
    document.body.appendChild(w);
    document.addEventListener('keydown', onKey);
    var t = document.getElementById('fbi-body');
    // Straight into the box on a laptop. NOT on a phone: focusing throws the
    // keyboard up over the sheet before they have read what it is asking.
    if (t && window.innerWidth >= 560) t.focus();
    paintShot();
    paint();
  }
  function closeSheet() {
    var w = document.getElementById('fbi-wrap');
    if (w) w.parentNode.removeChild(w);
    document.removeEventListener('keydown', onKey);
    open = false;
  }
  function onKey(e) { if (e.key === 'Escape' && !sending) closeSheet(); }

  function cardHTML() {
    var sc = screenName();
    return '<div id="fbi-card" role="dialog" aria-modal="true" aria-label="Tell us">'
      + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">'
      +   '<div><div style="font:600 17px/1.25 Georgia,serif;color:#400207">Tell us</div>'
      +   '<div style="font-size:12.5px;color:#8b7355;margin-top:3px">Something in the way? An idea? Say it here &mdash; it goes straight to Francesco.</div></div>'
      +   '<button class="fbi-x" type="button" onclick="window.FBI.close()" aria-label="Close">&#10005;</button>'
      + '</div>'
      + '<div class="fbi-lbl">Which is it</div>'
      + '<div class="fbi-seg">'
      +   '<button type="button" id="fbi-k-problem" onclick="window.FBI.kind(\'problem\')">Something&rsquo;s wrong</button>'
      +   '<button type="button" id="fbi-k-idea" onclick="window.FBI.kind(\'idea\')">An idea</button>'
      + '</div>'
      + '<div class="fbi-lbl">In your own words</div>'
      + '<textarea id="fbi-body" rows="4" maxlength="' + MAX + '" placeholder="What happened, or what would help&hellip;" oninput="window.FBI.set(\'body\',this.value)"></textarea>'
      + '<div class="fbi-lbl">A photo <span style="text-transform:none;letter-spacing:0">&mdash; optional</span></div>'
      // accept="image/*" and no capture= : on a phone this offers the camera AND
      // the photo library, so they can shoot the screen in front of them or
      // attach the screenshot they already took. capture="camera" would force the
      // camera and lock out the screenshot, which is the commoner case by far.
      + '<input type="file" id="fbi-file" accept="image/*" style="display:none" onchange="window.FBI.file(this)">'
      + '<div id="fbi-shot"></div>'
      + '<div class="fbi-lbl">Your name <span style="text-transform:none;letter-spacing:0">&mdash; optional</span></div>'
      + '<input id="fbi-who" value="' + esc(draft.who) + '" placeholder="So we can come back to you" oninput="window.FBI.set(\'who\',this.value)">'
      + '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:16px">'
      +   '<button class="fbi-go" type="button" id="fbi-send" onclick="window.FBI.send()">Send</button>'
      +   '<span id="fbi-why" style="font-size:12px;color:#8b7355;flex:1;min-width:120px"></span>'
      + '</div>'
      // Folded away, because it is us explaining ourselves. What is on screen
      // stays the state of THEIR message.
      + '<details class="fbi-more"><summary>What gets sent with this</summary>'
      +   '<div style="margin-top:7px;line-height:1.55">Your words, plus the screen you were on (<b>' + esc(sc || 'this screen') + '</b>), '
      +   'which app, the version and whether you are on a phone or a laptop &mdash; so nobody has to ask you where you were. '
      +   'Nothing else about your device is sent. Leave the name blank and it arrives anonymous. '
      +   'A photo is optional, is made smaller on your phone before it is sent, and only Francesco can open it.</div>'
      + '</details>'
      + '</div>';
  }

  // ── Painting ─────────────────────────────────────────────────────────────
  // Typing must never redraw the card — it would throw them out of the box
  // mid-sentence, the same trap the Admin panel form already fixed. Only the
  // segmented control, the Send button and its reason ever repaint.
  function paint() {
    var p = document.getElementById('fbi-k-problem'), i = document.getElementById('fbi-k-idea');
    if (p) p.className = draft.kind === 'problem' ? 'on' : '';
    if (i) i.className = draft.kind === 'idea' ? 'on' : '';
    var b = document.getElementById('fbi-send'), why = document.getElementById('fbi-why');
    if (!b) return;
    var n = String(draft.body || '').trim().length;
    b.disabled = sending || n === 0;
    b.textContent = sending ? 'Sending…' : 'Send';
    // A disabled button always says why it is disabled — never just sit there dead.
    b.title = sending ? 'Sending…' : (n === 0 ? 'Write what happened first' : '');
    if (why) {
      why.style.color = '#8b7355';
      why.textContent = sending ? '' : (n === 0 ? 'Write a line first — even a short one.' : '');
    }
  }
  function say(msg, bad) {
    var why = document.getElementById('fbi-why');
    if (!why) return;
    why.style.color = bad ? '#8A2A1A' : '#2E6B34';
    why.textContent = msg;
  }

  // ── Sending ──────────────────────────────────────────────────────────────
  async function send() {
    if (sending) return;
    var body = String(draft.body || '').trim();
    if (!body) { paint(); return; }
    sending = true; paint();

    var who = String(draft.who || '').trim();
    var row = {
      app: String(cfg().app || 'unknown'),
      screen: screenName() || null,
      kind: draft.kind,
      body: body.slice(0, MAX),
      who: who || null,
      build: build() || null,
      device: device()
    };

    // ── The photo goes FIRST, and only then the message ──────────────────────
    // So a row can never point at an image that is not there. The other order
    // reads better in code and is wrong in the place it matters: the venue wifi
    // mid-service is exactly where an upload dies, and it would leave a message
    // on his screen promising a photo that never arrives.
    //
    // The cost of this order is an orphaned image if the row insert then fails.
    // That is a tidiness problem in a bucket, not a truth problem on a screen.
    //
    // On the DEV sites the write guard blocks /rest/v1/ but NOT /storage/v1/, so
    // uploading first would quietly put real files in the bucket for a message
    // that was then refused. Both apps expose their guard as a top-level const —
    // not on window, so it is reached by name, not by property.
    var devLocked = (typeof FOH_DEV_READ_ONLY !== 'undefined' && FOH_DEV_READ_ONLY)
                 || (typeof DEV_READ_ONLY !== 'undefined' && DEV_READ_ONLY);
    if (draft.shot && !devLocked) {
      try {
        row.shot = await uploadShot();
      } catch (err) {
        sending = false; paint();
        say('The photo didn’t go through — ' + String(err && err.message || err).slice(0, 60)
            + '. Try again, or remove it and send the words.', true);
        return;
      }
    }

    var res, txt = '';
    try {
      // Plain fetch on purpose: it goes through whatever window.fetch is at call
      // time, which on the DEV sites is the write guard. A send that the guard
      // blocked must read as blocked, not slip past it.
      //
      // Deliberately NO "Prefer: return=representation" — the same trap
      // foh-feedback.html documents at its own send(). Asking PostgREST to hand
      // the row back makes it READ what it just wrote, and only signed-in users
      // may read this table; for anon (the prep screen, anyone's phone) the
      // whole insert then comes back as "new row violates row-level security
      // policy" — a write that actually succeeded, reported as a failure.
      // Verified 7 Aug 2026 by pressing the button on the local preview.
      // The 201 IS the receipt: PostgREST only answers it once the row is
      // committed, so nothing here is taken on trust.
      res = await fetch(INBOX_URL, {
        method: 'POST',
        headers: {
          'apikey': INBOX_KEY,
          'Authorization': 'Bearer ' + INBOX_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(row)
      });
      txt = await res.text();
    } catch (err) {
      sending = false; paint();
      say('Not sent — no connection. Nothing is lost; press Send again.', true);
      return;
    }

    // fetch does NOT throw on 4xx/5xx. Everything below this line is the reason
    // this module exists at all: a claim of "sent" has to be earned. Anything
    // that is not a 201 is NOT sent, and it says so rather than showing them a
    // tick they would believe.
    if (res.status !== 201) {
      sending = false; paint();
      var msg = '';
      try { var j = JSON.parse(txt) || {}; msg = j.message || j.hint || ''; } catch (e) {}
      if (res.status === 403) {
        say(msg || 'Not sent — this is the dev site and writes are off here.', true);
      } else if (/app_feedback_inbox/.test(msg) && /does not exist|schema cache/i.test(msg)) {
        say('Not sent — foh-app-feedback-inbox.sql has not been run yet.', true);
      } else {
        say('Not sent — ' + (msg || ('error ' + res.status)).slice(0, 90), true);
      }
      return;
    }

    if (who) { try { localStorage.setItem(NAME_KEY, who); } catch (e) {} }
    draft.who = who;
    if (draft.shot && draft.shot.url) URL.revokeObjectURL(draft.shot.url);
    draft.shot = null;
    sending = false;
    done();
  }

  // A tick, and what happens next in plain words. No jargon, no row id, no
  // "submission received" — they told a person something, so a person answers.
  function done() {
    var c = document.getElementById('fbi-card');
    if (!c) return;
    c.innerHTML = '<div style="text-align:center;padding:22px 6px 12px">'
      + '<div style="font-size:34px;color:#2E6B34;line-height:1">&#10003;</div>'
      + '<div style="font:600 17px/1.3 Georgia,serif;color:#400207;margin-top:8px">Sent to Francesco</div>'
      + '<div style="font-size:13px;color:#8b7355;margin-top:7px;line-height:1.55">It&rsquo;s on his list now. When it&rsquo;s fixed you&rsquo;ll be told what changed '
      + 'and how to check it yourself&nbsp;&mdash; you shouldn&rsquo;t have to take our word for it.</div>'
      + '<div style="display:flex;gap:10px;justify-content:center;margin-top:18px;flex-wrap:wrap">'
      +   '<button class="fbi-go" type="button" onclick="window.FBI.again()">Send another</button>'
      +   '<button class="fbi-x" style="font-size:13px;color:#8b7355" type="button" onclick="window.FBI.close()">Done</button>'
      + '</div></div>';
  }

  // ── The one global, because both apps use inline onclick ─────────────────
  window.FBI = {
    open: openSheet,
    close: closeSheet,
    kind: function (k) { draft.kind = k; paint(); },
    set: function (f, v) { draft[f] = v; paint(); },
    send: send,
    photo: pickPhoto,
    file: onFile,
    dropPhoto: dropPhoto,
    again: function () { closeSheet(); openSheet(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
