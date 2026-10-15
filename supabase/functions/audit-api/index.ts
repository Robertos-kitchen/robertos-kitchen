// audit-api — Chef Bartolini Audit (14 Oct 2026, Francesco).
//
// The ONLY door to the audit_* tables (RLS on, no policies). Two kinds of link:
//   ?k=<enrico_token>  Enrico: scores, notes, photos, dishes, flags, final comment, "send to Francesco".
//   ?a=<admin_token>   Francesco: everything Enrico can do, plus edit the English, owner/date on the
//                      actions, send himself a test, and email the report to Amin.
//   ?n=<invite token>  A shared link (15 Oct 2026): anyone opening it types their name and gets
//                      their OWN audit (a new visit, stamped with the date and time), then carries on
//                      at ?k= like Enrico. The invite is itself an audit_visits row, status 'invite';
//                      its admin_token (?a=) shows Francesco the list of every audit started from it.
//                      A visit started from an invite carries source_note 'invite:<invite id>'.
// Enrico writes in Italian. Every note is translated to English by Claude with a chef's glossary
// (Italian kitchen terms kept, explained once). The Italian is never overwritten.
//
// POST JSON { k | a, action, ... }. The page calls audit-api?read=1 for "load" so the DEV
// write guard (dev-guard.js) lets the page open on the DEV site; anything else is a write.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const FROM = "Roberto's Kitchen <no-reply@kitchenteam.robertos.ae>";
const AMIN = { name: "Amin Kadrie", email: "akadrie@skelmore.com" };
const FRANCESCO = { name: "Francesco Guarracino", email: "fguarracino@robertos.ae" };
const BUCKET = "audit-photos";
const MENUS = ["217de140-5257-405f-be72-eaef8dde2c8b", "b7af4ba8-6ecc-4883-a16f-fdce9ba4a075"]; // A la carte 2026, Scala Bites Menu
const SCALA_MENU = "b7af4ba8-6ecc-4883-a16f-fdce9ba4a075";
const AREAS = ["arrivo", "cucina", "ristorante", "vino", "scala"];
const AREA_EN: Record<string, string> = { arrivo: "Arrival & welcome", cucina: "Kitchen", ristorante: "Restaurant", vino: "Wine", scala: "Scala", piatto: "Dish" };
const ENRICO = "Chef Enrico Bartolini";
const firstName = (n: string) => String(n || "").replace(/^Chef\s+/i, "").trim().split(/\s+/)[0] || "the auditor";
// Pages that may be linked to in mails (the report link goes to the page that asked).
const PAGES = ["https://guarracinofamily.github.io/robertos-kitchen/audit.html", "https://robertos-kitchen.github.io/robertos-kitchen/audit.html"];
const pageFor = (o: unknown) => PAGES.find((p) => p === o) || PAGES[0];
const newToken = () => crypto.randomUUID().replace(/-/g, "");
const dubaiNow = () => {
  const d = new Date(Date.now() + 4 * 3600 * 1000).toISOString();   // Dubai is UTC+4, no DST
  return { date: d.slice(0, 10), time: d.slice(11, 16) };
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const clean = (s: unknown, max = 4000) => (s == null ? null : String(s).slice(0, max).trim() || null);
const VERDICT_SCORE = ["ok", "fix", "urgent"];
const VERDICT_DISH = ["keep", "fix", "remove"];
const FLAG_AREAS = ["piatto", "cucina", "ristorante", "scala"];
const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

type Row = Record<string, any>;

// ── percentages: score / (5 × scored items), N/A and empty left out ──────────────────
function pcts(scores: Row[], catalog: Row[]) {
  const area: Record<string, string> = {}; for (const c of catalog) area[c.code] = c.area;
  const sum: Record<string, number> = {}, n: Record<string, number> = {};
  let S = 0, N = 0;
  for (const s of scores) {
    if (s.na || !s.score) continue;
    const a = area[s.code]; if (!a) continue;
    sum[a] = (sum[a] || 0) + s.score; n[a] = (n[a] || 0) + 1; S += s.score; N++;
  }
  const out: Record<string, number> = {};
  for (const a of Object.keys(n)) out[a] = Math.round((sum[a] / (5 * n[a])) * 100);
  return { area: out, overall: N ? Math.round((S / (5 * N)) * 100) : null, scored: N };
}

// ── translation ───────────────────────────────────────────────────────────────────────
const system = (auditor: string) => `You translate the spoken or typed notes of ${auditor === ENRICO ? "Chef Enrico Bartolini (Italian, multi-Michelin-starred)" : auditor} from an audit of Roberto's, an Italian restaurant and lounge in Dubai, into English for the restaurant's chairman.

Rules:
- Faithful meaning first. Never add, soften or invent anything. Keep the auditor's tone and strength of judgement.
- Plain, clear English with short sentences. Not flowery.
- Italian kitchen and service terms with no exact English equal (e.g. mantecatura, all'onda, partita, brigata, fondo, battuto, soffritto, mise en place a regola d'arte, sala, servizio al guéridon, stuzzichini, piccola pasticceria): keep the Italian word in the sentence and add a short English meaning in brackets the first time it appears in that note. Common ones the chairman knows (pasta, risotto, al dente, aperitivo, mise en place, antipasto) stay as they are with no bracket.
- The notes may come from phone dictation: fix obvious dictation errors only when the intended word is certain from context.
- Names of people, dishes and places stay as written.
- If a note is already in English, return it tidied but unchanged in meaning.`;

async function claude(model: string, texts: string[], sys: string) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model, max_tokens: 8000, system: sys,
      messages: [{ role: "user", content: "Translate each note. Return ONLY a JSON array of strings, same order and same count, nothing else.\n\n" + JSON.stringify(texts) }],
    }),
  });
  if (!r.ok) throw new Error("translate " + r.status + " " + (await r.text()).slice(0, 300));
  const d = await r.json();
  const txt = (d.content || []).map((c: Row) => c.text || "").join("").trim();
  const m = txt.match(/\[[\s\S]*\]/);
  const arr = JSON.parse(m ? m[0] : txt);
  if (!Array.isArray(arr) || arr.length !== texts.length) throw new Error("translate: wrong count");
  return arr.map((x: unknown) => String(x ?? ""));
}
async function translateAll(texts: string[], sys: string) {
  const out: string[] = [];
  for (let i = 0; i < texts.length; i += 25) {
    const part = texts.slice(i, i + 25);
    let res: string[];
    try { res = await claude("claude-sonnet-5-5", part, sys); }
    catch (_e) { res = await claude("claude-sonnet-4-6", part, sys); }
    out.push(...res);
  }
  return out;
}

