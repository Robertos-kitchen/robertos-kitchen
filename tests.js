#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────────
// Safety-net tests for the small, bug-prone pure functions both apps rely on:
// Dubai date math (the source of the closing-report + checklist "wrong night"
// bugs) and hours-worked (overnight shifts). Run with:  node tests.js
//
// As of #3, these test the REAL shared file (common.js) that both apps load —
// not a copy. If you change common.js, run `node tests.js`.
// ──────────────────────────────────────────────────────────────────────────

const RC = require('./common.js');
const { localDateISO, dubaiBusinessDate, calcHours } = RC;

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
