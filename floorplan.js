// ──────────────────────────────────────────────────────────────────────────
// LIVE FLOORPLAN — who is sat where.
//
// WHY THIS FILE EXISTS: the SevenRooms API hands us table NUMBERS (43, 600,
// 502…) but never the map — it will not tell us where table 43 physically is.
//
// WHERE THE GEOMETRY CAME FROM: read straight out of the SevenRooms floorplan
// itself (22 Jul 2026). Their floorplan is a Konva canvas, so every table,
// wall and room was pulled from the live scene graph — real coordinates, real
// shapes, real sizes. This is not a hand-drawing: the layout matches theirs.
// Coordinates are SevenRooms' own, kept as-is so a re-read drops straight in.
//
// TO RE-READ AFTER THEY MOVE FURNITURE: open the SevenRooms floorplan, and in
// the console walk Konva.stages[0] — Text nodes matching /^\d{1,3}$/ are the
// table numbers, the nearest Rect/Circle is that table's shape.
//
// Any table the feed mentions but this map doesn't know is listed on screen
// under "not on the map" — it is never silently dropped.
// ──────────────────────────────────────────────────────────────────────────

// Cropped to the furniture. These are SevenRooms' units.
var FP_VIEW = { x: 380, y: 950, w: 5240, h: 3350 };

// Floor areas, by kind: 'floor' = a named room, 'boh' = back of house,
// 'fix' = fixed furniture (the bar, the wine cellar, the centre banquette).
var FP_AREAS = [
  { k: 'boh',   x: 1887, y: 100,  w: 2960, h: 1022 },   // kitchen block
  { k: 'boh',   x: 3871, y: 983,  w: 648,  h: 780 },
  { k: 'boh',   x: 4513, y: 982,  w: 341,  h: 204 },
  { k: 'floor', x: 1600, y: 2250, w: 1210, h: 638 },    // Cortina
  { k: 'floor', x: 5184, y: 1869, w: 416,  h: 1352 },   // Giardino
  { k: 'floor', x: 3944, y: 3370, w: 1226, h: 736 },    // Terrazza
  { k: 'fix',   x: 1982, y: 1284, w: 609,  h: 454 },    // the bar
  { k: 'fix',   x: 2785, y: 1795, w: 698,  h: 45  },    // wine cellar
  { k: 'fix',   x: 2789, y: 2071, w: 698,  h: 45  },
  { k: 'fix',   x: 3825, y: 2387, w: 214,  h: 634 }     // centre banquette
];

// Wall segments, exactly as SevenRooms draws them.
var FP_WALLS = [
  [399,2253,1171,8],[1562,2253,8,658],[1562,2903,1231,8],[2785,2768,8,631],
  [2785,2127,712,8],[2785,2127,8,342],[398,1122,8,1139],[398,1122,1647,8],
  [2785,3391,1158,8],[3935,4133,1243,8],[3935,3391,8,750],[5169,2934,8,1207],
  [5169,2149,8,586],[4314,2150,863,8],[1562,2254,206,8],[2580,2254,206,8],
  [5171,1858,433,8],[5176,3224,423,8],[5596,1866,8,1366],[5169,1858,8,297],
  [1444,1130,8,180],[1449,2074,8,180],[2774,1772,718,8],[5169,991,8,871],
  [3871,1772,669,8],[4532,1210,8,567],[4720,1210,8,567],[4720,1203,160,8],
  [4877,991,293,8],[4872,991,8,217],[4531,1203,43,8],[4678,1203,43,8],
  [2329,1124,140,8],[2467,1125,8,160],[3926,3391,181,8],[4994,3391,181,8]
];

