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
//   { foh: <FOH login token> }  The FOH Audits module (22 Oct 2026). The FOH login is checked
//                      against the FOH project, and its app_users.modules decide what it may do:
//                      'audit_send' = their OWN invite link (sender_email on the invite row), to share
//                      with anyone; 'audit_read' = send, plus the list of every audit and each report.
//                      FOH Admins get both. A sender can replace their link: the old one stops working.
// Whoever opens an invite types their name and the date and time of their visit (they may be a
// guest the Chairman sent). Their "send" goes to Roberto's management team: no email, it appears
// in the FOH Audits module. Only Enrico's own visit still mails Francesco (his report goes to Amin).
// Enrico writes in Italian. Every note is translated to English by Claude with a chef's glossary
// (Italian kitchen terms kept, explained once). The Italian is never overwritten.
//
// POST JSON { k | a, action, ... }. The page calls audit-api?read=1 for "load" so the DEV
// write guard (dev-guard.js) lets the page open on the DEV site; anything else is a write.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const FROM = "Roberto's DIFC <no-reply@kitchenteam.robertos.ae>";   // the verified domain stays
const AMIN = { name: "Amin Kadrie", email: "akadrie@skelmore.com" };
const FRANCESCO = { name: "Francesco Guarracino", email: "fguarracino@robertos.ae" };
const BUCKET = "audit-photos";
const MENUS = ["217de140-5257-405f-be72-eaef8dde2c8b", "b7af4ba8-6ecc-4883-a16f-fdce9ba4a075"]; // A la carte 2026, Scala Bites Menu
const SCALA_MENU = "b7af4ba8-6ecc-4883-a16f-fdce9ba4a075";
const MENU_SECTIONS = ["Crudo", "Antipasti", "Insalate", "Pasta", "Pizza", "Pesce", "Secondi", "Grill", "Side Dish", "Dessert"];
// Three kinds of audit (22 Oct 2026): 'venue' = Chef Enrico, the whole venue; 'restaurant' = a guest
// visit to the restaurant, booking included; 'scala' = the bar & lounge. audit_catalog.kinds says
// which questions belong to which; AREA_ORDER is the order the sections are shown and reported in.
const KINDS = ["venue", "restaurant", "scala"];
const KIND_EN: Record<string, string> = { venue: "Whole venue", restaurant: "Restaurant visit", scala: "Scala visit" };
const AREA_ORDER: Record<string, string[]> = {
  venue: ["arrivo", "cucina", "ristorante", "vino", "scala", "bagno", "congedo"],
  restaurant: ["prenota", "arrivo", "ristorante", "servito", "vino", "cucina", "bagno", "congedo"],
  scala: ["prenota", "arrivo", "scala", "servito", "bagno", "congedo"],
};
// Sections an older audit page cannot draw: hidden from any page that does not send pv >= 2.
const NEW_AREAS = ["prenota", "bagno", "congedo"];
// Question sets (22 Oct 2026, Francesco). Each audit keeps the set it started with (audit_visits.qset);
// a question shows when since_qset <= set and (until_qset is empty or set < until_qset). Set 2 = "Who served you",
// bar-counter wording, cigar selection. Set 3 = SOP timings, split double questions, how long the food took,
// dessert / coffee offered, name used, and dish scores counted in the food %. A page older than set 2 sees set 1.
// Set 4 (24 Oct 2026, agreed one by one): table ready within 5 min moves to Arrival, Scala drinks list split,
// first visit 2 min in both, washroom per room, Scala bill time + availability, allergies at the table, check-back.
const AREAS = AREA_ORDER.venue;
const AREA_EN: Record<string, string> = { prenota: "Booking", servito: "Who served you", arrivo: "Arrival & welcome", cucina: "Kitchen", ristorante: "Restaurant", vino: "Wine", scala: "Scala", bagno: "Washroom", congedo: "Bill & goodbye", piatto: "Dish" };
// For a guest the kitchen section is the food on the plate.
// A guest's sections are named for a guest: the kitchen is the food on the plate, the restaurant is
// what happens at the table, Scala is the bar & lounge itself.
const areaEn = (kind: string, a: string) =>
  kind !== "venue" && a === "cucina" ? "The food" : kind === "restaurant" && a === "ristorante" ? "At the table" : kind === "scala" && a === "scala" ? "At Scala" :
  kind === "restaurant" && a === "bagno" ? "Restaurant washroom" : kind === "scala" && a === "bagno" ? "Scala washroom" : AREA_EN[a] || a;
// A standard is answered Yes (score 5) or No (score 0); a quality score is 1-5. Either way the % is score / 5,
// and "answered" means a score is there at all — a No is 0, so never test a score for truth.
const has = (s: Row) => s && !s.na && s.score != null;
const kindOf = (k: unknown) => (KINDS.includes(String(k)) ? String(k) : "venue");
const ENRICO = "Chef Enrico Bartolini";
const firstName = (n: string) => String(n || "").replace(/^Chef\s+/i, "").trim().split(/\s+/)[0] || "the auditor";
// Pages that may be linked to (the link goes to the page that asked). The audit moved to the FOH app
// on 22 Oct 2026; the Kitchen pages only forward there. Cloudflare serves "/audit.html" as "/audit".
const PAGES = ["https://robertos-leadership.github.io/robertos-foh/audit.html", "https://robertos-foh-dev.pages.dev/audit.html",
  "https://guarracinofamily.github.io/robertos-kitchen/audit.html", "https://robertos-kitchen.github.io/robertos-kitchen/audit.html"];
const pageFor = (o: unknown) => { const s = String(o || "").replace(/\/audit$/, "/audit.html"); return PAGES.find((p) => p === s) || PAGES[0]; };
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
const isTime = (s: unknown) => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
// Statuses a reader sees in the FOH list (never the invites themselves or test visits).
const LISTED = ["open", "submitted", "sent"];   // archived = the Nov 2022 visit: not compared, not listed

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const FOH_URL = "https://paoaivwtkzujmrgrfjuq.supabase.co";
const FOH_KEY = Deno.env.get("FOH_SERVICE_KEY") ?? "";
const foh = FOH_KEY ? createClient(FOH_URL, FOH_KEY, { auth: { persistSession: false } }) : null;

