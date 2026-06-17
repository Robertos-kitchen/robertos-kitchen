// supabase/functions/send-market-order/index.ts
// Sends the Market List order to the chefs via Resend.
// Mirrors send-closing-report: POST { subject, html } with anon Bearer.
// Verified domain: kitchenteam.robertos.ae

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const FROM = "Roberto's Kitchen <orders@kitchenteam.robertos.ae>";
const TO = ["dvalla@robertos.ae", "astellacci@robertos.ae"]; // Danilo + Antonio

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { subject, html } = await req.json();
    if (!subject || !html) {
      return new Response(JSON.stringify({ error: "subject and html required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM, to: TO, subject, html }),
    });

    const data = await r.json();
    if (!r.ok) {
      return new Response(JSON.stringify({ error: "resend failed", detail: data }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true, id: data.id }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
