#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────────
// Safety-net tests for the small, bug-prone pure functions both apps rely on:
// Dubai date math (the source of the closing-report + checklist "wrong night"
// bugs) and hours-worked (overnight shifts). Run with:  node tests.js
//
// These are CANONICAL reference implementations that mirror the live code
// (clToday/chkToday/getServiceDate/calcHours). Step #3 (shared common.js) will
// make the apps import these very functions so the tests cover the real code.
// Until then, if you change the logic in an app, change it here too — a failing
// test means the two have drifted.
// ──────────────────────────────────────────────────────────────────────────

// --- functions under test (mirror the live apps) ---

// Calendar date from local parts — NEVER toISOString() (that returns UTC and
// rolls the date back a day east of GMT). Matches kitchen formatDate / FOH localISO.
function localDateISO(d){
  return d.getFullYear() + '-' +
    String(d.getMonth()+1).padStart(2,'0') + '-' +
    String(d.getDate()).padStart(2,'0');
}

// Operational/business night. Service runs past midnight, so work logged before
// 06:00 Dubai belongs to the night that just ended (the previous calendar day).
// `now` is a real Date; we shift to Dubai wall-clock then back 6h. Matches
// foh-closing clToday and the fixed FOH chkToday.
function dubaiBusinessDate(now){
  const dubai = new Date(now.getTime() + now.getTimezoneOffset()*60000 + 4*3600000);
  const biz   = new Date(dubai.getTime() - 6*3600000);
  return localDateISO(biz);
}

// Hours between two "HH:MM" strings; end <= start is treated as overnight (+24h).
// Matches kitchen/FOH calcHours.
function calcHours(start, end){
  const [sh,sm] = start.split(':').map(Number);
  const [eh,em] = end.split(':').map(Number);
  let mins = (eh*60+em) - (sh*60+sm);
  if (mins <= 0) mins += 1440;
  return mins/60;
}

// --- tiny test harness ---
let pass=0, fail=0;
function eq(got, want, name){
  const ok = got === want;
  if(ok) pass++; else { fail++; console.log(`  ✗ ${name}\n      got:  ${got}\n      want: ${want}`); }
}

// Build a real Date for a given Dubai wall-clock time, regardless of the machine
// timezone, so these tests pass on any developer's laptop.
function dubaiTime(y,mo,d,h,mi){
  const asUTC = Date.UTC(y, mo-1, d, h, mi);   // treat the wall clock as UTC…
  return new Date(asUTC - 4*3600000);          // …then subtract 4h so it IS Dubai (+4)
}

console.log('Dubai business date (6h rollback):');
eq(dubaiBusinessDate(dubaiTime(2026,6,21, 1,36)), '2026-06-20', 'Sun 01:36 closing -> Saturday night');
eq(dubaiBusinessDate(dubaiTime(2026,6,20,23,30)), '2026-06-20', 'Sat 23:30 (pre-midnight) -> Saturday');
eq(dubaiBusinessDate(dubaiTime(2026,6,21, 5,59)), '2026-06-20', 'Sun 05:59 -> still previous night');
eq(dubaiBusinessDate(dubaiTime(2026,6,21, 6, 1)), '2026-06-21', 'Sun 06:01 -> new day begins');
eq(dubaiBusinessDate(dubaiTime(2026,6,20,11, 0)), '2026-06-20', 'Sat 11:00 opening -> Saturday');

console.log('Local date (no UTC shift):');
eq(localDateISO(dubaiTime(2026,1,1,0,30)), '2026-01-01', 'midnight-ish stays on the day');

console.log('Hours worked:');
eq(calcHours('14:00','23:00'), 9,  'normal evening shift');
eq(calcHours('14:00','00:00'), 10, 'finish at midnight');
eq(calcHours('22:00','02:00'), 4,  'overnight wrap past midnight');
eq(calcHours('18:00','18:30'), 0.5,'half hour');

console.log(`\n${fail? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