// Room names and landmarks. rot = -90 for the two SevenRooms draws sideways.
var FP_LABELS = [
  { t: 'SCALA',        x: 470,  y: 1733, room: 1, rot: -90 },
  { t: 'CORTINA',      x: 2198, y: 2973, room: 1 },
  { t: 'PIEMONTE',     x: 3464, y: 3467, room: 1 },
  { t: 'TERRAZZA',     x: 4511, y: 4235, room: 1 },
  { t: 'GIARDINO',     x: 5530, y: 2438, room: 1, rot: -90 },
  { t: 'KITCHEN',      x: 3138, y: 1057 },
  { t: 'CIGARS',       x: 1484, y: 1228 },
  { t: 'WINE CELLAR',  x: 3135, y: 1912 },
  { t: 'FOOD DISPLAY', x: 4183, y: 1690 },
  { t: 'HOSTESS DESK', x: 4778, y: 1965 },
  { t: 'STATION',      x: 5183, y: 2973 },
  { t: 'STATION',      x: 3835, y: 3339 },
  { t: 'STATION',      x: 4538, y: 3729 },
  { t: 'STATION',      x: 3956, y: 3447 },
  { t: 'STATION',      x: 5122, y: 3454 }
];

// Every table in the venue, straight from SevenRooms.
// n = the number their feed uses · k = R(ectangle) or C(ircle) · w = size.
var FP_TABLES = [
  {n:'10',x:4529,y:2336,k:'R',w:100},  {n:'11',x:4640,y:2334,k:'R',w:100},
  {n:'12',x:4771,y:2334,k:'R',w:100},  {n:'14',x:4891,y:2334,k:'R',w:100},
  {n:'15',x:5045,y:2335,k:'R',w:100},  {n:'20',x:4648,y:2701,k:'C',w:150},
  {n:'21',x:4996,y:2622,k:'R',w:125},  {n:'22',x:4996,y:2794,k:'R',w:125},
  {n:'30',x:4643,y:3240,k:'C',w:150},  {n:'31',x:4973,y:3240,k:'C',w:150},
  {n:'32',x:4998,y:2951,k:'R',w:125},  {n:'33',x:4663,y:2967,k:'R',w:125},
  {n:'40',x:4084,y:2448,k:'R',w:100},  {n:'41',x:4086,y:2561,k:'R',w:100},
  {n:'42',x:4088,y:2697,k:'R',w:100},  {n:'43',x:4091,y:2839,k:'R',w:100},
  {n:'44',x:4093,y:2951,k:'R',w:100},  {n:'50',x:3746,y:2444,k:'R',w:100},
  {n:'51',x:3747,y:2555,k:'R',w:100},  {n:'52',x:3745,y:2693,k:'R',w:100},
  {n:'53',x:3751,y:2835,k:'R',w:100},  {n:'54',x:3751,y:2947,k:'R',w:100},
  {n:'60',x:3346,y:3229,k:'R',w:100},  {n:'61',x:3180,y:3226,k:'R',w:100},
  {n:'62',x:2993,y:3227,k:'C',w:125},  {n:'63',x:2986,y:3012,k:'R',w:100},
  {n:'64',x:2985,y:2866,k:'R',w:100},  {n:'70',x:3385,y:2915,k:'C',w:150},
  {n:'71',x:3385,y:2655,k:'C',w:150},  {n:'80',x:2949,y:2295,k:'C',w:125},
  {n:'81',x:3176,y:2291,k:'R',w:100},  {n:'82',x:3325,y:2289,k:'R',w:100},
  {n:'100',x:5353,y:1966,k:'R',w:100}, {n:'101',x:5481,y:1965,k:'R',w:100},
  {n:'110',x:5233,y:2265,k:'R',w:100}, {n:'111',x:5483,y:2258,k:'R',w:100},
  {n:'120',x:5392,y:2836,k:'R',w:100}, {n:'121',x:5506,y:2631,k:'R',w:100},
  {n:'130',x:5357,y:3074,k:'R',w:100}, {n:'131',x:5470,y:3079,k:'R',w:100},
  {n:'200',x:4957,y:3594,k:'R',w:100}, {n:'201',x:4959,y:3700,k:'R',w:100},
  {n:'202',x:4934,y:3949,k:'C',w:125}, {n:'203',x:4764,y:3973,k:'R',w:100},
  {n:'204',x:4622,y:3970,k:'R',w:100}, {n:'205',x:4474,y:3970,k:'R',w:100},
  {n:'206',x:4330,y:3963,k:'R',w:100}, {n:'207',x:4137,y:3950,k:'C',w:125},
  {n:'208',x:4134,y:3713,k:'R',w:100}, {n:'209',x:4134,y:3608,k:'R',w:100},
  {n:'210',x:4385,y:3508,k:'C',w:125}, {n:'211',x:4667,y:3508,k:'C',w:125},
  {n:'300',x:2541,y:2825,k:'R',w:100}, {n:'301',x:2422,y:2824,k:'R',w:100},
  {n:'310',x:2183,y:2830,k:'R',w:100}, {n:'311',x:2067,y:2833,k:'R',w:100},
  {n:'320',x:1720,y:2753,k:'R',w:100}, {n:'321',x:1720,y:2625,k:'R',w:100},
  {n:'322',x:1720,y:2487,k:'R',w:100}, {n:'323',x:1720,y:2369,k:'R',w:100},
  {n:'330',x:2160,y:2370,k:'C',w:125}, {n:'331',x:2392,y:2364,k:'C',w:125},
  {n:'400',x:2585,y:2101,k:'C',w:125}, {n:'401',x:2376,y:2103,k:'C',w:125},
  {n:'402',x:2142,y:2094,k:'C',w:125}, {n:'403',x:1890,y:2105,k:'C',w:125},
  {n:'500',x:2500,y:1776,k:'R',w:80},  {n:'501',x:2396,y:1776,k:'R',w:80},
  {n:'502',x:2297,y:1774,k:'R',w:80},  {n:'503',x:2197,y:1775,k:'R',w:80},
  {n:'504',x:2095,y:1775,k:'R',w:80},  {n:'505',x:1992,y:1776,k:'R',w:80},
  {n:'506',x:1878,y:1779,k:'R',w:98},  {n:'508',x:1776,y:1718,k:'R',w:113},
  {n:'509',x:1713,y:1615,k:'R',w:80},  {n:'510',x:1711,y:1509,k:'R',w:80},
  {n:'600',x:1242,y:2091,k:'C',w:100}, {n:'601',x:1005,y:2082,k:'R',w:100},
  {n:'602',x:876,y:2082,k:'R',w:100},  {n:'603',x:639,y:2084,k:'C',w:100},
  {n:'610',x:1235,y:1332,k:'C',w:100}, {n:'611',x:1009,y:1330,k:'R',w:100},
  {n:'612',x:895,y:1329,k:'R',w:100},  {n:'614',x:628,y:1330,k:'C',w:100},
  {n:'620',x:962,y:1811,k:'C',w:100},  {n:'621',x:965,y:1569,k:'C',w:100},
  {n:'622',x:1214,y:1808,k:'C',w:100}, {n:'623',x:1199,y:1582,k:'C',w:100}
];

