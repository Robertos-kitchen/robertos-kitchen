// ════════════════════════════════════════════════════════════
// COSEC-SYNC — Supabase Edge Function
// Pulls daily attendance from the Matrix COSEC API (face recognition
// terminals) and upserts first-in / last-out per employee into the
// `attendance` table. Credentials live in function secrets, never
// in the app or this repo.
//
// Deploy name: cosec-sync
// Secrets required (Edge Functions → cosec-sync → Secrets):
//   COSEC_URL   = http://skelmore.fortiddns.com:8000/cosec/api.svc/v2/attendance-daily?action=get
//   COSEC_USER  = <api username>
//   COSEC_PASS  = <api password>
//
// Call patterns:
//   POST /functions/v1/cosec-sync                 → throttled sync (skips if <5 min since last)
//   POST /functions/v1/cosec-sync?force=1         → sync now
//   POST /functions/v1/cosec-sync?debug=1         → sync now + return raw COSEC response (first 4000 chars)
// ════════════════════════════════════════════════════════════

import { createClient } from "jsr:@supabase/supabase-js@2";

const THROTTLE_MS = 5 * 60 * 1000;

function dubaiNow(): Date {
  // Dubai = UTC+4, no DST
  return new Date(Date.now() + 4 * 60 * 60 * 1000);
}
function dubaiToday(): string {
  return dubaiNow().toISOString().substring(0, 10);
}

interface Rec { emp_id: string; att_date: string; first_in: string | null; last_out: string | null; punch_count: number; punches: string[] }

// Pull HH:MM out of a COSEC timestamp like "13/06/2026 14:19:42" -> "14:19"
function timeFromStamp(s: string): string | null {
  if (!s) return null;
  const m = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (!m) return null;
  return m[1].padStart(2, "0") + ":" + m[2];
}

// Normalise a date like "13/06/2026" -> "2026-06-13"
function normDate(s: string): string | null {
  if (!s) return null;
  s = s.trim();
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + "-" + m[2] + "-" + m[3];
  m = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) return m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
  return null;
}

// Parse the COSEC attendance-daily response.
// Known format (Matrix COSEC v2): pipe-delimited, header row:
//   UserID|UserName|ProcessDate|Punch1|Punch2|WorkingShift|LateIn|EarlyOut|Overtime|WorkTime
// Punch1/Punch2 hold full timestamps ("13/06/2026 14:19:42") or are empty.
//
// WORKING-DAY MODEL (Roberto's kitchen + future FOH):
//   The operational day runs 05:00 → 05:00. Shifts can end as late as ~04:00
//   and a fresh shift (FOH event / morning prep) can start the same morning.
//
//   COSEC already files a late exit (e.g. 01:00–04:00) under the day the
//   shift STARTED — confirmed on this device — so we TRUST COSEC's date
//   grouping and never re-date a punch. The 05:00 boundary is used only to
//   ORDER punches within a day so that a small-hours exit (e.g. 02:00) is
//   correctly ranked AFTER an afternoon in-time (14:00), and so a morning
//   re-entry (09:00) on a record that also holds a small-hours exit doesn't
//   get read backwards. Within the day: earliest = clock-in, latest = clock-out.
const DAY_START_HOUR = 5; // 05:00 cutoff

// Rank a HH:MM time on a 05:00→05:00 day so 00:00–04:59 sorts AFTER the evening.
function rankTime(t: string): number {
  const hh = parseInt(t.substring(0, 2), 10);
  const base = hh < DAY_START_HOUR ? hh + 24 : hh;
  return base * 60 + parseInt(t.substring(3, 5), 10);
}

