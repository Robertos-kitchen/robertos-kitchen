// supabase/functions/interview-email/index.ts
// Interviews module — the candidate emails: Reject, Shortlist, Keep for the future, Send to HR.
//
// CV data is confidential, so the browser names NOTHING but the candidate:
//   - the HR list, the shortlist CC and every Reply-To come from interview_settings
//     (editable in the app, our own domains only — the database refuses anything
//     else); the lists below are only the fallback for an empty row;
//   - the CV is read from interview_cvs by this function, and only a CV that
//     belongs to that candidate is accepted;
//   - the interviewers' passcode is checked against interview_settings first.
//
// mode "preview" returns exactly what "send" would send — the Confirm screen
// shows this answer, never a copy of the wording kept in the browser.
// mode "send" refuses a missing/invalid name, email or position, refuses the HR
// email unless the Candidate Evaluation Form has been filled in the app — every
// rating, the decision, the interviewers — and refuses to repeat an action already
// sent to this candidate unless the chef has ticked "send again".
// The form HR receives is the restaurant's own Word form, filled here from those
// answers (template.ts), so it cannot arrive empty. Preview hands the same file back
// to the chef to open before anything is sent.
// Every attempt, sent or failed, is one row in interview_actions.
//
// A candidate in an event starting "zz-test" never reaches a real person: every
// To / CC / Reply-To becomes TEST_TO and the subject says [TEST].
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import JSZip from "npm:jszip@3.10.1";
import { TEMPLATE_B64 } from "./template.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";

const TEAM = "Roberto's Dubai Culinary Team";
const FROM_NOREPLY = `Roberto's Dubai <no-reply@kitchenteam.robertos.ae>`;   // no mailbox, no MX: a reply reaches nobody
const FROM_TEAM = `${TEAM} <culinary@kitchenteam.robertos.ae>`;
const FALLBACK = {
  shortlist_cc: ["dvalla@robertos.ae", "lmadlag@robertos.ae"],
  shortlist_reply_to: ["dvalla@robertos.ae", "lmadlag@robertos.ae"],
  hr_to: ["lmadlag@robertos.ae", "slhanzom@robertos.ae", "dsaxena@skelmore.com"],
  hr_cc: [] as string[],   // copy list on the hiring request (Francesco, 18 Sep 2026) — Set-up decides
  hr_reply_to: ["dvalla@robertos.ae", "lmadlag@robertos.ae"],   // Francesco, 17 Sep 2026
};
type Lists = typeof FALLBACK;
// the same rule the database enforces — checked again here before a CV leaves
const OWN_ADDR = /^[a-z0-9._+\-]+@(robertos\.ae|skelmore\.com)$/i;
function listsFrom(row: any): Lists {
  const out: any = {};
  for (const k of Object.keys(FALLBACK) as (keyof Lists)[]) {
    const v = Array.isArray(row?.[k]) ? row[k].map((x: unknown) => String(x).trim().toLowerCase()).filter((x: string) => OWN_ADDR.test(x)) : [];
    out[k] = v.length ? v : FALLBACK[k].slice();
  }
  return out as Lists;
}
const TEST_TO = ["fguarracino@robertos.ae"];
// Interview Form — slot reserved (17 Sep 2026). When the form exists, attach it
// in buildHr() as the third file and flip this on; the preview already lists it.
const INTERVIEW_FORM_ENABLED = false;

// The hiring form is the "Candidate Evaluation Form" (Francesco, 17 Sep 2026). The chef
// fills it in the app; it is never uploaded, so it can never reach HR blank.
const CRITERIA: [string, string][] = [
  ["r1", "1. Job knowledge"], ["r2", "2. Qualification and experience"], ["r3", "3. Employment achievement"],
  ["r4", "4. Intelligence"], ["r5", "5. Persuasiveness"], ["r6", "6. Communication"], ["r7", "7. Interpersonal"],
  ["r8", "8. Teamwork"], ["r9", "9. Motivation and resilience"], ["r10", "10. Personality and character"],
  ["r11", "11. Management & leadership (management-level candidates only)"],
];
const RATING_WORD: Record<string, string> = { E: "Excellent", G: "Good", A: "Average", P: "Poor", na: "Not applicable" };
const DECISION_WORD: Record<string, string> = { hired: "Hired", hold: "On Hold" };

type Evaluation = { interviewers: string; decision: string; department: string; salary: string; ratings: Record<string, string>; overall: string; comments: string };

