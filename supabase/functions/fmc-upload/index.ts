// Take the two FMC exports and rebuild `fmc_articles` from them.
//
// ─────────────────────────────────────────────────────────────────────────
// THE WRITE LIVES HERE BECAUSE THE ANON KEY CANNOT DO IT.
// ─────────────────────────────────────────────────────────────────────────
// A PATCH to `fmc_articles` with the app's key matches the row, changes
// nothing, and returns 204 — it looks exactly like success. So the browser
// parses and this function writes, with the service role.
//
// The browser sends parsed rows rather than raw files. That means the parse
// exists twice — here in JS and in fmc-helper/*.py — so this side does NOT
// trust what arrives. It re-checks the invariants that a bad parse breaks:
// a code that is not 7 digits, a master under the floor, an assortment that
// collapsed. Those guards are the point; without them a truncated upload
// would quietly empty the catalogue.
//
// Two questions, one table, and they must not be confused:
//   * `on_assortment` — can the kitchen ORDER it. Set only from the printed
//     Assortment List. Never from the master, which carries 1,000 live
//     articles the kitchen is not assorted for.
//   * everything else — what the article IS and what a RECIPE costs on.
//     From the Manage Articles export.
//
// `price` (per pack, from the Purchase grid) is never written here. It is a
// different measurement from a different source and naming it would blank it.

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
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
const bare = (s: string) => norm(s).replace(/^z{2,}\s*/, "");

/** FMC clips the Article column when it prints. Restore by unique prefix,
 *  refuse on a tie — guessing here points a recipe at the wrong article. */
