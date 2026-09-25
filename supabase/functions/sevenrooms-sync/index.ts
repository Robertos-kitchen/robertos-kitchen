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

// ---- GUEST PROFILE (shared by ?guest= and ?guests=) ----------------------
// The aggregates the SevenRooms CLIENT profile shows -- total spend, visits,
// covers, average per cover, no-shows, cancellations -- plus the tags a manager
// needs on the floor ("Cigar Lover", "Don't move from this table") and the note
// on file.
//
// WHY THIS EXISTS: those aggregates are NOT on the reservation object -- the
// reservation only ever carries ITS OWN check, never the guest's history -- so a
// lifetime figure can only come from the client record. Verified 28 Jul against
// the live book:
//
// (Correcting an earlier note here that said "?spend= returns zero pos_tickets on
// every date tested". That is no longer true and reading it would send the next
// person the wrong way: re-probed 28 Jul, every trading night 18-25 Jul came back
// with real per-booking checks -- 24 Jul had 67 bookings / 73 tickets / AED
// 69,153.80. What IS true is that the most recent night can be empty: 27 Jul read
// zero on 28 Jul. SevenRooms links the checks on a delay; treat a blank latest
// night as "not posted yet", not as "no money".)
// of 25 guests on 27 Jul, 8 were repeat guests and all 8 carried real spend
// (top AED42,386 / 145 visits). First-timers legitimately read 0.
//
// READ THE VENUE FIGURES, NOT THE GROUP TOTALS. This is the whole trap. The
// client record's top-level total_spend / total_visits are GROUP-wide and come
// from a different source than the profile page the hosts read. For the guest
// booked in on 28 Jul the two disagreed badly -- group said 70 visits /
// AED22,259, the SevenRooms page said 47 / AED62,715 -- and shipping the group
// number would have put a figure on a manager's screen that contradicts
// SevenRooms. venue_stats[venue_id] reconciles to the page EXACTLY on every
// field (47 visits, AED62,715 net, AED72,275.60 gross, AED482.42 per cover,
// AED1,393.67 per visit, 16 no-shows, 12 cancellations), so that is what this
// returns whenever the caller says which venue it is asking about. The venue id
// comes off the booking, never hardcoded here.
//
// PRIVACY -- the point of doing this server-side. The client record holds
// email, both phone numbers, home address, birthday, loyalty ids and the
// marketing opt-ins. NONE of that is returned. Only the counting fields, the
// tags, and the guest note a host would read off the booking. The browser is
// never handed a guest record it could leak. The raw venue_stats block is also
// withheld: alongside the counting fields it lists booked_by_names, every host
// and channel that ever took a booking for this guest.

// Tags are the most useful thing on the panel and the hardest thing to read out
// of this API. VERIFIED SHAPE (28 Jul, live book): client_tags is an array where
// each TAG is itself a small array of parts, and the parts vary in number:
//   ["Custom Local Marketing Segmentation","CopyCustomAutotag16","Reservation Within the Past 7 Days","#BDE7FD"]
//   ["Nationalities","Levantine","#88a5f5"]
//   ["Group All Guests","#0ABCC2"]
// The last part is the swatch colour and the part BEFORE it is what SevenRooms
// prints on the profile. A first attempt flattened these and returned the group
// name and the hex colour as if they were tags ("Nationalities", "#88a5f5") --
// hence the read-the-last-part rule rather than a blind recursive flatten. Some
// venues encode the same thing as one "a##b##Name##colour" string, and older
// records use {tag_name_display}, so all three shapes are handled. Anything
// unreadable is dropped rather than rendered as "[object Object]", which is
// exactly what leaked into the daysheet note on 23 Jul.
const srIsColour = (s: unknown) => typeof s === "string" && /^#[0-9A-Fa-f]{3,8}$/.test(s.trim());

function srPickPart(parts: string[]): string {
  const p = parts.map((x) => String(x == null ? "" : x).trim()).filter(Boolean);
  while (p.length && srIsColour(p[p.length - 1])) p.pop();
  return p.length ? p[p.length - 1] : "";
}

function srOneTag(v: unknown, depth = 0): string {
  if (v == null || depth > 3) return "";
  if (typeof v === "string") return srPickPart(v.indexOf("##") > -1 ? v.split("##") : [v]);
  if (Array.isArray(v)) return srPickPart(v.map((x) => typeof x === "string" ? x : srOneTag(x, depth + 1)));
  if (typeof v === "object") {
    const o = v as any;
    const named = o.tag_name_display || o.tag_name || o.name || o.display_name;
    return typeof named === "string" ? named.trim() : "";
  }
  return "";
}

function srTagList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((t) => srOneTag(t)).filter(Boolean);
  const one = srOneTag(v);
  return one ? [one] : [];
}

// ---- A GUEST'S PAST VISITS -----------------------------------------------
// The per-visit history behind the "Last here" cell.
//
// WHERE IT COMES FROM, AND WHY NOT FROM THE OBVIOUS PLACE. The client record
// (/clients/{id}) does NOT carry it -- proved on the live account 1 Aug 2026
// with ?guestkeys=: 63 fields, three arrays (client_tags, member_groups,
// custom_fields), not one of them a reservation list. Nor does SevenRooms have
// a /clients/{id}/reservations, /visits, /reservation_history or /history --
// all four answer 404 (?visitprobe=). What works is the ordinary reservations
// endpoint filtered by client.
//
// THE FILTER NAME IS LOAD-BEARING AND IT WAS NEARLY WRONG. Three names all
// answered 200 with 30 rows for a real guest -- client_id, venue_group_client_id
// and `client`, the last of which is not a parameter at all. Re-running the
// probe with a NONSENSE id separated them: client_id returned 0 rows, the other
// two still returned 30. They are ignored, and a page of the venue's general
// book was coming back looking exactly like a guest's history. Anyone changing
// this: re-run ?visitprobe= with a fake id before trusting a row count.
const SR_VISIT_FROM = "2015-01-01";   // older than the venue; a real floor

