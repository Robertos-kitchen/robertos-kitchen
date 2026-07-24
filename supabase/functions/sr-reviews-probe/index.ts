// ============================================================
// sr-reviews-probe - TEMPORARY discovery probe (Kitchen project zrpglswalgjbtghudmhu)
//
// Question it answers: does our SevenRooms account expose guest reviews
// (Review Aggregation, which is where the monthly Guest Satisfaction Report's
// mixed SevenRooms+Google "Platform" column comes from) - and if so, does the
// payload carry the REVIEW TEXT or only star ratings/counts?
//
// It reads SEVENROOMS_CLIENT_ID / _SECRET / _VENUE_GROUP_ID that are ALREADY
// set as secrets on this project. Nobody needs to see or paste a credential.
//
// It is READ-ONLY: every call is a GET. It writes nothing, to SevenRooms or to us.
//
// PRIVACY: it never returns review text or guest values - only HTTP status,
// the field NAMES it found, and counts. Enough to decide what is buildable
// without dragging guest data through a chat window.
//
// DELETE THIS FUNCTION once we have the answer. It is a probe, not a feature.
//
// Deploy: dashboard -> Functions -> sr-reviews-probe -> paste -> Deploy updates
// ============================================================

const SR_BASE = "https://api.sevenrooms.com/2_4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

async function getToken(): Promise<string> {
  const clientId = Deno.env.get("SEVENROOMS_CLIENT_ID");
  const clientSecret = Deno.env.get("SEVENROOMS_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Missing SevenRooms credentials on this project");
  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  const res = await fetch(`${SR_BASE}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  const data = await res.json();
  const token = data?.data?.token ?? data?.token;
  if (!token) throw new Error("No token in auth response");
  return token;
}

// Field NAMES only, never values.
function shapeOf(v: any, depth = 0): any {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return { array_len: v.length, item_fields: v.length && depth < 2 ? shapeOf(v[0], depth + 1) : null };
  if (typeof v === "object") {
    const out: Record<string, string> = {};
    for (const k of Object.keys(v).slice(0, 40)) {
      const val = (v as any)[k];
      out[k] = Array.isArray(val) ? "array" : val === null ? "null" : typeof val;
    }
    return out;
  }
  return typeof v;
}

// Does this payload smell like it carries actual written reviews?
const TEXT_HINTS = ["text", "body", "comment", "content", "review", "feedback", "message", "notes"];
const RATING_HINTS = ["rating", "stars", "score", "sentiment"];
const SOURCE_HINTS = ["platform", "source", "channel", "provider", "site"];
function hintsIn(obj: any): { text: string[]; rating: string[]; source: string[] } {
  const keys: string[] = [];
  const walk = (o: any, d = 0) => {
    if (!o || typeof o !== "object" || d > 3) return;
    if (Array.isArray(o)) { if (o.length) walk(o[0], d + 1); return; }
    for (const k of Object.keys(o)) { keys.push(k.toLowerCase()); walk(o[k], d + 1); }
  };
  walk(obj);
  const hit = (hints: string[]) => [...new Set(keys.filter((k) => hints.some((h) => k.includes(h))))];
  return { text: hit(TEXT_HINTS), rating: hit(RATING_HINTS), source: hit(SOURCE_HINTS) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "content-type": "application/json" } });

  try {
    const token = await getToken();
    const vg = Deno.env.get("SEVENROOMS_VENUE_GROUP_ID") || "";

    // SevenRooms does not publish a reviews endpoint we know of, so this is a
    // discovery sweep: ask for each plausible path and report what answers.
    const candidates = [
      "/reviews",
      "/review_aggregation",
      "/reviews/summary",
      "/feedback",
      "/guest_feedback",
      "/surveys",
      "/survey_responses",
      "/venues",
    ];

    const results: any[] = [];
    for (const path of candidates) {
      const url = new URL(SR_BASE + path);
      if (vg && path !== "/venues") url.searchParams.set("venue_group_id", vg);
      url.searchParams.set("limit", "3");
      try {
        const r = await fetch(url.toString(), { method: "GET", headers: { Authorization: token, Accept: "application/json" } });
        const raw = await r.text();
        let parsed: any = null;
        try { parsed = JSON.parse(raw); } catch { /* not json */ }
        const rows = parsed?.data?.results ?? parsed?.results ?? parsed?.data ?? null;
        results.push({
          path,
          status: r.status,
          ok: r.ok,
          top_level_keys: parsed ? Object.keys(parsed).slice(0, 12) : null,
          row_count: Array.isArray(rows) ? rows.length : null,
          fields: Array.isArray(rows) && rows.length ? shapeOf(rows[0]) : (r.ok ? shapeOf(parsed) : null),
          looks_like_reviews: r.ok && parsed ? hintsIn(parsed) : null,
          error_snippet: r.ok ? null : raw.slice(0, 180),
        });
      } catch (e) {
        results.push({ path, status: "fetch_threw", error_snippet: String(e).slice(0, 180) });
      }
    }

    const reachable = results.filter((r) => r.ok).map((r) => r.path);
    const withText = results.filter((r) => r.ok && r.looks_like_reviews?.text?.length).map((r) => r.path);

    return json({
      probe: "sevenrooms review availability",
      auth: "ok - credentials on this project are valid",
      venue_group_id_set: !!vg,
      summary: {
        endpoints_reachable: reachable,
        endpoints_with_texty_fields: withText,
        verdict: withText.length
          ? "Something review-shaped WITH text fields is reachable - full module is plausible"
          : reachable.length
          ? "Endpoints answered but nothing text-shaped - likely ratings/counts only, or wrong paths"
          : "No review endpoint answered - SevenRooms Review Aggregation is probably not on this account/plan",
      },
      results,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
