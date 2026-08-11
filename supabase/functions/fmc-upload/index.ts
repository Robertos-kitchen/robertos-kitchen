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

  if (body.dryRun) return json({ ok: true, report });

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
  return json({ ok: true, report, rowsInTable: count });
});