function srDateOf(o: any): string | null {
  for (const k of ["date", "real_datetime_of_slot", "time_slot_iso", "arrival_time"]) {
    const v = o?.[k];
    if (typeof v === "string") {
      const iso = v.match(/\d{4}-\d{2}-\d{2}/);
      if (iso) return iso[0];
      const dmy = v.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
    }
  }
  return null;
}

// One visit, flattened to only what a host standing at a table needs. No email,
// phone, or client identifier rides along -- same privacy rule as ?guest=.
function srVisitRow(r: any) {
  const num = (v: unknown) => { const n = Number(v); return isFinite(n) ? n : 0; };
  const st = String(r.status || "").toUpperCase();
  // Same money rule as the daysheet: pos_tickets.subtotal is the menu-price
  // total, which in Dubai is the gross the guest actually paid. `total` carries
  // tips and does not sit on the tax stack. Using a different field here would
  // put two spend figures for one night in one app.
  const tickets = Array.isArray(r.pos_tickets) ? r.pos_tickets : [];
  let posSubtotal = 0;
  for (const t of tickets) posSubtotal += num(t.subtotal);
  return {
    date: srDateOf(r),
    covers: num(r.arrived_guests) || num(r.max_guests) || null,
    status: st || null,
    // A cancelled night stays on the list -- a guest who booked and cancelled is
    // not the same as one who never came, and the hosts read that difference in
    // SevenRooms. Flagged so it can never be rendered as a visit.
    cancelled: st.indexOf("CANCEL") > -1 || st.indexOf("NO_SHOW") > -1 || st.indexOf("NOSHOW") > -1,
    spend: posSubtotal || num(r.total_payment) || num(r.onsite_payment_total) || 0,
    tables: Array.isArray(r.table_numbers) ? r.table_numbers.map(String).filter(Boolean).join(", ")
      : (r.table_numbers ? String(r.table_numbers) : null),
  };
}

// ---- WHAT THEY ORDERED ---------------------------------------------------
// Simphony posts the itemised check to SevenRooms and it rides on the
// reservation as pos_tickets[].items -- name, price, quantity, modifiers, notes
// and the course. Verified 7 Aug 2026 on the live account: 5 Aug carried 28
// tickets over 27 bookings, every one of them itemised (table 32, check 18939:
// Bread Basket, Coke Btl x2, Burrata, Arrabbiata, Margherita, Choc-Choc).
//
// TIMING, AND WHY THE APP MUST NOT READ AN EMPTY LIST AS "ATE NOTHING".
// SevenRooms links the check on a delay -- 6 Aug's 39 tickets were all present
// by 05:49 the next morning, but 2 Aug never posted a single one and 27 Jul was
// still empty the following day. An empty items list therefore means "not
// posted (yet)", never "no order". The caller gets `items: null` in that case,
// which is a different thing from an empty array, and the app says so in words.
//
// The course separators Simphony writes as check lines ("1st____________",
// "2nd Pick Up") are kitchen firing instructions at price 0, not something the
// guest ate. They are dropped here so a manager reads a menu, not a POS tape.
// Only zero-priced lines that OPEN with an ordinal are dropped -- a real dish at
// price 0 (the bread basket, the Arabic coffee) stays on the list, because a
// comped or included item is exactly the kind of thing a manager wants to see.
const SR_COURSE_MARKER = /^\d+(st|nd|rd|th)\b/i;

