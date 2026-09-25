// ════════════════════════════════════════════════════════════════════════
// send-roster — Supabase Edge Function
//
// ⚠️ THIS FUNCTION LIVES IN THE **KITCHEN** PROJECT, NOT THE FOH ONE.
//    Deploy: supabase functions deploy send-roster --project-ref zrpglswalgjbtghudmhu
//    Both apps call it: the FOH app passes source:'FOH', the Kitchen app passes
//    nothing. One function, two brandings — that is deliberate, so the roster
//    email looks and reads the same whichever schedule it came from.
//
// This copy exists so the source is in the repo. Before this, it lived ONLY in
// the Supabase dashboard, which is why nobody could see who the roster was
// actually going to without opening an email. Edit here, then deploy.
//
// WHO IT SENDS TO
// ---------------
// hr@robertos.ae is always the addressee. The email opens "Dear HR Team" and
// that mailbox is the reason the email exists, so it is fixed here and cannot
// be removed by accident from a settings screen.
//
// Everyone ELSE is copied in, and that list is NOT in this file — it is read at
// send time from app_users.notify in the FOH project, managed from the app's
// Admin → Emails screen. Add or drop someone there and the very next send
// obeys it; no redeploy. Keys: 'roster_foh' / 'roster_kitchen'.
//
// WHAT CHANGED IN THIS ROSTER
// ---------------------------
// `note` — free text the manager types on the Send-to-HR screen. It is printed
// under the greeting so HR reads the change instead of comparing two sheets
// person by person. Optional; when it is empty the email is exactly as before.
// Escaped, never trusted as HTML. `sentBy` signs it.
//
// If that lookup fails or returns nobody, we fall back to the exact list that
// was hardcoded here before this change. A roster that quietly reaches nobody
// is far worse than one that reaches a slightly stale list.
//
// SECRETS
//   RESEND_API_KEY   — the Resend key. REQUIRED. The old version of this
//                      function carried the key inline in the source; that key
//                      is considered exposed and must be rotated. Nothing is
//                      sent if this secret is missing, and the caller is told
//                      why, rather than failing silently.
//   FOH_SERVICE_KEY  — SECRET key of the FOH project (paoaivwtkzujmrgrfjuq).
//                      Without it the recipient lookup is skipped and the
//                      fallback list is used — the email still goes out.
//                      ⚠️ IT MUST BE THE SECRET KEY, NOT THE PUBLISHABLE/ANON ONE.
//                      From 1–14 Aug 2026 it held the anon key. app_users is
//                      own-row-only under RLS, so an anon read does not fail —
//                      it returns HTTP 200 with an empty array. The old code
//                      only guarded `!r.ok`, so that empty array became "nobody
//                      is ticked", which became the fallback list, and every
//                      roster for two weeks went to a pre-Ouafaa list while the
//                      Admin → Emails screen showed the right people. Nothing
//                      anywhere said a word. Hence `whyFallback` below: this
//                      function now reports WHICH failure it hit, the sending
//                      screen shows it instead of a green tick, and a test send
//                      exercises the same lookup so it can be caught before a
//                      real roster goes out.
// ════════════════════════════════════════════════════════════════════════
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// The FOH project holds app_users. Its URL is public (it is in the FOH app's
// own source); only the service key is a secret.
const FOH_URL = "https://paoaivwtkzujmrgrfjuq.supabase.co";

const RESEND_KEY = Deno.env.get("RESEND_API_KEY");

// The addressee. Never read from the database, never removable from a screen.
const HR_TO = ["hr@robertos.ae"];

// Exactly who was copied before recipients moved into app_users. Used only when
// the lookup gives us nothing.
const FALLBACK_CC: Record<string, string[]> = {
  roster_foh:     ["lmadlag@robertos.ae", "dsaxena@robertos.ae", "fguarracino@robertos.ae",
                   "jthomas@robertos.ae"],
  roster_kitchen: ["lmadlag@robertos.ae", "dsaxena@robertos.ae", "fguarracino@robertos.ae",
                   "dvalla@robertos.ae", "astellacci@robertos.ae"],
};

// Anything a person typed goes through this before it reaches HR's inbox.
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Reads everyone ticked for this roster on the Admin → Emails screen.
// Deliberately total: any failure falls back to the built-in list rather than
// throwing, because "we could not read the list" must never become "we sent it
// to nobody". But it now says WHICH failure it hit, because the two weeks this
// silently used the fallback are two weeks nobody could have noticed otherwise.
//
// `why` is null when the list was read. Otherwise:
//   no-key      the FOH_SERVICE_KEY secret is not set on this project
//   http-<n>    the read was rejected — a wrong or expired key gives 401
//   not-a-list  the response was not an array (an error object usually is not)
//   empty       the read SUCCEEDED and returned nobody. Either every person was
//               un-ticked on the Admin screen, or the key is a publishable one
//               and RLS returned an empty set instead of an error. Those look
//               identical from here, which is exactly how the Aug 2026 bug hid,
//               so this one is reported rather than treated as a plain result.
//   threw       the request itself failed (network, DNS, timeout)
type CcLookup = { list: string[] | null; why: string | null };

