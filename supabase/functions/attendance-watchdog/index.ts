// ════════════════════════════════════════════════════════════
// ATTENDANCE-WATCHDOG — Supabase Edge Function (Kitchen project)
// Once a day, after the morning COSEC catch-up, emails Francesco a
// digest of the PREVIOUS service day's attendance anomalies:
//   (1) NO CLOCK-OUT  — has a first_in but no last_out and no manual_out
//   (2) LONG SHIFT     — worked > 14h (machine out, or manager manual close)
//   (3) ALL CLEAR      — neither of the above for anyone
//
// Scope = Kitchen staff (local `staff` table) + FOH staff (`foh_staff`
// on the FOH project). Attendance lives ONLY on this Kitchen project;
// both apps share it, so this one function covers both teams.
//
// Deploy name: attendance-watchdog
// Schedule:    daily ~10:00 Dubai (06:00 UTC) — see attendance-watchdog-cron.sql
//              (runs AFTER the 09:00-UTC service catch-up so yesterday's
//               post-midnight out-punches are already captured).
//
// Call patterns:
//   POST /functions/v1/attendance-watchdog                → yesterday (Dubai), email
//   POST /functions/v1/attendance-watchdog?date=2026-06-21 → specific service day
//   POST /functions/v1/attendance-watchdog?dry=1          → compute + return JSON, DO NOT email
//   POST /functions/v1/attendance-watchdog?debug=1        → email + return the full breakdown
// ════════════════════════════════════════════════════════════

import { createClient } from "jsr:@supabase/supabase-js@2";

// ── Config (inline, matching send-market-order / send-closing-report) ──
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";  // set as a function secret - never in code
const FROM = "Roberto's Attendance <attendance@kitchenteam.robertos.ae>"; // verified Resend domain
const RECIPIENTS = ["fguarracino@robertos.ae"];                           // Francesco only, for now

// FOH project (read-only) — anon key, foh_staff RLS is allow-all.
const FOH_URL = "https://paoaivwtkzujmrgrfjuq.supabase.co";
const FOH_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBhb2Fpdnd0a3p1am1yZ3JmanVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwNzAxMzAsImV4cCI6MjA5NjY0NjEzMH0.VynG9PBeIaqRG2lkMEuzskkcB11EhR-UfO9eGYsaUxk";

const LONG_SHIFT_MIN = 14 * 60; // > 14h flagged

// Dubai = UTC+4, no DST.
function dubaiNow(): Date {
  return new Date(Date.now() + 4 * 60 * 60 * 1000);
}
function dubaiYesterday(): string {
  return new Date(dubaiNow().getTime() - 24 * 60 * 60 * 1000)
    .toISOString()
    .substring(0, 10);
}

// Worked minutes between two "HH:MM" times on a single overnight-capable
// shift. Mirrors the kitchen app's calcHours(): if the end is "before" the
// start, the shift crossed midnight, so add a day. Returns whole minutes.
function workedMinutes(start: string, end: string): number {
  const sp = start.split(":");
  const ep = end.split(":");
  let mins =
    (parseInt(ep[0], 10) * 60 + parseInt(ep[1] || "0", 10)) -
    (parseInt(sp[0], 10) * 60 + parseInt(sp[1] || "0", 10));
  if (mins <= 0) mins += 1440;
  return mins;
}
function fmtHours(mins: number): string {
  return (Math.round(mins / 6) / 10).toFixed(1) + "h";
}