function parseCosec(raw: string): Rec[] {
  const today = dubaiToday();
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (!lines.length) return [];

  // Locate header to map columns (tolerant to column reordering)
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 3); i++) {
    if (/userid/i.test(lines[i]) && /\|/.test(lines[i])) { headerIdx = i; break; }
  }
  let col = { id: 0, name: 1, date: 2, p1: 3, p2: 4 };
  let start = 0;
  if (headerIdx >= 0) {
    const h = lines[headerIdx].split("|").map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, ""));
    const find = (...names: string[]) => h.findIndex((x) => names.includes(x));
    col = {
      id: Math.max(0, find("userid")),
      name: Math.max(1, find("username")),
      date: Math.max(2, find("processdate", "date")),
      p1: Math.max(3, find("punch1", "firstin", "intime")),
      p2: Math.max(4, find("punch2", "lastout", "outtime")),
    };
    start = headerIdx + 1;
  }

  const recs: Rec[] = [];
  for (let i = start; i < lines.length; i++) {
    const c = lines[i].split("|");
    const id = (c[col.id] || "").trim();
    if (!id || !/^\d+$/.test(id)) continue;
    const date = normDate(c[col.date] || "") || today;   // trust COSEC's working-day date
    // Collect whatever punch times this row carries (dedup), then order them
    // on the 05:00→05:00 clock so a small-hours exit ranks after the evening in.
    const times = new Set<string>();
    const t1 = timeFromStamp(c[col.p1] || "");
    const t2 = timeFromStamp(c[col.p2] || "");
    if (t1) times.add(t1);
    if (t2) times.add(t2);
    const punches = Array.from(times).sort((a, b) => rankTime(a) - rankTime(b));
    recs.push({
      emp_id: id,
      att_date: date,
      first_in: punches.length ? punches[0] : null,
      last_out: punches.length > 1 ? punches[punches.length - 1] : null,
      punch_count: punches.length,
      punches,
    });
  }
  return recs;
}

// ── RAW EVENT FEED (event-ta) ──────────────────────────────────
// attendance-daily collapses a day to first-in/last-out, so split shifts lose
// their middle punches. The raw event-ta feed logs EVERY punch:
//   IndexNo|UserID|UserName|EventDateTime|EntryExitType|...
//   1497721|100033|MASTU CHAUDHARY|25/06/2026 05:37:25|0|...
// EntryExitType is unreliable on these face terminals (clock-outs also read 0),
// so we pair punches by ORDER: 1st=in, 2nd=out, 3rd=in, 4th=out.
interface Ev { emp_id: string; hhmm: string; ms: number; corrected?: boolean; device?: string }

// ATTENDANCE-DEVICE FILTER (added 16 Jul 2026)
// event-ta returns EVERY access-control event across the whole Skelmore estate, not
// just clock punches. Devices seen on this server:
//   GF-TA-FACE / BS-TA-FACE  → the real Time & Attendance face terminals ("TA")
//   WINE ROOM, DIFC Office 209 → door locks. Opening the wine room is Jad's JOB; it is
//                                NOT a clock-out. Counting it invented his phantom shifts.
//   KRSH Marina, KRSH Studio, AutoData → other venues entirely
// Only *-TA-FACE punches are attendance. Verified 16 Jul against both rosters: all 46
// staff with an emp_id clock on a TA terminal, so nobody loses attendance to this filter
// (the non-TA-only users are all other venues / office staff we never display).
// Fails OPEN: if the feed ever stops returning device_name we keep every event rather
// than silently zeroing attendance — the dry run reports non_ta_skipped so it stays visible.
const TA_DEVICE_RE = /TA-FACE/i;

// PANEL CLOCK GUARD (added 16 Jul 2026)
// A punch cannot physically happen AFTER the server recorded it. Each event row
// carries both EventDateTime (stamped by the door panel) and IDateTime (stamped
// by the COSEC server when it ingested the event). Healthy panels put IDateTime
// 1-7 seconds after the event. Controllers 21 and 29 stamp EventDateTime exactly
// +90 min — Gulf (UTC+4) read as IST (UTC+5:30) — which lands the event in the
// future relative to its own insertion. That is impossible, so where it happens
// IDateTime is the only trustworthy clock and we use it instead.
//
// Why a tolerance and not an exact test: absorbs ordinary sub-minute jitter.
// Why only ONE direction: a panel that was offline uploads late, which makes
// IDateTime legitimately LATER than the event. That case is left untouched.
//
// NOTE ON FORMATS — they differ, and getting this wrong silently corrupts dates:
//   EventDateTime = dd/mm/yyyy HH:MM:SS
//   IDateTime     = mm/dd/yyyy HH:MM:SS   (US order; per Web API V2.0 manual p.294/297)
const SKEW_TOL_MS = 5 * 60 * 1000;

