// supabase/functions/interview-email/index.ts
// Interviews module — the three candidate emails: Reject, Shortlist, Send to HR.
//
// CV data is confidential, so the browser names NOTHING but the candidate:
//   - the HR list, the shortlist CC and every Reply-To live HERE, not in the client;
//   - the CV is read from interview_cvs by this function, and only a CV that
//     belongs to that candidate is accepted;
//   - the interviewers' passcode is checked against interview_settings first.
//
// mode "preview" returns exactly what "send" would send — the Confirm screen
// shows this answer, never a copy of the wording kept in the browser.
// mode "send" refuses a missing/invalid name, email or position, refuses the HR
// email without the Excel hiring form, and refuses to repeat an action already
// sent to this candidate unless the chef has ticked "send again".
// Every attempt, sent or failed, is one row in interview_actions.
//
// A candidate in an event starting "zz-test" never reaches a real person: every
// To / CC / Reply-To becomes TEST_TO and the subject says [TEST].
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";

const TEAM = "Roberto's Dubai Culinary Team";
const FROM_NOREPLY = `Roberto's Dubai <no-reply@kitchenteam.robertos.ae>`;   // no mailbox, no MX: a reply reaches nobody
const FROM_TEAM = `${TEAM} <culinary@kitchenteam.robertos.ae>`;
const SHORTLIST_CC = ["dvalla@robertos.ae", "lmadlag@robertos.ae"];
const SHORTLIST_REPLY = ["dvalla@robertos.ae", "lmadlag@robertos.ae"];
const HR_TO = ["lmadlag@robertos.ae", "slhanzom@robertos.ae", "dsaxena@skelmore.com"];
const HR_REPLY = ["dvalla@robertos.ae", "lmadlag@robertos.ae"];   // Francesco, 17 Sep 2026
const TEST_TO = ["fguarracino@robertos.ae"];
// Interview Form — slot reserved (17 Sep 2026). When the form exists, attach it
// in buildHr() as the third file and flip this on; the preview already lists it.
const INTERVIEW_FORM_ENABLED = false;

const MAX_FORM_BYTES = 10 * 1024 * 1024;
const ACTIONS = ["reject", "shortlist", "hr"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// ── the three checks every button shares ──
function checkName(n: string): string {
  if (!n) return "The candidate's name is missing.";
  if (/unnamed candidate/i.test(n)) return "The candidate's name is missing.";
  if (n.length > 120) return "The name is too long.";
  if (/[@\d<>]|https?:/i.test(n)) return "The name does not look like a person's name.";
  if ((n.match(/\p{L}/gu) || []).length < 2) return "The name does not look like a person's name.";
  return "";
}
function checkEmail(e: string): string {
  if (!e) return "The candidate's email address is missing.";
  if (e.length > 200 || /\s/.test(e)) return "The email address does not look right.";
  if (!/^[A-Za-z0-9._+\-]+@[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/.test(e)) {
    return "The email address does not look right.";
  }
  if (/\.\./.test(e) || /^\./.test(e) || /\.@/.test(e)) return "The email address does not look right.";
  return "";
}
function checkPosition(p: string): string {
  if (!p) return "The position is missing.";
  if (p.length > 120) return "The position is too long.";
  if ((p.match(/\p{L}/gu) || []).length < 2 || /[<>]|https?:/i.test(p)) return "The position does not look right.";
  return "";
}
// typos worth a second look — a warning, never a block
function emailHints(e: string): string[] {
  const d = (e.split("@")[1] || "").toLowerCase();
  const out: string[] = [];
  const typo: Record<string, string> = {
    "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gamil.com": "gmail.com", "gmail.con": "gmail.com",
    "gmail.co": "gmail.com", "gmal.com": "gmail.com", "gnail.com": "gmail.com", "gmail.cm": "gmail.com",
    "hotmial.com": "hotmail.com", "hotmai.com": "hotmail.com", "hotmail.con": "hotmail.com",
    "yaho.com": "yahoo.com", "yahooo.com": "yahoo.com", "yahoo.con": "yahoo.com",
    "outlok.com": "outlook.com", "outlook.con": "outlook.com", "iclod.com": "icloud.com",
  };
  if (typo[d]) out.push(`The address ends in "${d}" — did the CV mean "${typo[d]}"?`);
  return out;
}

function dubaiDate(): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "long", year: "numeric" }).format(new Date());
}
function htmlOf(text: string): string {
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222">' +
    text.split(/\n{2,}/).map((p) => "<p>" + esc(p).replace(/\n/g, "<br>") + "</p>").join("") + "</div>";
}

type Mail = { from: string; to: string[]; cc: string[]; reply_to: string[]; subject: string; text: string };