function readEvaluation(raw: any): { ev: Evaluation; problems: string[] } {
  const r = raw && typeof raw === "object" ? raw : {};
  const ratings: Record<string, string> = {};
  const src = r.ratings && typeof r.ratings === "object" ? r.ratings : {};
  for (const [k] of CRITERIA) ratings[k] = String(src[k] ?? "");
  const ev: Evaluation = {
    interviewers: clean(r.interviewers), decision: String(r.decision ?? ""), department: clean(r.department),
    salary: clean(r.salary), ratings, overall: String(r.overall ?? ""),
    comments: String(r.comments ?? "").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim(),
  };
  const problems: string[] = [];
  if ((ev.interviewers.match(/\p{L}/gu) || []).length < 2 || ev.interviewers.length > 160) problems.push("Evaluation form: type the name of the interviewer(s).");
  if (!DECISION_WORD[ev.decision]) problems.push("Evaluation form: choose Hired or On Hold.");
  if ((ev.department.match(/\p{L}/gu) || []).length < 2 || ev.department.length > 80) problems.push("Evaluation form: the department is missing.");
  const missing = CRITERIA.filter(([k]) => k === "r11" ? !/^(E|G|A|P|na)$/.test(ratings[k]) : !/^(E|G|A|P)$/.test(ratings[k]));
  if (missing.length) problems.push("Evaluation form: " + missing.length + (missing.length === 1 ? " rating is" : " ratings are") + " not filled — " + missing.map(([, t]) => t.split(" (")[0]).join("; ") + ".");
  if (!/^(E|G|A|P)$/.test(ev.overall)) problems.push("Evaluation form: the overall rating is not filled.");
  // the recommended salary: free text, read by HR exactly as typed (never turned into a number)
  if (ev.decision === "hired" && !/\d/.test(ev.salary)) problems.push("Evaluation form: type the recommended salary.");
  if (ev.salary.length > 120) problems.push("Evaluation form: the recommended salary is too long.");
  if (ev.comments.length > 600) problems.push("Evaluation form: the comments are over 600 characters — shorten them.");
  return { ev, problems };
}

// control characters are not legal in Word's XML; a line break is handled by the caller
const xmlEsc = (t: string) => t.replace(/\p{Cc}/gu, (c) => (c.charCodeAt(0) === 10 ? c : "")).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

async function fillForm(ev: Evaluation, name: string, position: string): Promise<string> {
  const zip = await JSZip.loadAsync(TEMPLATE_B64, { base64: true });
  const doc = zip.file("word/document.xml");
  if (!doc) throw new Error("form template is broken");
  const text: Record<string, string> = {
    NAME: name, INTERVIEWERS: ev.interviewers, POSITION: position, DEPARTMENT: ev.department, SALARY: ev.salary || "—",
    COMMENTS: ev.comments, SIGNATURE: ev.interviewers, DATE: dubaiDate(),
  };
  const tick: Record<string, string> = { D: ev.decision === "hired" ? "HIRED" : ev.decision === "hold" ? "HOLD" : "", RO: ev.overall };
  for (const [k] of CRITERIA) tick[k.toUpperCase()] = ev.ratings[k] === "na" ? "" : ev.ratings[k];
  let unknown = 0;
  const xml = (await doc.async("string")).replace(/\{\{([A-Z0-9_]+)\}\}/g, (_m: string, key: string) => {
    if (key in text) return xmlEsc(text[key]).replace(/\n/g, '</w:t><w:br/><w:t xml:space="preserve">');
    const cut = key.lastIndexOf("_"), row = key.slice(0, cut), col = key.slice(cut + 1);
    if (!(row in tick)) { unknown++; return ""; }
    return tick[row] === col ? "✓" : "";
  });
  if (unknown) throw new Error("the form template has a box this function does not know");
  zip.file("word/document.xml", xml);
  return await zip.generateAsync({ type: "base64", compression: "DEFLATE" });
}

const ACTIONS = ["reject", "shortlist", "future", "hr"];

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