function parseEventTa(raw: string): Ev[] {
  const evs: Ev[] = [];
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (!lines.length) return evs;

  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 3); i++) {
    if (/userid/i.test(lines[i]) && /\|/.test(lines[i])) { headerIdx = i; break; }
  }
  // idt/dev stay -1 when the feed carries no such column, which disables the
  // panel-clock guard / device filter rather than silently reading column 0.
  let col = { id: 1, dt: 3, idt: -1, dev: -1 };
  let start = 0;
  if (headerIdx >= 0) {
    const h = lines[headerIdx].split("|").map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, ""));
    const find = (...n: string[]) => h.findIndex((x) => n.includes(x));
    col = {
      id: Math.max(0, find("userid")),
      dt: Math.max(0, find("eventdatetime")),
      idt: find("idatetime"),
      dev: find("devicename"),
    };
    start = headerIdx + 1;
  }

  for (let i = start; i < lines.length; i++) {
    const c = lines[i].split("|");
    const id = (c[col.id] || "").trim();
    if (!id || !/^\d+$/.test(id)) continue;
    const dt = (c[col.dt] || "").trim(); // "dd/mm/yyyy HH:MM:SS"
    const m = dt.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!m) continue;
    const [, dd, mm, yyyy, HH, MM, SS] = m;
    let hhmm = HH.padStart(2, "0") + ":" + MM;
    let ms = Date.UTC(+yyyy, +mm - 1, +dd, +HH, +MM, SS ? +SS : 0);
    let corrected = false;

    // Panel clock guard — see SKEW_TOL_MS above.
    if (col.idt >= 0) {
      const idt = (c[col.idt] || "").trim(); // "mm/dd/yyyy HH:MM:SS" — month FIRST
      const im = idt.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
      if (im) {
        const [, iMon, iDay, iYear, iHH, iMM, iSS] = im;
        const ims = Date.UTC(+iYear, +iMon - 1, +iDay, +iHH, +iMM, iSS ? +iSS : 0);
        if (ms - ims > SKEW_TOL_MS) {
          ms = ims;
          hhmm = iHH.padStart(2, "0") + ":" + iMM;
          corrected = true;
        }
      }
    }
    evs.push({ emp_id: id, hhmm, ms, corrected, device: col.dev >= 0 ? (c[col.dev] || "").trim() : undefined });
  }
  return evs;
}

// Turn one person's chronological events into a clean punch list:
// sort by real time, drop double-taps within DEDUP_MS of the kept punch.
//
// Widened 2 min → 5 min on 16 Jul 2026. One ARRIVAL can legitimately hit more than
// one reader — staff walk through several doors on the way in (Jad taps two, 0–4 min
// apart; Asarudeen taps ctrl24 then ctrl29). At 2 min the closer taps merged but a
// 3–4 min walk survived as a second punch, which the schedule then paired as a
// clock-OUT — showing a 4-minute "shift". 5 min covers the walk between doors while
// still leaving a genuine second movement (Jad's real 41-min trip) as its own punch:
// no legitimate in→out pair is under 5 minutes.
const DEDUP_MS = 300 * 1000; // 5 minutes
function punchesFromEvents(list: Ev[]): string[] {
  list.sort((a, b) => a.ms - b.ms);
  const kept: Ev[] = [];
  for (const e of list) {
    const prev = kept[kept.length - 1];
    if (prev && e.ms - prev.ms < DEDUP_MS) continue;
    kept.push(e);
  }
  return kept.map((e) => e.hhmm);
}

