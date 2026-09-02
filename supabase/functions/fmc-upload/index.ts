import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const VENUE = "robertos-difc";
// A master this small means a filtered or truncated export, not a shrunk one.
const MASTER_FLOOR = 800;
// The assortment may lose a line or two to a retirement. Not 40.
const ASSORTMENT_FLOOR = 300;
const BIG_DROP = 10;
// Price Quotes, unfiltered, gave 3,229 rows on 15 Aug 2026 of which 2,404 were
// switched on. A file that arrives with under a thousand was exported with a
// Supplier Group still in the box — that is exactly how the first one came in,
// covering 10 suppliers of 63 — and loading it would delete every supplier the
// filter left out.
const QUOTES_FLOOR = 1000;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const json = (body, status = 200)=>new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json"
    }
  });
const norm = (s)=>(s || "").replace(/\s+/g, " ").trim().toLowerCase();
const bare = (s)=>norm(s).replace(/^z{2,}\s*/, "");
/** FMC clips the Article column when it prints. Restore by unique prefix,
 *  refuse on a tie — guessing here points a recipe at the wrong article. */ function resolveClipped(names, master) {
  const canon = new Map();
  for (const rec of master.values())canon.set(bare(rec.name), rec.name);
  const out = [];
  const ties = [];
  for (const raw of names){
    const key = bare(raw);
    if (key.length < 40 || canon.has(key)) {
      out.push(raw);
      continue;
    }
    const hits = [
      ...canon.keys()
    ].filter((k)=>k.startsWith(key) && k.length > key.length);
    if (hits.length === 1) out.push(canon.get(hits[0]));
    else if (hits.length > 1) ties.push(raw);
    else out.push(raw);
  }
  return {
    names: out,
    ties
  };
}
/** Rebuild `fmc_price_quotes` from FMC's Purchase | Price Quotes export.
 *
 *  This answers a question the article table cannot: WHO will FMC accept an
 *  order from, and at what price. The two disagree — Turbot 4026100 was bought
 *  from Simply Gourmet and FMC offers only Wisk — so buying history says who we
 *  USED and this says who we CAN use.
 *
 *  Only rows FMC has switched on (E/D) are sent, so a supplier in this table is
 *  one an order will be accepted for. A supplier switched off must DISAPPEAR,
 *  or the app keeps offering somebody FMC will refuse: that is the Zurich fault,
 *  61 market-list lines naming a supplier whose every link was off. So this
 *  deletes what the file no longer carries — which is precisely why the floor
 *  above has to hold.
 *
 *  The article number in this export is the SUPPLIER's, not FMC's, and on
 *  15 Aug 2026 it was right on 604 of 615 rows, wrong on 3 (Romanesco carried
 *  4019036, which is not a Romanesco code) and unknown on 8. So a printed code
 *  is accepted only when it resolves to THIS article's name; otherwise the name
 *  decides. Trusting it blind is what made Ali Gholami's rosemary look like no
 *  supplier at all.
 */ async function processQuotes(sb, quotes, dryRun) {
  if (quotes.length < QUOTES_FLOOR) {
    return {
      error: "refused",
      problems: [
        `The price quotes file gave ${quotes.length} rows. Under ${QUOTES_FLOOR} ` + `means a Supplier Group or Item Group was still in the search box — ` + `clear every filter and export again. Loading it would remove every ` + `supplier the filter left out.`
      ]
    };
  }
  // the catalogue decides which code a row belongs to
  const arts = [];
  for(let from = 0;; from += 1000){
    const { data, error } = await sb.from("fmc_articles").select("code,name").eq("venue_id", VENUE).order("code").range(from, from + 999);
    if (error) return {
      error: error.message
    };
    arts.push(...data || []);
    if ((data || []).length < 1000) break; // PostgREST caps at 1000 silently
  }
  // FMC's two exports disagree with each other on the same article: Manage
  // Articles says "Anchovy Fillets Olive Oil 200Gm", Price Quotes says
  // "Anchovy Fillets IN Olive Oil 200Gm". So punctuation and four filler words
  // are dropped before comparing. This is NOT fuzzy matching - measured over
  // all 2,404 switched-on rows it rescues exactly ONE row, the anchovy, and
  // resolves nothing to an article whose name differs. Romanesco, whose quote
  // carries 4019036 (which belongs to Cherry Ciliegie Vignola), is still
  // rejected on the code and still resolves by name to the right article.
  const STOP = new Set([
    "in",
    "of",
    "the",
    "and",
    "with"
  ]);
  const akey = (s)=>String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w)=>w && !STOP.has(w)).join(" ");
  const nameOf = new Map();
  const codeOfName = new Map();
  for (const a of arts){
    nameOf.set(String(a.code), akey(a.name));
    if (!codeOfName.has(akey(a.name))) codeOfName.set(akey(a.name), String(a.code));
  }
  const stamp = new Date().toISOString();
  const rows = [];
  const seen = new Set();
  const unknownNames = new Set();
  let byPrinted = 0, byName = 0, dropped = 0;
  for (const q of quotes){
    const printed = String(q.code || "").trim();
    const article = akey(q.article || "");
    let code = "";
    if (printed && nameOf.get(printed) === article) {
      code = printed;
      byPrinted++;
    } else if (codeOfName.has(article)) {
      code = codeOfName.get(article);
      byName++;
    } else {
      dropped++;
      unknownNames.add(String(q.article || "").trim());
      continue;
    }
    const supplier = String(q.supplier || "").trim();
    const unit = String(q.unit || "").trim();
    if (!supplier || !unit) {
      dropped++;
      continue;
    }
    const key = `${code}|${supplier}|${unit}`;
    if (seen.has(key)) continue; // a duplicate inside one upsert rejects the batch
    seen.add(key);
    rows.push({
      code,
      supplier,
      unit,
      price_per_unit: q.price ?? null,
      price_per_base_unit: q.priceBase ?? null,
      last_price_update: q.priced || null,
      item_group: q.group || null,
      venue_id: VENUE,
      harvested_at: stamp
    });
  }
  const before = [];
  for(let from = 0;; from += 1000){
    const { data, error } = await sb.from("fmc_price_quotes").select("code,supplier,unit,price_per_unit").eq("venue_id", VENUE).order("code").range(from, from + 999);
    if (error) return {
      error: error.message
    };
    before.push(...data || []);
    if ((data || []).length < 1000) break;
  }
  // A floor measured against the table itself, not a number picked in advance.
  // Most of the export is articles the kitchen's catalogue does not carry -
  // 1,260 of 2,404 on 15 Aug 2026, nearly all beverages - so an absolute floor
  // on the MATCHED rows sat only 14% above the real figure and would have
  // refused a good file the first time the catalogue lost a few articles. What
  // must never happen is this table SHRINKING sharply, because the delete pass
  // below would then take real suppliers out with it.
  if (before.length && rows.length < before.length * 0.6) {
    return {
      error: "refused",
      problems: [
        `Only ${rows.length} supplier prices could be matched, against ` + `${before.length} already saved. That is too big a drop to be a real ` + `change — the article list is probably out of date, or the export was ` + `filtered. Nothing has been touched.`
      ]
    };
  }
  const wasKey = new Map(before.map((r)=>[
      `${r.code}|${r.supplier}|${r.unit}`,
      r
    ]));
  const nowKey = new Set(rows.map((r)=>`${r.code}|${r.supplier}|${r.unit}`));
  const gone = before.filter((r)=>!nowKey.has(`${r.code}|${r.supplier}|${r.unit}`));
  const report = {
    rows: rows.length,
    suppliers: new Set(rows.map((r)=>r.supplier)).size,
    articles: new Set(rows.map((r)=>r.code)).size,
    matchedByPrintedCode: byPrinted,
    matchedByName: byName,
    // Never silently dropped: a row nobody can place is a supplier a chef
    // will not be offered, and that has to be visible. Most of these are
    // articles the kitchen's catalogue does not carry - beverages, mainly -
    // so the names are shown rather than just a count, or a genuine gap
    // hides inside a big expected number.
    couldNotMatch: dropped,
    couldNotMatchNames: [
      ...unknownNames
    ].slice(0, 25),
    newLinks: rows.filter((r)=>!wasKey.has(`${r.code}|${r.supplier}|${r.unit}`)).length,
    // A link that vanished is a supplier FMC has switched off. This is the
    // one that matters: it is how the app learns to stop offering them.
    switchedOff: gone.map((r)=>`${r.code}  ${r.supplier}  ${r.unit}`),
    priceMoved: rows.flatMap((r)=>{
      const b = wasKey.get(`${r.code}|${r.supplier}|${r.unit}`);
      if (!b || b.price_per_unit == null || r.price_per_unit == null) return [];
      const was = Number(b.price_per_unit), now = Number(r.price_per_unit);
      if (!was || Math.abs(now - was) / was <= 0.02) return [];
      return [
        {
          code: r.code,
          supplier: r.supplier,
          before: was,
          now
        }
      ];
    }).sort((a, b)=>Math.abs(b.now - b.before) - Math.abs(a.now - a.before))
  };
  if (dryRun) return {
    ok: true,
    quotesReport: report
  };
  for(let i = 0; i < rows.length; i += 500){
    const { error } = await sb.from("fmc_price_quotes").upsert(rows.slice(i, i + 500), {
      onConflict: "code,supplier,unit,venue_id"
    });
    if (error) return {
      error: error.message,
      wrote: i
    };
  }
  // and drop what FMC no longer offers, one key at a time rather than a broad
  // filter — a delete that matches more than intended cannot be undone here.
  for (const g of gone){
    const { error } = await sb.from("fmc_price_quotes").delete().eq("venue_id", VENUE).eq("code", g.code).eq("supplier", g.supplier).eq("unit", g.unit);
    if (error) return {
      error: error.message
    };
  }
  const { count } = await sb.from("fmc_price_quotes").select("code", {
    count: "exact",
    head: true
  }).eq("venue_id", VENUE);
  return {
    ok: true,
    quotesReport: report,
    quoteRowsInTable: count
  };
}
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: CORS
  });
  if (req.method !== "POST") return json({
    error: "POST only"
  }, 405);
  let body;
  try {
    body = await req.json();
  } catch  {
    return json({
      error: "bad JSON"
    }, 400);
  }
  // More than one person updates the list, so FMC_UPLOAD_PIN is a COMMA-
  // SEPARATED list of codes rather than a single one - Francesco's and Aung's.
  // Kept in the secret rather than in this file so a person can be added or
  // taken off without deploying the function, which matters because the next
  // change to it is likely to be removing someone.
  //
  // Still one env var, still an exact match, and a blank secret still refuses
  // everything: an empty list cannot accidentally let anyone in.
  const pins = String(Deno.env.get("FMC_UPLOAD_PIN") || "").split(",").map((p)=>p.trim()).filter(Boolean);
  if (!pins.length || !pins.includes(String(body.passcode || "").trim())) {
    return json({
      error: "That code is not right."
    }, 401);
  }
  const master = body.master || [];
  const assortment = body.assortment || [];
  const quotes = body.quotes || [];
  // The price quotes stand on their own: they are their own export, they answer
  // their own question, and they go stale on their own schedule. So they can be
  // loaded without the other two rather than forcing all three every time - the
  // thing that rots is the one nobody can be bothered to refresh.
  if (quotes.length && !master.length && !assortment.length) {
    const sbq = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
    const out = await processQuotes(sbq, quotes, !!body.dryRun);
    return json(out, out.error ? out.problems ? 422 : 500 : 200);
  }
  // The article list rots on its own schedule too, and it is the half carrying
  // names, units, recipe costs and FMC's ZZZ retirement marker. The lobster
  // proved it: 4026031 sat retiring=false for five days after FMC retired it,
  // while the kitchen was receiving a different article entirely.
  //
  // It could not be refreshed on its own because the printed Assortment List is
  // a File > Print > save-as-PDF job. The robot cannot drive that; it CAN press
  // the same green Excel button on Manage Articles that it already presses for
  // the quotes. So the master is allowed to come alone.
  //
  // ⚠ WHAT MAKES THAT SAFE IS AN OMISSION, and it is the most dangerous line in
  // this function: without the printed list `assortedCodes` is EMPTY, so
  // `on_assortment: assortedCodes.has(code)` would write EVERY article
  // unorderable in a single upsert and take the whole catalogue off the chefs'
  // screens. On this path `on_assortment` is left out of the payload entirely,
  // so ON CONFLICT DO UPDATE never names the column and the stored value stands.
  // Anything derived from the assortment is refused the right to answer rather
  // than answering zero - a false zero here reads exactly like a real one.
  const masterOnly = master.length > 0 && assortment.length === 0;
  // ---- refuse a bad parse before it can touch anything --------------------
  const problems = [];
  if (master.length < MASTER_FLOOR) {
    problems.push(`The article file gave ${master.length} articles. Under ${MASTER_FLOOR} ` + `means it did not read properly, or it was exported with a filter on.`);
  }
  if (!masterOnly && assortment.length < ASSORTMENT_FLOOR) {
    problems.push(`The assortment list gave ${assortment.length} lines. Under ${ASSORTMENT_FLOOR} ` + `means some pages did not read.`);
  }
  const badCodes = master.filter((m)=>!/^\d{7}$/.test(String(m.code || "")));
  if (badCodes.length) {
    problems.push(`${badCodes.length} article numbers are not 7 digits — e.g. ` + badCodes.slice(0, 3).map((m)=>`"${m.code}"`).join(", "));
  }
  if (problems.length) return json({
    error: "refused",
    problems
  }, 422);
  const url = Deno.env.get("SUPABASE_URL");
  const sb = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  const byCode = new Map();
  // FIRST row wins, and it must: `set` on every row would keep the LAST,
  // and FMC has 4029136 on both Baby Capsicum Mix and Potato Large Peeled.
  // Keeping the last flipped that row to Potato at 3.20 against Capsicum's
  // 62.50 - a 95% 'price move' that is really the two paths disagreeing
  // about which article the number belongs to. The Python harvest keeps
  // the first, so this does too.
  for (const m of master)if (!byCode.has(String(m.code))) byCode.set(String(m.code), m);
  const assortedCodes = new Set();
  const unmatched = [];
  if (!masterOnly) {
    const fixed = resolveClipped(assortment, byCode);
    if (fixed.ties.length) {
      return json({
        error: "refused",
        problems: [
          "The assortment list clipped these names and more than one article " + "fits each, so nothing was written: " + fixed.ties.join(" | ")
        ]
      }, 422);
    }
    const byName = new Map();
    for (const [code, rec] of byCode)if (!byName.has(bare(rec.name))) byName.set(bare(rec.name), code);
    for (const n of fixed.names){
      const code = byName.get(bare(n));
      if (code) assortedCodes.add(code);
      else unmatched.push(n);
    }
  }
  // ---- what is there now, so the answer can be a diff and not a guess -----
  const existing = [];
  for(let from = 0;; from += 1000){
    const { data, error } = await sb.from("fmc_articles").select("code,name,on_assortment,price_per_base_unit").eq("venue_id", VENUE).range(from, from + 999);
    if (error) return json({
      error: error.message
    }, 500);
    existing.push(...data || []);
    if (!data || data.length < 1000) break;
  }
  const was = new Map(existing.map((r)=>[
      r.code,
      r
    ]));
  const wasAssorted = new Set(existing.filter((r)=>r.on_assortment).map((r)=>r.code));
  // Skipped on the master-only path, and not because it is inconvenient: with
  // no printed list `assortedCodes` is empty, so this would compare the real
  // count against zero and refuse every honest upload. The protection it gives
  // is not lost — nothing on that path writes `on_assortment` at all.
  const drop = wasAssorted.size - assortedCodes.size;
  if (!masterOnly && !body.force && wasAssorted.size && drop > Math.max(BIG_DROP, wasAssorted.size * 0.02)) {
    return json({
      error: "refused",
      problems: [
        `The list had ${wasAssorted.size} orderable articles and this one has ` + `${assortedCodes.size} — ${drop} fewer. That is more than FMC retiring ` + `a line, so it reads like a bad export. Nothing was written.`
      ]
    }, 422);
  }
  const stamp = new Date().toISOString();
  // Built from the DEDUPED map, never from the raw array. FMC's own file has
  // at least one number on two articles - 4029136 is on both Baby Capsicum
  // Mix and Potato Large Peeled - and Postgres rejects the whole batch with
  // "ON CONFLICT DO UPDATE command cannot affect row a second time" when the
  // same code appears twice in one upsert. First row wins, exactly as it does
  // in the Python harvest, so the two paths agree.
  const rows = [
    ...byCode.values()
  ].map((m)=>{
    const row = {
      code: String(m.code),
      name: m.name,
      unit: m.store_unit || "",
      retiring: !!m.retired,
      code_source: "master",
      venue_id: VENUE,
      harvested_at: stamp,
      item_group: m.item_group || null,
      base_unit: m.base_unit || null,
      store_unit: m.store_unit || null,
      price_per_base_unit: m.price_per_base_unit ?? null,
      // FMC's own date for this article, not ours. `master_harvested_at` says
      // when WE read the file, which on 16 Aug 2026 made a price last touched
      // in April look like today's: the median article had not moved in 122
      // days and 770 of 1,435 were over three months old. A price with no date
      // is the actual danger, so the date travels with the price.
      price_paid_at: m.priced || null,
      master_harvested_at: stamp
    };
    // Only the printed Assortment List is allowed to answer "can we order it",
    // so on the master-only path these two keys are absent from EVERY row and
    // the upsert cannot name them. `assortment_checked_at` goes with it: a
    // fresh timestamp against an unchanged flag would claim the question had
    // been asked today when it was not.
    if (!masterOnly) {
      row.on_assortment = assortedCodes.has(String(m.code));
      row.assortment_checked_at = stamp;
    }
    return row;
  });
  const report = {
    articles: rows.length,
    // null, never 0. Nothing in this upload asked the question, and a zero here
    // would be read as "nothing is orderable" by every screen that prints it.
    orderable: masterOnly ? null : assortedCodes.size,
    // The flag the app renders from, so a person is told which half was
    // refreshed rather than left to infer it from a blank.
    assortmentUntouched: masterOnly,
    added: rows.filter((r)=>!was.has(r.code)).map((r)=>r.name).slice(0, 50),
    addedCount: rows.filter((r)=>!was.has(r.code)).length,
    // Only an article the master KNOWS about can be reported as having left
    // the assortment. A code missing from the master is a hole in that export
    // — the food-only export drops the whole beverage range — and reading it
    // as "no longer orderable" would let one file overrule the other. The
    // printed list is the only thing allowed to answer this, and for a code
    // it cannot match it has not answered at all.
    //
    // ⚠ Both are forced empty on the master-only path rather than left to
    // compute. `assortedCodes` is empty there, so the filter below would match
    // EVERY currently-orderable article and report the entire catalogue as
    // having just stopped being orderable — a false alarm that looks exactly
    // like the real one this list exists to raise.
    noLongerOrderable: masterOnly ? [] : existing.filter((r)=>r.on_assortment && !assortedCodes.has(r.code) && byCode.has(r.code)).map((r)=>`${r.code}  ${r.name}`),
    nowOrderable: masterOnly ? [] : [
      ...assortedCodes
    ].filter((c)=>!wasAssorted.has(c)).map((c)=>`${c}  ${byCode.get(c)?.name || ""}`),
    priceMoved: rows.flatMap((r)=>{
      const b = was.get(r.code);
      if (!b || b.price_per_base_unit == null || r.price_per_base_unit == null) return [];
      const before = Number(b.price_per_base_unit), now = Number(r.price_per_base_unit);
      if (!before || Math.abs(now - before) / before <= 0.02) return [];
      return [
        {
          code: r.code,
          name: r.name,
          before,
          now
        }
      ];
    }).sort((a, b)=>Math.abs(b.now - b.before) - Math.abs(a.now - a.before)),
    // Named, never silently dropped — an assortment line that matches no
    // article is the case where a chef loses the ability to order something.
    unmatchedAssortmentLines: unmatched,
    dryRun: !!body.dryRun
  };
  if (body.dryRun) {
    if (!quotes.length) return json({
      ok: true,
      report
    });
    const q = await processQuotes(sb, quotes, true);
    if (q.error) return json(q, q.problems ? 422 : 500);
    return json({
      ok: true,
      report,
      quotesReport: q.quotesReport
    });
  }
  // 2 Sep 2026: the robot's master-only refresh now brings in NEW articles from
  // the kitchen's own item groups (see the helper's `kitchen_groups()`). A new
  // row on this path has never been through the printed Assortment List, and
  // the column's default is TRUE - so an insert that leaves `on_assortment`
  // out would claim the article is orderable when nobody has asked. New rows
  // are therefore written in their own batch with the flag OFF and no
  // `assortment_checked_at`; the rows we already hold keep the omission above,
  // so their stored answer stands exactly as before. PostgREST needs every row
  // of one upsert to carry the same keys, which is why it is two batches and
  // not one. The market list flags a line whose article is off the assortment
  // until the mirror has put it there, which is the right state for a newcomer.
  const knownRows = masterOnly ? rows.filter((r)=>was.has(r.code)) : rows;
  const freshRows = masterOnly ? rows.filter((r)=>!was.has(r.code)).map((r)=>({
      ...r,
      on_assortment: false
    })) : [];
  for(let i = 0; i < knownRows.length; i += 500){
    const { error } = await sb.from("fmc_articles").upsert(knownRows.slice(i, i + 500), {
      onConflict: "code"
    });
    if (error) return json({
      error: error.message,
      wrote: i
    }, 500);
  }
  for(let i = 0; i < freshRows.length; i += 500){
    const { error } = await sb.from("fmc_articles").upsert(freshRows.slice(i, i + 500), {
      onConflict: "code"
    });
    if (error) return json({
      error: error.message,
      wrote: knownRows.length + i
    }, 500);
  }
  // Anything the printed list no longer carries stops being orderable. The
  // row stays — a market-list line or a recipe may still point at it, and
  // that is a decision per item, not a cleanup.
  // No second pass to switch anything off. Every row above already carries
  // its own `on_assortment`, so an article that left the list is demoted by
  // the upsert itself — and an article the master never mentioned is left
  // exactly as it was, which is the whole point of the note above. Nothing
  // is ever deleted: a market-list line or a recipe may still point at it.
  const { count } = await sb.from("fmc_articles").select("code", {
    count: "exact",
    head: true
  }).eq("venue_id", VENUE);
  // The articles are already written by here. If the quotes then fail, say so
  // plainly rather than returning a clean ok — a half-done update that reports
  // success is the failure mode this whole function is built to avoid.
  if (quotes.length) {
    const q = await processQuotes(sb, quotes, false);
    if (q.error) {
      return json({
        ok: false,
        report,
        rowsInTable: count,
        error: "The article list was updated. The supplier list was NOT: " + q.error,
        problems: q.problems
      }, 207);
    }
    return json({
      ok: true,
      report,
      rowsInTable: count,
      quotesReport: q.quotesReport,
      quoteRowsInTable: q.quoteRowsInTable
    });
  }
  return json({
    ok: true,
    report,
    rowsInTable: count
  });
});
