// kitchen-guard -- server-side gate for the kitchen tables that hold sensitive
// data. The kitchen app has NO logins, so these tables are locked to the
// service role at the database (kitchen-security-batch-b.sql) and every
// legitimate operation goes through this function instead of PostgREST.
//
// Ops:
//   survey_submit     anyone (staff fill the survey) -- shape-validated insert
//   survey_completion anyone -- names + dates only (the list screen tick marks)
//   survey_results    passcode-gated SERVER-SIDE -- the full named answers
//   summary_get       passcode-gated -- latest AI summary (aggregates answers)
//   summary_save      passcode-gated -- store a new AI summary
//   manual_out        close an open shift (manual clock-out override)
//
// Deploy with verify_jwt=false. Secret: TEAM_RESULTS_CODES = "1212,121212"
// (comma-separated accepted passcodes; rotate by changing the env only).
// ASCII ONLY in this file (deploy encoding trap).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad request" }, 400); }
  if (!b || typeof b !== "object") b = {};

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const op = String(b.op || "");
  const codes = (Deno.env.get("TEAM_RESULTS_CODES") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const gated = codes.length > 0 && codes.includes(String(b.code || "").trim());

  if (op === "survey_submit") {
    const r = b.row || {};
    const row = {
      staff_id: (typeof r.staff_id === "string" && r.staff_id.length < 80) ? r.staff_id : null,
      staff_name: String(r.staff_name || "").slice(0, 120),
      designation: r.designation ? String(r.designation).slice(0, 80) : null,
      station_key: r.station_key ? String(r.station_key).slice(0, 80) : null,
      answers: (r.answers && typeof r.answers === "object" && !Array.isArray(r.answers)) ? r.answers : null,
      lang: r.lang ? String(r.lang).slice(0, 8) : null,
      submitted_at: new Date().toISOString(),
    };
    if (!row.staff_name || !row.answers) return json({ error: "incomplete" }, 400);
    if (JSON.stringify(row.answers).length > 20000) return json({ error: "too large" }, 400);
    const res = await supa.from("team_survey").insert(row);
    if (res.error) return json({ error: res.error.message }, 500);
    return json({ ok: true });
  }

  if (op === "survey_completion") {
    const since = /^\d{4}-\d{2}-\d{2}/.test(String(b.since || "")) ? String(b.since) : "1970-01-01";
    const res = await supa.from("team_survey")
      .select("staff_id,staff_name,submitted_at")
      .gte("submitted_at", since).limit(2000);
    if (res.error) return json({ error: res.error.message }, 500);
    return json({ rows: res.data });
  }

  if (op === "survey_results") {
    if (!gated) return json({ error: "wrong passcode" }, 403);
    const res = await supa.from("team_survey").select("*")
      .order("submitted_at", { ascending: false }).limit(2000);
    if (res.error) return json({ error: res.error.message }, 500);
    return json({ rows: res.data });
  }

  if (op === "summary_get") {
    if (!gated) return json({ error: "wrong passcode" }, 403);
    const res = await supa.from("team_survey_summary").select("*")
      .order("created_at", { ascending: false }).limit(1);
    if (res.error) return json({ error: res.error.message }, 500);
    return json({ rows: res.data });
  }

  if (op === "summary_save") {
    if (!gated) return json({ error: "wrong passcode" }, 403);
    const res = await supa.from("team_survey_summary").insert({
      summary: String(b.summary || "").slice(0, 60000),
      round: b.round ? String(b.round).slice(0, 40) : null,
      created_at: new Date().toISOString(),
    });
    if (res.error) return json({ error: res.error.message }, 500);
    return json({ ok: true });
  }

  if (op === "manual_out") {
    const emp = String(b.emp_id || "").trim();
    const date = String(b.att_date || "");
    if (!emp || emp.length > 20 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "bad request" }, 400);
    const out = b.out == null ? null : String(b.out).slice(0, 25);
    const res = await supa.from("attendance")
      .update({ manual_out: out, closed_by: "manager", closed_at: b.closed_at ? String(b.closed_at).slice(0, 40) : new Date().toISOString() })
      .eq("emp_id", emp).eq("att_date", date);
    if (res.error) return json({ error: res.error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: "unknown op" }, 400);
});