type Row = Record<string, any>;

// ── percentages: score / (5 × scored items), N/A and empty left out ──────────────────
// Which area a scored dish counts in: the food on a Restaurant visit, Scala on a Scala visit (set 3 on).
const dishArea = (kind: string, qset: number) => qset >= 3 ? (kind === "restaurant" ? "cucina" : kind === "scala" ? "scala" : "") : "";
const dishItems = (kind: string, qset: number, dishes: Row[]) => {
  const area = dishArea(kind, qset);
  return area ? (dishes || []).filter((d) => !d.removed && d.score != null && Number(d.score) > 0).map((d) => ({ area, score: Number(d.score) })) : [];
};
function pcts(scores: Row[], catalog: Row[], dishes: { area: string; score: number }[] = []) {
  const area: Record<string, string> = {}; for (const c of catalog) area[c.code] = c.area;
  const sum: Record<string, number> = {}, n: Record<string, number> = {};
  let S = 0, N = 0;
  for (const s of scores) {
    if (!has(s)) continue;
    const a = area[s.code]; if (!a) continue;
    sum[a] = (sum[a] || 0) + s.score; n[a] = (n[a] || 0) + 1; S += s.score; N++;
  }
  // A scored dish is one more item in its area (set 3 guests: the food, or Scala). Not for Enrico's tasting.
  for (const d of dishes) { sum[d.area] = (sum[d.area] || 0) + d.score; n[d.area] = (n[d.area] || 0) + 1; S += d.score; N++; }
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

// ── dictation clean-up ────────────────────────────────────────────────────────────────
// Phone speech-to-text writes the sounds, not the meaning ("a Bittu sorati" for "a bit too salty",
// Francesco 22 Oct 2026). After Stop, the dictated words go here with what they are about and the
// menu names, and come back as a clean sentence in the same language. Nothing is added: the page
// keeps what was said and offers it back ("What you said"), and every pair is logged.
const TEXT_ABOUT: Record<string, string> = {
  overall: "the visit overall", improve: "suggested improvements", p1: "a top priority", p2: "a top priority", p3: "a top priority",
  best: "the best moment of the visit", fixone: "one thing to fix", other: "anything else about the visit",
  formfb: "feedback on the audit form itself (its questions or the app), not on the restaurant",
};
const tidySystem = (lang: string, about: string, visit: string, menu: string[]) => `You clean up phone dictation for an audit of Roberto's, an Italian restaurant with Scala, its bar & lounge, in Dubai.
The speaker dictated a note about ${about}. Visit: ${visit}.

Speech-to-text writes the sounds it heard, so words come out wrong. Your job:
- Fix misheard words only where the context makes the intended words clear (for example, about a dish, "a Bittu sorati" means "a bit too salty"). Use the menu names below only to correct a name that was misheard; never replace, complete or lengthen a name the speaker said correctly ("burrata" stays "burrata").
- Remove fillers, false starts, repeated words and anything said to the phone rather than about the visit ("okay let's see", "testing 1 2 3", "do you understand").
- Keep the speaker's meaning, opinion and strength exactly. Never add facts, details, praise or criticism they did not say. Never answer, explain or comment.
- If a part cannot be understood with confidence, keep those words as they were.
- Change as little as possible: keep the speaker's own words, word order and connectors (but, because, ma, perché); add punctuation and capitals. Write in ${lang}, in the speaker's own voice.
- If nothing is left after removing what was said to the phone, return an empty text.

Return ONLY JSON: {"text": "..."}

Menu names: ${menu.join(" · ") || "(none)"}`;

// The menu for the tidy prompt, kept for 10 minutes: three lookups on every Stop added ~1 s.
let MENU_CACHE: { at: number; list: Row[] } | null = null;
async function menuCached() {
  if (!MENU_CACHE || Date.now() - MENU_CACHE.at > 600000) MENU_CACHE = { at: Date.now(), list: await dishList() };
  return MENU_CACHE.list;
}

async function tidyCall(model: string, raw: string, sys: string) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 1000, system: sys, messages: [{ role: "user", content: raw }] }),
  });
  if (!r.ok) throw new Error("tidy " + r.status + " " + (await r.text()).slice(0, 200));
  const d = await r.json();
  const txt = (d.content || []).map((c: Row) => c.text || "").join("").trim();
  const m = txt.match(/\{[\s\S]*\}/);
  const o = JSON.parse(m ? m[0] : txt);
  if (typeof o.text !== "string") throw new Error("tidy: no text");
  return o.text.trim();
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
  for (const r of tx.data || []) if (r.key !== "seat" && r.it && r.it !== r.en_src) jobs.push({ table: "audit_texts", match: { visit_id: visitId, key: r.key }, it: r.it, enCol: "en", srcCol: "en_src" });
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

// The catalog changes rarely: one fetch serves every save for a minute (a new question can take up to 60 s to be accepted).
let CAT_CACHE: { at: number; rows: Row[] } | null = null;
async function catRow(code: string, kind: string) {
  for (let pass = 0; pass < 2; pass++) {
    if (!CAT_CACHE || pass === 1 || Date.now() - CAT_CACHE.at > 60000) {
      const { data } = await sb.from("audit_catalog").select("code,qtype,kinds");
      CAT_CACHE = { at: Date.now(), rows: data || [] };
    }
    const r = CAT_CACHE.rows.find((x: Row) => x.code === code && (x.kinds || []).includes(kind));
    if (r) return r;
  }
  return null;
}

