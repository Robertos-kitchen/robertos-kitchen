import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SR_BASE = "https://api.sevenrooms.com/2_4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-proxy-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function getToken(): Promise<string> {
  const clientId = Deno.env.get("SEVENROOMS_CLIENT_ID");
  const clientSecret = Deno.env.get("SEVENROOMS_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Missing SevenRooms credentials");
  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  const res = await fetch(`${SR_BASE}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  const data = await res.json();
  const token = data?.data?.token ?? data?.token;
  if (!token) throw new Error("No token in auth response");
  return token;
}

// NOTE (16 Jun 2026): NO_ANSWER intentionally NOT excluded — SevenRooms live screen
// counts No Answer bookings, so excluding them under-counted the dashboard. Only real
// cancellations and no-shows are dropped. This applies to the dashboard/normal mode ONLY;
// the covers_actual (Closing Report) mode below is separate and uses COMPLETE-only.
const EXCLUDE = new Set(["CANCELED", "CANCELLED", "NO_SHOW"]);

async function fetchReservations(token: string, venueGroupId: string | undefined, from: string, to: string) {
  const all: any[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const url = new URL(`${SR_BASE}/reservations`);
    url.searchParams.set("from_date", from);
    url.searchParams.set("to_date", to);
    if (venueGroupId) url.searchParams.set("venue_group_id", venueGroupId);
    url.searchParams.set("limit", "400");
    if (cursor) url.searchParams.set("cursor", cursor);
    const r = await fetch(url.toString(), {
      method: "GET",
      headers: { "Authorization": token, "Accept": "application/json" },
    });
    if (!r.ok) throw new Error(`Reservations fetch failed: ${r.status}`);
    const j = await r.json();
    const results = j?.data?.results ?? [];
    all.push(...results);
    cursor = j?.data?.cursor ?? null;
    pages++;
  } while (cursor && pages < 6);
  return all;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  if (req.headers.get("x-proxy-secret") !== Deno.env.get("SEVENROOMS_PROXY_SECRET")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  try {
    const token = await getToken();
    const venueGroupId = Deno.env.get("SEVENROOMS_VENUE_GROUP_ID");
    const reqUrl = new URL(req.url);

    // ---- ACTUAL COVERS for one date: COMPLETE bookings, arrived_guests || max_guests ----
    const coversActual = reqUrl.searchParams.get("covers_actual");
    if (coversActual) {
      const rows = await fetchReservations(token, venueGroupId, coversActual, coversActual);
      let covers = 0, restaurant = 0, lounge = 0;
      let completed = 0;
      for (const r of rows) {
        if (String(r.status || "").toUpperCase() !== "COMPLETE") continue;
        completed++;
        const arrived = r.arrived_guests;
        const pax = (arrived != null && Number(arrived) > 0)
          ? Number(arrived)
          : (Number(r.max_guests) || 0);
        covers += pax;
        // Venue split: the "PIEMONTE" seating area is the Restaurant; every other
        // area (and anything unassigned) is Scala Lounge & Bar.
        const area = String(r.venue_seating_area_name || "").toUpperCase();
        if (area.includes("PIEMONTE")) restaurant += pax;
        else lounge += pax;
      }
      return new Response(JSON.stringify({
        ok: true, date: coversActual, covers,
        restaurant_covers: restaurant, lounge_covers: lounge,
        completed_bookings: completed,
      }, null, 2), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    // ---- UPCOMING MODE: booked / here / still-expected for one date ----
    // Returns three live numbers so the kitchen dashboard can show how many more
    // guests are still expected as the night goes on.
    //   booked   = all reservations excl. cancel/no-show (sum max_guests)
    //   here     = guests who have arrived/finished (ARRIVED/COMPLETE/PAID)
    //   upcoming = booked guests not yet arrived whose slot time is still ahead
    const upcoming = reqUrl.searchParams.get("upcoming");
    if (upcoming) {
      const rows = await fetchReservations(token, venueGroupId, upcoming, upcoming);
      // HERE    = has arrived at any point tonight (incl. already-departed) — the base
      //           for average-spend maths.
      // PRESENT = still physically in the venue right now: arrived/seated but NOT yet
      //           completed or paid-out. This is the dashboard "In now" figure.
      const HERE = new Set(["ARRIVED", "SEATED", "COMPLETE", "PAID"]);
      const PRESENT = new Set(["ARRIVED", "SEATED"]);
      const nowMs = Date.now();
      let booked = 0, here = 0, stillUpcoming = 0, seated = 0;
      for (const r of rows) {
        const st = String(r.status || "").toUpperCase();
        if (EXCLUDE.has(st)) continue;            // drop cancel / no-show
        const pax = Number(r.max_guests) || 0;
        booked += pax;
        if (PRESENT.has(st)) seated += pax;       // in the room right now
        if (HERE.has(st)) { here += pax; continue; }
        // not yet arrived — count as upcoming only if the slot time is still ahead
        const slot = r.real_datetime_of_slot;     // "YYYY-MM-DD HH:MM:SS" (venue local)
        let slotMs = NaN;
        if (slot) slotMs = Date.parse(slot.replace(" ", "T") + "+04:00"); // Dubai = UTC+4
        if (!isNaN(slotMs) && slotMs > nowMs) stillUpcoming += pax;
      }
      return new Response(JSON.stringify({
        ok: true, date: upcoming, booked, here, upcoming: stillUpcoming, seated,
      }, null, 2), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    // ---- COVER FLOW MODE: replica of SevenRooms' "Cover Flow" grid for one date ----
    // ?coverflow=YYYY-MM-DD → per 15-min slot: total covers + every party's size and
    // live state (upcoming / seated / completed), plus night totals. Deliberately
    // PII-free: sizes, slot times and statuses only — no names, phones or tables —
    // so it is safe on the kitchen wall screen. One aggregated payload per call.
    const coverflow = reqUrl.searchParams.get("coverflow");
    if (coverflow) {
      const rows = await fetchReservations(token, venueGroupId, coverflow, coverflow);
      const SEATED_NOW = new Set(["ARRIVED", "SEATED"]);
      const DONE = new Set(["COMPLETE", "PAID"]);
      const slots: Record<string, { size: number; state: string }[]> = {};
      let booked = 0, upcomingPax = 0, seatedPax = 0, completedPax = 0;
      for (const r of rows) {
        const st = String(r.status || "").toUpperCase();
        if (EXCLUDE.has(st)) continue;            // drop cancel / no-show
        const pax = Number(r.max_guests) || 0;
        const state = DONE.has(st) ? "completed" : SEATED_NOW.has(st) ? "seated" : "upcoming";
        booked += pax;
        if (state === "completed") completedPax += pax;
        else if (state === "seated") seatedPax += pax;
        else upcomingPax += pax;
        const slot = String(r.real_datetime_of_slot || "").slice(11, 16) || "?";
        (slots[slot] ||= []).push({ size: pax, state });
      }
      const outSlots = Object.keys(slots).sort().map((t) => ({
        t,
        covers: slots[t].reduce((s, p) => s + p.size, 0),
        parties: slots[t].sort((a, b) => b.size - a.size),
      }));
      return new Response(JSON.stringify({
        ok: true, date: coverflow,
        totals: { booked, upcoming: upcomingPax, seated: seatedPax, completed: completedPax },
        slots: outSlots,
      }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    // ---- FLOORPLAN MODE: who is sat where, for one date ----
    // ?floorplan=YYYY-MM-DD → one entry per reservation carrying its table
    // number(s), guest name, party size and live state. SevenRooms' API gives
    // table NUMBERS but never the map geometry, so the kitchen screen draws its
    // own floorplan and colours it from this feed.
    //
    // Unlike ?coverflow this DOES carry guest names — Francesco's explicit call
    // (22 Jul) so the brigade can see who is on which table, matching what the
    // hosts see in SevenRooms. Read-only: writes nothing.
    const floorplan = reqUrl.searchParams.get("floorplan");
    if (floorplan) {
      const rows = await fetchReservations(token, venueGroupId, floorplan, floorplan);
      const SEATED_NOW = new Set(["ARRIVED", "SEATED"]);
      const DONE = new Set(["COMPLETE", "PAID"]);
      const out: any[] = [];
      let seatedPax = 0, seatedTables = 0, unassigned = 0;
      for (const r of rows) {
        const st = String(r.status || "").toUpperCase();
        if (EXCLUDE.has(st)) continue;                  // drop cancel / no-show
        const tables = Array.isArray(r.table_numbers)
          ? r.table_numbers.map(String).filter(Boolean)
          : (r.table_numbers ? [String(r.table_numbers)] : []);
        // A booking with no table yet can't be placed on the map. Count it so the
        // screen can say so out loud rather than quietly losing a party.
        if (!tables.length) { unassigned++; continue; }
        const state = DONE.has(st) ? "completed" : SEATED_NOW.has(st) ? "seated" : "upcoming";
        const pax = Number(r.arrived_guests) > 0 ? Number(r.arrived_guests) : (Number(r.max_guests) || 0);
        if (state === "seated") { seatedPax += pax; seatedTables += tables.length; }
        out.push({
          tables,
          name: `${r.first_name || ""} ${r.last_name || ""}`.trim() || "Guest",
          pax, state,
          time: String(r.real_datetime_of_slot || "").slice(11, 16),
          area: r.venue_seating_area_name || null,
        });
      }
      return new Response(JSON.stringify({
        ok: true, date: floorplan,
        seated_pax: seatedPax, seated_tables: seatedTables, unassigned,
        reservations: out,
      }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    // ---- DAY SHEET MODE: the whole book for one date, as the hosts see it ----
    // ?daysheet=YYYY-MM-DD → one entry per reservation with everything the FOH
    // "Reservations" module shows: time, guest, covers, table, seating area,
    // status, notes, who booked it and when. Grouped by seating area with
    // per-area counts, so a manager gets the full picture of a night without
    // opening SevenRooms and without needing a SevenRooms seat.
    //
    // READ-ONLY, and deliberately NOT the full guest record:
    //   • phone is returned MASKED (last 4 digits only) — enough to match a guest
    //     on the phone, useless if the payload ever leaks. Never the full number.
    //   • email, address, loyalty and the marketing opt-ins are never returned.
    // The FOH side gates the whole module per user (app_users.modules), but the
    // masking happens HERE so the browser is never handed data it shouldn't hold.
    const daysheet = reqUrl.searchParams.get("daysheet");
    if (daysheet) {
      const rows = await fetchReservations(token, venueGroupId, daysheet, daysheet);
      const SEATED_NOW = new Set(["ARRIVED", "SEATED"]);
      const DONE = new Set(["COMPLETE", "PAID"]);
      const out: any[] = [];
      let covers = 0, seatedPax = 0, upcomingPax = 0, completedPax = 0;
      for (const r of rows) {
        const st = String(r.status || "").toUpperCase();
        if (EXCLUDE.has(st)) continue;                  // drop cancel / no-show
        const pax = Number(r.max_guests) || 0;
        const state = DONE.has(st) ? "completed" : SEATED_NOW.has(st) ? "seated" : "upcoming";
        covers += pax;
        if (state === "completed") completedPax += pax;
        else if (state === "seated") seatedPax += pax;
        else upcomingPax += pax;
        // The note a host would read off the booking. SevenRooms spreads this over
        // several fields and any of them can be empty, so join whichever exist and
        // label them the way the SevenRooms grid does. Line breaks are collapsed:
        // this lands in a single-line table cell, and a raw "\n" would show as a gap.
        //
        // `tags` is deliberately NOT included: verified 23 Jul against the live
        // book, it is an array of OBJECTS holding exactly the same tags that
        // reservation_type already gives us as readable text (Alberto = 2 tags /
        // 2 objects, Fatma = 3 / 3, and so on). Joining it printed "[object
        // Object]" on 6 of 13 bookings AND duplicated the text beside it.
        const clean = (v: unknown) => String(v).replace(/\s+/g, " ").trim();
        const noteBits: string[] = [];
        if (r.notes) noteBits.push(clean(r.notes));
        if (r.client_requests) noteBits.push("Guest: " + clean(r.client_requests));
        if (r.reservation_type) noteBits.push(clean(r.reservation_type));
        const tables = Array.isArray(r.table_numbers)
          ? r.table_numbers.map(String).filter(Boolean)
          : (r.table_numbers ? [String(r.table_numbers)] : []);
        // Money only if a check is actually linked — an unlinked booking must show
        // blank, never a misleading 0.
        const tickets = Array.isArray(r.pos_tickets) ? r.pos_tickets : [];
        let posTotal = 0;
        for (const t of tickets) posTotal += Number(t.total) || 0;
        const spend = posTotal || Number(r.total_payment) || Number(r.onsite_payment_total) || 0;
        const phone = String(r.phone_number || "").replace(/\D/g, "");
        out.push({
          time: String(r.real_datetime_of_slot || "").slice(11, 16) || String(r.arrival_time || ""),
          // clean() here too — a trailing space on first_name would otherwise
          // print "Standard  Chartered Bank" with a double gap.
          name: clean(`${r.first_name || ""} ${r.last_name || ""}`) || "Guest",
          pax,
          arrived: r.arrived_guests != null ? Number(r.arrived_guests) : null,
          tables,
          area: r.venue_seating_area_name || null,
          shift: r.shift_category || null,
          status: st,
          // What SevenRooms prints in its own STATUS column ("Do Not Move",
          // "Awaiting Cc Details"…). Falling back to the raw code would show
          // managers "CUSTOM_STATUS_27", which means nothing to anyone.
          status_display: r.status_display || r.status_simple || null,
          state,
          vip: !!r.is_vip,
          notes: noteBits.join(" · ") || null,
          booked_by: r.booked_by || null,
          created: r.created || null,
          minimum: Number(r.min_price) || null,
          spend: spend || null,
          served_by: r.served_by || null,
          phone_last4: phone ? phone.slice(-4) : null,
        });
      }
      out.sort((a, b) => String(a.time).localeCompare(String(b.time)));
      // Per-seating-area counts — the "PIEMONTE (9 reservations) - 33 covers"
      // header line the hosts read off the SevenRooms day view.
      const areaMap: Record<string, { area: string; reservations: number; covers: number }> = {};
      for (const r of out) {
        const k = r.area || "Any Seating Area";
        (areaMap[k] ||= { area: k, reservations: 0, covers: 0 });
        areaMap[k].reservations++;
        areaMap[k].covers += r.pax;
      }
      return new Response(JSON.stringify({
        ok: true, date: daysheet,
        totals: {
          reservations: out.length, covers,
          upcoming: upcomingPax, seated: seatedPax, completed: completedPax,
        },
        areas: Object.values(areaMap).sort((a, b) => b.covers - a.covers),
        reservations: out,
      }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    // ---- SPEND DIAGNOSTIC MODE (read-only): payment/POS fields for one date ----
    // ?spend=YYYY-MM-DD → per-reservation payment fields + pos_tickets, plus night totals.
    // Built 4 Jul 2026 to answer: is the SevenRooms "live spend" net or gross of the
    // 10% service / 7% municipality / 5% VAT stack? Compare pos_tickets subtotal/total
    // against a printed Simphony check.
    const spend = reqUrl.searchParams.get("spend");
    if (spend) {
      const rows = await fetchReservations(token, venueGroupId, spend, spend);
      const out: any[] = [];
      let sumTotalPayment = 0, sumNet = 0, sumGross = 0;
      let sumPosSubtotal = 0, sumPosTotal = 0, ticketCount = 0;
      for (const r of rows) {
        const st = String(r.status || "").toUpperCase();
        if (EXCLUDE.has(st)) continue;
        const tickets = Array.isArray(r.pos_tickets) ? r.pos_tickets : [];
        const hasMoney = tickets.length || r.total_payment || r.onsite_payment_total;
        if (!hasMoney) continue;
        let posSub = 0, posTot = 0;
        for (const t of tickets) {
          posSub += Number(t.subtotal) || 0;
          posTot += Number(t.total) || 0;
          ticketCount++;
        }
        sumPosSubtotal += posSub; sumPosTotal += posTot;
        sumTotalPayment += Number(r.total_payment) || 0;
        sumNet += Number(r.total_net_payment) || 0;
        sumGross += Number(r.total_gross_payment) || 0;
        out.push({
          name: `${r.first_name || ""} ${(r.last_name || "").slice(0, 1)}.`.trim(),
          // How the entry was created — WALK_IN vs booked etc. Proves whether
          // host-logged walk-ins auto-link their Simphony check (7 Jul analysis).
          reservation_type: r.reservation_type ?? null,
          booked_by: r.booked_by ?? null,
          status: st, table: r.table_numbers, guests: r.max_guests,
          arrived: r.arrived_guests, area: r.venue_seating_area_name,
          check_numbers: r.check_numbers,
          total_payment: r.total_payment,
          total_net_payment: r.total_net_payment,
          total_gross_payment: r.total_gross_payment,
          onsite_payment_net: r.onsite_payment_net,
          onsite_payment_tax: r.onsite_payment_tax,
          onsite_payment_gratuity: r.onsite_payment_gratuity,
          onsite_payment_total: r.onsite_payment_total,
          pos_subtotal: posSub || null, pos_total: posTot || null,
          // full ticket detail on the first 3 rows only, to keep the payload light
          pos_tickets: out.length < 3 ? tickets : `(${tickets.length} tickets)`,
        });
      }
      return new Response(JSON.stringify({
        ok: true, date: spend,
        reservations_with_money: out.length, tickets: ticketCount,
        totals: {
          pos_subtotal: sumPosSubtotal, pos_total: sumPosTotal,
          total_payment: sumTotalPayment, total_net_payment: sumNet,
          total_gross_payment: sumGross,
          implied_multiplier: sumPosSubtotal > 0 ? +(sumPosTotal / sumPosSubtotal).toFixed(5) : null,
        },
        rows: out,
      }, null, 2), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    // ---- DIAGNOSTIC MODE ----
    const diag = reqUrl.searchParams.get("diag");
    if (diag) {
      const rows = await fetchReservations(token, venueGroupId, diag, diag);
      let sumMax = 0, sumArrived = 0;
      const statusCounts: Record<string, number> = {};
      // Walk-in linkage analysis (7 Jul): per reservation_type, how many entries
      // exist and how many carry a linked POS check — proves whether host-logged
      // walk-ins auto-attach their Simphony check under the CURRENT config.
      const typeCounts: Record<string, { total: number; with_check: number; tables: string[] }> = {};
      for (const r of rows) {
        const st = String(r.status || "").toUpperCase();
        statusCounts[st] = (statusCounts[st] || 0) + 1;
        if (st === "COMPLETE") sumMax += Number(r.max_guests) || 0;
        if (r.arrived_guests != null) sumArrived += Number(r.arrived_guests) || 0;
        const rt = String(r.reservation_type || "UNKNOWN").toUpperCase();
        const bucket = (typeCounts[rt] ||= { total: 0, with_check: 0, tables: [] });
        bucket.total++;
        // An empty check_numbers array ([]) is truthy in JS, so test its length
        // when it's an array — otherwise a walk-in with NO check counts as linked
        // and inflates with_check, corrupting the exact answer this probe seeks.
        const checkCount = Array.isArray(r.check_numbers) ? r.check_numbers.length : (r.check_numbers ? 1 : 0);
        const hasCheck = !!(checkCount || (Array.isArray(r.pos_tickets) && r.pos_tickets.length));
        if (hasCheck) bucket.with_check++;
        if (bucket.tables.length < 12) {
          const t = Array.isArray(r.table_numbers) ? r.table_numbers.join("+") : String(r.table_numbers || "");
          bucket.tables.push(`${t || "?"}${hasCheck ? "✓" : "✗"}`);
        }
      }
      // Surface every time-like / status-like field name present on a sample row,
      // plus one full sample reservation, so we can build the "upcoming" filter.
      const sample = rows[0] || {};
      const timeFields: Record<string, any> = {};
      for (const k of Object.keys(sample)) {
        if (/time|arriv|seat|date|status|guest/i.test(k)) timeFields[k] = sample[k];
      }
      return new Response(JSON.stringify({
        ok: true, diag_date: diag, total: rows.length,
        complete_max_guests: sumMax, sum_arrived_guests: sumArrived,
        status_breakdown: statusCounts,
        reservation_type_breakdown: typeCounts,
        sample_time_status_fields: timeFields,
        sample_keys: Object.keys(sample),
      }, null, 2), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    // ---- NORMAL MODE: upcoming booked covers ----
    const today = new Date();
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const from = fmt(today);
    const to = fmt(new Date(today.getTime() + 6 * 86400000));
    const rows = await fetchReservations(token, venueGroupId, from, to);

    const covers: Record<string, number> = {};
    for (const resv of rows) {
      if (EXCLUDE.has(String(resv.status || "").toUpperCase())) continue;
      const date = resv.date;
      if (!date) continue;
      covers[date] = (covers[date] || 0) + (Number(resv.max_guests) || 0);
    }

    const now = new Date().toISOString();
    const outRows = Object.keys(covers).map((d) => ({
      service_date: d, night_covers: covers[d], day_covers: 0, updated_at: now,
    }));

    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { error } = await sb.from("covers").upsert(outRows, { onConflict: "service_date" });
    if (error) throw new Error(`DB upsert failed: ${error.message}`);

    return new Response(JSON.stringify({ ok: true, days: outRows.length, written: outRows }, null, 2),
      { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }),
      { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
