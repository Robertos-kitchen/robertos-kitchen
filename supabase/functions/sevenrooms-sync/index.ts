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

// NOTE (16 Jun 2026): NO_ANSWER intentionally NOT excluded -- SevenRooms live screen
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
      // HERE    = has arrived at any point tonight (incl. already-departed) -- the base
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
        // not yet arrived -- count as upcoming only if the slot time is still ahead
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
    // ?coverflow=YYYY-MM-DD -> per 15-min slot: total covers + every party's size and
    // live state (upcoming / seated / completed), plus night totals. Deliberately
    // PII-free: sizes, slot times and statuses only -- no names, phones or tables --
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
    // ?floorplan=YYYY-MM-DD -> one entry per reservation carrying its table
    // number(s), guest name, party size and live state. SevenRooms' API gives
    // table NUMBERS but never the map geometry, so the kitchen screen draws its
    // own floorplan and colours it from this feed.
    //
    // Unlike ?coverflow this DOES carry guest names -- Francesco's explicit call
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
    // ?daysheet=YYYY-MM-DD -> one entry per reservation with everything the FOH
    // "Reservations" module shows: time, guest, covers, table, seating area,
    // status, notes, who booked it and when. Grouped by seating area with
    // per-area counts, so a manager gets the full picture of a night without
    // opening SevenRooms and without needing a SevenRooms seat.
    //
    // READ-ONLY, and deliberately NOT the full guest record:
    //   * phone is returned MASKED (last 4 digits only) -- enough to match a guest
    //     on the phone, useless if the payload ever leaks. Never the full number.
    //   * email, address, loyalty and the marketing opt-ins are never returned.
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
        // Money only if a check is actually linked -- an unlinked booking must show
        // blank, never a misleading 0.
        const tickets = Array.isArray(r.pos_tickets) ? r.pos_tickets : [];
        let posTotal = 0;
        for (const t of tickets) posTotal += Number(t.total) || 0;
        const spend = posTotal || Number(r.total_payment) || Number(r.onsite_payment_total) || 0;
        const phone = String(r.phone_number || "").replace(/\D/g, "");
        out.push({
          time: String(r.real_datetime_of_slot || "").slice(11, 16) || String(r.arrival_time || ""),
          // clean() here too -- a trailing space on first_name would otherwise
          // print "Standard  Chartered Bank" with a double gap.
          name: clean(`${r.first_name || ""} ${r.last_name || ""}`) || "Guest",
          pax,
          arrived: r.arrived_guests != null ? Number(r.arrived_guests) : null,
          tables,
          area: r.venue_seating_area_name || null,
          shift: r.shift_category || null,
          status: st,
          // What SevenRooms prints in its own STATUS column ("Do Not Move",
          // "Awaiting Cc Details"...). Falling back to the raw code would show
          // managers "CUSTOM_STATUS_27", which means nothing to anyone.
          status_display: r.status_display || r.status_simple || null,
          state,
          vip: !!r.is_vip,
          // The separator is written as an escape, not a literal middot: this file has to survive being pasted
          // through a clipboard and a Notepad window to reach the Supabase
          // editor, and on 28 Jul that round-trip turned the literal character
          // into "A-middot" mojibake that then showed up in the note column on
          // the live screen. An escape is plain ASCII in the source and the
          // exact same character at runtime, so the trip can't corrupt it.
          notes: noteBits.join(" \u00b7 ") || null,
          booked_by: r.booked_by || null,
          created: r.created || null,
          minimum: Number(r.min_price) || null,
          spend: spend || null,
          served_by: r.served_by || null,
          phone_last4: phone ? phone.slice(-4) : null,
          // The key the FOH name-tap uses to ask ?guest= for this guest's
          // history. An opaque SevenRooms id -- no PII in it, and useless
          // without the proxy secret. Null on a booking with no client record
          // (the module simply doesn't make that name tappable).
          client: r.venue_group_client_id || r.client_id || null,
          // Which venue this booking belongs to. The guest's lifetime figures
          // MUST be read per-venue (see the ?guest= block), and the booking is
          // the only place that says which venue we're looking at -- so the
          // module passes this straight back rather than anything hardcoding a
          // venue id that would silently rot the day a second venue is added.
          venue: r.venue_id || null,
        });
      }
      out.sort((a, b) => String(a.time).localeCompare(String(b.time)));
      // Per-seating-area counts -- the "PIEMONTE (9 reservations) - 33 covers"
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

    // ---- GUEST PROFILE MODE: one guest's history, for the FOH name tap -------
    // ?guest=<client id> -> the aggregates the SevenRooms CLIENT profile shows --
    // total spend, visits, covers, average per cover, no-shows, cancellations --
    // plus the tags a manager needs on the floor ("Cigar Lover", "Don't move
    // from this table"). The daysheet hands the FOH module the id, so the app
    // never has to search for a guest: it asks for exactly the one whose name
    // was tapped.
    //
    // WHY THIS EXISTS: those aggregates are NOT on the reservation object --
    // ?spend= returns zero pos_tickets on every date tested -- so a lifetime
    // figure can only come from the client record. Verified 28 Jul against the
    // live book: of 25 guests on 27 Jul, 8 were repeat guests and all 8 carried
    // real spend (top AED42,386 / 145 visits). First-timers legitimately read 0.
    //
    // READ THE VENUE FIGURES, NOT THE GROUP TOTALS. This is the whole trap.
    // The client record's top-level total_spend / total_visits are GROUP-wide
    // and come from a different source than the profile page the hosts read.
    // For the guest booked in on 28 Jul the two disagreed badly -- group said
    // 70 visits / AED22,259, the SevenRooms page said 47 / AED62,715 -- and
    // shipping the group number would have put a figure on a manager's screen
    // that contradicts SevenRooms. `venue_stats[venue_id]` reconciles to the
    // page EXACTLY on every field (47 visits, AED62,715 net, AED72,275.60
    // gross, AED482.42 per cover, AED1,393.67 per visit, 16 no-shows, 12
    // cancellations), so that is what this returns whenever the caller says
    // which venue it is asking about. ?venue= comes from the booking itself.
    //
    // PRIVACY -- the point of doing this server-side. The client record holds
    // email, both phone numbers, home address, birthday, loyalty ids and the
    // marketing opt-ins. NONE of that is returned. Only the counting fields,
    // the tags, and the guest note a host would read off the booking. The
    // browser is never handed a guest record it could leak.
    const guest = reqUrl.searchParams.get("guest");
    if (guest) {
      const vgq = venueGroupId ? `?venue_group_id=${encodeURIComponent(venueGroupId)}` : "";
      const r = await fetch(`${SR_BASE}/clients/${encodeURIComponent(guest)}${vgq}`, {
        method: "GET",
        headers: { "Authorization": token, "Accept": "application/json" },
      });
      if (!r.ok) throw new Error(`Client fetch failed: ${r.status}`);
      const body = await r.json();
      const c = body?.data?.results?.[0] ?? body?.data ?? body;
      if (!c || typeof c !== "object") throw new Error("No client record");
      // Tags are the most useful thing on this panel for a floor manager
      // ("Cigar Lover", "Don't move from this table") and the hardest thing to
      // read out of this API. Verified 28 Jul: a first pass that assumed an
      // array of {tag_name} objects returned EMPTY for all 14 guests on the
      // book, while the SevenRooms UI showed tags on the same profiles -- so
      // the shape is one of the others below. Rather than guess again:
      //   * plain string                      -> itself
      //   * "groupid##Group##tag##Tag" hash   -> the last segment (SevenRooms'
      //     own encoding; the display name is always last)
      //   * {tag_name_display|tag_name|name}  -> that field
      //   * object keyed by tag group         -> walk the values
      // Anything unreadable is dropped rather than rendered as "[object
      // Object]", which is exactly what leaked into the daysheet note on 23 Jul.
      // VERIFIED SHAPE (28 Jul, live book): client_tags is an array where each
      // TAG is itself a small array of parts, and the parts vary in number:
      //   ["Custom Local Marketing Segmentation","CopyCustomAutotag16","Reservation Within the Past 7 Days","#BDE7FD"]
      //   ["Nationalities","Levantine","#88a5f5"]
      //   ["Group All Guests","#0ABCC2"]
      // The last part is the swatch colour and the part BEFORE it is what
      // SevenRooms prints on the profile. A first attempt flattened these and
      // returned the group name and the hex colour as if they were tags
      // ("Nationalities", "#88a5f5") -- hence the read-the-last-part rule below
      // rather than a blind recursive flatten.
      const isColour = (s: unknown) => typeof s === "string" && /^#[0-9A-Fa-f]{3,8}$/.test(s.trim());
      const oneTag = (v: unknown, depth = 0): string => {
        if (v == null || depth > 3) return "";
        if (typeof v === "string") {
          // Some venues encode the same thing as one "a##b##Name##colour" string.
          const parts = v.indexOf("##") > -1 ? v.split("##") : [v];
          return pickPart(parts);
        }
        if (Array.isArray(v)) return pickPart(v.map((x) => typeof x === "string" ? x : oneTag(x, depth + 1)));
        if (typeof v === "object") {
          const o = v as any;
          const named = o.tag_name_display || o.tag_name || o.name || o.display_name;
          return typeof named === "string" ? named.trim() : "";
        }
        return "";
      };
      // Drop the trailing colour, then take what's left at the end -- the
      // display name. A tag that is nothing but a colour is not a tag.
      const pickPart = (parts: string[]): string => {
        const p = parts.map((x) => String(x == null ? "" : x).trim()).filter(Boolean);
        while (p.length && isColour(p[p.length - 1])) p.pop();
        return p.length ? p[p.length - 1] : "";
      };
      const tagNames = (v: unknown): string[] =>
        Array.isArray(v) ? v.map((t) => oneTag(t)).filter(Boolean) : (oneTag(v) ? [oneTag(v)] : []);
      // ...and one more layer: what comes back per tag is itself a COMMA-JOINED
      // list ("Cigar Lover, DON'T MOVE FROM THIS TABLE, Rumba Regular"), so the
      // parts have to be split out or the panel renders one enormous tag.
      // A tag containing a real comma can't survive this -- but it can't survive
      // SevenRooms' own encoding either, which is what joined them.
      const tags: string[] = [];
      for (const raw of [...tagNames(c.client_tags), ...tagNames(c.tags), ...tagNames(c.member_groups)]) {
        for (const t of String(raw).split(/\s*,\s*/)) {
          const s = t.trim();
          if (s && tags.indexOf(s) === -1) tags.push(s);
        }
      }
      // If the walk STILL finds nothing, say what the raw fields actually were
      // so this can be settled without another deploy. Types and lengths only --
      // never the values, which could carry a guest's name.
      const shapeOf = (v: unknown) =>
        v == null ? "null" : Array.isArray(v) ? `array(${v.length})` : typeof v === "object" ? `object(${Object.keys(v as any).length})` : typeof v;
      const tags_shape = tags.length ? undefined : {
        client_tags: shapeOf(c.client_tags),
        tags: shapeOf(c.tags),
        member_groups: shapeOf(c.member_groups),
        client_tags_first_keys: Array.isArray(c.client_tags) && c.client_tags[0] && typeof c.client_tags[0] === "object"
          ? Object.keys(c.client_tags[0]) : undefined,
        tags_first_keys: Array.isArray(c.tags) && c.tags[0] && typeof c.tags[0] === "object"
          ? Object.keys(c.tags[0]) : undefined,
      };
      const num = (v: unknown) => { const n = Number(v); return isFinite(n) ? n : 0; };
      // Venue figures when the caller said which venue, group totals otherwise.
      // `scope` rides along in the payload so the app -- and anyone reading this
      // later -- can tell which of the two they are looking at, instead of the
      // silent mismatch that started this.
      const venueId = reqUrl.searchParams.get("venue");
      const vstats = (venueId && c.venue_stats && typeof c.venue_stats === "object")
        ? (c.venue_stats as any)[venueId] : null;
      const s: any = vstats || c;
      return new Response(JSON.stringify({
        ok: true,
        id: c.id || guest,
        scope: vstats ? "venue" : "group",
        visits: num(s.total_visits),
        covers: num(s.total_covers),
        spend: num(s.total_spend),
        gross: num(s.gross_total) || null,
        per_cover: num(s.total_spend_per_cover),
        per_visit: num(s.total_spend_per_visit),
        noshows: num(s.total_noshows),
        cancellations: num(s.total_cancellations),
        // Only the venue block carries this, and it is the single most useful
        // line on the panel: "last in on 3 Feb" tells a manager more than any
        // average does.
        last_visit: vstats ? (vstats.last_visit_date || null) : null,
        rating: num(s.avg_rating) || null,
        // The "Client Notes" line off the profile -- an allergy or a standing
        // preference belongs in front of the manager. private_notes is
        // deliberately NOT returned: it is the hosts' internal commentary.
        note: c.notes ? String(c.notes).replace(/\s+/g, " ").trim() : null,
        tags,
        tags_shape,
        // The raw venue_stats block is NOT returned: alongside the counting
        // fields it lists booked_by_names -- every host and channel that ever
        // took a booking for this guest -- which the floor has no need of.
        first_seen: c.created || null,
      }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    // ---- SPEND DIAGNOSTIC MODE (read-only): payment/POS fields for one date ----
    // ?spend=YYYY-MM-DD -> per-reservation payment fields + pos_tickets, plus night totals.
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
          // How the entry was created -- WALK_IN vs booked etc. Proves whether
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
      // exist and how many carry a linked POS check -- proves whether host-logged
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
        // when it's an array -- otherwise a walk-in with NO check counts as linked
        // and inflates with_check, corrupting the exact answer this probe seeks.
        const checkCount = Array.isArray(r.check_numbers) ? r.check_numbers.length : (r.check_numbers ? 1 : 0);
        const hasCheck = !!(checkCount || (Array.isArray(r.pos_tickets) && r.pos_tickets.length));
        if (hasCheck) bucket.with_check++;
        if (bucket.tables.length < 12) {
          const t = Array.isArray(r.table_numbers) ? r.table_numbers.join("+") : String(r.table_numbers || "");
          bucket.tables.push(`${t || "?"}${hasCheck ? "\u2713" : "\u2717"}`);
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
