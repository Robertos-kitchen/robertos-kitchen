// ══════════════════════════════════════════════════════════════════════════
// INTERVIEW SCORING — Commis Open Day, 17 Sep 2026.
//
// Built from Chef Andrea's "Commis Open Day — Live Scoring" draft: the same
// ten interview questions, the same five practical lines, the same 40/60
// weighting, the same Score / Leaderboard tabs. What changed is where the
// numbers live: in the Kitchen database, so the four chefs interviewing see
// one board on four phones and on the kitchen screen.
//
// Candidate names, scores and notes are personal data and the kitchen app has
// no logins, so nothing here touches a table. The anon key cannot read
// interview_candidates at all; every read and write is an RPC that checks the
// interviewers' passcode inside the database (interview-scoring-schema.sql).
//
// Live: a light poll every 4s while the screen is open. Scores are merged key
// by key in the database, so two chefs scoring the same candidate at the same
// time cannot wipe each other's questions.
//
// A candidate gets a final score and a verdict only when all 15 lines are
// scored. Until then the board says "In progress" and shows how many are
// left — a half-scored candidate never ranks above a finished one.
//
// CVs (16 Sep 2026): Word, PDF or a photo of a paper CV, per candidate, stored
// in the database behind the same passcode and opened IN the app — PDF drawn
// page by page with the app's own pdf.js (an iPhone iframe shows page 1 only),
// .docx turned into readable text by mammoth. An old .doc cannot be read in a
// browser, so it says so and offers the download instead of a blank panel.
//
// Candidate details (16 Sep 2026, Chef Andrea via "Tell us"): salary
// expectation, position applied for, notice period, visa status. Kept as the
// words the interviewer typed — "4,500 + accommodation" or "1 month" — so the
// app never turns 4.500 into 4.5. Each field saves on its own, like the name.
//
// Bulk CVs + search (16 Sep 2026, Chef Andrea via Tell us): "add in bulk all
// the cv saved in a folder" and "a window where we can search the candidate".
// The bulk window takes a whole folder (or many files, or a drag-and-drop),
// reads each candidate's name off the CV's first page (biggest name-shaped
// line of a PDF, first name-shaped line of a .docx, else the file name) and
// shows every name for the chef to correct BEFORE anything is written. A CV
// already on the board (same file name and size) is skipped, and a name that
// matches an existing candidate gets the CV attached instead of a duplicate —
// so running the same folder twice adds nothing.
//
// Reuses app.js globals: sb, hideAllPages(), kToast(), activeStation, lazyLoad().
// ══════════════════════════════════════════════════════════════════════════

var IVS_KEY   = '__interviews__';
var IVS_EVENT = 'commis-open-day-2026-09';
var IVS_CODE_STORE = 'kitchen-interview-code';

var IVS_SECTIONS = [
  { title:'Interview — behavioural', part:'int', items:[
    ['B1','Tell me about a time you made a mistake during a shift.','Ownership without excuses; corrects and learns from it.'],
    ['B2','Describe coping with a genuinely busy, high-pressure service.','Stays organized, prioritizes, doesn\'t panic or blame others.'],
    ['B3','How do you react when a senior chef corrects you sharply?','Takes feedback professionally, respects kitchen hierarchy.'],
    ['B4','Tell me about supporting a struggling teammate during service.','Team-first instinct, notices and helps, puts service ahead of ego.'],
    ['B5','Why Roberto\'s, and where in a year?','Genuine motivation; some awareness of Roberto\'s modern-Italian identity.']
  ]},
  { title:'Interview — technical', part:'int', items:[
    ['T1','Basic knife cuts (brunoise/julienne/chiffonade) and knife care.','Correct technique, mentions sharpening, safe handling.'],
    ['T2','Cooking methods and when to use each.','Matches method to ingredient/cut, not just definitions.'],
    ['T3','Key food safety points (temps, cross-contamination, allergens, FIFO).','Concrete habits, not vague "I\'m careful."'],
    ['T4','How they set up and organize mise en place.','Systematic, anticipates service flow, station stays stocked.'],
    ['T5','What is \'al dente\' and pasta/sauce finishing pitfalls.','Timing/texture, tasting as verification — Italian fundamentals.']
  ]},
  { title:'Practical demonstration', part:'prac', items:[
    ['P1','Knife skills & precision','Cut uniformity, correct grip/technique, safe handling.'],
    ['P2','Speed & time management','Finishes within 10 minutes, sensible order of operations.'],
    ['P3','Organization & cleanliness','Mise en place discipline, tidy while working, waste controlled.'],
    ['P4','Cooking technique & doneness','Heat control, correct doneness, seasoning judged & tasted.'],
    ['P5','Taste, presentation & plating','Balanced flavour, clean simple plating.']
  ]}
];
// [column, label, placeholder, suggestions — tap one or type anything]
var IVS_DETAILS = [
  ['position_applied',   'Position applied / expected', 'e.g. Commis II',
    ['Commis III','Commis II','Commis I','Demi Chef de Partie','Chef de Partie']],
  ['salary_expectation', 'Salary expectation', 'e.g. AED 4,500 / month + accommodation', []],
  ['notice_period',      'Notice period', 'e.g. 1 month',
    ['Immediate','1 week','2 weeks','1 month','2 months','3 months']],
  ['visa_status',        'Visa status', 'e.g. Visit visa',
    ['Visit visa','Employment visa — current employer','Cancelled visa / grace period','Family / spouse visa','Own visa (freelance / golden)','Outside the UAE']]
];
var IVS_WAVES = ['', 'Wave 1', 'Wave 2', 'Wave 3', 'Wave 4'];
var IVS_LINES = 15;

var ivsCode  = null;
var ivsRows  = [];
var ivsSel   = null;
var ivsTab   = 'score';   // score | board
var ivsErr   = '';
var ivsTimer = null;
var ivsPending = {};      // id -> number of saves in flight (the poll leaves those rows alone)
var ivsNameT = null, ivsNotesT = null;
var ivsDetT = {};          // column -> debounce timer for a detail field not sent yet
function ivsDetTyping(){ for (var k in ivsDetT) if (ivsDetT[k]) return true; return false; }
var ivsCvs = [];          // CV metadata for this event (never the file bytes)
var ivsCvBusy = null;     // candidate id with an upload in flight
var IVS_CV_MAX = 8 * 1024 * 1024;
var ivsQ = '';            // candidate search, kept across re-renders
var ivsBulk = null;       // the bulk-CV window's state while it is open
var IVS_MAMMOTH = 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js';