interface StaffRef { name: string; team: "Kitchen" | "FOH" }
interface Flagged { emp_id: string; name: string; team: string; first_in: string | null; out: string | null; mins?: number }

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const url = new URL(req.url);
  const targetDate = url.searchParams.get("date") || dubaiYesterday();
  const dry = url.searchParams.get("dry") === "1";
  const debug = url.searchParams.get("debug") === "1";

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const foh = createClient(FOH_URL, FOH_ANON);

    // ── Build emp_id → {name, team} from BOTH staff lists ──
    const [kitchenStaff, fohStaff] = await Promise.all([
      sb.from("staff").select("emp_id,name").eq("active", true),
      foh.from("foh_staff").select("emp_id,name").eq("active", true),
    ]);
    if (kitchenStaff.error) throw new Error("kitchen staff: " + kitchenStaff.error.message);
    // FOH read is best-effort — if the cross-project call fails we still
    // report kitchen, and flag the gap rather than silently dropping FOH.
    const fohError = fohStaff.error ? fohStaff.error.message : null;

    const staffMap: Record<string, StaffRef> = {};
    (kitchenStaff.data || []).forEach((s: any) => {
      if (s.emp_id) staffMap[String(s.emp_id).trim()] = { name: s.name, team: "Kitchen" };
    });
    (fohStaff.data || []).forEach((s: any) => {
      const id = s.emp_id ? String(s.emp_id).trim() : "";
      if (id && !staffMap[id]) staffMap[id] = { name: s.name, team: "FOH" }; // kitchen wins on collision
    });

    // ── Attendance for the target service day ──
    const att = await sb.from("attendance")
      .select("emp_id,att_date,first_in,last_out,manual_out")
      .eq("att_date", targetDate)
      .limit(2000);
    if (att.error) throw new Error("attendance: " + att.error.message);

    const noClockOut: Flagged[] = [];
    const longShift: Flagged[] = [];
    let outsideRoster = 0; // anomalies on COSEC ids NOT in either roster (other depts)

    for (const a of (att.data || [])) {
      const id = String(a.emp_id).trim();
      const ref = staffMap[id];
      const out = a.manual_out || a.last_out || null;

      // Is this row an anomaly at all?
      const isNoOut = !!(a.first_in && !a.last_out && !a.manual_out);
      const mins = (a.first_in && out) ? workedMinutes(a.first_in, out) : 0;
      const isLong = mins > LONG_SHIFT_MIN;
      if (!isNoOut && !isLong) continue;

      // Scope = Kitchen + FOH rosters only. COSEC also serves other departments
      // (stewarding etc.) on a separate id series — their missing clock-outs
      // aren't actionable here, so we COUNT them for transparency but don't
      // alarm on them. (Never silently dropped — see the email footer.)
      if (!ref) { outsideRoster++; continue; }

      if (isNoOut) {
        noClockOut.push({ emp_id: id, name: ref.name, team: ref.team, first_in: a.first_in, out: null });
        continue; // a no-out shift has no known length — don't double-count
      }
      if (isLong) {
        longShift.push({ emp_id: id, name: ref.name, team: ref.team, first_in: a.first_in, out, mins });
      }
    }

    noClockOut.sort((x, y) => x.name.localeCompare(y.name));
    longShift.sort((x, y) => (y.mins || 0) - (x.mins || 0));

    const issueCount = noClockOut.length + longShift.length;
    const allClear = issueCount === 0;

    // ── Compose email ──
    const niceDate = new Date(targetDate + "T00:00:00Z").toLocaleDateString("en-GB", {
      weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
    });
    const subject = allClear
      ? `✅ Attendance watchdog — ${niceDate}: all clear`
      : `⏰ Attendance watchdog — ${niceDate}: ${issueCount} issue${issueCount > 1 ? "s" : ""}`;

    const html = buildHtml({ niceDate, noClockOut, longShift, allClear, fohError, outsideRoster });

    let emailStatus: unknown = "skipped (dry run)";
    if (!dry) {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM, to: RECIPIENTS, subject, html }),
      });
      emailStatus = await r.json();
      console.log("WATCHDOG RESEND:", r.status, JSON.stringify(emailStatus));
    }

    return json({
      ok: true,
      date: targetDate,
      issueCount,
      allClear,
      noClockOut: (debug || dry) ? noClockOut : noClockOut.length,
      longShift: (debug || dry) ? longShift : longShift.length,
      outsideRoster,
      fohError,
      emailStatus: dry ? "dry run — no email sent" : emailStatus,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("WATCHDOG ERROR:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

function buildHtml(o: {
  niceDate: string;
  noClockOut: Flagged[];
  longShift: Flagged[];
  allClear: boolean;
  fohError: string | null;
  outsideRoster: number;
}): string {
  const outsideNote = o.outsideRoster
    ? `<div style="color:#aaa;font-size:12px;margin-top:6px;">
        + ${o.outsideRoster} clock-in${o.outsideRoster > 1 ? "s" : ""} with no out from IDs outside the Kitchen/FOH rosters (other departments) — not shown.
      </div>`
    : "";
  const wrap = (inner: string) => `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a;">
    <h2 style="margin:0 0 4px;">Attendance watchdog</h2>
    <div style="color:#666;margin-bottom:18px;">Service day — ${o.niceDate}</div>
    ${inner}
    ${outsideNote}
    <p style="color:#999;font-size:12px;margin-top:28px;border-top:1px solid #eee;padding-top:12px;">
      Automatic daily check of clock-outs and shift length across Kitchen &amp; FOH.
      "No clock-out" = a clock-in with no machine out and no manager close. "Long shift" = over 14 hours.
    </p>
  </div>`;

  if (o.allClear) {
    return wrap(`
      <div style="background:#e9f7ef;border:1px solid #b7e1c6;border-radius:8px;padding:18px 20px;">
        <div style="font-size:18px;">✅ <b>All clear.</b></div>
        <div style="color:#456;margin-top:4px;">Everyone who clocked in also clocked out, and no shift ran over 14&nbsp;hours.</div>
      </div>
      ${o.fohError ? fohWarn(o.fohError) : ""}`);
  }

  const row = (f: Flagged, showHours: boolean) => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;"><b>${esc(f.name)}</b></td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;color:#667;">${f.team}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;">${f.first_in || "—"}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;">${f.out || '<span style="color:#c0392b;">no out</span>'}</td>
      ${showHours ? `<td style="padding:8px 10px;border-bottom:1px solid #eee;"><b>${fmtHours(f.mins || 0)}</b></td>` : ""}
    </tr>`;

  const section = (title: string, color: string, items: Flagged[], showHours: boolean) => {
    if (!items.length) return "";
    return `
      <div style="margin-bottom:22px;">
        <div style="font-weight:700;color:${color};margin-bottom:8px;">${title} (${items.length})</div>
        <table style="border-collapse:collapse;width:100%;font-size:14px;">
          <thead><tr style="text-align:left;color:#888;font-size:12px;">
            <th style="padding:6px 10px;">Name</th><th style="padding:6px 10px;">Team</th>
            <th style="padding:6px 10px;">In</th><th style="padding:6px 10px;">Out</th>
            ${showHours ? '<th style="padding:6px 10px;">Worked</th>' : ""}
          </tr></thead>
          <tbody>${items.map((f) => row(f, showHours)).join("")}</tbody>
        </table>
      </div>`;
  };

  return wrap(
    section("⛔ No clock-out", "#c0392b", o.noClockOut, false) +
    section("⏱️ Long shift — over 14h", "#b9770e", o.longShift, true) +
    (o.fohError ? fohWarn(o.fohError) : ""),
  );
}

function fohWarn(msg: string): string {
  return `<div style="background:#fff4e5;border:1px solid #ffd8a8;border-radius:8px;padding:10px 14px;color:#92400e;font-size:13px;margin-top:8px;">
    ⚠️ FOH staff list could not be read this run — FOH names may be missing or shown as "Unknown". (${esc(msg)})
  </div>`;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] || c));
}