// Every note whose English was made from different Italian (or never made) is translated now.
async function translatePending(visitId: string, auditor: string) {
  const jobs: { table: string; match: Row; it: string; enCol: string; srcCol: string }[] = [];
  const [sc, di, fl, tx] = await Promise.all([
    sb.from("audit_scores").select("id,note_it,en_src").eq("visit_id", visitId),
    sb.from("audit_dishes").select("id,note_it,en_src").eq("visit_id", visitId).eq("removed", false),
    sb.from("audit_flags").select("id,note_it,en_src").eq("visit_id", visitId).eq("removed", false),
    sb.from("audit_texts").select("key,it,en_src").eq("visit_id", visitId),
  ]);
  for (const r of sc.data || []) if (r.note_it && r.note_it !== r.en_src) jobs.push({ table: "audit_scores", match: { id: r.id }, it: r.note_it, enCol: "note_en", srcCol: "en_src" });
  for (const r of di.data || []) if (r.note_it && r.note_it !== r.en_src) jobs.push({ table: "audit_dishes", match: { id: r.id }, it: r.note_it, enCol: "note_en", srcCol: "en_src" });
  for (const r of fl.data || []) if (r.note_it && r.note_it !== r.en_src) jobs.push({ table: "audit_flags", match: { id: r.id }, it: r.note_it, enCol: "note_en", srcCol: "en_src" });
  for (const r of tx.data || []) if (r.it && r.it !== r.en_src) jobs.push({ table: "audit_texts", match: { visit_id: visitId, key: r.key }, it: r.it, enCol: "en", srcCol: "en_src" });
  if (!jobs.length) return 0;
  if (!ANTHROPIC_API_KEY) throw new Error("No ANTHROPIC_API_KEY on this project");
  const en = await translateAll(jobs.map((j) => j.it), system(auditor));
  await Promise.all(jobs.map((j, i) => {
    let q = sb.from(j.table).update({ [j.enCol]: en[i], [j.srcCol]: j.it });
    for (const [k, v] of Object.entries(j.match)) q = q.eq(k, v as string);
    return q.eq(j.table === "audit_texts" ? "it" : "note_it", j.it);   // only if the Italian did not change meanwhile
  }));
  return jobs.length;
}

