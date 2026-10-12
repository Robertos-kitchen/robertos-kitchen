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
//
// 12 Oct 2026 (Francesco): NEW cards are grouped. 13 cards that day went out as 26 emails and
// the free Resend day (100) ran out before the closing report. The database now holds a new
// card for 30 minutes (maint_retry), and the row it then asks for takes every other waiting
// 'new' row for the same people with it: one email, all the cards. A check still goes at once.
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
const FOOT = "Roberto's Kitchen app. This is an automated message; please do not reply.";
const linkOf = (c: Card) => APP + "?maint=" + c.id;

function mediaOf(c: Card) {
  const photos = (c.media || []).filter((m: any) => m.kind === "photo").length;
  const videos = (c.media || []).filter((m: any) => m.kind === "video").length;
  return [photos ? photos + (photos === 1 ? " photo" : " photos") : "", videos ? videos + (videos === 1 ? " video" : " videos") : ""].filter(Boolean).join(" · ") || "none";
}
function newRows(c: Card): [string, string][] {
  return [["Reported by", `${c.reported_by}, ${when(c.reported_at)}`], ["Where", c.location], ["Equipment", c.equipment], ["Problem", c.problem], ["Media", mediaOf(c)]];
}
const tableOf = (rows: [string, string][]) =>
  '<table style="margin:0 18px;border-collapse:collapse;font-size:14px">' + rows.map(([k, v]) =>
    '<tr><td style="padding:4px 14px 4px 0;color:#5f4c3d;vertical-align:top;white-space:nowrap">' + esc(k) + '</td><td style="padding:4px 0">' + esc(v).replace(/\n/g, "<br>") + "</td></tr>").join("") + "</table>";
const buttonOf = (href: string, label: string) =>
  '<p style="margin:18px"><a href="' + esc(href) + '" style="display:inline-block;background:#410207;color:#f5ede0;padding:11px 18px;border-radius:10px;font-weight:bold;text-decoration:none">' + esc(label) + "</a></p>";
const shell = (band: string, inner: string) =>
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#2a1a10;max-width:560px">' +
  '<div style="background:#410207;color:#f5ede0;padding:14px 18px;font-family:Georgia,serif;font-size:22px">' + esc(band) + "</div>" + inner +
  '<p style="margin:18px;font-size:12px;color:#5f4c3d">' + esc(FOOT) + "</p></div>";

function build(kind: string, c: Card) {
  const short = c.problem.length > 60 ? c.problem.slice(0, 57).trimEnd() + "…" : c.problem;
  let subject: string, band: string, intro: string, rows: [string, string][];
  if (kind === "new") {
    subject = `New job card ${jc(c.card_no)}: ${c.equipment}, ${short}`;
    band = `New job card · ${jc(c.card_no)}`;
    intro = c.source === "calendar" ? "A job on the maintenance calendar is past its date, so it has opened a job card." : "A new maintenance problem has been reported in the kitchen.";
    rows = newRows(c);
  } else {
    subject = `${jc(c.card_no)} is ready for your check: ${c.equipment}`;
    band = `Ready for your check · ${jc(c.card_no)}`;
    intro = "The technician has finished this job and signed it. It stays open until Chef Danilo or Chef Antonio checks the repair and signs with their staff code.";
    rows = [["Equipment", `${c.equipment} (${c.location})`], ["Problem", c.problem], ["Work completed", c.work_done || ""],
      ["Final cost", aed(c.final_cost)], ["Completed", `${when(c.completed_at)} by ${c.tech_signed_by || ""}`]];
  }
  const link = linkOf(c);
  const text = intro + "\n\n" + rows.map(([k, v]) => `${k}: ${v}`).join("\n") + "\n\nOpen the job card: " + link + "\n\n" + FOOT;
  const html = shell(band, '<p style="margin:14px 18px">' + esc(intro) + "</p>" + tableOf(rows) + buttonOf(link, "Open the job card"));
  return { subject, text, html };
}

