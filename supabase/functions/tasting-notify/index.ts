// tasting-notify — the Kitchen Tasting time emails (12 Oct 2026, Francesco).
//
// The DATABASE decides who gets what (the maint-notify pattern): tasting_request_new / _decide /
// _cancel queue a row in tasting_mail and call this function through pg_net with {mail: <id>}.
// The app never calls it. So the only thing a caller can do is ask for an already-queued row to
// be sent — once: the row is claimed (queued|failed -> sending) before anything goes out.
//   kind 'ask'    -> Chef Francesco: a chef asks him to taste, with Accept / Pick another time
//   kind 'invite' -> Chef Francesco: the confirmed time as a calendar invite (Outlook adds it)
//   kind 'cancel' -> Chef Francesco: the calendar entry is taken off again
//   kind 'answer' -> the chef who asked: Chef Francesco accepted the time, or moved it
//   kind 'gone'   -> the chef who asked: someone else cancelled it
// The invite's UID is the request id and SEQUENCE is tasting_requests.cal_seq, so a changed time
// updates the same calendar entry instead of adding a second one.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM_ADDR = "no-reply@kitchenteam.robertos.ae";
const FROM = `Roberto's Kitchen <${FROM_ADDR}>`;
const PAGE = "https://guarracinofamily.github.io/robertos-kitchen/tasting.html";
const MINUTES = 60;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const when = (t: string) => new Date(t).toLocaleString("en-GB", { timeZone: "Asia/Dubai", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hour12: false });
const icsTime = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
// RFC 5545: lines of at most 75 octets, continued with CRLF + one space.
function fold(line: string) {
  const enc = new TextEncoder(); const out: string[] = []; let cur = "";
  for (const ch of line) {
    if (enc.encode(cur + ch).length > (out.length ? 74 : 75)) { out.push(cur); cur = ch; } else cur += ch;
  }
  out.push(cur);
  return out.join("\r\n ");
}
function b64(s: string) {
  const bytes = new TextEncoder().encode(s); let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

type Req = Record<string, any>;

function ics(r: Req, dishes: string[], to: string, cancel: boolean) {
  const start = new Date(r.confirmed_at || r.proposed_at);
  const end = new Date(start.getTime() + MINUTES * 60000);
  const summary = (r.is_test ? "[TEST] " : "") + "Tasting: " + dishes.join(", ");
  const desc = "Asked by " + r.asked_by + ".\nDishes: " + dishes.join(", ") + "." + (r.note ? "\nNote: " + r.note : "") + "\n\nScore them here: " + PAGE;
  const lines = [
    "BEGIN:VCALENDAR", "PRODID:-//Roberto's Kitchen//Tasting//EN", "VERSION:2.0", "CALSCALE:GREGORIAN",
    "METHOD:" + (cancel ? "CANCEL" : "REQUEST"),
    "BEGIN:VEVENT",
    "UID:tasting-" + r.id + "@kitchenteam.robertos.ae",
    "SEQUENCE:" + (r.cal_seq || 0),
    "DTSTAMP:" + icsTime(new Date()),
    "DTSTART:" + icsTime(start),
    "DTEND:" + icsTime(end),
    "SUMMARY:" + icsText(summary),
    "LOCATION:" + icsText("Roberto's DIFC, kitchen"),
    "DESCRIPTION:" + icsText(desc),
    "ORGANIZER;CN=Roberto's Kitchen:mailto:" + FROM_ADDR,
    "ATTENDEE;CN=Francesco Guarracino;ROLE=REQ-PARTICIPANT;PARTSTAT=" + (cancel ? "NEEDS-ACTION" : "ACCEPTED") + ";RSVP=FALSE:mailto:" + to,
    "STATUS:" + (cancel ? "CANCELLED" : "CONFIRMED"),
    "TRANSP:OPAQUE",
  ];
  if (!cancel) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Tasting", "TRIGGER:-PT30M", "END:VALARM");
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

function build(kind: string, r: Req, dishes: string[]) {
  const list = dishes.join(", ");
  const n = dishes.length === 1 ? "1 dish" : dishes.length + " dishes";
  const link = (act: string) => PAGE + "?req=" + r.id + (act ? "&do=" + act : "");
  let subject: string, band: string, intro: string, rows: [string, string][], buttons: [string, string, boolean][];
  if (kind === "ask") {
    subject = `${r.asked_by} asks you to taste ${n}: ${when(r.proposed_at)}`;
    band = "Tasting · a time is proposed";
    intro = `${r.asked_by} would like you to taste ${n}.`;
    rows = [["When", when(r.proposed_at)], ["Dishes", list]];
    if (r.note) rows.push(["Note", r.note]);
    buttons = [["Accept this time", link("accept"), true], ["Pick another time", link("change"), false]];
  } else if (kind === "invite") {
    const moved = new Date(r.confirmed_at).getTime() !== new Date(r.proposed_at).getTime();
    subject = `Tasting confirmed: ${when(r.confirmed_at)}`;
    band = "Tasting · confirmed";
    intro = "This tasting is confirmed. The calendar entry is attached to this email." + (moved ? ` ${r.asked_by} had asked for ${when(r.proposed_at)}.` : "");
    rows = [["When", when(r.confirmed_at)], ["Dishes", list], ["Asked by", r.asked_by]];
    if (r.note) rows.push(["Note", r.note]);
    buttons = [["Open the tasting", link(""), true]];
  } else if (kind === "answer") {
    // to the chef who asked: Chef Francesco accepted the time, or moved it
    const moved = new Date(r.confirmed_at).getTime() !== new Date(r.proposed_at).getTime();
    subject = moved ? `Chef Francesco moved your tasting to ${when(r.confirmed_at)}` : `Chef Francesco accepted your tasting: ${when(r.confirmed_at)}`;
    band = moved ? "Tasting · the time has changed" : "Tasting · confirmed";
    intro = moved ? `Chef Francesco will taste at a different time from the one you asked for (${when(r.proposed_at)}).` : "Chef Francesco accepted the time you asked for.";
    rows = [["When", when(r.confirmed_at)], ["Dishes", list]];
    buttons = [["Open the tasting", PAGE, true]];
  } else if (kind === "gone") {
    // to the chef who asked: someone else cancelled it
    subject = `Your tasting was cancelled: ${when(r.confirmed_at || r.proposed_at)}`;
    band = "Tasting · cancelled";
    intro = `The tasting you asked for was cancelled${r.decided_by ? " by " + r.decided_by : ""}. Ask for another time from the Tasting screen.`;
    rows = [["Was", when(r.confirmed_at || r.proposed_at)], ["Dishes", list]];
    buttons = [["Open the tasting", PAGE, true]];
  } else {
    subject = `Tasting cancelled: ${when(r.confirmed_at || r.proposed_at)}`;
    band = "Tasting · cancelled";
    intro = `This tasting was cancelled${r.decided_by ? " by " + r.decided_by : ""}. It comes off your calendar.`;
    rows = [["Was", when(r.confirmed_at || r.proposed_at)], ["Dishes", list], ["Asked by", r.asked_by]];
    buttons = [];
  }
  const foot = "Roberto's Kitchen app. This is an automated message; please do not reply.";
  const text = intro + "\n\n" + rows.map(([k, v]) => `${k}: ${v}`).join("\n") +
    (buttons.length ? "\n\n" + buttons.map(([l, u]) => `${l}: ${u}`).join("\n") : "") + "\n\n" + foot;
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#2a1a10;max-width:560px">' +
    '<div style="background:#410207;color:#f5ede0;padding:14px 18px;font-family:Georgia,serif;font-size:22px">' + esc(band) + "</div>" +
    '<p style="margin:14px 18px">' + esc(intro) + "</p>" +
    '<table style="margin:0 18px;border-collapse:collapse;font-size:14px">' + rows.map(([k, v]) =>
      '<tr><td style="padding:4px 14px 4px 0;color:#5f4c3d;vertical-align:top;white-space:nowrap">' + esc(k) + '</td><td style="padding:4px 0">' + esc(v).replace(/\n/g, "<br>") + "</td></tr>").join("") + "</table>" +
    (buttons.length ? '<p style="margin:18px">' + buttons.map(([l, u, main]) =>
      '<a href="' + esc(u) + '" style="display:inline-block;margin:0 8px 8px 0;padding:11px 18px;border-radius:10px;font-weight:bold;text-decoration:none;' +
      (main ? "background:#410207;color:#f5ede0;border:1px solid #410207" : "background:#ffffff;color:#410207;border:1px solid #410207") + '">' + esc(l) + "</a>").join("") + "</p>" : "") +
    '<p style="margin:18px;font-size:12px;color:#5f4c3d">' + esc(foot) + "</p></div>";
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
  const claim = await sb.from("tasting_mail").select("*").eq("id", id).maybeSingle();
  if (claim.error || !claim.data) return json({ error: "no such mail" }, 404);
  const m = claim.data;
  if (!(m.status === "queued" || (m.status === "failed" && m.tries < 3))) return json({ ok: true, skipped: m.status });
  const upd = await sb.from("tasting_mail").update({ status: "sending", tries: m.tries + 1 }).eq("id", id).eq("status", m.status).select("id");
  if (upd.error || !upd.data || !upd.data.length) return json({ ok: true, skipped: "taken" });
  const fail = async (error: string, status: number) => {
    await sb.from("tasting_mail").update({ status: "failed", error: error.slice(0, 500) }).eq("id", id);
    console.log("tasting-notify", id, m.kind, "FAILED " + error);
    return json({ error }, status);
  };

  const rq = await sb.from("tasting_requests").select("*").eq("id", m.request_id).maybeSingle();
  if (rq.error || !rq.data) return await fail("request not found", 404);
  const r = rq.data;
  const rc = await sb.from("recipes").select("id,name").in("id", r.recipe_ids);
  if (rc.error) return await fail("recipes: " + rc.error.message, 502);
  const byId: Record<string, string> = {};
  (rc.data || []).forEach((x: any) => { byId[x.id] = x.name; });
  const dishes = (r.recipe_ids as string[]).map((x) => byId[x]).filter(Boolean);
  if (!dishes.length) return await fail("no dishes left on this request", 409);
  if (!RESEND_API_KEY) return await fail("no RESEND_API_KEY", 500);

  const mail = build(m.kind, r, dishes);
  if (m.is_test) mail.subject = "[TEST] " + mail.subject;
  const payload: Record<string, unknown> = { from: FROM, to: m.to_list, subject: mail.subject, text: mail.text, html: mail.html };
  if (m.kind === "invite" || m.kind === "cancel") {
    const cancel = m.kind === "cancel";
    payload.attachments = [{
      filename: cancel ? "tasting-cancelled.ics" : "tasting.ics",
      content: b64(ics(r, dishes, m.to_list[0], cancel)),
      content_type: "text/calendar; charset=utf-8; method=" + (cancel ? "CANCEL" : "REQUEST"),
    }];
  }
  let resendId: string | null = null, err = "";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await res.json().catch(() => null);
    if (res.ok && d && d.id) resendId = d.id; else err = (d && (d.message || d.error)) ? String(d.message || d.error) : "HTTP " + res.status;
  } catch (e) { err = String((e as Error).message || e); }
  if (!resendId) return await fail(err, 502);
  await sb.from("tasting_mail").update({ status: "sent", resend_id: resendId, sent_at: new Date().toISOString(), error: null }).eq("id", id);
  console.log("tasting-notify", id, m.kind, "sent " + resendId);
  return json({ ok: true, id: resendId });
});
