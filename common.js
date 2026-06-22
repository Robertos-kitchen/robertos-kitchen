// ──────────────────────────────────────────────────────────────────────────
// Roberto's SHARED helpers — ONE definition used by both apps (Kitchen + FOH).
//
// Pure, dependency-free functions that were previously copy-pasted into each
// app and drifted apart (the Dubai-date logic behind the "wrong night" bugs).
// Exposed as `window.RC` in the browser and as a module in Node, so tests.js
// checks this exact file.
//
// KEEP THIS FILE IDENTICAL IN BOTH REPOS (kitchen + foh). It is covered by
// tests.js — run `node tests.js` after any change here.
// ──────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; // Node (tests)
  if (root) root.RC = api;                                                // Browser (window.RC)
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // 'YYYY-MM-DD' from a Date's LOCAL parts. Never toISOString() (that's UTC and
  // rolls the date back a day east of GMT — a known source of off-by-one bugs).
  function localDateISO(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  // A Date shifted to Dubai wall-clock (UTC+4, no DST), regardless of the
  // device's own timezone.
  function dubaiWallClock(now) {
    return new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 4 * 3600000);
  }

  // The OPERATIONAL NIGHT as 'YYYY-MM-DD'. Service runs past midnight, so work
  // logged before 06:00 Dubai belongs to the night that just ended (previous
  // calendar day). This is the rule used by the closing report and checklist.
  function dubaiBusinessDate(now) {
    return localDateISO(new Date(dubaiWallClock(now).getTime() - 6 * 3600000));
  }

  // Hours between two "HH:MM" strings; end <= start is treated as overnight (+24h).
  function calcHours(start, end) {
    var s = start.split(':').map(Number), e = end.split(':').map(Number);
    var mins = (e[0] * 60 + e[1]) - (s[0] * 60 + s[1]);
    if (mins <= 0) mins += 1440;
    return mins / 60;
  }

  return {
    localDateISO: localDateISO,
    dubaiWallClock: dubaiWallClock,
    dubaiBusinessDate: dubaiBusinessDate,
    calcHours: calcHours,
    VERSION: '2026-06-22'
  };
});