// ── loading ───────────────────────────────────────────────────────────────────────────
async function signAll(paths: string[], secs: number) {
  const out: Record<string, string> = {};
  const uniq = [...new Set(paths.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 100) {
    const { data } = await sb.storage.from(BUCKET).createSignedUrls(uniq.slice(i, i + 100), secs);
    for (const d of data || []) if (d.signedUrl && d.path) out[d.path] = d.signedUrl;
  }
  return out;
}

async function dishList() {
  const { data: subs } = await sb.from("menus").select("id,parent_id").in("parent_id", MENUS).eq("archived", false);
  const scala = new Set([SCALA_MENU, ...(subs || []).filter((m) => m.parent_id === SCALA_MENU).map((m) => m.id)]);
  const ids = [...MENUS, ...(subs || []).map((m) => m.id)];
  const { data: rm } = await sb.from("recipe_menus").select("recipe_id,menu_id").in("menu_id", ids);
  const rids = [...new Set((rm || []).map((r) => r.recipe_id))];
  if (!rids.length) return [];
  const { data: rec } = await sb.from("recipes").select("id,name,archived").in("id", rids);
  const place: Record<string, string> = {};
  for (const r of rm || []) place[r.recipe_id] = scala.has(r.menu_id) ? "scala" : (place[r.recipe_id] || "ristorante");
  return (rec || []).filter((r) => !r.archived && r.name).map((r) => ({ id: r.id, name: String(r.name).trim(), where: place[r.id] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function previousVisit(v: Row) {
  const { data } = await sb.from("audit_visits").select("id,title,visit_date,overall_pct,area_pct,status,created_at")
    .in("status", ["archived", "sent"]).eq("auditor", v.auditor).neq("id", v.id);   // same auditor only
  const list = (data || []).filter((p) => !v.visit_date || !p.visit_date || p.visit_date < v.visit_date)
    .sort((a, b) => String(b.visit_date || "0000").localeCompare(String(a.visit_date || "0000")) || String(b.created_at).localeCompare(String(a.created_at)));
  const p = list[0]; if (!p) return null;
  const { data: sc } = await sb.from("audit_scores").select("code,score,na,note_it,note_en").eq("visit_id", p.id);
  return { title: p.title, overall_pct: p.overall_pct, area_pct: p.area_pct || {}, scores: sc || [] };
}

async function loadAll(v: Row, admin: boolean) {
  const [cat, sc, di, fl, tx, prev, dishes] = await Promise.all([
    sb.from("audit_catalog").select("*").eq("active", true).order("area").order("position"),
    sb.from("audit_scores").select("*").eq("visit_id", v.id),
    sb.from("audit_dishes").select("*").eq("visit_id", v.id).eq("removed", false).order("created_at"),
    sb.from("audit_flags").select("*").eq("visit_id", v.id).eq("removed", false).order("created_at"),
    sb.from("audit_texts").select("*").eq("visit_id", v.id),
    previousVisit(v),
    dishList(),
  ]);
  const paths: string[] = [];
  for (const r of [...(sc.data || []), ...(di.data || []), ...(fl.data || []), ...(tx.data || [])]) for (const p of r.photos || []) paths.push(p);
  const urls = await signAll(paths, 60 * 60 * 24);
  const p = pcts(sc.data || [], cat.data || []);
  return {
    role: admin ? "admin" : "enrico",
    visit: { id: v.id, title: v.title, visit_date: v.visit_date, auditor: v.auditor, created_at: v.created_at, status: v.status, submitted_at: v.submitted_at, sent_at: v.sent_at, sent_to: v.sent_to, enrico_token: admin ? v.enrico_token : undefined },
    catalog: cat.data || [], scores: sc.data || [], dishes: di.data || [], flags: fl.data || [], texts: tx.data || [],
    previous: prev, menu: dishes, urls, pct: p, recipients: admin ? { to: AMIN, cc: FRANCESCO } : null,
  };
}

// ── photos ────────────────────────────────────────────────────────────────────────────
function b64ToBytes(b64: string) {
  const s = atob(b64.replace(/^data:[^,]+,/, ""));
  const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
async function rowFor(target: string, ref: string, visitId: string) {
  if (target === "score") {
    await sb.from("audit_scores").upsert({ visit_id: visitId, code: ref }, { onConflict: "visit_id,code", ignoreDuplicates: true });
    return { table: "audit_scores", match: { visit_id: visitId, code: ref } };
  }
  if (target === "text") {
    await sb.from("audit_texts").upsert({ visit_id: visitId, key: ref }, { onConflict: "visit_id,key", ignoreDuplicates: true });
    return { table: "audit_texts", match: { visit_id: visitId, key: ref } };
  }
  if (target === "dish") return { table: "audit_dishes", match: { visit_id: visitId, id: ref } };
  if (target === "flag") return { table: "audit_flags", match: { visit_id: visitId, id: ref } };
  throw new Error("bad target");
}
async function getRow(t: { table: string; match: Row }) {
  let q = sb.from(t.table).select("*");
  for (const [k, v] of Object.entries(t.match)) q = q.eq(k, v as string);
  const { data } = await q.maybeSingle();
  return data;
}
async function setRow(t: { table: string; match: Row }, fields: Row) {
  let q = sb.from(t.table).update({ ...fields, updated_at: new Date().toISOString() });
  for (const [k, v] of Object.entries(t.match)) q = q.eq(k, v as string);
  const { data, error } = await q.select().maybeSingle();
  if (error) throw error;
  return data;
}

// ── the email ─────────────────────────────────────────────────────────────────────────
const C = { vino: "#410207", terra: "#c0481f", ink: "#2a1a10", muted: "#6b5b50", line: "#e6dacb", paper: "#fbf7f1", sab: "#ede5d8", ok: "#2f5d1e", below: "#7a4200", err: "#8f1d12" };
const fmtDate = (d: string | null) => d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "";
const dueTxt = (d: string | null) => d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
const lbl = (t: string) => `<div style="font:700 11px/1.4 Arial,sans-serif;letter-spacing:1.5px;text-transform:uppercase;color:${C.vino};margin:26px 0 8px">${esc(t)}</div>`;
const badge = (v: string) => {
  const m: Record<string, [string, string, string]> = { urgent: ["Urgent", "#f6dcd6", C.err], fix: ["To fix", "#f6e6cc", C.below], remove: ["Take off", "#f6dcd6", C.err], keep: ["Keep", "#e4ecd9", C.ok], ok: ["OK", "#e4ecd9", C.ok], attention: ["Attention", "#f6e6cc", C.below] };
  const x = m[v]; if (!x) return "";
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${x[1]};color:${x[2]};font:700 11px Arial,sans-serif">${x[0]}</span>`;
};
const pics = (ps: string[], urls: Record<string, string>) => (ps || []).filter((p) => urls[p]).map((p) =>
  `<a href="${esc(urls[p])}"><img src="${esc(urls[p])}" width="120" height="90" style="width:120px;height:90px;object-fit:cover;border-radius:4px;margin:6px 6px 0 0;border:0" alt="Photo"></a>`).join("");
const en = (r: Row, itCol = "note_it", enCol = "note_en") => r[enCol] || r[itCol] || "";

function emailHtml(d: Row, urls: Record<string, string>) {
  const cat: Record<string, Row> = {}; for (const c of d.catalog) cat[c.code] = c;
  const t: Record<string, Row> = {}; for (const x of d.texts) t[x.key] = x;
  const prev = d.previous;
  const pa = d.pct.area, pp = prev ? prev.area_pct : {};
  const urgent = d.scores.filter((s: Row) => s.verdict === "urgent").length + d.dishes.filter((x: Row) => x.verdict === "remove").length;
  const tofix = d.scores.filter((s: Row) => s.verdict === "fix").length + d.dishes.filter((x: Row) => x.verdict === "fix").length + d.flags.filter((f: Row) => f.kind === "attention").length;
  const diff = (a: number | null, b: number | null) => (a == null || b == null) ? "—" : (a - b > 0 ? "+" : "") + (a - b);
  const tile = (n: string, l: string, col = C.ink) => `<td style="padding:4px"><div style="border:1px solid ${C.line};background:#fff;border-radius:6px;padding:12px"><div style="font:700 24px Arial,sans-serif;color:${col}">${esc(n)}</div><div style="font:12px Arial,sans-serif;color:${C.muted}">${esc(l)}</div></div></td>`;
  const para = (s: string) => `<div style="font:15px/1.55 Arial,sans-serif;color:${C.ink};white-space:pre-line">${esc(s)}</div>`;

  let h = `<!doctype html><html><body style="margin:0;background:${C.paper}"><div style="max-width:680px;margin:0 auto;padding:24px 18px;font-family:Arial,sans-serif;color:${C.ink}">`;
  h += `<div style="background:${C.vino};color:#f5ede0;border-radius:8px;padding:24px 22px"><div style="font:700 11px Arial,sans-serif;letter-spacing:2px;text-transform:uppercase;color:#e1d3c2">Roberto's DIFC · Audit</div>`;
  h += `<div style="font:30px/1.15 Georgia,'Times New Roman',serif;margin-top:8px">${esc(d.visit.auditor)}</div><div style="font:14px Arial,sans-serif;color:#e1d3c2;margin-top:6px">Visit of ${esc(fmtDate(d.visit.visit_date))}</div></div>`;
  h += `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:12px"><tr>${tile((d.pct.overall ?? "—") + "%", "Overall")}${tile(diff(d.pct.overall, prev?.overall_pct ?? null), "vs " + (prev?.title || "last visit"), C.ok)}${tile(String(urgent), "Urgent", C.err)}${tile(String(tofix), "To fix", C.below)}</tr></table>`;
  if (t.overall && en(t.overall, "it", "en")) h += lbl("Overall visit") + para(en(t.overall, "it", "en")) + pics(t.overall.photos, urls);
  if (t.improve && en(t.improve, "it", "en")) h += lbl("Suggested improvements") + para(en(t.improve, "it", "en")) + pics(t.improve.photos, urls);
  const tops = ["p1", "p2", "p3"].map((k) => t[k] ? en(t[k], "it", "en") : "").filter(Boolean);
  if (tops.length) h += lbl(firstName(d.visit.auditor) + "'s top 3") + tops.map((s, i) => `<div style="font:15px/1.5 Arial,sans-serif;margin:4px 0"><b style="color:${C.terra};font:20px Georgia,serif">${i + 1}</b>&nbsp; ${esc(s)}</div>`).join("");

  h += lbl("Scores by area") + `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font:14px Arial,sans-serif"><tr style="color:${C.muted};font-size:12px"><td style="padding:6px 0;border-bottom:1px solid ${C.line}">Area</td><td style="border-bottom:1px solid ${C.line}">${esc(d.visit.title)}</td><td style="border-bottom:1px solid ${C.line}">${esc(prev?.title || "Last visit")}</td><td style="border-bottom:1px solid ${C.line}">Trend</td></tr>`;
  for (const a of AREAS) {
    const n = pa[a] ?? null, o = pp[a] ?? null;
    h += `<tr><td style="padding:8px 0;border-bottom:1px solid ${C.line};font:16px Georgia,serif;color:${C.vino}">${AREA_EN[a]}</td><td style="border-bottom:1px solid ${C.line}">${n == null ? "not scored" : n + "%"}</td><td style="border-bottom:1px solid ${C.line}">${o == null ? "not scored" : o + "%"}</td><td style="border-bottom:1px solid ${C.line}">${diff(n, o)}</td></tr>`;
  }
  h += `</table>`;

  // Action plan: urgent first, then to fix — items, dishes, photo flags.
  type A = { lvl: number; v: string; where: string; what: string; note: string; owner: string; due: string; photos: string[] };
  const acts: A[] = [];
  for (const s of d.scores) if (s.verdict === "urgent" || s.verdict === "fix") { const c = cat[s.code] || {}; acts.push({ lvl: s.verdict === "urgent" ? 0 : 1, v: s.verdict, where: AREA_EN[c.area] || "", what: c.label_en || s.code, note: en(s), owner: s.owner || "", due: dueTxt(s.due), photos: s.photos }); }
  for (const x of d.dishes) if (x.verdict === "fix" || x.verdict === "remove") acts.push({ lvl: x.verdict === "remove" ? 0 : 1, v: x.verdict, where: "Dish", what: x.dish_name, note: en(x), owner: x.owner || "", due: dueTxt(x.due), photos: x.photos });
  for (const f of d.flags) if (f.kind === "attention") acts.push({ lvl: 1, v: "attention", where: AREA_EN[f.area] || "", what: f.dish_name || "Photo note", note: en(f), owner: f.owner || "", due: dueTxt(f.due), photos: f.photos });
  acts.sort((a, b) => a.lvl - b.lvl);
  if (acts.length) {
    h += lbl("Action plan");
    for (const a of acts) h += `<div style="border:1px solid ${C.line};background:#fff;border-radius:6px;padding:12px 14px;margin:0 0 8px"><div style="font:16px Georgia,serif;color:${C.vino}">${esc(a.what)} &nbsp;${badge(a.v)}</div><div style="font:12px Arial,sans-serif;color:${C.muted};margin-top:2px">${esc(a.where)}${a.owner ? " · " + esc(a.owner) : ""}${a.due ? " · by " + esc(a.due) : ""}</div>${a.note ? `<div style="font:14px/1.5 Arial,sans-serif;margin-top:6px;white-space:pre-line">${esc(a.note)}</div>` : ""}${pics(a.photos, urls)}</div>`;
  }

  if (d.dishes.length) {
    h += lbl("Dishes tasted");
    for (const x of d.dishes) h += `<div style="border-bottom:1px solid ${C.line};padding:10px 0"><div style="font:16px Georgia,serif;color:${C.vino}">${esc(x.dish_name)} ${x.score ? `<span style="font:700 14px Arial,sans-serif;color:${C.ink}">· ${x.score}/5</span>` : ""} ${badge(x.verdict)}</div>${en(x) ? `<div style="font:14px/1.5 Arial,sans-serif;margin-top:4px;white-space:pre-line">${esc(en(x))}</div>` : ""}${pics(x.photos, urls)}</div>`;
  }
  const keeps = d.flags.filter((f: Row) => f.kind === "keep");
  if (keeps.length) {
    h += lbl("What " + firstName(d.visit.auditor) + " liked");
    for (const f of keeps) h += `<div style="border-bottom:1px solid ${C.line};padding:10px 0"><div style="font:12px Arial,sans-serif;color:${C.muted}">${esc(AREA_EN[f.area] || "")}${f.dish_name ? " · " + esc(f.dish_name) : ""}</div>${en(f) ? `<div style="font:14px/1.5 Arial,sans-serif;margin-top:4px">${esc(en(f))}</div>` : ""}${pics(f.photos, urls)}</div>`;
  }

  h += lbl("Every item");
  const byCode: Record<string, Row> = {}; for (const s of d.scores) byCode[s.code] = s;
  for (const a of AREAS) {
    const items = d.catalog.filter((c: Row) => c.area === a);
    h += `<div style="font:18px Georgia,serif;color:${C.vino};margin:14px 0 4px">${AREA_EN[a]}${pa[a] != null ? ` <span style="font:13px Arial,sans-serif;color:${C.muted}">${pa[a]}%</span>` : ""}</div>`;
    for (const c of items) {
      const s = byCode[c.code] || {};
      const sc = s.na ? "N/A" : (s.score ? s.score + "/5" : "—");
      h += `<div style="border-bottom:1px solid ${C.line};padding:8px 0;font:14px Arial,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td>${esc(c.label_en)} ${badge(s.verdict)}</td><td align="right" style="font-weight:700;white-space:nowrap">${sc}</td></tr></table>${en(s) ? `<div style="color:${C.muted};font-size:13px;line-height:1.5;margin-top:3px;white-space:pre-line">${esc(en(s))}</div>` : ""}${pics(s.photos, urls)}</div>`;
    }
  }
  h += `<div style="font:12px/1.5 Arial,sans-serif;color:${C.muted};margin-top:26px">Scores 1–5. Percentages count only the items ${esc(firstName(d.visit.auditor))} scored; N/A is left out. ${prev ? esc(prev.title) + " is recalculated on the same items." : ""} Notes translated to English where needed; the original is kept in the Kitchen App.</div>`;
  h += `</div></body></html>`;
  return h;
}

async function sendMail(to: Row[], cc: Row[], subject: string, html: string) {
  if (!RESEND_API_KEY) throw new Error("No RESEND_API_KEY on this project");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: to.map((x) => `${x.name} <${x.email}>`), cc: cc.map((x) => `${x.name} <${x.email}>`), reply_to: FRANCESCO.email, subject, html }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error("Resend " + r.status + " " + body.slice(0, 300));
  return body;
}

// ── handler ───────────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let b: Row;
  try { b = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const readOnly = new URL(req.url).searchParams.has("read");
  const action = String(b.action || "");
  if (readOnly && action !== "load") return json({ error: "read-only call" }, 400);

  // ── the shared link ──
  if (typeof b.n === "string") {
    if (b.n.length < 20) return json({ error: "Link not valid" }, 403);
    const { data: inv } = await sb.from("audit_visits").select("id,title,status").eq("enrico_token", b.n).eq("status", "invite").maybeSingle();
    if (!inv) return json({ error: "Link not valid" }, 403);
    if (action === "load") return json({ role: "invite", title: inv.title });
    if (action !== "start") return json({ error: "Not allowed" }, 403);
    const name = clean(b.name, 60);
    if (!name || name.length < 2) return json({ error: "Name needed" }, 400);
    // A shared link can be forwarded: cap how many audits it can start in a day.
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { count } = await sb.from("audit_visits").select("id", { count: "exact", head: true }).eq("source_note", "invite:" + inv.id).gte("created_at", since);
    if ((count || 0) >= 40) return json({ error: "Too many audits started from this link today. Ask Francesco." }, 429);
    const now = dubaiNow();
    const { data: nv, error } = await sb.from("audit_visits").insert({
      title: `${name} · ${now.date.split("-").reverse().join("/")} ${now.time}`, auditor: name, visit_date: now.date,
      status: "open", enrico_token: newToken(), admin_token: newToken(), source_note: "invite:" + inv.id,
    }).select("enrico_token").single();
    if (error) return json({ error: error.message }, 500);
    return json({ k: nv.enrico_token });
  }

  const admin = typeof b.a === "string" && b.a.length >= 20;
  const token = admin ? b.a : b.k;
  if (typeof token !== "string" || token.length < 20) return json({ error: "Link not valid" }, 403);
  const { data: v } = await sb.from("audit_visits").select("*").eq(admin ? "admin_token" : "enrico_token", token).maybeSingle();
  if (!v) return json({ error: "Link not valid" }, 403);
  if (v.status === "invite") {   // ?k= of an invite is refused (it is the ?n= link); ?a= of an invite is Francesco's list
    if (!admin || action !== "load") return json({ error: "Link not valid" }, 403);
    const { data: list } = await sb.from("audit_visits").select("id,title,auditor,visit_date,created_at,status,overall_pct,submitted_at,sent_at,admin_token")
      .eq("source_note", "invite:" + v.id).order("created_at", { ascending: false });
    const ids = (list || []).map((x) => x.id);
    const { data: sc } = ids.length ? await sb.from("audit_scores").select("visit_id,score,na").in("visit_id", ids) : { data: [] as Row[] };
    const done: Record<string, number> = {};
    for (const s of sc || []) if (s.score || s.na) done[s.visit_id] = (done[s.visit_id] || 0) + 1;
    const { count: total } = await sb.from("audit_catalog").select("code", { count: "exact", head: true }).eq("active", true);
    return json({ role: "invite_admin", title: v.title, invite_token: v.enrico_token, total: total || 0,
      audits: (list || []).map((x) => ({ ...x, done: done[x.id] || 0 })) });
  }

  try {
    if (action === "load") return json(await loadAll(v, admin));

    // Enrico cannot change anything once the report has gone to Amin.
    if (!admin && v.status === "sent") return json({ error: v.auditor === ENRICO ? "Questo audit è già stato inviato. Grazie!" : "This audit has already been sent. Thank you!" }, 409);
    const touch = () => sb.from("audit_visits").update({ updated_at: new Date().toISOString() }).eq("id", v.id);

    if (action === "score") {
      const code = String(b.code || "");
      const { data: c } = await sb.from("audit_catalog").select("code").eq("code", code).maybeSingle();
      if (!c) return json({ error: "Unknown item" }, 400);
      const f: Row = { visit_id: v.id, code, updated_at: new Date().toISOString() };
      if ("score" in b) f.score = b.score == null ? null : Math.max(1, Math.min(5, Math.round(Number(b.score))));
      if ("na" in b) { f.na = !!b.na; if (f.na) f.score = null; }
      if ("score" in b && f.score != null) f.na = false;
      if ("verdict" in b) f.verdict = VERDICT_SCORE.includes(b.verdict) ? b.verdict : null;
      if ("note_it" in b) f.note_it = clean(b.note_it);
      const { data, error } = await sb.from("audit_scores").upsert(f, { onConflict: "visit_id,code" }).select().single();
      if (error) throw error;
      await touch();
      return json({ row: data });
    }

    if (action === "dish") {
      const f: Row = { updated_at: new Date().toISOString() };
      if ("dish_name" in b) f.dish_name = clean(b.dish_name, 200);
      if ("recipe_id" in b) f.recipe_id = typeof b.recipe_id === "string" && /^[0-9a-f-]{36}$/.test(b.recipe_id) ? b.recipe_id : null;
      if ("score" in b) f.score = b.score == null ? null : Math.max(1, Math.min(5, Math.round(Number(b.score))));
      if ("verdict" in b) f.verdict = VERDICT_DISH.includes(b.verdict) ? b.verdict : null;
      if ("note_it" in b) f.note_it = clean(b.note_it);
      if (b.remove === true) f.removed = true;
      let res;
      if (b.id) res = await sb.from("audit_dishes").update(f).eq("id", b.id).eq("visit_id", v.id).select().single();
      else { if (!f.dish_name) return json({ error: "Dish name needed" }, 400); res = await sb.from("audit_dishes").insert({ ...f, visit_id: v.id }).select().single(); }
      if (res.error) throw res.error;
      await touch();
      return json({ row: res.data });
    }

    if (action === "flag") {
      const f: Row = { updated_at: new Date().toISOString() };
      if ("area" in b) f.area = FLAG_AREAS.includes(b.area) ? b.area : "piatto";
      if ("dish_name" in b) f.dish_name = clean(b.dish_name, 200);
      if ("recipe_id" in b) f.recipe_id = typeof b.recipe_id === "string" && /^[0-9a-f-]{36}$/.test(b.recipe_id) ? b.recipe_id : null;
      if ("kind" in b) f.kind = b.kind === "keep" ? "keep" : "attention";
      if ("note_it" in b) f.note_it = clean(b.note_it);
      if (b.remove === true) f.removed = true;
      let res;
      if (b.id) res = await sb.from("audit_flags").update(f).eq("id", b.id).eq("visit_id", v.id).select().single();
      else res = await sb.from("audit_flags").insert({ area: "piatto", kind: "attention", ...f, visit_id: v.id }).select().single();
      if (res.error) throw res.error;
      await touch();
      return json({ row: res.data });
    }

    if (action === "text") {
      const key = String(b.key || "");
      if (!["overall", "improve", "p1", "p2", "p3"].includes(key)) return json({ error: "bad key" }, 400);
      const { data, error } = await sb.from("audit_texts").upsert({ visit_id: v.id, key, it: clean(b.it), updated_at: new Date().toISOString() }, { onConflict: "visit_id,key" }).select().single();
      if (error) throw error;
      await touch();
      return json({ row: data });
    }

    if (action === "photo") {
      const t = await rowFor(String(b.target), String(b.ref), v.id);
      const row = await getRow(t);
      if (!row) return json({ error: "Not found" }, 404);
      const bytes = b64ToBytes(String(b.data || ""));
      if (bytes.length < 100 || bytes.length > 9_000_000) return json({ error: "Photo too large" }, 400);
      const path = `${v.id}/${crypto.randomUUID()}.jpg`;
      const up = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: "image/jpeg", upsert: false });
      if (up.error) throw up.error;
      // Re-read and append, so two photos taken quickly both stay.
      const fresh = await getRow(t);
      const data = await setRow(t, { photos: [...((fresh && fresh.photos) || []), path] });
      const urls = await signAll([path], 60 * 60 * 24);
      await touch();
      return json({ row: data, path, url: urls[path] });
    }

    if (action === "photo_del") {
      const t = await rowFor(String(b.target), String(b.ref), v.id);
      const row = await getRow(t);
      if (!row) return json({ error: "Not found" }, 404);
      const data = await setRow(t, { photos: (row.photos || []).filter((p: string) => p !== b.path) });   // the file itself is kept
      return json({ row: data });
    }

    if (action === "submit") {
      const n = await translatePending(v.id, v.auditor).catch((e) => { console.error(e); return -1; });
      const { data: sc } = await sb.from("audit_scores").select("code,score,na").eq("visit_id", v.id);
      const { data: cat } = await sb.from("audit_catalog").select("code,area");
      const p = pcts(sc || [], cat || []);
      await sb.from("audit_visits").update({ status: v.status === "sent" || v.status === "test" ? v.status : "submitted", submitted_at: new Date().toISOString(), overall_pct: p.overall, area_pct: p.area, updated_at: new Date().toISOString() }).eq("id", v.id);
      // Tell Francesco it is ready. This mail goes only to him, so it carries his report link.
      const link = pageFor(b.page) + "?a=" + v.admin_token;
      try {
        await sendMail([FRANCESCO], [], (v.status === "test" ? "[TEST] " : "") + `${v.auditor} has finished the audit`,
          `<div style="font:15px/1.5 Arial,sans-serif;color:#2a1a10">${esc(v.auditor)} has sent the audit (${p.scored} items scored, overall ${p.overall ?? "—"}%).<br><a href="${esc(link)}">Open the report</a> to check the English and send it to Amin.</div>`);
      } catch (e) { console.error(e); }
      return json({ ok: true, translated: n, pct: p });
    }

    // ── Francesco only from here ──
    if (!admin) return json({ error: "Not allowed" }, 403);

    if (action === "translate") return json({ translated: await translatePending(v.id, v.auditor) });

    if (action === "set") {   // edit the English, owner, date, done
      const t = await rowFor(String(b.target), String(b.ref), v.id);
      const f: Row = {};
      const enCol = b.target === "text" ? "en" : "note_en";
      if ("en" in b) f[enCol] = clean(b.en);
      if ("owner" in b && b.target !== "text") f.owner = clean(b.owner, 80);
      if ("due" in b && b.target !== "text") f.due = isDate(b.due) ? b.due : null;
      if ("done" in b && b.target !== "text") f.done = !!b.done;
      return json({ row: await setRow(t, f) });
    }

    if (action === "send" || action === "send_test") {
      if (action === "send" && v.status === "test") return json({ error: "This is a test visit: it can only be sent to Francesco." }, 400);
      await translatePending(v.id, v.auditor);
      const d = await loadAll(v, true);
      const all: string[] = [];
      for (const r of [...d.scores, ...d.dishes, ...d.flags, ...d.texts]) for (const p of r.photos || []) all.push(p);
      const urls = await signAll(all, 60 * 60 * 24 * 365);   // a year, so the photos still open from the email
      const html = emailHtml(d, urls);
      const subject = (action === "send_test" ? "[TEST] " : "") + `${v.auditor} Audit — Roberto's DIFC — ${fmtDate(v.visit_date)}`;
      const to = action === "send_test" ? [FRANCESCO] : [AMIN];
      const cc = action === "send_test" ? [] : [FRANCESCO];
      try {
        await sendMail(to, cc, subject, html);
        await sb.from("audit_mail").insert({ visit_id: v.id, sent_to: to.map((x) => x.email).join(", "), cc: cc.map((x) => x.email).join(", "), subject, status: "sent" });
      } catch (e) {
        await sb.from("audit_mail").insert({ visit_id: v.id, sent_to: to.map((x) => x.email).join(", "), subject, status: "failed", error: String(e).slice(0, 500) });
        throw e;
      }
      if (action === "send") await sb.from("audit_visits").update({ status: "sent", sent_at: new Date().toISOString(), sent_to: AMIN.email, overall_pct: d.pct.overall, area_pct: d.pct.area, updated_at: new Date().toISOString() }).eq("id", v.id);
      return json({ ok: true, to: to.map((x) => x.email) });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