function ivsEsc(s){ return String(s==null?'':s)
  .replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

// ── the arithmetic, in one place ──
function ivsCalc(r){
  var sc = (r && r.scores) || {}, i = 0, p = 0, n = 0;
  IVS_SECTIONS.forEach(function(s){ s.items.forEach(function(it){
    var v = +sc[it[0]];
    if (v >= 1 && v <= 5){ n++; if (s.part === 'int') i += v; else p += v; }
  }); });
  var done = n === IVS_LINES;
  var fin = done ? Math.round((i/50)*40 + (p/25)*60) : null;
  return { int:i, prac:p, scored:n, done:done, final:fin, verdict: done ? ivsVerdict(fin) : null };
}
function ivsVerdict(f){
  if (f >= 80) return { t:'Strong hire', c:'strong', hire:true };
  if (f >= 65) return { t:'Hire',        c:'hire',   hire:true };
  if (f >= 50) return { t:'Maybe',       c:'maybe',  hire:false };
  return            { t:'No hire',      c:'no',     hire:false };
}

// ══════════════════════════════════════════════════════════════════════════
function ivsInjectCss(){
  if (document.getElementById('ivs-css')) return;
  var s = document.createElement('style'); s.id = 'ivs-css';
  s.textContent = [
    '#interviews-view,#ivs-bulk{--iv:#410207;--ivm:#5e0a10;--ivl:#7a1218;--is:#e1d3c2;--isl:#ede5d8;--isd:#cfc0ad;',
    '  --ik:#2a1a10;--icr:#f5ede0;--igo:#ba9b02;--iol:#4b5128}',
    '.ivwrap{max-width:1100px;margin:0 auto;padding:14px 14px 90px;font-family:"DM Sans",sans-serif;color:var(--ik)}',
    '.ivhd{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;justify-content:space-between;margin-bottom:12px}',
    '.ivhd small{display:block;font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--ivl);font-weight:700}',
    '.ivhd h2{font-family:"Cormorant Garamond",Georgia,serif;font-size:30px;margin:2px 0 0;font-weight:600;color:var(--iv);line-height:1.1}',
    '.ivstats{display:flex;gap:8px}',
    '.ivstat{background:#fff;border:1px solid var(--isd);border-radius:6px;padding:8px 12px;min-width:74px;text-align:center}',
    '.ivstat b{display:block;font-family:"DM Sans",sans-serif;font-variant-numeric:lining-nums tabular-nums;font-weight:600;font-size:22px;color:var(--iv);line-height:1}',
    '.ivstat span{display:block;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--ivl);font-weight:700;margin-top:3px}',
    '.ivtabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center}',
    '.ivb{font-family:"DM Sans",sans-serif;font-size:14px;font-weight:600;background:var(--iv);color:var(--icr);',
    '  border:1px solid var(--iv);border-radius:4px;padding:0 18px;min-height:46px;cursor:pointer}',
    '.ivb:hover{background:var(--ivm)}',
    '.ivb2{font-family:"DM Sans",sans-serif;font-size:14px;font-weight:600;background:#fff;color:var(--iv);',
    '  border:1px solid var(--isd);border-radius:4px;padding:0 16px;min-height:46px;cursor:pointer}',
    '.ivb2.on{background:var(--iv);color:var(--icr);border-color:var(--iv)}',
    '.ivb:focus-visible,.ivb2:focus-visible,.ivs button:focus-visible{outline:3px solid var(--igo);outline-offset:2px}',
    '.ivlock{margin-left:auto;background:none;border:0;color:var(--ivl);font-size:13px;font-weight:600;text-decoration:underline;cursor:pointer;min-height:44px}',
    '.ivgrid{display:grid;grid-template-columns:250px 1fr;gap:12px;align-items:start}',
    '.ivcard{background:#fff;border:1px solid var(--isd);border-radius:6px;padding:12px}',
    '.ivlbl{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--ivl);font-weight:700;margin-bottom:8px}',
    '.ivcand{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:var(--isl);border:1px solid transparent;',
    '  border-radius:4px;padding:10px;margin-top:7px;min-height:48px;cursor:pointer;font-family:"DM Sans",sans-serif;font-size:14px;color:var(--ik)}',
    '.ivcand.on{background:var(--icr);border-color:var(--iv)}',
    '.ivcand b{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ivcand i{font-style:normal;font-size:12.5px;font-weight:700;color:var(--iv)}',
    '.ivdot{width:9px;height:9px;border-radius:50%;background:var(--isd);flex:0 0 auto}',
    '.ivdot.done{background:var(--iol)}.ivdot.part{background:var(--igo)}',
    '.ivtop{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
    '.ivname{flex:1 1 220px;min-width:0;font-family:"Cormorant Garamond",Georgia,serif;font-size:25px;color:var(--ik);',
    '  border:0;border-bottom:2px solid var(--is);background:none;padding:6px 2px;min-height:46px}',
    '.ivname:focus{outline:none;border-bottom-color:var(--iv)}',
    '.ivdet{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px;margin-top:10px}',
    '.ivdf{display:block;min-width:0}',
    '.ivdf span{display:block;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ivl);font-weight:700;margin-bottom:3px}',
    '.ivdf input{width:100%;box-sizing:border-box;font-family:"DM Sans",sans-serif;font-size:15px;min-height:46px;border:1px solid var(--isd);border-radius:4px;background:var(--isl);padding:0 10px;color:var(--ik)}',
    '.ivdf input:focus{outline:none;border-color:var(--iv);background:#fff}',
    '.ivtab td.ivdc{font-size:13px;max-width:150px;overflow-wrap:anywhere}',
    '.ivsel{font-family:"DM Sans",sans-serif;font-size:15px;min-height:46px;border:1px solid var(--isd);border-radius:4px;background:var(--isl);padding:0 10px;color:var(--ik)}',
    '.ivdel{background:#fff;border:1px solid var(--isd);color:var(--iv);border-radius:4px;min-height:46px;padding:0 14px;font-weight:600;cursor:pointer}',
    '.ivsum{display:flex;flex-wrap:wrap;gap:12px;align-items:center;background:var(--isl);border-radius:6px;padding:12px 14px;margin:12px 0 4px}',
    '.ivsum .big{font-family:"DM Sans",sans-serif;font-variant-numeric:lining-nums tabular-nums;font-size:36px;color:var(--iv);line-height:1;font-weight:600}',
    '.ivsum .big small{font-family:"DM Sans",sans-serif;font-size:13px;color:#6b5a48;font-weight:400}',
    '.ivsum .parts{margin-left:auto;display:flex;gap:18px;text-align:right}',
    '.ivsum .parts b{display:block;font-size:19px;font-variant-numeric:tabular-nums}',
    '.ivsum .parts span{display:block;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#6b5a48}',
    '.ivpill{display:inline-block;font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;border-radius:20px;padding:5px 11px;background:#fff;color:#5a4a3a;border:1px solid var(--isd)}',
    '.ivpill.strong{background:#2f4a1e;color:#fff;border-color:#2f4a1e}',
    '.ivpill.hire{background:var(--iol);color:#fff;border-color:var(--iol)}',
    '.ivpill.maybe{background:#8a6d00;color:#fff;border-color:#8a6d00}',
    '.ivpill.no{background:var(--iv);color:#fff;border-color:var(--iv)}',
    '.ivsec{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--ivl);font-weight:700;padding:18px 0 4px;border-top:1px solid var(--isl);margin-top:10px}',
    '.ivq{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;padding:10px 0;border-bottom:1px dashed var(--isd)}',
    '.ivq .t{flex:1 1 260px;min-width:0}',
    '.ivq .t b{display:block;font-size:14.5px;font-weight:600;line-height:1.35}',
    '.ivq .t span{display:block;font-size:12.5px;color:#6b5a48;margin-top:2px;line-height:1.4}',
    '.ivs{display:flex;gap:6px;flex:0 0 auto}',
    '.ivs button{width:46px;height:46px;border:1px solid var(--isd);background:#fff;border-radius:5px;font-size:16px;font-weight:600;color:var(--ik);cursor:pointer;font-family:"DM Sans",sans-serif}',
    '.ivs button.on{background:var(--iv);color:#fff;border-color:var(--iv)}',
    '.ivnotes{width:100%;box-sizing:border-box;min-height:90px;font-family:"DM Sans",sans-serif;font-size:15px;border:1px solid var(--isd);border-radius:5px;background:var(--isl);padding:10px;color:var(--ik)}',
    '.ivempty{padding:26px 10px;color:#6b5a48;font-size:14px}',
    '.ivgate{max-width:420px;margin:30px auto;background:#fff;border:2px solid var(--iv);border-radius:6px;padding:18px}',
    '.ivgate b{display:block;font-size:16px;margin-bottom:10px}',
    '.ivgate input{font-size:22px;letter-spacing:.3em;text-align:center;width:150px;min-height:48px;border:1px solid var(--isd);border-radius:4px;margin-right:8px}',
    '.iverr{color:var(--iv);font-weight:600;font-size:13.5px;margin-top:10px}',
    '.ivtab{width:100%;border-collapse:collapse;font-size:14px;background:#fff;border:1px solid var(--isd);border-radius:6px;overflow:hidden}',
    '.ivtab th{text-align:left;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--ivl);background:var(--isl);padding:10px}',
    '.ivtab td{padding:11px 10px;border-top:1px solid var(--isl);vertical-align:middle}',
    '.ivtab td.n{font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.ivtab tr{cursor:pointer}',
    '.ivbar{display:inline-block;width:80px;height:6px;background:var(--isl);border-radius:3px;vertical-align:middle;margin-right:8px;overflow:hidden}',
    '.ivbar i{display:block;height:100%;background:var(--iv)}',
    '.ivsync{font-size:11.5px;color:#6b5a48;text-align:right;margin-top:10px}',
    '.ivcvs{background:var(--icr);border:1px solid var(--isd);border-radius:6px;padding:10px 12px;margin:10px 0 2px}',
    '.ivcvs .hd{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
    '.ivcvs .hd b{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--ivl)}',
    '.ivcvup{margin-left:auto;display:inline-flex;align-items:center;font-size:14px;font-weight:600;background:var(--iv);color:var(--icr);border-radius:4px;padding:0 16px;min-height:46px;cursor:pointer}',
    '.ivcvup input{display:none}',
    '.ivcvup.busy{opacity:.6;pointer-events:none}',
    '.ivcvf{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:#fff;border:1px solid var(--isd);border-radius:5px;padding:6px 8px;margin-top:8px}',
    '.ivcvf .nm{flex:1 1 160px;min-width:0;font-size:14px;font-weight:600;overflow-wrap:anywhere}',
    '.ivcvf .nm span{display:block;font-size:11.5px;font-weight:400;color:#6b5a48}',
    '.ivcvf button{min-height:44px;padding:0 14px;border-radius:4px;font-weight:600;cursor:pointer;font-family:"DM Sans",sans-serif;font-size:14px}',
    '.ivcvf .v{background:var(--iv);color:#fff;border:1px solid var(--iv)}',
    '.ivcvf .x{background:#fff;color:var(--iv);border:1px solid var(--isd)}',
    '.ivcvnone{font-size:13px;color:#6b5a48;margin-top:6px}',
    '.ivcand .cv{font-size:10px;font-weight:700;letter-spacing:.08em;color:var(--iol);border:1px solid var(--iol);border-radius:3px;padding:1px 4px}',
    '#ivs-viewer{position:fixed;inset:0;z-index:9000;background:rgba(20,10,5,.72);display:flex;flex-direction:column}',
    '#ivs-viewer .bar{display:flex;align-items:center;gap:8px;background:#410207;color:#f5ede0;padding:8px 10px;font-family:"DM Sans",sans-serif}',
    '#ivs-viewer .bar b{flex:1;min-width:0;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#ivs-viewer .bar a,#ivs-viewer .bar button{min-height:44px;display:inline-flex;align-items:center;padding:0 14px;border-radius:4px;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none;font-family:"DM Sans",sans-serif}',
    '#ivs-viewer .bar a{background:#f5ede0;color:#410207;border:0}',
    '#ivs-viewer .bar button{background:transparent;color:#f5ede0;border:1px solid rgba(245,237,224,.6)}',
    '#ivs-viewer .body{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;padding:12px}',
    '#ivs-viewer .page{display:block;max-width:900px;width:100%;height:auto;margin:0 auto 12px;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.3)}',
    '#ivs-viewer .doc{max-width:820px;margin:0 auto;background:#fff;padding:22px 20px;border-radius:4px;font-family:"DM Sans",sans-serif;font-size:15px;line-height:1.55;color:#2a1a10;overflow-wrap:anywhere}',
    '#ivs-viewer .doc img{max-width:100%;height:auto}',
    '#ivs-viewer .doc table{border-collapse:collapse;max-width:100%}#ivs-viewer .doc td{border:1px solid #ddd;padding:4px 6px;vertical-align:top}',
    '#ivs-viewer .msg{max-width:520px;margin:40px auto;background:#fff;padding:20px;border-radius:6px;font-family:"DM Sans",sans-serif;font-size:15px;line-height:1.5;color:#2a1a10}',
    '.ivfind{position:relative;margin-top:10px}',
    '.ivfind input{width:100%;box-sizing:border-box;font-family:"DM Sans",sans-serif;font-size:15px;min-height:46px;border:1px solid var(--isd);border-radius:4px;background:var(--isl);padding:0 38px 0 10px;color:var(--ik)}',
    '.ivfind input:focus{outline:3px solid var(--igo);outline-offset:1px;background:#fff}',
    '.ivfind input::-webkit-search-cancel-button{-webkit-appearance:none;display:none}',   // ours is the one clear button
    '.ivfind button{position:absolute;right:2px;top:1px;width:44px;height:44px;border:0;background:none;color:var(--ivl);font-size:20px;cursor:pointer}',
    '.ivfindn{font-size:12px;color:#6b5a48;margin-top:6px}',
    '.ivcand small{display:block;font-size:11.5px;font-weight:400;color:#6b5a48;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ivcand .nmw{flex:1;min-width:0}.ivcand .nmw b{display:block}',
    // the bottom strip stays clear so the "Tell us" pill never sits on the Add button
    '#ivs-bulk{position:fixed;inset:0;z-index:9000;background:rgba(20,10,5,.72);display:flex;flex-direction:column;padding-bottom:56px;box-sizing:border-box}',
    '#ivs-bulk .bar{display:flex;align-items:center;gap:8px;background:#410207;color:#f5ede0;padding:8px 10px;font-family:"DM Sans",sans-serif}',
    '#ivs-bulk .bar b{flex:1;min-width:0;font-size:15px}',
    '#ivs-bulk .bar button{min-height:44px;padding:0 14px;border-radius:4px;font-size:14px;font-weight:600;cursor:pointer;background:transparent;color:#f5ede0;border:1px solid rgba(245,237,224,.6);font-family:"DM Sans",sans-serif}',
    '#ivs-bulk .body{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;padding:12px}',
    '.ivbk{max-width:900px;margin:0 auto;background:#fff;border-radius:6px;padding:16px;font-family:"DM Sans",sans-serif;color:var(--ik)}',
    '.ivdrop{border:2px dashed var(--isd);border-radius:6px;background:var(--isl);padding:26px 14px;text-align:center}',
    '.ivdrop.over{border-color:var(--iv);background:var(--icr)}',
    '.ivdrop p{margin:0 0 14px;font-size:15px;line-height:1.45}',
    '.ivdrop .btns{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}',
    '.ivdrop label{display:inline-flex;align-items:center}.ivdrop input{display:none}',
    '.ivbkhd{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:10px}',
    '.ivbkhd .msg{flex:1 1 240px;font-size:14px;line-height:1.4}',
    '.ivbkr{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;border-top:1px solid var(--isl);padding:9px 0}',
    '.ivbkr .f{flex:1 1 200px;min-width:0;font-size:12.5px;color:#6b5a48;overflow-wrap:anywhere}',
    '.ivbkr input{flex:1 1 220px;min-width:0;font-family:"DM Sans",sans-serif;font-size:15px;min-height:44px;border:1px solid var(--isd);border-radius:4px;padding:0 10px;color:var(--ik);background:#fff}',
    '.ivbkr input:disabled{background:var(--isl);color:#6b5a48}',
    '.ivbkr .st{flex:0 0 auto;font-size:12px;font-weight:700;border-radius:20px;padding:5px 10px;background:var(--isl);color:#5a4a3a;max-width:100%;overflow-wrap:anywhere}',
    '.ivbkr .st.new{background:#e3e7d3;color:#2f4a1e}.ivbkr .st.add{background:#f3e9c4;color:#5c4700}',
    '.ivbkr .st.skip{background:#eee;color:#555}.ivbkr .st.bad{background:#f6dcdc;color:#7a1218}',
    '.ivbkr .st.ok{background:#2f4a1e;color:#fff}.ivbkr .st.run{background:var(--igo);color:#fff}',
    '.ivbkr .out{flex:0 0 auto;min-height:44px;background:#fff;border:1px solid var(--isd);color:var(--iv);border-radius:4px;padding:0 10px;font-weight:600;cursor:pointer;font-family:"DM Sans",sans-serif}',
    '.ivbkft{position:sticky;bottom:-12px;background:#fff;display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-top:2px solid var(--isd);padding:12px 0 4px;margin-top:6px}',
    '.ivbkft .sum{flex:1 1 200px;font-size:13.5px;color:#5a4a3a}',
    '.ivb:disabled{opacity:.5;cursor:default}',
    '@media(max-width:760px){',
    '  .ivgrid{grid-template-columns:1fr}',
    '  .ivdet{grid-template-columns:1fr}',
    '  .ivstats{width:100%}.ivstat{flex:1;min-width:0}',
    '  .ivs{width:100%}.ivs button{flex:1;width:auto}',
    '  .ivsum .parts{margin-left:0}',
    '  .ivtab .hm{display:none}',
    '}'
  ].join('\n');
  document.head.appendChild(s);
}

// ══════════════════════════════════════════════════════════════════════════
async function openInterviews(){
  activeStation = IVS_KEY;
  hideAllPages();
  var v = document.getElementById('interviews-view');
  v.style.display = 'block';
  document.querySelector('.footer-bar').style.display = 'flex';
  var fl = document.getElementById('foot-label'); if (fl) fl.textContent = 'Interviews';
  ivsInjectCss();
  if (!ivsCode){ try { ivsCode = localStorage.getItem(IVS_CODE_STORE) || null; } catch(e){} }
  if (!ivsCode){ ivsRender(); return; }
  v.innerHTML = '<div style="padding:40px;text-align:center;opacity:.6">Opening the scoring sheet…</div>';
  var ok = await ivsLoad();
  if (!ok && !ivsCode){ ivsRender(); return; }
  ivsRender();
  ivsStartPoll();
}

function ivsVisible(){
  var v = document.getElementById('interviews-view');
  return !!(v && v.style.display !== 'none' && activeStation === IVS_KEY);
}
function ivsStartPoll(){
  if (ivsTimer) clearInterval(ivsTimer);
  ivsTimer = setInterval(async function(){
    if (!ivsVisible() || !ivsCode){ clearInterval(ivsTimer); ivsTimer = null; return; }
    if (document.hidden) return;
    if (await ivsLoad(true)) ivsRender(true);
  }, 4000);
}

// a phone put in a pocket and taken out again catches up at once, not 4s later
document.addEventListener('visibilitychange', async function(){
  if (document.hidden || !ivsCode || !ivsVisible()) return;
  if (await ivsLoad(true)) ivsRender(true);
  if (!ivsTimer) ivsStartPoll();
});

async function ivsLoad(quiet){
  var both = await Promise.all([
    sb.rpc('interview_list',    { p_code: ivsCode, p_event: IVS_EVENT }),
    sb.rpc('interview_cv_list', { p_code: ivsCode, p_event: IVS_EVENT })
  ]);
  var r = both[0];
  if (!both[1].error) ivsCvs = both[1].data || [];
  if (r.error){
    if (/passcode/i.test(r.error.message || '')){
      ivsCode = null; try { localStorage.removeItem(IVS_CODE_STORE); } catch(e){}
      ivsErr = 'That passcode is not right.';
      return false;
    }
    if (!quiet) ivsErr = 'Could not read the scores: ' + (r.error.message || 'no connection');
    return false;
  }
  ivsErr = '';
  var fresh = r.data || [];
  // a row with a save still in flight keeps what this phone already shows
  var mine = {};
  ivsRows.forEach(function(x){ if (ivsPending[x.id]) mine[x.id] = x; });
  ivsRows.forEach(function(x){
    if (x.id === ivsSel && (ivsNameT || ivsNotesT || ivsDetTyping()) && !mine[x.id]) mine[x.id] = { old:x, partial:true };
  });
  ivsRows = fresh.map(function(x){
    var m = mine[x.id];
    if (!m) return x;
    if (!m.partial) return m;
    ivsKeepTyping(x, m.old);                 // not sent yet — the typing wins
    return x;
  });
  if (ivsSel && !ivsRows.some(function(x){ return x.id === ivsSel; })) ivsSel = null;
  return true;
}

async function ivsUnlock(){
  var inp = document.getElementById('ivs-code');
  var c = inp ? (inp.value || '').trim() : '';
  if (!c){ if (inp) inp.focus(); return; }
  ivsCode = c;
  var ok = await ivsLoad();
  if (!ok){ ivsRender(); return; }
  try { localStorage.setItem(IVS_CODE_STORE, c); } catch(e){}
  ivsRender();
  ivsStartPoll();
}
function ivsLock(){
  if (ivsBulk && ivsBulk.running){ kToast('CVs are still uploading — wait for them to finish, then lock.', true); return; }
  ivsCode = null; ivsRows = []; ivsSel = null; ivsCvs = []; ivsQ = ''; ivsViewerClose(); ivsBulkClose(true);
  try { localStorage.removeItem(IVS_CODE_STORE); } catch(e){}
  if (ivsTimer){ clearInterval(ivsTimer); ivsTimer = null; }
  ivsRender();
}

function ivsRow(id){ for (var i=0;i<ivsRows.length;i++) if (ivsRows[i].id === id) return ivsRows[i]; return null; }

async function ivsSave(id, patch){
  ivsPending[id] = (ivsPending[id] || 0) + 1;
  var r = await sb.rpc('interview_patch', { p_code: ivsCode, p_id: id, p_patch: patch });
  ivsPending[id]--;
  if (!ivsPending[id]) delete ivsPending[id];
  if (r.error){
    kToast('Not saved — ' + (r.error.message || 'no connection') + '. Tap it again.', true);
    await ivsLoad(true); ivsRender(true);
    return;
  }
  if (r.data && !ivsPending[id]){
    var i = ivsRows.findIndex(function(x){ return x.id === id; });
    if (i >= 0){
      // keep whatever the chef is typing right now
      var cur = ivsRows[i];
      ivsRows[i] = r.data;
      if (cur) ivsKeepTyping(ivsRows[i], cur);
    }
  }
}

// copy onto a fresh row every field this phone has typed but not sent yet
function ivsKeepTyping(to, from){
  if (!from) return;
  if (ivsNameT) to.name = from.name;
  if (ivsNotesT) to.notes = from.notes;
  IVS_DETAILS.forEach(function(d){ if (ivsDetT[d[0]]) to[d[0]] = from[d[0]]; });
}

async function ivsAdd(){
  var r = await sb.rpc('interview_add', { p_code: ivsCode, p_event: IVS_EVENT });
  if (r.error){ kToast('Could not add — ' + (r.error.message || 'no connection'), true); return; }
  ivsRows.push(r.data);
  ivsQ = '';                                        // a search would hide the new, unnamed row
  ivsSel = r.data.id; ivsTab = 'score';
  ivsRender();
  var n = document.getElementById('ivs-name'); if (n) n.focus();
}

function ivsPick(id){
  ivsSel = id; ivsTab = 'score'; ivsRender();
  // on a phone the list sits above the sheet — a long list would leave the sheet off-screen
  var ed = document.getElementById('ivs-editor');
  if (ed && window.matchMedia('(max-width:760px)').matches) ed.scrollIntoView({ block:'start' });
  else window.scrollTo(0, 0);
}

function ivsScore(key, val){
  var row = ivsRow(ivsSel); if (!row) return;
  var sc = Object.assign({}, row.scores || {});
  var next = (+sc[key] === val) ? null : val;       // tap the same number again to clear it
  if (next === null) delete sc[key]; else sc[key] = next;
  row.scores = sc;
  var p = {}; p[key] = next;
  ivsSave(row.id, { scores: p });
  ivsRender(true);
}

function ivsName(el){
  var row = ivsRow(ivsSel); if (!row) return;
  row.name = el.value;
  var id = row.id, val = el.value;
  clearTimeout(ivsNameT);
  ivsNameT = setTimeout(function(){ ivsNameT = null; ivsSave(id, { name: val }); }, 600);
  ivsRenderList();
}
function ivsNotes(el){
  var row = ivsRow(ivsSel); if (!row) return;
  row.notes = el.value;
  var id = row.id, val = el.value;
  clearTimeout(ivsNotesT);
  ivsNotesT = setTimeout(function(){ ivsNotesT = null; ivsSave(id, { notes: val }); }, 800);
}
function ivsDetail(el){
  var row = ivsRow(ivsSel); if (!row) return;
  var key = el.getAttribute('data-k');
  row[key] = el.value;
  var id = row.id, val = el.value;
  clearTimeout(ivsDetT[key]);
  ivsDetT[key] = setTimeout(function(){
    ivsDetT[key] = null;
    var p = {}; p[key] = val;
    ivsSave(id, p);
  }, 700);
}
// leaving the field sends it at once — a chef who types and walks away loses nothing
function ivsDetailFlush(el){
  var key = el.getAttribute('data-k');
  if (!ivsDetT[key]) return;
  clearTimeout(ivsDetT[key]); ivsDetT[key] = null;
  var row = ivsRow(ivsSel); if (!row) return;
  var p = {}; p[key] = el.value;
  ivsSave(row.id, p);
}
function ivsDetailsHtml(r){
  var h = '<div class="ivdet">';
  IVS_DETAILS.forEach(function(d){
    var list = d[3].length ? ' list="ivs-dl-'+d[0]+'"' : '';
    h += '<label class="ivdf"><span>'+ivsEsc(d[1])+'</span>'+
      '<input id="ivs-d-'+d[0]+'" data-k="'+d[0]+'" maxlength="120" autocomplete="off"'+list+
      ' placeholder="'+ivsEsc(d[2])+'" value="'+ivsEsc(r[d[0]])+'" oninput="ivsDetail(this)" onchange="ivsDetailFlush(this)"></label>';
    if (d[3].length) h += '<datalist id="ivs-dl-'+d[0]+'">'+d[3].map(function(o){ return '<option value="'+ivsEsc(o)+'">'; }).join('')+'</datalist>';
  });
  return h + '</div>';
}

function ivsWave(el){
  var row = ivsRow(ivsSel); if (!row) return;
  row.wave = el.value;
  ivsSave(row.id, { wave: el.value });
  ivsRenderList();
}

async function ivsDelete(){
  var row = ivsRow(ivsSel); if (!row) return;
  var nm = row.name || 'this unnamed candidate';
  if (!confirm('Delete ' + nm + ' and all their scores?\n\nThis removes them for all four interviewers and cannot be undone.')) return;
  var r = await sb.rpc('interview_delete', { p_code: ivsCode, p_id: row.id });
  if (r.error){ kToast('Not deleted — ' + (r.error.message || 'no connection'), true); return; }
  ivsRows = ivsRows.filter(function(x){ return x.id !== row.id; });
  ivsCvs = ivsCvs.filter(function(x){ return x.candidate_id !== row.id; });
  ivsSel = null;
  ivsRender();
}

// ══════════════════════════════════════════════════════════════════════════
// rendering
// ══════════════════════════════════════════════════════════════════════════
function ivsStatsHtml(){
  var done = ivsRows.map(ivsCalc).filter(function(c){ return c.done; });
  var avg = done.length ? Math.round(done.reduce(function(a,c){ return a + c.final; }, 0) / done.length) : null;
  var hire = done.filter(function(c){ return c.verdict.hire; }).length;
  // "Seen" = scoring has started. A CV loaded the night before is a candidate, not someone seen.
  var seen = ivsRows.filter(function(r){ return ivsCalc(r).scored > 0; }).length;
  return '<div class="ivstats">'+
    '<div class="ivstat"><b>'+ivsRows.length+'</b><span>Candidates</span></div>'+
    '<div class="ivstat"><b>'+seen+'</b><span>Seen</span></div>'+
    '<div class="ivstat"><b>'+(avg==null?'—':avg)+'</b><span>Avg score</span></div>'+
    '<div class="ivstat"><b>'+hire+'</b><span>Hire+</span></div>'+
  '</div>';
}

function ivsCandLabel(r){ return r.name && r.name.trim() ? r.name : 'Unnamed candidate'; }

// the buttons and the search box sit OUTSIDE #ivs-list, so a poll redrawing the
// list never takes the search box out from under the chef's typing
function ivsListShellHtml(){
  return '<div class="ivlbl">Candidates</div>'+
    '<button class="ivb" style="width:100%" onclick="ivsAdd()">+ Add candidate</button>'+
    '<button class="ivb2" style="width:100%;margin-top:7px" onclick="ivsBulkOpen()">Add CVs in bulk</button>'+
    '<div class="ivfind"><input id="ivs-search" type="search" placeholder="Search candidates" aria-label="Search candidates" autocomplete="off" value="'+ivsEsc(ivsQ)+'" oninput="ivsSearch(this)" onkeydown="ivsSearchKey(event)">'+
    (ivsQ ? '<button type="button" aria-label="Clear search" onclick="ivsSearchClear()">&times;</button>' : '')+'</div>'+
    '<div id="ivs-list">'+ivsListHtml()+'</div>';
}

// lower-case, accents off, anything that is not a letter or digit becomes a space
function ivsNorm(s){
  return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
// every word typed must appear somewhere: name, wave, notes, the candidate details or a CV file name
function ivsMatches(r, q){
  var words = ivsNorm(q).split(' ').filter(Boolean);
  if (!words.length) return true;
  var hay = ' ' + ivsNorm([ivsCandLabel(r), r.wave, r.notes]
    .concat(IVS_DETAILS.map(function(d){ return r[d[0]]; }))
    .concat(ivsCvsFor(r.id).map(function(c){ return c.filename; })).join(' '));
  return words.every(function(w){ return hay.indexOf(w) >= 0; });
}
// a hit that is not in the name says where it was found, or the row looks like a wrong match
function ivsWhere(r, q){
  var words = ivsNorm(q).split(' ').filter(Boolean);
  var nm = ivsNorm(ivsCandLabel(r));
  if (words.every(function(w){ return nm.indexOf(w) >= 0; })) return '';
  if (words.some(function(w){ return ivsNorm(r.notes).indexOf(w) >= 0; })) return 'found in notes';
  if (words.some(function(w){ return ivsNorm(r.wave).indexOf(w) >= 0; })) return r.wave;
  var det = IVS_DETAILS.filter(function(d){ return words.some(function(w){ return ivsNorm(r[d[0]]).indexOf(w) >= 0; }); })[0];
  if (det) return det[1] + ': ' + r[det[0]];
  return 'found in CV file name';
}
function ivsFiltered(){ return ivsRows.filter(function(r){ return ivsMatches(r, ivsQ); }); }

function ivsSearch(el){
  ivsQ = el.value;
  var el2 = document.getElementById('ivs-list'); if (el2) el2.innerHTML = ivsListHtml();
  var box = el.parentNode, x = box.querySelector('button');
  if (ivsQ && !x) box.insertAdjacentHTML('beforeend', '<button type="button" aria-label="Clear search" onclick="ivsSearchClear()">&times;</button>');
  if (!ivsQ && x) x.remove();
}
function ivsSearchKey(e){
  if (e.key === 'Escape' && ivsQ){ e.preventDefault(); ivsSearchClear(); }
  if (e.key === 'Enter'){
    var hits = ivsFiltered();
    if (hits.length){ e.preventDefault(); e.target.blur(); ivsPick(hits[0].id); }
  }
}
function ivsSearchClear(){
  ivsQ = '';
  var el = document.getElementById('ivs-search');
  if (el){ el.value = ''; ivsSearch(el); el.focus(); }
}

function ivsListHtml(){
  if (!ivsRows.length) return '<div class="ivempty">No candidates yet. Add the first one above, or add a folder of CVs in bulk.</div>';
  var hits = ivsFiltered(), h = '';
  if (ivsQ.trim()){
    h += '<div class="ivfindn">'+(hits.length ? hits.length+' of '+ivsRows.length+' candidates' : 'No candidate matches “'+ivsEsc(ivsQ.trim())+'”')+'</div>';
  }
  hits.forEach(function(r){
    var c = ivsCalc(r), where = ivsQ.trim() ? ivsWhere(r, ivsQ) : '';
    h += '<button class="ivcand'+(r.id===ivsSel?' on':'')+'" onclick="ivsPick(\''+r.id+'\')">'+
      '<span class="ivdot'+(c.done?' done':(c.scored?' part':''))+'"></span>'+
      '<span class="nmw"><b>'+ivsEsc(ivsCandLabel(r))+'</b>'+(where ? '<small>'+ivsEsc(where)+'</small>' : '')+'</span>'+
      (ivsCvsFor(r.id).length?'<span class="cv">CV</span>':'')+'<i>'+(c.done ? c.final : (c.scored ? c.scored+'/15' : '—'))+'</i></button>';
  });
  return h;
}
function ivsRenderList(){
  var el = document.getElementById('ivs-list'); if (el) el.innerHTML = ivsListHtml();
  var st = document.getElementById('ivs-stats'); if (st) st.outerHTML = '<div id="ivs-stats">'+ivsStatsHtml()+'</div>';
}

function ivsSumHtml(r){
  var c = ivsCalc(r);
  var pill = c.done ? '<span class="ivpill '+c.verdict.c+'">'+c.verdict.t+'</span>'
                    : '<span class="ivpill">'+(c.scored ? 'In progress · '+(IVS_LINES-c.scored)+' to score' : 'Not scored')+'</span>';
  return '<div class="ivsum" id="ivs-sum">'+
    '<div class="big">'+(c.done ? c.final : '—')+'<small> / 100</small></div>'+ pill +
    '<div class="parts"><div><b>'+c.int+'/50</b><span>Interview (40%)</span></div>'+
    '<div><b>'+c.prac+'/25</b><span>Practical (60%)</span></div></div>'+
  '</div>';
}

function ivsEditorHtml(){
  var r = ivsRow(ivsSel);
  if (!r) return '<div class="ivempty">Select a candidate on the left, or add a new one.</div>';
  var sc = r.scores || {};
  var h = '<div class="ivtop">'+
    '<input id="ivs-name" class="ivname" placeholder="Candidate name" value="'+ivsEsc(r.name)+'" oninput="ivsName(this)" autocomplete="off">'+
    '<select class="ivsel" onchange="ivsWave(this)" aria-label="Wave">'+
      IVS_WAVES.map(function(w){ return '<option value="'+ivsEsc(w)+'"'+(w===(r.wave||'')?' selected':'')+'>'+(w||'Unassigned')+'</option>'; }).join('')+
    '</select>'+
    '<button class="ivdel" onclick="ivsDelete()">Delete</button>'+
  '</div>' + ivsDetailsHtml(r) + ivsSumHtml(r) + ivsCvsHtml(r);
  IVS_SECTIONS.forEach(function(s){
    h += '<div class="ivsec">'+ivsEsc(s.title)+'</div>';
    s.items.forEach(function(it){
      var cur = +sc[it[0]] || 0;
      h += '<div class="ivq"><div class="t"><b>'+(it[0].charAt(0)==='P'?'':ivsEsc(it[0])+'. ')+ivsEsc(it[1])+'</b><span>'+ivsEsc(it[2])+'</span></div><div class="ivs" data-k="'+it[0]+'">';
      for (var n=1;n<=5;n++) h += '<button type="button" class="'+(cur===n?'on':'')+'" aria-pressed="'+(cur===n)+'" onclick="ivsScore(\''+it[0]+'\','+n+')">'+n+'</button>';
      h += '</div></div>';
    });
  });
  h += '<div class="ivsec">Notes</div>'+
    '<textarea id="ivs-notes" class="ivnotes" placeholder="Anything worth remembering — knife confidence, attitude, timing issues…" oninput="ivsNotes(this)">'+ivsEsc(r.notes)+'</textarea>';
  return h;
}

// ══════════════════════════════════════════════════════════════════════════
// CVs
// ══════════════════════════════════════════════════════════════════════════
function ivsCvsFor(id){ return ivsCvs.filter(function(c){ return c.candidate_id === id; }); }
function ivsKb(n){ return n >= 1048576 ? (n/1048576).toFixed(1)+' MB' : Math.max(1, Math.round(n/1024))+' KB'; }
function ivsCvKind(name, mime){
  var n = String(name||'').toLowerCase(), m = String(mime||'').toLowerCase();
  if (/\.pdf$/.test(n) || m === 'application/pdf') return 'pdf';
  if (/\.docx$/.test(n) || m.indexOf('wordprocessingml') >= 0) return 'docx';
  if (/\.doc$/.test(n) || m === 'application/msword') return 'doc';
  if (/\.(jpe?g|png|webp|heic|heif)$/.test(n) || m.indexOf('image/') === 0) return 'image';
  return '';
}

function ivsCvsHtml(r){
  var list = ivsCvsFor(r.id), busy = ivsCvBusy === r.id;
  var h = '<div class="ivcvs" id="ivs-cvs"><div class="hd"><b>CV</b>'+
    '<label class="ivcvup'+(busy?' busy':'')+'">'+(busy ? 'Uploading…' : (list.length ? '+ Add another' : 'Upload CV'))+
    '<input type="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*" onchange="ivsCvUpload(this,\''+r.id+'\')"></label></div>';
  if (!list.length) h += '<div class="ivcvnone">No CV yet — Word, PDF, or a photo of a paper CV.</div>';
  list.forEach(function(c){
    h += '<div class="ivcvf"><div class="nm">'+ivsEsc(c.filename)+'<span>'+ivsKb(c.size_bytes)+'</span></div>'+
      '<button class="v" onclick="ivsCvView(\''+c.id+'\')">Open</button>'+
      '<button class="x" onclick="ivsCvDelete(\''+c.id+'\')">Remove</button></div>';
  });
  return h + '</div>';
}
function ivsCvRefresh(){
  var r = ivsRow(ivsSel), el = document.getElementById('ivs-cvs');
  if (r && el) el.outerHTML = ivsCvsHtml(r);
  ivsRenderList();
}

function ivsCvUpload(input, candId){
  var f = input.files && input.files[0];
  input.value = '';
  if (!f) return;
  if (!ivsCvKind(f.name, f.type)){ kToast('That file type cannot be opened here. Use Word, PDF or a photo.', true); return; }
  if (f.size > IVS_CV_MAX){ kToast(f.name+' is '+ivsKb(f.size)+'. The limit is 8 MB — save it smaller or take a photo.', true); return; }
  var rd = new FileReader();
  rd.onerror = function(){ kToast('Could not read that file on this device.', true); };
  rd.onload = async function(){
    var b64 = String(rd.result).split(',')[1] || '';
    ivsCvBusy = candId; ivsCvRefresh();
    var r = await sb.rpc('interview_cv_add', { p_code: ivsCode, p_candidate: candId,
      p_filename: f.name, p_mime: f.type || '', p_b64: b64 });
    ivsCvBusy = null;
    if (r.error){ ivsCvRefresh(); kToast('CV not saved — ' + (r.error.message || 'no connection') + '. Try again.', true); return; }
    var row = Array.isArray(r.data) ? r.data[0] : r.data;
    if (row) ivsCvs.push(row);
    ivsCvRefresh();
    kToast('CV saved — ' + f.name);
  };
  rd.readAsDataURL(f);
}

async function ivsCvDelete(id){
  var c = ivsCvs.filter(function(x){ return x.id === id; })[0]; if (!c) return;
  if (!confirm('Remove ' + c.filename + ' from this candidate?\n\nIt is removed for all four interviewers.')) return;
  var r = await sb.rpc('interview_cv_delete', { p_code: ivsCode, p_id: id });
  if (r.error){ kToast('Not removed — ' + (r.error.message || 'no connection'), true); return; }
  ivsCvs = ivsCvs.filter(function(x){ return x.id !== id; });
  ivsCvRefresh();
}

function ivsViewerClose(){
  var v = document.getElementById('ivs-viewer');
  if (v){ if (v._url) URL.revokeObjectURL(v._url); v.remove(); }
  document.removeEventListener('keydown', ivsViewerKey);
}
function ivsViewerKey(e){ if (e.key === 'Escape') ivsViewerClose(); }

async function ivsCvView(id){
  var c = ivsCvs.filter(function(x){ return x.id === id; })[0]; if (!c) return;
  ivsViewerClose();
  var kind = ivsCvKind(c.filename, c.mime);
  var v = document.createElement('div'); v.id = 'ivs-viewer';
  v.innerHTML = '<div class="bar"><b>'+ivsEsc(c.filename)+'</b><span id="ivs-dl"></span>'+
    '<button onclick="ivsViewerClose()">Close</button></div><div class="body"><div class="msg">Opening the CV…</div></div>';
  document.body.appendChild(v);
  document.addEventListener('keydown', ivsViewerKey);
  var body = v.querySelector('.body');

  var r = await sb.rpc('interview_cv_get', { p_code: ivsCode, p_id: id });
  if (!document.body.contains(v)) return;
  if (r.error){ body.innerHTML = '<div class="msg">Could not open it — '+ivsEsc(r.error.message || 'no connection')+'.</div>'; return; }
  var bin = atob(r.data), bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  var mime = c.mime || ({pdf:'application/pdf', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc:'application/msword'})[kind] || 'application/octet-stream';
  v._url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  v.querySelector('#ivs-dl').innerHTML = '<a href="'+v._url+'" download="'+ivsEsc(c.filename)+'">Download</a>';

  try {
    if (kind === 'image'){
      body.innerHTML = '<img class="page" alt="CV" src="'+v._url+'">';
    } else if (kind === 'pdf'){
      var P = await ivsLib('lib/pdf.min.js', 'pdfjsLib');
      try { P.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js'; } catch(e){}
      var pdf = await P.getDocument({ data: bytes.slice() }).promise;
      body.innerHTML = '';
      for (var pg = 1; pg <= pdf.numPages; pg++){
        if (!document.body.contains(v)) return;
        var page = await pdf.getPage(pg);
        var vp = page.getViewport({ scale: 2 });
        var cv = document.createElement('canvas');
        cv.className = 'page'; cv.width = vp.width; cv.height = vp.height;
        body.appendChild(cv);
        await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
      }
    } else if (kind === 'docx'){
      var M = await ivsLib(IVS_MAMMOTH, 'mammoth');
      var out = await M.convertToHtml({ arrayBuffer: bytes.buffer });
      var d = document.createElement('div'); d.className = 'doc';
      d.innerHTML = out.value || '<p><i>This Word file has no readable text.</i></p>';
      d.querySelectorAll('script,iframe,object,embed,link,style').forEach(function(x){ x.remove(); });
      d.querySelectorAll('*').forEach(function(x){
        [].slice.call(x.attributes).forEach(function(a){
          if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) x.removeAttribute(a.name);
        });
      });
      body.innerHTML = ''; body.appendChild(d);
    } else {
      body.innerHTML = '<div class="msg"><b>This is an old Word file (.doc).</b> A browser cannot show it. '+
        'Tap <b>Download</b> above to open it in Word, or ask the candidate for a PDF.</div>';
    }
  } catch(e){
    body.innerHTML = '<div class="msg">This file could not be shown here ('+ivsEsc(e && e.message || 'unknown error')+'). '+
      'Tap <b>Download</b> above to open it.</div>';
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Bulk CVs — a folder (or a pile of files) in, one candidate per CV out.
// Nothing is written until the chef has seen every name and pressed Add.
// ══════════════════════════════════════════════════════════════════════════
var IVS_NOT_NAME = ['resume','curriculum','vitae','cv','biodata','profile','objective','contact','summary',
  'personal','details','detail','information','info','experience','education','skills','career','address',
  'email','phone','mobile','nationality','reference','references','declaration','languages','hobbies',
  'commis','chef','cook','kitchen','helper','steward','dubai','uae','name','job','new','seeking','position',
  'application','cover','letter','hotel','restaurant','cuisine','dining','and','the','with','for','exposure'];   // never countries: "Dhanraj Nepal" is a name

function ivsPdf(){
  return ivsLib('lib/pdf.min.js', 'pdfjsLib').then(function(P){
    try { P.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js'; } catch(e){}
    return P;
  });
}

// "BHUP BAHADUR" -> "Bhup Bahadur"; initials such as "B.K" or "S." stay as they are
function ivsTitle(s){
  var t = String(s||'').replace(/\s+/g, ' ').trim();
  var letters = t.replace(/[^A-Za-z]/g, '');
  if (letters !== letters.toUpperCase() && letters !== letters.toLowerCase()) return t;   // already mixed case
  return t.split(' ').map(function(w){
    return w.replace(/[^A-Za-z]/g, '').length <= 2 && /[.]/.test(w) ? w.toUpperCase()
      : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}
// a line that could be a person's name: 2-5 words of letters, no digits, no CV headings
function ivsNameish(line){
  var t = String(line||'').replace(/\s+/g, ' ').trim();
  if (t.length < 4 || t.length > 48) return '';
  if (!/^[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ.'’\- ]+$/.test(t)) return '';
  var words = t.split(' ');
  if (words.length < 2 || words.length > 5) return '';
  if (/[A-Za-z]{3,}\.$/.test(t)) return '';                 // ends like a sentence, not like "S." or "B.K."
  if (words.some(function(w){ return IVS_NOT_NAME.indexOf(w.toLowerCase().replace(/[^a-z]/g, '')) >= 0; })) return '';
  return t;
}
// "Name: John Doe" beats any guess
function ivsLabelledName(lines){
  for (var i = 0; i < lines.length; i++){
    var m = /^\s*(full\s+)?name\s*[:\-]\s*(.+)$/i.exec(lines[i]);
    if (m && ivsNameish(m[2])) return ivsNameish(m[2]);
  }
  return '';
}
// the file name as a last resort: "ResumeJamilKajumba.pdf" -> "Jamil Kajumba"
function ivsNameFromFile(fn){
  var t = String(fn||'').replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-.,+()\[\]]+/g, ' ').replace(/\d+/g, ' ');
  t = t.split(/\s+/).filter(function(w){
    return w && ['resume','cv','curriculum','vitae','final','updated','new','copy','of'].indexOf(w.toLowerCase()) < 0;
  }).join(' ');
  t = t.replace(/^(resume|cv)(?=[A-Z])/i, '');
  return ivsTitle(t);
}

// How many of the line's words also sit in the file name. "ResumeDhanrajNepal.pdf"
// backs "DHANRAJ NEPAL" and not the heading "Italian Fine Dining" in bigger type.
function ivsFileHits(text, fn){
  var f = ivsNorm(fn).replace(/ /g, '');
  // 4+ letters: "new" in "Someone new.pdf" must not crown the heading "New Job"
  return ivsNorm(text).split(' ').filter(function(w){ return w.length >= 4 && f.indexOf(w) >= 0; }).length;
}
// most file-name words, then biggest type, then more of the name, then nearest the top
function ivsBestName(cands, fn){
  var best = null;
  cands.forEach(function(c){
    var t = ivsNameish(c.text); if (!t) return;
    c.hits = ivsFileHits(t, fn); c.words = t.split(' ').length; c.text = t;
    if (!best || c.hits > best.hits || (c.hits === best.hits && (c.size > best.size ||
        (c.size === best.size && (c.words > best.words || (c.words === best.words && c.y > best.y)))))) best = c;
  });
  // no line agrees with the file name, but the file name is itself a clean name: trust it
  var fromFile = ivsNameish(ivsNameFromFile(fn));
  if (fromFile && (!best || (!best.hits && ivsFileHits(fromFile, fn) >= 2))) return fromFile;
  return best ? best.text : '';
}

async function ivsReadName(file, kind){
  if (kind === 'pdf'){
    var P = await ivsPdf();
    var pdf = await P.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    try {
      var page = await pdf.getPage(1), tc = await page.getTextContent(), byY = {};
      // one line per baseline, whatever the type size ("YOGENDERA" 15pt + "SINGH" 16pt)
      tc.items.forEach(function(it){
        if (!it.str || !it.str.trim()) return;
        var size = Math.round(Math.hypot(it.transform[2], it.transform[3]) * 2) / 2 || Math.round(it.height);
        var y = Math.round(it.transform[5]);
        var L = byY[y] || byY[y-1] || byY[y+1];
        if (!L){ L = byY[y] = { y: y, size: 0, parts: [] }; }
        L.size = Math.max(L.size, size);
        L.parts.push({ x: it.transform[4], s: it.str });
      });
      var lines = Object.keys(byY).map(function(k){
        var L = byY[k];
        L.text = L.parts.sort(function(a,b){ return a.x - b.x; }).map(function(p){ return p.s; }).join(' ').replace(/\s+/g, ' ').trim();
        if (/^([A-Za-z] )+[A-Za-z]$/.test(L.text)) L.text = L.text.replace(/ /g, '');   // "J O H N" letter-spaced
        return L;
      }).sort(function(a,b){ return b.y - a.y; });
      var lab = ivsLabelledName(lines.map(function(L){ return L.text; }));
      if (lab) return ivsTitle(lab);
      // a name set over two or three lines in the same type: "DHANRAJ" / "NEPAL"
      var cands = lines.map(function(L){ return { text: L.text, size: L.size, y: L.y }; });
      lines.forEach(function(L, i){
        var txt = L.text, last = L, joined = 0;
        for (var j = i + 1; j < lines.length && joined < 2; j++){
          var N = lines[j];
          if (last.y - N.y > L.size * 1.9) break;
          if (Math.abs(N.size - L.size) > 0.5) continue;   // a phone number in the next column, smaller type
          if (!/^[A-Za-zÀ-ɏ.'’\- ]+$/.test(N.text) || N.text.split(' ').length > 3) break;
          txt += ' ' + N.text; last = N; joined++;
          cands.push({ text: txt, size: L.size, y: L.y });
        }
      });
      var got = ivsBestName(cands, file.name);
      return got ? ivsTitle(got) : '';
    } finally { try { pdf.destroy(); } catch(e){} }
  }
  if (kind === 'docx'){
    var M = await ivsLib(IVS_MAMMOTH, 'mammoth');
    var out = await M.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    var ls = String(out.value || '').split(/\n+/).map(function(s){ return s.trim(); }).filter(Boolean).slice(0, 20);
    var l2 = ivsLabelledName(ls);
    if (l2) return ivsTitle(l2);
    // no type sizes in raw text: earlier lines rank higher
    var got2 = ivsBestName(ls.map(function(s, i){ return { text: s, size: 0, y: -i }; }), file.name);
    return got2 ? ivsTitle(got2) : '';
  }
  return '';
}

// everything a dropped folder holds, subfolders included
function ivsEntryFiles(entry){
  return new Promise(function(resolve){
    if (entry.isFile){
      entry.file(function(f){
        try { Object.defineProperty(f, 'ivsPath', { value: (entry.fullPath || f.name).replace(/^\//, '') }); } catch(e){}
        resolve([f]);
      }, function(){ resolve([]); });
      return;
    }
    if (!entry.isDirectory){ resolve([]); return; }
    var rd = entry.createReader(), got = [];
    (function more(){
      rd.readEntries(async function(ents){
        if (!ents.length){
          var lists = [];
          for (var i = 0; i < got.length; i++) lists.push(await ivsEntryFiles(got[i]));
          resolve([].concat.apply([], lists));
          return;
        }
        got = got.concat([].slice.call(ents)); more();
      }, function(){ resolve([]); });
    })();
  });
}

function ivsBulkOpen(){
  if (ivsBulk) return;
  ivsBulk = { rows: [], reading: false, running: false, stopped: false, wave: '', seq: 0 };
  var v = document.createElement('div'); v.id = 'ivs-bulk';
  v.setAttribute('role', 'dialog'); v.setAttribute('aria-label', 'Add CVs in bulk');
  document.body.appendChild(v);
  document.addEventListener('keydown', ivsBulkKey);
  ivsBulkRender();
}
function ivsBulkKey(e){ if (e.key === 'Escape' && !(e.target && e.target.closest && e.target.closest('.ivbkr'))) ivsBulkClose(); }
function ivsBulkClose(force){
  var b = ivsBulk;
  if (!b) return;
  if (!force && b.running){
    if (!confirm('CVs are still uploading.\n\nStop after the one in progress? Those already added stay on the board.')) return;
    b.stopped = true; return;
  }
  if (!force && !b.running && b.rows.some(function(r){ return r.state === 'ready'; }) &&
      !confirm('Close without adding these CVs?')) return;
  ivsBulk = null;
  var v = document.getElementById('ivs-bulk'); if (v) v.remove();
  document.removeEventListener('keydown', ivsBulkKey);
  ivsRenderList();
}

function ivsCvDupe(file){
  var fn = file.name.toLowerCase();
  return ivsCvs.filter(function(c){ return String(c.filename).toLowerCase() === fn && +c.size_bytes === file.size; })[0] || null;
}
function ivsCandByName(name){
  var n = ivsNorm(name); if (!n) return null;
  return ivsRows.filter(function(r){ return ivsNorm(r.name) === n; })[0] || null;
}

// what will happen to this row if Add is pressed — worked out again every time a name changes
function ivsBulkPlan(row){
  if (row.state === 'done' || row.state === 'run' || row.state === 'fail') return;
  if (row.problem){ row.state = 'bad'; return; }
  var dupe = ivsCvDupe(row.file);
  if (dupe){
    var owner = ivsRow(dupe.candidate_id);
    row.state = 'skip'; row.note = 'Already on the board' + (owner ? ' — ' + ivsCandLabel(owner) : ''); return;
  }
  var twin = ivsBulk.rows.filter(function(o){
    return o !== row && o.seq < row.seq && !o.problem && o.file.name.toLowerCase() === row.file.name.toLowerCase() && o.file.size === row.file.size;
  })[0];
  if (twin){ row.state = 'skip'; row.note = 'Same file twice in this folder'; return; }
  if (!row.left) {
    var name = (row.name || '').trim();
    if (!name){ row.state = 'bad'; row.note = 'Type the candidate’s name'; return; }
    var ex = ivsCandByName(name);
    row.state = 'ready';
    row.note = ex ? 'CV goes to ' + ivsCandLabel(ex) + ' (already on the board)' : 'New candidate';
    row.cls = ex ? 'add' : 'new';
  } else { row.state = 'skip'; row.note = 'Left out'; }
}

async function ivsBulkAddFiles(list){
  var b = ivsBulk; if (!b || b.running) return;
  var files = [].slice.call(list || []);
  if (!files.length) return;
  files.forEach(function(f){
    var kind = ivsCvKind(f.name, f.type), row = { seq: ++b.seq, file: f, kind: kind, path: f.ivsPath || f.webkitRelativePath || f.name,
      name: ivsNameFromFile(f.name), edited: false, reading: !!kind && (kind === 'pdf' || kind === 'docx') && f.size <= IVS_CV_MAX };
    if (/^\./.test(f.name) || /^~\$/.test(f.name)) return;       // .DS_Store, Word lock files
    if (!kind) row.problem = 'Not a CV file — skipped';
    else if (f.size > IVS_CV_MAX) row.problem = 'Over 8 MB (' + ivsKb(f.size) + ') — save it smaller';
    else if (!f.size) row.problem = 'Empty file';
    if (row.problem){ row.note = row.problem; row.reading = false; }
    b.rows.push(row);
  });
  b.rows.forEach(ivsBulkPlan);
  ivsBulkRender();
  if (b.reading) return;                                  // the loop already running picks the new rows up
  b.reading = true;
  for (;;){
    if (ivsBulk !== b) return;
    var next = b.rows.filter(function(r){ return r.reading; })[0];
    if (!next) break;
    try {
      var got = await ivsReadName(next.file, next.kind);
      if (got && !next.edited) next.name = got;
    } catch(e){ /* unreadable here — the file name stands and the chef can type it */ }
    next.reading = false;
    ivsBulkPlan(next);
    ivsBulkRender();
  }
  b.reading = false;
  b.rows.forEach(ivsBulkPlan);
  ivsBulkRender();
}

function ivsBulkPick(input){ var f = input.files; ivsBulkAddFiles(f); input.value = ''; }

async function ivsBulkDrop(e){
  e.preventDefault();
  var z = document.getElementById('ivs-drop'); if (z) z.classList.remove('over');
  var dt = e.dataTransfer; if (!dt) return;
  var items = dt.items ? [].slice.call(dt.items) : [];
  var entries = items.map(function(it){ return it.webkitGetAsEntry ? it.webkitGetAsEntry() : null; }).filter(Boolean);
  if (entries.length){
    var lists = [];
    for (var i = 0; i < entries.length; i++) lists.push(await ivsEntryFiles(entries[i]));
    ivsBulkAddFiles([].concat.apply([], lists));
  } else ivsBulkAddFiles(dt.files);
}
function ivsBulkOver(e, on){
  e.preventDefault();
  var z = document.getElementById('ivs-drop'); if (z) z.classList.toggle('over', on);
}

function ivsBulkName(el, seq){
  var row = ivsBulk && ivsBulk.rows.filter(function(r){ return r.seq === seq; })[0]; if (!row) return;
  row.name = el.value; row.edited = true;
  ivsBulkPlan(row);
  var st = document.getElementById('ivs-bst-' + seq);
  if (st){ st.className = 'st ' + ivsBulkCls(row); st.textContent = row.note || ''; }
  ivsBulkFoot();
}
function ivsBulkLeave(seq){
  var row = ivsBulk && ivsBulk.rows.filter(function(r){ return r.seq === seq; })[0]; if (!row) return;
  row.left = !row.left;
  if (!row.left) row.state = '';
  ivsBulkPlan(row); ivsBulkRender();
}
function ivsBulkCls(r){
  return r.reading ? 'run' : r.state === 'ready' ? (r.cls || 'new') : r.state === 'done' ? 'ok' : r.state === 'run' ? 'run'
    : r.state === 'fail' || r.state === 'bad' ? 'bad' : 'skip';
}

function ivsBulkCounts(){
  var b = ivsBulk, c = { ready:0, newc:0, attach:0, done:0, fail:0, skip:0, bad:0, reading:0 };
  b.rows.forEach(function(r){
    if (r.reading) c.reading++;
    if (r.state === 'ready'){ c.ready++; if (r.cls === 'add') c.attach++; else c.newc++; }
    else if (r.state === 'done') c.done++;
    else if (r.state === 'fail') c.fail++;
    else if (r.state === 'bad') c.bad++;
    else if (r.state === 'skip') c.skip++;
  });
  return c;
}
function ivsBulkFoot(){
  var el = document.getElementById('ivs-bft'); if (!el || !ivsBulk) return;
  el.outerHTML = ivsBulkFootHtml();
}
function ivsBulkFootHtml(){
  var b = ivsBulk, c = ivsBulkCounts(), bits = [];
  if (b.running){
    var total = c.ready + c.done + c.fail + b.rows.filter(function(r){ return r.state === 'run'; }).length;
    return '<div class="ivbkft" id="ivs-bft"><div class="sum"><b>Uploading '+(c.done + c.fail + 1 > total ? total : c.done + c.fail + 1)+' of '+total+'…</b> Keep this window open.</div>'+
      '<button class="ivb2" onclick="ivsBulkClose()">Stop</button></div>';
  }
  if (c.done) bits.push(c.done + ' added');
  if (c.fail) bits.push(c.fail + ' failed');
  if (c.newc) bits.push(c.newc + ' new candidate' + (c.newc === 1 ? '' : 's'));
  if (c.attach) bits.push(c.attach + ' CV' + (c.attach === 1 ? '' : 's') + ' for candidates already on the board');
  if (c.skip) bits.push(c.skip + ' skipped');
  if (c.bad) bits.push(c.bad + ' need' + (c.bad === 1 ? 's' : '') + ' attention');
  var label = c.reading ? 'Reading names… ' + c.reading + ' left'
    : c.ready ? 'Add ' + c.ready + ' CV' + (c.ready === 1 ? '' : 's') : (c.done || c.fail ? 'Done' : 'Add');
  var h = '<div class="ivbkft" id="ivs-bft"><div class="sum">'+ivsEsc(bits.join(' · ') || 'Nothing chosen yet.')+'</div>';
  if (c.fail) h += '<button class="ivb2" onclick="ivsBulkRetry()">Try the failed ones again</button>';
  if (!c.ready && (c.done || c.fail)) h += '<button class="ivb" onclick="ivsBulkClose(true)">Close</button>';
  else h += '<button class="ivb" '+(c.reading || !c.ready ? 'disabled' : '')+' onclick="ivsBulkRun()">'+ivsEsc(label)+'</button>';
  return h + '</div>';
}

function ivsBulkRender(){
  var v = document.getElementById('ivs-bulk'), b = ivsBulk;
  if (!v || !b) return;
  var keep = document.activeElement && document.activeElement.id && v.contains(document.activeElement) ? document.activeElement.id : null;
  var sy = v.querySelector('.body') ? v.querySelector('.body').scrollTop : 0;
  var folderOk = 'webkitdirectory' in document.createElement('input') && !window.matchMedia('(pointer:coarse)').matches;
  var accept = '.pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*';
  var h = '<div class="bar"><b>Add CVs in bulk</b><button onclick="ivsBulkClose()">'+(b.running ? 'Stop' : 'Close')+'</button></div>'+
    '<div class="body"><div class="ivbk">';
  if (!b.running){
    h += '<div class="ivdrop" id="ivs-drop" ondragover="ivsBulkOver(event,true)" ondragenter="ivsBulkOver(event,true)" ondragleave="ivsBulkOver(event,false)" ondrop="ivsBulkDrop(event)">'+
      '<p><b>'+(b.rows.length ? 'Add more CVs' : 'Choose the folder where the CVs are saved')+'</b><br>'+
      '<span style="font-size:13.5px;color:#6b5a48">'+(folderOk ? 'Or drag the folder or the files here. ' : 'Select them all at once. ')+'Word, PDF or photos, up to 8 MB each. '+
      'Each CV becomes one candidate — you check every name before anything is added.</span></p><div class="btns">'+
      (folderOk ? '<label class="ivb">Choose a folder<input type="file" webkitdirectory directory multiple onchange="ivsBulkPick(this)"></label>' : '')+
      '<label class="'+(folderOk ? 'ivb2' : 'ivb')+'">Choose files<input type="file" multiple accept="'+accept+'" onchange="ivsBulkPick(this)"></label>'+
      '</div></div>';
  }
  if (b.rows.length){
    h += '<div class="ivbkhd" style="margin-top:14px"><div class="msg">Check each name — it was read from the CV. Fix any that are wrong.</div>'+
      '<select class="ivsel" aria-label="Wave for new candidates" '+(b.running?'disabled ':'')+'onchange="ivsBulk.wave=this.value">'+
      IVS_WAVES.map(function(w){ return '<option value="'+ivsEsc(w)+'"'+(w===b.wave?' selected':'')+'>'+(w ? 'New candidates: '+w : 'Wave: unassigned')+'</option>'; }).join('')+
      '</select></div>';
    b.rows.forEach(function(r){
      var locked = b.running || r.problem || r.state === 'done' || r.state === 'run' || (r.state === 'skip' && !r.left) || r.left;
      var canLeave = !b.running && !r.problem && r.state !== 'done' && !(r.state === 'skip' && !r.left);
      h += '<div class="ivbkr"><div class="f">'+ivsEsc(r.path)+' · '+ivsKb(r.file.size)+'</div>'+
        '<input id="ivs-bn-'+r.seq+'" value="'+ivsEsc(r.name)+'" placeholder="Candidate name" aria-label="Candidate name for '+ivsEsc(r.file.name)+'" '+
          (locked ? 'disabled ' : '')+'oninput="ivsBulkName(this,'+r.seq+')" autocomplete="off">'+
        '<span class="st '+ivsBulkCls(r)+'" id="ivs-bst-'+r.seq+'">'+ivsEsc(r.reading ? 'Reading the name…' : (r.note || ''))+'</span>'+
        (canLeave ? '<button class="out" onclick="ivsBulkLeave('+r.seq+')">'+(r.left ? 'Put back' : 'Leave out')+'</button>' : '')+
      '</div>';
    });
    h += ivsBulkFootHtml();
  }
  h += '</div></div>';
  v.innerHTML = h;
  var body = v.querySelector('.body'); if (body) body.scrollTop = sy;
  if (keep){ var k = document.getElementById(keep); if (k){ k.focus(); try { var n = k.value.length; k.setSelectionRange(n, n); } catch(e){} } }
}

function ivsB64(file){
  return new Promise(function(resolve, reject){
    var rd = new FileReader();
    rd.onerror = function(){ reject(new Error('could not read the file on this device')); };
    rd.onload = function(){ resolve(String(rd.result).split(',')[1] || ''); };
    rd.readAsDataURL(file);
  });
}

async function ivsBulkRun(){
  var b = ivsBulk; if (!b || b.running) return;
  b.rows.forEach(ivsBulkPlan);
  if (!b.rows.some(function(r){ return r.state === 'ready'; })) return;
  b.running = true; b.stopped = false;
  ivsBulkRender();
  for (var i = 0; i < b.rows.length; i++){
    var row = b.rows[i];
    if (ivsBulk !== b || b.stopped) break;
    ivsBulkPlan(row);                                  // a candidate added earlier in this run may now own this name
    if (row.state !== 'ready') continue;
    row.state = 'run'; row.note = 'Uploading…'; ivsBulkRender();
    try {
      if (!row.candId){
        var ex = ivsCandByName(row.name);
        if (ex) row.candId = ex.id;
        else {
          var a = await sb.rpc('interview_add', { p_code: ivsCode, p_event: IVS_EVENT });
          if (a.error) throw a.error;
          var patch = { name: row.name.trim() }; if (b.wave) patch.wave = b.wave;
          ivsPending[a.data.id] = 1;                   // the poll must not show it nameless meanwhile
          var fresh = Object.assign({}, a.data, patch);
          ivsRows.push(fresh);
          row.candId = a.data.id;
          var p = await sb.rpc('interview_patch', { p_code: ivsCode, p_id: a.data.id, p_patch: patch });
          delete ivsPending[a.data.id];
          if (p.error) throw p.error;
          var k = ivsRows.findIndex(function(x){ return x.id === a.data.id; });
          if (k >= 0 && p.data) ivsRows[k] = p.data;
        }
      }
      var b64 = await ivsB64(row.file);
      var r = await sb.rpc('interview_cv_add', { p_code: ivsCode, p_candidate: row.candId,
        p_filename: row.file.name, p_mime: row.file.type || '', p_b64: b64 });
      if (r.error) throw r.error;
      var cvRow = Array.isArray(r.data) ? r.data[0] : r.data;
      if (cvRow) ivsCvs.push(cvRow);
      var owner = ivsRow(row.candId);
      row.state = 'done'; row.note = 'Added' + (owner ? ' — ' + ivsCandLabel(owner) : '');
    } catch(e){
      row.state = 'fail'; row.note = 'Not added — ' + ((e && e.message) || 'no connection');
    }
    if (ivsBulk === b){ ivsBulkRender(); ivsRenderList(); }
  }
  b.running = false;
  if (ivsBulk !== b) return;
  if (b.stopped) b.rows.forEach(function(r){ if (r.state === 'ready') { r.state = 'skip'; r.note = 'Not added — stopped'; r.left = true; } });
  ivsBulkRender(); ivsRenderList();
  var c = ivsBulkCounts();
  kToast(c.done + ' CV' + (c.done === 1 ? '' : 's') + ' added' + (c.fail ? ' · ' + c.fail + ' failed' : ''), !!c.fail);
}
function ivsBulkRetry(){
  if (!ivsBulk || ivsBulk.running) return;
  ivsBulk.rows.forEach(function(r){ if (r.state === 'fail'){ r.state = ''; ivsBulkPlan(r); } });
  ivsBulkRun();
}

function ivsLib(src, globalName){
  if (window[globalName]) return Promise.resolve(window[globalName]);
  return lazyLoad(src).then(function(){
    if (!window[globalName]) throw new Error('viewer did not load');
    return window[globalName];
  });
}

function ivsBoardHtml(){
  if (!ivsRows.length) return '<div class="ivcard"><div class="ivempty">No candidates yet.</div></div>';
  var rows = ivsRows.map(function(r){ return { r:r, c:ivsCalc(r) }; });
  rows.sort(function(a,b){
    if (a.c.done !== b.c.done) return a.c.done ? -1 : 1;
    if (a.c.done) return b.c.final - a.c.final;
    return b.c.scored - a.c.scored;
  });
  var h = '<table class="ivtab"><thead><tr><th>Rank</th><th>Candidate</th><th class="hm">Wave</th>'+
    '<th class="hm">Position</th><th class="hm">Salary exp.</th><th class="hm">Notice</th><th class="hm">Visa</th>'+
    '<th class="hm">Interview /50</th><th class="hm">Practical /25</th><th>Final</th><th>Verdict</th></tr></thead><tbody>';
  var rank = 0;
  rows.forEach(function(x){
    if (x.c.done) rank++;
    h += '<tr onclick="ivsPick(\''+x.r.id+'\')">'+
      '<td class="n">'+(x.c.done ? rank : '—')+'</td>'+
      '<td><b>'+ivsEsc(ivsCandLabel(x.r))+'</b></td>'+
      '<td class="hm">'+ivsEsc(x.r.wave || '—')+'</td>'+
      IVS_DETAILS.map(function(d){ return '<td class="hm ivdc">'+ivsEsc(x.r[d[0]] || '—')+'</td>'; }).join('')+
      '<td class="n hm">'+x.c.int+'/50</td><td class="n hm">'+x.c.prac+'/25</td>'+
      '<td class="n">'+(x.c.done ? '<span class="ivbar"><i style="width:'+x.c.final+'%"></i></span><b>'+x.c.final+'</b>' : '—')+'</td>'+
      '<td>'+(x.c.done ? '<span class="ivpill '+x.c.verdict.c+'">'+x.c.verdict.t+'</span>'
                       : '<span class="ivpill">'+(x.c.scored ? (IVS_LINES-x.c.scored)+' to score' : 'Not scored')+'</span>')+'</td>'+
    '</tr>';
  });
  return h + '</tbody></table>';
}

function ivsRender(fromPoll){
  var v = document.getElementById('interviews-view');
  if (!v) return;
  if (!ivsCode){
    v.innerHTML = '<div class="ivwrap"><div class="ivgate"><b>Interview scoring</b>'+
      '<div style="font-size:13.5px;color:#6b5a48;margin-bottom:12px">Candidate names and scores are private. Enter the interviewers\' passcode.</div>'+
      '<input id="ivs-code" type="password" inputmode="numeric" autocomplete="off" onkeydown="if(event.key===\'Enter\')ivsUnlock()">'+
      '<button class="ivb" onclick="ivsUnlock()">Open</button>'+
      (ivsErr ? '<div class="iverr">'+ivsEsc(ivsErr)+'</div>' : '')+
    '</div></div>';
    var ci = document.getElementById('ivs-code'); if (ci) ci.focus();
    return;
  }
  // while a chef is typing, a poll only refreshes the parts that are not under their thumb
  var ae = document.activeElement;
  var typing = ae && (ae.id === 'ivs-name' || ae.id === 'ivs-notes' || ae.id === 'ivs-search' || /^ivs-d-/.test(ae.id || ''));
  if (fromPoll && typing){
    ivsRenderList();
    var r = ivsRow(ivsSel), sumEl = document.getElementById('ivs-sum');
    if (r && sumEl) sumEl.outerHTML = ivsSumHtml(r);
    var cvEl = document.getElementById('ivs-cvs');
    if (r && cvEl) cvEl.outerHTML = ivsCvsHtml(r);
    // another chef's detail edits land in the fields this chef is not typing in
    if (r) IVS_DETAILS.forEach(function(d){
      var inp = document.getElementById('ivs-d-'+d[0]);
      if (inp && inp !== ae && !ivsDetT[d[0]] && inp.value !== (r[d[0]]||'')) inp.value = r[d[0]]||'';
    });
    if (r) document.querySelectorAll('#interviews-view .ivs').forEach(function(g){
      var cur = +((r.scores||{})[g.getAttribute('data-k')]) || 0;
      g.querySelectorAll('button').forEach(function(b, i){ b.classList.toggle('on', cur === i+1); b.setAttribute('aria-pressed', cur === i+1); });
    });
    return;
  }
  var y = window.scrollY;
  var body = ivsTab === 'board' ? ivsBoardHtml()
    : '<div class="ivgrid"><div class="ivcard">'+ivsListShellHtml()+'</div>'+
      '<div class="ivcard" id="ivs-editor">'+ivsEditorHtml()+'</div></div>';
  v.innerHTML = '<div class="ivwrap">'+
    '<div class="ivhd"><div><small>Roberto\'s Dubai · Kitchen</small><h2>Commis Open Day — Live Scoring</h2></div>'+
      '<div id="ivs-stats">'+ivsStatsHtml()+'</div></div>'+
    '<div class="ivtabs">'+
      '<button class="ivb2'+(ivsTab==='score'?' on':'')+'" onclick="ivsTab=\'score\';ivsRender()">Score</button>'+
      '<button class="ivb2'+(ivsTab==='board'?' on':'')+'" onclick="ivsTab=\'board\';ivsRender()">Leaderboard</button>'+
      '<button class="ivlock" onclick="ivsLock()">Lock</button>'+
    '</div>'+
    (ivsErr ? '<div class="iverr" style="margin-bottom:10px">'+ivsEsc(ivsErr)+'</div>' : '')+
    body +
    '<div class="ivsync">Synced live — shared with everyone scoring today. Final = interview 40% + practical 60%, given once all 15 lines are scored.</div>'+
  '</div>';
  if (fromPoll) window.scrollTo(0, y);
}