function fpEsc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// Names run long ("Ms. Ekaterina Vasil") and tables are small on a shared
// screen. Trim to something a chef can still read across a kitchen.
function fpShortName(name){
  var n = String(name || '').trim();
  // Drop the honorific first — "Ms. Ekaterina Vasil" must not shorten to
  // "Ms. Vasil" and lose the name the chef actually needs.
  n = n.replace(/^(mr|mrs|ms|miss|dr|sir|mx)\.?\s+/i, '');
  if (n.length <= 12) return n;
  var parts = n.split(/\s+/);
  if (parts.length > 1) {
    var last = parts[parts.length - 1];
    var short = parts[0].charAt(0) + ' ' + last;          // "A Bernardini"
    if (short.length <= 12) return short;
    return parts[0].slice(0, 11) + '…';
  }
  return n.slice(0, 11) + '…';
}

// Turn the live feed into a lookup of table number → the booking on it, and
// report back any table the feed named that this map has never heard of.
// A busy table is turned, so one table carries two bookings in a night — on a
// normal Wednesday 8 of them do. Which booking owns the square matters: whoever
// is physically sat there wins; if nobody is, the party still to come beats the
// party that has already left. Without this the map happily shows a guest who
// went home an hour ago on a table someone else is eating at right now.
var FP_RANK = { seated: 3, upcoming: 2, completed: 1 };