// Several new cards for the same people, in one email. Each card keeps its own facts and its own link.
function buildMany(cards: Card[]) {
  const n = cards.length;
  const nos = cards.map((c) => jc(c.card_no));
  const subject = `${n} new job cards: ${nos.length > 6 ? nos.slice(0, 6).join(", ") + " and " + (nos.length - 6) + " more" : nos.join(", ")}`;
  const band = `${n} new job cards`;
  const intro = `${n} new job cards are waiting for maintenance. Each one has its own link below.`;
  const text = intro + "\n\n" + cards.map((c) =>
    `${jc(c.card_no)} · ${c.equipment}\n` + newRows(c).map(([k, v]) => `${k}: ${v}`).join("\n") + `\nOpen ${jc(c.card_no)}: ${linkOf(c)}`).join("\n\n") + "\n\n" + FOOT;
  const html = shell(band, '<p style="margin:14px 18px">' + esc(intro) + "</p>" + cards.map((c) =>
    '<div style="margin:18px 0 0;border-top:1px solid #e1d3c2;padding-top:12px">' +
    '<div style="margin:0 18px 6px;font-family:Georgia,serif;font-size:17px;font-weight:bold;color:#410207">' + esc(jc(c.card_no) + " · " + c.equipment) + "</div>" +
    tableOf(newRows(c)) + buttonOf(linkOf(c), "Open " + jc(c.card_no)) + "</div>").join(""));
  return { subject, text, html };
}

const sameList = (a: string[] | null, b: string[] | null) => [...(a || [])].sort().join(",") === [...(b || [])].sort().join(",");

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

  // a new card takes every other waiting new card for the same people with it, each claimed
  // the same guarded way, so a card can only ever ride in one email
  const taken: any[] = [m];
  if (m.kind === "new") {
    const sib = await sb.from("maint_mail").select("*").eq("kind", "new").eq("is_test", m.is_test).in("status", ["queued", "failed"]).neq("id", id).order("id");
    for (const s of (sib.data || [])) {
      if (!sameList(s.to_list, m.to_list)) continue;
      if (s.status === "failed" && s.tries >= 3) continue;
      const u = await sb.from("maint_mail").update({ status: "sending", tries: s.tries + 1 }).eq("id", s.id).eq("status", s.status).select("id");
      if (!u.error && u.data && u.data.length) taken.push(s);
    }
  }
  const allIds = taken.map((t) => t.id);

  const got = await sb.from("maint_cards").select("*").in("id", taken.map((t) => t.card_id));
  const byId: Record<string, Card> = {};
  for (const c of (got.data || [])) byId[c.id] = c;
  const lost = taken.filter((t) => !byId[t.card_id]).map((t) => t.id);
  if (lost.length) await sb.from("maint_mail").update({ status: "failed", error: "card not found" }).in("id", lost);
  const ids = taken.filter((t) => byId[t.card_id]).map((t) => t.id);
  const cards = [...new Set(taken.filter((t) => byId[t.card_id]).map((t) => t.card_id))].map((k) => byId[k]).sort((a, b) => a.card_no - b.card_no);
  if (got.error || !cards.length) return json({ error: "card not found" }, 404);

  const mail = cards.length === 1 ? build(m.kind, cards[0]) : buildMany(cards);
  if (m.is_test) mail.subject = "[TEST] " + mail.subject;
  if (!RESEND_API_KEY) {
    await sb.from("maint_mail").update({ status: "failed", error: "no RESEND_API_KEY" }).in("id", ids);
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
                                               : { status: "failed", error: err.slice(0, 500) }).in("id", ids);
  console.log("maint-notify", allIds.join("+"), m.kind, cards.length + " card(s)", resendId ? "sent " + resendId : "FAILED " + err);
  return resendId ? json({ ok: true, id: resendId, cards: cards.length }) : json({ error: err }, 502);
});
