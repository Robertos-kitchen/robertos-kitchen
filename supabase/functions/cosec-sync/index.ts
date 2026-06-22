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
  const reqVariant = url.searchParams.get("variant"); // which date param format to use
  const probe = url.searchParams.get("probe");       // YYYY-MM-DD: try param variants, report which works (no DB write)

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

    const targetUrl = reqDate ? urlForDate(cosecUrl, reqDate, reqVariant || Deno.env.get("COSEC_DATE_VARIANT") || "date-range") : cosecUrl;

    const res = await fetch(targetUrl, {
      headers: auth,
      signal: AbortSignal.timeout(20000),
    });
    const raw = await res.text();

    if (!res.ok) {
      await sb.from("cosec_sync_state").upsert({
        id: 1, last_sync: new Date().toISOString(),
        last_status: "HTTP " + res.status, last_raw: raw.substring(0, 4000),
      });
      return json({ ok: false, error: "COSEC HTTP " + res.status, raw: debug ? raw.substring(0, 4000) : undefined }, 502);
    }

    const recs = parseCosec(raw);
    // When pulling a specific historical date, trust the requested date
    // (some firmwares omit the date column on per-date queries).
    if (reqDate) recs.forEach((r) => { r.att_date = reqDate; });

    // Only consider rows that actually carry a punch — a row with no punches
    // must never overwrite an existing record (that's how late out-punches
    // got lost: an early empty/in-only snapshot froze the day).
    const punchRecs = recs.filter((r) => r.first_in || r.last_out);

    let upserted = 0;
    if (punchRecs.length) {
      // Pull the existing rows for these emp/date pairs so we can MERGE
      // rather than blind-overwrite. Rule: keep the earliest first_in and
      // the latest last_out ever seen; never replace a real value with null.
      const dates = Array.from(new Set(punchRecs.map((r) => r.att_date)));
      const ids = Array.from(new Set(punchRecs.map((r) => r.emp_id)));
      const { data: existing } = await sb.from("attendance")
        .select("emp_id,att_date,first_in,last_out,punches")
        .in("att_date", dates).in("emp_id", ids);
      const exMap: Record<string, { first_in: string | null; last_out: string | null; punches: string[] }> = {};
      (existing || []).forEach((e) => { exMap[e.emp_id + "|" + e.att_date] = e as any; });

      // Compare on the 05:00→05:00 operational clock, NOT as text. As strings
      // "23:50" > "02:00", so a real post-midnight clock-out ("02:00") would lose
      // to an earlier punch and the late out would silently disappear/regress.
      // rankTime() pushes 00:00–04:59 after the evening, so latest-out is correct.
      const minT = (a: string | null, b: string | null) =>
        a && b ? (rankTime(a) <= rankTime(b) ? a : b) : (a || b);
      const maxT = (a: string | null, b: string | null) =>
        a && b ? (rankTime(a) >= rankTime(b) ? a : b) : (a || b);

      const rows = punchRecs.map((r) => {
        const ex = exMap[r.emp_id + "|" + r.att_date];
        const first_in = minT(ex?.first_in ?? null, r.first_in);
        const last_out = maxT(ex?.last_out ?? null, r.last_out);
        // Union of all punch times we've ever seen for this day, sorted.
        const punchSet = new Set<string>([...(ex?.punches || []), ...r.punches]);
        const punches = Array.from(punchSet).sort((x, y) => rankTime(x) - rankTime(y));
        return {
          emp_id: r.emp_id,
          att_date: r.att_date,
          first_in,
          last_out,
          punch_count: punches.length,
          punches,
          synced_at: new Date().toISOString(),
        };
      });
      const up = await sb.from("attendance").upsert(rows, { onConflict: "emp_id,att_date" });
      if (up.error) throw new Error("Upsert failed: " + up.error.message);
      upserted = rows.length;
    }

    const status = "ok: " + recs.length + " records, " + upserted + " upserted";
    await sb.from("cosec_sync_state").upsert({
      id: 1, last_sync: new Date().toISOString(),
      last_status: status,
      last_raw: (recs.length ? "" : "UNPARSED → ") + raw.substring(0, 4000),
    });

    return json({
      ok: true, records: recs.length, upserted,
      sample: recs.slice(0, 3),
      raw: debug ? raw.substring(0, 4000) : undefined,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from("cosec_sync_state").upsert({
      id: 1, last_sync: new Date().toISOString(), last_status: "error: " + msg,
    }).then(() => {}, () => {});
    return json({ ok: false, error: msg }, 500);
  }
});