function fpBeats(next, prev){
  if (!prev) return true;
  var a = FP_RANK[next.state] || 0, b = FP_RANK[prev.state] || 0;
  if (a !== b) return a > b;
  // Same standing: show the next party due in, and the most recent of those
  // already finished.
  if (next.state === 'upcoming') return (next.time || '99:99') < (prev.time || '99:99');
  if (next.state === 'completed') return (next.time || '') > (prev.time || '');
  return false;
}

function fpIndex(reservations){
  var pos = {};
  FP_TABLES.forEach(function(t){ pos[t.n] = t; });
  var byTable = {}, unmapped = [];
  (reservations || []).forEach(function(r){
    // Anchor the name to the left-most table of a joined booking (611+612)
    // so a party across two tables gets one label, not two.
    var mapped = (r.tables || []).filter(function(t){ return pos[t]; });
    mapped.sort(function(a, b){ return pos[a].x - pos[b].x; });
    (r.tables || []).forEach(function(t){
      if (!pos[t]) { unmapped.push({ table: t, name: r.name, state: r.state, pax: r.pax }); return; }
      var cand = { state: r.state, name: r.name, pax: r.pax, time: r.time, lead: mapped[0] === t };
      if (fpBeats(cand, byTable[t])) byTable[t] = cand;
    });
  });
  return { byTable: byTable, unmapped: unmapped };
}

function fpTableSvg(t, hit){
  var state = hit ? hit.state : 'free';
  var half = t.w / 2;
  var out = '<g class="fp-t fp-' + state + '">';
  out += t.k === 'C'
    ? '<circle cx="' + t.x + '" cy="' + t.y + '" r="' + half + '"></circle>'
    : '<rect x="' + (t.x - half) + '" y="' + (t.y - half) + '" width="' + t.w + '" height="' + t.w + '" rx="12"></rect>';
  out += '<text class="fp-num" x="' + t.x + '" y="' + (t.y + 18) + '">' + t.n + '</text>';
  // The guest's name sits under the table, exactly as the hosts see it in
  // SevenRooms — Francesco's call, 22 Jul.
  if (hit && hit.lead && hit.state !== 'free') {
    out += '<text class="fp-name" x="' + t.x + '" y="' + (t.y + half + 48) + '">' +
      fpEsc(fpShortName(hit.name)) + (hit.pax ? ' · ' + hit.pax : '') + '</text>';
    if (hit.state === 'upcoming' && hit.time) {
      out += '<text class="fp-time" x="' + t.x + '" y="' + (t.y + half + 96) + '">' + fpEsc(hit.time) + '</text>';
    }
  }
  return out + '</g>';
}

function fpSvg(reservations){
  var idx = fpIndex(reservations);
  var s = '<svg class="fp-svg" viewBox="' + FP_VIEW.x + ' ' + FP_VIEW.y + ' ' + FP_VIEW.w + ' ' + FP_VIEW.h +
          '" preserveAspectRatio="xMidYMid meet">';
  FP_AREAS.forEach(function(a){
    s += '<rect class="fp-area fp-a-' + a.k + '" x="' + a.x + '" y="' + a.y +
         '" width="' + a.w + '" height="' + a.h + '" rx="8"></rect>';
  });
  FP_WALLS.forEach(function(w){
    s += '<rect class="fp-wall" x="' + w[0] + '" y="' + w[1] + '" width="' + w[2] + '" height="' + w[3] + '"></rect>';
  });
  FP_LABELS.forEach(function(l){
    var tr = l.rot ? ' transform="rotate(' + l.rot + ' ' + l.x + ' ' + l.y + ')"' : '';
    s += '<text class="fp-label' + (l.room ? ' fp-room-label' : '') + '" x="' + l.x + '" y="' + l.y + '"' + tr + '>' + l.t + '</text>';
  });
  FP_TABLES.forEach(function(t){ s += fpTableSvg(t, idx.byTable[t.n]); });
  s += '</svg>';
  return { svg: s, unmapped: idx.unmapped };
}