async function ccFromAppUsers(notifyKey: string): Promise<CcLookup> {
  const svc = Deno.env.get("FOH_SERVICE_KEY");
  if (!svc) return { list: null, why: "no-key" };
  try {
    const url = FOH_URL + "/rest/v1/app_users"
      + "?select=email&notify=cs." + encodeURIComponent("{" + notifyKey + "}");
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

// Said in words a manager can act on, for the sending screen and the test email.
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
    // ── check:true — answer "who would this actually copy?" and send NOTHING ──
    //
    // The reason this exists: the Admin → Emails screen shows what is in the
    // database, which is not the same claim as "this is who the email reaches".
    // For two weeks in Aug 2026 those two things disagreed and the screen looked
    // perfectly healthy. A test SEND could not have caught it either — it skipped
    // the lookup, and it is localhost-only, so no manager could run one anyway.
    //
    // So the check runs the exact lookup a real send runs, through the same key
    // and the same URL, and reports the result without touching Resend. It needs
    // no attachment and no RESEND_API_KEY: nothing is emailed, so the person who
    // owns the list can press it as often as they like.
    const checkBody = await req.clone().json().catch(() => ({}));
    if (checkBody && checkBody.check === true) {
      const key = checkBody.source === "FOH" ? "roster_foh" : "roster_kitchen";
      const look = await ccFromAppUsers(key);
      const fell = look.list === null;
      return new Response(JSON.stringify({
        checked: true,
        sent: false,
        to: HR_TO,
        recipients: (look.list || FALLBACK_CC[key] || []).filter((e) => !HR_TO.includes(e)),
        usedFallback: fell,
        fallbackReason: fell ? fallbackReason(look.why) : null,
        fallbackWhy: look.why,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // Said plainly, and BEFORE building anything: a missing key must read as
    // "not sent, here is why", never as a silent success on the schedule screen.
    if (!RESEND_KEY) {
      return new Response(JSON.stringify({ error: "RESEND_API_KEY secret is not set on this project — nothing was sent." }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const body = await req.json();
    const { xlsxBase64, fileName, weekStr, source, update, sentBy } = body;

    // The line the manager typed on the Send-to-HR screen: what changed in this
    // roster, in their own words.
    //
    // Antonio asked for this on 10 Aug 2026. He had already sent the week to HR
    // when Gaejindra asked to swap his day off with Joker, so the roster changed
    // by two cells — and the email had no way to say so. The only options were to
    // send an identical-looking attachment and leave HR to compare every person
    // line by line, or to tell Leverina on WhatsApp instead, which is what he did.
    //
    // Typed text, never markup: escaped here, so a stray < or & from a phone
    // keyboard cannot break the email or inject anything into HR's inbox.
    const note   = typeof body.note === "string" ? body.note.trim().slice(0, 2000) : "";
    const noteBy = typeof sentBy === "string" ? sentBy.trim().slice(0, 80) : "";

    // Brand + recipients depend on which app sent it (FOH app passes source:'FOH')
    const isFOH = source === "FOH";
    const fromName  = isFOH ? "Roberto's FOH" : "Roberto's Kitchen";
    const subjLabel = isFOH ? "FOH Roster" : "Kitchen Roster";
    const bodyLabel = isFOH ? "Front of House" : "kitchen";
    const signOff   = isFOH ? "Front of House Management" : "Kitchen Management";
    const notifyKey = isFOH ? "roster_foh" : "roster_kitchen";

    // update:true means this week was already sent — tell HR to discard the old one.
    const isUpdate = update === true;

    // A test send goes to ONE address and nobody else — not HR, not the Cc list.
    // Without this the only way to check the roster email was to send a real one
    // to HR, which is not a test, it is a mistake with a nice name. Anything
    // that is not a single sane address is ignored rather than half-honoured.
    const testTo = typeof body.testTo === "string" && body.testTo.includes("@")
      ? body.testTo.trim().toLowerCase() : null;

    const to = testTo ? [testTo] : HR_TO;

    // The lookup runs on a test send TOO, and that is the whole point of the
    // change. It used to be skipped, which made the test send blind to the one
    // thing most worth testing: a test could pass perfectly while every real
    // roster went to the wrong people. A test still COPIES nobody — it just
    // reads the list and prints it, so the tester sees the real recipients.
    const lookup = await ccFromAppUsers(notifyKey);
    const usedFallback = lookup.list === null;
    // Who a real send would copy — computed the same way for a test and a send.
    // Never copy the addressee back to itself — it reads as a mistake to HR.
    const wouldCc = (lookup.list || FALLBACK_CC[notifyKey] || [])
      .filter((e) => !HR_TO.includes(e));
    const cc = testTo ? [] : wouldCc;
    const replyTo = isFOH ? "jthomas@robertos.ae" : "dvalla@robertos.ae";   // Jins since 24 Sep 2026 (Manuel left)

    // A test must be unmistakable in the inbox. If it ever did reach HR by
    // accident, the subject line alone tells them to ignore it.
    const subject = (testTo ? "TEST — " : "") + (isUpdate ? "UPDATED — " : "") + subjLabel + ": " + weekStr;

    const banner = isUpdate
      ? "<p style=\"background:#fbeaea;border-left:4px solid #b91c1c;padding:10px 14px;color:#7f1d1d;font-weight:bold;border-radius:4px\">⚠️ UPDATED ROSTER — this replaces the version sent earlier for this week. Please discard the previous roster and use this latest one.</p>"
      : "";

    const intro = isUpdate
      ? "<p>Dear HR Team,</p><p>Please find attached the <strong>updated</strong> " + bodyLabel + " roster for the week of <strong>" + weekStr + "</strong>. It <strong>replaces</strong> any earlier version sent for this week.</p>"
      : "<p>Dear HR Team,</p><p>Please find attached the <strong>" + bodyLabel + "</strong> roster for the week of <strong>" + weekStr + "</strong>.</p>";

    // Sits directly under the greeting — above the attachment sentence — because
    // it is the reason HR would otherwise have to re-read the whole sheet.
    const noteHtml = note
      ? '<div style="background:#F5F0E8;border-left:4px solid #6B1F2A;padding:12px 15px;border-radius:4px;margin:16px 0">'
        + '<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6B1F2A;font-weight:bold;margin-bottom:7px">What changed in this roster</div>'
        + '<div style="color:#3D0F15;line-height:1.5">' + esc(note).replace(/\n/g, "<br>") + "</div>"
        + (noteBy ? '<div style="font-size:12px;color:#7a6b55;margin-top:9px;font-style:italic">&mdash; ' + esc(noteBy) + "</div>" : "")
        + "</div>"
      : "";

    // Only on a test, and only to the one person who asked for it: exactly who a
    // real send would copy, by name, read live from the same lookup the real
    // send uses. A test that does not show this cannot catch a wrong list —
    // which is what happened for two weeks in Aug 2026.
    const testHtml = testTo
      ? '<div style="background:#F5F0E8;border:1px solid #6B1F2A;padding:12px 15px;border-radius:4px;margin:16px 0">'
        + '<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6B1F2A;font-weight:bold;margin-bottom:7px">This is a test — nobody else received it</div>'
        + '<div style="color:#3D0F15;line-height:1.6">A real send would go to <strong>' + esc(HR_TO.join(", ")) + '</strong>'
        + (wouldCc.length
            ? ' and copy <strong>' + esc(wouldCc.length + (wouldCc.length === 1 ? " person" : " people")) + '</strong>:<br>' + esc(wouldCc.join(", "))
            : ' and copy <strong>nobody</strong>')
        + '.</div>'
        + (usedFallback
            ? '<div style="color:#7f1d1d;font-weight:bold;margin-top:10px;line-height:1.5">⚠️ Those names did NOT come from the Admin → Emails screen — '
              + esc(fallbackReason(lookup.why)) + ', so this is the built-in list. Whoever you tick or untick on that screen is being ignored. Please report this.</div>'
            : '<div style="color:#4a6b4f;margin-top:10px">✓ Read live from the Admin → Emails screen.</div>')
        + "</div>"
      : "";

    const emailPayload = {
      from: fromName + " <roster@kitchenteam.robertos.ae>",
      to: to,
      cc: cc,
      reply_to: replyTo,
      subject: subject,
      html: banner + intro + testHtml + noteHtml + "<p>The Excel file contains shift times, total hours and days worked per person.</p><p>Best regards,<br>" + signOff + "<br>Roberto's DIFC</p>",
      attachments: [{ filename: fileName, content: xlsxBase64 }],
    };

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + RESEND_KEY,
      },
      body: JSON.stringify(emailPayload),
    });

    const data = await res.json();

    // The caller shows a green tick on 2xx, so tell it who was actually copied.
    // usedFallback:true is the one thing worth noticing — it means the Admin
    // list could not be read and the built-in list was used instead. It is now
    // sent with the REASON and the actual names, because a boolean nobody
    // displays is the same as no signal at all: this flag was already here
    // during the two weeks the roster went to the wrong list.
    // `noted` is how the sending screen can say "your note went with it" without
    // guessing — if the note were ever dropped on the way here, the tick would say so.
    return new Response(JSON.stringify({
      ...data,
      cc: cc.length,
      usedFallback,
      fallbackReason: usedFallback ? fallbackReason(lookup.why) : null,
      fallbackWhy: lookup.why,
      recipients: wouldCc,
      test: !!testTo,
      noted: note.length,
    }), {
      status: res.status,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
});