function srCheckItems(r: any) {
  const tickets = Array.isArray(r.pos_tickets) ? r.pos_tickets : [];
  const items: any[] = [];
  let open = false;
  for (const t of tickets) {
    if (String(t?.status || "").toLowerCase() === "open") open = true;
    const lines = Array.isArray(t?.items) ? t.items : [];
    for (const it of lines) {
      // The underscores are padding Simphony uses to make the separator span the
      // printed check; collapsing whitespace also handles the trailing spaces
      // that would otherwise print as a gap in a single-line cell.
      const name = String(it?.name || "").replace(/_+/g, " ").replace(/\s+/g, " ").trim();
      if (!name) continue;
      // `price` IS THE LINE TOTAL, NOT THE UNIT PRICE. Reconciled 7 Aug 2026
      // against three checks from 6 Aug: 18979 (713), 18968 (660), 18974 (525)
      // each tie EXACTLY to the sum of their item prices as they stand, and
      // 18979's "2 x Elysium GL" carries a single 150 for the pair. Multiplying
      // by quantity turned that 713 check into 983. Never multiply this field.
      const price = Number(it?.price) || 0;
      const qty = Number(it?.quantity) || 1;
      if (!price && SR_COURSE_MARKER.test(name)) continue;
      // Modifiers arrive either as objects or as plain strings depending on how
      // the item was rung in; both reduce to the words a manager reads.
      const mods = (Array.isArray(it?.modifiers) ? it.modifiers : [])
        .map((m: any) => String((m && (m.name ?? m)) || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const note = String(it?.notes || "").replace(/\s+/g, " ").trim();
      items.push({
        name,
        qty,
        // The line total. Named plainly so nothing downstream is tempted to
        // multiply it -- see the note above.
        price,
        mods: mods.length ? mods : null,
        note: note || null,
      });
    }
  }
  // Identical lines rung in separately read as noise on a screen ("Margherita"
  // three times over). Merged on the dish, its modifiers and its note --
  // deliberately NOT on price, because two identical lines can carry different
  // amounts (one comped, one not) and keying on price would split them back
  // apart. Quantities AND prices are added, which keeps the merged list summing
  // to the same check total as the unmerged one.
  const merged: any[] = [];
  const seen: Record<string, any> = {};
  for (const it of items) {
    const k = it.name + "|" + (it.mods ? it.mods.join(",") : "") + "|" + (it.note || "");
    if (seen[k]) { seen[k].qty += it.qty; seen[k].price += it.price; continue; }
    seen[k] = it;
    merged.push(it);
  }
  return { items: merged.length ? merged : null, open };
}

// Days added to (or subtracted from) a YYYY-MM-DD date, in UTC so a Dubai clock
// never shifts the window by a day.
function srShiftDate(day: string, days: number): string {
  const t = Date.parse(day + "T00:00:00Z");
  if (!isFinite(t)) return day;
  return new Date(t + days * 86400000).toISOString().slice(0, 10);
}

async function guestVisits(
  token: string,
  venueGroupId: string | undefined,
  clientId: string,
  venueId: string | null,
  before: string | null,
  // The guest's last known visit, off the client record the caller has already
  // read. Used only to place the first window -- see below. Optional: without it
  // the window is placed on the night being viewed, which is right for anyone
  // who has been in recently and merely costs a second call for anyone who
  // hasn't.
  anchor: string | null = null,
) {
  // TWO THINGS ABOUT THIS ENDPOINT, BOTH MEASURED, BOTH LOAD-BEARING.
  //
  // 1. IT RETURNS A CLIENT'S RESERVATIONS IN NO DATE ORDER WHATSOEVER. Measured
  //    20 Aug 2026 with ?visitpage= on the Chairman's record (1,038 rows over 3
  //    pages at limit=400): page 1 opened 2023-05-05, 2023-05-05, 2023-05-04,
  //    2023-05-03, 2023-05-15 and closed on 2020, 2017, 2015. His three most
  //    recent nights were on pages 2 and 3.
  //
  //    So reading page one and sorting it is not "the newest visits, roughly" --
  //    it is an arbitrary 400 of 1,038, sorted. His panel showed 11 May 2026,
  //    9 May 2026 and then fell off a cliff to 15 May 2023, while the stats
  //    block two lines above it correctly read "Last visit 23 June". Two
  //    contradicting answers on one card. It stayed invisible for so long
  //    because a guest with fewer than 400 lifetime bookings fits in one page,
  //    so for almost everyone the old code was accidentally right.
  //
  //    (An earlier note here guessed a hard 30-row page. That was wrong: 30 is
  //    only the DEFAULT when no limit is sent. `limit` is honoured.)
  //
  // 2. READING THE WHOLE HISTORY TO FIX IT COSTS TEN SECONDS. 1,038 rows carry
  //    their pos_tickets with them; three sequential pages measured 9.9-10.8s.
  //    That is a manager standing at a table waiting for a panel.
  //
  // THE WINDOW IS THE ANSWER. This list is never more than 12 nights, so it does
  // not need eleven years of history -- it needs the most recent twelve months,
  // which for the same guest is 45 rows in ONE page in 1.6s. The window is
  // placed on his LAST KNOWN VISIT rather than on tonight, so a heavy guest who
  // has been away for six months is still answered in one call. Only if twelve
  // months genuinely does not hold twelve visits do we fall back to the full
  // history -- which is cheap precisely because that guest has little of it.
  const to = before || new Date().toISOString().slice(0, 10);
  const WANT = 12;

  const readWindow = async (from: string) => {
    const rows: any[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url = new URL(`${SR_BASE}/reservations`);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("from_date", from);
      // Everything strictly BEFORE the night being viewed. Tonight is excluded at
      // the source, because SevenRooms writes today into a guest's history the
      // moment they are seated -- which is the whole reason this exists. Passing
      // the VIEWED date rather than today also keeps it honest when a manager is
      // looking back at an old book: they see what was true then, not what is
      // true now.
      url.searchParams.set("to_date", to);
      url.searchParams.set("limit", "400");
      if (venueGroupId) url.searchParams.set("venue_group_id", venueGroupId);
      if (cursor) url.searchParams.set("cursor", cursor);
      const r = await fetch(url.toString(), {
        method: "GET", headers: { "Authorization": token, "Accept": "application/json" },
      });
      if (!r.ok) throw new Error(`Visits fetch failed: ${r.status}`);
      const b = await r.json();
      const d = b?.data ?? b;
      const page: any[] = Array.isArray(d) ? d : (Array.isArray(d?.results) ? d.results : []);
      rows.push(...page);
      // The cursor still gets walked inside a window. A window is a speed
      // measure, never a correctness one -- point 1 above means a truncated
      // window would hand back an arbitrary slice all over again.
      cursor = (d && typeof d === "object" ? d.cursor : null) ?? null;
      pages++;
    } while (cursor && pages < 6);
    return rows
      // Scoped to the venue they are sitting in tonight, matching the stats block
      // above it in the panel. A panel that counts 47 visits at this venue and
      // then lists three from another one is a panel that gets argued with.
      .filter((x) => !venueId || String(x.venue_id || "") === venueId)
      .map(srVisitRow)
      .filter((v) => v.date && (!before || v.date < before))
      .sort((a, b2) => (a.date! < b2.date! ? 1 : a.date! > b2.date! ? -1 : 0))
      .slice(0, WANT);
  };

  const anchorDay = anchor ? String(anchor).slice(0, 10) : "";
  const recentFrom = srShiftDate(/^\d{4}-\d{2}-\d{2}$/.test(anchorDay) && anchorDay < to ? anchorDay : to, -365);
  if (recentFrom > SR_VISIT_FROM) {
    const recent = await readWindow(recentFrom);
    if (recent.length >= WANT) return recent;
    // Short of twelve. Either they are an occasional guest, or they are a
    // regular whose history starts inside the window -- and the full read that
    // settles it is cheap in both cases.
  }
  return await readWindow(SR_VISIT_FROM);
}
async function guestProfile(
  token: string,
  venueGroupId: string | undefined,
  id: string,
  venueId: string | null,
  // Visit lists are for the ONE guest whose panel is open. The batch mode below
  // reads every guest on the night in a single call, and 35 guests x 12 visits
  // would multiply that payload for a list nothing on the table renders --
  // straight onto the module's first paint, on a phone, on the floor.
  withVisits = false,
  // The night being viewed. Visits are returned strictly before it.
  before: string | null = null,
) {
  const vgq = venueGroupId ? `?venue_group_id=${encodeURIComponent(venueGroupId)}` : "";
  const r = await fetch(`${SR_BASE}/clients/${encodeURIComponent(id)}${vgq}`, {
    method: "GET",
    headers: { "Authorization": token, "Accept": "application/json" },
  });
  if (!r.ok) throw new Error(`Client fetch failed: ${r.status}`);
  const body = await r.json();
  const c = body?.data?.results?.[0] ?? body?.data ?? body;
  if (!c || typeof c !== "object") throw new Error("No client record");

  // Each tag arrives as a COMMA-JOINED list ("Cigar Lover, DON'T MOVE FROM THIS
  // TABLE, Rumba Regular"), so the parts are split out or the panel renders one
  // enormous tag. A tag containing a real comma cannot survive this -- but it
  // cannot survive SevenRooms' own encoding either, which is what joined them.
  const tags: string[] = [];
  for (const raw of [...srTagList(c.client_tags), ...srTagList(c.tags), ...srTagList(c.member_groups)]) {
    for (const t of String(raw).split(/\s*,\s*/)) {
      const s = t.trim();
      if (s && tags.indexOf(s) === -1) tags.push(s);
    }
  }

  const num = (v: unknown) => { const n = Number(v); return isFinite(n) ? n : 0; };
  // A second call, and only for the one guest whose panel is open. It must never
  // take the panel down with it: the lifetime figures, tags and note below are
  // read from the client record and are still true if the visit list fails, so
  // a failure here degrades to "no list" instead of an error where a manager
  // wanted a guest.
  // Read BEFORE the visit list, not after: guestVisits places its first window
  // on the guest's last known visit, so a heavy guest who has been away a while
  // is still answered in one call instead of an eleven-year read.
  const vstats = (venueId && c.venue_stats && typeof c.venue_stats === "object")
    ? (c.venue_stats as any)[venueId] : null;
  const s: any = vstats || c;
  const lastKnown: string | null =
    (vstats && (vstats.last_visit_date as string)) || ((c as any).last_visit_date as string) || null;

  let visitList: any[] = [];
  let visitsOk = false;
  if (withVisits) {
    try {
      visitList = await guestVisits(token, venueGroupId, id, venueId, before, lastKnown);
      visitsOk = true;
    } catch (e) {
      console.warn("[sevenrooms-sync] visits failed", String(e).slice(0, 160));
    }
  }
  return {
    id: c.id || id,
    // `scope` rides along so the app -- and anyone reading this later -- can
    // tell which of the two measures they are looking at, instead of the silent
    // mismatch that started this.
    scope: vstats ? "venue" : "group",
    visits: num(s.total_visits),
    covers: num(s.total_covers),
    spend: num(s.total_spend),
    gross: num(s.gross_total) || null,
    per_cover: num(s.total_spend_per_cover),
    per_visit: num(s.total_spend_per_visit),
    noshows: num(s.total_noshows),
    cancellations: num(s.total_cancellations),
    // Only the venue block carries this, and it is the single most useful line
    // on the panel: when they were last in tells a manager more than any
    // average does.
    last_visit: vstats ? (vstats.last_visit_date || null) : null,
    rating: num(s.avg_rating) || null,
    // The "Client Notes" line off the profile -- an allergy or a standing
    // preference belongs in front of the manager. private_notes is deliberately
    // NOT returned: it is the hosts' internal commentary.
    note: c.notes ? String(c.notes).replace(/\s+/g, " ").trim() : null,
    tags,
    first_seen: c.created || null,
    // The per-visit history behind the "Last here" cell. Newest first, and the
    // caller decides how many to show -- the app asks for 3, but capping at the
    // source would make this useless for anything else later.
    //
    // `visits_have` says the LOOKUP SUCCEEDED, not that the list is non-empty.
    // The two look identical once the array is empty, and the app needs to tell
    // them apart: printing "no previous visits" at a guest with 63 of them
    // because a call failed is the kind of wrong that gets a screen switched off.
    visits_have: visitsOk,
    visits_recent: visitList,
  };
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
    //
    // ---- &include=all : the cancellations and no-shows, ON REQUEST ----------
    // Added 31 Jul 2026 for the FOH Reservation Reports module (Nicole's
    // cancellation list and no-show rate).
    //
    // THE BACKGROUND. SevenRooms sends us every cancellation and no-show in
    // full -- name, time, table, party size, channel, phone, client id, the lot.
    // This mode threw them away, because it was written to put TONIGHT'S SERVICE
    // on a manager's screen and a cancelled table is not part of tonight's
    // service. Reconciled 30 Jul 2026: the raw feed held 55 rows (45 COMPLETE,
    // 8 NO_SHOW, 2 CANCELED) and this mode returned 45. The 10 were never
    // missing from SevenRooms; we dropped them.
    //
    // WHY A FLAG AND NOT A CHANGE. The Reservations book, the closing report and
    // the Live-now strip all read this mode and all mean "the night that
    // happened". Returning cancellations to them unasked would inflate every
    // count on every one of those screens. So the default is byte-for-byte what
    // it always was, and a caller has to ask.
    //
    // WHAT THE FLAG DOES *NOT* DO: it never adds a cancelled or no-show booking
    // to `covers` or to any figure in `totals` or `areas`. Those keep counting
    // the night that actually happened, so a caller who passes the flag and then
    // reads totals gets the same numbers as one who did not. The extra rows
    // arrive with state "cancelled" / "noshow" and are the caller's to count.
    //
    // `includes_cancelled` IS THE POINT OF THE ECHO. An older deployment of this
    // function ignores an unknown query parameter and answers 200 with a normal
    // payload -- so a no-show report built against it would print "0 no-shows"
    // and look like good news. The app checks this field and refuses to draw the
    // report unless it is true. Do not remove it: silence would become a zero.
    const daysheet = reqUrl.searchParams.get("daysheet");
    if (daysheet) {
      const includeAll = String(reqUrl.searchParams.get("include") || "").toLowerCase() === "all";
      const rows = await fetchReservations(token, venueGroupId, daysheet, daysheet);
      const SEATED_NOW = new Set(["ARRIVED", "SEATED"]);
      const DONE = new Set(["COMPLETE", "PAID"]);
      const NOSHOW = new Set(["NO_SHOW"]);
      const out: any[] = [];
      let covers = 0, seatedPax = 0, upcomingPax = 0, completedPax = 0;
      for (const r of rows) {
        const st = String(r.status || "").toUpperCase();
        const dropped = EXCLUDE.has(st);                 // cancel / no-show
        if (dropped && !includeAll) continue;
        const pax = Number(r.max_guests) || 0;
        const state = dropped
          ? (NOSHOW.has(st) ? "noshow" : "cancelled")
          : (DONE.has(st) ? "completed" : SEATED_NOW.has(st) ? "seated" : "upcoming");
        // A booking that never happened is not a cover. Every total below stays
        // exactly as it was before this flag existed.
        if (!dropped) {
          covers += pax;
          if (state === "completed") completedPax += pax;
          else if (state === "seated") seatedPax += pax;
          else upcomingPax += pax;
        }
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
        //
        // TWO figures, and the difference matters (found 28 Jul 2026 while building
        // the Reservations spend column for Nicole):
        //   subtotal = the MENU-PRICE total. Menu prices in Dubai are tax-inclusive,
        //              so this is the GROSS the guest actually paid, and it is the
        //              only figure that sits on the verified stack -- net = / 1.225
        //              (10% service + 7% municipality on net, 5% VAT on net+SC).
        //   total    = subtotal plus whatever extra was added on the check (tips).
        //              It does NOT hold a constant relationship to subtotal -- on
        //              24 Jul, per booking, 388 -> 390 and 262.40 -> 278.40, and the
        //              night's implied multiplier moved 1.010 / 1.049 / 1.012 across
        //              23-25 Jul. Dividing IT by 1.225 gives a net that is quietly
        //              wrong by the size of the tip, which is exactly the kind of
        //              number that ends up in a report.
        // So `gross` (subtotal) is what the app shows and divides. `spend` keeps its
        // old meaning so nothing already reading it changes underneath.
        const tickets = Array.isArray(r.pos_tickets) ? r.pos_tickets : [];
        let posTotal = 0, posSubtotal = 0;
        for (const t of tickets) {
          posTotal += Number(t.total) || 0;
          posSubtotal += Number(t.subtotal) || 0;
        }
        const spend = posTotal || Number(r.total_payment) || Number(r.onsite_payment_total) || 0;
        // total_payment reconciles to subtotal (verified 24 Jul: both 69,153.80 for
        // the night), so it is the right fallback when a booking carries payment
        // without an itemised ticket.
        const gross = posSubtotal || Number(r.total_payment) || Number(r.onsite_payment_total) || 0;
        // The check itself, line by line -- see srCheckItems for the timing rule
        // and why a missing list is null and never an empty array.
        const check = srCheckItems(r);
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
          gross: gross || null,
          // What they ordered. Null until Simphony's check is linked, which is
          // NOT the same as an empty order -- the app must never turn this into
          // "they had nothing". Prices ride along and the app hides them from
          // anyone without Revenue access, the same rule the spend column follows.
          items: check.items,
          // True while a ticket on this booking is still open in Simphony, so a
          // manager reading it mid-service knows the list can still grow.
          check_open: check.open || null,
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
      // A cancelled table occupied no seating area, so it is not counted here
      // either -- see the &include=all note above: the extra rows never move a
      // number that already existed.
      const areaMap: Record<string, { area: string; reservations: number; covers: number }> = {};
      for (const r of out) {
        if (r.state === "cancelled" || r.state === "noshow") continue;
        const k = r.area || "Any Seating Area";
        (areaMap[k] ||= { area: k, reservations: 0, covers: 0 });
        areaMap[k].reservations++;
        areaMap[k].covers += r.pax;
      }
      // Night money totals -- counted over the bookings that ACTUALLY carry a
      // linked check, and the counts are returned alongside so the app can say how
      // much of the night the figure covers. This total is always SHORT of the
      // Simphony night: a walk-in served without a booking has no reservation to
      // hang a check on. Measured against rev_daily 20-25 Jul 2026 it ran 83-98%
      // of Simphony net and the gap moved night to night, so it must never be
      // presented as the night's revenue. The app labels it; do not strip that.
      let grossTotal = 0, coversWithMoney = 0, bookingsWithMoney = 0;
      for (const r of out) {
        if (r.state === "cancelled" || r.state === "noshow") continue;
        if (!r.gross) continue;
        grossTotal += r.gross;
        coversWithMoney += r.pax;
        bookingsWithMoney++;
      }
      // Counted, not out.length: with &include=all the array also carries the
      // cancellations and no-shows, and "Reservations" on the FOH screen means
      // the night that happened. Without the flag these are identical.
      const served = out.filter((r) => r.state !== "cancelled" && r.state !== "noshow");
      return new Response(JSON.stringify({
        ok: true, date: daysheet,
        // Echoed so a caller can tell "this deployment honoured the flag" from
        // "this deployment is older and ignored it". See the note above.
        includes_cancelled: includeAll,
        totals: {
          reservations: served.length, covers,
          upcoming: upcomingPax, seated: seatedPax, completed: completedPax,
          gross: grossTotal || null,
          covers_with_money: coversWithMoney || null,
          bookings_with_money: bookingsWithMoney || null,
        },
        areas: Object.values(areaMap).sort((a, b) => b.covers - a.covers),
        reservations: out,
      }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    // ---- GUEST PROFILE MODE: one guest, for the FOH name tap -----------------
    // ?guest=<client id>&venue=<venue id> -> that guest's history. See
    // guestProfile() above for what is and is not returned, and why the venue
    // figures are the only ones safe to show.
    // ---- GUEST RECORD SHAPE PROBE: ?guestkeys=<client id> --------------------
    // Not used by the app. It exists because SevenRooms' API docs are behind an
    // account login, so the only way to know what /clients actually returns is
    // to ask it. Prints FIELD NAMES and array sizes only -- never a value, so it
    // cannot leak a guest. If the visits list ever comes back empty for a guest
    // who plainly has history, this says whether the list is absent or just
    // under a name the finder does not recognise.
    const guestKeys = reqUrl.searchParams.get("guestkeys");
    if (guestKeys) {
      const vgq = venueGroupId ? `?venue_group_id=${encodeURIComponent(venueGroupId)}` : "";
      const rk = await fetch(`${SR_BASE}/clients/${encodeURIComponent(guestKeys)}${vgq}`, {
        method: "GET", headers: { "Authorization": token, "Accept": "application/json" },
      });
      const bk = await rk.json();
      const ck = bk?.data?.results?.[0] ?? bk?.data ?? bk;
      const arrays: Record<string, any> = {};
      for (const k of Object.keys(ck || {})) {
        const v = (ck as any)[k];
        if (Array.isArray(v)) {
          arrays[k] = {
            length: v.length,
            // First entry's KEYS only. A reservation history announces itself by
            // carrying a date field; this is what tells us which array it is.
            first_row_keys: v[0] && typeof v[0] === "object" ? Object.keys(v[0]) : typeof v[0],
          };
        }
      }
      return new Response(JSON.stringify({
        ok: true, status: rk.status,
        record_keys: Object.keys(ck || {}),
        arrays,
      }, null, 2), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    // ---- WHERE DOES A GUEST'S VISIT HISTORY LIVE? ?visitprobe=<client id> ----
    // Settled 1 Aug 2026 by ?guestkeys= above: /clients/{id} returns 63 fields
    // and NOT ONE of them is a reservation list -- so the per-visit history the
    // hosts read on the SevenRooms profile screen comes from somewhere else.
    // This asks every plausible somewhere in one call and reports what answers.
    //
    // Field names and row counts only, never a value. Deliberately kept after
    // the answer is known: the next person to ask "can we get X from SevenRooms"
    // should re-run this rather than guess, because the docs are account-gated.
    const visitProbe = reqUrl.searchParams.get("visitprobe");
    if (visitProbe) {
      const vg = venueGroupId || "";
      const id = encodeURIComponent(visitProbe);
      // A date window on the /reservations attempts because that endpoint has
      // always demanded one -- without it a 400 would look like "no such filter"
      // when it really means "you forgot the dates".
      const win = "from_date=2015-01-01&to_date=2026-12-31";
      const candidates = [
        `/clients/${id}/reservations`,
        `/clients/${id}/visits`,
        `/clients/${id}/reservation_history`,
        `/clients/${id}/history`,
        `/reservations?client_id=${id}&${win}`,
        `/reservations?venue_group_client_id=${id}&${win}`,
        `/reservations?client=${id}&${win}`,
        `/reservations?client_id=${id}`,
      ];
      const results: any[] = [];
      for (const path of candidates) {
        const url = new URL(SR_BASE + path);
        if (vg && !url.searchParams.get("venue_group_id")) url.searchParams.set("venue_group_id", vg);
        try {
          const r = await fetch(url.toString(), {
            method: "GET", headers: { Authorization: token, Accept: "application/json" },
          });
          let rows: any = null, sampleKeys: any = null;
          if (r.ok) {
            const b = await r.json();
            const d = b?.data ?? b;
            const arr = Array.isArray(d) ? d : (Array.isArray(d?.results) ? d.results : null);
            rows = arr ? arr.length : null;
            sampleKeys = arr && arr[0] && typeof arr[0] === "object" ? Object.keys(arr[0]).slice(0, 25) : null;
          }
          results.push({ path: path.replace(id, "<id>"), status: r.status, ok: r.ok, rows, sampleKeys });
        } catch (e) {
          results.push({ path: path.replace(id, "<id>"), status: "threw", error: String(e).slice(0, 120) });
        }
      }
      return new Response(JSON.stringify({
        ok: true,
        answered: results.filter((x) => x.ok && x.rows).map((x) => x.path),
        results,
      }, null, 2), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    // ---- ?visitpage=<client id> -- HOW DOES THE VISIT LIST ACTUALLY PAGE? ---
    // guestVisits asked for limit=400 and its comment assumed "one page holds a
    // whole history". A guest with 1,002 venue visits came back with 30 rows and
    // a panel that jumped from May 2026 straight to May 2023, so both the page
    // size and the row ORDER have to be facts before the fix is written.
    //
    // Same discipline as the probes above: COUNTS, DATES and whether a cursor
    // came back. Never a guest field.
    const visitPage = reqUrl.searchParams.get("visitpage");
    if (visitPage) {
      const pages: any[] = [];
      let cursor: string | null = null;
      let n = 0;
      do {
        const url = new URL(`${SR_BASE}/reservations`);
        url.searchParams.set("client_id", visitPage);
        url.searchParams.set("from_date", reqUrl.searchParams.get("from") || SR_VISIT_FROM);
        url.searchParams.set("to_date", reqUrl.searchParams.get("to") || new Date().toISOString().slice(0, 10));
        url.searchParams.set("limit", reqUrl.searchParams.get("limit") || "400");
        if (venueGroupId) url.searchParams.set("venue_group_id", venueGroupId);
        if (cursor) url.searchParams.set("cursor", cursor);
        const r = await fetch(url.toString(), {
          method: "GET", headers: { "Authorization": token, "Accept": "application/json" },
        });
        if (!r.ok) { pages.push({ page: n, status: r.status }); break; }
        const b = await r.json();
        const rows: any[] = b?.data?.results ?? [];
        const dates = rows.map((x) => srDateOf(x)).filter(Boolean) as string[];
        const sorted = [...dates].sort();
        pages.push({
          page: n,
          rows: rows.length,
          cursor_returned: !!(b?.data?.cursor),
          data_keys: Object.keys(b?.data ?? {}),
          total_field: b?.data?.total ?? null,
          raw_order_first5: dates.slice(0, 5),
          raw_order_last5: dates.slice(-5),
          oldest: sorted[0] ?? null,
          newest: sorted[sorted.length - 1] ?? null,
        });
        cursor = b?.data?.cursor ?? null;
        n++;
      } while (cursor && n < 40);
      return new Response(JSON.stringify({ ok: true, pages_read: n, exhausted: !cursor, pages }, null, 2), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const guest = reqUrl.searchParams.get("guest");
    if (guest) {
      const p = await guestProfile(token, venueGroupId, guest, reqUrl.searchParams.get("venue"), true,
        reqUrl.searchParams.get("before"));
      return new Response(JSON.stringify({ ok: true, ...p }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // ---- GUEST BATCH MODE: the whole book's guests in ONE call ----------------
    // ?guests=<id,id,id>&venue=<venue id> -> { guests: { id: profile } }
    //
    // Asked for by Francesco 28 Jul: the Reservations table shows each guest's
    // last visit and average spend per person, and the print brief needs the
    // same for every booking on the night. Doing that per row would mean one
    // request per booking -- 47 on last Sunday -- from a phone on the floor.
    // One call instead, and the app caches the answer for the date.
    //
    // Chunked rather than one big Promise.all: a busy night would otherwise open
    // 47 simultaneous connections to SevenRooms and invite a rate-limit, which
    // would fail the whole brief instead of one guest. A guest whose record
    // cannot be read is simply absent from the map -- the app already renders a
    // row with no history, so a partial answer degrades instead of breaking.
    const guests = reqUrl.searchParams.get("guests");
    if (guests) {
      const seen: Record<string, boolean> = {};
      const ids = guests.split(",").map((s) => s.trim()).filter((s) => {
        if (!s || seen[s]) return false;      // the same guest can hold two
        seen[s] = true;                        // bookings on one night
        return true;
      }).slice(0, 120);                        // hard cap: no unbounded fan-out
      const venueId = reqUrl.searchParams.get("venue");
      const out: Record<string, unknown> = {};
      let failed = 0;
      for (let i = 0; i < ids.length; i += 8) {
        const chunk = ids.slice(i, i + 8);
        const res = await Promise.all(chunk.map((id) =>
          guestProfile(token, venueGroupId, id, venueId).catch(() => null)
        ));
        chunk.forEach((id, j) => { if (res[j]) out[id] = res[j]; else failed++; });
      }
      return new Response(JSON.stringify({
        ok: true,
        requested: ids.length,
        returned: Object.keys(out).length,
        // Named so a partial answer is visible to the caller rather than
        // silently looking like "these guests have no history".
        failed,
        guests: out,
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

    // ---- CLIENT CHECK (12 Aug 2026) --------------------------------------
    // "Has this enquiry dined with us before?" â asked by the Events desk with
    // nothing but what the guest put in their email: a number, an address, or a
    // name. Answers with a VERDICT and the guest's history, never their contact
    // details: no phone, no email, no address ever leaves this function, exactly
    // as the daysheet mode has always worked.
    //
    // ?clientcheck=<value>[&kind=phone|email|name]
    //
    // TWO TRAPS THIS GUARDS, both proved against the live API on 12 Aug 2026:
    //
    //  1. `query=` / `search=` / `text=` are SILENTLY IGNORED by SevenRooms and
    //     return the unfiltered first page â 50 rows for any input on earth.
    //     They are not used here. Only phone / email / name genuinely filter
    //     (real number -> 2 rows, fake -> 0; real surname -> 2, nonsense -> 0).
    //
    //  2. Passing the WRONG VALUE TYPE to a working filter falls back to that
    //     same unfiltered 50 â an email sent to `phone=` returned all 50. So the
    //     value is classified BEFORE it is sent, and a 50-row answer is treated
    //     as "the filter did not apply" and reported as an ERROR, never as 50
    //     matches and never as "new guest".
    //
    // "We could not check" and "they are new" are different sentences and only
    // one of them should ever be shown to a guest-facing quote.
    const clientCheck = reqUrl.searchParams.get("clientcheck");
    if (clientCheck) {
      const raw = String(clientCheck).trim();
      const digits = raw.replace(/\D/g, "");
      let kind = String(reqUrl.searchParams.get("kind") || "").toLowerCase();
      if (kind !== "phone" && kind !== "email" && kind !== "name") {
        if (raw.includes("@")) kind = "email";
        else if (digits.length >= 7) kind = "phone";
        else kind = "name";
      }
      // The value actually sent. A UAE mobile reaches us as 0564034998,
      // 971564034998 or +971 56 403 4998 in the same week; the last 9 digits are
      // the subscriber number and match all three without inventing a dial code.
      const value = kind === "phone" ? digits.slice(-9)
                  : kind === "email" ? raw.toLowerCase()
                  : raw;

      const tooShort = (kind === "name" && value.length < 3) ||
                       (kind === "phone" && value.length < 7) ||
                       (kind === "email" && !/.@./.test(value));
      if (tooShort) {
        return new Response(JSON.stringify({
          ok: true, status: "error", matched: false, matched_on: kind,
          reason: `Not enough to search on â "${kind}" needs a fuller value.`,
        }), { headers: { ...cors, "Content-Type": "application/json" } });
      }

      const url = new URL(`${SR_BASE}/clients`);
      url.searchParams.set(kind, value);
      if (venueGroupId) url.searchParams.set("venue_group_id", venueGroupId);

      const cr = await fetch(url.toString(), {
        method: "GET", headers: { Authorization: token, Accept: "application/json" },
      });
      if (!cr.ok) {
        return new Response(JSON.stringify({
          ok: true, status: "error", matched: false, matched_on: kind,
          reason: `SevenRooms answered ${cr.status}.`,
        }), { headers: { ...cors, "Content-Type": "application/json" } });
      }
      const cb = await cr.json();
      const cd = cb?.data ?? cb;
      const list: any[] = Array.isArray(cd) ? cd : (Array.isArray(cd?.results) ? cd.results : []);

      // The unfiltered-page guard. 50 is SevenRooms' default page size, and it is
      // what comes back when a filter did not apply. A real venue can have 50
      // people called Ahmed, so this refuses rather than guesses.
      if (list.length >= 50) {
        return new Response(JSON.stringify({
          ok: true, status: "error", matched: false, matched_on: kind,
          reason: "SevenRooms returned an unfiltered list, so this could not be checked reliably.",
        }), { headers: { ...cors, "Content-Type": "application/json" } });
      }

      if (!list.length) {
        return new Response(JSON.stringify({
          ok: true, status: "new", matched: false, matched_on: kind, count: 0,
        }), { headers: { ...cors, "Content-Type": "application/json" } });
      }

      // Up to 3 candidates get their history read, so she can tell two people of
      // the same name apart by when they were last in. Three, not the five the
      // search may return, because each one costs two SevenRooms calls and this
      // runs while she is on the phone to the guest.
      //
      // Name and company ride along because she has to confirm it is the right
      // person; the contact fields deliberately do not.
      //
      // venue is OPTIONAL and normally absent here: an enquiry has no table, so
      // there is no venue to scope to. Without it the figures are GROUP-wide,
      // which is the right question anyway ("have they been to us before"), and
      // `scope` says which of the two is being shown. last_visit only exists on
      // the venue block, so it falls back to the newest row of the visit list --
      // the same date, read the other way round.
      const venueParam = reqUrl.searchParams.get("venue");
      const picked = list.slice(0, 3);
      const matches: any[] = [];
      for (const c of picked) {
        const id = c?.id;
        if (!id) continue;
        let stats: any = null;
        try {
          stats = await guestProfile(token, venueGroupId, String(id), venueParam, true, null);
        } catch (_) { /* history is a bonus; the match itself still stands */ }
        const recent = stats && Array.isArray(stats.visits_recent) ? stats.visits_recent : [];
        matches.push({
          sr_client_id: String(id),
          name: [c.first_name, c.last_name].filter(Boolean).join(" ") || null,
          company: c.company || null,
          scope: stats ? stats.scope : null,
          visits: stats ? stats.visits : null,
          covers: stats ? stats.covers : null,
          spend: stats ? stats.spend : null,
          last_visit: stats ? (stats.last_visit || (recent[0] && recent[0].date) || null) : null,
          note: stats ? stats.note : null,
          tags: stats ? stats.tags : [],
          history_read: !!stats,
        });
      }
      // Best = most visits, so the real regular leads when a name returns several.
      matches.sort((a, b) => (b.visits || 0) - (a.visits || 0));
      return new Response(JSON.stringify({
        ok: true, status: "known", matched: true, matched_on: kind,
        count: list.length, matches,
      }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    // ---- CLIENT SEARCH PROBE (12 Aug 2026) -------------------------------
    // Does SevenRooms let us look a guest up by PHONE or EMAIL, rather than by
    // the client id we already hold? The Events desk needs to answer "has this
    // enquiry dined with us before?" from nothing but a number in an email.
    // The API docs are account-gated and no public source documents a client
    // search, so the only honest answer is to ask the API.
    //
    // Same discipline as ?visitprobe=: this reports PATHS, STATUS CODES, ROW
    // COUNTS and FIELD NAMES only. It never returns a field VALUE, so running
    // it can never leak a guest's number or address into a log or a browser.
    const clientProbe = reqUrl.searchParams.get("clientprobe");
    if (clientProbe) {
      const vg = venueGroupId || "";
      const v = encodeURIComponent(clientProbe);
      const candidates = [
        `/clients?phone=${v}`,
        `/clients?phone_number=${v}`,
        `/clients?email=${v}`,
        `/clients?query=${v}`,
        `/clients?search=${v}`,
        `/clients?text=${v}`,
        `/clients?name=${v}`,
        `/clients/search?query=${v}`,
        `/clients/search?phone=${v}`,
        `/client_search?query=${v}`,
      ];
      const results: any[] = [];
      for (const path of candidates) {
        const url = new URL(SR_BASE + path);
        if (vg && !url.searchParams.get("venue_group_id")) url.searchParams.set("venue_group_id", vg);
        try {
          const r = await fetch(url.toString(), {
            method: "GET", headers: { Authorization: token, Accept: "application/json" },
          });
          let rows: any = null, sampleKeys: any = null;
          if (r.ok) {
            const b = await r.json();
            const d = b?.data ?? b;
            const arr = Array.isArray(d) ? d : (Array.isArray(d?.results) ? d.results : null);
            rows = arr ? arr.length : null;
            sampleKeys = arr && arr[0] && typeof arr[0] === "object" ? Object.keys(arr[0]).slice(0, 30) : null;
          }
          results.push({ path: path.replace(v, "<value>"), status: r.status, ok: r.ok, rows, sampleKeys });
        } catch (e) {
          results.push({ path: path.replace(v, "<value>"), status: "threw", error: String(e).slice(0, 120) });
        }
      }
      return new Response(JSON.stringify({
        ok: true,
        answered: results.filter((x) => x.ok && x.rows).map((x) => x.path),
        results,
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