function buildMail(action: string, name: string, email: string, position: string): Mail {
  if (action === "reject") {
    return {
      from: FROM_NOREPLY, to: [email], cc: [], reply_to: [],
      subject: `Your application – ${position} at Roberto's Dubai`,
      text: `Dear ${name},\n\nThank you for your interest in the ${position} role at Roberto's Dubai and for the time you took to apply.\n\n` +
        `After careful review, we have decided not to move forward with your application at this time. We will keep your details on file and may contact you should a suitable opportunity arise.\n\n` +
        `We wish you every success in your career.\n\nKind regards,\n${TEAM}\n\nThis is an automated message; please do not reply.`,
    };
  }
  if (action === "shortlist") {
    return {
      from: FROM_TEAM, to: [email], cc: SHORTLIST_CC.slice(), reply_to: SHORTLIST_REPLY.slice(),
      subject: `You've been shortlisted – ${position} at Roberto's Dubai`,
      text: `Dear ${name},\n\nThank you for applying for the ${position} role at Roberto's Dubai. We are pleased to let you know that you have been shortlisted.\n\n` +
        `We will be in touch soon regarding the next step.\n\nKind regards,\n${TEAM}`,
    };
  }
  return {
    from: FROM_TEAM, to: HR_TO.slice(), cc: [], reply_to: HR_REPLY.slice(),
    subject: `Hiring Request – ${name} – ${position}`,
    text: `Dear HR Team,\n\nPlease find attached the CV and hiring form for the candidate below:\n\n` +
      `Name: ${name}\nEmail: ${email}\nPosition: ${position}\nDate: ${dubaiDate()}\n\nKind regards,\n${TEAM}`,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "Bad request" }, 400); }

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // passcode first — nothing about a candidate is confirmed or denied without it
  const code = String(b.code ?? "");
  const st = await sb.from("interview_settings").select("passcode").eq("id", 1).maybeSingle();
  if (st.error) return json({ error: "Could not check the passcode. Try again." }, 500);
  if (!code || !st.data || st.data.passcode !== code) return json({ error: "wrong passcode" }, 401);

  const mode = String(b.mode ?? "");

  // ── delivery check: what happened to the emails already sent ──
  if (mode === "status") {
    const event = String(b.event ?? "");
    const rows = await sb.from("interview_actions").select("id,resend_id,delivery")
      .eq("event", event).eq("status", "sent").not("resend_id", "is", null)
      .or("delivery.is.null,delivery.in.(sent,queued,scheduled,delivery_delayed)").limit(25);
    if (rows.error) return json({ error: rows.error.message }, 500);
    let checked = 0, readable = true;
    for (const r of rows.data || []) {
      const g = await fetch("https://api.resend.com/emails/" + r.resend_id, { headers: { Authorization: `Bearer ${RESEND_API_KEY}` } });
      if (g.status === 401 || g.status === 403) { readable = false; break; }   // a send-only key cannot read
      if (!g.ok) continue;
      const d = await g.json();
      if (d && d.last_event) {
        await sb.from("interview_actions").update({ delivery: d.last_event, delivery_checked_at: new Date().toISOString() }).eq("id", r.id);
        checked++;
      }
    }
    return json({ ok: true, checked, readable });
  }

  if (mode !== "preview" && mode !== "send") return json({ error: "Unknown mode" }, 400);
  const action = String(b.action ?? "");
  if (!ACTIONS.includes(action)) return json({ error: "Unknown action" }, 400);

  const cand = await sb.from("interview_candidates").select("id,event,name").eq("id", String(b.candidate_id ?? "")).maybeSingle();
  if (cand.error || !cand.data) return json({ error: "That candidate is no longer on the board." }, 404);
  const isTest = /^zz-test/i.test(cand.data.event || "");

  const name = clean(b.name), email = clean(b.email).replace(/^mailto:/i, ""), position = clean(b.position);
  const problems = [checkName(name), checkEmail(email), checkPosition(position)].filter(Boolean);

  // ── attachments (HR only) ──
  const cvIds: string[] = action === "hr" && Array.isArray(b.cv_ids) ? b.cv_ids.map(String).slice(0, 5) : [];
  let cvs: { id: string; filename: string; size_bytes: number }[] = [];
  const form = action === "hr" && b.hiring_form && typeof b.hiring_form === "object" ? b.hiring_form : null;
  const formName = form ? clean(form.filename) : "";
  let formBytes = 0;
  if (action === "hr") {
    if (!cvIds.length) problems.push("No CV is attached. Upload the candidate's CV first.");
    else {
      const got = await sb.from("interview_cvs").select("id,filename,size_bytes,candidate_id").in("id", cvIds);
      if (got.error) return json({ error: got.error.message }, 500);
      cvs = (got.data || []).filter((c) => c.candidate_id === cand.data!.id);
      if (cvs.length !== cvIds.length) problems.push("A chosen CV does not belong to this candidate. Close this window and try again.");
    }
    if (!form || !formName) problems.push("The Excel hiring form has not been uploaded. Add it before sending to HR.");
    else if (!/\.(xlsx|xlsm|xls)$/i.test(formName)) problems.push("The hiring form must be an Excel file (.xlsx or .xls).");
    else {
      const b64 = String(form.b64 ?? "");
      formBytes = Math.floor(b64.length * 3 / 4);
      if (mode === "send" && formBytes < 200) problems.push("The Excel hiring form is empty. Upload it again.");
      if (formBytes > MAX_FORM_BYTES) problems.push("The hiring form is over 10 MB.");
    }
  }

  // ── has this been done before? ──
  // same candidate row, or the same address under another row (a CV added twice)
  const PREV = "id,action,candidate_name,candidate_email,position,created_at,is_test,delivery";
  const byId = await sb.from("interview_actions").select(PREV).eq("status", "sent").eq("event", cand.data.event).eq("candidate_id", cand.data.id);
  if (byId.error) return json({ error: byId.error.message }, 500);
  let previous = byId.data || [];
  if (!checkEmail(email)) {
    const byMail = await sb.from("interview_actions").select(PREV).eq("status", "sent").eq("event", cand.data.event).ilike("candidate_email", email);
    if (byMail.error) return json({ error: byMail.error.message }, 500);
    const seen = new Set(previous.map((p) => p.id));
    previous = previous.concat((byMail.data || []).filter((p) => !seen.has(p.id)));
  }
  previous.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const repeats = previous.filter((p) => p.action === action);

  const mail = buildMail(action, name, email, position);
  const real = { to: mail.to.slice(), cc: mail.cc.slice(), reply_to: mail.reply_to.slice() };
  if (isTest) {
    mail.to = TEST_TO.slice(); mail.cc = []; mail.reply_to = mail.reply_to.length ? TEST_TO.slice() : [];
    mail.subject = "[TEST] " + mail.subject;
  }
  const attachNames = action === "hr" ? cvs.map((c) => c.filename).concat(formName ? [formName] : []) : [];

  const view = {
    action, is_test: isTest,
    from: mail.from, to: mail.to, cc: mail.cc, reply_to: mail.reply_to,
    real_recipients: isTest ? real : null,
    subject: mail.subject, body: mail.text,
    attachments: action === "hr"
      ? cvs.map((c) => ({ label: "Candidate's CV", filename: c.filename, size_bytes: c.size_bytes }))
          .concat(formName ? [{ label: "Hiring Form", filename: formName, size_bytes: formBytes }] : [])
      : [],
    interview_form_slot: action === "hr" ? { enabled: INTERVIEW_FORM_ENABLED, note: "Interview Form — to be added later. Not attached." } : null,
    problems, hints: problems.length ? [] : emailHints(email),
    previous, repeats: repeats.length,
  };

  if (mode === "preview") return json({ ok: true, preview: view });

  // ── send ──
  if (problems.length) return json({ error: problems[0], problems }, 422);
  if (repeats.length && b.confirm_repeat !== true) {
    return json({ error: "This has already been sent to this candidate.", repeats: repeats.length, previous }, 409);
  }
  if (!RESEND_API_KEY) return json({ error: "The email service is not set up (no key)." }, 500);

  const attachments: { filename: string; content: string }[] = [];
  if (action === "hr") {
    for (const c of cvs) {
      const g = await sb.rpc("interview_cv_get", { p_code: code, p_id: c.id });
      if (g.error || !g.data) return json({ error: "Could not read the CV " + c.filename + " — nothing was sent." }, 500);
      attachments.push({ filename: c.filename, content: String(g.data) });
    }
    attachments.push({ filename: formName, content: String(form.b64).replace(/\s+/g, "") });
  }

  const payload: Record<string, unknown> = { from: mail.from, to: mail.to, subject: mail.subject, text: mail.text, html: htmlOf(mail.text) };
  if (mail.cc.length) payload.cc = mail.cc;
  if (mail.reply_to.length) payload.reply_to = mail.reply_to;
  if (attachments.length) payload.attachments = attachments;

  let resendId: string | null = null, err = "";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok && d && d.id) resendId = d.id;
    else err = (d && (d.message || d.error)) ? String(d.message || d.error) : "The email service answered " + res.status;
  } catch (e) { err = "Could not reach the email service (" + String(e) + ")"; }

  const log = await sb.from("interview_actions").insert({
    candidate_id: cand.data.id, event: cand.data.event, action,
    candidate_name: name, candidate_email: email, position,
    status: resendId ? "sent" : "failed",
    sent_to: mail.to, sent_cc: mail.cc, reply_to: mail.reply_to,
    subject: mail.subject, attachments: attachNames,
    resend_id: resendId, error: err || null, is_test: isTest,
  }).select("*").maybeSingle();
  console.log("interview-email", action, resendId ? "sent " + resendId : "FAILED " + err, log.error ? "LOG FAILED " + log.error.message : "logged");

  if (!resendId) return json({ error: err, logged: !log.error }, 502);
  return json({ ok: true, id: resendId, logged: !log.error, row: log.data || null, log_error: log.error ? log.error.message : null });
});
