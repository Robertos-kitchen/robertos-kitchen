/* Kitchen Design — storage layer.
 *
 * The planner page was written against a small document-store API
 * (doc / collection / get / set / update / delete / orderBy / limit / onSnapshot)
 * plus three helpers (user, downloads). This file provides exactly that API on top of
 * the Kitchen app's own Supabase tables kd_projects + kd_docs, so the planner runs
 * unchanged inside the Kitchen app and everything it saves belongs to us.
 *
 * Load order on the page: dev-guard.js, supabase-js, THIS FILE, then the planner.
 * dev-guard.js must run first: on the DEV host it blocks writes, exactly as for every
 * other Kitchen screen.
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

  function scope(coll) { return coll === 'equipment' ? GLOBAL : PROJECT; }
  function snapDoc(id, row) { return { id: id, exists: !!row, data: function () { return row ? row.data : undefined; }, metadata: { fromCache: false } }; }
  function snapList(rows) {
    return { docs: rows.map(function (r) { return { id: r.doc_id, data: function () { return r.data; } }; }), metadata: { fromCache: false } };
  }
  function err(e) { var x = new Error((e && e.message) || 'storage error'); x.code = (e && (e.code || e.status)) || 'error'; return x; }
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

  function DocRef(coll, id) {
    this.coll = coll; this.id = id;
  }
  DocRef.prototype._read = function () {
    var self = this;
    return sb.from('kd_docs').select('data,updated_at').eq('project_id', scope(self.coll)).eq('coll', self.coll).eq('doc_id', self.id).limit(1)
      .then(function (r) { if (r.error) throw r.error; var row = r.data && r.data[0] ? { data: r.data[0].data, doc_id: self.id } : null; return { row: row, at: r.data && r.data[0] ? r.data[0].updated_at : null }; });
  };
  DocRef.prototype.get = function () { var self = this; return this._read().then(function (x) { return snapDoc(self.id, x.row); }); };
  DocRef.prototype.set = function (data) {
    return sb.from('kd_docs').upsert({ project_id: scope(this.coll), coll: this.coll, doc_id: this.id, data: data, updated_at: new Date().toISOString() }, { onConflict: 'project_id,coll,doc_id' })
      .then(function (r) { if (r.error) throw err(r.error); });
  };
  DocRef.prototype.update = function (patch) {
    var self = this;
    return this._read().then(function (x) { var cur = x.row ? x.row.data : {}; return new DocRef(self.coll, self.id).set(Object.assign({}, cur, patch)); });
  };
  DocRef.prototype.delete = function () {
    return sb.from('kd_docs').delete().eq('project_id', scope(this.coll)).eq('coll', this.coll).eq('doc_id', this.id).then(function (r) { if (r.error) throw err(r.error); });
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
    return sb.from('kd_docs').select('doc_id,data,updated_at').eq('project_id', scope(self.coll)).eq('coll', self.coll).limit(2000).then(function (r) {
      if (r.error) throw r.error;
      var rows = r.data || [];
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

  /* who is using it: a name typed once, kept on this device */
  function myName() { try { return localStorage.getItem('kd_name') || localStorage.getItem('mk_ovname') || ''; } catch (e) { return ''; } }
  var user = {
    id: function () { return Promise.resolve('kitchen'); },
    me: function () { return Promise.resolve({ id: 'kitchen:' + (myName() || 'team'), name: myName() || 'Kitchen team' }); },
    isOwner: function () { return true; }, canEdit: function () { return true; },
    can: function () { return Promise.resolve(true); },
    profiles: function (ids) { var o = {}; (ids || []).forEach(function (i) { o[i] = { name: String(i).replace(/^kitchen:/, '') || 'Kitchen team' }; }); return Promise.resolve(o); },
    search: function () { return Promise.resolve([]); }
  };

  /* save a file: the browser's own download */
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

  window.claude = {
    use: function (name) {
      if (name === 'db') return Promise.resolve(db);
      if (name === 'user') return Promise.resolve(user);
      if (name === 'downloads') return Promise.resolve(downloads);
      return Promise.resolve(null);   // sample, permissions, … are not part of the Kitchen app
    }
  };
})();
