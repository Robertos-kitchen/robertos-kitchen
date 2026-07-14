// ════════════════════════════════════════════════════════════
// REVENUE-GAP-WATCHDOG — Supabase Edge Function (Kitchen project)
// Once a day, emails Francesco how much of the PREVIOUS night's revenue
// SevenRooms actually captured vs the truth, and flags the checks that
// leaked (their party was never logged in SevenRooms, so nothing to link to).
//
// WHY: SevenRooms "live spend" is GROSS and INCOMPLETE — a Simphony check
// links only if a SEATED SR entry (booking or logged walk-in) exists for that
// party. Unlogged walk-ins vanish (verified 7 Jul: all 7 unlinked money checks
// of 6 Jul HAD table numbers — "name-only tab" is a dead theory). Across
// 5 measured nights SR caught 83–94% (~88%). This watchdog surfaces the gap
// every morning so the "every guest gets a SevenRooms entry" habit can be
// coached, and the missing attribution recovered (~AED 7,450/night avg).
//
// THE MATHS (verified to the fils, 4 Jul 2026):
//   Net = menu-price total ÷ 1.225   (10% SC + 7% municipality + 5% VAT)
//   • Truth net       = rev_daily.net_actual  (Closing Report → Simphony "Sales Net VAT")
//   • SR-tracked net  = SevenRooms pos_subtotal ÷ 1.225   (tracked tables only)
//   • Gap             = truth − tracked  = revenue SR never saw
//
// DATA SOURCES:
//   • SR spend      → this project's sevenrooms-sync?spend=DATE  (same Kitchen project)
//   • Truth net     → FOH project rev_daily.net_actual  (cross-project, anon read)
//                     Only present AFTER a manager files the Closing Report; if it
//                     isn't filed yet we still report tracked net + the leak list,
//                     and say the truth line is pending.
//
// SUSPECTED-MISSING DETECTION (v1): from the linked check numbers SR returns,
// we find the min..max of each series (17xxx restaurant, 25xxx bar) and list the
// in-sequence gaps. Those gaps are the prime suspects for unlogged walk-in
// parties. This is a heuristic that OVERCOUNTS — gaps can also be 0.00
// voids/re-opens/transfer shells — so it's labelled "suspected".
// v2 (needs a Simphony guest-check feed): exact checks + AED + who opened them.
//
// Deploy name: revenue-gap-watchdog
// Schedule:    daily ~10:30 Dubai (06:30 UTC) — AFTER the night is closed and the
//              post-midnight bar tabs are settled. See revenue-gap-watchdog-cron.sql.
//
// Call patterns:
//   POST /functions/v1/revenue-gap-watchdog                 → yesterday (Dubai), email
//   POST /functions/v1/revenue-gap-watchdog?date=2026-07-06 → specific service day
//   POST /functions/v1/revenue-gap-watchdog?dry=1           → compute + return JSON, NO email
//   POST /functions/v1/revenue-gap-watchdog?debug=1         → email + return full breakdown
// ════════════════════════════════════════════════════════════

import { createClient } from "jsr:@supabase/supabase-js@2";

// ── Config (inline, matching attendance-watchdog / send-closing-report) ──
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";  // set as a function secret - never in code
const FROM = "Roberto's Revenue <revenue@kitchenteam.robertos.ae>"; // verified Resend domain
const RECIPIENTS = ["fguarracino@robertos.ae"];                     // Francesco only, for now

// This (Kitchen) project — where sevenrooms-sync lives.
const SR_SYNC_URL = "https://zrpglswalgjbtghudmhu.supabase.co/functions/v1/sevenrooms-sync";
const KITCHEN_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpycGdsc3dhbGdqYnRnaHVkbWh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5MTIyMjQsImV4cCI6MjA5NjQ4ODIyNH0.pfABN-so4xINK7nHxXUlVeTO4g0h0l6ILHVwpoKrbds";

// FOH project (read-only) — where rev_daily lives. rev_daily RLS is authenticated-only,
// which silently returns ZERO rows to the anon key (verified 7 Jul — the truth line
// could never appear with anon). So we read with the FOH service key, held as an
// edge-function secret (FOH_SERVICE_KEY, set via Management API — never in code),
// used ONLY for this one SELECT. Anon fallback degrades gracefully ("pending").
const FOH_URL = "https://paoaivwtkzujmrgrfjuq.supabase.co";
const FOH_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBhb2Fpdnd0a3p1am1yZ3JmanVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwNzAxMzAsImV4cCI6MjA5NjY0NjEzMH0.VynG9PBeIaqRG2lkMEuzskkcB11EhR-UfO9eGYsaUxk";
const FOH_KEY = Deno.env.get("FOH_SERVICE_KEY") ?? "";  // no anon fallback: anon reads 0 rows and lies

const GROSS_TO_NET = 1.225; // verified tax stack

