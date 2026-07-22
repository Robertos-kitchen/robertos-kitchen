// ──────────────────────────────────────────────────────────────────────────
// LIVE FLOORPLAN — who is sat where.
//
// WHY THIS FILE EXISTS: the SevenRooms API hands us table NUMBERS (43, 600,
// 502…) but never the map — it will not tell us where table 43 physically is.
// So the venue is drawn here once, by hand, transcribed from the SevenRooms
// floorplan. The live feed (?floorplan= mode of the sevenrooms-sync edge
// function) then just colours it in.
//
// TO MOVE FURNITURE: edit the coordinates below. Nothing else needs touching.
// Coordinates are in the SVG viewBox (1289 x 751) and are the CENTRE of each
// table. Any table the feed mentions but this map doesn't know is listed on
// screen under "not on the map" — it is never silently dropped.
// ──────────────────────────────────────────────────────────────────────────

// Cropped tight to the furniture (measured, not guessed) — the raw SevenRooms
// canvas wastes ~23% of its width and ~20% of its height on empty margin, and
// that margin is scale the table numbers can't afford in a side panel.
var FP_VIEW = { x: 108, y: 103, w: 1014, h: 622 };

// Room outlines, drawn as simple boxes with the room name along the bottom.
var FP_ROOMS = [
  { label: 'SCALA',    x: 118, y: 137, w: 192, h: 226 },
  { label: 'CORTINA',  x: 340, y: 352, w: 240, h: 128 },
  { label: 'PIEMONTE', x: 575, y: 340, w: 455, h: 238 },
  { label: 'GIARDINO', x: 1030, y: 288, w: 82,  h: 252 },
  { label: 'TERRAZZA', x: 793, y: 578, w: 237, h: 137 }
];

// Fixed furniture and landmarks — they orient the eye, nothing more.
var FP_FIXTURES = [
  { kind: 'blob', x: 378, y: 180, w: 155, h: 88, rx: 14 },   // the bar
  { kind: 'bar',  x: 570, y: 262, w: 140, h: 26 },           // wine cellar
  { kind: 'bar',  x: 918, y: 296, w: 70,  h: 18 },           // hostess desk
  { kind: 'bar',  x: 893, y: 342, w: 130, h: 12 }            // pass / back bar
];

var FP_LABELS = [
  { t: 'WC',            x: 452,  y: 121 },
  { t: 'KITCHEN',       x: 638,  y: 127 },
  { t: 'WC',            x: 925,  y: 136 },
  { t: 'FOOD DISPLAY',  x: 838,  y: 247 },
  { t: 'WINE CELLAR',   x: 640,  y: 285 },
  { t: 'HOSTESS DESK',  x: 953,  y: 309 },
  { t: 'STAIRS',        x: 322,  y: 160 },
  { t: 'STATION',       x: 906,  y: 640 }
];