function resolveClipped(names: string[], master: Map<string, any>) {
  const canon = new Map<string, string>();
  for (const rec of master.values()) canon.set(bare(rec.name), rec.name);

  const out: string[] = [];
  const ties: string[] = [];
  for (const raw of names) {
    const key = bare(raw);
    if (key.length < 40 || canon.has(key)) { out.push(raw); continue; }
    const hits = [...canon.keys()].filter((k) => k.startsWith(key) && k.length > key.length);
    if (hits.length === 1) out.push(canon.get(hits[0])!);
    else if (hits.length > 1) ties.push(raw);
    else out.push(raw);
  }
  return { names: out, ties };
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
 */
async function processQuotes(sb: any, quotes: any[], dryRun: boolean) {
  if (quotes.length < QUOTES_FLOOR) {
    return {
      error: "refused",
      problems: [
        `The price quotes file gave ${quotes.length} rows. Under ${QUOTES_FLOOR} ` +
        `means a Supplier Group or Item Group was still in the search box — ` +
        `clear every filter and export again. Loading it would remove every ` +
        `supplier the filter left out.`,
      ],
    };
  }

  // the catalogue decides which code a row belongs to
  const arts: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("fmc_articles")
      .select("code,name").eq("venue_id", VENUE).order("code")
      .range(from, from + 999);
    if (error) return { error: error.message };
    arts.push(...(data || []));
    if ((data || []).length < 1000) break;   // PostgREST caps at 1000 silently
  }
  // FMC's two exports disagree with each other on the same article: Manage
  // Articles says "Anchovy Fillets Olive Oil 200Gm", Price Quotes says
  // "Anchovy Fillets IN Olive Oil 200Gm". So punctuation and four filler words
  // are dropped before comparing. This is NOT fuzzy matching - measured over
  // all 2,404 switched-on rows it rescues exactly ONE row, the anchovy, and
  // resolves nothing to an article whose name differs. Romanesco, whose quote
  // carries 4019036 (which belongs to Cherry Ciliegie Vignola), is still
  // rejected on the code and still resolves by name to the right article.
  const STOP = new Set(["in", "of", "the", "and", "with"]);
  const akey = (s: string) =>
    String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
      .split(" ").filter((w) => w && !STOP.has(w)).join(" ");

  const nameOf = new Map<string, string>();
  const codeOfName = new Map<string, string>();
  for (const a of arts) {
    nameOf.set(String(a.code), akey(a.name));
    if (!codeOfName.has(akey(a.name))) codeOfName.set(akey(a.name), String(a.code));
  }

  const stamp = new Date().toISOString();
  const rows: any[] = [];
  const seen = new Set<string>();
  const unknownNames = new Set<string>();
  let byPrinted = 0, byName = 0, dropped = 0;
  for (const q of quotes) {
    const printed = String(q.code || "").trim();
    const article = akey(q.article || "");
    let code = "";
    if (printed && nameOf.get(printed) === article) { code = printed; byPrinted++; }
    else if (codeOfName.has(article)) { code = codeOfName.get(article)!; byName++; }
    else { dropped++; unknownNames.add(String(q.article || "").trim()); continue; }

    const supplier = String(q.supplier || "").trim();
    const unit = String(q.unit || "").trim();
    if (!supplier || !unit) { dropped++; continue; }
    const key = `${code}|${supplier}|${unit}`;
    if (seen.has(key)) continue;   // a duplicate inside one upsert rejects the batch
    seen.add(key);
    rows.push({
      code, supplier, unit,
      price_per_unit: q.price ?? null,
      price_per_base_unit: q.priceBase ?? null,
      last_price_update: q.priced || null,
      item_group: q.group || null,
      venue_id: VENUE, harvested_at: stamp,
    });
  }

  const before: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("fmc_price_quotes")
      .select("code,supplier,unit,price_per_unit").eq("venue_id", VENUE)
      .order("code").range(from, from + 999);
    if (error) return { error: error.message };
    before.push(...(data || []));
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
        `Only ${rows.length} supplier prices could be matched, against ` +
        `${before.length} already saved. That is too big a drop to be a real ` +
        `change — the article list is probably out of date, or the export was ` +
        `filtered. Nothing has been touched.`,
      ],
    };
  }

  const wasKey = new Map(before.map((r) => [`${r.code}|${r.supplier}|${r.unit}`, r]));
  const nowKey = new Set(rows.map((r) => `${r.code}|${r.supplier}|${r.unit}`));
  const gone = before.filter((r) => !nowKey.has(`${r.code}|${r.supplier}|${r.unit}`));

  const report = {
    rows: rows.length,
    suppliers: new Set(rows.map((r) => r.supplier)).size,
    articles: new Set(rows.map((r) => r.code)).size,
    matchedByPrintedCode: byPrinted,
    matchedByName: byName,
    // Never silently dropped: a row nobody can place is a supplier a chef
    // will not be offered, and that has to be visible. Most of these are
    // articles the kitchen's catalogue does not carry - beverages, mainly -
    // so the names are shown rather than just a count, or a genuine gap
    // hides inside a big expected number.
    couldNotMatch: dropped,
    couldNotMatchNames: [...unknownNames].slice(0, 25),
    newLinks: rows.filter((r) => !wasKey.has(`${r.code}|${r.supplier}|${r.unit}`)).length,
    // A link that vanished is a supplier FMC has switched off. This is the
    // one that matters: it is how the app learns to stop offering them.
    switchedOff: gone.map((r) => `${r.code}  ${r.supplier}  ${r.unit}`),
    priceMoved: rows.flatMap((r) => {
      const b = wasKey.get(`${r.code}|${r.supplier}|${r.unit}`);
      if (!b || b.price_per_unit == null || r.price_per_unit == null) return [];
      const was = Number(b.price_per_unit), now = Number(r.price_per_unit);
      if (!was || Math.abs(now - was) / was <= 0.02) return [];
      return [{ code: r.code, supplier: r.supplier, before: was, now }];
    }).sort((a, b) => Math.abs(b.now - b.before) - Math.abs(a.now - a.before)),
  };

  if (dryRun) return { ok: true, quotesReport: report };

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from("fmc_price_quotes")
      .upsert(rows.slice(i, i + 500), { onConflict: "code,supplier,unit,venue_id" });
    if (error) return { error: error.message, wrote: i };
  }
  // and drop what FMC no longer offers, one key at a time rather than a broad
  // filter — a delete that matches more than intended cannot be undone here.
  for (const g of gone) {
    const { error } = await sb.from("fmc_price_quotes").delete()
      .eq("venue_id", VENUE).eq("code", g.code)
      .eq("supplier", g.supplier).eq("unit", g.unit);
    if (error) return { error: error.message };
  }
  const { count } = await sb.from("fmc_price_quotes")
    .select("code", { count: "exact", head: true }).eq("venue_id", VENUE);
  return { ok: true, quotesReport: report, quoteRowsInTable: count };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad JSON" }, 400); }

  // More than one person updates the list, so FMC_UPLOAD_PIN is a COMMA-
  // SEPARATED list of codes rather than a single one - Francesco's and Aung's.
  // Kept in the secret rather than in this file so a person can be added or
  // taken off without deploying the function, which matters because the next
  // change to it is likely to be removing someone.
  //
  // Still one env var, still an exact match, and a blank secret still refuses
  // everything: an empty list cannot accidentally let anyone in.
  const pins = String(Deno.env.get("FMC_UPLOAD_PIN") || "")
    .split(",").map((p) => p.trim()).filter(Boolean);
  if (!pins.length || !pins.includes(String(body.passcode || "").trim())) {
    return json({ error: "That code is not right." }, 401);
  }

  const master: any[] = body.master || [];
  const assortment: string[] = body.assortment || [];
  const quotes: any[] = body.quotes || [];

  // The price quotes stand on their own: they are their own export, they answer
  // their own question, and they go stale on their own schedule. So they can be
  // loaded without the other two rather than forcing all three every time - the
  // thing that rots is the one nobody can be bothered to refresh.
  if (quotes.length && !master.length && !assortment.length) {
    const sbq = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const out = await processQuotes(sbq, quotes, !!body.dryRun);
    return json(out, out.error ? (out.problems ? 422 : 500) : 200);
  }

  // ---- refuse a bad parse before it can touch anything --------------------
  const problems: string[] = [];
  if (master.length < MASTER_FLOOR) {
    problems.push(
      `The article file gave ${master.length} articles. Under ${MASTER_FLOOR} ` +
      `means it did not read properly, or it was exported with a filter on.`,
    );
  }
  if (assortment.length < ASSORTMENT_FLOOR) {
    problems.push(
      `The assortment list gave ${assortment.length} lines. Under ${ASSORTMENT_FLOOR} ` +
      `means some pages did not read.`,
    );
  }
  const badCodes = master.filter((m) => !/^\d{7}$/.test(String(m.code || "")));
  if (badCodes.length) {
    problems.push(
      `${badCodes.length} article numbers are not 7 digits — e.g. ` +
      badCodes.slice(0, 3).map((m) => `"${m.code}"`).join(", "),
    );
  }
  if (problems.length) return json({ error: "refused", problems }, 422);

  const url = Deno.env.get("SUPABASE_URL")!;
  const sb = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const byCode = new Map<string, any>();
  // FIRST row wins, and it must: `set` on every row would keep the LAST,
  // and FMC has 4029136 on both Baby Capsicum Mix and Potato Large Peeled.
  // Keeping the last flipped that row to Potato at 3.20 against Capsicum's
  // 62.50 - a 95% 'price move' that is really the two paths disagreeing
  // about which article the number belongs to. The Python harvest keeps
  // the first, so this does too.
  for (const m of master) if (!byCode.has(String(m.code))) byCode.set(String(m.code), m);

  const fixed = resolveClipped(assortment, byCode);
  if (fixed.ties.length) {
    return json({
      error: "refused",
      problems: [
        "The assortment list clipped these names and more than one article " +
        "fits each, so nothing was written: " + fixed.ties.join(" | "),
      ],
    }, 422);
  }

  const byName = new Map<string, string>();
  for (const [code, rec] of byCode) if (!byName.has(bare(rec.name))) byName.set(bare(rec.name), code);
  const assortedCodes = new Set<string>();
  const unmatched: string[] = [];
  for (const n of fixed.names) {
    const code = byName.get(bare(n));
    if (code) assortedCodes.add(code);
    else unmatched.push(n);
  }

  // ---- what is there now, so the answer can be a diff and not a guess -----
  const existing: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("fmc_articles")
      .select("code,name,on_assortment,price_per_base_unit")
      .eq("venue_id", VENUE).range(from, from + 999);
    if (error) return json({ error: error.message }, 500);
    existing.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const was = new Map(existing.map((r) => [r.code, r]));
  const wasAssorted = new Set(existing.filter((r) => r.on_assortment).map((r) => r.code));

  const drop = wasAssorted.size - assortedCodes.size;
  if (!body.force && wasAssorted.size && drop > Math.max(BIG_DROP, wasAssorted.size * 0.02)) {
    return json({
      error: "refused",
      problems: [
        `The list had ${wasAssorted.size} orderable articles and this one has ` +
        `${assortedCodes.size} — ${drop} fewer. That is more than FMC retiring ` +
        `a line, so it reads like a bad export. Nothing was written.`,
      ],
    }, 422);
  }

  const stamp = new Date().toISOString();
  // Built from the DEDUPED map, never from the raw array. FMC's own file has
  // at least one number on two articles - 4029136 is on both Baby Capsicum
  // Mix and Potato Large Peeled - and Postgres rejects the whole batch with
  // "ON CONFLICT DO UPDATE command cannot affect row a second time" when the
  // same code appears twice in one upsert. First row wins, exactly as it does
  // in the Python harvest, so the two paths agree.
  const rows = [...byCode.values()].map((m) => ({
    code: String(m.code),
    name: m.name,
    unit: m.store_unit || "",
    on_assortment: assortedCodes.has(String(m.code)),
    retiring: !!m.retired,
    code_source: "master",
    venue_id: VENUE,
    harvested_at: stamp,
    assortment_checked_at: stamp,
    item_group: m.item_group || null,
    base_unit: m.base_unit || null,
    store_unit: m.store_unit || null,
    price_per_base_unit: m.price_per_base_unit ?? null,
    master_harvested_at: stamp,
  }));

  const report = {
    articles: rows.length,
    orderable: assortedCodes.size,
    added: rows.filter((r) => !was.has(r.code)).map((r) => r.name).slice(0, 50),
    addedCount: rows.filter((r) => !was.has(r.code)).length,
    // Only an article the master KNOWS about can be reported as having left
    // the assortment. A code missing from the master is a hole in that export
    // — the food-only export drops the whole beverage range — and reading it
    // as "no longer orderable" would let one file overrule the other. The
    // printed list is the only thing allowed to answer this, and for a code
    // it cannot match it has not answered at all.
    noLongerOrderable: existing
      .filter((r) => r.on_assortment && !assortedCodes.has(r.code) && byCode.has(r.code))
      .map((r) => `${r.code}  ${r.name}`),
    nowOrderable: [...assortedCodes]
      .filter((c) => !wasAssorted.has(c))
      .map((c) => `${c}  ${byCode.get(c)?.name || ""}`),
    priceMoved: rows.flatMap((r) => {
      const b = was.get(r.code);
      if (!b || b.price_per_base_unit == null || r.price_per_base_unit == null) return [];
      const before = Number(b.price_per_base_unit), now = Number(r.price_per_base_unit);
      if (!before || Math.abs(now - before) / before <= 0.02) return [];
      return [{ code: r.code, name: r.name, before, now }];
    }).sort((a, b) => Math.abs(b.now - b.before) - Math.abs(a.now - a.before)),
    // Named, never silently dropped — an assortment line that matches no
    // article is the case where a chef loses the ability to order something.
    unmatchedAssortmentLines: unmatched,
    dryRun: !!body.dryRun,
  };

  if (body.dryRun) {
    if (!quotes.length) return json({ ok: true, report });
    const q = await processQuotes(sb, quotes, true);
    if (q.error) return json(q, q.problems ? 422 : 500);
    return json({ ok: true, report, quotesReport: q.quotesReport });
  }

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from("fmc_articles")
      .upsert(rows.slice(i, i + 500), { onConflict: "code" });
    if (error) return json({ error: error.message, wrote: i }, 500);
  }

  // Anything the printed list no longer carries stops being orderable. The
  // row stays — a market-list line or a recipe may still point at it, and
  // that is a decision per item, not a cleanup.
  // No second pass to switch anything off. Every row above already carries
  // its own `on_assortment`, so an article that left the list is demoted by
  // the upsert itself — and an article the master never mentioned is left
  // exactly as it was, which is the whole point of the note above. Nothing
  // is ever deleted: a market-list line or a recipe may still point at it.

  const { count } = await sb.from("fmc_articles")
    .select("code", { count: "exact", head: true }).eq("venue_id", VENUE);

  // The articles are already written by here. If the quotes then fail, say so
  // plainly rather than returning a clean ok — a half-done update that reports
  // success is the failure mode this whole function is built to avoid.
  if (quotes.length) {
    const q = await processQuotes(sb, quotes, false);
    if (q.error) {
      return json({
        ok: false, report, rowsInTable: count,
        error: "The article list was updated. The supplier list was NOT: " + q.error,
        problems: q.problems,
      }, 207);
    }
    return json({ ok: true, report, rowsInTable: count,
                  quotesReport: q.quotesReport, quoteRowsInTable: q.quoteRowsInTable });
  }
  return json({ ok: true, report, rowsInTable: count });
});