async function dishList() {
  const { data: subs } = await sb.from("menus").select("id,parent_id,name").in("parent_id", MENUS).eq("archived", false);
  const scala = new Set([SCALA_MENU, ...(subs || []).filter((m) => m.parent_id === SCALA_MENU).map((m) => m.id)]);
  const ids = [...MENUS, ...(subs || []).map((m) => m.id)];
  const { data: rm } = await sb.from("recipe_menus").select("recipe_id,menu_id").in("menu_id", ids);
  // A recipe the kitchen filed under a "Condiments and extras" section is not a dish a guest orders
  // (Almond Pizzicotti, the coffee biscuit, showed under Dessert — Antonio, 23 Oct 2026).
  const extraMenus = new Set((subs || []).filter((m) => /condiment|extra/i.test(m.name || "")).map((m) => m.id));
  const extras = new Set((rm || []).filter((r) => extraMenus.has(r.menu_id)).map((r) => r.recipe_id));
  const rids = [...new Set((rm || []).map((r) => r.recipe_id))].filter((id) => !extras.has(id));
  if (!rids.length) return [];
  const { data: rec } = await sb.from("recipes").select("id,name,archived,section").in("id", rids);
  const place: Record<string, string> = {};
  for (const r of rm || []) place[r.recipe_id] = scala.has(r.menu_id) ? "scala" : (place[r.recipe_id] || "ristorante");
  // Each dish carries its menu section, so a guest can open the menu by section and pick what they
  // ordered without remembering the name (Francesco, 22 Oct 2026). Sections in menu order.
  const rank = (x: string) => { const i = MENU_SECTIONS.indexOf(x); return i < 0 ? 99 : i; };
  return (rec || []).filter((r) => !r.archived && r.name).map((r) => ({ id: r.id, name: String(r.name).trim(), where: place[r.id], section: r.section || "Other" }))
    .sort((a, b) => rank(a.section) - rank(b.section) || a.name.localeCompare(b.name));
}

async function previousVisit(v: Row) {
  const { data } = await sb.from("audit_visits").select("id,title,visit_date,overall_pct,area_pct,status,created_at")
    .in("status", ["submitted", "sent"]).eq("auditor", v.auditor).eq("kind", kindOf(v.kind)).is("removed_at", null).neq("id", v.id);
    // Same auditor, same kind of audit, under the new standard only. Nov 2022 is never compared
    // (Francesco, 22 Oct 2026: "different restaurant, different standard, we start a new one").
  const list = (data || []).filter((p) => !v.visit_date || !p.visit_date || p.visit_date < v.visit_date)
    .sort((a, b) => String(b.visit_date || "0000").localeCompare(String(a.visit_date || "0000")) || String(b.created_at).localeCompare(String(a.created_at)));
  const p = list[0]; if (!p) return null;
  const { data: sc } = await sb.from("audit_scores").select("code,score,na,note_it,note_en").eq("visit_id", p.id);
  return { title: p.title, overall_pct: p.overall_pct, area_pct: p.area_pct || {}, scores: sc || [] };
}

