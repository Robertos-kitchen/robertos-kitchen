/* Kitchen Design — access gate and storage layer.
 *
 * Only three people may open or change Kitchen Design (Chef Francesco, Andrea Sacchi,
 * Andrea Falcone). The rule lives in the database: the tables kd_projects and kd_docs
 * cannot be touched with the public key at all. Every read and write goes through a
 * kd_* function that first asks kd_who(code). This file asks for the code, keeps it for
 * the tab (sessionStorage, gone when the tab closes) and passes it on every call.
 *
 * The planner page was written against a small document-store API (doc / collection /
 * get / set / update / delete / orderBy / limit / onSnapshot) plus helpers (user,
 * downloads). window.claude below provides exactly that, so the planner runs unchanged.
 *
 * Load order on a page: dev-guard.js, supabase-js, THIS FILE, then the page's own code.
 */
(function () {
  var SUPABASE_URL = 'https://zrpglswalgjbtghudmhu.supabase.co';
  var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpycGdsc3dhbGdqYnRnaHVkbWh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5MTIyMjQsImV4cCI6MjA5NjQ4ODIyNH0.pfABN-so4xINK7nHxXUlVeTO4g0h0l6ILHVwpoKrbds';
  var GLOBAL = '00000000-0000-0000-0000-000000000000';   // the shared equipment bank
  var qs = new URLSearchParams(location.search);
  var PROJECT = qs.get('p') || 'a0000000-0000-4000-8000-000000000001';
  window.KD_PROJECT = PROJECT;
  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  var POLL_MS = 6000;
  var CODE = '', WHO = '', waiting = null;

  function err(e) { var x = new Error((e && e.message) || 'storage error'); x.code = (e && (e.code || e.status)) || 'error'; return x; }
  function noAccess(e) { return e && /no_access/.test(String(e.message || '')); }

  /* ---------- the gate ---------- */
  function check(code) {
    return sb.rpc('kd_check', { p_code: code }).then(function (r) { return r.error ? '' : (r.data || ''); }, function () { return ''; });
  }
  function overlay(msg) {
    var o = document.getElementById('kdGate');
    if (!o) {
      o = document.createElement('div'); o.id = 'kdGate';
      o.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#efe7db;display:flex;align-items:center;justify-content:center;padding:16px;font-family:"DM Sans",-apple-system,"Segoe UI",Roboto,sans-serif;color:#2a1a10';
      o.innerHTML = '<div style="background:#fffaf2;border:1px solid #dccdb9;border-radius:14px;max-width:380px;width:100%;padding:22px 20px;box-shadow:0 8px 30px rgba(65,2,7,.12)">' +
        '<div style="font:600 26px Georgia,serif;color:#410207;margin:0 0 6px">Kitchen Design</div>' +
        '<p style="margin:0 0 14px;color:#5f4c3d;font-size:15px">This area is private. Enter your code to open it.</p>' +
        '<input id="kdCode" type="text" inputmode="numeric" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Your code" ' +
        'style="width:100%;min-height:48px;padding:8px 12px;font-size:20px;letter-spacing:.2em;border:1px solid #dccdb9;border-radius:10px;-webkit-text-security:disc">' +
        '<div id="kdGateMsg" style="min-height:22px;margin:8px 0;font-size:14px;color:#8f1d12"></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap"><button id="kdGo" style="min-height:46px;padding:0 20px;border-radius:10px;border:1px solid #410207;background:#410207;color:#f5ede0;font-weight:600;font-size:16px;cursor:pointer">Open</button>' +
        '<a href="index.html" style="min-height:46px;padding:0 16px;border-radius:10px;border:1px solid #410207;color:#410207;font-weight:600;font-size:15px;text-decoration:none;display:inline-flex;align-items:center">Back to the kitchen</a></div></div>';
      document.body.appendChild(o);
    }
    document.getElementById('kdGateMsg').textContent = msg || '';
    return o;
  }
  function ask(msg) {
    if (waiting) return waiting;
    waiting = new Promise(function (ok) {
      var o = overlay(msg), inp = document.getElementById('kdCode'), go = document.getElementById('kdGo');
      setTimeout(function () { try { inp.focus(); } catch (e) {} }, 50);
      function submit() {
        var c = (inp.value || '').trim(); if (!c) return;
        go.disabled = true; document.getElementById('kdGateMsg').textContent = 'Checking…';
        check(c).then(function (who) {
          go.disabled = false;
          if (!who) { document.getElementById('kdGateMsg').textContent = 'That code is not recognised.'; inp.value = ''; inp.focus(); return; }
          CODE = c; WHO = who;
          try { sessionStorage.setItem('kd_code', c); localStorage.setItem('kd_name', who); if (!localStorage.getItem('mk_ovname')) localStorage.setItem('mk_ovname', who); } catch (e) {}
          o.remove(); waiting = null; ok(c);
        });
      }
      go.onclick = submit; inp.onkeydown = function (e) { if (e.key === 'Enter') submit(); };
    });
    return waiting;
  }
  function ensure() {
    if (CODE) return Promise.resolve(CODE);
    var saved = ''; try { saved = sessionStorage.getItem('kd_code') || ''; } catch (e) {}
    if (!saved) return ask('');
    return check(saved).then(function (who) {
      if (who) { CODE = saved; WHO = who; return CODE; }
      try { sessionStorage.removeItem('kd_code'); } catch (e) {}
      return ask('');
    });
  }
  /* one call, with the code; if the database says no access, ask again and retry once */
  function rpc(name, args) {
    return ensure().then(function (code) {
      return sb.rpc(name, Object.assign({ p_code: code }, args)).then(function (r) {
        if (r.error && noAccess(r.error)) {
          CODE = ''; try { sessionStorage.removeItem('kd_code'); } catch (e) {}
          return ask('Your code is no longer valid. Enter it again.').then(function (c2) { return sb.rpc(name, Object.assign({ p_code: c2 }, args)); });
        }
        return r;
      });
    });
  }
  window.KD = { ensure: ensure, rpc: rpc, who: function () { return WHO; } };

  /* ---------- the document store the planner expects ---------- */
  function scope(coll) { return coll === 'equipment' ? GLOBAL : PROJECT; }
  function snapDoc(id, row) { return { id: id, exists: !!row, data: function () { return row ? row.data : undefined; }, metadata: { fromCache: false } }; }
  function snapList(rows) { return { docs: rows.map(function (r) { return { id: r.doc_id, data: function () { return r.data; } }; }), metadata: { fromCache: false } }; }
  function poll(read, cb, ecb) {
    var last = null, stopped = false, timer = null;
    function tick() {
      if (stopped) return;
      read().then(function (res) {
        var key = JSON.stringify(res.key);
        if (key !== last) { last = key; try { cb(res.snap); } catch (e) { console.error(e); } }
      }).catch(function (e) { if (ecb) ecb(err(e)); }).then(function () { if (!stopped) timer = setTimeout(tick, document.hidden ? POLL_MS * 5 : POLL_MS); });
    }
    tick();
    return function () { stopped = true; if (timer) clearTimeout(timer); };
  }

  function DocRef(coll, id) { this.coll = coll; this.id = id; }
  DocRef.prototype._read = function () {
    var self = this;
    return rpc('kd_doc_get', { p_project: scope(self.coll), p_coll: self.coll, p_id: self.id }).then(function (r) {
      if (r.error) throw r.error;
      var v = r.data; return { row: v ? { data: v.data, doc_id: self.id } : null, at: v ? v.at : null };
    });
  };
  DocRef.prototype.get = function () { var self = this; return this._read().then(function (x) { return snapDoc(self.id, x.row); }); };
  DocRef.prototype.set = function (data) {
    return rpc('kd_doc_put', { p_project: scope(this.coll), p_coll: this.coll, p_id: this.id, p_data: data }).then(function (r) { if (r.error) throw err(r.error); });
  };
  DocRef.prototype.update = function (patch) {
    var self = this;
    return this._read().then(function (x) { return new DocRef(self.coll, self.id).set(Object.assign({}, x.row ? x.row.data : {}, patch)); });
  };
  DocRef.prototype.delete = function () {
    return rpc('kd_doc_del', { p_project: scope(this.coll), p_coll: this.coll, p_id: this.id }).then(function (r) { if (r.error) throw err(r.error); });
  };
  DocRef.prototype.onSnapshot = function (cb, ecb) {
    var self = this;
    return poll(function () { return self._read().then(function (x) { return { key: [x.at], snap: snapDoc(self.id, x.row) }; }); }, cb, ecb);
  };

  function Query(coll, order, lim) { this.coll = coll; this._order = order || null; this._lim = lim || null; }
  Query.prototype.orderBy = function (field, dir) { return new Query(this.coll, { field: field, dir: dir || 'asc' }, this._lim); };
  Query.prototype.limit = function (n) { return new Query(this.coll, this._order, n); };
  Query.prototype._rows = function () {
    var self = this;
    return rpc('kd_doc_list', { p_project: scope(self.coll), p_coll: self.coll }).then(function (r) {
      if (r.error) throw r.error;
      var rows = (r.data || []).slice();
      if (self._order) {
        var f = self._order.field, d = self._order.dir === 'desc' ? -1 : 1;
        rows.sort(function (a, b) { var x = a.data && a.data[f], y = b.data && b.data[f]; return x === y ? 0 : (x > y ? 1 : -1) * d; });
      }
      if (self._lim) rows = rows.slice(0, self._lim);
      return rows;
    });
  };
  Query.prototype.get = function () { return this._rows().then(snapList); };
  Query.prototype.onSnapshot = function (cb, ecb) {
    var self = this;
    return poll(function () { return self._rows().then(function (rows) { return { key: rows.map(function (r) { return [r.doc_id, r.updated_at]; }), snap: snapList(rows) }; }); }, cb, ecb);
  };
  function Collection(coll) { Query.call(this, coll); }
  Collection.prototype = Object.create(Query.prototype);
  Collection.prototype.doc = function (id) { return new DocRef(this.coll, id); };

  var db = {
    doc: function (path) { var p = String(path).split('/'); return new DocRef(p[0], p.slice(1).join('/')); },
    collection: function (coll) { return new Collection(coll); }
  };

  var user = {
    id: function () { return Promise.resolve('kitchen'); },
    me: function () { return Promise.resolve({ id: 'kitchen:' + (WHO || 'team'), name: WHO || 'Kitchen team' }); },
    isOwner: function () { return true; }, canEdit: function () { return true; },
    can: function () { return Promise.resolve(true); },
    profiles: function (ids) { var o = {}; (ids || []).forEach(function (i) { o[i] = { name: String(i).replace(/^kitchen:/, '') || 'Kitchen team' }; }); return Promise.resolve(o); },
    search: function () { return Promise.resolve([]); }
  };

  var downloads = {
    save: function (o) {
      return new Promise(function (ok, no) {
        try {
          var blob = o.data instanceof Blob ? o.data : new Blob([o.data], { type: 'application/octet-stream' });
          var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = o.filename;
          document.body.appendChild(a); a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000); ok();
        } catch (e) { no({ code: 'unavailable', message: String(e) }); }
      });
    }
  };

  /* the planner asks for db first: nothing loads until a valid code has been given */
  window.claude = {
    use: function (name) {
      if (name === 'db') return ensure().then(function () { return db; });
      if (name === 'user') return ensure().then(function () { return user; });
      if (name === 'downloads') return Promise.resolve(downloads);
      return Promise.resolve(null);   // sample, permissions, … are not part of the Kitchen app
    }
  };
})();