// Dubai = UTC+4, no DST.
function dubaiNow(): Date {
  return new Date(Date.now() + 4 * 60 * 60 * 1000);
}
function dubaiYesterday(): string {
  return new Date(dubaiNow().getTime() - 24 * 60 * 60 * 1000).toISOString().substring(0, 10);
}
function money0(n: number): string {
  return "AED " + Math.round(n).toLocaleString("en-US");
}

// Collect all integer check numbers from the SR rows (check_numbers is a
// comma-separated string like "25778,25782"), then per magnitude-series
// (grouped by thousands bucket) list the in-sequence gaps = suspected misses.
function suspectedGaps(rows: any[]): { series: number; lo: number; hi: number; linked: number; missing: number[] }[] {
  const buckets: Record<number, Set<number>> = {};
  for (const r of rows) {
    const raw = String(r.check_numbers ?? "");
    for (const part of raw.split(",")) {
      const n = parseInt(part.trim(), 10);
      if (!Number.isFinite(n)) continue;
      const b = Math.floor(n / 1000); // 17xxx → 17, 25xxx → 25
      (buckets[b] ||= new Set<number>()).add(n);
    }
  }
  const out = [];
  for (const b of Object.keys(buckets).map(Number).sort((a, z) => a - z)) {
    const nums = [...buckets[b]].sort((a, z) => a - z);
    const lo = nums[0], hi = nums[nums.length - 1];
    const have = new Set(nums);
    const missing: number[] = [];
    for (let i = lo; i <= hi; i++) if (!have.has(i)) missing.push(i);
    out.push({ series: b, lo, hi, linked: nums.length, missing });
  }
  return out;
}

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
    new Response(JSON.stringify(body, null, 2), { status, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const proxySecret = Deno.env.get("SEVENROOMS_PROXY_SECRET") || "Kitchen";

    // ── (1) SevenRooms captured spend for the night ──
    const srRes = await fetch(`${SR_SYNC_URL}?spend=${targetDate}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${KITCHEN_ANON}`,
        "apikey": KITCHEN_ANON,
        "x-proxy-secret": proxySecret,
        "Content-Type": "application/json",
      },
    });
    const sr = await srRes.json();
    if (!sr?.ok) throw new Error("sevenrooms-sync spend failed: " + JSON.stringify(sr).slice(0, 300));

    const grossCaptured = Number(sr?.totals?.pos_subtotal) || 0; // menu prices, gross
    const trackedNet = grossCaptured / GROSS_TO_NET;
    const linkedChecks = Number(sr?.tickets) || 0;
    const rows: any[] = Array.isArray(sr?.rows) ? sr.rows : [];
    const gaps = suspectedGaps(rows);
    const suspectedMissing = gaps.reduce((a, g) => a + g.missing.length, 0);

    // ── (2) Truth net from the FOH Closing Report rollup (best-effort) ──
    let truthNet: number | null = null;
    let truthNote = "";
    try {
      const foh = createClient(FOH_URL, FOH_KEY);
      const { data, error } = await foh
        .from("rev_daily").select("net_actual").eq("service_date", targetDate).maybeSingle();
      if (error) truthNote = "rev_daily not readable (" + error.message + ")";
      else if (!data || data.net_actual == null) truthNote = "Closing Report not filed yet for this date";
      else truthNet = Number(data.net_actual);
    } catch (e) {
      truthNote = "rev_daily read error (" + (e instanceof Error ? e.message : String(e)) + ")";
    }

    const gapNet = truthNet != null ? truthNet - trackedNet : null;
    const coveragePct = truthNet && truthNet > 0 ? (trackedNet / truthNet) * 100 : null;

    // ── (3) Compose + email ──
    const niceDate = new Date(targetDate + "T00:00:00Z").toLocaleDateString("en-GB", {
      weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
    });
    const subject = coveragePct != null
      ? `📊 Revenue capture — ${niceDate}: ${coveragePct.toFixed(0)}% tracked, ${money0(gapNet || 0)} leaked`
      : `📊 Revenue capture — ${niceDate}: ${money0(trackedNet)} tracked (truth pending)`;

    const html = buildHtml({
      niceDate, grossCaptured, trackedNet, truthNet, gapNet, coveragePct,
      truthNote, linkedChecks, suspectedMissing, gaps,
    });

    let emailStatus: unknown = "skipped (dry run)";
    if (!dry) {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM, to: RECIPIENTS, subject, html }),
      });
      emailStatus = await r.json();
      console.log("REV-GAP RESEND:", r.status, JSON.stringify(emailStatus));
    }

    return json({
      ok: true, date: targetDate,
      grossCaptured: +grossCaptured.toFixed(2),
      trackedNet: +trackedNet.toFixed(2),
      truthNet, gapNet: gapNet != null ? +gapNet.toFixed(2) : null,
      coveragePct: coveragePct != null ? +coveragePct.toFixed(1) : null,
      truthNote, linkedChecks, suspectedMissing,
      gaps: (debug || dry) ? gaps : gaps.map((g) => ({ series: g.series, linked: g.linked, missing: g.missing.length })),
      emailStatus: dry ? "dry run — no email sent" : emailStatus,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("REV-GAP ERROR:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

function buildHtml(o: {
  niceDate: string;
  grossCaptured: number;
  trackedNet: number;
  truthNet: number | null;
  gapNet: number | null;
  coveragePct: number | null;
  truthNote: string;
  linkedChecks: number;
  suspectedMissing: number;
  gaps: { series: number; lo: number; hi: number; linked: number; missing: number[] }[];
}): string {
  const covColor = o.coveragePct == null ? "#666" : o.coveragePct >= 95 ? "#1e7e46" : o.coveragePct >= 88 ? "#b9770e" : "#c0392b";

  const truthBlock = o.truthNet != null
    ? `
      <table style="border-collapse:collapse;width:100%;font-size:15px;margin:6px 0 18px;">
        <tr><td style="padding:7px 0;color:#556;">Truth — Simphony Net (Closing Report)</td>
            <td style="padding:7px 0;text-align:right;font-weight:700;">${money0(o.truthNet)}</td></tr>
        <tr><td style="padding:7px 0;color:#556;">SevenRooms tracked net (÷ 1.225)</td>
            <td style="padding:7px 0;text-align:right;">${money0(o.trackedNet)}</td></tr>
        <tr style="border-top:2px solid #eee;"><td style="padding:9px 0;color:#c0392b;font-weight:700;">Leaked (not captured)</td>
            <td style="padding:9px 0;text-align:right;color:#c0392b;font-weight:700;">${money0(o.gapNet || 0)}</td></tr>
      </table>
      <div style="font-size:13px;color:#667;margin-bottom:18px;">
        Coverage: <b style="color:${covColor};">${o.coveragePct!.toFixed(0)}%</b> of the night's revenue was linked to a table in SevenRooms.
      </div>`
    : `
      <table style="border-collapse:collapse;width:100%;font-size:15px;margin:6px 0 12px;">
        <tr><td style="padding:7px 0;color:#556;">SevenRooms tracked net (÷ 1.225)</td>
            <td style="padding:7px 0;text-align:right;font-weight:700;">${money0(o.trackedNet)}</td></tr>
      </table>
      <div style="background:#fff4e5;border:1px solid #ffd8a8;border-radius:8px;padding:10px 14px;color:#92400e;font-size:13px;margin-bottom:18px;">
        ⏳ Truth line pending — ${esc(o.truthNote)}. Re-run once the Closing Report is filed for the full gap.
      </div>`;

  const gapRows = o.gaps.map((g) => {
    const label = g.series === 17 ? "Restaurant (17xxx)" : g.series === 25 ? "Bar / Lounge (25xxx)" : `${g.series}xxx`;
    const list = g.missing.length
      ? g.missing.slice(0, 40).join(", ") + (g.missing.length > 40 ? ` … (+${g.missing.length - 40})` : "")
      : "— none —";
    const c = g.missing.length === 0 ? "#1e7e46" : g.missing.length <= 2 ? "#b9770e" : "#c0392b";
    return `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;"><b>${label}</b></td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;color:#667;">${g.lo}–${g.hi}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;">${g.linked}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;color:${c};"><b>${g.missing.length}</b></td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;color:#556;font-size:13px;">${list}</td>
      </tr>`;
  }).join("");

  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:660px;margin:0 auto;color:#1a1a1a;">
    <h2 style="margin:0 0 4px;">Revenue capture watchdog</h2>
    <div style="color:#666;margin-bottom:18px;">Service night — ${o.niceDate}</div>
    ${truthBlock}
    <div style="font-weight:700;margin:0 0 8px;">Suspected unlinked checks (${o.suspectedMissing})</div>
    <div style="color:#778;font-size:13px;margin-bottom:8px;">
      Gaps in each check-number series — the prime suspects for parties never logged in SevenRooms (unlogged walk-ins).
      SevenRooms linked ${o.linkedChecks} check${o.linkedChecks === 1 ? "" : "s"} in total.
    </div>
    <table style="border-collapse:collapse;width:100%;font-size:14px;">
      <thead><tr style="text-align:left;color:#888;font-size:12px;">
        <th style="padding:6px 10px;">Area</th><th style="padding:6px 10px;">Range</th>
        <th style="padding:6px 10px;">Linked</th><th style="padding:6px 10px;">Gaps</th>
        <th style="padding:6px 10px;">Suspected missing check #s</th>
      </tr></thead>
      <tbody>${gapRows}</tbody>
    </table>
    <p style="color:#999;font-size:12px;margin-top:24px;border-top:1px solid #eee;padding-top:12px;">
      SevenRooms only captures checks whose party has a seated SevenRooms entry (booking or logged walk-in), at gross menu prices.
      "Tracked net" = that gross ÷ 1.225. Gap counts are heuristic and OVERCOUNT (a gap can also be a 0.00 void/re-open/transfer shell) —
      confirm the real ones against Simphony's guest-check list.
      Fix: <b>every guest gets a SevenRooms entry</b> — hosts log walk-ins at seating (real table + party size);
      manager does the 2-minute unmatched-check sweep at close ("Link Check" = safety net).
    </p>
  </div>`;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] || c));
}