// The questions for this visit's kind. A page older than pv 2 only draws the original sections.
function catalogFor(kind: string, pv: number) {
  let q = sb.from("audit_catalog").select("*").eq("active", true).contains("kinds", [kindOf(kind)]);
  if (pv < 2) q = q.not("area", "in", "(" + NEW_AREAS.join(",") + ")");
  return q.order("area").order("position");
}
async function loadAll(v: Row, admin: boolean, pv = 2, pageQset?: number) {
  const qset = pageQset != null && pageQset < 2 ? 1 : Number(v.qset) || 2;
  const [cat, sc, di, fl, tx, prev, dishes] = await Promise.all([
    catalogFor(v.kind, pv),
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
  // A question belongs to some sets only; one it replaced stays for a visit that already answered it.
  const answered = new Set((sc.data || []).filter((r: Row) => r.na || r.score != null).map((r: Row) => r.code));
  if (cat.data) cat.data = cat.data.filter((c: Row) => (Number(c.since_qset) || 1) <= qset && (!c.until_qset || qset < Number(c.until_qset) || answered.has(c.code)));
  // Scala: a guest at the bar counter gets the counter wording (label_bar_*), at a lounge table the usual one.
  const seat = ((tx.data || []).find((r: Row) => r.key === "seat") || {}).it;
  if (qset >= 2 && seat === "bar" && cat.data) cat.data = cat.data.map((c: Row) => c.label_bar_en ? { ...c, label_en: c.label_bar_en, label_it: c.label_bar_it || c.label_it, hint_en: c.hint_bar_en ?? c.hint_en, hint_it: c.hint_bar_it ?? c.hint_it } : c);
  const areaList = AREA_ORDER[kindOf(v.kind)].filter((a) => (cat.data || []).some((c: Row) => c.area === a));
  const p = pcts(sc.data || [], cat.data || [], dishItems(kindOf(v.kind), qset, di.data || []));
  return {
    role: admin ? "admin" : "enrico", kind: kindOf(v.kind), areas: areaList, area_en: Object.fromEntries(areaList.map((a) => [a, areaEn(kindOf(v.kind), a)])),
    visit: { id: v.id, title: v.title, kind: kindOf(v.kind), sender_name: v.sender_name, visit_date: v.visit_date, visit_time: v.visit_time, auditor: v.auditor, created_at: v.created_at, status: v.status, submitted_at: v.submitted_at, sent_at: v.sent_at, sent_to: v.sent_to, enrico_token: admin ? v.enrico_token : undefined },
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

// Trend against the last visit, like for like: only items scored (not N/A) in BOTH visits.
function like(scores: Row[], prevScores: Row[], catalog: Row[], area?: string) {
  const old: Record<string, number> = {};
  for (const p of prevScores || []) if (has(p)) old[p.code] = p.score;
  const inArea = new Set(catalog.filter((c) => !area || c.area === area).map((c) => c.code));
  let a = 0, b = 0, n = 0;
  for (const s of scores) if (inArea.has(s.code) && has(s) && old[s.code] != null) { a += s.score; b += old[s.code]; n++; }
  if (!n) return null;
  const now = Math.round((a / (5 * n)) * 100), then = Math.round((b / (5 * n)) * 100);
  return { diff: now - then, n };
}
const signed = (x: number) => (x > 0 ? "+" : "") + x;

// The report (22 Oct 2026, redesigned to the mock-up Francesco approved): one big score, a bar per
// section against the 85% target (Roberto's 3.0), what needs attention, what went well, the dishes,
// then every answer. The same HTML is the email Amin gets and the report in the FOH Audits module.
// Email clients ignore web fonts, so the type falls back to Georgia / Arial there.
const TARGET = 85;
const LOGO = "https://robertos-leadership.github.io/robertos-foh/robertos-logo-email.png";
const B = { wine: "#450207", ink: "#3A332C", muted: "#6E5A4C", line: "#D8C4AC", soft: "#EFE4D6", paper: "#FBF7F1", ok: "#2F6B2F", okbar: "#4C8A3F", low: "#B23A00", lowbar: "#FA4700" };
const DISPLAY = "Forum,Georgia,'Times New Roman',serif", SANS = "Outfit,Arial,Helvetica,sans-serif";
const KIND_TITLE: Record<string, string> = { venue: "Chef's audit · Whole venue", restaurant: "Guest audit · The restaurant", scala: "Guest audit · Scala, bar & lounge" };

function answerText(c: Row, s: Row) {
  if (!s || (s.score == null && !s.na)) return "—";
  if (s.na) return "Didn't see";
  if (c.qtype === "standard") return s.score > 0 ? "Yes" : "No";
  return s.score + " / 5";
}

function emailHtml(d: Row, urls: Record<string, string>) {
  const kind = kindOf(d.visit.kind), enrico = d.visit.auditor === ENRICO;
  const cat: Record<string, Row> = {}; for (const c of d.catalog) cat[c.code] = c;
  const byCode: Record<string, Row> = {}; for (const s of d.scores) byCode[s.code] = s;
  const t: Record<string, Row> = {}; for (const x of d.texts) t[x.key] = x;
  const areas = AREA_ORDER[kind].filter((a) => d.catalog.some((c: Row) => c.area === a));
  const pa = d.pct.area;
  let answered = 0, notSeen = 0;
  for (const c of d.catalog) { const s = byCode[c.code]; if (s && s.na) notSeen++; else if (has(s)) answered++; }
  const para = (s: string) => `<div style="font:15px/1.55 ${SANS};color:${B.ink};white-space:pre-line">${esc(s)}</div>`;
  const head = (s: string) => `<div style="font:600 13px ${SANS};color:${B.wine};margin:0 0 10px">${esc(s)}</div>`;
  const block = (inner: string) => `<div style="padding:20px 24px;border-bottom:1px solid ${B.line}">${inner}</div>`;
  const card = (inner: string) => `<div style="background:#ffffff;border:1px solid ${B.line};border-radius:12px;padding:12px 14px;margin:0 0 10px">${inner}</div>`;
  const whenTxt = [fmtDate(d.visit.visit_date), d.visit.visit_time].filter(Boolean).join(", ");
  const by = enrico ? "" : (d.visit.sender_name ? " · sent by " + d.visit.sender_name : "");
  const seatTxt = ({ bar: " · at the bar counter", lounge: " · at a lounge table" } as Record<string, string>)[(t.seat && t.seat.it) || ""] || "";

  let h = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<link href="https://fonts.googleapis.com/css2?family=Forum&family=Outfit:wght@400;500;600&display=swap" rel="stylesheet"></head>` +
    `<body style="margin:0;background:${B.paper}"><div style="max-width:640px;margin:0 auto;background:${B.paper};font-family:${SANS};color:${B.ink}">`;

  // Header: logo, who, when, the score
  h += `<div style="padding:26px 24px 22px;border-bottom:1px solid ${B.line}">` +
    `<img src="${LOGO}" alt="Roberto's" width="190" style="display:block;width:190px;height:auto;border:0;margin:0 0 18px">` +
    `<div style="font:500 12px ${SANS};letter-spacing:1.6px;text-transform:uppercase;color:${B.muted}">${esc(KIND_TITLE[kind])}</div>` +
    `<div style="font:400 34px/1.1 ${DISPLAY};color:${B.wine};margin:4px 0 4px">${esc(d.visit.auditor)}</div>` +
    `<div style="font:14px ${SANS};color:${B.muted}">${esc(whenTxt)}${esc(seatTxt)}${esc(by)}</div>` +
    `<table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:16px"><tr>` +
    `<td style="font:400 64px/0.9 ${DISPLAY};color:${d.pct.overall != null && d.pct.overall >= TARGET ? B.ok : B.wine};padding-right:16px;vertical-align:bottom">${d.pct.overall ?? "—"}${d.pct.overall != null ? "%" : ""}</td>` +
    `<td style="font:14px/1.5 ${SANS};color:${B.muted};vertical-align:bottom;padding-bottom:4px">${answered} of ${d.catalog.length} answered<br>${notSeen} not seen · target ${TARGET}%</td></tr></table></div>`;

  // By section
  let rows = "";
  for (const a of areas) {
    const v = pa[a] ?? null, good = v != null && v >= TARGET;
    rows += `<tr><td style="padding:6px 10px 6px 0;font:14px ${SANS};color:${B.ink};white-space:nowrap">${esc(areaEn(kind, a))}</td>` +
      `<td style="padding:6px 0;width:100%"><div style="height:8px;border-radius:4px;background:${B.soft}">${v == null ? "" : `<div style="width:${Math.max(2, v)}%;height:8px;border-radius:4px;background:${good ? B.okbar : B.lowbar}"></div>`}</div></td>` +
      `<td style="padding:6px 0 6px 10px;font:600 14px ${SANS};text-align:right;white-space:nowrap;color:${v == null ? B.muted : good ? B.ok : B.low}">${v == null ? "not seen" : v + "%"}</td></tr>`;
  }
  h += block(head("By section") + `<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${rows}</table>` +
    `<div style="font:12.5px ${SANS};color:${B.muted};margin-top:8px">Green at ${TARGET}% and above, orange below.</div>`);

  // Needs attention: a No, a quality score of 1-2, a dish of 1-2, Enrico's to fix / urgent, a photo flag
  type A = { lvl: number; what: string; where: string; ans: string; note: string; photos: string[]; owner: string; due: string };
  const acts: A[] = [];
  for (const c of d.catalog) {
    const s = byCode[c.code]; if (!s) continue;
    const low = has(s) && (c.qtype === "standard" ? s.score === 0 : s.score <= 2);
    if (low || s.verdict === "fix" || s.verdict === "urgent")
      acts.push({ lvl: s.verdict === "urgent" ? 0 : 1, what: c.label_en, where: areaEn(kind, c.area), ans: s.verdict === "urgent" ? "Urgent" : answerText(c, s), note: en(s), photos: s.photos || [], owner: s.owner || "", due: dueTxt(s.due) });
  }
  for (const x of d.dishes) if ((x.score != null && x.score <= 2) || x.verdict === "fix" || x.verdict === "remove")
    acts.push({ lvl: x.verdict === "remove" ? 0 : 1, what: x.dish_name, where: "Dish", ans: x.verdict === "remove" ? "Take off" : (x.score != null ? x.score + " / 5" : "To fix"), note: en(x), photos: x.photos || [], owner: x.owner || "", due: dueTxt(x.due) });
  for (const f of d.flags) if (f.kind === "attention")
    acts.push({ lvl: 1, what: f.dish_name || "Photo note", where: areaEn(kind, f.area) || "", ans: "Flag", note: en(f), photos: f.photos || [], owner: f.owner || "", due: dueTxt(f.due) });
  acts.sort((a, b) => a.lvl - b.lvl);
  h += block(head("Needs attention · " + acts.length) + (acts.length ? acts.map((a) => card(
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="font:400 18px ${DISPLAY};color:${B.wine}">${esc(a.what)}</td>` +
    `<td style="font:600 13px ${SANS};color:${B.low};text-align:right;white-space:nowrap;vertical-align:top">${esc(a.ans)}</td></tr></table>` +
    `<div style="font:12.5px ${SANS};color:${B.muted};margin-top:2px">${esc(a.where)}${a.owner ? " · " + esc(a.owner) : ""}${a.due ? " · by " + esc(a.due) : ""}</div>` +
    (a.note ? `<div style="font:14px/1.45 ${SANS};margin-top:6px;white-space:pre-line">${esc(a.note)}</div>` : "") + pics(a.photos, urls))).join("")
    : `<div style="font:14px ${SANS};color:${B.muted}">Nothing below standard.</div>`));

  // In their words
  const words: [string, string][] = enrico
    ? [["Overall visit", "overall"], ["Suggested improvements", "improve"]]
    : [["The best moment", "best"], ["One thing to fix", "fixone"], ["Anything else", "other"]];
  let said = "";
  for (const [label, k] of words) if (t[k] && en(t[k], "it", "en")) said += `<div style="margin:0 0 14px"><div style="font:500 12px ${SANS};color:${B.muted};margin-bottom:4px">${esc(label)}</div>${para(en(t[k], "it", "en"))}${pics(t[k].photos, urls)}</div>`;
  if (enrico) {
    const tops = ["p1", "p2", "p3"].map((k) => t[k] ? en(t[k], "it", "en") : "").filter(Boolean);
    if (tops.length) said += `<div style="font:500 12px ${SANS};color:${B.muted};margin-bottom:4px">${esc(firstName(d.visit.auditor))}'s top 3</div>` + tops.map((s, i) => `<div style="font:15px/1.5 ${SANS};margin:3px 0"><b style="color:${B.wine}">${i + 1}</b>&nbsp; ${esc(s)}</div>`).join("");
  }
  if (said) h += block(head(enrico ? "In Enrico's words" : "In " + firstName(d.visit.auditor) + "'s words") + said);
  // Feedback on the audit form itself (shared link only): kept apart from the visit, never scored.
  if (!enrico && t.formfb && en(t.formfb, "it", "en")) h += block(head("Feedback on the audit form") + para(en(t.formfb, "it", "en")));

  // What went well: every 5 / 5 and every "keep" photo flag
  const wells: string[] = [];
  for (const c of d.catalog) { const s = byCode[c.code]; if (has(s) && c.qtype !== "standard" && s.score === 5) wells.push(c.label_en + (en(s) ? " — " + en(s) : "")); }
  for (const f of d.flags) if (f.kind === "keep") wells.push((f.dish_name || "Photo") + (en(f) ? " — " + en(f) : ""));
  if (wells.length) h += block(head("What went well") + wells.map((w) => `<div style="font:14px/1.5 ${SANS};margin:0 0 6px">${esc(w)}</div>`).join(""));

  // Dishes
  if (d.dishes.length) h += block(head("Dishes tasted · " + d.dishes.length) + d.dishes.map((x: Row) =>
    `<div style="padding:9px 0;border-bottom:1px solid ${B.soft}"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="font:14px ${SANS}">${esc(x.dish_name)}</td>` +
    `<td style="font:600 14px ${SANS};text-align:right;white-space:nowrap">${x.score != null ? x.score + " / 5" : "—"}</td></tr></table>` +
    (en(x) ? `<div style="font:13.5px/1.45 ${SANS};color:${B.muted};margin-top:3px;white-space:pre-line">${esc(en(x))}</div>` : "") + pics(x.photos, urls) + `</div>`).join(""));

  // Every answer
  let all = "";
  for (const a of areas) {
    all += `<div style="font:400 19px ${DISPLAY};color:${B.wine};margin:16px 0 4px">${esc(areaEn(kind, a))}${pa[a] != null ? ` <span style="font:13px ${SANS};color:${B.muted}">${pa[a]}%</span>` : ""}</div>`;
    for (const c of d.catalog.filter((x: Row) => x.area === a).sort((x: Row, y: Row) => x.position - y.position)) {
      const s = byCode[c.code] || {};
      all += `<div style="padding:8px 0;border-bottom:1px solid ${B.soft}"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>` +
        `<td style="font:14px ${SANS};color:${B.ink}">${esc(c.label_en)}</td><td style="font:600 14px ${SANS};text-align:right;white-space:nowrap;padding-left:10px">${esc(answerText(c, s))}</td></tr></table>` +
        (en(s) ? `<div style="font:13px/1.45 ${SANS};color:${B.muted};margin-top:3px;white-space:pre-line">${esc(en(s))}</div>` : "") + pics(s.photos, urls) + `</div>`;
    }
  }
  h += `<div style="padding:20px 24px">${head("Every answer")}${all}` +
    `<div style="font:12px/1.5 ${SANS};color:${B.muted};margin-top:22px">A standard counts 100% for Yes and 0% for No; a quality score of 1 to 5 counts 20% to 100%. "Didn't see" is left out. Notes are shown in English; the original is kept in the FOH app.</div></div>`;
  return h + `</div></body></html>`;
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

// ── FOH Audits module ─────────────────────────────────────────────────────────────────
// Who is asking, from their FOH login. The ticks live in FOH app_users.modules; nothing here
// trusts the page. 'audit_read' includes sending.
async function fohWho(jwt: string) {
  if (!foh) throw new Error("The FOH link is not set up (FOH_SERVICE_KEY)");
  const { data, error } = await foh.auth.getUser(jwt);
  const email = String(data?.user?.email || "").toLowerCase();
  if (error || !email) return null;
  const { data: u } = await foh.from("app_users").select("name,modules,is_admin").eq("email", email).maybeSingle();
  const mods: string[] = (u && u.modules) || [];
  const read = !!(u && u.is_admin) || mods.includes("audit_read");
  return { email, name: (u && u.name) || email.split("@")[0], read, send: read || mods.includes("audit_send"), admin: !!(u && u.is_admin) };
}

// The sender's own invite: made the first time they open the module.
async function senderLink(who: { email: string; name: string }, fresh: boolean) {
  const { data: cur } = await sb.from("audit_visits").select("id,enrico_token").eq("status", "invite").eq("sender_email", who.email)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (cur && !fresh) return cur.enrico_token;
  if (cur) await sb.from("audit_visits").update({ status: "invite_off", updated_at: new Date().toISOString() }).eq("id", cur.id);
  const { data: nv, error } = await sb.from("audit_visits").insert({
    title: "Audit link · " + who.name, auditor: "Shared link", status: "invite",
    enrico_token: newToken(), admin_token: newToken(), sender_email: who.email, sender_name: who.name,
  }).select("enrico_token").single();
  if (error) throw error;
  return nv.enrico_token;
}

async function fohCall(b: Row, action: string) {
  const who = await fohWho(String(b.foh));
  if (!who) return json({ error: "Please sign in to the FOH app again." }, 401);
  if (!who.send) return json({ error: "No access to Audits. Ask an Admin." }, 403);

  if (action === "me" || action === "new_link") {
    const token = await senderLink(who, action === "new_link");
    return json({ name: who.name, send: who.send, read: who.read, admin: who.admin, link: pageFor(b.page) + "?n=" + token });
  }
  if (!who.read) return json({ error: "Not allowed" }, 403);

  // list: every audit still in use. removed: (Admin) the ones taken out, with who, when and why.
  if (action === "list" || action === "removed") {
    if (action === "removed" && !who.admin) return json({ error: "Admins only" }, 403);
    const { data: inv } = await sb.from("audit_visits").select("id,sender_name").in("status", ["invite", "invite_off"]);
    const by: Record<string, string> = {}; for (const i of inv || []) by["invite:" + i.id] = i.sender_name || "Shared link";
    let q = sb.from("audit_visits")
      .select("id,title,kind,auditor,visit_date,visit_time,created_at,updated_at,status,overall_pct,submitted_at,source_note,sender_name,removed_at,removed_by,removed_reason");
    q = action === "removed" ? q.in("status", [...LISTED, "archived"]).not("removed_at", "is", null) : q.in("status", LISTED).is("removed_at", null);
    const { data: list, error } = await q.order("created_at", { ascending: false }).limit(500);
    if (error) throw error;
    const ids = (list || []).map((x) => x.id);
    const done: Record<string, number> = {};
    for (let i = 0; i < ids.length; i += 200) {
      const { data: sc } = await sb.from("audit_scores").select("visit_id,score,na").in("visit_id", ids.slice(i, i + 200));
      for (const s of sc || []) if (s.score != null || s.na) done[s.visit_id] = (done[s.visit_id] || 0) + 1;
    }
    // How many questions each kind has (the "x of N" on each row).
    const { data: cat } = await sb.from("audit_catalog").select("kinds").eq("active", true);
    const totals: Record<string, number> = {};
    for (const k of KINDS) totals[k] = (cat || []).filter((c) => (c.kinds || []).includes(k)).length;
    return json({ totals, kinds: KIND_EN, audits: (list || []).map((x) => ({
      id: x.id, title: x.title, kind: kindOf(x.kind), auditor: x.auditor, visit_date: x.visit_date, visit_time: x.visit_time,
      created_at: x.created_at, updated_at: x.updated_at, status: x.status, overall_pct: x.overall_pct, submitted_at: x.submitted_at,
      done: done[x.id] || 0, total: totals[kindOf(x.kind)] || 0,
      sent_by: x.auditor === ENRICO ? "Chef Bartolini's own link" : (x.sender_name || by[x.source_note || ""] || "Shared link"),
      removed_at: x.removed_at, removed_by: x.removed_by, removed_reason: x.removed_reason,
    })) });
  }

  // Remove / put back (Admin only). Nothing is deleted: the audit leaves the list and the chart,
  // and is kept with who removed it, when and why.
  if (action === "remove" || action === "restore") {
    if (!who.admin) return json({ error: "Admins only" }, 403);
    const id = String(b.id || "");
    const reason = clean(b.reason, 300);
    if (action === "remove" && !reason) return json({ error: "Give a reason" }, 400);
    const f: Row = action === "remove"
      ? { removed_at: new Date().toISOString(), removed_by: who.email, removed_reason: reason }
      : { removed_at: null, removed_by: null, removed_reason: null };
    const { data, error } = await sb.from("audit_visits").update(f).eq("id", id).in("status", [...LISTED, "archived"]).select("id,removed_at").maybeSingle();
    if (error) throw error;
    if (!data) return json({ error: "Not found" }, 404);
    return json({ ok: true, row: data });
  }

  // Delete for good (Admin only): only audits already removed, never the archived Nov 2022 record. Scores, dishes, notes, mail log
  // and tidy log go with the visit (FK cascade); the photos are deleted from storage first.
  if (action === "purge") {
    if (!who.admin) return json({ error: "Admins only" }, 403);
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(String).filter(Boolean))].slice(0, 500);
    if (!ids.length) return json({ error: "Nothing chosen" }, 400);
    const { data: rows, error } = await sb.from("audit_visits").select("id").in("id", ids)
      .in("status", LISTED).not("removed_at", "is", null);
    if (error) throw error;
    const ok = (rows || []).map((r) => r.id);
    if (!ok.length) return json({ ok: true, deleted: 0 });
    const paths: string[] = [];
    for (const t of ["audit_scores", "audit_dishes", "audit_flags", "audit_texts"]) {
      const { data: ph } = await sb.from(t).select("photos").in("visit_id", ok);
      for (const r of ph || []) for (const p of r.photos || []) if (p) paths.push(p);
    }
    const uniq = [...new Set(paths)];
    for (let i = 0; i < uniq.length; i += 100) await sb.storage.from(BUCKET).remove(uniq.slice(i, i + 100));
    const { error: de } = await sb.from("audit_visits").delete().in("id", ok).in("status", LISTED).not("removed_at", "is", null);
    if (de) throw de;
    console.log("audit purge", who.email, ok.length, ok.join(","));
    return json({ ok: true, deleted: ok.length });
  }

  if (action === "report") {
    const { data: v } = await sb.from("audit_visits").select("*").eq("id", String(b.id || "")).in("status", [...LISTED, "archived"]).maybeSingle();
    if (!v || (v.removed_at && !who.admin) || (v.status === "archived" && !who.admin)) return json({ error: "Not found" }, 404);
    await translatePending(v.id, v.auditor).catch((e) => console.error(e));   // English for the reader; the Italian stays
    const d = await loadAll(v, true);
    const all: string[] = [];
    for (const r of [...d.scores, ...d.dishes, ...d.flags, ...d.texts]) for (const p of r.photos || []) all.push(p);
    return json({ html: emailHtml(d, await signAll(all, 60 * 60 * 24)), pct: d.pct });
  }
  return json({ error: "Unknown action" }, 400);
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

  // ── the FOH Audits module ──
  if (typeof b.foh === "string") {
    try { return await fohCall(b, action); }
    catch (e) { console.error(e); return json({ error: String((e as Error)?.message || e) }, 500); }
  }

  // ── the shared link ──
  if (typeof b.n === "string") {
    if (b.n.length < 20) return json({ error: "Link not valid" }, 403);
    const { data: inv } = await sb.from("audit_visits").select("id,title,status,sender_name,sender_email").eq("enrico_token", b.n).in("status", ["invite", "invite_off"]).maybeSingle();
    if (!inv) return json({ error: "Link not valid" }, 403);
    if (inv.status === "invite_off") return json({ error: "This link has been replaced. Ask for a new one." }, 403);
    if (action === "load") return json({ role: "invite", title: inv.title });
    if (action !== "start") return json({ error: "Not allowed" }, 403);
    const name = clean(b.name, 60);
    if (!name || name.length < 2) return json({ error: "Name needed" }, 400);
    // Where they went: a shared link is a Restaurant or a Scala visit, chosen at the start.
    // (Only an older page sends no kind; it gets the whole-venue form, as before.)
    const kind = b.kind == null ? "venue" : String(b.kind);
    if (!["restaurant", "scala", "venue"].includes(kind) || (b.kind != null && kind === "venue")) return json({ error: "Choose Restaurant or Scala" }, 400);
    // A shared link can be forwarded: cap how many audits it can start in a day.
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { count } = await sb.from("audit_visits").select("id", { count: "exact", head: true }).eq("source_note", "invite:" + inv.id).gte("created_at", since);
    if ((count || 0) >= 40) return json({ error: "Too many audits started from this link today. Ask the person who sent it." }, 429);
    // The date and time of the visit are typed (the auditor may be a guest writing it up later);
    // an older page that sends neither gets "now", as before. No future date, nothing over 90 days old.
    const now = dubaiNow();
    let date = now.date, time = now.time;
    if (b.visit_date != null || b.visit_time != null) {
      if (!isDate(b.visit_date) || !isTime(b.visit_time)) return json({ error: "Date and time of the visit needed" }, 400);
      const oldest = new Date(Date.now() + 4 * 3600 * 1000 - 90 * 86400 * 1000).toISOString().slice(0, 10);
      if (b.visit_date > now.date || b.visit_date < oldest) return json({ error: "Check the date of the visit" }, 400);
      date = b.visit_date; time = b.visit_time;
    }
    const { data: nv, error } = await sb.from("audit_visits").insert({
      title: `${name} · ${date.split("-").reverse().join("/")} ${time}`, auditor: name, visit_date: date, visit_time: time, kind,
      status: "open", enrico_token: newToken(), admin_token: newToken(), source_note: "invite:" + inv.id, qset: Number(b.qset) >= 4 ? 4 : Number(b.qset) >= 3 ? 3 : 2,
      sender_name: inv.sender_name, sender_email: inv.sender_email,
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
    for (const s of sc || []) if (s.score != null || s.na) done[s.visit_id] = (done[s.visit_id] || 0) + 1;
    const { count: total } = await sb.from("audit_catalog").select("code", { count: "exact", head: true }).eq("active", true);
    return json({ role: "invite_admin", title: v.title, invite_token: v.enrico_token, total: total || 0,
      audits: (list || []).map((x) => ({ ...x, done: done[x.id] || 0 })) });
  }

  try {
    if (action === "load") return json(await loadAll(v, admin, Number(b.pv) || 1, Number(b.qset) || 1));

    // Enrico cannot change anything once the report has gone to Amin.
    if (!admin && v.status === "sent") return json({ error: v.auditor === ENRICO ? "Questo audit è già stato inviato. Grazie!" : "This audit has already been sent. Thank you!" }, 409);
    const touch = () => sb.from("audit_visits").update({ updated_at: new Date().toISOString() }).eq("id", v.id);
    // The "updated" mark is written after the reply has gone out: a save was making four database calls one after
    // another (~2-3 s from Dubai to the Sydney database); the guest only needs the answer written (23 Oct 2026).
    // deno-lint-ignore no-explicit-any
    const touchSoon = () => { const t = touch().then(() => {}, () => {}); const ER = (globalThis as any).EdgeRuntime; if (ER && ER.waitUntil) ER.waitUntil(t); };

    if (action === "score") {
      const code = String(b.code || "");
      const c = await catRow(code, kindOf(v.kind));
      if (!c) return json({ error: "Unknown item" }, 400);
      const f: Row = { visit_id: v.id, code, updated_at: new Date().toISOString() };
      if ("score" in b) f.score = b.score == null ? null
        : c.qtype === "standard" && Number(b.pv) >= 3 ? (Number(b.score) > 0 ? 5 : 0)   // Yes = 5, No = 0
        : Math.max(1, Math.min(5, Math.round(Number(b.score))));
      if ("na" in b) { f.na = !!b.na; if (f.na) f.score = null; }
      if ("score" in b && f.score != null) f.na = false;
      if ("verdict" in b) f.verdict = VERDICT_SCORE.includes(b.verdict) ? b.verdict : null;
      if ("note_it" in b) f.note_it = clean(b.note_it);
      const { data, error } = await sb.from("audit_scores").upsert(f, { onConflict: "visit_id,code" }).select().single();
      if (error) throw error;
      touchSoon();
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
      touchSoon();
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
      touchSoon();
      return json({ row: res.data });
    }

    if (action === "tidy") {
      const raw = clean(b.text, 2000);
      if (!raw) return json({ text: "" });
      if (!ANTHROPIC_API_KEY) return json({ text: raw, same: true });
      const kind = kindOf(v.kind), tgt = String(b.target || ""), ref = String(b.ref || "");
      // The three lookups run side by side: one after another they doubled the wait after Stop (~5 s).
      const [ctx, st, dl] = await Promise.all([
        tgt === "score" ? sb.from("audit_catalog").select("area,label_en,hint_en").eq("code", ref).maybeSingle()
          : tgt === "dish" || tgt === "flag" ? sb.from(tgt === "dish" ? "audit_dishes" : "audit_flags").select("dish_name").eq("id", ref).eq("visit_id", v.id).maybeSingle()
          : Promise.resolve({ data: null }),
        sb.from("audit_texts").select("it").eq("visit_id", v.id).eq("key", "seat").maybeSingle(),
        menuCached(),
      ]);
      const c = ctx.data as Row | null;
      let about = "a point of the visit";
      if (tgt === "score" && c) about = `the question "${c.label_en}"${c.hint_en ? " (" + c.hint_en + ")" : ""}, in the section "${areaEn(kind, c.area)}"`;
      else if (tgt === "dish" || tgt === "flag") about = c && c.dish_name ? `the dish "${c.dish_name}"` : tgt === "flag" ? "something in a photo" : "a dish";
      else if (tgt === "text") about = TEXT_ABOUT[ref] || about;
      const visit = KIND_EN[kind] + (st.data && st.data.it === "bar" ? ", sitting at the bar counter" : st.data && st.data.it === "lounge" ? ", at a lounge table" : "");
      const where = kind === "scala" ? "scala" : "ristorante";
      const menu = dl.filter((m: Row) => kind === "venue" || m.where === where).map((m: Row) => m.name).slice(0, 300);
      const sys = tidySystem(b.lang === "it" ? "Italian" : "English", about, visit, menu);
      let out: string, model = "claude-haiku-5-5";
      const t0 = Date.now();
      try { out = await tidyCall(model, raw, sys); }
      catch (_e) { model = "claude-sonnet-5-5"; out = await tidyCall(model, raw, sys); }
      // A clean-up is never longer than what was said, beyond punctuation: anything longer is refused.
      if (out.length > raw.length * 1.3 + 20) out = raw;
      // The log is written after the reply goes out, so the guest never waits for it.
      const log = sb.from("audit_tidy_log").insert({ visit_id: v.id, target: tgt, ref, lang: b.lang === "it" ? "it" : "en", raw, tidy: out, model, ms: Date.now() - t0 }).then(() => {});
      // deno-lint-ignore no-explicit-any
      const ER = (globalThis as any).EdgeRuntime;
      if (ER && ER.waitUntil) ER.waitUntil(log); else await log;
      return json({ text: out, ms: Date.now() - t0 });
    }

    if (action === "text") {
      const key = String(b.key || "");
      // Enrico: overall, improvements, top 3. A guest: the best moment, one thing to fix, anything else,
      // and (optional) feedback on the audit form itself, for the people who look after it.
      if (!["overall", "improve", "p1", "p2", "p3", "best", "fixone", "other", "formfb", "seat"].includes(key)) return json({ error: "bad key" }, 400);
      if (key === "seat" && !["bar", "lounge", ""].includes(String(b.it || ""))) return json({ error: "bad seat" }, 400);
      const { data, error } = await sb.from("audit_texts").upsert({ visit_id: v.id, key, it: clean(b.it), updated_at: new Date().toISOString() }, { onConflict: "visit_id,key" }).select().single();
      if (error) throw error;
      touchSoon();
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
      touchSoon();
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
      const { data: dsh } = await sb.from("audit_dishes").select("score,removed").eq("visit_id", v.id);
      const p = pcts(sc || [], cat || [], dishItems(kindOf(v.kind), Number(v.qset) || 2, dsh || []));
      await sb.from("audit_visits").update({ status: v.status === "sent" || v.status === "test" ? v.status : "submitted", submitted_at: new Date().toISOString(), overall_pct: p.overall, area_pct: p.area, updated_at: new Date().toISOString() }).eq("id", v.id);
      // Anyone else's audit goes to Roberto's management team: it is in the FOH Audits module now, no mail.
      if (v.auditor !== ENRICO) return json({ ok: true, translated: n, pct: p });
      // Enrico: tell Francesco it is ready. This mail goes only to him, so it carries his report link.
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