// Every table in the venue. n = the number SevenRooms uses in its feed.
var FP_TABLES = [
  // ── Scala ──
  { n: '614', x: 160, y: 180 }, { n: '612', x: 208, y: 180 }, { n: '611', x: 238, y: 180 }, { n: '610', x: 277, y: 180 },
  { n: '621', x: 224, y: 227 }, { n: '623', x: 268, y: 227 },
  { n: '620', x: 224, y: 272 }, { n: '622', x: 271, y: 272 },
  { n: '603', x: 161, y: 324 }, { n: '602', x: 205, y: 324 }, { n: '601', x: 237, y: 324 }, { n: '600', x: 277, y: 325 },
  // ── Bar (small = stools, drawn smaller so the row doesn't collide) ──
  { n: '510', x: 367, y: 214, small: 1 }, { n: '509', x: 367, y: 236, small: 1 }, { n: '508', x: 393, y: 251, small: 1 },
  { n: '506', x: 410, y: 268, small: 1 }, { n: '505', x: 430, y: 268, small: 1 }, { n: '504', x: 450, y: 268, small: 1 },
  { n: '503', x: 470, y: 268, small: 1 }, { n: '502', x: 490, y: 268, small: 1 }, { n: '501', x: 510, y: 268, small: 1 },
  { n: '500', x: 530, y: 268, small: 1 },
  { n: '403', x: 401, y: 327 }, { n: '402', x: 448, y: 327 }, { n: '401', x: 493, y: 327 }, { n: '400', x: 533, y: 327 },
  // ── Cortina ──
  { n: '323', x: 368, y: 378 }, { n: '322', x: 368, y: 400 }, { n: '321', x: 368, y: 427 }, { n: '320', x: 368, y: 452 },
  { n: '330', x: 452, y: 378 }, { n: '331', x: 496, y: 378 },
  { n: '311', x: 432, y: 467 }, { n: '310', x: 464, y: 467 }, { n: '301', x: 500, y: 467 }, { n: '300', x: 532, y: 467 },
  // ── Piemonte (left) ──
  { n: '80', x: 603, y: 364 }, { n: '81', x: 647, y: 364 }, { n: '82', x: 675, y: 364 },
  { n: '71', x: 687, y: 433 }, { n: '70', x: 684, y: 483 },
  { n: '64', x: 610, y: 446 }, { n: '63', x: 610, y: 502 },
  { n: '62', x: 612, y: 543 }, { n: '61', x: 647, y: 543 }, { n: '60', x: 679, y: 543 },
  // ── Piemonte (centre banquettes) ──
  { n: '50', x: 756, y: 393 }, { n: '51', x: 756, y: 415 }, { n: '52', x: 756, y: 441 },
  { n: '53', x: 756, y: 467 }, { n: '54', x: 756, y: 489 },
  { n: '40', x: 821, y: 393 }, { n: '41', x: 821, y: 415 }, { n: '42', x: 821, y: 441 },
  { n: '43', x: 821, y: 467 }, { n: '44', x: 821, y: 489 },
  // ── Piemonte (right) ──
  { n: '10', x: 905, y: 373, small: 1 }, { n: '11', x: 928, y: 373, small: 1 }, { n: '12', x: 951, y: 373, small: 1 },
  { n: '14', x: 976, y: 373, small: 1 }, { n: '15', x: 1003, y: 373, small: 1 },
  { n: '20', x: 928, y: 442, big: 1 },
  { n: '21', x: 994, y: 427 }, { n: '22', x: 994, y: 461 },
  { n: '33', x: 931, y: 492 }, { n: '32', x: 995, y: 490 },
  { n: '30', x: 927, y: 545 }, { n: '31', x: 990, y: 545 },
  // ── Giardino ──
  { n: '100', x: 1058, y: 302 }, { n: '101', x: 1090, y: 302 },
  { n: '110', x: 1040, y: 359 }, { n: '111', x: 1086, y: 357 },
  { n: '121', x: 1091, y: 429 }, { n: '120', x: 1069, y: 468 },
  { n: '130', x: 1058, y: 514 }, { n: '131', x: 1090, y: 514 },
  // ── Terrazza ──
  { n: '210', x: 877, y: 596 }, { n: '211', x: 931, y: 596 },
  { n: '209', x: 829, y: 616 }, { n: '208', x: 829, y: 638 },
  { n: '200', x: 987, y: 613 }, { n: '201', x: 987, y: 632 },
  { n: '207', x: 830, y: 682 }, { n: '206', x: 866, y: 683 }, { n: '205', x: 894, y: 683 },
  { n: '204', x: 922, y: 683 }, { n: '203', x: 949, y: 683 }, { n: '202', x: 982, y: 682 }
];

