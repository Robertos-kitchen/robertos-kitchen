// Supabase Edge Function: secure proxy to Anthropic Claude API
// Holds the ANTHROPIC_API_KEY as a server-side secret — never exposed to the browser.
// Handles two actions: { action:'chat', system, messages } and { action:'translate', items:[...] }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
// Optional shared secret so only your app can call this function (set SURVEY_PROXY_SECRET in Supabase).
const PROXY_SECRET = Deno.env.get("SURVEY_PROXY_SECRET") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-proxy-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  if (!ANTHROPIC_API_KEY) return json({ error: "Server not configured: missing ANTHROPIC_API_KEY" }, 500);

  // Optional gate: require the shared secret if one is set
  if (PROXY_SECRET) {
    const got = req.headers.get("x-proxy-secret") ?? "";
    if (got !== PROXY_SECRET) return json({ error: "Unauthorized" }, 401);
  }

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }

  const action = payload.action || "chat";

  try {
    if (action === "translate") {
      const items: string[] = Array.isArray(payload.items) ? payload.items.slice(0, 50) : [];
      if (!items.length) return json({ translations: [] });
      const prompt =
        "Translate each of the following short staff-survey answers to natural English. " +
        "Return ONLY a JSON array of strings, in the same order, no other text.\n\n" +
        JSON.stringify(items);
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001", // cheap model is fine for translation
          max_tokens: 1500,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data = await r.json();
      let txt = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
      txt = txt.replace(/```json|```/g, "").trim();
      let arr: string[] = [];
      try { arr = JSON.parse(txt); } catch { arr = items; }
      return json({ translations: arr });
    }

    // default: chat
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: payload.model || "claude-sonnet-4-6",
        max_tokens: payload.max_tokens || 1000,
        system: payload.system || "",
        messages: payload.messages || [],
      }),
    });
    const data = await r.json();
    if (data.error) return json({ error: data.error.message || "Anthropic error" }, 502);
    const text = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
    return json({ text });
  } catch (e) {
    return json({ error: "Proxy failure: " + (e?.message || String(e)) }, 500);
  }
});