// Pair an ordered punch list into [in,out] segments (last in may be open).
function segmentsFromPunches(p: string[]): Array<[string, string | null]> {
  const segs: Array<[string, string | null]> = [];
  for (let i = 0; i < p.length; i += 2) segs.push([p[i], i + 1 < p.length ? p[i + 1] : null]);
  return segs;
}

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const debug = url.searchParams.get("debug") === "1";
  const reqDate = url.searchParams.get("date");      // YYYY-MM-DD: sync a specific past date
  const probe = url.searchParams.get("probe");       // YYYY-MM-DD: try param variants, report which works (no DB write)
  const eventsProbe = url.searchParams.get("events"); // YYYY-MM-DD: read-only probe of the raw events endpoint (no DB write)
  const eventsUser = url.searchParams.get("user");    // with events=: filter the probe to ONE userid and return the FULL rows
                                                      // (event-ta supports userid + field-name — Web API V2.0 manual p.292/294).
                                                      // Answers "what device actually made this punch, and was it even a door?"
  const eventSync = url.searchParams.get("eventsync"); // YYYY-MM-DD: sync a day from the raw event-ta feed (captures splits)
  const dry = url.searchParams.get("dry") === "1";    // with eventsync: compute + return, write nothing
  const replace = url.searchParams.get("replace") === "1"; // with eventsync: REBUILD the day (heals bad punches) instead of merging

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  // Build a COSEC URL for a given date by appending a candidate param.
  // Matrix COSEC variants differ by firmware; these are the common ones.
  function urlForDate(base: string, dateStr: string, variant: string): string {
    const sep = base.includes("?") ? "&" : "?";
    // dateStr is YYYY-MM-DD; COSEC often wants DD/MM/YYYY
    const [y, m, d] = dateStr.split("-");
    const dmy = d + "/" + m + "/" + y;
    const ddmmyyyy = d + m + y;  // COSEC date-range wants DDMMYYYY, no slashes
    switch (variant) {
      // Confirmed working format for this CENTRA server (per Matrix/Niyaz 18Jun26):
      //   ?action=get;date-range=DDMMYYYY-DDMMYYYY;   (semicolons, no slashes)
      case "date-range": return base.split("?")[0] + "?action=get;date-range=" + ddmmyyyy + "-" + ddmmyyyy + ";";
      case "date-dmy":   return base + sep + "date=" + encodeURIComponent(dmy);
      case "date-ymd":   return base + sep + "date=" + dateStr;
      case "from-to-dmy":return base + sep + "from-date=" + encodeURIComponent(dmy) + "&to-date=" + encodeURIComponent(dmy);
      case "fromto-ymd": return base + sep + "fromdate=" + dateStr + "&todate=" + dateStr;
      case "processdate":return base + sep + "process-date=" + encodeURIComponent(dmy);
      default:           return base;
    }
  }

  try {
    const cosecUrl = Deno.env.get("COSEC_URL");
    const user = Deno.env.get("COSEC_USER");
    const pass = Deno.env.get("COSEC_PASS");
    if (!cosecUrl || !user || !pass) {
      return json({ ok: false, error: "Missing COSEC_URL / COSEC_USER / COSEC_PASS secrets" }, 500);
    }
    const auth = { Authorization: "Basic " + btoa(user + ":" + pass) };

    // Fetch the raw event-ta feed for one operational day (05:00 → 05:00 next day)
    // and collapse it to one clean, de-duplicated punch list per employee. This is
    // the COMPLETE source (every punch), so it captures split shifts that the
    // attendance-daily summary (first-in/last-out only) silently dropped.
    async function buildFromEventTa(opDate: string): Promise<{ records: Array<{ emp_id: string; att_date: string; punches: string[] }>; total: number; skewFixed: number; nonTa: number }> {
      const root = cosecUrl!.split("/v2/")[0] + "/v2/";
      const [yy, mm, dd] = opDate.split("-");
      const dmy = dd + mm + yy;
      const nxt = new Date(opDate + "T00:00:00Z");
      nxt.setUTCDate(nxt.getUTCDate() + 1);
      const ndmy = String(nxt.getUTCDate()).padStart(2, "0") +
        String(nxt.getUTCMonth() + 1).padStart(2, "0") + nxt.getUTCFullYear();
      const win = dmy + "050000-" + ndmy + "045959";
      // field-name is REQUIRED here: the server's default API Data Template does NOT
      // include device_name, so without asking we cannot tell a clock from a door lock.
      const u = root + "event-ta?action=get;date-range=" + win +
        ";field-name=indexno,userid,username,eventdatetime,entryexittype,mastercontrollerid,device_name,idatetime;";
      const r = await fetch(u, { headers: auth, signal: AbortSignal.timeout(20000) });
      const rawEv = await r.text();
      if (!r.ok) throw new Error("event-ta HTTP " + r.status + ": " + rawEv.substring(0, 200));
      const all = parseEventTa(rawEv);
      // Keep only real Time & Attendance terminals. Door locks (WINE ROOM, offices) and
      // other venues' readers are movement, not clocking. See TA_DEVICE_RE.
      const evs = all.filter((e) => e.device === undefined || TA_DEVICE_RE.test(e.device));
      const nonTa = all.length - evs.length;
      const byEmp: Record<string, Ev[]> = {};
      for (const e of evs) (byEmp[e.emp_id] ||= []).push(e);
      const records = Object.entries(byEmp)
        .map(([emp_id, list]) => ({ emp_id, att_date: opDate, punches: punchesFromEvents(list) }))
        .filter((x) => x.punches.length > 0);
      return { records, total: evs.length, skewFixed: evs.filter((e) => e.corrected).length, nonTa };
    }

    // Merge-safe upsert: union the new punches with whatever is already stored,
    // re-order on the 05:00 clock, recompute first/last. event-ta is complete, so
    // this only ever ADDS punches — it never nulls a real value.
    //
    // REPLACE MODE (?eventsync=DATE&replace=1, added 16 Jul 2026): union is add-only,
    // so it can never heal a row that already holds a bad punch — a skew-corrected
    // 09:14 would land NEXT TO the phantom 10:44 rather than replacing it. Replace
    // mode rebuilds the day authoritatively from event-ta (the complete source)
    // instead of merging. Only ever touches employees who HAVE events that day, so a
    // day outside COSEC's event retention returns nothing and silently changes nothing
    // rather than wiping good history. Never enabled on the automatic cron path.
    async function upsertPunchRecords(records: Array<{ emp_id: string; att_date: string; punches: string[] }>, replace = false): Promise<number> {
      if (!records.length) return 0;
      const dates = Array.from(new Set(records.map((r) => r.att_date)));
      const ids = Array.from(new Set(records.map((r) => r.emp_id)));
      const { data: existing } = await sb.from("attendance")
        .select("emp_id,att_date,punches").in("att_date", dates).in("emp_id", ids);
      const exMap: Record<string, string[]> = {};
      (existing || []).forEach((e) => { exMap[(e as any).emp_id + "|" + (e as any).att_date] = (e as any).punches || []; });
      const rows = records.map((r) => {
        const merged = replace
          ? new Set<string>(r.punches)
          : new Set<string>([...(exMap[r.emp_id + "|" + r.att_date] || []), ...r.punches]);
        const punches = Array.from(merged).sort((x, y) => rankTime(x) - rankTime(y));
        return {
          emp_id: r.emp_id, att_date: r.att_date,
          first_in: punches.length ? punches[0] : null,
          last_out: punches.length > 1 ? punches[punches.length - 1] : null,
          punch_count: punches.length, punches,
          synced_at: new Date().toISOString(),
        };
      });
      const up = await sb.from("attendance").upsert(rows, { onConflict: "emp_id,att_date" });
      if (up.error) throw new Error("Upsert failed: " + up.error.message);
      return rows.length;
    }

    // ── EVENT-TA SYNC: pull every punch for a day, capture split shifts ──
    // Window is 05:00 → 05:00 (next day) so a post-midnight clock-out stays
    // attached to the day the shift started. With ?dry=1 it writes nothing and
    // returns what it WOULD store (splits highlighted) for validation.
    if (eventSync) {
      const { records, total, skewFixed, nonTa } = await buildFromEventTa(eventSync);
      const splits = records.filter((r) => r.punches.length > 2);

      if (dry) {
        return json({
          ok: true, dry: true, date: eventSync,
          total_events: total, people: records.length, split_shifts: splits.length,
          skew_corrected: skewFixed, non_ta_skipped: nonTa, replace,
          splits: splits.map((s) => ({ emp_id: s.emp_id, punches: s.punches, segments: segmentsFromPunches(s.punches) })),
          sample: records.slice(0, 8).map((r) => ({ emp_id: r.emp_id, att_date: r.att_date, punch_count: r.punches.length, punches: r.punches })),
        });
      }

      const upserted = await upsertPunchRecords(records, replace);
      return json({ ok: true, date: eventSync, total_events: total, people: records.length, split_shifts: splits.length, skew_corrected: skewFixed, non_ta_skipped: nonTa, replace, upserted });
    }

    // ── EVENTS PROBE: read-only look at the raw per-punch events endpoint ──
    // attendance-daily only carries Punch1/Punch2 (first-in / last-out), so split
    // shifts lose their middle punches. The raw `events` endpoint logs EVERY punch.
    // This mode tries a few endpoint/param forms and returns the raw text only —
    // it never writes to the DB. Call: POST .../cosec-sync?events=YYYY-MM-DD
    if (eventsProbe) {
      const root = cosecUrl.split("/v2/")[0] + "/v2/"; // .../cosec/api.svc/v2/
      const [y, m, d] = eventsProbe.split("-");
      const dmy = d + m + y;                            // DDMMYYYY
      // 05:00 → 05:00 operational window: next calendar day for the post-midnight tail
      const next = new Date(eventsProbe + "T00:00:00Z");
      next.setUTCDate(next.getUTCDate() + 1);
      const ndmy = String(next.getUTCDate()).padStart(2, "0") +
        String(next.getUTCMonth() + 1).padStart(2, "0") + next.getUTCFullYear();
      const win = dmy + "050000-" + ndmy + "045959";   // DDMMYYYYHHMMSS-DDMMYYYYHHMMSS
      // ?events=DATE&user=<id> — one person, every field that identifies WHAT made the
      // punch: device_name (which reader), event_src (0=controller/door, 1=USB, 2=ESS
      // web, 3=SMS, 4=PIM, 5=other, 6=APP) and access_allowed. A filtered day is a
      // handful of rows, so return it whole rather than the 1800-char sample.
      if (eventsUser) {
        const u = root + "event-ta?action=get;date-range=" + win + ";userid=" +
          encodeURIComponent(eventsUser) +
          ";field-name=indexno,userid,username,eventdatetime,entryexittype,mastercontrollerid,doorcontrollerid,device_name,event_src,access_allowed,idatetime;";
        try {
          const r = await fetch(u, { headers: auth, signal: AbortSignal.timeout(20000) });
          const t = await r.text();
          return json({ ok: true, eventsProbe, user: eventsUser, url: u, http: r.status, len: t.length, raw: t.substring(0, 12000) });
        } catch (e) {
          return json({ ok: false, eventsProbe, user: eventsUser, url: u, error: e instanceof Error ? e.message : String(e) }, 502);
        }
      }

      // ?events=DATE&devices=1 — map every device seen that day: which controller,
      // its name, how many punches, and its clock skew. Needed to tell a real
      // Time & Attendance terminal (GF-TA-FACE) from an access-control door (WINE ROOM):
      // counting a door as a clock is what invents phantom in/out pairs.
      if (url.searchParams.get("devices") === "1") {
        const u = root + "event-ta?action=get;date-range=" + win +
          ";field-name=userid,eventdatetime,mastercontrollerid,device_name,event_src,idatetime;";
        const r = await fetch(u, { headers: auth, signal: AbortSignal.timeout(20000) });
        const t = await r.text();
        const agg: Record<string, { device: string; ctrl: string; punches: number; users: Set<string>; skews: number[] }> = {};
        for (const line of t.split(/\r?\n/)) {
          const c = line.split("|");
          if (c.length < 6 || !/^\w+$/.test((c[0] || "").trim()) || /userid/i.test(c[0])) continue;
          const ev = (c[1] || "").match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
          const id = (c[5] || "").match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
          const key = (c[2] || "?") + "|" + (c[3] || "?");
          (agg[key] ||= { device: c[3] || "?", ctrl: c[2] || "?", punches: 0, users: new Set(), skews: [] });
          agg[key].punches++;
          agg[key].users.add((c[0] || "").trim());
          if (ev && id) {
            const e = Date.UTC(+ev[3], +ev[2] - 1, +ev[1], +ev[4], +ev[5], ev[6] ? +ev[6] : 0);
            const i = Date.UTC(+id[3], +id[1] - 1, +id[2], +id[4], +id[5], id[6] ? +id[6] : 0);
            agg[key].skews.push(Math.round((e - i) / 60000));
          }
        }
        // Per-user device usage. The question that decides whether we can safely count
        // ONLY the TA terminals: is there anyone whose punches are all on non-TA
        // readers, who would lose their attendance entirely if we filtered?
        const byUser: Record<string, Set<string>> = {};
        for (const line of t.split(/\r?\n/)) {
          const c = line.split("|");
          if (c.length < 6 || /userid/i.test(c[0])) continue;
          const uid = (c[0] || "").trim();
          if (!uid) continue;
          (byUser[uid] ||= new Set()).add(c[3] || "?");
        }
        const isTA = (n: string) => /TA-FACE/i.test(n);
        return json({
          ok: true, date: eventsProbe, rows: t.length,
          devices: Object.values(agg).map((a) => ({
            controller: a.ctrl, device: a.device, punches: a.punches, distinct_users: a.users.size,
            skew_min: a.skews.length ? Math.round(a.skews.reduce((x, y) => x + y, 0) / a.skews.length) : null,
          })).sort((x, y) => y.punches - x.punches),
          users_total: Object.keys(byUser).length,
          users_with_ta: Object.entries(byUser).filter(([, d]) => [...d].some(isTA)).length,
          users_NO_ta: Object.entries(byUser).filter(([, d]) => ![...d].some(isTA))
            .map(([u, d]) => ({ emp_id: u, devices: [...d] })),
        });
      }

      const candidates: Record<string, string> = {
        eventta_window: root + "event-ta?action=get;date-range=" + win + ";",
        eventta_fields: root + "event-ta?action=get;date-range=" + win + ";field-name=indexno,userid,username,eventdatetime,entryexittype;",
        eventta_day: root + "event-ta?action=get;date-range=" + dmy + "-" + dmy + ";",
      };
      const out: Record<string, unknown> = {};
      for (const [k, u] of Object.entries(candidates)) {
        try {
          const r = await fetch(u, { headers: auth, signal: AbortSignal.timeout(20000) });
          const t = await r.text();
          out[k] = { url: u, http: r.status, len: t.length, sample: t.substring(0, 1800) };
        } catch (e) {
          out[k] = { url: u, error: e instanceof Error ? e.message : String(e) };
        }
      }
      return json({ ok: true, eventsProbe, out });
    }

    // ── PROBE MODE: discover which date parameter the API accepts ──
    if (probe) {
      const variants = ["date-dmy", "date-ymd", "from-to-dmy", "fromto-ymd", "processdate"];
      const results: Record<string, unknown> = {};
      for (const v of variants) {
        try {
          const u = urlForDate(cosecUrl, probe, v);
          const r = await fetch(u, { headers: auth, signal: AbortSignal.timeout(20000) });
          const t = await r.text();
          const recs = parseCosec(t);
          const withPunch = recs.filter((x) => x.first_in).length;
          results[v] = {
            http: r.status,
            rows: recs.length,
            withPunch,
            firstDate: recs[0]?.att_date || null,
            sample: t.substring(0, 200),
          };
        } catch (e) {
          results[v] = { error: e instanceof Error ? e.message : String(e) };
        }
      }
      return json({ ok: true, probe, results });
    }

    // Throttle (only for the normal "today" auto-sync)
    const { data: state } = await sb.from("cosec_sync_state").select("*").eq("id", 1).maybeSingle();
    if (!force && !debug && !reqDate && state?.last_sync) {
      const age = Date.now() - new Date(state.last_sync).getTime();
      if (age < THROTTLE_MS) {
        return json({ ok: true, skipped: true, last_sync: state.last_sync, last_status: state.last_status });
      }
    }

    // STANDARD SYNC — now sourced from the raw event-ta feed so split shifts are
    // captured (attendance-daily only ever gave first-in/last-out). The operational
    // day runs 05:00 → 05:00, so before 05:00 Dubai the live day is still yesterday.
    let opDate: string;
    if (reqDate) {
      opDate = reqDate;
    } else {
      const dn = dubaiNow();
      if (dn.getUTCHours() < DAY_START_HOUR) {
        const yd = new Date(dn); yd.setUTCDate(yd.getUTCDate() - 1);
        opDate = yd.toISOString().substring(0, 10);
      } else {
        opDate = dn.toISOString().substring(0, 10);
      }
    }

    let upserted = 0, totalEvents = 0, splitCount = 0, skewCount = 0, nonTaCount = 0;
    try {
      const { records, total, skewFixed, nonTa } = await buildFromEventTa(opDate);
      totalEvents = total;
      skewCount = skewFixed;
      nonTaCount = nonTa;
      splitCount = records.filter((r) => r.punches.length > 2).length;
      upserted = await upsertPunchRecords(records);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await sb.from("cosec_sync_state").upsert({
        id: 1, last_sync: new Date().toISOString(), last_status: "event-ta error: " + msg,
      });
      return json({ ok: false, error: msg }, 502);
    }

    const status = "ok(event-ta): " + opDate + " — " + totalEvents + " events, " + upserted + " upserted, " + splitCount + " splits, " + skewCount + " skew-corrected, " + nonTaCount + " non-TA ignored";
    await sb.from("cosec_sync_state").upsert({
      id: 1, last_sync: new Date().toISOString(), last_status: status,
    });

    return json({ ok: true, date: opDate, total_events: totalEvents, upserted, split_shifts: splitCount, skew_corrected: skewCount, non_ta_skipped: nonTaCount });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from("cosec_sync_state").upsert({
      id: 1, last_sync: new Date().toISOString(), last_status: "error: " + msg,
    }).then(() => {}, () => {});
    return json({ ok: false, error: msg }, 500);
  }
});