function fpEsc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// Names run long ("Ms. Ekaterina Vasil") and tables are 30px wide. Trim to
// something a chef can still read across a kitchen.
function fpShortName(name){
  var n = String(name || '').trim();
  // Drop the honorific first — "Ms. Ekaterina Vasil" must not shorten to
  // "Ms. Vasil" and lose the name the chef actually needs.
  n = n.replace(/^(mr|mrs|ms|miss|dr|sir|mx)\.?\s+/i, '');
  // 12 is what fits between two neighbouring tables without the labels
  // colliding on the narrowest spacing in the room.
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
function fpIndex(reservations){
  var known = {}, i;
  for (i = 0; i < FP_TABLES.length; i++) known[FP_TABLES[i].n] = 1;
  var byTable = {}, unmapped = [];
  (reservations || []).forEach(function(r){
    // Anchor the name to the left-most table of a joined booking (611+612)
    // so a party across two tables gets one label, not two.
    var mapped = (r.tables || []).filter(function(t){ return known[t]; });
    mapped.sort(function(a, b){
      var ta = null, tb = null, k;
      for (k = 0; k < FP_TABLES.length; k++) {
        if (FP_TABLES[k].n === a) ta = FP_TABLES[k];
        if (FP_TABLES[k].n === b) tb = FP_TABLES[k];
      }
      return (ta ? ta.x : 0) - (tb ? tb.x : 0);
    });
    (r.tables || []).forEach(function(t){
      if (!known[t]) { unmapped.push({ table: t, name: r.name, state: r.state, pax: r.pax }); return; }
      byTable[t] = { state: r.state, name: r.name, pax: r.pax, time: r.time, lead: mapped[0] === t };
    });
  });
  return { byTable: byTable, unmapped: unmapped };
}

function fpSize(t){
  if (t.big) return { w: 42, h: 28 };
  if (t.small) return { w: 18, h: 14 };
  return { w: 26, h: 18 };
}

function fpTableSvg(t, hit){
  var sz = fpSize(t), w = sz.w, h = sz.h;
  var x = t.x - w / 2, y = t.y - h / 2;
  var state = hit ? hit.state : 'free';
  var out = '<g class="fp-t fp-' + state + (t.small ? ' fp-sm' : '') + '">' +
    '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="5"></rect>' +
    '<text class="fp-num" x="' + t.x + '" y="' + (t.y + 3.5) + '">' + t.n + '</text>';
  // The guest's name sits under the table, exactly as the hosts see it in
  // SevenRooms — Francesco's call, 22 Jul.
  if (hit && hit.lead && hit.state !== 'free') {
    out += '<text class="fp-name" x="' + t.x + '" y="' + (t.y + h / 2 + 9) + '">' +
      fpEsc(fpShortName(hit.name)) + (hit.pax ? ' · ' + hit.pax : '') + '</text>';
    if (hit.state === 'upcoming' && hit.time) {
      out += '<text class="fp-time" x="' + t.x + '" y="' + (t.y + h / 2 + 18) + '">' + fpEsc(hit.time) + '</text>';
    }
  }
  return out + '</g>';
}

function fpSvg(reservations){
  var idx = fpIndex(reservations);
  var s = '<svg class="fp-svg" viewBox="' + FP_VIEW.x + ' ' + FP_VIEW.y + ' ' + FP_VIEW.w + ' ' + FP_VIEW.h +
          '" preserveAspectRatio="xMidYMid meet">';
  FP_ROOMS.forEach(function(r){
    s += '<rect class="fp-room" x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h + '" rx="3"></rect>' +
         '<text class="fp-room-label" x="' + (r.x + r.w / 2) + '" y="' + (r.y + r.h - 6) + '">' + r.label + '</text>';
  });
  FP_FIXTURES.forEach(function(f){
    s += '<rect class="fp-fix' + (f.kind === 'blob' ? ' fp-blob' : '') + '" x="' + f.x + '" y="' + f.y +
         '" width="' + f.w + '" height="' + f.h + '" rx="' + (f.rx || 2) + '"></rect>';
  });
  FP_LABELS.forEach(function(l){
    s += '<text class="fp-label" x="' + l.x + '" y="' + l.y + '">' + l.t + '</text>';
  });
  FP_TABLES.forEach(function(t){ s += fpTableSvg(t, idx.byTable[t.n]); });
  s += '</svg>';
  return { svg: s, unmapped: idx.unmapped };
}
