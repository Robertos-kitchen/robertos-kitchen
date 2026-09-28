// supabase/functions/send-closing-report/index.ts  (KITCHEN project)
// Emails the Kitchen closing report.
//
// 28 Sep 2026 — recipients moved out of code into FOH Admin → Emails, key
// `closing_report_kitchen` (Tell us 21887994: "include sajad into the mail of the
// closing report"). Same model as send-roster: this function reads the FOH
// project's app_users over PostgREST with the FOH_SERVICE_KEY secret, so a tick
// takes effect on the next send with no deploy.
//
// Before this, the list was written here: To Francesco, Cc Andrea Falcone,
// Danilo, Antonio Stellacci. That list is kept as the fallback — an unreadable
// or empty Admin list must never mean "emailed nobody".
//
// Also removes the Resend key that used to sit inline in this file; it now reads
// the RESEND_API_KEY secret like every other sender on this project.
//
// {check:true} returns who a real send would reach and sends NOTHING — it is
// what Admin → Emails → "Check who really gets it" calls.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const FOH_URL = "https://paoaivwtkzujmrgrfjuq.supabase.co";
const NOTIFY_KEY = "closing_report_kitchen";
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";

const FALLBACK_TO = [
  "fguarracino@robertos.ae",
  "afalcone@robertos.ae",
  "dvalla@robertos.ae",
  "astellacci@robertos.ae",
];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Same lookup as send-roster: total, never throws, and says WHICH failure it hit.
type Lookup = { list: string[] | null; why: string | null };
async function fromAppUsers(key: string): Promise<Lookup> {
  const svc = Deno.env.get("FOH_SERVICE_KEY");
  if (!svc) return { list: null, why: "no-key" };
  try {
    const url = FOH_URL + "/rest/v1/app_users?select=email&notify=cs." + encodeURIComponent("{" + key + "}");
    const r = await fetch(url, { headers: { apikey: svc, Authorization: "Bearer " + svc } });
    if (!r.ok) return { list: null, why: "http-" + r.status };
    const rows = await r.json();
    if (!Array.isArray(rows)) return { list: null, why: "not-a-list" };
    const emails = rows
      .map((x: { email?: unknown }) => typeof x.email === "string" ? x.email.trim().toLowerCase() : "")
      .filter((e: string) => e.includes("@"));
    return emails.length ? { list: emails, why: null } : { list: null, why: "empty" };
  } catch (_) {
    return { list: null, why: "threw" };
  }
}
function fallbackReason(why: string | null): string {
  if (why === "empty")  return "the Admin → Emails list came back empty";
  if (why === "no-key") return "this project has no key for reading the Admin → Emails list";
  if (why === "threw")  return "the Admin → Emails list could not be reached";
  if (why && why.indexOf("http-") === 0) return "the Admin → Emails list was refused (" + why + ")";
  return "the Admin → Emails list could not be read";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = await req.json().catch(() => ({}));
    const look = await fromAppUsers(NOTIFY_KEY);
    const usedFallback = look.list === null;
    const to = look.list || FALLBACK_TO;
    const reason = usedFallback ? fallbackReason(look.why) : null;

    if (body && body.check === true) {
      return json({ checked: true, sent: false, to: [], recipients: to, usedFallback,
                    fallbackReason: reason, fallbackWhy: look.why });
    }

    if (!RESEND_KEY) return json({ ok: false, error: "RESEND_API_KEY is not set on this project" }, 500);

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Roberto's Kitchen <roster@kitchenteam.robertos.ae>",
        to,
        subject: body.subject || "Closing Report",
        html: body.html || "",
      }),
    });
    const data = await res.json().catch(() => ({}));
    console.log("RESEND STATUS:", res.status, "TO:", to.join(","), "FALLBACK:", usedFallback, "RESPONSE:", JSON.stringify(data));

    return json({ ...data, ok: res.ok, recipients: to, usedFallback, fallbackReason: reason },
                res.ok ? 200 : 500);
  } catch (e) {
    console.log("FUNCTION ERROR:", String(e));
    return json({ ok: false, error: String(e) }, 500);
  }
});
