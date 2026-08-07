// ──────────────────────────────────────────────────────────────────────────
// WRITING HELP — THE ONLY COPY. Loaded by the Recipes screen.
//
// Chefs write recipes here in their third or fourth language, and what they
// write is read at the stove and printed in the Food Bible. An audit of the
// 62 prose passages found errors throughout — but it also found that the
// BEST writing in the app breaks English on purpose:
//
//     "Slow down the fire."          "Cool down rapidly the cremeux."
//
// That is a chef's voice and it is CLEARER to a cook than correct English.
// So this file is built around one rule, and every part of it obeys:
//
//     ONLY a word that names the WRONG THING is ever raised.
//     Grammar, tense, agreement, article and word order are NEVER touched.
//
// The safety is in the TRIGGER, not in which box is being read. That matters,
// because the errors are not where you would guess: of the audit's findings,
// ~90% are in the stove-facing boxes (method / store / plating), not the
// printed ones. A checker that only read the Food Bible fields would have
// caught two typos and missed every error that misinstructs at the stove.
//
// ── WHY TWO ENGINES ───────────────────────────────────────────────────────
// Measured on the real 62 passages, 7 Aug (see writing-review.html):
//
//   TABLE (below)   deterministic, free, offline, instant. Owns the errors
//                   that repeat: cock→cook, chilly→chilli, walking chiller.
//                   It cannot invent, because it can only match a fixed list.
//                   It also cannot DERIVE anything it has not been told.
//
//   ASK (the proxy) the only thing that can produce a first answer for a word
//                   nobody has seen. "papin bag" is the whole category: the
//                   browser's own spell checker offered papain / pain / pippin
//                   — all wrong, and papain is a real kitchen enzyme, so a
//                   confident wrong answer would have printed. The correct
//                   word is PIPING and nothing reaches it from letters alone.
//
// Sonnet 5 is used and Haiku is NOT, on evidence rather than taste: on the
// same corpus with the same prompt, Haiku returned 63 findings including 11
// that would have damaged a recipe — it rewrote an ingredient (olive oil →
// "neutral oil"), and "corrected" the correct professional usage "Scale the
// olive oil" into "Heat the olive oil". Sonnet 5 returned 13, silent on every
// one of those. Cost at this volume is ~$0.09/month, so the cheaper model
// buys nothing and risks the binder.
//
// ── WHAT NEVER HAPPENS ────────────────────────────────────────────────────
// Nothing is ever changed without the chef tapping it. Not a spelling, not a
// certainty. These chefs are partly learning English FROM this app, a silent
// fix teaches nothing, and the blast radius of one wrong silent fix is a
// printed binder carrying a word no human ever typed or read. Instead,
// accepting a whole batch costs ONE tap.
//
// A word nobody recognises is always shown as a QUESTION, never as a fix,
// even when the answer looks certain. A wrong question costs one tap; a wrong
// fix costs the Food Bible. And "It's what we call it" is always on screen,
// so a real house word is closed for good the first time it is raised — by
// anybody, once, for everybody.
// ──────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  var WH = window.WritingHelp = {};

  /* ═══════════ 1. THE TABLE — what repeats ═══════════
     Every entry here was harvested from the real recipes, not imagined. An
     entry earns its place by being WRONG IN A KITCHEN with one obvious right
     answer — never by being non-standard English.

     `re` is built with word boundaries so "chilly" never matches inside
     another word. Phrases are allowed and are the point: "tree fingers" is
     two correctly-spelled words that no spell checker can flag, and "tree"
     ALONE must never be touched — tree nuts is a live allergen on this very
     screen. Match the phrase, never the word. */
  var PAIRS = [
    /* the ones that misinstruct at the stove — these are why this exists */
    { wrong: 'to cock',           right: 'to cook',            note: 'cook' },
    { wrong: 'papin bag',         right: 'piping bag',         note: 'piping bag' },
    { wrong: 'walking chiller',   right: 'walk-in chiller',    note: 'walk-in' },
    { wrong: 'walk in chiller',   right: 'walk-in chiller',    note: 'walk-in' },
    { wrong: 'tree fingers',      right: 'three fingers',      note: 'three' },
    { wrong: 'current water',     right: 'running water',      note: 'running water' },

    /* ingredients and equipment named wrongly */
    { wrong: 'chilly',            right: 'chilli' },
    { wrong: 'almon',             right: 'almond' },
    { wrong: 'rosematy',          right: 'rosemary' },
    /* 'sifon' is NOT here, deliberately. The 7 Aug pass called it siphon, but a
       recipe is named "Hot Chocolate Sifon" — it is what this kitchen calls the
       thing, and correcting the body while the title keeps saying it would read
       as the app not knowing its own book. It lives in HOUSE_SEED instead.
       Nothing may appear in both lists: house wins in scan(), so a word in both
       is silently un-fixable and the contradiction never shows itself. */
    { wrong: 'chilller',          right: 'chiller' },
    { wrong: 'liquide',           right: 'liquid' },

    /* plain misspellings that survived the browser's own spell check */
    { wrong: 'freez',             right: 'freeze' },
    { wrong: 'freezed',           right: 'frozen' },
    { wrong: 'choosed',           right: 'chosen' },
    { wrong: 'tought',            right: 'thought' },
    { wrong: 'experiece',         right: 'experience' },
    { wrong: 'sandly',            right: 'sandy' }
  ];

  /* ═══════════ 2. HOUSE WORDS — never raised, by anybody, ever ═══════════
     Real things this kitchen owns, or proper nouns. Every one of these was
     "corrected" by the cheaper model during the trial: mortar → "container",
     excalibur → "dehydrator or oven", pacojet glasses → "containers", BB
     plate → "white plate". Each of those would have been a confident wrong
     suggestion, and a chef who is corrected wrongly once stops reading.

     This list GROWS: every time somebody taps "It's what we call it", the
     word lands here and is never raised again. */
  var HOUSE_SEED = [
    'mortar', 'excalibur', 'silicasec', 'pacojet', 'lupini', 'bb',
    'thermomix', 'gianduja', 'cremeux', 'pizzicotti', 'vongole', 'burrata',
    'andria', 'amalfi', 'ricciola', 'branzino', 'bartolini', 'maldon',
    'philo', 'sifon', 'kitchen aid', 'blast chiller', 'roner', 'bimby'
  ];

  /* ═══════════ 3. WHAT WE HAVE LEARNED ═══════════
     Answers survive in a table so a question is asked ONCE, for everybody,
     ever. `papin bag` appears six times across the recipes — that is one
     decision, not six.

     The table may not exist yet (the SQL is in writing-help.sql and has to be
     run by hand). Until it does, answers are kept on the device so the screen
     is fully usable today and nothing is lost — they upload themselves the
     first time the table answers. A missing table must never break a save. */
  var LS_KEY = 'kitchen-writing-terms';
  var learned = { fix: {}, house: {} };   // term(lower) -> replacement | true
  var tableLive = false;

  function loadLocal() {
    try {
      var raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      learned.fix = raw.fix || {};
      learned.house = raw.house || {};
    } catch (e) { /* corrupt or blocked storage is not a reason to fail */ }
    HOUSE_SEED.forEach(function (w) { if (!(w in learned.house)) learned.house[w] = true; });
  }
  function saveLocal() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(learned)); } catch (e) {}
  }
  loadLocal();

  WH.loadTerms = function () {
    if (typeof sb !== 'function') return Promise.resolve();
    return sb('kitchen_terms?select=term,verdict,meant').then(function (rows) {
      tableLive = true;
      (rows || []).forEach(function (r) {
        var t = String(r.term || '').toLowerCase();
        if (!t) return;
        if (r.verdict === 'house') learned.house[t] = true;
        else if (r.verdict === 'fix' && r.meant) learned.fix[t] = r.meant;
      });
      saveLocal();
    }).catch(function () { tableLive = false; });   /* table absent — carry on */
  };

  /* An answer is written to the device FIRST, so it survives a failed write,
     a dev-host block, or no signal at all. The row is a bonus, never the
     record of truth for this device. */
  WH.remember = function (term, verdict, meant) {
    var t = String(term || '').trim().toLowerCase();
    if (!t) return Promise.resolve();
    if (verdict === 'house') { learned.house[t] = true; delete learned.fix[t]; }
    else if (verdict === 'fix' && meant) { learned.fix[t] = meant; delete learned.house[t]; }
    saveLocal();
    if (!tableLive || typeof sb !== 'function') return Promise.resolve();
    return sb('kitchen_terms', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: { term: t, verdict: verdict, meant: meant || null }
    }).catch(function () { /* the device already has it */ });
  };

  WH.isHouse = function (term) {
    return !!learned.house[String(term || '').trim().toLowerCase()];
  };
  WH.knownFix = function (term) {
    return learned.fix[String(term || '').trim().toLowerCase()] || null;
  };
  WH.houseCount = function () { return Object.keys(learned.house).length; };

  /* ═══════════ 4. THE FREE PASS — runs on every box, offline ═══════════
     No network, no cost, no waiting. Returns [] almost always, which is the
     point: the app pushes, it does not nag, so a box with nothing wrong in it
     shows nothing at all.

     Case is preserved on the replacement so "Chilly" comes back "Chilli" and
     a line that starts with it still reads right. */
  function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function norm(s) { return String(s).toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim(); }

  /* The table and the proxy can land on the same mistake from two directions —
     the table matched "to cock" while the proxy reported "cock". Two rows about
     one word reads as the app not knowing what it thinks, so the certain one
     wins and the question is dropped. */
  WH.covers = function (certainWord, questionWord) {
    var a = ' ' + norm(certainWord) + ' ', b = ' ' + norm(questionWord) + ' ';
    return a.indexOf(b) > -1 || b.indexOf(a) > -1;
  };

  function matchCase(sample, replacement) {
    if (sample === sample.toUpperCase() && sample.length > 1) return replacement.toUpperCase();
    if (sample[0] === sample[0].toUpperCase()) return replacement[0].toUpperCase() + replacement.slice(1);
    return replacement;
  }

  WH.scan = function (text) {
    var t = String(text || '');
    if (!t.trim()) return [];
    var out = [], seen = {};

    function add(wrong, right, from) {
      var re = new RegExp('(^|[^\\p{L}\\p{N}-])(' + esc(wrong) + ')(?![\\p{L}\\p{N}-])', 'giu');
      var m;
      while ((m = re.exec(t)) !== null) {
        var found = m[2];
        var key = found.toLowerCase() + '>' + right.toLowerCase();
        if (seen[key]) continue;
        seen[key] = 1;
        /* the chef has already said this is his word — never raise it again */
        if (WH.isHouse(found)) continue;
        out.push({
          wrong: found,
          right: matchCase(found, right),
          where: m.index + m[1].length,
          source: from,
          sure: true
        });
      }
    }

    PAIRS.forEach(function (p) { add(p.wrong, p.right, 'table'); });
    /* answers given by somebody, once, now free for everybody */
    Object.keys(learned.fix).forEach(function (w) { add(w, learned.fix[w], 'learned'); });

    return out;
  };

  /* ═══════════ 5. THE ASK — the only job the table cannot do ═══════════
     Sent only on Save, never while typing, and never blocking: the recipe is
     already written and the ✓ is already shown before this is called.

     The prompt below is the one that was measured. Every "report NOTHING
     about" line is there because leaving it out produced a real failure on
     the real recipes — the word-order line is not theoretical, the cheaper
     model reordered "Spread very smoothly the second and last layer" into
     standard English, which is the same move that would flatten "Slow down
     the fire". */
  var PROXY = 'https://zrpglswalgjbtghudmhu.supabase.co/functions/v1/survey-assistant';

  var SYS_CHECK =
    'You check recipe writing from a professional kitchen. The chefs are excellent cooks ' +
    'writing in their third or fourth language. Their English is not the point — being ' +
    'followed at the stove is.\n\n' +
    'Report ONE kind of problem only: a word that names the WRONG THING or the WRONG ACTION, ' +
    'so a cook reading it would either do the wrong thing or stop to work out what was meant.\n\n' +
    'Report NOTHING about:\n' +
    '- grammar, verb tense, agreement, plurals, articles\n' +
    '- word order, even where it is not standard English\n' +
    '- style, tone, register, or how something "should" be phrased\n' +
    '- proper nouns, brand names, dish names, or house terms you do not recognise\n' +
    '- which ingredient or which piece of equipment the chef chose. That is his decision, ' +
    'not yours, and you do not know this kitchen.\n\n' +
    'These are all FINE and must NOT be reported — every word in them names the right thing:\n' +
    '  "Slow down the fire"\n  "Cool down rapidly the cremeux"\n  "the egg whites is whipped"\n' +
    '  "til the liquid almost reduce"\n  "Scale the olive oil"\n\n' +
    'For each problem give the exact wrong text as written, what was meant, and why — reasoning ' +
    'from the sentence around it, not from which word looks similar.\n\n' +
    'If you cannot work out what was meant FROM THE SENTENCE, set "meant" to null. Never guess a ' +
    'word because it looks similar to the one written. A confident wrong answer is worse than no answer.\n\n' +
    'Reply with ONLY a JSON array and nothing else:\n' +
    '[{"wrong":"exact text as written","meant":"the correct text, or null","why":"one short sentence"}]\n' +
    'Empty array [] if there is nothing.';

  /* One term, every sentence it appears in, one answer. Asking per passage
     gave the SAME word four different answers across six recipes, including
     one confident invention ("papin pouch"). Asking once against all six
     contexts gave "piping bag", once. */
  var SYS_TERM =
    'A word from a professional kitchen\'s recipe files is not recognised. You are shown EVERY ' +
    'sentence in which it appears.\n\n' +
    'Work out what the chef meant, using what the sentences have in common. Reason from what is ' +
    'being DONE around the word, never from which dictionary word it resembles — the correct ' +
    'answer is often not the closest-looking one.\n\n' +
    'Three possible verdicts:\n' +
    '- "fix"   : you are confident, from the contexts, what was meant.\n' +
    '- "house" : it looks like this kitchen\'s own name for something real. Do not correct it.\n' +
    '- "ask"   : you cannot tell. This is a perfectly good answer and is much better than a guess.\n\n' +
    'Never propose a word only because it is spelled similarly. If the contexts do not support ' +
    'your answer, the verdict is "ask".\n\n' +
    'Reply with ONLY JSON: {"verdict":"fix|house|ask","meant":"..." or null,"why":"one sentence"}';

  /* The chef supplies the facts. This only ever changes the language they are
     in. It may not add a place, a date, a person, a tradition or a reason —
     the Food Bible is read out to guests, so an invented fact becomes a lie
     the restaurant told. Starved of facts it must ask, not write: given only
     "torta di mele" it returns nothing and asks what makes it theirs. */
  var SYS_STORY =
    'A chef at Roberto\'s writes the story of a dish. He is an excellent chef writing in his third ' +
    'or fourth language, and he may write to you in Italian, English, or a mix. Your ONLY job is to ' +
    'put HIS words into clear English for the Food Bible, which waiters read before service.\n\n' +
    'THE ONE RULE: every fact in your version must come from what he wrote. You may not add a place, ' +
    'a date, a person, a tradition, a family member, a technique, an ingredient, or a reason that he ' +
    'did not give you. If his note is thin, your version is short. A short true story is worth more ' +
    'than a long invented one, and an invented one gets read out to a guest as though it were true.\n\n' +
    'Never write the generic encyclopedia version of a dish ("one of Italy\'s most iconic dishes", ' +
    '"celebrates simplicity", "a tradition dating back centuries"). That tells a waiter nothing about ' +
    'THIS restaurant and is worse than leaving the box empty.\n\n' +
    'Keep his voice. If he says the kitchen did something, say the kitchen did it. Keep the specific ' +
    'detail he bothered to include — it is the reason the story is worth printing. Under 90 words.\n\n' +
    'Reply with ONLY JSON:\n' +
    '{"story":"the English version, or null if there is not enough to work with",\n' +
    ' "used":["each fact you took from his note"],\n' +
    ' "missing":["a question to ask him, if his note is too thin to make a story"]}';

  /* The anon key is called SUPABASE_KEY in app.js and SB_KEY on the Recipes
     screen, which opens on its own and never loads app.js. Reading only one of
     them sent an empty key and every call came back rejected — and because the
     failure path says "no connection", it looked like kitchen wifi rather than
     a bug. Take whichever this page actually has, and say so loudly if neither. */
  function anonKey() {
    if (typeof SB_KEY !== 'undefined' && SB_KEY) return SB_KEY;
    if (typeof SUPABASE_KEY !== 'undefined' && SUPABASE_KEY) return SUPABASE_KEY;
    console.error('[writing-help] no Supabase key on this page — the proxy will reject every call.');
    return '';
  }
  function proxySecret() {
    if (typeof KITCHEN_PROXY_SECRET !== 'undefined' && KITCHEN_PROXY_SECRET) return KITCHEN_PROXY_SECRET;
    console.error('[writing-help] KITCHEN_PROXY_SECRET is not defined on this page — the proxy will reject every call.');
    return '';
  }

  function ask(system, user, maxTok) {
    var key = anonKey();
    return fetch(PROXY, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
        'apikey': key,
        'x-proxy-secret': proxySecret()
      },
      body: JSON.stringify({
        action: 'chat',
        model: 'claude-sonnet-5',
        max_tokens: maxTok || 700,
        system: system,
        messages: [{ role: 'user', content: user }]
      })
    }).then(function (r) {
      if (!r.ok) throw new Error('proxy ' + r.status);
      return r.json();
    }).then(function (d) { return String((d && d.text) || ''); });
  }

  function firstJSON(txt, open, close) {
    var m = txt.match(open === '[' ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch (e) { return null; }
  }

  /* Look over a whole recipe. Anything the table already answers is dropped
     before the reply is shown, so the chef is never asked twice about the
     same word and never sees a house term raised. */
  WH.check = function (boxes) {
    var body = Object.keys(boxes)
      .filter(function (k) { return (boxes[k] || '').trim(); })
      .map(function (k) { return '<<' + k + '>>\n' + boxes[k].trim(); })
      .join('\n\n');
    if (!body.trim()) return Promise.resolve([]);

    return ask(SYS_CHECK, body, 900).then(function (txt) {
      var arr = firstJSON(txt, '[') || [];
      if (!Array.isArray(arr)) return [];
      return arr.filter(function (f) {
        if (!f || !f.wrong) return false;
        var w = String(f.wrong).trim();
        if (!w || w.indexOf('<<') === 0) return false;   /* never our own scaffolding */
        if (WH.isHouse(w)) return false;
        /* An "expansion" is not an error. Measured on the real book it offered
           "chocolate sorbet" → "chocolate sorbet (frozen dessert)": the chef's
           words are all still there and a gloss has been added. Nothing names
           the wrong thing, so there is nothing to raise — and a question about
           a word that was right is exactly what makes a chef stop reading. */
        if (f.meant && norm(String(f.meant)).indexOf(norm(w)) > -1) return false;
        return true;
      }).map(function (f) {
        return {
          wrong: String(f.wrong).trim(),
          right: f.meant ? String(f.meant).trim() : null,
          why: String(f.why || '').trim(),
          sure: false                                     /* an ask, never a fix */
        };
      });
    }).catch(function (e) {
      /* the chef sees nothing, which is right — but the reason must not vanish,
         or a broken key looks exactly like bad wifi for ever */
      console.warn('[writing-help] check failed:', e && e.message);
      return [];
    });
  };

  /* Resolve one term against every context it appears in. Used by the review
     screen, and by a save when the same new word turns up more than once. */
  WH.resolveTerm = function (term, contexts) {
    var body = 'Word not recognised: "' + term + '"\n\nEvery sentence it appears in (' +
      contexts.length + '):\n' + contexts.join('\n');
    return ask(SYS_TERM, body, 400).then(function (txt) {
      var o = firstJSON(txt, '{') || {};
      return {
        term: term,
        verdict: o.verdict === 'fix' || o.verdict === 'house' ? o.verdict : 'ask',
        meant: o.meant || null,
        why: String(o.why || '').trim(),
        uses: contexts.length
      };
    }).catch(function (e) {
      console.warn('[writing-help] resolveTerm failed:', e && e.message);
      return { term: term, verdict: 'ask', meant: null, why: 'No connection.', uses: contexts.length };
    });
  };

  /* The story helper. Returns his facts back at him in English, or nothing
     plus a question. `used` is shown so he can see every fact came from him. */
  WH.story = function (text) {
    var t = String(text || '').trim();
    if (!t) return Promise.resolve({ story: null, used: [], missing: [], empty: true });
    return ask(SYS_STORY, t, 700).then(function (txt) {
      var o = firstJSON(txt, '{') || {};
      return {
        story: o.story ? String(o.story).trim() : null,
        used: Array.isArray(o.used) ? o.used : [],
        missing: Array.isArray(o.missing) ? o.missing : []
      };
    }).catch(function (e) {
      console.warn('[writing-help] story failed:', e && e.message);
      return { story: null, used: [], missing: [], offline: true };
    });
  };

  /* Every sentence in the recipe that contains a term — so a question can be
     asked against all its contexts rather than one. */
  WH.contextsIn = function (boxes, term) {
    var re = new RegExp('(^|[^\\p{L}\\p{N}-])' + esc(term) + '(?![\\p{L}\\p{N}-])', 'iu');
    var out = [];
    Object.keys(boxes).forEach(function (k) {
      String(boxes[k] || '').split(/\n/).forEach(function (line) {
        if (line.trim() && re.test(line)) out.push('(' + k + ') ' + line.trim());
      });
    });
    return out;
  };

  WH.tableSize = function () { return PAIRS.length + Object.keys(learned.fix).length; };
})();
