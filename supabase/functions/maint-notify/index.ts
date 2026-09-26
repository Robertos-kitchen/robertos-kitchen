// maint-notify — sends the Kitchen Maintenance emails (25 Sep 2026, Chef Andrea, Tell us fe2b2456).
//
// The DATABASE decides who gets what: maint_report / maint_roll / maint_step queue a row in
// maint_mail (card, kind, recipients) and call this function through pg_net with {mail: <id>}.
// The app never calls it. So the only thing a caller can do is ask for an already-queued row to
// be sent — once: the row is claimed (queued|failed -> sending) before anything goes out.
//   kind 'new'   -> the technician(s): a new job card
//   kind 'check' -> the chefs (Danilo, Antonio): a completed card waiting for their check
// A test card (is_test) was already addressed to Francesco only by the database; the subject
// gets [TEST] here.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = `Roberto's Kitchen <no-reply@kitchenteam.robertos.ae>`;
const APP = "https://guarracinofamily.github.io/robertos-kitchen/";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const jc = (n: number) => "JC-" + String(n).padStart(4, "0");
const when = (t: string | null) => t ? new Date(t).toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) : "";
const aed = (v: number | null) => v == null ? "" : "AED " + Number(v).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Card = Record<string, any>;

function build(kind: string, c: Card) {
  const photos = (c.media || []).filter((m: any) => m.kind === "photo").length;
  const videos = (c.media || []).filter((m: any) => m.kind === "video").length;
  const media = [photos ? photos + (photos === 1 ? " photo" : " photos") : "", videos ? videos + (videos === 1 ? " video" : " videos") : ""].filter(Boolean).join(" · ") || "none";
  const short = c.problem.length > 60 ? c.problem.slice(0, 57).trimEnd() + "…" : c.problem;
  let subject: string, band: string, intro: string, rows: [string, string][];
  if (kind === "new") {
    subject = `New job card ${jc(c.card_no)}: ${c.equipment}, ${short}`;
    band = `New job card · ${jc(c.card_no)}`;
    intro = c.source === "calendar" ? "A job on the maintenance calendar is past its date, so it has opened a job card." : "A new maintenance problem has been reported in the kitchen.";
    rows = [["Reported by", `${c.reported_by}, ${when(c.reported_at)}`], ["Where", c.location], ["Equipment", c.equipment], ["Problem", c.problem], ["Media", media]];
  } else {
    subject = `${jc(c.card_no)} is ready for your check: ${c.equipment}`;
    band = `Ready for your check · ${jc(c.card_no)}`;
    intro = "The technician has finished this job and signed it. It stays open until Chef Danilo or Chef Antonio checks the repair and signs with their staff code.";
    rows = [["Equipment", `${c.equipment} (${c.location})`], ["Problem", c.problem], ["Work completed", c.work_done || ""],
      ["Final cost", aed(c.final_cost)], ["Completed", `${when(c.completed_at)} by ${c.tech_signed_by || ""}`]];
  }
  const link = APP + "?maint=" + c.id;
  const text = intro + "\n\n" + rows.map(([k, v]) => `${k}: ${v}`).join("\n") + "\n\nOpen the job card: " + link + "\n\nRoberto's Kitchen app. This is an automated message; please do not reply.";
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#2a1a10;max-width:560px">' +
    '<div style="background:#410207;color:#f5ede0;padding:14px 18px;font-family:Georgia,serif;font-size:22px">' + esc(band) + "</div>" +
    '<p style="margin:14px 18px">' + esc(intro) + "</p>" +
    '<table style="margin:0 18px;border-collapse:collapse;font-size:14px">' + rows.map(([k, v]) =>
      '<tr><td style="padding:4px 14px 4px 0;color:#5f4c3d;vertical-align:top;white-space:nowrap">' + esc(k) + '</td><td style="padding:4px 0">' + esc(v).replace(/\n/g, "<br>") + "</td></tr>").join("") + "</table>" +
    '<p style="margin:18px"><a href="' + esc(link) + '" style="display:inline-block;background:#410207;color:#f5ede0;padding:11px 18px;border-radius:10px;font-weight:bold;text-decoration:none">Open the job card</a></p>' +
    '<p style="margin:18px;font-size:12px;color:#5f4c3d">Roberto\'s Kitchen app. This is an automated message; please do not reply.</p></div>';
  return { subject, text, html };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "bad body" }, 400); }
  const id = Number(body?.mail);
  if (!Number.isInteger(id) || id <= 0) return json({ error: "no mail id" }, 400);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // claim it: only a queued (or failed, fewer than 3 tries) row is ever sent, and only once at a time
  const claim = await sb.from("maint_mail").select("*").eq("id", id).maybeSingle();
  if (claim.error || !claim.data) return json({ error: "no such mail" }, 404);
  const m = claim.data;
  if (!(m.status === "queued" || (m.status === "failed" && m.tries < 3))) return json({ ok: true, skipped: m.status });
  const upd = await sb.from("maint_mail").update({ status: "sending", tries: m.tries + 1 }).eq("id", id).eq("status", m.status).select("id");
  if (upd.error || !upd.data || !upd.data.length) return json({ ok: true, skipped: "taken" });

  const card = await sb.from("maint_cards").select("*").eq("id", m.card_id).maybeSingle();
  if (card.error || !card.data) {
    await sb.from("maint_mail").update({ status: "failed", error: "card not found" }).eq("id", id);
    return json({ error: "card not found" }, 404);
  }
  const mail = build(m.kind, card.data);
  if (m.is_test) mail.subject = "[TEST] " + mail.subject;
  if (!RESEND_API_KEY) {
    await sb.from("maint_mail").update({ status: "failed", error: "no RESEND_API_KEY" }).eq("id", id);
    return json({ error: "no key" }, 500);
  }
  let resendId: string | null = null, err = "";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: m.to_list, subject: mail.subject, text: mail.text, html: mail.html }),
    });
    const d = await r.json().catch(() => null);
    if (r.ok && d && d.id) resendId = d.id; else err = (d && (d.message || d.error)) ? String(d.message || d.error) : "HTTP " + r.status;
  } catch (e) { err = String((e as Error).message || e); }
  await sb.from("maint_mail").update(resendId ? { status: "sent", resend_id: resendId, sent_at: new Date().toISOString(), error: null }
                                               : { status: "failed", error: err.slice(0, 500) }).eq("id", id);
  console.log("maint-notify", id, m.kind, resendId ? "sent " + resendId : "FAILED " + err);
  return resendId ? json({ ok: true, id: resendId }) : json({ error: err }, 502);
});
