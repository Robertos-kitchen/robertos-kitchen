// maint-notify — sends the Kitchen Maintenance emails (25 Sep 2026, Chef Andrea, Tell us fe2b2456).
//
// The DATABASE decides who gets what: maint_report / maint_roll / maint_step queue a row in
// maint_mail (card, kind, recipients) and call this function through pg_net with {mail: <id>}.
// The app never calls it. So the only thing a caller can do is ask for an already-queued row to
// be sent — once: the row is claimed (queued|failed -> sending) before anything goes out.
//   kind 'new'   -> the technician(s): a new job card
//   kind 'check' -> the chefs (Danilo, Antonio): a completed card waiting for their check
//   kind 'followup' -> the technician who has the card: a chef asked for an update on a card
//                      nobody has moved for a day (14 Oct 2026, Chef Andrea, Send feedback ba7f8e65)
//   kind 'tools'    -> the technicians: the month-end tools count is due (or the month ended unsigned).
//                      No card: the row carries the month. Queued by maint_tools_remind() (cron, 09:00
//                      Dubai) 3 days before month end and again after it if still unsigned (16 Oct 2026,
//                      Chef Andrea, Send feedback 9d2beffc; Francesco: "Oliver gets it by email").
//   kind 'buy'      -> the buyers (maint_people role 'buyer', Andrea Falcone): the technician asks for a
//                      spare part or tool to be bought, with the exact model, how many, a price range
//                      and photos. No card needed: the row carries buy_id. Sent at once (19 Oct 2026,
//                      Chef Andrea, Send feedback 2ce28fd4 + 0dbd7f59: "it has to work like a purchase request").
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
const STATUS: Record<string, string> = { new: "New", acknowledged: "Acknowledged", in_progress: "In progress", on_hold: "On hold", completed: "Completed" };
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
  } else if (kind === "followup") {
    const by = c.followup_by || "The chef";
    subject = `Update needed on ${jc(c.card_no)}: ${c.equipment}`;
    band = `Update needed · ${jc(c.card_no)}`;
    intro = `${by} is asking for an update on this job card. It has not been updated since ${when(c.updated_at || c.reported_at)}. Open it and update it: start the work, put it on hold with the reason, save the assessment, or complete it.`;
    rows = [["Equipment", `${c.equipment} (${c.location})`], ["Problem", c.problem], ["Status", (STATUS[c.status] || c.status) + (c.status === "on_hold" && c.hold_reason ? `: ${c.hold_reason}` : "")],
      ["Reported by", `${c.reported_by}, ${when(c.reported_at)}`], ["Asked by", `${by}, ${when(c.followup_at)}`]];
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

// The month-end tools count. The numbers come from the database at the moment of sending.
const TOOLS_LINK = APP + "maintenance.html?tab=tools";
async function buildTools(sb: any, m: any) {
  const month: string = m.month; // 'YYYY-MM-01'
  const name = new Date(month + "T12:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const d = new Date(month + "T12:00:00Z"); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0);
  const last = d.toISOString().slice(0, 10);
  const lastSay = d.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
  const sentDay = new Date(m.created_at).toLocaleDateString("en-CA", { timeZone: "Asia/Dubai" });
  const late = sentDay > last;
  const tools = await sb.from("maint_tools").select("id", { count: "exact", head: true }).eq("active", true);
  const counted = await sb.from("maint_tool_counts").select("tool_id", { count: "exact", head: true }).eq("month", month);
  if (tools.error || counted.error) throw new Error("tools not read");
  const n = tools.count ?? 0, c = counted.count ?? 0;
  const subject = late ? `Tools count for ${name} is not signed yet` : `Month-end tools count: ${name}`;
  const band = late ? `Tools count overdue · ${name}` : `Month-end tools count · ${name}`;
  const intro = late
    ? `${name} has ended and its tools count is not signed. Count every tool, then sign the count with your staff code.`
    : `It is time for the month-end tools count. Count every tool on the list, type how many you find, then sign the count with your staff code by ${lastSay}.`;
  const rows: [string, string][] = [["Month", name], ["Tools on the list", String(n)], ["Counted so far", `${c} of ${n}`], ["Sign by", late ? "Now, the month is over" : lastSay]];
  const text = intro + "\n\n" + rows.map(([k, v]) => `${k}: ${v}`).join("\n") + "\n\nOpen the tools count: " + TOOLS_LINK + "\n\n" + FOOT;
  const html = shell(band, '<p style="margin:14px 18px">' + esc(intro) + "</p>" + tableOf(rows) + buttonOf(TOOLS_LINK, "Open the tools count"));
  return { subject, text, html };
}

// A purchase request. The photos go with the mail as attachments, so the buyer has them in the shop:
// Outlook strips an <img> that points outside the mail, so a picture in the body alone arrives empty.
const BUY_LINK = (id: string) => APP + "maintenance.html?tab=buy&buy=" + id;
const mediaPublic = (p: string) => (Deno.env.get("SUPABASE_URL") ?? "") + "/storage/v1/object/public/maint-media/" + p.split("/").map(encodeURIComponent).join("/");
const bn = (n: number) => "PR-" + String(n).padStart(4, "0");
async function buildBuy(sb: any, m: any) {
  const got = await sb.from("maint_buys").select("*").eq("id", m.buy_id).maybeSingle();
  if (got.error || !got.data) throw new Error("request not found");
  const b = got.data;
  let card = "";
  if (b.card_id) {
    const c = await sb.from("maint_cards").select("card_no,equipment").eq("id", b.card_id).maybeSingle();
    if (c.data) card = `${jc(c.data.card_no)} · ${c.data.equipment}`;
  }
  const range = Number(b.price_min) === Number(b.price_max) ? aed(b.price_min) : `${aed(b.price_min)} to ${aed(b.price_max)}`;
  const photos: string[] = (b.media || []).map((x: any) => mediaPublic(x.path));
  const subject = `To buy ${bn(b.buy_no)}: ${b.qty} × ${b.item}`;
  const band = `To buy · ${bn(b.buy_no)}`;
  const intro = `${b.asked_by} needs this bought. The exact model, the price range and the photos are below. When you hand it over, open the request and press Provided.`;
  const rows: [string, string][] = [["Item", b.item], ["Exact model", b.model], ["How many", String(b.qty)], ["Price range", range + (b.qty > 1 ? " each" : "")]];
  if (b.note) rows.push(["Note", b.note]);
  if (card) rows.push(["For job card", card]);
  rows.push(["Asked by", `${b.asked_by}, ${when(b.asked_at)}`], ["Photos", photos.length ? String(photos.length) : "none"]);
  const link = BUY_LINK(b.id);
  const text = intro + "\n\n" + rows.map(([k, v]) => `${k}: ${v}`).join("\n") + (photos.length ? "\n\n" + photos.join("\n") : "") + "\n\nOpen the request: " + link + "\n\n" + FOOT;
  const pics = photos.length ? '<p style="margin:14px 18px 0">Photos, attached to this email and here: ' + photos.map((u, i) =>
    '<a href="' + esc(u) + '" style="color:#410207;font-weight:bold">Photo ' + (i + 1) + "</a>").join(" · ") + "</p>" : "";
  const attachments = photos.map((u, i) => ({ path: u, filename: `${bn(b.buy_no)}-photo-${i + 1}.${(u.split(".").pop() || "jpg").toLowerCase()}` }));
  const html = shell(band, '<p style="margin:14px 18px">' + esc(intro) + "</p>" + tableOf(rows) + pics + buttonOf(link, "Open the request"));
  return { subject, text, html, attachments };
}

async function sendResend(to: string[], mail: { subject: string; text: string; html: string; attachments?: { path: string; filename: string }[] }) {
  let resendId: string | null = null, err = "";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to, subject: mail.subject, text: mail.text, html: mail.html, ...(mail.attachments && mail.attachments.length ? { attachments: mail.attachments } : {}) }),
    });
    const d = await r.json().catch(() => null);
    if (r.ok && d && d.id) resendId = d.id; else err = (d && (d.message || d.error)) ? String(d.message || d.error) : "HTTP " + r.status;
  } catch (e) { err = String((e as Error).message || e); }
  return { resendId, err };
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

  if (m.kind === "tools" || m.kind === "buy") {
    if (!RESEND_API_KEY) { await sb.from("maint_mail").update({ status: "failed", error: "no RESEND_API_KEY" }).eq("id", id); return json({ error: "no key" }, 500); }
    let mail: { subject: string; text: string; html: string; attachments?: { path: string; filename: string }[] };
    try { mail = m.kind === "buy" ? await buildBuy(sb, m) : await buildTools(sb, m); }
    catch (e) { await sb.from("maint_mail").update({ status: "failed", error: String((e as Error).message || e).slice(0, 500) }).eq("id", id); return json({ error: m.kind + " not read" }, 500); }
    if (m.is_test) mail.subject = "[TEST] " + mail.subject;
    const { resendId, err } = await sendResend(m.to_list, mail);
    await sb.from("maint_mail").update(resendId ? { status: "sent", resend_id: resendId, sent_at: new Date().toISOString(), error: null }
                                                 : { status: "failed", error: err.slice(0, 500) }).eq("id", id);
    console.log("maint-notify", id, m.kind, m.month || m.buy_id, resendId ? "sent " + resendId : "FAILED " + err);
    return resendId ? json({ ok: true, id: resendId }) : json({ error: err }, 502);
  }

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