function buildMail(action: string, name: string, email: string, position: string, L: Lists, salary = ""): Mail {
  if (action === "reject") {
    return {
      from: FROM_NOREPLY, to: [email], cc: [], reply_to: [],
      subject: `Your application – ${position} at Roberto's Dubai`,
      text: `Dear ${name},\n\nThank you for your interest in the ${position} role at Roberto's Dubai and for the time you took to apply.\n\n` +
        `After careful review, we have decided not to move forward with your application at this time. We will keep your details on file and may contact you should a suitable opportunity arise.\n\n` +
        `We wish you every success in your career.\n\nKind regards,\n${TEAM}\n\nThis is an automated message; please do not reply.`,
    };
  }
  // a good interview and tasting, but no opening today (Chef Andrea, Tell us 70e28770, 24 Sep 2026)
  if (action === "future") {
    return {
      from: FROM_TEAM, to: [email], cc: [], reply_to: L.shortlist_reply_to.slice(),
      subject: `Your interview – ${position} at Roberto's Dubai`,
      text: `Dear ${name},\n\nThank you for coming to Roberto's Dubai for your interview and food tasting for the ${position} role, and for the time and effort you put into it.\n\n` +
        `We are pleased to tell you that your interview and food tasting were positive. Although we do not have a position available for you at the moment, we will keep your details on file and we will contact you if a suitable opportunity arises in the future.\n\n` +
        `We wish you every success in the meantime.\n\nKind regards,\n${TEAM}`,
    };
  }
  if (action === "shortlist") {
    return {
      from: FROM_TEAM, to: [email], cc: L.shortlist_cc.slice(), reply_to: L.shortlist_reply_to.slice(),
      subject: `You've been shortlisted – ${position} at Roberto's Dubai`,
      text: `Dear ${name},\n\nThank you for applying for the ${position} role at Roberto's Dubai. We are pleased to let you know that you have been shortlisted.\n\n` +
        `We will be in touch soon regarding the next step.\n\nKind regards,\n${TEAM}`,
    };
  }
  return {
    from: FROM_TEAM, to: L.hr_to.slice(), cc: L.hr_cc.filter((a) => !L.hr_to.includes(a)), reply_to: L.hr_reply_to.slice(),
    subject: `Hiring Request – ${name} – ${position}`,
    text: `Dear HR Team,\n\nPlease find attached the CV and hiring form for the candidate below:\n\n` +
      `Name: ${name}\nEmail: ${email}\nPosition: ${position}\n${salary ? `Recommended salary: ${salary}\n` : ""}Date: ${dubaiDate()}\n\nKind regards,\n${TEAM}`,
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
  const st = await sb.from("interview_settings").select("passcode,hr_to,hr_cc,shortlist_cc,shortlist_reply_to,hr_reply_to").eq("id", 1).maybeSingle();
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
  const sentBy = clean(b.sent_by).slice(0, 60);   // the name picked on unlock — a name, not a login
  const problems = [checkName(name), checkEmail(email), checkPosition(position)].filter(Boolean);

  // ── attachments (HR only) ──
  const cvIds: string[] = action === "hr" && Array.isArray(b.cv_ids) ? b.cv_ids.map(String).slice(0, 5) : [];
  let cvs: { id: string; filename: string; size_bytes: number }[] = [];
  let evaluation: Evaluation | null = null;
  let formName = "", formB64 = "", formBytes = 0;
  if (action === "hr") {
    if (!cvIds.length) problems.push("No CV is attached. Upload the candidate's CV first.");
    else {
      const got = await sb.from("interview_cvs").select("id,filename,size_bytes,candidate_id").in("id", cvIds);
      if (got.error) return json({ error: got.error.message }, 500);
      cvs = (got.data || []).filter((c) => c.candidate_id === cand.data!.id);
      if (cvs.length !== cvIds.length) problems.push("A chosen CV does not belong to this candidate. Close this window and try again.");
    }
    const got = readEvaluation(b.evaluation);
    evaluation = got.ev;
    problems.push(...got.problems);
    if (!problems.length) {
      // only a complete form is ever built — there is no half-filled one to send
      try {
        formB64 = await fillForm(evaluation, name, position);
        formBytes = Math.floor(formB64.length * 3 / 4);
        formName = "Candidate Evaluation Form - " + name.replace(/[^\p{L}\p{N} .'-]/gu, "").trim().slice(0, 80) + ".docx";
      } catch (e) { return json({ error: "Could not build the evaluation form (" + String((e as Error).message || e) + ") — nothing was sent." }, 500); }
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

  const lists = listsFrom(st.data);
  const mail = buildMail(action, name, email, position, lists, evaluation?.salary || "");
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
          .concat(formName ? [{ label: "Candidate Evaluation Form — filled", filename: formName, size_bytes: formBytes }] : [])
      : [],
    interview_form_slot: action === "hr" ? { enabled: INTERVIEW_FORM_ENABLED, note: "Interview Form — to be added later. Not attached." } : null,
    // the filled form itself, for the chef to open before sending, and the same answers in words
    form_file: formB64 ? { filename: formName, b64: formB64 } : null,
    form_answers: evaluation && formB64 ? [
      ["Interviewer(s)", evaluation.interviewers], ["Decision", DECISION_WORD[evaluation.decision]], ["Department", evaluation.department],
      ["Recommended salary", evaluation.salary || "—"],
      ...CRITERIA.map(([k, t]) => [t.split(" (")[0], RATING_WORD[evaluation!.ratings[k]]]),
      ["Overall rating", RATING_WORD[evaluation.overall]], ["Comments", evaluation.comments || "—"],
    ] : null,
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
    attachments.push({ filename: formName, content: formB64 });
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
    resend_id: resendId, error: err || null, is_test: isTest, sent_by: sentBy,
  }).select("*").maybeSingle();
  console.log("interview-email", action, resendId ? "sent " + resendId : "FAILED " + err, log.error ? "LOG FAILED " + log.error.message : "logged");

  if (!resendId) return json({ error: err, logged: !log.error }, 502);
  return json({ ok: true, id: resendId, logged: !log.error, row: log.data || null, log_error: log.error ? log.error.message : null });
});
